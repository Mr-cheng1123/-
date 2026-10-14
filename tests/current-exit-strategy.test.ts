import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfig} from '../src/shared/config.js';
import type {AppConfig,ExchangeId,MarketSnapshot,Position} from '../src/shared/types.js';
import {currentExitStrategyPosition,usesCurrentExitStrategy} from '../src/shared/current-exit-strategy.js';
import {evaluateHoldingDecision} from '../src/core/holding-decision.js';
import {alignedExitProfitsPass,assessAlignedExit,assessBestOppositeProfitExit} from '../src/core/profit-exit.js';
import {exitProfitThresholdUsd} from '../src/core/exit-profit-threshold.js';

const now=2_000_000_000_000,symbol='BTC/USDT:USDT';
const config:AppConfig={...structuredClone(defaultConfig),mode:'live',dataSource:'public',entryPolicy:'aligned',holdMode:'adaptive',minExitProfitBps:10};
function position():Position {
  return {id:'ORIGINAL-LEGACY-STRATEGY',base:'BTC',mode:'live',status:'open',entryPolicy:'funding',holdMode:'once',
    openedAt:now-1000,plannedExitAt:now+3_600_000,profitExitNotionalUsd:100,
    long:{exchange:'gate',symbol,side:'long',quantity:1,entryPrice:100,markPrice:1,feesUsd:.05,liquidationDistancePct:null,
      fundingObservedSince:now-1000,fundingObservedAt:now},
    short:{exchange:'bybit',symbol,side:'short',quantity:1,entryPrice:100,markPrice:1000,feesUsd:.05,liquidationDistancePct:null,
      fundingObservedSince:now-1000,fundingObservedAt:now},
    profitExitPolicy:{firstFundingTime:now+1_800_000,earliestExitAt:now+3_600_000,minCombinedNetUsd:999,minSpreadNetUsd:999,
      fundingChecks:[{exchange:'gate',timestamp:now+1_800_000},{exchange:'bybit',timestamp:now+1_800_000}]},
    fundingUsd:0,feesUsd:.1,transferCostUsd:0,spreadPnlUsd:-999,realizedSpreadPnlUsd:0,netPnlUsd:-999,deltaUsd:0,
    fundingEvents:[],riskReasons:[]};
}
function quote(exchange:ExchangeId):MarketSnapshot {
  const long=exchange==='gate';
  return {exchange,base:'BTC',symbol,source:'public',timestamp:now,observedAt:now,fundingObservedAt:now,
    markPrice:100,indexPrice:100,fundingRate:long?0:.001,nextFundingTime:now+1_800_000,intervalHours:1,fundingHistory:[],
    bids:[{price:long?101:100,quantity:10}],asks:[{price:long?101.01:100.01,quantity:10}],quantityStep:.001,minQuantity:.001,
    minNotional:5,contractSize:1,openInterestUsd:1e8,volume24hUsd:1e8,bookTransport:'websocket',feeProfile:'standard',
    takerFeeRate:long?.0005:.00055,takerFeeSource:'exchange',takerFeeAt:now};
}

test('the current exit projection preserves historical entry policy, original leg identity, cash, clocks and frozen principal',()=>{
  const p=position(),before=structuredClone(p),view=currentExitStrategyPosition(p,config);
  assert.equal(usesCurrentExitStrategy(p,config),true);assert.notEqual(view,p);
  assert.equal(view.entryPolicy,'aligned');assert.equal(view.holdMode,'adaptive');assert.equal(view.id,p.id);
  assert.equal(view.long,p.long);assert.equal(view.short,p.short);assert.equal(view.profitExitPolicy,p.profitExitPolicy);
  assert.equal(view.profitExitNotionalUsd,100);assert.deepEqual(p,before);
  assert.equal(currentExitStrategyPosition(view,config),view,'an already current view does not accumulate copies');
});

test('every ordinary legacy entry and hold mode qualifies immediately on current opposite-price net profit',()=>{
  for(const entryPolicy of [undefined,'funding','dual','aligned'] as const)for(const holdMode of ['once','continuous','adaptive'] as const){
    const p=position();p.entryPolicy=entryPolicy;p.holdMode=holdMode;const before=structuredClone(p);
    const profit=assessBestOppositeProfitExit(p,quote('gate'),quote('bybit'),config,now);
    assert.ok(profit,`${entryPolicy}/${holdMode}`);assert.equal(alignedExitProfitsPass(p,profit,config),true);
    const decision=evaluateHoldingDecision(p,quote('gate'),quote('bybit'),config,now);
    assert.equal(decision.action,'close');assert.equal(decision.exitSignal,'profit');
    assert.equal(assessAlignedExit(p,quote('gate'),quote('bybit'),config,now)?.exitSignal,'profit');
    assert.deepEqual(p,before,'valuation must not migrate original entry records or real cash');
  }
});

test('current exit routing follows explicit global strategy changes instead of overriding future once, continuous or legacy settings',()=>{
  for(const change of [{entryPolicy:'dual' as const},{entryPolicy:'funding' as const},{holdMode:'once' as const},{holdMode:'continuous' as const}]){
    const c={...config,...change},p=position();assert.equal(usesCurrentExitStrategy(p,c),false);
    assert.equal(currentExitStrategyPosition(p,c),p);assert.equal(assessBestOppositeProfitExit(p,quote('gate'),quote('bybit'),c,now),undefined);
    assert.equal(alignedExitProfitsPass(p,{spreadPnlUsd:1,totalFeesUsd:0,fundingAfterFeesUsd:0,spreadAfterFeesUsd:1,netPnlUsd:1},c),false);
  }
});

