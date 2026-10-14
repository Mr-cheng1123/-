import test from 'node:test';
import assert from 'node:assert/strict';
import {buildFundingVerificationPriorities,compareFundingVerificationPriority,type FundingVerificationPriorityOptions} from '../src/core/funding-verification-priority.js';
import type {FundingCandidate} from '../src/shared/funding-opportunities.js';
import type {Opportunity} from '../src/shared/types.js';

const NOW=1_700_000_000_000;
function candidate(base:string,extra:Partial<FundingCandidate>={}):FundingCandidate {
  return {id:`${base}-gate-bybit`,base,longExchange:'gate',shortExchange:'bybit',longRate:0,shortRate:.005,
    longIntervalHours:8,shortIntervalHours:8,normalized8hBps:50,aprPct:10,notionalUsd:100,
    nextFundingTime:NOW+3_600_000,exitTime:NOW+3_610_000,longFundingCount:1,shortFundingCount:1,
    grossFundingUsd:.5,feesUsd:.32,feesSource:'reference',afterFeesUsd:.18,
    slippageBudgetUsd:0,transferCostUsd:0,fundingHaircutUsd:0,basisReserveUsd:0,expectedNetUsd:.18,
    candidateEligible:true,reasons:[],updatedAt:NOW,...extra};
}
function detail(row:FundingCandidate,extra:Partial<Opportunity>={}):Opportunity {
  return {id:row.id,base:row.base,longExchange:row.longExchange,shortExchange:row.shortExchange,
    entryPolicy:'aligned',feesSource:'reference',longRate:row.longRate,shortRate:row.shortRate,
    longIntervalHours:8,shortIntervalHours:8,longQuantity:1,shortQuantity:1,notionalUsd:100,grossExposureUsd:200,
    netRateBps:50,normalized8hBps:50,aprPct:10,capitalAprPct:10,expectedFundingUsd:.5,feesUsd:.22,
    slippageUsd:0,transferCostUsd:0,basisStressUsd:0,expectedNetUsd:.28,combinedExpectedNetUsd:.28,
    basisBps:0,deltaUsd:0,nextFundingTime:row.nextFundingTime,exitTime:row.exitTime,
    settlementSkewSec:0,liquidityUsd:1000,eligible:false,reasons:[],risk:'low',confidence:.55,...extra};
}
function priorities(rows:readonly FundingCandidate[],opportunities:readonly Opportunity[]=[],extra:Partial<FundingVerificationPriorityOptions>={}) {
  return buildFundingVerificationPriorities(rows,{config:{mode:'live',entryPolicy:'aligned'},opportunities,
    prefer:()=>true,ready:()=>false,...extra});
}

test('unverified reference funding after four fees receives priority despite a blocked entry window',()=>{
  const blocked=candidate('BLOCKED',{candidateEligible:false,reasons:['异步资金费入场时点不合适']}),
    grossOnly=candidate('GROSS',{grossFundingUsd:10,feesUsd:11,afterFeesUsd:999,normalized8hBps:1000});
  const result=priorities([grossOnly,blocked]);
  assert.equal(result.get(blocked.id),3);
  assert.equal(result.get(grossOnly.id),0,'a saved afterFees field cannot invent a positive funding subtotal');
  assert.equal(blocked.candidateEligible,false,'observation priority cannot grant execution eligibility');
});

test('live reference estimates require identified fees while paper accepts valid simulation and old fixtures',()=>{
  const rows=['reference','exchange','simulation','pending',undefined].map((source,i)=>candidate(`COIN${i}`,{feesSource:source as FundingCandidate['feesSource']}));
  const live=priorities(rows),paper=priorities(rows,[],{config:{mode:'paper',entryPolicy:'aligned'}});
  assert.deepEqual(rows.map(row=>live.get(row.id)),[3,0,0,0,0]);
  assert.deepEqual(rows.map(row=>paper.get(row.id)),[3,3,3,0,3]);
});

