import assert from 'node:assert/strict';
import test from 'node:test';
import {Engine,safeMessage} from '../src/core/engine.js';
import {MakerClosePreflightError} from '../src/core/execution.js';
import type {Store} from '../src/core/store.js';
import {defaultConfig} from '../src/shared/config.js';
import type {AccountState,AppConfig,ExchangeAdapter,ExchangeId,MarketSnapshot,OrderRequest,Position,TradingFeeMetadata} from '../src/shared/types.js';

const NOW=Date.UTC(2026,9,10,11),base='PREFLIGHT',symbol=`${base}/USDT:USDT`;
const secret='OFFLINE_PRIVATE_KEY_SENTINEL',rawBody='OFFLINE_RAW_BODY_SENTINEL';
type Stage='maker'|'peer';
function deferred<T>(){
  let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};
}
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function bounded<T>(promise:Promise<T>):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise,new Promise<never>((_yes,no)=>{timer=setTimeout(()=>no(new Error('offline preflight did not finish')),1000);})]);}
  finally{if(timer)clearTimeout(timer);}
}
function privateFailure(stage:Stage){
  return new Error(stage==='maker'?`gate {"label":"READ_ONLY","apiKey":"${secret}","rawBody":"${rawBody}"}`:
    `bybit {"retCode":10005,"apiKey":"${secret}","rawBody":"${rawBody}"}`);
}

