import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyNetworkError, configureExchangeTransport, exchangeApiCode, ExchangeNetworkError, GATE_API_LABELS, getExchangeNetworkStatus, proxyFor, withExchangeRequestContext } from '../src/adapters/network.js';

test('proxy precedence supports venue isolation and explicit direct access',()=>{
  const env={HTTPS_PROXY:'http://shared:7890',EXCHANGE_PROXY_URL:'http://app:7891',BINANCE_PROXY_URL:'http://isolated:7892'};
  assert.equal(proxyFor('binance',env),'http://isolated:7892');
  assert.equal(proxyFor('bybit',env),'http://app:7891');
  assert.equal(proxyFor('okx',{HTTPS_PROXY:env.HTTPS_PROXY}),'http://shared:7890');
  assert.equal(proxyFor('binance',{...env,BINANCE_PROXY_URL:'direct'}),undefined);
  assert.throws(()=>proxyFor('gate',{EXCHANGE_PROXY_URL:'file:///etc/passwd'}));
});

test('country-blocked CCXT 403 is distinct from rate limits and timeout',()=>{
  const error=new Error('bybit 403 CloudFront: The Amazon CloudFront distribution is configured to block access from your country.');error.name='RateLimitExceeded';
  assert.equal(classifyNetworkError(error),'REGION_BLOCKED');
  assert.equal(classifyNetworkError(new Error('451 Service unavailable from a restricted location')),'REGION_BLOCKED');
  assert.equal(classifyNetworkError(new Error('429 Too many requests')),'RATE_LIMITED');
  assert.equal(classifyNetworkError(new Error('RequestTimeout timed out')),'TIMEOUT');
  assert.equal(classifyNetworkError(new Error('ECONNREFUSED 127.0.0.1:7890'),true),'PROXY_UNAVAILABLE');
});

test('transient public GET retries once and clears the prior diagnostic',async()=>{
  let calls=0;const client:any={fetch:async()=>{if(++calls===1)throw new Error('ECONNRESET');return {ok:true};}};
  configureExchangeTransport(client,'gate');
  assert.deepEqual(await client.fetch('https://api.gateio.ws/api/v4/futures/usdt/tickers'),{ok:true});
  assert.equal(calls,2);assert.equal(getExchangeNetworkStatus(client)?.errorCode,undefined);
  assert.equal(getExchangeNetworkStatus(client)?.endpoint,'api.gateio.ws');
});

test('blocked location opens circuit and never repeats rejected requests',async()=>{
  let calls=0;const client:any={fetch:async()=>{calls++;throw new Error('451 restricted location');}};
  configureExchangeTransport(client,'binance');
  await assert.rejects(client.fetch('https://fapi.binance.com/fapi/v1/premiumIndex'),(e:unknown)=>e instanceof ExchangeNetworkError&&e.code==='REGION_BLOCKED');
  await assert.rejects(client.fetch('https://fapi.binance.com/fapi/v1/premiumIndex'));
  assert.equal(calls,1);assert.ok((getExchangeNetworkStatus(client)?.retryAt??0)>Date.now());
});

test('order submission is never retried on uncertain network response; raw secrets stay out of diagnostics',async()=>{
  let calls=0;const client:any={fetch:async()=>{calls++;throw new Error('ECONNRESET https://user:secret@proxy.invalid?apiKey=private');}};
  configureExchangeTransport(client,'bybit');
  await assert.rejects(client.fetch('https://api.bybit.com/v5/order/create','POST',{},'{}'),(e:unknown)=>{
    assert.ok(e instanceof ExchangeNetworkError);assert.doesNotMatch(e.message,/secret|private|user/);return true;
  });
  assert.equal(calls,1);assert.doesNotMatch(JSON.stringify(getExchangeNetworkStatus(client)),/secret|private|user/);
});

test('OKX official hostname migration covers interpolated and literal API URLs',()=>{
  const client:any={hostname:'www.okx.com',urls:{api:{rest:'https://{hostname}',public:'https://www.okx.com/api/v5'}},fetch:async()=>({})};
  configureExchangeTransport(client,'okx');
  assert.equal(client.hostname,'openapi.okx.com');
  assert.equal(client.urls.api.rest,'https://{hostname}');
  assert.equal(client.urls.api.public,'https://openapi.okx.com/api/v5');
  assert.equal(client.maxRetriesOnFailure,0);
  assert.equal(client.options.maxRetriesOnFailure,0);
});

