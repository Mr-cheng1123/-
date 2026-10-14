import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {defaultConfig} from '../src/shared/config.js';
import type {AppConfig,ExchangeAdapter,ExchangeId,MarketSnapshot,OrderRequest} from '../src/shared/types.js';
import {Engine} from '../src/core/engine.js';
import {Store} from '../src/core/store.js';

// Full Engine → Execution path; all account responses and IOC fills are in memory, with no network transport.
function fixture(overrides:Partial<AppConfig>={}){
  const tempRoot=path.resolve(tmpdir()),dir=mkdtempSync(path.join(tempRoot,'funding-repair-offline-'));
  const config:AppConfig={...defaultConfig,entryPolicy:'funding',mode:'live',exchanges:['gate','bybit'],symbols:['BTC'],
    orderNotionalUsd:100,minCombinedNetUsd:.04,holdMode:'once',takerFees:{...defaultConfig.takerFees},...overrides};
  const now=Date.now(),quotes=new Map<ExchangeId,MarketSnapshot>();
  for(const exchange of config.exchanges)quotes.set(exchange,{exchange,base:'BTC',symbol:'BTC/USDT:USDT',timestamp:now,
    observedAt:now,markPrice:100,indexPrice:100,fundingRate:exchange==='bybit'?.006:0,nextFundingTime:now+300_000,
    intervalHours:8,fundingHistory:[],bids:[{price:exchange==='gate'?99.98:99.9,quantity:5}],
    asks:[{price:exchange==='gate'?100:99.92,quantity:5}],openInterestUsd:0,volume24hUsd:0,
    quantityStep:.001,minQuantity:.001,minNotional:5,contractSize:1,source:'public',
    takerFeeRate:exchange==='bybit'?.00055:.0005,takerFeeAt:now,takerFeeSource:'exchange'});
  const store=new Store(path.join(dir,'state.json'),config),requests:Array<{exchange:ExchangeId;request:OrderRequest}>=[];
  let initialLong=true,afterBothFills:()=>void=()=>{},privateChecks=0;
  const adapters=config.exchanges.map(exchange=>({id:exchange,
    fetchSnapshots:async()=>{const quote=quotes.get(exchange)!;quote.timestamp=quote.observedAt=Date.now();return [quote];},
    fetchAccount:async()=>{privateChecks++;return {freeUsd:1_000,equityUsd:1_000,positions:[]};},
    inspectTrading:async()=>{},prepareTrading:async()=>{},validateOrder:async()=>{},
    placeOrder:async(request:OrderRequest)=>{
      requests.push({exchange,request});
      const partial=exchange==='gate'&&!request.reduceOnly&&initialLong;
      if(partial)initialLong=false;
      const quantity=partial?request.quantity/2:request.quantity;
      if(requests.length===2)afterBothFills();
      return {id:'OFFLINE-'+requests.length,clientOrderId:request.clientOrderId,status:partial?'partial' as const:'filled' as const,
        filledQuantity:quantity,averagePrice:request.limitPrice,feeUsd:quantity*request.limitPrice*config.takerFees[exchange],timestamp:Date.now()};
    },reconcileOrder:async()=>{throw new Error('No unexpected reconciliation');},
    cancelOrder:async()=>{throw new Error('No unexpected cancel');},fetchFundingPayments:async()=>[],close:async()=>{}} as ExchangeAdapter));
  const engine=new Engine(store,true,{adapterFactory:()=>adapters,liveEnvironment:{ALLOW_LIVE_TRADING:'true',LIVE_TRADING_ACK:'I_UNDERSTAND_THE_RISKS',
    GATE_API_KEY:'OFFLINE-ONLY',GATE_API_SECRET:'OFFLINE-ONLY',BYBIT_API_KEY:'OFFLINE-ONLY',BYBIT_API_SECRET:'OFFLINE-ONLY'}});
  engine.snapshots=[...quotes.values()];engine.health.forEach(h=>{h.status='online';h.lastSuccess=now;});
  return {engine,store,quotes,requests,privateChecks:()=>privateChecks,setAfterFills:(fn:()=>void)=>{afterBothFills=fn;},cleanup:()=>{
    const relative=path.relative(tempRoot,path.resolve(dir));assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
    assert.ok(path.basename(dir).startsWith('funding-repair-offline-'));rmSync(dir,{recursive:true,force:true});
  }};
}

