import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AppState,Opportunity} from '../src/shared/types.js';
import type {FundingCandidateView} from '../src/shared/funding-opportunities.js';
import {defaultConfig} from '../src/shared/config.js';
import {candidateExecutionIsFresh} from '../web/src/candidate-readiness.js';
import AutomaticFundingEntryStatus from '../web/src/AutomaticFundingEntryStatus.js';
import {automaticFundingStabilityPresentation,AUTOMATIC_ENTRY_RULE,AUTOMATIC_ENTRY_MODE} from '../web/src/automatic-entry-presentation.js';

function opportunity(patch:Partial<NonNullable<Opportunity['fundingEntryStability']>>={}):Opportunity {
  return {fundingEntryStability:{passes:true,status:'confirmed',reason:'当前双腿资金费数据新鲜且预计净资金费为正',
    latestFundingUsd:.3,sampleCount:1,requiredSamples:1,observedSpanMs:0,requiredSpanMs:0,...patch}} as Opportunity;
}

test('current funding confirmation displays immediately without a sample countdown or mutation from a page render',()=>{
  const value=opportunity(),before=structuredClone(value);
  const html=renderToStaticMarkup(createElement(AutomaticFundingEntryStatus,{opportunity:value,details:true}));
  assert.ok(html.includes('自动资金费优势已确认'));
  assert.ok(html.includes('当前双腿资金费收益 &gt; 0'));
  assert.ok(!html.includes('3:00'));assert.ok(!html.includes('独立双腿样本'));
  assert.ok(html.includes('仍需价格、手续费、数量与账户条件通过'));
  assert.deepEqual(value,before);
  assert.equal(automaticFundingStabilityPresentation(value).kind,'green');
});

test('legacy observing evidence is pending update and never recycles its old wait or grants confirmation',()=>{
  const value=opportunity({status:'observing',passes:true,sampleCount:3,requiredSamples:5,
    observedSpanMs:45_000,requiredSpanMs:180_000,reason:'同方向资金费优势持续确认中 0:45 / 3:00'});
  const before=structuredClone(value);
  const html=renderToStaticMarkup(createElement(AutomaticFundingEntryStatus,{opportunity:value,details:true}));
  assert.ok(html.includes('自动资金费确认待更新'));assert.ok(html.includes('连续确认等待已取消'));
  for(const stale of ['0:45','3:00','3 / 5','优势已确认','持续确认中'])assert.ok(!html.includes(stale),stale);
  assert.equal(automaticFundingStabilityPresentation(value).kind,'orange');
  assert.deepEqual(value,before);
});

test('missing or expired automatic funding evidence is never displayed as confirmed',()=>{
  const missing=automaticFundingStabilityPresentation(undefined);
  assert.equal(missing.kind,'orange');assert.ok(missing.label.includes('待更新'));
  const unavailable=automaticFundingStabilityPresentation(opportunity({status:'unavailable',reason:'双腿资金费数据已过期'}));
  assert.equal(unavailable.kind,'orange');assert.ok(unavailable.label.includes('待更新'));
  assert.equal(unavailable.reason,'双腿资金费数据已过期');
  const invalidConfirmation=automaticFundingStabilityPresentation(opportunity({status:'confirmed',passes:false}));
  assert.equal(invalidConfirmation.kind,'orange');assert.ok(!invalidConfirmation.label.includes('已确认'));
});

test('public candidate badge suppresses a cached confirmation when either execution leg is stale',()=>{
  const now=1_800_000_000_000;
  const execution={...opportunity(),
    longObservedAt:now-100,shortObservedAt:now-50};
  const row={execution,executionObservedAt:now-100} as FundingCandidateView;
  const state={config:{...defaultConfig,maxSnapshotAgeMs:10_000,maxQuoteSkewMs:2_000}} as AppState;
  const render=()=>renderToStaticMarkup(createElement(AutomaticFundingEntryStatus,{opportunity:row.execution,
    fresh:candidateExecutionIsFresh(row,state,now)}));
  assert.ok(render().includes('自动资金费优势已确认'));
  row.execution!.shortObservedAt=now-10_001;
  const before=structuredClone(row),stale=render();
  assert.ok(stale.includes('自动资金费等待新行情'));
  assert.ok(!stale.includes('优势已确认'));
  assert.deepEqual(row,before);
});

test('confirmation describes funding only and a lost advantage has a distinct state',()=>{
  const confirmed=automaticFundingStabilityPresentation(opportunity());
  assert.equal(confirmed.label,'自动资金费优势已确认');assert.equal(confirmed.kind,'green');
  assert.ok(!confirmed.label.includes('可开仓'));
  const negative=automaticFundingStabilityPresentation(opportunity({status:'nonpositive',passes:false,latestFundingUsd:0,reason:'预计净资金费已非正'}));
  assert.equal(negative.label,'自动资金费暂无优势');assert.equal(negative.kind,'neutral');
});

test('automatic rule uses current fresh positive funding and retains original strict economic thresholds',()=>{
  for(const text of ['30 秒内的新鲜双腿资金费数据','预计净资金费 > 0','与当前机会一致','不再等待连续确认',
    '> 20 bps','> 100 bps','> 80 bps','手动开仓按原条件独立'])assert.ok(AUTOMATIC_ENTRY_RULE.includes(text),text);
  for(const text of ['3 分钟','5 个独立','15 秒']) {
    assert.ok(!AUTOMATIC_ENTRY_RULE.includes(text),text);assert.ok(!AUTOMATIC_ENTRY_MODE.includes(text),text);
  }
});
