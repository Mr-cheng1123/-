import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import ccxt from 'ccxt';
import {BitgetClassic} from '../src/adapters/bitget-classic.js';
import {BitgetUta} from '../src/adapters/bitget-uta.js';
import {exchangeClientId,unknownOrder} from '../src/adapters/normalization.js';
import type {OrderRequest,OrderResult} from '../src/shared/types.js';
import {OrderNotSubmittedError} from '../src/adapters/order-rejection.js';

type Kind='classic'|'uta';
const request:OrderRequest={clientOrderId:'offline-bitget-maker-reduce',base:'BTC',symbol:'BTC/USDT:USDT',
  side:'sell',quantity:1,limitPrice:100,reduceOnly:true,postOnly:true};
function fixture(kind:Kind,hedged=false){
  const client:any=new ccxt.bitget({apiKey:'offline-key',secret:'offline-secret',password:'offline-pass',enableRateLimit:false,
    options:{adjustForTimeDifference:false,maxRetriesOnFailure:0}});
  client.setMarkets([{id:'BTCUSDT',symbol:request.symbol,base:'BTC',quote:'USDT',settle:'USDT',type:'swap',spot:false,swap:true,
    future:false,option:false,margin:false,contract:true,active:true,linear:true,inverse:false,contractSize:1,
    precision:{amount:.1,price:.1},limits:{amount:{min:.1},cost:{min:5}},info:{}}]);
  const holdMode=hedged?'hedge_mode':'one_way_mode',now=String(Date.now());
  const raw:any=kind==='classic'?{symbol:'BTCUSDT',orderId:'offline-order',clientOid:exchangeClientId('bitget',request.clientOrderId),
    size:'1',baseVolume:'.4',price:'100',priceAvg:'100',fee:'-.008',state:'partially_filled',side:'sell',marginCoin:'USDT',
    posMode:holdMode,marginMode:'isolated',reduceOnly:'YES',orderType:'limit',force:'post_only',uTime:now}:
    {category:'USDT-FUTURES',symbol:'BTCUSDT',orderId:'offline-order',clientOid:exchangeClientId('bitget',request.clientOrderId),
      qty:'1',cumExecQty:'.4',price:'100',avgPrice:'100',orderStatus:'partially_filled',side:'sell',orderType:'limit',timeInForce:'post_only',
      posSide:'long',tradeSide:'close_long',holdMode,marginMode:'crossed',reduceOnly:hedged?'NO':'YES',updatedTime:now,
      feeDetail:[{feeCoin:'USDT',fee:'.008'}]};
  const trade=(id:string,qty:string,price:string,fee:string):any=>kind==='classic'?
    {tradeId:id,orderId:raw.orderId,symbol:raw.symbol,baseVolume:qty,price,side:'sell',posMode:'one_way_mode',tradeSide:'sell_single',tradeScope:'maker',
      feeDetail:[{feeCoin:'USDT',deduction:'no',totalDeductionFee:'0',totalFee:String(-Number(fee))}]}:
    {execId:id,orderId:raw.orderId,clientOid:raw.clientOid,category:raw.category,symbol:raw.symbol,execQty:qty,execPrice:price,
      side:'sell',orderType:'limit',tradeSide:'close_long',tradeScope:'maker',feeDetail:[{feeCoin:'USDT',fee}]};
  const first=trade('fill-1','.1','100.1','.002002'),second=trade('fill-2','.3','100.2','.006012');
  const pages:any[]=kind==='classic'?[{fillList:[first,second],endId:'fill-1'}]:[{list:[first,second],cursor:'fill-1'}];
  const calls:Array<{method:string;path:string;params:any}>=[];
  let page=0,createError=false,cancelled=false,createOrderId:string|null='offline-order';
  client.fetchImplementation=async(urlText:string,params:any)=>{
    const url=new URL(urlText),method=String(params.method),body=params.body??'',headers=new Headers(params.headers);
    assert.equal(url.hostname,'api.bitget.com');assert.ok(['GET','POST'].includes(method));
    const message=headers.get('ACCESS-TIMESTAMP')+method+url.pathname+decodeURIComponent(url.search)+body;
    assert.equal(headers.get('ACCESS-SIGN'),createHmac('sha256','offline-secret').update(message).digest('base64'));
    const query=method==='GET'?Object.fromEntries(url.searchParams):JSON.parse(body);
    calls.push({method,path:url.pathname,params:query});let data:any;
    switch(url.pathname){
      case '/api/v2/mix/account/account':data={marginCoin:'USDT',assetMode:'single',posMode:holdMode,marginMode:'isolated',isolatedLongLever:'2',isolatedShortLever:'2'};break;
      case '/api/v3/account/settings':data={accountMode:'unified',accountLevel:'basic',holdMode,assetMode:'multi_assets',deltaSwitch:'no',
        symbolConfigList:[{category:'USDT-FUTURES',symbol:'BTCUSDT',marginMode:'crossed',leverage:'2'}]};break;
      case '/api/v3/account/assets':data={accountEquity:'500',effEquity:'400',imr:'10',assets:[{coin:'USDT',equity:'500',available:'300',debt:'0'}]};break;
      case '/api/v2/mix/order/place-order':case '/api/v3/trade/place-order':
        if(createError)throw new Error('offline create transport failure');
        data={clientOid:raw.clientOid,orderId:createOrderId};break;
      case '/api/v2/mix/order/detail':case '/api/v3/trade/order-info':data=raw;break;
      case '/api/v2/mix/order/fills':data=pages[page++]??{fillList:[],endId:''};break;
      case '/api/v3/trade/fills':data=pages[page++]??{list:[],cursor:null};break;
      case '/api/v2/mix/order/cancel-order':case '/api/v3/trade/cancel-order':cancelled=true;data={orderId:raw.orderId};break;
      default:throw new Error(`Unexpected offline Maker route ${url.pathname}`);
    }
    return new Response(JSON.stringify({code:'00000',data}),{headers:{'content-type':'application/json'}});
  };
  return {client,adapter:kind==='classic'?new BitgetClassic(client):new BitgetUta(client),raw,first,second,pages,calls,trade,
    resetPages(){page=0;},setCreateError(){createError=true;},setNullOrderId(){createOrderId=null;},cancelled:()=>cancelled};
}
const creates=(f:ReturnType<typeof fixture>)=>f.calls.filter(c=>c.path.endsWith('/place-order'));
const oldResult=():OrderResult=>({...unknownOrder(request),id:'offline-order',filledQuantity:.2,averagePrice:100.15,feeUsd:.004006,
  timestamp:Date.now()-10,averagePriceVerified:true});

