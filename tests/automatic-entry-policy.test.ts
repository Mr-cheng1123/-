import test from 'node:test';
import assert from 'node:assert/strict';
import {automaticEntryAssessment} from '../src/shared/automatic-entry-policy.js';
import type {Opportunity} from '../src/shared/types.js';

const opportunity=(changes:Partial<Opportunity>={}):Opportunity=>({
  combinedExpectedNetUsd:.1,expectedNetUsd:.1,expectedFundingUsd:.3,entryPriceEdgeBps:21,entryLimitPriceEdgeBps:5,
  eligible:true,entryBatch:{pricing:'best-opposite',batchQuantity:10,targetQuantity:100,
    longLimitPrice:1,shortLimitPrice:1.0021,longBestPrice:1,shortBestPrice:1.0021,expectedNetUsd:.01},...changes,
} as Opportunity);

test('automatic entry requires both full-target positive net and strictly more than twenty raw best-price bps',()=>{
  assert.equal(automaticEntryAssessment(opportunity()).passes,true);
  assert.equal(automaticEntryAssessment(opportunity()).route,'single-cycle');
  for(const net of [0,-.1,NaN,Infinity,-Infinity,null,undefined])
    assert.equal(automaticEntryAssessment(opportunity({combinedExpectedNetUsd:net})).passes,false,`net ${net}`);
  for(const edge of [0,-1,19.99,20,20.0000000000003,NaN,Infinity,null,undefined])
    assert.equal(automaticEntryAssessment(opportunity({entryPriceEdgeBps:edge})).passes,false,`edge ${edge}`);
  assert.equal(automaticEntryAssessment(opportunity({entryPriceEdgeBps:20.00001})).passes,true);
});

test('price route permits multi-cycle recovery only with positive net funding, raw above 100 and IOC limit above 80',()=>{
  const priceRoute=opportunity({combinedExpectedNetUsd:-.2,expectedFundingUsd:.01,entryPriceEdgeBps:110,entryLimitPriceEdgeBps:90});
  assert.deepEqual(automaticEntryAssessment(priceRoute),{passes:true,route:'price-100',netPnlUsd:-.2,
    oppositePriceEdgeBps:110,iocLimitPriceEdgeBps:90,fundingUsd:.01});
  assert.equal(automaticEntryAssessment({...priceRoute,combinedExpectedNetUsd:null}).route,'price-100');
  for(const edge of [100,100.0000000000003,NaN,Infinity,undefined])
    assert.equal(automaticEntryAssessment({...priceRoute,entryPriceEdgeBps:edge}).passes,false,`raw ${edge}`);
  for(const edge of [80,80.0000000000003,NaN,Infinity,null,undefined])
    assert.equal(automaticEntryAssessment({...priceRoute,entryLimitPriceEdgeBps:edge}).passes,false,`IOC ${edge}`);
  for(const funding of [0,-.01,NaN,Infinity,null,undefined])
    assert.equal(automaticEntryAssessment({...priceRoute,expectedFundingUsd:funding as number}).passes,false,`funding ${funding}`);
  assert.equal(automaticEntryAssessment({...priceRoute,entryPriceEdgeBps:100.00001,entryLimitPriceEdgeBps:80.00001}).route,'price-100');
  assert.equal(automaticEntryAssessment({...priceRoute,entryBatch:undefined}).passes,false);
});

test('single-cycle path remains preferred and does not inherit the price route IOC threshold',()=>{
  assert.equal(automaticEntryAssessment(opportunity({entryPriceEdgeBps:110,entryLimitPriceEdgeBps:90})).route,'single-cycle');
  assert.equal(automaticEntryAssessment(opportunity({entryPriceEdgeBps:110,entryLimitPriceEdgeBps:5})).route,'single-cycle');
  assert.equal(automaticEntryAssessment(opportunity({entryPriceEdgeBps:99,entryLimitPriceEdgeBps:90,combinedExpectedNetUsd:-.2})).route,null);
});

test('positive tab uses full target net, never a known fee subtotal or first-batch positive value as a substitute',()=>{
  assert.equal(automaticEntryAssessment(opportunity({combinedExpectedNetUsd:null,expectedNetUsd:5,fundingAfterFeesUsd:5})).passes,false);
  assert.equal(automaticEntryAssessment(opportunity({combinedExpectedNetUsd:-.1})).passes,false);
  assert.equal(automaticEntryAssessment(undefined).passes,false);
});

test('raw opposite edge and buffered IOC edge remain distinct and a legal current batch is required',()=>{
  assert.equal(automaticEntryAssessment(opportunity({entryLimitPriceEdgeBps:5})).passes,true);
  assert.equal(automaticEntryAssessment(opportunity({entryPriceEdgeBps:19,entryLimitPriceEdgeBps:100})).passes,false);
  assert.equal(automaticEntryAssessment(opportunity({entryBatch:undefined})).passes,false);
  for(const quantity of [0,-1,NaN,Infinity])assert.equal(automaticEntryAssessment(opportunity({entryBatch:{
    ...opportunity().entryBatch!,batchQuantity:quantity}})).passes,false);
});

test('automatic qualification neither alters manual eligibility nor depends on rounded display numbers',()=>{
  const manual=opportunity({combinedExpectedNetUsd:-1,entryPriceEdgeBps:5});
  const before=structuredClone(manual);assert.equal(automaticEntryAssessment(manual).passes,false);
  assert.equal(manual.eligible,true);assert.deepEqual(manual,before);
  assert.equal(automaticEntryAssessment(opportunity({combinedExpectedNetUsd:.00000001,entryPriceEdgeBps:20.00001})).passes,true);
});
