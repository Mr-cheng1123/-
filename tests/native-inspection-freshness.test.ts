import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {CcxtAdapter} from '../src/adapters/ccxt.js';
import {exchangeClientId,unknownOrder} from '../src/adapters/normalization.js';
import {defaultConfig} from '../src/shared/config.js';
import type {ExchangeId,OrderRequest,OrderResult} from '../src/shared/types.js';

const BASE=1791609000000,OLD_READ=BASE-500,ID='10001';
const request:OrderRequest={clientOrderId:'offline-inspection-freshness',base:'CT',symbol:'CT/USDT:USDT',side:'sell',quantity:10,limitPrice:11,reduceOnly:true,postOnly:false};
type Route='gate'|'bitget-uta'|'bitget-classic'|'binance'|'okx'|'bybit';
const wrappedRoutes=['gate','bitget-uta','bitget-classic','binance','okx'] as const;

function clock(t:TestContext){let now=BASE+1000;t.mock.method(Date,'now',()=>now);return {now:()=>now,advance:(ms:number)=>{now+=ms;}};}
function fixture(route:Route){
  const venue:ExchangeId=route.startsWith('bitget')?'bitget':route as ExchangeId;
  const market={id:venue==='gate'?'CT_USDT':venue==='okx'?'CT-USDT-SWAP':'CTUSDT',symbol:request.symbol,base:'CT',quote:'USDT',settle:'USDT',
    active:true,swap:true,linear:true,contractSize:1,precision:{amount:.1,price:.01},limits:{amount:{min:.1},cost:{min:1}}};
  const nativeClient=exchangeClientId(venue,request.clientOrderId),reads:string[]=[],writes:string[]=[];
  let readFailure=false,cashFailure=false,cashWait:(()=>Promise<void>)|undefined;
  let raw:any=venue==='gate'?{id:ID,contract:market.id,size:'-10',left:'0',price:'11',fill_price:'11',tif:'ioc',text:nativeClient,
    is_reduce_only:true,is_close:false,status:'finished',finish_as:'filled',create_time_ms:String(BASE),finish_time_ms:String(BASE)}:
    route==='bitget-classic'?{orderId:ID,symbol:market.id,clientOid:nativeClient,side:'sell',marginCoin:'USDT',reduceOnly:'YES',posMode:'one_way_mode',
      marginMode:'crossed',orderType:'limit',force:'ioc',price:'11',size:'10',baseVolume:'10',priceAvg:'11',fee:'-.001',uTime:String(BASE),state:'filled'}:
    route==='bitget-uta'?{orderId:ID,category:'USDT-FUTURES',symbol:market.id,clientOid:nativeClient,side:'sell',reduceOnly:'YES',holdMode:'one_way_mode',
      posSide:'net',tradeSide:'close',marginMode:'crossed',orderType:'limit',timeInForce:'ioc',price:'11',qty:'10',cumExecQty:'10',avgPrice:'11',
      feeDetail:[{feeCoin:'USDT',fee:'.001'}],updatedTime:String(BASE),orderStatus:'filled'}:
    venue==='bybit'?{orderId:ID,symbol:market.id,orderLinkId:nativeClient,side:'Sell',positionIdx:0,reduceOnly:true,orderType:'Limit',timeInForce:'IOC',
      price:'11',qty:'10',cumExecQty:'10',avgPrice:'11',updatedTime:String(BASE),cumFeeDetail:{USDT:'.001'},extraFees:'',orderStatus:'Filled'}:
    {id:ID,symbol:request.symbol,side:'sell',type:'limit',clientOrderId:nativeClient,amount:10,filled:10,average:11,cost:110,status:'closed',
      reduceOnly:true,timeInForce:'IOC',timestamp:BASE,fees:[{cost:.001,currency:'USDT'}],info:venue==='binance'?
        {orderId:ID,clientOrderId:nativeClient,symbol:market.id,side:'SELL',positionSide:'BOTH',type:'LIMIT',origType:'LIMIT',timeInForce:'IOC',reduceOnly:true,origQty:'10'}:
        {ordId:ID,clOrdId:nativeClient,instId:market.id,side:'sell',posSide:'net',ordType:'ioc',tdMode:'cross',reduceOnly:true,sz:'10'}};
  let fills:any[]=venue==='gate'?[{id:'501',order_id:ID,contract:market.id,size:'-10',close_size:'-10',price:'11',fee:'.001',point_fee:'0',fee_currency:'USDT'}]:
    [{execId:'offline-trade-1',orderId:ID,clientOid:nativeClient,category:'USDT-FUTURES',symbol:market.id,side:'sell',orderType:'limit',tradeSide:'close',
      execQty:'10',execPrice:'11',feeDetail:[{feeCoin:'USDT',fee:'.001'}]}];
  const nativeRead=async(name:string)=>{reads.push(name);if(readFailure)throw new Error('offline native GET failed');return structuredClone(raw);};
  const nativeCash=async(name:string)=>{reads.push(name);if(cashWait)await cashWait();if(cashFailure)throw new Error('offline cash GET failed');return structuredClone(fills);};
  const forbidden=async(name:string)=>{writes.push(name);throw new Error(`Unexpected financial action ${name}`);};
  const client:any={apiKey:'offline-key',secret:'offline-secret',password:'offline-passphrase',precisionMode:4,has:{fetchMyTrades:false},
    markets:{[market.symbol]:market},market:(symbol:string)=>{assert.equal(symbol,request.symbol);return market;},loadMarkets:async()=>({[market.symbol]:market}),
    amountToPrecision:(_s:string,n:number)=>String(n),priceToPrecision:(_s:string,n:number)=>String(n),close:async()=>{},
    fetch:async()=>{throw new Error('Network is forbidden in offline inspection tests');},
    fetchImplementation:async()=>{throw new Error('Network is forbidden in offline inspection tests');},
    privateFuturesGetSettleOrdersOrderId:async(params:any)=>{assert.equal(params.order_id,ID);return nativeRead('gate-order');},
    privateFuturesGetSettleMyTrades:async(params:any)=>{assert.equal(params.order,ID);return nativeCash('gate-cash');},
    privateUtaGetV3AccountSettings:async()=>{reads.push('bitget-settings');return {code:'00000',data:{accountMode:route==='bitget-classic'?'hybrid':'unified'}};},
    privateMixGetV2MixOrderDetail:async(params:any)=>{assert.equal(params.orderId,ID);return {code:'00000',data:await nativeRead('classic-order')};},
    privateUtaGetV3TradeOrderInfo:async(params:any)=>{assert.equal(params.orderId,ID);return {code:'00000',data:await nativeRead('uta-order')};},
    privateUtaGetV3TradeFills:async(params:any)=>{assert.equal(params.orderId,ID);return {code:'00000',data:{list:await nativeCash('uta-cash'),cursor:''}};},
    privateGetV5OrderRealtime:async(params:any)=>{assert.equal(params.orderId,ID);return {retCode:0,result:{list:[await nativeRead('bybit-order')]}};},
    privateGetV5OrderHistory:async()=>{throw new Error('A successful fixture order must not need speculative history');},
    fetchOrder:async(id:string)=>{assert.equal(id,ID);return nativeRead(`${venue}-order`);},
  };
  for(const name of ['createOrder','cancelOrder','setLeverage','setMarginMode','setPositionMode','transfer','withdraw','privateFuturesPostSettleOrders',
    'privateFuturesDeleteSettleOrdersOrderId','privateUtaPostV3TradePlaceOrder','privateUtaPostV3TradeCancelOrder','privateMixPostV2MixOrderPlaceOrder',
    'privateMixPostV2MixOrderCancelOrder','privatePostV5OrderCreate','privatePostV5OrderCancel'])client[name]=()=>forbidden(name);
  const adapter=new CcxtAdapter(venue,{...defaultConfig,mode:'live',dataSource:'public'},client);
  const prior=Object.freeze({...unknownOrder(request,ID),timestamp:BASE,orderReadAt:OLD_READ});
  const seed=(result:OrderResult=prior)=>{(adapter as any).submitted.set(request.clientOrderId,{request:JSON.stringify(request),result});return result;};
  seed();
  return {adapter,client,reads,writes,prior,seed,patchRaw:(patch:any)=>{raw={...raw,...patch};},patchFill:(patch:any)=>{fills=fills.map(row=>({...row,...patch}));},
    failRead:()=>{readFailure=true;},failCash:()=>{cashFailure=true;},waitCash:(wait:()=>Promise<void>)=>{cashWait=wait;},
    assertReadOnly:()=>{assert.deepEqual(writes,[]);},
    assertCached:(result:OrderResult)=>{assert.equal((adapter as any).submitted.get(request.clientOrderId).result,result);}};
}

