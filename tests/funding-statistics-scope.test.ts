import test from 'node:test';
import assert from 'node:assert/strict';
import { EXCHANGES, type ExchangeId } from '../src/shared/types.js';
import { comparableRate, fundingCellIsFresh, summarizeFundingRow, type FundingStatsCell, type FundingStatsDataset } from '../src/shared/funding-statistics.js';
import { fundingStatisticsExchanges, scopeFundingStatistics } from '../web/src/funding-statistics-scope.js';

const now = 1790710000000;
const cell = (exchange: ExchangeId, rate: number, intervalHours = 8, changes: Partial<FundingStatsCell> = {}): FundingStatsCell => ({ exchange, rate, intervalHours, nextFundingTime: now + 60_000, updatedAt: now, timestampKind: 'exchange', available: true, ...changes });
const data: FundingStatsDataset = {
  source: 'exchanges', range: 'current', status: 'ready', receivedAt: now, lastAttemptAt: now,
  nextRefreshAt: now + 20_000, maxAgeMs: 60_000, sourceUrl: '', marginScope: 'USDT',
  rows: [
    { base: 'BTC', cells: {
      binance: cell('binance', .0001, 8, { openInterestUsd: 100 }),
      bybit: cell('bybit', .00005, 1, { openInterestUsd: 100 }),
      gate: cell('gate', .00015, 4, { openInterestUsd: 100 }),
      bitget: cell('bitget', .00005, 4, { openInterestUsd: 100 }),
      okx: cell('okx', -.8, 1, { openInterestUsd: 1_000_000 }),
    } },
    { base: 'ONLY_OKX', cells: { okx: cell('okx', 1) } },
  ],
};
const connected = ['binance', 'bybit', 'gate', 'bitget'] as const;

test('unconnected extreme rates do not affect matrix gaps, APR, extrema or weights', () => {
  const scoped = scopeFundingStatistics(data, fundingStatisticsExchanges(connected));
  const summary = summarizeFundingRow(scoped.rows[0], scoped, now);
  assert.equal(summary.available, 4);
  assert.equal(summary.low, 'binance');
  assert.equal(summary.high, 'bybit');
  assert.ok(Math.abs(summary.gap! - .0003) < 1e-12);
  assert.ok(Math.abs(summary.aprPct! - 32.85) < 1e-12);
  assert.ok(Math.abs(summary.oiWeighted8h! - .000225) < 1e-12);
  assert.equal(scoped.rows[0].cells.okx, undefined);
});

test('excluded venues do not count as symbols, negative-rate matches or fresh markets', () => {
  const scoped = scopeFundingStatistics(data, connected);
  assert.deepEqual(scoped.rows.map(row => row.base), ['BTC']);
  assert.equal(scoped.rows.filter(row => row.base.includes('ONLY_OKX')).length, 0);
  const fresh = scoped.rows.flatMap(row => Object.values(row.cells)).filter(cell => cell && fundingCellIsFresh(cell, scoped, now));
  assert.equal(fresh.length, 4);
  assert.equal(fresh.some(cell => comparableRate(cell!, scoped.range, '8h')! < 0), false);
});

test('legacy callers without a scope retain all five exchanges and their old statistics', () => {
  const exchanges = fundingStatisticsExchanges();
  assert.deepEqual(exchanges, [...EXCHANGES]);
  const scoped = scopeFundingStatistics(data, exchanges);
  assert.equal(scoped.rows.length, 2);
  assert.deepEqual(summarizeFundingRow(scoped.rows[0], scoped, now), summarizeFundingRow(data.rows[0], data, now));
});

test('an explicitly empty account scope remains empty rather than falling back to five venues', () => {
  assert.deepEqual(fundingStatisticsExchanges([]), []);
  const scoped = scopeFundingStatistics(data, []);
  assert.deepEqual(scoped.rows, []);
  assert.equal(scoped.receivedAt, data.receivedAt);
  assert.equal(scoped.maxAgeMs, data.maxAgeMs);
});

test('scope preserves existing column order and does not duplicate a venue', () => {
  assert.deepEqual(fundingStatisticsExchanges(['gate', 'binance', 'gate']), ['binance', 'gate']);
});

test('scoping does not mutate public source rows or manufacture missing connected cells', () => {
  const original = structuredClone(data);
  const scoped = scopeFundingStatistics(data, ['bybit']);
  assert.equal(scoped.rows.length, 1);
  assert.equal(summarizeFundingRow(scoped.rows[0], scoped, now).gap, null);
  assert.deepEqual(data, original);
  assert.notEqual(scoped.rows[0].cells, data.rows[0].cells);
});

test('connected stale markets remain visible but cannot drive a fresh gap', () => {
  const staleData: FundingStatsDataset = { ...data, rows: [{ base: 'BTC', cells: {
    bybit: cell('bybit', .00005),
    gate: cell('gate', .5, 8, { updatedAt: now - 60_001 }),
    okx: cell('okx', .9),
  } }] };
  const scoped = scopeFundingStatistics(staleData, ['bybit', 'gate']);
  assert.ok(scoped.rows[0].cells.gate);
  const summary = summarizeFundingRow(scoped.rows[0], scoped, now);
  assert.equal(summary.available, 1);
  assert.equal(summary.gap, null);
  assert.equal(summary.aprPct, null);
});
