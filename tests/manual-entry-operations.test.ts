import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ManualEntryOperations, ManualEntryCancelled } from '../src/core/manual-entry-operations.js';
import type { ManualEntryOperation } from '../src/shared/manual-entry.js';
import type { ExchangeAdapter, MarketSnapshot, Opportunity, Position } from '../src/shared/types.js';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { defaultConfig } from './legacy-config.js';

function position():Position{return {id:'p-ct',base:'CT',mode:'live',status:'opening',openedAt:1000,plannedExitAt:50_000,holdMode:'adaptive',
  long:{exchange:'gate',symbol:'CT/USDT:USDT',side:'long',quantity:0,entryPrice:0,markPrice:.5,feesUsd:0,liquidationDistancePct:null},
  short:{exchange:'bybit',symbol:'CT/USDT:USDT',side:'short',quantity:0,entryPrice:0,markPrice:.5,feesUsd:0,liquidationDistancePct:null},
  fundingUsd:0,feesUsd:0,transferCostUsd:0,spreadPnlUsd:0,realizedSpreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[]};}
function registry(records:ManualEntryOperation[]=[],positions:Position[]=[],hasIntent=false){
  let now=1000,saves=0;
  const logs:ManualEntryOperation[]=[];
  const operations=new ManualEntryOperations(records,{now:()=>now,persist:()=>{saves++;},log:operation=>logs.push(operation),positions:()=>positions,hasOrderIntent:()=>hasIntent});
  return {operations,records,logs,positions,advance:(milliseconds:number)=>{now+=milliseconds;},now:()=>now,saves:()=>saves};
}
const operationId='click-ct-001',opportunityId='CT-gate-bybit';

test('manual click receipt is immediate, isolated from caller mutation and permanently idempotent',()=>{
  const s=registry();try{
    const first=s.operations.create(operationId,opportunityId,s.now()+30_000);
    assert.equal(first.operation.state,'queued');assert.equal(first.created,true);assert.ok(s.saves()>0);
    first.operation.ordersSubmitted=true;
    assert.equal(s.operations.get(operationId)!.ordersSubmitted,false);
    const duplicate=s.operations.create(operationId,opportunityId,s.now()+90_000);
    assert.equal(duplicate.created,false);assert.equal(s.records.length,1);assert.equal(duplicate.operation.expiresAt,31_000);
    assert.throws(()=>s.operations.create(operationId,'CT-bybit-gate',s.now()+30_000),/不同机会/);
  }finally{s.operations.stop();}
});

test('late HTTP acceptance with an expired client click never gains a new deadline',()=>{
  const s=registry();try{
    const result=s.operations.create(operationId,opportunityId,s.now()-1);
    assert.equal(result.operation.state,'expired');assert.equal(result.operation.ordersSubmitted,false);
    assert.throws(()=>s.operations.begin(operationId),ManualEntryCancelled);
    assert.throws(()=>s.operations.commit(operationId),ManualEntryCancelled);
  }finally{s.operations.stop();}
});

test('a queued click expires after five seconds even if a visible page keeps polling',()=>{
  const s=registry();try{
    s.operations.create(operationId,opportunityId,s.now()+30_000);s.advance(4999);
    assert.equal(s.operations.get(operationId,true)!.state,'queued');s.advance(1);
    assert.equal(s.operations.get(operationId,true)!.state,'expired');
    assert.throws(()=>s.operations.begin(operationId),/排队/);
  }finally{s.operations.stop();}
});

test('a disconnected pre-submission page expires while a slow private read finishes later',()=>{
  const s=registry();try{
    s.operations.create(operationId,opportunityId,s.now()+30_000);s.operations.begin(operationId);
    s.advance(12_000);assert.throws(()=>s.operations.ensure(operationId),/页面/);
    assert.equal(s.operations.get(operationId)!.ordersSubmitted,false);
  }finally{s.operations.stop();}
});

