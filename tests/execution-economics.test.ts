import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {defaultConfig} from '../src/shared/config.js';
import type {ExchangeAdapter,ExchangeId,MarketSnapshot,Opportunity,OrderRequest,OrderResult,Position,SpreadHistoryProvider} from '../src/shared/types.js';
import {Execution} from '../src/core/execution.js';
import {Store} from '../src/core/store.js';
import {calculateOpportunities,sweep} from '../src/core/strategy.js';

// Entire execution path is offline: adapters fill only these in-memory books and no credentials/network are used.
function setup(entryPolicy:'aligned'|'funding'|'dual'='dual',minEntryIocEdgeBps=defaultConfig.minEntryIocEdgeBps){
  const tempRoot=path.resolve(tmpdir()),dir=mkdtempSync(path.join(tempRoot,'funding-economics-mock-'));
  const config={...defaultConfig,entryPolicy,minEntryIocEdgeBps,mode:'live' as const,dataSource:'public' as const,orderNotionalUsd:100,maxOrderRetries:1,
    takerFees:{...defaultConfig.takerFees},minCombinedNetUsd:.04,maxSlippageBps:.01,minSpreadNetUsd:999,fundingSafetyFactor:.01,transferCostUsd:999,basisStressBps:999};
  const store=new Store(path.join(dir,'state.json'),config),quotes=new Map<ExchangeId,MarketSnapshot>();
  for(const exchange of ['binance','bybit'] as const)quotes.set(exchange,{exchange,base:'BTC',symbol:'BTC/USDT:USDT',
    timestamp:Date.now(),markPrice:100,indexPrice:100,fundingRate:exchange==='bybit'?(entryPolicy==='aligned'?.0005:.0012):0,
    predictedFundingRate:exchange==='bybit'?-.1:0,nextFundingTime:Date.now()+300000,intervalHours:8,fundingHistory:[],
    bids:[{price:exchange==='binance'?99.98:entryPolicy==='aligned'?100.4:99.9,quantity:100}],
    asks:[{price:exchange==='binance'?100:entryPolicy==='aligned'?100.42:99.92,quantity:100}],
    openInterestUsd:0,volume24hUsd:0,quantityStep:.001,minQuantity:.001,minNotional:1,contractSize:1,source:'public',
    takerFeeRate:config.takerFees[exchange],takerFeeAt:Date.now(),takerFeeSource:'exchange'});
  let baseline=-30;
  const history:SpreadHistoryProvider={assess:(long,short,quantity,c)=>{
    const buy=sweep(long.asks,quantity),sell=sweep(short.bids,quantity),reference=(long.indexPrice+short.indexPrice)/2;
    const entrySpreadBps=(sell.average-buy.average)/reference*10000;
    return {status:'ready',samples:12,requiredSamples:c.spreadMinSamples,observedSpanSec:180,requiredSpanSec:c.spreadMinSpanSec,
      longEntryPrice:buy.average,shortEntryPrice:sell.average,entrySpreadBps,expectedExitSpreadBps:baseline,
      spreadAdvantageBps:entrySpreadBps-baseline,expectedSpreadPnlUsd:quantity*reference*(entrySpreadBps-baseline)/10000};
  }};
  const p:Position={id:'offline-partial',base:'BTC',status:'opening',mode:'live',holdMode:entryPolicy==='aligned'?'adaptive':'once',
    ...(entryPolicy!=='dual'?{entryPolicy}:{}),
    long:{exchange:'binance',symbol:'BTC/USDT:USDT',side:'long',quantity:0,entryPrice:0,markPrice:100,feesUsd:0,liquidationDistancePct:null},
    short:{exchange:'bybit',symbol:'BTC/USDT:USDT',side:'short',quantity:0,entryPrice:0,markPrice:100,feesUsd:0,liquidationDistancePct:null},
    openedAt:Date.now(),plannedExitAt:Date.now()+300000,fundingUsd:0,feesUsd:0,transferCostUsd:0,spreadPnlUsd:0,
    realizedSpreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[]};
  store.data.positions.push(p);
  const requests:Array<{exchange:ExchangeId;request:OrderRequest}>=[],phases:Array<'initial'|'supplement'|'batch'>=[];
  let firstLong=true,actualLongFee:number|undefined,validationCount=0;
  const adapters=new Map<ExchangeId,ExchangeAdapter>();
  for(const exchange of ['binance','bybit'] as const)adapters.set(exchange,{
    validateOrder:async()=>{validationCount++;},placeOrder:async(request:OrderRequest):Promise<OrderResult>=>{
      assert.ok(store.data.orders.some(o=>o.request.clientOrderId===request.clientOrderId),'intent is persisted before submission');
      requests.push({exchange,request});
      const partial=exchange==='binance'&&!request.reduceOnly&&firstLong;
      if(partial)firstLong=false;
      const filledQuantity=partial?request.quantity/2:request.quantity;
      return {id:request.clientOrderId,clientOrderId:request.clientOrderId,status:partial?'partial':'filled',filledQuantity,
        averagePrice:request.limitPrice,feeUsd:partial&&actualLongFee!==undefined?actualLongFee:filledQuantity*request.limitPrice*config.takerFees[exchange],timestamp:Date.now()};
    },reconcileOrder:async()=>{throw new Error('unexpected offline reconciliation');},
  } as unknown as ExchangeAdapter);
  const execution=new Execution(store,{config:()=>store.data.config,snapshot:exchange=>quotes.get(exchange as ExchangeId),
    adapter:exchange=>adapters.get(exchange as ExchangeId)!,liveUnlocked:()=>true,
    refreshSnapshots:async(_base,exchanges)=>{for(const exchange of exchanges)quotes.get(exchange as ExchangeId)!.timestamp=Date.now();},halt:()=>{}});
  const latest=()=>calculateOpportunities([...quotes.values()],config,Date.now(),history)[0];
  const validate=async(phase:'initial'|'supplement'|'batch'='initial'):Promise<Opportunity>=>{
    phases.push(phase);const o=latest();
    if(phase==='initial')assert.equal(o.eligible,true,o.reasons.join('；'));
    return o;
  };
  return {store,p,quotes,requests,phases,execution,latest,validate,setBaseline:(value:number)=>{baseline=value;},
    setActualLongFee:(value:number)=>{actualLongFee=value;},validationCount:()=>validationCount,cleanup:()=>{
      const resolved=path.resolve(dir),relative=path.relative(tempRoot,resolved);
      assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(resolved).startsWith('funding-economics-mock-'));
      rmSync(resolved,{recursive:true,force:true});
    }};
}

