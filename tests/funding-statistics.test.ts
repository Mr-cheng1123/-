import test from 'node:test';
import assert from 'node:assert/strict';
import { comparableRate, fundingCellIsFresh, summarizeFundingRow, type FundingStatsCell, type FundingStatsDataset } from '../src/shared/funding-statistics.js';
const now=1790710000000;
const dataset:FundingStatsDataset={source:'exchanges',range:'current',status:'ready',rows:[],receivedAt:now,lastAttemptAt:now,nextRefreshAt:now+20000,maxAgeMs:60000,sourceUrl:'',marginScope:'USDT'};
const cell=(changes:Partial<FundingStatsCell>={}):FundingStatsCell=>({exchange:'binance',rate:.0001,intervalHours:8,nextFundingTime:now+60000,updatedAt:now,timestampKind:'exchange',available:true,...changes});
test('normalized ranking accounts for unequal funding intervals and computes gross annualization',()=>{
  const row={base:'BTC',cells:{binance:cell({rate:.001,intervalHours:1}),bybit:cell({exchange:'bybit',rate:.002,intervalHours:8})}};
  const summary=summarizeFundingRow(row,dataset,now);
  assert.equal(summary.low,'bybit');assert.equal(summary.high,'binance');assert.equal(summary.gap,.006);assert.ok(Math.abs(summary.aprPct!-657)<1e-9);
});
test('zero rates are valid; missing periods and absent predictions are not silently invented',()=>{
  assert.equal(comparableRate(cell({rate:0}),'current','8h'),0);
  assert.equal(comparableRate(cell({intervalHours:null}),'current','8h'),null);
  assert.equal(comparableRate(cell(),'current','native',true),null);
  assert.equal(comparableRate(cell({predictedRate:.0002}),'current','8h',true),.0002);
});
test('cumulative rates are historical values, never annualized as current forecasts',()=>{
  const sum={...dataset,range:'7d' as const};
  const row={base:'BTC',cells:{binance:cell({rate:.03,intervalHours:null}),bybit:cell({exchange:'bybit',rate:.04,intervalHours:null})}};
  assert.equal(comparableRate(row.cells.binance,'7d','8h'),.03);
  assert.equal(summarizeFundingRow(row,sum,now).aprPct,null);
});
test('stale, disconnected, future and already-settled cells cannot drive ranking',()=>{
  for(const changes of [{updatedAt:now-60001},{updatedAt:now+6000},{available:false},{nextFundingTime:now-1}])assert.equal(fundingCellIsFresh(cell(changes),dataset,now),false);
  const summary=summarizeFundingRow({base:'BTC',cells:{binance:cell(),bybit:cell({exchange:'bybit',rate:.9,available:false})}},dataset,now);
  assert.equal(summary.available,1);assert.equal(summary.gap,null);assert.equal(summary.aprPct,null);
});
test('weighted rates use only reported positive weights and normalized rates',()=>{
  const summary=summarizeFundingRow({base:'BTC',cells:{binance:cell({openInterestUsd:300}),bybit:cell({exchange:'bybit',rate:.0001,intervalHours:4,openInterestUsd:100})}},dataset,now);
  assert.equal(summary.oiWeighted8h,.000125);assert.equal(summary.volumeWeighted8h,null);
});
