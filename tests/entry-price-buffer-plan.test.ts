import test from 'node:test';
import assert from 'node:assert/strict';
import {bestOppositeLevel,planBestPriceEntryBatch,planBufferedLongEntry} from '../src/core/entry-batch.js';
import type {MarketSnapshot} from '../src/shared/types.js';

function quote(change:Partial<MarketSnapshot>={}):MarketSnapshot{return {exchange:'gate',base:'SAND',symbol:'SAND/USDT:USDT',
  timestamp:1,observedAt:1,markPrice:100,indexPrice:100,fundingRate:0,nextFundingTime:60_000,intervalHours:8,
  fundingHistory:[],bids:[{price:99.9,quantity:10}],asks:[{price:100,quantity:10}],openInterestUsd:0,volume24hUsd:0,
  quantityStep:.1,minQuantity:.1,minNotional:1,contractSize:1,source:'public',...change};}
const options={bufferBps:8,minEdgeBps:0};
const near=(value:number,expected:number)=>assert(Math.abs(value-expected)<1e-9,`${value} != ${expected}`);

test('legacy callers retain exact opposite prices and the original return shape',()=>{
  const long=quote({asks:[{price:100,quantity:3},{price:100.05,quantity:20}]}),
    short=quote({exchange:'bybit',bids:[{price:102,quantity:4},{price:101.95,quantity:20}]});
  assert.deepEqual(planBestPriceEntryBatch(long,short,10),{
    quantity:3,longLimitPrice:100,shortLimitPrice:102,targetQuantity:10,commonQuantityStep:.1,
  });
});

test('limits use only visible prices inside each 8 bps budget while top-depth quantity stays frozen',()=>{
  const long=quote({quantityStep:.1,asks:[{price:100.07,quantity:20},{price:100.081,quantity:20},
    {price:100,quantity:3.87},{price:100.06,quantity:0},{price:NaN,quantity:5}]}),
    short=quote({exchange:'bybit',quantityStep:.3,bids:[{price:101.9183,quantity:20},{price:102,quantity:4.09},
      {price:101.92,quantity:20},{price:Infinity,quantity:5}]});
  const before=JSON.stringify([long,short]),plan=planBestPriceEntryBatch(long,short,10,options)!;
  near(plan.quantity,3.6);near(plan.commonQuantityStep,.3);assert.equal(plan.targetQuantity,10);
  assert.equal(plan.longLimitPrice,100.07);assert.equal(plan.shortLimitPrice,101.92);
  assert.equal(plan.longBestPrice,100);assert.equal(plan.shortBestPrice,102);
  near(plan.longPriceBufferBps!,7);near(plan.shortPriceBufferBps!,.08/102*10_000);
  assert.equal(JSON.stringify([long,short]),before);
  assert(plan.longPriceBufferBps!<=8);assert(plan.shortPriceBufferBps!<=8);
});

test('a narrow advantage retains at least half of the surplus beyond the minimum edge',()=>{
  const long=quote({asks:[{price:100,quantity:10},{price:100.005,quantity:10},{price:100.006,quantity:20}]}),
    short=quote({exchange:'bybit',bids:[{price:100.04,quantity:10},{price:100.035,quantity:10},{price:100.034,quantity:20}]});
  const plan=planBestPriceEntryBatch(long,short,10,{bufferBps:8,minEdgeBps:2})!;
  assert.equal(plan.longLimitPrice,100.005);assert.equal(plan.shortLimitPrice,100.035);
  const originalExcess=100.04-100-.02,remainingExcess=plan.shortLimitPrice-plan.longLimitPrice-.02;
  assert(remainingExcess+1e-12>=originalExcess*.5);
  assert((plan.shortLimitPrice-plan.longLimitPrice)/100*10_000>2+1e-9);
});

test('reverse, equal, minimum-boundary and invalid budgets preserve the original opposite bounds',()=>{
  for(const [shortBest,minEdgeBps] of [[99.99,0],[100,0],[100.02,2]] as const){
    const long=quote({asks:[{price:100,quantity:10},{price:100.0001,quantity:10}]}),
      short=quote({exchange:'bybit',bids:[{price:shortBest,quantity:10},{price:shortBest-.0001,quantity:10}]});
    const plan=planBestPriceEntryBatch(long,short,10,{bufferBps:8,minEdgeBps})!;
    assert.equal(plan.longLimitPrice,100);assert.equal(plan.shortLimitPrice,shortBest);
    assert.equal(plan.longPriceBufferBps,0);assert.equal(plan.shortPriceBufferBps,0);
  }
  const long=quote({asks:[{price:100,quantity:10},{price:100.05,quantity:10}]}),
    short=quote({exchange:'bybit',bids:[{price:102,quantity:10},{price:101.95,quantity:10}]});
  for(const bad of [{bufferBps:NaN,minEdgeBps:0},{bufferBps:8,minEdgeBps:-1},{bufferBps:Infinity,minEdgeBps:0}]){
    const plan=planBestPriceEntryBatch(long,short,10,bad)!;
    assert.equal(plan.longLimitPrice,100);assert.equal(plan.shortLimitPrice,102);
  }
});

