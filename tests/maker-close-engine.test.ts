import assert from 'node:assert/strict';
import test from 'node:test';
import {Engine} from '../src/core/engine.js';
import type {Store} from '../src/core/store.js';
import {defaultConfig} from '../src/shared/config.js';
import {makerCloseComparisonReport} from '../src/shared/maker-close-comparison.js';
import type {AccountState,AppConfig,ExchangeAdapter,ExchangeId,JournalOrder,LivePortfolio,MakerReductionObservation,MarketSnapshot,OrderRequest,OrderResult,Position,TradingFeeMetadata} from '../src/shared/types.js';

const NOW=Date.UTC(2026,9,10,4),base='TESTMAKER',symbol=`${base}/USDT:USDT`;
type Frame={quantity:number;activity?:MakerReductionObservation['activity'];verified?:boolean;price?:number;feeUsd?:number;averageVerified?:boolean};
type NativeMaker={request:OrderRequest;exchange:ExchangeId;id:string;filled:number;cancelled:boolean};
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
async function bounded<T>(promise:Promise<T>,label:string,ms=500):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error(label)),ms);})]);}
  finally{if(timer)clearTimeout(timer);}
}

/** Real Engine and Execution. Every quote, native slot, ACK, read and fill stays in memory. */
function fixture(options:{wide?:'long'|'short';topQuantity?:number;permission?:boolean;missingFees?:boolean}={}){
  const exchanges:ExchangeId[]=['gate','bybit'],wide=options.wide??'long';
  const config:AppConfig={...structuredClone(defaultConfig),mode:'live',dataSource:'public',entryPolicy:'aligned',
    exchanges,symbols:[base],holdMode:'adaptive',maxOrderRetries:0,minExitProfitBps:10};
  const logs:Array<unknown>=[];
  const store={data:{version:1,config,positions:[],orders:[],logs:[],equity:[],killSwitch:false,fundingSeen:[]},
    save(){},log(...args:unknown[]){logs.push(args);}} as unknown as Store;
  const quotes=new Map<ExchangeId,MarketSnapshot>(),additionalQuotes=new Map<string,MarketSnapshot>();
  const nativeFees=new Map<ExchangeId,TradingFeeMetadata>(),accounts=new Map<ExchangeId,AccountState>();
  const events:string[]=[],feeReads:ExchangeId[]=[],makerRequests:Array<{exchange:ExchangeId;request:OrderRequest}>=[],
    peerRequests:Array<{exchange:ExchangeId;request:OrderRequest}>=[],cancelledIds:string[]=[],inspectedIds:Array<string|undefined>=[];
  const makers=new Map<string,NativeMaker>();
  for(const exchange of exchanges){
    if(!options.missingFees)nativeFees.set(exchange,{takerFeeRate:.0005,takerFeeAt:Date.now(),takerFeeSource:'exchange',
      makerFeeRate:.0002,makerFeeAt:Date.now(),makerFeeSource:'exchange'});
    const isLong=exchange==='gate';
    quotes.set(exchange,{exchange,base,symbol,source:'public',timestamp:Date.now(),observedAt:Date.now(),fundingObservedAt:Date.now(),
      bookTransport:'websocket',markPrice:1,indexPrice:1,fundingRate:isLong?0:.001,intervalHours:8,nextFundingTime:Date.now()+3_600_000,
      fundingHistory:[],bids:[{price:isLong?1.006:(wide==='short'?.99:.998),quantity:options.topQuantity??30}],
      asks:[{price:isLong?(wide==='long'?1.016:1.008):1,quantity:options.topQuantity??30}],quantityStep:1,minQuantity:1,minNotional:5,contractSize:1,
      openInterestUsd:1e6,volume24hUsd:1e6,feeProfile:'standard'});
    accounts.set(exchange,{freeUsd:1000,equityUsd:1000,positions:[{base,symbol,side:isLong?'long':'short',quantity:100,
      markPrice:1,entryPrice:1,liquidationPrice:0,leverage:2}]});
  }
  let inspectCall=0,inspector:(maker:NativeMaker,call:number)=>Promise<Frame>|Frame=()=>({quantity:0,activity:'terminal'}),
    peerFill:(request:OrderRequest,call:number)=>number|'unknown'=(request)=>request.quantity,
    afterPeer:()=>void=()=>{};
  const accountRow=(exchange:ExchangeId,requestedBase:string)=>accounts.get(exchange)!.positions.find(row=>row.base===requestedBase)!;
  const snapshot=(exchange:ExchangeId,requestedBase=base)=>requestedBase===base?quotes.get(exchange):additionalQuotes.get(`${exchange}:${requestedBase}`);
  const adapters=exchanges.map(exchange=>({id:exchange,supportsMakerReduction:()=>true,
    fetchSnapshots:async()=>[quotes.get(exchange)!],fetchExecutionSnapshots:async(requestedBases:string[])=>requestedBases.map(requestedBase=>snapshot(exchange,requestedBase)!),
    getExecutionSnapshot:(requestedBase:string)=>snapshot(exchange,requestedBase),fetchAccount:async()=>structuredClone(accounts.get(exchange)!),
    fetchFundingPayments:async()=>[],inspectTrading:async()=>{},prepareTrading:async()=>{},
    fetchTradingFee:async(requestedSymbol:string)=>{assert.equal(requestedSymbol,symbol);feeReads.push(exchange);return nativeFees.get(exchange);},
    cachedTradingFee:()=>nativeFees.get(exchange),
    validateOrder:async(request:OrderRequest)=>{assert.equal(request.reduceOnly,true);assert.notEqual(request.postOnly,true);},
    validateMakerReduction:async(request:OrderRequest)=>{assert.equal(request.reduceOnly,true);assert.equal(request.postOnly,true);},
    submitMakerReduction:async(request:OrderRequest,canSubmit?:()=>boolean):Promise<OrderResult>=>{
      assert.equal(request.reduceOnly,true);assert.equal(request.postOnly,true);assert.ok(nativeFees.has(exchange));
      if(canSubmit&&!canSubmit())return {id:'',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,
        averagePrice:0,feeUsd:0,rejectionCode:'MAKER_REDUCTION_PERMISSION_CHANGED',rejectionReason:'MEMORY final submission guard veto',timestamp:Date.now()};
      const id=`MEMORY-MAKER-${makerRequests.length+1}`;
      makers.set(request.clientOrderId,{request,exchange,id,filled:0,cancelled:false});
      makerRequests.push({exchange,request:{...request}});events.push(`maker-submit:${exchange}`);
      return {id,clientOrderId:request.clientOrderId,status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:NaN,timestamp:Date.now()};
    },
    inspectMakerReduction:async(request:OrderRequest,orderId?:string):Promise<MakerReductionObservation>=>{
      inspectedIds.push(orderId);const maker=makers.get(request.clientOrderId)!;assert.ok(maker);assert.equal(orderId,maker.id);
      const frame=await inspector(maker,++inspectCall),quantity=frame.quantity,activity=frame.activity??'active',price=frame.price??request.limitPrice;
      if(quantity>maker.filled){accountRow(exchange,request.base).quantity-=quantity-maker.filled;maker.filled=quantity;}
      events.push(`maker-read:${quantity}:${activity}`);
      return {activity,executionVerified:frame.verified!==false,observedAt:Date.now(),result:{id:maker.id,clientOrderId:request.clientOrderId,
        status:activity==='terminal'?(quantity===request.quantity?'filled':quantity?'partial':'cancelled'):'unknown',
        filledQuantity:quantity,averagePrice:quantity?price:0,averagePriceVerified:frame.averageVerified!==false,
        feeUsd:frame.feeUsd??quantity*price*.0002,timestamp:Date.now()}};
    },
    cancelMakerReduction:async(request:OrderRequest,id:string)=>{const maker=makers.get(request.clientOrderId)!;
      assert.equal(id,maker.id);maker.cancelled=true;cancelledIds.push(id);events.push('maker-cancel');},
    placeOrder:async(request:OrderRequest):Promise<OrderResult>=>{
      assert.equal(request.reduceOnly,true);assert.notEqual(request.postOnly,true);assert.ok(nativeFees.has(exchange));
      peerRequests.push({exchange,request:{...request}});events.push(`peer-ioc:${request.quantity}`);
      const fill=peerFill(request,peerRequests.length);
      if(fill==='unknown')return {id:`MEMORY-PEER-${peerRequests.length}`,clientOrderId:request.clientOrderId,status:'unknown',
        filledQuantity:0,averagePrice:0,feeUsd:NaN,timestamp:Date.now()};
      accountRow(exchange,request.base).quantity-=fill;afterPeer();
      return {id:`MEMORY-PEER-${peerRequests.length}`,clientOrderId:request.clientOrderId,
        status:fill===request.quantity?'filled':fill?'partial':'cancelled',filledQuantity:fill,averagePrice:fill?request.limitPrice:0,
        averagePriceVerified:true,feeUsd:fill*request.limitPrice*.0005,timestamp:Date.now()};
    },reconcileOrder:async()=>{throw new Error('Unexpected general reconciliation');},
    cancelOrder:async()=>{throw new Error('Unexpected general cancellation');},close:async()=>{}
  } as ExchangeAdapter));
  const createEngine=(permission=options.permission!==false)=>new Engine(store,permission,{adapterFactory:()=>adapters,liveEnvironment:{
    ALLOW_LIVE_TRADING:'true',LIVE_TRADING_ACK:'I_UNDERSTAND_THE_RISKS',GATE_API_KEY:'MEMORY',GATE_API_SECRET:'MEMORY',
    BYBIT_API_KEY:'MEMORY',BYBIT_API_SECRET:'MEMORY'}});
  const engine=createEngine();
  const p:Position={id:'maker-close-memory',base,mode:'live',entryPolicy:'aligned',holdMode:'adaptive',status:'open',openedAt:Date.now()-1000,
    plannedExitAt:Date.now()+3_610_000,profitExitNotionalUsd:100,
    long:{exchange:'gate',symbol,side:'long',quantity:100,entryPrice:1,markPrice:1,feesUsd:.05,liquidationDistancePct:null},
    short:{exchange:'bybit',symbol,side:'short',quantity:100,entryPrice:1,markPrice:1,feesUsd:.05,liquidationDistancePct:null},
    fundingUsd:0,feesUsd:.1,transferCostUsd:0,realizedSpreadPnlUsd:0,spreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[],
    profitExitPolicy:{firstFundingTime:Date.now()+3_600_000,earliestExitAt:Date.now()+3_610_000,minSpreadNetUsd:0,minCombinedNetUsd:0,
      fundingChecks:exchanges.map(exchange=>({exchange,timestamp:Date.now()+3_600_000}))}};
  // Constructed after the session: saved attention records are not implicitly adopted.
  store.data.positions.push(p);engine.snapshots=[...quotes.values()];
  const readAccounts=(target=engine)=>{for(const [exchange,account] of accounts){target.accounts.set(exchange,account);
    const health=target.health.find(value=>value.exchange===exchange)!;health.status='online';health.lastSuccess=Date.now();
    health.accountStatus='ready';health.accountUpdatedAt=Date.now();}};
  readAccounts();
  const publish=(changes:{long?:Partial<MarketSnapshot>;short?:Partial<MarketSnapshot>}={})=>{
    for(const [exchange,quote] of quotes)quotes.set(exchange,{...quote,timestamp:Date.now(),observedAt:Date.now(),fundingObservedAt:Date.now(),
      ...(exchange==='gate'?changes.long:changes.short)});engine.snapshots=[...quotes.values(),...additionalQuotes.values()];
  };
  const internal=engine as unknown as {exclusive<T>(fn:()=>Promise<T>):Promise<T>;managePositions(now:number):Promise<void>;
    managePosition(position:Position,now:number,realtimeProfitWake:boolean):Promise<void>};
  return {engine,store,p,quotes,accounts,nativeFees,feeReads,makerRequests,peerRequests,cancelledIds,inspectedIds,events,makers,adapters,logs,
    createEngine,readAccounts,publish,additionalQuotes,
    manage:()=>internal.exclusive(()=>internal.managePositions(Date.now())),exclusive:<T>(fn:()=>Promise<T>)=>internal.exclusive(fn),
    manageProfitWake:()=>internal.exclusive(()=>internal.managePosition(p,Date.now(),true)),
    inspect(fn:typeof inspector){inspector=fn;},fillPeer(fn:typeof peerFill){peerFill=fn;},afterPeer(fn:typeof afterPeer){afterPeer=fn;},
    stop:()=>engine.stop()};
}

