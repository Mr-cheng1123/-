import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Execution,UncertainOrderError} from '../src/core/execution.js';
import {Store} from '../src/core/store.js';
import {defaultConfig} from '../src/shared/config.js';
import type {ExchangeAdapter,MarketSnapshot,OrderRequest,OrderResult,Position} from '../src/shared/types.js';

const near=(actual:number,expected:number)=>assert.ok(Number.isFinite(actual)&&Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);
function fixture(reduceOnly=false,initial:{quantity:number;price:number;verified?:boolean;fee?:number}={quantity:4,price:100,fee:NaN}){
  const tempRoot=path.resolve(tmpdir()),dir=mkdtempSync(path.join(tempRoot,'cash-reconcile-offline-'));
  const config={...defaultConfig,mode:'live' as const,dataSource:'public' as const,entryPolicy:'aligned' as const};
  const store=new Store(path.join(dir,'state.json'),config);
  const book:MarketSnapshot={exchange:'bybit',base:'BTC',symbol:'BTC/USDT:USDT',source:'public',timestamp:Date.now(),observedAt:Date.now(),
    markPrice:100,indexPrice:100,fundingRate:.001,nextFundingTime:Date.now()+300_000,intervalHours:8,fundingHistory:[],
    bids:[{price:99.9,quantity:100}],asks:[{price:100,quantity:100}],quantityStep:1,minQuantity:1,minNotional:1,contractSize:1,
    volume24hUsd:1e6,openInterestUsd:1e6,takerFeeRate:.0005,takerFeeAt:Date.now(),takerFeeSource:'exchange'};
  const p:Position={id:'cash-reconcile-position',base:'BTC',mode:'live',status:reduceOnly?'open':'opening',entryPolicy:'aligned',holdMode:'adaptive',
    long:{exchange:reduceOnly?'gate':'bybit',symbol:book.symbol,side:'long',quantity:0,entryPrice:0,markPrice:100,feesUsd:0,liquidationDistancePct:null},
    short:{exchange:reduceOnly?'bybit':'gate',symbol:book.symbol,side:'short',quantity:reduceOnly?10:0,entryPrice:reduceOnly?110:0,markPrice:100,feesUsd:0,liquidationDistancePct:null},
    openedAt:Date.now(),plannedExitAt:Date.now()+300_000,fundingUsd:0,feesUsd:0,transferCostUsd:0,spreadPnlUsd:0,realizedSpreadPnlUsd:0,
    netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[]};
  store.data.positions.push(p);
  const result=(request:OrderRequest,changes:Partial<OrderResult>={}):OrderResult=>({id:`native-${request.clientOrderId}`,
    clientOrderId:request.clientOrderId,status:'unknown',filledQuantity:initial.quantity,averagePrice:initial.price,
    averagePriceVerified:initial.verified??true,feeUsd:initial.fee??NaN,timestamp:Date.now(),...changes});
  let submits=0,queries=0,finalReply:Partial<OrderResult>|undefined;
  const adapter:ExchangeAdapter={id:'bybit',fetchSnapshots:async()=>[],fetchAccount:async()=>({freeUsd:1000,equityUsd:1000,positions:[]}),
    prepareTrading:async()=>{},cancelOrder:async()=>{},fetchFundingPayments:async()=>[],close:async()=>{},
    placeOrder:async request=>{submits++;return result(request);},
    reconcileOrder:async request=>{queries++;return result(request,finalReply);}};
  const context={config:()=>config,snapshot:()=>book,adapter:()=>adapter,liveUnlocked:()=>true,halt:()=>{}};
  const execution=new Execution(store,context),leg=()=>reduceOnly?p.short:p.long;
  const start=()=>execution.order(p,leg(),'buy',10,reduceOnly);
  const observed=(changes:Partial<OrderResult>={})=>result(store.data.orders[0].request,{status:'filled',filledQuantity:10,averagePrice:99,averagePriceVerified:true,feeUsd:-.01,...changes});
  const cleanup=()=>{const target=path.resolve(dir),relative=path.relative(tempRoot,target);
    assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(target).startsWith('cash-reconcile-offline-'));
    rmSync(target,{recursive:true,force:true});};
  return {p,store,execution,leg,start,observed,cleanup,context,submits:()=>submits,queries:()=>queries,setFinalReply:(value:Partial<OrderResult>)=>{finalReply=value;}};
}

