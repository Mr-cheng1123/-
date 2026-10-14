import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfig} from '../src/shared/config.js';
import type {AppConfig,MarketSnapshot,SpreadHistoryProvider} from '../src/shared/types.js';
import {assessFundingCarry,sweepBook} from '../src/core/funding-carry.js';
import {calculateOpportunities} from '../src/core/strategy.js';
import {evaluateTradeEconomics} from '../src/core/trade-economics.js';

// Offline execution books with different venue prices, nonzero bid/ask spreads and actual base-coin quantities.
// No credentials, HTTP clients, orders or fake historical convergence are used.
const now=1_790_921_600_000;
const config:AppConfig={...defaultConfig,entryPolicy:'funding',orderNotionalUsd:100,minCombinedNetUsd:.04,
  takerFees:{...defaultConfig.takerFees,gate:.0005,bitget:.0006}};
function quote(changes:Partial<MarketSnapshot>={}):MarketSnapshot{return {exchange:'gate',base:'BTC',symbol:'BTC/USDT:USDT',
  timestamp:now,observedAt:now,indexPrice:100,markPrice:99.9,fundingRate:0,nextFundingTime:now+60_000,intervalHours:8,
  fundingHistory:[],bids:[{price:99.8,quantity:5}],asks:[{price:99.9,quantity:5}],openInterestUsd:0,volume24hUsd:0,
  quantityStep:.001,minQuantity:.001,minNotional:5,contractSize:1,source:'public',...changes};}
const pair=()=>[quote(),quote({exchange:'bitget',markPrice:101,fundingRate:.006,bids:[{price:100.9,quantity:5}],asks:[{price:101,quantity:5}]})];
const closeTo=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);

test('funding mode enters without history when one funding receipt covers four book trades and all four fees',()=>{
  const [o]=calculateOpportunities(pair(),config,now);
  assert.equal(o.entryPolicy,'funding');assert.equal(o.eligible,true,o.reasons.join('；'));
  assert.equal(o.longExchange,'gate');assert.equal(o.shortExchange,'bitget');
  assert.equal(o.longQuantity,1);assert.equal(o.shortQuantity,1);
  assert.equal(o.spreadAdvantage!.estimateMethod,'current-book');assert.equal(o.spreadAdvantage!.status,'ready');
  closeTo(o.expectedFundingUsd,.606);closeTo(o.spreadAdvantage!.expectedSpreadPnlUsd!,-.2);
  closeTo(o.feesUsd,.22099);closeTo(o.combinedExpectedNetUsd!,.18501);
  closeTo(o.entryLimitNetUsd!,.18501);
  assert.equal(o.checks!.some(check=>/历史样本|优于历史/.test(check.label)),false);
  assert.ok(o.checks!.every(check=>check.pass===true));
});

test('ordinary cross-venue basis cancels instead of being counted as a convergence profit or a guaranteed loss',()=>{
  const snapshots=[quote({markPrice:100,bids:[{price:99.9,quantity:5}],asks:[{price:100,quantity:5}]}),
    quote({exchange:'bitget',markPrice:200,fundingRate:.003,bids:[{price:199.9,quantity:5}],asks:[{price:200,quantity:5}]})];
  const [o]=calculateOpportunities(snapshots,config,now);
  closeTo(o.spreadAdvantage!.expectedSpreadPnlUsd!,-.2);
  closeTo(o.expectedFundingUsd,.6);closeTo(o.feesUsd,.33989);closeTo(o.combinedExpectedNetUsd!,.06011);
  assert.equal(o.eligible,true);assert.ok(o.basisBps>9_000);
});

