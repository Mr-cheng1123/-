import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import ccxt from 'ccxt';
import {CcxtAdapter} from '../src/adapters/ccxt.js';
import {GatePrivate} from '../src/adapters/gate-private.js';
import {consumeGateMakerCreateRejection,configureExchangeTransport,ExchangeNetworkError,getExchangeNetworkStatus} from '../src/adapters/network.js';
import {exchangeClientId} from '../src/adapters/normalization.js';
import {OrderNotSubmittedError} from '../src/adapters/order-rejection.js';
import {defaultConfig} from '../src/shared/config.js';
import type {OrderRequest} from '../src/shared/types.js';

// Official create rejection, distinct from FuturesOrder.finish_as and ordinary IOC diagnostics.
// https://www.gate.com/docs/developers/apiv4/en/#label-list
const request:OrderRequest={clientOrderId:'offline-gate-maker-create',base:'CT',symbol:'CT/USDT:USDT',
  side:'sell',quantity:2,limitPrice:11,reduceOnly:true,postOnly:true};
const rejectionBody=JSON.stringify({label:'ORDER_POC_IMMEDIATE',detail:'order price would immediately fill'});
const rejectionMessage=`gate ${rejectionBody}`;
type Call={method:string;path:string;body:any};

/** Installed CCXT signs and parses real HTTP Responses. All transport ends in this local fixture. */
function fixture(wrapped=true){
  const key='OFFLINE-GATE-WIRE-KEY',secret='OFFLINE-GATE-WIRE-SECRET';
  const client:any=new ccxt.gate({apiKey:key,secret,enableRateLimit:false,
    options:{defaultType:'swap',defaultSettle:'USDT',unifiedAccount:false,adjustForTimeDifference:false,maxRetriesOnFailure:0}});
  client.setMarkets([{id:'CT_USDT',symbol:request.symbol,base:'CT',quote:'USDT',settle:'USDT',type:'swap',spot:false,
    margin:false,swap:true,future:false,option:false,contract:true,active:true,linear:true,inverse:false,contractSize:1,
    precision:{amount:1,price:.01},limits:{amount:{min:1},cost:{min:5}},info:{}}]);
  const calls:Call[]=[];
  let postReply:()=>Response=()=>new Response(rejectionBody,{status:400,headers:{'Content-Type':'application/json'}});
  client.fetchImplementation=async(urlText:string,params:any)=>{
    const url=new URL(urlText),method=String(params.method),headers=new Headers(params.headers),body=params.body??'';
    assert.equal(url.hostname,'api.gateio.ws');assert.equal(headers.get('KEY'),key);
    const signature=[method,url.pathname,decodeURIComponent(url.search.slice(1)),createHash('sha512').update(body).digest('hex'),headers.get('Timestamp')].join('\n');
    assert.equal(headers.get('SIGN'),createHmac('sha512',secret).update(signature).digest('hex'));
    calls.push({method,path:url.pathname,body:body?JSON.parse(body):undefined});
    if(method==='POST'&&url.pathname==='/api/v4/futures/usdt/orders')return postReply();
    let data:any;
    if(method==='GET'&&url.pathname.endsWith('/accounts'))data={currency:'USDT',available:'100',total:'100',unrealised_pnl:'0',position_mode:'single',margin_mode:0};
    else if(method==='GET'&&url.pathname.endsWith('/positions'))data=[{contract:'CT_USDT',size:'2',mode:'single',leverage:'2'}];
    else if(method==='GET'&&url.pathname.includes('/orders/'))return new Response(JSON.stringify({label:'ORDER_NOT_FOUND',message:'Order not found'}),{status:404,headers:{'Content-Type':'application/json'}});
    else throw new Error('Unexpected offline Gate wire route');
    return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
  };
  if(wrapped)configureExchangeTransport(client,'gate');
  const adapter=new CcxtAdapter('gate',{...defaultConfig,mode:'live',dataSource:'public'},client);
  return {client,adapter,native:new GatePrivate(client),calls,
    reply(body:string,status=400){postReply=()=>new Response(body,{status,headers:{'Content-Type':'application/json'}});},
    fail(error:Error){postReply=()=>{throw error;};},posts:()=>calls.filter(call=>call.method==='POST')};
}

