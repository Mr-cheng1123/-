import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {Engine} from '../src/core/engine.js';
import {Store} from '../src/core/store.js';
import {defaultConfig} from '../src/shared/config.js';
import {EXCHANGES,type AccountState,type AppConfig,type ExchangeAdapter,type ExchangeId,type Position} from '../src/shared/types.js';

const acknowledgement='RECHECK_LIVE_AUTHORIZATION';
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
function fixture(exchanges:ExchangeId[]=[...EXCHANGES],privateReadDeadlineMs=500){
  const directory=mkdtempSync(join(tmpdir(),'funding-live-authorization-'));
  const config:AppConfig={...structuredClone(defaultConfig),mode:'live',dataSource:'public',exchanges,orderNotionalUsd:100,leverage:2};
  const store=new Store(join(directory,'state.json'),config);
  const env:Record<string,string|undefined>={ALLOW_LIVE_TRADING:'false',LIVE_TRADING_ACK:'',
    BYBIT_API_KEY:'offline-key',BYBIT_API_SECRET:'offline-secret',GATE_API_KEY:'offline-key',GATE_API_SECRET:'offline-secret',
    BITGET_API_KEY:'offline-key',BITGET_API_SECRET:'offline-secret',BITGET_PASSPHRASE:'offline-pass'};
  const accounts=new Map<ExchangeId,AccountState>(EXCHANGES.map(exchange=>[exchange,{freeUsd:1000,equityUsd:1000,positions:[]}]));
  const failed=new Set<ExchangeId>(),reads:ExchangeId[]=[],forbidden:string[]=[];
  const forbid=(name:string)=>async():Promise<never>=>{forbidden.push(name);throw new Error(`Offline forbidden ${name}`);};
  const adapterFactory=(current:AppConfig):ExchangeAdapter[]=>current.exchanges.map(id=>({id,
    fetchAccount:async()=>{reads.push(id);if(failed.has(id))throw new Error('Offline unavailable account');return accounts.get(id)!;},
    fetchSnapshots:forbid('snapshots'),fetchFundingPayments:forbid('funding'),close:async()=>{},
    inspectTrading:forbid('contract'),prepareTrading:forbid('preparation'),placeOrder:forbid('order'),cancelOrder:forbid('cancel'),
    reconcileOrder:forbid('reconcile'),fetchOpenOrders:forbid('open-orders'),fetchTradingFee:forbid('fee'),
  }));
  const engine=new Engine(store,false,{liveEnvironment:env,adapterFactory,privateReadDeadlineMs});
  return {engine,store,env,accounts,failed,reads,forbidden,
    cleanup:async()=>{await engine.stop();const target=resolve(directory);assert.equal(dirname(target),resolve(tmpdir()));
      assert.ok(basename(target).startsWith('funding-live-authorization-'));rmSync(target,{recursive:true,force:true});}};
}
const scope=(engine:Engine)=>engine.liveReadiness().exchanges.filter(row=>row.executionAuthorized).map(row=>row.exchange).sort();
const financialState=(store:Store)=>JSON.stringify({config:store.data.config,positions:store.data.positions,orders:store.data.orders,
  killSwitch:store.data.killSwitch,fundingSeen:store.data.fundingSeen,manualEntryOperations:store.data.manualEntryOperations});
function position(id:string,status:Position['status']):Position{return {id,base:id==='managed'?'SAND':'ONE',mode:'live',status,
  entryPolicy:'aligned',long:{exchange:'bitget',symbol:'SAND/USDT:USDT',side:'long',quantity:1261,entryPrice:.1,markPrice:.11,feesUsd:.05,liquidationDistancePct:null},
  short:{exchange:'bybit',symbol:'SAND/USDT:USDT',side:'short',quantity:1261,entryPrice:.101,markPrice:.11,feesUsd:.06,liquidationDistancePct:400},
  openedAt:Date.now()-60000,plannedExitAt:Date.now()+60000,holdMode:'adaptive',fundingUsd:.5,feesUsd:.11,transferCostUsd:0,
  spreadPnlUsd:1,realizedSpreadPnlUsd:0,netPnlUsd:1.39,deltaUsd:0,fundingEvents:['offline-receipt'],riskReasons:status==='attention'?['paused manager']:[]};}

test('account authorization requires its explicit acknowledgement before any account read',async()=>{
  const f=fixture();try{await assert.rejects(f.engine.authorizeLiveAccounts(''),/本机/);assert.deepEqual(f.reads,[]);
    assert.deepEqual(scope(f.engine),[]);assert.equal(f.engine.liveUnlocked,false);assert.deepEqual(f.forbidden,[]);
  }finally{await f.cleanup();}
});

