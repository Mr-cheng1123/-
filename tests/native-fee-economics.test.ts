import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeTakerFeeRate,nativeMakerFeeRate,takerFeeRate} from '../src/shared/trading-fees.js';
import {defaultConfig} from '../src/shared/config.js';
import {assessProfitExit,assessAlignedExit} from '../src/core/profit-exit.js';
import {calculateOpportunities} from '../src/core/strategy.js';
import type {MarketSnapshot,Position} from '../src/shared/types.js';

const now=1_790_921_600_000;
const config={...defaultConfig,mode:'live' as const,entryPolicy:'aligned' as const,orderNotionalUsd:100};
const quote=(exchange:'gate'|'bybit',rate:number):MarketSnapshot=>({exchange,base:'DGAI',symbol:'DGAI/USDT:USDT',
  timestamp:now,observedAt:now,source:'public',markPrice:100,indexPrice:100,fundingRate:rate,
  intervalHours:8,nextFundingTime:now+60000,fundingHistory:[],bids:[{price:100,quantity:5}],asks:[{price:100,quantity:5}],
  quantityStep:.001,minQuantity:.001,minNotional:1,contractSize:1,openInterestUsd:0,volume24hUsd:0,
  takerFeeSource:'exchange',takerFeeAt:now,takerFeeRate:exchange==='gate'?.0005:.0011});
const position=():Position=>({id:'native-fee-profit',base:'DGAI',mode:'live',status:'open',entryPolicy:'aligned',holdMode:'adaptive',
  openedAt:now-1000,plannedExitAt:now+70000,
  long:{exchange:'gate',symbol:'DGAI/USDT:USDT',side:'long',quantity:1,entryPrice:100,markPrice:100,feesUsd:.05,liquidationDistancePct:null},
  short:{exchange:'bybit',symbol:'DGAI/USDT:USDT',side:'short',quantity:1,entryPrice:100,markPrice:100,feesUsd:.11,liquidationDistancePct:null},
  fundingUsd:.28,feesUsd:.16,transferCostUsd:0,realizedSpreadPnlUsd:0,spreadPnlUsd:0,netPnlUsd:.12,deltaUsd:0,
  fundingEvents:[],riskReasons:[],profitExitPolicy:{firstFundingTime:now+60000,earliestExitAt:now+70000,
    minSpreadNetUsd:0,minCombinedNetUsd:0,fundingChecks:[]}});

test('native special-symbol closing fee prevents a false recovered profit',()=>{
  const long=quote('gate',0),short=quote('bybit',0),p=position();
  const value=assessProfitExit(p,long,short,config,now)!;
  assert.ok(Math.abs(value.closingFeesUsd-.16)<1e-12);
  assert.ok(Math.abs(value.netPnlUsd-(-.04))<1e-12);
  assert.equal(assessAlignedExit(p,long,short,config,now)!.passes,false);
  short.takerFeeRate=.00055;
  assert.ok(assessProfitExit(p,long,short,config,now)!.netPnlUsd>0);
});

test('live aligned bankable profit stays unknown without complete current account fee observations',()=>{
  const long=quote('gate',0),short=quote('bybit',0),p=position();
  for(const bad of [{takerFeeAt:now-120001},{takerFeeAt:now+5001},{takerFeeRate:NaN},{takerFeeSource:undefined}]){
    assert.equal(assessProfitExit(p,long,{...short,...bad},config,now),undefined);
  }
  assert.equal(nativeTakerFeeRate(undefined,now),undefined);
  const stale={...short,takerFeeAt:now-120001};
  assert.equal(takerFeeRate(stale,config,now),undefined,'live calculations never invent configured fees');
  assert.equal(takerFeeRate(stale,{...config,mode:'paper'},now),config.takerFees.bybit,'isolated paper simulations have explicit configured fees');
  assert.equal(takerFeeRate(stale,config,now,true),undefined);
});

test('native contract fees also reach four-order opportunity economics',()=>{
  const long=quote('gate',0),short=quote('bybit',.001);
  short.markPrice=short.indexPrice=101;short.bids=[{price:101,quantity:5}];short.asks=[{price:101,quantity:5}];
  const native=calculateOpportunities([long,short],config,now)[0];
  const fallback=calculateOpportunities([{...long,takerFeeSource:undefined},{...short,takerFeeSource:undefined}],{...config,mode:'paper'},now)[0];
  assert.ok(native.feesUsd>fallback.feesUsd);
  assert.equal(native.feesSource,'exchange');assert.equal(fallback.feesSource,'simulation');
  assert.ok(native.expectedNetUsd<fallback.expectedNetUsd);
  assert.equal(native.eligible,true,'positive funding and price entry does not suddenly require a single-round payback');
});

test('every live entry model rejects missing official fee evidence without hiding funding or price data',()=>{
  const long=quote('gate',0),short=quote('bybit',.001);
  short.markPrice=short.indexPrice=101;short.bids=[{price:101,quantity:5}];short.asks=[{price:101,quantity:5}];
  delete short.takerFeeSource;
  const history={assess:()=>({status:'ready' as const,samples:12,requiredSamples:12,observedSpanSec:180,requiredSpanSec:120,
    longEntryPrice:100,shortEntryPrice:101,entrySpreadBps:100,expectedExitSpreadBps:0,spreadAdvantageBps:100,expectedSpreadPnlUsd:1})};
  for(const entryPolicy of ['aligned','funding','dual'] as const){
    const [o]=calculateOpportunities([long,short],{...config,entryPolicy},now,history);
    assert.equal(o.feesSource,'pending');assert.equal(o.eligible,false);assert.ok(o.expectedFundingUsd>0);
    assert.equal(o.checks!.find(check=>check.label==='两腿手续费已知')!.pass,false);
    assert.ok(Number.isNaN(o.feesUsd));assert.equal(o.combinedExpectedNetUsd,null);
  }
});

test('Maker fee evidence has independent provenance and age and preserves official rebates',()=>{
  const observed={makerFeeRate:-.0001,makerFeeAt:now,makerFeeSource:'exchange' as const};
  assert.equal(nativeMakerFeeRate(observed,now),-.0001);
  assert.equal(nativeMakerFeeRate({...observed,makerFeeRate:0},now),0);
  assert.equal(nativeMakerFeeRate({...observed,makerFeeRate:.0002},now),.0002);
  assert.equal(nativeMakerFeeRate(quote('gate',0),now),undefined,'known Taker is not Maker evidence');
  for(const bad of [{makerFeeAt:now-120001},{makerFeeAt:now+5001},{makerFeeRate:NaN},{makerFeeRate:.011},
    {makerFeeRate:-.011},{makerFeeSource:'simulation' as const},{makerFeeSource:undefined}])
    assert.equal(nativeMakerFeeRate({...observed,...bad},now),undefined);
  assert.equal(nativeMakerFeeRate(undefined,now),undefined);
});
