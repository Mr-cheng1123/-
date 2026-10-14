import assert from 'node:assert/strict';
import {Engine} from '../src/core/engine.js';
import type {Store} from '../src/core/store.js';
import {defaultConfig} from '../src/shared/config.js';
import type {AccountState,ExchangeAdapter,ExchangeId,MarketSnapshot,Opportunity,OrderRequest,OrderResult,TradingFeeMetadata} from '../src/shared/types.js';

// All accounts, native checks and order receipts are in memory. No environment credentials or files are read.
export function fundingEntryFixture(options:{top?:number;maxBatches?:number}={}) {
  const exchanges:ExchangeId[]=['gate','bybit'],symbol='BTC/USDT:USDT',settlement=Date.now()+30*60_000;
  const config={...structuredClone(defaultConfig),mode:'live' as const,dataSource:'public' as const,
    entryPolicy:'aligned' as const,exchanges,symbols:['BTC'],orderNotionalUsd:100,holdMode:'adaptive' as const,
    feeOnly:true,maxEntryBatches:options.maxBatches??1,maxOrderRetries:0,entryIocBufferBps:0};
  const store={data:{version:1,config,positions:[],orders:[],logs:[],equity:[],killSwitch:false,fundingSeen:[]},save(){},log(){}} as unknown as Store;
  const native=new Map<ExchangeId,TradingFeeMetadata>(),accounts=new Map<ExchangeId,AccountState>(exchanges.map(exchange=>[exchange,{freeUsd:1000,equityUsd:1000,positions:[]}]));
  const quotes=new Map<ExchangeId,MarketSnapshot>();
  const counters={accounts:0,inspections:0,preparations:0,fees:0,nativeChecks:0,submissionGuards:0};
  const sent:Array<{exchange:ExchangeId;request:OrderRequest}>=[];
  const now=Date.now(),top=options.top??10;
  for(const exchange of exchanges)quotes.set(exchange,{exchange,base:'BTC',symbol,source:'public',timestamp:now,observedAt:now,
    fundingObservedAt:now,bookTransport:'websocket',markPrice:100,indexPrice:100,
    fundingRate:exchange==='bybit'?.005:0,nextFundingTime:settlement,intervalHours:1,fundingHistory:[],
    bids:[{price:exchange==='gate'?99.99:100.5,quantity:top}],asks:[{price:exchange==='gate'?100:100.51,quantity:top}],
    quantityStep:.001,minQuantity:.001,minNotional:5,contractSize:1,openInterestUsd:1e8,volume24hUsd:1e8,feeProfile:'standard'});
  let beforeNativeSubmit:((exchange:ExchangeId,request:OrderRequest)=>Promise<void>|void)|undefined;
  let afterFill:((exchange:ExchangeId,request:OrderRequest)=>void)|undefined;
  const adapters=exchanges.map(exchange=>({id:exchange,
    fetchSnapshots:async()=>[quotes.get(exchange)!],fetchExecutionSnapshots:async()=>[quotes.get(exchange)!],
    fetchAccount:async()=>{counters.accounts++;return structuredClone(accounts.get(exchange)!);},
    fetchFundingPayments:async()=>[],setRealtimeBases(){},close:async()=>{},
    inspectTrading:async()=>{counters.inspections++;},prepareTrading:async()=>{counters.preparations++;},validateOrder:async()=>{},
    cachedTradingFee:()=>native.get(exchange),fetchTradingFee:async(requestedSymbol:string)=>{
      assert.equal(requestedSymbol,symbol);counters.fees++;
      const fee={takerFeeSource:'exchange' as const,takerFeeAt:Date.now(),takerFeeRate:exchange==='bybit'?.00055:.0005,
        makerFeeSource:'exchange' as const,makerFeeAt:Date.now(),makerFeeRate:.0002};native.set(exchange,fee);return fee;
    },
    placeOrder:async(request:OrderRequest,canSubmit?:()=>boolean):Promise<OrderResult>=>{
      counters.nativeChecks++;await beforeNativeSubmit?.(exchange,request);
      if(canSubmit){
        counters.submissionGuards++;let allowed=false;try{allowed=canSubmit()!==false;}catch{allowed=false;}
        if(!allowed)return {id:'',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,
          feeUsd:0,timestamp:Date.now(),rejectionCode:'ORDER_SUBMISSION_PERMISSION_CHANGED',rejectionReason:'Memory native final guard veto'};
      }
      sent.push({exchange,request:{...request}});
      const fee=native.get(exchange);assert.ok(fee,'only verified native fees may reach a simulated create');
      const account=accounts.get(exchange)!,side=exchange==='gate'?'long':'short';
      if(request.reduceOnly){const row=account.positions.find(row=>row.symbol===symbol&&row.side===side);if(row)row.quantity-=request.quantity;}
      else {const row=account.positions.find(row=>row.symbol===symbol&&row.side===side);
        if(row)row.quantity+=request.quantity;else account.positions.push({base:'BTC',symbol,side,quantity:request.quantity,markPrice:100,entryPrice:request.limitPrice,liquidationPrice:0,leverage:2});}
      const result:OrderResult={id:`MEMORY-STABILITY-${sent.length}`,clientOrderId:request.clientOrderId,status:'filled',
        filledQuantity:request.quantity,averagePrice:request.limitPrice,averagePriceVerified:true,
        feeUsd:request.quantity*request.limitPrice*fee.takerFeeRate,timestamp:Date.now()};
      afterFill?.(exchange,request);return result;
    },reconcileOrder:async()=>{throw new Error('Unexpected memory reconciliation');},cancelOrder:async()=>{},
  } as ExchangeAdapter));
  const engine=new Engine(store,true,{adapterFactory:()=>adapters,liveEnvironment:{ALLOW_LIVE_TRADING:'true',LIVE_TRADING_ACK:'I_UNDERSTAND_THE_RISKS',
    GATE_API_KEY:'MEMORY-STABILITY',GATE_API_SECRET:'MEMORY-STABILITY',BYBIT_API_KEY:'MEMORY-STABILITY',BYBIT_API_SECRET:'MEMORY-STABILITY'}});
  const publish=(funding=true)=>{
    for(const quote of quotes.values()){
      quote.timestamp=Date.now();quote.observedAt=Date.now();if(funding)quote.fundingObservedAt=Date.now();
      const fee=native.get(quote.exchange);if(fee)Object.assign(quote,fee);
    }
    engine.snapshots=[...quotes.values()];
    engine.health=exchanges.map(exchange=>({exchange,status:'online',latencyMs:0,lastSuccess:Date.now(),accountStatus:'ready',accountUpdatedAt:Date.now()}));
    // A quote update is not an account observation during a financial request.
    // Publishing native quantities before applyFill would fabricate an external position mismatch.
    if(store.data.orders.length===0)for(const [exchange,account] of accounts)engine.accounts.set(exchange,structuredClone(account));
  };
  publish();
  return {engine,internal:engine as any,store,quotes,accounts,native,counters,sent,publish,adapters,
    candidate:()=>engine.currentOpportunities().find(o=>o.id==='BTC-gate-bybit'),
    beforeNativeSubmit(fn:typeof beforeNativeSubmit){beforeNativeSubmit=fn;},afterFill(fn:typeof afterFill){afterFill=fn;},
    stop:()=>engine.stop()};
}

export function entryStability(opportunity:Opportunity|undefined) {
  assert.ok(opportunity,'the ordinary manually available direction remains visible');
  const result=(opportunity as any).fundingEntryStability;
  assert.ok(result,'the engine must attach its process-local funding evidence');
  return result as {status:string;passes:boolean;sampleCount:number;observedSpanMs:number;requiredSpanMs:number};
}

export function confirmEntryFunding(f:ReturnType<typeof fundingEntryFixture>,_tick:(ms:number)=>void) {
  f.publish();
  const candidate=f.candidate()!;const stability=entryStability(candidate);
  assert.equal(stability.status,'confirmed');assert.equal(stability.passes,true);
  assert.equal(stability.sampleCount,1);assert.equal(stability.observedSpanMs,0);assert.equal(stability.requiredSpanMs,0);
  return candidate;
}
