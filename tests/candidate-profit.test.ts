import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateProfit, compareCandidateProfits } from '../web/src/candidate-profit.js';
import type { FundingCandidateView } from '../src/shared/funding-opportunities.js';
import type { Opportunity } from '../src/shared/types.js';
import {nativeMakerFeeRate,nativeTakerFeeRate} from '../src/shared/trading-fees.js';

const candidate = (id = 'BTC-gate-bitget', funding = .3, fees = .2): FundingCandidateView => ({
  id, base: 'BTC', longExchange: 'gate', shortExchange: 'bitget', longRate: 0, shortRate: .003,
  longIntervalHours: 8, shortIntervalHours: 8, normalized8hBps: 30, aprPct: 328.5,
  notionalUsd: 100, nextFundingTime: 10000, exitTime: 11000, longFundingCount: 1, shortFundingCount: 1,
  grossFundingUsd: funding, feesUsd: fees, afterFeesUsd: funding - fees,
  slippageBudgetUsd: 0, transferCostUsd: 0, fundingHaircutUsd: 0, basisReserveUsd: 0,
  expectedNetUsd: funding - fees, candidateEligible: true, reasons: [], updatedAt: 1000, verification: 'pending',
});
const execution = (funding = .4, fees = .22, spread: number | null = .1, status: 'ready' | 'warming' = 'ready'): Opportunity => ({
  expectedFundingUsd: funding, feesUsd: fees, fundingAfterFeesUsd: funding - fees,
  combinedExpectedNetUsd: spread === null ? null : funding + spread - fees,
  spreadAdvantage: { status, expectedSpreadPnlUsd: spread },
} as Opportunity);

test('an unverified row preserves the known funding subtotal without inventing a complete total', () => {
  const row = candidate(), before = structuredClone(row), profit = candidateProfit(row);
  assert.ok(Math.abs(profit.fundingAfterFeesUsd! - .1) < 1e-12);
  assert.equal(profit.spreadUsd, null); assert.equal(profit.combinedNetUsd, null);
  assert.deepEqual(row, before);
});

test('verified accounting consistently uses executable funding and fees and deducts fees only once', () => {
  const row = candidate(); row.execution = execution();
  const profit = candidateProfit(row);
  assert.equal(profit.fundingUsd, .4); assert.equal(profit.feesUsd, .22);
  assert.ok(Math.abs(profit.fundingAfterFeesUsd! - .18) < 1e-12);
  assert.ok(Math.abs(profit.combinedNetUsd! - .28) < 1e-12);
});

test('a warming spread stays unknown even when the API retained a previous numeric estimate', () => {
  const row = candidate(); row.execution = execution(.4, .22, .1, 'warming');
  assert.equal(candidateProfit(row).spreadUsd, null); assert.equal(candidateProfit(row).combinedNetUsd, null);
  assert.ok(candidateProfit(row).fundingAfterFeesUsd! > 0);
});

test('negative and genuinely zero spread estimates stay visible when ready', () => {
  const row = candidate(); row.execution = execution(.4, .22, -.3);
  assert.ok(Math.abs(candidateProfit(row).combinedNetUsd! + .12) < 1e-12);
  row.execution = execution(.4, .22, 0);
  assert.equal(candidateProfit(row).spreadUsd, 0);
  assert.ok(Math.abs(candidateProfit(row).combinedNetUsd! - .18) < 1e-12);
});

test('invalid execution fields use known statistical inputs, while missing inputs never become zero', () => {
  const row = candidate(); row.execution = execution(NaN, Infinity, null);
  row.feesSource='simulation';row.execution.feesSource='exchange';
  const profit = candidateProfit(row);
  assert.equal(profit.fundingUsd, .3); assert.equal(profit.feesUsd, .2); assert.equal(profit.combinedNetUsd, null);
  assert.equal(profit.feesSource,'simulation','Fee provenance follows the selected statistical amount.');
  row.grossFundingUsd = NaN; row.feesUsd = NaN;
  const missing = candidateProfit(row);
  assert.equal(missing.fundingUsd, null); assert.equal(missing.feesUsd, null); assert.equal(missing.fundingAfterFeesUsd, null);
});

test('a ready current-book estimate cannot use a statistical fee fallback to invent a complete total', () => {
  const row = candidate(); row.execution = execution(.4, NaN, -.04);
  row.execution.entryPolicy = 'funding'; row.execution.spreadAdvantage!.estimateMethod = 'current-book';
  const profit = candidateProfit(row);
  assert.equal(profit.feesUsd, .2); assert.equal(profit.spreadUsd, -.04);
  assert.equal(profit.combinedNetUsd, null); assert.equal(profit.subtotalIsReference, true);
  row.execution.expectedFundingUsd = NaN; row.execution.feesUsd = .22;
  assert.equal(candidateProfit(row).combinedNetUsd, null);
});

