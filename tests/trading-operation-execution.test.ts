import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import {Store} from '../src/core/store.js';
import {Execution,UncertainOrderError} from '../src/core/execution.js';
import {defaultConfig} from './legacy-config.js';
import type {ExchangeAdapter,ExchangeId,MarketSnapshot,OrderRequest,OrderResult,Position} from '../src/shared/types.js';

// These are isolated mock transport regressions for the existing legacy execution path.
// No account, fee, market or order transport is connected to a real exchange.
const root=path.resolve('D:/codex/tmp/execution-operation-improvements-20261012/execution-operation-tests');
mkdirSync(root,{recursive:true});
function setup(t:{after:(fn:()=>void)=>void},mode:'paper'|'live'='live'){
  const directory=mkdtempSync(path.join(root,'case-'));
  const store=new Store(path.join(directory,'state.json'),{
    ...defaultConfig,mode,dataSource:mode==='live'?'public':'demo',feeOnly:true,maxOrderRetries:1,
  });
  const quotes=new Map<ExchangeId,MarketSnapshot>();
  for(const exchange of ['gate','bybit'] as const)quotes.set(exchange,{
    exchange,base:'BTC',symbol:'BTC/USDT:USDT',timestamp:Date.now(),markPrice:100,indexPrice:100,
    fundingRate:.001,nextFundingTime:Date.now()+60_000,intervalHours:8,fundingHistory:[],
    bids:[{price:100,quantity:1000}],asks:[{price:100,quantity:1000}],
    openInterestUsd:1e8,volume24hUsd:1e8,quantityStep:1,minQuantity:1,minNotional:1,contractSize:1,
    source:mode==='live'?'public':'demo',takerFeeRate:store.data.config.takerFees[exchange],
    takerFeeAt:Date.now(),takerFeeSource:'exchange',
  });
  const p:Position={id:'operation-position',base:'BTC',mode,status:'opening',feeOnly:true,
    long:{exchange:'gate',symbol:'BTC/USDT:USDT',side:'long',quantity:0,entryPrice:0,markPrice:100,feesUsd:0,liquidationDistancePct:null},
    short:{exchange:'bybit',symbol:'BTC/USDT:USDT',side:'short',quantity:0,entryPrice:0,markPrice:100,feesUsd:0,liquidationDistancePct:null},
    openedAt:Date.now(),plannedExitAt:Date.now()+60_000,holdMode:'once',fundingUsd:0,feesUsd:0,
    transferCostUsd:0,spreadPnlUsd:0,realizedSpreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[]};
  store.data.positions.push(p);
  const counts={submit:0,validate:0,reconcile:0,account:0,fee:0,refresh:0};
  const requests:Array<{exchange:ExchangeId;request:OrderRequest}>=[];
  const receipt=(request:OrderRequest,filled=request.quantity,status:OrderResult['status']='filled'):OrderResult=>({
    id:'native-'+request.clientOrderId,clientOrderId:request.clientOrderId,status,filledQuantity:filled,
    averagePrice:filled?request.limitPrice:0,feeUsd:filled*request.limitPrice*.0005,timestamp:Date.now(),
  });
  const adapters=new Map<ExchangeId,ExchangeAdapter>();
  for(const exchange of ['gate','bybit'] as const)adapters.set(exchange,{
    validateOrder:async()=>{counts.validate++;},
    placeOrder:async(request:OrderRequest)=>{counts.submit++;requests.push({exchange,request});return receipt(request);},
    reconcileOrder:async()=>{counts.reconcile++;throw new Error('unexpected reconciliation');},
    fetchAccount:async()=>{counts.account++;throw new Error('unexpected private account read');},
    fetchTradingFee:async()=>{counts.fee++;throw new Error('unexpected private fee read');},
    fetchTradingFees:async()=>{counts.fee++;throw new Error('unexpected private fee enumeration');},
  } as unknown as ExchangeAdapter);
  const execution=new Execution(store,{config:()=>store.data.config,snapshot:exchange=>quotes.get(exchange as ExchangeId),
    adapter:exchange=>adapters.get(exchange as ExchangeId)!,liveUnlocked:()=>true,
    refreshSnapshots:async(_base,exchanges)=>{counts.refresh++;for(const exchange of exchanges){
      const quote=quotes.get(exchange as ExchangeId)!;quote.timestamp=Date.now();quote.observedAt=quote.timestamp;
    }},halt:()=>{store.data.killSwitch=true;}});
  t.after(()=>{
    store.operations.dispose();const relative=path.relative(root,path.resolve(directory));
    assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(directory).startsWith('case-'));
    rmSync(directory,{recursive:true,force:true});
  });
  return {store,p,quotes,execution,adapters,counts,requests,receipt};
}

