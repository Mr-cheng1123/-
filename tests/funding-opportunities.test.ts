import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from './legacy-config.js';
import { calculateFundingCandidates } from '../src/shared/funding-opportunities.js';
import type { FundingStatsCell, FundingStatsDataset } from '../src/shared/funding-statistics.js';
import type { AppConfig, ExchangeId } from '../src/shared/types.js';
import {inspectLiveEnvironment} from '../src/core/live-readiness.js';

const now=1_700_000_000_000;
const cell=(exchange:ExchangeId,rate:number,extra:Partial<FundingStatsCell>={}):FundingStatsCell=>({exchange,rate,intervalHours:8,
  nextFundingTime:now+60_000,updatedAt:now,timestampKind:'received',available:true,...extra});
const row=(base:string,cells:FundingStatsCell[])=>({base,cells:Object.fromEntries(cells.map(value=>[value.exchange,value]))});
const data=(rows:FundingStatsDataset['rows'],extra:Partial<FundingStatsDataset>={}):FundingStatsDataset=>({
  source:'exchanges',range:'current',status:'ready',rows,receivedAt:now,lastAttemptAt:now,nextRefreshAt:now+20_000,
  maxAgeMs:120_000,sourceUrl:'https://example.test',marginScope:'USDT',...extra});
const settings=(extra:Partial<AppConfig>={}):AppConfig=>({...defaultConfig,...extra});
const near=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);

test('all-market pairing includes unconfigured and Unicode bases but only enabled venues',()=>{
  const cells=[cell('binance',-.001),cell('bybit',.005),cell('okx',.01),cell('gate',.02)];
  const candidates=calculateFundingCandidates(data([row('BTC',cells),row('中文币',cells)]),settings({symbols:['BTC'],exchanges:['binance','bybit','okx']}),now);
  assert.equal(candidates.length,6);assert.equal(candidates.filter(value=>value.base==='中文币').length,3);
  assert.ok(candidates.every(value=>value.longExchange!=='gate'&&value.shortExchange!=='gate'));
  assert.equal(new Set(candidates.map(value=>value.id)).size,6);
});

test('the paper statistics forecast charges four configured taker fees once and carries no extra cost budgets',()=>{
  const [candidate]=calculateFundingCandidates(data([row('BTC',[cell('binance',-.005),cell('bybit',-.001)])]),settings({mode:'paper'}),now);
  assert.equal(candidate.longFundingCount,1);assert.equal(candidate.shortFundingCount,1);
  near(candidate.grossFundingUsd,4);near(candidate.feesUsd,2.1);near(candidate.afterFeesUsd,1.9);
  near(candidate.expectedNetUsd,1.9);assert.equal(candidate.candidateEligible,true);
  assert.deepEqual([candidate.slippageBudgetUsd,candidate.transferCostUsd,candidate.fundingHaircutUsd,candidate.basisReserveUsd],[0,0,0,0]);
  assert.ok(candidate.reasons.some(reason=>reason.includes('盘口')));
  assert.equal('eligible' in candidate,false);assert.equal('execution' in candidate,false);
});

test('once direction follows scheduled cash rather than normalized rate and may have negative reference APR',()=>{
  const [candidate]=calculateFundingCandidates(data([row('BTC',[cell('binance',.001,{intervalHours:1}),cell('bybit',.002)])]),settings(),now);
  assert.equal(candidate.longExchange,'binance');assert.equal(candidate.shortExchange,'bybit');
  near(candidate.normalized8hBps,-60);near(candidate.aprPct,-657);
  near(candidate.grossFundingUsd,1);near(candidate.fundingHaircutUsd,0);
  assert.equal(candidate.candidateEligible,true);assert.equal(candidate.expectedNetUsd,candidate.afterFeesUsd);
});

