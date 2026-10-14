import test from 'node:test';
import assert from 'node:assert/strict';
import {Execution} from '../src/core/execution.js';
import {defaultConfig} from '../src/shared/config.js';
import {unknownOrder} from '../src/adapters/normalization.js';
import type {Store} from '../src/core/store.js';
import type {AppConfig,ExchangeAdapter,ExchangeId,JournalOrder,MarketSnapshot,NativeExitRecoveryAudit,OrderRequest,OrderResult,Position} from '../src/shared/types.js';

function fixture(base='IOCEXIT'){
  let config:AppConfig={...structuredClone(defaultConfig),mode:'live',dataSource:'public',entryPolicy:'aligned',holdMode:'adaptive',
    profitExitExecutionMode:'ioc',exchanges:['gate','bybit'],symbols:[base],minExitProfitBps:10,feeRebatePct:{gate:70,bitget:50}};
  const now=Date.now(),symbol=`${base}/USDT:USDT`;
  const p:Position={id:`offline-${base}`,base,mode:'live',entryPolicy:'aligned',holdMode:'adaptive',status:'open',openedAt:now-60_000,
    plannedExitAt:now+4_000_000,profitExitNotionalUsd:10,
    long:{exchange:'gate',symbol,side:'long',quantity:10,entryPrice:1,markPrice:1,feesUsd:.001,liquidationDistancePct:null},
    short:{exchange:'bybit',symbol,side:'short',quantity:10,entryPrice:1,markPrice:1,feesUsd:.001,liquidationDistancePct:null},
    fundingUsd:0,feesUsd:.002,transferCostUsd:0,realizedSpreadPnlUsd:0,spreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[],
    profitExitPolicy:{firstFundingTime:now+3_600_000,earliestExitAt:now+3_610_000,minSpreadNetUsd:0,minCombinedNetUsd:0,fundingChecks:[]}};
  const orders:JournalOrder[]=[],logs:string[]=[],saved:unknown[]=[],posts:Array<{exchange:ExchangeId;request:OrderRequest}>=[],reads:string[]=[];
  for(const leg of [p.long,p.short]){const id=`offline-open-${leg.exchange}-${base}`;
    orders.push({positionId:p.id,exchange:leg.exchange,createdAt:p.openedAt,
      request:{clientOrderId:id,base,symbol,side:leg.side==='long'?'buy':'sell',quantity:10,limitPrice:1,reduceOnly:false},
      result:{id:`native-${id}`,clientOrderId:id,status:'filled',filledQuantity:10,averagePrice:1,averagePriceVerified:true,feeUsd:.001,timestamp:p.openedAt}});
  }
  let saveFault=0,saves=0,allowed=true;
  const data={version:1 as const,config,positions:[p],orders,logs:[],equity:[],killSwitch:false,fundingSeen:[]};
  const store={data,save(){saves++;if(saveFault===saves)throw new Error('offline persistence failure');saved.push(structuredClone(data));},
    log(_level:unknown,message:string){logs.push(message);}} as unknown as Store;
  const books=new Map<ExchangeId,MarketSnapshot>();
  for(const exchange of ['gate','bybit'] as const)books.set(exchange,{exchange,base,symbol,source:'public',timestamp:now,observedAt:now,fundingObservedAt:now,
    markPrice:1,indexPrice:1,fundingRate:exchange==='bybit'?.001:0,nextFundingTime:now+3_600_000,intervalHours:8,fundingHistory:[],
    bids:[{price:exchange==='gate'?1.02:1,quantity:10}],asks:[{price:exchange==='gate'?1.03:1.01,quantity:10}],
    quantityStep:1,minQuantity:1,minNotional:1_000_000,contractSize:1,openInterestUsd:1e6,volume24hUsd:1e6,
    takerFeeRate:.0005,takerFeeAt:now,takerFeeSource:'exchange'});
  const result=(request:OrderRequest,fill=request.quantity,status:OrderResult['status']=fill===request.quantity?'filled':fill>0?'partial':'cancelled'):OrderResult=>({
    id:`native-${request.clientOrderId}`,clientOrderId:request.clientOrderId,status,filledQuantity:fill,
    averagePrice:fill?request.limitPrice:0,averagePriceVerified:true,feeUsd:fill*request.limitPrice*.0005,timestamp:Date.now()});
  let queue=Promise.resolve();const serial=<T>(fn:()=>Promise<T>):Promise<T>=>{const next=queue.then(fn,fn);queue=next.then(()=>undefined,()=>undefined);return next;};
  const adapters=new Map<ExchangeId,ExchangeAdapter>();
  for(const exchange of ['gate','bybit'] as const)adapters.set(exchange,{id:exchange,fetchSnapshots:async()=>[],fetchFundingPayments:async()=>[],prepareTrading:async()=>{},
    fetchAccount:async()=>{reads.push(`account:${exchange}`);const leg=exchange==='gate'?p.long:p.short;
      return {freeUsd:100,equityUsd:100,positions:leg.quantity>0?[{base,symbol,side:leg.side,quantity:leg.quantity,entryPrice:1,markPrice:1,
        liquidationPrice:0,leverage:2,marginMode:'crossed',positionId:`slot-${exchange}`,positionOpenedAt:p.openedAt}]:[]};},
    fetchOpenOrders:async()=>{reads.push(`open:${exchange}`);return [];},validateOrder:async()=>{},
    placeOrder:async(request,permit)=>{assert.equal(permit?.(),true);posts.push({exchange,request:structuredClone(request)});return result(request);},
    reconcileOrder:async request=>unknownOrder(request),cancelOrder:async()=>{throw new Error('IOC must not rest or require cancel');},close:async()=>{}});
  const refresh=()=>{for(const book of books.values())Object.assign(book,{timestamp:Date.now(),observedAt:Date.now(),fundingObservedAt:Date.now(),takerFeeAt:Date.now()});};
  const execution=new Execution(store,{config:()=>config,liveUnlocked:()=>allowed,makerActionsAllowed:()=>allowed,serialize:serial,
    snapshot:exchange=>books.get(exchange as ExchangeId),adapter:exchange=>adapters.get(exchange as ExchangeId)!,canUseSnapshot:()=>true,
    refreshSnapshots:async()=>refresh(),halt:reason=>logs.push(`halt:${reason}`)});
  return {execution,store,p,books,adapters,posts,reads,saved,logs,result,serial,refresh,
    async close(){await execution.drainIocProfitCloses();await execution.drainMakerCloses();},
    async start(validate=()=>true){assert.equal(execution.dispatchIocProfitClose(p,'offline IOC profit exit',validate),true);await execution.waitIocProfitClose(p);},
    revoke(){allowed=false;},changeConfig(){config={...config};store.data.config=config;},failNextSave(offset=1){saveFault=saves+offset;}};
}

