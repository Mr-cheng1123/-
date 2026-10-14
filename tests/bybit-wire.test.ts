import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import ccxt from 'ccxt';
import {BybitPrivate,bybitReadError} from '../src/adapters/bybit-private.js';
import {CcxtAdapter} from '../src/adapters/ccxt.js';
import {defaultConfig} from './legacy-config.js';
import {unknownOrder} from '../src/adapters/normalization.js';
import type {OrderRequest,OrderResult} from '../src/shared/types.js';

const KEY='offline-bybit-key',SECRET='offline-bybit-secret',symbol='BTC/USDT:USDT';
interface Wire {method:string;path:string;params:any}
function diagnostic(result:OrderResult){const {observedAt,...details}=result.confirmation??{};return details;}
function fixture(hedged=false,marginMode='REGULAR_MARGIN',marketOverrides:any={},timeInForce='IOC'){
  const calls:Wire[]=[],orders=new Map<string,any>(),holdings=new Map<number,{side:string;size:number}>(),cashLog:any[]=[];
  let leverage='10',emptySymbol=false,pending=false,createError=false,missingOrder=false,historyOnly=false,openIoc=false,fillRatio=1,unknownFee=false,leverageError:string|undefined;
  let configuredSymbolCursor=false,cursorAfterSet=false,accountPagination=false,incompleteSymbol=false;
  let createRejection:string|undefined,createRejectionMessage:string|undefined,zeroIoc=false;
  const wallet:any={accountType:'UNIFIED',totalEquity:'540',totalAvailableBalance:'280',coin:[
    {coin:'USDT',walletBalance:'350',equity:'355',usdValue:'355',totalPositionIM:'20',totalOrderIM:'10',locked:'5',bonus:'15',borrowAmount:'0',spotBorrow:'0',accruedInterest:'0',availableToWithdraw:''},
    {coin:'BTC',walletBalance:'.001',equity:'.001',usdValue:'185',borrowAmount:'0',spotBorrow:'0',accruedInterest:''},
  ]};
  const client:any=new ccxt.bybit({apiKey:KEY,secret:SECRET,enableRateLimit:false,options:{adjustForTimeDifference:false,maxRetriesOnFailure:0}});
  const marketId=marketOverrides.id??'BTCUSDT';
  client.setMarkets([{id:'BTCUSDT',symbol,base:'BTC',quote:'USDT',settle:'USDT',baseId:'BTC',quoteId:'USDT',settleId:'USDT',type:'swap',
    spot:false,swap:true,margin:false,future:false,option:false,contract:true,active:true,linear:true,inverse:false,contractSize:1,
    precision:{amount:.001,price:.1},limits:{amount:{min:.001,max:10},cost:{min:1}},info:{},...marketOverrides}]);
  const ok=(result:any)=>({retCode:0,retMsg:'OK',result,time:1770000000000,retExtInfo:{}});
  client.fetchImplementation=async(urlText:string,params:any)=>{
    const url=new URL(urlText),headers=new Headers(params.headers),method=String(params.method),body=params.body as string|undefined;
    assert.equal(url.hostname,'api.bybit.com');assert.equal(headers.get('X-BAPI-API-KEY'),KEY);
    const signed=headers.get('X-BAPI-TIMESTAMP')!+KEY+headers.get('X-BAPI-RECV-WINDOW')!+(method==='POST'?(body??''):decodeURIComponent(url.search.slice(1)));
    assert.equal(headers.get('X-BAPI-SIGN'),createHmac('sha256',SECRET).update(signed).digest('hex'));
    const p=body?JSON.parse(body):Object.fromEntries(url.searchParams);calls.push({method,path:url.pathname,params:p});
    if(method==='POST')assert.equal(url.search,'');else assert.equal(body,undefined);
    let result:any;
    if(url.pathname==='/v5/account/info')result={unifiedMarginStatus:5,marginMode};
    else if(url.pathname==='/v5/account/wallet-balance'){assert.equal(p.accountType,'UNIFIED');assert.equal(p.coin,undefined);result={list:[wallet]};}
    else if(url.pathname==='/v5/position/list'){
      assert.equal(p.category,'linear');assert.ok(p.symbol===marketId||p.settleCoin==='USDT');
      const indices=hedged?[1,2]:[0];
      result={category:'linear',nextPageCursor:'',list:p.symbol&&emptySymbol?[]:indices.map(positionIdx=>{
        const holding=holdings.get(positionIdx);return {symbol:marketId,positionIdx,size:String(holding?.size??0),side:holding?.side??'',leverage,tradeMode:0,
          markPrice:'10000',liqPrice:'',updatedTime:'1770000000000'};
      }).filter(row=>p.symbol||Number(row.size)>0)};
      if(p.symbol&&incompleteSymbol)result.list=result.list.slice(0,1);
      if(p.symbol&&configuredSymbolCursor){
        result.nextPageCursor=p.cursor?'':'offline-next-symbol';
        if(p.cursor)result.list=result.list.map((row:any)=>({...row,leverage:'10'}));
      }
      if(!p.symbol&&accountPagination){
        result.list=result.list.slice(p.cursor?1:0,p.cursor?2:1);
        result.nextPageCursor=p.cursor?'':'offline-next-account';
      }
    }else if(url.pathname==='/v5/account/transaction-log'){
      assert.equal(method,'GET');assert.equal(p.accountType,'UNIFIED');assert.equal(p.category,'linear');assert.equal(p.currency,'USDT');
      result={list:cashLog,nextPageCursor:null};
    }else if(url.pathname==='/v5/position/set-leverage'){
      assert.equal(method,'POST');assert.deepEqual(p,{category:'linear',symbol:marketId,buyLeverage:'2',sellLeverage:'2'});
      if(leverageError)return new Response(JSON.stringify({retCode:Number(leverageError),retMsg:'offline leverage validation',result:{}}),{headers:{'content-type':'application/json'}});
      leverage=p.buyLeverage;if(cursorAfterSet)configuredSymbolCursor=true;result={};
    }else if(url.pathname==='/v5/order/create'){
      assert.equal(method,'POST');assert.equal(p.category,'linear');assert.equal(p.orderType,'Limit');assert.equal(p.timeInForce,timeInForce);
      assert.equal(p.marginMode,undefined);assert.equal(p.tradeMode,undefined);assert.equal(typeof p.reduceOnly,'boolean');
      if(createRejection)return new Response(JSON.stringify({retCode:Number(createRejection),retMsg:createRejectionMessage??`Native order validation; apiKey=${KEY}; secret=${SECRET}`,result:{}}),{headers:{'content-type':'application/json'}});
      const id=`offline-order-${orders.size+1}`,qty=Number(p.qty),filled=openIoc?qty*.2:qty*fillRatio;
      const current=holdings.get(p.positionIdx);
      const holdingSide=p.reduceOnly?(p.side==='Sell'?'Buy':'Sell'):p.side;
      holdings.set(p.positionIdx,{side:holdingSide,size:Math.max(0,(current?.size??0)+(p.reduceOnly?-filled:filled))});
      const row={...p,orderId:id,orderStatus:openIoc?'PartiallyFilled':fillRatio===1?'Filled':'Cancelled',cumExecQty:String(filled),avgPrice:String(p.price),
        cumFeeDetail:unknownFee?{}:{USDT:String(.05*(openIoc?.2:fillRatio))},extraFees:'',updatedTime:'1770000000000',...(zeroIoc?{rejectReason:'EC_NoImmediateQtyToFill'}:{})};
      orders.set(id,row);result={orderId:id,orderLinkId:p.orderLinkId};
      if(createError)throw new TypeError('offline lost acknowledgement');
    }else if(url.pathname==='/v5/order/realtime'||url.pathname==='/v5/order/history'){
      assert.equal(method,'GET');assert.equal(p.category,'linear');
      if(p.openOnly==='0')result={category:'linear',list:pending?[{orderId:'external-order'}]:[],nextPageCursor:''};
      else{
        const row=orders.get(p.orderId)??[...orders.values()].find(o=>o.orderLinkId===p.orderLinkId);
        result={category:'linear',nextPageCursor:'',list:missingOrder||historyOnly&&url.pathname.endsWith('/realtime')||!row?[]:[row]};
      }
    }else if(url.pathname==='/v5/order/cancel'){
      assert.equal(method,'POST');const row=orders.get(p.orderId);assert.ok(row);row.orderStatus='Cancelled';result={orderId:p.orderId};
    }else throw new Error(`Unexpected offline route ${method} ${url.pathname}`);
    return new Response(JSON.stringify(ok(result)),{headers:{'Content-Type':'application/json'}});
  };
  return {client,calls,wallet,orders,holdings,cashLog,adapter:new BybitPrivate(client),setLeverage:(value:string)=>{leverage=value;},
    setMode:(value:string)=>{marginMode=value;},emptySymbol:()=>{emptySymbol=true;},pending:()=>{pending=true;},loseAck:()=>{createError=true;},
    missingOrder:()=>{missingOrder=true;},historyOnly:()=>{historyOnly=true;},openIoc:(enabled=true)=>{openIoc=enabled;},partial:(unknown=false)=>{fillRatio=.6;unknownFee=unknown;},
    cursorAfterSet:()=>{cursorAfterSet=true;},symbolCursor:()=>{configuredSymbolCursor=true;},accountPagination:()=>{accountPagination=true;},incompleteSymbol:()=>{incompleteSymbol=true;},
    rejectCreate:(value:string,message?:string)=>{createRejection=value;createRejectionMessage=message;},zeroIoc:()=>{fillRatio=0;zeroIoc=true;},
    leverageError:(value:string)=>{leverageError=value;}};
}
const req=(side:'buy'|'sell',reduceOnly:boolean,suffix=''):OrderRequest=>({base:'BTC',symbol,side,reduceOnly,quantity:.01,limitPrice:10000,clientOrderId:`offline-${side}-${reduceOnly}${suffix}`});