test('accepted entry rejected by venue preflight remains in the operation denominator without a submission',async t=>{
  const s=setup(t);s.adapters.get('bybit')!.validateOrder=async()=>{s.counts.validate++;throw new Error('invalid quantity precision');};
  await assert.rejects(()=>s.execution.open(s.p,10,10),/invalid quantity precision/);
  const summary=s.store.operations.snapshot(),row=summary.rows[0];
  assert.equal(summary.counts.total,1);assert.equal(summary.counts.failed,1);assert.equal(summary.completionRatePct,0);
  assert.equal(row.kind,'entry');assert.deepEqual(row.target,{long:10,short:10});
  assert.equal(row.attempts.preflightNotSent,1);assert.equal(row.attempts.submitted,0);assert.ok(row.endedAt);
  assert.equal(s.counts.validate,2);assert.equal(s.counts.submit,0);assert.equal(s.store.data.orders.length,0);
  assert.equal(s.p.long.quantity+s.p.short.quantity+s.p.feesUsd,0);
});

test('paper target fills stay awaiting account evidence instead of manufacturing a completed operation',async t=>{
  const s=setup(t,'paper');await s.execution.open(s.p,10,10);
  assert.equal(s.p.status,'open');assert.equal(s.store.data.orders.length,2);
  const summary=s.store.operations.snapshot(),row=summary.rows[0];
  assert.equal(summary.counts.complete,0);assert.equal(row.state,'partial');assert.equal(row.endedAt,undefined);
  assert.deepEqual(row.confirmed,{long:10,short:10});assert.deepEqual(row.remaining,{long:0,short:0});
  assert.ok(row.stages.pairedAt);assert.equal(row.stages.accountConfirmedAt,undefined);
  assert.equal(row.stages.acknowledgedAt,undefined,'paper client IDs do not prove native acknowledgement');
  assert.equal(s.counts.submit+s.counts.account+s.counts.fee,0);
});

test('IOC reductions across repeated close rounds retain the original operation target and identity',async t=>{
  const s=setup(t);s.p.status='open';s.p.short.quantity=10;s.p.short.entryPrice=100;
  const refresh=s.execution.context.refreshSnapshots!;
  s.execution.context.refreshSnapshots=async(base,exchanges)=>{
    await refresh(base,exchanges);s.quotes.get('bybit')!.asks=[{price:100,quantity:s.counts.refresh===1?3:s.counts.refresh===2?2:1000}];
  };
  s.adapters.get('bybit')!.placeOrder=async request=>{
    s.counts.submit++;s.requests.push({exchange:'bybit',request});
    return s.counts.submit===1?s.receipt(request,1,'partial'):s.receipt(request);
  };
  await s.execution.close(s.p,'close residual');assert.equal(s.p.short.quantity,7);
  const first=s.store.operations.current(s.p.id)!;assert.equal(first.kind,'close');
  assert.deepEqual(first.target,{long:0,short:10});assert.deepEqual(first.confirmed,{long:0,short:3});
  await s.execution.close(s.p,'continue confirmed residual');
  assert.equal(s.p.short.quantity,0);assert.equal(s.p.status,'closed');
  const summary=s.store.operations.snapshot(),row=summary.rows[0];
  assert.equal(summary.counts.total,1);assert.equal(row.id,first.id);
  assert.deepEqual(row.target,{long:0,short:10});assert.deepEqual(row.confirmed,{long:0,short:10});
  assert.deepEqual(s.requests.map(({request})=>request.quantity),[3,2,7]);
  assert.ok(s.requests.every(({request})=>request.reduceOnly));assert.equal(row.attempts.submitted,3);
  assert.equal(row.stages.accountConfirmedAt,undefined);assert.equal(summary.counts.complete,0);
});

test('concurrent IOC close reports the still-awaited second adapter call as pending after the first leg returns',{timeout:5000},async t=>{
  const s=setup(t);s.p.status='open';s.p.long.quantity=10;s.p.short.quantity=10;
  s.p.long.entryPrice=100;s.p.short.entryPrice=100;
  let releaseSecond:((result:OrderResult)=>void)|undefined,secondRequest:OrderRequest|undefined;
  let observedFirst:()=>void=()=>{};
  const firstObserved=new Promise<void>(resolve=>{observedFirst=resolve;});
  const observe=s.store.operations.observe.bind(s.store.operations);
  s.store.operations.observe=(position,orders)=>{
    observe(position,orders);
    if(orders.some(order=>order.exchange==='gate'&&order.result)&&
      orders.some(order=>order.exchange==='bybit'&&order.result===undefined))observedFirst();
  };
  s.adapters.get('bybit')!.placeOrder=request=>{
    s.counts.submit++;s.requests.push({exchange:'bybit',request});secondRequest=request;
    return new Promise<OrderResult>(resolve=>{releaseSecond=resolve;});
  };
  const closing=s.execution.close(s.p,'concurrent close');
  try{
    await firstObserved;
    const row=s.store.operations.current(s.p.id)!;
    assert.equal(row.attempts.submitted,2);assert.equal(row.attempts.pending,1);assert.equal(row.attempts.unknown,0);
    assert.equal(row.attempts.zeroFill,0);assert.equal(row.state,'partial');
    assert.deepEqual(row.confirmed,{long:10,short:0});assert.deepEqual(row.remaining,{long:0,short:10});
    assert.equal(s.store.operations.snapshot().counts.complete,0);
  }finally{if(releaseSecond&&secondRequest)releaseSecond(s.receipt(secondRequest));await closing;}
  assert.equal(s.p.status,'closed');const final=s.store.operations.current(s.p.id)!;
  assert.equal(final.attempts.pending,0);assert.equal(final.attempts.unknown,0);
  assert.deepEqual(final.confirmed,{long:10,short:10});assert.equal(final.stages.accountConfirmedAt,undefined);
});

