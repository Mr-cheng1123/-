import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Execution} from '../src/core/execution.js';
import {Store} from '../src/core/store.js';
import {calculateOpportunities} from '../src/core/strategy.js';
import {defaultConfig} from '../src/shared/config.js';
import {MAX_ENTRY_EXPANSION_MS} from '../src/core/entry-batch.js';
import type {ExchangeAdapter,ExchangeId,MarketSnapshot,OrderRequest,OrderResult,Position} from '../src/shared/types.js';

// Native responses, private parameter checks and book changes are all in memory. No credentials/transport.
function fixture(options:{top?:number;target?:number;longStep?:number;shortFill?:number;maxBatches?:number}={}){
  const root=path.resolve(tmpdir()),dir=mkdtempSync(path.join(root,'best-price-batches-'));
  const config={...defaultConfig,mode:'live' as const,dataSource:'public' as const,entryPolicy:'aligned' as const,
    minEntryIocEdgeBps:0,maxOrderRetries:1,maxEntryBatches:options.maxBatches??8,orderNotionalUsd:options.target??100,dualAdvantageEnabled:false};
  const store=new Store(path.join(dir,'state.json'),config),quotes=new Map<ExchangeId,MarketSnapshot>();
  for(const exchange of ['gate','bybit'] as const)quotes.set(exchange,{exchange,base:'BTC',symbol:'BTC/USDT:USDT',
    markPrice:1,indexPrice:1,timestamp:Date.now(),observedAt:Date.now(),fundingRate:exchange==='gate'?0:.001,
    nextFundingTime:Date.now()+300_000,intervalHours:8,fundingHistory:[],
    bids:[{price:exchange==='gate'?.999:1.003,quantity:options.top??1000},{price:.9,quantity:10_000}],
    asks:[{price:exchange==='gate'?1:1.004,quantity:options.top??1000},{price:1.1,quantity:10_000}],
    quantityStep:exchange==='gate'?(options.longStep??1):1,minQuantity:exchange==='gate'?(options.longStep??1):1,
    minNotional:1,contractSize:1,openInterestUsd:1e6,volume24hUsd:1e6,source:'public',
    takerFeeRate:config.takerFees[exchange],takerFeeAt:Date.now(),takerFeeSource:'exchange'});
  const p:Position={id:'best-batches-offline',base:'BTC',mode:'live',status:'opening',entryPolicy:'aligned',holdMode:'adaptive',
    long:{exchange:'gate',symbol:'BTC/USDT:USDT',side:'long',quantity:0,entryPrice:0,markPrice:1,feesUsd:0,liquidationDistancePct:null},
    short:{exchange:'bybit',symbol:'BTC/USDT:USDT',side:'short',quantity:0,entryPrice:0,markPrice:1,feesUsd:0,liquidationDistancePct:null},
    openedAt:Date.now(),plannedExitAt:Date.now()+300_000,fundingUsd:0,feesUsd:0,transferCostUsd:0,spreadPnlUsd:0,realizedSpreadPnlUsd:0,
    netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[]};
  store.data.positions.push(p);
  const sent:Array<{exchange:ExchangeId;request:OrderRequest}>=[],phases:Array<'initial'|'batch'|'supplement'>=[],halts:string[]=[];
  let refreshes=0,shortSubmits=0;
  const adapters=new Map<ExchangeId,ExchangeAdapter>();
  const result=(request:OrderRequest,quantity=request.quantity,status:OrderResult['status']=quantity===request.quantity?'filled':quantity>0?'partial':'cancelled',exchange:ExchangeId=request.side==='buy'&&!request.reduceOnly?'gate':'bybit'):OrderResult=>({
    id:request.clientOrderId,clientOrderId:request.clientOrderId,status,filledQuantity:quantity,averagePrice:quantity?request.limitPrice:0,
    averagePriceVerified:true,feeUsd:quantity*request.limitPrice*config.takerFees[exchange],timestamp:Date.now()});
  for(const exchange of ['gate','bybit'] as const)adapters.set(exchange,{
    validateOrder:async()=>{},
    placeOrder:async(request:OrderRequest)=>{
      assert.ok(store.data.orders.some(order=>order.request.clientOrderId===request.clientOrderId));sent.push({exchange,request});
      const quantity=exchange==='bybit'&&!request.reduceOnly&&++shortSubmits===1&&options.shortFill!==undefined?
        Math.min(request.quantity,options.shortFill):request.quantity;
      return result(request,quantity,undefined,exchange);
    },
    reconcileOrder:async(request:OrderRequest)=>result(request,0,'unknown',exchange),
  } as unknown as ExchangeAdapter);
  const execution=new Execution(store,{config:()=>store.data.config,snapshot:exchange=>quotes.get(exchange as ExchangeId),
    adapter:exchange=>adapters.get(exchange as ExchangeId)!,liveUnlocked:()=>true,halt:reason=>{halts.push(reason);},
    refreshSnapshots:async()=>{
      refreshes++;for(const quote of quotes.values()){quote.timestamp=Date.now();quote.observedAt=Date.now();quote.takerFeeAt=Date.now();}
    }});
  const opportunity=()=>calculateOpportunities([...quotes.values()],store.data.config)[0];
  const validate=async(phase:'initial'|'batch'|'supplement'='initial')=>{
    phases.push(phase);const current=opportunity();
    if(phase==='initial')assert.equal(current.eligible,true,current.reasons.join('；'));
    return current;
  };
  const cleanup=()=>{
    const target=path.resolve(dir),relative=path.relative(root,target);
    assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(target).startsWith('best-price-batches-'));
    rmSync(target,{recursive:true,force:true});
  };
  return {store,p,quotes,sent,phases,halts,adapters,execution,validate,opportunity,result,refreshes:()=>refreshes,cleanup};
}

