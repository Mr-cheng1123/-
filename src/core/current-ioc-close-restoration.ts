import type {JournalOrder,Position} from '../shared/types.js';
import type {ManualCloseOperation} from '../shared/manual-close.js';
import {isPositionActive,isCurrentUnconfirmedOrder,isUnconfirmedJournalOrder} from '../shared/ledger-lifecycle.js';
import {conflictingNativeOrderReceipts,isProvenNoSubmitReceipt} from '../shared/order-receipt-validity.js';
import {quantityAdd,quantitySubtract} from './order-quantity.js';
import {isDurableConfirmedIocOpeningZero} from './confirmed-ioc-opening-zero.js';

export interface CurrentIocNativeOrderProof {
  exchange:JournalOrder['exchange'];clientOrderId:string;nativeOrderId:string;observedAt:number;
}
export interface CurrentIocCloseRestorationAudit {
  acknowledgement:'RECONCILE_CURRENT_STRATEGY_POSITIONS';restoredAt:number;positionId:string;openedAt:number;
  previousStatus:'attention';previousRiskReasons:string[];profitExitNotionalUsd:number;
  previousCloseIntent:{requestedAt:number;attemptedAt:number;reason:string;pricing:'best-opposite';profitRequired:true;pauseReason?:string};
  legs:Array<{exchange:Position['long']['exchange'];symbol:string;side:'long'|'short';quantity:number;entryPrice:number;feesUsd:number;realizedPnlUsd:number}>;
  originalOrders:Array<{exchange:JournalOrder['exchange'];clientOrderId:string;nativeOrderId:string;status:NonNullable<JournalOrder['result']>['status'];
    filledQuantity:number;averagePrice:number;feeUsd:number;bookedFeeUsd:number;nativeObservedAt?:number;localNoSubmit?:true;
    durableZero?:{submittedAt:number;confirmedAt:number;nativeTimestamp:number}}>;
}
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const positive=(value:unknown):value is number=>finite(value)&&value>0;
const equal=(a:number,b:number)=>finite(a)&&finite(b)&&Math.abs(a-b)<=Math.max(1,Math.abs(a),Math.abs(b))*Number.EPSILON*16;
const base=(value:unknown)=>typeof value==='string'?value.trim().toUpperCase():undefined;

/** Local proof only. A caller must still obtain exact native cash, two independent
 * fresh accounts and complete empty native order lists within its selected scope.
 * An active process/worker, Maker or unknown intent cannot borrow this proof. */