test('Engine allows a profitable funding repair when a hypothetical new full pair has insufficient open depth and minimum notional',async()=>{
  const f=fixture();try{
    const initial=f.engine.currentOpportunities()[0];assert.equal(initial.eligible,true);
    f.setAfterFills(()=>{
      // Only another half-long is needed. The already-filled short bid is gone, but buying back that short remains priced.
      f.quotes.get('gate')!.asks=[{price:100.5,quantity:.5}];f.quotes.get('bybit')!.bids=[];
    });
    const p=await f.engine.open(initial.id);
    assert.equal(p.status,'open');assert.equal(p.entryPolicy,'funding');assert.equal(p.long.quantity,1);assert.equal(p.short.quantity,1);
    assert.equal(p.long.entryPrice,100.25);assert.equal(f.requests.length,3);assert.ok(f.requests.every(o=>!o.request.reduceOnly));
    assert.ok(f.privateChecks()>=2,'account reads remain part of the authorized entry path');
    const full=f.engine.currentOpportunities().find(o=>o.id===initial.id)!;
    assert.equal(full.spreadAdvantage!.status,'warming');assert.equal(full.combinedExpectedNetUsd,null);
    assert.equal(full.checks!.find(c=>c.label==='四边开平仓盘口够成交整笔数量')!.pass,false);
    assert.equal(full.checks!.find(c=>c.label==='数量达到交易所最小下单量')!.pass,false);
  }finally{f.cleanup();}
});

test('actual supplementary minimum notional remains enforced after dropping hypothetical full-pair checks',async()=>{
  const f=fixture();try{
    const id=f.engine.currentOpportunities()[0].id;
    f.setAfterFills(()=>{f.quotes.get('gate')!.minNotional=60;});
    const p=await f.engine.open(id);
    assert.equal(f.requests.filter(o=>!o.request.reduceOnly).length,2);
    assert.ok(f.requests.some(o=>o.request.reduceOnly));assert.equal(p.long.quantity,.5);assert.equal(p.short.quantity,.5);
  }finally{f.cleanup();}
});

test('full hypothetical IOC net failure does not block an actual profitable funding repair',async()=>{
  const f=fixture();try{
    const id=f.engine.currentOpportunities()[0].id;
    f.setAfterFills(()=>{f.quotes.get('gate')!.asks=[{price:100.5,quantity:5}];});
    const p=await f.engine.open(id);
    assert.equal(p.status,'open');assert.equal(p.long.quantity,1);assert.equal(p.short.quantity,1);
    assert.equal(p.long.entryPrice,100.25);assert.equal(f.requests.length,3);assert.ok(f.requests.every(order=>!order.request.reduceOnly));
    const freshFull=f.engine.currentOpportunities().find(o=>o.id===id)!;
    assert.ok(freshFull.entryLimitNetUsd!<0);
    assert.equal(freshFull.checks!.find(check=>check.label==='实际 IOC 限价净收益达标')!.pass,false);
  }finally{f.cleanup();}
});

test('valid closing depth is still mandatory for the actual full matched funding hedge',async()=>{
  const f=fixture();try{
    const id=f.engine.currentOpportunities()[0].id;
    f.setAfterFills(()=>{f.quotes.get('gate')!.asks=[{price:100.5,quantity:.5}];f.quotes.get('gate')!.bids=[{price:99.98,quantity:.5}];});
    const p=await f.engine.open(id);
    assert.equal(f.requests.filter(o=>!o.request.reduceOnly).length,2);assert.ok(f.requests.some(o=>o.request.reduceOnly));
    assert.equal(p.long.quantity,.5);assert.equal(p.short.quantity,.5);
  }finally{f.cleanup();}
});

