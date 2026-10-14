import test from 'node:test';
import assert from 'node:assert/strict';
import {CcxtAdapter} from '../src/adapters/ccxt.js';
import {configureExchangeTransport,ExchangeNetworkError,withExchangeRequestContext,withoutExchangeRequestContext} from '../src/adapters/network.js';
import {PublicFundingMonitor} from '../src/core/public-funding-monitor.js';
import {Engine} from '../src/core/engine.js';
import {defaultConfig} from '../src/shared/config.js';
import type {AppConfig,MarketSnapshot} from '../src/shared/types.js';

const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const wait=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
function fixture(options:{holdTickers?:boolean;holdMetadata?:boolean}={}){
  const bases=Array.from({length:8},(_,index)=>`DEADLINE${index}`),markets=Object.fromEntries(bases.map(base=>[`${base}/USDT:USDT`,{
    id:`${base}USDT`,symbol:`${base}/USDT:USDT`,base,quote:'USDT',settle:'USDT',active:true,swap:true,linear:true,
    contractSize:1,precision:{amount:1,price:.1},limits:{amount:{min:1},cost:{min:1}},info:{fundingInterval:480},
  }]));
  const config:AppConfig={...defaultConfig,mode:'paper',dataSource:'public',feeOnly:true,paperFeeOnly:true,maxSnapshotAgeMs:30000};
  const tickerCalls:{symbol:string;startedAt:number}[]=[],pendingTickers:(()=>void)[]=[],pendingMetadata:(()=>void)[]=[];
  let metadataReads=0,bookReads=0,privateCalls=0;
  const privateRead=async()=>{privateCalls++;throw new Error('Unexpected private API in a public-only deadline fixture');};
  const client:any={precisionMode:4,options:{},has:{},markets,market:(symbol:string)=>markets[symbol],
    loadMarkets:async()=>{metadataReads++;if(options.holdMetadata)await new Promise<void>(resolve=>pendingMetadata.push(resolve));return markets;},
    fetchTicker:async(symbol:string)=>{
      tickerCalls.push({symbol,startedAt:Date.now()});
      // A native/stub request can ignore cancellation. Its promise must remain tracked until it actually settles.
      if(options.holdTickers)await new Promise<void>(resolve=>pendingTickers.push(resolve));
      return {timestamp:Date.now(),quoteVolume:1e6,info:{markPrice:100,indexPrice:100}};
    },
    parseFundingRate:()=>({fundingRate:.001,fundingTimestamp:Date.now()+300000,interval:'8h',markPrice:100,indexPrice:100,info:{fundingIntervalHour:'8'}}),
    fetchOrderBook:async()=>{bookReads++;return {timestamp:Date.now(),bids:[[99,10]],asks:[[101,10]]};},
    privateGetV5AccountFeeRate:privateRead,fetchTradingFee:privateRead,fetchBalance:privateRead,fetchPositions:privateRead,
    fetchFundingRateHistory:async()=>[{timestamp:Date.now()-16*3600000,fundingRate:.0008},{timestamp:Date.now()-8*3600000,fundingRate:.0009}],
  };
  const adapter=new CcxtAdapter('bybit',config,client,true);
  const releaseTickers=()=>{for(const release of pendingTickers.splice(0))release();};
  const releaseOneTicker=()=>{pendingTickers.shift()?.();};
  const releaseMetadata=()=>{for(const release of pendingMetadata.splice(0))release();};
  // Finish a failing baseline too: without the guard, releasing one pair starts the next pair.
  const drain=async()=>{for(let i=0;i<8;i++){releaseMetadata();releaseTickers();await flush();}};
  return {adapter,config,bases,client,tickerCalls,releaseTickers,releaseOneTicker,releaseMetadata,drain,
    metadataReads:()=>metadataReads,bookReads:()=>bookReads,privateCalls:()=>privateCalls};
}
function isTimeout(error:unknown):boolean{
  assert(error instanceof ExchangeNetworkError);assert.equal(error.code,'TIMEOUT');return true;
}
function monitorFor(f:ReturnType<typeof fixture>,deadlineMs=20){
  return new PublicFundingMonitor({config:()=>f.config,candidates:()=>[],snapshots:()=>[],protectedBases:()=>new Set(),
    prefer:()=>false,adapters:()=>[],publish:async()=>{},deadlineMs});
}

