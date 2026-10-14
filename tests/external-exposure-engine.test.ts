import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as immediate} from 'node:timers/promises';
import {Engine,type SelectedExternalExposureRecoveryRequest} from '../src/core/engine.js';
import {alignedExitProfitsPass} from '../src/core/profit-exit.js';
import type {AccountState,ExitProfit,LivePortfolio,MarketSnapshot,OrderResult,Position} from '../src/shared/types.js';
import {fixture} from './external-exposure-reduction-fixture.js';

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return {promise,resolve};}
async function flush(){for(let turn=0;turn<18;turn++)await immediate();}
type Internal={
  externalExposureSources:Set<string>;externalExposureWorkers:Map<string,Promise<void>>;
  externalExposureRetryAt:Map<string,number>;externalExposureRetryTimers:Map<string,ReturnType<typeof setTimeout>>;
  scheduleExternalExposureReduction:(p:Position)=>void;observePendingReports:(portfolio:LivePortfolio)=>Promise<void>;
  exclusive:<T>(work:()=>Promise<T>)=>Promise<T>;stopping:boolean;credentialUpdatePending:boolean;
  maintenanceTradingPending:boolean;environmentPermissionRevoked:boolean;liveEnvironment:object;
};
function engineFixture(privateReadDeadlineMs=8000){
  const f=fixture();
  const adapters=new Map((['bitget','gate'] as const).map(exchange=>[exchange,f.options.adapter(exchange)]));
  Object.assign(f.store.data.config,{exchanges:['bitget','gate'],symbols:['DOS'],entryPolicy:'aligned',holdMode:'adaptive',
    minExitProfitBps:10,profitExitExecutionMode:'ioc',feeRebatePct:{gate:70,bitget:50},autoEnabled:false});
  f.source.profitExitNotionalUsd=100;
  let feeReads=0,closes=0;
  for(const [exchange,adapter] of adapters){
    adapter.fetchAccount=async()=> (await f.options.readAccount(exchange)).account;
    adapter.getExecutionSnapshot=base=>base==='DOS'?f.books.get(exchange):undefined;
    adapter.fetchExecutionSnapshots=async bases=>{for(const book of f.books.values())book.timestamp=Date.now();return bases.includes('DOS')?[f.books.get(exchange)!]:[];};
    adapter.fetchSnapshots=async()=>[];
    adapter.fetchFundingPayments=async()=>[];
    adapter.fetchTradingFee=async()=>{feeReads++;throw new Error('No private fee request is authorized by this offline risk test');};
    adapter.close=async()=>{closes++;};
  }
  const engine=new Engine(f.store,true,{privateReadDeadlineMs,adapterFactory:()=>[...adapters.values()],liveEnvironment:{
    ALLOW_LIVE_TRADING:'true',LIVE_TRADING_ACK:'I_UNDERSTAND_THE_RISKS',GATE_API_KEY:'OFFLINE',GATE_API_SECRET:'OFFLINE',
    BITGET_API_KEY:'OFFLINE',BITGET_API_SECRET:'OFFLINE',BITGET_PASSPHRASE:'OFFLINE'}});
  engine.running=true;engine.autoEnabled=false;
  const internal=engine as unknown as Internal;
  const request=():SelectedExternalExposureRecoveryRequest=>({acknowledgement:'RESTORE_SELECTED_EXTERNAL_EXPOSURE_MANAGEMENT',
    expiresAt:Date.now()+60000,positionId:f.source.id,expected:{base:f.source.base,openedAt:f.source.openedAt,
      longExchange:f.source.long.exchange,longSymbol:f.source.long.symbol,longQuantity:f.source.long.quantity,
      shortExchange:f.source.short.exchange,shortSymbol:f.source.short.symbol,shortQuantity:f.source.short.quantity}});
  const portfolio=():LivePortfolio=>({timestamp:Date.now(),pollIntervalMs:1000,maxAgeMs:30000,
    exchanges:[...f.accounts].map(([exchange,account])=>({exchange,credentialsConfigured:true,status:'ready',
      requestedAt:Date.now(),receivedAt:Date.now(),freeUsd:account.freeUsd,equityUsd:account.equityUsd,positions:structuredClone(account.positions)}))});
  return {...f,adapters,engine,internal,request,portfolio,feeReads:()=>feeReads,closes:()=>closes,
    stop:async()=>{await engine.stop();f.cleanup();}};
}
function originalCash(p:Position){return structuredClone({long:p.long,short:p.short,openedAt:p.openedAt,fees:p.feesUsd,
  funding:p.fundingUsd,transfer:p.transferCostUsd,realized:p.realizedSpreadPnlUsd,basis:p.profitExitNotionalUsd});}

