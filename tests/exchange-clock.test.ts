import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {configureExchangeClock} from '../src/adapters/exchange-clock.js';
import {assertExchangeRequestActive,configureExchangeTransport,ExchangeNetworkError,withExchangeRequestContext} from '../src/adapters/network.js';
import type {ExchangeId} from '../src/shared/types.js';

type Attempt={path:string;api:unknown;method:string;rest:unknown[];timestamp:number;offset:number};
function fixture(t:TestContext,id:ExchangeId='bybit',install=true){
  let wall=1_780_000_000_000,monotonic=100,serverOffset=5000,timeReads=0;
  t.mock.method(Date,'now',()=>wall);t.mock.method(performance,'now',()=>monotonic);
  const attempts:Attempt[]=[],timestampError=new ExchangeNetworkError('API_ERROR',0,id==='binance'?'-1021':'10002',id);
  let onAttempt:(attempt:Attempt)=>Promise<unknown>=async attempt=>{
    if(attempt.timestamp!==wall+serverOffset)throw timestampError;
    return {ok:true,timestamp:attempt.timestamp};
  };
  let onTime:()=>Promise<unknown>=async()=>wall+serverOffset;
  const client:any={options:{timeDifference:0,recvWindow:10000,retained:{category:'linear'}},timeout:8000,
    milliseconds:()=>wall,fetch:async()=>{throw new Error('No real network is permitted');},
    fetch2:async function(path:string,api:unknown='public',method='GET',...rest:unknown[]){
      assert.equal(this,client);assertExchangeRequestActive(client,id);
      const explicit=(rest[0] as {timestamp?:unknown}|undefined)?.timestamp;
      const attempt={path,api,method,rest,timestamp:typeof explicit==='number'?explicit:client.milliseconds()-client.options.timeDifference,
        offset:client.options.timeDifference};
      attempts.push(attempt);return onAttempt(attempt);
    },
    fetchTime:async function(){
      assert.equal(this,client);assertExchangeRequestActive(client,id);timeReads++;
      const value=await onTime();assertExchangeRequestActive(client,id);return value;
    }};
  const advance=(elapsed:number,wallElapsed=elapsed)=>{monotonic+=elapsed;wall+=wallElapsed;};
  if(install)configureExchangeClock(client,id);
  return {client,attempts,timestampError,advance,now:()=>wall,serverNow:()=>wall+serverOffset,timeReads:()=>timeReads,
    setAttempt:(handler:typeof onAttempt)=>{onAttempt=handler;},setTime:(handler:typeof onTime)=>{onTime=handler;},
    setServerOffset:(value:number)=>{serverOffset=value;}};
}

for(const [id,api] of [['binance','fapiPrivate'],['binance','fapiPrivateV2'],['binance','fapiPrivateV3'],['bybit','private']] as const)
test(`${id} ${api} timestamp rejection regenerates one original read with the calibrated signature`,async t=>{
  const f=fixture(t,id),identity=f.client,retained=f.client.options.retained;
  const params=Object.freeze({symbol:'BTCUSDT',clientOrderId:'unchanged-read',recvWindow:10000}),headers=Object.freeze({accept:'application/json'}),body=undefined,config=Object.freeze({cost:1});
  const response=await f.client.fetch2('order',api,'GET',params,headers,body,config);
  assert.equal(response.ok,true);assert.equal(f.timeReads(),1);assert.equal(f.attempts.length,2);
  assert.equal(f.client,identity);assert.equal(f.client.options.timeDifference,-5000);assert.equal(f.client.options.recvWindow,10000);
  assert.equal(f.client.options.retained,retained);assert.equal(f.attempts[1].timestamp,f.serverNow());
  assert.notEqual(f.attempts[0].timestamp,f.attempts[1].timestamp);
  for(const attempt of f.attempts){assert.equal(attempt.path,'order');assert.equal(attempt.api,api);assert.equal(attempt.method,'GET');
    assert.equal(attempt.rest[0],params);assert.equal(attempt.rest[1],headers);assert.equal(attempt.rest[2],body);assert.equal(attempt.rest[3],config);}
  await f.client.fetch2('balance',api,'GET',params);assert.equal(f.timeReads(),1,'Successful calibration does not establish periodic time polling');
});

