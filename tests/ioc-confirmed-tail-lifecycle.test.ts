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


async function deferredTail(f:ReturnType<typeof fixture>){
  let fill=false;
  f.adapters.get('bybit')!.placeOrder=async(request,permit)=>{
    assert.equal(permit?.(),true);f.posts.push({exchange:'bybit',request});return f.result(request,fill?request.quantity:0);
  };
  await f.start();assert.equal(f.p.long.quantity,0);assert.equal(f.p.short.quantity,10);
  assert.equal(f.execution.hasPendingIocProfitTail(f.p),true);
  return ()=>{fill=true;};
}

for(const observation of ['funding','confirmed-order-timing','historical-unknown-timing','journal-timing'] as const)
test(`confirmed IOC tail survives an independent ${observation} observation and reduces only its unchanged fill budget`,async t=>{
  const f=fixture('LUMIA');t.after(()=>f.close());const {oldUnknown}=addNativeAudit(f),fill=await deferredTail(f);
  const oldOrders=f.store.data.orders.length,oldPosts=f.posts.length,oldFees=f.p.feesUsd;
  if(observation==='funding'){f.p.fundingUsd+=.001;f.p.long.fundingUsd=.001;f.p.fundingEvents.push('offline-new-native-bill');}
  if(observation==='confirmed-order-timing')f.store.data.orders.find(order=>order.request.reduceOnly&&order.result?.filledQuantity===10)!.result!.orderReadAt=Date.now()+1;
  if(observation==='historical-unknown-timing')oldUnknown.result!.orderReadAt=Date.now()+1;
  if(observation==='journal-timing')f.store.data.orders.at(-1)!.execution!.confirmationMs=(f.store.data.orders.at(-1)!.execution!.confirmationMs??0)+1;
  const original=structuredClone(oldUnknown);fill();f.books.get('bybit')!.asks[0].price=1.015;
  assert.equal(f.execution.hasPendingIocProfitTail(f.p),true);assert.equal(f.execution.hasNativeExitAuthority(f.p),true);
  assert.equal(f.execution.dispatchIocProfitClose(f.p,'confirmed budget after observation'),true);await f.execution.waitIocProfitClose(f.p);
  assert.equal(f.posts.length,oldPosts+1);assert.equal(f.store.data.orders.length,oldOrders+1);
  assert.equal(f.posts.at(-1)!.exchange,'bybit');assert.equal(f.posts.at(-1)!.request.quantity,10);
  assert.equal(f.p.status,'closed');assert.equal(f.p.long.quantity,0);assert.equal(f.p.short.quantity,0);
  assert.equal(f.p.feesUsd,oldFees+10*1.015*.0005);assert.deepEqual(oldUnknown,original);
  const cash=structuredClone(f.p);
  assert.equal(f.execution.applyObservedOrder(f.store.data.orders.at(-1)!,structuredClone(f.store.data.orders.at(-1)!.result!)),false);
  assert.deepEqual(f.p,cash);assert.equal(f.store.data.killSwitch,false);
});

for(const mutation of ['quantity','quantity-both','realized','fees','transfer','source-cash','source-request','source-rejection','source-identity',
  'leg-object','intent','policy','config','config-in-place','permission','kill-switch','manual','audit-revoked','new-unknown'] as const)
