import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as immediate,setTimeout as sleep} from 'node:timers/promises';
import ccxt from 'ccxt';
import {Engine} from '../src/core/engine.js';
import {Store} from '../src/core/store.js';
import {CcxtAdapter} from '../src/adapters/ccxt.js';
import {configureExchangeTransport,withExchangeRequestContext} from '../src/adapters/network.js';
import {configureExchangeClock} from '../src/adapters/exchange-clock.js';
import {defaultConfig} from '../src/shared/config.js';
import type {AppConfig,ExchangeAdapter,ExchangeId,MarketSnapshot,Position} from '../src/shared/types.js';

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
async function bounded<T>(promise:Promise<T>):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('offline fixture deadline')),2000);})]);}
  finally{if(timer)clearTimeout(timer);}
}
const response=(list:unknown[]=[],nextPageCursor='')=>new Response(JSON.stringify({retCode:0,retMsg:'OK',
  result:{list,nextPageCursor},retExtInfo:{},time:Date.now()}),{headers:{'content-type':'application/json'}});
async function fixture(privateReadDeadlineMs=100){
  const config:AppConfig={...structuredClone(defaultConfig),mode:'live',dataSource:'public',exchanges:['gate','bybit'],
    symbols:['BTC'],holdMode:'continuous',autoEnabled:false};
  const now=Date.now(),position:Position={id:'OFFLINE-LOGICAL-FUNDING',base:'BTC',mode:'live',status:'open',manualCloseOnly:true,
    openedAt:now-1000,plannedExitAt:now+3600000,holdMode:'continuous',
    long:{exchange:'gate',symbol:'BTC/USDT:USDT',side:'long',quantity:1,entryPrice:100,markPrice:100,feesUsd:0,liquidationDistancePct:null},
    short:{exchange:'bybit',symbol:'BTC/USDT:USDT',side:'short',quantity:1,entryPrice:100,markPrice:100,feesUsd:0,liquidationDistancePct:null},
    fundingUsd:0,feesUsd:0,transferCostUsd:0,realizedSpreadPnlUsd:0,spreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[]};
  const logs:Array<{level:string;message:string}>=[],calls:Array<{method:string;cursor:string|null}>=[];
  let financialCalls=0,active=0,maxActive=0,handler:((cursor:string|null)=>Promise<Response>)=async()=>response();
  const store={data:{version:1,config,positions:[] as Position[],orders:[],fundingSeen:[],logs,equity:[],killSwitch:false,
    spreadObservations:[],manualEntryOperations:[],manualCloseOperations:[]},save(){},
    log(level:string,message:string){logs.push({level,message});}};
  const client:any=new ccxt.bybit({apiKey:'offline-key',secret:'offline-secret',enableRateLimit:false,timeout:1000,
    options:{adjustForTimeDifference:false}});
  client.setMarkets([{id:'BTCUSDT',symbol:'BTC/USDT:USDT',base:'BTC',quote:'USDT',settle:'USDT',baseId:'BTC',quoteId:'USDT',
    settleId:'USDT',type:'swap',spot:false,swap:true,margin:false,future:false,option:false,contract:true,active:true,
    linear:true,inverse:false,contractSize:1,precision:{amount:.001,price:.1},limits:{amount:{min:.001,max:100},cost:{min:1}},info:{}}]);
  client.fetchImplementation=async(urlText:string,params:any)=>{
    const url=new URL(urlText),method=String(params.method).toUpperCase();
    if(method!=='GET'){financialCalls++;throw new Error('offline financial HTTP forbidden');}
    assert.equal(url.pathname,'/v5/execution/list');calls.push({method,cursor:url.searchParams.get('cursor')});
    active++;maxActive=Math.max(active,maxActive);
    try{return await handler(url.searchParams.get('cursor'));}finally{active--;}
  };
  configureExchangeTransport(client,'bybit');configureExchangeClock(client,'bybit');
  await client.privateGetV5ExecutionList({category:'linear',execType:'Funding',limit:100});calls.length=0;
  const bybit=new CcxtAdapter('bybit',config,client),gate={id:'gate',fetchFundingPayments:async()=>[],close:async()=>{}} as unknown as ExchangeAdapter;
  const quotes=(exchange:ExchangeId,bases:string[]):MarketSnapshot[]=>bases.map(base=>({exchange,base,symbol:`${base}/USDT:USDT`,source:'public',
    timestamp:Date.now(),observedAt:Date.now(),markPrice:100,indexPrice:100,fundingRate:.001,nextFundingTime:Date.now()+3600000,
    intervalHours:8,fundingHistory:[],bids:[{price:99,quantity:100}],asks:[{price:101,quantity:100}],quantityStep:1,minQuantity:1,
    minNotional:5,contractSize:1,volume24hUsd:1000000,openInterestUsd:1000000}));
  const forbidden=async():Promise<never>=>{financialCalls++;throw new Error('offline financial action forbidden');};
  for(const adapter of [gate,bybit]){
    adapter.fetchSnapshots=async bases=>quotes(adapter.id,bases);
    adapter.fetchAccount=async()=>({freeUsd:1000,equityUsd:1000,positions:[{base:'BTC',symbol:'BTC/USDT:USDT',
      side:adapter.id==='gate'?'long':'short',quantity:1,positionOpenedAt:position.openedAt,markPrice:100,liquidationPrice:0,leverage:2}]});
    adapter.prepareTrading=forbidden;adapter.placeOrder=forbidden;adapter.cancelOrder=forbidden;adapter.reconcileOrder=forbidden;
  }
  const engine=new Engine(store as unknown as Store,true,{adapterFactory:()=>[gate,bybit],privateReadDeadlineMs,
    publicSnapshotDeadlineMs:100,liveEnvironment:{ALLOW_LIVE_TRADING:'true',LIVE_TRADING_ACK:'I_UNDERSTAND_THE_RISKS',
      GATE_API_KEY:'offline-key',GATE_API_SECRET:'offline-secret',BYBIT_API_KEY:'offline-key',BYBIT_API_SECRET:'offline-secret'}});
  store.data.positions.push(position);(engine as any).snapshots=[...quotes('gate',['BTC']),...quotes('bybit',['BTC'])];
  return {engine,bybit,client,position,store,logs,calls,setHandler(value:typeof handler){handler=value;},
    financialCalls:()=>financialCalls,maxActive:()=>maxActive,cleanup:()=>client.close()};
}

