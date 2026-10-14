import test from 'node:test';
import assert from 'node:assert/strict';
import type {AppConfig,ExchangeId,MarketSnapshot,Opportunity} from '../src/shared/types.js';
import {FundingEntryStabilityTracker} from '../src/core/funding-entry-stability.js';

const start=Date.parse('2026-10-10T16:05:00+08:00'),minute=60_000,hour=60*minute;
const config:Pick<AppConfig,'mode'|'maxSnapshotAgeMs'>={mode:'live',maxSnapshotAgeMs:30_000};
const quote=(exchange:ExchangeId,at:number,changes:Partial<MarketSnapshot>={}):MarketSnapshot=>({
  exchange,base:'KAIA',symbol:'KAIA/USDT:USDT',timestamp:at,observedAt:at,fundingObservedAt:at,
  markPrice:100,indexPrice:100,fundingRate:exchange==='bybit'?.001:0,nextFundingTime:start+55*minute,
  intervalHours:1,fundingHistory:[],bids:[{price:99.99,quantity:100}],asks:[{price:100.01,quantity:100}],
  quantityStep:.001,minQuantity:.001,minNotional:1,contractSize:1,openInterestUsd:0,volume24hUsd:0,
  source:'public',bookTransport:'rest',...changes});
function opportunity(long:MarketSnapshot,short:MarketSnapshot,changes:Partial<Opportunity>={}):Opportunity {
  return {id:`KAIA-${long.exchange}-${short.exchange}`,base:'KAIA',longExchange:long.exchange,shortExchange:short.exchange,
    longRate:long.fundingRate,shortRate:short.fundingRate,longIntervalHours:long.intervalHours,shortIntervalHours:short.intervalHours,
    longQuantity:1,shortQuantity:1,notionalUsd:100,grossExposureUsd:200,netRateBps:10,normalized8hBps:80,aprPct:0,capitalAprPct:0,
    expectedFundingUsd:100*(short.fundingRate-long.fundingRate),feesUsd:.02,slippageUsd:0,transferCostUsd:0,basisStressUsd:0,
    expectedNetUsd:.08,basisBps:0,deltaUsd:0,nextFundingTime:Math.min(long.nextFundingTime,short.nextFundingTime),
    exitTime:Math.max(long.nextFundingTime,short.nextFundingTime)+10_000,settlementSkewSec:0,liquidityUsd:10_000,
    eligible:true,reasons:[],risk:'low',confidence:.85,entryPolicy:'aligned',...changes};
}
function read(tracker:FundingEntryStabilityTracker,at:number,longChanges:Partial<MarketSnapshot>={},shortChanges:Partial<MarketSnapshot>={},
  opportunityChanges:Partial<Opportunity>={},c=config){
  const long=quote('gate',at,longChanges),short=quote('bybit',at,shortChanges);
  return tracker.evaluate(opportunity(long,short,opportunityChanges),long,short,c,at);
}
function confirmed(tracker:FundingEntryStabilityTracker){
  return read(tracker,start);
}

test('the first current positive paired funding read qualifies without a continuous confirmation window',()=>{
  const tracker=new FundingEntryStabilityTracker();
  const result=read(tracker,start);
  assert.equal(result.passes,true);assert.equal(result.status,'confirmed');assert.equal(result.sampleCount,1);
  assert.equal(result.requiredSamples,1);assert.equal(result.requiredSpanMs,0);assert.equal(result.observedSpanMs,0);
  assert.equal(result.minimumFundingUsd,.1);assert.equal(result.evidence?.version,2);
  assert.equal(result.evidence?.firstObservedAt,start);assert.equal(result.evidence?.lastObservedAt,start);
  assert.equal(result.evidence?.long.fundingObservedAt,start);
  assert.equal(result.evidence?.short.fundingRate,.001);assert.equal(result.evidence?.samples.length,1);
});

test('new positive observations replace the current pair instead of accumulating a history',()=>{
  const tracker=new FundingEntryStabilityTracker();let result=read(tracker,start);
  for(const offset of [1,1000,15_000,60_000]){
    result=read(tracker,start+offset);
    assert.equal(result.sampleCount,1);assert.equal(result.observedSpanMs,0);assert.equal(result.passes,true);
    assert.deepEqual(result.evidence?.samples,[{at:start+offset,longObservedAt:start+offset,shortObservedAt:start+offset,fundingUsd:.1}]);
  }
});

