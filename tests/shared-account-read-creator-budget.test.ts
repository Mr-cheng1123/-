import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as immediate,setTimeout as delay} from 'node:timers/promises';
import ccxt from 'ccxt';
import {CcxtAdapter} from '../src/adapters/ccxt.js';
import {configureMarketLoadRecovery} from '../src/adapters/ccxt-market-loader.js';
import {readVerifiedBitgetSettings} from '../src/adapters/bitget-account.js';
import {assertExchangeRequestActive,configureExchangeTransport,ExchangeNetworkError,withExchangeRequestContext} from '../src/adapters/network.js';
import {Engine} from '../src/core/engine.js';
import {defaultConfig} from '../src/shared/config.js';
import type {AppConfig} from '../src/shared/types.js';

const market={id:'BTCUSDT',symbol:'BTC/USDT:USDT',base:'BTC',quote:'USDT',settle:'USDT',baseId:'BTC',quoteId:'USDT',settleId:'USDT',
  type:'swap',spot:false,swap:true,margin:false,future:false,option:false,contract:true,active:true,linear:true,inverse:false,
  contractSize:1,precision:{amount:.001,price:.1},limits:{amount:{min:.001,max:100},cost:{min:1}},info:{}};
async function flush(){for(let i=0;i<12;i++)await immediate();}
function deferred<T=void>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
function observe<T>(promise:Promise<T>){let outcome:{state:'resolved';value:T}|{state:'rejected';error:any}|undefined;
  const settled=promise.then(value=>{outcome={state:'resolved',value};},error=>{outcome={state:'rejected',error};});return {settled,get:()=>outcome};}
function nativeFixture(kind:'metadata'|'settings'){
  const id=kind==='metadata'?'bybit':'bitget',Constructor:any=(ccxt as any)[id],client:any=new Constructor({apiKey:'OFFLINE-KEY',secret:'OFFLINE-SECRET',password:'OFFLINE-PASS',
    enableRateLimit:true,rateLimit:100,has:{fetchCurrencies:false},options:{adjustForTimeDifference:false}});
  let http=0,fees=0,metadataCalls=0;
  client.fetchImplementation=async(urlText:string,params:any)=>{
    assert.equal(params.method,'GET','all genuine native HTTP in this fixture is fake GET only');
    const path=new URL(urlText).pathname;
    if(path.includes('fee'))fees++;
    assert.equal(path,kind==='metadata'?'/v5/market/instruments-info':'/api/v3/account/settings','no new account or fee query after shared read expires');http++;
    return new Response(JSON.stringify(kind==='metadata'?{retCode:0,retMsg:'OK',result:{list:[],nextPageCursor:''}}:
      {code:'00000',msg:'success',data:{accountMode:'unified',accountLevel:'basic',holdMode:'one_way_mode',deltaSwitch:'no'}}),{headers:{'content-type':'application/json'}});
  };
  if(kind==='metadata')client.fetchMarkets=async()=>{metadataCalls++;await client.publicGetV5MarketInstrumentsInfo({category:'linear',limit:1000});return [market];};
  else client.setMarkets([market]);
  configureExchangeTransport(client,id,{proxyUrl:''});client.timeout=20;
  const config:AppConfig={...structuredClone(defaultConfig),mode:'live',dataSource:'public',exchanges:[id]},adapter=new CcxtAdapter(id,config,client);
  const shell:any={config,startGeneration:1,options:{privateReadDeadlineMs:40},privateReadRequests:new Map(),accountReadAt:new WeakMap(),accountReadSources:new WeakMap()};
  const account=()=>observe((Engine.prototype as any).boundedPrivateRead.call(shell,adapter,'account',(context:any)=>adapter.fetchAccount(context)));
  const start=()=>{if(kind==='metadata')return observe(client.loadMarkets());
    (adapter as any).realtimePublish=()=>{};return observe((adapter as any).startPrivateRealtime());};
  return {id,client,adapter,shell,account,start,http:()=>http,fees:()=>fees,metadataCalls:()=>metadataCalls};
}

