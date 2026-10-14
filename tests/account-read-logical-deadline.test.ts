import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as immediate} from 'node:timers/promises';
import {CcxtAdapter} from '../src/adapters/ccxt.js';
import {GatePrivate} from '../src/adapters/gate-private.js';
import {BybitPrivate} from '../src/adapters/bybit-private.js';
import {BitgetClassic} from '../src/adapters/bitget-classic.js';
import {BitgetUta} from '../src/adapters/bitget-uta.js';
import {Engine} from '../src/core/engine.js';
import {assertExchangeRequestActive,ExchangeNetworkError,withExchangeRequestContext} from '../src/adapters/network.js';
import {defaultConfig} from '../src/shared/config.js';
import type {PrivateReadContext} from '../src/shared/types.js';

function deferred<T=void>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
const account={currency:'USDT',available:'100',total:'100',unrealised_pnl:'0',position_mode:'single',margin_mode_name:'single_currency'};
function fixture(){
  const calls:string[]=[],pending:ReturnType<typeof deferred<any>>[]=[];
  let metadata:Promise<unknown>|undefined,held=false,privateFeeCalls=0;
  const config={...defaultConfig,mode:'live' as const,dataSource:'public' as const,feeOnly:true};
  const client:any={apiKey:'OFFLINE-ACCOUNT',secret:'OFFLINE-SECRET',options:{},markets:{},
    loadMarkets:async()=>{calls.push('metadata');await metadata;return {};},
    privateFuturesGetSettleAccounts:async()=>{assertExchangeRequestActive(client,'gate');calls.push('account');
      if(!held)return {...account};const read=deferred<any>();pending.push(read);return read.promise;},
    privateFuturesGetSettlePositions:async()=>{assertExchangeRequestActive(client,'gate');calls.push('positions');
      if(!held)return [];const read=deferred<any>();pending.push(read);return read.promise;},
    privateUnifiedGetAccounts:async()=>{assertExchangeRequestActive(client,'gate');calls.push('unified');return {unified_account_total_equity:'100'};},
    privateFuturesGetSettleFee:async()=>{privateFeeCalls++;throw new Error('Unexpected private fee query during account observation');},
  };
  const adapter=new CcxtAdapter('gate',config,client);
  const read=(context?:PrivateReadContext)=>adapter.fetchAccount(context);
  const release=()=>{for(const [index,read] of pending.splice(0).entries())read.resolve(index%2===0?{...account}:[]);};
  return {adapter,client,calls,read,release,pending,hold:()=>{held=true;},holdMetadata:(promise:Promise<unknown>)=>{metadata=promise;},
    privateFeeCalls:()=>privateFeeCalls};
}
const timeout=(error:unknown)=>error instanceof ExchangeNetworkError&&error.code==='TIMEOUT';

test('an expired account context rejects before metadata or private reads',async()=>{
  const f=fixture();try{
    await assert.rejects(f.read({deadlineAt:Date.now()-1}),timeout);
    assert.deepEqual(f.calls,[]);assert.equal(f.privateFeeCalls(),0);
  }finally{await f.adapter.close();}
});

test('cancelled metadata loading cannot start private account reads',async()=>{
  const f=fixture(),metadata=deferred(),controller=new AbortController();f.holdMetadata(metadata.promise);
  const task=f.read({signal:controller.signal});const outcome=task.then(value=>({value}),error=>({error}));
  try{
    await immediate();assert.deepEqual(f.calls,['metadata']);controller.abort();metadata.resolve();
    const result=await outcome;assert.ok('error' in result&&timeout(result.error));
    assert.deepEqual(f.calls,['metadata']);assert.equal(f.privateFeeCalls(),0);
  }finally{metadata.resolve();await outcome;await f.adapter.close();}
});

test('a cancelled account read drains native work and does not start the next balance request',async()=>{
  const f=fixture(),controller=new AbortController();f.hold();let finished=false;
  const task=f.read({signal:controller.signal}).then(value=>{finished=true;return {value};},error=>{finished=true;return {error};});
  try{
    await immediate();assert.deepEqual(f.calls,['metadata','account','positions']);controller.abort();await immediate();
    assert.equal(finished,false,'ignored cancellation must retain the actual native read lifetime');
    f.release();const result=await task;assert.ok('error' in result&&timeout(result.error));
    assert.deepEqual(f.calls,['metadata','account','positions']);assert.equal(f.privateFeeCalls(),0);
  }finally{f.release();await task;await f.adapter.close();}
});

test('independent account reads on one client do not inherit another read cancellation',async()=>{
  const f=fixture(),controller=new AbortController();f.hold();
  const first=f.read({signal:controller.signal}).then(value=>({value}),error=>({error}));
  try{
    await immediate();const second=f.read();controller.abort();await immediate();f.release();
    const [old,fresh]=await Promise.all([first,second]);assert.ok('error' in old&&timeout(old.error));
    assert.equal(fresh.freeUsd,100);assert.equal(fresh.equityUsd,100);
    assert.equal(f.calls.filter(call=>call==='unified').length,1);assert.equal(f.privateFeeCalls(),0);
  }finally{f.release();await first;await f.adapter.close();}
});

