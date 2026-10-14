import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfig,validateConfig} from '../src/shared/config.js';
import type {AppConfig,ExchangeId,JournalOrder,MarketSnapshot,Position} from '../src/shared/types.js';
import {effectiveFeeRate,estimateFeeRebateUsd,estimatedPositionFeeRebateUsd,feeRebateBreakdown,feeRebatePct} from '../src/shared/fee-rebates.js';
import {nativeMakerFeeRate,nativeTakerFeeRate,takerFeeRate} from '../src/shared/trading-fees.js';
import {estimateAlignedEntryFees,assessFundingCarry} from '../src/core/funding-carry.js';
import {calculateOpportunities} from '../src/core/strategy.js';
import {assessBestOppositeProfitExit,alignedExitProfitsPass} from '../src/core/profit-exit.js';
import {evaluateHoldingDecision} from '../src/core/holding-decision.js';
import {canRestConfirmedMakerClose,planMakerClose} from '../src/core/maker-close-plan.js';
import {calculateFundingCandidates} from '../src/shared/funding-opportunities.js';
import type {FundingStatsCell,FundingStatsDataset} from '../src/shared/funding-statistics.js';

const now=1_791_618_000_000;
const config:AppConfig={...defaultConfig,mode:'live',entryPolicy:'aligned',holdMode:'adaptive',orderNotionalUsd:100,
  feeRebatePct:{gate:70,bitget:50},minExitProfitBps:10,minEntryIocEdgeBps:20};
const near=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-10,`${actual} != ${expected}`);
function quote(exchange:ExchangeId,changes:Partial<MarketSnapshot>={}):MarketSnapshot {
  return {exchange,base:'BTC',symbol:'BTC/USDT:USDT',timestamp:now,observedAt:now,source:'public',
    markPrice:100,indexPrice:100,fundingRate:exchange==='bitget'?.005:0,nextFundingTime:now+60_000,intervalHours:8,
    bids:[{price:exchange==='gate'?100.2:100,quantity:20}],asks:[{price:exchange==='gate'?100.8:100.1,quantity:20}],
    fundingHistory:[],quantityStep:.001,minQuantity:.001,minNotional:1,contractSize:1,openInterestUsd:1e9,volume24hUsd:1e9,
    makerFeeRate:.0002,makerFeeAt:now,makerFeeSource:'exchange',takerFeeRate:exchange==='gate'?.0005:.0006,
    takerFeeAt:now,takerFeeSource:'exchange',...changes};
}
function position():Position {
  return {id:'rebate-offline',base:'BTC',mode:'live',status:'open',entryPolicy:'aligned',holdMode:'adaptive',
    long:{exchange:'gate',symbol:'BTC/USDT:USDT',side:'long',quantity:1,entryPrice:100,markPrice:100,feesUsd:.05,liquidationDistancePct:null},
    short:{exchange:'bitget',symbol:'BTC/USDT:USDT',side:'short',quantity:1,entryPrice:100,markPrice:100,feesUsd:.06,liquidationDistancePct:null},
    openedAt:now-1000,plannedExitAt:now+70_000,profitExitNotionalUsd:100,fundingUsd:0,feesUsd:.11,transferCostUsd:0,
    realizedSpreadPnlUsd:.15,spreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[],
    profitExitPolicy:{firstFundingTime:now+60_000,earliestExitAt:now+70_000,minSpreadNetUsd:0,minCombinedNetUsd:0,
      fundingChecks:[{exchange:'gate',timestamp:now+60_000},{exchange:'bitget',timestamp:now+60_000}]}};
}

