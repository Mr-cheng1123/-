import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {Engine} from '../src/core/engine.js';
import {Store} from '../src/core/store.js';
import {defaultConfig} from '../src/shared/config.js';
import type {AccountState,ExchangeAdapter,JournalOrder,LivePortfolio,MarketSnapshot,Opportunity,Position} from '../src/shared/types.js';
import type {ManualCloseRequest} from '../src/shared/manual-close.js';

const root='D:/codex/tmp/execution-operation-improvements-20261012/engine-operation-tests';mkdirSync(root,{recursive:true});
const opportunityId='CT-gate-bybit';
function setup(t:{after:(fn:()=>Promise<void>)=>void},locked=false){
  let reads=0,writes=0;
  const directory=mkdtempSync(join(root,'case-')),store=new Store(join(directory,'state.json'),
    {...defaultConfig,mode:'live',dataSource:'public',exchanges:['gate','bybit'],symbols:['CT'],orderNotionalUsd:100});
  const adapters:ExchangeAdapter[]=(['gate','bybit'] as const).map(id=>({id,fetchSnapshots:async()=>[],
    fetchAccount:async()=>{reads++;return {freeUsd:1000,equityUsd:1000,positions:[]};},fetchFundingPayments:async()=>[],
    inspectTrading:async()=>{},prepareTrading:async()=>{},placeOrder:async()=>{writes++;throw new Error('No real submission in diagnostics tests');},
    cancelOrder:async()=>{throw new Error('No cancel in diagnostics tests');},reconcileOrder:async()=>{throw new Error('No native query in diagnostics tests');},close:async()=>{}}));
  const engine=new Engine(store,!locked,{adapterFactory:()=>adapters,liveEnvironment:{ALLOW_LIVE_TRADING:locked?'false':'true',
    LIVE_TRADING_ACK:'I_UNDERSTAND_THE_RISKS',GATE_API_KEY:'offline',GATE_API_SECRET:'offline',BYBIT_API_KEY:'offline',BYBIT_API_SECRET:'offline'}});
  t.after(async()=>{await engine.stop();});
  return {engine,store,adapters,reads:()=>reads,writes:()=>writes,directory};
}
function configureOpportunity(f:ReturnType<typeof setup>){
  f.engine.health=f.adapters.map(adapter=>({exchange:adapter.id,status:'online',latencyMs:0,lastSuccess:Date.now()}));
  f.engine.snapshots=f.adapters.map(adapter=>({exchange:adapter.id,base:'CT',symbol:'CT/USDT:USDT',timestamp:Date.now(),
    observedAt:Date.now(),markPrice:.5,indexPrice:.5,fundingRate:adapter.id==='gate'?0:.005,nextFundingTime:Date.now()+3600_000,
    intervalHours:8,fundingHistory:[],bids:[{price:.5,quantity:1000}],asks:[{price:.5,quantity:1000}],openInterestUsd:1e9,
    volume24hUsd:1e9,quantityStep:1,minQuantity:1,minNotional:1,contractSize:1,source:'public',
    takerFeeRate:.0005,takerFeeAt:Date.now(),takerFeeSource:'exchange'}) as MarketSnapshot);
  const opportunity={id:opportunityId,base:'CT',eligible:true,longExchange:'gate',shortExchange:'bybit',longQuantity:190,shortQuantity:190,
    exitTime:Date.now()+3600_000,transferCostUsd:0,entryPolicy:'aligned',checks:[],reasons:[],spreadAdvantage:{longEntryPrice:.5,shortEntryPrice:.5}} as unknown as Opportunity;
  (f.engine as any).detailedOpportunities=()=>[opportunity];(f.engine as any).refreshExecutionSnapshots=async()=>{};
}
function selectedPosition():Position {
  return {id:'selected-position',base:'CT',mode:'live',status:'open',openedAt:Date.now()-60000,plannedExitAt:Date.now()+3600000,holdMode:'adaptive',
    long:{exchange:'gate',symbol:'CT/USDT:USDT',side:'long',quantity:2,entryPrice:.5,markPrice:.5,feesUsd:0,liquidationDistancePct:null},
    short:{exchange:'bybit',symbol:'CT/USDT:USDT',side:'short',quantity:2,entryPrice:.5,markPrice:.5,feesUsd:0,liquidationDistancePct:null},
    fundingUsd:0,feesUsd:0,transferCostUsd:0,spreadPnlUsd:0,realizedSpreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[]};
}

