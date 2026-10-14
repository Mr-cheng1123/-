import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as immediate} from 'node:timers/promises';
import {CcxtAdapter} from '../src/adapters/ccxt.js';
import {ExchangeNetworkError} from '../src/adapters/network.js';
import {defaultConfig} from '../src/shared/config.js';
import type {MarketSnapshot} from '../src/shared/types.js';

function deferred<T=any>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((done,fail)=>{resolve=done;reject=fail;});return {promise,resolve,reject};}
function fixture(){
  const bases=['BTC','ETH'],calls:string[]=[],pending=new Map<string,ReturnType<typeof deferred>>();let metadata:Promise<unknown>|undefined,held=false,feeCalls=0;
  const markets=Object.fromEntries(bases.map(base=>[`${base}/USDT:USDT`,{id:`${base}USDT`,symbol:`${base}/USDT:USDT`,base,quote:'USDT',settle:'USDT',
    active:true,swap:true,linear:true,contractSize:1,precision:{amount:1,price:.1},limits:{amount:{min:1},cost:{min:1}}}]));
  const book=()=>({bids:[[99,10]],asks:[[101,10]],timestamp:Date.now()});
  const client:any={markets,market:(symbol:string)=>markets[symbol],precisionMode:4,options:{},
    loadMarkets:async()=>{calls.push('metadata');await metadata;return markets;},
    fetchOrderBook:async(symbol:string)=>{calls.push(symbol);if(!held)return book();const read=deferred();pending.set(symbol,read);return read.promise;},
    fetchTradingFee:async()=>{feeCalls++;throw new Error('OFFLINE private fee query forbidden during execution book observation');},
  };
  const config={...defaultConfig,mode:'paper' as const,dataSource:'public' as const,feeOnly:true,paperFeeOnly:true};
  const adapter=new CcxtAdapter('bybit',config,client,true),seeds=new Map<string,MarketSnapshot>();
  for(const base of bases){const at=Date.now(),seed:MarketSnapshot={exchange:'bybit',base,symbol:`${base}/USDT:USDT`,timestamp:at,observedAt:at,
    markPrice:100,indexPrice:100,fundingRate:.001,fundingObservedAt:at-1000,nextFundingTime:at+300000,intervalHours:8,fundingHistory:[],
    bids:[{price:99,quantity:10}],asks:[{price:101,quantity:10}],quantityStep:1,minQuantity:1,minNotional:1,contractSize:1,
    source:'public',bookTransport:'rest',openInterestUsd:1000,volume24hUsd:1000};
    seeds.set(base,seed);(adapter as any).realtimeSeeds.set(base,seed);
  }
  return {adapter,client,calls,bases,book,seeds,pending,hold:()=>{held=true;},holdMetadata:(task:Promise<unknown>)=>{metadata=task;},
    release:()=>{for(const read of pending.values())read.resolve(book());pending.clear();},feeCalls:()=>feeCalls};
}
const timeout=(error:unknown)=>error instanceof ExchangeNetworkError&&error.code==='TIMEOUT';

test('expired execution-book context does not start metadata or depth reads',async()=>{
  const f=fixture();try{
    await assert.rejects(f.adapter.fetchExecutionSnapshots(f.bases,{deadlineAt:Date.now()-1}),timeout);
    assert.deepEqual(f.calls,[]);assert.equal(f.feeCalls(),0);
  }finally{await f.adapter.close();}
});

test('execution-book metadata ignores cancelled caller without starting depth',async()=>{
  const f=fixture(),metadata=deferred<void>(),controller=new AbortController();f.holdMetadata(metadata.promise);
  const task=f.adapter.fetchExecutionSnapshots(f.bases,{signal:controller.signal}).then(value=>({value}),error=>({error}));
  try{
    await immediate();controller.abort();metadata.resolve();const result=await task;
    assert.ok('error' in result&&timeout(result.error));assert.deepEqual(f.calls,['metadata']);assert.equal(f.feeCalls(),0);
  }finally{metadata.resolve();await task;await f.adapter.close();}
});

test('cancelled execution-book reads remain pending until every actual native depth settles',async()=>{
  const f=fixture(),controller=new AbortController();f.hold();let finished=false;
  const task=f.adapter.fetchExecutionSnapshots(f.bases,{signal:controller.signal}).then(value=>{finished=true;return {value};},error=>{finished=true;return {error};});
  try{
    await immediate();assert.equal(f.pending.size,2);controller.abort();await immediate();assert.equal(finished,false);
    f.pending.get('BTC/USDT:USDT')!.resolve(f.book());await immediate();assert.equal(finished,false);
    f.release();const result=await task;assert.ok('error' in result&&timeout(result.error));assert.equal(f.feeCalls(),0);
  }finally{f.release();await task;await f.adapter.close();}
});

test('one failed native depth cannot release its still-running sibling',async()=>{
  const f=fixture(),failure=new Error('OFFLINE initial depth rejected');f.hold();let finished=false;
  const task=f.adapter.fetchExecutionSnapshots(f.bases).then(value=>{finished=true;return {value};},error=>{finished=true;return {error};});
  try{
    await immediate();f.pending.get('BTC/USDT:USDT')!.reject(failure);await immediate();assert.equal(finished,false);
    f.release();const result=await task;assert.ok('error' in result&&result.error===failure);assert.equal(f.feeCalls(),0);
  }finally{f.release();await task;await f.adapter.close();}
});

test('REST execution-depth refresh retains original funding observation and cash fee metadata',async()=>{
  const f=fixture();try{
    const rows=await f.adapter.fetchExecutionSnapshots(['BTC']);assert.equal(rows.length,1);
    assert.equal(rows[0].fundingObservedAt,f.seeds.get('BTC')!.fundingObservedAt);assert.equal(rows[0].fundingRate,.001);
    assert.equal(rows[0].bookTransport,'rest');assert.equal(f.calls.filter(call=>call!=='metadata').length,1);assert.equal(f.feeCalls(),0);
  }finally{await f.adapter.close();}
});

test('genuine fresh WS execution depth keeps priority without a REST request',async()=>{
  const f=fixture(),seed=f.seeds.get('BTC')!,at=Date.now();
  (f.adapter as any).publicBooks={getBook:()=>({exchange:'bybit',symbol:seed.symbol,receivedAt:at,eventAt:at,generation:1,
    bids:[{price:99.5,quantity:10}],asks:[{price:100.5,quantity:10}]}),close:async()=>{}};
  try{
    const rows=await f.adapter.fetchExecutionSnapshots(['BTC']);assert.equal(rows[0].bookTransport,'websocket');assert.equal(rows[0].bids[0].price,99.5);
    assert.equal(rows[0].fundingObservedAt,seed.fundingObservedAt);assert.deepEqual(f.calls,['metadata']);assert.equal(f.feeCalls(),0);
  }finally{await f.adapter.close();}
});
