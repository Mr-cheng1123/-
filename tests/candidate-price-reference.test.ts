import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfig} from '../src/shared/config.js';
import type {AppState,MarketSnapshot,Opportunity} from '../src/shared/types.js';
import type {FundingCandidateView} from '../src/shared/funding-opportunities.js';
import {candidateBboReference,candidatePricePresentation,retainCandidateReferenceQuotes,candidateReferenceQuoteCaption} from '../web/src/candidate-price-reference.js';
import {quoteIsFresh} from '../src/core/market-validity.js';
import {candidateReadyToStart} from '../web/src/candidate-readiness.js';
import {automaticEntryAssessment} from '../src/shared/automatic-entry-policy.js';

const now=100_000_000;
const config={...defaultConfig,mode:'live' as const,entryPolicy:'aligned' as const,maxSnapshotAgeMs:10_000,maxQuoteSkewMs:1000};
const quote=(exchange:'binance'|'gate',indexPrice=40):MarketSnapshot=>({exchange,base:'NKE',symbol:'NKE/USDT:USDT',
  timestamp:now,observedAt:now,bookTransport:'rest',indexPrice,markPrice:indexPrice,fundingRate:.001,
  nextFundingTime:now+3600000,intervalHours:8,fundingHistory:[],quantityStep:.1,minQuantity:.1,minNotional:5,
  contractSize:1,source:'public',openInterestUsd:0,volume24hUsd:0,
  bids:[{price:exchange==='binance'?39.9:41,quantity:100}],asks:[{price:exchange==='binance'?40:41.1,quantity:100}]});
const row=():FundingCandidateView=>({id:'NKE-binance-gate',base:'NKE',longExchange:'binance',shortExchange:'gate',
  verification:'pending',reasons:[],updatedAt:now} as unknown as FundingCandidateView);
const lookup=(long=quote('binance'),short=quote('gate'))=>new Map([[`binance:NKE`,long],[`gate:NKE`,short]]);
const execution=():Opportunity=>({id:'NKE-binance-gate',base:'NKE',longExchange:'binance',shortExchange:'gate',
  entryPolicy:'aligned',entryReady:false,eligible:false,entryPriceEdgeBps:177,entryLimitPriceEdgeBps:166,
  longObservedAt:now,shortObservedAt:now,reasons:['数量待核验'],checks:[],
  entryBatch:{pricing:'best-opposite',targetQuantity:2.5,batchQuantity:1,longLimitPrice:40.02,shortLimitPrice:40.99,
    longBestPrice:40,shortBestPrice:41}} as unknown as Opportunity);

test('valid BBOs show a separate reference using the strategy index denominator without manufacturing execution',()=>{
  const candidate=row(),quotes=lookup(quote('binance',39),quote('gate',41)),before=structuredClone(candidate);
  const result=candidatePricePresentation(candidate,quotes,config,now);
  assert.equal(result.kind,'reference');assert.equal(result.label,'参考对手价1价差');
  assert.equal(result.edgeBps,250);assert.equal(result.iocEdgeBps,null);assert.equal(result.batch,undefined);
  assert.equal(result.reference.status,'ready');assert.deepEqual(candidate,before);assert.equal(candidate.execution,undefined);
});

test('BBO reference scans real best opposite levels and remains signed for zero and disadvantage',()=>{
  const long=quote('binance'),short=quote('gate');
  long.asks.unshift({price:42,quantity:100});short.bids.unshift({price:38,quantity:100});
  assert.equal(candidatePricePresentation(row(),lookup(long,short),config,now).edgeBps,250);
  short.bids=[{price:40,quantity:100}];assert.equal(candidatePricePresentation(row(),lookup(long,short),config,now).edgeBps,0);
  short.bids=[{price:39,quantity:100}];assert.equal(candidatePricePresentation(row(),lookup(long,short),config,now).edgeBps,-250);
});

