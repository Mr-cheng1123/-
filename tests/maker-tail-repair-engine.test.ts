import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {Engine,type SelectedMakerCloseRepairRequest} from '../src/core/engine.js';
import type {Store} from '../src/core/store.js';
import {defaultConfig} from '../src/shared/config.js';
import {createMakerCloseComparison,updateMakerCloseComparison} from '../src/shared/maker-close-comparison.js';
import type {AccountOpenOrder,AccountState,AppConfig,ExchangeAdapter,ExchangeId,JournalOrder,MakerReductionObservation,MarketSnapshot,OrderRequest,OrderResult,Position} from '../src/shared/types.js';

const NOW=Date.UTC(2026,9,10,6),base='ORCA',symbol='ORCA/USDT:USDT';
const parentId='legacy-orca-gate-maker',peerId='legacy-orca-bybit-peer';
let advanceFixtureClock:()=>void=()=>{};
type NativeRead={exchange:ExchangeId;request:OrderRequest;id?:string};
type InternalEngine={maintenanceTradingPending:boolean;credentialUpdatePending:boolean;sessionLivePermission:boolean;sessionExchanges?:Set<ExchangeId>;financialEpoch:number;
  stopping:boolean;
  onRealtimeSignal():void;scheduleRealtimeProfitExits(settled?:Position,delayMs?:number):void;
  managePositions(now:number):Promise<void>;exclusive<T>(fn:()=>Promise<T>):Promise<T>};

/** All account/quote/order reads and submissions are memory-only; no service, credentials or HTTP client is created. */
function fixture(options:{current?:boolean;permission?:boolean;peerExchange?:ExchangeId;nativePermit?:boolean}={}){
  const advanceClock=advanceFixtureClock,peerExchange=options.peerExchange??'bybit';
  const config:AppConfig={...structuredClone(defaultConfig),mode:'live',dataSource:'public',entryPolicy:'aligned',holdMode:'adaptive',
    exchanges:['gate',peerExchange],symbols:[base],maxOrderRetries:0,minExitProfitBps:10};
  const events:string[]=[],requests:Array<{exchange:ExchangeId;request:OrderRequest}>=[],nativeReads:NativeRead[]=[],executionReads:NativeRead[]=[],logs:unknown[][]=[],feeReads:ExchangeId[]=[];
  let saves=0,failSave=false,persistedData:Store['data']|undefined;
  let saveHook:(data:Store['data'])=>void=()=>{};
  const store={data:{version:1,config,positions:[],orders:[],logs:[],equity:[],killSwitch:false,fundingSeen:[]},
    save(){saves++;events.push('save');if(failSave)throw new Error('Memory durable save failed');saveHook(store.data);persistedData=structuredClone(store.data);},
    log(...args:unknown[]){logs.push(args);}} as unknown as Store;
  const accounts=new Map<ExchangeId,AccountState>(),quotes=new Map<ExchangeId,MarketSnapshot>();
  for(const exchange of config.exchanges){const isLong=exchange==='gate';
    accounts.set(exchange,{freeUsd:1000,equityUsd:1000,...(isLong?{positionMode:'single'}:{}),positions:[{
      base,symbol,side:isLong?'long':'short',quantity:options.current?44.5:isLong?43.5:43.6,entryPrice:2,
      markPrice:2,liquidationPrice:0,leverage:2,marginMode:'crossed',positionOpenedAt:NOW-60_000,
      ...(isLong?{positionId:'47123'}:{})}]});
    quotes.set(exchange,{exchange,base,symbol,source:'public',timestamp:Date.now(),observedAt:Date.now(),fundingObservedAt:Date.now(),
      bookTransport:'websocket',markPrice:2,indexPrice:2,fundingRate:isLong?0:.001,intervalHours:8,nextFundingTime:NOW+3_600_000,
      fundingHistory:[],bids:[{price:isLong?(options.current?2.2:2.006):1.998,quantity:1}],asks:[{price:isLong?(options.current?2.216:2.016):2,quantity:1}],
      quantityStep:.1,minQuantity:.1,minNotional:5,contractSize:isLong?.1:1,openInterestUsd:1e6,volume24hUsd:1e6,
      takerFeeRate:.0005,takerFeeAt:Date.now(),takerFeeSource:'exchange',makerFeeRate:.0002,makerFeeAt:Date.now(),makerFeeSource:'exchange'});
  }
  const oldMakerRequest:OrderRequest={clientOrderId:parentId,base,symbol,side:'sell',quantity:1,limitPrice:2.016,reduceOnly:true,postOnly:true};
  const oldPeerRequest:OrderRequest={clientOrderId:peerId,base,symbol,side:'buy',quantity:1,limitPrice:2,reduceOnly:true};
  const receipt=(request:OrderRequest,id:string,quantity:number,status:OrderResult['status']):OrderResult=>({id,clientOrderId:request.clientOrderId,
    status,filledQuantity:quantity,averagePrice:quantity?request.limitPrice:0,averagePriceVerified:true,
    feeUsd:quantity*request.limitPrice*(request.postOnly?.0002:.0005),timestamp:NOW-1000});
  const parent:JournalOrder={positionId:'orca-selected-repair',exchange:'gate',createdAt:NOW-3000,request:oldMakerRequest,
    result:receipt(oldMakerRequest,'48123',1,'filled'),makerReduction:{activity:'terminal',makerLeg:'long',deadlineAt:NOW-1000,
      bookedExecution:true,lastObservedAt:NOW-1000},
    executionEvidence:{version:1,method:'maker',role:'exit',batchId:'old-orca-maker-batch',bookedFeeUsd:2.016*.0002}};
  const peer:JournalOrder={positionId:parent.positionId,exchange:peerExchange,createdAt:NOW-2000,request:oldPeerRequest,
    result:receipt(oldPeerRequest,'old-bybit-native-id',.9,'partial'),
    executionEvidence:{version:1,method:'ioc',role:'exit-tail',batchId:'old-orca-peer-batch',bookedFeeUsd:.9*2*.0005}};
  // Native Bybit IOC GET proves terminal summary cash, but does not claim individual-fill price precision.
  if(peerExchange==='bybit')delete peer.result!.averagePriceVerified;
  const makers=new Map<string,{request:OrderRequest;id:string;booked:boolean}>();
  makers.set(parentId,{request:oldMakerRequest,id:parent.result!.id,booked:true});
  const accountReads=new Map<ExchangeId,number>(),accountReadTimes=new Map<ExchangeId,number[]>(),openReads=new Map<ExchangeId,number>();
  let accountHook:(exchange:ExchangeId,call:number,value:AccountState)=>Promise<AccountState>|AccountState=(_exchange,_call,value)=>value;
  let openHook:(exchange:ExchangeId,call:number)=>AccountOpenOrder[]=()=>[];
  let makerHook:(value:MakerReductionObservation)=>MakerReductionObservation=value=>value;
  let peerHook:(value:OrderResult)=>OrderResult=value=>value;
  let verifyHook:(value:OrderResult)=>Promise<OrderResult>|OrderResult=value=>value;
  let validateHook:(exchange:ExchangeId,request:OrderRequest)=>Promise<void>|void=()=>{};
  let postHook:(exchange:ExchangeId,request:OrderRequest)=>void=()=>{};
  let nativePermitHook:(exchange:ExchangeId,request:OrderRequest)=>void=()=>{};
  let nativePermitChecks=0;
  let receiptHook:(value:OrderResult)=>OrderResult=value=>value;
  let firstCurrentPeer=options.current===true,currentTailBlocked=false,zeroPeerReceipts=false,nativeFeesAvailable=true;
  const publish=()=>{for(const quote of quotes.values())Object.assign(quote,{timestamp:Date.now(),observedAt:Date.now(),fundingObservedAt:Date.now(),
    takerFeeAt:Date.now(),makerFeeAt:Date.now()});if(engine)engine.snapshots=[...quotes.values()];};
  const adapters=config.exchanges.map(exchange=>({id:exchange,supportsMakerReduction:()=>true,
    getExecutionSnapshot:()=>quotes.get(exchange),fetchSnapshots:async()=>[quotes.get(exchange)!],fetchExecutionSnapshots:async()=>{publish();return [quotes.get(exchange)!];},
    fetchAccount:async()=>{const call=(accountReads.get(exchange)??0)+1;accountReads.set(exchange,call);events.push(`account:${exchange}:${call}`);
      accountReadTimes.set(exchange,[...(accountReadTimes.get(exchange)??[]),Date.now()]);
      advanceClock();
      return structuredClone(await accountHook(exchange,call,structuredClone(accounts.get(exchange)!)));},
    fetchOpenOrders:async(requestedSymbol:string)=>{assert.equal(requestedSymbol,symbol);const call=(openReads.get(exchange)??0)+1;
      openReads.set(exchange,call);events.push(`open:${exchange}:${call}`);return structuredClone(openHook(exchange,call));},
    inspectMakerReduction:async(request:OrderRequest,id?:string):Promise<MakerReductionObservation>=>{
      nativeReads.push({exchange,request:structuredClone(request),id});events.push(`maker-get:${request.clientOrderId}`);
      const maker=makers.get(request.clientOrderId);assert.ok(maker);assert.deepEqual(request,maker.request);assert.equal(id,maker.id);
      if(!maker.booked){accounts.get(exchange)!.positions[0].quantity-=request.quantity;maker.booked=true;}
      return makerHook({activity:'terminal',executionVerified:true,observedAt:Date.now(),result:receipt(request,maker.id,request.quantity,'filled')});
    },
    inspectOrder:async(request:OrderRequest,id?:string):Promise<OrderResult>=>{
      nativeReads.push({exchange,request:structuredClone(request),id});events.push(`peer-get:${request.clientOrderId}`);
      assert.equal(exchange,peerExchange);const original=store.data.orders.find(order=>order.request.clientOrderId===request.clientOrderId);
      assert.ok(original?.result);assert.deepEqual(request,original.request);assert.equal(id,original.result.id);
      if(request.clientOrderId===peerId)assert.deepEqual(request,oldPeerRequest);
      return peerHook({...structuredClone(original.result),orderReadAt:Date.now()});
    },
    verifyOrderExecution:async(request:OrderRequest,id?:string):Promise<OrderResult>=>{
      executionReads.push({exchange,request:structuredClone(request),id});events.push(`execution-get:${request.clientOrderId}`);
      const original=store.data.orders.find(order=>order.request.clientOrderId===request.clientOrderId);
      assert.ok(original?.result);assert.deepEqual(request,original.request);assert.equal(id,original.result.id);
      return verifyHook({...structuredClone(original.result),averagePriceVerified:true,orderReadAt:Date.now()});
    },
    validateOrder:async(request:OrderRequest)=>{assert.equal(request.reduceOnly,true);assert.notEqual(request.postOnly,true);
      assert.equal(exchange,peerExchange,'A confirmed Gate Maker fill never authorizes a new Gate IOC');
      events.push(`validate:${request.quantity}`);await validateHook(exchange,request);},
    validateMakerReduction:async(request:OrderRequest)=>{assert.equal(request.reduceOnly,true);assert.equal(request.postOnly,true);},
    submitMakerReduction:async(request:OrderRequest,canSubmit?:()=>boolean):Promise<OrderResult>=>{
      assert.equal(options.current,true,'A scoped old tail repair never submits another Maker');assert.equal(exchange,'gate');
      assert.equal(canSubmit?.()??true,true);requests.push({exchange,request:structuredClone(request)});
      const id='current-orca-gate-native';makers.set(request.clientOrderId,{request:structuredClone(request),id,booked:false});
      return {id,clientOrderId:request.clientOrderId,status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:NaN,timestamp:Date.now()};
    },
    placeOrder:async(request:OrderRequest,canSubmit?:()=>boolean):Promise<OrderResult>=>{
      if(options.nativePermit){
        nativePermitHook(exchange,request);nativePermitChecks++;
        if(canSubmit?.()!==true)return {id:'',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,
          timestamp:Date.now(),rejectionCode:'ORDER_SUBMISSION_PERMISSION_CHANGED'};
      }
      assert.equal(exchange,peerExchange);assert.equal(request.reduceOnly,true);assert.notEqual(request.postOnly,true);
      assert.ok(request.quantity<=accounts.get(exchange)!.positions[0].quantity);requests.push({exchange,request:structuredClone(request)});
      events.push(`post:${exchange}:${request.quantity}`);const quantity=zeroPeerReceipts?0:firstCurrentPeer?.9:request.quantity;firstCurrentPeer=false;
      accounts.get(exchange)!.positions[0].quantity=Number((accounts.get(exchange)!.positions[0].quantity-quantity).toFixed(10));
      if(options.current&&!currentTailBlocked){currentTailBlocked=true;quotes.get(peerExchange)!.asks[0].quantity=.09;quotes.get(peerExchange)!.bids[0].quantity=.09;}
      postHook(exchange,request);const result={...receipt(request,`new-peer-${requests.length}`,quantity,
        quantity===request.quantity?'filled':quantity>0?'partial':'cancelled'),timestamp:Date.now()};
      advanceClock();return receiptHook(result);
    },
    fetchTradingFee:async()=>{feeReads.push(exchange);throw new Error('Repair cannot poll account trading fee rates');},
    cachedTradingFee:()=>nativeFeesAvailable?{takerFeeRate:.0005,takerFeeAt:Date.now(),takerFeeSource:'exchange' as const,
      makerFeeRate:.0002,makerFeeAt:Date.now(),makerFeeSource:'exchange' as const}:undefined,
    prepareTrading:async()=>{throw new Error('Repair cannot change leverage or account modes');},
    reconcileOrder:async()=>{throw new Error('Repair must GET the original, never general reconciliation/cancellation');},
    cancelOrder:async()=>{throw new Error('Repair cannot cancel an original order');},
    cancelMakerReduction:async()=>{throw new Error('Confirmed terminal parent needs no cancellation');},
    fetchFundingPayments:async()=>[],close:async()=>{}} as ExchangeAdapter));
  const engine=new Engine(store,options.permission!==false,{adapterFactory:()=>adapters,liveEnvironment:{ALLOW_LIVE_TRADING:'true',
    LIVE_TRADING_ACK:'I_UNDERSTAND_THE_RISKS',GATE_API_KEY:'MEMORY',GATE_API_SECRET:'MEMORY',BYBIT_API_KEY:'MEMORY',BYBIT_API_SECRET:'MEMORY',
    BITGET_API_KEY:'MEMORY',BITGET_API_SECRET:'MEMORY',BITGET_PASSPHRASE:'MEMORY'}});
  const p:Position={id:parent.positionId,base,mode:'live',entryPolicy:'aligned',holdMode:'adaptive',status:options.current?'open':'attention',
    openedAt:NOW-60_000,plannedExitAt:NOW+3_610_000,profitExitNotionalUsd:89,
    long:{exchange:'gate',symbol,side:'long',quantity:options.current?44.5:43.50000000000001,entryPrice:2,markPrice:2,feesUsd:.06,liquidationDistancePct:null},
    short:{exchange:peerExchange,symbol,side:'short',quantity:options.current?44.5:43.6,entryPrice:2,markPrice:2,feesUsd:.06,liquidationDistancePct:null},
    fundingUsd:.7,feesUsd:.12,transferCostUsd:.02,realizedSpreadPnlUsd:.35,spreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,
    fundingEvents:['old-confirmed-funding'],riskReasons:['old-confirmed-maker-peer-tail'],
    ...(!options.current?{closeRequestedAt:NOW-4000,closeProfitRequired:true,closePricing:'best-opposite' as const}:{}),
    profitExitPolicy:{firstFundingTime:NOW+3_600_000,earliestExitAt:NOW+3_610_000,minSpreadNetUsd:0,minCombinedNetUsd:.089,
      fundingChecks:config.exchanges.map(exchange=>({exchange,timestamp:NOW+3_600_000}))}};
  // This memory permission is established before adding historical attention records; no restored session is implicitly adopted.
  store.data.positions.push(p);if(!options.current)store.data.orders.push(parent,peer);publish();
  for(const exchange of config.exchanges){engine.accounts.set(exchange,structuredClone(accounts.get(exchange)!));const health=engine.health.find(h=>h.exchange===exchange)!;
    Object.assign(health,{status:'online',lastSuccess:Date.now(),accountStatus:'ready',accountUpdatedAt:Date.now()});}
  const request=():SelectedMakerCloseRepairRequest=>({acknowledgement:'REPAIR_SELECTED_MAKER_CLOSE_TAIL',positionId:p.id,parentClientOrderId:parentId,
    legacyPeerClientOrderIds:[peerId],expiresAt:Date.now()+30_000,expected:{base:p.base,openedAt:p.openedAt,longExchange:p.long.exchange,
      longSymbol:p.long.symbol,longQuantity:p.long.quantity,shortExchange:p.short.exchange,shortSymbol:p.short.symbol,shortQuantity:p.short.quantity}});
  const internal=engine as unknown as InternalEngine;
  // Model an already granted exact two-account session. Environment permission alone cannot authorize a repair.
  if(options.permission!==false){internal.sessionLivePermission=true;internal.sessionExchanges=new Set(config.exchanges);}
  return {engine,internal,store,p,parent,peer,accounts,quotes,adapters,events,requests,nativeReads,executionReads,accountReads,accountReadTimes,openReads,logs,feeReads,publish,request,
    repair:(input=request())=>engine.repairSelectedMakerClose(input),
    manage:()=>internal.exclusive(()=>internal.managePositions(Date.now())),
    onAccount(fn:typeof accountHook){accountHook=fn;},onOpen(fn:typeof openHook){openHook=fn;},onMaker(fn:typeof makerHook){makerHook=fn;},
    onPeer(fn:typeof peerHook){peerHook=fn;},onVerify(fn:typeof verifyHook){verifyHook=fn;},onValidate(fn:typeof validateHook){validateHook=fn;},onPost(fn:typeof postHook){postHook=fn;},
    onReceipt(fn:typeof receiptHook){receiptHook=fn;},
    onNativePermit(fn:typeof nativePermitHook){nativePermitHook=fn;},nativePermitChecks:()=>nativePermitChecks,
    failSave(){failSave=true;},saves:()=>saves,persistedData:()=>persistedData,onSave(fn:typeof saveHook){saveHook=fn;},
    setZeroPeerReceipts(value:boolean){zeroPeerReceipts=value;},
    dropNativeFees(){nativeFeesAvailable=false;for(const quote of quotes.values()){
      delete quote.takerFeeRate;delete quote.takerFeeAt;delete quote.takerFeeSource;
      delete quote.makerFeeRate;delete quote.makerFeeAt;delete quote.makerFeeSource;}},
    async createCurrentTail(){await internal.exclusive(()=>internal.managePositions(Date.now()));await engine.execution.waitMakerClose(p);},
    cacheNativeAccounts(){for(const exchange of config.exchanges){engine.accounts.set(exchange,structuredClone(accounts.get(exchange)!));
      Object.assign(engine.health.find(h=>h.exchange===exchange)!,{status:'online',lastSuccess:Date.now(),accountStatus:'ready',accountUpdatedAt:Date.now()});}},
  };
}
type Fixture=ReturnType<typeof fixture>;
test('selected Engine repair final native permit recognizes its own durable unsent intent',async t=>{
  memoryTime(t);const f=fixture({nativePermit:true});const original=structuredClone(f.store.data.orders);
  f.onNativePermit((_exchange,request)=>{
    const pending=f.store.data.orders.at(-1)!;
    assert.equal(pending.request,request);assert.equal(pending.result,undefined);
    assert.ok(f.persistedData()!.orders.some(order=>order.request.clientOrderId===request.clientOrderId&&!order.result),
      'Only an intent already recorded by the same operation reaches the final native check');
  });
  const outcome=await f.repair();assert.equal(outcome.repaired,true);assert.equal(f.requests.length,1);
  assert.equal(f.nativePermitChecks(),1);
  assert.equal(f.requests[0].request.quantity,.1);assert.equal(f.p.status,'open');
  assert.deepEqual(f.store.data.orders.slice(0,2).map(order=>order.result),original.map(order=>order.result));
});

