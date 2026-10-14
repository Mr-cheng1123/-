import assert from 'node:assert/strict';
import test from 'node:test';
import {Engine} from '../src/core/engine.js';
import type {Store} from '../src/core/store.js';
import {defaultConfig} from '../src/shared/config.js';
import type {AccountState,AppConfig,ExchangeAdapter,ExchangeId,MarketSnapshot,OrderRequest,OrderResult,Position,TradingFeeMetadata} from '../src/shared/types.js';

const NOW=Date.UTC(2026,9,10,3,0,0),symbol='TESTSPREAD/USDT:USDT';

/** Real Engine and Execution, with all accounts, prices, fee reads and fills held in memory. */
function fixture(options:{topQuantity?:number;nativeFees?:boolean;missingFees?:boolean;feeRate?:number;permission?:boolean}={}){
  const exchanges:ExchangeId[]=['gate','bybit'];
  const config:AppConfig={...structuredClone(defaultConfig),mode:'live',dataSource:'public',entryPolicy:'aligned',
    exchanges,symbols:['TESTSPREAD'],holdMode:'adaptive',maxOrderRetries:0};
  const store={data:{version:1,config,positions:[],orders:[],logs:[],equity:[],killSwitch:false,fundingSeen:[]},save(){},log(){}} as unknown as Store;
  const quotes=new Map<ExchangeId,MarketSnapshot>(),nativeFees=new Map<ExchangeId,TradingFeeMetadata>();
  let feeRate=options.feeRate??.0005;
  const feeReads:ExchangeId[]=[],requests:Array<{exchange:ExchangeId;request:OrderRequest}>=[];
  const accounts=new Map<ExchangeId,AccountState>();
  for(const exchange of exchanges){
    if(options.nativeFees!==false)nativeFees.set(exchange,{takerFeeSource:'exchange',takerFeeRate:feeRate,takerFeeAt:Date.now(),
      makerFeeSource:'exchange',makerFeeRate:feeRate,makerFeeAt:Date.now()});
    quotes.set(exchange,{exchange,base:'TESTSPREAD',symbol,source:'public',timestamp:Date.now(),observedAt:Date.now(),
      fundingObservedAt:Date.now(),bookTransport:'websocket',markPrice:1,indexPrice:1,fundingRate:exchange==='bybit'?.001:0,
      intervalHours:8,nextFundingTime:Date.now()+3_600_000,fundingHistory:[],
      bids:[{price:exchange==='gate'?1.006:.998,quantity:options.topQuantity??100}],
      asks:[{price:exchange==='gate'?1.008:1,quantity:options.topQuantity??100}],
      quantityStep:1,minQuantity:1,minNotional:5,contractSize:1,openInterestUsd:1e6,volume24hUsd:1e6,feeProfile:'standard'});
    accounts.set(exchange,{freeUsd:1000,equityUsd:1000,positions:[{base:'TESTSPREAD',symbol,side:exchange==='gate'?'long':'short',
      quantity:100,markPrice:1,entryPrice:1,liquidationPrice:0,leverage:2}]});
  }
  let beforeRefresh:(exchange:ExchangeId)=>void=()=>{},afterValidate:(exchange:ExchangeId)=>void=()=>{},afterFill:()=>void=()=>{};
  const adapters=exchanges.map(exchange=>({id:exchange,fetchSnapshots:async()=>[quotes.get(exchange)!],
    fetchExecutionSnapshots:async()=>{beforeRefresh(exchange);return [quotes.get(exchange)!];},getExecutionSnapshot:()=>quotes.get(exchange),
    fetchAccount:async()=>structuredClone(accounts.get(exchange)!),fetchFundingPayments:async()=>[],inspectTrading:async()=>{},prepareTrading:async()=>{},
    fetchTradingFee:async(requestedSymbol:string)=>{assert.equal(requestedSymbol,symbol);feeReads.push(exchange);if(options.missingFees)return;
      const fee:TradingFeeMetadata={takerFeeSource:'exchange',takerFeeRate:feeRate,takerFeeAt:Date.now(),
        makerFeeSource:'exchange',makerFeeRate:feeRate,makerFeeAt:Date.now()};nativeFees.set(exchange,fee);return fee;},
    cachedTradingFee:()=>nativeFees.get(exchange),validateOrder:async(request:OrderRequest)=>{assert.equal(request.reduceOnly,true);afterValidate(exchange);},
    supportsMakerReduction:()=>true,validateMakerReduction:async(request:OrderRequest)=>{assert.equal(request.postOnly,true);assert.equal(request.reduceOnly,true);afterValidate(exchange);},
    submitMakerReduction:async(request:OrderRequest,canSubmit?:()=>boolean):Promise<OrderResult>=>{
      if(canSubmit&&!canSubmit())return {id:'',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,
        rejectionCode:'MAKER_REDUCTION_PERMISSION_CHANGED',rejectionReason:'MEMORY final guard veto',timestamp:Date.now()};
      assert.equal(request.reduceOnly,true);assert.equal(request.postOnly,true);requests.push({exchange,request:{...request}});
      return {id:`MEMORY-SPREAD-${requests.length}`,clientOrderId:request.clientOrderId,status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:NaN,timestamp:Date.now()};
    },inspectMakerReduction:async(request:OrderRequest,id?:string)=>{
      const quantity=request.quantity,price=request.limitPrice;
      accounts.get(exchange)!.positions[0].quantity-=quantity;afterFill();
      return {activity:'terminal' as const,executionVerified:true,observedAt:Date.now(),result:{id:id!,clientOrderId:request.clientOrderId,
        status:'filled' as const,filledQuantity:quantity,averagePrice:price,averagePriceVerified:true,
        feeUsd:quantity*price*nativeFees.get(exchange)!.makerFeeRate!,timestamp:Date.now()}};
    },cancelMakerReduction:async()=>{},
    placeOrder:async(request:OrderRequest):Promise<OrderResult>=>{
      assert.equal(request.reduceOnly,true);assert.ok(nativeFees.has(exchange));requests.push({exchange,request:{...request}});
      const result:OrderResult={id:`MEMORY-SPREAD-${requests.length}`,clientOrderId:request.clientOrderId,status:'filled',
        filledQuantity:request.quantity,averagePrice:request.limitPrice,feeUsd:request.quantity*request.limitPrice*nativeFees.get(exchange)!.takerFeeRate!,timestamp:Date.now()};
      accounts.get(exchange)!.positions[0].quantity-=request.quantity;afterFill();return result;
    },reconcileOrder:async()=>{throw new Error('Unexpected memory reconciliation');},cancelOrder:async()=>{throw new Error('Unexpected memory cancellation');},close:async()=>{}
  } as ExchangeAdapter));
  const engine=new Engine(store,options.permission!==false,{adapterFactory:()=>adapters,liveEnvironment:{
    ALLOW_LIVE_TRADING:'true',LIVE_TRADING_ACK:'I_UNDERSTAND_THE_RISKS',GATE_API_KEY:'MEMORY',GATE_API_SECRET:'MEMORY',
    BYBIT_API_KEY:'MEMORY',BYBIT_API_SECRET:'MEMORY'}});
  const p:Position={id:'spread-profit-memory',base:'TESTSPREAD',mode:'live',entryPolicy:'aligned',holdMode:'adaptive',status:'open',
    openedAt:Date.now()-1000,plannedExitAt:Date.now()+3_610_000,
    long:{exchange:'gate',symbol,side:'long',quantity:100,entryPrice:1,markPrice:1,feesUsd:.05,liquidationDistancePct:null},
    short:{exchange:'bybit',symbol,side:'short',quantity:100,entryPrice:1,markPrice:1,feesUsd:.05,liquidationDistancePct:null},
    fundingUsd:0,feesUsd:.1,transferCostUsd:0,realizedSpreadPnlUsd:0,spreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[],
    profitExitPolicy:{firstFundingTime:Date.now()+3_600_000,earliestExitAt:Date.now()+3_610_000,minSpreadNetUsd:0,minCombinedNetUsd:0,
      fundingChecks:exchanges.map(exchange=>({exchange,timestamp:Date.now()+3_600_000}))}};
  // Add the current managed fixture only after construction, so restart restoration grants no authority.
  store.data.positions.push(p);engine.snapshots=[...quotes.values()];
  const readAccounts=()=>{
    for(const [exchange,account] of accounts){engine.accounts.set(exchange,account);
      const health=engine.health.find(value=>value.exchange===exchange)!;
      health.status='online';health.lastSuccess=Date.now();health.accountStatus='ready';health.accountUpdatedAt=Date.now();}
  };
  readAccounts();
  const publish=(changes:{long?:Partial<MarketSnapshot>;short?:Partial<MarketSnapshot>}={})=>{
    for(const [exchange,quote] of quotes)quotes.set(exchange,{...quote,timestamp:Date.now(),observedAt:Date.now(),fundingObservedAt:Date.now(),
      ...(exchange==='gate'?changes.long:changes.short)});
    engine.snapshots=[...quotes.values()];
  };
  return {engine,store,p,quotes,nativeFees,feeReads,requests,readAccounts,publish,
    manage:async()=>{await (engine as unknown as {managePositions(now:number):Promise<void>}).managePositions(Date.now());await engine.execution.waitMakerClose(p);},
    setFeeRate(rate:number){feeRate=rate;},setRefresh(fn:typeof beforeRefresh){beforeRefresh=fn;},
    setValidate(fn:typeof afterValidate){afterValidate=fn;},setAfterFill(fn:typeof afterFill){afterFill=fn;}};
}

