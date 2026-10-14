import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfig} from '../src/shared/config.js';
import type {AppConfig,MarketSnapshot,SpreadHistoryProvider} from '../src/shared/types.js';
import {calculateOpportunities} from '../src/core/strategy.js';

const now=1_790_921_600_000;
const config:AppConfig={...defaultConfig,entryPolicy:'aligned',orderNotionalUsd:100,minCombinedNetUsd:999,
  takerFees:{...defaultConfig.takerFees,gate:.0005,bitget:.0006}};
function quote(change:Partial<MarketSnapshot>={}):MarketSnapshot{return {exchange:'gate',base:'BTC',symbol:'BTC/USDT:USDT',
  timestamp:now,observedAt:now,markPrice:99.9,indexPrice:100,fundingRate:0,nextFundingTime:now+60_000,intervalHours:8,
  fundingHistory:[],bids:[{price:99.8,quantity:5}],asks:[{price:99.9,quantity:5}],openInterestUsd:0,volume24hUsd:0,
  quantityStep:.001,minQuantity:.001,minNotional:5,contractSize:1,source:'public',...change};}
const pair=()=>[quote(),quote({exchange:'bitget',markPrice:101,fundingRate:.0005,bids:[{price:100.9,quantity:5}],asks:[{price:101,quantity:5}]})];
const near=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);

test('aligned entry needs favorable prices and positive next cash funding, without requiring one cycle to cover all fees',()=>{
  const [o]=calculateOpportunities(pair(),config,now);
  assert.equal(o.entryPolicy,'aligned');assert.equal(o.eligible,true,o.reasons.join('；'));
  near(o.expectedFundingUsd,.0505);near(o.feesUsd,.22104);near(o.spreadAdvantage!.expectedSpreadPnlUsd!,-.2);
  near(o.combinedExpectedNetUsd!,-.17054);assert.ok(o.entryLimitNetUsd!<0);
  near(o.entryPriceEdgeBps!,100);near(o.entryLimitPriceEdgeBps!,100);
  assert.equal(o.breakEvenRounds,5,'fee recovery counts four fees only; price advantage is an independent entry requirement');
  assert.equal(o.longObservedAt,now);assert.equal(o.shortObservedAt,now);
  assert.ok(o.checks!.every(check=>check.pass===true));
  assert.equal(o.checks!.some(check=>/历史|净收益达标|往返成本/.test(check.label)),false);
});

test('aligned funding-after-fees remains calculable when future closing depth is missing',()=>{
  const snapshots=pair();snapshots[0].bids=[];snapshots[1].asks=[];
  const [o]=calculateOpportunities(snapshots,config,now);
  assert.equal(o.eligible,true,o.reasons.join('；'));assert.equal(o.spreadAdvantage!.status,'warming');
  near(o.combinedExpectedNetUsd!,-.17054);near(o.entryLimitNetUsd!,-.17054);assert.equal(o.breakEvenRounds,5);
  near(o.feesUsd,.22104);assert.equal(o.bookCost,undefined,'missing closing-depth cost remains unknown diagnostic data');
  assert.equal(o.checks!.find(check=>check.label==='两腿手续费已知')!.pass,true,'the fee schedule itself is known');
});

test('positive cash funding with an unfavorable or equal opening price cannot enter',()=>{
  for(const shortBid of [99.8,99.9]){
    const snapshots=pair();snapshots[1].bids=[{price:shortBid,quantity:5}];
    const [o]=calculateOpportunities(snapshots,config,now);
    assert.equal(o.eligible,false);assert.ok(o.reasons.includes('开仓价格没有优势：开多均价不低于开空均价'));
  }
});

test('aligned prices its best opposite first batch instead of consuming a losing deeper opening level',()=>{
  const snapshots=pair();snapshots[0].asks=[{price:99.9,quantity:.99},{price:101.1,quantity:.01}];
  const [o]=calculateOpportunities(snapshots,config,now);
  near(o.entryPriceEdgeBps!,100);near(o.entryLimitPriceEdgeBps!,100);assert.equal(o.eligible,true);
  assert.equal(o.entryBatch!.batchQuantity,.99);assert.equal(o.entryBatch!.targetQuantity,1);
  assert.equal(o.longQuantity,1);assert.equal(o.shortQuantity,1);
  assert.equal(o.entryLimitNetUsd,null,'a partial top level cannot establish full-goal IOC bounds');
  assert.equal(o.checks!.find(check=>check.label==='实际 IOC 开仓价格优势达标')!.pass,true);
});

test('aligned IOC prices must strictly exceed the configured 20 bps threshold',()=>{
  for(const [shortBid,eligible] of [[100.099,false],[100.1,false],[100.10001,true]] as const){
    const snapshots=pair();snapshots[1].bids=[{price:shortBid,quantity:5}];
    const [o]=calculateOpportunities(snapshots,{...config,minEntryIocEdgeBps:20},now);
    assert.ok(o.entryPriceEdgeBps!>0);assert.equal(o.eligible,eligible,`${shortBid}: ${o.reasons.join('；')}`);
    assert.equal(o.checks!.find(check=>check.label==='实际 IOC 开仓价格优势达标')!.required,'> 20 bps');
  }
  const snapshots=pair();snapshots[1].bids=[{price:100.1,quantity:5}];
  assert.equal(calculateOpportunities(snapshots,{...config,minEntryIocEdgeBps:10},now)[0].eligible,true);
  assert.equal(calculateOpportunities(pair(),{...config,minEntryIocEdgeBps:100},now)[0].eligible,false,'equal boundary is never enough');
});