/** Emit the native Bybit cancellation reason only after our original-ID cancellation and final GET. */
function controlledMakerCancellation(f:ReturnType<typeof fixture>,options:{exchange?:ExchangeId;quantity?:number;activeQuantity?:number;terminal?:Promise<Frame>}={}){
  const exchange=options.exchange??'bybit',adapter=f.adapters.find(value=>value.id===exchange)!;
  const inspected=adapter.inspectMakerReduction!,cancel=adapter.cancelMakerReduction!,cancelled=deferred<void>();
  adapter.cancelMakerReduction=async(request,id)=>{await cancel(request,id);cancelled.resolve();};
  adapter.inspectMakerReduction=async(request,id)=>{
    const observation=await inspected(request,id);
    if(id==='MEMORY-MAKER-1'&&observation.activity==='terminal'){
      observation.result.rejectionCode='EC_PerCancelRequest';
      observation.result.rejectionReason='MEMORY native original order canceled by our cancellation request';
    }
    return observation;
  };
  f.inspect((maker,call)=>{
    if(maker.id!=='MEMORY-MAKER-1')return {quantity:maker.request.quantity,activity:'terminal'};
    if(call===1){
      f.publish(exchange==='bybit'?{short:{bids:[{price:.992,quantity:30}]}}:{long:{asks:[{price:1.012,quantity:30}]}});
      return {quantity:options.activeQuantity??0,activity:'active'};
    }
    return options.terminal??{quantity:options.quantity??0,activity:'terminal'};
  });
  return cancelled.promise;
}

test('wider Gate long rests a post-only sell at ask; the first verified partial immediately hedges before Maker terminal',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.stop());
  f.inspect((_maker,call)=>({quantity:call===1?10:30,activity:call===1?'active':'terminal'}));
  await f.manage();await f.engine.execution.waitMakerClose(f.p);
  assert.equal(f.makerRequests.length,1);const maker=f.makerRequests[0];
  assert.equal(maker.exchange,'gate');assert.equal(maker.request.side,'sell');assert.equal(maker.request.limitPrice,1.016);
  assert.equal(maker.request.postOnly,true);assert.equal(maker.request.quantity,30);
  assert.deepEqual(f.peerRequests.map(value=>[value.exchange,value.request.side,value.request.quantity]),[['bybit','buy',10],['bybit','buy',20]]);
  assert.ok(f.events.indexOf('peer-ioc:10')<f.events.indexOf('maker-read:30:terminal'));
  assert.equal(f.p.long.quantity,70);assert.equal(f.p.short.quantity,70);assert.equal(f.cancelledIds.length,0);
  assert.equal(f.store.data.orders[0].makerReduction?.activity,'terminal');
});

test('rebated Maker partials use cumulative native cash once and remain resting for the original-ID first read',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.stop());
  f.engine.config.feeRebatePct={gate:70,bitget:50};
  for(const leg of [f.p.long,f.p.short]){const clientOrderId=`MEMORY-OPEN-${leg.exchange}`;
    f.store.data.orders.push({positionId:f.p.id,exchange:leg.exchange,createdAt:f.p.openedAt,request:{clientOrderId,base,symbol,
      side:leg.side==='long'?'buy':'sell',quantity:100,limitPrice:1,reduceOnly:false},result:{id:clientOrderId,clientOrderId,
        status:'filled',filledQuantity:100,averagePrice:1,averagePriceVerified:true,feeUsd:.05,timestamp:f.p.openedAt}});}
  f.inspect((_maker,call)=>({quantity:call===1?10:30,activity:call===1?'active':'terminal'}));
  await f.manage();await f.engine.execution.waitMakerClose(f.p);
  assert.equal(f.makerRequests.length,1);assert.equal(f.cancelledIds.length,0);
  assert.deepEqual(f.peerRequests.map(value=>value.request.quantity),[10,20]);
  assert.equal(f.p.long.quantity,70);assert.equal(f.p.short.quantity,70);
  const gross=.1+30*1.016*.0002+30*.0005;
  assert.ok(Math.abs(f.p.feesUsd-gross)<1e-12);
  const row=f.engine.state().positions.find(row=>row.id===f.p.id)!;
  assert.ok(Math.abs(row.estimatedFeeRebateUsd!-(.05+30*1.016*.0002)*.7)<1e-12);
  assert.equal(f.p.estimatedFeeRebateUsd,undefined);
  const record=f.store.data.orders.find(order=>order.request.postOnly)!.makerCloseComparison!;
  assert.deepEqual(record.feeRebatePct,{maker:70,peer:0});
  assert.ok(record.estimatedPairSavingAfterRebateUsd!<record.pairTotalSavingUsd!);
});

test('rebate pre-intent proof rejects a changed filled basis at the final native Maker guard',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.stop());
  f.engine.config.feeRebatePct={gate:70};
  const adapter=f.adapters.find(adapter=>adapter.id==='gate')!,submit=adapter.submitMakerReduction!;
  adapter.submitMakerReduction=async(request,canSubmit)=>{f.p.long.entryPrice=.9;return submit(request,canSubmit);};
  await f.manage();await f.engine.execution.waitMakerClose(f.p);
  assert.equal(f.makerRequests.length,0);assert.equal(f.peerRequests.length,0);
  assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);
});

test('wider Bybit short rests a post-only buy at bid and sells only confirmed Maker fills on Gate',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture({wide:'short'});t.after(()=>f.stop());
  f.inspect(()=>({quantity:30,activity:'terminal'}));
  await f.manage();await f.engine.execution.waitMakerClose(f.p);
  assert.equal(f.makerRequests.length,1);assert.equal(f.makerRequests[0].exchange,'bybit');
  assert.equal(f.makerRequests[0].request.side,'buy');assert.equal(f.makerRequests[0].request.limitPrice,.99);
  assert.deepEqual(f.peerRequests.map(value=>[value.exchange,value.request.side,value.request.quantity]),[['gate','sell',30]]);
  assert.equal(f.p.long.quantity,70);assert.equal(f.p.short.quantity,70);
});

test('verified cumulative Maker fills 10, 20, 20, 30 book cash once and hedge only new deltas',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.stop());
  const cumulative=[10,20,20,30];f.inspect((_maker,call)=>({quantity:cumulative[call-1],activity:call===4?'terminal':'active'}));
  await f.manage();await f.engine.execution.waitMakerClose(f.p);
  assert.deepEqual(f.peerRequests.map(value=>value.request.quantity),[10,10,10]);
  assert.equal(f.store.data.orders.length,4);assert.equal(f.p.long.quantity,70);assert.equal(f.p.short.quantity,70);
  assert.ok(Math.abs(f.p.feesUsd-(.1+30*1.016*.0002+30*.0005))<1e-12);
  assert.ok(Math.abs(f.p.realizedSpreadPnlUsd-30*.016)<1e-12);
  assert.equal(f.store.data.orders[0].result?.filledQuantity,30);assert.equal(f.store.data.orders[0].result?.status,'filled');
  assert.equal(f.makerRequests.length,1);assert.equal(f.cancelledIds.length,0);
  const maker=f.store.data.orders[0],comparison=maker.makerCloseComparison!;assert.ok(comparison);
  assert.equal(comparison.benchmark,'submission-opposite-1');assert.equal(comparison.longOppositePrice,1.006);
  assert.equal(comparison.shortOppositePrice,1);assert.equal(comparison.originalOneLegNotionalUsd,100);
  assert.equal(comparison.status,'paired');assert.equal(comparison.pairedQuantity,30);assert.equal(comparison.peerOrderCount,3);
  assert.ok(f.store.data.orders.slice(1).every(order=>order.executionEvidence?.makerCloseParentClientId===maker.request.clientOrderId));
  assert.ok(Math.abs(comparison.makerPriceSavingUsd!-.3)<1e-12);
  assert.ok(Math.abs(comparison.makerBenchmarkFeeUsd!-30*1.006*.0005)<1e-12);
  assert.ok(Math.abs(comparison.makerActualFeeUsd!-30*1.016*.0002)<1e-12);
  assert.ok(Math.abs(comparison.makerFeeSavingUsd!-.008994)<1e-12);
  assert.ok(Math.abs(comparison.pairTotalSavingUsd!-.308994)<1e-12);assert.equal(comparison.peerPriceSavingUsd,0);
  const feesBefore=f.feeReads.length,ledgerBefore=JSON.stringify(f.store.data.orders);f.publish({long:{bids:[{price:1.012,quantity:30}]}});
  const report=makerCloseComparisonReport(f.store.data.orders);
  assert.deepEqual(report.counts,{total:1,confirmedPaired:1,pending:0,zeroFill:0,rebateEstimatedPaired:1,rebateUnknownPaired:0});
  assert.ok(Math.abs(report.totals.pairTotalSavingUsd!-.308994)<1e-12);
  assert.equal(JSON.stringify(f.store.data.orders),ledgerBefore);assert.equal(f.feeReads.length,feesBefore);
});

test('verified Maker fill 1 normalizes Gate native 44.50000000000001 lots and hedges exactly 1 on Bybit',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture({topQuantity:1});t.after(()=>f.stop());
  f.p.long.quantity=44.50000000000001;f.p.short.quantity=44.5;
  f.accounts.get('gate')!.positions[0].quantity=f.p.long.quantity;f.accounts.get('bybit')!.positions[0].quantity=f.p.short.quantity;
  f.publish({long:{quantityStep:.1,minQuantity:.1,contractSize:.1},short:{quantityStep:.1,minQuantity:.1}});
  f.inspect(()=>({quantity:1,activity:'terminal'}));
  await f.manage();await f.engine.execution.waitMakerClose(f.p);
  assert.equal(f.makerRequests.length,1);assert.equal(f.makerRequests[0].request.quantity,1);
  assert.deepEqual(f.peerRequests.map(value=>[value.exchange,value.request.quantity]),[['bybit',1]]);
  assert.equal(f.p.long.quantity,43.5);assert.equal(f.p.short.quantity,43.5);assert.notEqual(f.p.status,'attention');
  assert.equal(f.store.data.orders[0].makerReduction?.quantityStep,.1);
  assert.equal(f.store.data.orders[0].result?.filledQuantity,1);assert.equal(f.store.data.orders[1].result?.filledQuantity,1);
  assert.equal(f.store.data.orders[0].makerCloseComparison?.pairedQuantity,1);
});

test('verified active cumulative Maker fills 1 then 1.1 hedge exactly 1 then the legal 0.1 boundary without inflating cash',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture({topQuantity:1.1});t.after(()=>f.stop());
  f.p.long.quantity=44.50000000000001;f.p.short.quantity=44.5;
  f.accounts.get('gate')!.positions[0].quantity=f.p.long.quantity;f.accounts.get('bybit')!.positions[0].quantity=f.p.short.quantity;
  f.publish({long:{quantityStep:.1,minQuantity:.1,contractSize:.1},short:{quantityStep:.1,minQuantity:.1}});
  f.inspect((_maker,call)=>({quantity:call===1?1:1.1,activity:call===1?'active':'terminal'}));
  await f.manage();await f.engine.execution.waitMakerClose(f.p);
  assert.equal(f.makerRequests.length,1);assert.deepEqual(f.peerRequests.map(value=>value.request.quantity),[1,.1]);
  assert.ok(f.events.indexOf('peer-ioc:1')<f.events.indexOf('maker-read:1.1:terminal'));
  assert.equal(f.p.long.quantity,43.4);assert.equal(f.p.short.quantity,43.4);assert.notEqual(f.p.status,'attention');
  assert.ok(Math.abs(f.p.feesUsd-(.1+1.1*1.016*.0002+1.1*.0005))<1e-12);
  assert.ok(Math.abs(f.p.realizedSpreadPnlUsd-1.1*.016)<1e-12);
  assert.equal(f.store.data.orders[0].result?.filledQuantity,1.1);
  assert.equal(f.store.data.orders[0].makerCloseComparison?.pairedQuantity,1.1);
});

test('a real off-grid Maker fill remains exact cash and exposure evidence and never rounds the peer hedge up',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture({topQuantity:1});t.after(()=>f.stop());
  f.p.long.quantity=44.50000000000001;f.p.short.quantity=44.5;
  f.accounts.get('gate')!.positions[0].quantity=f.p.long.quantity;f.accounts.get('bybit')!.positions[0].quantity=f.p.short.quantity;
  f.publish({long:{quantityStep:.1,minQuantity:.1,contractSize:.1},short:{quantityStep:.1,minQuantity:.1}});
  f.inspect((_maker,call)=>({quantity:.95,activity:call===1?'active':'terminal'}));
  await f.manage();await f.engine.execution.waitMakerClose(f.p);
  assert.equal(f.makerRequests.length,1);assert.deepEqual(f.peerRequests.map(value=>value.request.quantity),[.9]);
  assert.ok(f.peerRequests.reduce((quantity,value)=>quantity+value.request.quantity,0)<=.95);assert.equal(f.cancelledIds.length,1);
  assert.equal(f.store.data.orders[0].result?.filledQuantity,.95);
  assert.equal(f.p.long.quantity,43.55000000000001);assert.equal(f.p.short.quantity,43.6);assert.equal(f.p.status,'attention');
  assert.ok(Math.abs(f.p.feesUsd-(.1+.95*1.016*.0002+.9*.0005))<1e-12);
  assert.ok(Math.abs(f.p.realizedSpreadPnlUsd-.95*.016)<1e-12);
  assert.ok(f.p.short.quantity-f.p.long.quantity>0&&f.p.short.quantity-f.p.long.quantity<.1);
  assert.match(f.store.data.orders[0].makerReduction?.stopReason??'',/合法减仓量|尾差|合法/);
  await f.manage();assert.equal(f.makerRequests.length,1);assert.equal(f.peerRequests.length,1);
});