test('funding mode computes the complete current-book total without historical observations', () => {
  const row = candidate(); row.execution = execution(.4, .22, -.04);
  row.execution.entryPolicy = 'funding'; row.execution.spreadAdvantage!.estimateMethod = 'current-book';
  row.execution.spreadAdvantage!.samples = 0;
  const profit = candidateProfit(row);
  assert.ok(Math.abs(profit.combinedNetUsd! - .14) < 1e-12); assert.equal(profit.subtotalIsReference, false);
});

test('default funding subtotal sorting covers all combinations without substituting it for the total', () => {
  const pending = candidate('pending', 1, .2), complete = candidate('complete'); complete.execution = execution();
  assert.deepEqual([complete, pending].sort((a, b) => compareCandidateProfits(a, b, 'afterFeesUsd', 'desc')).map(row => row.id), ['pending', 'complete']);
  assert.deepEqual([pending, complete].sort((a, b) => compareCandidateProfits(a, b, 'expectedNetUsd', 'desc')).map(row => row.id), ['complete', 'pending']);
});

test('unknown complete totals remain last for both sorting directions', () => {
  const pending = candidate('pending'), negative = candidate('negative'), positive = candidate('positive');
  negative.execution = execution(.4, .22, -.3); positive.execution = execution();
  for (const direction of ['asc', 'desc'] as const) {
    const sorted = [pending, positive, negative].sort((a, b) => compareCandidateProfits(a, b, 'expectedNetUsd', direction));
    assert.equal(sorted.at(-1)?.id, 'pending');
    assert.equal(sorted[0].id, direction === 'asc' ? 'negative' : 'positive');
  }
});

test('unknown values are stable and never report an eligible total for positive funding alone', () => {
  const rows = [candidate('z', .8), candidate('a', .7)];
  assert.deepEqual(rows.sort((a, b) => compareCandidateProfits(a, b, 'expectedNetUsd', 'asc')).map(row => row.id), ['a', 'z']);
  assert.equal(candidateProfit(rows[0]).combinedNetUsd, null);
  assert.ok(compareCandidateProfits(rows[0], rows[1], 'expectedNetUsd', 'desc', false) > 0);
});

test('live fees and net totals require identified official fee proof, while raw funding stays visible',()=>{
  const row=candidate();row.execution=execution();
  for(const source of [undefined,'pending','simulation'] as const){
    row.execution.feesSource=source;
    const profit=candidateProfit(row,{requireNative:true});
    assert.equal(profit.fundingUsd,.4);assert.equal(profit.feesUsd,null);
    assert.equal(profit.fundingAfterFeesUsd,null);assert.equal(profit.combinedNetUsd,null);assert.equal(profit.feesPending,true);
  }
  row.execution.feesSource='exchange';let profit=candidateProfit(row,{requireNative:true});
  assert.equal(profit.feesUsd,.22);assert.equal(profit.feesPending,false);assert.ok(Math.abs(profit.combinedNetUsd!-.28)<1e-12);
  row.execution.feesUsd=NaN;profit=candidateProfit(row,{requireNative:true});
  assert.equal(profit.feesUsd,null);assert.equal(profit.combinedNetUsd,null,'A broken native response never falls back to configured statistics.');
  assert.equal(candidateProfit(row).feesUsd,.2,'Paper statistics can retain their configured simulation fee.');
});

test('live missing-fee totals sort last in either direction without changing raw funding rank',()=>{
  const missing=candidate('missing',100),known=candidate('known',1);known.execution=execution();known.execution.feesSource='exchange';
  const options={requireNative:true};
  for(const direction of ['asc','desc'] as const)assert.equal([missing,known].sort((a,b)=>compareCandidateProfits(a,b,'expectedNetUsd',direction,true,options)).at(-1)?.id,'missing');
  assert.equal([known,missing].sort((a,b)=>compareCandidateProfits(a,b,'grossFundingUsd','desc',true,options))[0].id,'missing');
});

test('official local reference fees supply a live statistical subtotal without claiming a complete book total',()=>{
  const row=candidate();row.feesSource='reference';
  const before=structuredClone(row),profit=candidateProfit(row,{requireNative:true});
  assert.equal(profit.feesSource,'reference');assert.equal(profit.feesPending,false);assert.equal(profit.feesUsd,.2);
  assert.ok(Math.abs(profit.fundingAfterFeesUsd!-.1)<1e-12);
  assert.equal(profit.combinedNetUsd,null);assert.equal(profit.subtotalIsReference,true);
  assert.deepEqual(row,before);
});

