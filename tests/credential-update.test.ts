import test from 'node:test';
import { ReadyHistory } from './ready-history.js';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {Engine} from '../src/core/engine.js';
import {Store} from '../src/core/store.js';
import {defaultConfig} from './legacy-config.js';
import type {AccountState,AppConfig,ExchangeAdapter,ExchangeId,OrderResult,Position} from '../src/shared/types.js';

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
function fixture(environmentPermission=false,exchanges:ExchangeId[]=['gate','bitget']){
  const directory=mkdtempSync(join(tmpdir(),'funding-credentials-'));
  const config:AppConfig={...defaultConfig,mode:'live',dataSource:'public',feeOnly:true,dualAdvantageEnabled:true,hedgeMode:'base',orderNotionalUsd:100,exchanges};
  const env={ALLOW_LIVE_TRADING:environmentPermission?'true':'false',LIVE_TRADING_ACK:environmentPermission?'I_UNDERSTAND_THE_RISKS':'',
    GATE_API_KEY:'offline-key',GATE_API_SECRET:'offline-secret',BITGET_API_KEY:'offline-key',BITGET_API_SECRET:'offline-secret',BITGET_PASSPHRASE:'offline-pass',BYBIT_API_KEY:'offline-key',BYBIT_API_SECRET:'offline-secret'};
  const store=new Store(join(directory,'state.json'),config);
  const accounts=new Map<ExchangeId,AccountState>(config.exchanges.map(id=>[id,{freeUsd:1000,equityUsd:1000,positions:[]}]));
  let reads=0,writes=0,created=0,closed=0,failFactory=false;
  const adapterFactory=(config:AppConfig):ExchangeAdapter[]=>{
    created++;if(failFactory)throw new Error('Offline adapter construction failure');
    return config.exchanges.map(id=>({id,fetchAccount:async()=>{reads++;return accounts.get(id)!;},fetchSnapshots:async()=>[],fetchFundingPayments:async()=>[],
      close:async()=>{closed++;},prepareTrading:async()=>{writes++;throw new Error('Unexpected private write');},
      placeOrder:async()=>{writes++;throw new Error('Unexpected order');},cancelOrder:async()=>{writes++;throw new Error('Unexpected cancel');},
      reconcileOrder:async()=>{writes++;throw new Error('Unexpected reconcile');}}));
  };
  const engine=new Engine(store,environmentPermission,{liveEnvironment:env,adapterFactory,spreadHistory:new ReadyHistory()});
  return {engine,store,env,accounts,reads:()=>reads,writes:()=>writes,created:()=>created,closed:()=>closed,failFactory:()=>{failFactory=true;},
    cleanup:async()=>{await engine.stop();const target=resolve(directory);assert.equal(dirname(target),resolve(tmpdir()));
      assert.ok(basename(target).startsWith('funding-credentials-'));rmSync(target,{recursive:true,force:true});}};
}
const pendingOrder=()=>({positionId:'offline-position',exchange:'gate' as const,createdAt:Date.now(),
  request:{clientOrderId:'offline-request',base:'BTC',symbol:'BTC/USDT:USDT',side:'buy' as const,quantity:1,limitPrice:1,reduceOnly:false}});
const localPosition=():Position=>({id:'offline-position',base:'BTC',mode:'live',status:'attention',feeOnly:true,
  long:{exchange:'gate',symbol:'BTC/USDT:USDT',side:'long',quantity:1,entryPrice:100,markPrice:100,feesUsd:.05,liquidationDistancePct:40},
  short:{exchange:'bitget',symbol:'BTC/USDT:USDT',side:'short',quantity:1,entryPrice:101,markPrice:100,feesUsd:.06,liquidationDistancePct:40},
  openedAt:Date.now()-60000,plannedExitAt:Date.now()+60000,holdMode:'adaptive',fundingUsd:.5,feesUsd:.11,transferCostUsd:0,
  spreadPnlUsd:1,realizedSpreadPnlUsd:0,netPnlUsd:1.39,deltaUsd:0,fundingEvents:['fixture-funding'],riskReasons:['fixture unresolved record']});

