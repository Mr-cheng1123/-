import test from 'node:test';
import assert from 'node:assert/strict';
import {bitgetAccount,cachedBitgetAccountMode,clearBitgetAccountCache,BITGET_VERIFIED_CACHE_MS} from '../src/adapters/bitget-account.js';
import {BitgetUta} from '../src/adapters/bitget-uta.js';
import {BitgetClassic} from '../src/adapters/bitget-classic.js';
import type {OrderRequest} from '../src/shared/types.js';

// Native method stubs only: no CCXT signer, credentials, sockets or financial transport.
const symbol='BTC/USDT:USDT',other='ETH/USDT:USDT';
function fixture(accountMode:'unified'|'hybrid'='unified'){
  const counts:Record<string,number>={},sent:any[]=[];
  const state={accountMode:accountMode as string,holdMode:'one_way_mode',level:'basic',debt:'0',available:'1000',leverage:'2',
    failAssets:false,failSettings:false,ignoreLeverageWrite:false};
  const markets=Object.fromEntries([symbol,other].map(s=>[s,{id:s.split('/')[0]+'USDT',symbol:s,base:s.split('/')[0],quote:'USDT',settle:'USDT',
    active:true,swap:true,linear:true,contractSize:1}]));
  const ok=(data:any)=>({code:'00000',data});
  const settings=()=>({accountMode:state.accountMode,accountLevel:state.level,holdMode:state.holdMode,deltaSwitch:'no',
    symbolConfigList:Object.values(markets).map(m=>({category:'USDT-FUTURES',symbol:m.id,marginMode:'crossed',leverage:state.leverage}))});
  const assets=()=>({accountEquity:state.available,effEquity:state.available,imr:'0',
    assets:[{coin:'USDT',equity:state.available,available:state.available,debt:state.debt}]});
  const classic=()=>({marginCoin:'USDT',assetMode:'single',available:state.available,isolatedMaxAvailable:state.available,accountEquity:state.available,
    posMode:state.holdMode,marginMode:'isolated',isolatedLongLever:state.leverage,isolatedShortLever:state.leverage});
  const method=(name:string,read:(params:any)=>any)=>(params:any)=>{counts[name]=(counts[name]??0)+1;return Promise.resolve().then(()=>ok(read(params)));};
  const client:any={apiKey:'offline-key',secret:'offline-secret',password:'offline-passphrase',markets,market:(s:string)=>markets[s],
    amountToPrecision:(_s:string,value:number)=>String(value),priceToPrecision:(_s:string,value:number)=>String(value),
    privateUtaGetV3AccountSettings:method('settings',()=>{if(state.failSettings)throw new Error('synthetic settings failure');return settings();}),
    privateUtaGetV3AccountAssets:method('assets',()=>{if(state.failAssets)throw new Error('synthetic asset failure');return assets();}),
    privateUtaGetV3PositionCurrentPosition:method('positions',()=>({list:[]})),
    privateUtaGetV3TradeUnfilledOrders:method('pending',()=>({list:[],cursor:''})),
    privateUtaPostV3AccountSetLeverage:method('leverage',params=>{if(!state.ignoreLeverageWrite)state.leverage=params.leverage;return 'success';}),
    privateUtaPostV3TradePlaceOrder:method('uta-place',params=>{sent.push(params);return {orderId:'synthetic-uta-order'};}),
    privateMixGetV2MixAccountAccount:method('classic-mode',classic),
    privateMixGetV2MixAccountAccounts:method('classic-balances',()=>[classic()]),
    privateMixGetV2MixPositionAllPosition:method('classic-positions',()=>[]),
    privateMixGetV2MixPositionSinglePosition:method('classic-single',()=>[]),
    privateMixGetV2MixOrderOrdersPending:method('classic-pending',()=>({entrustedList:[]})),
    privateMixPostV2MixAccountSetLeverage:method('classic-leverage',params=>{if(!state.ignoreLeverageWrite)state.leverage=params.leverage;return {};}),
    privateMixPostV2MixOrderPlaceOrder:method('classic-place',params=>{sent.push(params);return {orderId:'synthetic-classic-order'};}),
    privateSpotGetV2SpotAccountAssets:method('spot',()=>[]),
  };
  const request:OrderRequest={clientOrderId:'offline-cached-mode',base:'BTC',symbol,side:'buy',quantity:1,limitPrice:1.01,reduceOnly:false};
  return {client,state,counts,sent,request};
}