test('five venue recheck grants only the three configured valid accounts and never enables automatic entries',async()=>{
  const f=fixture();try{const report=await f.engine.authorizeLiveAccounts(acknowledgement);
    assert.deepEqual([...f.reads].sort(),['bitget','bybit','gate']);assert.deepEqual(report.authorizedExchanges,['bybit','gate','bitget']);
    assert.deepEqual(scope(f.engine),['bitget','bybit','gate']);assert.equal(f.engine.liveUnlocked,true);assert.equal(f.engine.autoEnabled,false);
    assert.equal(report.autoEnabled,false);assert.equal(report.accounts.length,5);
    for(const exchange of ['binance','okx']){const row=report.accounts.find(item=>item.exchange===exchange)!;
      assert.equal(row.status,'not_configured');assert.equal(row.executionAuthorized,false);assert.equal(row.credentialsConfigured,false);}
    assert.deepEqual(f.forbidden,[]);assert.equal(f.store.data.orders.length,0);
  }finally{await f.cleanup();}
});

test('configured but disabled venue is reported without being read or authorized',async()=>{
  const f=fixture(['bitget','bybit']);try{const report=await f.engine.authorizeLiveAccounts(acknowledgement),gate=report.accounts.find(row=>row.exchange==='gate')!;
    assert.equal(gate.credentialsConfigured,true);assert.equal(gate.status,'disabled');assert.equal(gate.executionAuthorized,false);
    assert.deepEqual([...f.reads].sort(),['bitget','bybit']);assert.deepEqual(scope(f.engine),['bitget','bybit']);assert.deepEqual(f.forbidden,[]);
  }finally{await f.cleanup();}
});

test('a valid single account with insufficient entry principal can authorize reductions without canStart',async()=>{
  const f=fixture(['gate']);try{f.accounts.get('gate')!.freeUsd=0;
    const preflight=await f.engine.tradingPreflight();assert.equal(preflight.canStart,false);assert.equal(f.engine.liveUnlocked,false);
    const report=await f.engine.authorizeLiveAccounts(acknowledgement),gate=report.accounts.find(row=>row.exchange==='gate')!;
    assert.equal(gate.status,'insufficient');assert.equal(gate.freeUsd,0);assert.equal(gate.executionAuthorized,true);
    assert.deepEqual(scope(f.engine),['gate']);assert.equal(f.engine.liveUnlocked,true);assert.equal(f.engine.liveReadiness().ready,false);
    assert.equal(f.engine.autoEnabled,false);assert.deepEqual(f.forbidden,[]);
  }finally{await f.cleanup();}
});

test('temporary account failure preserves prior permission while preventing stale entry-account readiness',async()=>{
  const f=fixture();try{await f.engine.authorizeLiveAccounts(acknowledgement);f.failed.add('gate');
    const report=await f.engine.authorizeLiveAccounts(acknowledgement),gate=report.accounts.find(row=>row.exchange==='gate')!;
    assert.equal(gate.status,'error');assert.equal(gate.executionAuthorized,true);assert.deepEqual(scope(f.engine),['bitget','bybit','gate']);
    assert.equal(f.engine.accounts.has('gate'),false);assert.equal(f.engine.health.find(row=>row.exchange==='gate')!.accountStatus,'error');
    assert.equal(f.engine.autoEnabled,false);assert.deepEqual(f.forbidden,[]);
  }finally{await f.cleanup();}
});

test('a failed new account is excluded while existing two-venue authorization is extended only after success',async()=>{
  const f=fixture();try{f.failed.add('gate');const first=await f.engine.authorizeLiveAccounts(acknowledgement);
    assert.deepEqual(scope(f.engine),['bitget','bybit']);assert.equal(first.accounts.find(row=>row.exchange==='gate')!.executionAuthorized,false);
    f.failed.delete('gate');const second=await f.engine.authorizeLiveAccounts(acknowledgement);
    assert.deepEqual(scope(f.engine),['bitget','bybit','gate']);assert.equal(second.accounts.find(row=>row.exchange==='gate')!.executionAuthorized,true);
    assert.deepEqual(f.forbidden,[]);
  }finally{await f.cleanup();}
});

