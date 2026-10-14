import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import https from 'node:https';
import {TLSSocket} from 'node:tls';
import {getEventListeners} from 'node:events';
import {AsyncLocalStorage} from 'node:async_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {Engine} from '../src/core/engine.js';
import {configureExchangeTransport,consumeBybitCreateNotSent,ExchangeNetworkError,withExchangeRequestContext} from '../src/adapters/network.js';
import {exchangeClientId} from '../src/adapters/normalization.js';
import {installProxyConnectCancellation} from '../src/adapters/proxy-connect-cancellation.js';
import type {AccountState,PrivateReadContext} from '../src/shared/types.js';
const ccxt=(await import(new URL('../node_modules/ccxt/js/ccxt.js',import.meta.url).href)).default;
const payload={retCode:0,retMsg:'OK',result:{ok:true},retExtInfo:{},time:1};
async function listen(server:http.Server){await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert(address&&typeof address==='object');return address.port;}
async function observe<T>(promise:Promise<T>,limitMs=800){let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise.then(value=>({state:'fulfilled' as const,value}),error=>({state:'rejected' as const,error})),
    new Promise<{state:'pending'}>(resolve=>{timer=setTimeout(()=>resolve({state:'pending'}),limitMs);})]);}finally{if(timer)clearTimeout(timer);}}
async function fixture(t:test.TestContext){
  const requests:Array<{method:string;url:string}>=[],sockets=new Set<net.Socket>(),held:Array<{socket:net.Socket;establish:()=>void}>=[];
  let hold=false,nativeCalls=0;
  const target=http.createServer((request,response)=>{requests.push({method:request.method!,url:request.url!});
    response.setHeader('Connection','close');response.end(JSON.stringify(payload));});
  const port=await listen(target),proxy=http.createServer();
  proxy.on('connect',(_request,socket,head)=>{const clientSocket=socket as net.Socket;sockets.add(clientSocket);clientSocket.once('close',()=>sockets.delete(clientSocket));
    const establish=()=>{if(clientSocket.destroyed)return;const upstream=net.connect({host:'127.0.0.1',port},()=>{
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);upstream.pipe(clientSocket);clientSocket.pipe(upstream);});
      sockets.add(upstream);upstream.once('close',()=>sockets.delete(upstream));upstream.on('error',()=>clientSocket.destroy());clientSocket.once('close',()=>upstream.destroy());};
    if(hold)held.push({socket:clientSocket,establish});else establish();});
  const proxyPort=await listen(proxy),client:any=new (ccxt as any).bybit({enableRateLimit:false});
  const nativeRequest=client.undiciRequest.bind(client);
  // All scopes come from the real configureExchangeTransport integration. Only
  // endpoint routing is replaced so every native connection stays on this machine.
  client.undiciRequest=(url:string,parameters:any)=>{nativeCalls++;return nativeRequest(`http://127.0.0.1:${port}${new URL(url).pathname}`,parameters);};
  configureExchangeTransport(client,'bybit',{proxyUrl:`http://127.0.0.1:${proxyPort}`});
  t.after(async()=>{for(const socket of sockets)socket.destroy();target.closeAllConnections();proxy.closeAllConnections();
    await Promise.all([new Promise<void>(resolve=>target.close(()=>resolve())),new Promise<void>(resolve=>proxy.close(()=>resolve()))]);await client.close();});
  await client.fetch(`http://127.0.0.1:${port}/warm`,'GET');
  return {client,held,requests,hold:()=>{hold=true;},resume:()=>{hold=false;for(const pending of held)pending.establish();},
    nativeCalls:()=>nativeCalls,url:(path:string)=>`http://127.0.0.1:${port}${path}`};
}
function owner(){const value:any={privateReadRequests:new WeakMap(),accountReadAt:new WeakMap(),accountReadSources:new WeakMap(),
  store:{data:{config:{maxSnapshotAgeMs:30000}}},options:{privateReadDeadlineMs:80},startGeneration:1};Object.setPrototypeOf(value,Engine.prototype);return value;}
const account:AccountState={freeUsd:100,equityUsd:100,positions:[]};

