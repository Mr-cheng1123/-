import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {Execution} from '../src/core/execution.js';
import {confirmedIocOrderProof,isWitnessedIocLocalVeto,planConfirmedIocTail} from '../src/core/confirmed-ioc-tail.js';
import {selectedNativeExitRecoverySchema} from '../src/server-input.js';
import type {JournalOrder,OrderResult} from '../src/shared/types.js';
import {fixture as nativeFixture,completeKnownTail,extraUnknown,NOW} from './native-exit-read-fixture.js';

function fixture(t:TestContext){
  const f=nativeFixture(t,{peerExchange:'bitget'});completeKnownTail(f);f.store.data.config.profitExitExecutionMode='ioc';
  const batchId=`${f.p.id}:ioc-close:original-confirmed-pair`,createdAt=NOW-100;
  const orders=[f.p.long,f.p.short].map((leg,index)=>{
    const clientOrderId=`confirmed-ioc-${index}`,limitPrice=index===0?1.01:1.001;
    return {positionId:f.p.id,exchange:leg.exchange,createdAt,
      request:{clientOrderId,base:f.p.base,symbol:leg.symbol,side:leg.side==='long'?'sell':'buy',quantity:5,limitPrice,reduceOnly:true},
      result:{id:index===0?'native-original-ioc':'',clientOrderId,status:index===0?'filled':'cancelled',filledQuantity:index===0?5:0,
        averagePrice:index===0?limitPrice:0,averagePriceVerified:index===0?true:undefined,feeUsd:index===0?5*limitPrice*.0005:0,timestamp:NOW-20,
        ...(index===1?{rejectionCode:'IOC_REDUCTION_PERMISSION_CHANGED',rejectionReason:'对手价1 IOC 提交前盘口、数量或许可已变化；本次未发送创建请求'}:{})},
      execution:{bookObservedAt:NOW-200,quoteAgeMs:100,bookTransport:'rest',confirmedAt:NOW-10,confirmationMs:90},
      executionEvidence:{version:1,method:'ioc',role:'exit',batchId,nativeTakerFeeRate:.0005,feeObservedAt:NOW-1000,
        referencePrice:limitPrice,referenceObservedAt:NOW-200,submittedAt:NOW-90,bookedFeeUsd:index===0?5*limitPrice*.0005:0},
    } as JournalOrder;
  }) as [JournalOrder,JournalOrder];
  f.store.data.orders.push(...orders);f.p.long.quantity=90;f.nativeAccounts.get(f.p.long.exchange)!.positions[0].quantity=90;
  f.p.long.feesUsd+=orders[0].result!.feeUsd;f.p.feesUsd+=orders[0].result!.feeUsd;
  f.p.long.realizedPnlUsd=(f.p.long.realizedPnlUsd??0)+.05;f.p.realizedSpreadPnlUsd+=.05;
  let nativeHook=(_result:OrderResult)=>{};
  for(const adapter of f.adapters)adapter.inspectOrder=async(request,id)=>{
    f.reads.push(`ioc-native:${adapter.id}:${id}`);const order=orders.find(o=>o.request.clientOrderId===request.clientOrderId)!;
    const result={...structuredClone(order.result!),orderReadAt:Date.now()};nativeHook(result);return result;
  };
  const input=()=>({...f.input(),confirmedIocBatchId:batchId});
  return {...f,orders,batchId,input,grant:(request:ReturnType<typeof f.input>=input())=>f.engine.restoreSelectedNativeExitManagement(request),
    onNative:(hook:typeof nativeHook)=>{nativeHook=hook;}};
}

