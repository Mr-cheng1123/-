import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {Engine} from '../src/core/engine.js';
import type {Store} from '../src/core/store.js';
import {defaultConfig} from '../src/shared/config.js';
import {assessBestOppositeProfitExit,alignedExitProfitsPass} from '../src/core/profit-exit.js';
import type {AccountState,AppConfig,ExchangeAdapter,ExchangeId,MakerReductionObservation,MarketSnapshot,OrderRequest,OrderResult,Position} from '../src/shared/types.js';

const START=Date.UTC(2026,9,3,9,6,37);

/** Every account, quote, native validation and fill is memory-only. The real Engine and Execution are exercised. */
function fixture(options:{longExchange?:'gate'|'bitget';base?:string;topQuantity?:number;earnedFundingUsd?:number}={}){
  const now=Date.now(),longExchange=options.longExchange??'gate',shortExchange='bybit' as const,base=options.base??'TESTFUND';
  const config:AppConfig={...structuredClone(defaultConfig),mode:'live',dataSource:'public',entryPolicy:'aligned',
    exchanges:[longExchange,shortExchange],symbols:[base],holdMode:'adaptive',maxOrderRetries:1};
  const store={data:{version:1,config,positions:[],orders:[],logs:[],equity:[],killSwitch:false,fundingSeen:[]},
    save(){},log(){}} as unknown as Store;
  const symbol=`${base}/USDT:USDT`,nextFundingTime=now+3_600_000;
  const quotes=new Map<ExchangeId,MarketSnapshot>();
  for(const exchange of config.exchanges)quotes.set(exchange,{exchange,base,symbol,source:'public',timestamp:now,observedAt:now,
    bookTransport:'websocket',fundingObservedAt:now,markPrice:1,indexPrice:1,fundingRate:exchange===shortExchange?-.001:0,
    intervalHours:8,nextFundingTime,fundingHistory:[],bids:[{price:exchange===longExchange?1:.998,quantity:options.topQuantity??100}],
    asks:[{price:exchange===shortExchange?1:1.002,quantity:options.topQuantity??100}],
    quantityStep:1,minQuantity:1,minNotional:5,contractSize:1,openInterestUsd:1_000_000,volume24hUsd:1_000_000,
    takerFeeRate:exchange===shortExchange?.00055:.0005,takerFeeAt:now,takerFeeSource:'exchange',
    makerFeeRate:.0002,makerFeeAt:now,makerFeeSource:'exchange'});
  const requests:Array<{exchange:ExchangeId;request:OrderRequest}>=[];
  const feeRequests:Array<{exchange:ExchangeId;symbol:string}>=[];
  const makers=new Map<string,{exchange:ExchangeId;request:OrderRequest;id:string;filled:number;cancelled:boolean}>();
  const nativeAccounts=new Map<ExchangeId,AccountState>();
  for(const exchange of config.exchanges)nativeAccounts.set(exchange,{freeUsd:1000,equityUsd:1000,positions:[{
    base,symbol,side:exchange===longExchange?'long':'short',quantity:100,markPrice:1,entryPrice:1,
    liquidationPrice:exchange===longExchange?.5:1.5,leverage:2}]});
  let afterValidate:(exchange:ExchangeId,request:OrderRequest)=>Promise<void>|void=()=>{};
  let afterFill:(exchange:ExchangeId,request:OrderRequest,result:OrderResult)=>void=()=>{};
  let fillQuantity:(exchange:ExchangeId,request:OrderRequest)=>number=(_exchange,request)=>request.quantity;
  const adapters=config.exchanges.map(exchange=>({id:exchange,supportsMakerReduction:()=>true,fetchSnapshots:async()=>[quotes.get(exchange)!],
    fetchExecutionSnapshots:async()=>[quotes.get(exchange)!],getExecutionSnapshot:()=>quotes.get(exchange),
    fetchAccount:async()=>nativeAccounts.get(exchange)!,fetchFundingPayments:async()=>[],inspectTrading:async()=>{},
    fetchTradingFee:async(symbol:string)=>{feeRequests.push({exchange,symbol});return undefined;},
    prepareTrading:async()=>{},validateOrder:async(request:OrderRequest)=>{
      assert.equal(request.reduceOnly,true);assert.notEqual(request.postOnly,true);await afterValidate(exchange,request);
    },
    validateMakerReduction:async(request:OrderRequest)=>{
      assert.equal(request.reduceOnly,true);assert.equal(request.postOnly,true);await afterValidate(exchange,request);
    },
    submitMakerReduction:async(request:OrderRequest,canSubmit?:()=>boolean):Promise<OrderResult>=>{
      assert.equal(request.reduceOnly,true);assert.equal(request.postOnly,true);
      assert.equal(quotes.get(exchange)!.makerFeeSource,'exchange');
      if(canSubmit&&!canSubmit())return {id:'',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,
        averagePrice:0,feeUsd:0,rejectionCode:'MAKER_REDUCTION_PERMISSION_CHANGED',rejectionReason:'Memory final submission guard veto',timestamp:Date.now()};
      requests.push({exchange,request:{...request}});const id=`MEMORY-MAKER-${requests.length}`;
      makers.set(request.clientOrderId,{exchange,request:{...request},id,filled:0,cancelled:false});
      return {id,clientOrderId:request.clientOrderId,status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:NaN,timestamp:Date.now()};
    },
    inspectMakerReduction:async(request:OrderRequest,orderId?:string):Promise<MakerReductionObservation>=>{
      const maker=makers.get(request.clientOrderId);assert.ok(maker);assert.equal(maker.exchange,exchange);assert.equal(orderId,maker.id);
      const quantity=maker.cancelled?maker.filled:fillQuantity(exchange,request);
      if(quantity>maker.filled){nativeAccounts.get(exchange)!.positions[0].quantity-=quantity-maker.filled;maker.filled=quantity;}
      const result:OrderResult={id:maker.id,clientOrderId:request.clientOrderId,
        status:quantity===request.quantity?'filled':quantity?'partial':'cancelled',filledQuantity:quantity,
        averagePrice:quantity?request.limitPrice:0,averagePriceVerified:true,
        feeUsd:quantity*request.limitPrice*quotes.get(exchange)!.makerFeeRate!,timestamp:Date.now()};
      afterFill(exchange,request,result);
      return {activity:'terminal',executionVerified:true,observedAt:Date.now(),result};
    },
    cancelMakerReduction:async(request:OrderRequest,orderId:string)=>{
      const maker=makers.get(request.clientOrderId);assert.ok(maker);assert.equal(orderId,maker.id);maker.cancelled=true;
    },
    placeOrder:async(request:OrderRequest):Promise<OrderResult>=>{
      assert.equal(request.reduceOnly,true,'These exit tests cannot create opening orders');
      assert.notEqual(request.postOnly,true,'Maker reductions must use the dedicated native interface');
      requests.push({exchange,request});
      const filledQuantity=fillQuantity(exchange,request),feeRate=quotes.get(exchange)!.takerFeeRate!;
      const result:OrderResult={id:`MEMORY-${requests.length}`,clientOrderId:request.clientOrderId,
        status:filledQuantity===request.quantity?'filled':filledQuantity>0?'partial':'cancelled',filledQuantity,
        averagePrice:filledQuantity?request.limitPrice:0,feeUsd:filledQuantity*request.limitPrice*feeRate,timestamp:Date.now()};
      const row=nativeAccounts.get(exchange)!.positions[0];if(row)row.quantity-=filledQuantity;
      afterFill(exchange,request,result);return result;
    },reconcileOrder:async()=>{throw new Error('Unexpected native reconciliation');},
    cancelOrder:async()=>{throw new Error('Unexpected native cancellation');},close:async()=>{}} as ExchangeAdapter));
  const createEngine=()=>new Engine(store,true,{adapterFactory:()=>adapters,liveEnvironment:{ALLOW_LIVE_TRADING:'true',
    LIVE_TRADING_ACK:'I_UNDERSTAND_THE_RISKS',GATE_API_KEY:'MEMORY',GATE_API_SECRET:'MEMORY',
    BITGET_API_KEY:'MEMORY',BITGET_API_SECRET:'MEMORY',BITGET_PASSPHRASE:'MEMORY',
    BYBIT_API_KEY:'MEMORY',BYBIT_API_SECRET:'MEMORY'}});
  const engine=createEngine();
  assert.equal(engine.liveUnlocked,true,'The memory fixture must be execution-enabled so the guard, not account locking, prevents exits');
  engine.health.forEach(health=>{health.status='online';health.lastSuccess=now;});
  for(const [exchange,account] of nativeAccounts)engine.accounts.set(exchange,account);
  const p:Position={id:'funding-exit-memory',base,mode:'live',entryPolicy:'aligned',holdMode:'adaptive',status:'open',
    openedAt:now-1000,plannedExitAt:nextFundingTime+config.exitDelaySec*1000,
    long:{exchange:longExchange,symbol,side:'long',quantity:100,entryPrice:1,markPrice:1,feesUsd:.05,liquidationDistancePct:50},
    short:{exchange:shortExchange,symbol,side:'short',quantity:100,entryPrice:1,markPrice:1,feesUsd:.05,liquidationDistancePct:50},
    fundingUsd:options.earnedFundingUsd??0,feesUsd:.1,transferCostUsd:0,realizedSpreadPnlUsd:0,spreadPnlUsd:0,netPnlUsd:(options.earnedFundingUsd??0)-.1,deltaUsd:0,
    fundingEvents:['MEMORY-CONFIRMED-CASH'],riskReasons:[],profitExitPolicy:{firstFundingTime:nextFundingTime,
      earliestExitAt:nextFundingTime+config.exitDelaySec*1000,minSpreadNetUsd:0,minCombinedNetUsd:.05,
      fundingChecks:config.exchanges.map(exchange=>({exchange,timestamp:nextFundingTime}))}};
  // Constructor restoration must not accidentally authorize existing positions; add only after the memory session is constructed.
  store.data.positions.push(p);engine.snapshots=[...quotes.values()];
  const publish=(changes:{fundingAt?:number;longRate?:number;shortRate?:number;longNext?:number;shortNext?:number;
    longInterval?:number;shortInterval?:number}={})=>{
    for(const [exchange,old] of quotes){const isLong=exchange===longExchange;
      quotes.set(exchange,{...old,timestamp:Date.now(),observedAt:Date.now(),takerFeeAt:Date.now(),makerFeeAt:Date.now(),
        fundingObservedAt:changes.fundingAt??Date.now(),fundingRate:(isLong?changes.longRate:changes.shortRate)??old.fundingRate,
        nextFundingTime:(isLong?changes.longNext:changes.shortNext)??old.nextFundingTime,
        intervalHours:(isLong?changes.longInterval:changes.shortInterval)??old.intervalHours});}
    engine.snapshots=[...quotes.values()];
  };
  const readAccounts=(target=engine)=>{
    for(const [exchange,account] of nativeAccounts){target.accounts.set(exchange,account);
      const health=target.health.find(row=>row.exchange===exchange)!;
      health.status='online';health.lastSuccess=Date.now();health.accountStatus='ready';health.accountUpdatedAt=Date.now();}
  };
  return {engine,store,p,quotes,requests,feeRequests,publish,longExchange,shortExchange,readAccounts,createEngine,
    setValidate(fn:typeof afterValidate){afterValidate=fn;},setAfterFill(fn:typeof afterFill){afterFill=fn;},
    setFillQuantity(fn:typeof fillQuantity){fillQuantity=fn;},
    manage:async()=>{
      await (engine as unknown as {managePositions(now:number):Promise<void>}).managePositions(Date.now());
      await engine.execution.waitMakerClose(p);
    }};
}

