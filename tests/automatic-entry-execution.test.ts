import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Execution} from '../src/core/execution.js';
import {Store} from '../src/core/store.js';
import {calculateOpportunities} from '../src/core/strategy.js';
import {estimateAlignedEntryFees} from '../src/core/funding-carry.js';
import {defaultConfig} from '../src/shared/config.js';
import {automaticEntryAssessment} from '../src/shared/automatic-entry-policy.js';
import type {ExchangeAdapter,ExchangeId,MarketSnapshot,Opportunity,OrderRequest,OrderResult,Position} from '../src/shared/types.js';

function fixture(options:{top?:number;target?:number;fundingRate?:number;bufferBps?:number;maxBatches?:number;automatic?:boolean}={}){
  const tempRoot=path.resolve(tmpdir()),dir=mkdtempSync(path.join(tempRoot,'automatic-entry-execution-'));
  const config={...structuredClone(defaultConfig),mode:'live' as const,dataSource:'public' as const,entryPolicy:'aligned' as const,
    orderNotionalUsd:options.target??100,minEntryIocEdgeBps:0,minCombinedNetUsd:100,entryIocBufferBps:options.bufferBps??0,
    maxEntryBatches:options.maxBatches??8,maxOrderRetries:0,dualAdvantageEnabled:false};
  const store=new Store(path.join(dir,'state.json'),config),quotes=new Map<ExchangeId,MarketSnapshot>(),now=Date.now(),top=options.top??1000;
  for(const exchange of ['gate','bybit'] as const)quotes.set(exchange,{exchange,base:'BTC',symbol:'BTC/USDT:USDT',source:'public',
    markPrice:1,indexPrice:1,timestamp:now,observedAt:now,fundingRate:exchange==='gate'?0:options.fundingRate??.01,
    nextFundingTime:now+300000,intervalHours:8,fundingHistory:[],
    bids:exchange==='gate'?[{price:.9999,quantity:top},{price:.9998,quantity:10000}]:[{price:1.003,quantity:top},{price:1.0028,quantity:10000}],
    asks:exchange==='gate'?[{price:1,quantity:top},{price:1.0002,quantity:10000}]:[{price:1.0031,quantity:top},{price:1.0032,quantity:10000}],
    quantityStep:1,minQuantity:1,minNotional:1,contractSize:1,openInterestUsd:1e6,volume24hUsd:1e6,
    takerFeeRate:.0005,takerFeeAt:now,takerFeeSource:'exchange'});
  const leg=(side:'long'|'short')=>({exchange:side==='long'?'gate' as const:'bybit' as const,symbol:'BTC/USDT:USDT',side,
    quantity:0,entryPrice:0,markPrice:1,feesUsd:0,liquidationDistancePct:null});
  const p:Position={id:'automatic-entry-offline',base:'BTC',mode:'live',status:'opening',entryPolicy:'aligned',holdMode:'adaptive',
    ...(options.automatic===false?{}:{automaticEntry:true}),long:leg('long'),short:leg('short'),openedAt:now,plannedExitAt:now+300000,
    fundingUsd:0,feesUsd:0,transferCostUsd:0,spreadPnlUsd:0,realizedSpreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[]};
  store.data.positions.push(p);
  const sent:Array<{exchange:ExchangeId;request:OrderRequest}>=[],phases:string[]=[],adapters=new Map<ExchangeId,ExchangeAdapter>();
  const result=(request:OrderRequest):OrderResult=>({id:request.clientOrderId,clientOrderId:request.clientOrderId,status:'filled',
    filledQuantity:request.quantity,averagePrice:request.limitPrice,averagePriceVerified:true,feeUsd:request.quantity*request.limitPrice*.0005,timestamp:Date.now()});
  for(const exchange of ['gate','bybit'] as const)adapters.set(exchange,{validateOrder:async()=>{},
    placeOrder:async(request:OrderRequest)=>{sent.push({exchange,request});return result(request);},
    reconcileOrder:async()=>{throw new Error('Unexpected offline reconciliation');}} as unknown as ExchangeAdapter);
  const opportunity=()=>calculateOpportunities([...quotes.values()],config)[0];
  const validate=async(phase='initial')=>{phases.push(phase);return opportunity();};
  const execution=new Execution(store,{config:()=>config,snapshot:exchange=>quotes.get(exchange as ExchangeId),
    // This fixture isolates the original economic thresholds; actual sustained evidence has separate integration coverage.
    adapter:exchange=>adapters.get(exchange as ExchangeId)!,liveUnlocked:()=>true,assertAutomaticEntryStability:()=>{},halt:()=>{},
    refreshSnapshots:async()=>{for(const snapshot of quotes.values()){snapshot.timestamp=Date.now();snapshot.observedAt=Date.now();snapshot.takerFeeAt=Date.now();}}});
  const cleanup=()=>{const target=path.resolve(dir),relative=path.relative(tempRoot,target);
    assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(target).startsWith('automatic-entry-execution-'));
    rmSync(target,{recursive:true,force:true});};
  return {p,store,config,quotes,sent,phases,adapters,execution,opportunity,validate,result,cleanup};
}
const noOrders=(f:ReturnType<typeof fixture>)=>{assert.equal(f.sent.length,0);assert.equal(f.store.data.orders.length,0);assert.equal(f.p.long.quantity,0);assert.equal(f.p.short.quantity,0);};