for(const route of wrappedRoutes)test(`${route}: complete terminal GET adds fresh read evidence without replacing the cached receipt`,async t=>{
  const time=clock(t),f=fixture(route);
  try{
    const result=await f.adapter.inspectOrder(request,ID);
    assert.equal(result.status,'filled');assert.equal(result.filledQuantity,10);assert.equal(result.averagePrice,11);assert.equal(result.feeUsd,.001);
    assert.equal(result.orderReadAt,time.now());assert.ok(result.orderReadAt!>f.prior.orderReadAt!);
    assert.ok(f.reads.some(name=>name.endsWith('order')));f.assertCached(f.prior);f.assertReadOnly();
  }finally{await f.adapter.close();}
});

test('Gate read evidence is assigned only after the last awaited cash GET completes',async t=>{
  const time=clock(t),f=fixture('gate');let release!:()=>void,entered!:()=>void,settled=false;
  const blocked=new Promise<void>(resolve=>{release=resolve;}),cashEntered=new Promise<void>(resolve=>{entered=resolve;});
  f.waitCash(async()=>{entered();await blocked;});
  try{
    const pending=f.adapter.inspectOrder(request,ID).then(result=>{settled=true;return result;});
    await Promise.race([cashEntered,pending.then(()=>{throw new Error('Inspection returned before its expected cash GET');})]);
    assert.equal(settled,false);assert.equal(f.prior.orderReadAt,OLD_READ);f.assertCached(f.prior);
    time.advance(700);release();const result=await pending;
    assert.equal(result.orderReadAt,time.now());assert.equal(result.status,'filled');f.assertReadOnly();
  }finally{release();await f.adapter.close();}
});

