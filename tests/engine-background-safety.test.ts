import assert from 'node:assert/strict';
import test from 'node:test';
import {setImmediate as immediate} from 'node:timers/promises';
import {Engine} from '../src/core/engine.js';
import type {Store} from '../src/core/store.js';
import {defaultConfig} from '../src/shared/config.js';
import type {AccountState,AppConfig,ExchangeAdapter,ExchangeId,FundingPayment,JournalOrder,LivePortfolio,MarketSnapshot,OrderResult,Position} from '../src/shared/types.js';

const BASE='BGSAFE',SYMBOL='BGSAFE/USDT:USDT',VENUES:ExchangeId[]=['gate','bybit'];
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return {promise,resolve};}
async function flush(){for(let turn=0;turn<12;turn++)await immediate();}
function fixture(){
  const now=Date.now(),config:AppConfig={...structuredClone(defaultConfig),mode:'live',dataSource:'public',exchanges:VENUES,
    symbols:[BASE],holdMode:'continuous',pollIntervalMs:10};
  let fault:((stage:'save'|'log',message?:string)=>unknown)|undefined,posts=0;
  const store={data:{version:1,config,positions:[],orders:[],logs:[],equity:[],killSwitch:false,fundingSeen:[]},
    save(){const error=fault?.('save');if(error!==undefined)throw error;},
    log(level:'info'|'warn'|'error',message:string,context?:string){
      store.data.logs.push({id:`bg-${store.data.logs.length}`,timestamp:Date.now(),level,message,context});
      const error=fault?.('log',message);if(error!==undefined)throw error;store.save();
    }} as unknown as Store;
  const adapters=VENUES.map(id=>({id,fetchSnapshots:async()=>[],fetchAccount:async()=>({freeUsd:1000,equityUsd:1000,positions:[]}),
    fetchFundingPayments:async()=>[],fetchOpenOrders:async()=>[],prepareTrading:async()=>{posts++;throw new Error('Offline fixture cannot prepare');},
    placeOrder:async()=>{posts++;throw new Error('Offline fixture cannot submit');},cancelOrder:async()=>{posts++;throw new Error('Offline fixture cannot cancel');},
    reconcileOrder:async()=>{posts++;throw new Error('Offline fixture cannot reconcile through trading');},close:async()=>{}} as ExchangeAdapter));
  const engine=new Engine(store,true,{adapterFactory:()=>adapters,liveEnvironment:{ALLOW_LIVE_TRADING:'true',LIVE_TRADING_ACK:'I_UNDERSTAND_THE_RISKS',
    GATE_API_KEY:'OFFLINE',GATE_API_SECRET:'OFFLINE',BYBIT_API_KEY:'OFFLINE',BYBIT_API_SECRET:'OFFLINE'}});
  const p:Position={id:'bg-safe',base:BASE,mode:'live',status:'open',openedAt:now-60000,plannedExitAt:now+3600000,holdMode:'continuous',
    long:{exchange:'gate',symbol:SYMBOL,side:'long',quantity:10,entryPrice:1,markPrice:1,feesUsd:0,liquidationDistancePct:null},
    short:{exchange:'bybit',symbol:SYMBOL,side:'short',quantity:10,entryPrice:1,markPrice:1,feesUsd:0,liquidationDistancePct:null},
    fundingUsd:0,feesUsd:0,transferCostUsd:0,realizedSpreadPnlUsd:0,spreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[]};
  engine.running=true;engine.autoEnabled=true;
  const internal=engine as unknown as {schedule:()=>void;timer?:ReturnType<typeof setTimeout>;startGeneration:number;lastLedgerAt:number;tickFailed:(error:unknown)=>void;
    accrueLiveFunding:()=>Promise<void>;observePendingReports:(portfolio:LivePortfolio)=>Promise<void>;
    scheduleRealtimeWarmup:()=>void;warmRealtimeEntries:()=>Promise<void>;scheduleRealtimeProfitExits:()=>void;runRealtimeProfitExits:()=>Promise<void>;
    realtimeProfitCandidate:(position:Position)=>boolean;realtimeProfitFeesMissing:(position:Position)=>ExchangeId[];readProfitExitAccount:(adapter:ExchangeAdapter)=>Promise<AccountState>;
    realtimeProfitPending:Set<string>;refreshEntryContractPreviews:()=>Promise<void>;detailedOpportunities:()=>unknown[];
    managePosition:(position:Position,now:number)=>Promise<void>;
    refreshAdapter:(adapter:ExchangeAdapter,bases:string[],includeAccount?:boolean)=>Promise<boolean>;
    refreshExecutionSnapshots:(base:string,exchanges:string[],requireNativeFees?:boolean)=>Promise<void>;
    continuingClosePositions:Set<string>;pendingCloseReadWorkers:Map<string,Promise<void>>;dispatchPendingCloseRead:(position:Position)=>void};
  const addPosition=()=>{store.data.positions.push(p);return p;};
  const receipt:FundingPayment={id:'bg-native-bill',base:BASE,symbol:SYMBOL,side:'short',quantity:10,timestamp:p.openedAt+1000,amountUsd:.5};
  const addUnknown=(maker=false)=>{
    const request={clientOrderId:'bg-original-client',base:BASE,symbol:SYMBOL,side:maker?'sell' as const:'buy' as const,quantity:1,limitPrice:1,reduceOnly:true,...(maker?{postOnly:true}:{})};
    const journal:JournalOrder={positionId:p.id,exchange:maker?'gate':'bybit',request,createdAt:now-100,
      result:{id:'bg-original-native',clientOrderId:request.clientOrderId,status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:now-100},
      ...(maker?{makerReduction:{activity:'unknown',makerLeg:'long',deadlineAt:now-10,bookedExecution:false}}:{})};
    store.data.orders.push(journal);return journal;
  };
  const portfolio=():LivePortfolio=>({timestamp:Date.now(),pollIntervalMs:5000,maxAgeMs:15000,exchanges:VENUES.map(exchange=>({
    exchange,credentialsConfigured:true,status:'ready',requestedAt:Date.now()-1,receivedAt:Date.now(),freeUsd:1000,equityUsd:1000,
    positions:[{base:BASE,symbol:SYMBOL,side:exchange==='gate'?'long':'short',quantity:10,entryPrice:1,markPrice:1,liquidationPrice:0,leverage:2}]}))});
  const terminal=(journal:JournalOrder):OrderResult=>({id:journal.result!.id,clientOrderId:journal.request.clientOrderId,status:'filled',filledQuantity:1,
    averagePrice:1,averagePriceVerified:true,feeUsd:.0005,timestamp:journal.createdAt+1,orderReadAt:Date.now()});
  return {engine,internal,store,p,adapters,addPosition,addUnknown,portfolio,receipt,terminal,posts:()=>posts,
    fault:(value:typeof fault)=>fault=value,stop:async()=>{fault=undefined;await engine.stop();}};
}
const writeFaults=[['plain Error',()=>new Error('Offline actual ledger save failed')],
  ['filesystem EIO',()=>Object.assign(new Error('Offline actual ledger save failed'),{syscall:'write',code:'EIO'})]] as const;

