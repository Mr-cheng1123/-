import test from 'node:test';
import assert from 'node:assert/strict';
import {isProvenNoSubmitReceipt,normalizeOrderReceipt} from '../src/shared/order-receipt-validity.js';
import type {OrderRequest,OrderResult} from '../src/shared/types.js';
import {fundingEntryFixture,entryStability,confirmEntryFunding} from './funding-entry-stability-fixture.js';

test('a permitted native funding update durably records its final evidence before create while retaining the original intent evidence',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fundingEntryFixture(),save=f.store.save.bind(f.store);
  try{
    const candidate=confirmEntryFunding(f,ms=>t.mock.timers.tick(ms));
    let initialIntent:typeof f.store.data.orders[number]|undefined,submissionIntent:typeof f.store.data.orders[number]|undefined;
    const expectedObservation=Date.now()+1;
    f.store.save=()=>{
      const journal=f.store.data.orders.find(order=>order.exchange==='bybit');
      if(journal&&!journal.result){
        if(!journal.executionEvidence?.submissionFundingEntryStability)initialIntent??=structuredClone(journal);
        else{
          assert.equal(f.sent.length,0,'the latest confirmation must be persisted before either simulated create');
          submissionIntent=structuredClone(journal);
        }
      }
      save();
    };
    f.beforeNativeSubmit(async(exchange,request)=>{if(exchange==='bybit'&&!request.reduceOnly){
      await new Promise<void>(resolve=>setImmediate(resolve));
      assert.ok(initialIntent?.executionEvidence?.fundingEntryStability,'the original preflight evidence is already durable');
      assert.equal(initialIntent.executionEvidence.fundingEntryStability.short.fundingRate,.005);
      t.mock.timers.tick(1);f.quotes.get('bybit')!.fundingRate=.0055;f.publish();
    }});
    f.afterFill((exchange,request)=>{if(exchange==='bybit'&&!request.reduceOnly){
      assert.ok(submissionIntent?.executionEvidence?.submissionFundingEntryStability,'native create follows the successful final-evidence save');
      assert.equal(submissionIntent.result,undefined);
    }});
    f.engine.autoEnabled=true;const p=await f.internal.openInternal(candidate.id,true);
    assert.equal(p.status,'open');assert.equal(f.sent.length,2);assert.equal(f.counters.submissionGuards,1);
    assert.ok(initialIntent?.executionEvidence?.fundingEntryStability);assert.ok(submissionIntent?.executionEvidence?.submissionFundingEntryStability);
    const initial=initialIntent.executionEvidence.fundingEntryStability,latest=submissionIntent.executionEvidence.submissionFundingEntryStability;
    assert.deepEqual(submissionIntent.executionEvidence.fundingEntryStability,initial,'late evidence must not rewrite the durable original confirmation');
    assert.equal(initial.version,2);assert.equal(latest.version,2);
    assert.deepEqual(submissionIntent.request,initialIntent.request,'the final guard preserves the original order ID and request');
    assert.equal(latest.short.fundingRate,.0055);assert.equal(latest.short.fundingObservedAt,expectedObservation);
    assert.equal(latest.long.fundingObservedAt,expectedObservation);assert.equal(initial.short.fundingRate,.005);
    assert.ok(initial.short.fundingObservedAt<latest.short.fundingObservedAt);
    assert.equal(latest.sampleCount,1);assert.equal(latest.observedSpanMs,0);
    assert.equal(latest.samples[0].fundingUsd,latest.minimumFundingUsd,'the final record describes the current paired forecast');
    assert.deepEqual(f.store.data.orders[0].executionEvidence?.submissionFundingEntryStability,latest);
  }finally{f.store.save=save;await f.stop();}
});

