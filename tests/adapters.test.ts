import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig, OrderRequest, OrderResult } from '../src/shared/types.js';
import { CcxtAdapter, createAdapters } from '../src/adapters/index.js';
import { amountStep, bitgetMarket, exchangeClientId, fundingClock, isEligibleMarket, normalizeBook } from '../src/adapters/normalization.js';
import { readFundingLedger } from '../src/adapters/funding-ledger.js';
import {quoteIsFresh} from '../src/core/market-validity.js';

const market = {id:'BTC_USDT',symbol:'BTC/USDT:USDT',base:'BTC',quote:'USDT',settle:'USDT',active:true,swap:true,linear:true,
  contractSize:0.001,precision:{amount:1,price:0.1},limits:{amount:{min:1},cost:{min:5}},info:{funding_interval:28800}};
const config = {mode:'live',dataSource:'public',maxLeverage:3,takerFees:{binance:0.0005,bybit:0.00055,okx:0.0005,gate:0.0005},
  exchanges:['binance','bybit','okx','gate'],initialBalanceUsd:10000,demoSettlementSec:120} as AppConfig;
const request:OrderRequest = {clientOrderId:'position-leg-order-1',base:'BTC',symbol:market.symbol,side:'buy',quantity:0.1,limitPrice:60000,reduceOnly:true};
function assertNotSubmitted(result:OrderResult){
  assert.equal(result.status,'cancelled');assert.equal(result.id,'');assert.equal(result.filledQuantity,0);assert.equal(result.feeUsd,0);
  assert.equal(result.rejectionCode,'PRE_SUBMISSION_CHECK_FAILED');
  assert.deepEqual(result.confirmation,{stage:'pre-submit',reason:'pre-submit-failed'});
}
function mock(overrides:Record<string,any> = {}) {
  return {apiKey:'test-only',secret:'test-only',password:'test-only',precisionMode:4,has:{fetchMyTrades:false},
    markets:{[market.symbol]:market},loadMarkets:async()=>({[market.symbol]:market}),market:()=>market,
    amountToPrecision:(_s:string,n:number)=>String(Math.floor(n)),priceToPrecision:(_s:string,n:number)=>String(Math.round(n*10)/10),
    ...overrides};
}