test('Gate70 and Bitget50 reduce only positive cost and retain native negative Maker rebates',()=>{
  near(effectiveFeeRate('gate',.0005,config)!, .00015);near(effectiveFeeRate('bitget',.0006,config)!, .0003);
  assert.equal(effectiveFeeRate('gate',-.0001,config),-.0001);assert.equal(estimateFeeRebateUsd('gate',-.01,config),0);
  assert.deepEqual(feeRebateBreakdown('gate',1,config),{grossFeesUsd:1,estimatedFeeRebateUsd:.7,effectiveFeesUsd:.30000000000000004});
  assert.equal(feeRebatePct('bybit',config),0);assert.equal(effectiveFeeRate('bybit',.00055,config),.00055);
});

test('missing rebates preserve previous economics and invalid config is rejected without adding legacy fields',()=>{
  const legacy=validateConfig(defaultConfig);assert.equal('feeRebatePct' in legacy,false);
  const accepted=validateConfig({...defaultConfig,feeRebatePct:{gate:70,bitget:50}});
  assert.deepEqual(accepted.feeRebatePct,{gate:70,bitget:50});assert.equal(effectiveFeeRate('gate',.0005,legacy),.0005);
  for(const rate of [-1,101,NaN,Infinity,'70'])assert.throws(()=>validateConfig({...defaultConfig,feeRebatePct:{gate:rate}}));
  assert.throws(()=>validateConfig({...defaultConfig,feeRebatePct:{unknown:70}}));
  assert.equal(feeRebatePct('gate',{feeRebatePct:{gate:NaN}}),0);
});

test('a configured100 percent rebate cannot create known fees from absent or malformed evidence',()=>{
  const full={...config,feeRebatePct:{gate:100,bitget:100}};
  for(const rate of [undefined,NaN,Infinity])assert.equal(effectiveFeeRate('gate',rate,full),undefined);
  assert.ok(Number.isNaN(estimateFeeRebateUsd('gate',NaN,full)));
  const p=position(),long=quote('gate',{takerFeeRate:undefined});
  assert.equal(assessBestOppositeProfitExit(p,long,quote('bitget'),full,now),undefined);
  assert.ok(Number.isNaN(estimateAlignedEntryFees(long,quote('bitget'),1,full,{now})));
  assert.equal(planMakerClose(p,quote('gate',{makerFeeRate:undefined}),quote('bitget'),full,now),undefined);
});

test('adjusted costs follow a validated source without changing native rates or freshness',()=>{
  const long=quote('gate'),short=quote('bitget'),before=structuredClone([long,short]);
  near(estimateAlignedEntryFees(long,short,1,config,{now}),.09);
  assert.equal(nativeTakerFeeRate(long,now),.0005);assert.equal(nativeMakerFeeRate(long,now),.0002);
  assert.equal(takerFeeRate(long,config,now),.0005);assert.deepEqual([long,short],before);
  long.takerFeeAt=now-120_001;
  assert.ok(Number.isNaN(estimateAlignedEntryFees(long,short,1,config,{now})));
  assert.ok(Number.isFinite(estimateAlignedEntryFees(long,short,1,config,{now,requireNativeFees:false})),
    'local preview may retain gross reference evidence without granting execution permission');
});

test('best-opposite trigger applies booked and remaining rebate once while preserving real cash and10bps',()=>{
  const p=position(),long=quote('gate'),short=quote('bitget'),before=structuredClone({p,long,short});
  const gross=assessBestOppositeProfitExit(p,long,short,{...config,feeRebatePct:undefined},now)!;
  const adjusted=assessBestOppositeProfitExit(p,long,short,config,now)!;
  assert.equal(alignedExitProfitsPass(p,gross,config),false);assert.equal(alignedExitProfitsPass(p,adjusted,config),true);
  near(adjusted.bookedFeeRebateUsd!,.065);near(adjusted.grossClosingFeesUsd!,100.2*.0005+100.1*.0006);
  near(adjusted.closingFeesUsd,100.2*.00015+100.1*.0003);
  near(adjusted.estimatedFeeRebateUsd!,.065+100.2*.0005*.7+100.1*.0006*.5);
  near(adjusted.netPnlUsd,gross.netPnlUsd+adjusted.estimatedFeeRebateUsd!);
  assert.deepEqual({p,long,short},before);assert.equal(p.profitExitNotionalUsd,100);assert.equal(p.feesUsd,.11);assert.equal(p.netPnlUsd,0);
  const holding=evaluateHoldingDecision(p,long,short,config,now);
  assert.equal(holding.action,'close');assert.equal(holding.exitSignal,'profit');
  near(holding.exitProfit!.estimatedFeeRebateUsd!,adjusted.estimatedFeeRebateUsd!);
});

