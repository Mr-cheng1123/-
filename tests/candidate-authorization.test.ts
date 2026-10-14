import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateAuthorizationKey, connectedCandidateResponse, synchronizeCandidateAuthorization, synchronizeCandidateEntryState } from '../web/src/candidate-authorization.js';
import type { AppState, Opportunity } from '../src/shared/types.js';
import type { FundingCandidateView, FundingOpportunitiesResponse } from '../src/shared/funding-opportunities.js';

const reason = '实盘执行锁定或该交易所账户未就绪';
const state = (authorized: boolean | null = true): AppState => ({
  config: { mode: 'live', exchanges: ['gate', 'bitget'] }, liveUnlocked: true,
  liveReadiness: { unlocked: true, ready: true, reasons: [], exchanges: (['gate', 'bitget'] as const).map(exchange => ({
    exchange, supported: true, credentialsConfigured: true, ...(authorized === null ? {} : { executionAuthorized: authorized }),
  })) },
} as unknown as AppState);
const row = (eligible = false): FundingCandidateView => ({
  id: 'AGPU-gate-bitget', longExchange: 'gate', shortExchange: 'bitget', verification: eligible ? 'verified' : 'blocked',
  execution: {
    eligible, reasons: eligible ? [] : [reason],
    checks: [{ group: 'account', label: '两腿交易账户已授权', pass: eligible, reason },
      { group: 'funding', label: '预计资金费为正', pass: true, reason: '预计资金费不为正' },
      { group: 'account', label: '两腿保证金可用', pass: null, reason: '下单前读取并确认两腿可用保证金' }],
  } as Opportunity,
} as FundingCandidateView);

test('explicit latest authorization removes only its stale blocker without promoting server eligibility', () => {
  const original = row(), before = structuredClone(original), result = synchronizeCandidateAuthorization(original, state());
  assert.equal(result.execution?.checks?.[0].pass, true);
  assert.equal(result.execution?.checks?.[0].actual, 'Gate 已授权 / Bitget 已授权');
  assert.deepEqual(result.execution?.reasons, []);
  assert.equal(result.execution?.eligible, false);
  assert.equal(result.verification, 'blocked');
  assert.equal(result.execution?.checks?.[2].pass, null);
  assert.deepEqual(original, before);
});

test('credentials and global unlock without explicit per-venue permission do not manufacture authorization', () => {
  const original = row();
  assert.equal(synchronizeCandidateAuthorization(original, state(null)), original);
  assert.equal(synchronizeCandidateAuthorization(original, { ...state(), config: { mode: 'paper' } } as AppState), original);
});

test('an unconfigured account stays visible and reports the specific venue without promoting execution', () => {
  const current=state(); current.liveReadiness!.exchanges[0].credentialsConfigured=false;
  current.liveReadiness!.exchanges[0].executionAuthorized=false;
  const original=row(true), result=synchronizeCandidateEntryState(original,current);
  assert.equal(result.id,original.id); assert.equal(result.execution!.eligible,false);
  assert.equal(result.execution!.checks![0].actual,'Gate 未配置 / Bitget 已授权');
  assert.deepEqual(result.execution!.reasons,['Gate 交易凭据未配置']);
});

test('revoking one venue or the global permission disables a previously executable candidate immediately', () => {
  for (const current of [state(false), { ...state(), liveUnlocked: false }, { ...state(), liveReadiness: { ...state().liveReadiness!, unlocked: false } }]) {
    const result = synchronizeCandidateAuthorization(row(true), current);
    assert.equal(result.execution?.eligible, false); assert.equal(result.verification, 'blocked');
    assert.equal(result.execution?.checks?.[0].pass, false);
    assert.deepEqual(result.execution?.reasons, [reason]);
  }
});