test('a full top level opens the complete original 100U target at the best ask and bid',async()=>{
  const f=fixture();try{
    let committed=0;
    await f.execution.open(f.p,100,100,f.validate,()=>{committed++;assert.equal(f.store.data.orders.length,0);});
    assert.equal(committed,1);assert.equal(f.p.status,'open');assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);
    assert.deepEqual(f.sent.map(order=>[order.exchange,order.request.quantity,order.request.limitPrice,order.request.reduceOnly]),[
      ['bybit',100,1.003,false],['gate',100,1,false],
    ]);
    assert.deepEqual(f.p.entryExecution,{pricing:'best-opposite',targetQuantity:100,matchedQuantity:100,completedBatches:1,stopReason:'目标数量已完成'});
  }finally{f.cleanup();}
});

test('shallow best levels form three matched batches to the same target without sweeping the adverse next levels',async()=>{
  const f=fixture({top:30});try{
    const gate=f.adapters.get('gate')!,place=gate.placeOrder.bind(gate);let buys=0,commits=0;
    gate.placeOrder=async request=>{
      const fill=await place(request);
      if(!request.reduceOnly&&++buys===2){f.quotes.get('gate')!.asks[0].quantity=40;f.quotes.get('bybit')!.bids[0].quantity=40;}
      return fill;
    };
    await f.execution.open(f.p,100,100,f.validate,()=>{commits++;});
    assert.equal(f.p.status,'open');assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);
    assert.deepEqual(f.sent.map(order=>order.request.quantity),[30,30,30,30,40,40]);
    assert.ok(f.sent.every(order=>order.request.limitPrice===(order.exchange==='gate'?1:1.003)));
    assert.equal(f.p.entryExecution?.completedBatches,3);assert.equal(f.p.entryExecution?.targetQuantity,100);assert.equal(commits,1);
    assert.ok(f.phases.includes('batch'));assert.equal(f.sent.some(order=>order.request.reduceOnly),false);
  }finally{f.cleanup();}
});

test('a later price edge loss stops expansion while retaining the first matched batch',async()=>{
  const f=fixture({top:40});try{
    const gate=f.adapters.get('gate')!,place=gate.placeOrder.bind(gate);
    gate.placeOrder=async request=>{const fill=await place(request);if(!request.reduceOnly)f.quotes.get('bybit')!.bids[0].price=.9999;return fill;};
    await f.execution.open(f.p,100,100,f.validate);
    assert.equal(f.p.status,'open');assert.equal(f.p.long.quantity,40);assert.equal(f.p.short.quantity,40);
    assert.equal(f.sent.length,2);assert.equal(f.p.entryExecution?.completedBatches,1);assert.match(f.p.entryExecution?.stopReason??'',/优势/);
    assert.equal(f.p.closeRequestedAt,undefined);
  }finally{f.cleanup();}
});