function riskFixture(){
  const f=fixture('EXTERNALRISK');f.p.manualCloseOnly=true;f.p.manualCloseAccountRecord=true;
  f.p.manualCloseSourcePositionId='original-external-hedge';f.p.short.quantity=0;f.p.short.feesUsd=0;
  f.p.externalExposureReduction={version:1,sourcePositionId:f.p.manualCloseSourcePositionId,sourceOpenedAt:f.p.openedAt,
    authorizedAt:Date.now(),side:'long',exchange:'gate',symbol:f.p.long.symbol,initialExcessQuantity:10,
    initialNativeQuantity:10,peerInitialQuantity:0,nativeIdentity:'offline-risk-native'};
  f.p.feesUsd=0;f.p.long.feesUsd=0;f.store.data.orders.length=0;
  return f;
}
test('external risk reduction uses one BBO IOC, books a partial once and never starts another order itself',async t=>{
  const f=riskFixture();t.after(()=>f.close());
  f.adapters.get('gate')!.placeOrder=async(request,permit)=>{
    assert.equal(permit?.(),true);f.posts.push({exchange:'gate',request});
    await f.serial(async()=>assert.equal(f.p.long.quantity,10));return f.result(request,4);
  };
  await f.execution.reduceExternalRisk(f.p,f.p.long,10,()=>true);
  assert.equal(f.posts.length,1);assert.equal(f.posts[0].request.limitPrice,1.02);
  assert.equal(f.posts[0].request.reduceOnly,true);assert.notEqual(f.posts[0].request.postOnly,true);
  assert.equal(f.p.long.quantity,6);assert.equal(f.p.short.quantity,0);assert.equal(f.p.status,'attention');
  assert.equal(f.p.feesUsd,4*1.02*.0005);assert.equal(f.store.data.orders.length,1);
});
for(const mutation of ['remove-intent','change-request','replace-leg','change-quantity'] as const)
test(`external risk quarantines the actual native receipt without booking when its owner changes: ${mutation}`,async t=>{
  const f=riskFixture();t.after(()=>f.close());
  f.adapters.get('gate')!.placeOrder=async(request,permit)=>{
    assert.equal(permit?.(),true);const actual=f.result(request,4);
    if(mutation==='remove-intent')f.store.data.orders.length=0;
    if(mutation==='change-request')f.store.data.orders[0].request.clientOrderId='mutated-client-id';
    if(mutation==='replace-leg')f.p.long={...f.p.long};
    if(mutation==='change-quantity')f.p.long.quantity=9;
    return actual;
  };
  await assert.rejects(f.execution.reduceExternalRisk(f.p,f.p.long,10,()=>true),/已保存未入账回执/);
  assert.equal(f.store.data.killSwitch,true);assert.equal(f.p.feesUsd,0);assert.equal(f.p.realizedSpreadPnlUsd,0);
  assert.equal(f.p.long.quantity,mutation==='change-quantity'?9:10);
  const audit=f.store.data.unappliedRiskReceipts!;assert.equal(audit.length,1);
  assert.equal(audit[0].result.filledQuantity,4);assert.equal(audit[0].request.clientOrderId,audit[0].result.clientOrderId);
  assert.notEqual(audit[0].request.clientOrderId,'mutated-client-id');
  assert.equal((f.saved.at(-1) as typeof f.store.data).unappliedRiskReceipts?.length,1);
});
test('external risk native final permission veto preserves the original zero intent without confirmed cash',async t=>{
  const f=riskFixture();t.after(()=>f.close());let allowed=true;
  f.adapters.get('gate')!.placeOrder=async(request,permit)=>{
    allowed=false;assert.equal(permit?.(),false);
    return {id:'',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,
      timestamp:Date.now(),rejectionCode:'ORDER_SUBMISSION_PERMISSION_CHANGED'};
  };
  await f.execution.reduceExternalRisk(f.p,f.p.long,10,()=>allowed);
  assert.equal(f.p.long.quantity,10);assert.equal(f.p.feesUsd,0);assert.equal(f.posts.length,0);
  assert.equal(f.store.data.orders[0].result?.rejectionCode,'IOC_REDUCTION_PERMISSION_CHANGED');
  assert.equal(f.store.data.killSwitch,false);
});
test('external risk unknown retains one original ID and cannot be reissued even if the caller erroneously permits',async t=>{
  const f=riskFixture();t.after(()=>f.close());
  f.adapters.get('gate')!.placeOrder=async(request,permit)=>{
    assert.equal(permit?.(),true);f.posts.push({exchange:'gate',request});return unknownOrder(request,'native-risk-unknown');
  };
  await f.execution.reduceExternalRisk(f.p,f.p.long,10,()=>true);
  assert.equal(f.p.status,'attention');assert.equal(f.store.data.orders[0].result?.status,'unknown');
  await assert.rejects(f.execution.reduceExternalRisk(f.p,f.p.long,10,()=>true));
  assert.equal(f.posts.length,1);assert.equal(f.store.data.orders.length,1);assert.equal(f.p.long.quantity,10);
});
test('external risk durable intent failure stops before POST and leaves an unresolved intent for review',async t=>{
  const f=riskFixture();t.after(()=>f.close());f.failNextSave();
  await assert.rejects(f.execution.reduceExternalRisk(f.p,f.p.long,10,()=>true));
  assert.equal(f.posts.length,0);assert.equal(f.store.data.orders.length,1);assert.equal(f.store.data.orders[0].result,undefined);
  assert.equal(f.store.data.killSwitch,true);assert.equal(f.p.long.quantity,10);
});
test('external risk actual fill is retained when permission is revoked during the native response',async t=>{
  const f=riskFixture();t.after(()=>f.close());
  f.adapters.get('gate')!.placeOrder=async(request,permit)=>{
    assert.equal(permit?.(),true);f.posts.push({exchange:'gate',request});f.revoke();return f.result(request);
  };
  await f.execution.reduceExternalRisk(f.p,f.p.long,10,()=>true);
  assert.equal(f.p.long.quantity,0);assert.equal(f.p.status,'closed');assert.equal(f.store.data.orders[0].result?.filledQuantity,10);
  assert.equal(f.p.feesUsd,10*1.02*.0005);
});
test('two external risk callers cannot submit the same unresolved child budget concurrently',async t=>{
  const f=riskFixture();t.after(()=>f.close());let release=()=>{},entered=0;
  const barrier=new Promise<void>(resolve=>{release=resolve;});
  f.adapters.get('gate')!.validateOrder=async()=>{if(++entered===2)release();await barrier;};
  f.adapters.get('gate')!.placeOrder=async(request,permit)=>{
    assert.equal(permit?.(),true);f.posts.push({exchange:'gate',request});return unknownOrder(request,'native-concurrent-risk');
  };
  const results=await Promise.allSettled([f.execution.reduceExternalRisk(f.p,f.p.long,10,()=>true),
    f.execution.reduceExternalRisk(f.p,f.p.long,10,()=>true)]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(f.posts.length,1);assert.equal(f.store.data.orders.length,1);
  assert.equal(f.store.data.orders[0].result?.status,'unknown');assert.equal(f.p.long.quantity,10);
});
test('paired IOC captures the actual book veto separately from zero-fill exchange receipts',async t=>{
  const f=fixture('VETOBOOK');t.after(()=>f.close());
  for(const [exchange,adapter] of f.adapters)adapter.placeOrder=async(request,permit)=>{
    const book=f.books.get(exchange)!;
    if(request.side==='sell')book.bids=[{price:request.limitPrice*.99,quantity:10}];
    else book.asks=[{price:request.limitPrice*1.01,quantity:10}];
    assert.equal(permit?.(),false);
    return {id:'',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,
      timestamp:Date.now(),rejectionCode:'ORDER_SUBMISSION_PERMISSION_CHANGED'};
  };
  await f.start();const orders=f.store.data.orders.filter(order=>order.request.reduceOnly);
  assert.equal(orders.length,2);assert.equal(f.posts.length,0);
  for(const order of orders){
    assert.equal(order.executionEvidence?.iocSubmissionVeto?.code,'book');
    assert.equal(order.executionEvidence?.iocSubmissionVeto?.requestedLimitPrice,order.request.limitPrice);
    assert.ok(Number.isFinite(order.executionEvidence?.iocSubmissionVeto?.nativeProofAgeMs));
  }
  assert.ok(f.logs.some(message=>message.includes('首档盘口价格、数量或时效变化')));
  assert.equal(f.p.long.quantity,10);assert.equal(f.p.short.quantity,10);assert.equal(f.store.data.killSwitch,false);
});

for(const phase of ['book-refresh','native-validation'] as const)for(const syscall of ['connect','getaddrinfo'])
test(`IOC ${phase} ${syscall} read failure waits locally before any intent and keeps other trading allowed`,async t=>{
  const f=fixture();t.after(()=>f.close());
  const fail=async()=>{throw Object.assign(new Error('offline private payload must remain hidden'),{syscall,code:'ETIMEDOUT'});};
  if(phase==='book-refresh')f.execution.context.refreshSnapshots=fail;
  else f.adapters.get('gate')!.validateOrder=fail;
  await f.start();assert.equal(f.store.data.killSwitch,false);assert.equal(f.p.status,'open');
  assert.equal(f.p.closeRequestedAt,undefined);assert.equal(f.posts.length,0);
  assert.equal(f.store.data.orders.filter(order=>order.request.reduceOnly).length,0);
  assert.ok(f.execution.iocProfitCloseRetryAfter(f.p)>Date.now());assert.equal(f.p.long.quantity,10);assert.equal(f.p.short.quantity,10);
  assert.ok(f.logs.every(line=>!line.includes('private payload')));
});

test('IOC profit close submits both opposite1 reduce-only legs together and frees the cash queue during native network wait',async t=>{
  const f=fixture();t.after(()=>f.close());let release:()=>void=()=>{},bothPosted=false;
  const pending=new Promise<void>(resolve=>{release=resolve;});
  f.adapters.get('gate')!.placeOrder=async(request,permit)=>{assert.equal(permit?.(),true);f.posts.push({exchange:'gate',request});await pending;return f.result(request);};
  f.adapters.get('bybit')!.placeOrder=async(request,permit)=>{
    assert.equal(permit?.(),true);f.posts.push({exchange:'bybit',request});assert.equal(f.posts.length,2);bothPosted=true;
    await f.serial(async()=>assert.equal(f.p.long.quantity,10));release();return f.result(request);
  };
  await f.start();assert.equal(bothPosted,true);assert.equal(f.p.status,'closed');assert.equal(f.p.long.quantity,0);assert.equal(f.p.short.quantity,0);
  assert.ok(f.posts.every(({request})=>request.reduceOnly===true&&request.postOnly!==true&&request.quantity===10));
  assert.equal(f.posts.find(post=>post.exchange==='gate')!.request.limitPrice,1.02);assert.equal(f.posts.find(post=>post.exchange==='bybit')!.request.limitPrice,1.01);
  const closeOrders=f.store.data.orders.filter(order=>order.request.reduceOnly);
  assert.equal(closeOrders.length,2);assert.equal(closeOrders[0].executionEvidence!.batchId,closeOrders[1].executionEvidence!.batchId);
  assert.deepEqual(closeOrders.map(order=>order.executionEvidence!.closeFeeRebatePct),[70,0]);
  assert.equal(closeOrders[0].executionEvidence!.referencePrice,1.02);assert.equal(closeOrders[1].executionEvidence!.referencePrice,1.01);
  assert.ok(closeOrders.every(order=>order.executionEvidence!.method==='ioc'&&order.executionEvidence!.role==='exit'));
  assert.ok(f.saved.some(snapshot=>((snapshot as {orders:JournalOrder[]}).orders.filter(order=>order.request.reduceOnly&&order.result===undefined)).length===2));
  assert.deepEqual(f.reads.sort(),['account:bybit','account:gate','open:bybit','open:gate']);assert.equal(f.store.data.killSwitch,false);
});

test('a confirmed partial/zero IOC pair immediately reduces only the actual unmatched remainder even after economics fall',async t=>{
  const f=fixture();t.after(()=>f.close());let gateCalls=0,bybitCalls=0;
  f.adapters.get('gate')!.placeOrder=async(request,permit)=>{assert.equal(permit?.(),true);gateCalls++;f.posts.push({exchange:'gate',request});return f.result(request,4);};
  f.adapters.get('bybit')!.placeOrder=async(request,permit)=>{assert.equal(permit?.(),true);bybitCalls++;f.posts.push({exchange:'bybit',request});return f.result(request,bybitCalls===1?0:request.quantity);};
  await f.start(()=>f.p.long.quantity===10);
  assert.equal(gateCalls,1);assert.equal(bybitCalls,2);assert.deepEqual(f.posts.map(post=>post.request.quantity),[10,10,4]);
  assert.equal(f.p.long.quantity,6);assert.equal(f.p.short.quantity,6);assert.equal(f.execution.hasPendingIocProfitTail(f.p),false);
  assert.equal(f.store.data.orders.at(-1)!.executionEvidence!.role,'exit-tail');assert.equal(f.store.data.killSwitch,false);
});

test('a new IOC unknown preserves its original ID and forbids followup, compensation, or another pair',async t=>{
  const f=fixture();t.after(()=>f.close());
  f.adapters.get('bybit')!.placeOrder=async(request,permit)=>{assert.equal(permit?.(),true);f.posts.push({exchange:'bybit',request});return unknownOrder(request,'native-unknown-current');};
  await f.start();assert.equal(f.posts.length,2);assert.equal(f.p.status,'attention');assert.equal(f.p.long.quantity,0);assert.equal(f.p.short.quantity,10);
  assert.equal(f.execution.dispatchIocProfitClose(f.p,'must not replay',()=>true),false);assert.equal(f.execution.hasPendingIocProfitTail(f.p),false);
  const unknown=f.store.data.orders.find(order=>order.result?.id==='native-unknown-current')!;assert.equal(unknown.result!.status,'unknown');
  assert.equal(f.posts.filter(post=>post.request.clientOrderId===unknown.request.clientOrderId).length,1);
});

for(const veto of ['quantity','open-order','permission','config'] as const)test(`IOC paired close retains the ${veto} guard before any native POST`,async t=>{
  const f=fixture();t.after(()=>f.close());
  if(veto==='quantity')f.adapters.get('gate')!.fetchAccount=async()=>({freeUsd:100,equityUsd:100,positions:[{base:f.p.base,symbol:f.p.long.symbol,side:'long',quantity:9,
    entryPrice:1,markPrice:1,liquidationPrice:0,leverage:2,marginMode:'crossed'}]});
  if(veto==='open-order')f.adapters.get('gate')!.fetchOpenOrders=async()=>[{id:'external-resting',base:f.p.base,symbol:f.p.long.symbol,side:'sell',quantity:1,remainingQuantity:1,reduceOnly:true,kind:'regular'}];
  if(veto==='permission'||veto==='config')f.adapters.get('gate')!.validateOrder=async()=>{veto==='permission'?f.revoke():f.changeConfig();};
  await f.start();assert.equal(f.posts.length,0);assert.equal(f.p.long.quantity,10);assert.equal(f.p.short.quantity,10);
  assert.equal(f.store.data.orders.filter(order=>order.request.reduceOnly).length,0);assert.equal(f.store.data.killSwitch,false);
});

test('IOC intent persistence failure stops trading before either leg is sent',async t=>{
  const f=fixture();t.after(()=>f.close());f.failNextSave(2);await f.start();assert.equal(f.posts.length,0);assert.equal(f.store.data.killSwitch,true);
  assert.equal(f.p.long.quantity,10);assert.equal(f.p.short.quantity,10);
});

test('the first close-intent save failure is financial failure even before pair journals exist',async t=>{
  const f=fixture();t.after(()=>f.close());f.failNextSave();await f.start();assert.equal(f.posts.length,0);assert.equal(f.store.data.killSwitch,true);
  assert.equal(f.execution.dispatchIocProfitClose(f.p,'must stop',()=>true),false);
});

test('IOC cash persistence failure retains real fills and prevents any next batch or peer replay',async t=>{
  const f=fixture();t.after(()=>f.close());f.failNextSave(5);await f.start();assert.equal(f.store.data.killSwitch,true);
  assert.ok(f.posts.length<=2);assert.equal(f.execution.dispatchIocProfitClose(f.p,'must stop',()=>true),false);
  assert.ok(f.store.data.orders.filter(order=>order.request.reduceOnly).every(order=>order.request.clientOrderId));
});

test('profit execution mode keeps old undefined configuration Maker-only and IOC does not require Maker capabilities',async t=>{
  const f=fixture();t.after(()=>f.close());assert.equal(f.execution.requiresMakerProfitClose(f.p),false);assert.equal(f.execution.canUseMakerClose(f.p),false);
  delete f.store.data.config.profitExitExecutionMode;assert.equal(f.execution.requiresMakerProfitClose(f.p),true);
  f.store.data.config.profitExitExecutionMode='ioc';await f.start();assert.equal(f.p.status,'closed');
});

function addNativeAudit(f:ReturnType<typeof fixture>){
  const {p,store}=f,now=Date.now(),parentId=`offline-old-maker-${p.base}`,oldId=`offline-old-unknown-${p.base}`;
  const parent:JournalOrder={positionId:p.id,exchange:'gate',createdAt:now-10000,
    request:{clientOrderId:parentId,base:p.base,symbol:p.long.symbol,side:'sell',quantity:1,limitPrice:1.02,reduceOnly:true,postOnly:true},
    result:{id:`native-${parentId}`,clientOrderId:parentId,status:'filled',filledQuantity:1,averagePrice:1.02,averagePriceVerified:true,feeUsd:.000204,timestamp:now-9000},
    makerReduction:{activity:'terminal',makerLeg:'long',quantityStep:1,peerQuantityStep:1,deadlineAt:now-8000,bookedExecution:true,lastObservedAt:now-9000},
    executionEvidence:{version:1,method:'maker',role:'exit',batchId:parentId,bookedFeeUsd:.000204}};
  const oldRequest:OrderRequest={clientOrderId:oldId,base:p.base,symbol:p.short.symbol,side:'buy',quantity:1,limitPrice:1.01,reduceOnly:true};
  const oldUnknown:JournalOrder={positionId:p.id,exchange:'bybit',createdAt:now-7000,request:oldRequest,result:unknownOrder(oldRequest),
    executionEvidence:{version:1,method:'ioc',role:'exit-tail',batchId:parentId,makerCloseParentClientId:parentId,nativeTakerFeeRate:.0005}};
  const knownId=`offline-known-peer-${p.base}`;
  const known:JournalOrder={positionId:p.id,exchange:'bybit',createdAt:now-8500,
    request:{clientOrderId:knownId,base:p.base,symbol:p.short.symbol,side:'buy',quantity:1,limitPrice:1.01,reduceOnly:true},
    result:{id:`native-${knownId}`,clientOrderId:knownId,status:'filled',filledQuantity:1,averagePrice:1.01,averagePriceVerified:true,feeUsd:.000505,timestamp:now-8400},
    executionEvidence:{version:1,method:'ioc',role:'exit-tail',batchId:parentId,makerCloseParentClientId:parentId,bookedFeeUsd:.000505}};
  for(const opening of store.data.orders){opening.request.quantity=11;opening.result!.filledQuantity=11;}
  p.profitExitNotionalUsd=11;p.long.feesUsd+=.000204;p.short.feesUsd+=.000505;p.feesUsd+=.000709;
  p.realizedSpreadPnlUsd=.01;p.long.realizedPnlUsd=.02;p.short.realizedPnlUsd=-.01;
  store.data.orders.push(parent,known,oldUnknown);
  const evidence=[p.long,p.short].map(leg=>({exchange:leg.exchange,requestedAt:now,symbol:leg.symbol,side:leg.side,quantity:leg.quantity,
    entryPrice:1,marginMode:'crossed' as const,positionId:`slot-${leg.exchange}`,positionOpenedAt:p.openedAt}));
  const audit:NativeExitRecoveryAudit={version:1,id:`offline-regrant-${p.base}`,authorizedAt:now,parentClientOrderId:parentId,
    unknownClientOrderIds:[oldId],originalRemainingBudget:0,feeReserveUsd:.000505,lossReserveUsd:.01,
    originalUnknowns:[{clientOrderId:oldId,financialFingerprint:'offline-native-cash',originalResult:structuredClone(oldUnknown.result!)}],
    originalParentFingerprint:'offline-parent-cash',nativeReadEvidence:[...evidence,...structuredClone(evidence)],
    noOpenOrders:evidence.map(row=>({exchange:row.exchange,symbol:row.symbol,checkedAt:now}))};
  p.nativeExitRecoveryAudit=[audit];f.execution.installNativeExitAuthority(p,audit,()=>true);return {audit,parent,oldUnknown};
}

test('an explicitly restored native historical-unknown group submits its new IOC pair without treating its sibling intent as unknown',async t=>{
  const f=fixture('CVC');t.after(()=>f.close());const {oldUnknown}=addNativeAudit(f),original=structuredClone(oldUnknown);
  await f.start();assert.equal(f.posts.length,2);assert.equal(f.p.status,'closed');assert.equal(f.p.long.quantity,0);assert.equal(f.p.short.quantity,0);
  assert.deepEqual(oldUnknown,original);assert.equal(oldUnknown.result!.status,'unknown');assert.equal(f.execution.hasNativeExitAuthority(f.p),true);
  assert.ok(f.posts.every(post=>post.request.clientOrderId!==oldUnknown.request.clientOrderId));
});

test('native historical exemption never exempts a new IOC unknown from the tail freeze',async t=>{
  const f=fixture('LUMIA');t.after(()=>f.close());const {oldUnknown}=addNativeAudit(f),original=structuredClone(oldUnknown);
  f.adapters.get('bybit')!.placeOrder=async(request,permit)=>{assert.equal(permit?.(),true);f.posts.push({exchange:'bybit',request});return unknownOrder(request,'new-native-LUMIA-unknown');};
  await f.start();assert.equal(f.posts.length,2);assert.equal(f.p.status,'attention');assert.equal(f.execution.hasPendingIocProfitTail(f.p),false);
  assert.deepEqual(oldUnknown,original);assert.equal(f.execution.dispatchIocProfitClose(f.p,'no repeat',()=>true),false);
});

test('a late sibling POST permission accepts its own already-booked exact first-leg cash',async t=>{
  const f=fixture();t.after(()=>f.close());addNativeAudit(f);let siblingSawConfirmed=false;
  f.adapters.get('bybit')!.placeOrder=async(request,permit)=>{
    await new Promise<void>(resolve=>setImmediate(resolve));siblingSawConfirmed=f.p.long.quantity===0;
    assert.equal(siblingSawConfirmed,true);assert.equal(permit?.(),true);f.posts.push({exchange:'bybit',request});return f.result(request);
  };
  await f.start();assert.equal(siblingSawConfirmed,true);assert.equal(f.posts.length,2);assert.equal(f.p.status,'closed');
});

test('an external cash change during IOC adapter preparation vetoes new POST and preserves true earlier fill',async t=>{
  const f=fixture();t.after(()=>f.close());let siblingCalls=0;
  f.adapters.get('bybit')!.placeOrder=async(request,permit)=>{
    siblingCalls++;await new Promise<void>(resolve=>setImmediate(resolve));f.p.fundingUsd+=.001;
    assert.equal(permit?.(),false);return {id:'',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now(),rejectionCode:'ORDER_SUBMISSION_PERMISSION_CHANGED'};
  };
  await f.start();assert.equal(siblingCalls,1);assert.equal(f.posts.length,1);assert.equal(f.p.long.quantity,0);assert.equal(f.p.short.quantity,10);
  assert.equal(f.p.status,'attention');assert.equal(f.execution.hasPendingIocProfitTail(f.p),false);
});

test('book veto has a witnessed no-send receipt and retries only the first legs confirmed IOC tail',async t=>{
  const f=fixture();t.after(()=>f.close());let shortCalls=0;
  f.adapters.get('bybit')!.placeOrder=async(request,permit)=>{
    shortCalls++;if(shortCalls===1){f.books.get('bybit')!.asks[0].price=1.011;
      assert.equal(permit?.(),false);return {id:'',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now(),rejectionCode:'ORDER_SUBMISSION_PERMISSION_CHANGED'};}
    assert.equal(permit?.(),true);f.posts.push({exchange:'bybit',request});return f.result(request);
  };
  await f.start();assert.equal(shortCalls,2);assert.equal(f.posts.length,2);assert.equal(f.p.status,'closed');
  const veto=f.store.data.orders.find(order=>order.result?.rejectionCode==='IOC_REDUCTION_PERMISSION_CHANGED')!;
  assert.ok(veto);assert.equal(veto.result!.status,'cancelled');assert.equal(veto.result!.filledQuantity,0);assert.equal(veto.result!.id,'');
  assert.equal(f.store.data.orders.at(-1)!.request.quantity,10);assert.equal(f.store.data.orders.at(-1)!.request.limitPrice,1.011);
});

test('ordinary IOC full pair stops when the fresh native proof ages past eight seconds during adapter checks',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,9,11,14)});const f=fixture();t.after(()=>f.close());
  for(const adapter of f.adapters.values())adapter.placeOrder=async(request,permit)=>{
    t.mock.timers.setTime(Date.now()+8001);f.refresh();assert.equal(permit?.(),false);
    return {id:'',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now(),rejectionCode:'ORDER_SUBMISSION_PERMISSION_CHANGED'};
  };
  await f.start();assert.equal(f.posts.length,0);assert.equal(f.p.long.quantity,10);assert.equal(f.p.short.quantity,10);assert.equal(f.store.data.killSwitch,false);
  assert.ok(f.store.data.orders.filter(order=>order.request.reduceOnly).every(order=>order.result!.status==='cancelled'));
});

