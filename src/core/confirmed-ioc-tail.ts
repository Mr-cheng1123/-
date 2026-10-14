import type {JournalOrder,Position,PositionLeg} from '../shared/types.js';
import {isTerminalOrderReceipt} from '../shared/order-receipt-validity.js';
import {quantitySubtract} from './order-quantity.js';

const localVetoReason='对手价1 IOC 提交前盘口、数量或许可已变化；本次未发送创建请求';
/** This is a durable internal no-send witness, never a guessed remote zero fill. */
export function isWitnessedIocLocalVeto(order:JournalOrder):boolean {
  const r=order.result,e=order.executionEvidence,x=order.execution;
  return !!r&&!!e&&!!x&&r.id===''&&r.clientOrderId===order.request.clientOrderId&&r.status==='cancelled'&&
    r.filledQuantity===0&&r.averagePrice===0&&r.feeUsd===0&&r.rejectionCode==='IOC_REDUCTION_PERMISSION_CHANGED'&&
    r.rejectionReason===localVetoReason&&!order.error&&!order.originalConfirmation&&!r.originalConfirmation&&!r.confirmation&&
    e.bookedFeeUsd===0&&Number.isFinite(e.submittedAt)&&e.submittedAt!>=order.createdAt&&
    Number.isFinite(x.confirmedAt)&&x.confirmedAt!>=e.submittedAt!&&x.confirmationMs===x.confirmedAt!-order.createdAt&&
    Number.isFinite(r.timestamp)&&r.timestamp>=e.submittedAt!&&r.timestamp<=x.confirmedAt!&&
    Number.isFinite(x.bookObservedAt)&&x.bookObservedAt!>0&&x.bookObservedAt!<=order.createdAt&&
    x.quoteAgeMs===order.createdAt-x.bookObservedAt!&&e.referenceObservedAt===x.bookObservedAt&&e.referencePrice===order.request.limitPrice;
}
/** Freeze all original cash/request/witness fields. Read-only timing observations do not alter cash. */
export function confirmedIocOrderProof(order:JournalOrder):string {
  const {result,...rest}=order,{orderReadAt,...cash}=result??{};
  return JSON.stringify({...rest,...(result?{result:cash}:{})});
}
export interface ConfirmedIocTailPlan {batchId:string;orders:[JournalOrder,JournalOrder];leg:PositionLeg;quantity:number}
/** A selected original pair only. No unknown lower bounds, Maker fills or later children become this budget. */
export function planConfirmedIocTail(p:Position,allOrders:readonly JournalOrder[],batchId:string):ConfirmedIocTailPlan {
  const orders=allOrders.filter(order=>order.executionEvidence?.batchId===batchId);
  if(!batchId||orders.length!==2||p.long.exchange===p.short.exchange||
    ![p.long.quantity,p.short.quantity].every(q=>Number.isFinite(q)&&q>=0)||p.long.quantity===p.short.quantity)
    throw new Error('所选 IOC 原批次必须是唯一双腿且存在准确真实尾差');
  const pair=[p.long,p.short].map(leg=>{
    const matches=orders.filter(o=>o.exchange===leg.exchange&&o.request.symbol===leg.symbol);
    if(matches.length!==1)throw new Error('所选 IOC 原批次腿身份不唯一');
    const o=matches[0],r=o.result,e=o.executionEvidence!;
    if(o.positionId!==p.id||o.request.base!==p.base||o.request.side!==(leg.side==='long'?'sell':'buy')||
      o.request.reduceOnly!==true||o.request.postOnly===true||o.request.closePosition!==undefined||o.makerReduction||
      e.method!=='ioc'||e.role!=='exit'||e.makerCloseParentClientId!==undefined||
      !Number.isFinite(o.createdAt)||o.createdAt<=p.openedAt||o.createdAt>Date.now()||!Number.isFinite(o.request.quantity)||o.request.quantity<=0||
      !Number.isFinite(o.request.limitPrice)||o.request.limitPrice<=0||!r||!isTerminalOrderReceipt(o.request,r)||
      !Number.isFinite(r.feeUsd)||e.bookedFeeUsd!==r.feeUsd||!Number.isFinite(r.timestamp)||r.timestamp<=0||
      !Number.isFinite(e.submittedAt)||e.submittedAt!<o.createdAt||e.submittedAt!>Date.now()||
      o.error||o.originalConfirmation||r.originalConfirmation||r.confirmation||o.reconciliationEvidence?.length||
      !Number.isFinite(e.nativeTakerFeeRate)||e.nativeTakerFeeRate!<0||!Number.isFinite(e.feeObservedAt)||
      e.feeObservedAt!<=0||e.feeObservedAt!>o.createdAt||
      allOrders.filter(other=>other.request.clientOrderId===o.request.clientOrderId).length!==1||
      r.rejectionCode!==undefined&&!(r.id===''&&isWitnessedIocLocalVeto(o))||
      r.id===''&&!isWitnessedIocLocalVeto(o)||r.id!==''&&(r.id===o.request.clientOrderId||
        allOrders.filter(other=>other.exchange===o.exchange&&other.result?.id===r.id).length!==1)||
      r.filledQuantity>0&&r.averagePriceVerified!==true)
      throw new Error('所选 IOC 原单缺少唯一身份、完整已入账现金或严格本地未发送见证');
    return o;
  }) as [JournalOrder,JournalOrder];
  if(pair[0].request.quantity!==pair[1].request.quantity)
    throw new Error('所选 IOC 双腿原数量不一致');
  const larger=p.long.quantity>p.short.quantity?p.long:p.short,index=larger===p.long?0:1,
    budget=quantitySubtract(pair[1-index].result!.filledQuantity,pair[index].result!.filledQuantity),
    difference=Math.abs(quantitySubtract(p.long.quantity,p.short.quantity));
  if(!Number.isFinite(budget)||budget<=0||budget!==difference)
    throw new Error('当前真实尾差与所选 IOC 已确认批次现金差量不一致');
  return {batchId,orders:pair,leg:larger,quantity:budget};
}
