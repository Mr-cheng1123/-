import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {defaultConfig} from '../src/shared/config.js';
import type {ExchangeAdapter,ExchangeId,MarketSnapshot,OrderRequest,OrderResult,Position} from '../src/shared/types.js';
import {Store} from '../src/core/store.js';
import {Execution,UncertainOrderError} from '../src/core/execution.js';
import {bestCloseOppositeLevel,planBestPriceCloseBatch,planBestPriceReduction,MAX_BEST_PRICE_CLOSE_BATCHES} from '../src/core/close-batch.js';

function book(exchange:ExchangeId,patch:Partial<MarketSnapshot>={}):MarketSnapshot {
  const now=Date.now();
  return {exchange,base:'TESTCLOSE',symbol:'TESTCLOSE/USDT:USDT',source:'public',timestamp:now,observedAt:now,
    markPrice:1,indexPrice:1,fundingRate:0,nextFundingTime:now+3600_000,intervalHours:1,fundingHistory:[],
    bids:[{price:exchange==='gate'?1:.99,quantity:20},{price:.5,quantity:1000}],
    asks:[{price:exchange==='bybit'?1:1.01,quantity:20},{price:1.5,quantity:1000}],
    quantityStep:1,minQuantity:1,minNotional:1_000_000,contractSize:1,openInterestUsd:100_000,volume24hUsd:100_000,
    takerFeeRate:.0005,takerFeeAt:now,takerFeeSource:'exchange',...patch};
}
function setup(quantity=100){
  const root=path.resolve(tmpdir()),dir=mkdtempSync(path.join(root,'funding-best-close-'));
  const store=new Store(path.join(dir,'state.json'),{...structuredClone(defaultConfig),mode:'live',dataSource:'public',maxOrderRetries:1});
  const leg=(side:'long'|'short')=>({exchange:side==='long'?'gate' as const:'bybit' as const,symbol:'TESTCLOSE/USDT:USDT',side,
    quantity,entryPrice:1,markPrice:1,feesUsd:.05,liquidationDistancePct:null});
  const p:Position={id:'best-close-mock',base:'TESTCLOSE',mode:'live',status:'open',long:leg('long'),short:leg('short'),
    openedAt:Date.now()-60_000,plannedExitAt:0,holdMode:'adaptive',fundingUsd:.5,feesUsd:.1,transferCostUsd:.03,
    realizedSpreadPnlUsd:0,spreadPnlUsd:0,netPnlUsd:.37,deltaUsd:0,fundingEvents:['confirmed-funding'],riskReasons:[]};
  store.data.positions.push(p);
  const books=new Map<ExchangeId,MarketSnapshot>([['gate',book('gate')],['bybit',book('bybit')]]);
  const requests:Array<{exchange:ExchangeId;request:OrderRequest}>=[],refreshes:string[][]=[],halts:Array<{reason:string;base?:string}>=[];
  const result=(request:OrderRequest,filled=request.quantity,status:OrderResult['status']='filled'):OrderResult=>({
    id:request.clientOrderId,clientOrderId:request.clientOrderId,status,filledQuantity:filled,
    averagePrice:filled?request.limitPrice:0,feeUsd:filled*request.limitPrice*.0005,timestamp:Date.now()});
  const adapters=new Map<ExchangeId,ExchangeAdapter>();
  for(const exchange of ['gate','bybit'] as const)adapters.set(exchange,{validateOrder:async()=>{},
    placeOrder:async(request:OrderRequest)=>{requests.push({exchange,request});return result(request);},
    reconcileOrder:async()=>{throw new Error('Unexpected reconciliation');}} as unknown as ExchangeAdapter);
  const execution=new Execution(store,{config:()=>store.data.config,snapshot:exchange=>books.get(exchange as ExchangeId),
    adapter:exchange=>adapters.get(exchange as ExchangeId)!,liveUnlocked:()=>true,
    refreshSnapshots:async(_base,exchanges)=>{refreshes.push(exchanges);for(const exchange of exchanges){
      const quote=books.get(exchange as ExchangeId)!;quote.timestamp=Date.now();quote.observedAt=Date.now();
      quote.fundingObservedAt=Date.now();quote.takerFeeAt=Date.now();}},halt:(reason,base)=>{halts.push({reason,base});}});
  return {store,p,books,requests,refreshes,halts,result,adapters,execution,cleanup:()=>{
    const resolved=path.resolve(dir),relative=path.relative(root,resolved);
    assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(resolved).startsWith('funding-best-close-'));
    rmSync(resolved,{recursive:true,force:true});}};
}
const near=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);