test('continuous forecasts each leg schedule through max hold; once exits after both next settlements',()=>{
  const dataset=data([row('BTC',[cell('binance',.0001,{nextFundingTime:now+3_600_000}),cell('bybit',.0002,{intervalHours:1,nextFundingTime:now+1_800_000})])]);
  const [continuous]=calculateFundingCandidates(dataset,settings({holdMode:'continuous',maxHoldHours:4}),now);
  assert.equal(continuous.exitTime,now+4*3_600_000);assert.equal(continuous.longFundingCount,1);assert.equal(continuous.shortFundingCount,4);
  near(continuous.grossFundingUsd,.7);
  const [once]=calculateFundingCandidates(dataset,settings({holdMode:'once',maxHoldHours:4,exitDelaySec:10}),now);
  assert.equal(once.exitTime,now+3_610_000);assert.equal(once.longFundingCount,1);assert.equal(once.shortFundingCount,1);
  near(once.grossFundingUsd,.1);
});

test('once holding covers both next settlements without an unrelated forecast-window cutoff',()=>{
  const [candidate]=calculateFundingCandidates(data([row('BTC',[cell('binance',-.001,{nextFundingTime:now+20_000}),cell('bybit',.01)])]),settings({maxHoldHours:.01}),now);
  assert.equal(candidate.exitTime,now+70_000);assert.equal(candidate.longFundingCount,1);assert.equal(candidate.shortFundingCount,1);
  near(candidate.grossFundingUsd,11);assert.equal(candidate.candidateEligible,true);
  assert.ok(!candidate.reasons.includes('持有期无法覆盖两腿下一次结算'));
});

test('historical, unhealthy and expired datasets cannot produce current candidates',()=>{
  const rows=[row('BTC',[cell('binance',0),cell('bybit',.01)])];
  for(const extra of [{range:'7d'},{status:'error'},{status:'stale'},{status:'loading'},{receivedAt:now-120_001},{receivedAt:now+6000}] as Partial<FundingStatsDataset>[]){
    assert.deepEqual(calculateFundingCandidates(data(rows,extra),settings(),now),[]);
  }
  for(const extra of [{available:false},{updatedAt:now-120_001},{updatedAt:now+6000},{intervalHours:null},{intervalHours:0},{nextFundingTime:null},{nextFundingTime:now},{rate:NaN}] as Partial<FundingStatsCell>[]){
    assert.deepEqual(calculateFundingCandidates(data([row('BTC',[cell('binance',0),cell('bybit',.01,extra)])]),settings(),now),[]);
  }
});

test('liquidity and a predicted reversal do not block a positive funding candidate',()=>{
  const calculate=(extra:Partial<FundingStatsCell>={})=>calculateFundingCandidates(data([row('BTC',[cell('binance',.001),cell('bybit',.02,extra)])]),settings(),now)[0];
  const pending=calculate();assert.equal(pending.candidateEligible,true);
  assert.ok(pending.reasons.some(reason=>reason.includes('待核验')));
  assert.equal(pending.slippageBudgetUsd,0);
  assert.equal(calculate({openInterestUsd:0,volume24hUsd:0}).candidateEligible,true);
  assert.equal(calculate({predictedRate:-.01}).candidateEligible,true);
});

test('only an imminent settlement blocks; skew and the old entry window do not',()=>{
  const [close]=calculateFundingCandidates(data([row('BTC',[cell('binance',.001),cell('bybit',.02,{nextFundingTime:now+2000})])]),settings(),now);
  assert.equal(close.candidateEligible,false);assert.ok(close.reasons.includes('距离结算过近'));
  const [skew]=calculateFundingCandidates(data([row('BTC',[cell('binance',.001),cell('bybit',.02,{nextFundingTime:now+121_000})])]),settings(),now);
  assert.equal(skew.candidateEligible,true);
  const [early]=calculateFundingCandidates(data([row('BTC',[cell('binance',.001,{nextFundingTime:now+1_800_000}),cell('bybit',.02,{nextFundingTime:now+1_800_000})])]),settings(),now);
  assert.equal(early.candidateEligible,true);assert.ok(!early.reasons.some(reason=>reason.includes('建仓窗口')));
});

