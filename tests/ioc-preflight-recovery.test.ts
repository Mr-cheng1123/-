import test from 'node:test';
import assert from 'node:assert/strict';
import {Execution} from '../src/core/execution.js';
import {defaultConfig} from '../src/shared/config.js';
import {unknownOrder} from '../src/adapters/normalization.js';
import {ExchangeNetworkError} from '../src/adapters/network.js';
import {tradingError} from '../src/core/trading-errors.js';
import type {Store} from '../src/core/store.js';
import type {AppConfig,ExchangeAdapter,ExchangeId,JournalOrder,MarketSnapshot,NativeExitRecoveryAudit,OrderRequest,OrderResult,Position} from '../src/shared/types.js';

function fixture(base='IOCEXIT'){
  let config:AppConfig={...structuredClone(defaultConfig),mode:'live',dataSource:'public',entryPolicy:'aligned',holdMode:'adaptive',
    profitExitExecutionMode:'ioc',exchanges:['gate','bybit'],symbols:[base],minExitProfitBps:10,feeRebatePct:{gate:70,bitget:50}};
  const now=Date.now(),symbol=`${base}/USDT:USDT`;
  const p:Position={id:`offline-${base}`,base,mode:'live',entryPolicy:'aligned',holdMode:'adaptive',status:'open',openedAt:now-60_000,
    plannedExitAt:now+4_000_000,profitExitNotionalUsd:10,
    long:{exchange:'gate',symbol,side:'long',quantity:10,entryPrice:1,markPrice:1,feesUsd:.001,liquidationDistancePct:null},
    short:{exchange:'bybit',symbol,side:'short',quantity:10,entryPrice:1,markPrice:1,feesUsd:.001,liquidationDistancePct:null},
    fundingUsd:0,feesUsd:.002,transferCostUsd:0,realizedSpreadPnlUsd:0,spreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[],
    profitExitPolicy:{firstFundingTime:now+3_600_000,earliestExitAt:now+3_610_000,minSpreadNetUsd:0,minCombinedNetUsd:0,fundingChecks:[]}};
  const orders:JournalOrder[]=[],logs:string[]=[],saved:unknown[]=[],posts:Array<{exchange:ExchangeId;request:OrderRequest}>=[],reads:string[]=[];
  for(const leg of [p.long,p.short]){const id=`offline-open-${leg.exchange}-${base}`;
    orders.push({positionId:p.id,exchange:leg.exchange,createdAt:p.openedAt,
      request:{clientOrderId:id,base,symbol,side:leg.side==='long'?'buy':'sell',quantity:10,limitPrice:1,reduceOnly:false},
      result:{id:`native-${id}`,clientOrderId:id,status:'filled',filledQuantity:10,averagePrice:1,averagePriceVerified:true,feeUsd:.001,timestamp:p.openedAt}});
  }
  let saveFault=0,saves=0,allowed=true;
  const data={version:1 as const,config,positions:[p],orders,logs:[],equity:[],killSwitch:false,fundingSeen:[]};
  const store={data,save(){saves++;if(saveFault===saves)throw new Error('offline persistence failure');saved.push(structuredClone(data));},
    log(_level:unknown,message:string){logs.push(message);}} as unknown as Store;
  const books=new Map<ExchangeId,MarketSnapshot>();
  for(const exchange of ['gate','bybit'] as const)books.set(exchange,{exchange,base,symbol,source:'public',timestamp:now,observedAt:now,fundingObservedAt:now,
    markPrice:1,indexPrice:1,fundingRate:exchange==='bybit'?.001:0,nextFundingTime:now+3_600_000,intervalHours:8,fundingHistory:[],
    bids:[{price:exchange==='gate'?1.02:1,quantity:10}],asks:[{price:exchange==='gate'?1.03:1.01,quantity:10}],
    quantityStep:1,minQuantity:1,minNotional:1_000_000,contractSize:1,openInterestUsd:1e6,volume24hUsd:1e6,
    takerFeeRate:.0005,takerFeeAt:now,takerFeeSource:'exchange'});
  const result=(request:OrderRequest,fill=request.quantity,status:OrderResult['status']=fill===request.quantity?'filled':fill>0?'partial':'cancelled'):OrderResult=>({
    id:`native-${request.clientOrderId}`,clientOrderId:request.clientOrderId,status,filledQuantity:fill,
    averagePrice:fill?request.limitPrice:0,averagePriceVerified:true,feeUsd:fill*request.limitPrice*.0005,timestamp:Date.now()});
  let queue=Promise.resolve();const serial=<T>(fn:()=>Promise<T>):Promise<T>=>{const next=queue.then(fn,fn);queue=next.then(()=>undefined,()=>undefined);return next;};
  const adapters=new Map<ExchangeId,ExchangeAdapter>();
  for(const exchange of ['gate','bybit'] as const)adapters.set(exchange,{id:exchange,fetchSnapshots:async()=>[],fetchFundingPayments:async()=>[],prepareTrading:async()=>{},
    fetchAccount:async()=>{reads.push(`account:${exchange}`);const leg=exchange==='gate'?p.long:p.short;
      return {freeUsd:100,equityUsd:100,positions:leg.quantity>0?[{base,symbol,side:leg.side,quantity:leg.quantity,entryPrice:1,markPrice:1,
        liquidationPrice:0,leverage:2,marginMode:'crossed',positionId:`slot-${exchange}`,positionOpenedAt:p.openedAt}]:[]};},
    fetchOpenOrders:async()=>{reads.push(`open:${exchange}`);return [];},validateOrder:async()=>{},
    placeOrder:async(request,permit)=>{assert.equal(permit?.(),true);posts.push({exchange,request:structuredClone(request)});return result(request);},
    reconcileOrder:async request=>unknownOrder(request),cancelOrder:async()=>{throw new Error('IOC must not rest or require cancel');},close:async()=>{}});
  const refresh=()=>{for(const book of books.values())Object.assign(book,{timestamp:Date.now(),observedAt:Date.now()});};
  const execution=new Execution(store,{config:()=>config,liveUnlocked:()=>allowed,makerActionsAllowed:()=>allowed,serialize:serial,
    snapshot:exchange=>books.get(exchange as ExchangeId),adapter:exchange=>adapters.get(exchange as ExchangeId)!,canUseSnapshot:()=>true,
    refreshSnapshots:async()=>refresh(),halt:reason=>logs.push(`halt:${reason}`)});
  return {execution,store,p,books,adapters,posts,reads,saved,logs,result,serial,refresh,
    async close(){await execution.drainIocProfitCloses();await execution.drainMakerCloses();},
    async start(validate=()=>true){assert.equal(execution.dispatchIocProfitClose(p,'offline IOC profit exit',validate),true);await execution.waitIocProfitClose(p);},
    revoke(){allowed=false;},changeConfig(){config={...config};store.data.config=config;},failNextSave(offset=1){saveFault=saves+offset;}};
}