test('the uncalibrated signing fixture fails before the wrapper repairs its timestamp',async t=>{
  const f=fixture(t,'bybit',false);
  await assert.rejects(f.client.fetch2('wallet/balance','private','GET',{}),error=>error===f.timestampError);
  assert.equal(f.attempts.length,1);assert.equal(f.timeReads(),0);
  configureExchangeClock(f.client,'bybit');assert.equal((await f.client.fetch2('wallet/balance','private','GET',{})).ok,true);
  assert.equal(f.attempts.length,3);assert.equal(f.timeReads(),1);
});

test('a second explicit timestamp rejection is retained without recursive resubmission',async t=>{
  const f=fixture(t);f.setAttempt(async()=>{throw f.timestampError;});
  await assert.rejects(f.client.fetch2('order/history','private','GET',{}),error=>error===f.timestampError);
  assert.equal(f.attempts.length,2);assert.equal(f.timeReads(),1);
});

test('financial writes, public or spot reads, foreign API groups and other venues never calibrate or replay',async t=>{
  for(const [id,api,method] of [
    ['bybit','private','POST'],['bybit','private','DELETE'],['binance','fapiPrivate','POST'],['binance','fapiPrivateV3','DELETE'],
    ['bybit','public','GET'],['bybit','fapiPrivate','GET'],['binance','public','GET'],['binance','private','GET'],
    ['binance','sapi','GET'],['gate','private','GET'],['okx','private','GET'],['bitget','private','GET'],
  ] as const){
    const f=fixture(t,id);f.setAttempt(async()=>{throw f.timestampError;});
    await assert.rejects(f.client.fetch2('unchanged-path',api,method,{}),error=>error===f.timestampError);
    assert.equal(f.attempts.length,1,`${id} ${api} ${method}`);assert.equal(f.timeReads(),0);assert.equal(f.client.options.timeDifference,0);
  }
});

test('timeout and permission diagnostics do not become clock recovery even when a transport retained the business code',async t=>{
  for(const diagnostic of [new ExchangeNetworkError('TIMEOUT',0,'10002','bybit'),new ExchangeNetworkError('ACCESS_DENIED',0,'10002','bybit'),
    new ExchangeNetworkError('API_ERROR',0,'10005','bybit'),new ExchangeNetworkError('RATE_LIMITED',0,'429','bybit'),
    new Error('timestamp out of recvWindow without an explicit official code')] ){
    const f=fixture(t);f.setAttempt(async()=>{throw diagnostic;});
    await assert.rejects(f.client.fetch2('wallet/balance','private','GET',{}),error=>error===diagnostic);
    assert.equal(f.attempts.length,1);assert.equal(f.timeReads(),0);
  }
});

test('concurrent signed read failures share one calibration without serializing financial writes',async t=>{
  const f=fixture(t);let resolveTime!:(value:number)=>void;f.setTime(()=>new Promise(resolve=>{resolveTime=resolve;}));
  const first=f.client.fetch2('wallet/balance','private','GET',{}),second=f.client.fetch2('order/history','private','GET',{});
  for(let tick=0;tick<20&&!f.timeReads();tick++)await Promise.resolve();assert.equal(f.timeReads(),1);
  f.setAttempt(async attempt=>{if(attempt.method!=='GET')return {write:'untouched'};
    if(attempt.timestamp!==f.serverNow())throw f.timestampError;return {ok:true};});
  assert.deepEqual(await f.client.fetch2('order/create','private','POST',{clientOrderId:'original-write'}),{write:'untouched'});
  assert.equal(f.timeReads(),1);resolveTime(f.serverNow());await Promise.all([first,second]);
  assert.equal(f.timeReads(),1);assert.equal(f.attempts.filter(attempt=>attempt.method==='GET').length,4);
});

