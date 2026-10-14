import test from 'node:test';
import assert from 'node:assert/strict';
import {LivePortfolioMonitor} from '../src/core/live-portfolio.js';
import {positionMetrics} from '../src/adapters/position-metrics.js';
import {defaultConfig} from '../src/shared/config.js';
import type {AccountState,ExchangeId} from '../src/shared/types.js';
const env={GATE_API_KEY:'fixture',GATE_API_SECRET:'fixture',BYBIT_API_KEY:'fixture',BYBIT_API_SECRET:'fixture',ALLOW_LIVE_TRADING:'false'};
const config={...defaultConfig,mode:'live' as const,dataSource:'public' as const,exchanges:['gate','bybit'] as ExchangeId[],autoEnabled:false};
const account=(quantity=1,pnl=-1):AccountState=>({freeUsd:500,equityUsd:600,positions:quantity?[{base:'BTC',symbol:'BTC/USDT:USDT',side:'long',quantity,markPrice:100,entryPrice:101,unrealizedPnlUsd:pnl,liquidationPrice:50,leverage:2}]:[]});
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};};

test('configured accounts refresh while execution is locked, without altering local records or exposing writes',async()=>{
  let calls=0;const monitor=new LivePortfolioMonitor(()=>config,{env,createClient:()=>({fetchAccount:async()=>{calls++;return account();},close:async()=>{}})});
  try{const state=await monitor.refresh();assert.equal(calls,2);assert.equal(state.exchanges.every(e=>e.status==='ready'),true);
    assert.equal(state.exchanges[0].positions[0].quantity,1);assert.equal(state.exchanges[0].positions[0].unrealizedPnlUsd,-1);assert.equal(env.ALLOW_LIVE_TRADING,'false');}
  finally{await monitor.stop();}
});
test('confirmed account changes and externally closed positions replace observations, not stale quantities',async()=>{
  let current=account(3,-4);const monitor=new LivePortfolioMonitor(()=>config,{env,createClient:()=>({fetchAccount:async()=>current,close:async()=>{}})});
  try{await monitor.refresh();current=account(2,-5);assert.equal((await monitor.refresh()).exchanges[0].positions[0].quantity,2);
    current=account(0);const result=await monitor.refresh();assert.equal(result.exchanges[0].status,'ready');assert.deepEqual(result.exchanges[0].positions,[]);}
  finally{await monitor.stop();}
});
test('failed reads hide old quantities, balances and PnL; private errors are sanitized',async()=>{
  let fail=false;const monitor=new LivePortfolioMonitor(()=>config,{env,createClient:()=>({fetchAccount:async()=>{if(fail)throw new Error('SECRET_FIXTURE=must-never-appear');return account();},close:async()=>{}})});
  try{await monitor.refresh();fail=true;const result=await monitor.refresh();for(const e of result.exchanges){assert.equal(e.status,'error');assert.deepEqual(e.positions,[]);assert.equal(e.freeUsd,undefined);}
    assert.ok(!JSON.stringify(result).includes('SECRET_FIXTURE'));}
  finally{await monitor.stop();}
});
test('snapshot age starts at request start and expires even with no subsequent request',async()=>{
  let now=100000;const monitor=new LivePortfolioMonitor(()=>config,{env,maxAgeMs:1000,now:()=>now,createClient:()=>({fetchAccount:async()=>{now+=100;return account();},close:async()=>{}})});
  try{await monitor.refresh();now=102000;const result=monitor.state();for(const e of result.exchanges){assert.equal(e.status,'stale');assert.deepEqual(e.positions,[]);assert.equal(e.freeUsd,undefined);}}
  finally{await monitor.stop();}
});
test('a failed Gate read stays visible during a retry and reuses the initialized client',async()=>{
  const held=deferred<AccountState>();let created=0,calls=0,closed=0;
  const monitor=new LivePortfolioMonitor(()=>({...config,exchanges:['gate']}),{env,createClient:()=>{
    created++;return {fetchAccount:()=>{calls++;if(calls===1)throw new Error('gate: multiple positions for the same contract side require manual reconciliation');return held.promise;},close:async()=>{closed++;}};
  }});
  try{
    const first=await monitor.refresh();assert.equal(first.exchanges[0].status,'error');
    assert.match(first.exchanges[0].message!,/同一币种方向存在多个仓位/);
    const retry=monitor.refresh();await new Promise(r=>setImmediate(r));
    assert.equal(monitor.state().exchanges[0].status,'error');
    assert.equal(monitor.state().exchanges[0].message,first.exchanges[0].message);
    assert.equal(created,1);assert.equal(closed,0);
    held.resolve(account(2));assert.equal((await retry).exchanges[0].positions[0].quantity,2);
    assert.equal(monitor.state().exchanges[0].status,'ready');
  }finally{held.resolve(account());await monitor.stop();}
  assert.equal(closed,1);
});
test('a timed-out read cannot publish late data but its warm client can recover after completion',async()=>{
  const held=deferred<AccountState>();let created=0,calls=0;
  const monitor=new LivePortfolioMonitor(()=>({...config,exchanges:['gate']}),{env,timeoutMs:10,createClient:()=>{
    created++;return {fetchAccount:()=>++calls===1?held.promise:Promise.resolve(account(3)),close:async()=>{}};
  }});
  try{
    assert.equal((await monitor.refresh()).exchanges[0].status,'error');
    held.resolve(account(99));await new Promise(r=>setImmediate(r));
    assert.equal(monitor.state().exchanges[0].status,'error');
    const recovered=await monitor.refresh();assert.equal(recovered.exchanges[0].status,'ready');
    assert.equal(recovered.exchanges[0].positions[0].quantity,3);assert.equal(created,1);
  }finally{held.resolve(account());await monitor.stop();}
});
test('same-venue requests are deduplicated and a timeout cannot publish a late response',async()=>{
  let calls=0;const held=deferred<AccountState>(),monitor=new LivePortfolioMonitor(()=>({...config,exchanges:['gate']}),{env,timeoutMs:10,createClient:()=>({fetchAccount:()=>{calls++;return held.promise;},close:async()=>{}})});
  try{const [a,b]=await Promise.all([monitor.refresh(),monitor.refresh()]);assert.equal(calls,1);assert.equal(a.exchanges[0].status,'error');assert.equal(b.exchanges[0].status,'error');
    await monitor.refresh();assert.equal(calls,1,'timed-out raw request must not overlap a retry');held.resolve(account(99));await new Promise(r=>setImmediate(r));
    assert.equal(monitor.state().exchanges[0].status,'error');assert.deepEqual(monitor.state().exchanges[0].positions,[]);}
  finally{held.resolve(account());await monitor.stop();}
});
test('one hung venue does not prevent fast venue observations from updating independently',async()=>{
  let bybitCalls=0;const held=deferred<AccountState>(),monitor=new LivePortfolioMonitor(()=>config,{env,timeoutMs:10,createClient:id=>({fetchAccount:()=>id==='gate'?held.promise:Promise.resolve(account(++bybitCalls)),close:async()=>{}})});
  try{const first=monitor.refresh();await new Promise(r=>setImmediate(r));assert.equal(monitor.state().exchanges.find(e=>e.exchange==='bybit')!.positions[0].quantity,1);
    await Promise.all([first,monitor.refresh()]);assert.equal(bybitCalls,2);assert.equal(monitor.state().exchanges.find(e=>e.exchange==='bybit')!.positions[0].quantity,2);}
  finally{held.resolve(account());await monitor.stop();}
});
test('credential reset discards late old-account observations',async()=>{
  let generation=0;const held=deferred<AccountState>(),monitor=new LivePortfolioMonitor(()=>({...config,exchanges:['gate']}),{env,createClient:()=>({fetchAccount:()=>generation===0?held.promise:Promise.resolve(account(2)),close:async()=>{}})});
  try{const old=monitor.refresh();await new Promise(r=>setImmediate(r));monitor.reset();generation=1;await monitor.refresh();held.resolve(account(99));await old;
    assert.equal(monitor.state().exchanges[0].positions[0].quantity,2);}
  finally{held.resolve(account());await monitor.stop();}
});
test('missing credentials and paper mode make no private requests',async()=>{
  let calls=0;const factory=()=>{calls++;throw new Error('must not instantiate');};
  const missing=new LivePortfolioMonitor(()=>config,{env:{},createClient:factory});const paper=new LivePortfolioMonitor(()=>({...config,mode:'paper'}),{env,createClient:factory});
  try{assert.ok((await missing.refresh()).exchanges.every(e=>e.status==='not_configured'));await paper.refresh();assert.equal(calls,0);}
  finally{await missing.stop();await paper.stop();}
});
test('invalid account quantities cannot be treated as an empty account',async()=>{
  const bad=account();bad.positions[0].quantity=NaN;const monitor=new LivePortfolioMonitor(()=>config,{env,createClient:()=>({fetchAccount:async()=>bad,close:async()=>{}})});
  try{assert.ok((await monitor.refresh()).exchanges.every(e=>e.status==='error'));}finally{await monitor.stop();}
});
test('normalization copies only approved position fields and callers cannot mutate the cache',async()=>{
  const raw:any=account();raw.secret='PRIVATE';raw.positions[0].rawPayload={secret:'PRIVATE'};
  raw.positions[0].cashFlowAt=100000;raw.positions[0].fundingUsd=-.12;raw.positions[0].feesUsd=.01;raw.positions[0].marginMode='crossed';
  raw.positions[0].realizedPnlUsd=.035;raw.positions[0].positionOpenedAt=90000;raw.positions[0].positionUpdatedAt=99000;
  raw.positions[0].cashFlowSince=90000;raw.positions[0].liquidationStatus='not_liquidatable';raw.positions[0].liquidationReason='当前无强平价';
  raw.positions[0].positionId='922337203685477581';
  const monitor=new LivePortfolioMonitor(()=>config,{env,createClient:()=>({fetchAccount:async()=>raw,close:async()=>{}})});
  try{const state=await monitor.refresh();assert.ok(!JSON.stringify(state).includes('PRIVATE'));
    assert.equal(state.exchanges[0].positions[0].cashFlowAt,100000);assert.equal(state.exchanges[0].positions[0].fundingUsd,-.12);assert.equal(state.exchanges[0].positions[0].marginMode,'crossed');
    assert.equal(state.exchanges[0].positions[0].realizedPnlUsd,.035);assert.equal(state.exchanges[0].positions[0].cashFlowSince,90000);
    assert.equal(state.exchanges[0].positions[0].positionOpenedAt,90000);assert.equal(state.exchanges[0].positions[0].liquidationStatus,'not_liquidatable');
    assert.equal(state.exchanges[0].positions[0].liquidationReason,'当前无强平价');
    assert.equal(state.exchanges[0].positions[0].positionId,'922337203685477581');
    state.exchanges[0].positions[0].quantity=100;assert.equal(monitor.state().exchanges[0].positions[0].quantity,1);}
  finally{await monitor.stop();}
});
test('optional exchange metrics retain real zero but do not invent missing funding, fees or PnL',()=>{
  assert.deepEqual(positionMetrics('',undefined,null,''),{});
  assert.deepEqual(positionMetrics('100','0','-.12','-.05'),{entryPrice:100,unrealizedPnlUsd:0,fundingUsd:-.12,feesUsd:.05});
  assert.deepEqual(positionMetrics(Infinity,NaN,{},false),{});
});

