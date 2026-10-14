import test from 'node:test';
import assert from 'node:assert/strict';
import { instrumentIdentityBlockReason } from '../src/shared/instrument-identity.js';
import { calculateFundingCandidates } from '../src/shared/funding-opportunities.js';
import { calculateOpportunities } from '../src/core/strategy.js';
import { defaultConfig } from './legacy-config.js';
import type { FundingStatsDataset } from '../src/shared/funding-statistics.js';
import type { ExchangeId, MarketSnapshot } from '../src/shared/types.js';

const now=1_700_000_000_000;
const quote=(base:string,exchange:ExchangeId,fundingRate:number):MarketSnapshot=>({exchange,base,symbol:`${base}/USDT:USDT`,timestamp:now,
  takerFeeRate:.0005,takerFeeAt:now,takerFeeSource:'exchange',
  markPrice:100,indexPrice:100,fundingRate,nextFundingTime:now+60_000,intervalHours:8,fundingHistory:[fundingRate,fundingRate,fundingRate],
  asks:[{price:100,quantity:100}],bids:[{price:100,quantity:100}],quantityStep:.01,minQuantity:.01,minNotional:1,contractSize:1,
  openInterestUsd:1e9,volume24hUsd:1e9,source:'public'});
const data=(base:string,a:ExchangeId,b:ExchangeId):FundingStatsDataset=>({source:'exchanges',range:'current',status:'ready',
  rows:[{base,cells:Object.fromEntries([[a,0],[b,.01]].map(([exchange,rate])=>[exchange,{exchange,rate,intervalHours:8,nextFundingTime:now+60_000,
    updatedAt:now,timestampKind:'received',available:true,openInterestUsd:1e9,volume24hUsd:1e9}]))}],
  receivedAt:now,lastAttemptAt:now,nextRefreshAt:now+20_000,maxAgeMs:120_000,sourceUrl:'https://example.test',marginScope:'USDT'});

test('known Bitget naming conflicts require identity verification in either direction and do not assert different assets',()=>{
  for(const base of ['HANMI','SAMSUNGEM'])for(const other of ['binance','bybit','okx','gate'] as const){
    const first=instrumentIdentityBlockReason(base,'bitget',other),second=instrumentIdentityBlockReason(base,other,'bitget');
    assert.equal(first,second);assert.match(first!,/官方标的身份待核验/);assert.match(first!,/尚不能确认是同一标的/);
  }
  assert.equal(instrumentIdentityBlockReason('HANMI','gate','okx'),undefined);
  assert.equal(instrumentIdentityBlockReason('HANMI','bitget','bitget'),undefined);
  assert.equal(instrumentIdentityBlockReason('NAVER','gate','bitget'),undefined);
  assert.equal(instrumentIdentityBlockReason('SFP','gate','bitget'),undefined);
});

test('identity conflicts keep funding rows and estimates visible but block both statistical and executable candidates, including fee-only',()=>{
  for(const feeOnly of [false,true])for(const base of ['HANMI','SAMSUNGEM']){
    const config={...defaultConfig,mode:'live' as const,feeOnly,orderNotionalUsd:100,minNetProfitUsd:0};
    const [candidate]=calculateFundingCandidates(data(base,'gate','bitget'),config,now);
    assert.ok(candidate);assert.ok(candidate.grossFundingUsd>0);assert.equal(candidate.feesSource,'reference');
    assert.ok(Math.abs(candidate.feesUsd-.22)<1e-12);assert.equal(candidate.afterFeesUsd,candidate.grossFundingUsd-candidate.feesUsd);
    assert.equal(candidate.candidateEligible,false);assert.ok(candidate.reasons.some(reason=>reason.includes('官方标的身份待核验')));
    const [opportunity]=calculateOpportunities([quote(base,'gate',0),quote(base,'bitget',.01)],config,now);
    assert.ok(opportunity);assert.ok(opportunity.expectedFundingUsd>0);assert.equal(opportunity.eligible,false);
    assert.ok(opportunity.reasons.some(reason=>reason.includes('官方标的身份待核验')));
  }
});

test('identity check is confined to the unresolved venue-symbol mappings',()=>{
  const config={...defaultConfig,mode:'live' as const,feeOnly:true,orderNotionalUsd:100};
  for(const [base,a,b] of [['HANMI','gate','okx'],['SAMSUNGEM','binance','bybit'],['NAVER','gate','bitget'],['SFP','gate','bitget']] as const){
    const [candidate]=calculateFundingCandidates(data(base,a,b),config,now);
    const [opportunity]=calculateOpportunities([quote(base,a,0),quote(base,b,.01)],config,now);
    assert.equal(candidate.candidateEligible,true,`${base} ${a} ${b}`);
    // Not blocked by identity (the spread history is still warming here, which is a different, expected reason).
    assert.ok(!opportunity.reasons.some(reason=>reason.includes('身份')),`${base} ${a} ${b}`);
  }
});

test('Gate EDGE Definitive cannot pair with edgeX despite the equal ticker and apparently favorable price',()=>{
  const config={...defaultConfig,entryPolicy:'aligned' as const,mode:'live' as const,feeOnly:true};
  for(const other of ['bybit','binance','okx'] as const){
    assert.match(instrumentIdentityBlockReason('EDGE','gate',other)!,/同名不同标的/);
    assert.equal(instrumentIdentityBlockReason('EDGE','gate',other),instrumentIdentityBlockReason('EDGE',other,'gate'));
    const [candidate]=calculateFundingCandidates(data('EDGE','gate',other),config,now);
    assert.equal(candidate.candidateEligible,false);assert.ok(candidate.reasons.some(r=>r.includes('Definitive')));
    const a=quote('EDGE','gate',0),b=quote('EDGE',other,.01);
    a.markPrice=a.indexPrice=.107;a.asks=a.bids=[{price:.107,quantity:1e6}];
    b.markPrice=b.indexPrice=.5;b.asks=b.bids=[{price:.5,quantity:1e6}];
    const [opportunity]=calculateOpportunities([a,b],config,now);
    assert.ok(opportunity.entryPriceEdgeBps!>0);assert.equal(opportunity.eligible,false);
  }
  assert.equal(instrumentIdentityBlockReason('EDGE','bybit','binance'),undefined);
  assert.equal(instrumentIdentityBlockReason('ONE','gate','bitget'),undefined);
});
