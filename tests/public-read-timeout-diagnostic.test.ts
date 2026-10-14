import assert from 'node:assert/strict';
import test from 'node:test';
import {setImmediate as immediate} from 'node:timers/promises';
import {Engine} from '../src/core/engine.js';
import {ExchangeNetworkError} from '../src/adapters/network.js';
import {defaultConfig} from '../src/shared/config.js';
import type {ExchangeAdapter,ExchangeHealth,ExchangeReadContext,MarketSnapshot} from '../src/shared/types.js';

const BUDGET_MESSAGE='本轮公共行情读取预算已用完，等待原请求结束后自动重试';
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return {promise,resolve};}
async function flush(){for(let turn=0;turn<8;turn++)await immediate();}
function fixture(fetchSnapshots:ExchangeAdapter['fetchSnapshots']){
  const logs:Array<{level:string;message:string}>=[],adapter={id:'gate',fetchSnapshots} as ExchangeAdapter,
    health:ExchangeHealth={exchange:'gate',status:'online',lastSuccess:Date.now(),latencyMs:0};
  const owner:any={config:{...structuredClone(defaultConfig),dataSource:'public'},startGeneration:1,stopping:false,
    options:{publicSnapshotDeadlineMs:20},publicSnapshotRequests:new Map(),adapters:[adapter],health:[health],snapshots:[],
    unavailableSnapshots:new Set(),errors:new Map(),activePositions:()=>[],paperBalance:()=>0,
    persistObservation:(write:()=>unknown)=>write(),store:{log:(level:string,message:string)=>logs.push({level,message})}};
  owner.snapshotKey=(exchange:string,base:string)=>`${exchange}:${base}`;
  owner.acquireSnapshots=(Engine.prototype as any).acquireSnapshots.bind(owner);
  const refresh=()=>(Engine.prototype as any).refreshAdapter.call(owner,adapter,['DOS'],false) as Promise<boolean>;
  return {owner,adapter,health,logs,refresh};
}

test('an actual Engine public batch deadline has a fixed budget diagnostic and retains the original request owner',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1700000000000});const held=deferred<MarketSnapshot[]>();
  let reads=0,context:ExchangeReadContext|undefined;
  const f=fixture(async(_bases,received)=>{reads++;context=received;return held.promise;});
  try{const pending=f.refresh();await flush();assert.equal(reads,1);assert.equal(context?.deadlineAt,Date.now()+20);
    t.mock.timers.tick(20);assert.equal(await pending,false);
    assert.equal(f.health.errorCode,'TIMEOUT');assert.equal(f.health.error,BUDGET_MESSAGE);assert.equal(context?.signal?.aborted,true);
    assert.equal(f.owner.publicSnapshotRequests.size,1);assert.equal(f.logs.length,1);assert.match(f.logs[0].message,/本次请求的币种暂停新开仓/);
    assert(!f.logs[0].message.includes('自动重连'));assert(!f.logs[0].message.includes('SECRET'));
    await f.refresh();assert.equal(reads,1);assert.equal(f.health.errorCode,'READ_IN_PROGRESS');assert.equal(f.logs.length,1);
    held.resolve([]);await flush();assert.equal(f.owner.publicSnapshotRequests.size,0);assert.deepEqual(f.owner.snapshots,[]);
  }finally{held.resolve([]);await flush();}
});

for(const [code,expected] of [
  ['TIMEOUT','网络请求超时，正在自动重试；过期数据不会用于开仓'],
  ['NETWORK_ERROR','网络连接中断，正在自动重试'],
  ['ACCESS_DENIED','交易所拒绝访问，请检查网络出口或接口权限'],
  ['API_ERROR','交易所接口响应异常'],
] as const)test(`native ${code} retains its classification without claiming a local batch budget or socket reconnect`,async()=>{
  const error=new ExchangeNetworkError(code,0,undefined,'gate');Object.defineProperty(error,'message',{value:'SECRET_NATIVE_RESPONSE_TOKEN'});
  const f=fixture(async()=>{throw error;});assert.equal(await f.refresh(),false);
  assert.equal(f.health.errorCode,code);assert.equal(f.health.error,expected);assert.equal(f.owner.publicSnapshotRequests.size,0);
  assert.equal(f.logs.length,1);assert(!f.logs[0].message.includes('SECRET'));assert(!f.logs[0].message.includes('自动重连'));
  assert(!f.health.error?.includes('公共行情读取预算'));
});

test('matching text cannot impersonate the internal public batch timeout type or expose raw diagnostic values',async()=>{
  const f=fixture(async()=>{throw new Error(`${BUDGET_MESSAGE} SECRET_FAKE_BUDGET_TOKEN`);});
  assert.equal(await f.refresh(),false);assert.equal(f.health.errorCode,'API_ERROR');assert.equal(f.health.error,'交易所接口响应异常');
  assert(!f.logs[0].message.includes('SECRET'));assert(!f.logs[0].message.includes('公共行情读取预算'));
});

test('an actual request succeeding before the same deadline keeps its original quote timestamp and records no timeout',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1700000000000});const held=deferred<MarketSnapshot[]>();
  const f=fixture(async()=>held.promise),timestamp=Date.now();
  const quote={exchange:'gate',base:'DOS',symbol:'DOS/USDT:USDT',timestamp,bids:[{price:1,quantity:10}],asks:[{price:1.01,quantity:10}]} as MarketSnapshot;
  const pending=f.refresh();await flush();t.mock.timers.tick(19);held.resolve([quote]);
  assert.equal(await pending,true);assert.equal(f.owner.snapshots[0].timestamp,timestamp);assert.equal(f.health.errorCode,undefined);assert.equal(f.logs.length,0);
  t.mock.timers.tick(1);await flush();assert.equal(f.logs.length,0);assert.equal(f.owner.publicSnapshotRequests.size,0);
});