function expireBooksAfterAccount(f:ReturnType<typeof fixture>){
  const account=f.adapters.get('gate')!.fetchAccount!;
  f.adapters.get('gate')!.fetchAccount=async()=>{const result=await account();for(const book of f.books.values())book.timestamp=book.observedAt=Date.now()-120000;return result;};
}

test('slow native account reads are followed by selected public books and preserve the original IOC IDs, quantities and limits',async t=>{
  const f=fixture();t.after(()=>f.close());let freshBooks=0;const checked=new Map<string,OrderRequest>(),feeTimes=[...f.books.values()].map(book=>book.takerFeeAt);
  for(const [exchange,adapter] of f.adapters){const account=adapter.fetchAccount!;
    adapter.validateOrder=async request=>{checked.set(exchange,structuredClone(request));};
    adapter.fetchAccount=async()=>{const result=await account();for(const book of f.books.values())book.timestamp=book.observedAt=Date.now()-120000;return result;};
  }
  f.execution.context.refreshReductionSnapshots=async(base,venues)=>{
    assert.equal(base,f.p.base);assert.deepEqual([...venues].sort(),['bybit','gate']);assert.equal(f.reads.length,4);
    freshBooks++;f.refresh();f.books.get('gate')!.bids[0].price=1.021;f.books.get('bybit')!.asks[0].price=1.009;
  };
  await f.start();assert.equal(freshBooks,1);assert.equal(f.posts.length,2);assert.equal(f.p.status,'closed');
  for(const post of f.posts)assert.deepEqual(post.request,checked.get(post.exchange));
  assert.deepEqual(f.posts.map(post=>post.request.quantity),[10,10]);assert.deepEqual(f.posts.map(post=>post.request.limitPrice),[1.02,1.01]);
  assert.deepEqual([...f.books.values()].map(book=>book.takerFeeAt),feeTimes);assert.equal(f.store.data.killSwitch,false);
});

