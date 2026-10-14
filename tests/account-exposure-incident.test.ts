import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as immediate} from 'node:timers/promises';
import {Engine} from '../src/core/engine.js';
import {accountExposureIncident,type AccountExposureObservation} from '../src/core/account-exposure-incident.js';
import {defaultConfig} from '../src/shared/config.js';
import type {AccountState,Position} from '../src/shared/types.js';

function position():Position{return {id:'current-dos',base:'DOS',mode:'live',status:'open',openedAt:1000,
  long:{exchange:'bitget',symbol:'DOS/USDT:USDT',side:'long',quantity:220,entryPrice:.45815,markPrice:.46,feesUsd:.0604758,liquidationDistancePct:null},
  short:{exchange:'gate',symbol:'DOS/USDT:USDT',side:'short',quantity:220,entryPrice:.4631,markPrice:.46,feesUsd:.050941,liquidationDistancePct:null},
  entryPolicy:'aligned',holdMode:'adaptive',profitExitNotionalUsd:101.3375,fundingUsd:.1,feesUsd:.1114168,transferCostUsd:0,
  realizedSpreadPnlUsd:0,spreadPnlUsd:1.089,netPnlUsd:1.0775832,deltaUsd:0,plannedExitAt:10000,riskReasons:[],fundingEvents:[]};}
const account=():AccountState=>({freeUsd:100,equityUsd:100,positions:[]});
function observation():AccountExposureObservation{return {position:position(),exchange:'gate',account:account(),now:5000,readStartedAt:4900,
  maxAgeMs:30000,lastFinancialActivityAt:1000,quantityTolerance:1,sourceCurrent:true,sessionAuthorized:true,executionBusy:false,unconfirmed:false};}
function engineFixture(){
  const p=position(),a=account(),logs:{level:string;message:string;context?:string}[]=[],snapshots:any[]=[],adapter:any={id:'gate',fetchAccount:async()=>a};
  const config={...defaultConfig,mode:'live' as const,dataSource:'public' as const,maxSnapshotAgeMs:30000};
  const source:any={adapter,config,generation:7};
  const health:any={exchange:'gate',accountStatus:'ready',accountUpdatedAt:4900};
  const store:any={data:{positions:[p],orders:[],killSwitch:false},save(){snapshots.push(structuredClone(this.data));},
    log(level:string,message:string,context?:string){logs.push({level,message,context});this.save();}};
  const engine:any={config,startGeneration:7,running:true,stopping:false,credentialUpdatePending:false,maintenanceTradingPending:false,autoEnabled:true,
    accountReadAt:new WeakMap([[a,4900]]),accountReadSources:new WeakMap([[a,source]]),privateReadRequests:new WeakMap(),accountCacheRevision:new Map(),
    accounts:new Map([['gate',a]]),health:[health],adapters:[adapter],store,options:{privateReadDeadlineMs:1000},persistenceFailures:new Set(),externalExposureSources:new Set(),
    snapshot:()=>({quantityStep:10}),activePositions:()=>[p],hasLiveAccess:()=>true,pendingCoin:()=>false,confirmOperationAccounts:()=>{},scheduleExternalExposureReduction:()=>{},
    execution:{hasMakerClose:()=>false,hasIocProfitClose:()=>false,hasPendingIocProfitTail:()=>false,hasPendingMakerCloseTail:()=>false,
      hasPendingEntryRollback:()=>false,isObservationPersistenceFailure:()=>false}};
  Object.setPrototypeOf(engine,Engine.prototype);return {engine,p,a,adapter,source,health,store,logs,snapshots};
}

test('a fresh missing native leg yields original and actual quantity/time evidence without changing cash',()=>{
  const input=observation(),before=structuredClone(input.position),incident=accountExposureIncident(input);assert(incident);
  assert.equal(incident.reason,'missing');assert.equal(incident.nativeQuantity,0);assert.equal(incident.expectedQuantity,220);
  assert.equal(incident.accountReadStartedAt,4900);assert.equal(incident.lastFinancialActivityAt,1000);assert.equal(incident.status,'detected');
  assert.equal(incident.pausedNewEntry,true);assert.deepEqual(input.position,before);assert.equal(incident.originalLegs.length,2);
});

