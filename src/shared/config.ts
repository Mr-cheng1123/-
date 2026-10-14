import { z } from 'zod';
import type { AppConfig } from './types.js';
import {retiredConfigFields} from './execution-profile.js';
import {responsiveSpreadWarmup,SPREAD_WARMUP_PROFILE_VERSION,spreadWarmupProfile} from './spread-warmup-profile.js';
const positive = z.number().finite().positive();
const nonnegative = z.number().finite().nonnegative();
export const configSchema = z.object({
  mode:z.enum(['paper','live']), dataSource:z.enum(['demo','public']),
  fundingStatsSource:z.enum(['auto','exchanges','coinglass']),
  entryPolicy:z.enum(['aligned','funding','dual']).default('dual'),
  paperFeeOnly:z.boolean().default(false),feeOnly:z.boolean().default(false),
  exchanges:z.array(z.enum(['binance','bybit','okx','gate','bitget'])).min(2).max(5).refine(v=>new Set(v).size===v.length,'交易所不可重复'),
  symbols:z.array(z.string().regex(/^[A-Z0-9]{2,15}$/)).min(1).max(30).refine(v=>new Set(v).size===v.length,'币种不可重复'),
  pollIntervalMs:z.number().int().min(1000).max(60000), orderNotionalUsd:positive.max(1000000),
  hedgeMode:z.enum(['base','notional']), holdMode:z.enum(['once','continuous','adaptive']),
  adaptiveMinNetUsd:nonnegative.max(10000).default(.05),adaptiveConfirmations:z.number().int().min(1).max(20).default(3),
  adaptiveSettlementGraceSec:nonnegative.max(300).default(60),
  minEntryIocEdgeBps:nonnegative.max(10000).default(0),
  // Keep absent fields absent in old saved configs so a scoped maintenance handover preserves its exact policy.
  // Execution and the form use 8 as their compatible runtime default.
  maxEntryBatches:z.number().int().min(1).max(32).optional(),
  entryIocBufferBps:nonnegative.max(50).optional(),
  entryExecutionMode:z.enum(['ioc','maker-ioc']).optional(),
  asyncFundingEntryTiming:z.enum(['last-payment','anytime']).optional(),
  exitWeakFundingBps:nonnegative.max(10000).default(2),
  minExitProfitUsd:nonnegative.max(10000).default(.10),
  minExitProfitBps:nonnegative.max(10000).optional(),
  profitExitExecutionMode:z.enum(['maker','ioc']).optional(),
  dualAdvantageEnabled:z.boolean().default(true),
  spreadLookbackMinutes:positive.min(5).max(1440).default(responsiveSpreadWarmup.spreadLookbackMinutes),
  spreadMinSamples:z.number().int().min(3).max(240).default(responsiveSpreadWarmup.spreadMinSamples),
  spreadMinSpanSec:positive.min(30).max(86400).default(responsiveSpreadWarmup.spreadMinSpanSec),
  spreadSampleIntervalSec:positive.min(1).max(300).default(responsiveSpreadWarmup.spreadSampleIntervalSec),
  spreadWarmupProfile:z.enum(['responsive-v1','custom']).default(SPREAD_WARMUP_PROFILE_VERSION),
  minSpreadAdvantageBps:nonnegative.max(1000).default(2),
  minSpreadNetUsd:nonnegative.max(10000).default(0),
  minCombinedNetUsd:nonnegative.max(10000).default(.05),minEntryLeadSec:positive.min(3).max(600).default(30),
  minNetProfitUsd:nonnegative, minNetRateBps:nonnegative, maxBasisBps:positive.max(1000), maxSlippageBps:positive.max(200),
  minOpenInterestUsd:nonnegative, minVolume24hUsd:nonnegative, maxSettlementSkewSec:nonnegative.max(3600),
  entryWindowSec:positive.max(86400), exitDelaySec:nonnegative.max(600), maxSnapshotAgeMs:positive.max(120000),
  maxPositionPerCoinUsd:positive, maxTotalPositionUsd:positive, leverage:positive.min(1).max(20),maxLeverage:positive.min(1).max(20),maxDeltaUsd:nonnegative,
  marginMode:z.enum(['crossed','isolated']).optional(),
  bitgetNewSymbolMarginMode:z.enum(['crossed','isolated']).default('isolated'),
  minLiquidationDistancePct:positive.max(80),maxHoldHours:positive.max(168),fundingSafetyFactor:positive.max(1),
  transferCostUsd:nonnegative,rebalanceCostUsd:nonnegative,exitSlippageBps:nonnegative.max(200),basisStressBps:nonnegative.max(1000),
  takerFees:z.object({binance:nonnegative.max(.01),bybit:nonnegative.max(.01),okx:nonnegative.max(.01),gate:nonnegative.max(.01),bitget:nonnegative.max(.01)}),
  // Absent legacy fields stay absent: automatic rebate policy is explicit and does not change old handover hashes.
  feeRebatePct:z.object({binance:nonnegative.max(100).optional(),bybit:nonnegative.max(100).optional(),okx:nonnegative.max(100).optional(),
    gate:nonnegative.max(100).optional(),bitget:nonnegative.max(100).optional()}).strict().optional(),
  initialBalanceUsd:positive,demoSettlementSec:z.number().int().min(30).max(3600),maxOrderRetries:z.number().int().min(0).max(3),maxApiErrors:z.number().int().min(1).max(10),autoEnabled:z.boolean(),
  maxQuoteSkewMs:z.number().int().min(200).max(60000).default(3000)
}).strict().superRefine((v,ctx)=>{
  if(v.entryExecutionMode==='maker-ioc'&&v.entryPolicy!=='aligned')ctx.addIssue({code:'custom',path:['entryExecutionMode'],message:'Maker 首腿试运行仅支持资金费与价格同向的分批入场算法'});
  if(v.spreadMinSpanSec>=v.spreadLookbackMinutes*60)ctx.addIssue({code:'custom',path:['spreadMinSpanSec'],message:'价差最短观察时长须小于回看区间'});
  if(v.mode==='live' && v.dataSource!=='public')ctx.addIssue({code:'custom',path:['mode'],message:'实盘必须使用公开实时行情'});
});
export const defaultConfig:AppConfig = {
  mode:'paper',dataSource:'public',fundingStatsSource:'auto',paperFeeOnly:false,feeOnly:true,exchanges:['binance','bybit','okx','gate','bitget'],symbols:['BTC','ETH','SOL','DOGE','XRP','AVAX'],
  pollIntervalMs:5000,orderNotionalUsd:1000,hedgeMode:'base',holdMode:'once',
  adaptiveMinNetUsd:.05,adaptiveConfirmations:3,adaptiveSettlementGraceSec:60,
  minEntryIocEdgeBps:0,exitWeakFundingBps:2,minExitProfitUsd:.10,minExitProfitBps:10,
  dualAdvantageEnabled:true,...responsiveSpreadWarmup,spreadWarmupProfile:SPREAD_WARMUP_PROFILE_VERSION,
  minSpreadAdvantageBps:2,minSpreadNetUsd:0,minCombinedNetUsd:.05,minEntryLeadSec:30,
  minNetProfitUsd:.5,minNetRateBps:3,maxBasisBps:25,maxSlippageBps:8,minOpenInterestUsd:1000000,minVolume24hUsd:5000000,
  maxSettlementSkewSec:60,entryWindowSec:900,exitDelaySec:10,maxSnapshotAgeMs:30000,
  maxPositionPerCoinUsd:4000,maxTotalPositionUsd:12000,leverage:2,maxLeverage:3,maxDeltaUsd:5,
  marginMode:'crossed',
  bitgetNewSymbolMarginMode:'isolated',
  minLiquidationDistancePct:15,maxHoldHours:24,fundingSafetyFactor:.8,
  transferCostUsd:.2,rebalanceCostUsd:.1,exitSlippageBps:2,basisStressBps:3,
  takerFees:{binance:.0005,bybit:.00055,okx:.0005,gate:.0005,bitget:.0006},
  initialBalanceUsd:10000,demoSettlementSec:120,maxOrderRetries:1,maxApiErrors:3,autoEnabled:false,
  maxQuoteSkewMs:3000
};
/** Old risk fields are accepted for file compatibility, then ignored even when malformed.
 * The lightweight execution policy has one economic rule and no hidden legacy thresholds. */
export function validateConfig(input:unknown):AppConfig {
  if(input&&typeof input==='object'&&!Array.isArray(input)){
    const normalized={...input} as Record<string,unknown>;
    for(const key of retiredConfigFields)normalized[key]=defaultConfig[key];
    input=normalized;
  }
  const config={...configSchema.parse(input),feeOnly:true,paperFeeOnly:false,dualAdvantageEnabled:true,hedgeMode:'base' as const};
  return {...config,spreadWarmupProfile:spreadWarmupProfile(config)};
}