/** Real Engine/Execution; all quotes, fees, accounts and native checks remain in memory. */
function fixture(){
  const exchanges:ExchangeId[]=['gate','bybit'];
  const config:AppConfig={...structuredClone(defaultConfig),mode:'live',dataSource:'public',entryPolicy:'aligned',
    exchanges,symbols:[base],holdMode:'adaptive',maxOrderRetries:0,minExitProfitBps:10};
  const logs:Array<{level:unknown;message:unknown;context:unknown}>=[],posts:OrderRequest[]=[];
  const store={data:{version:1,config,positions:[],orders:[],logs:[],equity:[],killSwitch:false,fundingSeen:[]},save(){},
    log(level:unknown,message:unknown,context:unknown){logs.push({level,message,context});}} as unknown as Store;
  const quotes=new Map<ExchangeId,MarketSnapshot>(),accounts=new Map<ExchangeId,AccountState>();
  const fees:TradingFeeMetadata={takerFeeRate:.0005,takerFeeAt:Date.now(),takerFeeSource:'exchange',
    makerFeeRate:.0002,makerFeeAt:Date.now(),makerFeeSource:'exchange'};
  for(const exchange of exchanges){const isLong=exchange==='gate';
    quotes.set(exchange,{exchange,base,symbol,source:'public',timestamp:Date.now(),observedAt:Date.now(),fundingObservedAt:Date.now(),
      bookTransport:'websocket',markPrice:1,indexPrice:1,fundingRate:isLong?0:.001,intervalHours:8,nextFundingTime:Date.now()+3_600_000,
      fundingHistory:[],bids:[{price:isLong?1.006:.998,quantity:30}],asks:[{price:isLong?1.016:1,quantity:30}],
      quantityStep:1,minQuantity:1,minNotional:5,contractSize:1,openInterestUsd:1e6,volume24hUsd:1e6,feeProfile:'standard',...fees});
    accounts.set(exchange,{freeUsd:1000,equityUsd:1000,positions:[{base,symbol,side:isLong?'long':'short',quantity:100,
      entryPrice:1,markPrice:1,liquidationPrice:0,leverage:2}]});
  }
  const hooks:Record<Stage,(request:OrderRequest)=>Promise<void>>={maker:async()=>{},peer:async()=>{}};
  const entered={maker:deferred<void>(),peer:deferred<void>()};
  const adapters=exchanges.map(exchange=>({id:exchange,supportsMakerReduction:()=>true,
    fetchSnapshots:async()=>[quotes.get(exchange)!],fetchExecutionSnapshots:async()=>[quotes.get(exchange)!],
    getExecutionSnapshot:()=>quotes.get(exchange),fetchAccount:async()=>structuredClone(accounts.get(exchange)!),
    fetchFundingPayments:async()=>[],inspectTrading:async()=>{},prepareTrading:async()=>{},
    fetchTradingFee:async()=>fees,cachedTradingFee:()=>fees,
    validateMakerReduction(request:OrderRequest){assert.equal(exchange,'gate');assert.equal(request.reduceOnly,true);assert.equal(request.postOnly,true);
      entered.maker.resolve();return hooks.maker(request);},
    validateOrder(request:OrderRequest){assert.equal(exchange,'bybit');assert.equal(request.reduceOnly,true);assert.notEqual(request.postOnly,true);
      entered.peer.resolve();return hooks.peer(request);},
    submitMakerReduction:async(request:OrderRequest)=>{posts.push(request);throw new Error('failed native preflight must not submit Maker');},
    placeOrder:async(request:OrderRequest)=>{posts.push(request);throw new Error('failed native preflight must not submit peer');},
    inspectMakerReduction:async()=>{throw new Error('preflight has no native order to inspect');},cancelMakerReduction:async()=>{},
    reconcileOrder:async()=>{throw new Error('preflight has no native order to reconcile');},cancelOrder:async()=>{},close:async()=>{}
  } as ExchangeAdapter));
  const engine=new Engine(store,true,{adapterFactory:()=>adapters,liveEnvironment:{ALLOW_LIVE_TRADING:'true',
    LIVE_TRADING_ACK:'I_UNDERSTAND_THE_RISKS',GATE_API_KEY:'MEMORY',GATE_API_SECRET:'MEMORY',BYBIT_API_KEY:'MEMORY',BYBIT_API_SECRET:'MEMORY'}});
  const p:Position={id:'preflight-memory',base,mode:'live',entryPolicy:'aligned',holdMode:'adaptive',status:'open',
    openedAt:Date.now()-1000,plannedExitAt:Date.now()+3_610_000,profitExitNotionalUsd:100,
    long:{exchange:'gate',symbol,side:'long',quantity:100,entryPrice:1,markPrice:1,feesUsd:.05,liquidationDistancePct:null},
    short:{exchange:'bybit',symbol,side:'short',quantity:100,entryPrice:1,markPrice:1,feesUsd:.05,liquidationDistancePct:null},
    fundingUsd:0,feesUsd:.1,transferCostUsd:0,realizedSpreadPnlUsd:0,spreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[],
    profitExitPolicy:{firstFundingTime:Date.now()+3_600_000,earliestExitAt:Date.now()+3_610_000,minSpreadNetUsd:0,minCombinedNetUsd:0,
      fundingChecks:exchanges.map(exchange=>({exchange,timestamp:Date.now()+3_600_000}))}};
  store.data.positions.push(p);engine.snapshots=[...quotes.values()];
  for(const [exchange,account] of accounts){engine.accounts.set(exchange,account);const health=engine.health.find(row=>row.exchange===exchange)!;
    health.status='online';health.lastSuccess=Date.now();health.accountStatus='ready';health.accountUpdatedAt=Date.now();}
  engine.running=true;
  const internal=engine as unknown as {realtimeProfitPending:Set<string>;realtimeProfitPreparing:Set<string>;runRealtimeProfitExits():Promise<void>};
  return {engine,store,p,logs,posts,hooks,entered,internal,quotes,
    wake(){internal.realtimeProfitPending.add(p.id);return internal.runRealtimeProfitExits();},stop:()=>engine.stop()};
}

test('offline fixture reaches both native preflights and produces a preparation without an order intent',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.stop());
  const preparation=await f.engine.execution.prepareMakerClose(f.p);assert.ok(preparation);
  assert.equal(preparation.plan.makerLeg,'long');assert.equal(f.posts.length,0);assert.equal(f.store.data.orders.length,0);
});

