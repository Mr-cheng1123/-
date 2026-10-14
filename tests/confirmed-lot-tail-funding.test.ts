import test from 'node:test';
import assert from 'node:assert/strict';
import {lotTailFixture} from './confirmed-lot-tail-fixture.js';
import {assessConfirmedLotTailFundingExit,type ConfirmedLotTailFundingLossExit} from '../src/core/confirmed-lot-tail-funding.js';
import {assessAlignedExit} from '../src/core/profit-exit.js';
import {FundingExitStabilityTracker} from '../src/core/funding-exit-stability.js';
import {currentExitStrategyPosition} from '../src/shared/current-exit-strategy.js';

function fixture(){
  const f=lotTailFixture();
  for(const book of [f.long,f.short]){
    book.bids=[{price:.02999,quantity:1000}];book.asks=[{price:.03001,quantity:1000}];
    book.nextFundingTime=f.now+240_000;
  }
  f.long.fundingRate=.01;f.short.fundingRate=-.01;
  const assess=(longReduction=10,shortReduction=4,requireNativeFees=true,now=f.now)=>
    assessConfirmedLotTailFundingExit(f.p,f.long,f.short,f.config,now,longReduction,shortReduction,requireNativeFees);
  return {...f,assess};
}
const near=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-12,`${actual} != ${expected}`);
const cost=(f:ReturnType<typeof fixture>,longReduction=10,shortReduction=4)=>{
  const assessment=f.assess(longReduction,shortReduction);assert.ok(assessment?.fundingLossExit);
  return assessment.fundingLossExit as ConfirmedLotTailFundingLossExit;
};

