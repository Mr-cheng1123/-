import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {Engine} from '../src/core/engine.js';
import type {Store} from '../src/core/store.js';
import {defaultConfig} from '../src/shared/config.js';
import type {ExchangeAdapter,ExchangeId,JournalOrder,LivePortfolio,OrderResult,Position} from '../src/shared/types.js';

const NOW=Date.UTC(2026,9,11,3),base='OBS',symbol='OBS/USDT:USDT';
function fixture(t:TestContext,maker=false){
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const config={...structuredClone(defaultConfig),mode:'live' as const,dataSource:'public' as const,
    exchanges:['gate','bybit'] as ExchangeId[],symbols:[base]};
  const p:Position={id:'offline-observation',base,mode:'live',status:'attention',entryPolicy:'aligned',holdMode:'adaptive',
    openedAt:NOW-60_000,plannedExitAt:NOW+3_600_000,
    long:{exchange:'gate',symbol,side:'long',quantity:100,entryPrice:1,markPrice:1,feesUsd:.05,liquidationDistancePct:null},
    short:{exchange:'bybit',symbol,side:'short',quantity:100,entryPrice:1,markPrice:1,feesUsd:.05,liquidationDistancePct:null},
    fundingUsd:.2,feesUsd:.1,transferCostUsd:0,spreadPnlUsd:0,realizedSpreadPnlUsd:0,netPnlUsd:.1,deltaUsd:0,
    fundingEvents:['original-funding'],riskReasons:['original-unknown']};
  const request={clientOrderId:'offline-native-original',base,symbol,side:maker?'sell' as const:'buy' as const,quantity:1,limitPrice:1,
    reduceOnly:true,...(maker?{postOnly:true}:{})};
  const journal:JournalOrder={positionId:p.id,exchange:maker?'gate':'bybit',request,createdAt:NOW-100,
    result:{id:'offline-original-id',clientOrderId:request.clientOrderId,status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:NOW-100},
    ...(maker?{makerReduction:{activity:'unknown' as const,makerLeg:'long' as const,deadlineAt:NOW-10,bookedExecution:false}}:{})};
  const failure=Object.assign(new Error('Offline persistence unavailable'),{syscall:'rename',code:'EACCES'});
  let failSave=false,failLog=false,onceLogFailure=false,writes=0,saves=0,logCalls=0;
  let persisted:Store['data']|undefined;
  const store={data:{version:1,config,positions:[p],orders:[journal],logs:[],equity:[],killSwitch:false,fundingSeen:[]},
    save(){saves++;if(failSave)throw failure;persisted=structuredClone(store.data);},
    log(level:'info'|'warn'|'error',message:string,context?:string){
      logCalls++;store.data.logs.unshift({id:`offline-log-${logCalls}`,timestamp:Date.now(),level,message,context});
      if(failLog||onceLogFailure){onceLogFailure=false;throw failure;}store.save();
    }} as unknown as Store;
  const adapters=config.exchanges.map(id=>({id,fetchSnapshots:async()=>[],fetchAccount:async()=>({freeUsd:1000,equityUsd:1000,positions:[]}),
    prepareTrading:async()=>{writes++;throw new Error('No financial writes in this observer');},
    placeOrder:async()=>{writes++;throw new Error('No financial writes in this observer');},
    cancelOrder:async()=>{writes++;throw new Error('No financial writes in this observer');},
    reconcileOrder:async()=>{writes++;throw new Error('No financial writes in this observer');},
    fetchFundingPayments:async()=>[],close:async()=>{}} as ExchangeAdapter));
  const engine=new Engine(store,false,{adapterFactory:()=>adapters,liveEnvironment:{}});
  engine.autoEnabled=true;
  const portfolio:LivePortfolio={timestamp:NOW,pollIntervalMs:5000,maxAgeMs:15000,exchanges:config.exchanges.map(exchange=>({
    exchange,credentialsConfigured:true,status:'ready',requestedAt:NOW-1,receivedAt:NOW,
    freeUsd:1000,equityUsd:1000,positions:[{base,symbol,side:exchange==='gate'?'long':'short',quantity:100,markPrice:1,liquidationPrice:0,leverage:2}]}))};
  const terminal=():OrderResult=>({id:'offline-original-id',clientOrderId:request.clientOrderId,status:'filled',filledQuantity:1,
    averagePrice:1,averagePriceVerified:true,feeUsd:.0005,timestamp:NOW-50,orderReadAt:NOW});
  return {engine,store,p,journal,portfolio,failure,terminal,writes:()=>writes,saves:()=>saves,
    failSave(){failSave=true;},failLog(){failLog=true;},failNextLog(){onceLogFailure=true;},persisted:()=>persisted,
    observe:()=>engine.observeAccountClosures(portfolio)};
}

