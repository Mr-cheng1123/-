import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import ccxt from 'ccxt';
import {BitgetUta} from '../src/adapters/bitget-uta.js';
import {exchangeClientId,unknownOrder} from '../src/adapters/normalization.js';
import type {OrderRequest} from '../src/shared/types.js';

const req:OrderRequest={clientOrderId:'offline-safe-precision',base:'SAFE',symbol:'SAFE/USDT:USDT',side:'sell',quantity:908.8,limitPrice:.11019,reduceOnly:false};
function fixture(change:any={},pages?:Array<{list:any[];cursor:string|null}>){
  const request={...req,...change},calls:Array<{method:string;path:string;query:any}>=[];
  const client:any=new ccxt.bitget({apiKey:'offline-key',secret:'offline-secret',password:'offline-pass',enableRateLimit:false,
    options:{adjustForTimeDifference:false,maxRetriesOnFailure:0}});
  client.setMarkets([{id:'SAFEUSDT',symbol:req.symbol,base:'SAFE',quote:'USDT',settle:'USDT',type:'swap',spot:false,swap:true,
    future:false,option:false,margin:false,contract:true,active:true,linear:true,inverse:false,contractSize:1,
    precision:{amount:.1,price:.0001},limits:{amount:{min:.1},cost:{min:5}},info:{}}]);
  const raw:any={orderId:'offline-order',clientOid:exchangeClientId('bitget',request.clientOrderId),category:'USDT-FUTURES',symbol:'SAFEUSDT',
    side:'sell',orderType:'limit',timeInForce:'ioc',posSide:'short',tradeSide:'open_short',holdMode:'hedge_mode',reduceOnly:'NO',
    marginMode:'crossed',price:'.1102',qty:String(request.quantity),cumExecQty:'908.8',avgPrice:'.1102',cumExecValue:'100.204',
    updatedTime:'1790916558674',orderStatus:'filled',feeDetail:[{feeCoin:'USDT',fee:'.0601224'}]};
  const trade=(execId:string,qty:string,price:string,fee:string)=>({execId,orderId:raw.orderId,clientOid:raw.clientOid,
    category:raw.category,symbol:raw.symbol,side:raw.side,orderType:raw.orderType,tradeSide:raw.tradeSide,
    execQty:qty,execPrice:price,feeDetail:[{feeCoin:'USDT',fee}]});
  const first=trade('offline-fill-1','366.3','.1102','.024219756'),second=trade('offline-fill-2','542.5','.1103','.03590265');
  const fillPages=pages??[{list:[first,second],cursor:'cursor-even-short-page'}];
  let page=0;
  client.fetchImplementation=async(urlText:string,params:any)=>{
    const url=new URL(urlText),headers=new Headers(params.headers),method=String(params.method);
    assert.equal(method,'GET');assert.equal(params.body,undefined);assert.equal(url.hostname,'api.bitget.com');
    assert.equal(headers.get('ACCESS-KEY'),'offline-key');assert.equal(headers.get('ACCESS-PASSPHRASE'),'offline-pass');
    const message=headers.get('ACCESS-TIMESTAMP')+method+url.pathname+decodeURIComponent(url.search);
    assert.equal(headers.get('ACCESS-SIGN'),createHmac('sha256','offline-secret').update(message).digest('base64'));
    const query=Object.fromEntries(url.searchParams);calls.push({method,path:url.pathname,query});
    let data:any;
    if(url.pathname==='/api/v3/trade/order-info')data=raw;
    else if(url.pathname==='/api/v3/trade/fills'){
      assert.equal(query.category,'USDT-FUTURES');assert.equal(query.orderId,raw.orderId);assert.equal(query.limit,'100');
      data=fillPages[page++]??{list:[],cursor:null};
    }else throw new Error('Unexpected offline precision route');
    return new Response(JSON.stringify({code:'00000',data}),{headers:{'content-type':'application/json'}});
  };
  return {request,client,adapter:new BitgetUta(client),raw,first,second,fillPages,calls};
}

test('Bitget actual SAFE two-fill shape replaces truncated avgPrice and cumExecValue using real CCXT signed GETs',async()=>{
  const f=fixture(),result=await f.adapter.inspectOrder(f.request);
  assert.equal(result.status,'filled');assert.equal(result.filledQuantity,908.8);
  assert.equal(result.averagePrice,(366.3*.1102+542.5*.1103)/908.8);
  assert.equal(result.feeUsd,.024219756+.03590265);
  assert.equal(result.averagePrice,.1102596941021127);
  assert.equal(result.averagePriceVerified,true);
  assert.notEqual(result.averagePrice,Number(f.raw.avgPrice));assert.notEqual(result.averagePrice,Number(f.raw.cumExecValue)/908.8);
  assert.deepEqual(f.calls.map(c=>c.path),['/api/v3/trade/order-info','/api/v3/trade/fills']);
});