for(const invalid of ['acknowledgement','expired','nonfinite','too-long','auto-enabled','quantity','symbol','cycle','unknown-id'] as const)
test(`selected external restore rejects ${invalid} before native reads or financial actions`,async()=>{
  const f=engineFixture();try{const request=f.request();
    if(invalid==='acknowledgement')request.acknowledgement='UNAUTHORIZED' as typeof request.acknowledgement;
    else if(invalid==='expired')request.expiresAt=Date.now()-1;
    else if(invalid==='nonfinite')request.expiresAt=NaN;
    else if(invalid==='too-long')request.expiresAt=Date.now()+61000;
    else if(invalid==='auto-enabled')f.engine.autoEnabled=true;
    else if(invalid==='quantity')request.expected.longQuantity++;
    else if(invalid==='symbol')request.expected.shortSymbol='OTHER/USDT:USDT';
    else if(invalid==='cycle')request.expected.openedAt--;
    else request.positionId='another-position';
    await assert.rejects(()=>f.engine.restoreSelectedExternalExposureManagement(request));
    assert.equal(f.internal.externalExposureSources.size,0);assert.equal(f.internal.externalExposureWorkers.size,0);
    assert.equal(f.accountCalls.length,0);assert.equal(f.requests.length,0);assert.equal(f.store.data.positions.length,1);
  }finally{await f.stop();}
});

test('a queued selected restore rechecks expiry and original quantity after the financial queue is released',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1700000000000});const f=engineFixture();const hold=deferred<void>();
  try{const queue=f.internal.exclusive(()=>hold.promise);await flush();const request=f.request();request.expiresAt=Date.now()+5;
    const pending=f.engine.restoreSelectedExternalExposureManagement(request);const rejected=assert.rejects(pending);
    t.mock.timers.tick(6);hold.resolve();await queue;await rejected;
    assert.equal(f.internal.externalExposureSources.size,0);assert.equal(f.requests.length,0);
    const current=f.request();current.expected.longQuantity=99;
    await assert.rejects(()=>f.engine.restoreSelectedExternalExposureManagement(current),/身份或数量已变化/);
  }finally{hold.resolve();await f.stop();}
});

test('historical attention and saved audits confer no implicit external risk authority',async()=>{
  const f=engineFixture();try{
    f.source.accountExposureIncidents=[{version:1,id:'historical-incident',status:'detected',positionId:f.source.id,
      base:f.source.base,openedAt:f.source.openedAt,detectedAt:Date.now()-1000,accountReadStartedAt:Date.now()-1000,
      lastFinancialActivityAt:0,observedExchange:'gate',symbol:f.source.short.symbol,side:'short',expectedQuantity:100,
      nativeQuantity:0,reason:'missing',nativeRows:[],originalLegs:[{exchange:'bitget',symbol:f.source.long.symbol,side:'long',quantity:100,entryPrice:1},
        {exchange:'gate',symbol:f.source.short.symbol,side:'short',quantity:100,entryPrice:1}],pausedNewEntry:true}];
    f.internal.scheduleExternalExposureReduction(f.source);await flush();
    assert.equal(f.internal.externalExposureSources.size,0);assert.equal(f.accountCalls.length,0);assert.equal(f.requests.length,0);
    assert.equal(f.source.status,'attention');assert.equal(f.store.data.positions.length,1);
  }finally{await f.stop();}
});