test('fine Maker partials accumulate under the original active order and hedge only complete coarser peer lots',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture({topQuantity:2});t.after(()=>f.stop());
  f.publish({long:{quantityStep:.1,minQuantity:.1,contractSize:.1},short:{quantityStep:1,minQuantity:1}});
  const cumulative=[.1,.9,1,1.9,2];f.inspect((_maker,call)=>({quantity:cumulative[call-1],activity:call===5?'terminal':'active'}));
  await f.manageProfitWake();await f.engine.execution.waitMakerClose(f.p);
  assert.equal(f.makerRequests.length,1);assert.equal(f.makerRequests[0].request.quantity,2);
  assert.deepEqual(f.peerRequests.map(value=>value.request.quantity),[1,1]);assert.equal(f.cancelledIds.length,0);
  assert.ok(f.events.indexOf('peer-ioc:1')>f.events.indexOf('maker-read:1:active'));
  assert.ok(f.events.indexOf('peer-ioc:1')<f.events.indexOf('maker-read:1.9:active'));
  assert.equal(f.p.long.quantity,98);assert.equal(f.p.short.quantity,98);assert.notEqual(f.p.status,'attention');
  assert.ok(Math.abs(f.p.feesUsd-(.1+2*1.016*.0002+2*.0005))<1e-12);
  assert.equal(f.store.data.orders[0].makerCloseComparison?.pairedQuantity,2);
});

test('fine Maker carry 0.1 plus remaining 0.2 fits the exact coarser peer capacity 0.3 without an arithmetic false cancel',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture({topQuantity:.3});t.after(()=>f.stop());
  f.p.long.quantity=f.p.short.quantity=99.9;
  for(const account of f.accounts.values())account.positions[0].quantity=99.9;
  f.publish({long:{quantityStep:.1,minQuantity:.1,contractSize:.1},short:{quantityStep:.3,minQuantity:.3}});
  f.inspect((_maker,call)=>({quantity:call===1?.1:.3,activity:call===1?'active':'terminal'}));
  await f.manageProfitWake();await f.engine.execution.waitMakerClose(f.p);
  assert.equal(f.makerRequests.length,1);assert.equal(f.makerRequests[0].request.quantity,.3);assert.equal(f.cancelledIds.length,0);
  assert.deepEqual(f.peerRequests.map(value=>value.request.quantity),[.3]);
  assert.ok(f.events.indexOf('peer-ioc:0.3')>f.events.indexOf('maker-read:0.3:terminal'));
  assert.equal(f.p.long.quantity,99.6);assert.equal(f.p.short.quantity,99.6);assert.notEqual(f.p.status,'attention');
  assert.equal(f.store.data.orders[0].result?.filledQuantity,.3);assert.equal(f.store.data.orders[0].makerCloseComparison?.pairedQuantity,.3);
  assert.ok(Math.abs(f.p.feesUsd-(.1+.3*1.016*.0002+.3*.0005))<1e-12);
});

test('the first verified fine Maker cumulative fill 1.9 immediately hedges its legal peer lot 1 and keeps only the confirmed fractional tail',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture({topQuantity:2});t.after(()=>f.stop());
  f.publish({long:{quantityStep:.1,minQuantity:.1,contractSize:.1},short:{quantityStep:1,minQuantity:1}});
  f.inspect((_maker,call)=>({quantity:call===1?1.9:2,activity:call===1?'active':'terminal'}));
  await f.manageProfitWake();await f.engine.execution.waitMakerClose(f.p);
  assert.deepEqual(f.peerRequests.map(value=>value.request.quantity),[1,1]);
  assert.ok(f.events.indexOf('peer-ioc:1')<f.events.indexOf('maker-read:2:terminal'));
  assert.equal(f.cancelledIds.length,0);assert.equal(f.p.long.quantity,98);assert.equal(f.p.short.quantity,98);
  assert.notEqual(f.p.status,'attention');assert.equal(f.makerRequests.length,1);
});

test('terminal fine Maker fill 0.9 remains visible and cannot authorize an unfilled coarser peer lot 1',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture({topQuantity:2});t.after(()=>f.stop());
  f.publish({long:{quantityStep:.1,minQuantity:.1,contractSize:.1},short:{quantityStep:1,minQuantity:1}});
  f.inspect(()=>({quantity:.9,activity:'terminal'}));
  await f.manageProfitWake();await f.engine.execution.waitMakerClose(f.p);
  assert.equal(f.makerRequests.length,1);assert.equal(f.peerRequests.length,0);
  assert.equal(f.store.data.orders[0].result?.filledQuantity,.9);assert.equal(f.store.data.orders[0].makerReduction?.activity,'terminal');
  assert.equal(f.p.long.quantity,99.1);assert.equal(f.p.short.quantity,100);assert.equal(f.p.status,'attention');
  assert.equal(f.engine.execution.hasPendingMakerCloseTail(f.p),false);
  assert.ok(Math.abs(f.p.feesUsd-(.1+.9*1.016*.0002))<1e-12);
  await f.manageProfitWake();assert.equal(f.makerRequests.length,1);assert.equal(f.peerRequests.length,0);
});

test('an active fine Maker fractional tail loses resting permission when IOC profit, native fee evidence or trading permission changes',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  for(const changed of ['profit','fees','permission'] as const){
    const f=fixture({topQuantity:2});t.after(()=>f.stop());
    f.publish({long:{quantityStep:.1,minQuantity:.1,contractSize:.1},short:{quantityStep:1,minQuantity:1}});
    f.inspect((_maker,call)=>{
      if(call===1){
        if(changed==='profit')f.publish({short:{asks:[{price:1.008,quantity:2}]}});
        else if(changed==='fees')f.nativeFees.delete('bybit');
        else f.store.data.killSwitch=true;
        return {quantity:.1,activity:'active'};
      }
      return {quantity:.9,activity:'terminal'};
    });
    await f.manageProfitWake();await f.engine.execution.waitMakerClose(f.p);
    assert.equal(f.makerRequests.length,1);assert.deepEqual(f.cancelledIds,['MEMORY-MAKER-1']);assert.equal(f.peerRequests.length,0);
    assert.equal(f.store.data.orders[0].result?.filledQuantity,.9);assert.equal(f.store.data.orders[0].makerReduction?.activity,'terminal');
    assert.equal(f.p.long.quantity,99.1);assert.equal(f.p.short.quantity,100);assert.equal(f.p.status,'attention');
    assert.ok(Math.abs(f.p.feesUsd-(.1+.9*1.016*.0002))<1e-12);
    await f.manageProfitWake();assert.equal(f.makerRequests.length,1);assert.equal(f.peerRequests.length,0);
  }
});

test('a Maker execution batch stays within both original opposite-1 quantities while its own passive visible quantity is irrelevant',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture({topQuantity:100});t.after(()=>f.stop());
  f.publish({long:{bids:[{price:1.006,quantity:20}],asks:[{price:1.016,quantity:1}]}});
  f.inspect(maker=>({quantity:maker.request.quantity,activity:'terminal'}));
  await f.manage();await f.engine.execution.waitMakerClose(f.p);
  assert.equal(f.makerRequests.length,1);assert.equal(f.makerRequests[0].request.quantity,20);
  assert.deepEqual(f.peerRequests.map(value=>value.request.quantity),[20]);assert.equal(f.p.long.quantity,80);assert.equal(f.p.short.quantity,80);
  assert.equal(f.store.data.orders[0].makerCloseComparison?.pairedQuantity,20);
});

test('original opposite-1 capacity shrinking from 20 to 15 after intent persistence blocks the unchanged Maker POST',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture({topQuantity:100});t.after(()=>f.stop());
  f.publish({long:{bids:[{price:1.006,quantity:20}]}});let changed=false;
  f.store.save=()=>{const order=f.store.data.orders[0];
    if(!changed&&order?.makerReduction&&order.executionEvidence?.submittedAt===undefined){
      changed=true;f.publish({long:{bids:[{price:1.006,quantity:15}]}});
    }
  };
  await f.manage();await f.engine.execution.waitMakerClose(f.p);
  assert.equal(changed,true);assert.equal(f.store.data.orders[0].request.quantity,20);
  assert.equal(f.makerRequests.length,0);assert.equal(f.peerRequests.length,0);assert.equal(f.cancelledIds.length,0);
  assert.equal(f.store.data.orders[0].result?.status,'cancelled');assert.equal(f.store.data.orders[0].result?.filledQuantity,0);
  assert.equal(f.store.data.orders[0].executionEvidence?.submittedAt,undefined);
  assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);assert.equal(f.p.feesUsd,.1);
});

test('a local prepared-order exception after durable intent but before native POST produces known zero terminal without unknown-order attention',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.stop());let changed=false;
  f.store.save=()=>{
    const order=f.store.data.orders[0];
    if(!changed&&order?.makerReduction&&order.executionEvidence?.submittedAt===undefined){
      changed=true;f.publish({long:{contractSize:10}});
    }
  };
  await f.manage();await f.engine.execution.waitMakerClose(f.p);
  assert.equal(changed,true);assert.equal(f.store.data.orders.length,1);
  const order=f.store.data.orders[0];assert.equal(order.result?.status,'cancelled');assert.equal(order.result?.filledQuantity,0);
  assert.equal(order.makerReduction?.activity,'terminal');assert.equal(order.executionEvidence?.submittedAt,undefined);
  assert.equal(order.result?.feeUsd,0);assert.notEqual(f.p.status,'attention');assert.equal(f.store.data.killSwitch,false);
  assert.equal(f.makerRequests.length,0);assert.equal(f.peerRequests.length,0);assert.equal(f.inspectedIds.length,0);assert.equal(f.cancelledIds.length,0);
  assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);assert.equal(f.p.feesUsd,.1);assert.equal(f.p.realizedSpreadPnlUsd,0);
});

test('a moved passive quote cancels the original Maker and only a trusted terminal permits a fresh client ID at the new price',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();
  const cancelled=deferred<void>(),releaseTerminal=deferred<Frame>();
  t.after(async()=>{releaseTerminal.resolve({quantity:0,activity:'terminal'});await f.stop();});
  const gate=f.adapters.find(adapter=>adapter.id==='gate')!,cancel=gate.cancelMakerReduction!;
  gate.cancelMakerReduction=async(request,id)=>{await cancel(request,id);cancelled.resolve();};
  f.inspect((maker,call)=>{
    if(maker.id==='MEMORY-MAKER-1'){
      if(call===1){f.publish({long:{asks:[{price:1.012,quantity:30}]}});return {quantity:0,activity:'active'};}
      return releaseTerminal.promise;
    }
    return {quantity:maker.request.quantity,activity:'terminal'};
  });
  await f.manage();await bounded(cancelled.promise,'moving quote did not cancel original Maker',1500);
  const first=f.store.data.orders[0],originalClientId=first.request.clientOrderId;
  assert.equal(first.makerReduction?.activity,'active');assert.deepEqual(f.cancelledIds,['MEMORY-MAKER-1']);
  await f.manageProfitWake();assert.equal(f.makerRequests.length,1);assert.equal(f.peerRequests.length,0);
  releaseTerminal.resolve({quantity:0,activity:'terminal'});await f.engine.execution.waitMakerClose(f.p);
  assert.equal(first.makerReduction?.activity,'terminal');assert.match(first.makerReduction?.stopReason??'',/最优挂单价已移动/);
  t.mock.timers.setTime(NOW+1);f.publish();await f.manageProfitWake();await f.engine.execution.waitMakerClose(f.p);
  assert.equal(f.makerRequests.length,2);assert.notEqual(f.makerRequests[1].request.clientOrderId,originalClientId);
  assert.equal(f.makerRequests[1].request.limitPrice,1.012);
  assert.equal(f.store.data.orders[1].makerReduction?.previousClientOrderId,originalClientId);
  assert.deepEqual(f.peerRequests.map(value=>value.request.quantity),[30]);
  assert.equal(f.store.data.orders[2].executionEvidence?.makerCloseParentClientId,f.makerRequests[1].request.clientOrderId);
  assert.equal(f.p.long.quantity,70);assert.equal(f.p.short.quantity,70);assert.notEqual(f.p.status,'attention');
});

