import test from 'node:test';
import assert from 'node:assert/strict';
import ccxt from 'ccxt';
import {CcxtAdapter} from '../src/adapters/ccxt.js';
import {defaultConfig} from '../src/shared/config.js';
import {exchangeClientId} from '../src/adapters/normalization.js';
import type {OrderRequest} from '../src/shared/types.js';

const symbol='BTC/USDT:USDT';
const request:OrderRequest={base:'BTC',symbol,side:'buy',quantity:1,limitPrice:100,reduceOnly:false,clientOrderId:'readonly-existing-intent'};
function fixture(exchange:'gate'|'bybit',reply:(path:string,params:Record<string,string>)=>any){
  const Constructor=(ccxt as any)[exchange],client=new Constructor({apiKey:'offline-key',secret:'offline-secret',enableRateLimit:false,options:{adjustForTimeDifference:false}});
  const calls:{method:string;path:string;params:Record<string,string>}[]=[];
  client.setMarkets([{id:exchange==='gate'?'BTC_USDT':'BTCUSDT',symbol,base:'BTC',quote:'USDT',settle:'USDT',type:'swap',
    spot:false,swap:true,future:false,option:false,contract:true,active:true,linear:true,inverse:false,contractSize:exchange==='gate'?.1:1,
    precision:{amount:exchange==='gate'?1:.001,price:.1},limits:{amount:{min:1},cost:{min:1}},info:{}}]);
  client.fetchImplementation=async(urlText:string,init:any)=>{
    const url=new URL(urlText),params=Object.fromEntries(url.searchParams),method=String(init.method);
    assert.equal(method,'GET','Read-only observation must never issue a financial write');
    assert.equal(init.body,undefined);calls.push({method,path:url.pathname,params});
    const response=reply(url.pathname,params);
    return new Response(JSON.stringify(exchange==='bybit'?{retCode:0,retMsg:'OK',result:response,time:1770000000000,retExtInfo:{}}:response),
      {headers:{'Content-Type':'application/json'}});
  };
  const adapter=new CcxtAdapter(exchange,{...defaultConfig,mode:'live',dataSource:'public'},client);
  return {adapter,calls};
}
const bybitOpen=(id:string,extra:any={})=>({orderId:id,orderLinkId:'',symbol:'BTCUSDT',side:'Buy',qty:'1',leavesQty:'1',reduceOnly:false,orderStatus:'New',stopOrderType:'',...extra});
const gateOpen=(id:string,extra:any={})=>({id,contract:'BTC_USDT',size:'10',left:'10',status:'open',is_reduce_only:false,...extra});

test('Bybit reads every open-order page including a zero-quantity conditional close without POST or cancellation',async()=>{
  const s=fixture('bybit',(path,p)=>{
    assert.equal(path,'/v5/order/realtime');assert.equal(p.openOnly,'0');assert.equal(p.symbol,'BTCUSDT');
    assert.equal(p.orderFilter,undefined);assert.equal(p.limit,'50');
    return p.cursor?{list:[bybitOpen('conditional',{qty:'0',leavesQty:'0',reduceOnly:true,stopOrderType:'Stop',orderStatus:'Untriggered'})],nextPageCursor:''}:
      {list:Array.from({length:50},(_,i)=>bybitOpen(`regular-${i}`)),nextPageCursor:'next-page'};
  });
  const orders=await s.adapter.fetchOpenOrders(symbol);
  assert.equal(orders.length,51);assert.equal(orders.at(-1)?.kind,'conditional');assert.equal(orders.at(-1)?.quantity,0);
  assert.equal(s.calls.length,2);assert.equal(s.calls[1].params.cursor,'next-page');
});

test('Bybit missing, duplicate, terminal or malformed order rows never become an empty successful observation',async()=>{
  for(const row of [bybitOpen('one',{symbol:'ETHUSDT'}),bybitOpen('one',{qty:'bad'}),bybitOpen('one',{leavesQty:'2'}),bybitOpen('one',{orderStatus:'Filled'})]){
    const s=fixture('bybit',()=>({list:[row],nextPageCursor:''}));await assert.rejects(s.adapter.fetchOpenOrders(symbol));
  }
  const duplicate=fixture('bybit',()=>({list:[bybitOpen('one'),bybitOpen('one')],nextPageCursor:''}));
  await assert.rejects(duplicate.adapter.fetchOpenOrders(symbol));
  const missing=fixture('bybit',()=>({nextPageCursor:''}));await assert.rejects(missing.adapter.fetchOpenOrders(symbol));
  const loop=fixture('bybit',()=>({list:[bybitOpen('one')],nextPageCursor:'same'}));await assert.rejects(loop.adapter.fetchOpenOrders(symbol));
});