test('only active exact-base linear USDT perpetuals can pair',()=> {
  assert.ok(isEligibleMarket(market,'BTC'));
  assert.equal(isEligibleMarket({...market,base:'1000BTC'},'BTC'),false);
  assert.equal(isEligibleMarket({...market,linear:false}),false);
  assert.equal(isEligibleMarket({...market,active:undefined}),false);
  assert.equal(isEligibleMarket({...market,settle:'USDC'}),false);
});
test('contract book levels and lot steps normalize to base units',()=> {
  assert.deepEqual(normalizeBook([[60000,100],[59000,50]],0.001),[{price:60000,quantity:0.1},{price:59000,quantity:0.05}]);
  assert.equal(amountStep(market,4),0.001);
  assert.equal(amountStep({...market,contractSize:1,precision:{amount:3}},2),0.001);
});
test('OKX uses fundingTime for next settlement rather than following nextFundingTime',()=> {
  const now = 1770000000000, next=now+300000;
  const clock = fundingClock('okx',{info:{fundingTime:String(next),nextFundingTime:String(next+14400000)}},market,[],now);
  assert.deepEqual(clock,{nextFundingTime:next,intervalHours:4});
});
test('funding clock rejects stale/unknown interval and handles different periods',()=> {
  const now = 1770000000000;
  assert.throws(()=>fundingClock('binance',{fundingTimestamp:now-1,interval:'8h'},market,[],now));
  assert.throws(()=>fundingClock('binance',{fundingTimestamp:now+10000},market,[],now));
  assert.equal(fundingClock('bybit',{fundingTimestamp:now+10000},{info:{fundingInterval:60}},[],now).intervalHours,1);
  assert.equal(fundingClock('bybit',{fundingTimestamp:now+10000,interval:'8h',info:{fundingIntervalHour:'1'}},{info:{fundingInterval:480}},[],now).intervalHours,1);
});
test('Bitget current rate uses nextUpdate and actual variable settlement period',()=> {
  const now=1770000000000;
  assert.deepEqual(fundingClock('bitget',{info:{nextUpdate:String(now+300000),fundingRateInterval:'2'}},market,[],now),
    {nextFundingTime:now+300000,intervalHours:2});
});
test('Bitget USDT metadata preserves raw base identity, coin lot and price tick',()=> {
  const raw={symbol:'BTCUSDT',baseCoin:'BTC',quoteCoin:'USDT',supportMarginCoins:['USDT'],symbolType:'perpetual',
    symbolStatus:'normal',pricePlace:'1',priceEndStep:'1',volumePlace:'4',sizeMultiplier:'0.0001',minTradeNum:'0.0001',minTradeUSDT:'5'};
  const m=bitgetMarket(raw);
  assert.equal(m.symbol,'BTC/USDT:USDT');assert.equal(m.contractSize,1);
  assert.equal(m.precision.price,0.1);assert.equal(m.precision.amount,0.0001);assert.equal(m.limits.cost.min,5);
  assert.equal(bitgetMarket({...raw,symbolType:'delivery'}),null);
  assert.equal(bitgetMarket({...raw,quoteCoin:'USD'}),null);
  assert.equal(bitgetMarket({...raw,baseCoin:'1000PEPE'}).base,'1000PEPE');
});
test('venue client IDs are deterministic and conform to restrictive venue formats',()=> {
  assert.equal(exchangeClientId('gate','abc'),exchangeClientId('gate','abc'));
  assert.match(exchangeClientId('gate','arbitrary#$id'),/^t-[a-f0-9]{26}$/);
  assert.match(exchangeClientId('okx','arbitrary#$id'),/^[a-z0-9]{1,32}$/);
});
test('demo venues share the same settlement epoch and prohibit exchange execution',async()=> {
  const adapters=createAdapters({...config,mode:'paper',dataSource:'demo'});
  const snapshots=await Promise.all(adapters.map(a=>a.fetchSnapshots(['BTC'])));
  assert.equal(new Set(snapshots.map(s=>s[0].nextFundingTime)).size,1);
  assert.ok(snapshots.every(s=>s[0].source==='demo'));
  await assert.rejects(()=>adapters[0].placeOrder(request),/paper broker/);
});
test('Gate public snapshot normalizes OI, books, contract sizes and settlement',async()=> {
  const now=Date.now();
  const client=mock({
    fetchFundingRate:async()=>({fundingRate:0.001,fundingTimestamp:now+300000,interval:'8h',markPrice:60000,indexPrice:59995,info:{position_size:1000}}),
    fetchOrderBook:async()=>({timestamp:now,bids:[[59999,100]],asks:[[60001,150]]}),
    fetchTicker:async()=>({timestamp:now,quoteVolume:9000000}),
    fetchFundingRateHistory:async()=>[{timestamp:now-57600000,fundingRate:0.0008},{timestamp:now-28800000,fundingRate:0.0009}],
  });
  const [s]=await new CcxtAdapter('gate',config,client).fetchSnapshots(['BTC']);
  assert.equal(s.openInterestUsd,60000);assert.equal(s.bids[0].quantity,0.1);assert.equal(s.asks[0].quantity,0.15);
  assert.equal(s.quantityStep,0.001);assert.equal(s.minQuantity,0.001);assert.equal(s.volume24hUsd,9000000);
});

test('slow funding response cannot make an earlier order book appear freshly received',async t=>{
  const started=1770000000000;let clock=started,releaseFunding!:(value:any)=>void;
  t.mock.method(Date,'now',()=>clock);
  const funding=new Promise<any>(resolve=>{releaseFunding=resolve;});
  const client=mock({fetchFundingRate:()=>funding,
    fetchOrderBook:async()=>({timestamp:started,bids:[[59999,100]],asks:[[60001,150]]}),
    fetchTicker:async()=>({timestamp:started,quoteVolume:9000000})});
  const adapter=new CcxtAdapter('gate',{...config,feeOnly:true},client,true);
  try{
    const request=adapter.fetchSnapshots(['BTC']);
    await new Promise<void>(resolve=>setImmediate(resolve));
    clock+=5000;
    releaseFunding({fundingRate:.001,fundingTimestamp:started+300000,interval:'8h',markPrice:60000,indexPrice:59995,info:{position_size:1000}});
    const [snapshot]=await request;
    assert.equal(snapshot.observedAt,started);
    assert.equal(quoteIsFresh(snapshot,{maxSnapshotAgeMs:1000},clock),false);
  }finally{await adapter.close();}
});