test('final first-POST economics check prevents a fee increase from executing a previously profitable pair',async t=>{
  const f=fixture();t.after(()=>f.close());
  for(const adapter of f.adapters.values())adapter.placeOrder=async(request,permit)=>{
    for(const book of f.books.values())book.takerFeeRate=.01;
    assert.equal(permit?.(),false);return {id:'',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now(),rejectionCode:'ORDER_SUBMISSION_PERMISSION_CHANGED'};
  };
  await f.start();assert.equal(f.posts.length,0);assert.equal(f.p.long.quantity,10);assert.equal(f.p.short.quantity,10);assert.equal(f.store.data.killSwitch,false);
});

test('a terminal-zero IOC tail stays scoped across rounds and resumes without requiring a new profit signal',async t=>{
  const f=fixture();t.after(()=>f.close());let allowFill=false;
  f.adapters.get('bybit')!.placeOrder=async(request,permit)=>{
    assert.equal(permit?.(),true);f.posts.push({exchange:'bybit',request});return f.result(request,allowFill?request.quantity:0);
  };
  await f.start();assert.equal(f.p.long.quantity,0);assert.equal(f.p.short.quantity,10);
  assert.equal(f.execution.hasPendingIocProfitTail(f.p),true);assert.equal(f.p.status,'closing');const old=f.posts.length;
  allowFill=true;f.books.get('bybit')!.asks[0].price=1.02;
  assert.equal(f.execution.dispatchIocProfitClose(f.p,'confirmed IOC tail',undefined),true);await f.execution.waitIocProfitClose(f.p);
  assert.equal(f.posts.length,old+1);assert.equal(f.posts.at(-1)!.exchange,'bybit');assert.equal(f.posts.at(-1)!.request.quantity,10);
  assert.equal(f.p.status,'closed');assert.equal(f.execution.hasPendingIocProfitTail(f.p),false);
});