test('unknown diagnostic persistence failure halts trading without inventing cash or swallowing the disk failure',async t=>{
  const f=fixture(t),originalCash=structuredClone(f.p);
  f.engine.adapter('bybit').inspectOrder=async()=>({...f.journal.result!,orderReadAt:NOW,
    confirmation:{stage:'order-read',reason:'not-found',observedAt:NOW}});
  f.failSave();await assert.rejects(f.observe,error=>error===f.failure);
  assert.equal(f.store.data.killSwitch,true);assert.equal(f.engine.autoEnabled,false);assert.equal(f.writes(),0);
  assert.deepEqual(f.p,originalCash);assert.equal(f.journal.result!.status,'unknown');assert.equal(f.journal.result!.id,'offline-original-id');
});

test('unchanged diagnostic read-time persistence failure also halts, while execution timestamps and cash remain historical',async t=>{
  const f=fixture(t),originalCash=structuredClone(f.p);
  f.journal.result!.confirmation={stage:'order-read',reason:'not-found',observedAt:NOW-1};f.journal.result!.orderReadAt=NOW-1;
  f.engine.adapter('bybit').inspectOrder=async()=>({...f.journal.result!,orderReadAt:NOW,
    confirmation:{stage:'order-read',reason:'not-found',observedAt:NOW}});
  f.failSave();await assert.rejects(f.observe,error=>error===f.failure);
  assert.equal(f.store.data.killSwitch,true);assert.equal(f.engine.autoEnabled,false);assert.equal(f.writes(),0);
  assert.deepEqual(f.p,originalCash);assert.equal(f.journal.result!.timestamp,NOW-100);assert.equal(f.journal.result!.status,'unknown');
});

for(const maker of [false,true])test(`confirmed ${maker?'Maker':'IOC'} observation save failure retains real native cash and halts`,async t=>{
  const f=fixture(t,maker);
  if(maker)f.engine.adapter('gate').inspectMakerReduction=async()=>({activity:'terminal',executionVerified:true,observedAt:NOW,result:f.terminal()});
  else f.engine.adapter('bybit').inspectOrder=async()=>f.terminal();
  f.failSave();await assert.rejects(f.observe,error=>error===f.failure);
  assert.equal(f.store.data.killSwitch,true);assert.equal(f.engine.autoEnabled,false);assert.equal(f.writes(),0);
  assert.equal(f.p[maker?'long':'short'].quantity,99);assert.equal(f.journal.result!.filledQuantity,1);
  assert.equal(f.journal.result!.id,'offline-original-id');assert.equal(f.journal.result!.status,'filled');assert.equal(f.p.fundingUsd,.2);
});

test('failure to persist the terminal observation info log is surfaced after retaining its saved native receipt',async t=>{
  const f=fixture(t);f.engine.adapter('bybit').inspectOrder=async()=>f.terminal();f.failLog();
  await assert.rejects(f.observe,error=>error===f.failure);assert.equal(f.store.data.killSwitch,true);assert.equal(f.engine.autoEnabled,false);
  assert.equal(f.p.short.quantity,99);assert.equal(f.journal.result!.status,'filled');assert.ok(f.saves()>0);assert.equal(f.writes(),0);
});

for(const [name,failure] of [
  ['socket syscall timeout',Object.assign(new Error('Offline GET timeout'),{syscall:'connect',code:'ETIMEDOUT'})],
  ['account or regional access refusal',new Error('Offline native access denied')],
] as const)test(`original-order GET ${name} stays unknown without a global persistence halt`,async t=>{
  const f=fixture(t),before=structuredClone({p:f.p,journal:f.journal});
  f.engine.adapter('bybit').inspectOrder=async()=>{throw failure;};await f.observe();
  assert.equal(f.store.data.killSwitch,false);assert.equal(f.engine.autoEnabled,true);assert.equal(f.writes(),0);
  assert.deepEqual({p:f.p,journal:f.journal},before);
});

test('a local observation save failure waits for other original GETs to drain before leaving the serialized observation',async t=>{
  const f=fixture(t),second=structuredClone(f.journal);second.exchange='gate';second.request.clientOrderId='offline-second-original';
  second.result!.clientOrderId=second.request.clientOrderId;second.result!.id='offline-second-native';f.store.data.orders.push(second);
  let release!:(value:OrderResult)=>void,done=false;
  f.engine.adapter('gate').inspectOrder=async()=>new Promise<OrderResult>(resolve=>{release=resolve;});
  f.engine.adapter('bybit').inspectOrder=async()=>({...f.journal.result!,orderReadAt:NOW,confirmation:{stage:'order-read',reason:'not-found'}});
  f.failSave();const observing=f.observe().then(()=>{done=true;},error=>{done=true;throw error;});
  const rejected=assert.rejects(observing,error=>error===f.failure);
  for(let turn=0;turn<3;turn++)await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(f.store.data.killSwitch,true);assert.equal(done,false);
  release({...second.result!});await rejected;assert.equal(done,true);assert.equal(f.writes(),0);
});

