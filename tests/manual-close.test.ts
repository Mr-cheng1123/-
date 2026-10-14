import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Engine} from '../src/core/engine.js';
import {Store} from '../src/core/store.js';
import {defaultConfig} from '../src/shared/config.js';
import type {AccountPosition,ExchangeAdapter,ExchangeId,MarketSnapshot,OrderRequest,Position} from '../src/shared/types.js';
import type {ManualCloseRequest} from '../src/shared/manual-close.js';
import {executeScopedManualClose,verifyCloseSlots} from '../src/core/scoped-manual-close.js';

const symbol='ONE/USDT:USDT';
const nativeRow=(side:'long'|'short',quantity:number,marginMode:'crossed'|'isolated'='crossed'):AccountPosition=>({base:'ONE',symbol,side,quantity,marginMode,entryPrice:.0021,markPrice:.0021,leverage:2,liquidationPrice:0,positionOpenedAt:Date.now()-60000});
function quote(exchange:ExchangeId):MarketSnapshot{return {exchange,base:'ONE',symbol,timestamp:Date.now(),observedAt:Date.now(),source:'public',markPrice:.0021,indexPrice:.0021,fundingRate:0,nextFundingTime:Date.now()+3600000,intervalHours:8,fundingHistory:[],bids:[{price:.00209,quantity:1e8}],asks:[{price:.00211,quantity:1e8}],openInterestUsd:1e8,volume24hUsd:1e8,quantityStep:1,minQuantity:1,minNotional:1,contractSize:1};}
function original(quantity=55620):Position{return {id:'owned-one',base:'ONE',mode:'live',status:'open',long:{exchange:'gate',symbol,side:'long',quantity,entryPrice:.0021,markPrice:.0021,feesUsd:0,liquidationDistancePct:null},short:{exchange:'bitget',symbol,side:'short',quantity,entryPrice:.0021,markPrice:.0021,feesUsd:0,liquidationDistancePct:null},openedAt:Date.now()-60000,plannedExitAt:Date.now()+3600000,holdMode:'continuous',fundingUsd:0,feesUsd:0,transferCostUsd:0,spreadPnlUsd:0,realizedSpreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[]};}
function fixture(split=false,ownedQuantity?:number){
  const directory=mkdtempSync(path.join(tmpdir(),'manual-close-test-')),config={...defaultConfig,mode:'live' as const,dataSource:'public' as const,exchanges:['gate','bitget'] as ExchangeId[],symbols:['ONE'],maxOrderRetries:2};
  const store=new Store(path.join(directory,'state.json'),config),native=new Map<ExchangeId,AccountPosition[]>([['gate',split?[nativeRow('long',27810,'crossed'),nativeRow('long',27810,'isolated')]:[nativeRow('long',55620)]],['bitget',[nativeRow('short',55620)]]]);
  if(ownedQuantity!==undefined)store.data.positions.push(original(ownedQuantity));
  const sent:Array<{exchange:ExchangeId;request:OrderRequest}>=[],adapters:ExchangeAdapter[]=[];
  let unknown=false;
  const account=(exchange:ExchangeId)=>{
    const rows=native.get(exchange)!.filter(row=>row.quantity>0);
    const positions=exchange==='gate'&&rows.length>1?[{...rows[0],quantity:rows.reduce((sum,row)=>sum+row.quantity,0),splitPositionCount:rows.length,marginMode:undefined,positionId:undefined,positionOpenedAt:undefined}]:rows;
    return {freeUsd:1000,equityUsd:1000,positions:structuredClone(positions)};
  };
  for(const id of config.exchanges)adapters.push({id,fetchAccount:async()=>account(id),fetchClosePositions:async()=>structuredClone(native.get(id)!),fetchSnapshots:async()=>[quote(id)],fetchOpenOrders:async()=>[],fetchFundingPayments:async()=>[],close:async()=>{},prepareTrading:async()=>{throw new Error('Manual reductions must not alter trading settings');},validateOrder:async request=>{assert(request.reduceOnly);},
    placeOrder:async request=>{
      assert(request.reduceOnly);sent.push({exchange:id,request:structuredClone(request)});
      const row=native.get(id)!.find(row=>row.symbol===request.symbol&&row.side===(request.side==='sell'?'long':'short')&&(id!=='gate'||row.marginMode===request.closePosition?.marginMode&&row.positionId===request.closePosition?.positionId))!;
      assert(row);assert(request.quantity<=row.quantity);row.quantity-=request.quantity;
      return {id:`native-${sent.length}`,clientOrderId:request.clientOrderId,status:unknown?'unknown':'filled',filledQuantity:unknown?0:request.quantity,averagePrice:unknown?0:request.limitPrice,feeUsd:unknown?0:.01,timestamp:Date.now()};
    },cancelOrder:async()=>{throw new Error('No unrelated cancellation');},reconcileOrder:async request=>({id:'unknown',clientOrderId:request.clientOrderId,status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now()}),inspectOrder:async request=>({id:'unknown',clientOrderId:request.clientOrderId,status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now()})});
  const environment={ALLOW_LIVE_TRADING:'false',GATE_API_KEY:'fixture',GATE_API_SECRET:'fixture',BITGET_API_KEY:'fixture',BITGET_API_SECRET:'fixture',BITGET_PASSPHRASE:'fixture'};
  const options={adapterFactory:()=>adapters,liveEnvironment:environment},engine=new Engine(store,false,options);
  const request=(id='operation-one-001',owned=false):ManualCloseRequest=>({operationId:id,base:'ONE',expiresAt:Date.now()+45000,acknowledgement:owned?'CLOSE_SELECTED_POSITION':'CLOSE_SELECTED_ACCOUNT_POSITION',legs:config.exchanges.flatMap(exchange=>account(exchange).positions.map(row=>({exchange,symbol:row.symbol,side:row.side,quantity:row.quantity,accountPositionKey:JSON.stringify([exchange,row.symbol,row.side,row.marginMode??null,row.positionId??null]),...(row.positionOpenedAt?{positionOpenedAt:row.positionOpenedAt}:{})})))});
  return {engine,store,options,native,adapters,sent,request,setUnknown:()=>{unknown=true;},cleanup:async()=>{await engine.stop();rmSync(directory,{recursive:true,force:true});}};
}
function smallFixture(quantity=421){
  const f=fixture(false,quantity);for(const rows of f.native.values())for(const row of rows)row.quantity=quantity;return f;
}
function websocketQuote(exchange:ExchangeId):MarketSnapshot{return {...quote(exchange),bookTransport:'websocket',fundingObservedAt:Date.now()};}
async function observedScopedClose(f:ReturnType<typeof fixture>,operationId='scoped-observation'){
  const position=f.store.data.positions[0],selected=f.adapters.map(adapter=>({exchange:adapter.id,position:structuredClone(f.native.get(adapter.id)![0])}));
  f.store.operations.begin({id:operationId,positionId:position.id,base:position.base,mode:'live',origin:'manual',kind:'manual-close',protocol:'ioc',
    target:{long:position.long.quantity,short:position.short.quantity}});
  await executeScopedManualClose({store:f.store,position,selected,nativeSlots:new Map(),config:f.store.data.config,
    adapter:exchange=>f.adapters.find(adapter=>adapter.id===exchange)!,read:(_adapter,_key,call)=>call(),ensure:()=>{},
    message:error=>error instanceof Error?error.message:String(error)});
  return f.store.operations.snapshot().rows.find(row=>row.id===operationId)!;
}
function virtualClock(){
  const originalNow=Date.now;let now=1_000_000;Date.now=()=>now;
  return {advance:(ms:number)=>{now+=ms;},restore:()=>{Date.now=originalNow;}};
}
function trackCloseReads(f:ReturnType<typeof fixture>){
  const calls=new Map<string,number>();
  const validated:Array<{exchange:ExchangeId;request:OrderRequest}>=[];
  const count=(exchange:ExchangeId,method:string)=>calls.get(`${exchange}:${method}`)??0;
  const record=(exchange:ExchangeId,method:string)=>{const value=count(exchange,method)+1;calls.set(`${exchange}:${method}`,value);return value;};
  for(const a of f.adapters){
    const account=a.fetchAccount.bind(a),slots=a.fetchClosePositions!.bind(a),orders=a.fetchOpenOrders!.bind(a),validate=a.validateOrder!.bind(a);
    a.fetchAccount=async()=>{record(a.id,'account');return account();};
    a.fetchClosePositions=async selected=>{assert.equal(selected,symbol);record(a.id,'slots');return slots(selected);};
    a.fetchOpenOrders=async selected=>{assert.equal(selected,symbol);record(a.id,'orders');return orders(selected);};
    a.fetchTradingFee=async selected=>{assert.equal(selected,symbol);record(a.id,'fee');return {takerFeeRate:.0005,takerFeeAt:Date.now(),takerFeeSource:'exchange'};};
    a.validateOrder=async request=>{
      assert.equal(request.symbol,symbol);assert.equal(request.side,a.id==='gate'?'sell':'buy');assert.equal(request.reduceOnly,true);
      assert(Number.isInteger(request.quantity)&&request.quantity>=1);assert(Number.isFinite(request.limitPrice)&&request.limitPrice>0);
      record(a.id,'validate');validated.push({exchange:a.id,request:structuredClone(request)});await validate(request);
    };
  }
  return {count,validated,book:(exchange:ExchangeId)=>record(exchange,'book'),
    privateReads:()=>f.adapters.map(a=>[a.id,...['account','slots','orders','fee','validate'].map(method=>count(a.id,method))])};
}
function assertCloseReads(reads:ReturnType<typeof trackCloseReads>,batches:number,publicReads:number,validations=batches){
  for(const exchange of ['gate','bitget'] as const){
    assert.equal(reads.count(exchange,'book'),publicReads,`${exchange} public book reads`);
    assert.equal(reads.count(exchange,'fee'),batches,`${exchange} fee reads occur only in normal batch refreshes`);
    assert.equal(reads.count(exchange,'account'),exchange==='gate'?1:batches+1,`${exchange} account reads`);
    assert.equal(reads.count(exchange,'slots'),exchange==='gate'?batches+1:0,`${exchange} native slot reads`);
    assert.equal(reads.count(exchange,'orders'),1,`${exchange} initial open-order read`);
    assert.equal(reads.count(exchange,'validate'),validations,`${exchange} native validations`);
  }
}
function assertCloseReceipts(f:ReturnType<typeof fixture>,quantities:number[],prices:number[]=quantities.map((_,index)=>index%2===0?.00209:.00211)){
  assert.deepEqual(f.sent.map(row=>row.request.quantity),quantities);
  assert.deepEqual(f.sent.map(row=>row.request.limitPrice),prices);
  assert.equal(f.store.data.orders.length,quantities.length);
  for(const journal of f.store.data.orders){
    assert.equal(journal.request.symbol,symbol);assert.equal(journal.request.reduceOnly,true);
    assert.equal(journal.result!.status,'filled');assert.equal(journal.result!.filledQuantity,journal.request.quantity);
    assert.equal(journal.result!.averagePrice,journal.request.limitPrice);assert.equal(journal.result!.feeUsd,.01);
    assert.equal(journal.result!.clientOrderId,journal.request.clientOrderId);
    assert(journal.result!.timestamp>=journal.createdAt&&journal.result!.timestamp<=Date.now());
  }
}