test('profit ordering retains blocked high-profit and negative rows, independently of eligibility',()=>{
  const candidates=calculateFundingCandidates(data([
    row('BLOCKED',[cell('binance',.001),cell('bybit',.05,{openInterestUsd:0})]),
    row('ELIGIBLE',[cell('binance',.001),cell('bybit',.02)]),
    row('LOSS',[cell('binance',.001),cell('bybit',.0011)]),
  ]),settings(),now);
  assert.deepEqual(candidates.map(value=>value.base),['BLOCKED','ELIGIBLE','LOSS']);
  assert.deepEqual(candidates.map(value=>value.candidateEligible),[true,true,true]);assert.ok(candidates[2].expectedNetUsd<0);
});

test('duplicate rows do not multiply pairs and update time remains the older leg observation',()=>{
  const duplicate=row('BTC',[cell('binance',0,{updatedAt:now-1000}),cell('bybit',.01)]);
  const [candidate,...extra]=calculateFundingCandidates(data([duplicate,duplicate]),settings(),now);
  assert.equal(extra.length,0);assert.equal(candidate.updatedAt,now-1000);assert.equal(candidate.id,'BTC-binance-bybit');
});

test('paper fee-only candidates use 100 per leg and bypass discretionary budgets and filters',()=>{
  const dataset=data([row('BTC',[
    cell('binance',0,{nextFundingTime:now+1_800_000,openInterestUsd:0,volume24hUsd:0}),
    cell('bybit',.003,{nextFundingTime:now+3_600_000,predictedRate:-.01,openInterestUsd:0,volume24hUsd:0}),
  ])]);
  const config=settings({paperFeeOnly:true,orderNotionalUsd:100,minNetProfitUsd:100,minNetRateBps:1000,
    transferCostUsd:20,rebalanceCostUsd:20,basisStressBps:1000,fundingSafetyFactor:.01});
  const [candidate]=calculateFundingCandidates(dataset,config,now);
  near(candidate.grossFundingUsd,.3);near(candidate.feesUsd,.21);near(candidate.afterFeesUsd,.09);
  near(candidate.expectedNetUsd,.09);assert.equal(candidate.candidateEligible,true);
  assert.deepEqual([candidate.slippageBudgetUsd,candidate.transferCostUsd,candidate.fundingHaircutUsd,candidate.basisReserveUsd],[0,0,0,0]);
  assert.equal(calculateFundingCandidates(dataset,{...config,mode:'live'},now)[0].candidateEligible,true);
  assert.equal(calculateFundingCandidates(dataset,{...config,paperFeeOnly:undefined} as unknown as AppConfig,now)[0].candidateEligible,true);
});

test('statistics candidates need positive gross funding; spread and combined fees are checked with books',()=>{
  const config=settings({paperFeeOnly:true,orderNotionalUsd:100,minNetProfitUsd:0});
  const [flat]=calculateFundingCandidates(data([row('BTC',[cell('binance',0),cell('bybit',0)])]),config,now);
  assert.ok(flat.afterFeesUsd<=1e-12);assert.equal(flat.candidateEligible,false);
  const [thin]=calculateFundingCandidates(data([row('BTC',[cell('binance',0),cell('bybit',.0021)])]),config,now);
  assert.ok(thin.grossFundingUsd>0);assert.equal(thin.candidateEligible,true);
  const profitable=data([row('BTC',[cell('binance',0),cell('bybit',.01)])]);
  assert.equal(calculateFundingCandidates(profitable,{...config,maxHoldHours:.001},now)[0].candidateEligible,true);
  assert.equal(calculateFundingCandidates(profitable,{...config,maxTotalPositionUsd:199},now)[0].candidateEligible,true);
  assert.deepEqual(calculateFundingCandidates({...profitable,receivedAt:now-120_001},config,now),[]);
});

test('adaptive candidate entry never uses a full-day forecast to manufacture first-cycle profit',()=>{
  const dataset=data([row('BTC',[cell('binance',.001,{intervalHours:1}),cell('bybit',.002)])]);
  const [adaptive]=calculateFundingCandidates(dataset,settings({holdMode:'adaptive'}),now);
  const [continuous]=calculateFundingCandidates(dataset,settings({holdMode:'continuous'}),now);
  assert.equal(adaptive.longExchange,'binance');assert.equal(adaptive.exitTime,now+70_000);near(adaptive.grossFundingUsd,1);
  assert.equal(continuous.longExchange,'bybit');near(continuous.grossFundingUsd,18);
});