test('explicit confirmed IOC restore performs GET only, preserves historical unknown and owns exactly the current difference',async t=>{
  const f=fixture(t),unknown=structuredClone(f.unknown),cash=structuredClone({funding:f.p.fundingUsd,fees:f.p.feesUsd,realized:f.p.realizedSpreadPnlUsd});
  assert.equal(planConfirmedIocTail(f.p,f.store.data.orders,f.batchId).quantity,5);assert.equal(isWitnessedIocLocalVeto(f.orders[1]),true);
  const result=await f.grant(),audit=f.p.nativeExitRecoveryAudit!.at(-1)!;
  assert.equal(result.longQuantity,90);assert.equal(result.shortQuantity,95);
  assert.equal(f.engine.execution.hasNativeExitAuthority(f.p),true);assert.equal(f.engine.execution.hasPendingIocProfitTail(f.p),true);
  assert.equal(audit.originalRemainingBudget,0);assert.equal(audit.confirmedIocRemainingBudget,5);assert.equal(audit.confirmedIocBatchId,f.batchId);
  assert.equal(audit.confirmedTailParentClientOrderId,undefined);assert.equal(audit.nativeReadEvidence.length,4);assert.equal(audit.noOpenOrders.length,2);
  assert.deepEqual(audit.confirmedIocOrders?.map(row=>row.localNoSend),[undefined,true]);
  assert.equal(f.reads.filter(row=>row.startsWith('ioc-native:')).length,1);
  assert.equal(f.reads.some(row=>row.includes('confirmed-ioc-1')),false);assert.deepEqual(f.unknown,unknown);
  assert.deepEqual({funding:f.p.fundingUsd,fees:f.p.feesUsd,realized:f.p.realizedSpreadPnlUsd},cash);
  await assert.rejects(f.grant(),/已接收|变化/);
  const restarted=new Execution(f.store,f.engine.execution.context);
  assert.equal(restarted.hasNativeExitAuthority(f.p),false);assert.equal(restarted.hasPendingIocProfitTail(f.p),false);
  assert.equal(restarted.dispatchIocProfitClose(f.p,'saved audit never authorizes a restarted worker'),false);
});

test('restored IOC tail reduces only its confirmed difference and does not expand into a common batch',async t=>{
  const f=fixture(t);await f.grant();const posts:unknown[]=[],ordersBefore=f.store.data.orders.length,cashBefore=f.p.feesUsd;
  const adapter=f.adapters.find(a=>a.id===f.p.short.exchange)!;
  adapter.placeOrder=async(request,permit)=>{
    assert.equal(permit?.(),true);assert.equal(request.quantity,5);assert.equal(request.reduceOnly,true);
    assert.notEqual(request.clientOrderId,f.orders[1].request.clientOrderId);posts.push(request);
    f.nativeAccounts.get(adapter.id)!.positions[0].quantity=90;
    return {id:'native-new-tail',clientOrderId:request.clientOrderId,status:'filled',filledQuantity:5,averagePrice:request.limitPrice,
      averagePriceVerified:true,feeUsd:5*request.limitPrice*.0005,timestamp:Date.now()};
  };
  assert.equal(f.engine.execution.dispatchIocProfitClose(f.p,'verified original difference'),true);await f.engine.execution.waitIocProfitClose(f.p);
  assert.equal(posts.length,1);assert.equal(f.p.long.quantity,90);assert.equal(f.p.short.quantity,90);
  assert.equal(f.store.data.orders.length,ordersBefore+1);assert.equal(f.engine.execution.hasPendingIocProfitTail(f.p),false);
  const journal=f.store.data.orders.at(-1)!,fee=journal.result!.feeUsd;
  assert.equal(f.p.feesUsd,cashBefore+fee);
  assert.equal(f.engine.execution.applyObservedOrder(journal,structuredClone(journal.result!)),false);
  assert.equal(f.p.feesUsd,cashBefore+fee);assert.equal(f.unknown.result!.status,'unknown');assert.equal(f.store.data.killSwitch,false);
});

test('unique original same-batch IOC intents retain their individual millisecond creation times',async t=>{
  const f=fixture(t);f.orders[0].createdAt--;
  f.orders[0].execution!.quoteAgeMs!++;f.orders[0].execution!.confirmationMs!++;
  assert.equal(planConfirmedIocTail(f.p,f.store.data.orders,f.batchId).quantity,5);
  await f.grant();assert.equal(f.engine.execution.hasPendingIocProfitTail(f.p),true);
});

for(const mutation of ['unknown','hard-rejection','generic-veto','missing-witness','changed-witness','fake-native-id','cash','unbooked-fee',
  'unverified-price','duplicate-client','duplicate-native','wrong-batch','wrong-role','maker','different-quantity','quantity-difference','prior-unknown',
  'receipt-prior-unknown','unapplied-cash','parent-budget'] as const)