test('authorization leaves existing manager partition, cash records, policy, orders, kill and auto values unchanged',async()=>{
  for(const autoEnabled of [false,true]){const f=fixture();try{
    f.store.data.positions.push(position('managed','open'),position('paused','attention'));f.store.data.killSwitch=true;
    f.store.data.orders.push({positionId:'paused',exchange:'gate',createdAt:Date.now(),request:{clientOrderId:'offline-unknown',base:'ONE',
      symbol:'ONE/USDT:USDT',side:'buy',quantity:1,limitPrice:.01,reduceOnly:false}});
    f.store.data.fundingSeen.push('offline-receipt');f.engine.autoEnabled=autoEnabled;
    const before=financialState(f.store),report=await f.engine.authorizeLiveAccounts(acknowledgement);
    assert.equal(financialState(f.store),before);assert.equal(f.engine.autoEnabled,autoEnabled);assert.equal(report.autoEnabled,autoEnabled);
    assert.equal(f.store.data.positions[0].status,'open');assert.equal(f.store.data.positions[1].status,'attention');assert.deepEqual(f.forbidden,[]);
  }finally{await f.cleanup();}}
});

test('all reads failing grants no new session and leaves financial state intact',async()=>{
  const f=fixture();try{for(const exchange of ['gate','bitget','bybit'] as const)f.failed.add(exchange);
    const before=financialState(f.store),report=await f.engine.authorizeLiveAccounts(acknowledgement);
    assert.deepEqual(report.authorizedExchanges,[]);assert.equal(f.engine.liveUnlocked,false);assert.equal(financialState(f.store),before);
    assert(report.accounts.filter(row=>row.credentialsConfigured).every(row=>row.status==='error'&&!row.executionAuthorized));assert.deepEqual(f.forbidden,[]);
  }finally{await f.cleanup();}
});

test('invalid account balance or occupied-position quantity cannot grant the new venue',async()=>{
  for(const invalid of ['balance','quantity','positions'] as const){const f=fixture();try{
    const account=f.accounts.get('gate')!;
    if(invalid==='balance')account.freeUsd=NaN;
    else if(invalid==='positions')account.positions=undefined as unknown as AccountState['positions'];
    else account.positions=[{base:'CT',symbol:'CT/USDT:USDT',quantity:NaN,side:'long',markPrice:1,leverage:2,liquidationPrice:0}];
    const report=await f.engine.authorizeLiveAccounts(acknowledgement),gate=report.accounts.find(row=>row.exchange==='gate')!;
    assert.equal(gate.status,'error');assert.equal(gate.executionAuthorized,false);assert.deepEqual(scope(f.engine),['bitget','bybit']);assert.deepEqual(f.forbidden,[]);
  }finally{await f.cleanup();}}
});

test('read timeout and late successful account completion cannot add an unauthorized venue or cache its account',async()=>{
  const f=fixture([...EXCHANGES],20),pending=deferred<AccountState>();
  try{f.engine.adapter('gate').fetchAccount=()=>pending.promise;const report=await f.engine.authorizeLiveAccounts(acknowledgement);
    assert.equal(report.accounts.find(row=>row.exchange==='gate')!.status,'error');assert.deepEqual(scope(f.engine),['bitget','bybit']);
    pending.resolve(f.accounts.get('gate')!);await new Promise<void>(resolve=>setImmediate(resolve));
    assert.deepEqual(scope(f.engine),['bitget','bybit']);assert.equal(f.engine.accounts.has('gate'),false);assert.deepEqual(f.forbidden,[]);
  }finally{pending.resolve(f.accounts.get('gate')!);await f.cleanup();}
});

test('pause or kill arriving while authorization reads wait cancels the grant without financial actions',async()=>{
  for(const action of ['pause','kill']){const f=fixture(),entered=deferred<void>(),pending=deferred<AccountState>();
    try{f.engine.adapter('gate').fetchAccount=()=>{entered.resolve();return pending.promise;};
      const request=f.engine.authorizeLiveAccounts(acknowledgement),rejection=assert.rejects(request,/取消/);await entered.promise;
      if(action==='pause')await f.engine.control(action);else await assert.rejects(f.engine.control(action),/锁定/);
      pending.resolve(f.accounts.get('gate')!);await rejection;assert.equal(f.engine.liveUnlocked,false);assert.deepEqual(scope(f.engine),[]);
      assert.equal(f.engine.autoEnabled,false);assert.deepEqual(f.forbidden,[]);assert.equal(f.store.data.orders.length,0);
    }finally{pending.resolve(f.accounts.get('gate')!);await f.cleanup();}}
});

