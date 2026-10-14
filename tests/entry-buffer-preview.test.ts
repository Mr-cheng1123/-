import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfig,validateConfig} from '../src/shared/config.js';
import {startupConfig} from '../src/shared/startup-config.js';
import {configUpdatePolicy} from '../src/shared/config-update-policy.js';
import {calculateOpportunities} from '../src/core/strategy.js';
import {maintenanceHash,maintenanceLedgerHash,validateMaintenanceHandoff,type MaintenanceHandoff} from '../src/core/maintenance-handoff.js';
import type {SavedState} from '../src/core/store.js';
import type {AppConfig,MarketSnapshot,ExchangeId} from '../src/shared/types.js';
import {entryBatchPresentation} from '../web/src/entry-batch-presentation.js';

const now=1_790_921_600_000;
const config:AppConfig={...defaultConfig,entryPolicy:'aligned',orderNotionalUsd:100,
  takerFees:{...defaultConfig.takerFees,gate:.0005,bybit:.0012}};
function quote(change:Partial<MarketSnapshot>={}):MarketSnapshot{return {exchange:'gate',base:'SAND',symbol:'SAND/USDT:USDT',
  timestamp:now,observedAt:now,markPrice:100,indexPrice:100,fundingRate:0,nextFundingTime:now+60_000,intervalHours:8,
  fundingHistory:[],bids:[{price:99.9,quantity:5}],asks:[{price:100,quantity:5},{price:100.07,quantity:5}],
  openInterestUsd:0,volume24hUsd:0,quantityStep:.001,minQuantity:.001,minNotional:5,contractSize:1,source:'public',...change};}
const pair=()=>[quote(),quote({exchange:'bybit',markPrice:102,fundingRate:.0005,
  bids:[{price:102,quantity:5},{price:101.92,quantity:5}],asks:[{price:102.1,quantity:5}]})];
const near=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);

test('aligned preview keeps raw opposite advantage separate from buffered IOC limits and their displayed advantage',()=>{
  const snapshots=pair(),before=structuredClone(snapshots);
  const [o]=calculateOpportunities(snapshots,config,now),display=entryBatchPresentation(o,100)!;
  assert.equal(o.eligible,true,o.reasons.join('；'));
  near(o.entryPriceEdgeBps!,200);near(o.entryLimitPriceEdgeBps!,185);
  assert.equal(o.entryBatch!.longBestPrice,100);assert.equal(o.entryBatch!.shortBestPrice,102);
  assert.equal(o.entryBatch!.longLimitPrice,100.07);assert.equal(o.entryBatch!.shortLimitPrice,101.92);
  assert.equal(display.bestPriceEdge,'本批对手价1价格优势 200 bps');
  assert.equal(display.limitPriceEdge,'本批 IOC 实际限价价格优势 185 bps');
  assert.match(display.bestPrices!,/多腿卖一 100 · 空腿买一 102/);
  assert.match(display.prices,/买入限价 100\.07 · 空腿 IOC 卖出限价 101\.92/);
  assert.deepEqual(snapshots,before,'preview must not reorder or change shared execution books');
});

test('aligned IOC fee-only forecast uses buffered opening notionals and mark-based future closing fee estimates',()=>{
  const [buffered]=calculateOpportunities(pair(),config,now);
  const [exact]=calculateOpportunities(pair(),{...config,entryIocBufferBps:0},now);
  // One coin: four fees at two opening IOC bounds and two current mark notionals.
  const bufferedFees=(100.07+100)*.0005+(101.92+102)*.0012;
  near(buffered.expectedFundingUsd,.051);near(buffered.entryLimitSpreadAfterFeesUsd!,-bufferedFees);
  near(buffered.entryLimitNetUsd!,.051-bufferedFees);
  // Current depth costs remain observable diagnostics but are not subtracted from aligned income.
  near(buffered.bookCost!.roundTripBookLossUsd,.2);
  near(buffered.feesUsd,.3448);near(buffered.combinedExpectedNetUsd!,.051-.3448);
  near(exact.entryLimitNetUsd!,.051-.3448);
  assert.ok(buffered.entryLimitPriceEdgeBps!<exact.entryLimitPriceEdgeBps!,'IOC buffering is checked through its independent price advantage');
});

test('zero buffer restores exact opposite prices while an absent setting uses the runtime eight bps default',()=>{
  const [implicit]=calculateOpportunities(pair(),config,now);
  const [explicit]=calculateOpportunities(pair(),{...config,entryIocBufferBps:8},now);
  const [exact]=calculateOpportunities(pair(),{...config,entryIocBufferBps:0},now);
  assert.deepEqual(implicit.entryBatch,explicit.entryBatch);
  assert.equal(exact.entryBatch!.longLimitPrice,100);assert.equal(exact.entryBatch!.shortLimitPrice,102);
  assert.equal(exact.entryBatch!.longPriceBufferBps,0);assert.equal(exact.entryBatch!.shortPriceBufferBps,0);
  near(exact.entryPriceEdgeBps!,200);near(exact.entryLimitPriceEdgeBps!,200);
});

test('buffer setting validation preserves explicit limits and treats a saved change as new-entry policy',()=>{
  for(const value of [0,8,50]){
    const parsed=validateConfig({...config,entryIocBufferBps:value});
    assert.equal(parsed.entryIocBufferBps,value);
    assert.equal(startupConfig({},parsed,'paper').entryIocBufferBps,value);
    const policy=configUpdatePolicy(validateConfig(config),parsed);
    assert.equal(policy.entryOnly,true);assert.deepEqual(policy.criticalFields,[]);
    assert.deepEqual(policy.changedFields,['entryIocBufferBps']);
  }
  for(const value of [-1,50.001,NaN,Infinity,'8',null])assert.throws(()=>validateConfig({...config,entryIocBufferBps:value}));
});

test('an old saved config keeps its exact policy hash and scoped maintenance proof after startup',()=>{
  const original=validateConfig({...config,mode:'live',autoEnabled:false});
  assert.equal(Object.hasOwn(original,'entryIocBufferBps'),false);
  const restarted=startupConfig({},original,'live');
  assert.equal(Object.hasOwn(restarted,'entryIocBufferBps'),false);
  assert.deepEqual(restarted,original);assert.equal(maintenanceHash(restarted),maintenanceHash(original));
  const venues:ExchangeId[]=['gate','bybit'],project='D:/entry-buffer-fixture';
  const ledger:SavedState={version:1,config:original,positions:[],orders:[],fundingSeen:[],logs:[],equity:[],killSwitch:false};
  const proof:MaintenanceHandoff={version:1,at:now,sourcePid:99,project,credentialsHash:'fixture-file-hash',
    ledgerHash:maintenanceLedgerHash(ledger),configHash:maintenanceHash(original),venues,positionIds:[]};
  assert.doesNotThrow(()=>validateMaintenanceHandoff(proof,ledger,restarted,project,'fixture-file-hash',venues,now));
  assert.throws(()=>validateMaintenanceHandoff(proof,ledger,{...restarted,entryIocBufferBps:8},project,'fixture-file-hash',venues,now));
});
