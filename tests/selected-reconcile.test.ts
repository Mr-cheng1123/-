import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine,type SelectedReconcileRequest} from '../src/core/engine.js';
import type {Store,SavedState} from '../src/core/store.js';
import {defaultConfig} from '../src/shared/config.js';
import {selectedReconcileSchema} from '../src/server-input.js';
import type {AccountState,ExchangeAdapter,ExchangeId,JournalOrder,MarketSnapshot,OrderRequest,OrderResult,Position} from '../src/shared/types.js';
import type {ManualCloseOperation} from '../src/shared/manual-close.js';

// Real Engine control flow, deterministic native GET responses, no credentials or network transport.
function fixture(options:{privateReadDeadlineMs?:number;venues?:ExchangeId[]}={}){
  const now=Date.now(),venues:ExchangeId[]=options.venues??['bybit','gate'];
  const makePosition=(id:string,base:string,quantity:number):Position=>({id,base,mode:'live',status:'open',entryPolicy:'aligned',
    openedAt:now-60_000,plannedExitAt:now+3_600_000,holdMode:'adaptive',
    long:{exchange:venues[0],symbol:`${base}/USDT:USDT`,side:'long',quantity,entryPrice:.1,markPrice:.1,feesUsd:.01,liquidationDistancePct:null},
    short:{exchange:'gate',symbol:`${base}/USDT:USDT`,side:'short',quantity,entryPrice:.101,markPrice:.101,feesUsd:.01,liquidationDistancePct:null},
    fundingUsd:.02,feesUsd:.02,transferCostUsd:0,spreadPnlUsd:0,realizedSpreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:['actual-old-funding'],riskReasons:[]});
  const one=makePosition('one-original','ONE',1000),other=makePosition('other-attention','OGN',30),unknownPosition=makePosition('laopu-unknown','LAOPU',.6);
  other.status='attention';unknownPosition.status='attention';unknownPosition.long.quantity=0;
  const order=(position:Position,exchange:ExchangeId):JournalOrder=>{
    const leg=exchange===venues[0]?position.long:position.short,id=`original-${position.id}-${exchange}`;
    return {positionId:position.id,exchange,createdAt:position.openedAt+1000,
      request:{clientOrderId:id,base:position.base,symbol:leg.symbol,side:leg.side==='long'?'buy':'sell',quantity:leg.quantity,limitPrice:leg.entryPrice,reduceOnly:false},
      result:{id,clientOrderId:id,status:'filled',filledQuantity:leg.quantity,averagePrice:leg.entryPrice,feeUsd:.01,timestamp:position.openedAt+1200}};
  };
  const unknown:JournalOrder={positionId:unknownPosition.id,exchange:'bybit',createdAt:unknownPosition.openedAt+1000,
    request:{clientOrderId:'original-unknown-client',base:'LAOPU',symbol:'LAOPU/USDT:USDT',side:'buy',quantity:.6,limitPrice:41.84,reduceOnly:false},
    result:{id:'',clientOrderId:'original-unknown-client',status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:unknownPosition.openedAt+1200,
      confirmation:{stage:'order-read',reason:'not-found'}}};
  const config={...defaultConfig,mode:'live' as const,dataSource:'public' as const,entryPolicy:'aligned' as const,exchanges:venues,symbols:['ONE','OGN'],orderNotionalUsd:100};
  const ledger:SavedState={version:1,config,positions:[one,other,unknownPosition],orders:[order(one,'bybit'),order(one,'gate'),order(other,'bybit'),order(other,'gate'),unknown],
    logs:[],equity:[],fundingSeen:['actual-old-funding'],killSwitch:false};
  let saveCount=0,failSaveAt=Infinity;
  const save=()=>{saveCount++;if(saveCount===failSaveAt)throw new Error('Offline storage interruption');};
  const store={data:ledger,save,
    log(level:string,message:string){ledger.logs.push({id:'mock-log',timestamp:Date.now(),level:level as 'info',message});save();}} as unknown as Store;
  const accounts=new Map<ExchangeId,AccountState>(venues.map(exchange=>[exchange,{freeUsd:500,equityUsd:600,
    positions:[one,other,unknownPosition].flatMap(position=>{
      const leg=exchange===venues[0]?position.long:position.short;
      return leg.quantity>0?[{base:position.base,symbol:leg.symbol,side:leg.side,quantity:leg.quantity,entryPrice:leg.entryPrice,
        markPrice:leg.markPrice,liquidationPrice:0,leverage:2,marginMode:'crossed' as const,positionId:`${position.base}-${exchange}-slot`,positionOpenedAt:position.openedAt+1000}]:[];
    })}]));
  const calls:string[]=[],mutations:string[]=[],readCounts=new Map<ExchangeId,number>();
  let accountHook:(exchange:ExchangeId,count:number)=>void|Promise<void>=()=>{},openOrdersHook:(exchange:ExchangeId,symbol:string)=>unknown|Promise<unknown>=()=>[];
  let orderHook:((request:OrderRequest,nativeId:string|undefined,original:JournalOrder)=>OrderResult|Promise<OrderResult>)|undefined;
  const adapters=venues.map(exchange=>({id:exchange,fetchAccount:async()=>{
    const count=(readCounts.get(exchange)??0)+1;readCounts.set(exchange,count);calls.push(`${exchange}:account`);
    await accountHook(exchange,count);return structuredClone(accounts.get(exchange)!);
  },fetchOpenOrders:async(symbol:string)=>{calls.push(`${exchange}:orders:${symbol}`);return await openOrdersHook(exchange,symbol);},
    inspectOrder:async(request:OrderRequest,nativeId?:string)=>{
      if(!orderHook){mutations.push('Unexpected original-order query');throw new Error('Unselected original order must not be queried');}
      const original=ledger.orders.find(order=>order.positionId===one.id&&order.exchange===exchange&&order.request.clientOrderId===request.clientOrderId);
      assert.ok(original,'Only the explicitly selected original receipt can be inspected');
      assert.deepEqual(request,original.request);assert.equal(nativeId,original.result!.id);
      calls.push(`${exchange}:inspect:${request.clientOrderId}`);return await orderHook(request,nativeId,original);
    },
    reconcileOrder:async()=>{mutations.push('Unexpected original-order reconciliation');throw new Error('No order reconciliation');},
    inspectTrading:async()=>{mutations.push('Unexpected contract preparation');throw new Error('No preparation');},
    prepareTrading:async()=>{mutations.push('Unexpected financial mode change');throw new Error('No financial action');},
    fetchTradingFee:async()=>{mutations.push('Unexpected fee query');throw new Error('No private fee query');},
    placeOrder:async()=>{mutations.push('Unexpected order');throw new Error('No financial action');},
    cancelOrder:async()=>{mutations.push('Unexpected cancel');throw new Error('No financial action');},close:async()=>{}} as unknown as ExchangeAdapter));
  const environment={ALLOW_LIVE_TRADING:'false',LIVE_TRADING_ACK:'READ_ONLY',BYBIT_API_KEY:'offline-only',BYBIT_API_SECRET:'offline-only',
    GATE_API_KEY:'offline-only',GATE_API_SECRET:'offline-only',BITGET_API_KEY:'offline-only',BITGET_API_SECRET:'offline-only',BITGET_PASSPHRASE:'offline-only'};
  const engine=new Engine(store,false,{adapterFactory:()=>adapters,liveEnvironment:environment,privateReadDeadlineMs:options.privateReadDeadlineMs});
  engine.snapshots=venues.flatMap(exchange=>[one,other].map(position=>({exchange,base:position.base,symbol:position.long.symbol,markPrice:.1,indexPrice:.1,
    fundingRate:0,nextFundingTime:now+3_600_000,intervalHours:8,fundingHistory:[],timestamp:now,observedAt:now,source:'public',
    bids:[{price:.1,quantity:10000}],asks:[{price:.101,quantity:10000}],quantityStep:1,minQuantity:1,minNotional:5,contractSize:1,openInterestUsd:1e6,volume24hUsd:1e6} as MarketSnapshot)));
  const request=(positions=[one]):SelectedReconcileRequest=>({acknowledgement:'RECONCILE_SELECTED_POSITIONS',expiresAt:Date.now()+45_000,
    positionIds:positions.map(position=>position.id),expected:positions.map(position=>({id:position.id,base:position.base,openedAt:position.openedAt,
      longExchange:position.long.exchange,longSymbol:position.long.symbol,longQuantity:position.long.quantity,
      shortExchange:position.short.exchange,shortSymbol:position.short.symbol,shortQuantity:position.short.quantity}))});
  return {engine,store,ledger,one,other,unknownPosition,unknown,accounts,calls,mutations,adapters,request,
    authorize:async()=>{await engine.authorizeLiveAccounts('RECHECK_LIVE_AUTHORIZATION');calls.length=0;readCounts.clear();},
    setAccountHook:(hook:typeof accountHook)=>{accountHook=hook;},setOpenOrdersHook:(hook:typeof openOrdersHook)=>{openOrdersHook=hook;},
    setOrderHook:(hook:NonNullable<typeof orderHook>)=>{orderHook=hook;},
    failNextFinalSave:()=>{failSaveAt=saveCount+2;}};
}

test('explicit selected reconciliation restores only ONE while unrelated attention, unknown intents and cash remain unchanged',async()=>{
  const f=fixture();await f.authorize();
  const ordersBefore=JSON.stringify(f.ledger.orders),otherBefore=JSON.stringify([f.other,f.unknownPosition]),fundingBefore=JSON.stringify(f.ledger.fundingSeen);
  const result=await f.engine.reconcileSelectedPositions(selectedReconcileSchema.parse(f.request()));
  assert.deepEqual(result.positionIds,[f.one.id]);assert.equal(result.autoEnabled,false);assert.equal(f.one.status,'open');
  assert.equal(JSON.stringify([f.other,f.unknownPosition]),otherBefore);assert.equal(JSON.stringify(f.ledger.orders),ordersBefore);
  assert.equal(JSON.stringify(f.ledger.fundingSeen),fundingBefore);assert.equal(f.engine.autoEnabled,false);assert.deepEqual(f.mutations,[]);
  assert.equal(f.calls.filter(call=>call.endsWith(':account')).length,4);assert.equal(f.calls.filter(call=>call.includes(':orders:')).length,2);
  assert.deepEqual([...(f.engine as any).reconciledPositions],[f.one.id]);
});

test('read-only, automatic-entry running and kill-switch states cannot grant selected management',async()=>{
  const f=fixture();await assert.rejects(f.engine.reconcileSelectedPositions(f.request()),/当前会话实盘授权/);assert.deepEqual(f.calls,[]);
  await f.authorize();f.engine.autoEnabled=true;
  await assert.rejects(f.engine.reconcileSelectedPositions(f.request()),/暂停自动/);
  f.engine.autoEnabled=false;f.ledger.killSwitch=true;await assert.rejects(f.engine.reconcileSelectedPositions(f.request()),/风险开关/);
  assert.equal(f.one.status,'attention');assert.deepEqual(f.calls,[]);assert.deepEqual(f.mutations,[]);
});