test('a failed final funding-evidence save vetoes create and freezes the original intent without replay or false booking',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fundingEntryFixture(),save=f.store.save.bind(f.store);
  try{
    const candidate=confirmEntryFunding(f,ms=>t.mock.timers.tick(ms));
    let durableIntent:typeof f.store.data.orders[number]|undefined,failed=false;
    f.store.save=()=>{
      const journal=f.store.data.orders[0];
      if(journal&&!journal.result){
        if(!journal.executionEvidence?.submissionFundingEntryStability)durableIntent??=structuredClone(journal);
        else if(!failed){
          failed=true;assert.equal(f.sent.length,0);throw new Error('Memory final funding confirmation storage failure');
        }
      }
      save();
    };
    f.engine.autoEnabled=true;const p=await f.internal.openInternal(candidate.id,true);
    assert.equal(failed,true);assert.ok(durableIntent?.executionEvidence?.fundingEntryStability);
    assert.equal(durableIntent.result,undefined);assert.equal(durableIntent.executionEvidence.submissionFundingEntryStability,undefined);
    assert.equal(f.sent.length,0);assert.equal(f.counters.nativeChecks,1);assert.equal(f.counters.submissionGuards,1);
    assert.equal(f.store.data.killSwitch,true);assert.equal((f.engine.execution as any).interruptedOrderProcessing.has(p.id),true);
    assert.equal(p.status,'closed');assert.equal(p.long.quantity,0);assert.equal(p.short.quantity,0);assert.equal(p.feesUsd,0);
    assert.equal(f.store.data.orders.length,1);const journal=f.store.data.orders[0];
    assert.deepEqual(journal.request,durableIntent.request);assert.deepEqual(journal.executionEvidence?.fundingEntryStability,durableIntent.executionEvidence.fundingEntryStability);
    assert.equal(journal.result?.filledQuantity,0);assert.equal(journal.result?.feeUsd,0);
    assert.equal(journal.result?.rejectionCode,'AUTOMATIC_ENTRY_PERMISSION_CHANGED');
    await assert.rejects(f.engine.execution.order(p,p.short,'sell',1,false),/原订单处理已中断/);
    assert.equal(p.status,'attention','an explicit replay attempt remains frozen for ledger review');
    assert.equal(f.sent.length,0);assert.equal(f.counters.nativeChecks,1);assert.equal(f.store.data.orders.length,1,'the preserved intent cannot become a fresh retry');
    assert.equal(p.long.quantity,0);assert.equal(p.short.quantity,0);assert.equal(p.feesUsd,0);
  }finally{f.store.save=save;await f.stop();}
});

test('a funding reversal during native preflight vetoes the actual automatic create after a durable intent',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fundingEntryFixture();
  try{
    const candidate=confirmEntryFunding(f,ms=>t.mock.timers.tick(ms));
    f.beforeNativeSubmit(async(exchange,request)=>{if(exchange==='bybit'&&!request.reduceOnly){
      await new Promise<void>(resolve=>setImmediate(resolve));f.quotes.get('bybit')!.fundingRate=-.005;f.publish();
    }});
    f.engine.autoEnabled=true;await f.internal.openInternal(candidate.id,true);
    assert.equal(f.counters.nativeChecks,1);assert.equal(f.counters.submissionGuards,1);
    assert.equal(f.sent.length,0,'the native create must not receive either opening leg');
    assert.equal(f.store.data.orders.length,1,'the veto preserves the original durable intent and terminal receipt');
    const journal=f.store.data.orders[0];assert.equal(journal.result?.filledQuantity,0);assert.equal(journal.result?.status,'cancelled');
    assert.equal(journal.result?.rejectionCode,'AUTOMATIC_ENTRY_PERMISSION_CHANGED');
    assert.equal(f.store.data.positions[0].long.quantity,0);assert.equal(f.store.data.positions[0].short.quantity,0);
  }finally{await f.stop();}
});

