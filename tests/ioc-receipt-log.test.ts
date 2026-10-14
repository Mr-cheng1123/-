import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {iocReductionReceiptLog} from '../src/core/ioc-receipt-log.js';
import {unknownOrder} from '../src/adapters/normalization.js';
import {isTerminalOrderReceipt} from '../src/shared/order-receipt-validity.js';
import type {JournalOrder,OrderRequest,OrderResult} from '../src/shared/types.js';
import {fixture as nativeFixture,completeKnownTail,NOW} from './native-exit-read-fixture.js';

function order():JournalOrder {
  const request:OrderRequest={clientOrderId:'safe-local-IOC',base:'CVC',symbol:'CVC/USDT:USDT',side:'buy',quantity:44,limitPrice:1.001,reduceOnly:true};
  return {positionId:'memory-cvc',exchange:'bybit',createdAt:NOW-100,request,result:{id:'',clientOrderId:request.clientOrderId,
    status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:NOW,
    rejectionCode:'IOC_REDUCTION_PERMISSION_CHANGED',rejectionReason:'private-response-must-not-appear'}};
}
test('logging needs the current worker witness; isolated internal code or raw reason cannot claim an unsent request',()=>{
  const journal=order(),before=structuredClone(journal);
  const ordinary=iocReductionReceiptLog(journal);assert.doesNotMatch(ordinary,/本次未发送创建/);assert.doesNotMatch(ordinary,/private-response/);
  assert.match(iocReductionReceiptLog(journal,true),/提交前核验未通过；本次未发送创建请求；买入 0 \/ 44/);
  assert.deepEqual(journal,before);
  for(const mutate of [(o:JournalOrder)=>o.result!.id='native-id',(o:JournalOrder)=>o.result!.feeUsd=.001,
    (o:JournalOrder)=>o.result!.rejectionCode='10001',(o:JournalOrder)=>o.result!.clientOrderId='wrong-client']){
    const changed=structuredClone(journal);mutate(changed);assert.doesNotMatch(iocReductionReceiptLog(changed,true),/本次未发送创建/);
  }
});
test('native terminal zero includes its actual terminal status without borrowing a no-send assertion',()=>{
  const journal=order();journal.result!.id='actual-native-id';delete journal.result!.rejectionCode;
  const before=structuredClone(journal),message=iocReductionReceiptLog(journal);
  assert.match(message,/原生订单已终态，零成交（cancelled）/);assert.match(message,/买入 0 \/ 44/);
  assert.doesNotMatch(message,/本次未发送创建|private-response/);assert.deepEqual(journal,before);
});
for(const status of ['filled','partial'] as const)test(`positive ${status} receipt retains the existing actual-fill log`,()=>{
  const journal=order();journal.result={id:'actual-native',clientOrderId:journal.request.clientOrderId,status,
    filledQuantity:status==='filled'?44:4,averagePrice:1,averagePriceVerified:true,feeUsd:.002,timestamp:NOW};
  const before=structuredClone(journal);
  assert.equal(iocReductionReceiptLog(journal),`CVC bybit 对手价1 IOC 减仓 买入 ${journal.result.filledQuantity} / 44`);
  assert.deepEqual(journal,before);
});

test('quantity logs remove binary arithmetic tails without changing a confirmed receipt or request',()=>{
  const journal=order();journal.request.quantity=.7;
  journal.result={id:'actual-native',clientOrderId:journal.request.clientOrderId,status:'filled',
    filledQuantity:.7000000000000001,averagePrice:1,averagePriceVerified:true,feeUsd:.002,timestamp:NOW};
  assert.equal(isTerminalOrderReceipt(journal.request,journal.result),true);
  const before=structuredClone(journal);
  assert.equal(iocReductionReceiptLog(journal),'CVC bybit 对手价1 IOC 减仓 买入 0.7 / 0.7');
  assert.deepEqual(journal,before);
  journal.request.quantity=.30000000000000004;journal.result.filledQuantity=.30000000000000004;
  const decimalBefore=structuredClone(journal);
  assert.equal(iocReductionReceiptLog(journal),'CVC bybit 对手价1 IOC 减仓 买入 0.3 / 0.3');
  assert.deepEqual(journal,decimalBefore);
});

