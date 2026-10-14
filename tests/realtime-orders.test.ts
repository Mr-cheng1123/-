import test from 'node:test';
import assert from 'node:assert/strict';
import ccxt from 'ccxt';
import type {ExchangeId,OrderRequest} from '../src/shared/types.js';
import {RealtimeOrderEvents} from '../src/adapters/realtime-orders.js';
import {ExchangeNetworkError} from '../src/adapters/network.js';

type Kind='orders'|'trades';
class FakeWs {
  options:any={};uid?:string;markets:any;markets_by_id:any;wssProxy?:string;wsSocksProxy?:string;httpsProxy?:string;socksProxy?:string;
  calls:{kind:Kind;params:any;symbol:any}[]=[];
  pending:Record<Kind,Array<{resolve:(rows:any)=>void;reject:(error:any)=>void}>>={orders:[],trades:[]};
  closeCalls=0;
  handleMessage(_client:any,_message:any){}
  onConnected(_client:any,_message?:any){}
  onError(_client:any,_error:any){}
  onClose(_client:any,_error:any){}
  watchOrders(symbol:any,_since:any,_limit:any,params:any){return this.watch('orders',symbol,params);}
  watchMyTrades(symbol:any,_since:any,_limit:any,params:any){return this.watch('trades',symbol,params);}
  watch(kind:Kind,symbol:any,params:any){this.calls.push({kind,symbol,params});return new Promise<any>((resolve,reject)=>this.pending[kind].push({resolve,reject}));}
  emit(kind:Kind,rows:any){const listener=this.pending[kind].shift();assert.ok(listener,`${kind} is subscribed`);listener.resolve(rows);}
  reject(kind:Kind,error:unknown=new Error('secret-should-never-be-published')){this.pending[kind].shift()!.reject(error);}
  async close(){this.closeCalls++;}
}
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
const request=(clientOrderId='app-one',quantity=10):OrderRequest=>({clientOrderId,base:'CT',symbol:'CT/USDT:USDT',side:'buy',quantity,limitPrice:11,reduceOnly:false});
const market={symbol:'CT/USDT:USDT',id:'CTUSDT',base:'CT',quote:'USDT',settle:'USDT',contract:true,swap:true,linear:true,contractSize:1};
function fixture(id:ExchangeId='bybit',extra:any={}){
  const ws=new FakeWs(),rest={id,markets:{[market.symbol]:market},markets_by_id:{CTUSDT:[market]},options:{},
    ...(id==='gate'?{privateFuturesGetSettleAccounts:async(_params:any)=>({user:'12345'})}:{}),...extra};
  const events=new RealtimeOrderEvents(id,rest,{injectedWsClient:ws,accountMode:id==='bitget'?'unified':undefined});
  return {ws,rest,events};
}
const order=(extra:any={})=>({id:'native-one',clientOrderId:'native-client',symbol:market.symbol,side:'buy',status:'closed',
  amount:10,price:11,type:'limit',timeInForce:'IOC',reduceOnly:false,filled:10,timestamp:Date.now(),...extra,
  info:{positionIdx:0,positionSide:'BOTH',posSide:'net',holdMode:'one_way_mode',marginMode:'crossed',tdMode:'cross',...extra.info}});
const trade=(id='fill-one',amount=10,price=10,extra:any={})=>({id,order:'native-one',symbol:market.symbol,side:'buy',amount,price,timestamp:Date.now(),fee:{currency:'USDT',cost:.05},...extra});
async function start(f:ReturnType<typeof fixture>,r=request(),size=1){
  f.events.observe(r,'native-client',size,f.events.id==='bybit'?{positionIdx:0}:f.events.id==='gate'?{}:
    f.events.id==='binance'?{posSide:'net'}:{posSide:'net',marginMode:'cross'});await flush();
}
async function nativeHeartbeatFixture(id:'binance'|'bybit',proxy?:{httpsProxy?:string;socksProxy?:string}){
  const name=id==='binance'?'binanceusdm':id,Native=(ccxt as any).pro[name];
  let ws:any,requests=0;
  class OfflineNative extends Native {
    constructor(settings:any){super(settings);ws=this;}
    watchOrders(){return new Promise(()=>{});}
    watchMyTrades(){return new Promise(()=>{});}
  }
  const rest=new (ccxt as any)[name]({apiKey:'offline-placeholder',secret:'offline-placeholder',timeout:8000,
    options:{defaultType:'swap',defaultSubType:'linear',defaultSettle:'USDT'}});
  rest.setMarkets([{...market,type:'swap',spot:false,inverse:false,baseId:'CT',quoteId:'USDT',settleId:'USDT',precision:{amount:1,price:.01},limits:{}}]);
  rest.fetch=async()=>{requests++;throw new Error('offline test must not request a real account');};
  Object.assign(rest,proxy);
  let events:RealtimeOrderEvents|undefined;
  (ccxt as any).pro[name]=OfflineNative;
  try{
    events=new RealtimeOrderEvents(id,rest);events.setSymbols([market.symbol]);await flush();
    assert.ok(ws);await ws.loadProxyModules();await flush();
    return {events,ws,rest,requests:()=>requests};
  }catch(error){await events?.close();await rest.close();throw error;}
  finally{(ccxt as any).pro[name]=Native;}
}