test('marked automatic entry accepts positive current net after exactly four real fee charges and does not apply the old configured dollar hurdle',async()=>{
  const f=fixture({fundingRate:.0025});try{
    const o=f.opportunity();assert.equal(o.eligible,true);assert.equal(automaticEntryAssessment(o).passes,true);
    assert.ok(o.combinedExpectedNetUsd!>0&&o.combinedExpectedNetUsd!<.05);
    assert.equal(o.combinedExpectedNetUsd,o.expectedFundingUsd-o.feesUsd);
    assert.ok(o.expectedFundingUsd-o.feesUsd*2<0,'Charging all four fees twice would wrongly block this case.');
    await f.execution.open(f.p,100,100,f.validate);
    assert.equal(f.p.status,'open');assert.equal(f.sent.length,2);assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);
  }finally{f.cleanup();}
});

test('manual and historical unmarked entries keep their existing rule when raw edge is below 20 and one-cycle net is negative',async()=>{
  for(const marker of [undefined,false]){const f=fixture({automatic:false,fundingRate:.001});try{
    f.p.automaticEntry=marker;f.quotes.get('bybit')!.bids=[{price:1.001,quantity:1000}];f.quotes.get('bybit')!.asks=[{price:1.0011,quantity:1000}];
    assert.ok(f.opportunity().combinedExpectedNetUsd!<0);assert.ok(f.opportunity().entryPriceEdgeBps!<20);
    await f.execution.open(f.p,100,100,f.validate);assert.equal(f.p.status,'open');assert.equal(f.sent.length,2);
  }finally{f.cleanup();}}
});

test('automatic direct execution rejects nonpositive or unknown full-target net and missing batch metadata before a first intent',async()=>{
  for(const patch of [{combinedExpectedNetUsd:-1},{combinedExpectedNetUsd:0},{combinedExpectedNetUsd:null},
    {combinedExpectedNetUsd:NaN},{entryBatch:undefined}] as Partial<Opportunity>[]){
    const f=fixture();try{
      const o={...f.opportunity(),...patch};let committed=false;
      await assert.rejects(f.execution.open(f.p,100,100,async()=>o,()=>{committed=true;}),/自动开仓/);
      noOrders(f);assert.equal(committed,false);
    }finally{f.cleanup();}
  }
});