for(const first of ['maker','peer'] as const)for(const later of ['resolve','reject'] as const)
test(`${first} native rejection waits for pending opposite preflight to ${later}, with safe Engine diagnostics and no order`,async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture(),maker=deferred<void>(),peer=deferred<void>();
  f.hooks.maker=()=>maker.promise;f.hooks.peer=()=>peer.promise;
  const unhandled:unknown[]=[],onUnhandled=(reason:unknown)=>unhandled.push(reason);
  process.on('unhandledRejection',onUnhandled);
  t.after(async()=>{maker.resolve();peer.resolve();await f.stop();process.off('unhandledRejection',onUnhandled);});
  let finished=false;const wake=f.wake().finally(()=>{finished=true;});
  await bounded(Promise.all([f.entered.maker.promise,f.entered.peer.promise]));
  const failing=first==='maker'?maker:peer,pending=first==='maker'?peer:maker;
  failing.reject(privateFailure(first));await turn();await turn();
  assert.equal(finished,false,'a failed side must not release preparation while its opposite native check is still pending');
  assert.equal(f.internal.realtimeProfitPreparing.has(f.p.id),true);
  assert.equal(f.logs.length,0);assert.equal(f.posts.length,0);assert.equal(f.store.data.orders.length,0);
  if(later==='resolve')pending.resolve();else pending.reject(privateFailure(first==='maker'?'peer':'maker'));
  await bounded(wake);await turn();
  const warnings=f.logs.filter(row=>row.level==='warn');assert.equal(warnings.length,1);
  const selected=first==='maker'||later==='reject'?'maker':'peer';
  const message=String(warnings[0].message);
  assert.match(message,selected==='maker'?/gate Maker 原生预检.*READ_ONLY/:/bybit 对侧减仓原生预检.*10005/);
  assert.match(message,/本轮未创建委托/);assert.equal(warnings[0].context,f.p.id);
  const display=JSON.stringify({logs:f.logs,riskReasons:f.p.riskReasons});
  assert.equal(display.includes(secret),false);assert.equal(display.includes(rawBody),false);
  assert.equal(display.includes('"retCode"'),false);assert.equal(display.includes('"apiKey"'),false);
  assert.equal(f.internal.realtimeProfitPreparing.has(f.p.id),false);assert.equal(f.store.data.killSwitch,false);
  assert.equal(f.posts.length,0);assert.equal(f.store.data.orders.length,0);assert.deepEqual([f.p.long.quantity,f.p.short.quantity],[100,100]);
  assert.deepEqual(unhandled,[]);
});

test('a synchronous Maker native throw still starts and drains the opposite pending native check',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture(),peer=deferred<void>();
  t.after(async()=>{peer.resolve();await f.stop();});
  f.hooks.maker=()=>{throw privateFailure('maker');};f.hooks.peer=()=>peer.promise;
  let finished=false;
  const preparation=f.engine.execution.prepareMakerClose(f.p).then(value=>({value}),error=>({error})).finally(()=>{finished=true;});
  await bounded(f.entered.peer.promise);await turn();assert.equal(finished,false);
  peer.resolve();const result=await bounded(preparation);assert.ok('error' in result);assert.ok(result.error instanceof MakerClosePreflightError);
  assert.equal(result.error.preflight,'maker-native');assert.equal(f.posts.length,0);assert.equal(f.store.data.orders.length,0);
  assert.equal(result.error.message.includes(secret),false);assert.equal(result.error.message.includes(rawBody),false);
});

test('a peer persistence syscall failure is preserved when the Maker native preflight also rejects',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.stop());
  const diskError=Object.assign(new Error('offline persistence failure'),{code:'ENOSPC',syscall:'write'});
  f.hooks.maker=async()=>{throw privateFailure('maker');};f.hooks.peer=async()=>{throw diskError;};
  await assert.rejects(f.engine.execution.prepareMakerClose(f.p),error=>error===diskError);
  assert.equal(f.posts.length,0);assert.equal(f.store.data.orders.length,0);
});

