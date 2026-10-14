import test from 'node:test';
import assert from 'node:assert/strict';
import {opportunityExchangeScope,filterOpportunityPairs,scopedFundingDataset,type OpportunityExchangeScope} from '../src/shared/opportunity-exchange-scope.js';
import {calculateFundingCandidates,fundingOpportunityCoverage} from '../src/shared/funding-opportunities.js';
import {summarizeFundingRow,type FundingStatsCell,type FundingStatsDataset} from '../src/shared/funding-statistics.js';
import type {ExchangeId,LivePortfolioExchange} from '../src/shared/types.js';
import {defaultConfig} from './legacy-config.js';

const now=1_790_710_000_000;
const exchanges:ExchangeId[]=['binance','bybit','okx','gate','bitget'];
const connected:ExchangeId[]=['binance','bybit','gate','bitget'];
function scope():OpportunityExchangeScope {
  return {config:{mode:'live',exchanges},
    liveReadiness:{exchanges:exchanges.map(exchange=>({exchange,supported:true,credentialsConfigured:exchange!=='okx',executionAuthorized:false}))},
    livePortfolio:{exchanges:exchanges.map(exchange=>({exchange,credentialsConfigured:exchange!=='okx',status:exchange==='okx'?'not_configured':'ready',
      lastSuccessAt:exchange==='okx'?undefined:now,positions:[],freeUsd:0,equityUsd:0}))}};
}
function account(state:OpportunityExchangeScope,exchange:ExchangeId):LivePortfolioExchange {
  return state.livePortfolio!.exchanges.find(item=>item.exchange===exchange)!;
}
const cell=(exchange:ExchangeId,rate:number):FundingStatsCell=>({exchange,rate,intervalHours:8,nextFundingTime:now+60_000,
  updatedAt:now,timestampKind:'received',available:true});
const data=():FundingStatsDataset=>({source:'exchanges',range:'current',status:'ready',receivedAt:now,lastAttemptAt:now,nextRefreshAt:now+20_000,maxAgeMs:120_000,
  marginScope:'USDT',sourceUrl:'',rows:[
    {base:'BTC',cells:{binance:cell('binance',.001),bybit:cell('bybit',.002),okx:cell('okx',.9)}},
    {base:'ONLY_OKX',cells:{okx:cell('okx',.1)}},
    {base:'ONE_VENUE',cells:{gate:cell('gate',.003),okx:cell('okx',.1)}},
  ]});

test('private account proof scopes all four connected venues regardless of execution authorization or zero balance',()=>{
  assert.deepEqual(opportunityExchangeScope(scope()),connected);
});
test('configured credentials and public quotes alone never establish a private account connection',()=>{
  const state=scope();
  state.liveReadiness!.exchanges.find(item=>item.exchange==='okx')!.credentialsConfigured=true;
  Object.assign(account(state,'okx'),{credentialsConfigured:true,status:'loading'});
  assert.deepEqual(opportunityExchangeScope(state),connected);
  delete state.livePortfolio;
  assert.deepEqual(opportunityExchangeScope(state),[]);
});
test('temporary stale/error/loading observations retain previously successful accounts without a time-to-live cutoff',()=>{
  for(const status of ['stale','error','loading'] as const){
    const state=scope();
    Object.assign(account(state,'bybit'),{status,lastSuccessAt:1});
    assert.deepEqual(opportunityExchangeScope(state),connected);
  }
});
test('never successful, unsupported, removed and reset credentials are excluded',()=>{
  for(const lastSuccessAt of [undefined,0,Number.NaN,Number.POSITIVE_INFINITY]){
    const state=scope();Object.assign(account(state,'bybit'),{status:'error',lastSuccessAt});
    assert.ok(!opportunityExchangeScope(state).includes('bybit'));
  }
  const state=scope();
  state.liveReadiness!.exchanges.find(item=>item.exchange==='binance')!.supported=false;
  account(state,'bybit').credentialsConfigured=false;
  state.config.exchanges=['binance','bybit','gate'];
  assert.deepEqual(opportunityExchangeScope(state),['gate']);
});
test('paper mode keeps its explicitly enabled venues; empty configuration remains empty',()=>{
  const state=scope();state.config.mode='paper';delete state.livePortfolio;delete state.liveReadiness;
  assert.deepEqual(opportunityExchangeScope(state),exchanges);
  state.config.exchanges=[];
  assert.deepEqual(opportunityExchangeScope(state),[]);
});
test('pair projection requires both connected legs and does not mutate source records',()=>{
  const rows=[{id:1,longExchange:'binance' as const,shortExchange:'bybit' as const},
    {id:2,longExchange:'binance' as const,shortExchange:'okx' as const},
    {id:3,longExchange:'okx' as const,shortExchange:'gate' as const}];
  const before=structuredClone(rows);
  assert.deepEqual(filterOpportunityPairs(rows,connected),[rows[0]]);
  assert.deepEqual(filterOpportunityPairs(rows,[]),[]);
  assert.deepEqual(filterOpportunityPairs(rows,['binance']),[]);
  assert.deepEqual(rows,before);
});
test('display dataset excludes disconnected-only coins and disconnected extremes before calculating spreads',()=>{
  const source=data(),before=structuredClone(source),projected=scopedFundingDataset(source,connected);
  assert.deepEqual(projected.rows.map(row=>row.base),['BTC','ONE_VENUE']);
  assert.deepEqual(Object.keys(projected.rows[0].cells),['binance','bybit']);
  const summary=summarizeFundingRow(projected.rows[0],projected,now);
  assert.equal(summary.high,'bybit');assert.equal(summary.gap,.001);
  assert.equal(summarizeFundingRow(projected.rows[1],projected,now).gap,null);
  assert.deepEqual(source,before);
  assert.deepEqual(scopedFundingDataset(source,[]).rows,[]);
});
test('candidate pair counts and missing-data coverage share the identical connected account scope',()=>{
  const dataset=scopedFundingDataset(data(),connected),config={...defaultConfig,mode:'live' as const,exchanges:connected};
  const candidates=calculateFundingCandidates(dataset,config,now);
  assert.equal(candidates.length,1);assert.equal(candidates[0].base,'BTC');
  const coverage=fundingOpportunityCoverage(dataset,config,candidates,[],now);
  assert.equal(coverage.statisticsCoinCount,2);assert.equal(coverage.pairedCoinCount,1);assert.equal(coverage.unpairedCoinCount,1);
  assert.deepEqual(coverage.unpaired.map(row=>row.base),['ONE_VENUE']);
  assert.deepEqual(coverage.unpaired[0].validExchanges,['gate']);
});
