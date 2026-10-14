import test from 'node:test';
import { ReadyHistory } from './ready-history.js';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {Engine} from '../src/core/engine.js';
import {Store} from '../src/core/store.js';
import {defaultConfig} from './legacy-config.js';
import type {AccountState,ExchangeAdapter,ExchangeId,Position} from '../src/shared/types.js';

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'funding-session-'));
  const config={...defaultConfig,mode:'live' as const,dataSource:'public' as const,feeOnly:true,orderNotionalUsd:100};
  const store=new Store(join(directory,'state.json'),config);
  const env={ALLOW_LIVE_TRADING:'false',LIVE_TRADING_ACK:'',GATE_API_KEY:'fixture-key',GATE_API_SECRET:'fixture-secret',BITGET_API_KEY:'fixture-key',BITGET_API_SECRET:'fixture-secret',BITGET_PASSPHRASE:'fixture-pass'};
  const engine=new Engine(store,false,{liveEnvironment:env,spreadHistory:new ReadyHistory()});
  let reads=0,writes=0;
  const accounts=new Map<ExchangeId,AccountState>([['gate',{freeUsd:1000,equityUsd:1000,positions:[]}],['bitget',{freeUsd:1000,equityUsd:1000,positions:[]}]]);
  engine.adapters=config.exchanges.map(id=>({id,fetchAccount:async()=>{reads++;const a=accounts.get(id);if(!a)throw new Error('Unconfigured account queried');return a;},
    fetchSnapshots:async()=>[],fetchFundingPayments:async()=>[],close:async()=>{},
    prepareTrading:async()=>{writes++;throw new Error('Unexpected trading preparation');},placeOrder:async()=>{writes++;throw new Error('Unexpected order');},
    cancelOrder:async()=>{writes++;throw new Error('Unexpected cancellation');},reconcileOrder:async()=>{writes++;throw new Error('Unexpected order lookup');},
  }) as ExchangeAdapter);
  return {engine,store,env,accounts,reads:()=>reads,writes:()=>writes,cleanup:async()=>{await engine.stop();const target=resolve(directory);assert.equal(dirname(target),resolve(tmpdir()));assert(basename(target).startsWith('funding-session-'));rmSync(target,{recursive:true,force:true});}};
}

test('local live preflight reads two configured accounts but never grants execution or sends a trade',async()=>{
  const f=fixture();try{
    await assert.rejects(f.engine.startLive(''),/确认/);assert.equal(f.reads(),0);
    const report=await f.engine.tradingPreflight();assert.equal(report.canStart,true);assert.equal(report.executionUnlocked,false);
    assert.equal(report.accounts.filter(a=>a.status==='ready').length,2);assert.equal(report.accounts.filter(a=>a.status==='not_configured').length,3);
    assert.equal(f.engine.liveUnlocked,false);assert.equal(f.engine.autoEnabled,false);assert.equal(f.reads(),2);assert.equal(f.writes(),0);assert.equal(f.store.data.orders.length,0);
  }finally{await f.cleanup();}
});
test('explicit local acknowledgement enables only a process session and does not submit orders during start',async()=>{
  const f=fixture();try{
    const result=await f.engine.startLive('START_LIVE_TRADING');assert.equal(result.executionUnlocked,true);assert.equal(f.engine.liveUnlocked,true);assert.equal(f.engine.autoEnabled,true);
    assert.equal(f.writes(),0);assert.equal(f.store.data.orders.length,0);assert.equal(f.env.ALLOW_LIVE_TRADING,'false');assert.equal(f.store.data.config.autoEnabled,false);
    await f.engine.control('pause');assert.equal(f.engine.autoEnabled,false);assert.equal(f.engine.liveUnlocked,true);
    await f.engine.updateConfig({feeOnly:true});assert.equal(f.engine.liveUnlocked,true);assert.equal(f.engine.autoEnabled,false);
    await f.engine.updateConfig({adaptiveConfirmations:4});assert.equal(f.engine.liveUnlocked,false);assert.equal(f.engine.autoEnabled,false);
  }finally{await f.cleanup();}
});
test('insufficient futures margin cannot activate a session even when another venue has enough',async()=>{
  const f=fixture();try{
    f.accounts.get('bitget')!.freeUsd=0;
    const report=await f.engine.tradingPreflight();assert.equal(report.canStart,false);assert.equal(report.accounts.find(a=>a.exchange==='bitget')?.status,'insufficient');
    await assert.rejects(f.engine.startLive('START_LIVE_TRADING'));assert.equal(f.engine.liveUnlocked,false);assert.equal(f.engine.autoEnabled,false);assert.equal(f.writes(),0);
  }finally{await f.cleanup();}
});
test('pause arriving during account checks cancels the pending activation',async()=>{
  const f=fixture();let release!:(a:AccountState)=>void,started!:()=>void;
  const entered=new Promise<void>(resolve=>{started=resolve;});
  try{
    const pending=new Promise<AccountState>(resolve=>{release=resolve;});f.engine.adapter('gate').fetchAccount=async()=>{started();return pending;};
    const activation=f.engine.startLive('START_LIVE_TRADING');await entered;await f.engine.control('pause');release(f.accounts.get('gate')!);
    await assert.rejects(activation,/取消/);assert.equal(f.engine.liveUnlocked,false);assert.equal(f.engine.autoEnabled,false);assert.equal(f.writes(),0);
  }finally{await f.cleanup();}
});
test('a persistence failure rolls back live session activation',async()=>{
  const f=fixture();const original=f.store.log.bind(f.store);
  try{
    f.store.log=()=>{throw new Error('Test storage unavailable');};
    await assert.rejects(f.engine.startLive('START_LIVE_TRADING'),/storage/);assert.equal(f.engine.liveUnlocked,false);assert.equal(f.engine.autoEnabled,false);assert.equal(f.writes(),0);
  }finally{f.store.log=original;await f.cleanup();}
});
test('an unconfirmed order with a known coin blocks only that coin and permits activation',async()=>{
  const f=fixture();try{
    f.store.data.orders.push({positionId:'missing',exchange:'gate',request:{clientOrderId:'pending',base:'BTC',symbol:'BTC/USDT:USDT',quantity:1,side:'buy',limitPrice:1,reduceOnly:false},createdAt:Date.now()});
    const result=await f.engine.tradingPreflight();assert.equal(result.canStart,true);assert.deepEqual(result.blockers,[]);
    assert.deepEqual(result.excludedCoins?.map(item=>item.base),['BTC']);
    await f.engine.startLive('START_LIVE_TRADING');assert.equal(f.engine.liveUnlocked,true);assert.equal(f.writes(),0);
    assert.equal(f.store.data.orders[0].result,undefined);
  }finally{await f.cleanup();}
});