function addUnknownAtNativeBoundary(f:Fixture,options:{otherPosition?:boolean;otherCoinSameContract?:boolean;unidentified?:boolean}={}){
  const request={...f.peer.request,clientOrderId:'foreign-original-unknown',
    ...(options.otherCoinSameContract?{base:'OTHER'}:{}),...(options.unidentified?{base:''}:{} )};
  const positionId=options.otherPosition||options.otherCoinSameContract||options.unidentified?'foreign-position':f.p.id;
  f.store.data.orders.push({positionId,exchange:f.peer.exchange,request,createdAt:Date.now(),
    result:{id:'foreign-native-unknown',clientOrderId:request.clientOrderId,status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now()}});
}
for(const [name,change] of [
  ['live account permission revoked',(f:Fixture)=>{f.internal.sessionLivePermission=false;}],
  ['native venue scope revoked',(f:Fixture)=>{f.internal.sessionExchanges=new Set(['gate']);}],
  ['live execution relocked',(f:Fixture)=>{Object.defineProperty(f.engine,'liveUnlocked',{get:()=>false});}],
  ['automatic entry restarted',(f:Fixture)=>{f.engine.autoEnabled=true;}],
  ['kill switch enabled',(f:Fixture)=>{f.store.data.killSwitch=true;}],
  ['graceful stopping begun',(f:Fixture)=>{f.internal.stopping=true;}],
  ['maintenance pending',(f:Fixture)=>{f.internal.maintenanceTradingPending=true;}],
  ['scope expires',(f:Fixture,t:TestContext)=>{t.mock.timers.setTime(Date.now()+30_001);f.publish();}],
  ['another unknown on this position',(f:Fixture)=>addUnknownAtNativeBoundary(f)],
  ['same coin unknown under another position ID',(f:Fixture)=>addUnknownAtNativeBoundary(f,{otherPosition:true})],
  ['same native contract unknown carrying another base',(f:Fixture)=>addUnknownAtNativeBoundary(f,{otherCoinSameContract:true})],
  ['unidentified original unknown',(f:Fixture)=>addUnknownAtNativeBoundary(f,{unidentified:true})],
  ['own pending intent already has a result',(f:Fixture)=>{f.store.data.orders.at(-1)!.result={...f.peer.result!,status:'unknown'};}],
  ['original maker cash changes',(f:Fixture)=>{f.parent.result!.feeUsd+=.01;}],
  ['original remaining quantity changes',(f:Fixture)=>{f.p.short.quantity+=.1;}],
] as const){test(`selected Engine tail final native permit vetoes ${name} after its own intent is saved`,async t=>{
  memoryTime(t);const f=fixture({nativePermit:true});let reached=false;
  f.onNativePermit(()=>{reached=true;change(f,t);});
  try{await f.repair();}catch{/* A revoked scoped operation may reject or finish without submitting. */}
  assert.equal(reached,true);assert.equal(f.nativePermitChecks(),1);assert.equal(f.requests.length,0);
  assert.equal(f.accounts.get('bybit')!.positions[0].quantity,43.6,'No native send means no counterpart fill');
  assert.notEqual(f.p.status,'open');
  for(const order of f.store.data.orders.filter(order=>order.request.clientOrderId==='foreign-original-unknown')){
    assert.equal(order.result!.status,'unknown');assert.equal(order.result!.id,'foreign-native-unknown');
  }
});}
function memoryTime(t:TestContext,timers=false){t.mock.timers.enable({apis:timers?['Date','setTimeout']:['Date'],now:NOW});advanceFixtureClock=()=>t.mock.timers.setTime(Date.now()+1);}
function assertNoSubmission(f:Fixture){assert.equal(f.requests.length,0);assert.equal(f.store.data.orders.length,2);}
async function refused(f:Fixture,input=f.request()){
  try{await f.repair(input);}catch{/* An explicit blocked repair may reject or return without posting. */}
  assertNoSubmission(f);
}
async function drainRepair(){for(let turn=0;turn<4;turn++)await new Promise<void>(resolve=>setImmediate(resolve));}
function observeRepair(f:Fixture,input=f.request()){
  const observed={done:false,error:undefined as unknown,result:undefined as Awaited<ReturnType<Fixture['repair']>>|undefined,
    completion:Promise.resolve()};
  observed.completion=f.repair(input).then(result=>{observed.result=result;observed.done=true;},error=>{observed.error=error;observed.done=true;});
  return observed;
}
function zeroFilledFixture(){
  const f=fixture();
  f.store.data.orders.splice(1);f.p.long.quantity=44.5;f.p.short.quantity=44.5;
  for(const account of f.accounts.values())account.positions[0].quantity=44.5;
  Object.assign(f.parent.result!,{status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,averagePriceVerified:true});
  f.parent.executionEvidence!.bookedFeeUsd=0;f.parent.makerReduction!.quantityStep=.1;
  f.onMaker(value=>({...value,result:structuredClone(f.parent.result!)}));
  const request=()=>({...f.request(),legacyPeerClientOrderIds:[]});
  return {...f,request,repair:(input=request())=>f.engine.repairSelectedMakerClose(input)};
}
type ZeroFixture=ReturnType<typeof zeroFilledFixture>;
async function refuseZero(f:ZeroFixture,input=f.request()){
  const count=f.store.data.orders.length;
  await assert.rejects(()=>f.repair(input));
  assert.equal(f.requests.length,0);assert.equal(f.store.data.orders.length,count);assert.notEqual(f.p.status,'open');
}