for(const change of ['expired-maker','moved-peer'] as const)
test(`native checks followed by ${change} report the exact local book veto and can prepare again from fresh quotes`,async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture(),maker=deferred<void>();
  f.hooks.maker=()=>maker.promise;t.after(async()=>{maker.resolve();await f.stop();});
  const cash=()=>JSON.stringify({quantities:[f.p.long.quantity,f.p.short.quantity],feesUsd:f.p.feesUsd,
    legFeesUsd:[f.p.long.feesUsd,f.p.short.feesUsd],fundingUsd:f.p.fundingUsd,
    realizedSpreadPnlUsd:f.p.realizedSpreadPnlUsd,transferCostUsd:f.p.transferCostUsd,
    profitExitNotionalUsd:f.p.profitExitNotionalUsd});
  const before=cash(),originalPrepare=f.engine.execution.prepareMakerClose.bind(f.engine.execution);
  let failure:unknown;
  f.engine.execution.prepareMakerClose=async p=>{
    try{return await originalPrepare(p);}catch(error){failure=error;throw error;}
  };
  const wake=f.wake();await bounded(Promise.all([f.entered.maker.promise,f.entered.peer.promise]));
  assert.equal(f.posts.length,0);assert.equal(f.store.data.orders.length,0);
  if(change==='expired-maker')t.mock.timers.setTime(NOW+2001);
  else{
    const quote=f.quotes.get('bybit')!;
    f.quotes.set('bybit',{...quote,asks:[{price:1.0001,quantity:30}]});
  }
  maker.resolve();await bounded(wake);
  const warnings=f.logs.filter(row=>row.level==='warn');assert.equal(warnings.length,1);
  const display=JSON.stringify({logs:f.logs,riskReasons:f.p.riskReasons});
  assert.ok(failure instanceof MakerClosePreflightError);
  assert.equal(failure.exchange,change==='expired-maker'?'gate':'bybit');
  assert.equal(failure.preflight,change==='expired-maker'?'maker-book':'peer-book');
  assert.match(String(warnings[0].message),change==='expired-maker'?/gate.*提交前盘口已过期/:/bybit.*提交前首档盘口已变化/);
  assert.match(String(warnings[0].message),/本轮未创建委托/);
  assert.doesNotMatch(display,/接口请求失败|apiKey|retCode|headers/);
  assert.equal(display.includes(secret),false);assert.equal(display.includes(rawBody),false);
  assert.equal(warnings[0].context,f.p.id);assert.equal(cash(),before);
  assert.equal(f.store.data.killSwitch,false);assert.equal(f.internal.realtimeProfitPreparing.has(f.p.id),false);
  assert.equal(f.posts.length,0);assert.equal(f.store.data.orders.length,0);
  for(const [exchange,quote] of f.quotes)f.quotes.set(exchange,{...quote,
    timestamp:Date.now(),observedAt:Date.now(),fundingObservedAt:Date.now()});
  f.hooks.maker=async()=>{};
  const renewed=await bounded(f.engine.execution.prepareMakerClose(f.p));assert.ok(renewed);
  assert.equal(renewed.plan.makerLeg,'long');assert.equal(cash(),before);
  assert.equal(f.posts.length,0);assert.equal(f.store.data.orders.length,0);
});

test('a forged local-book Error subclass cannot bypass safeMessage or leak its private payload',()=>{
  class PreparedBookChangedError extends Error {}
  for(const message of ['提交前盘口已过期，停止提交','提交前首档盘口已变化，原限价或首档数量已不可成交',
    `提交前盘口已过期，停止提交 headers {"apiKey":"${secret}","rawBody":"${rawBody}"}`]){
    const error=Object.assign(new PreparedBookChangedError(message),{url:`https://offline.invalid/${secret}`,
      headers:{authorization:secret},response:{body:rawBody}});
    const display=safeMessage(error);
    assert.equal(display,'接口请求失败，请检查连接、权限和账户配置');
    assert.equal(display.includes(secret),false);assert.equal(display.includes(rawBody),false);
    assert.doesNotMatch(display,/headers|apiKey|https?:/);
  }
});
