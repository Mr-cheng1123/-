import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Execution} from '../src/core/execution.js';
import {Store} from '../src/core/store.js';
import {calculateOpportunities} from '../src/core/strategy.js';
import {defaultConfig} from '../src/shared/config.js';
import type {ExchangeAdapter,ExchangeId,MarketSnapshot,OrderRequest,OrderResult,Position} from '../src/shared/types.js';

// All validation, order replies and quotes are local fixtures. No credentials or transport.
function fixture(options:{precheckFailure?:boolean;repair:'filled'|'zero'|'unknown';marginRefusal?:boolean;noRefresh?:boolean}){
  const root=path.resolve(tmpdir()),dir=mkdtempSync(path.join(root,'entry-compensation-'));
  const config={...defaultConfig,mode:'live' as const,dataSource:'public' as const,entryPolicy:'aligned' as const,
    minEntryIocEdgeBps:0,maxOrderRetries:1,maxEntryBatches:1,orderNotionalUsd:190,dualAdvantageEnabled:false};
  const store=new Store(path.join(dir,'state.json'),config),quotes=new Map<ExchangeId,MarketSnapshot>();
  for(const exchange of ['gate','bybit'] as const)quotes.set(exchange,{exchange,base:'BTC',symbol:'BTC/USDT:USDT',
    markPrice:1,indexPrice:1,timestamp:Date.now(),observedAt:Date.now(),fundingRate:exchange==='gate'?0:.005,
    nextFundingTime:Date.now()+300_000,intervalHours:8,fundingHistory:[],
    bids:[{price:exchange==='gate'?.999:1.012,quantity:1000}],asks:[{price:exchange==='gate'?1:1.013,quantity:1000}],
    quantityStep:1,minQuantity:1,minNotional:1,contractSize:1,openInterestUsd:1e6,volume24hUsd:1e6,source:'public',
    takerFeeRate:config.takerFees[exchange],takerFeeAt:Date.now(),takerFeeSource:'exchange'});
  const p:Position={id:'compensation-local',base:'BTC',mode:'live',status:'opening',entryPolicy:'aligned',holdMode:'adaptive',
    long:{exchange:'gate',symbol:'BTC/USDT:USDT',side:'long',quantity:0,entryPrice:0,markPrice:1,feesUsd:0,liquidationDistancePct:null},
    short:{exchange:'bybit',symbol:'BTC/USDT:USDT',side:'short',quantity:0,entryPrice:0,markPrice:1,feesUsd:0,liquidationDistancePct:null},
    openedAt:Date.now(),plannedExitAt:Date.now()+300_000,fundingUsd:0,feesUsd:0,transferCostUsd:0,spreadPnlUsd:0,realizedSpreadPnlUsd:0,
    netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[]};
  store.data.positions.push(p);
  const sent:Array<{exchange:ExchangeId;request:OrderRequest}>=[],scopes:Array<{longQuantity:number;shortQuantity:number}>=[];
  let longChecks=0,longSubmits=0,supplementChecks=0;
  const result=(request:OrderRequest,exchange:ExchangeId,q:number,status:OrderResult['status']):OrderResult=>({
    id:request.clientOrderId,clientOrderId:request.clientOrderId,status,filledQuantity:q,averagePrice:q?request.limitPrice:0,
    averagePriceVerified:true,feeUsd:q*request.limitPrice*config.takerFees[exchange],timestamp:Date.now()});
  const adapters=new Map<ExchangeId,ExchangeAdapter>();
  for(const exchange of ['gate','bybit'] as const)adapters.set(exchange,{
    id:exchange,fetchSnapshots:async()=>[],fetchAccount:async()=>({freeUsd:1000,equityUsd:1000,positions:[]}),
    prepareTrading:async()=>{},cancelOrder:async()=>{},fetchFundingPayments:async()=>[],close:async()=>{},
    validateOrder:async request=>{
      if(exchange==='gate'&&!request.reduceOnly&&++longChecks===3&&options.precheckFailure)throw new Error('local price precheck changed');
    },
    placeOrder:async request=>{
      assert.ok(store.data.orders.some(order=>order.request.clientOrderId===request.clientOrderId));sent.push({exchange,request});
      if(request.reduceOnly)return result(request,exchange,request.quantity,'filled');
      if(exchange==='bybit')return result(request,exchange,106,'partial');
      if(++longSubmits===1)return result(request,exchange,100,'partial');
      if(options.repair==='unknown')return result(request,exchange,0,'unknown');
      if(options.repair==='zero')return result(request,exchange,0,'cancelled');
      return result(request,exchange,request.quantity,'filled');
    },
    reconcileOrder:async request=>result(request,exchange,0,'unknown'),
  });
  const refresh=async()=>{for(const quote of quotes.values()){quote.timestamp=Date.now();quote.observedAt=Date.now();quote.takerFeeAt=Date.now();}};
  const execution=new Execution(store,{config:()=>store.data.config,snapshot:exchange=>quotes.get(exchange as ExchangeId),
    adapter:exchange=>adapters.get(exchange as ExchangeId)!,liveUnlocked:()=>true,halt:()=>{},
    ...(options.noRefresh?{}:{refreshSnapshots:refresh})});
  const validate=async(phase:'initial'|'batch'|'supplement'='initial',quantities?:{longQuantity:number;shortQuantity:number})=>{
    if(phase==='supplement'){
      if(quantities)scopes.push({...quantities});
      if(++supplementChecks>1&&options.marginRefusal)throw new Error('local fresh margin refusal');
    }
    const opportunity=calculateOpportunities([...quotes.values()],store.data.config)[0];
    return {...opportunity,longQuantity:190,shortQuantity:190};
  };
  const cleanup=()=>{const absolute=path.resolve(dir),relative=path.relative(root,absolute);
    assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(absolute).startsWith('entry-compensation-'));
    rmSync(absolute,{recursive:true,force:true});};
  return {p,store,sent,scopes,execution,validate,cleanup,longSubmits:()=>longSubmits};
}