for(const change of ['quantity-step','compatible-step','symbol','contract-size'] as const)
test(`a post-native public ${change} change rejects the original IOC batch before any durable intent`,async t=>{
  const f=fixture();t.after(()=>f.close());let refreshed=0;expireBooksAfterAccount(f);
  f.execution.context.refreshReductionSnapshots=async()=>{
    refreshed++;f.refresh();const book=f.books.get('bybit')!;
    if(change==='quantity-step')book.quantityStep=3;
    if(change==='compatible-step')book.quantityStep=.5;
    if(change==='symbol')book.symbol='OTHER/USDT:USDT';
    if(change==='contract-size')book.contractSize=2;
  };
  await f.start();assert.equal(refreshed,1);assert.equal(f.posts.length,0);assert.equal(f.store.data.orders.length,2);
  assert.equal(f.p.closeRequestedAt,undefined);assert.equal(f.p.long.quantity,10);assert.equal(f.p.short.quantity,10);
  assert.equal(f.store.data.killSwitch,false);assert.ok(f.execution.iocProfitCloseRetryAfter(f.p)>Date.now());
});

function freshDrift(f:ReturnType<typeof fixture>,change:'price'|'capacity'){
  const checked:OrderRequest[]=[],account=f.adapters.get('gate')!.fetchAccount!;
  let changed=false,recovered=0;
  for(const adapter of f.adapters.values())adapter.validateOrder=async request=>{checked.push(structuredClone(request));};
  f.adapters.get('gate')!.fetchAccount=async()=>{const value=await account();if(!changed){changed=true;
    f.books.get('gate')!.bids[0]=change==='price'?{price:1.019,quantity:10}:{price:1.02,quantity:9};f.refresh();
  }return value;};
  f.execution.context.refreshReductionSnapshots=async()=>{recovered++;f.refresh();};
  return {checked,recovered:()=>recovered};
}

for(const change of ['price','capacity'] as const)test(`a still-profitable fresh post-native ${change} update replans only uncommitted requests and validates them exactly`,async t=>{
  const f=fixture('CVC');t.after(()=>f.close());const d=freshDrift(f,change),original=structuredClone(f.store.data.orders),
    feeTimes=[...f.books.values()].map(book=>book.takerFeeAt);
  await f.start();assert.ok(f.posts.length>=2,'the safe fresh candidate must progress');
  assert.equal(d.recovered(),0,'an already complete fresh book needs no additional public GET');
  for(const post of f.posts)assert.ok(d.checked.some(request=>JSON.stringify(request)===JSON.stringify(post.request)),
    'each posted quantity/limit/ID must have its exact new native validation');
  assert.deepEqual(f.store.data.orders.slice(0,2),original);assert.deepEqual([...f.books.values()].map(book=>book.takerFeeAt),feeTimes);
  assert.equal(f.posts[0].request.quantity,change==='capacity'?9:10);assert.equal(f.posts[0].request.limitPrice,change==='price'?1.019:1.02);
  assert.equal(f.p.status,'closed');assert.equal(f.store.data.killSwitch,false);
});

for(const change of ['price','capacity'] as const)test(`a stale post-native book recovers once and replans the safe new ${change} batch`,async t=>{
  const f=fixture('CVC');t.after(()=>f.close());expireBooksAfterAccount(f);const checked:OrderRequest[]=[];let refreshed=0;
  for(const adapter of f.adapters.values())adapter.validateOrder=async request=>{checked.push(structuredClone(request));};
  f.execution.context.refreshReductionSnapshots=async()=>{refreshed++;f.refresh();const book=f.books.get('bybit')!;
    if(change==='price')book.asks[0].price=1.011;else book.asks[0].quantity=9;};
  await f.start();assert.ok(f.posts.length>=2);assert.equal(f.store.data.killSwitch,false);
  assert.equal(f.posts[0].request.quantity,change==='capacity'?9:10);
  assert.equal(f.posts[1].request.limitPrice,change==='price'?1.011:1.01);
  for(const post of f.posts)assert.ok(checked.some(request=>JSON.stringify(request)===JSON.stringify(post.request)));
  assert.equal(refreshed,change==='capacity'?2:1);
});

