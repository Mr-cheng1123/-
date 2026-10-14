import type {EquityPoint} from './types.js';

export type PerformanceCategory='normal'|'abnormal'|'pending'|'external'|'no_fill';
/** Null means the complete value is not established, never a zero cash flow. */
export interface PerformanceAmounts {
  fundingUsd:number|null;feesUsd:number|null;spreadPnlUsd:number|null;
  transferCostUsd:number|null;netPnlUsd:number|null;
  /** Calculation only; configured official rebates are never confirmed cash receipts. */
  estimatedFeeRebateUsd?:number|null;estimatedNetPnlAfterRebateUsd?:number|null;
}
export interface PerformanceRow extends PerformanceAmounts {
  id:string;base:string;category:PerformanceCategory;reason:string;closed:boolean;
  openedAt:number;closedAt?:number;
}
export interface PerformanceBucket extends PerformanceAmounts {
  count:number;
  /** Rows with a complete, known net value. Other rows remain in count. */
  includedCount:number;
  /** Explicit subtotal of complete rows; do not label it the whole bucket's net. */
  knownNetUsd:number;
}
export interface PerformanceSummary {
  rows:PerformanceRow[];
  normal:PerformanceBucket;abnormal:PerformanceBucket;pending:PerformanceBucket;external:PerformanceBucket;
  noFillCount:number;
  /** Complete closed normal lifecycles only; excludes current marks and failed entry rollbacks. */
  closedNormalEquity:EquityPoint[];
}
