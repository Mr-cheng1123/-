import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Execution,UncertainOrderError} from '../src/core/execution.js';
import {Store} from '../src/core/store.js';
import {defaultConfig} from '../src/shared/config.js';
import {executionStatistics} from '../src/core/execution-statistics.js';
import {performanceSummary} from '../src/core/performance-summary.js';
import {normalizeOrderReceipt,safeOrderConfirmation} from '../src/shared/order-receipt-validity.js';
import type {ExchangeAdapter,MarketSnapshot,OrderRequest,OrderResult,Position} from '../src/shared/types.js';

const reply=(request:OrderRequest,overrides:Partial<OrderResult>={}):OrderResult=>({id:'original-native',clientOrderId:request.clientOrderId,
  status:'filled',filledQuantity:request.quantity,averagePrice:101,averagePriceVerified:true,feeUsd:.1,timestamp:Date.now(),...overrides});
const unknown=(request:OrderRequest,quantity=0):OrderResult=>reply(request,{id:quantity?'original-native':'',status:'unknown',
  filledQuantity:quantity,averagePrice:quantity?101:0,feeUsd:quantity*.01});

test('a later confirmed receipt clears a prior unknown diagnostic without losing prior evidence while still unknown',()=>{
  const request:OrderRequest={clientOrderId:'late-receipt',base:'TEST',symbol:'TEST/USDT:USDT',side:'sell',quantity:10,limitPrice:100,reduceOnly:false};
  const prior:OrderResult={...unknown(request),confirmation:{stage:'order-read',reason:'not-found'}};
  const unresolved=normalizeOrderReceipt(request,unknown(request),Date.now(),prior);
  assert.equal(unresolved.status,'unknown');assert.deepEqual(unresolved.confirmation,prior.confirmation);
  const final=normalizeOrderReceipt(request,reply(request),Date.now(),prior);
  assert.equal(final.status,'filled');assert.equal(final.confirmation,undefined);
  assert.equal(final.filledQuantity,10);assert.equal(final.feeUsd,.1);
  assert.deepEqual(prior.confirmation,{stage:'order-read',reason:'not-found'});
});
function fixture(place:(request:OrderRequest)=>OrderResult,get?:(request:OrderRequest,id?:string)=>OrderResult){
  const tempRoot=path.resolve(tmpdir()),dir=mkdtempSync(path.join(tempRoot,'receipt-identity-'));
  const store=new Store(path.join(dir,'state.json'),{...defaultConfig,mode:'live',dataSource:'public',entryPolicy:'aligned'});
  const s:MarketSnapshot={exchange:'bybit',base:'BTC',symbol:'BTC/USDT:USDT',source:'public',timestamp:Date.now(),observedAt:Date.now(),
    markPrice:101,indexPrice:101,fundingRate:.001,nextFundingTime:Date.now()+300_000,intervalHours:8,fundingHistory:[],
    bids:[{price:101,quantity:100}],asks:[{price:101.1,quantity:100}],quantityStep:1,minQuantity:1,minNotional:1,contractSize:1,
    volume24hUsd:1e6,openInterestUsd:1e6,takerFeeRate:.0005,takerFeeAt:Date.now(),takerFeeSource:'exchange'};
  const p:Position={id:'original-position',base:'BTC',mode:'live',status:'opening',entryPolicy:'aligned',holdMode:'adaptive',
    long:{exchange:'gate',symbol:s.symbol,side:'long',quantity:0,entryPrice:0,markPrice:101,feesUsd:0,liquidationDistancePct:null},
    short:{exchange:'bybit',symbol:s.symbol,side:'short',quantity:0,entryPrice:0,markPrice:101,feesUsd:0,liquidationDistancePct:null},
    openedAt:Date.now(),plannedExitAt:Date.now()+300_000,fundingUsd:0,feesUsd:0,transferCostUsd:0,spreadPnlUsd:0,realizedSpreadPnlUsd:0,
    netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[]};
  store.data.positions.push(p);
  let submissions=0;const queryIds:Array<string|undefined>=[];
  const adapter:ExchangeAdapter={id:'bybit',fetchSnapshots:async()=>[],fetchAccount:async()=>({freeUsd:1000,equityUsd:1000,positions:[]}),
    prepareTrading:async()=>{},cancelOrder:async()=>{},fetchFundingPayments:async()=>[],close:async()=>{},
    placeOrder:async request=>{submissions++;return place(request);},
    reconcileOrder:async(request,id)=>{queryIds.push(id);return get?.(request,id)??unknown(request);}};
  const execution=new Execution(store,{config:()=>store.data.config,snapshot:()=>s,adapter:()=>adapter,liveUnlocked:()=>true,halt:()=>{}});
  const cleanup=()=>{const target=path.resolve(dir),relative=path.relative(tempRoot,target);
    assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(target).startsWith('receipt-identity-'));
    rmSync(target,{recursive:true,force:true});};
  return {p,store,execution,queryIds,submissions:()=>submissions,order:()=>execution.order(p,p.short,'sell',10,false),cleanup};
}

