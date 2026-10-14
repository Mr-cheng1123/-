import test from 'node:test';
import assert from 'node:assert/strict';
import {CcxtAdapter} from '../src/adapters/ccxt.js';
import {BybitPrivate} from '../src/adapters/bybit-private.js';
import {BitgetUta} from '../src/adapters/bitget-uta.js';
import {BitgetClassic} from '../src/adapters/bitget-classic.js';
import {GatePrivate} from '../src/adapters/gate-private.js';
import {exchangeClientId} from '../src/adapters/normalization.js';
import {defaultConfig} from '../src/shared/config.js';
import type {OrderRequest} from '../src/shared/types.js';

// Official, product-specific reasons. Gate Futures has no documented finish_as=poc;
// Bitget Classic's order-detail cancellation table does not document the UTA reason.
// https://bybit-exchange.github.io/docs/v5/enum#rejectreason
// https://www.bitget.com/docs/uta/enum#cancelreason
// https://www.gate.com/docs/developers/apiv4/en/futures/#futuresorder
// https://www.bitget.com/docs/catalog/classic-contract-trade/classic-contract-trade
const request:OrderRequest={clientOrderId:'offline-maker-requote',base:'CT',symbol:'CT/USDT:USDT',
  side:'sell',quantity:2,limitPrice:11,reduceOnly:true,postOnly:true};
type Venue='bybit'|'bitget';
const expectedCode=(venue:Venue)=>venue==='bybit'?'EC_PostOnlyWillTakeLiquidity':'MAKER_POST_ONLY_WOULD_TAKE';

function fixture(venue:Venue){
  const market={id:'CTUSDT',symbol:request.symbol,base:'CT',quote:'USDT',settle:'USDT',active:true,swap:true,linear:true,
    contractSize:1,precision:{amount:.1,price:.01},limits:{amount:{min:.1},cost:{min:5}}};
  const clientId=exchangeClientId(venue,request.clientOrderId),calls:string[]=[];
  let filled=0,failed=false,feeKnown=true;
  const raw:any=venue==='bybit'?{orderId:'original-native-order',symbol:market.id,orderLinkId:clientId,side:'Sell',positionIdx:0,
    reduceOnly:true,orderType:'Limit',timeInForce:'PostOnly',price:'11',qty:'2',cumExecQty:'0',avgPrice:'',updatedTime:String(Date.now()),
    cumFeeDetail:{USDT:'0'},extraFees:'',orderStatus:'Rejected',rejectReason:'EC_PostOnlyWillTakeLiquidity'}:
    {orderId:'original-native-order',category:'USDT-FUTURES',symbol:market.id,clientOid:clientId,side:'sell',posSide:'long',tradeSide:'close_long',
      reduceOnly:'YES',orderType:'limit',timeInForce:'post_only',price:'11',qty:'2',cumExecQty:'0',avgPrice:'0',updatedTime:String(Date.now()),
      holdMode:'one_way_mode',marginMode:'crossed',feeDetail:[{feeCoin:'USDT',fee:'0'}],orderStatus:'cancelled',cancelReason:'post_only_fill_cancel'};
  const read=async()=>{calls.push('order-get');if(failed)throw new Error('offline transport failure');return {...raw};};
  const fill=()=>venue==='bybit'?{execId:'identified-execution',orderId:raw.orderId,orderLinkId:clientId,symbol:market.id,side:'Sell',
    orderType:'Limit',execType:'Trade',isMaker:true,execQty:String(filled),execPrice:'11',execFee:feeKnown?'.002':undefined,
    closedSize:String(filled),feeCurrency:'USDT',extraFees:'',execTime:String(Date.now())}:
    {execId:'identified-execution',orderId:raw.orderId,clientOid:clientId,category:'USDT-FUTURES',symbol:market.id,side:'sell',
      orderType:'limit',tradeSide:'close_long',tradeScope:'maker',execQty:String(filled),execPrice:'11',
      feeDetail:feeKnown?[{feeCoin:'USDT',fee:'.002'}]:[]};
  const unexpected=async()=>{throw new Error('Unexpected offline financial or fee request');};
  const client:any={apiKey:'offline-key',secret:'offline-secret',password:'offline-passphrase',precisionMode:4,markets:{[market.symbol]:market},
    market:()=>market,loadMarkets:async()=>({[market.symbol]:market}),close:async()=>{},
    privateGetV5OrderRealtime:async()=>({retCode:0,result:{list:[await read()]}}),
    privateGetV5OrderHistory:async()=>({retCode:0,result:{list:[await read()]}}),
    privateGetV5ExecutionList:async()=>{calls.push('fills-get');return {retCode:0,result:{category:'linear',list:[fill()],nextPageCursor:''}};},
    privateUtaGetV3AccountSettings:async()=>{calls.push('settings-get');return {code:'00000',data:{accountMode:'unified'}};},
    privateUtaGetV3TradeOrderInfo:async()=>({code:'00000',data:await read()}),
    privateUtaGetV3TradeFills:async()=>{calls.push('fills-get');return {code:'00000',data:{list:[fill()],cursor:''}};},
    privatePostV5OrderCreate:unexpected,privatePostV5OrderCancel:unexpected,
    privateUtaPostV3TradePlaceOrder:unexpected,privateUtaPostV3TradeCancelOrder:unexpected,
    privateGetV5AccountFeeRate:unexpected,privateUtaGetV3AccountFeeRate:unexpected};
  const adapter=new CcxtAdapter(venue,{...defaultConfig,mode:'live',dataSource:'public'},client);
  return {adapter,client,raw,calls,native:venue==='bybit'?new BybitPrivate(client):new BitgetUta(client),
    filled(value:number){filled=value;raw.cumExecQty=String(value);raw.avgPrice=value?'11':'0';
      if(venue==='bybit')raw.cumFeeDetail={USDT:value?'.002':'0'};else raw.feeDetail=[{feeCoin:'USDT',fee:value?'.002':'0'}];},
    fail(){failed=true;},missingFillFee(){feeKnown=false;}};
}

