import test from 'node:test';
import assert from 'node:assert/strict';
import {Execution} from '../src/core/execution.js';
import {CcxtAdapter} from '../src/adapters/ccxt.js';
import {exchangeClientId,unknownOrder} from '../src/adapters/normalization.js';
import {defaultConfig} from '../src/shared/config.js';
import {normalizeOrderReceipt} from '../src/shared/order-receipt-validity.js';
import {isCurrentUnconfirmedOrder} from '../src/shared/ledger-lifecycle.js';
import type {Store} from '../src/core/store.js';
import type {AccountOpenOrder,AccountState,AppConfig,ExchangeAdapter,ExchangeId,JournalOrder,MarketSnapshot,NativeExitRecoveryAudit,OrderRequest,OrderResult,Position} from '../src/shared/types.js';

const NOW=1_791_651_600_000,base='RUNTIME',symbol=`${base}/USDT:USDT`;
function fixture(){
  const config:AppConfig={...structuredClone(defaultConfig),mode:'live',dataSource:'public',entryPolicy:'aligned',holdMode:'adaptive',
    exchanges:['gate','bybit'],symbols:[base],maxOrderRetries:0,minExitProfitBps:10};
  const p:Position={id:'runtime-maker-offline',base,mode:'live',entryPolicy:'aligned',holdMode:'adaptive',status:'open',openedAt:Date.now()-1000,
    plannedExitAt:Date.now()+3_610_000,profitExitNotionalUsd:100,
    long:{exchange:'gate',symbol,side:'long',quantity:100,entryPrice:1,markPrice:1,feesUsd:.05,liquidationDistancePct:null},
    short:{exchange:'bybit',symbol,side:'short',quantity:100,entryPrice:1,markPrice:1,feesUsd:.05,liquidationDistancePct:null},
    fundingUsd:0,feesUsd:.1,transferCostUsd:0,realizedSpreadPnlUsd:0,spreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[],
    profitExitPolicy:{firstFundingTime:Date.now()+3_600_000,earliestExitAt:Date.now()+3_610_000,minSpreadNetUsd:0,minCombinedNetUsd:0,fundingChecks:[]}};
  const data={version:1 as const,config,positions:[p],orders:[] as JournalOrder[],logs:[],equity:[],killSwitch:false,fundingSeen:[]};
  const saved:any[]=[],logs:Array<{level:unknown;message:string}>=[],halts:string[]=[],creates:any[]=[],reads:any[]=[];
  const store={data,save(){saved.push(structuredClone(data));},log(level:unknown,message:string){logs.push({level,message});}} as unknown as Store;
  const books=new Map<ExchangeId,MarketSnapshot>();
  for(const exchange of ['gate','bybit'] as const){const long=exchange==='gate';
    books.set(exchange,{exchange,base,symbol,source:'public',timestamp:Date.now(),observedAt:Date.now(),fundingObservedAt:Date.now(),bookTransport:'websocket',
      markPrice:1,indexPrice:1,fundingRate:long?0:.001,intervalHours:8,nextFundingTime:Date.now()+3_600_000,fundingHistory:[],
      bids:[{price:long?1.006:.998,quantity:30}],asks:[{price:long?1.016:1,quantity:30}],quantityStep:1,minQuantity:1,minNotional:5,contractSize:1,
      openInterestUsd:1e6,volume24hUsd:1e6,takerFeeRate:.0005,takerFeeAt:Date.now(),takerFeeSource:'exchange',makerFeeRate:.0002,makerFeeAt:Date.now(),makerFeeSource:'exchange'});
    const id=`offline-opening-${exchange}`;data.orders.push({positionId:p.id,exchange,createdAt:p.openedAt,
      request:{clientOrderId:id,base,symbol,side:long?'buy':'sell',quantity:100,limitPrice:1,reduceOnly:false},
      result:{id:`native-${id}`,clientOrderId:id,status:'filled',filledQuantity:100,averagePrice:1,feeUsd:.05,timestamp:p.openedAt}});
  }
  let accountReads=0,onAccount:()=>void=()=>{},lostAck=false,filledPeer=false,liveUnlocked=true,
    observedNative:{id:string;request:OrderRequest}|undefined;
  const market={id:`${base}USDT`,symbol,base,quote:'USDT',settle:'USDT',active:true,swap:true,linear:true,contractSize:1,
    precision:{amount:1,price:.001},limits:{amount:{min:1},cost:{min:5}},info:{priceFilter:{tickSize:'.001'}}};
  const native=(params:any)=>{const create=creates.at(-1)??(observedNative?{orderLinkId:exchangeClientId('bybit',observedNative.request.clientOrderId),
    price:String(observedNative.request.limitPrice),qty:String(observedNative.request.quantity)}:undefined);
    return create?{orderId:observedNative?.id??(creates.length<=1?'offline-peer-native':`offline-peer-native-${creates.length}`),orderLinkId:create.orderLinkId,symbol:market.id,
    side:'Buy',positionIdx:0,reduceOnly:true,orderType:'Limit',timeInForce:'IOC',price:create.price,qty:create.qty,
    orderStatus:observedNative?'New':filledPeer?'Filled':'Cancelled',cumExecQty:filledPeer?create.qty:'0',avgPrice:filledPeer?create.price:'',
    cumExecValue:filledPeer?String(Number(create.qty)*Number(create.price)):'0',cumFeeDetail:{USDT:filledPeer?String(Number(create.qty)*Number(create.price)*.0005):'0'},
    extraFees:'',updatedTime:String(Date.now())}:undefined;};
  const ok=(result:any)=>({retCode:0,result});
  const client:any={apiKey:'OFFLINE_KEY',secret:'OFFLINE_SECRET',precisionMode:4,options:{},markets:{[symbol]:market},market:()=>market,
    loadMarkets:async()=>({[symbol]:market}),amountToPrecision:(_s:string,n:number)=>String(n),priceToPrecision:(_s:string,n:number)=>String(n),close:async()=>{},
    privateGetV5AccountInfo:async()=>{accountReads++;onAccount();return ok({unifiedMarginStatus:5,marginMode:'REGULAR_MARGIN'});},
    privateGetV5PositionList:async()=>ok({list:[{symbol:market.id,positionIdx:0,side:'Sell',
      size:nativeReadsEnabled?String(nativeAccounts.get('bybit')!.positions[0].quantity):'100',leverage:'2'}]}),
    privateGetV5OrderRealtime:async(params:any)=>{reads.push(structuredClone(params));const row=lostAck?undefined:native(params);return ok({list:row?[row]:[]});},
    privateGetV5OrderHistory:async(params:any)=>{reads.push(structuredClone(params));return ok({list:[]});},
    privatePostV5OrderCreate:async(params:any)=>{creates.push(structuredClone(params));if(nativeReadsEnabled)nativeEvents.push('POST:peer');
      if(lostAck)throw new Error('offline response lost after create');return ok({orderId:creates.length===1?'offline-peer-native':`offline-peer-native-${creates.length}`});},
    privatePostV5OrderCancel:async()=>{throw new Error('offline test forbids financial cancellation');}};
  const bybit=new CcxtAdapter('bybit',config,client);
  const nativeAccounts=new Map<ExchangeId,AccountState>(),nativeEvents:string[]=[];
  let nativeHook=(exchange:ExchangeId,kind:'account'|'open',value:AccountState|AccountOpenOrder[])=>{},nativeReadsEnabled=false;
  for(const leg of [p.long,p.short])nativeAccounts.set(leg.exchange,{freeUsd:1000,equityUsd:1000,positions:[{
    base,symbol,side:leg.side,quantity:leg.quantity,entryPrice:leg.entryPrice,markPrice:1,liquidationPrice:0,leverage:2,
    positionId:`offline-slot-${leg.exchange}`,positionOpenedAt:p.openedAt,marginMode:'crossed'}]});
  const readNativeAccount=async(exchange:ExchangeId)=>{nativeEvents.push(`account:${exchange}`);
    const account=structuredClone(nativeAccounts.get(exchange)!);nativeHook(exchange,'account',account);return account;};
  const readNativeOpen=async(exchange:ExchangeId)=>{nativeEvents.push(`open:${exchange}`);const open:AccountOpenOrder[]=[];
    nativeHook(exchange,'open',open);return open;};
  const makerCreates:OrderRequest[]=[],gate:ExchangeAdapter={id:'gate',supportsMakerReduction:()=>true,
    fetchSnapshots:async()=>[],fetchAccount:()=>readNativeAccount('gate'),fetchOpenOrders:()=>readNativeOpen('gate'),fetchFundingPayments:async()=>[],prepareTrading:async()=>{},
    validateMakerReduction:async()=>{},validateOrder:async()=>{},submitMakerReduction:async(request,permit)=>{
      assert.equal(permit?.(),true);makerCreates.push(structuredClone(request));nativeEvents.push('POST:maker');return unknownOrder(request,'offline-maker-native');},
    inspectMakerReduction:async(request,id)=>{assert.equal(id,'offline-maker-native');if(nativeReadsEnabled){nativeEvents.push('maker:confirmed');
      nativeAccounts.get('gate')!.positions[0].quantity-=request.quantity;}return {activity:'terminal',executionVerified:true,observedAt:Date.now(),
      result:{id:id!,clientOrderId:request.clientOrderId,status:'filled',filledQuantity:request.quantity,averagePrice:request.limitPrice,
        averagePriceVerified:true,feeUsd:request.quantity*request.limitPrice*.0002,timestamp:Date.now()}};},
    cancelMakerReduction:async()=>{throw new Error('terminal maker must not be cancelled');},cancelOrder:async()=>{throw new Error('offline cancellation forbidden');},
    placeOrder:async()=>{throw new Error('gate uses maker path only');},reconcileOrder:async()=>{throw new Error('gate generic reconcile forbidden');},close:async()=>{}};
  let queue=Promise.resolve();
  const serial=<T>(fn:()=>Promise<T>):Promise<T>=>{const result=queue.then(fn,fn);queue=result.then(()=>undefined,()=>undefined);return result;};
  const execution=new Execution(store,{config:()=>config,liveUnlocked:()=>liveUnlocked,makerActionsAllowed:()=>true,serialize:serial,
    snapshot:venue=>books.get(venue as ExchangeId),adapter:venue=>venue==='gate'?gate:bybit,canUseSnapshot:()=>true,
    refreshSnapshots:async()=>{},refreshReductionSnapshots:async()=>{},halt:reason=>{halts.push(reason);}});
  return {config,p,store,execution,books,saved,logs,halts,creates,reads,bybit,gate,makerCreates,serial,nativeAccounts,nativeEvents,
    enableNativeReads(){nativeReadsEnabled=true;bybit.fetchAccount=()=>readNativeAccount('bybit');bybit.fetchOpenOrders=()=>readNativeOpen('bybit');
      const originalPlace=bybit.placeOrder.bind(bybit);bybit.placeOrder=async(request,permit)=>{
        const result=await originalPlace(request,permit);if(result.filledQuantity>0){nativeEvents.push('POST:peer-confirmed');
          nativeAccounts.get('bybit')!.positions[0].quantity-=result.filledQuantity;}return result;};},
    syncNative(){for(const leg of [p.long,p.short])nativeAccounts.get(leg.exchange)!.positions[0].quantity=leg.quantity;},
    onNative(fn:typeof nativeHook){nativeHook=fn;},
    onAccount(fn:()=>void){onAccount=fn;},accountReads:()=>accountReads,loseAck(){lostAck=true;},fillPeer(){filledPeer=true;},blockLive(){liveUnlocked=false;},
    observeNative(request:OrderRequest,id:string){observedNative={request:structuredClone(request),id};},
    peer:()=>data.orders.find(row=>row.executionEvidence?.makerCloseParentClientId),
    async start(beforeNative:()=>void=()=>{}){const preparation=await execution.prepareMakerClose(p);assert.ok(preparation);beforeNative();await serial(()=>execution.startMakerClose(p,'offline log regression',preparation));await execution.waitMakerClose(p);},
    async close(){await execution.drainMakerCloses();await bybit.close();}};
}