test('a larger replacement first level never enlarges the original uncommitted batch',async t=>{
  const f=fixture('CVC');t.after(()=>f.close());f.books.get('gate')!.bids[0].quantity=5;
  const account=f.adapters.get('gate')!.fetchAccount!,checked:OrderRequest[]=[];let changed=false;
  for(const adapter of f.adapters.values())adapter.validateOrder=async request=>{checked.push(structuredClone(request));};
  f.adapters.get('gate')!.fetchAccount=async()=>{const value=await account();if(!changed){changed=true;
    f.books.get('gate')!.bids[0]={price:1.019,quantity:100};f.refresh();}return value;};
  await f.start();assert.equal(f.p.status,'closed');assert.deepEqual(f.posts.slice(0,2).map(post=>post.request.quantity),[5,5]);
  for(const post of f.posts)assert.ok(checked.some(request=>JSON.stringify(request)===JSON.stringify(post.request)));
});

test('continuous fresh price churn performs at most two replacements and preserves zero intents',async t=>{
  const f=fixture('CVC');t.after(()=>f.close());const d=freshDrift(f,'price'),original=structuredClone(f.store.data.orders);
  let gateValidations=0,bybitValidations=0;
  f.adapters.get('gate')!.validateOrder=async request=>{d.checked.push(structuredClone(request));if(++gateValidations>1){
    f.books.get('gate')!.bids[0].price=1.02-.001*gateValidations;f.refresh();}};
  f.adapters.get('bybit')!.validateOrder=async request=>{d.checked.push(structuredClone(request));bybitValidations++;};
  await f.start();assert.equal(gateValidations,3);assert.equal(bybitValidations,3);assert.equal(d.recovered(),0);
  assert.equal(f.reads.length,4);assert.equal(f.posts.length,0);assert.deepEqual(f.store.data.orders,original);
  assert.equal(f.store.data.killSwitch,false);assert.ok(f.execution.iocProfitCloseRetryAfter(f.p)>Date.now());
});

test('a replacement native validation rejection preserves its venue and creates no intent',async t=>{
  const f=fixture('CVC');t.after(()=>f.close());freshDrift(f,'capacity');let validations=0;
  f.adapters.get('bybit')!.validateOrder=async()=>{if(++validations>1)throw new ExchangeNetworkError('TIMEOUT',0,undefined,'bybit');};
  await f.start();assert.equal(validations,2);assert.equal(f.posts.length,0);assert.equal(f.store.data.orders.length,2);
  assert.match(f.logs.at(-1)!,/Bybit.*请求超时/);assert.equal(f.store.data.killSwitch,false);
});

test('replacement validation cannot renew the original native clock past eight seconds',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,9,12)});const f=fixture('CVC');t.after(()=>f.close());freshDrift(f,'price');
  let validations=0;f.adapters.get('gate')!.validateOrder=async()=>{if(++validations===2){t.mock.timers.setTime(Date.now()+8001);f.refresh();}};
  await f.start();assert.equal(validations,2);assert.equal(f.reads.length,4);assert.equal(f.posts.length,0);assert.equal(f.store.data.orders.length,2);
  assert.equal(f.store.data.killSwitch,false);
});

