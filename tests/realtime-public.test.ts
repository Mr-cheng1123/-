import test from 'node:test';
import assert from 'node:assert/strict';
import type {ExchangeId} from '../src/shared/types.js';
import type {RealtimeBook,RealtimeStreamStatus} from '../src/shared/realtime.js';
import {MAX_REALTIME_PUBLIC_SYMBOLS,REALTIME_PUBLIC_BOOK_TTL_MS,RealtimePublicBooks} from '../src/adapters/realtime-public.js';
import {ExchangeNetworkError,getExchangeNetworkStatus} from '../src/adapters/network.js';

type Pending={symbol:string;resolve:(book:any)=>void;reject:(error:unknown)=>void};
const SYMBOL='CT/USDT:USDT',OTHER='ARK/USDT:USDT';
const market=(symbol:string,contractSize=1)=>({id:symbol.replace('/','').split(':')[0],symbol,base:symbol.split('/')[0],swap:true,linear:true,active:true,quote:'USDT',settle:'USDT',contract:true,contractSize});
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function rest(id:ExchangeId='gate',contractSize=10):any{
  return {id:id==='binance'?'binanceusdm':id,markets:{[SYMBOL]:market(SYMBOL,contractSize),[OTHER]:market(OTHER,contractSize)},symbols:[SYMBOL,OTHER],options:{},
    apiKey:'REST_KEY_MUST_NOT_ESCAPE',secret:'REST_SECRET_MUST_NOT_ESCAPE',password:'REST_PASS_MUST_NOT_ESCAPE'};
}
function raw(symbol=SYMBOL,nonce:number|string|undefined=1,timestamp:number|undefined=Date.now()):any{
  return {symbol,nonce,timestamp,bids:[[100,2],[99,3]],asks:[[101,4],[102,5]]};
}
class FakeWs{
  [key:string]:any;
  pending:Pending[]=[];
  watches:{symbol:string;limit:number;params:any}[]=[];
  unwatches:{symbol:string;params:any}[]=[];
  closeCalls=0;proxyLoads=0;shared=0;
  options:Record<string,unknown>={};
  setMarketsFromExchange(source:any){this.shared++;this.markets=source.markets;this.symbols=source.symbols;}
  async loadProxyModules(){this.proxyLoads++;}
  watchOrderBook(symbol:string,limit:number,params:any){
    this.watches.push({symbol,limit,params});
    return new Promise((resolve,reject)=>this.pending.push({symbol,resolve,reject}));
  }
  async unWatchOrderBook(symbol:string,params:any){this.unwatches.push({symbol,params});}
  async close(){this.closeCalls++;}
  next(symbol=SYMBOL):Pending{
    const index=this.pending.findIndex(p=>p.symbol===symbol);assert.ok(index>=0,`pending watch ${symbol}`);
    return this.pending.splice(index,1)[0];
  }
}
function fixture(id:ExchangeId='gate',contractSize=10,ws=new FakeWs()){
  const source=rest(id,contractSize),books:RealtimeBook[]=[],statuses:RealtimeStreamStatus[]=[];
  const stream=new RealtimePublicBooks(id,source,{onBook:book=>books.push(book),onStatus:status=>statuses.push(status)},ws);
  return {source,ws,stream,books,statuses};
}

test('public clients strip credentials, share loaded metadata and convert contracts to base coins',async()=>{
  const {source,ws,stream,books}=fixture();
  // A separately injected client with credentials is also sanitized during construction.
  const secureWs=new FakeWs();secureWs.apiKey='private';secureWs.secret='secret';secureWs.password='pass';
  const publicOnly=new RealtimePublicBooks('gate',source,{onBook:()=>{}},secureWs);
  try{
    assert.equal(secureWs.apiKey,undefined);assert.equal(secureWs.secret,undefined);assert.equal(secureWs.password,undefined);
    assert.equal(source.apiKey,'REST_KEY_MUST_NOT_ESCAPE');
    stream.setSymbols([SYMBOL]);await flush();
    assert.equal(ws.markets,source.markets);assert.equal(ws.watches[0].limit,100);
    ws.next().resolve(raw());await flush();
    assert.equal(books.length,1);assert.deepEqual(books[0].bids[0],{price:100,quantity:20});
    assert.deepEqual(books[0].asks[0],{price:101,quantity:40});
    assert.equal(stream.status().state,'online');
    books[0].bids[0].quantity=999;assert.equal(stream.getBook(SYMBOL)!.bids[0].quantity,20);
    const read=stream.getBook(SYMBOL)!;read.bids[0].price=999;assert.equal(stream.getBook(SYMBOL)!.bids[0].price,100);
  }finally{await stream.close();await publicOnly.close();}
});

