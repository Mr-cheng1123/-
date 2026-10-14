import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import ccxt from 'ccxt';
import {CcxtAdapter} from '../src/adapters/ccxt.js';
import {defaultConfig} from './legacy-config.js';
import type {OrderRequest,OrderResult} from '../src/shared/types.js';

// Deliberately fake credentials, no dotenv import and no native network fallback. Raw endpoint methods, signing,
// serialization, fetch(), handleRestResponse() and exchange handleErrors() all remain the real CCXT implementation.
const KEY='offline-wire-key',SECRET='offline-wire-secret',PASSPHRASE='offline-wire-passphrase';
const symbol='BTC/USDT:USDT';
const config={...defaultConfig,mode:'live' as const,dataSource:'public' as const,leverage:2};
function assertNotSubmitted(result:OrderResult){
  assert.equal(result.status,'cancelled');assert.equal(result.id,'');assert.equal(result.filledQuantity,0);assert.equal(result.feeUsd,0);
  assert.equal(result.rejectionCode,'PRE_SUBMISSION_CHECK_FAILED');
  assert.deepEqual(result.confirmation,{stage:'pre-submit',reason:'pre-submit-failed'});
}
interface Wire {method:string;path:string;query:Record<string,string>;body:any;rawBody:string|undefined}
interface Reply {data:any;status?:number;lostAck?:boolean}
function wireClient(venue:'bitget'|'gate',handler:(request:Wire)=>Reply,newSymbolMarginMode:'crossed'|'isolated'='isolated'){
  const wires:Wire[]=[];
  const client:any=new ccxt[venue]({apiKey:KEY,secret:SECRET,password:PASSPHRASE,enableRateLimit:false,timeout:500,
    options:{defaultType:'swap',defaultSettle:'USDT',adjustForTimeDifference:false,maxRetriesOnFailure:0,unifiedAccount:false}});
  client.setMarkets([{id:venue==='bitget'?'BTCUSDT':'BTC_USDT',symbol,base:'BTC',quote:'USDT',settle:'USDT',baseId:'BTC',quoteId:'USDT',settleId:'USDT',
    type:'swap',spot:false,margin:false,swap:true,future:false,option:false,contract:true,active:true,linear:true,inverse:false,
    contractSize:venue==='bitget'?1:.001,precision:{amount:venue==='bitget'?.001:1,price:.1},
    limits:{amount:{min:venue==='bitget'?.001:1},price:{min:.1},cost:{min:1}},info:{}}]);
  client.fetchImplementation=async(urlText:string,params:any)=>{
    const url=new URL(urlText),headers=new Headers(params.headers),method=String(params.method);
    assert.ok(['api.bitget.com','api.gateio.ws'].includes(url.hostname));
    const rawBody=params.body as string|undefined;
    if(venue==='bitget'){
      assert.equal(headers.get('ACCESS-KEY'),KEY);assert.equal(headers.get('ACCESS-PASSPHRASE'),PASSPHRASE);
      const auth=headers.get('ACCESS-TIMESTAMP')+method+url.pathname+(method==='POST'?(rawBody??''):decodeURIComponent(url.search));
      assert.equal(headers.get('ACCESS-SIGN'),createHmac('sha256',SECRET).update(auth).digest('base64'));
    }else{
      assert.equal(headers.get('KEY'),KEY);
      const auth=[method,url.pathname,decodeURIComponent(url.search.slice(1)),createHash('sha512').update(rawBody??'').digest('hex'),headers.get('Timestamp')].join('\n');
      assert.equal(headers.get('SIGN'),createHmac('sha512',SECRET).update(auth).digest('hex'));
    }
    const wire={method,path:url.pathname,query:Object.fromEntries(url.searchParams),body:rawBody?JSON.parse(rawBody):undefined,rawBody};
    wires.push(wire);const reply=handler(wire);
    if(reply.lostAck)throw new TypeError('offline fixture: response lost after processing');
    return new Response(JSON.stringify(reply.data),{status:reply.status??200,headers:{'Content-Type':'application/json'}});
  };
  return {client,wires,adapter:new CcxtAdapter(venue,{...config,bitgetNewSymbolMarginMode:newSymbolMarginMode},client)};
}
function bitgetFixture(newSymbolMarginMode:'crossed'|'isolated'='isolated'){
  const leverages=new Map<string,string>(),orders=new Map<string,any>(),holdings=new Map<string,number>();
  let leverageError:string|undefined,previewError:string|undefined,lostAck=false,missingOrder=false,openIoc=false,fillRatio=1,feesUnknown=false;
  const ok=(data:any):Reply=>({data:{code:'00000',msg:'success',requestTime:1770000000000,data}});
  const failure=(code:string,msg='offline validation failure'):Reply=>({status:400,data:{code,msg,data:null}});
  const f=wireClient('bitget',w=>{
    const p=w.body??w.query;
    if(w.method==='GET')assert.equal(w.rawBody,undefined);
    if(w.method==='POST')assert.deepEqual(w.query,{});
    if(w.path==='/api/v3/account/settings')return ok({accountMode:'unified',accountLevel:'basic',holdMode:'hedge_mode',deltaSwitch:'no',assetMode:'multi_assets',
      symbolConfigList:leverages.size===2?[{category:'USDT-FUTURES',symbol:'BTCUSDT',marginMode:newSymbolMarginMode,longLeverage:leverages.get('long'),shortLeverage:leverages.get('short')}]:[]});
    if(w.path==='/api/v3/account/assets')return ok({accountEquity:'500',effEquity:'450',imr:'0',assets:[{coin:'USDT',equity:'400',available:'400',debt:'0'},{coin:'BGB',equity:'1',available:'1',debt:'0'}]});
    if(w.path==='/api/v3/position/current-position'){
      assert.equal(p.category,'USDT-FUTURES');
      return ok({list:[...holdings].filter(([,quantity])=>quantity>0).map(([posSide,quantity])=>({category:'USDT-FUTURES',symbol:'BTCUSDT',marginCoin:'USDT',
        total:String(quantity),posSide,holdMode:'hedge_mode',marginMode:newSymbolMarginMode,leverage:'2',markPrice:'10000',liquidationPrice:'5000'}))});
    }
    if(w.path==='/api/v3/trade/unfilled-orders')return ok({list:[],cursor:''});
    if(w.path==='/api/v3/account/pre-set-leverage'){
      assert.equal(w.method,'GET');assert.deepEqual(p,{category:'USDT-FUTURES',symbol:'BTCUSDT',marginMode:newSymbolMarginMode==='crossed'?'cross':'isolated',leverage:'2'});
      if(previewError)return failure(previewError,'afterLeverage none validation error');
      return ok({requiredMargin:'0',estMaxOpen:'1000',marginChange:'0',estMaxBorrowable:'0'});
    }
    if(w.path==='/api/v3/account/set-leverage'){
      assert.equal(w.method,'POST');assert.deepEqual(Object.keys(p).sort(),['category','leverage','marginMode','symbol',...(newSymbolMarginMode==='isolated'?['posSide']:[])].sort());
      assert.equal(p.category,'USDT-FUTURES');assert.equal(p.symbol,'BTCUSDT');assert.equal(p.marginMode,newSymbolMarginMode);assert.equal(p.leverage,'2');
      if(newSymbolMarginMode==='isolated')assert.ok(['long','short'].includes(p.posSide));
      if(leverageError)return failure(leverageError,leverageError==='25200'?'afterLeverage none validation error':'Incorrect permissions');
      for(const side of newSymbolMarginMode==='crossed'?['long','short']:[p.posSide])leverages.set(side,p.leverage);return ok('success');
    }
    if(w.path==='/api/v3/trade/place-order'){
      assert.equal(w.method,'POST');assert.equal(p.orderType,'limit');assert.equal(p.timeInForce,'ioc');assert.equal(p.marginMode,newSymbolMarginMode);
      assert.equal(p.reduceOnly,undefined);assert.equal(p.tradeSide,undefined);assert.equal(p.pxAmendType,'no');
      const orderId=String(1000+orders.size),tradeSide=(p.side==='buy')===(p.posSide==='long')?'open':'close';
      const raw={...p,orderId,holdMode:'hedge_mode',tradeSide,reduceOnly:'NO',orderStatus:openIoc?'new':fillRatio===1?'filled':'cancelled',cumExecQty:openIoc?'0':String(Number(p.qty)*fillRatio),
        avgPrice:openIoc?'0':p.price,updatedTime:'1770000000000',feeDetail:openIoc||feesUnknown?[]:[{feeCoin:'USDT',fee:String(.05*fillRatio)}]};
      orders.set(orderId,raw);
      if(!openIoc)holdings.set(p.posSide,(holdings.get(p.posSide)??0)+(tradeSide==='open'?1:-1)*Number(p.qty)*fillRatio);
      return {...ok({orderId,clientOid:p.clientOid}),lostAck};
    }
    if(w.path==='/api/v3/trade/order-info'){
      if(missingOrder)return failure('25204','Order does not exist');
      const order=orders.get(p.orderId)??[...orders.values()].find(o=>o.clientOid===p.clientOid);
      return order?ok(order):failure('25204','Order does not exist');
    }
    if(w.path==='/api/v3/trade/fills'){
      assert.equal(w.method,'GET');assert.equal(w.rawBody,undefined);
      assert.equal(p.category,'USDT-FUTURES');assert.equal(p.limit,'100');
      const raw=orders.get(p.orderId);assert.ok(raw);
      return ok({list:Number(raw.cumExecQty)>0?[{execId:`offline-fill-${raw.orderId}`,orderId:raw.orderId,clientOid:raw.clientOid,
        category:raw.category,symbol:raw.symbol,side:raw.side,orderType:raw.orderType,tradeSide:raw.tradeSide,
        execQty:raw.cumExecQty,execPrice:raw.avgPrice,feeDetail:raw.feeDetail}]:[],cursor:null});
    }
    if(w.path==='/api/v3/trade/cancel-order'){
      assert.equal(w.method,'POST');assert.equal(p.category,'USDT-FUTURES');
      const order=orders.get(p.orderId);assert.ok(order);order.orderStatus='cancelled';return ok({orderId:p.orderId});
    }
    throw new Error(`Unexpected offline Bitget route: ${w.method} ${w.path}`);
  },newSymbolMarginMode);
  return {...f,leverages,orders,error:(value:string)=>{leverageError=value;},previewError:(value:string)=>{previewError=value;},loseAck:()=>{lostAck=true;},hideOrders:()=>{missingOrder=true;},openIoc:()=>{openIoc=true;},
    partial:(unknownFees=false)=>{fillRatio=.6;feesUnknown=unknownFees;}};
}
function gateFixture(){
  const leverages:Record<string,string>={dual_long:'10',dual_short:'10'},orders=new Map<string,any>(),holdings=new Map<string,number>();
  let leverageError:string|undefined,lostAck=false,openIoc=false,fillRatio=1,feesUnknown=false;
  const f=wireClient('gate',w=>{
    const p=w.body??w.query;
    if(w.path==='/api/v4/futures/usdt/accounts')return {data:{currency:'USDT',available:'400',total:'500',unrealised_pnl:'0',position_mode:'dual_plus',
      in_dual_mode:true,enable_credit:true,margin_mode:3,margin_mode_name:'single_currency'}};
    if(w.path==='/api/v4/unified/accounts'){
      assert.equal(w.method,'GET');assert.equal(w.rawBody,undefined);assert.deepEqual(w.query,{});
      return {data:{mode:'single_currency',unified_account_total_equity:'500'}};
    }
    if(w.path==='/api/v4/futures/usdt/price_orders'){
      assert.equal(w.method,'GET');assert.equal(w.rawBody,undefined);
      assert.deepEqual(w.query,{contract:'BTC_USDT',status:'open',limit:'1'});
      return {data:[]};
    }
    if(w.path==='/api/v4/futures/usdt/positions')return {data:[...holdings].filter(([,quantity])=>quantity>0).map(([mode,quantity])=>({
      contract:'BTC_USDT',mode,size:String(mode==='dual_long'?quantity:-quantity),pos_margin_mode:'cross',pid:mode==='dual_long'?'991':'992',
      lever:'2',leverage:'0',mark_price:'10000',liq_price:'5000'}))};
    if(w.path==='/api/v4/futures/usdt/get_leverage/BTC_USDT'){
      assert.equal(w.method,'GET');assert.equal(w.rawBody,undefined);assert.equal(p.pos_margin_mode,'cross');return {data:{Lever:leverages[p.dual_side]}};
    }
    if(w.path==='/api/v4/futures/usdt/positions/BTC_USDT/set_leverage'){
      assert.equal(w.method,'POST');assert.equal(w.rawBody,undefined);
      assert.deepEqual(Object.keys(w.query).sort(),['leverage','margin_mode'].sort());
      assert.equal(p.margin_mode,'cross');assert.equal(p.leverage,'2');
      if(leverageError)return {status:400,data:{label:leverageError,message:'offline leverage failure'}};
      leverages.dual_long=p.leverage;leverages.dual_short=p.leverage;return {data:{lever:p.leverage}};
    }
    if(w.path==='/api/v4/futures/usdt/orders'&&w.method==='GET')return {data:p.status==='open'?[]:[...orders.values()]};
    if(w.path==='/api/v4/futures/usdt/orders'&&w.method==='POST'){
      assert.deepEqual(w.query,{});assert.equal(p.pos_margin_mode,'cross');assert.equal(p.tif,'ioc');assert.equal(p.auto_size,undefined);assert.equal(p.close,undefined);
      const id=String(10000+orders.size),quantity=Number(p.size),mode=(p.reduce_only?quantity<0:quantity>0)?'dual_long':'dual_short';
      if(p.reduce_only)assert.equal(p.pid,mode==='dual_long'?'991':'992');
      const raw={...p,id,left:openIoc?p.size:String(quantity*(1-fillRatio)),fill_price:openIoc?'0':p.price,is_reduce_only:p.reduce_only,is_close:false,status:openIoc?'open':'finished',
        finish_as:'ioc',create_time:1770000000,finish_time:openIoc?0:1770000001};delete raw.pid;
      orders.set(id,raw);if(!openIoc)holdings.set(mode,(holdings.get(mode)??0)+(p.reduce_only?-1:1)*Math.abs(quantity)*fillRatio);
      return {data:raw,lostAck};
    }
    if(w.path.startsWith('/api/v4/futures/usdt/orders/')){
      const id=decodeURIComponent(w.path.split('/').at(-1)!),order=orders.get(id)??[...orders.values()].find(o=>o.text===id);
      if(!order)return {status:404,data:{label:'ORDER_NOT_FOUND',message:'offline order absent'}};
      if(w.method==='DELETE'){order.status='finished';order.finish_as='cancelled';order.finish_time=1770000002;}
      return {data:order};
    }
    if(w.path==='/api/v4/futures/usdt/my_trades'){
      assert.equal(w.method,'GET');const order=orders.get(p.order);assert.ok(order);
      return {data:[{id:'80001',order_id:order.id,contract:'BTC_USDT',size:String(Number(order.size)-Number(order.left)),price:order.price,
        fee:String(.05*fillRatio),point_fee:feesUnknown?'1':'0'}]};
    }
    throw new Error(`Unexpected offline Gate route: ${w.method} ${w.path}`);
  });
  return {...f,leverages,orders,error:(value:string)=>{leverageError=value;},loseAck:()=>{lostAck=true;},openIoc:()=>{openIoc=true;},
    partial:(unknownFees=false)=>{fillRatio=.6;feesUnknown=unknownFees;}};
}
const request=(side:'buy'|'sell',reduceOnly:boolean,suffix=''):OrderRequest=>({base:'BTC',symbol,side,reduceOnly,quantity:.01,limitPrice:10000,
  clientOrderId:`wire-${side}-${reduceOnly}${suffix}`});