test('explicit native zero-fill Maker recovery reads original cash and fresh holdings, archives only the chosen intent and never enters a submit path',async t=>{
  memoryTime(t);const f=zeroFilledFixture(),other=structuredClone(f.p);other.id='unselected-historical-attention';other.base='OTHER';
  f.store.data.positions.push(other);
  const orders=structuredClone(f.store.data.orders),cash={fees:f.p.feesUsd,funding:f.p.fundingUsd,spread:f.p.realizedSpreadPnlUsd,
    long:structuredClone(f.p.long),short:structuredClone(f.p.short),fundingEvents:structuredClone(f.p.fundingEvents)};
  f.engine.execution.repairConfirmedMakerCloseTail=async()=>{throw new Error('Zero recovery must never enter a hedge-capable path');};
  const outcome=await f.repair();assert.equal(outcome.repaired,true);assert.equal(f.p.status,'open');assert.equal(other.status,'attention');
  assert.equal(f.requests.length,0);assert.deepEqual(f.store.data.orders,orders);assert.equal(f.feeReads.length,0);
  assert.deepEqual(f.nativeReads.map(read=>[read.request.clientOrderId,read.id]),[[parentId,'48123']]);
  for(const exchange of ['gate','bybit'] as const){assert.equal(f.accountReads.get(exchange),4);assert.equal(f.openReads.get(exchange),1);}
  assert.deepEqual({fees:f.p.feesUsd,funding:f.p.fundingUsd,spread:f.p.realizedSpreadPnlUsd,long:f.p.long,short:f.p.short,fundingEvents:f.p.fundingEvents},cash);
  assert.equal(f.p.closeRequestedAt,undefined);assert.equal(f.p.closeAttemptedAt,undefined);
  assert.equal(f.p.automaticCloseHistory!.length,1);assert.equal(f.p.automaticCloseHistory![0].requestedAt,NOW-4000);
  assert.equal(f.p.profitExitNotionalUsd,89);assert.equal(f.store.data.killSwitch,false);assert.equal(f.engine.autoEnabled,false);
});

for(const [name,change] of [
  ['empty native identity',(f:ZeroFixture)=>{f.parent.result!.id='';}],
  ['local client identity masquerading as native',(f:ZeroFixture)=>{f.parent.result!.id=parentId;}],
  ['unverified zero cash',(f:ZeroFixture)=>{f.parent.result!.averagePriceVerified=false;}],
  ['charged zero receipt',(f:ZeroFixture)=>{f.parent.result!.feeUsd=.001;f.parent.executionEvidence!.bookedFeeUsd=.001;}],
  ['unbooked zero receipt',(f:ZeroFixture)=>{f.parent.makerReduction!.bookedExecution=false;}],
  ['original from an earlier intent',(f:ZeroFixture)=>{f.p.closeRequestedAt=NOW-2000;}],
  ['linked peer on a zero Maker',(f:ZeroFixture)=>{f.store.data.orders.push(f.peer);f.peer.executionEvidence!.makerCloseParentClientId=parentId;}],
  ['unmatched positive holdings',(f:ZeroFixture)=>{f.p.short.quantity=44.6;}],
  ['later unknown Maker',(f:ZeroFixture)=>{const later=structuredClone(f.parent);later.createdAt=NOW-500;later.request.clientOrderId='later-unknown';
    later.result!.clientOrderId='later-unknown';later.result!.id='later-native';later.makerReduction!.activity='unknown';f.store.data.orders.push(later);} ],
  ['later hard rejection',(f:ZeroFixture)=>{const later=structuredClone(f.parent);later.createdAt=NOW-500;later.request.clientOrderId='later-rejected';
    later.result!.clientOrderId='later-rejected';later.result!.id='later-native';later.result!.rejectionCode='HARD_REJECTION';f.store.data.orders.push(later);} ],
] as const)test(`zero-fill selected recovery refuses ${name} without enabling management or submitting`,async t=>{
  memoryTime(t);const f=zeroFilledFixture();change(f);await refuseZero(f);
});

for(const [name,change] of [
  ['unknown original GET',(f:ZeroFixture)=>f.onMaker(value=>({...value,activity:'unknown',executionVerified:false,result:{...f.parent.result!,status:'unknown'}}))],
  ['GET execution not verified',(f:ZeroFixture)=>f.onMaker(value=>({...value,executionVerified:false,result:structuredClone(f.parent.result!)}))],
  ['GET native identity changed',(f:ZeroFixture)=>f.onMaker(value=>({...value,result:{...f.parent.result!,id:'foreign-native'}}))],
  ['GET reports a real fill',(f:ZeroFixture)=>f.onMaker(value=>({...value,result:{...f.parent.result!,status:'filled',filledQuantity:1,averagePrice:2,feeUsd:.0004}}))],
  ['GET zero average not verified',(f:ZeroFixture)=>f.onMaker(value=>({...value,result:{...f.parent.result!,averagePriceVerified:false}}))],
  ['fresh account quantity mismatch',(f:ZeroFixture)=>f.onAccount((exchange,_call,value)=>({...value,positions:value.positions.map(row=>({...row,quantity:exchange==='bybit'?44.6:44.5}))}))],
  ['actual native open order',(f:ZeroFixture)=>f.onOpen(()=>[{base,symbol,side:'sell',quantity:1,remainingQuantity:1,kind:'regular',id:'working-native'}])],
  ['config changes during native read',(f:ZeroFixture)=>f.onMaker(value=>{f.store.data.config={...f.store.data.config,minExitProfitBps:11};return {...value,result:structuredClone(f.parent.result!)};})],
  ['scope revoked during native read',(f:ZeroFixture)=>f.onMaker(value=>{f.internal.sessionExchanges=new Set(['gate']);return {...value,result:structuredClone(f.parent.result!)};})],
  ['own cash changes during native read',(f:ZeroFixture)=>f.onMaker(value=>{f.p.fundingUsd+=.01;return {...value,result:structuredClone(f.parent.result!)};})],
] as const)test(`zero-fill selected recovery rejects ${name} with no order and no manager promotion`,async t=>{
  memoryTime(t);const f=zeroFilledFixture();change(f);await refuseZero(f);
});

test('a zero-fill recovery persistence failure leaves the selected manager at attention and blocks new trading without changing original cash',async t=>{
  memoryTime(t);const f=zeroFilledFixture(),orders=structuredClone(f.store.data.orders),cash=[f.p.feesUsd,f.p.fundingUsd,f.p.realizedSpreadPnlUsd];
  f.failSave();await assert.rejects(()=>f.repair(),/Memory durable save failed/);
  assert.equal(f.p.status,'attention');assert.equal(f.store.data.killSwitch,true);assert.equal(f.requests.length,0);
  assert.deepEqual(f.store.data.orders,orders);assert.deepEqual([f.p.feesUsd,f.p.fundingUsd,f.p.realizedSpreadPnlUsd],cash);
});
function addControlledBybitZeroMaker(f:Fixture):JournalOrder{
  const request:OrderRequest={clientOrderId:'own-bybit-zero-maker',base,symbol,side:'buy',quantity:.2,limitPrice:1.998,reduceOnly:true,postOnly:true},
    createdAt=Date.now()-1500;
  const order:JournalOrder={positionId:f.p.id,exchange:'bybit',createdAt,request,
    result:{id:'own-bybit-zero-native',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,
      averagePriceVerified:true,feeUsd:0,timestamp:createdAt+300,rejectionCode:'EC_PerCancelRequest'},
    makerReduction:{activity:'terminal',makerLeg:'short',deadlineAt:createdAt+5000,submittedAt:createdAt+10,
      cancelRequestedAt:createdAt+100,lastObservedAt:createdAt+350,bookedExecution:true},
    executionEvidence:{version:1,method:'maker',role:'exit',batchId:`${f.p.id}:maker-close:${request.clientOrderId}`,bookedFeeUsd:0}};
  f.store.data.orders.push(order);return order;
}
const precisePeerAverage=1.999233830845772,roundedPeerAverage=1.99923383;
function useRoundedBybitPeer(f:Fixture){
  const result=f.peer.result!,oldFee=result.feeUsd,oldAverage=result.averagePrice;
  result.averagePrice=precisePeerAverage;result.feeUsd=result.filledQuantity*precisePeerAverage*.0005;
  f.peer.executionEvidence!.bookedFeeUsd=result.feeUsd;
  const pnlCorrection=result.filledQuantity*(oldAverage-precisePeerAverage);
  f.p.short.feesUsd+=result.feeUsd-oldFee;f.p.feesUsd+=result.feeUsd-oldFee;
  f.p.short.realizedPnlUsd=(f.p.short.realizedPnlUsd??0)+pnlCorrection;f.p.realizedSpreadPnlUsd+=pnlCorrection;
  f.onPeer(value=>value.clientOrderId===peerId?{...value,averagePrice:roundedPeerAverage}:value);
}
const oldBitgetPeerFee=.00001249,confirmedBitgetPeerFee=.000012498;
function bitgetFeeCorrectionFixture(){
  const f=fixture({peerExchange:'bitget'}),oldFee=f.peer.result!.feeUsd;
  f.peer.result={...f.peer.result!,status:'filled',filledQuantity:1,averagePriceVerified:true,feeUsd:oldBitgetPeerFee};
  f.peer.executionEvidence!.bookedFeeUsd=oldBitgetPeerFee;f.peer.executionEvidence!.makerCloseParentClientId=parentId;
  f.p.short.quantity=43.5;f.accounts.get('bitget')!.positions[0].quantity=43.5;
  f.p.short.feesUsd+=oldBitgetPeerFee-oldFee;f.p.feesUsd+=oldBitgetPeerFee-oldFee;
  f.parent.makerCloseComparison=createMakerCloseComparison({timestamp:NOW-3000,makerLeg:'long',longOppositePrice:2.006,
    shortOppositePrice:2,longTakerFeeRate:.0005,shortTakerFeeRate:.0005,originalOneLegNotionalUsd:89,peer:{exchange:'bitget',symbol}});
  updateMakerCloseComparison(f.parent,f.store.data.orders);
  f.onPeer(result=>({...result,averagePriceVerified:true,feeUsd:confirmedBitgetPeerFee}));
  f.onVerify(result=>({...result,feeUsd:confirmedBitgetPeerFee}));
  const feeRequest=():SelectedMakerCloseRepairRequest=>({...f.request(),feeCorrectionAcknowledgement:'RECONCILE_CONFIRMED_PEER_FEES',
    expectedPeerFeeCorrections:[{clientOrderId:peerId,bookedFeeUsd:oldBitgetPeerFee,confirmedFeeUsd:confirmedBitgetPeerFee}]});
  return {...f,feeRequest};
}

test('selected historical ORCA Maker 1 / peer .9 repairs only Bybit .1 and preserves original native cash',async t=>{
  memoryTime(t);const f=fixture(),originals=structuredClone([f.parent.request,f.parent.result,f.peer]),cash=structuredClone({
    funding:f.p.fundingUsd,fees:f.p.feesUsd,spread:f.p.realizedSpreadPnlUsd,transfer:f.p.transferCostUsd,events:f.p.fundingEvents});
  await f.repair();
  assert.deepEqual(f.requests.map(({exchange,request})=>[exchange,request.side,request.quantity,request.postOnly===true]),[['bybit','buy',.1,false]]);
  assert.deepEqual([f.parent.request,f.parent.result,f.peer],originals,'Original receipts/cash are evidence, never replayed or rewritten');
  assert.ok(Math.abs(f.p.long.quantity-43.5)<=Number.EPSILON*43.5*8);assert.equal(f.p.short.quantity,43.5);assert.equal(f.p.status,'open');
  const tail=f.store.data.orders.at(-1)!;assert.equal(tail.executionEvidence?.makerCloseParentClientId,parentId);
  assert.equal(tail.executionEvidence?.role,'exit-tail');assert.equal(tail.executionEvidence?.method,'ioc');
  assert.deepEqual(f.parent.makerReduction?.recoveredPeers?.clientOrderIds,[peerId]);
  assert.equal(f.p.fundingUsd,cash.funding);assert.equal(f.p.transferCostUsd,cash.transfer);assert.deepEqual(f.p.fundingEvents,cash.events);
  assert.ok(Math.abs(f.p.feesUsd-cash.fees-.1*2*.0005)<1e-12);assert.equal(f.p.realizedSpreadPnlUsd,cash.spread);
  assert.equal(f.nativeReads.filter(read=>read.exchange==='gate').length,1);assert.equal(f.nativeReads.filter(read=>read.exchange==='bybit').length,1);
  assert.equal(f.executionReads.length,0,'An exact original summary does not request extra execution evidence');
  assert.ok((f.openReads.get('gate')??0)>=1);assert.ok((f.openReads.get('bybit')??0)>=1);
  const post=f.events.findIndex(event=>event.startsWith('post:'));
  for(const exchange of ['gate','bybit']){assert.ok(f.events.slice(0,post).filter(event=>event.startsWith(`account:${exchange}:`)).length>=2);
    assert.ok(f.events.slice(post+1).filter(event=>event.startsWith(`account:${exchange}:`)).length>=2);}
});

test('a rounded Bybit peer summary uses complete original fills before repairing only the remaining .1 budget',async t=>{
  memoryTime(t);const f=fixture();useRoundedBybitPeer(f);
  const original=structuredClone(f.peer),cash={fees:f.p.feesUsd,spread:f.p.realizedSpreadPnlUsd};
  const outcome=await f.repair();assert.equal(outcome.repaired,true);assert.equal(f.p.status,'open');
  assert.deepEqual(f.executionReads,[{exchange:'bybit',request:original.request,id:original.result!.id}]);
  assert.deepEqual(f.requests.map(({exchange,request})=>[exchange,request.quantity,request.postOnly===true]),[['bybit',.1,false]]);
  assert.deepEqual(f.peer,original,'Precise GET evidence compares the frozen cash without rewriting the summary or booked receipt');
  assert.equal(f.p.realizedSpreadPnlUsd,cash.spread);assert.ok(Math.abs(f.p.feesUsd-cash.fees-.1*2*.0005)<1e-12);
  assert.equal(f.feeReads.length,0);
});