test('missing, invalid, crossed or mismatched evidence reports its reason without a current numeric reference',()=>{
  const examples=[
    {quotes:new Map([['binance:NKE',quote('binance')]]),reason:/Gate 未收到 10 秒内的有效参考盘口/},
    {quotes:lookup({...quote('binance'),indexPrice:0}),reason:/指数价格无效/},
    {quotes:lookup({...quote('binance'),bids:[{price:42,quantity:100}]}),reason:/盘口倒挂/},
    {quotes:lookup(quote('binance'),{...quote('gate'),bids:[{price:41,quantity:0}]}),reason:/首档数量不足/},
    {quotes:lookup({...quote('binance'),base:'OTHER'}),reason:/币种或交易所不匹配/},
    {quotes:lookup(quote('binance'),{...quote('gate'),source:'demo'}),reason:/数据来源不一致/},
  ];
  for(const example of examples){
    const result=candidatePricePresentation(row(),example.quotes,config,now);
    assert.equal(result.kind,'waiting');assert.equal(result.edgeBps,null);assert.equal(result.iocEdgeBps,null);
    assert.match(result.reason,example.reason);
  }
});

test('real observed times allow quiet REST books while stale, future or skewed observations cannot masquerade as current',()=>{
  const quiet={...quote('binance'),timestamp:now-86400000};
  assert.equal(candidateBboReference(row(),lookup(quiet),config,now).status,'ready');
  for(const long of [{...quiet,observedAt:now-10001},{...quiet,observedAt:now+5001}]){
    const result=candidatePricePresentation(row(),lookup(long),config,now);
    assert.equal(result.edgeBps,null);assert.match(result.reason,/已过期/);
  }
  const skewed=candidatePricePresentation(row(),lookup({...quiet,observedAt:now-1001}),config,now);
  assert.equal(skewed.edgeBps,null);assert.match(skewed.reason,/两腿盘口采集相差 1001 毫秒/);
});

test('WebSocket references use a bounded ten-second display window without changing the two-second execution guard',()=>{
  const ws={...quote('binance'),bookTransport:'websocket' as const,fundingObservedAt:now};
  assert.equal(candidateBboReference(row(),lookup(ws),config,now).status,'ready');
  const short={...quote('gate'),bookTransport:'websocket' as const,fundingObservedAt:now};
  assert.equal(quoteIsFresh(ws,config,now+3000),false);
  const display=candidatePricePresentation({...row(),execution:execution()},lookup(ws,short),config,now+3000);
  assert.equal(display.kind,'reference');assert.equal(display.edgeBps,250);assert.equal(display.iocEdgeBps,null);
  assert.match(display.reason,/3 秒前 · 数量\/IOC待核验/);
  for(const long of [{...ws,observedAt:now-10001},{...ws,fundingObservedAt:now-30001},{...ws,fundingObservedAt:undefined}]){
    const result=candidatePricePresentation(row(),lookup(long),config,now);
    assert.equal(result.edgeBps,null);assert.match(result.reason,/超过 10 秒或价格元数据已过期/);
  }
});

test('display cache preserves real quote records across pruning, clears them at eleven seconds and drops removed venues',()=>{
  const long={...quote('binance'),bookTransport:'websocket' as const,fundingObservedAt:now};
  const short={...quote('gate'),bookTransport:'websocket' as const,fundingObservedAt:now};
  const before=structuredClone([long,short]);
  const first=retainCandidateReferenceQuotes(new Map(),[long,short],['binance','gate'],now);
  const pruned=retainCandidateReferenceQuotes(first,[],['binance','gate'],now+3000);
  assert.equal(pruned.size,2);assert.equal(pruned.get('binance:NKE'),long);assert.equal(pruned.get('gate:NKE'),short);
  const price=candidatePricePresentation(row(),pruned,config,now+3000);
  assert.equal(price.kind,'reference');assert.equal(price.edgeBps,250);
  assert.equal(price.reference.status,'ready');
  if(price.reference.status==='ready'){
    assert.equal(price.reference.longObservedAt,now);assert.equal(price.reference.shortObservedAt,now);
    assert.match(candidateReferenceQuoteCaption(price.reference,now+3000)!,/3 秒前/);
  }
  assert.deepEqual([long,short],before,'No observation, transport or metadata time may be refreshed by display retention.');
  assert.equal(retainCandidateReferenceQuotes(pruned,[],['binance','gate'],now+11000).size,0);
  const removed=retainCandidateReferenceQuotes(pruned,[],['binance'],now+3000);
  assert.deepEqual([...removed.keys()],['binance:NKE']);
  assert.equal(candidatePricePresentation(row(),removed,config,now+3000).edgeBps,null);
});

