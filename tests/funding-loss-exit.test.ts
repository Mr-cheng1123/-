import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfig} from '../src/shared/config.js';
import type {ExchangeId,MarketSnapshot,Position} from '../src/shared/types.js';
import {assessAlignedExit,profitExitPolicy} from '../src/core/profit-exit.js';
import {evaluateHoldingDecision} from '../src/core/holding-decision.js';

const now=Date.UTC(2026,9,3,16,56),hour=3_600_000,config={...defaultConfig,entryPolicy:'aligned' as const};
function fixture(){
  const quote=(exchange:ExchangeId):MarketSnapshot=>({exchange,base:'SAND',symbol:'SAND/USDT:USDT',source:'public',
    timestamp:now,observedAt:now,fundingObservedAt:now,indexPrice:.075,markPrice:.075,
    fundingRate:exchange==='gate'?-.008437:-.001826,intervalHours:exchange==='gate'?8:1,
    nextFundingTime:now+(exchange==='gate'?7*hour+4*60_000:4*60_000),fundingHistory:[],
    bids:[{price:.07499,quantity:1332}],asks:[{price:.07501,quantity:1332}],
    quantityStep:1,minQuantity:1,minNotional:5,contractSize:1,openInterestUsd:1e6,volume24hUsd:1e6,
    takerFeeRate:exchange==='gate'?.0005:.0011,takerFeeAt:now,takerFeeSource:'exchange'});
  const long=quote('gate'),short=quote('bybit');
  const p:Position={id:'sand-cost-exit',base:'SAND',mode:'live',entryPolicy:'aligned',holdMode:'adaptive',status:'open',
    openedAt:now-1000,plannedExitAt:long.nextFundingTime+config.exitDelaySec*1000,
    long:{exchange:'gate',symbol:long.symbol,side:'long',quantity:1332,entryPrice:.075,markPrice:.075,feesUsd:.05,liquidationDistancePct:null},
    short:{exchange:'bybit',symbol:short.symbol,side:'short',quantity:1332,entryPrice:.075,markPrice:.075,feesUsd:.05,liquidationDistancePct:null},
    feesUsd:.1,fundingUsd:-.03,transferCostUsd:0,realizedSpreadPnlUsd:0,spreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,
    fundingEvents:[],riskReasons:[],profitExitPolicy:profitExitPolicy(long,short,config)};
  return {p,long,short};
}
const assess=(f:ReturnType<typeof fixture>,at=now)=>assessAlignedExit(f.p,f.long,f.short,config,at)!;
const near=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-10,`${a} != ${b}`);

test('SAND-like eight payments offset the later receipt but still justify a controlled losing exit near payment',()=>{
  const f=fixture(),a=assess(f),cost=a.fundingLossExit!;
  assert.ok(a.profit!.netPnlUsd<-.31&&a.profit!.netPnlUsd>-.33);
  near(a.expectedFundingUsd,-.6164829);
  assert.equal(a.fundingSchedule.shortCount,8);assert.equal(a.fundingSchedule.longCount,1);
  assert.equal(cost.paymentWindowOpen,true);assert.equal(cost.quantity,1332);
  near(cost.spreadCostUsd,.02664);near(cost.minimumSavingsUsd,.1);
  assert.ok(cost.expectedSavingsUsd>.1);assert.equal(a.passes,true);assert.equal(a.exitSignal,'funding-loss');
  const raw=evaluateHoldingDecision(f.p,f.long,f.short,config,now);
  assert.equal(raw.action,'close');assert.equal(raw.exitSignal,'funding-loss');
  assert.match(raw.reason,/历史亏损不计入/);assert.match(raw.reason,/非确定收益/);
  assert.equal(f.p.fundingUsd,-.03,'No forecast may be booked as accrued cash');
});

test('large historical losses do not increase or remove the marginal remaining-exposure signal',()=>{
  const f=fixture(),initial=assess(f).fundingLossExit;
  f.p.feesUsd=200;f.p.fundingUsd=-100;f.p.realizedSpreadPnlUsd=-300;
  f.p.long.entryPrice=.09;f.p.short.entryPrice=.06;f.p.transferCostUsd=50;
  const changed=assess(f);assert.ok(changed.profit!.netPnlUsd<-600);
  assert.equal(changed.passes,true);assert.deepEqual(changed.fundingLossExit,initial);
});

test('accepting a loss waits for the actual payment window, including directly adverse next rates',()=>{
  for(const direct of [false,true]){
    const f=fixture();f.short.nextFundingTime=now+300_001;
    f.long.nextFundingTime=f.short.nextFundingTime+7*hour;
    if(direct)f.long.fundingRate=0;
    const outside=assess(f);assert.ok(outside.fundingLossExit!.expectedSavingsUsd>.1);
    assert.equal(outside.passes,false);assert.equal(outside.fundingLossExit!.paymentWindowOpen,false);
    f.short.nextFundingTime--;f.long.nextFundingTime--;
    assert.equal(assess(f).passes,true,'Exactly five minutes is allowed');
  }
});

