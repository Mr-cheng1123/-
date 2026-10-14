import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfig} from '../src/shared/config.js';
import type {AppConfig,ExchangeId,MarketSnapshot,Position} from '../src/shared/types.js';
import {buildFundingSchedule} from '../src/shared/funding-schedule.js';
import type {AlignedExitAssessment} from '../src/core/profit-exit.js';
import {FundingExitStabilityTracker,FUNDING_EXIT_MIN_SAMPLES,FUNDING_EXIT_HISTORY_WINDOW_MS} from '../src/core/funding-exit-stability.js';

const start=Date.parse('2026-10-03T17:06:37+08:00'),minute=60_000,hour=60*minute;
const config:AppConfig={...defaultConfig,entryPolicy:'aligned',exitWeakFundingBps:2,maxSnapshotAgeMs:30_000,pollIntervalMs:5000};
const quote=(exchange:ExchangeId,at:number,changes:Partial<MarketSnapshot>={}):MarketSnapshot=>({
  exchange,base:'MANA',symbol:'MANA/USDT:USDT',timestamp:at,observedAt:at,fundingObservedAt:at,
  markPrice:100,indexPrice:100,fundingRate:exchange==='bybit'?-.0005:0,nextFundingTime:start+hour,
  intervalHours:8,fundingHistory:[],bids:[{price:99.99,quantity:100}],asks:[{price:100.01,quantity:100}],
  quantityStep:.001,minQuantity:.001,minNotional:1,contractSize:1,openInterestUsd:0,volume24hUsd:0,
  source:'public',bookTransport:'rest',...changes});
const position=():Position=>({id:'mana-stability',base:'MANA',mode:'live',status:'open',entryPolicy:'aligned',holdMode:'adaptive',
  long:{exchange:'bitget',symbol:'MANA/USDT:USDT',side:'long',quantity:1,entryPrice:100,markPrice:100,feesUsd:.05,liquidationDistancePct:null},
  short:{exchange:'bybit',symbol:'MANA/USDT:USDT',side:'short',quantity:1,entryPrice:100,markPrice:100,feesUsd:.05,liquidationDistancePct:null},
  openedAt:start-1000,plannedExitAt:start+hour,feesUsd:.1,fundingUsd:.4,transferCostUsd:0,spreadPnlUsd:0,
  realizedSpreadPnlUsd:0,netPnlUsd:.3,deltaUsd:0,fundingEvents:[],riskReasons:[]});
function assessment(p:Position,long:MarketSnapshot,short:MarketSnapshot,now:number):AlignedExitAssessment {
  const longValue=p.long.quantity*long.markPrice,shortValue=p.short.quantity*short.markPrice;
  const fundingSchedule=buildFundingSchedule({...long,notionalUsd:longValue},{...short,notionalUsd:shortValue},{now});
  return {fundingSchedule,expectedFundingUsd:fundingSchedule.totalUsd,
    expectedFundingBps:fundingSchedule.totalUsd/((longValue+shortValue)/2)*10_000,
    targetFundingTime:Math.max(long.nextFundingTime,short.nextFundingTime),passes:true,reason:'raw current carry and close profit pass'};
}
function read(tracker:FundingExitStabilityTracker,p:Position,at:number,
  longChanges:Partial<MarketSnapshot>={},shortChanges:Partial<MarketSnapshot>={},c=config){
  const long=quote('bitget',at,longChanges),short=quote('bybit',at,shortChanges);
  return tracker.evaluate(p,long,short,assessment(p,long,short,at),c,at);
}
function directConfirmed(tracker:FundingExitStabilityTracker,p=position()){
  let result=read(tracker,p,start);
  for(const offset of [45_000,90_000,135_000,180_000])result=read(tracker,p,start+offset);
  return result;
}
const projection=(payAt:number)=>({long:{fundingRate:-.005,nextFundingTime:payAt+6*hour,intervalHours:8},
  short:{fundingRate:-.001,nextFundingTime:payAt,intervalHours:1}});