test('paused live session can atomically save credentials, rebuild clients and require explicit restart without process restart',async()=>{
  const f=fixture();try{
    await f.engine.startLive('START_LIVE_TRADING');await f.engine.control('pause');assert.equal(f.engine.liveUnlocked,true);
    const old=f.engine.adapters;f.engine.accounts.set('gate',f.accounts.get('gate')!);
    let saved=0;const result=await f.engine.updateCredentials(()=>{
      saved++;assert.equal(f.engine.liveUnlocked,false);assert.equal(f.engine.autoEnabled,false);assert.equal(f.engine.accounts.size,0);
      f.env.GATE_API_KEY='new-offline-key';return {status:'unchecked'};
    });
    assert.deepEqual(result,{status:'unchecked'});assert.equal(saved,1);assert.equal(f.created(),2);assert.equal(f.closed(),2);
    assert.notEqual(f.engine.adapters,old);assert.equal(f.engine.liveUnlocked,false);assert.equal(f.engine.accounts.size,0);
    assert.ok(f.engine.health.every(h=>h.status==='connecting'&&h.balanceUsd===undefined));
    await assert.rejects(f.engine.control('startAuto'),/锁定/);
    await f.engine.startLive('START_LIVE_TRADING');assert.equal(f.engine.liveUnlocked,true);assert.equal(f.engine.autoEnabled,true);
    assert.equal(f.writes(),0);assert.equal(f.store.data.orders.length,0);
  }finally{await f.cleanup();}
});

test('credential save revokes static environment permission across ticks and config changes until explicit start',async()=>{
  const f=fixture(true);try{
    assert.equal(f.engine.liveUnlocked,true);f.engine.autoEnabled=true;
    await f.engine.updateCredentials(()=>{});assert.equal(f.engine.liveUnlocked,false);assert.equal(f.env.ALLOW_LIVE_TRADING,'true');
    const reads=f.reads();await f.engine.tick();assert.equal(f.reads(),reads);assert.equal(f.engine.liveUnlocked,false);
    await f.engine.updateConfig({orderNotionalUsd:120});assert.equal(f.engine.liveUnlocked,false);
    assert.ok(f.engine.liveReadiness().reasons.some(reason=>reason.includes('所选两腿')&&reason.includes('自动策略尚未单独启动')));
    await f.engine.startLive('START_LIVE_TRADING');assert.equal(f.engine.liveUnlocked,true);assert.equal(f.writes(),0);
  }finally{await f.cleanup();}
});

test('client configuration changes revoke environment permission through the same helper',async()=>{
  const f=fixture(true);try{await f.engine.updateConfig({bitgetNewSymbolMarginMode:'crossed'});assert.equal(f.engine.liveUnlocked,false);assert.equal(f.engine.autoEnabled,false);}
  finally{await f.cleanup();}
});

test('save or adapter rebuild failure leaves all cached accounts cleared and execution locked',async()=>{
  for(const failure of ['save','rebuild']){
    const f=fixture(true);try{
      f.engine.accounts.set('gate',f.accounts.get('gate')!);f.engine.autoEnabled=true;
      if(failure==='rebuild')f.failFactory();
      await assert.rejects(f.engine.updateCredentials(()=>{if(failure==='save')throw new Error('Offline save failure');}),/Offline/);
      assert.equal(f.engine.liveUnlocked,false);assert.equal(f.engine.autoEnabled,false);assert.equal(f.engine.accounts.size,0);
      assert.equal(f.engine.totals().availableBalanceUsd,null);await assert.rejects(f.engine.open('unused'),/锁定/);assert.equal(f.writes(),0);
      if(failure==='rebuild'){
        assert.deepEqual(f.engine.adapters,[]);const reads=f.reads();
        await assert.rejects(f.engine.startLive('START_LIVE_TRADING'),/至少需要两家/);assert.equal(f.reads(),reads);
        assert.equal(f.engine.liveUnlocked,false);
      }
    }finally{await f.cleanup();}
  }
});

test('read-only account-card precheck runs inside the queue before revocation and preserves management for known external positions',async()=>{
  const f=fixture(true);try{
    let saveCalled=false;f.engine.autoEnabled=true;
    await assert.rejects(f.engine.updateCredentials(()=>{saveCalled=true;},()=>{
      assert.equal(f.engine.liveUnlocked,true);throw new Error('Offline known external position');
    }),/known external position/);
    assert.equal(saveCalled,false);assert.equal(f.engine.liveUnlocked,true);assert.equal(f.engine.autoEnabled,true);assert.equal(f.created(),1);
  }finally{await f.cleanup();}
});