test('funding mode consumes depth on all four sides and charges fees at their own actual notionals once',()=>{
  const long=quote({asks:[{price:100.2,quantity:2},{price:100,quantity:.4}],bids:[{price:99.7,quantity:2},{price:99.9,quantity:.2}]}),
    short=quote({exchange:'bitget',markPrice:101,fundingRate:.01,bids:[{price:100.8,quantity:2},{price:101,quantity:.25}],
      asks:[{price:101.3,quantity:2},{price:101.1,quantity:.5}]});
  const snapshotBefore=JSON.stringify([long,short]);
  const estimate=assessFundingCarry(long,short,1,config,now);
  closeTo(estimate.openLong.value,100.12);closeTo(estimate.openShort.value,100.85);
  closeTo(estimate.closeLong.value,99.74);closeTo(estimate.closeShort.value,101.2);
  closeTo(estimate.spread.expectedSpreadPnlUsd!,-.73);
  closeTo(estimate.feesUsd,(100.12+99.74)*.0005+(100.85+101.2)*.0006);
  assert.equal(JSON.stringify([long,short]),snapshotBefore,'sorting does not mutate shared market snapshots');
  const [o]=calculateOpportunities([long,short],config,now);
  closeTo(o.combinedExpectedNetUsd!,1.01-.73-estimate.feesUsd);
  closeTo(o.entryLimitNetUsd!,1.01+(100.8-100.2+99.74-101.2)-estimate.limitFeesUsd);
  assert.ok(o.combinedExpectedNetUsd!>config.minCombinedNetUsd,'average-priced forecast remains positive');
  assert.ok(o.entryLimitNetUsd!<0,'permitted IOC limits can still lose');assert.equal(o.eligible,false);
  assert.equal(o.checks!.find(check=>check.label==='实际 IOC 限价净收益达标')!.pass,false);
  assert.ok(o.reasons.includes('实际 IOC 限价对应的扣费净收益不足'));
  assert.ok(o.entryLimitSpreadAfterFeesUsd!<o.spreadAfterFeesUsd!,'IOC worst limits retain consumed-depth cost');
});

test('positive funding that fails to cover book friction and four fees is still rejected',()=>{
  const snapshots=pair();snapshots[1].fundingRate=.003;
  const [o]=calculateOpportunities(snapshots,config,now);
  closeTo(o.combinedExpectedNetUsd!,-.11799);
  assert.equal(o.eligible,false);assert.ok(o.reasons.includes('资金费与价差合计净收益不足'));
});

test('missing or partial closing books never become zero assumed close costs or a profitable opportunity',()=>{
  for(const change of [{bids:[]},{bids:[{price:99.8,quantity:.4}]},{asks:[]}]){
    const snapshots=pair();Object.assign(change.asks?snapshots[1]:snapshots[0],change);
    const [o]=calculateOpportunities(snapshots,config,now);
    assert.equal(o.eligible,false);assert.equal(o.spreadAdvantage!.status,'warming');
    assert.equal(o.spreadAdvantage!.expectedSpreadPnlUsd,null);assert.equal(o.combinedExpectedNetUsd,null);
    assert.equal(o.entryLimitNetUsd,null);
    assert.ok(Number.isNaN(o.feesUsd));assert.ok(Number.isNaN(o.expectedNetUsd));
  }
});

test('invalid prices, fee schedules, crossed books and incompatible sources cannot manufacture funding profit',()=>{
  for(const change of [{bids:[{price:NaN,quantity:5}]},{asks:[{price:Infinity,quantity:5}]},
    {bids:[{price:101,quantity:5}]},{source:'demo' as const}]){
    const snapshots=pair();Object.assign(snapshots[0],change);
    const [o]=calculateOpportunities(snapshots,config,now);
    assert.equal(o.eligible,false);assert.equal(o.combinedExpectedNetUsd,null);
    assert.equal(o.entryLimitNetUsd,null);
  }
  for(const fee of [NaN,Infinity,-.001,undefined]){
    const bad={...config,takerFees:{...config.takerFees,bitget:fee}} as AppConfig;
    const [o]=calculateOpportunities(pair(),bad,now);
    assert.equal(o.eligible,false);assert.equal(o.combinedExpectedNetUsd,null);
    assert.equal(o.checks!.find(check=>check.label==='两腿手续费已知')!.pass,false);
  }
});

test('stale, unsynchronized or imminent settlement quotes retain the executable-data checks in funding mode',()=>{
  for(const change of [{observedAt:now-config.maxSnapshotAgeMs-1,timestamp:now-config.maxSnapshotAgeMs-1},
    {observedAt:now-config.maxQuoteSkewMs-1},{nextFundingTime:now+3_000},{nextFundingTime:NaN}]){
    const snapshots=pair();Object.assign(snapshots[0],change);
    assert.equal(calculateOpportunities(snapshots,config,now)[0].eligible,false,JSON.stringify(change));
  }
});

