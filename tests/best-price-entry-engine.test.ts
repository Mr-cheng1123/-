import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../src/core/engine.js';
import type {Store} from '../src/core/store.js';
import {defaultConfig,validateConfig} from '../src/shared/config.js';
import {configUpdatePolicy} from '../src/shared/config-update-policy.js';
import type {AppConfig,ExchangeAdapter,ExchangeId,MarketSnapshot,OrderRequest} from '../src/shared/types.js';

// Full strategy → account/contract checks → execution path. Every adapter is memory-only.
function fixture(options:{automaticEconomics?:boolean}={}){
  const config:AppConfig={...defaultConfig,mode:'live',entryPolicy:'aligned',exchanges:['gate','bybit'],symbols:['BTC'],
    orderNotionalUsd:100,holdMode:'adaptive',maxEntryBatches:8,maxOrderRetries:1};
  const store={data:{version:1,config,positions:[],orders:[],logs:[],equity:[],killSwitch:false,fundingSeen:[]},save(){},log(){}} as unknown as Store;
  const now=Date.now(),quotes=new Map<ExchangeId,MarketSnapshot>();
  for(const exchange of config.exchanges)quotes.set(exchange,{exchange,base:'BTC',symbol:'BTC/USDT:USDT',timestamp:now,observedAt:now,fundingObservedAt:now,
    markPrice:100,indexPrice:100,fundingRate:exchange==='bybit'?.0003:0,nextFundingTime:now+300_000,intervalHours:8,
    fundingHistory:[],bids:[{price:exchange==='gate'?99.98:100.5,quantity:.4},{price:exchange==='gate'?99.97:99,quantity:10}],
    asks:[{price:exchange==='gate'?100:100.52,quantity:.4},{price:exchange==='gate'?102:100.53,quantity:10}],
    quantityStep:.001,minQuantity:.001,minNotional:5,contractSize:1,openInterestUsd:0,volume24hUsd:0,source:'public',
    takerFeeRate:exchange==='bybit'?.00055:.0005,takerFeeAt:now,takerFeeSource:'exchange'});
  if(options.automaticEconomics){
    quotes.get('bybit')!.fundingRate=.005;
    quotes.get('gate')!.asks[1].price=100.01;
    quotes.get('gate')!.bids[1].price=99.97;
    quotes.get('bybit')!.bids[1].price=100.49;
    quotes.get('bybit')!.asks[1].price=100.53;
  }
  const requests:Array<{exchange:ExchangeId;request:OrderRequest}>=[];
  let afterFill:(count:number)=>void=()=>{};
  const adapters=config.exchanges.map(exchange=>({id:exchange,
    fetchSnapshots:async()=>[{...quotes.get(exchange)!,timestamp:Date.now(),observedAt:Date.now()}],
    fetchAccount:async()=>({freeUsd:55,equityUsd:55,positions:[]}),inspectTrading:async()=>{},prepareTrading:async()=>{},validateOrder:async()=>{},
    placeOrder:async(request:OrderRequest)=>{
      requests.push({exchange,request});afterFill(requests.length);
      return {id:`MEMORY-${requests.length}`,clientOrderId:request.clientOrderId,status:'filled' as const,
        filledQuantity:request.quantity,averagePrice:request.limitPrice,feeUsd:request.quantity*request.limitPrice*config.takerFees[exchange],timestamp:Date.now()};
    },reconcileOrder:async()=>{throw new Error('Unexpected reconciliation');},cancelOrder:async()=>{throw new Error('Unexpected cancel');},
    fetchFundingPayments:async()=>[],close:async()=>{}} as ExchangeAdapter));
  const engine=new Engine(store,true,{adapterFactory:()=>adapters,liveEnvironment:{
    ALLOW_LIVE_TRADING:'true',LIVE_TRADING_ACK:'I_UNDERSTAND_THE_RISKS',GATE_API_KEY:'MEMORY',GATE_API_SECRET:'MEMORY',BYBIT_API_KEY:'MEMORY',BYBIT_API_SECRET:'MEMORY'}});
  engine.snapshots=[...quotes.values()];engine.health.forEach(health=>{health.status='online';health.lastSuccess=now;});
  return {engine,store,quotes,requests,setAfterFill(fn:typeof afterFill){afterFill=fn;}};
}