test('a stale permission error cannot remove a funding or execution blocker', () => {
  const original = row(); original.execution!.reasons.push('预计资金费不为正', '该币种已有仓位');
  original.execution!.checks![1].pass = false;
  const result = synchronizeCandidateAuthorization(original, state());
  assert.deepEqual(result.execution?.reasons, ['预计资金费不为正', '该币种已有仓位']);
  assert.equal(result.execution?.checks?.[1].pass, false); assert.equal(result.execution?.eligible, false);
});

test('permission keys track explicit authorization transitions and ignore exchange array reordering', () => {
  const before = state();
  const reordered = structuredClone(before); reordered.liveReadiness!.exchanges.reverse();
  assert.equal(candidateAuthorizationKey(before), candidateAuthorizationKey(reordered));
  for (const changed of [state(false), state(null), { ...before, liveUnlocked: false }, { ...before, liveReadiness: { ...before.liveReadiness!, ready: false } }]) {
    assert.notEqual(candidateAuthorizationKey(before), candidateAuthorizationKey(changed));
  }
});

const connectedState = (): AppState => ({
  config: { mode: 'live', exchanges: ['binance', 'bybit', 'okx', 'gate', 'bitget'] },
  autoEnabled: false, liveUnlocked: false,
  liveReadiness: { unlocked: false, ready: false, exchanges: ['binance', 'bybit', 'okx', 'gate', 'bitget'].map(exchange => ({
    exchange, supported: true, credentialsConfigured: exchange !== 'okx', executionAuthorized: false,
  })) },
  livePortfolio: { exchanges: ['binance', 'bybit', 'okx', 'gate', 'bitget'].map(exchange => ({
    exchange, credentialsConfigured: exchange !== 'okx', status: exchange === 'okx' ? 'not_configured' : 'ready',
    lastSuccessAt: exchange === 'okx' ? 0 : 1000, receivedAt: 1000, freeUsd: 0, positions: [],
  })) },
} as unknown as AppState);

const connectedReply = (): FundingOpportunitiesResponse => ({
  source: 'exchanges', status: 'ready', coinCount: 3, pairCount: 4,
  rows: [
    { id: 'ARK-binance-gate', base: 'ARK', longExchange: 'binance', shortExchange: 'gate' },
    { id: 'ARK-bybit-bitget', base: 'ARK', longExchange: 'bybit', shortExchange: 'bitget' },
    { id: 'ONE-gate-okx', base: 'ONE', longExchange: 'gate', shortExchange: 'okx' },
    { id: 'NKE-binance-okx', base: 'NKE', longExchange: 'binance', shortExchange: 'okx' },
  ],
  coverage: { statisticsCoinCount: 3, pairedCoinCount: 3, unpairedCoinCount: 0, detailedPairCount: 0, unpaired: [] },
} as unknown as FundingOpportunitiesResponse);

test('cached candidate counts and membership immediately exclude an unconnected venue even while auto and authorization are off', () => {
  const current = connectedState(), original = connectedReply(), before = structuredClone(original);
  const projected = connectedCandidateResponse(original, current);
  assert.deepEqual(projected.rows.map(item => item.id), ['ARK-binance-gate', 'ARK-bybit-bitget']);
  assert.equal(projected.coinCount, 1); assert.equal(projected.pairCount, 2);
  assert.equal(projected.coverage, undefined, 'Coverage from an obsolete wider reply must not retain wider counts.');
  assert.deepEqual(original, before);
});

test('public connectivity or credentials without a successful account read does not admit an exchange', () => {
  const current = connectedState();
  current.liveReadiness!.exchanges.find(item => item.exchange === 'okx')!.credentialsConfigured = true;
  const okx = current.livePortfolio!.exchanges.find(item => item.exchange === 'okx')!;
  okx.credentialsConfigured = true; okx.status = 'error'; okx.lastSuccessAt = 0;
  current.exchanges = [{ exchange: 'okx', status: 'online', latencyMs: 1, lastSuccess: 1000 }];
  assert.equal(connectedCandidateResponse(connectedReply(), current).pairCount, 2);
  okx.status = 'ready'; okx.lastSuccessAt = 2000;
  assert.equal(connectedCandidateResponse(connectedReply(), current).pairCount, 4);
});