test('direct economic disadvantage needs five independent pairs and at least three minutes, independent of profit',()=>{
  const tracker=new FundingExitStabilityTracker(),p=position(),before=JSON.stringify(p);
  for(const offset of [0,45_000,90_000,135_000]){
    const result=read(tracker,p,start+offset);assert.equal(result.passes,false);assert.equal(result.status,'observing');
    assert.equal(result.requiredSamples,5);assert.equal(result.requiredSpanMs,180_000);
  }
  const long=quote('bitget',start+180_000),short=quote('bybit',start+180_000);
  const raw=assessment(p,long,short,start+180_000);raw.passes=false;raw.profit=undefined;
  const result=tracker.evaluate(p,long,short,raw,config,start+180_000);
  assert.equal(result.status,'confirmed');assert.equal(result.passes,true);
  assert.equal(result.sampleCount,5);assert.equal(result.observedSpanMs,180_000);assert.equal(result.medianBps,-5);
  assert.equal(JSON.stringify(p),before,'forecast and observations never modify cash, orders or positions');
});

test('one thousand WebSocket book events do not turn the same funding read into new evidence',()=>{
  const tracker=new FundingExitStabilityTracker(),p=position();
  for(let index=0;index<1000;index++){
    const at=start+index*10,result=read(tracker,p,at,
      {bookTransport:'websocket',bookGeneration:index+1,fundingObservedAt:start},
      {bookTransport:'websocket',bookGeneration:index+1,fundingObservedAt:start});
    assert.equal(result.sampleCount,1);assert.equal(result.observedSpanMs,0);assert.equal(result.passes,false);
  }
});

test('both fee observation clocks must advance and accepted pairs are at least fifteen seconds apart',()=>{
  const tracker=new FundingExitStabilityTracker(),p=position();read(tracker,p,start);
  for(const offset of [1000,5000,14_999])assert.equal(read(tracker,p,start+offset).sampleCount,1);
  assert.equal(read(tracker,p,start+15_000).sampleCount,2);
  assert.equal(read(tracker,p,start+30_000,{fundingObservedAt:start+30_000},{fundingObservedAt:start+15_000}).sampleCount,2);
  const both=read(tracker,p,start+40_000,{fundingObservedAt:start+30_000},{fundingObservedAt:start+40_000});
  assert.equal(both.sampleCount,3);assert.equal(both.observedSpanMs,30_000,'the slower independent clock sets the span');
});

test('a funding value changed at an unchanged read timestamp clears history and cannot seed on a repeated book event',()=>{
  const tracker=new FundingExitStabilityTracker(),p=position();read(tracker,p,start);
  const changed=read(tracker,p,start+1000,{fundingObservedAt:start},{fundingObservedAt:start,fundingRate:-.001});
  assert.equal(changed.status,'unavailable');assert.equal(changed.sampleCount,0);assert.equal(changed.passes,false);
  const repeated=read(tracker,p,start+2000,{fundingObservedAt:start},{fundingObservedAt:start,fundingRate:-.001});
  assert.equal(repeated.sampleCount,0);assert.equal(repeated.passes,false);
  const renewed=read(tracker,p,start+15_000,{}, {fundingRate:-.001});assert.equal(renewed.sampleCount,1);
});

test('a fresh positive read immediately cancels a previously confirmed adverse window',()=>{
  const tracker=new FundingExitStabilityTracker(),p=position();assert.equal(directConfirmed(tracker,p).passes,true);
  const recovered=read(tracker,p,start+195_000,{}, {fundingRate:.0001});
  assert.equal(recovered.status,'positive');assert.equal(recovered.passes,false);assert.equal(recovered.sampleCount,0);
  const nextBad=read(tracker,p,start+210_000);assert.equal(nextBad.sampleCount,1);assert.equal(nextBad.passes,false);
});

test('zero and exactly the configured negative neutral-band boundary do not exit, even after old confirmation',()=>{
  for(const fundingRate of [0,-.0002,-.0000001]){
    const tracker=new FundingExitStabilityTracker(),p=position();assert.equal(directConfirmed(tracker,p).passes,true);
    const result=read(tracker,p,start+195_000,{}, {fundingRate});
    assert.equal(result.status,'neutral');assert.equal(result.passes,false);assert.equal(result.sampleCount,0);
    assert.equal(result.neutralBandBps,2);
  }
  const custom={...config,exitWeakFundingBps:5},tracker=new FundingExitStabilityTracker(),p=position();
  assert.equal(read(tracker,p,start,{}, {},custom).status,'neutral');
  assert.equal(read(tracker,p,start+15_000,{}, {fundingRate:-.00051},custom).sampleCount,1);
});

