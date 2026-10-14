import assert from 'node:assert/strict';
import test from 'node:test';
import {BybitPrivate} from '../src/adapters/bybit-private.js';
import {CcxtAdapter} from '../src/adapters/ccxt.js';
import {exchangeClientId,unknownOrder} from '../src/adapters/normalization.js';
import {defaultConfig} from '../src/shared/config.js';
import type {OrderRequest} from '../src/shared/types.js';

const request:OrderRequest={clientOrderId:'offline-orca-ioc-proof',base:'ORCA',symbol:'ORCA/USDT:USDT',side:'buy',quantity:20.1,limitPrice:2.3104,reduceOnly:true};
const id='offline-native-orca-ioc',cash=46.4357,fee=.02553967;
const executionCash=[['2.2','2.3104','5.08288','.00279559'],['2.2','2.3104','5.08288','.00279559'],
  ['2.4','2.3104','5.54496','.00304973'],['2.2','2.3103','5.08266','.00279547'],
  ['2.2','2.3103','5.08266','.00279547'],['3.3','2.3102','7.62366','.00419302'],['5.6','2.31','12.936','.0071148']];
function fixture(){
  const market={id:'ORCAUSDT',symbol:request.symbol,base:'ORCA',quote:'USDT',settle:'USDT',active:true,swap:true,linear:true,
    contractSize:1,precision:{amount:.1,price:.0001},info:{priceFilter:{tickSize:'.0001'},lotSizeFilter:{qtyStep:'.1'}}};
  const records:any[]=executionCash.map(([qty,price,value,paidFee],index)=>({execId:`fill-${index}`,orderId:id,
    orderLinkId:exchangeClientId('bybit',request.clientOrderId),symbol:market.id,side:'Buy',orderType:'Limit',execType:'Trade',isMaker:false,
    execQty:qty,execPrice:price,execValue:value,execFee:paidFee,feeCurrency:'USDT',closedSize:qty,execTime:String(Date.now()),extraFees:''}));
  const raw:any={orderId:id,orderLinkId:exchangeClientId('bybit',request.clientOrderId),symbol:market.id,side:'Buy',positionIdx:0,
    reduceOnly:true,orderType:'Limit',timeInForce:'IOC',price:'2.3104',qty:'20.1',cumExecQty:'20.1',avgPrice:'2.31023383',cumExecValue:String(cash),
    cumFeeDetail:{USDT:String(fee)},extraFees:'',updatedTime:String(Date.now()),orderStatus:'Filled'};
  const events:string[]=[],queries:any[]=[],ok=(result:any)=>({retCode:0,result});
  let orderMissing=false,pages:(cursor:string|undefined)=>any=()=>({category:'linear',list:structuredClone(records),nextPageCursor:''});
  const forbidden=async()=>{events.push('MUTATION');throw new Error('This fixture rejects every mutation');};
  const client:any={apiKey:'OFFLINE',secret:'OFFLINE',precisionMode:4,markets:{[market.symbol]:market},market:()=>market,
    loadMarkets:async()=>{events.push('loadMarkets');return {[market.symbol]:market};},
    amountToPrecision:(_s:string,q:number)=>(Math.floor(q*10+1e-8)/10).toFixed(1),priceToPrecision:(_s:string,p:number)=>String(p),
    privateGetV5OrderRealtime:async(query:any)=>{events.push('order-get');queries.push(query);return ok({list:orderMissing?[]:[structuredClone(raw)]});},
    privateGetV5OrderHistory:async(query:any)=>{events.push('history-get');queries.push(query);return ok({list:orderMissing?[]:[structuredClone(raw)]});},
    privateGetV5ExecutionList:async(query:any)=>{events.push('execution-get');queries.push(query);return ok(pages(query.cursor));},
    privateGetV5AccountInfo:forbidden,privateGetV5PositionList:forbidden,privateGetV5AccountFeeRate:forbidden,
    privatePostV5OrderCreate:forbidden,privatePostV5OrderCancel:forbidden,privatePostV5PositionSetLeverage:forbidden,close:async()=>{},
  };
  const adapter=new CcxtAdapter('bybit',{...defaultConfig,mode:'live'},client),native=new BybitPrivate(client);
  return {adapter,native,client,market,raw,records,events,queries,pages:(fn:typeof pages)=>{pages=fn;},missing:()=>{orderMissing=true;}};
}