test('accepted manual preflight failure and duplicate click remain one diagnostic operation with no order or extra account read',async t=>{
  const f=setup(t),id='manual-preflight-test';(f.engine as any).detailedOpportunities=()=>[];
  f.engine.requestManualEntry(opportunityId,id,Date.now()+30000);
  f.engine.requestManualEntry(opportunityId,id,Date.now()+30000);
  await f.engine.exclusive(async()=>{});
  const row=f.store.operations.snapshot().rows[0];
  assert.equal(f.store.operations.snapshot().counts.total,1);assert.equal(row.id,id);assert.equal(row.state,'failed');
  assert.equal(row.attempts.preflightNotSent,1);assert.equal(row.attempts.submitted,0);
  assert.equal(f.reads(),0);assert.equal(f.writes(),0);assert.equal(f.store.data.positions.length,0);
});

test('the accepted manual operation follows its actual position and projected progress never enters the financial state',async t=>{
  const f=setup(t),id='manual-attached-test';configureOpportunity(f);
  f.engine.execution.open=async(p,long,short)=>{
    assert.equal(f.store.operations.current(p.id)!.id,id);
    assert.deepEqual(f.store.operations.current(p.id)!.target,{long,short});
    p.long.quantity=long;p.short.quantity=short;p.status='open';f.store.save();
  };
  f.engine.requestManualEntry(opportunityId,id,Date.now()+30000);await f.engine.exclusive(async()=>{});
  const position=f.store.data.positions[0],before=readFileSync(f.store.path,'utf8');
  const state=f.engine.state();assert.equal(state.positions[0].operationProgress!.id,id);
  assert.equal(state.executionStatistics!.operations!.rows[0].id,id);
  assert.equal(state.positions[0].operationProgress!.state,'running','a fake position state without bound receipts is not completion');
  assert.equal(position.operationProgress,undefined);assert.equal(before.includes('operationProgress'),false);
  state.positions[0].operationProgress!.base='tampered';assert.equal(f.store.operations.snapshot().rows[0].base,'CT');
  f.store.save();assert.equal(readFileSync(f.store.path,'utf8'),before);assert.equal(f.writes(),0);assert.equal(f.reads(),2);
});

test('automatic accepted entry records account preflight failure, but the existing retry guard creates no extra accepted operation',async t=>{
  const f=setup(t);configureOpportunity(f);f.engine.autoEnabled=true;
  (f.engine as any).assertAutomaticFundingOpportunity=()=>{};
  f.adapters.forEach(adapter=>{adapter.fetchAccount=async()=>{throw new Error('offline account unavailable');};});
  await assert.rejects((f.engine as any).openInternal(opportunityId,true));
  let summary=f.store.operations.snapshot();assert.equal(summary.counts.total,1);assert.equal(summary.rows[0].origin,'automatic');
  assert.equal(summary.rows[0].state,'failed');assert.equal(summary.rows[0].attempts.submitted,0);
  await assert.rejects((f.engine as any).openInternal(opportunityId,true),/重试间隔/);
  summary=f.store.operations.snapshot();assert.equal(summary.counts.total,1);assert.equal(f.store.data.positions.length,0);
});

test('accepted scoped manual close preflight is recorded once and does not turn request expiry into an execution window',async t=>{
  const f=setup(t),request:ManualCloseRequest={operationId:'scoped-preflight-test',base:'CT',expiresAt:Date.now()+45000,
    acknowledgement:'CLOSE_SELECTED_POSITION',legs:[{exchange:'gate',symbol:'CT/USDT:USDT',side:'long',quantity:2,
      accountPositionKey:JSON.stringify(['gate','CT/USDT:USDT','long','crossed',null])}]};
  await assert.rejects(f.engine.close('missing-position',request),/不一致/);
  await assert.rejects(f.engine.close('missing-position',request),/不一致/);
  const summary=f.store.operations.snapshot(),row=summary.rows[0];
  assert.equal(summary.counts.total,1);assert.equal(row.kind,'manual-close');assert.equal(row.state,'failed');
  assert.equal(row.windowEndsAt,undefined);assert.equal(row.attempts.preflightNotSent,1);assert.equal(f.reads(),0);
});