test('actual Maker peer native veto retains same-operation proven no-send instead of creating an original-order query loop',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.close());
  await f.start(()=>f.onAccount(()=>f.blockLive()));
  const peer=f.peer()!;assert.ok(peer);
  assert.equal(peer.result!.status,'cancelled');assert.equal(peer.result!.rejectionCode,'MAKER_REDUCTION_PERMISSION_CHANGED');
  assert.equal(peer.result!.id,'');assert.equal(isCurrentUnconfirmedOrder(peer,f.store.data.positions),false);
  assert.equal(f.makerCreates.length,1);assert.equal(f.creates.length,0);
  assert.ok(f.reads.every(params=>!params.orderId&&!params.orderLinkId),'no speculative original-order lookup is added after the local veto');
  assert.equal(f.p.long.quantity,70);assert.equal(f.p.short.quantity,100,'the real unmatched Maker fill remains protected');
  assert.equal(f.store.data.killSwitch,false);assert.ok(!f.halts.some(reason=>reason.includes('原订单未知')));
  assert.equal(f.saved.at(-1).orders.find((row:JournalOrder)=>row.request.clientOrderId===peer.request.clientOrderId).result.status,'cancelled');
});

test('a generic permission diagnostic without the current operation native veto witness cannot resolve an unknown',()=>{
  const request:OrderRequest={clientOrderId:'offline-no-witness',base,symbol,side:'buy',quantity:10,limitPrice:1,reduceOnly:true};
  const result:OrderResult={id:'',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now(),
    rejectionCode:'ORDER_SUBMISSION_PERMISSION_CHANGED'};
  assert.equal(normalizeOrderReceipt(request,result).status,'unknown');
});