test('expired or already-aborted public read never begins shared metadata or per-symbol calls',async()=>{
  for(const context of [{deadlineAt:Date.now()-1},{signal:AbortSignal.abort()}]){
    const f=fixture();
    try{
      await assert.rejects(f.adapter.fetchSnapshots(f.bases,context),isTimeout);
      assert.equal(f.metadataReads(),0);assert.equal(f.tickerCalls.length,0);assert.equal(f.bookReads(),0);assert.equal(f.privateCalls(),0);
    }finally{await f.adapter.close();}
  }
});

test('one public deadline stops remaining six symbols even when the first two native reads ignore abort',async()=>{
  const f=fixture({holdTickers:true}),deadlineAt=Date.now()+20;
  let settled=false;
  const raw=f.adapter.fetchSnapshots(f.bases,{deadlineAt});
  void raw.then(()=>{settled=true;},()=>{settled=true;});const rejected=assert.rejects(raw,isTimeout);
  try{
    await flush();assert.equal(f.tickerCalls.length,2);await wait(30);
    assert.equal(settled,false,'an outer deadline cannot pretend a native promise has actually ended');
    await f.drain();await rejected;
    assert.equal(f.tickerCalls.length,2,'the expired first pair must not start the other six symbols');
    assert.equal(f.privateCalls(),0);
  }finally{await f.drain();await f.adapter.close();}
});

test('metadata that finishes after the original public budget cannot start a new ticker or depth request',async()=>{
  const f=fixture({holdMetadata:true});
  const raw=f.adapter.fetchSnapshots(f.bases,{deadlineAt:Date.now()+20});
  const rejected=assert.rejects(raw,isTimeout);
  try{
    await flush();assert.equal(f.metadataReads(),1);await wait(30);f.releaseMetadata();await rejected;
    assert.equal(f.tickerCalls.length,0);assert.equal(f.bookReads(),0);assert.equal(f.privateCalls(),0);
  }finally{await f.drain();await f.adapter.close();}
});

test('caller cancellation ends its selected public batch without cancelling another read on the same client',async()=>{
  const f=fixture({holdTickers:true}),controller=new AbortController();
  const raw=f.adapter.fetchSnapshots(f.bases,{signal:controller.signal});
  const rejected=assert.rejects(raw,isTimeout);
  try{
    await flush();assert.equal(f.tickerCalls.length,2);controller.abort();
    const independent=f.adapter.fetchSnapshots([f.bases[7]]);await flush();assert.equal(f.tickerCalls.length,3);
    await f.drain();await rejected;const rows=await independent;
    assert.equal(f.tickerCalls.length,3,'only the independent symbol may be added after cancellation');
    assert.deepEqual(rows.map(row=>row.base),[f.bases[7]]);assert.equal(f.privateCalls(),0);
  }finally{await f.drain();await f.adapter.close();}
});

test('fast public reads retain genuine funding observations and never query private fees',async()=>{
  const f=fixture(),started=Date.now();
  try{
    const rows=await f.adapter.fetchSnapshots(f.bases,{deadlineAt:started+5000});
    const finished=Date.now();assert.deepEqual(rows.map(row=>row.base),f.bases);
    assert.equal(f.tickerCalls.length,8);assert.equal(f.bookReads(),8);assert.equal(f.privateCalls(),0);
    for(const row of rows){
      assert(row.fundingObservedAt!==undefined&&row.fundingObservedAt>=started&&row.fundingObservedAt<=finished);
      assert(row.observedAt!==undefined&&row.observedAt>=started&&row.observedAt<=finished);
      assert.equal(row.bookTransport,'rest');assert.equal(row.fundingRate,.001);
    }
  }finally{await f.adapter.close();}
});

test('the default public API without a caller context still finishes every requested symbol',async()=>{
  const f=fixture({holdTickers:true}),raw=f.adapter.fetchSnapshots(f.bases);
  try{
    await flush();await wait(30);await f.drain();const rows=await raw;
    assert.equal(f.tickerCalls.length,8);assert.deepEqual(rows.map(row=>row.base),f.bases);assert.equal(f.privateCalls(),0);
  }finally{await f.drain();await f.adapter.close();}
});