test('a local unsent supplement precheck failure can use remaining original budget to complete exact 106 with fresh scoped checks',async()=>{
  const f=fixture({precheckFailure:true,repair:'filled'});try{
    await f.execution.open(f.p,190,190,f.validate);
    assert.equal(f.p.status,'open');assert.equal(f.p.long.quantity,106);assert.equal(f.p.short.quantity,106);
    assert.equal(f.longSubmits(),2);assert.deepEqual(f.scopes,[{longQuantity:106,shortQuantity:0},{longQuantity:6,shortQuantity:0}]);
    assert.equal(f.sent.some(order=>order.request.reduceOnly),false);
    const comparison=f.p.executionEvidence!.compensations![0];
    assert.equal(comparison.decision,'hedge');assert.equal(comparison.outcome,'hedged');assert.equal(comparison.hedgeFilledQuantity,6);
    assert.equal(comparison.unmatchedQuantity,6);assert.equal(f.p.entryExecution!.targetQuantity,190);
    assert.equal(f.p.fundingUsd,0,'forecast never enters booked funding');
  }finally{f.cleanup();}
});

test('a controlled hedge zero fill falls back to exact tail reduction and reports actual rollback separately from its prediction',async()=>{
  const f=fixture({precheckFailure:true,repair:'zero'});try{
    await f.execution.open(f.p,190,190,f.validate);
    assert.equal(f.p.status,'open');assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);
    assert.equal(f.longSubmits(),2);
    const comparison=f.p.executionEvidence!.compensations![0];
    assert.equal(comparison.decision,'hedge');assert.equal(comparison.outcome,'rollback');assert.equal(comparison.hedgeFilledQuantity,0);
    assert.equal(comparison.reducedShortQuantity,6);assert.equal(comparison.reducedLongQuantity,0);
    assert.deepEqual(f.sent.filter(order=>order.request.reduceOnly).map(order=>[order.exchange,order.request.quantity]),[['bybit',6]]);
  }finally{f.cleanup();}
});

test('three already submitted long orders exhaust the original budget and cannot cause a fourth compensation buy',async()=>{
  const f=fixture({repair:'zero'});try{
    await f.execution.open(f.p,190,190,f.validate);
    assert.equal(f.longSubmits(),3);assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);
    const comparison=f.p.executionEvidence!.compensations![0];
    assert.equal(comparison.constraint,'retry-budget');assert.equal(comparison.decision,'rollback');assert.equal(comparison.outcome,'rollback');
    assert.equal(comparison.hedgeFilledQuantity,0);assert.equal(comparison.reducedShortQuantity,6);
  }finally{f.cleanup();}
});

test('an unknown controlled hedge never sends a reduction or repeats its original order',async()=>{
  const f=fixture({precheckFailure:true,repair:'unknown'});try{
    await f.execution.open(f.p,190,190,f.validate);
    assert.equal(f.p.status,'attention');assert.equal(f.longSubmits(),2);assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,106);
    assert.equal(f.sent.some(order=>order.request.reduceOnly),false);
    assert.equal(f.p.executionEvidence!.compensations![0].outcome,'unresolved');
    assert.equal(new Set(f.sent.map(order=>order.request.clientOrderId)).size,f.sent.length);
  }finally{f.cleanup();}
});

test('fresh margin refusal prevents the prospective repair and falls back to reducing only its six known coins',async()=>{
  const f=fixture({precheckFailure:true,repair:'filled',marginRefusal:true});try{
    await f.execution.open(f.p,190,190,f.validate);
    assert.equal(f.longSubmits(),1);assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);
    const comparison=f.p.executionEvidence!.compensations![0];
    assert.equal(comparison.constraint,'validation-failed');assert.equal(comparison.decision,'rollback');assert.equal(comparison.outcome,'rollback');
    assert.equal(comparison.reducedShortQuantity,6);
  }finally{f.cleanup();}
});

test('a cached book without a refresh transport cannot approve another confirmed-cancellation supplement',async()=>{
  const f=fixture({repair:'filled',noRefresh:true});try{
    await f.execution.open(f.p,190,190,f.validate);
    assert.equal(f.longSubmits(),1);assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);
    assert.equal(f.p.executionEvidence!.compensations![0].constraint,'no-fresh-refresh');
  }finally{f.cleanup();}
});

test('a local save error after a confirmed compensation fill preserves its attempted choice and completed hedge',async()=>{
  const f=fixture({precheckFailure:true,repair:'filled'});try{
    const save=f.store.save.bind(f.store);let thrown=false;
    f.store.save=()=>{
      if(!thrown&&f.p.long.quantity===106&&f.store.data.orders.some(order=>!order.request.reduceOnly&&order.exchange==='gate'&&
        order.request.quantity===6&&order.result?.status==='filled')){thrown=true;throw new Error('local simulated post-reply save failure');}
      save();
    };
    await f.execution.open(f.p,190,190,f.validate);
    assert.equal(thrown,true);assert.equal(f.longSubmits(),2);assert.equal(f.p.long.quantity,106);assert.equal(f.p.short.quantity,106);
    const comparison=f.p.executionEvidence!.compensations![0];
    assert.equal(comparison.decision,'hedge');assert.equal(comparison.outcome,'hedged');assert.equal(comparison.hedgeFilledQuantity,6);
    assert.equal(f.sent.some(order=>order.request.reduceOnly),false);
  }finally{f.cleanup();}
});