/** Real tracker evidence for the existing economic execution fixtures, with independent public reads. */
function confirmAutomaticFunding(f:ReturnType<typeof fixture>){
  const now=Date.now();
  // Use genuine current paired observations without seeding an old confirmation window.
  (f.engine as any).fundingEntryStability.clear();
  for(const quote of f.quotes.values()){quote.timestamp=now;quote.observedAt=now;quote.fundingObservedAt=now;quote.takerFeeAt=now;}
  f.engine.snapshots=[...f.quotes.values()];
  const candidate=f.engine.currentOpportunities()[0];
  assert.equal(candidate.fundingEntryStability?.status,'confirmed');
  assert.equal(candidate.fundingEntryStability!.sampleCount,1);assert.equal(candidate.fundingEntryStability!.observedSpanMs,0);
  return candidate;
}

test('best-price Engine previews before auto and reaches the frozen goal despite index drift and used margin',async()=>{
  const f=fixture();
  const candidate=f.engine.currentOpportunities()[0];
  assert.equal(f.engine.autoEnabled,false);
  assert.equal(candidate.eligible,true,candidate.reasons.join('；'));
  assert.equal(candidate.entryBatch?.batchQuantity,.4);
  assert.equal(candidate.longQuantity,1);
  f.setAfterFill(count=>{
    if(count===2||count===4){
      for(const quote of f.quotes.values())quote.indexPrice=101;
      for(const account of f.engine.accounts.values())account.freeUsd=count===2?34.9:14.9;
    }
  });
  const position=await f.engine.open(candidate.id);
  assert.equal(position.status,'open');assert.equal(position.long.quantity,1);assert.equal(position.short.quantity,1);
  assert.equal(position.entryExecution?.targetQuantity,1);assert.equal(position.entryExecution?.completedBatches,3);
  assert.equal(position.entryExecution?.matchedQuantity,1);
  assert.deepEqual(f.requests.map(({exchange,request})=>[exchange,request.quantity,request.limitPrice,request.reduceOnly]),[
    ['bybit',.4,100.5,false],['gate',.4,100,false],['bybit',.4,100.5,false],['gate',.4,100,false],
    ['bybit',.2,100.5,false],['gate',.2,100,false],
  ]);
  assert.equal(f.engine.autoEnabled,false);assert.ok(position.profitExitPolicy);
});

test('actual automatic Engine entries carry the automatic gate through all common batches',async t=>{
  const f=fixture({automaticEconomics:true});f.engine.autoEnabled=true;
  t.after(()=>f.engine.stop());
  const candidate=confirmAutomaticFunding(f);
  assert.equal(candidate.eligible,true,candidate.reasons.join('；'));
  assert.ok(candidate.combinedExpectedNetUsd!>0);assert.ok(candidate.entryPriceEdgeBps!>20);
  const position=await (f.engine as any).openInternal(candidate.id,true);
  assert.equal(position.automaticEntry,true);assert.equal(position.status,'open');
  assert.equal(position.long.quantity,1);assert.equal(position.short.quantity,1);
  assert.equal(f.requests.length,6);assert.ok(f.requests.every(order=>!order.request.reduceOnly));
});

test('automatic Engine rejects a manually eligible negative full-target single-cycle net before any order',async t=>{
  const f=fixture();f.engine.autoEnabled=true;
  t.after(()=>f.engine.stop());
  const candidate=f.engine.currentOpportunities()[0];
  assert.equal(candidate.eligible,true);assert.ok(candidate.combinedExpectedNetUsd!<0);
  await assert.rejects((f.engine as any).openInternal(candidate.id,true),/完整目标单轮净收益/);
  assert.equal(f.requests.length,0);assert.equal(f.store.data.positions.length,0);
});

test('polling automatic selection uses the same net and raw-edge conjunction as WS selection',async t=>{
  const f=fixture();f.engine.autoEnabled=true;
  t.after(()=>f.engine.stop());
  await f.engine.tick();
  assert.equal(f.requests.length,0);assert.equal(f.store.data.positions.length,0);
  f.quotes.get('bybit')!.fundingRate=.05;
  for(const quote of f.quotes.values()){
    quote.bids[0].quantity=10;quote.asks[0].quantity=10;
  }
  confirmAutomaticFunding(f);
  await f.engine.tick();
  assert.equal(f.store.data.positions.length,1);
  assert.equal(f.store.data.positions[0].automaticEntry,true);
  assert.equal(f.requests.length,2);
});

