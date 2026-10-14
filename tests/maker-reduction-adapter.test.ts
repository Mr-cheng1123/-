import test from 'node:test';
import assert from 'node:assert/strict';
import {CcxtAdapter} from '../src/adapters/ccxt.js';
import {GatePrivate} from '../src/adapters/gate-private.js';
import {BybitPrivate} from '../src/adapters/bybit-private.js';
import {exchangeClientId,unknownOrder} from '../src/adapters/normalization.js';
import {defaultConfig} from '../src/shared/config.js';
import type {OrderRequest} from '../src/shared/types.js';

const request:OrderRequest={clientOrderId:'offline-maker-reduction',base:'CT',symbol:'CT/USDT:USDT',side:'sell',quantity:10,limitPrice:11,reduceOnly:true,postOnly:true};
function fixture(venue:'gate'|'bybit'){
  const market={id:venue==='gate'?'CT_USDT':'CTUSDT',symbol:request.symbol,base:'CT',quote:'USDT',settle:'USDT',active:true,swap:true,linear:true,
    contractSize:venue==='gate'?2:1,precision:{amount:1,price:.01},limits:{amount:{min:1},cost:{min:1000}}};
  const nativeClient=exchangeClientId(venue,request.clientOrderId),posted:any[]=[],queries:any[]=[],cancelled:any[]=[];
  let filled=2,terminal=false,failReads=false,failPost=false,wrongIdentity=false,fillPatch:any={},rawPatch:any={},held=10;
  const time=()=>String(Date.now());
  const raw=()=>venue==='gate'?{id:'10001',contract:market.id,size:'-5',left:String(-(10-filled)/2),price:'11',fill_price:filled?'11':'0',
    tif:'poc',text:wrongIdentity?'another-client':nativeClient,is_reduce_only:true,is_close:false,status:terminal?'finished':'open',
    ...(terminal?{finish_as:filled===request.quantity?'filled':'cancelled'}:{}),create_time_ms:time(),...rawPatch}:
    {orderId:'10001',symbol:market.id,orderLinkId:wrongIdentity?'another-client':nativeClient,side:'Sell',positionIdx:0,reduceOnly:true,orderType:'Limit',timeInForce:'PostOnly',
      price:'11',qty:'10',cumExecQty:String(filled),avgPrice:filled?'11':'',updatedTime:time(),cumFeeDetail:{USDT:'.001'},extraFees:'',orderStatus:terminal?'Cancelled':filled?'PartiallyFilled':'New',...rawPatch};
  const fills=()=>filled===0?[]:[venue==='gate'?{id:'501',order_id:'10001',contract:market.id,size:String(-filled/2),close_size:String(-filled/2),price:'11',fee:'.001',point_fee:'0',fee_currency:'USDT',...fillPatch}:
    {execId:'501',orderId:'10001',orderLinkId:nativeClient,symbol:market.id,side:'Sell',orderType:'Limit',execType:'Trade',isMaker:true,
      execQty:String(filled),execPrice:'11',execFee:'.001',closedSize:String(filled),feeCurrency:'USDT',extraFees:'',execTime:time(),...fillPatch}];
  const read=async(params:any)=>{queries.push(params);if(failReads)throw new Error('offline read failure');return raw();};
  const create=async(payload:any)=>{posted.push(payload);if(failPost)throw new Error('offline ambiguous POST');return {id:'10001',orderId:'10001'};};
  const client:any={apiKey:'offline-key',secret:'offline-secret',password:'offline-passphrase',precisionMode:4,markets:{[market.symbol]:market},
    market:()=>market,loadMarkets:async()=>({[market.symbol]:market}),amountToPrecision:(_s:string,x:number|string)=>String(x),priceToPrecision:(_s:string,x:number)=>String(x),
    privateFuturesGetSettleAccounts:async()=>({currency:'USDT',available:'100',total:'100',unrealised_pnl:'0',position_mode:'single',margin_mode:0}),
    privateFuturesGetSettlePositions:async()=>[{contract:market.id,size:String(held/2),mode:'single',leverage:'2'}],
    privateFuturesPostSettleOrders:create,privateFuturesGetSettleOrdersOrderId:read,
    privateFuturesGetSettleMyTrades:async(params:any)=>{queries.push(params);return fills();},
    privateFuturesDeleteSettleOrdersOrderId:async(params:any)=>{cancelled.push(params);},
    privateGetV5AccountInfo:async()=>({retCode:0,result:{unifiedMarginStatus:5,marginMode:'REGULAR_MARGIN'}}),
    privateGetV5PositionList:async()=>({retCode:0,result:{list:[{symbol:market.id,size:String(held),positionIdx:0,side:'Buy',leverage:'2'}]}}),
    privatePostV5OrderCreate:async(payload:any)=>({retCode:0,result:await create(payload)}),
    privateGetV5OrderRealtime:async(params:any)=>({retCode:0,result:{list:[await read(params)]}}),
    privateGetV5OrderHistory:async(params:any)=>({retCode:0,result:{list:[await read(params)]}}),
    privateGetV5ExecutionList:async(params:any)=>{queries.push(params);return {retCode:0,result:{category:'linear',list:fills(),nextPageCursor:''}};},
    privatePostV5OrderCancel:async(params:any)=>{cancelled.push(params);return {retCode:0,result:{orderId:'10001'}};},close:async()=>{},
  };
  const adapter=new CcxtAdapter(venue,{...defaultConfig,mode:'live',dataSource:'public'},client);
  return {adapter,client,posted,queries,cancelled,native:venue==='gate'?new GatePrivate(client):new BybitPrivate(client),
    filled:(value:number)=>{filled=value;},terminal:()=>{terminal=true;},failReads:()=>{failReads=true;},failPost:()=>{failPost=true;},
    wrongIdentity:()=>{wrongIdentity=true;},patchFill:(patch:any)=>{fillPatch=patch;},patchRaw:(patch:any)=>{rawPatch=patch;},held:(value:number)=>{held=value;}};
}

