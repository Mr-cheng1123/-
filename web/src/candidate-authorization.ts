import type { AppState } from '../../src/shared/types';
import type { FundingCandidateView, FundingOpportunitiesResponse } from '../../src/shared/funding-opportunities';
import { filterOpportunityPairs, opportunityExchangeScope } from '../../src/shared/opportunity-exchange-scope';
import { entryPolicy, fundingEntryLimitReady, entryExecutionReady } from './entry-policy';

const authorizationLabel = '两腿交易账户已授权';
const authorizationReason = '实盘执行锁定或该交易所账户未就绪';
const names = { binance: 'Binance', bybit: 'Bybit', okx: 'OKX', gate: 'Gate', bitget: 'Bitget' };

/** A changed server authorization starts a new candidate request immediately. */
export function candidateAuthorizationKey(state: AppState): string {
  return JSON.stringify([
    state.config.mode, state.liveUnlocked, state.liveReadiness?.unlocked, state.liveReadiness?.ready,
    opportunityExchangeScope(state).sort(),
    [...(state.liveReadiness?.exchanges ?? [])].sort((a, b) => a.exchange.localeCompare(b.exchange))
      .map(item => [item.exchange, item.executionAuthorized ?? null, item.credentialsConfigured, item.supported]),
  ]);
}

/** Project cached replies immediately when a venue is removed. The next scoped
 * server reply supplies coverage; obsolete full-market coverage must not flash. */
export function connectedCandidateResponse(data: FundingOpportunitiesResponse, state: AppState): FundingOpportunitiesResponse {
  const scope = opportunityExchangeScope(state);
  const rows = filterOpportunityPairs(data.rows, scope)
    .map(row => synchronizeCandidateEntryState(row, state));
  const scopeMatches = state.config.mode !== 'live' || Array.isArray(data.connectedExchanges) &&
    JSON.stringify([...data.connectedExchanges].sort()) === JSON.stringify([...scope].sort());
  return { ...data, rows, coinCount: new Set(rows.map(row => row.base)).size, pairCount: rows.length,
    ...(!scopeMatches || rows.length !== data.rows.length ? { coverage: undefined } : {}) };
}

/** Update only a known account permission check. Configuration is not authorization,
 * and a corrected display must never promote a previously blocked server result. */
export function synchronizeCandidateAuthorization(row: FundingCandidateView, state: AppState): FundingCandidateView {
  const execution = row.execution;
  if (state.config.mode !== 'live' || !execution?.checks?.some(check => check.group === 'account' && check.label === authorizationLabel)) return row;
  const accounts = [row.longExchange, row.shortExchange].map(exchange => state.liveReadiness?.exchanges.find(item => item.exchange === exchange));
  const locked = !state.liveUnlocked || !state.liveReadiness?.unlocked;
  const explicit = accounts.map(account => account?.executionAuthorized);
  const authorized = locked || explicit.includes(false) ? false : explicit.every(value => value === true) ? true : undefined;
  if (authorized === undefined) return row;
  const prepared = execution.entryReady === true && accounts.every(account => account?.credentialsConfigured === true && account.supported !== false);
  // A prior manual click can unlock another pair while leaving this venue out
  // of the session. A server-prepared pair can still authorize itself on its
  // manual click; global unlock must not make that same preview look blocked.
  const authorizeBeforeSubmit = prepared && !authorized;
  const missing = accounts.flatMap((account,index)=>account?.credentialsConfigured===false?[names[index===0?row.longExchange:row.shortExchange]]:[]);
  const currentReason = !locked&&missing.length ? `${missing.join(' / ')} 交易凭据未配置` : authorizationReason;
  const checks = execution.checks.map(check => check.group === 'account' && check.label === authorizationLabel ? {
    ...check, pass: authorizeBeforeSubmit ? null : authorized, reason: currentReason,
    actual: authorizeBeforeSubmit ? '账户与盘口已就绪，可手动开仓；提交前核对并授权所选两腿，自动策略保持当前状态' : locked ? '实盘执行未授权' : accounts.map((account, index) => `${names[index === 0 ? row.longExchange : row.shortExchange]} ${account?.credentialsConfigured===false?'未配置':account?.executionAuthorized === true ? '已授权' : '未授权'}`).join(' / '),
  } : check);
  const previousReasons = execution.checks.filter(check => check.group === 'account' && check.label === authorizationLabel).map(check => check.reason);
  const reasons = execution.reasons.filter(reason => !previousReasons.includes(reason) && reason !== authorizationReason);
  if (!authorized && !authorizeBeforeSubmit) reasons.push(currentReason);
  return {
    ...row,
    verification: prepared && !reasons.length && !checks.some(check => check.pass === false || (check.pass === null && check.group !== 'account')) ? 'verified' : authorized ? row.verification : 'blocked',
    execution: { ...execution, entryReady: prepared ? execution.entryReady : execution.entryReady === true ? false : execution.entryReady, checks, reasons: [...new Set(reasons)], eligible: execution.eligible && authorized },
  };
}

