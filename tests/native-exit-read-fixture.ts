import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import {Engine,type SelectedNativeExitRecoveryRequest} from '../src/core/engine.js';
import type {Store} from '../src/core/store.js';
import {defaultConfig} from '../src/shared/config.js';
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


export {fixture,completeKnownTail,extraUnknown,NOW,base,symbol};
export type {Fixture,Internal};
