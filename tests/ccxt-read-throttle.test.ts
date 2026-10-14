import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {setImmediate as immediate,setTimeout as delay} from 'node:timers/promises';
import ccxt from 'ccxt';
import {configureCcxtReadThrottle} from '../src/adapters/ccxt-read-throttle.js';
import {configureExchangeTransport,ExchangeNetworkError,withExchangeRequestContext} from '../src/adapters/network.js';

class ReadExpired extends Error {}
const failure=()=>new ReadExpired('offline queued GET expired');
async function flush(){for(let turn=0;turn<12;turn++)await immediate();}
function scope(){const context=new AsyncLocalStorage<{deadlineAt?:number;signal?:AbortSignal}>();
  return {context,options:{getContext:()=>context.getStore(),timeoutError:failure}};}
function observe<T>(promise:Promise<T>){let outcome:{state:'resolved';value:T}|{state:'rejected';error:unknown}|undefined;
  const settled=promise.then(value=>{outcome={state:'resolved',value};},error=>{outcome={state:'rejected',error};});
  return {settled,get:()=>outcome};}
function nativeFixture(){
  const s=scope(),client:any=new ccxt.bybit({apiKey:'OFFLINE-KEY',secret:'OFFLINE-SECRET',enableRateLimit:true,rateLimit:100,
    options:{adjustForTimeDifference:false}});let reads=0;
  client.fetchImplementation=async(urlText:string,params:any)=>{
    assert.equal(String(params.method).toUpperCase(),'GET','all real native HTTP in this file is offline GET only');
    assert.equal(new URL(urlText).pathname,'/v5/execution/list');reads++;
    return new Response(JSON.stringify({retCode:0,retMsg:'OK',result:{list:[],nextPageCursor:''},retExtInfo:{},time:Date.now()}),
      {headers:{'content-type':'application/json'}});
  };
  configureCcxtReadThrottle(client,s.options);
  return {...s,client,reads:()=>reads,read:(budget:{deadlineAt?:number;signal?:AbortSignal})=>s.context.run(budget,()=>
    client.privateGetV5ExecutionList({category:'linear',execType:'Funding',limit:100})),cleanup:()=>client.close()};
}
function controlledFixture(shape=true){
  const s=scope(),calls:string[]=[],permits:Array<{resolve:()=>void;reject:(error:unknown)=>void;entry:any}>=[],client:any={
    throttler:{queue:[] as any[],queueHead:0,tokens:-1,running:true},
    throttle(cost:number){let resolve!:()=>void,reject!:(error:unknown)=>void;const promise=new Promise<void>((done,failed)=>{resolve=done;reject=failed;});
      const entry=shape?{resolver:resolve,cost}:{cost};this.throttler.queue.push(entry);permits.push({resolve,reject,entry});return promise;},
    async fetch2(_path:string,_api:string,method='GET',params:{cost?:number}={}){await this.throttle(params.cost??5);calls.push(method);return method;},
  };
  configureCcxtReadThrottle(client,s.options);
  const read=(budget:{deadlineAt?:number;signal?:AbortSignal},method='GET',cost=5)=>s.context.run(budget,()=>client.fetch2('offline','private',method,{cost}));
  const admit=(index:number)=>{const permit=permits[index],queue=client.throttler.queue;
    const found=queue.indexOf(permit.entry);if(found>=0)queue[found]=undefined;client.throttler.queueHead=Math.max(client.throttler.queueHead,found+1);
    client.throttler.tokens-=permit.entry.cost;permit.resolve();};
  return {...s,client,calls,permits,read,admit};
}

