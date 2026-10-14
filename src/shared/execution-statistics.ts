import type {ExchangeId,Side} from './types.js';
import type {FundingEntryConfirmationEvidence} from './funding-entry-stability.js';

export type ExecutionMethod='ioc'|'maker-ioc';
export type ExecutionEntryPath='single-cycle'|'price-100'|'manual'|'legacy';
export type ExecutionOrderRole='entry'|'hedge'|'entry-tail'|'exit'|'exit-tail';
export type ExecutionStatisticsStatus='hedged'|'no-fill'|'abnormal'|'pending'|'external';
export type IocSubmissionVetoCode='runtime-permission'|'configuration'|'batch-identity'|'order-identity'|'cash-scope'|
  'native-authority'|'unresolved-order'|'native-proof-age'|'book'|'native-fee'|'profit-threshold'|'exit-condition'|'local-validation';

/** Persist only values captured before the entry. Predictions are never booked cash. */
export interface ExecutionPrediction {
  fundingUsd?:number;singleCycleNetUsd?:number;rawOppositeEdgeBps?:number;makerFeeSavingUsd?:number;
}
export interface CompensationAlternative {
  quantity:number;limitPrice:number;
  /** Signed conditional price PnL, excluding fees; never booked realized cash. */
  pricePnlUsd:number;feesUsd:number;
  /** Fees minus price PnL minus predicted funding, excluding the common, already paid first-leg opening fee. */
  costUsd:number;
  predictedFundingUsd?:number;
  basis?:'current-book-at-cycle-end'|'immediate-rollback';
  longClosePrice?:number;shortClosePrice?:number;
}
export interface CompensationComparisonEvidence {
  observedAt:number;batchId:string;unmatchedSide:'long'|'short';unmatchedQuantity:number;
  hedge?:CompensationAlternative;rollback?:CompensationAlternative;
  decision:'hedge'|'rollback'|'wait';
  /** The hedge assumes the current two close books persist to this funding-cycle endpoint. */
  projectionUntil?:number;longBookObservedAt?:number;shortBookObservedAt?:number;
  longTakerFeeRate?:number;shortTakerFeeRate?:number;
  constraint?:'retry-budget'|'explicit-rejection'|'no-supported-hedge'|'no-fresh-refresh'|'validation-failed';
  /** Confirmed execution result, separate from the conditional decision recorded before any submit. */
  outcome?:'hedged'|'rollback'|'unresolved';
  hedgeFilledQuantity?:number;reducedLongQuantity?:number;reducedShortQuantity?:number;
}
export interface PositionExecutionEvidence {
  version:1;method:ExecutionMethod;entryPath:ExecutionEntryPath;
  prediction?:ExecutionPrediction;compensations?:CompensationComparisonEvidence[];
  fundingEntryStability?:FundingEntryConfirmationEvidence;
}
/** Quantities are BASE COINS after applying the native contract multiplier. */
export interface ExecutionFillEvidence {
  execId:string;quantity:number;price:number;feeUsd:number;
  liquidity:'maker'|'taker';feeCurrency:'USDT';
  /** Local receipt clock; native exchange clocks must not be compared across venues. */
  observedAt:number;exchangeTimestamp?:number;
}
export interface OrderExecutionEvidence {
  version:1;method:'ioc'|'maker';role:ExecutionOrderRole;batchId:string;
  /** Original independent funding evidence authorizing this new automatic first leg. */
  fundingEntryStability?:FundingEntryConfirmationEvidence;
  /** Latest confirmation at the native no-send/create boundary, retained separately from preflight. */
  submissionFundingEntryStability?:FundingEntryConfirmationEvidence;
  /** Exact parent Maker close intent for incremental peer reductions and auditable savings. */
  makerCloseParentClientId?:string;
  /** Scoped lot restoration consumes only the sum of these separately confirmed Maker receipts. */
  makerCloseLotTailOriginalParentClientId?:string;makerCloseLotTailParentClientIds?:string[];
  /** Local adapter.placeOrder call start after durable save; includes any preparation inside the adapter.
   * This is neither proof that a network packet left nor an exchange acceptance/fill clock. */
  submittedAt?:number;
  /** Actual opposite level at preparation, recorded before sending this request. */
  referencePrice?:number;referenceObservedAt?:number;
  nativeTakerFeeRate?:number;nativeMakerFeeRate?:number;feeObservedAt?:number;
  /** Exit estimates freeze the configured rebate and exact reference taker rate before each submitted leg. */
  closeFeeRebatePct?:number;referenceTakerFeeRate?:number;
  /** Actual cumulative fees already applied to local Position. Zero means none applied; raw unknown fees stay unknown. */
  bookedFeeUsd?:number;
  /** A local final-boundary refusal, never native fill/zero-fill or permission evidence. */
  iocSubmissionVeto?:{code:IocSubmissionVetoCode;observedAt:number;nativeProofAgeMs:number;
    requestedLimitPrice:number;bookObservedAt?:number;bestOppositePrice?:number};
  fills?:ExecutionFillEvidence[];
}
export interface ExecutionMoneyMetric {
  /** Complete total only. One missing amount makes this null. */
  valueUsd:number|null;knownUsd:number;knownCount:number;unknownCount:number;
}
export interface ExecutionSampleMetric {
  mean:number|null;max:number|null;knownCount:number;unknownCount:number;
}
export interface ExecutionStatisticsAmounts {
  fundingUsd:number|null;feesUsd:number|null;spreadPnlUsd:number|null;transferCostUsd:number|null;
  /** Complete, closed lifecycle only; never mark-price or predicted profit. */
  closedNetPnlUsd:number|null;
  /** Opening and reduction fees minus realized PnL of confirmed entry compensation. Signed cost. */
  rollbackCostUsd:number|null;
  /** Actual maker fills against a contemporaneously recorded official taker-rate counterfactual. */
  makerFeeSavingUsd:number|null;
}
export interface ExecutionStatisticsTiming {
  /** Local adapter call gap when recorded; row.timingBasis distinguishes legacy intent clocks. */
  firstLegSubmissionGapMs:number|null;firstLegConfirmationGapMs:number|null;
  /** Reconstructed from complete identified local fill observations, not order summaries. */
  unhedgedObservedMs:number|null;longestUnhedgedObservedMs:number|null;
}
export interface ExecutionStatisticsOrder {
  key:string;clientOrderId:string;nativeOrderId:string|null;exchange:ExchangeId;symbol:string;
  side:Side;reduceOnly:boolean;createdAt:number;status:'filled'|'partial'|'cancelled'|'unknown';
  requestQuantity:number|null;filledQuantity:number|null;limitPrice:number|null;averagePrice:number|null;feeUsd:number|null;
  method:'ioc'|'maker';role:ExecutionOrderRole|null;batchId:string|null;
  confirmedAt:number|null;confirmationMs:number|null;bookObservedAt:number|null;quoteAgeMs:number|null;
  submittedAt:number|null;
  referencePrice:number|null;referenceObservedAt:number|null;
  slippageUsd:number|null;slippageBps:number|null;makerFeeSavingUsd:number|null;
  /** Fixed adapter rejection identifiers only; no original API response or exception text. */
  rejectionCode?:string;
}
export interface ExecutionStatisticsRow {
  id:string;base:string;mode:'paper'|'live';method:ExecutionMethod;entryPath:ExecutionEntryPath;
  methodSource:'recorded'|'legacy-ioc';pathSource:'recorded'|'legacy';
  status:ExecutionStatisticsStatus;reason:string;closed:boolean;closeRecorded:boolean;
  openedAt:number;closedAt:number|null;longExchange:ExchangeId|null;shortExchange:ExchangeId|null;
  longQuantity:number|null;shortQuantity:number|null;
  amounts:ExecutionStatisticsAmounts;prediction:ExecutionPrediction|null;
  timing:ExecutionStatisticsTiming;slippageUsd:number|null;slippageBps:number|null;
  timingBasis?:{submission:'outbound'|'journal-intent'|'unknown';confirmation:'local-confirmation'|'unknown';exposure:'identified-fills'|'unknown'};
  compensations:CompensationComparisonEvidence[];orders:ExecutionStatisticsOrder[];
}
export interface ExecutionStatisticsCounts {
  total:number;hedged:number;noFill:number;abnormal:number;pending:number;external:number;
  closed:number;closedKnown:number;
}
export interface ExecutionStatisticsGroup {
  key:string;method:ExecutionMethod;entryPath:ExecutionEntryPath;
  counts:ExecutionStatisticsCounts;
  amounts:{[K in keyof ExecutionStatisticsAmounts]:ExecutionMoneyMetric};
  timing:{[K in keyof ExecutionStatisticsTiming]:ExecutionSampleMetric};
  slippageUsd:ExecutionMoneyMetric;slippageBps:ExecutionSampleMetric;
}
export interface ExecutionStatisticsSummary {
  operations?:import('./trading-operations.js').TradingOperationsSummary;
  timestamp:number;counts:ExecutionStatisticsCounts;groups:ExecutionStatisticsGroup[];
  amounts:{[K in keyof ExecutionStatisticsAmounts]:ExecutionMoneyMetric};
  timing:{[K in keyof ExecutionStatisticsTiming]:ExecutionSampleMetric};
  slippageUsd:ExecutionMoneyMetric;slippageBps:ExecutionSampleMetric;rows:ExecutionStatisticsRow[];
}