for(const change of ['permission','config','inplace-config','cash','quantity','unknown','symbol','contract-size','compatible-step','fee-expiry','fee-increase','profit'] as const)
test(`a ${change} change during exact replacement validation cannot authorize a new IOC intent`,async t=>{
  const f=fixture('CVC');t.after(()=>f.close());freshDrift(f,'price');let validations=0;
  f.adapters.get('gate')!.validateOrder=async()=>{if(++validations!==2)return;
    const quote=f.books.get('gate')!;
    if(change==='permission')f.revoke();if(change==='config')f.changeConfig();
    if(change==='inplace-config')f.store.data.config.minExitProfitBps=11;
    if(change==='cash')f.p.fundingUsd+=.1;if(change==='quantity')f.p.long.quantity=9;
    if(change==='unknown'){const request={...f.store.data.orders[0].request,clientOrderId:'external-unknown',side:'sell' as const,reduceOnly:true};
      f.store.data.orders.push({positionId:f.p.id,exchange:'gate',createdAt:Date.now(),request,result:unknownOrder(request)});}
    if(change==='symbol')quote.symbol='OTHER/USDT:USDT';if(change==='contract-size')quote.contractSize=2;
    if(change==='compatible-step')quote.quantityStep=.5;if(change==='fee-expiry')quote.takerFeeAt=Date.now()-120001;
    if(change==='fee-increase')quote.takerFeeRate=.05;if(change==='profit')quote.bids[0].price=1;
  };
  await f.start();assert.equal(validations,2);assert.equal(f.posts.length,0);
  assert.equal(f.store.data.orders.length,change==='unknown'?3:2);assert.equal(f.p.closeRequestedAt,undefined);
  assert.equal(f.store.data.killSwitch,false);
});

test('a persisted replacement intent stays frozen when the final native callback vetoes later book movement',async t=>{
  const f=fixture('CVC');t.after(()=>f.close());freshDrift(f,'price');const save=f.store.save;let savedRequests:OrderRequest[]|undefined;
  f.store.save=()=>{save();const newOrders=f.store.data.orders.filter(order=>order.executionEvidence?.method==='ioc'&&order.request.reduceOnly);
    if(!savedRequests&&newOrders.length){savedRequests=newOrders.map(order=>structuredClone(order.request));f.books.get('gate')!.bids[0].price=1.018;f.revoke();}};
  for(const adapter of f.adapters.values())adapter.placeOrder=async(request,permit)=>{
    assert.equal(permit?.(),false);return {id:'',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,
      timestamp:Date.now(),rejectionCode:'ORDER_SUBMISSION_PERMISSION_CHANGED'};};
  await f.start();assert.ok(savedRequests);assert.equal(savedRequests[0].limitPrice,1.019);
  assert.deepEqual(f.store.data.orders.slice(2).map(order=>order.request),savedRequests);assert.equal(f.posts.length,0);
  assert.equal(f.p.long.quantity,10);assert.equal(f.p.short.quantity,10);assert.equal(f.store.data.killSwitch,false);
});

test('confirmed IOC tail replanning remains within its original planned chunk and confirmed quantity budget',async t=>{
  const f=fixture('CVC');t.after(()=>f.close());const checked:OrderRequest[]=[],account=f.adapters.get('bybit')!.fetchAccount!;
  let bybitPosts=0,accounts=0;
  for(const adapter of f.adapters.values())adapter.validateOrder=async request=>{checked.push(structuredClone(request));};
  f.adapters.get('bybit')!.placeOrder=async(request,permit)=>{assert.equal(permit?.(),true);f.posts.push({exchange:'bybit',request:structuredClone(request)});
    if(++bybitPosts===1){f.books.get('bybit')!.asks[0].quantity=2;return f.result(request,6);}return f.result(request);};
  f.adapters.get('bybit')!.fetchAccount=async()=>{const value=await account();if(++accounts===2){
    f.books.get('bybit')!.asks[0]={price:1.011,quantity:100};f.refresh();}return value;};
  await f.start();assert.equal(f.p.status,'closed');assert.deepEqual(f.posts.slice(2).map(post=>post.request.quantity),[2,2]);
  assert.equal(f.posts.slice(2).every(post=>post.exchange==='bybit'),true);
  assert.equal(f.posts.slice(2).reduce((sum,post)=>sum+post.request.quantity,0),4);
  for(const post of f.posts)assert.ok(checked.some(request=>JSON.stringify(request)===JSON.stringify(post.request)));
  assert.equal(f.store.data.orders.slice(2,4).every(order=>order.request.quantity===10),true);
  assert.equal(f.p.feesUsd,.002+f.store.data.orders.slice(2).reduce((sum,order)=>sum+order.result!.feeUsd,0));
  assert.equal(f.store.data.killSwitch,false);
});

