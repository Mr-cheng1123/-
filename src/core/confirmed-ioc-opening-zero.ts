import type {JournalOrder,Position} from '../shared/types.js';
import {exchangeClientId} from '../adapters/normalization.js';
import {conflictingNativeOrderReceipts,isTerminalOrderReceipt} from '../shared/order-receipt-validity.js';
import {isUnconfirmedJournalOrder} from '../shared/ledger-lifecycle.js';

export const BITGET_CANCELLED_ORDER_RETENTION_MS=2*60*60*1000;
const positive=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>0;
const identity=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.trim()===value;

/** Historical committed zero only; this never receives a new lookup result, grants
 * execution budget or refreshes cash/read time. Only selected CURRENT recovery may
 * reuse it after independently reading every positive original cash and both accounts. */
export function isDurableConfirmedIocOpeningZero(order:JournalOrder,position:Position,orders:readonly JournalOrder[],now=Date.now()):boolean {
  const p=position;
  if(!positive(now)||!p||p.mode!=='live'||p.status!=='attention'||p.closedAt!==undefined||p.accountClosure||
    p.manualCloseOnly||p.manualCloseAccountRecord||p.manualCloseSourcePositionId!==undefined||p.manualCloseOperationId!==undefined||
    p.automaticEntry!==true||p.feeOnly!==true||p.entryPolicy!=='aligned'||p.holdMode!=='adaptive'||
    p.executionEvidence?.version!==1||p.executionEvidence.method!=='ioc'||!['single-cycle','price-100'].includes(p.executionEvidence.entryPath)||
    p.closeProfitRequired!==true||p.closePricing!=='best-opposite'||!positive(p.closeRequestedAt)||!positive(p.closeAttemptedAt)||
    p.closeAttemptedAt<p.closeRequestedAt||p.closeAttemptedAt>now||!identity(p.closeReason)||!positive(p.profitExitNotionalUsd)||
    !identity(p.id)||!identity(p.base)||!positive(p.openedAt)||p.openedAt>now||p.long.side!=='long'||p.short.side!=='short'||
    p.long.exchange===p.short.exchange||![p.long,p.short].every(leg=>identity(leg.symbol)&&positive(leg.quantity)&&positive(leg.entryPrice)))return false;
  if(!order||orders.filter(candidate=>candidate===order).length!==1||order.positionId!==p.id||order.exchange!=='bitget'||
    !positive(order.createdAt)||order.createdAt<p.openedAt||order.createdAt>=p.closeRequestedAt||order.createdAt>now||order.error!==undefined||
    order.makerReduction||order.makerCloseComparison||order.confirmedPeerFeeCorrections?.length)return false;
  const request=order.request,result=order.result,evidence=order.executionEvidence,timing=order.execution,
    leg=[p.long,p.short].find(row=>row.exchange===order.exchange&&row.symbol===request?.symbol);
  if(!request||!result||!evidence||!timing||!leg||request.base!==p.base||!identity(request.clientOrderId)||
    request.reduceOnly!==false||request.postOnly===true||request.closePosition!==undefined||
    request.side!==(leg.side==='long'?'buy':'sell')||!positive(request.quantity)||!positive(request.limitPrice)||
    !identity(result.id)||result.id===request.clientOrderId||result.id===exchangeClientId('bitget',request.clientOrderId)||
    result.clientOrderId!==request.clientOrderId||!isTerminalOrderReceipt(request,result)||result.status!=='cancelled'||
    result.filledQuantity!==0||result.averagePrice!==0||result.feeUsd!==0||result.averagePriceVerified!==true||
    result.confirmation!==undefined||result.rejectionCode!==undefined||result.rejectionReason!==undefined||
    evidence.version!==1||evidence.method!=='ioc'||!['entry','hedge'].includes(evidence.role)||!identity(evidence.batchId)||
    evidence.bookedFeeUsd!==0||evidence.fills?.length||evidence.makerCloseParentClientId!==undefined||
    evidence.makerCloseLotTailOriginalParentClientId!==undefined||evidence.makerCloseLotTailParentClientIds!==undefined||
    !['rest','websocket'].includes(timing.bookTransport)||!positive(timing.bookObservedAt)||
    timing.bookObservedAt>order.createdAt||timing.quoteAgeMs!==order.createdAt-timing.bookObservedAt||
    !positive(evidence.submittedAt)||evidence.submittedAt<order.createdAt||
    !positive(timing.confirmedAt)||timing.confirmedAt<evidence.submittedAt||timing.confirmedAt>now||
    timing.confirmationMs!==timing.confirmedAt-order.createdAt||now-timing.confirmedAt<BITGET_CANCELLED_ORDER_RETENTION_MS||
    !positive(result.timestamp)||result.timestamp<order.createdAt-5000||result.timestamp>timing.confirmedAt+5000||result.timestamp>now+5000)return false;
  if(order.reconciliationEvidence?.some(row=>row.positionId!==p.id||row.exchange!==order.exchange||
    row.request.clientOrderId!==request.clientOrderId||row.result.id!==result.id||row.result.clientOrderId!==result.clientOrderId||
    row.result.status!=='cancelled'||row.result.confirmation!==undefined||row.result.filledQuantity!==0||
    row.result.averagePrice!==0||row.result.feeUsd!==0))return false;
  if(conflictingNativeOrderReceipts(orders).has(order))return false;
  for(const other of orders){
    if(other!==order&&other.exchange===order.exchange&&(other.result?.id===result.id||other.request?.clientOrderId===request.clientOrderId))return false;
    const same=other.positionId===p.id||[p.long,p.short].some(side=>other.exchange===side.exchange&&other.request?.symbol===side.symbol);
    if(same&&isUnconfirmedJournalOrder(other))return false;
    if(other.executionEvidence?.makerCloseParentClientId===request.clientOrderId||
      other.executionEvidence?.makerCloseLotTailParentClientIds?.includes(request.clientOrderId))return false;
  }
  return true;
}
