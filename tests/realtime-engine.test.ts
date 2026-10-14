import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../src/core/engine.js';
import {defaultConfig} from '../src/shared/config.js';
import type {ExchangeAdapter,ExchangeId,MarketSnapshot} from '../src/shared/types.js';
import type {Store} from '../src/core/store.js';
import {RealtimeLatency} from '../src/core/realtime-latency.js';
import {quoteIsFresh} from '../src/core/market-validity.js';
import {CcxtAdapter} from '../src/adapters/ccxt.js';

function quote(exchange:ExchangeId,offset=0):MarketSnapshot {
  const now=Date.now()+offset;
  return {exchange,base:'BTC',symbol:'BTC/USDT:USDT',source:'public',timestamp:now,observedAt:now,
    fundingObservedAt:Date.now(),bookTransport:'websocket',markPrice:100,indexPrice:100,
    fundingRate:exchange==='bybit'?.005:0,nextFundingTime:Math.floor(Date.now()/3600000)*3600000+3600000,intervalHours:8,fundingHistory:[],
    bids:[{price:exchange==='gate'?99.99:100.5,quantity:10}],asks:[{price:exchange==='gate'?100:100.51,quantity:10}],
    openInterestUsd:0,volume24hUsd:0,quantityStep:.001,minQuantity:.001,minNotional:5,contractSize:1,
    takerFeeRate:.0005,takerFeeSource:'exchange',takerFeeAt:Date.now()};
}
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
function fixture(){
  const config={...defaultConfig,mode:'live' as const,dataSource:'public' as const,entryPolicy:'aligned' as const,
    exchanges:['gate','bybit'] as ExchangeId[],symbols:['BTC'],orderNotionalUsd:100};
  const store={data:{version:1,config,positions:[],orders:[],logs:[],equity:[],killSwitch:false,fundingSeen:[]},save(){},log(){}} as unknown as Store;
  const publish=new Map<ExchangeId,(quote:MarketSnapshot)=>void>();let preparations=0,placements=0;
  const adapters=config.exchanges.map(id=>({id,startRealtime:callback=>{publish.set(id,callback);},setRealtimeBases(){},
    fetchSnapshots:async()=>[],fetchAccount:async()=>({freeUsd:1000,equityUsd:1000,positions:[]}),
    fetchFundingPayments:async()=>[],inspectTrading:async()=>{},prepareTrading:async()=>{preparations++;},
    placeOrder:async()=>{placements++;throw new Error('OFFLINE unexpected real placement');},close:async()=>{},
    reconcileOrder:async()=>{throw new Error('OFFLINE unexpected reconcile');},cancelOrder:async()=>{},
  } as ExchangeAdapter));
  const engine=new Engine(store,true,{adapterFactory:()=>adapters,liveEnvironment:{ALLOW_LIVE_TRADING:'true',LIVE_TRADING_ACK:'I_UNDERSTAND_THE_RISKS',
    GATE_API_KEY:'OFFLINE',GATE_API_SECRET:'OFFLINE',BYBIT_API_KEY:'OFFLINE',BYBIT_API_SECRET:'OFFLINE'}});
  const internals=engine as any;engine.running=true;internals.bindRealtime();
  return {engine,internals,adapters,publish,store,counts:()=>({preparations,placements})};
}
function hot(f:ReturnType<typeof fixture>){
  let opens=0;
  const id='BTC-gate-bybit',now=Date.now(),quotes=[quote('gate'),quote('bybit')];
  // Obtain confirmation from actual public funding samples before isolating the scheduling callback.
  // The latency fixture never grants a synthesized confirmation DTO or submits a financial request.
  for(const age of [180_000,135_000,90_000,45_000,0]){
    const at=now-age;
    f.engine.snapshots=quotes.map(value=>({...value,timestamp:at,observedAt:at,fundingObservedAt:at,takerFeeAt:at}));
    f.engine.health=quotes.map(value=>({exchange:value.exchange,status:'online',latencyMs:0,lastSuccess:at,accountStatus:'ready',accountUpdatedAt:at}));
    for(const value of quotes)f.engine.accounts.set(value.exchange,{freeUsd:1000,equityUsd:1000,positions:[]});
    f.internals.detailedOpportunities(at);
  }
  const eligible=f.engine.currentOpportunities().find(value=>value.id===id)!;
  assert.ok(eligible);assert.equal(eligible.eligible,true);assert.equal(eligible.entryReady,true);
  assert.equal(eligible.fundingEntryStability?.status,'confirmed');
  assert.equal(eligible.fundingEntryStability!.sampleCount,1);assert.equal(eligible.fundingEntryStability!.observedSpanMs,0);
  // The scheduling cases still start with no received WS books, so an intentionally
  // skewed first event is not hidden behind the fixture's newer priming book.
  f.engine.snapshots=[];
  f.internals.detailedOpportunities=()=>[eligible];f.internals.scheduleRealtimeWarmup=()=>{};
  f.internals.openInternal=async()=>{opens++;await pause(15);};f.engine.autoEnabled=true;
  f.internals.realtimePrepared.set(id,{generation:f.internals.startGeneration,config:f.engine.config,financialEpoch:f.internals.financialEpoch,context:{
    generation:f.internals.startGeneration,ensure(){},stage(){},tradingPrepared:true,
    preflight:{checkedAt:Date.now(),accounts:new Map(),symbols:new Map()}}});
  return {opens:()=>opens,eligible};
}

