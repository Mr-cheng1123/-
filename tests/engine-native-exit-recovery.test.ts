import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {Engine,type SelectedNativeExitRecoveryRequest} from '../src/core/engine.js';
import {Execution} from '../src/core/execution.js';
import type {Store} from '../src/core/store.js';
import {defaultConfig} from '../src/shared/config.js';
import {selectedNativeExitRecoverySchema} from '../src/server-input.js';
import type {AccountOpenOrder,AccountState,AppConfig,ExchangeAdapter,ExchangeId,JournalOrder,MakerReductionObservation,MarketSnapshot,OrderRequest,Position} from '../src/shared/types.js';

const NOW=Date.UTC(2026,9,11,6),base='CVC',symbol='CVC/USDT:USDT';
type Internal={sessionLivePermission:boolean;sessionExchanges:Set<ExchangeId>;stopping:boolean;maintenanceTradingPending:boolean;financialEpoch:number;
  economicsPosition(p:Position):Position;exitPendingCoin(p:Position):boolean;pendingCoin(base:string):boolean;
  managePosition(p:Position,now:number):Promise<void>;exclusive<T>(fn:()=>Promise<T>):Promise<T>};
function fixture(t:TestContext,options:{peerExchange?:'bybit'|'bitget'|'gate';makerExchange?:'gate'|'bitget'}={}){
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const makerExchange=options.makerExchange??'gate',peerExchange=options.peerExchange??'bybit';
  const config:AppConfig={...structuredClone(defaultConfig),mode:'live',dataSource:'public',entryPolicy:'aligned',holdMode:'adaptive',
    exchanges:[makerExchange,peerExchange],symbols:[base],minExitProfitBps:10,feeRebatePct:{gate:70,bitget:50}};
  let saves=0,failSave=false,nativeFees=true,grantHook=()=>{},accountHook=(_exchange:ExchangeId,_call:number,_account:AccountState)=>{},
    parentHook=(_value:MakerReductionObservation)=>{},openHook=(_exchange:ExchangeId):AccountOpenOrder[]=>[];
  const logs:unknown[][]=[],reads:string[]=[],nativeAccounts=new Map<ExchangeId,AccountState>(),quotes=new Map<ExchangeId,MarketSnapshot>(),calls=new Map<ExchangeId,number>();
  const store={data:{version:1,config,positions:[],orders:[],logs:[],equity:[],killSwitch:false,fundingSeen:[]},
    save(){saves++;if(failSave)throw Object.assign(new Error('memory journal disk failure'),{code:'EIO',syscall:'write'});grantHook();},
    log(...args:unknown[]){logs.push(args);}} as unknown as Store;
  const request:OrderRequest={clientOrderId:'original-maker',base,symbol,side:'sell',quantity:5,limitPrice:1.01,reduceOnly:true,postOnly:true};
  const parent:JournalOrder={positionId:'native-selected-cvc',exchange:makerExchange,createdAt:NOW-3000,request,
    result:{id:'native-maker-id',clientOrderId:request.clientOrderId,status:'filled',filledQuantity:5,averagePrice:1.01,averagePriceVerified:true,feeUsd:.00101,timestamp:NOW-2000},
    makerReduction:{activity:'terminal',makerLeg:'long',deadlineAt:NOW-2000,bookedExecution:true},
    executionEvidence:{version:1,method:'maker',role:'exit',batchId:'original-maker-batch',bookedFeeUsd:.00101}};
  const unknown:JournalOrder={positionId:parent.positionId,exchange:peerExchange,createdAt:NOW-1000,
    request:{clientOrderId:'original-peer-unknown',base,symbol,side:'buy',quantity:5,limitPrice:1.02,reduceOnly:true},
    result:{id:'',clientOrderId:'original-peer-unknown',status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:NOW-1000},
    executionEvidence:{version:1,method:'ioc',role:'exit-tail',batchId:'original-peer-batch',makerCloseParentClientId:request.clientOrderId,nativeTakerFeeRate:.00055}};
  const p:Position={id:parent.positionId,base,mode:'live',entryPolicy:'aligned',holdMode:'adaptive',status:'attention',openedAt:NOW-60_000,
    plannedExitAt:NOW+3_610_000,profitExitNotionalUsd:100,
    long:{exchange:makerExchange,symbol,side:'long',quantity:95,entryPrice:1,markPrice:1,feesUsd:.02101,liquidationDistancePct:null},
    short:{exchange:peerExchange,symbol,side:'short',quantity:100,entryPrice:1,markPrice:1,feesUsd:.02,liquidationDistancePct:null},
    fundingUsd:1,feesUsd:.04101,transferCostUsd:.02,realizedSpreadPnlUsd:.05,spreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],
    riskReasons:['original peer unknown'],closeRequestedAt:NOW-4000,closeProfitRequired:true,closePricing:'best-opposite'};
  for(const leg of [p.long,p.short]){
    nativeAccounts.set(leg.exchange,{freeUsd:1000,equityUsd:1000,positions:[{base,symbol,side:leg.side,quantity:leg.quantity,
      entryPrice:1,markPrice:1,liquidationPrice:0,leverage:2,marginMode:'crossed',positionId:`slot-${leg.exchange}`,positionOpenedAt:p.openedAt}]});
    quotes.set(leg.exchange,{exchange:leg.exchange,base,symbol,source:'public',timestamp:NOW,observedAt:NOW,fundingObservedAt:NOW,
      markPrice:1,indexPrice:1,fundingRate:leg.side==='long'?0:.001,intervalHours:8,nextFundingTime:NOW+3_600_000,fundingHistory:[],
      bids:[{price:leg.side==='long'?1.01:1,quantity:1000}],asks:[{price:leg.side==='long'?1.03:1.001,quantity:1000}],
      quantityStep:1,minQuantity:1,minNotional:1,contractSize:1,openInterestUsd:1e6,volume24hUsd:1e6,
      takerFeeRate:.0005,takerFeeAt:NOW,takerFeeSource:'exchange',makerFeeRate:.0002,makerFeeAt:NOW,makerFeeSource:'exchange'});
  }
  const forbidden=async()=>{throw new Error('This selected authority action must not send any financial request');};
  const adapters=config.exchanges.map(exchange=>({id:exchange,supportsMakerReduction:()=>true,
    getExecutionSnapshot:()=>quotes.get(exchange),fetchExecutionSnapshots:async()=>{for(const q of quotes.values())Object.assign(q,{timestamp:Date.now(),observedAt:Date.now(),takerFeeAt:Date.now(),makerFeeAt:Date.now()});return [quotes.get(exchange)!];},
    cachedTradingFee:()=>nativeFees?({takerFeeRate:.0005,takerFeeAt:Date.now(),takerFeeSource:'exchange',makerFeeRate:.0002,makerFeeAt:Date.now(),makerFeeSource:'exchange'}):undefined,
    fetchAccount:async()=>{t.mock.timers.setTime(Date.now()+1);const call=(calls.get(exchange)??0)+1;calls.set(exchange,call);reads.push(`account:${exchange}:${call}`);
      const account=structuredClone(nativeAccounts.get(exchange)!);accountHook(exchange,call,account);return account;},
    fetchOpenOrders:async()=>{reads.push(`open:${exchange}`);return openHook(exchange);},
    inspectMakerReduction:async(request:OrderRequest)=>{reads.push('parent');const selected=store.data.orders.find(order=>order.request.clientOrderId===request.clientOrderId)!;
      const value:MakerReductionObservation={activity:'terminal',executionVerified:true,observedAt:Date.now(),result:structuredClone(selected.result!)};parentHook(value);return value;},
    placeOrder:forbidden,submitMakerReduction:forbidden,validateMakerReduction:async()=>{},cancelMakerReduction:forbidden,
    reconcileOrder:forbidden,prepareTrading:forbidden,fetchFundingPayments:async()=>[],close:async()=>{},fetchTradingFee:forbidden,
  } as unknown as ExchangeAdapter));
  const engine=new Engine(store,true,{adapterFactory:()=>adapters,liveEnvironment:{ALLOW_LIVE_TRADING:'true',LIVE_TRADING_ACK:'I_UNDERSTAND_THE_RISKS',
    GATE_API_KEY:'MEMORY',GATE_API_SECRET:'MEMORY',BYBIT_API_KEY:'MEMORY',BYBIT_API_SECRET:'MEMORY',BITGET_API_KEY:'MEMORY',BITGET_API_SECRET:'MEMORY',BITGET_PASSPHRASE:'MEMORY'}});
  const internal=engine as unknown as Internal;internal.sessionLivePermission=true;internal.sessionExchanges=new Set(config.exchanges);
  store.data.positions.push(p);
  for(const leg of [p.long,p.short]){
    const id=`original-open-${leg.exchange}`;
    store.data.orders.push({positionId:p.id,exchange:leg.exchange,createdAt:p.openedAt,
      request:{clientOrderId:id,base,symbol,side:leg.side==='long'?'buy':'sell',quantity:100,limitPrice:1,reduceOnly:false},
      result:{id:`native-${id}`,clientOrderId:id,status:'filled',filledQuantity:100,averagePrice:1,averagePriceVerified:true,feeUsd:.02,timestamp:p.openedAt},
      executionEvidence:{version:1,method:'ioc',role:leg.side==='long'?'hedge':'entry',batchId:id,bookedFeeUsd:.02}});
  }
  store.data.orders.push(parent,unknown);engine.snapshots=[...quotes.values()];
  for(const exchange of config.exchanges)Object.assign(engine.health.find(h=>h.exchange===exchange)!,{status:'online',lastSuccess:NOW,accountStatus:'ready',accountUpdatedAt:NOW});
  const input=():SelectedNativeExitRecoveryRequest=>({acknowledgement:'RESTORE_SELECTED_NATIVE_EXIT_MANAGEMENT',operationId:'selected-native-cvc-1',expiresAt:Date.now()+30_000,
    positionId:p.id,parentClientOrderId:parent.request.clientOrderId,unknownClientOrderIds:[unknown.request.clientOrderId],expected:{base,openedAt:p.openedAt,
      longExchange:p.long.exchange,longSymbol:p.long.symbol,longQuantity:p.long.quantity,shortExchange:p.short.exchange,shortSymbol:p.short.symbol,shortQuantity:p.short.quantity}});
  return {engine,internal,store,p,parent,unknown,adapters,nativeAccounts,quotes,reads,logs,input,saves:()=>saves,advance:(delay:number)=>t.mock.timers.setTime(Date.now()+delay),
    grant:(value=input())=>engine.restoreSelectedNativeExitManagement(value),failSave:()=>{failSave=true;},
    dropNativeFees:()=>{nativeFees=false;for(const quote of quotes.values()){
      delete quote.takerFeeRate;delete quote.takerFeeAt;delete quote.takerFeeSource;delete quote.makerFeeRate;delete quote.makerFeeAt;delete quote.makerFeeSource;}},
    onAccount:(hook:typeof accountHook)=>{accountHook=hook;},onParent:(hook:typeof parentHook)=>{parentHook=hook;},
    onOpen:(hook:typeof openHook)=>{openHook=hook;},onSave:(hook:typeof grantHook)=>{grantHook=hook;}};
}
type Fixture=ReturnType<typeof fixture>;
function extraUnknown(f:Fixture,scope:'position'|'coin'|'contract'|'unidentified'='position'){
  const order=structuredClone(f.unknown);order.request.clientOrderId=`extra-${scope}`;order.result!.clientOrderId=order.request.clientOrderId;
  if(scope!=='position')order.positionId='other-position';if(scope==='contract')order.request.base='OTHER';if(scope==='unidentified'){order.request.base='';order.request.symbol='';}
  f.store.data.orders.push(order);
}
function completeKnownTail(f:Fixture){
  const completed=structuredClone(f.unknown);completed.request.clientOrderId='confirmed-new-peer';completed.result={
    id:'confirmed-new-native-peer',clientOrderId:completed.request.clientOrderId,status:'filled',filledQuantity:5,averagePrice:1.02,
    averagePriceVerified:true,feeUsd:.002805,timestamp:NOW-500};completed.executionEvidence!.bookedFeeUsd=.002805;
  f.store.data.orders.push(completed);f.p.short.quantity=95;f.nativeAccounts.get(f.p.short.exchange)!.positions[0].quantity=95;
  f.p.short.feesUsd+=.002805;f.p.feesUsd+=.002805;f.p.short.realizedPnlUsd=-.1;f.p.realizedSpreadPnlUsd-=.1;
  return completed;
}
function newConfirmedTail(f:Fixture){
  completeKnownTail(f);const parent=structuredClone(f.parent);parent.request.clientOrderId='current-confirmed-maker';parent.createdAt=NOW-200;
  parent.result!.id='current-native-maker';parent.result!.clientOrderId=parent.request.clientOrderId;parent.result!.timestamp=NOW-190;
  const failedPeer=structuredClone(f.unknown);failedPeer.createdAt=NOW-180;failedPeer.request.clientOrderId='current-never-sent-peer';
  failedPeer.result={id:'',clientOrderId:failedPeer.request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,
    timestamp:NOW-170,rejectionCode:'MAKER_REDUCTION_PERMISSION_CHANGED'};
  failedPeer.executionEvidence!.makerCloseParentClientId=parent.request.clientOrderId;failedPeer.executionEvidence!.bookedFeeUsd=0;
  f.store.data.orders.push(parent,failedPeer);f.p.long.quantity=90;f.nativeAccounts.get(f.p.long.exchange)!.positions[0].quantity=90;
  f.p.long.feesUsd+=parent.result!.feeUsd;f.p.feesUsd+=parent.result!.feeUsd;f.p.realizedSpreadPnlUsd+=.05;
  return {parent,failedPeer,input:()=>({...f.input(),confirmedTailParentClientOrderId:parent.request.clientOrderId})};
}