test('the MANA recorded seven-hour projection alone cannot cause the 17:06 close and its 17:48 recovery clears it',()=>{
  const tracker=new FundingExitStabilityTracker(),p=position();p.long.quantity=p.short.quantity=948;
  const nextShort=Date.parse('2026-10-03T18:00:00+08:00'),nextLong=Date.parse('2026-10-04T00:00:00+08:00');
  const value=948*.1017;
  const long={markPrice:.1017,indexPrice:.1017,fundingRate:-.36840457416/value,nextFundingTime:nextLong,intervalHours:8};
  const short={markPrice:.1017,indexPrice:.1017,fundingRate:-.057505880502/value,nextFundingTime:nextShort,intervalHours:1};
  const first=read(tracker,p,start,long,short);
  assert.equal(first.status,'observing');assert.equal(first.passes,false);
  assert.ok(first.observedNextNetUsd!>0);assert.ok(first.projectedNetUsd!<0);
  assert.ok(Math.abs(first.observedNextNetUsd!-.310898693658)<1e-10);
  assert.ok(Math.abs(first.projectedNetUsd!+.345035283012)<1e-10);
  assert.equal(first.requiredSpanMs,600_000);assert.equal(first.nextPaymentAt,nextShort);
  let stable=first;
  for(let offset=minute;offset<=10*minute;offset+=minute)stable=read(tracker,p,start+offset,long,short);
  assert.equal(stable.status,'projection-wait');assert.equal(stable.passes,false,'far-off unknown hourly rates are not immediate exit permission');
  const recovered=read(tracker,p,Date.parse('2026-10-03T17:48:22+08:00'),
    {...long,markPrice:.10319,fundingRate:-.003559},{...short,markPrice:.1033,fundingRate:.000012});
  assert.equal(recovered.status,'positive');assert.equal(recovered.passes,false);assert.equal(recovered.sampleCount,0);
});

test('projection-only disadvantage may exit after ten minutes when the next observed payment is within five minutes',()=>{
  const tracker=new FundingExitStabilityTracker(),p=position(),rates=projection(start+15*minute);
  let result=read(tracker,p,start,rates.long,rates.short);
  for(let offset=minute;offset<10*minute;offset+=minute){
    result=read(tracker,p,start+offset,rates.long,rates.short);assert.equal(result.passes,false);
  }
  result=read(tracker,p,start+10*minute,rates.long,rates.short);
  assert.equal(result.status,'confirmed');assert.equal(result.passes,true);assert.equal(result.observedSpanMs,10*minute);
  assert.equal(result.requiredSpanMs,10*minute);assert.equal(result.nextPaymentAt,start+15*minute);
});

test('projection qualification cannot use a distant payment or a settled clock and cannot shortcut the ten-minute span',()=>{
  const p=position(),far=new FundingExitStabilityTracker(),rates=projection(start+30*minute);
  let result=read(far,p,start,rates.long,rates.short);
  for(let offset=minute;offset<=10*minute;offset+=minute)result=read(far,p,start+offset,rates.long,rates.short);
  assert.equal(result.status,'projection-wait');assert.equal(result.passes,false);
  for(let offset=11*minute;offset<=25*minute;offset+=minute)result=read(far,p,start+offset,rates.long,rates.short);
  assert.equal(result.passes,true,'a sustained projected loss eventually qualifies when actual next payment is near');
  const near=new FundingExitStabilityTracker(),nearRates=projection(start+12*minute);
  for(let offset=0;offset<=9*minute;offset+=minute)read(near,p,start+offset,nearRates.long,nearRates.short);
  result=read(near,p,start+10*minute-1,nearRates.long,nearRates.short);
  assert.equal(result.passes,false);assert.equal(result.observedSpanMs,10*minute-1);
  result=read(near,p,start+12*minute,nearRates.long,nearRates.short);
  assert.equal(result.status,'unavailable');assert.equal(result.passes,false,'an elapsed native clock is unknown, not a future payment');
});

test('confirmation gaps beyond ninety seconds restart the window, while exactly ninety seconds remains valid',()=>{
  const p=position(),tracker=new FundingExitStabilityTracker();read(tracker,p,start);read(tracker,p,start+45_000);
  const afterGap=read(tracker,p,start+135_001);assert.equal(afterGap.sampleCount,1);assert.equal(afterGap.observedSpanMs,0);
  const exact=new FundingExitStabilityTracker();
  for(const offset of [0,90_000,180_000,195_000])assert.equal(read(exact,p,start+offset).passes,false);
  assert.equal(read(exact,p,start+210_000).passes,true);
});

