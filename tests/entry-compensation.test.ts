import test from 'node:test';
import assert from 'node:assert/strict';
import type {MarketSnapshot} from '../src/shared/types.js';
import {compareEntryCompensation,type EntryCompensationInput} from '../src/core/entry-compensation.js';

function snapshot(exchange:'gate'|'bybit'):MarketSnapshot {
  const long=exchange==='gate';
  return {exchange,base:'BTC',symbol:'BTC/USDT:USDT',source:'public',timestamp:100_000,observedAt:100_000,
    markPrice:1,indexPrice:1,fundingRate:long?0:.005,nextFundingTime:200_000,intervalHours:8,fundingHistory:[],
    bids:[{price:long?.999:1.012,quantity:1000}],asks:[{price:long?1:1.013,quantity:1000}],
    quantityStep:1,minQuantity:1,minNotional:1,contractSize:1,openInterestUsd:1e6,volume24hUsd:1e6};
}
function input():EntryCompensationInput {
  return {observedAt:100_000,batchId:'p:2',long:snapshot('gate'),short:snapshot('bybit'),
    longQuantity:100,shortQuantity:106,previousMatched:100,frozenTarget:150,
    unmatchedEntryPrice:1.012,averagePriceVerified:true,originalIntentsConfirmed:true,
    longTakerFeeRate:.0005,shortTakerFeeRate:.0005,hedgeLimitPrice:1,minimumPriceEdgeBps:80,
    predictedFundingUsd:.03,projectionUntil:200_000};
}
const near=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-10,`${actual} != ${expected}`);

test('a legal missing six coins can preserve exactly 106 rather than rounding existing matches to 100',()=>{
  const value=input(),before=structuredClone(value),plan=compareEntryCompensation(value);
  assert.equal(plan.evidence.decision,'hedge');assert.equal(plan.evidence.hedge!.quantity,6);
  near(plan.evidence.rollback!.pricePnlUsd,-.006);near(plan.evidence.rollback!.feesUsd,.003039);
  near(plan.evidence.rollback!.costUsd,.009039);near(plan.evidence.hedge!.pricePnlUsd,-.012);
  near(plan.evidence.hedge!.feesUsd,.009036);near(plan.evidence.hedge!.costUsd,-.008964);
  assert.equal(plan.evidence.hedge!.basis,'current-book-at-cycle-end');assert.equal(plan.evidence.rollback!.basis,'immediate-rollback');
  assert.equal(plan.evidence.hedge!.predictedFundingUsd,.03);assert.equal(plan.evidence.rollback!.predictedFundingUsd,0);
  assert.deepEqual(value,before,'a decision never mutates quantities or booked cash');
});

test('a large positive opening venue basis is cancelled by the same projected close basis',()=>{
  const value=input();value.unmatchedEntryPrice=2;value.short.bids[0].price=2;value.short.asks[0].price=2.001;
  value.predictedFundingUsd=.0001;
  const plan=compareEntryCompensation(value);assert.equal(plan.evidence.decision,'rollback');
  near(plan.evidence.hedge!.pricePnlUsd,-.012);assert.ok(plan.evidence.hedge!.pricePnlUsd<0);
  assert.ok(plan.evidence.hedge!.costUsd>plan.evidence.rollback!.costUsd);
});

test('both alternatives price the same exact tail and the hedge adds missing-open and both future-close fees only',()=>{
  const value=input();value.longTakerFeeRate=.001;value.shortTakerFeeRate=.002;
  const plan=compareEntryCompensation(value),hedge=plan.evidence.hedge!,rollback=plan.evidence.rollback!;
  near(hedge.feesUsd,6*1*.001+6*.999*.001+6*1.013*.002);
  near(rollback.feesUsd,6*1.013*.002);
  near(hedge.costUsd,hedge.feesUsd-hedge.pricePnlUsd-.03);
  assert.equal(hedge.quantity,rollback.quantity);
});

test('a small positive funding advantage can make immediate rollback cheaper, with no booked forecast profit',()=>{
  const value=input();value.predictedFundingUsd=.001;
  const plan=compareEntryCompensation(value);assert.equal(plan.evidence.decision,'rollback');
  assert.ok(plan.evidence.hedge!.costUsd>plan.evidence.rollback!.costUsd);
});