test('locked manual owned close independently reduces the selected pair without starting or unlocking anything',async()=>{
  const f=fixture(false,55620);try{
    f.store.data.killSwitch=true;assert.equal(f.engine.liveUnlocked,false);
    const result=await f.engine.close('owned-one',f.request('owned-operation-1',true));
    assert.equal(result.id,'owned-one');assert.equal(result.status,'closed',result.riskReasons.join(';'));
    assert.equal(result.manualCloseOperationId,'owned-operation-1');assert.equal(f.sent.length,2);
    assert.equal(f.engine.liveUnlocked,false);assert.equal(f.engine.autoEnabled,false);assert.equal(f.store.data.killSwitch,true);
  }finally{await f.cleanup();}
});
test('Gate ONE aggregate 55620 closes exact cross and isolated 27810 slots with matched peer batches',async()=>{
  const f=fixture(true,27810);try{
    const result=await f.engine.close('owned-one',f.request('split-operation-1',true));
    assert.equal(result.id,'manual-close-split-operation-1');assert.equal(result.status,'closed',result.riskReasons.join(';'));
    assert.equal(result.manualCloseSourcePositionId,'owned-one');assert.equal(f.store.data.positions.find(row=>row.id==='owned-one')!.long.quantity,27810);
    assert.deepEqual(f.sent.map(row=>row.request.quantity),[27810,27810,27810,27810]);
    assert.deepEqual(f.sent.filter(row=>row.exchange==='gate').map(row=>row.request.closePosition?.marginMode),['crossed','isolated']);
    assert(f.sent.every(row=>row.request.reduceOnly));assert.equal(f.engine.liveUnlocked,false);
    for(const rows of f.native.values())assert(rows.every(row=>row.quantity===0));
  }finally{await f.cleanup();}
});
test('double click, lost response replay and process reload never resubmit an operation ID',async()=>{
  const f=fixture();try{
    const request=f.request();const [a,b]=await Promise.all([f.engine.closeAccountPosition(request),f.engine.closeAccountPosition(request)]);
    assert.equal(a.id,b.id);assert.equal(f.sent.length,2);await f.engine.closeAccountPosition(request);assert.equal(f.sent.length,2);
    const reloaded=new Store(f.store.path,f.store.data.config),engine=new Engine(reloaded,false,f.options);
    try{const replay=await engine.closeAccountPosition(request);assert.equal(replay.id,a.id);assert.equal(f.sent.length,2);}finally{await engine.stop();}
    await assert.rejects(f.engine.closeAccountPosition({...request,legs:[{...request.legs[0],quantity:1}]}),/另一项选择/);
  }finally{await f.cleanup();}
});
test('quantity changes and expired selections fail before any order and publish a failed receipt',async()=>{
  const f=fixture();try{
    const request=f.request();f.native.get('bitget')![0].quantity+=1;
    await assert.rejects(f.engine.closeAccountPosition(request),/实际持仓数量已变化/);assert.equal(f.sent.length,0);
    const receipt=f.engine.state().manualCloseOperations!.find(row=>row.id===request.operationId)!;assert.equal(receipt.state,'failed');assert(receipt.error);assert.equal(receipt.positionId,undefined);
    await assert.rejects(f.engine.closeAccountPosition({...f.request('expired-operation'),expiresAt:Date.now()-1}),/过期/);assert.equal(f.sent.length,0);
  }finally{await f.cleanup();}
});
test('unknown child order stops further reductions and neither restart nor a new click duplicates it',async()=>{
  const f=fixture(true);try{
    const request=f.request();f.setUnknown();const result=await f.engine.closeAccountPosition(request);
    assert.equal(result.status,'attention');assert.equal(f.sent.length,2);
    await f.engine.closeAccountPosition(request);assert.equal(f.sent.length,2);
    await assert.rejects(f.engine.closeAccountPosition(f.request('another-operation')),/未确认订单/);assert.equal(f.sent.length,2);
    await assert.rejects(f.engine.close(result.id),/只读锁定|重新确认/);assert.equal(f.sent.length,2);
    await (f.engine as any).managePosition(result,Date.now());assert.equal(f.sent.length,2);
  }finally{await f.cleanup();}
});
test('only explicitly selected single short is reduced; opposite direction and other markets remain intact',async()=>{
  const f=fixture();try{
    const opposite=nativeRow('long',123);f.native.get('bitget')!.push(opposite);const unrelated={...nativeRow('long',456),base:'XAU',symbol:'XAU/USDT:USDT'};f.native.get('gate')!.push(unrelated);
    const request=f.request();request.legs=request.legs.filter(row=>row.exchange==='bitget'&&row.side==='short');
    const result=await f.engine.closeAccountPosition(request);assert.equal(result.status,'closed',result.riskReasons.join(';'));
    assert.equal(f.sent.length,1);assert.equal(f.sent[0].exchange,'bitget');assert.equal(opposite.quantity,123);assert.equal(unrelated.quantity,456);assert.equal(f.native.get('gate')![0].quantity,55620);
  }finally{await f.cleanup();}
});
test('new same-size native cycle cannot replace the selected slot between reads',()=>{
  const selected=nativeRow('long',100);assert.throws(()=>verifyCloseSlots(selected,[{...selected,positionOpenedAt:selected.positionOpenedAt!+1000}]),/身份|周期/);
  assert.throws(()=>verifyCloseSlots(selected,[{...selected,quantity:NaN}]),/无效/);
});
test('preflight interrupted by restart becomes visible failed without creating an order or position',async()=>{
  const f=fixture();try{
    f.store.data.manualCloseOperations=[{id:'interrupted-operation',createdAt:Date.now(),expiresAt:Date.now()+45000,state:'checking',selection:'test'}];f.store.save();
    const reloaded=new Engine(new Store(f.store.path,f.store.data.config),false,f.options);
    try{assert.equal(reloaded.state().manualCloseOperations![0].state,'failed');assert.equal(f.sent.length,0);}finally{await reloaded.stop();}
  }finally{await f.cleanup();}
});
test('single short unknown reduction resolves from an exact terminal read after restart, without a second order',async()=>{
  const f=fixture();try{
    const request=f.request();request.legs=request.legs.filter(row=>row.exchange==='bitget');f.setUnknown();
    const result=await f.engine.closeAccountPosition(request);assert.equal(result.status,'attention');assert.equal(f.sent.length,1);
    assert.equal(result.long.exchange,result.short.exchange);assert.equal(result.long.quantity,0);
    const reloaded=new Engine(new Store(f.store.path,f.store.data.config),false,f.options);
    try{
      const journal=reloaded.store.data.orders[0],position=reloaded.store.data.positions.find(row=>row.id===result.id)!;
      const applied=reloaded.execution.applyObservedOrder(journal,{id:journal.result!.id,clientOrderId:journal.request.clientOrderId,status:'filled',filledQuantity:journal.request.quantity,averagePrice:journal.request.limitPrice,feeUsd:.01,timestamp:Date.now()});
      assert.equal(applied,true);assert.equal(position.short.quantity,0);assert.equal(position.long.quantity,0);assert.equal(f.sent.length,1);
      await (reloaded as any).managePosition(position,Date.now());assert.equal(f.sent.length,1);
    }finally{await reloaded.stop();}
  }finally{await f.cleanup();}
});
test('a queued selection cannot inherit a later credential/permission generation',async()=>{
  const f=fixture();let release!:()=>void;try{
    const held=f.engine.exclusive(()=>new Promise<void>(resolve=>{release=resolve;}));await new Promise<void>(resolve=>setImmediate(resolve));
    const request=f.request(),operation=f.engine.closeAccountPosition(request);(f.engine as any).startGeneration++;release();await held;
    await assert.rejects(operation,/运行状态或账户配置/);assert.equal(f.sent.length,0);assert.equal(f.store.data.positions.length,0);
  }finally{release?.();await f.cleanup();}
});
test('imported exit ledger is explicitly incomplete and does not duplicate original lifecycle totals',async()=>{
  const f=fixture(true,27810);try{
    const before=f.engine.state().totals,position=await f.engine.close('owned-one',f.request('incomplete-ledger',true));
    assert.equal(position.manualCloseAccountRecord,true);assert.equal(f.engine.state().totals.feesUsd,before.feesUsd);
    assert.equal(f.engine.state().totals.netPnlUsd,before.netPnlUsd);assert(position.feesUsd>0);
  }finally{await f.cleanup();}
});
test('new click during a credential update is rejected before it can capture the replacement account',async()=>{
  const f=fixture();try{
    (f.engine as any).credentialUpdatePending=true;
    await assert.rejects(f.engine.closeAccountPosition(f.request()),/凭据正在更新/);assert.equal(f.sent.length,0);
    assert.equal(f.store.data.manualCloseOperations?.length??0,0);
  }finally{(f.engine as any).credentialUpdatePending=false;await f.cleanup();}
});

