import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {setImmediate as immediate} from 'node:timers/promises';
import {Engine} from '../src/core/engine.js';
import type {Store} from '../src/core/store.js';
import {FundingReadRetry,fundingReadFailure} from '../src/core/funding-read-retry.js';
import {defaultConfig} from '../src/shared/config.js';
import type {ExchangeAdapter,ExchangeId,FundingPayment,MarketSnapshot,Position} from '../src/shared/types.js';

const start=1_700_000_000_000;
const venues=['gate','bybit'] as const;
function fixture(t:TestContext){
  let now=start; t.mock.method(Date,'now',()=>now);
  const config={...structuredClone(defaultConfig),mode:'live' as const,dataSource:'public' as const,
    exchanges:[...venues],symbols:['BTC'],holdMode:'continuous' as const};
  const logs:Array<{level:string;message:string}>=[],calls=new Map<ExchangeId,number>(),accountCalls=new Map<ExchangeId,number>();
  const reads=new Map<ExchangeId,()=>Promise<FundingPayment[]>>(venues.map(venue=>[venue,async()=>[]]));
  const store={data:{config,positions:[] as Position[],orders:[],fundingSeen:[] as string[],logs,
    equity:[],killSwitch:false,spreadObservations:[],manualEntryOperations:[],manualCloseOperations:[]},
    save:()=>{},log:(level:string,message:string)=>{logs.push({level,message});}} as unknown as Store;
  const quotes=venues.map(exchange=>({exchange,base:'BTC',symbol:'BTC/USDT:USDT',source:'public',timestamp:now,observedAt:now,
    markPrice:100,indexPrice:100,fundingRate:.001,nextFundingTime:start+8*3_600_000,intervalHours:8,fundingHistory:[],
    bids:[{price:99,quantity:100}],asks:[{price:101,quantity:100}],quantityStep:1,minQuantity:1,minNotional:5,
    contractSize:1,volume24hUsd:1000,openInterestUsd:1000}) as MarketSnapshot);
  const adapters=venues.map(id=>({id,fetchSnapshots:async()=>[quotes.find(quote=>quote.exchange===id)!],
    fetchAccount:async()=>{accountCalls.set(id,(accountCalls.get(id)??0)+1);return {freeUsd:1000,equityUsd:1000,positions:[]};},
    fetchFundingPayments:async()=>{calls.set(id,(calls.get(id)??0)+1);return reads.get(id)!();},
    prepareTrading:async()=>{throw new Error('OFFLINE funding test must never prepare a trade');},
    placeOrder:async()=>{throw new Error('OFFLINE test must never submit orders');},
    cancelOrder:async()=>{throw new Error('OFFLINE test must never cancel orders');},
    reconcileOrder:async()=>{throw new Error('OFFLINE test must never reconcile a financial order');},
    close:async()=>{}}) as ExchangeAdapter);
  const engine=new Engine(store,true,{adapterFactory:()=>adapters,privateReadDeadlineMs:10,liveEnvironment:{ALLOW_LIVE_TRADING:'true',
    LIVE_TRADING_ACK:'I_UNDERSTAND_THE_RISKS',GATE_API_KEY:'OFFLINE',GATE_API_SECRET:'OFFLINE',BYBIT_API_KEY:'OFFLINE',BYBIT_API_SECRET:'OFFLINE'}});
  const p:Position={id:'OFFLINE-FUNDING',base:'BTC',mode:'live',status:'open',openedAt:start-1000,plannedExitAt:start+8*3_600_000,
    holdMode:'continuous',long:{exchange:'gate',symbol:'BTC/USDT:USDT',side:'long',quantity:1,entryPrice:100,markPrice:100,feesUsd:0,liquidationDistancePct:null},
    short:{exchange:'bybit',symbol:'BTC/USDT:USDT',side:'short',quantity:1,entryPrice:100,markPrice:100,feesUsd:0,liquidationDistancePct:null},
    fundingUsd:0,feesUsd:0,transferCostUsd:0,realizedSpreadPnlUsd:0,spreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[]};
  store.data.positions.push(p);engine.snapshots=quotes;engine.autoEnabled=true;
  const internal=engine as unknown as {accrueLiveFunding:()=>Promise<void>;boundedPrivateRead:<T>(adapter:ExchangeAdapter,key:string,read:()=>Promise<T>)=>Promise<T>};
  return {engine,store,p,reads,quotes,adapters,logs,calls,accountCalls,
    at:(value:number)=>{now=start+value;},collect:()=>internal.accrueLiveFunding(),internal};
}
const refusals=(code:number)=>new Error(`bybit {"retCode":${code},"retMsg":"OFFLINE_SECRET token=not-for-logs signature=private"}`);
function deferred<T>(){let resolve!:(value:T)=>void;let reject!:(error:unknown)=>void;
  const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const warnings=(f:ReturnType<typeof fixture>)=>f.logs.filter(log=>log.level==='warn'&&log.message.includes('资金费账单'));

test('one venue backs off 15, 30, 60 then 120 seconds while successful venue continues independent reads',async t=>{
  const f=fixture(t);f.reads.set('bybit',async()=>{throw refusals(10001);});
  for(const [at,expected] of [[0,1],[14_999,1],[15_000,2],[44_999,2],[45_000,3],[104_999,3],[105_000,4],
    [224_999,4],[225_000,5],[344_999,5],[345_000,6]]){
    f.at(at);await f.collect();assert.equal(f.calls.get('bybit'),expected);
  }
  assert.equal(f.calls.get('gate'),11);assert.equal(warnings(f).length,4);
  assert.match(warnings(f)[0].message,/官方代码 10001.*15 秒/);
  assert.equal(f.p.short.fundingObservedAt,undefined);assert.equal(f.p.short.fundingUsd,undefined);
  assert.equal(f.p.fundingUsd,0);assert.deepEqual(f.store.data.fundingSeen,[]);assert.equal(f.store.data.orders.length,0);
  assert.equal(f.engine.autoEnabled,true);assert.equal(f.store.data.killSwitch,false);
});

test('safe cause changes log immediately, repeated same cause is throttled and no private response text is retained',async t=>{
  const f=fixture(t);let code=10001;f.reads.set('bybit',async()=>{throw refusals(code);});
  await f.collect();code=10005;f.at(15_000);await f.collect();f.at(45_000);await f.collect();
  assert.equal(warnings(f).length,2);assert.match(warnings(f)[1].message,/读取权限不足.*10005/);
  assert.ok(!f.logs.some(log=>/OFFLINE_SECRET|token=|signature=|retMsg|\{/.test(log.message)));
});

test('a complete accepted recovery resets retry pacing, announces once and retains receipt deduplication',async t=>{
  const f=fixture(t);f.reads.set('bybit',async()=>{throw refusals(10001);});await f.collect();
  const payment:FundingPayment={id:'OFFLINE-RECEIPT',base:'BTC',symbol:f.p.short.symbol,side:'short',quantity:1,
    timestamp:f.p.openedAt+500,amountUsd:-.2};
  f.reads.set('bybit',async()=>[payment]);f.at(15_000);await f.collect();await f.collect();
  assert.equal(f.calls.get('bybit'),3);assert.equal(f.p.fundingUsd,-.2);assert.equal(f.p.short.fundingUsd,-.2);
  assert.deepEqual(f.store.data.fundingSeen,['bybit:OFFLINE-RECEIPT']);
  assert.equal(f.logs.filter(log=>/资金费账单读取已恢复/.test(log.message)).length,1);
  f.reads.set('bybit',async()=>{throw refusals(10001);});await f.collect();
  assert.match(warnings(f).at(-1)!.message,/15 秒/);assert.equal(f.store.data.orders.length,0);
});

test('foreign terminal order evidence leaves a funding invoice unconsumed and retries exactly once after identity repair',async t=>{
  const f=fixture(t),request={clientOrderId:'OFFLINE-ORIGINAL',base:f.p.base,symbol:f.p.short.symbol,
    side:'sell' as const,quantity:1,limitPrice:100,reduceOnly:false};
  const order={positionId:f.p.id,exchange:'bybit' as const,request,createdAt:f.p.openedAt+100,
    result:{id:'OFFLINE-NATIVE',clientOrderId:'OFFLINE-FOREIGN',status:'filled' as const,
      filledQuantity:1,averagePrice:100,feeUsd:.01,timestamp:f.p.openedAt+200}};
  f.store.data.orders.push(order);
  const payment:FundingPayment={id:'OFFLINE-WAIT-IDENTITY',base:f.p.base,symbol:f.p.short.symbol,
    side:'short',quantity:1,timestamp:f.p.openedAt+500,amountUsd:.3};
  f.reads.set('bybit',async()=>[payment]);await f.collect();
  assert.equal(f.p.fundingUsd,0);assert.equal(f.p.short.fundingObservedAt,undefined);assert.deepEqual(f.store.data.fundingSeen,[]);
  order.result.clientOrderId=request.clientOrderId;f.at(1);await f.collect();await f.collect();
  assert.equal(f.p.fundingUsd,.3);assert.equal(f.p.short.fundingUsd,.3);
  assert.deepEqual(f.store.data.fundingSeen,['bybit:OFFLINE-WAIT-IDENTITY']);assert.equal(f.store.data.orders.length,1);
});

test('timed-out funding reads stay single-flight and late completion never applies cash or releases a false success',async t=>{
  const f=fixture(t),pending=deferred<FundingPayment[]>();f.reads.set('bybit',()=>pending.promise);
  await f.collect();assert.equal(f.calls.get('bybit'),1);assert.match(warnings(f)[0].message,/只读请求超时/);
  f.at(15_000);await f.collect();f.at(30_000);await f.collect();
  assert.equal(f.calls.get('bybit'),1);assert.equal(warnings(f).length,1);
  pending.resolve([{id:'OFFLINE-LATE',base:'BTC',timestamp:f.p.openedAt+500,amountUsd:99}]);await immediate();
  assert.equal(f.p.fundingUsd,0);assert.equal(f.p.short.fundingObservedAt,undefined);
  assert.deepEqual(f.store.data.fundingSeen,[]);assert.equal(f.logs.filter(log=>/读取已恢复/.test(log.message)).length,0);
  f.reads.set('bybit',async()=>[{id:'OFFLINE-FRESH',base:'BTC',timestamp:f.p.openedAt+500,amountUsd:.3}]);
  await f.collect();assert.equal(f.calls.get('bybit'),2);assert.equal(f.p.fundingUsd,.3);
  assert.deepEqual(f.store.data.fundingSeen,['bybit:OFFLINE-FRESH']);
});

test('a late rejection clears the raw single-flight slot without an unhandled rejection or a fake invoice',async t=>{
  const f=fixture(t),pending=deferred<FundingPayment[]>();f.reads.set('bybit',()=>pending.promise);
  await f.collect();pending.reject(refusals(10001));await immediate();
  assert.equal(f.p.fundingUsd,0);assert.deepEqual(f.store.data.fundingSeen,[]);
  f.reads.set('bybit',async()=>[]);f.at(15_000);await f.collect();
  assert.equal(f.calls.get('bybit'),2);assert.equal(f.logs.filter(log=>/读取已恢复/.test(log.message)).length,1);
});

test('a pending funding read cannot block an account read or a successful different venue receipt',async t=>{
  const f=fixture(t),pending=deferred<FundingPayment[]>();f.reads.set('bybit',()=>pending.promise);
  f.reads.set('gate',async()=>[{id:'OFFLINE-GATE',base:'BTC',timestamp:f.p.openedAt+500,amountUsd:.4}]);
  await f.collect();const bybit=f.adapters.find(adapter=>adapter.id==='bybit')!;
  const account=await f.internal.boundedPrivateRead(bybit,'account',()=>bybit.fetchAccount());
  assert.equal(account.freeUsd,1000);assert.equal(f.accountCalls.get('bybit'),1);assert.equal(f.p.fundingUsd,.4);
  assert.equal(f.p.long.fundingUsd,.4);assert.equal(f.p.short.fundingUsd,undefined);
  assert.deepEqual(f.store.data.fundingSeen,['gate:OFFLINE-GATE']);pending.resolve([]);await immediate();
  assert.equal(f.store.data.orders.length,0);assert.equal(f.engine.autoEnabled,true);
});

test('crossing a previously observed future funding clock probes once before a long failure backoff expires',async t=>{
  const f=fixture(t);f.quotes.find(quote=>quote.exchange==='bybit')!.nextFundingTime=start+110_000;
  f.reads.set('bybit',async()=>{throw refusals(10001);});
  for(const at of [0,15_000,45_000,105_000]){f.at(at);await f.collect();}
  assert.equal(f.calls.get('bybit'),4);
  f.at(110_000);await f.collect();assert.equal(f.calls.get('bybit'),5,'the known settlement boundary cannot wait until 225 seconds');
  for(const at of [110_001,115_000,120_000]){f.at(at);await f.collect();}
  assert.equal(f.calls.get('bybit'),5,'one stale past clock must not trigger a request on every poll');
  assert.equal(f.p.short.fundingObservedAt,undefined);assert.deepEqual(f.store.data.fundingSeen,[]);
});

test('an already past clock first seen after failure cannot fabricate repeated settlement retries',async t=>{
  const f=fixture(t);f.quotes.find(quote=>quote.exchange==='bybit')!.nextFundingTime=start-1;
  f.reads.set('bybit',async()=>{throw refusals(10001);});await f.collect();
  for(const at of [1,1000,14_999]){f.at(at);await f.collect();}
  assert.equal(f.calls.get('bybit'),1);f.at(15_000);await f.collect();assert.equal(f.calls.get('bybit'),2);
});

test('a known settlement boundary never bypasses an in-flight timeout request',async t=>{
  const f=fixture(t),pending=deferred<FundingPayment[]>();f.quotes.find(quote=>quote.exchange==='bybit')!.nextFundingTime=start+1000;
  f.reads.set('bybit',()=>pending.promise);await f.collect();f.at(1000);await f.collect();f.at(1001);await f.collect();
  assert.equal(f.calls.get('bybit'),1);pending.resolve([]);await immediate();
  f.reads.set('bybit',async()=>[]);await f.collect();assert.equal(f.calls.get('bybit'),2,'the single deferred boundary probe runs only after the old request settles');
});

test('replaced adapter credentials do not inherit the prior adapter funding failure backoff',async t=>{
  const f=fixture(t);f.reads.set('bybit',async()=>{throw refusals(10001);});await f.collect();
  const old=f.adapters.find(adapter=>adapter.id==='bybit')!,replacement={...old};
  f.engine.adapters=f.engine.adapters.map(adapter=>adapter===old?replacement:adapter);
  f.reads.set('bybit',async()=>[]);f.at(1);await f.collect();
  assert.equal(f.calls.get('bybit'),2);assert.equal(f.logs.filter(log=>/读取已恢复/.test(log.message)).length,0);
});

test('retry state resets on clear and rejects only pending requests while leaving other adapter schedules separate',()=>{
  const retry=new FundingReadRetry(),a={},b={};
  assert.equal(retry.ready(a,start,[]),true);retry.failed(a,refusals(10001),'bybit',start);
  assert.equal(retry.ready(a,start+1,[]),false);assert.equal(retry.ready(b,start+1,[]),true);
  retry.clear();assert.equal(retry.ready(a,start+1,[]),true);assert.equal(retry.ready(a,start+1,[],true),false);
  assert.equal(retry.succeeded(a),false);
});

test('a changed future settlement clock replaces the old future clock without issuing an early phantom probe',()=>{
  const retry=new FundingReadRetry(),adapter={},key='OFFLINE-CLOCK';
  retry.ready(adapter,start,[{key,nextFundingTime:start+1000}]);retry.failed(adapter,refusals(10001),'bybit',start);
  assert.equal(retry.ready(adapter,start+500,[{key,nextFundingTime:start+2000}]),false);
  assert.equal(retry.ready(adapter,start+1000,[{key,nextFundingTime:start+2000}]),false);
  assert.equal(retry.ready(adapter,start+2000,[{key,nextFundingTime:start+2000}]),true);
  retry.failed(adapter,refusals(10001),'bybit',start+2000);
  assert.equal(retry.ready(adapter,start+2001,[{key,nextFundingTime:start+2000}]),false);
});

test('funding diagnostics retain only fixed reasons and validated venue-scoped codes, including malformed accessors',()=>{
  const failure=fundingReadFailure('bybit',refusals(10005));assert.match(failure.reason,/读取权限不足.*10005/);
  assert.ok(!/OFFLINE_SECRET|token=|signature=|retMsg/.test(JSON.stringify(failure)));
  assert.equal(fundingReadFailure('gate',refusals(10005)).apiCode,undefined);
  const error=new Error('OFFLINE');Object.defineProperty(error,'message',{get:()=>{throw new Error('OFFLINE_SECRET');}});
  assert.deepEqual(fundingReadFailure('bybit',error),{code:'API_ERROR',apiCode:undefined,reason:'账单接口响应异常',signature:'API_ERROR:'});
});

test('local funding phases never inspect private errors or inherit authorization codes, and phase changes log separately',()=>{
  const error=refusals(10005),retry=new FundingReadRetry(),adapter={};
  const read=retry.failed(adapter,error,'bybit',start);
  const attribute=retry.failed(adapter,error,'bybit',start+1,'attribute');
  const save=retry.failed(adapter,error,'bybit',start+2,'save');
  assert.equal(read.apiCode,'10005');assert.equal(attribute.code,'LOCAL_ATTRIBUTION_ERROR');assert.equal(save.code,'LOCAL_SAVE_ERROR');
  assert.equal(attribute.apiCode,undefined);assert.equal(save.apiCode,undefined);assert.equal(attribute.log,true);assert.equal(save.log,true);
  assert.notEqual(attribute.signature,read.signature);assert.notEqual(save.signature,attribute.signature);
  assert.ok(!/OFFLINE_SECRET|token=|signature=|retMsg|10005|权限|官方代码/.test(JSON.stringify([attribute,save])));
  const malformed=new Error('OFFLINE');Object.defineProperty(malformed,'message',{get:()=>{throw new Error('OFFLINE_SECRET');}});
  assert.equal(fundingReadFailure('bybit',malformed,'attribute').reason,'资金费账单本地归属核对失败');
  assert.equal(fundingReadFailure('bybit',malformed,'save').reason,'资金费账单本地保存失败');
});

test('a local funding ownership exception after a successful GET is not reported as an API authorization failure',async t=>{
  const f=fixture(t),receipt:FundingPayment={id:'OFFLINE-BROKEN-OWNERSHIP',base:'BTC',timestamp:f.p.openedAt+500,amountUsd:.5};
  Object.defineProperty(receipt,'id',{get:()=>{throw refusals(10005);}});
  f.reads.set('bybit',async()=>[receipt]);await f.collect();
  const warning=warnings(f);assert.equal(warning.length,1);assert.match(warning[0].message,/bybit.*本地归属核对失败/);
  assert.ok(!/OFFLINE_SECRET|token=|signature=|retMsg|10005|权限|官方代码/.test(warning[0].message));
  assert.equal(f.p.fundingUsd,0);assert.deepEqual(f.store.data.fundingSeen,[]);assert.equal(f.p.short.fundingObservedAt,undefined);
  assert.equal(f.p.long.fundingObservedAt,start);assert.equal(f.store.data.orders.length,0);
});

test('receipt and final observation save failures surface a global halt without exposing API-looking error bodies',async t=>{
  const f=fixture(t);f.reads.set('bybit',async()=>[{id:'OFFLINE-ACCEPTED',base:'BTC',timestamp:f.p.openedAt+500,amountUsd:.5}]);
  const failure=refusals(10005);f.store.save=()=>{throw failure;};await assert.rejects(f.collect(),caught=>caught===failure);
  const diagnosis=f.logs.filter(log=>log.level==='error'&&log.message.includes('资金费账单'));
  assert.equal(diagnosis.length,2);assert.ok(diagnosis.every(log=>/本地保存失败/.test(log.message)));
  assert.ok(diagnosis.some(log=>log.message.startsWith('gate ')));assert.ok(diagnosis.some(log=>log.message.startsWith('bybit ')));
  assert.ok(!/OFFLINE_SECRET|token=|signature=|retMsg|10005|权限|官方代码/.test(JSON.stringify(diagnosis)));
  // Retain verified in-memory cash and ownership while refusing further trades after an actual save fault.
  assert.equal(f.p.long.fundingObservedAt,start);assert.equal(f.p.short.fundingObservedAt,undefined);
  assert.equal(f.p.fundingUsd,.5);assert.deepEqual(f.store.data.fundingSeen,['bybit:OFFLINE-ACCEPTED']);assert.equal(f.store.data.orders.length,0);
  assert.equal(f.store.data.killSwitch,true);assert.equal(f.engine.autoEnabled,false);
});
