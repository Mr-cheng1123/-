import {EXCHANGES,type EntryExecutionProgress,type ExchangeId,type OrderResult,type Side} from './types.js';

export interface ManualEntryLegExecution {
  exchange:ExchangeId;
  /** Sum of confirmed native fills. These are historical quantities, never current exposure. */
  openedQuantity:number;
  reducedQuantity:number;
  openingAttempts:number;
}
export interface ManualEntryExecutionEvent {
  exchange:ExchangeId;
  phase:'opening'|'reducing';
  side:Side;
  status:OrderResult['status']|'pending'|'error';
  requestedQuantity:number;
  filledQuantity?:number;
  limitPrice?:number;
  averagePrice?:number;
  /** Confirmed cash charge; a negative value is an exchange rebate. */
  feeUsd?:number;
  timestamp:number;
  /** Fixed classifications already present in the journal, never raw private responses. */
  rejectionCode?:string;
  rejectionReason?:string;
}
export interface ManualEntryExecutionSummary {
  /** Goal progress is separate from confirmed historical fills and current exposure. */
  entryExecution?:EntryExecutionProgress;
  long:ManualEntryLegExecution;
  short:ManualEntryLegExecution;
  openingFeesUsd?:number;
  /** Fees of every confirmed reduction, including rollback and later normal closing. */
  rollbackFeesUsd?:number;
  realizedPricePnlUsd?:number;
  netPnlUsd?:number;
  /** Partial receipts preserve confirmed lower bounds; they cannot establish final PnL. */
  accountingStatus:'confirmed'|'partial';
  events:ManualEntryExecutionEvent[];
}

/** A durable receipt for one user click. An operation ID is never reused to create more orders. */
export type ManualEntryState='queued'|'checking'|'preparing'|'submitting'|'reconciling'|'completed'|'failed'|'cancelled'|'expired';
export interface ManualEntryOperation {
  id:string;
  opportunityId:string;
  state:ManualEntryState;
  createdAt:number;
  updatedAt:number;
  expiresAt:number;
  leaseExpiresAt:number;
  positionId?:string;
  message:string;
  cancelable:boolean;
  /** The atomic submission boundary was crossed; a lost reply must never cause a new submission. */
  ordersSubmitted:boolean;
  result?:{positionStatus:string;base:string;longQuantity:number;shortQuantity:number;executionSummary?:ManualEntryExecutionSummary};
  error?:string;
}
export const MANUAL_ENTRY_TERMINAL_STATES:ReadonlySet<ManualEntryState>=new Set(['completed','failed','cancelled','expired']);

/** Opportunity IDs end in two exchange identifiers. A base can itself contain
 * hyphens, so splitting at the first hyphen would claim a different coin. */
export function manualEntryOpportunityBase(id:string):string|undefined {
  const shortSeparator=id.lastIndexOf('-');
  if(shortSeparator<=0)return undefined;
  const shortExchange=id.slice(shortSeparator+1),beforeShort=id.slice(0,shortSeparator);
  const longSeparator=beforeShort.lastIndexOf('-');
  if(longSeparator<=0)return undefined;
  const longExchange=beforeShort.slice(longSeparator+1);
  if(!EXCHANGES.some(exchange=>exchange===longExchange)||!EXCHANGES.some(exchange=>exchange===shortExchange))return undefined;
  const opportunityBase=beforeShort.slice(0,longSeparator).trim().toUpperCase();
  return opportunityBase||undefined;
}

/** Read-only occupancy: elapsed deadlines do not prove an operation ended.
 * Its owner must persist a terminal state before another entry can proceed. */
export function pendingManualEntryBases(operations:readonly ManualEntryOperation[]):Set<string> {
  const bases=new Set<string>();
  for(const operation of operations){
    if(MANUAL_ENTRY_TERMINAL_STATES.has(operation.state))continue;
    const recordedBase=typeof operation.result?.base==='string'?operation.result.base.trim().toUpperCase():undefined;
    const operationBase=recordedBase||manualEntryOpportunityBase(operation.opportunityId);
    if(operationBase)bases.add(operationBase);
  }
  return bases;
}