test('Engine tick shares its funding deadline with native pagination, retains raw lock and accepts only a fresh recovery',async t=>{
  const f=await fixture(),second=deferred(),entered=deferred();
  const row=(id:string)=>({execId:id,symbol:'BTCUSDT',execTime:String(f.position.openedAt+500),execFee:'-.1',execQty:'1',side:'Sell'});
  f.setHandler(async cursor=>{
    if(!cursor){await sleep(40);return response([row('OFFLINE-LATE-1')],'OFFLINE-PAGE-2');}
    if(cursor==='OFFLINE-PAGE-2'){entered.resolve();await second.promise;return response([row('OFFLINE-LATE-2')],'OFFLINE-PAGE-3');}
    return response();
  });
  try{
    const tick=f.engine.tick();await bounded(entered.promise);await bounded(tick);
    const raw:Promise<unknown>|undefined=(f.engine as any).privateReadRequests.get(f.bybit)?.get('funding');
    assert.ok(raw,'logical timeout must not release the still-active raw read');
    const settled=raw.then(()=>false,()=>true);
    assert.equal(f.calls.length,2);assert.equal(f.position.fundingUsd,0);assert.deepEqual(f.store.data.fundingSeen,[]);
    await assert.rejects((f.engine as any).boundedPrivateRead(f.bybit,'funding',()=>f.bybit.fetchFundingPayments(f.position.openedAt)),/尚未结束/);
    await (f.engine as any).accrueLiveFunding();assert.equal(f.calls.length,2,'pending read cannot overlap');
    second.resolve();const rejected=await bounded(settled);await immediate();
    assert.equal(f.calls.length,2,'no third signed GET may start after the Engine logical deadline');
    assert.equal(rejected,true);assert.equal((f.engine as any).privateReadRequests.get(f.bybit)?.has('funding'),false);
    assert.equal(f.position.fundingUsd,0);assert.deepEqual(f.store.data.fundingSeen,[]);assert.deepEqual(f.position.fundingEvents,[]);
    assert.equal(f.position.short.fundingObservedAt,undefined);
    assert.equal(f.logs.filter(log=>/读取已恢复/.test(log.message)).length,0,'late completion cannot publish a recovery');
    const retryAt=Date.now()+15001;t.mock.method(Date,'now',()=>retryAt);
    f.setHandler(async()=>response());await (f.engine as any).accrueLiveFunding();
    assert.equal(f.calls.length,3,'a new read can recover after the raw request settles');
    assert.equal(f.position.short.fundingObservedAt,retryAt);
    assert.equal(f.logs.filter(log=>/读取已恢复/.test(log.message)).length,1);
    assert.equal(f.maxActive(),1);assert.equal(f.financialCalls(),0);assert.equal(f.position.fundingUsd,0);
    assert.deepEqual(f.store.data.fundingSeen,[]);
  }finally{second.resolve();await f.cleanup();}
});

test('funding adapter preserves an earlier parent deadline and abort signal without a new request',async()=>{
  const f=await fixture();
  try{
    const funding=f.bybit.fetchFundingPayments.bind(f.bybit) as (since:number,context?:{deadlineAt?:number;signal?:AbortSignal})=>Promise<unknown>;
    await assert.rejects(withExchangeRequestContext(f.client,{deadlineAt:Date.now()-1},()=>
      funding(f.position.openedAt,{deadlineAt:Date.now()+8000})));
    const controller=new AbortController();controller.abort();
    await assert.rejects(withExchangeRequestContext(f.client,{signal:controller.signal},()=>
      funding(f.position.openedAt,{deadlineAt:Date.now()+8000})));
    assert.equal(f.calls.length,0);assert.equal(f.financialCalls(),0);
  }finally{await f.cleanup();}
});

test('logical read passes the unchanged configured budget and existing 8000 ms cap',async t=>{
  const f=await fixture();const now=Date.now();t.mock.method(Date,'now',()=>now);
  try{
    for(const [configured,expected] of [[100,100],[10000,8000],[0,8000],[-1,8000],[NaN,8000],[Infinity,8000]]){
      (f.engine as any).options.privateReadDeadlineMs=configured;
      const deadline=await (f.engine as any).boundedPrivateRead(f.bybit,'budget',async(context:{deadlineAt:number})=>context.deadlineAt);
      assert.equal(deadline,now+expected);
    }
    assert.equal(f.calls.length,0);assert.equal(f.financialCalls(),0);
  }finally{await f.cleanup();}
});
