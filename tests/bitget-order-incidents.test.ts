import test from 'node:test';
import assert from 'node:assert/strict';
import {BitgetUta} from '../src/adapters/bitget-uta.js';
import {CcxtAdapter} from '../src/adapters/ccxt.js';
import {defaultConfig} from '../src/shared/config.js';
import {exchangeClientId,unknownOrder} from '../src/adapters/normalization.js';
import type {OrderRequest} from '../src/shared/types.js';
import {attachBitgetFillFixture} from './bitget-fill-fixture.js';
const market={id:'ONEUSDT',symbol:'ONE/USDT:USDT',base:'ONE',quote:'USDT',settle:'USDT',active:true,swap:true,linear:true,contractSize:1};
const request:OrderRequest={clientOrderId:'incident-fixture',base:'ONE',symbol:market.symbol,side:'sell',quantity:46600,limitPrice:.0021986,reduceOnly:false};
const response=(data:any)=>({code:'00000',data});
const raw=(req=request,change:any={})=>({orderId:'order-fixture',clientOid:exchangeClientId('bitget',req.clientOrderId),category:'USDT-FUTURES',symbol:'ONEUSDT',
  side:req.side,posSide:req.reduceOnly?(req.side==='sell'?'long':'short'):(req.side==='buy'?'long':'short'),tradeSide:'open_short',holdMode:'hedge_mode',reduceOnly:'NO',
  marginMode:'crossed',orderType:'limit',timeInForce:'ioc',qty:String(req.quantity),cumExecQty:'0',avgPrice:'0',price:String(req.limitPrice),
  updatedTime:'1790910305105',orderStatus:'cancelled',feeDetail:[{feeCoin:'',fee:''}],cancelReason:'ioc_not_full_cancel',...change});