test('WS books publish during an occupied transaction queue; manual display never starts a strategy',async()=>{
  const f=fixture();let release!:()=>void;
  const occupied=f.engine.exclusive(()=>new Promise<void>(resolve=>{release=resolve;}));await pause(0);
  try{
    f.publish.get('gate')!(quote('gate'));f.publish.get('bybit')!(quote('bybit'));await pause(80);
    assert.equal(f.engine.snapshots.length,2);assert.equal(f.engine.snapshot('gate','BTC')!.bookTransport,'websocket');
    assert.equal(f.engine.autoEnabled,false);assert.deepEqual(f.counts(),{preparations:0,placements:0});
  }finally{release();await occupied;await f.engine.stop();}
});

test('prepared fresh dual WS quotes trigger one entry without a polling tick, deduplicating bursts',async()=>{
  const f=fixture(),h=hot(f);
  try{
    f.publish.get('gate')!(quote('gate'));f.publish.get('bybit')!(quote('bybit'));
    for(let i=0;i<12;i++)f.internals.onRealtimeSignal();await pause(35);
    assert.equal(h.opens(),1);assert.equal(f.store.data.orders.length,0);
  }finally{await f.engine.stop();}
});

test('slow routine REST polling does not delay a ready WS purchase in the financial queue',async()=>{
  const f=fixture(),h=hot(f);let release!:()=>void;
  const blocked=new Promise<MarketSnapshot[]>(resolve=>{release=()=>resolve([]);});
  f.adapters[0].fetchSnapshots=()=>blocked;
  f.internals.openInternal=async()=>{f.engine.autoEnabled=false;(h as any).sawImmediate=true;};
  const tick=f.engine.tick();
  try{
    f.publish.get('gate')!(quote('gate'));f.publish.get('bybit')!(quote('bybit'));f.internals.onRealtimeSignal();await pause(20);
    assert.equal((h as any).sawImmediate,true,'entry must run before the stalled REST batch finishes');
  }finally{release();await tick;await f.engine.stop();}
});

test('routine account GET crossing a financial epoch cannot overwrite newer account evidence',async()=>{
  const f=fixture();let release!:(value:any)=>void;
  f.engine.accounts.set('gate',{freeUsd:777,equityUsd:777,positions:[]});
  f.adapters[0].fetchAccount=()=>new Promise(resolve=>{release=resolve;});
  const tick=f.engine.tick();await pause(0);
  try{
    f.internals.financialEpoch++;release({freeUsd:1,equityUsd:1,positions:[]});await tick;
    assert.equal(f.engine.accounts.get('gate')!.freeUsd,777);
  }finally{release?.({freeUsd:1,equityUsd:1,positions:[]});await f.engine.stop();}
});

test('queued push signal rechecks generation, current price, automatic economics and quote age before any order',async()=>{
  for(const kind of ['pause','price','net','edge','stale'] as const){
    const f=fixture(),h=hot(f);let release!:()=>void;
    const occupied=f.engine.exclusive(()=>new Promise<void>(resolve=>{release=resolve;}));await pause(0);
    try{
      f.publish.get('gate')!(quote('gate'));f.publish.get('bybit')!(quote('bybit'));f.internals.onRealtimeSignal();
      if(kind==='pause'){f.internals.startGeneration++;f.engine.autoEnabled=false;}
      if(kind==='price')h.eligible.eligible=false;
      if(kind==='net')h.eligible.combinedExpectedNetUsd=0;
      if(kind==='edge')h.eligible.entryPriceEdgeBps=20;
      if(kind==='stale')f.engine.snapshots=f.engine.snapshots.map(s=>({...s,observedAt:Date.now()-800}));
      release();await occupied;await pause(20);assert.equal(h.opens(),0,kind);assert.equal(f.counts().placements,0);
    }finally{release();await f.engine.stop();}
  }
});

