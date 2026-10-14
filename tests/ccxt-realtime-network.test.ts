import test from 'node:test';
import assert from 'node:assert/strict';
import {CcxtAdapter} from '../src/adapters/ccxt.js';
import {defaultConfig} from '../src/shared/config.js';
import type {ExchangeId} from '../src/shared/types.js';
import type {RealtimeBook} from '../src/shared/realtime.js';

const SYMBOL='BTC/USDT:USDT';
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function fixture(id:ExchangeId='gate'){
  const market={id:'BTCUSDT',symbol:SYMBOL,base:'BTC',quote:'USDT',settle:'USDT',active:true,swap:true,linear:true,
    contractSize:10,precision:{amount:1,price:.1},limits:{amount:{min:1},cost:{min:1}},info:{funding_interval:28800,fundingInterval:480}};
  let book:RealtimeBook|undefined={exchange:id,symbol:SYMBOL,bids:[{price:99,quantity:100}],asks:[{price:101,quantity:200}],
    receivedAt:Date.now()-300,eventAt:Date.now()-400,generation:7};
  let restReads=0,tickerReads=0,fundingReads=0;
  const funding=()=>({fundingRate:.001,fundingTimestamp:Date.now()+300_000,interval:'8h',markPrice:100,indexPrice:100,
    info:{fundingIntervalHour:'8',position_size:1000}});
  const client:any={precisionMode:4,options:{},has:{},markets:{[SYMBOL]:market},market:()=>market,loadMarkets:async()=>({[SYMBOL]:market}),
    fetchTicker:async()=>{tickerReads++;return {timestamp:Date.now(),quoteVolume:1e6,info:{markPrice:100,indexPrice:100}};},
    parseFundingRate:()=>funding(),fetchFundingRate:async()=>{fundingReads++;return funding();},
    fetchOrderBook:async()=>{restReads++;return {timestamp:Date.now(),bids:[[98,3]],asks:[[102,4]]};},
    fetchOpenInterest:async()=>({openInterestValue:1e6}),
    publicGetPublicMarkPrice:async()=>({data:[{markPx:'100',ts:String(Date.now())}]}),
    publicGetMarketIndexTickers:async()=>({data:[{idxPx:'100',ts:String(Date.now())}]}),
    fetchFundingRateHistory:async()=>[{timestamp:Date.now()-16*3600000,fundingRate:.0008},{timestamp:Date.now()-8*3600000,fundingRate:.0009}],
  };
  const adapter=new CcxtAdapter(id,{...defaultConfig,mode:'paper',dataSource:'public',feeOnly:true,maxSnapshotAgeMs:30000},client);
  (adapter as any).publicBooks={getBook:()=>book,setSymbols:()=>{},close:async()=>{}};
  return {adapter,client,getBook:()=>book,setBook:(value:RealtimeBook|undefined)=>{book=value;},restReads:()=>restReads,tickerReads:()=>tickerReads,fundingReads:()=>fundingReads};
}

test('all five venues reuse genuine fresh WebSocket depth without a redundant REST read or a second contract multiplier',async()=>{
  for(const id of ['binance','bybit','okx','gate','bitget'] as const){
    const f=fixture(id),source=f.getBook()!;
    try{
      const [quote]=await f.adapter.fetchSnapshots(['BTC']);
      assert.equal(f.restReads(),0);assert.equal(f.tickerReads(),1);
      assert.equal(f.fundingReads(),id==='bybit'?0:1,'funding remains an independently fetched observation');
      assert.equal(quote.bookTransport,'websocket');assert.equal(quote.bookGeneration,7);
      assert.equal(quote.observedAt,source.receivedAt);assert.equal(quote.bids[0].quantity,100);
      assert.equal(quote.asks[0].quantity,200);assert.equal(quote.contractSize,10);
      assert.ok(quote.fundingObservedAt!>source.receivedAt);
    }finally{await f.adapter.close();}
  }
});

test('expired, malformed, crossed, wrong-symbol and invalid-generation stream observations fall back to current REST depth',async()=>{
  const mutations:Array<(book:RealtimeBook)=>void>=[
    book=>{book.receivedAt=Date.now()-2001;},book=>{book.eventAt=Date.now()-2001;},
    book=>{book.generation=0;},book=>{book.symbol='ETH/USDT:USDT';},book=>{book.exchange='bybit';},
    book=>{book.asks=[];},book=>{book.bids[0].quantity=NaN;},book=>{book.bids[0].price=102;},
    book=>{book.bids.push({price:100,quantity:1});},
  ];
  for(const mutate of mutations){const f=fixture();try{
    mutate(f.getBook()!);const [quote]=await f.adapter.fetchSnapshots(['BTC']);
    assert.equal(f.restReads(),1);assert.equal(quote.bookTransport,'rest');assert.equal(quote.bookGeneration,undefined);
    assert.equal(quote.bids[0].price,98);assert.equal(quote.bids[0].quantity,30);
  }finally{await f.adapter.close();}}
});