test('native exit grant persists fresh four-read identity proof but never resolves or resends original unknown',async t=>{
  const f=fixture(t),original=structuredClone(f.store.data.orders),financial={fees:f.p.feesUsd,realized:f.p.realizedSpreadPnlUsd,transfer:f.p.transferCostUsd};
  const result=await f.grant(),audit=f.p.nativeExitRecoveryAudit![0];
  assert.equal(result.positionId,f.p.id);assert.equal(f.engine.execution.hasNativeExitAuthority(f.p),true);assert.equal(audit.originalRemainingBudget,5);
  assert.equal(audit.nativeReadEvidence.length,4);assert.equal(audit.noOpenOrders.length,2);assert.equal(f.reads.filter(v=>v==='parent').length,1);
  assert.deepEqual(f.store.data.orders,original);assert.deepEqual({fees:f.p.feesUsd,realized:f.p.realizedSpreadPnlUsd,transfer:f.p.transferCostUsd},financial);
  assert.ok(Math.abs(audit.feeReserveUsd-5*1.02*.00055)<1e-12);assert.ok(Math.abs(audit.lossReserveUsd-.1)<1e-12);
  assert.equal(f.internal.pendingCoin(base),true,'Entry remains excluded');assert.equal(f.internal.exitPendingCoin(f.p),false);
  const shadow=f.internal.economicsPosition(f.p);assert.ok(Math.abs(shadow.transferCostUsd-(financial.transfer+audit.feeReserveUsd+audit.lossReserveUsd))<1e-12);
  assert.equal(typeof shadow.estimatedFeeRebateUsd,'number','Known booked rebate remains usable; unknown original fee is already conservatively reserved');
  assert.equal(shadow.profitExitNotionalUsd,100);assert.equal(f.p.transferCostUsd,financial.transfer);
  await assert.rejects(f.grant(),/已接收|已变化/);assert.equal(f.p.nativeExitRecoveryAudit!.length,1);
});