test('a slow peer account cannot age the first WS book before scoped close planning',async()=>{
  const clock=virtualClock(),f=smallFixture();try{
    const bitget=f.adapters.find(row=>row.id==='bitget')!,account=bitget.fetchAccount.bind(bitget);
    let accountReads=0,verifiedAt=0;const bookTimes:number[]=[];
    bitget.fetchAccount=async()=>{
      const value=await account();if(++accountReads===2){await new Promise<void>(resolve=>setImmediate(resolve));clock.advance(2101);verifiedAt=Date.now();}return value;
    };
    for(const a of f.adapters)a.fetchExecutionSnapshots=async()=>{bookTimes.push(Date.now());return [websocketQuote(a.id)];};
    const result=await f.engine.close('owned-one',f.request('slow-account-book',true));
    assert.equal(result.status,'closed',result.riskReasons.join(';'));assert.equal(f.sent.length,2);
    assert.equal(bookTimes.length,2);assert(bookTimes.every(at=>at>=verifiedAt));
    assert.equal(f.engine.autoEnabled,false);assert.equal(f.engine.liveUnlocked,false);
  }finally{clock.restore();await f.cleanup();}
});

test('exact fresh WS updates remain usable after native validation ages the captured books',async()=>{
  const clock=virtualClock(),f=smallFixture();try{
    const streams=new Map<ExchangeId,MarketSnapshot>();
    for(const a of f.adapters){
      a.fetchExecutionSnapshots=async()=>{const value=websocketQuote(a.id);streams.set(a.id,value);return [value];};
      a.getExecutionSnapshot=()=>streams.get(a.id);
    }
    f.adapters[1].validateOrder=async()=>{
      await new Promise<void>(resolve=>setImmediate(resolve));clock.advance(2101);
      for(const a of f.adapters)streams.set(a.id,websocketQuote(a.id));
    };
    const result=await f.engine.close('owned-one',f.request('validation-new-ws',true));
    assert.equal(result.status,'closed',result.riskReasons.join(';'));assert.equal(f.sent.length,2);
    assert.deepEqual(f.sent.map(row=>row.request.limitPrice),[.00209,.00211]);
    assert(f.sent.every(row=>row.request.quantity===421&&row.request.reduceOnly));
  }finally{clock.restore();await f.cleanup();}
});