test('Bybit terminal receipts accept only empty extra-fee containers, preserving actual fills and fees',async()=>{
  for(const extraFees of [undefined,'',[],'[]',' [ ] '])for(const zero of [false,true]){
    const f=fixture();await f.adapter.prepare(symbol,2);if(zero)f.zeroIoc();
    const request=req('buy',false),id=await f.adapter.place(request,.01,10000),row=f.orders.get(id!)!;
    row.extraFees=extraFees;
    const result=await f.adapter.reconcile(request,unknownOrder(request,id),id);
    assert.equal(result.status,zero?'cancelled':'filled');assert.equal(result.filledQuantity,zero?0:.01);
    assert.equal(result.feeUsd,zero?0:.05);assert.equal(result.id,id);assert.equal(result.confirmation,undefined);
    await f.adapter.place(request,.01,10000);assert.equal(f.orders.size,1);
  }
});

test('Bybit nonempty or malformed extra fees cannot establish a complete terminal receipt',async()=>{
  for(const extraFees of [null,false,0,{},'[','null','{}',[{}],'[{}]',[{feeCoin:'USDT',fee:'.1'}]]){
    const f=fixture();await f.adapter.prepare(symbol,2);const request=req('buy',false),id=await f.adapter.place(request,.01,10000);
    f.orders.get(id!)!.extraFees=extraFees;
    const result=await f.adapter.reconcile(request,unknownOrder(request,id),id);
    assert.equal(result.status,'unknown');assert.equal(result.filledQuantity,.01);assert.equal(result.id,id);
    assert.deepEqual(diagnostic(result),{stage:'receipt',reason:'fee-unverified'});
    await f.adapter.place(request,.01,10000);assert.equal(f.orders.size,1);
  }
});

test('Bybit missing original records and failed reads retain safe diagnostics without inventing execution',async()=>{
  const f=fixture();await f.adapter.prepare(symbol,2);const request=req('buy',false),id=await f.adapter.place(request,.01,10000);
  f.missingOrder();const prior=unknownOrder(request,id);
  const absent=await f.adapter.inspectOrder(request,prior,id);
  assert.equal(absent.status,'unknown');assert.equal(absent.id,id);assert.equal(absent.filledQuantity,0);
  assert.deepEqual(diagnostic(absent),{stage:'order-read',reason:'not-found'});
  f.client.privateGetV5OrderRealtime=async()=>{throw Object.assign(new Error('private-payload-canary'),{apiCode:'10005'});};
  const failed=await f.adapter.reconcile(request,absent,id);
  assert.equal(failed.status,'unknown');assert.equal(failed.id,id);
  assert.deepEqual(diagnostic(failed),{stage:'order-read',reason:'request-failed',apiCode:'10005'});
  assert.ok(!JSON.stringify(failed).includes('private-payload-canary'));assert.equal(failed.rejectionCode,undefined);
  assert.equal(f.calls.filter(call=>call.path==='/v5/order/create').length,1);
});