test('a discarded native subscription send failure invalidates public books through the existing watch generation',async()=>{
  const ws=new FakeWs();let sends=0,onErrors=0;
  const native={send:async()=>{sends++;throw new Error('WebSocket is not open: readyState 3 (CLOSED)');},
    onError:(error:unknown)=>{onErrors++;for(const pending of ws.pending.splice(0))pending.reject(error);}};
  ws.client=()=>native;
  const {stream}=fixture('bybit',1,ws);
  try {
    stream.setSymbols([SYMBOL]);await flush();ws.next().resolve(raw());await flush();
    assert.ok(stream.getBook(SYMBOL));
    // No financial endpoint: model only CCXT's native subscribe-send promise being discarded.
    void ws.client('offline').send();await flush();
    assert.equal(sends,1);assert.equal(onErrors,1);assert.equal(stream.getBook(SYMBOL),undefined);
    assert.equal(stream.status().state,'offline');assert.equal(stream.status().reconnects,1);
    assert.equal(ws.closeCalls,1);
  }finally{await stream.close();}
});

test('five venues subscribe to unauthenticated channels and unwatch the exact depth',async()=>{
  for(const id of ['binance','bybit','okx','gate','bitget'] as const){
    const {ws,stream}=fixture(id,1);
    try{
      // Bitget's method exists even though CCXT's has.unWatchOrderBook flag is missing.
      ws.has={watchOrderBook:true};
      stream.setSymbols([SYMBOL]);await flush();
      assert.deepEqual(ws.watches[0].params,id==='bitget'?{uta:false}:{});
      assert.equal(ws.watches[0].limit,{binance:20,bybit:50,okx:400,gate:100,bitget:15}[id]);
      stream.setSymbols([]);await flush();
      assert.equal(ws.unwatches.length,1);assert.equal(ws.unwatches[0].params.limit,ws.watches[0].limit);
      assert.equal(stream.status().state,'disabled');
    }finally{await stream.close();}
  }
});

test('HTTP CONNECT and SOCKS websocket proxy settings inherit the REST route without direct fallback',async()=>{
  for(const route of ['httpsProxy','httpProxy','socksProxy'] as const){
    const source=rest('gate'),ws=new FakeWs();source[route]=route==='socksProxy'?'socks5h://proxy.invalid:1080':'http://proxy.invalid:7890';
    ws.wsProxy='http://wrong.invalid';ws.wssProxy='http://wrong.invalid';
    const stream=new RealtimePublicBooks('gate',source,{onBook:()=>{}},ws);
    try{
      assert.equal(ws.wsProxy,undefined);
      if(route==='socksProxy'){
        assert.equal(ws.wsSocksProxy,source.socksProxy);assert.equal(ws.socksProxy,source.socksProxy);assert.equal(ws.wssProxy,undefined);
      }else{
        assert.equal(ws.wssProxy,source[route]);assert.equal(ws.httpsProxy,source[route]);assert.equal(ws.wsSocksProxy,undefined);
      }
      stream.setSymbols([SYMBOL]);await flush();assert.equal(ws.proxyLoads,1);
    }finally{await stream.close();}
  }
});

test('Bitget public channels stay fixed when concurrent REST calls detect a unified account',async()=>{
  const {source,ws,stream}=fixture('bitget',1);source.options.uta=true;
  try{
    stream.setSymbols([SYMBOL]);await flush();
    assert.equal(ws.watches[0].params.uta,false);assert.equal(ws.options.uta,undefined);
    ws.next().resolve(raw());await flush();source.options.uta=false;
    ws.next().resolve(raw(SYMBOL,2));await flush();source.options.uta=true;
    ws.next().resolve(raw(SYMBOL,3));await flush();
    assert.ok(ws.watches.every(row=>row.params.uta===false));
    stream.setSymbols([]);await flush();assert.equal(ws.unwatches[0].params.uta,false);
  }finally{await stream.close();}
});