test('malformed, stale, mismatched or repeated selected identities cannot widen recovery',async()=>{
  const f=fixture();await f.authorize();
  const original=f.request(),bad:Array<SelectedReconcileRequest>=[
    {...original,expiresAt:Date.now()-1},{...original,expiresAt:Date.now()+61_000},
    {...original,positionIds:[f.one.id,f.one.id],expected:[original.expected[0],original.expected[0]]},
    {...original,expected:[]},{...original,expected:[{...original.expected[0],id:'another-id'}]},
    {...original,positionIds:['missing'],expected:[{...original.expected[0],id:'missing'}]},
    {...original,expected:[{...original.expected[0],openedAt:original.expected[0].openedAt+1}]},
    {...original,expected:[{...original.expected[0],longQuantity:1001}]},
    {...original,expected:[{...original.expected[0],longSymbol:'OTHER/USDT:USDT'}]},
  ];
  for(const request of bad)await assert.rejects(f.engine.reconcileSelectedPositions(request));
  assert.equal(f.one.status,'attention');assert.equal(f.other.status,'attention');assert.deepEqual(f.calls,[]);
  assert.throws(()=>selectedReconcileSchema.parse({...original,autoEnabled:true}));
  assert.throws(()=>selectedReconcileSchema.parse({...original,acknowledgement:'RESTORE_LIVE_MANAGEMENT'}));
});

test('same-coin unknown or unscoped unknown blocks restoration without querying or changing the original order',async()=>{
  for(const unidentified of [false,true]){
    const f=fixture();await f.authorize();
    if(unidentified){f.unknown.request.base='';f.unknown.positionId='unscoped-missing-position';}
    else f.unknown.request.base='ONE';
    const before=JSON.stringify(f.unknown);await assert.rejects(f.engine.reconcileSelectedPositions(f.request()),/未确认订单/);
    assert.equal(JSON.stringify(f.unknown),before);assert.equal(f.one.status,'attention');assert.deepEqual(f.calls,[]);assert.deepEqual(f.mutations,[]);
  }
});

test('closed, manual reduction, close intent and unmatched or illegal quantities are not adopted',async()=>{
  const mutations:Array<(f:ReturnType<typeof fixture>)=>void>=[
    f=>{f.one.status='closed';},f=>{f.one.manualCloseOnly=true;},f=>{f.one.closeRequestedAt=Date.now();},
    f=>{f.one.closeAttemptedAt=Date.now();},f=>{f.one.accountClosure={confirmedAt:Date.now(),reason:'Independent flat proof',historicalOrdersPending:false};},
    f=>{f.one.long.quantity+=.01;},f=>{f.one.long.quantity=f.one.short.quantity=1000.01;},
    f=>{f.other.base=f.one.base;},f=>{f.engine.snapshots=[];},
  ];
  for(const mutate of mutations){const f=fixture();await f.authorize();mutate(f);await assert.rejects(f.engine.reconcileSelectedPositions(f.request()));assert.deepEqual(f.calls,[]);}
});

test('native pending orders and incomplete or failing open-order responses cannot prove readiness',async()=>{
  const responses:Array<()=>unknown|Promise<unknown>>=[()=>undefined,()=>({list:[]}),()=>[{id:'conditional-close-all',quantity:0}],()=>Promise.reject(new Error('Native page timeout'))];
  for(const response of responses){
    const f=fixture();await f.authorize();f.setOpenOrdersHook(()=>response());
    await assert.rejects(f.engine.reconcileSelectedPositions(f.request()));assert.equal(f.one.status,'attention');assert.deepEqual(f.mutations,[]);
  }
});

test('both native account reads must remain equal in quantity, identity, margin and opening cycle',async()=>{
  const mutations:Array<(account:AccountState)=>void>=[
    account=>{account.positions.find(row=>row.base==='ONE')!.quantity+=.01;},
    account=>{account.positions.find(row=>row.base==='ONE')!.side='short';},
    account=>{account.positions.find(row=>row.base==='ONE')!.positionId='replacement-slot';},
    account=>{account.positions.find(row=>row.base==='ONE')!.marginMode='isolated';},
    account=>{delete account.positions.find(row=>row.base==='ONE')!.positionId;},
    account=>{account.positions.find(row=>row.base==='ONE')!.positionOpenedAt=Date.now();},
    account=>{account.positions.push({...account.positions.find(row=>row.base==='ONE')!});},
  ];
  for(const mutate of mutations){
    const f=fixture();await f.authorize();f.setAccountHook((exchange,count)=>{if(exchange==='bybit'&&count===2)mutate(f.accounts.get(exchange)!);});
    await assert.rejects(f.engine.reconcileSelectedPositions(f.request()));assert.equal(f.one.status,'attention');assert.equal(f.other.status,'attention');assert.deepEqual(f.mutations,[]);
  }
});

test('optional native identity is not fabricated when both fresh reads legitimately omit it',async()=>{
  const f=fixture();await f.authorize();for(const account of f.accounts.values())for(const row of account.positions){delete row.positionId;delete row.positionOpenedAt;delete row.marginMode;}
  await f.engine.reconcileSelectedPositions(f.request());assert.equal(f.one.status,'open');assert.deepEqual(f.mutations,[]);
});

test('every selected position must pass before any selected manager is restored',async()=>{
  const f=fixture();await f.authorize();f.accounts.get('gate')!.positions.find(row=>row.base==='OGN')!.quantity--;
  await assert.rejects(f.engine.reconcileSelectedPositions(f.request([f.one,f.other])),/实际账户/);
  assert.equal(f.one.status,'attention');assert.equal(f.other.status,'attention');assert.deepEqual([...(f.engine as any).reconciledPositions],[]);
});

test('large quantities cannot turn floating-point tolerance into several legitimate lot steps',async()=>{
  const f=fixture();await f.authorize();f.one.long.quantity=f.one.short.quantity=1e16;
  for(const account of f.accounts.values())account.positions.find(row=>row.base==='ONE')!.quantity=1e16;
  f.accounts.get('bybit')!.positions.find(row=>row.base==='ONE')!.quantity+=2;
  await assert.rejects(f.engine.reconcileSelectedPositions(f.request()),/实际账户/);assert.equal(f.one.status,'attention');
  const mismatched=fixture();await mismatched.authorize();mismatched.one.long.quantity=1e16;mismatched.one.short.quantity=1e16+2;
  await assert.rejects(mismatched.engine.reconcileSelectedPositions(mismatched.request()),/数量尾差/);assert.deepEqual(mismatched.calls,[]);
});

test('pause generation, configuration, native client and current authorization changes invalidate awaited verification',async()=>{
  const mutations:Array<(f:ReturnType<typeof fixture>)=>void|Promise<void>>=[
    async f=>{await f.engine.control('pause');},f=>{f.store.data.config={...f.store.data.config,orderNotionalUsd:6};},
    f=>{(f.engine as any).sessionExchanges.delete('gate');},f=>{f.engine.adapters=f.engine.adapters.filter(adapter=>adapter.id!=='gate');},
  ];
  for(const mutate of mutations){
    const f=fixture();await f.authorize();let changed=false;
    f.setOpenOrdersHook(async()=>{if(!changed){changed=true;await mutate(f);}return [];});
    await assert.rejects(f.engine.reconcileSelectedPositions(f.request()));assert.equal(f.one.status,'attention');assert.equal(f.other.status,'attention');assert.deepEqual(f.mutations,[]);
  }
});

test('expired or stale account observations and account reads preceding the latest order cannot resume holding',async t=>{
  const realNow=Date.now();let clock=realNow;t.mock.method(Date,'now',()=>clock);
  const f=fixture();await f.authorize();const request=f.request();
  f.setOpenOrdersHook(()=>{clock+=46_000;return [];});
  await assert.rejects(f.engine.reconcileSelectedPositions(request),/过期/);assert.equal(f.one.status,'attention');
  const stale=fixture();await stale.authorize();stale.setAccountHook(()=>{clock+=31_000;});
  await assert.rejects(stale.engine.reconcileSelectedPositions(stale.request()),/过期/);assert.equal(stale.one.status,'attention');
  const future=fixture();await future.authorize();future.ledger.orders.find(order=>order.positionId===future.one.id)!.result!.timestamp=clock+5000;
  await assert.rejects(future.engine.reconcileSelectedPositions(future.request()),/新鲜读取/);assert.equal(future.one.status,'attention');
});

test('final status persistence failure leaves all selected managers and unrelated attention paused',async()=>{
  const f=fixture();await f.authorize();f.failNextFinalSave();const ordersBefore=JSON.stringify(f.ledger.orders);
  await assert.rejects(f.engine.reconcileSelectedPositions(f.request()),/storage interruption/);
  assert.equal(f.one.status,'attention');assert.equal(f.other.status,'attention');assert.deepEqual([...(f.engine as any).reconciledPositions],[]);
  assert.equal(JSON.stringify(f.ledger.orders),ordersBefore);assert.deepEqual(f.mutations,[]);
});

function completedManualFixture(options:{privateReadDeadlineMs?:number}={}){
  const f=fixture(options),p=f.one,now=Date.now();
  f.ledger.config.holdMode='adaptive';
  p.automaticEntry=true;p.feeOnly=true;p.entryPolicy='funding';p.holdMode='once';p.profitExitNotionalUsd=102.51;
  p.manualCloseOnly=true;p.manualCloseOperationId='completed-scoped-close';
  p.closeRequestedAt=now-15_000;p.closeAttemptedAt=now-12_000;p.closeReason='用户确认所选账户仓位手动平仓';
  p.closeProfitRequired=false;p.closePricing='best-opposite';p.closePauseReason='原手动操作已经结束';
  const original=f.ledger.orders.filter(order=>order.positionId===p.id);
  for(const order of original){
    order.request.quantity=1020;order.result!.filledQuantity=1020;order.result!.id=`native-${order.request.clientOrderId}`;
    order.result!.averagePriceVerified=true;
    order.executionEvidence={version:1,method:'ioc',role:order.exchange===p.long.exchange?'entry':'hedge',batchId:'original-entry',bookedFeeUsd:.01};
  }
  for(const leg of [p.long,p.short]){
    const clientOrderId=`manual-prior-reduction-${leg.exchange}`,feeUsd=leg.side==='long'?.0015:.002;
    leg.feesUsd=.01+feeUsd;
    f.ledger.orders.push({positionId:p.id,exchange:leg.exchange,createdAt:now-12_000,
      request:{clientOrderId,base:p.base,symbol:leg.symbol,side:leg.side==='long'?'sell':'buy',quantity:20,limitPrice:leg.entryPrice,reduceOnly:true},
      result:{id:`native-${clientOrderId}`,clientOrderId,status:'filled',filledQuantity:20,averagePrice:leg.entryPrice,
        averagePriceVerified:true,feeUsd,timestamp:now-11_000},
      executionEvidence:{version:1,method:'ioc',role:'exit',batchId:'original-manual-close',bookedFeeUsd:feeUsd}});
  }
  p.feesUsd=p.long.feesUsd+p.short.feesUsd;
  const operation:ManualCloseOperation={id:p.manualCloseOperationId,state:'completed',positionId:p.id,sourcePositionId:p.id,
    createdAt:now-10_000,expiresAt:now-5000,error:'首档无共同合法量，本次手动操作已结束',
    selection:JSON.stringify({sourceId:p.id,base:p.base,acknowledgement:'CLOSE_SELECTED_POSITION',legs:[p.long,p.short].map(leg=>({
      exchange:leg.exchange,symbol:leg.symbol,side:leg.side,quantity:leg.quantity,
      accountPositionKey:JSON.stringify([leg.exchange,leg.symbol,leg.side,'crossed',`${p.base}-${leg.exchange}-slot`]),
      positionOpenedAt:p.openedAt+1000}))})};
  f.ledger.manualCloseOperations=[operation];
  f.setOrderHook((_request,_id,order)=>({...structuredClone(order.result!),orderReadAt:Date.now()}));
  const currentRequest=():SelectedReconcileRequest=>({...f.request(),acknowledgement:'RECONCILE_CURRENT_STRATEGY_POSITIONS'});
  return {...f,operation,currentRequest};
}

