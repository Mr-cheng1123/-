import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfig} from '../src/shared/config.js';
import type {ExchangeAdapter,ExchangeId,LivePortfolio,MarketSnapshot,Position} from '../src/shared/types.js';
import {Engine} from '../src/core/engine.js';
import type {Store} from '../src/core/store.js';

function fixture(){
  const now=Date.now(),config={...defaultConfig,mode:'live' as const,entryPolicy:'aligned' as const,
    orderNotionalUsd:100,exchanges:['gate','bybit'] as ExchangeId[],symbols:['BTC']};
  let financialCalls=0;
  const store={data:{version:1,config,positions:[],orders:[],logs:[],equity:[],killSwitch:false,fundingSeen:[]},save(){},log(){}} as unknown as Store;
  const adapters=config.exchanges.map(exchange=>({id:exchange,fetchSnapshots:async()=>[],
    fetchAccount:async()=>({freeUsd:1000,equityUsd:1000,positions:[]}),
    inspectTrading:async()=>{},
    prepareTrading:async()=>{financialCalls++;},placeOrder:async()=>{financialCalls++;throw new Error('Unexpected trade');},
    cancelOrder:async()=>{financialCalls++;},close:async()=>{},fetchFundingPayments:async()=>[],
    reconcileOrder:async()=>{throw new Error('Unexpected reconciliation');},
  } as ExchangeAdapter));
  const engine=new Engine(store,false,{adapterFactory:()=>adapters,liveEnvironment:{
    GATE_API_KEY:'OFFLINE',GATE_API_SECRET:'OFFLINE',BYBIT_API_KEY:'OFFLINE',BYBIT_API_SECRET:'OFFLINE'}});
  engine.snapshots=config.exchanges.map(exchange=>({exchange,base:'BTC',symbol:'BTC/USDT:USDT',timestamp:now,observedAt:now,
    markPrice:100,indexPrice:100,fundingRate:exchange==='bybit'?.001:0,nextFundingTime:now+3600000,intervalHours:8,
    fundingHistory:[],bids:[{price:exchange==='gate'?99.99:100.5,quantity:10}],asks:[{price:exchange==='gate'?100:100.51,quantity:10}],
    quantityStep:.001,minQuantity:.001,minNotional:5,contractSize:1,openInterestUsd:0,volume24hUsd:0,source:'public',
    takerFeeRate:exchange==='bybit'?.00055:.0005,takerFeeAt:now,takerFeeSource:'exchange'} as MarketSnapshot));
  const portfolio:LivePortfolio={timestamp:now,pollIntervalMs:5000,maxAgeMs:15000,exchanges:config.exchanges.map(exchange=>({
    exchange,credentialsConfigured:true,status:'ready',requestedAt:now,receivedAt:now,freeUsd:1000,equityUsd:1000,positions:[]}))};
  const observe=async()=>{await engine.observeAccountClosures(portfolio);await new Promise<void>(resolve=>setImmediate(resolve));};
  return {engine,store,portfolio,observe,financialCalls:()=>financialCalls};
}

test('fresh account GETs make a candidate ready before startup without granting execution or submitting intents',async()=>{
  const f=fixture();assert.equal(f.engine.currentOpportunities()[0].entryReady,false);
  await f.observe();
  const opportunity=f.engine.currentOpportunities()[0];assert.equal(opportunity.entryReady,true);assert.equal(opportunity.eligible,false);
  assert.equal(f.engine.liveUnlocked,false);assert.equal(f.engine.autoEnabled,false);
  await assert.rejects(f.engine.open(opportunity.id));assert.equal(f.store.data.orders.length,0);assert.equal(f.financialCalls(),0);
});

test('explicit startup authorizes the same ready opportunity and enables selection without placing during preview',async()=>{
  const f=fixture();await f.observe();
  const before=f.engine.currentOpportunities()[0];assert.equal(before.entryReady,true);assert.equal(before.eligible,false);
  await f.engine.startLive('START_LIVE_TRADING');
  const after=f.engine.currentOpportunities().find(item=>item.id===before.id)!;
  assert.equal(after.entryReady,true);assert.equal(after.eligible,true);assert.equal(f.engine.autoEnabled,true);
  assert.equal(f.store.data.orders.length,0);assert.equal(f.financialCalls(),0);
});