test('native Binance private client uses the selected proxy heartbeat while direct and other venue clients retain native defaults',async()=>{
  for(const [id,proxy,expected] of [
    ['binance',{httpsProxy:'http://127.0.0.1:7890'},15000],
    ['binance',{socksProxy:'socks5://127.0.0.1:7891'},15000],
    ['binance',undefined,180000],
    ['bybit',{httpsProxy:'http://127.0.0.1:7890'},18000],
  ] as const){
    const f=await nativeHeartbeatFixture(id,proxy);
    try{
      const native=f.ws.client('wss://private-memory.invalid/not-an-account-key');
      assert.equal(native.keepAlive,expected,'verify the actual installed native client, not only constructor options');
      assert.equal(native.maxPingPongMisses,2);assert.equal(native.connectionTimeout,10000);
      assert.equal(f.requests(),0);assert.equal(f.events.status().reconnects,0);
    }finally{await f.events.close();await f.rest.close();}
  }
  const injected=fixture('binance',{httpsProxy:'http://127.0.0.1:7890'});
  (injected.ws as any).streaming={keepAlive:45678};
  try{await start(injected);assert.equal((injected.ws as any).streaming.keepAlive,45678);}
  finally{await injected.events.close();}
});

test('real Binance proxy client schedules native control pings on a quiet private stream without inventing business updates',async t=>{
  const f=await nativeHeartbeatFixture('binance',{httpsProxy:'http://127.0.0.1:7890'});
  let pings=0;
  try{
    t.mock.timers.enable({apis:['setInterval']});
    f.ws.options.future={listenKey:'offline-placeholder'};
    const native=f.ws.client('wss://private-memory.invalid/offline-placeholder');
    native.connection={readyState:1,ping(){pings++;native.onPong();}};
    f.ws.onConnected(native);const acknowledgedAt=f.events.status().lastEventAt;
    assert.equal(f.events.status().state,'online');native.setPingInterval();
    for(let cycle=1;cycle<=4;cycle++){t.mock.timers.tick(15000);assert.equal(pings,cycle);}
    assert.equal(f.events.status().state,'online');assert.equal(f.events.status().reconnects,0);
    assert.equal(f.events.status().lastEventAt,acknowledgedAt,'control pong is not an order or fill event');
    assert.equal(f.requests(),0);
  }finally{await f.events.close();await f.rest.close();}
});