function provenNoSendFixture(){
  const f=fixture(),p=f.one,now=Date.now();f.ledger.config.holdMode='adaptive';
  p.automaticEntry=true;p.feeOnly=true;p.entryPolicy='funding';p.holdMode='once';p.profitExitNotionalUsd=100.5;
  p.closeRequestedAt=now-15_000;p.closeAttemptedAt=now-12_000;p.closeReason='Original automatic conditional Maker';
  p.closeProfitRequired=true;p.closePricing='best-opposite';p.closePauseReason='Submission permission changed before send';
  p.automaticCloseHistory=[{requestedAt:now-30_000,suspendedAt:now-20_000,reason:'Older original intent',
    suspensionReason:'Earlier complete proof',pricing:'depth',longQuantity:1000,shortQuantity:1000}];
  for(const order of f.ledger.orders.filter(order=>order.positionId===p.id)){
    order.result!.id=`native-${order.request.clientOrderId}`;order.result!.averagePriceVerified=true;
    order.executionEvidence={version:1,method:'ioc',role:order.exchange===p.long.exchange?'entry':'hedge',batchId:'original-entry',bookedFeeUsd:.01};
  }
  const clientOrderId='original-never-sent-maker',noSend:JournalOrder={positionId:p.id,exchange:p.long.exchange,createdAt:now-12_000,
    request:{clientOrderId,base:p.base,symbol:p.long.symbol,side:'sell',quantity:1000,limitPrice:.101,reduceOnly:true,postOnly:true},
    result:{id:'',clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,averagePriceVerified:true,feeUsd:0,timestamp:now-11_000,
      rejectionCode:'MAKER_REDUCTION_PERMISSION_CHANGED',rejectionReason:'Memory native pre-send permission veto'},
    makerReduction:{activity:'terminal',makerLeg:'long',deadlineAt:now-10_000,quantityStep:1,peerQuantityStep:1,bookedExecution:true},
    executionEvidence:{version:1,method:'maker',role:'exit',batchId:'original-automatic-close',bookedFeeUsd:0}};
  f.ledger.orders.push(noSend);
  f.setOrderHook((_request,_id,order)=>({...structuredClone(order.result!),orderReadAt:Date.now()}));
  return {...f,noSend,currentRequest:():SelectedReconcileRequest=>({...f.request(),acknowledgement:'RECONCILE_CURRENT_STRATEGY_POSITIONS'})};
}

test('current acknowledgement archives only a proven never-sent automatic Maker after original cash and exact accounts are read',async()=>{
  const f=provenNoSendFixture();await f.authorize();const prior=structuredClone(f.one),orders=JSON.stringify(f.ledger.orders),
    unselected=JSON.stringify([f.other,f.unknownPosition]),funding=JSON.stringify(f.ledger.fundingSeen);
  await assert.rejects(f.engine.reconcileSelectedPositions(f.request()),/身份|处理状态/);assert.equal(f.calls.length,0);
  const response=await f.engine.reconcileSelectedPositions(f.currentRequest());
  assert.deepEqual(response.positionIds,[f.one.id]);assert.equal(f.one.status,'open');assert.equal(f.engine.autoEnabled,false);
  for(const field of ['closeRequestedAt','closeAttemptedAt','closeReason','closePricing','closeProfitRequired','closePauseReason'] as const)
    assert.equal(f.one[field],undefined);
  for(const field of ['entryPolicy','holdMode','feeOnly','automaticEntry','profitExitNotionalUsd','fundingUsd','feesUsd','realizedSpreadPnlUsd',
    'transferCostUsd','long','short','fundingEvents'] as const)assert.deepEqual(f.one[field],prior[field]);
  assert.equal(f.one.automaticCloseHistory?.length,2);assert.deepEqual(f.one.automaticCloseHistory![0],prior.automaticCloseHistory![0]);
  const archived=f.one.automaticCloseHistory![1];assert.equal(archived.requestedAt,prior.closeRequestedAt);
  assert.equal(archived.attemptedAt,prior.closeAttemptedAt);assert.equal(archived.reason,prior.closeReason);assert.equal(archived.pricing,'best-opposite');
  assert.equal(JSON.stringify(f.ledger.orders),orders);assert.equal(JSON.stringify([f.other,f.unknownPosition]),unselected);
  assert.equal(JSON.stringify(f.ledger.fundingSeen),funding);assert.equal(f.one.currentManagementRestorationHistory,undefined);
  assert.equal(f.calls.filter(call=>call.includes(':inspect:')).length,2,'every real original opening receipt still needs its exact native cash GET');
  assert.ok(f.calls.every(call=>!call.includes(f.noSend.request.clientOrderId)),'a proven empty native ID cannot be sent to an order lookup');
  assert.equal(f.calls.filter(call=>call.endsWith(':account')).length,4);assert.equal(f.calls.filter(call=>call.includes(':orders:')).length,2);
  assert.deepEqual([...(f.engine as any).reconciledPositions],[f.one.id]);assert.deepEqual(f.mutations,[]);
});

test('generic permission errors, unknown cash, a real native ID and foreign no-send metadata never release the old close intent',async()=>{
  const mutations:Array<(f:ReturnType<typeof provenNoSendFixture>)=>void>=[
    f=>{f.noSend.result!.rejectionCode='ORDER_SUBMISSION_PERMISSION_CHANGED';},
    f=>{f.noSend.result!.rejectionCode='PRE_SUBMISSION_CHECK_FAILED';},
    f=>{f.noSend.result!.status='unknown';},f=>{f.noSend.result!.id='actually-created-native-order';},
    f=>{f.noSend.result!.feeUsd=NaN;},f=>{f.noSend.result!.averagePrice=.1;},
    f=>{f.noSend.executionEvidence!.bookedFeeUsd=.001;},f=>{f.noSend.makerReduction!.bookedExecution=false;},
    f=>{f.noSend.makerReduction!.activity='unknown';},f=>{f.noSend.request.reduceOnly=false;},
    f=>{f.noSend.request.postOnly=false;},f=>{f.noSend.request.base='FOREIGN';},
    f=>{f.noSend.request.symbol='FOREIGN/USDT:USDT';},f=>{f.noSend.request.side='buy';},
    f=>{const other=structuredClone(f.noSend);other.request.clientOrderId='another-unknown-intent';other.result!.clientOrderId=other.request.clientOrderId;
      other.result!.status='unknown';f.ledger.orders.push(other);},
  ];
  for(const mutate of mutations){const f=provenNoSendFixture();await f.authorize();mutate(f);const before=JSON.stringify(f.one),orders=JSON.stringify(f.ledger.orders);
    await assert.rejects(f.engine.reconcileSelectedPositions(f.currentRequest()));assert.equal(JSON.stringify(f.one),before);
    assert.equal(JSON.stringify(f.ledger.orders),orders);assert.deepEqual(f.calls,[]);assert.deepEqual(f.mutations,[]);
    assert.deepEqual([...(f.engine as any).reconciledPositions],[]);}
  const cashMismatch=provenNoSendFixture();await cashMismatch.authorize();const before=JSON.stringify(cashMismatch.one);
  cashMismatch.setOrderHook((_request,_id,order)=>({...structuredClone(order.result!),feeUsd:order.result!.feeUsd+.001,orderReadAt:Date.now()}));
  await assert.rejects(cashMismatch.engine.reconcileSelectedPositions(cashMismatch.currentRequest()),/真实现金|原生终态/);
  assert.equal(JSON.stringify(cashMismatch.one),before);assert.deepEqual(cashMismatch.mutations,[]);
});

test('failed never-sent intent restoration saves leave its historical audit and conditional intent intact',async()=>{
  const f=provenNoSendFixture();await f.authorize();f.failNextFinalSave();
  const prior=structuredClone(f.one),orders=JSON.stringify(f.ledger.orders),others=JSON.stringify([f.other,f.unknownPosition]);
  await assert.rejects(f.engine.reconcileSelectedPositions(f.currentRequest()),/storage interruption/);
  assert.deepEqual(JSON.parse(JSON.stringify(f.one)),prior);assert.equal(JSON.stringify(f.ledger.orders),orders);
  assert.equal(JSON.stringify([f.other,f.unknownPosition]),others);assert.deepEqual([...(f.engine as any).reconciledPositions],[]);
  assert.deepEqual(f.mutations,[]);
});

test('current-strategy acknowledgement verifies original native cash and both accounts before archiving a completed manual intent',async()=>{
  const f=completedManualFixture();await f.authorize();
  const prior=structuredClone(f.one),ordersBefore=JSON.stringify(f.ledger.orders),operationsBefore=JSON.stringify(f.ledger.manualCloseOperations),
    unselectedBefore=JSON.stringify([f.other,f.unknownPosition]),fundingSeenBefore=JSON.stringify(f.ledger.fundingSeen);
  const response=await f.engine.reconcileSelectedPositions(selectedReconcileSchema.parse(f.currentRequest()));
  assert.deepEqual(response.positionIds,[f.one.id]);assert.equal(response.autoEnabled,false);assert.equal(f.one.status,'open');
  for(const field of ['manualCloseOnly','closeRequestedAt','closeAttemptedAt','closeReason','closePricing','closeProfitRequired','closePauseReason'] as const)
    assert.equal(f.one[field],undefined);
  for(const field of ['entryPolicy','holdMode','feeOnly','automaticEntry','manualCloseOperationId','profitExitNotionalUsd','fundingUsd','feesUsd',
    'realizedSpreadPnlUsd','transferCostUsd','long','short','fundingEvents'] as const)assert.deepEqual(f.one[field],prior[field]);
  const audit=f.one.currentManagementRestorationHistory!;assert.equal(audit.length,1);assert.equal(audit[0].sourceOperationId,f.operation.id);
  assert.equal(audit[0].previousCloseIntent.profitRequired,false);assert.equal(audit[0].previousCloseIntent.requestedAt,prior.closeRequestedAt);
  assert.equal(audit[0].originalOrderIds.length,4);assert.equal(audit[0].originalManualCloseOnly,true);
  assert.equal(JSON.stringify(f.ledger.orders),ordersBefore);assert.equal(JSON.stringify(f.ledger.manualCloseOperations),operationsBefore);
  assert.equal(JSON.stringify([f.other,f.unknownPosition]),unselectedBefore);assert.equal(JSON.stringify(f.ledger.fundingSeen),fundingSeenBefore);
  assert.deepEqual([...(f.engine as any).reconciledPositions],[f.one.id]);assert.deepEqual(f.mutations,[]);
  assert.equal(f.calls.filter(call=>call.includes(':inspect:')).length,4);
  assert.equal(f.calls.filter(call=>call.endsWith(':account')).length,4);assert.equal(f.calls.filter(call=>call.includes(':orders:')).length,2);
  const firstAccount=f.calls.findIndex(call=>call.endsWith(':account')),lastInspect=f.calls.map(call=>call.includes(':inspect:')).lastIndexOf(true),
    firstOrders=f.calls.findIndex(call=>call.includes(':orders:'));
  assert.ok(lastInspect<firstAccount);assert.ok(firstOrders>firstAccount);
  assert.ok(f.calls.map(call=>call.endsWith(':account')).lastIndexOf(true)>f.calls.map(call=>call.includes(':orders:')).lastIndexOf(true));
});

