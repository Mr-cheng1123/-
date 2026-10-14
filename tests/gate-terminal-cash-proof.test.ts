import test from 'node:test';
import assert from 'node:assert/strict';
import {GatePrivate} from '../src/adapters/gate-private.js';
import {CcxtAdapter} from '../src/adapters/ccxt.js';
import {exchangeClientId,unknownOrder} from '../src/adapters/normalization.js';
import {defaultConfig} from '../src/shared/config.js';
import {isTerminalOrderReceipt} from '../src/shared/order-receipt-validity.js';
import type {OrderRequest} from '../src/shared/types.js';

const request:OrderRequest={clientOrderId:'offline-gate-terminal-cash',base:'CT',symbol:'CT/USDT:USDT',
  side:'buy',quantity:10,limitPrice:11,reduceOnly:false};
const nativeId='73001001';
function fixture(reduceOnly=false){
  const req={...request,reduceOnly},events:string[]=[],market={id:'CT_USDT',symbol:req.symbol,base:'CT',quote:'USDT',settle:'USDT',
    active:true,swap:true,linear:true,contractSize:1,precision:{amount:1,price:.01},limits:{amount:{min:1},cost:{min:1}}},
    raw:any={id:nativeId,contract:market.id,size:'10',left:'0',price:'11',fill_price:'10.01',tif:'ioc',
      text:exchangeClientId('gate',req.clientOrderId),is_reduce_only:reduceOnly,is_close:false,pos_margin_mode:'cross',
      status:'finished',finish_time_ms:String(Date.now())},
    trades:any[]=[{id:'501',order_id:nativeId,contract:market.id,size:'4',price:'10',fee:'.02',point_fee:'0',fee_currency:'USDT',close_size:reduceOnly?'4':'0'},
      {id:'502',order_id:nativeId,contract:market.id,size:'6',price:'10.01',fee:'.03',point_fee:'0',fee_currency:'USDT',close_size:reduceOnly?'6':'0'}];
  const client:any={apiKey:'offline-key',secret:'offline-secret',precisionMode:4,markets:{[market.symbol]:market},
    market:()=>market,loadMarkets:async()=>({[market.symbol]:market}),
    amountToPrecision:(_symbol:string,q:number)=>String(q),priceToPrecision:(_symbol:string,p:number)=>String(p),
    privateFuturesGetSettleOrdersOrderId:async(params:any)=>{assert.equal(params.order_id,nativeId);events.push('order-get');return {...raw};},
    privateFuturesGetSettleMyTrades:async(params:any)=>{assert.equal(params.order,nativeId);events.push('trade-get');return trades;},
    privateFuturesPostSettleOrders:async()=>{events.push('MUTATION');throw new Error('No creates allowed');},
    privateFuturesDeleteSettleOrdersOrderId:async()=>{events.push('MUTATION');throw new Error('No cancels allowed');},
  };
  return {req,client,raw,trades,events,native:new GatePrivate(client),
    adapter:new CcxtAdapter('gate',{...defaultConfig,mode:'live',dataSource:'public'},client)};
}

for(const reduceOnly of [false,true]){
  test(`Gate terminal ${reduceOnly?'reduction':'opening'} inspection marks only the complete original weighted trade cash verified`,async t=>{
    const f=fixture(reduceOnly);t.after(()=>f.adapter.close());const readAt=Date.now(),result=await f.adapter.inspectOrder(f.req,nativeId);
    const expected=(4*10+6*10.01)/10;
    assert.equal(result.id,nativeId);assert.equal(result.clientOrderId,f.req.clientOrderId);assert.equal(result.status,'filled');
    assert.equal(result.filledQuantity,10);assert.equal(result.averagePrice,expected);assert.notEqual(result.averagePrice,Number(f.raw.fill_price));
    assert.equal(result.feeUsd,.05);assert.equal(result.averagePriceVerified,true);assert.equal(isTerminalOrderReceipt(f.req,result),true);
    assert.ok(result.orderReadAt!>=readAt);assert.deepEqual(f.events,['order-get','trade-get']);
  });
}

test('Gate terminal partial inspection proves only the actually filled cash and never cancels the remaining request',async t=>{
  const f=fixture(true);t.after(()=>f.adapter.close());f.raw.left='6';f.trades.splice(1);
  const result=await f.native.inspectOrder(f.req,unknownOrder(f.req,nativeId),nativeId);
  assert.equal(result.status,'partial');assert.equal(result.filledQuantity,4);assert.equal(result.averagePrice,10);
  assert.equal(result.feeUsd,.02);assert.equal(result.averagePriceVerified,true);assert.deepEqual(f.events,['order-get','trade-get']);
});

test('Gate active native order cannot acquire terminal weighted cash confirmation or successful read time',async t=>{
  const f=fixture();t.after(()=>f.adapter.close());f.raw.status='open';f.raw.left='6';
  const result=await f.adapter.inspectOrder(f.req,nativeId);
  assert.equal(result.status,'unknown');assert.equal(result.filledQuantity,4);assert.notEqual(result.averagePriceVerified,true);
  assert.equal(result.orderReadAt,undefined);assert.deepEqual(f.events,['order-get']);
});

for(const failure of ['incomplete','wrong-original-id','wrong-action','unknown-fee','point-fee','non-usdt','price-outside-limit'] as const){
  test(`Gate ${failure} trade evidence cannot mark an ordinary terminal receipt verified`,async t=>{
    const f=fixture();t.after(()=>f.adapter.close());
    if(failure==='incomplete')f.trades.splice(1);
    else if(failure==='wrong-original-id')f.trades[1].order_id='foreign';
    else if(failure==='wrong-action')f.trades[1].close_size='6';
    else if(failure==='unknown-fee')f.trades[1].fee=undefined;
    else if(failure==='point-fee')f.trades[1].point_fee='.01';
    else if(failure==='non-usdt')f.trades[1].fee_currency='BTC';
    else f.trades[1].price='12';
    const result=await f.adapter.inspectOrder(f.req,nativeId);
    assert.equal(result.status,'unknown');assert.equal(result.filledQuantity,10);assert.notEqual(result.averagePriceVerified,true);
    assert.equal(result.orderReadAt,undefined);assert.ok(!f.events.includes('MUTATION'));
  });
}

test('Gate valid zero terminal inspection uses no trade GET and does not fabricate a positive execution price proof',async t=>{
  const f=fixture();t.after(()=>f.adapter.close());f.raw.left='10';f.raw.fill_price='0';
  const result=await f.adapter.inspectOrder(f.req,nativeId);
  assert.equal(result.status,'cancelled');assert.equal(result.filledQuantity,0);assert.equal(result.averagePrice,0);assert.equal(result.feeUsd,0);
  assert.notEqual(result.averagePriceVerified,true);assert.ok(Number.isFinite(result.orderReadAt));assert.deepEqual(f.events,['order-get']);
});

test('Gate reconciliation preserves its existing receipt while the dedicated read-only inspection alone supplies the new flag',async t=>{
  const f=fixture();t.after(()=>f.adapter.close());const result=await f.native.reconcile(f.req,unknownOrder(f.req,nativeId),nativeId);
  assert.equal(result.status,'filled');assert.equal(result.averagePrice,(4*10+6*10.01)/10);assert.equal(result.feeUsd,.05);
  assert.notEqual(result.averagePriceVerified,true);assert.deepEqual(f.events,['order-get','trade-get']);
});