for(const wrapped of [false,true]){
  test(`Gate real CCXT ${wrapped?'production-wrapped':'bare'} documented PostOnly rejection proves terminal zero and never replays its original create`,async()=>{
    const f=fixture(wrapped);try{
      const rejected=await f.adapter.submitMakerReduction(request);
      assert.equal(rejected.rejectionCode,'GATE_MAKER_POST_ONLY_WOULD_TAKE');assert.equal(rejected.id,'');
      assert.equal(rejected.status,'cancelled');assert.equal(rejected.filledQuantity,0);assert.equal(rejected.feeUsd,0);
      assert.equal(f.posts().length,1);assert.equal(f.posts()[0].body.tif,'poc');assert.equal(f.posts()[0].body.reduce_only,true);
      assert.equal(f.posts()[0].body.text,exchangeClientId('gate',request.clientOrderId));
      assert.deepEqual(await f.adapter.submitMakerReduction({...request}),rejected);assert.equal(f.posts().length,1);
      await assert.rejects(new GatePrivate(f.client).placeMakerReduction(request,2,11),
        (error:unknown)=>error instanceof OrderNotSubmittedError&&error.rejectionCode==='GATE_MAKER_POST_ONLY_WOULD_TAKE');
      assert.equal(f.posts().length,1);
      const reads=f.calls.length,observed=await f.adapter.inspectMakerReduction(request);
      assert.equal(observed.activity,'terminal');assert.equal(observed.executionVerified,true);assert.deepEqual(observed.result,rejected);
      assert.equal(f.calls.length,reads,'Known no-ID rejection does not become an unknown order lookup');
      assert.doesNotMatch(JSON.stringify(rejected),/OFFLINE-GATE-WIRE|order price would immediately fill/);
      assert.equal(getExchangeNetworkStatus(f.client)?.retryAt,undefined);
    }finally{await f.adapter.close();}
  });

  test(`Gate ${wrapped?'wrapped':'bare'} network, timeout, spoofed class, duplicate and internal errors remain unknown with no repeated POST`,async()=>{
    const spoofed=Object.assign(new Error(rejectionMessage),{name:'OrderImmediatelyFillable'});
    const failures=[new ccxt.NetworkError(rejectionMessage),new ccxt.RequestTimeout(rejectionMessage),spoofed,
      new ccxt.DuplicateOrderId(rejectionMessage),new ccxt.ExchangeError(rejectionMessage),new ExchangeNetworkError('API_ERROR',0,undefined,'gate')];
    for(const error of failures){const f=fixture(wrapped);try{
      f.client.last_response=rejectionBody;f.client.last_json_response=JSON.parse(rejectionBody);f.fail(error);
      const ack=await f.adapter.submitMakerReduction(request);
      assert.equal(ack.status,'unknown',error.name);assert.equal(ack.rejectionCode,undefined,error.name);assert.equal(ack.filledQuantity,0);
      assert.deepEqual(await f.adapter.submitMakerReduction(request),ack);assert.equal(f.posts().length,1);
      const observed=await f.adapter.inspectMakerReduction(request);
      assert.equal(observed.activity,'unknown');assert.equal(observed.executionVerified,false);assert.equal(observed.result.rejectionCode,undefined);
      assert.equal(f.posts().length,1,'A later 404 does not grant a new create');
    }finally{await f.adapter.close();}}
  });

  test(`Gate ${wrapped?'wrapped':'bare'} strict create JSON rejects duplicate keys, trailing text, unknown fields and other native labels`,async()=>{
    const bodies=[
      JSON.stringify({label:'INTERNAL',message:'ORDER_POC_IMMEDIATE'}),JSON.stringify({label:'ORDER_DUPLICATE',message:'duplicate create'}),
      JSON.stringify({label:'ORDER_NOT_FOUND',message:'missing'}),
      '{"label":"ORDER_POC_IMMEDIATE","label":"ORDER_POC_IMMEDIATE","detail":"same repeated key"}',
      '{"label":"INTERNAL","label":"ORDER_POC_IMMEDIATE","detail":"conflicting repeated key"}',
      rejectionBody+' trailing',JSON.stringify({label:'ORDER_POC_IMMEDIATE',id:'10001'}),
      JSON.stringify({label:'ORDER_POC_IMMEDIATE',detail:{message:'nested'}}),
    ];
    for(const body of bodies){const f=fixture(wrapped);try{
      f.reply(body);const ack=await f.adapter.submitMakerReduction(request);
      assert.equal(ack.status,'unknown');assert.equal(ack.rejectionCode,undefined);assert.equal(ack.filledQuantity,0);
      assert.deepEqual(await f.adapter.submitMakerReduction(request),ack);assert.equal(f.posts().length,1);
    }finally{await f.adapter.close();}}
  });
}

