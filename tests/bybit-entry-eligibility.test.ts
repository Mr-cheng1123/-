import test from 'node:test';
import assert from 'node:assert/strict';
import {assertBybitEntryEligibility} from '../src/adapters/bybit-entry-eligibility.js';
import {OrderNotSubmittedError,rejectedOrder} from '../src/adapters/order-rejection.js';
import type {OrderRequest} from '../src/shared/types.js';

const request:OrderRequest={clientOrderId:'opening-test',base:'LAOPU',symbol:'LAOPU/USDT:USDT',side:'buy',
  quantity:.6,limitPrice:41.84,reduceOnly:false};
const market=(info:Record<string,unknown>)=>({id:'LAOPUUSDT',symbol:request.symbol,active:true,swap:true,linear:true,info});
const additional=(info:Record<string,unknown>)=>assert.throws(()=>assertBybitEntryEligibility(market(info),request),
  (error:unknown)=>error instanceof OrderNotSubmittedError&&error.rejectionCode==='UNVERIFIED_PRODUCT_ACCESS'&&
    error.rejectionReason.includes('本次未发送开仓订单'));

for(const symbolType of ['stock','ETF','commodity','forex']){
  test(`additional ${symbolType} product is blocked even with Trading and unified margin support`,()=>{
    additional({symbolType,status:'Trading',unifiedMarginTrade:true});
  });
}

test('instrument symbol and tokenized-gold names are not a product whitelist or blacklist',()=>{
  additional({symbolType:'stock',marketRegion:'HK',underlyingTicker:'6181HK'});
  assert.throws(()=>assertBybitEntryEligibility({id:'BTCUSDT',info:{symbolType:'stock'}},request),OrderNotSubmittedError);
  for(const id of ['LAOPUUSDT','XAUTUSDT','PAXGUSDT','BTCUSDT'])
    assert.doesNotThrow(()=>assertBybitEntryEligibility({id,info:{symbolType:'',marketRegion:'',underlyingTicker:''}},request));
});

test('unknown or contradictory TradFi markers cannot be treated as an ordinary crypto instrument',()=>{
  for(const info of [
    {symbolType:'future-stock-category'},
    {symbolType:'Stock'},
    {marketRegion:'HK'},
    {underlyingTicker:'6181HK'},
    {symbolType:'innovation',marketRegion:'US'},
    {symbolType:'',underlyingTicker:'SPY'},
    {marketRegion:0},
    {underlyingTicker:{}},
    {symbolType:false}
  ])additional(info);
});

test('ordinary crypto and innovation metadata perform no network reads or mutation',()=>{
  let requests=0;
  for(const info of [{},{symbolType:''},{symbolType:'innovation'},{symbolType:'',marketRegion:'',underlyingTicker:''}]){
    const before=structuredClone(info);
    const candidate={info,privateGetV5AccountInstrumentsInfo:()=>{requests++;throw new Error('Unexpected private GET');},
      privatePostV5UserAgreement:()=>{requests++;throw new Error('Unexpected agreement POST');}};
    assert.doesNotThrow(()=>assertBybitEntryEligibility(candidate,request));
    assert.deepEqual(info,before);
  }
  assert.equal(requests,0);
});

test('reduce-only requests skip additional eligibility before reading any metadata',()=>{
  const candidate={get info():never{throw new Error('Reduction must not read product access');}};
  assert.doesNotThrow(()=>assertBybitEntryEligibility(candidate,{reduceOnly:true}));
  for(const symbolType of ['stock','ETF','commodity','forex','unknown-product'])
    assert.doesNotThrow(()=>assertBybitEntryEligibility(market({symbolType}),{reduceOnly:true}));
});

test('preflight failure yields a known zero-submission receipt rather than an unknown create result',()=>{
  let error:OrderNotSubmittedError|undefined;
  try{assertBybitEntryEligibility(market({symbolType:'stock'}),request);}catch(caught){
    assert(caught instanceof OrderNotSubmittedError);error=caught;
  }
  assert(error);
  const receipt=rejectedOrder(request,error);
  assert.equal(receipt.status,'cancelled');assert.equal(receipt.id,'');assert.equal(receipt.filledQuantity,0);
  assert.equal(receipt.clientOrderId,request.clientOrderId);assert.equal(receipt.rejectionCode,'UNVERIFIED_PRODUCT_ACCESS');
});