test('automatic fresh raw opposite-1 edge is strict at 20 bps even when supplied opportunity metadata claims a higher edge',async()=>{
  for(const price of [1.002,1.0019]){const f=fixture();try{
    f.quotes.get('bybit')!.bids=[{price,quantity:1000}];f.quotes.get('bybit')!.asks=[{price:price+.0001,quantity:1000}];
    const o={...f.opportunity(),eligible:true,entryPriceEdgeBps:30};assert.equal(automaticEntryAssessment(o).passes,true);
    await assert.rejects(f.execution.open(f.p,100,100,async()=>o),/当前本批对手价1.*20 bps/);noOrders(f);
  }finally{f.cleanup();}}
});

test('marked automatic entry cannot bypass the batch rule through the legacy funding or historical policy path',async()=>{
  for(const policy of ['funding','dual'] as const){const f=fixture();try{
    f.p.entryPolicy=policy;await assert.rejects(f.execution.open(f.p,100,100,f.validate),/对手价1共同批次/);noOrders(f);
  }finally{f.cleanup();}}
});

test('positive funding after four fees survives IOC price buffering while price advantage remains positive',async()=>{
  const f=fixture({fundingRate:.003,bufferBps:8});try{
    f.quotes.get('gate')!.asks[1].price=1.0007;f.quotes.get('bybit')!.bids[1].price=1.0023;
    const o=f.opportunity();assert.equal(automaticEntryAssessment(o).passes,true);assert.ok(o.entryBatch!.expectedNetUsd!>0);
    assert.equal(o.entryBatch!.longLimitPrice,1.0007);assert.equal(o.entryBatch!.shortLimitPrice,1.0023);
    await f.execution.open(f.p,100,100,async()=>o);
    assert.equal(f.p.status,'open');assert.equal(f.sent.length,2);assert.ok(o.entryLimitPriceEdgeBps!>0);
  }finally{f.cleanup();}
});

test('an exactly zero current batch net cannot pass by receiving positive cached full-target metadata',async()=>{
  const f=fixture();try{
    const fees=estimateAlignedEntryFees(f.quotes.get('gate')!,f.quotes.get('bybit')!,100,f.config,
      {longOpenPrice:1,shortOpenPrice:1.003});
    f.quotes.get('bybit')!.fundingRate=fees/100;
    const real=f.opportunity();assert.equal(real.combinedExpectedNetUsd,0);
    const cached={...real,combinedExpectedNetUsd:1};assert.equal(automaticEntryAssessment(cached).passes,true);
    await assert.rejects(f.execution.open(f.p,100,100,async()=>cached),/本批单轮净收益大于 0/);noOrders(f);
  }finally{f.cleanup();}
});

test('automatic aligned batch does not require future closing depth or deduct its diagnostic book loss',async()=>{
  for(const closing of ['missing','costly'] as const){const f=fixture({fundingRate:.0025});try{
    const long=f.quotes.get('gate')!,short=f.quotes.get('bybit')!;
    long.bids=closing==='missing'?[]:[{price:.75,quantity:1000}];
    short.asks=closing==='missing'?[]:[{price:1.25,quantity:1000}];
    const o=f.opportunity();assert.equal(o.eligible,true);assert.equal(automaticEntryAssessment(o).route,'single-cycle');
    assert.ok(o.combinedExpectedNetUsd!>0);
    if(closing==='costly')assert.ok(o.bookCost!.roundTripBookLossUsd>o.expectedFundingUsd);
    else assert.equal(o.bookCost,undefined);
    await f.execution.open(f.p,100,100,f.validate);assert.equal(f.sent.length,2);assert.equal(f.p.status,'open');
  }finally{f.cleanup();}}
});

