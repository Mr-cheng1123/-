import test from 'node:test';
import assert from 'node:assert/strict';
import {CcxtAdapter} from '../src/adapters/ccxt.js';
import {defaultConfig} from './legacy-config.js';
import {inspectLiveStart} from '../src/core/live-start.js';
import {EXCHANGES,type OrderRequest} from '../src/shared/types.js';
import {attachBitgetFillFixture} from './bitget-fill-fixture.js';

const market={id:'BTCUSDT',symbol:'BTC/USDT:USDT',base:'BTC',quote:'USDT',settle:'USDT',active:true,swap:true,linear:true,
  contractSize:1,precision:{amount:.001,price:.1},limits:{amount:{min:.001},cost:{min:5}}};
const config={...defaultConfig,mode:'live' as const,dataSource:'public' as const,orderNotionalUsd:100,leverage:2};
const response=(data:any)=>({code:'00000',data});

/** All endpoints are local fixtures. No authenticated network client is constructed. */
function fixture(newSymbolMarginMode:'crossed'|'isolated'='isolated'){
  const calls:{method:string;params:any}[]=[],orders=new Map<string,any>();
  const leverages=new Map<string,string>();let mode='hedge_mode';
  const settings=()=>({accountMode:'unified',accountLevel:'basic',holdMode:mode,assetMode:'multi_assets',deltaSwitch:'no',
    symbolConfigList:leverages.size===2?[{category:'USDT-FUTURES',symbol:market.id,marginMode:newSymbolMarginMode,
      ...(newSymbolMarginMode==='crossed'?{leverage:leverages.get('long'),longLeverage:null,shortLeverage:null}:
        {longLeverage:leverages.get('long'),shortLeverage:leverages.get('short')})}]:[]});
  const method=(name:string,fn:(p:any)=>any)=>async(p:any)=>{calls.push({method:name,params:p});return response(fn(p));};
  const client:any={apiKey:'fixture-only',secret:'fixture-only',password:'fixture-only',precisionMode:4,
    markets:{[market.symbol]:market},loadMarkets:async()=>({[market.symbol]:market}),market:()=>market,
    amountToPrecision:(_s:string,n:number)=>Number(n).toFixed(3),priceToPrecision:(_s:string,n:number)=>(Math.round(n*10)/10).toFixed(1),
    privateUtaGetV3AccountSettings:method('settings',settings),
    privateUtaGetV3AccountAssets:method('assets',()=>({accountEquity:'1200',effEquity:'1000',imr:'0',assets:[
      {coin:'USDT',equity:'300',available:'300',balance:'300',debt:'0'},
      {coin:'USDC',equity:'20',available:'20',balance:'20',debt:'0'},
      {coin:'BGB',equity:'1',available:'1',balance:'1',debt:'0'}]})),
    privateUtaGetV3PositionCurrentPosition:method('positions',()=>({list:null})),
    privateUtaGetV3TradeUnfilledOrders:method('pending',()=>({list:[],cursor:''})),
    privateUtaGetV3AccountPreSetLeverage:method('preview',()=>({requiredMargin:'0',estMaxOpen:'1000',marginChange:'0'})),
    privateUtaPostV3AccountSetLeverage:method('leverage',p=>{for(const side of p.marginMode==='crossed'?['long','short']:[p.posSide])leverages.set(side,p.leverage);return 'success';}),
    privateUtaPostV3TradePlaceOrder:method('place',p=>{
      const orderId=`fixture-${orders.size+1}`,tradeSide=`${(p.side==='buy')===(p.posSide==='long')?'open':'close'}_${p.posSide}`;
      const raw={...p,orderId,holdMode:mode,tradeSide,reduceOnly:'NO',orderStatus:'filled',cumExecQty:p.qty,avgPrice:p.price,
        updatedTime:String(Date.now()),feeDetail:[{feeCoin:'USDT',fee:'0.12'}]};
      orders.set(orderId,raw);return{orderId,clientOid:p.clientOid};
    }),
    privateUtaGetV3TradeOrderInfo:method('info',p=>orders.get(p.orderId)??[...orders.values()].find(o=>o.clientOid===p.clientOid)),
    privateUtaPostV3TradeCancelOrder:method('cancel',()=>({})),
  };
  attachBitgetFillFixture(client,p=>calls.push({method:'fills',params:p}));
  return {adapter:new CcxtAdapter('bitget',{...config,bitgetNewSymbolMarginMode:newSymbolMarginMode},client),client,calls,setMode:(value:string)=>{mode=value;}};
}

test('Gate plus basic UTA hedge account with other owned assets passes read-only startup without any writes',async()=>{
  const f=fixture();
  const result=await inspectLiveStart(config,{permissionGranted:false,exchanges:EXCHANGES.map(exchange=>({exchange,supported:true,credentialsConfigured:['gate','bitget'].includes(exchange)}))},
    {executionUnlocked:false,blockedReasons:[],adapter:exchange=>exchange==='bitget'?f.adapter:{fetchAccount:async()=>({freeUsd:500,equityUsd:500,positions:[]})}});
  assert.equal(result.canStart,true);assert.equal(result.executionUnlocked,false);
  assert.equal(result.accounts.find(a=>a.exchange==='bitget')?.freeUsd,300);
  assert.equal(result.accounts.filter(a=>a.status==='ready').length,2);
  assert.ok(f.calls.every(c=>['settings','assets','positions'].includes(c.method)));
});