test('failed wrapped native GETs retain old read evidence and cannot become fresh success',async t=>{
  clock(t);
  for(const route of wrappedRoutes){const f=fixture(route);try{
    f.failRead();const result=await f.adapter.inspectOrder(request,ID);
    assert.equal(result.orderReadAt,OLD_READ,route);assert.ok(result.status==='unknown'||result.averagePriceVerified===false,route);
    f.assertCached(f.prior);f.assertReadOnly();
  }finally{await f.adapter.close();}}
});

test('nonterminal native orders receive no successful terminal read marker',async t=>{
  clock(t);
  for(const route of wrappedRoutes){const f=fixture(route);try{
    f.patchRaw(route==='gate'?{status:'open'}:route==='bitget-classic'?{state:'partially_filled'}:route==='bitget-uta'?{orderStatus:'partially_filled'}:{status:'open'});
    const result=await f.adapter.inspectOrder(request,ID);assert.equal(result.status,'unknown',route);assert.notEqual(result.orderReadAt,Date.now(),route);
    f.assertCached(f.prior);f.assertReadOnly();
  }finally{await f.adapter.close();}}
});

test('wrong identity or an out-of-bound execution price cannot mint fresh read evidence',async t=>{
  clock(t);
  for(const route of wrappedRoutes)for(const bad of ['identity','price'] as const){const f=fixture(route);try{
    if(bad==='identity')f.patchRaw(route==='gate'?{text:'another-client'}:route.startsWith('bitget')?{clientOid:'another-client'}:{clientOrderId:'another-client'});
    else if(route==='gate')f.patchFill({price:'10'});
    else if(route==='bitget-uta')f.patchFill({execPrice:'10'});
    else f.patchRaw(route==='bitget-classic'?{priceAvg:'10'}:{average:10,cost:100});
    const result=await f.adapter.inspectOrder(request,ID);assert.notEqual(result.orderReadAt,Date.now(),`${route}/${bad}`);
    assert.ok(result.status==='unknown'||result.averagePriceVerified===false||result.averagePrice<request.limitPrice,`${route}/${bad}`);
    f.assertCached(f.prior);f.assertReadOnly();
  }finally{await f.adapter.close();}}
});

test('missing or invalid actual fees cannot produce fresh terminal success',async t=>{
  clock(t);
  for(const route of wrappedRoutes){const f=fixture(route);try{
    if(route==='gate')f.patchFill({fee:'not-a-fee'});
    else if(route==='bitget-uta')f.patchFill({feeDetail:[{feeCoin:'BTC',fee:'.001'}]});
    else if(route==='bitget-classic')f.patchRaw({fee:'not-a-fee'});
    else f.patchRaw({fees:[{cost:.001,currency:'BTC'}]});
    const result=await f.adapter.inspectOrder(request,ID);assert.notEqual(result.orderReadAt,Date.now(),route);
    assert.ok(result.status==='unknown'||result.averagePriceVerified===false,route);f.assertCached(f.prior);f.assertReadOnly();
  }finally{await f.adapter.close();}}
});