test('partial hedge repairs using positive funding plus positive spread, with four fees counted once',async()=>{
  const f=setup();try{
    const o=f.latest();assert.ok(o.expectedFundingUsd<o.feesUsd);assert.ok(o.spreadAdvantage!.expectedSpreadPnlUsd!<o.feesUsd);
    assert.ok(o.spreadAdvantage!.shortEntryPrice<o.spreadAdvantage!.longEntryPrice,'an improving negative spread is a legitimate edge');
    await f.execution.open(f.p,1,1,f.validate);
    assert.equal(f.p.status,'open');assert.equal(f.p.long.quantity,1);assert.equal(f.p.short.quantity,1);assert.equal(f.p.deltaUsd,0);
    assert.equal(f.requests.length,3);assert.ok(f.requests.every(r=>!r.request.reduceOnly));
    assert.deepEqual(f.phases,['initial','initial','supplement','supplement']);
    assert.ok(Math.abs(f.p.feesUsd-.104945)<1e-9,'only reported opening fees have been booked');
  }finally{f.cleanup();}
});

test('funding can carry spread that is positive but smaller than the old independent fee gate',async()=>{
  const f=setup();try{
    f.quotes.get('bybit')!.fundingRate=.006;f.setBaseline(-15);
    const o=f.latest();assert.ok(o.spreadAdvantage!.expectedSpreadPnlUsd!>0&&o.spreadAdvantage!.expectedSpreadPnlUsd!<o.feesUsd);
    await f.execution.open(f.p,1,1,f.validate);
    assert.equal(f.p.status,'open');assert.equal(f.requests.length,3);assert.equal(f.p.long.quantity,f.p.short.quantity);
  }finally{f.cleanup();}
});