test('a zero-fill native fee receipt with no average never changes an existing entry basis or realized cash',async()=>{
  for(const reduceOnly of [false,true]){
    const f=fixture(reduceOnly,{quantity:0,price:0,fee:NaN});try{
      if(!reduceOnly){f.p.long.quantity=2;f.p.long.entryPrice=98;}
      await assert.rejects(f.start,UncertainOrderError);const before=structuredClone(f.leg());
      assert.equal(f.execution.applyObservedOrder(f.store.data.orders[0],f.observed({status:'cancelled',filledQuantity:0,averagePrice:NaN,feeUsd:.02})),true);
      assert.equal(f.leg().quantity,before.quantity);assert.equal(f.leg().entryPrice,before.entryPrice);near(f.p.realizedSpreadPnlUsd,0);
      near(f.p.feesUsd,.02);assert.ok(Number.isFinite(f.p.netPnlUsd));assert.equal(f.submits(),1);
    }finally{f.cleanup();}
  }
});

test('unknown GET-only diagnostics persist without replacing any trusted fill, quantity, cash or observation time',async()=>{
  const f=fixture(false,{quantity:4,price:100,fee:.04});try{
    f.setFinalReply({confirmation:{stage:'create',reason:'request-failed',apiCode:'10001'}});
    await assert.rejects(f.start,UncertainOrderError);
    const journal=f.store.data.orders[0],before=structuredClone({p:f.p,result:journal.result});
    assert.match(journal.error!,/创建请求.*10001/);
    const logsBefore=f.store.data.logs.length;
    const observed=f.observed({status:'unknown',filledQuantity:9,averagePrice:99,feeUsd:999,timestamp:Date.now()+4000,
      confirmation:{stage:'order-read',reason:'not-found'}});
    assert.equal(f.execution.applyObservedOrder(journal,observed),false);
    assert.deepEqual(f.p,before.p);
    assert.deepEqual({...journal.result,confirmation:undefined},{...before.result,confirmation:undefined});
    assert.deepEqual(journal.result!.confirmation,{stage:'order-read',reason:'not-found'});
    assert.match(journal.error!,/暂未查到原订单/);assert.equal(journal.result!.status,'unknown');
    assert.equal(f.execution.applyObservedOrder(journal,observed),false);
    assert.equal(f.store.data.logs.length,logsBefore+1,'A changed failure is visible immediately; its identical repeat adds no warning');
    const persisted=JSON.parse(readFileSync(f.store.path,'utf8'));
    assert.equal(persisted.orders[0].result.status,'unknown');assert.equal(persisted.orders[0].result.filledQuantity,4);
    assert.equal(persisted.orders[0].result.timestamp,before.result!.timestamp);
    assert.deepEqual(persisted.orders[0].result.confirmation,{stage:'order-read',reason:'not-found'});
    assert.equal(f.submits(),1);
  }finally{f.cleanup();}
});

