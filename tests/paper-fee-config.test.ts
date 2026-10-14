import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, validateConfig } from './legacy-config.js';

test('fee-only experiment remains opt-in and accepts a 100 USD paper configuration',()=>{
  assert.equal(defaultConfig.paperFeeOnly,false);
  const config=validateConfig({...defaultConfig,paperFeeOnly:true,orderNotionalUsd:100});
  assert.equal(config.mode,'paper');assert.equal(config.paperFeeOnly,false);assert.equal(config.feeOnly,true);assert.equal(config.orderNotionalUsd,100);
});

test('the paper fee-only switch is ignored and live still runs the single entry rule',()=>{
  const config=validateConfig({...defaultConfig,mode:'live',dataSource:'public',paperFeeOnly:true});
  assert.equal(config.paperFeeOnly,false);assert.equal(config.feeOnly,true);
});