test('close planner uses actual opposite 1, aggregates duplicate prices, shares legal lots and ignores opening minNotional',()=>{
  const long=book('gate',{quantityStep:.2,minQuantity:.4,bids:[{price:.99,quantity:10},{price:1,quantity:.7},{price:1,quantity:.8},{price:NaN,quantity:100}]}),
    short=book('bybit',{quantityStep:.3,minQuantity:.6,asks:[{price:1.1,quantity:20},{price:1,quantity:1.3}]});
  const before=structuredClone([long,short]),plan=planBestPriceCloseBatch(long,short,100,100)!;
  assert.deepEqual(plan,{quantity:1.2,longLimitPrice:1,shortLimitPrice:1,longTopQuantity:1.5,shortTopQuantity:1.3});
  assert.deepEqual(bestCloseOppositeLevel(long,'long'),{price:1,quantity:1.5});
  assert.deepEqual(planBestPriceReduction(short,'short',.95),{quantity:.9,limitPrice:1});
  assert.deepEqual([long,short],before);
});

test('planners reject invalid, crossed, dust and insufficient shared top quantities without inventing deeper limits',()=>{
  const long=book('gate'),short=book('bybit');
  for(const quote of [book('gate',{quantityStep:0}),book('gate',{minQuantity:NaN}),book('gate',{asks:[]}),
    book('gate',{bids:[{price:1.02,quantity:20}]}),book('gate',{bids:[{price:1,quantity:.2}]})]){
    assert.equal(planBestPriceCloseBatch(quote,short,100,100),undefined);
    assert.equal(planBestPriceReduction(quote,'long',100),undefined);
  }
  for(const quantity of [0,-1,NaN,Infinity,.2])assert.equal(planBestPriceCloseBatch(long,short,quantity,100),undefined);
});

test('normal best close submits matched opposite-1 IOC batches concurrently and books every actual fee once',async()=>{
  const s=setup();try{
    let release:(result:OrderResult)=>void=()=>{},bothStarted=false;
    const firstLong=new Promise<OrderResult>(resolve=>{release=resolve;});let first=true;
    s.adapters.get('gate')!.placeOrder=async request=>{s.requests.push({exchange:'gate',request});if(first){first=false;return firstLong;}return s.result(request);};
    s.adapters.get('bybit')!.placeOrder=async request=>{s.requests.push({exchange:'bybit',request});if(s.requests.length===2){bothStarted=true;release(s.result(s.requests[0].request));}return s.result(request);};
    await s.execution.close(s.p,'normal manual close',undefined,{pricing:'best-opposite',requireProfit:false});
    assert.equal(bothStarted,true);assert.equal(s.p.status,'closed');assert.equal(s.requests.length,10);
    assert.ok(s.requests.every(({request})=>request.reduceOnly&&request.quantity===20&&request.limitPrice===1));
    assert.ok(s.requests.every(({exchange,request})=>request.side===(exchange==='gate'?'sell':'buy')));
    assert.equal(s.p.closePricing,'best-opposite');assert.equal(s.p.closeProfitRequired,false);
    assert.equal(s.p.long.quantity,0);assert.equal(s.p.short.quantity,0);near(s.p.feesUsd,.2);near(s.p.netPnlUsd,.27);
    near(s.p.fundingUsd,.5);assert.deepEqual(s.p.fundingEvents,['confirmed-funding']);assert.equal(s.halts.length,0);
    assert.equal(new Set(s.requests.map(row=>row.request.clientOrderId)).size,10);
  }finally{s.cleanup();}
});

test('a new profit close has no durable intent or order if its first shared batch fails the final check',async()=>{
  const s=setup();try{
    assert.equal(await s.execution.close(s.p,'profit close',()=>false,{pricing:'best-opposite',requireProfit:true}),false);
    assert.equal(s.requests.length,0);assert.equal(s.p.status,'open');assert.equal(s.p.closeRequestedAt,undefined);
    assert.equal(s.p.closePricing,undefined);assert.equal(s.p.closeProfitRequired,undefined);
  }finally{s.cleanup();}
});

