import test from 'node:test';
import assert from 'node:assert/strict';
import {CcxtAdapter} from '../src/adapters/ccxt.js';
import {GatePrivate} from '../src/adapters/gate-private.js';
import {BybitPrivate} from '../src/adapters/bybit-private.js';
import {BitgetClassic} from '../src/adapters/bitget-classic.js';
import {BitgetUta} from '../src/adapters/bitget-uta.js';
import {OrderNotSubmittedError} from '../src/adapters/order-rejection.js';
import {exchangeClientId} from '../src/adapters/normalization.js';
import {defaultConfig} from '../src/shared/config.js';
import type {OrderRequest} from '../src/shared/types.js';

const symbol='CT/USDT:USDT';
const request:OrderRequest={clientOrderId:'offline-confirmed-maker-peer',base:'CT',symbol,side:'sell',quantity:10,limitPrice:11,reduceOnly:true};
function deferred<T>(){
  let resolve!:(value:T)=>void;
  const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};
}
const response=(data:any)=>({code:'00000',data});
function fixture(kind:'gate'|'bybit'|'classic'|'uta'){
  const venue=kind==='classic'||kind==='uta'?'bitget':kind;
  const market={id:venue==='gate'?'CT_USDT':'CTUSDT',symbol,base:'CT',quote:'USDT',settle:'USDT',active:true,swap:true,linear:true,
    contractSize:1,precision:{amount:1,price:.01},limits:{amount:{min:1},cost:{min:1000}}};
  const calls:string[]=[],posted:any[]=[],queried:any[]=[],nativeId='10001';let held=10,failReads=false;
  const gateAccount={currency:'USDT',available:'100',total:'100',unrealised_pnl:'0',position_mode:'single',margin_mode:0};
  const bybitAccount={retCode:0,result:{unifiedMarginStatus:5,marginMode:'REGULAR_MARGIN'}};
  const bitgetSettings={accountMode:kind==='classic'?'hybrid':'unified',accountLevel:'basic',holdMode:'one_way_mode',assetMode:'multi_assets',deltaSwitch:'no',
    symbolConfigList:[{category:'USDT-FUTURES',symbol:market.id,marginMode:'crossed',leverage:'2'}]};
  const classicAccount={marginCoin:'USDT',assetMode:'single',posMode:'one_way_mode',marginMode:'isolated',isolatedLongLever:'2',isolatedShortLever:'2'};
  const method=(name:string,fn:(params:any)=>any)=>async(params:any)=>{calls.push(name);return fn(params);};
  const create=(payload:any)=>{posted.push(payload);return {id:nativeId,orderId:nativeId,clientOid:exchangeClientId(venue,request.clientOrderId)};};
  const read=(params:any)=>{queried.push(params);if(failReads)throw new Error('offline missing original receipt');return {
    id:nativeId,contract:market.id,size:'-10',left:'-10',price:'11',fill_price:'0',tif:'ioc',text:exchangeClientId(venue,request.clientOrderId),
    is_reduce_only:true,is_close:false,status:'finished',finish_time_ms:Date.now(),
  };};
  const client:any={apiKey:'offline-key',secret:'offline-secret',password:'offline-pass',precisionMode:4,has:{fetchMyTrades:false},
    markets:{[symbol]:market},loadMarkets:async()=>{calls.push('markets');return {[symbol]:market};},market:()=>market,
    amountToPrecision:(_s:string,value:number|string)=>String(value),priceToPrecision:(_s:string,value:number)=>String(value),
    privateFuturesGetSettleAccounts:method('account',()=>gateAccount),
    privateFuturesGetSettlePositions:method('positions',()=>[{contract:market.id,size:String(held),mode:'single',leverage:'2'}]),
    privateFuturesPostSettleOrders:method('create',create),privateFuturesGetSettleOrdersOrderId:method('order',read),
    privateFuturesGetSettleMyTrades:method('trades',()=>[]),
    privateGetV5AccountInfo:method('account',()=>bybitAccount),
    privateGetV5PositionList:method('positions',()=>({retCode:0,result:{list:[{symbol:market.id,size:String(held),positionIdx:0,side:'Buy',leverage:'2'}]}})),
    privatePostV5OrderCreate:method('create',params=>({retCode:0,result:create(params)})),
    privateGetV5OrderRealtime:method('order',params=>{queried.push(params);if(failReads)throw new Error('offline missing original receipt');return {retCode:0,result:{list:[{
      orderId:nativeId,symbol:market.id,orderLinkId:exchangeClientId(venue,request.clientOrderId),side:'Sell',positionIdx:0,reduceOnly:true,
      orderType:'Limit',timeInForce:'IOC',price:'11',qty:'10',cumExecQty:'0',avgPrice:'',updatedTime:String(Date.now()),cumFeeDetail:{USDT:'0'},extraFees:'',orderStatus:'Cancelled',
    }]}};}),
    privateGetV5OrderHistory:method('history',()=>({retCode:0,result:{list:[]}})),
    privateUtaGetV3AccountSettings:method('settings',()=>response(bitgetSettings)),
    privateUtaGetV3AccountAssets:method('assets',()=>response({accountEquity:'100',effEquity:'100',imr:'0',assets:[{coin:'USDT',equity:'100',available:'100',debt:'0'}]})),
    privateMixGetV2MixAccountAccount:method('account',()=>response(classicAccount)),
    privateMixPostV2MixOrderPlaceOrder:method('create',params=>response(create(params))),
    privateUtaPostV3TradePlaceOrder:method('create',params=>response(create(params))),
  };
  const adapter=new CcxtAdapter(venue,{...defaultConfig,mode:'live',dataSource:'public'},client);
  const native=()=>kind==='gate'?new GatePrivate(client):kind==='bybit'?new BybitPrivate(client):kind==='classic'?new BitgetClassic(client):new BitgetUta(client);
  return {kind,venue,client,adapter,native,calls,posted,queried,gateAccount,bybitAccount,bitgetSettings,classicAccount,
    held(value:number){held=value;},failReads(){failReads=true;}};
}