test('supervised Maker reduction posts the exact native selectors and returns an ACK without any execution wait or cancel',async()=>{
  for(const venue of ['gate','bybit'] as const){const f=fixture(venue);try{
    await f.adapter.validateMakerReduction(request);assert.equal(f.posted.length,0);
    const ack=await f.adapter.submitMakerReduction(request);
    assert.equal(ack.id,'10001');assert.equal(ack.status,'unknown');assert.equal(ack.filledQuantity,0);
    assert.equal(f.posted.length,1);assert.equal(f.queries.length,0);assert.equal(f.cancelled.length,0);
    if(venue==='gate'){assert.equal(f.posted[0].tif,'poc');assert.equal(f.posted[0].reduce_only,true);assert.equal(f.posted[0].size,'-5');}
    else{assert.equal(f.posted[0].timeInForce,'PostOnly');assert.equal(f.posted[0].reduceOnly,true);assert.equal(f.posted[0].positionIdx,0);assert.equal(f.posted[0].qty,'10');}
  }finally{await f.adapter.close();}}
});

test('ordinary placeOrder still refuses Maker reductions and other venues cannot use the new controlled route',async()=>{
  for(const venue of ['gate','bybit'] as const){const f=fixture(venue);try{
    const refused=await f.adapter.placeOrder(request);assert.equal(refused.status,'cancelled');assert.equal(refused.rejectionCode,'INVALID_MAKER_ORDER');assert.equal(f.posted.length,0);
    await assert.rejects(f.native.place(request,venue==='gate'?5:10,11));assert.equal(f.posted.length,0);
  }finally{await f.adapter.close();}}
  const f=fixture('gate'),unsupported=new CcxtAdapter('binance',{...defaultConfig,mode:'live'},f.client);
  try{assert.equal(unsupported.supportsMakerReduction(),false);assert.equal((await unsupported.submitMakerReduction(request)).rejectionCode,'INVALID_MAKER_ORDER');assert.equal(f.posted.length,0);}
  finally{await unsupported.close();await f.adapter.close();}
});

test('same-ID Maker create ACK and ambiguous transport never replay, inspect, or cancel implicitly',async()=>{
  for(const venue of ['gate','bybit'] as const)for(const ambiguous of [false,true]){const f=fixture(venue);try{
    if(ambiguous)f.failPost();const first=await f.adapter.submitMakerReduction(request),again=await f.adapter.submitMakerReduction(request);
    assert.deepEqual(again,first);assert.equal(f.posted.length,1);assert.equal(f.queries.length,0);assert.equal(f.cancelled.length,0);
    await assert.rejects(f.adapter.submitMakerReduction({...request,quantity:8}),/reused/);assert.equal(f.posted.length,1);
  }finally{await f.adapter.close();}}
});