function mockDate(t:TestContext,at=START){t.mock.timers.enable({apis:['Date'],now:at});}
async function observeFour(t:TestContext,f:ReturnType<typeof fixture>){
  for(const elapsed of [0,45_000,90_000,135_000]){
    t.mock.timers.setTime(START+elapsed);f.publish();await f.manage();
    assert.equal(f.p.status,'open');assert.equal(f.requests.length,0);
  }
}
async function observeStableWithoutTrading(t:TestContext,f:ReturnType<typeof fixture>){
  f.p.status='attention';
  for(const elapsed of [0,45_000,90_000,135_000,180_000]){
    t.mock.timers.setTime(START+elapsed);f.publish();await f.manage();assert.equal(f.requests.length,0);
  }
  assert.equal(f.p.holdDecision?.fundingExitStability?.status,'confirmed');
}
function continueProfitDepth(f:ReturnType<typeof fixture>){
  return (f.engine as unknown as {continueClosing(p:Position,reason:string,options:{pricing:'depth';requireProfit:true}):Promise<unknown>})
    .continueClosing(f.p,'历史深度自动退出',{pricing:'depth',requireProfit:true});
}
function prepareLosingExit(f:ReturnType<typeof fixture>,paymentAt=START+240_000){
  f.p.fundingUsd=0;
  f.p.profitExitPolicy!.fundingChecks=f.store.data.config.exchanges.map(exchange=>({exchange,timestamp:paymentAt}));
  f.publish({longNext:paymentAt,shortNext:paymentAt,longRate:0,shortRate:-.01});
}

