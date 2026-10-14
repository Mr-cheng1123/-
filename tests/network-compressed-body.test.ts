import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {gzipSync,brotliCompressSync,deflateSync} from 'node:zlib';
import {setTimeout as delay} from 'node:timers/promises';
import {configureExchangeTransport,consumeBybitCreateNotSent,ExchangeNetworkError,withExchangeRequestContext} from '../src/adapters/network.js';
import {exchangeClientId} from '../src/adapters/normalization.js';

const ccxt=(await import(new URL('../node_modules/ccxt/js/ccxt.js',import.meta.url).href)).default;
const payload={retCode:0,retMsg:'OK',result:{text:'完整正文与真实字节 '.repeat(80)},retExtInfo:{},time:1};
const json=JSON.stringify(payload);
const encoders={gzip:gzipSync,br:brotliCompressSync,deflate:deflateSync};
type Encoding=keyof typeof encoders;

async function fixture(t:test.TestContext,encoding:Encoding,respond:(res:http.ServerResponse,bytes:Buffer)=>void,
  options:{status?:number;contentType?:string;contentEncoding?:string}={}){
  let served=0;
  const server=http.createServer((req,res)=>{
    if(req.url==='/warm'){res.end(JSON.stringify({retCode:0,retMsg:'OK',result:{},retExtInfo:{},time:1}));return;}
    served++;res.writeHead(options.status??200,{'content-type':options.contentType??'application/json','content-encoding':options.contentEncoding??encoding});
    respond(res,encoders[encoding](Buffer.from(json)));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert(address&&typeof address!=='string');
  const url=`http://127.0.0.1:${address.port}`;
  const client=new ccxt.bybit({enableRateLimit:false});
  configureExchangeTransport(client,'bybit',{proxyUrl:undefined});
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await client.close();});
  // Load installed native HTTP/zlib modules before applying a tiny body deadline.
  await client.fetch(`${url}/warm`,'GET');
  return {client,url,served:()=>served,server};
}

async function observed(promise:Promise<unknown>,limitMs=400){
  let timer:ReturnType<typeof setTimeout>|undefined;
  const result=await Promise.race([
    promise.then(value=>({state:'fulfilled' as const,value}),error=>({state:'rejected' as const,error})),
    new Promise<{state:'pending'}>(resolve=>{timer=setTimeout(()=>resolve({state:'pending'}),limitMs);}),
  ]);
  if(timer)clearTimeout(timer);
  return result;
}

for(const encoding of Object.keys(encoders) as Encoding[]){
  test(`native ${encoding} body stall obeys the unchanged request deadline`,async t=>{
    const f=await fixture(t,encoding,(res,bytes)=>res.write(bytes.subarray(0,Math.min(15,bytes.length-1))));
    f.client.timeout=80;
    const result=await observed(f.client.fetch(`${f.url}/stall`,'GET'));
    assert.equal(f.served(),1,'The native response must actually have reached the body stage');
    assert.equal(result.state,'rejected','Aborting the source body must also finish its decompressor');
    if(result.state==='rejected'){assert(result.error instanceof ExchangeNetworkError);assert.equal(result.error.code,'TIMEOUT');}
    assert.equal(f.client.timeout,80);
  });

  test(`native ${encoding} decompression preserves UTF-8 bytes and waits for body completion`,async t=>{
    let end!:()=>void;
    const f=await fixture(t,encoding,(res,bytes)=>{res.write(bytes);end=()=>res.end();});
    f.client.timeout=1000;
    let settled=false;
    const task=f.client.fetch(`${f.url}/complete`,'GET').finally(()=>{settled=true;});
    for(let turn=0;turn<50&&!end;turn++)await delay(2);
    assert.ok(end);await delay(20);assert.equal(settled,false,'Decoded bytes alone do not prove a complete response');
    end();assert.deepEqual(await task,payload);assert.equal(f.served(),1);
  });

  test(`native ${encoding} upstream socket error finishes the read without replaying a write`,async t=>{
    const f=await fixture(t,encoding,(res,bytes)=>{
      res.write(bytes.subarray(0,Math.min(15,bytes.length-1)));
      setTimeout(()=>res.destroy(),20);
    });
    f.client.timeout=1000;
    const result=await observed(f.client.fetch(`${f.url}/create`,'POST',{},'{}'));
    assert.equal(result.state,'rejected','A lost source stream cannot leave decompression waiting forever');
    if(result.state==='rejected'){assert(result.error instanceof ExchangeNetworkError);assert.equal(result.error.code,'NETWORK_ERROR');}
    assert.equal(f.served(),1);
  });
}

for(const method of ['POST','DELETE'] as const)test(`a compressed ${method} response deadline never repeats the financial request`,async t=>{
  const f=await fixture(t,'gzip',(res,bytes)=>res.write(bytes.subarray(0,15)));
  f.client.timeout=80;
  const result=await observed(f.client.fetch(`${f.url}/financial`,method,{},method==='POST'?'{}':undefined));
  assert.equal(result.state,'rejected');
  if(result.state==='rejected'){assert(result.error instanceof ExchangeNetworkError);assert.equal(result.error.code,'TIMEOUT');}
  assert.equal(f.served(),1);
});

