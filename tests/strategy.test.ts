import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from './legacy-config.js';
import { calculateOpportunities, commonStep, sweep } from '../src/core/strategy.js';
import { ReadyHistory } from './ready-history.js';
import type { MarketSnapshot, SpreadHistoryProvider } from '../src/shared/types.js';
const now=1700000000000;
const cfg={...defaultConfig,orderNotionalUsd:1000};
export function quote(overrides:Partial<MarketSnapshot>={}):MarketSnapshot{return {exchange:'binance',base:'BTC',symbol:'BTC/USDT:USDT',timestamp:now,markPrice:100,indexPrice:100,fundingRate:.0001,nextFundingTime:now+60000,intervalHours:8,fundingHistory:[.0001,.0001,.0001],bids:[{price:100,quantity:100}],asks:[{price:100,quantity:100}],openInterestUsd:1e9,volume24hUsd:1e9,quantityStep:.001,minQuantity:.001,minNotional:1,contractSize:1,source:'demo',...overrides};}
const history=(advantageBps=20):SpreadHistoryProvider=>new ReadyHistory(advantageBps);

test('cash funding handles negative rates and counts the four taker fees once',()=>{
  const [o]=calculateOpportunities([quote({fundingRate:-.005}),quote({exchange:'bybit',fundingRate:-.001})],cfg,now,history(5));
  assert.equal(o.longExchange,'binance');assert.equal(o.shortExchange,'bybit');
  assert.equal(o.expectedFundingUsd,4);assert.ok(Math.abs(o.feesUsd-2.1)<1e-9);
  assert.ok(Math.abs(o.expectedNetUsd-(4-2.1+.5))<1e-9);assert.ok(o.eligible);
});
test('one-cycle direction follows actual cash flow even when its normalized annual carry is negative',()=>{
  const [o]=calculateOpportunities([quote({fundingRate:.001,intervalHours:1}),quote({exchange:'bybit',fundingRate:.002,intervalHours:8})],cfg,now,history());
  assert.equal(o.shortExchange,'bybit');assert.equal(o.longExchange,'binance');
  assert.ok(o.expectedFundingUsd>0);assert.ok(Math.abs(o.normalized8hBps+60)<1e-9);
});
test('stale quotes and invalid or imminent settlements never trade',()=>{
  for(const change of [{nextFundingTime:now-1},{nextFundingTime:now+2000},{timestamp:now-60000},{timestamp:NaN},{nextFundingTime:NaN}]){
    const [o]=calculateOpportunities([quote(),quote({exchange:'bybit',fundingRate:.01,...change})],cfg,now,history());
    assert.equal(o.eligible,false,JSON.stringify(change));assert.ok(o.reasons.length>0);
  }
});
test('common quantity satisfies both contract increments',()=>{
  assert.equal(commonStep(.003,.002),.006);
  const [o]=calculateOpportunities([quote({quantityStep:.003}),quote({exchange:'bybit',quantityStep:.002,fundingRate:.01})],cfg,now,history());
  assert.equal(o.longQuantity,o.shortQuantity);assert.equal(o.deltaUsd,0);
  assert.ok(Math.abs(o.longQuantity/.003-Math.round(o.longQuantity/.003))<1e-8);
  assert.ok(Math.abs(o.shortQuantity/.002-Math.round(o.shortQuantity/.002))<1e-8);
});

test('without spread history the quote stays visible but cannot enter; with it, the same quote qualifies',()=>{
  const pair=[quote({source:'public'}),quote({exchange:'bybit',source:'public',fundingRate:.01})];
  const [warming]=calculateOpportunities(pair,cfg,now);
  assert.ok(Number.isFinite(warming.expectedNetUsd));assert.equal(warming.eligible,false);
  assert.equal(warming.checks!.find(check=>check.label.includes('历史样本'))!.pass,null);
  const [ready]=calculateOpportunities(pair,cfg,now,history());
  assert.equal(ready.eligible,true);assert.deepEqual(ready.reasons,[]);
});
test('thin books are rejected because the whole size could not be priced',()=>{
  const [thin]=calculateOpportunities([quote({asks:[{price:100,quantity:1}]}),quote({exchange:'bybit',fundingRate:.01})],cfg,now,history());
  assert.ok(thin.reasons.includes('盘口深度不足'));assert.equal(thin.eligible,false);
  assert.deepEqual(sweep([{price:100,quantity:2},{price:101,quantity:3}],4),{filled:4,average:100.5,value:402,worstPrice:101});
});

test('continuous forecast counts funding over the holding horizon and charges roundtrip fees once',()=>{
  const snapshots=[quote({fundingRate:0}),quote({exchange:'bybit',fundingRate:.001})];
  const [once]=calculateOpportunities(snapshots,cfg,now,history());
  const [continuous]=calculateOpportunities(snapshots,{...cfg,holdMode:'continuous',maxHoldHours:24},now,history());
  assert.equal(once.expectedFundingUsd,1);assert.equal(continuous.expectedFundingUsd,3);
  assert.equal(continuous.feesUsd,once.feesUsd);assert.equal(continuous.exitTime,now+24*3600000);
});