test(`confirmed IOC budget never grants a new POST after ${mutation} changes`,async t=>{
  const f=fixture();t.after(()=>f.close());const audit=mutation==='audit-revoked'?addNativeAudit(f).audit:undefined;await deferredTail(f);
  const posts=f.posts.length,source=f.store.data.orders.find(order=>order.request.reduceOnly&&order.result?.filledQuantity===10)!;
  if(mutation==='quantity')f.p.short.quantity=11;
  if(mutation==='quantity-both'){f.p.long.quantity=1;f.p.short.quantity=11;}
  if(mutation==='realized')f.p.realizedSpreadPnlUsd+=.001;
  if(mutation==='fees')f.p.feesUsd+=.001;
  if(mutation==='transfer')f.p.transferCostUsd+=.001;
  if(mutation==='source-cash'){source.result!.feeUsd+=.001;source.executionEvidence!.bookedFeeUsd=source.result!.feeUsd;}
  if(mutation==='source-request')source.request.quantity+=1;
  if(mutation==='source-rejection')f.store.data.orders.at(-1)!.result!.rejectionCode='EXCHANGE_HARD_REJECT';
  if(mutation==='source-identity')f.store.data.orders[f.store.data.orders.indexOf(source)]={...source};
  if(mutation==='leg-object')f.p.short={...f.p.short};
  if(mutation==='intent')f.p.closeRequestedAt!++;
  if(mutation==='policy')f.p.profitExitPolicy!.minCombinedNetUsd+=1;
  if(mutation==='config')f.changeConfig();
  if(mutation==='config-in-place')f.store.data.config.minExitProfitBps=(f.store.data.config.minExitProfitBps??10)+1;
  if(mutation==='permission')f.revoke();
  if(mutation==='kill-switch')f.store.data.killSwitch=true;
  if(mutation==='manual')f.p.manualCloseOnly=true;
  if(mutation==='audit-revoked')audit!.revokedAt=Date.now();
  if(mutation==='new-unknown')f.store.data.orders.push({...structuredClone(source),request:{...source.request,clientOrderId:'offline-unrelated-unknown'},
    result:unknownOrder({...source.request,clientOrderId:'offline-unrelated-unknown'})});
  assert.equal(f.execution.dispatchIocProfitClose(f.p,'changed scope cannot own budget'),false);
  assert.equal(f.posts.length,posts);
});

test('IOC drain revokes even an idle confirmed tail; a new process cannot inherit saved budget or intent',async t=>{
  const f=fixture();t.after(()=>f.close());const fill=await deferredTail(f),posts=f.posts.length;
  await f.execution.drainIocProfitCloses();fill();
  assert.equal(f.execution.hasPendingIocProfitTail(f.p),false);
  assert.equal(f.execution.dispatchIocProfitClose(f.p,'drained session budget'),false);
  const restarted=new Execution(f.store,f.execution.context);
  assert.equal(restarted.hasPendingIocProfitTail(f.p),false);
  assert.equal(restarted.dispatchIocProfitClose(f.p,'saved original intent'),false);
  assert.equal(f.posts.length,posts);assert.equal(f.p.long.quantity,0);assert.equal(f.p.short.quantity,10);
});

test('a delayed local book veto uses only the actual first-leg fill and cannot replay its zero original ID',async t=>{
  const f=fixture();t.after(()=>f.close());let calls=0,zeroOriginal='';
  f.adapters.get('bybit')!.placeOrder=async(request,permit)=>{
    calls++;if(calls===1){await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(f.p.long.quantity,0);
      f.books.get('bybit')!.asks[0].price=1.012;assert.equal(permit?.(),false);zeroOriginal=request.clientOrderId;
      return {id:'',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now(),rejectionCode:'ORDER_SUBMISSION_PERMISSION_CHANGED'};}
    assert.equal(permit?.(),true);f.posts.push({exchange:'bybit',request});return f.result(request);
  };
  await f.start();assert.equal(calls,2);assert.equal(f.posts.length,2);assert.equal(f.p.status,'closed');
  assert.equal(f.posts.at(-1)!.request.quantity,10);assert.notEqual(f.posts.at(-1)!.request.clientOrderId,zeroOriginal);
  assert.equal(f.store.data.orders.find(order=>order.request.clientOrderId===zeroOriginal)!.result!.filledQuantity,0);
});

for(const response of ['unknown','hard-rejection'] as const)
test(`a new ${response} after a real IOC fill grants no confirmed tail authority`,async t=>{
  const f=fixture();t.after(()=>f.close());
  f.adapters.get('bybit')!.placeOrder=async(request,permit)=>{
    assert.equal(permit?.(),true);f.posts.push({exchange:'bybit',request});
    return response==='unknown'?unknownOrder(request,'offline-native-new-unknown'):
      {...f.result(request,0),rejectionCode:'EXCHANGE_HARD_REJECT'};
  };
  await f.start();assert.equal(f.posts.length,2);assert.equal(f.p.long.quantity,0);assert.equal(f.p.short.quantity,10);
  assert.equal(f.execution.hasPendingIocProfitTail(f.p),false);
  assert.equal(f.execution.dispatchIocProfitClose(f.p,'must not compensate unknown or refused receipt'),false);
});