test('credential replacement arriving during reads cancels authorization and cannot publish the old account result',async()=>{
  const f=fixture(),entered=deferred<void>(),pending=deferred<AccountState>();
  try{f.engine.adapter('gate').fetchAccount=()=>{entered.resolve();return pending.promise;};
    const request=f.engine.authorizeLiveAccounts(acknowledgement),rejection=assert.rejects(request,/凭据|取消/);await entered.promise;
    let saved=false;const update=f.engine.updateCredentials(()=>{saved=true;f.env.GATE_API_KEY='replacement-offline-key';});
    await assert.rejects(f.engine.authorizeLiveAccounts(acknowledgement),/凭据正在更新/);assert.equal(saved,false);
    pending.resolve(f.accounts.get('gate')!);await rejection;await update;
    assert.equal(saved,true);assert.equal(f.engine.liveUnlocked,false);assert.equal(f.engine.accounts.size,0);assert.deepEqual(scope(f.engine),[]);
    assert.equal(f.engine.autoEnabled,false);assert.deepEqual(f.forbidden,[]);
  }finally{pending.resolve(f.accounts.get('gate')!);await f.cleanup();}
});

test('service stop arriving during account reads cancels authorization before adapters close',async()=>{
  const f=fixture(),entered=deferred<void>(),pending=deferred<AccountState>();
  try{f.engine.adapter('gate').fetchAccount=()=>{entered.resolve();return pending.promise;};
    const request=f.engine.authorizeLiveAccounts(acknowledgement),rejection=assert.rejects(request,/取消/);await entered.promise;
    const stopping=f.engine.stop();pending.resolve(f.accounts.get('gate')!);await rejection;await stopping;
    assert.equal(f.engine.liveUnlocked,false);assert.equal(f.engine.accounts.size,0);assert.deepEqual(scope(f.engine),[]);
    assert.equal(f.engine.autoEnabled,false);assert.deepEqual(f.forbidden,[]);
  }finally{pending.resolve(f.accounts.get('gate')!);await f.cleanup();}
});

test('non-live mode cannot obtain execution permission through the authorization endpoint',async()=>{
  const f=fixture();try{f.store.data.config={...f.store.data.config,mode:'paper'};
    await assert.rejects(f.engine.authorizeLiveAccounts(acknowledgement),/实盘公开行情/);
    assert.deepEqual(f.reads,[]);assert.deepEqual(scope(f.engine),[]);assert.equal(f.engine.liveUnlocked,false);assert.deepEqual(f.forbidden,[]);
  }finally{await f.cleanup();}
});

test('authorization log persistence failure cannot publish a new scope or overwrite existing manager permissions',async()=>{
  for(const existing of [false,true]){const f=fixture();const originalLog=f.store.log.bind(f.store);
    try{if(existing){f.failed.add('gate');await f.engine.authorizeLiveAccounts(acknowledgement);f.failed.delete('gate');}
      const beforeScope=scope(f.engine),beforeAccounts=[...f.engine.accounts],before=financialState(f.store);
      f.store.log=()=>{throw new Error('Offline persistence unavailable');};
      await assert.rejects(f.engine.authorizeLiveAccounts(acknowledgement),/persistence/);
      assert.deepEqual(scope(f.engine),beforeScope);assert.deepEqual([...f.engine.accounts],beforeAccounts);assert.equal(financialState(f.store),before);
      assert.equal(f.engine.autoEnabled,false);assert.deepEqual(f.forbidden,[]);
    }finally{f.store.log=originalLog;await f.cleanup();}}
});

test('read-only startup preflight still never grants a session before the separate authorization operation',async()=>{
  const f=fixture();try{const before=financialState(f.store),report=await f.engine.tradingPreflight();
    assert.equal(report.canStart,true);assert.equal(report.executionUnlocked,false);assert.equal(f.engine.liveUnlocked,false);
    assert.deepEqual(scope(f.engine),[]);assert.equal(f.engine.accounts.size,0);assert.equal(financialState(f.store),before);assert.deepEqual(f.forbidden,[]);
  }finally{await f.cleanup();}
});

test('new scope survives a stale manual-grant rollback because the independent authorization replaces its scope object',async()=>{
  const f=fixture();try{
    const priorScope=new Set<ExchangeId>(['bitget','bybit']),internal=f.engine as unknown as {
      sessionExchanges:Set<ExchangeId>;sessionLivePermission:boolean;pendingManualPermission?:{restore:()=>void};};
    internal.sessionExchanges=priorScope;internal.sessionLivePermission=true;
    const staleRestore=()=>{if(internal.sessionExchanges===priorScope){internal.sessionExchanges=new Set();internal.sessionLivePermission=false;}};
    internal.pendingManualPermission={restore:staleRestore};await f.engine.authorizeLiveAccounts(acknowledgement);staleRestore();
    assert.deepEqual(scope(f.engine),['bitget','bybit','gate']);assert.equal(f.engine.autoEnabled,false);assert.deepEqual(f.forbidden,[]);
  }finally{await f.cleanup();}
});
