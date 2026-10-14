import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfig} from '../src/shared/config.js';
import type {AppState,Opportunity} from '../src/shared/types.js';
import type {FundingCandidateView,FundingOpportunitiesResponse} from '../src/shared/funding-opportunities.js';
import {automaticEntryAssessment} from '../src/shared/automatic-entry-policy.js';
import {AUTOMATIC_ENTRY_RULE,AUTOMATIC_ENTRY_CONDITIONS} from '../web/src/automatic-entry-presentation.js';
import {candidateCanSubmit,candidateReadyWithIoc20,sortCandidateRows,type CandidateReadinessContext} from '../web/src/candidate-readiness.js';
import {candidateProfit} from '../web/src/candidate-profit.js';

const NOW=1_800_000_000_000;
function candidate(base:string,patch:Partial<Opportunity>={}):FundingCandidateView {
  const execution={id:`${base}-gate-bitget`,base,longExchange:'gate',shortExchange:'bitget',entryPolicy:'aligned',eligible:true,reasons:[],
    checks:[{group:'funding',label:'funding',pass:true},{group:'execution',label:'IOC',pass:true}],
    expectedFundingUsd:.3,feesUsd:.21,feesSource:'exchange',combinedExpectedNetUsd:.06,
    entryPriceEdgeBps:30,entryLimitPriceEdgeBps:25,longObservedAt:NOW-100,shortObservedAt:NOW-50,
    entryBatch:{pricing:'best-opposite',targetQuantity:100,batchQuantity:10,longLimitPrice:1,shortLimitPrice:1.003},
    spreadAdvantage:{status:'ready',estimateMethod:'current-book',expectedSpreadPnlUsd:-.03},...patch} as unknown as Opportunity;
  return {id:execution.id,base,longExchange:'gate',shortExchange:'bitget',longRate:0,shortRate:.001,longIntervalHours:8,shortIntervalHours:8,
    normalized8hBps:10,aprPct:109.5,notionalUsd:100,nextFundingTime:NOW+3_600_000,exitTime:NOW+3_610_000,
    longFundingCount:1,shortFundingCount:1,grossFundingUsd:execution.expectedFundingUsd,feesUsd:.21,afterFeesUsd:.09,expectedNetUsd:.06,
    slippageBudgetUsd:0,transferCostUsd:0,fundingHaircutUsd:0,basisReserveUsd:0,candidateEligible:true,reasons:[],updatedAt:NOW-200,
    verification:'verified',execution,executionObservedAt:NOW-100} as FundingCandidateView;
}
function context(rows:FundingCandidateView[]):CandidateReadinessContext {
  const state={config:{...structuredClone(defaultConfig),mode:'live',entryPolicy:'aligned',minEntryIocEdgeBps:0},
    autoEnabled:false,killSwitch:false,positions:[],liveUnlocked:true,
    liveReadiness:{unlocked:true,ready:true,reasons:[],excludedCoins:[],exchanges:(['gate','bitget'] as const).map(exchange=>
      ({exchange,supported:true,credentialsConfigured:true,executionAuthorized:true}))}} as unknown as AppState;
  const data={source:'exchanges',status:'ready',receivedAt:NOW,maxAgeMs:120_000,computedAt:NOW,coinCount:rows.length,
    pairCount:rows.length,verificationLimit:6,rows} as FundingOpportunitiesResponse;
  return {state,data,now:NOW,synchronized:true};
}

test('manual submission stays available before and after automatic start when automatic economic conditions fail',()=>{
  const rows=[candidate('NEGATIVE_NET',{combinedExpectedNetUsd:-.1}),candidate('SMALL_EDGE',{entryPriceEdgeBps:15,entryLimitPriceEdgeBps:5})];
  const ctx=context(rows);
  for(const enabled of [false,true]) {
    ctx.state.autoEnabled=enabled;
    for(const row of rows) {
      assert.equal(automaticEntryAssessment(row.execution).passes,false,row.base);
      assert.equal(candidateCanSubmit(row,ctx),true,`${row.base} autoEnabled=${enabled}`);
    }
  }
});

