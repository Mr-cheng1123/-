import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as immediate} from 'node:timers/promises';
import {CcxtAdapter} from '../src/adapters/ccxt.js';
import {ExchangeNetworkError} from '../src/adapters/network.js';
import {defaultConfig} from '../src/shared/config.js';
import type {ExchangeId} from '../src/shared/types.js';

function deferred<T=any>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((done,fail)=>{resolve=done;reject=fail;});return {promise,resolve,reject};}
const market={id:'BTCUSDT',symbol:'BTC/USDT:USDT',base:'BTC',quote:'USDT',settle:'USDT',active:true,swap:true,linear:true,contractSize:1};
type Venue='gate'|'bybit'|'bitget-classic'|'bitget-uta'|'binance'|'okx';
function fixture(venue:Venue){
  const calls:string[]=[],pending:ReturnType<typeof deferred>[]=[],exchange:ExchangeId=venue.startsWith('bitget')?'bitget':venue as ExchangeId;
  let metadata:Promise<unknown>|undefined,held=false,financialCalls=0;
  const regularResult=()=>venue==='bybit'?{retCode:0,result:{list:[],nextPageCursor:''}}:
    venue==='bitget-uta'?{code:'00000',data:{list:[],cursor:''}}:venue==='bitget-classic'?{code:'00000',data:{entrustedList:[]}}:
    venue==='okx'?{code:'0',data:[]}:[];
  const conditionalResult=()=>venue==='bitget-uta'?{code:'00000',data:[]}:regularResult();
  const regular=async()=>{calls.push('regular');if(!held)return regularResult();const read=deferred();pending.push(read);return read.promise;};
  const conditional=async()=>{calls.push('conditional');return conditionalResult();};
  const forbidden=async()=>{financialCalls++;throw new Error('OFFLINE financial operation forbidden during active-order GET');};
  const client:any={apiKey:'OFFLINE-OPEN',secret:'OFFLINE-SECRET',password:'OFFLINE-PASSWORD',options:{},markets:{[market.symbol]:market},market:()=>market,
    loadMarkets:async()=>{calls.push('metadata');await metadata;return {[market.symbol]:market};},
    privateFuturesGetSettleOrders:regular,privateFuturesGetSettlePriceOrders:conditional,
    privateGetV5OrderRealtime:regular,
    privateUtaGetV3AccountSettings:async()=>{calls.push('settings');return {code:'00000',data:{accountMode:venue==='bitget-classic'?'hybrid':'unified'}};},
    privateMixGetV2MixOrderOrdersPending:regular,privateMixGetV2MixOrderOrdersPlanPending:conditional,
    privateUtaGetV3TradeUnfilledOrders:regular,privateUtaGetV3TradeUnfilledStrategyOrders:conditional,
    fapiPrivateGetOpenOrders:regular,fapiPrivateGetOpenAlgoOrders:conditional,
    privateGetTradeOrdersPending:regular,privateGetTradeOrdersAlgoPending:conditional,
    createOrder:forbidden,cancelOrder:forbidden,fetchTradingFee:forbidden,
  };
  const adapter=new CcxtAdapter(exchange,{...defaultConfig,mode:'live',dataSource:'public'},client);
  return {adapter,client,calls,pending,regularResult,conditionalResult,hold:()=>{held=true;},holdMetadata:(task:Promise<unknown>)=>{metadata=task;},
    release:()=>{for(const read of pending.splice(0))read.resolve(regularResult());},financialCalls:()=>financialCalls};
}
const timeout=(error:unknown)=>error instanceof ExchangeNetworkError&&error.code==='TIMEOUT';

test('expired active-order context rejects before metadata or native GET',async()=>{
  const f=fixture('gate');try{
    await assert.rejects(f.adapter.fetchOpenOrders(market.symbol,{deadlineAt:Date.now()-1}),timeout);
    assert.deepEqual(f.calls,[]);assert.equal(f.financialCalls(),0);
  }finally{await f.adapter.close();}
});