test('a late response from an old signature reuses the newer calibration revision',async t=>{
  const f=fixture(t);let rejectLate!:(error:unknown)=>void;
  f.setAttempt(async attempt=>{if(attempt.path==='late'&&attempt.offset===0)return new Promise((_resolve,reject)=>{rejectLate=reject;});
    if(attempt.timestamp!==f.serverNow())throw f.timestampError;return {ok:true};});
  const late=f.client.fetch2('late','private','GET',{});await Promise.resolve();
  assert.equal((await f.client.fetch2('fast','private','GET',{})).ok,true);assert.equal(f.timeReads(),1);
  rejectLate(f.timestampError);assert.equal((await late).ok,true);assert.equal(f.timeReads(),1);assert.equal(f.attempts.length,4);
});

test('failed calibration preserves the old offset, waits fifteen seconds, then accepts a valid sample',async t=>{
  const f=fixture(t);f.client.options.timeDifference=1234;f.setTime(async()=>NaN);
  await assert.rejects(f.client.fetch2('wallet/balance','private','GET',{}),error=>error===f.timestampError);
  assert.equal(f.client.options.timeDifference,1234);assert.equal(f.timeReads(),1);assert.equal(f.attempts.length,1);
  f.setTime(async()=>f.serverNow());f.advance(14999);
  await assert.rejects(f.client.fetch2('wallet/balance','private','GET',{}),error=>error===f.timestampError);
  assert.equal(f.timeReads(),1);assert.equal(f.client.options.timeDifference,1234);
  f.advance(1);assert.equal((await f.client.fetch2('wallet/balance','private','GET',{})).ok,true);
  assert.equal(f.timeReads(),2);assert.equal(f.client.options.timeDifference,-5000);assert.equal(f.attempts.length,4);
});

for(const sample of ['NaN','string','fraction','zero','slow','wall-forward','wall-backward','monotonic-backward'] as const)
test(`invalid ${sample} time observation cannot overwrite the last offset or replay the signed read`,async t=>{
  const f=fixture(t);f.client.options.timeDifference=1234;
  f.setTime(async()=>{
    if(sample==='NaN')return NaN;if(sample==='string')return String(f.serverNow());if(sample==='fraction')return f.serverNow()+.5;if(sample==='zero')return 0;
    if(sample==='slow')f.advance(4001);if(sample==='wall-forward')f.advance(100,351);if(sample==='wall-backward')f.advance(100,-151);
    if(sample==='monotonic-backward')f.advance(-1,0);return f.serverNow();
  });
  await assert.rejects(f.client.fetch2('order/history','private','GET',{}),error=>error===f.timestampError);
  assert.equal(f.attempts.length,1);assert.equal(f.timeReads(),1);assert.equal(f.client.options.timeDifference,1234);
});

test('the sample safety boundary accepts exactly four seconds RTT and 250 milliseconds wall divergence',async t=>{
  for(const [elapsed,wallElapsed] of [[4000,4000],[100,350]] as const){
    const f=fixture(t);f.setTime(async()=>{f.advance(elapsed,wallElapsed);return f.serverNow();});
    assert.equal((await f.client.fetch2('wallet/balance','private','GET',{})).ok,true);
    assert.equal(f.timeReads(),1);assert.equal(f.client.options.timeDifference,-5000);
  }
});

test('clock calibration and the retried read consume the original total request budget',async t=>{
  const f=fixture(t);f.client.timeout=500;
  f.setAttempt(async()=>{f.advance(300);throw f.timestampError;});f.setTime(async()=>{f.advance(250);return f.serverNow();});
  await assert.rejects(f.client.fetch2('wallet/balance','private','GET',{}),error=>error===f.timestampError);
  assert.equal(f.attempts.length,1);assert.equal(f.timeReads(),1);assert.equal(f.client.options.timeDifference,0);
});

test('an earlier parent deadline prevents calibration from obtaining a fresh six-second budget',async t=>{
  const f=fixture(t);f.setAttempt(async()=>{f.advance(350);throw f.timestampError;});
  f.setTime(async()=>{f.advance(300);return f.serverNow();});
  await assert.rejects(withExchangeRequestContext(f.client,{deadlineAt:f.now()+600},()=>f.client.fetch2('wallet/balance','private','GET',{})),error=>error===f.timestampError);
  assert.equal(f.attempts.length,1);assert.equal(f.timeReads(),1);assert.equal(f.client.options.timeDifference,0);
});

