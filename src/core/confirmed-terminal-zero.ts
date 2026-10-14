import type {JournalOrder,Position} from '../shared/types.js';
import {exchangeClientId} from '../adapters/normalization.js';
import {conflictingNativeOrderReceipts} from '../shared/order-receipt-validity.js';
import {isUnconfirmedJournalOrder} from '../shared/ledger-lifecycle.js';

const positive=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>0;
const identity=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.trim()===value;
const makerVenues=new Set(['gate','bybit','bitget']);

/**
 * Reuse only an already committed, identity-matched native Maker cancellation.
 * This proves historical zero cash, not current account quantities or permission
 * to restore management. The caller must freeze the unique original position,
 * freshly verify all positive native cash and both accounts, and audit reuse.
 * No timestamp, receipt, or cash is refreshed or reconstructed here.
 */
export function isDurableConfirmedMakerZero(order:JournalOrder,position:Position,
  orders:readonly JournalOrder[],now=Date.now()):boolean {
  if(!positive(now)||!position||!identity(position.id)||!identity(position.base)||position.mode!=='live'||
    !['open','closing','attention'].includes(position.status)||position.closedAt!==undefined||
    position.manualCloseAccountRecord||position.manualCloseSourcePositionId!==undefined||position.accountClosure||
    position.automaticEntry===false||position.executionEvidence?.entryPath==='manual'||
    !positive(position.openedAt)||position.openedAt>now||
    ![position.long,position.short].every(leg=>leg&&identity(leg.symbol)&&positive(leg.quantity)&&positive(leg.entryPrice))||
    position.long.side!=='long'||position.short.side!=='short'||position.long.exchange===position.short.exchange)return false;
  if(!order||orders.filter(candidate=>candidate===order).length!==1||order.positionId!==position.id||
    !makerVenues.has(order.exchange)||!positive(order.createdAt)||order.createdAt<position.openedAt||order.createdAt>now)return false;
  const request=order.request,result=order.result,metadata=order.makerReduction,evidence=order.executionEvidence;
  if(!request||!result||!metadata||!evidence||!identity(request.clientOrderId)||request.base!==position.base||
    request.reduceOnly!==true||request.postOnly!==true||request.closePosition!==undefined||
    !positive(request.quantity)||!positive(request.limitPrice)||!identity(result.id)||
    result.id===request.clientOrderId||result.id===exchangeClientId(order.exchange,request.clientOrderId)||
    result.clientOrderId!==request.clientOrderId||result.status!=='cancelled'||result.filledQuantity!==0||
    result.averagePrice!==0||result.feeUsd!==0||result.averagePriceVerified!==true||result.confirmation!==undefined||
    order.error!==undefined||metadata.activity!=='terminal'||metadata.bookedExecution!==true||
    !['long','short'].includes(metadata.makerLeg)||evidence.version!==1||evidence.method!=='maker'||
    evidence.role!=='exit'||!identity(evidence.batchId)||evidence.bookedFeeUsd!==0||
    evidence.submittedAt!==metadata.submittedAt)return false;
  // Bybit's existing native cancellation diagnostic is not a create refusal.
  // Its full acknowledged cancellation lifecycle below is still mandatory.
  if(order.exchange==='bybit'?result.rejectionCode!=='EC_PerCancelRequest':result.rejectionCode!==undefined)return false;
  if(result.rejectionCode===undefined&&result.rejectionReason!==undefined)return false;
  const leg=position[metadata.makerLeg];
  if(order.exchange!==leg.exchange||request.symbol!==leg.symbol||request.side!==(leg.side==='long'?'sell':'buy'))return false;
  const lifecycle=[order.createdAt,metadata.submittedAt,metadata.acknowledgedAt,metadata.cancelRequestedAt,
    metadata.lastObservedAt,metadata.observationQueuedAt,metadata.observationCommitStartedAt,
    metadata.observationCommittedAt,metadata.finishedAt];
  if(!lifecycle.every(positive)||lifecycle.some((timestamp,index)=>timestamp!>now||index>0&&timestamp!<lifecycle[index-1]!)||
    !positive(metadata.deadlineAt)||metadata.deadlineAt<order.createdAt||
    !positive(result.timestamp)||result.timestamp<order.createdAt-5000||
    result.timestamp>metadata.lastObservedAt!+5000||result.timestamp>now+5000)return false;
  // A zero terminal receipt may never erase previously observed positive cash
  // or supply a hedge budget to a related peer order.
  if(metadata.firstFillObservedAt!==undefined||metadata.lastFillObservedAt!==undefined||
    metadata.hedgeStartedAt!==undefined||metadata.hedgeCompletedAt!==undefined||
    metadata.recoveredPeers!==undefined||evidence.fills?.length||order.confirmedPeerFeeCorrections?.length)return false;
  const lowerBound=metadata.lotTailObservedExecution;
  if(lowerBound&&(lowerBound.id!==result.id||lowerBound.clientOrderId!==result.clientOrderId||
    lowerBound.filledQuantity!==0||lowerBound.averagePrice!==0||lowerBound.feeUsd!==0||
    lowerBound.averagePriceVerified!==true||lowerBound.confirmation!==undefined||lowerBound.rejectionCode!==undefined))return false;
  const comparison=order.makerCloseComparison;
  if(comparison&&(comparison.status!=='zero-fill'||comparison.makerLeg!==metadata.makerLeg||
    comparison.pairedQuantity!==0||comparison.makerQuantity!==0||comparison.peerQuantity!==0||
    comparison.peerOrderCount!==0||comparison.peerConfirmedOrderCount!==0||comparison.peerPendingOrderCount!==0||
    comparison.peerKnownQuantity!==0||comparison.peerKnownCashUsd!==0||comparison.peerKnownFeeUsd!==0||
    comparison.makerActualCashUsd!==0||comparison.makerActualFeeUsd!==0||
    comparison.peerActualCashUsd!==0||comparison.peerActualFeeUsd!==0))return false;
  const conflicts=conflictingNativeOrderReceipts(orders);
  if(conflicts.has(order))return false;
  for(const candidate of orders){
    // Supported Maker venues use venue-wide native IDs and client intent IDs.
    // A contradictory symbol must not hide a reused identity from grouping.
    if(candidate!==order&&candidate.exchange===order.exchange&&
      (candidate.result?.id===result.id||candidate.request?.clientOrderId===request.clientOrderId))return false;
    const own=candidate.positionId===position.id,sameContract=[position.long,position.short]
      .some(leg=>candidate.exchange===leg.exchange&&candidate.request?.symbol===leg.symbol);
    if((own||sameContract)&&isUnconfirmedJournalOrder(candidate))return false;
    const peerEvidence=candidate.executionEvidence;
    if(peerEvidence?.makerCloseParentClientId===request.clientOrderId||
      peerEvidence?.makerCloseLotTailParentClientIds?.includes(request.clientOrderId))return false;
  }
  return true;
}