test('the entire tick catches a pre-queue adapter callback fault, pauses entry and retains holdings',async t=>{
  const f=fixture();t.after(f.stop);f.addPosition();const before=structuredClone(f.p);
  f.adapters[0].setRealtimeBases=()=>{throw new Error('Offline subscription focus failed');};
  await f.engine.tick();assert.equal(f.engine.autoEnabled,false);assert.equal(f.store.data.killSwitch,false);
  assert.ok(f.store.data.logs.some(log=>log.message.includes('引擎暂停')&&log.message.includes('持仓继续管理')));
  assert.deepEqual(f.p,before);assert.equal(f.posts(),0);
});

for(const kind of ['async rejection','sync callback throw'] as const)test(`periodic ${kind} is handled and a later tick still runs`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture();t.after(f.stop);let calls=0;
  f.engine.tick=(kind==='async rejection'?async()=>{calls++;if(calls===1)throw new Error('Offline scheduled asynchronous fault');}:
    ()=>{calls++;if(calls===1)throw new Error('Offline scheduled synchronous fault');return Promise.resolve();});
  f.internal.schedule();t.mock.timers.tick(10);await flush();
  assert.equal(calls,1);assert.equal(f.engine.autoEnabled,false);assert.equal(f.store.data.killSwitch,false);assert.ok(f.internal.timer);
  t.mock.timers.tick(10);await flush();assert.equal(calls,2);assert.ok(f.internal.timer);assert.equal(f.posts(),0);
});