test('a parent abort during public calibration stops the recovery and preserves the original private diagnostic',async t=>{
  const f=fixture(t),controller=new AbortController();f.setTime(async()=>{controller.abort();return f.serverNow();});
  await assert.rejects(withExchangeRequestContext(f.client,{signal:controller.signal,deadlineAt:f.now()+1000},()=>f.client.fetch2('wallet/balance','private','GET',{})),error=>error===f.timestampError);
  assert.equal(f.attempts.length,1);assert.equal(f.timeReads(),1);assert.equal(f.client.options.timeDifference,0);
});

test('an expired parent scope prevents the first signed request itself',async t=>{
  const f=fixture(t);
  await assert.rejects(withExchangeRequestContext(f.client,{deadlineAt:f.now()},()=>f.client.fetch2('wallet/balance','private','GET',{})),
    error=>error instanceof ExchangeNetworkError&&error.code==='TIMEOUT');
  assert.equal(f.attempts.length,0);assert.equal(f.timeReads(),0);
});

test('a caller-supplied timestamp stays transparent because it overrides the client nonce',async t=>{
  const f=fixture(t),params=Object.freeze({timestamp:f.now(),recvWindow:10000,orderId:'original-order'});
  await assert.rejects(f.client.fetch2('order/history','private','GET',params),error=>error===f.timestampError);
  assert.equal(f.attempts.length,1);assert.equal(f.attempts[0].rest[0],params);assert.equal(f.timeReads(),0);assert.equal(f.client.options.timeDifference,0);
});

test('installation is idempotent and keeps the same live client rather than rebuilding its transport',async t=>{
  const f=fixture(t),wrapper=f.client.fetch2,fetch=f.client.fetch,options=f.client.options;
  configureExchangeClock(f.client,'bybit');configureExchangeClock(f.client,'bybit');assert.equal(f.client.fetch2,wrapper);assert.equal(f.client.fetch,fetch);
  assert.equal(f.client.options,options);assert.equal((await f.client.fetch2('wallet/balance','private','GET',{})).ok,true);
  assert.equal(f.attempts.length,2);assert.equal(f.timeReads(),1);
});

test('missing clock primitives do not install a half-functional recovery wrapper',t=>{
  for(const client of [{fetch2:async()=>({ok:true}),options:{}},{fetchTime:async()=>Date.now(),options:{}}]){
    const prior=(client as any).fetch2;configureExchangeClock(client,'bybit');assert.equal((client as any).fetch2,prior);
  }
});

test('transport plus failed clock recovery retains only the sanitized original business error',async()=>{
  const client:any={options:{timeDifference:1234,recvWindow:10000},milliseconds:()=>Date.now(),
    fetch:async(url:string)=>{throw new Error(url.includes('/v5/market/time')?'public-calibration-canary apiKey=time-secret':
      'bybit {"retCode":10002,"retMsg":"Request timestamp is outside the receive window apiKey=private-secret"}');},
    fetch2:async function(_path:string,_api:string,method:string){return client.fetch('https://api.bybit.com/v5/account/wallet-balance',method);},
    fetchTime:async()=>client.fetch('https://api.bybit.com/v5/market/time','GET')};
  configureExchangeTransport(client,'bybit');configureExchangeClock(client,'bybit');
  await assert.rejects(client.fetch2('wallet/balance','private','GET',{}),error=>{
    assert(error instanceof ExchangeNetworkError);assert.equal(error.apiCode,'10002');
    assert.match(JSON.stringify(error),/Request timestamp is outside the receive window/);
    assert.doesNotMatch(error.message+JSON.stringify(error),/public-calibration-canary|private-secret|time-secret|apiKey|api\.bybit/);return true;
  });
  assert.equal(client.options.timeDifference,1234);assert.equal(client.options.recvWindow,10000);
});