test('Engine never treats advancing WebSocket books as independent funding observations',async t=>{
  mockDate(t);const f=fixture();
  for(let seconds=0;seconds<=24;seconds+=2){
    t.mock.timers.setTime(START+seconds*1000);f.publish({fundingAt:START});await f.manage();
  }
  assert.equal(f.p.holdDecision?.fundingExitStability?.sampleCount,1);
  assert.equal(f.p.holdDecision?.fundingExitStability?.observedSpanMs,0);
  assert.equal(f.p.holdDecision?.action,'wait');assert.equal(f.p.status,'open');
  assert.equal(f.requests.length,0);assert.equal(f.store.data.orders.length,0);assert.equal(f.p.closeRequestedAt,undefined);
});

test('Engine realizes a controlled funding-loss exit only after five independent observations span three minutes',async t=>{
  mockDate(t);const f=fixture();prepareLosingExit(f);await observeFour(t,f);
  t.mock.timers.setTime(START+180_000);f.publish();await f.manage();
  assert.equal(f.p.holdDecision?.fundingExitStability?.status,'confirmed');
  assert.equal(f.p.holdDecision?.fundingExitStability?.sampleCount,5);
  assert.equal(f.p.holdDecision?.fundingExitStability?.observedSpanMs,180_000);
  assert.equal(f.p.status,'closed');assert.equal(f.p.long.quantity,0);assert.equal(f.p.short.quantity,0);
  assert.equal(f.requests.length,2);assert.equal(f.store.data.orders.length,2);
  assert.ok(f.requests.every(({request})=>request.quantity===100&&request.limitPrice===1&&request.reduceOnly&&request.postOnly!==true));
  assert.ok(f.store.data.orders.every(order=>order.executionEvidence?.method==='ioc'),'Funding-loss exits retain the original IOC path');
  assert.equal(f.p.holdDecision?.exitSignal,'funding-loss');
  assert.ok(Math.abs(f.p.netPnlUsd+.205)<1e-12,'Paid entry and actual exit fees are realized without inventing future funding');
});

test('a positive funding read immediately clears Engine exit evidence and requires a new negative window',async t=>{
  mockDate(t);const f=fixture();await observeFour(t,f);
  t.mock.timers.setTime(START+180_000);f.publish({shortRate:.001});await f.manage();
  assert.equal(f.p.holdDecision?.fundingExitStability?.status,'positive');
  assert.equal(f.p.holdDecision?.fundingExitStability?.sampleCount,0);assert.equal(f.p.holdDecision?.action,'hold');
  assert.equal(f.requests.length,0);assert.equal(f.p.status,'open');
  t.mock.timers.setTime(START+195_000);f.publish({shortRate:-.001});await f.manage();
  assert.equal(f.p.holdDecision?.fundingExitStability?.sampleCount,1);
  assert.equal(f.p.holdDecision?.fundingExitStability?.observedSpanMs,0);assert.equal(f.requests.length,0);
});

test('MANA repeated-hour payment projection cannot eject the hedge ten minutes later when actual payment remains distant',async t=>{
  mockDate(t);const f=fixture({base:'MANA',longExchange:'bitget'});
  const longNext=Date.UTC(2026,9,3,16),shortNext=Date.UTC(2026,9,3,10);
  f.p.profitExitPolicy!.fundingChecks=[{exchange:'bitget',timestamp:longNext},{exchange:'bybit',timestamp:shortNext}];
  for(let elapsed=0;elapsed<=600_000;elapsed+=30_000){
    t.mock.timers.setTime(START+elapsed);f.publish({longRate:-.0036,shortRate:-.000575,
      longNext,shortNext,longInterval:8,shortInterval:1});await f.manage();
  }
  const evidence=f.p.holdDecision!.fundingExitStability!;
  assert.equal(evidence.status,'projection-wait');assert.equal(evidence.observedSpanMs,600_000);
  assert.ok(evidence.latestBps!< -2);assert.ok(evidence.observedNextNetUsd!>0);assert.ok(evidence.projectedNetUsd!<0);
  assert.equal(evidence.nextPaymentAt,shortNext);assert.equal(f.p.holdDecision?.action,'hold');
  assert.equal(f.p.status,'open');assert.equal(f.requests.length,0);assert.equal(f.p.closeRequestedAt,undefined);
});

test('a positive funding update during awaited native validation cancels both new common losing reductions',async t=>{
  mockDate(t);const f=fixture();prepareLosingExit(f);await observeFour(t,f);
  let validations=0;
  f.setValidate(async()=>{await Promise.resolve();if(++validations===1){
    t.mock.timers.setTime(Date.now()+1);f.publish({shortRate:.001});
  }});
  t.mock.timers.setTime(START+180_000);f.publish();await f.manage();
  assert.equal(validations,2,'Both native preparations occurred before the final economic guard');
  assert.equal(f.p.holdDecision?.fundingExitStability?.status,'positive');
  assert.equal(f.p.holdDecision?.action,'hold');assert.match(f.p.holdDecision!.reason,/仍为正/);
  assert.equal(f.p.status,'open');assert.equal(f.requests.length,0);assert.equal(f.store.data.orders.length,0);
  assert.equal(f.p.closeRequestedAt,undefined);assert.equal(f.p.closeProfitRequired,undefined);
});

test('stable weak negative funding cannot waive the independently verified exit cost allowance',async t=>{
  mockDate(t);const f=fixture();f.p.fundingUsd=.05;await observeFour(t,f);
  t.mock.timers.setTime(START+180_000);f.publish();await f.manage();
  assert.equal(f.p.holdDecision?.fundingExitStability?.status,'confirmed');
  assert.equal(f.p.holdDecision?.action,'wait');assert.ok(f.p.holdDecision!.exitProfit!.netPnlUsd<0);
  assert.equal(f.p.status,'open');assert.equal(f.requests.length,0);assert.equal(f.p.closeRequestedAt,undefined);
});