test('the old acknowledgement cannot clear a manual management lock even after its operation completed',async()=>{
  const f=completedManualFixture();await f.authorize();const before=JSON.stringify(f.one);
  await assert.rejects(f.engine.reconcileSelectedPositions(f.request()),/身份|处理状态/);
  assert.equal(JSON.stringify(f.one),before);assert.deepEqual(f.calls,[]);assert.deepEqual(f.mutations,[]);
});

test('current-strategy restoration accepts old missing automaticEntry only with the complete original opening cash',async()=>{
  const f=completedManualFixture();delete f.one.automaticEntry;for(const order of f.ledger.orders.filter(order=>order.positionId===f.one.id))delete order.executionEvidence;
  await f.authorize();await f.engine.reconcileSelectedPositions(f.currentRequest());assert.equal(f.one.status,'open');
  assert.equal(f.one.automaticEntry,undefined);assert.equal(f.one.entryPolicy,'funding');assert.equal(f.one.holdMode,'once');assert.deepEqual(f.mutations,[]);
});

test('current-strategy acknowledgement does not adopt synthetic, unfinished, unknown or subsequently traded records',async()=>{
  const mutations:Array<(f:ReturnType<typeof completedManualFixture>)=>void>=[
    f=>{f.one.manualCloseAccountRecord=true;},f=>{f.operation.state='closing';},f=>{f.operation.sourcePositionId='another-original';},
    f=>{f.one.automaticEntry=false;},f=>{f.ledger.orders.find(order=>order.positionId===f.one.id)!.result!.feeUsd=NaN;},
    f=>{f.ledger.orders.find(order=>order.positionId===f.one.id)!.result!.status='unknown';},
    f=>{const order=structuredClone(f.ledger.orders.find(order=>order.positionId===f.one.id)!);order.createdAt=Date.now();f.ledger.orders.push(order);},
  ];
  for(const mutate of mutations){
    const f=completedManualFixture();await f.authorize();mutate(f);const before=JSON.stringify(f.one),ordersBefore=JSON.stringify(f.ledger.orders);
    await assert.rejects(f.engine.reconcileSelectedPositions(f.currentRequest()));assert.equal(JSON.stringify(f.one),before);
    assert.equal(JSON.stringify(f.ledger.orders),ordersBefore);assert.deepEqual(f.calls,[]);assert.deepEqual(f.mutations,[]);
    assert.deepEqual([...(f.engine as any).reconciledPositions],[]);
  }
});

test('native restored-source receipts must prove exactly the saved identity, quantity, price, fee and fresh complete cash',async()=>{
  const mutateResults:Array<(result:OrderResult)=>void>=[
    result=>{result.id='foreign-native';},result=>{result.clientOrderId='foreign-client';},result=>{result.status='cancelled';},
    result=>{result.filledQuantity--;},result=>{result.averagePrice-=.000001;},result=>{result.feeUsd+=.001;},
    result=>{result.averagePriceVerified=false;},result=>{delete result.orderReadAt;},result=>{result.orderReadAt=Date.now()-1000;},
    result=>{result.orderReadAt=Date.now()+1000;},
  ];
  for(const mutate of mutateResults){
    const f=completedManualFixture();await f.authorize();const before=JSON.stringify(f.one),ordersBefore=JSON.stringify(f.ledger.orders);
    f.setOrderHook((_request,_id,order)=>{const result={...structuredClone(order.result!),orderReadAt:Date.now()};mutate(result);return result;});
    await assert.rejects(f.engine.reconcileSelectedPositions(f.currentRequest()),/原生终态|真实现金/);
    assert.equal(JSON.stringify(f.one),before);assert.equal(JSON.stringify(f.ledger.orders),ordersBefore);
    assert.equal(f.calls.filter(call=>call.endsWith(':account')).length,0);assert.deepEqual(f.mutations,[]);
  }
});

test('a completed manual source still needs complete empty ordinary and conditional native order lists',async()=>{
  const responses=[undefined,{list:[]},[{id:'conditional-close-all',symbol:'ONE/USDT:USDT',quantity:0,kind:'conditional'}]];
  for(const response of responses){
    const f=completedManualFixture();await f.authorize();const before=JSON.stringify(f.one);
    f.setOpenOrdersHook(()=>response);await assert.rejects(f.engine.reconcileSelectedPositions(f.currentRequest()),/挂单/);
    assert.equal(JSON.stringify(f.one),before);assert.equal(f.calls.filter(call=>call.includes(':inspect:')).length,4);
    assert.equal(f.calls.filter(call=>call.endsWith(':account')).length,2);assert.deepEqual(f.mutations,[]);
  }
});

test('post-inspection account changes in quantities, slots, margin or cycle leave the manual source unadopted',async()=>{
  const mutations:Array<(account:AccountState)=>void>=[
    account=>{account.positions.find(row=>row.base==='ONE')!.quantity--;},
    account=>{account.positions.find(row=>row.base==='ONE')!.positionId='replacement';},
    account=>{account.positions.find(row=>row.base==='ONE')!.marginMode='isolated';},
    account=>{account.positions.find(row=>row.base==='ONE')!.positionOpenedAt=Date.now();},
  ];
  for(const mutate of mutations){
    const f=completedManualFixture();await f.authorize();const before=JSON.stringify(f.one);
    f.setAccountHook((exchange,count)=>{if(exchange==='gate'&&count===2)mutate(f.accounts.get(exchange)!);});
    await assert.rejects(f.engine.reconcileSelectedPositions(f.currentRequest()));assert.equal(JSON.stringify(f.one),before);
    assert.equal(f.calls.filter(call=>call.endsWith(':account')).length,4);assert.deepEqual([...(f.engine as any).reconciledPositions],[]);
  }
});

test('awaited native cash verification cannot cross source intent, historical audit or accounting scope changes',async()=>{
  const mutations:Array<(f:ReturnType<typeof completedManualFixture>)=>void>=[
    f=>{f.operation.error='changed operation evidence';},f=>{f.one.closeReason='different explicit intent';},
    f=>{f.one.feeOnly=false;},f=>{f.one.currentManagementRestorationHistory=[];},
    f=>{(f.engine as any).sessionExchanges.delete('gate');},
  ];
  for(const mutate of mutations){
    const f=completedManualFixture();await f.authorize();let changed=false;
    f.setOrderHook((_request,_id,order)=>{if(!changed){changed=true;mutate(f);}return {...structuredClone(order.result!),orderReadAt:Date.now()};});
    await assert.rejects(f.engine.reconcileSelectedPositions(f.currentRequest()));
    assert.equal(f.one.status,'attention');assert.equal(f.one.manualCloseOnly,true);assert.equal(f.one.closeProfitRequired,false);
    assert.deepEqual([...(f.engine as any).reconciledPositions],[]);assert.deepEqual(f.mutations,[]);
  }
});

test('failed persistence restores the manual intent, original frozen notional, audit and manager registry atomically',async()=>{
  for(const legacyMissingNotional of [false,true]){
    const f=completedManualFixture();if(legacyMissingNotional)delete f.one.profitExitNotionalUsd;
    await f.authorize();f.failNextFinalSave();const before=structuredClone(f.one),ordersBefore=JSON.stringify(f.ledger.orders),operationsBefore=JSON.stringify(f.ledger.manualCloseOperations);
    await assert.rejects(f.engine.reconcileSelectedPositions(f.currentRequest()),/storage interruption/);
    assert.deepEqual(JSON.parse(JSON.stringify(f.one)),before);assert.equal(JSON.stringify(f.ledger.orders),ordersBefore);assert.equal(JSON.stringify(f.ledger.manualCloseOperations),operationsBefore);
    assert.deepEqual([...(f.engine as any).reconciledPositions],[]);assert.deepEqual(f.mutations,[]);
  }
});

test('unverified native order summary requires independent original execution cash before restoration',async()=>{
  const f=completedManualFixture();await f.authorize();
  const target=f.ledger.orders.find(order=>order.positionId===f.one.id&&order.exchange==='bybit'&&!order.request.reduceOnly)!;
  f.setOrderHook((_request,_id,order)=>({...structuredClone(order.result!),averagePriceVerified:order!==target,orderReadAt:Date.now()}));
  f.adapters.find(adapter=>adapter.id==='bybit')!.verifyOrderExecution=async()=>{throw new Error('Reduction proof must not inspect an opening order');};
  f.adapters.find(adapter=>adapter.id==='bybit')!.verifyOpeningExecution=async(request,nativeId)=>{
    assert.deepEqual(request,target.request);assert.equal(nativeId,target.result!.id);
    f.calls.push(`bybit:verify:${request.clientOrderId}`);return {...structuredClone(target.result!),averagePriceVerified:true,orderReadAt:Date.now()};
  };
  await f.engine.reconcileSelectedPositions(f.currentRequest());assert.equal(f.one.status,'open');
  assert.equal(f.calls.filter(call=>call.includes(':verify:')).length,1);assert.equal(f.calls.filter(call=>call.includes(':inspect:')).length,4);
  assert.deepEqual(f.mutations,[]);
});

function appendHistoricalMaker(f:ReturnType<typeof completedManualFixture>){
  const clientOrderId='old-terminal-maker-client',journal:JournalOrder={positionId:f.one.id,exchange:'bybit',createdAt:f.operation.createdAt-1000,
    request:{clientOrderId,base:f.one.base,symbol:f.one.long.symbol,side:'sell',quantity:10,limitPrice:f.one.long.entryPrice,reduceOnly:true,postOnly:true},
    result:{id:'old-terminal-maker-native',clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,averagePriceVerified:true,
      feeUsd:0,timestamp:f.operation.createdAt-900},
    makerReduction:{activity:'terminal',makerLeg:'long',deadlineAt:f.operation.createdAt-500,bookedExecution:true},
    executionEvidence:{version:1,method:'maker',role:'exit',batchId:'historical-maker-close',bookedFeeUsd:0}};
  f.ledger.orders.push(journal);return journal;
}

test('historical terminal Maker is read with the original Maker inspection path without replaying or changing it',async()=>{
  const f=completedManualFixture();await f.authorize();const maker=appendHistoricalMaker(f),before=JSON.stringify(f.ledger.orders);
  f.adapters.find(adapter=>adapter.id==='bybit')!.inspectMakerReduction=async(request,nativeId)=>{
    assert.deepEqual(request,maker.request);assert.equal(nativeId,maker.result!.id);
    f.calls.push(`bybit:maker:${request.clientOrderId}`);
    return {activity:'terminal',executionVerified:true,observedAt:Date.now(),result:structuredClone(maker.result!)};
  };
  await f.engine.reconcileSelectedPositions(f.currentRequest());assert.equal(f.one.status,'open');
  assert.equal(f.calls.filter(call=>call.includes(':maker:')).length,1);assert.equal(f.calls.filter(call=>call.includes(':inspect:')).length,4);
  assert.equal(JSON.stringify(f.ledger.orders),before);assert.equal(f.one.currentManagementRestorationHistory![0].originalOrderIds.length,5);
  assert.deepEqual(f.mutations,[]);
});