test('native exit economic reserve applies configured automatic Bitget rebate once',async t=>{
  const f=fixture(t,{peerExchange:'bitget'});await f.grant();
  assert.ok(Math.abs(f.p.nativeExitRecoveryAudit![0].feeReserveUsd-5*1.02*.00055*.5)<1e-12);
  assert.equal(f.p.short.feesUsd,.02);assert.equal(f.unknown.result!.feeUsd,0);
});

test('native exit supports a confirmed short Maker with Gate long peer and Gate rebate reserve',async t=>{
  const f=fixture(t,{makerExchange:'bitget',peerExchange:'gate'}),long=f.p.long,short=f.p.short;
  f.p.long={...short,side:'long'};f.p.short={...long,side:'short'};f.parent.makerReduction!.makerLeg='short';
  f.parent.request.side='buy';f.unknown.request.side='sell';
  for(const opening of f.store.data.orders.filter(order=>!order.request.reduceOnly))opening.request.side=opening.exchange==='gate'?'buy':'sell';
  f.nativeAccounts.get('bitget')!.positions[0].side='short';f.nativeAccounts.get('gate')!.positions[0].side='long';
  await f.grant();assert.equal(f.p.nativeExitRecoveryAudit![0].originalRemainingBudget,5);
  assert.ok(Math.abs(f.p.nativeExitRecoveryAudit![0].feeReserveUsd-5*1.02*.00055*.3)<1e-12);
  assert.equal(f.p.nativeExitRecoveryAudit![0].lossReserveUsd,0);assert.equal(f.unknown.result!.status,'unknown');
});