test('a native fee update during awaited validation cancels a once-profitable automatic close',async t=>{
  mockDate(t);const f=fixture({earnedFundingUsd:.5});
  let validations=0;const validated:Array<{exchange:ExchangeId;postOnly:boolean}>=[];
  f.setValidate(async(exchange,request)=>{validated.push({exchange,postOnly:request.postOnly===true});await Promise.resolve();if(++validations===1){
    for(const quote of f.quotes.values())quote.takerFeeRate=.003;
  }});
  f.publish();await f.manage();
  assert.equal(validations,2);
  assert.deepEqual(validated,[{exchange:'bybit',postOnly:true},{exchange:'gate',postOnly:false}],
    'The profitable close validates the wider Bybit Maker and its Gate IOC peer before the updated fees veto submission');
  assert.equal(f.p.holdDecision?.action,'wait');assert.ok([...f.quotes.values()].every(quote=>quote.takerFeeRate===.003));
  assert.equal(f.p.holdDecision?.exitSignal,undefined);assert.equal(f.p.holdDecision?.fundingExitStability?.sampleCount,1);
  assert.equal(f.p.status,'open');assert.equal(f.requests.length,0);assert.equal(f.store.data.orders.length,0);
  assert.equal(f.p.closeRequestedAt,undefined);
});

test('confirmed losing one-leg reductions are compensated after positive funding returns while further shared batches stop',async t=>{
  mockDate(t);const f=fixture({topQuantity:40});prepareLosingExit(f);await observeFour(t,f);
  let shortCalls=0;
  f.setFillQuantity((exchange,request)=>exchange==='bybit'&&++shortCalls===1?10:request.quantity);
  f.setAfterFill(()=>{if(f.requests.length===2){t.mock.timers.setTime(Date.now()+1);f.publish({shortRate:.001});}});
  t.mock.timers.setTime(START+180_000);f.publish();await f.manage();
  assert.deepEqual(f.requests.map(({exchange,request})=>[exchange,request.quantity]),[['gate',40],['bybit',40],['bybit',30]]);
  assert.equal(f.p.long.quantity,60);assert.equal(f.p.short.quantity,60);assert.equal(f.p.status,'attention');
  assert.equal(f.p.holdDecision?.fundingExitStability?.status,'positive');assert.equal(f.p.closeProfitRequired,true);
  t.mock.timers.setTime(START+190_000);f.readAccounts();f.publish({shortRate:.001});await f.manage();
  assert.equal(f.requests.length,3,'A persisted losing close intent cannot bypass newly positive funding for another shared batch');
  assert.equal(f.p.long.quantity,60);assert.equal(f.p.short.quantity,60);assert.equal(f.store.data.killSwitch,false);
  assert.equal(f.p.status,'open');assert.equal(f.p.closeRequestedAt,undefined);assert.equal(f.p.closeProfitRequired,undefined);
  assert.equal(f.p.automaticCloseHistory?.length,1);
});

test('an explicit manual close does not wait for the automatic funding stability window',async t=>{
  mockDate(t);const f=fixture();await f.manage();
  assert.equal(f.p.holdDecision?.fundingExitStability?.sampleCount,1);assert.equal(f.requests.length,0);
  await f.engine.close(f.p.id);
  assert.equal(f.p.status,'closed');assert.equal(f.requests.length,2);assert.equal(f.p.closeProfitRequired,false);
  assert.equal(f.p.long.quantity,0);assert.equal(f.p.short.quantity,0);
});

test('persisted depth funding-loss intent cannot bypass a newly restarted funding observation window',async t=>{
  mockDate(t);const f=fixture();prepareLosingExit(f);
  f.p.closeRequestedAt=START-1;f.p.closeProfitRequired=true;f.p.closePricing='depth';
  await f.manage();assert.equal(f.p.holdDecision?.fundingExitStability?.sampleCount,1);
  await continueProfitDepth(f);
  assert.equal(f.requests.length,0);assert.equal(f.store.data.orders.length,0);
  assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);
});

test('a persisted depth profit intent still tests its actual worst IOC limits instead of profitable opposite 1',async t=>{
  mockDate(t);const f=fixture({topQuantity:40,earnedFundingUsd:.5});
  f.quotes.get('gate')!.bids.push({price:.99,quantity:60});
  f.quotes.get('bybit')!.asks.push({price:1.01,quantity:60});
  f.p.status='attention';await f.manage();
  assert.ok(f.p.holdDecision!.exitProfit!.netPnlUsd>.1,'Opposite 1 estimate remains profitable');
  f.p.closeRequestedAt=Date.now()-1;f.p.closeProfitRequired=true;f.p.closePricing='depth';
  await continueProfitDepth(f);
  assert.equal(f.requests.length,0,'The actual full-depth worst bounds would lose money');
  assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);
});

test('a depth funding-loss retry cannot reduce matched residuals when fresh funding becomes positive',async t=>{
  mockDate(t);const f=fixture();prepareLosingExit(f);await observeStableWithoutTrading(t,f);
  f.setFillQuantity((_exchange,request)=>f.requests.length<=2?40:request.quantity);
  f.setAfterFill(()=>{if(f.requests.length===2){t.mock.timers.setTime(Date.now()+1);f.publish({shortRate:.001});}});
  await continueProfitDepth(f);
  assert.equal(f.requests.length,2);assert.ok(f.requests.every(({request})=>request.quantity===100));
  assert.equal(f.p.long.quantity,60);assert.equal(f.p.short.quantity,60);
  assert.equal(f.p.status,'attention');assert.equal(f.store.data.killSwitch,false);
  t.mock.timers.setTime(START+190_000);f.readAccounts();f.publish({shortRate:.001});await f.manage();
  assert.equal(f.p.status,'open');assert.equal(f.p.closeRequestedAt,undefined);assert.equal(f.requests.length,2);
});

test('a depth funding-loss close repairs only confirmed excess after funding flips positive',async t=>{
  mockDate(t);const f=fixture();prepareLosingExit(f);await observeStableWithoutTrading(t,f);
  f.setFillQuantity((exchange,request)=>f.requests.length<=2?(exchange==='gate'?40:10):request.quantity);
  f.setAfterFill(()=>{if(f.requests.length===2){t.mock.timers.setTime(Date.now()+1);f.publish({shortRate:.001});}});
  await continueProfitDepth(f);
  assert.deepEqual(f.requests.map(({exchange,request})=>[exchange,request.quantity]),[['gate',100],['bybit',100],['bybit',30]]);
  assert.equal(f.p.long.quantity,60);assert.equal(f.p.short.quantity,60);
  assert.equal(f.p.status,'attention');assert.equal(f.store.data.killSwitch,false);
  t.mock.timers.setTime(START+190_000);f.readAccounts();f.publish({shortRate:.001});await f.manage();
  assert.equal(f.p.status,'open');assert.equal(f.p.closeRequestedAt,undefined);assert.equal(f.requests.length,3);
});