test('only native receipts plus existing accounts freshly started after pairing produce a completed Engine projection',async t=>{
  const f=setup(t),p=selectedPosition();f.store.data.positions.push(p);
  const row=f.store.operations.begin({positionId:p.id,base:p.base,mode:'live',origin:'automatic',kind:'entry',protocol:'ioc',target:{long:2,short:2}})!;
  const orders:JournalOrder[]=(['long','short'] as const).map(side=>({positionId:p.id,exchange:p[side].exchange,createdAt:Date.now(),
    request:{base:p.base,symbol:p[side].symbol,clientOrderId:`engine-${side}`,side:side==='long'?'buy':'sell',quantity:2,limitPrice:.5,reduceOnly:false},
    result:{id:`native-${side}`,clientOrderId:`engine-${side}`,status:'filled',filledQuantity:2,averagePrice:.5,feeUsd:.001,timestamp:Date.now()},
    execution:{bookTransport:'rest',quoteAgeMs:0,bookObservedAt:Date.now(),confirmedAt:Date.now()}}));
  f.store.data.orders.push(...orders);orders.forEach(order=>f.store.operations.orderSubmitted(p,order));f.store.operations.observe(p,orders);
  const pairedAt=f.store.operations.current(p.id)!.stages.pairedAt!;
  const account=(side:'long'|'short',quantity=2):AccountState=>({freeUsd:1000,equityUsd:1000,positions:[{base:p.base,symbol:p[side].symbol,side,
    quantity,markPrice:.5,liquidationPrice:0,leverage:2}]});
  const cache=(side:'long'|'short',at?:number,quantity=2)=>{const observed=account(side,quantity);
    if(at!==undefined)(f.engine as any).accountReadAt.set(observed,at);
    (f.engine as any).cacheAccount(p[side].exchange,observed);};
  cache('long');cache('short');assert.equal(f.engine.state().executionStatistics!.operations!.counts.complete,0,'cache arrival alone supplies no observation clock');
  cache('long',pairedAt);cache('short',pairedAt);assert.equal(f.engine.state().executionStatistics!.operations!.counts.complete,0);
  await new Promise(resolve=>setTimeout(resolve,5));const later=Date.now();assert(later>pairedAt);
  cache('long',later);cache('short',later,1.999);assert.equal(f.engine.state().executionStatistics!.operations!.counts.complete,0);
  cache('short',later);const state=f.engine.state();assert.equal(state.executionStatistics!.operations!.counts.complete,1);
  assert.equal(state.positions[0].operationProgress!.id,row.id);assert.equal(state.positions[0].operationProgress!.state,'complete');
  assert.equal(f.reads(),0);assert.equal(f.writes(),0);assert.equal(p.operationProgress,undefined);
});

test('diagnostic failures preserve original trading errors and do not break state or stop',async t=>{
  const f=setup(t);(f.engine as any).detailedOpportunities=()=>[];
  const begin=f.store.operations.begin.bind(f.store.operations),snapshot=f.store.operations.snapshot.bind(f.store.operations),dispose=f.store.operations.dispose.bind(f.store.operations);
  f.store.operations.begin=()=>{throw new Error('diagnostic begin failed');};
  f.store.operations.snapshot=()=>{throw new Error('diagnostic snapshot failed');};
  f.store.operations.dispose=()=>{throw new Error('diagnostic write failed');};
  try{
    await assert.rejects(f.engine.open(opportunityId),/机会已过期/);
    assert.equal(f.engine.state().executionStatistics!.operations,undefined);await f.engine.stop();
    assert.equal(f.writes(),0);assert.equal(f.reads(),0);assert.equal(f.store.data.orders.length,0);
  }finally{f.store.operations.begin=begin;f.store.operations.snapshot=snapshot;f.store.operations.dispose=dispose;}
});

function observedManualClose(f:ReturnType<typeof setup>,receipt:'filled'|'unknown'|'unbound'='filled'){
  const p=selectedPosition();f.store.data.positions.push(p);
  const operation=f.store.operations.begin({positionId:p.id,base:p.base,mode:'live',origin:'manual',kind:'manual-close',protocol:'ioc',target:{long:2,short:2}})!;
  const orders:JournalOrder[]=(['long','short'] as const).map(side=>({positionId:p.id,exchange:p[side].exchange,createdAt:Date.now(),
    request:{base:p.base,symbol:p[side].symbol,clientOrderId:`close-${side}`,side:side==='long'?'sell':'buy',quantity:2,limitPrice:.5,reduceOnly:true},
    result:{id:`close-native-${side}`,clientOrderId:`close-${side}`,status:'filled',filledQuantity:2,averagePrice:.5,feeUsd:.001,timestamp:Date.now()},
    execution:{bookTransport:'rest',quoteAgeMs:0,bookObservedAt:Date.now(),confirmedAt:Date.now()}}));
  if(receipt==='unknown')orders[1].result={...orders[1].result!,status:'unknown',filledQuantity:0};
  f.store.data.orders.push(...orders);
  if(receipt!=='unbound')orders.forEach(order=>f.store.operations.orderSubmitted(p,order));
  f.store.operations.observe(p,orders);
  return {p,id:operation.id,pairedAt:f.store.operations.current(p.id)!.stages.pairedAt};
}
function flatPortfolio(requestedAt:number):LivePortfolio {
  return {timestamp:Date.now(),pollIntervalMs:5000,maxAgeMs:15000,exchanges:(['gate','bybit'] as const).map(exchange=>({exchange,
    credentialsConfigured:true,status:'ready',requestedAt,receivedAt:Date.now(),positions:[],freeUsd:1000,equityUsd:1000}))};
}