for(const venue of ['bitget','gate'] as const){
  test(`${venue} real CCXT wire: read-only inspect, preparation, four order directions, fills, positions and no duplicate submission`,async()=>{
    const f=venue==='bitget'?bitgetFixture():gateFixture();
    const account=await f.adapter.fetchAccount();assert.equal(account.positions.length,0);
    await f.adapter.inspectTrading(symbol,2);assert.ok(f.wires.every(w=>w.method==='GET'));
    await f.adapter.prepareTrading(symbol,2);
    const leverage=f.wires.filter(w=>w.method==='POST'&&/set[_-]leverage$/.test(w.path));assert.equal(leverage.length,venue==='gate'?1:2);
    for(const [side,reduceOnly] of [['buy',false],['sell',false],['sell',true],['buy',true]] as const){
      const req=request(side,reduceOnly),result=await f.adapter.placeOrder(req);
      assert.equal(result.status,'filled');assert.equal(result.filledQuantity,.01);assert.equal(result.feeUsd,.05);
      assert.equal((await f.adapter.reconcileOrder(req,result.id)).status,'filled');
      const writes=f.wires.filter(w=>w.method==='POST').length;
      assert.deepEqual(await f.adapter.placeOrder(req),result);assert.equal(f.wires.filter(w=>w.method==='POST').length,writes);
    }
    assert.equal((await f.adapter.fetchAccount()).positions.length,0);
    assert.equal(f.orders.size,4);
  });
  test(`${venue} real CCXT wire: unexpectedly open IOC cancels exact order then confirms terminal result`,async()=>{
    const f=venue==='bitget'?bitgetFixture():gateFixture();await f.adapter.prepareTrading(symbol,2);f.openIoc();
    const result=await f.adapter.placeOrder(request('buy',false,'-open'));
    assert.equal(result.status,'cancelled');assert.equal(result.filledQuantity,0);
    const canceled=f.wires.filter(w=>venue==='bitget'?w.path.endsWith('/cancel-order'):w.method==='DELETE');assert.equal(canceled.length,1);
    assert.ok(f.wires.some(w=>w.method==='GET'&&(venue==='bitget'?w.path.endsWith('/order-info'):w.path.endsWith(`/orders/${result.id}`))));
  });
  test(`${venue} real CCXT wire: lost acknowledgement resolves by deterministic client ID without resubmitting`,async()=>{
    const f=venue==='bitget'?bitgetFixture():gateFixture();await f.adapter.prepareTrading(symbol,2);f.loseAck();
    const req=request('buy',false,'-lost'),result=await f.adapter.placeOrder(req);
    assert.equal(result.status,'filled');assert.equal(result.filledQuantity,.01);
    await f.adapter.placeOrder(req);
    assert.equal(f.wires.filter(w=>w.method==='POST'&&(w.path.endsWith('/place-order')||w.path.endsWith('/orders'))).length,1);
  });
  test(`${venue} real CCXT wire: partial fills survive missing or unsupported fee evidence without another order`,async()=>{
    for(const unknownFees of [false,true]){
      const f=venue==='bitget'?bitgetFixture():gateFixture();await f.adapter.prepareTrading(symbol,2);f.partial(unknownFees);
      const req=request('buy',false,'-partial'),result=await f.adapter.placeOrder(req);
      assert.equal(result.status,unknownFees?'unknown':'partial');assert.equal(result.filledQuantity,.006);
      if(!unknownFees)assert.equal(result.feeUsd,.03);
      const latest=await f.adapter.reconcileOrder(req,result.id);assert.equal(latest.filledQuantity,.006);
      await f.adapter.placeOrder(req);
      assert.equal(f.wires.filter(w=>w.method==='POST'&&(w.path.endsWith('/place-order')||w.path.endsWith('/orders'))).length,1);
    }
  });
}