test('one selected worker remains outside the cash queue and never manages an unselected historical group',async()=>{
  const f=engineFixture(),hold=deferred<AccountState>();const adapter=f.adapters.get('bitget')!,read=adapter.fetchAccount;
  adapter.fetchAccount=async context=>{const account=await read.call(adapter,context);if(f.accountCalls.filter(x=>x==='bitget').length===1)return hold.promise;return account;};
  try{const unselected={...structuredClone(f.source),id:'old-unselected',base:'OTHER'};
    unselected.long.symbol='OTHER/USDT:USDT';unselected.short.symbol='OTHER/USDT:USDT';f.store.data.positions.push(unselected);
    const cash=originalCash(f.source),receipt=await f.engine.restoreSelectedExternalExposureManagement(f.request());await flush();
    assert.equal(receipt.autoEnabled,false);assert.deepEqual([...f.internal.externalExposureSources],[f.source.id]);
    assert.equal(f.internal.externalExposureWorkers.size,1);assert.equal(f.requests.length,0);
    const worker=f.internal.externalExposureWorkers.get(f.source.id);
    for(let i=0;i<8;i++)f.internal.scheduleExternalExposureReduction(f.source);
    f.internal.scheduleExternalExposureReduction(unselected);await flush();
    assert.equal(f.internal.externalExposureWorkers.get(f.source.id),worker);assert.equal(f.accountCalls.length,2);
    let queueRan=false;await f.internal.exclusive(async()=>{queueRan=true;});assert.equal(queueRan,true);
    hold.resolve(structuredClone(f.accounts.get('bitget')!));await worker;
    assert.equal(f.requests.length,1);assert.deepEqual(f.accountCalls,['bitget','gate','bitget','gate']);assert.equal(f.orderCalls.length,2);
    assert.deepEqual(originalCash(f.source),cash);assert.equal(unselected.status,'attention');assert.equal(f.feeReads(),0);
  }finally{hold.resolve(structuredClone(f.accounts.get('bitget')!));await f.stop();}
});

for(const revoke of ['stop','credentials','maintenance','configuration','environment','adapter','selected-source'] as const)
test(`native proof finishing after ${revoke} cannot send a risk reduction`,async()=>{
  const f=engineFixture(),hold=deferred<AccountState>();const adapter=f.adapters.get('bitget')!,read=adapter.fetchAccount;
  adapter.fetchAccount=async context=>{const account=await read.call(adapter,context);if(f.accountCalls.filter(x=>x==='bitget').length===1)return hold.promise;return account;};
  try{await f.engine.restoreSelectedExternalExposureManagement(f.request());await flush();
    if(revoke==='stop')f.internal.stopping=true;
    else if(revoke==='credentials')f.internal.credentialUpdatePending=true;
    else if(revoke==='maintenance')f.internal.maintenanceTradingPending=true;
    else if(revoke==='configuration')f.store.data.config={...f.store.data.config};
    else if(revoke==='environment')f.internal.liveEnvironment={...f.internal.liveEnvironment};
    else if(revoke==='adapter')f.engine.adapters=f.engine.adapters.filter(x=>x!==adapter);
    else f.internal.externalExposureSources.delete(f.source.id);
    const worker=f.internal.externalExposureWorkers.get(f.source.id)!;hold.resolve(structuredClone(f.accounts.get('bitget')!));await worker;
    assert.equal(f.requests.length,0);assert.equal(f.store.data.positions.length,1);assert.equal(f.source.long.quantity,100);
  }finally{hold.resolve(structuredClone(f.accounts.get('bitget')!));await f.stop();}
});

test('stop drains a still pending native account read and does not start another worker or POST',async()=>{
  const f=engineFixture(),hold=deferred<AccountState>();const adapter=f.adapters.get('bitget')!,read=adapter.fetchAccount;
  adapter.fetchAccount=async context=>{await read.call(adapter,context);return hold.promise;};
  let stopped=false;
  try{await f.engine.restoreSelectedExternalExposureManagement(f.request());await flush();
    const stopping=f.engine.stop().then(()=>{stopped=true;});await flush();
    assert.equal(stopped,false);assert.equal(f.closes(),0);assert.equal(f.internal.externalExposureWorkers.size,1);
    hold.resolve(structuredClone(f.accounts.get('bitget')!));await stopping;
    assert.equal(stopped,true);assert.equal(f.requests.length,0);assert.equal(f.internal.externalExposureRetryTimers.size,0);assert.equal(f.closes(),2);
  }finally{hold.resolve(structuredClone(f.accounts.get('bitget')!));await f.stop();}
});