test('actual fees that erase the combined edge reject the supplement and reduce the excess leg',async()=>{
  const f=setup();try{
    f.setActualLongFee(.5);
    await f.execution.open(f.p,1,1,f.validate);
    assert.equal(f.requests.filter(r=>!r.request.reduceOnly).length,2,'no economically losing supplement is sent');
    assert.ok(f.requests.some(r=>r.request.reduceOnly));assert.equal(f.p.long.quantity,f.p.short.quantity);
    assert.ok(f.p.feesUsd>=.5,'actual fees survive the rejected supplement and the reduction');
  }finally{f.cleanup();}
});

test('a profitable actual partial pair can repair even when a hypothetical new full pair has no spread edge',async()=>{
  const f=setup();try{
    f.quotes.get('bybit')!.fundingRate=.006;
    const refresh=f.execution.context.refreshSnapshots!;
    f.execution.context.refreshSnapshots=async(base,exchanges)=>{
      await refresh(base,exchanges);
      if(f.p.long.quantity>0&&f.p.short.quantity>0)f.quotes.get('binance')!.asks=[{price:100.3,quantity:100}];
    };
    const validate=async(phase:'initial'|'supplement'|'batch'='initial')=>{
      const o=await f.validate(phase);
      if(phase==='supplement'&&f.p.long.quantity>0)assert.equal(o.eligible,false,'buying the entire size at the new price would lose the spread edge');
      return o;
    };
    await f.execution.open(f.p,1,1,validate);
    assert.equal(f.p.status,'open');assert.equal(f.p.long.quantity,1);assert.equal(f.p.short.quantity,1);
    assert.ok(Math.abs(f.p.long.entryPrice-100.15)<1e-9,'the actual old half is retained in the economic decision');
    assert.equal(f.requests.length,3);assert.ok(f.requests.every(r=>!r.request.reduceOnly));
  }finally{f.cleanup();}
});

test('missing or insufficient book blocks both initial requests without a mark/slippage fallback',async()=>{
  for(const asks of [[],[{price:100,quantity:.1}]]){
    const f=setup();try{
      f.quotes.get('binance')!.asks=asks;
      await assert.rejects(()=>f.execution.open(f.p,1,1,async()=>({...f.latest(),eligible:true})),/没有可成交报价|盘口不足/);
      assert.equal(f.requests.length,0);assert.equal(f.store.data.orders.length,0);
    }finally{f.cleanup();}
  }
});

test('funding-mode partial hedge repairs negative spread using actual filled prices and four fees once',async()=>{
  const f=setup('funding');try{
    f.store.data.config.dualAdvantageEnabled=false;f.quotes.get('bybit')!.fundingRate=.006;
    const o=f.latest();assert.ok(o.spreadAdvantage!.expectedSpreadPnlUsd!<0);assert.ok(o.eligible);
    await f.execution.open(f.p,1,1,f.validate);
    assert.equal(f.p.status,'open');assert.equal(f.p.long.quantity,1);assert.equal(f.p.short.quantity,1);
    assert.equal(f.requests.length,3);assert.ok(f.requests.every(order=>!order.request.reduceOnly));
    assert.deepEqual(f.phases,['initial','initial','supplement','supplement']);
    assert.ok(Math.abs(f.p.feesUsd-.104945)<1e-9,'closing fee estimates are not booked as incurred expenses');
  }finally{f.cleanup();}
});