function setup(){
  const calls:{name:string;params:any}[]=[];let row=raw();
  const client:any={apiKey:'fixture-only',secret:'fixture-only',password:'fixture-only',markets:{[market.symbol]:market},market:()=>market,
    loadMarkets:async()=>({[market.symbol]:market}),
    privateUtaGetV3AccountSettings:async()=>response({accountMode:'unified'}),
    privateUtaGetV3TradeOrderInfo:async(params:any)=>{calls.push({name:'info',params});return response(row);},
    privateUtaGetV3TradeUnfilledOrders:async(params:any)=>{calls.push({name:'normal',params});return response({list:[],cursor:null});},
    privateUtaGetV3TradeUnfilledStrategyOrders:async(params:any)=>{calls.push({name:'strategy',params});return response([]);},
    privateUtaPostV3TradeCancelOrder:async()=>{throw new Error('read-only inspection attempted cancellation');},
    privateUtaPostV3TradePlaceOrder:async()=>{throw new Error('read-only inspection attempted submission');},
  };
  attachBitgetFillFixture(client,p=>calls.push({name:'fills',params:p}));
  return {client,calls,adapter:new BitgetUta(client),row:(value:any)=>{row=value;}};
}
test('ONE incident: zero-fill cancelled IOC with open_short and empty fee placeholders is terminal, not unknown',async()=>{
  const f=setup(),r=await f.adapter.inspectOrder(request);
  assert.equal(r.status,'cancelled');assert.equal(r.filledQuantity,0);assert.equal(r.feeUsd,0);assert.equal(r.id,'order-fixture');
  assert.deepEqual(f.calls,[{name:'info',params:{clientOid:exchangeClientId('bitget',request.clientOrderId)}}]);
  assert.deepEqual(await f.adapter.reconcile(request),r);
});
test('SIREN incident: actual open_long full fill and exact fee survive read-only CCXT factory dispatch',async()=>{
  const f=setup(),req={...request,side:'buy' as const,quantity:4330,limitPrice:.02314};
  f.row(raw(req,{tradeSide:'open_long',orderStatus:'filled',cumExecQty:'4330',avgPrice:'.02313',feeDetail:[{feeCoin:'USDT',fee:'.06010194'}]}));
  const adapter=new CcxtAdapter('bitget',{...defaultConfig,mode:'live'},f.client),r=await adapter.inspectOrder(req);
  assert.equal(r.status,'filled');assert.equal(r.filledQuantity,4330);assert.equal(r.averagePrice,.02313);assert.equal(r.feeUsd,.06010194);
  assert.equal(f.calls.length,2);assert.equal(f.calls.at(-1)?.name,'fills');
});
test('UTA directional tradeSide matches all four directions, rejects opposite suffix and action',async()=>{
  for(const [side,reduceOnly,posSide] of [['buy',false,'long'],['sell',false,'short'],['sell',true,'long'],['buy',true,'short']] as const){
    const req={...request,side,reduceOnly},f=setup(),action=reduceOnly?'close':'open';
    for(const tradeSide of [action,`${action}_${posSide}`]){
      f.row(raw(req,{tradeSide,orderStatus:'filled',cumExecQty:String(req.quantity),avgPrice:'.0021986',feeDetail:[{feeCoin:'USDT',fee:'.061'}]}));
      const r=await f.adapter.inspectOrder(req);assert.equal(r.status,'filled');assert.equal(r.filledQuantity,req.quantity);
    }
    for(const tradeSide of [`${action}_${posSide==='long'?'short':'long'}`,`${reduceOnly?'open':'close'}_${posSide}`]){
      f.row(raw(req,{tradeSide}));assert.equal((await f.adapter.inspectOrder(req)).status,'unknown');
    }
  }
});
test('Empty fee fields never prove a fee for filled orders; live inspection never cancels or discards observed fills',async()=>{
  const f=setup();f.row(raw(request,{orderStatus:'partially_filled',cumExecQty:'200',avgPrice:'.0021986'}));
  const r=await f.adapter.inspectOrder(request);assert.equal(r.status,'unknown');assert.equal(r.filledQuantity,200);assert.equal(f.calls.length,2);
  f.row(raw(request,{orderStatus:'filled',cumExecQty:String(request.quantity),avgPrice:'.0021986'}));
  assert.equal((await f.adapter.inspectOrder(request)).status,'unknown');
  f.row(raw(request,{clientOid:'wrong'}));assert.deepEqual(await f.adapter.inspectOrder(request,r),{...r,status:'unknown'});
  f.row(raw(request,{feeDetail:[{feeCoin:'',fee:'5'}]}));assert.equal((await f.adapter.inspectOrder(request)).status,'unknown');
});
test('UTA active-order observation checks normal pagination and all six strategy types including close-all',async()=>{
  const f=setup();
  f.client.privateUtaGetV3TradeUnfilledOrders=async(params:any)=>{
    f.calls.push({name:'normal',params});return response(params.cursor?{list:[],cursor:null}:{list:[raw(request,{orderStatus:'live',cumExecQty:'10'})],cursor:'older'});
  };
  f.client.privateUtaGetV3TradeUnfilledStrategyOrders=async(params:any)=>{
    f.calls.push({name:'strategy',params});return response(params.type==='trigger'?[{orderId:'trigger-1',category:'USDT-FUTURES',symbol:'ONEUSDT',qty:'0',status:'pending'}]:[]);
  };
  const r=await f.adapter.fetchOpenOrders(market.symbol);assert.equal(r.length,2);assert.equal(r[0].remainingQuantity,46590);assert.equal(r[1].quantity,0);
  assert.equal(r[1].kind,'conditional');assert.deepEqual(f.calls.filter(c=>c.name==='strategy').map(c=>c.params.type).sort(),['iceberg','oco','tpsl','trailing_stop','trigger','twap']);
  assert.equal(f.calls[1].params.cursor,'older');
});
test('UTA active-order failure, missing pagination proof or ambiguous identity cannot certify no orders',async()=>{
  for(const data of [{list:[]},{list:null,cursor:null},{list:[],cursor:'nonadvancing'},{list:[raw(request,{orderStatus:'live',category:'SPOT'})],cursor:null}]){
    const f=setup();f.client.privateUtaGetV3TradeUnfilledOrders=async()=>response(data);await assert.rejects(f.adapter.fetchOpenOrders(market.symbol));
  }
  for(const data of [null,{list:[]},[{orderId:'x',category:'USDT-FUTURES',symbol:'ONEUSDT',qty:'1',status:'success'}]]){
    const f=setup();f.client.privateUtaGetV3TradeUnfilledStrategyOrders=async()=>response(data);await assert.rejects(f.adapter.fetchOpenOrders(market.symbol));
  }
  const f=setup(),a=new CcxtAdapter('bitget',{...defaultConfig,mode:'live'},f.client);
  assert.deepEqual(await a.fetchOpenOrders(market.symbol),[]);assert.equal(f.calls.filter(c=>c.name==='strategy').length,6);
});