for(const change of ['permission','config','cash','quantity'] as const)
test(`the post-native public refresh cannot authorize an IOC after ${change} changes`,async t=>{
  const f=fixture();t.after(()=>f.close());let refreshed=0;expireBooksAfterAccount(f);
  f.execution.context.refreshReductionSnapshots=async()=>{
    refreshed++;f.refresh();
    if(change==='permission')f.revoke();if(change==='config')f.changeConfig();
    if(change==='cash')f.p.fundingUsd+=.1;if(change==='quantity')f.p.long.quantity=9;
  };
  await f.start();assert.equal(refreshed,1);assert.equal(f.posts.length,0);assert.equal(f.store.data.orders.length,2);
  assert.equal(f.p.closeRequestedAt,undefined);assert.equal(f.store.data.killSwitch,false);
});

test('the post-native public refresh does not extend the original eight-second account proof',async t=>{
  const originalNow=Date.now;let now=originalNow();Date.now=()=>now;t.after(()=>{Date.now=originalNow;});
  const f=fixture();t.after(()=>f.close());let refreshed=0;
  const account=f.adapters.get('gate')!.fetchAccount!;f.adapters.get('gate')!.fetchAccount=async()=>{const result=await account();now+=7000;for(const book of f.books.values())book.timestamp=book.observedAt=now-120000;return result;};
  f.execution.context.refreshReductionSnapshots=async()=>{refreshed++;now+=1500;f.refresh();};
  await f.start();assert.equal(refreshed,1);assert.equal(f.posts.length,0);assert.equal(f.store.data.orders.length,2);
  assert.equal(f.p.closeRequestedAt,undefined);assert.equal(f.store.data.killSwitch,false);
});

test('a failing selected public refresh waits locally without private fee renewal or new intent',async t=>{
  const f=fixture();t.after(()=>f.close());const feeTimes=[...f.books.values()].map(book=>book.takerFeeAt);expireBooksAfterAccount(f);
  f.execution.context.refreshReductionSnapshots=async()=>{throw new ExchangeNetworkError('TIMEOUT',0,undefined,'bybit');};
  await f.start();assert.equal(f.posts.length,0);assert.equal(f.store.data.orders.length,2);assert.equal(f.store.data.killSwitch,false);
  assert.deepEqual([...f.books.values()].map(book=>book.takerFeeAt),feeTimes);assert.match(f.logs.at(-1)!,/Bybit/);assert.doesNotMatch(f.logs.at(-1)!,/Gate/);
});

test('short-side native validation errors keep their actual venue and await the other read before retry',async t=>{
  const f=fixture();t.after(()=>f.close());let release:()=>void=()=>{},entered=false;
  const pending=new Promise<void>(resolve=>{release=resolve;});
  f.adapters.get('gate')!.validateOrder=async()=>{entered=true;await pending;};
  f.adapters.get('bybit')!.validateOrder=async()=>{throw new ExchangeNetworkError('TIMEOUT',0,undefined,'bybit');};
  assert.equal(f.execution.dispatchIocProfitClose(f.p,'offline IOC',()=>true),true);
  for(let i=0;!entered&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,1));
  assert.equal(entered,true);await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(f.execution.hasIocProfitClose(f.p),true);assert.equal(f.logs.length,0);release();await f.execution.waitIocProfitClose(f.p);
  assert.equal(f.posts.length,0);assert.equal(f.store.data.killSwitch,false);assert.match(f.logs.at(-1)!,/Bybit 原生参数核验|Bybit 合约检查/);assert.doesNotMatch(f.logs.at(-1)!,/Gate/);
});

test('already safe short-side execution diagnostics are not relabelled or wrapped as Gate',async t=>{
  const f=fixture();t.after(()=>f.close());
  f.execution.context.refreshSnapshots=async()=>{throw tradingError('bybit','账户检查',new ExchangeNetworkError('TIMEOUT',0,undefined,'bybit'));};
  await f.start();assert.match(f.logs.at(-1)!,/Bybit 账户检查未通过/);assert.doesNotMatch(f.logs.at(-1)!,/Gate|未能确认执行条件/);
  assert.equal(f.posts.length,0);assert.equal(f.store.data.killSwitch,false);
});