test('each shared batch repeats economics, cancels its matched residual intent and requires a new signal',async()=>{
  const s=setup();try{
    const checks:Array<[number,number,number|undefined]>=[];
    await s.execution.close(s.p,'profit close',(long,short,quantity)=>{checks.push([long,short,quantity]);return checks.length===1;},{pricing:'best-opposite',requireProfit:true});
    assert.deepEqual(checks,[[1,1,20],[1,1,20]]);assert.equal(s.requests.length,2);
    assert.equal(s.p.long.quantity,80);assert.equal(s.p.short.quantity,80);assert.equal(s.p.status,'open');
    assert.equal(s.p.closeProfitRequired,undefined);assert.equal(s.p.closeRequestedAt,undefined);assert.equal(s.halts.length,0);
    assert.equal(s.p.automaticCloseHistory?.length,1);assert.equal(s.p.automaticCloseHistory![0].reason,'profit close');
    assert.equal(s.p.automaticCloseHistory![0].longQuantity,80);assert.equal(s.p.automaticCloseHistory![0].shortQuantity,80);
    near(s.p.feesUsd,.12);near(s.p.netPnlUsd,.35);
    const history=structuredClone(s.p.automaticCloseHistory),journal=structuredClone(s.store.data.orders);
    await s.execution.close(s.p,'new unconfirmed automatic signal',()=>false,{pricing:'best-opposite',requireProfit:true});
    assert.equal(s.requests.length,2,'A cancelled economic intent needs a new passing signal before another shared batch.');
    assert.deepEqual(s.store.data.orders,journal);assert.deepEqual(s.p.automaticCloseHistory,history);near(s.p.feesUsd,.12);
    await s.execution.close(s.p,'user confirmed manual close',()=>{throw new Error('Explicit manual close must override the old guard');},
      {pricing:'best-opposite',requireProfit:false});
    assert.equal(s.p.status,'closed');assert.ok(s.p.closeRequestedAt);assert.equal(s.p.closeProfitRequired,false);
    assert.deepEqual(s.p.automaticCloseHistory,history);near(s.p.feesUsd,.2);near(s.p.netPnlUsd,.27);
    assert.equal(new Set(s.requests.map(row=>row.request.clientOrderId)).size,s.requests.length);
    const closedOrders=s.requests.length;await s.execution.close(s.p,'already closed');assert.equal(s.requests.length,closedOrders);
    near(s.p.fundingUsd,.5);assert.deepEqual(s.p.fundingEvents,['confirmed-funding']);near(s.p.feesUsd,.2);
  }finally{s.cleanup();}
});

test('a partial pair repairs only confirmed excess then ends the conditional intent and retains matched holdings',async()=>{
  const s=setup();try{
    for(const quote of s.books.values()){quote.bids[0].quantity=40;quote.asks[0].quantity=40;}
    let shortCalls=0,checks=0;
    s.adapters.get('bybit')!.placeOrder=async request=>{s.requests.push({exchange:'bybit',request});return ++shortCalls===1?s.result(request,10,'partial'):s.result(request);};
    await s.execution.close(s.p,'profit close',()=>++checks===1,{pricing:'best-opposite',requireProfit:true});
    assert.equal(s.requests.length,3);assert.deepEqual(s.requests.map(({exchange,request})=>[exchange,request.quantity]),[['gate',40],['bybit',40],['bybit',30]]);
    assert.equal(s.p.long.quantity,60);assert.equal(s.p.short.quantity,60);assert.equal(s.p.status,'open');
    assert.equal(checks,2);assert.ok(s.requests.every(row=>row.request.reduceOnly));near(s.p.feesUsd,.14);
    assert.equal(s.p.closeRequestedAt,undefined);assert.equal(s.p.closeProfitRequired,undefined);
    assert.equal(s.p.automaticCloseHistory?.length,1);assert.equal(s.p.automaticCloseHistory![0].longQuantity,60);
    assert.equal(s.p.automaticCloseHistory![0].shortQuantity,60);near(s.p.netPnlUsd,.33);
    const journal=structuredClone(s.store.data.orders);
    await s.execution.close(s.p,'new signal still fails',()=>false,{pricing:'best-opposite',requireProfit:true});
    assert.equal(s.requests.length,3);assert.deepEqual(s.store.data.orders,journal);near(s.p.feesUsd,.14);
    assert.equal(new Set(s.requests.map(row=>row.request.clientOrderId)).size,3);
    assert.equal(s.halts.length,0,'Matched residuals are not an exchange-wide lock or an emergency unwind.');
  }finally{s.cleanup();}
});

