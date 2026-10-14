import test from 'node:test';
import assert from 'node:assert/strict';
import {GatePrivate} from '../src/adapters/gate-private.js';
import {BybitPrivate} from '../src/adapters/bybit-private.js';
import {BitgetClassic} from '../src/adapters/bitget-classic.js';
import {BitgetUta} from '../src/adapters/bitget-uta.js';
import {CcxtAdapter} from '../src/adapters/ccxt.js';
import {exchangeClientId,unknownOrder} from '../src/adapters/normalization.js';
import {defaultConfig} from '../src/shared/config.js';
import type {ExchangeId,OrderRequest} from '../src/shared/types.js';

type Native='gate'|'bybit'|'classic'|'uta';
const request:OrderRequest={clientOrderId:'offline-native-identity',base:'CT',symbol:'CT/USDT:USDT',side:'buy',quantity:10,limitPrice:11,reduceOnly:true};
function fixture(kind:Native){
  const id:ExchangeId=kind==='classic'||kind==='uta'?'bitget':kind;
  const nativeClient=exchangeClientId(id,request.clientOrderId);
  const market={id:kind==='gate'?'CT_USDT':'CTUSDT',symbol:request.symbol,base:'CT',quote:'USDT',settle:'USDT',active:true,swap:true,linear:true,
    contractSize:1,precision:{amount:1,price:.01},limits:{amount:{min:1},cost:{min:1}}};
  let nativeId='10001',fail=false,creates=0,cancels=0;
  const queries:any[]=[],timestamp=String(Date.now());
  const raw=()=>({
    gate:{id:nativeId,contract:market.id,size:'10',left:'6',price:'11',fill_price:'10',tif:'ioc',text:nativeClient,
      is_reduce_only:true,is_close:false,pos_margin_mode:'cross',status:'finished',finish_time_ms:timestamp},
    bybit:{orderId:nativeId,symbol:market.id,orderLinkId:nativeClient,side:'Buy',positionIdx:0,reduceOnly:true,orderType:'Limit',timeInForce:'IOC',
      price:'11',qty:'10',cumExecQty:'4',avgPrice:'10',updatedTime:timestamp,cumFeeDetail:{USDT:'.02'},extraFees:'',orderStatus:'Cancelled'},
    classic:{orderId:nativeId,symbol:market.id,clientOid:nativeClient,side:'buy',marginCoin:'USDT',posMode:'one_way_mode',marginMode:'isolated',reduceOnly:'YES',
      size:'10',baseVolume:'4',price:'11',orderType:'limit',force:'ioc',priceAvg:'10',fee:'-.02',uTime:timestamp,state:'canceled'},
    uta:{orderId:nativeId,category:'USDT-FUTURES',symbol:market.id,clientOid:nativeClient,side:'buy',reduceOnly:'YES',holdMode:'one_way_mode',marginMode:'crossed',
      orderType:'limit',timeInForce:'ioc',price:'11',qty:'10',cumExecQty:'4',avgPrice:'10',updatedTime:timestamp,feeDetail:[{feeCoin:'USDT',fee:'.02'}],orderStatus:'cancelled'},
  }[kind]);
  const read=async(params:any)=>{queries.push(params);if(fail)throw new Error('offline GET unavailable');return raw();};
  const cancel=async()=>{cancels++;};
  const response=(data:any)=>({code:'00000',data});
  const client:any={apiKey:'offline-key',secret:'offline-secret',password:'offline-password',precisionMode:4,
    markets:{[market.symbol]:market},loadMarkets:async()=>({[market.symbol]:market}),market:()=>market,
    amountToPrecision:(_s:string,q:number)=>String(q),priceToPrecision:(_s:string,p:number)=>String(p),
    privateFuturesGetSettleOrdersOrderId:read,privateFuturesDeleteSettleOrdersOrderId:cancel,
    privateFuturesGetSettleMyTrades:async()=>[{id:'501',order_id:nativeId,contract:market.id,size:'4',price:'10',fee:'.02',point_fee:'0',fee_currency:'USDT'}],
    privateGetV5OrderRealtime:async(params:any)=>({retCode:0,result:{list:[await read(params)]}}),
    privateGetV5OrderHistory:async(params:any)=>({retCode:0,result:{list:[await read(params)]}}),privatePostV5OrderCancel:cancel,
    privateMixGetV2MixOrderDetail:async(params:any)=>response(await read(params)),privateMixPostV2MixOrderCancelOrder:cancel,
    privateUtaGetV3TradeOrderInfo:async(params:any)=>response(await read(params)),privateUtaPostV3TradeCancelOrder:cancel,
    privateUtaGetV3AccountSettings:async()=>response({accountMode:kind==='uta'?'unified':'hybrid'}),
    privateUtaGetV3TradeFills:async()=>response({list:[{execId:'execution',orderId:nativeId,clientOid:nativeClient,category:'USDT-FUTURES',symbol:market.id,
      side:'buy',orderType:'limit',tradeSide:'close',execQty:'4',execPrice:'10',feeDetail:[{feeCoin:'USDT',fee:'.02'}]}],cursor:''}),
  };
  const Type=kind==='gate'?GatePrivate:kind==='bybit'?BybitPrivate:kind==='classic'?BitgetClassic:BitgetUta;
  return {id,client,Type,adapter:new Type(client),queries,cancels:()=>cancels,creates:()=>creates,
    create:async()=>{creates++;return '10001';},setId:(value:string)=>{nativeId=value;},setFail:(value:boolean)=>{fail=value;}};
}

