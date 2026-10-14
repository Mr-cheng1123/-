import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfig} from '../src/shared/config.js';
import type {AccountPosition,AppState,MarketSnapshot,Position} from '../src/shared/types.js';
import {ledgerPositionMetrics} from '../web/src/ledger-position-metrics.js';
import {ledgerCashPresentation} from '../web/src/ledger-cash-presentation.js';
import {ledgerHoldingEstimate} from '../web/src/ledger-holding-estimate.js';
import {ledgerCloseValue} from '../web/src/ledger-close-value.js';

const now=1_000_000;
function fixture(){
  const symbol='BILLCASH/USDT:USDT',base='BILLCASH';
  const position:Position={id:'bill-cash',base,mode:'live',status:'attention',openedAt:now-200000,plannedExitAt:0,holdMode:'adaptive',
    long:{exchange:'gate',symbol,side:'long',quantity:100,entryPrice:1,markPrice:1,feesUsd:.05,liquidationDistancePct:null},
    short:{exchange:'bybit',symbol,side:'short',quantity:100,entryPrice:1.01,markPrice:1,feesUsd:.05,liquidationDistancePct:null},
    fundingUsd:999,feesUsd:888,transferCostUsd:0,spreadPnlUsd:0,realizedSpreadPnlUsd:777,netPnlUsd:666,deltaUsd:0,fundingEvents:[],riskReasons:[]};
  const row=(side:'long'|'short'):AccountPosition=>({base,symbol,side,quantity:100,entryPrice:side==='long'?1:1.01,markPrice:1,
    liquidationPrice:0,leverage:2,realizedPnlUsd:0,unrealizedPnlUsd:0,fundingUsd:.2,feesUsd:.05,
    takerFeeRate:.0005,takerFeeAt:now,takerFeeSource:'exchange',cashFlowStatus:'ready',cashFlowReason:'账单已完整核对',cashFlowAt:now-1000});
  const quote=(exchange:'gate'|'bybit'):MarketSnapshot=>({exchange,base,symbol,timestamp:now,observedAt:now,markPrice:1,indexPrice:1,
    fundingRate:0,nextFundingTime:now+3600000,intervalHours:1,fundingHistory:[],bids:[{price:1,quantity:100}],asks:[{price:1,quantity:100}],
    quantityStep:1,minQuantity:1,minNotional:1,contractSize:1,volume24hUsd:1000,openInterestUsd:1000,source:'public'});
  const state:AppState={timestamp:now,config:{...structuredClone(defaultConfig),mode:'live',dataSource:'public'},running:true,
    autoEnabled:false,killSwitch:false,liveUnlocked:false,positions:[position],snapshots:[quote('gate'),quote('bybit')],opportunities:[],
    exchanges:[],logs:[],equity:[],risk:{status:'healthy',reasons:[]},
    totals:{fundingUsd:0,feesUsd:0,spreadPnlUsd:0,netPnlUsd:0,grossExposureUsd:0,availableBalanceUsd:0,openPositions:0},
    livePortfolio:{timestamp:now,pollIntervalMs:5000,maxAgeMs:15000,exchanges:(['gate','bybit'] as const).map((exchange,index)=>({
      exchange,credentialsConfigured:true,status:'ready',requestedAt:now-100,receivedAt:now-50,positions:[row(index?'short':'long')]}))}};
  return {position,state};
}
const evaluate=({position,state}:ReturnType<typeof fixture>)=>{
  const metrics=ledgerPositionMetrics(position,state.livePortfolio,now),presentation=ledgerCashPresentation(position,metrics);
  const estimate=ledgerHoldingEstimate(position,metrics,state,now),value=ledgerCloseValue(position,metrics,estimate,state,now);
  return {metrics,presentation,value};
};

test('complete paired cash displays the original numerical close value and has no missing-evidence notice',()=>{
  const f=fixture(),before=structuredClone(f.state),{value,presentation}=evaluate(f);
  assert.equal(value.status,'current');assert.ok(Math.abs(value.netPnlUsd!-1.2)<1e-10);assert.equal(value.pendingReason,undefined);
  assert.deepEqual(presentation.details,[]);assert.deepEqual(presentation.fundingReasons,[]);assert.deepEqual(presentation.observations,[]);
  assert.deepEqual(f.state,before,'Cash presentation cannot change stored cash, authorization or orders.');
});

test('latest incomplete bill refresh retains valid cash amounts and labels only the update evidence',()=>{
  const f=fixture();f.state.livePortfolio!.exchanges[1].positions[0].cashFlowStatus='incomplete';
  const {value,metrics,presentation}=evaluate(f);
  assert.equal(metrics.short.cashFlowAt,now-1000);assert.equal(value.status,'current');assert.ok(Math.abs(value.netPnlUsd!-1.2)<1e-10);
  assert.deepEqual(presentation.details,[]);assert.match(presentation.observations[0],/空 Bybit.*最近已核现金，本次账单归属待核对/);
});