test('bounded excess repairs finish before cancelling the old economic intent and retaining equal residuals',async()=>{
  const s=setup();try{
    for(const quote of s.books.values()){quote.bids[0].quantity=40;quote.asks[0].quantity=40;}
    let shortCalls=0,checks=0;
    s.adapters.get('bybit')!.placeOrder=async request=>{
      s.requests.push({exchange:'bybit',request});
      if(++shortCalls===1){s.books.get('bybit')!.asks=[{price:1,quantity:5},{price:1.0007,quantity:25},{price:1.01,quantity:1000}];return s.result(request,10,'partial');}
      return s.result(request);
    };
    await s.execution.close(s.p,'profit close',()=>++checks===1,{pricing:'best-opposite',requireProfit:true});
    assert.deepEqual(s.requests.filter(row=>row.exchange==='bybit').map(({request})=>[request.quantity,request.limitPrice]),[[40,1],[5,1],[25,1.0007]]);
    assert.equal(s.p.long.quantity,60);assert.equal(s.p.short.quantity,60);assert.equal(s.p.status,'open');
    assert.ok(s.requests.every(row=>row.request.reduceOnly));near(s.p.realizedSpreadPnlUsd,-.0175);
    assert.equal(s.requests.some(row=>row.request.limitPrice===1.01),false);
    assert.equal(s.p.closeRequestedAt,undefined);assert.equal(s.p.closeProfitRequired,undefined);
    assert.equal(s.p.automaticCloseHistory?.length,1);assert.equal(s.p.automaticCloseHistory![0].longQuantity,60);
    assert.equal(s.p.automaticCloseHistory![0].shortQuantity,60);near(s.p.feesUsd,.14000875);
    near(s.p.short.markPrice,1.0007);near(s.p.spreadPnlUsd,-.0595);near(s.p.netPnlUsd,.27049125);
    const journal=structuredClone(s.store.data.orders);
    await s.execution.close(s.p,'new signal still fails',()=>false,{pricing:'best-opposite',requireProfit:true});
    assert.equal(s.requests.length,4);assert.deepEqual(s.store.data.orders,journal);near(s.p.realizedSpreadPnlUsd,-.0175);
    assert.equal(new Set(s.requests.map(row=>row.request.clientOrderId)).size,4);
  }finally{s.cleanup();}
});

test('Gate native slot bounds are applied to both venues before choosing the shared legal reduction',async()=>{
  const s=setup(12);try{
    s.books.get('bybit')!.quantityStep=3;s.books.get('bybit')!.minQuantity=3;
    s.execution.context.prepareReduction=(leg,quantity)=>({quantity:Math.min(quantity,leg.exchange==='gate'?Math.max(0,5-(12-s.p.long.quantity)):12),
      ...(leg.exchange==='gate'?{closePosition:{side:'long' as const,marginMode:'crossed' as const,positionId:'frozen-native-slot'}}:{})});
    await s.execution.close(s.p,'selected native close',undefined,{pricing:'best-opposite'});
    assert.deepEqual(s.requests.map(row=>row.request.quantity),[3,3]);
    assert.equal(s.requests[0].request.closePosition!.positionId,'frozen-native-slot');
    assert.equal(s.p.long.quantity,9);assert.equal(s.p.short.quantity,9);assert.equal(s.p.status,'closing');assert.equal(s.halts.length,0);
  }finally{s.cleanup();}
});

test('unknown partial or full native close receipts freeze reconciliation without tail compensation or resubmission',async()=>{
  for(const lowerBound of [10,100]){
    const s=setup();try{
      for(const quote of s.books.values()){quote.bids[0].quantity=100;quote.asks[0].quantity=100;}
      s.adapters.get('bybit')!.placeOrder=async request=>{s.requests.push({exchange:'bybit',request});return s.result(request,lowerBound,'unknown');};
      s.adapters.get('bybit')!.reconcileOrder=async request=>s.result(request,lowerBound,'unknown');
      assert.equal(await s.execution.close(s.p,'unknown receipt',undefined,{pricing:'best-opposite'}),false);
      assert.equal(s.requests.length,2);assert.equal(s.p.status,'attention');assert.equal(s.p.closedAt,undefined);
      assert.equal(s.p.long.quantity,0);assert.equal(s.p.short.quantity,100-lowerBound);
      assert.equal(s.halts.every(item=>item.base==='TESTCLOSE'),true);
      await assert.rejects(()=>s.execution.close(s.p,'do not repeat'),UncertainOrderError);assert.equal(s.requests.length,2);
    }finally{s.cleanup();}
  }
});

