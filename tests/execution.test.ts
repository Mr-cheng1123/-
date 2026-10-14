import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/core/store.js';
import { Execution } from '../src/core/execution.js';
import { defaultConfig } from './legacy-config.js';
import type { ExchangeAdapter, MarketSnapshot, OrderRequest, OrderResult, Position } from '../src/shared/types.js';
function setup(mode:'paper'|'live'='paper',adapter?:ExchangeAdapter){
  const dir=mkdtempSync(path.join(tmpdir(),'funding-arb-'));
  const store=new Store(path.join(dir,'state.json'),{...defaultConfig,mode,dataSource:mode==='live'?'public':'demo',maxOrderRetries:1});
  const snapshot:MarketSnapshot={exchange:'binance',base:'BTC',symbol:'BTC/USDT:USDT',timestamp:Date.now(),markPrice:100,indexPrice:100,fundingRate:.01,nextFundingTime:Date.now()+60000,intervalHours:8,fundingHistory:[],bids:[{price:100,quantity:100}],asks:[{price:100,quantity:100}],openInterestUsd:1e9,volume24hUsd:1e9,quantityStep:.01,minQuantity:.01,minNotional:1,contractSize:1,source:'demo'};
  const p:Position={id:'p1',base:'BTC',status:'opening',mode,long:{exchange:'binance',symbol:snapshot.symbol,side:'long',quantity:0,entryPrice:0,markPrice:100,feesUsd:0,liquidationDistancePct:50},short:{exchange:'bybit',symbol:snapshot.symbol,side:'short',quantity:0,entryPrice:0,markPrice:100,feesUsd:0,liquidationDistancePct:50},openedAt:Date.now(),plannedExitAt:Date.now()+60000,holdMode:'once',fundingUsd:0,feesUsd:0,transferCostUsd:0,spreadPnlUsd:0,realizedSpreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[]};
  store.data.positions.push(p);let halted=false;
  const venueSnapshots=new Map<string,MarketSnapshot>();
  const execution=new Execution(store,{config:()=>store.data.config,snapshot:x=>{
    const current=venueSnapshots.get(x)??{...snapshot,exchange:x as MarketSnapshot['exchange']};
    Object.assign(current,snapshot,{exchange:x},mode==='live'?{takerFeeRate:store.data.config.takerFees[x as keyof typeof store.data.config.takerFees],takerFeeAt:snapshot.timestamp,takerFeeSource:'exchange'}:{});
    venueSnapshots.set(x,current);return current;
  },
    adapter:()=>adapter!,liveUnlocked:()=>true,halt:()=>{halted=true;store.data.killSwitch=true;}});
  return {store,p,snapshot,execution,isHalted:()=>halted,cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}
test('paper open/close records all four fees and leaves zero exposure',async()=>{
  const s=setup();try{
    await s.execution.open(s.p,10,10);assert.equal(s.p.status,'open');assert.equal(s.p.deltaUsd,0);
    await s.execution.close(s.p,'test');assert.equal(s.p.status,'closed');
    assert.equal(s.p.long.quantity,0);assert.equal(s.p.short.quantity,0);assert.equal(s.store.data.orders.length,4);
    assert.equal(s.p.feesUsd,2.1);assert.equal(s.p.netPnlUsd,-2.1);
    await s.execution.close(s.p,'again');assert.equal(s.store.data.orders.length,4);
  }finally{s.cleanup();}
});
test('unknown live order is queried but never blindly submitted again',async()=>{
  let submits=0,queries=0;
  const adapter={placeOrder:async()=>{submits++;throw new Error('network timeout');},reconcileOrder:async(r:OrderRequest)=>{queries++;return {id:'',clientOrderId:r.clientOrderId,status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now()} as OrderResult;}} as unknown as ExchangeAdapter;
  const s=setup('live',adapter);try{
    await s.execution.open(s.p,10,10);assert.equal(submits,1);assert.ok(queries>=1);assert.equal(s.p.long.quantity,0);assert.equal(s.p.status,'attention');assert.equal(s.isHalted(),true);
    await assert.rejects(()=>s.execution.close(s.p,'test'),/未确认订单/);assert.equal(submits,1);
  }finally{s.cleanup();}
});
test('a cancelled short fill does not submit or unwind the long',async()=>{
  const adapter={placeOrder:async(r:OrderRequest)=>({id:r.clientOrderId,clientOrderId:r.clientOrderId,status:r.side==='sell'&&!r.reduceOnly?'cancelled':'filled',filledQuantity:r.side==='sell'&&!r.reduceOnly?0:r.quantity,averagePrice:100,feeUsd:0,timestamp:Date.now()} as OrderResult)} as unknown as ExchangeAdapter;
  const s=setup('live',adapter);try{
    await s.execution.open(s.p,10,10);assert.equal(s.p.status,'closed');assert.equal(s.p.long.quantity,0);assert.equal(s.p.short.quantity,0);
    assert.equal(s.store.data.orders.length,1,'a cancelled IOC is not repeated without a quote transport');assert.ok(s.store.data.orders.every(order=>order.request.side==='sell'&&!order.request.reduceOnly));
    assert.ok(s.p.closeReason?.includes('未提交'));assert.equal(s.store.data.orders.some(o=>o.request.reduceOnly),false);
  }finally{s.cleanup();}
});
test('partial close retains actual exposure and halts instead of claiming closed',async()=>{
  const s=setup();try{
    await s.execution.open(s.p,10,10);s.snapshot.bids=[{price:100,quantity:3}];s.snapshot.asks=[{price:100,quantity:4}];
    await s.execution.close(s.p,'test');assert.equal(s.p.status,'attention');assert.equal(s.p.long.quantity,7);assert.equal(s.p.short.quantity,6);assert.equal(s.isHalted(),true);
  }finally{s.cleanup();}
});
test('later order reconciliation applies only new cumulative fills and is idempotent',async()=>{
  let resolved=false;
  const adapter={placeOrder:async(r:OrderRequest)=>({id:r.clientOrderId,clientOrderId:r.clientOrderId,status:'unknown',filledQuantity:3,averagePrice:100,feeUsd:.15,timestamp:Date.now()}),reconcileOrder:async(r:OrderRequest)=>({id:r.clientOrderId,clientOrderId:r.clientOrderId,status:resolved?'filled':'unknown',filledQuantity:resolved?10:3,averagePrice:100,feeUsd:resolved?.5:.15,timestamp:Date.now()})} as unknown as ExchangeAdapter;
  const s=setup('live',adapter);try{
    await s.execution.open(s.p,10,10);assert.equal(s.p.long.quantity,0);assert.equal(s.p.short.quantity,3);
    resolved=true;await s.execution.reconcilePending();assert.equal(s.p.long.quantity,0);assert.equal(s.p.short.quantity,10);assert.ok(Math.abs(s.p.feesUsd-.5)<1e-10);
    await s.execution.reconcilePending();assert.equal(s.p.short.quantity,10);assert.ok(Math.abs(s.p.feesUsd-.5)<1e-10);
  }finally{s.cleanup();}
});

test('paper fee-only execution sweeps observed prices outside the ordinary slippage limit and records actual costs',async()=>{
  const s=setup();try{
    s.store.data.config.paperFeeOnly=true;
    s.snapshot.asks=[{price:100.2,quantity:.4},{price:100.4,quantity:.6}];
    s.snapshot.bids=[{price:99.8,quantity:.4},{price:99.6,quantity:.6}];
    await s.execution.open(s.p,1,1);
    assert.equal(s.p.status,'open');assert.equal(s.p.long.quantity,1);assert.equal(s.p.short.quantity,1);
    assert.ok(Math.abs(s.p.long.entryPrice-100.32)<1e-10);assert.ok(Math.abs(s.p.short.entryPrice-99.68)<1e-10);
    assert.equal(s.store.data.orders.find(order=>order.request.side==='buy')!.request.limitPrice,100.4);
    assert.equal(s.store.data.orders.find(order=>order.request.side==='sell')!.request.limitPrice,99.6);
    assert.equal(s.p.fundingUsd,0);
    await s.execution.close(s.p,'observed book test');
    assert.equal(s.p.status,'closed');assert.ok(Math.abs(s.p.feesUsd-.21)<1e-10);
    assert.ok(Math.abs(s.p.realizedSpreadPnlUsd+1.28)<1e-10);assert.ok(Math.abs(s.p.netPnlUsd+1.49)<1e-10);
  }finally{s.cleanup();}
});

test('entry needs its complete visible depth and an empty book cannot fabricate a mark-price order',async()=>{
  const s=setup();try{
    s.store.data.config.paperFeeOnly=true;s.snapshot.asks=[{price:105,quantity:.25}];
    await assert.rejects(()=>s.execution.order(s.p,s.p.long,'buy',1,false),/盘口不足/);
    assert.equal(s.p.long.quantity,0);assert.equal(s.store.data.orders.length,0);
    s.snapshot.asks=[];
    await assert.rejects(()=>s.execution.order(s.p,s.p.long,'buy',1,false),/没有可成交报价/);
    assert.equal(s.p.long.quantity,0);assert.equal(s.store.data.orders.length,0);
  }finally{s.cleanup();}
});

test('an entry order is limited to the book depth actually needed for its size',async()=>{
  let submitted:OrderRequest|undefined;
  const adapter={placeOrder:async(request:OrderRequest)=>{
    submitted=request;return {id:request.clientOrderId,clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now()} as OrderResult;
  }} as unknown as ExchangeAdapter;
  const live=setup('live',adapter);try{
    live.snapshot.asks=[{price:100.5,quantity:100}];
    await live.execution.order(live.p,live.p.long,'buy',1,false);
    assert.ok(submitted);assert.equal(submitted.limitPrice,100.5);assert.equal(live.p.long.quantity,0);
  }finally{live.cleanup();}
});

test('paper fee-only close keeps both legs when the latest venue quote is unavailable even if its cached timestamp is recent',async()=>{
  const s=setup();try{
    s.store.data.config.paperFeeOnly=true;await s.execution.open(s.p,1,1);
    const before=s.store.data.orders.length;
    s.execution.context.canUseSnapshot=exchange=>exchange!=='binance';
    await assert.rejects(s.execution.close(s.p,'scheduled settlement exit'),/最新可用盘口/);
    assert.equal(s.p.status,'open');assert.equal(s.p.long.quantity,1);assert.equal(s.p.short.quantity,1);assert.equal(s.store.data.orders.length,before);
    s.execution.context.canUseSnapshot=()=>true;
    await s.execution.close(s.p,'restored book');assert.equal(s.p.status,'closed');
  }finally{s.cleanup();}
});