test('another contract stream cannot refresh the selected stale quote or create an intent',async()=>{
  for(const invalid of ['foreign','expired'] as const){
    const clock=virtualClock(),f=smallFixture();try{
      const reads=trackCloseReads(f);let afterValidation=false;
      for(const a of f.adapters){
        a.fetchExecutionSnapshots=async()=>{
          reads.book(a.id);const value=websocketQuote(a.id);
          return [!afterValidation?value:invalid==='foreign'?{...value,symbol:'OTHER/USDT:USDT',base:'OTHER'}:
            {...value,observedAt:Date.now()-2101}];
        };
        a.getExecutionSnapshot=()=>({...websocketQuote(a.id),symbol:'OTHER/USDT:USDT',base:'OTHER'});
      }
      const bitget=f.adapters[1],validate=bitget.validateOrder!.bind(bitget);
      bitget.validateOrder=async request=>{await validate(request);afterValidation=true;clock.advance(2101);};
      const result=await f.engine.close('owned-one',f.request(`wrong-stream-${invalid}`,true));
      assert.equal(result.status,'attention');assert.equal(f.sent.length,0);assert.equal(f.store.data.orders.length,0);
      assert.match(result.riskReasons.join(';'),invalid==='foreign'?/缺少.*盘口/:/过期/);
      assert.equal(result.long.quantity,421);assert.equal(result.short.quantity,421);assertCloseReads(reads,1,4);
    }finally{clock.restore();await f.cleanup();}
  }
});