test('native exit grant preserves original notional and reserve after a completed tail',async t=>{
  const f=fixture(t);f.p.profitExitNotionalUsd=1000;await f.grant();const audit=structuredClone(f.p.nativeExitRecoveryAudit![0]);
  f.p.short.quantity=95;const shadow=f.internal.economicsPosition(f.p);
  assert.equal(shadow.profitExitNotionalUsd,1000);assert.ok(Math.abs(shadow.transferCostUsd-(.02+audit.feeReserveUsd+audit.lossReserveUsd))<1e-12);
  assert.deepEqual(f.p.nativeExitRecoveryAudit![0],audit);assert.equal(f.internal.pendingCoin(base),true);
});

test('matched native position explicitly restores after consumed parent budget without inheriting authority or creating a close intent',async t=>{
  const f=fixture(t);completeKnownTail(f);delete f.p.closeRequestedAt;delete f.p.closeProfitRequired;delete f.p.closePricing;
  const original=structuredClone(f.store.data.orders);await f.grant();
  assert.equal(f.p.nativeExitRecoveryAudit![0].originalRemainingBudget,0);assert.equal(f.p.status,'open');assert.equal(f.p.closeRequestedAt,undefined);
  assert.equal(f.p.closeProfitRequired,undefined);assert.equal(f.engine.execution.hasNativeExitAuthority(f.p),true);
  assert.deepEqual(f.store.data.orders,original);assert.ok(f.p.nativeExitRecoveryAudit![0].feeReserveUsd>0);
  let repairs=0;f.engine.execution.repairNativeConfirmedTail=async()=>{repairs++;return false;};
  f.engine.execution.canUseMakerClose=()=>false;await f.internal.managePosition(f.p,Date.now());assert.equal(repairs,0);
  assert.equal(new Execution(f.store,f.engine.execution.context).hasNativeExitAuthority(f.p),false);
});

