import test from 'node:test';
import assert from 'node:assert/strict';
import type { LivePortfolio } from '../src/shared/types.js';
import { nextPortfolioTransition } from '../web/src/portfolio-clock.js';
import { portfolioPositionSummary } from '../web/src/position-observation.js';

const portfolio = (): LivePortfolio => ({ timestamp: 20_000, pollIntervalMs: 2000, maxAgeMs: 15_000,
  exchanges: [{ exchange: 'bybit', credentialsConfigured: true, status: 'ready', requestedAt: 10_000,
    receivedAt: 20_000, positions: [{ base: 'BTC', symbol: 'BTCUSDT', quantity: 1, side: 'long', markPrice: 100,
      liquidationPrice: 0, leverage: 2 }] }] });

test('portfolio count expires from requestedAt, not later receivedAt, while polls are stalled', () => {
  const data = portfolio(), next = nextPortfolioTransition(data, 20_000);
  assert.equal(next, 25_001);
  assert.equal(portfolioPositionSummary(data, next! - 1).count, 1);
  assert.equal(portfolioPositionSummary(data, next!).count, null);
  assert.equal(nextPortfolioTransition(data, next!), undefined);
});

test('future account observations become usable at request timestamp; failed accounts do not schedule refresh', () => {
  const data = portfolio(); data.exchanges[0].requestedAt = 21_000;
  assert.equal(nextPortfolioTransition(data, 20_000), 21_000);
  assert.equal(portfolioPositionSummary(data, 20_999).count, null);
  assert.equal(portfolioPositionSummary(data, 21_000).count, 1);
  data.exchanges[0].status = 'error';
  assert.equal(nextPortfolioTransition(data, 20_000), undefined);
  assert.equal(portfolioPositionSummary(data, 21_000).count, null);
});