test('a long previous observation gap creates no new time or sample waiting period',()=>{
  const tracker=new FundingEntryStabilityTracker();let result=read(tracker,start);
  for(const offset of [60_000,120_000,180_000]){
    result=read(tracker,start+offset);
    assert.equal(result.sampleCount,1);assert.equal(result.observedSpanMs,0);assert.equal(result.passes,true);
  }
});

test('one thousand fresh books and account-fee overlays cannot multiply one native funding read',()=>{
  const tracker=new FundingEntryStabilityTracker();
  for(let i=0;i<1000;i++){
    const at=start+i*10,result=read(tracker,at,{bookTransport:'websocket',bookGeneration:i,fundingObservedAt:start,takerFeeAt:at},
      {bookTransport:'websocket',bookGeneration:i,fundingObservedAt:start,takerFeeAt:at});
    assert.equal(result.sampleCount,1);assert.equal(result.observedSpanMs,0);assert.equal(result.passes,true);
    assert.equal(result.evidence?.lastObservedAt,start);
    assert.equal(result.evidence?.long.fundingObservedAt,start);assert.equal(result.evidence?.short.fundingObservedAt,start);
  }
});

test('fresh valid pairs qualify immediately without a minimum interval or both clocks changing',()=>{
  const tracker=new FundingEntryStabilityTracker();read(tracker,start);
  for(const offset of [1,1000,5000,14_999])assert.equal(read(tracker,start+offset).passes,true);
  assert.equal(read(tracker,start+15_000).sampleCount,1);
  const oneLeg=read(tracker,start+30_000,{}, {fundingObservedAt:start+15_000});assert.equal(oneLeg.passes,true);
  assert.equal(oneLeg.evidence?.short.fundingObservedAt,start+15_000);
  const paired=read(tracker,start+40_000,{fundingObservedAt:start+30_000});
  assert.equal(paired.sampleCount,1);assert.equal(paired.observedSpanMs,0);assert.equal(paired.passes,true);
});

test('negative and zero forecasts refuse entry immediately and new current positive reads recover immediately',()=>{
  for(const fundingRate of [0,-.001]){
    const tracker=new FundingEntryStabilityTracker();assert.equal(confirmed(tracker).passes,true);
    const changed=read(tracker,start+195_000,{}, {fundingRate});
    assert.equal(changed.status,'nonpositive');assert.equal(changed.sampleCount,0);assert.equal(changed.passes,false);
    const positive=read(tracker,start+210_000);assert.equal(positive.sampleCount,1);assert.equal(positive.passes,true);
    assert.equal(positive.observedSpanMs,0);
  }
});

test('a forecast turning negative cannot spend its preceding positive permission',()=>{
  const tracker=new FundingEntryStabilityTracker();assert.equal(read(tracker,start).passes,true);
  assert.equal(read(tracker,start+30_000).sampleCount,1);
  const negative=read(tracker,start+45_000,{}, {fundingRate:-.001});assert.equal(negative.sampleCount,0);assert.equal(negative.passes,false);
  assert.equal(read(tracker,start+60_000).passes,true);
});

test('sixty-second observation gaps have no effect when the replacement funding pair itself is fresh',()=>{
  for(const gap of [60_000,60_001]){
    const tracker=new FundingEntryStabilityTracker();read(tracker,start);
    const result=read(tracker,start+gap);assert.equal(result.sampleCount,1);assert.equal(result.passes,true);
  }
});

test('stale or missing funding observations remove old confirmation without using the book timestamp',()=>{
  for(const fundingObservedAt of [undefined,start+164_999]){
    const tracker=new FundingEntryStabilityTracker();assert.equal(confirmed(tracker).passes,true);
    const result=read(tracker,start+195_000,{fundingObservedAt});assert.equal(result.status,'unavailable');assert.equal(result.sampleCount,0);
    assert.equal(read(tracker,start+210_000).passes,true);
  }
});

test('public paper observations still require funding timestamps; only synthetic demo can use quote timestamps',()=>{
  const tracker=new FundingEntryStabilityTracker(),paper={...config,mode:'paper' as const};
  assert.equal(read(tracker,start,{fundingObservedAt:undefined},{fundingObservedAt:undefined},{},paper).status,'unavailable');
  assert.equal(read(tracker,start,{source:'demo',fundingObservedAt:undefined},{source:'demo',fundingObservedAt:undefined},{},paper).sampleCount,1);
});