test('complete Bybit IOC execution cash restores the real 20.1 weighted average while ordinary inspection remains a rounded GET',async t=>{
  const f=fixture();t.after(()=>f.adapter.close());const input=structuredClone(request),before=JSON.stringify(input),startedAt=Date.now();
  const summary=await f.adapter.inspectOrder(input,id);assert.equal(summary.averagePrice,2.31023383);
  const proven=await f.adapter.verifyOrderExecution(input,id);
  assert.equal(proven.id,id);assert.equal(proven.clientOrderId,request.clientOrderId);assert.equal(proven.status,'filled');
  assert.equal(proven.filledQuantity,20.1);assert.equal(proven.feeUsd,fee);assert.equal(proven.averagePriceVerified,true);
  assert.ok(Math.abs(proven.averagePrice-2.310233830845772)<2e-15);
  assert.ok(proven.orderReadAt!>=startedAt&&proven.orderReadAt!<=Date.now());assert.equal(JSON.stringify(input),before);
  assert.equal((await f.adapter.inspectOrder(input,id)).averagePrice,2.31023383,'complete verification does not replace a submitted-order cache');
  assert.equal(f.events.filter(event=>event==='execution-get').length,1);
  assert.ok(f.events.every(event=>['loadMarkets','order-get','execution-get'].includes(event)));
});

test('Bybit execution proof follows pagination after quantity coverage, ignores identical duplicates and requires its final page',async t=>{
  const f=fixture();t.after(()=>f.adapter.close());
  f.pages(cursor=>cursor===undefined?{category:'linear',list:structuredClone(f.records),nextPageCursor:'second'}:
    cursor==='second'?{category:'linear',list:[structuredClone(f.records[0])],nextPageCursor:'last'}:
    {category:'linear',list:[],nextPageCursor:''});
  const result=await f.adapter.verifyOrderExecution(request,id);
  assert.equal(result.status,'filled');assert.equal(result.filledQuantity,20.1);assert.equal(result.feeUsd,fee);
  assert.deepEqual(f.queries.filter(query=>'limit' in query).map(query=>query.cursor),[undefined,'second','last']);
  assert.ok(f.queries.filter(query=>'limit' in query).every(query=>query.orderId===id&&query.category==='linear'));
});

test('hundreds of legal IOC fills preserve native decimal cash under the same strict quantity and fee comparisons',async t=>{
  const f=fixture();t.after(()=>f.adapter.close());const many={...request,quantity:30};
  f.records.splice(0,f.records.length,...Array.from({length:300},(_value,index)=>({...f.records[0],execId:`small-${index}`,
    execQty:'.1',execPrice:'2.31',execValue:'.231',execFee:index%2?'.0002':'-.0001',closedSize:'.1'})));
  Object.assign(f.raw,{qty:'30',cumExecQty:'30',avgPrice:'2.31',cumExecValue:'69.3',cumFeeDetail:{USDT:'.015'}});
  f.pages(cursor=>({category:'linear',list:f.records.slice(cursor?Number(cursor):0,(cursor?Number(cursor):0)+100),
    nextPageCursor:cursor==='200'?'':String((cursor?Number(cursor):0)+100)}));
  const result=await f.adapter.verifyOrderExecution(many,id);
  assert.equal(result.status,'filled');assert.equal(result.filledQuantity,30);assert.equal(result.averagePrice,2.31);
  assert.equal(result.feeUsd,.015);assert.equal(result.averagePriceVerified,true);
  assert.equal(f.events.filter(event=>event==='execution-get').length,3);assert.ok(!f.events.includes('MUTATION'));
});

