import assert from 'node:assert/strict';
import test from 'node:test';
import {BybitPrivate} from '../src/adapters/bybit-private.js';
import {CcxtAdapter} from '../src/adapters/ccxt.js';
import {exchangeClientId,unknownOrder} from '../src/adapters/normalization.js';
import {defaultConfig} from '../src/shared/config.js';
import type {ExchangeId,OrderRequest,OrderResult} from '../src/shared/types.js';

const request:OrderRequest={clientOrderId:'offline-original-opening-proof',base:'ORCA',symbol:'ORCA/USDT:USDT',side:'buy',quantity:20.1,limitPrice:2.3104,reduceOnly:false};
const id='offline-original-opening-native',cash=46.4357,fee=.02553967;
const executionCash=[['2.2','2.3104','5.08288','.00279559'],['2.2','2.3104','5.08288','.00279559'],
  ['2.4','2.3104','5.54496','.00304973'],['2.2','2.3103','5.08266','.00279547'],
  ['2.2','2.3103','5.08266','.00279547'],['3.3','2.3102','7.62366','.00419302'],['5.6','2.31','12.936','.0071148']];
function fixture(){
  const market={id:'ORCAUSDT',symbol:request.symbol,base:request.base,quote:'USDT',settle:'USDT',active:true,swap:true,linear:true,
    contractSize:1,precision:{amount:.1,price:.0001},info:{priceFilter:{tickSize:'.0001'},lotSizeFilter:{qtyStep:'.1'}}};
  const records:any[]=executionCash.map(([qty,price,value,paidFee],index)=>({execId:`opening-${index}`,orderId:id,
    orderLinkId:exchangeClientId('bybit',request.clientOrderId),symbol:market.id,side:'Buy',orderType:'Limit',execType:'Trade',isMaker:false,
    execQty:qty,execPrice:price,execValue:value,execFee:paidFee,feeCurrency:'USDT',closedSize:'0',execTime:String(Date.now()),extraFees:''}));
  const raw:any={orderId:id,orderLinkId:exchangeClientId('bybit',request.clientOrderId),symbol:market.id,side:'Buy',positionIdx:0,
    reduceOnly:false,orderType:'Limit',timeInForce:'IOC',price:'2.3104',qty:'20.1',cumExecQty:'20.1',avgPrice:'2.31023383',cumExecValue:String(cash),
    cumFeeDetail:{USDT:String(fee)},extraFees:'',updatedTime:String(Date.now()),orderStatus:'Filled'};
  const events:string[]=[],queries:any[]=[],ok=(result:any)=>({retCode:0,result});
  let missing=false,pages:(cursor:string|undefined)=>any=()=>({category:'linear',list:structuredClone(records),nextPageCursor:''});
  const forbidden=async()=>{events.push('MUTATION');throw new Error('Offline opening proof rejects financial requests');};
  const client:any={apiKey:'OFFLINE',secret:'OFFLINE',precisionMode:4,markets:{[market.symbol]:market},market:()=>market,
    loadMarkets:async()=>{events.push('loadMarkets');return {[market.symbol]:market};},
    amountToPrecision:(_symbol:string,q:number)=>(Math.floor(q*10+1e-8)/10).toFixed(1),priceToPrecision:(_symbol:string,p:number)=>String(p),
    privateGetV5OrderRealtime:async(query:any)=>{events.push('order-get');queries.push(query);return ok({list:missing?[]:[structuredClone(raw)]});},
    privateGetV5OrderHistory:async(query:any)=>{events.push('history-get');queries.push(query);return ok({list:missing?[]:[structuredClone(raw)]});},
    privateGetV5ExecutionList:async(query:any)=>{events.push('execution-get');queries.push(query);return ok(pages(query.cursor));},
    privateGetV5AccountInfo:forbidden,privateGetV5PositionList:forbidden,privateGetV5AccountFeeRate:forbidden,
    privatePostV5OrderCreate:forbidden,privatePostV5OrderCancel:forbidden,privatePostV5PositionSetLeverage:forbidden,close:async()=>{},
  };
  const adapter=new CcxtAdapter('bybit',{...defaultConfig,mode:'live'},client),native=new BybitPrivate(client);
  return {adapter,native,client,market,raw,records,events,queries,pages:(fn:typeof pages)=>{pages=fn;},missing:()=>{missing=true;}};
}

