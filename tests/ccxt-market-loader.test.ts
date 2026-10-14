import test from 'node:test';
import assert from 'node:assert/strict';
import ccxt from 'ccxt';
import {configureMarketLoadRecovery} from '../src/adapters/ccxt-market-loader.js';
import {CcxtAdapter} from '../src/adapters/ccxt.js';
import {defaultConfig} from '../src/shared/config.js';
import type {OrderRequest} from '../src/shared/types.js';

const market={id:'BTCUSDT',symbol:'BTC/USDT:USDT',base:'BTC',quote:'USDT',settle:'USDT',
  baseId:'BTC',quoteId:'USDT',settleId:'USDT',active:true,swap:true,contract:true,linear:true,inverse:false,
  contractSize:1,precision:{amount:.001,price:.1},limits:{amount:{min:.001},cost:{min:1}}};
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function deferred<T>(){
  let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
function nativeClient(){
  const client:any=new ccxt.bybit({enableRateLimit:false,has:{fetchCurrencies:false}});
  // A test must fail if CCXT unexpectedly reaches any real transport boundary.
  client.fetch=async()=>{throw new Error('unexpected network request');};
  return client;
}

test('the main adapter releases a rejected native CCXT loader and the next read obtains real fixture metadata',async()=>{
  const client=nativeClient();let metadataReads=0;
  const firstError=new ccxt.RequestTimeout('synthetic startup timeout');
  client.fetchMarkets=async()=>{if(++metadataReads===1)throw firstError;return [market];};
  const adapter=new CcxtAdapter('bybit',{...defaultConfig,mode:'paper',dataSource:'public'},client);
  try{
    await assert.rejects(adapter.fetchSnapshots(['BTC']),error=>error===firstError);
    assert.equal(metadataReads,1,'the failing invocation is never retried inside the helper');
    assert.equal(client.marketsLoading,undefined);assert.equal(client.reloadingMarkets,false);
    const loaded=await client.loadMarkets();
    assert.equal(metadataReads,2);assert.equal(loaded[market.symbol].id,market.id);
  }finally{await adapter.close();}
});

test('concurrent callers retain the same in-flight metadata request and a success stays cached',async()=>{
  const client=nativeClient(),metadata=deferred<any[]>();let metadataReads=0;
  client.fetchMarkets=async()=>{metadataReads++;return metadata.promise;};
  configureMarketLoadRecovery(client);
  try{
    const first=client.loadMarkets(),loading=client.marketsLoading,second=client.loadMarkets();
    await flush();assert.equal(metadataReads,1);assert.equal(client.marketsLoading,loading);
    assert.equal(client.reloadingMarkets,true);
    metadata.resolve([market]);const [one,two]=await Promise.all([first,second]);
    assert.equal(one,two);assert.equal(client.marketsLoading,loading);assert.equal(client.reloadingMarkets,false);
    const cached=await client.loadMarkets();assert.equal(cached,one);assert.equal(metadataReads,1);
  }finally{await client.close();}
});

test('a separate caller rejection does not clear the native metadata promise while it remains pending',async()=>{
  const pending=deferred<Record<string,unknown>>(),error=new Error('outer logical timeout');
  const client={marketsLoading:pending.promise,reloadingMarkets:true,loadMarkets:()=>Promise.reject(error)};
  configureMarketLoadRecovery(client);
  await assert.rejects(client.loadMarkets(),rejection=>rejection===error);
  assert.equal(client.marketsLoading,pending.promise);assert.equal(client.reloadingMarkets,true);
  pending.resolve({[market.symbol]:market});await flush();
  assert.equal(client.marketsLoading,pending.promise,'a successful native load is retained');
});

test('a late rejection cannot erase a newer metadata loader or change its in-flight state',async()=>{
  const old=deferred<Record<string,unknown>>(),next=deferred<Record<string,unknown>>();
  const client:{marketsLoading:Promise<Record<string,unknown>>|undefined;reloadingMarkets:boolean;loadMarkets:()=>Promise<Record<string,unknown>>}={
    marketsLoading:old.promise,reloadingMarkets:true,loadMarkets(){return this.marketsLoading!;}};
  configureMarketLoadRecovery(client);
  const original=client.loadMarkets(),rejected=assert.rejects(original,/old load rejected/);
  client.marketsLoading=next.promise;const replacement=client.loadMarkets();
  old.reject(new Error('old load rejected'));await rejected;
  assert.equal(client.marketsLoading,next.promise);assert.equal(client.reloadingMarkets,true);
  next.resolve({[market.symbol]:market});await replacement;
  assert.equal(client.marketsLoading,next.promise);
});

test('a failed metadata refresh preserves previously loaded markets and success-cache installation is idempotent',async()=>{
  const client=nativeClient();let metadataReads=0,failReload=false;
  client.fetchMarkets=async()=>{metadataReads++;if(failReload)throw new Error('refresh failed');return [market];};
  configureMarketLoadRecovery(client);const installed=client.loadMarkets;
  configureMarketLoadRecovery(client);assert.equal(client.loadMarkets,installed);
  try{
    const original=await client.loadMarkets(),successful=client.marketsLoading;
    assert.equal(await client.loadMarkets(),original);assert.equal(client.marketsLoading,successful);
    failReload=true;await assert.rejects(client.loadMarkets(true),/refresh failed/);
    assert.equal(client.marketsLoading,undefined);assert.equal(client.markets,original);
    assert.equal(await client.loadMarkets(),original,'the existing valid market dictionary remains usable');
    assert.equal(metadataReads,2,'normal cache reuse does not force an extra market fetch');
  }finally{await client.close();}
});

test('metadata recovery never retries an uncertain order or converts its original result into a no-send refusal',async()=>{
  let metadataReads=0,creates=0,orderReads=0,failMetadata=false;
  const client:any={apiKey:'synthetic-key',secret:'synthetic-secret',precisionMode:4,has:{fetchMyTrades:false},
    markets:{[market.symbol]:market},marketsLoading:undefined,reloadingMarkets:false,market:()=>market,
    loadMarkets(){
      if(!this.marketsLoading){metadataReads++;this.marketsLoading=failMetadata?Promise.reject(new Error('metadata outage')):Promise.resolve(this.markets);}
      return this.marketsLoading;
    },
    fetchPositions:async()=>[{symbol:market.symbol,contracts:1,side:'short',info:{marginType:'isolated'}}],
    amountToPrecision:(_symbol:string,value:number)=>String(value),priceToPrecision:(_symbol:string,value:number)=>String(value),
    createOrder:async()=>{creates++;throw new ccxt.RequestTimeout('uncertain original create');},
    fetchOrder:async()=>{orderReads++;throw new ccxt.RequestTimeout('original result unknown');},
  };
  const request:OrderRequest={clientOrderId:'metadata-recovery-original-order',base:'BTC',symbol:market.symbol,
    side:'buy',quantity:1,limitPrice:100,reduceOnly:true};
  const adapter=new CcxtAdapter('binance',{...defaultConfig,mode:'live',dataSource:'public'},client);
  try{
    const original=await adapter.placeOrder(request);assert.equal(original.status,'unknown');assert.equal(creates,1);
    failMetadata=true;client.marketsLoading=undefined;
    const duringFailure=await adapter.placeOrder(request);
    assert.equal(duringFailure.status,'unknown');assert.equal(duringFailure.rejectionCode,undefined);
    assert.equal(client.marketsLoading,undefined);assert.equal(metadataReads,2);assert.equal(creates,1);
    failMetadata=false;const recovered=await adapter.placeOrder(request);
    assert.equal(recovered.status,'unknown');assert.equal(recovered.rejectionCode,undefined);
    assert.equal(metadataReads,3);assert.equal(creates,1,'only original order reconciliation is allowed');
    assert.equal(orderReads,2);assert.equal(recovered.clientOrderId,original.clientOrderId);
  }finally{await adapter.close();}
});