test('a newly received static REST book stays fresh even if its last exchange event was old',async t=>{
  const observed=1770000000000,eventAt=observed-3600000;t.mock.method(Date,'now',()=>observed);
  const client=mock({
    fetchFundingRate:async()=>({fundingRate:.001,fundingTimestamp:observed+300000,interval:'8h',markPrice:60000,indexPrice:59995,info:{position_size:1000}}),
    fetchOrderBook:async()=>({timestamp:eventAt,bids:[[59999,100]],asks:[[60001,150]]}),
    fetchTicker:async()=>({timestamp:observed,quoteVolume:9000000})});
  const adapter=new CcxtAdapter('gate',{...config,feeOnly:true},client,true);
  try{
    const [snapshot]=await adapter.fetchSnapshots(['BTC']);
    assert.equal(snapshot.timestamp,eventAt);assert.equal(snapshot.observedAt,observed);
    assert.equal(quoteIsFresh(snapshot,{maxSnapshotAgeMs:1000},observed),true);
  }finally{await adapter.close();}
});

test('background public monitoring keeps real depth and clocks without optional OI or historical warmup requests',async()=>{
  const now=Date.now();let history=0,oi=0,privateCalls=0;
  const unexpectedPrivate=async()=>{privateCalls++;throw new Error('unexpected private call');};
  const client=mock({
    fetchFundingRate:async()=>({fundingRate:.001,fundingTimestamp:now+300000,interval:'8h',markPrice:60000,indexPrice:59995}),
    fetchOrderBook:async()=>({timestamp:now,bids:[[59999,100]],asks:[[60001,150]]}),
    fetchTicker:async()=>({timestamp:now,quoteVolume:9000000}),
    fetchOpenInterest:async()=>{oi++;return {openInterestValue:1e8};},
    fetchFundingRateHistory:async()=>{history++;return [];},
    createOrder:unexpectedPrivate,fetchOrder:unexpectedPrivate,fetchBalance:unexpectedPrivate,fetchPositions:unexpectedPrivate,
  });
  const adapter=new CcxtAdapter('binance',{...config,mode:'paper',feeOnly:true},client,true);
  const [snapshot]=await adapter.fetchSnapshots(['BTC']);
  assert.equal(snapshot.markPrice,60000);assert.equal(snapshot.bids[0].quantity,.1);
  assert.equal(snapshot.fundingRate,.001);assert.equal(snapshot.intervalHours,8);
  assert.equal(history,0);assert.equal(oi,0);assert.equal(snapshot.fundingHistory.length,0);
  assertNotSubmitted(await adapter.placeOrder(request));assert.equal(privateCalls,0);await adapter.close();
});
test('Bitget real public schema supplies mark, index, OI, rate, depth without extra OI call',async()=> {
  const now=Date.now(),bitget={...market,id:'BTCUSDT',contractSize:1,precision:{amount:0.0001,price:0.1},limits:{amount:{min:0.0001},cost:{min:5}}};
  const client=mock({markets:{[bitget.symbol]:bitget},market:()=>bitget,
    fetchFundingRate:async()=>({fundingRate:0.00008,fundingTimestamp:now+300000,interval:'4h',info:{nextUpdate:String(now+300000),fundingRateInterval:'4'}}),
    fetchTicker:async()=>({timestamp:now,quoteVolume:9000000,info:{markPrice:'60000',indexPrice:'59998',holdingAmount:'123.4'}}),
    fetchOrderBook:async()=>({timestamp:now,bids:[[59999,0.6]],asks:[[60001,0.7]]}),
    fetchOpenInterest:async()=>{throw new Error('redundant OI request');},
    fetchFundingRateHistory:async()=>[{timestamp:now-7200000,fundingRate:0.00007},{timestamp:now-3600000,fundingRate:0.00008}],
  });
  const adapter=new CcxtAdapter('bitget',{...config,mode:'paper'},client);
  const [s]=await adapter.fetchSnapshots(['BTC']);
  assert.equal(s.markPrice,60000);assert.equal(s.indexPrice,59998);assert.equal(s.openInterestUsd,7404000);
  assert.equal(s.intervalHours,4);assert.equal(s.bids[0].quantity,0.6);assert.equal(s.source,'public');
  assert.equal(s.quantityStep,0.0001);assert.equal(s.fundingRate,0.00008);
  await adapter.close();
});
test('valid symbols survive another symbol error and unsupported bases are diagnosed',async()=> {
  const now=Date.now(),eth={...market,id:'ETH_USDT',symbol:'ETH/USDT:USDT',base:'ETH'};
  const client=mock({markets:{[market.symbol]:market,[eth.symbol]:eth},
    fetchFundingRate:async(s:string)=>{if(s===eth.symbol)throw new Error('ETH unavailable');return {fundingRate:0.001,fundingTimestamp:now+300000,interval:'8h',markPrice:60000,indexPrice:59995,info:{position_size:1000}};},
    fetchOrderBook:async()=>({timestamp:now,bids:[[59999,100]],asks:[[60001,150]]}),
    fetchTicker:async()=>({timestamp:now,quoteVolume:9000000}),
    fetchFundingRateHistory:async()=>[{timestamp:now-57600000,fundingRate:0.0008},{timestamp:now-28800000,fundingRate:0.0009}],
  });
  const adapter=new CcxtAdapter('gate',config,client);
  const rows=await adapter.fetchSnapshots(['BTC','ETH','UNLISTED']);
  assert.deepEqual(rows.map(s=>s.base),['BTC']);
  assert.ok(adapter.getDiagnostics().some(d=>d.symbol==='ETH'&&d.code==='SYMBOL_FETCH_FAILED'));
  assert.ok(adapter.getDiagnostics().some(d=>d.symbol==='UNLISTED'&&d.code==='SYMBOL_UNAVAILABLE'));
  await adapter.close();
});
test('first live quotes do not wait for funding-history warmup and next poll uses cache',async()=> {
  const now=Date.now();let resolveHistory!:(v:any[])=>void;let historyCalls=0;
  const pending=new Promise<any[]>(resolve=>{resolveHistory=resolve;});
  const client=mock({
    fetchFundingRate:async()=>({fundingRate:0.001,fundingTimestamp:now+300000,interval:'8h',markPrice:60000,indexPrice:59995,info:{position_size:1000}}),
    fetchOrderBook:async()=>({timestamp:now,bids:[[59999,100]],asks:[[60001,150]]}),
    fetchTicker:async()=>({timestamp:now,quoteVolume:9000000}),
    fetchFundingRateHistory:async()=>{historyCalls++;return pending;},
  });
  const adapter=new CcxtAdapter('gate',config,client);
  const [first]=await adapter.fetchSnapshots(['BTC']);assert.equal(first.fundingHistory.length,0);assert.equal(historyCalls,1);
  resolveHistory([{timestamp:now-57600000,fundingRate:0.0008},{timestamp:now-28800000,fundingRate:0.0009}]);
  await new Promise(resolve=>setImmediate(resolve));
  const [next]=await adapter.fetchSnapshots(['BTC']);assert.deepEqual(next.fundingHistory,[0.0008,0.0009]);assert.equal(historyCalls,1);
  await adapter.close();
});
test('Bitget requires its passphrase before touching any private venue method',async()=> {
  let dispatches=0;const unexpectedDispatch=async()=>{dispatches++;throw new Error('unexpected private dispatch');};
  const adapter=new CcxtAdapter('bitget',config,mock({password:undefined,loadMarkets:unexpectedDispatch,
    createOrder:unexpectedDispatch,privateUtaGetV3AccountSettings:unexpectedDispatch}));
  for(const action of [()=>adapter.fetchAccount(),()=>adapter.prepareTrading(market.symbol,2),
    ()=>adapter.reconcileOrder(request),()=>adapter.cancelOrder(market.symbol,'1'),()=>adapter.fetchFundingPayments(Date.now()-1000)])
    await assert.rejects(action,/credentials are missing/);
  assertNotSubmitted(await adapter.placeOrder(request));assert.equal(dispatches,0);
});
test('confirmed partial IOC fills are base-normalized and same client ID never resubmits',async()=> {
  let calls=0; let params:any;
  const client=mock({createOrder:async(_s:string,type:string,side:string,qty:number,price:number,p:any)=> {
    calls++;params=p;assert.equal(type,'limit');assert.equal(qty,100);assert.equal(price,60000);
    return {id:'123',status:'canceled',filled:40,average:60000,fee:{currency:'USDT',cost:1.2}};
  }});
  const adapter=new CcxtAdapter('binance',config,client);
  const first=await adapter.placeOrder(request),second=await adapter.placeOrder(request);
  assert.equal(first.status,'partial');assert.equal(first.filledQuantity,0.04);assert.equal(first.feeUsd,1.2);
  assert.deepEqual(first,second);assert.equal(calls,1);assert.equal(params.timeInForce,'IOC');assert.equal(params.reduceOnly,true);
  await assert.rejects(()=>adapter.placeOrder({...request,quantity:0.2}),/different order details/);
});
test('network timeout and missing order remain unknown and never trigger another send',async()=> {
  let calls=0;
  const adapter=new CcxtAdapter('binance',config,mock({createOrder:async()=>{calls++;throw new Error('timeout');},fetchOrder:async()=>{throw new Error('not found yet');}}));
  assert.equal((await adapter.placeOrder(request)).status,'unknown');
  assert.equal((await adapter.placeOrder(request)).status,'unknown');
  assert.equal(calls,1);
});
test('simultaneous duplicate client IDs submit only once',async()=> {
  let calls=0;
  const adapter=new CcxtAdapter('binance',config,mock({createOrder:async()=>{calls++;return {id:'1',status:'closed',filled:100,average:60000};},fetchOrder:async()=>{throw new Error('pending');}}));
  await Promise.all([adapter.placeOrder(request),adapter.placeOrder(request)]);
  assert.equal(calls,1);
});
test('Bybit funding expenses and receipts normalize to signed cash flow',async()=> {
  const now=Date.now();
  const adapter=new CcxtAdapter('bybit',config,mock({privateGetV5ExecutionList:async()=>({result:{list:[
    {execId:'paid',symbol:market.id,execTime:now,execFee:'2'},
    {execId:'received',symbol:market.id,execTime:now,execFee:'-3'},
  ]}})}));
  const payments=await adapter.fetchFundingPayments(now-1);
  assert.deepEqual(payments.map(p=>p.amountUsd),[-2,3]);
});