test('funding-mode supplement prices the actual old half, even when a hypothetical new complete pair loses',async()=>{
  const f=setup('funding');try{
    f.quotes.get('bybit')!.fundingRate=.006;
    const refresh=f.execution.context.refreshSnapshots!;
    f.execution.context.refreshSnapshots=async(base,exchanges)=>{
      await refresh(base,exchanges);
      if(f.p.long.quantity>0&&f.p.short.quantity>0)f.quotes.get('binance')!.asks=[{price:100.5,quantity:.5}];
    };
    const validate=async(phase:'initial'|'supplement'|'batch'='initial')=>{
      const o=await f.validate(phase);
      if(phase==='supplement'&&f.p.long.quantity>0){
        assert.equal(o.eligible,false,'new full pair is not priced because only the required half can be opened');
        assert.equal(o.combinedExpectedNetUsd,null);
      }
      return o;
    };
    await f.execution.open(f.p,1,1,validate);
    assert.equal(f.p.status,'open');assert.equal(f.p.long.quantity,1);assert.equal(f.p.short.quantity,1);
    assert.ok(Math.abs(f.p.long.entryPrice-100.25)<1e-9);
    assert.equal(f.requests.length,3);assert.ok(f.requests.every(order=>!order.request.reduceOnly));
  }finally{f.cleanup();}
});

test('funding-mode initial IOC worst-price loss is rejected before validation, journalling or submission',async()=>{
  const f=setup('funding');try{
    f.quotes.get('bybit')!.fundingRate=.006;
    f.quotes.get('binance')!.asks=[{price:100,quantity:.99},{price:100.7,quantity:.01}];
    const o=f.latest();assert.ok(o.combinedExpectedNetUsd!>0,'VWAP forecast remains positive');
    assert.equal(o.eligible,false,'strategy now rejects the same losing IOC bound before showing an executable action');
    assert.ok(o.entryLimitNetUsd!<0);
    // Independently enforce the bound if a stale/malformed caller wrongly forwards eligibility.
    await assert.rejects(()=>f.execution.open(f.p,1,1,async()=>({...o,eligible:true})),/IOC 限价允许/);
    assert.equal(f.requests.length,0);assert.equal(f.store.data.orders.length,0);assert.equal(f.validationCount(),0);
  }finally{f.cleanup();}
});

test('funding-mode final check does not rely on a trusted opportunity when its closing book or fee has disappeared',async()=>{
  for(const change of ['book','fee'] as const){
    const f=setup('funding');try{
      f.quotes.get('bybit')!.fundingRate=.006;const previouslyEligible=f.latest();
      if(change==='book')f.quotes.get('binance')!.bids=[];
      else {f.store.data.config.takerFees.bybit=NaN;delete f.quotes.get('bybit')!.takerFeeRate;}
      await assert.rejects(()=>f.execution.open(f.p,1,1,async()=>previouslyEligible),/盘口|手续费/);
      assert.equal(f.requests.length,0);assert.equal(f.store.data.orders.length,0);
    }finally{f.cleanup();}
  }
});

test('funding-mode expensive actual fees reject a losing supplement and reduce confirmed excess',async()=>{
  const f=setup('funding');try{
    f.quotes.get('bybit')!.fundingRate=.006;f.setActualLongFee(.5);
    await f.execution.open(f.p,1,1,f.validate);
    assert.equal(f.requests.filter(order=>!order.request.reduceOnly).length,2);
    assert.ok(f.requests.some(order=>order.request.reduceOnly));
    assert.equal(f.p.long.quantity,f.p.short.quantity);assert.ok(f.p.feesUsd>=.5);
  }finally{f.cleanup();}
});

test('funding-mode incomplete actual closing depth prevents a supplement without inventing zero closing costs',async()=>{
  const f=setup('funding');try{
    f.quotes.get('bybit')!.fundingRate=.006;
    const refresh=f.execution.context.refreshSnapshots!;
    f.execution.context.refreshSnapshots=async(base,exchanges)=>{
      await refresh(base,exchanges);
      if(f.p.long.quantity>0&&f.p.short.quantity>0)f.quotes.get('binance')!.bids=[{price:99.98,quantity:.5}];
    };
    await f.execution.open(f.p,1,1,f.validate);
    assert.equal(f.requests.filter(order=>!order.request.reduceOnly).length,2);
    assert.ok(f.requests.some(order=>order.request.reduceOnly));
    assert.equal(f.p.long.quantity,.5);assert.equal(f.p.short.quantity,.5);
  }finally{f.cleanup();}
});