test('monitor timeout preserves pending until the actual adapter settles, then allows one fresh batch',async()=>{
  const f=fixture({holdTickers:true}),monitor=monitorFor(f);
  const timing:any={exchange:'bybit',startedAt:Date.now(),outcome:'reading'};
  const first=(monitor as any).read(f.adapter,f.bases,f.config,timing) as Promise<MarketSnapshot[]>;
  try{
    await assert.rejects(first,/Public monitoring deadline/);assert.equal(timing.outcome,'deadline');assert.equal(f.tickerCalls.length,2);
    assert.equal((monitor as any).pending.has(f.adapter),true);
    const secondTiming:any={exchange:'bybit',startedAt:Date.now(),outcome:'reading'};
    assert.deepEqual(await (monitor as any).read(f.adapter,f.bases,f.config,secondTiming),[]);
    assert.equal(secondTiming.outcome,'already-in-flight');assert.equal(f.tickerCalls.length,2);
    await f.drain();assert.equal((monitor as any).pending.has(f.adapter),false);
    assert.equal(f.tickerCalls.length,2,'the late native settlement must not continue the expired eight-symbol plan');
    const freshTiming:any={exchange:'bybit',startedAt:Date.now(),outcome:'reading'};
    const fresh=(monitor as any).read(f.adapter,[f.bases[7]],f.config,freshTiming) as Promise<MarketSnapshot[]>;
    await flush();f.releaseTickers();const rows=await fresh;
    assert.deepEqual(rows.map(row=>row.base),[f.bases[7]]);assert.equal(freshTiming.outcome,'returned');assert.equal(f.privateCalls(),0);
  }finally{await f.drain();await f.adapter.close();await monitor.stop();}
});

test('foreground engine deadline prevents leftover symbol reads and keeps its original in-flight guard',async()=>{
  const f=fixture({holdTickers:true});
  const owner:any={config:f.config,options:{publicSnapshotDeadlineMs:20},publicSnapshotRequests:new Map()};
  const acquire=(Engine.prototype as any).acquireSnapshots.bind(owner);
  try{
    await assert.rejects(acquire(f.adapter,f.bases),/Public market snapshot timeout/);
    assert.equal(f.tickerCalls.length,2);assert.equal(owner.publicSnapshotRequests.has(f.adapter.id),true);
    await assert.rejects(acquire(f.adapter,f.bases),/already in progress/);assert.equal(f.tickerCalls.length,2);
    await f.drain();assert.equal(owner.publicSnapshotRequests.has(f.adapter.id),false);
    assert.equal(f.tickerCalls.length,2);assert.equal(f.privateCalls(),0);
  }finally{await f.drain();await f.adapter.close();}
});

for(const owner of ['monitor','engine'] as const)test(`${owner} retains pending when one expired worker settles but another native read is still unresolved`,async()=>{
  const f=fixture({holdTickers:true}),monitor=monitorFor(f);
  const foreground:any={config:f.config,options:{publicSnapshotDeadlineMs:20},publicSnapshotRequests:new Map()};
  const acquire=owner==='monitor'
    ?()=> (monitor as any).read(f.adapter,f.bases,f.config,{exchange:'bybit',startedAt:Date.now(),outcome:'reading'}) as Promise<MarketSnapshot[]>
    :()=> (Engine.prototype as any).acquireSnapshots.call(foreground,f.adapter,f.bases) as Promise<MarketSnapshot[]>;
  const pending=()=>owner==='monitor'?(monitor as any).pending.has(f.adapter):foreground.publicSnapshotRequests.has(f.adapter.id);
  try{
    await assert.rejects(acquire(),owner==='monitor'?/Public monitoring deadline/:/Public market snapshot timeout/);
    assert.equal(f.tickerCalls.length,2);assert.equal(pending(),true);
    f.releaseOneTicker();await flush();
    assert.equal(pending(),true,'one expired worker rejecting does not prove the other native request has actually settled');
    if(owner==='monitor')assert.deepEqual(await acquire(),[]);
    else await assert.rejects(acquire(),/already in progress/);
    assert.equal(f.tickerCalls.length,2,'the unresolved original worker must prevent a second selected batch');
    f.releaseTickers();await flush();assert.equal(pending(),false);
    assert.equal(f.privateCalls(),0);
  }finally{await f.drain();await f.adapter.close();await monitor.stop();}
});

