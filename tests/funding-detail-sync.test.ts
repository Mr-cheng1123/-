import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../src/core/engine.js';
import {defaultConfig} from '../src/shared/config.js';
import {calculateOpportunities} from '../src/core/strategy.js';
import {FundingEntryStabilityTracker} from '../src/core/funding-entry-stability.js';
import {calculateFundingCandidates,fundingOpportunityCoverage,fundingPairKey,pairFundingCandidateDetails} from '../src/shared/funding-opportunities.js';
import type {FundingStatsDataset} from '../src/shared/funding-statistics.js';
import type {AppConfig,ExchangeId,LiveCoinExclusion,MarketSnapshot} from '../src/shared/types.js';

const NOW=1_700_000_000_000;
const config:AppConfig={...defaultConfig,mode:'paper',dataSource:'public',entryPolicy:'aligned',orderNotionalUsd:100,
  exchanges:['binance','bybit'],holdMode:'adaptive'};
function dataset(rateA=.001,rateB=.0009):FundingStatsDataset{return {
  source:'exchanges',range:'current',status:'ready',receivedAt:NOW,lastAttemptAt:NOW,nextRefreshAt:NOW+20_000,maxAgeMs:60_000,
  sourceUrl:'https://example.test',marginScope:'USDT perpetual',rows:[{base:'ARK',cells:Object.fromEntries((['binance','bybit'] as const).map((exchange,i)=>
    [exchange,{exchange,rate:i?rateB:rateA,intervalHours:1,nextFundingTime:NOW+600_000,updatedAt:NOW-i*1000,timestampKind:'received',available:true}]))}],
};}
function quotes(rateA=.001,rateB=.0009):MarketSnapshot[]{return (['binance','bybit'] as const).map((exchange,i)=>{
  const markPrice=i?120:100;
  return {exchange,base:'ARK',symbol:'ARK/USDT:USDT',timestamp:NOW-1000,observedAt:NOW-i*500,fundingObservedAt:NOW-i*500,markPrice,indexPrice:100,
    fundingRate:i?rateB:rateA,intervalHours:1,nextFundingTime:NOW+600_000,fundingHistory:[],
    bids:[{price:markPrice-.01,quantity:100}],asks:[{price:markPrice+.01,quantity:100}],
    openInterestUsd:0,volume24hUsd:0,quantityStep:.01,minQuantity:.01,minNotional:5,contractSize:1,source:'public'};
});}
function engineFixture(data:FundingStatsDataset,observations:MarketSnapshot[],excluded:LiveCoinExclusion[]=[]){
  const reads:Array<{exchange:ExchangeId;includeAccount:boolean}>=[];
  const engine={config,options:{},adapters:[],overlaidSnapshotFees:new WeakSet<MarketSnapshot>(),snapshots:observations,spreadHistory:undefined,store:{data:{killSwitch:false}},
    fundingEntryStability:new FundingEntryStabilityTracker(),
    entryCooldowns:new Map<string,number>(),unavailableSnapshots:new Set<string>(),fundingWatch:new Map(),fundingChecked:new Map(),
    verifyFailures:new Map(),health:config.exchanges.map(exchange=>({exchange,status:'online'})),opportunities:[],
    usesFundingStatistics:()=>true,fundingCandidates:(now=NOW)=>calculateFundingCandidates(data,config,now),coinExclusions:()=>excluded,
    paperBalance:()=>10000,requiredMarginUsd:()=>50,snapshot:(exchange:ExchangeId,base:string)=>observations.find(q=>q.exchange===exchange&&q.base===base),
    exclusive:<T>(fn:()=>Promise<T>)=>fn(),adapter:(id:ExchangeId)=>({id}),
    refreshAdapter:async(adapter:{id:ExchangeId},_bases:string[],includeAccount=true)=>{reads.push({exchange:adapter.id,includeAccount});return true;},
    recordSpreadObservations:()=>{},pruneSnapshots:()=>{},
  };
  Object.setPrototypeOf(engine,Engine.prototype);
  const detailed=()=> (Engine.prototype as unknown as {detailedOpportunities(now:number):ReturnType<typeof calculateOpportunities>})
    .detailedOpportunities.call(engine,NOW);
  // This suite isolates public statistical/detail pairing after genuine funding confirmation.
  // Five independent observations retain the same native settlement clocks; no private reads occur.
  for(const age of [180_000,135_000,90_000,45_000,0]){
    const at=NOW-age;
    observations.forEach((quote,index)=>Object.assign(quote,{timestamp:at-1000,observedAt:at-index*500,fundingObservedAt:at-index*500}));
    (Engine.prototype as unknown as {detailedOpportunities(now:number):ReturnType<typeof calculateOpportunities>}).detailedOpportunities.call(engine,at);
  }
  return {engine,reads,detailed};
}