test('a settlement rollover during native preflight cannot spend the preceding cycle confirmation',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fundingEntryFixture();
  try{
    const candidate=confirmEntryFunding(f,ms=>t.mock.timers.tick(ms));
    f.beforeNativeSubmit(async(exchange,request)=>{if(exchange==='bybit'&&!request.reduceOnly){
      await new Promise<void>(resolve=>setImmediate(resolve));for(const quote of f.quotes.values())quote.nextFundingTime+=3_600_000;f.publish();
    }});
    f.engine.autoEnabled=true;await f.internal.openInternal(candidate.id,true);
    assert.equal(f.sent.length,0);assert.equal(f.counters.submissionGuards,1);assert.equal(f.store.data.orders.length,1);
    assert.equal(f.store.data.orders[0].result?.filledQuantity,0);assert.equal(entryStability(f.candidate()).passes,false);
  }finally{await f.stop();}
});

test('pausing automatic entries during native preflight vetoes its pending first create',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fundingEntryFixture();
  try{
    const candidate=confirmEntryFunding(f,ms=>t.mock.timers.tick(ms));
    f.beforeNativeSubmit(async(exchange,request)=>{if(exchange==='bybit'&&!request.reduceOnly){
      await new Promise<void>(resolve=>setImmediate(resolve));await f.engine.control('pause');
    }});
    f.engine.autoEnabled=true;const p=await f.internal.openInternal(candidate.id,true);
    assert.equal(f.engine.autoEnabled,false);assert.equal(f.sent.length,0,'a pending native GET cannot outlive automatic-entry cancellation');
    assert.equal(f.store.data.orders.length,1);assert.equal(f.store.data.orders[0].result?.status,'cancelled');
    assert.equal(p.long.quantity,0);assert.equal(p.short.quantity,0);
  }finally{await f.stop();}
});

test('a newer session generation cannot authorize an older automatic entry still awaiting native checks',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fundingEntryFixture();
  try{
    const candidate=confirmEntryFunding(f,ms=>t.mock.timers.tick(ms));
    f.beforeNativeSubmit(async(exchange,request)=>{if(exchange==='bybit'&&!request.reduceOnly){
      await new Promise<void>(resolve=>setImmediate(resolve));f.internal.startGeneration++;
      assert.equal(f.engine.autoEnabled,true,'current automatic permission alone is not the old request generation');
    }});
    f.engine.autoEnabled=true;const p=await f.internal.openInternal(candidate.id,true);
    assert.equal(f.sent.length,0);assert.equal(f.store.data.orders.length,1);
    assert.equal(f.store.data.orders[0].result?.status,'cancelled');assert.equal(p.long.quantity,0);assert.equal(p.short.quantity,0);
  }finally{await f.stop();}
});

test('a confirmed short fill retains its existing long hedge when funding weakens and prior confirmation is invalidated',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fundingEntryFixture();
  try{
    const candidate=confirmEntryFunding(f,ms=>t.mock.timers.tick(ms));
    f.afterFill((exchange,request)=>{if(exchange==='bybit'&&!request.reduceOnly){f.quotes.get('bybit')!.fundingRate=.00001;f.publish();}});
    f.engine.autoEnabled=true;const p=await f.internal.openInternal(candidate.id,true);
    assert.deepEqual(f.sent.map(order=>[order.exchange,order.request.side,order.request.reduceOnly]),[['bybit','sell',false],['gate','buy',false]]);
    assert.equal(p.long.quantity,1);assert.equal(p.short.quantity,1);assert.equal(p.status,'open');
    assert.equal(f.counters.submissionGuards,1,'the new-risk guard must not reject completion of the confirmed hedge');
    assert.equal(entryStability(f.candidate()).passes,false);
  }finally{await f.stop();}
});

test('direct automatic execution fails closed when its final stability callback is absent',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fundingEntryFixture();
  try{
    const candidate=confirmEntryFunding(f,ms=>t.mock.timers.tick(ms));
    (f.engine.execution as any).context.assertAutomaticEntryStability=undefined;
    f.engine.autoEnabled=true;const p=await f.internal.openInternal(candidate.id,true);
    assert.match(p.entryExecution!.stopReason!,/缺少资金费持续优势确认守卫/);
    assert.equal(f.sent.length,0);assert.equal(f.store.data.orders.length,0);assert.equal(f.counters.nativeChecks,0);
  }finally{await f.stop();}
});