// Generated exclusively for localhost transport fixtures. Never used by an exchange client.
const TLS_TEST_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCysrlifcXGxPUM\nMMaKBW16hpbjdNHIjCO9cyf9HWvmiIoAqZbvwZIhWeDROWxQTS8T/MSfIiwp+zEj\nGvqJ0q9WXmJdSL3UG9Hy9bjbAnHqU0mAs7S3PpOJ9LWGSRZRWAC0u1NvPE/Yf9PH\nJLW5sNx/3E8jM7V2MmMaP2E3cpMTKwQMUFFxE0R3PA/Fw5+OkjRwz2QCELHY4/pL\nXtrHLcspIBa5g68GRTrfnmdgpCO9FRaX8uK85LpxsNa4izPpYIahO1SS5OShspBc\nS9dnZyw9VcaCrjDt1e4KXKAjsAWpI9fd2Z1lydVpxsiaqS0KX29fvCZXeTKHplMY\npmxirZefAgMBAAECggEAAlhODnjQC5eyD4LkWBNSKHVzrXBvAE62eVn1gGDOdav9\nA502GddUb5OaW6SBQ1x/7ac3fU8ZfUOKlYdZGk3ldyCt8cNumkXzL1kCH/2cORL2\nt/WjvXPYw8quRyDWZiLdf4GlyqPj+FdVFBvrNpCXlCXz8+ZNz0tB+aozQGMEgw/b\n1K3J+fZdEPBGKfbSxn2qaeolYm2eebwoeU3x+by2vw7HGcazT3bAyZDiOMRMBmno\n5rkXgCk/4coctluRTZLSzULmSCLL6yYqXG7im8/PFULiPjfe6n5dNl6Kzd96mbsG\nR5VGjiHaJmlzPE0vzt8db5pbQZQ/puGjJxc/qYzsIQKBgQDXF3+Er8DOJMjkOfsf\nZDbD3lywZsPo7Q/xh0dbmxgM1uf979EZrTfi5s+Y5f4z9ne5/ADweTPD54/gGD4g\nm5QsHEqY5BGzIQwd6LK7xbaVVZCs7dkF2GZ7jIV+2dNmT8kAfBDH7RgazwWvmkl5\nYooUPao6Ai+4N2Rrd94AJ42pWwKBgQDUr0Xjc9NYwyrOAV5O9KT+Y9gemTcVUXG9\nURCRIJFunMeHW54EoRIIGaZi0zNk2RcETyWs1Luqnve8JGKb5Pqt18hiqu6QLd8m\nqf/LDVLadOCiLv6BTQRfONpaUYResPuVHgwRLr/u6qZpco4bOpwcaGIKHqmO0HgS\nRsQH+XZaDQKBgC38vCrmWNa6TqldLC/eAUeHd1HP5vsaFFqTjdIsKswz9o34hEB1\nJInCx4ftRJhfjeGZ26mOgF7WV5CWHlJicR+tPNXLjW07F5gddHlpIEx1auVORSRW\nzDKGLNSeRfCOBm+wFvZn3st8j76nwiXNx6/kL00PwpwkW7gOfMyTqFoZAoGAUEPZ\nb059+2ikVdyEV+3R+sN5g4q1FBGJiDX4t5x/5iu6zWWRDBQxducfOPqV0cBwBEtO\nX5xlOq4FtnZQ1J6k0Ei4MixqHfWB2tibVWkw1Ir5X5u2ptuHA9yz4xQSjZ3jRFJz\noWRwQN1DclYuNS54TexC26jYurIILnWQc6X8uV0CgYAHqwUJrbPFBMx3IHuLCWvq\nPsjYqmcgWYfzGrK+iUhA2rtbj85ZozEE5J+z59WysCLTAPopQAzlIEhoTGCsqekj\nZDJoUByg1cemwskK0Wzx91GxkGXGYcJwlKpuvdQ6ef3Dg5VZ2YtV3LVc7jX84/ux\nDJIzYH0bk6WrkGZTQeMjQA==\n-----END PRIVATE KEY-----\n";
const TLS_TEST_CERT="-----BEGIN CERTIFICATE-----\nMIIDJTCCAg2gAwIBAgIUL+hN0bDrhDOAohCxzBQ0MwFjOiUwDQYJKoZIhvcNAQEL\nBQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTAxNDEwMjUzN1oXDTM2MTAx\nMTEwMjUzN1owFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF\nAAOCAQ8AMIIBCgKCAQEAsrK5Yn3FxsT1DDDGigVteoaW43TRyIwjvXMn/R1r5oiK\nAKmW78GSIVng0TlsUE0vE/zEnyIsKfsxIxr6idKvVl5iXUi91BvR8vW42wJx6lNJ\ngLO0tz6TifS1hkkWUVgAtLtTbzxP2H/TxyS1ubDcf9xPIzO1djJjGj9hN3KTEysE\nDFBRcRNEdzwPxcOfjpI0cM9kAhCx2OP6S17axy3LKSAWuYOvBkU6355nYKQjvRUW\nl/LivOS6cbDWuIsz6WCGoTtUkuTkobKQXEvXZ2csPVXGgq4w7dXuClygI7AFqSPX\n3dmdZcnVacbImqktCl9vX7wmV3kyh6ZTGKZsYq2XnwIDAQABo28wbTAdBgNVHQ4E\nFgQUvhp2TEVX3Bv8pBPz51fnhqUpamYwHwYDVR0jBBgwFoAUvhp2TEVX3Bv8pBPz\n51fnhqUpamYwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH\nBH8AAAEwDQYJKoZIhvcNAQELBQADggEBAGFUiE2z5i2lp6IbSLgyZEHAVFiw7akn\nebAmvFkErB0LdNjst18P0c3F5qvVzgqJtdGAtKOyqBI5NhGYYj7PIzAHOE5ej8j6\nSIlF2TfWtXNUTpGAEMT+spEkJ3ULsGwEbJQByeIYN6OKB3J+oREBxSzidfSkXQb/\nts30R1U+rhlprJO7hTbpcPXUypS5Ee/Qtq16kfAPLj5plNrwp8PxtjnyTK/Tc6ZY\nhnXUGJq4ukrEbTPHrg14ZQivWLlrYboLwBWeSCW/mQF3Uy8FlKc7Ouh202/NucEe\nlang7nWCbs1Lfb/aHcjIGJ173X08emKZBR1h83Ud1VImffAYQ6Yu11c=\n-----END CERTIFICATE-----\n";
async function tlsFixture(t:test.TestContext,stall=true,holdHandshake=false){
  const requests:string[]=[],sockets=new Set<net.Socket>(),handshakes:Array<()=>void>=[];let connects=0,heldResponse:any,nativeCalls=0;
  const target=stall?net.createServer(socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.on('data',()=>{});}):
    https.createServer({key:TLS_TEST_KEY,cert:TLS_TEST_CERT},(request,response)=>{requests.push(request.url!);
      if(request.url==='/second'){heldResponse=response;return;}response.end(JSON.stringify(payload));});
  const port=await new Promise<number>(resolve=>target.listen(0,'127.0.0.1',()=>resolve((target.address() as net.AddressInfo).port))),proxy=http.createServer();
  proxy.on('connect',(request,socket,head)=>{if(Number(request.url!.split(':').at(-1))===port)connects++;const clientSocket=socket as net.Socket;sockets.add(clientSocket);clientSocket.once('close',()=>sockets.delete(clientSocket));
    const selected=Number(request.url!.split(':').at(-1))===port;
    const upstream=net.connect({host:'127.0.0.1',port:Number(request.url!.split(':').at(-1))},()=>{clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const forward=()=>{if(clientSocket.destroyed)return;if(head.length)upstream.write(head);upstream.pipe(clientSocket);clientSocket.pipe(upstream);};
      if(holdHandshake&&selected)handshakes.push(forward);else forward();});
    sockets.add(upstream);upstream.once('close',()=>sockets.delete(upstream));upstream.on('error',()=>clientSocket.destroy());clientSocket.once('close',()=>upstream.destroy());});
  const proxyPort=await listen(proxy),client:any=new (ccxt as any).bybit({enableRateLimit:false}),originalOptions=client.getDispatcherOptions;
  const originalRequest=client.undiciRequest.bind(client);
  client.undiciRequest=(url:string,parameters:any)=>{nativeCalls++;const endpoint=new URL(url);
    return originalRequest(endpoint.hostname==='api.bybit.com'?`https://127.0.0.1:${port}${endpoint.pathname}`:url,parameters);};
  client.getDispatcherOptions=function(plain=false){const original=originalOptions.call(this,plain);return plain?original:{...original,...(!stall&&!holdHandshake?{connections:1}:{}),requestTls:{...original.requestTls,ca:TLS_TEST_CERT,servername:'localhost'}};};
  configureExchangeTransport(client,'bybit',{proxyUrl:`http://127.0.0.1:${proxyPort}`});
  t.after(async()=>{for(const socket of sockets)socket.destroy();if('closeAllConnections' in target)target.closeAllConnections();proxy.closeAllConnections();
    await Promise.all([new Promise<void>(resolve=>target.close(()=>resolve())),new Promise<void>(resolve=>proxy.close(()=>resolve()))]);await client.close();});
  // Warm module initialization, never the target TLS handshake.
  const warm=http.createServer((_request,response)=>response.end(JSON.stringify(payload))),warmPort=await listen(warm);
  try{await client.fetch(`http://127.0.0.1:${warmPort}/warm`,'GET');}finally{warm.closeAllConnections();await new Promise<void>(resolve=>warm.close(()=>resolve()));}
  return {client,requests,url:(path:string)=>`https://127.0.0.1:${port}${path}`,connects:()=>connects,nativeCalls:()=>nativeCalls,
    resumeHandshake:()=>{holdHandshake=false;for(const forward of handshakes)forward();},
    release:()=>{assert(heldResponse);heldResponse.end(JSON.stringify(payload));},secondReady:async()=>{for(let i=0;i<100&&!heldResponse;i++)await delay(5);assert(heldResponse);}};
}