test('a missing Bybit funding receipt identifies its leg and genuine failure without filling zero or old journal cash',()=>{
  const f=fixture(),row=f.state.livePortfolio!.exchanges[1].positions[0];delete row.fundingUsd;row.cashFlowStatus='error';
  const {value,metrics,presentation}=evaluate(f);
  assert.equal(metrics.fundingUsd,undefined);assert.equal(value.netPnlUsd,undefined);assert.equal(value.pendingReason,'cash');
  assert.equal(presentation.closePendingLabel(value.pendingReason),'账单读取失败');assert.equal(presentation.fundingLabel,'资金费读取失败');
  assert.match(presentation.fundingReasons[0],/空 Bybit.*账单读取失败.*到账资金费/);
  assert.match(presentation.details[0],/空 Bybit/);assert.doesNotMatch(presentation.details.join(' '),/多 Gate/);
});

test('missing realization alone leaves actual funding and fees intact while explaining the precise blocker',()=>{
  const f=fixture(),row=f.state.livePortfolio!.exchanges[1].positions[0];delete row.realizedPnlUsd;row.cashFlowStatus='incomplete';
  const {value,metrics,presentation}=evaluate(f);
  assert.equal(metrics.fundingUsd,.4);assert.equal(metrics.feesUsd,.1);assert.equal(metrics.realizedPnlUsd,undefined);
  assert.equal(value.pendingReason,'cash');assert.equal(value.netPnlUsd,undefined);assert.deepEqual(presentation.fundingReasons,[]);
  assert.match(presentation.details[0],/空 Bybit.*已实现价格损益/);assert.doesNotMatch(presentation.details[0],/缺少.*到账资金费/);
});

test('missing native cycle and actual loading are separate statuses',()=>{
  for(const [status,label] of [['unavailable','账单周期待核对'],['loading','现金账单待核对']] as const){
    const f=fixture(),row=f.state.livePortfolio!.exchanges[1].positions[0];delete row.feesUsd;row.cashFlowStatus=status;
    const {value,presentation}=evaluate(f);assert.equal(value.pendingReason,'cash');assert.equal(presentation.closePendingLabel(value.pendingReason),label);
    assert.doesNotMatch(presentation.details.join(' '),/同步中/);
  }
});

test('an actually flat previously traded leg requires historical cash while an unopened absent leg remains genuine zero',()=>{
  const f=fixture();f.state.livePortfolio!.exchanges[1].positions=[];
  const closed=evaluate(f);assert.equal(closed.metrics.short.quantity,0);assert.equal(closed.metrics.short.fundingUsd,undefined);
  assert.equal(closed.value.pendingReason,'cash');assert.equal(closed.presentation.closePendingLabel('cash'),'已平腿现金待核对');
  assert.match(closed.presentation.details[0],/空 Bybit.*已平腿的历史现金/);
  Object.assign(f.position.short,{quantity:0,entryPrice:0,feesUsd:0});
  const unopened=evaluate(f);assert.equal(unopened.metrics.short.fundingUsd,0);assert.deepEqual(unopened.presentation.details,[]);
  assert.equal(unopened.value.status,'current');assert.ok(Number.isFinite(unopened.value.netPnlUsd));
});

test('unverified transfer cost is its own cash blocker instead of an exchange bill synchronization claim',()=>{
  const f=fixture();f.position.transferCostUsd=NaN;
  const {value,presentation}=evaluate(f);assert.equal(value.pendingReason,'cash');assert.equal(value.netPnlUsd,undefined);
  assert.equal(presentation.closePendingLabel('cash'),'转账成本待核对');assert.deepEqual(presentation.fundingReasons,[]);
  assert.deepEqual(presentation.details,['转账成本尚未核实，不按零计算']);
});

test('book, fee, entry and account blockers retain their own classification with complete account cash',()=>{
  const f=fixture();f.state.snapshots=[];const {value,presentation}=evaluate(f);
  assert.equal(value.pendingReason,'book');assert.deepEqual(presentation.details,[]);assert.equal(presentation.closePendingLabel('book'),'盘口同步中');
  assert.equal(presentation.closePendingLabel('fees'),'平仓费率待核对');assert.equal(presentation.closePendingLabel('entry'),'开仓均价待读取');
  assert.equal(presentation.closePendingLabel('account'),'待读取');
  const metrics=ledgerPositionMetrics(f.position,f.state.livePortfolio,now);metrics.cycleMismatch=true;
  assert.equal(ledgerCashPresentation(f.position,metrics).closePendingLabel('account'),'持仓周期待核对');
});
