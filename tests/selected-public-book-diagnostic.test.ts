import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {safeMessage} from '../src/core/engine.js';
import {SelectedPublicBookError,selectedPublicBookReason} from '../src/core/selected-public-book-error.js';
import {ExchangeNetworkError} from '../src/adapters/network.js';
import {tradingError} from '../src/core/trading-errors.js';
import type {ExchangeId,MarketSnapshot,Position} from '../src/shared/types.js';
import {fixture,NOW} from './native-exit-read-fixture.js';

function prepare(t:TestContext,exchange:'gate'|'bybit'|'bitget'='bitget'){
  const f=fixture(t,{peerExchange:exchange==='gate'?'bybit':exchange}),adapter=f.adapters.find(a=>a.id===exchange)!;
  const originalOrders=structuredClone(f.store.data.orders),originalCash=structuredClone({long:f.p.long,short:f.p.short,
    funding:f.p.fundingUsd,fees:f.p.feesUsd,realized:f.p.realizedSpreadPnlUsd}),publicReads:string[]=[];
  let feeReads=0,returned:MarketSnapshot[]=[];
  adapter.fetchExecutionSnapshots=async bases=>{publicReads.push(...bases);return returned;};
  adapter.fetchTradingFee=async()=>{feeReads++;throw new Error('Private fee traffic is forbidden for this public recovery');};
  const refresh=()=>f.engine.execution.context.refreshReductionSnapshots!(f.p.base,[exchange]);
  const wait=(error:unknown)=> (f.engine.execution as unknown as {
    waitIocPreflight(p:Position,phase:'book-refresh',error:unknown):Promise<void>}).waitIocPreflight(f.p,'book-refresh',error);
  const failure=async()=>{try{await refresh();}catch(error){await wait(error);return error;}assert.fail('The unchanged quote guard must reject');};
  const unchanged=(expectedFees=0,expectedKill=false)=>{
    assert.deepEqual(f.store.data.orders,originalOrders);assert.deepEqual({long:f.p.long,short:f.p.short,
      funding:f.p.fundingUsd,fees:f.p.feesUsd,realized:f.p.realizedSpreadPnlUsd},originalCash);
    assert.equal(feeReads,expectedFees);assert.equal(f.store.data.killSwitch,expectedKill);assert.equal(f.reads.length,0);
  };
  return {...f,adapter,publicReads,refresh,wait,failure,unchanged,setReturned:(value:MarketSnapshot[])=>{returned=value;},
    message:()=>f.logs.at(-1)![1] as string};
}

function pendingPublic(t:TestContext){
  const f=prepare(t),snapshots=structuredClone(f.engine.snapshots);
  (f.engine as unknown as {options:{privateReadDeadlineMs?:number}}).options.privateReadDeadlineMs=5;
  let finish!:(quotes:MarketSnapshot[])=>void,started!:()=>void;
  const pending=new Promise<MarketSnapshot[]>(resolve=>{finish=resolve;}),entered=new Promise<void>(resolve=>{started=resolve;});
  f.adapter.fetchExecutionSnapshots=async bases=>{f.publicReads.push(...bases);started();return pending;};
  const requests=()=>(f.engine as unknown as {privateReadRequests:WeakMap<typeof f.adapter,Map<string,Promise<unknown>>>})
    .privateReadRequests.get(f.adapter);
  const release=async()=>{
    finish([{...structuredClone(f.quotes.get('bitget')!),markPrice:777}]);await pending;
    await new Promise<void>(resolve=>setImmediate(resolve));
  };
  t.after(release);
  return {...f,entered,release,snapshots,isPending:()=>requests()?.has(`execution-book:${f.p.base}`)===true};
}

for(const exchange of ['gate','bybit','bitget'] as const)
test(`Engine public ${exchange} response -> execution preflight preserves selected venue and missing-book reason`,async t=>{
  const f=prepare(t,exchange),error=await f.failure();
  assert.ok(error instanceof SelectedPublicBookError);assert.equal(error.exchange,exchange);assert.equal(error.reason,'missing');
  assert.equal(f.message(),`${f.p.base} 对手价1 IOC 盘口读取未通过：${selectedPublicBookReason(error)}；本轮未创建委托，等待重新核验`);
  assert.doesNotMatch(f.message(),/账户权限|合约设置/);assert.deepEqual(f.publicReads,[f.p.base]);f.unchanged();
});

