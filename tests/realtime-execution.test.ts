import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Execution,type ExecutionTrace} from '../src/core/execution.js';
import {Store} from '../src/core/store.js';
import {calculateOpportunities} from '../src/core/strategy.js';
import {defaultConfig} from '../src/shared/config.js';
import type {ExchangeAdapter,ExchangeId,MarketSnapshot,OrderRequest,OrderResult,Position} from '../src/shared/types.js';

type FastAdapter=ExchangeAdapter&{getExecutionSnapshot:(base:string)=>MarketSnapshot|undefined;fetchExecutionSnapshots:(bases:string[])=>Promise<MarketSnapshot[]>};
// All feeds, account metadata and order replies are synthetic; neither credentials nor transport exist.
function fixture(top=100){
  const root=path.resolve(tmpdir()),dir=mkdtempSync(path.join(root,'realtime-execution-'));
  const config={...defaultConfig,mode:'live' as const,dataSource:'public' as const,entryPolicy:'aligned' as const,
    minEntryIocEdgeBps:0,maxOrderRetries:1,maxEntryBatches:8,orderNotionalUsd:100,dualAdvantageEnabled:false};
  const store=new Store(path.join(dir,'state.json'),config),quotes=new Map<ExchangeId,MarketSnapshot>();
  for(const exchange of ['gate','bybit'] as const)quotes.set(exchange,{exchange,base:'BTC',symbol:'BTC/USDT:USDT',
    markPrice:1,indexPrice:1,timestamp:Date.now(),observedAt:Date.now(),fundingRate:exchange==='gate'?0:.001,
    nextFundingTime:Date.now()+300_000,intervalHours:8,fundingHistory:[],
    bids:[{price:exchange==='gate'?.999:1.003,quantity:top}],asks:[{price:exchange==='gate'?1:1.004,quantity:top}],
    quantityStep:1,minQuantity:1,minNotional:1,contractSize:1,openInterestUsd:1e6,volume24hUsd:1e6,source:'public',
    takerFeeRate:config.takerFees[exchange],takerFeeAt:Date.now(),takerFeeSource:'exchange'});
  const p:Position={id:'offline-realtime-position',base:'BTC',mode:'live',status:'opening',entryPolicy:'aligned',holdMode:'adaptive',
    long:{exchange:'gate',symbol:'BTC/USDT:USDT',side:'long',quantity:0,entryPrice:0,markPrice:1,feesUsd:0,liquidationDistancePct:null},
    short:{exchange:'bybit',symbol:'BTC/USDT:USDT',side:'short',quantity:0,entryPrice:0,markPrice:1,feesUsd:0,liquidationDistancePct:null},
    openedAt:Date.now(),plannedExitAt:Date.now()+300_000,fundingUsd:0,feesUsd:0,transferCostUsd:0,spreadPnlUsd:0,realizedSpreadPnlUsd:0,
    netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[]};
  store.data.positions.push(p);
  const sent:Array<{exchange:ExchangeId;request:OrderRequest}>=[],traces:ExecutionTrace[]=[],adapters=new Map<ExchangeId,FastAdapter>();
  let slowReads=0,fullRefreshes=0,fastRefreshes=0,activeOrders=0;
  const replace=(exchange:ExchangeId,change:(quote:MarketSnapshot)=>void=()=>{})=>{
    const quote=structuredClone(quotes.get(exchange)!);quote.timestamp=Date.now();quote.observedAt=Date.now();change(quote);quotes.set(exchange,quote);return quote;
  };
  const result=(exchange:ExchangeId,request:OrderRequest,quantity=request.quantity,status:OrderResult['status']='filled'):OrderResult=>({
    id:request.clientOrderId,clientOrderId:request.clientOrderId,status,filledQuantity:quantity,averagePrice:quantity?request.limitPrice:0,
    averagePriceVerified:true,feeUsd:quantity*request.limitPrice*config.takerFees[exchange],timestamp:Date.now()});
  for(const exchange of ['gate','bybit'] as const)adapters.set(exchange,{
    id:exchange,getExecutionSnapshot:()=>quotes.get(exchange),
    fetchExecutionSnapshots:async()=>{fastRefreshes++;return [replace(exchange)];},
    fetchSnapshots:async()=>{fullRefreshes++;throw new Error('Full snapshot fetch is deliberately unavailable');},
    validateOrder:async()=>{replace(exchange);},
    placeOrder:async(request:OrderRequest)=>{
      assert.equal(activeOrders,0,'both opening legs must never be submitted concurrently');activeOrders++;
      try{
        assert.ok(store.data.orders.some(order=>order.request.clientOrderId===request.clientOrderId),'durable intent precedes submission');
        sent.push({exchange,request});await Promise.resolve();return result(exchange,request);
      }finally{activeOrders--;}
    },reconcileOrder:async(request:OrderRequest)=>result(exchange,request,0,'unknown'),
  } as unknown as FastAdapter);
  const execution=new Execution(store,{config:()=>store.data.config,
    snapshot:exchange=>{slowReads++;return {...quotes.get(exchange as ExchangeId)!,timestamp:1,observedAt:1};},
    adapter:exchange=>adapters.get(exchange as ExchangeId)!,liveUnlocked:()=>true,halt:()=>{},trace:event=>traces.push(event),
    refreshSnapshots:async(base,exchanges)=>{await Promise.all(exchanges.map(exchange=>adapters.get(exchange as ExchangeId)!.fetchExecutionSnapshots([base])));},
  });
  const validate=async()=>calculateOpportunities([...quotes.values()],store.data.config)[0];
  const cleanup=()=>{
    const target=path.resolve(dir),relative=path.relative(root,target);
    assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(target).startsWith('realtime-execution-'));
    rmSync(target,{recursive:true,force:true});
  };
  return {store,p,quotes,sent,traces,adapters,replace,result,execution,validate,cleanup,slowReads:()=>slowReads,fullRefreshes:()=>fullRefreshes,fastRefreshes:()=>fastRefreshes};
}