test('six already filled coins are excluded from the new ten-long/four-short avoided funding',()=>{
  const f=fixture(),before=JSON.stringify({p:f.p,long:f.long,short:f.short,orders:f.orders}),a=f.assess()!,loss=cost(f);
  assert.equal(a.passes,true);assert.equal(a.exitSignal,'funding-loss');assert.ok(a.profit!.netPnlUsd<0);
  assert.equal(assessAlignedExit(f.p,f.long,f.short,f.config,f.now)?.fundingLossExit,undefined,
    'ordinary equal-lot assessment must still refuse this real six-coin mismatch');
  near(a.expectedFundingUsd,-(3670+3664)*.03*.01);near(a.expectedFundingBps,-200);
  assert.equal(a.fundingSchedule.events[0].longUsd,-3670*.03*.01);
  assert.equal(a.fundingSchedule.events[0].shortUsd,-3664*.03*.01);
  near(loss.expectedFundingLossUsd,(10+4)*.03*.01);
  near(loss.reductionFundingSchedule.events[0].longUsd,-10*.03*.01);
  near(loss.reductionFundingSchedule.events[0].shortUsd,-4*.03*.01);
  assert.notEqual(loss.expectedFundingLossUsd,(10+10)*.03*.01,'the original short six cannot be charged again');
  assert.equal(loss.longReduction,10);assert.equal(loss.shortReduction,4);assert.equal(loss.makerLeg,'short');
  near(loss.longClosingFeeUsd,10*.02999*.0005);near(loss.shortClosingFeeUsd,4*.03001*.0005);
  near(loss.longSpreadCostUsd,10*.00001);near(loss.shortSpreadCostUsd,4*.00001);
  near(loss.minimumSavingsUsd,.1*Math.max(10/3670,4/3664));assert.equal(loss.paymentWindowOpen,true);
  assert.equal(JSON.stringify({p:f.p,long:f.long,short:f.short,orders:f.orders}),before);
});
test('the reverse finer-long/coarser-short four/ten case uses each real quantity and the larger margin ratio',()=>{
  const f=fixture();f.p.long.quantity=3664;f.p.short.quantity=3670;
  f.long.quantityStep=f.long.minQuantity=1;f.short.quantityStep=f.short.minQuantity=10;
  const a=f.assess(4,10)!,loss=cost(f,4,10);assert.equal(a.passes,true);assert.equal(loss.makerLeg,'long');
  near(a.expectedFundingUsd,-(3664+3670)*.03*.01);
  near(loss.expectedFundingLossUsd,(4+10)*.03*.01);
  near(loss.longClosingFeeUsd,4*.02999*.0005);near(loss.shortClosingFeeUsd,10*.03001*.0005);
  near(loss.minimumSavingsUsd,.1*Math.max(4/3664,10/3670));
});
test('a terminal two-coin partial leaves only ten/two future reductions, without reusing the earlier two',()=>{
  const f=fixture();f.augmentation(4,2);const a=f.assess(10,2)!,loss=cost(f,10,2);
  assert.equal(a.passes,true);assert.equal(f.p.short.quantity,3662);
  near(a.expectedFundingUsd,-(3670+3662)*.03*.01);near(loss.expectedFundingLossUsd,(10+2)*.03*.01);
  near(loss.shortClosingFeeUsd,2*.03001*.0005);assert.equal(loss.shortReduction,2);
});
test('only the paying leg contributes avoided funding while both new reductions retain costs',()=>{
  for(const payer of ['long','short'] as const){
    const f=fixture();f.long.fundingRate=payer==='long'?.01:0;f.short.fundingRate=payer==='short'?-.01:0;
    const a=f.assess()!,loss=cost(f);assert.equal(a.passes,true,payer);
    near(loss.expectedFundingLossUsd,(payer==='long'?10:4)*.03*.01);
    assert.ok(loss.longClosingFeeUsd>0&&loss.shortClosingFeeUsd>0);
    assert.equal(a.fundingSchedule.events[0][payer==='long'?'shortUsd':'longUsd'],0);
  }
});
test('signed negative funding rates distinguish a long receipt from a short payment',()=>{
  const f=fixture();f.long.fundingRate=-.002;f.short.fundingRate=-.02;
  const a=f.assess()!,loss=cost(f);assert.equal(a.passes,true);
  near(loss.expectedFundingLossUsd,4*.03*.02-10*.03*.002);
  assert.ok(loss.reductionFundingSchedule.events[0].longUsd>0);
  assert.ok(loss.reductionFundingSchedule.events[0].shortUsd<0);
});
test('negative full carry and negative new-reduction carry are both necessary',()=>{
  const subsetReceipt=fixture();subsetReceipt.long.fundingRate=-.009;subsetReceipt.short.fundingRate=-.01;
  const first=subsetReceipt.assess()!;assert.ok(first.expectedFundingUsd<0);assert.equal(first.passes,false);
  assert.equal(first.fundingLossExit,undefined);
  const fullReceipt=fixture();fullReceipt.long.fundingRate=.01;fullReceipt.short.fundingRate=.0101;
  const second=fullReceipt.assess()!;assert.ok(second.expectedFundingUsd>0);assert.equal(second.passes,false);
  assert.equal(second.fundingLossExit,undefined);
});
test('sunk actual opening costs, funding and realized losses never become marginal future holding costs',()=>{
  const f=fixture(),original=cost(f);f.p.feesUsd=200;f.p.long.feesUsd=f.p.short.feesUsd=100;
  f.p.fundingUsd=-100;f.p.realizedSpreadPnlUsd=-300;f.p.transferCostUsd=50;
  f.p.long.entryPrice=.09;f.p.short.entryPrice=.01;
  const a=f.assess()!;assert.ok(a.profit!.netPnlUsd<-600);assert.equal(a.passes,true);
  assert.deepEqual(a.fundingLossExit,original);
});
test('fresh higher-than-Taker Maker expense on the finer leg can veto a previously worthwhile loss exit',()=>{
  const f=fixture();f.long.fundingRate=0;f.short.fundingRate=-.006;assert.equal(f.assess()!.passes,true);
  f.short.makerFeeRate=.005;const a=f.assess()!,loss=cost(f);
  assert.equal(a.passes,false);near(loss.shortGrossFeeRate,.005);near(loss.shortClosingFeeUsd,4*.03001*.005);
  assert.ok(loss.expectedSavingsUsd<loss.minimumSavingsUsd);
});
test('the reverse finer leg also uses its real Maker expense while the coarse leg does not require Maker evidence',()=>{
  const f=fixture();f.p.long.quantity=3664;f.p.short.quantity=3670;f.long.quantityStep=f.long.minQuantity=1;
  f.short.quantityStep=f.short.minQuantity=10;f.long.makerFeeRate=.004;delete f.short.makerFeeRate;
  const a=f.assess(4,10)!,loss=cost(f,4,10);assert.equal(a.passes,true);
  near(loss.longGrossFeeRate,.004);near(loss.longClosingFeeUsd,4*.02999*.004);near(loss.shortGrossFeeRate,.0005);
});
test('known negative Maker rebates cannot subsidize this conservative new-risk cost allowance',()=>{
  const f=fixture(),initial=cost(f);f.short.makerFeeRate=-.001;
  const loss=cost(f);near(loss.shortGrossFeeRate,.0005);near(loss.closingFeesUsd,initial.closingFeesUsd);
});
test('current configured positive fee rebates affect estimated costs without changing booked cash',()=>{
  const f=fixture(),before=structuredClone(f.p),original=cost(f);f.config.feeRebatePct={gate:70};
  const loss=cost(f);near(loss.longEffectiveFeeRate,.0005*.3);near(loss.longClosingFeeUsd,original.longClosingFeeUsd*.3);
  near(loss.shortClosingFeeUsd,original.shortClosingFeeUsd);assert.deepEqual(f.p,before);
});
test('reference-only discovery never substitutes missing native Taker or finer Maker evidence for actual permission',()=>{
  const f=fixture();delete f.long.takerFeeRate;delete f.short.takerFeeRate;delete f.short.makerFeeRate;
  assert.equal(f.assess(),undefined);const reference=f.assess(10,4,false);assert.equal(reference?.passes,true);
  f.config.feeRebatePct={gate:100,bybit:100};assert.equal(f.assess(),undefined);
});
test('observed expensive Maker fees also remain conservative during reference discovery',()=>{
  const f=fixture();f.short.makerFeeRate=.005;const native=cost(f),reference=f.assess(10,4,false)!;
  assert.deepEqual(reference.fundingLossExit,native);
});
test('payment qualification keeps the five-minute boundary and rejects stale settlement clocks',()=>{
  for(const delay of [300_000,300_001]){
    const f=fixture();f.long.nextFundingTime=f.short.nextFundingTime=f.now+delay;
    const a=f.assess()!;assert.equal(a.passes,delay===300_000);assert.equal(a.fundingLossExit!.paymentWindowOpen,delay===300_000);
  }
  const f=fixture();f.short.nextFundingTime=f.now;assert.equal(f.assess(),undefined);
});
test('an earlier actual receipt prevents new losing reductions despite repeated later negative carry',()=>{
  const f=fixture();f.long.fundingRate=.001;f.long.intervalHours=1;f.long.nextFundingTime=f.now+240_000+3_600_000;
  f.short.fundingRate=.0005;f.short.intervalHours=8;f.short.nextFundingTime=f.now+240_000;
  const a=f.assess()!;assert.ok(a.expectedFundingUsd<0);assert.ok(a.fundingSchedule.nextEventUsd>0);
  assert.ok(a.fundingLossExit!.expectedFundingLossUsd>0);assert.equal(a.fundingLossExit!.paymentWindowOpen,false);assert.equal(a.passes,false);
});
test('an earlier zero-cash event cannot be skipped to call a later payment imminent',()=>{
  const f=fixture();f.short.fundingRate=0;f.short.nextFundingTime=f.now+120_000;f.long.nextFundingTime=f.now+240_000;
  const a=f.assess()!;assert.equal(a.fundingSchedule.nextEventUsd,0);assert.equal(a.fundingLossExit!.paymentWindowOpen,false);
  assert.equal(a.passes,false);
});
test('a strict savings margin rejects equality and a low expected payment',()=>{
  const f=fixture();f.long.fundingRate=0;const allowance=cost(f);
  f.short.fundingRate=-(allowance.exitCostAllowanceUsd+allowance.minimumSavingsUsd)/(4*f.short.markPrice);
  assert.equal(f.assess()!.passes,false);f.short.fundingRate-=.000001;assert.equal(f.assess()!.passes,true);
  f.short.fundingRate=-.000001;assert.equal(f.assess()!.passes,false);
});