test('Bybit invalid original identity and execution report fixed receipt reasons',async()=>{
  for(const mismatch of ['identity','quantity']){
    const f=fixture();await f.adapter.prepare(symbol,2);const request=req('buy',false),id=await f.adapter.place(request,.01,10000),row=f.orders.get(id!)!;
    if(mismatch==='identity')row.orderLinkId='private-foreign-id';else row.cumExecQty='99';
    const result=await f.adapter.inspectOrder(request,unknownOrder(request,id),id);
    assert.equal(result.status,'unknown');assert.equal(result.id,id);assert.equal(result.filledQuantity,0);
    assert.deepEqual(diagnostic(result),{stage:'receipt',reason:mismatch==='identity'?'identity-mismatch':'invalid-execution'});
    assert.ok(!JSON.stringify(result).includes('private-foreign-id'));assert.equal(f.orders.size,1);
  }
});

test('Bybit Maker partial closes exact order remainder and confirms actual fees before returning to hedge',async()=>{
  const f=fixture(false,'REGULAR_MARGIN',{},'PostOnly'),adapter=new CcxtAdapter('bybit',{...defaultConfig,mode:'live',dataSource:'public'},f.client);
  try{
    await adapter.prepareTrading(symbol,2);f.openIoc();
    const request={...req('buy',false,'-maker'),postOnly:true};
    const [value,duplicate]=await Promise.all([adapter.placeOrder(request),adapter.placeOrder(request)]);
    assert.equal(value.status,'partial');assert.equal(value.filledQuantity,.002);assert.equal(value.feeUsd,.05*.2);assert.deepEqual(duplicate,value);
    assert.equal(f.calls.filter(c=>c.path==='/v5/order/create').length,1);assert.equal(f.calls.filter(c=>c.path==='/v5/order/cancel').length,1);
    assert.equal(f.calls.find(c=>c.path==='/v5/order/create')?.params.timeInForce,'PostOnly');
    const creates=f.calls.filter(c=>c.path==='/v5/order/create').length;
    const wrong={...request,clientOrderId:'offline-invalid-maker-close',reduceOnly:true};
    assert.equal((await adapter.placeOrder(wrong)).rejectionCode,'INVALID_MAKER_ORDER');assert.equal(f.calls.filter(c=>c.path==='/v5/order/create').length,creates);
    const native=f.orders.get(value.id)!;native.timeInForce='IOC';
    assert.equal((await adapter.inspectOrder(request,value.id)).status,'unknown','native IOC response cannot confirm a Maker request');
  }finally{await adapter.close();}
});

test('Bybit Maker lost ACK resolves only the original deterministic order and never creates another order',async()=>{
  const f=fixture(false,'REGULAR_MARGIN',{},'PostOnly'),adapter=new CcxtAdapter('bybit',{...defaultConfig,mode:'live',dataSource:'public'},f.client);
  try{
    await adapter.prepareTrading(symbol,2);f.openIoc();f.loseAck();
    const request={...req('buy',false,'-maker-lost-ack'),postOnly:true},value=await adapter.placeOrder(request);
    assert.equal(value.status,'partial');assert.equal(value.filledQuantity,.002);
    assert.equal(f.calls.filter(c=>c.path==='/v5/order/create').length,1);assert.equal(f.calls.filter(c=>c.path==='/v5/order/cancel').length,1);
    assert.deepEqual(await adapter.placeOrder(request),value);assert.equal(f.calls.filter(c=>c.path==='/v5/order/create').length,1);
  }finally{await adapter.close();}
});

test('Bybit Maker missing real cash fee remains unknown with its fill lower bound and never guesses Maker charges',async()=>{
  const f=fixture(false,'REGULAR_MARGIN',{},'PostOnly'),adapter=new CcxtAdapter('bybit',{...defaultConfig,mode:'live',dataSource:'public'},f.client);
  try{
    await adapter.prepareTrading(symbol,2);f.partial(true);
    const request={...req('buy',false,'-maker-missing-fees'),postOnly:true},value=await adapter.placeOrder(request);
    assert.equal(value.status,'unknown');assert.equal(value.filledQuantity,.006);assert.equal(value.feeUsd,0,'keeps the unresolved prior fee placeholder without estimating a charge');
    assert.equal((await adapter.placeOrder(request)).status,'unknown');assert.equal(f.calls.filter(c=>c.path==='/v5/order/create').length,1);
  }finally{await adapter.close();}
});

test('Bybit blank cross liquidation stays unavailable and current openTime is separate from first symbol creation',async()=>{
  const f=fixture(),native={symbol:'BTCUSDT',positionIdx:0,size:'908.8',side:'Buy',leverage:'2',markPrice:'.10948',liqPrice:'',
    avgPrice:'.1099195',unrealisedPnl:'-.399416',curRealisedPnl:'-.05494223',cumRealisedPnl:'99',
    openTime:1790916557929,createdTime:'1700000000000',updatedTime:'1790917189298'};
  f.client.privateGetV5PositionList=async()=>({retCode:0,result:{list:[native],nextPageCursor:''}});
  const p=(await f.adapter.fetchAccount()).positions[0];
  assert.equal(p.entryPrice,.1099195);assert.equal(p.unrealizedPnlUsd,-.399416);assert.equal(p.marginMode,'crossed');
  assert.equal(p.liquidationPrice,0);assert.equal(p.liquidationStatus,'unavailable');assert.ok(p.liquidationReason);
  assert.equal(p.positionOpenedAt,1790916557929);assert.equal(p.positionUpdatedAt,1790917189298);
  assert.equal(p.realizedPnlUsd,undefined);assert.equal(p.fundingUsd,undefined);assert.equal(p.feesUsd,undefined);
  delete (native as any).openTime;assert.equal((await f.adapter.fetchAccount()).positions[0].positionOpenedAt,undefined);
  f.setMode('ISOLATED_MARGIN');assert.equal((await f.adapter.fetchAccount()).positions[0].marginMode,'isolated');
  assert.ok(f.calls.every(c=>c.method==='GET'));
});

