import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, validateConfig } from './legacy-config.js';

test('existing configuration without Bitget new-symbol margin choice remains isolated',()=>{
  const {bitgetNewSymbolMarginMode,...legacy}=defaultConfig;
  assert.equal(bitgetNewSymbolMarginMode,'isolated');
  assert.equal(validateConfig(legacy).bitgetNewSymbolMarginMode,'isolated');
});

test('an explicit Bitget new-symbol margin choice survives live configuration validation',()=>{
  for(const bitgetNewSymbolMarginMode of ['crossed','isolated'] as const){
    const config=validateConfig({...defaultConfig,mode:'live',bitgetNewSymbolMarginMode});
    assert.equal(config.bitgetNewSymbolMarginMode,bitgetNewSymbolMarginMode);
  }
});

test('Bitget margin choice rejects preview-only cross spelling and unknown modes',()=>{
  for(const bitgetNewSymbolMarginMode of ['cross','auto','']){
    assert.throws(()=>validateConfig({...defaultConfig,bitgetNewSymbolMarginMode}));
  }
});