test('a logical native read timeout retains worker ownership and stop drains the actual pending GET',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1700000000000});const f=engineFixture(8),hold=deferred<AccountState>();
  const adapter=f.adapters.get('bitget')!,read=adapter.fetchAccount;adapter.fetchAccount=async context=>{await read.call(adapter,context);return hold.promise;};
  let stopped=false;
  try{await f.engine.restoreSelectedExternalExposureManagement(f.request());await flush();t.mock.timers.tick(9);await flush();
    assert.equal(f.internal.externalExposureWorkers.size,1,'logical timeout must not release the actual GET owner');
    assert.equal(f.internal.externalExposureRetryTimers.size,0,'no retry timer before the native request actually settles');
    const stopping=f.engine.stop().then(()=>{stopped=true;});await flush();assert.equal(stopped,false);assert.equal(f.closes(),0);
    hold.resolve(structuredClone(f.accounts.get('bitget')!));await stopping;assert.equal(f.requests.length,0);
  }finally{hold.resolve(structuredClone(f.accounts.get('bitget')!));await f.stop();}
});

test('a selected book timeout retains actual quote GET ownership until stop drains it and discards its late quote',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1700000000000});const f=engineFixture(8),hold=deferred<MarketSnapshot[]>();
  const adapter=f.adapters.get('bitget')!,book=f.books.get('bitget')!;let bookReads=0,stopped=false;
  book.timestamp=Date.now()-f.engine.config.maxSnapshotAgeMs-1;
  adapter.fetchExecutionSnapshots=async()=>{bookReads++;return hold.promise;};
  try{await f.engine.restoreSelectedExternalExposureManagement(f.request());await flush();
    assert.equal(bookReads,1);assert.equal(f.accountCalls.length,4);assert.equal(f.orderCalls.length,2);assert.equal(f.requests.length,0);
    t.mock.timers.tick(9);await flush();assert.equal(f.internal.externalExposureWorkers.size,1);assert.equal(f.internal.externalExposureRetryTimers.size,0);
    const stopping=f.engine.stop().then(()=>{stopped=true;});await flush();assert.equal(stopped,false);assert.equal(f.closes(),0);
    hold.resolve([{...structuredClone(book),timestamp:Date.now()}]);await stopping;
    assert.equal(stopped,true);assert.equal(f.requests.length,0);assert.equal(f.internal.externalExposureRetryTimers.size,0);
    assert.equal(f.engine.snapshots.length,0,'late native quote cannot publish after timeout and stop');assert.equal(bookReads,1);assert.equal(f.feeReads(),0);
  }finally{hold.resolve([]);await f.stop();}
});

test('stop drains a native POST already accepted and preserves its actual receipt once',async()=>{
  const f=engineFixture(),hold=deferred<void>(),adapter=f.adapters.get('bitget')!,post=adapter.placeOrder;
  adapter.placeOrder=async(request,guard)=>{const receipt=await post.call(adapter,request,guard);await hold.promise;return receipt;};
  let stopped=false;
  try{const cash=originalCash(f.source);await f.engine.restoreSelectedExternalExposureManagement(f.request());await flush();
    assert.equal(f.requests.length,1);assert.equal(f.store.data.orders[0].result,undefined);
    const stopping=f.engine.stop().then(()=>{stopped=true;});await flush();assert.equal(stopped,false);assert.equal(f.closes(),0);
    hold.resolve();await stopping;
    const child=f.store.data.positions.find(p=>p.manualCloseSourcePositionId===f.source.id)!;
    const saved=f.store.data.orders.find(order=>order.request.clientOrderId===f.requests[0].clientOrderId)!;
    assert.equal(saved.result?.filledQuantity,100);assert.equal(child.long.quantity,0);assert.equal(child.feesUsd,.01);
    assert.equal(f.store.data.killSwitch,false);assert.equal(f.internal.externalExposureRetryTimers.size,0);assert.deepEqual(originalCash(f.source),cash);
  }finally{hold.resolve();await f.stop();}
});