test('funding and fees follow the rounded common base quantity rather than the nominal 100U setting',()=>{
  const snapshots=pair();snapshots[0].quantityStep=.3;snapshots[1].quantityStep=.2;
  const [o]=calculateOpportunities(snapshots,config,now);
  closeTo(o.longQuantity,.6);closeTo(o.shortQuantity,.6);
  closeTo(o.expectedFundingUsd,.3636);closeTo(o.feesUsd,.132594);closeTo(o.combinedExpectedNetUsd!,.111006);
  assert.equal(o.eligible,true);
  snapshots[0].minNotional=70;
  const [tooSmall]=calculateOpportunities(snapshots,config,now);
  assert.equal(tooSmall.eligible,false);assert.ok(tooSmall.reasons.includes('低于交易所最小下单量'));
});

test('optional funding mode ignores the historical convergence forecast while explicit or missing dual mode retains it',()=>{
  const negativeHistory:SpreadHistoryProvider={assess:()=>({status:'ready',samples:6,requiredSamples:6,observedSpanSec:60,requiredSpanSec:60,
    longEntryPrice:99.9,shortEntryPrice:100.9,entrySpreadBps:100,expectedExitSpreadBps:120,spreadAdvantageBps:-20,expectedSpreadPnlUsd:-.2})};
  const [funding]=calculateOpportunities(pair(),config,now,negativeHistory);
  assert.equal(funding.eligible,true);assert.equal(funding.spreadAdvantage!.estimateMethod,'current-book');
  for(const entryPolicy of ['dual',undefined] as const){
    const [dual]=calculateOpportunities(pair(),{...config,entryPolicy},now,negativeHistory);
    assert.equal(dual.entryPolicy,'dual');assert.equal(dual.eligible,false);
    assert.ok(dual.reasons.includes('价差没有优势：开仓价差不优于历史退出价差'));
    assert.equal(calculateOpportunities(pair(),{...config,entryPolicy},now)[0].combinedExpectedNetUsd,null);
  }
});

test('spread-positive restriction remains opt-in per economics call, with legacy dual as the default',()=>{
  const cost={fundingUsd:.6,spreadUsd:-.2,feesUsd:.22,minCombinedNetUsd:.04};
  assert.equal(evaluateTradeEconomics(cost).eligible,false);
  assert.equal(evaluateTradeEconomics({...cost,requireSpreadPositive:false}).eligible,true);
  assert.equal(evaluateTradeEconomics({...cost,requireSpreadPositive:false,fundingUsd:0}).eligible,false);
  assert.equal(evaluateTradeEconomics({...cost,requireSpreadPositive:false,feesUsd:NaN}).eligible,false);
  assert.equal(evaluateTradeEconomics({...cost,requireSpreadPositive:false,feesUsd:-.01}).eligible,false);
});

test('closing estimates for a partial hedge use its actual remaining size and independently consumed closing depth',()=>{
  const long=quote({bids:[{price:99.8,quantity:.5},{price:99.6,quantity:2}]}),short=pair()[1];
  const smaller=assessFundingCarry(long,short,.5,config,now),full=assessFundingCarry(long,short,1,config,now);
  closeTo(smaller.closeLong.value,49.9);closeTo(full.closeLong.value,99.7);
  assert.notEqual(smaller.closeLong.value,full.closeLong.value*.5);
  closeTo(sweepBook(short,'asks',.5).value,50.5);
});

