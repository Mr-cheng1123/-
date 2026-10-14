import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {Execution} from '../src/core/execution.js';
import {unknownOrder} from '../src/adapters/normalization.js';
import {defaultConfig} from '../src/shared/config.js';
import type {Store} from '../src/core/store.js';
import type {AccountState,AppConfig,ExchangeAdapter,ExchangeId,JournalOrder,MarketSnapshot,NativeExitRecoveryAudit,OrderRequest,OrderResult,Position} from '../src/shared/types.js';

const NOW=Date.UTC(2026,9,11,14),base='MAGIC',symbol='MAGIC/USDT:USDT',batch=345;
function fixture(t:TestContext){
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const config:AppConfig={...structuredClone(defaultConfig),mode:'live',dataSource:'public',entryPolicy:'aligned',holdMode:'adaptive',
    exchanges:['gate','bybit'],symbols:[base],maxOrderRetries:0,minExitProfitBps:10,feeRebatePct:{gate:70,bitget:50}};
  const p:Position={id:'offline-MAGIC-followup',base,mode:'live',entryPolicy:'aligned',holdMode:'adaptive',status:'closing',openedAt:NOW-10_000,
    plannedExitAt:NOW+3_610_000,profitExitNotionalUsd:1030,closeRequestedAt:NOW-4000,closeProfitRequired:true,closePricing:'best-opposite',
    long:{exchange:'gate',symbol,side:'long',quantity:1000,entryPrice:1,markPrice:1,feesUsd:.521096,liquidationDistancePct:null},
    short:{exchange:'bybit',symbol,side:'short',quantity:1000,entryPrice:1,markPrice:1,feesUsd:.53,liquidationDistancePct:null},
    fundingUsd:0,feesUsd:1.051096,transferCostUsd:0,realizedSpreadPnlUsd:.48,spreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[],
    profitExitPolicy:{firstFundingTime:NOW+3_600_000,earliestExitAt:NOW+3_610_000,minSpreadNetUsd:0,minCombinedNetUsd:0,fundingChecks:[]}};
  const orders:JournalOrder[]=[],logs:Array<{level:unknown;message:string}>=[],saved:unknown[]=[],events:string[]=[],posts:OrderRequest[]=[],makerPosts:OrderRequest[]=[];
  const data={version:1 as const,config,positions:[p],orders,logs:[],equity:[],killSwitch:false,fundingSeen:[]};
  const store={data,save(){saved.push(structuredClone(data));},log(level:unknown,message:string){logs.push({level,message});}} as unknown as Store;
  const books=new Map<ExchangeId,MarketSnapshot>(),accounts=new Map<ExchangeId,AccountState>();
  for(const leg of [p.long,p.short]){
    const long=leg.side==='long',id=`offline-original-open-${leg.exchange}`;
    orders.push({positionId:p.id,exchange:leg.exchange,createdAt:p.openedAt,
      request:{clientOrderId:id,base,symbol,side:long?'buy':'sell',quantity:1030,limitPrice:1,reduceOnly:false},
      result:{id:`native-${id}`,clientOrderId:id,status:'filled',filledQuantity:1030,averagePrice:1,feeUsd:.515,timestamp:p.openedAt}});
    books.set(leg.exchange,{exchange:leg.exchange,base,symbol,source:'public',timestamp:NOW,observedAt:NOW,fundingObservedAt:NOW,bookTransport:'websocket',
      markPrice:1,indexPrice:1,fundingRate:long?0:.001,intervalHours:8,nextFundingTime:NOW+3_600_000,fundingHistory:[],
      bids:[{price:long?1.006:.998,quantity:batch}],asks:[{price:long?1.016:1,quantity:batch}],
      quantityStep:1,minQuantity:1,minNotional:1,contractSize:1,openInterestUsd:1e6,volume24hUsd:1e6,
      takerFeeRate:.0005,takerFeeAt:NOW,takerFeeSource:'exchange',makerFeeRate:.0002,makerFeeAt:NOW,makerFeeSource:'exchange'});
    accounts.set(leg.exchange,{freeUsd:1000,equityUsd:1000,positions:[{base,symbol,side:leg.side,quantity:1000,entryPrice:1,markPrice:1,
      liquidationPrice:0,leverage:2,marginMode:'crossed',positionId:`slot-${leg.exchange}`,positionOpenedAt:p.openedAt}]});
  }
  const parentRequest:OrderRequest={clientOrderId:'offline-original-maker-30',base,symbol,side:'sell',quantity:30,limitPrice:1.016,reduceOnly:true,postOnly:true};
  const originalParent:JournalOrder={positionId:p.id,exchange:'gate',createdAt:NOW-3000,request:parentRequest,
    result:{id:'native-original-maker-30',clientOrderId:parentRequest.clientOrderId,status:'filled',filledQuantity:30,averagePrice:1.016,averagePriceVerified:true,feeUsd:.006096,timestamp:NOW-2900},
    makerReduction:{activity:'terminal',makerLeg:'long',quantityStep:1,peerQuantityStep:1,deadlineAt:NOW-2800,bookedExecution:true,lastObservedAt:NOW-2900},
    executionEvidence:{version:1,method:'maker',role:'exit',batchId:'old-30',bookedFeeUsd:.006096}};
  const filledRequest:OrderRequest={clientOrderId:'offline-original-peer-30-filled',base,symbol,side:'buy',quantity:30,limitPrice:1,reduceOnly:true};
  orders.push(originalParent,{positionId:p.id,exchange:'bybit',createdAt:NOW-2000,request:filledRequest,
    result:{id:'native-original-peer-30',clientOrderId:filledRequest.clientOrderId,status:'filled',filledQuantity:30,averagePrice:1,averagePriceVerified:true,feeUsd:.015,timestamp:NOW-1900},
    executionEvidence:{version:1,method:'ioc',role:'exit-tail',batchId:'old-30',makerCloseParentClientId:parentRequest.clientOrderId,bookedFeeUsd:.015}});
  const unknownRequest:OrderRequest={clientOrderId:'offline-old-unknown-30',base,symbol,side:'buy',quantity:30,limitPrice:1,reduceOnly:true};
  const oldUnknown:JournalOrder={positionId:p.id,exchange:'bybit',createdAt:NOW-1000,request:unknownRequest,result:unknownOrder(unknownRequest),
    executionEvidence:{version:1,method:'ioc',role:'exit-tail',batchId:'old-30',makerCloseParentClientId:parentRequest.clientOrderId,nativeTakerFeeRate:.0005}};
  orders.push(oldUnknown);
  const nativeEvidence=[p.long,p.short].map(leg=>({exchange:leg.exchange,requestedAt:NOW,symbol,side:leg.side,quantity:leg.quantity,
    entryPrice:1,marginMode:'crossed' as const,positionId:`slot-${leg.exchange}`,positionOpenedAt:p.openedAt}));
  const audit:NativeExitRecoveryAudit={version:1,id:'offline-original-regrant',authorizedAt:NOW,parentClientOrderId:parentRequest.clientOrderId,
    unknownClientOrderIds:[unknownRequest.clientOrderId],originalRemainingBudget:0,feeReserveUsd:.015,lossReserveUsd:0,
    originalUnknowns:[{clientOrderId:unknownRequest.clientOrderId,financialFingerprint:'offline-native-cash',originalResult:structuredClone(oldUnknown.result!)}],
    originalParentFingerprint:'offline-old-parent',nativeReadEvidence:[...nativeEvidence,...structuredClone(nativeEvidence)],
    noOpenOrders:nativeEvidence.map(row=>({exchange:row.exchange,symbol,checkedAt:NOW}))};p.nativeExitRecoveryAudit=[audit];
  let fault:'none'|'native-quantity'|'book'|'unknown'='none',makerFilled=false,peerCalls=0,permitAllowed=true;
  const adapters=new Map<ExchangeId,ExchangeAdapter>();
  for(const exchange of ['gate','bybit'] as const){
    const adapter:ExchangeAdapter={id:exchange,supportsMakerReduction:()=>true,fetchSnapshots:async()=>[],fetchFundingPayments:async()=>[],prepareTrading:async()=>{},
      fetchAccount:async()=>{events.push(`account:${exchange}`);const account=structuredClone(accounts.get(exchange)!);
        if(exchange==='gate'&&makerFilled&&fault==='native-quantity')account.positions[0].quantity=1000;return account;},
      fetchOpenOrders:async()=>{events.push(`open:${exchange}`);return [];},validateOrder:async()=>{},validateOrderLocally:async()=>{},validateMakerReduction:async()=>{},
      submitMakerReduction:async(request,permit)=>{assert.equal(exchange,'gate');assert.equal(permit?.(),true);makerPosts.push(structuredClone(request));return unknownOrder(request,'native-new-MAGIC-345');},
      inspectMakerReduction:async(request,id)=>{assert.equal(exchange,'gate');assert.equal(id,'native-new-MAGIC-345');
        if(!makerFilled){makerFilled=true;accounts.get('gate')!.positions[0].quantity-=request.quantity;events.push(`maker-filled:${request.quantity}`);}
        return {activity:'terminal',executionVerified:true,observedAt:Date.now(),result:{id:id!,clientOrderId:request.clientOrderId,status:'filled',filledQuantity:request.quantity,
          averagePrice:request.limitPrice,averagePriceVerified:true,feeUsd:request.quantity*request.limitPrice*.0002,timestamp:Date.now()}};},
      placeOrder:async(request,permit)=>{assert.equal(exchange,'bybit');peerCalls++;
        if(fault==='book')books.get('bybit')!.asks[0].price=1.0004;
        if(!permit?.()||!permitAllowed)return {id:'',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now(),
          rejectionCode:'ORDER_SUBMISSION_PERMISSION_CHANGED',rejectionReason:'offline current native or book veto'};
        posts.push(structuredClone(request));events.push(`peer-post:${request.quantity}`);
        if(fault==='unknown')return unknownOrder(request,'native-new-peer-unknown');
        accounts.get('bybit')!.positions[0].quantity-=request.quantity;
        return {id:`native-new-peer-${posts.length}`,clientOrderId:request.clientOrderId,status:'filled',filledQuantity:request.quantity,averagePrice:request.limitPrice,
          averagePriceVerified:true,feeUsd:request.quantity*request.limitPrice*.0005,timestamp:Date.now()};},
      reconcileOrder:async()=>{throw new Error('no speculative reconciliation in this fake financial owner');},
      cancelMakerReduction:async()=>{throw new Error('terminal native Maker requires no cancellation');},cancelOrder:async()=>{throw new Error('no financial cancellation');},close:async()=>{}};
    adapters.set(exchange,adapter);
  }
  let queue=Promise.resolve();const serial=<T>(fn:()=>Promise<T>):Promise<T>=>{const result=queue.then(fn,fn);queue=result.then(()=>undefined,()=>undefined);return result;};
  const execution=new Execution(store,{config:()=>config,liveUnlocked:()=>permitAllowed,makerActionsAllowed:()=>true,serialize:serial,
    snapshot:exchange=>books.get(exchange as ExchangeId),adapter:exchange=>adapters.get(exchange as ExchangeId)!,canUseSnapshot:()=>true,
    refreshSnapshots:async()=>{},refreshReductionSnapshots:async()=>{},halt:reason=>logs.push({level:'halt',message:reason})});
  execution.installNativeExitAuthority(p,audit,()=>permitAllowed);
  const refresh=()=>{for(const book of books.values())Object.assign(book,{timestamp:Date.now(),observedAt:Date.now(),takerFeeAt:Date.now(),makerFeeAt:Date.now(),fundingObservedAt:Date.now()});};
  return {p,store,execution,books,accounts,logs,saved,events,posts,makerPosts,audit,oldUnknown,originalParent,serial,refresh,
    setFault(value:typeof fault){fault=value;},peerCalls:()=>peerCalls,revoke(){permitAllowed=false;},
    async start(){const preparation=await execution.prepareMakerClose(p);assert.ok(preparation);assert.equal(preparation.prepared.request.quantity,batch);
      await serial(()=>execution.startMakerClose(p,'offline actual MAGIC followup',preparation));await execution.waitMakerClose(p);},
    async close(){await execution.drainMakerCloses();}};
}