test('aligned price profit closes on its first review even with positive future funding',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();
  await f.manage();
  assert.equal(f.p.status,'closed');assert.equal(f.requests.length,2);assert.equal(f.p.holdDecision?.exitSignal,'profit');
  assert.equal(f.p.holdDecision?.fundingExitStability?.status,'positive');
  assert.deepEqual(Object.keys(f.p.holdDecision!.exitProfit!).sort(),['closingFeesUsd','fundingAfterFeesUsd','netPnlUsd',
    'spreadAfterClosingFeesUsd','spreadAfterFeesUsd','spreadPnlUsd','totalFeesUsd'].sort());
  assert.ok(f.p.netPnlUsd>.1);assert.equal(f.p.fundingUsd,0);
  assert.ok(f.requests.every(({request})=>request.quantity===100&&request.reduceOnly));
});

test('aligned profit does not wait for an adverse funding confirmation window',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();f.publish({short:{fundingRate:-.001}});
  await f.manage();assert.equal(f.p.status,'closed');assert.equal(f.requests.length,2);
  assert.equal(f.p.holdDecision?.fundingExitStability?.sampleCount,1);
  assert.equal(f.p.holdDecision?.fundingExitStability?.observedSpanMs,0);
});

test('future funding or mark metadata does not block a verified executable profit',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();
  f.publish({long:{markPrice:NaN,fundingRate:NaN,nextFundingTime:NaN,intervalHours:NaN},
    short:{markPrice:NaN,fundingRate:NaN,nextFundingTime:NaN,intervalHours:NaN}});
  await f.manage();assert.equal(f.p.status,'closed');assert.equal(f.requests.length,2);assert.ok(f.p.netPnlUsd>.1);
  assert.equal(f.p.holdDecision?.exitSignal,'profit');assert.equal(f.p.holdDecision?.fundingExitStability?.status,'unavailable');
});