test('an exception in periodic rescheduling is observed and does not leak its derived promise',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture();t.after(f.stop);let ran=0;
  f.engine.tick=async()=>{ran++;};const schedule=f.internal.schedule.bind(f.internal);
  f.internal.schedule=()=>{throw new Error('Offline next schedule failed');};schedule();t.mock.timers.tick(10);await flush();
  assert.equal(ran,1);assert.equal(f.engine.autoEnabled,false);assert.equal(f.store.data.killSwitch,false);
  assert.ok(f.store.data.logs.some(log=>log.message.includes('Offline next schedule failed')));assert.equal(f.internal.timer,undefined);
});

test('a periodic diagnostic log save failure halts in memory while the next read-only timer still runs safely',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture();t.after(f.stop);let calls=0;
  f.engine.tick=async()=>{calls++;throw new Error('Offline scheduled fault');};
  f.fault(stage=>stage==='log'?new Error('Offline diagnostic cannot be saved'):undefined);
  f.internal.schedule();t.mock.timers.tick(10);await flush();assert.equal(f.store.data.killSwitch,true);assert.equal(f.engine.autoEnabled,false);
  t.mock.timers.tick(10);await flush();assert.equal(calls,2);assert.ok(f.internal.timer);assert.equal(f.posts(),0);
});

test('malformed exception accessors cannot turn background failure reporting into an unattended rejection',async t=>{
  const f=fixture();t.after(f.stop);const error=new Error('unused');Object.defineProperty(error,'message',{get(){throw new Error('Offline accessor failure');}});
  f.internal.tickFailed(error);assert.equal(f.engine.autoEnabled,false);assert.equal(f.store.data.killSwitch,false);
  assert.ok(f.store.data.logs.some(log=>log.message.includes('后台异常诊断不可用')));
});

for(const kind of ['warmup','profit'] as const)test(`the ${kind} timer observes an unexpected rejected callback without a global stop`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture();t.after(f.stop);
  if(kind==='warmup'){f.internal.warmRealtimeEntries=async()=>{throw new Error('Offline warmup callback failed');};f.internal.scheduleRealtimeWarmup();}
  else{f.internal.realtimeProfitPending.add('unused');f.internal.runRealtimeProfitExits=async()=>{throw new Error('Offline profit callback failed');};f.internal.scheduleRealtimeProfitExits();}
  t.mock.timers.tick(0);await flush();assert.equal(f.engine.autoEnabled,false);assert.equal(f.store.data.killSwitch,false);assert.equal(f.posts(),0);
  assert.ok(f.store.data.logs.some(log=>log.message.includes('引擎暂停')));
});

test('a contract preview calculation rejection is handled after a read-only observation publishes the account view',async t=>{
  const f=fixture();t.after(f.stop);f.internal.detailedOpportunities=()=>{throw new Error('Offline contract preview calculation failed');};
  await f.engine.observeAccountClosures(f.portfolio());await flush();
  assert.equal(f.engine.autoEnabled,false);assert.equal(f.store.data.killSwitch,false);assert.equal(f.posts(),0);
  assert.ok(f.store.data.logs.some(log=>log.message.includes('Offline contract preview calculation failed')));
});