test('ordinary aligned entry and a compatible config without a threshold accept positive 5 and 20 bps',()=>{
  assert.equal(defaultConfig.minEntryIocEdgeBps,0);
  for(const shortBid of [99.95,100.1]){
    const snapshots=pair();snapshots[1].bids=[{price:shortBid,quantity:5}];
    const [o]=calculateOpportunities(snapshots,config,now);
    assert.equal(o.eligible,true,o.reasons.join('；'));
    assert.equal(o.checks!.find(check=>check.label==='实际 IOC 开仓价格优势达标')!.required,'> 0 bps');
    const compatible={...config};delete (compatible as Partial<AppConfig>).minEntryIocEdgeBps;
    assert.equal(calculateOpportunities(snapshots,compatible,now)[0].eligible,true);
  }
});

test('aligned uses the next paired funding cycle rather than inflating its entry edge with a 24-hour forecast',()=>{
  const [o]=calculateOpportunities(pair(),{...config,holdMode:'continuous',maxHoldHours:24},now);
  assert.equal(o.exitTime,now+70_000);near(o.expectedFundingUsd,.0505);assert.equal(o.breakEvenRounds,5);
});

test('aligned positive funding after fees does not subtract diagnostic book loss or count opening basis as income',()=>{
  const snapshots=pair();snapshots[1].fundingRate=.003;snapshots[0].bids=[{price:50,quantity:5}];
  const [o]=calculateOpportunities(snapshots,config,now);
  assert.equal(o.eligible,true,o.reasons.join('；'));assert.ok(o.bookCost!.roundTripBookLossUsd>o.expectedFundingUsd);
  near(o.combinedExpectedNetUsd!,o.expectedFundingUsd-o.feesUsd);assert.ok(o.combinedExpectedNetUsd!>0);
  near(o.entryBatch!.expectedNetUsd!,o.entryBatch!.expectedFundingUsd!-o.feesUsd);
  assert.equal(o.breakEvenRounds,1);
});

test('aligned full-target fee reference remains available when only a smaller legal first batch fits opening depth',()=>{
  const snapshots=pair();snapshots[0].asks=[{price:99.9,quantity:.5}];snapshots[1].bids=[{price:100.9,quantity:.5}];
  const [o]=calculateOpportunities(snapshots,config,now);
  assert.equal(o.eligible,true,o.reasons.join('；'));assert.equal(o.entryBatch!.batchQuantity,.5);
  near(o.feesUsd,.2211);
  near(o.combinedExpectedNetUsd!,o.expectedFundingUsd-o.feesUsd);
  assert.equal(o.entryLimitNetUsd,null,'first-batch bounds do not guarantee complete-target IOC prices');
  near(o.entryBatch!.expectedNetUsd!,o.entryBatch!.expectedFundingUsd!-.11052);
});

test('aligned distinguishes funding direction from raw hourly normalization when settlement cycles differ',()=>{
  const snapshots=pair();snapshots[0].fundingRate=.001;snapshots[0].intervalHours=1;snapshots[1].fundingRate=.002;
  const [o]=calculateOpportunities(snapshots,config,now);
  assert.equal(o.longExchange,'gate');assert.equal(o.shortExchange,'bitget');assert.ok(o.expectedFundingUsd>0);
  assert.ok(o.normalized8hBps<0);assert.equal(o.eligible,true);
});

test('aligned still requires a legal first batch, valid current data, known fees and matching source',()=>{
  for(const change of [{asks:[]},{asks:[{price:99.9,quantity:.049}]},{timestamp:NaN},
    {observedAt:now-config.maxSnapshotAgeMs-1},{observedAt:now-config.maxQuoteSkewMs-1},
    {nextFundingTime:now+3000},{nextFundingTime:NaN},{minQuantity:2},{minNotional:110},{source:'demo' as const}]){
    const snapshots=pair();Object.assign(snapshots[0],change);
    assert.equal(calculateOpportunities(snapshots,config,now)[0].eligible,false,JSON.stringify(change));
  }
  for(const fee of [NaN,Infinity,-.01,undefined]){
    const bad={...config,takerFees:{...config.takerFees,bitget:fee}} as AppConfig;
    const [o]=calculateOpportunities(pair(),bad,now);assert.equal(o.eligible,false);
    assert.equal(o.checks!.find(check=>check.label==='两腿手续费已知')!.pass,false);
  }
  const equalFunding=pair();equalFunding[1].fundingRate=0;
  assert.equal(calculateOpportunities(equalFunding,config,now)[0].eligible,false);
});

test('aligned rejects observed crossed quotes without making missing opposite-side quotes mandatory',()=>{
  const crossed=pair();crossed[0].bids=[{price:100,quantity:5}];
  const [o]=calculateOpportunities(crossed,config,now);
  assert.equal(o.eligible,false);assert.ok(o.reasons.includes('交易所买卖盘口价格倒挂，等待一致的新报价'));
  crossed[0].bids=[];crossed[1].asks=[];
  assert.equal(calculateOpportunities(crossed,config,now)[0].eligible,true);
});

test('aligned does not call or wait for historical median and preserves legacy funding/dual choices',()=>{
  const unused:SpreadHistoryProvider={assess:()=>{throw new Error('History must not be a prerequisite for aligned entry');}};
  assert.equal(calculateOpportunities(pair(),config,now,unused)[0].eligible,true);
  assert.equal(calculateOpportunities(pair(),{...config,entryPolicy:'funding'},now)[0].eligible,false,'funding retains one-cycle cost gate');
  for(const entryPolicy of ['dual',undefined] as const){
    const [o]=calculateOpportunities(pair(),{...config,entryPolicy},now);
    assert.equal(o.entryPolicy,'dual');assert.equal(o.eligible,false);assert.equal(o.combinedExpectedNetUsd,null);
  }
});