for(const [label,change] of [
  ['overconsumed original Maker budget',(f:Fixture,peer:JournalOrder)=>{peer.result!.filledQuantity=6;}],
  ['zero budget with native excess',(f:Fixture)=>{f.p.short.quantity=96;f.nativeAccounts.get(f.p.short.exchange)!.positions[0].quantity=96;}],
  ['matched manual close intent',(f:Fixture)=>{f.p.closeProfitRequired=false;}],
  ['known peer wrong direction',(_f:Fixture,peer:JournalOrder)=>{peer.request.side='sell';}],
] as const)test(`matched native recovery rejects ${label}`,async t=>{
  const f=fixture(t),peer=completeKnownTail(f);change(f,peer);await assert.rejects(f.grant());
  assert.equal(f.p.nativeExitRecoveryAudit,undefined);assert.equal(f.unknown.result!.status,'unknown');
});

test('selected current confirmed tail is independent of the consumed historical unknown parent',async t=>{
  const f=fixture(t),current=newConfirmedTail(f),originalUnknown=structuredClone(f.unknown),originalOrders=structuredClone(f.store.data.orders);
  await f.grant(current.input());const audit=f.p.nativeExitRecoveryAudit![0];
  assert.equal(audit.parentClientOrderId,f.parent.request.clientOrderId);assert.equal(audit.originalRemainingBudget,0);
  assert.equal(audit.confirmedTailParentClientOrderId,current.parent.request.clientOrderId);assert.equal(audit.confirmedTailRemainingBudget,5);
  assert.equal(f.reads.filter(value=>value==='parent').length,2);assert.equal(audit.nativeReadEvidence.length,4);
  assert.deepEqual(f.unknown,originalUnknown);assert.deepEqual(f.store.data.orders,originalOrders);
  assert.ok(Math.abs(audit.feeReserveUsd-5*1.02*.00055)<1e-12);
  let selected:string|undefined;f.engine.execution.repairNativeConfirmedTail=async(_position,id)=>{selected=id;return false;};
  await f.internal.exclusive(()=>f.internal.managePosition(f.p,Date.now()));assert.equal(selected,current.parent.request.clientOrderId);
  await new Promise<void>(resolve=>setImmediate(resolve));
});

test('MAGIC literal historical Maker120 budget0 and current Maker345 restore only native457 versus802 tail345',async t=>{
  const f=fixture(t),current=newConfirmedTail(f),magicSymbol='MAGIC/USDT:USDT';
  f.p.base='MAGIC';f.p.profitExitNotionalUsd=922;
  for(const order of f.store.data.orders){order.request.base='MAGIC';order.request.symbol=magicSymbol;
    if(!order.request.reduceOnly){order.request.quantity=922;order.result!.filledQuantity=922;}}
  f.parent.request.quantity=120;Object.assign(f.parent.result!,{filledQuantity:120,feeUsd:.02424});f.parent.executionEvidence!.bookedFeeUsd=.02424;
  f.unknown.request.quantity=120;
  const known=f.store.data.orders.find(order=>order.request.clientOrderId==='confirmed-new-peer')!;
  known.request.quantity=120;Object.assign(known.result!,{filledQuantity:120,feeUsd:.06732});known.executionEvidence!.bookedFeeUsd=.06732;
  current.parent.request.quantity=345;Object.assign(current.parent.result!,{filledQuantity:345,feeUsd:.06969});current.parent.executionEvidence!.bookedFeeUsd=.06969;
  current.failedPeer.request.quantity=345;
  Object.assign(f.p.long,{symbol:magicSymbol,quantity:457,feesUsd:.11393,realizedPnlUsd:4.65});
  Object.assign(f.p.short,{symbol:magicSymbol,quantity:802,feesUsd:.08732,realizedPnlUsd:-2.4});f.p.feesUsd=.20125;f.p.realizedSpreadPnlUsd=2.25;
  for(const leg of [f.p.long,f.p.short])Object.assign(f.nativeAccounts.get(leg.exchange)!.positions[0],{base:'MAGIC',symbol:magicSymbol,quantity:leg.quantity});
  for(const quote of f.quotes.values())Object.assign(quote,{base:'MAGIC',symbol:magicSymbol});f.engine.snapshots=[...f.quotes.values()];
  const input=current.input();input.expected.base='MAGIC';await f.grant(input);const audit=f.p.nativeExitRecoveryAudit![0];
  assert.equal(audit.originalRemainingBudget,0);assert.equal(audit.confirmedTailRemainingBudget,345);
  assert.equal(f.p.long.quantity,457);assert.equal(f.p.short.quantity,802);assert.equal(f.unknown.result!.status,'unknown');
  assert.ok(Math.abs(audit.feeReserveUsd-120*1.02*.00055)<1e-12);
  let selected:string|undefined;f.engine.execution.repairNativeConfirmedTail=async(_p,id)=>{selected=id;return false;};
  await f.internal.exclusive(()=>f.internal.managePosition(f.p,Date.now()));assert.equal(selected,current.parent.request.clientOrderId);
  await new Promise<void>(resolve=>setImmediate(resolve));
});