test('scope keys refresh once for a connection transition and ignore subsequent receipt timestamps and ordinary retries', () => {
  const current = connectedState(), initial = candidateAuthorizationKey(current);
  const gate = current.livePortfolio!.exchanges.find(item => item.exchange === 'gate')!;
  gate.receivedAt = 3000; gate.lastSuccessAt = 3000; gate.status = 'error';
  assert.equal(candidateAuthorizationKey(current), initial);
  assert.equal(connectedCandidateResponse(connectedReply(), current).pairCount, 2);
  gate.status = 'stale';
  assert.equal(candidateAuthorizationKey(current), initial);
  gate.credentialsConfigured = false;
  assert.notEqual(candidateAuthorizationKey(current), initial);
  assert.deepEqual(connectedCandidateResponse(connectedReply(), current).rows.map(item => item.id), ['ARK-bybit-bitget']);
});

test('paper candidate visibility retains all enabled exchanges without real account connections', () => {
  const current = connectedState(); current.config.mode = 'paper';
  current.livePortfolio = undefined; current.liveReadiness = undefined;
  const projected = connectedCandidateResponse(connectedReply(), current);
  assert.equal(projected.coinCount, 3); assert.equal(projected.pairCount, 4);
  assert.equal(projected.coverage!.statisticsCoinCount, 3);
});

test('only a reply from the current connected scope supplies coverage, including when adding a venue does not add rows yet', () => {
  const current = connectedState(), data = connectedReply();
  data.rows = data.rows.slice(0, 2);
  data.connectedExchanges = ['bitget', 'bybit', 'gate', 'binance'];
  assert.equal(connectedCandidateResponse(data, current).coverage, data.coverage);
  current.liveReadiness!.exchanges.find(item => item.exchange === 'okx')!.credentialsConfigured = true;
  const okx = current.livePortfolio!.exchanges.find(item => item.exchange === 'okx')!;
  okx.credentialsConfigured = true; okx.status = 'ready'; okx.lastSuccessAt = 3000;
  const projected = connectedCandidateResponse(data, current);
  assert.equal(projected.rows.length, 2);
  assert.equal(projected.coverage, undefined, 'Old coverage cannot describe a newly expanded venue scope.');
});

test('legacy warming history is presented as waiting, while order eligibility remains false', () => {
  const original = row();
  original.execution!.spreadAdvantage = { status: 'warming' } as Opportunity['spreadAdvantage'];
  original.execution!.checks!.push({ group: 'spread', label: '价差历史样本充足', pass: false, reason: '价差历史样本不足' });
  original.execution!.reasons.push('价差历史样本不足');
  const result = synchronizeCandidateEntryState(original, state());
  assert.equal(result.execution?.checks?.at(-1)?.pass, null);
  assert.equal(result.execution?.checks?.[0].pass, true);
  assert.deepEqual(result.execution?.reasons, []); assert.equal(result.verification, 'pending');
  assert.equal(result.execution?.eligible, false); assert.equal(original.execution?.checks?.at(-1)?.pass, false);
});

test('warming never clears a confirmed bad spread or any other execution failure', () => {
  const original = row();
  original.execution!.spreadAdvantage = { status: 'warming' } as Opportunity['spreadAdvantage'];
  original.execution!.checks!.push(
    { group: 'spread', label: '价差历史样本充足', pass: false, reason: '价差历史样本不足' },
    { group: 'spread', label: '开仓价差优于历史退出价差', pass: false, reason: '价差没有优势' },
  );
  original.execution!.reasons.push('价差历史样本不足', '价差没有优势');
  const result = synchronizeCandidateEntryState(original, state());
  assert.deepEqual(result.execution?.reasons, ['价差没有优势']);
  assert.equal(result.execution?.checks?.at(-1)?.pass, false); assert.equal(result.verification, 'blocked');
  assert.equal(result.execution?.eligible, false);
});