test('same-time rate conflicts remain fenced until both original funding clocks advance',()=>{
  const tracker=new FundingEntryStabilityTracker();read(tracker,start);
  const changed={fundingObservedAt:start,fundingRate:.002};
  assert.equal(read(tracker,start+1000,{fundingObservedAt:start},changed).status,'unavailable');
  assert.equal(read(tracker,start+2000,{fundingObservedAt:start},changed).sampleCount,0);
  assert.equal(read(tracker,start+3000,{fundingObservedAt:start},{fundingRate:.002}).passes,false);
  const fresh=read(tracker,start+4000,{}, {fundingRate:.002});assert.equal(fresh.passes,true);assert.equal(fresh.sampleCount,1);
});

test('backwards observation timestamps clear confirmation and fence the previous accepted clocks',()=>{
  const tracker=new FundingEntryStabilityTracker();read(tracker,start);read(tracker,start+15_000);
  assert.equal(read(tracker,start+20_000,{fundingObservedAt:start+10_000}).status,'unavailable');
  assert.equal(read(tracker,start+25_000,{fundingObservedAt:start+15_000},{fundingObservedAt:start+20_000}).sampleCount,0);
  assert.equal(read(tracker,start+30_000).passes,true);
});

test('a far-future observation and observations from before the native current interval are unavailable',()=>{
  const tracker=new FundingEntryStabilityTracker();
  assert.equal(read(tracker,start,{fundingObservedAt:start+5001}).status,'unavailable');
  const long=quote('gate',start,{fundingObservedAt:start-1,nextFundingTime:start+hour});
  const short=quote('bybit',start,{nextFundingTime:start+hour});
  assert.equal(tracker.evaluate(opportunity(long,short),long,short,config,start).status,'unavailable');
});

test('settlement rollover does not seed a new interval using funding observed before that interval',()=>{
  const tracker=new FundingEntryStabilityTracker();assert.equal(confirmed(tracker).passes,true);
  const at=start+55*minute+1000,nextFundingTime=start+115*minute;
  const old={fundingObservedAt:start+55*minute-1000,nextFundingTime};
  assert.equal(read(tracker,at,old,old).status,'unavailable');
  const fresh=read(tracker,at,{nextFundingTime},{nextFundingTime});assert.equal(fresh.sampleCount,1);assert.equal(fresh.passes,true);
});

test('valid current settlement metadata changes do not introduce another confirmation window',()=>{
  for(const change of [{nextFundingTime:start+54*minute},{intervalHours:2}]){
    const tracker=new FundingEntryStabilityTracker();assert.equal(confirmed(tracker).passes,true);
    const result=read(tracker,start+181_000,{...change,fundingObservedAt:start+180_000},{fundingObservedAt:start+180_000});
    assert.equal(result.sampleCount,1);assert.equal(result.passes,true);assert.equal(result.observedSpanMs,0);
    assert.equal(result.evidence?.long.nextFundingTime,change.nextFundingTime??start+55*minute);
    assert.equal(result.evidence?.long.intervalHours,change.intervalHours??1);
    assert.equal(read(tracker,start+195_000,change).passes,true);
  }
});

test('a fabricated future settlement cycle cannot qualify even with fresh positive rates',()=>{
  const tracker=new FundingEntryStabilityTracker();assert.equal(confirmed(tracker).passes,true);
  const result=read(tracker,start+1000,{nextFundingTime:start+115*minute},{nextFundingTime:start+115*minute});
  assert.equal(result.status,'unavailable');assert.equal(result.passes,false);assert.equal(result.evidence,undefined);
});

test('reversing a venue pair clears its earlier direction while a different venue pair remains independent',()=>{
  const tracker=new FundingEntryStabilityTracker();assert.equal(confirmed(tracker).passes,true);
  const at=start+195_000,long=quote('bybit',at,{fundingRate:0}),short=quote('gate',at,{fundingRate:.001});
  const reversed=tracker.evaluate(opportunity(long,short),long,short,config,at);assert.equal(reversed.sampleCount,1);assert.equal(reversed.passes,true);
  assert.equal(read(tracker,start+210_000).passes,true);
  const otherLong=quote('bitget',start+225_000),otherShort=quote('bybit',start+225_000);
  assert.equal(tracker.evaluate(opportunity(otherLong,otherShort),otherLong,otherShort,config,start+225_000).passes,true);
  assert.equal(read(tracker,start+240_000).sampleCount,1);
});