test('manual cancellation generation still prevents a funding supplement even when its economics would profit',async()=>{
  const f=fixture();try{
    const id=f.engine.currentOpportunities()[0].id;
    f.setAfterFills(()=>{void f.engine.control('pause');});
    const p=await f.engine.open(id);
    assert.equal(f.requests.filter(o=>!o.request.reduceOnly).length,2);assert.ok(f.requests.some(o=>o.request.reduceOnly));
    assert.equal(p.long.quantity,.5);assert.equal(p.short.quantity,.5);
  }finally{f.cleanup();}
});

test('aligned Engine opens and repairs a positive price/funding pair even when one round cannot repay fees',async()=>{
  const f=fixture({entryPolicy:'aligned',holdMode:'adaptive'});try{
    const short=f.quotes.get('bybit')!;short.markPrice=101;short.fundingRate=.0005;
    short.bids=[{price:101,quantity:5}];short.asks=[{price:101.02,quantity:5}];
    const initial=f.engine.currentOpportunities()[0];
    assert.equal(initial.eligible,true);assert.ok(initial.combinedExpectedNetUsd!<0);assert.ok(initial.entryLimitPriceEdgeBps!>0);
    f.setAfterFills(()=>{
      // The already executed short bid and future close books may disappear; only a half-long still needs entry.
      f.quotes.get('gate')!.asks=[{price:100.5,quantity:.5}];f.quotes.get('gate')!.bids=[];
      short.bids=[];short.asks=[];
    });
    const p=await f.engine.open(initial.id);
    assert.equal(p.status,'open');assert.equal(p.entryPolicy,'aligned');assert.equal(p.holdMode,'adaptive');
    assert.equal(p.long.quantity,1);assert.equal(p.short.quantity,1);
    assert.equal(p.long.entryPrice,100.25);assert.equal(p.short.entryPrice,101);
    assert.equal(f.requests.length,3);assert.ok(f.requests.every(order=>!order.request.reduceOnly));
    assert.ok(p.profitExitPolicy,'actual accrued profit can later be captured without changing the entry condition');
    // Before the first funding settlement, a small positive carry must not immediately trigger the old fee-based exit.
    const long=f.quotes.get('gate')!;
    long.bids=[{price:100,quantity:5}];long.asks=[{price:100.5,quantity:5}];
    short.bids=[{price:101,quantity:5}];short.asks=[{price:101.02,quantity:5}];
    const at=Date.now();
    for(let i=0;i<3;i++){
      long.timestamp=long.observedAt=at+i;short.timestamp=short.observedAt=at+i;
      await (f.engine as unknown as {managePositions:(now:number)=>Promise<void>}).managePositions(at+i);
    }
    assert.equal(p.holdDecision?.action,'hold');assert.equal(p.holdDecision?.incrementalCostUsd,0);
    assert.ok(p.holdDecision!.expectedFundingUsd>0&&p.holdDecision!.expectedFundingUsd<p.feesUsd);
    assert.equal(f.requests.length,3,'ongoing small positive funding does not add any closing request');
  }finally{f.cleanup();}
});

test('aligned repair rejects an actual adverse entry-price pair and removes only the unmatched exposure',async()=>{
  const f=fixture({entryPolicy:'aligned',holdMode:'adaptive'});try{
    const short=f.quotes.get('bybit')!;short.markPrice=101;short.fundingRate=.0005;
    short.bids=[{price:101,quantity:5}];short.asks=[{price:101.02,quantity:5}];
    const initial=f.engine.currentOpportunities()[0];assert.equal(initial.eligible,true);
    f.setAfterFills(()=>{f.quotes.get('gate')!.asks=[{price:103,quantity:.5}];short.bids=[];});
    const p=await f.engine.open(initial.id);
    assert.equal(f.requests.filter(order=>!order.request.reduceOnly).length,2);
    assert.ok(f.requests.some(order=>order.request.reduceOnly));
    assert.equal(p.long.quantity,.5);assert.equal(p.short.quantity,.5);
  }finally{f.cleanup();}
});
