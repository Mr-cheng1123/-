import assert from 'node:assert/strict';
import test from 'node:test';
import {setImmediate as immediate} from 'node:timers/promises';
import {Engine} from '../src/core/engine.js';
import {quoteIsFresh} from '../src/core/market-validity.js';
import type {ExchangeAdapter,MarketSnapshot,Position} from '../src/shared/types.js';
import {fixture} from './external-exposure-reduction-fixture.js';

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return {promise,resolve};}
async function flush(){for(let turn=0;turn<8;turn++)await immediate();}
type Internals={refreshAdapter:(adapter:ExchangeAdapter,bases:string[],includeAccount:boolean)=>Promise<boolean>;
  realtimeProfitCandidate:(p:Position)=>boolean;unavailableSnapshots:Set<string>;publicSnapshotRequests:Map<string,Promise<MarketSnapshot[]>>};
function fallbackFixture(){
  const f=fixture(),held=deferred<MarketSnapshot[]>(),adapters=(['bitget','gate'] as const).map(exchange=>f.options.adapter(exchange));
  Object.assign(f.store.data.config,{entryPolicy:'aligned',holdMode:'adaptive',exchanges:['bitget','gate'],symbols:['DOS'],
    profitExitExecutionMode:'ioc',minExitProfitBps:10,feeRebatePct:{gate:70,bitget:50}});
  let privateFees=0,posts=0;const feeObservedAt=Date.now();
  for(const adapter of adapters){
    const book=f.books.get(adapter.id)!;
    Object.assign(book,{bookTransport:'websocket',observedAt:Date.now(),fundingObservedAt:Date.now()});
    if(adapter.id==='bitget'){book.bids=[{price:1.02,quantity:1000}];book.asks=[{price:1.03,quantity:1000}];}
    else {book.bids=[{price:1.005,quantity:1000}];book.asks=[{price:1.01,quantity:1000}];}
    adapter.getExecutionSnapshot=base=>base==='DOS'?f.books.get(adapter.id):undefined;
    adapter.cachedTradingFee=()=>({source:'exchange',symbol:book.symbol,takerRate:.0005,takerFeeRate:.0005,
      takerFeeSource:'exchange',takerFeeAt:feeObservedAt,observedAt:feeObservedAt}) as ReturnType<NonNullable<ExchangeAdapter['cachedTradingFee']>>;
    adapter.fetchSnapshots=async()=>held.promise;
    adapter.fetchTradingFee=async()=>{privateFees++;throw new Error('Offline observation must not fetch private fees');};
    adapter.placeOrder=async()=>{posts++;throw new Error('Offline diagnostic must not submit an order');};
    adapter.close=async()=>{};
  }
  const engine=new Engine(f.store,true,{adapterFactory:()=>adapters,publicSnapshotDeadlineMs:20,liveEnvironment:{
    ALLOW_LIVE_TRADING:'true',LIVE_TRADING_ACK:'I_UNDERSTAND_THE_RISKS',BITGET_API_KEY:'OFFLINE',BITGET_API_SECRET:'OFFLINE',
    BITGET_PASSPHRASE:'OFFLINE',GATE_API_KEY:'OFFLINE',GATE_API_SECRET:'OFFLINE'}});
  engine.running=true;f.source.status='open';f.source.entryPolicy='aligned';f.source.profitExitNotionalUsd=100;
  for(const leg of [f.source.long,f.source.short]){leg.fundingObservedSince=f.source.openedAt;leg.fundingObservedAt=Date.now();}
  engine.snapshots=[...f.books.values()].map(book=>structuredClone(book));
  for(const health of engine.health){health.status='online';health.accountStatus='ready';health.accountUpdatedAt=Date.now();}
  const internal=engine as unknown as Internals,adapter=adapters[0];
  return {...f,engine,internal,adapter,held,privateFees:()=>privateFees,posts:()=>posts,
    cleanup:async()=>{held.resolve([]);await flush();await engine.stop();f.cleanup();}};
}

