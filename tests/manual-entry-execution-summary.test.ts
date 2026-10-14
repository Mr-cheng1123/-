import test from 'node:test';
import assert from 'node:assert/strict';
import {manualEntryExecutionSummary} from '../src/core/manual-entry-execution-summary.js';
import {ManualEntryOperations} from '../src/core/manual-entry-operations.js';
import type {ManualEntryOperation} from '../src/shared/manual-entry.js';
import type {JournalOrder,Position} from '../src/shared/types.js';

function position():Position{return {id:'ct-native-cycle',base:'CT',mode:'live',status:'closed',openedAt:1000,closedAt:2000,plannedExitAt:5000,holdMode:'adaptive',
  long:{exchange:'bitget',symbol:'CT/USDT:USDT',side:'long',quantity:0,entryPrice:.62336,markPrice:900,feesUsd:999,liquidationDistancePct:null},
  short:{exchange:'bybit',symbol:'CT/USDT:USDT',side:'short',quantity:0,entryPrice:0,markPrice:901,feesUsd:999,liquidationDistancePct:null},
  fundingUsd:0,feesUsd:999,transferCostUsd:0,spreadPnlUsd:999,realizedSpreadPnlUsd:999,netPnlUsd:999,deltaUsd:0,fundingEvents:[],riskReasons:[]};}
function order(exchange:'bitget'|'bybit',reduceOnly:boolean,quantity:number,price:number,fee:number,at:number):JournalOrder{
  const filled=exchange==='bitget'?quantity:0;
  return {positionId:'ct-native-cycle',exchange,createdAt:at,request:{clientOrderId:`local-${at}`,base:'CT',symbol:'CT/USDT:USDT',
    side:reduceOnly?'sell':exchange==='bitget'?'buy':'sell',quantity,limitPrice:price,reduceOnly},
    result:{id:`native-${at}`,clientOrderId:`local-${at}`,status:filled?'filled':'cancelled',filledQuantity:filled,averagePrice:filled?price:0,
      averagePriceVerified:true,feeUsd:fee,timestamp:at+1,...(filled?{}:{rejectionCode:'EC_NoImmediateQtyToFill',rejectionReason:'PRIVATE raw payload must never escape'})}};
}
const failedCycle=()=>[order('bitget',false,160,.62336,.05984256,1100),order('bybit',false,160,.6255,0,1101),
  order('bybit',false,160,.6249,0,1200),order('bybit',false,160,.6238,0,1300),order('bitget',true,160,.62125,.05964,1400)];
const near=(value:number|undefined,expected:number)=>assert(Math.abs(value!-expected)<1e-10,`${value} != ${expected}`);

test('closed CT native fills expose all zero-fill attempts and recompute actual rollback loss without mark or ledger guesses',()=>{
  const p=position(),orders=failedCycle(),before=JSON.stringify({p,orders});
  const summary=manualEntryExecutionSummary(p,orders,true);
  assert.deepEqual(summary.long,{exchange:'bitget',openedQuantity:160,reducedQuantity:160,openingAttempts:1});
  assert.deepEqual(summary.short,{exchange:'bybit',openedQuantity:0,reducedQuantity:0,openingAttempts:3});
  assert.equal(summary.accountingStatus,'confirmed');assert.equal(summary.events.length,5);
  near(summary.openingFeesUsd,.05984256);near(summary.rollbackFeesUsd,.05964);near(summary.realizedPricePnlUsd,-.3376);near(summary.netPnlUsd,-.45708256);
  assert(summary.events.filter(event=>event.exchange==='bybit').every(event=>event.status==='cancelled'&&event.filledQuantity===0&&event.averagePrice===undefined));
  assert(summary.events.filter(event=>event.exchange==='bybit').every(event=>event.rejectionCode==='EC_NoImmediateQtyToFill'&&event.rejectionReason!.includes('无可立即成交数量')));
  assert(!JSON.stringify(summary).includes('PRIVATE'));assert.equal(JSON.stringify({p,orders}),before);
});