test('legacy journals retain the earliest available safe diagnostic before a changed, repeated or terminal observation',async()=>{
  for(const kind of ['changed','repeated','terminal']){
    const f=fixture(false,{quantity:4,price:100,fee:.04});try{
      await assert.rejects(f.start,UncertainOrderError);const journal=f.store.data.orders[0];
      journal.result!.confirmation={stage:'create',reason:'request-failed',apiCode:'10016'};
      assert.equal(journal.originalConfirmation,undefined);
      const observation=kind==='terminal'?f.observed():f.observed({status:'unknown',confirmation:kind==='changed'?
        {stage:'order-read',reason:'not-found'}:{stage:'create',reason:'request-failed',apiCode:'10016'}});
      assert.equal(f.execution.applyObservedOrder(journal,observation),kind==='terminal');
      assert.deepEqual(journal.originalConfirmation,{stage:'create',reason:'request-failed',apiCode:'10016'});
      const persisted=JSON.parse(readFileSync(f.store.path,'utf8'));
      assert.deepEqual(persisted.orders[0].originalConfirmation,journal.originalConfirmation);
      if(kind==='terminal'){
        assert.equal(journal.result!.status,'filled');assert.equal(journal.result!.confirmation,undefined);
        near(f.p.long.quantity,10);near(f.p.feesUsd,-.01);
      }else{assert.equal(journal.result!.status,'unknown');near(f.p.long.quantity,4);near(f.p.feesUsd,.04);}
      assert.equal(f.submits(),1);
    }finally{f.cleanup();}
  }
});

test('pending reconciliation records safe unknown evidence and keeps the original order unresolved',async()=>{
  const f=fixture(false,{quantity:4,price:100,fee:.04});try{
    await assert.rejects(f.start,UncertainOrderError);const journal=f.store.data.orders[0];
    const before=structuredClone({p:f.p,result:journal.result});
    f.setFinalReply({confirmation:{stage:'order-read',reason:'request-failed',apiCode:'-2010'}});
    await assert.rejects(()=>f.execution.reconcilePending(f.p.id),UncertainOrderError);
    assert.deepEqual(f.p,before.p);
    assert.deepEqual({...journal.result,confirmation:undefined},{...before.result,confirmation:undefined});
    assert.deepEqual(journal.result!.confirmation,{stage:'order-read',reason:'request-failed',apiCode:'-2010'});
    assert.match(journal.error!,/-2010/);assert.equal(f.submits(),1);
  }finally{f.cleanup();}
});

test('first create failure survives an immediate original-order GET and subsequent diagnostic updates without cash mutation',async()=>{
  const f=fixture(false,{quantity:4,price:100,fee:.04});try{
    const firstAt=Date.now()-1000;
    const original={stage:'create' as const,reason:'request-failed' as const,apiCode:'110126',apiMessage:'Trading access unavailable',observedAt:firstAt};
    f.setFinalReply({originalConfirmation:original,confirmation:{stage:'order-read',reason:'not-found',observedAt:Date.now()},orderReadAt:Date.now()});
    await assert.rejects(f.start,UncertainOrderError);
    const journal=f.store.data.orders[0],before=structuredClone({p:f.p,result:journal.result});
    assert.deepEqual(journal.originalConfirmation,original);
    const readAt=Date.now();
    f.execution.applyObservedOrder(journal,f.observed({status:'unknown',filledQuantity:4,averagePrice:100,feeUsd:.04,
      originalConfirmation:{...original,apiCode:'10001'},confirmation:{stage:'order-read',reason:'request-failed',apiCode:'10002',observedAt:readAt},orderReadAt:readAt}));
    assert.deepEqual(journal.originalConfirmation,original);assert.equal(journal.result!.confirmation?.stage,'order-read');
    assert.equal(journal.result!.confirmation?.apiCode,'10002');assert.equal(journal.result!.orderReadAt,readAt);
    assert.equal(journal.result!.timestamp,before.result!.timestamp);assert.deepEqual(f.p,before.p);
    assert.equal(journal.result!.filledQuantity,4);assert.equal(journal.result!.feeUsd,.04);assert.equal(f.submits(),1);
  }finally{f.cleanup();}
});