test('a genuinely queued native funding GET settles at its inherited deadline without signing a late HTTP request',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1700000000000});const f=nativeFixture();
  try{await f.client.throttle(1);const owner=f.client.throttler,queue=owner.queue;
    const read=observe(f.read({deadlineAt:Date.now()+20}));await flush();const own=queue[owner.queueHead];assert.equal(own.cost,5);
    t.mock.timers.tick(20);await flush();assert.equal(read.get()?.state,'rejected');assert.ok((read.get() as any).error instanceof ReadExpired);
    assert.equal(own.cost,0);assert.equal(owner.queue,queue);assert.equal(f.reads(),0);
    // CCXT captures its clock and timer at module load; give its genuine limiter time
    // to drain instead of pretending test-runner timer ticks advanced native CCXT.
    await delay(150);await read.settled;assert.equal(f.reads(),0);assert.equal(owner.queue.length,0);
  }finally{await f.cleanup();}
});
test('a queued native GET reacts to the original abort signal and never reaches HTTP after its permit later drains',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1700000000000});const f=nativeFixture(),controller=new AbortController();
  try{await f.client.throttle(1);const read=observe(f.read({signal:controller.signal}));await flush();
    const own=f.client.throttler.queue[f.client.throttler.queueHead];controller.abort();await flush();
    assert.equal(read.get()?.state,'rejected');assert.equal(own.cost,0);await delay(150);await flush();assert.equal(f.reads(),0);assert.equal(f.client.throttler.queue.length,0);
  }finally{await f.cleanup();}
});
for(const kind of ['expired','aborted'] as const)test(`${kind} inherited budget rejects before acquiring or enqueueing any native permit`,async()=>{
  const f=controlledFixture(),controller=new AbortController();controller.abort();
  await assert.rejects(f.read(kind==='expired'?{deadlineAt:Date.now()-1}:{signal:controller.signal}),ReadExpired);
  assert.equal(f.permits.length,0);assert.equal(f.calls.length,0);
});
test('cancelling one queued GET changes only its exact unadmitted cost and preserves FIFO, head, tokens and running',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1700000000000});const f=controlledFixture();
  const early=observe(f.read({deadlineAt:Date.now()+20})),other=observe(f.read({deadlineAt:Date.now()+200},'GET',3)),
    post=observe(f.read({deadlineAt:Date.now()+20},'POST',7)),del=observe(f.read({deadlineAt:Date.now()+20},'DELETE',9));
  const q=f.client.throttler.queue,before=q.slice(),tokens=f.client.throttler.tokens;
  t.mock.timers.tick(20);await flush();assert.equal(early.get()?.state,'rejected');assert.equal(other.get(),undefined);
  assert.deepEqual(q,before);assert.deepEqual(q.map((entry:any)=>entry.cost),[0,3,7,9]);
  assert.equal(f.client.throttler.queueHead,0);assert.equal(f.client.throttler.running,true);assert.equal(f.client.throttler.tokens,tokens);
  f.admit(0);await flush();f.admit(1);await flush();f.admit(2);await flush();f.admit(3);await flush();assert.deepEqual(f.calls,['GET','POST','DELETE']);
  assert.equal(f.client.throttler.tokens,tokens-3-7-9);await Promise.all([early.settled,other.settled,post.settled,del.settled]);
});
test('an admitted native GET preserves its real permit cost and a later abort cannot roll it back',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1700000000000});const f=controlledFixture(),controller=new AbortController();
  const read=observe(f.read({deadlineAt:Date.now()+20,signal:controller.signal}));const own=f.permits[0].entry;
  f.admit(0);controller.abort();await flush();assert.equal(own.cost,5);assert.equal(f.client.throttler.tokens,-6);
  assert.equal(f.calls.length,0,'expired after admission still cannot continue the GET');assert.equal(read.get()?.state,'rejected');
});
test('a normal native funding GET completes once before deadline with the native endpoint cost intact',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1700000000000});const f=nativeFixture();
  try{const read=observe(f.read({deadlineAt:Date.now()+1000}));await flush();assert.equal(read.get()?.state,'resolved');assert.equal(f.reads(),1);
    assert.equal(f.client.throttler.config.tokens,-5);t.mock.timers.tick(1001);await flush();assert.equal(f.reads(),1);
  }finally{await f.cleanup();}
});
test('no-budget native GET and standalone websocket-style throttle retain their ordinary native waits',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1700000000000});const f=controlledFixture();
  const unbounded=observe(f.read({})),standalone=observe(f.context.run({deadlineAt:Date.now()+20},()=>f.client.throttle(4)));
  t.mock.timers.tick(100);await flush();assert.equal(unbounded.get(),undefined);assert.equal(standalone.get(),undefined);
  assert.deepEqual(f.permits.map(p=>p.entry.cost),[5,4]);f.admit(0);f.admit(1);await flush();
  assert.equal(unbounded.get()?.state,'resolved');assert.equal(standalone.get()?.state,'resolved');assert.deepEqual(f.calls,['GET']);
});
test('POST and DELETE are untouched even with expired or aborted inherited contexts',async()=>{
  const f=controlledFixture(),controller=new AbortController();controller.abort();
  const post=observe(f.read({deadlineAt:Date.now()-1,signal:controller.signal},'POST',7)),
    del=observe(f.read({deadlineAt:Date.now()-1,signal:controller.signal},'DELETE',9));
  assert.deepEqual(f.permits.map(p=>p.entry.cost),[7,9]);f.admit(0);f.admit(1);await flush();
  assert.deepEqual(f.calls,['POST','DELETE']);assert.equal(post.get()?.state,'resolved');assert.equal(del.get()?.state,'resolved');
});
test('an unknown native queue shape retains actual permit ownership but rejects an expired GET after it drains',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1700000000000});const f=controlledFixture(false),read=observe(f.read({deadlineAt:Date.now()+20}));
  t.mock.timers.tick(20);await flush();assert.equal(read.get(),undefined);assert.equal(f.permits[0].entry.cost,5);
  f.admit(0);await flush();assert.equal(read.get()?.state,'rejected');assert.equal(f.calls.length,0);
});
test('a replaced native throttler cannot donate a foreign queue entry to the cancellation proof',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1700000000000});const f=controlledFixture(),read=observe(f.read({deadlineAt:Date.now()+20}));
  const original=f.client.throttler,own=f.permits[0].entry,foreign={resolver:()=>{},cost:9};
  f.client.throttler={queue:[foreign],queueHead:0,tokens:-1,running:true};t.mock.timers.tick(20);await flush();
  assert.equal(read.get(),undefined);assert.equal(own.cost,5);assert.equal(foreign.cost,9);
  original.queue[0]=undefined;original.queueHead=1;f.permits[0].resolve();await flush();assert.equal(read.get()?.state,'rejected');assert.equal(f.calls.length,0);
});
test('a native queue entry whose cost or resolver changed cannot be mistaken for the frozen queued GET',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1700000000000});const f=controlledFixture(),read=observe(f.read({deadlineAt:Date.now()+20}));
  f.permits[0].entry.cost=9;t.mock.timers.tick(20);await flush();assert.equal(read.get(),undefined);assert.equal(f.permits[0].entry.cost,9);
  f.admit(0);await flush();assert.equal(read.get()?.state,'rejected');assert.equal(f.calls.length,0);
});
test('queued cancellation freezes its original deadline rather than borrowing an extended context object',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1700000000000});const f=controlledFixture(),budget={deadlineAt:Date.now()+20};
  const read=observe(f.read(budget));budget.deadlineAt+=10000;t.mock.timers.tick(20);await flush();
  assert.equal(read.get()?.state,'rejected');assert.equal(f.permits[0].entry.cost,0);f.admit(0);await flush();assert.equal(f.calls.length,0);
});
test('installing the helper twice is idempotent and never adds another native permit or wrapper layer',()=>{
  const f=controlledFixture(),fetch2=f.client.fetch2,throttle=f.client.throttle;
  configureCcxtReadThrottle(f.client,f.options);assert.equal(f.client.fetch2,fetch2);assert.equal(f.client.throttle,throttle);
});
test('a native throttle rejection retains its original error and is never retried',async()=>{
  const s=scope(),original=new Error('offline native limiter rejected'),client:any={
    throttle:()=>Promise.reject(original),async fetch2(){await this.throttle(5);throw new Error('must not continue');}};
  configureCcxtReadThrottle(client,s.options);await assert.rejects(s.context.run({deadlineAt:Date.now()+1000},()=>client.fetch2('offline','private','GET')),error=>error===original);
});
test('reconfiguration updates future request readers without changing a queued request budget or adding wrappers',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1700000000000});const f=controlledFixture(),next=scope(),futureError=new Error('new request expired');
  const old=observe(f.read({deadlineAt:Date.now()+20})),fetch2=f.client.fetch2,throttle=f.client.throttle;
  configureCcxtReadThrottle(f.client,{getContext:next.options.getContext,timeoutError:()=>futureError});
  const future=observe(next.context.run({deadlineAt:Date.now()+40},()=>f.client.fetch2('offline','private','GET')));
  assert.equal(f.client.fetch2,fetch2);assert.equal(f.client.throttle,throttle);assert.equal(f.permits.length,2);
  t.mock.timers.tick(20);await flush();assert.ok((old.get() as any).error instanceof ReadExpired);assert.equal(future.get(),undefined);
  t.mock.timers.tick(20);await flush();assert.equal((future.get() as any).error,futureError);assert.deepEqual(f.permits.map(p=>p.entry.cost),[0,0]);
  f.admit(0);f.admit(1);await flush();assert.equal(f.calls.length,0);
});
test('a mutated native resolver retains the original permit and cost until the actual native promise settles',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1700000000000});const f=controlledFixture(),read=observe(f.read({deadlineAt:Date.now()+20}));
  f.permits[0].entry.resolver=()=>{};t.mock.timers.tick(20);await flush();assert.equal(read.get(),undefined);assert.equal(f.permits[0].entry.cost,5);
  f.admit(0);await flush();assert.equal(read.get()?.state,'rejected');assert.equal(f.calls.length,0);
});
test('a duplicated queue identity is not sufficient ownership to erase either native permit cost',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1700000000000});const f=controlledFixture(),read=observe(f.read({deadlineAt:Date.now()+20}));
  f.client.throttler.queue.push(f.permits[0].entry);t.mock.timers.tick(20);await flush();assert.equal(read.get(),undefined);assert.equal(f.permits[0].entry.cost,5);
  f.admit(0);await flush();assert.equal(read.get()?.state,'rejected');assert.equal(f.calls.length,0);
});
test('a late native limiter rejection is observed after exact queued cancellation and cannot restart the GET',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1700000000000});const f=controlledFixture(),read=observe(f.read({deadlineAt:Date.now()+20}));
  t.mock.timers.tick(20);await flush();const initial=read.get();assert.equal(initial?.state,'rejected');assert.equal(f.permits[0].entry.cost,0);
  f.permits[0].reject(new Error('native late rejection'));await flush();assert.equal(read.get(),initial);assert.equal(f.calls.length,0);
});
test('a native limiter rejection with an undefined value remains a rejection',async()=>{
  const s=scope(),client:any={throttle:()=>Promise.reject(undefined),async fetch2(){await this.throttle(5);return 'must not continue';}};
  configureCcxtReadThrottle(client,s.options);const read=observe(s.context.run({deadlineAt:Date.now()+1000},()=>client.fetch2('offline','private','GET')));
  await read.settled;assert.equal(read.get()?.state,'rejected');assert.equal((read.get() as any).error,undefined);
});
test('transport-installed helper uses the actual inherited exchange context and refuses all late native funding HTTP',async()=>{
  const client:any=new ccxt.bybit({apiKey:'OFFLINE-KEY',secret:'OFFLINE-SECRET',enableRateLimit:true,rateLimit:100,options:{adjustForTimeDifference:false}});
  let http=0;client.fetchImplementation=async(_url:string,params:any)=>{assert.equal(params.method,'GET');http++;
    return new Response(JSON.stringify({retCode:0,retMsg:'OK',result:{list:[],nextPageCursor:''}}),{headers:{'content-type':'application/json'}});};
  configureExchangeTransport(client,'bybit',{proxyUrl:''});
  try{await client.throttle(1);const owner=client.throttler;
    const read=observe(withExchangeRequestContext(client,{deadlineAt:Date.now()+20},()=>client.privateGetV5ExecutionList({category:'linear',execType:'Funding',limit:100})));
    await delay(40);assert.equal(read.get()?.state,'rejected');assert.ok((read.get() as any).error instanceof ExchangeNetworkError);
    assert.equal((read.get() as any).error.code,'TIMEOUT');assert.equal(owner.queue[owner.queueHead].cost,0);assert.equal(http,0);
    await delay(110);assert.equal(owner.queue.length,0);assert.equal(http,0);
    const fresh=await withExchangeRequestContext<any>(client,{deadlineAt:Date.now()+500},()=>client.privateGetV5ExecutionList({category:'linear',execType:'Funding',limit:100}));
    assert.equal(fresh.retCode,0);assert.equal(http,1);assert.ok(owner.config.tokens<0,'only the new actual GET consumes its endpoint cost');
  }finally{await client.close();}
});
test('the genuine native limiter keeps FIFO and rate costs for other reads, POST and DELETE after a cancelled GET',async()=>{
  const s=scope(),client:any=new ccxt.bybit({enableRateLimit:true,rateLimit:20}),calls:string[]=[];
  // These are in-memory method labels around the real native limiter; no sign, fetch,
  // native private API or financial request is invoked for POST/DELETE.
  client.fetch2=async function(_path:string,_api:string,method='GET',params:{cost:number}){await this.throttle(params.cost);calls.push(method);return method;};
  configureCcxtReadThrottle(client,s.options);
  try{await client.throttle(1);const owner=client.throttler;
    const call=(method:string,cost:number,deadlineAt:number)=>observe(s.context.run({deadlineAt},()=>client.fetch2('in-memory','offline',method,{cost})));
    const cancelled=call('GET',5,Date.now()+5),get=call('GET',3,Date.now()+1000),post=call('POST',7,Date.now()-1),del=call('DELETE',9,Date.now()-1);
    const entries=owner.queue.slice(owner.queueHead);assert.deepEqual(entries.map((entry:any)=>entry.cost),[5,3,7,9]);
    await delay(10);assert.equal(cancelled.get()?.state,'rejected');assert.equal(entries[0].cost,0);assert.deepEqual(entries.slice(1).map((entry:any)=>entry.cost),[3,7,9]);
    await Promise.all([cancelled.settled,get.settled,post.settled,del.settled]);assert.deepEqual(calls,['GET','POST','DELETE']);
    assert.equal(owner.queue.length,0);assert.ok(owner.config.tokens<0);assert.equal(get.get()?.state,'resolved');assert.equal(post.get()?.state,'resolved');assert.equal(del.get()?.state,'resolved');
  }finally{await client.close();}
});