test('immutable websocket replacements do not block sequential orders and hedging uses only the fast complete book',async()=>{
  const f=fixture();try{
    const short=f.adapters.get('bybit')!,place=short.placeOrder.bind(short);
    short.placeOrder=async request=>{const fill=await place(request);if(!request.reduceOnly)f.replace('gate',quote=>{quote.asks[0].price=1.0004;});return fill;};
    await f.execution.open(f.p,100,100,async()=>{for(const exchange of ['gate','bybit'] as const)f.replace(exchange);return f.validate();});
    assert.equal(f.p.status,'open');assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);
    assert.deepEqual(f.sent.map(order=>[order.exchange,order.request.quantity,order.request.limitPrice]),[['bybit',100,1.003],['gate',100,1.0004]]);
    assert.equal(f.slowReads(),0);assert.equal(f.fullRefreshes(),0);assert.ok(f.fastRefreshes()>=4);
  }finally{f.cleanup();}
});

test('favorable best-price updates after awaited validation allow the unchanged conservative original IOC bounds',async()=>{
  const f=fixture();try{
    f.adapters.get('gate')!.validateOrder=async()=>{f.replace('gate',quote=>{quote.asks[0].price=.9998;});};
    f.adapters.get('bybit')!.validateOrder=async()=>{f.replace('bybit',quote=>{quote.bids[0].price=1.0032;});};
    await f.execution.open(f.p,100,100,f.validate);
    assert.equal(f.p.status,'open');assert.equal(f.sent.length,2);
    assert.equal(f.sent[0].request.limitPrice,1.003,'no order ID or limit is replaced merely because the bid improved');
    assert.equal(f.sent[1].request.limitPrice,.9998,'the confirmed short gets a newly prepared best-ask hedge');
  }finally{f.cleanup();}
});

test('adverse price, insufficient top depth and changed lot metadata still reject before either durable first intent',async()=>{
  const mutations:Array<(quote:MarketSnapshot)=>void>=[
    quote=>{quote.bids[0].price=1.0029;},quote=>{quote.bids[0].quantity=99;},
    quote=>{quote.quantityStep=3;},quote=>{quote.contractSize=10;},
  ];
  for(const mutate of mutations){const f=fixture();try{
    const allowed=await f.validate();
    f.adapters.get('bybit')!.validateOrder=async()=>{f.replace('bybit',mutate);};
    let committed=0;
    await assert.rejects(f.execution.open(f.p,100,100,async()=>allowed,()=>{committed++;}),/盘口已变化|合法下单数量/);
    assert.equal(f.sent.length,0);assert.equal(f.store.data.orders.length,0);assert.equal(committed,0);
    assert.deepEqual(f.traces.map(trace=>trace.phase),['finished']);
  }finally{f.cleanup();}}
});