test('execution funding and fees replace the nominal reference even when their signs disagree',()=>{
  const referencePositive=candidate('POSITIVE'),referenceNegative=candidate('NEGATIVE',{grossFundingUsd:.2,feesUsd:.32,afterFeesUsd:-.12});
  const executions=[detail(referencePositive,{expectedFundingUsd:.1,feesUsd:.22,fundingAfterFeesUsd:999,combinedExpectedNetUsd:999}),
    detail(referenceNegative,{expectedFundingUsd:.2,feesUsd:.11})];
  const result=priorities([referencePositive,referenceNegative],executions);
  assert.equal(result.get(referencePositive.id),0,'positive statistics or another net field cannot mask the aligned execution loss');
  assert.equal(result.get(referenceNegative.id),3,'confirmed contract classification can lower the execution fee estimate');
});

test('unknown or invalid execution finances cannot fall back to positive reference statistics',()=>{
  const row=candidate('UNKNOWN');
  for(const change of [{feesSource:'pending' as const},{feesSource:'simulation' as const},{feesSource:undefined},
    {feesUsd:NaN},{feesUsd:Infinity},{feesUsd:-.01},{expectedFundingUsd:NaN},{expectedFundingUsd:Infinity},{expectedFundingUsd:-1}]){
    const result=priorities([row],[detail(row,{...change,combinedExpectedNetUsd:999})]);
    assert.equal(result.get(row.id),0,JSON.stringify(change));
  }
  assert.equal(priorities([row],[detail(row,{feesSource:'simulation'})],{config:{mode:'paper',entryPolicy:'aligned'}}).get(row.id),3);
  assert.equal(priorities([row],[detail(row,{feesSource:undefined})],{config:{mode:'paper',entryPolicy:'aligned'}}).get(row.id),3);
});

test('aligned observation income excludes book losses, basis gains and the smaller first batch',()=>{
  const row=candidate('ALIGNED');
  const execution=detail(row,{combinedExpectedNetUsd:-999,expectedNetUsd:-999,slippageUsd:999,
    spreadAdvantage:{status:'ready',samples:1,requiredSamples:1,observedSpanSec:1,requiredSpanSec:1,
      longEntryPrice:100,shortEntryPrice:200,entrySpreadBps:10,expectedExitSpreadBps:10,
      spreadAdvantageBps:0,expectedSpreadPnlUsd:-999},
    entryBatch:{pricing:'best-opposite',targetQuantity:1,batchQuantity:.1,longLimitPrice:100,shortLimitPrice:101,
      expectedFundingUsd:.05,expectedNetUsd:-999}});
  assert.equal(priorities([row],[execution]).get(row.id),3);
});

test('non-aligned complete net income receives priority only with valid execution finances',()=>{
  const row=candidate('NET');
  for(const policy of ['funding','dual'] as const){
    const execution=detail(row,{entryPolicy:policy,expectedFundingUsd:.1,feesUsd:.22,combinedExpectedNetUsd:.5});
    assert.equal(priorities([row],[execution],{config:{mode:'live',entryPolicy:policy}}).get(row.id),3);
    for(const change of [{combinedExpectedNetUsd:null},{combinedExpectedNetUsd:NaN},{combinedExpectedNetUsd:0},
      {feesSource:'pending' as const},{feesUsd:-1}])
      assert.equal(priorities([row],[{...execution,...change}],{config:{mode:'live',entryPolicy:policy}}).get(row.id),0);
  }
});

test('the unordered pair matches a reversed execution direction without conflating another venue route',()=>{
  const row=candidate('REVERSED',{grossFundingUsd:.1,feesUsd:.32}),other=candidate('REVERSED',{
    id:'REVERSED-gate-bitget',shortExchange:'bitget',grossFundingUsd:.1,feesUsd:.32});
  const execution=detail(row,{id:'REVERSED-bybit-gate',longExchange:'bybit',shortExchange:'gate'});
  const result=priorities([row,other],[execution]);
  assert.equal(result.get(row.id),3);assert.equal(result.get(other.id),0);
  assert.equal(result.has(execution.id),false,'result keys remain the current statistical candidate ids');
});

