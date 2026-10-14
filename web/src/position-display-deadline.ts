import type { AppState, MarketSnapshot } from '../../src/shared/types';
import { quoteObservedAt } from '../../src/core/market-validity';
import { NATIVE_TRADING_FEE_MAX_AGE_MS } from '../../src/shared/trading-fees';
import { isFreshPortfolioExchange } from './position-observation';
import { nextPortfolioTransition } from './portfolio-clock';
import { accountPositionMatchesLeg } from './account-position-identity';

/** Schedule display revaluation at the exact boundaries used by the underlying
 * account, quote and fee validators. This changes no execution requirements. */
export function nextPositionDisplayTransition(state: AppState, now: number): number | undefined {
  let next = nextPortfolioTransition(state.livePortfolio, now) ?? Infinity;
  const consider = (value: number | undefined) => { if (value !== undefined && Number.isFinite(value) && value > now) next = Math.min(next, value); };
  const fee = (item: { takerFeeSource?: string; takerFeeAt?: number }) => {
    if (item.takerFeeSource !== 'exchange' || !(item.takerFeeAt! > 0)) return;
    consider(item.takerFeeAt! - 5000);
    consider(item.takerFeeAt! + NATIVE_TRADING_FEE_MAX_AGE_MS + 1);
  };
  const identities = new Set<string>();
  const identity = (exchange: string, symbol: string, base: string) => JSON.stringify([exchange, symbol, base]);
  if (state.livePortfolio) for (const account of state.livePortfolio.exchanges) {
    if (!isFreshPortfolioExchange(account, state.livePortfolio, now)) continue;
    for (const position of account.positions) if (position.quantity > 0) {
      identities.add(identity(account.exchange, position.symbol, position.base));
      identities.add(identity(account.exchange, position.symbol, position.base.toUpperCase()));
      for (const record of state.positions) if (record.status !== 'closed' && !record.accountClosure &&
        [record.long, record.short].some(leg => accountPositionMatchesLeg(account.exchange, position, leg))) {
        identities.add(identity(account.exchange, position.symbol, record.base));
      }
      fee(position);
    }
  }
  const latest = new Map<string, MarketSnapshot>();
  for (const quote of state.snapshots) {
    const key = identity(quote.exchange, quote.symbol, quote.base);
    if (quote.source !== state.config.dataSource || !identities.has(key)) continue;
    const previous = latest.get(key);
    if (!previous || quoteObservedAt(quote) > quoteObservedAt(previous)) latest.set(key, quote);
  }
  for (const quote of latest.values()) {
    const observed = quoteObservedAt(quote);
    consider(quote.timestamp - 5000);
    consider(observed - 5000);
    consider(observed + (quote.bookTransport === 'websocket' ? Math.min(state.config.maxSnapshotAgeMs, 2000) : state.config.maxSnapshotAgeMs) + 1);
    if (quote.fundingObservedAt !== undefined) {
      consider(quote.fundingObservedAt - 5000);
      consider(quote.fundingObservedAt + Math.min(state.config.maxSnapshotAgeMs, 30_000) + 1);
    }
    consider(quote.nextFundingTime);
    fee(quote);
  }
  for (const position of state.positions) {
    if (position.status !== 'closed' && !position.accountClosure) consider(position.holdDecision?.nextReviewAt);
  }
  return Number.isFinite(next) ? next : undefined;
}