test('stale books retry three times without repeating account checks and expose a completed residual',async()=>{
  const clock=virtualClock(),f=smallFixture();try{
    const bookReads=new Map<ExchangeId,number>(),accountReads=new Map<ExchangeId,number>();
    for(const a of f.adapters){
      if(a.id==='gate'){
        const nativeSlots=a.fetchClosePositions!.bind(a);
        a.fetchClosePositions=async()=>{accountReads.set(a.id,(accountReads.get(a.id)??0)+1);return nativeSlots(symbol);};
      }else{
        const nativeAccount=a.fetchAccount.bind(a);
        a.fetchAccount=async()=>{accountReads.set(a.id,(accountReads.get(a.id)??0)+1);return nativeAccount();};
      }
      a.fetchExecutionSnapshots=async()=>{
        bookReads.set(a.id,(bookReads.get(a.id)??0)+1);const value=websocketQuote(a.id);
        return [{...value,observedAt:Date.now()-2101}];
      };
    }
    const request=f.request('stale-books-bounded',true),result=await f.engine.close('owned-one',request);
    assert.equal(result.status,'attention');assert.equal(f.sent.length,0);
    assert.deepEqual([...bookReads.values()],[3,3]);assert.deepEqual([...accountReads.values()],[2,2]);
    assert.match(result.riskReasons.join(';'),/盘口已过期/);assert.match(result.riskReasons.join(';'),/本次手动平仓已结束/);
    const receipt=f.engine.state().manualCloseOperations!.find(row=>row.id===request.operationId)!;
    assert.equal(receipt.state,'completed');assert.match(receipt.error!,/过期/);
    await f.engine.close('owned-one',request);assert.equal(f.sent.length,0);assert.deepEqual([...bookReads.values()],[3,3]);
  }finally{clock.restore();await f.cleanup();}
});

test('fresh but asynchronous quotes report skew rather than blaming visible quantity',async()=>{
  const clock=virtualClock(),f=smallFixture();try{
    let bookReads=0;
    for(const a of f.adapters)a.fetchExecutionSnapshots=async()=>{bookReads++;return [{...quote(a.id),observedAt:Date.now()-(a.id==='gate'?3501:0)}];};
    const result=await f.engine.close('owned-one',f.request('book-skew-bounded',true));
    assert.equal(result.status,'attention');assert.equal(f.sent.length,0);assert.equal(bookReads,6);
    assert.match(result.riskReasons.join(';'),/不同步/);assert.doesNotMatch(result.riskReasons.join(';'),/数量不足/);
  }finally{clock.restore();await f.cleanup();}
});

test('a fresh single-side top smaller than one lot reports capacity without an absent-leg expiry',async()=>{
  const f=smallFixture();try{
    for(const a of f.adapters)a.fetchExecutionSnapshots=async()=>[{...quote(a.id),bids:[{price:.00209,quantity:.5}],asks:[{price:.00211,quantity:.5}]}];
    const request=f.request('single-top-capacity');request.legs=request.legs.filter(row=>row.exchange==='bitget');
    const result=await f.engine.closeAccountPosition(request);
    assert.equal(result.status,'attention');assert.equal(f.sent.length,0);
    assert.match(result.riskReasons.join(';'),/可成交数量不足合法减仓批量/);assert.doesNotMatch(result.riskReasons.join(';'),/过期/);
    assert.equal(result.short.quantity,421);assert.equal(f.native.get('gate')![0].quantity,421);
  }finally{await f.cleanup();}
});

test('eight known BBO close batches end with exact residual and only a fresh click can finish it',async()=>{
  const f=smallFixture();try{
    for(const a of f.adapters)a.fetchExecutionSnapshots=async()=>[{...quote(a.id),
      bids:[{price:.00209,quantity:1007}],asks:[{price:.00211,quantity:a.id==='bitget'?46:1007}]}];
    const request=f.request('eight-close-batches',true),result=await f.engine.close('owned-one',request);
    assert.equal(f.sent.length,16);assert.equal(result.status,'attention');assert.equal(result.long.quantity,53);assert.equal(result.short.quantity,53);
    assert.match(result.riskReasons.join(';'),/轮数已到/);assert.match(result.riskReasons.join(';'),/重新确认/);
    assert.equal(f.engine.state().manualCloseOperations!.find(row=>row.id===request.operationId)!.state,'completed');
    await f.engine.close('owned-one',request);await (f.engine as any).managePosition(result,Date.now());assert.equal(f.sent.length,16);
    const closed=await f.engine.close('owned-one',f.request('remaining-fresh-click',true));
    assert.equal(closed.status,'closed',closed.riskReasons.join(';'));assert.equal(f.sent.length,20);
    assert.deepEqual(f.sent.slice(16).map(row=>row.request.quantity),[46,46,7,7]);
    assert.equal(f.engine.autoEnabled,false);assert.equal(f.engine.liveUnlocked,false);
  }finally{await f.cleanup();}
});

test('scoped refresh cannot extend the original thirty-second window by retrying books',async()=>{
  const clock=virtualClock(),f=smallFixture();try{
    let reads=0;
    for(const a of f.adapters)a.fetchExecutionSnapshots=async()=>{
      reads++;if(a.id==='bitget')clock.advance(30001);return [websocketQuote(a.id)];
    };
    const result=await f.engine.close('owned-one',f.request('scoped-thirty-second',true));
    assert.equal(result.status,'attention');assert.equal(f.sent.length,0);assert.equal(reads,2);
    assert.match(result.riskReasons.join(';'),/处理窗口已结束/);assert.equal(result.long.quantity,421);
  }finally{clock.restore();await f.cleanup();}
});