test('a historical Maker needs independently verified terminal cash and a fresh exact native identity',async()=>{
  for(const failure of ['active','unverified','stale','foreign'] as const){
    const f=completedManualFixture();await f.authorize();const maker=appendHistoricalMaker(f),before=JSON.stringify(f.one);
    f.adapters.find(adapter=>adapter.id==='bybit')!.inspectMakerReduction=async()=>({
      activity:failure==='active'?'active':'terminal',executionVerified:failure!=='unverified',
      observedAt:Date.now()-(failure==='stale'?1000:0),result:{...structuredClone(maker.result!),id:failure==='foreign'?'foreign-native':maker.result!.id}});
    await assert.rejects(f.engine.reconcileSelectedPositions(f.currentRequest()),/Maker|原生终态|真实现金/);
    assert.equal(JSON.stringify(f.one),before);assert.deepEqual([...(f.engine as any).reconciledPositions],[]);assert.deepEqual(f.mutations,[]);
  }
});

test('manual-source restoration never treats a slow cached account result as a new independent proof',async t=>{
  let clock=Date.now();t.mock.method(Date,'now',()=>clock);
  const f=completedManualFixture();await f.authorize();const before=JSON.stringify(f.one);
  f.setAccountHook((exchange,count)=>{if(exchange==='bybit'&&count===1)clock+=f.ledger.config.maxSnapshotAgeMs+1;});
  await assert.rejects(f.engine.reconcileSelectedPositions(f.currentRequest()),/过期|新鲜|不完整/);
  assert.equal(JSON.stringify(f.one),before);assert.equal(f.one.currentManagementRestorationHistory,undefined);
  assert.deepEqual([...(f.engine as any).reconciledPositions],[]);assert.deepEqual(f.mutations,[]);
});

test('two consistent replacement account observations cannot replace the original completed manual selection',async()=>{
  const replacements:Array<(account:AccountState,p:Position)=>void>=[
    account=>{account.positions.find(row=>row.base==='ONE')!.positionId='different-native-slot';},
    account=>{account.positions.find(row=>row.base==='ONE')!.marginMode='isolated';},
    (account,p)=>{account.positions.find(row=>row.base==='ONE')!.positionOpenedAt=p.openedAt+1100;},
    (account,p)=>{account.positions.find(row=>row.base==='ONE')!.positionOpenedAt=p.openedAt-6000;},
    account=>{delete account.positions.find(row=>row.base==='ONE')!.positionId;},
  ];
  for(const replace of replacements){
    const f=completedManualFixture();await f.authorize();replace(f.accounts.get('bybit')!,f.one);
    // Every GET clones this same replacement row: equality between independent reads alone is insufficient.
    const before=JSON.stringify(f.one),ordersBefore=JSON.stringify(f.ledger.orders),operationBefore=JSON.stringify(f.operation);
    await assert.rejects(f.engine.reconcileSelectedPositions(f.currentRequest()),/身份|账户|周期|原手动/);
    assert.equal(JSON.stringify(f.one),before);assert.equal(JSON.stringify(f.ledger.orders),ordersBefore);
    assert.equal(JSON.stringify(f.operation),operationBefore);assert.equal(f.one.currentManagementRestorationHistory,undefined);
    assert.deepEqual([...(f.engine as any).reconciledPositions],[]);assert.deepEqual(f.mutations,[]);
  }
});

function beginPendingAccountPoll(f:ReturnType<typeof fixture>){
  const adapter=f.adapters.find(adapter=>adapter.id==='bybit')!,fetch=adapter.fetchAccount.bind(adapter),wrong=structuredClone(f.accounts.get('bybit')!);
  wrong.positions.find(row=>row.base==='ONE')!.quantity++;
  let release!:(account:AccountState)=>void,reject!:(error:Error)=>void,started!:()=>void,first=true;
  const pending=new Promise<AccountState>((resolve,fail)=>{release=resolve;reject=fail;}),entered=new Promise<void>(resolve=>{started=resolve;});
  adapter.fetchAccount=async()=>{if(first){first=false;f.calls.push('bybit:background-account');started();return pending;}return fetch();};
  const internal=f.engine as unknown as {readTradingAccount(adapter:ExchangeAdapter):Promise<AccountState>},
    background=internal.readTradingAccount(adapter).then(account=>account,()=>undefined);
  return {adapter,internal,background,entered,wrong,release:()=>release(wrong),reject:()=>reject(new Error('Offline old account poll failed'))};
}

test('scoped recovery drains an existing account poll without reusing its wrong quantity and still requires two fresh rounds',async t=>{
  for(const failure of [false,true]){
    const f=completedManualFixture();await f.authorize();
    const active=beginPendingAccountPoll(f);await active.entered;t.after(async()=>{active.release();await active.background;});
    await assert.rejects(active.internal.readTradingAccount(active.adapter),/上次只读请求尚未结束/);
    assert.equal(f.calls.filter(call=>call==='bybit:background-account').length,1);
    let accountStarted!:()=>void;const firstAccount=new Promise<void>(resolve=>{accountStarted=resolve;});
    f.setAccountHook((exchange,count)=>{if(exchange==='gate'&&count===1)accountStarted();});
    const recovery=f.engine.reconcileSelectedPositions(f.currentRequest());await firstAccount;
    assert.equal(f.one.status,'attention');assert.equal(f.one.currentManagementRestorationHistory,undefined);
    assert.equal(f.calls.filter(call=>call==='bybit:account').length,0);
    if(failure)active.reject();else active.release();
    const old=await active.background;if(!failure)assert.equal(old!.positions.find(row=>row.base==='ONE')!.quantity,1001);
    await recovery;assert.equal(f.one.status,'open');assert.equal(f.one.long.quantity,1000);assert.equal(f.one.short.quantity,1000);
    assert.equal(f.calls.filter(call=>call==='bybit:account').length,2);assert.equal(f.calls.filter(call=>call==='gate:account').length,2);
    assert.equal(f.calls.filter(call=>call.includes(':orders:')).length,2);assert.equal(f.calls.filter(call=>call.includes(':inspect:')).length,4);
    assert.equal(f.engine.accounts.get('bybit')!.positions.find(row=>row.base==='ONE')!.quantity,1000);
    assert.deepEqual(f.mutations,[]);
  }
});

test('authorization or session changes while a scoped account wait is pending cancel its fresh reads and adoption',async t=>{
  for(const change of ['permission','generation'] as const){
    const f=completedManualFixture();await f.authorize();const before=JSON.stringify(f.one),orders=JSON.stringify(f.ledger.orders),
      poll=beginPendingAccountPoll(f);await poll.entered;t.after(async()=>{poll.release();await poll.background;});
    let accountStarted!:()=>void;const firstAccount=new Promise<void>(resolve=>{accountStarted=resolve;});
    f.setAccountHook((exchange,count)=>{if(exchange==='gate'&&count===1)accountStarted();});
    const recovery=f.engine.reconcileSelectedPositions(f.currentRequest()),rejected=assert.rejects(recovery,/会话实盘授权|运行状态|已变化/);
    await firstAccount;const internal=f.engine as unknown as {sessionLivePermission:boolean;startGeneration:number};
    if(change==='permission')internal.sessionLivePermission=false;else internal.startGeneration++;
    poll.release();await poll.background;await rejected;
    assert.equal(f.calls.filter(call=>call==='bybit:account').length,0);assert.equal(JSON.stringify(f.one),before);
    assert.equal(JSON.stringify(f.ledger.orders),orders);assert.deepEqual([...(f.engine as any).reconciledPositions],[]);assert.deepEqual(f.mutations,[]);
  }
});

test('a scoped account wait timeout retains the old active request and never starts an overlapping fresh read',async t=>{
  const f=completedManualFixture({privateReadDeadlineMs:30});await f.authorize();const before=JSON.stringify(f.one),orders=JSON.stringify(f.ledger.orders),
    cached=JSON.stringify(f.engine.accounts.get('bybit')),poll=beginPendingAccountPoll(f);await poll.entered;
  t.after(async()=>{poll.release();await poll.background;});
  await assert.rejects(f.engine.reconcileSelectedPositions(f.currentRequest()),/原账户只读请求仍未结束/);
  assert.equal(f.calls.filter(call=>call==='bybit:account').length,0);
  await assert.rejects(poll.internal.readTradingAccount(poll.adapter),/上次只读请求尚未结束/);
  assert.equal(f.calls.filter(call=>call==='bybit:background-account').length,1);assert.equal(JSON.stringify(f.one),before);
  assert.equal(JSON.stringify(f.ledger.orders),orders);assert.equal(JSON.stringify(f.engine.accounts.get('bybit')),cached);
  assert.deepEqual([...(f.engine as any).reconciledPositions],[]);assert.deepEqual(f.mutations,[]);
  poll.release();await poll.background;await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(JSON.stringify(f.engine.accounts.get('bybit')),cached);assert.equal(JSON.stringify(f.one),before);
});

/** ERA-style restart: matched original exposure, an immutable native zero history,
 * and a later local no-send intent. Every financial transport remains in memory. */
function durableZeroContinuationFixture(){
  const f=provenNoSendFixture(),now=Date.now(),p=f.one;
  const zeros:JournalOrder[]=[],positiveReductions:JournalOrder[]=[];
  for(const [index,leg] of [p.long,p.short].entries()){
    const opening=f.ledger.orders.find(order=>order.positionId===p.id&&order.exchange===leg.exchange&&!order.request.reduceOnly)!;
    opening.request.quantity+=10;opening.result!.filledQuantity+=10;
    const createdAt=now-28_000+index,clientOrderId=`original-native-zero-${leg.exchange}`;
    const zero:JournalOrder={positionId:p.id,exchange:leg.exchange,createdAt,
      request:{clientOrderId,base:p.base,symbol:leg.symbol,side:leg.side==='long'?'sell':'buy',quantity:1000,
        limitPrice:leg.entryPrice,reduceOnly:true,postOnly:true},
      result:{id:`native-terminal-zero-${leg.exchange}`,clientOrderId,status:'cancelled',filledQuantity:0,
        averagePrice:0,averagePriceVerified:true,feeUsd:0,timestamp:createdAt+400,
        ...(leg.exchange==='bybit'?{rejectionCode:'EC_PerCancelRequest',rejectionReason:'Native user cancellation'}:{})},
      makerReduction:{activity:'terminal',makerLeg:leg.side,bookedExecution:true,deadlineAt:createdAt+1000,
        submittedAt:createdAt+100,acknowledgedAt:createdAt+200,cancelRequestedAt:createdAt+300,lastObservedAt:createdAt+400,
        observationQueuedAt:createdAt+410,observationCommitStartedAt:createdAt+420,observationCommittedAt:createdAt+430,
        finishedAt:createdAt+440,quantityStep:1,peerQuantityStep:1},
      executionEvidence:{version:1,method:'maker',role:'exit',batchId:`original-zero-close-${index}`,
        submittedAt:createdAt+100,bookedFeeUsd:0}};
    zeros.push(zero);f.ledger.orders.push(zero);
    const positiveClientId=`original-positive-reduction-${leg.exchange}`,feeUsd=.001;
    const positive:JournalOrder={positionId:p.id,exchange:leg.exchange,createdAt:now-20_000,
      request:{clientOrderId:positiveClientId,base:p.base,symbol:leg.symbol,side:leg.side==='long'?'sell':'buy',
        quantity:10,limitPrice:leg.entryPrice,reduceOnly:true},
      result:{id:`native-${positiveClientId}`,clientOrderId:positiveClientId,status:'filled',filledQuantity:10,
        averagePrice:leg.entryPrice,averagePriceVerified:true,feeUsd,timestamp:now-19_000},
      executionEvidence:{version:1,method:'ioc',role:'exit',batchId:'original-positive-close',bookedFeeUsd:feeUsd}};
    positiveReductions.push(positive);f.ledger.orders.push(positive);leg.feesUsd+=feeUsd;
    f.adapters.find(adapter=>adapter.id===leg.exchange)!.inspectMakerReduction=async(request,nativeId)=>{
      f.calls.push(`${leg.exchange}:maker:${request.clientOrderId}`);
      assert.equal(nativeId,zeros.find(order=>order.request.clientOrderId===request.clientOrderId)!.result!.id);
      throw new Error('Offline native retained history expired');
    };
  }
  p.feesUsd=p.long.feesUsd+p.short.feesUsd;
  return {...f,zeros,positiveReductions};
}

