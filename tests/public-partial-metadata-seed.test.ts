import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as immediate} from 'node:timers/promises';
import {CcxtAdapter} from '../src/adapters/ccxt.js';
import {ExchangeNetworkError} from '../src/adapters/network.js';
import {Engine} from '../src/core/engine.js';
import {quoteIsFresh} from '../src/core/market-validity.js';
import {defaultConfig} from '../src/shared/config.js';
import type {MarketSnapshot} from '../src/shared/types.js';

function fixture(){
  const bases=['HELD0','HELD1','SLOW0','SLOW1','UNUSED0','UNUSED1'];
  const markets=Object.fromEntries(bases.map(base=>[`${base}/USDT:USDT`,{id:`${base}USDT`,symbol:`${base}/USDT:USDT`,base,
    quote:'USDT',settle:'USDT',active:true,swap:true,linear:true,contractSize:1,precision:{amount:1,price:.1},
    limits:{amount:{min:1},cost:{min:1}},info:{fundingInterval:480}}]));
  const pending:(()=>void)[]=[],tickerCalls:string[]=[];let holdAll=false,invalid=false,metadataCalls=0,privateCalls=0,closed=false;
  let streamAt:number|undefined;
  const privateRead=async()=>{privateCalls++;throw new Error('Unexpected private call in public observation');};
  const client:any={precisionMode:4,options:{},has:{},markets,market:(symbol:string)=>markets[symbol],
    loadMarkets:async()=>{metadataCalls++;return markets;},
    fetchTicker:async(symbol:string)=>{tickerCalls.push(symbol);if(holdAll||symbol.startsWith('SLOW'))await new Promise<void>(resolve=>pending.push(resolve));
      return {timestamp:Date.now(),quoteVolume:1e6,info:{markPrice:invalid?NaN:100,indexPrice:100}};},
    parseFundingRate:()=>({fundingRate:.001,fundingTimestamp:Date.now()+300000,interval:'8h',markPrice:invalid?NaN:100,indexPrice:100,info:{fundingIntervalHour:'8'}}),
    fetchOrderBook:async()=>({timestamp:Date.now(),bids:[[99,10]],asks:[[101,10]]}),
    fetchFundingRateHistory:async()=>[{timestamp:Date.now()-16*3600000,fundingRate:.001},{timestamp:Date.now()-8*3600000,fundingRate:.001}],
    fetchTradingFee:privateRead,fetchBalance:privateRead,fetchPositions:privateRead,privateGetV5AccountFeeRate:privateRead};
  const config={...defaultConfig,mode:'paper' as const,dataSource:'public' as const,feeOnly:true,paperFeeOnly:true,maxSnapshotAgeMs:30000};
  const adapter=new CcxtAdapter('bybit',config,client,true);
  (adapter as any).publicBooks={getBook:(symbol:string)=>closed?undefined:{exchange:'bybit',symbol,generation:7,
    receivedAt:streamAt??Date.now(),eventAt:streamAt??Date.now(),bids:[{price:99,quantity:10}],asks:[{price:101,quantity:10}]},
    setSymbols:()=>{},close:async()=>{closed=true;}};
  return {adapter,config,client,bases,tickerCalls,pending,release:()=>pending.splice(0).forEach(resolve=>resolve()),
    holdAll:()=>{holdAll=true;},invalid:()=>{invalid=true;},streamAt:(at:number|undefined)=>{streamAt=at;},
    seeds:()=>(adapter as any).realtimeSeeds as Map<string,MarketSnapshot>,privateCalls:()=>privateCalls,metadataCalls:()=>metadataCalls};
}
const timeout=(error:unknown)=>error instanceof ExchangeNetworkError&&error.code==='TIMEOUT';
const taskResult=<T>(task:Promise<T>)=>task.then(value=>({value}),error=>({error}));

test('completed held metadata is retained while unrelated symbols remain pending, without publishing a partial batch',async()=>{
  const f=fixture(),controller=new AbortController();let published=0,finished=false;
  (f.adapter as any).realtimePublish=()=>{published++;};
  // The fixture is a public-only client; registering a callback cannot start a private stream.
  const task=taskResult(f.adapter.fetchSnapshots(f.bases,{signal:controller.signal})).finally(()=>{finished=true;});
  try{
    await immediate();assert.equal(f.pending.length,2);assert.equal(finished,false);
    for(const base of ['HELD0','HELD1']){
      const quote=f.adapter.getExecutionSnapshot(base);assert(quote,'a completed original observation must not wait for an unrelated symbol');
      assert.equal(quote.fundingRate,.001);assert.equal(quote.bookGeneration,7);assert(quoteIsFresh(quote,f.config));
    }
    assert.equal(published,0,'successful per-symbol seed retention must not publish a partial whole batch');
    controller.abort();f.release();const result=await task;assert('error' in result&&timeout(result.error));
    assert.deepEqual([...f.seeds().keys()].sort(),['HELD0','HELD1']);assert.equal(f.tickerCalls.length,4);assert.equal(f.privateCalls(),0);
  }finally{controller.abort();f.release();await task;await f.adapter.close();}
});