test('an exception after a pending-order worker cleans up is handled after its registry is released',async t=>{
  const f=fixture();t.after(f.stop);f.addPosition();f.p.closeRequestedAt=Date.now()-1000;f.internal.continuingClosePositions.add(f.p.id);
  f.internal.scheduleRealtimeProfitExits=()=>{throw new Error('Offline worker continuation failed');};
  f.internal.dispatchPendingCloseRead(f.p);await flush();assert.equal(f.internal.pendingCloseReadWorkers.size,0);
  assert.equal(f.engine.autoEnabled,false);assert.equal(f.store.data.killSwitch,false);assert.equal(f.posts(),0);
  assert.ok(f.store.data.logs.some(log=>log.message.includes('Offline worker continuation failed')));
});

for(const [label,failure] of writeFaults)for(const stage of ['receipt','observation'] as const)
test(`funding ${stage} actual ${label} persistence failure surfaces after reads drain and globally halts`,async t=>{
  const f=fixture();t.after(f.stop);f.addPosition();f.adapters[1].fetchFundingPayments=async()=>[f.receipt];
  const error=failure();let faulted=false;
  f.fault(boundary=>{
    const selected=stage==='receipt'?f.store.data.fundingSeen.includes('bybit:bg-native-bill'):f.p.long.fundingObservedAt!==undefined;
    if(boundary==='save'&&selected&&!faulted){faulted=true;return error;}
  });
  await assert.rejects(f.internal.accrueLiveFunding(),caught=>caught===error);
  assert.equal(faulted,true);assert.equal(f.store.data.killSwitch,true);assert.equal(f.engine.autoEnabled,false);assert.equal(f.posts(),0);
  assert.equal(f.p.fundingUsd,.5);assert.equal(f.p.short.fundingUsd,.5);assert.deepEqual(f.store.data.fundingSeen,['bybit:bg-native-bill']);
  assert.equal(f.p.long.quantity,10);assert.equal(f.p.short.quantity,10);
  assert.ok(f.store.data.logs.some(log=>log.level==='error'&&log.message.includes('本地保存失败')));
});

test('funding warning log actual save failure preserves the original unknown cash and globally halts',async t=>{
  const f=fixture();t.after(f.stop);f.addPosition();const error=new Error('Offline funding warning save failed');
  f.adapters[1].fetchFundingPayments=async()=>{throw Object.assign(new Error('Offline socket unavailable'),{syscall:'connect',code:'ETIMEDOUT'});};
  f.fault((stage,message)=>stage==='log'&&message?.includes('资金费账单暂不可用')?error:undefined);
  await assert.rejects(f.internal.accrueLiveFunding(),caught=>caught===error);
  assert.equal(f.store.data.killSwitch,true);assert.equal(f.engine.autoEnabled,false);assert.equal(f.p.fundingUsd,0);
  assert.equal(f.p.short.fundingObservedAt,undefined);assert.deepEqual(f.store.data.fundingSeen,[]);assert.equal(f.posts(),0);
});

for(const syscall of ['connect','getaddrinfo'])test(`funding GET ${syscall} remains a local retry and does not stop other venues`,async t=>{
  const f=fixture();t.after(f.stop);f.addPosition();f.adapters[1].fetchFundingPayments=async()=>{throw Object.assign(new Error('Offline GET failed'),{syscall,code:'ETIMEDOUT'});};
  await f.internal.accrueLiveFunding();assert.equal(f.store.data.killSwitch,false);assert.equal(f.engine.autoEnabled,true);
  assert.ok(f.p.long.fundingObservedAt);assert.equal(f.p.short.fundingObservedAt,undefined);assert.equal(f.p.fundingUsd,0);assert.equal(f.posts(),0);
  f.internal.tickFailed(Object.assign(new Error('Offline unexpected GET callback failed'),{syscall,code:'ETIMEDOUT'}));
  assert.equal(f.store.data.killSwitch,false,'A syscall alone cannot establish a ledger write failure');
});