test('alternating IOC preflight diagnostics are throttled independently and the first recovery stays visible',async t=>{
  const f=fixture();t.after(()=>f.close());const execution=f.execution as any,originalNow=Date.now;let now=originalNow();Date.now=()=>now;t.after(()=>{Date.now=originalNow;});
  const first=tradingError('gate','合约检查',new ExchangeNetworkError('TIMEOUT',0,undefined,'gate'));
  const second=tradingError('bybit','合约检查',new ExchangeNetworkError('DNS_ERROR',0,undefined,'bybit'));
  for(const error of [first,second,first,second]){await execution.waitIocPreflight(f.p,'native-validation',error);now+=1000;}
  assert.equal(f.logs.length,2);assert.match(f.p.riskReasons[0],/Bybit/);assert.ok(f.execution.iocProfitCloseRetryAfter(f.p)>now);
  now+=12000;await execution.waitIocPreflight(f.p,'native-validation',first);assert.equal(f.logs.length,3);
  now+=2000;f.refresh();await f.start();assert.equal(f.p.status,'closed');assert.equal(f.posts.length,2);
  assert.equal(f.logs.filter(line=>line.includes('准备核验已恢复')).length,1);
});

test('a local Gate exact-position ambiguity has a fixed quantity/identity explanation without private payloads',async t=>{
  const f=fixture();t.after(()=>f.close());
  f.adapters.get('gate')!.validateOrder=async()=>{throw new Error('gate: exact position for quantitative close is unavailable or ambiguous');};
  await f.start();assert.equal(f.posts.length,0);assert.equal(f.store.data.killSwitch,false);
  assert.match(f.logs.at(-1)!,/Gate 未找到可唯一确认的仓位，不能执行定量平仓/);assert.doesNotMatch(f.logs.at(-1)!,/未能确认执行条件|unavailable or ambiguous/);
  const unknown=tradingError('gate','合约检查',new Error('gate: exact position for quantitative close is unavailable or ambiguous secret-canary'));
  assert.match(unknown.message,/未能确认执行条件/);assert.doesNotMatch(unknown.message,/secret-canary/);
});

test('an actual preflight wait-state persistence failure stops all trading instead of being log-throttled',async t=>{
  const f=fixture();t.after(()=>f.close());f.failNextSave();expireBooksAfterAccount(f);
  f.execution.context.refreshReductionSnapshots=async()=>{throw new ExchangeNetworkError('TIMEOUT',0,undefined,'bybit');};
  await f.start();assert.equal(f.store.data.killSwitch,true);assert.equal(f.p.status,'attention');assert.equal(f.posts.length,0);
});

test('fresh matching books after native reads need no extra public recovery request',async t=>{
  const f=fixture();t.after(()=>f.close());let recovered=0;
  f.execution.context.refreshReductionSnapshots=async()=>{recovered++;throw new Error('unnecessary refresh');};
  await f.start();assert.equal(recovered,0);assert.equal(f.posts.length,2);assert.equal(f.p.status,'closed');assert.equal(f.store.data.killSwitch,false);
});

test('reading a stale public cache cannot renew a prepared IOC quote',async t=>{
  const f=fixture();t.after(()=>f.close());expireBooksAfterAccount(f);let recovered=0;
  f.execution.context.refreshReductionSnapshots=async()=>{recovered++;};
  await f.start();assert.equal(recovered,1);assert.equal(f.posts.length,0);assert.equal(f.store.data.orders.length,2);
  assert.match(f.logs.at(-1)!,/盘口已过期/);assert.equal(f.store.data.killSwitch,false);
});

test('without a selected public recovery hook the original stale IOC batch still waits',async t=>{
  const f=fixture();t.after(()=>f.close());expireBooksAfterAccount(f);
  await f.start();assert.equal(f.posts.length,0);assert.equal(f.store.data.orders.length,2);assert.equal(f.p.closeRequestedAt,undefined);
  assert.match(f.logs.at(-1)!,/盘口已过期/);assert.equal(f.store.data.killSwitch,false);
});