test('an unknown original or malformed veto receipt never becomes a proven zero-fill cancellation',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});
  for(const mutation of ['unknown-original','unknown-fee','wrong-client','nonzero-average'] as const){const f=fundingEntryFixture();try{
    const candidate=confirmEntryFunding(f,ms=>t.mock.timers.tick(ms)),adapter=f.adapters.find(value=>value.id==='bybit')!,place=adapter.placeOrder.bind(adapter);
    f.beforeNativeSubmit(async(exchange,request)=>{if(exchange==='bybit'&&!request.reduceOnly){
      await new Promise<void>(resolve=>setImmediate(resolve));f.quotes.get('bybit')!.fundingRate=-.005;f.publish();
    }});
    adapter.placeOrder=async(request,canSubmit)=>{
      const result=await place(request,canSubmit);assert.equal(result.rejectionCode,'ORDER_SUBMISSION_PERMISSION_CHANGED');
      if(mutation==='unknown-original')return {...result,id:'MEMORY-EXISTING-UNKNOWN',status:'unknown'};
      if(mutation==='unknown-fee')return {...result,feeUsd:NaN};
      if(mutation==='nonzero-average')return {...result,averagePrice:100.5};
      return {...result,clientOrderId:'WRONG-CLIENT-ID'};
    };
    f.engine.autoEnabled=true;const p=await f.internal.openInternal(candidate.id,true);
    assert.equal(f.sent.length,0,mutation);assert.equal(f.store.data.orders.length,1,mutation);
    assert.equal(f.store.data.orders[0].result?.status,'unknown',mutation);assert.equal(p.status,'attention',mutation);
    assert.equal(p.long.quantity,0);assert.equal(p.short.quantity,0);assert.equal(f.counters.nativeChecks,1);
  }finally{await f.stop();}}
});

test('a generic permission code cannot mint automatic no-submit evidence without the native veto witness',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fundingEntryFixture();
  try{
    const candidate=confirmEntryFunding(f,ms=>t.mock.timers.tick(ms)),adapter=f.adapters.find(value=>value.id==='bybit')!;
    adapter.placeOrder=async(request,canSubmit)=>{
      assert.equal(typeof canSubmit,'function'); // Deliberately never call the supplied native permission witness.
      return {id:'',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,
        timestamp:Date.now(),rejectionCode:'ORDER_SUBMISSION_PERMISSION_CHANGED',rejectionReason:'Memory unproven permission receipt'};
    };
    f.engine.autoEnabled=true;const p=await f.internal.openInternal(candidate.id,true);
    assert.equal(f.sent.length,0);assert.equal(f.store.data.orders.length,1);
    assert.equal(f.store.data.orders[0].result?.status,'unknown');assert.equal(p.status,'attention');
    assert.equal(p.long.quantity,0);assert.equal(p.short.quantity,0);
  }finally{await f.stop();}
});

test('a local funding veto cannot overwrite an existing unknown native ID or its confirmed fill lower bound',()=>{
  const now=Date.now(),request:OrderRequest={clientOrderId:'MEMORY-EXISTING-INTENT',base:'BTC',symbol:'BTC/USDT:USDT',
    side:'sell',quantity:1,limitPrice:100.5,reduceOnly:false};
  const prior:OrderResult={id:'MEMORY-EXISTING-NATIVE',clientOrderId:request.clientOrderId,status:'unknown',filledQuantity:.4,
    averagePrice:100.5,averagePriceVerified:true,feeUsd:.02211,timestamp:now};
  const veto:OrderResult={id:'',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,
    feeUsd:0,rejectionCode:'AUTOMATIC_ENTRY_PERMISSION_CHANGED',rejectionReason:'Memory local veto',timestamp:now};
  assert.equal(isProvenNoSubmitReceipt(request,veto),true,'the new code proves no submission for a fresh matching intent only');
  const retained=normalizeOrderReceipt(request,veto,now,prior);
  assert.equal(retained.status,'unknown');assert.equal(retained.id,prior.id);assert.equal(retained.filledQuantity,.4);
  assert.equal(retained.averagePrice,100.5);assert.equal(retained.feeUsd,.02211);
});