for(const [label,failure] of writeFaults)for(const maker of [false,true])
test(`GET-only ${maker?'Maker':'IOC'} confirmed observation actual ${label} save failure keeps true native cash and halts`,async t=>{
  const f=fixture();t.after(f.stop);f.addPosition();const journal=f.addUnknown(maker),error=failure();let faulted=false;
  if(maker)f.adapters[0].inspectMakerReduction=async()=>({activity:'terminal',executionVerified:true,result:f.terminal(journal),observedAt:Date.now()});
  else f.adapters[1].inspectOrder=async()=>f.terminal(journal);
  f.fault(stage=>{if(stage==='save'&&!faulted&&journal.result?.status==='filled'){faulted=true;return error;}});
  await assert.rejects(f.engine.observeAccountClosures(f.portfolio()),caught=>caught===error);
  assert.equal(f.store.data.killSwitch,true);assert.equal(f.engine.autoEnabled,false);assert.equal(journal.result!.status,'filled');
  assert.equal(f.p[maker?'long':'short'].quantity,9);assert.equal(f.p.feesUsd,.0005);assert.equal(f.p.fundingUsd,0);assert.equal(f.posts(),0);
});

test('GET-only terminal observation info log PlainError is an actual write fault after confirmed cash is saved',async t=>{
  const f=fixture();t.after(f.stop);f.addPosition();const journal=f.addUnknown(),error=new Error('Offline receipt info log save failed');
  f.adapters[1].inspectOrder=async()=>f.terminal(journal);
  f.fault((stage,message)=>stage==='log'&&message?.includes('订单已自动只读核对')?error:undefined);
  await assert.rejects(f.engine.observeAccountClosures(f.portfolio()),caught=>caught===error);
  assert.equal(f.store.data.killSwitch,true);assert.equal(f.engine.autoEnabled,false);assert.equal(f.p.short.quantity,9);
  assert.equal(journal.result!.feeUsd,.0005);assert.equal(f.posts(),0);
});

test('business-invalid observed receipts stay unknown without masquerading as a persistence failure',async t=>{
  const f=fixture();t.after(f.stop);f.addPosition();const journal=f.addUnknown(),before=structuredClone({p:f.p,journal});
  f.adapters[1].inspectOrder=async()=>({...f.terminal(journal),filledQuantity:2});
  await f.engine.observeAccountClosures(f.portfolio());assert.deepEqual({p:f.p,journal},before);
  assert.equal(f.store.data.killSwitch,false);assert.equal(f.engine.autoEnabled,true);assert.equal(f.posts(),0);
});

for(const change of ['generation','config','adapter'] as const)test(`an original order GET cannot apply after its ${change} scope changes`,async t=>{
  const f=fixture();t.after(f.stop);f.addPosition();const journal=f.addUnknown(),pending=deferred<OrderResult>(),before=structuredClone({p:f.p,journal});let started=false;
  f.adapters[1].inspectOrder=async()=>{started=true;return pending.promise;};const observing=f.engine.observeAccountClosures(f.portfolio());
  await flush();assert.equal(started,true);
  if(change==='generation')f.internal.startGeneration++;
  if(change==='config')f.store.data.config=structuredClone(f.store.data.config);
  if(change==='adapter')f.engine.adapters=f.engine.adapters.filter(adapter=>adapter!==f.adapters[1]);
  pending.resolve(f.terminal(journal));await observing;assert.deepEqual({p:f.p,journal},before);assert.equal(f.posts(),0);
});

test('funding GET results from an older generation do not publish a cash receipt or fresh observation',async t=>{
  const f=fixture();t.after(f.stop);f.addPosition();const pending=deferred<FundingPayment[]>();let started=false;
  f.adapters[1].fetchFundingPayments=async()=>{started=true;return pending.promise;};const collecting=f.internal.accrueLiveFunding();
  await flush();assert.equal(started,true);f.internal.startGeneration++;pending.resolve([f.receipt]);await collecting;
  assert.equal(f.p.fundingUsd,0);assert.equal(f.p.short.fundingObservedAt,undefined);assert.deepEqual(f.store.data.fundingSeen,[]);
  f.adapters[1].fetchFundingPayments=async()=>[f.receipt];await f.internal.accrueLiveFunding();await f.internal.accrueLiveFunding();
  assert.equal(f.p.fundingUsd,.5);assert.deepEqual(f.store.data.fundingSeen,['bybit:bg-native-bill']);assert.equal(f.posts(),0);
});