test('active Maker partials expose only complete verified cumulative fills, retain unknown legacy status, and never cancel on GET',async()=>{
  for(const venue of ['gate','bybit'] as const){const f=fixture(venue);try{
    await f.adapter.submitMakerReduction(request);const first=await f.adapter.inspectMakerReduction(request,'10001');
    assert.equal(first.activity,'active');assert.equal(first.executionVerified,true);assert.equal(first.result.status,'unknown');assert.equal(first.result.filledQuantity,2);
    assert.equal(first.result.averagePriceVerified,true);assert.equal(first.result.averagePrice,11);assert.equal(first.result.feeUsd,.001);
    f.filled(4);const next=await f.adapter.inspectMakerReduction(request);assert.equal(next.result.filledQuantity,4);assert.equal(next.executionVerified,true);assert.equal(f.cancelled.length,0);
    f.filled(2);const regressive=await f.adapter.inspectMakerReduction(request);assert.equal(regressive.activity,'unknown');assert.equal(regressive.result.filledQuantity,4);
  }finally{await f.adapter.close();}}
});

test('cancel acknowledgement alone does not make Maker terminal; cancellation races retain later confirmed fills',async()=>{
  for(const venue of ['gate','bybit'] as const){const f=fixture(venue);try{
    await f.adapter.submitMakerReduction(request);await f.adapter.inspectMakerReduction(request,'10001');
    await f.adapter.cancelMakerReduction(request,'10001');assert.equal(f.cancelled.length,1);
    assert.equal((await f.adapter.inspectMakerReduction(request)).activity,'active');
    f.filled(6);f.terminal();const final=await f.adapter.inspectMakerReduction(request);
    assert.equal(final.activity,'terminal');assert.equal(final.executionVerified,true);assert.equal(final.result.status,'partial');assert.equal(final.result.filledQuantity,6);
    assert.equal(f.posted.length,1);await assert.rejects(f.adapter.cancelMakerReduction(request,'other'),/identity/);
  }finally{await f.adapter.close();}}
});

test('missing fill cash, wrong identity, execution overflow and failed reads cannot manufacture zero or a terminal Maker receipt',async()=>{
  for(const venue of ['gate','bybit'] as const)for(const bad of ['fee','currency','identity','overflow','read'] as const){const f=fixture(venue);try{
    await f.adapter.submitMakerReduction(request);await f.adapter.inspectMakerReduction(request,'10001');f.filled(4);
    if(bad==='fee')f.patchFill(venue==='gate'?{fee:undefined}:{execFee:undefined});
    if(bad==='currency')f.patchFill(venue==='gate'?{fee_currency:'BTC'}:{feeCurrency:'BTC'});
    if(bad==='identity')f.wrongIdentity();if(bad==='overflow')f.patchFill(venue==='gate'?{size:'-5',close_size:'-5'}:{execQty:'10',closedSize:'10'});if(bad==='read')f.failReads();
    const value=await f.adapter.inspectMakerReduction(request);assert.equal(value.activity,'unknown');assert.equal(value.executionVerified,false);assert.equal(value.result.filledQuantity,2);
    assert.equal(value.result.feeUsd,.001);assert.equal(f.posted.length,1);assert.equal(f.cancelled.length,0);
  }finally{await f.adapter.close();}}
});

test('zero-fill active orders and confirmed cancellations are distinguishable without fee fabrication',async()=>{
  for(const venue of ['gate','bybit'] as const){const f=fixture(venue);try{
    f.filled(0);await f.adapter.submitMakerReduction(request);const active=await f.adapter.inspectMakerReduction(request,'10001');
    assert.equal(active.activity,'active');assert.equal(active.executionVerified,true);assert.equal(active.result.feeUsd,0);
    f.terminal();const cancelled=await f.adapter.inspectMakerReduction(request);assert.equal(cancelled.activity,'terminal');assert.equal(cancelled.result.status,'cancelled');assert.equal(cancelled.result.filledQuantity,0);
  }finally{await f.adapter.close();}}
});