test('selected current restoration retains old terminal zero cash and resumes only the matched original manager',async()=>{
  const f=durableZeroContinuationFixture();await f.authorize();
  const before=structuredClone(f.one),orders=JSON.stringify(f.ledger.orders),others=JSON.stringify([f.other,f.unknownPosition]);
  const result=await f.engine.reconcileSelectedPositions(selectedReconcileSchema.parse(f.currentRequest()));
  assert.deepEqual(result.positionIds,[f.one.id]);assert.equal(f.one.status,'open');assert.equal(f.engine.autoEnabled,false);
  assert.equal(JSON.stringify(f.ledger.orders),orders);assert.equal(JSON.stringify([f.other,f.unknownPosition]),others);
  assert.equal(f.calls.filter(call=>call.includes(':maker:')).length,0,'durably booked native zero cash needs no retention-dependent requery');
  assert.equal(f.calls.filter(call=>call.includes(':inspect:')).length,4,'both positive openings and both positive reductions still require fresh exact native cash');
  for(const positive of f.positiveReductions)assert.ok(f.calls.some(call=>call.includes(`:inspect:${positive.request.clientOrderId}`)));
  assert.equal(f.calls.filter(call=>call.endsWith(':account')).length,4);assert.equal(f.calls.filter(call=>call.includes(':orders:')).length,2);
  const history=f.one.automaticCloseHistory!;
  assert.equal(history.length,before.automaticCloseHistory!.length+1);assert.deepEqual(history[0],before.automaticCloseHistory![0]);
  assert.deepEqual(history.at(-1)!.confirmedZeroOrders,f.zeros.map(order=>({exchange:order.exchange,symbol:order.request.symbol,
    clientOrderId:order.request.clientOrderId,nativeOrderId:order.result!.id,
    observedAt:order.makerReduction!.lastObservedAt!,committedAt:order.makerReduction!.observationCommittedAt!})));
  for(const field of ['long','short','fundingUsd','feesUsd','realizedSpreadPnlUsd','fundingEvents','profitExitNotionalUsd','entryPolicy','holdMode'] as const)
    assert.deepEqual(f.one[field],before[field]);
  assert.equal(f.one.closeRequestedAt,undefined);assert.equal(f.one.closePauseReason,undefined);
  assert.deepEqual([...(f.engine as any).reconciledPositions],[f.one.id]);assert.deepEqual(f.mutations,[]);
});

test('incomplete durable zero proof requires the original native lookup and retention failure preserves attention',async()=>{
  const lifecycle:Array<keyof NonNullable<JournalOrder['makerReduction']>>=['submittedAt','acknowledgedAt','cancelRequestedAt',
    'lastObservedAt','observationQueuedAt','observationCommitStartedAt','observationCommittedAt','finishedAt'];
  const mutations:Array<(order:JournalOrder)=>void>=[...lifecycle.map(field=>(order:JournalOrder)=>{delete order.makerReduction![field];}),
    order=>{delete order.executionEvidence;},order=>{delete order.executionEvidence!.submittedAt;},
    order=>{delete order.executionEvidence!.bookedFeeUsd;},order=>{order.executionEvidence!.batchId='';},
    order=>{order.result!.averagePriceVerified=false;},order=>{order.makerReduction!.bookedExecution=false;}];
  for(const [index,mutate] of mutations.entries()){
    const f=durableZeroContinuationFixture();await f.authorize();mutate(f.zeros[0]);
    const before=JSON.stringify(f.one),orders=JSON.stringify(f.ledger.orders);
    await assert.rejects(f.engine.reconcileSelectedPositions(f.currentRequest()),/retained history expired/,`proof case ${index}`);
    assert.ok(f.calls.includes(`bybit:maker:${f.zeros[0].request.clientOrderId}`),`missing proof case ${index} bypassed the original native lookup`);
    assert.equal(JSON.stringify(f.one),before);assert.equal(JSON.stringify(f.ledger.orders),orders);
    assert.equal(f.one.status,'attention');assert.deepEqual([...(f.engine as any).reconciledPositions],[]);assert.deepEqual(f.mutations,[]);
  }
});

test('durable zero history cannot bypass fresh positive cash, explicit current acknowledgement or exact selection',async()=>{
  for(const failure of ['cash','generic-ack','changed-quantity','expired','unknown'] as const){
    const f=durableZeroContinuationFixture();await f.authorize();const request=f.currentRequest();
    if(failure==='cash')f.setOrderHook((_request,_id,order)=>({...structuredClone(order.result!),
      feeUsd:order===f.positiveReductions[0]?order.result!.feeUsd+.001:order.result!.feeUsd,orderReadAt:Date.now()}));
    if(failure==='generic-ack')request.acknowledgement='RECONCILE_SELECTED_POSITIONS';
    if(failure==='changed-quantity')request.expected[0].longQuantity++;
    if(failure==='expired')request.expiresAt=Date.now()-1;
    if(failure==='unknown'){
      const unknown=structuredClone(f.noSend);unknown.request.clientOrderId='another-unconfirmed-original';
      unknown.result!.clientOrderId=unknown.request.clientOrderId;unknown.result!.status='unknown';f.ledger.orders.push(unknown);
    }
    const before=JSON.stringify(f.one),orders=JSON.stringify(f.ledger.orders);
    await assert.rejects(f.engine.reconcileSelectedPositions(request),`guard case ${failure}`);
    assert.equal(JSON.stringify(f.one),before);assert.equal(JSON.stringify(f.ledger.orders),orders);
    assert.equal(f.one.status,'attention');assert.deepEqual([...(f.engine as any).reconciledPositions],[]);assert.deepEqual(f.mutations,[]);
    if(failure==='cash')assert.ok(f.calls.some(call=>call.includes(`:inspect:${f.positiveReductions[0].request.clientOrderId}`)));
    else assert.deepEqual(f.calls,[],'an invalid selection cannot begin any native read');
  }
});

test('durable zero restoration still rejects changing account identity, quantities and incomplete or active order lists',async()=>{
  for(const failure of ['identity','quantity','open-order','incomplete-open-orders'] as const){
    const f=durableZeroContinuationFixture();await f.authorize();const before=JSON.stringify(f.one),orders=JSON.stringify(f.ledger.orders);
    if(failure==='identity'||failure==='quantity')f.setAccountHook((exchange,count)=>{
      if(exchange==='gate'&&count===2){const row=f.accounts.get(exchange)!.positions.find(row=>row.base===f.one.base)!;
        if(failure==='identity')row.positionId='replacement-account-slot';else row.quantity--;}
    });
    if(failure==='open-order')f.setOpenOrdersHook(()=>[{id:'unknown-conditional-close',symbol:f.one.long.symbol,quantity:0,kind:'conditional'}]);
    if(failure==='incomplete-open-orders')f.setOpenOrdersHook(()=>undefined);
    await assert.rejects(f.engine.reconcileSelectedPositions(f.currentRequest()),/身份|数量|账户|挂单/);
    assert.equal(JSON.stringify(f.one),before);assert.equal(JSON.stringify(f.ledger.orders),orders);
    assert.deepEqual([...(f.engine as any).reconciledPositions],[]);assert.deepEqual(f.mutations,[]);
    assert.equal(f.calls.filter(call=>call.includes(':maker:')).length,0);
  }
});

test('durable zero restoration save failure rolls back its status, intent, audit and manager registry',async()=>{
  const f=durableZeroContinuationFixture();await f.authorize();f.failNextFinalSave();
  const before=structuredClone(f.one),orders=JSON.stringify(f.ledger.orders),others=JSON.stringify([f.other,f.unknownPosition]);
  await assert.rejects(f.engine.reconcileSelectedPositions(f.currentRequest()),/storage interruption/);
  assert.deepEqual(JSON.parse(JSON.stringify(f.one)),before);assert.equal(JSON.stringify(f.ledger.orders),orders);
  assert.equal(JSON.stringify([f.other,f.unknownPosition]),others);assert.equal(f.one.status,'attention');
  assert.deepEqual([...(f.engine as any).reconciledPositions],[]);assert.deepEqual(f.mutations,[]);
});

test('an explicitly restored zero-history position enters normal current-policy profit routing without replaying old intents',async()=>{
  const f=durableZeroContinuationFixture();await f.authorize();
  const routed:Array<{id:string;reason:string}>=[],internal=f.engine as unknown as {
    realtimeProfitCandidate(position:Position):boolean;managePosition(position:Position,now:number):Promise<void>;
    continueClosing(position:Position,reason:string):Promise<void>};
  internal.continueClosing=async(position,reason)=>{routed.push({id:position.id,reason});};
  f.engine.running=true;
  for(const leg of [f.one.long,f.one.short]){
    leg.fundingObservedSince=f.one.openedAt;leg.fundingObservedAt=Date.now();
    const quote=f.engine.snapshots.find(quote=>quote.exchange===leg.exchange&&quote.base===f.one.base)!;
    const bid=leg.side==='long'?.103:.1;
    Object.assign(quote,{timestamp:Date.now(),observedAt:Date.now(),fundingObservedAt:Date.now(),bookTransport:'websocket',
      bids:[{price:bid,quantity:10000}],asks:[{price:bid+.0001,quantity:10000}],
      takerFeeRate:.0005,takerFeeSource:'exchange',takerFeeAt:Date.now(),makerFeeRate:.0002,makerFeeSource:'exchange',makerFeeAt:Date.now()});
    const adapter=f.adapters.find(adapter=>adapter.id===leg.exchange)!;
    adapter.supportsMakerReduction=()=>true;adapter.validateMakerReduction=async()=>{};
    adapter.submitMakerReduction=async()=>{assert.fail('Only the normal management route is observed; no execution is allowed');};
    adapter.cancelMakerReduction=async()=>{assert.fail('Original historical zero must never be cancelled or replayed');};
    f.engine.health.find(health=>health.exchange===leg.exchange)!.status='online';
  }
  f.one.profitExitPolicy={firstFundingTime:Date.now()+3_600_000,earliestExitAt:Date.now()+3_610_000,
    minSpreadNetUsd:0,minCombinedNetUsd:0,fundingChecks:[f.one.long,f.one.short].map(leg=>({exchange:leg.exchange,timestamp:Date.now()+3_600_000}))};
  assert.equal(internal.realtimeProfitCandidate(f.one),false,'a profitable historical attention record is not automatically adopted');
  await internal.managePosition(f.one,Date.now());assert.equal(routed.length,0);
  await f.engine.reconcileSelectedPositions(f.currentRequest());
  const orders=JSON.stringify(f.ledger.orders);
  assert.equal(internal.realtimeProfitCandidate(f.one),true,'the explicitly restored ordinary open manager participates in profit discovery');
  await internal.managePosition(f.one,Date.now());
  assert.equal(f.one.holdDecision?.action,'close');assert.equal(f.one.holdDecision?.exitSignal,'profit');
  assert.equal(routed.length,1);assert.equal(routed[0].id,f.one.id);assert.match(routed[0].reason,/净收益|净利润/);
  assert.equal(JSON.stringify(f.ledger.orders),orders);assert.deepEqual(f.mutations,[]);
});

