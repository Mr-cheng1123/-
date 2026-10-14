import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import {Store} from '../src/core/store.js';
import {defaultConfig} from '../src/shared/config.js';
import {runExternalExposureReduction,type ExternalExposureReductionOptions} from '../src/core/external-exposure-reduction.js';
import type {AccountPosition,AccountState,ExchangeAdapter,ExchangeId,JournalOrder,MarketSnapshot,OrderRequest,OrderResult,Position} from '../src/shared/types.js';

export function fixture(longQuantity=100,shortQuantity=0){
  const root=path.resolve('D:/codex/tmp/external-exposure-reduction-tests');mkdirSync(root,{recursive:true});
  const dir=mkdtempSync(path.join(root,'case-')),store=new Store(path.join(dir,'state.json'),{...defaultConfig,mode:'live'});
  const openedAt=Date.now()-60000;
  const leg=(side:'long'|'short')=>({exchange:side==='long'?'bitget' as const:'gate' as const,symbol:'DOS/USDT:USDT',side,
    quantity:100,entryPrice:1,markPrice:.8,feesUsd:.01,fundingUsd:.02,realizedPnlUsd:.03,liquidationDistancePct:50});
  const source:Position={id:'original-dos',base:'DOS',status:'attention',mode:'live',long:leg('long'),short:leg('short'),openedAt,
    plannedExitAt:openedAt+600000,holdMode:'adaptive',fundingUsd:.04,feesUsd:.02,transferCostUsd:.01,
    spreadPnlUsd:.06,realizedSpreadPnlUsd:.06,netPnlUsd:.07,deltaUsd:0,fundingEvents:[],riskReasons:['external ADL']};
  store.data.positions.push(source);store.save();
  const native=(side:'long'|'short',quantity:number):AccountPosition=>({base:'DOS',symbol:source[side].symbol,side,quantity,
    markPrice:.8,liquidationPrice:.5,leverage:5,entryPrice:1,positionOpenedAt:openedAt,positionId:`native-${side}`,marginMode:'crossed'});
  const accounts=new Map<ExchangeId,AccountState>([
    ['bitget',{freeUsd:50,equityUsd:100,positions:longQuantity>0?[native('long',longQuantity)]:[]}],
    ['gate',{freeUsd:50,equityUsd:100,positions:shortQuantity>0?[native('short',shortQuantity)]:[]}]
  ]);
  const books=new Map<ExchangeId,MarketSnapshot>(['bitget','gate'].map(exchange=>[exchange as ExchangeId,
    {exchange:exchange as ExchangeId,base:'DOS',symbol:'DOS/USDT:USDT',timestamp:Date.now(),markPrice:.8,indexPrice:.8,
      fundingRate:0,nextFundingTime:Date.now()+60000,intervalHours:8,fundingHistory:[],bids:[{price:.8,quantity:1000}],
      asks:[{price:.81,quantity:1000}],openInterestUsd:1e9,volume24hUsd:1e9,quantityStep:1,minQuantity:1,minNotional:5,contractSize:1,source:'public'}]));
  const requests:OrderRequest[]=[],accountCalls:ExchangeId[]=[],orderCalls:ExchangeId[]=[],gateSlots:AccountPosition[]=[];
  let serialDepth=0,readHook:((exchange:ExchangeId,index:number,account:AccountState)=>void)|undefined,
    validateHook:((request:OrderRequest)=>void)|undefined,postHook:((request:OrderRequest)=>void)|undefined,
    resultHook:((request:OrderRequest)=>OrderResult)|undefined,allowed=true,openHook:(exchange:ExchangeId)=>unknown[]=()=>[];
  const adapters=new Map<ExchangeId,ExchangeAdapter>(['bitget','gate'].map(exchange=>[exchange as ExchangeId,{
    id:exchange,fetchOpenOrders:async()=>{assert.equal(serialDepth,0);orderCalls.push(exchange as ExchangeId);return openHook(exchange as ExchangeId);},
    fetchClosePositions:async()=>{assert.equal(serialDepth,0);return gateSlots.length?structuredClone(gateSlots):structuredClone(accounts.get('gate')!.positions);},
    validateOrder:async(request:OrderRequest)=>{assert.equal(serialDepth,0);validateHook?.(request);},
    placeOrder:async(request:OrderRequest,guard?:()=>boolean)=>{
      assert.equal(serialDepth,0,'native POST must not hold the global cash queue');postHook?.(request);
      if(guard&&!guard())return {id:'',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,
        timestamp:Date.now(),rejectionCode:'ORDER_SUBMISSION_PERMISSION_CHANGED'};
      const persisted=JSON.parse(readFileSync(store.path,'utf8'));
      assert.ok(persisted.orders.some((order:JournalOrder)=>order.request.clientOrderId===request.clientOrderId&&!order.result),'durable original intent before POST');
      requests.push(structuredClone(request));
      const result:OrderResult=resultHook?.(request)??{id:`native-order-${requests.length}`,clientOrderId:request.clientOrderId,
        status:'filled',filledQuantity:request.quantity,averagePrice:request.limitPrice,feeUsd:.01,timestamp:Date.now()};
      const current=accounts.get(exchange as ExchangeId)!.positions.find(row=>row.symbol===request.symbol&&row.side===(request.side==='sell'?'long':'short'));
      if(current&&result.status!=='unknown')current.quantity-=result.filledQuantity;
      return result;
    },reconcileOrder:async(request:OrderRequest)=>({id:'',clientOrderId:request.clientOrderId,status:'unknown',filledQuantity:0,
      averagePrice:0,feeUsd:0,timestamp:Date.now()})
  } as unknown as ExchangeAdapter]));
  const options:ExternalExposureReductionOptions={store,source,config:store.data.config,adapter:exchange=>adapters.get(exchange)!,
    readAccount:async exchange=>{assert.equal(serialDepth,0);const startedAt=Date.now(),account=structuredClone(accounts.get(exchange)!);
      accountCalls.push(exchange);readHook?.(exchange,accountCalls.length,account);return {account,startedAt};},
    read:async(_adapter,_key,call)=>call(),snapshot:exchange=>books.get(exchange as ExchangeId),
    refreshBooks:async()=>{for(const book of books.values())book.timestamp=Date.now();},ensure:()=>{if(!allowed)throw new Error('revoked');},
    onFinancialActivity:()=>{},serialize:async work=>{assert.equal(serialDepth,0);serialDepth++;try{return await work();}finally{serialDepth--;}}};
  return {store,source,accounts,books,requests,accountCalls,orderCalls,gateSlots,options,
    setReadHook:(value:typeof readHook)=>{readHook=value;},setValidateHook:(value:typeof validateHook)=>{validateHook=value;},
    setPostHook:(value:typeof postHook)=>{postHook=value;},setResultHook:(value:typeof resultHook)=>{resultHook=value;},
    setOpenHook:(value:typeof openHook)=>{openHook=value;},revoke:()=>{allowed=false;},
    run:()=>runExternalExposureReduction(options),cleanup:()=>{assert.equal(path.dirname(dir),root);rmSync(dir,{recursive:true,force:true});}};
}
