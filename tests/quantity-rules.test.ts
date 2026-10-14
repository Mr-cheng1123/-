import test from 'node:test';
import assert from 'node:assert/strict';
import ccxt from 'ccxt';
import { amountStep } from '../src/adapters/normalization.js';
import { calculateOpportunities, commonStep } from '../src/core/strategy.js';
import { defaultConfig } from './legacy-config.js';
import type { ExchangeId, MarketSnapshot } from '../src/shared/types.js';

const now=Date.UTC(2026,8,30,12);
// Public 2026-09-30 metadata; synthetic prices/funding below isolate quantity conversion.
function market(exchange:'gate'|'bybit',base:'GTLB'|'ARK'){
  const contractSize=exchange==='gate'&&base==='GTLB'?.1:1;
  return {id:exchange==='gate'?`${base}_USDT`:`${base}USDT`,symbol:`${base}/USDT:USDT`,base,quote:'USDT',settle:'USDT',
    type:'swap',active:true,spot:false,swap:true,future:false,option:false,contract:true,linear:true,inverse:false,
    contractSize,precision:{amount:exchange==='bybit'&&base==='GTLB'?.01:1,price:base==='GTLB'?.01:.00001},
    limits:{amount:{min:exchange==='bybit'&&base==='GTLB'?.01:1},cost:{min:exchange==='bybit'?5:0},price:{}},info:{}};
}
function snapshot(exchange:ExchangeId,m:ReturnType<typeof market>,step:number,price:number):MarketSnapshot{
  return {exchange,base:m.base,symbol:m.symbol,timestamp:now,markPrice:price,indexPrice:price,
    fundingRate:exchange==='bybit'?.01:0,intervalHours:8,nextFundingTime:now+60000,fundingHistory:[],
    bids:[{price,quantity:100000}],asks:[{price,quantity:100000}],openInterestUsd:1e8,volume24hUsd:1e8,
    quantityStep:step,minQuantity:m.limits.amount.min*m.contractSize,minNotional:m.limits.cost.min,contractSize:m.contractSize,source:'public'};
}

for(const [base,price,expected] of [['GTLB',46.768,2.1],['ARK',.315,317]] as const){
  test(`${base} Gate contracts and Bybit coins preserve the same valid hedge quantity through actual CCXT precision`,()=>{
    const gate=new ccxt.gate(),bybit=new ccxt.bybit();
    const gm=market('gate',base),bm=market('bybit',base);
    gate.setMarkets([gm as any]);bybit.setMarkets([bm as any]);
    const gateStep=amountStep(gm,gate.precisionMode!),bybitStep=amountStep(bm,bybit.precisionMode!);
    assert.equal(commonStep(gateStep,bybitStep),base==='GTLB'?.1:1);
    const [opportunity]=calculateOpportunities([snapshot('gate',gm,gateStep,price),snapshot('bybit',bm,bybitStep,price)],
      {...defaultConfig,feeOnly:true,hedgeMode:'base',orderNotionalUsd:100},now);
    assert.equal(opportunity.longQuantity,expected);assert.equal(opportunity.shortQuantity,expected);
    assert.equal(Number(gate.amountToPrecision(gm.symbol,opportunity.longQuantity/gm.contractSize))*gm.contractSize,expected);
    assert.equal(Number(bybit.amountToPrecision(bm.symbol,opportunity.shortQuantity/bm.contractSize))*bm.contractSize,expected);
    assert.equal(opportunity.deltaUsd,0);
    if(base==='GTLB')assert.equal(gate.amountToPrecision(gm.symbol,opportunity.longQuantity/gm.contractSize),'21');
  });
}

test('GTLB quantity precheck rejects a positive forecast when one leg cannot meet its minimum notional',()=>{
  const gm=market('gate','GTLB'),bm=market('bybit','GTLB');
  const [opportunity]=calculateOpportunities([snapshot('gate',gm,.1,46.768),snapshot('bybit',bm,.01,46.768)],
    {...defaultConfig,feeOnly:true,hedgeMode:'base',orderNotionalUsd:4.9},now);
  assert.equal(opportunity.longQuantity,.1);assert.equal(opportunity.shortQuantity,.1);
  assert.equal(opportunity.eligible,false);assert(opportunity.reasons.includes('低于交易所最小下单量'));
});