test(`selected confirmed IOC restore rejects ${mutation} without any grant`,async t=>{
  const f=fixture(t),[filled,zero]=f.orders;
  if(mutation==='unknown')zero.result!.status='unknown';
  if(mutation==='hard-rejection')zero.result!.rejectionCode='EXCHANGE_HARD_REJECT';
  if(mutation==='generic-veto')zero.result!.rejectionCode='ORDER_SUBMISSION_PERMISSION_CHANGED';
  if(mutation==='missing-witness')delete zero.execution;
  if(mutation==='changed-witness')zero.execution!.confirmationMs!++;
  if(mutation==='fake-native-id')zero.result!.id='fictional-native-id';
  if(mutation==='cash')filled.result!.feeUsd+=.001;
  if(mutation==='unbooked-fee')delete filled.executionEvidence!.bookedFeeUsd;
  if(mutation==='unverified-price')filled.result!.averagePriceVerified=false;
  if(mutation==='duplicate-client')f.store.data.orders.push(structuredClone(filled));
  if(mutation==='duplicate-native')f.store.data.orders.push({...structuredClone(filled),executionEvidence:undefined,
    request:{...filled.request,clientOrderId:'different-client'},result:{...filled.result!,clientOrderId:'different-client'}});
  if(mutation==='wrong-batch')zero.executionEvidence!.batchId='other-batch';
  if(mutation==='wrong-role')filled.executionEvidence!.role='exit-tail';
  if(mutation==='maker')filled.request.postOnly=true;
  if(mutation==='different-quantity')zero.request.quantity=6;
  if(mutation==='quantity-difference'){f.p.short.quantity=96;f.nativeAccounts.get(f.p.short.exchange)!.positions[0].quantity=96;}
  if(mutation==='prior-unknown')zero.originalConfirmation={stage:'order-read',reason:'not-found'};
  if(mutation==='receipt-prior-unknown')zero.result!.originalConfirmation={stage:'order-read',reason:'not-found'};
  if(mutation==='unapplied-cash')filled.reconciliationEvidence=[{observedAt:Date.now(),reason:'unapplied-receipt',positionId:f.p.id,
    exchange:filled.exchange,request:structuredClone(filled.request),result:structuredClone(filled.result!)}];
  if(mutation==='parent-budget')f.store.data.orders.splice(f.store.data.orders.findIndex(o=>o.request.clientOrderId==='confirmed-new-peer'),1);
  await assert.rejects(f.grant());assert.equal(f.engine.execution.hasPendingIocProfitTail(f.p),false);
  assert.equal(f.engine.execution.hasNativeExitAuthority(f.p),false);
});

for(const mutation of ['unknown','native-id','client-id','price','fee','quantity','status','unverified-price','stale-read','future-read'] as const)
test(`native original IOC GET rejects ${mutation} receipt evidence`,async t=>{
  const f=fixture(t);f.onNative(result=>{
    if(mutation==='unknown')result.status='unknown';if(mutation==='native-id')result.id='wrong-native';
    if(mutation==='client-id')result.clientOrderId='wrong-client';if(mutation==='price')result.averagePrice+=.001;
    if(mutation==='fee')result.feeUsd+=.001;if(mutation==='quantity')result.filledQuantity-=1;
    if(mutation==='status')result.status='cancelled';if(mutation==='unverified-price')result.averagePriceVerified=false;
    if(mutation==='stale-read')result.orderReadAt=NOW-1;if(mutation==='future-read')result.orderReadAt=NOW+1;
  });
  await assert.rejects(f.grant(),/原 IOC/);assert.equal(f.engine.execution.hasPendingIocProfitTail(f.p),false);
  assert.equal(f.unknown.result!.status,'unknown');
});

for(const mutation of ['second-quantity','open-order','unknown','config-in-place','generation','permission','stop','manual','foreign-cash','source-cash','expiry'] as const)
test(`fresh account rounds cannot renew IOC authority after ${mutation}`,async t=>{
  const f=fixture(t);f.onAccount((exchange,call,account)=>{
    if(exchange!==f.p.short.exchange||call!==2)return;
    if(mutation==='second-quantity')account.positions[0].quantity=96;
    if(mutation==='unknown')extraUnknown(f);
    if(mutation==='config-in-place')f.store.data.config.minExitProfitBps!++;
    if(mutation==='generation')(f.engine as unknown as {startGeneration:number}).startGeneration++;
    if(mutation==='permission')f.internal.sessionLivePermission=false;
    if(mutation==='stop')f.internal.stopping=true;
    if(mutation==='manual')f.p.manualCloseOnly=true;
    if(mutation==='foreign-cash')f.p.realizedSpreadPnlUsd+=.001;
    if(mutation==='source-cash'){f.orders[0].result!.feeUsd+=.001;f.orders[0].executionEvidence!.bookedFeeUsd=f.orders[0].result!.feeUsd;}
    if(mutation==='expiry')f.advance(30_001);
  });
  if(mutation==='open-order')f.onOpen(exchange=>exchange===f.p.short.exchange?[{id:'unmanaged-native',base:f.p.base,symbol:f.p.short.symbol,
    side:'buy',kind:'regular',reduceOnly:true,quantity:1,remainingQuantity:1}]:[]);
  await assert.rejects(f.grant());assert.equal(f.engine.execution.hasNativeExitAuthority(f.p),false);
  assert.equal(f.engine.execution.hasPendingIocProfitTail(f.p),false);
});