for(const [label,change] of [
  ['historical parent still has an unspent budget',(f:Fixture)=>{f.store.data.orders.find(o=>o.request.clientOrderId==='confirmed-new-peer')!.result!.filledQuantity=4;}],
  ['current parent has no native identity',(_f:Fixture,current:ReturnType<typeof newConfirmedTail>)=>{current.parent.result!.id='';}],
  ['current parent has unverified cash',(_f:Fixture,current:ReturnType<typeof newConfirmedTail>)=>{current.parent.result!.averagePriceVerified=false;}],
  ['current parent budget differs from real excess',(_f:Fixture,current:ReturnType<typeof newConfirmedTail>)=>{current.parent.result!.filledQuantity=4;}],
  ['current peer remains uncertain',(_f:Fixture,current:ReturnType<typeof newConfirmedTail>)=>{current.failedPeer.result!.status='unknown';}],
  ['current peer points at a foreign contract',(_f:Fixture,current:ReturnType<typeof newConfirmedTail>)=>{current.failedPeer.request.symbol='OTHER/USDT:USDT';}],
  ['current native parent GET has different cash',(f:Fixture,current:ReturnType<typeof newConfirmedTail>)=>{f.onParent(observation=>{
    if(observation.result.clientOrderId===current.parent.request.clientOrderId)observation.result.feeUsd+=.01;
  });}],
  ['current parent cash changes during accounts',(f:Fixture,current:ReturnType<typeof newConfirmedTail>)=>{f.onAccount(()=>{current.parent.result!.feeUsd+=.01;});}],
] as const)test(`selected current tail cannot claim ${label}`,async t=>{
  const f=fixture(t),current=newConfirmedTail(f);change(f,current);await assert.rejects(f.grant(current.input()));
  assert.equal(f.p.nativeExitRecoveryAudit,undefined);assert.equal(f.unknown.result!.status,'unknown');
});

test('historical authority cannot claim a later real imbalance without selecting its exact Maker',async t=>{
  const f=fixture(t);newConfirmedTail(f);await assert.rejects(f.grant(),/预算不一致/);
  assert.equal(f.p.nativeExitRecoveryAudit,undefined);
});

test('current session Maker tail takes priority over the historical native parent retry',async t=>{
  const f=fixture(t);await f.grant();newConfirmedTail(f);
  for(const leg of [f.p.long,f.p.short])f.engine.accounts.set(leg.exchange,structuredClone(f.nativeAccounts.get(leg.exchange)!));
  let currentDispatch=0,oldNativeDispatch=0;f.engine.running=true;
  f.engine.execution.hasPendingMakerCloseTail=()=>true;
  f.engine.execution.dispatchMakerCloseTail=()=>{currentDispatch++;return true;};
  f.engine.execution.repairNativeConfirmedTail=async()=>{oldNativeDispatch++;return false;};
  await f.internal.exclusive(()=>f.internal.managePosition(f.p,Date.now()));
  assert.equal(currentDispatch,1);assert.equal(oldNativeDispatch,0);
});