test('a positive-carry reference profit immediately checks both account contract fees',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture({nativeFees:false});
  assert.equal(f.nativeFees.size,0);await f.manage();
  assert.equal(f.p.status,'closed');assert.equal(f.requests.length,2);
  assert.deepEqual([...new Set(f.feeReads)].sort(),['bybit','gate']);
  assert.ok(f.requests.every(({request})=>request.reduceOnly));
});

test('actual account fees can reject a reference profit before any order intent',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture({nativeFees:false,feeRate:.005});
  await f.manage();assert.deepEqual([...new Set(f.feeReads)].sort(),['bybit','gate']);
  assert.equal(f.requests.length,0);assert.equal(f.store.data.orders.length,0);assert.equal(f.p.closeRequestedAt,undefined);
  assert.equal(f.p.status,'open');assert.equal(f.p.holdDecision?.action,'hold');
});

test('missing native fees explain a verified reference profit without attributing it to future funding',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  for(const invalidFunding of [false,true]){
    const f=fixture({nativeFees:false,missingFees:true});
    if(invalidFunding)f.publish({long:{fundingRate:NaN,nextFundingTime:NaN},short:{fundingRate:NaN,nextFundingTime:NaN}});
    await f.manage();assert.equal(f.feeReads.length,2);assert.equal(f.requests.length,0);assert.equal(f.p.status,'open');
    assert.equal(f.p.holdDecision?.action,'wait');assert.equal(f.p.holdDecision?.exitSignal,undefined);
    assert.match(f.p.holdDecision!.reason,/参考可平净收益.*实际平仓手续费尚未确认/);
    assert.equal(f.p.closeRequestedAt,undefined);assert.equal(f.store.data.orders.length,0);
  }
});