test('a target TLS handshake after successful CONNECT drains the actual selected account request at its original deadline',async t=>{
  const f=await tlsFixture(t),engine=owner();
  const adapter={id:'bybit',fetchAccount:(context:PrivateReadContext)=>withExchangeRequestContext(f.client,context,async()=>{
    await f.client.fetch(f.url('/account'),'GET');return structuredClone(account);})};
  const read=engine.readTradingAccount(adapter),raw=engine.privateReadRequests.get(adapter).get('account');
  const first=await observe(read);assert.equal(first.state,'rejected');
  assert.notEqual((await observe(raw,250)).state,'pending','native target TLS handshake must end instead of keeping the raw account slot until Undici default 10 seconds');
  await delay(5);assert.equal(engine.privateReadRequests.get(adapter)?.has('account'),false);
  assert.equal(f.connects(),1);assert.deepEqual(f.requests,[]);
});

test('cancelling an undelivered TLS socket leaves a concurrent caller on the same cached ProxyAgent untouched',async t=>{
  const f=await tlsFixture(t,false,true);
  const first=observe(withExchangeRequestContext(f.client,{deadlineAt:Date.now()+80},()=>f.client.fetch(f.url('/short'),'GET')));
  let secondSettled=false;
  const second=withExchangeRequestContext(f.client,{deadlineAt:Date.now()+1000},()=>f.client.fetch(f.url('/long'),'GET'))
    .finally(()=>{secondSettled=true;});
  assert.equal((await first).state,'rejected');assert.equal(secondSettled,false);assert.equal(f.connects(),2);
  f.resumeHandshake();assert.deepEqual(await second,payload);assert.deepEqual(f.requests,['/long']);
});