for(const [label,change] of [
  ['automatic entry active',(f:Fixture)=>{f.engine.autoEnabled=true;}],
  ['session permission revoked',(f:Fixture)=>{f.internal.sessionLivePermission=false;}],
  ['venue permission revoked',(f:Fixture)=>{f.internal.sessionExchanges.delete('bybit');}],
  ['risk stop',(f:Fixture)=>{f.store.data.killSwitch=true;}],
  ['expired selection',(f:Fixture)=>{f.advance(31_000);}],
  ['unknown native ID discovered',(f:Fixture)=>{f.unknown.result!.id='late-native-id';}],
  ['unknown has booked prefix',(f:Fixture)=>{f.unknown.result!.filledQuantity=1;f.unknown.result!.averagePrice=1.02;}],
  ['parent cash unverified',(f:Fixture)=>{f.parent.result!.averagePriceVerified=false;}],
  ['parent budget differs from native excess',(f:Fixture)=>{f.parent.result!.filledQuantity=4;}],
  ['new unknown on position',(f:Fixture)=>extraUnknown(f)],
  ['new unknown on same coin',(f:Fixture)=>extraUnknown(f,'coin')],
  ['new unknown on same contract',(f:Fixture)=>extraUnknown(f,'contract')],
  ['unidentified unknown',(f:Fixture)=>extraUnknown(f,'unidentified')],
] as const)test(`native exit selected authority rejects ${label}`,async t=>{
  const f=fixture(t),input=f.input();change(f);await assert.rejects(f.grant(input));
  assert.equal(f.engine.execution.hasNativeExitAuthority(f.p),false);assert.equal(f.p.nativeExitRecoveryAudit,undefined);
  assert.equal(f.store.data.orders.filter(o=>o.request.clientOrderId==='original-peer-unknown').length,1);
});
for(const [label,change] of [
  ['native quantity mismatch',(account:AccountState)=>{account.positions[0].quantity+=1;}],
  ['native side mismatch',(account:AccountState)=>{account.positions[0].side='short';}],
  ['native opening basis changed',(account:AccountState)=>{account.positions[0].entryPrice=1.1;}],
  ['native opening identity absent',(account:AccountState)=>{delete account.positions[0].entryPrice;}],
  ['native duplicate row',(account:AccountState)=>{account.positions.push(structuredClone(account.positions[0]));}],
  ['native reopened position',(account:AccountState)=>{account.positions[0].positionOpenedAt=NOW;}],
] as const)test(`native exit grant rejects ${label}`,async t=>{
  const f=fixture(t);f.onAccount((exchange,_call,account)=>{if(exchange==='gate')change(account);});await assert.rejects(f.grant());
  assert.equal(f.p.nativeExitRecoveryAudit,undefined);assert.equal(f.engine.execution.hasNativeExitAuthority(f.p),false);
});

test('native exit grant rejects nonempty complete native order list and changed second-read identity',async t=>{
  const f=fixture(t);f.onOpen(exchange=>exchange==='gate'?[{id:'foreign-open'} as AccountOpenOrder]:[]);await assert.rejects(f.grant(),/挂单/);
  f.onOpen(()=>[]);f.onAccount((_exchange,call,account)=>{if(call===3)account.positions[0].positionId='changed-slot';});
  await assert.rejects(f.grant(),/身份/);assert.equal(f.p.nativeExitRecoveryAudit,undefined);
});

test('native exit original parent fresh GET requires complete exact cash proof',async t=>{
  const f=fixture(t);f.onParent(value=>{value.result.feeUsd+=.01;});await assert.rejects(f.grant(),/原生完整现金/);
  assert.equal(f.p.nativeExitRecoveryAudit,undefined);assert.equal(f.unknown.result!.status,'unknown');
});

test('native exit missing actual account fee cannot use old or reference fee as current authority',async t=>{
  const f=fixture(t);f.dropNativeFees();await assert.rejects(f.grant());
  assert.equal(f.p.nativeExitRecoveryAudit,undefined);assert.equal(f.engine.execution.hasNativeExitAuthority(f.p),false);
  assert.equal(f.unknown.result!.status,'unknown');
});

test('native exit selected client IDs are unique and a caller mutation cannot widen the captured selection',async t=>{
  const f=fixture(t);const duplicate=structuredClone(f.unknown);duplicate.positionId='foreign-position';f.store.data.orders.push(duplicate);
  await assert.rejects(f.grant(),/ID 不唯一/);assert.equal(f.p.nativeExitRecoveryAudit,undefined);f.store.data.orders.pop();
  const input=f.input();f.onParent(()=>{input.unknownClientOrderIds.push('not-selected-original');});await f.grant(input);
  assert.deepEqual(f.p.nativeExitRecoveryAudit![0].unknownClientOrderIds,['original-peer-unknown']);
});

