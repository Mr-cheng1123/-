import type { FundingCandidateView } from '../../src/shared/funding-opportunities';
import { isCurrentBookEstimate, opportunityBookLoss } from './book-cost-presentation';
import { entryPolicy, type EntryPolicy } from './entry-policy';

export interface CandidateProfit {
  fundingUsd: number | null;
  feesUsd: number | null;
  fundingAfterFeesUsd: number | null;
  spreadUsd: number | null;
  /** Positive round-trip cost, excluding fees. Historical spread PnL is not a cost. */
  bookLossUsd: number | null;
  combinedNetUsd: number | null;
  /** Statistical reference estimates do not establish executable quantities or entry readiness. */
  subtotalIsReference: boolean;
  feesPending:boolean;
  feesSource?:FundingCandidateView['feesSource'];
}
/** The legacy live-display option requires an identified official source;
 * reference estimates do not establish native account-fee evidence. */
export interface CandidateProfitOptions {requireNative?:boolean;entryPolicy?:EntryPolicy}

const finite = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value);

/** Aligned entry references count funding minus four fees. Other policies retain their spread accounting. */
export function candidateProfit(row: FundingCandidateView,options:CandidateProfitOptions={}): CandidateProfit {
  const aligned=entryPolicy({entryPolicy:options.entryPolicy},row.execution)==='aligned';
  const feeProof=!options.requireNative||row.execution?.feesSource==='exchange'||row.execution?.feesSource==='reference';
  const completeExecution = !!row.execution && feeProof&&finite(row.execution.expectedFundingUsd) && finite(row.execution.feesUsd) && row.execution.feesUsd >= 0;
  const statistics=row.statistics??row;
  const referenceStatistics=!row.execution&&statistics.feesSource==='reference';
  const funding = completeExecution||options.requireNative&&finite(row.execution?.expectedFundingUsd) ? row.execution!.expectedFundingUsd : statistics.grossFundingUsd;
  const fees = options.requireNative?row.execution&&feeProof?row.execution.feesUsd:referenceStatistics?statistics.feesUsd:undefined:completeExecution ? row.execution!.feesUsd : statistics.feesUsd;
  const feesSource=options.requireNative?row.execution&&feeProof?row.execution.feesSource:referenceStatistics?statistics.feesSource:undefined:completeExecution?row.execution!.feesSource:statistics.feesSource;
  const fundingUsd = finite(funding) ? funding : null;
  const feesUsd = finite(fees) && fees >= 0 ? fees : null;
  const subtotal = fundingUsd !== null && feesUsd !== null ? fundingUsd - feesUsd : null;
  const fundingAfterFeesUsd = finite(subtotal) ? subtotal : null;
  const spread = row.execution?.spreadAdvantage;
  const currentBook = isCurrentBookEstimate(row.execution);
  const bookLossUsd = opportunityBookLoss(row.execution);
  const spreadUsd = currentBook ? bookLossUsd === null ? null : -bookLossUsd :
    spread?.status === 'ready' && finite(spread.expectedSpreadPnlUsd) ? spread.expectedSpreadPnlUsd : null;
  const combined = aligned ? fundingAfterFeesUsd : completeExecution && spreadUsd !== null ? row.execution!.expectedFundingUsd + spreadUsd - row.execution!.feesUsd : null;
  const combinedNetUsd = finite(combined) ? combined : null;
  const subtotalIsReference = !completeExecution;
  return { fundingUsd, feesUsd, fundingAfterFeesUsd, spreadUsd, bookLossUsd, combinedNetUsd, subtotalIsReference,feesPending:options.requireNative===true&&feesUsd===null,feesSource };
}

export type CandidateSortKey = 'expectedNetUsd' | 'afterFeesUsd' | 'grossFundingUsd' | 'feesUsd' | 'normalized8hBps';

/** Sorting can reuse a row's accounting result instead of recomputing it for
 * every comparator call. Missing/invalid values still sort last. */
export function candidateSortValue(row:FundingCandidateView,profit:CandidateProfit,key:CandidateSortKey,dual=true):number|null {
  if (key === 'expectedNetUsd') return dual ? profit.combinedNetUsd : profit.fundingAfterFeesUsd;
  if (key === 'afterFeesUsd') return profit.fundingAfterFeesUsd;
  if (key === 'grossFundingUsd') return profit.fundingUsd;
  if (key === 'feesUsd') return profit.feesUsd;
  return finite(row.normalized8hBps) ? row.normalized8hBps : null;
}

export function compareCandidateValues(av:number|null,bv:number|null,direction:'asc'|'desc'):number {
  if (av === null && bv !== null) return 1;
  if (bv === null && av !== null) return -1;
  return av !== null && bv !== null ? (av - bv) * (direction === 'asc' ? 1 : -1) : 0;
}

/** Unknown totals stay last in either direction; a subtotal is never ranked as a complete total. */
export function compareCandidateProfits(a: FundingCandidateView, b: FundingCandidateView, key: CandidateSortKey, direction: 'asc' | 'desc', dual = true,options:CandidateProfitOptions={}): number {
  return compareCandidateValues(candidateSortValue(a,candidateProfit(a,options),key,dual),candidateSortValue(b,candidateProfit(b,options),key,dual),direction) || a.id.localeCompare(b.id);
}
