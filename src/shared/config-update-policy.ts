import type {AppConfig} from './types.js';
import {retiredConfigFields} from './execution-profile.js';

/** These fields affect selection of new entries; existing positions retain their own execution policy. */
const entryOnlyFields=new Set<keyof AppConfig>([
  'fundingStatsSource','orderNotionalUsd','hedgeMode','holdMode','entryPolicy',
  'dualAdvantageEnabled','spreadLookbackMinutes','spreadMinSamples','spreadMinSpanSec','spreadSampleIntervalSec',
  'spreadWarmupProfile',
  'minSpreadAdvantageBps','minSpreadNetUsd','minCombinedNetUsd','minEntryLeadSec','minNetProfitUsd','minNetRateBps','minEntryIocEdgeBps',
  'minOpenInterestUsd','minVolume24hUsd','maxSettlementSkewSec','entryWindowSec','transferCostUsd','rebalanceCostUsd',
  'maxQuoteSkewMs','maxEntryBatches','entryIocBufferBps','entryExecutionMode','asyncFundingEntryTiming',
  'maxHoldHours',
]);
const holdingDecisionFields=new Set<keyof AppConfig>(['exitWeakFundingBps','minExitProfitUsd','minExitProfitBps','feeRebatePct','profitExitExecutionMode']);

export function configUpdatePolicy(current:AppConfig,next:AppConfig):{
  changedFields:Array<keyof AppConfig>;criticalFields:Array<keyof AppConfig>;entryOnly:boolean;
}{
  // Both values come from the same validated JSON schema, including the canonical fee-object key order.
  const value=(config:AppConfig,key:keyof AppConfig)=>key==='entryPolicy'?config.entryPolicy??'dual':config[key];
  const changedFields=(Object.keys(next) as Array<keyof AppConfig>).filter(key=>key!=='autoEnabled'&&!retiredConfigFields.includes(key)&&JSON.stringify(value(current,key))!==JSON.stringify(value(next,key)));
  const criticalFields=changedFields.filter(key=>!entryOnlyFields.has(key)&&!holdingDecisionFields.has(key));
  return {changedFields,criticalFields,entryOnly:criticalFields.length===0};
}
