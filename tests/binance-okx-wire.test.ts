import test from 'node:test';
import assert from 'node:assert/strict';
import ccxt from 'ccxt';
import {CcxtAdapter} from '../src/adapters/ccxt.js';
import {defaultConfig} from './legacy-config.js';
import type {AppConfig,OrderRequest,OrderResult} from '../src/shared/types.js';

const symbol='BTC/USDT:USDT';
type Venue='binance'|'okx';
type Wire={path:string;method:string;params:any};
function assertNotSubmitted(result:OrderResult){
  assert.equal(result.status,'cancelled');assert.equal(result.id,'');assert.equal(result.filledQuantity,0);assert.equal(result.feeUsd,0);
  assert.equal(result.rejectionCode,'PRE_SUBMISSION_CHECK_FAILED');
  assert.deepEqual(result.confirmation,{stage:'pre-submit',reason:'pre-submit-failed'});
}

/** Actual installed CCXT signs and parses every request. Its transport is replaced before
 * any call, with fake credentials and preloaded markets: no network or real key is used. */
function fixture(id:Venue,config:Partial<AppConfig>={}){
  const contractSize=id==='binance'?1:.01;
  const market:any={id:id==='binance'?'BTCUSDT':'BTC-USDT-SWAP',symbol,base:'BTC',baseId:'BTC',quote:'USDT',quoteId:'USDT',
    settle:'USDT',settleId:'USDT',type:'swap',spot:false,swap:true,future:false,option:false,contract:true,linear:true,inverse:false,
    active:true,contractSize,precision:{amount:id==='binance'?.001:1,price:.1},limits:{amount:{min:id==='binance'?.001:1},cost:{min:1}},info:{orderTypes:['LIMIT','MARKET']}};
  const Constructor=id==='binance'?ccxt.binanceusdm:ccxt.okx;
  const client:any=new Constructor({apiKey:'wire-test-key',secret:'wire-test-secret',password:'wire-test-passphrase',enableRateLimit:false,
    options:{defaultType:'swap',defaultSubType:'linear',defaultSettle:'USDT',adjustForTimeDifference:false,leverageBrackets:{}}});
  client.setMarkets([market]);
  const calls:Wire[]=[],orders=new Map<string,any>();
  const state={leverage:2,positionMode:id==='binance'?false:'net_mode' as any,marginType:'ISOLATED',positions:[] as any[],
    openOrders:[] as any[],finalStatus:'filled',filledFraction:1,missingOrder:false,keepLeverage:false,invalidLeverage:false,
    balanceAvailable:'250',balanceEquity:'300',crossAfterWrite:false,keepMargin:false,conditionalOrders:[] as any[]};
  const now=Date.now();
  const ok=(data:any)=>({code:'0',msg:'',data});
  client.fetch=async(url:string,method='GET',_headers:any,body?:string)=>{
    const parsed=new URL(url),path=parsed.pathname;
    let params:any=Object.fromEntries(parsed.searchParams);
    if(body)params=id==='okx'?JSON.parse(body):Object.fromEntries(new URLSearchParams(body));
    calls.push({path,method,params});
    if(path==='/fapi/v1/positionSide/dual')return {dualSidePosition:state.positionMode};
    if(path==='/api/v5/account/config')return ok([{uid:'fixture',acctLv:'2',posMode:state.positionMode}]);
    if(path==='/fapi/v1/symbolConfig')return [{symbol:market.id,marginType:state.marginType,leverage:state.invalidLeverage?'':state.leverage}];
    if(path==='/api/v5/account/leverage-info')return ok([{instId:market.id,mgnMode:params.mgnMode,posSide:'net',lever:state.invalidLeverage?'':String(state.leverage)}]);
    if(path==='/fapi/v1/openAlgoOrders')return state.conditionalOrders;
    if(path==='/fapi/v1/marginType'){
      if(!state.keepMargin)state.marginType=params.marginType;
      return {code:200,msg:'success'};
    }
    if(path==='/fapi/v1/leverage'||path==='/api/v5/account/set-leverage'){
      if(!state.keepLeverage)state.leverage=Number(params.leverage??params.lever);
      if(state.crossAfterWrite)state.marginType='CROSSED';
      return id==='binance'?{symbol:market.id,leverage:state.leverage}:ok([{instId:market.id,mgnMode:params.mgnMode,posSide:'net',lever:String(state.leverage)}]);
    }
    if(path==='/fapi/v3/account')return {assets:[{asset:'USDT',walletBalance:state.balanceEquity,marginBalance:state.balanceEquity,
      availableBalance:state.balanceAvailable,initialMargin:'50',unrealizedProfit:'0'}],positions:[]};
    if(path==='/api/v5/account/balance')return ok([{uTime:String(now),details:[{ccy:'USDT',eq:state.balanceEquity,availEq:state.balanceAvailable,availBal:state.balanceAvailable,frozenBal:'50'}]}]);
    if(path==='/fapi/v3/positionRisk')return state.positions;
    if(path==='/api/v5/account/positions')return ok(state.positions);
    if(path==='/fapi/v1/openOrders')return state.openOrders;
    if(path==='/api/v5/trade/orders-pending')return ok(state.openOrders);
    if(path==='/api/v5/trade/orders-algo-pending')return ok([]);
    if(path==='/fapi/v1/income')return [-2,3].map((income,i)=>({symbol:market.id,asset:'USDT',incomeType:'FUNDING_FEE',income:String(income),time:now,tranId:`invoice-${i}`}));
    if(path==='/api/v5/account/bills-archive')return ok([-2,3].map((income,i)=>({instId:market.id,ccy:'USDT',type:'8',balChg:'0',posBalChg:String(income),ts:String(now),billId:`invoice-${i}`})));
    if((path==='/fapi/v1/order'||path==='/api/v5/trade/batch-orders')&&method==='POST'){
      const p=Array.isArray(params)?params[0]:params,orderId=String(100+orders.size),qty=Number(p.quantity??p.sz),price=Number(p.price??p.px);
      const filled=qty*state.filledFraction;
      const order=id==='binance'?{symbol:market.id,orderId,clientOrderId:p.newClientOrderId,side:p.side,type:'LIMIT',timeInForce:'IOC',
        status:state.finalStatus==='filled'?'FILLED':state.finalStatus==='cancelled'?'CANCELED':'NEW',origQty:String(qty),executedQty:String(filled),
        avgPrice:filled?String(price):'0',cumQuote:String(filled*price),price:String(price),time:now,updateTime:now,reduceOnly:p.reduceOnly==='true',positionSide:'BOTH'}:
        {instId:market.id,instType:'SWAP',ordId:orderId,clOrdId:p.clOrdId,side:p.side,ordType:'ioc',state:state.finalStatus==='cancelled'?'canceled':state.finalStatus,
          sz:String(qty),accFillSz:String(filled),avgPx:filled?String(price):'',px:String(price),fillPx:filled?String(price):'',fee:filled?'-.07':'0',feeCcy:'USDT',
          cTime:String(now),uTime:String(now),posSide:'net',tdMode:p.tdMode,reduceOnly:String(p.reduceOnly)};
      orders.set(orderId,order);
      // Deliberately acknowledge only: the adapter must query terminal execution, not call an acknowledgement a fill.
      return id==='binance'?{...order,status:'NEW',executedQty:'0',cumQuote:'0',avgPrice:'0'}:ok([{ordId:orderId,clOrdId:p.clOrdId,sCode:'0',sMsg:''}]);
    }
    if((path==='/fapi/v1/order'||path==='/api/v5/trade/order')&&method==='GET'){
      if(state.missingOrder)throw new Error('fixture order is not yet visible');
      const order=orders.get(String(params.orderId??params.ordId))??[...orders.values()].find(o=>(o.clientOrderId??o.clOrdId)===(params.origClientOrderId??params.clOrdId));
      if(!order)throw new Error('fixture order not found');
      return id==='binance'?order:ok([order]);
    }
    if((path==='/fapi/v1/order'&&method==='DELETE')||path==='/api/v5/trade/cancel-order'){
      const order=orders.get(String(params.orderId??params.ordId));
      if(!order)throw new Error('fixture cancel order not found');
      if(id==='binance')order.status='CANCELED';else order.state='canceled';
      return id==='binance'?order:ok([{ordId:order.ordId,sCode:'0',sMsg:''}]);
    }
    if(path==='/fapi/v1/userTrades'){
      const order=orders.get(String(params.orderId));
      return order?[{id:'trade',orderId:order.orderId,symbol:market.id,side:order.side,qty:order.executedQty,price:order.avgPrice,
        quoteQty:order.cumQuote,commission:'.07',commissionAsset:'USDT',time:now,buyer:order.side==='BUY',maker:false}]:[];
    }
    throw new Error(`Unexpected fixture route: ${method} ${path}`);
  };
  return {id,client,market,state,calls,orders,now,adapter:new CcxtAdapter(id,{...defaultConfig,mode:'live',dataSource:'public',feeOnly:true,...config},client)};
}