test('confirmed partials wake after 250ms and finish with a new GET-only double native proof',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1700000000000});const f=engineFixture();
  try{const cash=originalCash(f.source);f.setResultHook(request=>({id:`partial-native-${f.requests.length}`,clientOrderId:request.clientOrderId,
      status:f.requests.length===1?'cancelled':'filled',filledQuantity:f.requests.length===1?30:request.quantity,
      averagePrice:request.limitPrice,averagePriceVerified:true,feeUsd:.01,timestamp:Date.now()}));
    await f.engine.restoreSelectedExternalExposureManagement(f.request());await flush();
    assert.deepEqual(f.requests.map(r=>r.quantity),[100]);assert.equal(f.internal.externalExposureRetryTimers.size,1);
    const child=f.store.data.positions.find(p=>p.manualCloseSourcePositionId===f.source.id)!;assert.equal(child.long.quantity,70);
    t.mock.timers.tick(249);await flush();assert.equal(f.requests.length,1);
    t.mock.timers.tick(1);await flush();assert.deepEqual(f.requests.map(r=>r.quantity),[100,70]);assert.equal(child.long.quantity,0);assert.equal(child.feesUsd,.02);
    assert.equal(child.accountClosure,undefined,'a final IOC fill is not a fresh native flat proof');assert.equal(f.internal.externalExposureSources.size,1);
    t.mock.timers.tick(250);await flush();assert.equal(f.requests.length,2);assert.equal(f.accountCalls.length,12);assert.equal(f.orderCalls.length,6);
    assert.equal(f.internal.externalExposureSources.size,0);assert.equal(f.internal.externalExposureRetryTimers.size,0);assert.ok(child.accountClosure);
    t.mock.timers.tick(10000);await flush();assert.equal(f.requests.length,2);assert.deepEqual(originalCash(f.source),cash);
    assert.equal(f.feeReads(),0);assert.equal(f.engine.config.minExitProfitBps,10);assert.deepEqual(f.engine.config.feeRebatePct,{gate:70,bitget:50});
  }finally{await f.stop();}
});

test('ordinary paired profit exits retain the frozen 10bps guard while confirmed external risk may realize a loss',async()=>{
  const f=engineFixture();try{const p={...f.source,entryPolicy:'aligned' as const,status:'open' as const},profit=(netPnlUsd:number):ExitProfit=>({
      spreadPnlUsd:netPnlUsd,totalFeesUsd:0,fundingAfterFeesUsd:0,spreadAfterFeesUsd:netPnlUsd,netPnlUsd});
    assert.equal(alignedExitProfitsPass(p,profit(.10),f.engine.config),false);assert.equal(alignedExitProfitsPass(p,profit(.10001),f.engine.config),true);
    await f.engine.restoreSelectedExternalExposureManagement(f.request());await flush();
    const child=f.store.data.positions.find(p=>p.manualCloseSourcePositionId===f.source.id)!;
    assert.ok(child.realizedSpreadPnlUsd!<0);assert.equal(f.requests.length,1);assert.equal(f.requests[0].reduceOnly,true);
    assert.notEqual(f.requests[0].postOnly,true);assert.equal(f.feeReads(),0);assert.equal(f.engine.config.minExitProfitBps,10);
  }finally{await f.stop();}
});

test('background order GET never races the active risk POST; an unknown receipt is reconciled once after its worker ends',async()=>{
  const f=engineFixture(),hold=deferred<void>(),adapter=f.adapters.get('bitget')!,post=adapter.placeOrder;let inspections=0,actual:OrderResult|undefined;
  adapter.placeOrder=async(request,guard)=>{actual=await post.call(adapter,request,guard);await hold.promise;return {id:'',clientOrderId:request.clientOrderId,
    status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now()};};
  adapter.inspectOrder=async request=>{inspections++;assert.equal(request.clientOrderId,actual!.clientOrderId);return {...actual!,averagePriceVerified:true,orderReadAt:Date.now()};};
  try{await f.engine.restoreSelectedExternalExposureManagement(f.request());await flush();assert.equal(f.requests.length,1);
    const child=f.store.data.positions.find(p=>p.manualCloseSourcePositionId===f.source.id)!;
    await f.internal.observePendingReports(f.portfolio());assert.equal(inspections,0);assert.equal(child.feesUsd,0);assert.equal(child.long.quantity,100);
    const worker=f.internal.externalExposureWorkers.get(f.source.id)!;hold.resolve();await worker;
    assert.equal(f.store.data.orders[0].result?.status,'unknown');assert.equal(f.internal.externalExposureWorkers.size,0);
    await f.internal.observePendingReports(f.portfolio());assert.equal(inspections,1);assert.equal(child.feesUsd,.01);assert.equal(child.long.quantity,0);
    await f.internal.observePendingReports(f.portfolio());assert.equal(inspections,1);assert.equal(child.feesUsd,.01);assert.equal(f.store.data.killSwitch,false);
    assert.equal(f.store.data.orders.length,1);assert.equal(f.requests.length,1);
  }finally{hold.resolve();await f.stop();}
});