test('hot subscriptions are capped, deduplicated and constrained to exact eligible USDT perpetuals',async()=>{
  const {source,ws,stream}=fixture();
  const symbols=Array.from({length:MAX_REALTIME_PUBLIC_SYMBOLS+5},(_,i)=>`T${i}/USDT:USDT`);
  for(const symbol of symbols)source.markets[symbol]=market(symbol);
  source.markets['BAD/USDT:USDT']={...market('BAD/USDT:USDT'),active:false};
  source.markets['SPOT/USDT']={...market('SPOT/USDT'),swap:false};
  try{
    stream.setSymbols(['missing','BAD/USDT:USDT','SPOT/USDT',SYMBOL,SYMBOL,...symbols]);await flush();
    assert.equal(stream.status().subscriptions,MAX_REALTIME_PUBLIC_SYMBOLS);
    assert.equal(ws.watches.length,MAX_REALTIME_PUBLIC_SYMBOLS);
    assert.equal(ws.watches.filter(w=>w.symbol===SYMBOL).length,1);
    const first=ws.pending.find(p=>p.symbol===SYMBOL)!;
    stream.setSymbols([SYMBOL]);await flush();
    assert.ok(ws.pending.includes(first),'kept symbol should retain its pending watch');
    assert.equal(ws.watches.filter(w=>w.symbol===SYMBOL).length,1);
  }finally{await stream.close();}
});

test('remove and immediate re-add wait for unsubscribe; late data cannot cross subscription generations',async()=>{
  const {ws,stream,books}=fixture();
  let finishUnsubscribe!:()=>void;
  ws.unWatchOrderBook=(symbol:string,params:any)=>{ws.unwatches.push({symbol,params});return new Promise<void>(resolve=>{finishUnsubscribe=resolve;});};
  try{
    stream.setSymbols([SYMBOL]);await flush();const old=ws.next();
    stream.setSymbols([]);stream.setSymbols([SYMBOL]);await flush();
    assert.equal(ws.watches.length,1);assert.equal(stream.getBook(SYMBOL),undefined);
    old.resolve(raw());await flush();assert.equal(books.length,0);
    finishUnsubscribe();await flush();assert.equal(ws.watches.length,2);
    ws.next().resolve(raw(SYMBOL,2));await flush();assert.equal(books.length,1);
    assert.equal(books[0].generation,2);
  }finally{await stream.close();}
});

test('crossed, locked, unsorted, duplicate-price and malformed depths are discarded without fake liquidity',async()=>{
  for(const mutate of [
    (b:any)=>b.bids[0][0]=103,
    (b:any)=>b.bids[0][0]=101,
    (b:any)=>b.bids=[[99,2],[100,2]],
    (b:any)=>b.asks=[[101,2],[101,2]],
    (b:any)=>b.bids[1][1]=0,
    (b:any)=>b.asks[0][1]=Infinity,
    (b:any)=>b.bids=[],
    (b:any)=>b.symbol=OTHER,
  ]){
    const {ws,stream,books}=fixture();
    try{
      stream.setSymbols([SYMBOL]);await flush();const b=raw();mutate(b);ws.next().resolve(b);await flush();
      assert.equal(books.length,0);assert.equal(stream.getBook(SYMBOL),undefined);assert.equal(stream.status().state,'degraded');
      ws.next().resolve(raw(SYMBOL,2));await flush();assert.equal(stream.status().state,'online');
    }finally{await stream.close();}
  }
});

test('stale native events and rounded unsafe numeric sequences never become live quotes',async()=>{
  for(const book of [raw(SYMBOL,1,Date.now()-REALTIME_PUBLIC_BOOK_TTL_MS-100),raw(SYMBOL,1,Date.now()+5000),raw(SYMBOL,Number.MAX_SAFE_INTEGER+1)]){
    const {ws,stream,books}=fixture();
    try{
      stream.setSymbols([SYMBOL]);await flush();ws.next().resolve(book);await flush();
      assert.equal(books.length,0);assert.equal(stream.getBook(SYMBOL),undefined);
    }finally{await stream.close();}
  }
});

test('identical sequence or timestamp-free cached replay cannot extend the cache lifetime',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now:1700000000000});
  const {ws,stream,books}=fixture();
  try{
    stream.setSymbols([SYMBOL]);await flush();ws.next().resolve(raw());await flush();const received=books[0].receivedAt;
    t.mock.timers.tick(1000);ws.next().resolve(raw());await flush();
    assert.equal(books.length,1);assert.equal(stream.getBook(SYMBOL)!.receivedAt,received);
    t.mock.timers.tick(1100);assert.equal(stream.getBook(SYMBOL),undefined);assert.equal(stream.status().state,'degraded');
  }finally{await stream.close();}
  const second=fixture();
  try{
    second.stream.setSymbols([SYMBOL]);await flush();const b=raw();delete b.nonce;delete b.timestamp;second.ws.next().resolve(b);await flush();
    t.mock.timers.tick(1000);second.ws.next().resolve(b);await flush();assert.equal(second.books.length,1);
    t.mock.timers.tick(1100);assert.equal(second.stream.getBook(SYMBOL),undefined);
  }finally{await second.stream.close();}
});