for(const method of ['POST','DELETE'] as const)test(`an undelivered target TLS timeout cannot replay ${method} or supply Bybit financial no-send evidence`,async t=>{
  const f=await tlsFixture(t),id=`local-tls-${method.toLowerCase()}`,body=JSON.stringify({category:'linear',orderLinkId:exchangeClientId('bybit',id)});
  const endpoint=method==='POST'?'https://api.bybit.com/v5/order/create':'https://api.bybit.com/v5/order/cancel';
  const before=f.nativeCalls(),result=await observe(withExchangeRequestContext(f.client,{deadlineAt:Date.now()+80},()=>f.client.fetch(endpoint,method,{},body)));
  assert.equal(result.state,'rejected');if(result.state==='rejected'){assert(result.error instanceof ExchangeNetworkError);assert.equal(result.error.code,'TIMEOUT');
    assert.equal(consumeBybitCreateNotSent(result.error,f.client,id),false);}
  assert.equal(f.nativeCalls(),before+1);assert.deepEqual(f.requests,[]);assert.equal(f.connects(),1);
});

test('successful TLS delivery removes the old cancellation before an independent request reuses its cached connection',async t=>{
  const f=await tlsFixture(t,false),first=new AbortController(),second=new AbortController();
  assert.deepEqual(await withExchangeRequestContext(f.client,{signal:first.signal,deadlineAt:Date.now()+1000},()=>f.client.fetch(f.url('/first'),'GET')),payload);
  await delay(10); // Finish the native body close before deliberately reusing its sole origin connection.
  const cached=f.client.getFetchProxyDispatcher(f.client.httpsProxy);
  const pending=withExchangeRequestContext(f.client,{signal:second.signal,deadlineAt:Date.now()+1000},()=>f.client.fetch(f.url('/second'),'GET'));
  await f.secondReady();first.abort(new Error('former caller has ended'));await delay(20);
  assert.equal(f.client.getFetchProxyDispatcher(f.client.httpsProxy),cached);f.release();assert.deepEqual(await pending,payload);
  assert.deepEqual(f.requests,['/first','/second']);assert.equal(f.connects(),1,'cancelled former owner must not destroy an already delivered reusable TLS connection');
});