test('native exit GET-only diagnostic timestamp changes do not create financial mutation',async t=>{
  const f=fixture(t);f.onParent(()=>{f.unknown.result!.orderReadAt=Date.now();});await f.grant();
  assert.equal(f.engine.execution.hasNativeExitAuthority(f.p),true);
  f.unknown.result!.orderReadAt=Date.now()+10;assert.equal(f.engine.execution.hasNativeExitAuthority(f.p),true);
  f.unknown.result!.feeUsd=.01;assert.equal(f.engine.execution.hasNativeExitAuthority(f.p),false);
});

test('native exit await-time original cash mutation cannot install authority',async t=>{
  const f=fixture(t);f.onAccount(()=>{f.parent.result!.feeUsd+=.01;});await assert.rejects(f.grant(),/记录已变化|现金/);
  assert.equal(f.p.nativeExitRecoveryAudit,undefined);
});

test('native exit journal persistence failure rolls back local status and grant, then stops trading',async t=>{
  const f=fixture(t),oldStatus=f.p.status,oldReasons=structuredClone(f.p.riskReasons),unknown=structuredClone(f.unknown);f.failSave();
  await assert.rejects(f.grant(),/memory journal disk failure/);assert.equal(f.p.nativeExitRecoveryAudit,undefined);
  assert.equal(f.p.status,oldStatus);assert.deepEqual(f.p.riskReasons,oldReasons);assert.deepEqual(f.unknown,unknown);
  assert.equal(f.store.data.killSwitch,true);assert.equal(f.engine.autoEnabled,false);assert.equal(f.engine.execution.hasNativeExitAuthority(f.p),false);
});

test('native exit persisted audit cannot grant authority to a new Execution instance',async t=>{
  const f=fixture(t);await f.grant();const restarted=new Execution(f.store,f.engine.execution.context);
  assert.equal(restarted.hasNativeExitAuthority(f.p),false);assert.equal(f.p.nativeExitRecoveryAudit!.length,1);
});

test('pausing new entries preserves a completed native exit grant but invalidates a still-preparing grant',async t=>{
  const f=fixture(t);await f.grant();f.engine.autoEnabled=true;await f.engine.control('pause');
  const execution=f.engine.execution as unknown as {nativeExitSubmissionAllowed(p:Position):boolean};
  assert.equal(f.engine.autoEnabled,false);assert.equal(f.engine.execution.hasNativeExitAuthority(f.p),true);
  assert.equal(execution.nativeExitSubmissionAllowed(f.p),true,'A pause of entries retains already authorized reductions');
  // A second selection captures a generation at the start; cancelling it during a GET still aborts that new grant.
  f.engine.execution.revokeNativeExitAuthority(f.p,'memory audit reselect');
  f.p.status='attention';f.onParent(()=>{void f.engine.control('pause');});
  await assert.rejects(f.grant({...f.input(),operationId:'selected-native-cvc-2'}),/确认有效|暂停自动开仓/);
  assert.equal(f.p.nativeExitRecoveryAudit!.length,1);
});

test('native exit management keeps newly observed same-contract unknown blocked after grant',async t=>{
  const f=fixture(t);await f.grant();let repairs=0;f.engine.execution.repairNativeConfirmedTail=async()=>{repairs++;return false;};
  extraUnknown(f,'contract');assert.equal(f.internal.exitPendingCoin(f.p),true);
  await f.internal.exclusive(()=>f.internal.managePosition(f.p,Date.now()));assert.equal(repairs,0);
});

test('native exit tail worker is deduplicated and its pending read does not hold the global queue',async t=>{
  const f=fixture(t);await f.grant();let repairs=0,release!:()=>void;
  f.engine.execution.repairNativeConfirmedTail=async()=>{repairs++;await new Promise<void>(resolve=>{release=resolve;});return false;};
  await f.internal.exclusive(()=>f.internal.managePosition(f.p,Date.now()));assert.equal(repairs,1);
  let independent=false;await f.internal.exclusive(async()=>{independent=true;});assert.equal(independent,true);
  await f.internal.exclusive(()=>f.internal.managePosition(f.p,Date.now()));assert.equal(repairs,1);release();
  await new Promise<void>(resolve=>setImmediate(resolve));
});

test('native exit local API schema does not accept entry authorization or mutable unknown-state options',async t=>{
  const f=fixture(t),input=f.input();assert.equal(selectedNativeExitRecoverySchema.safeParse(input).success,true);
  assert.equal(selectedNativeExitRecoverySchema.safeParse({...input,resolveAsZero:true}).success,false);
  assert.equal(selectedNativeExitRecoverySchema.safeParse({...input,expected:{...input.expected,allowEntry:true}}).success,false);
  assert.equal(selectedNativeExitRecoverySchema.safeParse({...input,acknowledgement:'START_LIVE_TRADING'}).success,false);
});