test('an unchanged unknown-query reason still persists the latest GET time without refreshing execution time or cash',async()=>{
  const f=fixture(false,{quantity:4,price:100,fee:.04});try{
    await assert.rejects(f.start,UncertainOrderError);const journal=f.store.data.orders[0];
    const diagnostic={stage:'order-read' as const,reason:'not-found' as const};
    journal.result!.confirmation=diagnostic;journal.result!.orderReadAt=Date.now()-1000;
    const before=structuredClone({p:f.p,result:journal.result}),readAt=Date.now();
    assert.equal(f.execution.applyObservedOrder(journal,f.observed({status:'unknown',filledQuantity:4,averagePrice:100,feeUsd:.04,confirmation:diagnostic,orderReadAt:readAt})),false);
    const persisted=JSON.parse(readFileSync(f.store.path,'utf8'));
    assert.equal(persisted.orders[0].result.orderReadAt,readAt);
    assert.equal(persisted.orders[0].result.timestamp,before.result!.timestamp);
    assert.deepEqual(f.p,before.p);assert.equal(f.submits(),1);
  }finally{f.cleanup();}
});

test('foreign or free-form unknown diagnostics cannot leak payloads or mutate a journal',async()=>{
  const f=fixture(false,{quantity:4,price:100,fee:.04});try{
    await assert.rejects(f.start,UncertainOrderError);const journal=f.store.data.orders[0];
    const before=structuredClone({p:f.p,journal});
    for(const changes of [
      {clientOrderId:'FOREIGN',confirmation:{stage:'receipt',reason:'fee-unverified'}},
      {confirmation:{stage:'receipt',reason:'PRIVATE RESPONSE SECRET'}},
    ] as Array<Partial<OrderResult>>){
      assert.equal(f.execution.applyObservedOrder(journal,f.observed({status:'unknown',...changes})),false);
      assert.deepEqual({p:f.p,journal},before);
    }
    f.execution.applyObservedOrder(journal,f.observed({status:'unknown',confirmation:{stage:'receipt',reason:'fee-unverified',apiCode:'PRIVATE SECRET WITH SPACES'}}));
    assert.deepEqual(journal.result!.confirmation,{stage:'receipt',reason:'fee-unverified'});
    assert.ok(!JSON.stringify(f.store.data).includes('PRIVATE SECRET'));
    assert.deepEqual(f.p,before.p);assert.equal(f.submits(),1);
  }finally{f.cleanup();}
});

test('malformed old unknown quantities and foreign lower-bound identities cannot enter a cumulative cash correction',async()=>{
  for(const mutate of [(old:OrderResult)=>{old.filledQuantity=NaN;},(old:OrderResult)=>{old.filledQuantity=-1;},
    (old:OrderResult)=>{old.clientOrderId='foreign-original';},(old:OrderResult)=>{old.averagePrice=NaN;}]){
    const f=fixture();try{
      await assert.rejects(f.start,UncertainOrderError);const journal=f.store.data.orders[0];mutate(journal.result!);
      const before=structuredClone({p:f.p,journal});assert.throws(()=>f.execution.applyObservedOrder(journal,f.observed()),/旧订单|累计成交/);
      assert.deepEqual({p:f.p,journal},before);assert.equal(f.submits(),1);
    }finally{f.cleanup();}
  }
});

test('unknown local paid or realized cash is never silently reset by a complete new native fee receipt',async()=>{
  for(const mutate of [(p:Position)=>{p.feesUsd=NaN;},(p:Position)=>{p.long.feesUsd=null as unknown as number;},
    (p:Position)=>{p.realizedSpreadPnlUsd=NaN;}]){
    const f=fixture();try{
      await assert.rejects(f.start,UncertainOrderError);mutate(f.p);const journal=f.store.data.orders[0],before=structuredClone({p:f.p,journal});
      assert.throws(()=>f.execution.applyObservedOrder(journal,f.observed()),/旧订单|本地账本/);
      assert.deepEqual({p:f.p,journal},before);assert.equal(journal.result!.status,'unknown');
    }finally{f.cleanup();}
  }
});