for(const kind of ['classic','uta'] as const){
  test(`${kind} a Maker permit revoked during native mode GET proves no POST and its original ID never replays`,async()=>{
    for(const throws of [false,true]){
      const f=fixture(kind),original=f.client.fetchImplementation;
      let release!:()=>void,entered!:()=>void,allowed=true;
      const barrier=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
      const path=kind==='classic'?'/api/v2/mix/account/account':'/api/v3/account/settings';
      f.client.fetchImplementation=async(urlText:string,params:any)=>{
        if(new URL(urlText).pathname===path){entered();await barrier;}
        return original(urlText,params);
      };
      const pending=f.adapter.placeMakerReduction(request,1,100,()=>{if(throws&&!allowed)throw new Error('offline revoked permission');return allowed;});
      // The result is expected to reject after the deferred native GET is released.
      const assertion=assert.rejects(pending,(error:any)=>error instanceof OrderNotSubmittedError&&error.rejectionCode==='MAKER_REDUCTION_PERMISSION_CHANGED');
      await started;allowed=false;release();await assertion;assert.equal(creates(f).length,0);
      await assert.rejects(f.adapter.placeMakerReduction(request,1,100,()=>true),(error:any)=>error instanceof OrderNotSubmittedError);
      assert.equal(creates(f).length,0);
    }
  });

  test(`${kind} dedicated Maker reduction sends one native PostOnly close without inspection or cancellation`,async()=>{
    const f=fixture(kind);await assert.rejects(f.adapter.place(request,1,100),/Maker trial/);
    assert.equal(await f.adapter.placeMakerReduction(request,1,100),'offline-order');
    const sent=creates(f)[0].params;assert.equal(creates(f).length,1);assert.equal(sent.side,'sell');assert.equal(sent.orderType,'limit');
    if(kind==='classic'){assert.equal(sent.force,'post_only');assert.equal(sent.reduceOnly,'YES');assert.equal(sent.size,'1');assert.equal(sent.marginMode,'isolated');}
    else{assert.equal(sent.timeInForce,'post_only');assert.equal(sent.reduceOnly,'yes');assert.equal(sent.qty,'1');assert.equal(sent.marginMode,'crossed');assert.equal(sent.posSide,undefined);}
    assert.equal(sent.clientOid,exchangeClientId('bitget',request.clientOrderId));
    assert.ok(!f.calls.some(c=>c.path.endsWith('/detail')||c.path.endsWith('/order-info')||c.path.includes('/fills')||c.path.endsWith('/cancel-order')));
    assert.equal(await f.adapter.placeMakerReduction({...request},1,100),'offline-order');assert.equal(creates(f).length,1);
    await assert.rejects(f.adapter.placeMakerReduction({...request,limitPrice:100.1},1,100.1),/client ID conflict/);assert.equal(creates(f).length,1);
  });

  test(`${kind} an uncertain Maker create or null native ID never replays the same request`,async()=>{
    const failure=fixture(kind);failure.setCreateError();await assert.rejects(failure.adapter.placeMakerReduction(request,1,100),/offline create/);
    assert.equal(await failure.adapter.placeMakerReduction(request,1,100),undefined);assert.equal(creates(failure).length,1);
    const empty=fixture(kind);empty.setNullOrderId();assert.equal(await empty.adapter.placeMakerReduction(request,1,100),undefined);
    assert.equal(await empty.adapter.placeMakerReduction(request,1,100),undefined);assert.equal(creates(empty).length,1);
    const observed=await empty.adapter.inspectMakerReduction(request);assert.equal(observed.executionVerified,true);
    assert.equal(empty.calls.find(c=>c.path.endsWith('/detail')||c.path.endsWith('/order-info'))?.params.clientOid,exchangeClientId('bitget',request.clientOrderId));
  });

  test(`${kind} active cumulative fills have exact cash while legacy status stays unknown and all observation calls are GET`,async()=>{
    const f=fixture(kind),observed=await f.adapter.inspectMakerReduction(request,undefined,'offline-order');
    assert.equal(observed.activity,'active');assert.equal(observed.executionVerified,true);assert.equal(observed.result.status,'unknown');
    assert.equal(observed.result.filledQuantity,.4);assert.equal(observed.result.averagePrice,(.1*100.1+.3*100.2)/.4);
    assert.equal(observed.result.feeUsd,.002002+.006012);assert.equal(observed.result.averagePriceVerified,true);
    assert.notEqual(observed.result.averagePrice,100);assert.ok(f.calls.every(c=>c.method==='GET'));
    const fills=f.calls.find(c=>c.path.endsWith('/fills'))!;assert.equal(fills.params.orderId,'offline-order');assert.equal(fills.params.limit,'100');
  });

  test(`${kind} overlapping short fill pages advance the native cursor and do not duplicate cash`,async()=>{
    const f=fixture(kind);f.pages.splice(0,1,...(kind==='classic'?[{fillList:[f.first],endId:'older'},{fillList:[f.first,f.second],endId:'last'}]:
      [{list:[f.first],cursor:'older'},{list:[f.first,f.second],cursor:'last'}]));
    const observed=await f.adapter.inspectMakerReduction(request);
    assert.equal(observed.executionVerified,true);assert.equal(observed.result.filledQuantity,.4);assert.equal(observed.result.feeUsd,.008014);
    assert.equal(f.calls.at(-1)?.params[kind==='classic'?'idLessThan':'cursor'],'older');assert.ok(f.calls.every(c=>c.method==='GET'));
  });

  test(`${kind} missing executions or unsupported fees preserve previous confirmed fills and cash`,async()=>{
    const variants=['empty','missing-price','bad-id','wrong-side','wrong-symbol','wrong-fee-coin','missing-fee','not-maker','conflict','overfill','cycle'] as const;
    for(const variant of variants){
      const f=fixture(kind),prior=oldResult(),saved=structuredClone(prior);
      if(variant==='empty')f.pages.splice(0,1,kind==='classic'?{fillList:[],endId:''}:{list:[],cursor:null});
      if(variant==='missing-price')f.first[kind==='classic'?'price':'execPrice']='';
      if(variant==='bad-id')f.first.orderId='wrong';
      if(variant==='wrong-side')f.first.side='buy';
      if(variant==='wrong-symbol')f.first.symbol='OTHERUSDT';
      if(variant==='wrong-fee-coin')f.first.feeDetail[0].feeCoin='BGB';
      if(variant==='missing-fee')f.first.feeDetail=[];
      if(variant==='not-maker')f.first.tradeScope='taker';
      if(variant==='conflict')f.pages[0][kind==='classic'?'fillList':'list'].push({...f.first,[kind==='classic'?'price':'execPrice']:'100.3'});
      if(variant==='overfill')f.first[kind==='classic'?'baseVolume':'execQty']='.3';
      if(variant==='cycle')f.pages.splice(0,1,...(kind==='classic'?[{fillList:[f.first],endId:'repeat'},{fillList:[f.first],endId:'repeat'}]:
        [{list:[f.first],cursor:'repeat'},{list:[f.first],cursor:'repeat'}]));
      const observed=await f.adapter.inspectMakerReduction(request,prior,'offline-order');
      assert.equal(observed.activity,'unknown',variant);assert.equal(observed.executionVerified,false,variant);
      assert.deepEqual(observed.result,{...saved,status:'unknown'},variant);assert.deepEqual(prior,saved);assert.ok(f.calls.every(c=>c.method==='GET'));
    }
  });

  test(`${kind} terminal cancellation reads late additional executions without discarding an earlier active fill`,async()=>{
    const f=fixture(kind),active=await f.adapter.inspectMakerReduction(request);
    await f.adapter.cancel(request.symbol,'offline-order');assert.equal(f.cancelled(),true);
    f.raw[kind==='classic'?'state':'orderStatus']=kind==='classic'?'canceled':'cancelled';
    f.raw[kind==='classic'?'baseVolume':'cumExecQty']='.6';
    const late=f.trade('late-fill','.2','100.3','.004012');
    f.pages[0][kind==='classic'?'fillList':'list'].push(late);f.resetPages();
    const final=await f.adapter.inspectMakerReduction(request,active.result,'offline-order');
    assert.equal(final.activity,'terminal');assert.equal(final.executionVerified,true);assert.equal(final.result.status,'partial');
    assert.equal(final.result.filledQuantity,.6);assert.equal(final.result.feeUsd,.012026);
    assert.equal(f.calls.filter(c=>c.path.endsWith('/cancel-order')).length,1);assert.equal(creates(f).length,0);
  });

  test(`${kind} fill races, backwards cumulative snapshots and wrong original IDs do not authorize a new close`,async()=>{
    const f=fixture(kind),prior=oldResult();f.raw[kind==='classic'?'baseVolume':'cumExecQty']='.1';
    assert.deepEqual((await f.adapter.inspectMakerReduction(request,prior)).result,{...prior,status:'unknown'});
    f.raw[kind==='classic'?'baseVolume':'cumExecQty']='.4';f.resetPages();
    f.pages[0][kind==='classic'?'fillList':'list'].push(f.trade('raced-fill','.2','100.3','.004012'));
    const raced=await f.adapter.inspectMakerReduction(request,prior);assert.equal(raced.executionVerified,false);assert.equal(raced.result.filledQuantity,.2);
    f.resetPages();const wrong=await f.adapter.inspectMakerReduction(request,prior,'another-order');assert.equal(wrong.activity,'unknown');
    assert.deepEqual(wrong.result,{...prior,status:'unknown'});assert.ok(f.calls.every(c=>c.method==='GET'));
  });

  test(`${kind} future timestamps, tighter native limits and contradictory summary fee currency reject execution proof`,async()=>{
    for(const variant of ['future','native-limit','summary-fee'] as const){
      const f=fixture(kind),prior=oldResult();
      if(variant==='future')f.raw[kind==='classic'?'uTime':'updatedTime']=String(Date.now()+10000);
      if(variant==='native-limit')f.raw.price='100.2';
      if(variant==='summary-fee')f.raw.feeDetail=kind==='classic'?[{feeCoin:'BGB',totalFee:'-.01'}]:[{feeCoin:'BGB',fee:'.01'}];
      const observed=await f.adapter.inspectMakerReduction(request,prior);
      assert.equal(observed.executionVerified,false,variant);assert.deepEqual(observed.result,{...prior,status:'unknown'},variant);
    }
  });

  test(`${kind} concurrent copies of one Maker request create only one native order`,async()=>{
    const f=fixture(kind);await Promise.all([f.adapter.placeMakerReduction(request,1,100),f.adapter.placeMakerReduction({...request},1,100)]);
    assert.equal(creates(f).length,1);assert.ok(!f.calls.some(c=>c.path.endsWith('/cancel-order')));
  });

  test(`${kind} zero-fill terminal orders need no fills and a Filled label with partial quantity is contradictory`,async()=>{
    const f=fixture(kind);f.raw[kind==='classic'?'baseVolume':'cumExecQty']='0';f.raw[kind==='classic'?'state':'orderStatus']=kind==='classic'?'canceled':'cancelled';
    if(kind==='classic')f.raw.fee='';else f.raw.feeDetail=[{feeCoin:'',fee:''}];
    const zero=await f.adapter.inspectMakerReduction(request);assert.equal(zero.activity,'terminal');assert.equal(zero.executionVerified,true);
    assert.equal(zero.result.status,'cancelled');assert.equal(zero.result.feeUsd,0);assert.ok(!f.calls.some(c=>c.path.endsWith('/fills')));
    f.raw[kind==='classic'?'baseVolume':'cumExecQty']='.4';f.raw[kind==='classic'?'state':'orderStatus']='filled';
    const bad=await f.adapter.inspectMakerReduction(request,oldResult());assert.equal(bad.executionVerified,false);assert.equal(bad.activity,'unknown');
  });

  test(`${kind} dedicated reduction rejects entry, imprecise quantity and unsupported exact close selectors`,async()=>{
    const f=fixture(kind);
    for(const change of [{reduceOnly:false},{postOnly:false},{quantity:0},{side:'invalid'},{base:'OTHER'},
      {closePosition:{side:'long',quantity:1}}]){
      await assert.rejects(f.adapter.placeMakerReduction({...request,...change} as OrderRequest,1,100));
    }
    await assert.rejects(f.adapter.placeMakerReduction({...request,quantity:1.01},1.01,100),/precision/);
    assert.equal(creates(f).length,0);
  });
}