test('renewed matched budget-zero recovery verifies a rounded Bybit summary without another order or cash booking',async t=>{
  memoryTime(t);const f=fixture();useRoundedBybitPeer(f);f.onPost(()=>{f.accounts.get('bybit')!.positions[0].quantity=43.7;});
  const first=observeRepair(f);await first.completion;assert.ok(first.error);assert.equal(f.requests.length,1);assert.equal(f.p.status,'attention');
  f.accounts.get('bybit')!.positions[0].quantity=43.5;
  const original=structuredClone([f.peer,f.parent.request,f.parent.result]),cash={fees:f.p.feesUsd,spread:f.p.realizedSpreadPnlUsd,funding:f.p.fundingUsd},
    completedAt=f.parent.makerReduction!.hedgeCompletedAt,reads=f.executionReads.length;
  const outcome=await f.repair();assert.equal(outcome.repaired,true);assert.equal(f.p.status,'open');assert.equal(f.requests.length,1);
  assert.equal(f.executionReads.length,reads+1);assert.equal(f.executionReads.at(-1)!.request.clientOrderId,peerId);
  assert.deepEqual([f.peer,f.parent.request,f.parent.result],original);assert.equal(f.parent.makerReduction!.hedgeCompletedAt,completedAt);
  assert.deepEqual({fees:f.p.feesUsd,spread:f.p.realizedSpreadPnlUsd,funding:f.p.fundingUsd},cash);assert.equal(f.feeReads.length,0);
});

for(const [guard,change] of [
  ['actual fee mismatch',(result:OrderResult)=>({...result,feeUsd:result.feeUsd+.0001})],
  ['cumulative fill mismatch',(result:OrderResult)=>({...result,filledQuantity:.8})],
  ['wrong native identity',(result:OrderResult)=>({...result,id:'foreign-summary-native'})],
  ['wrong client identity',(result:OrderResult)=>({...result,clientOrderId:'foreign-summary-client'})],
  ['unknown terminal status',(result:OrderResult)=>({...result,status:'unknown' as const})],
  ['missing original read time',(result:OrderResult)=>{const value={...result};delete value.orderReadAt;return value;}],
  ['stale original read time',(result:OrderResult)=>({...result,orderReadAt:NOW-1})],
] as const){test(`a rounded peer summary with ${guard} cannot request full-fill verification or a new order`,async t=>{
  memoryTime(t);const f=fixture();useRoundedBybitPeer(f);f.onPeer(result=>change({...result,averagePrice:roundedPeerAverage}));
  const original=structuredClone(f.peer);await refused(f);assert.equal(f.executionReads.length,0);assert.deepEqual(f.peer,original);
});}

for(const [guard,change] of [
  ['a genuinely different average',(result:OrderResult)=>({...result,averagePrice:1.998})],
  ['different actual fees',(result:OrderResult)=>({...result,feeUsd:result.feeUsd+.0001})],
  ['different cumulative fill',(result:OrderResult)=>({...result,filledQuantity:.8})],
  ['wrong original native ID',(result:OrderResult)=>({...result,id:'foreign-execution-native'})],
  ['wrong original client ID',(result:OrderResult)=>({...result,clientOrderId:'foreign-execution-client'})],
  ['unknown execution',(result:OrderResult)=>({...result,status:'unknown' as const})],
  ['unverified average',(result:OrderResult)=>({...result,averagePriceVerified:false})],
  ['missing actual cash',(result:OrderResult)=>({...result,feeUsd:NaN})],
  ['missing independent read time',(result:OrderResult)=>{const value={...result};delete value.orderReadAt;return value;}],
  ['stale independent read time',(result:OrderResult)=>({...result,orderReadAt:NOW-1})],
] as const){test(`full Bybit fill evidence with ${guard} cannot override the original ledger`,async t=>{
  memoryTime(t);const f=fixture();useRoundedBybitPeer(f);f.onVerify(change);
  const original=structuredClone(f.peer),cash={fees:f.p.feesUsd,spread:f.p.realizedSpreadPnlUsd};await refused(f);
  assert.equal(f.executionReads.length,1);assert.deepEqual(f.peer,original);
  assert.deepEqual({fees:f.p.feesUsd,spread:f.p.realizedSpreadPnlUsd},cash);
});}

test('a rounded peer summary without a full-execution interface remains blocked',async t=>{
  memoryTime(t);const f=fixture();useRoundedBybitPeer(f);delete f.adapters.find(adapter=>adapter.id==='bybit')!.verifyOrderExecution;
  await refused(f);assert.equal(f.executionReads.length,0);
});

for(const guard of ['revoked account scope','expired acknowledgement'] as const){
  test(`a ${guard} during full-fill GET prevents the old-budget repair`,async t=>{
    memoryTime(t);const f=fixture();useRoundedBybitPeer(f);f.onVerify(result=>{
      if(guard==='revoked account scope')f.internal.sessionExchanges!.delete('bybit');
      else t.mock.timers.setTime(Date.now()+30_000);
      return result;
    });
    await refused(f);assert.equal(f.executionReads.length,1);assert.equal(f.accountReads.size,0);assert.equal(f.feeReads.length,0);
  });
}

for(const guard of ['non-Bybit peer','entry request','PostOnly peer'] as const){
  test(`a ${guard} cannot use the ordinary Bybit summary precision fallback`,async t=>{
    memoryTime(t);const f=fixture();useRoundedBybitPeer(f);
    if(guard==='non-Bybit peer')f.peer.exchange='gate';
    else if(guard==='entry request')f.peer.request.reduceOnly=false;
    else f.peer.request.postOnly=true;
    await refused(f);assert.equal(f.executionReads.length,0);assert.equal(f.feeReads.length,0);
  });
}

test('explicit matched Bitget peer fee correction books only 8e-9, preserves original fills and audits both native receipts',async t=>{
  memoryTime(t);const f=bitgetFeeCorrectionFixture(),originalPeer=structuredClone(f.peer),parentCash=structuredClone([f.parent.request,f.parent.result]),
    originalPosition=structuredClone(f.p),oldComparison=structuredClone(f.parent.makerCloseComparison),delta=confirmedBitgetPeerFee-oldBitgetPeerFee;
  let correctionSaved=false;
  f.onSave(data=>{if(data.orders.find(order=>order.request.clientOrderId===peerId)!.confirmedPeerFeeCorrections?.length){
    correctionSaved=true;
    for(const exchange of ['gate','bitget'] as const){assert.ok((f.accountReads.get(exchange)??0)>=2);assert.ok((f.openReads.get(exchange)??0)>=1);}
  }});
  const outcome=await f.repair(f.feeRequest());assert.equal(outcome.repaired,true);assert.equal(outcome.feeCorrectionCount,1);assert.equal(f.p.status,'open');
  assert.equal(correctionSaved,true);assert.equal(f.requests.length,0);assert.equal(f.store.data.orders.length,2);assert.equal(f.executionReads.length,1);
  assert.deepEqual(f.executionReads[0],{exchange:'bitget',request:originalPeer.request,id:originalPeer.result!.id});
  assert.equal(f.p.feesUsd,originalPosition.feesUsd+delta);assert.equal(f.p.short.feesUsd,originalPosition.short.feesUsd+delta);
  assert.deepEqual(f.p.long,originalPosition.long);assert.deepEqual({...f.p.short,feesUsd:originalPosition.short.feesUsd},originalPosition.short);
  assert.deepEqual({funding:f.p.fundingUsd,spread:f.p.realizedSpreadPnlUsd,transfer:f.p.transferCostUsd,events:f.p.fundingEvents},
    {funding:originalPosition.fundingUsd,spread:originalPosition.realizedSpreadPnlUsd,transfer:originalPosition.transferCostUsd,events:originalPosition.fundingEvents});
  assert.deepEqual(f.peer.result,{...originalPeer.result!,feeUsd:confirmedBitgetPeerFee});assert.deepEqual(f.peer.request,originalPeer.request);
  assert.equal(f.peer.executionEvidence!.bookedFeeUsd,confirmedBitgetPeerFee);assert.deepEqual([f.parent.request,f.parent.result],parentCash);
  const audit=f.peer.confirmedPeerFeeCorrections![0];assert.equal(f.peer.confirmedPeerFeeCorrections!.length,1);
  assert.equal(audit.previousBookedFeeUsd,oldBitgetPeerFee);assert.equal(audit.feeDeltaUsd,delta);assert.deepEqual(audit.originalResult,originalPeer.result);
  assert.deepEqual(audit.nativeResult,{...originalPeer.result!,averagePriceVerified:true,feeUsd:confirmedBitgetPeerFee,orderReadAt:audit.verifiedAt});
  assert.equal(f.parent.makerCloseComparison!.peerActualFeeUsd,confirmedBitgetPeerFee);assert.equal(f.parent.makerCloseComparison!.pairedComplete,true);
  assert.equal(f.parent.makerCloseComparison!.makerActualFeeUsd,oldComparison!.makerActualFeeUsd);
  assert.equal(f.parent.makerCloseComparison!.peerActualCashUsd,oldComparison!.peerActualCashUsd);
  assert.equal(f.persistedData()!.orders.find(order=>order.request.clientOrderId===peerId)!.confirmedPeerFeeCorrections!.length,1);
  assert.equal(f.feeReads.length,0);
});

test('replaying a completed explicit fee correction never books its delta or audit twice',async t=>{
  memoryTime(t);const f=bitgetFeeCorrectionFixture(),input=f.feeRequest();await f.repair(input);
  const known=structuredClone({position:f.p,orders:f.store.data.orders}),reads=f.executionReads.length;
  await assert.rejects(f.repair(input));assert.deepEqual({position:f.p,orders:f.store.data.orders},known);
  assert.equal(f.executionReads.length,reads);assert.equal(f.requests.length,0);assert.equal(f.feeReads.length,0);
});

for(const phase of ['initial order GET','independent execution GET'] as const){for(const [guard,change] of [
  ['unknown execution',(result:OrderResult)=>({...result,status:'unknown' as const})],
  ['wrong actual fee',(result:OrderResult)=>({...result,feeUsd:confirmedBitgetPeerFee+1e-10})],
  ['quantity differs within normal receipt EPS',(result:OrderResult)=>({...result,filledQuantity:1-Number.EPSILON})],
  ['average differs within normal receipt EPS',(result:OrderResult)=>({...result,averagePrice:2-Number.EPSILON*2})],
  ['different terminal status',(result:OrderResult)=>({...result,status:'partial' as const})],
  ['different native ID',(result:OrderResult)=>({...result,id:'foreign-bitget-native'})],
  ['different client ID',(result:OrderResult)=>({...result,clientOrderId:'foreign-bitget-client'})],
  ['unverified native average',(result:OrderResult)=>({...result,averagePriceVerified:false})],
  ['stale proof read',(result:OrderResult)=>({...result,orderReadAt:NOW-1})],
] as const){test(`fee correction ${phase} with ${guard} preserves old cash and refuses management recovery`,async t=>{
  memoryTime(t);const f=bitgetFeeCorrectionFixture();
  if(phase==='initial order GET')f.onPeer(result=>change({...result,averagePriceVerified:true,feeUsd:confirmedBitgetPeerFee}));
  else f.onVerify(result=>change({...result,feeUsd:confirmedBitgetPeerFee}));
  const known=structuredClone({position:f.p,orders:f.store.data.orders});await assert.rejects(f.repair(f.feeRequest()));
  assert.deepEqual({position:f.p,orders:f.store.data.orders},known);assert.equal(f.requests.length,0);assert.equal(f.accountReads.size,0);
  assert.equal(f.executionReads.length,phase==='initial order GET'?0:1);assert.equal(f.feeReads.length,0);
});}}

for(const guard of ['no fee opt-in','missing acknowledgement','duplicate correction','wrong booked snapshot','unlinked legacy peer',
  'missing full-execution interface','unverified original parent','nonzero tail budget','parent fill budget not exactly paired','closing status'] as const){
  test(`explicit fee correction with ${guard} cannot alter cash or create an order`,async t=>{
    memoryTime(t);const f=bitgetFeeCorrectionFixture(),input=f.feeRequest();
    if(guard==='no fee opt-in'){delete input.expectedPeerFeeCorrections;delete input.feeCorrectionAcknowledgement;}
    else if(guard==='missing acknowledgement')delete input.feeCorrectionAcknowledgement;
    else if(guard==='duplicate correction')input.expectedPeerFeeCorrections!.push({...input.expectedPeerFeeCorrections![0]});
    else if(guard==='wrong booked snapshot')input.expectedPeerFeeCorrections![0].bookedFeeUsd-=1e-10;
    else if(guard==='unlinked legacy peer')delete f.peer.executionEvidence!.makerCloseParentClientId;
    else if(guard==='missing full-execution interface')delete f.adapters.find(adapter=>adapter.id==='bitget')!.verifyOrderExecution;
    else if(guard==='unverified original parent')delete f.parent.result!.averagePriceVerified;
    else if(guard==='nonzero tail budget'){
      f.peer.result!.filledQuantity=.9;f.peer.result!.status='partial';f.p.short.quantity=43.6;f.accounts.get('bitget')!.positions[0].quantity=43.6;
      input.expected.shortQuantity=43.6;
    }else if(guard==='parent fill budget not exactly paired')f.peer.result!.filledQuantity=1-Number.EPSILON;
    else f.p.status='closing';
    const known=structuredClone({position:f.p,orders:f.store.data.orders});await assert.rejects(f.repair(input));
    assert.deepEqual({position:f.p,orders:f.store.data.orders},known);assert.equal(f.requests.length,0);assert.equal(f.executionReads.length,0);
    assert.equal(f.accountReads.size,0);assert.equal(f.feeReads.length,0);
  });
}