for(const id of ['binance','okx'] as const){
  test(`${id}: empty account uses supported native query fields and retains USDT balance`,async()=>{
    const f=fixture(id),a=await f.adapter.fetchAccount();
    assert.equal(a.freeUsd,250);assert.equal(a.equityUsd,300);assert.deepEqual(a.positions,[]);
    for(const c of f.calls){assert.equal(c.params.settle,undefined);assert.equal(c.params.type,undefined);}
    if(id==='okx')assert.equal(f.calls.find(c=>c.path.endsWith('/positions'))!.params.instType,'SWAP');
    assert.ok(f.calls.every(c=>c.method==='GET'));
  });
  test(`${id}: matching leverage is a read-only preparation, changed leverage has one scoped write and readback`,async()=>{
    const f=fixture(id);await f.adapter.inspectTrading(symbol,2);await f.adapter.prepareTrading(symbol,2);
    assert.ok(f.calls.every(c=>c.method==='GET'));
    assert.ok(f.calls.some(c=>c.path.endsWith(id==='binance'?'/openOrders':'/orders-pending')));
    await f.adapter.prepareTrading(symbol,3);
    const writes=f.calls.filter(c=>c.method==='POST');assert.equal(writes.length,1);
    const p=writes[0].params;
    assert.equal(p.marginMode,undefined);assert.equal(p.posSide,undefined);
    if(id==='binance'){assert.equal(p.leverage,'3');assert.equal(p.symbol,'BTCUSDT');}
    else assert.deepEqual(p,{instId:'BTC-USDT-SWAP',mgnMode:'isolated',lever:'3'});
    assert.ok(f.calls.at(-1)!.method==='GET');
  });
  test(`${id}: inconsistent leverage acknowledgement stays unprepared`,async()=>{
    const f=fixture(id);f.state.keepLeverage=true;
    await assert.rejects(f.adapter.prepareTrading(symbol,3),/verify requested leverage/);
    const calls=f.calls.length;
    assertNotSubmitted(await f.adapter.placeOrder({base:'BTC',symbol,side:'buy',reduceOnly:false,quantity:.01,limitPrice:10000,clientOrderId:'blocked'}));
    assert.equal(f.calls.length,calls,'unprepared entry cannot dispatch another private request');
  });
  test(`${id}: unknown mode and malformed leverage cannot reach a write`,async()=>{
    const f=fixture(id);f.state.positionMode=undefined;
    await assert.rejects(f.adapter.prepareTrading(symbol,2),/one-way\/net/);
    f.state.positionMode=id==='binance'?false:'net_mode';f.state.invalidLeverage=true;
    await assert.rejects(f.adapter.prepareTrading(symbol,2),/symbol leverage|leverage scope/);
    assert.ok(f.calls.every(c=>c.method==='GET'));
  });
  test(`${id}: existing pending order blocks preparation before leverage changes`,async()=>{
    const f=fixture(id);f.state.openOrders=[id==='binance'?{symbol:f.market.id,orderId:'1',status:'NEW',origQty:'.01',executedQty:'0'}:
      {instId:f.market.id,ordId:'1',state:'live',sz:'1',accFillSz:'0'}];
    await assert.rejects(f.adapter.prepareTrading(symbol,3),/pending order/);
    assert.ok(f.calls.every(c=>c.method==='GET'));
  });
  test(`${id}: signed IOC wire handles all four net-mode directions and confirmed actual fees`,async()=>{
    const f=fixture(id);await f.adapter.prepareTrading(symbol,2);
    for(const [side,reduceOnly] of [['buy',false],['sell',false],['sell',true],['buy',true]] as const){
      const req:OrderRequest={base:'BTC',symbol,side,reduceOnly,quantity:.01,limitPrice:10000,clientOrderId:`wire-${side}-${reduceOnly}`};
      const result=await f.adapter.placeOrder(req);
      assert.equal(result.status,'filled');assert.equal(result.filledQuantity,.01);assert.equal(result.averagePrice,10000);assert.equal(result.feeUsd,.07);
      const wire=f.calls.filter(c=>c.method==='POST'&&c.path.includes(id==='binance'?'/order':'/batch-orders')).at(-1)!;
      const p=Array.isArray(wire.params)?wire.params[0]:wire.params;
      assert.equal(p.side,id==='binance'?side.toUpperCase():side);
      assert.equal(p.reduceOnly,id==='binance'?String(reduceOnly):reduceOnly);
      if(id==='binance'){assert.equal(p.positionSide,'BOTH');assert.equal(p.timeInForce,'IOC');assert.equal(p.quantity,'0.01');}
      else{assert.equal(p.posSide,'net');assert.equal(p.tdMode,'isolated');assert.equal(p.ordType,'ioc');assert.equal(p.sz,'1');}
      const writes=f.calls.filter(c=>c.method==='POST').length;
      assert.deepEqual(await f.adapter.placeOrder(req),result);assert.equal(f.calls.filter(c=>c.method==='POST').length,writes);
    }
  });
  test(`${id}: IOC cancellation confirms partial fill; missing order remains unknown without resending`,async()=>{
    const f=fixture(id);f.state.finalStatus='cancelled';f.state.filledFraction=.5;
    const req:OrderRequest={base:'BTC',symbol,side:'sell',reduceOnly:true,quantity:.02,limitPrice:10000,clientOrderId:'partial'};
    const partial=await f.adapter.placeOrder(req);assert.equal(partial.status,'partial');assert.equal(partial.filledQuantity,.01);assert.equal(partial.feeUsd,.07);
    f.state.finalStatus='live';f.state.filledFraction=0;
    const cancelled=await f.adapter.placeOrder({...req,clientOrderId:'cancel'});assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.filledQuantity,0);
    assert.ok(f.calls.some(c=>c.method==='DELETE'||c.path.endsWith('/cancel-order')));
    f.state.missingOrder=true;
    const unknownReq={...req,clientOrderId:'unknown'};
    assert.equal((await f.adapter.placeOrder(unknownReq)).status,'unknown');
    const writes=f.calls.filter(c=>c.method==='POST').length;
    assert.equal((await f.adapter.placeOrder(unknownReq)).status,'unknown');assert.equal(f.calls.filter(c=>c.method==='POST').length,writes);
  });
  test(`${id}: funding receipts and expenses retain invoice signs`,async()=>{
    const f=fixture(id);const payments=await f.adapter.fetchFundingPayments(f.now-1);
    assert.deepEqual(payments.map(p=>p.amountUsd),[-2,3]);assert.ok(f.calls.every(c=>c.method==='GET'));
  });
}