test('Bitget real CCXT HTTP 400 body: 25200 and 40014 survive parsing and prevent any order submission',async()=>{
  for(const code of ['25200','40014']){
    const f=bitgetFixture();f.error(code);
    await assert.rejects(f.adapter.prepareTrading(symbol,2),error=>error instanceof ccxt.ExchangeError&&error.message.includes(code)&&
      (code!=='40014'||error instanceof ccxt.PermissionDenied));
    assert.equal(f.wires.filter(w=>w.method==='POST').length,1);
    assert.ok(!f.wires.some(w=>w.path.endsWith('/place-order')));
    const calls=f.wires.length;assertNotSubmitted(await f.adapter.placeOrder(request('buy',false)));
    assert.equal(f.wires.length,calls,'failed preparation cannot dispatch another private request');
  }
});

test('Bitget real CCXT new crossed wire: preview GET cross, one POST crossed, idempotent settings and four order directions',async()=>{
  const f=bitgetFixture('crossed');await f.adapter.inspectTrading(symbol,2);assert.ok(f.wires.every(w=>w.method==='GET'));
  await f.adapter.prepareTrading(symbol,2);
  assert.equal(f.wires.filter(w=>w.path.endsWith('/pre-set-leverage')).length,2);
  assert.deepEqual(f.wires.filter(w=>w.path.endsWith('/set-leverage')).map(w=>w.body),[{category:'USDT-FUTURES',symbol:'BTCUSDT',marginMode:'crossed',leverage:'2'}]);
  await f.adapter.prepareTrading(symbol,2);assert.equal(f.wires.filter(w=>w.path.endsWith('/set-leverage')).length,1);
  for(const [side,reduceOnly] of [['buy',false],['sell',false],['sell',true],['buy',true]] as const){
    const req=request(side,reduceOnly,'-crossed'),result=await f.adapter.placeOrder(req);
    assert.equal(result.status,'filled');assert.equal((await f.adapter.reconcileOrder(req,result.id)).status,'filled');
    assert.equal(f.wires.filter(w=>w.path.endsWith('/place-order')).at(-1)!.body.marginMode,'crossed');
  }
  assert.equal((await f.adapter.fetchAccount()).positions.length,0);
});