test('telemetry does not add private requests or order submissions to the same mocked open and close',async t=>{
  const observed=setup(t),baseline=setup(t);
  baseline.store.operations.begin=()=>undefined;
  for(const s of [baseline,observed]){await s.execution.open(s.p,10,10);await s.execution.close(s.p,'ordinary close');}
  assert.deepEqual(observed.counts,baseline.counts);assert.equal(observed.counts.submit,4);
  assert.equal(observed.counts.account,0);assert.equal(observed.counts.fee,0);assert.equal(observed.counts.reconcile,0);
  const requestValues=(s:typeof observed)=>s.requests.map(({exchange,request})=>({exchange,side:request.side,
    quantity:request.quantity,price:request.limitPrice,reduceOnly:request.reduceOnly}));
  assert.deepEqual(requestValues(observed),requestValues(baseline));
  assert.deepEqual([observed.p.long.quantity,observed.p.short.quantity,observed.p.feesUsd,observed.p.netPnlUsd],
    [baseline.p.long.quantity,baseline.p.short.quantity,baseline.p.feesUsd,baseline.p.netPnlUsd]);
  assert.equal(observed.store.operations.snapshot().counts.total,2);
});

test('an unknown original receipt stays unknown without zero-fill, completion, or duplicate submission',async t=>{
  const s=setup(t);
  for(const exchange of ['gate','bybit'] as const){
    s.adapters.get(exchange)!.placeOrder=async request=>{
      s.counts.submit++;s.requests.push({exchange,request});throw new Error('mock timeout');
    };
    s.adapters.get(exchange)!.reconcileOrder=async request=>{
      s.counts.reconcile++;return {...s.receipt(request,0,'unknown'),id:''};
    };
  }
  await s.execution.open(s.p,10,10);
  const row=s.store.operations.snapshot().rows[0];assert.equal(row.kind,'entry');assert.equal(row.state,'unknown');
  assert.equal(row.attempts.unknown,1);assert.equal(row.attempts.zeroFill,0);assert.equal(row.attempts.submitted,1);
  assert.deepEqual(row.remaining,{long:10,short:null});assert.equal(row.confirmed.short,null);assert.equal(row.stages.acknowledgedAt,undefined);
  assert.equal(row.endedAt,undefined);assert.equal(s.counts.submit,1);
  await assert.rejects(()=>s.execution.close(s.p,'repeat close'),UncertainOrderError);
  assert.equal(s.counts.submit,1);assert.equal(s.store.operations.snapshot().counts.complete,0);
});

test('a real diagnostic sidecar write failure does not block mocked fills or change the financial ledger schema',async t=>{
  const s=setup(t);mkdirSync(s.store.operations.path);
  for(const exchange of ['gate','bybit'] as const){
    const submit=s.adapters.get(exchange)!.placeOrder;
    s.adapters.get(exchange)!.placeOrder=async request=>{
      assert.doesNotThrow(()=>s.store.operations.flush());
      assert.ok(s.store.operations.snapshot().diagnosticError);return submit(request);
    };
  }
  await s.execution.open(s.p,10,10);await s.execution.close(s.p,'ordinary close');
  assert.equal(s.p.status,'closed');assert.equal(s.p.long.quantity+s.p.short.quantity,0);
  assert.equal(s.counts.submit,4);assert.equal(s.p.feesUsd,2);assert.equal(s.p.netPnlUsd,-2);
  const ledger=JSON.parse(readFileSync(s.store.path,'utf8')) as Record<string,unknown>;
  assert.equal('operations' in ledger,false);assert.equal('diagnosticError' in ledger,false);
  assert.equal((ledger.orders as unknown[]).length,4);assert.ok(s.store.operations.snapshot().diagnosticError);
  assert.equal(s.store.data.killSwitch,false);assert.equal(s.counts.account+s.counts.fee,0);
});