test('foreground timeout still rejects the whole batch and owns actual pending reads while completed held seeds survive',async()=>{
  const f=fixture(),owner:any={config:f.config,options:{publicSnapshotDeadlineMs:80},publicSnapshotRequests:new Map()};
  const acquire=(Engine.prototype as any).acquireSnapshots.bind(owner);
  try{
    await assert.rejects(acquire(f.adapter,f.bases),/Public market snapshot timeout/);
    assert.equal(owner.publicSnapshotRequests.has('bybit'),true);assert.equal(f.tickerCalls.length,4);
    assert(f.adapter.getExecutionSnapshot('HELD0'));assert(f.adapter.getExecutionSnapshot('HELD1'));
    await assert.rejects(acquire(f.adapter,f.bases),/already in progress/);assert.equal(f.tickerCalls.length,4);
    f.release();await immediate();assert.equal(owner.publicSnapshotRequests.has('bybit'),false);
    assert.equal(f.seeds().has('SLOW0'),false);assert.equal(f.seeds().has('SLOW1'),false);assert.equal(f.privateCalls(),0);
  }finally{f.release();await immediate();await f.adapter.close();}
});

test('an already cancelled read never starts metadata, ticker or private queries or creates a seed',async()=>{
  const f=fixture();try{
    await assert.rejects(f.adapter.fetchSnapshots(f.bases,{signal:AbortSignal.abort()}),timeout);
    assert.equal(f.metadataCalls(),0);assert.equal(f.tickerCalls.length,0);assert.equal(f.seeds().size,0);assert.equal(f.privateCalls(),0);
  }finally{await f.adapter.close();}
});

test('cancellation cannot retain late metadata or refresh the original completed funding observation',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1700000000000});
  const f=fixture(),controller=new AbortController(),task=taskResult(f.adapter.fetchSnapshots(f.bases,{signal:controller.signal}));
  try{
    await immediate();const original=f.seeds().get('HELD0')?.fundingObservedAt;assert.equal(original,1700000000000);
    controller.abort();t.mock.timers.tick(15000);f.release();const result=await task;assert('error' in result&&timeout(result.error));
    assert.equal(f.seeds().get('HELD0')?.fundingObservedAt,original);assert.equal(f.seeds().has('SLOW0'),false);
    assert.equal(f.adapter.getExecutionSnapshot('HELD0')?.fundingObservedAt,original);assert.equal(f.privateCalls(),0);
  }finally{controller.abort();f.release();await task;await f.adapter.close();}
});

test('late completion after closing a retired adapter cannot retain a seed or publish a quote',async()=>{
  const f=fixture();f.holdAll();let published=0;(f.adapter as any).realtimePublish=()=>{published++;};
  const task=taskResult(f.adapter.fetchSnapshots(['HELD0','HELD1']));
  try{
    await immediate();assert.equal(f.pending.length,2);await f.adapter.close();f.release();await task;
    assert.equal(f.seeds().size,0);assert.equal(f.adapter.getExecutionSnapshot('HELD0'),undefined);assert.equal(published,0);assert.equal(f.privateCalls(),0);
  }finally{f.release();await task;await f.adapter.close();}
});

for(const changed of ['generation','adapter','configuration'] as const)test(`${changed} change prevents original whole batch publishing to Engine`,async()=>{
  const f=fixture();f.holdAll();
  const owner:any={config:f.config,startGeneration:1,stopping:false,options:{publicSnapshotDeadlineMs:2000},
    publicSnapshotRequests:new Map(),adapters:[f.adapter],health:[{exchange:'bybit',status:'connecting'}],snapshots:[],
    unavailableSnapshots:new Set(),errors:new Map(),snapshotKey:(exchange:string,base:string)=>`${exchange}:${base}`,
    paperBalance:()=>0,persistObservation:(write:()=>void)=>write(),store:{log:()=>{}},activePositions:()=>[]};
  owner.acquireSnapshots=(Engine.prototype as any).acquireSnapshots.bind(owner);
  const task=(Engine.prototype as any).refreshAdapter.call(owner,f.adapter,['HELD0','HELD1'],false) as Promise<boolean>;
  try{
    await immediate();assert.equal(f.pending.length,2);
    if(changed==='generation')owner.startGeneration++;
    else if(changed==='adapter')owner.adapters=[];
    else owner.config={...f.config};
    f.release();assert.equal(await task,false);assert.deepEqual(owner.snapshots,[]);assert.equal(f.privateCalls(),0);
  }finally{f.release();await task;await f.adapter.close();}
});