function classicFixture(){
  const f=fixture('bitget');
  const raw:any={orderId:'original-native-order',symbol:'CTUSDT',clientOid:exchangeClientId('bitget',request.clientOrderId),
    side:'sell',marginCoin:'USDT',posMode:'one_way_mode',marginMode:'isolated',reduceOnly:'YES',orderType:'limit',
    force:'post_only',price:'11',size:'2',baseVolume:'0',priceAvg:'0',fee:'0',state:'rejected',uTime:String(Date.now())};
  let filled=0,feeKnown=true;
  f.client.privateUtaGetV3AccountSettings=async()=>{f.calls.push('settings-get');return {code:'00000',data:{accountMode:'hybrid'}};};
  f.client.privateMixGetV2MixOrderDetail=async()=>{f.calls.push('classic-order-get');return {code:'00000',data:{...raw}};};
  f.client.privateMixGetV2MixOrderFills=async()=>{
    f.calls.push('classic-fills-get');return {code:'00000',data:{fillList:[{tradeId:'identified-classic-fill',orderId:raw.orderId,
      symbol:raw.symbol,side:'sell',posMode:'one_way_mode',tradeSide:'sell_single',tradeScope:'maker',baseVolume:String(filled),price:'11',
      feeDetail:feeKnown?[{feeCoin:'USDT',deduction:'no',totalDeductionFee:'0',totalFee:'-.002'}]:[]}],endId:''}};
  };
  return {...f,raw,native:new BitgetClassic(f.client),filled(value:number){filled=value;raw.baseVolume=String(value);
    raw.priceAvg=value?'11':'0';raw.fee=value?'-.002':'0';},missingFillFee(){feeKnown=false;}};
}

