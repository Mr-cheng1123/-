import test from 'node:test';
import assert from 'node:assert/strict';
import {referenceTradingFee,REFERENCE_TRADING_FEE_VERIFIED_AT} from '../src/shared/reference-trading-fees.js';
import {nativeMakerFeeRate,nativeTakerFeeRate} from '../src/shared/trading-fees.js';
import type {ExchangeId,MarketSnapshot} from '../src/shared/types.js';

test('official standard USDT perpetual schedules preserve percentage-to-ratio conversion',()=>{
  for(const [exchange,maker,taker] of [['binance',.0002,.0005],['bybit',.0002,.00055],['gate',.0002,.0005],['bitget',.0002,.0006]] as const){
    const fee=referenceTradingFee(exchange,'BTC/USDT:USDT','standard');
    assert.equal(fee?.makerRate,maker);assert.equal(fee?.takerRate,taker);
    assert.equal(fee?.profile,'standard');assert.equal(fee?.source,'official-reference');
    assert.equal(fee?.verifiedAt,REFERENCE_TRADING_FEE_VERIFIED_AT);
    assert.ok(fee?.sourceUrl.startsWith('https://'));assert.ok(fee!.caveats.length>=3);
  }
});

test('Bybit unclassified contracts do not silently inherit the lower ordinary fee',()=>{
  const ordinary=referenceTradingFee('bybit','BTC/USDT:USDT','standard')!;
  const unknown=referenceTradingFee('bybit','DGAI/USDT:USDT')!;
  const innovation=referenceTradingFee('bybit','DGAI/USDT:USDT','innovation')!;
  const preMarket=referenceTradingFee('bybit','SOON/USDT:USDT','pre-market')!;
  assert.equal(ordinary.takerRate,.00055);
  assert.equal(unknown.profile,'unknown');assert.equal(unknown.takerRate,.0011);assert.equal(unknown.makerRate,.0004);
  assert.ok(unknown.caveats.some(value=>value.includes('不保证')));
  assert.equal(innovation.takerRate,.0011);assert.equal(innovation.makerRate,.0004);
  assert.equal(preMarket.takerRate,.001);assert.equal(preMarket.makerRate,.0004);
  assert.ok(preMarket.caveats.some(value=>value.includes('集合竞价')));
});

test('ordinary venue references retain unknown classification and disclose account exceptions',()=>{
  for(const exchange of ['binance','gate','bitget'] as const){
    const fee=referenceTradingFee(exchange,'BTC/USDT:USDT')!;
    assert.equal(fee.profile,'unknown');assert.ok(fee.caveats.some(value=>value.includes('特殊合约')));
    assert.equal(referenceTradingFee(exchange,'BTC/USDT:USDT','innovation'),undefined);
    assert.equal(referenceTradingFee(exchange,'BTC/USDT:USDT','pre-market'),undefined);
  }
  assert.ok(referenceTradingFee('gate','BTC/USDT:USDT')!.caveats.some(value=>value.includes('0.075%')));
});

test('non-USDT perpetual symbols, unreviewed OKX and invalid profiles never receive a reference',()=>{
  for(const symbol of ['BTC/USDT','BTC/USD:BTC','BTC/USDC:USDC','BTC/USDT:USDT-261225','BTCUSDT','BTC_USDT','/USDT:USDT','BTC /USDT:USDT'])
    assert.equal(referenceTradingFee('binance',symbol),undefined);
  assert.equal(referenceTradingFee('okx','BTC/USDT:USDT'),undefined);
  for(const exchange of ['other','__proto__','constructor'])
    assert.equal(referenceTradingFee(exchange as ExchangeId,'BTC/USDT:USDT'),undefined);
  assert.equal(referenceTradingFee('bybit','BTC/USDT:USDT','unexpected' as 'standard'),undefined);
});

test('reference metadata can neither satisfy nor refresh native account fee checks',()=>{
  const fee=referenceTradingFee('bybit','BTC/USDT:USDT')!;
  const snapshot={...fee,takerFeeRate:fee.takerRate,makerFeeRate:fee.makerRate,
    takerFeeAt:Date.now(),makerFeeAt:Date.now(),takerFeeSource:fee.source,makerFeeSource:fee.source} as unknown as MarketSnapshot;
  assert.equal(nativeTakerFeeRate(snapshot),undefined);assert.equal(nativeMakerFeeRate(snapshot),undefined);
  assert.equal('takerFeeRate' in fee,false);assert.equal('takerFeeAt' in fee,false);assert.equal('takerFeeSource' in fee,false);
  assert.equal('makerFeeRate' in fee,false);assert.equal('makerFeeAt' in fee,false);assert.equal('makerFeeSource' in fee,false);
  assert.ok(Object.isFrozen(fee));assert.ok(Object.isFrozen(fee.caveats));
  const again=referenceTradingFee('bybit','BTC/USDT:USDT')!;
  assert.equal(again.verifiedAt,fee.verifiedAt,'reading the local schedule never fabricates a fresh account observation');
});