for(const fault of ['native-quantity','book'] as const)test(`current-session MAGIC Maker345 retains and later consumes exact pending peer budget after transient ${fault} veto`,async t=>{
  const f=fixture(t);t.after(()=>f.close());const oldUnknown=structuredClone(f.oldUnknown),originalFees=f.p.feesUsd,originalRealized=f.p.realizedSpreadPnlUsd;
  f.setFault(fault);await f.start();
  const maker=f.store.data.orders.find(order=>order!==f.originalParent&&order.makerReduction)!;
  assert.equal(f.makerPosts.length,1);assert.equal(f.makerPosts[0].postOnly,true);assert.equal(maker.result!.filledQuantity,batch);
  assert.equal(f.p.long.quantity,655);assert.equal(f.p.short.quantity,1000);assert.equal(f.posts.length,0);assert.equal(f.peerCalls(),1);
  assert.equal(f.execution.hasPendingMakerCloseTail(f.p),true,JSON.stringify({risk:f.p.riskReasons,logs:f.logs}));
  assert.equal(f.p.feesUsd,originalFees+batch*1.016*.0002);assert.deepEqual(f.oldUnknown,oldUnknown);
  const veto=f.store.data.orders.find(order=>order.executionEvidence?.makerCloseParentClientId===maker.request.clientOrderId)!;
  assert.equal(veto.result!.status,'cancelled');assert.equal(veto.result!.filledQuantity,0);assert.equal(veto.result!.feeUsd,0);
  assert.equal(veto.result!.rejectionCode,'MAKER_REDUCTION_PERMISSION_CHANGED');
  assert.equal(maker.makerReduction!.peerPermissionVetoReason,fault==='native-quantity'?'native-proof':'book');
  assert.ok(maker.makerReduction!.peerNativeCheckStartedAt!<=maker.makerReduction!.peerNativeCheckCompletedAt!);
  f.setFault('none');f.books.get('bybit')!.asks[0].price=1;t.mock.timers.setTime(Date.now()+501);f.refresh();
  assert.equal(f.execution.dispatchMakerCloseTail(f.p),true);await f.execution.waitMakerClose(f.p);
  assert.equal(f.posts.length,1);assert.equal(f.posts[0].quantity,batch);assert.equal(f.posts[0].reduceOnly,true);assert.equal(f.posts[0].postOnly,undefined);
  assert.equal(f.p.long.quantity,655);assert.equal(f.p.short.quantity,655);assert.equal(f.execution.hasPendingMakerCloseTail(f.p),false);
  assert.equal(f.p.feesUsd,originalFees+batch*1.016*.0002+batch*.0005);
  assert.ok(Math.abs(f.p.realizedSpreadPnlUsd-(originalRealized+batch*.016))<1e-10);assert.deepEqual(f.oldUnknown,oldUnknown);
  const peer=f.store.data.orders.find(order=>order.executionEvidence?.makerCloseParentClientId===maker.request.clientOrderId&&order.result?.status==='filled')!;
  assert.equal(f.execution.applyObservedOrder(peer,structuredClone(peer.result!)),false);assert.equal(f.execution.applyObservedMakerTerminal(maker,{activity:'terminal',executionVerified:true,observedAt:Date.now(),result:structuredClone(maker.result!)}),false);
  assert.equal(f.execution.dispatchMakerCloseTail(f.p),false);assert.equal(f.posts.length,1);assert.equal(f.makerPosts.length,1);
  assert.equal(f.store.data.killSwitch,false);assert.equal(f.p.profitExitNotionalUsd,1030);
});