test('lost Maker peer create acknowledgement retains unknown and never replays the original create',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.close());f.loseAck();await f.start();
  const peer=f.peer()!;assert.equal(peer.result!.status,'unknown',JSON.stringify({result:peer.result,risk:f.p.riskReasons,halts:f.halts,logs:f.logs}));assert.equal(f.creates.length,1);
  assert.ok(f.reads.length>=2);assert.ok(f.reads.every(params=>params.orderLinkId===exchangeClientId('bybit',peer.request.clientOrderId)));
  assert.equal(f.p.long.quantity,70);assert.equal(f.p.short.quantity,100);assert.ok(f.halts.some(reason=>reason.includes('原订单未知')));
});

function tailFixture(f:ReturnType<typeof fixture>){
  f.p.status='attention';f.p.long.quantity=90;f.p.closeRequestedAt=Date.now()-500;f.p.closeProfitRequired=true;f.p.closePricing='best-opposite';
  const request:OrderRequest={clientOrderId:'offline-confirmed-parent',base,symbol,side:'sell',quantity:10,limitPrice:1.016,reduceOnly:true,postOnly:true};
  const parent:JournalOrder={positionId:f.p.id,exchange:'gate',createdAt:Date.now()-400,request,
    result:{id:'offline-confirmed-parent-native',clientOrderId:request.clientOrderId,status:'filled',filledQuantity:10,averagePrice:1.016,
      averagePriceVerified:true,feeUsd:.002032,timestamp:Date.now()-300},
    makerReduction:{activity:'terminal',makerLeg:'long',quantityStep:1,peerQuantityStep:1,deadlineAt:Date.now()-100,bookedExecution:true,lastObservedAt:Date.now()-300},
    executionEvidence:{version:1,method:'maker',role:'exit',batchId:'offline-parent',bookedFeeUsd:.002032}};
  f.store.data.orders.push(parent);return parent;
}

test('scoped confirmed-tail permission revocation during the last Bybit GET vetoes the first peer POST',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.close());const parent=tailFixture(f);
  assert.equal(f.execution.canRepairConfirmedMakerCloseTail(f.p,parent.request.clientOrderId),true);
  let allowed=true;f.onAccount(()=>{if(f.accountReads()>=2)allowed=false;});
  await f.execution.repairConfirmedMakerCloseTail(f.p,parent.request.clientOrderId,[],()=>allowed);
  assert.equal(allowed,false);assert.equal(f.creates.length,0,'scoped user permission must still be true at the native POST boundary');
  assert.equal(f.p.long.quantity,90);assert.equal(f.p.short.quantity,100);assert.equal(f.p.feesUsd,.1);
  assert.equal(f.peer()!.result!.status,'cancelled');
  assert.ok(f.reads.every(params=>!params.orderId&&!params.orderLinkId));
});

test('unchanged scoped confirmed-tail permission allows one original-budget peer POST',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.close());const parent=tailFixture(f);
  f.fillPeer();await f.execution.repairConfirmedMakerCloseTail(f.p,parent.request.clientOrderId,[],()=>true);
  assert.equal(f.creates.length,1);assert.equal(f.creates[0].reduceOnly,true);assert.equal(f.creates[0].qty,'10');
  assert.ok(f.reads.filter(params=>params.orderId||params.orderLinkId).every(params=>params.orderId==='offline-peer-native'));
  assert.equal(f.peer()!.result!.status,'filled');
  assert.equal(f.p.long.quantity,90);assert.equal(f.p.short.quantity,90);assert.equal(f.p.feesUsd,.1+.005);
});