test('quantity, opposite and ambiguous rows are distinct evidence; an ambiguous account never invents an exact zero',()=>{
  for(const scenario of [
    {rows:[{side:'short',quantity:110}],reason:'quantity',nativeQuantity:110},
    {rows:[{side:'long',quantity:220}],reason:'opposite',nativeQuantity:0},
    {rows:[{side:'short',quantity:100},{side:'short',quantity:120}],reason:'ambiguous',nativeQuantity:null},
  ] as const){const input=observation();input.account.positions=scenario.rows.map(row=>({...row,base:'DOS',symbol:'DOS/USDT:USDT'})) as AccountState['positions'];
    const incident=accountExposureIncident(input);assert(incident);assert.equal(incident.reason,scenario.reason);assert.equal(incident.nativeQuantity,scenario.nativeQuantity);}
});

for(const reason of ['old','future','pre-activity','equal-activity','source','unauthorized','busy','unconfirmed','historical-attention','manual','archived'] as const)
test(`${reason} observation cannot create or authorize an incident`,()=>{
  const input=observation();
  if(reason==='old')input.now=35001;
  else if(reason==='future')input.readStartedAt=5001;
  else if(reason==='pre-activity')input.lastFinancialActivityAt=4901;
  else if(reason==='equal-activity')input.lastFinancialActivityAt=4900;
  else if(reason==='source')input.sourceCurrent=false;
  else if(reason==='unauthorized')input.sessionAuthorized=false;
  else if(reason==='busy')input.executionBusy=true;
  else if(reason==='unconfirmed')input.unconfirmed=true;
  else if(reason==='historical-attention')input.position.status='attention';
  else if(reason==='manual')input.position.manualCloseOnly=true;
  else input.position.accountClosure={} as Position['accountClosure'];
  assert.equal(accountExposureIncident(input),undefined);
});

test('matching rows, malformed quantity and unrelated symbols do not manufacture an external mismatch',()=>{
  const input=observation();input.account.positions=[{base:'DOS',symbol:'DOS/USDT:USDT',side:'short',quantity:220}] as AccountState['positions'];
  assert.equal(accountExposureIncident(input),undefined);input.account.positions[0].quantity=NaN;assert.equal(accountExposureIncident(input),undefined);
});

test('detection ids ignore query time changes and include changed original/native financial quantities',()=>{
  const first=observation(),a=accountExposureIncident(first)!;first.now+=100;first.readStartedAt+=100;
  assert.equal(accountExposureIncident(first)?.id,a.id);first.position.short.quantity=210;assert.notEqual(accountExposureIncident(first)?.id,a.id);
});

test('Engine records attention and one severe log durably, pauses entries and keeps kill and original cash unchanged',async t=>{
  t.mock.timers.enable({apis:['Date'],now:5000});const f=engineFixture(),cash=structuredClone({long:f.p.long,short:f.p.short,fees:f.p.feesUsd,funding:f.p.fundingUsd,basis:f.p.profitExitNotionalUsd});
  f.engine.checkAccount('gate',f.a);assert.equal(f.p.status,'attention');assert.equal(f.engine.autoEnabled,false);assert.equal(f.store.data.killSwitch,false);
  assert.equal(f.p.accountExposureIncidents?.length,1);assert.equal(f.logs.length,1);assert.equal(f.logs[0].level,'error');assert.equal(f.logs[0].context,f.p.id);
  assert.equal(f.snapshots[0].positions[0].status,'attention');assert.equal(f.snapshots[0].positions[0].accountExposureIncidents.length,1);
  assert.deepEqual({long:f.p.long,short:f.p.short,fees:f.p.feesUsd,funding:f.p.fundingUsd,basis:f.p.profitExitNotionalUsd},cash);
  f.engine.checkAccount('gate',f.a);assert.equal(f.logs.length,1);
  f.p.status='open';f.engine.autoEnabled=true;t.mock.timers.tick(1);f.engine.accountReadAt.set(f.a,4901);f.health.accountUpdatedAt=4901;
  f.engine.checkAccount('gate',f.a);assert.equal(f.logs.length,1);assert.equal(f.p.accountExposureIncidents?.length,1);assert.equal(f.engine.autoEnabled,false);
});