function gateFixture(){
  const market={id:'CT_USDT',symbol:request.symbol,base:'CT',quote:'USDT',settle:'USDT',active:true,swap:true,linear:true,
    contractSize:1,precision:{amount:.1,price:.01},limits:{amount:{min:.1},cost:{min:5}}};
  const raw:any={id:'10001',contract:market.id,size:'-2',left:'-2',price:'11',fill_price:'0',tif:'poc',
    text:exchangeClientId('gate',request.clientOrderId),is_reduce_only:true,is_close:false,status:'finished',
    finish_as:'cancelled',create_time_ms:String(Date.now())};
  const calls:Array<{method:string;params:any}>=[];let filled=0,feeKnown=true;
  const unexpected=async()=>{throw new Error('Unexpected offline Gate financial or fee request');};
  const client:any={apiKey:'offline-key',secret:'offline-secret',precisionMode:4,markets:{[market.symbol]:market},
    market:()=>market,loadMarkets:async()=>({[market.symbol]:market}),close:async()=>{},
    privateFuturesGetSettleOrdersOrderId:async(params:any)=>{calls.push({method:'order-get',params});return {...raw};},
    privateFuturesGetSettleMyTrades:async(params:any)=>{calls.push({method:'fills-get',params});return [{id:'501',
      order_id:'10001',contract:market.id,size:String(-filled),close_size:String(-filled),price:'11',fee:feeKnown?'.002':undefined,
      point_fee:'0',fee_currency:'USDT'}];},
    privateFuturesPostSettleOrders:unexpected,privateFuturesDeleteSettleOrdersOrderId:unexpected,privateFuturesGetSettleFee:unexpected};
  const adapter=new CcxtAdapter('gate',{...defaultConfig,mode:'live',dataSource:'public'},client);
  return {adapter,raw,calls,native:new GatePrivate(client),filled(value:number){filled=value;raw.left=String(-(request.quantity-value));
    raw.fill_price=value?'11':'0';},missingFillFee(){feeKnown=false;}};
}

test('Gate verified manual cancellations and consistent full fills preserve the original continuation classification',async()=>{
  for(const [finish,quantity] of [['cancelled',0],['cancelled',.5],['filled',2]] as const){const f=gateFixture();try{
    f.raw.finish_as=finish;f.filled(quantity);
    const observed=await f.adapter.inspectMakerReduction(request,'10001');
    assert.equal(observed.activity,'terminal');assert.equal(observed.executionVerified,true);
    assert.equal(observed.result.filledQuantity,quantity);assert.equal(observed.result.feeUsd,quantity?.002:0);
    assert.equal(observed.result.status,quantity===2?'filled':quantity?'partial':'cancelled');
    assert.equal(observed.result.rejectionCode,undefined);
    assert.ok(f.calls.filter(call=>call.method==='order-get').every(call=>call.params.order_id==='10001'));
  }finally{await f.adapter.close();}}
});

test('Gate risk, IOC, missing and undocumented Maker finish reasons retain verified zero or partial cash and hard-stop new batches',async()=>{
  const reasons=['liquidated','auto_deleveraged','reduce_only','position_closed','reduce_out','stp','ioc','poc','unknown',undefined,''];
  for(const finish of reasons)for(const quantity of [0,.5]){const f=gateFixture();try{
    f.raw.finish_as=finish;f.filled(quantity);
    const observed=await f.adapter.inspectMakerReduction(request,'10001');
    assert.equal(observed.activity,'terminal');assert.equal(observed.executionVerified,true);
    assert.equal(observed.result.id,'10001');assert.equal(observed.result.clientOrderId,request.clientOrderId);
    assert.equal(observed.result.filledQuantity,quantity);assert.equal(observed.result.averagePrice,quantity?11:0);
    assert.equal(observed.result.averagePriceVerified,true);assert.equal(observed.result.feeUsd,quantity?.002:0);
    assert.equal(observed.result.status,quantity?'partial':'cancelled');
    assert.equal(observed.result.rejectionCode,'MAKER_REDUCTION_FINISH_REASON_BLOCKED');
    assert.match(observed.result.rejectionReason!,/保留已确认成交和费用/);
  }finally{await f.adapter.close();}}
});

