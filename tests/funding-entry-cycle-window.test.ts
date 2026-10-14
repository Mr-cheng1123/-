import test from 'node:test';
import assert from 'node:assert/strict';
import {buildFundingSchedule,type FundingScheduleLeg} from '../src/shared/funding-schedule.js';

const at=(time:string)=>Date.parse(`2026-10-03T${time}+08:00`);
const near=(value:number,expected:number)=>assert.ok(Math.abs(value-expected)<1e-10,`${value} != ${expected}`);
const big:FundingScheduleLeg={exchange:'bitget',side:'long',notionalUsd:100,fundingRate:-.010993,
  intervalHours:8,nextFundingTime:at('16:00:00')};
const small:FundingScheduleLeg={exchange:'bybit',side:'short',notionalUsd:100,fundingRate:-.000859,
  intervalHours:1,nextFundingTime:at('15:00:00')};

test('an hourly payment opens only in the final hour of the observed common eight-hour cycle',()=>{
  const schedule=buildFundingSchedule(big,small,{now:at('14:05:00')});
  assert.equal(schedule.valid,true);assert.equal(schedule.entryReady,false);
  const {smallCashUsd,...window}=schedule.entryWindow!;near(smallCashUsd,-.0859);
  assert.deepEqual(window,{
    kind:'last-payment',startTime:at('15:00:10'),endTime:at('15:59:50'),settlementTime:at('16:00:00'),
    cycleStart:at('08:00:00'),cycleEnd:at('16:00:00'),smallIntervalHours:1,smallExchange:'bybit',
    smallSide:'short',phase:'before'
  });
  assert.equal(schedule.recommendedEntryAt,at('15:00:10'));
  near(schedule.nextEventUsd,-.0859);near(schedule.totalUsd,.9275);
  assert.equal(schedule.events.length,2,'window restrictions never rewrite the current cash forecast');
});

test('the final payment window requires fresh rolled clocks and excludes both settlement boundary margins',()=>{
  const rolled={...small,nextFundingTime:at('16:00:00')};
  for(const [time,ready,phase] of [
    ['15:00:05',false,'before'],['15:00:09',false,'before'],['15:00:10',true,'open'],
    ['15:59:49',true,'open'],['15:59:50',false,'after'],['15:59:55',false,'after']
  ] as const){
    const schedule=buildFundingSchedule(big,rolled,{now:at(time),exitDelaySec:0});
    assert.equal(schedule.entryReady,ready,time);assert.equal(schedule.entryWindow!.phase,phase,time);
    near(schedule.totalUsd,1.0134);
    if(phase==='after'){
      assert.equal(schedule.entryWindow!.nextStartTime,at('23:00:10'));
      assert.equal(schedule.entryWindow!.nextEndTime,at('23:59:50'));
      assert.equal(schedule.recommendedEntryAt,at('23:00:10'));
    }
  }
  const oldClock=buildFundingSchedule(big,small,{now:at('15:00:10')});
  assert.equal(oldClock.valid,false);assert.equal(oldClock.entryReady,false);
});

test('an hourly receipt opens only before the first small settlement after the common-cycle boundary',()=>{
  const receipt={...small,fundingRate:.000859,nextFundingTime:at('09:00:00')};
  const schedule=buildFundingSchedule(big,receipt,{now:at('08:15:00')});
  assert.equal(schedule.entryReady,true);
  const {smallCashUsd,...window}=schedule.entryWindow!;near(smallCashUsd,.0859);
  assert.deepEqual(window,{
    kind:'first-receipt',startTime:at('08:00:10'),endTime:at('08:59:50'),settlementTime:at('09:00:00'),
    cycleStart:at('08:00:00'),cycleEnd:at('16:00:00'),smallIntervalHours:1,smallExchange:'bybit',
    smallSide:'short',phase:'open'
  });
  assert.equal(schedule.nextEventTime,at('09:00:00'));
  near(schedule.nextEventUsd,.0859);assert.equal(schedule.shortCount,8);
});

test('the receipt window has a post-common-settlement grace and a pre-first-settlement cutoff',()=>{
  const receipt={...small,fundingRate:.000859,nextFundingTime:at('09:00:00')};
  for(const [time,ready,phase] of [
    ['08:00:05',false,'before'],['08:00:10',true,'open'],['08:59:49',true,'open'],
    ['08:59:50',false,'after']
  ] as const){
    const schedule=buildFundingSchedule(big,receipt,{now:at(time)});
    assert.equal(schedule.entryReady,ready,time);assert.equal(schedule.entryWindow!.phase,phase,time);
  }
});

test('a receipt opportunity midway through the common cycle waits for the next first window',()=>{
  const receipt={...small,fundingRate:.000859,nextFundingTime:at('14:00:00')};
  const schedule=buildFundingSchedule(big,receipt,{now:at('13:44:49')});
  assert.equal(schedule.entryReady,false);assert.equal(schedule.entryWindow!.phase,'after');
  assert.equal(schedule.entryWindow!.startTime,at('08:00:10'));
  assert.equal(schedule.entryWindow!.endTime,at('08:59:50'));
  assert.equal(schedule.entryWindow!.nextStartTime,at('16:00:10'));
  assert.equal(schedule.entryWindow!.nextEndTime,at('16:59:50'));
  assert.equal(schedule.recommendedEntryAt,at('16:00:10'));
  assert.equal(schedule.endTime,at('16:00:00'),'current forecast does not pretend to be a next-cycle rate forecast');
  near(schedule.nextEventUsd,.0859);
});