test('native Bybit funding ownership keeps exact symbols, side and base quantity without inventing absent metadata',async()=>{
  const now=Date.now(),rows=[{execId:'long',symbol:market.id,execTime:now,execFee:'2',side:'Buy',execQty:'4330'},
    {execId:'short',symbol:market.id,execTime:now,execFee:'-3',side:'Sell',execQty:'4330'},
    {execId:'legacy',symbol:market.id,execTime:now,execFee:'-1'}];
  const payments=await readFundingLedger(mock({privateGetV5ExecutionList:async()=>({result:{list:rows}})}),'bybit',now-1,now);
  assert.deepEqual(payments.map(p=>[p.symbol,p.side,p.quantity]),[[market.symbol,undefined,undefined],[market.symbol,'long',4330],[market.symbol,'short',4330]]);
});
test('OKX funding ledger follows invoice cursor and deduplicates page overlap',async()=> {
  const now=Date.now();let calls=0;
  const rows=Array.from({length:100},(_,i)=>({instId:market.id,ccy:'USDT',ts:now-i,billId:String(200-i),balChg:'0',posBalChg:'1'}));
  const client=mock({privateGetAccountBillsArchive:async(p:any)=>{
    calls++;if(calls===1)return {data:rows};
    assert.equal(p.after,'101');return {data:[rows[99],{...rows[99],billId:'100',ts:now-100,posBalChg:'2'}]};
  }});
  const entries=await readFundingLedger(client,'okx',now-200,now);
  assert.equal(calls,2);assert.equal(entries.length,101);assert.equal(entries.reduce((n,p)=>n+p.amountUsd,0),102);
});
test('Bybit ledger splits week boundaries and follows each cursor',async()=> {
  const start=1770000000000,week=7*86400000;let calls=0;
  const client=mock({privateGetV5ExecutionList:async(p:any)=>{
    calls++;assert.ok(p.endTime-p.startTime<week);
    const first=p.startTime===start;
    return {result:{list:[{symbol:market.id,execId:String(calls),execTime:p.startTime,execFee:'-1'}],nextPageCursor:first&&!p.cursor?'next':''}};
  }});
  const rows=await readFundingLedger(client,'bybit',start,start+week+1000);
  assert.equal(calls,3);assert.equal(rows.length,3);
});
test('Binance and Gate ledger pages preserve every distinct invoice',async()=> {
  const now=Date.now();
  for(const id of ['binance','gate'] as const){
    let calls=0;
    const method=id==='binance'?'fapiPrivateGetIncome':'privateFuturesGetSettleAccountBook';
    const client=mock({[method]:async(p:any)=>{
      calls++;assert.equal(id==='binance'?p.page:p.offset,id==='binance'?calls:(calls-1)*100);
      return Array.from({length:calls===1?100:1},(_,i)=>id==='binance'
        ? {symbol:market.id,asset:'USDT',tranId:`${calls}-${i}`,time:now-i,income:'1'}
        : {text:market.id,id:`${calls}-${i}`,time:(now-i)/1000,change:'1'});
    }});
    const rows=await readFundingLedger(client,id,now-1000,now);
    assert.equal(calls,2);assert.equal(rows.length,101);
  }
});
test('repeated full funding ledger page fails rather than returning incomplete results',async()=> {
  const now=Date.now();
  const rows=Array.from({length:100},(_,i)=>({symbol:market.id,asset:'USDT',tranId:String(i),time:now,income:'1'}));
  await assert.rejects(()=>readFundingLedger(mock({fapiPrivateGetIncome:async()=>rows}),'binance',now-1000,now),/did not advance/);
});
test('paper config rejects private APIs, and hedge-mode prepare never changes account',async()=> {
  let changed=false,privateCalls=0;
  const client=mock({fetchPositionMode:async()=>{privateCalls++;return {hedged:true};},setLeverage:async()=>{changed=true;},
    createOrder:async()=>{privateCalls++;throw new Error('unexpected private create');}});
  assertNotSubmitted(await new CcxtAdapter('binance',{...config,mode:'paper'},client).placeOrder(request));
  assert.equal(privateCalls,0);
  await assert.rejects(()=>new CcxtAdapter('binance',config,client).prepareTrading(market.symbol,2),/one-way/);
  assert.equal(changed,false);
});
test('limit rounding never increases buy cap and imprecise coin size is rejected',async()=> {
  let sentPrice=0,sends=0;
  const adapter=new CcxtAdapter('binance',config,mock({createOrder:async(_s:string,_t:string,_side:string,_qty:number,price:number)=>{
    sentPrice=price;sends++;return {id:'1',status:'canceled',filled:0};
  }}));
  await adapter.placeOrder({...request,limitPrice:60000.07});
  assert.ok(sentPrice<=60000.07);
  const bad={...request,clientOrderId:'bad-size',quantity:0.1004};
  await assert.rejects(()=>adapter.validateOrder(bad),/lot size/);
  const rejected=await adapter.placeOrder(bad);assert.equal(rejected.status,'cancelled');assert.equal(rejected.filledQuantity,0);
  assert.equal(rejected.rejectionCode,'INVALID_ORDER_QUANTITY');assert.equal(sends,1);
});

