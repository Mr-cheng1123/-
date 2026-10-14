import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/core/store.js';
import { Execution } from '../src/core/execution.js';
import { sweep } from '../src/core/strategy.js';
import { defaultConfig } from './legacy-config.js';
import type { ExchangeAdapter, ExchangeId, MarketSnapshot, OrderRequest, OrderResult, Position } from '../src/shared/types.js';

const near=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-10,`${actual} != ${expected}`);
function setup(){
  const tempRoot=path.resolve(tmpdir()),dir=mkdtempSync(path.join(tempRoot,'funding-fee-live-mock-'));
  const store=new Store(path.join(dir,'state.json'),{...defaultConfig,mode:'live',dataSource:'public',feeOnly:true,orderNotionalUsd:100,
    maxOrderRetries:0,maxDeltaUsd:0,maxSlippageBps:1,exitSlippageBps:200,transferCostUsd:999,basisStressBps:999});
  const quotes=new Map<ExchangeId,MarketSnapshot>();
  for(const exchange of ['binance','bybit'] as const)quotes.set(exchange,{exchange,base:'BTC',symbol:'BTC/USDT:USDT',timestamp:Date.now(),
    markPrice:100,indexPrice:100,fundingRate:exchange==='bybit'?.01:0,nextFundingTime:Date.now()+60_000,intervalHours:8,
    fundingHistory:[],bids:[{price:99.8,quantity:.4},{price:99.6,quantity:.6},{price:90,quantity:100}],
    asks:[{price:100.2,quantity:.4},{price:100.4,quantity:.6},{price:110,quantity:100}],openInterestUsd:0,volume24hUsd:0,
    quantityStep:.01,minQuantity:.01,minNotional:1,contractSize:1,source:'public',
    takerFeeRate:store.data.config.takerFees[exchange],takerFeeAt:Date.now(),takerFeeSource:'exchange'});
  const p:Position={id:'live-mocked-fee-only',base:'BTC',status:'opening',mode:'live',feeOnly:true,
    long:{exchange:'binance',symbol:'BTC/USDT:USDT',side:'long',quantity:0,entryPrice:0,markPrice:100,feesUsd:0,liquidationDistancePct:null},
    short:{exchange:'bybit',symbol:'BTC/USDT:USDT',side:'short',quantity:0,entryPrice:0,markPrice:100,feesUsd:0,liquidationDistancePct:null},
    openedAt:Date.now(),plannedExitAt:Date.now()+60_000,holdMode:'once',fundingUsd:0,feesUsd:0,transferCostUsd:0,
    spreadPnlUsd:0,realizedSpreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[]};
  store.data.positions.push(p);
  const requests:Array<{exchange:ExchangeId;request:OrderRequest}>=[];
  let unlocked=true,halted=false;
  const makeAdapter=(exchange:ExchangeId)=>({placeOrder:async(request:OrderRequest):Promise<OrderResult>=>{
    assert.ok(store.data.orders.some(order=>order.request.clientOrderId===request.clientOrderId),'durable intent must precede a mock submit');
    requests.push({exchange,request});
    const snapshot=quotes.get(exchange)!,levels=(request.side==='buy'?snapshot.asks:snapshot.bids).filter(level=>request.side==='buy'?level.price<=request.limitPrice:level.price>=request.limitPrice);
    const result=sweep(levels,request.quantity);
    const feeUsd=request.reduceOnly?(exchange==='binance'?.23:.29):(exchange==='binance'?.17:.19);
    return {id:request.clientOrderId,clientOrderId:request.clientOrderId,status:result.filled>=request.quantity?'filled':result.filled>0?'partial':'cancelled',
      filledQuantity:result.filled,averagePrice:result.average,feeUsd:result.filled>0?feeUsd:0,timestamp:Date.now()};
  },reconcileOrder:async()=>{throw new Error('Unexpected reconciliation in a deterministic fill test');}} as unknown as ExchangeAdapter);
  const adapters=new Map<ExchangeId,ExchangeAdapter>([['binance',makeAdapter('binance')],['bybit',makeAdapter('bybit')]]);
  const execution=new Execution(store,{config:()=>store.data.config,snapshot:exchange=>quotes.get(exchange as ExchangeId),adapter:exchange=>adapters.get(exchange as ExchangeId)!,
    liveUnlocked:()=>unlocked,allowEntry:()=>!store.data.killSwitch,halt:()=>{halted=true;store.data.killSwitch=true;}});
  return {store,p,quotes,requests,adapters,execution,setUnlocked:(value:boolean)=>{unlocked=value;},halted:()=>halted,cleanup:()=>{
    const resolved=path.resolve(dir),relative=path.relative(tempRoot,resolved);
    assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(resolved).startsWith('funding-fee-live-mock-'));
    rmSync(resolved,{recursive:true,force:true});
  }};
}