export function assertCurrentIocCloseRestorationEligible(p:Position,positions:readonly Position[],orders:readonly JournalOrder[],
  operations:readonly ManualCloseOperation[],now=Date.now()):JournalOrder[] {
  if(!positive(now)||!p||typeof p.id!=='string'||!p.id.trim()||p.id!==p.id.trim()||
    positions.filter(row=>row.id===p.id).length!==1||!positions.includes(p)||
    p.mode!=='live'||p.status!=='attention'||!isPositionActive(p)||p.closedAt!==undefined||
    p.manualCloseOnly||p.manualCloseAccountRecord||p.accountClosure||p.manualCloseSourcePositionId!==undefined||p.manualCloseOperationId!==undefined||
    p.automaticEntry!==true||p.entryPolicy!=='aligned'||p.holdMode!=='adaptive'||p.feeOnly!==true||
    p.executionEvidence?.version!==1||p.executionEvidence.method!=='ioc'||!['single-cycle','price-100'].includes(p.executionEvidence.entryPath)||
    !positive(p.openedAt)||p.openedAt>now||!base(p.base)||p.base!==p.base.trim()||
    !positive(p.closeRequestedAt)||p.closeRequestedAt<p.openedAt||p.closeRequestedAt>now||
    !positive(p.closeAttemptedAt)||p.closeAttemptedAt<p.closeRequestedAt||p.closeAttemptedAt>now||
    typeof p.closeReason!=='string'||!p.closeReason.trim()||p.closeProfitRequired!==true||p.closePricing!=='best-opposite'||
    p.closePauseReason!==undefined&&typeof p.closePauseReason!=='string'||
    !positive(p.profitExitNotionalUsd)||p.long.side!=='long'||p.short.side!=='short'||p.long.exchange===p.short.exchange||
    ![p.long.quantity,p.short.quantity,p.long.entryPrice,p.short.entryPrice].every(positive)||!equal(p.long.quantity,p.short.quantity)||
    ![p.fundingUsd,p.feesUsd,p.transferCostUsd,p.realizedSpreadPnlUsd,p.long.feesUsd,p.short.feesUsd].every(finite))
    throw new Error('所选记录不是重启后可限定恢复的已确认 IOC 条件退出持仓');
  if(positions.some(other=>other!==p&&isPositionActive(other)&&base(other.base)===base(p.base))||
    operations.some(operation=>operation.positionId===p.id||operation.sourcePositionId===p.id))
    throw new Error('所选币种存在重复活跃持仓或原手动操作，未恢复 IOC 管理');
  const own=orders.filter(order=>order.positionId===p.id),conflicts=conflictingNativeOrderReceipts(orders);
  const sameContract=(order:JournalOrder)=>base(order.request?.base)===base(p.base)||[p.long,p.short].some(leg=>
    order.exchange===leg.exchange&&order.request?.symbol===leg.symbol);
  if(!own.length||own.some(order=>conflicts.has(order))||orders.some(order=>sameContract(order)&&
    (isCurrentUnconfirmedOrder(order,positions)||order.positionId!==p.id&&
      Math.max(order.createdAt,order.result?.timestamp??0)>=p.openedAt)))
    throw new Error('所选合约存在未知订单、重复身份或其他新增订单，未恢复 IOC 管理');
  let closeCount=0;
  for(const order of own){
    const request=order.request,result=order.result,evidence=order.executionEvidence,
      leg=[p.long,p.short].find(row=>row.exchange===order.exchange&&row.symbol===request?.symbol);
    if(!request||!result||!leg||request.base!==p.base||!positive(order.createdAt)||order.createdAt<p.openedAt-5000||order.createdAt>now||
      !positive(request.quantity)||!positive(request.limitPrice)||typeof request.reduceOnly!=='boolean'||request.postOnly===true||
      order.makerReduction||order.makerCloseComparison||request.closePosition!==undefined||
      request.side!==(request.reduceOnly?(leg.side==='long'?'sell':'buy'):(leg.side==='long'?'buy':'sell'))||
      isUnconfirmedJournalOrder(order)||!positive(result.timestamp)||result.timestamp>now+5000||
      typeof result.id!=='string'||result.id===request.clientOrderId||result.id!==''&&!result.id.trim()||
      result.id===''&&!isProvenNoSubmitReceipt(request,result)||
      !finite(result.averagePrice)||result.averagePrice<0||!finite(result.feeUsd)||
      result.filledQuantity>0&&result.averagePriceVerified!==true||
      result.filledQuantity===0&&(result.averagePrice!==0||result.feeUsd!==0)||
      evidence?.version!==1||evidence.method!=='ioc'||!equal(evidence.bookedFeeUsd??NaN,result.feeUsd)||
      typeof evidence.batchId!=='string'||!evidence.batchId||evidence.makerCloseParentClientId!==undefined||
      evidence.makerCloseLotTailOriginalParentClientId!==undefined||evidence.makerCloseLotTailParentClientIds!==undefined||
      !(request.reduceOnly?['exit','exit-tail']:['entry','hedge']).includes(evidence.role)||
      request.reduceOnly&&(order.createdAt<p.closeRequestedAt||!evidence.batchId.startsWith(`${p.id}:ioc-close:`))||
      !request.reduceOnly&&order.createdAt>=p.closeRequestedAt)
      throw new Error('原 IOC 开仓或退出缺少完整终态现金与协议身份，未恢复管理');
    if(request.reduceOnly)closeCount++;
  }
  if(!closeCount)throw new Error('原 IOC 条件退出没有完整的原订单记录，未恢复管理');
  const openingCash:number[]=[];
  for(const leg of [p.long,p.short]){
    const rows=own.filter(order=>order.exchange===leg.exchange),opening=rows.filter(order=>!order.request.reduceOnly),closing=rows.filter(order=>order.request.reduceOnly),
      opened=opening.reduce((sum,order)=>quantityAdd(sum,order.result!.filledQuantity),0),
      reduced=closing.reduce((sum,order)=>quantityAdd(sum,order.result!.filledQuantity),0),
      fees=rows.reduce((sum,order)=>sum+order.result!.feeUsd,0),
      cash=opening.reduce((sum,order)=>sum+order.result!.filledQuantity*order.result!.averagePrice,0),
      realized=closing.reduce((sum,order)=>sum+order.result!.filledQuantity*(leg.side==='long'?order.result!.averagePrice-leg.entryPrice:leg.entryPrice-order.result!.averagePrice),0);
    if(!positive(opened)||!equal(quantitySubtract(opened,reduced),leg.quantity)||!equal(fees,leg.feesUsd)||
      !equal(cash/opened,leg.entryPrice)||!equal(realized,leg.realizedPnlUsd??0))
      throw new Error('原 IOC 完整开仓现金、累计费用、已实现损益或余量与持仓不一致，未恢复管理');
    openingCash.push(cash);
  }
  if(!equal(p.profitExitNotionalUsd,(openingCash[0]+openingCash[1])/2)||!equal(p.feesUsd,p.long.feesUsd+p.short.feesUsd)||
    !equal(p.realizedSpreadPnlUsd,(p.long.realizedPnlUsd??0)+(p.short.realizedPnlUsd??0)))
    throw new Error('原固定本金、双腿真实费用或已实现总账不一致，未恢复 IOC 管理');
  return own;
}