test('Binance v3 position without leverage gets the actual symbol setting and base quantity',async()=>{
  const f=fixture('binance');f.state.positions=[{symbol:'BTCUSDT',positionSide:'BOTH',positionAmt:'.01',entryPrice:'10000',markPrice:'10010',
    unRealizedProfit:'.1',liquidationPrice:'5000',isolatedMargin:'50',notional:'100.1',isolatedWallet:'50',initialMargin:'50.05',
    maintMargin:'.4',positionInitialMargin:'50.05',openOrderInitialMargin:'0',marginAsset:'USDT',updateTime:f.now}];
  const a=await f.adapter.fetchAccount();assert.equal(a.positions.length,1);assert.equal(a.positions[0].leverage,2);assert.equal(a.positions[0].quantity,.01);
  assert.equal(a.positions[0].entryPrice,10000);assert.equal(a.positions[0].unrealizedPnlUsd,.1);
  assert.ok(f.calls.some(c=>c.path==='/fapi/v1/symbolConfig'&&c.params.symbol==='BTCUSDT'));
  assert.ok(f.calls.every(c=>c.method==='GET'));
});

test('Binance unknown margin type is not CCXT default-isolated and decimal leverage is rejected before a write',async()=>{
  const f=fixture('binance');f.state.marginType='';
  await assert.rejects(f.adapter.prepareTrading(symbol,2),/unknown margin mode/);
  f.state.marginType='ISOLATED';await assert.rejects(f.adapter.prepareTrading(symbol,2.5),/invalid symbol leverage/);
  assert.ok(f.calls.every(c=>c.method==='GET'));
});