test('routing hints come only from real settings GETs and expire at the strict two-second boundary',async t=>{
  const f=fixture();let now=1_000_000;t.mock.method(Date,'now',()=>now);
  assert.equal(cachedBitgetAccountMode(f.client),undefined);
  assert.ok(await bitgetAccount(f.client) instanceof BitgetUta);assert.equal(f.counts.settings,1);
  assert.equal(cachedBitgetAccountMode(f.client),'unified');now+=BITGET_VERIFIED_CACHE_MS-1;
  assert.ok(await bitgetAccount(f.client,'crossed') instanceof BitgetUta);assert.equal(f.counts.settings,1);
  now++;assert.equal(cachedBitgetAccountMode(f.client),undefined);f.state.accountMode='hybrid';
  assert.ok(await bitgetAccount(f.client) instanceof BitgetClassic);assert.equal(f.counts.settings,2);
  assert.equal(cachedBitgetAccountMode(f.client),'classic');
});

test('verified UTA preparation shares readback proof across fresh wrappers and eliminates redundant per-order settings/assets GETs',async()=>{
  const f=fixture(),account=await bitgetAccount(f.client);assert.ok(account instanceof BitgetUta);
  await account.prepare(symbol,3);assert.equal(f.state.leverage,'3');
  const before={...f.counts};
  const prechecked=await bitgetAccount(f.client);assert.ok(prechecked instanceof BitgetUta);
  assert.equal((await prechecked.assertTradingMode(symbol)).longLeverage,3);
  await (await bitgetAccount(f.client)).place(f.request,1,1.01);
  assert.equal(f.counts.settings,before.settings);assert.equal(f.counts.assets,before.assets);
  assert.equal(f.counts['uta-place'],1);assert.equal(f.sent[0].marginMode,'crossed');assert.equal(f.sent[0].timeInForce,'ioc');
  assert.equal(f.sent[0].qty,'1');assert.equal(f.sent[0].price,'1.01');assert.equal(f.sent[0].reduceOnly,'no');
});

test('native mode cache is isolated by client, exact symbol and new-symbol margin preference',async()=>{
  const f=fixture(),first=new BitgetUta(f.client,'isolated');await first.assertTradingMode(symbol);
  const initial=f.counts.assets;await new BitgetUta(f.client,'isolated').assertTradingMode(symbol);assert.equal(f.counts.assets,initial);
  await new BitgetUta(f.client,'crossed').assertTradingMode(symbol);assert.equal(f.counts.assets,initial+1);
  await new BitgetUta(f.client,'crossed').assertTradingMode(other);assert.equal(f.counts.assets,initial+2);
  const second=fixture();await new BitgetUta(second.client).assertTradingMode(symbol);assert.equal(second.counts.settings,1);assert.equal(second.counts.assets,1);
  assert.equal(f.counts['uta-place'],undefined);
});

test('fresh balances are never cached and invalidate previous mode/asset-health evidence before any subsequent order',async()=>{
  const f=fixture(),account=new BitgetUta(f.client);await account.assertTradingMode(symbol);
  f.state.available='88';assert.equal((await account.fetchAccount()).freeUsd,88);
  const before=f.counts.assets;await new BitgetUta(f.client).assertTradingMode(symbol);assert.equal(f.counts.assets,before+1);
  f.state.debt='1';await assert.rejects(account.fetchAccount(),/borrowed/);
  assert.equal(cachedBitgetAccountMode(f.client),undefined);
  await assert.rejects(new BitgetUta(f.client).place(f.request,1,1.01),/borrowed/);
  assert.equal(f.counts['uta-place'],undefined);
});

test('failed asset or settings reads clear existing route/mode proofs and never select Classic as a fallback',async()=>{
  const f=fixture(),account=new BitgetUta(f.client);await account.assertTradingMode(symbol);f.state.failAssets=true;
  await assert.rejects(account.fetchAccount(),/synthetic asset failure/);assert.equal(cachedBitgetAccountMode(f.client),undefined);
  f.state.failAssets=false;f.state.failSettings=true;
  await assert.rejects(bitgetAccount(f.client),/synthetic settings failure/);assert.equal(f.counts['classic-balances'],undefined);
  f.state.failSettings=false;await new BitgetUta(f.client).assertTradingMode(symbol);
  assert.equal(f.counts.assets,3);assert.equal(f.counts['uta-place'],undefined);
});

test('prepare always performs actual readback, including no-op settings, and a successful leverage ACK cannot create a proof',async()=>{
  const f=fixture(),account=new BitgetUta(f.client);await account.prepare(symbol,2);
  assert.equal(f.counts.settings,2);assert.equal(f.counts.assets,2);assert.equal(f.counts.leverage,undefined);
  await account.prepare(symbol,2);assert.equal(f.counts.settings,4);assert.equal(f.counts.assets,4);
  f.state.ignoreLeverageWrite=true;await assert.rejects(account.prepare(symbol,3),/could not be verified/);
  assert.equal(cachedBitgetAccountMode(f.client),undefined);
  const before=f.counts.assets;const checked=await new BitgetUta(f.client).assertTradingMode(symbol);
  assert.equal(checked.longLeverage,2);assert.equal(f.counts.assets,before+1);assert.equal(f.counts['uta-place'],undefined);
});