for(const timing of ['book','metadata','future'] as const)
test(`the original ${timing} freshness guard still rejects and reports the selected public timing reason`,async t=>{
  const f=prepare(t),quote=structuredClone(f.quotes.get('bitget')!);
  if(timing==='book')quote.observedAt=quote.timestamp=NOW-120_000;
  if(timing==='metadata')quote.fundingObservedAt=NOW-120_000;
  if(timing==='future')quote.observedAt=quote.timestamp=NOW+5001;
  f.setReturned([quote]);const error=await f.failure();
  assert.ok(error instanceof SelectedPublicBookError);assert.equal(error.reason,'not-fresh');
  assert.match(f.message(),/Bitget 公开执行盘口.*时效核验/);f.unchanged();
});

test('a response for another venue or another coin cannot masquerade as the requested public book',async t=>{
  const f=prepare(t),quote=structuredClone(f.quotes.get('bitget')!);
  f.setReturned([{...quote,exchange:'gate'},{...quote,base:'OTHER'}]);await f.failure();
  assert.match(f.message(),/Bitget 公开执行盘口未返回所选币种数据/);f.unchanged();
});

test('the first selected public cause is logged and repeated cause keeps the original fifteen-second throttle',async t=>{
  const f=prepare(t),before=f.logs.length,error=await f.failure();assert.equal(f.logs.length,before+1);
  f.advance(14999);await f.wait(error);assert.equal(f.logs.length,before+1);
  f.advance(1);await f.wait(error);assert.equal(f.logs.length,before+2);f.unchanged();
});

test('selected public venues and missing/timing causes keep independent log-throttle scopes',async t=>{
  const f=prepare(t),before=f.logs.length;
  await f.wait(new SelectedPublicBookError('bitget','missing'));
  await f.wait(new SelectedPublicBookError('gate','missing'));
  await f.wait(new SelectedPublicBookError('bitget','not-fresh'));
  await f.wait(new SelectedPublicBookError('bitget','missing'));
  assert.equal(f.logs.length,before+3);f.unchanged();
});

test('a fresh selected public response still succeeds with no private fee read or IOC intent',async t=>{
  const f=prepare(t);f.setReturned([structuredClone(f.quotes.get('bitget')!)]);await f.refresh();f.unchanged();
});

test('a public transport failure keeps its original network venue and never becomes a missing quote',async t=>{
  const f=prepare(t),error=new ExchangeNetworkError('TIMEOUT',0,undefined,'bitget');
  f.adapter.fetchExecutionSnapshots=async bases=>{f.publicReads.push(...bases);throw error;};assert.equal(await f.failure(),error);
  assert.match(f.message(),/Bitget.*请求超时/);assert.doesNotMatch(f.message(),/未返回所选币种|时效核验/);
  assert.deepEqual(f.publicReads,[f.p.base]);f.unchanged();
});

test('native fee or account errors retain their native venue and cannot borrow public-book wording',async t=>{
  const f=prepare(t),error=tradingError('bybit','账户检查',new ExchangeNetworkError('ACCESS_DENIED',0,undefined,'bybit'));
  await f.wait(error);assert.match(f.message(),/Bybit 账户检查/);assert.doesNotMatch(f.message(),/公开执行盘口/);f.unchanged();
});

test('an actual public adapter rejection reports only its known callsite venue and unknown read cause',async t=>{
  const f=prepare(t),error=Object.assign(new Error('private-canary https://secret-canary.invalid?apiKey=canary'),
    {name:'SelectedPublicBookError',exchange:'gate',reason:'missing',headers:{authorization:'private-canary'}});
  f.adapter.fetchExecutionSnapshots=async bases=>{f.publicReads.push(...bases);throw error;};const selected=await f.failure();
  assert.ok(selected instanceof SelectedPublicBookError);assert.equal(selected.exchange,'bitget');assert.equal(selected.reason,'read-failed');
  assert.match(f.message(),/Bitget 公开执行行情读取失败，原始原因未确认/);
  assert.doesNotMatch(f.message(),/Gate|未返回所选币种|时效核验|canary|headers|账户权限|合约设置/);
  assert.equal(selected.cause,undefined);assert.equal(safeMessage(selected),selectedPublicBookReason(selected));
  assert.deepEqual(f.publicReads,[f.p.base]);f.unchanged();
});