test('persisted depth execution without its required profit callback never submits common reductions',async t=>{
  mockDate(t);const f=fixture();
  f.p.closeRequestedAt=START-1;f.p.closeProfitRequired=true;f.p.closePricing='depth';
  await f.engine.execution.close(f.p,'历史请求缺少本轮评估',undefined,{pricing:'depth',requireProfit:true});
  assert.equal(f.requests.length,0);assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);
});

test('persisted depth funding-loss intent repeats funding qualification after awaited native preparation',async t=>{
  mockDate(t);const f=fixture();prepareLosingExit(f);await observeStableWithoutTrading(t,f);
  f.p.closeRequestedAt=Date.now()-1;f.p.closeProfitRequired=true;f.p.closePricing='depth';
  let validations=0;
  f.setValidate(async()=>{await Promise.resolve();if(++validations===1){
    t.mock.timers.setTime(Date.now()+1);f.publish({shortRate:.001});
  }});
  await continueProfitDepth(f);
  assert.equal(validations,2);assert.equal(f.requests.length,0);
  assert.equal(f.p.holdDecision?.fundingExitStability?.status,'positive');
  assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);
});

test('a persisted depth intent without its callback repairs only larger confirmed excess then retains equal holdings',async t=>{
  mockDate(t);const f=fixture();
  f.p.long.quantity=60;f.p.short.quantity=90;
  f.engine.accounts.get('gate')!.positions[0].quantity=60;
  f.engine.accounts.get('bybit')!.positions[0].quantity=90;
  f.p.closeRequestedAt=START-1;f.p.closeProfitRequired=true;f.p.closePricing='depth';
  await f.engine.execution.close(f.p,'历史请求仍需修复已确认尾差',undefined,{pricing:'depth',requireProfit:true});
  assert.deepEqual(f.requests.map(({exchange,request})=>[exchange,request.quantity,request.reduceOnly]),[['bybit',30,true]]);
  assert.equal(f.store.data.orders.length,1);assert.equal(f.store.data.orders[0].result?.filledQuantity,30);
  assert.equal(f.p.long.quantity,60);assert.equal(f.p.short.quantity,60);assert.equal(f.p.status,'closing');
  assert.equal(f.p.closeProfitRequired,true);assert.equal(f.store.data.killSwitch,false);
});

test('post-intent depth fill logging failure retains confirmed receipts without sending extra compensation',async t=>{
  mockDate(t);const f=fixture();prepareLosingExit(f);await observeStableWithoutTrading(t,f);
  f.setFillQuantity((exchange,request)=>f.requests.length<=2?(exchange==='gate'?40:10):request.quantity);
  const originalLog=f.store.log.bind(f.store);let logFailed=false;
  f.store.log=(level,message,positionId)=>{
    if(!logFailed&&message.includes('gate 减仓')&&f.store.data.orders.some(order=>order.exchange==='gate'&&order.result?.filledQuantity===40)){
      logFailed=true;throw new Error('Injected post-intent native fill logging failure');
    }
    originalLog(level,message,positionId);
  };
  await continueProfitDepth(f);
  assert.equal(logFailed,true);assert.equal(f.requests.length,2,'No compensation or retry may follow a post-intent persistence failure');
  assert.deepEqual(f.store.data.orders.map(order=>[order.exchange,order.result?.status,order.result?.filledQuantity]),
    [['gate','partial',40],['bybit','partial',10]]);
  assert.equal(f.p.long.quantity,60);assert.equal(f.p.short.quantity,90);assert.equal(f.p.status,'attention');
  assert.ok(f.p.riskReasons.some(reason=>reason.includes('保存中断')&&reason.includes('未提交额外补偿')));
  assert.ok(Math.abs(f.p.feesUsd-.1255)<1e-12,'Confirmed fees remain booked despite logging failure');
  assert.equal(f.p.closedAt,undefined);
});

test('a losing hedge exits near actual payment only after independent sustained funding confirmation',async t=>{
  mockDate(t);const f=fixture();prepareLosingExit(f);await observeFour(t,f);
  t.mock.timers.setTime(START+180_000);f.publish();await f.manage();
  assert.equal(f.p.holdDecision?.fundingExitStability?.status,'confirmed');
  assert.equal(f.p.holdDecision?.exitSignal,'funding-loss');assert.equal(f.p.closeProfitRequired,true);
  assert.equal(f.p.status,'closed');assert.equal(f.requests.length,2);
  assert.ok(f.requests.every(({request})=>request.reduceOnly&&request.quantity===100));
  assert.ok(Math.abs(f.p.netPnlUsd+.205)<1e-12,'Historical trade loss is realized without inserting future funding');
  assert.equal(f.p.fundingUsd,0);
});

test('even directly adverse confirmed funding does not create a losing exit before its payment window',async t=>{
  mockDate(t);const f=fixture();prepareLosingExit(f,START+3_600_000);await observeFour(t,f);
  t.mock.timers.setTime(START+180_000);f.publish();await f.manage();
  assert.equal(f.p.holdDecision?.fundingExitStability?.status,'confirmed');
  assert.equal(f.p.holdDecision?.fundingLossExit?.paymentWindowOpen,false);
  assert.ok(f.p.holdDecision!.fundingLossExit!.expectedSavingsUsd>.1);
  assert.equal(f.p.status,'open');assert.equal(f.requests.length,0);assert.equal(f.p.closeRequestedAt,undefined);
});

