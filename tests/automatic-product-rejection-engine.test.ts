import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../src/core/engine.js';
import {defaultConfig} from '../src/shared/config.js';
import {assertBybitEntryEligibility} from '../src/adapters/bybit-entry-eligibility.js';
import {OrderNotSubmittedError} from '../src/adapters/order-rejection.js';
import type {Store} from '../src/core/store.js';
import type {AppConfig,ExchangeAdapter,ExchangeId,MarketSnapshot,OrderRequest} from '../src/shared/types.js';

// Actual Engine -> strategy -> Execution preflight; all accounts/orders are memory-only.
function fixture(){
  const config:AppConfig={...structuredClone(defaultConfig),mode:'live',dataSource:'public',entryPolicy:'aligned',
    exchanges:['gate','bybit','bitget'],symbols:['OKTA'],orderNotionalUsd:100,holdMode:'adaptive',maxOrderRetries:0};
  const data={version:1,config,positions:[],orders:[],logs:[],equity:[],killSwitch:false,fundingSeen:[]};
  const store={data,save(){},log(level:string,message:string,positionId?:string){(data.logs as any[]).unshift({level,message,positionId,timestamp:Date.now()});}} as unknown as Store;
  const counts={account:0,inspect:0,prepare:0,fee:0,validate:0,post:0};
  const quotes=new Map<ExchangeId,MarketSnapshot>();let marker='stock',failure:unknown;
  const refresh=()=>{const now=Date.now();for(const exchange of config.exchanges){const old=quotes.get(exchange);
    quotes.set(exchange,{exchange,base:'OKTA',symbol:old?.symbol??'OKTA/USDT:USDT',source:'public',bookTransport:'websocket',
      timestamp:now,observedAt:now,fundingObservedAt:now,markPrice:100,indexPrice:100,
      fundingRate:exchange==='gate'?0:exchange==='bybit'?.01:.009,nextFundingTime:now+300000,intervalHours:8,fundingHistory:[],
      bids:[{price:exchange==='gate'?99.98:exchange==='bybit'?100.5:100.4,quantity:10}],
      asks:[{price:exchange==='gate'?100:exchange==='bybit'?100.52:100.42,quantity:10}],
      quantityStep:.001,minQuantity:.001,minNotional:5,contractSize:1,openInterestUsd:0,volume24hUsd:0,
      takerFeeRate:.0005,takerFeeAt:now,takerFeeSource:'exchange'});}};
  refresh();
  const adapters=config.exchanges.map(exchange=>({id:exchange,
    fetchSnapshots:async()=>{refresh();return [quotes.get(exchange)!];},
    fetchAccount:async()=>{counts.account++;return {freeUsd:1000,equityUsd:1000,positions:[]};},
    inspectTrading:async()=>{counts.inspect++;},prepareTrading:async()=>{counts.prepare++;},
    fetchTradingFee:async()=>{counts.fee++;return {takerFeeRate:.0005,takerFeeAt:Date.now(),takerFeeSource:'exchange' as const};},
    validateOrder:async(request:OrderRequest)=>{counts.validate++;if(exchange==='bybit'){if(failure)throw failure;
      assertBybitEntryEligibility({info:{symbolType:marker}},request);}},
    placeOrder:async(request:OrderRequest)=>{counts.post++;return {id:`offline-${counts.post}`,clientOrderId:request.clientOrderId,
      status:'filled' as const,filledQuantity:request.quantity,averagePrice:request.limitPrice,feeUsd:.01,timestamp:Date.now()};},
    fetchFundingPayments:async()=>[],reconcileOrder:async()=>{throw new Error('Unexpected offline reconcile');},
    cancelOrder:async()=>{throw new Error('Unexpected offline cancel');},close:async()=>{},
  } as ExchangeAdapter));
  const engine=new Engine(store,true,{adapterFactory:()=>adapters,liveEnvironment:{ALLOW_LIVE_TRADING:'true',LIVE_TRADING_ACK:'I_UNDERSTAND_THE_RISKS',
    GATE_API_KEY:'OFFLINE',GATE_API_SECRET:'OFFLINE',BYBIT_API_KEY:'OFFLINE',BYBIT_API_SECRET:'OFFLINE',BITGET_API_KEY:'OFFLINE',BITGET_API_SECRET:'OFFLINE',BITGET_PASSPHRASE:'OFFLINE'}});
  const internal=engine as any;engine.running=true;engine.autoEnabled=true;
  const ready=()=>{refresh();engine.snapshots=[...quotes.values()];internal.fundingEntryStability.clear();
    engine.health.forEach(h=>{h.status='online';h.lastSuccess=Date.now();h.accountStatus='ready';h.accountUpdatedAt=Date.now();});
    return engine.currentOpportunities();};
  ready();
  const candidate=(peer:ExchangeId='bybit')=>{const value=ready().find(o=>o.longExchange==='gate'&&o.shortExchange===peer)!;
    assert.ok(value);assert.equal(value.eligible,true,value.reasons.join(';'));assert.equal(value.fundingEntryStability?.status,'confirmed');return value;};
  return {engine,internal,store,adapters,quotes,counts,ready,candidate,setFailure:(v:unknown)=>{failure=v;},setMarker:(v:string)=>{marker=v;}};
}