/** Older servers reported observation warmup as a failure. It is missing data;
 * keep entry unavailable while presenting it as waiting for samples. */
export function synchronizeCandidateEntryState(row: FundingCandidateView, state: AppState): FundingCandidateView {
  const synchronized = synchronizeCandidateAuthorization(row, state);
  const execution = synchronized.execution;
  if(execution&&entryPolicy(state.config,execution)==='aligned'&&!entryExecutionReady(state.config,execution)){
    const label='实际 IOC 开仓价格优势达标';
    const known=typeof execution.entryLimitPriceEdgeBps==='number'&&Number.isFinite(execution.entryLimitPriceEdgeBps);
    const minimum=state.config.minEntryIocEdgeBps??0;
    const reason=known?`实际 IOC 限价价格优势未超过 ${minimum} bps`:'实际 IOC 限价价格优势待计算';
    const checks=execution.checks??[];
    const existing=checks.find(check=>check.label===label);
    const nextChecks=existing?checks.map(check=>check===existing?{...check,pass:known?false:null,reason,required:`> ${minimum} bps`}:check):[...checks,{group:'execution' as const,label,pass:known?false:null,reason,actual:known?`${execution.entryLimitPriceEdgeBps!.toFixed(2)} bps`:'待计算',required:`> ${minimum} bps`}];
    const reasons=known&&!execution.reasons.includes(reason)?[...execution.reasons,reason]:execution.reasons;
    return {...synchronized,verification:reasons.length?'blocked':'pending',execution:{...execution,entryReady:false,eligible:false,checks:nextChecks,reasons}};
  }
  if(execution&&entryPolicy(state.config,execution)==='funding'&&!fundingEntryLimitReady(state.config,execution)){
    const label='实际 IOC 限价净收益达标';
    const known=typeof execution.entryLimitNetUsd==='number'&&Number.isFinite(execution.entryLimitNetUsd);
    const reason=known?'实际 IOC 限价净收益不足':'实际 IOC 限价净收益待计算';
    const checks=execution.checks??[];
    const existing=checks.find(check=>check.label===label);
    const nextChecks=existing?checks.map(check=>check===existing?{...check,pass:known?false:null,reason}:check): [...checks,{group:'funding' as const,label,pass:known?false:null,reason,
      actual:known?`$${execution.entryLimitNetUsd!.toFixed(2)}`:'待计算',required:`> $${state.config.minCombinedNetUsd.toFixed(2)}`}];
    const reasons=known&&!execution.reasons.includes(reason)?[...execution.reasons,reason]:execution.reasons;
    return {...synchronized,verification:reasons.length?'blocked':'pending',execution:{...execution,entryReady:false,eligible:false,checks:nextChecks,reasons}};
  }
  if (execution?.spreadAdvantage?.status !== 'warming') return synchronized;
  const historyChecks = execution.checks?.filter(check => check.group === 'spread' && check.label === '价差历史样本充足') ?? [];
  if (!historyChecks.some(check => check.pass === false)) return synchronized;
  const reasons = execution.reasons.filter(reason => !historyChecks.some(check => check.reason === reason));
  return {
    ...synchronized,
    verification: reasons.length ? 'blocked' : 'pending',
    execution: {
      ...execution, entryReady: false, eligible: false, reasons,
      checks: execution.checks?.map(check => historyChecks.includes(check) ? { ...check, pass: null } : check),
    },
  };
}