test('earlier in-flight success cannot erase a later rate-limit cooldown',async()=>{
  let resolveSlow:(value:unknown)=>void=()=>{},calls=0;
  const client:any={fetch:async()=>{calls++;if(calls===1)return new Promise(resolve=>{resolveSlow=resolve;});throw new Error('429 Too many requests');}};
  configureExchangeTransport(client,'okx');
  const slow=client.fetch('https://openapi.okx.com/api/v5/market/ticker');
  await assert.rejects(client.fetch('https://openapi.okx.com/api/v5/public/funding-rate'));
  resolveSlow({ok:true});await slow;
  assert.equal(getExchangeNetworkStatus(client)?.errorCode,'RATE_LIMITED');
  await assert.rejects(client.fetch('https://openapi.okx.com/api/v5/market/ticker'));assert.equal(calls,2);
});

test('market cooldown does not block order cancellation or reconciliation',async()=>{
  let calls=0;const client:any={fetch:async(url:string)=>{calls++;if(url.includes('premiumIndex'))throw new Error('451 restricted location');return {status:'cancelled'};}};
  configureExchangeTransport(client,'binance');
  await assert.rejects(client.fetch('https://fapi.binance.com/fapi/v1/premiumIndex'));
  assert.deepEqual(await client.fetch('https://fapi.binance.com/fapi/v1/order','DELETE'),{status:'cancelled'});
  assert.deepEqual(await client.fetch('https://fapi.binance.com/fapi/v1/order?origClientOrderId=test','GET'),{status:'cancelled'});
  assert.equal(getExchangeNetworkStatus(client)?.errorCode,'REGION_BLOCKED');assert.equal(calls,3);
});

test('Bitget private permission failures keep only their numeric business code without echoing private payloads',async()=>{
  const client:any={fetch:async()=>{throw new Error('bitget {"code":"40014","msg":"permission denied apiKey=never-show-this"}');}};
  configureExchangeTransport(client,'bitget');
  await assert.rejects(client.fetch('https://api.bitget.com/api/v3/account/assets'),(error:unknown)=>{
    assert(error instanceof ExchangeNetworkError);assert.equal(error.apiCode,'40014');
    assert.doesNotMatch(JSON.stringify(error)+error.message,/never-show-this|apiKey/);return true;
  });
  assert.equal(getExchangeNetworkStatus(client)?.errorCode,undefined);
});

test('Gate documented business labels survive private transport errors without raw request data or retries',async()=>{
  for(const label of GATE_API_LABELS){
    let calls=0;
    const client:any={fetch:async()=>{calls++;throw Object.assign(new Error(`gate {"label":"${label}","message":"apiKey=private-canary https://secret-canary@private.invalid"}`),{headers:{KEY:'header-canary'},body:'body-canary'});}};
    configureExchangeTransport(client,'gate');
    await assert.rejects(client.fetch('https://api.gateio.ws/api/v4/futures/usdt/positions/BTC_USDT/leverage','POST',{KEY:'header-canary'},'body-canary'),(error:unknown)=>{
      assert(error instanceof ExchangeNetworkError);assert.equal(error.exchange,'gate');assert.equal(error.apiCode,label);
      assert.equal(error.code,['FORBIDDEN','IP_FORBIDDEN'].includes(label)?'ACCESS_DENIED':'API_ERROR');
      assert.doesNotMatch(error.message+error.stack+JSON.stringify(error),/canary|private\.invalid|headers|body/);
      assert.equal(error.cause,undefined);return true;
    });
    assert.equal(calls,1);assert.equal(getExchangeNetworkStatus(client)?.errorCode,undefined);
  }
});

test('Gate arbitrary labels, text mentions and other venue response fields are not retained',async()=>{
  for(const message of [
    'gate {"label":"PRIVATE_CANARY","message":"READ_ONLY"}',
    'gate {"label":"READ_ONLY-private-canary"}',
    'gate {"message":"READ_ONLY"}',
    'gate {"code":"40014"}',
  ]){
    const client:any={fetch:async()=>{throw new Error(message);}};configureExchangeTransport(client,'gate');
    await assert.rejects(client.fetch('https://api.gateio.ws/api/v4/futures/usdt/accounts'),(error:unknown)=>{
      assert(error instanceof ExchangeNetworkError);assert.equal(error.apiCode,undefined);assert.equal(error.exchange,'gate');
      assert.doesNotMatch(error.message+JSON.stringify(error),/CANARY|canary|READ_ONLY|40014/);return true;
    });
  }
});