test('a stream book expiring while metadata is pending is never relabeled fresh and is replaced by a REST read',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1700000000000});
  const f=fixture();let finish!:()=>void;
  f.client.fetchTicker=async()=>{await new Promise<void>(resolve=>{finish=resolve;});return {timestamp:Date.now(),quoteVolume:1e6};};
  try{
    const request=f.adapter.fetchSnapshots(['BTC']);await flush();assert.equal(f.restReads(),0);
    t.mock.timers.tick(2500);finish();const [quote]=await request;
    assert.equal(f.restReads(),1);assert.equal(quote.bookTransport,'rest');assert.equal(quote.observedAt,Date.now());
    assert.equal(quote.fundingObservedAt,1700000000000,'book fallback cannot change the funding observation time');
  }finally{await f.adapter.close();}
});

test('fresh incoming WS updates can replace a failed redundant REST book while valid metadata reads still complete',async()=>{
  const f=fixture(),arriving=f.getBook()!;f.setBook(undefined);
  f.client.fetchOrderBook=async()=>{throw new Error('synthetic read timeout');};
  f.client.fetchTicker=async()=>{f.setBook({...arriving,receivedAt:Date.now(),eventAt:Date.now()});return {timestamp:Date.now(),quoteVolume:1e6};};
  try{
    const [quote]=await f.adapter.fetchSnapshots(['BTC']);assert.equal(quote.bookTransport,'websocket');assert.equal(quote.bids[0].quantity,100);
  }finally{await f.adapter.close();}
});

test('book updates never extend funding metadata lifetime; an independent funding poll renews that metadata seed',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1700000000000});
  const f=fixture();try{
    const [initial]=await f.adapter.fetchSnapshots(['BTC']);assert.equal(initial.fundingObservedAt,Date.now());
    assert.equal(f.adapter.getExecutionSnapshot('BTC')?.fundingObservedAt,initial.fundingObservedAt);
    t.mock.timers.tick(30001);f.setBook({...f.getBook()!,receivedAt:Date.now(),eventAt:Date.now(),generation:8});
    assert.equal(f.adapter.getExecutionSnapshot('BTC'),undefined,'a fresh book cannot borrow expired funding');
    f.adapter.seedRealtimeSnapshot({...initial,fundingObservedAt:Date.now(),observedAt:Date.now()});
    assert.equal(f.adapter.getExecutionSnapshot('BTC'),undefined,'externally pushed metadata cannot be renewed by a WS book');
    const [renewed]=await f.adapter.fetchSnapshots(['BTC']);assert.equal(renewed.fundingObservedAt,Date.now());
    assert.equal(f.adapter.getExecutionSnapshot('BTC')?.fundingObservedAt,renewed.fundingObservedAt);
    assert.equal(f.restReads(),0);assert.equal(f.fundingReads(),2);
  }finally{await f.adapter.close();}
});

test('WebSocket and REST execution refresh clear old seeded Maker after a Taker-only response and cache expiry',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1700000000000});
  const f=fixture('bybit');let maker:any='.00018',feeReads=0;
  // All public and private methods are local fixtures; no real account request is issued.
  (f.adapter as any).config={...defaultConfig,mode:'live',dataSource:'public',feeOnly:true,maxSnapshotAgeMs:30000};
  f.client.apiKey='synthetic-key';f.client.secret='synthetic-secret';
  f.client.privateGetV5AccountFeeRate=async()=>{feeReads++;return {retCode:0,result:{list:[{symbol:'BTCUSDT',takerFeeRate:'.0011',makerFeeRate:maker}]}};};
  const noMaker=(row:any)=>{
    assert.ok(row);assert.equal(row.makerFeeRate,undefined);assert.equal(row.makerFeeAt,undefined);assert.equal(row.makerFeeSource,undefined);
  };
  try{
    const [initial]=await f.adapter.fetchSnapshots(['BTC']),fee=await f.adapter.fetchTradingFee(SYMBOL);
    const seeded={...initial,...fee,bookTransport:'rest' as const};
    f.adapter.seedRealtimeSnapshot(seeded);
    assert.equal(f.adapter.getExecutionSnapshot('BTC')?.makerFeeRate,.00018);
    t.mock.timers.tick(60000);maker=undefined;
    assert.equal((await f.adapter.fetchTradingFee(SYMBOL))?.takerFeeRate,.0011);assert.equal(feeReads,2);
    const renewOldSeed=()=>f.adapter.seedRealtimeSnapshot({...seeded,makerFeeAt:Date.now(),fundingObservedAt:Date.now(),observedAt:Date.now(),timestamp:Date.now()});
    renewOldSeed();const stream={...f.getBook()!,receivedAt:Date.now(),eventAt:Date.now(),generation:8};f.setBook(stream);
    const ws=f.adapter.getExecutionSnapshot('BTC');noMaker(ws);assert.equal(ws?.takerFeeRate,.0011);assert.equal(ws?.bookTransport,'websocket');
    f.setBook(undefined);const [rest]=await f.adapter.fetchExecutionSnapshots(['BTC']);noMaker(rest);assert.equal(rest.bookTransport,'rest');
    // A missing cache also clears an earlier seed, even if that seed pretends its Maker timestamp is recent.
    t.mock.timers.tick(120001);renewOldSeed();f.setBook({...stream,receivedAt:Date.now(),eventAt:Date.now(),generation:9});
    assert.equal(f.adapter.cachedTradingFee(SYMBOL),undefined);noMaker(f.adapter.getExecutionSnapshot('BTC'));
    f.setBook(undefined);noMaker((await f.adapter.fetchExecutionSnapshots(['BTC']))[0]);assert.equal(feeReads,2);
  }finally{await f.adapter.close();}
});