test('a real public batch timeout keeps verified same-base fresh WS health degraded and permits its eligible profit preview',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1700000000000});const f=fallbackFixture();
  try{assert.equal(f.internal.realtimeProfitCandidate(f.source),true,'the pair is profitable before a separate REST batch times out');
    const pending=f.internal.refreshAdapter(f.adapter,['DOS'],false);await flush();t.mock.timers.tick(20);assert.equal(await pending,false);
    const health=f.engine.health.find(row=>row.exchange===f.adapter.id)!;
    assert.equal(quoteIsFresh(f.engine.snapshot(f.adapter.id,'DOS'),f.engine.config),true);assert.equal(f.internal.unavailableSnapshots.size,0);
    assert.deepEqual({code:health.errorCode,status:health.status,profitCandidate:f.internal.realtimeProfitCandidate(f.source)},
      {code:'TIMEOUT',status:'degraded',profitCandidate:true});
    assert.equal(f.internal.publicSnapshotRequests.size,1);assert.equal(f.privateFees(),0);assert.equal(f.posts(),0);
    t.mock.timers.tick(1981);assert.equal(f.internal.realtimeProfitCandidate(f.source),false,'health fallback does not renew WS TTL');
    assert.equal(f.source.profitExitNotionalUsd,100);assert.equal(f.engine.config.minExitProfitBps,10);
  }finally{await f.cleanup();}
});

for(const invalid of ['expired-book','expired-metadata','future-book','wrong-exchange','wrong-base','missing-book'] as const)
test(`${invalid} cannot preserve healthy requested-book fallback or permit a profit preview`,async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1700000000000});const f=fallbackFixture();
  try{const book=f.books.get(f.adapter.id)!;
    if(invalid==='expired-book')book.observedAt=Date.now()-2001;
    else if(invalid==='expired-metadata')book.fundingObservedAt=Date.now()-30001;
    else if(invalid==='future-book')book.observedAt=Date.now()+5001+20;
    else if(invalid==='wrong-exchange')book.exchange='bybit';
    else if(invalid==='wrong-base')book.base='OTHER';
    else f.adapter.getExecutionSnapshot=()=>undefined;
    const pending=f.internal.refreshAdapter(f.adapter,['DOS'],false);await flush();t.mock.timers.tick(20);assert.equal(await pending,false);
    assert.equal(f.engine.health.find(row=>row.exchange===f.adapter.id)!.status,'offline');
    assert.equal(f.internal.realtimeProfitCandidate(f.source),false);assert.equal(f.privateFees(),0);assert.equal(f.posts(),0);
  }finally{await f.cleanup();}
});

test('a wrong contract symbol does not become the selected strategy profit candidate through a generic venue health fallback',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1700000000000});const f=fallbackFixture();
  try{f.books.get(f.adapter.id)!.symbol='OTHER/USDT:USDT';
    const pending=f.internal.refreshAdapter(f.adapter,['DOS'],false);await flush();t.mock.timers.tick(20);await pending;
    assert.equal(f.internal.realtimeProfitCandidate(f.source),false);assert.equal(f.source.long.symbol,'DOS/USDT:USDT');
    assert.equal(f.privateFees(),0);assert.equal(f.posts(),0);
  }finally{await f.cleanup();}
});

test('a replaced adapter cannot use its late REST failure or old WS getter to update current health',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1700000000000});const f=fallbackFixture();
  try{const health=f.engine.health.find(row=>row.exchange===f.adapter.id)!,before=structuredClone(health),logCount=f.store.data.logs.length;
    const pending=f.internal.refreshAdapter(f.adapter,['DOS'],false);await flush();
    f.engine.adapters=f.engine.adapters.map(adapter=>adapter===f.adapter?{id:adapter.id,close:async()=>{}} as ExchangeAdapter:adapter);
    t.mock.timers.tick(20);assert.equal(await pending,false);assert.deepEqual(health,before);assert.equal(f.store.data.logs.length,logCount);
    assert.equal(f.privateFees(),0);assert.equal(f.posts(),0);
  }finally{await f.cleanup();}
});