test('a current snapshot rate different from the opportunity cannot inherit earlier positive evidence',()=>{
  const tracker=new FundingEntryStabilityTracker();assert.equal(confirmed(tracker).passes,true);
  const at=start+195_000,long=quote('gate',at),short=quote('bybit',at,{fundingRate:-.001});
  const stale=opportunity(long,quote('bybit',at));
  assert.equal(tracker.evaluate(stale,long,short,config,at).status,'unavailable');
  assert.equal(read(tracker,start+210_000).sampleCount,1);
});

test('a stale funding amount fails even if the original raw rate fields still match',()=>{
  const tracker=new FundingEntryStabilityTracker();assert.equal(confirmed(tracker).passes,true);
  assert.equal(read(tracker,start+195_000,{}, {},{expectedFundingUsd:.5}).status,'unavailable');
});

test('different-period funding is calculated for the paired horizon, including repeated current-rate projections',()=>{
  const tracker=new FundingEntryStabilityTracker();
  const long={nextFundingTime:start+7*hour+55*minute,intervalHours:8,fundingRate:.001};
  const short={nextFundingTime:start+55*minute,intervalHours:1,fundingRate:.001};
  const valid=read(tracker,start,long,short,{expectedFundingUsd:.7});assert.equal(valid.sampleCount,1);assert.ok(Math.abs(valid.latestFundingUsd!-.7)<1e-12);
  assert.equal(read(tracker,start+15_000,long,short,{expectedFundingUsd:0}).status,'unavailable');
});

test('non-aligned policies use their actual opportunity horizon, including a leg with no settlement before exit',()=>{
  const tracker=new FundingEntryStabilityTracker(),long={nextFundingTime:start+7*hour+55*minute,intervalHours:8};
  const result=read(tracker,start,long,{}, {entryPolicy:'funding',exitTime:start+hour,expectedFundingUsd:.1});
  assert.equal(result.sampleCount,1);assert.equal(result.latestFundingUsd,.1);
});

test('fresh duplicate observations never refresh evidence timestamps or extend funding validity',()=>{
  const tracker=new FundingEntryStabilityTracker();const first=confirmed(tracker);
  const second=read(tracker,start+10_000,{fundingObservedAt:start},{fundingObservedAt:start});
  assert.equal(second.passes,true);assert.equal(second.sampleCount,first.sampleCount);assert.equal(second.observedSpanMs,first.observedSpanMs);
  assert.deepEqual(second.evidence,first.evidence);
  assert.equal(read(tracker,start+30_001,{fundingObservedAt:start},{fundingObservedAt:start}).passes,false);
});

test('absence, forget and restart never reuse an old permission DTO but can qualify a new current pair immediately',()=>{
  for(const action of ['absent','forget','clear','expired']){
    const tracker=new FundingEntryStabilityTracker();assert.equal(confirmed(tracker).passes,true);
    if(action==='absent')tracker.invalidateMissing([],start+181_000);
    if(action==='forget')tracker.forget('KAIA-gate-bybit');
    if(action==='clear')tracker.clear();
    if(action==='expired')tracker.invalidateMissing([{id:'KAIA-gate-bybit'}],start+240_001);
    const at=start+255_000,long=quote('gate',at,{fundingObservedAt:undefined}),short=quote('bybit',at);
    const o=opportunity(long,short,{fundingEntryStability:{...confirmed(new FundingEntryStabilityTracker()),passes:true,status:'confirmed'}});
    assert.equal(tracker.evaluate(o,long,short,config,at).passes,false,'an old DTO cannot supply missing current observations');
    const fresh=read(tracker,at);assert.equal(fresh.sampleCount,1);assert.equal(fresh.passes,true);
  }
});

test('returned evidence holds only the current pair and external edits cannot alter later permission',()=>{
  const tracker=new FundingEntryStabilityTracker();let result=read(tracker,start);
  for(let i=1;i<=60;i++)result=read(tracker,start+i*15_000);
  assert.equal(result.passes,true);assert.equal(result.sampleCount,1);assert.equal(result.observedSpanMs,0);
  result.evidence!.long.fundingRate=-9;result.evidence!.samples.splice(0);
  const next=read(tracker,start+61*15_000);assert.equal(next.passes,true);assert.equal(next.evidence!.samples.length,1);
  assert.equal(next.evidence!.long.fundingRate,0);
});