test('an explicit prepared server pair displays manual readiness without enabling automatic trading',()=>{
  const original=row();original.execution!.entryReady=true;
  const current=state(false);current.liveUnlocked=false;current.liveReadiness!.unlocked=false;
  const result=synchronizeCandidateAuthorization(original,current);
  assert.equal(result.execution!.entryReady,true);assert.equal(result.execution!.eligible,false);
  assert.equal(result.execution!.checks![0].pass,null);assert.match(result.execution!.checks![0].actual!,/可手动开仓；提交前核对并授权所选两腿/);
  assert.match(result.execution!.checks![0].actual!,/自动策略保持当前状态/);
  assert.deepEqual(result.execution!.reasons,[]);assert.equal(result.verification,'verified');
  assert.equal(original.execution!.checks![0].pass,false);
});

test('a prepared pair missing one session venue stays manually ready after another pair unlocked the session',()=>{
  const original=row();original.execution!.entryReady=true;
  const current=state();current.liveReadiness!.exchanges[0].executionAuthorized=false;
  const before=structuredClone(current),result=synchronizeCandidateAuthorization(original,current);
  assert.equal(result.execution!.entryReady,true);assert.equal(result.execution!.eligible,false);
  assert.equal(result.execution!.checks![0].pass,null);assert.deepEqual(result.execution!.reasons,[]);
  assert.equal(result.verification,'verified');assert.match(result.execution!.checks![0].actual!,/提交前核对并授权/);
  assert.deepEqual(current,before,'A UI correction must not grant or widen real execution permission.');
  assert.equal(original.execution!.checks![0].pass,false);
});

test('a mixed session cannot infer prepared manual readiness or hide a real account or contract failure',()=>{
  const current=state();current.liveReadiness!.exchanges[0].executionAuthorized=false;
  assert.equal(synchronizeCandidateAuthorization(row(),current).verification,'blocked');
  for(const change of [
    (candidate:FundingCandidateView,account:AppState)=>{account.liveReadiness!.exchanges[0].credentialsConfigured=false;},
    (candidate:FundingCandidateView,account:AppState)=>{account.liveReadiness!.exchanges[0].supported=false;},
    (candidate:FundingCandidateView)=>{candidate.execution!.checks!.push({group:'account',label:'两腿账户读取就绪',pass:false,reason:'Gate 账户读取失败'});candidate.execution!.reasons.push('Gate 账户读取失败');},
    (candidate:FundingCandidateView)=>{candidate.execution!.checks!.push({group:'execution',label:'两腿合约只读检查就绪',pass:false,reason:'Gate 合约不支持'});candidate.execution!.reasons.push('Gate 合约不支持');},
  ]){
    const candidate=row();candidate.execution!.entryReady=true;const account=structuredClone(current);change(candidate,account);
    const result=synchronizeCandidateAuthorization(candidate,account);
    assert.equal(result.execution!.eligible,false);assert.equal(result.verification,'blocked');
  }
});

test('prestart display cannot infer readiness from a permission blocker alone or clear another failure',()=>{
  const current=state(false);current.liveUnlocked=false;current.liveReadiness!.unlocked=false;
  assert.equal(synchronizeCandidateAuthorization(row(),current).execution!.entryReady,undefined);
  const original=row();original.execution!.entryReady=true;original.execution!.checks![1].pass=false;original.execution!.reasons.push('预计资金费不为正');
  const result=synchronizeCandidateAuthorization(original,current);
  assert.equal(result.execution!.checks![1].pass,false);assert.deepEqual(result.execution!.reasons,['预计资金费不为正']);assert.equal(result.verification,'blocked');
  current.liveReadiness!.exchanges[0].credentialsConfigured=false;
  assert.equal(synchronizeCandidateAuthorization(original,current).execution!.entryReady,false);
});
