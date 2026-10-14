import test from 'node:test';
import assert from 'node:assert/strict';
import ccxt from 'ccxt';
import {observeWsSendRejections} from '../src/adapters/ws-send-observation.js';

const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
const failure=()=>new Error('WebSocket is not open: readyState 3 (CLOSED)');
function deferred<T>() {
  let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;
  const promise=new Promise<T>((success,failed)=>{resolve=success;reject=failed;});
  return {promise,resolve,reject};
}

for(const method of ['watch','watchMultiple'] as const)test(`installed CCXT ${method} forwards a discarded throttled send rejection to its watched future`,async()=>{
  const exchange=new (ccxt as any).Exchange({enableRateLimit:true});
  const error=failure(),pending=new Map<string,ReturnType<typeof deferred<unknown>>>();
  let sends=0,onErrors=0,fallbacks=0;
  const native={subscriptions:{},connect:()=>Promise.resolve(),throttle:()=>Promise.resolve(),
    future:(hash:string)=>{let value=pending.get(hash);if(!value){value=deferred();pending.set(hash,value);}
      const result=value.promise as any;result.reject=value.reject;result.resolve=value.resolve;return result;},
    send:async()=>{sends++;throw error;},
    onError:(reason:unknown)=>{onErrors++;for(const value of pending.values())value.reject(reason);}};
  exchange.client=()=>native;
  observeWsSendRejections(exchange,{isCurrent:()=>true,onFailure:()=>{fallbacks++;}});
  const watched=method==='watch'?exchange.watch('wss://offline.invalid','book',{op:'subscribe'},'book'):
    exchange.watchMultiple('wss://offline.invalid',['book'],{op:'subscribe'},['book']);
  await assert.rejects(watched,(caught:unknown)=>caught===error);
  assert.equal(sends,1);assert.equal(onErrors,1);assert.equal(fallbacks,0);
});

test('guard returns the original send promise and rejection without replaying or changing arguments',async()=>{
  const pending=deferred<unknown>(),error=failure(),args:unknown[]=[];
  let onErrors=0,sends=0;
  const native={send:function(...values:unknown[]){assert.equal(this,native);sends++;args.push(...values);return pending.promise;},
    onError:(caught:unknown)=>{assert.equal(caught,error);onErrors++;}};
  const exchange={client:function(url:string){assert.equal(this,exchange);assert.equal(url,'offline');return native;}};
  observeWsSendRejections(exchange,{isCurrent:()=>true,onFailure:()=>assert.fail('native callback should handle failure')});
  const guarded=exchange.client('offline'),payload={channel:'public-book'};
  const result=guarded.send(payload);
  assert.equal(result,pending.promise);pending.reject(error);
  await assert.rejects(result,(caught:unknown)=>caught===error);
  assert.equal(sends,1);assert.deepEqual(args,[payload]);assert.equal(onErrors,1);
});

test('multiple closed-socket sends notify once and a throwing onError cannot create another rejection',async()=>{
  let onErrors=0,fallbacks=0;
  const native={send:async()=>{throw failure();},onError:()=>{onErrors++;throw new Error('callback failed');}};
  const exchange={client:()=>native};
  observeWsSendRejections(exchange,{isCurrent:()=>true,onFailure:()=>{fallbacks++;throw new Error('fallback failed');}});
  const client=exchange.client();
  // This models CCXT discarding send's return value after throttle resolution.
  void client.send();void client.send();void client.send();
  await tick();await tick();
  assert.equal(onErrors,1);assert.equal(fallbacks,1);
});

test('a late rejected send is handled without invalidating a closed or replacement owner',async()=>{
  const old=deferred<unknown>();let current=true,onErrors=0,fallbacks=0;
  const native={send:()=>old.promise,onError:()=>{onErrors++;}};
  const exchange={client:()=>native};
  observeWsSendRejections(exchange,{isCurrent:()=>current,onFailure:()=>{fallbacks++;}});
  void exchange.client().send();current=false;old.reject(failure());
  await tick();assert.equal(onErrors,0);assert.equal(fallbacks,0);
});

test('reinstalling for a new generation does not duplicate wrappers or forward pending old errors',async()=>{
  const old=deferred<unknown>();let result=old.promise,onErrors=0,sends=0;
  const native={send:()=>{sends++;return result;},onError:()=>{onErrors++;}};
  const exchange={client:()=>native};
  observeWsSendRejections(exchange,{isCurrent:()=>true,onFailure:()=>{}});
  void exchange.client().send();
  observeWsSendRejections(exchange,{isCurrent:()=>true,onFailure:()=>{}});
  old.reject(failure());await tick();assert.equal(onErrors,0);
  result=Promise.reject(failure());void exchange.client().send();await tick();
  assert.equal(sends,2);assert.equal(onErrors,1);
});

test('missing native onError invokes the existing owner invalidation once while preserving synchronous throws',()=>{
  const error=failure();let fallbacks=0;
  const native={send:()=>{throw error;}};
  const exchange={client:()=>native};
  observeWsSendRejections(exchange,{isCurrent:()=>true,onFailure:()=>{fallbacks++;}});
  assert.throws(()=>exchange.client().send(),caught=>caught===error);
  assert.equal(fallbacks,1);
});

test('injected watch fixtures without native client factories retain their original behavior',()=>{
  const exchange={watchOrderBook:()=>Promise.resolve('book')},before=Object.keys(exchange);
  observeWsSendRejections(exchange,{isCurrent:()=>true,onFailure:()=>assert.fail()});
  assert.deepEqual(Object.keys(exchange),before);
});
