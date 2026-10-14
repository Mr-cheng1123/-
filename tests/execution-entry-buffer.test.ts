import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Execution} from '../src/core/execution.js';
import {Store} from '../src/core/store.js';
import {calculateOpportunities} from '../src/core/strategy.js';
import {defaultConfig} from '../src/shared/config.js';
import type {ExchangeAdapter,ExchangeId,MarketSnapshot,OrderRequest,OrderResult,Position} from '../src/shared/types.js';

// Quotes, terminal IOC responses and transport failures are synthetic. No private client is created.
function fixture(options:{bufferBps?:number;minimumBps?:number;top?:number}={}){
  const root=path.resolve(tmpdir()),dir=mkdtempSync(path.join(root,'entry-buffer-offline-'));
  const config={...defaultConfig,mode:'live' as const,dataSource:'public' as const,entryPolicy:'aligned' as const,
    entryIocBufferBps:options.bufferBps??8,minEntryIocEdgeBps:options.minimumBps??0,
    maxOrderRetries:1,maxEntryBatches:8,orderNotionalUsd:100,dualAdvantageEnabled:false};
  const store=new Store(path.join(dir,'state.json'),config),quotes=new Map<ExchangeId,MarketSnapshot>();
  for(const exchange of ['gate','bybit'] as const)quotes.set(exchange,{exchange,base:'SAND',symbol:'SAND/USDT:USDT',
    markPrice:1,indexPrice:1,timestamp:Date.now(),observedAt:Date.now(),fundingRate:exchange==='gate'?0:.001,
    nextFundingTime:Date.now()+300_000,intervalHours:8,fundingHistory:[],
    bids:exchange==='gate'?[{price:.9995,quantity:1000}]:[
      {price:1.003,quantity:options.top??1000},{price:1.0026,quantity:1000},
      {price:1.0023,quantity:1000},{price:1.0021,quantity:1000}],
    asks:exchange==='bybit'?[{price:1.004,quantity:1000}]:[
      {price:1,quantity:options.top??1000},{price:1.0004,quantity:1000},
      {price:1.0007,quantity:1000},{price:1.0009,quantity:1000}],
    quantityStep:1,minQuantity:1,minNotional:1,contractSize:1,openInterestUsd:1e6,volume24hUsd:1e6,
    source:'public',takerFeeRate:config.takerFees[exchange],takerFeeAt:Date.now(),takerFeeSource:'exchange'});
  const p:Position={id:'offline-entry-buffer',base:'SAND',mode:'live',status:'opening',entryPolicy:'aligned',holdMode:'adaptive',
    long:{exchange:'gate',symbol:'SAND/USDT:USDT',side:'long',quantity:0,entryPrice:0,markPrice:1,feesUsd:0,liquidationDistancePct:null},
    short:{exchange:'bybit',symbol:'SAND/USDT:USDT',side:'short',quantity:0,entryPrice:0,markPrice:1,feesUsd:0,liquidationDistancePct:null},
    openedAt:Date.now(),plannedExitAt:Date.now()+300_000,fundingUsd:0,feesUsd:0,transferCostUsd:0,
    spreadPnlUsd:0,realizedSpreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[]};
  store.data.positions.push(p);
  const sent:Array<{exchange:ExchangeId;request:OrderRequest}>=[],halts:string[]=[],adapters=new Map<ExchangeId,ExchangeAdapter>();
  const arrival={shortBid:1.0025,longAsk:1.0003};
  const record=(exchange:ExchangeId,request:OrderRequest)=>{
    assert.ok(store.data.orders.some(order=>order.request.clientOrderId===request.clientOrderId),'the intent must precede submission');
    sent.push({exchange,request:structuredClone(request)});
  };
  const result=(exchange:ExchangeId,request:OrderRequest,quantity=request.quantity,averagePrice=request.limitPrice,
    status:OrderResult['status']=quantity===request.quantity?'filled':quantity>0?'partial':'cancelled'):OrderResult=>({
    id:request.clientOrderId,clientOrderId:request.clientOrderId,status,filledQuantity:quantity,
    averagePrice:quantity?averagePrice:0,averagePriceVerified:true,
    feeUsd:quantity*averagePrice*config.takerFees[exchange],timestamp:Date.now()});
  for(const exchange of ['gate','bybit'] as const)adapters.set(exchange,{
    validateOrder:async()=>{},
    placeOrder:async(request:OrderRequest)=>{
      record(exchange,request);
      if(request.reduceOnly)return result(exchange,request);
      const price=exchange==='bybit'?arrival.shortBid:arrival.longAsk;
      const fill=exchange==='bybit'?price>=request.limitPrice:price<=request.limitPrice;
      return result(exchange,request,fill?request.quantity:0,price);
    },reconcileOrder:async(request:OrderRequest)=>result(exchange,request,0,0,'unknown'),
  } as unknown as ExchangeAdapter);
  const execution=new Execution(store,{config:()=>store.data.config,snapshot:exchange=>quotes.get(exchange as ExchangeId),
    adapter:exchange=>adapters.get(exchange as ExchangeId)!,liveUnlocked:()=>true,halt:reason=>{halts.push(reason);},
    refreshSnapshots:async()=>{for(const quote of quotes.values()){
      quote.timestamp=Date.now();quote.observedAt=Date.now();quote.takerFeeAt=Date.now();
    }}});
  const opportunity=()=>calculateOpportunities([...quotes.values()],store.data.config)[0];
  const validate=async(phase:'initial'|'batch'|'supplement'='initial')=>{
    const current=opportunity();if(phase==='initial')assert.equal(current.eligible,true,current.reasons.join('；'));return current;
  };
  const cleanup=()=>{
    const target=path.resolve(dir),relative=path.relative(root,target);
    assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(target).startsWith('entry-buffer-offline-'));
    rmSync(target,{recursive:true,force:true});
  };
  return {store,p,quotes,sent,halts,adapters,arrival,record,result,execution,opportunity,validate,cleanup};
}