test('active local positions or unconfirmed journals prevent saving while preserving existing management permission',async()=>{
  for(const blocked of ['position','pending','unknown','nonterminal','account']){
    const f=fixture(true);try{
      f.engine.autoEnabled=true;
      if(blocked==='position')f.store.data.positions.push({status:'open'} as Position);
      else if(blocked==='account')f.engine.accounts.set('gate',{freeUsd:100,equityUsd:100,positions:[{base:'BTC',symbol:'BTC/USDT:USDT',side:'long',quantity:1,markPrice:1,leverage:2,liquidationPrice:0}]});
      else f.store.data.orders.push({...pendingOrder(),...(blocked==='pending'?{}:{result:{status:blocked==='unknown'?'unknown':'new'} as OrderResult})});
      let saved=false;await assert.rejects(f.engine.updateCredentials(()=>{saved=true;}),/持仓|订单/);
      assert.equal(saved,false);assert.equal(f.created(),1);assert.equal(f.engine.liveUnlocked,true);assert.equal(f.engine.autoEnabled,true);assert.equal(f.writes(),0);
    }finally{await f.cleanup();}
  }
});

test('credentials arriving during start or preflight cancel the old result and cannot publish its account cache',async()=>{
  for(const operation of ['start','preflight']){
    const f=fixture(),entered=deferred<void>(),read=deferred<AccountState>();
    try{
      f.engine.adapter('gate').fetchAccount=async()=>{entered.resolve();return read.promise;};
      const request=operation==='start'?f.engine.startLive('START_LIVE_TRADING'):f.engine.tradingPreflight();
      const cancelled=assert.rejects(request,/取消/);await entered.promise;
      let saved=false;const update=f.engine.updateCredentials(()=>{saved=true;});assert.equal(saved,false);
      await assert.rejects(f.engine.startLive('START_LIVE_TRADING'),/凭据正在更新/);
      await assert.rejects(f.engine.recoverLive('RESTORE_LIVE_MANAGEMENT'),/凭据正在更新/);
      await assert.rejects(f.engine.tradingPreflight(),/凭据正在更新/);
      read.resolve(f.accounts.get('gate')!);await cancelled;await update;
      assert.equal(saved,true);assert.equal(f.engine.liveUnlocked,false);assert.equal(f.engine.autoEnabled,false);assert.equal(f.engine.accounts.size,0);assert.equal(f.writes(),0);
    }finally{read.resolve(f.accounts.get('gate')!);await f.cleanup();}
  }
});

test('saving waits for in-flight execution and checks newly created unresolved orders before replacing credentials',async()=>{
  const f=fixture(true),entered=deferred<void>(),release=deferred<void>();
  try{
    const executing=f.engine.exclusive(async()=>{entered.resolve();await release.promise;f.store.data.orders.push(pendingOrder());});
    await entered.promise;let saved=false;const updating=f.engine.updateCredentials(()=>{saved=true;});
    const rejected=assert.rejects(updating,/未确认订单/);assert.equal(saved,false);release.resolve();await executing;await rejected;
    assert.equal(saved,false);assert.equal(f.engine.liveUnlocked,true);assert.equal(f.writes(),0);
  }finally{release.resolve();await f.cleanup();}
});

test('an in-progress save rejects simultaneous start and second save and never reactivates on failure',async()=>{
  const f=fixture(true),entered=deferred<void>(),release=deferred<void>();
  try{
    const updating=f.engine.updateCredentials(async()=>{entered.resolve();await release.promise;throw new Error('Offline interrupted save');});
    const rejected=assert.rejects(updating,/interrupted save/);await entered.promise;
    assert.equal(f.engine.liveUnlocked,false);await assert.rejects(f.engine.startLive('START_LIVE_TRADING'),/凭据正在更新/);
    await assert.rejects(f.engine.control('startAuto'),/凭据正在更新/);
    await assert.rejects(f.engine.updateCredentials(()=>{}),/凭据正在更新/);release.resolve();await rejected;
    assert.equal(f.engine.liveUnlocked,false);assert.equal(f.engine.autoEnabled,false);assert.equal(f.writes(),0);
  }finally{release.resolve();await f.cleanup();}
});