test('five venues subscribe to private linear contracts without changing account parameters',async()=>{
  for(const id of ['binance','bybit','okx','gate','bitget'] as const){
    const f=fixture(id);try{await start(f);assert.equal(f.ws.calls.length,2);assert.deepEqual(f.ws.calls.map(c=>c.kind),['orders','trades']);
      for(const c of f.ws.calls){assert.equal(c.symbol,undefined);assert.equal(c.params.type,'swap');assert.equal(c.params.subType,'linear');assert.equal(c.params.settle,'USDT');}
      if(id==='bitget')assert.ok(f.ws.calls.every(c=>c.params.uta===true));
      if(id==='gate'){assert.equal(f.ws.options.ws.options.headers['X-Gate-Size-Decimal'],'1');assert.equal(f.ws.uid,'12345');}
      assert.equal(f.ws.markets,f.rest.markets);
    }finally{await f.events.close();}
  }
});
test('Gate resolves its subscription UID with the existing signed read endpoint and rejects missing UID',async()=>{
  const calls:any[]=[],f=fixture('gate',{privateFuturesGetSettleAccounts:async(params:any)=>{calls.push(params);return {user:445566};}});
  try{await start(f);assert.deepEqual(calls,[{settle:'usdt'}]);assert.equal(f.ws.uid,'445566');assert.equal(f.ws.calls.length,2);}
  finally{await f.events.close();}
  const missing=fixture('gate',{privateFuturesGetSettleAccounts:async()=>({user:undefined,apiKey:'never-publish-this'})});
  try{await start(missing);assert.equal(missing.ws.calls.length,0);assert.equal(missing.events.status().state,'degraded');assert.ok(!JSON.stringify(missing.events.status()).includes('never-publish-this'));}
  finally{await missing.events.close();}
});
test('native private subscription acknowledgements mark quiet streams ready without inventing executions',async()=>{
  for(const id of ['bybit','gate','bitget','okx'] as const){
    const f=fixture(id),r=request();try{await start(f,r);
      const client={subscriptions:{one:{id:'1',topics:['order']},two:{id:'2',topics:['execution']}}};
      const messages=id==='bybit'?[{op:'subscribe',success:true,req_id:'1'},{op:'subscribe',success:true,req_id:'2'}]:
        id==='gate'?[{event:'subscribe',channel:'futures.orders',result:{status:'success'}},{event:'subscribe',channel:'futures.usertrades',result:{status:'success'}}]:
        id==='bitget'?[{event:'subscribe',arg:{instType:'UTA',topic:'order'}},{event:'subscribe',arg:{instType:'UTA',topic:'fill'}}]:
        [{event:'subscribe',arg:{instType:'SWAP',channel:'orders'}}];
      for(const message of messages)f.ws.handleMessage(client,message);
      assert.equal(f.events.status().state,'online');assert.equal(f.events.result(r),undefined);
      const pending=f.events.wait(r,'native-one',200);f.ws.emit('orders',[order()]);f.ws.emit('trades',[trade()]);assert.ok(await pending);
    }finally{await f.events.close();}
  }
});
test('failed, unknown-request and public acknowledgements do not warm private execution streams',async()=>{
  const f=fixture(),g=fixture('bitget');try{await start(f);await start(g);
    f.ws.handleMessage({subscriptions:{}},{op:'subscribe',success:true,req_id:'unknown'});
    f.ws.handleMessage({subscriptions:{a:{id:'1',topics:['order','execution']}}},{op:'subscribe',success:false,req_id:'1'});
    g.ws.handleMessage({}, {event:'subscribe',arg:{instType:'SPOT',topic:'fill'}});
    g.ws.handleMessage({}, {event:'error',arg:{instType:'UTA',topic:'fill'}});
    assert.equal(f.events.status().state,'connecting');assert.equal(g.events.status().state,'connecting');
  }finally{await f.events.close();await g.events.close();}
});
test('a native socket disconnect invalidates acknowledged availability and cached order evidence',async()=>{
  const f=fixture('okx'),r=request();try{await start(f,r);f.ws.handleMessage({}, {event:'subscribe',arg:{instType:'SWAP',channel:'orders'}});
    f.ws.emit('orders',[order()]);f.ws.emit('trades',[trade()]);await flush();assert.ok(f.events.result(r));
    f.ws.onClose({url:'wss://private.invalid'},new Error('private-secret-error'));assert.equal(f.events.result(r),undefined);
    assert.equal(f.events.status().state,'degraded');assert.equal(f.events.status().reconnects,1);assert.ok(!JSON.stringify(f.events.status()).includes('private-secret-error'));
  }finally{await f.events.close();}
});

test('native private errors record only fixed failure categories and their actual callback phase',async()=>{
  for(const [error,code] of [
    [new ccxt.RequestTimeout('wss://private.invalid/listenKey-secret signed-body=private-body apiKey=private-key'),'TIMEOUT'],
    [new ccxt.NetworkError('socket closed wss://private.invalid/listenKey-secret private-body'),'NETWORK_ERROR'],
  ] as const){
    const f=fixture('binance');try{
      await start(f);f.ws.onError({url:'wss://private.invalid/listenKey-secret'},error);
      const status=f.events.status();assert.equal(status.failureCode,code);assert.equal(status.failureStage,'socket-error');
      assert.equal(status.closeCode,undefined);assert.equal(status.reconnects,1);assert.equal(status.state,'degraded');
      for(const secret of ['listenKey-secret','private-body','private-key'])assert.ok(!JSON.stringify(status).includes(secret));
    }finally{await f.events.close();}
  }
});

test('unexpected structured private error codes cannot escape the fixed status allowlist',async()=>{
  const f=fixture(),error=new ExchangeNetworkError('TIMEOUT');
  Object.defineProperty(error,'code',{value:'private-unexpected-code'});
  try{await start(f);f.ws.onError({},error);assert.equal(f.events.status().failureCode,'NETWORK_ERROR');
    assert.equal(f.events.status().failureStage,'socket-error');assert.ok(!JSON.stringify(f.events.status()).includes('private-unexpected-code'));
  }finally{await f.events.close();}
});