for(const kind of ['metadata','settings'] as const)test(`the first background ${kind} native GET owns a deadline before an account reader joins its shared promise`,async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1700000000000});const f=nativeFixture(kind);
  try{await f.client.throttle(1);const background=f.start(),account=f.account();await flush();
    const owner=f.client.throttler,entry=owner.queue[owner.queueHead],raw=f.shell.privateReadRequests.get(f.adapter)?.get('account');assert.ok(raw);assert.ok(entry.cost>0);
    t.mock.timers.tick(20);await flush();assert.equal(account.get()?.state,'rejected');assert.equal((account.get() as any).error.code,'TIMEOUT');
    assert.equal(entry.cost,0);assert.equal(f.shell.privateReadRequests.get(f.adapter).has('account'),false);
    if(kind==='metadata'){assert.equal(background.get()?.state,'rejected');assert.equal(f.client.marketsLoading,undefined);assert.equal(f.metadataCalls(),1);}
    else{assert.equal(background.get()?.state,'resolved');assert.equal((f.adapter as any).privateStreamError,true);assert.equal((f.adapter as any).privateEvents,undefined);}
    assert.equal(f.http(),0);assert.equal(f.fees(),0);await delay(150);await background.settled;assert.equal(f.http(),0);assert.equal(owner.queue.length,0);
    f.client.timeout=500;
    if(kind==='metadata'){const loaded=await f.client.loadMarkets();assert.equal(loaded[market.symbol].id,market.id);assert.equal(f.metadataCalls(),2);}
    else await withExchangeRequestContext(f.client,{deadlineAt:Date.now()+500},()=>readVerifiedBitgetSettings(f.client));
    assert.equal(f.http(),1,'one new healthy GET only after the old read actually rejected');assert.equal(f.fees(),0);
  }finally{await delay(150);await f.adapter.close();}
});

test('a short metadata caller budget is inherited instead of being extended to the shared default',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1700000000000});const hold=deferred(),client:any={timeout:8000,marketsLoading:undefined,reloadingMarkets:false};let reads=0;
  client.loadMarkets=function(){if(!this.marketsLoading)this.marketsLoading=(async()=>{reads++;assertExchangeRequestActive(client,'gate');await hold.promise;assertExchangeRequestActive(client,'gate');return {};})();return this.marketsLoading;};
  configureMarketLoadRecovery(client);
  const first=observe(withExchangeRequestContext(client,{deadlineAt:Date.now()+20},()=>client.loadMarkets())),native=client.marketsLoading;
  const joined=observe(client.loadMarkets());t.mock.timers.tick(20);await flush();assert.equal(client.marketsLoading,native);assert.equal(first.get(),undefined);
  hold.resolve();await Promise.all([first.settled,joined.settled]);assert.equal(reads,1);assert.equal((first.get() as any).error.code,'TIMEOUT');assert.equal((joined.get() as any).error.code,'TIMEOUT');
});

test('an ignored shared GET cancellation never clears the native loader or returns early before true settlement',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1700000000000});const hold=deferred(),client:any={timeout:20,marketsLoading:undefined};let reads=0;
  client.loadMarkets=function(){if(!this.marketsLoading)this.marketsLoading=(async()=>{reads++;await hold.promise;assertExchangeRequestActive(client,'gate');return {};})();return this.marketsLoading;};
  configureMarketLoadRecovery(client);const first=observe(client.loadMarkets()),native=client.marketsLoading;
  t.mock.timers.tick(20);await flush();const joined=observe(client.loadMarkets());assert.equal(first.get(),undefined);assert.equal(joined.get(),undefined);assert.equal(client.marketsLoading,native);assert.equal(reads,1);
  hold.resolve();await Promise.all([first.settled,joined.settled]);assert.equal((first.get() as any).error.code,'TIMEOUT');assert.equal((joined.get() as any).error.code,'TIMEOUT');assert.equal(client.marketsLoading,undefined);
});

test('metadata read scope expires independently and cannot spread its deadline into a later financial continuation',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1700000000000});let get=0,financial=0;
  const client:any={timeout:20,loadMarkets:async()=>{get++;assertExchangeRequestActive(client,'gate');return {};}};
  configureMarketLoadRecovery(client);await client.loadMarkets();t.mock.timers.tick(21);
  // A pure in-memory write label proves caller context isolation; no financial API is called.
  assertExchangeRequestActive(client,'gate');financial++;
  assert.equal(get,1);assert.equal(financial,1);
});

for(const value of [undefined,NaN,Infinity,0,-1,20000])test(`the shared metadata creator uses bounded default for timeout=${String(value)}`,async t=>{
  t.mock.timers.enable({apis:['Date'],now:1700000000000});const hold=deferred(),client:any={timeout:value,loadMarkets:async()=>{await hold.promise;assertExchangeRequestActive(client,'gate');return {};}};
  configureMarketLoadRecovery(client);const read=observe(client.loadMarkets());t.mock.timers.tick(8000);hold.resolve();await read.settled;
  assert.equal(read.get()?.state,'rejected');assert.ok((read.get() as any).error instanceof ExchangeNetworkError);assert.equal((read.get() as any).error.code,'TIMEOUT');
});