test('confirmed Maker peer local validation keeps quantity/price rules without private account, fee or order reads',async()=>{
  for(const kind of ['gate','bybit','classic','uta'] as const){const f=fixture(kind);try{
    await f.adapter.validateOrderLocally(request);
    assert.ok(f.calls.every(name=>name==='markets'));assert.equal(f.posted.length,0);
    for(const change of [{quantity:10.5},{base:'OTHER'},{limitPrice:NaN},{quantity:0},{postOnly:true}])
      await assert.rejects(f.adapter.validateOrderLocally({...request,...change}));
    assert.ok(f.calls.every(name=>name==='markets'));assert.equal(f.posted.length,0);
  }finally{await f.adapter.close();}}
});

test('local validation does not replace the native Gate/Bybit side and holdings checks before peer POST',async()=>{
  for(const kind of ['gate','bybit'] as const){const f=fixture(kind);try{
    await f.adapter.validateOrderLocally(request);f.held(9);let permits=0;
    const result=await f.adapter.placeOrder(request,()=>{permits++;return true;});
    assert.equal(result.status,'cancelled');assert.equal(result.filledQuantity,0);assert.equal(f.posted.length,0);assert.equal(permits,0);
    assert.ok(f.calls.includes('positions'));assert.ok(f.calls.includes('account'));
  }finally{await f.adapter.close();}}
});