test('fresh funding or native fee changes during awaited private validation cannot use stale positive opportunity forecasts',async()=>{
  for(const change of ['funding','fee'] as const){const f=fixture({fundingRate:.0025});try{
    const cached=f.opportunity();assert.equal(automaticEntryAssessment(cached).passes,true);
    f.adapters.get('gate')!.validateOrder=async()=>{
      await new Promise<void>(resolve=>setImmediate(resolve));
      if(change==='funding')f.quotes.get('bybit')!.fundingRate=.0001;
      else for(const quote of f.quotes.values())quote.takerFeeRate=.002;
    };
    await assert.rejects(f.execution.open(f.p,100,100,async()=>cached),/本批单轮净收益大于 0/);noOrders(f);
  }finally{f.cleanup();}}
});

test('a fresh raw-edge loss inside the original buffered IOC bounds is rechecked after private validation',async()=>{
  const f=fixture({bufferBps:8});try{
    f.quotes.get('gate')!.asks[1].price=1.0007;f.quotes.get('bybit')!.bids[1].price=1.0023;
    const cached=f.opportunity();assert.equal(automaticEntryAssessment(cached).passes,true);
    f.adapters.get('gate')!.validateOrder=async()=>{
      f.quotes.get('gate')!.asks=[{price:1.0007,quantity:1000}];f.quotes.get('bybit')!.bids=[{price:1.0023,quantity:1000}];
    };
    await assert.rejects(f.execution.open(f.p,100,100,async()=>cached),/当前本批对手价1.*20 bps/);noOrders(f);
  }finally{f.cleanup();}
});

test('a later newly matched batch whose funding no longer covers its own four fees stops expansion and retains the earlier hedge',async()=>{
  const f=fixture({top:40});try{
    const cached=f.opportunity(),gate=f.adapters.get('gate')!,place=gate.placeOrder.bind(gate);
    gate.placeOrder=async request=>{const receipt=await place(request);if(!request.reduceOnly)f.quotes.get('bybit')!.fundingRate=.0001;return receipt;};
    await f.execution.open(f.p,100,100,async()=>cached);
    assert.equal(f.sent.length,2);assert.equal(f.p.long.quantity,40);assert.equal(f.p.short.quantity,40);assert.equal(f.p.status,'open');
    assert.match(f.p.entryExecution!.stopReason!,/本批单轮净收益大于 0/);assert.equal(f.p.closeRequestedAt,undefined);
  }finally{f.cleanup();}
});

test('a confirmed short still gets its existing matched long supplement when current raw edge and net no longer qualify for a new automatic batch',async()=>{
  const f=fixture({top:40,target:40,maxBatches:1});try{
    const bybit=f.adapters.get('bybit')!,place=bybit.placeOrder.bind(bybit);
    bybit.placeOrder=async request=>{const receipt=await place(request);if(!request.reduceOnly){
      f.quotes.get('gate')!.asks=[{price:1.002,quantity:40}];f.quotes.get('bybit')!.fundingRate=.0001;
    }return receipt;};
    await f.execution.open(f.p,40,40,f.validate);
    assert.equal(automaticEntryAssessment(f.opportunity()).passes,false);assert.equal(f.sent.length,2);
    assert.equal(f.sent[1].request.limitPrice,1.002);assert.equal(f.sent.some(order=>order.request.reduceOnly),false);
    assert.equal(f.p.long.quantity,40);assert.equal(f.p.short.quantity,40);assert.equal(f.p.status,'open');assert.ok(f.phases.includes('supplement'));
  }finally{f.cleanup();}
});

test('the final smaller remainder re-sweeps its actual 20 coins rather than the opportunity larger 40-coin first-batch metadata',async()=>{
  const f=fixture({top:40});try{
    const cached=f.opportunity();assert.equal(cached.entryBatch!.batchQuantity,40);
    const gate=f.adapters.get('gate')!,place=gate.placeOrder.bind(gate);let buys=0;
    gate.placeOrder=async request=>{const receipt=await place(request);if(!request.reduceOnly&&++buys===2){
      f.quotes.get('gate')!.bids=[{price:.9999,quantity:20}];f.quotes.get('bybit')!.asks=[{price:1.0031,quantity:20}];
    }return receipt;};
    await f.execution.open(f.p,100,100,async()=>cached);
    assert.deepEqual(f.sent.map(order=>order.request.quantity),[40,40,40,40,20,20]);assert.equal(f.p.status,'open');
    assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);
  }finally{f.cleanup();}
});