test('an isolated unclassified error cannot spoof a public callsite or leak its private body',async t=>{
  const f=prepare(t),error=Object.assign(new Error('private-canary https://secret-canary.invalid?apiKey=canary'),
    {name:'SelectedPublicBookError',exchange:'bitget',reason:'read-failed',headers:{authorization:'private-canary'}});
  await f.wait(error);
  assert.match(f.message(),/所选交易所/);assert.doesNotMatch(f.message(),/Bitget|Gate|公开执行盘口|canary|headers/);f.unchanged();
});

test('public read rejection preserves the original first log and independent fifteen-second cause throttle',async t=>{
  const f=prepare(t),raw=new Error('private-canary'),before=f.logs.length;
  f.adapter.fetchExecutionSnapshots=async bases=>{f.publicReads.push(...bases);throw raw;};const error=await f.failure();
  assert.ok(error instanceof SelectedPublicBookError);assert.equal(error.reason,'read-failed');assert.equal(f.logs.length,before+1);
  f.advance(14999);await f.wait(error);assert.equal(f.logs.length,before+1);
  await f.wait(new SelectedPublicBookError('bitget','missing'));assert.equal(f.logs.length,before+2);
  f.advance(1);await f.wait(error);assert.equal(f.logs.length,before+3);f.unchanged();
});

test('a raw connect-shaped error is fixed public read failure without guessed network cause or private text',async t=>{
  const f=prepare(t),error=Object.assign(new Error('private-canary timeout token'),{code:'ETIMEDOUT',syscall:'connect'});
  f.adapter.fetchExecutionSnapshots=async bases=>{f.publicReads.push(...bases);throw error;};await f.failure();
  assert.match(f.message(),/Bitget 公开执行行情读取失败，原始原因未确认/);
  assert.doesNotMatch(f.message(),/请求超时|canary|token|ETIMEDOUT/);assert.deepEqual(f.publicReads,[f.p.base]);f.unchanged();
});

test('the exact known public network error keeps its original object and venue despite a different callsite',async t=>{
  const f=prepare(t),error=new ExchangeNetworkError('DNS_ERROR',0,undefined,'bybit');
  f.adapter.fetchExecutionSnapshots=async bases=>{f.publicReads.push(...bases);throw error;};assert.equal(await f.failure(),error);
  assert.match(f.message(),/Bybit.*域名解析失败/);assert.doesNotMatch(f.message(),/Bitget|公开执行行情/);
  assert.deepEqual(f.publicReads,[f.p.base]);f.unchanged();
});

test('a real native fee fetch failure alongside public rejection adds no fee reads and cannot relabel its cause',async t=>{
  const f=prepare(t),error=new Error('private-public-canary'),native=new ExchangeNetworkError('ACCESS_DENIED',0,undefined,'bitget');
  let feeReads=0;f.adapter.fetchTradingFee=async()=>{feeReads++;throw native;};
  f.adapter.fetchExecutionSnapshots=async bases=>{f.publicReads.push(...bases);throw error;};
  let rejected:unknown;try{await f.engine.execution.context.refreshSnapshots!(f.p.base,['bitget']);}catch(e){rejected=e;}
  assert.ok(rejected instanceof SelectedPublicBookError);assert.equal(rejected.reason,'read-failed');await f.wait(rejected);
  assert.match(f.message(),/Bitget 公开执行行情读取失败，原始原因未确认/);assert.doesNotMatch(f.message(),/canary|权限/);
  assert.equal(feeReads,1);assert.deepEqual(f.publicReads,[f.p.base]);f.unchanged();
});