test('Gate/Bybit peer permit is checked after deferred native reads and a veto cannot replay its original ID',async()=>{
  for(const kind of ['gate','bybit'] as const)for(const throws of [false,true]){const f=fixture(kind);try{
    const entered=deferred<void>(),release=deferred<void>();let allowed=true,permits=0;
    const name=kind==='gate'?'privateFuturesGetSettleAccounts':'privateGetV5AccountInfo',original=f.client[name];
    f.client[name]=async(params:any)=>{entered.resolve();await release.promise;return original(params);};
    const task=f.adapter.placeOrder(request,()=>{permits++;if(throws&&!allowed)throw new Error('offline veto');return allowed;});
    await entered.promise;assert.equal(permits,0);assert.equal(f.posted.length,0);allowed=false;release.resolve();
    const result=await task;
    assert.equal(permits,1);assert.equal(result.rejectionCode,'ORDER_SUBMISSION_PERMISSION_CHANGED');
    assert.equal(result.status,'cancelled');assert.equal(result.id,'');assert.equal(result.filledQuantity,0);assert.equal(result.feeUsd,0);
    assert.ok(f.calls.includes('positions'));assert.equal(f.posted.length,0);assert.equal(f.queried.length,0);
    assert.deepEqual(await f.adapter.placeOrder(request,()=>true),result);assert.equal(permits,1);assert.equal(f.posted.length,0);
    await assert.rejects(f.native().place(request,10,11,()=>true),(error:any)=>error instanceof OrderNotSubmittedError);
    assert.equal(f.posted.length,0);
  }finally{await f.adapter.close();}}
});

test('allowed Gate/Bybit peers preserve IOC reduce-only selectors and retain the verified original receipt',async()=>{
  for(const kind of ['gate','bybit'] as const){const f=fixture(kind);try{
    let permits=0;await f.adapter.validateOrderLocally(request);
    const result=await f.adapter.placeOrder(request,()=>{permits++;assert.ok(f.calls.includes('account')&&f.calls.includes('positions'));return true;});
    assert.equal(result.status,'cancelled');assert.equal(result.id,'10001');assert.equal(result.feeUsd,0);assert.equal(f.posted.length,1);
    assert.equal(permits,1);
    if(kind==='gate'){assert.equal(f.posted[0].reduce_only,true);assert.equal(f.posted[0].tif,'ioc');assert.equal(f.posted[0].size,'-10');}
    else{assert.equal(f.posted[0].reduceOnly,true);assert.equal(f.posted[0].timeInForce,'IOC');assert.equal(f.posted[0].qty,'10');}
    assert.deepEqual(await f.adapter.placeOrder(request,()=>false),result);assert.equal(f.posted.length,1);assert.equal(permits,1);
  }finally{await f.adapter.close();}}
});

test('an acknowledged unknown peer stays bound to its original ID when a later permit is false',async()=>{
  for(const kind of ['gate','bybit'] as const){const f=fixture(kind);try{
    f.failReads();let permits=0;
    const original=await f.adapter.placeOrder(request,()=>{permits++;return true;});
    assert.equal(original.status,'unknown');assert.equal(original.id,'10001');assert.equal(f.posted.length,1);
    const retained=await f.adapter.placeOrder(request,()=>{permits++;return false;});
    assert.equal(retained.status,'unknown');assert.equal(retained.id,'10001');assert.equal(retained.rejectionCode,undefined);
    assert.equal(permits,1);assert.equal(f.posted.length,1);
    assert.ok(f.queried.every(params=>(params.order_id??params.orderId)==='10001'));
  }finally{await f.adapter.close();}}
});

test('a later peer veto cannot replace a booked positive native receipt with zero quantity or fees',async()=>{
  const f=fixture('gate');try{
    f.client.privateFuturesGetSettleOrdersOrderId=async()=>({id:'10001',contract:'CT_USDT',size:'-10',left:'0',price:'11',fill_price:'11',
      tif:'ioc',text:exchangeClientId('gate',request.clientOrderId),is_reduce_only:true,is_close:false,status:'finished',finish_time_ms:Date.now()});
    f.client.privateFuturesGetSettleMyTrades=async()=>[{id:'101',order_id:'10001',contract:'CT_USDT',size:'-10',close_size:'-10',price:'11',
      fee:'.055',point_fee:'0',fee_currency:'USDT'}];
    let permits=0;const original=await f.adapter.placeOrder(request,()=>{permits++;return true;});
    assert.equal(original.status,'filled');assert.equal(original.filledQuantity,10);assert.equal(original.averagePrice,11);assert.equal(original.feeUsd,.055);
    const retained=await f.adapter.placeOrder(request,()=>{permits++;return false;});
    assert.deepEqual(retained,original);assert.equal(permits,1);assert.equal(f.posted.length,1);
  }finally{await f.adapter.close();}
});