test('cancelled active-order metadata cannot start the first native GET',async()=>{
  const f=fixture('gate'),metadata=deferred<void>(),controller=new AbortController();f.holdMetadata(metadata.promise);
  const task=f.adapter.fetchOpenOrders(market.symbol,{signal:controller.signal}).then(value=>({value}),error=>({error}));
  try{
    await immediate();controller.abort();metadata.resolve();const result=await task;
    assert.ok('error' in result&&timeout(result.error));assert.deepEqual(f.calls,['metadata']);assert.equal(f.financialCalls(),0);
  }finally{metadata.resolve();await task;await f.adapter.close();}
});

for(const venue of ['gate','bybit','bitget-classic','bitget-uta'] as const)
  test(`${venue} ignores late active-order pages and does not start another category or cursor`,async()=>{
    const f=fixture(venue),controller=new AbortController();f.hold();let settled=false;
    const task=f.adapter.fetchOpenOrders(market.symbol,{signal:controller.signal}).then(value=>{settled=true;return {value};},error=>{settled=true;return {error};});
    try{
      await immediate();assert.equal(f.pending.length,1);controller.abort();await immediate();assert.equal(settled,false);
      if(venue==='bybit')f.pending[0].resolve({retCode:0,result:{list:[{orderId:'OFFLINE-ACTIVE',symbol:market.id,side:'Buy',qty:'1',leavesQty:'1',orderStatus:'New'}],nextPageCursor:'OFFLINE-NEXT'}});
      else f.release();
      const result=await task;assert.ok('error' in result&&timeout(result.error));
      assert.equal(f.calls.filter(call=>call==='regular').length,1);assert.equal(f.calls.filter(call=>call==='conditional').length,0);
      assert.equal(f.financialCalls(),0);
    }finally{f.release();await task;await f.adapter.close();}
  });

for(const venue of ['binance','okx','bitget-uta'] as const)
  test(`${venue} active-order rejection drains every originally started conditional GET`,async()=>{
    const f=fixture(venue),held=deferred(),failure=new Error(`OFFLINE ${venue} initial GET failed`);let completed=false,heldCalls=0;
    if(venue==='binance'){
      f.client.fapiPrivateGetOpenOrders=async()=>{throw failure;};f.client.fapiPrivateGetOpenAlgoOrders=()=>{heldCalls++;return held.promise;};
    }else if(venue==='okx'){
      f.client.privateGetTradeOrdersPending=async()=>{throw failure;};f.client.privateGetTradeOrdersAlgoPending=()=>{heldCalls++;return held.promise;};
    }else{
      f.client.privateUtaGetV3TradeUnfilledStrategyOrders=({type}:any)=>{if(type==='tpsl')return Promise.reject(failure);heldCalls++;return held.promise;};
    }
    const task=f.adapter.fetchOpenOrders(market.symbol).then(()=>{completed=true;return undefined;},error=>{completed=true;return error;});
    try{
      await immediate();assert.equal(completed,false);assert.equal(heldCalls,venue==='binance'?1:venue==='okx'?4:5);
      held.resolve(f.conditionalResult());assert.equal(await task,failure);assert.equal(f.financialCalls(),0);
    }finally{held.resolve(f.conditionalResult());await task;await f.adapter.close();}
  });

for(const venue of ['gate','bybit','bitget-classic','bitget-uta'] as const)
  test(`${venue} unscoped active-order API retains all original native categories and zero financial calls`,async()=>{
    const f=fixture(venue);try{
      assert.deepEqual(await f.adapter.fetchOpenOrders(market.symbol),[]);
      assert.equal(f.calls.filter(call=>call==='regular').length,venue==='bitget-classic'?2:1);
      assert.equal(f.calls.filter(call=>call==='conditional').length,venue==='gate'?1:venue==='bybit'?0:venue==='bitget-classic'?3:6);
      assert.equal(f.financialCalls(),0);
    }finally{await f.adapter.close();}
  });