test('a real partial fill below the counterpart minimum is retained as dust and never rounded up into a larger tail order',async t=>{
  const f=fixture();t.after(()=>f.close());
  f.adapters.get('gate')!.placeOrder=async(request,permit)=>{assert.equal(permit?.(),true);f.posts.push({exchange:'gate',request});return f.result(request,.5);};
  f.adapters.get('bybit')!.placeOrder=async(request,permit)=>{assert.equal(permit?.(),true);f.posts.push({exchange:'bybit',request});return f.result(request,0);};
  await f.start();assert.equal(f.posts.length,2);assert.equal(f.p.long.quantity,9.5);assert.equal(f.p.short.quantity,10);
  assert.equal(f.execution.hasPendingIocProfitTail(f.p),true);assert.equal(f.p.status,'closing');
  assert.equal(f.execution.dispatchIocProfitClose(f.p,'only dust',undefined),true);await f.execution.waitIocProfitClose(f.p);
  assert.equal(f.posts.length,2);assert.equal(f.p.long.quantity,9.5);assert.equal(f.p.short.quantity,10);
});

test('new paired IOC receipts are booked once even when the same terminal observation arrives again',async t=>{
  const f=fixture();t.after(()=>f.close());await f.start();const before=structuredClone(f.p);
  for(const journal of f.store.data.orders.filter(order=>order.request.reduceOnly))assert.equal(f.execution.applyObservedOrder(journal,structuredClone(journal.result!)),false);
  assert.deepEqual(f.p,before);assert.equal(f.posts.length,2);
});