test('ARK discovery uses explicit official local reference fees without API credentials and does not imply real four-fee profit',()=>{
  assert.ok(inspectLiveEnvironment({}).exchanges.every(exchange=>!exchange.credentialsConfigured));
  const config=settings({mode:'live',orderNotionalUsd:100,exchanges:['binance','bybit'],holdMode:'adaptive'});
  const dataset=data([row('ARK',[
    cell('binance',-.0027115,{intervalHours:1}),
    cell('bybit',-.000888,{intervalHours:1}),
  ])]);
  const [candidate]=calculateFundingCandidates(dataset,config,now);
  assert.equal(candidate.id,'ARK-binance-bybit');
  assert.equal(candidate.candidateEligible,true);
  assert.equal(candidate.longFundingCount,1);assert.equal(candidate.shortFundingCount,1);
  near(candidate.grossFundingUsd,.18235);near(candidate.feesUsd,.32);near(candidate.afterFeesUsd,-.13765);
  assert.equal(candidate.feesSource,'reference');near(candidate.expectedNetUsd,-.13765);
  const json=JSON.parse(JSON.stringify(candidate));assert.equal(json.feesSource,'reference');near(json.feesUsd,.32);near(json.afterFeesUsd,-.13765);near(json.expectedNetUsd,-.13765);
  const flipped=data([row('ARK',[
    cell('binance',-.00240462,{intervalHours:1}),
    cell('bybit',-.00309976,{intervalHours:1}),
  ])]);
  const [reversed]=calculateFundingCandidates(flipped,config,now);
  assert.equal(reversed.id,'ARK-bybit-binance');
  assert.equal(reversed.longExchange,'bybit');assert.equal(reversed.shortExchange,'binance');
  near(reversed.grossFundingUsd,.069514);near(reversed.feesUsd,.32);assert.equal(reversed.feesSource,'reference');
});

test('live ARK discovery and funding order never depend on configured or invalid trading fees',()=>{
  const dataset=data([
    row('ARK',[cell('binance',-.0027115,{intervalHours:1}),cell('bybit',-.000888,{intervalHours:1})]),
    row('BTC',[cell('binance',0),cell('bybit',.004)]),
    row('FLAT',[cell('binance',0),cell('bybit',0)]),
  ]);
  for(const entryPolicy of ['aligned','funding','dual'] as const){
    const config=settings({mode:'live',entryPolicy,orderNotionalUsd:100,exchanges:['binance','bybit'],holdMode:'adaptive'});
    const baseline=calculateFundingCandidates(dataset,config,now);
    assert.deepEqual(baseline.map(value=>value.base),['BTC','ARK','FLAT']);
    for(const value of [NaN,0,1,Infinity,-1]){
      const takerFees=Object.fromEntries(Object.keys(config.takerFees).map(exchange=>[exchange,value])) as AppConfig['takerFees'];
      const actual=calculateFundingCandidates(dataset,{...config,takerFees},now);
      assert.deepEqual(actual,baseline,`${entryPolicy}: public funding discovery must be independent of configured fee ${value}`);
      const ark=actual.find(value=>value.base==='ARK')!;assert.equal(ark.candidateEligible,true);near(ark.grossFundingUsd,.18235);
      assert.equal(ark.feesSource,'reference');near(ark.feesUsd,.32);near(ark.afterFeesUsd,-.13765);near(ark.expectedNetUsd,-.13765);
    }
    const configWithoutFeeAccess={...config};Object.defineProperty(configWithoutFeeAccess,'takerFees',{get:()=>{throw Error('Live statistics must not read configured fees');}});
    assert.deepEqual(calculateFundingCandidates(dataset,configWithoutFeeAccess,now),baseline);
    assert.equal(baseline.find(value=>value.base==='FLAT')!.candidateEligible,false,'Funding eligibility still requires positive scheduled cash.');
  }
});