test('our original Bybit Maker zero-fill cancellation permits a new Maker only after verified terminal and preserves the native cancellation receipt',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture({wide:'short'}),terminal=deferred<Frame>();
  t.after(async()=>{terminal.resolve({quantity:0,activity:'terminal'});await f.stop();});
  const cancelled=controlledMakerCancellation(f,{terminal:terminal.promise});
  await f.manageProfitWake();await bounded(cancelled,'Bybit moved quote did not cancel the original Maker',1500);
  const original=f.store.data.orders[0],client=original.request.clientOrderId;
  assert.equal(original.makerReduction?.activity,'active');assert.equal(original.makerReduction?.cancelRequestedAt,NOW);
  await f.manageProfitWake();assert.equal(f.makerRequests.length,1);assert.equal(f.peerRequests.length,0);
  terminal.resolve({quantity:0,activity:'terminal'});await f.engine.execution.waitMakerClose(f.p);
  assert.equal(original.result?.rejectionCode,'EC_PerCancelRequest');assert.equal(original.result?.status,'cancelled');
  assert.equal(original.result?.filledQuantity,0);assert.equal(original.result?.averagePrice,0);assert.equal(original.result?.feeUsd,0);
  assert.equal(original.makerReduction?.activity,'terminal');assert.equal(original.makerReduction?.bookedExecution,true);
  assert.equal(original.executionEvidence?.bookedFeeUsd,0);assert.notEqual(f.p.status,'attention');
  const receipt=structuredClone(original.result),request=structuredClone(original.request);
  t.mock.timers.setTime(NOW+1);f.publish();await f.manageProfitWake();await f.engine.execution.waitMakerClose(f.p);
  assert.equal(f.makerRequests.length,2);assert.notEqual(f.makerRequests[1].request.clientOrderId,client);
  assert.equal(f.makerRequests[1].exchange,'bybit');assert.equal(f.makerRequests[1].request.limitPrice,.992);
  assert.ok(f.makerRequests.every(value=>value.request.postOnly===true));
  assert.equal(f.store.data.orders[1].makerReduction?.previousClientOrderId,client);
  assert.deepEqual(original.request,request);assert.deepEqual(original.result,receipt);
  assert.deepEqual(f.peerRequests.map(value=>[value.exchange,value.request.quantity]),[['gate',30]]);
  assert.equal(f.store.data.orders[2].executionEvidence?.makerCloseParentClientId,f.makerRequests[1].request.clientOrderId);
  assert.equal(f.p.long.quantity,70);assert.equal(f.p.short.quantity,70);assert.notEqual(f.p.status,'attention');
});

test('our verified partial Bybit Maker cancellation hedges the exact active fill immediately and permits a fresh Maker only after terminal cash',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture({wide:'short'}),terminal=deferred<Frame>();
  t.after(async()=>{terminal.resolve({quantity:10,activity:'terminal'});await f.stop();});
  const cancelled=controlledMakerCancellation(f,{activeQuantity:10,terminal:terminal.promise});
  await f.manageProfitWake();await bounded(cancelled,'partially filled Bybit Maker did not cancel the original ID',1500);
  const original=f.store.data.orders[0],client=original.request.clientOrderId;
  assert.equal(original.makerReduction?.activity,'active');assert.equal(original.result?.filledQuantity,10);
  assert.deepEqual(f.peerRequests.map(value=>[value.exchange,value.request.quantity]),[['gate',10]]);
  assert.ok(f.events.indexOf('peer-ioc:10')<f.events.indexOf('maker-cancel'));
  assert.equal(f.p.long.quantity,90);assert.equal(f.p.short.quantity,90);
  await f.manageProfitWake();assert.equal(f.makerRequests.length,1);assert.equal(f.peerRequests.length,1);
  terminal.resolve({quantity:10,activity:'terminal'});await f.engine.execution.waitMakerClose(f.p);
  assert.equal(original.result?.status,'partial');assert.equal(original.result?.rejectionCode,'EC_PerCancelRequest');
  assert.equal(original.result?.averagePrice,.99);assert.equal(original.result?.averagePriceVerified,true);
  assert.equal(original.result?.feeUsd,10*.99*.0002);assert.equal(original.executionEvidence?.bookedFeeUsd,original.result?.feeUsd);
  assert.equal(original.makerReduction?.bookedExecution,true);assert.equal(original.makerReduction?.activity,'terminal');
  assert.equal(original.makerCloseComparison?.pairedQuantity,10);assert.equal(original.makerCloseComparison?.status,'paired');
  assert.notEqual(f.p.status,'attention');const receipt=structuredClone(original.result),request=structuredClone(original.request);
  t.mock.timers.setTime(NOW+1);f.publish();await f.manageProfitWake();await f.engine.execution.waitMakerClose(f.p);
  assert.equal(f.makerRequests.length,2);const next=f.store.data.orders.find(order=>order.makerReduction&&order!==original)!;
  assert.notEqual(next.request.clientOrderId,client);assert.equal(next.request.postOnly,true);assert.equal(next.request.limitPrice,.992);
  assert.equal(next.makerReduction?.previousClientOrderId,client);
  assert.deepEqual(f.peerRequests.map(value=>[value.exchange,value.request.quantity]),[['gate',10],['gate',30]]);
  assert.deepEqual(f.store.data.orders.filter(order=>order.executionEvidence?.makerCloseParentClientId===client).map(order=>order.result?.filledQuantity),[10]);
  assert.deepEqual(f.store.data.orders.filter(order=>order.executionEvidence?.makerCloseParentClientId===next.request.clientOrderId).map(order=>order.result?.filledQuantity),[30]);
  assert.deepEqual(original.result,receipt);assert.deepEqual(original.request,request);
  assert.equal(f.p.long.quantity,60);assert.equal(f.p.short.quantity,60);assert.notEqual(f.p.status,'attention');
  assert.ok(Math.abs(f.p.feesUsd-(.1+10*.99*.0002+30*.992*.0002+40*1.006*.0005))<1e-12);
  assert.ok(Math.abs(f.p.realizedSpreadPnlUsd-(10*(1.006-.99)+30*(1.006-.992)))<1e-12);
});

for(const variant of ['missing-cancel-marker','future-cancel-marker','unknown-original','unbooked-positive-fill','unverified-positive-fill','other-hard-reason','ordinary-ioc','other-venue'] as const){
  test(`a Bybit cancellation reason with ${variant} cannot grant a new Maker or common IOC reduction`,async t=>{
    t.mock.timers.enable({apis:['Date'],now:NOW});
    const f=fixture({wide:variant==='other-venue'?'long':'short'});t.after(()=>f.stop());
    const positive=variant==='unbooked-positive-fill'||variant==='unverified-positive-fill';
    controlledMakerCancellation(f,{exchange:variant==='other-venue'?'gate':'bybit',quantity:positive?10:0});
    await f.manageProfitWake();await f.engine.execution.waitMakerClose(f.p);
    const original=f.store.data.orders[0];assert.equal(original.result?.rejectionCode,'EC_PerCancelRequest');
    assert.equal(f.cancelledIds.length,1);assert.equal(f.makerRequests.length,1);
    if(variant==='missing-cancel-marker')delete original.makerReduction!.cancelRequestedAt;
    if(variant==='future-cancel-marker')original.makerReduction!.cancelRequestedAt=NOW+5000;
    if(variant==='unknown-original'){
      original.result!.status='unknown';original.result!.feeUsd=NaN;original.makerReduction!.activity='unknown';
      // The original native GET remains uncertain; a later verified terminal would legitimately remove this blocker.
      f.adapters.find(adapter=>adapter.id==='bybit')!.inspectMakerReduction=async()=>({activity:'unknown',executionVerified:false,
        observedAt:Date.now(),result:{...original.result!,timestamp:Date.now()}});
    }
    if(variant==='unbooked-positive-fill')delete original.executionEvidence!.bookedFeeUsd;
    if(variant==='unverified-positive-fill'){
      original.result!.averagePriceVerified=false;
      f.adapters.find(adapter=>adapter.id==='bybit')!.inspectMakerReduction=async()=>({activity:'terminal',executionVerified:false,
        observedAt:Date.now(),result:{...original.result!,timestamp:Date.now()}});
    }
    if(variant==='other-hard-reason')original.result!.rejectionCode='EC_InvalidSymbol';
    if(variant==='ordinary-ioc'){original.request.postOnly=false;original.executionEvidence!.method='ioc';}
    const ledgerBefore=JSON.stringify(f.store.data.orders),peersBefore=f.peerRequests.length;
    const quantityBefore=[f.p.long.quantity,f.p.short.quantity],feesBefore=f.p.feesUsd;
    t.mock.timers.setTime(NOW+1);f.publish();await f.manageProfitWake();await f.engine.execution.waitMakerClose(f.p);
    assert.equal(f.makerRequests.length,1);assert.equal(f.peerRequests.length,peersBefore);
    if(variant==='unknown-original'||variant==='unverified-positive-fill'){
      assert.equal(f.store.data.orders.length,1+peersBefore);
      if(variant==='unknown-original')assert.equal(original.result?.status,'unknown');
      else assert.equal(original.result?.averagePriceVerified,false);
      assert.equal(original.result?.id,'MEMORY-MAKER-1');assert.equal(original.request.clientOrderId,f.makerRequests[0].request.clientOrderId);
    }else assert.equal(JSON.stringify(f.store.data.orders),ledgerBefore);
    assert.deepEqual([f.p.long.quantity,f.p.short.quantity],quantityBefore);assert.equal(f.p.feesUsd,feesBefore);
    if(positive){
      assert.deepEqual(f.peerRequests.map(value=>value.request.quantity),[10]);
      assert.equal(original.result?.filledQuantity,10);assert.equal(f.p.long.quantity,90);assert.equal(f.p.short.quantity,90);
    }else assert.equal(peersBefore,0);
  });
}

test('three terminal zero fills impose only a 500ms Maker retry cooldown and never switch the wider leg to a common IOC exit',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.stop());
  f.inspect(()=>({quantity:0,activity:'terminal'}));
  for(let attempt=0;attempt<3;attempt++){
    t.mock.timers.setTime(NOW+attempt);f.publish();f.readAccounts();await f.manageProfitWake();await f.engine.execution.waitMakerClose(f.p);
    assert.equal(f.makerRequests.length,attempt+1);assert.equal(f.peerRequests.length,0);
  }
  assert.equal(f.engine.execution.makerCloseRetryAfter(f.p),NOW+502);
  const journals=f.store.data.orders;assert.ok(journals.every(order=>order.makerReduction?.activity==='terminal'));
  assert.equal(new Set(f.makerRequests.map(value=>value.request.clientOrderId)).size,3);
  assert.deepEqual(journals.map(order=>order.makerReduction?.attempt),[1,2,3]);
  assert.equal(journals[1].makerReduction?.previousClientOrderId,journals[0].request.clientOrderId);
  assert.equal(journals[2].makerReduction?.previousClientOrderId,journals[1].request.clientOrderId);
  t.mock.timers.setTime(NOW+501);f.publish();f.readAccounts();await f.manageProfitWake();assert.equal(f.makerRequests.length,3);
  assert.equal(f.peerRequests.length,0);assert.equal(f.store.data.orders.length,3);
  t.mock.timers.setTime(NOW+502);f.publish();f.readAccounts();await f.manageProfitWake();await f.engine.execution.waitMakerClose(f.p);
  assert.equal(f.makerRequests.length,4);assert.equal(f.peerRequests.length,0);
  // An old eight-second chase budget must not silently turn a later eligible wake into IOC.
  t.mock.timers.setTime(NOW+8002);f.publish();f.readAccounts();await f.manageProfitWake();await f.engine.execution.waitMakerClose(f.p);
  assert.equal(f.makerRequests.length,5);assert.equal(f.peerRequests.length,0);
  assert.ok(f.makerRequests.every(value=>value.request.postOnly===true));
  assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);assert.notEqual(f.p.status,'attention');
});

test('a new config or closing intent clears the previous Maker cooldown and starts a new bounded cycle without IOC',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  for(const reset of ['config','intent'] as const){
    t.mock.timers.setTime(NOW);const f=fixture();t.after(()=>f.stop());f.inspect(()=>({quantity:0,activity:'terminal'}));
    for(let attempt=0;attempt<3;attempt++){
      t.mock.timers.setTime(NOW+attempt);f.publish();f.readAccounts();await f.manageProfitWake();await f.engine.execution.waitMakerClose(f.p);
    }
    assert.equal(f.engine.execution.makerCloseRetryAfter(f.p),NOW+502);
    const previousCycle=f.store.data.orders[0].makerReduction?.cycleId;
    if(reset==='config')f.store.data.config={...f.store.data.config};
    else f.p.closeRequestedAt=NOW+3;
    assert.equal(f.engine.execution.makerCloseRetryAfter(f.p),0);
    t.mock.timers.setTime(NOW+3);f.publish();f.readAccounts();await f.manageProfitWake();await f.engine.execution.waitMakerClose(f.p);
    assert.equal(f.makerRequests.length,4);assert.equal(f.peerRequests.length,0);
    const order=f.store.data.orders[3];assert.notEqual(order.makerReduction?.cycleId,previousCycle);
    assert.equal(order.makerReduction?.attempt,1);assert.equal(order.makerReduction?.previousClientOrderId,undefined);
    assert.notEqual(f.p.status,'attention');
  }
});

