import type {JournalOrder,Position} from './types.js';
import {isTerminalOrderReceipt} from './order-receipt-validity.js';

/** Confirmed account closure ends current exposure without rewriting historical fills. */
export function isPositionActive(position:Position):boolean {
  return position.status!=='closed'&&!(position.accountClosure&&Number.isFinite(position.accountClosure.confirmedAt)&&position.accountClosure.confirmedAt>0);
}

/** Only orders created before the independent flat-account proof belong to that archived record. */
export function isHistoricalJournalOrder(order:JournalOrder,positions:readonly Position[]):boolean {
  const closure=positions.find(position=>position.id===order.positionId)?.accountClosure;
  return !!closure&&Number.isFinite(closure.confirmedAt)&&closure.confirmedAt>0&&Number.isFinite(order.createdAt)&&closure.confirmedAt>=order.createdAt;
}

/** A terminal label alone cannot establish original-order identity or complete actual cash. */
export function isUnconfirmedJournalOrder(order:JournalOrder):boolean {
  const request=order?.request,result=order?.result;
  return !!order?.makerReduction&&order.makerReduction.activity!=='terminal'||!request||!result||!isTerminalOrderReceipt(request,result)||!Number.isFinite(result.feeUsd)||
    result.filledQuantity>0&&(!(Number.isFinite(result.averagePrice)&&result.averagePrice>0)||result.averagePriceVerified===false);
}

/** An unresolved historical order is an audit item, rather than a current exposure blocker. */
export function isCurrentUnconfirmedOrder(order:JournalOrder,positions:readonly Position[]):boolean {
  return isUnconfirmedJournalOrder(order)&&!isHistoricalJournalOrder(order,positions);
}