test('OKX snapshots preserve raw funding/mark/index observation times and ignore deprecated later-cycle predictions',async()=>{
  const now=Date.now();
  const client:any=mock({
    fetchFundingRate:async()=>({fundingRate:.001,nextFundingRate:-.02,fundingTimestamp:now+300000,nextFundingTimestamp:now+29100000,
      info:{fundingTime:String(now+300000),nextFundingTime:String(now+29100000),ts:String(now-60000)}}),
    fetchOrderBook:async()=>({timestamp:now,bids:[[59999,100]],asks:[[60001,150]]}),
    fetchTicker:async()=>({timestamp:now,quoteVolume:9000000,info:{volCcy24h:'150'}}),fetchOpenInterest:async()=>({openInterestValue:1e8}),
    publicGetPublicMarkPrice:async()=>({data:[{markPx:'60000',ts:String(now-1000)}]}),
    publicGetMarketIndexTickers:async()=>({data:[{idxPx:'60000',ts:String(now-2000)}]}),
    fetchFundingRateHistory:async()=>[],
  });
  const adapter=new CcxtAdapter('okx',config,client),[s]=await adapter.fetchSnapshots(['BTC']);
  assert.equal(s.timestamp,now-60000);assert.equal(s.predictedFundingRate,undefined);await adapter.close();
  client.fetchFundingRate=async()=>({fundingRate:.001,fundingTimestamp:now+300000,interval:'8h',info:{ts:String(now+60000)}});
  const future=new CcxtAdapter('okx',config,client);await assert.rejects(future.fetchSnapshots(['BTC']),/no requested/);await future.close();
});

