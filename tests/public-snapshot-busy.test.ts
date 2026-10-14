import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../src/core/engine.js';
import {defaultConfig} from '../src/shared/config.js';
import type {ExchangeAdapter,MarketSnapshot} from '../src/shared/types.js';

test('an existing public read is reported as waiting and never as another connection failure',async()=>{
  let reads=0,logs=0;
  const pending=new Promise<MarketSnapshot[]>(()=>{});
  const adapter={id:'gate',fetchSnapshots:async()=>{reads++;return [];}} as unknown as ExchangeAdapter;
  const health={exchange:'gate',status:'online',lastSuccess:Date.now(),errorCode:undefined as string|undefined,error:undefined as string|undefined};
  const engine={config:{...defaultConfig,mode:'paper',dataSource:'public'},stopping:false,adapters:[adapter],health:[health],
    publicSnapshotRequests:new Map([['gate',pending]]),unavailableSnapshots:new Set<string>(),errors:new Map<string,number>(),
    snapshots:[] as MarketSnapshot[],store:{data:{positions:[]},log(){logs++;}}};
  Object.setPrototypeOf(engine,Engine.prototype);
  const refresh=Engine.prototype as unknown as {refreshAdapter(adapter:ExchangeAdapter,bases:string[],includeAccount:boolean):Promise<boolean>};
  assert.equal(await refresh.refreshAdapter.call(engine,adapter,['NKE'],false),false);
  assert.equal(await refresh.refreshAdapter.call(engine,adapter,['NKE'],false),false);
  assert.equal(reads,0);assert.equal(logs,0);assert.equal(engine.errors.size,0);
  assert.equal(engine.publicSnapshotRequests.get('gate'),pending);
  assert.equal(health.status,'online');assert.equal(health.errorCode,'READ_IN_PROGRESS');
  assert.match(health.error!,/上一批公共盘口读取尚未完成/);
});
