import type {AppConfig,MarketSnapshot} from '../shared/types.js';

/** A current REST answer may describe a book whose last exchange event was hours ago.
 * Freshness is the time we observed the book, not the time someone last changed it. */
export function quoteObservedAt(quote:Pick<MarketSnapshot,'timestamp'|'observedAt'>):number {
  return Number.isFinite(quote.observedAt)?quote.observedAt!:quote.timestamp;
}

export function quoteIsFresh(quote:MarketSnapshot|undefined,config:Pick<AppConfig,'maxSnapshotAgeMs'>,now=Date.now()):quote is MarketSnapshot {
  if(!quote||!Number.isFinite(quote.timestamp)||quote.timestamp>now+5000)return false;
  const observed=quoteObservedAt(quote);
  const maxAge=quote.bookTransport==='websocket'?Math.min(config.maxSnapshotAgeMs,2000):config.maxSnapshotAgeMs;
  // A fast book cannot refresh old funding/contract metadata merely by receiving more book events.
  const metadataFresh=quote.fundingObservedAt===undefined&&quote.bookTransport!=='websocket'||Number.isFinite(quote.fundingObservedAt)&&
    quote.fundingObservedAt!>0&&quote.fundingObservedAt!<=now+5000&&now-quote.fundingObservedAt!<=Math.min(config.maxSnapshotAgeMs,30000);
  return metadataFresh&&Number.isFinite(observed)&&observed>0&&observed<=now+5000&&now-observed<=maxAge;
}