test('WS automatic selection rejects manual-ready candidates without both requested advantages',async()=>{
  for(const kind of ['net','edge','missing-batch'] as const){
    const f=fixture(),h=hot(f);
    if(kind==='net')h.eligible.combinedExpectedNetUsd=-.01;
    if(kind==='edge')h.eligible.entryPriceEdgeBps=20;
    if(kind==='missing-batch')delete (h.eligible as any).entryBatch;
    try{
      f.publish.get('gate')!(quote('gate'));f.publish.get('bybit')!(quote('bybit'));
      f.internals.onRealtimeSignal();await pause(20);
      assert.equal(h.eligible.eligible,true,'manual eligibility is independent');
      assert.equal(h.opens(),0,kind);assert.equal(f.counts().placements,0);
    }finally{await f.engine.stop();}
  }
});

test('fast path rejects cross-venue quote skew, REST-only quotes and expired account preparations',async()=>{
  for(const kind of ['skew','rest','proof'] as const){
    const f=fixture(),h=hot(f);
    try{
      f.publish.get('gate')!(quote('gate'));f.publish.get('bybit')!(quote('bybit',kind==='skew'?-400:0));
      if(kind==='rest')f.engine.snapshots[0].bookTransport='rest';
      if(kind==='proof')for(const proof of f.internals.realtimePrepared.values())proof.context.preflight.checkedAt=Date.now()-8001;
      f.internals.onRealtimeSignal();await pause(20);assert.equal(h.opens(),0,kind);
    }finally{await f.engine.stop();}
  }
});

test('cold positive signal never performs a delayed purchase by itself',async()=>{
  const f=fixture(),h=hot(f);f.internals.realtimePrepared.clear();
  try{f.publish.get('gate')!(quote('gate'));f.publish.get('bybit')!(quote('bybit'));f.internals.onRealtimeSignal();await pause(30);
    assert.equal(h.opens(),0);assert.equal(f.counts().placements,0);
  }finally{await f.engine.stop();}
});

for(const route of ['push','tick'] as const)test(`a completed warm proof from before non-Maker financial activity is not reused by ${route}`,async()=>{
  const f=fixture(),h=hot(f),proof=f.internals.realtimePrepared.get(h.eligible.id);
  proof.context.preflight.accounts=new Map([['gate',{freeUsd:1000,equityUsd:1000,positions:[]}],['bybit',{freeUsd:1000,equityUsd:1000,positions:[]}]]);
  let attempts=0,reused=0;
  // Only the warm context can publish these older native balances. A polling entry
  // still has its ordinary cold path; the push route waits for a new warm proof.
  f.internals.openInternal=async(_id:string,_automatic:boolean,context:any)=>{
    attempts++;if(context?.preflight){reused++;for(const [exchange,account] of context.preflight.accounts)f.engine.accounts.set(exchange,account);}
  };
  try{
    f.publish.get('gate')!(quote('gate'));f.publish.get('bybit')!(quote('bybit'));
    f.engine.accounts.set('gate',{freeUsd:777,equityUsd:777,positions:[]});
    // Manual/non-Maker reductions advance this barrier without Maker's map clear.
    f.internals.financialEpoch++;
    assert.equal(f.internals.realtimePrepared.size,1,'the completed proof remains present so the consumption guard is exercised');
    if(route==='push'){f.internals.onRealtimeSignal();await pause(20);assert.equal(attempts,0);}
    else{
      for(const adapter of f.adapters)adapter.fetchAccount=async()=>({freeUsd:777,equityUsd:777,positions:[]});
      await f.engine.tick();assert.equal(attempts,1,'the polling cold path remains available');
    }
    assert.equal(reused,0);assert.equal(f.engine.accounts.get('gate')!.freeUsd,777);
    assert.equal(f.counts().placements,0);
  }finally{await f.engine.stop();}
});