test('manual reductions, imported account records and archived account closures never acquire normal strategy management',()=>{
  for(const flag of [{manualCloseOnly:true},{manualCloseAccountRecord:true},{accountClosure:{confirmedAt:now,reason:'Verified account archive',historicalOrdersPending:true}}]){
    const p={...position(),...flag};assert.equal(usesCurrentExitStrategy(p,config),false);assert.equal(currentExitStrategyPosition(p,config),p);
    assert.equal(assessBestOppositeProfitExit(p,quote('gate'),quote('bybit'),config,now),undefined);
  }
});

test('an original due funding check stays binding when the current public settlement clock has moved onward',()=>{
  const p=position(),due=now-500;p.profitExitPolicy!.fundingChecks=[{exchange:'bybit',timestamp:due}];
  p.short.fundingObservedAt=due-1;
  assert.equal(assessBestOppositeProfitExit(p,quote('gate'),quote('bybit'),config,now),undefined);
  assert.notEqual(evaluateHoldingDecision(p,quote('gate'),quote('bybit'),config,now).exitSignal,'profit');
  p.short.lastFundingAt=due;assert.ok(assessBestOppositeProfitExit(p,quote('gate'),quote('bybit'),config,now));
  assert.equal(p.profitExitPolicy!.fundingChecks[0].timestamp,due,'projection cannot replace an unpaid original event with a new future clock');
});

test('old positions without a saved exit policy need a complete real billing read on both legs before any profit qualification',()=>{
  const p=position();delete p.profitExitPolicy;const before=structuredClone(p);
  assert.ok(assessBestOppositeProfitExit(p,quote('gate'),quote('bybit'),config,now));
  assert.equal(evaluateHoldingDecision(p,quote('gate'),quote('bybit'),config,now).exitSignal,'profit');assert.deepEqual(p,before);
  for(const missing of ['fundingObservedAt','fundingObservedSince'] as const){
    const incomplete=structuredClone(p);delete incomplete.short[missing];
    assert.equal(assessBestOppositeProfitExit(incomplete,quote('gate'),quote('bybit'),config,now),undefined,missing);
  }
  const truncated=structuredClone(p);truncated.short.fundingObservedSince=p.openedAt+1;
  assert.equal(assessBestOppositeProfitExit(truncated,quote('gate'),quote('bybit'),config,now),undefined);
});

test('missing legacy policy cannot hide a due settlement behind a partial or too-early billing observation',()=>{
  const p=position();delete p.profitExitPolicy;p.openedAt=now-3_600_000;
  for(const leg of [p.long,p.short])leg.fundingObservedSince=p.openedAt;
  const long=quote('gate'),short=quote('bybit'),event=now-500;
  long.nextFundingTime=short.nextFundingTime=event+3_600_000;
  assert.equal(assessBestOppositeProfitExit(p,long,short,config,now),undefined,'zero cash is not settled proof during the settlement grace window');
  p.long.lastFundingAt=p.short.lastFundingAt=event;
  assert.ok(assessBestOppositeProfitExit(p,long,short,config,now));
});

test('unknown or malformed original funding checks remain unavailable under current normal management',()=>{
  for(const checks of [null,[{exchange:'gate',timestamp:NaN}],[{exchange:'binance',timestamp:now-100}]]){
    const p=position();p.profitExitPolicy!.fundingChecks=checks as any;
    assert.equal(assessBestOppositeProfitExit(p,quote('gate'),quote('bybit'),config,now),undefined);
  }
});

test('partial legacy remainders retain the fixed original opening principal and strict current bps threshold',()=>{
  const p=position();p.long.quantity=p.short.quantity=.25;p.profitExitPolicy!.minCombinedNetUsd=0;
  const profit={spreadPnlUsd:1,totalFeesUsd:0,fundingAfterFeesUsd:0,spreadAfterFeesUsd:1,netPnlUsd:.05};
  assert.equal(exitProfitThresholdUsd(p,config),.1);assert.equal(alignedExitProfitsPass(p,profit,config),false);
  assert.equal(alignedExitProfitsPass(p,{...profit,netPnlUsd:.1},config),false);
  assert.equal(alignedExitProfitsPass(p,{...profit,netPnlUsd:.100001},config),true);assert.equal(p.profitExitNotionalUsd,100);
});

test('book losses and missing actual fees cannot be replaced by marked unrealized profit or local fee references',()=>{
  const p=position(),long=quote('gate'),short=quote('bybit');p.netPnlUsd=p.spreadPnlUsd=999;
  long.bids[0].price=99;long.asks[0].price=99.01;
  assert.notEqual(evaluateHoldingDecision(p,long,short,config,now).exitSignal,'profit');
  const missing=quote('bybit');delete missing.takerFeeRate;delete missing.takerFeeSource;delete missing.takerFeeAt;
  assert.equal(assessBestOppositeProfitExit(p,quote('gate'),missing,config,now),undefined);
  assert.ok(assessBestOppositeProfitExit(p,quote('gate'),missing,config,now,undefined,undefined,false),'a local reference remains observation only');
});

test('positive future carry is retained without charging sunk opening or future closing fees anew for each legacy cycle',()=>{
  const p=position(),long=quote('gate'),short=quote('bybit');long.bids[0].price=100;long.asks[0].price=100.01;
  p.fundingUsd=-10;p.feesUsd=10;
  const decision=evaluateHoldingDecision(p,long,short,config,now);
  assert.equal(decision.action,'hold');assert.equal(decision.expectedFundingUsd,.1);assert.equal(decision.incrementalCostUsd,0);
  assert.equal(decision.expectedNetUsd,.1);assert.equal(decision.exitSignal,undefined);
});
