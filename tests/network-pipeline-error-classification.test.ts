import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGunzip,gzipSync} from 'node:zlib';
import {errors} from 'undici';
import {classifyNetworkError,configureExchangeTransport,consumeBybitCreateNotSent,exchangeApiCode,ExchangeNetworkError,withExchangeRequestContext} from '../src/adapters/network.js';
import {exchangeClientId} from '../src/adapters/normalization.js';

const payload={probe:'local interrupted compressed response'},bytes=gzipSync(Buffer.from(JSON.stringify(payload)));
async function prematureClose(){
  const input=new Readable({read(){}});
  const reading=pipeline(input,createGunzip(),async source=>{for await(const _chunk of source){};});
  input.push(bytes.subarray(0,15));setImmediate(()=>input.destroy());
  return reading.then(()=>undefined,error=>error);
}
function clientFixture(failures=Infinity){
  let calls=0;
  const client:any={zlibModule:{createGunzip},undiciBody(){throw new Error('unexpected uncompressed fixture');},
    async fetch(){
      const fail=++calls<=failures,input=fail?new Readable({read(){}}):Readable.from([bytes]);
      const reading=client.undiciBody({statusCode:200,headers:{'content-encoding':'gzip'},body:input});
      if(fail){input.push(bytes.subarray(0,15));setImmediate(()=>input.destroy());}
      return JSON.parse(await reading);
    }};
  configureExchangeTransport(client,'bybit',{proxyUrl:undefined});
  return {client,calls:()=>calls};
}
const isNetworkFailure=(error:unknown)=>error instanceof ExchangeNetworkError&&error.code==='NETWORK_ERROR';

test('an actual Node pipeline premature close is a transport failure',async()=>{
  const error=await prematureClose();assert(error instanceof Error);
  assert.equal((error as Error&{code:string}).code,'ERR_STREAM_PREMATURE_CLOSE');
  assert.equal(classifyNetworkError(error),'NETWORK_ERROR');
});

test('premature-close words, inherited or getter codes and business responses cannot fabricate the transport category',()=>{
  assert.equal(classifyNetworkError(new Error('Premature close')),'API_ERROR');
  const business=new Error('gate {"label":"INVALID_KEY","message":"Premature close"}');
  assert.equal(classifyNetworkError(business),'API_ERROR');assert.equal(exchangeApiCode('gate',business),'INVALID_KEY');
  let reads=0;const getter=new Error('unclassified');
  Object.defineProperty(getter,'code',{get(){reads++;return 'ERR_STREAM_PREMATURE_CLOSE';}});
  assert.equal(classifyNetworkError(getter),'API_ERROR');assert.equal(reads,0);
  const inherited=new Error('unclassified');Object.setPrototypeOf(inherited,Object.assign(Object.create(Error.prototype),{code:'ERR_STREAM_PREMATURE_CLOSE'}));
  assert.equal(classifyNetworkError(inherited),'API_ERROR');
  assert.equal(classifyNetworkError(Object.assign(new Error('unclassified'),{code:'ERR_STREAM_PREMATURE_CLOSE_FAKE'})),'API_ERROR');
});

test('installed Undici request cancellation retains its existing timeout category',()=>{
  const error=new errors.RequestAbortedError();assert.equal(error.name,'AbortError');assert.equal(error.code,'UND_ERR_ABORTED');
  assert.equal(classifyNetworkError(error),'TIMEOUT');
});

test('an interrupted GET body can retry once within the original budget and return a complete response',async()=>{
  const f=clientFixture(1);f.client.timeout=1000;
  assert.deepEqual(await f.client.fetch('https://api.bybit.com/v5/account/wallet-balance','GET'),payload);
  assert.equal(f.calls(),2);
});

test('persistent interrupted GET bodies stop at the existing retry limit',async()=>{
  const f=clientFixture();f.client.timeout=1000;
  await assert.rejects(f.client.fetch('https://api.bybit.com/v5/account/wallet-balance','GET'),isNetworkFailure);
  assert.equal(f.calls(),2);
});

test('a short logical GET deadline does not gain a new budget to accommodate a retry',async()=>{
  const f=clientFixture();f.client.timeout=8000;
  await assert.rejects(withExchangeRequestContext(f.client,{deadlineAt:Date.now()+100},
    ()=>f.client.fetch('https://api.bybit.com/v5/account/wallet-balance','GET')),isNetworkFailure);
  assert.equal(f.calls(),1);assert.equal(f.client.timeout,8000);
});

for(const method of ['POST','DELETE'] as const)test(`a premature ${method} response never repeats its financial request`,async()=>{
  const f=clientFixture();f.client.timeout=1000;
  await assert.rejects(f.client.fetch('https://api.bybit.com/v5/order/create',method,{},'{}'),isNetworkFailure);
  assert.equal(f.calls(),1);
});

test('an admitted Bybit create cannot acquire no-send proof after a premature response or a later expired attempt',async()=>{
  const f=clientFixture(),logicalId='pipeline-premature-original-create';f.client.timeout=1000;
  const url='https://api.bybit.com/v5/order/create',body=JSON.stringify({category:'linear',orderLinkId:exchangeClientId('bybit',logicalId)});
  const first=await f.client.fetch(url,'POST',{},body).then(()=>undefined,(error:unknown)=>error);
  assert(isNetworkFailure(first));assert.equal(consumeBybitCreateNotSent(first,f.client,logicalId),false);assert.equal(f.calls(),1);
  const later=await withExchangeRequestContext(f.client,{deadlineAt:Date.now()-1},()=>f.client.fetch(url,'POST',{},body))
    .then(()=>undefined,(error:unknown)=>error);
  assert(later instanceof ExchangeNetworkError);assert.equal(later.code,'TIMEOUT');
  assert.equal(consumeBybitCreateNotSent(later,f.client,logicalId),false);assert.equal(f.calls(),1);
});