test('OKX verifies fractional leverage from raw scope without integer rounding',async()=>{
  const f=fixture('okx');await f.adapter.prepareTrading(symbol,2.5);
  assert.equal(f.state.leverage,2.5);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});

test('OKX malformed position quantity fails rather than disappearing as an empty account',async()=>{
  const f=fixture('okx');f.state.positions=[{instId:f.market.id,pos:undefined,posSide:'net',mgnMode:'isolated',markPx:'10000',lever:'2',avgPx:'10000'}];
  await assert.rejects(f.adapter.fetchAccount(),/invalid position quantity/);
});

test('Binance leverage readback also checks that the isolated margin scope still matches',async()=>{
  const f=fixture('binance');f.state.crossAfterWrite=true;
  await assert.rejects(f.adapter.prepareTrading(symbol,3),/verify requested leverage/);
});

test('OKX actual positions normalize signed contracts into base coins and reject missing risk data',async()=>{
  const f=fixture('okx');f.state.positions=[{instId:f.market.id,pos:'-3',posSide:'net',mgnMode:'isolated',markPx:'10000',lever:'2.5',avgPx:'10000',
    margin:'120',notionalUsd:'300',mmr:'1',upl:'0',liqPx:'20000',cTime:String(f.now)}];
  const account=await f.adapter.fetchAccount();assert.equal(account.positions.length,1);
  assert.equal(account.positions[0].quantity,.03);assert.equal(account.positions[0].side,'short');assert.equal(account.positions[0].leverage,2.5);
  assert.equal(account.positions[0].entryPrice,10000);assert.equal(account.positions[0].unrealizedPnlUsd,0);assert.ok(f.calls.every(c=>c.method==='GET'));
  f.state.positions[0].markPx='';await assert.rejects(f.adapter.fetchAccount(),/incomplete position risk data/);
  f.state.positions[0].markPx='10000';f.state.positions[0].lever='';await assert.rejects(f.adapter.fetchAccount(),/incomplete position risk data/);
});