test('Bybit real CCXT UTA wallet ignores deprecated empty withdraw amount and caps own USDT by account margin',async()=>{
  const f=fixture();const account=await f.adapter.fetchAccount();assert.equal(account.freeUsd,280);assert.equal(account.equityUsd,540);assert.deepEqual(account.positions,[]);
  const overview=await f.adapter.fetchAccountOverview();assert.equal(overview.usdtAvailableUsd,300);assert.equal(overview.marginAvailableUsd,280);
  assert.equal(overview.accountMode,'REGULAR_MARGIN');assert.equal(overview.executionSupported,true);assert.equal(overview.balanceScope,'unified_usdt');
  f.wallet.totalAvailableBalance='900';assert.equal((await f.adapter.fetchAccount()).freeUsd,300);
  assert.ok(f.calls.every(c=>c.method==='GET'));assert.ok(f.calls.every(c=>!c.path.includes('query-api')));
});

test('Bybit isolated balances use coin collateral while account-wide empty fields are not invented as zero',async()=>{
  const f=fixture(false,'ISOLATED_MARGIN');f.wallet.totalEquity='';f.wallet.totalAvailableBalance='';
  const account=await f.adapter.fetchAccount();assert.equal(account.freeUsd,300);assert.equal(account.equityUsd,540);
  assert.equal((await f.adapter.fetchAccountOverview()).marginAvailableUsd,undefined);
  f.wallet.coin[0].totalOrderIM='';await assert.rejects(f.adapter.fetchAccount(),/fields are incomplete/);
  f.wallet.coin[0].totalOrderIM='10';f.wallet.coin[1].usdValue=undefined;await assert.rejects(f.adapter.fetchAccount(),/equity fields/);
});

test('Bybit malformed budget or debt blocks execution, while portfolio margin stays read-only',async()=>{
  const f=fixture();for(const value of ['1',undefined,'']){f.wallet.coin[0].borrowAmount=value;await assert.rejects(f.adapter.fetchAccount(),/borrowed/);assert.equal((await f.adapter.fetchAccountOverview()).executionSupported,false);}
  f.wallet.coin[0].borrowAmount='0';f.wallet.coin[1].accruedInterest='not-a-number';await assert.rejects(f.adapter.fetchAccount(),/borrowed/);
  f.wallet.coin[1].accruedInterest='';f.setMode('PORTFOLIO_MARGIN');
  assert.equal((await f.adapter.fetchAccountOverview()).executionSupported,false);await assert.rejects(f.adapter.fetchAccount(),/portfolio/);
  assert.ok(f.calls.every(c=>c.method==='GET'));
});

for(const margin of ['REGULAR_MARGIN','ISOLATED_MARGIN'])for(const hedged of [false,true]){
  test(`Bybit real CCXT ${margin}/${hedged?'hedge':'one-way'} preparation and all four IOC directions preserve mode`,async()=>{
    const f=fixture(hedged,margin);await f.adapter.inspectTrading(symbol,2);assert.ok(f.calls.every(c=>c.method==='GET'));
    await f.adapter.prepare(symbol,2);await new BybitPrivate(f.client).prepare(symbol,2);
    assert.equal(f.calls.filter(c=>c.path.endsWith('/set-leverage')).length,1);
    // One-way opens/closes the first side before opening the opposite side; hedge slots are independently confirmed.
    for(const [side,reduceOnly] of [['buy',false],['sell',true],['sell',false],['buy',true]] as const){
      const request=req(side,reduceOnly),adapter=new BybitPrivate(f.client),id=await adapter.place(request,.01,10000);
      const result=await adapter.reconcile(request,undefined,id);assert.equal(result.status,'filled');assert.equal(result.filledQuantity,.01);assert.equal(result.feeUsd,.05);
      const payload=f.calls.filter(c=>c.path.endsWith('/create')).at(-1)!.params;
      const expectedIdx=hedged?((reduceOnly?side==='sell':side==='buy')?1:2):0;
      assert.equal(payload.positionIdx,expectedIdx);assert.equal(payload.reduceOnly,reduceOnly);assert.equal(payload.qty,'0.01');
      const count=f.orders.size;await new BybitPrivate(f.client).place(request,.01,10000);assert.equal(f.orders.size,count);
      await assert.rejects(adapter.place({...request,quantity:.02},.02,10000),/conflict/);
    }
    assert.deepEqual((await f.adapter.fetchAccount()).positions,[]);
    assert.ok(!f.calls.some(c=>/switch|set-margin/.test(c.path)));
  });
}

test('Bybit empty-symbol, existing positions or pending orders fail the read-only phase before any write',async()=>{
  for(const kind of ['empty','position','pending']){
    const f=fixture(true);if(kind==='empty')f.emptySymbol();if(kind==='pending')f.pending();if(kind==='position')f.holdings.set(1,{side:'Buy',size:.1});
    await assert.rejects(f.adapter.inspectTrading(symbol,2),/mode cannot|existing position/);
    await assert.rejects(f.adapter.prepare(symbol,2));assert.ok(f.calls.every(c=>c.method==='GET'));
  }
});

test('Bybit lost acknowledgements query stable client ID/history, never resend and keep unresolved fills unknown',async()=>{
  const f=fixture();await f.adapter.prepare(symbol,2);f.loseAck();f.historyOnly();const request=req('buy',false);
  await assert.rejects(f.adapter.place(request,.01,10000));
  const result=await new BybitPrivate(f.client).reconcile(request);assert.equal(result.status,'filled');assert.equal(result.filledQuantity,.01);
  await new BybitPrivate(f.client).place(request,.01,10000);assert.equal(f.orders.size,1);
  f.missingOrder();const later=await f.adapter.reconcile(request,result);assert.equal(later.status,'unknown');assert.equal(later.filledQuantity,.01);assert.equal(f.orders.size,1);
});