const amountKeys:Array<keyof ExecutionStatisticsAmounts>=['fundingUsd','feesUsd','spreadPnlUsd','transferCostUsd','closedNetPnlUsd','rollbackCostUsd','makerFeeSavingUsd'];
const timingKeys:Array<keyof ExecutionStatisticsTiming>=['firstLegSubmissionGapMs','firstLegConfirmationGapMs','unhedgedObservedMs','longestUnhedgedObservedMs'];
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
function money(values:Array<number|null>):ExecutionMoneyMetric {
  const known=values.filter(finite),knownUsd=known.reduce((sum,value)=>sum+value,0),unknownCount=values.length-known.length;
  return {valueUsd:unknownCount||!finite(knownUsd)?null:knownUsd,knownUsd:finite(knownUsd)?knownUsd:0,
    knownCount:known.length,unknownCount};
}
function samples(values:Array<number|null>):ExecutionSampleMetric {
  const known=values.filter(finite),sum=known.reduce((total,value)=>total+value,0);
  return {mean:known.length&&finite(sum)?sum/known.length:null,max:known.length?Math.max(...known):null,
    knownCount:known.length,unknownCount:values.length-known.length};
}
function aggregate(rows:ExecutionStatisticsRow[]){
  const closed=rows.filter(row=>row.status!=='external'&&row.status!=='no-fill'&&(row.closed||row.closeRecorded));
  const counts:ExecutionStatisticsCounts={total:rows.length,hedged:rows.filter(row=>row.status==='hedged').length,
    noFill:rows.filter(row=>row.status==='no-fill').length,abnormal:rows.filter(row=>row.status==='abnormal').length,
    pending:rows.filter(row=>row.status==='pending').length,external:rows.filter(row=>row.status==='external').length,
    closed:closed.filter(row=>row.closed).length,closedKnown:closed.filter(row=>row.closed&&finite(row.amounts.closedNetPnlUsd)).length};
  const amounts={} as ExecutionStatisticsGroup['amounts'],timing={} as ExecutionStatisticsGroup['timing'];
  for(const key of amountKeys)amounts[key]=money((key==='closedNetPnlUsd'||key==='spreadPnlUsd'?closed:rows).map(row=>row.amounts[key]));
  for(const key of timingKeys)timing[key]=samples(rows.map(row=>
    key==='firstLegSubmissionGapMs'&&row.timingBasis?.submission!=='outbound'?null:row.timing[key]));
  return {counts,amounts,timing,slippageUsd:money(rows.map(row=>row.slippageUsd)),slippageBps:samples(rows.map(row=>row.slippageBps))};
}
/** Browser-safe regrouping of an already verified DTO. No new financial facts are inferred here. */
export function summarizeExecutionStatisticsRows(rows:ExecutionStatisticsRow[],now=Date.now()):ExecutionStatisticsSummary {
  const grouped=new Map<string,ExecutionStatisticsRow[]>();
  for(const row of rows){const key=`${row.method}:${row.entryPath}`,group=grouped.get(key)??[];group.push(row);grouped.set(key,group);}
  const groups=[...grouped].sort(([left],[right])=>left.localeCompare(right)).map(([key,entries]):ExecutionStatisticsGroup=>
    ({key,method:entries[0].method,entryPath:entries[0].entryPath,...aggregate(entries)}));
  return {timestamp:now,...aggregate(rows),groups,rows:[...rows]};
}