test('Bybit precise partial IOC cash is confirmed without requesting or canceling its unfilled remainder',async t=>{
  const f=fixture();t.after(()=>f.adapter.close());f.records.pop();
  const q=f.records.reduce((sum,row)=>sum+Number(row.execQty),0),value=f.records.reduce((sum,row)=>sum+Number(row.execValue),0),paid=f.records.reduce((sum,row)=>sum+Number(row.execFee),0);
  Object.assign(f.raw,{orderStatus:'PartiallyFilledCanceled',cumExecQty:String(q),cumExecValue:String(value),cumFeeDetail:{USDT:String(paid)},avgPrice:(value/q).toFixed(8)});
  const result=await f.adapter.verifyOrderExecution(request,id);
  assert.equal(result.status,'partial');assert.equal(result.filledQuantity,14.5);assert.equal(result.averagePrice,value/q);
  assert.equal(result.feeUsd,paid);assert.equal(result.averagePriceVerified,true);assert.ok(!f.events.includes('MUTATION'));
});

test('a confirmed zero IOC is a fresh zero-cash GET and does not query executions',async t=>{
  const f=fixture();t.after(()=>f.adapter.close());Object.assign(f.raw,{orderStatus:'Cancelled',cumExecQty:'0',cumExecValue:'0',avgPrice:'',cumFeeDetail:{}});
  const result=await f.adapter.verifyOrderExecution(request,id);
  assert.equal(result.status,'cancelled');assert.equal(result.filledQuantity,0);assert.equal(result.averagePrice,0);
  assert.equal(result.feeUsd,0);assert.equal(result.averagePriceVerified,true);assert.ok(result.orderReadAt!>0);
  assert.ok(!f.events.includes('execution-get'));assert.ok(!f.events.includes('MUTATION'));
});

for(const [field,value] of Object.entries({orderId:'other',orderLinkId:'other',symbol:'OTHERUSDT',side:'Sell',orderType:'Market',
  execType:'Funding',isMaker:true,feeCurrency:'BTC',extraFees:'[{"coin":"USDT","fee":".01"}]',closedSize:'0',execQty:'2.25',execPrice:'2.3105',
  execValue:'0',execFee:undefined,execTime:'0'})){
  test(`a Bybit IOC execution with invalid ${field} retains uncertainty and never obtains verified cash`,async t=>{
    const f=fixture();t.after(()=>f.adapter.close());f.records[0][field]=value;
    const prior={...unknownOrder(request,id),filledQuantity:1,averagePrice:2.31,feeUsd:.001,averagePriceVerified:true},before=structuredClone(prior);
    const result=await f.native.verifyOrderExecution(request,prior,id);
    assert.equal(result.status,'unknown');assert.equal(result.id,id);assert.equal(result.filledQuantity,1);
    assert.equal(result.averagePrice,2.31);assert.equal(result.feeUsd,.001);assert.deepEqual(prior,before);
    assert.ok(!f.events.includes('MUTATION'));
  });
}

test('conflicting duplicate Bybit executions cannot hide changed native cash behind an already complete quantity',async t=>{
  const f=fixture();t.after(()=>f.adapter.close());
  f.pages(cursor=>cursor===undefined?{category:'linear',list:structuredClone(f.records),nextPageCursor:'again'}:
    {category:'linear',list:[{...f.records[0],execFee:'.1'}],nextPageCursor:''});
  const result=await f.adapter.verifyOrderExecution(request,id);assert.equal(result.status,'unknown');
  assert.ok(!f.events.includes('MUTATION'));
});