test('fee-only quotes tolerate unavailable OI and volume without inventing zeroes',async()=>{
  const now=Date.now(),client=mock({
    fetchFundingRate:async()=>({fundingRate:.006,fundingTimestamp:now+300000,interval:'8h',info:{fundingTime:String(now+300000),ts:String(now)}}),
    fetchOrderBook:async()=>({timestamp:now,bids:[[59999,100]],asks:[[60001,150]]}),
    fetchTicker:async()=>({timestamp:now,info:{}}),fetchOpenInterest:async()=>{throw new Error('OFFLINE optional OI unavailable');},
    publicGetPublicMarkPrice:async()=>({data:[{markPx:'60000',ts:String(now)}]}),
    publicGetMarketIndexTickers:async()=>({data:[{idxPx:'60000',ts:String(now)}]}),fetchFundingRateHistory:async()=>[],
  });
  const allowed=new CcxtAdapter('okx',{...config,feeOnly:true},client);
  try{const [s]=await allowed.fetchSnapshots(['BTC']);assert.ok(s);assert.equal(s.fundingRate,.006);
    assert.ok(Number.isNaN(s.openInterestUsd));assert.ok(Number.isNaN(s.volume24hUsd));
    assert.ok(allowed.getDiagnostics().some(d=>d.code==='OI_UNAVAILABLE'));assert.ok(allowed.getDiagnostics().some(d=>d.code==='VOLUME_UNAVAILABLE'));
  }finally{await allowed.close();}
  const strict=new CcxtAdapter('okx',{...config,feeOnly:false},client);
  try{await assert.rejects(strict.fetchSnapshots(['BTC']),/no requested/);}finally{await strict.close();}
});