test('normalization retains only safe confirmation labels when financial identities are rejected',()=>{
  const request:OrderRequest={clientOrderId:'MEMORY original',base:'BTC',symbol:'BTC/USDT:USDT',side:'sell',quantity:10,limitPrice:100,reduceOnly:false};
  const prior=unknown(request,5),candidate=reply(request,{clientOrderId:'FOREIGN',confirmation:{stage:'receipt',reason:'identity-mismatch',apiCode:'INVALID_ARGUMENT'}});
  const normalized=normalizeOrderReceipt(request,candidate,Date.now(),prior);
  assert.equal(normalized.status,'unknown');assert.equal(normalized.id,prior.id);assert.equal(normalized.filledQuantity,5);
  assert.deepEqual(normalized.confirmation,{stage:'receipt',reason:'identity-mismatch',apiCode:'INVALID_ARGUMENT'});
  for(const code of ['10001','-2010','INVALID_ARGUMENT'])
    assert.equal(safeOrderConfirmation({stage:'create',reason:'request-failed',apiCode:code,privatePayload:'SECRET'})?.apiCode,code);
  assert.deepEqual(safeOrderConfirmation({stage:'create',reason:'request-failed',apiCode:'PRIVATE SECRET',privatePayload:'SECRET'}),{stage:'create',reason:'request-failed'});
  assert.equal(safeOrderConfirmation({stage:'create',reason:'PRIVATE SECRET'}),undefined);
});

test('a foreign filled receipt cannot enter this position or forward its native ID to reconciliation',async()=>{
  const f=fixture(request=>reply(request,{id:'foreign-native',clientOrderId:'foreign-client'}));try{
    await assert.rejects(f.order,UncertainOrderError);assert.equal(f.p.short.quantity,0);assert.equal(f.p.feesUsd,0);
    assert.deepEqual(f.queryIds,[undefined]);assert.equal(f.submissions(),1);assert.equal(f.p.status,'attention');
    assert.equal(f.store.data.orders[0].result!.clientOrderId,f.store.data.orders[0].request.clientOrderId);
  }finally{f.cleanup();}
});

test('a foreign unknown receipt cannot forward an unverified native ID or its five-coin lower bound',async()=>{
  const f=fixture(request=>reply(request,{id:'foreign-native',clientOrderId:'foreign-client',status:'unknown',filledQuantity:5}));try{
    await assert.rejects(f.order,UncertainOrderError);assert.equal(f.p.short.quantity,0);assert.deepEqual(f.queryIds,[undefined]);
    assert.equal(f.store.data.orders[0].result!.status,'unknown');
  }finally{f.cleanup();}
});

test('a trusted original unknown lower bound survives a foreign response to the later GET',async()=>{
  const f=fixture(request=>unknown(request,5),request=>reply(request,{id:'foreign-native',clientOrderId:'foreign-client'}));try{
    await assert.rejects(f.order,UncertainOrderError);assert.equal(f.p.short.quantity,5);assert.equal(f.p.feesUsd,.05);
    assert.deepEqual(f.queryIds,['original-native']);assert.equal(f.store.data.orders[0].result!.filledQuantity,5);
    assert.equal(f.store.data.orders[0].result!.status,'unknown');assert.equal(f.submissions(),1);
  }finally{f.cleanup();}
});