for(const marginMode of ['crossed','isolated'] as const){
  test(`Binance explicit ${marginMode}: flat contract changes native margin then leverage and verifies both`,async()=>{
    const f=fixture('binance',{marginMode});f.state.marginType=marginMode==='crossed'?'ISOLATED':'CROSSED';
    await f.adapter.inspectTrading(symbol,3);assert.ok(f.calls.every(c=>c.method==='GET'));
    await f.adapter.prepareTrading(symbol,3);
    const writes=f.calls.filter(c=>c.method==='POST');assert.equal(writes.length,2);
    assert.equal(writes[0].path,'/fapi/v1/marginType');assert.equal(writes[0].params.marginType,marginMode==='crossed'?'CROSSED':'ISOLATED');
    assert.equal(writes[1].path,'/fapi/v1/leverage');assert.equal(writes[1].params.leverage,'3');
    assert.equal(f.calls.at(-1)!.method,'GET');
    const result=await f.adapter.placeOrder({base:'BTC',symbol,side:'buy',reduceOnly:false,quantity:.01,limitPrice:10000,clientOrderId:`new-${marginMode}`});
    assert.equal(result.status,'filled');assert.equal(f.calls.filter(c=>c.method==='POST'&&c.path==='/fapi/v1/marginType').length,1);
  });
}

