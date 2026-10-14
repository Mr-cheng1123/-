import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { SpreadHistory } from '../src/core/spread-history.js';
import { defaultConfig } from '../src/shared/config.js';
import type { AccountState, AppConfig, ExchangeAdapter, ExchangeId, MarketSnapshot } from '../src/shared/types.js';
import { ReadyHistory } from './ready-history.js';

function snapshot(exchange: ExchangeId): MarketSnapshot {
  const now = Date.now();
  return { exchange, base: 'BTC', symbol: 'BTC/USDT:USDT', source: 'public', timestamp: now, observedAt: now,
    markPrice: 100, indexPrice: 100, fundingRate: exchange === 'gate' ? .001 : .01,
    nextFundingTime: now + 3_600_000, intervalHours: 8, fundingHistory: [],
    bids: [{ price: 100, quantity: 100 }], asks: [{ price: 100, quantity: 100 }],
    openInterestUsd: 1e9, volume24hUsd: 1e9, quantityStep: .01, minQuantity: .01, minNotional: 1, contractSize: 1,
    takerFeeRate:exchange==='bitget'?.0006:exchange==='bybit'?.00055:.0005,takerFeeAt:now,takerFeeSource:'exchange' };
}

function fixture(history: SpreadHistory = new ReadyHistory()) {
  const directory = mkdtempSync(join(tmpdir(), 'funding-authorization-state-'));
  const config: AppConfig = { ...defaultConfig, mode: 'live', dataSource: 'public', symbols: ['BTC'], orderNotionalUsd: 100 };
  const store = new Store(join(directory, 'state.json'), config);
  const env = { ALLOW_LIVE_TRADING: 'false', LIVE_TRADING_ACK: '',
    BYBIT_API_KEY: 'fixture-key', BYBIT_API_SECRET: 'fixture-secret',
    GATE_API_KEY: 'fixture-key', GATE_API_SECRET: 'fixture-secret',
    BITGET_API_KEY: 'fixture-key', BITGET_API_SECRET: 'fixture-secret', BITGET_PASSPHRASE: 'fixture-pass' };
  const failed = new Set<ExchangeId>(['bybit']);
  const accounts = new Map<ExchangeId, AccountState>([
    ['bybit', { freeUsd: 1000, equityUsd: 1000, positions: [] }],
    ['gate', { freeUsd: 1000, equityUsd: 1000, positions: [] }],
    ['bitget', { freeUsd: 1000, equityUsd: 1000, positions: [] }],
  ]);
  let writes = 0;
  const forbidWrite = async (): Promise<never> => { writes++; throw new Error('Offline test must never submit financial operations'); };
  const adapterFactory = (c: AppConfig): ExchangeAdapter[] => c.exchanges.map(id => ({ id,
    fetchAccount: async () => { if (failed.has(id) || !accounts.has(id)) throw new Error('Fixture account unavailable'); return accounts.get(id)!; },
    fetchSnapshots: async () => [snapshot(id)], fetchFundingPayments: async () => [], close: async () => {},
    prepareTrading: forbidWrite, placeOrder: forbidWrite, cancelOrder: forbidWrite, reconcileOrder: forbidWrite,
  }));
  const engine = new Engine(store, false, { liveEnvironment: env, spreadHistory: history, adapterFactory });
  engine.snapshots = [snapshot('gate'), snapshot('bitget')];
  return { engine, store, failed, writes: () => writes,
    cleanup: async () => { await engine.stop(); const target = resolve(directory);
      assert.equal(dirname(target), resolve(tmpdir())); assert(basename(target).startsWith('funding-authorization-state-'));
      rmSync(target, { recursive: true, force: true }); } };
}

test('readiness reports the actual venue permission rather than credential presence', async () => {
  const f = fixture();
  try {
    assert(f.engine.liveReadiness().exchanges.every(venue => venue.executionAuthorized === false));
    await f.engine.startLive('START_LIVE_TRADING');
    const readiness = f.engine.liveReadiness();
    assert.equal(readiness.ready, true);
    assert.deepEqual(readiness.exchanges.map(venue => [venue.exchange, venue.credentialsConfigured, venue.executionAuthorized]), [
      ['binance', false, false], ['bybit', true, false], ['okx', false, false], ['gate', true, true], ['bitget', true, true],
    ]);
    assert.equal(f.writes(), 0); assert.equal(f.store.data.orders.length, 0);
  } finally { await f.cleanup(); }
});

test('state recomputes authorization immediately after start without an engine tick', async () => {
  const f = fixture();
  try {
    const before = f.engine.currentOpportunities().find(opportunity => opportunity.id === 'BTC-gate-bitget')!;
    assert.equal(before.checks?.find(check => check.label === '两腿交易账户已授权')?.pass, false);
    // Deliberately retain a cached pre-authorization result, as the old state endpoint did.
    f.engine.opportunities = [before];
    await f.engine.startLive('START_LIVE_TRADING');
    const after = f.engine.state().opportunities.find(opportunity => opportunity.id === before.id)!;
    assert.equal(after.checks?.find(check => check.label === '两腿交易账户已授权')?.pass, true);
    assert.equal(after.eligible, true);
    assert.equal(before.eligible, false); assert.equal(f.engine.opportunities[0], before);
    assert.equal(f.writes(), 0); assert.equal(f.store.data.orders.length, 0);
  } finally { await f.cleanup(); }
});

test('temporary account read failure affects readiness without revoking the user permission', async () => {
  const f = fixture();
  try {
    await f.engine.startLive('START_LIVE_TRADING'); await f.engine.control('pause');
    f.failed.add('bitget');
    await f.engine.tick();
    const state = f.engine.state();
    assert.equal(state.autoEnabled, false); assert.equal(state.liveUnlocked, true);
    assert.equal(state.liveReadiness?.ready, false);
    assert.equal(state.liveReadiness?.exchanges.find(venue => venue.exchange === 'bitget')?.executionAuthorized, true);
    assert.equal(state.exchanges.find(venue => venue.exchange === 'bitget')?.accountStatus, 'error');
    assert.equal(state.opportunities.find(opportunity => opportunity.id === 'BTC-gate-bitget')?.checks?.find(check => check.label === '两腿交易账户已授权')?.pass, true);
    assert.equal(f.writes(), 0); assert.equal(f.store.data.orders.length, 0);
  } finally { await f.cleanup(); }
});

test('fresh user permission cannot turn pending spread history into an eligible trade', async () => {
  const f = fixture(new SpreadHistory());
  try {
    f.engine.opportunities = f.engine.currentOpportunities();
    await f.engine.startLive('START_LIVE_TRADING');
    const opportunity = f.engine.state().opportunities.find(row => row.id === 'BTC-gate-bitget')!;
    assert.equal(opportunity.checks?.find(check => check.label === '两腿交易账户已授权')?.pass, true);
    assert.equal(opportunity.spreadAdvantage?.status, 'warming');
    assert.equal(opportunity.checks?.find(check => check.label === '价差历史样本充足')?.pass, null);
    assert.equal(opportunity.combinedExpectedNetUsd, null); assert.equal(opportunity.eligible, false);
    assert.equal(f.writes(), 0); assert.equal(f.store.data.orders.length, 0);
  } finally { await f.cleanup(); }
});