test('entry policy is frozen on the position and cannot silently switch during either initial validation',async()=>{
  for(const changeAt of [1,2]){
    const f=setup('funding');try{
      f.quotes.get('bybit')!.fundingRate=.006;let calls=0;
      await assert.rejects(()=>f.execution.open(f.p,1,1,async()=>{
        const o=await f.validate();return ++calls===changeAt?{...o,entryPolicy:'dual'}:o;
      }),/收益模型已变化/);
      assert.equal(f.requests.length,0);assert.equal(f.store.data.orders.length,0);assert.equal(f.p.entryPolicy,'funding');
    }finally{f.cleanup();}
  }
});

test('a stored position without a policy keeps dual semantics even when the global mode changes to funding',async()=>{
  const f=setup();try{
    assert.equal(f.p.entryPolicy,undefined);
    const previouslyDual=f.latest();assert.equal(previouslyDual.entryPolicy,'dual');
    f.store.data.config.entryPolicy='funding';
    await f.execution.open(f.p,1,1,async()=>previouslyDual);
    assert.equal(f.p.status,'open');assert.equal(f.requests.length,3);
  }finally{f.cleanup();}
});

test('a legacy dual-disabled caller does not gain an extra spread-model restriction between its confirmed legs',async()=>{
  const f=setup();try{
    f.store.data.config.dualAdvantageEnabled=false;
    await f.execution.open(f.p,1,1,async phase=>({...await f.validate(phase),spreadAdvantage:undefined}));
    assert.equal(f.p.status,'open');assert.equal(f.p.long.quantity,1);assert.equal(f.p.short.quantity,1);
    assert.equal(f.requests.length,3);assert.ok(f.requests.every(request=>!request.request.reduceOnly));
  }finally{f.cleanup();}
});

test('funding-mode opening always requires final economics validation even if the legacy dual switch is false',async()=>{
  const f=setup('funding');try{
    f.store.data.config.dualAdvantageEnabled=false;
    await assert.rejects(()=>f.execution.open(f.p,1,1),/资金费入场缺少最终收益复核/);
    assert.equal(f.requests.length,0);assert.equal(f.store.data.orders.length,0);
  }finally{f.cleanup();}
});

test('aligned executes and repairs favorable opening prices despite negative first-cycle net after all fees',async()=>{
  const f=setup('aligned');try{
    f.store.data.config.dualAdvantageEnabled=false;f.store.data.config.minCombinedNetUsd=999;
    const o=f.latest();assert.equal(o.eligible,true);assert.ok(o.combinedExpectedNetUsd!<0);
    await f.execution.open(f.p,1,1,f.validate);
    assert.equal(f.p.status,'open');assert.equal(f.requests.length,3);assert.ok(f.requests.every(order=>!order.request.reduceOnly));
    assert.equal(f.p.long.quantity,1);assert.equal(f.p.short.quantity,1);assert.ok(f.p.short.entryPrice>f.p.long.entryPrice);
    assert.ok(f.p.profitExitPolicy);assert.equal(f.p.profitExitPolicy.minCombinedNetUsd,0,'new aligned captures any actual positive full net');
  }finally{f.cleanup();}
});

test('aligned entry and matched repair do not require currently observable closing depth',async()=>{
  const f=setup('aligned');try{
    f.quotes.get('binance')!.bids=[];f.quotes.get('bybit')!.asks=[];
    const o=f.latest();assert.equal(o.combinedExpectedNetUsd,o.expectedFundingUsd-o.feesUsd);assert.equal(o.eligible,true);
    assert.equal(o.bookCost,undefined,'closing cost diagnosis remains unknown while fee-only income is available');
    await f.execution.open(f.p,1,1,f.validate);
    assert.equal(f.p.status,'open');assert.equal(f.requests.length,3);assert.ok(f.requests.every(order=>!order.request.reduceOnly));
    assert.equal(f.p.long.quantity,1);assert.equal(f.p.short.quantity,1);
  }finally{f.cleanup();}
});