for(const mutation of ['foreign-cash','config','source-cash','save-failure'] as const)
test(`IOC restore save boundary cannot capture ${mutation} into the new authority`,async t=>{
  const f=fixture(t);
  if(mutation==='save-failure')f.failSave();else f.onSave(()=>{
    if(mutation==='foreign-cash')f.p.realizedSpreadPnlUsd+=.001;
    if(mutation==='config')f.store.data.config.minExitProfitBps!++;
    if(mutation==='source-cash'){f.orders[0].result!.feeUsd+=.001;f.orders[0].executionEvidence!.bookedFeeUsd=f.orders[0].result!.feeUsd;}
  });
  await assert.rejects(f.grant());assert.equal(f.engine.execution.hasNativeExitAuthority(f.p),false);
  assert.equal(f.engine.execution.hasPendingIocProfitTail(f.p),false);assert.equal(f.store.data.killSwitch,true);assert.equal(f.engine.autoEnabled,false);
});

for(const mutation of ['cash','config','new-unknown','audit-revoked','stop'] as const)
test(`installed cold IOC grant cannot POST after ${mutation}`,async t=>{
  const f=fixture(t);await f.grant();
  if(mutation==='cash')f.p.realizedSpreadPnlUsd+=.001;
  if(mutation==='config')f.store.data.config.minExitProfitBps!++;
  if(mutation==='new-unknown')extraUnknown(f);
  if(mutation==='audit-revoked')f.p.nativeExitRecoveryAudit!.at(-1)!.revokedAt=Date.now();
  if(mutation==='stop')await f.engine.execution.drainIocProfitCloses();
  assert.equal(f.engine.execution.dispatchIocProfitClose(f.p,'revoked grant'),false);
});

test('recovery schema keeps IOC batch selection explicit and rejects combined Maker/IOC selectors',t=>{
  const f=fixture(t),request=f.input();assert.deepEqual(selectedNativeExitRecoverySchema.parse(request),request);
  assert.equal(selectedNativeExitRecoverySchema.safeParse({...request,confirmedTailParentClientOrderId:'different-maker'}).success,false);
  assert.equal(selectedNativeExitRecoverySchema.safeParse({...request,confirmedIocBatchId:''}).success,false);
  const proof=confirmedIocOrderProof(f.orders[0]);f.orders[0].result!.orderReadAt=Date.now();assert.equal(confirmedIocOrderProof(f.orders[0]),proof);
});

for(const mutation of ['audit-account-quantity','audit-account-round','audit-open-time','ioc-proof-age'] as const)
test(`explicit IOC installer rejects ${mutation} evidence without borrowing the saved grant`,async t=>{
  const f=fixture(t);await f.grant();const audit=f.p.nativeExitRecoveryAudit!.at(-1)!;
  await f.engine.execution.drainIocProfitCloses();
  if(mutation==='audit-account-quantity')audit.nativeReadEvidence[0].quantity++;
  if(mutation==='audit-account-round')audit.nativeReadEvidence.splice(0,1);
  if(mutation==='audit-open-time')audit.noOpenOrders[0].checkedAt=Date.now()-8001;
  if(mutation==='ioc-proof-age')f.advance(8001);
  assert.throws(()=>f.engine.execution.installVerifiedIocTail(f.p,audit));assert.equal(f.engine.execution.hasPendingIocProfitTail(f.p),false);
});

test('configuration changed at the actual restored-tail adapter boundary vetoes any new POST',async t=>{
  const f=fixture(t);await f.grant();let witnessed=false;
  f.adapters.find(a=>a.id===f.p.short.exchange)!.placeOrder=async(request,permit)=>{
    f.store.data.config.minExitProfitBps!++;assert.equal(permit?.(),false);witnessed=true;
    return {id:'',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now(),
      rejectionCode:'ORDER_SUBMISSION_PERMISSION_CHANGED'};
  };
  assert.equal(f.engine.execution.dispatchIocProfitClose(f.p,'frozen original authorization'),true);await f.engine.execution.waitIocProfitClose(f.p);
  assert.equal(witnessed,true);assert.equal(f.engine.execution.hasPendingIocProfitTail(f.p),false);
  assert.equal(f.p.long.quantity,90);assert.equal(f.p.short.quantity,95);
});