test('Bybit anomalously live IOC cancels exact identity then re-reads terminal partial quantity and true fee',async()=>{
  const f=fixture(true);await f.adapter.prepare(symbol,2);f.openIoc();const request=req('buy',false),id=await f.adapter.place(request,.01,10000);
  const result=await f.adapter.reconcile(request,undefined,id);assert.equal(result.status,'partial');assert.equal(result.filledQuantity,.002);assert.ok(Math.abs(result.feeUsd-.01)<1e-12);
  const cancel=f.calls.findIndex(c=>c.path.endsWith('/cancel'));assert.ok(cancel>0);assert.equal(f.calls[cancel].params.orderId,id);
  assert.ok(f.calls.slice(cancel+1).some(c=>c.method==='GET'&&c.path.endsWith('/realtime')&&c.params.orderId===id));
});

test('Bybit partial fills with unknown fee currency keep known quantity without fee estimates or duplicate order',async()=>{
  const f=fixture();await f.adapter.prepare(symbol,2);f.partial(true);const request=req('buy',false),id=await f.adapter.place(request,.01,10000);
  const result=await f.adapter.reconcile(request,undefined,id);assert.equal(result.status,'unknown');assert.equal(result.filledQuantity,.006);
  const row=f.orders.get(id!);row.cumFeeDetail={USDC:'.03'};assert.equal((await f.adapter.reconcile(request,result,id)).status,'unknown');
  row.cumFeeDetail={USDT:'.03'};assert.equal((await f.adapter.reconcile(request,result,id)).status,'partial');
  await f.adapter.place(request,.01,10000);assert.equal(f.orders.size,1);
});

test('Bybit changed settings, leverage or mismatched order identity cannot authorize unintended execution',async()=>{
  const f=fixture(true);await f.adapter.prepare(symbol,2);f.setLeverage('3');await assert.rejects(f.adapter.place(req('buy',false,'-stale-setting'),.01,10000),/settings changed/);
  f.setLeverage('2');const request=req('buy',false),id=await f.adapter.place(request,.01,10000),row=f.orders.get(id!);
  const original={...row},prior={...unknownOrder(request),filledQuantity:.001,averagePrice:10000};
  for(const change of [{orderId:'wrong'},{symbol:'ETHUSDT'},{side:'Sell'},{positionIdx:2},{reduceOnly:true},{orderLinkId:'wrong'},{qty:'.02'},{timeInForce:'GTC'}]){
    Object.assign(row,original,change);const result=await f.adapter.reconcile(request,prior,id);assert.equal(result.status,'unknown');assert.equal(result.filledQuantity,.001);
  }
  assert.ok(!f.calls.some(c=>c.path.endsWith('/cancel')));
});

test('Bybit no-change error is not success unless fresh target leverage readback agrees',async()=>{
  const f=fixture();f.leverageError('110043');await assert.rejects(f.adapter.prepare(symbol,2),/readback failed/);
  await assert.rejects(f.adapter.place(req('buy',false),.01,10000),/preparation missing/);
  assert.equal(f.orders.size,0);
  assert.match(bybitReadError(new Error('bybit: symbol position mode cannot be verified'))!,/不能猜测/);
  assert.equal(bybitReadError(new Error('untrusted raw message')),undefined);
  const corrected=fixture();corrected.leverageError('110043');
  const set=corrected.client.privatePostV5PositionSetLeverage.bind(corrected.client);
  corrected.client.privatePostV5PositionSetLeverage=async(p:any)=>{try{return await set(p);}finally{corrected.setLeverage('2');}};
  await corrected.adapter.prepare(symbol,2);
  assert.equal(corrected.calls.filter(c=>c.path.endsWith('/set-leverage')).length,1);
});

test('Bybit nonzero direct V5 response retains only a safe business identifier and malformed list has a fixed explanation',async()=>{
  const f=fixture();f.client.privateGetV5AccountInfo=async()=>({retCode:10005,retMsg:'sensitive account details',result:{}});
  await assert.rejects(f.adapter.assertTradingMode(symbol),error=>error instanceof Error&&(error as any).apiCode==='10005'&&!error.message.includes('sensitive'));
  f.client.privateGetV5PositionList=async()=>({retCode:0,result:{list:null}});
  f.client.privateGetV5AccountInfo=async()=>({retCode:0,result:{unifiedMarginStatus:5,marginMode:'REGULAR_MARGIN'}});
  await assert.rejects(f.adapter.assertTradingMode(symbol),error=>error instanceof Error&&bybitReadError(error)?.includes('不能将缺失记录当作空仓')===true);
});

test('Bybit live positions expose actual entry and unrealized PnL without inventing funding totals',async()=>{
  const f=fixture();
  f.client.privateGetV5PositionList=async()=>({retCode:0,result:{list:[{symbol:'BTCUSDT',positionIdx:0,size:'.01',side:'Buy',markPrice:'10000',avgPrice:'9900',unrealisedPnl:'1',leverage:'2',liqPrice:''}],nextPageCursor:''}});
  const p=(await f.adapter.fetchAccount()).positions[0];assert.equal(p.entryPrice,9900);assert.equal(p.unrealizedPnlUsd,1);
  assert.equal(p.fundingUsd,undefined);assert.equal(p.feesUsd,undefined);assert.ok(f.calls.every(c=>c.method==='GET'));
});