test('private native closes retain only an own integer code and never inspect close reason or getters',async()=>{
  const values=[1000,1006,4999,'1006',999,5000,1006.5,NaN];
  for(const value of values){
    const f=fixture('binance');try{
      await start(f);f.ws.onClose({url:'wss://private.invalid/signed-listen-key'},{code:value,reason:'signed-close-reason',body:'private-api-body'});
      const status=f.events.status();assert.equal(status.failureCode,'SOCKET_CLOSED');assert.equal(status.failureStage,'socket-close');
      assert.equal(status.closeCode,typeof value==='number'&&Number.isInteger(value)&&value>=1000&&value<=4999?value:undefined);
      assert.ok(!JSON.stringify(status).includes('signed'));assert.ok(!JSON.stringify(status).includes('private-api-body'));
    }finally{await f.events.close();}
  }
  let reads=0;const event={get code(){reads++;throw new Error('sensitive getter');}};
  const f=fixture();try{await start(f);f.ws.onClose({},event);assert.equal(reads,0);assert.equal(f.events.status().closeCode,undefined);
    assert.equal(f.events.status().failureCode,'SOCKET_CLOSED');
  }finally{await f.events.close();}
});

test('initialization and watch failures retain their distinct phase without changing subscriptions or replaying requests',async()=>{
  const init=fixture();(init.ws as any).loadProxyModules=async()=>{throw new ccxt.RequestTimeout('private-init-token');};
  try{await start(init);assert.equal(init.events.status().failureStage,'initialization');assert.equal(init.events.status().failureCode,'TIMEOUT');
    assert.equal(init.ws.calls.length,0);assert.equal(init.ws.closeCalls,1);assert.ok(!JSON.stringify(init.events.status()).includes('private-init-token'));
  }finally{await init.events.close();}
  for(const kind of ['orders','trades'] as const){
    const f=fixture();try{await start(f);f.ws.reject(kind,new ccxt.RequestTimeout('private-watch-token'));await flush();
      assert.equal(f.events.status().failureStage,kind);assert.equal(f.events.status().failureCode,'TIMEOUT');assert.equal(f.ws.calls.length,2);
      assert.ok(!JSON.stringify(f.events.status()).includes('private-watch-token'));
    }finally{await f.events.close();}
  }
});

test('a send observer fallback records a fixed category without publishing the discarded send error',async()=>{
  const f=fixture();const native={send:async()=>{throw new ccxt.RequestTimeout('discarded-private-send-token');}};
  (f.ws as any).client=()=>native;
  try{await start(f);void (f.ws as any).client().send();await flush();
    assert.equal(f.events.status().failureStage,'send');assert.equal(f.events.status().failureCode,'NETWORK_ERROR');
    assert.equal(f.events.status().reconnects,1);assert.ok(!JSON.stringify(f.events.status()).includes('discarded-private-send-token'));
  }finally{await f.events.close();}
});

test('a replacement generation clears old diagnostics and ignores late native errors, closes and watch rejections',async()=>{
  const f=fixture();try{
    await start(f);const oldError=f.ws.onError,oldClose=f.ws.onClose,oldOrders=f.ws.pending.orders.shift()!;
    oldClose({}, {code:1006,reason:'old-secret-close'});
    assert.equal(f.events.status().failureStage,'socket-close');
    (f.events as any).retry&&clearTimeout((f.events as any).retry);(f.events as any).retry=undefined;
    f.events.setSymbols([market.symbol]);await flush();
    assert.equal(f.events.status().failureCode,undefined);assert.equal(f.events.status().failureStage,undefined);assert.equal(f.events.status().closeCode,undefined);
    const before=f.events.status();oldError({},new ccxt.RequestTimeout('old-private-token'));oldClose({}, {code:1011});
    oldOrders.reject(new ccxt.RequestTimeout('old-watch-token'));await flush();assert.deepEqual(f.events.status(),before);
    f.ws.emit('orders',[]);await flush();assert.equal(f.events.status().failureCode,undefined);
    await f.events.close();const disabled=f.events.status();f.ws.onClose({}, {code:1006});assert.deepEqual(f.events.status(),disabled);
  }finally{await f.events.close();}
});