test('the new price route permits a large positive basis with positive funding without pretending it is assured single-cycle income',async()=>{
  const f=fixture({fundingRate:.001});try{
    f.quotes.get('bybit')!.bids=[{price:1.012,quantity:1000}];f.quotes.get('bybit')!.asks=[{price:1.0121,quantity:1000}];
    const real=f.opportunity();assert.ok(real.entryPriceEdgeBps!>20);assert.ok(real.combinedExpectedNetUsd!<0);
    const cached={...real,eligible:true};
    await f.execution.open(f.p,100,100,async()=>cached);
    assert.equal(f.p.status,'open');assert.equal(f.sent.length,2);assert.equal(f.p.executionEvidence?.entryPath,'price-100');
    assert.ok(f.p.executionEvidence!.prediction!.singleCycleNetUsd!<0,'Negative forecast is stored as a forecast, not realized income.');
    assert.equal(f.p.realizedSpreadPnlUsd,0);
  }finally{f.cleanup();}
});

test('price-route thresholds are rechecked against real IOC limits before any durable intent',async()=>{
  const f=fixture({fundingRate:.0001,bufferBps:50});try{
    f.quotes.get('gate')!.asks=[{price:1,quantity:1000},{price:1.00274,quantity:1000}];
    f.quotes.get('bybit')!.bids=[{price:1.011,quantity:1000},{price:1.00826,quantity:1000}];
    f.quotes.get('bybit')!.asks=[{price:1.0111,quantity:1000}];
    const actual=f.opportunity();assert.ok(actual.entryPriceEdgeBps!>100);assert.ok(actual.entryLimitPriceEdgeBps!<80);
    assert.ok(actual.combinedExpectedNetUsd!<0);
    const forged={...actual,entryLimitPriceEdgeBps:110};
    await assert.rejects(f.execution.open(f.p,100,100,async()=>forged),/80 bps/);noOrders(f);
  }finally{f.cleanup();}
});

test('positive high price edge cannot admit zero or negative current funding',async()=>{
  for(const rate of [0,-.001]){const f=fixture({fundingRate:.0001});try{
    f.quotes.get('bybit')!.bids=[{price:1.012,quantity:1000}];f.quotes.get('bybit')!.asks=[{price:1.0121,quantity:1000}];
    const cached={...f.opportunity(),eligible:true};
    f.quotes.get('bybit')!.fundingRate=rate;
    await assert.rejects(f.execution.open(f.p,100,100,async()=>cached),/资金费/);noOrders(f);
  }finally{f.cleanup();}}
});

test('a price-route hedge cannot chase below 80 bps after the first short confirms',async()=>{
  const f=fixture({fundingRate:.0001,maxBatches:1});try{
    f.quotes.get('bybit')!.bids=[{price:1.012,quantity:1000}];f.quotes.get('bybit')!.asks=[{price:1.0121,quantity:1000}];
    const bybit=f.adapters.get('bybit')!,place=bybit.placeOrder.bind(bybit);
    bybit.placeOrder=async request=>{const receipt=await place(request);if(!request.reduceOnly)f.quotes.get('gate')!.asks=[{price:1.0041,quantity:1000}];return receipt;};
    await f.execution.open(f.p,100,100,f.validate);
    assert.equal(f.p.executionEvidence?.entryPath,'price-100');
    assert.equal(f.sent.filter(x=>x.exchange==='gate'&&!x.request.reduceOnly).length,0);
    assert.ok(f.sent.some(x=>x.request.reduceOnly));assert.equal(f.p.long.quantity,0);assert.equal(f.p.short.quantity,0);
  }finally{f.cleanup();}
});