test('a fresh realtime object cannot borrow missing or expired native fee metadata from a stale full snapshot',async()=>{
  for(const expired of [false,true]){const f=fixture();try{
    const full=structuredClone(f.quotes.get('gate')!);
    f.execution.context.snapshot=()=>full;
    f.replace('gate',quote=>{if(expired)quote.takerFeeAt=Date.now()-120_001;else{quote.takerFeeRate=undefined;quote.takerFeeSource=undefined;}});
    await assert.rejects(f.execution.open(f.p,100,100,async()=>({...await f.validate(),eligible:true})),/有效同币盘口、手续费|优势/);
    assert.equal(f.sent.length,0);assert.equal(f.store.data.orders.length,0);
  }finally{f.cleanup();}}
});

test('in-place contract multiplier changes cannot mutate the frozen prepared market baseline',async()=>{
  const f=fixture();try{
    const allowed=await f.validate();
    f.adapters.get('bybit')!.validateOrder=async()=>{f.quotes.get('bybit')!.contractSize=10;};
    await assert.rejects(f.execution.open(f.p,100,100,async()=>allowed),/合约或合法下单数量/);
    assert.equal(f.sent.length,0);assert.equal(f.store.data.orders.length,0);
  }finally{f.cleanup();}
});

test('a changed hedge price after awaited callback cannot send an obsolete IOC even if a new quote still has a positive edge',async()=>{
  const f=fixture();try{
    await f.execution.open(f.p,100,100,async(phase)=>{
      const opportunity=await f.validate();if(phase==='supplement')f.replace('gate',quote=>{quote.asks[0].price=1.0001;});return opportunity;
    });
    assert.equal(f.sent.filter(order=>order.exchange==='gate').length,0);
    assert.deepEqual(f.sent.map(order=>[order.exchange,order.request.reduceOnly]),[['bybit',false],['bybit',true]]);
    assert.equal(f.p.status,'closed');assert.equal(f.p.long.quantity,0);assert.equal(f.p.short.quantity,0);
    assert.equal(f.traces.some(trace=>trace.phase==='hedge-submit'),false);
  }finally{f.cleanup();}
});

test('realtime hedge funding loss cannot be masked by profitable first-leg prices or an older opportunity',async()=>{
  const f=fixture();try{
    const short=f.adapters.get('bybit')!,place=short.placeOrder.bind(short);
    short.placeOrder=async request=>{const fill=await place(request);if(!request.reduceOnly)f.replace('bybit',quote=>{quote.fundingRate=-.001;});return fill;};
    await f.execution.open(f.p,100,100,async()=>({...await f.validate(),eligible:true}));
    assert.equal(f.sent.some(order=>order.exchange==='gate'),false);assert.equal(f.p.status,'closed');
    assert.deepEqual(f.sent.map(order=>order.request.reduceOnly),[false,true]);
  }finally{f.cleanup();}
});

test('latency events use confirmed phase order, per-batch labels and never interrupt matching when an observer throws',async()=>{
  const f=fixture(40);try{
    f.execution.context.trace=event=>{f.traces.push(event);if(event.phase==='first-confirmed')throw new Error('observer failed');};
    await f.execution.open(f.p,100,100,f.validate);
    assert.equal(f.p.status,'open');assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);
    const phases=['first-submit','first-confirmed','hedge-submit','hedge-confirmed','matched'];
    assert.deepEqual(f.traces.map(trace=>trace.phase),[...phases,...phases,...phases,'finished']);
    assert.deepEqual(f.traces.filter(trace=>trace.phase==='matched').map(trace=>trace.batch),[1,2,3]);
    assert.ok(f.traces.every(trace=>trace.base==='BTC'&&trace.positionId===f.p.id&&Number.isFinite(trace.at)));
    assert.ok(f.traces.slice(1).every((trace,index)=>trace.at>=f.traces[index].at));
    assert.equal(f.traces.at(-1)!.batch,undefined);
  }finally{f.cleanup();}
});

test('later realtime batches perform only one final scoped callback after both native parameter checks',async()=>{
  const f=fixture(40);try{
    const calls:Array<{phase:string;longQuantity?:number;shortQuantity?:number;validated:number}>=[];
    let validated=0;
    for(const exchange of ['gate','bybit'] as const)f.adapters.get(exchange)!.validateOrder=async()=>{validated++;f.replace(exchange);};
    await f.execution.open(f.p,100,100,async(phase='initial',quantity)=>{
      calls.push({phase,...quantity,validated});return f.validate();
    });
    assert.equal(f.p.status,'open');assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);
    assert.deepEqual(calls.filter(call=>call.phase==='batch').map(call=>[call.longQuantity,call.shortQuantity,call.validated]),[[40,40,5],[20,20,8]]);
    assert.deepEqual(calls.filter(call=>call.phase==='supplement').map(call=>[call.longQuantity,call.shortQuantity]),[[40,0],[40,0],[20,0]]);
    assert.equal(calls.length,7,'full-target precheck + first final check + two later final checks + three actual missing-leg checks');
  }finally{f.cleanup();}
});