const invalid:Array<[string,(f:ReturnType<typeof fixture>)=>void]>=[
  ['unknown Taker fee',f=>{delete f.long.takerFeeRate;}],['negative Taker fee',f=>{f.short.takerFeeRate=-.001;}],
  ['non-native Taker source',f=>{delete f.short.takerFeeSource;}],['stale Taker fee',f=>{f.long.takerFeeAt=f.now-120_001;}],
  ['missing finer Maker fee',f=>{delete f.short.makerFeeRate;}],['stale finer Maker fee',f=>{f.short.makerFeeAt=f.now-120_001;}],
  ['unknown accrued funding cash',f=>{f.p.fundingUsd=NaN;}],['unknown paid fees',f=>{f.p.feesUsd=NaN;}],
  ['unknown actual realized cash',f=>{f.p.realizedSpreadPnlUsd=NaN;}],['unknown transfer cost',f=>{f.p.transferCostUsd=NaN;}],
  ['unverified old rebate evidence',f=>{f.p.estimatedFeeRebateUsd=null;}],
  ['missing due funding evidence',f=>{f.p.profitExitPolicy!.fundingChecks=[{exchange:'gate',timestamp:f.now-500}];delete f.p.long.lastFundingAt;}],
  ['stale execution quote',f=>{f.long.observedAt=f.now-f.config.maxSnapshotAgeMs-1;}],
  ['stale funding metadata',f=>{f.short.fundingObservedAt=f.now-30_001;}],
  ['crossed observed book',f=>{f.short.bids[0].price=.04;}],['empty executable quote',f=>{f.long.bids=[];}],
  ['unknown funding rate',f=>{f.long.fundingRate=NaN;}],['invalid settlement interval',f=>{f.short.intervalHours=0;}],
  ['unknown mark notional',f=>{f.long.markPrice=NaN;}],['foreign contract',f=>{f.short.symbol='OTHER/USDT:USDT';}],
  ['source mismatch',f=>{f.short.source='demo';}],['same amount steps',f=>{f.long.quantityStep=1;}],
  ['ordinary manual protection',f=>{f.p.manualCloseOnly=true;}],['synthetic account ledger',f=>{f.p.manualCloseAccountRecord=true;}],
  ['flat account archive',f=>{f.p.accountClosure={confirmedAt:f.now-1,reason:'flat',historicalOrdersPending:false};}],
  ['current once mode',f=>{f.config.holdMode='once';}],['current funding-only strategy',f=>{f.config.entryPolicy='funding';}],
];
for(const [name,mutate] of invalid)test(`new tail funding assessment refuses ${name}`,()=>{
  const f=fixture();mutate(f);assert.notEqual(f.assess()?.passes,true);
});
test('new quantities must be positive legal real reductions rather than a rounded or oversized common fiction',()=>{
  const f=fixture();for(const [long,short] of [[0,4],[10,0],[-10,4],[10,NaN],[6,4],[10,3.5],[3680,4],[10,3665]])
    assert.equal(f.assess(long,short),undefined,`${long}/${short}`);
});
test('a rolled prior settlement needs independently observed post-settlement quotes',()=>{
  const f=fixture();f.p.plannedExitAt=f.now-500+f.config.exitDelaySec*1000;
  f.long.observedAt=f.short.observedAt=f.now-600;assert.equal(f.assess(),undefined);
  f.long.observedAt=f.short.observedAt=f.now;assert.equal(f.assess()!.passes,true);
});
test('ordinary old entry policy is preserved while the global current aligned/adaptive exit rule supplies this assessment',()=>{
  const f=fixture();f.p.entryPolicy='dual';f.p.holdMode='once';const before=structuredClone(f.p);
  assert.equal(f.assess()!.passes,true);assert.deepEqual(f.p,before);
});
test('full actual funding identity matches the existing Tracker without inventing independent history',()=>{
  const f=fixture(),tracker=new FundingExitStabilityTracker();const first=f.assess()!;
  const original=tracker.evaluate(f.p,f.long,f.short,first,f.config,f.now);
  assert.equal(original.passes,false);assert.equal(original.status,'observing');assert.equal(original.sampleCount,1);
  const again=tracker.evaluate(f.p,f.long,f.short,first,f.config,f.now+100);
  assert.equal(again.sampleCount,1,'same native funding observation does not count again');
  for(const offset of [45_000,90_000,135_000,180_000]){
    const at=f.now+offset;for(const book of [f.long,f.short]){
      book.timestamp=book.observedAt=book.fundingObservedAt=at;book.takerFeeAt=book.makerFeeAt=at;
    }
    const a=f.assess(10,4,true,at)!;const evidence=tracker.evaluate(f.p,f.long,f.short,a,f.config,at);
    assert.equal(evidence.passes,offset===180_000);
    if(offset===180_000){assert.equal(evidence.status,'confirmed');assert.equal(evidence.sampleCount,5);assert.equal(evidence.observedSpanMs,180_000);}
  }
});
test('old funding/once originals use the current economic view for Tracker while their source policy stays unchanged',()=>{
  const f=fixture();f.p.entryPolicy='funding';f.p.holdMode='once';const tracker=new FundingExitStabilityTracker(),before=structuredClone(f.p);
  const first=f.assess()!;assert.equal(first.passes,true);
  assert.equal(tracker.evaluate(f.p,f.long,f.short,first,f.config,f.now).status,'unavailable',
    'the strict Tracker does not silently adopt a different original policy');
  for(const offset of [0,45_000,90_000,135_000,180_000]){
    const at=f.now+offset;for(const book of [f.long,f.short]){
      book.timestamp=book.observedAt=book.fundingObservedAt=at;book.takerFeeAt=book.makerFeeAt=at;
    }
    const a=f.assess(10,4,true,at)!;
    const view=currentExitStrategyPosition(f.p,f.config),evidence=tracker.evaluate(view,f.long,f.short,a,f.config,at);
    assert.equal(evidence.passes,offset===180_000);assert.notEqual(evidence.status,'unavailable');
  }
  assert.deepEqual(f.p,before);
});
test('projected negative carry keeps the full-real-holding ten-minute history and still waits for actual imminent payment',()=>{
  const f=fixture(),tracker=new FundingExitStabilityTracker();
  f.long.fundingRate=-.01;f.short.fundingRate=-.009;f.long.intervalHours=8;f.short.intervalHours=1;
  f.short.nextFundingTime=f.now+720_000;f.long.nextFundingTime=f.short.nextFundingTime+7*3_600_000;
  const first=f.assess()!;assert.ok(first.expectedFundingUsd<0);assert.equal(first.fundingSchedule.shortCount,8);
  assert.equal(first.passes,false);assert.equal(first.fundingLossExit!.paymentWindowOpen,false);
  for(let offset=0;offset<=600_000;offset+=60_000){
    const at=f.now+offset;for(const book of [f.long,f.short]){
      book.timestamp=book.observedAt=book.fundingObservedAt=at;book.takerFeeAt=book.makerFeeAt=at;
    }
    const a=f.assess(10,4,true,at)!;
    const evidence=tracker.evaluate(f.p,f.long,f.short,a,f.config,at);
    assert.equal(evidence.requiredSpanMs,600_000);assert.equal(evidence.passes,offset===600_000);
    if(offset===600_000){assert.equal(a.passes,true);assert.equal(evidence.status,'confirmed');
      assert.equal(evidence.sampleCount,11);near(a.fundingLossExit!.expectedFundingLossUsd,4*.03*.009*8-10*.03*.01);}
  }
});