test('an independent original opening GET proves exact native weighted cash without changing its rounded receipt or submitted cache',async t=>{
  const f=fixture();t.after(()=>f.adapter.close());const input=structuredClone(request),before=JSON.stringify(input),startedAt=Date.now();
  const rounded=await f.adapter.inspectOrder(input,id);assert.equal(rounded.averagePrice,2.31023383);
  const proven=await f.adapter.verifyOpeningExecution!(input,id);
  assert.equal(proven.status,'filled');assert.equal(proven.id,id);assert.equal(proven.filledQuantity,20.1);assert.equal(proven.feeUsd,fee);
  assert.equal(proven.averagePriceVerified,true);assert.ok(Math.abs(proven.averagePrice-2.310233830845772)<2e-15);
  assert.ok(proven.orderReadAt!>=startedAt&&proven.orderReadAt!<=Date.now());assert.equal(JSON.stringify(input),before);
  assert.equal((await f.adapter.inspectOrder(input,id)).averagePrice,rounded.averagePrice);
  assert.equal((f.adapter as any).submitted.size,0);assert.ok(f.events.every(event=>['loadMarkets','order-get','execution-get'].includes(event)));
});

test('a short opening has exact Sell identity and every real fill stays above the original native sell bound',async t=>{
  const f=fixture();t.after(()=>f.adapter.close());const sell={...request,side:'sell' as const,limitPrice:2.31};
  f.raw.side='Sell';f.raw.price='2.31';f.records.forEach(row=>{row.side='Sell';});
  const result=await f.adapter.verifyOpeningExecution!(sell,id);assert.equal(result.status,'filled');assert.equal(result.averagePriceVerified,true);
  f.records[0].execPrice='2.3099';f.records[0].execValue=String(Number(f.records[0].execQty)*2.3099);
  assert.equal((await f.adapter.verifyOpeningExecution!(sell,id)).status,'unknown');assert.ok(!f.events.includes('MUTATION'));
});

test('opening execution pages are fully drained after quantity coverage, with identical duplicate native IDs counted once',async t=>{
  const f=fixture();t.after(()=>f.adapter.close());
  f.pages(cursor=>cursor===undefined?{category:'linear',list:structuredClone(f.records),nextPageCursor:'second'}:
    cursor==='second'?{category:'linear',list:[structuredClone(f.records[0])],nextPageCursor:'final'}:
    {category:'linear',list:[],nextPageCursor:''});
  const result=await f.adapter.verifyOpeningExecution!(request,id);assert.equal(result.status,'filled');assert.equal(result.feeUsd,fee);
  assert.deepEqual(f.queries.filter(query=>'limit' in query).map(query=>query.cursor),[undefined,'second','final']);
  assert.ok(f.queries.every(query=>query.orderId===id));assert.ok(!f.events.includes('MUTATION'));
});

test('hundreds of original opening fills preserve exact decimal native value and positive fees minus real rebates',async t=>{
  const f=fixture();t.after(()=>f.adapter.close());const many={...request,quantity:30},seed={...f.records[0]};
  f.records.splice(0,f.records.length,...Array.from({length:300},(_value,index)=>({...seed,execId:`opening-small-${index}`,
    execQty:'.1',execPrice:'2.31',execValue:'.231',execFee:index%2?'.0002':'-.0001',closedSize:'0'})));
  Object.assign(f.raw,{qty:'30',cumExecQty:'30',avgPrice:'2.31',cumExecValue:'69.3',cumFeeDetail:{USDT:'.015'}});
  f.pages(cursor=>({category:'linear',list:f.records.slice(cursor?Number(cursor):0,(cursor?Number(cursor):0)+100),
    nextPageCursor:cursor==='200'?'':String((cursor?Number(cursor):0)+100)}));
  const result=await f.adapter.verifyOpeningExecution!(many,id);assert.equal(result.status,'filled');assert.equal(result.filledQuantity,30);
  assert.equal(result.averagePrice,2.31);assert.equal(result.feeUsd,.015);assert.equal(result.averagePriceVerified,true);
  assert.equal(f.events.filter(event=>event==='execution-get').length,3);assert.ok(!f.events.includes('MUTATION'));
});