test('a complete reference opportunity displays four fees once and remains separate from native account evidence',()=>{
  const row=candidate();row.execution=execution();row.execution.feesSource='reference';
  const before=structuredClone(row),profit=candidateProfit(row,{requireNative:true});
  assert.equal(profit.feesSource,'reference');assert.equal(profit.feesPending,false);
  assert.equal(profit.fundingUsd,.4);assert.equal(profit.feesUsd,.22);
  assert.ok(Math.abs(profit.combinedNetUsd!-.28)<1e-12);assert.deepEqual(row,before);
  const now=1_790_921_600_000;
  const reference={takerFeeSource:'reference',takerFeeRate:.0005,takerFeeAt:now,
    makerFeeSource:'reference',makerFeeRate:.0002,makerFeeAt:now};
  assert.equal(nativeTakerFeeRate(reference as unknown as Parameters<typeof nativeTakerFeeRate>[0],now),undefined);
  assert.equal(nativeMakerFeeRate(reference as unknown as Parameters<typeof nativeMakerFeeRate>[0],now),undefined);
});

test('reference proof cannot invent valid fees or replace unavailable spread data',()=>{
  const row=candidate();row.feesSource='reference';row.execution=execution();row.execution.feesSource='reference';
  for(const invalid of [NaN,Infinity,-.1]){
    row.execution.feesUsd=invalid;
    const profit=candidateProfit(row,{requireNative:true});
    assert.equal(profit.feesUsd,null);assert.equal(profit.feesPending,true);
    assert.equal(profit.fundingAfterFeesUsd,null);assert.equal(profit.combinedNetUsd,null);
  }
  row.execution=execution(.4,.22,.1,'warming');row.execution.feesSource='reference';
  const warming=candidateProfit(row,{requireNative:true});
  assert.equal(warming.feesPending,false);assert.ok(Math.abs(warming.fundingAfterFeesUsd!-.18)<1e-12);
  assert.equal(warming.spreadUsd,null);assert.equal(warming.combinedNetUsd,null);
});

test('reference and exchange fee evidence use the same existing financial sort rules',()=>{
  const low=candidate('low'),high=candidate('high');
  low.execution=execution(.4,.22,-.3);high.execution=execution();
  const options={requireNative:true};
  for(const source of ['exchange','reference'] as const){
    low.execution.feesSource=source;high.execution.feesSource=source;
    for(const direction of ['asc','desc'] as const){
      const sorted=[low,high].sort((a,b)=>compareCandidateProfits(a,b,'expectedNetUsd',direction,true,options));
      assert.equal(sorted[0].id,direction==='asc'?'low':'high');
    }
  }
});

test('aligned single-cycle reference counts four fees once and keeps book loss separate',()=>{
  const row=candidate();row.execution=execution(.4,.22,-2);row.execution.entryPolicy='aligned';
  row.execution.feesSource='exchange';row.execution.spreadAdvantage!.estimateMethod='current-book';
  const before=structuredClone(row),profit=candidateProfit(row,{requireNative:true});
  assert.equal(profit.bookLossUsd,2);assert.equal(profit.spreadUsd,-2);
  assert.ok(Math.abs(profit.combinedNetUsd!-.18)<1e-12);
  assert.deepEqual(row,before);
});

test('aligned reference statistics contribute to positive-net totals without waiting for paired books',()=>{
  const row=candidate();row.feesSource='reference';
  const options={requireNative:true,entryPolicy:'aligned' as const};
  const before=structuredClone(row),profit=candidateProfit(row,options);
  assert.ok(Math.abs(profit.combinedNetUsd!-.1)<1e-12);
  assert.equal(profit.bookLossUsd,null);assert.equal(profit.spreadUsd,null);
  assert.equal(profit.subtotalIsReference,true);assert.equal(row.execution,undefined);
  assert.deepEqual(row,before);
  row.feesUsd=NaN;
  assert.equal(candidateProfit(row,options).combinedNetUsd,null,'Unknown fees are not treated as zero.');
});

test('aligned fee references remain useful during closing-book warmup without inventing book loss',()=>{
  const row=candidate();row.execution=execution(.4,.22,-2,'warming');
  row.execution.entryPolicy='aligned';row.execution.feesSource='reference';
  const profit=candidateProfit(row,{requireNative:true});
  assert.ok(Math.abs(profit.combinedNetUsd!-.18)<1e-12);
  assert.equal(profit.bookLossUsd,null);assert.equal(profit.spreadUsd,null);
  for(const fee of [NaN,Infinity,-.1]){
    row.execution.feesUsd=fee;
    assert.equal(candidateProfit(row,{requireNative:true}).combinedNetUsd,null);
  }
});

test('an explicit legacy policy retains its accounting while global aligned settings synchronize',()=>{
  const row=candidate();row.execution=execution(.4,.22,-.04);
  row.execution.entryPolicy='funding';row.execution.spreadAdvantage!.estimateMethod='current-book';
  row.execution.feesSource='exchange';
  const options={requireNative:true,entryPolicy:'aligned' as const};
  assert.ok(Math.abs(candidateProfit(row,options).combinedNetUsd!-.14)<1e-12);
  row.execution.entryPolicy='dual';row.execution.spreadAdvantage!.estimateMethod='historical-median';
  row.execution.spreadAdvantage!.expectedSpreadPnlUsd=.1;
  assert.ok(Math.abs(candidateProfit(row,options).combinedNetUsd!-.28)<1e-12);
});