for(const guard of ['scope revoked during execution GET','acknowledgement expires during execution GET','pending financial epoch changes during execution GET',
  'native quantity mismatch','live open order'] as const){test(`fee correction refuses ${guard} before cash is committed`,async t=>{
  memoryTime(t);const f=bitgetFeeCorrectionFixture();
  if(guard==='native quantity mismatch')f.accounts.get('bitget')!.positions[0].quantity=43.7;
  else if(guard==='live open order')f.onOpen(exchange=>exchange==='bitget'?[{id:'live-peer-order',base,symbol,side:'buy',quantity:1,remainingQuantity:1,kind:'regular'}]:[]);
  else f.onVerify(result=>{
    if(guard==='scope revoked during execution GET')f.internal.sessionExchanges!.delete('bitget');
    else if(guard==='acknowledgement expires during execution GET')t.mock.timers.setTime(Date.now()+30_000);
    else f.internal.financialEpoch++;
    return {...result,feeUsd:confirmedBitgetPeerFee};
  });
  const known=structuredClone({position:f.p,orders:f.store.data.orders});await assert.rejects(f.repair(f.feeRequest()));
  assert.deepEqual({position:f.p,orders:f.store.data.orders},known);assert.equal(f.requests.length,0);assert.equal(f.executionReads.length,1);
  assert.equal(f.feeReads.length,0);
});}

test('a failed explicit correction save halts recovery and preserves the durable old fee plus the in-memory native audit',async t=>{
  memoryTime(t);const f=bitgetFeeCorrectionFixture();f.store.save();const durable=structuredClone(f.persistedData()),oldFees=f.p.feesUsd;
  f.failSave();await assert.rejects(f.repair(f.feeRequest()),/Memory durable save failed/);
  assert.equal(f.store.data.killSwitch,true);assert.equal(f.p.status,'attention');assert.equal(f.requests.length,0);assert.equal(f.store.data.orders.length,2);
  assert.deepEqual(f.persistedData(),durable);assert.equal(f.peer.result!.feeUsd,confirmedBitgetPeerFee);
  assert.equal(f.p.feesUsd,oldFees+(confirmedBitgetPeerFee-oldBitgetPeerFee));assert.equal(f.peer.confirmedPeerFeeCorrections!.length,1);
  assert.equal(f.engine.execution.canRepairConfirmedMakerCloseTail(f.p,parentId,[peerId]),false);assert.equal(f.feeReads.length,0);
});

test('an account failure after the saved fee correction durably retains its audit and stops management',async t=>{
  memoryTime(t);const f=bitgetFeeCorrectionFixture();f.onAccount((exchange,call,value)=>{
    if(exchange==='bitget'&&call===3)value.positions[0].quantity=43.7;return value;
  });
  await assert.rejects(f.repair(f.feeRequest()));assert.equal(f.p.status,'attention');assert.equal(f.store.data.killSwitch,true);
  assert.equal(f.requests.length,0);assert.equal(f.store.data.orders.length,2);assert.equal(f.peer.result!.feeUsd,confirmedBitgetPeerFee);
  const persisted=f.persistedData()!;assert.equal(persisted.killSwitch,true);assert.equal(persisted.positions[0].status,'attention');
  assert.equal(persisted.positions[0].feesUsd,f.p.feesUsd);assert.equal(persisted.orders[1].confirmedPeerFeeCorrections!.length,1);
  assert.equal(f.feeReads.length,0);
});

test('fee-correction schema requires explicit paired acknowledgement and finite exact fee snapshots',async t=>{
  memoryTime(t);const f=bitgetFeeCorrectionFixture(),{selectedMakerCloseRepairSchema}=await import('../src/server-input.js'),input=f.feeRequest();
  assert.equal(selectedMakerCloseRepairSchema.safeParse(input).success,true);
  for(const value of [{...input,feeCorrectionAcknowledgement:undefined},{...f.request(),feeCorrectionAcknowledgement:'RECONCILE_CONFIRMED_PEER_FEES'},
    {...input,expectedPeerFeeCorrections:[]},{...input,expectedPeerFeeCorrections:[{...input.expectedPeerFeeCorrections![0],confirmedFeeUsd:NaN}]},
    {...input,expectedPeerFeeCorrections:[{...input.expectedPeerFeeCorrections![0],allowAnyFee:true}]}])
    assert.equal(selectedMakerCloseRepairSchema.safeParse(value).success,false);
});

test('an exactly identified own-cancelled Bybit zero Maker does not block repairing only the original .1 peer budget',async t=>{
  memoryTime(t);const f=fixture(),cancelled=addControlledBybitZeroMaker(f),original=structuredClone(cancelled);
  const outcome=await f.repair();assert.equal(outcome.repaired,true);assert.equal(f.p.status,'open');
  assert.deepEqual(f.requests.map(({exchange,request})=>[exchange,request.quantity,request.postOnly===true]),[['bybit',.1,false]]);
  assert.equal(f.store.data.orders.at(-1)!.executionEvidence!.makerCloseParentClientId,parentId);
  assert.deepEqual(cancelled,original,'Recognizing our zero Maker cancellation preserves its native rejection and all original evidence');
  assert.equal(f.p.short.quantity,43.5);assert.equal(f.feeReads.length,0);
});

test('an own-cancelled zero Maker allows a renewed matched budget-zero account recovery with no new order',async t=>{
  memoryTime(t);const f=fixture();f.onPost(()=>{f.accounts.get('bybit')!.positions[0].quantity=43.7;});
  const first=observeRepair(f);await first.completion;assert.ok(first.error);assert.equal(f.p.status,'attention');assert.equal(f.requests.length,1);
  f.accounts.get('bybit')!.positions[0].quantity=43.5;const cancelled=addControlledBybitZeroMaker(f),original=structuredClone(cancelled),
    cash={fees:f.p.feesUsd,funding:f.p.fundingUsd,spread:f.p.realizedSpreadPnlUsd},completedAt=f.parent.makerReduction!.hedgeCompletedAt;
  const outcome=await f.repair();assert.equal(outcome.repaired,true);assert.equal(f.p.status,'open');assert.equal(f.requests.length,1);
  assert.deepEqual(cancelled,original);assert.equal(f.parent.makerReduction!.hedgeCompletedAt,completedAt);
  assert.deepEqual({fees:f.p.feesUsd,funding:f.p.fundingUsd,spread:f.p.realizedSpreadPnlUsd},cash);assert.equal(f.feeReads.length,0);
});

test('a fully booked own-cancelled Bybit partial Maker pair allows renewed original budget-zero recovery without another trade',async t=>{
  memoryTime(t);const f=fixture();f.onPost(()=>{f.accounts.get('bybit')!.positions[0].quantity=43.7;});
  const first=observeRepair(f);await first.completion;assert.ok(first.error);assert.equal(f.p.status,'attention');assert.equal(f.requests.length,1);
  f.accounts.get('bybit')!.positions[0].quantity=43.5;
  const tailClientId=f.store.data.orders.at(-1)!.request.clientOrderId,partial=addControlledBybitZeroMaker(f),quantity=.1;
  partial.request.clientOrderId='own-bybit-partial-maker';partial.result!.clientOrderId=partial.request.clientOrderId;
  partial.result!.id='own-bybit-partial-native';partial.result!.status='partial';partial.result!.filledQuantity=quantity;
  partial.result!.averagePrice=partial.request.limitPrice;partial.result!.feeUsd=quantity*partial.request.limitPrice*.0002;
  partial.executionEvidence!.bookedFeeUsd=partial.result!.feeUsd;
  partial.executionEvidence!.batchId=`${f.p.id}:maker-close:${partial.request.clientOrderId}`;
  partial.makerReduction!.hedgeCompletedAt=Date.now()-1;
  const peerRequest:OrderRequest={clientOrderId:'paired-gate-ioc-peer',base,symbol,side:'sell',quantity,limitPrice:2.006,reduceOnly:true},
    peer:JournalOrder={positionId:f.p.id,exchange:'gate',createdAt:partial.createdAt+400,request:peerRequest,
      result:{id:'paired-gate-ioc-native',clientOrderId:peerRequest.clientOrderId,status:'filled',filledQuantity:quantity,
        averagePrice:peerRequest.limitPrice,averagePriceVerified:true,feeUsd:quantity*peerRequest.limitPrice*.0005,timestamp:partial.createdAt+500},
      executionEvidence:{version:1,method:'ioc',role:'exit-tail',batchId:'paired-gate-ioc-batch',
        makerCloseParentClientId:partial.request.clientOrderId,bookedFeeUsd:quantity*peerRequest.limitPrice*.0005}};
  f.store.data.orders.push(peer);
  // Both native fills are already booked: retained quantities and fees cannot remain at the zero-fill fixture values.
  const shortPnl=quantity*(f.p.short.entryPrice-partial.result!.averagePrice),longPnl=quantity*(peer.result!.averagePrice-f.p.long.entryPrice);
  f.p.short.quantity=43.4;f.p.long.quantity=43.4;
  f.p.short.feesUsd+=partial.result!.feeUsd;f.p.long.feesUsd+=peer.result!.feeUsd;
  f.p.short.realizedPnlUsd=(f.p.short.realizedPnlUsd??0)+shortPnl;f.p.long.realizedPnlUsd=(f.p.long.realizedPnlUsd??0)+longPnl;
  f.p.realizedSpreadPnlUsd+=shortPnl+longPnl;f.p.feesUsd+=partial.result!.feeUsd+peer.result!.feeUsd;
  for(const account of f.accounts.values())account.positions[0].quantity=43.4;
  const originalPair=structuredClone([partial,peer]),cash={fees:f.p.feesUsd,funding:f.p.fundingUsd,spread:f.p.realizedSpreadPnlUsd,
    longFees:f.p.long.feesUsd,shortFees:f.p.short.feesUsd,longPnl:f.p.long.realizedPnlUsd,shortPnl:f.p.short.realizedPnlUsd},
    completedAt=f.parent.makerReduction!.hedgeCompletedAt,reads=f.nativeReads.length;
  assert.equal(f.engine.execution.canRepairConfirmedMakerCloseTail(f.p,parentId,[peerId]),true);
  const outcome=await f.repair();assert.equal(outcome.repaired,true);assert.equal(f.p.status,'open');assert.equal(f.requests.length,1);
  assert.deepEqual([f.p.long.quantity,f.p.short.quantity],[43.4,43.4]);assert.deepEqual([partial,peer],originalPair);
  assert.deepEqual(f.nativeReads.slice(reads).map(read=>read.request.clientOrderId).sort(),[parentId,peerId,tailClientId].sort());
  assert.equal(f.parent.makerReduction!.hedgeCompletedAt,completedAt);
  assert.deepEqual({fees:f.p.feesUsd,funding:f.p.fundingUsd,spread:f.p.realizedSpreadPnlUsd,
    longFees:f.p.long.feesUsd,shortFees:f.p.short.feesUsd,longPnl:f.p.long.realizedPnlUsd,shortPnl:f.p.short.realizedPnlUsd},cash);
  assert.equal(f.feeReads.length,0);
});