test('transport failure clears every book before reconnect and ignores all late old-generation results',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now:1700000000000});
  const {ws,stream,books}=fixture();
  try{
    stream.setSymbols([SYMBOL,OTHER]);await flush();ws.next().resolve(raw(SYMBOL,10));ws.next(OTHER).resolve(raw(OTHER,20));await flush();
    assert.equal(stream.status().state,'online');const late=ws.next(OTHER);
    ws.next().reject(new Error('ECONNRESET http://user:secret@proxy.invalid'));await flush();
    assert.equal(stream.getBook(SYMBOL),undefined);assert.equal(stream.getBook(OTHER),undefined);
    assert.equal(stream.status().state,'offline');assert.equal(stream.status().reconnects,1);
    assert.doesNotMatch(JSON.stringify(stream.status()),/user|secret|proxy\.invalid/);
    late.resolve(raw(OTHER,21));await flush();assert.equal(books.length,2);
    t.mock.timers.tick(250);await flush();
    ws.next().resolve(raw(SYMBOL,1));ws.next(OTHER).resolve(raw(OTHER,1));await flush();
    assert.equal(books.length,4);assert.equal(stream.status().state,'online');
    assert.ok(books[2].generation>books[0].generation);
  }finally{await stream.close();}
});

test('a regressing sequence forces a fresh generation instead of reusing an invalid native book',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now:1700000000000});
  const {ws,stream,books}=fixture();
  try{
    stream.setSymbols([SYMBOL]);await flush();ws.next().resolve(raw(SYMBOL,'9007199254740995'));await flush();
    assert.equal(books[0].sequence,'9007199254740995');
    ws.next().resolve(raw(SYMBOL,'9007199254740994'));await flush();
    assert.equal(books.length,1);assert.equal(stream.getBook(SYMBOL),undefined);assert.equal(stream.status().error,'OUT_OF_ORDER');
    t.mock.timers.tick(250);await flush();ws.next().resolve(raw(SYMBOL,1));await flush();
    assert.equal(books.length,2);assert.ok(books[1].generation>books[0].generation);
  }finally{await stream.close();}
});

test('quiet instruments expire quotes without treating silence as a transport disconnect',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now:1700000000000});
  const {ws,stream}=fixture();
  try{
    stream.setSymbols([SYMBOL]);await flush();ws.next().resolve(raw());await flush();
    t.mock.timers.tick(2250);assert.equal(stream.getBook(SYMBOL),undefined);assert.equal(stream.status().error,'STALE_BOOK');
    t.mock.timers.tick(8000);await flush();assert.equal(stream.status().reconnects,0);assert.equal(ws.closeCalls,0);
  }finally{await stream.close();}
});

test('24 symbols with quiet books do not restart or invalidate the continuously active symbol',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now:1700000000000});
  const {source,ws,stream}=fixture();
  const symbols=[SYMBOL,...Array.from({length:23},(_,i)=>`QUIET${i}/USDT:USDT`)];
  for(const symbol of symbols)source.markets[symbol]=market(symbol,1);
  try{
    stream.setSymbols(symbols);await flush();
    for(const symbol of symbols)ws.next(symbol).resolve(raw(symbol));await flush();
    const generation=stream.getBook(SYMBOL)!.generation;
    for(let second=1;second<=30;second++){
      t.mock.timers.tick(1000);ws.next().resolve(raw(SYMBOL,second+1));await flush();
    }
    assert.equal(stream.status().subscriptions,24);assert.equal(stream.status().reconnects,0);assert.equal(ws.closeCalls,0);
    assert.equal(stream.getBook(SYMBOL)!.sequence,31);assert.equal(stream.getBook(SYMBOL)!.generation,generation);
    assert.equal(stream.getBook(symbols[1]),undefined);assert.equal(stream.status().state,'degraded');assert.equal(stream.status().freshBooks,1);
    ws.next(symbols[1]).resolve(raw(symbols[1],2));await flush();assert.ok(stream.getBook(symbols[1]));
  }finally{await stream.close();}
});

