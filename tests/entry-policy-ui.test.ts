import test from 'node:test';
import assert from 'node:assert/strict';
import { entryPolicy, entryPolicyLabel, fundingEntryLimitReady, entryExecutionReady, roundsEstimate } from '../web/src/entry-policy.js';
import type { AppConfig, Opportunity } from '../src/shared/types.js';
import { synchronizeCandidateEntryState } from '../web/src/candidate-authorization.js';
import type { FundingCandidateView } from '../src/shared/funding-opportunities.js';
import type { AppState } from '../src/shared/types.js';

test('the UI honors an opportunity frozen policy during a configuration transition', () => {
  const config = { entryPolicy: 'funding' } as AppConfig;
  assert.equal(entryPolicy(config), 'funding');
  assert.equal(entryPolicy(config, { entryPolicy: 'dual' }), 'dual');
  assert.equal(entryPolicy({ entryPolicy: 'dual' }, { entryPolicy: 'funding' }), 'funding');
  assert.equal(entryPolicy({}, undefined), 'dual');
  assert.match(entryPolicyLabel('funding'), /单轮成本/);
});

test('aligned execution depends on the IOC price edge and ignores the one-round net threshold',()=>{
  const config={entryPolicy:'aligned',minCombinedNetUsd:999,minEntryIocEdgeBps:0} as AppConfig;
  const opportunity={entryPolicy:'aligned',entryPriceEdgeBps:35,entryLimitPriceEdgeBps:5,entryLimitNetUsd:-.3,combinedExpectedNetUsd:-.2,eligible:true} as Opportunity;
  assert.equal(entryPolicy(config,opportunity),'aligned');
  assert.equal(entryExecutionReady(config,opportunity),true);
  for(const edge of [undefined,null,NaN,Infinity,0,-1])assert.equal(entryExecutionReady(config,{...opportunity,entryLimitPriceEdgeBps:edge} as Opportunity),false);
  for(const edge of [5,19,20])assert.equal(entryExecutionReady(config,{...opportunity,entryLimitPriceEdgeBps:edge} as Opportunity),true);
  assert.equal(entryExecutionReady({...config,minEntryIocEdgeBps:30},opportunity),false);
});

test('compatible payloads without a minimum use positive IOC advantage while explicit custom thresholds still apply',()=>{
  const config={entryPolicy:'aligned',minCombinedNetUsd:999} as AppConfig;
  const opportunity={entryPolicy:'aligned',entryLimitPriceEdgeBps:5} as Opportunity;
  assert.equal(entryExecutionReady(config,opportunity),true);
  assert.equal(entryExecutionReady({...config,minEntryIocEdgeBps:20},opportunity),false);
  assert.equal(entryExecutionReady({...config,minEntryIocEdgeBps:20},{...opportunity,entryLimitPriceEdgeBps:20}),false);
  assert.equal(entryExecutionReady({...config,minEntryIocEdgeBps:20},{...opportunity,entryLimitPriceEdgeBps:20.01}),true);
});

test('aligned pending IOC price data shows the backend label without adding an economic threshold',()=>{
  const row={verification:'verified',execution:{entryPolicy:'aligned',eligible:true,reasons:[],checks:[],combinedExpectedNetUsd:-.2,spreadAdvantage:{status:'ready',estimateMethod:'current-book'}}} as unknown as FundingCandidateView;
  const state={config:{mode:'paper',entryPolicy:'aligned',minCombinedNetUsd:999}} as unknown as AppState;
  const result=synchronizeCandidateEntryState(row,state);
  assert.equal(result.execution!.eligible,false);
  assert.deepEqual(result.execution!.checks!.map(check=>check.label),['实际 IOC 开仓价格优势达标']);
  assert.equal(result.execution!.checks![0].pass,null);
});

test('conditional break-even rounds never display unknown or invalid data as a free first round',()=>{
  assert.equal(roundsEstimate(3.2),'4 轮（按本轮假设）');
  for(const rounds of [undefined,null,NaN,Infinity,0,-1])assert.equal(roundsEstimate(rounds),'暂不可估算');
});

test('explicit estimate provenance identifies a policy for compatible older opportunity payloads', () => {
  const currentBook = { spreadAdvantage: { estimateMethod: 'current-book' } } as Opportunity;
  const history = { spreadAdvantage: { estimateMethod: 'historical-median' } } as Opportunity;
  assert.equal(entryPolicy({ entryPolicy: 'dual' }, currentBook), 'funding');
  assert.equal(entryPolicy({ entryPolicy: 'funding' }, history), 'dual');
});

test('a warming historical reference never blocks or changes an eligible current-book opportunity', () => {
  const row = { verification: 'verified', execution: {
    entryPolicy: 'funding', entryLimitNetUsd:.3, eligible: true, reasons: [], checks: [],
    spreadAdvantage: { status: 'ready', estimateMethod: 'current-book' },
    historicalSpreadAdvantage: { status: 'warming', samples: 0 },
  } } as unknown as FundingCandidateView;
  const state = { config: { mode: 'paper', entryPolicy: 'funding', minCombinedNetUsd:.05 } } as unknown as AppState;
  assert.equal(synchronizeCandidateEntryState(row,state), row);
  assert.equal(row.execution!.eligible, true);
});

test('funding mode requires a finite IOC limit net above the shared minimum without affecting legacy dual mode',()=>{
  const config={entryPolicy:'funding',minCombinedNetUsd:.05} as AppConfig;
  for(const value of [undefined,null,NaN,Infinity,-.1,.05]){
    const opportunity={entryPolicy:'funding',entryLimitNetUsd:value} as unknown as Opportunity;
    assert.equal(fundingEntryLimitReady(config,opportunity),false);
  }
  assert.equal(fundingEntryLimitReady(config,{entryPolicy:'funding',entryLimitNetUsd:.051} as Opportunity),true);
  assert.equal(fundingEntryLimitReady(config,{entryPolicy:'dual'} as Opportunity),true);
});

test('a stale eligible funding payload with missing or losing IOC net cannot enable order submission',()=>{
  for(const value of [undefined,-.1]){
    const row={verification:'verified',execution:{entryPolicy:'funding',entryLimitNetUsd:value,eligible:true,reasons:[],checks:[],spreadAdvantage:{status:'ready',estimateMethod:'current-book'}}} as unknown as FundingCandidateView;
    const state={config:{mode:'paper',entryPolicy:'funding',minCombinedNetUsd:.05}} as unknown as AppState;
    const result=synchronizeCandidateEntryState(row,state);
    assert.equal(result.execution!.eligible,false);
    assert.equal(result.execution!.checks!.at(-1)!.pass,value===undefined?null:false);
    assert.equal(result.verification,value===undefined?'pending':'blocked');
    assert.equal(row.execution!.eligible,true);
  }
});
