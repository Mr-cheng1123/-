import type {JournalOrder,Position} from '../shared/types.js';
import type {ManualCloseOperation} from '../shared/manual-close.js';
import {isPositionActive,isCurrentUnconfirmedOrder,isUnconfirmedJournalOrder} from '../shared/ledger-lifecycle.js';
import {conflictingNativeOrderReceipts,isProvenNoSubmitReceipt} from '../shared/order-receipt-validity.js';
import {quantityAdd,quantitySubtract} from './order-quantity.js';

export interface CurrentManagementRestorationAudit {
  restoredAt:number;sourceOperationId:string;sourceOperationCreatedAt:number;
  positionId:string;openedAt:number;previousStatus:Position['status'];previousRiskReasons:string[];
  originalManualCloseOnly:true;manualCloseOperationId:string;
  previousCloseIntent:{requestedAt?:number;attemptedAt?:number;reason?:string;
    pricing?:Position['closePricing'];profitRequired?:boolean;pauseReason?:string};
  legs:Array<{exchange:Position['long']['exchange'];symbol:string;side:'long'|'short';quantity:number}>;
  originalOrderIds:Array<{exchange:JournalOrder['exchange'];clientOrderId:string;nativeOrderId:string}>;
}

const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const positive=(value:unknown):value is number=>finite(value)&&value>0;
const equal=(a:number,b:number)=>finite(a)&&finite(b)&&Math.abs(a-b)<=Math.max(Math.abs(a),Math.abs(b))*Number.EPSILON*16;
const base=(value:unknown)=>typeof value==='string'?value.trim().toUpperCase():undefined;

/** Local eligibility only. This grants no account adoption, cancellation or order permission.
 * The caller must independently inspect the exact native receipts, two fresh accounts and
 * complete ordinary/conditional open-order lists before committing any restoration. */