test('24 delayed first subscriptions never cause a shared restart; real socket failure still invalidates every generation',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now:1700000000000});
  const {source,ws,stream}=fixture();
  const symbols=[SYMBOL,...Array.from({length:23},(_,i)=>`QUEUED${i}/USDT:USDT`)];
  for(const symbol of symbols)source.markets[symbol]=market(symbol,1);
  try{
    stream.setSymbols(symbols);await flush();
    for(let second=0;second<15;second++){
      ws.next().resolve(raw(SYMBOL,second+1));await flush();t.mock.timers.tick(1000);
    }
    assert.equal(stream.status().reconnects,0);assert.equal(ws.closeCalls,0);assert.ok(stream.getBook(SYMBOL));
    const delayed=ws.next(symbols[1]);delayed.resolve(raw(symbols[1]));await flush();assert.ok(stream.getBook(symbols[1]));
    const late=ws.next(symbols[2]);ws.next().reject(new Error('ECONNRESET'));await flush();
    assert.equal(stream.getBook(SYMBOL),undefined);assert.equal(stream.getBook(symbols[1]),undefined);
    assert.equal(stream.status().reconnects,1);assert.equal(ws.closeCalls,1);
    late.resolve(raw(symbols[2]));await flush();assert.equal(stream.getBook(symbols[2]),undefined);
  }finally{await stream.close();}
});

test('missing sequence metadata does not erase the prior sequence ordering watermark',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now:1700000000000});
  const {ws,stream}=fixture();
  try{
    stream.setSymbols([SYMBOL]);await flush();ws.next().resolve(raw(SYMBOL,10));await flush();
    t.mock.timers.tick(1);const withoutNonce=raw();delete withoutNonce.nonce;ws.next().resolve(withoutNonce);await flush();
    t.mock.timers.tick(1);ws.next().resolve(raw(SYMBOL,9));await flush();
    assert.equal(stream.getBook(SYMBOL),undefined);assert.equal(stream.status().error,'OUT_OF_ORDER');
  }finally{await stream.close();}
});

test('stalled unsubscribe resets the public transport; late acknowledgement cannot touch the new generation',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now:1700000000000});
  const {ws,stream}=fixture();let lateAck!:()=>void;
  ws.unWatchOrderBook=()=>new Promise<void>(resolve=>{lateAck=resolve;});
  try{
    stream.setSymbols([SYMBOL,OTHER]);await flush();stream.setSymbols([SYMBOL]);await flush();
    t.mock.timers.tick(2000);await flush();assert.equal(stream.status().error,'UNSUBSCRIBE_FAILED');
    t.mock.timers.tick(250);await flush();assert.equal(stream.status().subscriptions,1);
    const latest=ws.pending.filter(p=>p.symbol===SYMBOL).at(-1)!;latest.resolve(raw());await flush();
    const generation=stream.getBook(SYMBOL)!.generation;lateAck();await flush();
    assert.equal(stream.getBook(SYMBOL)!.generation,generation);assert.equal(stream.status().state,'online');
  }finally{await stream.close();}
});

test('close cancels retry timers, ignores pending events and never reopens the public client',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now:1700000000000});
  const {ws,stream,books}=fixture();
  stream.setSymbols([SYMBOL,OTHER]);await flush();const late=ws.next(OTHER);ws.next().reject(new Error('timeout'));await flush();
  const closing=stream.close();await closing;const watches=ws.watches.length;
  late.resolve(raw(OTHER));t.mock.timers.tick(30000);await flush();stream.setSymbols([SYMBOL]);
  assert.equal(ws.watches.length,watches);assert.equal(books.length,0);assert.equal(stream.status().state,'disabled');assert.equal(stream.status().subscriptions,0);
  assert.equal(stream.getBook(OTHER),undefined);assert.equal(stream.close(),closing);
});

test('dashboard callback exceptions do not interrupt stream delivery or sequence checking',async()=>{
  const ws=new FakeWs(),stream=new RealtimePublicBooks('bybit',rest('bybit',1),{onBook:()=>{throw new Error('view failed');},onStatus:()=>{throw new Error('view failed');}},ws);
  try{
    stream.setSymbols([SYMBOL]);await flush();ws.next().resolve(raw());await flush();ws.next().resolve(raw(SYMBOL,2));await flush();
    assert.equal(stream.getBook(SYMBOL)!.sequence,2);assert.equal(stream.status().state,'online');
  }finally{await stream.close();}
});