test('a native-entered Bybit create with an interrupted compressed response cannot acquire no-send proof',async t=>{
  const f=await fixture(t,'gzip',(res,bytes)=>res.write(bytes.subarray(0,15)));
  const originalRequest=f.client.undiciRequest.bind(f.client);
  // Retain the exact create identity at the app boundary while routing solely to the local fixture.
  f.client.undiciRequest=(_url:string,params:unknown)=>originalRequest(`${f.url}/local-create`,params);
  const logicalId='compressed-response-original-create';
  const body=JSON.stringify({category:'linear',orderLinkId:exchangeClientId('bybit',logicalId)});
  f.client.timeout=80;
  const result=await observed(f.client.fetch('https://api.bybit.com/v5/order/create','POST',{},body));
  assert.equal(result.state,'rejected');
  if(result.state==='rejected'){
    assert(result.error instanceof ExchangeNetworkError);assert.equal(result.error.code,'TIMEOUT');
    assert.equal(consumeBybitCreateNotSent(result.error,f.client,logicalId),false);
  }
  assert.equal(f.served(),1);
});

test('caller abort reaches a compressed body without shrinking the native 8-second HTTP timeout',async t=>{
  const f=await fixture(t,'gzip',(res,bytes)=>res.write(bytes.subarray(0,15)));
  f.client.timeout=8000;
  const controller=new AbortController();
  const task=withExchangeRequestContext(f.client,{deadlineAt:Date.now()+1000,signal:controller.signal},()=>f.client.fetch(`${f.url}/abort`,'GET'));
  for(let turn=0;turn<50&&f.served()===0;turn++)await delay(2);
  assert.equal(f.served(),1);controller.abort();
  const result=await observed(task);
  assert.equal(result.state,'rejected');
  if(result.state==='rejected'){assert(result.error instanceof ExchangeNetworkError);assert.equal(result.error.code,'TIMEOUT');}
  assert.equal(f.client.timeout,8000);
});

test('one caller compressed-body deadline cannot cancel an independent read on the same native client',async t=>{
  let reads=0;
  const f=await fixture(t,'gzip',(res,bytes)=>{if(++reads===1)res.write(bytes.subarray(0,15));else setTimeout(()=>res.end(bytes),120);});
  f.client.timeout=8000;
  const first=withExchangeRequestContext(f.client,{deadlineAt:Date.now()+80},()=>f.client.fetch(`${f.url}/short`,'GET'));
  for(let turn=0;turn<50&&f.served()===0;turn++)await delay(2);
  const second=f.client.fetch(`${f.url}/independent`,'GET');
  const result=await observed(first);assert.equal(result.state,'rejected');
  if(result.state==='rejected'){assert(result.error instanceof ExchangeNetworkError);assert.equal(result.error.code,'TIMEOUT');}
  assert.deepEqual(await second,payload);assert.equal(f.served(),2);assert.equal(f.client.timeout,8000);
});

test('compressed binary response preserves the native Buffer result',async t=>{
  const binary=Buffer.from([0,1,2,255,239,187,191,128]);
  const f=await fixture(t,'gzip',res=>res.end(gzipSync(binary)),{contentType:'application/zip'});
  f.client.handleContentTypeApplicationZip=true;
  const result=await f.client.fetch(`${f.url}/binary`,'GET');
  assert.equal(Buffer.isBuffer(result),true);assert.deepEqual(result,binary);assert.equal(f.served(),1);
});

test('the native x-gzip alias keeps the same decompression semantics',async t=>{
  const f=await fixture(t,'gzip',(res,bytes)=>res.end(bytes),{contentEncoding:'x-gzip'});
  assert.deepEqual(await f.client.fetch(`${f.url}/alias`,'GET'),payload);
});

for(const status of [204,304])test(`native ${status} bodyless response ignores a gzip header`,async t=>{
  const f=await fixture(t,'gzip',res=>res.end(),{status});
  const response=await f.client.undiciRequest(`${f.url}/bodyless`,{method:'GET',headers:{},dispatcher:f.client.fetchDispatcher});
  assert.equal(response.status,status);assert.equal(await response.text(),'');assert.equal(f.served(),1);
});

test('unsupported chained content encoding retains native passthrough behavior',async t=>{
  const f=await fixture(t,'gzip',(res,bytes)=>res.end(bytes),{contentEncoding:'gzip, br'});
  const response=await f.client.undiciRequest(`${f.url}/unsupported`,{method:'GET',headers:{},dispatcher:f.client.fetchDispatcher});
  assert.equal(await response.text(),gzipSync(Buffer.from(json)).toString('utf8'));
});