test('a pending optional OI request cannot delay fee-only books and is never sent twice',async()=>{
  const now=Date.now();let calls=0,resolveOi!:(value:unknown)=>void;
  const client=mock({
    fetchFundingRate:async()=>({fundingRate:.006,fundingTimestamp:now+300000,interval:'8h',info:{fundingTime:String(now+300000),ts:String(now)}}),
    fetchOrderBook:async()=>({timestamp:now,bids:[[59999,100]],asks:[[60001,150]]}),
    fetchTicker:async()=>({timestamp:now,quoteVolume:9000000,info:{volCcy24h:'150'}}),
    fetchOpenInterest:()=>{calls++;return new Promise(resolve=>{resolveOi=resolve;});},
    publicGetPublicMarkPrice:async()=>({data:[{markPx:'60000',ts:String(now)}]}),
    publicGetMarketIndexTickers:async()=>({data:[{idxPx:'60000',ts:String(now)}]}),fetchFundingRateHistory:async()=>[],
  });
  const adapter=new CcxtAdapter('okx',{...config,feeOnly:true},client);let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    const bounded=()=>Promise.race([adapter.fetchSnapshots(['BTC']),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('optional OI blocked books')),1000);})]).finally(()=>{if(timer)clearTimeout(timer);});
    assert.ok(Number.isNaN((await bounded())[0].openInterestUsd));
    assert.ok(Number.isNaN((await bounded())[0].openInterestUsd));assert.equal(calls,1);
    resolveOi({openInterestValue:1e8});await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal((await bounded())[0].openInterestUsd,1e8);assert.equal(calls,1);
  }finally{await adapter.close();if(timer)clearTimeout(timer);}
});

