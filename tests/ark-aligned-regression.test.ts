import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateOpportunities} from '../src/core/strategy.js';
import {defaultConfig} from '../src/shared/config.js';
import type {AppConfig,MarketSnapshot} from '../src/shared/types.js';

// Prices and native 1h funding rates transcribed from the user's ARK screenshot.
// Deep-enough synthetic size isolates eligibility; this is not evidence of a historical live fill.
test('the ARK screenshot can qualify for aligned multi-round holding despite a negative first-round net estimate',()=>{
  const now=1790870880000;
  const config:AppConfig={...defaultConfig,entryPolicy:'aligned',holdMode:'adaptive',orderNotionalUsd:100,minCombinedNetUsd:100};
  const common={base:'ARK',symbol:'ARK/USDT:USDT',timestamp:now,observedAt:now,indexPrice:.235,
    intervalHours:1,nextFundingTime:now+52*60_000,fundingHistory:[],quantityStep:1,minQuantity:1,minNotional:5,
    contractSize:1,openInterestUsd:0,volume24hUsd:0,source:'public' as const};
  const quotes:MarketSnapshot[]=[
    {...common,exchange:'binance',markPrice:.23332,fundingRate:-.0027115,bids:[{price:.2333,quantity:1000}],asks:[{price:.2334,quantity:1000}]},
    {...common,exchange:'bybit',markPrice:.23694,fundingRate:-.000888,bids:[{price:.23699,quantity:1000}],asks:[{price:.23704,quantity:1000}]}
  ];
  const [opportunity]=calculateOpportunities(quotes,config,now);
  assert.equal(opportunity.id,'ARK-binance-bybit');assert.equal(opportunity.longQuantity,opportunity.shortQuantity);
  assert.equal(opportunity.eligible,true,opportunity.reasons.join('；'));
  assert.ok(opportunity.expectedFundingUsd>0);assert.ok(opportunity.entryLimitPriceEdgeBps!>0);
  assert.ok(opportunity.combinedExpectedNetUsd!<0);assert.equal(opportunity.breakEvenRounds,2);
  assert.equal(opportunity.checks!.some(check=>check.label.includes('净收益达标')),false);
});