test('a confirmed paired Maker reduction resets the consecutive zero counter before the next Maker attempts',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.stop());
  f.inspect(maker=>({quantity:maker.id==='MEMORY-MAKER-3'?30:0,activity:'terminal'}));
  for(let attempt=0;attempt<6;attempt++){
    t.mock.timers.setTime(NOW+attempt);f.publish();f.readAccounts();await f.manageProfitWake();await f.engine.execution.waitMakerClose(f.p);
    assert.equal(f.makerRequests.length,attempt+1);
    assert.equal(f.engine.execution.makerCloseRetryAfter(f.p),attempt<5?0:NOW+505);
  }
  assert.deepEqual(f.peerRequests.map(value=>value.request.quantity),[30]);
  assert.equal(f.p.long.quantity,70);assert.equal(f.p.short.quantity,70);assert.notEqual(f.p.status,'attention');
  assert.ok(f.store.data.orders.filter(order=>order.makerReduction).every(order=>order.makerReduction?.activity==='terminal'));
});

test('a local prepared-order exception in the native final permit vetoes POST instead of creating an unknown original',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.stop());
  const gate=f.adapters.find(adapter=>adapter.id==='gate')!;let permit:boolean|undefined;
  gate.submitMakerReduction=async(request,canSubmit)=>{
    await gate.fetchAccount();f.publish({long:{contractSize:10}});permit=canSubmit!();
    return {id:'',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,
      rejectionCode:'MAKER_REDUCTION_PERMISSION_CHANGED',rejectionReason:'MEMORY native permit caught local prepared-order exception',timestamp:Date.now()};
  };
  await f.manageProfitWake();await f.engine.execution.waitMakerClose(f.p);
  assert.equal(permit,false);assert.equal(f.makerRequests.length,0);assert.equal(f.peerRequests.length,0);
  assert.equal(f.inspectedIds.length,0);assert.equal(f.cancelledIds.length,0);assert.equal(f.store.data.orders.length,1);
  const order=f.store.data.orders[0];assert.equal(order.result?.status,'cancelled');assert.equal(order.result?.id,'');
  assert.equal(order.result?.filledQuantity,0);assert.equal(order.makerReduction?.activity,'terminal');
  assert.ok(order.makerReduction?.localVetoReason);assert.equal(order.executionEvidence?.submittedAt,undefined);
  assert.notEqual(f.p.status,'attention');assert.equal(f.store.data.killSwitch,false);
  assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);assert.equal(f.p.feesUsd,.1);
});

test('the native final-submit permit vetoes an IOC profit loss after native preflight even while the Maker quote stays profitable',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.stop());
  const gate=f.adapters.find(adapter=>adapter.id==='gate')!;let permit:boolean|undefined;
  gate.submitMakerReduction=async(request,canSubmit)=>{
    assert.equal(typeof canSubmit,'function');await gate.fetchAccount();f.events.push('native-preflight-get');
    f.publish({long:{bids:[{price:1.001,quantity:30}]}});
    // The unchanged passive sell 1.016 is still profitable; opposite-1 sell 1.001 fails the trigger.
    permit=canSubmit!();assert.equal(permit,false);
    return {id:'',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,
      rejectionCode:'MAKER_REDUCTION_PERMISSION_CHANGED',rejectionReason:'MEMORY final native preflight rejected changed IOC profit',timestamp:Date.now()};
  };
  await f.manage();await f.engine.execution.waitMakerClose(f.p);
  assert.equal(permit,false);assert.ok(f.events.includes('native-preflight-get'));
  assert.equal(f.makerRequests.length,0);assert.equal(f.peerRequests.length,0);assert.equal(f.cancelledIds.length,0);assert.equal(f.inspectedIds.length,0);
  const order=f.store.data.orders[0];assert.equal(order.result?.status,'cancelled');assert.equal(order.result?.id,'');
  assert.equal(order.result?.rejectionCode,'MAKER_REDUCTION_PERMISSION_CHANGED');assert.equal(order.makerReduction?.activity,'terminal');
  assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);assert.equal(f.p.feesUsd,.1);assert.equal(f.p.realizedSpreadPnlUsd,0);
});

test('the native final-submit permit refreezes the freshest opposite-1 prices and actual Taker fees for the confirmed comparison',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.stop());
  const gate=f.adapters.find(adapter=>adapter.id==='gate')!,submit=gate.submitMakerReduction!;let permit:boolean|undefined;
  gate.submitMakerReduction=async(request,canSubmit)=>{
    assert.equal(typeof canSubmit,'function');await gate.fetchAccount();f.events.push('native-preflight-get');
    t.mock.timers.setTime(NOW+1);f.publish({long:{bids:[{price:1.009,quantity:30}]}});
    f.nativeFees.set('gate',{...f.nativeFees.get('gate')!,takerFeeRate:.0007,takerFeeAt:Date.now(),makerFeeAt:Date.now()});
    permit=canSubmit!();assert.equal(permit,true);return submit(request);
  };
  f.inspect(()=>({quantity:30,activity:'terminal'}));await f.manage();await f.engine.execution.waitMakerClose(f.p);
  assert.equal(permit,true);assert.equal(f.makerRequests.length,1);assert.deepEqual(f.peerRequests.map(value=>value.request.quantity),[30]);
  const order=f.store.data.orders[0],comparison=order.makerCloseComparison!;assert.ok(comparison);
  assert.equal(comparison.timestamp,NOW+1);assert.equal(comparison.longOppositePrice,1.009);assert.equal(comparison.shortOppositePrice,1);
  assert.equal(comparison.longTakerFeeRate,.0007);assert.equal(comparison.shortTakerFeeRate,.0005);
  assert.equal(order.executionEvidence?.referencePrice,1.009);assert.equal(order.executionEvidence?.referenceObservedAt,NOW+1);
  assert.equal(order.executionEvidence?.nativeTakerFeeRate,.0007);assert.equal(comparison.status,'paired');
  assert.equal(order.executionEvidence?.nativeMakerFeeRate,.0002);assert.equal(order.executionEvidence?.feeObservedAt,NOW+1);
  assert.equal(order.executionEvidence?.submittedAt,NOW+1);
  assert.ok(Math.abs(comparison.makerPriceSavingUsd!-.21)<1e-12);
  assert.ok(Math.abs(comparison.makerBenchmarkFeeUsd!-.021189)<1e-12);
  assert.ok(Math.abs(comparison.makerActualFeeUsd!-.006096)<1e-12);
  assert.ok(Math.abs(comparison.pairTotalSavingUsd!-.225093)<1e-12);
  assert.equal(f.p.long.quantity,70);assert.equal(f.p.short.quantity,70);assert.equal(f.cancelledIds.length,0);
});

test('a confirmed funding-loss exit uses its original IOC route even when only a passive Maker quote would show profit',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture({topQuantity:100});t.after(()=>f.stop());
  const paymentAt=NOW+240_000;
  f.p.profitExitPolicy!.firstFundingTime=paymentAt;f.p.profitExitPolicy!.earliestExitAt=paymentAt+10_000;
  f.p.profitExitPolicy!.fundingChecks=['gate','bybit'].map(exchange=>({exchange:exchange as ExchangeId,timestamp:paymentAt}));
  f.p.plannedExitAt=paymentAt+10_000;
  for(const elapsed of [0,45_000,90_000,135_000,180_000]){
    t.mock.timers.setTime(NOW+elapsed);
    for(const [exchange,fee] of f.nativeFees)f.nativeFees.set(exchange,{...fee,takerFeeAt:Date.now(),makerFeeAt:Date.now()});
    f.publish({long:{bids:[{price:1,quantity:100}],nextFundingTime:paymentAt,fundingRate:0},
      short:{nextFundingTime:paymentAt,fundingRate:-.05}});
    await f.manage();assert.equal(f.makerRequests.length,0);
    if(elapsed<180_000){assert.equal(f.p.status,'open');assert.equal(f.peerRequests.length,0);}
  }
  assert.equal(f.p.holdDecision?.exitSignal,'funding-loss');assert.equal(f.p.holdDecision?.fundingExitStability?.status,'confirmed');
  assert.equal(f.p.holdDecision?.fundingExitStability?.sampleCount,5);assert.equal(f.p.holdDecision?.fundingExitStability?.observedSpanMs,180_000);
  assert.deepEqual(f.peerRequests.map(value=>[value.exchange,value.request.side,value.request.quantity,value.request.limitPrice]),
    [['gate','sell',100,1],['bybit','buy',100,1]]);
  assert.equal(f.p.status,'closed');assert.equal(f.p.long.quantity,0);assert.equal(f.p.short.quantity,0);
  assert.ok(Math.abs(f.p.netPnlUsd+.2)<1e-12);assert.equal(f.makerRequests.length,0);assert.equal(f.cancelledIds.length,0);
});

test('a partial peer IOC retries only confirmed excess and never enlarges the Maker-filled reduction budget',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.stop());
  f.inspect((_maker,call)=>({quantity:call===1?10:30,activity:call===1?'active':'terminal'}));
  f.fillPeer((request,call)=>call===1?4:request.quantity);
  await f.manage();await f.engine.execution.waitMakerClose(f.p);
  assert.deepEqual(f.peerRequests.map(value=>value.request.quantity),[10,6,20]);
  assert.equal(f.store.data.orders[1].result?.filledQuantity,4);
  assert.equal(f.p.long.quantity,70);assert.equal(f.p.short.quantity,70);assert.equal(f.makerRequests.length,1);
  assert.equal(f.p.status,'closing');assert.equal(f.cancelledIds.length,0);
});

test('terminal Maker cash keeps a current-session legal tail across confirmed zero peers and fresh accounts, without a new profit signal',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.stop());
  f.inspect(()=>({quantity:10,activity:'terminal'}));
  f.fillPeer((request,call)=>call===1?3:call<=6?0:call===7?2:request.quantity);
  await f.manage();await f.engine.execution.waitMakerClose(f.p);
  const maker=f.store.data.orders[0],cashBefore=f.p.realizedSpreadPnlUsd;
  assert.deepEqual(f.peerRequests.map(o=>o.request.quantity),[10,7,7]);
  assert.equal(f.p.long.quantity,90);assert.equal(f.p.short.quantity,97);
  assert.equal(f.p.status,'closing');assert.equal(f.engine.execution.hasPendingMakerCloseTail(f.p),true);
  assert.equal(maker.makerReduction?.peerQuantityStep,1);assert.equal(maker.makerReduction?.peerMinQuantity,1);
  f.publish({long:{bids:[{price:.99,quantity:30}]},short:{asks:[{price:1.02,quantity:30}]}});
  for(const health of f.engine.health)health.accountUpdatedAt=NOW-1;
  t.mock.timers.tick(501);await f.manageProfitWake();
  assert.equal(f.peerRequests.length,3,'account evidence from before the confirmed Maker cash cannot authorize the next tail');
  for(const [exchange,account] of f.accounts)f.engine.accounts.set(exchange,{...structuredClone(account),positions:[{
    ...structuredClone(account.positions[0]),quantity:100}]});
  for(const health of f.engine.health)health.accountUpdatedAt=Date.now();
  await f.manageProfitWake();assert.equal(f.peerRequests.length,3,'fresh but unmatched account quantities cannot authorize repair');
  f.readAccounts();await f.manageProfitWake();
  assert.deepEqual(f.peerRequests.map(o=>o.request.quantity),[10,7,7,7,7,7]);
  assert.equal(f.p.long.quantity,90);assert.equal(f.p.short.quantity,97);
  assert.equal(f.engine.execution.hasPendingMakerCloseTail(f.p),true);assert.equal(f.makerRequests.length,1);
  t.mock.timers.tick(501);f.publish();f.readAccounts();await f.manageProfitWake();
  assert.deepEqual(f.peerRequests.map(o=>o.request.quantity),[10,7,7,7,7,7,7,5]);
  assert.equal(f.p.long.quantity,90);assert.equal(f.p.short.quantity,90);
  assert.equal(f.engine.execution.hasPendingMakerCloseTail(f.p),false);assert.equal(f.makerRequests.length,1);
  assert.ok(f.p.realizedSpreadPnlUsd<cashBefore,'the actual adverse peer cash stays booked');
  assert.ok(f.store.data.orders.slice(1).every(o=>o.executionEvidence?.makerCloseParentClientId===maker.request.clientOrderId));
  const paid=f.p.feesUsd,realized=f.p.realizedSpreadPnlUsd;
  assert.equal(await f.engine.execution.continueMakerCloseTail(f.p),false);
  assert.equal(f.p.feesUsd,paid);assert.equal(f.p.realizedSpreadPnlUsd,realized);assert.equal(f.peerRequests.length,8);
});