test('the REST authenticated client cannot be injected as the public websocket client',()=>{
  const source=rest();assert.throws(()=>new RealtimePublicBooks('gate',source,{onBook:()=>{}},source),/PUBLIC_CLIENT_MUST_BE_SEPARATE/);
});

for(const id of ['binance','bybit'] as const)test(`${id} native public REST snapshot aborts a stalled response body within its own budget`,async()=>{
  const {createServer}=await import('node:http');let requests=0;
  const server=createServer((_request,response)=>{
    requests++;response.writeHead(200,{'content-type':'application/json'});response.flushHeaders();response.write('{"ok":');
    // End a failing baseline fixture too, so an omitted body budget cannot hang the test process.
    const timer=setTimeout(()=>{if(!response.destroyed)response.end('true}');},650);
    response.once('close',()=>clearTimeout(timer));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert(address&&typeof address==='object');
  const stream=new RealtimePublicBooks(id,rest(id,1),{onBook:()=>{}}),client=(stream as any).client;
  try{
    assert.equal(client.apiKey,undefined);assert.equal(client.secret,undefined);assert.equal(client.password,undefined);
    assert.equal(client.httpsProxy,undefined);assert.equal(client.socksProxy,undefined);
    await client.loadFetchImplementation();await client.loadProxyModules();client.timeout=120;
    const started=Date.now();
    await assert.rejects(client.fetch(`http://127.0.0.1:${address.port}/stalled-public-body`),(error:unknown)=>{
      assert(error instanceof ExchangeNetworkError);assert.equal(error.code,'TIMEOUT');return true;
    });
    assert.equal(requests,1,'all attempts share one exhausted body budget');
    assert(Date.now()-started<500,'headers must not end the response-body budget');
    assert.equal(stream.status().subscriptions,0,'the loopback fixture never starts a real WebSocket');
  }finally{await stream.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('native public transport preserves the REST proxy source even if the environment changes',async()=>{
  const previous=process.env.BINANCE_PROXY_URL;process.env.BINANCE_PROXY_URL='socks5://environment-only.invalid:17893';
  try{
    for(const proxy of [undefined,'http://rest-only.invalid:7890','socks5://rest-only.invalid:7891']){
      const source=rest('binance',1);
      if(proxy?.startsWith('socks'))source.socksProxy=proxy;else source.httpsProxy=proxy;
      const stream=new RealtimePublicBooks('binance',source,{onBook:()=>{}}),client=(stream as any).client;
      try{
        assert.equal(getExchangeNetworkStatus(client)?.route,proxy?'proxy':'direct');
        assert.equal(client.httpsProxy,proxy&&!proxy.startsWith('socks')?proxy:undefined);
        assert.equal(client.socksProxy,proxy?.startsWith('socks')?proxy:undefined);
        assert.equal(client.wssProxy,proxy&&!proxy.startsWith('socks')?proxy:undefined);
        assert.equal(client.wsSocksProxy,proxy?.startsWith('socks')?proxy:undefined);
        assert.equal(source.apiKey,'REST_KEY_MUST_NOT_ESCAPE');
        assert.notEqual(client.fetch,source.fetch,'public REST must keep its independent uncredentialed implementation');
      }finally{await stream.close();}
    }
  }finally{if(previous===undefined)delete process.env.BINANCE_PROXY_URL;else process.env.BINANCE_PROXY_URL=previous;}
});

test('native public transport never retries a non-GET response whose outcome is uncertain',async()=>{
  const {createServer}=await import('node:http');let requests=0;
  const server=createServer((request)=>{requests++;request.socket.destroy();});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert(address&&typeof address==='object');
  const stream=new RealtimePublicBooks('bybit',rest('bybit',1),{onBook:()=>{}}),client=(stream as any).client;
  try{
    await client.loadFetchImplementation();await client.loadProxyModules();
    await assert.rejects(client.fetch(`http://127.0.0.1:${address.port}/synthetic-write`,'POST',{},'{}'),(error:unknown)=>{
      assert(error instanceof ExchangeNetworkError);assert.equal(error.code,'NETWORK_ERROR');return true;
    });
    assert.equal(requests,1);assert.equal(client.maxRetriesOnFailure,0);assert.equal(client.options.maxRetriesOnFailure,0);
  }finally{await stream.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