test('business code sanitizing is venue scoped and does not invoke arbitrary apiCode getters',()=>{
  assert.equal(exchangeApiCode('gate',Object.assign(new Error('local'),{apiCode:'NO_CHANGE'})),'NO_CHANGE');
  assert.equal(exchangeApiCode('gate',new ExchangeNetworkError('API_ERROR',0,'40014','bitget')),undefined);
  assert.equal(exchangeApiCode('bitget',new ExchangeNetworkError('API_ERROR',0,'READ_ONLY','gate')),undefined);
  let reads=0;const error=Object.defineProperty(new Error('unknown'),'apiCode',{get(){reads++;throw new Error('secret-canary');}});
  assert.equal(exchangeApiCode('gate',error),undefined);assert.equal(reads,0);
  assert.equal(new ExchangeNetworkError('API_ERROR',0,'secret-canary','gate').apiCode,undefined);
  assert.equal(new ExchangeNetworkError('API_ERROR',0,'40014','gate').apiCode,undefined);
});

test('private timeout preserves its network category and venue without replaying the write',async()=>{
  let calls=0;const client:any={fetch:async()=>{calls++;throw new Error('ETIMEDOUT private-canary');}};
  configureExchangeTransport(client,'gate');
  await assert.rejects(client.fetch('https://api.gateio.ws/api/v4/futures/usdt/positions/BTC_USDT/leverage','POST'),(error:unknown)=>{
    assert(error instanceof ExchangeNetworkError);assert.equal(error.code,'TIMEOUT');assert.equal(error.exchange,'gate');assert.equal(error.apiCode,undefined);return true;
  });
  assert.equal(calls,1);
});

test('all five CCXT REST business-code shapes survive transport without retaining private payloads',async()=>{
  const fixtures=[
    ['binance','binanceusdm', {code:-2015,msg:'secret-canary'},'-2015'],
    ['bybit','bybit',{retCode:10001,retMsg:'secret-canary',result:{}},'10001'],
    ['okx','okx',{code:'1',msg:'secret-canary',data:[{sCode:'51008',sMsg:'secret-canary',ordId:'private-order-canary'}]},'51008'],
    ['gate','gateio',{label:'INVALID_PARAM_VALUE',message:'secret-canary'},'INVALID_PARAM_VALUE'],
    ['bitget','bitget',{code:'25200',msg:'secret-canary'},'25200'],
  ] as const;
  for(const [exchange,prefix,payload,expected] of fixtures){
    let calls=0;
    const client:any={secret:'secret-canary',fetch:async()=>{calls++;throw Object.assign(new Error(`${prefix} ${JSON.stringify(payload)}`),{name:'ExchangeError',headers:{authorization:'private-header-canary'}});}};
    configureExchangeTransport(client,exchange);
    await assert.rejects(client.fetch('https://fixture.invalid/private','POST',{},'private-body-canary'),(error:unknown)=>{
      assert(error instanceof ExchangeNetworkError);assert.equal(error.exchange,exchange);assert.equal(error.apiCode,expected);
      assert.doesNotMatch(error.message+error.stack+JSON.stringify(error),/canary|fixture\.invalid|headers|authorization|ordId/);
      assert.equal(error.cause,undefined);return true;
    });
    assert.equal(calls,1);
  }
});

test('primitive business identifiers are validated against each venue format and success codes are omitted',()=>{
  const fixtures=[
    ['binance',[-1000,-999999,'-2015'],[0,'0','-12','-1234567','2015','-0001']],
    ['bybit',[429,'10001',110043,34022001],[-1,0,'0','123','123456789','010001']],
    ['okx',['1',2,'51000','00001'],[0,'0','00000','3','510000']],
    ['bitget',['00001','25200',40014],['00000',0,'4001','400140']],
  ] as const;
  for(const [exchange,valid,invalid] of fixtures){
    for(const apiCode of valid)assert.equal(exchangeApiCode(exchange,{apiCode}),String(apiCode));
    for(const apiCode of [...invalid,1.5,Infinity,NaN,Number.MAX_SAFE_INTEGER+1,{},['10001'],'10001-private-canary','１０００１'])assert.equal(exchangeApiCode(exchange,{apiCode}),undefined);
  }
  assert.equal(new ExchangeNetworkError('API_ERROR',0,'40014').apiCode,'40014');
  assert.equal(new ExchangeNetworkError('API_ERROR',0,'READ_ONLY').apiCode,'READ_ONLY');
  assert.equal(exchangeApiCode('binance',{code:-4061}),'-4061');
  assert.equal(exchangeApiCode('bybit',{retCode:'110043'}),'110043');
});