test('short-first zero fills leave the unsent long at zero attempts with confirmed zero charged fees',()=>{
  const summary=manualEntryExecutionSummary(position(),failedCycle().filter(order=>order.exchange==='bybit'),true);
  assert.equal(summary.long.openingAttempts,0);assert.equal(summary.long.openedQuantity,0);assert.equal(summary.short.openingAttempts,3);
  assert.equal(summary.openingFeesUsd,0);assert.equal(summary.rollbackFeesUsd,0);assert.equal(summary.realizedPricePnlUsd,0);assert.equal(summary.netPnlUsd,0);
});

test('manual outcome exposes safe Bybit cancel types and gives historic missing causes a neutral description',()=>{
  for(const code of ['CancelBySmp','CancelByReduceOnly',undefined]){
    const journal=order('bybit',false,160,.6255,0,1101);journal.result!.rejectionCode=code;
    const before=JSON.stringify(journal),summary=manualEntryExecutionSummary(position(),[journal],true),event=summary.events[0];
    assert.equal(event.rejectionCode,code??'BYBIT_CANCELLED_ZERO_FILL');
    assert.match(event.rejectionReason!,/未形成新仓位/);assert.ok(!JSON.stringify(summary).includes('PRIVATE'));
    if(code===undefined){assert.match(event.rejectionReason!,/具体取消原因尚未识别/);assert.ok(!event.rejectionReason!.includes('无可立即成交数量'));}
    assert.equal(JSON.stringify(journal),before,'Outcome projection cannot rewrite the exchange receipt.');
  }
});

test('manual zero-fill reduction explains that no position was reduced, while a filled receipt has no rejection',()=>{
  const journal=order('bybit',true,160,.6255,0,1101);journal.request.side='buy';
  const event=manualEntryExecutionSummary(position(),[journal],true).events[0];
  assert.equal(event.rejectionCode,'EC_NoImmediateQtyToFill');assert.match(event.rejectionReason!,/仓位尚未因此减少/);
  journal.result!.status='filled';journal.result!.filledQuantity=160;journal.result!.averagePrice=.6255;
  journal.result!.rejectionCode='CancelByUser';
  const filled=manualEntryExecutionSummary(position(),[journal],true).events[0];
  assert.equal(filled.status,'filled');assert.equal(filled.rejectionCode,undefined);assert.equal(filled.rejectionReason,undefined);
});

test('unknown results or missing native fees preserve known quantities but cannot establish full fees or final profit',()=>{
  for(const kind of ['unknown','missing-fee','unverified-price','no-journal'] as const){
    const p=position(),orders=failedCycle();
    if(kind==='unknown'){orders[1].result!.status='unknown';orders[1].result!.filledQuantity=160;orders[1].error='PRIVATE signed request';}
    if(kind==='missing-fee')orders[0].result!.feeUsd=NaN;
    if(kind==='unverified-price')orders[0].result!.averagePriceVerified=false;
    if(kind==='no-journal')orders.length=0;
    const summary=manualEntryExecutionSummary(p,orders,true);
    assert.equal(summary.accountingStatus,'partial',kind);assert.equal(summary.realizedPricePnlUsd,undefined,kind);assert.equal(summary.netPnlUsd,undefined,kind);
    if(kind==='unknown'||kind==='missing-fee'||kind==='no-journal')assert.equal(summary.openingFeesUsd,undefined,kind);
    if(kind==='unknown'){assert.equal(summary.short.openedQuantity,0);assert.equal(summary.events[1].filledQuantity,undefined);assert.equal(summary.events[1].feeUsd,undefined);}
    assert(!JSON.stringify(summary).includes('PRIVATE'));
  }
});