test('unknown original order state or unverified average blocks both alternative cash calculations',()=>{
  for(const field of ['originalIntentsConfirmed','averagePriceVerified'] as const){
    const value=input();value[field]=false;const plan=compareEntryCompensation(value);
    assert.equal(plan.evidence.decision,'wait');assert.equal(plan.reason,'unconfirmed-basis');
    assert.equal(plan.evidence.hedge,undefined);assert.equal(plan.evidence.rollback,undefined);
  }
});

test('a supplement must stay above the strict 80bps threshold and still have positive forecast funding',()=>{
  for(const funding of [undefined,0,-.1]){
    const value=input();value.predictedFundingUsd=funding;
    const plan=compareEntryCompensation(value);assert.equal(plan.evidence.decision,'rollback');assert.equal(plan.evidence.hedge,undefined);
  }
  const value=input();value.unmatchedEntryPrice=1.008;
  assert.equal(compareEntryCompensation(value).evidence.hedge,undefined,'equal to 80bps cannot authorize a repair');
});

test('missing-venue lot, minimum notional and available first-level depth are enforced independently',()=>{
  for(const mutate of [(v:EntryCompensationInput)=>{v.long.quantityStep=10;},
    (v:EntryCompensationInput)=>{v.long.minNotional=7;},(v:EntryCompensationInput)=>{v.long.asks[0].quantity=5;}]){
    const value=input();mutate(value);const plan=compareEntryCompensation(value);
    assert.equal(plan.evidence.decision,'rollback');assert.equal(plan.evidence.hedge,undefined);
    assert.equal(plan.evidence.rollback!.quantity,6,'never round a comparison to a different group of coins');
  }
});

test('a legally hedgeable fragment may complete 106 even if the original venue cannot reduce that six-coin fragment',()=>{
  const value=input();value.short.quantityStep=10;value.short.minQuantity=10;
  const plan=compareEntryCompensation(value);assert.equal(plan.reason,'hedge-only-legal');
  assert.equal(plan.evidence.decision,'hedge');assert.equal(plan.evidence.hedge!.quantity,6);assert.equal(plan.evidence.rollback,undefined);
  value.long.quantityStep=10;value.long.minQuantity=10;
  assert.equal(compareEntryCompensation(value).evidence.decision,'wait','two illegal fragments do not invent a rounded target');
});

test('original target and previously matched holdings cannot be enlarged or consumed by a compensation',()=>{
  const value=input();value.frozenTarget=105;
  assert.equal(compareEntryCompensation(value).reason,'invalid-quantity');
  value.frozenTarget=150;value.previousMatched=101;
  assert.equal(compareEntryCompensation(value).reason,'invalid-quantity');
});

test('unknown native fees, inconsistent instruments, crossed books and nonvisible prices cannot approve a hedge',()=>{
  for(const mutate of [(v:EntryCompensationInput)=>{v.longTakerFeeRate=undefined;},
    (v:EntryCompensationInput)=>{v.short.base='ETH';},(v:EntryCompensationInput)=>{v.long.bids[0].price=1.1;}]){
    const value=input();mutate(value);assert.equal(compareEntryCompensation(value).evidence.decision,'wait');
  }
  const value=input();value.hedgeLimitPrice=1.00001;
  assert.equal(compareEntryCompensation(value).evidence.hedge,undefined,'synthetic limit prices are not quote evidence');
});

test('closing depth VWAP is shared by the two conditional alternatives rather than mixing quote and mark basis',()=>{
  const value=input();value.short.asks=[{price:1.013,quantity:2},{price:1.014,quantity:4}];
  const plan=compareEntryCompensation(value);near(plan.evidence.hedge!.shortClosePrice!,(2*1.013+4*1.014)/6);
  assert.equal(plan.evidence.rollback!.shortClosePrice,plan.evidence.hedge!.shortClosePrice);
  assert.equal(plan.evidence.rollback!.limitPrice,1.014);assert.equal(plan.evidence.shortBookObservedAt,100_000);
});