test('live missing or stale independent fee timestamps fail closed; paper REST snapshots can use observation timestamps',()=>{
  for(const changes of [{fundingObservedAt:undefined},{fundingObservedAt:NaN},{fundingObservedAt:0},
    {fundingObservedAt:start-30_001},{fundingObservedAt:start+5001},{observedAt:start-30_001}]){
    const tracker=new FundingExitStabilityTracker(),result=read(tracker,position(),start,changes);
    assert.equal(result.status,'unavailable');assert.equal(result.passes,false);assert.equal(result.sampleCount,0);
  }
  const paper=position();paper.mode='paper';
  const result=read(new FundingExitStabilityTracker(),paper,start,{fundingObservedAt:undefined},{fundingObservedAt:undefined});
  assert.equal(result.status,'observing');assert.equal(result.sampleCount,1);
});

test('funding clocks, interval, source, market or neutral-band changes invalidate old confirmation',()=>{
  for(const change of ['clock','interval','source','market','band']){
    const tracker=new FundingExitStabilityTracker(),p=position();assert.equal(directConfirmed(tracker,p).passes,true);
    let l:Partial<MarketSnapshot>={},s:Partial<MarketSnapshot>={},c=config;
    if(change==='clock')l=s={nextFundingTime:start+2*hour};
    if(change==='interval')l=s={intervalHours:4};
    if(change==='source')l=s={source:'demo'};
    if(change==='market'){p.long.symbol=p.short.symbol='MANA2/USDT:USDT';l=s={symbol:p.long.symbol};}
    if(change==='band')c={...config,exitWeakFundingBps:3};
    const reset=read(tracker,p,start+195_000,l,s,c);
    assert.equal(reset.sampleCount,1,change);assert.equal(reset.passes,false,change);assert.equal(reset.observedSpanMs,0,change);
  }
});

test('unchanged quote funding timestamps or an assessment for old rates cannot reuse a cached confirmation after a final update',()=>{
  const tracker=new FundingExitStabilityTracker(),p=position();assert.equal(directConfirmed(tracker,p).passes,true);
  const oldLong=quote('bitget',start+180_000),oldShort=quote('bybit',start+180_000),old=assessment(p,oldLong,oldShort,start+180_000);
  const newLong=quote('bitget',start+195_000),newShort=quote('bybit',start+195_000,{fundingRate:.001});
  const staleAssessment=tracker.evaluate(p,newLong,newShort,old,config,start+195_000);
  assert.equal(staleAssessment.status,'unavailable');assert.equal(staleAssessment.passes,false);
  const current=tracker.evaluate(p,newLong,newShort,assessment(p,newLong,newShort,start+195_000),config,start+195_000);
  assert.equal(current.status,'positive');assert.equal(current.sampleCount,0);assert.equal(current.passes,false);
});

test('a short book outage cannot authorize a close or add funding samples, but valid history survives it',()=>{
  const tracker=new FundingExitStabilityTracker(),p=position();assert.equal(directConfirmed(tracker,p).passes,true);
  const metadata={fundingObservedAt:start+180_000};
  const result=read(tracker,p,start+195_000,{...metadata,bookTransport:'websocket',observedAt:start+180_000},metadata);
  assert.equal(result.status,'unavailable');assert.equal(result.sampleCount,5);assert.equal(result.passes,false);
  assert.equal(result.lastObservedAt,start+180_000);assert.equal(result.latestBps,undefined);
  assert.equal(result.observedNextNetUsd,undefined);assert.match(result.reason,/保留 90 秒/);
  const restored=read(tracker,p,start+196_000,metadata,metadata);
  assert.equal(restored.sampleCount,5);assert.equal(restored.passes,true,'restoring the book does not create a funding sample');
});

test('a missing assessment retains a short compatible funding window, and recovery in rates still cancels permission',()=>{
  for(const rate of [.0001,-.0001]){
    const tracker=new FundingExitStabilityTracker(),p=position();assert.equal(directConfirmed(tracker,p).passes,true);
    const at=start+195_000,long=quote('bitget',at),short=quote('bybit',at,{fundingRate:rate});
    const unavailable=tracker.evaluate(p,long,short,undefined,config,at);
    assert.equal(unavailable.status,'unavailable');assert.equal(unavailable.sampleCount,0);assert.equal(unavailable.passes,false);
    assert.equal(unavailable.latestBps,undefined,'no unavailable current assessment is published as current economics');
    const recovered=tracker.evaluate(p,long,short,assessment(p,long,short,at+1000),config,at+1000);
    assert.equal(recovered.status,rate>0?'positive':'neutral');assert.equal(recovered.sampleCount,0);assert.equal(recovered.passes,false);
  }
});