test('native GET inspection and reconciliation use a previously acknowledged ID when no argument repeats it',async()=>{
  for(const kind of ['gate','bybit','classic','uta'] as const)for(const operation of ['inspectOrder','reconcile'] as const){
    const f=fixture(kind),prior={...unknownOrder(request,'10001'),filledQuantity:2,averagePrice:10,feeUsd:.01};
    const result=await f.adapter[operation](request,prior);
    assert.equal(result.status,'partial');assert.equal(result.id,'10001');assert.equal(result.filledQuantity,4);
    assert.equal(f.queries[0][kind==='gate'?'order_id':'orderId'],'10001',`${kind} must query the exact known ID`);
  }
});

test('native lookups never replace an already known ID with another receipt sharing a client ID',async()=>{
  for(const kind of ['gate','bybit','classic','uta'] as const)for(const operation of ['inspectOrder','reconcile'] as const){
    const f=fixture(kind),prior={...unknownOrder(request,'10001'),filledQuantity:2,averagePrice:10,feeUsd:.01};
    f.setId('10002');
    const result=await f.adapter[operation](request,prior);
    assert.equal(result.status,'unknown');assert.equal(result.id,'10001');assert.equal(result.filledQuantity,2);
    assert.equal(f.cancels(),0);
  }
});

test('UTA independent execution verification binds its GET to the existing native ID',async()=>{
  const f=fixture('uta'),prior={...unknownOrder(request,'10001'),filledQuantity:2,averagePrice:10,feeUsd:.01};
  const result=await (f.adapter as BitgetUta).verifyOrderExecution(request,prior);
  assert.equal(result.id,'10001');assert.equal(result.averagePriceVerified,true);assert.equal(f.queries[0].orderId,'10001');
  f.setId('10002');
  await assert.rejects((f.adapter as BitgetUta).verifyOrderExecution(request,prior),/order ID mismatch/);
});

test('an explicit conflicting native ID cannot override the already acknowledged receipt',async()=>{
  for(const kind of ['gate','bybit','classic','uta'] as const)for(const operation of ['inspectOrder','reconcile'] as const){
    const f=fixture(kind),prior={...unknownOrder(request,'10001'),filledQuantity:2,averagePrice:10,feeUsd:.01};
    f.setId('10002');
    const result=await f.adapter[operation](request,prior,'10002');
    assert.equal(result.status,'unknown');assert.equal(result.id,'10001');assert.equal(result.filledQuantity,2);
    assert.equal(f.cancels(),0);
  }
});

test('native creation ACK remains in the adapter journal when every subsequent GET fails',async()=>{
  for(const kind of ['gate','bybit','classic','uta'] as const){
    const f=fixture(kind),prototype=f.Type.prototype as any,originalPlace=prototype.place,originalMode=prototype.assertTradingMode;
    const adapter=new CcxtAdapter(f.id,{...defaultConfig,mode:'live',dataSource:'public'},f.client);
    // The native create boundary is stubbed: this test never prepares or sends a venue order.
    prototype.place=f.create;if(originalMode)prototype.assertTradingMode=async()=>({});
    f.setFail(true);
    try{
      const first=await adapter.placeOrder(request);
      assert.equal(first.status,'unknown');assert.equal(first.id,'10001');assert.equal(first.filledQuantity,0);
      const again=await adapter.placeOrder(request);
      assert.equal(again.status,'unknown');assert.equal(again.id,'10001');assert.equal(f.creates(),1);
      assert.ok(f.queries.every(q=>q[kind==='gate'?'order_id':'orderId']==='10001'),'recovery queries must not lose the original native ID');
    }finally{prototype.place=originalPlace;if(originalMode)prototype.assertTradingMode=originalMode;await adapter.close();}
  }
});