test('preview does not advertise stale, insufficient or occupied accounts as ready',async()=>{
  for(const kind of ['stale','insufficient','occupied'] as const){
    const f=fixture(),row=f.portfolio.exchanges[0];
    if(kind==='stale')row.requestedAt=Date.now()-16000;
    if(kind==='insufficient')row.freeUsd=1;
    if(kind==='occupied')row.positions=[{base:'BTC',symbol:'BTC/USDT:USDT',side:'long',quantity:1,markPrice:100,leverage:2,liquidationPrice:0}];
    await f.observe();assert.equal(f.engine.currentOpportunities()[0].entryReady,false,kind);
    assert.equal(f.financialCalls(),0);
  }
});

test('stop remains blocked in the startup-independent preview',async()=>{
  const f=fixture();await f.observe();
  f.store.data.killSwitch=true;assert.equal(f.engine.currentOpportunities()[0].entryReady,false);
  assert.equal(f.financialCalls(),0);
});

test('ordinary startup preview accepts positive 5 and 20 bps before execution is enabled',async()=>{
  assert.equal(defaultConfig.minEntryIocEdgeBps,0);
  for(const shortBid of [100.05,100.2]){
    const f=fixture();f.engine.snapshots[1].bids=[{price:shortBid,quantity:10}];
    await f.observe();
    const before=f.engine.currentOpportunities()[0];
    assert.equal(before.entryReady,true);assert.equal(before.eligible,false);assert.equal(f.financialCalls(),0);
    await f.engine.startLive('START_LIVE_TRADING');
    const after=f.engine.currentOpportunities().find(item=>item.id===before.id)!;
    assert.equal(after.entryReady,true);assert.equal(after.eligible,true);assert.equal(f.financialCalls(),0);
    assert.equal(f.store.data.orders.length,0);
  }
});

test('ordinary preview rejects zero and negative IOC edge while explicit 20 bps retains its strict boundary',async()=>{
  for(const shortBid of [100,99.99]){
    const f=fixture();f.engine.snapshots[1].bids=[{price:shortBid,quantity:10}];
    await f.observe();
    assert.equal(f.engine.currentOpportunities()[0].entryReady,false);assert.equal(f.financialCalls(),0);
  }
  const f=fixture();f.store.data.config.minEntryIocEdgeBps=20;
  f.engine.snapshots[1].bids=[{price:100.2,quantity:10}];
  await f.observe();
  assert.equal(f.engine.currentOpportunities()[0].entryReady,false);assert.equal(f.financialCalls(),0);
});

test('changing exit thresholds discards prior confirmations and decisions without any financial call',async()=>{
  for(const change of [{exitWeakFundingBps:3},{minExitProfitUsd:.20}]){
    const f=fixture(),now=Date.now(),decision={action:'close' as const,reason:'old profit decision',expectedFundingUsd:0,
      incrementalCostUsd:0,expectedNetUsd:0,targetFundingTime:now+3600000,nextReviewAt:now+5000,exitSignal:'profit' as const};
    const p:Position={id:'offline-restore',base:'BTC',mode:'live',entryPolicy:'aligned',status:'open',holdMode:'adaptive',
      long:{exchange:'gate',symbol:'BTC/USDT:USDT',side:'long',quantity:1,entryPrice:100,markPrice:100,feesUsd:.05,liquidationDistancePct:null},
      short:{exchange:'bybit',symbol:'BTC/USDT:USDT',side:'short',quantity:1,entryPrice:101,markPrice:100,feesUsd:.05,liquidationDistancePct:null},
      openedAt:now-600000,plannedExitAt:now+3600000,fundingUsd:0,feesUsd:.10,transferCostUsd:0,spreadPnlUsd:0,
      realizedSpreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[],holdDecision:decision};
    f.store.data.positions.push(p);
    const internal=f.engine as unknown as {holdingSamples:Map<string,unknown>};
    internal.holdingSamples.set(p.id,{action:'close',count:2,longAt:now,shortAt:now,targetFundingTime:decision.targetFundingTime,exitSignal:'profit'});
    await f.engine.updateConfig(change);
    assert.equal(internal.holdingSamples.size,0);assert.equal(p.holdDecision,undefined);
    assert.equal(p.status,'open');assert.equal(p.closeRequestedAt,undefined);
    assert.equal(f.engine.liveUnlocked,false);assert.equal(f.engine.autoEnabled,false);
    assert.equal(f.store.data.orders.length,0);assert.equal(f.financialCalls(),0);
  }
});