test('an older tick cannot publish account cache or manage holdings after the process generation changes',async t=>{
  const f=fixture();t.after(f.stop);f.addPosition();const before=structuredClone(f.p),pending=deferred<AccountState>();let started=false;
  // Isolate account publication; a funding observation completed before the change is valid independent evidence.
  f.internal.lastLedgerAt=Date.now();
  f.adapters[0].fetchAccount=async()=>{started=true;return pending.promise;};const ticking=f.engine.tick();await flush();assert.equal(started,true);
  f.internal.startGeneration++;pending.resolve({freeUsd:1000,equityUsd:1000,positions:[{base:BASE,symbol:SYMBOL,side:'long',quantity:10,entryPrice:1,markPrice:1,liquidationPrice:0,leverage:2}]});
  await ticking;assert.equal(f.engine.accounts.size,0);assert.deepEqual(f.p,before);assert.equal(f.posts(),0);
});

test('a direct adapter account read from an older generation cannot populate the current account cache',async t=>{
  const f=fixture();t.after(f.stop);const pending=deferred<AccountState>();let started=false;
  f.adapters[0].fetchAccount=async()=>{started=true;return pending.promise;};const reading=f.internal.refreshAdapter(f.adapters[0],[]);
  await flush();assert.equal(started,true);f.internal.startGeneration++;
  pending.resolve({freeUsd:1000,equityUsd:1000,positions:[]});assert.equal(await reading,false);assert.equal(f.engine.accounts.size,0);assert.equal(f.posts(),0);
});

for(const change of ['generation','config','adapter'] as const)test(`a new profit worker joining an old ${change} account GET cannot receive a publishable proof`,async t=>{
  const f=fixture();t.after(f.stop);const pending=deferred<AccountState>();let reads=0;
  f.adapters[0].fetchAccount=async()=>{reads++;return pending.promise;};
  const original=f.internal.readProfitExitAccount(f.adapters[0]),rejected=assert.rejects(original,/账户读取会话已变化/);await flush();
  if(change==='generation')f.internal.startGeneration++;
  if(change==='config')f.store.data.config=structuredClone(f.store.data.config);
  if(change==='adapter')f.engine.adapters=f.engine.adapters.filter(adapter=>adapter!==f.adapters[0]);
  const joined=f.internal.readProfitExitAccount(f.adapters[0]);assert.equal(joined,original,'Keep the existing bounded GET until it settles instead of duplicating it');
  pending.resolve({freeUsd:1000,equityUsd:1000,positions:[]});await rejected;
  assert.equal(reads,1);assert.equal(f.engine.accounts.size,0);assert.equal(f.store.data.killSwitch,false);assert.equal(f.engine.autoEnabled,true);assert.equal(f.posts(),0);
  if(change!=='adapter'){
    f.adapters[0].fetchAccount=async()=>{reads++;return {freeUsd:1000,equityUsd:1000,positions:[]};};
    assert.equal((await f.internal.readProfitExitAccount(f.adapters[0])).freeUsd,1000);assert.equal(reads,2);
  }
});

for(const syscall of ['connect','getaddrinfo'])test(`a Maker preflight ${syscall} failure keeps its local retry and leaves automatic entries enabled`,async t=>{
  const f=fixture();t.after(f.stop);f.addPosition();f.internal.realtimeProfitCandidate=()=>true;f.internal.realtimeProfitFeesMissing=()=>[];
  f.engine.execution.requiresMakerProfitClose=()=>true;
  f.engine.execution.prepareMakerClose=async()=>{throw Object.assign(new Error('Offline ordinary Maker GET failed'),{syscall,code:'ETIMEDOUT'});};
  f.internal.realtimeProfitPending.add(f.p.id);await f.internal.runRealtimeProfitExits();
  assert.equal(f.store.data.killSwitch,false);assert.equal(f.engine.autoEnabled,true);assert.equal(f.posts(),0);
  assert.ok(f.p.riskReasons.some(reason=>reason.includes('Maker 提交前核验未通过')));
});

