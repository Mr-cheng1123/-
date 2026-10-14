import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectLiveEnvironment, liveEligibleExchanges } from '../src/core/live-readiness.js';

test('live readiness requires exact permission flags and complete venue credentials without exposing values',()=>{
  const env={ALLOW_LIVE_TRADING:'true',LIVE_TRADING_ACK:'I_UNDERSTAND_THE_RISKS',BINANCE_API_KEY:'private-key-a',BINANCE_API_SECRET:'private-secret-a',OKX_API_KEY:'private-key-b',OKX_API_SECRET:'private-secret-b'};
  const missingPassphrase=inspectLiveEnvironment(env);
  assert.equal(missingPassphrase.permissionGranted,true);assert.equal(liveEligibleExchanges(missingPassphrase,['binance','okx']).length,1);
  const complete=inspectLiveEnvironment({...env,OKX_PASSPHRASE:'private-passphrase'});
  assert.equal(liveEligibleExchanges(complete,['binance','okx']).length,2);
  assert.equal(liveEligibleExchanges(complete,['binance','bybit']).length,1);
  assert.equal(inspectLiveEnvironment({...env,ALLOW_LIVE_TRADING:'TRUE'}).permissionGranted,false);
  assert.equal(inspectLiveEnvironment({...env,LIVE_TRADING_ACK:''}).permissionGranted,false);
  assert.ok(!JSON.stringify(complete).includes('private-'));
});

test('Bitget supports classic accounts but still needs complete credentials and a second venue',()=>{
  const status=inspectLiveEnvironment({BINANCE_API_KEY:'key',BINANCE_API_SECRET:' ',BITGET_API_KEY:'key',BITGET_API_SECRET:'secret',BITGET_PASSPHRASE:'passphrase'});
  assert.equal(status.exchanges.find(x=>x.exchange==='binance')?.credentialsConfigured,false);
  assert.deepEqual(status.exchanges.find(x=>x.exchange==='bitget'),{exchange:'bitget',supported:true,credentialsConfigured:true});
  assert.equal(liveEligibleExchanges(status,['binance','bitget']).length,1);
  assert.equal(inspectLiveEnvironment({BITGET_API_KEY:'key',BITGET_API_SECRET:'secret'}).exchanges.find(x=>x.exchange==='bitget')?.credentialsConfigured,false);
});
