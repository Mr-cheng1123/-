import type { LivePortfolio } from '../../src/shared/types';

/** Matches isFreshPortfolioExchange: freshness is measured from request start. */
export function nextPortfolioTransition(portfolio: LivePortfolio | undefined, now: number): number | undefined {
  if (!portfolio) return undefined;
  let next = Infinity;
  for (const account of portfolio.exchanges) {
    const requestedAt = account.requestedAt;
    if (!account.credentialsConfigured || account.status !== 'ready' || !Number.isFinite(requestedAt) || !(requestedAt! > 0)) continue;
    for (const deadline of [requestedAt!, requestedAt! + portfolio.maxAgeMs + 1]) {
      if (deadline > now) next = Math.min(next, deadline);
    }
  }
  return Number.isFinite(next) ? next : undefined;
}