test('a late native GET identity is durably retained while unknown execution and cash stay unchanged',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.close());
  const request:OrderRequest={clientOrderId:'offline-late-native-id',base,symbol,side:'buy',quantity:10,limitPrice:1,reduceOnly:true};
  const journal:JournalOrder={positionId:f.p.id,exchange:'bybit',createdAt:Date.now()-100,request,result:unknownOrder(request)};
  f.store.data.orders.push(journal);f.observeNative(request,'offline-late-exact-id');
  const observed=await f.bybit.inspectOrder(request);assert.equal(observed.id,'offline-late-exact-id');assert.equal(observed.status,'unknown');
  assert.equal(f.execution.applyObservedOrder(journal,observed),false);assert.equal(journal.result!.id,observed.id);
  assert.equal(journal.result!.status,'unknown');assert.equal(journal.result!.filledQuantity,0);assert.equal(journal.result!.feeUsd,0);
  const saved=f.saved.at(-1).orders.find((row:JournalOrder)=>row.request.clientOrderId===request.clientOrderId);
  assert.equal(saved.result.id,observed.id);assert.equal(saved.result.status,'unknown');
  await f.bybit.inspectOrder(request,journal.result!.id);assert.equal(f.reads.at(-1).orderId,observed.id);
  assert.equal(f.creates.length,0);assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);assert.equal(f.p.feesUsd,.1);
});

test('unchanged original-order diagnostic timestamps do not emit another warning after the heartbeat interval',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.close());
  const request:OrderRequest={clientOrderId:'offline-same-not-found',base,symbol,side:'buy',quantity:10,limitPrice:1,reduceOnly:true};
  const journal:JournalOrder={positionId:f.p.id,exchange:'bybit',createdAt:Date.now()-100,request,result:unknownOrder(request)};
  f.store.data.orders.push(journal);
  const observe=()=>f.execution.applyObservedOrder(journal,{...unknownOrder(request),orderReadAt:Date.now(),
    confirmation:{stage:'order-read',reason:'not-found',observedAt:Date.now()}});
  observe();t.mock.timers.tick(61_000);observe();
  assert.equal(f.logs.filter(row=>row.message.includes('原订单仍未确认')).length,1);
  assert.equal(journal.result!.status,'unknown');assert.equal(journal.result!.orderReadAt,Date.now());assert.equal(f.creates.length,0);
  t.mock.timers.tick(61_000);f.execution.applyObservedOrder(journal,{...unknownOrder(request),orderReadAt:Date.now(),
    confirmation:{stage:'order-read',reason:'identity-mismatch',observedAt:Date.now()}});
  assert.equal(f.logs.filter(row=>row.message.includes('原订单仍未确认')).length,2,'a genuinely different problem remains visible');
});

test('changed original-order diagnostics are visible immediately while repeated timestamps stay quiet',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.close());
  const request:OrderRequest={clientOrderId:'offline-diagnostic-changes',base,symbol,side:'buy',quantity:10,limitPrice:1,reduceOnly:true};
  const journal:JournalOrder={positionId:f.p.id,exchange:'bybit',createdAt:Date.now()-100,request,result:unknownOrder(request)};
  f.store.data.orders.push(journal);
  for(const diagnostic of [
    {reason:'not-found' as const},
    {reason:'not-found' as const},
    {reason:'request-failed' as const,apiCode:'10002'},
    {reason:'request-failed' as const,apiCode:'10002'},
    {reason:'request-failed' as const,apiCode:'10005'},
    {reason:'not-found' as const},
  ]){
    t.mock.timers.tick(1);f.execution.applyObservedOrder(journal,{...unknownOrder(request),orderReadAt:Date.now(),
      confirmation:{stage:'order-read',...diagnostic,observedAt:Date.now()}});
  }
  assert.equal(f.logs.filter(row=>row.message.includes('原订单仍未确认')).length,4);
  assert.equal(journal.result!.status,'unknown');assert.equal(f.creates.length,0);assert.equal(f.p.feesUsd,.1);
});

test('late Maker peer no-send response cannot erase an existing unknown receipt or cause a second create',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.close());
  let preserved:OrderResult|undefined;
  await f.start(()=>f.onAccount(()=>{
    const peer=f.peer();if(!peer||preserved)return;
    preserved={...unknownOrder(peer.request,'offline-observed-original'),filledQuantity:2,averagePrice:1,
      confirmation:{stage:'receipt',reason:'nonterminal',observedAt:Date.now()}};
    peer.result=structuredClone(preserved);f.blockLive();
  }));
  assert.ok(preserved);assert.deepEqual(f.peer()!.result,preserved);
  assert.equal(f.creates.length,0);assert.equal(f.store.data.orders.filter(row=>row.executionEvidence?.makerCloseParentClientId).length,1);
  assert.equal(f.p.long.quantity,70);assert.equal(f.p.short.quantity,100);assert.ok(f.halts.some(reason=>reason.includes('原订单记录已变化')));
});

test('late Maker peer confirmed response cannot book a terminal observation twice',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.close());f.fillPeer();
  const place=f.bybit.placeOrder.bind(f.bybit);let observed:OrderResult|undefined,bookedFees:number|undefined;
  f.bybit.placeOrder=async(request,permit)=>{
    const result=await place(request,permit);
    await f.serial(async()=>{
      assert.equal(f.execution.applyObservedOrder(f.peer()!,result),true);
      observed=structuredClone(f.peer()!.result);bookedFees=f.p.feesUsd;
    });
    return result;
  };
  await f.start();assert.ok(observed);assert.deepEqual(f.peer()!.result,observed);
  assert.equal(f.creates.length,1);assert.equal(f.p.long.quantity,70);assert.equal(f.p.short.quantity,70);
  assert.equal(f.p.feesUsd,bookedFees);assert.equal(f.peer()!.executionEvidence!.bookedFeeUsd,observed.feeUsd);
  assert.ok(f.halts.some(reason=>reason.includes('原订单记录已变化')));assert.equal(f.store.data.killSwitch,false);
});