test('Bybit portfolio cash uses signed native GET while execution account checks do not read cash history',async()=>{
  const f=fixture(),openedAt=Date.now()-60_000;
  f.client.privateGetV5PositionList=async()=>({retCode:0,result:{list:[{symbol:'BTCUSDT',positionIdx:0,size:'.01',side:'Buy',markPrice:'10000',avgPrice:'9900',unrealisedPnl:'1',leverage:'2',liqPrice:'',openTime:openedAt,updatedTime:String(openedAt)}],nextPageCursor:''}});
  f.cashLog.push({id:'cash-trade',symbol:'BTCUSDT',category:'linear',currency:'USDT',type:'TRADE',side:'Buy',qty:'.01',size:'.01',fee:'.05',funding:'0',transactionTime:String(openedAt)},
    {id:'cash-fund',symbol:'BTCUSDT',category:'linear',currency:'USDT',type:'SETTLEMENT',side:'Buy',qty:'.01',size:'.01',fee:'0',funding:'-.01',transactionTime:String(openedAt+1000)});
  const adapter=new CcxtAdapter('bybit',{...defaultConfig,mode:'live',dataSource:'public'},f.client);
  try{
    await adapter.fetchAccount();assert.equal(f.calls.filter(c=>c.path.includes('transaction-log')).length,0);
    const initial=await adapter.fetchPortfolioAccount();assert.equal(initial.positions[0].fundingUsd,undefined);
    await new Promise(resolve=>setImmediate(resolve));
    const p=(await adapter.fetchPortfolioAccount()).positions[0];assert.equal(p.fundingUsd,-.01);assert.equal(p.feesUsd,.05);assert.ok(p.cashFlowAt!>=openedAt);
    assert.equal(f.calls.filter(c=>c.path.includes('transaction-log')).length,1);assert.ok(f.calls.every(c=>c.method==='GET'));
  }finally{await adapter.close();}
});

test('Bybit CcxtAdapter facade shares native preparation across instances and closes only confirmed IOC partial quantity',async()=>{
  const f=fixture(true),adapter=new CcxtAdapter('bybit',{...defaultConfig,mode:'live',dataSource:'public',orderNotionalUsd:100,leverage:2},f.client);
  const opening=req('buy',false,'-facade');
  const unprepared=await adapter.placeOrder(req('buy',false,'-facade-unprepared'));
  assert.equal(unprepared.status,'cancelled');assert.equal(unprepared.rejectionCode,'PRE_SUBMISSION_CHECK_FAILED');
  assert.deepEqual(unprepared.confirmation,{stage:'pre-submit',reason:'pre-submit-failed'});
  await adapter.inspectTrading(symbol,2);assert.ok(f.calls.every(c=>c.method==='GET'));
  await adapter.prepareTrading(symbol,2);f.openIoc();
  const opened=await adapter.placeOrder(opening);assert.equal(opened.status,'partial');assert.equal(opened.filledQuantity,.002);
  assert.equal(f.calls.filter(c=>c.path.endsWith('/cancel')&&c.params.orderId===opened.id).length,1);
  const reconciled=await adapter.reconcileOrder(opening,opened.id);
  const {orderReadAt:openedReadAt,...openedFacts}=opened;
  const {orderReadAt:reconciledReadAt,...reconciledFacts}=reconciled;
  assert.deepEqual(reconciledFacts,openedFacts);
  assert.ok(reconciledReadAt!>=openedReadAt!,'a new original-ID read advances observation time without changing execution facts');
  assert.deepEqual(await adapter.placeOrder(opening),reconciled);assert.equal(f.orders.size,1);
  const held=await adapter.fetchAccount();assert.equal(held.positions.length,1);assert.equal(held.positions[0].quantity,opened.filledQuantity);
  f.openIoc(false);
  const closing={...req('sell',true,'-facade'),quantity:opened.filledQuantity};
  const closed=await adapter.placeOrder(closing);assert.equal(closed.status,'filled');assert.equal(closed.filledQuantity,opened.filledQuantity);
  assert.deepEqual((await adapter.fetchAccount()).positions,[]);
  assert.equal(f.orders.size,2);assert.equal(f.calls.filter(c=>c.path.endsWith('/set-leverage')).length,1);
  const closePayload=f.calls.filter(c=>c.path.endsWith('/create')).at(-1)!.params;
  assert.equal(closePayload.qty,'0.002');assert.equal(closePayload.reduceOnly,true);assert.equal(closePayload.positionIdx,1);
  // Exercise the facade's explicit cancellation dispatcher on a genuinely pending offline IOC as well.
  f.openIoc();const pending=req('sell',false,'-facade-cancel'),pendingId=await new BybitPrivate(f.client).place(pending,.01,10000);
  await adapter.cancelOrder(symbol,pendingId!);const canceled=await adapter.reconcileOrder(pending,pendingId);
  assert.equal(canceled.status,'partial');assert.equal(canceled.filledQuantity,.002);
  f.openIoc(false);await adapter.placeOrder({...req('buy',true,'-facade-close-short'),quantity:canceled.filledQuantity});
  assert.deepEqual((await adapter.fetchAccount()).positions,[]);
});

test('Bybit configured-symbol cursor cannot append conflicting same-symbol records during leverage readback or later orders',async()=>{
  for(const hedged of [false,true]){
    const f=fixture(hedged),adapter=new CcxtAdapter('bybit',{...defaultConfig,mode:'live',dataSource:'public',leverage:2},f.client);
    f.cursorAfterSet();await adapter.prepareTrading(symbol,2);
    await adapter.inspectTrading(symbol,2);await adapter.prepareTrading(symbol,2);
    assert.equal(f.calls.filter(c=>c.path.endsWith('/set-leverage')).length,1);
    const opening=req('buy',false,'-symbol-cursor'),opened=await adapter.placeOrder(opening);
    assert.equal(opened.status,'filled');assert.equal(opened.filledQuantity,.01);
    const closed=await adapter.placeOrder({...req('sell',true,'-symbol-cursor'),quantity:opened.filledQuantity});assert.equal(closed.status,'filled');
    assert.deepEqual((await adapter.fetchAccount()).positions,[]);
    const reads=f.calls.filter(c=>c.path==='/v5/position/list'&&c.params.symbol);
    assert.ok(reads.length>=5);assert.ok(reads.every(c=>c.params.cursor===undefined));
  }
});

test('Bybit incomplete or empty symbol snapshots remain blocked even if a nonempty cursor is present',async()=>{
  for(const kind of ['incomplete','empty']){
    const f=fixture(true);f.symbolCursor();if(kind==='incomplete')f.incompleteSymbol();else f.emptySymbol();
    await assert.rejects(f.adapter.inspectTrading(symbol,2),/position mode cannot be verified/);
    assert.ok(f.calls.every(c=>c.method==='GET'));assert.ok(f.calls.filter(c=>c.path==='/v5/position/list').every(c=>c.params.cursor===undefined));
  }
});