test('aligned actual supplement may preserve buy-low sell-high even if a hypothetical all-new opening loses that edge',async()=>{
  const f=setup('aligned');try{
    const refresh=f.execution.context.refreshSnapshots!;
    f.execution.context.refreshSnapshots=async(base,exchanges)=>{
      await refresh(base,exchanges);
      if(f.p.long.quantity>0&&f.p.short.quantity>0){
        f.quotes.get('binance')!.asks=[{price:100.3,quantity:.5}];
        // The existing short is confirmed, even if a hypothetical NEW batch cannot sell here now.
        f.quotes.get('bybit')!.bids=[];
      }
    };
    const validate=async(phase:'initial'|'supplement'|'batch'='initial')=>{
      const o=await f.validate(phase);if(phase==='supplement'&&f.p.long.quantity>0)assert.equal(o.eligible,false);return o;
    };
    await f.execution.open(f.p,1,1,validate);
    assert.equal(f.p.status,'open');assert.equal(f.requests.length,3);assert.ok(f.requests.every(order=>!order.request.reduceOnly));
    assert.ok(Math.abs(f.p.long.entryPrice-100.15)<1e-9);assert.equal(f.p.short.entryPrice,100.4);
  }finally{f.cleanup();}
});

test('aligned rejects an actual supplement that erases its opening price edge and reduces confirmed excess',async()=>{
  const f=setup('aligned');try{
    const refresh=f.execution.context.refreshSnapshots!;
    f.execution.context.refreshSnapshots=async(base,exchanges)=>{
      await refresh(base,exchanges);
      if(f.p.long.quantity>0&&f.p.short.quantity>0)f.quotes.get('binance')!.asks=[{price:100.9,quantity:100}];
    };
    await f.execution.open(f.p,1,1,f.validate);
    assert.equal(f.requests.filter(order=>!order.request.reduceOnly).length,2);assert.ok(f.requests.some(order=>order.request.reduceOnly));
    assert.equal(f.p.long.quantity,.5);assert.equal(f.p.short.quantity,.5);
  }finally{f.cleanup();}
});

test('aligned independently rejects unfavorable prepared IOC prices even if a caller forwards incorrect eligibility',async()=>{
  const f=setup('aligned');try{
    f.quotes.get('binance')!.asks=[{price:100.5,quantity:1}];
    const o=f.latest();assert.ok(o.entryPriceEdgeBps!<0);assert.ok(o.entryLimitPriceEdgeBps!<0);assert.equal(o.eligible,false);
    await assert.rejects(()=>f.execution.open(f.p,1,1,async()=>({...o,eligible:true})),/实际 IOC 开仓价格优势/);
    assert.equal(f.requests.length,0);assert.equal(f.store.data.orders.length,0);assert.equal(f.validationCount(),0);
  }finally{f.cleanup();}
});

test('aligned independently rejects IOC prices at or below 20 bps before any order intent',async()=>{
  for(const shortBid of [100.199,100.2]){
    const f=setup('aligned',20);try{
      f.quotes.get('bybit')!.bids=[{price:shortBid,quantity:100}];
      const o=f.latest();assert.equal(o.eligible,false);
      await assert.rejects(()=>f.execution.open(f.p,1,1,async()=>({...o,eligible:true})),/须大于 20 bps/);
      assert.equal(f.requests.length,0);assert.equal(f.store.data.orders.length,0);assert.equal(f.validationCount(),0);
    }finally{f.cleanup();}
  }
});

test('aligned repair at exactly 20 bps does not expand exposure and retains the matched old half',async()=>{
  const f=setup('aligned',20);try{
    const refresh=f.execution.context.refreshSnapshots!;
    f.execution.context.refreshSnapshots=async(base,exchanges)=>{
      await refresh(base,exchanges);
      if(f.p.long.quantity>0&&f.p.short.quantity>0)f.quotes.get('binance')!.asks=[{price:100.4,quantity:.5}];
    };
    await f.execution.open(f.p,1,1,f.validate);
    assert.equal(f.requests.filter(order=>!order.request.reduceOnly).length,2);
    assert.ok(f.requests.some(order=>order.request.reduceOnly));
    assert.equal(f.p.long.quantity,.5);assert.equal(f.p.short.quantity,.5);assert.equal(f.p.status,'open');
  }finally{f.cleanup();}
});

