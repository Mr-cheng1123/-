import type { AppConfig, Opportunity } from '../../src/shared/types';

/** Detailed opportunities keep the policy used to calculate them while a settings update is synchronizing. */
export type EntryPolicy = 'aligned' | 'funding' | 'dual';
export function entryPolicy(config: Pick<AppConfig, 'entryPolicy'>, opportunity?: Pick<Opportunity, 'entryPolicy' | 'spreadAdvantage'>): EntryPolicy {
  if (opportunity?.entryPolicy) return opportunity.entryPolicy;
  if (opportunity?.spreadAdvantage?.estimateMethod === 'current-book') return 'funding';
  if (opportunity?.spreadAdvantage?.estimateMethod === 'historical-median') return 'dual';
  return config.entryPolicy ?? 'dual';
}

export const entryPolicyLabel = (policy: EntryPolicy): string => policy === 'aligned' ? '资金费＋价格同向' : policy === 'funding' ? '资金费覆盖单轮成本（高级）' : '历史价差双优势（高级）';

/** A legacy funding payload without the IOC estimate cannot authorize an entry. */
export function fundingEntryLimitReady(config:Pick<AppConfig,'entryPolicy'|'minCombinedNetUsd'>, opportunity:Opportunity):boolean {
  return entryPolicy(config,opportunity)!=='funding'||typeof opportunity.entryLimitNetUsd==='number'&&Number.isFinite(opportunity.entryLimitNetUsd)&&opportunity.entryLimitNetUsd>config.minCombinedNetUsd;
}

export function entryExecutionReady(config:Pick<AppConfig,'entryPolicy'|'minCombinedNetUsd'|'minEntryIocEdgeBps'>,opportunity:Opportunity):boolean {
  if(entryPolicy(config,opportunity)==='aligned')return iocEdgeExceeds(opportunity.entryLimitPriceEdgeBps,config.minEntryIocEdgeBps??0);
  return fundingEntryLimitReady(config,opportunity);
}

/** Match the backend boundary tolerance so rounding noise cannot promote 20 bps. */
export function iocEdgeExceeds(value:number|null|undefined,minimum:number):boolean {
  return typeof value==='number'&&Number.isFinite(value)&&Number.isFinite(minimum)&&value>minimum+1e-9;
}

export const roundsEstimate=(rounds:number|null|undefined):string=>typeof rounds==='number'&&Number.isFinite(rounds)&&rounds>=1?`${Math.ceil(rounds)} 轮（按本轮假设）`:'暂不可估算';