for(const unknownFirst of [true,false])test(`parallel IOC unknown plus a cash-save failure always stops all trading (unknown first: ${unknownFirst})`,async t=>{
  const f=fixture();t.after(()=>f.close());const originalSave=f.store.save.bind(f.store);let faulted=false;
  f.store.save=()=>{
    const receipts=f.store.data.orders.filter(order=>order.request.reduceOnly&&order.result);
    if(!faulted&&receipts.some(order=>order.result!.filledQuantity>0)){faulted=true;throw new Error('offline cash-save failure');}
    originalSave();
  };
  const unknownExchange=unknownFirst?'gate':'bybit',filledExchange=unknownFirst?'bybit':'gate';
  f.adapters.get(unknownExchange)!.placeOrder=async(request,permit)=>{
    assert.equal(permit?.(),true);f.posts.push({exchange:unknownExchange,request});
    if(!unknownFirst)await new Promise<void>(resolve=>setImmediate(resolve));return unknownOrder(request,`native-${unknownExchange}-unknown`);
  };
  f.adapters.get(filledExchange)!.placeOrder=async(request,permit)=>{
    assert.equal(permit?.(),true);f.posts.push({exchange:filledExchange,request});
    if(unknownFirst)await new Promise<void>(resolve=>setImmediate(resolve));return f.result(request);
  };
  await f.start();assert.equal(faulted,true);assert.equal(f.store.data.killSwitch,true);assert.equal(f.posts.length,2);
  assert.equal(f.execution.dispatchIocProfitClose(f.p,'must stop',()=>true),false);
});