test('ordinary aligned execution and actual partial repair accept positive 5 and 20 bps',async()=>{
  assert.equal(defaultConfig.minEntryIocEdgeBps,0);
  for(const shortBid of [100.05,100.2]){
    const f=setup('aligned');try{
      f.quotes.get('bybit')!.bids=[{price:shortBid,quantity:100}];
      assert.equal(f.latest().eligible,true);
      await f.execution.open(f.p,1,1,f.validate);
      assert.equal(f.p.status,'open');assert.equal(f.p.long.quantity,1);assert.equal(f.p.short.quantity,1);
      assert.equal(f.requests.length,3);assert.ok(f.requests.every(order=>!order.request.reduceOnly));
    }finally{f.cleanup();}
  }
});

test('ordinary aligned execution independently rejects zero and negative IOC edge',async()=>{
  for(const shortBid of [100,99.99]){
    const f=setup('aligned');try{
      f.quotes.get('bybit')!.bids=[{price:shortBid,quantity:100}];const o=f.latest();
      assert.equal(o.eligible,false);
      await assert.rejects(()=>f.execution.open(f.p,1,1,async()=>({...o,eligible:true})),/须大于 0 bps/);
      assert.equal(f.requests.length,0);assert.equal(f.store.data.orders.length,0);
    }finally{f.cleanup();}
  }
});

test('aligned cannot submit with unknown fee schedule and always requires its final validation callback',async()=>{
  for(const missing of ['validation','fees'] as const){
    const f=setup('aligned');try{
      f.store.data.config.dualAdvantageEnabled=false;const o=f.latest();
      if(missing==='validation')await assert.rejects(()=>f.execution.open(f.p,1,1),/价格与资金费入场缺少最终收益复核/);
      else{
        f.store.data.config.takerFees.bybit=NaN;delete f.quotes.get('bybit')!.takerFeeRate;
        await assert.rejects(()=>f.execution.open(f.p,1,1,async()=>o),/手续费/);
      }
      assert.equal(f.requests.length,0);assert.equal(f.store.data.orders.length,0);
    }finally{f.cleanup();}
  }
});

test('aligned rejects an observed crossed book before initial intents even if eligibility was incorrectly forwarded',async()=>{
  const f=setup('aligned');try{
    f.quotes.get('binance')!.bids=[{price:100.2,quantity:100}];const o=f.latest();assert.equal(o.eligible,false);
    await assert.rejects(()=>f.execution.open(f.p,1,1,async()=>({...o,eligible:true})),/有效同币盘口/);
    assert.equal(f.requests.length,0);assert.equal(f.store.data.orders.length,0);assert.equal(f.validationCount(),0);
  }finally{f.cleanup();}
});

test('aligned refuses new exposure when observed supplementary books cross, keeping confirmed quantities for reduction',async()=>{
  const f=setup('aligned');try{
    const refresh=f.execution.context.refreshSnapshots!;
    f.execution.context.refreshSnapshots=async(base,exchanges)=>{
      await refresh(base,exchanges);if(f.p.long.quantity>0&&f.p.short.quantity>0)f.quotes.get('binance')!.bids=[{price:100.2,quantity:100}];
    };
    await f.execution.open(f.p,1,1,f.validate);
    assert.equal(f.requests.filter(order=>!order.request.reduceOnly).length,2);assert.ok(f.requests.some(order=>order.request.reduceOnly));
    assert.equal(f.p.long.quantity,.5);assert.equal(f.p.short.quantity,.5);
  }finally{f.cleanup();}
});

test('aligned records expensive actual opening fees without turning them into an extra first-cycle entry restriction',async()=>{
  const f=setup('aligned');try{
    f.setActualLongFee(.5);await f.execution.open(f.p,1,1,f.validate);
    assert.equal(f.p.status,'open');assert.equal(f.requests.length,3);assert.ok(f.requests.every(order=>!order.request.reduceOnly));
    assert.ok(f.p.feesUsd>=.5);assert.ok(f.store.data.orders.some(order=>order.result?.feeUsd===.5));
  }finally{f.cleanup();}
});