test('a missing peer quote retains only the terminal Maker tail on the frozen peer step and resumes when a fresh quote returns',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.stop());
  f.inspect(()=>{
    f.publish({short:{timestamp:NOW-60_000,observedAt:NOW-60_000}});
    return {quantity:10,activity:'terminal'};
  });
  await f.manage();await f.engine.execution.waitMakerClose(f.p);
  const maker=f.store.data.orders[0];assert.equal(maker.makerReduction?.peerQuantityStep,1);
  assert.equal(f.peerRequests.length,0);assert.equal(f.p.long.quantity,90);assert.equal(f.p.short.quantity,100);
  assert.equal(f.engine.execution.hasPendingMakerCloseTail(f.p),true);assert.equal(f.p.status,'closing');
  t.mock.timers.tick(501);f.readAccounts();await f.manageProfitWake();
  assert.equal(f.peerRequests.length,0);assert.equal(f.engine.execution.hasPendingMakerCloseTail(f.p),true);
  t.mock.timers.tick(501);f.publish({long:{bids:[{price:.99,quantity:30}]},short:{asks:[{price:1.02,quantity:30}]}});
  f.readAccounts();await f.manageProfitWake();
  assert.deepEqual(f.peerRequests.map(o=>o.request.quantity),[10]);
  assert.equal(f.p.long.quantity,90);assert.equal(f.p.short.quantity,90);assert.equal(f.makerRequests.length,1);
  assert.equal(f.engine.execution.hasPendingMakerCloseTail(f.p),false);
});

test('a hard-refused peer never registers an automatic confirmed-tail continuation',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.stop());
  const peer=f.adapters.find(a=>a.id==='bybit')!,place=peer.placeOrder;
  f.fillPeer(()=>0);peer.placeOrder=async request=>({...await place!(request),rejectionCode:'MEMORY_RISK_REFUSAL',rejectionReason:'Risk refusal'});
  f.inspect(()=>({quantity:10,activity:'terminal'}));await f.manage();await f.engine.execution.waitMakerClose(f.p);
  assert.equal(f.peerRequests.length,1);assert.equal(f.p.long.quantity,90);assert.equal(f.p.short.quantity,100);
  assert.equal(f.engine.execution.hasPendingMakerCloseTail(f.p),false);
  assert.equal(f.engine.execution.canRepairConfirmedMakerCloseTail(f.p,f.store.data.orders[0].request.clientOrderId),false);
  t.mock.timers.tick(501);f.publish();f.readAccounts();await f.manageProfitWake();
  assert.equal(f.peerRequests.length,1);assert.equal(f.makerRequests.length,1);
});

async function legacyMakerTailFixture(){
  const f=fixture();
  f.p.long.quantity=f.p.short.quantity=44.5;
  for(const account of f.accounts.values())account.positions[0].quantity=44.5;
  f.publish({long:{quantityStep:.1,minQuantity:.1,contractSize:.1},short:{quantityStep:.1,minQuantity:.1}});
  f.inspect(()=>({quantity:1,activity:'terminal'}));f.fillPeer((request,call)=>call===1?.9:call<=3?0:request.quantity);
  await f.manage();await f.engine.execution.waitMakerClose(f.p);
  const maker=f.store.data.orders[0],legacy=f.store.data.orders[1];
  delete legacy.executionEvidence!.makerCloseParentClientId;
  f.p.status='attention';
  return {...f,maker,legacy};
}

test('explicit legacy peer proof changes only the original Maker link metadata and adds the exact remaining reduction',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=await legacyMakerTailFixture();t.after(()=>f.stop());
  const old=structuredClone(f.legacy),makerCash=f.maker.result!.filledQuantity;
  assert.equal(f.engine.execution.canRepairConfirmedMakerCloseTail(f.p,f.maker.request.clientOrderId),false);
  assert.equal(f.engine.execution.canRepairConfirmedMakerCloseTail(f.p,f.maker.request.clientOrderId,[f.legacy.request.clientOrderId]),true);
  t.mock.timers.tick(501);f.publish({short:{asks:[{price:1.2,quantity:30}]}});f.readAccounts();
  assert.equal(await f.exclusive(()=>f.engine.execution.repairConfirmedMakerCloseTail(f.p,f.maker.request.clientOrderId,[f.legacy.request.clientOrderId],()=>true)),true);
  assert.deepEqual(f.legacy,old);assert.equal(f.maker.result!.filledQuantity,makerCash);
  assert.deepEqual(f.maker.makerReduction?.recoveredPeers,{verifiedAt:Date.now(),clientOrderIds:[f.legacy.request.clientOrderId]});
  assert.deepEqual(f.peerRequests.map(o=>o.request.quantity),[1,.1,.1,.1]);
  assert.equal(f.store.data.orders.at(-1)!.executionEvidence?.makerCloseParentClientId,f.maker.request.clientOrderId);
  assert.equal(f.p.long.quantity,43.5);assert.equal(f.p.short.quantity,43.5);assert.equal(f.makerRequests.length,1);
  const comparison=f.maker.makerCloseComparison!;assert.equal(comparison.pairedComplete,true);
  assert.equal(comparison.peerQuantity,1);assert.ok(comparison.pairTotalSavingUsd!<0);
});

test('foreign parents, legacy receipt aliases and duplicate recovery claims cannot authorize a confirmed Maker budget',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  for(const failure of ['parent','duplicate-client','duplicate-native','duplicate-claim','foreign-position','overflow'] as const){
    const f=await legacyMakerTailFixture();
    try{
      const id=f.legacy.request.clientOrderId;
      if(failure==='parent')f.legacy.executionEvidence!.makerCloseParentClientId='another-maker-parent';
      if(failure==='duplicate-client')f.store.data.orders.push(structuredClone(f.legacy));
      if(failure==='duplicate-native'){
        const alias=structuredClone(f.legacy);alias.request.clientOrderId=alias.result!.clientOrderId='legacy-native-alias';
        alias.executionEvidence!.makerCloseParentClientId=f.maker.request.clientOrderId;f.store.data.orders.push(alias);
      }
      if(failure==='duplicate-claim'){
        const other=structuredClone(f.maker);other.request.clientOrderId=other.result!.clientOrderId='another-maker-original';
        other.result!.id='another-maker-native';other.makerReduction!.recoveredPeers={verifiedAt:NOW,clientOrderIds:[id]};
        f.store.data.orders.push(other);
      }
      if(failure==='foreign-position')f.legacy.positionId='unrelated-position';
      if(failure==='overflow'){
        f.legacy.request.quantity=f.legacy.result!.filledQuantity=1.1;
        f.legacy.result!.feeUsd=f.legacy.executionEvidence!.bookedFeeUsd=1.1*.0005;
      }
      assert.equal(f.engine.execution.canRepairConfirmedMakerCloseTail(f.p,f.maker.request.clientOrderId,[id]),false,failure);
      const before=f.peerRequests.length;
      assert.equal(await f.engine.execution.repairConfirmedMakerCloseTail(f.p,f.maker.request.clientOrderId,[id]),false,failure);
      assert.equal(f.peerRequests.length,before);assert.equal(f.makerRequests.length,1);
    }finally{await f.stop();}
  }
});

test('a duplicate original Maker client identity cannot select an arbitrary receipt for tail repair',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=await legacyMakerTailFixture();t.after(()=>f.stop());
  const alias:JournalOrder=structuredClone(f.maker);alias.result!.id='another-native-with-same-client';
  f.store.data.orders.push(alias);
  assert.equal(f.engine.execution.canRepairConfirmedMakerCloseTail(f.p,f.maker.request.clientOrderId,[f.legacy.request.clientOrderId]),false);
  assert.equal(await f.engine.execution.repairConfirmedMakerCloseTail(f.p,f.maker.request.clientOrderId,[f.legacy.request.clientOrderId]),false);
  assert.equal(f.peerRequests.length,3);assert.equal(f.makerRequests.length,1);
});

test('legacy recovery-proof persistence failure kills trading before any new confirmed-tail order or repeat booking',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=await legacyMakerTailFixture();t.after(()=>f.stop());
  const old=structuredClone(f.legacy),fees=f.p.feesUsd,realized=f.p.realizedSpreadPnlUsd;let failed=false;
  f.store.save=()=>{if(f.maker.makerReduction?.recoveredPeers){failed=true;throw new Error('MEMORY recovery-proof save failed');}};
  await assert.rejects(f.engine.execution.repairConfirmedMakerCloseTail(f.p,f.maker.request.clientOrderId,[f.legacy.request.clientOrderId]),/save failed/);
  assert.equal(failed,true);assert.equal(f.store.data.killSwitch,true);
  assert.equal(f.engine.execution.hasPendingMakerCloseTail(f.p),false);
  assert.equal(f.engine.execution.canRepairConfirmedMakerCloseTail(f.p,f.maker.request.clientOrderId,[f.legacy.request.clientOrderId]),false);
  assert.deepEqual(f.legacy,old);assert.equal(f.p.feesUsd,fees);assert.equal(f.p.realizedSpreadPnlUsd,realized);
  assert.equal(f.peerRequests.length,3);assert.equal(f.makerRequests.length,1);
  assert.equal(await f.engine.execution.repairConfirmedMakerCloseTail(f.p,f.maker.request.clientOrderId,[f.legacy.request.clientOrderId]),false);
  assert.equal(f.peerRequests.length,3);assert.equal(f.p.long.quantity,43.5);assert.equal(f.p.short.quantity,43.6);
  f.store.save=()=>{};
});

test('confirmed-tail waiting-state persistence failures stop later financial continuations after missing books or zero peer retries',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  for(const stage of ['missing-book','retry-state'] as const){
    const f=fixture();let failed=false;
    try{
      f.inspect(()=>({quantity:10,activity:'terminal'}));f.fillPeer((_request,call)=>call===1?3:0);
      await f.manage();await f.engine.execution.waitMakerClose(f.p);
      assert.equal(f.engine.execution.hasPendingMakerCloseTail(f.p),true);
      t.mock.timers.tick(501);
      if(stage==='missing-book')f.publish({short:{timestamp:Date.now()-60_000,observedAt:Date.now()-60_000}});
      else f.publish();
      f.readAccounts();
      f.store.save=()=>{
        const reason=f.p.riskReasons.join(' ');
        if(stage==='missing-book'?reason.includes('尾差等待新盘口；'):reason.includes('限定修复已确认减仓结果')){
          failed=true;throw new Error(`MEMORY ${stage} waiting-state save failed`);
        }
      };
      await assert.rejects(f.exclusive(()=>f.engine.execution.continueMakerCloseTail(f.p)),/waiting-state save failed/);
      assert.equal(failed,true,stage);assert.equal(f.store.data.killSwitch,true,stage);
      assert.equal(f.engine.execution.hasPendingMakerCloseTail(f.p),false,stage);
      const count=f.peerRequests.length,fees=f.p.feesUsd,realized=f.p.realizedSpreadPnlUsd;
      f.store.save=()=>{};t.mock.timers.tick(501);f.publish();f.readAccounts();await f.manageProfitWake();
      assert.equal(f.peerRequests.length,count);assert.equal(f.makerRequests.length,1);
      assert.equal(f.p.feesUsd,fees);assert.equal(f.p.realizedSpreadPnlUsd,realized);
    }finally{f.store.save=()=>{};await f.stop();}
  }
});

test('verified active zero and partial executions retain unknown order status and book complete cash only once',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();
  const entered=deferred<void>(),release=deferred<Frame>(),partialBooked=deferred<void>(),terminal=deferred<Frame>();
  t.after(async()=>{release.resolve({quantity:10,activity:'terminal'});terminal.resolve({quantity:10,activity:'terminal'});await f.stop();});
  f.inspect((_maker,call)=>{
    if(call===1)return {quantity:0,activity:'active',feeUsd:0};
    if(call===2){entered.resolve();return release.promise;}
    partialBooked.resolve();return terminal.promise;
  });
  await f.manage();await bounded(entered.promise,'zero-fill active observation did not complete');
  const order=f.store.data.orders[0];assert.equal(order.result?.status,'unknown');assert.equal(order.result?.filledQuantity,0);
  assert.equal(order.makerReduction?.activity,'active');assert.equal(order.makerReduction?.bookedExecution,true);
  assert.equal(f.peerRequests.length,0);assert.equal(f.p.feesUsd,.1);assert.equal(f.p.realizedSpreadPnlUsd,0);
  release.resolve({quantity:10,activity:'active'});await bounded(partialBooked.promise,'active partial was never committed');
  assert.equal(order.result?.status,'unknown');assert.equal(order.makerReduction?.activity,'active');
  assert.equal(order.result?.filledQuantity,10);assert.equal(f.peerRequests.length,1);
  assert.equal(f.p.long.quantity,90);assert.equal(f.p.short.quantity,90);
  terminal.resolve({quantity:10,activity:'terminal'});await f.engine.execution.waitMakerClose(f.p);
  assert.deepEqual(f.peerRequests.map(value=>value.request.quantity),[10]);
  assert.equal(order.result?.status,'partial');assert.equal(order.result?.filledQuantity,10);
  assert.ok(Math.abs(f.p.feesUsd-(.1+10*1.016*.0002+10*.0005))<1e-12);
  assert.equal(f.p.long.quantity,90);assert.equal(f.p.short.quantity,90);
});

