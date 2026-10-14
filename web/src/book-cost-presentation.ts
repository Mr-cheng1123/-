import type { Opportunity, RoundTripBookCost } from '../../src/shared/types';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const positive = (value: unknown): value is number => finite(value) && value > 0;
const amountFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 12 });
const priceFormat = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 12 });
const costFormat = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const atFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export const bookQuantity = (value: number | null | undefined) => positive(value) ? amountFormat.format(value) : '—';
/** Contract prices retain significant digits even when one coin costs less than one cent. */
export const bookPrice = (value: number | null | undefined) => positive(value) ? `$${priceFormat.format(value)}` : '—';
/** Costs are positive amounts; signed trading PnL belongs to a different display. */
export const bookCostMoney = (value: number | null | undefined) => finite(value) && value >= 0 ? `$${costFormat.format(value)}` : '待计算';
export const bookObservedAt = (value: number | null | undefined) => positive(value) ? atFormat.format(value) : '未提供采样时间';

export function isCurrentBookEstimate(opportunity: Opportunity | undefined): boolean {
  return !!opportunity && (opportunity.spreadAdvantage?.estimateMethod === 'current-book' ||
    opportunity.entryPolicy === 'aligned' || opportunity.entryPolicy === 'funding');
}

/** Use the estimator's evidence, never a later public snapshot fetched by the page. */
export function usableBookCost(value: RoundTripBookCost | undefined): RoundTripBookCost | undefined {
  if (!value || !positive(value.quantity) ||
    ![value.longOpenPrice, value.longClosePrice, value.shortOpenPrice, value.shortClosePrice].every(positive) ||
    ![value.openingSpreadCostUsd, value.openingDepthImpactUsd, value.closingSpreadCostUsd, value.closingDepthImpactUsd,
      value.openingCostUsd, value.closingCostUsd, value.roundTripBookLossUsd].every(item => finite(item) && item >= 0)) return;
  return value;
}

/** Older replies contain negative cash PnL instead of a positive cost breakdown.
 * Historical estimates keep their original PnL sign and are never renamed costs. */
export function opportunityBookLoss(opportunity: Opportunity | undefined): number | null {
  if (!isCurrentBookEstimate(opportunity)) return null;
  if (opportunity?.spreadAdvantage?.status === 'warming') return null;
  if (opportunity?.bookCost !== undefined) return usableBookCost(opportunity.bookCost)?.roundTripBookLossUsd ?? null;
  const spread = opportunity?.spreadAdvantage;
  return spread?.status === 'ready' && finite(spread.expectedSpreadPnlUsd) && spread.expectedSpreadPnlUsd <= 0
    ? -spread.expectedSpreadPnlUsd : null;
}

export function bookCostScope(opportunity: Opportunity | undefined): string {
  const quantity = opportunity?.bookCost?.quantity ?? opportunity?.entryBatch?.targetQuantity ?? opportunity?.longQuantity;
  return positive(quantity) ? `完整目标 ${bookQuantity(quantity)} 币` : '完整目标';
}

export function firstBatchBookCostCaption(opportunity: Opportunity | undefined): string | null {
  const cost = usableBookCost(opportunity?.entryBatch?.bookCost);
  const target = opportunity?.entryBatch?.targetQuantity;
  return cost && positive(target) && cost.quantity < target * (1 - 1e-9)
    ? `首批 ${bookQuantity(cost.quantity)} 币 · 盘口损耗 ${bookCostMoney(cost.roundTripBookLossUsd)}` : null;
}