test('bill evidence statuses and fixed safe reasons survive portfolio normalization without inventing amounts',async()=>{
  const raw:any=account(),states=[['loading','正在读取当前持仓周期账单'],['ready','账单已完整核对'],
    ['incomplete','账单无法完整归属当前持仓周期'],['error','账单请求失败，后台会自动重试'],
    ['unavailable','交易所未返回当前持仓周期时间'],['stale','账单证据已过期，等待重新读取']];
  raw.positions[0].rawCashPayload={secret:'PRIVATE_BILL'};
  const monitor=new LivePortfolioMonitor(()=>({...config,exchanges:['bybit']}),{env,createClient:()=>({fetchAccount:async()=>raw,close:async()=>{}})});
  try{
    for(const [cashFlowStatus,cashFlowReason] of states){
      Object.assign(raw.positions[0],{cashFlowStatus,cashFlowReason});
      const state=await monitor.refresh(),position=state.exchanges[0].positions[0];
      assert.equal(position.cashFlowStatus,cashFlowStatus);assert.equal(position.cashFlowReason,cashFlowReason);
      assert.equal(position.fundingUsd,undefined);assert.equal(position.feesUsd,undefined);assert.equal(position.realizedPnlUsd,undefined);
      assert.ok(!JSON.stringify(state).includes('PRIVATE_BILL'));
    }
    Object.assign(raw.positions[0],{cashFlowStatus:'ready',cashFlowReason:'PRIVATE_BILL',fundingUsd:0,feesUsd:0,realizedPnlUsd:0});
    const zeros=(await monitor.refresh()).exchanges[0].positions[0];
    assert.equal(zeros.fundingUsd,0);assert.equal(zeros.feesUsd,0);assert.equal(zeros.realizedPnlUsd,0);assert.equal(zeros.cashFlowReason,undefined);
    Object.assign(raw.positions[0],{cashFlowStatus:'PRIVATE_STATUS',cashFlowReason:'账单已完整核对'});
    const invalid=(await monitor.refresh()).exchanges[0].positions[0];
    assert.equal(invalid.cashFlowStatus,undefined);assert.equal(invalid.cashFlowReason,undefined);
  }finally{await monitor.stop();}
});
test('portfolio publishes only complete fresh signed contract fee metadata, retaining a real zero fee',async()=>{
  let now=1_000_000;const raw:any=account();raw.positions[0].takerFeeRate=.0011;raw.positions[0].takerFeeAt=now;raw.positions[0].takerFeeSource='exchange';
  raw.positions[0].privateFeePayload={secret:'PRIVATE'};
  const monitor=new LivePortfolioMonitor(()=>config,{env,now:()=>now,createClient:()=>({fetchAccount:async()=>raw,close:async()=>{}})});
  try{
    let p=(await monitor.refresh()).exchanges[0].positions[0];assert.equal(p.takerFeeRate,.0011);assert.equal(p.takerFeeAt,now);assert.equal(p.takerFeeSource,'exchange');
    assert.ok(!JSON.stringify(monitor.state()).includes('PRIVATE'));
    raw.positions[0].takerFeeRate=0;p=(await monitor.refresh()).exchanges[0].positions[0];assert.equal(p.takerFeeRate,0);
    for(const patch of [{takerFeeSource:'config'}, {takerFeeSource:'exchange',takerFeeAt:now+1},
      {takerFeeAt:now-120001},{takerFeeAt:now,takerFeeRate:NaN},{takerFeeRate:-.001},{takerFeeRate:.011}]){
      Object.assign(raw.positions[0],patch);p=(await monitor.refresh()).exchanges[0].positions[0];
      assert.equal(p.takerFeeRate,undefined);assert.equal(p.takerFeeAt,undefined);assert.equal(p.takerFeeSource,undefined);
    }
  }finally{await monitor.stop();}
});
