import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../src/core/engine.js';
import type {Store} from '../src/core/store.js';
import {calculateOpportunities} from '../src/core/strategy.js';
import {defaultConfig} from '../src/shared/config.js';
import type {AppConfig,ExchangeAdapter,ExchangeId,MarketSnapshot,OrderRequest} from '../src/shared/types.js';

/** Full Engine callbacks with memory-only exchanges. No network or disk state is used. */
function fixture(startWaiting=false){
  const now=Date.now(),config:AppConfig={...defaultConfig,mode:'live',entryPolicy:'aligned',exchanges:['gate','bybit'],
    symbols:['BTC'],orderNotionalUsd:100,holdMode:'adaptive',maxEntryBatches:1,maxOrderRetries:0,entryIocBufferBps:0,
    asyncFundingEntryTiming:'last-payment'};
  const store={data:{version:1,config,positions:[],orders:[],logs:[],equity:[],killSwitch:false,fundingSeen:[]},
    save(){},log(){}} as unknown as Store;
  const quotes=new Map<ExchangeId,MarketSnapshot>();
  for(const exchange of config.exchanges)quotes.set(exchange,{exchange,base:'BTC',symbol:'BTC/USDT:USDT',
    timestamp:now,observedAt:now,markPrice:100,indexPrice:100,fundingRate:exchange==='bybit'?.0003:0,
    nextFundingTime:now+300_000,intervalHours:8,fundingHistory:[],
    bids:[{price:exchange==='gate'?99.98:100.5,quantity:5}],asks:[{price:exchange==='gate'?100:100.52,quantity:5}],
    quantityStep:.001,minQuantity:.001,minNotional:5,contractSize:1,openInterestUsd:0,volume24hUsd:0,source:'public',
    takerFeeRate:exchange==='bybit'?.00055:.0005,takerFeeAt:now,takerFeeSource:'exchange'});
  const moveToEarlierPayment=()=>{
    Object.assign(quotes.get('gate')!,{fundingRate:-.010993,nextFundingTime:now+3_900_000,intervalHours:8});
    Object.assign(quotes.get('bybit')!,{fundingRate:-.000859,nextFundingTime:now+300_000,intervalHours:1});
  };
  if(startWaiting)moveToEarlierPayment();
  const requests:Array<{exchange:ExchangeId;request:OrderRequest}>=[],financialMethods:string[]=[];
  let nativeShortFilled=false,changeAfterShort=false,timingChanged=false,changedQuoteReads=0,engine:Engine;
  const adapters=config.exchanges.map(exchange=>({id:exchange,
    fetchSnapshots:async()=>{
      // Change clocks only after Engine has recorded the actual short fill. The
      // following supplement must evaluate this fresh, newly ineligible timing.
      if(changeAfterShort&&nativeShortFilled&&!timingChanged){
        assert.ok(store.data.positions[0].short.quantity>0);
        moveToEarlierPayment();timingChanged=true;
      }
      if(timingChanged)changedQuoteReads++;
      return [{...quotes.get(exchange)!,timestamp:Date.now(),observedAt:Date.now()}];
    },
    fetchAccount:async()=>({freeUsd:55,equityUsd:55,positions:[]}),inspectTrading:async()=>{},validateOrder:async()=>{},
    prepareTrading:async()=>{financialMethods.push(`${exchange}:prepare`);},
    placeOrder:async(request:OrderRequest)=>{
      financialMethods.push(`${exchange}:place`);requests.push({exchange,request});
      if(exchange==='bybit'&&request.side==='sell'&&!request.reduceOnly)nativeShortFilled=true;
      return {id:`MEMORY-${requests.length}`,clientOrderId:request.clientOrderId,status:'filled' as const,
        filledQuantity:request.quantity,averagePrice:request.limitPrice,
        feeUsd:request.quantity*request.limitPrice*config.takerFees[exchange],timestamp:Date.now()};
    },
    reconcileOrder:async()=>{financialMethods.push(`${exchange}:reconcile`);throw new Error('Unexpected reconciliation');},
    cancelOrder:async()=>{financialMethods.push(`${exchange}:cancel`);throw new Error('Unexpected cancellation');},
    fetchFundingPayments:async()=>[],close:async()=>{}} as ExchangeAdapter));
  engine=new Engine(store,true,{adapterFactory:()=>adapters,liveEnvironment:{ALLOW_LIVE_TRADING:'true',
    LIVE_TRADING_ACK:'I_UNDERSTAND_THE_RISKS',GATE_API_KEY:'MEMORY',GATE_API_SECRET:'MEMORY',BYBIT_API_KEY:'MEMORY',BYBIT_API_SECRET:'MEMORY'}});
  engine.snapshots=[...quotes.values()];engine.health.forEach(health=>{health.status='online';health.lastSuccess=now;});
  return {engine,store,config,quotes,requests,financialMethods,enableClockChange(){changeAfterShort=true;},
    changedQuoteReads:()=>changedQuoteReads,timingChanged:()=>timingChanged};
}

test('committed short fill is hedged even when fresh settlement clocks make a hypothetical new entry wait',async()=>{
  const f=fixture(),initial=f.engine.currentOpportunities()[0];
  assert.equal(initial.eligible,true,initial.reasons.join('；'));assert.equal(initial.fundingSchedule!.entryReady,true);
  f.enableClockChange();
  const position=await f.engine.open(initial.id);
  assert.equal(f.timingChanged(),true);assert.ok(f.changedQuoteReads()>0);
  const [hypothetical]=calculateOpportunities([...f.quotes.values()],f.config,Date.now());
  assert.equal(hypothetical.fundingSchedule!.entryReady,false);assert.equal(hypothetical.eligible,false);
  assert.ok(hypothetical.expectedFundingUsd>0);assert.ok(hypothetical.entryLimitPriceEdgeBps!>0);
  assert.ok(hypothetical.checks!.filter(check=>check.pass===false).every(check=>check.label==='异步资金费入场时点合适'));
  assert.equal(position.status,'open',position.riskReasons.join('；'));
  assert.equal(position.short.quantity,1);assert.equal(position.long.quantity,1);
  assert.deepEqual(f.requests.map(({exchange,request})=>[exchange,request.side,request.quantity,request.reduceOnly]),[
    ['bybit','sell',1,false],['gate','buy',1,false],
  ]);
  assert.equal(f.store.data.orders.length,2);assert.ok(f.store.data.orders.every(order=>order.result?.status==='filled'));
  assert.equal(position.entryExecution!.matchedQuantity,1);assert.equal(position.closeRequestedAt,undefined);
  assert.ok(f.financialMethods.every(method=>!method.endsWith(':cancel')&&!method.endsWith(':reconcile')));
});

test('a new hedge that must wait performs no financial methods and creates no order intent',async()=>{
  const f=fixture(true),candidate=f.engine.currentOpportunities()[0];
  assert.equal(candidate.fundingSchedule!.entryReady,false);assert.equal(candidate.eligible,false);
  assert.ok(candidate.expectedFundingUsd>0);assert.ok(candidate.entryLimitPriceEdgeBps!>0);
  await assert.rejects(f.engine.open(candidate.id),/先付后收/);
  assert.deepEqual(f.financialMethods,[]);assert.deepEqual(f.requests,[]);
  assert.deepEqual(f.store.data.orders,[]);assert.deepEqual(f.store.data.positions,[]);
});
