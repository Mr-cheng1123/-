import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfig} from '../src/shared/config.js';
import type {AppConfig,ExchangeId,MarketSnapshot,Position} from '../src/shared/types.js';
import {planMakerClose,selectMakerCloseLeg} from '../src/core/maker-close-plan.js';

const now=1_791_575_807_231;
const config:AppConfig={...defaultConfig,mode:'live',entryPolicy:'aligned',holdMode:'adaptive',minExitProfitBps:10};
function quote(exchange:ExchangeId,changes:Partial<MarketSnapshot>={}):MarketSnapshot {
  return {exchange,base:'BTC',symbol:'BTC/USDT:USDT',timestamp:now,observedAt:now,source:'public',
    markPrice:exchange==='gate'?100:101,indexPrice:100,fundingRate:0,nextFundingTime:now+60_000,intervalHours:8,
    bids:[{price:exchange==='gate'?100:101,quantity:20}],asks:[{price:exchange==='gate'?100.8:101.1,quantity:20}],
    fundingHistory:[],quantityStep:.001,minQuantity:.001,minNotional:1,contractSize:1,openInterestUsd:0,volume24hUsd:0,
    makerFeeRate:.0002,makerFeeAt:now,makerFeeSource:'exchange',takerFeeRate:exchange==='gate'?.0005:.00055,
    takerFeeAt:now,takerFeeSource:'exchange',...changes};
}
function position():Position {
  return {id:'maker-profit-offline',base:'BTC',mode:'live',status:'open',entryPolicy:'aligned',holdMode:'adaptive',
    long:{exchange:'gate',symbol:'BTC/USDT:USDT',side:'long',quantity:1,entryPrice:100,markPrice:100,feesUsd:.05,liquidationDistancePct:null},
    short:{exchange:'bybit',symbol:'BTC/USDT:USDT',side:'short',quantity:1,entryPrice:101,markPrice:101,feesUsd:.06,liquidationDistancePct:null},
    openedAt:now-1000,plannedExitAt:now+70_000,profitExitNotionalUsd:100.5,fundingUsd:.2,feesUsd:.11,transferCostUsd:.03,
    realizedSpreadPnlUsd:.05,spreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[],
    profitExitPolicy:{firstFundingTime:now+60_000,earliestExitAt:now+70_000,minSpreadNetUsd:0,minCombinedNetUsd:0,
      fundingChecks:[{exchange:'gate',timestamp:now+60_000},{exchange:'bybit',timestamp:now+60_000}]}};
}
const near=(actual:number,expected:number,message?:string)=>assert.ok(Math.abs(actual-expected)<1e-10,message??`${actual} != ${expected}`);

test('relative full spread selects the wider venue and posts a reducing long sell at its ask',()=>{
  const p=position(),long=quote('gate'),short=quote('bybit'),before=structuredClone({p,long,short});
  const plan=planMakerClose(p,long,short,config,now)!;
  assert.equal(selectMakerCloseLeg(long,short),'long');assert.equal(plan.makerLeg,'long');assert.equal(plan.makerSide,'sell');
  assert.equal(plan.makerExchange,'gate');assert.equal(plan.makerLimitPrice,100.8);
  assert.equal(plan.takerLeg,'short');assert.equal(plan.takerSide,'buy');assert.equal(plan.takerLimitPrice,101.1);
  assert.equal(plan.feeSource,'native');assert.equal(plan.submissionAllowed,true);
  near(plan.longSpreadBps,.8/100.4*10_000);
  assert.deepEqual({p,long,short},before,'selection and estimates never mutate actual cash or book observations');
  const highNominalShort=quote('bybit',{bids:[{price:1000,quantity:20}],asks:[{price:1002,quantity:20}]});
  assert.equal(selectMakerCloseLeg(long,highNominalShort),'long','percentage width beats absolute price width');
});