test('OKX nonzero five-digit item codes take precedence over outer batch results',()=>{
  for(const code of ['0','1','2','50000']){
    const payload={code,data:[{sCode:'0'},{sCode:'00000'},{sCode:'51008',sMsg:'private-canary'}]};
    assert.equal(exchangeApiCode('okx',payload),'51008');
    assert.equal(exchangeApiCode('okx',Object.assign(new Error(`okx ${JSON.stringify(payload)}`),{code})),'51008');
  }
  assert.equal(exchangeApiCode('okx',{code:'2',data:[{sCode:'0'}]}),'2');
  assert.equal(exchangeApiCode('okx',{code:'0',data:[{sCode:'0'}]}),undefined);
  assert.equal(exchangeApiCode('okx',{code:'1',sCode:51010}),'51010');
  assert.equal(exchangeApiCode('okx',new Error('okx {"code":"51000","data":[]}')),'51000');
});

test('codes embedded in message strings, nested private data or another venue cannot masquerade as business fields',()=>{
  for(const exchange of ['binance','bybit','okx','gate','bitget'] as const){
    const message=new Error(`${exchange} ${JSON.stringify({msg:'private-canary "code":"51008" "retCode":10001 "label":"READ_ONLY"',raw:{code:'51008'},headers:{retCode:10001}})}`);
    assert.equal(exchangeApiCode(exchange,message),undefined);
    assert.equal(exchangeApiCode(exchange,{apiCode:'private-canary',response:{code:'51008'},headers:{retCode:10001}}),undefined);
  }
  assert.equal(exchangeApiCode('okx',new Error('bitget {"code":"40014"}')),undefined);
  assert.equal(exchangeApiCode('bitget',{exchange:'okx',apiCode:'51008'}),undefined);
  assert.equal(exchangeApiCode('bybit',new ExchangeNetworkError('API_ERROR',0,'51008','okx')),undefined);
});

test('business code extraction never invokes accessor fields or coerces objects',()=>{
  let reads=0;
  const error=new Error('unrecognized');
  for(const key of ['apiCode','code','retCode','sCode','message','data','exchange'])Object.defineProperty(error,key,{configurable:true,get(){reads++;throw new Error('private-canary');}});
  for(const exchange of ['binance','bybit','okx','gate','bitget'] as const)assert.equal(exchangeApiCode(exchange,error),undefined);
  const malicious={toString(){reads++;return '10001';}};
  assert.equal(exchangeApiCode('bybit',{retCode:malicious}),undefined);
  const data:any[]=[];Object.defineProperty(data,'0',{get(){reads++;throw new Error('private-canary');}});
  assert.equal(exchangeApiCode('okx',{code:'1',data}),'1');
  assert.equal(reads,0);
});

test('contract business errors do not interrupt unrelated public market reads',async()=>{
  let calls=0;const client:any={fetch:async()=>{if(++calls===1)throw new Error('bybit {"retCode":10001,"retMsg":"invalid symbol"}');return {ok:true};}};
  configureExchangeTransport(client,'bybit');
  await assert.rejects(client.fetch('https://api.bybit.com/v5/market/orderbook?symbol=INVALID'),(error:unknown)=>
    error instanceof ExchangeNetworkError&&error.code==='API_ERROR'&&error.apiCode==='10001');
  assert.deepEqual(await client.fetch('https://api.bybit.com/v5/market/tickers?category=linear'),{ok:true});
  assert.equal(calls,2);assert.equal(getExchangeNetworkStatus(client)?.retryAt,undefined);
});