test('a real partial quantity, excess receipt and high precision or large quantity retain their differences',()=>{
  for(const [requested,filled,status] of [[.7,.69999999999,'partial'],[.7,.7000001,'filled'],
    [1.234567890123456,1.234567890123456,'filled'],[1000000000000001,1000000000000001,'filled'],
    [9007199254740990,9007199254740991,'filled'],[123456789123456,123456789123456.02,'filled'],
    [12345678912345.7,12345678912345.703,'filled']] as const){
    const journal=order();journal.request.quantity=requested;
    journal.result={id:'actual-native',clientOrderId:journal.request.clientOrderId,status,filledQuantity:filled,
      averagePrice:1,averagePriceVerified:true,feeUsd:.002,timestamp:NOW};
    const before=structuredClone(journal);
    assert.equal(iocReductionReceiptLog(journal),`CVC bybit 对手价1 IOC 减仓 买入 ${filled} / ${requested}`);
    if(requested===.7&&filled>requested)assert.equal(isTerminalOrderReceipt(journal.request,journal.result),false);
    assert.deepEqual(journal,before);
  }
});

test('quantity display has no absolute zero tolerance and keeps a tiny real partial fill visible',()=>{
  const journal=order();journal.request.quantity=1e-18;
  journal.result={id:'actual-native',clientOrderId:journal.request.clientOrderId,status:'partial',filledQuantity:1e-21,
    averagePrice:1,averagePriceVerified:true,feeUsd:0,timestamp:NOW};
  const before=structuredClone(journal);
  assert.equal(iocReductionReceiptLog(journal),'CVC bybit 对手价1 IOC 减仓 买入 1e-21 / 1e-18');
  assert.deepEqual(journal,before);
});

test('zero-fill quantity formatting preserves local witness and native terminal classification',()=>{
  const journal=order();journal.request.quantity=.30000000000000004;const before=structuredClone(journal);
  assert.match(iocReductionReceiptLog(journal,true),/本次未发送创建请求；买入 0 \/ 0\.3$/);
  assert.match(iocReductionReceiptLog(journal),/发送状态须按原记录核对/);
  assert.doesNotMatch(iocReductionReceiptLog(journal),/本次未发送/);
  journal.result!.id='actual-native-id';delete journal.result!.rejectionCode;
  assert.match(iocReductionReceiptLog(journal),/原生订单已终态，零成交（cancelled）；买入 0 \/ 0\.3，/);
  journal.result!.id=before.result!.id;journal.result!.rejectionCode=before.result!.rejectionCode;
  assert.deepEqual(journal,before);
});