test('adding credentials for an idle venue keeps other accounts and unresolved positions intact',async()=>{
  const f=fixture(false,['gate','bitget','bybit']);try{
    await f.engine.startLive('START_LIVE_TRADING');
    const position=localPosition(),order=pendingOrder();f.store.data.positions.push(position);f.store.data.orders.push(order);
    const gate=f.engine.adapter('gate'),bitget=f.engine.adapter('bitget'),bybit=f.engine.adapter('bybit'),gateAccount=f.engine.accounts.get('gate');
    const records=JSON.stringify({position,order});let saved=0;
    await f.engine.updateCredentials(()=>{saved++;f.env.BYBIT_API_KEY='new-offline-key';},undefined,'bybit');
    assert.equal(saved,1);assert.equal(f.closed(),1);assert.equal(f.created(),2);
    assert.equal(f.engine.adapter('gate'),gate);assert.equal(f.engine.adapter('bitget'),bitget);assert.notEqual(f.engine.adapter('bybit'),bybit);
    assert.equal(f.engine.accounts.get('gate'),gateAccount);assert.equal(f.engine.accounts.has('bybit'),false);
    assert.equal(JSON.stringify({position,order}),records);assert.equal(f.engine.liveUnlocked,true);assert.equal(f.engine.autoEnabled,false);assert.equal(f.writes(),0);
  }finally{await f.cleanup();}
});

test('an external holding on another venue does not block target-only credential updates',async()=>{
  const f=fixture(false,['gate','bitget','bybit']);try{
    f.accounts.get('gate')!.positions=[{base:'ETH',symbol:'ETH/USDT:USDT',side:'long',quantity:1,markPrice:100,leverage:2,liquidationPrice:40}];
    await f.engine.startLive('START_LIVE_TRADING');const gateAccount=f.engine.accounts.get('gate');
    await f.engine.updateCredentials(()=>{},undefined,'bybit');assert.equal(f.engine.accounts.get('gate'),gateAccount);assert.equal(f.engine.liveUnlocked,true);assert.equal(f.writes(),0);
  }finally{await f.cleanup();}
});

test('a held target account is protected without pausing or replacing other clients',async()=>{
  const f=fixture(false,['gate','bitget','bybit']);try{
    await f.engine.startLive('START_LIVE_TRADING');f.store.data.positions.push(localPosition());
    const adapters=[...f.engine.adapters];let saved=false;
    await assert.rejects(f.engine.updateCredentials(()=>{saved=true;},undefined,'gate'),/gate.*持仓/);
    assert.equal(saved,false);assert.equal(f.engine.autoEnabled,true);assert.equal(f.engine.liveUnlocked,true);assert.deepEqual(f.engine.adapters,adapters);assert.equal(f.closed(),0);assert.equal(f.writes(),0);
  }finally{await f.cleanup();}
});

test('a target unknown order or external position remains protected without changing the active session',async()=>{
  for(const kind of ['unknown','external']){
    const f=fixture(false,['gate','bitget','bybit']);try{
      await f.engine.startLive('START_LIVE_TRADING');
      if(kind==='unknown')f.store.data.orders.push({...pendingOrder(),exchange:'bybit'});
      else f.engine.accounts.get('bybit')!.positions=[{base:'ETH',symbol:'ETH/USDT:USDT',side:'long',quantity:1,markPrice:100,leverage:2,liquidationPrice:40}];
      let saved=false;await assert.rejects(f.engine.updateCredentials(()=>{saved=true;},undefined,'bybit'),/持仓|订单/);
      assert.equal(saved,false);assert.equal(f.engine.autoEnabled,true);assert.equal(f.engine.liveUnlocked,true);assert.equal(f.closed(),0);assert.equal(f.writes(),0);
    }finally{await f.cleanup();}
  }
});

test('unscoped incomplete records cannot be bypassed by naming an unrelated target venue',async()=>{
  const f=fixture(false,['gate','bitget','bybit']);try{
    await f.engine.startLive('START_LIVE_TRADING');const order=pendingOrder();delete (order.request as {base?:string}).base;f.store.data.orders.push(order);
    let saved=false;await assert.rejects(f.engine.updateCredentials(()=>{saved=true;},undefined,'bybit'),/缺少币种\/交易所/);
    assert.equal(saved,false);assert.equal(f.engine.autoEnabled,true);assert.equal(f.engine.liveUnlocked,true);assert.equal(f.writes(),0);
  }finally{await f.cleanup();}
});