test('the same moved arrival bid cancels an exact BBO IOC but fills the bounded visible-price IOC',async()=>{
  for(const bufferBps of [0,8]){const f=fixture({bufferBps});try{
    await f.execution.open(f.p,100,100,f.validate);
    const sells=f.sent.filter(order=>order.exchange==='bybit'&&!order.request.reduceOnly);
    if(bufferBps===0){
      assert.equal(f.p.status,'closed');assert.equal(sells.length,3);
      assert(sells.every(order=>order.request.limitPrice===1.003));
      assert.equal(f.sent.some(order=>order.exchange==='gate'),false);
      assert.equal(f.p.feesUsd,0);assert.equal(f.p.long.quantity,0);assert.equal(f.p.short.quantity,0);
    }else{
      assert.equal(f.p.status,'open');assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);
      assert.deepEqual(f.sent.map(order=>[order.exchange,order.request.limitPrice,order.request.quantity]),[
        ['bybit',1.0023,100],['gate',1.0004,100],
      ]);
      assert.equal(f.p.short.entryPrice,1.0025);assert.equal(f.p.long.entryPrice,1.0003);
      assert.equal(f.p.entryExecution?.matchedQuantity,100);assert.equal(f.halts.length,0);
    }
  }finally{f.cleanup();}}
});

test('arrival movement beyond the buffer remains zero-filled and never opens a long or expands the retry bound',async()=>{
  const f=fixture();try{
    f.arrival.shortBid=1.0015;
    await f.execution.open(f.p,100,100,f.validate);
    assert.equal(f.p.status,'closed');assert.equal(f.sent.length,3);
    assert(f.sent.every(order=>order.exchange==='bybit'&&order.request.limitPrice===1.0023&&!order.request.reduceOnly));
    assert(f.store.data.orders.every(order=>order.result?.status==='cancelled'&&order.result.filledQuantity===0));
    assert.equal(f.p.entryExecution?.matchedQuantity,0);assert.equal(f.p.feesUsd,0);assert.equal(f.halts.length,0);
  }finally{f.cleanup();}
});

test('a local best-bid update inside the prepared bound still permits the unchanged buffered order',async()=>{
  const f=fixture();try{
    let changed=false;
    f.adapters.get('bybit')!.validateOrder=async()=>{
      if(!changed){f.quotes.get('bybit')!.bids[0].price=1.0025;changed=true;}
    };
    await f.execution.open(f.p,100,100,f.validate);
    assert.equal(f.p.status,'open');assert.equal(f.sent.length,2);
    assert.equal(f.sent[0].request.limitPrice,1.0023);
  }finally{f.cleanup();}
});

test('a narrow price advantage uses smaller visible buffers and retains the configured strict minimum',async()=>{
  const f=fixture({minimumBps:4});try{
    f.quotes.get('gate')!.asks=[{price:1,quantity:1000},{price:1.00006,quantity:1000},
      {price:1.00009,quantity:1000},{price:1.00011,quantity:1000}];
    f.quotes.get('bybit')!.bids=[{price:1.0008,quantity:1000},{price:1.00071,quantity:1000},{price:1.00069,quantity:1000}];
    f.arrival.shortBid=1.00072;f.arrival.longAsk=1.00005;
    const initial=f.opportunity().entryBatch!;
    assert.equal(initial.longLimitPrice,1.00009);assert.equal(initial.shortLimitPrice,1.00071);
    assert((initial.shortLimitPrice-initial.longLimitPrice)*10_000>4+1e-9);
    await f.execution.open(f.p,100,100,f.validate);
    assert.equal(f.p.status,'open');assert.equal(f.sent.length,2);
    assert.deepEqual(f.sent.map(order=>order.request.limitPrice),[1.00071,1.00006]);
    assert((f.p.short.entryPrice-f.sent[1].request.limitPrice)*10_000>4+1e-9);
    assert.equal(f.store.data.config.minEntryIocEdgeBps,4);
  }finally{f.cleanup();}
});