test('a wider short venue posts a reducing buy at its bid and sells the peer at its bid',()=>{
  const long=quote('gate',{asks:[{price:100.1,quantity:20}]}),short=quote('bybit',{asks:[{price:102,quantity:20}]});
  const plan=planMakerClose(position(),long,short,config,now)!;
  assert.equal(selectMakerCloseLeg(long,short),'short');assert.equal(plan.makerLeg,'short');assert.equal(plan.makerSide,'buy');
  assert.equal(plan.makerLimitPrice,101);assert.equal(plan.takerSide,'sell');assert.equal(plan.takerLimitPrice,100);
  near(plan.profit.closingFeesUsd,100*.0005+101*.0002);
});

test('Maker capacity is bounded by peer top depth and a common legal lot, not the Maker visible level',()=>{
  const p=position();p.long.quantity=p.short.quantity=6;p.profitExitNotionalUsd=603;
  const long=quote('gate',{quantityStep:.2,minQuantity:.6,minNotional:1_000_000,
    bids:[{price:100,quantity:.01}],asks:[{price:100.8,quantity:.01}]}),
    short=quote('bybit',{quantityStep:.3,minQuantity:.6,minNotional:1_000_000,
      asks:[{price:102,quantity:50},{price:101.1,quantity:2},{price:101.1,quantity:2.5}]});
  const plan=planMakerClose(p,long,short,config,now)!;
  assert.equal(plan.commonQuantityStep,.6);assert.equal(plan.quantity,4.2);assert.equal(plan.takerTopQuantity,4.5);
  assert.equal(planMakerClose(p,long,short,config,now,{batchQuantity:1.2})!.quantity,1.2);
  for(const quantity of [0,NaN,-1,1.1,4.8])assert.equal(planMakerClose(p,long,short,config,now,{batchQuantity:quantity}),undefined);
});

test('a common Maker batch cannot manufacture off-grid holdings or a residual below a native minimum',()=>{
  const long=quote('gate',{quantityStep:.1,minQuantity:.6}),short=quote('bybit',{quantityStep:.1,minQuantity:.6,
    asks:[{price:101.1,quantity:.7}]});
  assert.equal(planMakerClose(position(),long,short,config,now),undefined);
  const p=position();p.long.quantity=p.short.quantity=1.05;
  assert.equal(planMakerClose(p,long,short,config,now),undefined);
});

test('full lifetime cash is counted once and closing fees use Maker on exactly one leg',()=>{
  const p=position(),long=quote('gate'),short=quote('bybit'),plan=planMakerClose(p,long,short,config,now)!;
  const spread=.05+(100.8-100)+(101-101.1),closing=100.8*.0002+101.1*.00055;
  near(plan.profit.spreadPnlUsd,spread);near(plan.profit.closingFeesUsd,closing);
  near(plan.profit.totalFeesUsd,p.feesUsd+closing);
  near(plan.profit.netPnlUsd,p.fundingUsd+spread-p.feesUsd-closing-p.transferCostUsd);
  const partial=planMakerClose(p,long,short,config,now,{batchQuantity:.1})!;
  near(partial.profit.netPnlUsd,plan.profit.netPnlUsd,'batch estimates do not prorate sunk or actual cash');
  near(partial.profitThresholdUsd,plan.profitThresholdUsd);
});

test('native fee requirements concern the Maker leg and peer Taker only, with actual Maker rebates preserved',()=>{
  const long=quote('gate'),short=quote('bybit');
  delete long.takerFeeRate;delete long.takerFeeAt;delete long.takerFeeSource;
  delete short.makerFeeRate;delete short.makerFeeAt;delete short.makerFeeSource;
  const plan=planMakerClose(position(),long,short,config,now)!;
  assert.equal(plan.submissionAllowed,true);assert.equal(plan.makerFeeRate,.0002);assert.equal(plan.takerFeeRate,.00055);
  long.makerFeeRate=-.0001;
  near(planMakerClose(position(),long,short,config,now)!.profit.closingFeesUsd,100.8*-.0001+101.1*.00055);
});

test('missing, old, malformed or simulated native fees never authorize a Maker batch',()=>{
  for(const change of [{makerFeeRate:undefined},{makerFeeAt:now-120_001},{makerFeeRate:NaN},{makerFeeRate:.011},
    {makerFeeSource:'simulation' as const},{makerFeeAt:now+5001}])
    assert.equal(planMakerClose(position(),quote('gate',change),quote('bybit'),config,now),undefined);
  for(const change of [{takerFeeRate:undefined},{takerFeeAt:now-120_001},{takerFeeRate:NaN},{takerFeeSource:undefined}])
    assert.equal(planMakerClose(position(),quote('gate'),quote('bybit',change),config,now),undefined);
});