test('target save or rebuild failure locks only that venue and preserves healthy management clients',async()=>{
  for(const failure of ['save','rebuild']){
    const f=fixture(false,['gate','bitget','bybit']);try{
      await f.engine.startLive('START_LIVE_TRADING');const gate=f.engine.adapter('gate'),bitget=f.engine.adapter('bitget');
      if(failure==='rebuild')f.failFactory();
      await assert.rejects(f.engine.updateCredentials(()=>{if(failure==='save')throw new Error('Offline target save failure');},undefined,'bybit'),/Offline/);
      assert.equal(f.engine.adapter('gate'),gate);assert.equal(f.engine.adapter('bitget'),bitget);assert.equal(f.engine.adapters.some(a=>a.id==='bybit'),false);
      assert.equal(f.engine.liveUnlocked,true);assert.equal(f.engine.autoEnabled,false);assert.equal(f.closed(),1);assert.equal(f.writes(),0);
    }finally{await f.cleanup();}
  }
});

test('updating one of two venues preserves remaining management permission for existing exposure',async()=>{
  const f=fixture();try{
    await f.engine.startLive('START_LIVE_TRADING');f.store.data.orders.push(pendingOrder());const gate=f.engine.adapter('gate');
    await f.engine.updateCredentials(()=>{},undefined,'bitget');
    assert.equal(f.engine.liveUnlocked,true);assert.equal(f.engine.adapter('gate'),gate);assert.equal(f.engine.autoEnabled,false);assert.equal(f.store.data.orders[0].result,undefined);assert.equal(f.writes(),0);
  }finally{await f.cleanup();}
});

test('entry thresholds can be saved with positions and unknown orders without revoking management or rebuilding clients',async()=>{
  const f=fixture();try{
    await f.engine.startLive('START_LIVE_TRADING');const position=localPosition(),order=pendingOrder();f.store.data.positions.push(position);f.store.data.orders.push(order);
    const oldAdapters=f.engine.adapters,oldAccounts=f.engine.accounts,records=JSON.stringify({position,order});
    const next=await f.engine.updateConfig({...JSON.parse(JSON.stringify(f.engine.config)),orderNotionalUsd:120,minSpreadNetUsd:.01,minCombinedNetUsd:.1});
    assert.equal(next.orderNotionalUsd,120);assert.equal(next.minSpreadNetUsd,0);assert.equal(next.minCombinedNetUsd,.1);assert.equal(f.engine.autoEnabled,false);assert.equal(f.engine.liveUnlocked,true);
    assert.equal(f.engine.adapters,oldAdapters);assert.equal(f.engine.accounts,oldAccounts);assert.equal(f.created(),1);assert.equal(f.closed(),0);
    assert.equal(JSON.stringify({position,order}),records);assert.equal(f.writes(),0);
  }finally{await f.cleanup();}
});

test('critical and invalid settings fail without pausing or changing the current session',async()=>{
  const f=fixture();try{
    await f.engine.startLive('START_LIVE_TRADING');f.store.data.positions.push(localPosition());const config=f.engine.config,adapters=f.engine.adapters;
    for(const change of [{adaptiveConfirmations:4},{leverage:3},{takerFees:{...config.takerFees,gate:.0006}},{orderNotionalUsd:-1}]){
      await assert.rejects(f.engine.updateConfig(change));assert.equal(f.engine.config,config);assert.equal(f.engine.adapters,adapters);assert.equal(f.engine.autoEnabled,true);assert.equal(f.engine.liveUnlocked,true);
    }
    assert.equal(f.writes(),0);
  }finally{await f.cleanup();}
});

test('unchanged settings do not interrupt a session and failed entry-setting persistence rolls back',async()=>{
  const f=fixture();const save=f.store.save.bind(f.store);try{
    await f.engine.startLive('START_LIVE_TRADING');const config=f.engine.config,adapters=f.engine.adapters;
    await f.engine.updateConfig(JSON.parse(JSON.stringify(config)));assert.equal(f.engine.autoEnabled,true);assert.equal(f.engine.liveUnlocked,true);assert.equal(f.engine.config,config);assert.equal(f.engine.adapters,adapters);
    f.store.save=()=>{throw new Error('Offline settings disk failure');};
    await assert.rejects(f.engine.updateConfig({minCombinedNetUsd:.1}),/disk failure/);
    assert.equal(f.engine.config,config);assert.equal(f.engine.autoEnabled,true);assert.equal(f.engine.liveUnlocked,true);assert.equal(f.engine.adapters,adapters);assert.equal(f.writes(),0);
  }finally{f.store.save=save;await f.cleanup();}
});