test('poll renewal never extends the absolute thirty-second submission limit',()=>{
  const s=registry();try{
    s.operations.create(operationId,opportunityId,s.now()+120_000);s.operations.begin(operationId);
    for(let i=0;i<3;i++){s.advance(9000);s.operations.get(operationId,true);}
    s.advance(3000);assert.throws(()=>s.operations.commit(operationId),/有效期/);
    assert.equal(s.operations.get(operationId)!.state,'expired');
  }finally{s.operations.stop();}
});

test('a synchronous cancel wins before the atomic initial submission boundary',()=>{
  const s=registry();try{
    s.operations.create(operationId,opportunityId,s.now()+30_000);s.operations.begin(operationId);
    assert.equal(s.operations.cancel(operationId)!.state,'cancelled');
    assert.throws(()=>s.operations.commit(operationId),ManualEntryCancelled);
    assert.equal(s.operations.get(operationId)!.ordersSubmitted,false);
  }finally{s.operations.stop();}
});

test('after initial commit neither cancellation nor a lost poll stops repair or reconciliation',()=>{
  const s=registry();try{
    s.operations.create(operationId,opportunityId,s.now()+30_000);s.operations.begin(operationId);s.operations.commit(operationId);
    s.advance(90_000);assert.equal(s.operations.cancel(operationId)!.state,'submitting');s.operations.ensure(operationId);
    s.operations.reconciling(operationId);assert.equal(s.operations.get(operationId)!.state,'reconciling');
    const p=position();p.status='open';p.long.quantity=p.short.quantity=190;s.operations.complete(operationId,p);
    const completed=s.operations.get(operationId)!;assert.equal(completed.state,'completed');assert.equal(completed.cancelable,false);assert.equal(completed.result!.longQuantity,190);
    assert.equal(s.operations.create(operationId,opportunityId,s.now()+30_000).created,false);
  }finally{s.operations.stop();}
});

test('restart closes only a zero-quantity record with no order intent',()=>{
  const p=position(),s=registry([], [p]);
  try{
    s.operations.create(operationId,opportunityId,s.now()+30_000);s.operations.begin(operationId);s.operations.attachPosition(operationId,p);
    const restarted=registry(s.records,[p]);try{
      restarted.operations.recover();assert.equal(p.status,'closed');assert.equal(p.long.quantity,0);
      const receipt=restarted.operations.get(operationId)!;assert.equal(receipt.state,'cancelled');assert.equal(receipt.result!.positionStatus,'closed');assert.equal(receipt.ordersSubmitted,false);
    }finally{restarted.operations.stop();}
  }finally{s.operations.stop();}
});

test('restart preserves an order intent even if a stale receipt says pre-submission and quantity zero',()=>{
  const p=position(),s=registry([], [p],true);try{
    s.operations.create(operationId,opportunityId,s.now()+30_000);s.operations.attachPosition(operationId,p);s.operations.recover();
    const receipt=s.operations.get(operationId)!;assert.equal(receipt.state,'failed');assert.equal(receipt.ordersSubmitted,true);assert.equal(p.status,'opening');
    assert.equal(s.operations.create(operationId,opportunityId,s.now()+30_000).created,false);
  }finally{s.operations.stop();}
});

test('a submitted receipt survives restart and later GET exposes independent confirmed reconciliation',()=>{
  const p=position(),s=registry([], [p]);try{
    s.operations.create(operationId,opportunityId,s.now()+30_000);s.operations.attachPosition(operationId,p);s.operations.commit(operationId);
    p.status='attention';p.long.quantity=190;s.operations.recover();
    assert.equal(s.operations.get(operationId)!.result!.positionStatus,'attention');
    p.short.quantity=190;p.status='open';assert.equal(s.operations.get(operationId)!.state,'completed');
    assert.equal(s.records.length,1);assert.equal(s.operations.get(operationId)!.result!.shortQuantity,190);
  }finally{s.operations.stop();}
});