test('an empty nested account context preserves its caller deadline',async()=>{
  const f=fixture();try{
    await assert.rejects(withExchangeRequestContext(f.client,{deadlineAt:Date.now()-1},()=>f.read({})),timeout);
    assert.deepEqual(f.calls,[]);assert.equal(f.privateFeeCalls(),0);
  }finally{await f.adapter.close();}
});

test('the unscoped account API keeps its existing cash and does not query private fees',async()=>{
  const f=fixture();try{
    assert.deepEqual(await f.read(),{freeUsd:100,equityUsd:100,positions:[],positionMode:'single'});
    assert.deepEqual(f.calls,['metadata','account','positions','unified']);assert.equal(f.privateFeeCalls(),0);
  }finally{await f.adapter.close();}
});

test('Engine account polling forwards its original logical deadline before late metadata can start private reads',async()=>{
  const f=fixture(),metadata=deferred();f.holdMetadata(metadata.promise);
  const shell:any={privateReadRequests:new Map(),accountReadAt:new WeakMap(),options:{privateReadDeadlineMs:20},config:{maxSnapshotAgeMs:30000}};
  shell.boundedPrivateRead=(Engine.prototype as any).boundedPrivateRead.bind(shell);
  const task=(Engine.prototype as any).readTradingAccount.call(shell,f.adapter).then(()=>undefined,(error:unknown)=>error);
  try{
    const error=await task;assert.ok(error instanceof Error&&/只读请求超时/.test(error.message));
    const raw:Promise<unknown>|undefined=shell.privateReadRequests.get(f.adapter)?.get('account');assert.ok(raw);
    const late=raw.then(()=>undefined,reason=>reason);metadata.resolve();assert.ok(timeout(await late));
    assert.deepEqual(f.calls,['metadata']);assert.equal(f.privateFeeCalls(),0);
  }finally{metadata.resolve();await task;await f.adapter.close();}
});

function parallelFixture(venue:'gate'|'bybit'|'bitget-classic'|'bitget-uta',failedIndex:number){
  const width=venue==='gate'||venue==='bitget-classic'?2:3,calls:number[]=[],pending=Array.from({length:width},()=>deferred<any>());
  const client:any={},failure=new Error(`OFFLINE ${venue} initial read ${failedIndex} failed`);
  const read=(index:number)=>()=>{calls.push(index);return pending[index].promise;};
  let helper:any;
  if(venue==='gate'){
    helper=new GatePrivate(client,.0005);helper.account=read(0);helper.positions=read(1);
  }else if(venue==='bybit'){
    helper=new BybitPrivate(client);helper.info=read(0);helper.wallet=read(1);helper.positions=read(2);
  }else if(venue==='bitget-classic'){
    client.privateMixGetV2MixAccountAccounts=read(0);client.privateMixGetV2MixPositionAllPosition=read(1);helper=new BitgetClassic(client);
  }else{
    helper=new BitgetUta(client);helper.settings=read(0);helper.assets=read(1);helper.positions=read(2);
  }
  const release=()=>{for(const [index,request] of pending.entries())if(index!==failedIndex)request.resolve(
    venue==='bitget-classic'?{code:'00000',data:[]}:[]);};
  return {helper,calls,pending,failure,release,width};
}

for(const venue of ['gate','bybit','bitget-classic','bitget-uta'] as const)for(const failedIndex of [0,1])
  test(`${venue} account read retains all native siblings after initial read ${failedIndex} fails`,async()=>{
    const f=parallelFixture(venue,failedIndex),shell:any={privateReadRequests:new Map(),accountReadAt:new WeakMap(),options:{privateReadDeadlineMs:20}};
    const adapter:any={fetchAccount:()=>f.helper.fetchAccount()},bounded=(Engine.prototype as any).boundedPrivateRead.bind(shell);
    const first=bounded(adapter,'account',()=>adapter.fetchAccount()).then(()=>undefined,(error:unknown)=>error);
    try{
      await immediate();assert.equal(f.calls.length,f.width);f.pending[failedIndex].resolve(Promise.reject(f.failure));
      const result=await first;assert.ok(result instanceof Error&&/只读请求超时/.test(result.message));
      const raw:Promise<unknown>|undefined=shell.privateReadRequests.get(adapter)?.get('account');assert.ok(raw);
      const original=raw.then(()=>undefined,error=>error);
      await assert.rejects(bounded(adapter,'account',()=>adapter.fetchAccount()),/尚未结束/);
      assert.equal(f.calls.length,f.width,'the failed batch cannot start a second account request while siblings are held');
      f.release();assert.equal(await original,f.failure,'the first real refusal is preserved after every sibling settles');await immediate();
      assert.equal(shell.privateReadRequests.get(adapter)?.has('account'),false);
    }finally{f.release();await first;}
  });