test('a later funding reversal stops new batches and retains the already matched quantity',async()=>{
  const f=fixture({top:40});try{
    const gate=f.adapters.get('gate')!,place=gate.placeOrder.bind(gate);
    gate.placeOrder=async request=>{const fill=await place(request);if(!request.reduceOnly)f.quotes.get('bybit')!.fundingRate=-.001;return fill;};
    await f.execution.open(f.p,100,100,f.validate);
    assert.equal(f.p.status,'open');assert.equal(f.p.long.quantity,40);assert.equal(f.p.short.quantity,40);assert.equal(f.sent.length,2);
    assert.equal(f.p.closeRequestedAt,undefined);assert.match(f.p.entryExecution?.stopReason??'',/方向|资金费/);
  }finally{f.cleanup();}
});

test('a later missing long is retried within bounds and only that batch short tail is unwound',async()=>{
  const f=fixture({top:40});try{
    const gate=f.adapters.get('gate')!;let buys=0;
    gate.placeOrder=async request=>{f.sent.push({exchange:'gate',request});return f.result(request,++buys===1?request.quantity:0);};
    await f.execution.open(f.p,100,100,f.validate);
    assert.equal(f.p.status,'open');assert.equal(f.p.long.quantity,40);assert.equal(f.p.short.quantity,40);
    assert.deepEqual(f.sent.map(order=>[order.exchange,order.request.quantity,order.request.reduceOnly]),[
      ['bybit',40,false],['gate',40,false],['bybit',40,false],['gate',40,false],['gate',40,false],['gate',40,false],['bybit',40,true],
    ]);
    assert.equal(f.p.entryExecution?.completedBatches,1);assert.equal(f.p.closeRequestedAt,undefined);
    assert.ok(f.p.feesUsd>0,'real unwind fees remain in the accounting');
  }finally{f.cleanup();}
});

test('earlier matched profits cannot subsidize a later long IOC above its own batch actual short fill',async()=>{
  const f=fixture({top:40});try{
    f.quotes.get('bybit')!.bids[0].price=1.02;f.quotes.get('bybit')!.asks[0].price=1.021;
    const gate=f.adapters.get('gate')!,bybit=f.adapters.get('bybit')!,gatePlace=gate.placeOrder.bind(gate),shortPlace=bybit.placeOrder.bind(bybit);
    let sells=0;
    gate.placeOrder=async request=>{
      const fill=await gatePlace(request);if(!request.reduceOnly){f.quotes.get('bybit')!.bids[0].price=1.001;f.quotes.get('bybit')!.asks[0].price=1.0011;}return fill;
    };
    bybit.placeOrder=async request=>{
      const fill=await shortPlace(request);if(!request.reduceOnly&&++sells===2)f.quotes.get('gate')!.asks[0].price=1.004;return fill;
    };
    await f.execution.open(f.p,100,100,f.validate);
    assert.equal(f.p.status,'open');assert.equal(f.p.long.quantity,40);assert.equal(f.p.short.quantity,40);
    assert.equal(f.sent.filter(order=>order.exchange==='gate'&&!order.request.reduceOnly).length,1);
    assert.deepEqual(f.sent.filter(order=>order.request.reduceOnly).map(order=>[order.exchange,order.request.quantity]),[['bybit',40]]);
    assert.match(f.p.entryExecution?.stopReason??'',/本批实际成交均价/);
  }finally{f.cleanup();}
});

test('a zero-fill short never submits a long, while the eight-batch cap retains a bounded partial target',async()=>{
  const empty=fixture({shortFill:0});try{
    empty.adapters.get('bybit')!.placeOrder=async request=>{empty.sent.push({exchange:'bybit',request});return empty.result(request,0);};
    await empty.execution.open(empty.p,100,100,empty.validate);
    assert.equal(empty.p.status,'closed');assert.equal(empty.sent.length,3);assert.equal(empty.sent.some(order=>order.exchange==='gate'),false);
    assert.equal(empty.p.feesUsd,0);
  }finally{empty.cleanup();}
  const capped=fixture({top:10});try{
    await capped.execution.open(capped.p,100,100,capped.validate);
    assert.equal(capped.p.status,'open');assert.equal(capped.p.long.quantity,80);assert.equal(capped.p.short.quantity,80);
    assert.equal(capped.p.entryExecution?.completedBatches,8);assert.equal(capped.sent.length,16);
    assert.match(capped.p.entryExecution?.stopReason??'',/次数已到/);
  }finally{capped.cleanup();}
});