test('native reduction quantity validation still refuses changed or insufficient holdings before the Maker create',async()=>{
  for(const venue of ['gate','bybit'] as const){const f=fixture(venue);try{
    f.held(8);await assert.rejects(f.adapter.validateMakerReduction(request));const value=await f.adapter.submitMakerReduction(request);
    assert.equal(value.status,'cancelled');assert.equal(value.filledQuantity,0);assert.equal(f.posted.length,0);
  }finally{await f.adapter.close();}}
});

test('Maker GET recovery binds to the persisted original ID without submitting or implicitly restoring authorization',async()=>{
  for(const venue of ['gate','bybit'] as const){const f=fixture(venue);try{
    const value=await f.adapter.inspectMakerReduction(request,'10001');assert.equal(value.activity,'active');assert.equal(value.result.filledQuantity,2);
    assert.equal(f.posted.length,0);assert.equal(f.cancelled.length,0);
    f.wrongIdentity();const missing=await f.adapter.inspectMakerReduction(request);assert.equal(missing.activity,'unknown');assert.equal(missing.result.filledQuantity,2);
  }finally{await f.adapter.close();}}
});

test('Bybit Maker execution pagination deduplicates exact exec IDs and requires complete cumulative coverage',async()=>{
  const f=fixture('bybit');try{
    await f.adapter.submitMakerReduction(request);f.filled(4);
    const at=String(Date.now());
    const execution=(id:string)=>({execId:id,orderId:'10001',orderLinkId:exchangeClientId('bybit',request.clientOrderId),symbol:'CTUSDT',side:'Sell',
      orderType:'Limit',execType:'Trade',isMaker:true,execQty:'2',execPrice:'11',execFee:'.001',closedSize:'2',feeCurrency:'USDT',extraFees:'',execTime:at});
    const pages:any[]=[];
    f.client.privateGetV5ExecutionList=async(params:any)=>{pages.push(params);return {retCode:0,result:{category:'linear',
      list:params.cursor?[execution('501'),execution('502')]:[execution('501')],nextPageCursor:params.cursor?'':'next-page'}};};
    const valid=await f.adapter.inspectMakerReduction(request,'10001');assert.equal(valid.executionVerified,true);assert.equal(valid.result.filledQuantity,4);assert.equal(valid.result.feeUsd,.002);
    assert.deepEqual(pages.map(p=>p.cursor),[undefined,'next-page']);assert.ok(pages.every(p=>p.orderId==='10001'));
    f.filled(6);f.client.privateGetV5ExecutionList=async()=>({retCode:0,result:{list:[execution('501')],nextPageCursor:'repeat'}});
    const incomplete=await f.adapter.inspectMakerReduction(request);assert.equal(incomplete.executionVerified,false);assert.equal(incomplete.result.filledQuantity,4);assert.equal(incomplete.result.feeUsd,.002);
  }finally{await f.adapter.close();}
});

test('Bybit unverified Maker fills cannot hide non-maker execution, wrong close action, extra fees, or duplicate cash conflicts',async()=>{
  for(const patch of [{isMaker:false},{closedSize:'0'},{extraFees:'[{"amount":".1"}]'},{execId:''},{orderId:'other-native'},{execTime:'0'}]){
    const f=fixture('bybit');try{
      await f.adapter.submitMakerReduction(request);await f.adapter.inspectMakerReduction(request,'10001');f.filled(4);f.patchFill(patch);
      const value=await f.adapter.inspectMakerReduction(request);assert.equal(value.executionVerified,false);assert.equal(value.result.filledQuantity,2);assert.equal(value.result.feeUsd,.001);
    }finally{await f.adapter.close();}
  }
  for(const venue of ['gate','bybit'] as const){const f=fixture(venue);try{
    await f.adapter.submitMakerReduction(request);await f.adapter.inspectMakerReduction(request,'10001');f.filled(4);
    if(venue==='gate')f.client.privateFuturesGetSettleMyTrades=async()=>[
      {id:'501',order_id:'10001',contract:'CT_USDT',size:'-1',close_size:'-1',price:'11',fee:'.001',point_fee:'0'},
      {id:'501',order_id:'10001',contract:'CT_USDT',size:'-1',close_size:'-1',price:'11',fee:'.002',point_fee:'0'}];
    else{const read=f.client.privateGetV5ExecutionList;f.client.privateGetV5ExecutionList=async(params:any)=>{
      const response=await read(params),row=response.result.list[0];response.result.list.push({...row,execFee:'.002'});return response;};}
    const value=await f.adapter.inspectMakerReduction(request);assert.equal(value.executionVerified,false);assert.equal(value.result.filledQuantity,2);assert.equal(f.cancelled.length,0);
  }finally{await f.adapter.close();}}
});

