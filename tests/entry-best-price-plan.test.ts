import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfig} from '../src/shared/config.js';
import type {AppConfig,MarketSnapshot} from '../src/shared/types.js';
import {calculateOpportunities,commonStep,floorQuantity} from '../src/core/strategy.js';
import {bestOppositeLevel,planBestPriceEntryBatch} from '../src/core/entry-batch.js';

const now=1_790_921_600_000;
const config:AppConfig={...defaultConfig,entryPolicy:'aligned',orderNotionalUsd:100,minCombinedNetUsd:999,
  takerFees:{...defaultConfig.takerFees,gate:.0005,bitget:.0006}};
function quote(change:Partial<MarketSnapshot>={}):MarketSnapshot{return {exchange:'gate',base:'CT',symbol:'CT/USDT:USDT',
  timestamp:now,observedAt:now,markPrice:99.9,indexPrice:100,fundingRate:0,nextFundingTime:now+60_000,intervalHours:8,
  fundingHistory:[],bids:[{price:99.8,quantity:5}],asks:[{price:99.9,quantity:5}],openInterestUsd:0,volume24hUsd:0,
  quantityStep:.001,minQuantity:.001,minNotional:5,contractSize:1,source:'public',...change};}
function pair(){return [quote(),quote({exchange:'bitget',markPrice:101,fundingRate:.0005,
  bids:[{price:100.9,quantity:5}],asks:[{price:101,quantity:5}]})];}
const near=(value:number,expected:number)=>assert(Math.abs(value-expected)<1e-9,`${value} != ${expected}`);

test('best opposite prices aggregate only that native level and ignore invalid or deeper quotes without mutating the book',()=>{
  const snapshot=quote({asks:[{price:103,quantity:9},{price:NaN,quantity:5},{price:99.9,quantity:.2},
    {price:99.8,quantity:0},{price:99.9,quantity:.3},{price:99.7,quantity:-1}],
    bids:[{price:98,quantity:9},{price:99.8,quantity:.2},{price:99.8,quantity:.4},{price:Infinity,quantity:9}]});
  const before=JSON.stringify(snapshot);
  assert.deepEqual(bestOppositeLevel(snapshot,'buy'),{price:99.9,quantity:.5});
  const sell=bestOppositeLevel(snapshot,'sell')!;assert.equal(sell.price,99.8);near(sell.quantity,.6);
  assert.equal(JSON.stringify(snapshot),before);
});

test('first batch uses the common coin step and both top depths while the original full target is preserved',()=>{
  const snapshots=pair();Object.assign(snapshots[0],{quantityStep:.1,minQuantity:.5,asks:[{price:99.9,quantity:3.87}]});
  Object.assign(snapshots[1],{quantityStep:.3,minQuantity:.6,bids:[{price:100.9,quantity:4.09}]});
  const [o]=calculateOpportunities(snapshots,{...config,orderNotionalUsd:500},now);
  assert.equal(o.eligible,true,o.reasons.join('；'));
  near(commonStep(.1,.3),.3);near(floorQuantity(5,.3),4.8);
  near(o.longQuantity,4.8);near(o.shortQuantity,4.8);near(o.entryBatch!.targetQuantity,4.8);near(o.entryBatch!.batchQuantity,3.6);
  const plan=planBestPriceEntryBatch(snapshots[0],snapshots[1],o.longQuantity)!;
  near(plan.commonQuantityStep,.3);near(plan.quantity,3.6);assert.equal(plan.longLimitPrice,99.9);assert.equal(plan.shortLimitPrice,100.9);
  near(o.expectedFundingUsd,4.8*101*.0005);
  assert.equal(o.entryLimitNetUsd,null);assert.equal(o.entryLimitSpreadAfterFeesUsd,null);
});

test('favorable top prices remain executable when a full-size sweep would consume unfavorable deeper prices',()=>{
  const snapshots=pair();snapshots[0].asks=[{price:102,quantity:5},{price:99.9,quantity:.2}];
  snapshots[1].bids=[{price:97,quantity:5},{price:100.9,quantity:.25}];
  const [o]=calculateOpportunities(snapshots,config,now);
  assert.equal(o.eligible,true,o.reasons.join('；'));
  const {bookCost,expectedFundingUsd,expectedNetUsd,...plan}=o.entryBatch!;
  assert.deepEqual(plan,{pricing:'best-opposite',targetQuantity:1,batchQuantity:.2,longLimitPrice:99.9,shortLimitPrice:100.9,
    longBestPrice:99.9,shortBestPrice:100.9,longPriceBufferBps:0,shortPriceBufferBps:0});
  near(bookCost!.quantity,.2);near(bookCost!.roundTripBookLossUsd,.04);
  near(expectedNetUsd!,expectedFundingUsd!-.2*((99.9+99.9)*.0005+(100.9+101)*.0006));
  near(o.entryPriceEdgeBps!,100);near(o.entryLimitPriceEdgeBps!,100);assert.equal(o.longQuantity,1);assert.equal(o.shortQuantity,1);
  near(o.combinedExpectedNetUsd!,o.expectedFundingUsd-o.feesUsd);
  assert(o.combinedExpectedNetUsd!<0,'this target funding does not cover four fees; depth cost remains diagnostic only');
  assert.equal(o.entryLimitNetUsd,null);assert.equal(o.entryLimitSpreadAfterFeesUsd,null);
  assert(o.checks!.find(check=>check.label==='双腿开仓盘口够成交整笔数量')!.actual!.includes('首批 0.2 / 完整目标 1'));
});