test('Gate filled finish reason contradicting zero or partial quantity hard-stops while preserving verified execution',async()=>{
  for(const quantity of [0,.5]){const f=gateFixture();try{
    f.raw.finish_as='filled';f.filled(quantity);
    const observed=await f.adapter.inspectMakerReduction(request,'10001');
    assert.equal(observed.activity,'terminal');assert.equal(observed.executionVerified,true);
    assert.equal(observed.result.filledQuantity,quantity);assert.equal(observed.result.feeUsd,quantity?.002:0);
    assert.equal(observed.result.rejectionCode,'MAKER_REDUCTION_FINISH_REASON_BLOCKED');
  }finally{await f.adapter.close();}}
});

test('Gate active and ordinary IOC results keep their existing classification even with risky native finish text',async()=>{
  const active=gateFixture();try{
    active.raw.status='open';active.raw.finish_as='stp';active.filled(.5);
    const observed=await active.adapter.inspectMakerReduction(request,'10001');
    assert.equal(observed.activity,'active');assert.equal(observed.executionVerified,true);assert.equal(observed.result.status,'unknown');
    assert.equal(observed.result.filledQuantity,.5);assert.equal(observed.result.feeUsd,.002);assert.equal(observed.result.rejectionCode,undefined);
  }finally{await active.adapter.close();}
  const ioc=gateFixture();try{
    ioc.raw.tif='ioc';ioc.raw.finish_as='stp';ioc.filled(.5);
    const result=await ioc.native.inspectOrder({...request,postOnly:false},undefined,'10001');
    assert.equal(result.status,'partial');assert.equal(result.filledQuantity,.5);assert.equal(result.feeUsd,.002);
    assert.equal(result.rejectionCode,undefined);
  }finally{await ioc.adapter.close();}
});

test('Gate risky finish metadata cannot bypass native identity or fill cash guards and preserves earlier confirmed cash',async()=>{
  for(const kind of ['identity','id','cash','regression'] as const){const f=gateFixture();try{
    f.filled(.5);f.raw.status='open';const prior=await f.adapter.inspectMakerReduction(request,'10001');
    assert.equal(prior.executionVerified,true);assert.equal(prior.result.filledQuantity,.5);
    f.raw.status='finished';f.raw.finish_as='stp';f.filled(1);
    if(kind==='identity')f.raw.text='other-client';if(kind==='id')f.raw.id='10002';
    if(kind==='cash')f.missingFillFee();if(kind==='regression')f.filled(0);
    const observed=await f.adapter.inspectMakerReduction(request,'10001');
    assert.equal(observed.activity,'unknown');assert.equal(observed.executionVerified,false);
    assert.equal(observed.result.filledQuantity,.5);assert.equal(observed.result.feeUsd,.002);assert.equal(observed.result.rejectionCode,undefined);
  }finally{await f.adapter.close();}}
});

test('Classic verified rejected zero retains native terminal execution and a hard rejection code',async()=>{
  const f=classicFixture();try{
    const observed=await f.adapter.inspectMakerReduction(request,'original-native-order');
    assert.equal(observed.activity,'terminal');assert.equal(observed.executionVerified,true);
    assert.equal(observed.result.id,'original-native-order');assert.equal(observed.result.clientOrderId,request.clientOrderId);
    assert.equal(observed.result.status,'cancelled');assert.equal(observed.result.filledQuantity,0);assert.equal(observed.result.feeUsd,0);
    assert.equal(observed.result.rejectionCode,'MAKER_REDUCTION_REJECTED_ZERO_FILL');assert.match(observed.result.rejectionReason!,/已拒绝/);
    assert.notEqual(observed.result.rejectionCode,'MAKER_POST_ONLY_WOULD_TAKE');
    const again=await f.adapter.inspectMakerReduction(request,'original-native-order');
    assert.equal(again.result.rejectionCode,'MAKER_REDUCTION_REJECTED_ZERO_FILL');
    assert.equal(f.calls.filter(call=>call==='classic-order-get').length,2);assert.equal(f.calls.includes('classic-fills-get'),false);
  }finally{await f.adapter.close();}
});