function completedIocConditionalFixture(venues?:ExchangeId[]){
  const f=fixture({venues}),p=f.one,now=Date.now();f.ledger.config.holdMode='adaptive';f.ledger.config.profitExitExecutionMode='ioc';
  p.status='attention';p.automaticEntry=true;p.feeOnly=true;p.entryPolicy='aligned';p.holdMode='adaptive';
  p.executionEvidence={version:1,method:'ioc',entryPath:'single-cycle'};
  p.closeRequestedAt=now-15_000;p.closeAttemptedAt=now-10_000;p.closeReason='Original matched IOC profit exit above 10 bps';
  p.closeProfitRequired=true;p.closePricing='best-opposite';p.closePauseReason='Original conditional account-proof wait';
  p.long.quantity=5;p.short.quantity=5;p.profitExitNotionalUsd=(5.2*p.long.entryPrice+5.2*p.short.entryPrice)/2;
  p.automaticCloseHistory=[{requestedAt:now-35_000,suspendedAt:now-30_000,reason:'Original older archival record',
    suspensionReason:'Earlier independent pause',pricing:'best-opposite',longQuantity:5.2,shortQuantity:5.2}];
  const own:JournalOrder[]=[];
  const make=(leg:Position['long'],quantity:number,reduceOnly:boolean,index:number,noSubmit=false,zeroNative=false):JournalOrder=>{
    const clientOrderId=`ioc-restore-original-${index}`,createdAt=reduceOnly?now-12_000+index*10:p.openedAt+1000+index*10,
      price=reduceOnly?(leg.side==='long'?.102:.100):leg.entryPrice,filled=noSubmit||zeroNative?0:quantity,feeUsd=filled*price*.001;
    return {positionId:p.id,exchange:leg.exchange,createdAt,
      request:{clientOrderId,base:p.base,symbol:leg.symbol,side:reduceOnly?(leg.side==='long'?'sell':'buy'):(leg.side==='long'?'buy':'sell'),
        quantity,limitPrice:price,reduceOnly},
      result:{id:noSubmit?'':`native-ioc-restore-original-${index}`,clientOrderId,status:noSubmit||zeroNative?'cancelled':'filled',
        filledQuantity:filled,averagePrice:filled?price:0,averagePriceVerified:true,feeUsd,timestamp:createdAt+1,
        ...(noSubmit?{rejectionCode:'IOC_REDUCTION_PERMISSION_CHANGED'}:{})},
      executionEvidence:{version:1,method:'ioc',role:reduceOnly?(leg.side==='long'?'exit':'exit-tail'):(leg.side==='long'?'hedge':'entry'),
        batchId:reduceOnly?`${p.id}:ioc-close:original-${index}`:`${p.id}:entry-original`,bookedFeeUsd:feeUsd}};
  };
  let index=0;
  for(const leg of [p.long,p.short])for(const quantity of [2.2,.8,.7,1.5])own.push(make(leg,quantity,false,index++));
  own.push(make(p.long,.1,false,index++,false,true));
  own.push(make(p.long,.2,true,index++,true));own.push(make(p.short,.2,true,index++,true));own.push(make(p.short,.2,true,index++,true));
  own.push(make(p.long,.2,true,index++));own.push(make(p.short,.2,true,index++));
  for(const leg of [p.long,p.short]){
    const rows=own.filter(order=>order.exchange===leg.exchange);
    leg.feesUsd=rows.reduce((sum,order)=>sum+order.result!.feeUsd,0);
    leg.realizedPnlUsd=rows.filter(order=>order.request.reduceOnly).reduce((sum,order)=>sum+order.result!.filledQuantity*
      (leg.side==='long'?order.result!.averagePrice-leg.entryPrice:leg.entryPrice-order.result!.averagePrice),0);
    for(const row of f.accounts.get(leg.exchange)!.positions)if(row.base===p.base)row.quantity=5;
  }
  p.feesUsd=p.long.feesUsd+p.short.feesUsd;p.realizedSpreadPnlUsd=p.long.realizedPnlUsd!+p.short.realizedPnlUsd!;
  f.ledger.orders=f.ledger.orders.filter(order=>order.positionId!==p.id).concat(own);
  for(const quote of f.engine.snapshots.filter(quote=>quote.base===p.base))quote.quantityStep=.1;
  f.setOrderHook((_request,_id,order)=>({...structuredClone(order.result!),orderReadAt:Date.now()}));
  return {...f,own,currentRequest:():SelectedReconcileRequest=>({...f.request(),acknowledgement:'RECONCILE_CURRENT_STRATEGY_POSITIONS'})};
}

test('CURRENT acknowledgement restores only exact matched IOC remainder after eleven native cash proofs and two fresh account rounds',async()=>{
  const f=completedIocConditionalFixture();await f.authorize();const before=structuredClone(f.one),orders=JSON.stringify(f.ledger.orders),
    unselected=JSON.stringify([f.other,f.unknownPosition]),funding=JSON.stringify(f.ledger.fundingSeen);
  await assert.rejects(f.engine.reconcileSelectedPositions(f.request()),/身份|处理状态/);assert.equal(f.calls.length,0);
  const result=await f.engine.reconcileSelectedPositions(f.currentRequest());assert.deepEqual(result.positionIds,[f.one.id]);
  assert.equal(f.one.status,'open');assert.equal(f.engine.autoEnabled,false);assert.equal(f.one.automaticCloseHistory!.length,2);
  assert.deepEqual(f.one.automaticCloseHistory![0],before.automaticCloseHistory![0]);
  const archived=f.one.automaticCloseHistory![1],audit=archived.iocRestoration!;assert.ok(audit);
  assert.equal(archived.requestedAt,before.closeRequestedAt);assert.equal(archived.attemptedAt,before.closeAttemptedAt);
  assert.equal(archived.reason,before.closeReason);assert.equal(archived.pricing,before.closePricing);
  assert.deepEqual(audit.previousCloseIntent,{requestedAt:before.closeRequestedAt,attemptedAt:before.closeAttemptedAt,reason:before.closeReason,
    pricing:'best-opposite',profitRequired:true,pauseReason:before.closePauseReason});
  assert.equal(audit.profitExitNotionalUsd,before.profitExitNotionalUsd);assert.equal(audit.originalOrders.length,14);
  assert.equal(audit.originalOrders.filter(order=>order.localNoSubmit).length,3);
  assert.equal(audit.originalOrders.filter(order=>order.nativeObservedAt!==undefined).length,11);
  for(const proof of audit.originalOrders){const original=f.own.find(order=>order.request.clientOrderId===proof.clientOrderId)!;
    assert.equal(proof.nativeOrderId,original.result!.id);assert.equal(proof.status,original.result!.status);
    assert.equal(proof.filledQuantity,original.result!.filledQuantity);assert.equal(proof.averagePrice,original.result!.averagePrice);
    assert.equal(proof.feeUsd,original.result!.feeUsd);assert.equal(proof.bookedFeeUsd,original.executionEvidence!.bookedFeeUsd);
  }
  for(const field of ['closeRequestedAt','closeAttemptedAt','closeReason','closePricing','closeProfitRequired','closePauseReason'] as const)
    assert.equal(f.one[field],undefined);
  for(const field of ['profitExitNotionalUsd','long','short','feesUsd','fundingUsd','fundingEvents','transferCostUsd','realizedSpreadPnlUsd',
    'entryPolicy','holdMode','automaticEntry','executionEvidence'] as const)assert.deepEqual(f.one[field],before[field]);
  assert.equal(JSON.stringify(f.ledger.orders),orders);assert.equal(JSON.stringify([f.other,f.unknownPosition]),unselected);
  assert.equal(JSON.stringify(f.ledger.fundingSeen),funding);assert.equal(f.calls.filter(call=>call.includes(':inspect:')).length,11);
  assert.equal(f.calls.filter(call=>call.endsWith(':account')).length,4);assert.equal(f.calls.filter(call=>call.includes(':orders:')).length,2);
  assert.deepEqual(f.mutations,[]);assert.deepEqual([...(f.engine as any).reconciledPositions],[f.one.id]);
});

test('CURRENT IOC restoration cannot adopt an active closing/open manager, worker, unknown receipt or incomplete original cash',async()=>{
  const changes:Array<(f:ReturnType<typeof completedIocConditionalFixture>)=>void>=[
    f=>{f.one.status='closing';},f=>{f.one.status='open';},
    f=>{f.engine.execution.hasIocProfitClose=()=>true;},f=>{f.engine.execution.hasMakerClose=()=>true;},
    f=>{f.own[0].result!.status='unknown';},f=>{f.ledger.orders.splice(f.ledger.orders.indexOf(f.own[0]),1);},
    f=>{f.one.profitExitNotionalUsd!+=1;},f=>{f.one.manualCloseOnly=true;},
  ];
  for(const change of changes){const f=completedIocConditionalFixture();await f.authorize();change(f);
    const before=JSON.stringify(f.one),orders=JSON.stringify(f.ledger.orders);
    await assert.rejects(f.engine.reconcileSelectedPositions(f.currentRequest()));
    assert.equal(JSON.stringify(f.one),before);assert.equal(JSON.stringify(f.ledger.orders),orders);assert.deepEqual(f.calls,[]);assert.deepEqual(f.mutations,[]);
  }
});

test('CURRENT IOC restoration rejects changed native cash, identity, status, price or observation time without archiving the old intent',async()=>{
  const changes:Array<(result:OrderResult)=>void>=[
    result=>{result.feeUsd+=.001;},result=>{result.averagePrice+=.001;},result=>{result.filledQuantity-=.1;},
    result=>{result.id='changed-native-id';},result=>{result.status='cancelled';},
    result=>{result.averagePriceVerified=false;},result=>{result.orderReadAt=Date.now()-10000;},
    result=>{result.orderReadAt=Date.now()+10000;},result=>{delete result.orderReadAt;},
  ];
  for(const change of changes){const f=completedIocConditionalFixture();await f.authorize();
    f.setOrderHook((_request,_id,order)=>{const result={...structuredClone(order.result!),orderReadAt:Date.now()};change(result);return result;});
    const before=JSON.stringify(f.one),orders=JSON.stringify(f.ledger.orders);
    await assert.rejects(f.engine.reconcileSelectedPositions(f.currentRequest()),/原生终态|真实现金/);
    assert.equal(JSON.stringify(f.one),before);assert.equal(JSON.stringify(f.ledger.orders),orders);assert.deepEqual(f.mutations,[]);
    assert.equal(f.calls.filter(call=>call.endsWith(':account')).length,0,'failed original cash must precede native account adoption');
  }
});

test('CURRENT IOC restoration requires complete empty native orders and the same quantities across two account rounds',async()=>{
  for(const stage of ['orders','second-account'] as const){const f=completedIocConditionalFixture();await f.authorize();
    if(stage==='orders')f.setOpenOrdersHook(()=>[{id:'still-native-active'}]);
    else f.setAccountHook((exchange,count)=>{if(exchange==='bybit'&&count===2)f.accounts.get(exchange)!.positions.find(row=>row.base===f.one.base)!.quantity=4.9;});
    const before=JSON.stringify(f.one),orders=JSON.stringify(f.ledger.orders);
    await assert.rejects(f.engine.reconcileSelectedPositions(f.currentRequest()),stage==='orders'?/挂单/:/实际账户|数量/);
    assert.equal(JSON.stringify(f.one),before);assert.equal(JSON.stringify(f.ledger.orders),orders);assert.deepEqual(f.mutations,[]);
  }
});