test('explicit funding-loss qualification preserves the original separate callback instead of imposing the profit ten-bps threshold',async t=>{
  const f=fixture();t.after(()=>f.close());f.books.get('gate')!.bids[0].price=1;
  assert.equal(f.execution.dispatchIocProfitClose(f.p,'confirmed funding disadvantage',()=>true,'funding-loss'),true);
  await f.execution.waitIocProfitClose(f.p);assert.equal(f.p.status,'closed');assert.equal(f.posts.length,2);
});

test('explicit funding-loss still requires fresh actual fees and its callback at the native boundary',async t=>{
  const f=fixture();t.after(()=>f.close());f.books.get('gate')!.bids[0].price=1;
  let qualify=true;
  for(const adapter of f.adapters.values())adapter.placeOrder=async(request,permit)=>{
    qualify=false;assert.equal(permit?.(),false);return {id:'',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now(),rejectionCode:'ORDER_SUBMISSION_PERMISSION_CHANGED'};
  };
  assert.equal(f.execution.dispatchIocProfitClose(f.p,'confirmed loss',()=>qualify,'funding-loss'),true);await f.execution.waitIocProfitClose(f.p);
  assert.equal(f.posts.length,0);assert.equal(f.p.long.quantity,10);assert.equal(f.p.short.quantity,10);
});

test('replacing a leg with equal-looking fields cannot authorize an IOC create against an orphaned position object',async t=>{
  const f=fixture();t.after(()=>f.close());
  for(const adapter of f.adapters.values())adapter.placeOrder=async(request,permit)=>{
    f.p.long={...f.p.long};assert.equal(permit?.(),false);
    return {id:'',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now(),rejectionCode:'ORDER_SUBMISSION_PERMISSION_CHANGED'};
  };
  await f.start();assert.equal(f.posts.length,0);assert.equal(f.p.long.quantity,10);assert.equal(f.p.short.quantity,10);
});

test('an adapter code without this operations local veto witness cannot prove a new IOC order was never sent',async t=>{
  const f=fixture();t.after(()=>f.close());
  f.adapters.get('bybit')!.placeOrder=async(request,permit)=>{
    assert.equal(permit?.(),true);f.posts.push({exchange:'bybit',request});
    return {id:'',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now(),rejectionCode:'IOC_REDUCTION_PERMISSION_CHANGED'};
  };
  await f.start();assert.equal(f.posts.length,2);assert.equal(f.p.status,'attention');assert.equal(f.execution.hasPendingIocProfitTail(f.p),false);
  assert.equal(f.store.data.orders.at(-1)!.result!.status,'unknown');
});

test('a leg replacement after a real native POST keeps its receipt without booking cash into an orphaned leg',async t=>{
  const f=fixture();t.after(()=>f.close());let release:()=>void=()=>{};
  const pending=new Promise<void>(resolve=>{release=resolve;});
  f.adapters.get('gate')!.placeOrder=async(request,permit)=>{
    assert.equal(permit?.(),true);f.posts.push({exchange:'gate',request});await pending;return f.result(request);
  };
  f.adapters.get('bybit')!.placeOrder=async(request,permit)=>{
    assert.equal(permit?.(),true);f.posts.push({exchange:'bybit',request});f.p.long={...f.p.long};release();return f.result(request);
  };
  await f.start();assert.equal(f.posts.length,2);assert.equal(f.store.data.killSwitch,true);assert.equal(f.p.status,'attention');
  assert.equal(f.p.long.quantity,10);assert.equal(f.p.short.quantity,10);assert.equal(f.p.feesUsd,.002);
  const cash=f.store.data.orders.filter(order=>order.request.reduceOnly);
  assert.equal(cash.length,2);assert.ok(cash.every(order=>order.result!.filledQuantity===10&&order.executionEvidence!.bookedFeeUsd===0&&order.error));
});

for(const stage of ['book-refresh','local-plan','native-validation','native-proof'] as const)test(`a pure ${stage} failure before any IOC intent waits locally and can recover without a financial kill`,async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,9,11,14)});
  const f=fixture();t.after(()=>f.close());let failing=true;
  const error=()=>{if(failing)throw new Error('offline pre-intent failure https://private.invalid?api_key=FAKE_ONLY');};
  if(stage==='book-refresh')f.execution.context.refreshSnapshots=async()=>{error();f.refresh();};
  if(stage==='local-plan')f.execution.context.prepareReduction=(_leg,quantity)=>{error();return {quantity};};
  if(stage==='native-validation')for(const adapter of f.adapters.values())adapter.validateOrder=async()=>error();
  if(stage==='native-proof'){
    const adapter=f.adapters.get('gate')!,original=adapter.fetchAccount.bind(adapter);
    adapter.fetchAccount=async()=>{error();return original();};
  }
  await f.start();assert.equal(f.store.data.killSwitch,false);assert.equal(f.posts.length,0);
  assert.equal(f.store.data.orders.filter(order=>order.request.reduceOnly).length,0);assert.equal(f.p.status,'open');
  assert.ok(f.logs.every(log=>!log.includes('FAKE_ONLY')&&!log.includes('private.invalid')));
  assert.equal(f.execution.dispatchIocProfitClose(f.p,'no busy retry',()=>true),false);
  failing=false;t.mock.timers.setTime(f.execution.iocProfitCloseRetryAfter(f.p)+1);f.refresh();await f.start();
  assert.equal(f.posts.length,2);assert.equal(f.p.status,'closed');assert.equal(f.store.data.killSwitch,false);
});

test('saving a pure preflight wait can still fail financially and must stop trading',async t=>{
  const f=fixture();t.after(()=>f.close());f.execution.context.refreshSnapshots=async()=>{throw new Error('offline quote read failed');};
  f.failNextSave();await f.start();assert.equal(f.store.data.killSwitch,true);assert.equal(f.posts.length,0);
  assert.equal(f.p.status,'attention');assert.ok(f.p.riskReasons.some(reason=>reason.includes('准备等待状态保存')));
});

for(const stage of ['book-refresh','local-plan','native-validation','native-proof'] as const)test(`a filesystem write fault in ${stage} remains a financial failure before any IOC intent`,async t=>{
  const f=fixture();t.after(()=>f.close());
  const error=()=>{throw Object.assign(new Error('offline disk write failure'),{syscall:'write',code:'EIO'});};
  if(stage==='book-refresh')f.execution.context.refreshSnapshots=async()=>error();
  if(stage==='local-plan')f.execution.context.prepareReduction=()=>error();
  if(stage==='native-validation')for(const adapter of f.adapters.values())adapter.validateOrder=async()=>error();
  if(stage==='native-proof')f.adapters.get('gate')!.fetchAccount=async()=>error();
  await f.start();assert.equal(f.store.data.killSwitch,true);assert.equal(f.posts.length,0);
  assert.equal(f.store.data.orders.filter(order=>order.request.reduceOnly).length,0);
  assert.equal(f.p.long.quantity,10);assert.equal(f.p.short.quantity,10);assert.equal(f.p.feesUsd,.002);
  assert.equal(f.p.status,'attention');assert.equal(f.execution.iocProfitCloseRetryAfter(f.p),0);
  assert.equal(f.execution.dispatchIocProfitClose(f.p,'must remain halted',()=>true),false);
});