test('a new common cycle is located from fresh native clocks rather than from a fixed eight or sixteen oclock',()=>{
  const nextBig={...big,nextFundingTime:at('24:00:00')};
  const nextSmall={...small,fundingRate:.000859,nextFundingTime:at('17:00:00')};
  const schedule=buildFundingSchedule(nextBig,nextSmall,{now:at('16:00:10')});
  assert.equal(schedule.entryReady,true);assert.equal(schedule.entryWindow!.cycleStart,at('16:00:00'));
  assert.equal(schedule.entryWindow!.startTime,at('16:00:10'));
  assert.equal(schedule.entryWindow!.endTime,at('16:59:50'));
});

test('receipt and payment classify the held side cash sign, including a small long and a large short',()=>{
  const largeShort={...big,side:'short' as const,fundingRate:.010993};
  const smallLong={...small,side:'long' as const,fundingRate:.000859};
  const payment=buildFundingSchedule([smallLong,largeShort],{now:at('14:05:00')});
  assert.equal(payment.entryWindow!.kind,'last-payment');assert.equal(payment.entryWindow!.smallSide,'long');
  near(payment.entryWindow!.smallCashUsd,-.0859);assert.equal(payment.entryReady,false);
  const receipt=buildFundingSchedule([largeShort,{...smallLong,fundingRate:-.000859,nextFundingTime:at('09:00:00')}],
    {now:at('08:15:00')});
  assert.equal(receipt.entryWindow!.kind,'first-receipt');near(receipt.entryWindow!.smallCashUsd,.0859);
  assert.equal(receipt.entryReady,true);
});

test('first and last windows support native four-hour and two-hour intervals without hardcoded hour edges',()=>{
  const large={...big,intervalHours:8};
  const twoHour={...small,intervalHours:2,nextFundingTime:at('14:00:00')};
  const payment=buildFundingSchedule(large,twoHour,{now:at('12:30:00')});
  assert.equal(payment.entryWindow!.startTime,at('14:00:10'));
  assert.equal(payment.entryWindow!.endTime,at('15:59:50'));assert.equal(payment.entryReady,false);
  const receipt=buildFundingSchedule({...large,intervalHours:4},
    {...twoHour,fundingRate:.000859},{now:at('12:30:00')});
  assert.equal(receipt.entryWindow!.cycleStart,at('12:00:00'));
  assert.equal(receipt.entryWindow!.startTime,at('12:00:10'));
  assert.equal(receipt.entryWindow!.endTime,at('13:59:50'));assert.equal(receipt.entryReady,true);
});

test('different phases and noninteger ratios retain event fallback without inventing a common cycle',()=>{
  for(const smaller of [{...small,nextFundingTime:at('15:30:00')},{...small,intervalHours:3}]){
    const schedule=buildFundingSchedule(big,smaller,{now:at('14:05:00')});
    assert.equal(schedule.valid,true);assert.equal(schedule.entryWindow,undefined);
    assert.equal(schedule.entryReady,false);assert.equal(schedule.events.length,2);
    assert.equal(schedule.recommendedEntryAt,smaller.nextFundingTime+10_000);
  }
});

test('a future previous clock cannot be treated as proof that the current common cycle has started',()=>{
  const schedule=buildFundingSchedule({...big,nextFundingTime:at('24:00:00')},small,{now:at('14:05:00')});
  assert.equal(schedule.valid,true);assert.equal(schedule.entryWindow,undefined);
  assert.equal(schedule.entryReady,false);
});

test('equal intervals, a zero small funding cash and single-leg holdings acquire no common-cycle entry window',()=>{
  const synchronous=buildFundingSchedule(big,{...small,intervalHours:8,nextFundingTime:at('16:00:00')},
    {now:at('13:44:49')});
  assert.equal(synchronous.entryWindow,undefined);assert.equal(synchronous.entryReady,true);
  const zeroSmall=buildFundingSchedule(big,{...small,fundingRate:0},{now:at('14:05:00')});
  assert.equal(zeroSmall.entryWindow,undefined);assert.equal(zeroSmall.entryReady,true);
  const single=buildFundingSchedule([big],{now:at('14:05:00')});
  assert.equal(single.entryWindow,undefined);assert.equal(single.entryReady,true);
});

test('explicit anytime mode preserves window evidence while bypassing the new-entry timing restriction',()=>{
  const schedule=buildFundingSchedule(big,{...small,fundingRate:.000859,nextFundingTime:at('14:00:00')},
    {now:at('13:44:49'),entryTiming:'anytime'});
  assert.equal(schedule.entryReady,true);assert.equal(schedule.entryWindow!.kind,'first-receipt');
  assert.equal(schedule.entryWindow!.phase,'after');assert.equal(schedule.entryWindow!.nextStartTime,at('16:00:10'));
});

test('a fresh funding interval change recomputes timing and removes the obsolete asynchronous window',()=>{
  const now=at('14:05:00');
  const before=buildFundingSchedule(big,small,{now});assert.equal(before.entryReady,false);
  const after=buildFundingSchedule({...big,intervalHours:1,nextFundingTime:at('15:00:00')},small,{now});
  assert.equal(after.entryWindow,undefined);assert.equal(after.asynchronous,false);assert.equal(after.entryReady,true);
  assert.equal(after.events.length,1);near(after.totalUsd,1.0134);
});