test('OKX native position lifetime cash signs and realised price PnL are preserved without zero-filling missing fields',async()=>{
  const native={symbol:market.symbol,contracts:100,side:'short',entryPrice:59900,unrealizedPnl:-10,markPrice:60000,leverage:2,liquidationPrice:90000,
    marginMode:'cross',info:{fundingFee:'1.23456789',fee:'-.12',pnl:'.25',cTime:'1790878400000',uTime:'1790913612000'}};
  const client=mock({fetchBalance:async()=>({USDT:{free:80,total:100}}),fetchPositions:async()=>[native]});
  const adapter=new CcxtAdapter('okx',config,client),p=(await adapter.fetchAccount()).positions[0];
  assert.equal(p.quantity,.1);assert.equal(p.fundingUsd,1.23456789);assert.equal(p.feesUsd,.12);assert.equal(p.realizedPnlUsd,.25);
  assert.equal(p.positionOpenedAt,1790878400000);assert.equal(p.positionUpdatedAt,1790913612000);
  assert.equal(p.marginMode,'crossed');assert.equal(p.liquidationStatus,'price');
  native.info.fee='.01';assert.equal((await adapter.fetchAccount()).positions[0].feesUsd,-.01);
  for(const value of [undefined,null,''] as const){
    Object.assign(native,{liquidationPrice:value});Object.assign(native.info,{fundingFee:value,fee:value,pnl:value});
    const missing=(await adapter.fetchAccount()).positions[0];
    assert.equal(missing.fundingUsd,undefined);assert.equal(missing.feesUsd,undefined);assert.equal(missing.realizedPnlUsd,undefined);
    assert.equal(missing.liquidationPrice,0);assert.equal(missing.liquidationStatus,'unavailable');assert.ok(missing.liquidationReason);
  }
});

test('Binance positions do not invent lifetime funding, fees or current opening time from update time',async()=>{
  const client=mock({fetchBalance:async()=>({USDT:{free:80,total:100}}),fetchPositions:async()=>[
    {symbol:market.symbol,contracts:100,side:'long',markPrice:60000,leverage:2,liquidationPrice:30000,
      info:{updateTime:'1790913612000',marginType:'ISOLATED'}}]});
  const p=(await new CcxtAdapter('binance',config,client).fetchAccount()).positions[0];
  assert.equal(p.fundingUsd,undefined);assert.equal(p.feesUsd,undefined);assert.equal(p.positionOpenedAt,undefined);
  assert.equal(p.positionUpdatedAt,1790913612000);assert.equal(p.marginMode,'isolated');assert.equal(p.liquidationStatus,'price');
});

test('generic account overview uses the read-only account mapping and does not fetch spot funds',async()=>{
  for(const id of ['binance','okx'] as const){
    const client=mock({fetchBalance:async()=>({USDT:{free:80,total:100}}),fetchPositions:async()=>[
      {symbol:market.symbol,contracts:2,side:'long',markPrice:60000,leverage:2,liquidationPrice:30000}],
      privateSpotGetV2SpotAccountAssets:async()=>{throw new Error('unexpected spot request');}});
    const overview=await new CcxtAdapter(id,config,client).fetchAccountOverview();
    assert.deepEqual(overview,{freeUsd:80,equityUsd:100,positionCount:1,balanceScope:'usdt_futures'});
  }
});
