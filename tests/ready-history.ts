import type { AppConfig, MarketSnapshot, SpreadAdvantage } from '../src/shared/types.js';
import { SpreadHistory } from '../src/core/spread-history.js';

/**
 * Test double: the spread history already holds enough samples and the opening spread beats the recent exit spread by
 * `advantageBps`. Lets engine/execution tests exercise order flow without waiting for real observation time.
 */
export class ReadyHistory extends SpreadHistory {
  constructor(private readonly advantageBps = 20) { super(); }
  override observe(): void {}
  override serialize() { return []; }
  override assess(long: MarketSnapshot, short: MarketSnapshot, quantity: number, c: AppConfig): SpreadAdvantage {
    const ref = (long.indexPrice + short.indexPrice) / 2;
    const buy = long.asks[0]?.price ?? long.markPrice, sell = short.bids[0]?.price ?? short.markPrice;
    const entrySpreadBps = (sell - buy) / ref * 10000;
    return { status: 'ready', samples: c.spreadMinSamples, requiredSamples: c.spreadMinSamples, observedSpanSec: c.spreadMinSpanSec, requiredSpanSec: c.spreadMinSpanSec,
      longEntryPrice: buy, shortEntryPrice: sell, entrySpreadBps, expectedExitSpreadBps: entrySpreadBps - this.advantageBps,
      spreadAdvantageBps: this.advantageBps, expectedSpreadPnlUsd: quantity * ref * this.advantageBps / 10000 };
  }
}