test('a new MAGIC peer unknown keeps its own original ID and freezes further followup despite old historical exemption',async t=>{
  const f=fixture(t);t.after(()=>f.close());f.setFault('unknown');await f.start();
  assert.equal(f.posts.length,1);assert.equal(f.p.long.quantity,655);assert.equal(f.p.short.quantity,1000);
  assert.equal(f.execution.hasPendingMakerCloseTail(f.p),false);f.setFault('none');t.mock.timers.setTime(Date.now()+501);f.refresh();
  assert.equal(f.execution.dispatchMakerCloseTail(f.p),false);assert.equal(f.posts.length,1);
  assert.ok(f.store.data.orders.some(order=>order.result?.id==='native-new-peer-unknown'&&order.result.status==='unknown'));
  assert.equal(f.oldUnknown.result!.status,'unknown');
});

function regrantConfirmedParent(f:ReturnType<typeof fixture>,maker:JournalOrder){
  const execution=new Execution(f.store,f.execution.context),audit:NativeExitRecoveryAudit={...structuredClone(f.audit),id:'offline-selected-MAGIC-345',
    confirmedTailParentClientOrderId:maker.request.clientOrderId,confirmedTailParentFingerprint:'offline-explicit-native-345-cash',confirmedTailRemainingBudget:batch,
    nativeReadEvidence:f.audit.nativeReadEvidence.map(row=>({...row,quantity:row.side==='long'?655:1000,requestedAt:Date.now()}))};
  f.p.nativeExitRecoveryAudit!.push(audit);execution.installNativeExitAuthority(f.p,audit,()=>true);return {execution,audit};
}