test('reduce-only residual work remains allowed when automatic entry confirmation is unavailable',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fundingEntryFixture();
  try{
    const candidate=confirmEntryFunding(f,ms=>t.mock.timers.tick(ms));f.engine.autoEnabled=true;
    const p=await f.internal.openInternal(candidate.id,true),guardCount=f.counters.submissionGuards;
    (f.engine.execution as any).context.assertAutomaticEntryStability=()=>{throw new Error('No new-entry funding permission');};
    f.quotes.get('bybit')!.fundingRate=-.005;f.publish();
    await f.engine.execution.order(p,p.short,'buy',p.short.quantity,true);
    assert.equal(f.sent.length,3);assert.equal(f.sent[2].request.reduceOnly,true);
    assert.equal(p.short.quantity,0);assert.equal(p.long.quantity,1);assert.equal(f.counters.submissionGuards,guardCount);
  }finally{await f.stop();}
});

test('new common expansion is refused after confirmation disappears, while the first matched pair is retained',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fundingEntryFixture({top:.4,maxBatches:4});
  try{
    const candidate=confirmEntryFunding(f,ms=>t.mock.timers.tick(ms));
    f.afterFill((exchange,request)=>{if(exchange==='gate'&&!request.reduceOnly){
      for(const quote of f.quotes.values())quote.nextFundingTime+=3_600_000;f.publish();
    }});
    f.engine.autoEnabled=true;const p=await f.internal.openInternal(candidate.id,true);
    assert.equal(f.sent.length,2);assert.equal(p.long.quantity,.4);assert.equal(p.short.quantity,.4);assert.equal(p.status,'open');
    assert.match(p.entryExecution!.stopReason!,/资金费|持续|独立/);assert.equal(p.closeRequestedAt,undefined);
    assert.equal(f.sent.some(order=>order.request.reduceOnly),false,'lost entry permission must not unwind the already completed hedge');
  }finally{await f.stop();}
});

test('unchanged cached funding can survive native checks without fabricating an additional independent sample',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fundingEntryFixture();
  try{
    const candidate=confirmEntryFunding(f,ms=>t.mock.timers.tick(ms)),count=entryStability(candidate).sampleCount;
    f.beforeNativeSubmit(async()=>{await new Promise<void>(resolve=>setImmediate(resolve));f.publish(false);});
    f.engine.autoEnabled=true;const p=await f.internal.openInternal(candidate.id,true);
    assert.equal(p.status,'open');assert.equal(f.sent.length,2);assert.equal(f.counters.submissionGuards,1);
    assert.equal(entryStability(f.candidate()).sampleCount,count);
  }finally{await f.stop();}
});

test('manual creates do not invoke automatic stability veto during native preparation',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fundingEntryFixture();
  try{
    for(const quote of f.quotes.values()){quote.fundingObservedAt=undefined;quote.bookTransport='rest';}
    f.publish(false);
    const candidate=f.candidate()!;assert.equal(entryStability(candidate).passes,false);
    f.beforeNativeSubmit(async()=>{await new Promise<void>(resolve=>setImmediate(resolve));f.publish(false);});
    const p=await f.internal.openInternal(candidate.id,false);assert.equal(p.status,'open');assert.equal(f.sent.length,2);
    assert.equal(f.counters.submissionGuards,0);
  }finally{await f.stop();}
});