/** Detached archival data only. Original orders and all booked cash are retained. */
export function buildCurrentIocCloseRestorationAudit(position:Position,orders:readonly JournalOrder[],
  nativeProofs:readonly CurrentIocNativeOrderProof[],now=Date.now()):CurrentIocCloseRestorationAudit {
  const own=orders.filter(order=>order.positionId===position.id),proofs=new Map(nativeProofs.map(proof=>[proof.clientOrderId,proof]));
  if(position.status!=='attention'||position.closeProfitRequired!==true||position.closePricing!=='best-opposite'||
    !positive(position.closeRequestedAt)||!positive(position.closeAttemptedAt)||!positive(position.profitExitNotionalUsd)||
    typeof position.closeReason!=='string'||!position.closeReason.trim()||!positive(now)||proofs.size!==nativeProofs.length||
    nativeProofs.length!==own.filter(order=>!isProvenNoSubmitReceipt(order.request,order.result)&&
      (!isDurableConfirmedIocOpeningZero(order,position,orders,now)||proofs.has(order.request.clientOrderId))).length)
    throw new Error('IOC 条件退出恢复审计缺少原意图或完整原生核验范围');
  const originalOrders=own.map(order=>{
    const result=order.result!,localNoSubmit=isProvenNoSubmitReceipt(order.request,result),proof=proofs.get(order.request.clientOrderId),
      durableZero=!proof&&isDurableConfirmedIocOpeningZero(order,position,orders,now);
    if(!result||!order.executionEvidence||localNoSubmit&&proof||!localNoSubmit&&!durableZero&&(!proof||proof.exchange!==order.exchange||
      proof.nativeOrderId!==result.id||!positive(proof.observedAt)||proof.observedAt>now||proof.observedAt<order.createdAt||now-proof.observedAt>60_000))
      throw new Error('IOC 条件退出恢复审计的原生订单身份或读取时间不一致');
    return {exchange:order.exchange,clientOrderId:order.request.clientOrderId,nativeOrderId:result.id,status:result.status,
      filledQuantity:result.filledQuantity,averagePrice:result.averagePrice,feeUsd:result.feeUsd,bookedFeeUsd:order.executionEvidence.bookedFeeUsd!,
      ...(localNoSubmit?{localNoSubmit:true as const}:durableZero?{durableZero:{submittedAt:order.executionEvidence.submittedAt!,
        confirmedAt:order.execution!.confirmedAt!,nativeTimestamp:result.timestamp}}:{nativeObservedAt:proof!.observedAt})};
  });
  return structuredClone({acknowledgement:'RECONCILE_CURRENT_STRATEGY_POSITIONS',restoredAt:now,positionId:position.id,openedAt:position.openedAt,
    previousStatus:'attention',previousRiskReasons:position.riskReasons,profitExitNotionalUsd:position.profitExitNotionalUsd,
    previousCloseIntent:{requestedAt:position.closeRequestedAt,attemptedAt:position.closeAttemptedAt,reason:position.closeReason,
      pricing:'best-opposite',profitRequired:true,pauseReason:position.closePauseReason},
    legs:[position.long,position.short].map(leg=>({exchange:leg.exchange,symbol:leg.symbol,side:leg.side,quantity:leg.quantity,
      entryPrice:leg.entryPrice,feesUsd:leg.feesUsd,realizedPnlUsd:leg.realizedPnlUsd??0})),originalOrders});
}