test('a terminal partial opening proves only its actual native cash without creating or cancelling the unfilled request',async t=>{
  const f=fixture();t.after(()=>f.adapter.close());f.records.pop();
  const quantity=f.records.reduce((sum,row)=>sum+Number(row.execQty),0),value=f.records.reduce((sum,row)=>sum+Number(row.execValue),0),paid=f.records.reduce((sum,row)=>sum+Number(row.execFee),0);
  Object.assign(f.raw,{orderStatus:'PartiallyFilledCanceled',cumExecQty:String(quantity),cumExecValue:String(value),cumFeeDetail:{USDT:String(paid)},avgPrice:(value/quantity).toFixed(8)});
  const result=await f.adapter.verifyOpeningExecution!(request,id);assert.equal(result.status,'partial');assert.equal(result.filledQuantity,14.5);
  assert.equal(result.averagePrice,value/quantity);assert.equal(result.feeUsd,paid);assert.equal(result.averagePriceVerified,true);
  assert.ok(!f.events.includes('MUTATION'));
});

test('zero terminal opening preserves explicit native cash checks without calling CCXT zero amount precision',async t=>{
  const f=fixture();t.after(()=>f.adapter.close());Object.assign(f.raw,{orderStatus:'Cancelled',cumExecQty:'0',cumExecValue:'0',avgPrice:'',cumFeeDetail:{}});
  const amountToPrecision=f.client.amountToPrecision.bind(f.client);let zeroPrecisionCalls=0;
  f.client.amountToPrecision=(symbol:string,quantity:number)=>{
    if(quantity===0){zeroPrecisionCalls++;throw new Error('InvalidOrder: amount of ORCA/USDT:USDT must be greater than minimum amount precision');}
    return amountToPrecision(symbol,quantity);
  };
  const result=await f.adapter.verifyOpeningExecution!(request,id);assert.equal(result.status,'cancelled');assert.equal(result.filledQuantity,0);
  assert.equal(result.averagePrice,0);assert.equal(result.feeUsd,0);assert.equal(result.averagePriceVerified,true);
  for(const patch of [{avgPrice:'1'},{cumExecValue:undefined},{cumExecValue:'.01'},{cumFeeDetail:undefined},{cumFeeDetail:{USDT:'.01'}},{extraFees:'[{}]'}]){
    const original=structuredClone(f.raw);Object.assign(f.raw,patch);
    assert.equal((await f.adapter.verifyOpeningExecution!(request,id)).status,'unknown');Object.assign(f.raw,original);
  }
  assert.equal(zeroPrecisionCalls,0);assert.ok(!f.events.includes('execution-get'));assert.ok(!f.events.includes('MUTATION'));
});

for(const [field,value] of Object.entries({execId:' ',orderId:'other',orderLinkId:'other',symbol:'OTHERUSDT',side:'Sell',orderType:'Market',
  execType:'Funding',isMaker:true,feeCurrency:'BTC',extraFees:'[{"coin":"USDT","fee":".01"}]',closedSize:'2.2',execQty:'2.25',execPrice:'2.3105',
  execValue:'0',execFee:undefined,execTime:'0'})){
  test(`invalid original opening native ${field} cannot mint verified cash or replace the saved lower bound`,async t=>{
    const f=fixture();t.after(()=>f.adapter.close());f.records[0][field]=value;
    const prior:OrderResult={...unknownOrder(request,id),filledQuantity:1,averagePrice:2.31,feeUsd:.001,averagePriceVerified:true},before=structuredClone(prior);
    const result=await f.native.verifyOpeningExecution(request,prior,id);assert.equal(result.status,'unknown');assert.equal(result.id,id);
    assert.equal(result.filledQuantity,1);assert.equal(result.averagePrice,2.31);assert.equal(result.feeUsd,.001);assert.deepEqual(prior,before);
    assert.ok(!f.events.includes('MUTATION'));
  });
}

test('closedSize must be exactly zero for opening, including tiny nonzero, negative and absent native fields',async t=>{
  for(const value of ['.00000000000000001','-.00000000000000001','-1',undefined,'']){
    const f=fixture();t.after(()=>f.adapter.close());f.records[0].closedSize=value;
    assert.equal((await f.adapter.verifyOpeningExecution!(request,id)).status,'unknown');assert.ok(!f.events.includes('MUTATION'));
  }
});