test('Gate 70% and Bitget 50% returns adjust both future alternatives while freezing gross account rates',()=>{
  const value=input();value.short.exchange='bitget';value.longTakerFeeRate=.001;value.shortTakerFeeRate=.002;
  value.feeRebatePct={gate:70,bitget:50};const before=structuredClone(value),plan=compareEntryCompensation(value);
  near(plan.evidence.hedge!.feesUsd,6*1*.0003+6*.999*.0003+6*1.013*.001);
  near(plan.evidence.rollback!.feesUsd,6*1.013*.001);
  near(plan.evidence.hedge!.costUsd,plan.evidence.hedge!.feesUsd-plan.evidence.hedge!.pricePnlUsd-.03);
  assert.equal(plan.evidence.longTakerFeeRate,.001);assert.equal(plan.evidence.shortTakerFeeRate,.002);
  assert.deepEqual(plan.evidence.feeRebatePct,{gate:70,bitget:50});assert.deepEqual(value,before);
  value.feeRebatePct.gate=0;assert.equal(plan.evidence.feeRebatePct!.gate,70,'evidence freezes the observed policy');
});
test('a long unmatched Gate leg discounts rollback and only the three future hedge fees',()=>{
  const value=input();value.short.exchange='bitget';value.longQuantity=106;value.shortQuantity=100;
  value.unmatchedEntryPrice=1;value.hedgeLimitPrice=1.012;value.feeRebatePct={gate:70,bitget:50};
  const plan=compareEntryCompensation(value);
  near(plan.evidence.rollback!.feesUsd,6*.999*.0005*.3);
  near(plan.evidence.hedge!.feesUsd,6*1.012*.0005*.5+6*.999*.0005*.3+6*1.013*.0005*.5);
  assert.equal(plan.evidence.rollback!.quantity,6);assert.equal(plan.evidence.hedge!.quantity,6);
});
test('return percentages can change which conditional future cost is cheaper without creating realized income',()=>{
  const value=input();value.short.exchange='bitget';value.predictedFundingUsd=.01;
  const gross=compareEntryCompensation(value);assert.equal(gross.evidence.decision,'rollback');
  value.feeRebatePct={gate:70,bitget:50};const net=compareEntryCompensation(value);
  assert.equal(net.evidence.decision,'hedge');assert.ok(net.evidence.hedge!.costUsd<net.evidence.rollback!.costUsd);
  assert.equal(net.evidence.hedge!.pricePnlUsd,gross.evidence.hedge!.pricePnlUsd);
  assert.equal(net.evidence.hedge!.predictedFundingUsd,gross.evidence.hedge!.predictedFundingUsd);
});
test('a 100% return cannot supply missing or invalid native gross fee evidence',()=>{
  for(const rate of [undefined,NaN,Infinity,-.001,1.001])for(const leg of ['longTakerFeeRate','shortTakerFeeRate'] as const){
    const value=input();value.feeRebatePct={gate:100,bybit:100};value[leg]=rate;
    const plan=compareEntryCompensation(value);assert.equal(plan.evidence.decision,'wait');
    assert.equal(plan.reason,'invalid-book-or-fees');assert.equal(plan.evidence.rollback,undefined);assert.equal(plan.evidence.hedge,undefined);
  }
});
test('returns never relax the independent strict IOC price threshold or legal missing-leg quantity',()=>{
  const value=input();value.feeRebatePct={gate:100,bybit:100};value.unmatchedEntryPrice=1.008;
  assert.equal(compareEntryCompensation(value).evidence.hedge,undefined,'equal to the original 80bps remains ineligible');
  value.unmatchedEntryPrice=1.012;value.long.asks[0].quantity=5;
  assert.equal(compareEntryCompensation(value).evidence.hedge,undefined,'real six-coin tail cannot borrow more visible capacity');
});
test('absent or invalid return percentages preserve the original gross future costs',()=>{
  const original=compareEntryCompensation(input());assert.equal(original.evidence.feeRebatePct,undefined);
  const value=input();value.feeRebatePct={gate:NaN,bybit:101};const invalid=compareEntryCompensation(value);
  assert.deepEqual(invalid.evidence.hedge,original.evidence.hedge);assert.deepEqual(invalid.evidence.rollback,original.evidence.rollback);
  assert.deepEqual(invalid.evidence.feeRebatePct,{gate:0,bybit:0});
});
