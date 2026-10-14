import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {defaultConfig,validateConfig} from '../src/shared/config.js';
import type {AppConfig,ExchangeAdapter,ExchangeId,MarketSnapshot,OrderRequest} from '../src/shared/types.js';
import {SpreadHistory} from '../src/core/spread-history.js';
import {calculateOpportunities} from '../src/core/strategy.js';
import {Engine} from '../src/core/engine.js';
import {Store} from '../src/core/store.js';
import {configUpdatePolicy} from '../src/shared/config-update-policy.js';

const settings=(extra:Partial<AppConfig>={}):AppConfig=>({...defaultConfig,mode:'live',feeOnly:true,dualAdvantageEnabled:true,
  exchanges:['gate','bybit'],symbols:['BTC'],orderNotionalUsd:100,holdMode:'once',...extra});
function quote(exchange:ExchangeId,at:number,change:Partial<MarketSnapshot>={}):MarketSnapshot{
  return {exchange,base:'BTC',symbol:'BTC/USDT:USDT',timestamp:at,observedAt:at,markPrice:100,indexPrice:100,
    fundingRate:exchange==='bybit'?.006:0,nextFundingTime:at+300000,intervalHours:8,fundingHistory:[],
    bids:[{price:exchange==='gate'?99.98:100.5,quantity:100}],asks:[{price:exchange==='gate'?100:100.52,quantity:100}],
    openInterestUsd:1e7,volume24hUsd:1e8,quantityStep:.001,minQuantity:.001,minNotional:5,contractSize:1,source:'public',
    takerFeeRate:exchange==='bybit'?.00055:.0005,takerFeeAt:at,takerFeeSource:'exchange',...change};
}
const exitQuote=(exchange:ExchangeId,at:number,change:Partial<MarketSnapshot>={})=>exchange==='gate'?quote(exchange,at,change):
  quote(exchange,at,{bids:[{price:100.1,quantity:100}],asks:[{price:100.12,quantity:100}],...change});
function seeded(now:number,c:AppConfig,skewMs=0){
  const h=new SpreadHistory();
  for(let i=12;i>=1;i--){const at=now-i*15000;h.observe([quote('gate',at),exitQuote('bybit',at,{observedAt:at+skewMs})],c,at);}
  return h;
}

test('quotes fetched too far apart cannot qualify, even when the spread itself looks good',()=>{
  const now=Date.now(),c=settings(),h=seeded(now,c);
  const [synced]=calculateOpportunities([quote('gate',now),quote('bybit',now)],c,now,h);
  assert.equal(synced.eligible,true);
  const [skewed]=calculateOpportunities([quote('gate',now),quote('bybit',now,{observedAt:now+c.maxQuoteSkewMs+1})],c,now,h);
  assert.equal(skewed.eligible,false);assert.ok(skewed.reasons.some(r=>r.includes('采集时间')));
  // Venues that report no fetch time (demo data, restored ledgers) are not penalised.
  const [unknown]=calculateOpportunities([quote('gate',now,{observedAt:undefined}),quote('bybit',now,{observedAt:undefined})],c,now,h);
  assert.equal(unknown.eligible,true);
});

test('skewed pairs never enter the spread baseline',()=>{
  const now=Date.now(),c=settings();
  const clean=seeded(now,c).serialize(),polluted=seeded(now,c,c.maxQuoteSkewMs+500).serialize();
  assert.equal(clean.length,24);   // 12 observation rounds × both directions
  assert.equal(polluted.length,0);
});

test('skew and loss-guard settings validate, default safely and can be saved while positions exist',()=>{
  assert.equal(defaultConfig.maxQuoteSkewMs,3000);
  assert.throws(()=>validateConfig({...defaultConfig,maxQuoteSkewMs:50}));
  const policy=configUpdatePolicy(defaultConfig,{...defaultConfig,maxQuoteSkewMs:5000});
  assert.equal(policy.entryOnly,true);assert.deepEqual(policy.criticalFields,[]);
  const {maxQuoteSkewMs:_a,...legacy}=defaultConfig;
  assert.equal(validateConfig(legacy).maxQuoteSkewMs,3000);
});

function fixture(extra:Partial<AppConfig>={}){
  const now=Date.now(),c=settings(extra),dir=mkdtempSync(path.join(tmpdir(),'quote-guards-'));
  const store=new Store(path.join(dir,'state.json'),c);store.data.spreadObservations=seeded(now,c).serialize();
  const quotes=new Map<ExchangeId,MarketSnapshot>([['gate',quote('gate',now)],['bybit',quote('bybit',now)]]);
  const requests:OrderRequest[]=[];
  const adapters=c.exchanges.map(exchange=>({id:exchange,fetchSnapshots:async()=>[quotes.get(exchange)!],
    fetchAccount:async()=>({freeUsd:1000,equityUsd:1000,positions:[]}),inspectTrading:async()=>{},prepareTrading:async()=>{},validateOrder:async()=>{},
    placeOrder:async(request:OrderRequest)=>{requests.push(request);return {id:'M'+requests.length,clientOrderId:request.clientOrderId,status:'filled' as const,
      filledQuantity:request.quantity,averagePrice:request.limitPrice,feeUsd:0,timestamp:Date.now()};},
    reconcileOrder:async()=>{throw new Error('unexpected');},cancelOrder:async()=>{throw new Error('unexpected');},fetchFundingPayments:async()=>[],close:async()=>{}} as ExchangeAdapter));
  const engine=new Engine(store,true,{adapterFactory:()=>adapters,liveEnvironment:{ALLOW_LIVE_TRADING:'true',LIVE_TRADING_ACK:'I_UNDERSTAND_THE_RISKS',
    GATE_API_KEY:'OFFLINE-ONLY',GATE_API_SECRET:'OFFLINE-ONLY',BYBIT_API_KEY:'OFFLINE-ONLY',BYBIT_API_SECRET:'OFFLINE-ONLY'}});
  engine.snapshots=[...quotes.values()];engine.health.forEach(h=>{h.status='online';h.lastSuccess=now;});
  return {store,engine,quotes,requests};
}

test('an entry that sent orders but did not end as a hedge pauses that coin instead of re-paying fees every tick',async()=>{
  const f=fixture(),o=f.engine.currentOpportunities()[0];assert.equal(o.eligible,true);
  // Simulate a rollback: an order intent was journalled, the pair ended closed.
  f.engine.execution.open=async p=>{f.store.data.orders.push({positionId:p.id,exchange:'gate',createdAt:Date.now(),
    request:{clientOrderId:'rolled-back',base:p.base,symbol:p.long.symbol,side:'buy',quantity:1,limitPrice:100,reduceOnly:false},
    result:{id:'x',clientOrderId:'rolled-back',status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now()}});p.status='closed';};
  await f.engine.open(o.id);
  const after=f.engine.currentOpportunities()[0];
  assert.equal(after.eligible,false);assert.ok(after.reasons.some(r=>r.includes('冷却')));
  await assert.rejects(f.engine.open(o.id),/冷却/);
  // The cooldown is bounded: it expires by itself.
  (f.engine as unknown as {entryCooldowns:Map<string,number>}).entryCooldowns.set('BTC',Date.now()-1);
  assert.equal(f.engine.currentOpportunities()[0].eligible,true);
});

test('a failed pre-check that sent no order does not start a cooldown',async()=>{
  const f=fixture(),o=f.engine.currentOpportunities()[0];
  f.engine.execution.open=async()=>{throw new Error('pre-check failed');};
  await f.engine.open(o.id);
  assert.equal(f.store.data.orders.length,0);assert.equal(f.engine.currentOpportunities()[0].eligible,true);
});