test('a confirmed IOC tail survives a read-only quote outage and resumes its exact compensation after a bounded wait',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,9,11,14)});
  const f=fixture();t.after(()=>f.close());let allowFill=false,readFails=false;
  f.execution.context.refreshSnapshots=async()=>{if(readFails)throw new Error('offline tail quote outage');f.refresh();};
  f.adapters.get('bybit')!.placeOrder=async(request,permit)=>{
    assert.equal(permit?.(),true);f.posts.push({exchange:'bybit',request});return f.result(request,allowFill?request.quantity:0);
  };
  await f.start();assert.equal(f.execution.hasPendingIocProfitTail(f.p),true);
  const beforeOrders=f.store.data.orders.length,beforePosts=f.posts.length;
  readFails=true;assert.equal(f.execution.dispatchIocProfitClose(f.p,'confirmed IOC tail',undefined),true);
  await f.execution.waitIocProfitClose(f.p);
  assert.equal(f.store.data.killSwitch,false);assert.equal(f.execution.hasPendingIocProfitTail(f.p),true);
  assert.equal(f.store.data.orders.length,beforeOrders);assert.equal(f.posts.length,beforePosts);
  assert.equal(f.p.long.quantity,0);assert.equal(f.p.short.quantity,10);
  assert.equal(f.execution.iocProfitCloseRetryAfter(f.p)-Date.now(),500);
  assert.equal(f.execution.dispatchIocProfitClose(f.p,'avoid read retry loop',undefined),false);
  allowFill=true;readFails=false;f.books.get('bybit')!.asks[0].price=1.04;
  t.mock.timers.setTime(f.execution.iocProfitCloseRetryAfter(f.p)+1);
  assert.equal(f.execution.dispatchIocProfitClose(f.p,'confirmed IOC tail after read recovery',undefined),true);
  await f.execution.waitIocProfitClose(f.p);
  assert.equal(f.posts.length,beforePosts+1);assert.equal(f.posts.at(-1)!.exchange,'bybit');
  assert.equal(f.posts.at(-1)!.request.quantity,10);assert.equal(f.p.status,'closed');
  assert.equal(f.execution.hasPendingIocProfitTail(f.p),false);assert.equal(f.store.data.killSwitch,false);
});

for(const failure of ['account','open'] as const)for(const slow of ['same-venue','other-venue'] as const)
test(`IOC ${failure} proof failure retains ${slow} native GET ownership until the original settles`,async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,9,12,15,30)});
  const f=fixture(`OWNED-${failure}-${slow}`),before=structuredClone(f.store.data.orders);
  let release!:()=>void,entered!:()=>void,active=0,calls=0;
  const pending=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
  const failed=f.adapters.get('gate')!,blocked=f.adapters.get(slow==='same-venue'?'gate':'bybit')!;
  const wait=async<T>(read:()=>Promise<T>)=>{calls++;active++;entered();await pending;active--;return read();};
  if(failure==='account'){
    const original=blocked.fetchOpenOrders!.bind(blocked);blocked.fetchOpenOrders=async symbol=>wait(()=>original(symbol));
    failed.fetchAccount=async()=>{throw Object.assign(new Error('offline proof connection failure'),{code:'ETIMEDOUT',syscall:'connect'});};
  }else{
    const original=blocked.fetchAccount.bind(blocked);blocked.fetchAccount=async()=>wait(original);
    failed.fetchOpenOrders=async()=>{throw Object.assign(new Error('offline proof connection failure'),{code:'ETIMEDOUT',syscall:'connect'});};
  }
  let finished=false;const originalWorker=f.start().then(()=>{finished=true;});
  t.after(async()=>{release();await originalWorker;await f.close();});
  await started;for(let i=0;i<12;i++)await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(active,1);assert.equal(finished,false);assert.equal(f.execution.hasIocProfitClose(f.p),true);
  assert.equal(await f.serial(async()=> 'financial queue available'),'financial queue available');
  t.mock.timers.setTime(Date.now()+1601);f.refresh();
  assert.equal(f.execution.dispatchIocProfitClose(f.p,'same coin must retain its original read',()=>true),false);
  assert.equal(calls,1);assert.equal(f.posts.length,0);assert.deepEqual(f.store.data.orders,before);
  release();await originalWorker;assert.equal(active,0);assert.equal(f.execution.hasIocProfitClose(f.p),false);
  assert.equal(f.store.data.killSwitch,false);assert.equal(f.p.long.quantity,10);assert.equal(f.p.short.quantity,10);
});

for(const slow of ['account','open'] as const)
test(`IOC eight second proof cutoff retains the real ${slow} GET and refuses its late result`,async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.UTC(2026,9,12,15,30)});
  const f=fixture(`CUTOFF-${slow}`),before=structuredClone(f.store.data.orders),adapter=f.adapters.get('bybit')!;
  let release!:()=>void,entered!:()=>void,active=0,calls=0,finished=false;
  const pending=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
  const wait=async<T>(read:()=>Promise<T>)=>{calls++;active++;entered();await pending;active--;return read();};
  if(slow==='account'){const original=adapter.fetchAccount.bind(adapter);adapter.fetchAccount=async()=>wait(original);}
  else{const original=adapter.fetchOpenOrders!.bind(adapter);adapter.fetchOpenOrders=async symbol=>wait(()=>original(symbol));}
  const originalWorker=f.start().then(()=>{finished=true;});
  t.after(async()=>{release();await originalWorker;await f.close();});
  await started;t.mock.timers.tick(8001);for(let i=0;i<12;i++)await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(active,1);assert.equal(finished,false);assert.equal(f.execution.hasIocProfitClose(f.p),true);
  assert.equal(f.execution.dispatchIocProfitClose(f.p,'cutoff cannot free a real pending GET',()=>true),false);
  assert.equal(await f.serial(async()=> 'financial queue available'),'financial queue available');
  assert.equal(calls,1);assert.equal(f.posts.length,0);assert.deepEqual(f.store.data.orders,before);
  release();await originalWorker;assert.equal(active,0);assert.equal(finished,true);
  assert.equal(f.posts.length,0);assert.deepEqual(f.store.data.orders,before);assert.equal(f.store.data.killSwitch,false);
  assert.ok(f.execution.iocProfitCloseRetryAfter(f.p)>Date.now());
  t.mock.timers.setTime(f.execution.iocProfitCloseRetryAfter(f.p)+1);f.refresh();await f.start();
  assert.equal(f.p.status,'closed');assert.equal(f.posts.length,2);assert.equal(calls,2);
});

test('IOC proof shares its original eight second deadline across every selected account and open-order GET',async t=>{
  const now=Date.UTC(2026,9,12,15,30);t.mock.timers.enable({apis:['Date'],now});
  const f=fixture('ONE-NATIVE-DEADLINE'),contexts:Array<{deadlineAt?:number}|undefined>=[];
  t.after(()=>f.close());
  for(const adapter of f.adapters.values()){
    const account=adapter.fetchAccount.bind(adapter),open=adapter.fetchOpenOrders!.bind(adapter);
    adapter.fetchAccount=async context=>{contexts.push(context);return account(context);};
    adapter.fetchOpenOrders=async(symbol,context)=>{contexts.push(context);return open(symbol,context);};
  }
  await f.start();assert.equal(f.p.status,'closed');assert.equal(contexts.length,4);
  assert.ok(contexts.every(context=>context===contexts[0]));assert.equal(contexts[0]?.deadlineAt,now+8000);
  assert.equal(f.posts.length,2);assert.equal(f.store.data.killSwitch,false);
});

test('IOC cutoff drain preserves a late filesystem failure as a financial stop',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.UTC(2026,9,12,15,30)});
  const f=fixture('LATE-DISK-PROOF'),before=structuredClone(f.store.data.orders);
  let release!:()=>void,entered!:()=>void;
  const pending=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
  f.adapters.get('gate')!.fetchAccount=async()=>{entered();await pending;throw Object.assign(new Error('offline late write failure'),{code:'EIO',syscall:'write'});};
  const worker=f.start();t.after(async()=>{release();await worker;await f.close();});
  await started;t.mock.timers.tick(8001);for(let i=0;i<12;i++)await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(f.execution.hasIocProfitClose(f.p),true);assert.equal(f.store.data.killSwitch,false);
  release();await worker;assert.equal(f.store.data.killSwitch,true);assert.equal(f.p.status,'attention');
  assert.equal(f.posts.length,0);assert.deepEqual(f.store.data.orders,before);
  assert.equal(f.p.long.quantity,10);assert.equal(f.p.short.quantity,10);
});