test('an actual stalled proxy CONNECT obeys the Engine deadline, settles native raw ownership and the same client recovers',async t=>{
  const f=await fixture(t),engine=owner();f.hold();
  const adapter={id:'bybit',fetchAccount:(context:PrivateReadContext)=>withExchangeRequestContext(f.client,context,async()=>{
    await f.client.fetch(f.url('/account'),'GET');return structuredClone(account);})};
  const first=await observe(engine.readTradingAccount(adapter));assert.equal(first.state,'rejected');
  if(first.state==='rejected'){assert(first.error instanceof ExchangeNetworkError);assert.equal(first.error.code,'TIMEOUT');}
  const raw=engine.privateReadRequests.get(adapter)?.get('account');if(raw)assert.notEqual((await observe(raw)).state,'pending');
  await delay(5);assert.equal(engine.privateReadRequests.get(adapter)?.has('account'),false);
  assert.deepEqual(f.requests.map(row=>row.url),['/warm']);assert.equal(f.nativeCalls(),2);
  f.resume();assert.deepEqual(await engine.readTradingAccount(adapter),account);assert.equal(f.nativeCalls(),3);
  assert.deepEqual(f.requests.map(row=>row.url),['/warm','/account']);assert.equal(f.client.timeout,8000);
});

test('short proxy CONNECT cancellation does not cancel a concurrent independent request on the same cached ProxyAgent',async t=>{
  const f=await fixture(t);f.hold();
  const first=withExchangeRequestContext(f.client,{deadlineAt:Date.now()+80},()=>f.client.fetch(f.url('/short'),'GET'));
  const firstOutcome=observe(first);
  const second=withExchangeRequestContext(f.client,{deadlineAt:Date.now()+800},()=>f.client.fetch(f.url('/long'),'GET'));
  let secondSettled=false;const secondOutcome=second.finally(()=>{secondSettled=true;});
  const result=await firstOutcome;assert.equal(result.state,'rejected');assert.equal(secondSettled,false);
  assert.equal(f.held.length,2);assert.deepEqual(f.requests.map(row=>row.url),['/warm']);
  f.resume();assert.deepEqual(await secondOutcome,payload);assert.deepEqual(f.requests.map(row=>row.url),['/warm','/long']);
  assert.equal(f.client.timeout,8000);
});