test('Bybit whole-account position enumeration still follows cursors and retains both nonzero hedge sides',async()=>{
  const f=fixture(true);f.accountPagination();f.holdings.set(1,{side:'Buy',size:.1});f.holdings.set(2,{side:'Sell',size:.2});
  const account=await f.adapter.fetchAccount();assert.deepEqual(account.positions.map(p=>[p.side,p.quantity]),[['long',.1],['short',.2]]);
  const reads=f.calls.filter(c=>c.path==='/v5/position/list');assert.equal(reads.length,2);
  assert.equal(reads[0].params.settleCoin,'USDT');assert.equal(reads[1].params.cursor,'offline-next-account');
});

test('Bybit first symbol snapshot rejects foreign symbols and repeated indices without following its cursor',async()=>{
  for(const kind of ['foreign','duplicate']){
    const f=fixture(true);f.symbolCursor();const original=f.client.fetchImplementation;
    f.client.fetchImplementation=async(url:string,params:any)=>{
      const response=await original(url,params),body=await response.json();
      if(new URL(url).pathname==='/v5/position/list'){
        if(kind==='foreign')body.result.list[0].symbol='ETHUSDT';
        else body.result.list[1].positionIdx=body.result.list[0].positionIdx;
      }
      return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
    };
    await assert.rejects(f.adapter.inspectTrading(symbol,2),/position mode cannot be verified/);
    const reads=f.calls.filter(c=>c.path==='/v5/position/list');
    assert.equal(reads.length,1);assert.equal(reads[0].params.cursor,undefined);assert.ok(f.calls.every(c=>c.method==='GET'));
  }
});

test('Bybit whole-account pages reject repeated symbol/index slots, including empty records',async()=>{
  for(const empty of [false,true]){
    const f=fixture(true);f.accountPagination();f.holdings.set(1,{side:'Buy',size:.1});f.holdings.set(2,{side:'Sell',size:.2});
    const original=f.client.fetchImplementation;let first:any;
    f.client.fetchImplementation=async(url:string,params:any)=>{
      const response=await original(url,params),body=await response.json(),address=new URL(url);
      if(address.pathname==='/v5/position/list'){
        if(!address.searchParams.has('cursor')){first={...body.result.list[0],...(empty?{size:'0'}:{})};body.result.list=[first];}
        else body.result.list=[{...first}];
      }
      return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
    };
    await assert.rejects(f.adapter.fetchAccount(),error=>error instanceof Error&&error.message==='bybit: duplicate position side'&&
      bybitReadError(error)?.includes('重复的合约持仓槽位')===true);
    const reads=f.calls.filter(c=>c.path==='/v5/position/list');assert.equal(reads.length,2);
    assert.equal(reads[1].params.cursor,'offline-next-account');assert.ok(f.calls.every(c=>c.method==='GET'));
  }
});

test('Bybit GTLB public lot and price rules accept 2.1 coins at 46.63 through the real CCXT wire',async()=>{
  const tradeSymbol='GTLB/USDT:USDT',f=fixture(false,'REGULAR_MARGIN',{id:'GTLBUSDT',symbol:tradeSymbol,base:'GTLB',baseId:'GTLB',
    precision:{amount:.01,price:.01},limits:{amount:{min:.01,max:1000},cost:{min:5}}});
  f.setLeverage('2');f.symbolCursor();
  const a=new CcxtAdapter('bybit',{...defaultConfig,mode:'live',dataSource:'public',leverage:2},f.client);
  await a.prepareTrading(tradeSymbol,2);
  const request:OrderRequest={base:'GTLB',symbol:tradeSymbol,side:'sell',quantity:2.1,limitPrice:46.63,reduceOnly:false,clientOrderId:'offline-gtlb-grid'};
  const result=await a.placeOrder(request);assert.equal(result.status,'filled');assert.equal(result.filledQuantity,2.1);
  const payload=f.calls.find(c=>c.path==='/v5/order/create')!.params;
  assert.equal(payload.qty,'2.1');assert.equal(payload.price,'46.63');assert.equal(payload.side,'Sell');assert.equal(payload.positionIdx,0);
  assert.equal(f.calls.filter(c=>c.path.endsWith('/set-leverage')).length,0);
});

test('CcxtAdapter validates both order grids using public metadata only and never prepares or sends an order',async()=>{
  const f=fixture(),a=new CcxtAdapter('bybit',{...defaultConfig,mode:'live',dataSource:'public'},f.client);
  await a.validateOrder(req('buy',false));
  await assert.rejects(a.validateOrder({...req('buy',false),quantity:.0105}),/lot size/);
  await assert.rejects(a.validateOrder({...req('buy',false),base:'ETH'}),/Invalid order/);
  await assert.rejects(a.validateOrder({...req('buy',false),quantity:11}),/maximum/);
  assert.deepEqual(f.calls,[]);
});

test('Bybit pre-send mode or local grid rejection is terminal zero-fill and cannot turn into unknown or resend',async()=>{
  for(const kind of ['mode','grid']){
    const f=fixture(),a=new CcxtAdapter('bybit',{...defaultConfig,mode:'live',dataSource:'public'},f.client);
    await a.prepareTrading(symbol,2);const request={...req('buy',false,kind),...(kind==='grid'?{quantity:.0105}:{})};
    if(kind==='mode')f.setLeverage('3');
    const result=await a.placeOrder(request);assert.equal(result.status,'cancelled');assert.equal(result.filledQuantity,0);
    assert.equal(result.rejectionCode,kind==='grid'?'INVALID_ORDER_QUANTITY':'PRE_SUBMISSION_CHECK_FAILED');assert.ok(result.rejectionReason);
    const calls=f.calls.length;assert.deepEqual(await a.reconcileOrder(request),result);assert.deepEqual(await a.placeOrder(request),result);assert.equal(f.calls.length,calls);
    assert.equal(f.calls.filter(c=>c.path==='/v5/order/create').length,0);
  }
});