test('UTA hedge preparation and all four order directions survive fresh per-call account adapters',async()=>{
  const f=fixture();await f.adapter.prepareTrading(market.symbol,2);
  const writes=f.calls.filter(c=>c.method==='leverage');assert.equal(writes.length,2);
  assert.deepEqual(writes.map(c=>c.params.posSide).sort(),['long','short']);
  assert.ok(writes.every(c=>c.params.marginMode==='isolated'&&c.params.leverage==='2'));
  for(const [side,reduceOnly,posSide] of [['buy',false,'long'],['sell',false,'short'],['sell',true,'long'],['buy',true,'short']] as const){
    const request:OrderRequest={base:'BTC',symbol:market.symbol,clientOrderId:`fixture-${side}-${reduceOnly}`,side,reduceOnly,quantity:.01,limitPrice:10000};
    const first=await f.adapter.placeOrder(request);assert.equal(first.status,'filled');assert.equal(first.filledQuantity,.01);
    assert.equal(first.feeUsd,.12);
    const sent=f.calls.filter(c=>c.method==='place').at(-1)!.params;
    assert.equal(sent.posSide,posSide);assert.equal(sent.side,side);assert.equal(sent.reduceOnly,undefined);assert.equal(sent.tradeSide,undefined);
    const count=f.calls.filter(c=>c.method==='place').length;
    assert.deepEqual(await f.adapter.placeOrder(request),first);assert.equal(f.calls.filter(c=>c.method==='place').length,count);
  }
  assert.equal(f.calls.filter(c=>c.method==='place').length,4);
  assert.equal(f.calls.filter(c=>c.method==='cancel').length,0);
});

test('Bitget UTA Maker first leg carries native post_only and verified execution cash through factory dispatch',async()=>{
  const f=fixture();await f.adapter.prepareTrading(market.symbol,2);
  const request:OrderRequest={base:'BTC',symbol:market.symbol,clientOrderId:'offline-uta-maker',side:'buy',reduceOnly:false,quantity:.01,limitPrice:10000,postOnly:true};
  const value=await f.adapter.placeOrder(request);
  assert.equal(value.status,'filled');assert.equal(value.filledQuantity,.01);assert.equal(value.feeUsd,.12);assert.equal(value.averagePriceVerified,true);
  assert.equal(f.calls.find(c=>c.method==='place')?.params.timeInForce,'post_only');
  assert.equal(f.calls.filter(c=>c.method==='place').length,1);assert.equal(f.calls.filter(c=>c.method==='cancel').length,0);
  assert.deepEqual(await f.adapter.placeOrder(request),value);assert.equal(f.calls.filter(c=>c.method==='place').length,1);
  f.client.privateUtaGetV3TradeFills=async()=>response({list:[],cursor:''});
  const unverified=await f.adapter.inspectOrder(request,value.id);
  assert.equal(unverified.status,'unknown');assert.equal(unverified.filledQuantity,.01);assert.equal(unverified.averagePriceVerified,false);
  await f.adapter.close();
});

test('UTA concrete-symbol inspection accepts an unconfigured hedge symbol without changing leverage or creating orders',async()=>{
  const f=fixture();await f.adapter.inspectTrading(market.symbol,2);
  assert.ok(f.calls.some(c=>c.method==='pending'));
  assert.ok(f.calls.every(c=>['settings','assets','positions','pending','preview'].includes(c.method)));
});

test('UTA new crossed settings with null optional side fields survive factory dispatch, no-op prepare and four order directions',async()=>{
  const f=fixture('crossed');await f.adapter.inspectTrading(market.symbol,2);await f.adapter.prepareTrading(market.symbol,2);
  assert.deepEqual(f.calls.filter(c=>c.method==='leverage').map(c=>c.params),[{category:'USDT-FUTURES',symbol:'BTCUSDT',marginMode:'crossed',leverage:'2'}]);
  assert.deepEqual(f.calls.filter(c=>c.method==='preview').map(c=>c.params),Array(2).fill({category:'USDT-FUTURES',symbol:'BTCUSDT',marginMode:'cross',leverage:'2'}));
  await f.adapter.prepareTrading(market.symbol,2);assert.equal(f.calls.filter(c=>c.method==='leverage').length,1);
  for(const [side,reduceOnly,posSide] of [['buy',false,'long'],['sell',false,'short'],['sell',true,'long'],['buy',true,'short']] as const){
    const result=await f.adapter.placeOrder({base:'BTC',symbol:market.symbol,clientOrderId:`cross-fixture-${side}-${reduceOnly}`,side,reduceOnly,quantity:.01,limitPrice:10000});
    assert.equal(result.status,'filled');assert.equal(result.filledQuantity,.01);
    const sent=f.calls.filter(c=>c.method==='place').at(-1)!.params;
    assert.equal(sent.marginMode,'crossed');assert.equal(sent.posSide,posSide);assert.equal(sent.reduceOnly,undefined);
  }
});