for(const method of ['POST','DELETE'] as const)test(`proxy CONNECT timeout cannot replay a ${method} or grant Bybit financial no-send authority`,async t=>{
  const f=await fixture(t);f.hold();const id=`local-proxy-${method.toLowerCase()}`,body=JSON.stringify({category:'linear',orderLinkId:exchangeClientId('bybit',id)});
  const endpoint=method==='POST'?'https://api.bybit.com/v5/order/create':'https://api.bybit.com/v5/order/cancel';
  const result=await observe(withExchangeRequestContext(f.client,{deadlineAt:Date.now()+80},()=>f.client.fetch(endpoint,method,{},body)));
  assert.equal(result.state,'rejected');if(result.state==='rejected'){assert(result.error instanceof ExchangeNetworkError);assert.equal(result.error.code,'TIMEOUT');
    assert.equal(consumeBybitCreateNotSent(result.error,f.client,id),false,'entering original fetch cannot be reclassified as a financial zero-send proof');}
  assert.equal(f.nativeCalls(),2);f.resume();await delay(30);assert.deepEqual(f.requests.map(row=>row.method),['GET']);
});

test('existing factory, proxy pool identity, original options and callback/promise signatures remain intact',async()=>{
  const storage=new AsyncLocalStorage<{signal?:AbortSignal}>(),calls:any[]=[],received:any[]=[],close=()=>{};
  const pool={connect(parameters:any,callback?:unknown){calls.push({parameters,callback,receiver:this});return callback?'callback-result':Promise.resolve('promise-result');},close};
  const factory=(origin:unknown,options:unknown)=>{received.push([origin,options]);return pool;},original={connections:2,clientFactory:factory,requestTls:{servername:'original'}};
  const client:any={getDispatcherOptions:()=>original,undiciModule:{Pool:class{constructor(){throw new Error('custom factory must be preserved');}}}};
  installProxyConnectCancellation(client,()=>storage.getStore());
  assert.equal(client.getDispatcherOptions(true),original);const options=client.getDispatcherOptions(false);assert.equal(original.clientFactory,factory);
  const connectOptions={connect:()=>{}},created=options.clientFactory('http://local-proxy',connectOptions);
  assert.equal(created,pool);assert.equal(pool.close,close);assert.deepEqual(received,[['http://local-proxy',connectOptions]]);
  const caller=new AbortController(),originalSignal=new AbortController(),headers={host:'original-target'},callback=()=>{};
  const parameters={signal:originalSignal.signal,path:'original-target',headers};
  const value=storage.run({signal:caller.signal},()=>pool.connect(parameters,callback));assert.equal(value,'callback-result');
  assert.equal(calls[0].callback,callback);assert.equal(calls[0].receiver,pool);assert.equal(calls[0].parameters.headers,headers);
  assert.equal(parameters.signal,originalSignal.signal);assert.equal(calls[0].parameters.path,parameters.path);
  assert.notEqual(calls[0].parameters.signal,caller.signal);caller.abort();assert.equal(calls[0].parameters.signal.aborted,true);
  assert.equal(await pool.connect(parameters),'promise-result');assert.equal(calls[1].parameters,parameters,'unscoped CONNECT keeps its original parameters');
  const connect=pool.connect,second=options.clientFactory('http://same-local-proxy',connectOptions);
  assert.equal(second,pool);assert.equal(second.connect,connect,'a repeated custom pool must not gain nested wrappers');
  const later=new AbortController();await storage.run({signal:later.signal},()=>pool.connect({path:'later'}));
  assert.equal(calls.length,3);assert.equal(calls[2].parameters.signal,later.signal,'a reused pool reads the current caller instead of retaining the first aborted signal');
});