test('one coin retains its pending native proof while another coin on the same venues closes',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,9,12,15,30)});
  const f=fixture('SLOW-PROOF'),other=fixture('READY-PROOF'),p=other.p;
  f.store.data.positions.push(p);f.store.data.orders.push(...other.store.data.orders);
  f.execution.context.snapshot=(exchange,base)=>base===p.base?other.books.get(exchange as ExchangeId):f.books.get(exchange as ExchangeId);
  f.execution.context.refreshSnapshots=async()=>{f.refresh();other.refresh();};
  let release!:()=>void,entered!:()=>void,gateCalls=0;
  const pending=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
  for(const [exchange,adapter] of f.adapters)adapter.fetchAccount=async()=>{
    if(exchange==='gate'&&++gateCalls===1){entered();await pending;}
    return {freeUsd:100,equityUsd:100,positions:[f.p,p].map(position=>{
      const leg=exchange==='gate'?position.long:position.short;
      return {base:position.base,symbol:leg.symbol,side:leg.side,quantity:leg.quantity,entryPrice:1,markPrice:1,liquidationPrice:0,
        leverage:2,marginMode:'crossed' as const,positionId:`slot-${exchange}-${position.base}`,positionOpenedAt:position.openedAt};
    }).filter(position=>position.quantity>0)};
  };
  const first=f.start();t.after(async()=>{release();await first;await f.close();await other.close();});await started;
  assert.equal(f.execution.dispatchIocProfitClose(p,'another coin is independently ready',()=>true),true);
  await f.execution.waitIocProfitClose(p);
  assert.equal(p.status,'closed');assert.equal(f.execution.hasIocProfitClose(f.p),true);
  assert.equal(f.p.long.quantity,10);assert.equal(f.p.short.quantity,10);
  assert.equal(f.posts.length,2);assert.ok(f.posts.every(post=>post.request.base===p.base));
  release();await first;assert.equal(f.p.status,'closed');assert.equal(f.posts.length,4);
  assert.equal(f.store.data.killSwitch,false);
});

function focusedTailFixture(excess:'gate'|'bybit'='bybit',options:{ownBookFails?:boolean;unknown?:boolean;invalidateCash?:boolean}={}){
  const f=fixture(`FOCUSED-TAIL-${excess}`),peer=excess==='gate'?'bybit':'gate',scopes:string[][]=[];
  let first=true,peerUnavailable=false;
  f.books.get('gate')!.bids[0].quantity=2;
  const adapter=f.adapters.get(excess)!;
  adapter.placeOrder=async(request,permit)=>{
    assert.equal(permit?.(),true);f.posts.push({exchange:excess,request});
    if(first){first=false;peerUnavailable=true;return f.result(request,0,options.unknown?'unknown':'cancelled');}
    return f.result(request);
  };
  f.execution.context.refreshSnapshots=async(_base,exchanges)=>{
    scopes.push([...exchanges]);
    const unmatched=f.p.long.quantity!==f.p.short.quantity;
    if(peerUnavailable){
      const book=f.books.get(peer)!;book.bookTransport='websocket';book.observedAt=Date.now()-2001;
      if(exchanges.includes(peer))throw new Error('offline matched-peer public book is unavailable');
      if(unmatched&&options.ownBookFails)throw new Error('offline actual excess-leg public book is unavailable');
    }
    for(const exchange of exchanges)Object.assign(f.books.get(exchange as ExchangeId)!,
      {timestamp:Date.now(),observedAt:Date.now(),fundingObservedAt:Date.now(),takerFeeAt:Date.now()});
    if(unmatched&&options.invalidateCash){f.p.feesUsd+=.001;f.p.long.feesUsd+=.001;}
  };
  return {...f,excess,peer,scopes};
}

for(const excess of ['gate','bybit'] as const)
test(`confirmed ${excess} IOC tail refreshes only its excess leg while retaining both native account and order proofs`,async t=>{
  const f=focusedTailFixture(excess);t.after(()=>f.close());await f.start();
  assert.deepEqual(f.scopes,[['gate','bybit'],[excess],['gate','bybit']]);
  assert.deepEqual([f.p.long.quantity,f.p.short.quantity],[8,8]);assert.equal(f.posts.length,3);
  const tail=f.store.data.orders.find(order=>order.executionEvidence?.role==='exit-tail')!;
  assert.equal(tail.exchange,excess);assert.equal(tail.request.quantity,2);assert.equal(tail.result!.filledQuantity,2);
  assert.equal(tail.executionEvidence!.bookedFeeUsd,tail.result!.feeUsd);assert.equal(tail.request.reduceOnly,true);
  assert.equal(tail.request.postOnly,undefined);assert.equal(f.p.profitExitNotionalUsd,10);
  assert.equal(f.execution.hasPendingIocProfitTail(f.p),false);assert.equal(f.store.data.killSwitch,false);
  for(const read of ['account:gate','account:bybit','open:gate','open:bybit'])assert.equal(f.reads.filter(value=>value===read).length,2);
  assert.equal(f.p.status,'closing','the following shared batch still waits for both books');
});

test('confirmed IOC tail keeps its exact remaining budget when its own selected public book fails',async t=>{
  const f=focusedTailFixture('bybit',{ownBookFails:true});t.after(()=>f.close());await f.start();
  assert.deepEqual(f.scopes,[['gate','bybit'],['bybit']]);assert.equal(f.posts.length,2);
  assert.deepEqual([f.p.long.quantity,f.p.short.quantity],[8,10]);assert.equal(f.execution.hasPendingIocProfitTail(f.p),true);
  assert.equal(f.store.data.orders.filter(order=>order.executionEvidence?.role==='exit-tail').length,0);
  assert.equal(f.reads.length,4,'a failed tail quote cannot issue a new native proof');assert.equal(f.store.data.killSwitch,false);
});

test('an unknown original IOC cannot create a focused tail or treat the unmatched quantity as confirmed budget',async t=>{
  const f=focusedTailFixture('bybit',{unknown:true});t.after(()=>f.close());await f.start();
  assert.deepEqual(f.scopes,[['gate','bybit']]);assert.equal(f.posts.length,2);
  assert.deepEqual([f.p.long.quantity,f.p.short.quantity],[8,10]);assert.equal(f.execution.hasPendingIocProfitTail(f.p),false);
  assert.equal(f.p.status,'attention');assert.equal(f.store.data.orders.at(-1)!.result!.status,'unknown');
  assert.equal(f.store.data.orders.filter(order=>order.executionEvidence?.role==='exit-tail').length,0);
});

test('a focused tail refresh cannot rebind changed booked cash or promote its read into a new shared batch',async t=>{
  const f=focusedTailFixture('bybit',{invalidateCash:true});t.after(()=>f.close());await f.start();
  assert.deepEqual(f.scopes,[['gate','bybit'],['bybit']]);assert.equal(f.posts.length,2);
  assert.deepEqual([f.p.long.quantity,f.p.short.quantity],[8,10]);assert.equal(f.execution.hasPendingIocProfitTail(f.p),false);
  assert.equal(f.store.data.orders.filter(order=>order.executionEvidence?.role==='exit-tail').length,0);
  assert.equal(f.reads.length,4);assert.equal(f.store.data.killSwitch,false);
});