test('a short-side account read failure is reported as that venue before any IOC intent',async t=>{
  const f=fixture();t.after(()=>f.close());
  f.adapters.get('bybit')!.fetchAccount=async()=>{throw new ExchangeNetworkError('DNS_ERROR',0,undefined,'bybit');};
  await f.start();assert.equal(f.posts.length,0);assert.equal(f.store.data.orders.length,2);
  assert.match(f.logs.at(-1)!,/Bybit 账户检查.*解析失败/);assert.doesNotMatch(f.logs.at(-1)!,/Gate/);assert.equal(f.store.data.killSwitch,false);
});

test('a network connect syscall in the native proof is a local wait and private payloads remain hidden',async t=>{
  const f=fixture();t.after(()=>f.close());
  f.adapters.get('bybit')!.fetchAccount=async()=>{throw Object.assign(new Error('private-canary'),{syscall:'connect',code:'ETIMEDOUT'});};
  await f.start();assert.equal(f.posts.length,0);assert.equal(f.store.data.killSwitch,false);
  assert.match(f.logs.at(-1)!,/Bybit/);assert.doesNotMatch(f.logs.join('\n'),/private-canary/);
});

test('a concurrent filesystem validation fault takes priority over an ordinary read failure',async t=>{
  const f=fixture();t.after(()=>f.close());
  f.adapters.get('gate')!.validateOrder=async()=>{throw new ExchangeNetworkError('TIMEOUT',0,undefined,'gate');};
  f.adapters.get('bybit')!.validateOrder=async()=>{throw Object.assign(new Error('offline disk failure'),{syscall:'write',code:'EIO'});};
  await f.start();assert.equal(f.posts.length,0);assert.equal(f.store.data.killSwitch,true);assert.equal(f.p.status,'attention');
});

test('IOC diagnostic throttling keeps each position and each new close scope independent',async t=>{
  const f=fixture();t.after(()=>f.close());const execution=f.execution as any,error=tradingError('bybit','账户检查',new ExchangeNetworkError('TIMEOUT',0,undefined,'bybit'));
  const second=structuredClone(f.p);second.id='offline-distinct-position';f.store.data.positions.push(second);
  await execution.waitIocPreflight(f.p,'native-proof',error);await execution.waitIocPreflight(second,'native-proof',error);
  await execution.waitIocPreflight(f.p,'native-proof',error);assert.equal(f.logs.length,2);
  f.p.closeRequestedAt=Date.now();await execution.waitIocPreflight(f.p,'native-proof',error);assert.equal(f.logs.length,3);
});

test('a real diagnostic persistence failure is not swallowed by IOC log throttling',async t=>{
  const f=fixture();t.after(()=>f.close());f.store.log=()=>{throw new Error('offline diagnostic persistence failed');};
  f.adapters.get('gate')!.validateOrder=async()=>{throw new ExchangeNetworkError('TIMEOUT',0,undefined,'gate');};
  await f.start();assert.equal(f.posts.length,0);assert.equal(f.store.data.killSwitch,true);assert.equal(f.p.status,'attention');
});

test('an unclassified public read error does not invent a failing Gate venue or expose its payload',async t=>{
  const f=fixture();t.after(()=>f.close());f.execution.context.refreshSnapshots=async()=>{throw new Error('private-canary');};
  await f.start();assert.equal(f.posts.length,0);assert.equal(f.store.data.killSwitch,false);
  assert.match(f.logs.at(-1)!,/所选交易所/);assert.doesNotMatch(f.logs.at(-1)!,/Gate|private-canary/);
});

test('cash-queue delay cannot renew the original IOC native proof or create stale intents',async t=>{
  const originalNow=Date.now;let now=originalNow();Date.now=()=>now;t.after(()=>{Date.now=originalNow;});
  const f=fixture();t.after(()=>f.close());let queued=0;
  f.execution.context.serialize=async fn=>{queued++;if(queued===1){now+=9000;f.refresh();}return f.serial(fn);};
  await f.start();assert.equal(f.posts.length,0);assert.equal(f.store.data.orders.length,2);assert.equal(f.p.closeRequestedAt,undefined);
  assert.equal(f.store.data.killSwitch,false);
});