test('a losing projected hedge waits ten minutes and then exits only with a nearby actual payment',async t=>{
  mockDate(t);const f=fixture(),paymentAt=START+840_000;
  f.p.fundingUsd=0;f.p.profitExitPolicy!.fundingChecks=[{exchange:'gate',timestamp:paymentAt+7*3_600_000},{exchange:'bybit',timestamp:paymentAt}];
  for(let elapsed=0;elapsed<=600_000;elapsed+=30_000){
    t.mock.timers.setTime(START+elapsed);
    f.publish({longNext:paymentAt+7*3_600_000,shortNext:paymentAt,longInterval:8,shortInterval:1,longRate:-.036,shortRate:-.006});
    await f.manage();
    if(elapsed<600_000)assert.equal(f.requests.length,0,'No early exit based on a distant projection');
  }
  assert.equal(f.p.holdDecision?.fundingExitStability?.requiredSpanMs,600_000);
  assert.ok(f.p.holdDecision!.fundingExitStability!.observedNextNetUsd!>0);
  assert.equal(f.p.holdDecision?.exitSignal,'funding-loss');assert.equal(f.p.status,'closed');
  assert.equal(f.requests.length,2);assert.ok(f.p.netPnlUsd<0);
});

test('a favorable funding update during native validation blocks a new losing close intent',async t=>{
  mockDate(t);const f=fixture();prepareLosingExit(f);await observeFour(t,f);
  let validations=0;
  f.setValidate(async()=>{await Promise.resolve();if(++validations===1){t.mock.timers.setTime(Date.now()+1);f.publish({shortRate:.001});}});
  t.mock.timers.setTime(START+180_000);f.publish();await f.manage();
  assert.equal(validations,2);assert.equal(f.requests.length,0);assert.equal(f.p.closeRequestedAt,undefined);
  assert.equal(f.p.holdDecision?.fundingExitStability?.status,'positive');assert.equal(f.p.holdDecision?.action,'hold');
});

test('an increased native closing fee cancels a losing exit after private preparation',async t=>{
  mockDate(t);const f=fixture();prepareLosingExit(f);await observeFour(t,f);
  let validations=0;
  f.setValidate(async()=>{await Promise.resolve();if(++validations===1)for(const quote of f.quotes.values())quote.takerFeeRate=.008;});
  t.mock.timers.setTime(START+180_000);f.publish();await f.manage();
  assert.equal(validations,2);assert.equal(f.requests.length,0);assert.equal(f.p.closeRequestedAt,undefined);
  assert.equal(f.p.holdDecision?.action,'wait');assert.match(f.p.holdDecision!.reason,/受控退出条件未达标/);
});

test('a losing exit values the exact prepared limits even after the current book improves',async t=>{
  mockDate(t);const f=fixture();prepareLosingExit(f);await observeFour(t,f);
  let validations=0;
  f.setValidate(async()=>{await Promise.resolve();if(++validations===1){
    const long=f.quotes.get('gate')!,short=f.quotes.get('bybit')!;
    long.bids=[{price:1.02,quantity:100}];long.asks=[{price:1.022,quantity:100}];
    short.bids=[{price:.978,quantity:100}];short.asks=[{price:.98,quantity:100}];
  }});
  t.mock.timers.setTime(START+180_000);f.publish();await f.manage();
  assert.equal(validations,2);assert.equal(f.requests.length,0);assert.equal(f.p.closeRequestedAt,undefined);
  assert.ok(f.p.holdDecision!.fundingLossExit!.spreadCostUsd>4);
  assert.equal(f.p.holdDecision?.action,'wait');
});

test('a partial losing exit retains matched residuals when funding recovers and cannot bypass later verification',async t=>{
  mockDate(t);const f=fixture({topQuantity:40});prepareLosingExit(f);await observeFour(t,f);
  f.setAfterFill(()=>{if(f.requests.length===2){t.mock.timers.setTime(Date.now()+1);f.publish({shortRate:.001});}});
  t.mock.timers.setTime(START+180_000);f.publish();await f.manage();
  assert.equal(f.requests.length,2);assert.equal(f.p.long.quantity,60);assert.equal(f.p.short.quantity,60);
  assert.equal(f.p.status,'attention');assert.equal(f.p.closeProfitRequired,true);assert.ok(f.p.closePauseReason);
  const orders=structuredClone(f.store.data.orders),cash={funding:f.p.fundingUsd,fees:f.p.feesUsd,realized:f.p.realizedSpreadPnlUsd};
  const requestedAt=f.p.closeRequestedAt,reason=f.p.closeReason;
  t.mock.timers.setTime(START+190_000);f.readAccounts();f.publish({shortRate:.001});await f.manage();
  assert.equal(f.requests.length,2);assert.equal(f.p.long.quantity,60);assert.equal(f.p.short.quantity,60);
  assert.equal(f.p.status,'open');assert.equal(f.p.closeRequestedAt,undefined);assert.equal(f.p.closeAttemptedAt,undefined);
  assert.equal(f.p.closeProfitRequired,undefined);assert.equal(f.p.closePricing,undefined);assert.equal(f.p.closeReason,undefined);
  assert.equal(f.p.automaticCloseHistory?.length,1);assert.equal(f.p.automaticCloseHistory![0].requestedAt,requestedAt);
  assert.equal(f.p.automaticCloseHistory![0].reason,reason);
  assert.deepEqual(f.store.data.orders,orders);assert.deepEqual({funding:f.p.fundingUsd,fees:f.p.feesUsd,realized:f.p.realizedSpreadPnlUsd},cash);
  const continuation=(f.engine as unknown as {continuingClosePositions:Set<string>}).continuingClosePositions;
  assert.equal(continuation.has(f.p.id),false);
});

test('a losing exit repairs only confirmed unmatched excess after funding recovers',async t=>{
  mockDate(t);const f=fixture({topQuantity:40});prepareLosingExit(f);await observeFour(t,f);
  let shortCalls=0;
  f.setFillQuantity((exchange,request)=>exchange==='bybit'&&++shortCalls===1?10:request.quantity);
  f.setAfterFill(()=>{if(f.requests.length===2){t.mock.timers.setTime(Date.now()+1);f.publish({shortRate:.001});}});
  t.mock.timers.setTime(START+180_000);f.publish();await f.manage();
  assert.deepEqual(f.requests.map(({exchange,request})=>[exchange,request.quantity]),[['gate',40],['bybit',40],['bybit',30]]);
  assert.equal(f.p.long.quantity,60);assert.equal(f.p.short.quantity,60);assert.equal(f.p.closeProfitRequired,true);
  assert.equal(f.store.data.killSwitch,false);
});

function savedConditionalIntent(f:ReturnType<typeof fixture>,pricing:'best-opposite'|'depth'='best-opposite'){
  f.p.status='closing';f.p.closeRequestedAt=START-100;f.p.closeAttemptedAt=START-50;
  f.p.closeProfitRequired=true;f.p.closePricing=pricing;f.p.closeReason='MEMORY prior confirmed funding-loss signal';
  // The original memory session explicitly adopted this manager; a restarted Engine receives no such authority.
  (f.engine as unknown as {reconciledPositions:Set<string>}).reconciledPositions.add(f.p.id);
  f.publish({shortRate:.001});
}