test('Gate raw method return with only a business label stays unknown; only a verified create exception proves no acceptance',async()=>{
  const f=fixture();try{
    let rawReturns=0;f.client.privateFuturesPostSettleOrders=async()=>{rawReturns++;return {label:'ORDER_POC_IMMEDIATE'};};
    const ack=await f.adapter.submitMakerReduction(request);
    assert.equal(ack.status,'unknown');assert.equal(ack.id,'');assert.equal(ack.rejectionCode,undefined);assert.equal(ack.filledQuantity,0);
    assert.deepEqual(await f.adapter.submitMakerReduction(request),ack);assert.equal(rawReturns,1);
  }finally{await f.adapter.close();}
});

test('Gate transport refusal proof is bound to the exact original client and native ID and is consumed once',async()=>{
  const f=fixture();try{
    const payload={settle:'usdt',contract:'CT_USDT',size:'-2',price:'11',tif:'poc',reduce_only:true,text:exchangeClientId('gate',request.clientOrderId)};
    let rejected:unknown;try{await f.client.privateFuturesPostSettleOrders(payload);}catch(error){rejected=error;}
    assert.ok(rejected instanceof ExchangeNetworkError);assert.equal(rejected.code,'API_ERROR');
    assert.equal(consumeGateMakerCreateRejection(rejected,{},request.clientOrderId),false);
    assert.equal(consumeGateMakerCreateRejection(rejected,f.client,'other-original-id'),false);
    assert.equal(consumeGateMakerCreateRejection(rejected,f.client,request.clientOrderId),true);
    assert.equal(consumeGateMakerCreateRejection(rejected,f.client,request.clientOrderId),false);
    assert.doesNotMatch(JSON.stringify(rejected),/ORDER_POC_IMMEDIATE|OFFLINE-GATE-WIRE|order price would immediately fill/);
  }finally{await f.adapter.close();}
});

test('Gate ordinary IOC creation and entry-shaped transport cannot consume Maker-only refusal proof',async()=>{
  const ordinary=fixture();try{
    let error:unknown;try{await ordinary.native.place({...request,postOnly:false},2,11);}catch(value){error=value;}
    assert.ok(error instanceof ExchangeNetworkError);assert.equal(error instanceof OrderNotSubmittedError,false);
    assert.equal(consumeGateMakerCreateRejection(error,ordinary.client,request.clientOrderId),false);
    assert.equal(await ordinary.native.place({...request,postOnly:false},2,11),undefined);assert.equal(ordinary.posts().length,1);
  }finally{await ordinary.adapter.close();}
  const entry=fixture();try{
    let error:unknown;try{await entry.client.privateFuturesPostSettleOrders({settle:'usdt',contract:'CT_USDT',size:'2',price:'11',
      tif:'poc',reduce_only:false,text:exchangeClientId('gate',request.clientOrderId)});}catch(value){error=value;}
    assert.ok(error instanceof ExchangeNetworkError);assert.equal(consumeGateMakerCreateRejection(error,entry.client,request.clientOrderId),false);
  }finally{await entry.adapter.close();}
});

test('Gate a private GET or another create endpoint cannot create an original USDT Maker refusal proof',async()=>{
  for(const [url,method] of [['https://api.gateio.ws/api/v4/futures/usdt/orders/10001','GET'],
    ['https://api.gateio.ws/api/v4/futures/btc/orders','POST']] as const){
    const client:any={fetch:async()=>{throw new ccxt.OrderImmediatelyFillable(rejectionMessage);}};
    configureExchangeTransport(client,'gate');let error:unknown;
    try{await client.fetch(url,method,{},JSON.stringify({tif:'poc',reduce_only:true,text:exchangeClientId('gate',request.clientOrderId)}));}catch(value){error=value;}
    assert.ok(error instanceof ExchangeNetworkError);assert.equal(consumeGateMakerCreateRejection(error,client,request.clientOrderId),false);
  }
});