test('Binance explicit mode refuses existing position, normal order, conditional order and unverified switch before a leverage write',async()=>{
  for(const blocked of ['position','order','conditional','ignored'] as const){
    const f=fixture('binance',{marginMode:'crossed'});
    if(blocked==='position')f.state.positions=[{symbol:'BTCUSDT',positionSide:'BOTH',positionAmt:'.01',entryPrice:'10000',markPrice:'10000',notional:'100',unRealizedProfit:'0',liquidationPrice:'5000',marginAsset:'USDT'}];
    if(blocked==='order')f.state.openOrders=[{symbol:'BTCUSDT',orderId:'1',status:'NEW',origQty:'.01',executedQty:'0'}];
    if(blocked==='conditional')f.state.conditionalOrders=[{symbol:'BTCUSDT',algoId:'1'}];
    if(blocked==='ignored')f.state.keepMargin=true;
    await assert.rejects(f.adapter.prepareTrading(symbol,3),/existing position|pending order|conditional order|verify requested margin/);
    assert.equal(f.calls.filter(c=>c.method==='POST'&&c.path==='/fapi/v1/leverage').length,0);
    assert.equal(f.calls.filter(c=>c.method==='POST').length,blocked==='ignored'?1:0);
  }
});

test('explicit Binance prepared mode changed externally rejects the new order without submission',async()=>{
  const f=fixture('binance',{marginMode:'crossed'});f.state.marginType='CROSSED';await f.adapter.prepareTrading(symbol,2);
  f.state.marginType='ISOLATED';const result=await f.adapter.placeOrder({base:'BTC',symbol,side:'buy',reduceOnly:false,quantity:.01,limitPrice:10000,clientOrderId:'changed-margin'});
  assert.equal(result.status,'cancelled');assert.equal(result.rejectionCode,'PRE_SUBMISSION_CHECK_FAILED');assert.equal(result.filledQuantity,0);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});

test('OKX cross scope uses matching leverage and opening tdMode without switching account position mode',async()=>{
  const f=fixture('okx',{marginMode:'crossed'});await f.adapter.prepareTrading(symbol,3);
  const leverageWrite=f.calls.find(c=>c.method==='POST')!;
  assert.deepEqual(leverageWrite.params,{instId:'BTC-USDT-SWAP',mgnMode:'cross',lever:'3'});
  assert.ok(f.calls.filter(c=>c.path.endsWith('/leverage-info')).every(c=>c.params.mgnMode==='cross'));
  const result=await f.adapter.placeOrder({base:'BTC',symbol,side:'buy',reduceOnly:false,quantity:.01,limitPrice:10000,clientOrderId:'okx-cross'});
  assert.equal(result.status,'filled');const order=f.calls.find(c=>c.path.endsWith('/batch-orders'))!.params[0];
  assert.equal(order.tdMode,'cross');assert.equal(order.posSide,'net');
});

test('OKX reduction follows actual isolated position even when next entry preference is cross',async()=>{
  const f=fixture('okx',{marginMode:'crossed'});
  f.state.positions=[{instId:f.market.id,pos:'3',posSide:'net',mgnMode:'isolated',markPx:'10000',lever:'2',avgPx:'10000',margin:'120',notionalUsd:'300',mmr:'1',upl:'0',liqPx:'5000'}];
  const result=await f.adapter.placeOrder({base:'BTC',symbol,side:'sell',reduceOnly:true,quantity:.01,limitPrice:10000,clientOrderId:'okx-old-isolated'});
  assert.equal(result.status,'filled');assert.equal(f.calls.find(c=>c.path.endsWith('/batch-orders'))!.params[0].tdMode,'isolated');
  assert.equal(f.calls.filter(c=>c.path.endsWith('/set-leverage')).length,0);
  f.state.positions.push({...f.state.positions[0],mgnMode:'cross'});
  const ambiguous=await f.adapter.placeOrder({base:'BTC',symbol,side:'sell',reduceOnly:true,quantity:.01,limitPrice:10000,clientOrderId:'okx-ambiguous'});
  assert.equal(ambiguous.status,'cancelled');assert.equal(ambiguous.rejectionCode,'PRE_SUBMISSION_CHECK_FAILED');assert.equal(ambiguous.filledQuantity,0);assert.equal(f.calls.filter(c=>c.path.endsWith('/batch-orders')).length,1);
});