test('live fee-only mock IOC reaches only the worst price needed for its quantity, beyond the removed slippage budget',async()=>{
  const s=setup();try{
    await s.execution.open(s.p,1,1);
    assert.equal(s.p.status,'open');assert.equal(s.requests.length,2);assert.equal(s.halted(),false);
    assert.equal(s.requests.find(x=>x.exchange==='binance')!.request.limitPrice,100.4);
    assert.equal(s.requests.find(x=>x.exchange==='bybit')!.request.limitPrice,99.6);
    assert.ok(s.requests.every(x=>x.request.quantity===1&&!x.request.reduceOnly));
    near(s.p.long.entryPrice,100.32);near(s.p.short.entryPrice,99.68);near(s.p.feesUsd,.36);near(s.p.deltaUsd,0);
    s.p.fundingUsd=.8151;
    await s.execution.close(s.p,'mock confirmed funding round');
    assert.equal(s.p.status,'closed');assert.equal(s.requests.length,4);assert.equal(s.halted(),false);
    assert.ok(s.requests.slice(2).every(x=>x.request.reduceOnly));
    near(s.p.feesUsd,.88);near(s.p.realizedSpreadPnlUsd,-1.28);near(s.p.netPnlUsd,.8151-1.28-.88);
    near(s.p.long.quantity,0);near(s.p.short.quantity,0);assert.equal(s.p.transferCostUsd,0);
  }finally{s.cleanup();}
});

test('fee-only configuration grants no execution permission and stale books cannot submit live orders',async()=>{
  const s=setup();try{
    s.setUnlocked(false);
    await assert.rejects(()=>s.execution.order(s.p,s.p.long,'buy',1,false),/未解锁/);
    assert.equal(s.requests.length,0);assert.equal(s.store.data.orders.length,0);
    s.setUnlocked(true);s.quotes.get('binance')!.timestamp=Date.now()-120_001;
    await assert.rejects(()=>s.execution.order(s.p,s.p.long,'buy',1,false),/行情过期/);
    assert.equal(s.requests.length,0);assert.equal(s.store.data.orders.length,0);
  }finally{s.cleanup();}
});

test('fee-only mock fills never replace reported actual fees with the configured estimate',async()=>{
  const s=setup();try{
    s.store.data.config.takerFees.binance=0;
    const result=await s.execution.order(s.p,s.p.long,'buy',.5,false);
    assert.equal(result.status,'filled');near(result.feeUsd,.17);near(s.p.long.feesUsd,.17);near(s.p.feesUsd,.17);
    assert.equal(s.requests[0].request.limitPrice,100.4);near(s.p.long.entryPrice,100.24);
    assert.equal(s.p.fundingUsd,0);
  }finally{s.cleanup();}
});

test('a partial short sizes the long to the filled quantity instead of opening an excess long',async()=>{
  const s=setup();try{
    for(const exchange of ['binance','bybit'] as const)s.adapters.set(exchange,{
      placeOrder:async(request:OrderRequest):Promise<OrderResult>=>{
        s.requests.push({exchange,request});
        const filledQuantity=request.reduceOnly?0:exchange==='binance'?request.quantity:request.quantity/2;
        return {id:request.clientOrderId,clientOrderId:request.clientOrderId,
          status:filledQuantity===request.quantity?'filled':filledQuantity>0?'partial':'cancelled',filledQuantity,
          averagePrice:filledQuantity>0?100:0,feeUsd:0,timestamp:Date.now()};
      },
    } as unknown as ExchangeAdapter);
    await s.execution.open(s.p,1,1);
    assert.equal(s.requests[0].exchange,'bybit');assert.equal(s.requests[0].request.quantity,1);
    assert.equal(s.requests[1].exchange,'binance');assert.equal(s.requests[1].request.quantity,.5);
    assert.equal(s.p.long.quantity,.5);assert.equal(s.p.short.quantity,.5);assert.equal(s.p.deltaUsd,0);
    assert.equal(s.p.status,'open');assert.equal(s.halted(),false);
    assert.equal(s.requests.filter(x=>x.request.reduceOnly).length,0,'the long is sized to the filled short, so no excess is opened');
    assert.equal(s.p.closeRequestedAt,undefined);
  }finally{s.cleanup();}
});