test('a refreshed original IOC trigger below profit cannot be rescued by a favorable passive Maker price',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();
  f.setRefresh(()=>f.publish({long:{bids:[{price:1.002,quantity:100}],asks:[{price:1.02,quantity:100}]}}));
  f.setValidate(()=>f.publish({long:{bids:[{price:1.01,quantity:100}],asks:[{price:1.02,quantity:100}]}}));
  await f.manage();assert.equal(f.requests.length,0);assert.equal(f.store.data.orders.length,0);
  assert.equal(f.p.closeRequestedAt,undefined);assert.equal(f.p.status,'open');assert.notEqual(f.p.holdDecision?.action,'close');
});

test('each new common batch rechecks actual fees and retains confirmed prior cash when profit vanishes',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture({topQuantity:40});
  f.setAfterFill(()=>{if(f.requests.length===2){t.mock.timers.tick(1);f.publish();f.readAccounts();f.setFeeRate(.005);}});
  await f.manage();assert.equal(f.requests.length,2);assert.equal(f.p.long.quantity,60);assert.equal(f.p.short.quantity,60);
  assert.ok(f.p.realizedSpreadPnlUsd>.23);assert.ok(f.p.feesUsd>.14);
  assert.equal(f.p.status,'closing');
  t.mock.timers.tick(5001);f.publish();f.readAccounts();await f.manage();assert.equal(f.requests.length,2);
  t.mock.timers.tick(1);f.publish();f.readAccounts();await f.manage();assert.equal(f.requests.length,2);
  assert.equal(f.p.status,'open');assert.equal(f.p.closeRequestedAt,undefined);assert.equal(f.p.automaticCloseHistory?.length,1);
  assert.equal(f.store.data.orders.length,2);
});

test('positive funding does not cancel a still-profitable conditional close on the following review',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture({topQuantity:40});
  f.setAfterFill(()=>{if(f.requests.length===2){t.mock.timers.tick(31_000);f.publish();f.readAccounts();}});
  await f.manage();assert.equal(f.p.status,'closing');assert.equal(f.p.long.quantity,60);assert.equal(f.p.short.quantity,60);
  const requestedAt=f.p.closeRequestedAt;assert.ok(requestedAt);assert.equal(f.requests.length,2);
  await f.manage();assert.equal(f.p.status,'closing');assert.equal(f.requests.length,4);
  t.mock.timers.tick(5001);f.publish();f.readAccounts();await f.manage();
  assert.equal(f.p.status,'closed');assert.equal(f.requests.length,6);assert.equal(f.p.closeRequestedAt,requestedAt);
  assert.equal(f.p.automaticCloseHistory,undefined);assert.ok(f.p.netPnlUsd>.1);
});

test('due funding without a receipt or complete bill window still blocks automatic profit',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();
  f.p.profitExitPolicy!.fundingChecks=f.store.data.config.exchanges.map(exchange=>({exchange,timestamp:NOW-500}));
  await f.manage();assert.equal(f.requests.length,0);assert.equal(f.store.data.orders.length,0);assert.equal(f.p.status,'open');
  assert.equal(f.p.closeRequestedAt,undefined);
});

test('an execution-locked profit observation neither reads private fees nor submits reductions',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture({permission:false,nativeFees:false});
  assert.equal(f.engine.liveUnlocked,false);await f.manage();
  assert.equal(f.feeReads.length,0);assert.equal(f.requests.length,0);assert.equal(f.store.data.orders.length,0);assert.equal(f.p.closeRequestedAt,undefined);
  assert.ok(f.p.riskReasons.some(reason=>reason.includes('只读')));
});

test('an original unknown order is not replayed or bypassed by an observed profit',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();
  f.store.data.orders.push({positionId:f.p.id,exchange:'gate',createdAt:NOW-100,
    request:{clientOrderId:'memory-original',base:'TESTSPREAD',symbol,side:'sell',quantity:1,limitPrice:1,reduceOnly:true},
    result:{id:'memory-original',clientOrderId:'memory-original',status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:NOW-100}});
  await f.manage();assert.equal(f.requests.length,0);assert.equal(f.store.data.orders.length,1);
  assert.equal(f.store.data.orders[0].request.clientOrderId,'memory-original');assert.equal(f.p.closeRequestedAt,undefined);
});
