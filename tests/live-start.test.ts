import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectLiveStart, type LiveStartContext } from '../src/core/live-start.js';
import type { LiveEnvironment } from '../src/core/live-readiness.js';
import { defaultConfig } from './legacy-config.js';
import { EXCHANGES, type AccountState, type AppConfig, type ExchangeId } from '../src/shared/types.js';

const config:AppConfig={...defaultConfig,mode:'live',dataSource:'public',orderNotionalUsd:100,leverage:2};
const environment=(configured:ExchangeId[]=['gate','bitget']):LiveEnvironment=>({permissionGranted:false,
  exchanges:EXCHANGES.map(exchange=>({exchange,supported:true,credentialsConfigured:configured.includes(exchange)}))});
const account=(freeUsd=100):AccountState=>({freeUsd,equityUsd:freeUsd,positions:[]});
const context=(fetch:(exchange:ExchangeId)=>Promise<AccountState>,extra:Partial<LiveStartContext>={}):LiveStartContext=>({
  executionUnlocked:false,blockedReasons:[],adapter:exchange=>({fetchAccount:()=>fetch(exchange)}),...extra,
});

test('two configured accounts can pass a read-only preflight while three unconfigured venues remain untouched',async()=>{
  const calls:ExchangeId[]=[];
  const result=await inspectLiveStart(config,environment(),context(async exchange=>{calls.push(exchange);return account();}));
  assert.equal(result.canStart,true);assert.equal(result.executionUnlocked,false);assert.deepEqual(calls,['gate','bitget']);
  assert.equal(result.orderNotionalUsd,100);assert.deepEqual(result.blockers,[]);
  assert.deepEqual(result.accounts.map(item=>item.exchange),[...EXCHANGES]);
  assert.deepEqual(result.accounts.map(item=>item.status),['not_configured','not_configured','not_configured','ready','ready']);
  assert.equal(result.accounts.find(item=>item.exchange==='gate')!.requiredUsd,50);
  assert.equal(result.accounts.find(item=>item.exchange==='bitget')!.requiredUsd,50);
  assert.match(result.accounts.find(item=>item.exchange==='gate')!.message,/本金.*具体合约官方手续费在下单前核验/);
});

test('startup checks principal without a guessed symbol fee and spot balances never supplement strict free margin',async()=>{
  const result=await inspectLiveStart(config,environment(),context(async exchange=>exchange==='gate'?account(50):
    {...account(49.99),spotAvailableUsd:1_000_000,isolatedAvailableUsd:1_000_000}));
  assert.equal(result.canStart,false);assert.equal(result.accounts[3].status,'ready');assert.equal(result.accounts[4].status,'insufficient');
  assert.equal(result.accounts[4].freeUsd,49.99);assert.equal('spotAvailableUsd' in result.accounts[4],false);
  assert.equal('equityUsd' in result.accounts[4],false);
});

test('account reads run concurrently and a hung venue has a deadline without blocking two healthy venues',async()=>{
  const calls:ExchangeId[]=[];
  let release!:()=>void;
  const allStarted=new Promise<void>(resolve=>{release=resolve;});
  const result=await inspectLiveStart(config,environment(['binance','gate','bitget']),context(async exchange=>{
    calls.push(exchange);if(calls.length===3)release();
    if(exchange==='binance')return new Promise<AccountState>(()=>{});
    await allStarted;return account();
  },{timeoutMs:20}));
  assert.deepEqual(calls,['binance','gate','bitget']);assert.equal(result.canStart,true);
  assert.equal(result.accounts[0].status,'error');assert.match(result.accounts[0].message,/超时/);
  assert.equal(result.accounts[3].status,'ready');assert.equal(result.accounts[4].status,'ready');
});

test('private failures and synchronous adapter errors use fixed messages without echoing secrets',async()=>{
  const secret='private-api-key-and-signed-url';
  const result=await inspectLiveStart(config,environment(),context(async()=>{throw new Error(secret);},{adapter:exchange=>{
    if(exchange==='gate')throw new Error(secret);
    return {fetchAccount:async()=>{throw new Error(secret);}};
  }}));
  assert.equal(result.canStart,false);assert.equal(JSON.stringify(result).includes(secret),false);
  assert.equal(result.accounts[3].message,result.accounts[4].message);
  assert.equal(result.accounts[3].freeUsd,undefined);
});