test('discarded native send rejection clears private evidence once and cannot reopen a closed owner',async()=>{
  const f=fixture('bybit'),r=request();let sends=0,onErrors=0;
  const native={send:async()=>{sends++;throw new Error('WebSocket is not open: readyState 3 (CLOSED)');},
    onError:(error:unknown)=>{onErrors++;f.ws.onError({url:'wss://offline.invalid'},error);}};
  (f.ws as any).client=()=>native;
  try {
    await start(f,r);f.ws.emit('orders',[order()]);f.ws.emit('trades',[trade()]);await flush();
    assert.ok(f.events.result(r));
    void (f.ws as any).client('offline').send();void (f.ws as any).client('offline').send();await flush();
    assert.equal(sends,2);assert.equal(onErrors,1);assert.equal(f.events.result(r),undefined);
    assert.equal(f.events.status().state,'degraded');assert.equal(f.events.status().reconnects,1);
    await f.events.close();
    void (f.ws as any).client('offline').send();await flush();
    assert.equal(onErrors,1);assert.equal(f.events.status().state,'disabled');
  }finally{await f.events.close();}
});
test('HTTP and SOCKS application proxies are also used by the independent secure WS client',async()=>{
  const f=fixture('gate',{httpsProxy:'http://127.0.0.1:7890'}),g=fixture('bybit',{socksProxy:'socks5://127.0.0.1:7891'});
  try{await start(f);await start(g);assert.equal(f.ws.wssProxy,'http://127.0.0.1:7890');assert.equal(f.ws.httpsProxy,f.ws.wssProxy);
    assert.equal(g.ws.wsSocksProxy,'socks5://127.0.0.1:7891');assert.equal(g.ws.socksProxy,g.ws.wsSocksProxy);
  }finally{await f.events.close();await g.events.close();}
});
test('a forwarding HTTP proxy without a WS tunnel never falls through to direct connection',async()=>{
  const f=fixture('bybit',{proxyUrl:'https://forward.invalid/'});try{await start(f);assert.equal(f.ws.calls.length,0);assert.equal(f.events.status().state,'degraded');}finally{await f.events.close();}
});
test('Bitget needs the confirmed classic or unified account mode, and never changes that mode',async()=>{
  const ws=new FakeWs(),rest={id:'bitget',markets:{[market.symbol]:market},options:{}};
  const events=new RealtimeOrderEvents('bitget',rest,{injectedWsClient:ws});try{events.setSymbols([market.symbol]);await flush();assert.equal(ws.calls.length,0);assert.equal(events.status().state,'degraded');}finally{await events.close();}
  const classic=new RealtimeOrderEvents('bitget',rest,{injectedWsClient:ws,accountMode:'classic'});try{classic.setSymbols([market.symbol]);await flush();assert.ok(ws.calls.every(c=>c.params.uta===false));}finally{await classic.close();}
});
test('ACK or an open order with a full reported fill is never a terminal receipt',async()=>{
  const f=fixture(),r=request();try{await start(f,r);f.ws.emit('orders',{event:'subscribe'});await flush();assert.equal(f.events.result(r),undefined);
    f.ws.emit('orders',[order({status:'open'})]);f.ws.emit('trades',[trade()]);await flush();assert.equal(f.events.result(r),undefined);
  }finally{await f.events.close();}
});
test('terminal quantity is matched by deduplicated contract fills and actual weighted prices and fees',async()=>{
  const f=fixture('okx'),r=request('app-one',5);try{await start(f,r,.1);
    const one=trade('a',20,9,{fee:{currency:'USDT',cost:.009}}),two=trade('b',30,11,{fee:{currency:'USDT',cost:.018}});
    f.ws.emit('trades',[one,two,one]);f.ws.emit('orders',[order({amount:50,filled:50,average:100})]);await flush();
    const result=f.events.result(r,'native-one');assert.ok(result);assert.equal(result.filledQuantity,5);assert.equal(result.averagePrice,10.2);assert.ok(Math.abs(result.feeUsd-.027)<1e-12);assert.equal(result.averagePriceVerified,true);assert.equal(result.clientOrderId,r.clientOrderId);assert.equal(result.status,'filled');
  }finally{await f.events.close();}
});
test('partial canceled IOC needs fills and fees for the exact terminal cumulative quantity',async()=>{
  const f=fixture(),r=request();try{await start(f,r);f.ws.emit('orders',[order({status:'canceled',filled:6})]);f.ws.emit('trades',[trade('a',3)]);await flush();assert.equal(f.events.result(r),undefined);
    f.ws.emit('trades',[trade('a',3),trade('b',3,11)]);await flush();const result=f.events.result(r);assert.ok(result);assert.equal(result.status,'partial');assert.equal(result.filledQuantity,6);assert.equal(result.averagePrice,10.5);assert.equal(result.feeUsd,.1);
  }finally{await f.events.close();}
});