test('an earlier actual receipt prevents a losing exit even when repeated future rates make the window negative',()=>{
  const f=fixture();f.long.fundingRate=.001;
  f.long.nextFundingTime=now+4*60_000+hour;f.long.intervalHours=1;
  f.short.fundingRate=.0003;f.short.intervalHours=8;f.short.nextFundingTime=now+4*60_000;
  const a=assess(f);assert.ok(a.expectedFundingUsd<0);assert.ok(a.fundingSchedule.nextEventUsd>0);
  assert.equal(a.fundingLossExit!.paymentWindowOpen,false);assert.equal(a.passes,false);
});

test('weak funding, zero funding and positive full-window funding retain the current hedge',()=>{
  for(const rate of [0,-.0002,.0002]){
    const f=fixture();f.long.fundingRate=0;f.short.fundingRate=rate;
    f.long.nextFundingTime=f.short.nextFundingTime;
    const a=assess(f);assert.equal(a.passes,false);assert.equal(a.exitSignal,undefined);
    if(rate<0)assert.ok(a.fundingLossExit!.expectedSavingsUsd<a.fundingLossExit!.minimumSavingsUsd);
  }
});

test('batch funding, allowance and margin all scale to the actual legal common quantity',()=>{
  const f=fixture(),full=assess(f).fundingLossExit!;
  f.long.bids[0].quantity=333;f.short.asks[0].quantity=333;
  const thin=assess(f);assert.equal(thin.fundingLossExit!.quantity,333);
  for(const key of ['expectedFundingLossUsd','closingFeesUsd','spreadCostUsd','minimumSavingsUsd','expectedSavingsUsd'] as const)
    near(thin.fundingLossExit![key],full[key]/4);
  assert.equal(thin.passes,true);
  const concrete=assessAlignedExit(f.p,f.long,f.short,config,now,false,
    {longPrice:.07499,shortPrice:.07501},{pricing:'best-opposite',batchQuantity:111})!;
  assert.equal(concrete.fundingLossExit!.quantity,111);near(concrete.fundingLossExit!.expectedFundingLossUsd,full.expectedFundingLossUsd/12);
  assert.equal(assessAlignedExit(f.p,f.long,f.short,config,now,false,undefined,{pricing:'best-opposite',batchQuantity:334})!.passes,false);
});

test('actual permitted IOC limits and updated native fees can cancel the cost advantage',()=>{
  const f=fixture();assert.equal(assess(f).passes,true);
  const expensive=assessAlignedExit(f.p,f.long,f.short,config,now,false,
    {longPrice:.074,shortPrice:.076},{pricing:'best-opposite',batchQuantity:333})!;
  assert.equal(expensive.passes,false);assert.ok(expensive.fundingLossExit!.spreadCostUsd>.6);
  f.long.takerFeeRate=f.short.takerFeeRate=.004;
  assert.equal(assess(f).passes,false);
});

test('the cost allowance requires a strict saving above the margin',()=>{
  const f=fixture();f.long.fundingRate=0;f.long.nextFundingTime=f.short.nextFundingTime;
  const cost=assess(f).fundingLossExit!;
  f.short.fundingRate=-(cost.exitCostAllowanceUsd+.1)/(1332*.075);
  assert.equal(assess(f).passes,false,'Equality must not authorize an automatic losing exit');
  f.short.fundingRate-=.000001;
  assert.equal(assess(f).passes,true);
});

test('unknown accrued funding, missing fee evidence and invalid books cannot authorize loss exits',()=>{
  for(const change of ['funding','fee','stale','crossed','empty','quantity']){
    const f=fixture();
    if(change==='funding'){f.p.openedAt=now-hour;f.p.profitExitPolicy!.fundingChecks[0].timestamp=now-60_000;}
    if(change==='fee')f.long.takerFeeSource=undefined;
    if(change==='stale')f.short.observedAt=now-config.maxSnapshotAgeMs-1;
    if(change==='crossed')f.long.bids[0].price=.076;
    if(change==='empty')f.long.bids=[];
    if(change==='quantity')f.p.short.quantity--;
    assert.notEqual(assessAlignedExit(f.p,f.long,f.short,config,now)?.passes,true,change);
  }
});

test('the new cost-based signal is confined to aligned adaptive positions',()=>{
  for(const holdMode of ['once','continuous'] as const){const f=fixture();f.p.holdMode=holdMode;assert.equal(assess(f).passes,false);}
  const f=fixture();f.p.entryPolicy='dual';assert.equal(assessAlignedExit(f.p,f.long,f.short,config,now),undefined);
});