test('an explicit close preserves its intent behind an unknown original order, while a new profit signal does not',async()=>{
  for(const pricing of ['best-opposite','depth'] as const)for(const requireProfit of [false,true]){
    const s=setup();try{
      const request:OrderRequest={clientOrderId:'original-pending-id',base:s.p.base,symbol:s.p.long.symbol,side:'buy',quantity:20,limitPrice:1,reduceOnly:false};
      s.store.data.orders.push({positionId:s.p.id,exchange:'gate',createdAt:Date.now()-1000,request,
        result:{...s.result(request,0,'unknown'),id:'native-original-id'}});
      await assert.rejects(()=>s.execution.close(s.p,requireProfit?'new automatic profit signal':'explicit manual close',()=>true,
        {pricing,requireProfit}),UncertainOrderError);
      assert.equal(s.requests.length,0);assert.equal(s.store.data.orders.length,1);near(s.p.feesUsd,.1);
      if(requireProfit){assert.equal(s.p.closeRequestedAt,undefined);assert.equal(s.p.closePricing,undefined);}
      else{assert.ok(s.p.closeRequestedAt);assert.equal(s.p.closePricing,pricing);assert.equal(s.p.closeProfitRequired,false);assert.equal(s.p.status,'attention');}
    }finally{s.cleanup();}
  }
});

test('an explicit emergency updates saved best-price profit intent while its unknown order still forbids new submissions',async()=>{
  const s=setup();try{
    s.p.closeRequestedAt=Date.now()-500;s.p.closePricing='best-opposite';s.p.closeProfitRequired=true;
    const request:OrderRequest={clientOrderId:'pending-close-id',base:s.p.base,symbol:s.p.long.symbol,side:'sell',quantity:20,limitPrice:1,reduceOnly:true};
    s.store.data.orders.push({positionId:s.p.id,exchange:'gate',createdAt:Date.now()-100,request,result:s.result(request,0,'unknown')});
    const requested=s.p.closeRequestedAt;
    await assert.rejects(()=>s.execution.close(s.p,'explicit emergency',undefined,{pricing:'depth',requireProfit:false}),UncertainOrderError);
    assert.equal(s.p.closeRequestedAt,requested);assert.equal(s.p.closePricing,'depth');assert.equal(s.p.closeProfitRequired,false);
    assert.equal(s.requests.length,0);assert.equal(s.p.status,'attention');
  }finally{s.cleanup();}
});

test('a save failure after an unknown reduction cannot send a residual or declare flat',async()=>{
  const s=setup();try{
    s.adapters.get('bybit')!.placeOrder=async request=>{s.requests.push({exchange:'bybit',request});return s.result(request,10,'unknown');};
    s.adapters.get('bybit')!.reconcileOrder=async request=>s.result(request,10,'unknown');
    const save=s.store.save.bind(s.store);let failed=false;
    s.store.save=()=>{if(!failed&&s.store.data.orders.some(order=>order.result?.status==='unknown')){failed=true;throw new Error('injected persistence fault');}save();};
    assert.equal(await s.execution.close(s.p,'unknown save fault',undefined,{pricing:'best-opposite'}),false);
    assert.equal(failed,true);assert.equal(s.requests.length,2);assert.equal(s.p.status,'attention');assert.equal(s.p.closedAt,undefined);
    assert.equal(s.p.long.quantity,80);assert.equal(s.p.short.quantity,90);near(s.p.feesUsd,.115);
  }finally{s.cleanup();}
});

test('a post-intent save fault on a known receipt stops new compensation until the original records are settled',async()=>{
  const s=setup();try{
    s.adapters.get('bybit')!.placeOrder=async request=>{s.requests.push({exchange:'bybit',request});return s.result(request,10,'partial');};
    const save=s.store.save.bind(s.store);let failed=false;
    s.store.save=()=>{if(!failed&&s.store.data.orders.some(order=>order.exchange==='gate'&&order.result?.status==='filled')){
      failed=true;throw new Error('injected confirmed receipt persistence fault');}save();};
    assert.equal(await s.execution.close(s.p,'known receipt persistence fault',undefined,{pricing:'best-opposite'}),false);
    assert.equal(failed,true);assert.equal(s.requests.length,2);assert.equal(s.p.status,'attention');
    assert.equal(s.p.long.quantity,80);assert.equal(s.p.short.quantity,90);near(s.p.feesUsd,.115);
    assert.ok(s.store.data.orders.every(order=>order.result&&order.result.status!=='unknown'),'Known receipts must remain native known receipts.');
    assert.equal(s.halts.every(item=>item.base===s.p.base),true);
  }finally{s.cleanup();}
});

