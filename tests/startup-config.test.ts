import test from 'node:test';
import assert from 'node:assert/strict';
import {startupConfig} from '../src/shared/startup-config.js';
import {defaultConfig,validateConfig} from '../src/shared/config.js';
import {isLegacySpreadWarmupProfile} from '../src/shared/spread-warmup-profile.js';
import type {AppConfig} from '../src/shared/types.js';
import {MAX_BEST_PRICE_ENTRY_BATCHES} from '../src/core/entry-batch.js';

test('10 bps runtime default preserves the exact legacy maintenance policy and explicit thresholds survive restart',()=>{
  const legacy=validateConfig({...defaultConfig,entryPolicy:'aligned',mode:'live',autoEnabled:false});
  delete legacy.minExitProfitBps;
  const restarted=startupConfig({},legacy,'live');
  assert.deepEqual(restarted,legacy,'an absent new field must not invalidate the existing maintenance config hash');
  assert.equal(restarted.minExitProfitBps??10,10);
  assert.equal(startupConfig({}, {},'live').minExitProfitBps,10);
  assert.equal(startupConfig({minExitProfitBps:15},{...legacy,minExitProfitBps:20},'live').minExitProfitBps,20);
  assert.equal(startupConfig({minExitProfitBps:15},legacy,'live').minExitProfitBps,15);
});

test('best-price batch runtime default preserves an old saved policy and explicit settings survive restart',()=>{
  const original=validateConfig({...defaultConfig,entryPolicy:'aligned',mode:'live',autoEnabled:false});
  delete original.maxEntryBatches;
  const restarted=startupConfig({},original,'live');
  assert.deepEqual(restarted,original,'adding a runtime default cannot invalidate a scoped maintenance config hash');
  assert.equal(restarted.maxEntryBatches??MAX_BEST_PRICE_ENTRY_BATCHES,8);
  assert.equal(startupConfig({maxEntryBatches:4},{...original,maxEntryBatches:2},'live').maxEntryBatches,2);
});

test('runtime defaults to aligned advantages while an explicitly chosen policy survives restart',()=>{
  assert.equal(startupConfig({}, {}, 'live').entryPolicy,'aligned');
  assert.equal(startupConfig({entryPolicy:'dual'}, {}, 'live').entryPolicy,'dual');
  assert.equal(startupConfig({entryPolicy:'dual'}, {entryPolicy:'funding'}, 'live').entryPolicy,'funding');
  assert.equal(startupConfig({}, {entryPolicy:'dual'}, 'live').entryPolicy,'dual');
  assert.equal(startupConfig({}, {entryPolicy:'funding'}, 'live').entryPolicy,'funding');
  assert.equal(startupConfig({entryPolicy:'funding'}, {entryPolicy:'aligned'}, 'live').entryPolicy,'aligned');
});

test('new installations default cross margin, while legacy saved accounts retain their exact absent setting',()=>{
  assert.equal(defaultConfig.marginMode,'crossed');assert.equal(startupConfig({}, {}, 'live').marginMode,'crossed');
  const legacy=validateConfig({...defaultConfig,mode:'live',entryPolicy:'aligned'});delete legacy.marginMode;
  assert.deepEqual(startupConfig({},legacy,'live'),legacy);
  assert.equal(Object.hasOwn(startupConfig({orderNotionalUsd:100},{},'live'),'marginMode'),false);
  assert.equal(startupConfig({marginMode:'crossed'},{marginMode:'isolated'},'live').marginMode,'isolated');
});

test('ordinary entry defaults to any positive IOC advantage while explicit thresholds survive restart',()=>{
  assert.equal(defaultConfig.minEntryIocEdgeBps,0);
  assert.equal(startupConfig({}, {}, 'live').minEntryIocEdgeBps,0);
  const missing={...defaultConfig} as Partial<AppConfig>;delete missing.minEntryIocEdgeBps;
  assert.equal(validateConfig(missing).minEntryIocEdgeBps,0);
  assert.equal(startupConfig({minEntryIocEdgeBps:20},{minEntryIocEdgeBps:0},'live').minEntryIocEdgeBps,0);
  assert.equal(startupConfig({}, {minEntryIocEdgeBps:20}, 'live').minEntryIocEdgeBps,20);
});