test('Bitget UTA zero-fill cached terminal receipt stays old when the current GET fails',async t=>{
  clock(t);const f=fixture('bitget-uta');
  const prior=Object.freeze({...f.prior,status:'cancelled' as const,filledQuantity:0,averagePrice:0,feeUsd:0,averagePriceVerified:true});f.seed(prior);f.failRead();
  try{
    const result=await f.adapter.inspectOrder(request,ID);
    assert.equal(result.status,'cancelled');assert.equal(result.filledQuantity,0);assert.equal(result.averagePriceVerified,false);assert.equal(result.orderReadAt,OLD_READ);
    f.assertCached(prior);f.assertReadOnly();
  }finally{await f.adapter.close();}
});

test('Bitget UTA confirmed positive quantity without its final cash GET gets no new read evidence',async t=>{
  clock(t);const f=fixture('bitget-uta');
  const prior=Object.freeze({...f.prior,status:'filled' as const,filledQuantity:10,averagePrice:11,feeUsd:.001,averagePriceVerified:true});f.seed(prior);f.failCash();
  try{
    const result=await f.adapter.inspectOrder(request,ID);
    assert.equal(result.filledQuantity,10);assert.equal(result.averagePriceVerified,false);assert.notEqual(result.orderReadAt,Date.now());
    assert.ok(f.reads.includes('uta-cash'));f.assertCached(prior);f.assertReadOnly();
  }finally{await f.adapter.close();}
});

test('Binance and OKX known no-submit caches return unchanged without a native order GET or fresh time',async t=>{
  clock(t);
  for(const route of ['binance','okx'] as const){const f=fixture(route);try{
    const prior=Object.freeze({...f.prior,id:'',status:'cancelled' as const,rejectionCode:'PRE_SUBMISSION_CHECK_FAILED',filledQuantity:0,averagePrice:0,feeUsd:0});f.seed(prior);
    const result=await f.adapter.inspectOrder(request);
    assert.equal(result,prior);assert.equal(result.orderReadAt,OLD_READ);assert.deepEqual(f.reads,[]);f.assertCached(prior);f.assertReadOnly();
  }finally{await f.adapter.close();}}
});

test('Bybit retains its native observation timestamp semantics on both success and failed reads',async t=>{
  const time=clock(t),f=fixture('bybit');
  try{
    const success=await f.adapter.inspectOrder(request,ID);assert.equal(success.status,'filled');assert.equal(success.orderReadAt,time.now());
    time.advance(300);f.failRead();const failed=await f.adapter.inspectOrder(request,ID);
    assert.equal(failed.status,'unknown');assert.equal(failed.orderReadAt,time.now());assert.equal(failed.confirmation?.stage,'order-read');
    assert.equal(failed.confirmation?.observedAt,time.now());f.assertCached(f.prior);f.assertReadOnly();
  }finally{await f.adapter.close();}
});

test('Bitget independent execution proof adds freshness after complete final native cash without changing the cache',async t=>{
  const time=clock(t),f=fixture('bitget-uta');let release!:()=>void,entered!:()=>void,settled=false;
  const blocked=new Promise<void>(resolve=>{release=resolve;}),cashEntered=new Promise<void>(resolve=>{entered=resolve;});
  f.waitCash(async()=>{entered();await blocked;});
  try{
    const pending=f.adapter.verifyOrderExecution(request,ID).then(result=>{settled=true;return result;});
    await Promise.race([cashEntered,pending.then(()=>{throw new Error('Verification returned before its expected cash GET');})]);
    assert.equal(settled,false);assert.equal(f.prior.orderReadAt,OLD_READ);time.advance(700);release();
    const result=await pending;assert.equal(result.status,'filled');assert.equal(result.averagePriceVerified,true);
    assert.equal(result.averagePrice,11);assert.equal(result.feeUsd,.001);assert.equal(result.orderReadAt,time.now());
    assert.ok(f.reads.includes('uta-order'));assert.ok(f.reads.includes('uta-cash'));f.assertCached(f.prior);f.assertReadOnly();
  }finally{release();await f.adapter.close();}
});

test('Bitget independent execution proof cannot add fresh terminal evidence on failed or nonterminal native reads',async t=>{
  clock(t);
  for(const failure of ['order','cash','nonterminal'] as const){const f=fixture('bitget-uta');try{
    if(failure==='order')f.failRead();else if(failure==='cash')f.failCash();else f.patchRaw({orderStatus:'partially_filled'});
    if(failure==='nonterminal'){
      const result=await f.adapter.verifyOrderExecution(request,ID);assert.equal(result.status,'unknown');assert.notEqual(result.orderReadAt,Date.now());
    }else await assert.rejects(f.adapter.verifyOrderExecution(request,ID),/offline .* GET failed/);
    f.assertCached(f.prior);assert.equal(f.prior.orderReadAt,OLD_READ);f.assertReadOnly();
  }finally{await f.adapter.close();}}
});