test('the native default Pool and both current and existing cancellation signals are preserved',async()=>{
  let constructed=0,parameters:any;const controller=new AbortController(),prior=new AbortController();
  class Pool {constructor(readonly origin:unknown,readonly options:unknown){constructed++;}connect(input:any){parameters=input;return Promise.resolve('ok');}}
  const client:any={getDispatcherOptions:()=>({connections:256,pipelining:1}),undiciModule:{Pool}};
  installProxyConnectCancellation(client,()=>({signal:controller.signal}));const native={connect:()=>{}},pool=client.getDispatcherOptions(false).clientFactory('http://local-proxy',native);
  assert(pool instanceof Pool);assert.equal(constructed,1);assert.equal(pool.origin,'http://local-proxy');assert.equal(pool.options,native);
  assert.equal(await pool.connect({signal:prior.signal,path:'target'}),'ok');assert.equal(parameters.signal.aborted,false);prior.abort();assert.equal(parameters.signal.aborted,true);
});

test('reinstall updates the current context reader without nesting proxy option wrappers or inheriting the former signal',async()=>{
  const previous=new AbortController(),current=new AbortController();let parameters:any,factories=0;
  const client:any={getDispatcherOptions:()=>({clientFactory:()=>{factories++;return {connect(input:any){parameters=input;return Promise.resolve();}};}}),undiciModule:{Pool:class{}}};
  installProxyConnectCancellation(client,()=>({signal:previous.signal}));const wrapper=client.getDispatcherOptions;
  installProxyConnectCancellation(client,()=>({signal:current.signal}));assert.equal(client.getDispatcherOptions,wrapper);
  const pool=client.getDispatcherOptions(false).clientFactory('proxy',{});await pool.connect({});assert.equal(factories,1);
  previous.abort();assert.equal(parameters.signal.aborted,false);current.abort();assert.equal(parameters.signal.aborted,true);
});

function tlsConnectorFixture(t:test.TestContext,connector?:(parameters:any,callback:any)=>any){
  const key=Symbol('connect endpoint function'),storage=new AsyncLocalStorage<{signal?:AbortSignal}>(),socket=new TLSSocket(new net.Socket());
  socket.on('error',()=>{});t.after(()=>socket.destroy());let complete:any,destroys=0;
  const destroy=socket.destroy;socket.destroy=function(error?:Error){destroys++;return destroy.call(this,error);};
  class NativeProxyAgent {[key]=(parameters:any,callback:any)=>connector?connector(parameters,callback):(complete=callback,socket);}
  const dispatcher=new NativeProxyAgent(),client:any={getDispatcherOptions:()=>({}),getFetchProxyDispatcher:()=>dispatcher,undiciModule:{ProxyAgent:NativeProxyAgent,Pool:class{}}};
  installProxyConnectCancellation(client,()=>storage.getStore());assert.equal(client.getFetchProxyDispatcher('local-fixture'),dispatcher);
  return {client,dispatcher:dispatcher as any,socket,storage,key,destroys:()=>destroys,complete:(...args:any[])=>complete(...args),
    call:(signal:AbortSignal,callback:any,parameters:any={protocol:'https:',httpSocket:new net.Socket()})=>storage.run({signal},()=>dispatcher[key](parameters,callback))};
}

for(const failed of [false,true])test(`TLS connector ${failed?'failure':'successful handoff'} cleans its own cancellation before even repeated callbacks`,async t=>{
  const f=tlsConnectorFixture(t),controller=new AbortController(),values:any[]=[];
  assert.equal(f.call(controller.signal,(...args:any[])=>values.push(args)),f.socket);assert.equal(getEventListeners(controller.signal,'abort').length,1);
  const error=failed?new Error('controlled TLS failure'):null;f.complete(error,failed?undefined:f.socket);
  assert.equal(getEventListeners(controller.signal,'abort').length,0);controller.abort();assert.equal(f.destroys(),0);
  f.complete(error,failed?undefined:f.socket);assert.equal(values.length,2,'preserve the original callback contract without inventing another native callback');
});