test('Maker peer unknown fill is booked atomically before a later terminal observation adds the remainder once',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.close());f.fillPeer();
  const place=f.bybit.placeOrder.bind(f.bybit);let terminal:OrderResult|undefined,extraReads=0;
  f.bybit.placeOrder=async(request,permit)=>{
    terminal=await place(request,permit);
    return {...terminal,status:'unknown',filledQuantity:2,feeUsd:.001,
      confirmation:{stage:'receipt',reason:'nonterminal',observedAt:Date.now()}};
  };
  f.bybit.reconcileOrder=async()=>{extraReads++;throw new Error('The execution owner must not expose unbooked cumulative cash while querying');};
  await f.start();const peer=f.peer()!;assert.ok(terminal);assert.equal(extraReads,0);
  assert.equal(peer.result!.status,'unknown');assert.equal(peer.result!.filledQuantity,2);
  assert.equal(f.p.long.quantity,70);assert.equal(f.p.short.quantity,98);
  assert.equal(peer.executionEvidence!.bookedFeeUsd,.001);
  const makerFee=f.store.data.orders.find(row=>row.makerReduction)!.result!.feeUsd;
  assert.equal(f.p.feesUsd,.1+makerFee+.001);
  const saved=f.saved.at(-1),savedPeer=saved.orders.find((row:JournalOrder)=>row.request.clientOrderId===peer.request.clientOrderId);
  assert.equal(savedPeer.result.filledQuantity,2);assert.equal(saved.positions[0].short.quantity,98);
  assert.equal(f.execution.applyObservedOrder(peer,terminal),true);
  assert.equal(f.p.short.quantity,70);assert.equal(f.p.feesUsd,.1+makerFee+terminal.feeUsd);
  assert.equal(f.execution.applyObservedOrder(peer,terminal),false);
  assert.equal(f.p.short.quantity,70);assert.equal(f.creates.length,1);assert.equal(f.store.data.killSwitch,false);
});

function nativeExitFixture(f:ReturnType<typeof fixture>,options:{feeReserveUsd?:number;lossReserveUsd?:number}={}){
  f.enableNativeReads();f.config.feeRebatePct={gate:70,bitget:50};
  const parent=tailFixture(f);parent.request.quantity=30;parent.result!.filledQuantity=30;parent.result!.feeUsd=.006096;
  parent.executionEvidence!.bookedFeeUsd=.006096;
  f.p.long.quantity=70;f.p.long.feesUsd+=.006096;f.p.feesUsd+=.006096;f.p.realizedSpreadPnlUsd=.48;f.p.status='closing';
  f.syncNative();
  const request:OrderRequest={clientOrderId:'offline-old-peer-unknown',base,symbol,side:'buy',quantity:30,limitPrice:1,reduceOnly:true};
  const unknown:JournalOrder={positionId:f.p.id,exchange:'bybit',createdAt:parent.createdAt+100,request,result:unknownOrder(request),
    executionEvidence:{version:1,method:'ioc',role:'exit-tail',batchId:'offline-old',makerCloseParentClientId:parent.request.clientOrderId,
      nativeTakerFeeRate:.0005,feeObservedAt:Date.now()-500}};
  f.store.data.orders.push(unknown);
  const evidence=[f.p.long,f.p.short].map(leg=>({exchange:leg.exchange,requestedAt:Date.now(),symbol:leg.symbol,side:leg.side,
    quantity:leg.quantity,positionId:`offline-slot-${leg.exchange}`,positionOpenedAt:f.p.openedAt,entryPrice:leg.entryPrice,marginMode:'crossed' as const}));
  const audit:NativeExitRecoveryAudit={version:1,id:'offline-native-authority',authorizedAt:Date.now(),parentClientOrderId:parent.request.clientOrderId,
    unknownClientOrderIds:[request.clientOrderId],originalRemainingBudget:30,feeReserveUsd:options.feeReserveUsd??.015,
    lossReserveUsd:options.lossReserveUsd??0,originalUnknowns:[{clientOrderId:request.clientOrderId,financialFingerprint:'offline-original-cash',
      originalResult:structuredClone(unknown.result!)}],originalParentFingerprint:'offline-confirmed-parent',
    nativeReadEvidence:[...evidence,...structuredClone(evidence)],noOpenOrders:evidence.map(row=>({exchange:row.exchange,symbol:row.symbol,checkedAt:Date.now()}))};
  f.p.nativeExitRecoveryAudit=[audit];let allowed=true;
  f.execution.installNativeExitAuthority(f.p,audit,()=>allowed);
  return {parent,unknown,audit,revoke(){allowed=false;}};
}

test('selected native authority repairs only confirmed parent budget while preserving the old unknown and booking new cash once',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.close());const n=nativeExitFixture(f),old=structuredClone(n.unknown);
  const initial={fees:f.p.feesUsd,realized:f.p.realizedSpreadPnlUsd};f.fillPeer();
  assert.equal(await f.execution.repairNativeConfirmedTail(f.p,n.parent.request.clientOrderId),true,
    JSON.stringify({risk:f.p.riskReasons,logs:f.logs,events:f.nativeEvents,results:f.store.data.orders.map(order=>order.result)}));
  assert.equal(f.creates.length,1);assert.equal(f.creates[0].qty,'30');assert.equal(f.creates[0].reduceOnly,true);
  assert.equal(f.p.long.quantity,70);assert.equal(f.p.short.quantity,70);assert.equal(f.p.feesUsd,initial.fees+.015);
  assert.equal(f.p.realizedSpreadPnlUsd,initial.realized);assert.deepEqual(n.unknown,old);assert.equal(n.unknown.result!.status,'unknown');
  assert.equal(f.nativeEvents.filter(value=>value.startsWith('account:')).length,2);
  assert.equal(f.nativeEvents.filter(value=>value.startsWith('open:')).length,2);
  assert.equal(await f.execution.repairNativeConfirmedTail(f.p,n.parent.request.clientOrderId),true);
  assert.equal(f.creates.length,1,'the exhausted old parent budget cannot be spent twice');
  const newPeer=f.store.data.orders.find(order=>order!==n.unknown&&order.executionEvidence?.makerCloseParentClientId===n.parent.request.clientOrderId)!;
  assert.equal(f.execution.applyObservedOrder(newPeer,structuredClone(newPeer.result!)),false);assert.equal(f.p.feesUsd,initial.fees+.015);
});