for(const change of ['generation','configuration','adapter','account-object','stopping','maintenance','credentials','unknown-order','ioc-worker','confirmed-tail'] as const)
test(`Engine excludes ${change} from external exposure attribution and waits for a later eligible read`,async t=>{
  t.mock.timers.enable({apis:['Date'],now:5000});const f=engineFixture();
  if(change==='generation')f.source.generation=6;
  else if(change==='configuration')f.source.config={...f.engine.config};
  else if(change==='adapter')f.engine.adapters=[{id:'gate'}];
  else if(change==='account-object')f.engine.accounts.set('gate',account());
  else if(change==='stopping')f.engine.stopping=true;
  else if(change==='maintenance')f.engine.maintenanceTradingPending=true;
  else if(change==='credentials')f.engine.credentialUpdatePending=true;
  else if(change==='unknown-order')f.engine.pendingCoin=()=>true;
  else if(change==='ioc-worker')f.engine.execution.hasIocProfitClose=()=>true;
  else f.engine.execution.hasPendingIocProfitTail=()=>true;
  f.engine.checkAccount('gate',f.a);assert.equal(f.p.status,'open');assert.equal(f.engine.autoEnabled,true);assert.equal(f.logs.length,0);assert.equal(f.p.accountExposureIncidents,undefined);
});

test('a real account request starting before a financial change is excluded; its later post-activity fresh read detects the loss',async t=>{
  t.mock.timers.enable({apis:['Date'],now:5000});const f=engineFixture();let release!:(value:AccountState)=>void,reads=0;
  f.adapter.fetchAccount=async()=>{reads++;if(reads===1)return new Promise<AccountState>(resolve=>{release=resolve;});return account();};
  const pending=f.engine.readTradingAccount(f.adapter);await immediate();t.mock.timers.tick(1);
  f.store.data.orders.push({positionId:f.p.id,createdAt:5001,result:{timestamp:5001}});
  t.mock.timers.tick(10);release(account());const old=await pending;assert.equal(f.engine.accountReadAt.get(old),5000);
  assert(f.engine.cacheAccount('gate',old));f.engine.checkAccount('gate',old);assert.equal(f.p.status,'open');assert.equal(f.logs.length,0);assert.equal(f.engine.autoEnabled,true);
  t.mock.timers.tick(1);const current=await f.engine.readTradingAccount(f.adapter);assert(f.engine.cacheAccount('gate',current));f.engine.checkAccount('gate',current);
  assert.equal(reads,2);assert.equal(f.p.status,'attention');assert.equal(f.engine.autoEnabled,false);
  assert.equal(f.p.accountExposureIncidents?.[0].accountReadStartedAt,5012);assert.equal(f.p.accountExposureIncidents?.[0].lastFinancialActivityAt,5001);
});

test('actual persistence failure keeps auto disabled and uses the existing write-failure halt without financial rewrites',async t=>{
  t.mock.timers.enable({apis:['Date'],now:5000});const f=engineFixture(),failure=new Error('Synthetic durable log save failure');
  f.store.save=()=>{throw failure;};assert.throws(()=>f.engine.checkAccount('gate',f.a),error=>error===failure);
  assert.equal(f.engine.autoEnabled,false);assert.equal(f.store.data.killSwitch,true);assert.equal(f.p.status,'attention');
  assert(f.engine.persistenceFailures.has(failure));assert.equal(f.p.long.quantity,220);assert.equal(f.p.short.quantity,220);assert.equal(f.p.accountExposureIncidents?.length,1);
});

test('later matching account observations do not auto-adopt or erase a frozen historical incident',async t=>{
  t.mock.timers.enable({apis:['Date'],now:5000});const f=engineFixture();f.engine.checkAccount('gate',f.a);
  f.a.positions=[{base:'DOS',symbol:'DOS/USDT:USDT',side:'short',quantity:220}] as AccountState['positions'];
  f.engine.checkAccount('gate',f.a);assert.equal(f.p.status,'attention');assert.equal(f.p.accountExposureIncidents?.length,1);assert.equal(f.engine.autoEnabled,false);assert.equal(f.logs.length,1);
});