test('IOC observation priority requires the caller readiness and an actual limit edge strictly over 20 bps',()=>{
  const row=candidate('IOC');
  for(const edge of [20,20+1e-10,null,undefined,NaN,Infinity])
    assert.equal(priorities([row],[detail(row,{entryLimitPriceEdgeBps:edge,entryPriceEdgeBps:200})],{ready:()=>true}).get(row.id),3);
  assert.equal(priorities([row],[detail(row,{entryLimitPriceEdgeBps:20.01})],{ready:()=>true}).get(row.id),4);
  assert.equal(priorities([row],[detail(row,{entryLimitPriceEdgeBps:100})],{ready:()=>false}).get(row.id),3);
  const loss=detail(row,{expectedFundingUsd:.1,feesUsd:.22,entryLimitPriceEdgeBps:20});
  assert.equal(priorities([row],[loss],{ready:()=>true}).get(row.id),2);
  assert.equal(priorities([row],[{...loss,entryLimitPriceEdgeBps:20.01}],{ready:()=>true}).get(row.id),4);
});

test('unpreferred and conflicting instruments stay at zero even with ready high-edge execution',()=>{
  const rows=[candidate('PUBLIC'),candidate('EDGE'),candidate('HANMI',{id:'HANMI-gate-bitget',shortExchange:'bitget'})];
  const details=rows.map(row=>detail(row,{entryLimitPriceEdgeBps:100}));
  const result=priorities(rows,details,{prefer:row=>row.base!=='PUBLIC',ready:()=>true});
  assert.deepEqual(rows.map(row=>result.get(row.id)),[0,0,0]);
});

test('priority calculation does not change candidate, execution or input order',()=>{
  const rows=[candidate('B'),candidate('A')],opportunities=rows.map(row=>detail(row));
  const before=JSON.stringify({rows,opportunities});
  Object.freeze(rows);Object.freeze(opportunities);
  for(const row of rows)Object.freeze(row);for(const opportunity of opportunities)Object.freeze(opportunity);
  priorities(rows,opportunities);
  assert.equal(JSON.stringify({rows,opportunities}),before);
});

test('priority comparison orders positive tiers by finite 8h funding then gross funding and stable id',()=>{
  const rows=[candidate('ZERO',{normalized8hBps:1000}),candidate('INVALID',{normalized8hBps:NaN}),
    candidate('LOWER',{normalized8hBps:40}),candidate('B',{grossFundingUsd:.5}),
    candidate('A',{grossFundingUsd:.5}),candidate('MORE',{grossFundingUsd:.6}),candidate('HIGH',{normalized8hBps:60}),
    candidate('READY',{normalized8hBps:1})];
  const scores=new Map(rows.map(row=>[row.id,row.base==='ZERO'?0:row.base==='READY'?4:3]));
  assert.deepEqual([...rows].sort((a,b)=>compareFundingVerificationPriority(a,b,scores)).map(row=>row.base),
    ['READY','HIGH','MORE','A','B','LOWER','INVALID','ZERO']);
  const invalidGross=candidate('NO_GROSS',{grossFundingUsd:Infinity});
  scores.set(invalidGross.id,3);
  assert.ok(compareFundingVerificationPriority(invalidGross,rows[3],scores)>0);
});

test('tier-zero comparison leaves original fairness and discovery ordering to the scheduler',()=>{
  const a=candidate('A',{normalized8hBps:1000,grossFundingUsd:100}),b=candidate('B',{normalized8hBps:1,grossFundingUsd:1});
  assert.equal(compareFundingVerificationPriority(a,b,new Map()),0);
  assert.equal(compareFundingVerificationPriority(a,b,new Map([[a.id,0],[b.id,0]])),0);
});
