import test from 'node:test';
import assert from 'node:assert/strict';
import { fundingCellIsFresh, type FundingStatsCell, type FundingStatsDataset } from '../src/shared/funding-statistics.js';
import { nextFundingStatisticsTransition } from '../web/src/funding-statistics-clock.js';

const cell = (changes: Partial<FundingStatsCell> = {}): FundingStatsCell => ({
  exchange: 'bybit', rate: .001, intervalHours: 1, nextFundingTime: null,
  updatedAt: 10_000, timestampKind: 'exchange', available: true, ...changes,
});
const dataset = (cells: FundingStatsCell[], changes: Partial<FundingStatsDataset> = {}): FundingStatsDataset => ({
  source: 'exchanges', range: 'current', status: 'ready', receivedAt: 10_000,
  lastAttemptAt: 10_000, nextRefreshAt: 15_000, maxAgeMs: 120_000,
  sourceUrl: '', marginScope: '', rows: cells.map((item, index) => ({ base: `COIN${index}`, cells: { bybit: item } })), ...changes,
});

test('matrix freshness expires even if all network polls stop, with the same inclusive max-age rule', () => {
  const item = cell(), data = dataset([item]);
  const next = nextFundingStatisticsTransition(data, 10_000);
  assert.equal(next, 130_001);
  assert.equal(fundingCellIsFresh(item, data, next! - 1), true);
  assert.equal(fundingCellIsFresh(item, data, next!), false);
  assert.equal(nextFundingStatisticsTransition(data, next!), undefined);
});

test('funding settlement immediately invalidates current-rate cells before cache expiry', () => {
  const item = cell({ nextFundingTime: 15_000 }), data = dataset([item]);
  const next = nextFundingStatisticsTransition(data, 10_000);
  assert.equal(next, 15_000);
  assert.equal(fundingCellIsFresh(item, data, next! - 1), true);
  assert.equal(fundingCellIsFresh(item, data, next!), false);
  assert.equal(nextFundingStatisticsTransition(dataset([item], { range: '1d' }), 10_000), 130_001);
});

test('future exchange timestamps enter the allowed skew window at the exact boundary', () => {
  const item = cell({ updatedAt: 25_000 }), data = dataset([item]);
  const next = nextFundingStatisticsTransition(data, 10_000);
  assert.equal(next, 20_000);
  assert.equal(fundingCellIsFresh(item, data, next! - 1), false);
  assert.equal(fundingCellIsFresh(item, data, next!), true);
});

test('earliest live-cell deadline wins; unavailable cells and no data need no repaint', () => {
  const data = dataset([cell({ nextFundingTime: 19_000 }), cell({ nextFundingTime: 11_000, available: false }), cell({ nextFundingTime: 16_000 })]);
  assert.equal(nextFundingStatisticsTransition(data, 10_000), 16_000);
  assert.equal(nextFundingStatisticsTransition(dataset([cell({ available: false })]), 10_000), undefined);
  assert.equal(nextFundingStatisticsTransition(null, 10_000), undefined);
});
