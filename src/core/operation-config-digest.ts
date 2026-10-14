import { createHash } from 'node:crypto';
import type { AppConfig } from '../shared/types.js';

/** A reproducible diagnostic fingerprint of execution settings; never credentials. */
export function operationConfigDigest(config:AppConfig):string {
  const {mode,entryExecutionMode,profitExitExecutionMode,maxOrderRetries,maxSnapshotAgeMs,
    maxQuoteSkewMs,orderNotionalUsd,minEntryIocEdgeBps,entryIocBufferBps,maxEntryBatches,
    takerFees,feeRebatePct,entryPolicy,feeOnly,paperFeeOnly,leverage,marginMode,minExitProfitBps,fundingSafetyFactor,
    exchanges,holdMode,adaptiveConfirmations,minNetRateBps,minNetProfitUsd,minCombinedNetUsd,asyncFundingEntryTiming}=config;
  return createHash('sha256').update(JSON.stringify({mode,entryExecutionMode,profitExitExecutionMode,
    maxOrderRetries,maxSnapshotAgeMs,maxQuoteSkewMs,orderNotionalUsd,minEntryIocEdgeBps,
    entryIocBufferBps,maxEntryBatches,takerFees,feeRebatePct,entryPolicy,feeOnly,paperFeeOnly,leverage,marginMode,minExitProfitBps,
    fundingSafetyFactor,exchanges,holdMode,adaptiveConfirmations,minNetRateBps,minNetProfitUsd,minCombinedNetUsd,
    asyncFundingEntryTiming})).digest('hex');
}