test('opposite-1 IOC profit falling below 10 bps cancels even while Maker prices remain profitable, but hedges late confirmed fills',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.stop());
  f.inspect((_maker,call)=>({quantity:call===1?10:20,activity:call===1?'active':'terminal'}));
  f.afterPeer(()=>f.publish({short:{asks:[{price:1.008,quantity:30}]}}));
  await f.manage();await f.engine.execution.waitMakerClose(f.p);
  assert.equal(f.cancelledIds.length,1);assert.deepEqual(f.peerRequests.map(value=>value.request.quantity),[10,10]);
  assert.equal(f.peerRequests[1].request.limitPrice,1.008);
  assert.ok(f.events.indexOf('maker-cancel')<f.events.indexOf('maker-read:20:terminal'));
  assert.equal(f.p.long.quantity,80);assert.equal(f.p.short.quantity,80);assert.equal(f.makerRequests.length,1);
  assert.match(f.store.data.orders[0].makerReduction!.stopReason!,/净收益率.*变化/);
});

test('the 5-second deadline cancels the same Maker ID and accounts for late fills before finishing',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.stop());
  f.inspect((_maker,call)=>({quantity:call===1?10:20,activity:call===1?'active':'terminal'}));
  f.afterPeer(()=>{t.mock.timers.setTime(NOW+5001);f.publish();});
  await f.manage();await f.engine.execution.waitMakerClose(f.p);
  assert.equal(f.cancelledIds.length,1);assert.equal(f.cancelledIds[0],f.store.data.orders[0].result!.id);
  assert.deepEqual(f.peerRequests.map(value=>value.request.quantity),[10,10]);
  assert.equal(f.p.long.quantity,80);assert.equal(f.p.short.quantity,80);
  assert.match(f.store.data.orders[0].makerReduction!.stopReason!,/5 秒/);
  assert.equal(f.makerRequests.length,1);
});

test('an unknown peer IOC cancels Maker, preserves original receipts and never retries the uncertain reduction',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.stop());
  f.inspect((_maker,call)=>({quantity:10,activity:call===1?'active':'terminal'}));f.fillPeer(()=> 'unknown');
  await f.manage();await f.engine.execution.waitMakerClose(f.p);
  assert.equal(f.peerRequests.length,1);assert.equal(f.peerRequests[0].request.quantity,10);assert.equal(f.cancelledIds.length,1);
  assert.equal(f.store.data.orders[1].result?.status,'unknown');assert.equal(f.store.data.orders[1].result?.id,'MEMORY-PEER-1');
  assert.equal(f.engine.execution.hasPendingMakerCloseTail(f.p),false);
  const comparison=f.store.data.orders[0].makerCloseComparison!;assert.ok(comparison);
  assert.equal(comparison.status,'pending');assert.equal(comparison.peerActualFeeUsd,null);assert.equal(comparison.pairTotalSavingUsd,null);
  assert.equal(comparison.peerPendingOrderCount,1);assert.equal(comparison.pairedComplete,false);
  assert.equal(f.p.status,'attention');assert.equal(f.p.long.quantity,90);assert.equal(f.p.short.quantity,100);
  await f.manage();assert.equal(f.peerRequests.length,1);assert.equal(f.makerRequests.length,1);
});

test('unknown Maker activity or incomplete active execution cash preserves its ID and grants no hedge or new POST',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  for(const frame of [{quantity:0,activity:'unknown' as const,verified:false},
    {quantity:10,activity:'active' as const,verified:false,feeUsd:NaN}]){
    const f=fixture();t.after(()=>f.stop());f.inspect(()=>frame);
    await f.manage();await f.engine.execution.waitMakerClose(f.p);
    const order=f.store.data.orders[0];assert.equal(f.makerRequests.length,1);assert.equal(f.peerRequests.length,0);
    assert.equal(f.cancelledIds.length,1);assert.equal(order.result?.id,'MEMORY-MAKER-1');assert.equal(order.result?.filledQuantity,0);
    assert.equal(order.result?.status,'unknown');assert.equal(f.p.feesUsd,.1);assert.equal(f.p.realizedSpreadPnlUsd,0);
    assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);assert.equal(f.p.status,'attention');
    await f.manage();assert.equal(f.makerRequests.length,1);assert.equal(f.peerRequests.length,0);
    assert.ok(f.inspectedIds.every(id=>id==='MEMORY-MAKER-1'));
  }
});

test('native fee absence, read-only permission and an original unknown order each prevent Maker submission',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const missing=fixture({missingFees:true});t.after(()=>missing.stop());await missing.manage();
  assert.equal(missing.makerRequests.length,0);assert.equal(missing.peerRequests.length,0);assert.equal(missing.store.data.orders.length,0);
  assert.deepEqual([...new Set(missing.feeReads)].sort(),['bybit','gate']);assert.equal(missing.p.holdDecision?.action,'wait');
  const readonly=fixture({permission:false});t.after(()=>readonly.stop());await readonly.manage();
  assert.equal(readonly.feeReads.length,0);assert.equal(readonly.makerRequests.length,0);assert.equal(readonly.peerRequests.length,0);
  assert.equal(readonly.store.data.orders.length,0);assert.match(readonly.p.riskReasons.join(' '),/只读/);
  const pending=fixture();t.after(()=>pending.stop());
  pending.store.data.orders.push({positionId:pending.p.id,exchange:'gate',createdAt:Date.now()-100,
    request:{clientOrderId:'MEMORY-ORIGINAL',base,symbol,side:'sell',quantity:10,limitPrice:1.016,reduceOnly:true},
    result:{id:'MEMORY-ORIGINAL-NATIVE',clientOrderId:'MEMORY-ORIGINAL',status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:NaN,timestamp:Date.now()-100}});
  await pending.manage();assert.equal(pending.makerRequests.length,0);assert.equal(pending.peerRequests.length,0);
  assert.equal(pending.store.data.orders.length,1);assert.equal(pending.store.data.orders[0].result?.id,'MEMORY-ORIGINAL-NATIVE');
});

test('a profitable Maker quote cannot create an exit intent or private fee request before opposite-1 IOC profit qualifies',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture({missingFees:true});t.after(()=>f.stop());
  f.publish({long:{bids:[{price:1,quantity:30}],asks:[{price:1.016,quantity:30}]}});
  await f.manage();assert.equal(f.p.status,'open');assert.equal(f.makerRequests.length,0);assert.equal(f.peerRequests.length,0);
  assert.equal(f.store.data.orders.length,0);assert.equal(f.feeReads.length,0);assert.equal(f.p.closeRequestedAt,undefined);
  assert.equal(f.p.holdDecision?.exitSignal,undefined);
});

test('reducing remaining holdings preserves the original 100 U single-leg basis and its 0.10 U trigger',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.stop());
  f.p.long.quantity=30;f.p.short.quantity=30;
  for(const account of f.accounts.values())account.positions[0].quantity=30;
  // At opposite price 1, 30 * .006 - .1 paid fees - .03009 close fees = .04991.
  // This exceeds the wrong 10-bps threshold on remaining notional (.03), but not the original .10.
  await f.manage();assert.equal(f.p.profitExitNotionalUsd,100);assert.equal(f.makerRequests.length,0);assert.equal(f.peerRequests.length,0);
  assert.equal(f.store.data.orders.length,0);assert.equal(f.p.closeRequestedAt,undefined);assert.equal(f.p.holdDecision?.exitSignal,undefined);
});

test('confirmed Maker batches preserve the original opening basis through final zero holdings',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.stop());
  // Let the real engine freeze the original basis before its first reduction.
  delete f.p.profitExitNotionalUsd;f.inspect(maker=>({quantity:maker.request.quantity,activity:'terminal'}));
  for(let batch=0;batch<4;batch++){
    t.mock.timers.setTime(NOW+batch*5001);f.publish();f.readAccounts();
    await f.manage();await f.engine.execution.waitMakerClose(f.p);
    assert.equal(f.p.profitExitNotionalUsd,100);
  }
  assert.deepEqual(f.makerRequests.map(value=>value.request.quantity),[30,30,30,10]);
  assert.deepEqual(f.peerRequests.map(value=>value.request.quantity),[30,30,30,10]);
  assert.equal(f.p.status,'closed');assert.equal(f.p.long.quantity,0);assert.equal(f.p.short.quantity,0);
  assert.equal(f.accounts.get('gate')!.positions[0].quantity,0);assert.equal(f.accounts.get('bybit')!.positions[0].quantity,0);
  assert.equal(f.p.profitExitNotionalUsd,100);assert.ok(f.p.netPnlUsd>.1);assert.equal(f.cancelledIds.length,0);
});

test('a deferred Maker GET leaves the engine queue available for another position and exclusive operations',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();
  const entered=deferred<void>(),release=deferred<Frame>();t.after(async()=>{release.resolve({quantity:0,activity:'terminal'});await f.stop();});
  f.inspect((_maker,call)=>{if(call===1){entered.resolve();return release.promise;}return {quantity:0,activity:'terminal'};});
  await f.manage();await bounded(entered.promise,'Maker GET was never entered');
  assert.equal(f.engine.execution.hasMakerClose(f.p),true);
  assert.equal(await bounded(f.exclusive(async()=> 'queue-free'),'Maker GET blocked exclusive'), 'queue-free');
  const other=structuredClone(f.p);other.id='independent-position';other.base='OTHERMAKER';other.status='open';
  delete other.closeRequestedAt;delete other.closeAttemptedAt;delete other.closeProfitRequired;delete other.closeReason;
  delete other.holdDecision;other.long.symbol='OTHERMAKER/USDT:USDT';other.short.symbol=other.long.symbol;
  f.store.data.positions.push(other);
  for(const exchange of ['gate','bybit'] as const){
    const quote={...f.quotes.get(exchange)!,base:other.base,symbol:other.long.symbol,
      bids:[{price:.999,quantity:30}],asks:[{price:1.001,quantity:30}]};
    f.additionalQuotes.set(`${exchange}:${other.base}`,quote);
    f.accounts.get(exchange)!.positions.push({base:other.base,symbol:other.long.symbol,side:exchange==='gate'?'long':'short',
      quantity:100,markPrice:1,entryPrice:1,liquidationPrice:0,leverage:2});
  }
  await bounded(f.manage(),'Maker GET blocked another position');
  assert.equal(f.store.data.positions.find(position=>position.id===other.id)?.holdDecision?.action,'hold');
  assert.equal(f.makerRequests.length,1);assert.equal(f.peerRequests.length,0);
  release.resolve({quantity:0,activity:'terminal'});await f.engine.execution.waitMakerClose(f.p);
});

test('rest checks and original-ID inspection bypass unrelated queued IO while verified cash and hedges stay serialized',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:NOW});const f=fixture();
  const firstRead=deferred<void>(),nextRead=deferred<void>(),releaseRead=deferred<Frame>(),
    queueEntered=deferred<void>(),releaseQueue=deferred<void>();
  t.after(async()=>{releaseRead.resolve({quantity:10,activity:'terminal'});releaseQueue.resolve();await f.stop();});
  f.inspect((_maker,call)=>{
    if(call===1){firstRead.resolve();return {quantity:0,activity:'active'};}
    nextRead.resolve();return releaseRead.promise;
  });
  await f.manage();await firstRead.promise;
  await f.exclusive(async()=>undefined);
  await new Promise<void>(resolve=>setImmediate(resolve));
  const blocked=f.exclusive(async()=>{queueEntered.resolve();await releaseQueue.promise;});await queueEntered.promise;
  f.publish();t.mock.timers.tick(100);
  // Use a real event-loop turn: mocked timeouts must not mask a queued canRest regression.
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(f.inspectedIds.length,2,'native GET starts without waiting for unrelated financial IO');
  await nextRead.promise;
  releaseRead.resolve({quantity:10,activity:'terminal'});
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(f.p.long.quantity,100,'verified observation cannot mutate cash outside the financial queue');
  assert.equal(f.p.short.quantity,100);assert.equal(f.peerRequests.length,0);
  releaseQueue.resolve();await blocked;await f.engine.execution.waitMakerClose(f.p);
  assert.deepEqual(f.peerRequests.map(value=>value.request.quantity),[10]);
  assert.equal(f.p.long.quantity,90);assert.equal(f.p.short.quantity,90);
  assert.equal(f.makerRequests.length,1);assert.equal(f.makerRequests[0].request.postOnly,true);
});

test('watchdog cancels after 5 seconds even while original Maker GET is deferred, then hedges final late fills',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:NOW});const f=fixture();
  const entered=deferred<void>(),release=deferred<Frame>(),cancelled=deferred<void>();
  const gate=f.adapters.find(adapter=>adapter.id==='gate')!,cancel=gate.cancelMakerReduction!;
  gate.cancelMakerReduction=async(request,id)=>{await cancel(request,id);cancelled.resolve();};
  t.after(async()=>{release.resolve({quantity:10,activity:'terminal'});await f.stop();});
  f.inspect((_maker,call)=>{if(call===1){entered.resolve();return release.promise;}return {quantity:10,activity:'terminal'};});
  await f.manage();await entered.promise;assert.equal(f.cancelledIds.length,0);
  t.mock.timers.tick(5000);f.publish();await cancelled.promise;
  assert.equal(f.cancelledIds.length,1);assert.equal(f.cancelledIds[0],'MEMORY-MAKER-1');
  await f.engine.execution.waitMakerClose(f.p);release.resolve({quantity:10,activity:'terminal'});
  assert.deepEqual(f.peerRequests.map(value=>value.request.quantity),[10]);assert.equal(f.p.long.quantity,90);assert.equal(f.p.short.quantity,90);
  assert.match(f.store.data.orders[0].makerReduction!.stopReason!,/5 秒/);assert.equal(f.makerRequests.length,1);
});