for(const scope of ['position','contract','unidentified'] as const)test(`selected native authority blocks a newly appearing ${scope} unknown before creating a peer`,async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.close());const n=nativeExitFixture(f);f.fillPeer();
  const extra=structuredClone(n.unknown);extra.request.clientOrderId='offline-new-unrelated-unknown';extra.result!.clientOrderId=extra.request.clientOrderId;
  if(scope!=='position')extra.positionId='offline-other-position';if(scope==='contract')extra.request.base='OTHER';
  if(scope==='unidentified'){extra.request.base='';extra.request.symbol='';}
  f.store.data.orders.push(extra);const before={long:f.p.long.quantity,short:f.p.short.quantity,fees:f.p.feesUsd};
  assert.equal(await f.execution.repairNativeConfirmedTail(f.p,n.parent.request.clientOrderId),false);
  assert.equal(f.creates.length,0);assert.deepEqual({long:f.p.long.quantity,short:f.p.short.quantity,fees:f.p.feesUsd},before);
});

for(const issue of ['quantity','foreign-open','incomplete-open','permission-after-GET'] as const)test(`selected native authority ${issue} final read failure vetoes the unsent peer without touching old cash`,async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.close());const n=nativeExitFixture(f),old=structuredClone(n.unknown);f.fillPeer();
  f.onNative((exchange,kind,value)=>{
    if(issue==='quantity'&&exchange==='gate'&&kind==='account')(value as AccountState).positions[0].quantity+=1;
    if(issue==='foreign-open'&&exchange==='gate'&&kind==='open')(value as AccountOpenOrder[]).push({id:'offline-foreign-open'} as AccountOpenOrder);
    if(issue==='incomplete-open'&&kind==='open')throw new Error('offline pagination incomplete');
    if(issue==='permission-after-GET'&&exchange==='bybit'&&kind==='open')n.revoke();
  });
  const fees=f.p.feesUsd;assert.equal(await f.execution.repairNativeConfirmedTail(f.p,n.parent.request.clientOrderId),false);
  assert.equal(f.creates.length,0);assert.equal(f.p.long.quantity,70);assert.equal(f.p.short.quantity,100);assert.equal(f.p.feesUsd,fees);
  assert.deepEqual(n.unknown,old);assert.equal(f.store.data.orders.filter(order=>order!==n.unknown&&order.executionEvidence?.makerCloseParentClientId).length,1);
  const veto=f.store.data.orders.find(order=>order!==n.unknown&&order.executionEvidence?.makerCloseParentClientId)!;
  assert.equal(veto.result!.status,'cancelled');assert.equal(veto.result!.rejectionCode,'MAKER_REDUCTION_PERMISSION_CHANGED');
});

test('late old terminal is quarantined after native repair and restart does not grant persisted audit a new authority',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.close());const n=nativeExitFixture(f),old=structuredClone(n.unknown);f.fillPeer();
  assert.equal(await f.execution.repairNativeConfirmedTail(f.p,n.parent.request.clientOrderId),true);
  const after={long:f.p.long.quantity,short:f.p.short.quantity,fees:f.p.feesUsd,realized:f.p.realizedSpreadPnlUsd};
  const terminal:OrderResult={id:'offline-original-late-native',clientOrderId:n.unknown.request.clientOrderId,status:'filled',filledQuantity:30,
    averagePrice:1,averagePriceVerified:true,feeUsd:.015,timestamp:Date.now()};
  assert.equal(f.execution.applyObservedOrder(n.unknown,terminal),false);assert.deepEqual(n.unknown,old);
  assert.deepEqual({long:f.p.long.quantity,short:f.p.short.quantity,fees:f.p.feesUsd,realized:f.p.realizedSpreadPnlUsd},after);
  assert.equal(n.audit.lateEvidence!.length,1);assert.ok(n.audit.revokedAt);assert.equal(f.execution.hasNativeExitAuthority(f.p),false);
  assert.equal(f.execution.applyObservedOrder(n.unknown,terminal),false);assert.equal(n.audit.lateEvidence!.length,1);
  const restarted=new Execution(f.store,f.execution.context);assert.equal(restarted.hasNativeExitAuthority(f.p),false);
  assert.equal(await restarted.repairNativeConfirmedTail(f.p,n.parent.request.clientOrderId),false);
  assert.equal(await restarted.prepareMakerClose(f.p),undefined);assert.equal(f.creates.length,1);assert.equal(f.makerCreates.length,0);
});

test('native reserve keeps Maker profit trigger above original 10bps while never booking the shadow cost',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.close());const n=nativeExitFixture(f,{feeReserveUsd:1,lossReserveUsd:1});f.fillPeer();
  assert.equal(await f.execution.repairNativeConfirmedTail(f.p,n.parent.request.clientOrderId),true);
  const transfer=f.p.transferCostUsd,fees=f.p.feesUsd;
  assert.equal(await f.execution.prepareMakerClose(f.p),undefined);assert.equal(f.makerCreates.length,0);
  assert.equal(f.p.profitExitNotionalUsd,100);assert.equal(f.p.transferCostUsd,transfer);assert.equal(f.p.feesUsd,fees);
});

test('after audited native tail repair the main leg stays Maker and each newly confirmed fill immediately closes the peer',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.close());const n=nativeExitFixture(f),old=structuredClone(n.unknown);f.fillPeer();
  assert.equal(await f.execution.repairNativeConfirmedTail(f.p,n.parent.request.clientOrderId),true);
  const preparation=await f.execution.prepareMakerClose(f.p);assert.ok(preparation,'exact audited unknown must not block native exit rebate economics');
  await f.serial(()=>f.execution.startMakerClose(f.p,'offline native continued Maker management',preparation));await f.execution.waitMakerClose(f.p);
  assert.equal(f.makerCreates.length,1);assert.equal(f.makerCreates[0].postOnly,true);assert.equal(f.makerCreates[0].reduceOnly,true);
  assert.equal(f.makerCreates[0].quantity,30);assert.equal(f.creates.length,2);assert.equal(f.creates[1].qty,'30');assert.equal(f.creates[1].reduceOnly,true);
  assert.equal(f.p.long.quantity,40);assert.equal(f.p.short.quantity,40);assert.deepEqual(n.unknown,old);
  const fillEvent=f.nativeEvents.indexOf('maker:confirmed'),peerPost=f.nativeEvents.lastIndexOf('POST:peer');
  assert.ok(fillEvent>=0&&peerPost>fillEvent);assert.ok(f.nativeEvents.slice(fillEvent+1,peerPost).every(value=>value.startsWith('account:')||value.startsWith('open:')),
    'only required native boundary GETs occur between the committed Maker fill and peer POST');
  assert.equal(f.execution.hasNativeExitAuthority(f.p),true);assert.equal(f.p.profitExitNotionalUsd,100);
});