test('earlier matched profits cannot authorize a buffered long above the current batch actual short fill',async()=>{
  const f=fixture({top:40});try{
    let sells=0,buys=0;
    f.adapters.get('bybit')!.placeOrder=async request=>{
      f.record('bybit',request);
      if(request.reduceOnly)return f.result('bybit',request);
      sells++;const fill=f.result('bybit',request,request.quantity,sells===1?1.003:request.limitPrice);
      if(sells===2)f.quotes.get('gate')!.asks=[{price:1.00209,quantity:40},{price:1.00212,quantity:1000}];
      return fill;
    };
    f.adapters.get('gate')!.placeOrder=async request=>{
      f.record('gate',request);const fill=f.result('gate',request,request.quantity,1.0003);
      if(!request.reduceOnly&&++buys===1){
        f.quotes.get('gate')!.asks=[{price:1.002,quantity:40},{price:1.00202,quantity:1000}];
        f.quotes.get('bybit')!.bids=[{price:1.0021,quantity:40},{price:1.00208,quantity:1000}];
        f.quotes.get('bybit')!.asks=[{price:1.0022,quantity:1000}];
      }
      return fill;
    };
    await f.execution.open(f.p,100,100,f.validate);
    assert.equal(f.p.status,'open');assert.equal(f.p.long.quantity,40);assert.equal(f.p.short.quantity,40);
    assert.equal(f.sent.filter(order=>order.exchange==='gate'&&!order.request.reduceOnly).length,1);
    assert.deepEqual(f.sent.filter(order=>order.request.reduceOnly).map(order=>[order.exchange,order.request.quantity]),[['bybit',40]]);
    const sold=f.store.data.orders.filter(order=>order.exchange==='bybit'&&!order.request.reduceOnly);
    assert.equal(sold.length,2);assert.equal(sold[1].result?.averagePrice,1.00208);
    assert((sold[0].result!.averagePrice+sold[1].result!.averagePrice)/2>1.00209,'an aggregate-price guard would incorrectly allow this hedge');
    assert.equal(f.p.entryExecution?.completedBatches,1);assert.match(f.p.entryExecution?.stopReason??'',/本批实际成交均价/);
    assert.equal(f.halts.length,0);
  }finally{f.cleanup();}
});

test('an unknown buffered first order never repeats its intent or submits the other leg',async()=>{
  for(const failure of ['unknown','throw'] as const){const f=fixture();try{
    f.adapters.get('bybit')!.placeOrder=async request=>{
      f.record('bybit',request);if(failure==='throw')throw new Error('synthetic transport failure');
      return f.result('bybit',request,0,0,'unknown');
    };
    await f.execution.open(f.p,100,100,f.validate);
    assert.equal(f.p.status,'attention');assert.equal(f.sent.length,1);assert.equal(f.sent[0].exchange,'bybit');
    assert.equal(f.store.data.orders.length,1);assert.equal(f.store.data.orders[0].result?.status,'unknown');
    assert.equal(f.halts.length,1);assert.equal(f.p.long.quantity,0);assert.equal(f.p.short.quantity,0);
    await f.execution.open(f.p,100,100,f.validate);
    assert.equal(f.sent.length,1);assert.equal(f.store.data.orders.length,1);
  }finally{f.cleanup();}}
});

test('a permanent Bybit price-scale rejection stops after one zero-fill short and never submits a long',async()=>{
  const f=fixture();try{
    f.adapters.get('bybit')!.placeOrder=async request=>{
      f.record('bybit',request);
      return {...f.result('bybit',request,0),rejectionCode:'EC_InvalidPriceScale',rejectionReason:'下单价格精度不符合合约要求'};
    };
    await f.execution.open(f.p,100,100,f.validate);
    assert.equal(f.p.status,'closed');assert.equal(f.sent.length,1);assert.equal(f.sent[0].exchange,'bybit');
    assert.equal(f.store.data.orders[0].result?.rejectionCode,'EC_InvalidPriceScale');
    assert.equal(f.p.long.quantity,0);assert.equal(f.p.short.quantity,0);assert.equal(f.p.feesUsd,0);
  }finally{f.cleanup();}
});