function fixture(t:TestContext){
  const f=nativeFixture(t);completeKnownTail(f);f.store.data.orders.splice(f.store.data.orders.indexOf(f.unknown),1);
  f.store.data.config.profitExitExecutionMode='ioc';f.p.status='open';
  f.p.profitExitPolicy={firstFundingTime:NOW+3_600_000,earliestExitAt:NOW+3_610_000,minSpreadNetUsd:0,minCombinedNetUsd:0,fundingChecks:[]};
  const posts:Array<{exchange:string;request:OrderRequest}>=[];
  const result=(request:OrderRequest,fill:number):OrderResult=>({id:`native-${request.clientOrderId}`,clientOrderId:request.clientOrderId,
    status:fill===request.quantity?'filled':fill>0?'partial':'cancelled',filledQuantity:fill,averagePrice:fill?request.limitPrice:0,
    averagePriceVerified:true,feeUsd:fill*request.limitPrice*.0005,timestamp:Date.now()});
  return {...f,posts,result,async start(){
    assert.equal(f.engine.execution.dispatchIocProfitClose(f.p,'memory receipt log',()=>true),true);await f.engine.execution.waitIocProfitClose(f.p);
  }};
}
test('current-worker local veto logs unsent receipts while preserving zero action count, quantities and cash',async t=>{
  const f=fixture(t),quantities=[f.p.long.quantity,f.p.short.quantity],cash={fees:f.p.feesUsd,realized:f.p.realizedSpreadPnlUsd,funding:f.p.fundingUsd};
  for(const adapter of f.adapters)adapter.placeOrder=async(request,permit)=>{
    f.internal.maintenanceTradingPending=true;assert.equal(permit?.(),false);
    return {id:'',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now(),
      rejectionCode:'ORDER_SUBMISSION_PERMISSION_CHANGED'};
  };
  await f.start();const closing=f.store.data.orders.filter(o=>o.createdAt>=NOW),messages=f.logs.map(row=>String(row[1]));
  assert.equal(closing.length,2);assert.equal(closing.every(o=>o.result?.rejectionCode==='IOC_REDUCTION_PERMISSION_CHANGED'),true);
  assert.equal(messages.filter(message=>message.includes('本次未发送创建请求')).length,2);assert.equal(f.posts.length,0);
  assert.deepEqual([f.p.long.quantity,f.p.short.quantity],quantities);
  assert.deepEqual({fees:f.p.feesUsd,realized:f.p.realizedSpreadPnlUsd,funding:f.p.fundingUsd},cash);
});
test('native zero-fill orders keep actual POST counts and cash unchanged while logs distinguish cancellation',async t=>{
  const f=fixture(t),quantities=[f.p.long.quantity,f.p.short.quantity],cash={fees:f.p.feesUsd,realized:f.p.realizedSpreadPnlUsd,funding:f.p.fundingUsd};
  for(const adapter of f.adapters)adapter.placeOrder=async(request,permit)=>{
    assert.equal(permit?.(),true);f.posts.push({exchange:adapter.id,request});return f.result(request,0);
  };
  await f.start();const closing=f.store.data.orders.filter(o=>o.createdAt>=NOW),messages=f.logs.map(row=>String(row[1]));
  assert.equal(f.posts.length,6);assert.equal(closing.length,6);
  assert.equal(messages.filter(message=>message.includes('原生订单已终态，零成交（cancelled）')).length,6);
  assert.equal(messages.some(message=>message.includes('本次未发送创建')),false);
  assert.deepEqual([f.p.long.quantity,f.p.short.quantity],quantities);
  assert.deepEqual({fees:f.p.feesUsd,realized:f.p.realizedSpreadPnlUsd,funding:f.p.fundingUsd},cash);
});
test('actual terminal partial fills retain their filled quantity and book each receipt once',async t=>{
  const f=fixture(t),fees=f.p.feesUsd;
  for(const adapter of f.adapters)adapter.placeOrder=async(request,permit)=>{
    assert.equal(permit?.(),true);f.posts.push({exchange:adapter.id,request});
    if(f.posts.length===2)f.internal.sessionLivePermission=false;
    return f.result(request,4);
  };
  await f.start();const closing=f.store.data.orders.filter(o=>o.createdAt>=NOW);
  assert.equal(f.posts.length,2);assert.equal(closing.length,2);assert.equal(closing.every(o=>o.result?.status==='partial'),true);
  assert.equal(f.p.long.quantity,91);assert.equal(f.p.short.quantity,91);
  assert.equal(f.p.feesUsd,fees+closing.reduce((sum,o)=>sum+o.result!.feeUsd,0));
  const snapshot=structuredClone(f.p);
  for(const journal of closing)assert.equal(f.engine.execution.applyObservedOrder(journal,structuredClone(journal.result!)),false);
  assert.deepEqual(f.p,snapshot);
});
test('unknown original receipt still freezes and does not borrow a zero-fill or unsent log',async t=>{
  const f=fixture(t);
  for(const adapter of f.adapters)adapter.placeOrder=async(request,permit)=>{
    assert.equal(permit?.(),true);f.posts.push({exchange:adapter.id,request});return unknownOrder(request,`unknown-${request.clientOrderId}`);
  };
  await f.start();const messages=f.logs.map(row=>String(row[1]));
  assert.equal(f.posts.length,2);assert.equal(f.p.status,'attention');
  assert.equal(f.engine.execution.hasPendingIocProfitTail(f.p),false);
  assert.equal(messages.some(message=>message.includes('本次未发送创建')||message.includes('原生订单已终态，零成交')),false);
});
test('restored old close intent waits neutrally without new orders, reads, saves or invented current-session fills',async t=>{
  const f=fixture(t);f.p.status='closing';
  (f.engine as unknown as {continuingClosePositions:Set<string>}).continuingClosePositions.add(f.p.id);
  for(const health of f.engine.health)health.accountUpdatedAt=NOW-60_000;
  const before=structuredClone(f.p),orders=f.store.data.orders.length;
  await f.internal.managePosition(f.p,NOW);
  assert.deepEqual(f.p.riskReasons,['平仓继续处理前等待新鲜账户数量核对；未新增减仓']);
  assert.equal(f.p.status,before.status);assert.equal(f.p.long.quantity,before.long.quantity);assert.equal(f.p.short.quantity,before.short.quantity);
  assert.equal(f.p.feesUsd,before.feesUsd);assert.equal(f.p.realizedSpreadPnlUsd,before.realizedSpreadPnlUsd);
  assert.equal(f.store.data.orders.length,orders);assert.equal(f.reads.length,0);assert.equal(f.saves(),0);assert.equal(f.posts.length,0);
});
