import type {AppConfig} from './types.js';

export const EXECUTION_POLICY_VERSION='simple-v1';

/** Old files remain readable, but these fields cannot influence selection, orders, exits or configuration locks. */
export const retiredConfigFields:ReadonlyArray<keyof AppConfig>=[
  'adaptiveMinNetUsd','adaptiveSettlementGraceSec','minSpreadAdvantageBps','minSpreadNetUsd','minEntryLeadSec',
  'minNetProfitUsd','minNetRateBps','maxBasisBps','maxSlippageBps',
  'minOpenInterestUsd','minVolume24hUsd','maxSettlementSkewSec','entryWindowSec',
  'maxPositionPerCoinUsd','maxTotalPositionUsd','maxLeverage','maxDeltaUsd',
  'minLiquidationDistancePct','fundingSafetyFactor','transferCostUsd','rebalanceCostUsd',
  'exitSlippageBps','basisStressBps'
];