test('CURRENT IOC restoration final-save failure restores the exact old intent, histories and manager scope',async()=>{
  const f=completedIocConditionalFixture();await f.authorize();const before=JSON.parse(JSON.stringify(f.one)),orders=JSON.stringify(f.ledger.orders),
    unselected=JSON.stringify([f.other,f.unknownPosition]);f.failNextFinalSave();
  await assert.rejects(f.engine.reconcileSelectedPositions(f.currentRequest()),/Offline storage/);
  assert.deepEqual(JSON.parse(JSON.stringify(f.one)),before);assert.equal(JSON.stringify(f.ledger.orders),orders);
  assert.equal(JSON.stringify([f.other,f.unknownPosition]),unselected);assert.equal(f.engine.autoEnabled,false);
  assert.equal((f.engine as any).reconciledPositions.has(f.one.id),false);assert.deepEqual(f.mutations,[]);
});

test('CURRENT multi-position restoration rolls back every original manager and intent on a synchronous later audit exception',async()=>{
  const f=completedIocConditionalFixture(),otherId=f.other.id,otherBase=f.other.base;
  const other=structuredClone(f.one);other.id=otherId;other.base=otherBase;
  for(const leg of [other.long,other.short])leg.symbol=`${otherBase}/USDT:USDT`;
  Object.assign(f.other,other);
  const otherOrders=f.own.map(original=>{
    const order=structuredClone(original);order.positionId=otherId;order.request.base=otherBase;order.request.symbol=`${otherBase}/USDT:USDT`;
    order.request.clientOrderId=`other-${order.request.clientOrderId}`;order.result!.clientOrderId=order.request.clientOrderId;
    if(order.result!.id)order.result!.id=`other-${order.result!.id}`;
    order.executionEvidence!.batchId=order.executionEvidence!.batchId.replace(f.one.id,otherId);return order;
  });
  f.ledger.orders=f.ledger.orders.filter(order=>order.positionId!==otherId).concat(otherOrders);
  for(const account of f.accounts.values())for(const row of account.positions)if(row.base===otherBase)row.quantity=5;
  for(const quote of f.engine.snapshots.filter(quote=>quote.base===otherBase))quote.quantityStep=.1;
  for(const adapter of f.adapters)adapter.inspectOrder=async(request,nativeId)=>{
    const original=f.ledger.orders.find(order=>[f.one.id,otherId].includes(order.positionId)&&order.exchange===adapter.id&&
      order.request.clientOrderId===request.clientOrderId);
    assert.ok(original);assert.deepEqual(request,original.request);assert.equal(nativeId,original.result!.id);
    f.calls.push(`${adapter.id}:inspect:${request.clientOrderId}`);return {...structuredClone(original.result!),orderReadAt:Date.now()};
  };
  // Corrupted old diagnostic history is not new financial authority. The second
  // commit must fail without leaving the first selected manager partly enabled.
  (f.other as any).automaticCloseHistory={legacyMalformed:true};
  await f.authorize();const before=JSON.parse(JSON.stringify([f.one,f.other,f.unknownPosition])),orders=JSON.stringify(f.ledger.orders),
    funding=JSON.stringify(f.ledger.fundingSeen),registered=[...(f.engine as any).reconciledPositions];
  const request={...f.request([f.one,f.other]),acknowledgement:'RECONCILE_CURRENT_STRATEGY_POSITIONS' as const};
  await assert.rejects(f.engine.reconcileSelectedPositions(request),/iterable/);
  assert.deepEqual(JSON.parse(JSON.stringify([f.one,f.other,f.unknownPosition])),before);
  assert.equal(JSON.stringify(f.ledger.orders),orders);assert.equal(JSON.stringify(f.ledger.fundingSeen),funding);
  assert.deepEqual([...(f.engine as any).reconciledPositions],registered);assert.equal(f.engine.autoEnabled,false);assert.deepEqual(f.mutations,[]);
});

function expiredBitgetOpeningZeroFixture(){
  const f=completedIocConditionalFixture(['bitget','gate']),now=Date.now();f.one.openedAt=now-4*3_600_000;
  const zero=f.own.find(order=>order.exchange==='bitget'&&!order.request.reduceOnly&&order.result!.filledQuantity===0)!;
  zero.createdAt=now-3*3_600_000;zero.result!.timestamp=zero.createdAt+8;
  zero.execution={bookObservedAt:zero.createdAt-2,quoteAgeMs:2,bookTransport:'websocket',confirmedAt:zero.createdAt+5,confirmationMs:5};
  zero.executionEvidence!.submittedAt=zero.createdAt+1;
  f.setOrderHook((_request,_id,order)=>{
    assert.notEqual(order,zero,'A current lookup cannot prove or replace the durable original zero');
    return {...structuredClone(order.result!),orderReadAt:Date.now()};
  });
  return {...f,zero};
}

test('CURRENT Bitget restoration preserves one expired original confirmed opening zero with ten fresh cash proofs and four account reads',async()=>{
  const f=expiredBitgetOpeningZeroFixture();await f.authorize();const before=structuredClone(f.one),orders=JSON.stringify(f.ledger.orders),
    untouched=JSON.stringify([f.other,f.unknownPosition,f.unknown]),funding=JSON.stringify(f.ledger.fundingSeen);
  await assert.rejects(f.engine.reconcileSelectedPositions(f.request()));assert.equal(f.calls.length,0);
  await f.engine.reconcileSelectedPositions(f.currentRequest());assert.equal(f.one.status,'open');assert.equal(f.engine.autoEnabled,false);
  const audit=f.one.automaticCloseHistory!.at(-1)!.iocRestoration!;
  assert.equal(audit.originalOrders.length,14);assert.equal(audit.originalOrders.filter(row=>row.nativeObservedAt!==undefined).length,10);
  assert.equal(audit.originalOrders.filter(row=>row.localNoSubmit).length,3);assert.equal(audit.originalOrders.filter(row=>row.durableZero).length,1);
  const zero=audit.originalOrders.find(row=>row.clientOrderId===f.zero.request.clientOrderId)!;
  assert.deepEqual(zero.durableZero,{submittedAt:f.zero.executionEvidence!.submittedAt,confirmedAt:f.zero.execution!.confirmedAt,
    nativeTimestamp:f.zero.result!.timestamp});assert.equal(zero.nativeObservedAt,undefined);assert.equal(zero.localNoSubmit,undefined);
  assert.equal(zero.status,'cancelled');assert.equal(zero.filledQuantity,0);assert.equal(zero.feeUsd,0);
  assert.deepEqual(audit.previousCloseIntent,{requestedAt:before.closeRequestedAt,attemptedAt:before.closeAttemptedAt,reason:before.closeReason,
    pricing:'best-opposite',profitRequired:true,pauseReason:before.closePauseReason});
  for(const field of ['profitExitNotionalUsd','long','short','feesUsd','fundingUsd','fundingEvents','transferCostUsd','realizedSpreadPnlUsd',
    'entryPolicy','holdMode','automaticEntry','executionEvidence'] as const)assert.deepEqual(f.one[field],before[field]);
  assert.equal(f.calls.filter(call=>call.includes(':inspect:')).length,10);assert.equal(f.calls.filter(call=>call.endsWith(':account')).length,4);
  assert.equal(f.calls.filter(call=>call.includes(':orders:')).length,2);assert.equal(JSON.stringify(f.ledger.orders),orders);
  assert.equal(JSON.stringify([f.other,f.unknownPosition,f.unknown]),untouched);assert.equal(JSON.stringify(f.ledger.fundingSeen),funding);
  assert.deepEqual(f.mutations,[]);assert.deepEqual([...(f.engine as any).reconciledPositions],[f.one.id]);
});

test('CURRENT Bitget restoration cannot upgrade a current lookup unknown into original zero when original confirmation is missing',async()=>{
  const changes:Array<(f:ReturnType<typeof expiredBitgetOpeningZeroFixture>)=>void>=[
    f=>{delete f.zero.execution!.confirmedAt;},f=>{delete f.zero.executionEvidence!.submittedAt;},
    f=>{f.zero.result!.averagePriceVerified=false;},f=>{f.zero.result!.status='unknown';},
    f=>{f.zero.result!.feeUsd=.1;},f=>{f.zero.result!.filledQuantity=.1;},
    f=>{const duplicate=structuredClone(f.zero);duplicate.positionId='another-symbol';duplicate.request.symbol='OTHER/USDT:USDT';
      duplicate.request.base='OTHER';duplicate.request.clientOrderId='duplicate-native';duplicate.result!.clientOrderId='duplicate-native';f.ledger.orders.push(duplicate);},
  ];
  for(const change of changes){const f=expiredBitgetOpeningZeroFixture();await f.authorize();change(f);
    f.setOrderHook((_request,_id,order)=>order===f.zero?{id:'',clientOrderId:order.request.clientOrderId,status:'unknown',
      filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now(),confirmation:{stage:'order-read',reason:'not-found'}}:
      {...structuredClone(order.result!),orderReadAt:Date.now()});
    const before=JSON.stringify(f.one),orders=JSON.stringify(f.ledger.orders);
    await assert.rejects(f.engine.reconcileSelectedPositions(f.currentRequest()));assert.equal(JSON.stringify(f.one),before);
    assert.equal(JSON.stringify(f.ledger.orders),orders);assert.equal(f.calls.filter(call=>call.endsWith(':account')).length,0);
    assert.deepEqual(f.mutations,[]);assert.equal((f.engine as any).reconciledPositions.has(f.one.id),false);
  }
});

test('durable original zero does not bypass fresh positive native cash, complete empty orders or the second independent account round',async()=>{
  for(const stage of ['cash','orders','second-account'] as const){const f=expiredBitgetOpeningZeroFixture();await f.authorize();
    if(stage==='cash')f.setOrderHook((_request,_id,order)=>({...structuredClone(order.result!),feeUsd:order.result!.feeUsd+.001,orderReadAt:Date.now()}));
    else if(stage==='orders')f.setOpenOrdersHook(()=>[{id:'still-native-pending'}]);
    else f.setAccountHook((exchange,count)=>{if(exchange==='bitget'&&count===2)f.accounts.get(exchange)!.positions.find(row=>row.base===f.one.base)!.quantity=4.9;});
    const before=JSON.stringify(f.one),orders=JSON.stringify(f.ledger.orders);
    await assert.rejects(f.engine.reconcileSelectedPositions(f.currentRequest()));assert.equal(JSON.stringify(f.one),before);
    assert.equal(JSON.stringify(f.ledger.orders),orders);assert.deepEqual(f.mutations,[]);assert.equal((f.engine as any).reconciledPositions.has(f.one.id),false);
  }
});

test('expired original zero restoration rolls back the saved original intent and audit on storage failure',async()=>{
  const f=expiredBitgetOpeningZeroFixture();await f.authorize();const before=JSON.parse(JSON.stringify(f.one)),orders=JSON.stringify(f.ledger.orders);
  f.failNextFinalSave();await assert.rejects(f.engine.reconcileSelectedPositions(f.currentRequest()),/Offline storage/);
  assert.deepEqual(JSON.parse(JSON.stringify(f.one)),before);assert.equal(JSON.stringify(f.ledger.orders),orders);assert.equal(f.engine.autoEnabled,false);
  assert.equal((f.engine as any).reconciledPositions.has(f.one.id),false);assert.deepEqual(f.mutations,[]);
});