test('partial short fills keep their exact matched quantity when legal, or only reduce the impossible lot tail',async()=>{
  for(const step of [1,10]){
    const f=fixture({target:190,shortFill:106,longStep:step,maxBatches:1});try{
      await f.execution.open(f.p,190,190,f.validate);
      const matched=step===1?106:100;
      assert.equal(f.p.status,'open');assert.equal(f.p.long.quantity,matched);assert.equal(f.p.short.quantity,matched);
      assert.deepEqual(f.sent.filter(order=>order.request.reduceOnly).map(order=>[order.exchange,order.request.quantity]),step===1?[]:[['bybit',6]]);
      assert.equal(f.p.entryExecution?.targetQuantity,190);assert.equal(f.p.entryExecution?.matchedQuantity,matched);
      assert.equal(f.p.closeRequestedAt,undefined);
    }finally{f.cleanup();}
  }
});

test('subsequent opportunity quantities can change without exceeding the frozen original target',async()=>{
  const f=fixture({top:40});try{
    await f.execution.open(f.p,100,100,async(phase='initial')=>{
      const o=await f.validate(phase);return phase==='initial'?o:{...o,longQuantity:500,shortQuantity:500};
    });
    assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);assert.equal(f.p.entryExecution?.targetQuantity,100);
    assert.deepEqual(f.sent.map(order=>order.request.quantity),[40,40,40,40,20,20]);
  }finally{f.cleanup();}
});

test('a later unknown short, including an exception saving that reply, preserves previous hedges and original ids',async()=>{
  for(const saveFault of [false,true]){
    const f=fixture({top:40});try{
      const bybit=f.adapters.get('bybit')!,place=bybit.placeOrder.bind(bybit);let sells=0;
      bybit.placeOrder=async request=>{
        const fill=await place(request);return !request.reduceOnly&&++sells===2?{...fill,status:'unknown',filledQuantity:10}:fill;
      };
      bybit.reconcileOrder=async request=>({...f.result(request,10,'unknown')});
      const save=f.store.save.bind(f.store);let failed=false;
      f.store.save=()=>{if(saveFault&&!failed&&f.store.data.orders.at(-1)?.result?.status==='unknown'){failed=true;throw new Error('injected save failure');}save();};
      await f.execution.open(f.p,100,100,f.validate);
      assert.equal(f.p.status,'attention');assert.equal(f.p.long.quantity,40);assert.equal(f.p.short.quantity,50);
      assert.equal(f.sent.length,3);assert.equal(f.sent.some(order=>order.request.reduceOnly),false);assert.equal(f.p.closeRequestedAt,undefined);
      assert.equal(f.p.entryExecution?.completedBatches,1);assert.match(f.p.entryExecution?.stopReason??'',/待核对/);
      assert.equal(f.store.data.orders.filter(order=>order.result?.status==='unknown').length,1);
    }finally{f.cleanup();}
  }
});

test('unverified incremental fill prices preserve earlier hedges and freeze the original tail until exact cash is known',async()=>{
  const f=fixture({top:40});try{
    const bybit=f.adapters.get('bybit')!,place=bybit.placeOrder.bind(bybit);let sells=0;
    bybit.placeOrder=async request=>{const fill=await place(request);return !request.reduceOnly&&++sells===2?{...fill,averagePriceVerified:false}:fill;};
    await f.execution.open(f.p,100,100,f.validate);
    assert.equal(f.p.status,'attention');assert.equal(f.p.long.quantity,40);assert.equal(f.p.short.quantity,80);
    assert.equal(f.sent.filter(order=>order.exchange==='gate').length,1);assert.equal(f.sent.filter(order=>order.request.reduceOnly).length,0);
    assert.match(f.p.entryExecution?.stopReason??'',/待核对/);assert.equal(f.p.entryExecution?.completedBatches,1);
    const journal=f.store.data.orders.find(order=>order.result?.status==='unknown')!,before=structuredClone(f.p);
    bybit.reconcileOrder=async request=>f.result(request,request.quantity,'filled');
    await f.execution.reconcilePending();assert.equal(f.p.short.quantity,80);assert.equal(f.p.long.quantity,40);
    assert.equal(f.sent.length,3,'verified GET recovery neither hedges nor reduces any coin');assert.equal(journal.result!.status,'filled');
    assert.equal(f.p.feesUsd,before.feesUsd);assert.equal(f.p.entryExecution?.completedBatches,1);
  }finally{f.cleanup();}
});