test('net deterioration after the committed short fill still completes its hedge then stops expansion',async t=>{
  const f=fixture({automaticEconomics:true});f.engine.autoEnabled=true;
  t.after(()=>f.engine.stop());
  const candidate=confirmAutomaticFunding(f);
  f.setAfterFill(count=>{if(count===1)f.quotes.get('bybit')!.fundingRate=.00001;});
  const position=await (f.engine as any).openInternal(candidate.id,true);
  assert.equal(position.status,'open');assert.equal(position.long.quantity,.4);assert.equal(position.short.quantity,.4);
  assert.equal(f.requests.length,2);assert.ok(f.requests.every(order=>!order.request.reduceOnly));
  assert.match(position.entryExecution.stopReason,/单轮.*净收益/);
});

test('automatic next-batch edge at twenty bps stops additional opening while retaining the matched pair',async t=>{
  const f=fixture({automaticEconomics:true});f.engine.autoEnabled=true;
  t.after(()=>f.engine.stop());
  const candidate=confirmAutomaticFunding(f);
  f.setAfterFill(count=>{if(count===2){
    const short=f.quotes.get('bybit')!;short.bids[0].price=100.2;short.bids[1].price=100.19;
    short.asks[0].price=100.22;short.asks[1].price=100.23;
  }});
  const position=await (f.engine as any).openInternal(candidate.id,true);
  assert.equal(position.status,'open');assert.equal(position.long.quantity,.4);assert.equal(position.short.quantity,.4);
  assert.equal(f.requests.length,2);assert.equal(position.closeRequestedAt,undefined);
  assert.match(position.entryExecution.stopReason,/严格大于 20/);
});

test('later batch cancellation retains the earlier matched pair without sending another naked leg',async()=>{
  const f=fixture();
  const candidate=f.engine.currentOpportunities()[0];
  f.setAfterFill(count=>{if(count===2)void f.engine.control('pause');});
  const position=await f.engine.open(candidate.id);
  assert.equal(position.status,'open');assert.equal(position.long.quantity,.4);assert.equal(position.short.quantity,.4);
  assert.equal(f.requests.length,2);assert.ok(f.requests.every(order=>!order.request.reduceOnly));
  assert.ok(position.entryExecution?.stopReason);assert.equal(position.closeRequestedAt,undefined);
});

test('next batch and filled-short hedge check only their exact additional margin',async()=>{
  const f=fixture();f.store.data.config.maxEntryBatches=2;
  const candidate=f.engine.currentOpportunities()[0];
  f.setAfterFill(count=>{
    if(count===2){
      for(const quote of f.quotes.values()){quote.bids[0].quantity=.1;quote.asks[0].quantity=.1;}
      for(const account of f.engine.accounts.values())account.freeUsd=5.05;
    }
    // After selling this batch, no additional short margin is needed for its long-only hedge.
    if(count===3)f.engine.accounts.get('bybit')!.freeUsd=0;
  });
  const position=await f.engine.open(candidate.id);
  assert.equal(position.status,'open');assert.equal(position.long.quantity,.5);assert.equal(position.short.quantity,.5);
  assert.equal(f.requests.length,4);assert.ok(f.requests.every(order=>!order.request.reduceOnly));
  assert.equal(position.entryExecution?.completedBatches,2);
  assert.match(position.entryExecution?.stopReason??'',/分批次数/);
});

test('batch limit is validated and affects new entries without changing existing managers',()=>{
  const before=validateConfig({...defaultConfig}),after=validateConfig({...before,maxEntryBatches:3});
  assert.equal(configUpdatePolicy(before,after).entryOnly,true);
  assert.deepEqual(configUpdatePolicy(before,after).criticalFields,[]);
  assert.throws(()=>validateConfig({...before,maxEntryBatches:0}));
  assert.throws(()=>validateConfig({...before,maxEntryBatches:33}));
  assert.throws(()=>validateConfig({...before,maxEntryBatches:2.5}));
  const compatible={...before};delete compatible.maxEntryBatches;
  assert.equal(validateConfig(compatible).maxEntryBatches,undefined,'old saved policy remains byte-compatible for scoped maintenance');
});