test('explicit recovery restores position management with zero free margin and keeps automatic entry disabled',async()=>{
  const f=fixture();try{
    const position:Position={id:'recovered',base:'BTC',status:'attention',mode:'live',feeOnly:true,
      long:{exchange:'gate',symbol:'BTC/USDT:USDT',side:'long',quantity:1,entryPrice:100,markPrice:100,feesUsd:0,liquidationDistancePct:null},
      short:{exchange:'bitget',symbol:'BTC/USDT:USDT',side:'short',quantity:1,entryPrice:100,markPrice:100,feesUsd:0,liquidationDistancePct:null},
      openedAt:Date.now()-60000,plannedExitAt:Date.now()+60000,holdMode:'adaptive',fundingUsd:0,feesUsd:0,transferCostUsd:0,spreadPnlUsd:0,realizedSpreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[]};
    f.store.data.positions.push(position);f.store.data.killSwitch=true;
    for(const [exchange,account] of f.accounts){account.freeUsd=0;account.positions=[{base:'BTC',symbol:'BTC/USDT:USDT',side:exchange==='gate'?'long':'short',quantity:1,markPrice:100,leverage:2,liquidationPrice:50}];}
    await assert.rejects(f.engine.recoverLive(''),/确认/);assert.equal(f.reads(),0);
    const report=await f.engine.tradingPreflight();assert.equal(report.canStart,false);assert.equal(report.canRecover,true);assert.equal(f.engine.liveUnlocked,false);
    const recovered=await f.engine.recoverLive('RESTORE_LIVE_MANAGEMENT');assert.equal(recovered.executionUnlocked,true);
    assert.equal(f.engine.autoEnabled,false);assert.equal(f.store.data.killSwitch,true);assert.equal(position.status,'attention');assert.equal(f.writes(),0);
    assert.equal(f.store.data.orders.length,0);assert.equal(f.env.ALLOW_LIVE_TRADING,'false');
  }finally{await f.cleanup();}
});

test('recovery without local positions or unresolved orders cannot grant a session',async()=>{
  const f=fixture();try{
    await assert.rejects(f.engine.recoverLive('RESTORE_LIVE_MANAGEMENT'),/没有可恢复/);assert.equal(f.engine.liveUnlocked,false);assert.equal(f.engine.autoEnabled,false);assert.equal(f.writes(),0);
  }finally{await f.cleanup();}
});

test('explicit start can clear an old stop only after confirming empty local and exchange accounts',async()=>{
  const f=fixture();try{
    f.store.data.killSwitch=true;
    const report=await f.engine.tradingPreflight();assert.equal(report.canStart,true);assert.equal(f.store.data.killSwitch,true);assert.equal(f.engine.liveUnlocked,false);
    await f.engine.startLive('START_LIVE_TRADING');assert.equal(f.store.data.killSwitch,false);assert.equal(f.engine.autoEnabled,true);assert.equal(f.writes(),0);
  }finally{await f.cleanup();}
});