test('a later cumulative quantity regression or changed native ID cannot discard five trusted original coins',async()=>{
  for(const changedId of [false,true]){
    const f=fixture(request=>unknown(request,5),request=>reply(request,changedId?{id:'different-native'}:{status:'cancelled',filledQuantity:0,feeUsd:0}));try{
      await assert.rejects(f.order,UncertainOrderError);assert.equal(f.p.short.quantity,5);assert.equal(f.p.feesUsd,.05);
      assert.equal(f.store.data.orders[0].result!.id,'original-native');assert.equal(f.store.data.orders[0].result!.status,'unknown');
    }finally{f.cleanup();}
  }
});

test('a claimed filled reply with partial quantity stays unknown while preserving its actual cumulative lower bound',async()=>{
  const f=fixture(request=>reply(request,{filledQuantity:5,feeUsd:.05}),request=>unknown(request,5));try{
    await assert.rejects(f.order,UncertainOrderError);assert.equal(f.p.short.quantity,5);assert.equal(f.p.status,'attention');
    assert.equal(f.store.data.orders[0].result!.status,'unknown');assert.equal(f.submissions(),1);
  }finally{f.cleanup();}
});

test('a zero-filled filled reply and an overfill smaller than an old lot-based allowance cannot become a known result',async()=>{
  for(const quantity of [0,10.05]){
    const f=fixture(request=>reply(request,{filledQuantity:quantity,averagePrice:quantity?101:0,feeUsd:0}));try{
      await assert.rejects(f.order,UncertainOrderError);assert.equal(f.p.short.quantity,0);assert.equal(f.p.feesUsd,0);
      assert.equal(f.store.data.orders[0].result!.status,'unknown');
    }finally{f.cleanup();}
  }
});

test('a documented empty-ID create refusal stays a known zero rather than a speculative retry',async()=>{
  const f=fixture(request=>reply(request,{id:'',status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,rejectionCode:'10001'}));try{
    const result=await f.order();assert.equal(result.status,'cancelled');assert.equal(f.p.short.quantity,0);
    assert.equal(f.queryIds.length,0);assert.equal(f.submissions(),1);
  }finally{f.cleanup();}
});

test('a native order ID already owned by another client cannot be counted as a second physical fill',async()=>{
  const f=fixture(request=>reply(request));try{
    await f.order();assert.equal(f.p.short.quantity,10);
    await assert.rejects(f.order,UncertainOrderError);assert.equal(f.p.short.quantity,10);assert.equal(f.p.feesUsd,.1);
    assert.deepEqual(f.queryIds,[undefined]);assert.equal(f.submissions(),2);
  }finally{f.cleanup();}
});

test('reconciliation cannot resolve an unknown zero as filled zero or double-apply one duplicated client intent',async()=>{
  const f=fixture(request=>unknown(request),request=>unknown(request));try{
    await assert.rejects(f.order,UncertainOrderError);const original=f.store.data.orders[0];
    assert.throws(()=>f.execution.applyObservedOrder(original,reply(original.request,{filledQuantity:0,averagePrice:0,feeUsd:0})),/累计成交/);
    f.store.data.orders.push(structuredClone(original));const before=structuredClone(f.p),queries=f.queryIds.length;
    await assert.rejects(()=>f.execution.reconcilePending(),/身份被多条记录复用/);assert.deepEqual(f.p,before);
    assert.equal(f.queryIds.length,queries,'duplicate identity blocks before even an original-order GET');
  }finally{f.cleanup();}
});