test('Gate observes all regular pages and the separate conditional-order list in base coin quantities',async()=>{
  const s=fixture('gate',(path,p)=>{
    assert.equal(p.status,'open');assert.equal(p.contract,'BTC_USDT');assert.equal(p.limit,'100');
    if(path==='/api/v4/futures/usdt/orders')return p.offset==='0'?Array.from({length:100},(_,i)=>gateOpen(String(i+1))):[gateOpen('101',{size:'-10',left:'-2'})];
    assert.equal(path,'/api/v4/futures/usdt/price_orders');
    return [{id:'1',status:'open',initial:{contract:'BTC_USDT',size:0,reduce_only:true,auto_size:'close_short'}}];
  });
  const orders=await s.adapter.fetchOpenOrders(symbol);
  assert.equal(orders.length,102);assert.equal(orders[100].side,'sell');assert.equal(orders[100].quantity,1);assert.equal(orders[100].remainingQuantity,.2);
  assert.equal(orders[101].kind,'conditional');assert.equal(orders[101].quantity,0);assert.equal(s.calls.length,3);
});

test('Gate only confirms no pending orders after both ordinary and conditional GETs return valid empty lists',async()=>{
  const empty=fixture('gate',()=>[]);assert.deepEqual(await empty.adapter.fetchOpenOrders(symbol),[]);assert.equal(empty.calls.length,2);
  for(const response of [null,{},[gateOpen('1',{left:'bad'})],[gateOpen('1',{status:'finished'})],[gateOpen('1'),gateOpen('1')]]){
    const bad=fixture('gate',()=>response);await assert.rejects(bad.adapter.fetchOpenOrders(symbol));
  }
  const badConditional=fixture('gate',path=>path.endsWith('/orders')?[]:[{id:'1',status:'open',initial:{contract:'ETH_USDT',size:1}}]);
  await assert.rejects(badConditional.adapter.fetchOpenOrders(symbol));
});

test('Bybit inspectOrder observes an anomalously open IOC without cancelling it',async()=>{
  const s=fixture('bybit',(path,p)=>{
    assert.equal(path,'/v5/order/realtime');assert.equal(p.orderLinkId,exchangeClientId('bybit',request.clientOrderId));
    return {list:[bybitOpen('existing',{orderLinkId:exchangeClientId('bybit',request.clientOrderId),price:'100',cumExecQty:'.2',avgPrice:'100',
      leavesQty:'.8',updatedTime:'1770000000000',positionIdx:0,orderType:'Limit',timeInForce:'IOC',cumFeeDetail:{USDT:'.01'},orderStatus:'PartiallyFilled'})]};
  });
  const observation=await s.adapter.inspectOrder(request);
  assert.equal(observation.status,'unknown');assert.equal(observation.filledQuantity,.2);assert.equal(s.calls.length,1);
});

test('Gate inspectOrder observes an anomalously open IOC without cancelling it',async()=>{
  const s=fixture('gate',(path)=>{
    assert.ok(path.startsWith('/api/v4/futures/usdt/orders/'));
    return gateOpen('1001',{text:exchangeClientId('gate',request.clientOrderId),left:'8',price:'100',fill_price:'100',tif:'ioc',
      create_time:1770000000,is_close:false,auto_size:'',pos_margin_mode:'isolated'});
  });
  const observation=await s.adapter.inspectOrder(request);
  assert.equal(observation.status,'unknown');assert.equal(observation.filledQuantity,.2);assert.equal(s.calls.length,1);
});

test('Bybit absent history remains unknown after two GETs, without inventing a cancellation or position',async()=>{
  const s=fixture('bybit',()=>({list:[],nextPageCursor:''}));const observation=await s.adapter.inspectOrder(request);
  assert.equal(observation.status,'unknown');assert.equal(observation.filledQuantity,0);assert.equal(s.calls.length,2);
  assert.ok(s.calls[1].path.endsWith('/history'));
});