test('Classic ordinary cancellation and IOC rejected diagnostics do not receive the Maker hard rejection',async()=>{
  for(const state of ['canceled','cancelled']){const f=classicFixture();try{
    f.raw.state=state;f.raw.cancelReason='post_only_fill_cancel';
    const observed=await f.adapter.inspectMakerReduction(request,'original-native-order');
    assert.equal(observed.activity,'terminal');assert.equal(observed.executionVerified,true);
    assert.equal(observed.result.rejectionCode,undefined,'UTA cancellation reason does not grant Classic repricing permission');
  }finally{await f.adapter.close();}}
  const f=classicFixture();try{
    f.raw.force='ioc';const observed=await f.native.inspectOrder({...request,postOnly:false},undefined,'original-native-order');
    assert.equal(observed.status,'cancelled');assert.equal(observed.rejectionCode,undefined);
  }finally{await f.adapter.close();}
});

test('Classic Maker active, partial and unverified identity or cash cannot become rejected-zero metadata',async()=>{
  for(const kind of ['active','partial','identity','id','cash'] as const){const f=classicFixture();try{
    if(kind==='active')f.raw.state='live';
    if(kind==='partial'){f.filled(.4);f.raw.state='rejected';}
    if(kind==='identity')f.raw.clientOid='other-client';if(kind==='id')f.raw.orderId='other-order';
    if(kind==='cash'){f.filled(.4);f.missingFillFee();}
    const observed=await f.adapter.inspectMakerReduction(request,'original-native-order');
    assert.equal(observed.result.rejectionCode,undefined,kind);
    if(kind==='active'){assert.equal(observed.activity,'active');assert.equal(observed.executionVerified,true);}
    else if(kind==='partial'){assert.equal(observed.activity,'terminal');assert.equal(observed.executionVerified,true);
      assert.equal(observed.result.filledQuantity,.4);assert.equal(observed.result.feeUsd,.002);}
    else {assert.equal(observed.activity,'unknown');assert.equal(observed.executionVerified,false);}
  }finally{await f.adapter.close();}}
});

test('Classic rejected zero readback preserves a previously verified partial and cash',async()=>{
  const f=classicFixture();try{
    f.filled(.4);f.raw.state='partially_filled';
    const prior=await f.adapter.inspectMakerReduction(request,'original-native-order');
    assert.equal(prior.executionVerified,true);assert.equal(prior.result.filledQuantity,.4);
    f.filled(0);f.raw.state='rejected';
    const observed=await f.adapter.inspectMakerReduction(request,'original-native-order');
    assert.equal(observed.activity,'unknown');assert.equal(observed.executionVerified,false);
    assert.equal(observed.result.filledQuantity,.4);assert.equal(observed.result.feeUsd,.002);
    assert.equal(observed.result.rejectionCode,undefined);
  }finally{await f.adapter.close();}
});