test('Bitget mode incompatibility is reported explicitly without granting execution readiness',async()=>{
  const result=await inspectLiveStart(config,environment(),context(async exchange=>{
    if(exchange==='bitget')throw new Error('bitget: UTA holding mode must be verified');
    return account();
  }));
  assert.equal(result.canStart,false);assert.equal(result.executionUnlocked,false);
  assert.equal(result.accounts[3].status,'ready');assert.equal(result.accounts[4].status,'error');
  assert.match(result.accounts[4].message,/连接已通过.*尚未确认.*开平仓参数/);
  assert.equal(result.accounts[4].freeUsd,undefined);
});

test('existing nonzero positions exclude only their coin and both venues can pass startup',async()=>{
  const position={base:'BTC',symbol:'BTC/USDT:USDT',side:'long' as const,quantity:0,markPrice:100,liquidationPrice:50,leverage:2};
  const result=await inspectLiveStart(config,environment(),context(async exchange=>({...account(),positions:[{...position,quantity:exchange==='gate'?0:.1}]})));
  assert.equal(result.canStart,true);assert.equal(result.accounts[3].status,'ready');assert.equal(result.accounts[4].status,'ready');
  assert.match(result.accounts[4].message,/仅跳过这些币种/);assert.equal('positions' in result.accounts[4],false);
  assert.deepEqual(result.accounts[3].excludedCoins,[]);assert.deepEqual(result.accounts[4].excludedCoins,['BTC']);
  assert.deepEqual(result.excludedCoins?.map(item=>({base:item.base,exchanges:item.exchanges})),[{base:'BTC',exchanges:['bitget']}]);
});

test('pending-order blockers prevent start even when two balances pass and execution is already unlocked',async()=>{
  const blockers=['仍有未确认订单'];
  const result=await inspectLiveStart(config,environment(),context(async()=>account(),{executionUnlocked:true,blockedReasons:blockers}));
  assert.equal(result.executionUnlocked,true);assert.equal(result.canStart,false);assert.deepEqual(result.blockers,blockers);
  assert.notEqual(result.blockers,blockers);assert.equal(result.accounts.filter(item=>item.status==='ready').length,2);
});

test('paper or synthetic modes cannot invoke private account reads',async()=>{
  for(const changes of [{mode:'paper' as const},{dataSource:'demo' as const}]){
    let calls=0;
    const result=await inspectLiveStart({...config,...changes},environment(),context(async()=>{calls++;return account();}));
    assert.equal(calls,0);assert.equal(result.canStart,false);assert.ok(result.blockers.some(message=>message.includes('实盘公开行情')));
    assert.equal(result.accounts.length,5);
  }
});

test('invalid margin calculations fail closed before private reads and never emit nonfinite amounts',async()=>{
  for(const changes of [{orderNotionalUsd:NaN},{leverage:0},{orderNotionalUsd:Number.MAX_VALUE,leverage:Number.MIN_VALUE}]){
    let calls=0;
    const result=await inspectLiveStart({...config,...changes},environment(),context(async()=>{calls++;return account();}));
    assert.equal(calls,0);assert.equal(result.canStart,false);assert.ok(Number.isFinite(result.orderNotionalUsd));
    assert.ok(result.accounts.every(item=>Number.isFinite(item.requiredUsd)));assert.ok(result.blockers.some(message=>message.includes('配置无效')));
  }
});

test('generic live startup never infers contract fees from simulated, missing or invalid configured rates',async()=>{
  for(const takerFees of [{...config.takerFees,bitget:NaN},{...config.takerFees,gate:-.001},{...config.takerFees,gate:.01,bitget:.01}]){
    const calls:ExchangeId[]=[];
    const result=await inspectLiveStart({...config,takerFees},environment(),context(async exchange=>{calls.push(exchange);return account(50);}));
    assert.equal(result.canStart,true);assert.equal(result.executionUnlocked,false);assert.deepEqual(calls,['gate','bitget']);
    assert.equal(result.accounts[3].requiredUsd,50);assert.equal(result.accounts[4].requiredUsd,50);
    assert.match(result.accounts[3].message,/具体合约官方手续费在下单前核验/);
  }
});

test('unsupported configured venues and missing credentials are never queried',async()=>{
  const env=environment(['binance','gate','bitget']);env.exchanges[0].supported=false;
  const calls:ExchangeId[]=[];
  const result=await inspectLiveStart(config,env,context(async exchange=>{calls.push(exchange);return account();}));
  assert.equal(result.canStart,true);assert.deepEqual(calls,['gate','bitget']);
  assert.equal(result.accounts[0].status,'error');assert.equal(result.accounts[0].credentialsConfigured,true);
  assert.equal(result.accounts[1].status,'not_configured');
});