test('Bitget Classic/UTA native peer guards run after mode reads and retain same-ID veto across fresh helpers',async()=>{
  for(const kind of ['classic','uta'] as const)for(const throws of [false,true]){const f=fixture(kind);try{
    const entered=deferred<void>(),release=deferred<void>();let allowed=true,permits=0;
    const name=kind==='classic'?'privateMixGetV2MixAccountAccount':'privateUtaGetV3AccountSettings',original=f.client[name];
    f.client[name]=async(params:any)=>{entered.resolve();await release.promise;return original(params);};
    const task=f.native().place(request,10,11,()=>{permits++;if(throws&&!allowed)throw new Error('offline veto');return allowed;});
    const rejected=assert.rejects(task,(error:any)=>error instanceof OrderNotSubmittedError&&error.rejectionCode==='ORDER_SUBMISSION_PERMISSION_CHANGED');
    await entered.promise;assert.equal(permits,0);allowed=false;release.resolve();await rejected;
    assert.equal(permits,1);assert.equal(f.posted.length,0);
    await assert.rejects(f.native().place(request,10,11,()=>true),(error:any)=>error instanceof OrderNotSubmittedError);
    await assert.rejects(f.native().place(request,10,11),(error:any)=>error instanceof OrderNotSubmittedError);
    assert.equal(f.posted.length,0);
  }finally{await f.adapter.close();}}
});

test('Bitget factory route propagates a final peer veto after its account routing and native mode reads',async()=>{
  for(const kind of ['classic','uta'] as const){const f=fixture(kind);try{
    let permits=0;
    const result=await f.adapter.placeOrder(request,()=>{permits++;assert.ok(f.calls.includes('settings'));
      assert.ok(f.calls.includes(kind==='classic'?'account':'assets'));return false;});
    assert.equal(permits,1);assert.equal(result.status,'cancelled');assert.equal(result.id,'');assert.equal(result.feeUsd,0);
    assert.equal(result.rejectionCode,'ORDER_SUBMISSION_PERMISSION_CHANGED');assert.equal(f.posted.length,0);
    assert.deepEqual(await f.adapter.placeOrder(request,()=>true),result);assert.equal(f.posted.length,0);assert.equal(permits,1);
  }finally{await f.adapter.close();}}
});

test('Bitget guarded native peer retains an ambiguous POST without resending through another helper',async()=>{
  for(const kind of ['classic','uta'] as const){const f=fixture(kind);try{
    const name=kind==='classic'?'privateMixPostV2MixOrderPlaceOrder':'privateUtaPostV3TradePlaceOrder';
    let attempts=0,permits=0;
    f.client[name]=async()=>{attempts++;throw new Error('offline POST may have reached venue');};
    await assert.rejects(f.native().place(request,10,11,()=>{permits++;return true;}));
    assert.equal(await f.native().place(request,10,11,()=>{permits++;return false;}),undefined);
    assert.equal(await f.native().place(request,10,11),undefined);
    assert.equal(attempts,1);assert.equal(permits,1);
  }finally{await f.adapter.close();}}
});

test('concurrent guarded native peers keep one original POST while its acknowledgement is in flight',async()=>{
  for(const kind of ['gate','bybit','classic','uta'] as const){const f=fixture(kind);try{
    const entered=deferred<void>(),release=deferred<void>();let attempts=0,permits=0;
    const name=kind==='gate'?'privateFuturesPostSettleOrders':kind==='bybit'?'privatePostV5OrderCreate':
      kind==='classic'?'privateMixPostV2MixOrderPlaceOrder':'privateUtaPostV3TradePlaceOrder',original=f.client[name];
    f.client[name]=async(params:any)=>{attempts++;entered.resolve();await release.promise;return original(params);};
    const first=f.native().place(request,10,11,()=>{permits++;return true;});
    await entered.promise;
    const duplicate=await f.native().place(request,10,11,()=>{permits++;return false;});
    assert.equal(duplicate,undefined);assert.equal(attempts,1);assert.equal(permits,1);release.resolve();
    assert.equal(await first,'10001');assert.equal(attempts,1);assert.equal(f.posted.length,1);
  }finally{await f.adapter.close();}}
});