test('a known venue rejection is not blindly retried; explicit emergency depth overrides old pricing and profit guards',async()=>{
  const s=setup();try{
    let rejected=false;
    s.adapters.get('bybit')!.placeOrder=async request=>{s.requests.push({exchange:'bybit',request});
      if(!rejected){rejected=true;return {...s.result(request,0,'cancelled'),rejectionCode:'PERMISSION_DENIED'};}return s.result(request);};
    await s.execution.close(s.p,'profit close',()=>true,{pricing:'best-opposite',requireProfit:true});
    assert.equal(s.requests.length,2);assert.equal(s.p.status,'attention');assert.equal(s.p.long.quantity,80);assert.equal(s.p.short.quantity,100);
    await s.execution.close(s.p,'continue original',()=>true);assert.equal(s.requests.length,2);
    await s.execution.close(s.p,'explicit emergency close',undefined,{pricing:'depth',requireProfit:false});
    assert.equal(s.p.status,'closed');assert.equal(s.p.closePricing,'depth');assert.equal(s.p.closeProfitRequired,false);
    assert.ok(s.requests.slice(2).every(row=>row.request.reduceOnly));assert.ok(s.requests.slice(2).some(row=>row.request.limitPrice!==1));
  }finally{s.cleanup();}
});

test('cancelled zero-fill best IOCs refresh quotes within finite retry bounds and preserve same-size remaining holdings',async()=>{
  const s=setup();try{
    for(const exchange of ['gate','bybit'] as const)s.adapters.get(exchange)!.placeOrder=async request=>{
      s.requests.push({exchange,request});return {...s.result(request,0,'cancelled'),rejectionCode:'EC_NoImmediateQtyToFill'};};
    await s.execution.close(s.p,'zero fill',undefined,{pricing:'best-opposite'});
    assert.equal(s.requests.length,4);assert.equal(s.refreshes.length,2);assert.equal(s.p.long.quantity,100);assert.equal(s.p.short.quantity,100);
    assert.equal(s.p.status,'closing');assert.equal(s.halts.length,0);
    near(s.p.feesUsd,.1);assert.equal(new Set(s.requests.map(row=>row.request.clientOrderId)).size,4);
  }finally{s.cleanup();}
});

test('native preflight book mutation cannot send either half of an already invalid shared batch',async()=>{
  const s=setup();try{
    s.adapters.get('bybit')!.validateOrder=async()=>{s.books.get('bybit')!.asks=[{price:1.1,quantity:20}];};
    await s.execution.close(s.p,'preflight mutation',undefined,{pricing:'best-opposite'});
    assert.equal(s.requests.length,0);assert.equal(s.store.data.orders.length,0);assert.equal(s.p.long.quantity,100);assert.equal(s.p.short.quantity,100);
    assert.equal(s.p.status,'closing');assert.equal(s.halts.length,0);
  }finally{s.cleanup();}
});

test('a crossed current book or excessive quote skew detected after native validation cannot create a half-close',async()=>{
  for(const change of ['cross','skew'] as const){
    const s=setup();try{
      s.adapters.get('bybit')!.validateOrder=async()=>{
        if(change==='cross')s.books.get('gate')!.asks=[{price:.9,quantity:100}];
        else{s.books.get('bybit')!.observedAt=Date.now()-4000;s.books.get('bybit')!.timestamp=Date.now()-4000;}
      };
      await s.execution.close(s.p,'changed native validation',undefined,{pricing:'best-opposite'});
      assert.equal(s.requests.length,0);assert.equal(s.store.data.orders.length,0);
      assert.equal(s.p.long.quantity,100);assert.equal(s.p.short.quantity,100);
    }finally{s.cleanup();}
  }
});