function setFlatAccounts(f:ReturnType<typeof fixture>){
  for(const venue of f.portfolio.exchanges){venue.positions=[];f.engine.adapter(venue.exchange).fetchOpenOrders=async()=>[];}
}
function advanceFlatObservation(t:TestContext,f:ReturnType<typeof fixture>){
  t.mock.timers.tick(1);f.portfolio.timestamp=Date.now();
  for(const venue of f.portfolio.exchanges){venue.requestedAt=Date.now();venue.receivedAt=Date.now();}
}
test('one-off archive log persistence failure rolls back only the archive, persists the halt audit and preserves original financial history',async t=>{
  const f=fixture(t);setFlatAccounts(f);const original=structuredClone({p:f.p,orders:f.store.data.orders});
  const historical=structuredClone(f.store.data.logs);await f.observe();advanceFlatObservation(t,f);f.failNextLog();
  await assert.rejects(f.observe,error=>error===f.failure);
  assert.equal(f.store.data.killSwitch,true);assert.equal(f.engine.autoEnabled,false);assert.equal(f.writes(),0);
  assert.deepEqual({p:f.p,orders:f.store.data.orders},original);assert.equal(f.p.accountClosure,undefined);
  const audit=f.store.data.logs.find(row=>row.level==='error'&&row.message.includes('空仓归档保存失败'));
  assert.ok(audit);assert.match(audit.message,/已撤回本轮归档并停止交易/);
  for(const old of historical)assert.ok(f.store.data.logs.some(row=>row.id===old.id&&row.message===old.message));
  assert.equal(f.persisted()!.killSwitch,true);assert.deepEqual(f.persisted()!.positions,[original.p]);
  assert.deepEqual(f.persisted()!.orders,original.orders);assert.ok(f.persisted()!.logs.some(row=>row.id===audit.id));
});

test('permanent archive persistence failure still exposes the original error and leaves the halt plus original cash intact',async t=>{
  const f=fixture(t);setFlatAccounts(f);const original=structuredClone({p:f.p,orders:f.store.data.orders});
  await f.observe();advanceFlatObservation(t,f);f.failSave();
  await assert.rejects(f.observe,error=>error===f.failure);
  assert.equal(f.store.data.killSwitch,true);assert.equal(f.engine.autoEnabled,false);assert.equal(f.writes(),0);
  assert.deepEqual({p:f.p,orders:f.store.data.orders},original);assert.equal(f.p.accountClosure,undefined);
  assert.ok(f.store.data.logs.some(row=>row.level==='error'&&row.message.includes('空仓归档保存失败')));
});

for(const stage of ['open-orders','fresh-accounts'] as const)test(`flat-account ${stage} GET socket syscall stays a wait, not an archive persistence halt`,async t=>{
  const f=fixture(t);setFlatAccounts(f);const original=structuredClone({p:f.p,orders:f.store.data.orders});
  const failure=Object.assign(new Error('Offline socket failure'),{syscall:'connect',code:'ETIMEDOUT'});
  await f.observe();advanceFlatObservation(t,f);
  if(stage==='open-orders')f.engine.adapter('bybit').fetchOpenOrders=async()=>{throw failure;};
  else f.engine.adapter('bybit').fetchAccount=async()=>{throw failure;};
  await f.observe();assert.equal(f.store.data.killSwitch,false);assert.equal(f.engine.autoEnabled,true);assert.equal(f.writes(),0);
  assert.deepEqual({p:f.p,orders:f.store.data.orders},original);assert.equal(f.p.accountClosure,undefined);
});

test('failure to persist a flat-account waiting warning also halts, without converting the GET failure into a fill',async t=>{
  const f=fixture(t);setFlatAccounts(f);const original=structuredClone({p:f.p,orders:f.store.data.orders});
  await f.observe();advanceFlatObservation(t,f);f.engine.adapter('bybit').fetchOpenOrders=async()=>{throw new Error('Offline GET unavailable');};
  f.failNextLog();await assert.rejects(f.observe,error=>error===f.failure);
  assert.equal(f.store.data.killSwitch,true);assert.equal(f.engine.autoEnabled,false);assert.equal(f.writes(),0);
  assert.deepEqual({p:f.p,orders:f.store.data.orders},original);assert.equal(f.p.accountClosure,undefined);
});