test('completed scoped residual survives restart as attention and its exact operation stays idempotent',async()=>{
  const f=smallFixture();try{
    const request=f.request('completed-legacy-close',true),selection=JSON.stringify({sourceId:'owned-one',base:request.base,acknowledgement:request.acknowledgement,
      legs:request.legs.map(leg=>({exchange:leg.exchange,symbol:leg.symbol,side:leg.side,quantity:leg.quantity,accountPositionKey:leg.accountPositionKey,
        positionOpenedAt:leg.positionOpenedAt??null})).sort((a,b)=>`${a.exchange}:${a.symbol}:${a.side}`.localeCompare(`${b.exchange}:${b.symbol}:${b.side}`))});
    const p=f.store.data.positions[0];p.status='closing';p.manualCloseOnly=true;p.manualCloseOperationId=request.operationId;p.closeRequestedAt=Date.now();
    f.store.data.manualCloseOperations=[{id:request.operationId,selection,createdAt:Date.now(),expiresAt:request.expiresAt,state:'completed',positionId:p.id}];f.store.save();
    const reloaded=new Engine(new Store(f.store.path,f.store.data.config),false,f.options);
    try{
      const replay=await reloaded.close('owned-one',request);assert.equal(replay.status,'attention');assert.equal(replay.manualCloseOperationId,request.operationId);
      assert.equal(replay.long.quantity,421);assert.equal(f.sent.length,0);
      await (reloaded as any).managePosition(replay,Date.now());assert.equal(f.sent.length,0);
      assert.equal(reloaded.state().manualCloseOperations![0].state,'completed');
    }finally{await reloaded.stop();}
  }finally{await f.cleanup();}
});

test('a second scoped batch refreshes public books after slow validation and finishes the original 421 selection',async()=>{
  const clock=virtualClock(),f=smallFixture();try{
    const reads=trackCloseReads(f),streams=new Map<ExchangeId,MarketSnapshot>(),postValidationTimes:number[]=[];
    let privateAtValidation:ReturnType<typeof reads.privateReads>|undefined;
    let secondValidationComplete=false;
    for(const a of f.adapters){
      a.fetchExecutionSnapshots=async()=>{
        reads.book(a.id);const quantity=f.sent.length===0?200:221;
        const value={...(secondValidationComplete?quote(a.id):websocketQuote(a.id)),
          bids:[{price:.00209,quantity}],asks:[{price:.00211,quantity}]};
        if(!secondValidationComplete)streams.set(a.id,value);
        else {assert.deepEqual(reads.privateReads(),privateAtValidation);postValidationTimes.push(Date.now());}
        return [value];
      };
      a.getExecutionSnapshot=()=>streams.get(a.id);
    }
    const bitget=f.adapters[1],validate=bitget.validateOrder!.bind(bitget);
    bitget.validateOrder=async request=>{
      await validate(request);
      if(reads.count('bitget','validate')===2){
        assert.equal(f.sent.length,2);assert(f.native.get('gate')!.every(row=>row.quantity===221));
        assert(f.native.get('bitget')!.every(row=>row.quantity===221));
        privateAtValidation=reads.privateReads();await new Promise<void>(resolve=>setImmediate(resolve));clock.advance(2101);secondValidationComplete=true;
      }
    };
    const request=f.request('second-batch-public-refresh',true),startedAt=Date.now();
    const result=await f.engine.close('owned-one',request);
    assert.equal(result.status,'closed',result.riskReasons.join(';'));assert.equal(result.long.quantity,0);assert.equal(result.short.quantity,0);
    assertCloseReceipts(f,[200,200,221,221]);assertCloseReads(reads,2,3);
    assert.deepEqual(postValidationTimes,[startedAt+2101,startedAt+2101]);
    assert([...streams.values()].every(value=>value.observedAt===startedAt),'no new WS observation follows the slow validation');
    assert(Date.now()<startedAt+30000&&Date.now()<request.expiresAt);assert.equal(result.feesUsd,.04);
    const receipt=f.engine.state().manualCloseOperations!.find(row=>row.id===request.operationId)!;
    assert.equal(receipt.state,'completed');assert.equal(f.store.data.manualCloseOperations!.find(row=>row.id===request.operationId)!.expiresAt,request.expiresAt);
    assert.equal(f.engine.autoEnabled,false);assert.equal(f.engine.liveUnlocked,false);
  }finally{clock.restore();await f.cleanup();}
});

test('post-validation stale public books retry at most three times without repeating native account or fee reads',async()=>{
  const clock=virtualClock(),f=smallFixture();try{
    const reads=trackCloseReads(f),streams=new Map<ExchangeId,MarketSnapshot>();
    for(const a of f.adapters){
      a.fetchExecutionSnapshots=async()=>{
        const ordinal=reads.book(a.id),value=websocketQuote(a.id);
        if(ordinal===1){streams.set(a.id,value);return [value];}
        return [ordinal<4?{...value,observedAt:Date.now()-2101}:quote(a.id)];
      };
      a.getExecutionSnapshot=()=>streams.get(a.id);
    }
    const bitget=f.adapters[1],validate=bitget.validateOrder!.bind(bitget);
    bitget.validateOrder=async request=>{await validate(request);clock.advance(2101);};
    const request=f.request('post-validation-third-public-read',true),startedAt=Date.now();
    const result=await f.engine.close('owned-one',request);
    assert.equal(result.status,'closed',result.riskReasons.join(';'));assert.equal(result.long.quantity,0);assert.equal(result.short.quantity,0);
    assertCloseReceipts(f,[421,421]);assertCloseReads(reads,1,4);
    assert(Date.now()<startedAt+30000&&Date.now()<request.expiresAt);assert.equal(result.feesUsd,.02);
  }finally{clock.restore();await f.cleanup();}
});

test('post-validation individually fresh public books with excessive skew stop before either new intent',async()=>{
  const clock=virtualClock(),f=smallFixture();try{
    const reads=trackCloseReads(f);let afterValidation=false;
    for(const a of f.adapters)a.fetchExecutionSnapshots=async()=>{
      reads.book(a.id);return [afterValidation?{...quote(a.id),observedAt:Date.now()-(a.id==='gate'?3501:0)}:websocketQuote(a.id)];
    };
    const bitget=f.adapters[1],validate=bitget.validateOrder!.bind(bitget);
    bitget.validateOrder=async request=>{await validate(request);afterValidation=true;clock.advance(2101);};
    const result=await f.engine.close('owned-one',f.request('post-validation-public-skew',true));
    assert.equal(result.status,'attention');assert.equal(f.sent.length,0);assert.equal(f.store.data.orders.length,0);
    assert.equal(result.long.quantity,421);assert.equal(result.short.quantity,421);assertCloseReads(reads,1,4);
    assert.match(result.riskReasons.join(';'),/不同步/);assert.doesNotMatch(result.riskReasons.join(';'),/数量不足/);
  }finally{clock.restore();await f.cleanup();}
});