for(const publicFails of [false,true])test(`a native fee promise failure stays outside the public boundary (public rejects: ${publicFails})`,async t=>{
  const f=prepare(t),native=tradingError('bybit','账户检查',new ExchangeNetworkError('ACCESS_DENIED',0,undefined,'bybit'));
  let feeReads=0;
  (f.engine as unknown as {refreshTradingFee():Promise<void>}).refreshTradingFee=async()=>{feeReads++;throw native;};
  f.adapter.fetchExecutionSnapshots=async bases=>{f.publicReads.push(...bases);if(publicFails)throw new Error('private-public-canary');return [structuredClone(f.quotes.get('bitget')!)];};
  let rejected:unknown;try{await f.engine.execution.context.refreshSnapshots!(f.p.base,['bitget']);}catch(e){rejected=e;}
  assert.equal(rejected,native);await f.wait(rejected);assert.match(f.message(),/Bybit 账户检查/);
  assert.doesNotMatch(f.message(),/公开执行行情|canary/);assert.equal(feeReads,1);assert.deepEqual(f.publicReads,[f.p.base]);f.unchanged();
});

test('a filesystem write fault in the public callback remains the original global-stop fault',async t=>{
  const f=prepare(t),error=Object.assign(new Error('private-disk-canary'),{syscall:'write',code:'EIO'});
  f.adapter.fetchExecutionSnapshots=async bases=>{f.publicReads.push(...bases);throw error;};
  await assert.rejects(f.refresh(),e=>e===error);await assert.rejects(f.wait(error),e=>e===error);
  assert.equal(f.logs.length,0);assert.deepEqual(f.publicReads,[f.p.base]);f.unchanged();
});

test('an actual marked save failure without OS metadata remains the original persistence fault',async t=>{
  const f=prepare(t),error=new Error('private-plain-save-canary');
  f.store.save=()=>{throw error;};
  f.adapter.fetchExecutionSnapshots=async bases=>{
    f.publicReads.push(...bases);
    (f.engine as unknown as {persistObservation<T>(write:()=>T):T}).persistObservation(()=>f.store.save());return [];
  };
  await assert.rejects(f.refresh(),e=>e===error);assert.equal(f.store.data.killSwitch,true);
  assert.deepEqual(f.publicReads,[f.p.base]);f.unchanged(0,true);
});

test('an Execution-marked actual observation log failure also crosses the public boundary unchanged',async t=>{
  const f=prepare(t),error=new Error('private-observation-save-canary');
  f.store.log=()=>{throw error;};
  f.adapter.fetchExecutionSnapshots=async bases=>{
    f.publicReads.push(...bases);
    (f.engine.execution as unknown as {persistReconciliationObservation<T>(journal:typeof f.parent,write:()=>T):T})
      .persistReconciliationObservation(f.parent,()=>f.store.log('warn','fixed memory diagnostic'));return [];
  };
  await assert.rejects(f.refresh(),e=>e===error);assert.equal(f.engine.execution.isObservationPersistenceFailure(error),true);
  assert.deepEqual(f.publicReads,[f.p.base]);f.unchanged(0,true);
});

test('the real selected public deadline has the fixed venue reason and cannot publish a late result',async t=>{
  const f=pendingPublic(t),error=await f.failure();
  assert.ok(error instanceof SelectedPublicBookError);assert.equal(error.exchange,'bitget');assert.equal(error.reason,'read-failed');
  assert.match(f.message(),/Bitget 公开执行行情读取失败，原始原因未确认/);
  assert.doesNotMatch(f.message(),/Gate|合约检查|账户权限|资金费/);assert.equal(f.isPending(),true);
  assert.deepEqual(f.publicReads,[f.p.base]);assert.deepEqual(f.engine.snapshots,f.snapshots);
  await f.release();assert.equal(f.isPending(),false);assert.deepEqual(f.engine.snapshots,f.snapshots);f.unchanged();
});

test('a second selected public read while the first is pending is diagnosed without a new overlapping request',async t=>{
  const f=pendingPublic(t),first=f.refresh().then(()=>assert.fail('The first selected public read must time out'),error=>error);
  await f.entered;const busy=await f.failure();
  assert.ok(busy instanceof SelectedPublicBookError);assert.equal(busy.exchange,'bitget');assert.equal(busy.reason,'read-failed');
  assert.match(f.message(),/Bitget 公开执行行情读取失败，原始原因未确认/);assert.deepEqual(f.publicReads,[f.p.base]);
  assert.equal(f.isPending(),true);const timeout=await first;assert.ok(timeout instanceof SelectedPublicBookError);
  assert.equal(timeout.reason,'read-failed');await f.release();assert.equal(f.isPending(),false);
  assert.deepEqual(f.engine.snapshots,f.snapshots);f.unchanged();
});