test('positive or neutral independent rates during a book outage cancel old negative samples before rates turn adverse again',()=>{
  for(const rate of [.0001,-.0001]){
    const tracker=new FundingExitStabilityTracker(),p=position();assert.equal(directConfirmed(tracker,p).passes,true);
    const unavailable=read(tracker,p,start+195_000,{bookTransport:'websocket',observedAt:start+180_000},{fundingRate:rate});
    assert.equal(unavailable.status,'unavailable');assert.equal(unavailable.sampleCount,0);assert.equal(unavailable.passes,false);
    const adverseAgain=read(tracker,p,start+210_000);
    assert.equal(adverseAgain.sampleCount,1);assert.equal(adverseAgain.observedSpanMs,0);assert.equal(adverseAgain.passes,false);
  }
  // This reversal keeps the projected-only classification, so cycle changes alone cannot cancel it.
  const tracker=new FundingExitStabilityTracker(),p=position(),rates=projection(start+15*minute);
  let result=read(tracker,p,start,rates.long,rates.short);
  for(let offset=minute;offset<=10*minute;offset+=minute)result=read(tracker,p,start+offset,rates.long,rates.short);
  assert.equal(result.passes,true);
  const unavailable=read(tracker,p,start+10*minute+15_000,
    {...rates.long,bookTransport:'websocket',observedAt:start+10*minute},{...rates.short,fundingRate:.001});
  assert.equal(unavailable.sampleCount,0);assert.equal(unavailable.passes,false);
  const adverseAgain=read(tracker,p,start+10*minute+30_000,rates.long,rates.short);
  assert.equal(adverseAgain.sampleCount,1);assert.equal(adverseAgain.observedSpanMs,0);assert.equal(adverseAgain.passes,false);
});

test('projected-only to direct disadvantage starts a new three-minute window instead of borrowing old projected samples',()=>{
  const tracker=new FundingExitStabilityTracker(),p=position(),rates=projection(start+30*minute);
  for(let offset=0;offset<=4*minute;offset+=minute)read(tracker,p,start+offset,rates.long,rates.short);
  const direct=read(tracker,p,start+4*minute+15_000,{...rates.long,fundingRate:-.001},{...rates.short,fundingRate:-.002});
  assert.ok(direct.observedNextNetUsd!<0);assert.equal(direct.requiredSpanMs,3*minute);
  assert.equal(direct.sampleCount,1);assert.equal(direct.observedSpanMs,0);assert.equal(direct.passes,false);
});

test('direct to projected-only disadvantage starts a new ten-minute window instead of retaining direct confirmation',()=>{
  const tracker=new FundingExitStabilityTracker(),p=position(),rates=projection(start+30*minute);
  let direct=read(tracker,p,start,{...rates.long,fundingRate:0},rates.short);
  for(const offset of [45_000,90_000,135_000,180_000])direct=read(tracker,p,start+offset,{...rates.long,fundingRate:0},rates.short);
  assert.equal(direct.passes,true);
  const projected=read(tracker,p,start+195_000,rates.long,rates.short);
  assert.ok(projected.observedNextNetUsd!>0);assert.equal(projected.requiredSpanMs,10*minute);
  assert.equal(projected.sampleCount,1);assert.equal(projected.observedSpanMs,0);assert.equal(projected.passes,false);
});

test('short unavailable books retain no history if funding metadata itself is invalid, changed, regressed or conflicting',()=>{
  for(const change of ['missing-time','stale-time','clock','period','source','symbol','band','same-time-rate','backwards']){
    const tracker=new FundingExitStabilityTracker(),p=position();assert.equal(directConfirmed(tracker,p).passes,true);
    const at=start+195_000,long=quote('bitget',at,{bookTransport:'websocket',observedAt:start+180_000}),short=quote('bybit',at);
    let c=config;
    if(change==='missing-time')long.fundingObservedAt=undefined;
    if(change==='stale-time')long.fundingObservedAt=at-30_001;
    if(change==='clock')long.nextFundingTime+=hour;
    if(change==='period')long.intervalHours=4;
    if(change==='source')long.source=short.source='demo';
    if(change==='symbol')long.symbol='OTHER/USDT:USDT';
    if(change==='band')c={...config,exitWeakFundingBps:3};
    if(change==='same-time-rate'){short.fundingObservedAt=start+180_000;short.fundingRate=-.001;}
    if(change==='backwards')short.fundingObservedAt=start+179_000;
    const result=tracker.evaluate(p,long,short,undefined,c,at);
    assert.equal(result.status,'unavailable',change);assert.equal(result.sampleCount,0,change);assert.equal(result.passes,false,change);
  }
});