function engineFixture(){
  const directory=mkdtempSync(path.join(tmpdir(),'manual-entry-'));
  let submitted=0;
  const adapters:ExchangeAdapter[]=(['gate','bybit'] as const).map(id=>({id,fetchSnapshots:async()=>[],fetchAccount:async()=>({freeUsd:1000,equityUsd:1000,positions:[]}),fetchFundingPayments:async()=>[],inspectTrading:async()=>{},prepareTrading:async()=>{},placeOrder:async()=>{submitted++;throw new Error('No exchange order is permitted in this test');},cancelOrder:async()=>{},reconcileOrder:async()=>{throw new Error('No exchange query is permitted');},close:async()=>{}}));
  const store=new Store(path.join(directory,'state.json'),{...defaultConfig,mode:'live',dataSource:'public',exchanges:['gate','bybit'],symbols:['CT'],feeOnly:true,orderNotionalUsd:100});
  const engine=new Engine(store,true,{adapterFactory:()=>adapters,liveEnvironment:{ALLOW_LIVE_TRADING:'true',LIVE_TRADING_ACK:'I_UNDERSTAND_THE_RISKS',GATE_API_KEY:'test',GATE_API_SECRET:'test',BYBIT_API_KEY:'test',BYBIT_API_SECRET:'test'}});
  engine.health=adapters.map(adapter=>({exchange:adapter.id,status:'online',latencyMs:0,lastSuccess:Date.now()}));
  engine.snapshots=adapters.map(adapter=>({exchange:adapter.id,base:'CT',symbol:'CT/USDT:USDT',timestamp:Date.now(),markPrice:.5,indexPrice:.5,fundingRate:adapter.id==='gate'?0:.001,nextFundingTime:Date.now()+3_600_000,intervalHours:8,fundingHistory:[],bids:[{price:.5,quantity:1000}],asks:[{price:.5,quantity:1000}],openInterestUsd:1e9,volume24hUsd:1e9,quantityStep:1,minQuantity:1,minNotional:1,contractSize:1,source:'public',takerFeeRate:.0005,takerFeeAt:Date.now(),takerFeeSource:'exchange'}) as MarketSnapshot);
  const opportunity={id:opportunityId,base:'CT',eligible:true,longExchange:'gate',shortExchange:'bybit',longQuantity:190,shortQuantity:190,exitTime:Date.now()+3_600_000,transferCostUsd:0,entryPolicy:'aligned',checks:[],reasons:[],spreadAdvantage:{longEntryPrice:.5,shortEntryPrice:.5}} as unknown as Opportunity;
  (engine as any).detailedOpportunities=()=>[opportunity];(engine as any).refreshExecutionSnapshots=async()=>{};
  return {directory,store,engine,adapters,submitted:()=>submitted,cleanup:async()=>{await engine.stop();rmSync(directory,{recursive:true,force:true});}};
}
function deferred(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}

test('engine accepts an immediate queued receipt but pause invalidates the click captured before queue entry',async()=>{
  const s=engineFixture(),barrier=deferred();try{
    const blocking=s.engine.exclusive(()=>barrier.promise);
    const receipt=s.engine.requestManualEntry(opportunityId,operationId,Date.now()+30_000);assert.equal(receipt.state,'queued');
    await s.engine.control('pause');barrier.release();await blocking;await s.engine.exclusive(async()=>{});
    const result=s.engine.manualEntryOperation(operationId)!;assert.equal(result.state,'failed');assert.match(result.message,/取消/);
    assert.equal(s.store.data.positions.length,0);assert.equal(s.store.data.orders.length,0);assert.equal(s.submitted(),0);
  }finally{barrier.release();await s.cleanup();}
});

test('cancelling a pending read-only contract check prevents every preparation and order',async()=>{
  const s=engineFixture(),entered=deferred(),waiting=deferred();let preparations=0;
  try{
    s.adapters[1].inspectTrading=async()=>{entered.release();await waiting.promise;};
    for(const adapter of s.adapters)adapter.prepareTrading=async()=>{preparations++;};
    s.engine.requestManualEntry(opportunityId,operationId,Date.now()+30_000);await entered.promise;
    const cancelled=s.engine.cancelManualEntry(operationId)!;assert.equal(cancelled.state,'cancelled');waiting.release();await s.engine.exclusive(async()=>{});
    assert.equal(preparations,0);assert.equal(s.store.data.positions.length,0);assert.equal(s.store.data.orders.length,0);assert.equal(s.submitted(),0);
  }finally{waiting.release();await s.cleanup();}
});

