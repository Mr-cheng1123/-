import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfig,validateConfig} from '../src/shared/config.js';
import {configUpdatePolicy} from '../src/shared/config-update-policy.js';

test('submitting the entire settings form considers only values that actually changed',()=>{
  const current=validateConfig({...defaultConfig,feeOnly:true});
  const next=validateConfig({...JSON.parse(JSON.stringify(current)),minSpreadNetUsd:.03,orderNotionalUsd:100});
  const policy=configUpdatePolicy(current,next);
  assert.equal(policy.entryOnly,true);assert.deepEqual(policy.criticalFields,[]);
  assert.deepEqual(new Set(policy.changedFields),new Set(['orderNotionalUsd']));
});

test('new-entry switches and profitability thresholds do not change existing position management',()=>{
  for(const change of [{entryPolicy:'aligned' as const},{entryPolicy:'funding' as const},{dualAdvantageEnabled:false},{holdMode:'adaptive'},{fundingStatsSource:'exchanges'},{entryWindowSec:1200},
    {minCombinedNetUsd:.1},{minSpreadAdvantageBps:3},{minNetProfitUsd:1},{maxSettlementSkewSec:30},{minEntryIocEdgeBps:25}]){
    const next=validateConfig({...defaultConfig,...change});assert.equal(configUpdatePolicy(defaultConfig,next).entryOnly,true);
  }
});

test('exit economic thresholds can change with positions without rebuilding authenticated clients',()=>{
  const current=validateConfig({...defaultConfig});
  const next=validateConfig({...current,exitWeakFundingBps:3,minExitProfitUsd:.20,minExitProfitBps:20});
  const policy=configUpdatePolicy(current,next);
  assert.deepEqual(new Set(policy.changedFields),new Set(['exitWeakFundingBps','minExitProfitUsd','minExitProfitBps']));
  assert.deepEqual(policy.criticalFields,[]);assert.equal(policy.entryOnly,true);
  assert.throws(()=>validateConfig({...current,exitWeakFundingBps:-1}));
  assert.throws(()=>validateConfig({...current,minExitProfitUsd:NaN}));
  for(const minExitProfitBps of [-1,NaN,Infinity,10001])assert.throws(()=>validateConfig({...current,minExitProfitBps}));
});

test('optional aligned bps remains absent in legacy configs and can change holding economics without replacing clients',()=>{
  const old={...defaultConfig};delete old.minExitProfitBps;const current=validateConfig(old);
  assert.equal(Object.hasOwn(current,'minExitProfitBps'),false);
  const next=validateConfig({...current,minExitProfitBps:10}),policy=configUpdatePolicy(current,next);
  assert.deepEqual(policy.changedFields,['minExitProfitBps']);assert.deepEqual(policy.criticalFields,[]);assert.equal(policy.entryOnly,true);
  assert.equal(validateConfig({...current,minExitProfitBps:0}).minExitProfitBps,0);
});

test('management or client changes remain critical even when combined with an entry threshold',()=>{
  for(const change of [{leverage:3},{takerFees:{...defaultConfig.takerFees,gate:.0006}},
    {marginMode:'isolated'},
    {adaptiveConfirmations:4},{maxSnapshotAgeMs:20000},
    {bitgetNewSymbolMarginMode:'crossed'},{exchanges:['gate','bitget']},{dataSource:'demo'}]){
    const next=validateConfig({...defaultConfig,...change,minSpreadNetUsd:.01});
    const policy=configUpdatePolicy(defaultConfig,next);assert.equal(policy.entryOnly,false);assert.equal(policy.criticalFields.length,1);
  }
});

test('amount-only saves preserve absent legacy margin; explicit margin selection rebuilds preparation clients',()=>{
  const legacy={...defaultConfig};delete legacy.marginMode;
  const current=validateConfig(legacy),amount=validateConfig({...current,orderNotionalUsd:100});
  assert.equal(Object.hasOwn(current,'marginMode'),false);assert.equal(Object.hasOwn(amount,'marginMode'),false);
  assert.equal(configUpdatePolicy(current,amount).entryOnly,true);
  const explicit=validateConfig({...current,marginMode:'crossed'});
  assert.deepEqual(configUpdatePolicy(current,explicit).criticalFields,['marginMode']);
  assert.throws(()=>validateConfig({...current,marginMode:'cross'}));
  assert.throws(()=>validateConfig({...current,orderNotionalUsd:0}));
  assert.throws(()=>validateConfig({...current,leverage:21}));
});

test('retired risk fields cannot lock settings or change the strategy, even in malformed old files',()=>{
  const current=validateConfig({...defaultConfig});
  const next=validateConfig({...current,maxLeverage:0,maxSlippageBps:'retired',maxDeltaUsd:null,
    fundingSafetyFactor:-1,transferCostUsd:'unused',minSpreadNetUsd:9999,maxTotalPositionUsd:0});
  assert.deepEqual(configUpdatePolicy(current,next),{changedFields:[],criticalFields:[],entryOnly:true});
  assert.equal(configUpdatePolicy(current,validateConfig({...current,maxHoldHours:12})).entryOnly,true);
});

test('unchanged arrays and fee objects do not force rebuilding exchange clients',()=>{
  const next=validateConfig(JSON.parse(JSON.stringify(defaultConfig)));
  assert.deepEqual(configUpdatePolicy(defaultConfig,next),{changedFields:[],criticalFields:[],entryOnly:true});
});

test('local rebate percentages change holding economics without rebuilding authenticated clients',()=>{
  const current=validateConfig({...defaultConfig}),next=validateConfig({...current,feeRebatePct:{gate:70,bitget:50}});
  const policy=configUpdatePolicy(current,next);
  assert.deepEqual(policy.changedFields,['feeRebatePct']);assert.deepEqual(policy.criticalFields,[]);assert.equal(policy.entryOnly,true);
  assert.equal(Object.hasOwn(current,'feeRebatePct'),false);
});

test('warmup profile changes remain an entry setting and never require rebuilding account clients',()=>{
  const next=validateConfig({...defaultConfig,spreadMinSamples:12,spreadMinSpanSec:120});
  const policy=configUpdatePolicy(defaultConfig,next);
  assert.equal(next.spreadWarmupProfile,'custom');assert.equal(policy.entryOnly,true);assert.deepEqual(policy.criticalFields,[]);
  assert.deepEqual(new Set(policy.changedFields),new Set(['spreadMinSamples','spreadMinSpanSec','spreadWarmupProfile']));
});

test('optional execution mode keeps old saved configs unchanged and only affects new aligned entries',()=>{
  const current=validateConfig({...defaultConfig,entryPolicy:'aligned'});
  assert.equal(Object.hasOwn(current,'entryExecutionMode'),false);
  const next=validateConfig({...current,entryExecutionMode:'maker-ioc'});
  assert.equal(configUpdatePolicy(current,next).entryOnly,true);
  assert.deepEqual(configUpdatePolicy(current,next).criticalFields,[]);
  assert.throws(()=>validateConfig({...defaultConfig,entryPolicy:'funding',entryExecutionMode:'maker-ioc'}),/Maker/);
});