test('legal top-depth batch can start even when full-goal opening or future closing books are not available',()=>{
  const snapshots=pair();snapshots[0].asks=[{price:99.9,quantity:.2}];snapshots[0].bids=[];
  snapshots[1].bids=[{price:100.9,quantity:.25}];snapshots[1].asks=[];
  const [o]=calculateOpportunities(snapshots,config,now);
  assert.equal(o.eligible,true,o.reasons.join('；'));assert.equal(o.entryBatch!.batchQuantity,.2);
  assert.equal(o.longQuantity,1);assert.equal(o.shortQuantity,1);near(o.expectedFundingUsd,.0505);
  near(o.feesUsd,.2211);near(o.combinedExpectedNetUsd!,.0505-.2211);assert.equal(o.entryLimitNetUsd,null);
  assert.equal(o.bookCost,undefined,'unknown future closing loss is not fabricated as a zero cost');
});

test('larger deeper depth cannot rescue a top batch that fails a shared lot, either venue minimum, or either minimum notional',()=>{
  for(const change of [
    (snapshots:MarketSnapshot[])=>{snapshots[0].asks=[{price:99.9,quantity:.2},{price:100,quantity:5}];snapshots[1].quantityStep=.3;},
    (snapshots:MarketSnapshot[])=>{snapshots[0].asks=[{price:99.9,quantity:.2},{price:100,quantity:5}];snapshots[0].minQuantity=.201;},
    (snapshots:MarketSnapshot[])=>{snapshots[0].asks=[{price:99.9,quantity:.2},{price:100,quantity:5}];snapshots[1].minQuantity=.201;},
    (snapshots:MarketSnapshot[])=>{snapshots[0].asks=[{price:99.9,quantity:.049},{price:100,quantity:5}];},
    (snapshots:MarketSnapshot[])=>{snapshots[0].asks=[{price:99.9,quantity:.2},{price:100,quantity:5}];snapshots[1].minNotional=21;},
  ]){
    const snapshots=pair();change(snapshots);
    assert.equal(planBestPriceEntryBatch(snapshots[0],snapshots[1],1),undefined);
    const [o]=calculateOpportunities(snapshots,config,now);assert.equal(o.eligible,false);assert.equal(o.entryBatch,undefined);
    assert.equal(o.entryLimitPriceEdgeBps,null);assert.equal(o.checks!.find(check=>check.label==='数量达到交易所最小下单量')!.pass,false);
  }
});

test('a genuinely sub-lot best level is not rounded into an executable batch while ordinary duplicate-row float noise is accepted',()=>{
  const snapshots=pair();
  snapshots[0].quantityStep=1;snapshots[0].minQuantity=1;
  snapshots[1].quantityStep=1;snapshots[1].minQuantity=1;
  snapshots[0].asks=[{price:99.9,quantity:.9999999999},{price:102,quantity:5}];
  assert.equal(planBestPriceEntryBatch(snapshots[0],snapshots[1],1),undefined,
    'one full coin cannot be priced solely by a best level that is materially below the minimum lot');
  const [o]=calculateOpportunities(snapshots,config,now);
  assert.equal(o.eligible,false);assert.equal(o.entryBatch,undefined);assert.equal(o.entryLimitPriceEdgeBps,null);
  const duplicate=pair();duplicate[0].quantityStep=.1;duplicate[1].quantityStep=.1;
  duplicate[0].asks=[{price:99.9,quantity:.1},{price:99.9,quantity:.2}];
  duplicate[1].bids=[{price:100.9,quantity:.3}];
  assert.equal(planBestPriceEntryBatch(duplicate[0],duplicate[1],.3)!.quantity,.3);
  assert.equal(calculateOpportunities(duplicate,config,now)[0].entryBatch!.batchQuantity,.3);
});

test('strict best-price IOC thresholds accept ordinary positive edges and reject exact configured boundaries',()=>{
  for(const [minimum,shortBid,eligible] of [[0,99.9,false],[0,99.95,true],[0,100.1,true],
    [20,100.099,false],[20,100.1,false],[20,100.10001,true]] as const){
    const snapshots=pair();snapshots[0].asks=[{price:99.9,quantity:.2},{price:102,quantity:5}];
    snapshots[1].bids=[{price:shortBid,quantity:.25},{price:97,quantity:5}];
    const [o]=calculateOpportunities(snapshots,{...config,minEntryIocEdgeBps:minimum},now);
    assert.equal(o.eligible,eligible,`${minimum} bps / ${shortBid}: ${o.reasons.join('；')}`);
    near(o.entryLimitPriceEdgeBps!,(shortBid-99.9)/100*10000);
    assert.equal(o.checks!.find(check=>check.label==='实际 IOC 开仓价格优势达标')!.required,`> ${minimum} bps`);
  }
});

test('best-price planning does not change funding/dual economics or bypass exact live official fee evidence',()=>{
  const snapshots=pair();snapshots[0].asks=[{price:99.9,quantity:.2},{price:102,quantity:5}];
  snapshots[1].bids=[{price:100.9,quantity:.25},{price:97,quantity:5}];
  for(const entryPolicy of ['funding','dual'] as const){
    const [o]=calculateOpportunities(snapshots,{...config,entryPolicy},now);
    assert.equal(o.entryBatch,undefined);assert.equal(o.eligible,false);assert.equal(o.longQuantity,1);assert.equal(o.shortQuantity,1);
  }
  const live={...config,mode:'live' as const};
  snapshots[0].takerFeeSource='exchange';snapshots[0].takerFeeAt=now;snapshots[0].takerFeeRate=.0005;
  assert.equal(calculateOpportunities(snapshots,live,now)[0].eligible,false,'one configured or known fee never substitutes for the other native contract');
  snapshots[1].takerFeeSource='exchange';snapshots[1].takerFeeAt=now;snapshots[1].takerFeeRate=.0006;
  assert.equal(calculateOpportunities(snapshots,live,now)[0].eligible,true);
});