test('a Maker preflight real filesystem write failure remains a global stop',async t=>{
  const f=fixture();t.after(f.stop);f.addPosition();f.internal.realtimeProfitCandidate=()=>true;f.internal.realtimeProfitFeesMissing=()=>[];
  f.engine.execution.requiresMakerProfitClose=()=>true;
  f.engine.execution.prepareMakerClose=async()=>{throw Object.assign(new Error('Offline actual preflight filesystem write failed'),{syscall:'write',code:'EIO'});};
  f.internal.realtimeProfitPending.add(f.p.id);await f.internal.runRealtimeProfitExits();
  assert.equal(f.store.data.killSwitch,true);assert.equal(f.engine.autoEnabled,false);assert.equal(f.posts(),0);
});

test('a Maker preflight actual diagnostic PlainError save failure remains a global stop',async t=>{
  const f=fixture();t.after(f.stop);f.addPosition();f.internal.realtimeProfitCandidate=()=>true;f.internal.realtimeProfitFeesMissing=()=>[];
  f.engine.execution.requiresMakerProfitClose=()=>true;f.engine.execution.prepareMakerClose=async()=>{throw new Error('Offline ordinary Maker check failed');};
  f.fault((stage,message)=>stage==='log'&&message?.includes('Maker 提交前核验未通过')?new Error('Offline actual Maker warning write failed'):undefined);
  f.internal.realtimeProfitPending.add(f.p.id);await f.internal.runRealtimeProfitExits();
  assert.equal(f.store.data.killSwitch,true);assert.equal(f.engine.autoEnabled,false);assert.equal(f.posts(),0);
});

for(const change of ['generation','config','adapter'] as const)test(`execution books returned after ${change} changes cannot overwrite the current snapshot`,async t=>{
  const f=fixture();t.after(f.stop);const now=Date.now(),original:MarketSnapshot={exchange:'gate',base:BASE,symbol:SYMBOL,source:'public',timestamp:now,observedAt:now,
    markPrice:1,indexPrice:1,fundingRate:0,nextFundingTime:now+3600000,intervalHours:8,fundingHistory:[],
    bids:[{price:.99,quantity:10}],asks:[{price:1.01,quantity:10}],quantityStep:1,minQuantity:1,minNotional:1,contractSize:1,volume24hUsd:1e6,openInterestUsd:1e6};
  f.engine.snapshots=[original];const pending=deferred<MarketSnapshot[]>();let started=false;
  f.adapters[0].fetchExecutionSnapshots=async()=>{started=true;return pending.promise;};
  const reading=f.internal.refreshExecutionSnapshots(BASE,['gate'],false),rejected=assert.rejects(reading,/读取会话已变化/);
  await flush();assert.equal(started,true);
  if(change==='generation')f.internal.startGeneration++;
  if(change==='config')f.store.data.config=structuredClone(f.store.data.config);
  if(change==='adapter')f.engine.adapters=f.engine.adapters.filter(adapter=>adapter!==f.adapters[0]);
  pending.resolve([{...original,markPrice:2,bids:[{price:1.99,quantity:10}],asks:[{price:2.01,quantity:10}]}]);
  await rejected;assert.deepEqual(f.engine.snapshots,[original]);assert.equal(f.posts(),0);
});

test('a market-read warning log save failure triggers the global stop even when the market requests use allSettled',async t=>{
  const f=fixture();t.after(f.stop);const error=new Error('Offline market diagnostic save failed');
  f.fault((stage,message)=>stage==='log'&&message?.startsWith('gate：')?error:undefined);
  await f.engine.tick();assert.equal(f.store.data.killSwitch,true);assert.equal(f.engine.autoEnabled,false);assert.equal(f.posts(),0);
});