test('adaptive entry uses only the first cycle and can choose a different direction from continuous holding',()=>{
  const snapshots=[quote({fundingRate:.001,intervalHours:1}),quote({exchange:'bybit',fundingRate:.002})];
  const c={...cfg,takerFees:{...cfg.takerFees,binance:0,bybit:0}};
  const [adaptive]=calculateOpportunities(snapshots,{...c,holdMode:'adaptive'},now,history());
  const [continuous]=calculateOpportunities(snapshots,{...c,holdMode:'continuous'},now,history());
  assert.equal(adaptive.exitTime,now+70_000);assert.equal(adaptive.longExchange,'binance');assert.equal(adaptive.expectedFundingUsd,1);
  assert.equal(continuous.longExchange,'bybit');assert.equal(continuous.expectedFundingUsd,18);
});

// --- the entry rule itself ---------------------------------------------------------------------------------------------
const edge=(change:Partial<MarketSnapshot>={},fundingRate=.003)=>[quote({fundingRate:0}),quote({exchange:'bybit',fundingRate,...change})];

test('entry needs positive funding, a spread advantage and a combined net above the threshold, nothing else',()=>{
  assert.equal(calculateOpportunities(edge(),cfg,now,history())[0].eligible,true);
  // no funding edge
  assert.equal(calculateOpportunities(edge({},0),cfg,now,history())[0].eligible,false);
  assert.equal(calculateOpportunities(edge({},-.001),cfg,now,history())[0].eligible,true);   // direction flips: the other leg is paid
  // no spread advantage
  assert.equal(calculateOpportunities(edge(),cfg,now,history(0))[0].eligible,false);
  assert.equal(calculateOpportunities(edge(),cfg,now,history(-5))[0].eligible,false);
  // combined net must clear the threshold, counted after ONE set of four fees
  const [o]=calculateOpportunities(edge(),cfg,now,history(20));
  assert.ok(Math.abs(o.combinedExpectedNetUsd!-(o.expectedFundingUsd-o.feesUsd+o.spreadAdvantage!.expectedSpreadPnlUsd!))<1e-9);
  assert.equal(calculateOpportunities(edge(),{...cfg,minCombinedNetUsd:o.combinedExpectedNetUsd!+.01},now,history(20))[0].eligible,false);
});

test('funding and spread do not each have to cover the fees: a good spread can carry modest positive funding',()=>{
  const [o]=calculateOpportunities(edge({},.0005),cfg,now,history(40));
  assert.ok(o.fundingAfterFeesUsd!<0);assert.ok(o.spreadAfterFeesUsd!>0);assert.ok(o.combinedExpectedNetUsd!>cfg.minCombinedNetUsd);
  assert.equal(o.eligible,true);
});

test('retired filters no longer block: window, settlement skew, basis, delta, exposure, liquidity, funding trend',()=>{
  const far=now+6*3600000;
  const [o]=calculateOpportunities([quote({fundingRate:0,nextFundingTime:far,markPrice:100,openInterestUsd:0,volume24hUsd:0}),
    quote({exchange:'bybit',fundingRate:.003,nextFundingTime:far+3*3600000,markPrice:104,predictedFundingRate:-.01,openInterestUsd:0,volume24hUsd:0})],
    {...cfg,orderNotionalUsd:5000,leverage:20},now,history());
  assert.equal(o.eligible,true,o.reasons.join('；'));
  assert.ok(o.checks!.every(check=>!/窗口|结算时间一致|基差|Delta|持仓量|成交额|仓位/.test(check.label)));
});

test('what remains blocking is only whether the numbers are real and executable',()=>{
  const config={...cfg,orderNotionalUsd:100,holdMode:'continuous' as const};
  for(const change of [{asks:[]},{timestamp:now-60_000},{timestamp:NaN},{nextFundingTime:NaN},{nextFundingTime:now-1},{minNotional:101}]){
    const [o]=calculateOpportunities([quote({fundingRate:0,...change}),quote({exchange:'bybit',fundingRate:.01})],config,now,history());
    assert.equal(o.eligible,false,JSON.stringify(change));
  }
});

test('quote fetch times must be close together, but only when both sides report them',()=>{
  const sync=(a:number|undefined,b:number|undefined)=>calculateOpportunities([quote({fundingRate:0,observedAt:a}),quote({exchange:'bybit',fundingRate:.003,observedAt:b})],cfg,now,history())[0];
  assert.equal(sync(now,now+cfg.maxQuoteSkewMs).eligible,true);
  assert.equal(sync(now,now+cfg.maxQuoteSkewMs+1).eligible,false);
  assert.equal(sync(undefined,now).eligible,true);
  assert.equal(sync(undefined,now+99999).eligible,false); // A missing peer observation cannot validate a future quote.
});