test('watchdog cancellation of its original Maker ID does not wait behind a blocked engine financial queue',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:NOW});const f=fixture();
  const inspected=deferred<void>(),releaseRead=deferred<Frame>(),queueEntered=deferred<void>(),releaseQueue=deferred<void>(),cancelled=deferred<void>();
  const gate=f.adapters.find(adapter=>adapter.id==='gate')!,cancel=gate.cancelMakerReduction!;
  gate.cancelMakerReduction=async(request,id)=>{await cancel(request,id);cancelled.resolve();};
  t.after(async()=>{releaseRead.resolve({quantity:0,activity:'terminal'});releaseQueue.resolve();await f.stop();});
  f.inspect((_maker,call)=>{if(call===1){inspected.resolve();return releaseRead.promise;}return {quantity:0,activity:'terminal'};});
  await f.manage();await inspected.promise;
  const blocked=f.exclusive(async()=>{queueEntered.resolve();await releaseQueue.promise;});await queueEntered.promise;
  t.mock.timers.tick(5000);f.publish();await cancelled.promise;
  assert.equal(f.cancelledIds.length,1);assert.equal(f.cancelledIds[0],'MEMORY-MAKER-1');assert.equal(f.peerRequests.length,0);
  assert.equal(f.engine.execution.hasMakerClose(f.p),true);
  releaseQueue.resolve();await blocked;await f.engine.execution.waitMakerClose(f.p);releaseRead.resolve({quantity:0,activity:'terminal'});
  assert.equal(f.store.data.orders[0].makerReduction?.activity,'terminal');assert.equal(f.makerRequests.length,1);
});

test('a restarted read-only engine reconciles original Maker terminal by GET without restoring a session or submitting a hedge',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.stop());
  f.inspect(()=>({quantity:0,activity:'unknown',verified:false}));await f.manage();await f.engine.execution.waitMakerClose(f.p);
  const order=f.store.data.orders[0],id=order.result!.id,beforePosts=f.makerRequests.length,beforeCancels=f.cancelledIds.length;
  const restarted=f.createEngine(false);t.after(()=>restarted.stop());f.readAccounts(restarted);restarted.snapshots=[...f.quotes.values()];
  assert.equal(restarted.execution.hasMakerClose(f.p),false);assert.equal(restarted.liveUnlocked,false);assert.equal(f.p.status,'attention');
  t.mock.timers.setTime(NOW+1);f.publish();f.inspect(()=>({quantity:10,activity:'terminal'}));
  const portfolio:LivePortfolio={timestamp:Date.now(),pollIntervalMs:5000,maxAgeMs:120000,
    exchanges:[...f.accounts].map(([exchange,account])=>({exchange,credentialsConfigured:true,status:'ready',
      requestedAt:Date.now(),receivedAt:Date.now(),positions:account.positions}))};
  const internal=restarted as unknown as {observePendingReports(value:LivePortfolio):Promise<void>;managePositions(now:number):Promise<void>};
  await restarted.exclusive(()=>internal.observePendingReports(portfolio));
  assert.equal(order.result!.id,id);assert.equal(order.makerReduction?.activity,'terminal');assert.equal(order.result?.filledQuantity,10);
  assert.equal(f.p.long.quantity,90);assert.equal(f.p.short.quantity,100);assert.equal(f.p.status,'attention');
  assert.equal(f.peerRequests.length,0);assert.equal(f.makerRequests.length,beforePosts);assert.equal(f.cancelledIds.length,beforeCancels);
  await restarted.exclusive(()=>internal.managePositions(Date.now()));assert.equal(f.peerRequests.length,0);
  assert.equal(restarted.liveUnlocked,false);assert.equal(restarted.execution.hasMakerClose(f.p),false);
});

test('an acknowledged Maker receipt persistence failure halts trading before any confirmed-fill hedge',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.stop());
  let failed=false;f.store.save=()=>{
    const order=f.store.data.orders[0];
    if(!failed&&order?.result?.id==='MEMORY-MAKER-1'&&order.makerReduction?.lastObservedAt===undefined){
      failed=true;throw new Error('MEMORY persistence failure after Maker acknowledgement');
    }
  };
  f.inspect(()=>({quantity:10,activity:'terminal'}));
  await f.manage();await f.engine.execution.waitMakerClose(f.p).catch(()=>undefined);
  assert.equal(failed,true);assert.equal(f.store.data.killSwitch,true);assert.equal(f.p.status,'attention');
  assert.equal(f.makerRequests.length,1);assert.equal(f.peerRequests.length,0);assert.equal(f.cancelledIds.length,1);
  assert.equal(f.store.data.orders[0].result?.id,'MEMORY-MAKER-1');
  assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);assert.equal(f.p.feesUsd,.1);assert.equal(f.p.realizedSpreadPnlUsd,0);
  await f.manage();assert.equal(f.makerRequests.length,1);assert.equal(f.peerRequests.length,0);
});

test('a verified partial-fill persistence failure preserves already applied cash, cancels Maker and prevents automatic replay or hedging',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.stop());
  let failed=false;f.store.save=()=>{
    if(!failed&&f.store.data.orders[0]?.result?.filledQuantity===10&&f.p.long.quantity===90){
      failed=true;throw new Error('MEMORY persistence failure after confirmed partial fill');
    }
  };
  f.inspect((_maker,call)=>({quantity:10,activity:call===1?'active':'terminal'}));
  await f.manage();await f.engine.execution.waitMakerClose(f.p).catch(()=>undefined);
  assert.equal(failed,true);assert.equal(f.store.data.killSwitch,true);assert.equal(f.p.status,'attention');
  assert.equal(f.p.long.quantity,90);assert.equal(f.p.short.quantity,100);assert.equal(f.peerRequests.length,0);
  assert.ok(Math.abs(f.p.realizedSpreadPnlUsd-.16)<1e-12);assert.ok(Math.abs(f.p.feesUsd-(.1+10*1.016*.0002))<1e-12);
  assert.equal(f.cancelledIds.length,1);assert.equal(f.makerRequests.length,1);
  await f.manage();assert.equal(f.peerRequests.length,0);assert.equal(f.p.long.quantity,90);
});

test('a Maker peer pre-intent persistence failure globally stops trading and final observations cannot create the previously unsent hedge',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.stop());let failed=false;
  f.store.save=()=>{
    const maker=f.store.data.orders[0];
    if(!failed&&maker?.makerReduction?.hedgeStartedAt!==undefined&&f.store.data.orders.length===1){
      failed=true;throw new Error('MEMORY persistence failure before Maker peer intent');
    }
  };
  f.inspect((_maker,call)=>({quantity:10,activity:call===1?'active':'terminal'}));
  await f.manage();await f.engine.execution.waitMakerClose(f.p).catch(()=>undefined);
  assert.equal(failed,true);assert.equal(f.store.data.killSwitch,true);assert.equal(f.p.status,'attention');
  assert.equal(f.engine.execution.hasPendingMakerCloseTail(f.p),false);
  assert.equal(f.makerRequests.length,1);assert.equal(f.peerRequests.length,0);assert.deepEqual(f.cancelledIds,['MEMORY-MAKER-1']);
  assert.equal(f.p.long.quantity,90);assert.equal(f.p.short.quantity,100);assert.equal(f.store.data.orders.length,1);
  assert.ok(Math.abs(f.p.feesUsd-(.1+10*1.016*.0002))<1e-12);
  await f.manageProfitWake();assert.equal(f.makerRequests.length,1);assert.equal(f.peerRequests.length,0);
});

test('a confirmed Maker peer fill persistence failure globally stops trading and never books or submits that hedge again',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.stop());let failed=false;
  f.store.save=()=>{
    if(!failed&&f.store.data.orders[1]?.result?.filledQuantity===10){
      failed=true;throw new Error('MEMORY persistence failure after confirmed Maker peer fill');
    }
  };
  f.inspect((_maker,call)=>({quantity:10,activity:call===1?'active':'terminal'}));
  await f.manage();await f.engine.execution.waitMakerClose(f.p).catch(()=>undefined);
  assert.equal(failed,true);assert.equal(f.store.data.killSwitch,true);assert.equal(f.p.status,'attention');
  assert.equal(f.makerRequests.length,1);assert.deepEqual(f.peerRequests.map(value=>value.request.quantity),[10]);
  assert.deepEqual(f.cancelledIds,['MEMORY-MAKER-1']);assert.equal(f.p.long.quantity,90);assert.equal(f.p.short.quantity,90);
  assert.equal(f.store.data.orders[1].result?.filledQuantity,10);
  assert.ok(Math.abs(f.p.feesUsd-(.1+10*1.016*.0002+10*.0005))<1e-12);
  assert.ok(Math.abs(f.p.realizedSpreadPnlUsd-.16)<1e-12);
  await f.manageProfitWake();assert.equal(f.peerRequests.length,1);assert.equal(f.makerRequests.length,1);
  assert.equal(f.p.long.quantity,90);assert.equal(f.p.short.quantity,90);
});

test('cancel-metadata persistence failure still attempts the original safety cancel and stops future financial actions',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.stop());
  let failed=false;f.store.save=()=>{
    if(!failed&&f.store.data.orders[0]?.makerReduction?.cancelRequestedAt!==undefined){
      failed=true;throw new Error('MEMORY persistence failure recording Maker cancellation');
    }
  };
  f.inspect((_maker,call)=>call===1?{quantity:0,activity:'unknown',verified:false}:{quantity:0,activity:'terminal'});
  await f.manage();await f.engine.execution.waitMakerClose(f.p).catch(()=>undefined);
  assert.equal(failed,true);assert.equal(f.store.data.killSwitch,true);assert.equal(f.p.status,'attention');
  assert.deepEqual(f.cancelledIds,['MEMORY-MAKER-1']);assert.equal(f.makerRequests.length,1);assert.equal(f.peerRequests.length,0);
  assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);
});

test('a manual close preserves inherited opposite-1 pricing and persists unconditional intent before canceling an in-flight Maker',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();
  const entered=deferred<void>(),release=deferred<Frame>();t.after(async()=>{release.resolve({quantity:0,activity:'terminal'});await f.stop();});
  f.store.save=()=>{if(f.p.closeProfitRequired===false&&f.p.closePricing==='best-opposite')f.events.push('saved-unconditional-opposite');};
  f.inspect((_maker,call)=>{if(call===1){entered.resolve();return release.promise;}return {quantity:0,activity:'terminal'};});
  await f.manage();await bounded(entered.promise,'Maker read was never entered');
  await assert.rejects(f.engine.close(f.p.id),/原 Maker 平仓仍在处理/);
  assert.equal(f.p.closeProfitRequired,false);assert.equal(f.p.closePricing,'best-opposite');assert.equal(f.p.closeReason,'手动平仓');
  await f.engine.execution.waitMakerClose(f.p);release.resolve({quantity:0,activity:'terminal'});
  assert.equal(f.cancelledIds.length,1);assert.equal(f.makerRequests.length,1);assert.equal(f.peerRequests.length,0);
  assert.ok(f.events.indexOf('saved-unconditional-opposite')>=0);
  assert.ok(f.events.indexOf('saved-unconditional-opposite')<f.events.indexOf('maker-cancel'));
});

test('emergency kill persists unconditional depth intent, cancels Maker and leaves the original reduction under supervision',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();
  const entered=deferred<void>(),release=deferred<Frame>();t.after(async()=>{release.resolve({quantity:0,activity:'terminal'});await f.stop();});
  f.store.save=()=>{if(f.p.closeProfitRequired===false&&f.p.closePricing==='depth')f.events.push('saved-unconditional-depth');};
  f.inspect((_maker,call)=>{if(call===1){entered.resolve();return release.promise;}return {quantity:0,activity:'terminal'};});
  await f.manage();await bounded(entered.promise,'Maker read was never entered');await f.engine.control('kill');
  assert.equal(f.store.data.killSwitch,true);assert.equal(f.p.closeProfitRequired,false);assert.equal(f.p.closePricing,'depth');
  assert.equal(f.p.closeReason,'紧急停止');await f.engine.execution.waitMakerClose(f.p);release.resolve({quantity:0,activity:'terminal'});
  assert.deepEqual(f.cancelledIds,['MEMORY-MAKER-1']);assert.equal(f.makerRequests.length,1);assert.equal(f.peerRequests.length,0);
  assert.ok(f.events.indexOf('saved-unconditional-depth')>=0);
  assert.ok(f.events.indexOf('saved-unconditional-depth')<f.events.indexOf('maker-cancel'));
  assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);
});