for(const [guard,change] of [
  ['missing own cancel marker',(order:JournalOrder)=>{delete order.makerReduction!.cancelRequestedAt;}],
  ['missing native submission marker',(order:JournalOrder)=>{delete order.makerReduction!.submittedAt;}],
  ['cancel marker precedes original submission',(order:JournalOrder)=>{order.makerReduction!.cancelRequestedAt=order.createdAt;}],
  ['observation precedes own cancellation',(order:JournalOrder)=>{order.makerReduction!.lastObservedAt=order.makerReduction!.cancelRequestedAt!-1;}],
  ['unknown execution',(order:JournalOrder)=>{order.result!.status='unknown';}],
  ['unknown activity',(order:JournalOrder)=>{order.makerReduction!.activity='unknown';}],
  ['positive partial fill with unverified native average',(order:JournalOrder)=>{order.result!.status='partial';order.result!.filledQuantity=.1;
    order.result!.averagePrice=order.request.limitPrice;order.result!.averagePriceVerified=false;
    order.result!.feeUsd=.1*order.request.limitPrice*.0002;order.executionEvidence!.bookedFeeUsd=order.result!.feeUsd;}],
  ['ordinary IOC cancellation',(order:JournalOrder)=>{order.request.postOnly=false;order.executionEvidence!.method='ioc';}],
  ['entry role cancellation',(order:JournalOrder)=>{order.executionEvidence!.role='entry';}],
  ['unrelated hard refusal',(order:JournalOrder)=>{order.result!.rejectionCode='EC_MarketOrderCannotBePostOnly';}],
  ['unverified native average',(order:JournalOrder)=>{order.result!.averagePriceVerified=false;}],
  ['missing booked cash',(order:JournalOrder)=>{delete order.executionEvidence!.bookedFeeUsd;}],
  ['nonzero paid fee',(order:JournalOrder)=>{order.result!.feeUsd=.0001;order.executionEvidence!.bookedFeeUsd=.0001;}],
  ['wrong client receipt identity',(order:JournalOrder)=>{order.result!.clientOrderId='foreign-zero-maker-client';}],
  ['missing native order identity',(order:JournalOrder)=>{order.result!.id='';}],
  ['native identity aliases the original peer',(order:JournalOrder,f:Fixture)=>{order.result!.id=f.peer.result!.id;}],
] as const){test(`a Bybit zero cancellation with ${guard} cannot authorize a scoped tail POST or resume management`,async t=>{
  memoryTime(t);const f=fixture(),cancelled=addControlledBybitZeroMaker(f);change(cancelled,f);
  const original=structuredClone(cancelled),cash={fees:f.p.feesUsd,funding:f.p.fundingUsd,spread:f.p.realizedSpreadPnlUsd},
    pending=observeRepair(f);await pending.completion;
  assert.ok(pending.error);assert.equal(f.requests.length,0);assert.equal(f.store.data.orders.length,3);assert.equal(f.p.status,'attention');
  assert.deepEqual([f.p.long.quantity,f.p.short.quantity],[43.50000000000001,43.6]);assert.deepEqual(cancelled,original);
  assert.deepEqual({fees:f.p.feesUsd,funding:f.p.fundingUsd,spread:f.p.realizedSpreadPnlUsd},cash);assert.equal(f.feeReads.length,0);
});}

for(const linkage of ['journal-parent','recovered-peer'] as const){
  test(`${linkage} peer is independently GET verified when the request supplies no legacy IDs`,async t=>{
    memoryTime(t);const f=fixture();
    if(linkage==='journal-parent')f.peer.executionEvidence!.makerCloseParentClientId=parentId;
    else f.parent.makerReduction!.recoveredPeers={verifiedAt:NOW-500,clientOrderIds:[peerId]};
    const input=f.request();delete input.legacyPeerClientOrderIds;
    const outcome=await f.repair(input);assert.equal(outcome.repaired,true);
    assert.equal(f.nativeReads.filter(read=>read.request.clientOrderId===peerId).length,1,'A saved parent association does not replace a fresh original GET');
    assert.deepEqual(f.requests.map(({exchange,request})=>[exchange,request.quantity]),[['bybit',.1]]);
  });
  test(`${linkage} peer with missing original native cash blocks repair even without legacy IDs`,async t=>{
    memoryTime(t);const f=fixture();
    if(linkage==='journal-parent')f.peer.executionEvidence!.makerCloseParentClientId=parentId;
    else f.parent.makerReduction!.recoveredPeers={verifiedAt:NOW-500,clientOrderIds:[peerId]};
    const input=f.request();delete input.legacyPeerClientOrderIds;f.onPeer(result=>({...result,feeUsd:NaN}));await refused(f,input);
    assert.equal(f.nativeReads.filter(read=>read.request.clientOrderId===peerId).length,1);
  });
}

for(const [name,change] of [
  ['wrong native parent ID',(f:Fixture)=>f.onMaker(o=>({...o,result:{...o.result,id:'different-gate-native'}}))],
  ['wrong native parent client ID',(f:Fixture)=>f.onMaker(o=>({...o,result:{...o.result,clientOrderId:'foreign-client'}}))],
  ['parent cumulative quantity changed',(f:Fixture)=>f.onMaker(o=>({...o,result:{...o.result,filledQuantity:.9,status:'partial'}}))],
  ['parent cash missing',(f:Fixture)=>f.onMaker(o=>({...o,result:{...o.result,feeUsd:NaN}}))],
  ['parent execution price unverified',(f:Fixture)=>f.onMaker(o=>({...o,result:{...o.result,averagePriceVerified:false}}))],
  ['active parent',(f:Fixture)=>f.onMaker(o=>({...o,activity:'active',result:{...o.result,status:'unknown'}}))],
  ['unknown parent',(f:Fixture)=>f.onMaker(o=>({...o,activity:'unknown',executionVerified:false,result:{...o.result,status:'unknown'}}))],
  ['cached no-ID zero refusal cannot prove this filled parent',(f:Fixture)=>f.onMaker(o=>({...o,result:{...o.result,id:'',status:'cancelled',filledQuantity:0,
    averagePrice:0,feeUsd:0,rejectionCode:'GATE_MAKER_POST_ONLY_WOULD_TAKE'}}))],
  ['parent original not found',(f:Fixture)=>f.onMaker(()=>{throw new Error('Memory original not found');})],
  ['wrong peer native ID',(f:Fixture)=>f.onPeer(r=>({...r,id:'different-bybit-native'}))],
  ['peer cumulative quantity changed',(f:Fixture)=>f.onPeer(r=>({...r,filledQuantity:.8}))],
  ['peer cash missing',(f:Fixture)=>f.onPeer(r=>({...r,feeUsd:NaN}))],
  ['unknown peer',(f:Fixture)=>f.onPeer(r=>({...r,status:'unknown'}))],
  ['foreign-position legacy peer',(f:Fixture)=>{f.peer.positionId='foreign-position';}],
  ['legacy peer already belongs to another Maker',(f:Fixture)=>{f.peer.executionEvidence!.makerCloseParentClientId='foreign-parent';}],
  ['peer booked cash absent',(f:Fixture)=>{delete f.peer.executionEvidence!.bookedFeeUsd;}],
  ['parent booked cash absent',(f:Fixture)=>{delete f.parent.executionEvidence!.bookedFeeUsd;}],
  ['unconfirmed additional old order',(f:Fixture)=>{f.store.data.orders.push({...structuredClone(f.peer),request:{...f.peer.request,clientOrderId:'unconfirmed-other'},
    result:{...f.peer.result!,id:'another-native',clientOrderId:'unconfirmed-other',status:'unknown'}});}],
] as const){test(`selected tail repair refuses ${name} without a POST`,async t=>{
  memoryTime(t);const f=fixture();change(f);const count=f.store.data.orders.length;
  try{await f.repair();}catch{}
  assert.equal(f.requests.length,0);assert.equal(f.store.data.orders.length,count);
});}

for(const [name,change] of [
  ['active regular order',(f:Fixture)=>f.onOpen(exchange=>exchange==='bybit'?[{id:'active-native',base,symbol,side:'buy',quantity:.1,
    remainingQuantity:.1,reduceOnly:true,kind:'regular'}]:[])],
  ['active conditional close-all',(f:Fixture)=>f.onOpen(exchange=>exchange==='gate'?[{id:'conditional-native',base,symbol,quantity:0,
    remainingQuantity:0,kind:'conditional'}]:[])],
  ['open-order response failure',(f:Fixture)=>f.onOpen(()=>{throw new Error('Memory incomplete open orders');})],
  ['actual quantity mismatch',(f:Fixture)=>f.accounts.get('bybit')!.positions[0].quantity=43.7],
  ['two reads disagree on quantity',(f:Fixture)=>f.onAccount((exchange,call,value)=>{if(exchange==='bybit'&&call===2)value.positions[0].quantity=43.7;return value;})],
  ['two reads disagree on native PID',(f:Fixture)=>f.onAccount((exchange,call,value)=>{if(exchange==='gate'&&call===2)value.positions[0].positionId='different-pid';return value;})],
  ['two reads disagree on opening cycle',(f:Fixture)=>f.onAccount((exchange,call,value)=>{if(exchange==='bybit'&&call===2)value.positions[0].positionOpenedAt=NOW-1000;return value;})],
  ['ambiguous native split',(f:Fixture)=>f.accounts.get('gate')!.positions[0].splitPositionCount=2],
  ['duplicate native side',(f:Fixture)=>f.accounts.get('bybit')!.positions.push(structuredClone(f.accounts.get('bybit')!.positions[0]))],
] as const){test(`selected tail repair refuses ${name} without a POST`,async t=>{memoryTime(t);const f=fixture();change(f);await refused(f);});}

for(const [name,change] of [
  ['automatic entry enabled',(f:Fixture)=>{f.engine.autoEnabled=true;}],
  ['kill switch',(f:Fixture)=>{f.store.data.killSwitch=true;}],
  ['maintenance authorization pending',(f:Fixture)=>{f.internal.maintenanceTradingPending=true;}],
  ['credentials changing',(f:Fixture)=>{f.internal.credentialUpdatePending=true;}],
  ['durable save failure',(f:Fixture)=>f.failSave()],
] as const){test(`selected tail repair refuses ${name} without a POST`,async t=>{memoryTime(t);const f=fixture();change(f);await refused(f);});}

test('a locked live session cannot acquire repair permission from the scoped request',async t=>{memoryTime(t);const f=fixture({permission:false});await refused(f);});

test('environment access without an explicit live account scope cannot authorize a historical tail repair',async t=>{
  memoryTime(t);const f=fixture();f.internal.sessionLivePermission=false;f.internal.sessionExchanges=undefined;
  assert.equal(f.engine.liveUnlocked,true,'The independent environment switch remains enabled');await refused(f);
  assert.equal(f.nativeReads.length,0,'A request acknowledgement cannot adopt an old session');
});

for(const [name,change] of [
  ['missing acknowledgement',(input:SelectedMakerCloseRepairRequest)=>{delete (input as Partial<SelectedMakerCloseRepairRequest>).acknowledgement;}],
  ['expired scope',(input:SelectedMakerCloseRepairRequest)=>{input.expiresAt=NOW;}],
  ['different parent scope',(input:SelectedMakerCloseRepairRequest)=>{input.parentClientOrderId='foreign-parent';}],
  ['different holding quantity',(input:SelectedMakerCloseRepairRequest)=>{input.expected.shortQuantity=43.7;}],
  ['different opening cycle',(input:SelectedMakerCloseRepairRequest)=>{input.expected.openedAt=NOW-1000;}],
  ['unselected peer not linked to parent',(input:SelectedMakerCloseRepairRequest)=>{input.legacyPeerClientOrderIds=[];}],
] as const){test(`selected tail repair rejects ${name}`,async t=>{memoryTime(t);const f=fixture(),input=f.request();change(input);await refused(f,input);});}

test('scope expiry during awaited native validation prevents a tail POST',async t=>{
  memoryTime(t);const f=fixture(),input=f.request();f.onValidate(()=>{t.mock.timers.setTime(input.expiresAt+1);f.publish();});
  await refused(f,input);assert.ok(f.events.some(event=>event.startsWith('validate:')),'The final guard must be tested after native validation');
  assert.equal(f.engine.execution.hasPendingMakerCloseTail(f.p),false,'An expired scope that never submitted cannot create a continuation session');
});

for(const [name,change] of [
  ['original parent request price',(f:Fixture)=>{f.parent.request.limitPrice=2.015;}],
  ['original parent native identity',(f:Fixture)=>{f.parent.result!.id='changed-after-get';}],
  ['original parent complete booked cash',(f:Fixture)=>{f.parent.result!.feeUsd=.001;f.parent.executionEvidence!.bookedFeeUsd=.001;}],
  ['original peer request price',(f:Fixture)=>{f.peer.request.limitPrice=2.01;}],
  ['original peer native identity',(f:Fixture)=>{f.peer.result!.id='changed-after-get';}],
  ['original peer complete booked cash',(f:Fixture)=>{f.peer.result!.feeUsd=.001;f.peer.executionEvidence!.bookedFeeUsd=.001;}],
  ['position entry basis',(f:Fixture)=>{f.p.long.entryPrice=1.9;}],
  ['original long leg object',(f:Fixture)=>{f.p.long={...f.p.long};}],
  ['original short leg object',(f:Fixture)=>{f.p.short={...f.p.short};}],
  ['frozen profit exit policy',(f:Fixture)=>{f.p.profitExitPolicy!.minCombinedNetUsd=.1;}],
  ['position holding scope',(f:Fixture)=>{f.p.long.quantity=43.4;f.p.short.quantity=43.5;}],
  ['kill after native validation',(f:Fixture)=>{f.store.data.killSwitch=true;}],
  ['maintenance after native validation',(f:Fixture)=>{f.internal.maintenanceTradingPending=true;}],
] as const){test(`scope changes to ${name} during native validation prevent a tail POST`,async t=>{
  memoryTime(t);const f=fixture();f.onValidate(()=>change(f));await refused(f);
  assert.ok(f.events.some(event=>event.startsWith('validate:')),'Exercise the final boundary after complete original GET/account proofs');
});}

test('a successful IOC with inconsistent later native holdings stays attention',async t=>{
  memoryTime(t);const f=fixture();f.onPost(()=>{f.accounts.get('bybit')!.positions[0].quantity=43.6;});
  try{await f.repair();}catch{}
  assert.equal(f.requests.length,1);assert.equal(f.p.status,'attention');assert.equal(f.p.fundingUsd,.7);
  assert.equal(f.store.data.orders.at(-1)!.result!.filledQuantity,.1,'The actual confirmed cash survives a failed account reconciliation');
});

