import test from 'node:test';
import assert from 'node:assert/strict';
import type { Opportunity } from '../src/shared/types.js';
import type { FundingCandidateView } from '../src/shared/funding-opportunities.js';
import { applyCandidateVerification, sameCandidatePair } from '../web/src/candidate-verification.js';
import { candidateProfit } from '../web/src/candidate-profit.js';

const row=()=>({id:'ARK-gate-bitget',base:'ARK',longExchange:'gate',shortExchange:'bitget',longRate:-.001,shortRate:0,longIntervalHours:1,shortIntervalHours:1,longFundingCount:2,shortFundingCount:1,grossFundingUsd:.3,feesUsd:.21,afterFeesUsd:.09,expectedNetUsd:.09,notionalUsd:100,updatedAt:12345,nextFundingTime:20000,exitTime:30000,verification:'pending',reasons:[]} as unknown as FundingCandidateView);
const reverse=()=>({id:'ARK-bitget-gate',base:'ARK',longExchange:'bitget',shortExchange:'gate',entryPolicy:'aligned',longRate:0,shortRate:.001,longIntervalHours:1,shortIntervalHours:1,expectedFundingUsd:.2,feesUsd:.21,fundingAfterFeesUsd:-.01,normalized8hBps:80,aprPct:876,nextFundingTime:20000,exitTime:30000,notionalUsd:100,eligible:true} as Opportunity);

test('a reverse direction on the same coin and venues replaces the route while preserving the original statistics',()=>{
  const original=row(),before=structuredClone(original),opportunity=reverse(),result=applyCandidateVerification(original,opportunity);
  assert.equal(sameCandidatePair(original,opportunity),true);assert.equal(result.id,opportunity.id);
  assert.equal(result.longExchange,'bitget');assert.equal(result.shortExchange,'gate');
  assert.equal(result.longFundingCount,1);assert.equal(result.shortFundingCount,2);
  assert.equal(result.statistics!.id,original.id);assert.equal(result.statistics!.grossFundingUsd,.3);
  assert.equal(result.statistics!.feesUsd,.21);assert.equal(result.directionChanged,true);assert.deepEqual(original,before);
  const back=applyCandidateVerification(result,{...opportunity,id:original.id,longExchange:'gate',shortExchange:'bitget'});
  assert.equal(back.statistics!.id,original.id);assert.equal(back.directionChanged,false);assert.equal(back.longFundingCount,2);
});

test('a different coin or venue cannot be substituted for a verified route',()=>{
  for(const opportunity of [{...reverse(),base:'OTHER'},{...reverse(),shortExchange:'bybit' as const}]){
    assert.equal(sameCandidatePair(row(),opportunity),false);
    assert.throws(()=>applyCandidateVerification(row(),opportunity),/组合不一致/);
  }
});

test('missing execution fees preserve the aligned statistical reference without inventing a live fee proof',()=>{
  const result=applyCandidateVerification(row(),{...reverse(),expectedFundingUsd:9,feesUsd:NaN,spreadAdvantage:{status:'ready',expectedSpreadPnlUsd:1} as Opportunity['spreadAdvantage']});
  assert.equal(result.grossFundingUsd,.3);assert.equal(result.feesUsd,.21);
  const profit=candidateProfit(result);assert.equal(profit.fundingUsd,.3);assert.equal(profit.feesUsd,.21);
  assert.ok(Math.abs(profit.combinedNetUsd!-.09)<1e-12);assert.equal(profit.subtotalIsReference,true);
  assert.equal(candidateProfit(result,{requireNative:true}).combinedNetUsd,null);
});

test('direction changes preserve reference provenance and later account fees retain their own source',()=>{
  const original=row();original.feesSource='reference';
  const before=structuredClone(original),reference={...reverse(),feesSource:'reference' as const};
  const verified=applyCandidateVerification(original,reference);
  assert.equal(verified.feesSource,'reference');assert.equal(verified.statistics!.feesSource,'reference');
  assert.equal(verified.directionChanged,true);assert.equal(candidateProfit(verified,{requireNative:true}).feesPending,false);
  const account=applyCandidateVerification(verified,{...reference,feesSource:'exchange',feesUsd:.4});
  assert.equal(account.feesSource,'exchange');assert.equal(account.statistics!.feesSource,'reference');
  assert.equal(candidateProfit(account,{requireNative:true}).feesSource,'exchange');
  assert.deepEqual(original,before);
});

test('incomplete verification keeps the stored reference source without claiming native fee proof',()=>{
  const original=row();original.feesSource='reference';
  const pending=applyCandidateVerification(original,{...reverse(),feesSource:'pending',feesUsd:NaN});
  assert.equal(pending.feesSource,'reference');assert.equal(pending.statistics!.feesSource,'reference');
  assert.equal(pending.execution!.feesSource,'pending');assert.equal(candidateProfit(pending,{requireNative:true}).feesPending,true);
});