test('Bybit actual CCXT create-response parser retains explicit parameter/balance/terms refusals without exposing raw payloads',async()=>{
  for(const code of ['10001','110007','110125']){
    const f=fixture(),a=new CcxtAdapter('bybit',{...defaultConfig,mode:'live',dataSource:'public'},f.client);
    await a.prepareTrading(symbol,2);f.rejectCreate(code);const request=req('sell',false,code),result=await a.placeOrder(request);
    assert.equal(result.status,'cancelled');assert.equal(result.filledQuantity,0);assert.equal(result.rejectionCode,code);assert.ok(result.rejectionReason);
    assert.ok(!JSON.stringify(result).includes(KEY));assert.ok(!JSON.stringify(result).includes(SECRET));const count=f.calls.length;
    assert.deepEqual(await a.placeOrder(request),result);assert.deepEqual(await a.reconcileOrder(request),result);assert.equal(f.calls.length,count);
    assert.equal(f.calls.filter(c=>c.path==='/v5/order/create').length,1);assert.equal(f.orders.size,0);
  }
});

test('Bybit actual CCXT signed create-response parser recognizes only the exact 110126 agreement refusal',async()=>{
  const f=fixture(),a=new CcxtAdapter('bybit',{...defaultConfig,mode:'live',dataSource:'public'},f.client);
  try{
    await a.prepareTrading(symbol,2);f.rejectCreate('110126','You must sign the required agreement before trading this contract.');
    const request=req('sell',false,'-agreement-refusal'),result=await a.placeOrder(request);
    assert.equal(result.status,'cancelled');assert.equal(result.rejectionCode,'110126');assert.equal(result.id,'');
    assert.equal(result.filledQuantity,0);assert.equal(result.feeUsd,0);assert.match(result.rejectionReason!,/签署.*协议/);
    const calls=f.calls.length;assert.deepEqual(await a.placeOrder(request),result);assert.deepEqual(await a.reconcileOrder(request),result);
    assert.equal(f.calls.length,calls);assert.equal(f.calls.filter(c=>c.path==='/v5/order/create').length,1);assert.equal(f.orders.size,0);
    assert.equal(f.calls.filter(c=>c.path==='/v5/order/history'||c.path==='/v5/order/realtime'&&c.params.openOnly===undefined).length,0);
  }finally{await a.close();}
});

test('Bybit server timeouts, internal errors and duplicate IDs remain unknown and query the original ID without resending',async()=>{
  for(const code of ['10000','10016','110072','10014','110126']){
    const f=fixture(),a=new CcxtAdapter('bybit',{...defaultConfig,mode:'live',dataSource:'public'},f.client);
    await a.prepareTrading(symbol,2);f.rejectCreate(code);const request=req('sell',false,code),result=await a.placeOrder(request);
    assert.equal(result.status,'unknown');assert.equal(result.rejectionCode,undefined);
    assert.deepEqual(diagnostic(result),{stage:'order-read',reason:'not-found'});
    assert.equal(result.originalConfirmation?.stage,'create');assert.equal(result.originalConfirmation?.apiCode,code);
    assert.match(result.originalConfirmation?.apiMessage??'',/Native order validation/);
    assert.ok(!JSON.stringify(result).includes(KEY));assert.ok(!JSON.stringify(result).includes(SECRET));
    assert.equal((await a.placeOrder(request)).status,'unknown');assert.equal(f.calls.filter(c=>c.path==='/v5/order/create').length,1);
    assert.ok(f.calls.some(c=>c.path==='/v5/order/history'&&c.params.orderLinkId));
  }
});

test('Bybit empty IOC preserves the exchange no-immediate-liquidity reason and confirms zero position reduction',async()=>{
  const f=fixture(),a=new CcxtAdapter('bybit',{...defaultConfig,mode:'live',dataSource:'public'},f.client);
  await a.prepareTrading(symbol,2);await a.placeOrder(req('sell',false,'-ioc-open'));f.zeroIoc();
  const result=await a.placeOrder(req('buy',true,'-ioc-close'));
  assert.equal(result.status,'cancelled');assert.equal(result.filledQuantity,0);assert.equal(result.rejectionCode,'EC_NoImmediateQtyToFill');
  assert.match(result.rejectionReason!,/仓位尚未/);assert.equal((await a.fetchAccount()).positions[0].quantity,.01);
});

test('Bybit native REST zero-fill receipts use actual safe reason fields and distinguish opening from reduction',async()=>{
  for(const cause of ['EC_NoImmediateQtyToFill','CancelBySmp','CancelByReduceOnly','unknown']){
    const f=fixture();await f.adapter.prepare(symbol,2);f.zeroIoc();const request=req('sell',false,`-diagnostic-${cause}`);
    const id=await f.adapter.place(request,.01,10000),native=f.orders.get(id!)!;
    native.rejectReason=cause==='EC_NoImmediateQtyToFill'?cause:cause==='unknown'?'PRIVATE signed payload':'EC_NoError';
    native.cancelType=cause.startsWith('Cancel')?cause:cause==='unknown'?'PRIVATE cancel type':'UNKNOWN';
    const result=await f.adapter.reconcile(request,undefined,id);
    assert.equal(result.status,'cancelled');assert.equal(result.filledQuantity,0);assert.equal(result.feeUsd,0);
    assert.equal(result.rejectionCode,cause==='unknown'?'BYBIT_CANCELLED_ZERO_FILL':cause);
    assert.match(result.rejectionReason!,/本单未形成新仓位/);assert.ok(!JSON.stringify(result).includes('PRIVATE'));
    if(cause==='unknown'){assert.match(result.rejectionReason!,/具体取消原因尚未识别/);assert.ok(!result.rejectionReason!.includes('无可立即成交数量'));}
  }
});

test('Bybit Filled REST receipts ignore rejection of a racing cancel request and keep actual fills',async()=>{
  const f=fixture();await f.adapter.prepare(symbol,2);const request=req('sell',false,'-filled-cancel-race');
  const id=await f.adapter.place(request,.01,10000),native=f.orders.get(id!)!;
  native.rejectReason='EC_OrigClOrdIDDoesNotExist';native.cancelType='CancelByUser';
  const result=await f.adapter.reconcile(request,undefined,id);
  assert.equal(result.status,'filled');assert.equal(result.filledQuantity,.01);assert.equal(result.feeUsd,.05);
  assert.equal(result.rejectionCode,undefined);assert.equal(result.rejectionReason,undefined);
});