test('a selected public timeout keeps its original in-flight slot until settlement and then permits one new read',async t=>{
  const f=pendingPublic(t);await f.failure();assert.equal(f.isPending(),true);
  const busy=await f.failure();assert.ok(busy instanceof SelectedPublicBookError);assert.equal(busy.reason,'read-failed');
  assert.deepEqual(f.publicReads,[f.p.base]);assert.deepEqual(f.engine.snapshots,f.snapshots);assert.equal(f.logs.length,1);
  await f.release();assert.equal(f.isPending(),false);assert.deepEqual(f.engine.snapshots,f.snapshots);
  f.adapter.fetchExecutionSnapshots=async bases=>{f.publicReads.push(...bases);return [structuredClone(f.quotes.get('bitget')!)];};
  await f.refresh();assert.deepEqual(f.publicReads,[f.p.base,f.p.base]);f.unchanged();
});

test('the selected public wrapper preserves an existing local typed cause instead of replacing its source facts',async t=>{
  const f=prepare(t),error=new SelectedPublicBookError('gate','not-fresh');
  f.adapter.fetchExecutionSnapshots=async bases=>{f.publicReads.push(...bases);throw error;};assert.equal(await f.failure(),error);
  assert.match(f.message(),/Gate 公开执行盘口.*时效核验/);assert.doesNotMatch(f.message(),/Bitget|读取失败/);
  assert.deepEqual(f.publicReads,[f.p.base]);f.unchanged();
});

test('an independent native fee failure cannot borrow a pending selected public deadline classification',async t=>{
  const f=pendingPublic(t),native=tradingError('bybit','账户检查',new ExchangeNetworkError('ACCESS_DENIED',0,undefined,'bybit'));
  let feeReads=0;
  (f.engine as unknown as {refreshTradingFee():Promise<void>}).refreshTradingFee=async()=>{feeReads++;throw native;};
  let rejected:unknown;try{await f.engine.execution.context.refreshSnapshots!(f.p.base,['bitget']);}catch(error){rejected=error;}
  assert.equal(rejected,native);await f.wait(rejected);assert.match(f.message(),/Bybit 账户检查/);
  assert.doesNotMatch(f.message(),/公开执行行情|公开执行盘口/);assert.equal(feeReads,1);assert.equal(f.isPending(),true);
  const busy=await f.failure();assert.ok(busy instanceof SelectedPublicBookError);assert.equal(busy.reason,'read-failed');
  assert.equal(feeReads,1);assert.deepEqual(f.publicReads,[f.p.base]);await f.release();
  assert.equal(f.isPending(),false);assert.deepEqual(f.engine.snapshots,f.snapshots);f.unchanged();
});

for(const exchange of ['binance','bybit','okx','gate','bitget'] as const)
test(`the fixed local ${exchange} public reason also survives the ordinary Engine safeMessage boundary`,()=>{
  const error=new SelectedPublicBookError(exchange,'missing');assert.equal(safeMessage(error),selectedPublicBookReason(error));
  assert.match(safeMessage(error),/公开执行盘口/);assert.equal(error.cause,undefined);
});

test('mutated class messages, getters and forged prototypes cannot inject private text or a false public cause',()=>{
  const genuine=new SelectedPublicBookError('bitget','not-fresh'),fixed=selectedPublicBookReason(genuine)!;
  Object.defineProperty(genuine,'message',{get(){throw new Error('private-canary');}});
  Object.defineProperty(genuine,'exchange',{get(){throw new Error('private-canary');}});
  assert.equal(selectedPublicBookReason(genuine),fixed);assert.equal(safeMessage(genuine),fixed);
  const fake=Object.assign(Object.create(SelectedPublicBookError.prototype),{message:'private-canary',exchange:'bitget',reason:'missing'});
  assert.equal(selectedPublicBookReason(fake),undefined);assert.doesNotMatch(safeMessage(fake),/canary|公开执行盘口/);
  assert.throws(()=>new SelectedPublicBookError('private-canary' as ExchangeId,'missing'),/^Error: 公开盘口诊断参数无效$/);
});