test('unordered venue pairing attaches the actual common-quantity direction without losing the statistical reference',()=>{
  const candidates=calculateFundingCandidates(dataset(),config,NOW),observations=quotes();
  assert.equal(candidates[0].id,'ARK-bybit-binance');
  const detail=calculateOpportunities(observations,config,NOW);
  assert.equal(detail[0].id,'ARK-binance-bybit');assert.equal(detail[0].eligible,true,detail[0].reasons.join('；'));
  const [row]=pairFundingCandidateDetails(candidates,detail,observations,()=>undefined,NOW);
  assert.equal(row.id,detail[0].id);assert.equal(row.execution?.id,row.id);assert.equal(row.verification,'verified');
  assert.equal(row.longExchange,'binance');assert.equal(row.shortExchange,'bybit');assert.equal(row.directionChanged,true);
  assert.equal(row.statistics?.id,candidates[0].id);assert.equal(row.statistics?.longRate,candidates[0].longRate);
  assert.equal(row.statistics?.updatedAt,NOW-1000);assert.equal(row.executionObservedAt,NOW-500);
  assert.equal(row.grossFundingUsd,detail[0].expectedFundingUsd);assert.equal(row.statistics?.grossFundingUsd,candidates[0].grossFundingUsd);
  assert.equal(row.pairKey,fundingPairKey(candidates[0]));assert.equal(row.pairKey,fundingPairKey(detail[0]));
});

test('a current statistical pair does not reject actual positive coin-quantity funding because nominal statistics chose the opposite direction',()=>{
  const f=engineFixture(dataset(),quotes()),[detail]=f.detailed();
  assert.equal(detail.id,'ARK-binance-bybit');assert.equal(detail.eligible,true,detail.reasons.join('；'));
  assert.equal(detail.fundingEntryStability?.passes,true);assert.equal(detail.fundingEntryStability!.sampleCount,1);
  assert.equal(detail.fundingEntryStability!.observedSpanMs,0);
  assert.equal(detail.checks?.find(check=>check.label==='资金费率候选仍有效')?.pass,true);
});

test('nominal zero-rate-difference still exposes the pair; actual funding and price advantage decide eligibility',()=>{
  const candidates=calculateFundingCandidates(dataset(.001,.001),config,NOW);
  assert.equal(candidates.length,1);assert.equal(candidates[0].candidateEligible,false);assert.equal(candidates[0].grossFundingUsd,0);
  const f=engineFixture(dataset(.001,.001),quotes(.001,.001)),[detail]=f.detailed();
  assert.ok(detail.expectedFundingUsd>0);assert.equal(detail.eligible,true,detail.reasons.join('；'));
});