test('buffering neither fabricates absent prices nor rescues an illegal first-level batch with deeper depth',()=>{
  const long=quote({asks:[{price:100,quantity:.09},{price:100.01,quantity:1000}]}),
    short=quote({exchange:'bybit',bids:[{price:102,quantity:10},{price:101.99,quantity:1000}]});
  assert.equal(planBestPriceEntryBatch(long,short,10,options),undefined);
  long.asks=[{price:100,quantity:2}];short.bids=[{price:102,quantity:2}];
  const plan=planBestPriceEntryBatch(long,short,10,options)!;
  assert.equal(plan.quantity,2);assert.equal(plan.longLimitPrice,100);assert.equal(plan.shortLimitPrice,102);
});

test('a buffered short limit cannot drop the fixed batch below the native minimum notional',()=>{
  const long=quote({asks:[{price:100,quantity:.1},{price:100.05,quantity:10}]}),
    short=quote({exchange:'bybit',minNotional:10.2,bids:[{price:102,quantity:.1},{price:101.95,quantity:10}]});
  const plan=planBestPriceEntryBatch(long,short,.1,options)!;
  assert.equal(plan.quantity,.1);assert.equal(plan.shortLimitPrice,102);assert.equal(plan.shortPriceBufferBps,0);
});

test('side-sensitive float comparisons accept an exact budget level and reject meaningfully deeper levels',()=>{
  const long=quote({asks:[{price:.1,quantity:10},{price:.10008,quantity:10},{price:.1000800001,quantity:20}],
      markPrice:.1,indexPrice:.1,minNotional:0}),
    short=quote({exchange:'bybit',bids:[{price:.102,quantity:10},{price:.1019184,quantity:10},{price:.1019183999,quantity:20}],
      markPrice:.102,indexPrice:.1,minNotional:0});
  const plan=planBestPriceEntryBatch(long,short,10,options)!;
  assert.equal(plan.longLimitPrice,.10008);assert.equal(plan.shortLimitPrice,.1019184);
  near(plan.longPriceBufferBps!,8);near(plan.shortPriceBufferBps!,8);
  assert.equal(bestOppositeLevel(long,'buy')!.price,.1);
});

test('a long repair uses the current batch actual short price and caps its own budget at 8 bps',()=>{
  const long=quote({asks:[{price:100,quantity:3.87},{price:100.07,quantity:20},{price:100.09,quantity:20}]}),
    short=quote({exchange:'bybit',bids:[{price:150,quantity:100}]});
  const plan=planBufferedLongEntry(long,short,10,102,{bufferBps:100,minEdgeBps:0})!;
  assert.equal(plan.quantity,3.8);assert.equal(plan.bestPrice,100);assert.equal(plan.limitPrice,100.07);
  near(plan.priceBufferBps,7);
  const narrow=planBufferedLongEntry(long,short,10,100.02,options)!;
  assert.equal(narrow.limitPrice,100,'current or earlier profitable short quotes cannot subsidize this batch');
  const adverse=planBufferedLongEntry(long,short,10,99.99,options)!;
  assert.equal(adverse.limitPrice,100,'the caller must reject this actual-fill basis with its normal entry guard');
});

test('a long repair preserves its minimum edge and uses a legal top-depth quantity only',()=>{
  const long=quote({quantityStep:.3,minQuantity:.6,asks:[{price:100,quantity:3.87},
      {price:100.005,quantity:20},{price:100.006,quantity:20}]}),short=quote({exchange:'bybit'});
  const plan=planBufferedLongEntry(long,short,2.99,100.04,{bufferBps:8,minEdgeBps:2})!;
  near(plan.quantity,2.7);assert.equal(plan.limitPrice,100.005);
  assert((100.04-plan.limitPrice)/100*10_000>2+1e-9);
  assert.equal(planBufferedLongEntry(long,short,.59,100.04,options),undefined);
  assert.equal(planBufferedLongEntry(long,short,2.99,NaN,options),undefined);
  long.asks[0].quantity=.29;
  assert.equal(planBufferedLongEntry(long,short,2.99,100.04,options),undefined);
});