test('retry checks a cooldown established by another concurrent public read',async()=>{
  let calls=0;const client:any={fetch:async()=>{calls++;throw new Error(calls===1?'ECONNRESET':'429 Too many requests');}};
  configureExchangeTransport(client,'gate');
  const retrying=client.fetch('https://api.gateio.ws/api/v4/futures/usdt/tickers');
  // Attach rejection handling before the concurrent failure establishes its circuit.
  const result=assert.rejects(retrying,(error:unknown)=>error instanceof ExchangeNetworkError&&error.code==='RATE_LIMITED');
  await Promise.resolve();
  await assert.rejects(client.fetch('https://api.gateio.ws/api/v4/futures/usdt/order_book'));
  await result;assert.equal(calls,2);
});

test('logical read cancellation stops retries and does not cancel concurrent private reconciliation',async()=>{
  let publicCalls=0;let cancelPrivate:(value:unknown)=>void=()=>{};
  const client:any={fetch:async(url:string)=>{
    if(url.includes('/v5/market/')){publicCalls++;throw new Error('ECONNRESET');}
    return new Promise(resolve=>{cancelPrivate=resolve;});
  }};
  configureExchangeTransport(client,'bybit');
  const controller=new AbortController();
  const read=withExchangeRequestContext(client,{signal:controller.signal,deadlineAt:Date.now()+1000},()=>
    client.fetch('https://api.bybit.com/v5/market/tickers'));
  const rejected=assert.rejects(read,(error:unknown)=>error instanceof ExchangeNetworkError&&error.code==='TIMEOUT');
  const privateRead=client.fetch('https://api.bybit.com/v5/order/realtime');
  await Promise.resolve();controller.abort(new Error('private-reason-canary'));
  await rejected;assert.equal(publicCalls,1);
  cancelPrivate({orderStatus:'Filled'});assert.deepEqual(await privateRead,{orderStatus:'Filled'});
  // Queued pagination from the cancelled operation must never start another HTTP call.
  await assert.rejects(withExchangeRequestContext(client,{signal:controller.signal},()=>
    client.fetch('https://api.bybit.com/v5/market/instruments-info')));
  assert.equal(publicCalls,1);
});

test('all GET attempts share one deadline and request-local timeout leaves other calls unchanged',async()=>{
  const timeouts:number[]=[];let calls=0;
  const client:any={fetch:async()=>{calls++;timeouts.push(client.timeout);await new Promise(resolve=>setTimeout(resolve,35));throw new Error('ETIMEDOUT');}};
  configureExchangeTransport(client,'okx');const baseline=client.timeout,started=Date.now();
  await assert.rejects(withExchangeRequestContext(client,{deadlineAt:started+65},()=>
    client.fetch('https://openapi.okx.com/api/v5/market/ticker')),(error:unknown)=>error instanceof ExchangeNetworkError&&error.code==='TIMEOUT');
  assert.equal(calls,1);assert(timeouts[0]>0&&timeouts[0]<=65);assert.equal(client.timeout,baseline);
  assert(Date.now()-started<250);
});

test('native CCXT response-body stall is aborted after headers even without an operation context',async()=>{
  const {createServer}=await import('node:http');
  const {default:ccxt}=await import('ccxt');let requests=0;
  const server=createServer((_request,response)=>{requests++;response.writeHead(200,{'content-type':'application/json'});response.flushHeaders();response.write('{"result":');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert(address&&typeof address==='object');
  const client:any=new ccxt.bybit({enableRateLimit:false});configureExchangeTransport(client,'bybit');
  // Local fixture routes must bypass any process-level exchange proxy.
  client.httpsProxy=undefined;client.socksProxy=undefined;client.httpProxy=undefined;
  await client.loadFetchImplementation();await client.loadProxyModules();client.timeout=90;
  const started=Date.now();
  try{
    await assert.rejects(client.fetch(`http://127.0.0.1:${address.port}/stalled-body`),(error:unknown)=>{
      assert(error instanceof ExchangeNetworkError);assert.equal(error.code,'TIMEOUT');return true;
    });
    assert.equal(requests,1);assert(Date.now()-started<1200,'body must not remain pending until an outer service timeout');
  }finally{await client.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('body timeouts and explicit aborts are classified as bounded network timeouts',()=>{
  assert.equal(classifyNetworkError(new Error('UND_ERR_HEADERS_TIMEOUT')),'TIMEOUT');
  assert.equal(classifyNetworkError(new Error('UND_ERR_BODY_TIMEOUT')),'TIMEOUT');
  assert.equal(classifyNetworkError(new DOMException('aborted','AbortError')),'TIMEOUT');
});