test('Bitget real CCXT 25200 preview failure blocks inspect and preparation before any private write',async()=>{
  const f=bitgetFixture('crossed');f.previewError('25200');
  await assert.rejects(f.adapter.inspectTrading(symbol,2),error=>error instanceof ccxt.ExchangeError&&error.message.includes('25200'));
  await assert.rejects(f.adapter.prepareTrading(symbol,2),error=>error instanceof ccxt.ExchangeError&&error.message.includes('25200'));
  assert.ok(f.wires.every(w=>w.method==='GET'));
  const calls=f.wires.length;assertNotSubmitted(await f.adapter.placeOrder(request('buy',false,'-preview-failed')));
  assert.equal(f.wires.length,calls,'failed preview cannot dispatch another private request');
  assert.ok(f.wires.every(w=>w.method==='GET'));
});

test('Gate real CCXT HTTP 400 body preserves READ_ONLY, NO_CHANGE and invalid-param labels',async()=>{
  for(const label of ['READ_ONLY','NO_CHANGE','INVALID_PARAM_VALUE']){
    const f=gateFixture();f.error(label);
    await assert.rejects(f.adapter.prepareTrading(symbol,2),error=>error instanceof ccxt.ExchangeError&&error.message.includes(label));
    assert.ok(!f.wires.some(w=>w.path.endsWith('/orders')&&w.method==='POST'));
  }
});

test('Bitget real CCXT wire: unresolved missing order preserves unknown state and never repeats POST',async()=>{
  const f=bitgetFixture();await f.adapter.prepareTrading(symbol,2);f.loseAck();f.hideOrders();
  const req=request('buy',false,'-unknown');assert.equal((await f.adapter.placeOrder(req)).status,'unknown');
  assert.equal((await f.adapter.placeOrder(req)).status,'unknown');
  assert.equal(f.wires.filter(w=>w.path.endsWith('/place-order')).length,1);
});