test('portfolio receipt time, expired read starts and invalid ready payloads cannot confirm a manual close',async t=>{
  const f=setup(t),{pairedAt}=observedManualClose(f);assert(pairedAt);
  await new Promise(resolve=>setTimeout(resolve,8));
  const older=flatPortfolio(pairedAt-1);f.engine.observeOperationPortfolio(older);
  const equal=flatPortfolio(pairedAt);f.engine.observeOperationPortfolio(equal);
  const stale=flatPortfolio(pairedAt+1);stale.maxAgeMs=1;f.engine.observeOperationPortfolio(stale);
  for(const mutate of [
    (p:LivePortfolio)=>{p.exchanges[0].status='error';},
    (p:LivePortfolio)=>{p.exchanges[0].freeUsd=undefined;},
    (p:LivePortfolio)=>{p.exchanges[1].equityUsd=NaN;},
    (p:LivePortfolio)=>{p.exchanges[1].credentialsConfigured=false;},
    (p:LivePortfolio)=>{p.exchanges[0].requestedAt=Date.now()+1000;},
    (p:LivePortfolio)=>{p.exchanges.push({...p.exchanges[0]});},
  ]){const payload=flatPortfolio(Date.now());mutate(payload);f.engine.observeOperationPortfolio(payload);}
  assert.equal(f.store.operations.snapshot().counts.complete,0);assert.equal(f.reads(),0);assert.equal(f.writes(),0);
});

test('a fresh zero portfolio cannot replace unknown original orders or unbound historical fills',async t=>{
  for(const receipt of ['unknown','unbound'] as const){
    const f=setup(t),{pairedAt}=observedManualClose(f,receipt);assert.equal(pairedAt,undefined);
    await new Promise(resolve=>setTimeout(resolve,3));f.engine.observeOperationPortfolio(flatPortfolio(Date.now()));
    assert.equal(f.store.operations.snapshot().counts.complete,0,receipt);assert.equal(f.reads(),0);assert.equal(f.writes(),0);
  }
});

test('existing fresh portfolio confirms an exactly filled manual close while locked without changing financial state or trading caches',async t=>{
  const f=setup(t,true),{p,id,pairedAt}=observedManualClose(f);assert(pairedAt);
  p.status='closed';p.long.quantity=p.short.quantity=0;f.store.data.killSwitch=true;f.store.save();
  const financial=JSON.stringify(f.store.data),file=readFileSync(f.store.path,'utf8'),health=JSON.stringify(f.engine.health),
    permissions={liveUnlocked:f.engine.liveUnlocked,autoEnabled:f.engine.autoEnabled,running:f.engine.running};
  assert.equal(permissions.liveUnlocked,false);
  await new Promise(resolve=>setTimeout(resolve,5));const portfolio=flatPortfolio(Date.now()),input=JSON.stringify(portfolio);
  f.engine.observeOperationPortfolio(portfolio);
  assert.equal(f.store.operations.snapshot().counts.complete,1);assert.equal(f.engine.state().positions[0].operationProgress!.id,id);
  assert.equal(JSON.stringify(f.store.data),financial);assert.equal(readFileSync(f.store.path,'utf8'),file);assert.equal(JSON.stringify(f.engine.health),health);
  assert.equal(f.engine.accounts.size,0);assert.deepEqual({liveUnlocked:f.engine.liveUnlocked,autoEnabled:f.engine.autoEnabled,running:f.engine.running},permissions);
  assert.equal(JSON.stringify(portfolio),input);assert.equal(f.reads(),0);assert.equal(f.writes(),0);assert.equal(p.operationProgress,undefined);
});
