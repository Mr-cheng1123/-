import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfig} from '../src/shared/config.js';
import type {AppConfig,MarketSnapshot} from '../src/shared/types.js';
import type {FundingStatsDataset} from '../src/shared/funding-statistics.js';
import {calculateFundingCandidates,pairFundingCandidateDetails} from '../src/shared/funding-opportunities.js';
import {calculateOpportunities} from '../src/core/strategy.js';

const at=(time:string)=>Date.parse(`2026-10-03T${time}+08:00`);
const config:AppConfig={...defaultConfig,entryPolicy:'aligned',orderNotionalUsd:100,holdMode:'adaptive',
  exchanges:['bitget','bybit'],exitDelaySec:10,entryIocBufferBps:0};
const near=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);
function pair(now:number,change:Partial<MarketSnapshot>[]=[]):MarketSnapshot[]{
  return (['bitget','bybit'] as const).map((exchange,index)=>({exchange,base:'SAND',symbol:'SAND/USDT:USDT',
    source:'public' as const,timestamp:now,observedAt:now,markPrice:100,indexPrice:100,
    fundingRate:index===0?-.010993:-.000859,intervalHours:index===0?8:1,
    nextFundingTime:index===0?at('16:00:00'):at('14:00:00'),fundingHistory:[],
    bids:[{price:index===0?99.89:100.1,quantity:10}],asks:[{price:index===0?99.9:100.11,quantity:10}],
    quantityStep:.01,minQuantity:.01,minNotional:5,contractSize:1,openInterestUsd:1_000_000,volume24hUsd:1_000_000,
    ...change[index]}));
}
function dataset(snapshots:MarketSnapshot[],now:number):FundingStatsDataset{
  return {source:'exchanges',range:'current',status:'ready',receivedAt:now,lastAttemptAt:now,
    nextRefreshAt:now+20_000,maxAgeMs:120_000,sourceUrl:'https://example.test',marginScope:'USDT',
    rows:[{base:'SAND',cells:Object.fromEntries(snapshots.map(snapshot=>[snapshot.exchange,{exchange:snapshot.exchange,
      rate:snapshot.fundingRate,intervalHours:snapshot.intervalHours,nextFundingTime:snapshot.nextFundingTime,
      updatedAt:now,timestampKind:'received' as const,available:true}]))}]};
}

test('SAND before hourly payments stays visible and recommends after the final payment before the eight-hour receipt',()=>{
  const now=at('13:44:49'),snapshots=pair(now),[opportunity]=calculateOpportunities(snapshots,config,now),
    [candidate]=calculateFundingCandidates(dataset(snapshots,now),config,now);
  assert.equal(opportunity.longExchange,'bitget');assert.equal(opportunity.shortExchange,'bybit');
  assert.equal(opportunity.eligible,false);assert.equal(candidate.candidateEligible,false);
  assert.equal(opportunity.fundingSchedule!.entryReady,false);assert.equal(candidate.fundingSchedule!.entryReady,false);
  assert.equal(opportunity.fundingSchedule!.recommendedEntryAt,at('15:00:10'));
  assert.equal(opportunity.fundingSchedule!.nextEventTime,at('14:00:00'));
  near(opportunity.fundingSchedule!.nextEventUsd,-.0859);
  near(opportunity.fundingSchedule!.preReceiptPaymentsUsd,.1718);
  near(opportunity.fundingSchedule!.totalUsd,.8416);
  near(opportunity.expectedFundingUsd,.8416);near(candidate.grossFundingUsd,.8416);
  assert.equal(candidate.longFundingCount,1);assert.equal(candidate.shortFundingCount,3);
  assert.ok(opportunity.checks!.some(check=>check.group==='timing'&&check.pass===false&&check.reason===opportunity.fundingSchedule!.reason));
  const views=pairFundingCandidateDetails([candidate],[opportunity],snapshots,()=>undefined,now);
  assert.equal(views.length,1);assert.equal(views[0].verification,'blocked');
  assert.deepEqual(views[0].fundingSchedule,opportunity.fundingSchedule);
});

test('after the hourly clock rolls to the receipt event, fresh favorable quotes permit entry without a synchronization gate',()=>{
  const now=at('15:00:10'),snapshots=pair(now,[{}, {nextFundingTime:at('16:00:00')}]);
  const [opportunity]=calculateOpportunities(snapshots,config,now),
    [candidate]=calculateFundingCandidates(dataset(snapshots,now),config,now);
  assert.equal(opportunity.eligible,true,opportunity.reasons.join('；'));assert.equal(candidate.candidateEligible,true);
  assert.equal(opportunity.fundingSchedule!.entryReady,true);assert.equal(opportunity.fundingSchedule!.nextEventTime,at('16:00:00'));
  near(opportunity.fundingSchedule!.nextEventUsd,1.0134);near(opportunity.fundingSchedule!.totalUsd,1.0134);
  assert.equal(candidate.longFundingCount,1);assert.equal(candidate.shortFundingCount,1);
});

test('a rolled settlement clock preserves the short post-payment grace before a new hedge',()=>{
  const now=at('15:00:05'),snapshots=pair(now,[{}, {nextFundingTime:at('16:00:00')}]);
  const [opportunity]=calculateOpportunities(snapshots,config,now);
  assert.equal(opportunity.fundingSchedule!.entryReady,false);assert.equal(opportunity.eligible,false);
  assert.equal(opportunity.fundingSchedule!.recommendedEntryAt,at('15:00:10'));
  near(opportunity.expectedFundingUsd,1.0134);
});