test('an active restored Maker hedges cumulative 10 then 30 immediately using only its own verified resting order',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.close());const n=nativeExitFixture(f);f.fillPeer();
  assert.equal(await f.execution.repairNativeConfirmedTail(f.p,n.parent.request.clientOrderId),true);
  let inspections=0,previous=0;
  f.gate.inspectMakerReduction=async(request,id)=>{
    assert.equal(id,'offline-maker-native');const filled=++inspections===1?10:30;
    f.nativeAccounts.get('gate')!.positions[0].quantity-=filled-previous;previous=filled;f.nativeEvents.push(`maker:cumulative:${filled}`);
    return {activity:filled===10?'active':'terminal',executionVerified:true,observedAt:Date.now(),
      result:{id:id!,clientOrderId:request.clientOrderId,status:filled===10?'unknown':'filled',filledQuantity:filled,
        averagePrice:request.limitPrice,averagePriceVerified:true,feeUsd:filled*request.limitPrice*.0002,timestamp:Date.now()}};
  };
  f.onNative((exchange,kind,value)=>{
    if(exchange!=='gate'||kind!=='open')return;
    const primary=f.store.data.orders.find(order=>order!==n.parent&&order.makerReduction?.activity==='active');
    if(primary)(value as AccountOpenOrder[]).push({id:'offline-maker-native',base,symbol,side:'sell',kind:'regular',reduceOnly:true,
      remainingQuantity:primary.request.quantity-primary.result!.filledQuantity,quantity:primary.request.quantity,limitPrice:primary.request.limitPrice} as AccountOpenOrder);
  });
  const preparation=await f.execution.prepareMakerClose(f.p);assert.ok(preparation);
  await f.serial(()=>f.execution.startMakerClose(f.p,'offline cumulative native Maker',preparation));await f.execution.waitMakerClose(f.p);
  assert.equal(f.makerCreates.length,1);assert.equal(f.makerCreates[0].postOnly,true);
  assert.deepEqual(f.creates.map(row=>row.qty),['30','10','20']);assert.equal(inspections,2);
  assert.equal(f.p.long.quantity,40);assert.equal(f.p.short.quantity,40);assert.equal(n.unknown.result!.status,'unknown');
  const firstFill=f.nativeEvents.indexOf('maker:cumulative:10'),secondFill=f.nativeEvents.indexOf('maker:cumulative:30'),posts=f.nativeEvents.reduce<number[]>((list,value,index)=>value==='POST:peer'?[...list,index]:list,[]);
  assert.ok(posts[1]>firstFill&&posts[1]<secondFill,'first confirmed partial fill is hedged before reading another Maker cumulative');
  assert.ok(posts[2]>secondFill);assert.equal(f.execution.hasNativeExitAuthority(f.p),true);
});

test('restored native tail final private mode GET must still honor a changed explicit permission',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.close());const n=nativeExitFixture(f);f.fillPeer();
  f.onAccount(()=>n.revoke());const beforeFees=f.p.feesUsd;
  assert.equal(await f.execution.repairNativeConfirmedTail(f.p,n.parent.request.clientOrderId),false);
  assert.equal(f.creates.length,0);assert.equal(f.p.short.quantity,100);assert.equal(f.p.feesUsd,beforeFees);
  assert.ok(f.nativeEvents.some(value=>value==='open:bybit'));assert.ok(f.accountReads()>0);
});

test('native reads finishing outside the eight-second logical window cannot grant a peer POST',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.close());const n=nativeExitFixture(f);f.fillPeer();
  let advanced=false;f.onNative((_exchange,kind)=>{if(kind==='account'&&!advanced){advanced=true;t.mock.timers.setTime(Date.now()+8001);}});
  assert.equal(await f.execution.repairNativeConfirmedTail(f.p,n.parent.request.clientOrderId),false);
  assert.equal(f.creates.length,0);assert.equal(f.p.long.quantity,70);assert.equal(f.p.short.quantity,100);
});

test('native worker drainage waits for its pending GET and prevents any financial continuation after it finishes',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.close());const n=nativeExitFixture(f);f.fillPeer();
  let release!:()=>void,started!:()=>void;const waiting=new Promise<void>(resolve=>{started=resolve;}),blocked=new Promise<void>(resolve=>{release=resolve;});
  const read=f.bybit.fetchAccount.bind(f.bybit);f.bybit.fetchAccount=async()=>{started();await blocked;return read();};
  const repair=f.execution.repairNativeConfirmedTail(f.p,n.parent.request.clientOrderId);await waiting;
  let drained=false;const drainage=f.execution.drainMakerCloses().then(()=>{drained=true;});await Promise.resolve();
  assert.equal(drained,false);assert.equal(f.execution.hasMakerClose(f.p),true);assert.equal(f.creates.length,0);
  release();await repair;await drainage;assert.equal(drained,true);assert.equal(f.execution.hasMakerClose(f.p),false);
  assert.equal(f.creates.length,0);assert.equal(f.p.long.quantity,70);assert.equal(f.p.short.quantity,100);
});