test('best top below native minimum notional cannot sweep a deeper level to manufacture an entry batch',async()=>{
  const f=fixture({top:2});try{
    f.quotes.get('gate')!.minNotional=5;
    await assert.rejects(()=>f.execution.open(f.p,100,100,async()=>({...f.opportunity(),eligible:true})),/最小下单量|金额/);
    assert.equal(f.sent.length,0);assert.equal(f.store.data.orders.length,0);
  }finally{f.cleanup();}
});

test('a changed or stale best quote during private validation cannot create either first intent',async()=>{
  for(const change of ['price','stale'] as const){
    const f=fixture();try{
      f.adapters.get('gate')!.validateOrder=async()=>{
        if(change==='price')f.quotes.get('gate')!.asks[0].price=1.1;
        else f.quotes.get('gate')!.observedAt=Date.now()-f.store.data.config.maxSnapshotAgeMs-1;
      };
      await assert.rejects(()=>f.execution.open(f.p,100,100,async()=>({...f.opportunity(),eligible:true})),/首档|过期|资格|条件/);
      assert.equal(f.sent.length,0);assert.equal(f.store.data.orders.length,0);
    }finally{f.cleanup();}
  }
});

test('the expansion deadline stops new batches but allows the submitted short batch to finish hedging',async t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const f=fixture({top:40});try{
    const bybit=f.adapters.get('bybit')!,place=bybit.placeOrder.bind(bybit);
    bybit.placeOrder=async request=>{const fill=await place(request);if(!request.reduceOnly)now+=MAX_ENTRY_EXPANSION_MS+1;return fill;};
    await f.execution.open(f.p,100,100,f.validate);
    assert.equal(f.p.status,'open');assert.equal(f.p.long.quantity,40);assert.equal(f.p.short.quantity,40);
    assert.equal(f.sent.length,2);assert.match(f.p.entryExecution?.stopReason??'',/时间已到/);
  }finally{f.cleanup();}
});

test('actual per-batch margin scopes are supplied and a missing leg never reserves the unrelated full target',async()=>{
  const f=fixture({top:40});try{
    const scopes:Array<{phase:string;longQuantity:number;shortQuantity:number}>=[];
    await f.execution.open(f.p,100,100,async(phase='initial',quantities)=>{
      if(quantities){scopes.push({phase,...quantities});assert.ok(quantities.longQuantity<=40&&quantities.shortQuantity<=40);}
      return f.validate(phase);
    });
    assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);
    assert.deepEqual(scopes.filter(scope=>scope.phase==='supplement').map(scope=>[scope.longQuantity,scope.shortQuantity]),[[40,0],[40,0],[20,0]]);
    assert.ok(scopes.filter(scope=>scope.phase==='batch').every(scope=>scope.longQuantity===scope.shortQuantity&&scope.longQuantity<=40));
  }finally{f.cleanup();}
});

test('a later unknown long preserves earlier matched holdings and cannot be retried or speculatively unwound',async()=>{
  for(const saveFault of [false,true]){
    const f=fixture({top:40});try{
      const gate=f.adapters.get('gate')!,place=gate.placeOrder.bind(gate);let buys=0;
      gate.placeOrder=async request=>{
        const fill=await place(request);return !request.reduceOnly&&++buys===2?{...fill,status:'unknown',filledQuantity:10}:fill;
      };
      gate.reconcileOrder=async request=>f.result(request,10,'unknown','gate');
      const save=f.store.save.bind(f.store);let failed=false;
      f.store.save=()=>{if(saveFault&&!failed&&f.store.data.orders.at(-1)?.result?.status==='unknown'){failed=true;throw new Error('injected late long save failure');}save();};
      await f.execution.open(f.p,100,100,f.validate);
      assert.equal(f.p.status,'attention');assert.equal(f.p.long.quantity,50);assert.equal(f.p.short.quantity,80);
      assert.equal(f.sent.length,4);assert.ok(f.sent.every(order=>!order.request.reduceOnly));
      assert.equal(f.p.entryExecution?.completedBatches,1);assert.equal(f.p.entryExecution?.matchedQuantity,50);
      assert.match(f.p.entryExecution?.stopReason??'',/待核对/);assert.equal(f.p.closeRequestedAt,undefined);
    }finally{f.cleanup();}
  }
});