test('a saved automatic exit requires fresh post-order matching accounts before returning to open',async t=>{
  mockDate(t);const f=fixture();savedConditionalIntent(f);
  await f.manage();assert.equal(f.p.status,'attention');assert.ok(f.p.closePauseReason);
  assert.equal(f.p.automaticCloseHistory,undefined);assert.ok(f.p.closeRequestedAt);
  f.readAccounts();f.engine.health.find(row=>row.exchange==='gate')!.accountUpdatedAt=START-51;
  await f.manage();assert.equal(f.p.status,'attention');assert.ok(f.p.closeRequestedAt,'A pre-order account read cannot resume holding');
  f.readAccounts();f.engine.accounts.get('gate')!.positions[0].quantity=99;
  await f.manage();assert.equal(f.p.status,'attention');assert.ok(f.p.closeRequestedAt,'Actual mismatching quantity cannot resume holding');
  f.engine.accounts.get('gate')!.positions[0].quantity=100;
  t.mock.timers.setTime(START+f.store.data.config.maxSnapshotAgeMs+1);f.publish({shortRate:.001});
  await f.manage();assert.equal(f.p.status,'attention');assert.ok(f.p.closeRequestedAt,'Expired matching account reads are insufficient');
  f.readAccounts();await f.manage();assert.equal(f.p.status,'open');assert.equal(f.p.closeRequestedAt,undefined);
  assert.equal(f.requests.length,0);assert.equal((f.p as Position).automaticCloseHistory?.length,1);
});

test('fresh matching accounts never adopt a restarted conditional intent, even after the next tick becomes profitable',async t=>{
  mockDate(t);
  for(const paused of [false,true]){
    t.mock.timers.setTime(START);const f=fixture();savedConditionalIntent(f,'depth');
    if(paused)f.p.closePauseReason='MEMORY prior economic pause';
    const historical:Position={...structuredClone(f.p),id:'MEMORY archived older ARK',status:'attention',
      accountClosure:{confirmedAt:START-1,reason:'MEMORY independent flat proof',historicalOrdersPending:true}};
    f.store.data.positions.push(historical);
    const historicalBefore=structuredClone(historical),restarted=f.createEngine();t.after(()=>restarted.stop());
    restarted.snapshots=[...f.quotes.values()];f.readAccounts(restarted);
    const internal=restarted as unknown as {managePositions(now:number):Promise<void>;continuingClosePositions:Set<string>;reconciledPositions:Set<string>};
    assert.equal(internal.continuingClosePositions.size,0);assert.equal(internal.reconciledPositions.size,0);
    const originalIntent={requestedAt:f.p.closeRequestedAt,attemptedAt:f.p.closeAttemptedAt,pauseReason:f.p.closePauseReason},
      cash={funding:f.p.fundingUsd,fees:f.p.feesUsd,spread:f.p.realizedSpreadPnlUsd};
    await internal.managePositions(Date.now());
    assert.equal(f.p.status,'attention');assert.equal(f.p.automaticCloseHistory,undefined);
    t.mock.timers.setTime(START+1);f.publish({shortRate:.001});
    const long=f.quotes.get(f.longExchange)!;long.bids=[{price:1.005,quantity:100}];long.asks=[{price:1.007,quantity:100}];
    // The fresh price can clear 10 bps with reference fees, but native fees require another actual read.
    for(const quote of f.quotes.values()){quote.takerFeeAt=START-120_001;quote.makerFeeAt=START-120_001;}
    restarted.snapshots=[...f.quotes.values()];f.readAccounts(restarted);
    assert.equal(alignedExitProfitsPass(f.p,assessBestOppositeProfitExit(f.p,long,f.quotes.get(f.shortExchange),f.store.data.config,
      Date.now(),undefined,undefined,false),f.store.data.config),true);
    await internal.managePositions(Date.now());assert.equal(f.p.status,'attention');
    assert.deepEqual({requestedAt:f.p.closeRequestedAt,attemptedAt:f.p.closeAttemptedAt,pauseReason:f.p.closePauseReason},originalIntent);
    assert.equal(f.p.automaticCloseHistory,undefined);assert.deepEqual(historical,historicalBefore);
    assert.deepEqual({funding:f.p.fundingUsd,fees:f.p.feesUsd,spread:f.p.realizedSpreadPnlUsd},cash);
    assert.equal(restarted.autoEnabled,false);assert.equal(f.feeRequests.length,0);assert.equal(f.requests.length,0);assert.equal(f.store.data.orders.length,0);
    assert.equal(internal.continuingClosePositions.size,0);assert.equal(internal.reconciledPositions.size,0);
  }
});

test('explicitly reconciled session authority releases a confirmed old conditional intent only after fresh accounts',async t=>{
  mockDate(t);const f=fixture();savedConditionalIntent(f,'depth');const restarted=f.createEngine();t.after(()=>restarted.stop());
  restarted.snapshots=[...f.quotes.values()];
  const internal=restarted as unknown as {managePositions(now:number):Promise<void>;continuingClosePositions:Set<string>;reconciledPositions:Set<string>};
  internal.reconciledPositions.add(f.p.id);
  await internal.managePositions(Date.now());assert.equal(f.p.status,'attention');assert.ok(f.p.closeRequestedAt);
  f.readAccounts(restarted);await internal.managePositions(Date.now());
  assert.equal(f.p.status,'open');assert.equal(f.p.closeRequestedAt,undefined);assert.equal(f.p.automaticCloseHistory?.length,1);
  assert.equal(f.p.automaticCloseHistory![0].pricing,'depth');assert.equal(internal.continuingClosePositions.size,0);
  assert.equal(f.feeRequests.length,0);assert.equal(f.requests.length,0);assert.equal(f.store.data.orders.length,0);
});