test('a duplicate click ID never queues another execution while its first preparation is pending',async()=>{
  const s=engineFixture(),entered=deferred(),waiting=deferred();let preparations=0;
  try{
    s.adapters[0].prepareTrading=async()=>{preparations++;entered.release();await waiting.promise;};
    s.engine.requestManualEntry(opportunityId,operationId,Date.now()+30_000);await entered.promise;
    const duplicate=s.engine.requestManualEntry(opportunityId,operationId,Date.now()+30_000);assert.equal(duplicate.state,'preparing');
    assert.throws(()=>s.engine.requestManualEntry(opportunityId,'another-click-002',Date.now()+30_000),/不要重复/);
    s.engine.cancelManualEntry(operationId);waiting.release();await s.engine.exclusive(async()=>{});
    assert.equal(preparations,1);assert.equal(s.store.data.manualEntryOperations!.length,1);assert.equal(s.submitted(),0);
  }finally{waiting.release();await s.cleanup();}
});

test('expiry at the final execution boundary creates no order intent and never leaves a ghost local position',async()=>{
  const s=engineFixture();try{
    s.engine.execution.open=async(p,_long,_short,validate,beforeSubmit)=>{
      await validate?.();s.engine.cancelManualEntry(operationId);beforeSubmit?.();throw new Error('Must never pass a cancelled submission boundary');
    };
    s.engine.requestManualEntry(opportunityId,operationId,Date.now()+30_000);await s.engine.exclusive(async()=>{});
    const receipt=s.engine.manualEntryOperation(operationId)!;assert.equal(receipt.state,'cancelled');assert.equal(receipt.ordersSubmitted,false);
    assert.equal(s.store.data.positions.length,1);assert.equal(s.store.data.positions[0].status,'closed');assert.equal(s.store.data.orders.length,0);assert.equal(s.submitted(),0);
  }finally{await s.cleanup();}
});

test('a browser cancel after commit leaves the original pair execution and progress receipt active',async()=>{
  const s=engineFixture();try{
    s.engine.execution.open=async(p,_long,_short,validate,beforeSubmit,onProgress)=>{
      await validate?.();beforeSubmit?.();const receipt=s.engine.cancelManualEntry(operationId)!;
      assert.equal(receipt.ordersSubmitted,true);assert.equal(receipt.cancelable,false);assert.equal(receipt.state,'submitting');
      onProgress?.('reconciling');assert.equal(s.engine.manualEntryOperation(operationId)!.state,'reconciling');
      p.long.quantity=p.short.quantity=190;p.status='open';s.store.save();
    };
    s.engine.requestManualEntry(opportunityId,operationId,Date.now()+30_000);await s.engine.exclusive(async()=>{});
    assert.equal(s.engine.manualEntryOperation(operationId)!.state,'completed');assert.equal(s.store.data.positions[0].status,'open');assert.equal(s.submitted(),0);
    const receipt=s.engine.requestManualEntry(opportunityId,operationId,Date.now()+30_000);assert.equal(receipt.state,'completed');assert.equal(s.store.data.positions.length,1);
  }finally{await s.cleanup();}
});

test('a final local pre-submission rejection preserves its exact sanitized reason in the durable receipt',async()=>{
  const s=engineFixture();try{
    s.engine.execution.open=async()=>{throw new Error('两腿数量在最终复核时变化，未提交订单');};
    s.engine.requestManualEntry(opportunityId,operationId,Date.now()+30_000);await s.engine.exclusive(async()=>{});
    const receipt=s.engine.manualEntryOperation(operationId)!;assert.equal(receipt.state,'failed');assert.equal(receipt.ordersSubmitted,false);
    assert.match(receipt.message,/两腿数量在最终复核时变化/);assert.match(receipt.error!,/两腿数量/);
    assert.equal(s.store.data.positions[0].status,'closed');assert.equal(s.store.data.orders.length,0);assert.equal(s.submitted(),0);
  }finally{await s.cleanup();}
});