test('conflicting duplicate opening executions, incomplete pages and any mismatch with summary totals preserve uncertainty',async t=>{
  for(const scenario of ['conflict','missing','overflow','cycle','empty-cursor','failed','category','value','fee'] as const){
    const f=fixture();t.after(()=>f.adapter.close());
    f.pages(cursor=>{
      if(scenario==='failed')throw new Error('Offline execution read failed');
      if(scenario==='conflict')return {category:'linear',list:cursor?[{...f.records[0],execFee:'.1'}]:f.records,nextPageCursor:cursor?'':'again'};
      return {category:scenario==='category'?'inverse':'linear',list:scenario==='missing'?f.records.slice(1):scenario==='empty-cursor'?[]:
        scenario==='overflow'?[...f.records,{...f.records[0],execId:'overflow'}]:f.records,nextPageCursor:scenario==='cycle'||scenario==='empty-cursor'?'same':''};
    });
    if(scenario==='value')f.raw.cumExecValue=String(cash+.000001);
    if(scenario==='fee')f.raw.cumFeeDetail={USDT:String(fee+.000001)};
    assert.equal((await f.adapter.verifyOpeningExecution!(request,id)).status,'unknown',scenario);
    assert.ok(f.events.filter(event=>event==='execution-get').length<=2);assert.ok(!f.events.includes('MUTATION'));
  }
});

test('nonterminal, foreign and incomplete native opening order summaries fail before execution-list GETs',async t=>{
  for(const patch of [{orderStatus:'New'},{orderStatus:'PartiallyFilled'},{orderId:'other'},{orderLinkId:'other'},
    {reduceOnly:true},{timeInForce:'PostOnly'},{positionIdx:2},{side:'Sell'},{price:'2.3105'},{qty:'20.2'},{cumExecQty:'20.2'},
    {cumExecValue:undefined},{cumFeeDetail:undefined},{cumFeeDetail:{BTC:String(fee)}},{extraFees:'[{}]'}]){
    const f=fixture();t.after(()=>f.adapter.close());Object.assign(f.raw,patch);
    assert.equal((await f.adapter.verifyOpeningExecution!(request,id)).status,'unknown');assert.ok(!f.events.includes('execution-get'));
    assert.ok(!f.events.includes('MUTATION'));
  }
  const f=fixture();t.after(()=>f.adapter.close());f.missing();assert.equal((await f.adapter.verifyOpeningExecution!(request,id)).status,'unknown');
  assert.ok(f.events.includes('history-get'));assert.ok(!f.events.includes('execution-get'));
});

test('new opening and unchanged reduction proof permissions remain disjoint before any network read',async t=>{
  for(const bad of [{...request,reduceOnly:true},{...request,reduceOnly:undefined},{...request,postOnly:true},{...request,closePosition:{positionIdx:0}}] as OrderRequest[]){
    const f=fixture();t.after(()=>f.adapter.close());
    await assert.rejects(f.native.verifyOpeningExecution(bad,unknownOrder(bad,id),id),/only supports/);
    await assert.rejects(f.adapter.verifyOpeningExecution!(bad,id),/only supports/);assert.deepEqual(f.events,[]);
  }
  const f=fixture();t.after(()=>f.adapter.close());
  await assert.rejects(f.native.verifyOrderExecution(request,unknownOrder(request,id),id),/only supports/);
  await assert.rejects(f.adapter.verifyOrderExecution(request,id),/only supports/);assert.deepEqual(f.events,[]);
});

test('missing original ID, conflicting native ID and a reused request cannot start an opening proof GET',async t=>{
  const f=fixture();t.after(()=>f.adapter.close());
  await assert.rejects(f.adapter.verifyOpeningExecution!(request,''),/original native ID/);assert.deepEqual(f.events,[]);
  const prior={...unknownOrder(request,id),filledQuantity:1,averagePrice:2.31,feeUsd:.001};
  assert.equal((await f.native.verifyOpeningExecution(request,prior,'other')).status,'unknown');assert.deepEqual(f.events,[]);
  const submitted=(f.adapter as any).submitted;submitted.set(request.clientOrderId,{request:JSON.stringify(request),result:structuredClone(prior)});
  await assert.rejects(f.adapter.verifyOpeningExecution!(request,'other'),/native ID changed/);
  await assert.rejects(f.adapter.verifyOpeningExecution!({...request,quantity:30},id),/different order details/);
  assert.deepEqual(f.events,[]);assert.deepEqual(submitted.get(request.clientOrderId).result,prior);
});

test('other venues do not advertise the optional native opening proof and cannot acquire a Bybit capability by fallback',async t=>{
  const f=fixture();t.after(()=>f.adapter.close());
  for(const exchange of ['gate','bitget','binance','okx'] as ExchangeId[]){
    const adapter=new CcxtAdapter(exchange,{...defaultConfig,mode:'live'},f.client);t.after(()=>adapter.close());
    assert.equal(adapter.verifyOpeningExecution,undefined);
  }
  assert.deepEqual(f.events,[]);
});