test('positive book cost separates each venue spread and depth from cross-venue basis and fees',()=>{
  const long=quote({asks:[{price:100,quantity:2},{price:101,quantity:20}],
    bids:[{price:99.9,quantity:2},{price:99,quantity:20}]}),
    short=quote({exchange:'bitget',markPrice:101,fundingRate:.006,
      bids:[{price:101,quantity:2},{price:100.9,quantity:20}],
      asks:[{price:101.1,quantity:2},{price:101.2,quantity:20}]});
  const estimate=assessFundingCarry(long,short,10,config,now),cost=estimate.bookCost!;
  assert.equal(cost.quantity,10);assert.equal(cost.longObservedAt,now);assert.equal(cost.shortObservedAt,now);
  closeTo(cost.longOpenPrice,100.8);closeTo(cost.longClosePrice,99.18);
  closeTo(cost.shortOpenPrice,100.92);closeTo(cost.shortClosePrice,101.18);
  closeTo(cost.openingSpreadCostUsd,1);closeTo(cost.closingSpreadCostUsd,1);
  closeTo(cost.openingDepthImpactUsd,8.8);closeTo(cost.closingDepthImpactUsd,8);
  closeTo(cost.openingCostUsd,9.8);closeTo(cost.closingCostUsd,9);closeTo(cost.roundTripBookLossUsd,18.8);
  closeTo(cost.roundTripBookLossUsd,cost.openingCostUsd+cost.closingCostUsd);
  closeTo(cost.feesUsd!,estimate.feesUsd);
  closeTo(estimate.spread.expectedSpreadPnlUsd!,-cost.roundTripBookLossUsd);
  for(const [key,value] of Object.entries(cost))if(/CostUsd|ImpactUsd|LossUsd/.test(key))assert.ok(value>=0,key);
  // Shifting both sides of just one venue changes basis, but never adds that basis to book friction.
  const shifted={...short,bids:short.bids.map(level=>({...level,price:level.price+1_000_000})),
    asks:short.asks.map(level=>({...level,price:level.price+1_000_000}))};
  closeTo(assessFundingCarry(long,shifted,10,config,now).bookCost!.roundTripBookLossUsd,cost.roundTripBookLossUsd);
});

test('large cross-venue basis cannot cancel a small observable local book loss',()=>{
  const long=quote({bids:[{price:100,quantity:5}],asks:[{price:100.125,quantity:5}]}),
    short=quote({exchange:'bitget',markPrice:1e16,indexPrice:1e16,
      bids:[{price:1e16,quantity:5}],asks:[{price:1e16,quantity:5}]});
  const estimate=assessFundingCarry(long,short,1,{...config,takerFees:{...config.takerFees,gate:0,bitget:0}},now);
  closeTo(estimate.bookCost!.roundTripBookLossUsd,.125);
  closeTo(estimate.spread.expectedSpreadPnlUsd!,-.125);closeTo(estimate.limitBookLossUsd,.125);
  const zero=assessFundingCarry({...long,asks:long.bids},short,1,config,now);
  assert.equal(zero.bookCost!.roundTripBookLossUsd,0);
  assert.equal(zero.spread.expectedSpreadPnlUsd!+0,0,'a favorable entry basis alone is not realized profit');
});

test('first best-price batch keeps independent book diagnostics and funding-after-fees horizon without scaling target costs',()=>{
  const long=quote({markPrice:100,fundingRate:.001,nextFundingTime:now+2*3_600_000+60_000,
    asks:[{price:100,quantity:2},{price:101,quantity:20}],bids:[{price:99.9,quantity:2},{price:99,quantity:20}]}),
    short=quote({exchange:'bitget',markPrice:101,fundingRate:.006,intervalHours:1,
      bids:[{price:101,quantity:2},{price:100.9,quantity:20}],
      asks:[{price:101.1,quantity:2},{price:101.2,quantity:20}]});
  const aligned={...config,entryPolicy:'aligned' as const,orderNotionalUsd:1000};
  const [o]=calculateOpportunities([long,short],aligned,now),batch=o.entryBatch!,cost=batch.bookCost!;
  assert.equal(o.longQuantity,10);assert.equal(o.shortQuantity,10);assert.equal(batch.batchQuantity,2);
  assert.equal(o.eligible,false,'the independent asynchronous entry window can block a positive forecast');
  assert.ok(o.reasons.some(reason=>reason.includes('小周期收款首轮窗口')));
  assert.equal(cost.quantity,2);closeTo(cost.roundTripBookLossUsd,.4);
  closeTo(o.bookCost!.roundTripBookLossUsd,18.8);
  assert.notEqual(cost.roundTripBookLossUsd,o.bookCost!.roundTripBookLossUsd*batch.batchQuantity/o.longQuantity);
  const expectedFunding=2*101*.006*3-2*100*.001;
  closeTo(batch.expectedFundingUsd!,expectedFunding);
  closeTo(batch.expectedNetUsd!,expectedFunding-.4424);
  closeTo(o.combinedExpectedNetUsd!,o.expectedFundingUsd-o.feesUsd);
});

