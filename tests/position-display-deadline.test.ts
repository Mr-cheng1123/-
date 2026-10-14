import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../src/shared/config.js';
import type { AccountPosition, AppState, ExchangeId, MarketSnapshot } from '../src/shared/types.js';
import { quoteIsFresh } from '../src/core/market-validity.js';
import { nativeTakerFeeRate } from '../src/shared/trading-fees.js';
import { nextPositionDisplayTransition } from '../web/src/position-display-deadline.js';
import { ledgerAccountProjection } from '../web/src/ledger-account-projection.js';
import { ledgerPositionMetrics } from '../web/src/ledger-position-metrics.js';
import { ledgerHoldingEstimate } from '../web/src/ledger-holding-estimate.js';

const now = 1_000_000;
const row = (side: 'long' | 'short'): AccountPosition => ({ base: 'CT', symbol: 'CT/USDT:USDT', side,
  quantity: 100, entryPrice:side==='long'?.998:1.002, markPrice: 1, liquidationPrice: 0, leverage: 2, unrealizedPnlUsd: .2,
  realizedPnlUsd: 0, fundingUsd: .2, feesUsd: .05, takerFeeAt: now, takerFeeRate: .0005, takerFeeSource: 'exchange' });
const quote = (exchange: ExchangeId, patch: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
  exchange, base: 'CT', symbol: 'CT/USDT:USDT', source: 'public', timestamp: now, observedAt: now,
  markPrice: 1, indexPrice: 1, bids: [{ price: .999, quantity: 200 }], asks: [{ price: 1.001, quantity: 200 }],
  fundingRate: exchange === 'gate' ? -.001 : .001, nextFundingTime: now + 3600_000, intervalHours: 1,
  fundingHistory: [], openInterestUsd: 1000, volume24hUsd: 1000, quantityStep: 1, minQuantity: 1,
  minNotional: 1, contractSize: 1, ...patch,
});
const fixture = (): AppState => ({ timestamp: now,
  config: { ...structuredClone(defaultConfig), mode: 'live', dataSource: 'public', maxSnapshotAgeMs: 60_000 },
  running: true, autoEnabled: false, killSwitch: false, liveUnlocked: false,
  opportunities: [], exchanges: [], logs: [], equity: [], risk: { status: 'healthy', reasons: [] },
  totals: { fundingUsd: 0, feesUsd: 0, spreadPnlUsd: 0, netPnlUsd: 0, grossExposureUsd: 0, availableBalanceUsd: 0, openPositions: 0 },
  positions: [], snapshots: [quote('gate'), quote('bitget')], livePortfolio: { timestamp: now, pollIntervalMs: 2000,
    maxAgeMs: 15_000, exchanges: (['gate', 'bitget'] as ExchangeId[]).map((exchange, index) => ({
      exchange, credentialsConfigured: true, status: 'ready', requestedAt: now, receivedAt: now,
      positions: [row(index ? 'short' : 'long')],
    })) },
});
const estimate = (state: AppState, at: number) => {
  const position = ledgerAccountProjection(state, at)[0].position;
  return ledgerHoldingEstimate(position, ledgerPositionMetrics(position, state.livePortfolio, at), state, at);
};

test('WS book expiry schedules exact executable-PnL invalidation without switching to a mark reference', () => {
  const state = fixture(); state.snapshots = state.snapshots.map(item => ({ ...item, bookTransport: 'websocket', fundingObservedAt: now }));
  const next = nextPositionDisplayTransition(state, now);
  assert.equal(next, now + 2001);
  assert.equal(estimate(state, next! - 1).basis, 'book');
  assert.equal(estimate(state, next!).basis, 'unknown');
  assert.equal(estimate(state, next!).closeNetPnlUsd, undefined);
  assert.equal(estimate(state, next!).breakEven, 'unknown');
  assert.ok(estimate(state, next!).markNetAfterCloseFeeUsd !== undefined, 'The optional reference remains available only for details.');
  assert.equal(estimate(state, next! - 1).closeBookExpiresAt, next);
});