test('confirmed fill residues below the lagging venue lot stay visible without reducing the matched smaller leg',async()=>{
  const s=setup(10);try{
    s.books.get('bybit')!.quantityStep=3;s.books.get('bybit')!.minQuantity=3;
    s.books.get('gate')!.bids[0].quantity=3;s.books.get('bybit')!.asks[0].quantity=3;
    s.adapters.get('bybit')!.placeOrder=async request=>{s.requests.push({exchange:'bybit',request});return s.result(request,1,'partial');};
    await s.execution.close(s.p,'non-lot native partial',undefined,{pricing:'best-opposite'});
    assert.equal(s.requests.length,2);assert.equal(s.p.long.quantity,7);assert.equal(s.p.short.quantity,9);
    assert.equal(s.p.status,'attention');assert.equal(s.halts.every(item=>item.base===s.p.base),true);
  }finally{s.cleanup();}
});

test('matched partial IOC receipts continue from confirmed fills and never charge the unfilled request amount',async()=>{
  const s=setup();try{
    for(const exchange of ['gate','bybit'] as const){let first=true;s.adapters.get(exchange)!.placeOrder=async request=>{
      s.requests.push({exchange,request});if(first){first=false;return s.result(request,10,'partial');}return s.result(request);};}
    await s.execution.close(s.p,'matched partial close',undefined,{pricing:'best-opposite'});
    assert.equal(s.p.status,'closed');assert.equal(s.requests.length,12);near(s.p.feesUsd,.2);
    assert.equal(s.p.long.quantity,0);assert.equal(s.p.short.quantity,0);assert.equal(s.halts.length,0);
  }finally{s.cleanup();}
});

test('bounded common batching retains matched residuals and resumes saved opposite-1 pricing on a later call',async()=>{
  const s=setup();try{
    for(const quote of s.books.values()){quote.bids[0].quantity=1;quote.asks[0].quantity=1;}
    await s.execution.close(s.p,'small top',undefined,{pricing:'best-opposite'});
    assert.equal(s.requests.length,MAX_BEST_PRICE_CLOSE_BATCHES*2);assert.equal(s.p.long.quantity,100-MAX_BEST_PRICE_CLOSE_BATCHES);
    assert.equal(s.p.short.quantity,s.p.long.quantity);assert.equal(s.p.status,'closing');assert.equal(s.halts.length,0);
    const before=s.requests.length;
    await s.execution.close(s.p,'continue saved best');assert.equal(s.requests.length,before+MAX_BEST_PRICE_CLOSE_BATCHES*2);
    assert.ok(s.requests.every(row=>row.request.quantity===1&&row.request.limitPrice===1));
  }finally{s.cleanup();}
});

test('an unavailable fresh transport cannot retry a cancelled close against the same cached book',async()=>{
  const s=setup();try{
    s.execution.context.refreshSnapshots=undefined;
    for(const exchange of ['gate','bybit'] as const)s.adapters.get(exchange)!.placeOrder=async request=>{
      s.requests.push({exchange,request});return s.result(request,0,'cancelled');};
    await s.execution.close(s.p,'no quote transport',undefined,{pricing:'best-opposite'});
    assert.equal(s.requests.length,2);assert.equal(s.p.status,'closing');assert.equal(s.halts.length,0);
  }finally{s.cleanup();}
});

test('single-account manual reductions also batch at opposite 1 without opening fees or false exchange locks',async()=>{
  const s=setup(50);try{
    s.p.short.quantity=0;s.p.short.entryPrice=0;
    await s.execution.close(s.p,'selected single position',undefined,{pricing:'best-opposite'});
    assert.equal(s.p.status,'closed');assert.deepEqual(s.requests.map(row=>[row.exchange,row.request.quantity,row.request.limitPrice]),
      [['gate',20,1],['gate',20,1],['gate',10,1]]);
    assert.ok(s.requests.every(row=>row.request.reduceOnly));assert.equal(s.halts.length,0);near(s.p.feesUsd,.125);
  }finally{s.cleanup();}
});

test('a batch that reaches the time budget cannot submit a new matched batch',async()=>{
  const s=setup(),nativeNow=Date.now;let clock=nativeNow();try{
    Date.now=()=>clock;
    for(const exchange of ['gate','bybit'] as const)s.adapters.get(exchange)!.placeOrder=async request=>{
      s.requests.push({exchange,request});clock+=16_000;return s.result(request);};
    await s.execution.close(s.p,'time bounded',undefined,{pricing:'best-opposite'});
    assert.equal(s.requests.length,2);assert.equal(s.p.long.quantity,80);assert.equal(s.p.short.quantity,80);
    assert.equal(s.p.status,'closing');assert.equal(s.halts.length,0);
  }finally{Date.now=nativeNow;s.cleanup();}
});
