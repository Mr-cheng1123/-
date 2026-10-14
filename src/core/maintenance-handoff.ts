import {createHash} from 'node:crypto';
import {readFileSync,renameSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import type {AccountState,AppConfig,ExchangeAdapter,ExchangeId,FundingPayment,Position} from '../shared/types.js';
import type {SavedState} from './store.js';
import {isPositionActive,isCurrentUnconfirmedOrder} from '../shared/ledger-lifecycle.js';
import type {Engine} from './engine.js';
import {findFundingOwner,fundingRecordsForRead} from './funding-attribution.js';

export interface MaintenanceHandoff {
  version:1|2;at:number;sourcePid:number;project:string;credentialsHash:string;ledgerHash:string;configHash:string;
  venues:ExchangeId[];positionIds:string[];
  /** Version 2 restores only positionIds. These source records remain paused at attention. */
  attentionPositionIds?:string[];
}
function canonical(value:unknown):unknown {
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,canonical(v)]));
  return value;
}
export const maintenanceHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const credentialsFileHash=(file:string)=>createHash('sha256').update(readFileSync(file)).digest('hex');
/** A source's explicit session scope can be narrower than its configured account credentials. */
export function maintenanceVenueScope(venues:readonly ExchangeId[],eligible:readonly ExchangeId[]):ExchangeId[]{
  if(!Array.isArray(venues)||!venues.length||new Set(venues).size!==venues.length||venues.some(venue=>!eligible.includes(venue)))
    throw new Error('Maintenance execution scope is empty, repeated or unavailable');
  return [...venues].sort();
}
/** Runtime marks, observations and log messages can change; orders and every recorded cash flow cannot. */
export function maintenanceLedgerHash(ledger:Pick<SavedState,'orders'|'positions'|'fundingSeen'>):string {
  return maintenanceHash({orders:ledger.orders,fundingSeen:ledger.fundingSeen,positions:ledger.positions.map(p=>({
    id:p.id,base:p.base,mode:p.mode,entryPolicy:p.entryPolicy,holdMode:p.holdMode,openedAt:p.openedAt,
    profitExitPolicy:p.profitExitPolicy,accountClosure:p.accountClosure,
    legs:[p.long,p.short].map(l=>({exchange:l.exchange,symbol:l.symbol,side:l.side,quantity:l.quantity,entryPrice:l.entryPrice,
      feesUsd:l.feesUsd,fundingUsd:l.fundingUsd,lastFundingAt:l.lastFundingAt,realizedPnlUsd:l.realizedPnlUsd})),
    feesUsd:p.feesUsd,fundingUsd:p.fundingUsd,fundingEvents:p.fundingEvents,transferCostUsd:p.transferCostUsd,
    realizedSpreadPnlUsd:p.realizedSpreadPnlUsd,closeRequestedAt:p.closeRequestedAt,closeAttemptedAt:p.closeAttemptedAt,
  }))});
}
/** Read-only receipt replay permits new exchange-confirmed funding while keeping every old intent and cash record. */
export function verifyMaintenanceFundingReads(before:SavedState,after:SavedState,payments:readonly (FundingPayment&{exchange:ExchangeId})[],now=Date.now()):number {
  if(maintenanceHash(before.config)!==maintenanceHash(after.config)||maintenanceHash(before.orders)!==maintenanceHash(after.orders)||
    maintenanceHash(before.fundingSeen)!==maintenanceHash(after.fundingSeen.slice(0,before.fundingSeen.length)))
    throw new Error('Maintenance changed existing intents, policy or funding history');
  const expected=structuredClone(before),newKeys=after.fundingSeen.slice(before.fundingSeen.length),receipts=new Map<string,FundingPayment&{exchange:ExchangeId}>();
  if(new Set(after.fundingSeen).size!==after.fundingSeen.length)throw new Error('Duplicate funding history');
  for(const payment of payments){const key=`${payment.exchange}:${payment.id}`,old=receipts.get(key);
    if(old&&maintenanceHash(old)!==maintenanceHash(payment))throw new Error('Funding receipt is ambiguous');receipts.set(key,payment);}
  const relevant=fundingRecordsForRead(expected.positions,now);
  for(const key of newKeys){
    const f=receipts.get(key);
    if(!f||!Number.isFinite(f.amountUsd)||!Number.isFinite(f.timestamp))throw new Error('New funding has no independently read receipt');
    const owner=findFundingOwner(relevant,expected.orders,f.exchange,f);
    if(!owner)throw new Error('Funding receipt does not belong to a confirmed source holding');
    const {position:p,leg}=owner;
    p.fundingUsd+=f.amountUsd;leg.fundingUsd=(leg.fundingUsd??0)+f.amountUsd;leg.lastFundingAt=Math.max(leg.lastFundingAt??0,f.timestamp);
    p.fundingEvents.push(key);expected.fundingSeen.push(key);
  }
  if(maintenanceLedgerHash(expected)!==maintenanceLedgerHash(after))throw new Error('Financial history changed beyond verified new funding receipts');
  return newKeys.length;
}
/** A controlled handover only covers completed, matched holdings, never an entry/exit or an unknown order. */
export function assertManagedPositionsForHandoff(positions:Position[]):void {
  for(const p of positions.filter(isPositionActive))if(p.mode!=='live'||p.status!=='open'||p.closeRequestedAt!==undefined||p.closeAttemptedAt!==undefined||
    p.long.side!=='long'||p.short.side!=='short'||p.long.exchange===p.short.exchange||
    ![p.long.quantity,p.short.quantity,p.long.entryPrice,p.short.entryPrice].every(n=>Number.isFinite(n)&&n>0)||
    Math.abs(p.long.quantity-p.short.quantity)>Math.max(p.long.quantity,p.short.quantity)*1e-10)
    throw new Error('Maintenance requires completely filled, matched open holdings with no pending close');
}
/** Classify the exact source managers without promoting historical attention records. */
export function maintenancePositionPartition(positions:Position[]):{positionIds:string[];attentionPositionIds:string[]} {
  const active=positions.filter(isPositionActive);
  if(new Set(active.map(p=>p.id)).size!==active.length||active.some(p=>p.mode!=='live'||!['open','attention'].includes(p.status)))
    throw new Error('Maintenance requires an idle live source with open or attention records');
  const managed=active.filter(p=>p.status==='open');
  assertManagedPositionsForHandoff(managed);
  return {positionIds:managed.map(p=>p.id).sort(),attentionPositionIds:active.filter(p=>p.status==='attention').map(p=>p.id).sort()};
}
function attentionIds(proof:MaintenanceHandoff):string[] {return proof.version===2?proof.attentionPositionIds??[]:[];}
function proofHasExactActiveIds(proof:MaintenanceHandoff,positions:Position[]):boolean {
  if(!Array.isArray(proof.positionIds)||(proof.version===2&&!Array.isArray(proof.attentionPositionIds)))return false;
  const ids=[...proof.positionIds,...attentionIds(proof)];
  return new Set(ids).size===ids.length&&maintenanceHash([...ids].sort())===maintenanceHash(positions.filter(isPositionActive).map(p=>p.id).sort());
}
export function validateMaintenanceHandoff(proof:MaintenanceHandoff,ledger:SavedState,config:AppConfig,
  project:string,credentialsHash:string,venues:ExchangeId[],now=Date.now()):void {
  maintenanceVenueScope(proof.venues,venues);
  if(![1,2].includes(proof.version)||!Number.isSafeInteger(proof.sourcePid)||proof.sourcePid<=0||!Number.isFinite(proof.at)||now-proof.at>120000||proof.at>now+5000||
    resolve(proof.project)!==resolve(project)||proof.credentialsHash!==credentialsHash||proof.ledgerHash!==maintenanceLedgerHash(ledger)||proof.configHash!==maintenanceHash(config)||
    !proofHasExactActiveIds(proof,ledger.positions)||
    ledger.orders.some(order=>isCurrentUnconfirmedOrder(order,ledger.positions)))throw new Error('Maintenance handover proof is missing, stale or no longer matches this process');
  const managedIds=new Set(proof.positionIds);
  if(ledger.positions.some(position=>managedIds.has(position.id)&&[position.long,position.short].some(leg=>!proof.venues.includes(leg.exchange))))
    throw new Error('Maintenance execution scope does not cover both managed legs');
  if(proof.version===1)assertManagedPositionsForHandoff(ledger.positions);
  else {
    const source=maintenancePositionPartition(ledger.positions);
    if(maintenanceHash(source.positionIds)!==maintenanceHash([...proof.positionIds].sort())||
      maintenanceHash(source.attentionPositionIds)!==maintenanceHash([...attentionIds(proof)].sort()))
      throw new Error('Maintenance source management and attention scopes changed');
  }
}
/** Consume once before Engine changes restart statuses. Ordinary restarts retain the normal reconciliation requirement. */
export function consumeMaintenanceHandoff(file:string|undefined,ledger:SavedState,config:AppConfig,project:string,venues:ExchangeId[],now=Date.now()):MaintenanceHandoff|undefined {
  if(!file)return;
  const resolved=resolve(file),runtime=resolve(project,'data/runtime'),within=relative(runtime,resolved);
  if(!within||within.startsWith('..')||isAbsolute(within))throw new Error('Maintenance proof must belong to this project runtime directory');
  const proof=JSON.parse(readFileSync(resolved,'utf8').replace(/^\uFEFF/,'')) as MaintenanceHandoff;
  validateMaintenanceHandoff(proof,ledger,config,project,credentialsFileHash(resolve(project,'.env')),venues,now);
  let alive=true;try{process.kill(proof.sourcePid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')alive=false;}
  if(alive)throw new Error('The source process is still running; maintenance handover refused');
  renameSync(resolved,resolved+'.consumed');
  return proof;
}
/** All external operations here are read-only. Never prepares modes, reconciles, submits, cancels or closes an order. */
export async function inspectMaintenanceHoldings(positions:Position[],adapter:(exchange:ExchangeId)=>ExchangeAdapter):Promise<Map<ExchangeId,AccountState>> {
  const active=positions.filter(isPositionActive),venues=[...new Set(active.flatMap(p=>[p.long.exchange,p.short.exchange]))];
  const clients=new Map(venues.map(exchange=>[exchange,adapter(exchange)]));
  const readAccounts=async()=>new Map(await Promise.all(venues.map(async exchange=>[exchange,await clients.get(exchange)!.fetchAccount()] as const)));
  const check=(accounts:Map<ExchangeId,AccountState>)=>{
    for(const p of active)for(const leg of [p.long,p.short]){
      const a=accounts.get(leg.exchange);
      if(!a||!Array.isArray(a.positions))throw new Error('Maintenance account positions are unavailable');
      const rows=a.positions.filter(row=>row.quantity>0&&(row.symbol===leg.symbol||row.base===p.base));
      if(rows.length!==1||rows[0].symbol!==leg.symbol||rows[0].side!==leg.side||!Number.isFinite(rows[0].quantity)||
        Math.abs(rows[0].quantity-leg.quantity)>Math.max(1,leg.quantity)*1e-10)
        throw new Error('Exchange holdings do not match the maintenance journal');
    }
  };
  check(await readAccounts());
  await Promise.all(active.flatMap(p=>[p.long,p.short]).map(async leg=>{
    const client=clients.get(leg.exchange)!;
    if(!client.fetchOpenOrders)throw new Error('Maintenance cannot verify pending orders');
    const orders=await client.fetchOpenOrders(leg.symbol);
    if(!Array.isArray(orders)||orders.length)throw new Error('Pending exchange orders prevent maintenance restoration');
  }));
  const accounts=await readAccounts();check(accounts);return accounts;
}

/** Preserve an already-running position manager after its exact paused process was replaced. No new permission is granted. */
export async function restoreVerifiedMaintenanceHoldings(engine:Engine,proof:MaintenanceHandoff):Promise<string[]> {
  return engine.exclusive(async()=>{
    if(!engine.liveUnlocked||engine.autoEnabled||engine.store.data.killSwitch||
      proof.ledgerHash!==maintenanceLedgerHash(engine.store.data)||proof.configHash!==maintenanceHash(engine.config))
      throw new Error('Maintenance restoration no longer matches the authorized source');
    const ids=new Set(proof.positionIds),active=engine.activePositions(),managed=active.filter(p=>ids.has(p.id));
    if(managed.some(position=>[position.long,position.short].some(leg=>!proof.venues.includes(leg.exchange))))
      throw new Error('Maintenance execution scope does not cover both managed legs');
    const unchangedRestartStatuses=()=>proofHasExactActiveIds(proof,engine.activePositions())&&engine.activePositions().every(p=>p.status==='attention')&&
      managed.every(p=>p.closeRequestedAt===undefined&&p.closeAttemptedAt===undefined);
    if(!unchangedRestartStatuses())
      throw new Error('Maintenance holdings changed before verification');
    const venueScope=engine.liveReadiness().exchanges.filter(v=>v.executionAuthorized).map(v=>v.exchange).sort();
    if(maintenanceHash(venueScope)!==maintenanceHash([...proof.venues].sort()))throw new Error('Maintenance execution scope changed');
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const accounts=await Promise.race([inspectMaintenanceHoldings(managed,exchange=>engine.adapter(exchange)),
        new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Maintenance position reads timed out')),25000);})]);
      const finalScope=engine.liveReadiness().exchanges.filter(v=>v.executionAuthorized).map(v=>v.exchange).sort();
      if(proof.ledgerHash!==maintenanceLedgerHash(engine.store.data)||proof.configHash!==maintenanceHash(engine.config)||!engine.liveUnlocked||engine.autoEnabled||engine.store.data.killSwitch||
        maintenanceHash(finalScope)!==maintenanceHash([...proof.venues].sort())||!unchangedRestartStatuses())
        throw new Error('Maintenance holdings changed during verification');
      for(const [exchange,account] of accounts){engine.accounts.set(exchange,account);const health=engine.health.find(h=>h.exchange===exchange);
        if(health){health.accountStatus='ready';health.accountUpdatedAt=Date.now();health.balanceUsd=account.freeUsd;health.accountError=undefined;}}
      for(const p of managed){p.status='open';p.riskReasons=[];}
      engine.store.log('info',`维护更新已只读核对 ${managed.length} 组原有持仓并保留原管理模式；自动开仓保持关闭`);
      return managed.map(p=>p.id);
    }finally{if(timer)clearTimeout(timer);}
  });
}