test('fresh WS book cannot make old funding/index metadata fresh, including REST fallback metadata',()=>{
  for(const transport of ['websocket','rest'] as const){
    const q={...quote('gate'),bookTransport:transport,fundingObservedAt:Date.now()-30001};
    assert.equal(quoteIsFresh(q,defaultConfig),false);
    q.fundingObservedAt=Date.now()+10000;assert.equal(quoteIsFresh(q,defaultConfig),false);
  }
});

test('execution book refresh uses WS cache or an isolated depth GET; no ticker/funding/OI await',async()=>{
  let requests=0;const seed={...quote('gate'),bookTransport:'rest' as const};
  const market={symbol:seed.symbol,id:'BTC_USDT',base:'BTC',quote:'USDT',settle:'USDT',active:true,swap:true,linear:true,contractSize:1};
  const client={markets:{[seed.symbol]:market},loadMarkets:async()=>{},market:()=>market,
    fetchOrderBook:async()=>{requests++;return {bids:[[99.99,10]],asks:[[100,10]]};},
    fetchTicker:async()=>{throw new Error('slow ticker called');},fetchFundingRate:async()=>{throw new Error('slow funding called');}};
  const adapter=new CcxtAdapter('gate',{...defaultConfig,mode:'paper'},client);adapter.seedRealtimeSnapshot(seed);
  const rest=await adapter.fetchExecutionSnapshots(['BTC']);assert.equal(rest[0].bookTransport,'rest');assert.equal(requests,1);
  (adapter as any).publicBooks={getBook:()=>({exchange:'gate',symbol:seed.symbol,bids:[{price:99.99,quantity:10}],asks:[{price:100,quantity:10}],receivedAt:Date.now(),generation:1})};
  const pushed=await adapter.fetchExecutionSnapshots(['BTC']);assert.equal(pushed[0].bookTransport,'websocket');assert.equal(requests,1);
});

test('latency counts confirmed paired batches only and leaves real trade measurements absent before any fill',()=>{
  const meter=new RealtimeLatency();assert.deepEqual(meter.status(),{samples:0});
  for(const [phase,at] of [['first-submit',1000],['first-confirmed',1110],['hedge-submit',1120],['hedge-confirmed',1290],['matched',1295]] as const)
    meter.observe({positionId:'offline',base:'BTC',phase,at,batch:1});
  assert.deepEqual(meter.status(),{samples:1,firstLegMs:110,hedgeMs:170,matchedMs:295,p95HedgeMs:170,p95MatchedMs:295});
  meter.observe({positionId:'bad',base:'BTC',phase:'finished',at:1400});assert.equal(meter.status().samples,1);
});

test('REST fallback missing actual cash fee stays unresolved instead of estimating from configuration',async()=>{
  const adapter=new CcxtAdapter('binance',{...defaultConfig,mode:'paper'},{has:{fetchMyTrades:false}});
  const request={base:'BTC',symbol:'BTC/USDT:USDT',clientOrderId:'offline-fee',side:'buy',reduceOnly:false,quantity:1,limitPrice:100};
  const raw={id:'offline',status:'closed',filled:1,average:100};
  const missing=await (adapter as any).orderResult(raw,request,{contractSize:1,base:'BTC'});
  assert.equal(missing.status,'unknown');assert.equal(Number.isFinite(missing.feeUsd),false);
  const mnt=await (adapter as any).orderResult({...raw,fee:{currency:'MNT',cost:.01}},request,{contractSize:1,base:'BTC'});
  assert.equal(mnt.status,'unknown');
  const actual=await (adapter as any).orderResult({...raw,fee:{currency:'USDT',cost:.0495}},request,{contractSize:1,base:'BTC'});
  assert.equal(actual.status,'filled');assert.equal(actual.feeUsd,.0495);
});

test('an initial market metadata failure retries WS initialization on a later successful REST read',async()=>{
  let calls=0;const client={markets:{},loadMarkets:async()=>{if(++calls===1)throw new Error('OFFLINE first market read failed');}};
  const adapter=new CcxtAdapter('bybit',{...defaultConfig,mode:'paper',dataSource:'public'},client);
  try{
    adapter.startRealtime(()=>{});await pause(10);assert.equal((adapter as any).publicBooks,undefined);
    await assert.rejects(adapter.fetchSnapshots([]),/no requested active/);await pause(10);
    assert.ok((adapter as any).publicBooks,'successful metadata read must restart the public stream lifecycle');
  }finally{await adapter.close();}
});