test('local Maker and Taker references discover a candidate without being turned into native evidence',()=>{
  const long=quote('gate',{makerFeeRate:undefined,makerFeeAt:undefined,makerFeeSource:undefined,
    feeReference:{source:'account-reference',makerRate:.000123,takerRate:.0005,observedAt:now-500_000}}),
    short=quote('bybit',{takerFeeRate:undefined,takerFeeAt:undefined,takerFeeSource:undefined,
      feeReference:{source:'account-reference',makerRate:.0002,takerRate:.000789,observedAt:now-500_000}});
  const before=structuredClone([long,short]);
  assert.equal(planMakerClose(position(),long,short,config,now),undefined);
  const reference=planMakerClose(position(),long,short,config,now,{requireNativeFees:false})!;
  assert.equal(reference.makerFeeRate,.000123);assert.equal(reference.takerFeeRate,.000789);
  assert.equal(reference.feeSource,'reference');assert.equal(reference.makerFeeSource,'account-reference');
  assert.equal(reference.profitPass,true);assert.equal(reference.submissionAllowed,false);
  assert.deepEqual([long,short],before,'reading references never changes original observation time');
  assert.equal(planMakerClose(position(),quote('gate'),quote('bybit'),config,now,{requireNativeFees:false})!.submissionAllowed,false,
    'an explicit preview remains a preview even when native evidence happens to be present');
});

test('an unknown Maker reference cannot be invented as zero or derived from its Taker fee',()=>{
  const p=position();p.long.exchange='okx';
  const long=quote('okx',{bids:[{price:100,quantity:20}],asks:[{price:100.8,quantity:20}],
    makerFeeRate:undefined,makerFeeAt:undefined,makerFeeSource:undefined});
  assert.equal(planMakerClose(p,long,quote('bybit'),config,now,{requireNativeFees:false}),undefined);
});

test('stale, skewed, crossed, missing or mismatched books do not produce an economic order plan',()=>{
  for(const change of [{observedAt:now-config.maxSnapshotAgeMs-1},{observedAt:now-config.maxQuoteSkewMs-1},
    {bids:[{price:101,quantity:20}]},{asks:[]},{symbol:'OTHER/USDT:USDT'},{base:'OTHER'},{source:'demo' as const},
    {quantityStep:0},{minQuantity:NaN}])
    assert.equal(planMakerClose(position(),quote('gate',change),quote('bybit'),config,now),undefined);
  assert.equal(selectMakerCloseLeg(quote('gate',{bids:[]}),quote('bybit')),undefined);
  const locked=quote('gate',{asks:[{price:100,quantity:20}]}),lockedShort=quote('bybit',{asks:[{price:101,quantity:20}]});
  assert.equal(selectMakerCloseLeg(locked,lockedShort),undefined);
});

test('frozen actual submitted limits are repriced and a resting Maker may remain passive inside the current spread',()=>{
  const p=position(),long=quote('gate'),short=quote('bybit'),initial=planMakerClose(p,long,short,config,now)!;
  const inside=planMakerClose(p,long,short,config,now,{makerLeg:'long',limits:{longPrice:100.4,shortPrice:101.15}})!;
  assert.equal(inside.makerLimitPrice,100.4);assert.ok(inside.profit.netPnlUsd<initial.profit.netPnlUsd);
  const badPeer=planMakerClose(p,long,short,config,now,{makerLeg:'long',limits:{longPrice:100.4,shortPrice:102}})!;
  assert.equal(badPeer.profitPass,false);assert.equal(badPeer.submissionAllowed,false);
  assert.equal(planMakerClose(p,long,short,config,now,{limits:{longPrice:100,shortPrice:101.1}}),undefined,'Maker sell would cross');
  assert.equal(planMakerClose(p,long,short,config,now,{limits:{longPrice:100.8,shortPrice:101}}),undefined,'peer buy would not reach ask');
  short.asks=[{price:103,quantity:20}];assert.equal(selectMakerCloseLeg(long,short),'short');
  assert.equal(planMakerClose(p,long,short,config,now,{makerLeg:'long'})!.makerLeg,'long','supervision cannot silently switch the submitted Maker identity');
});