test('account deadline uses request start and invalidates quantities before a late receive timestamp', () => {
  const state = fixture(); state.livePortfolio!.exchanges[0].requestedAt = now - 14_000;
  state.livePortfolio!.exchanges[0].receivedAt = now;
  const pair = ledgerAccountProjection(state, now)[0].position;
  assert.equal(nextPositionDisplayTransition(state, now), now + 1001);
  assert.equal(estimate(state, now + 1000).basis, 'book');
  const metrics = ledgerPositionMetrics(pair, state.livePortfolio, now + 1001);
  assert.equal(metrics.observation.status, 'unverified');
  assert.equal(metrics.long.quantity, undefined);
  assert.equal(ledgerHoldingEstimate(pair, metrics, state, now + 1001).closeNetPnlUsd, undefined);
});

test('funding metadata can expire before a fresh WS book', () => {
  const state = fixture(); state.snapshots[0] = quote('gate', { bookTransport: 'websocket', fundingObservedAt: now - 29_500 });
  assert.equal(nextPositionDisplayTransition(state, now), now + 501);
  assert.equal(quoteIsFresh(state.snapshots[0], state.config, now + 500), true);
  assert.equal(quoteIsFresh(state.snapshots[0], state.config, now + 501), false);
  assert.equal(estimate(state, now + 501).fundingUsd, undefined);
  assert.equal(estimate(state, now + 501).basis, 'book', 'A funding forecast expiry must not invalidate a fresh closing book.');
  assert.ok(estimate(state, now + 501).closeNetPnlUsd !== undefined);
  assert.equal(estimate(state, now + 501).closeBookExpiresAt, now + 2001);
});

test('official account fees expire at 120 seconds and switch display estimates to labelled local references', () => {
  const state = fixture(), fee = state.livePortfolio!.exchanges[0].positions[0]; fee.takerFeeAt = now - 119_500;
  assert.equal(nextPositionDisplayTransition(state, now), now + 501);
  assert.equal(nativeTakerFeeRate(fee, now + 500), .0005);
  assert.equal(nativeTakerFeeRate(fee, now + 501), undefined);
  assert.equal(estimate(state, now + 500).closingFeeSource, 'exchange');
  assert.equal(estimate(state, now + 501).closingFeeSource, 'reference');
  assert.equal(estimate(state, now + 501).legs[0].takerFeeSource, 'reference');
  assert.equal(estimate(state, now + 501).legs[0].takerFeeAt, undefined);
  assert.ok(Number.isFinite(estimate(state, now + 501).closeNetPnlUsd));
});

test('settlement and future-time skew windows trigger recomputation at their boundaries', () => {
  const state = fixture(); state.snapshots[0].nextFundingTime = now + 250;
  assert.equal(nextPositionDisplayTransition(state, now), now + 250);
  assert.notEqual(estimate(state, now + 249).fundingUsd, undefined);
  assert.equal(estimate(state, now + 250).fundingUsd, undefined);
  state.snapshots[0] = quote('gate', { timestamp: now + 5500, observedAt: now + 5500 });
  assert.equal(nextPositionDisplayTransition(state, now), now + 500);
  assert.equal(quoteIsFresh(state.snapshots[0], state.config, now + 499), false);
  assert.equal(quoteIsFresh(state.snapshots[0], state.config, now + 500), true);
  assert.equal(estimate(state, now + 499).basis, 'unknown');
  assert.equal(estimate(state, now + 500).basis, 'unknown', 'The quote remains outside the permitted two-leg timestamp skew.');
});

test('an unrelated fast book cannot trigger repeated holdings recalculations; paper needs no live timers', () => {
  const state = fixture(); state.snapshots.push(quote('gate', { base: 'BTC', symbol: 'BTC/USDT:USDT',
    bookTransport: 'websocket', fundingObservedAt: now, observedAt: now - 1900 }));
  assert.equal(nextPositionDisplayTransition(state, now), now + 15_001);
  state.config.mode = 'paper'; state.livePortfolio = undefined;
  assert.equal(nextPositionDisplayTransition(state, now), undefined);
});