test('an unavailable book lasting more than ninety seconds clears the otherwise valid funding window',()=>{
  const tracker=new FundingExitStabilityTracker(),p=position();assert.equal(directConfirmed(tracker,p).passes,true);
  const at=start+270_000,long=quote('bitget',at),short=quote('bybit',at);
  assert.equal(tracker.evaluate(p,long,short,undefined,config,at).sampleCount,5,'ninety seconds is allowed');
  const expiredAt=at+1,expiredLong=quote('bitget',expiredAt),expiredShort=quote('bybit',expiredAt);
  const expired=tracker.evaluate(p,expiredLong,expiredShort,undefined,config,expiredAt);
  assert.equal(expired.sampleCount,0);assert.equal(expired.passes,false);
  assert.equal(read(tracker,p,expiredAt+15_000).sampleCount,1);
});

test('a funding timestamp regression clears confirmation without counting the replayed read',()=>{
  const tracker=new FundingExitStabilityTracker(),p=position();read(tracker,p,start);read(tracker,p,start+15_000);
  const regressed=read(tracker,p,start+20_000,{fundingObservedAt:start+10_000},{fundingObservedAt:start+10_000});
  assert.equal(regressed.status,'unavailable');assert.equal(regressed.sampleCount,0);
  assert.equal(read(tracker,p,start+25_000,{fundingObservedAt:start+15_000},{fundingObservedAt:start+15_000}).sampleCount,0);
  assert.equal(read(tracker,p,start+30_000).sampleCount,1);
});

test('bounded fifteen-minute history, forget, clear and a new tracker never manufacture restart permission',()=>{
  const tracker=new FundingExitStabilityTracker(),p=position();let result=read(tracker,p,start);
  for(let offset=15_000;offset<=30*minute;offset+=15_000)result=read(tracker,p,start+offset);
  assert.equal(result.passes,true);assert.ok(result.sampleCount<=61);assert.ok(result.observedSpanMs<=FUNDING_EXIT_HISTORY_WINDOW_MS);
  tracker.forget(p.id);assert.equal(read(tracker,p,start+30*minute+15_000).sampleCount,1);
  tracker.clear();assert.equal(read(tracker,p,start+30*minute+30_000).sampleCount,1);
  assert.equal(read(new FundingExitStabilityTracker(),p,start+30*minute+45_000).passes,false);
  assert.equal(FUNDING_EXIT_MIN_SAMPLES,5);
});

test('invalid configured neutral bands and missing current assessments are unavailable, never zero or profitable evidence',()=>{
  for(const band of [-1,NaN,Infinity])assert.equal(read(new FundingExitStabilityTracker(),position(),start,{}, {},{...config,exitWeakFundingBps:band}).status,'unavailable');
  for(const age of [-1,0,NaN,Infinity]){
    const tracker=new FundingExitStabilityTracker(),p=position();assert.equal(directConfirmed(tracker,p).passes,true);
    const long=quote('bitget',start+195_000),short=quote('bybit',start+195_000);
    assert.equal(tracker.evaluate(p,long,short,undefined,{...config,maxSnapshotAgeMs:age},start+195_000).sampleCount,0);
    assert.equal(read(tracker,p,start+210_000).sampleCount,1,'invalid metadata freshness configuration clears the window');
  }
  const p=position(),tracker=new FundingExitStabilityTracker();assert.equal(directConfirmed(tracker,p).passes,true);
  const unavailable=tracker.evaluate(p,quote('bitget',start+195_000),quote('bybit',start+195_000),undefined,config,start+195_000);
  assert.equal(unavailable.passes,false);assert.equal(unavailable.sampleCount,5);
  assert.equal(read(tracker,p,start+210_000).sampleCount,6);
});