test('older arrivals cannot rewind a retained quote or fabricate a new observation time',()=>{
  const current=quote('binance');
  const first=retainCandidateReferenceQuotes(new Map(),[current],['binance'],now);
  const older={...current,observedAt:now-1000,markPrice:99};
  const retained=retainCandidateReferenceQuotes(first,[older],['binance'],now+3000);
  assert.equal(retained.get('binance:NKE'),current);assert.equal(retained.get('binance:NKE')!.observedAt,now);
  assert.equal(retainCandidateReferenceQuotes(retained,[older],['binance'],now+11000).size,0);
});

test('same-ticker instrument conflicts never produce a same-asset reference edge',()=>{
  const candidate={...row(),base:'EDGE'},long={...quote('binance'),base:'EDGE'},short={...quote('gate'),base:'EDGE'};
  const result=candidateBboReference(candidate,new Map([['binance:EDGE',long],['gate:EDGE',short]]),config,now);
  assert.equal(result.status,'waiting');assert.match(result.reason,/同名不同标的/);
});

test('a fresh real batch is displayed ahead of reference data and keeps only its actual IOC number',()=>{
  const candidate={...row(),execution:execution()};
  const result=candidatePricePresentation(candidate,lookup(),config,now);
  assert.equal(result.kind,'batch');assert.equal(result.label,'本批对手价1价格优势');
  assert.equal(result.edgeBps,177);assert.equal(result.iocEdgeBps,166);assert.ok(result.batch);
  assert.equal(result.reference.status,'ready');
  if(result.reference.status==='ready')assert.equal(result.reference.edgeBps,250);
});

test('old, unobserved, wrong-pair or invalid batch results fall back without retaining their IOC bounds',()=>{
  const examples=[
    {...execution(),longObservedAt:now-10001,shortObservedAt:now-10001},
    {...execution(),longObservedAt:undefined},
    {...execution(),base:'OTHER'},
    {...execution(),entryBatch:{...execution().entryBatch!,batchQuantity:0}},
  ];
  for(const stale of examples){
    const result=candidatePricePresentation({...row(),execution:stale},lookup(),config,now);
    assert.equal(result.kind,'reference');assert.equal(result.edgeBps,250);assert.equal(result.iocEdgeBps,null);assert.equal(result.batch,undefined);
  }
});

test('WebSocket batch observations expire independently of a newly received BBO reference',()=>{
  const candidate={...row(),execution:{...execution(),longObservedAt:now-2001,shortObservedAt:now-2001}};
  const quotes=lookup({...quote('binance'),bookTransport:'websocket',fundingObservedAt:now});
  const result=candidatePricePresentation(candidate,quotes,config,now);
  assert.equal(result.kind,'reference');assert.equal(result.iocEdgeBps,null);
});

test('a positive reference cannot affect automatic thresholds or submit readiness',()=>{
  const candidate=row(),before=structuredClone(candidate),opportunity=candidate.execution;
  const assessmentBefore=automaticEntryAssessment(opportunity);
  const state={config,positions:[],killSwitch:false} as unknown as AppState;
  const context={state,data:null,now,synchronized:true};
  assert.equal(candidateReadyToStart(candidate,context),false);
  const result=candidatePricePresentation(candidate,lookup(),config,now);
  assert.equal(result.edgeBps,250);
  assert.equal(candidateReadyToStart(candidate,context),false);
  assert.deepEqual(automaticEntryAssessment(candidate.execution),assessmentBefore);assert.deepEqual(candidate,before);
});