test('a confirmed IOC tail still requires fresh exact native quantities and complete empty orders before submitting',async t=>{
  const f=fixture();t.after(()=>f.close());const fill=await deferredTail(f),posts=f.posts.length;
  f.adapters.get('bybit')!.fetchAccount=async()=>({freeUsd:100,equityUsd:100,positions:[{base:f.p.base,symbol:f.p.short.symbol,side:'short',quantity:11,
    entryPrice:1,markPrice:1,liquidationPrice:0,leverage:2,marginMode:'crossed'}]});
  fill();assert.equal(f.execution.dispatchIocProfitClose(f.p,'same confirmed budget requires real account'),true);
  await f.execution.waitIocProfitClose(f.p);assert.equal(f.posts.length,posts);assert.equal(f.p.long.quantity,0);assert.equal(f.p.short.quantity,10);
});

for(const observation of ['funding','non-funding-cash'] as const)
test(`IOC tail native preflight cannot renew scope after an asynchronous ${observation} change`,async t=>{
  const f=fixture();t.after(()=>f.close());const fill=await deferredTail(f),posts=f.posts.length;
  const adapter=f.adapters.get('bybit')!,original=adapter.fetchAccount.bind(adapter);let changed=false;
  adapter.fetchAccount=async()=>{if(!changed){changed=true;if(observation==='funding')f.p.fundingUsd+=.001;else f.p.realizedSpreadPnlUsd+=.001;}
    return original();};
  fill();assert.equal(f.execution.dispatchIocProfitClose(f.p,'requires fresh dynamic financial scope'),true);
  await f.execution.waitIocProfitClose(f.p);assert.equal(changed,true);assert.equal(f.posts.length,posts);
  assert.equal(f.execution.hasPendingIocProfitTail(f.p),observation==='funding');
  if(observation==='funding'){
    assert.equal(f.execution.dispatchIocProfitClose(f.p,'new independent funding observed'),true);await f.execution.waitIocProfitClose(f.p);
    assert.equal(f.posts.length,posts+1);assert.equal(f.p.status,'closed');
  }else assert.equal(f.execution.dispatchIocProfitClose(f.p,'must not renew foreign cash scope'),false);
});

for(const mutation of ['cash','config','funding'] as const)
test(`final IOC receipt release cannot rebind ${mutation} into a confirmed tail grant`,async t=>{
  const f=fixture();t.after(()=>f.close());let changed=false;
  f.execution.context.serialize=async fn=>{
    const result=await f.serial(fn),closing=f.store.data.orders.filter(order=>order.request.reduceOnly);
    if(!changed&&closing.length===2&&closing.every(order=>order.result&&order.executionEvidence?.bookedFeeUsd===order.result.feeUsd)){
      changed=true;
      if(mutation==='cash')f.p.realizedSpreadPnlUsd+=.001;
      if(mutation==='config')f.store.data.config.minExitProfitBps=(f.store.data.config.minExitProfitBps??10)+1;
      if(mutation==='funding')f.p.fundingUsd+=.001;
    }
    return result;
  };
  f.adapters.get('bybit')!.placeOrder=async(request,permit)=>{
    assert.equal(permit?.(),true);f.posts.push({exchange:'bybit',request});return f.result(request,0);
  };
  await f.start();assert.equal(changed,true);assert.equal(f.p.long.quantity,0);assert.equal(f.p.short.quantity,10);
  assert.equal(f.execution.hasPendingIocProfitTail(f.p),mutation==='funding');
  if(mutation!=='funding')assert.equal(f.execution.dispatchIocProfitClose(f.p,'foreign changes must not renew tail'),false);
});