test('retained metadata preserves the two-second WS lifetime and original REST and metadata lifetime',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1700000000000});const f=fixture();
  try{
    const [quote]=await f.adapter.fetchSnapshots(['HELD0']);assert(quote);const original=quote.fundingObservedAt;
    const rest={...quote,bookTransport:'rest' as const};f.streamAt(Date.now());
    t.mock.timers.tick(2000);assert(f.adapter.getExecutionSnapshot('HELD0'));assert(quoteIsFresh(rest,f.config));
    t.mock.timers.tick(1);assert.equal(f.adapter.getExecutionSnapshot('HELD0'),undefined);assert.equal(quoteIsFresh(quote,f.config),false);
    f.streamAt(undefined);assert(f.adapter.getExecutionSnapshot('HELD0'));assert.equal(f.seeds().get('HELD0')?.fundingObservedAt,original);
    t.mock.timers.tick(27999);assert(quoteIsFresh(rest,f.config));assert(f.adapter.getExecutionSnapshot('HELD0'));
    t.mock.timers.tick(1);assert.equal(quoteIsFresh(rest,f.config),false);assert.equal(f.adapter.getExecutionSnapshot('HELD0'),undefined);
    assert.equal(f.seeds().get('HELD0')?.fundingObservedAt,original);assert.equal(f.privateCalls(),0);
  }finally{await f.adapter.close();}
});

test('repeated cancelled reads cannot renew expired metadata or turn an unseen symbol into an executable quote',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1700000000000});const f=fixture();
  try{
    await f.adapter.fetchSnapshots(['HELD0']);const original=f.seeds().get('HELD0')?.fundingObservedAt;assert.equal(original,Date.now());f.holdAll();
    for(let attempt=0;attempt<2;attempt++){
      const controller=new AbortController(),task=taskResult(f.adapter.fetchSnapshots(['HELD0','HELD1'],{signal:controller.signal}));
      await immediate();controller.abort();t.mock.timers.tick(16000);f.release();const result=await task;assert('error' in result&&timeout(result.error));
      assert.equal(f.seeds().get('HELD0')?.fundingObservedAt,original);assert.equal(f.seeds().has('HELD1'),false);
    }
    assert.equal(f.adapter.getExecutionSnapshot('HELD0'),undefined);assert.equal(f.adapter.getExecutionSnapshot('HELD1'),undefined);assert.equal(f.privateCalls(),0);
  }finally{f.release();await f.adapter.close();}
});

test('invalid completed mark or funding observations never become a partial executable seed',async()=>{
  const f=fixture();f.invalid();try{
    await assert.rejects(f.adapter.fetchSnapshots(['HELD0','HELD1']),/no requested active/);
    assert.equal(f.seeds().size,0);assert.equal(f.adapter.getExecutionSnapshot('HELD0'),undefined);assert.equal(f.privateCalls(),0);
  }finally{await f.adapter.close();}
});

test('an older concurrent observation completing last cannot replace a newer retained funding seed',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1700000000000});const f=fixture();
  let release!:()=>void,first=true;const original=f.client.fetchTicker;
  f.client.fetchTicker=async(symbol:string)=>{if(first){first=false;await new Promise<void>(resolve=>{release=resolve;});}return original(symbol);};
  const older=taskResult(f.adapter.fetchSnapshots(['HELD0']));
  try{
    await immediate();t.mock.timers.tick(500);const [newer]=await f.adapter.fetchSnapshots(['HELD0']);
    assert.equal(newer.fundingObservedAt,1700000000500);release();const result=await older;assert('value' in result);
    assert.equal(result.value[0].fundingObservedAt,1700000000000);assert.equal(f.seeds().get('HELD0')?.fundingObservedAt,newer.fundingObservedAt);
    assert.equal(f.adapter.getExecutionSnapshot('HELD0')?.fundingObservedAt,newer.fundingObservedAt);assert.equal(f.privateCalls(),0);
  }finally{release?.();await older;await f.adapter.close();}
});