test('unavailable current automatic funding data does not remove manual candidates or change their readiness',()=>{
  const row=candidate('FUNDING_CONFIRMATION',{fundingEntryStability:{passes:false,status:'unavailable',
    reason:'等待新鲜双腿资金费数据',sampleCount:0,requiredSamples:1,observedSpanMs:0,requiredSpanMs:0}});
  const ctx=context([row]),before=structuredClone(row);
  for(const enabled of [false,true]) {
    ctx.state.autoEnabled=enabled;
    assert.equal(automaticEntryAssessment(row.execution).passes,true);
    assert.equal(candidateCanSubmit(row,ctx),true);
    assert.deepEqual(sortCandidateRows([row],'grossFundingUsd','desc',ctx,true).map(value=>value.id),[row.id]);
  }
  assert.deepEqual(row,before);
});

test('manual IOC partition remains independent of automatic raw best-price and full-target net conditions',()=>{
  const autoQualified=candidate('RAW_EDGE',{entryPriceEdgeBps:30,entryLimitPriceEdgeBps:5});
  const manualIocQualified=candidate('NEGATIVE_NET',{combinedExpectedNetUsd:-.1,entryPriceEdgeBps:30,entryLimitPriceEdgeBps:25});
  const ctx=context([autoQualified,manualIocQualified]);
  assert.equal(automaticEntryAssessment(autoQualified.execution).passes,true);
  assert.equal(candidateCanSubmit(autoQualified,ctx),true);
  assert.equal(candidateReadyWithIoc20(autoQualified,ctx),false);
  assert.equal(automaticEntryAssessment(manualIocQualified.execution).passes,false);
  assert.equal(candidateCanSubmit(manualIocQualified,ctx),true);
  assert.equal(candidateReadyWithIoc20(manualIocQualified,ctx),true);
});

test('automatic qualification does not hide manual candidates or override the existing funding sort',()=>{
  const automatic=candidate('AUTOMATIC',{expectedFundingUsd:.3});
  const manual=candidate('MANUAL',{expectedFundingUsd:1,combinedExpectedNetUsd:-.1});
  const rows=[automatic,manual],ctx=context(rows);
  const before=structuredClone(rows);
  for(const enabled of [false,true]) {
    ctx.state.autoEnabled=enabled;
    const sorted=sortCandidateRows(rows,'grossFundingUsd','desc',ctx,true);
    assert.deepEqual(sorted.map(row=>row.base),['MANUAL','AUTOMATIC']);
    assert.equal(sorted.length,rows.length);
    assert.equal(sorted.filter(row=>candidateCanSubmit(row,ctx)).length,2);
  }
  assert.deepEqual(rows,before);
});

test('automatic price route and static display describe all three strict gates without changing manual readiness',()=>{
  const row=candidate('PRICE_ROUTE',{combinedExpectedNetUsd:-.1,entryPriceEdgeBps:110,entryLimitPriceEdgeBps:90}),ctx=context([row]);
  assert.equal(automaticEntryAssessment(row.execution).route,'price-100');
  assert.equal(candidateCanSubmit(row,ctx),true);
  for(const threshold of ['> 20 bps','> 100 bps','> 80 bps'])assert.ok(AUTOMATIC_ENTRY_CONDITIONS.includes(threshold));
  assert.ok(AUTOMATIC_ENTRY_CONDITIONS.includes('预计净资金费 > 0'));
  assert.ok(AUTOMATIC_ENTRY_RULE.includes('任一路径'));assert.ok(AUTOMATIC_ENTRY_RULE.includes('不要求单轮回本'));
  assert.ok(AUTOMATIC_ENTRY_RULE.includes('不计盘口损耗与未实现价差'));
  assert.ok(AUTOMATIC_ENTRY_CONDITIONS.includes('资金费 − 四笔手续费'));
});

test('positive aligned references without verified execution never become manual or automatic entries',()=>{
  const row=candidate('REFERENCE_ONLY'),ctx=context([row]);
  delete row.execution;row.feesSource='reference';row.verification='pending';
  const before=structuredClone(row),profit=candidateProfit(row,{requireNative:true,entryPolicy:'aligned'});
  assert.ok(profit.combinedNetUsd!>0);
  assert.equal(candidateCanSubmit(row,ctx),false);
  assert.equal(candidateReadyWithIoc20(row,ctx),false);
  assert.equal(automaticEntryAssessment(row.execution).passes,false);
  assert.deepEqual(row,before);
});
