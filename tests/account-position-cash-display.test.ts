import test from 'node:test';
import assert from 'node:assert/strict';
import {accountPositionCashDisplay} from '../web/src/account-position-cash-display.js';
import type {AccountPosition} from '../src/shared/types.js';

const complete={unrealizedPnlUsd:1.5,realizedPnlUsd:-.25,fundingUsd:.2,feesUsd:.1};

test('actual cash and pure realization each enter complete account net once',()=>{
  const result=accountPositionCashDisplay({...complete,cashFlowStatus:'ready',cashFlowReason:'账单已完整核对'});
  assert.equal(result.totalKind,'net');assert.ok(Math.abs(result.totalUsd!-1.35)<1e-12);
  assert.equal(result.totalLabel,undefined);assert.equal(result.fundingLabel,undefined);assert.equal(result.feesLabel,undefined);
  assert.equal(result.statusLabel,'账单已核对');assert.equal(result.totalCaption,'未实现＋已实现＋资金费−已付费');
});

test('a real zero remains a complete observed amount including fee rebates',()=>{
  const zero=accountPositionCashDisplay({unrealizedPnlUsd:0,realizedPnlUsd:0,fundingUsd:0,feesUsd:0,cashFlowStatus:'ready'});
  assert.equal(zero.totalKind,'net');assert.equal(zero.totalUsd,0);assert.equal(zero.fundingLabel,undefined);assert.equal(zero.feesLabel,undefined);
  assert.ok(Math.abs(accountPositionCashDisplay({...complete,feesUsd:-.1}).totalUsd!-1.55)<1e-12);
});

test('unknown realization permits only an explicitly named subtotal',()=>{
  const result=accountPositionCashDisplay({...complete,realizedPnlUsd:undefined,cashFlowStatus:'incomplete'});
  assert.equal(result.totalKind,'subtotal');assert.ok(Math.abs(result.totalUsd!-1.6)<1e-12);
  assert.equal(result.realizedLabel,'账单归属待核对');assert.match(result.totalCaption,/参考小计/);assert.doesNotMatch(result.totalCaption,/未实现＋已实现/);
});

test('missing funding or paid fees cannot be replaced by zero in the displayed account net',()=>{
  for(const field of ['fundingUsd','feesUsd','unrealizedPnlUsd'] as const){
    const result=accountPositionCashDisplay({...complete,[field]:undefined,cashFlowStatus:'incomplete'});
    assert.equal(result.totalKind,'pending');assert.equal(result.totalUsd,undefined);assert.equal(result.totalLabel,'账单归属待核对');
    assert.match(result.totalCaption,/非完整净值/);
  }
});

test('failed, not started, incomplete and expired bill evidence are visibly different from loading',()=>{
  const expected:Record<NonNullable<AccountPosition['cashFlowStatus']>,string>={loading:'账单读取中',ready:'账单字段待核对',
    incomplete:'账单归属待核对',error:'账单读取失败',unavailable:'账单暂不可用',stale:'账单已过期'};
  for(const [cashFlowStatus,label] of Object.entries(expected)){
    const result=accountPositionCashDisplay({unrealizedPnlUsd:1,cashFlowStatus:cashFlowStatus as AccountPosition['cashFlowStatus'],cashFlowReason:'固定安全原因'});
    assert.equal(result.totalLabel,label);assert.equal(result.fundingLabel,label);assert.equal(result.feesLabel,label);
    assert.equal(result.reason,'固定安全原因');assert.doesNotMatch(result.totalLabel!,/同步中/);
  }
});

test('an old venue without bill status preserves waiting labels and distinguishes an observed subtotal',()=>{
  const missing=accountPositionCashDisplay({unrealizedPnlUsd:1});
  assert.equal(missing.totalLabel,'账单同步中');assert.equal(missing.fundingLabel,'资金费同步中');assert.equal(missing.feesLabel,'手续费同步中');
  assert.equal(missing.totalUsd,undefined);
  const subtotal=accountPositionCashDisplay({...complete,realizedPnlUsd:undefined});
  assert.equal(subtotal.totalKind,'subtotal');assert.match(subtotal.totalCaption,/参考小计/);assert.equal(subtotal.realizedLabel,'同步中');
});

test('nonfinite cash is missing evidence and cannot generate a numerical total',()=>{
  for(const invalid of [NaN,Infinity,-Infinity]){
    const result=accountPositionCashDisplay({...complete,fundingUsd:invalid,cashFlowStatus:'error'});
    assert.equal(result.fundingLabel,'账单读取失败');assert.equal(result.totalUsd,undefined);
  }
});