test('a minimum-cost failure reducing a later naked tail keeps the old hedge visible and reports attention',async()=>{
  const f=fixture({top:40});try{
    const gate=f.adapters.get('gate')!;let buys=0;
    gate.placeOrder=async request=>{f.sent.push({exchange:'gate',request});return f.result(request,++buys===1?request.quantity:0);};
    f.adapters.get('bybit')!.validateOrder=async request=>{if(request.reduceOnly)throw new Error('native reduce minimum cost');};
    await f.execution.open(f.p,100,100,f.validate);
    assert.equal(f.p.status,'attention');assert.equal(f.p.long.quantity,40);assert.equal(f.p.short.quantity,80);
    assert.equal(f.sent.some(order=>order.request.reduceOnly),false);assert.equal(f.p.closeRequestedAt,undefined);
    assert.equal(f.p.entryExecution?.completedBatches,1);assert.equal(f.halts.length,1);
  }finally{f.cleanup();}
});

test('an unknown batch-tail reduction whose fill lower bound restores equality still cannot claim a completed hedge',async()=>{
  const f=fixture({top:40});try{
    const gate=f.adapters.get('gate')!;let buys=0;
    gate.placeOrder=async request=>{f.sent.push({exchange:'gate',request});return f.result(request,++buys===1?request.quantity:0);};
    const bybit=f.adapters.get('bybit')!,place=bybit.placeOrder.bind(bybit);
    bybit.placeOrder=async request=>{const fill=await place(request);return request.reduceOnly?{...fill,status:'unknown'}:fill;};
    bybit.reconcileOrder=async request=>f.result(request,request.quantity,'unknown','bybit');
    const save=f.store.save.bind(f.store);let failed=false;
    f.store.save=()=>{if(!failed&&f.store.data.orders.at(-1)?.result?.status==='unknown'){failed=true;throw new Error('injected trim save failure');}save();};
    await f.execution.open(f.p,100,100,f.validate);
    assert.equal(failed,true);assert.equal(f.p.status,'attention');assert.equal(f.p.long.quantity,40);assert.equal(f.p.short.quantity,40);
    assert.equal(f.sent.filter(order=>order.request.reduceOnly).length,1);assert.equal(f.p.entryExecution?.completedBatches,1);
    assert.equal(f.store.data.orders.at(-1)?.result?.status,'unknown');assert.equal(f.p.closeRequestedAt,undefined);
  }finally{f.cleanup();}
});

test('no quote transport can repeat a cancelled best-price IOC, and zero retries never expand a naked short',async()=>{
  for(const disabled of ['transport','retries'] as const){
    const f=fixture();try{
      if(disabled==='transport')f.execution.context.refreshSnapshots=undefined;
      else f.store.data.config.maxOrderRetries=0;
      f.adapters.get('gate')!.placeOrder=async request=>{f.sent.push({exchange:'gate',request});return f.result(request,0);};
      await f.execution.open(f.p,100,100,f.validate);
      assert.equal(f.p.status,'closed');assert.equal(f.p.long.quantity,0);assert.equal(f.p.short.quantity,0);
      assert.equal(f.sent.filter(order=>order.exchange==='gate').length,1);
      assert.deepEqual(f.sent.filter(order=>order.request.reduceOnly).map(order=>[order.exchange,order.request.quantity]),[['bybit',100]]);
    }finally{f.cleanup();}
  }
});

test('an existing unresolved original intent prevents starting another batch even with a zero fill lower bound',async()=>{
  const f=fixture();try{
    const request:OrderRequest={clientOrderId:'original-unresolved',base:f.p.base,symbol:f.p.short.symbol,side:'sell',quantity:40,limitPrice:1.003,reduceOnly:false};
    f.store.data.orders.push({positionId:f.p.id,exchange:'bybit',request,createdAt:Date.now(),result:f.result(request,0,'unknown')});
    let committed=0;
    await f.execution.open(f.p,100,100,f.validate,()=>{committed++;});
    assert.equal(committed,0);assert.equal(f.p.status,'attention');assert.equal(f.sent.length,0);
    assert.equal(f.store.data.orders.length,1);assert.equal(f.store.data.orders[0].request.clientOrderId,'original-unresolved');
  }finally{f.cleanup();}
});