test('explicit restarted MAGIC345 parent regrant cannot spend the exhausted old30 or an arbitrary parent',async t=>{
  const f=fixture(t);t.after(()=>f.close());f.setFault('native-quantity');await f.start();
  const maker=f.store.data.orders.find(order=>order!==f.originalParent&&order.makerReduction)!;const r=regrantConfirmedParent(f,maker);t.after(()=>r.execution.drainMakerCloses());
  f.setFault('none');assert.equal(r.execution.hasNativeExitAuthority(f.p),true);
  assert.equal(await r.execution.repairNativeConfirmedTail(f.p,f.originalParent.request.clientOrderId),false);
  assert.equal(await r.execution.repairNativeConfirmedTail(f.p,'arbitrary-parent'),false);assert.equal(f.posts.length,0);
  assert.equal(await r.execution.repairNativeConfirmedTail(f.p,maker.request.clientOrderId),true);
  assert.equal(f.posts.length,1);assert.equal(f.posts[0].quantity,batch);assert.equal(f.p.long.quantity,655);assert.equal(f.p.short.quantity,655);
  assert.equal(f.execution.hasPendingMakerCloseTail(f.p),false);assert.equal(r.execution.hasNativeExitAuthority(f.p),true);
});

for(const change of ['fee','filled','booked-fee','request','replacement'] as const)test(`selected explicit MAGIC345 parent ${change} mutation revokes authority before a peer create`,async t=>{
  const f=fixture(t);t.after(()=>f.close());f.setFault('native-quantity');await f.start();
  const maker=f.store.data.orders.find(order=>order!==f.originalParent&&order.makerReduction)!;const r=regrantConfirmedParent(f,maker);t.after(()=>r.execution.drainMakerCloses());f.setFault('none');
  if(change==='fee')maker.result!.feeUsd+=.001;
  if(change==='filled')maker.result!.filledQuantity-=1;
  if(change==='booked-fee')maker.executionEvidence!.bookedFeeUsd!+=.001;
  if(change==='request')maker.request.quantity+=1;
  if(change==='replacement')f.store.data.orders.splice(f.store.data.orders.indexOf(maker),1,structuredClone(maker));
  assert.equal(r.execution.hasNativeExitAuthority(f.p),false);
  assert.equal(await r.execution.repairNativeConfirmedTail(f.p,maker.request.clientOrderId),false);
  assert.equal(f.posts.length,0);assert.equal(f.p.long.quantity,655);assert.equal(f.p.short.quantity,1000);
});