test('a generic adapter unknown fee preserves exact native identity and quantity, then applies the true fee exactly once',async()=>{
  let resolved=false;
  const f=fixture(request=>reply(request,{status:'unknown',filledQuantity:4,feeUsd:NaN}),
    request=>resolved?reply(request):reply(request,{status:'unknown',filledQuantity:4,feeUsd:NaN}));try{
    await assert.rejects(f.order,UncertainOrderError);assert.equal(f.p.short.quantity,4);assert.equal(f.p.feesUsd,0);
    const journal=f.store.data.orders[0];assert.equal(journal.result!.id,'original-native');assert.equal(journal.result!.filledQuantity,4);
    assert.equal(Number.isFinite(journal.result!.feeUsd),false);assert.notEqual(journal.result!.feeUsd,0);
    assert.equal(journal.executionEvidence!.bookedFeeUsd,0,'zero is only the actual amount applied to local cash');
    assert.deepEqual(f.queryIds,['original-native']);resolved=true;await f.execution.reconcilePending();
    assert.equal(f.p.short.quantity,10);assert.equal(f.p.feesUsd,.1);assert.equal(journal.executionEvidence!.bookedFeeUsd,.1);
    await f.execution.reconcilePending();assert.equal(f.p.short.quantity,10);assert.equal(f.p.feesUsd,.1);
    assert.equal(f.submissions(),1,'fee uncertainty never causes a second create request');
  }finally{f.cleanup();}
});

test('previous finite fee evidence survives an unknown total fee without converting it into a complete fee',async()=>{
  let resolved=false;
  const f=fixture(request=>unknown(request,4),request=>resolved?reply(request):reply(request,{status:'unknown',filledQuantity:5,feeUsd:NaN}));try{
    await assert.rejects(f.order,UncertainOrderError);assert.equal(f.p.short.quantity,5);assert.equal(f.p.feesUsd,.04);
    const journal=f.store.data.orders[0];assert.equal(Number.isFinite(journal.result!.feeUsd),false);assert.equal(journal.executionEvidence!.bookedFeeUsd,.04);
    resolved=true;await f.execution.reconcilePending();assert.equal(f.p.short.quantity,10);assert.equal(f.p.feesUsd,.1);
  }finally{f.cleanup();}
});

test('verified native average prices beyond the original IOC limit cannot become this order cash or approve a hedge',async()=>{
  const f=fixture(request=>reply(request,{averagePrice:100.9}));try{
    await assert.rejects(f.order,UncertainOrderError);assert.equal(f.p.short.quantity,0);assert.equal(f.p.feesUsd,0);
    assert.equal(f.store.data.orders[0].result!.status,'unknown');assert.equal(f.submissions(),1);
  }finally{f.cleanup();}
});

test('a rounded unverified native average can preserve quantity but cannot become a complete terminal receipt',async()=>{
  const f=fixture(request=>reply(request,{averagePrice:100.9999,averagePriceVerified:false}),
    request=>reply(request,{averagePrice:100.9999,averagePriceVerified:false}));try{
    await assert.rejects(f.order,UncertainOrderError);assert.equal(f.p.short.quantity,10);
    assert.equal(f.store.data.orders[0].result!.status,'unknown');assert.equal(f.submissions(),1);
  }finally{f.cleanup();}
});

test('a terminal zero-fill cancellation charge or rebate changes actual fees without poisoning entry price',async()=>{
  for(const fee of [.02,-.01]){
    const f=fixture(request=>reply(request,{status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:fee}));try{
      const result=await f.order();assert.equal(result.status,'cancelled');assert.equal(f.p.short.quantity,0);
      assert.equal(f.p.feesUsd,fee);assert.equal(f.p.short.feesUsd,fee);assert.equal(f.p.short.entryPrice,0);
      assert.equal(f.store.data.orders[0].executionEvidence!.bookedFeeUsd,fee);
      f.p.status='closed';f.p.closedAt=Date.now();
      const performance=performanceSummary([f.p],f.store.data.orders),statistics=executionStatistics([f.p],f.store.data.orders);
      assert.equal(performance.rows[0].category,'abnormal');assert.equal(performance.abnormal.netPnlUsd,-fee);
      assert.equal(statistics.rows[0].amounts.closedNetPnlUsd,-fee);assert.equal(statistics.amounts.rollbackCostUsd.valueUsd,fee);
    }finally{f.cleanup();}
  }
});