test('queued settings from the same baseline cannot overwrite an earlier accepted update',async()=>{
  const f=fixture(true);try{
    const baseline=structuredClone(f.engine.config),adapters=f.engine.adapters;
    const [first,second]=await Promise.allSettled([
      f.engine.updateConfig({minCombinedNetUsd:.2},baseline),
      f.engine.updateConfig({...baseline,orderNotionalUsd:120},baseline),
    ]);
    assert.equal(first.status,'fulfilled');assert.equal(second.status,'rejected');
    if(second.status==='rejected'){assert.equal(second.reason.code,'CONFIG_CONFLICT');assert.match(second.reason.message,/其他页面更新/);}
    assert.equal(f.engine.config.minCombinedNetUsd,.2);assert.equal(f.engine.config.orderNotionalUsd,baseline.orderNotionalUsd);
    assert.equal(f.engine.adapters,adapters);assert.equal(f.engine.liveUnlocked,true);assert.equal(f.closed(),0);assert.equal(f.writes(),0);
    assert.deepEqual(f.store.data.positions,[]);assert.deepEqual(f.store.data.orders,[]);
    const accepted=structuredClone(f.engine.config);
    await f.engine.updateConfig({orderNotionalUsd:120},accepted);assert.equal(f.engine.config.orderNotionalUsd,120);
  }finally{await f.cleanup();}
});

test('expected settings ignore object key order but a stale conflict cannot pause or revoke the current session',async()=>{
  const f=fixture(true);try{
    const baseline=structuredClone(f.engine.config),reordered=Object.fromEntries(Object.entries(baseline).reverse()) as AppConfig;
    reordered.takerFees=Object.fromEntries(Object.entries(baseline.takerFees).reverse()) as AppConfig['takerFees'];
    await f.engine.updateConfig({},reordered);const current=f.engine.config;
    f.engine.autoEnabled=true;
    const stale={...baseline,orderNotionalUsd:baseline.orderNotionalUsd+1};
    await assert.rejects(f.engine.updateConfig({minCombinedNetUsd:.3},stale),{code:'CONFIG_CONFLICT'});
    assert.equal(f.engine.config,current);assert.equal(f.engine.autoEnabled,true);assert.equal(f.engine.liveUnlocked,true);
    assert.equal(f.created(),1);assert.equal(f.closed(),0);assert.equal(f.writes(),0);
  }finally{await f.cleanup();}
});

test('account-confirmed historical exposure and unknown orders allow credential saves without rewriting the journal',async()=>{
  for(const target of [undefined,'gate'] as const){
    const f=fixture();try{
      const position=localPosition(),order=pendingOrder();
      position.accountClosure={confirmedAt:order.createdAt+1,reason:'Both current accounts confirmed flat',historicalOrdersPending:true};
      f.store.data.positions.push(position);f.store.data.orders.push(order);
      const before=JSON.stringify({position,order});let saved=false;
      await f.engine.updateCredentials(()=>{saved=true;},undefined,target);
      assert.equal(saved,true);assert.equal(JSON.stringify({position,order}),before);assert.equal(f.writes(),0);
    }finally{await f.cleanup();}
  }
});

test('new account exposure still prevents credential saves when an older local record was archived',async()=>{
  const f=fixture();try{
    const position=localPosition(),order=pendingOrder();
    position.accountClosure={confirmedAt:order.createdAt+1,reason:'Old flat account proof',historicalOrdersPending:true};
    f.store.data.positions.push(position);f.store.data.orders.push(order);
    f.engine.accounts.set('gate',{freeUsd:100,equityUsd:100,positions:[{base:'BTC',symbol:'BTC/USDT:USDT',side:'long',quantity:1,markPrice:100,leverage:2,liquidationPrice:0}]});
    let saved=false;await assert.rejects(f.engine.updateCredentials(()=>{saved=true;},undefined,'gate'),/账户仍有持仓/);
    assert.equal(saved,false);assert.equal(f.writes(),0);
  }finally{await f.cleanup();}
});