test('a real occupied coin remains a fully paired financial opportunity but cannot open again',()=>{
  const f=engineFixture(dataset(),quotes(),[{base:'ARK',exchanges:['bybit'],reasons:['交易所已有该币种持仓']}]);
  const detailed=f.detailed(),rows=pairFundingCandidateDetails(calculateFundingCandidates(dataset(),config,NOW),detailed,quotes(),()=>undefined,NOW);
  assert.equal(rows.length,1);assert.ok(rows[0].execution);assert.equal(rows[0].execution!.eligible,false);
  assert.ok(rows[0].execution!.reasons.includes('交易所已有该币种持仓'));
  assert.ok(Number.isFinite(rows[0].execution!.expectedFundingUsd));assert.equal(rows[0].verification,'blocked');
});

test('public verification accepts the reverse id and returns the current pair direction without private reads',async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const f=engineFixture(dataset(),quotes());
  const result=await (Engine.prototype as unknown as {verifyFundingCandidate(id:string):Promise<ReturnType<typeof calculateOpportunities>[number]|undefined>})
    .verifyFundingCandidate.call(f.engine,'ARK-binance-bybit');
  assert.ok(result);assert.equal(result.id,'ARK-binance-bybit');
  assert.equal(f.reads.length,2);assert.ok(f.reads.every(read=>read.includeAccount===false));
});

test('a disappeared or stale statistical pair remains blocked despite old executable quotes',()=>{
  const data=dataset();data.status='stale';
  const f=engineFixture(data,quotes()),[detail]=f.detailed();
  assert.equal(detail.eligible,false);assert.equal(detail.checks?.find(check=>check.label==='资金费率候选仍有效')?.pass,false);
});

test('unpriced closing books preserve aligned funding-after-fees detail without inventing closing-loss data',()=>{
  const observations=quotes();observations[0].bids=[];
  const candidates=calculateFundingCandidates(dataset(),config,NOW),detail=calculateOpportunities(observations,config,NOW);
  assert.equal(detail[0].combinedExpectedNetUsd,detail[0].expectedFundingUsd-detail[0].feesUsd);
  assert.ok(Number.isFinite(detail[0].feesUsd));assert.equal(detail[0].bookCost,undefined);
  const [row]=pairFundingCandidateDetails(candidates,detail,observations,()=>undefined,NOW);
  assert.equal(row.feesUsd,detail[0].feesUsd);assert.equal(row.afterFeesUsd,detail[0].fundingAfterFeesUsd);
  assert.equal(row.statistics?.feesUsd,candidates[0].feesUsd);assert.equal(row.statistics?.notionalUsd,100);
  assert.equal(row.execution!.feesUsd,detail[0].feesUsd);assert.equal(row.execution!.combinedExpectedNetUsd,row.afterFeesUsd);
});

test('a verification failure recorded under the reverse direction is still visible on the public pair',()=>{
  const candidates=calculateFundingCandidates(dataset(),config,NOW);
  const [row]=pairFundingCandidateDetails(candidates,[],[],id=>id==='ARK-binance-bybit'?'盘口读取失败':undefined,NOW);
  assert.equal(row.verification,'blocked');assert.equal(row.verifyNote,'盘口读取失败');
});

test('coverage identifies lone valid venues and missing settlement information rather than claiming they have opportunities',()=>{
  const data=dataset();
  data.rows.push({base:'ONLY_ONE',cells:{binance:{...data.rows[0].cells.binance!}}});
  data.rows.push({base:'NO_TIME',cells:{bybit:{...data.rows[0].cells.bybit!,nextFundingTime:null}}});
  const candidates=calculateFundingCandidates(data,config,NOW),rows=pairFundingCandidateDetails(candidates,[],[],()=>undefined,NOW);
  const coverage=fundingOpportunityCoverage(data,config,candidates,rows,NOW);
  assert.equal(coverage.statisticsCoinCount,3);assert.equal(coverage.pairedCoinCount,1);assert.equal(coverage.unpairedCoinCount,2);
  assert.equal(coverage.detailedPairCount,0);
  assert.deepEqual(coverage.unpaired.find(row=>row.base==='ONLY_ONE')?.validExchanges,['binance']);
  assert.match(coverage.unpaired.find(row=>row.base==='NO_TIME')!.reason,/结算时间/);
});