test('UTA hedge Maker closes the selected long with sell + posSide and never sends a one-way reduceOnly flag',async()=>{
  const f=fixture('uta',true);assert.equal(await f.adapter.placeMakerReduction(request,1,100),'offline-order');
  const sent=creates(f)[0].params;assert.equal(sent.side,'sell');assert.equal(sent.posSide,'long');assert.equal(sent.reduceOnly,undefined);assert.equal(sent.timeInForce,'post_only');
  const observed=await f.adapter.inspectMakerReduction(request);assert.equal(observed.activity,'active');assert.equal(observed.executionVerified,true);
  f.raw.posSide='short';f.resetPages();assert.equal((await f.adapter.inspectMakerReduction(request,observed.result)).executionVerified,false);
});

test('Classic remains restricted to one-way mode and rejects hedge Maker reduction before creation',async()=>{
  const f=fixture('classic',true);await assert.rejects(f.adapter.placeMakerReduction(request,1,100),/one-way/);assert.equal(creates(f).length,0);
});

test('Classic discounted or inconsistent one-way execution evidence remains unknown',async()=>{
  for(const changed of [{deduction:'yes'},{totalDeductionFee:'-.001'},{totalDeductionFee:''}]){
    const f=fixture('classic');Object.assign(f.first.feeDetail[0],changed);
    assert.equal((await f.adapter.inspectMakerReduction(request,oldResult())).executionVerified,false);
  }
  const f=fixture('classic');f.first.tradeSide='open';assert.equal((await f.adapter.inspectMakerReduction(request)).executionVerified,false);
});