test('a native tail receipt 500 ms ahead of local account time waits for two genuinely post-receipt GETs',{timeout:3000},async t=>{
  memoryTime(t,true);const f=fixture();f.onReceipt(value=>({...value,timestamp:value.timestamp+500}));
  const original=structuredClone([f.parent.request,f.parent.result,f.peer]),pending=observeRepair(f);await drainRepair();
  assert.equal(pending.done,false);assert.equal(f.requests.length,1);assert.equal(f.p.status,'closing');
  for(const exchange of ['gate','bybit'] as const)assert.equal(f.accountReads.get(exchange),3);
  t.mock.timers.tick(499);await drainRepair();assert.equal(pending.done,false);
  for(const exchange of ['gate','bybit'] as const)assert.equal(f.accountReads.get(exchange),3,'Receipt time cannot be treated as an account read time');
  t.mock.timers.tick(1);await drainRepair();await pending.completion;
  assert.equal(pending.error,undefined);assert.equal(pending.result!.repaired,true);assert.equal(f.p.status,'open');
  assert.deepEqual(f.requests.map(({exchange,request})=>[exchange,request.quantity]),[['bybit',.1]]);
  const tail=f.store.data.orders.at(-1)!;
  for(const exchange of ['gate','bybit'] as const){
    assert.equal(f.accountReads.get(exchange),5);
    assert.ok(f.accountReadTimes.get(exchange)!.slice(-2).every(at=>at>tail.result!.timestamp));
    assert.ok(f.accountReadTimes.get(exchange)![3]-f.accountReadTimes.get(exchange)![2]>=500);
  }
  assert.deepEqual([f.parent.request,f.parent.result,f.peer],original);assert.equal(f.feeReads.length,0);
});

test('only the known pre-fill peer quantity may settle after 500 ms and restore management without another order',{timeout:3000},async t=>{
  memoryTime(t,true);const f=fixture();let settleAt=Infinity;
  f.onPost(()=>{settleAt=Date.now()+500;});
  f.onAccount((exchange,call,value)=>{if(exchange==='bybit'&&call>=3&&Date.now()<settleAt)value.positions[0].quantity=43.6;return value;});
  const cash={fees:f.p.feesUsd,funding:f.p.fundingUsd,spread:f.p.realizedSpreadPnlUsd},pending=observeRepair(f);await drainRepair();
  assert.equal(pending.done,false);assert.equal(f.requests.length,1);assert.equal(f.p.short.quantity,43.5);
  t.mock.timers.tick(499);await drainRepair();
  for(const exchange of ['gate','bybit'] as const)assert.equal(f.accountReads.get(exchange),3);
  t.mock.timers.tick(1);await drainRepair();await pending.completion;
  assert.equal(pending.error,undefined);assert.equal(f.p.status,'open');assert.equal(f.p.long.quantity,43.50000000000001);
  assert.equal(f.p.short.quantity,43.5);assert.equal(f.requests.length,1);
  for(const exchange of ['gate','bybit'] as const){assert.equal(f.accountReads.get(exchange),5);
    assert.ok(f.accountReadTimes.get(exchange)![3]-f.accountReadTimes.get(exchange)![2]>=500);}
  assert.ok(Math.abs(f.p.feesUsd-cash.fees-.1*2*.0005)<1e-12);
  assert.equal(f.p.fundingUsd,cash.funding);assert.equal(f.p.realizedSpreadPnlUsd,cash.spread);assert.equal(f.feeReads.length,0);
});

test('a permanently old known peer quantity exhausts three post-action reads while retaining the confirmed .1 cash',{timeout:3000},async t=>{
  memoryTime(t,true);const f=fixture();f.onPost(()=>{f.accounts.get('bybit')!.positions[0].quantity=43.6;});
  const pending=observeRepair(f);await drainRepair();assert.equal(pending.done,false);
  for(let retry=0;retry<2;retry++){
    t.mock.timers.tick(499);await drainRepair();
    for(const exchange of ['gate','bybit'] as const)assert.equal(f.accountReads.get(exchange),3+retry);
    t.mock.timers.tick(1);await drainRepair();
  }
  await pending.completion;assert.ok(pending.error);assert.equal(f.p.status,'attention');assert.equal(f.requests.length,1);
  assert.equal(f.p.short.quantity,43.5);assert.equal(f.store.data.orders.at(-1)!.result!.filledQuantity,.1);
  for(const exchange of ['gate','bybit'] as const)assert.equal(f.accountReads.get(exchange),5);
  t.mock.timers.tick(10_000);await drainRepair();assert.equal(f.requests.length,1);assert.equal(f.feeReads.length,0);
  for(const exchange of ['gate','bybit'] as const)assert.equal(f.accountReads.get(exchange),5,'A bounded settlement failure cannot become a polling loop');
});

for(const [guard,change] of [
  ['native PID',(f:Fixture,value:AccountState)=>{value.positions[0].positionId='foreign-pid';}],
  ['native side',(f:Fixture,value:AccountState)=>{value.positions[0].side='long';}],
  ['native split',(f:Fixture,value:AccountState)=>{value.positions[0].splitPositionCount=2;}],
  ['foreign quantity',(f:Fixture,value:AccountState)=>{value.positions[0].quantity=43.7;}],
  ['unknown new receipt',(f:Fixture)=>{f.store.data.orders.at(-1)!.result!.status='unknown';}],
  ['changed original cash',(f:Fixture)=>{f.parent.result!.feeUsd+=.0001;f.parent.executionEvidence!.bookedFeeUsd=f.parent.result!.feeUsd;}],
  ['changed new cash',(f:Fixture)=>{const tail=f.store.data.orders.at(-1)!;tail.result!.feeUsd+=.0001;tail.executionEvidence!.bookedFeeUsd=tail.result!.feeUsd;}],
  ['revoked account permission',(f:Fixture)=>{f.internal.sessionExchanges=new Set(['gate']);}],
] as const){test(`post-action ${guard} fails immediately instead of starting a settlement retry`,{timeout:3000},async t=>{
  memoryTime(t,true);const f=fixture();
  f.onAccount((exchange,call,value)=>{if(exchange==='bybit'&&call===3)change(f,value);return value;});
  const pending=observeRepair(f);await drainRepair();
  assert.equal(pending.done,true);assert.ok(pending.error);assert.equal(f.p.status,'attention');assert.equal(f.requests.length,1);
  for(const exchange of ['gate','bybit'] as const)assert.equal(f.accountReads.get(exchange),3);
  t.mock.timers.tick(1500);await drainRepair();
  for(const exchange of ['gate','bybit'] as const)assert.equal(f.accountReads.get(exchange),3);
  assert.equal(f.requests.length,1);assert.equal(f.feeReads.length,0);
});}

test('an expired selected repair scope cannot start another account round after a confirmed tail fill',{timeout:3000},async t=>{
  memoryTime(t,true);const f=fixture(),input=f.request();input.expiresAt=Date.now()+100;
  f.onAccount((exchange,call,value)=>{if(exchange==='bybit'&&call>=3)value.positions[0].quantity=43.6;return value;});
  const pending=observeRepair(f,input);await drainRepair();assert.equal(pending.done,false);assert.equal(f.requests.length,1);
  t.mock.timers.tick(500);await drainRepair();await pending.completion;
  assert.ok(pending.error);assert.equal(f.p.status,'attention');assert.equal(f.p.short.quantity,43.5);
  for(const exchange of ['gate','bybit'] as const)assert.equal(f.accountReads.get(exchange),3,'The original acknowledgement cannot authorize a new post-expiry GET round');
  assert.equal(f.requests.length,1);assert.equal(f.feeReads.length,0);
});

test('renewing a matched zero-budget repair independently verifies every receipt and reopens without any additional order',{timeout:3000},async t=>{
  memoryTime(t,true);
  for(const completionRecorded of [true,false]){
    t.mock.timers.setTime(NOW);const f=fixture();f.onPost(()=>{f.accounts.get('bybit')!.positions[0].quantity=43.6;});
    const first=observeRepair(f);await drainRepair();
    for(let retry=0;retry<2;retry++){t.mock.timers.tick(500);await drainRepair();}
    await first.completion;assert.ok(first.error);assert.equal(f.p.status,'attention');assert.equal(f.requests.length,1);
    assert.ok(Number.isFinite(f.parent.makerReduction!.hedgeCompletedAt),'The original real .1 hedge records its completion');
    if(!completionRecorded)delete f.parent.makerReduction!.hedgeCompletedAt;
    const completedAt=f.parent.makerReduction!.hedgeCompletedAt;
    f.accounts.get('bybit')!.positions[0].quantity=43.5;
    const originals=structuredClone(f.store.data.orders.map(order=>({request:order.request,result:order.result,bookedFee:order.executionEvidence?.bookedFeeUsd}))),
      cash={fees:f.p.feesUsd,funding:f.p.fundingUsd,spread:f.p.realizedSpreadPnlUsd},reads=f.nativeReads.length;
    const outcome=await f.repair();assert.equal(outcome.repaired,true);assert.equal(f.p.status,'open');
    assert.equal(f.requests.length,1);assert.equal(f.p.long.quantity,43.50000000000001);assert.equal(f.p.short.quantity,43.5);
    assert.deepEqual(f.nativeReads.slice(reads).map(read=>read.request.clientOrderId).sort(),f.store.data.orders.map(order=>order.request.clientOrderId).sort());
    assert.deepEqual(f.store.data.orders.map(order=>({request:order.request,result:order.result,bookedFee:order.executionEvidence?.bookedFeeUsd})),originals);
    assert.equal(f.parent.makerReduction!.hedgeCompletedAt,completedAt,'A no-trade account recheck cannot change the original hedge completion time');
    assert.equal(Object.hasOwn(f.parent.makerReduction!,'hedgeCompletedAt'),completionRecorded,'A missing historical completion time must stay absent');
    assert.deepEqual({fees:f.p.feesUsd,funding:f.p.fundingUsd,spread:f.p.realizedSpreadPnlUsd},cash);assert.equal(f.feeReads.length,0);
  }
});

test('a post-action identity failure durably saves attention alongside the truthful filled tail cash',{timeout:3000},async t=>{
  memoryTime(t,true);const f=fixture(),originals=structuredClone([f.parent.request,f.parent.result,f.peer]),
    cash={fees:f.p.feesUsd,funding:f.p.fundingUsd,spread:f.p.realizedSpreadPnlUsd};
  f.onPost(()=>{f.accounts.get('bybit')!.positions[0].quantity=43.7;});
  const pending=observeRepair(f);await drainRepair();await pending.completion;
  assert.ok(pending.error);assert.equal(f.p.status,'attention');assert.equal(f.requests.length,1);
  const persisted=f.persistedData()!,savedPosition=persisted.positions.find(position=>position.id===f.p.id)!,tail=persisted.orders.at(-1)!;
  assert.equal(savedPosition.status,'attention');assert.deepEqual(savedPosition.riskReasons,f.p.riskReasons);
  assert.deepEqual([savedPosition.long.quantity,savedPosition.short.quantity],[43.50000000000001,43.5]);
  assert.equal(savedPosition.feesUsd,f.p.feesUsd);assert.ok(Math.abs(savedPosition.feesUsd-cash.fees-.1*2*.0005)<1e-12);
  assert.equal(savedPosition.fundingUsd,cash.funding);assert.equal(savedPosition.realizedSpreadPnlUsd,cash.spread);
  assert.equal(tail.result!.filledQuantity,.1);assert.equal(tail.result!.feeUsd,tail.executionEvidence!.bookedFeeUsd);
  assert.equal(tail.executionEvidence!.makerCloseParentClientId,parentId);
  assert.deepEqual([f.parent.request,f.parent.result,f.peer],originals);assert.equal(f.feeReads.length,0);
  t.mock.timers.tick(1500);await drainRepair();assert.equal(f.requests.length,1);
});

test('failure to save final repair attention activates the kill switch and exposes the save error without losing prior cash',{timeout:3000},async t=>{
  memoryTime(t,true);const f=fixture();let finalSaveAttempted=false;
  f.onPost(()=>{f.accounts.get('bybit')!.positions[0].quantity=43.7;});
  f.onSave(data=>{
    const position=data.positions.find(value=>value.id===f.p.id)!;
    if(position.status==='attention'&&position.riskReasons.some(reason=>reason.includes('恢复管理仍待账户或保存核验'))){
      finalSaveAttempted=true;throw new Error('Memory final attention persistence failed');
    }
  });
  const pending=observeRepair(f);await drainRepair();await pending.completion;
  assert.equal(finalSaveAttempted,true);assert.match(String(pending.error),/Memory final attention persistence failed/);
  assert.equal(f.store.data.killSwitch,true);assert.equal(f.p.status,'attention');assert.equal(f.requests.length,1);
  const saved=f.persistedData()!,savedPosition=saved.positions.find(position=>position.id===f.p.id)!,tail=saved.orders.at(-1)!;
  assert.deepEqual([savedPosition.long.quantity,savedPosition.short.quantity],[f.p.long.quantity,f.p.short.quantity]);
  assert.equal(savedPosition.feesUsd,f.p.feesUsd);assert.equal(tail.result!.filledQuantity,.1);
  assert.equal(tail.result!.feeUsd,tail.executionEvidence!.bookedFeeUsd);
  assert.deepEqual(tail.request,f.store.data.orders.at(-1)!.request);
  assert.equal(f.engine.execution.canRepairConfirmedMakerCloseTail(f.p,parentId,[peerId]),false);
  t.mock.timers.tick(1500);await drainRepair();assert.equal(f.requests.length,1);assert.equal(f.feeReads.length,0);
});