test('private push fills outside the original buy cap or sell floor require original-ID REST verification',async()=>{
  for(const id of ['binance','bybit','okx','gate','bitget'] as const)for(const side of ['buy','sell'] as const){
    const f=fixture(id),r={...request(),side};try{
      await start(f,r);
      f.ws.emit('orders',[order({side})]);
      f.ws.emit('trades',[trade('out-of-bound',10,side==='buy'?12:10,{side})]);
      await flush();assert.equal(f.events.result(r,'native-one'),undefined);
    }finally{await f.events.close();}
  }
});

test('a safe private weighted average never excuses an out-of-bound individual execution',async()=>{
  for(const side of ['buy','sell'] as const){
    const f=fixture(),r={...request(),side};try{
      await start(f,r);f.ws.emit('orders',[order({side})]);
      f.ws.emit('trades',[trade('above-cap',5,12,{side}),trade('below-floor',5,10,{side})]);await flush();
      assert.equal(f.events.result(r,'native-one'),undefined);
    }finally{await f.events.close();}
  }
});

test('conflicting known fees for the same private execution never silently preserve the first cash amount',async()=>{
  const f=fixture(),r=request();try{
    await start(f,r);f.ws.emit('orders',[order()]);
    f.ws.emit('trades',[trade('same-execution',10,10,{fee:{currency:'USDT',cost:.05}})]);await flush();
    assert.equal(f.events.result(r)?.feeUsd,.05);
    f.ws.emit('trades',[trade('same-execution',10,10,{fee:{currency:'USDT',cost:.08}})]);await flush();
    assert.equal(f.events.result(r,'native-one'),undefined,'conflicting cash evidence must fall back to REST');
  }finally{await f.events.close();}
});
test('a confirmed zero-fill cancellation proves zero fee, while closed-zero or missing cumulative fill do not',async()=>{
  const f=fixture(),r=request();try{await start(f,r);f.ws.emit('orders',[order({status:'canceled',filled:undefined})]);await flush();assert.equal(f.events.result(r),undefined);
    f.ws.emit('orders',[order({filled:0})]);await flush();assert.equal(f.events.result(r),undefined);
    f.ws.emit('orders',[order({status:'canceled',filled:0})]);await flush();const result=f.events.result(r);assert.equal(result?.status,'cancelled');assert.equal(result?.feeUsd,0);assert.equal(result?.filledQuantity,0);
  }finally{await f.events.close();}
});

test('Bybit zero-fill private pushes retain actual IOC and cancellation diagnostics for opening and reducing',async()=>{
  for(const reduceOnly of [false,true])for(const cause of ['EC_NoImmediateQtyToFill','CancelBySmp','CancelByReduceOnly']){
    const f=fixture(),r={...request(),reduceOnly};try{
      await start(f,r);
      f.ws.emit('orders',[order({status:'canceled',filled:0,reduceOnly,info:{orderStatus:'Cancelled',
        rejectReason:cause.startsWith('EC_')?cause:'EC_NoError',cancelType:cause.startsWith('Cancel')?cause:'UNKNOWN',privatePayload:'never-publish-private-response'}})]);
      await flush();const result=f.events.result(r,'native-one');
      assert.equal(result?.status,'cancelled');assert.equal(result?.rejectionCode,cause);
      assert.match(result!.rejectionReason!,reduceOnly?/仓位尚未因此减少/:/未形成新仓位/);
      assert.ok(!JSON.stringify(result).includes('never-publish-private-response'));assert.equal(result?.feeUsd,0);
      // Some duplicate cumulative receipts omit optional metadata.
      f.ws.emit('orders',[order({status:'canceled',filled:0,reduceOnly,timestamp:result!.timestamp+1})]);await flush();
      assert.equal(f.events.result(r,'native-one')?.rejectionCode,cause);
    }finally{await f.events.close();}
  }
});

test('Bybit an unrecognised zero-fill cancel reason stays neutral without inventing a liquidity cause',async()=>{
  const f=fixture(),r=request();try{
    await start(f,r);f.ws.emit('orders',[order({status:'canceled',filled:0,
      info:{rejectReason:'PRIVATE signed response',cancelType:'PRIVATE unrecognised cancel type'}})]);await flush();
    const result=f.events.result(r);assert.equal(result?.rejectionCode,'BYBIT_CANCELLED_ZERO_FILL');
    assert.match(result!.rejectionReason!,/具体取消原因尚未识别/);assert.ok(!JSON.stringify(result).includes('PRIVATE'));
    assert.ok(!result!.rejectionReason!.includes('无可立即成交数量'));
  }finally{await f.events.close();}
});