test('a post-validation public read cannot extend the original thirty-second scoped close window',async()=>{
  const clock=virtualClock(),f=smallFixture();try{
    const reads=trackCloseReads(f);
    for(const a of f.adapters)a.fetchExecutionSnapshots=async()=>{
      const ordinal=reads.book(a.id);if(ordinal===2&&a.id==='bitget')clock.advance(27900);
      return [ordinal===1?websocketQuote(a.id):quote(a.id)];
    };
    const bitget=f.adapters[1],validate=bitget.validateOrder!.bind(bitget);
    bitget.validateOrder=async request=>{await validate(request);clock.advance(2101);};
    const request=f.request('post-validation-original-deadline',true),startedAt=Date.now();
    const result=await f.engine.close('owned-one',request);
    assert.equal(result.status,'attention');assert.equal(f.sent.length,0);assert.equal(f.store.data.orders.length,0);
    assert.equal(result.long.quantity,421);assert.equal(result.short.quantity,421);assertCloseReads(reads,1,2);
    assert.equal(Date.now()-startedAt,30001);assert(Date.now()<request.expiresAt);
    assert.match(result.riskReasons.join(';'),/处理窗口已结束/);
    const receipt=f.engine.state().manualCloseOperations!.find(row=>row.id===request.operationId)!;
    assert.equal(receipt.state,'completed');assert.equal(f.store.data.manualCloseOperations!.find(row=>row.id===request.operationId)!.expiresAt,request.expiresAt);
  }finally{clock.restore();await f.cleanup();}
});

test('failed post-validation public reads stop after three attempts and preserve the exact selected exposure',async()=>{
  const clock=virtualClock(),f=smallFixture();try{
    const reads=trackCloseReads(f);let afterValidation=false;
    for(const a of f.adapters)a.fetchExecutionSnapshots=async()=>{
      reads.book(a.id);if(afterValidation)throw new Error('Synthetic public book read failure');return [websocketQuote(a.id)];
    };
    const bitget=f.adapters[1],validate=bitget.validateOrder!.bind(bitget);
    bitget.validateOrder=async request=>{await validate(request);afterValidation=true;clock.advance(2101);};
    const request=f.request('post-validation-public-failure',true),result=await f.engine.close('owned-one',request);
    assert.equal(result.status,'attention');assert.equal(f.sent.length,0);assert.equal(f.store.data.orders.length,0);
    assert.equal(result.long.quantity,421);assert.equal(result.short.quantity,421);assertCloseReads(reads,1,4);
    assert.equal(f.native.get('gate')![0].quantity,421);assert.equal(f.native.get('bitget')![0].quantity,421);
    assert.equal(f.engine.state().manualCloseOperations!.find(row=>row.id===request.operationId)!.state,'completed');
    await f.engine.close('owned-one',request);assertCloseReads(reads,1,4);assert.equal(f.sent.length,0);
  }finally{clock.restore();await f.cleanup();}
});

test('fresh post-validation public price or capacity changes cannot expand the prepared reduction',async()=>{
  for(const changed of ['price','capacity'] as const){
    const clock=virtualClock(),f=smallFixture();try{
      const reads=trackCloseReads(f);let validationRound=0;
      for(const a of f.adapters)a.fetchExecutionSnapshots=async()=>{
        reads.book(a.id);const value=websocketQuote(a.id);
        return [validationRound===0?value:{...value,
          bids:[{price:changed==='price'?Number((.00209-validationRound*.00001).toFixed(5)):.00209,quantity:changed==='capacity'?.5:1e8}],
          asks:[{price:changed==='price'?Number((.00211+validationRound*.00001).toFixed(5)):.00211,quantity:changed==='capacity'?.5:1e8}]}];
      };
      const bitget=f.adapters[1],validate=bitget.validateOrder!.bind(bitget);
      bitget.validateOrder=async request=>{await validate(request);validationRound++;clock.advance(2101);};
      const result=await f.engine.close('owned-one',f.request(`post-validation-${changed}-change`,true));
      assert.equal(result.status,'attention');assert.equal(f.sent.length,0);assert.equal(f.store.data.orders.length,0);
      assert.equal(result.long.quantity,421);assert.equal(result.short.quantity,421);
      assertCloseReads(reads,1,changed==='price'?4:2,changed==='price'?3:1);
      assert.match(result.riskReasons.join(';'),/首档盘口已变化|不足.*合法|条件.*满足/);
    }finally{clock.restore();await f.cleanup();}
  }
});