test('saved UI thresholds and per-exchange fees survive a restart with older config.json',()=>{
  const config=startupConfig({...defaultConfig,minCombinedNetUsd:.5},
    {minCombinedNetUsd:.2,orderNotionalUsd:100,takerFees:{...defaultConfig.takerFees,bitget:.0004}},'live');
  assert.equal(config.minCombinedNetUsd,.2);assert.equal(config.orderNotionalUsd,100);
  assert.equal(config.takerFees.bitget,.0004);assert.equal(config.takerFees.gate,defaultConfig.takerFees.gate);
});
test('explicit runtime mode/source override saved settings and auto entries always restart off',()=>{
  const live=startupConfig({...defaultConfig,dataSource:'demo',autoEnabled:true},{autoEnabled:true},'live','demo');
  assert.equal(live.mode,'live');assert.equal(live.dataSource,'public');assert.equal(live.autoEnabled,false);
  const paper=startupConfig(defaultConfig,{dataSource:'public',autoEnabled:true},'paper','demo');
  assert.equal(paper.dataSource,'demo');assert.equal(paper.autoEnabled,false);
});

test('the complete unversioned old observation defaults migrate once without changing other saved settings',()=>{
  const legacy:Partial<AppConfig>={spreadLookbackMinutes:30,spreadMinSamples:12,spreadMinSpanSec:120,spreadSampleIntervalSec:15,
    orderNotionalUsd:100,minCombinedNetUsd:.12,autoEnabled:true};
  assert.equal(isLegacySpreadWarmupProfile(legacy),true);
  const config=startupConfig({},legacy,'live');
  assert.equal(config.spreadMinSamples,6);assert.equal(config.spreadMinSpanSec,60);
  assert.equal(config.spreadWarmupProfile,'responsive-v1');
  assert.equal(config.orderNotionalUsd,100);assert.equal(config.minCombinedNetUsd,.12);assert.equal(config.autoEnabled,false);
  assert.deepEqual(startupConfig({},config,'live'),config);
});

test('custom observations, including an explicit 12/120 profile, survive startup and schema validation',()=>{
  for(const override of [{spreadMinSamples:9},{spreadMinSpanSec:180},{spreadSampleIntervalSec:20},{spreadLookbackMinutes:45},
    {spreadMinSamples:12,spreadMinSpanSec:120,spreadWarmupProfile:'custom' as const}]){
    const legacy:Partial<AppConfig>={spreadLookbackMinutes:30,spreadMinSamples:12,spreadMinSpanSec:120,spreadSampleIntervalSec:15,...override};
    assert.equal(isLegacySpreadWarmupProfile(legacy),false);
    const config=startupConfig({},legacy,'live');
    assert.equal(config.spreadMinSamples,legacy.spreadMinSamples);
    assert.equal(config.spreadMinSpanSec,legacy.spreadMinSpanSec);
    assert.equal(config.spreadLookbackMinutes,legacy.spreadLookbackMinutes);
    assert.equal(config.spreadSampleIntervalSec,legacy.spreadSampleIntervalSec);
    assert.equal(config.spreadWarmupProfile,'custom');
  }
});

test('editing the warmup defaults protects the new custom values from future default migrations',()=>{
  const edited=validateConfig({...defaultConfig,spreadMinSamples:12,spreadMinSpanSec:120});
  assert.equal(edited.spreadWarmupProfile,'custom');
  const next=startupConfig({},edited,'live');
  assert.equal(next.spreadMinSamples,12);assert.equal(next.spreadMinSpanSec,120);assert.equal(next.spreadWarmupProfile,'custom');
});

test('absent schema values and a partial old setting do not restore the obsolete default pair',()=>{
  const missing={...defaultConfig} as Partial<AppConfig>;
  delete missing.spreadMinSamples;delete missing.spreadMinSpanSec;
  const parsed=validateConfig(missing);
  assert.equal(parsed.spreadMinSamples,6);assert.equal(parsed.spreadMinSpanSec,60);
  const partial=startupConfig({},{spreadMinSamples:12},'live');
  assert.equal(partial.spreadMinSamples,12);assert.equal(partial.spreadMinSpanSec,60);assert.equal(partial.spreadWarmupProfile,'custom');
});