test('TLS synchronous callback, synchronous throw and callback throw retain their native results without leaking abort listeners',async t=>{
  const successSocket=new TLSSocket(new net.Socket());successSocket.on('error',()=>{});t.after(()=>successSocket.destroy());
  const first=tlsConnectorFixture(t,(_parameters,callback)=>{callback(null,successSocket);return successSocket;}),controller=new AbortController();let successes=0;
  assert.equal(first.call(controller.signal,()=>successes++),successSocket);assert.equal(successes,1);assert.equal(getEventListeners(controller.signal,'abort').length,0);controller.abort();assert.equal(successSocket.destroyed,false);
  const failure=new Error('native synchronous connector failure'),second=tlsConnectorFixture(t,()=>{throw failure;}),signal=new AbortController();let callbacks=0;
  assert.throws(()=>second.call(signal.signal,()=>callbacks++),error=>error===failure);assert.equal(callbacks,0);assert.equal(getEventListeners(signal.signal,'abort').length,0);
  const third=tlsConnectorFixture(t),callerFailure=new Error('caller callback failure'),thirdSignal=new AbortController();third.call(thirdSignal.signal,()=>{throw callerFailure;});
  assert.throws(()=>third.complete(null,third.socket),error=>error===callerFailure);assert.equal(getEventListeners(thirdSignal.signal,'abort').length,0);thirdSignal.abort();assert.equal(third.destroys(),0);
});

test('an already aborted TLS owner destroys only the newly returned undelivered socket and cleans on native close',async t=>{
  const f=tlsConnectorFixture(t),controller=new AbortController();controller.abort(new Error('expired controlled read'));let callbacks=0;
  assert.equal(f.call(controller.signal,()=>callbacks++),f.socket);assert.equal(f.destroys(),1);assert.equal(callbacks,0);
  await delay(5);assert.equal(getEventListeners(controller.signal,'abort').length,0);
});

test('TLS wrapper conservatively preserves unverified native descriptor shapes and non-TLS returns',async t=>{
  const controller=new AbortController(),key=Symbol('connect endpoint function');let getterCalls=0,originalCalls=0;
  for(const kind of ['accessor','nonwritable','ambiguous','unrelated-class']){
    class NativeProxyAgent {}
    const dispatcher:any=kind==='unrelated-class'?{}:new NativeProxyAgent();const original=()=>{originalCalls++;return 'native-value';};
    if(kind==='accessor')Object.defineProperty(dispatcher,key,{get(){getterCalls++;return original;}});
    else Object.defineProperty(dispatcher,key,{value:original,writable:kind!=='nonwritable',configurable:true});
    if(kind==='ambiguous')dispatcher[Symbol('connect endpoint function')]=original;
    const before=Object.getOwnPropertyDescriptor(dispatcher,key),client:any={getDispatcherOptions:()=>({}),getFetchProxyDispatcher:()=>dispatcher,undiciModule:{ProxyAgent:NativeProxyAgent,Pool:class{}}};
    installProxyConnectCancellation(client,()=>({signal:controller.signal}));assert.equal(client.getFetchProxyDispatcher('fixture'),dispatcher);
    assert.deepEqual(Object.getOwnPropertyDescriptor(dispatcher,key),before);
  }
  assert.equal(getterCalls,0);assert.equal(originalCalls,0);
  const nonTls={destroy(){throw new Error('unverified object must never be destroyed');}},f=tlsConnectorFixture(t,()=>nonTls);
  assert.equal(f.call(controller.signal,()=>{}),nonTls);assert.equal(getEventListeners(controller.signal,'abort').length,0);controller.abort();
});

test('a cached TLS dispatcher reads the current reinstalled owner without nested wrapping or changing direct connector calls',async t=>{
  const f=tlsConnectorFixture(t),first=new AbortController(),second=new AbortController(),cached=f.dispatcher[f.key];
  installProxyConnectCancellation(f.client,()=>({signal:second.signal}));assert.equal(f.client.getFetchProxyDispatcher('cached'),f.dispatcher);assert.equal(f.dispatcher[f.key],cached);
  f.call(first.signal,()=>{});first.abort();assert.equal(f.destroys(),0);second.abort();assert.equal(f.destroys(),1);
  const direct=tlsConnectorFixture(t),controller=new AbortController();direct.call(controller.signal,()=>{},{protocol:'https:'});
  assert.equal(getEventListeners(controller.signal,'abort').length,0);controller.abort();assert.equal(direct.destroys(),0);
});