test('Bitget paginated execution coverage deduplicates overlap and accepts exact partial cumulative quantity',async()=>{
  const f=fixture({quantity:1500});f.raw.orderStatus='cancelled';
  f.fillPages.splice(0,1,{list:[f.first],cursor:'older'},{list:[f.first,f.second],cursor:'still-present'});
  const result=await f.adapter.reconcile(f.request);
  assert.equal(result.status,'partial');assert.equal(result.filledQuantity,908.8);assert.equal(result.averagePrice,.1102596941021127);
  assert.equal(result.feeUsd,.060122406);assert.equal(f.calls.at(-1)?.query.cursor,'older');
  assert.equal(result.averagePriceVerified,true);
  assert.ok(f.calls.every(c=>c.method==='GET'));
});

test('Bitget exact fills reject wrong identities, conflicting duplicates, excess quantity, currency and out-of-limit price',async()=>{
  for(const changed of [{orderId:'wrong'},{clientOid:'wrong'},{symbol:'OTHERUSDT'},{category:'SPOT'},{side:'buy'},
    {tradeSide:'close_short'},{orderType:'market'},{execId:''},{execQty:'0'},{execQty:'10000'},{execPrice:'.1'},
    {feeDetail:[]},{feeDetail:[{feeCoin:'BGB',fee:'.1'}]},{feeDetail:[{feeCoin:'USDT',fee:''}]}]){
    const f=fixture();Object.assign(f.first,changed);
    const result=await f.adapter.inspectOrder(f.request);
    assert.equal(result.status,'filled',JSON.stringify(changed));assert.equal(result.filledQuantity,908.8);assert.equal(result.averagePriceVerified,false);
    assert.equal(result.averagePrice,.1102);assert.ok(f.calls.every(c=>c.method==='GET'));
  }
  const f=fixture();f.fillPages[0].list.push({...f.first,execPrice:'.1103'});
  const conflict=await f.adapter.inspectOrder(f.request);assert.equal(conflict.status,'filled');assert.equal(conflict.averagePriceVerified,false);
});

test('Bitget missing/nonadvancing execution pages preserve observed exposure without confirming an approximate price',async()=>{
  for(const kind of ['empty','short','cycle']){
    const f=fixture();f.fillPages.splice(0,1,kind==='empty'?{list:[],cursor:null}:kind==='short'?{list:[f.first],cursor:null}:
      {list:[f.first],cursor:'same'},...(kind==='cycle'?[{list:[f.first],cursor:'same'}]:[]));
    const result=await f.adapter.inspectOrder(f.request);
    assert.equal(result.status,'filled');assert.equal(result.filledQuantity,908.8);assert.equal(result.averagePrice,.1102);assert.equal(result.averagePriceVerified,false);
    assert.ok(f.calls.every(c=>c.method==='GET'));
  }
  const f=fixture(),prior={...unknownOrder(f.request),status:'partial' as const,filledQuantity:908.8,averagePrice:.1102596941021127,feeUsd:.060122406};
  f.raw.cumExecQty='800';
  const result=await f.adapter.inspectOrder(f.request,prior);
  assert.deepEqual(result,{...prior,averagePriceVerified:false});assert.equal(f.calls.length,1);
});

test('Bitget caller-specified ID must match the GET identity and open order inspection never cancels',async()=>{
  const f=fixture();assert.equal((await f.adapter.inspectOrder(f.request,undefined,'other-order')).status,'unknown');assert.equal(f.calls.length,1);
  f.raw.orderStatus='partially_filled';
  const result=await f.adapter.inspectOrder(f.request);assert.equal(result.status,'unknown');assert.equal(result.averagePrice,.1102596941021127);
  assert.ok(f.calls.every(c=>c.method==='GET'));
});

test('Bitget standalone verification is GET only, rejects incomplete proof and leaves the caller ledger untouched',async()=>{
  const f=fixture(),prior={...unknownOrder(f.request),status:'filled' as const,filledQuantity:908.8,averagePrice:.1102,feeUsd:.0601224};
  const original=structuredClone(prior),verified=await f.adapter.verifyOrderExecution(f.request,prior);
  assert.equal(verified.averagePriceVerified,true);assert.equal(verified.averagePrice,.1102596941021127);assert.deepEqual(prior,original);
  f.fillPages.splice(0,1,{list:[f.first],cursor:null});
  await assert.rejects(f.adapter.verifyOrderExecution(f.request,prior),/cover confirmed fills/);
  assert.deepEqual(prior,original);assert.ok(f.calls.every(c=>c.method==='GET'));
});