test('the public fallback execution read cannot publish a book returned after the generation changes',async t=>{
  const f=fixture();t.after(f.stop);const pending=deferred<MarketSnapshot[]>(),now=Date.now();let started=false;
  const original:MarketSnapshot={exchange:'gate',base:BASE,symbol:SYMBOL,source:'public',timestamp:now,observedAt:now,
    markPrice:1,indexPrice:1,fundingRate:0,nextFundingTime:now+3600000,intervalHours:8,fundingHistory:[],
    bids:[{price:.99,quantity:10}],asks:[{price:1.01,quantity:10}],quantityStep:1,minQuantity:1,minNotional:1,contractSize:1,volume24hUsd:1e6,openInterestUsd:1e6};
  f.engine.snapshots=[original];f.adapters[0].fetchSnapshots=async()=>{started=true;return pending.promise;};
  const reading=f.internal.refreshExecutionSnapshots(BASE,['gate'],false),rejected=assert.rejects(reading,/读取会话已变化/);
  await flush();assert.equal(started,true);f.internal.startGeneration++;pending.resolve([{...original,markPrice:2}]);await rejected;
  assert.deepEqual(f.engine.snapshots,[original]);assert.equal(f.posts(),0);
});

test('an actual holding-management diagnostic PlainError save failure cannot masquerade as a per-coin business retry',async t=>{
  const f=fixture();t.after(f.stop);f.addPosition();f.internal.lastLedgerAt=Date.now();
  f.internal.managePosition=async()=>{throw new Error('Offline ordinary position calculation failed');};
  f.fault((stage,message)=>stage==='log'&&message?.includes('持仓管理异常')?new Error('Offline actual manager diagnostic save failed'):undefined);
  await f.engine.tick();assert.equal(f.store.data.killSwitch,true);assert.equal(f.engine.autoEnabled,false);assert.equal(f.posts(),0);
});

test('an ordinary holding-management calculation failure remains local and retains other positions management',async t=>{
  const f=fixture();t.after(f.stop);f.addPosition();f.internal.lastLedgerAt=Date.now();let checked=0;
  // This case isolates a calculation error; a genuinely missing native leg is a separate exposure incident.
  for(const adapter of f.adapters)adapter.fetchAccount=async()=>{
    const row=f.portfolio().exchanges.find(venue=>venue.exchange===adapter.id)!;
    return {freeUsd:row.freeUsd!,equityUsd:row.equityUsd!,positions:row.positions};
  };
  f.internal.managePosition=async()=>{checked++;throw Object.assign(new Error('Offline ordinary position calculation failed'),{syscall:'getaddrinfo',code:'ENOTFOUND'});};
  await f.engine.tick();assert.equal(checked,1);assert.equal(f.store.data.killSwitch,false);assert.equal(f.engine.autoEnabled,true);assert.equal(f.posts(),0);
});

test('a plain archive log write failure rolls back the archive and retains the stop with historical quantities',async t=>{
  const f=fixture();t.after(f.stop);f.addPosition();const original=structuredClone(f.p),portfolio=f.portfolio(),error=new Error('Offline archive log save failed');
  for(const venue of portfolio.exchanges)venue.positions=[];
  await f.engine.observeAccountClosures(portfolio);await immediate();
  for(const venue of portfolio.exchanges){venue.requestedAt=Date.now();venue.receivedAt=Date.now();}portfolio.timestamp=Date.now();
  f.fault((stage,message)=>stage==='log'&&message?.includes('已空仓且无挂单')?error:undefined);
  await assert.rejects(f.engine.observeAccountClosures(portfolio),caught=>caught===error);
  assert.equal(f.store.data.killSwitch,true);assert.equal(f.engine.autoEnabled,false);assert.deepEqual(f.p,original);assert.equal(f.p.accountClosure,undefined);assert.equal(f.posts(),0);
});