test('invalid private account data is not mistaken for zero or an empty position list',async()=>{
  for(const invalid of [{...account(),freeUsd:NaN},{...account(),positions:undefined},{...account(),positions:[{quantity:NaN}]}]){
    const result=await inspectLiveStart(config,environment(),context(async()=>invalid as AccountState));
    assert.equal(result.canStart,false);assert.equal(result.accounts[3].status,'error');
    assert.equal(result.accounts[3].freeUsd,undefined);assert.match(result.accounts[3].message,/数据不完整/);
  }
});

test('a late successful private response cannot revise a timed-out report',async()=>{
  let resolveLate!:(value:AccountState)=>void;
  const late=new Promise<AccountState>(resolve=>{resolveLate=resolve;});
  const result=await inspectLiveStart(config,environment(),context(async exchange=>exchange==='gate'?late:account(),{timeoutMs:5}));
  assert.equal(result.canStart,false);assert.equal(result.accounts[3].status,'error');
  const before=JSON.stringify(result);resolveLate(account());await Promise.resolve();await Promise.resolve();
  assert.equal(JSON.stringify(result),before);
});

test('existing positions and zero margin permit management recovery but never new automatic entries',async()=>{
  const position={base:'BTC',symbol:'BTC/USDT:USDT',side:'long' as const,quantity:1,markPrice:100,liquidationPrice:50,leverage:2};
  const result=await inspectLiveStart(config,environment(),context(async()=>({...account(0),positions:[position]}),{
    recoveryExchanges:['gate','bitget'],
  }));
  assert.equal(result.canStart,false);assert.equal(result.canRecover,true);assert.deepEqual(result.recoveryBlockers,[]);
  assert.deepEqual(result.managementExchanges,['gate','bitget']);assert.equal(result.executionUnlocked,false);
  assert.equal(result.accounts[3].status,'insufficient');assert.match(result.accounts[3].message,/保证金不足/);
  assert.equal(result.accounts[4].freeUsd,0);
});

test('management recovery requires every involved venue even when two other accounts are healthy',async()=>{
  const result=await inspectLiveStart(config,environment(),context(async()=>account(),{recoveryExchanges:['binance','gate']}));
  assert.equal(result.canStart,true);assert.equal(result.canRecover,false);
  assert.deepEqual(result.managementExchanges,['gate','bitget']);assert.ok(result.recoveryBlockers!.some(message=>message.includes('binance')));
});

test('management recovery may manage one residual venue and obeys independent recovery blockers',async()=>{
  const one=await inspectLiveStart(config,environment(['gate']),context(async()=>account(0),{recoveryExchanges:['gate']}));
  assert.equal(one.canRecover,true);assert.equal(one.canStart,false);assert.deepEqual(one.managementExchanges,['gate']);
  const blocked=await inspectLiveStart(config,environment(),context(async()=>account(),{
    recoveryExchanges:['gate','bitget'],recoveryBlockedReasons:['服务正在停止'],
  }));
  assert.equal(blocked.canStart,true);assert.equal(blocked.canRecover,false);assert.deepEqual(blocked.recoveryBlockers,['服务正在停止']);
});

test('management membership excludes timeouts and remains unchanged when an account succeeds late',async()=>{
  let resolveLate!:(value:AccountState)=>void;
  const late=new Promise<AccountState>(resolve=>{resolveLate=resolve;});
  const result=await inspectLiveStart(config,environment(['binance','gate','bitget']),context(async exchange=>exchange==='binance'?late:account(0),{
    recoveryExchanges:['gate','bitget'],timeoutMs:5,
  }));
  assert.equal(result.canStart,false);assert.equal(result.canRecover,true);assert.deepEqual(result.managementExchanges,['gate','bitget']);
  const before=JSON.stringify(result);resolveLate(account());await Promise.resolve();await Promise.resolve();
  assert.equal(JSON.stringify(result),before);
});

test('recovery fields are omitted unless a nonempty set of involved exchanges is supplied',async()=>{
  for(const recoveryExchanges of [undefined,[]]){
    const result=await inspectLiveStart(config,environment(),context(async()=>account(),{recoveryExchanges,recoveryBlockedReasons:['unused']}));
    assert.equal('canRecover' in result,false);assert.equal('recoveryBlockers' in result,false);assert.equal('managementExchanges' in result,false);
  }
});

test('invalid account quantities cannot grant management access',async()=>{
  const result=await inspectLiveStart(config,environment(),context(async exchange=>exchange==='gate'?account():
    ({...account(),positions:[{quantity:-1}]} as AccountState),{recoveryExchanges:['gate','bitget']}));
  assert.equal(result.canRecover,false);assert.deepEqual(result.managementExchanges,['gate']);
});