async function nativeBackgroundFixture(stallBody=false,id:'bybit'|'binance'='bybit'){
  const {createServer}=await import('node:http'),{default:ccxt}=await import('ccxt');
  const f=fixture();let requests=0;
  const server=createServer((_request,response)=>{
    requests++;response.writeHead(200,{'content-type':'application/json'});
    if(!stallBody){response.end('{"retCode":0,"result":{"ok":true}}');return;}
    response.flushHeaders();response.write('{"retCode":0,"result":');
    const timer=setTimeout(()=>{if(!response.destroyed)response.end('{"ok":true}}');},1000);
    response.once('close',()=>clearTimeout(timer));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert(address&&typeof address==='object');
  // Real CCXT native HTTP, with only public metadata/ticker/depth methods replaced by local observations.
  const Constructor=id==='binance'?ccxt.binanceusdm:ccxt.bybit;
  const client:any=new Constructor({enableRateLimit:false,has:{fetchCurrencies:false}});
  Object.assign(client,f.client);
  // The optional-OI case exercises the real Binance branch without contacting its funding endpoints.
  if(id==='binance'){
    client.fetchFundingRate=async()=>client.parseFundingRate();client.fapiPublicGetFundingInfo=async()=>[];
  }
  configureExchangeTransport(client,id,{});
  await client.loadFetchImplementation();await client.loadProxyModules();client.timeout=stallBody?80:500;
  const adapter=new CcxtAdapter(id,f.config,client);
  let release!:()=>void,background:Promise<{value?:any;error?:unknown}>|undefined;
  const held=new Promise<void>(resolve=>{release=resolve;});
  const start=()=>{
    background??=held.then(()=>client.fetch(`http://127.0.0.1:${address.port}/background-lifetime`))
      .then((value:any)=>({value}),(error:unknown)=>({error}));
    return background;
  };
  return {f,adapter,client,start,release,background:()=>background,requests:()=>requests,
    close:async()=>{release();await background;await adapter.close();await f.adapter.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}

for(const kind of ['stream','history','symbols'] as const)test(`${kind} background registration keeps its own lifetime after the public deadline and cancellation`,async()=>{
  const f=await nativeBackgroundFixture(),controller=new AbortController();
  if(kind==='stream'){
    (f.adapter as any).realtimePublish=()=>{};f.adapter.startRealtime=()=>{};(f.adapter as any).startPrivateRealtime=f.start;
  }else if(kind==='history')(f.adapter as any).warmHistory=f.start;
  else (f.adapter as any).syncRealtimeSymbols=f.start;
  try{
    const deadlineAt=Date.now()+50,rows=await f.adapter.fetchSnapshots([f.f.bases[0]],{deadlineAt,signal:controller.signal});
    assert.equal(rows.length,1);assert(f.background());controller.abort();await wait(80);assert(Date.now()>deadlineAt);
    f.release();const background=await f.background()!;
    assert.equal(background.error,undefined);assert.equal(background.value?.result?.ok,true);
    assert.equal(f.requests(),1,'a legitimate background read must enter its independent native transport');
    assert.equal(f.client.timeout,500,'detaching a public batch does not change the normal HTTP timeout');
    assert.equal(f.f.privateCalls(),0);
  }finally{await f.close();}
});

test('a detached background native body read still obeys its own normal HTTP budget',async()=>{
  const f=await nativeBackgroundFixture(true);
  (f.adapter as any).realtimePublish=()=>{};f.adapter.startRealtime=()=>{};(f.adapter as any).startPrivateRealtime=f.start;
  try{
    const deadlineAt=Date.now()+50,rows=await f.adapter.fetchSnapshots([f.f.bases[0]],{deadlineAt});assert.equal(rows.length,1);
    await wait(80);assert(Date.now()>deadlineAt);const started=Date.now();f.release();const background=await f.background()!;
    assert(isTimeout(background.error));assert.equal(f.requests(),1,'the expired public deadline must not preempt a background read before it starts');
    assert(Date.now()-started<800,'the background HTTP body retains the native 80ms total budget');
    assert.equal(f.client.timeout,80);assert.equal(f.f.privateCalls(),0);
  }finally{await f.close();}
});

test('nested empty read contexts retain their parent deadline while detaching only a background callback',async()=>{
  let nativeCalls=0;const client:any={fetch:async()=>{nativeCalls++;return {ok:true};}};
  configureExchangeTransport(client,'bybit',{});
  const controller=new AbortController();
  await withExchangeRequestContext(client,{deadlineAt:Date.now()+500,signal:controller.signal},async()=>{
    controller.abort();
    await assert.rejects(withExchangeRequestContext(client,{},()=>client.fetch('https://fixture.invalid/private-read')),isTimeout);
    assert.equal(nativeCalls,0,'an empty nested context cannot override the parent cancellation');
    assert.deepEqual(await withoutExchangeRequestContext(client,()=>client.fetch('https://fixture.invalid/background-read')),{ok:true});
    assert.equal(nativeCalls,1);
    await assert.rejects(client.fetch('https://fixture.invalid/private-read'),isTimeout);
    assert.equal(nativeCalls,1,'the parent read must remain cancelled after its detached callback returns');
  });
  assert.deepEqual(await client.fetch('https://fixture.invalid/independent-read'),{ok:true});assert.equal(nativeCalls,2);
});

test('optional open interest retains its own background lifetime and 60-second backoff after a public batch',async()=>{
  const f=await nativeBackgroundFixture(false,'binance'),controller=new AbortController();let oiReads=0;
  f.client.fetchOpenInterest=async()=>{
    oiReads++;const background=await f.start();if(background.error)throw background.error;
    return {openInterestValue:1e6};
  };
  try{
    const deadlineAt=Date.now()+50,rows=await f.adapter.fetchSnapshots([f.f.bases[0]],{deadlineAt,signal:controller.signal});
    assert.equal(rows.length,1);assert.equal(oiReads,1);assert(f.background());controller.abort();await wait(80);
    f.release();const background=await f.background()!;await flush();
    assert.equal(background.error,undefined);assert.equal(background.value?.result?.ok,true);assert.equal(f.requests(),1);
    const originalAttempt=(f.adapter as any).optionalOi.get(rows[0].symbol).attemptedAt;
    const followup=await f.adapter.fetchSnapshots([f.f.bases[0]]);
    assert.equal(followup[0].openInterestUsd,1e6);assert.equal(oiReads,1,'normal followup must retain the original one-minute OI backoff');
    assert.equal((f.adapter as any).optionalOi.get(rows[0].symbol).attemptedAt,originalAttempt);assert.equal(f.f.privateCalls(),0);
  }finally{await f.close();}
});

test('optional open interest keeps its own body timeout and original failed-read backoff',async()=>{
  const f=await nativeBackgroundFixture(true,'binance');let oiReads=0;
  f.client.fetchOpenInterest=async()=>{
    oiReads++;const background=await f.start();if(background.error)throw background.error;
    return {openInterestValue:1e6};
  };
  try{
    const rows=await f.adapter.fetchSnapshots([f.f.bases[0]],{deadlineAt:Date.now()+50});assert.equal(rows.length,1);
    const originalAttempt=(f.adapter as any).optionalOi.get(rows[0].symbol).attemptedAt;
    await wait(80);f.release();const background=await f.background()!;await flush();
    assert(isTimeout(background.error));assert.equal(f.requests(),1,'normal background HTTP starts before its own body timeout');
    assert.equal((f.adapter as any).optionalOi.get(rows[0].symbol).pending,false);
    const followup=await f.adapter.fetchSnapshots([f.f.bases[0]]);assert.equal(followup.length,1);
    assert.equal(Number.isFinite(followup[0].openInterestUsd),false,'a failed optional observation cannot become zero OI');
    assert.equal(oiReads,1,'a failed optional observation keeps its one-minute retry backoff');
    assert.equal((f.adapter as any).optionalOi.get(rows[0].symbol).attemptedAt,originalAttempt);assert.equal(f.f.privateCalls(),0);
  }finally{await f.close();}
});