test('same-price partial close moves paid fees and rebates without counting savings twice',()=>{
  const p=position(),long=quote('gate'),short=quote('bitget');
  const before=assessBestOppositeProfitExit(p,long,short,config,now)!;
  p.long.quantity=p.short.quantity=.9;
  p.long.feesUsd+=.1*100.2*.0005;p.short.feesUsd+=.1*100.1*.0006;p.feesUsd=p.long.feesUsd+p.short.feesUsd;
  p.realizedSpreadPnlUsd+=.1*(100.2-p.long.entryPrice)+.1*(p.short.entryPrice-100.1);
  const after=assessBestOppositeProfitExit(p,long,short,config,now)!;
  near(after.grossTotalFeesUsd!,before.grossTotalFeesUsd!);near(after.totalFeesUsd,before.totalFeesUsd);
  near(after.estimatedFeeRebateUsd!,before.estimatedFeeRebateUsd!);near(after.netPnlUsd,before.netPnlUsd);
  near(p.profitExitNotionalUsd!,100);
});

test('complete positive-order projection overrides net leg fallback and unknown projection prevents permission',()=>{
  const p=position();p.long.feesUsd=-.01;p.feesUsd=p.long.feesUsd+p.short.feesUsd;
  near(estimatedPositionFeeRebateUsd(p,config)!, .03);
  p.estimatedFeeRebateUsd=.065;near(estimatedPositionFeeRebateUsd(p,config)!, .065);
  const adjusted=assessBestOppositeProfitExit(p,quote('gate'),quote('bitget'),config,now)!;
  near(adjusted.bookedFeeRebateUsd!,.065);
  for(const projection of [null,NaN,Infinity,-.01]){
    p.estimatedFeeRebateUsd=projection;
    assert.equal(estimatedPositionFeeRebateUsd(p,config),undefined);
    assert.equal(assessBestOppositeProfitExit(p,quote('gate'),quote('bitget'),config,now),undefined);
    assert.equal(planMakerClose(p,quote('gate'),quote('bitget'),config,now),undefined);
  }
});

test('Maker economics use adjusted positive costs while fee fields and negative native rates remain gross',()=>{
  const p=position(),long=quote('gate'),short=quote('bitget'),before=structuredClone({p,long,short});
  const plan=planMakerClose(p,long,short,config,now)!;
  assert.equal(plan.makerFeeRate,.0002);assert.equal(plan.takerFeeRate,.0006);assert.equal(plan.feeSource,'native');
  near(plan.profit.closingFeesUsd,100.8*.0002*.3+100.1*.0006*.5);
  near(plan.profit.grossClosingFeesUsd!,100.8*.0002+100.1*.0006);
  assert.deepEqual({p,long,short},before);
  long.makerFeeRate=-.0001;
  const nativeRebate=planMakerClose(p,long,short,config,now)!;
  near(nativeRebate.profit.closingFeesUsd,-100.8*.0001+100.1*.0006*.5);
  near(nativeRebate.profit.estimatedFeeRebateUsd!,.065+100.1*.0006*.5);
  assert.equal(nativeRebate.makerFeeRate,-.0001);
});