test('three scoped known-zero IOC receipts retain a session tail and a 500 ms wake retries only the remaining old Maker budget',async t=>{
  memoryTime(t);const f=fixture(),cash={funding:f.p.fundingUsd,fees:f.p.feesUsd,spread:f.p.realizedSpreadPnlUsd};f.setZeroPeerReceipts(true);
  const outcome=await f.repair();assert.equal(outcome.repaired,false);assert.equal(f.p.status,'closing');
  assert.deepEqual(f.requests.map(({exchange,request})=>[exchange,request.quantity]),[['bybit',.1],['bybit',.1],['bybit',.1]]);
  assert.equal(f.engine.execution.hasPendingMakerCloseTail(f.p),true);
  assert.deepEqual(f.store.data.orders.slice(2).map(order=>[order.result!.status,order.result!.filledQuantity,order.result!.feeUsd]),
    [['cancelled',0,0],['cancelled',0,0],['cancelled',0,0]]);
  assert.deepEqual({funding:f.p.fundingUsd,fees:f.p.feesUsd,spread:f.p.realizedSpreadPnlUsd},cash);
  f.setZeroPeerReceipts(false);t.mock.timers.setTime(Date.now()+501);f.publish();f.cacheNativeAccounts();await f.manage();
  assert.deepEqual(f.requests.map(({exchange,request})=>[exchange,request.quantity]),[['bybit',.1],['bybit',.1],['bybit',.1],['bybit',.1]]);
  assert.equal(f.engine.execution.hasPendingMakerCloseTail(f.p),false);assert.equal(f.p.short.quantity,43.5);
  assert.ok(f.store.data.orders.slice(2).every(order=>order.executionEvidence?.makerCloseParentClientId===parentId));
  assert.ok(Math.abs(f.p.feesUsd-cash.fees-.1*2*.0005)<1e-12);
});

test('historical attention without a current-session registry never creates automatic tail requests',async t=>{
  memoryTime(t);const f=fixture();assert.equal(f.engine.execution.hasPendingMakerCloseTail(f.p),false);
  await f.manage();assertNoSubmission(f);assert.equal(f.nativeReads.length,0);
});

test('current-session confirmed Maker tail is repaired before positive carry and a now-low profit gate',async t=>{
  memoryTime(t);const f=fixture({current:true});f.p.fundingUsd=0;f.p.feesUsd=.001;f.p.realizedSpreadPnlUsd=0;
  await f.createCurrentTail();
  assert.equal(f.engine.execution.hasPendingMakerCloseTail(f.p),true,JSON.stringify({events:f.events,requests:f.requests,position:f.p,orders:f.store.data.orders}));assert.equal(f.p.long.quantity,43.5);assert.equal(f.p.short.quantity,43.6);
  assert.deepEqual(f.requests.map(({exchange,request})=>[exchange,request.quantity]),[['gate',1],['bybit',1]]);
  const realParent=f.store.data.orders.find(order=>order.makerReduction)!;
  f.quotes.get('gate')!.bids[0].price=1.99;f.quotes.get('gate')!.asks[0].price=2;
  f.quotes.get('bybit')!.asks[0]={price:2,quantity:1};f.quotes.get('bybit')!.bids[0]={price:1.998,quantity:1};
  t.mock.timers.setTime(NOW+2000);f.publish();f.cacheNativeAccounts();
  await f.manage();await f.engine.execution.waitMakerClose(f.p);
  assert.deepEqual(f.requests.map(({exchange,request})=>[exchange,request.quantity]),[['gate',1],['bybit',1],['bybit',.1]]);
  assert.equal(f.store.data.orders.at(-1)!.executionEvidence?.makerCloseParentClientId,realParent.request.clientOrderId);
  assert.equal(f.p.long.quantity,43.5);assert.equal(f.p.short.quantity,43.5);assert.equal(f.engine.execution.hasPendingMakerCloseTail(f.p),false);
});

async function flushRealtime(f:Fixture){
  for(let turn=0;turn<4;turn++)await new Promise<void>(resolve=>setImmediate(resolve));
  await f.internal.exclusive(async()=>{});
}
async function prepareRealtimeTail(){
  const f=fixture({current:true});f.p.fundingUsd=0;f.p.feesUsd=.001;f.p.realizedSpreadPnlUsd=0;
  await f.createCurrentTail();assert.equal(f.engine.execution.hasPendingMakerCloseTail(f.p),true);
  assert.equal(f.p.long.quantity,43.5);assert.equal(f.p.short.quantity,43.6);
  // The original profitable common action retains its existing on-demand fee guard. Measure only tail wakes below.
  f.feeReads.length=0;
  f.quotes.get('gate')!.bids[0].price=1.99;f.quotes.get('gate')!.asks[0].price=2;
  f.quotes.get('bybit')!.asks[0]={price:2,quantity:1};f.quotes.get('bybit')!.bids[0]={price:1.998,quantity:1};
  f.dropNativeFees();f.adapters.find(adapter=>adapter.id==='gate')!.supportsMakerReduction=()=>false;f.publish();
  // The actual Engine built both its continuing-close set and Execution's pending tail while running=false.
  // Enable only the realtime wake; no polling loop or implicit restored-session adoption runs in this fixture.
  f.engine.running=true;return f;
}

test('settled realtime wake repairs a confirmed .1 tail after 500 ms despite low common profit, missing native fees and positive carry',{timeout:2000},async t=>{
  memoryTime(t,true);const f=await prepareRealtimeTail();t.after(()=>f.engine.stop());
  const start=Date.now(),retryAt=f.engine.execution.makerCloseTailRetryAfter(f.p),reads=new Map(f.accountReads);
  const original=structuredClone(f.store.data.orders.map(order=>({request:order.request,result:order.result,bookedFee:order.executionEvidence?.bookedFeeUsd}))),
    parent=f.store.data.orders.find(order=>order.makerReduction)!,cash={fees:f.p.feesUsd,funding:f.p.fundingUsd,spread:f.p.realizedSpreadPnlUsd};
  f.internal.scheduleRealtimeProfitExits(f.p,50);
  t.mock.timers.tick(retryAt-start-1);await flushRealtime(f);assert.equal(f.requests.length,2);
  assert.deepEqual(f.accountReads,reads,'A completion callback must wait for the original tail cooldown');
  t.mock.timers.tick(1);t.mock.timers.tick(0);await flushRealtime(f);
  assert.deepEqual(f.requests.map(({exchange,request})=>[exchange,request.quantity]),[['gate',1],['bybit',1],['bybit',.1]]);
  assert.equal(f.feeReads.length,0,'Already-confirmed tail repair cannot prepare private contract fee rates');
  for(const exchange of ['gate','bybit'] as const)assert.equal(f.accountReads.get(exchange),(reads.get(exchange)??0)+1);
  assert.ok(Date.now()-start<f.store.data.config.pollIntervalMs,'The realtime timer repairs before the ordinary account poll');
  assert.deepEqual(f.store.data.orders.slice(0,2).map(order=>({request:order.request,result:order.result,bookedFee:order.executionEvidence?.bookedFeeUsd})),
    original,'The realtime tail cannot rebook its original Maker/peer cash');
  assert.ok(Math.abs(f.p.feesUsd-cash.fees-.1*2*.0005)<1e-12);assert.equal(f.p.fundingUsd,cash.funding);assert.equal(f.p.realizedSpreadPnlUsd,cash.spread);
  assert.equal(f.store.data.orders.at(-1)!.executionEvidence?.makerCloseParentClientId,parent.request.clientOrderId);
  assert.equal(f.p.long.quantity,43.5);assert.equal(f.p.short.quantity,43.5);
});

test('multiple WebSocket signals before the 500 ms tail deadline do not repeat native account or fee reads',{timeout:2000},async t=>{
  memoryTime(t,true);const f=await prepareRealtimeTail();t.after(()=>f.engine.stop());
  const reads=new Map(f.accountReads),start=Date.now(),retryAt=f.engine.execution.makerCloseTailRetryAfter(f.p);
  for(let signal=0;signal<9;signal++){
    f.publish();f.internal.onRealtimeSignal();t.mock.timers.tick(50);await flushRealtime(f);
    assert.deepEqual(f.accountReads,reads);assert.equal(f.feeReads.length,0);assert.equal(f.requests.length,2);
  }
  t.mock.timers.tick(retryAt-Date.now()-1);f.publish();f.internal.onRealtimeSignal();await flushRealtime(f);
  assert.equal(Date.now()-start,499);assert.deepEqual(f.accountReads,reads);assert.equal(f.feeReads.length,0);
  t.mock.timers.tick(1);t.mock.timers.tick(0);await flushRealtime(f);
  assert.equal(f.requests.length,3);assert.equal(f.requests.at(-1)!.request.quantity,.1);
  for(const exchange of ['gate','bybit'] as const)assert.equal(f.accountReads.get(exchange),(reads.get(exchange)??0)+1);
  assert.equal(f.feeReads.length,0);
});

test('realtime tail wake retains native quantity, its own financial proof, original intent and unresolved-session guards',{timeout:4000},async t=>{
  memoryTime(t,true);
  for(const guard of ['actual-mismatch','account-read-failure','account-read-own-financial','changed-intent','revoked-account-scope','unknown-peer','historical-attention'] as const){
    t.mock.timers.setTime(NOW);
    const f=guard==='historical-attention'?fixture():await prepareRealtimeTail();
    try{
      f.engine.running=true;const before=f.requests.length,quantities=[f.p.long.quantity,f.p.short.quantity];
      if(guard==='actual-mismatch')f.accounts.get('bybit')!.positions[0].quantity=43.7;
      else if(guard==='account-read-failure')f.onAccount((_exchange,call,value)=>{if(call===1)throw new Error('Memory native account unavailable');return value;});
      else if(guard==='account-read-own-financial')f.onAccount(async(exchange,_call,value)=>{
        await Promise.resolve();if(exchange==='gate'){f.internal.financialEpoch++;f.p.fundingUsd+=.001;}return value;
      });
      else if(guard==='changed-intent')f.p.closeRequestedAt=Date.now()+1;
      else if(guard==='revoked-account-scope')f.internal.sessionExchanges=new Set(['gate']);
      else if(guard==='unknown-peer'){f.store.data.orders.find(order=>order.exchange==='bybit')!.result!.status='unknown';f.p.status='attention';}
      f.publish();f.internal.onRealtimeSignal();t.mock.timers.tick(501);t.mock.timers.tick(0);await flushRealtime(f);
      assert.equal(f.requests.length,before,guard);assert.deepEqual([f.p.long.quantity,f.p.short.quantity],quantities,guard);
      assert.equal(f.feeReads.length,0,guard);
      if(guard==='actual-mismatch'||guard==='account-read-failure'||guard==='account-read-own-financial'){
        assert.equal(f.accountReads.get('gate'),1,guard);assert.equal(f.accountReads.get('bybit'),1,guard);
      }else assert.equal([...f.accountReads.values()].reduce((sum,quantity)=>sum+quantity,0),0,guard);
      if(guard==='account-read-failure'){
        const failedAt=Date.now();
        for(let signal=0;signal<9;signal++){f.publish();f.internal.onRealtimeSignal();t.mock.timers.tick(50);await flushRealtime(f);
          assert.equal(f.accountReads.get('gate'),1);assert.equal(f.accountReads.get('bybit'),1);assert.equal(f.requests.length,before);}
        t.mock.timers.tick(failedAt+499-Date.now());f.publish();f.internal.onRealtimeSignal();await flushRealtime(f);
        assert.equal(f.accountReads.get('gate'),1);assert.equal(f.accountReads.get('bybit'),1);
        t.mock.timers.tick(1);t.mock.timers.tick(0);await flushRealtime(f);
        assert.equal(f.accountReads.get('gate'),2);assert.equal(f.accountReads.get('bybit'),2);
        assert.equal(f.requests.length,before+1);assert.equal(f.requests.at(-1)!.exchange,'bybit');assert.equal(f.requests.at(-1)!.request.quantity,.1);
        assert.equal(f.feeReads.length,0);
      }
    }finally{await f.engine.stop();}
  }
});

test('selected Maker-tail repair HTTP schema rejects extra trading permissions and foreign shapes',async t=>{
  memoryTime(t);const f=fixture(),{selectedMakerCloseRepairSchema}=await import('../src/server-input.js');
  assert.equal(selectedMakerCloseRepairSchema.safeParse(f.request()).success,true);
  for(const value of [{...f.request(),allowEntry:true},{...f.request(),expected:{...f.request().expected,unknown:true}},
    {...f.request(),acknowledgement:'RECONCILE_SELECTED_POSITIONS'},{...f.request(),legacyPeerClientOrderIds:new Array(21).fill(peerId)}])
    assert.equal(selectedMakerCloseRepairSchema.safeParse(value).success,false);
});