export function assertCurrentManagementRestorationEligible(position:Position,positions:readonly Position[],
  orders:readonly JournalOrder[],operations:readonly ManualCloseOperation[],now=Date.now()):ManualCloseOperation {
  const p=position;
  if(!positive(now)||!p||typeof p.id!=='string'||!p.id.trim()||p.id!==p.id.trim()||
    positions.filter(row=>row.id===p.id).length!==1||!positions.includes(p)||
    p.mode!=='live'||!isPositionActive(p)||!['open','attention'].includes(p.status)||p.closedAt!==undefined||
    p.manualCloseOnly!==true||p.manualCloseAccountRecord||p.accountClosure||p.manualCloseSourcePositionId!==undefined||
    p.automaticEntry===false||p.executionEvidence?.entryPath==='manual'||
    !positive(p.openedAt)||p.openedAt>now||!base(p.base)||p.base!==p.base.trim()||
    p.long.side!=='long'||p.short.side!=='short'||
    p.long.exchange===p.short.exchange||![p.long.quantity,p.short.quantity,p.long.entryPrice,p.short.entryPrice].every(positive)||
    !equal(p.long.quantity,p.short.quantity)||
    ![p.fundingUsd,p.feesUsd,p.transferCostUsd,p.realizedSpreadPnlUsd,p.long.feesUsd,p.short.feesUsd].every(finite))
    throw new Error('所选记录不是可恢复的原正常策略持仓，禁止解除手动管理保护');
  if(positions.some(other=>other!==p&&isPositionActive(other)&&base(other.base)===base(p.base)))
    throw new Error('所选币种存在重复活跃持仓，未恢复管理');
  const matches=operations.filter(row=>row.id===p.manualCloseOperationId),operation=matches[0];
  if(matches.length!==1||!operation||operation.state!=='completed'||operation.positionId!==p.id||
    operation.sourcePositionId!==p.id||!positive(operation.createdAt)||operation.createdAt<p.openedAt||operation.createdAt>now||
    !positive(operation.expiresAt)||operation.expiresAt<=operation.createdAt)
    throw new Error('原所选手动操作尚未结束或来源身份不一致，未恢复管理');
  if(operations.some(other=>other!==operation&&(other.sourcePositionId===p.id||other.positionId===p.id)&&
    (other.state==='checking'||other.state==='closing'||other.createdAt>=operation.createdAt)))
    throw new Error('原策略还存在进行中或后续手动操作，未恢复管理');
  let selection:any;
  try{selection=JSON.parse(operation.selection);}catch{throw new Error('原手动操作缺少完整选择证据，未恢复管理');}
  if(selection?.sourceId!==p.id||selection.base!==p.base||selection.acknowledgement!=='CLOSE_SELECTED_POSITION'||
    !Array.isArray(selection.legs)||selection.legs.length!==2)
    throw new Error('原手动操作选择不属于原双腿策略持仓');
  for(const leg of [p.long,p.short]){
    const selected=selection.legs.filter((row:any)=>row?.exchange===leg.exchange&&row.symbol===leg.symbol&&row.side===leg.side);
    let key:unknown;
    try{key=JSON.parse(selected[0]?.accountPositionKey);}catch{/* Rejected below. */}
    if(selected.length!==1||!equal(selected[0].quantity,leg.quantity)||!Array.isArray(key)||key.length!==5||
      key[0]!==leg.exchange||key[1]!==leg.symbol||key[2]!==leg.side||![null,'crossed','isolated'].includes(key[3])||
      !(key[4]===null||typeof key[4]==='string'&&key[4].trim())||
      selected[0].positionOpenedAt!==undefined&&(!positive(selected[0].positionOpenedAt)||selected[0].positionOpenedAt<p.openedAt-5000))
      throw new Error('原手动选择的合约、方向、账户身份或剩余数量已变化');
  }
  const own=orders.filter(order=>order.positionId===p.id),conflicts=conflictingNativeOrderReceipts(orders);
  if(!own.length||own.some(order=>conflicts.has(order))||orders.some(order=>
    isCurrentUnconfirmedOrder(order,positions)&&(base(order.request?.base)===base(p.base)||
      [p.long,p.short].some(leg=>order.exchange===leg.exchange&&order.request?.symbol===leg.symbol))))
    throw new Error('所选合约存在未确认或重复原订单身份，未恢复管理');
  // No later transaction is silently attributed to an already completed manual operation.
  if(orders.some(order=>(order.positionId===p.id||[p.long,p.short].some(leg=>
    order.exchange===leg.exchange&&order.request?.symbol===leg.symbol))&&
    (!positive(order.createdAt)||order.createdAt>=operation.createdAt)))
    throw new Error('原手动操作开始后出现新订单，须另行核对原操作关联，未恢复管理');
  for(const order of own){
    const request=order.request,result=order.result,leg=[p.long,p.short].find(row=>row.exchange===order.exchange&&row.symbol===request?.symbol);
    if(!request||!result||!leg||request.base!==p.base||!positive(order.createdAt)||order.createdAt<p.openedAt-5000||
      !positive(request.quantity)||!positive(request.limitPrice)||typeof request.reduceOnly!=='boolean'||
      request.side!==(request.reduceOnly?(leg.side==='long'?'sell':'buy'):(leg.side==='long'?'buy':'sell'))||
      isUnconfirmedJournalOrder(order)||!positive(result.timestamp)||result.timestamp>now+5000||
      (result.id===''&&!isProvenNoSubmitReceipt(request,result))||result.id===request.clientOrderId||
      result.id!==''&&!result.id.trim()||!finite(result.averagePrice)||result.averagePrice<0||
      result.filledQuantity===0&&(result.averagePrice!==0||result.feeUsd!==0)||
      order.executionEvidence&&(order.executionEvidence.version!==1||
        !equal(order.executionEvidence.bookedFeeUsd??NaN,result.feeUsd)||
        !(request.reduceOnly?['exit','exit-tail','entry-tail']:['entry','hedge']).includes(order.executionEvidence.role)))
      throw new Error('原开仓或减仓订单缺少精确身份、终态数量及完整真实现金，未恢复管理');
  }
  for(const leg of [p.long,p.short]){
    const rows=own.filter(order=>order.exchange===leg.exchange),opening=rows.filter(order=>!order.request.reduceOnly);
    const opened=opening.reduce((sum,order)=>quantityAdd(sum,order.result!.filledQuantity),0),
      closed=rows.filter(order=>order.request.reduceOnly).reduce((sum,order)=>quantityAdd(sum,order.result!.filledQuantity),0),
      fees=rows.reduce((sum,order)=>sum+order.result!.feeUsd,0),
      cash=opening.reduce((sum,order)=>sum+order.result!.filledQuantity*order.result!.averagePrice,0);
    if(!positive(opened)||!equal(quantitySubtract(opened,closed),leg.quantity)||!equal(fees,leg.feesUsd)||
      !equal(cash/opened,leg.entryPrice))
      throw new Error('原完整开仓现金、累计费用或真实剩余数量与持仓不一致，未恢复管理');
  }
  if(!equal(p.feesUsd,p.long.feesUsd+p.short.feesUsd))
    throw new Error('原双腿实际费用与总账不一致，未恢复管理');
  return operation;
}

/** A detached archival draft. Only the independently verified engine commit may append it. */
export function buildCurrentManagementRestorationAudit(position:Position,operation:ManualCloseOperation,
  orders:readonly JournalOrder[],now=Date.now()):CurrentManagementRestorationAudit {
  if(!positive(now)||position.manualCloseOnly!==true||operation.state!=='completed'||
    operation.id!==position.manualCloseOperationId||operation.positionId!==position.id||operation.sourcePositionId!==position.id)
    throw new Error('当前策略恢复审计的原操作范围不一致');
  return structuredClone({restoredAt:now,sourceOperationId:operation.id,sourceOperationCreatedAt:operation.createdAt,
    positionId:position.id,openedAt:position.openedAt,previousStatus:position.status,previousRiskReasons:position.riskReasons,
    originalManualCloseOnly:true,manualCloseOperationId:operation.id,
    previousCloseIntent:{requestedAt:position.closeRequestedAt,attemptedAt:position.closeAttemptedAt,reason:position.closeReason,
      pricing:position.closePricing,profitRequired:position.closeProfitRequired,pauseReason:position.closePauseReason},
    legs:[position.long,position.short].map(leg=>({exchange:leg.exchange,symbol:leg.symbol,side:leg.side,quantity:leg.quantity})),
    originalOrderIds:orders.filter(order=>order.positionId===position.id).map(order=>({exchange:order.exchange,
      clientOrderId:order.request.clientOrderId,nativeOrderId:order.result!.id})),
  });
}