test('a permanent precision rejection on the missing long is tried once before reducing the confirmed short',async()=>{
  const f=fixture();try{
    f.adapters.get('gate')!.placeOrder=async request=>{
      f.record('gate',request);
      return {...f.result('gate',request,0),rejectionCode:'INVALID_ORDER_PRECISION',rejectionReason:'下单数量或价格精度无效'};
    };
    await f.execution.open(f.p,100,100,f.validate);
    assert.deepEqual(f.sent.map(order=>[order.exchange,order.request.reduceOnly,order.request.quantity]),[
      ['bybit',false,100],['gate',false,100],['bybit',true,100],
    ]);
    assert.equal(f.p.status,'closed');assert.equal(f.p.long.quantity,0);assert.equal(f.p.short.quantity,0);
    assert.equal(f.store.data.orders[1].result?.rejectionCode,'INVALID_ORDER_PRECISION');assert.equal(f.halts.length,0);
  }finally{f.cleanup();}
});

test('an exact Bybit agreement refusal reduces only the confirmed Gate tail while a historical unknown remains frozen',async()=>{
  for(const outcome of ['refused','unknown'] as const){
    const f=fixture();try{
      f.p.long.exchange='bybit';f.p.short.exchange='gate';
      const gate=f.quotes.get('gate')!,bybit=f.quotes.get('bybit')!;
      [gate.bids,bybit.bids]=[bybit.bids,gate.bids];[gate.asks,bybit.asks]=[bybit.asks,gate.asks];
      [gate.fundingRate,bybit.fundingRate]=[bybit.fundingRate,gate.fundingRate];
      f.adapters.get('gate')!.placeOrder=async request=>{f.record('gate',request);return f.result('gate',request);};
      f.adapters.get('bybit')!.placeOrder=async request=>{
        f.record('bybit',request);
        const zero={...f.result('bybit',request,0,0,outcome==='refused'?'cancelled':'unknown'),id:''};
        return outcome==='refused'?{...zero,rejectionCode:'110126',rejectionReason:'Bybit 拒绝下单：请先在交易所签署该合约所需协议'}:
          {...zero,originalConfirmation:{stage:'create',reason:'request-failed',apiCode:'110126',
            apiMessage:'You must sign the required agreement before trading this contract.'}};
      };
      await f.execution.open(f.p,100,100,f.validate);
      if(outcome==='refused'){
        assert.deepEqual(f.sent.map(order=>[order.exchange,order.request.side,order.request.reduceOnly,order.request.quantity]),[
          ['gate','sell',false,100],['bybit','buy',false,100],['gate','buy',true,100],
        ]);
        assert.equal(f.p.status,'closed');assert.equal(f.p.long.quantity,0);assert.equal(f.p.short.quantity,0);
        assert.equal(f.store.data.orders[1].result?.rejectionCode,'110126');assert.equal(f.halts.length,0);
      }else{
        assert.deepEqual(f.sent.map(order=>[order.exchange,order.request.reduceOnly,order.request.quantity]),[
          ['gate',false,100],['bybit',false,100],
        ]);
        assert.equal(f.p.status,'attention');assert.equal(f.p.long.quantity,0);assert.equal(f.p.short.quantity,100);
        assert.equal(f.store.data.orders[1].result?.status,'unknown');assert.equal(f.store.data.orders[1].result?.rejectionCode,undefined);
        await f.execution.open(f.p,100,100,f.validate);assert.equal(f.sent.length,2,'an unknown original authorizes neither a new hedge nor a rollback');
      }
    }finally{f.cleanup();}
  }
});

test('generic IOC cancellation and insufficient immediate liquidity retain bounded fresh-quote retries',async()=>{
  for(const rejectionCode of [undefined,'BYBIT_CANCELLED_ZERO_FILL','EC_NoImmediateQtyToFill']){
    const f=fixture();try{
      f.adapters.get('bybit')!.placeOrder=async request=>{
        f.record('bybit',request);
        return {...f.result('bybit',request,0),rejectionReason:'IOC 未即时成交',...(rejectionCode?{rejectionCode}:{})};
      };
      await f.execution.open(f.p,100,100,f.validate);
      assert.equal(f.p.status,'closed');assert.equal(f.sent.length,3);
      assert(f.sent.every(order=>order.exchange==='bybit'&&!order.request.reduceOnly&&order.request.limitPrice===1.0023));
      assert.equal(new Set(f.sent.map(order=>order.request.clientOrderId)).size,3);
      assert.equal(f.p.long.quantity,0);assert.equal(f.p.short.quantity,0);assert.equal(f.p.feesUsd,0);
    }finally{f.cleanup();}
  }
});
