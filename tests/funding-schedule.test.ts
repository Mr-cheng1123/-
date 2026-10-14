import test from 'node:test';
import assert from 'node:assert/strict';
import {buildFundingSchedule,type FundingScheduleLeg} from '../src/shared/funding-schedule.js';
import {defaultConfig,validateConfig} from '../src/shared/config.js';
import {configUpdatePolicy} from '../src/shared/config-update-policy.js';
const at=(time:string)=>Date.parse(`2026-10-03T${time}+08:00`),now=at('14:05:00');
const long:FundingScheduleLeg={side:'long',exchange:'bitget',notionalUsd:100,fundingRate:-.010993,nextFundingTime:at('16:00:00'),intervalHours:8};
const short:FundingScheduleLeg={side:'short',exchange:'bybit',notionalUsd:100,fundingRate:-.000859,nextFundingTime:at('15:00:00'),intervalHours:1};
const near=(value:number,expected:number)=>assert.ok(Math.abs(value-expected)<1e-10,`${value} != ${expected}`);

test('nearest payment and complete-cycle income have separate timestamps, amounts and repeated-rate evidence',()=>{
  const schedule=buildFundingSchedule(long,short,{now});
  assert.equal(schedule.valid,true);assert.equal(schedule.nextEventTime,at('15:00:00'));
  assert.equal(schedule.endTime,at('16:00:00'));near(schedule.nextEventUsd,-.0859);near(schedule.totalUsd,.9275);
  assert.equal(schedule.events.length,2);assert.equal(schedule.events[0].projected,false);assert.equal(schedule.events[1].projected,true);
  assert.equal(schedule.longCount,1);assert.equal(schedule.shortCount,2);near(schedule.minCumulativeUsd,-.0859);
  assert.equal(schedule.entryReady,false);assert.equal(schedule.recommendedEntryAt,at('15:00:10'));
});

test('past payment is not repeated after clocks roll and the grace never alters projected funding',()=>{
  const rolled={...short,nextFundingTime:at('16:00:00')};
  const before=buildFundingSchedule(long,rolled,{now:at('15:00:09')});
  const ready=buildFundingSchedule(long,rolled,{now:at('15:00:10')});
  assert.equal(before.entryReady,false);assert.equal(ready.entryReady,true);near(before.totalUsd,1.0134);near(ready.totalUsd,1.0134);
  assert.equal(before.events.length,1);assert.equal(before.hasRepeatedRate,false);
});

test('single-leg real positions have a forecast without a fabricated zero opposite leg or asynchronous gate',()=>{
  const schedule=buildFundingSchedule([long],{now});
  assert.equal(schedule.valid,true);assert.equal(schedule.asynchronous,false);assert.equal(schedule.events.length,1);
  near(schedule.totalUsd,1.0993);assert.equal(schedule.longCount,1);assert.equal(schedule.shortCount,0);
});

test('net same-time previous receipt and payment do not create an individual expense grace barrier',()=>{
  const a={...long,intervalHours:1},b={...short,nextFundingTime:at('16:00:00')};
  const schedule=buildFundingSchedule(a,b,{now:at('15:00:05')});
  assert.equal(schedule.entryReady,true);assert.equal(schedule.recommendedEntryAt,undefined);
});

test('unknown, expired and unbounded clocks never produce a ready or partial funding plan',()=>{
  for(const leg of [{...short,nextFundingTime:now},{...short,intervalHours:NaN},{...short,fundingRate:NaN},
    {...short,notionalUsd:Infinity},{...short,intervalHours:1/3600000},{...short,nextFundingTime:NaN}]){
    const schedule=buildFundingSchedule(long,leg,{now});assert.equal(schedule.valid,false);
    assert.equal(schedule.entryReady,false);assert.deepEqual(schedule.events,[]);assert.match(schedule.reason,/未知现金流/);
  }
});

test('optional new-entry timing policy preserves absent saved configuration and does not modify active-position policy',()=>{
  const original=validateConfig({...defaultConfig}),after=validateConfig({...original,asyncFundingEntryTiming:'last-payment'});
  assert.equal(Object.hasOwn(original,'asyncFundingEntryTiming'),false);
  assert.equal(configUpdatePolicy(original,after).entryOnly,true);
  assert.deepEqual(configUpdatePolicy(original,after).criticalFields,[]);
  assert.equal(validateConfig({...original,asyncFundingEntryTiming:'anytime'}).asyncFundingEntryTiming,'anytime');
  for(const value of ['disabled',null,0])assert.throws(()=>validateConfig({...original,asyncFundingEntryTiming:value}));
});