test('Maker first leg uses verified lower maker fee, journals before sending and only hedges confirmed partial quantity',async()=>{
  const f=fixture({maxBatches:1});try{
    f.config.entryExecutionMode='maker-ioc';
    for(const s of f.quotes.values()){s.makerFeeRate=.0002;s.makerFeeAt=Date.now();s.makerFeeSource='exchange';}
    const bybit=f.adapters.get('bybit')!;
    bybit.placeOrder=async request=>{
      const journal=f.store.data.orders.find(x=>x.request.clientOrderId===request.clientOrderId)!;
      assert.equal(journal.request.postOnly,true);assert.equal(journal.executionEvidence?.method,'maker');
      f.sent.push({exchange:'bybit',request});
      return {...f.result(request),status:'partial',filledQuantity:37,feeUsd:37*request.limitPrice*.0002};
    };
    await f.execution.open(f.p,100,100,f.validate);
    assert.equal(f.sent[0].request.limitPrice,1.0031);assert.equal(f.sent[0].request.postOnly,true);
    assert.equal(f.sent[1].request.quantity,37);assert.equal(f.sent[1].request.postOnly,undefined);
    assert.equal(f.p.long.quantity,37);assert.equal(f.p.short.quantity,37);assert.equal(f.p.status,'open');
    assert.equal(f.p.executionEvidence?.method,'maker-ioc');
  }finally{f.cleanup();}
});

test('Maker first leg never submits or silently becomes taker when official maker fee is missing',async()=>{
  const f=fixture();try{
    f.config.entryExecutionMode='maker-ioc';
    await assert.rejects(f.execution.open(f.p,100,100,f.validate),/官方 Maker/);noOrders(f);
  }finally{f.cleanup();}
});

test('a terminal unfilled Maker never sends the opposite leg or repeats the original order',async()=>{
  const f=fixture();try{
    f.config.entryExecutionMode='maker-ioc';
    for(const s of f.quotes.values()){s.makerFeeRate=.0002;s.makerFeeAt=Date.now();s.makerFeeSource='exchange';}
    f.adapters.get('bybit')!.placeOrder=async request=>{f.sent.push({exchange:'bybit',request});return {...f.result(request),status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0};};
    await f.execution.open(f.p,100,100,f.validate);
    assert.equal(f.sent.length,1);assert.equal(f.p.long.quantity,0);assert.equal(f.p.short.quantity,0);assert.equal(f.p.status,'closed');
  }finally{f.cleanup();}
});

test('an unknown Maker original remains blocking and never triggers speculative hedging or rollback',async()=>{
  const f=fixture();try{
    f.config.entryExecutionMode='maker-ioc';
    for(const s of f.quotes.values()){s.makerFeeRate=.0002;s.makerFeeAt=Date.now();s.makerFeeSource='exchange';}
    f.adapters.get('bybit')!.placeOrder=async request=>{f.sent.push({exchange:'bybit',request});return {...f.result(request),status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:0};};
    await f.execution.open(f.p,100,100,f.validate);
    assert.equal(f.sent.length,1);assert.equal(f.store.data.orders.length,1);assert.equal(f.p.status,'attention');
  }finally{f.cleanup();}
});

test('Maker fees that expire or stop saving during private validation are checked again before creating an intent',async()=>{
  for(const change of ['missing','higher'] as const){const f=fixture();try{
    f.config.entryExecutionMode='maker-ioc';
    for(const s of f.quotes.values()){s.makerFeeRate=.0002;s.makerFeeAt=Date.now();s.makerFeeSource='exchange';}
    f.adapters.get('bybit')!.validateOrder=async()=>{
      if(change==='missing')delete f.quotes.get('bybit')!.makerFeeRate;
      else f.quotes.get('bybit')!.makerFeeRate=.0006;
    };
    await assert.rejects(f.execution.open(f.p,100,100,f.validate),/Maker 费率/);noOrders(f);
  }finally{f.cleanup();}}
});