test('current adaptive strategy archives a confirmed historical once intent without changing its original policy or cash',async t=>{
  mockDate(t);const f=fixture();f.p.holdMode='once';f.p.plannedExitAt=START-1000;
  savedConditionalIntent(f,'depth');f.readAccounts();
  const original={entryPolicy:f.p.entryPolicy,holdMode:f.p.holdMode,profitExitPolicy:structuredClone(f.p.profitExitPolicy),
    fundingUsd:f.p.fundingUsd,feesUsd:f.p.feesUsd,realizedSpreadPnlUsd:f.p.realizedSpreadPnlUsd,transferCostUsd:f.p.transferCostUsd,
    long:structuredClone(f.p.long),short:structuredClone(f.p.short)};
  const intent={requestedAt:f.p.closeRequestedAt,attemptedAt:f.p.closeAttemptedAt,reason:f.p.closeReason,pricing:f.p.closePricing};
  assert.equal(f.store.data.config.holdMode,'adaptive');
  await f.manage();
  assert.equal(f.p.status,'open');assert.equal(f.p.closeRequestedAt,undefined);assert.equal(f.p.closeProfitRequired,undefined);
  assert.equal(f.p.closeAttemptedAt,undefined);assert.equal(f.p.closePricing,undefined);assert.equal(f.p.closePauseReason,undefined);
  assert.equal(f.p.automaticCloseHistory?.length,1);
  assert.deepEqual({requestedAt:f.p.automaticCloseHistory![0].requestedAt,attemptedAt:f.p.automaticCloseHistory![0].attemptedAt,
    reason:f.p.automaticCloseHistory![0].reason,pricing:f.p.automaticCloseHistory![0].pricing},intent);
  assert.deepEqual({entryPolicy:f.p.entryPolicy,holdMode:f.p.holdMode,profitExitPolicy:f.p.profitExitPolicy,
    fundingUsd:f.p.fundingUsd,feesUsd:f.p.feesUsd,realizedSpreadPnlUsd:f.p.realizedSpreadPnlUsd,transferCostUsd:f.p.transferCostUsd,
    long:f.p.long,short:f.p.short},original);
  t.mock.timers.tick(1);f.publish({shortRate:.001});f.readAccounts();await f.manage();
  assert.equal(f.p.status,'open');assert.equal(f.p.holdDecision?.action,'hold');
  assert.equal(f.p.holdDecision?.fundingExitStability?.status,'positive');
  assert.equal(f.p.holdMode,'once');assert.equal(f.p.closeRequestedAt,undefined);assert.equal(f.p.automaticCloseHistory?.length,1);
  assert.equal(f.feeRequests.length,0);assert.equal(f.requests.length,0);assert.equal(f.store.data.orders.length,0);
});

test('an equal local lower bound with an unknown or invalid terminal receipt never releases a close intent',async t=>{
  mockDate(t);const f=fixture();savedConditionalIntent(f);f.readAccounts();
  const request:OrderRequest={clientOrderId:'MEMORY unresolved',base:f.p.base,symbol:f.p.short.symbol,
    side:'buy',quantity:40,limitPrice:1,reduceOnly:true};
  const order={positionId:f.p.id,exchange:f.shortExchange,request,createdAt:START-50,result:{
    id:'MEMORY unresolved native',clientOrderId:request.clientOrderId,status:'unknown' as const,
    filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:START-40}};
  f.store.data.orders.push(order);await f.manage();
  assert.ok(f.p.closeRequestedAt);assert.equal(f.p.automaticCloseHistory,undefined);assert.notEqual(f.p.status,'open');
  order.result={...order.result,status:'filled' as never};await f.manage();
  assert.ok(f.p.closeRequestedAt);assert.equal(f.p.automaticCloseHistory,undefined);assert.equal(f.requests.length,0);
});

test('manual, emergency, scheduled, unequal, rejected and killed intents do not become economic holds',async t=>{
  mockDate(t);
  for(const kind of ['manual','emergency','scheduled','unequal','rejected','killed'] as const){
    const f=fixture();savedConditionalIntent(f);f.readAccounts();
    if(kind==='manual')f.p.manualCloseOnly=true;
    if(kind==='emergency')f.p.closeProfitRequired=false;
    if(kind==='scheduled'){f.p.holdMode='once';f.store.data.config.holdMode='once';}
    if(kind==='unequal')f.p.short.quantity=90;
    if(kind==='killed')f.store.data.killSwitch=true;
    if(kind==='rejected'){
      const request:OrderRequest={clientOrderId:'MEMORY refused',base:f.p.base,symbol:f.p.short.symbol,
        side:'buy',quantity:40,limitPrice:1,reduceOnly:true};
      f.store.data.orders.push({positionId:f.p.id,exchange:f.shortExchange,request,createdAt:START-50,result:{
        id:'',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,
        timestamp:START-40,rejectionCode:'110017'}});
    }
    await f.manage();assert.ok(f.p.closeRequestedAt,kind);assert.equal(f.p.automaticCloseHistory,undefined,kind);
    assert.equal(f.requests.length,0,kind);assert.notEqual(f.p.status,'open',kind);
  }
});

test('an explicit manual reduction still overrides a paused automatic exit',async t=>{
  mockDate(t);const f=fixture();savedConditionalIntent(f);await f.manage();
  assert.ok(f.p.closePauseReason);assert.equal(f.p.status,'attention');
  await f.engine.close(f.p.id);
  assert.equal(f.p.status,'closed');assert.equal(f.p.closeProfitRequired,false);assert.equal(f.p.closePauseReason,undefined);
  assert.equal(f.p.long.quantity,0);assert.equal(f.p.short.quantity,0);assert.equal(f.requests.length,2);
  assert.equal(f.p.automaticCloseHistory,undefined);
});

test('a cancelled price condition clears old funding confirmation before any later automatic exit',async t=>{
  mockDate(t);const f=fixture();prepareLosingExit(f);await observeStableWithoutTrading(t,f);
  f.p.closeRequestedAt=START+179_900;f.p.closeAttemptedAt=START+179_950;f.p.closeProfitRequired=true;
  f.p.closePauseReason='MEMORY exact submitted limit no longer passes';f.p.status='attention';f.readAccounts();
  (f.engine as unknown as {reconciledPositions:Set<string>}).reconciledPositions.add(f.p.id);
  await f.manage();assert.equal(f.p.status,'open');assert.equal(f.p.closeRequestedAt,undefined);
  t.mock.timers.setTime(START+190_000);f.publish();await f.manage();
  assert.equal(f.p.holdDecision?.fundingExitStability?.sampleCount,1);
  assert.equal(f.p.holdDecision?.fundingExitStability?.observedSpanMs,0);
  assert.equal(f.requests.length,0,'Old confirmed funding cannot execute another automatic intent immediately');
});