test('a terminal historic receipt reconstructs fresh summary on GET and restart without rewriting its native journal',()=>{
  const p=position(),orders=failedCycle();
  const records:ManualEntryOperation[]=[{id:'old-ct-operation',opportunityId:'CT-bitget-bybit',state:'failed',createdAt:1000,updatedAt:2000,expiresAt:31000,leaseExpiresAt:13000,
    positionId:p.id,message:'已撤回残余仓位',cancelable:false,ordersSubmitted:true,result:{positionStatus:'closed',base:'CT',longQuantity:0,shortQuantity:0}}];
  let writes=0;const before=JSON.stringify({records,p,orders});
  const registry=()=>new ManualEntryOperations(records,{now:()=>3000,persist:()=>{writes++;},log:()=>{},positions:()=>[p],orders:()=>orders,hasOrderIntent:()=>true});
  const first=registry();first.recover();const result=first.get('old-ct-operation')!.result!.executionSummary!;
  near(result.netPnlUsd,-.45708256);result.events[0].filledQuantity=999;result.long.openedQuantity=999;
  assert.equal(first.get('old-ct-operation')!.result!.executionSummary!.long.openedQuantity,160);
  const restarted=registry();restarted.recover();near(restarted.get('old-ct-operation')!.result!.executionSummary!.netPnlUsd,-.45708256);
  assert.equal(writes,0);assert.equal(JSON.stringify({records,p,orders}),before);first.stop();restarted.stop();
});

test('partial BBO1 goal progress is projected without changing confirmed fills or pretending the target was filled',()=>{
  const p=position();p.status='open';p.long.quantity=40;p.short.quantity=40;
  p.entryExecution={pricing:'best-opposite',targetQuantity:160,matchedQuantity:40,completedBatches:2,stopReason:'资金费优势消失，停止补仓'};
  const original=JSON.stringify(p),summary=manualEntryExecutionSummary(p,[],true);
  assert.deepEqual(summary.entryExecution,p.entryExecution);assert.equal(summary.accountingStatus,'partial');
  assert.equal(summary.long.openedQuantity,0,'Without original orders the DTO must not fabricate historic filled quantities.');
  assert.equal(summary.openingFeesUsd,undefined);assert.equal(summary.netPnlUsd,undefined);
  summary.entryExecution!.matchedQuantity=999;assert.equal(JSON.stringify(p),original);
});

test('a completed partial goal receipt refreshes current confirmed quantities while preserving its durable event history',()=>{
  const p=position();p.status='open';p.long.quantity=40;p.short.quantity=40;
  p.entryExecution={pricing:'best-opposite',targetQuantity:160,matchedQuantity:40,completedBatches:2,stopReason:'价格优势不再为正'};
  const records:ManualEntryOperation[]=[{id:'partial-operation',opportunityId:'CT-bitget-bybit',state:'reconciling',createdAt:1000,updatedAt:2000,
    expiresAt:31000,leaseExpiresAt:13000,positionId:p.id,message:'本批处理',cancelable:false,ordersSubmitted:true,
    result:{positionStatus:'opening',base:'CT',longQuantity:0,shortQuantity:0}}];
  const registry=new ManualEntryOperations(records,{now:()=>3000,persist:()=>{},log:()=>{},positions:()=>[p],orders:()=>[],hasOrderIntent:()=>true});
  registry.complete('partial-operation',p);
  const operation=registry.get('partial-operation')!;
  assert.equal(operation.state,'completed');assert.match(operation.message,/原目标尚未补满/);
  assert.equal(operation.result!.longQuantity,40);assert.equal(operation.result!.executionSummary!.entryExecution!.targetQuantity,160);
  p.long.quantity=30;p.short.quantity=30;
  assert.equal(registry.get('partial-operation')!.result!.longQuantity,30,'Polling exposes current known remaining quantity, not a stale result snapshot.');
  assert.equal(records[0].result!.longQuantity,40,'Read-only GET does not rewrite the durable result.');registry.stop();
});
