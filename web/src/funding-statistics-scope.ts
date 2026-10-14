import { EXCHANGES, type ExchangeId } from '../../src/shared/types.js';
import type { FundingStatsDataset, FundingStatsRow } from '../../src/shared/funding-statistics.js';

/** Keep the existing column order. An explicitly empty scope means no connected venues. */
export function fundingStatisticsExchanges(exchanges: readonly ExchangeId[] = EXCHANGES): ExchangeId[] {
  return EXCHANGES.filter(exchange => exchanges.includes(exchange));
}

/** Scope cells before any ranking, weighting, filtering or totals are calculated. */
export function scopeFundingStatistics<T extends FundingStatsDataset>(data: T, exchanges: readonly ExchangeId[]): T {
  const rows: FundingStatsRow[] = data.rows.flatMap(row => {
    const cells: FundingStatsRow['cells'] = {};
    for (const exchange of exchanges) {
      const cell = row.cells[exchange];
      if (cell) cells[exchange] = cell;
    }
    return Object.keys(cells).length ? [{ ...row, cells }] : [];
  });
  return { ...data, rows };
}