test('missing, overflowing, failed and cyclic execution pages cannot prove terminal Bybit IOC cash',async t=>{
  for(const variant of ['missing','overflow','cycle','empty-cursor','failed','wrong-category'] as const){
    const f=fixture();t.after(()=>f.adapter.close());
    f.pages(()=>{
      if(variant==='failed')throw new Error('OFFLINE GET failure');
      return {category:variant==='wrong-category'?'inverse':'linear',list:variant==='missing'?f.records.slice(1):variant==='empty-cursor'?[]:
        variant==='overflow'?[...f.records,{...f.records[0],execId:'extra'}]:f.records,nextPageCursor:variant==='cycle'||variant==='empty-cursor'?'same':''};
    });
    const result=await f.adapter.verifyOrderExecution(request,id);assert.equal(result.status,'unknown',variant);
    assert.ok(!f.events.includes('MUTATION'));assert.ok(f.events.filter(event=>event==='execution-get').length<=2);
  }
});

test('missing or different summary fees, extra fees and native cumulative value never borrow paid cash from the prior receipt',async t=>{
  for(const patch of [{cumFeeDetail:undefined},{cumFeeDetail:{USDT:'0'}},{cumFeeDetail:{BTC:String(fee)}},{extraFees:'[{}]'},{cumExecValue:'46.4'}]){
    const f=fixture();t.after(()=>f.adapter.close());Object.assign(f.raw,patch);
    const prior={...unknownOrder(request,id),feeUsd:fee};
    const result=await f.native.verifyOrderExecution(request,prior,id);assert.equal(result.status,'unknown');assert.ok(!f.events.includes('MUTATION'));
  }
});

test('native nonterminal, absent and wrong original IOC identity fail before independent execution GETs',async t=>{
  for(const patch of [{orderStatus:'New'},{orderStatus:'PartiallyFilled'},{orderId:'other'},{orderLinkId:'other'},
    {reduceOnly:false},{timeInForce:'PostOnly'},{side:'Sell'},{price:'2.3105'},{qty:'20.2'},{cumExecQty:'20.2'}]){
    const f=fixture();t.after(()=>f.adapter.close());Object.assign(f.raw,patch);
    const result=await f.adapter.verifyOrderExecution(request,id);assert.equal(result.status,'unknown');
    assert.ok(!f.events.includes('execution-get'));assert.ok(!f.events.includes('MUTATION'));
  }
  const f=fixture();t.after(()=>f.adapter.close());f.missing();const missing=await f.adapter.verifyOrderExecution(request,id);
  assert.equal(missing.status,'unknown');assert.ok(f.events.includes('history-get'));assert.ok(!f.events.includes('execution-get'));
});

test('entry, PostOnly and special close selectors cannot enter the Bybit IOC execution-proof route or make a GET',async t=>{
  for(const bad of [{...request,reduceOnly:false},{...request,postOnly:true},{...request,closePosition:{positionIdx:0}}] as OrderRequest[]){
    const f=fixture();t.after(()=>f.adapter.close());
    await assert.rejects(f.native.verifyOrderExecution(bad,unknownOrder(bad,id),id),/only supports/);
    await assert.rejects(f.adapter.verifyOrderExecution(bad,id),/only supports/);assert.deepEqual(f.events,[]);
  }
});

test('the unchanged Bybit Maker proof still requires Maker executions and the new IOC proof cannot consume them',async t=>{
  const f=fixture();t.after(()=>f.adapter.close());const maker={...request,postOnly:true};f.raw.timeInForce='PostOnly';
  f.records.forEach(row=>{row.isMaker=true;});
  const verified=await f.native.inspectMakerReduction(maker,unknownOrder(maker,id),id);
  assert.equal(verified.executionVerified,true);assert.equal(verified.activity,'terminal');assert.equal(verified.result.averagePriceVerified,true);
  f.records[0].isMaker=false;const refused=await f.native.inspectMakerReduction(maker,unknownOrder(maker,id),id);
  assert.equal(refused.executionVerified,false);assert.equal(refused.activity,'unknown');assert.ok(!f.events.includes('MUTATION'));
});