test('ten bps is strict on the frozen original single-leg notional and does not shrink with the first batch',()=>{
  const p=position();p.short.entryPrice=100;p.fundingUsd=p.feesUsd=p.realizedSpreadPnlUsd=p.transferCostUsd=0;p.profitExitNotionalUsd=125;
  const long=quote('gate',{bids:[{price:100,quantity:20}],asks:[{price:100.125,quantity:20}],makerFeeRate:0}),
    short=quote('bybit',{bids:[{price:99.99,quantity:20}],asks:[{price:100,quantity:20}],takerFeeRate:0});
  const equal=planMakerClose(p,long,short,config,now)!;
  assert.equal(equal.profit.netPnlUsd,.125);assert.equal(equal.profitThresholdUsd,.125);
  assert.equal(equal.profitPass,false);assert.equal(equal.submissionAllowed,false);
  long.asks=[{price:100.126,quantity:20}];
  assert.equal(planMakerClose(p,long,short,config,now)!.profitPass,true);
  const reduced=position();reduced.long.quantity=reduced.short.quantity=.1;reduced.profitExitNotionalUsd=125;
  assert.equal(planMakerClose(reduced,quote('gate'),quote('bybit'),config,now)!.profitThresholdUsd,.125);
  for(const threshold of [NaN,-1,Infinity])assert.equal(planMakerClose(p,long,short,{...config,minExitProfitBps:threshold},now),undefined);
});

test('cash proof is required for due settlements while first-future funding and repeated forecasts cannot count as cash',()=>{
  const p=position(),long=quote('gate'),short=quote('bybit');
  const first=planMakerClose(p,long,short,config,now)!;
  long.fundingRate=1;short.fundingRate=2;long.markPrice=short.markPrice=10_000;
  near(planMakerClose(p,long,short,config,now)!.profit.netPnlUsd,first.profit.netPnlUsd);
  p.profitExitPolicy!.fundingChecks[1].timestamp=now-20_000;
  assert.equal(planMakerClose(p,long,short,config,now),undefined,'already due receipt is not implied by a positive forecast');
  p.short.fundingObservedSince=p.openedAt;p.short.fundingObservedAt=now;
  assert.equal(planMakerClose(p,long,short,config,now),undefined,'twenty seconds does not prove an absent receipt');
  p.profitExitPolicy!.fundingChecks[1].timestamp=now-60_000;
  assert.ok(planMakerClose(p,long,short,config,now),'complete post-grace cash read can prove zero payment');
  p.fundingUsd=NaN;assert.equal(planMakerClose(p,long,short,config,now),undefined);
});

test('later settlement cycles need complete current evidence and manual or archived records are excluded',()=>{
  const p=position(),first=now-8*3_600_000-60_000,last=now-60_000;
  p.openedAt=first-1000;p.profitExitPolicy!.fundingChecks=[{exchange:'gate',timestamp:first},{exchange:'bybit',timestamp:first}];
  p.long.lastFundingAt=p.short.lastFundingAt=first;
  const long=quote('gate',{nextFundingTime:last+8*3_600_000}),short=quote('bybit',{nextFundingTime:last+8*3_600_000});
  assert.equal(planMakerClose(p,long,short,config,now),undefined);
  p.long.fundingObservedSince=p.short.fundingObservedSince=p.openedAt;p.long.fundingObservedAt=p.short.fundingObservedAt=now;
  assert.ok(planMakerClose(p,long,short,config,now));
  p.manualCloseOnly=true;assert.equal(planMakerClose(p,long,short,config,now),undefined);
  delete p.manualCloseOnly;p.accountClosure={confirmedAt:now,reason:'flat',historicalOrdersPending:true};
  assert.equal(planMakerClose(p,long,short,config,now),undefined);
});