test('real no-send product rejection suppresses repeated automatic private preparations and zero-intent records for five minutes',async t=>{
  const realNow=Date.now;let now=realNow();Date.now=()=>now;const f=fixture();
  t.after(async()=>{await f.engine.stop();Date.now=realNow;});
  const id=f.candidate().id;
  const otherProof={route:'other'};f.internal.realtimePrepared.set('OKTA-bybit-gate',otherProof);
  f.internal.realtimePrepared.set(id,{route:'rejected'});
  const first=await f.internal.openInternal(id,true);assert.equal(first.status,'closed');assert.equal(f.store.data.orders.length,0);
  assert.equal(f.internal.realtimePrepared.has(id),false);assert.equal(f.internal.realtimePrepared.get('OKTA-bybit-gate'),otherProof);
  // The unrelated placeholder is not a usable financial proof and is removed before normal warmup.
  f.internal.realtimePrepared.delete('OKTA-bybit-gate');
  assert.equal(f.counts.post,0);assert.ok(f.counts.account>0);const before={...f.counts};const records=f.store.data.positions.length;
  now+=16000;f.ready();
  await assert.rejects(f.internal.openInternal(id,true),/产品准入.*冷却/);
  // Warm/preview preparation is route-scoped too; isolate it from the valid Bitget route.
  const detailed=f.internal.detailedOpportunities.bind(f.internal);f.internal.detailedOpportunities=(...args:any[])=>detailed(...args).filter((o:any)=>o.id===id);
  await f.internal.warmRealtimeEntries();
  await f.internal.refreshEntryContractPreviews();f.internal.detailedOpportunities=detailed;
  assert.deepEqual(f.counts,before);assert.equal(f.store.data.positions.length,records);
  assert.equal(f.store.data.logs.filter(l=>l.message.includes('双腿下单前校验失败')).length,1);
  // Expiry does not grant access: the whole normal path is read again and the same guard still rejects.
  now+=300000;f.ready();const retried=await f.internal.openInternal(id,true);
  assert.equal(retried.status,'closed');assert.ok(f.counts.account>before.account);assert.ok(f.counts.prepare>before.prepare);
  assert.equal(f.counts.post,0);assert.equal(f.store.data.positions.length,records+1);
});

test('polling and websocket automatic selection skip the cached route while routine account reads continue',async t=>{
  const realNow=Date.now;let now=realNow();Date.now=()=>now;const f=fixture();
  t.after(async()=>{await f.engine.stop();Date.now=realNow;});
  const id=f.candidate().id;await f.internal.openInternal(id,true);now+=16000;f.ready();
  const detailed=f.internal.detailedOpportunities.bind(f.internal);f.internal.detailedOpportunities=(...args:any[])=>detailed(...args).filter((o:any)=>o.id===id);
  const open=f.internal.openInternal.bind(f.internal);let attempts=0;f.internal.openInternal=(...args:any[])=>{attempts++;return open(...args);};
  const before={...f.counts};await f.engine.tick();f.internal.onRealtimeSignal();await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(attempts,0);assert.equal(f.store.data.positions.length,1);assert.equal(f.counts.post,0);
  assert.ok(f.counts.account>before.account,'existing routine account observation must continue');
  assert.equal(f.counts.prepare,before.prepare);assert.equal(f.counts.validate,before.validate);assert.equal(f.counts.fee,before.fee);
});

test('a denied Bybit route does not cool another valid venue route for the same base',async t=>{
  const realNow=Date.now;let now=realNow();Date.now=()=>now;const f=fixture();
  t.after(async()=>{await f.engine.stop();Date.now=realNow;});
  await f.internal.openInternal(f.candidate().id,true);now+=16000;
  const other=await f.internal.openInternal(f.candidate('bitget').id,true);
  assert.equal(other.status,'open');assert.ok(f.counts.post>0);assert.equal(f.store.data.orders.some(o=>o.exchange==='bybit'),false);
});

test('explicit manual preparation remains available during automatic product cooldown and still enforces product access',async t=>{
  const realNow=Date.now;let now=realNow();Date.now=()=>now;const f=fixture();
  t.after(async()=>{await f.engine.stop();Date.now=realNow;});
  const id=f.candidate().id;await f.internal.openInternal(id,true);const accounts=f.counts.account;
  now+=16000;f.ready();const manual=await f.internal.openInternal(id,false);
  assert.equal(manual.status,'closed');assert.equal(manual.automaticEntry,false);assert.ok(f.counts.account>accounts);assert.equal(f.counts.post,0);
});

test('ordinary errors and other typed rejection codes do not acquire the product-specific cooldown',async t=>{
  const realNow=Date.now;let now=realNow();Date.now=()=>now;const f=fixture();
  t.after(async()=>{await f.engine.stop();Date.now=realNow;});
  for(const error of [Object.assign(new Error('UNVERIFIED_PRODUCT_ACCESS'),{rejectionCode:'UNVERIFIED_PRODUCT_ACCESS'}),
    new OrderNotSubmittedError('other','INVALID_ORDER_SIZE','other')]){
    f.setFailure(error);const id=f.candidate().id;await f.internal.openInternal(id,true);const accounts=f.counts.account;
    now+=16000;f.ready();const repeated=await f.internal.openInternal(id,true);
    assert.equal(repeated.status,'closed');assert.ok(f.counts.account>accounts);now+=16000;
  }
  assert.equal(f.counts.post,0);
});

test('changed contract symbol, config identity or adapter identity requires a fresh normal product check',async t=>{
  const realNow=Date.now;let now=realNow();Date.now=()=>now;const f=fixture();
  t.after(async()=>{await f.engine.stop();Date.now=realNow;});
  const id=f.candidate().id;await f.internal.openInternal(id,true);
  for(const mutate of [()=>{for(const quote of f.quotes.values())quote.symbol='OKTA/USDT';},
    ()=>{f.store.data.config={...f.store.data.config};},()=>{f.engine.adapters=f.engine.adapters.map(a=>a.id==='bybit'?{...a}:a);}]){
    now+=16000;mutate();f.ready();const accounts=f.counts.account;const retried=await f.internal.openInternal(id,true);
    assert.equal(retried.status,'closed');assert.ok(f.counts.account>accounts);assert.equal(f.counts.post,0);
  }
});
