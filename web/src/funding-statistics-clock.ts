import type { FundingStatsDataset } from '../../src/shared/funding-statistics';

/** The matrix changes between responses only when a cell crosses a freshness boundary. */
export function nextFundingStatisticsTransition(data: FundingStatsDataset | null, now: number): number | undefined {
  if (!data) return undefined;
  let next = Infinity;
  for (const row of data.rows) for (const cell of Object.values(row.cells)) {
    if (!cell?.available) continue;
    const deadlines = [cell.updatedAt - 5000, cell.updatedAt + data.maxAgeMs + 1];
    if (data.range === 'current' && cell.nextFundingTime !== null) deadlines.push(cell.nextFundingTime);
    for (const deadline of deadlines) if (Number.isFinite(deadline) && deadline > now) next = Math.min(next, deadline);
  }
  return Number.isFinite(next) ? next : undefined;
}