test('a legal refreshed scoped price or smaller BBO batch is revalidated before closing without duplicate private refreshes',async()=>{
  for(const changed of ['price','capacity'] as const){
    const clock=virtualClock(),f=smallFixture();try{
      const reads=trackCloseReads(f);let afterValidation=false;
      for(const a of f.adapters)a.fetchExecutionSnapshots=async()=>{
        reads.book(a.id);const value=websocketQuote(a.id),quantity=changed==='capacity'&&afterValidation?(f.sent.length===0?200:221):1e8;
        return [{...value,bids:[{price:changed==='price'&&afterValidation?.00208:.00209,quantity}],
          asks:[{price:changed==='price'&&afterValidation?.00212:.00211,quantity}]}];
      };
      const bitget=f.adapters[1],validate=bitget.validateOrder!.bind(bitget);
      bitget.validateOrder=async request=>{
        await validate(request);
        if(reads.count('bitget','validate')===1){afterValidation=true;clock.advance(2101);}
      };
      const request=f.request(`legal-post-validation-${changed}`,true),startedAt=Date.now();
      const result=await f.engine.close('owned-one',request);
      assert.equal(result.status,'closed',result.riskReasons.join(';'));assert.equal(result.long.quantity,0);assert.equal(result.short.quantity,0);
      if(changed==='price'){
        assertCloseReceipts(f,[421,421],[.00208,.00212]);assertCloseReads(reads,1,2,2);
      }else{
        assertCloseReceipts(f,[200,200,221,221]);assertCloseReads(reads,2,3,3);
      }
      for(const sent of f.sent)assert(reads.validated.some(row=>row.exchange===sent.exchange&&
        JSON.stringify(row.request)===JSON.stringify(sent.request)),'every submitted replacement is validated with its actual ID, quantity and limit');
      assert(Date.now()<startedAt+30000&&Date.now()<request.expiresAt);
      assert.equal(f.engine.state().manualCloseOperations!.find(row=>row.id===request.operationId)!.state,'completed');
      assert(f.native.get('gate')!.every(row=>row.quantity===0));assert(f.native.get('bitget')!.every(row=>row.quantity===0));
    }finally{clock.restore();await f.cleanup();}
  }
});

test('scoped operation uses its actual thirty-second worker window and does not infer account completion from filled orders',async()=>{
  const clock=virtualClock(),f=smallFixture();try{
    const reads=trackCloseReads(f),startedAt=Date.now(),row=await observedScopedClose(f);
    assert.equal(row.windowEndsAt,startedAt+30000);assert.equal(f.sent.length,2);assert.equal(f.store.data.positions[0].status,'closed');
    assert.deepEqual(row.remaining,{long:0,short:0});assert.deepEqual(row.confirmed,{long:421,short:421});
    assert.equal(row.stages.accountConfirmedAt,undefined,'The last existing account read preceded the final fill.');
    assert.notEqual(row.state,'complete');assert.match(row.waitReason?.text??'',/等待账户数量核对/);
    assert.equal(reads.count('gate','slots'),1);assert.equal(reads.count('bitget','account'),1,'Diagnostics must not add a final account GET.');
  }finally{clock.restore();await f.cleanup();}
});

test('scoped partial diagnostic ends with exact confirmed residual, while unknown original remains unresolved',async()=>{
  const f=smallFixture();try{
    for(const adapter of f.adapters)adapter.fetchExecutionSnapshots=async()=>[{...quote(adapter.id),bids:[{price:.00209,quantity:40}],asks:[{price:.00211,quantity:40}]}];
    const row=await observedScopedClose(f);
    assert.equal(row.state,'partial');assert(row.endedAt);assert.equal(row.confirmed.long,320);assert.equal(row.remaining.long,101);
    assert.equal(row.confirmed.short,320);assert.equal(row.remaining.short,101);assert.equal(f.sent.length,16);
  }finally{await f.cleanup();}
  const unknown=smallFixture();try{
    unknown.setUnknown();const row=await observedScopedClose(unknown);
    assert.equal(row.state,'unknown');assert.equal(row.endedAt,undefined);assert(row.attempts.unknown>0);
    assert.equal(unknown.sent.length,2);assert.match(row.waitReason?.text??'',/禁止重复减仓/);
  }finally{await unknown.cleanup();}
});

test('scoped window expiry records unsuccessful preparation without extending authorization or adding orders',async()=>{
  const clock=virtualClock(),f=smallFixture();try{
    let books=0;
    for(const adapter of f.adapters)adapter.fetchExecutionSnapshots=async()=>{books++;if(adapter.id==='bitget')clock.advance(30001);return [quote(adapter.id)];};
    const startedAt=Date.now(),row=await observedScopedClose(f);
    assert.equal(row.windowEndsAt,startedAt+30000);assert.equal(row.state,'failed');assert(row.endedAt);
    assert.equal(row.attempts.preflightNotSent,1);assert.match(row.waitReason?.text??'',/处理窗口已结束/);
    assert.equal(books,2);assert.equal(f.sent.length,0);assert.equal(f.store.data.positions[0].long.quantity,421);
  }finally{clock.restore();await f.cleanup();}
});

test('scoped trading remains unchanged when every diagnostic method throws',async()=>{
  const f=smallFixture(),tracker=f.store.operations;try{
    Object.defineProperty(f.store,'operations',{value:new Proxy(tracker,{get:()=>()=>{throw new Error('diagnostic probe');}}),configurable:true});
    // Exercise the already-authorized worker with a failed diagnostic dependency.
    const position=f.store.data.positions[0],selected=f.adapters.map(adapter=>({exchange:adapter.id,position:structuredClone(f.native.get(adapter.id)![0])}));
    await executeScopedManualClose({store:f.store,position,selected,nativeSlots:new Map(),config:f.store.data.config,
      adapter:exchange=>f.adapters.find(adapter=>adapter.id===exchange)!,read:(_adapter,_key,call)=>call(),ensure:()=>{},message:error=>String(error)});
    assert.equal(position.status,'closed');assert.equal(f.sent.length,2);assert.equal(f.engine.liveUnlocked,false);
  }finally{Object.defineProperty(f.store,'operations',{value:tracker,configurable:true});await f.cleanup();}
});

test('known zero-fill manual calls remain unsuccessful rather than being labeled partially completed',async()=>{
  const f=smallFixture();try{
    for(const adapter of f.adapters)adapter.placeOrder=async request=>{
      f.sent.push({exchange:adapter.id,request:structuredClone(request)});
      return {id:`zero-${f.sent.length}`,clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now()};
    };
    const row=await observedScopedClose(f);
    assert.equal(row.state,'failed');assert(row.attempts.submitted>0);assert(row.attempts.zeroFill>0);assert.equal(row.attempts.unknown,0);
    assert.deepEqual(row.confirmed,{long:0,short:0});assert.deepEqual(row.remaining,{long:421,short:421});
    assert.equal(f.store.data.positions[0].long.quantity,421);assert.equal(f.engine.liveUnlocked,false);
  }finally{await f.cleanup();}
});