for(const field of ['request','receipt','booked-fee'] as const)test(`a parent ${field} mutation during native GET revokes the frozen peer scope`,async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.close());const n=nativeExitFixture(f);f.fillPeer();
  let changed=false;f.onNative((_exchange,kind)=>{if(kind!=='account'||changed)return;changed=true;
    if(field==='request')n.parent.request.quantity+=1;
    if(field==='receipt')n.parent.result!.feeUsd+=.001;
    if(field==='booked-fee')n.parent.executionEvidence!.bookedFeeUsd!+=.001;
  });
  const fees=f.p.feesUsd;assert.equal(await f.execution.repairNativeConfirmedTail(f.p,n.parent.request.clientOrderId),false);
  assert.equal(f.creates.length,0);assert.equal(f.p.short.quantity,100);assert.equal(f.p.feesUsd,fees);
});

test('a newly submitted peer with lost ACK freezes further native continuation while both old and new unknowns remain intact',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.close());const n=nativeExitFixture(f),old=structuredClone(n.unknown);f.loseAck();
  const fees=f.p.feesUsd;assert.equal(await f.execution.repairNativeConfirmedTail(f.p,n.parent.request.clientOrderId),false);
  assert.equal(f.creates.length,1);const peer=f.store.data.orders.find(order=>order!==n.unknown&&order.executionEvidence?.makerCloseParentClientId)!;
  assert.equal(peer.result!.status,'unknown');const newUnknown=structuredClone(peer);
  assert.equal(await f.execution.repairNativeConfirmedTail(f.p,n.parent.request.clientOrderId),false);assert.equal(f.creates.length,1);
  assert.equal(await f.execution.prepareMakerClose(f.p),undefined);assert.deepEqual(n.unknown,old);assert.deepEqual(peer,newUnknown);
  assert.equal(f.p.long.quantity,70);assert.equal(f.p.short.quantity,100);assert.equal(f.p.feesUsd,fees);
});

test('an unrevoked audit after native repair is evidence only and cannot resurrect permission on restart',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.close());const n=nativeExitFixture(f);f.fillPeer();
  assert.equal(await f.execution.repairNativeConfirmedTail(f.p,n.parent.request.clientOrderId),true);assert.equal(n.audit.revokedAt,undefined);
  const restarted=new Execution(f.store,f.execution.context);assert.equal(restarted.hasNativeExitAuthority(f.p),false);
  assert.equal(await restarted.repairNativeConfirmedTail(f.p,n.parent.request.clientOrderId),false);
  assert.equal(await restarted.prepareMakerClose(f.p),undefined);assert.equal(f.creates.length,1);assert.equal(f.makerCreates.length,0);
});

function refreshNativeExitBooks(f:ReturnType<typeof fixture>){
  for(const book of f.books.values())Object.assign(book,{timestamp:Date.now(),observedAt:Date.now(),fundingObservedAt:Date.now(),
    takerFeeAt:Date.now(),makerFeeAt:Date.now()});
}

test('fresh WS books do not extend native proof after the final Bybit mode GET exceeds eight seconds',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.close());const n=nativeExitFixture(f),old=structuredClone(n.unknown);f.fillPeer();
  let advanced=false;f.onAccount(()=>{if(advanced)return;advanced=true;t.mock.timers.setTime(Date.now()+8001);refreshNativeExitBooks(f);});
  const fees=f.p.feesUsd;assert.equal(await f.execution.repairNativeConfirmedTail(f.p,n.parent.request.clientOrderId),false);
  assert.equal(advanced,true);assert.ok(f.nativeEvents.some(value=>value==='open:bybit'),'native quantity and open proofs completed before the adapter final mode GET');
  assert.equal(f.creates.length,0);assert.equal(f.p.long.quantity,70);assert.equal(f.p.short.quantity,100);assert.equal(f.p.feesUsd,fees);assert.deepEqual(n.unknown,old);
  const intent=f.store.data.orders.find(order=>order!==n.unknown&&order.executionEvidence?.makerCloseParentClientId)!;
  assert.equal(intent.result!.status,'cancelled');assert.equal(intent.result!.rejectionCode,'MAKER_REDUCTION_PERMISSION_CHANGED');
});

test('fresh WS books cannot reuse expired native proof inside the primary Maker final adapter callback',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.close());const n=nativeExitFixture(f);f.fillPeer();
  assert.equal(await f.execution.repairNativeConfirmedTail(f.p,n.parent.request.clientOrderId),true);
  let finalPermission:boolean|undefined,callbacks=0;
  f.gate.submitMakerReduction=async(request,permit)=>{
    callbacks++;
    const journal=f.store.data.orders.find(order=>order.request===request)!;
    // Isolate native-proof expiry from the separate five-second resting-order
    // deadline: that shorter production guard would otherwise mask this bug.
    journal.makerReduction!.deadlineAt=Date.now()+60_000;
    t.mock.timers.setTime(Date.now()+8001);refreshNativeExitBooks(f);
    finalPermission=permit?.();
    if(finalPermission)throw new Error('stale native proof must never reach a primary Maker POST');
    return {id:'',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now(),
      rejectionCode:'MAKER_REDUCTION_PERMISSION_CHANGED',rejectionReason:'offline native proof expired before create'};
  };
  const preparation=await f.execution.prepareMakerClose(f.p);assert.ok(preparation);const fees=f.p.feesUsd;
  await f.serial(()=>f.execution.startMakerClose(f.p,'offline stale primary proof',preparation));await f.execution.waitMakerClose(f.p);
  assert.equal(callbacks,1);assert.equal(finalPermission,false);assert.equal(f.makerCreates.length,0);assert.equal(f.creates.length,1);
  const primary=f.store.data.orders.find(order=>order!==n.parent&&order.makerReduction)!;
  assert.equal(primary.makerReduction!.activity,'terminal');assert.equal(primary.result!.status,'cancelled');assert.equal(primary.result!.id,'');
  assert.equal(primary.result!.rejectionCode,'MAKER_REDUCTION_PERMISSION_CHANGED');assert.equal(isCurrentUnconfirmedOrder(primary,f.store.data.positions),false);
  assert.equal(f.p.long.quantity,70);assert.equal(f.p.short.quantity,70);assert.equal(f.p.feesUsd,fees);assert.equal(n.unknown.result!.status,'unknown');
});
