import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import FundingSchedule,{fundingEntryWindowCaption} from '../web/src/FundingSchedule.js';
import {buildFundingSchedule,type FundingSchedule as Schedule} from '../src/shared/funding-schedule.js';

const at=(time:string)=>Date.parse(`2026-10-03T${time}+08:00`);
const schedule=()=>buildFundingSchedule(
  {exchange:'bitget',notionalUsd:100,fundingRate:-.010993,intervalHours:8,nextFundingTime:at('16:00:00')},
  {exchange:'bybit',notionalUsd:100,fundingRate:-.000859,intervalHours:1,nextFundingTime:at('14:00:00')},
  {now:at('13:44:49'),entryTiming:'last-payment'});

test('entry detail presents the next payment separately from the paired-horizon income and waiting time',()=>{
  const markup=renderToStaticMarkup(createElement(FundingSchedule,{schedule:schedule(),forEntry:true,referenceOnly:true}));
  assert.match(markup,/最近单次预计净资金费/);assert.match(markup,/−\$0\.0859/);
  assert.match(markup,/本轮合计预计资金费/);assert.match(markup,/\+\$0\.8416/);
  assert.match(markup,/14:00:00/);assert.match(markup,/16:00:00/);assert.match(markup,/15:00:10/);
  assert.match(markup,/等待入场窗口/);assert.match(markup,/统计参考，盘口待核验/);
  assert.match(markup,/末轮避付款窗口/);assert.match(markup,/共同结算周期/);
  assert.match(markup,/后续费率按当前值假设/);assert.match(markup,/单次净额/);assert.match(markup,/累计净额/);
  assert.match(markup,/本次不结算/);
});

test('existing holding display never turns a new-entry timing rule into a close or reopen instruction',()=>{
  const markup=renderToStaticMarkup(createElement(FundingSchedule,{schedule:schedule()}));
  assert.match(markup,/异步结算/);assert.match(markup,/−\$0\.0859/);assert.match(markup,/\+\$0\.8416/);
  assert.doesNotMatch(markup,/等待入场窗口|首轮收款窗口|末轮避付款窗口|共同结算周期|建议.*15:00:10|重新核验，再判断是否开仓/);
});

test('first-receipt entry displays the first small interval after a shared settlement with its closing deadline',()=>{
  const result=buildFundingSchedule(
    {exchange:'bitget',notionalUsd:100,fundingRate:.0005,intervalHours:8,nextFundingTime:at('16:00:00')},
    {exchange:'bybit',notionalUsd:100,fundingRate:.001,intervalHours:1,nextFundingTime:at('09:00:00')},
    {now:at('08:00:10'),entryTiming:'last-payment'});
  const markup=renderToStaticMarkup(createElement(FundingSchedule,{schedule:result,forEntry:true}));
  assert.match(markup,/当前在入场窗口/);assert.match(markup,/首轮收款窗口/);
  assert.match(markup,/08:00:10.*08:59:50 前/);assert.match(markup,/1h 小周期.*净收款/);
  assert.match(markup,/09:00:00.*提前 10 秒/);
  assert.match(fundingEntryWindowCaption(result)!,/首轮收款窗口.*08:00:10.*08:59:50 前/);
  assert.doesNotMatch(markup,/等待下一共同周期；不开中途仓/);
});

test('missed first receipt window explicitly waits for the next shared cycle instead of suggesting middle-cycle entry',()=>{
  const result=buildFundingSchedule(
    {exchange:'bitget',notionalUsd:100,fundingRate:.0005,intervalHours:8,nextFundingTime:at('16:00:00')},
    {exchange:'bybit',notionalUsd:100,fundingRate:.001,intervalHours:1,nextFundingTime:at('14:00:00')},
    {now:at('13:44:49'),entryTiming:'last-payment'});
  const markup=renderToStaticMarkup(createElement(FundingSchedule,{schedule:result,forEntry:true}));
  assert.match(markup,/已错过本轮入场窗口/);assert.match(markup,/本轮首个小周期窗口已结束/);
  assert.match(markup,/等待下一共同周期；不开中途仓/);assert.match(markup,/16:00:10.*16:59:50 前/);
  assert.match(markup,/上方本轮合计不代表下一周期收入/);
  assert.doesNotMatch(markup,/当前在入场窗口/);
  assert.match(fundingEntryWindowCaption(result)!,/已错过首轮收款窗口.*下一窗口.*16:00:10.*16:59:50 前/);
});

test('anytime compatibility never claims a missed timing window is currently open',()=>{
  const result=buildFundingSchedule(
    {exchange:'bitget',notionalUsd:100,fundingRate:.0005,intervalHours:8,nextFundingTime:at('16:00:00')},
    {exchange:'bybit',notionalUsd:100,fundingRate:.001,intervalHours:1,nextFundingTime:at('14:00:00')},
    {now:at('13:44:49'),entryTiming:'anytime'});
  const markup=renderToStaticMarkup(createElement(FundingSchedule,{schedule:result,forEntry:true}));
  assert.doesNotMatch(markup,/当前在入场窗口|等待下一共同周期；不开中途仓/);
  assert.match(markup,/任意时点/);
});

test('a schedule without a verified cycle window does not invent first or last entry deadlines',()=>{
  const value={...schedule()};delete value.entryWindow;
  const markup=renderToStaticMarkup(createElement(FundingSchedule,{schedule:value,forEntry:true}));
  assert.doesNotMatch(markup,/首轮收款窗口|末轮避付款窗口|共同结算周期/);
  assert.equal(fundingEntryWindowCaption(value),undefined);
});

test('invalid or unavailable cash evidence remains unknown without rendering its zero placeholders as income',()=>{
  const invalid=buildFundingSchedule(
    {exchange:'bitget',notionalUsd:100,fundingRate:NaN,intervalHours:8,nextFundingTime:at('16:00:00')},
    {exchange:'bybit',notionalUsd:100,fundingRate:-.000859,intervalHours:1,nextFundingTime:at('14:00:00')},
    {now:at('13:44:49')});
  assert.equal(invalid.valid,false);
  for(const value of [invalid,undefined] as Array<Schedule|undefined>){
    const markup=renderToStaticMarkup(createElement(FundingSchedule,{schedule:value,forEntry:true}));
    assert.match(markup,/等待/);assert.doesNotMatch(markup,/\$0\.00|最近单次预计净资金费|本轮合计预计资金费/);
  }
});