test('missing closing depth keeps fee-only forecasts available while unknown fee observations still block totals',()=>{
  const aligned={...config,entryPolicy:'aligned' as const,orderNotionalUsd:1000};
  const long=quote({asks:[{price:100,quantity:2},{price:100.1,quantity:20}],bids:[]}),
    short=quote({exchange:'bitget',markPrice:101,fundingRate:.006,
      bids:[{price:101,quantity:2},{price:100.9,quantity:20}],asks:[{price:101.1,quantity:30}]});
  const [missingClose]=calculateOpportunities([long,short],aligned,now);
  assert.equal(missingClose.bookCost,undefined);assert.equal(missingClose.entryBatch!.bookCost,undefined);
  closeTo(missingClose.entryBatch!.expectedNetUsd!,.7697);assert.ok(missingClose.entryBatch!.expectedFundingUsd!>0);
  closeTo(missingClose.combinedExpectedNetUsd!,missingClose.expectedFundingUsd-missingClose.feesUsd);
  assert.equal(missingClose.eligible,true,'unavailable closing depth remains separate from fee-only funding forecasts');
  long.bids=[{price:99.9,quantity:30}];
  const missingFee={...aligned,takerFees:{...aligned.takerFees,bitget:NaN}};
  const [unknownFee]=calculateOpportunities([long,short],missingFee,now);
  assert.ok(unknownFee.bookCost!.roundTripBookLossUsd>0);assert.equal(unknownFee.bookCost!.feesUsd,null);
  assert.ok(unknownFee.entryBatch!.bookCost!.roundTripBookLossUsd>0);
  assert.equal(unknownFee.entryBatch!.bookCost!.feesUsd,null);assert.equal(unknownFee.entryBatch!.expectedNetUsd,null);
  assert.equal(unknownFee.combinedExpectedNetUsd,null);assert.equal(unknownFee.eligible,false);
});

test('funding entry checklist reports a positive cost deduction consistently',()=>{
  const [o]=calculateOpportunities(pair(),config,now);
  const cost=o.checks!.find(check=>check.label==='当前开平仓盘口可估算往返成本')!;
  assert.equal(cost.actual,'$0.20');assert.equal(cost.pass,true);
});

test('a complete first batch retains its forecast when the full target lacks closing depth',()=>{
  const aligned={...config,entryPolicy:'aligned' as const,orderNotionalUsd:1000};
  const long=quote({asks:[{price:100,quantity:2},{price:100.1,quantity:20}],bids:[{price:99.9,quantity:2}]}),
    short=quote({exchange:'bitget',markPrice:101,fundingRate:.006,
      bids:[{price:101,quantity:2},{price:100.9,quantity:20}],asks:[{price:101.1,quantity:2}]});
  const [o]=calculateOpportunities([long,short],aligned,now);
  assert.equal(o.eligible,true);assert.equal(o.bookCost,undefined);
  closeTo(o.combinedExpectedNetUsd!,o.expectedFundingUsd-o.feesUsd);
  assert.equal(o.entryBatch!.batchQuantity,2);closeTo(o.entryBatch!.bookCost!.roundTripBookLossUsd,.4);
  assert.ok(Number.isFinite(o.entryBatch!.expectedNetUsd));
  assert.ok(o.checks!.every(check=>check.pass===true),'closing depth never becomes an aligned entry gate');
});

test('round-trip cost quantities are already base coins and never receive another contract multiplier',()=>{
  const [long,short]=pair();
  const ordinary=assessFundingCarry(long,short,1,config,now).bookCost!;
  const contractSized=assessFundingCarry({...long,contractSize:10},{...short,contractSize:100},1,config,now).bookCost!;
  assert.deepEqual(contractSized,ordinary);assert.equal(contractSized.quantity,1);
});