for(const venue of ['bybit','bitget'] as const){
  test(`${venue} original verified terminal zero retains only the documented PostOnly liquidity reason`,async()=>{
    const f=fixture(venue);try{
      const observed=await f.adapter.inspectMakerReduction(request,'original-native-order');
      assert.equal(observed.activity,'terminal');assert.equal(observed.executionVerified,true);
      assert.equal(observed.result.id,'original-native-order');assert.equal(observed.result.clientOrderId,request.clientOrderId);
      assert.equal(observed.result.status,'cancelled');assert.equal(observed.result.filledQuantity,0);assert.equal(observed.result.feeUsd,0);
      assert.equal(observed.result.rejectionCode,expectedCode(venue));assert.match(observed.result.rejectionReason!,/PostOnly/);
      const again=await f.adapter.inspectMakerReduction(request,'original-native-order');
      assert.equal(again.result.rejectionCode,expectedCode(venue));assert.equal(f.calls.filter(call=>call==='order-get').length,2);
      assert.equal(f.calls.includes('fills-get'),false,'zero execution does not invent or query fills');
    }finally{await f.adapter.close();}
  });

  test(`${venue} generic cancellation, unknown rejection and parameter or risk reasons grant no PostOnly reason`,async()=>{
    const reasons=venue==='bybit'?['','EC_MakerPostOnly','EC_MarketOrderCannotBePostOnly','EC_InvalidPriceScale','EC_BySelfMatch']:
      ['','normal_cancel','stp_cancel','delegated_risk_order_cancel','limit_price_exceed_cancel'];
    for(const reason of reasons){const f=fixture(venue);try{
      f.raw[venue==='bybit'?'rejectReason':'cancelReason']=reason;
      const observed=await f.adapter.inspectMakerReduction(request,'original-native-order');
      assert.equal(observed.activity,'terminal');assert.equal(observed.executionVerified,true);
      assert.notEqual(observed.result.rejectionCode,expectedCode(venue));
    }finally{await f.adapter.close();}}
  });

  test(`${venue} active zero or verified partial cannot carry a zero-fill requote permission`,async()=>{
    for(const quantity of [0,.4])for(const active of [true,false]){if(quantity===0&&!active)continue;
      const f=fixture(venue);try{
        f.filled(quantity);f.raw.orderStatus=venue==='bybit'?(active?(quantity?'PartiallyFilled':'New'):'Cancelled'):
          (active?(quantity?'partially_filled':'new'):'cancelled');
        const observed=await f.adapter.inspectMakerReduction(request,'original-native-order');
        assert.equal(observed.activity,active?'active':'terminal');assert.equal(observed.executionVerified,true);
        assert.equal(observed.result.filledQuantity,quantity);assert.notEqual(observed.result.rejectionCode,expectedCode(venue));
      }finally{await f.adapter.close();}}
  });

  test(`${venue} wrong identity, order ID, read failure or incomplete cash cannot authorize zero-fill requoting`,async()=>{
    for(const invalid of ['identity','id','read','cash','fee-summary','nonzero-fee'] as const){const f=fixture(venue);try{
      if(invalid==='identity')f.raw[venue==='bybit'?'orderLinkId':'clientOid']='other-client';
      if(invalid==='id')f.raw.orderId='other-order';if(invalid==='read')f.fail();
      if(invalid==='cash'){f.filled(.4);f.missingFillFee();}
      if(invalid==='fee-summary'){
        if(venue==='bybit')f.raw.cumFeeDetail={USDT:''};else f.raw.feeDetail=[{feeCoin:'USDT',fee:''}];
      }
      if(invalid==='nonzero-fee'){
        if(venue==='bybit')f.raw.cumFeeDetail={USDT:'.01'};else f.raw.feeDetail=[{feeCoin:'USDT',fee:'.01'}];
      }
      const observed=await f.adapter.inspectMakerReduction(request,'original-native-order');
      assert.notEqual(observed.result.rejectionCode,expectedCode(venue));
      if(['identity','id','read','cash'].includes(invalid))assert.equal(observed.executionVerified,false);
    }finally{await f.adapter.close();}}
  });

  test(`${venue} zero readback cannot erase a previously verified partial or mint a fresh requote reason`,async()=>{
    const f=fixture(venue);try{
      f.filled(.4);f.raw.orderStatus=venue==='bybit'?'PartiallyFilled':'partially_filled';
      const prior=await f.adapter.inspectMakerReduction(request,'original-native-order');
      assert.equal(prior.executionVerified,true);assert.equal(prior.result.filledQuantity,.4);
      f.filled(0);f.raw.orderStatus=venue==='bybit'?'Rejected':'cancelled';
      const observed=await f.adapter.inspectMakerReduction(request,'original-native-order');
      assert.equal(observed.activity,'unknown');assert.equal(observed.executionVerified,false);
      assert.equal(observed.result.filledQuantity,.4);assert.equal(observed.result.feeUsd,.002);
      assert.notEqual(observed.result.rejectionCode,expectedCode(venue));
    }finally{await f.adapter.close();}
  });

  test(`${venue} ordinary IOC inspection keeps its existing diagnostics even when native reason text resembles PostOnly`,async()=>{
    const f=fixture(venue);try{
      const ioc={...request,postOnly:false};f.raw.timeInForce=venue==='bybit'?'IOC':'ioc';
      const result=await f.native.inspectOrder(ioc);
      assert.equal(result.status,'cancelled');assert.notEqual(result.rejectionCode,expectedCode(venue));
      if(venue==='bybit')assert.equal(result.rejectionCode,'BYBIT_REJECTED_ZERO_FILL');
    }finally{await f.adapter.close();}
  });
}