test('ordinary reconciliation cannot cancel the dedicated resting Maker reduction',async()=>{
  const f=fixture('bybit');try{
    await f.adapter.submitMakerReduction(request);
    await assert.rejects(f.adapter.reconcileOrder(request,'10001'),/inspectMakerReduction/);
    await assert.rejects(f.adapter.placeOrder(request),/supervised route/);
    assert.equal(f.posted.length,1);assert.equal(f.cancelled.length,0);assert.equal(f.queries.length,0);
  }finally{await f.adapter.close();}
});

test('Maker fills must respect the tighter native limit and trustworthy order clock while retaining previously verified cash',async()=>{
  for(const venue of ['gate','bybit'] as const)for(const failure of ['price','clock']){const f=fixture(venue);try{
    await f.adapter.submitMakerReduction(request);await f.adapter.inspectMakerReduction(request,'10001');f.filled(4);
    if(failure==='price')f.patchRaw({price:'11.01'});
    else f.patchRaw(venue==='gate'?{create_time_ms:String(Date.now()+60000)}:{updatedTime:String(Date.now()+60000)});
    const result=await f.adapter.inspectMakerReduction(request);
    assert.equal(result.activity,'unknown');assert.equal(result.executionVerified,false);assert.equal(result.result.filledQuantity,2);assert.equal(result.result.feeUsd,.001);
    assert.equal(f.cancelled.length,0);assert.equal(f.posted.length,1);
  }finally{await f.adapter.close();}}
});

test('a dynamic Maker permit revoked during native account GET vetoes creation and retains proven zero without replay',async()=>{
  for(const venue of ['gate','bybit'] as const)for(const throws of [false,true]){const f=fixture(venue);try{
    const method=venue==='gate'?'privateFuturesGetSettleAccounts':'privateGetV5AccountInfo',original=f.client[method];
    let release!:()=>void,entered!:()=>void,allowed=true;
    const barrier=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
    f.client[method]=async(...args:any[])=>{entered();await barrier;return original(...args);};
    const pending=f.adapter.submitMakerReduction(request,()=>{if(throws&&!allowed)throw new Error('offline revoked permission');return allowed;});
    await started;allowed=false;release();const rejected=await pending;
    assert.equal(rejected.status,'cancelled');assert.equal(rejected.rejectionCode,'MAKER_REDUCTION_PERMISSION_CHANGED');
    assert.equal(rejected.id,'');assert.equal(rejected.filledQuantity,0);assert.equal(rejected.feeUsd,0);assert.equal(f.posted.length,0);
    assert.deepEqual(await f.adapter.submitMakerReduction(request,()=>true),rejected);assert.equal(f.posted.length,0);
    const verified=await f.adapter.inspectMakerReduction(request);assert.equal(verified.activity,'terminal');assert.equal(verified.executionVerified,true);assert.equal(f.queries.length,0);
    await assert.rejects(f.native.placeMakerReduction(request,venue==='gate'?5:10,11,()=>true));assert.equal(f.posted.length,0);
  }finally{await f.adapter.close();}}
});

test('a revoked Maker permit cannot replace an existing acknowledged or uncertain original with a zero refusal',async()=>{
  for(const venue of ['gate','bybit'] as const)for(const uncertain of [false,true]){const f=fixture(venue);try{
    if(uncertain)f.failPost();const original=await f.adapter.submitMakerReduction(request,()=>true);
    const retained=await f.adapter.submitMakerReduction(request,()=>false);
    assert.deepEqual(retained,original);assert.equal(retained.status,'unknown');assert.equal(f.posted.length,1);assert.equal(f.cancelled.length,0);
  }finally{await f.adapter.close();}}
});