test('a same-quantity native price correction cannot make a contradictory local opening basis negative',async()=>{
  const f=fixture(false,{quantity:4,price:100,verified:false,fee:NaN});try{
    await assert.rejects(f.start,UncertainOrderError);f.p.long.entryPrice=2;
    const journal=f.store.data.orders[0],before=structuredClone({p:f.p,journal});
    assert.throws(()=>f.execution.applyObservedOrder(journal,f.observed({status:'partial',filledQuantity:4,averagePrice:1})),/本地账本|累计开仓均价/);
    assert.deepEqual({p:f.p,journal},before);
  }finally{f.cleanup();}
});

test('an unverified earlier opening average can be replaced by verified cumulative cash without inventing a negative incremental fill',async()=>{
  const f=fixture(false,{quantity:4,price:100,verified:false,fee:NaN});try{
    await assert.rejects(f.start,UncertainOrderError);near(f.p.long.quantity,4);near(f.p.long.entryPrice,100);
    assert.equal(f.execution.applyObservedOrder(f.store.data.orders[0],f.observed({status:'partial',filledQuantity:5,averagePrice:40})),true);
    near(f.p.long.quantity,5);near(f.p.long.entryPrice,40);near(f.p.realizedSpreadPnlUsd,0);near(f.p.feesUsd,-.01);
    assert.equal(f.execution.applyObservedOrder(f.store.data.orders[0],f.observed({status:'partial',filledQuantity:5,averagePrice:40})),false);
    near(f.p.long.quantity,5);near(f.p.feesUsd,-.01);assert.equal(f.submits(),1);
  }finally{f.cleanup();}
});

test('verified cumulative cash corrects an unverified partial reduction once and preserves the remaining entry basis',async()=>{
  const f=fixture(true,{quantity:4,price:100,verified:false,fee:NaN});try{
    await assert.rejects(f.start,UncertainOrderError);near(f.p.short.quantity,6);near(f.p.realizedSpreadPnlUsd,40);
    assert.equal(f.execution.applyObservedOrder(f.store.data.orders[0],f.observed({status:'partial',filledQuantity:5,averagePrice:40})),true);
    near(f.p.short.quantity,5);near(f.p.short.entryPrice,110);near(f.p.realizedSpreadPnlUsd,350);near(f.p.short.realizedPnlUsd!,350);
    near(f.p.feesUsd,-.01);await f.execution.reconcilePending();near(f.p.realizedSpreadPnlUsd,350);assert.equal(f.submits(),1);
  }finally{f.cleanup();}
});

test('a contradictory verified incremental cash price remains unresolved instead of overriding an exact previous execution',async()=>{
  const f=fixture(false,{quantity:4,price:100,verified:true,fee:NaN});try{
    await assert.rejects(f.start,UncertainOrderError);const journal=f.store.data.orders[0],before=structuredClone({p:f.p,journal});
    assert.throws(()=>f.execution.applyObservedOrder(journal,f.observed({status:'partial',filledQuantity:5,averagePrice:40})),/增量成交/);
    assert.deepEqual({p:f.p,journal},before);
  }finally{f.cleanup();}
});

test('verified cumulative averages cannot conceal a new incremental price beyond the original IOC cap',async()=>{
  const f=fixture(false,{quantity:4,price:98,verified:true,fee:NaN});try{
    await assert.rejects(f.start,UncertainOrderError);const journal=f.store.data.orders[0],before=structuredClone({p:f.p,journal});
    // Both cumulative averages are below 100, but the newly claimed single coin would cost 103.
    assert.throws(()=>f.execution.applyObservedOrder(journal,f.observed({status:'partial',filledQuantity:5,averagePrice:99})),/增量成交/);
    assert.deepEqual({p:f.p,journal},before);
  }finally{f.cleanup();}
});