test('mode expiry forces a native reread that refuses a newly unsupported holding mode',async t=>{
  const f=fixture();let now=2_000_000;t.mock.method(Date,'now',()=>now);
  await new BitgetUta(f.client).assertTradingMode(symbol);f.state.holdMode='unknown';
  now+=BITGET_VERIFIED_CACHE_MS;
  await assert.rejects(new BitgetUta(f.client).place(f.request,1,1.01),/holding mode must be verified/);
  assert.equal(f.counts.settings,2);assert.equal(f.counts.assets,2);assert.equal(f.counts['uta-place'],undefined);
  assert.equal(cachedBitgetAccountMode(f.client),undefined);
});

test('slow settings replies cannot reset the two-second cache clock to their completion time',async t=>{
  const f=fixture();let now=3_000_000;t.mock.method(Date,'now',()=>now);
  const original=f.client.privateUtaGetV3AccountSettings;let slow=true;
  f.client.privateUtaGetV3AccountSettings=async(params:any)=>{const read=await original(params);if(slow){slow=false;now+=3000;}return read;};
  await new BitgetUta(f.client).assertTradingMode(symbol);
  assert.equal(cachedBitgetAccountMode(f.client),undefined);
  await new BitgetUta(f.client).assertTradingMode(symbol);assert.equal(f.counts.settings,2);assert.equal(f.counts.assets,2);
});

test('Classic caches only native mode/leverage fields and requires fresh readback after every preparation',async()=>{
  const f=fixture('hybrid'),account=new BitgetClassic(f.client);await account.prepare(symbol,3);
  assert.equal(f.counts['classic-mode'],2);
  const cached=await new BitgetClassic(f.client).assertTradingMode(symbol);assert.equal(f.counts['classic-mode'],2);
  assert.equal(cached.isolatedLongLever,'3');assert.equal(cached.available,undefined);assert.equal(cached.accountEquity,undefined);
  f.state.available='77';assert.equal((await account.fetchAccount()).freeUsd,77);
  await new BitgetClassic(f.client).assertTradingMode(symbol);assert.equal(f.counts['classic-mode'],3);
  await new BitgetClassic(f.client,5000,'crossed').assertTradingMode(symbol);assert.equal(f.counts['classic-mode'],4);
  f.state.ignoreLeverageWrite=true;await assert.rejects(account.prepare(symbol,4),/unable to verify/);
  const before=f.counts['classic-mode'];await new BitgetClassic(f.client).assertTradingMode(symbol);assert.equal(f.counts['classic-mode'],before+1);
});

test('credential changes and explicit close/reconfigure clear do not retain a mode grant across the same client object',async()=>{
  const f=fixture(),account=new BitgetUta(f.client);await account.assertTradingMode(symbol);
  const before=f.counts.assets;f.client.password='different-offline-passphrase';
  assert.equal(cachedBitgetAccountMode(f.client),undefined);await account.assertTradingMode(symbol);assert.equal(f.counts.assets,before+1);
  clearBitgetAccountCache(f.client);assert.equal(cachedBitgetAccountMode(f.client),undefined);
  await new BitgetUta(f.client).assertTradingMode(symbol);assert.equal(f.counts.assets,before+2);
});

test('a read started before invalidation cannot repopulate a closed/reconfigured route cache when it finishes late',async()=>{
  const f=fixture();let resolve!:(data:any)=>void;
  f.client.privateUtaGetV3AccountSettings=()=>new Promise(done=>{resolve=done;});
  const pending=bitgetAccount(f.client);clearBitgetAccountCache(f.client);
  resolve({code:'00000',data:{accountMode:'unified'}});assert.ok(await pending instanceof BitgetUta);
  assert.equal(cachedBitgetAccountMode(f.client),undefined);
});

test('native place or cancel failures immediately invalidate prior verified routing/mode evidence',async()=>{
  const uta=fixture();await new BitgetUta(uta.client).assertTradingMode(symbol);
  uta.client.privateUtaPostV3TradePlaceOrder=async()=>({code:'40014',data:null});
  await assert.rejects(new BitgetUta(uta.client).place(uta.request,1,1.01),/UTA response unavailable/);
  assert.equal(cachedBitgetAccountMode(uta.client),undefined);
  const before=uta.counts.assets;await new BitgetUta(uta.client).assertTradingMode(symbol);assert.equal(uta.counts.assets,before+1);
  const classic=fixture('hybrid');await bitgetAccount(classic.client);await new BitgetClassic(classic.client).assertTradingMode(symbol);
  classic.client.privateMixPostV2MixOrderCancelOrder=async()=>({code:'40014',data:null});
  await assert.rejects(new BitgetClassic(classic.client).cancel(symbol,'original-synthetic-id'),/classic USDT futures response unavailable/);
  assert.equal(cachedBitgetAccountMode(classic.client),undefined);
  const old=classic.counts['classic-mode'];await new BitgetClassic(classic.client).assertTradingMode(symbol);assert.equal(classic.counts['classic-mode'],old+1);
});