test('Bybit filled and partially filled push receipts ignore cancellation-race rejection metadata',async()=>{
  for(const filled of [10,6]){
    const f=fixture(),r=request();try{
      await start(f,r);f.ws.emit('orders',[order({status:filled===10?'closed':'canceled',filled,
        info:{orderStatus:filled===10?'Filled':'PartiallyFilledCanceled',rejectReason:'EC_OrigClOrdIDDoesNotExist',cancelType:'CancelByUser'}})]);
      f.ws.emit('trades',[trade('race-fill',filled)]);await flush();const result=f.events.result(r);
      assert.equal(result?.status,filled===10?'filled':'partial');assert.equal(result?.rejectionCode,undefined);
      assert.equal(result?.rejectionReason,undefined);assert.equal(result?.filledQuantity,filled);
    }finally{await f.events.close();}
  }
});
test('missing or non-USDT fee cannot become an invented zero USDT fee',async()=>{
  for(const fee of [undefined,{currency:'MNT',cost:.1},{currency:'USDT',cost:undefined},{currency:undefined,cost:0}]){
    const f=fixture(),r=request();try{await start(f,r);f.ws.emit('orders',[order()]);f.ws.emit('trades',[trade('a',10,10,{fee})]);await flush();assert.equal(f.events.result(r),undefined);}finally{await f.events.close();}
  }
});
test('Bybit real execution feeCurrency overrides a CCXT-inferred USDT fee, including when an order claims USDT fee',async()=>{
  const f=fixture(),r=request();try{await start(f,r);f.ws.emit('orders',[order({info:{cumFeeDetail:{USDT:.05}}})]);f.ws.emit('trades',[trade('a',10,10,{info:{feeCurrency:'MNT',execType:'Trade'}})]);await flush();assert.equal(f.events.result(r),undefined);}finally{await f.events.close();}
});
test('Bitget UTA all feeDetail currencies and Bybit extra tax fees must be accounted for',async()=>{
  const f=fixture('bitget'),r=request();try{await start(f,r);f.ws.emit('orders',[order()]);f.ws.emit('trades',[trade('a',10,10,{info:{feeDetail:[{feeCoin:'USDT',fee:'.03'},{feeCoin:'USDT',fee:'.01'}]}})]);await flush();assert.equal(f.events.result(r)?.feeUsd,.04);}finally{await f.events.close();}
  const g=fixture(),r2=request();try{await start(g,r2);g.ws.emit('orders',[order()]);g.ws.emit('trades',[trade('a',10,10,{info:{extraFees:[{feeCoin:'USDT',fee:'.01'}]}})]);await flush();assert.equal(g.events.result(r2)?.feeUsd,.060000000000000005);}finally{await g.events.close();}
});
test('a cumulative trading fee cannot conceal a separately charged unknown or foreign tax',async()=>{
  for(const extraFees of [[{feeCoin:'MNT',fee:'.01'}],[{feeCoin:'USDT',fee:'.01'}]]){
    const f=fixture(),r=request();try{await start(f,r);f.ws.emit('orders',[order({info:{cumFeeDetail:{USDT:'.05'}}})]);
      f.ws.emit('trades',[trade('a',10,10,{fee:undefined,info:{extraFees}})]);await flush();assert.equal(f.events.result(r),undefined);
    }finally{await f.events.close();}
  }
});
test('Bitget classic signed totalFee preserves an actual maker rebate instead of charging it twice',async()=>{
  const f=fixture('bitget'),r=request();try{await start(f,r);f.ws.emit('orders',[order()]);
    f.ws.emit('trades',[trade('a',10,10,{info:{feeDetail:[{feeCoin:'USDT',totalFee:'0.01'}]}})]);await flush();assert.equal(f.events.result(r)?.feeUsd,-.01);
  }finally{await f.events.close();}
});
test('an explicit full cumulative fee can fill missing per-fill fees, but Binance last-fill fee cannot',async()=>{
  for(const id of ['bybit','binance'] as const){
    const f=fixture(id),r=request();try{await start(f,r);f.ws.emit('orders',[order({fee:{currency:'USDT',cost:.05},info:id==='bybit'?{cumFeeDetail:{USDT:'.05'}}:{}})]);f.ws.emit('trades',[trade('a',10,10,{fee:undefined})]);await flush();assert.equal(f.events.result(r)?.feeUsd,id==='bybit'?.05:undefined);}finally{await f.events.close();}
  }
});
test('wrong symbol, side, client id, original order id, or execution type never supplies this receipt',async()=>{
  const invalid=[{symbol:'OTHER/USDT:USDT'},{side:'sell'},{order:'other-order'},{info:{orderLinkId:'other-client'}},{info:{execType:'Funding'}}];
  for(const bad of invalid){const f=fixture(),r=request();try{await start(f,r);f.ws.emit('orders',[order()]);f.ws.emit('trades',[trade('a',10,10,bad)]);await flush();assert.equal(f.events.result(r,'native-one'),undefined);}finally{await f.events.close();}}
  const f=fixture(),r=request();try{await start(f,r);f.ws.emit('orders',[order({clientOrderId:'wrong-client'})]);f.ws.emit('trades',[trade()]);await flush();assert.equal(f.events.result(r,'native-one'),undefined);}finally{await f.events.close();}
});
test('a trade arriving before its order is retained by original order id, never used for another order',async()=>{
  const f=fixture('gate'),r=request();try{await start(f,r);f.ws.emit('trades',[trade()]);await flush();assert.equal(f.events.result(r),undefined);f.ws.emit('orders',[order()]);await flush();assert.ok(f.events.result(r));assert.equal(f.events.result(r,'another-native'),undefined);}finally{await f.events.close();}
});
test('stale/regressive or conflicting duplicate events cannot inflate quantity or overwrite a terminal result',async()=>{
  const f=fixture(),r=request();try{await start(f,r);const at=Date.now();f.ws.emit('orders',[order({timestamp:at})]);f.ws.emit('trades',[trade()]);await flush();assert.ok(f.events.result(r));
    f.ws.emit('orders',[order({timestamp:at-1,status:'open',filled:2})]);await flush();assert.equal(f.events.result(r)?.filledQuantity,10);
    f.ws.emit('trades',[trade('fill-one',10,12)]);await flush();assert.equal(f.events.result(r),undefined);
  }finally{await f.events.close();}
});
test('cold subscriptions return immediately; warm waits are bounded and wake on complete receipts',async()=>{
  const f=fixture(),r=request();try{await start(f,r);const cold=Date.now();assert.equal(await f.events.wait(r,'native-one',10_000),undefined);assert.ok(Date.now()-cold<100);
    f.ws.emit('orders',[]);f.ws.emit('trades',[]);await flush();const timeout=Date.now();assert.equal(await f.events.wait(r,'native-one',10_000),undefined);assert.ok(Date.now()-timeout<450);
    const pending=f.events.wait(r,'native-one',200);f.ws.emit('orders',[order()]);f.ws.emit('trades',[trade()]);assert.ok(await pending);
  }finally{await f.events.close();}
});
test('disconnect invalidates stream evidence, clears waiting receipts and never exposes a private error',async()=>{
  const f=fixture(),r=request();try{await start(f,r);f.ws.emit('orders',[]);f.ws.emit('trades',[]);await flush();const pending=f.events.wait(r,'native-one',200);
    const stale=f.ws.pending.trades.shift()!;f.ws.reject('orders');await flush();stale.resolve([trade()]);await flush();assert.equal(await pending,undefined);assert.equal(f.events.result(r),undefined);assert.equal(f.events.status().state,'degraded');assert.equal(f.events.status().reconnects,1);assert.ok(!JSON.stringify(f.events.status()).includes('secret'));assert.equal(f.ws.closeCalls,1);
  }finally{await f.events.close();}
});
test('closing the observer disables it and clears all order data without calling any financial endpoint',async()=>{
  const f=fixture(),r=request();await start(f,r);f.ws.emit('orders',[order()]);f.ws.emit('trades',[trade()]);await flush();assert.ok(f.events.result(r));await f.events.close();assert.equal(f.events.status().state,'disabled');assert.equal(f.events.result(r),undefined);assert.equal(await f.events.wait(r),undefined);f.events.observe(r,'native-client',1);assert.equal(f.ws.calls.length,4);
});
test('restarting a subscription cannot use terminal evidence or pending events from the prior generation',async()=>{
  const f=fixture(),r=request();try{await start(f,r);f.ws.emit('orders',[order()]);f.ws.emit('trades',[trade()]);await flush();assert.ok(f.events.result(r));
    const old=f.ws.pending.orders.shift()!;f.events.setSymbols([]);f.events.setSymbols([market.symbol]);await flush();old.resolve([order()]);await flush();assert.equal(f.events.result(r),undefined);
  }finally{await f.events.close();}
});