test('a new unverified terminal average cannot finish unknown cash reconciliation or remove its blocker',async()=>{
  const f=fixture();try{
    await assert.rejects(f.start,UncertainOrderError);const journal=f.store.data.orders[0],before=structuredClone({p:f.p,journal});
    assert.throws(()=>f.execution.applyObservedOrder(journal,f.observed({averagePriceVerified:false})),/累计成交|均价/);
    assert.deepEqual({p:f.p,journal},before);assert.equal(journal.result!.status,'unknown');
  }finally{f.cleanup();}
});

test('actual fee corrections may refund earlier charges while cumulative quantity and price are applied once',async()=>{
  const f=fixture(false,{quantity:4,price:98,verified:true,fee:.04});try{
    await assert.rejects(f.start,UncertainOrderError);near(f.p.feesUsd,.04);
    assert.equal(f.execution.applyObservedOrder(f.store.data.orders[0],f.observed({averagePrice:99,feeUsd:-.01})),true);
    near(f.p.long.quantity,10);near(f.p.long.entryPrice,99);near(f.p.feesUsd,-.01);near(f.p.long.feesUsd,-.01);
    await f.execution.reconcilePending();near(f.p.long.quantity,10);near(f.p.feesUsd,-.01);
  }finally{f.cleanup();}
});

test('a failed reconciliation save restores the previous durable cash and a restart applies the true receipt only once',async()=>{
  const f=fixture();try{
    await assert.rejects(f.start,UncertainOrderError);const journal=f.store.data.orders[0],save=f.store.save.bind(f.store);
    f.store.save=()=>{throw new Error('offline reconciliation save fault');};
    assert.throws(()=>f.execution.applyObservedOrder(journal,f.observed()),/offline reconciliation save fault/);
    near(f.p.long.quantity,10);near(f.p.long.entryPrice,99);near(f.p.feesUsd,-.01);
    await f.execution.reconcilePending();near(f.p.long.quantity,10);near(f.p.feesUsd,-.01);f.store.save=save;
    const restored=new Store(f.store.path,f.context.config()),restoredPosition=restored.data.positions[0];
    near(restoredPosition.long.quantity,4);near(restoredPosition.feesUsd,0);assert.equal(restored.data.orders[0].result!.feeUsd,null);
    f.setFinalReply({status:'filled',filledQuantity:10,averagePrice:99,averagePriceVerified:true,feeUsd:-.01});
    const restarted=new Execution(restored,f.context);await restarted.reconcilePending();await restarted.reconcilePending();
    near(restoredPosition.long.quantity,10);near(restoredPosition.long.entryPrice,99);near(restoredPosition.feesUsd,-.01);
    assert.equal(restored.data.orders[0].executionEvidence!.bookedFeeUsd,-.01);assert.equal(f.submits(),1);
    const saved=new Store(f.store.path,f.context.config());near(saved.data.positions[0].long.quantity,10);near(saved.data.positions[0].feesUsd,-.01);
  }finally{f.cleanup();}
});

test('an old malformed terminal receipt blocks new entry, supplements and closing before any additional financial call',async()=>{
  const f=fixture();try{
    await assert.rejects(f.start,UncertainOrderError);const journal=f.store.data.orders[0];
    journal.result!.status='filled'; // Legacy label claims complete, but its actual cumulative 4 / 10 contradicts that label.
    const before=structuredClone({long:f.p.long,short:f.p.short,feesUsd:f.p.feesUsd});
    await f.execution.open(f.p,10,10);assert.equal(f.p.status,'attention');
    await assert.rejects(()=>f.execution.order(f.p,f.p.long,'buy',6,false),UncertainOrderError);
    await assert.rejects(()=>f.execution.close(f.p,'explicit offline close request'),UncertainOrderError);
    assert.equal(f.submits(),1);assert.equal(f.store.data.orders.length,1);
    assert.deepEqual({long:f.p.long,short:f.p.short,feesUsd:f.p.feesUsd},before);
    assert.equal(journal.result!.id,`native-${journal.request.clientOrderId}`);
  }finally{f.cleanup();}
});