test('a verified active sublot Maker keeps the same rebate economics and needs both current native fees',()=>{
  const p=position(),long=quote('gate',{quantityStep:.1,minQuantity:.1}),short=quote('bitget',{quantityStep:.2,minQuantity:.2});
  p.long.quantity=.9;p.long.feesUsd+=.1*100.8*.0002;p.feesUsd=p.long.feesUsd+p.short.feesUsd;
  p.realizedSpreadPnlUsd=.16;p.closeProfitRequired=true;
  const journal:JournalOrder={positionId:p.id,exchange:'gate',createdAt:now-100,
    request:{clientOrderId:'known-active-maker',base:'BTC',symbol:'BTC/USDT:USDT',side:'sell',quantity:.2,limitPrice:100.8,reduceOnly:true,postOnly:true},
    result:{id:'known-native-id',clientOrderId:'known-active-maker',status:'unknown',filledQuantity:.1,averagePrice:100.8,averagePriceVerified:true,
      feeUsd:.1*100.8*.0002,timestamp:now-50},
    makerReduction:{activity:'active',makerLeg:'long',deadlineAt:now+5000,quantityStep:.1,bookedExecution:true}};
  const before=structuredClone({p,long,short,journal});
  assert.equal(canRestConfirmedMakerClose(p,journal,long,short,{...config,feeRebatePct:undefined},now),false);
  assert.equal(canRestConfirmedMakerClose(p,journal,long,short,config,now),true);
  assert.deepEqual({p,long,short,journal},before);
  assert.equal(canRestConfirmedMakerClose({...p,estimatedFeeRebateUsd:null},journal,long,short,config,now),false);
  assert.equal(canRestConfirmedMakerClose(p,journal,{...long,takerFeeAt:now-120_001},short,
    {...config,feeRebatePct:{gate:100,bitget:100}},now),false);
});

test('pure funding and opportunity estimates agree on four adjusted fees without changing gross snapshots',()=>{
  const long=quote('gate',{bids:[{price:100,quantity:20}],asks:[{price:100,quantity:20}]}),
    short=quote('bitget',{bids:[{price:100,quantity:20}],asks:[{price:100,quantity:20}]}),before=structuredClone([long,short]);
  const carry=assessFundingCarry(long,short,1,config,now);near(carry.feesUsd,.09);near(carry.limitFeesUsd,.09);
  const row=calculateOpportunities([long,short],config,now).find(o=>o.longExchange==='gate')!;
  near(row.feesUsd,.09);near(row.fundingAfterFeesUsd!,.5-.09);assert.equal(row.feesSource,'exchange');
  assert.deepEqual([long,short],before);
});

test('public statistical calculations apply configured rebates to reference fees without native fetching',()=>{
  const cell=(exchange:ExchangeId,rate:number):FundingStatsCell=>({exchange,rate,intervalHours:8,
    nextFundingTime:now+60_000,updatedAt:now,timestampKind:'received',available:true});
  const dataset:FundingStatsDataset={source:'exchanges',range:'current',status:'ready',rows:[{base:'BTC',cells:{gate:cell('gate',0),bitget:cell('bitget',.005)}}],
    receivedAt:now,lastAttemptAt:now,nextRefreshAt:now+20_000,maxAgeMs:120_000,sourceUrl:'https://example.test',marginScope:'USDT'};
  const before=structuredClone(dataset),[row]=calculateFundingCandidates(dataset,config,now);
  assert.equal(row.feesSource,'reference');near(row.feesUsd,.09);near(row.afterFeesUsd,.41);
  assert.deepEqual(dataset,before);
  const [unknown]=calculateFundingCandidates({...dataset,rows:[{base:'BTC',cells:{gate:cell('gate',0),okx:cell('okx',.005)}}]},
    {...config,exchanges:['gate','okx'],feeRebatePct:{gate:100,okx:100}},now);
  assert.equal(unknown.feesSource,'pending');assert.ok(Number.isNaN(unknown.feesUsd));assert.ok(Number.isNaN(unknown.afterFeesUsd));
});