test('a first standalone receipt permits early asynchronous entry even if another venue pays later',()=>{
  const now=at('13:44:49'),snapshots=pair(now,[{fundingRate:.0005,nextFundingTime:at('16:00:00')},
    {fundingRate:.002,intervalHours:8,nextFundingTime:at('14:00:00')}]);
  const [opportunity]=calculateOpportunities(snapshots,config,now);
  assert.equal(opportunity.eligible,true,opportunity.reasons.join('；'));
  assert.equal(opportunity.fundingSchedule!.entryReady,true);near(opportunity.fundingSchedule!.nextEventUsd,.2);
  assert.equal(opportunity.settlementSkewSec,7200,'different clocks alone never impose a synchronization gate');
});

test('a positive hourly cash leg cannot open in the middle of the common eight-hour cycle',()=>{
  const now=at('13:44:49'),snapshots=pair(now,[{}, {fundingRate:.000859}]);
  const [opportunity]=calculateOpportunities(snapshots,config,now);
  assert.equal(opportunity.eligible,false);
  assert.equal(opportunity.fundingSchedule!.entryReady,false);near(opportunity.fundingSchedule!.preReceiptPaymentsUsd,0);
  assert.equal(opportunity.fundingSchedule!.entryWindow!.kind,'first-receipt');
  assert.equal(opportunity.fundingSchedule!.entryWindow!.phase,'after');
  assert.equal(opportunity.fundingSchedule!.recommendedEntryAt,at('16:00:10'));
  assert.ok(opportunity.fundingSchedule!.nextEventUsd>0);
});

test('synchronous opposite-sign payments are judged by the net event, not by individual expense legs',()=>{
  const now=at('13:44:49'),snapshots=pair(now,[{}, {nextFundingTime:at('16:00:00')}]);
  const [opportunity]=calculateOpportunities(snapshots,config,now);
  assert.equal(opportunity.eligible,true,opportunity.reasons.join('；'));
  assert.equal(opportunity.fundingSchedule!.entryReady,true);near(opportunity.fundingSchedule!.preReceiptPaymentsUsd,0);
  near(opportunity.fundingSchedule!.nextEventUsd,1.0134);
});

test('a tied net-zero event is not an individual-leg payment barrier',()=>{
  const now=at('13:44:49'),snapshots=pair(now,[{fundingRate:-.000859,intervalHours:8,nextFundingTime:at('14:00:00')},
    {fundingRate:-.000859,intervalHours:8,nextFundingTime:at('14:00:00')}]);
  const [opportunity]=calculateOpportunities(snapshots,config,now);
  assert.equal(opportunity.fundingSchedule!.entryReady,true);
  near(opportunity.fundingSchedule!.nextEventUsd,0);near(opportunity.fundingSchedule!.preReceiptPaymentsUsd,0);
  assert.equal(opportunity.eligible,false,'zero total income remains separately ineligible');
});

test('explicit anytime policy preserves entry while still presenting the separate payment and receipt events',()=>{
  const now=at('13:44:49'),snapshots=pair(now),settings={...config,asyncFundingEntryTiming:'anytime' as const};
  const [opportunity]=calculateOpportunities(snapshots,settings,now),
    [candidate]=calculateFundingCandidates(dataset(snapshots,now),settings,now);
  assert.equal(opportunity.eligible,true,opportunity.reasons.join('；'));assert.equal(candidate.candidateEligible,true);
  assert.equal(opportunity.fundingSchedule!.entryReady,true);near(opportunity.fundingSchedule!.nextEventUsd,-.0859);
  near(opportunity.expectedFundingUsd,.8416);assert.equal(candidate.shortFundingCount,3);
});

test('historical and cost-based entry policies do not acquire the aligned settlement-timing gate',()=>{
  const now=at('13:44:49'),snapshots=pair(now);
  for(const entryPolicy of ['funding','dual'] as const){
    const [opportunity]=calculateOpportunities(snapshots,{...config,entryPolicy},now);
    assert.equal(opportunity.checks!.some(check=>check.reason===opportunity.fundingSchedule?.reason),false);
    const [candidate]=calculateFundingCandidates(dataset(snapshots,now),{...config,entryPolicy},now);
    assert.equal(candidate.candidateEligible,true,candidate.reasons.join('；'));
  }
});

test('a post-settlement exit delay never credits a later hourly payment to the paired funding cycle',()=>{
  const now=at('12:30:00'),snapshots=pair(now,[{nextFundingTime:at('13:59:55')}, {nextFundingTime:at('13:00:00')}]);
  const [opportunity]=calculateOpportunities(snapshots,config,now),
    [candidate]=calculateFundingCandidates(dataset(snapshots,now),config,now);
  assert.equal(opportunity.exitTime,at('14:00:05'));assert.equal(opportunity.fundingSchedule!.endTime,at('13:59:55'));
  near(opportunity.expectedFundingUsd,1.0134);near(candidate.grossFundingUsd,1.0134);
  assert.equal(candidate.shortFundingCount,1);
  const [view]=pairFundingCandidateDetails([candidate],[opportunity],snapshots,()=>undefined,now);
  assert.equal(view.shortFundingCount,1,'execution rows use the same paired cutoff as the original statistics');
});