test('zero-fill realtime first IOC replies produce no hedge or confirmed-fill latency events',async()=>{
  const f=fixture();try{
    f.adapters.get('bybit')!.placeOrder=async request=>{f.sent.push({exchange:'bybit',request});return f.result('bybit',request,0,'cancelled');};
    await f.execution.open(f.p,100,100,f.validate);
    assert.equal(f.p.status,'closed');assert.equal(f.sent.length,3);assert.equal(f.p.feesUsd,0);
    assert.deepEqual(f.traces.map(trace=>trace.phase),['first-submit','first-submit','first-submit','finished']);
  }finally{f.cleanup();}
});

test('a late unknown or incomplete cash reply keeps original IDs and previous hedges without false confirmation traces',async()=>{
  for(const invalidCash of [false,true]){const f=fixture(40);try{
    const short=f.adapters.get('bybit')!,place=short.placeOrder.bind(short);let submissions=0;
    short.placeOrder=async request=>{
      const fill=await place(request);if(!request.reduceOnly&&++submissions===2)return invalidCash?{...fill,feeUsd:NaN}:{...fill,status:'unknown',filledQuantity:10};return fill;
    };
    short.reconcileOrder=async request=>f.result('bybit',request,10,'unknown');
    await f.execution.open(f.p,100,100,f.validate);
    assert.equal(f.p.status,'attention');assert.equal(f.p.long.quantity,40);assert.equal(f.p.short.quantity,invalidCash?80:50);
    assert.equal(f.sent.length,3);assert.ok(f.sent.every(order=>!order.request.reduceOnly));
    assert.equal(f.traces.filter(trace=>trace.phase==='first-confirmed').length,1);
    assert.equal(f.traces.filter(trace=>trace.phase==='matched').length,1);assert.equal(f.traces.at(-1)!.phase,'finished');
    const unknown=f.store.data.orders.find(order=>order.result?.status==='unknown')!;
    assert.ok(unknown.request.clientOrderId);assert.equal(f.store.data.orders.filter(order=>order.request.clientOrderId===unknown.request.clientOrderId).length,1);
    assert.equal(unknown.result!.id,unknown.request.clientOrderId);assert.equal(unknown.result!.filledQuantity,invalidCash?40:10);
    if(invalidCash){
      assert.equal(Number.isFinite(unknown.result!.feeUsd),false,'unknown fees cannot erase valid native identity, quantity and average');
      assert.equal(unknown.executionEvidence!.bookedFeeUsd,0,'only the actually booked cash is zero; the total native fee remains unknown');
    }
    const before=structuredClone({long:f.p.long,short:f.p.short,feesUsd:f.p.feesUsd}),traceCount=f.traces.length;
    await assert.rejects(()=>f.execution.reconcilePending(),/仍有未知订单/);
    assert.deepEqual({long:f.p.long,short:f.p.short,feesUsd:f.p.feesUsd},before,'a regressed late GET cannot erase or apply the same cumulative fill again');
    assert.equal(f.sent.length,3);assert.equal(f.traces.length,traceCount);
  }finally{f.cleanup();}}
});

test('unknown realtime confirmations remain frozen through a result persistence exception',async()=>{
  const f=fixture();try{
    f.adapters.get('bybit')!.placeOrder=async request=>{f.sent.push({exchange:'bybit',request});return f.result('bybit',request,10,'unknown');};
    f.adapters.get('bybit')!.reconcileOrder=async request=>f.result('bybit',request,10,'unknown');
    const save=f.store.save.bind(f.store);let failed=false;
    f.store.save=()=>{if(!failed&&f.store.data.orders.at(-1)?.result?.status==='unknown'){failed=true;throw new Error('injected result persistence failure');}save();};
    await f.execution.open(f.p,100,100,f.validate);
    assert.equal(f.p.status,'attention');assert.equal(f.sent.length,1);assert.equal(f.p.short.quantity,10);assert.equal(f.p.long.quantity,0);
    assert.deepEqual(f.traces.map(trace=>trace.phase),['first-submit','finished']);
    assert.equal(f.store.data.orders.filter(order=>order.result?.status==='unknown').length,1);
  }finally{f.cleanup();}
});
