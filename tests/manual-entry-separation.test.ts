import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Engine} from '../src/core/engine.js';
import {Store} from '../src/core/store.js';
import {defaultConfig} from '../src/shared/config.js';
import type {AccountPosition,ExchangeAdapter,ExchangeId,LivePortfolio,MarketSnapshot,Position} from '../src/shared/types.js';

function quote(exchange:ExchangeId,base='CT'):MarketSnapshot{
  const now=Date.now(),price=exchange==='bybit'?.501:.5;
  return {exchange,base,symbol:`${base}/USDT:USDT`,timestamp:now,observedAt:now,source:'public',markPrice:price,indexPrice:.5,
    fundingRate:exchange==='bybit'?.001:0,nextFundingTime:now+3_600_000,intervalHours:8,fundingHistory:[],
    bids:[{price:price-.00001,quantity:100_000}],asks:[{price:price+.00001,quantity:100_000}],openInterestUsd:1e8,volume24hUsd:1e8,
    quantityStep:1,minQuantity:1,minNotional:1,contractSize:1};
}
function deferred(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
function fixture(){
  const directory=mkdtempSync(path.join(tmpdir(),'manual-separation-')),events:string[]=[],requests=new Map<ExchangeId,string[][]>();
  const exchanges:ExchangeId[]=['gate','bybit','bitget'];
  const config={...defaultConfig,mode:'live' as const,dataSource:'public' as const,entryPolicy:'aligned' as const,exchanges,symbols:['CT'],orderNotionalUsd:100,minEntryIocEdgeBps:0};
  const store=new Store(path.join(directory,'state.json'),config),nativePositions=new Map<ExchangeId,AccountPosition[]>(exchanges.map(exchange=>[exchange,[]]));
  const adapters:ExchangeAdapter[]=exchanges.map(id=>{
    const feeCache=new Map<string,{takerFeeRate:number;takerFeeAt:number;takerFeeSource:'exchange'}>();
    return {id,
    fetchAccount:async()=>{events.push(`GET-account:${id}`);return {freeUsd:1000,equityUsd:1000,positions:nativePositions.get(id)!};},
    inspectTrading:async(symbol)=>{events.push(`GET-contract:${id}:${symbol}`);},
    fetchSnapshots:async bases=>{requests.set(id,[...(requests.get(id)??[]),[...bases]]);return bases.map(base=>quote(id,base));},
    fetchTradingFee:async symbol=>{events.push(`GET-fee:${id}:${symbol}`);const fee={takerFeeRate:id==='bybit'?.0011:.0005,takerFeeAt:Date.now(),takerFeeSource:'exchange' as const};feeCache.set(symbol,fee);return fee;},
    cachedTradingFee:symbol=>feeCache.get(symbol),
    fetchFundingPayments:async()=>[],close:async()=>{},prepareTrading:async()=>{events.push(`prepare:${id}`);},
    placeOrder:async()=>{throw new Error('Forbidden external financial call');},cancelOrder:async()=>{throw new Error('Forbidden external financial call');},reconcileOrder:async()=>{throw new Error('Forbidden external financial call');}};
  });
  const environment={ALLOW_LIVE_TRADING:'false',LIVE_TRADING_ACK:'',GATE_API_KEY:'fixture',GATE_API_SECRET:'fixture',BYBIT_API_KEY:'fixture',BYBIT_API_SECRET:'fixture',BITGET_API_KEY:'fixture',BITGET_API_SECRET:'fixture',BITGET_PASSPHRASE:'fixture'};
  const engine=new Engine(store,false,{adapterFactory:()=>adapters,liveEnvironment:environment});
  engine.snapshots=exchanges.map(exchange=>quote(exchange));engine.health=exchanges.map(exchange=>({exchange,status:'online',lastSuccess:Date.now(),latencyMs:0}));
  const portfolio=():LivePortfolio=>{const now=Date.now();return {timestamp:now,pollIntervalMs:5000,maxAgeMs:15000,exchanges:exchanges.map(exchange=>({exchange,credentialsConfigured:true,status:'ready',requestedAt:now,receivedAt:now,freeUsd:1000,equityUsd:1000,positions:nativePositions.get(exchange)!}))};};
  const observe=async()=>{await engine.observeAccountClosures(portfolio());await new Promise<void>(resolve=>setImmediate(resolve));};
  return {engine,store,events,adapters,nativePositions,requests,observe,cleanup:async()=>{await engine.stop();rmSync(directory,{recursive:true,force:true});}};
}
const id='CT-gate-bybit',operationId='manual-separate-ct';
function fakeSuccessfulExecution(engine:Engine){
  engine.execution.open=async(p,long,short,validate,beforeSubmit,onProgress)=>{
    await validate?.();beforeSubmit?.();onProgress?.('reconciling');p.long.quantity=long;p.short.quantity=short;p.status='open';engine.store.save();
  };
}

test('fresh market/account/contract preview is manually ready before automatic start and grants no permission',async()=>{
  const f=fixture();try{
    await f.observe();const opportunity=f.engine.currentOpportunities().find(row=>row.id===id)!;
    assert(opportunity,JSON.stringify(f.engine.currentOpportunities().map(row=>row.id)));
    assert.equal(opportunity.entryReady,true,opportunity.reasons.join('；'));assert.equal(opportunity.eligible,false);
    assert.equal(opportunity.checks!.find(check=>check.label==='两腿合约只读检查就绪')!.pass,true);
    assert.equal(f.engine.liveUnlocked,false);assert.equal(f.engine.autoEnabled,false);
    assert(f.events.some(event=>event.startsWith('GET-contract:gate:CT/')));assert(f.events.every(event=>!event.startsWith('prepare:')));
    assert.equal(f.store.data.positions.length,0);assert.equal(f.store.data.orders.length,0);
  }finally{await f.cleanup();}
});

test('one acknowledged manual click checks both legs and activates only those venues without starting automatic entries',async()=>{
  const f=fixture();try{
    await f.observe();f.events.length=0;fakeSuccessfulExecution(f.engine);
    const receipt=f.engine.requestManualEntry(id,operationId,Date.now()+30_000,'OPEN_LIVE_HEDGE');assert.equal(receipt.state,'queued');
    await f.engine.exclusive(async()=>{});
    const final=f.engine.manualEntryOperation(operationId)!;assert.equal(final.state,'completed',final.message);
    assert.equal(f.engine.autoEnabled,false);assert.equal(f.engine.liveUnlocked,true);
    assert.deepEqual(f.engine.liveReadiness().exchanges.filter(row=>row.executionAuthorized).map(row=>row.exchange),['bybit','gate']);
    const firstPrepare=f.events.findIndex(event=>event.startsWith('prepare:'));
    assert(firstPrepare>=0);for(const exchange of ['gate','bybit']){
      assert(f.events.slice(0,firstPrepare).includes(`GET-account:${exchange}`));assert(f.events.slice(0,firstPrepare).includes(`GET-contract:${exchange}:CT/USDT:USDT`));
      assert(f.events.slice(0,firstPrepare).includes(`GET-fee:${exchange}:CT/USDT:USDT`),'the explicit manual action must obtain both native fees before preparation');
    }
    assert(f.events.every(event=>!event.startsWith('GET-fee:bitget:')),'a manual action reads only its selected two contracts');
    assert.equal(f.store.data.positions.length,1);assert.equal(f.store.data.orders.length,0,'The offline executor never submits an exchange order');
  }finally{await f.cleanup();}
});

test('a pending manual read-only check can be cancelled before permission, preparation or order submission',async()=>{
  const f=fixture(),entered=deferred(),waiting=deferred();try{
    await f.observe();f.events.length=0;
    f.adapters.find(adapter=>adapter.id==='bybit')!.inspectTrading=async()=>{entered.release();await waiting.promise;};
    f.engine.requestManualEntry(id,operationId,Date.now()+30_000,'OPEN_LIVE_HEDGE');await entered.promise;
    assert.equal(f.engine.cancelManualEntry(operationId)!.state,'cancelled');waiting.release();await f.engine.exclusive(async()=>{});
    assert.equal(f.engine.liveUnlocked,false);assert.equal(f.engine.autoEnabled,false);assert.equal(f.store.data.positions.length,0);assert.equal(f.store.data.orders.length,0);
    assert(f.events.every(event=>!event.startsWith('prepare:')));
  }finally{waiting.release();await f.cleanup();}
});

test('independent venue preparations start together and neither order can submit before both finish',async()=>{
  const f=fixture(),bothStarted=deferred(),waiting=deferred();let starts=0,timer:ReturnType<typeof setTimeout>|undefined;try{
    await f.observe();fakeSuccessfulExecution(f.engine);
    for(const adapter of f.adapters)adapter.prepareTrading=async()=>{
      f.events.push(`prepare:${adapter.id}`);if(++starts===2)bothStarted.release();await waiting.promise;
    };
    f.engine.requestManualEntry(id,operationId,Date.now()+30000,'OPEN_LIVE_HEDGE');
    await Promise.race([bothStarted.promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Both venue preparations did not start concurrently')),500);})]);
    assert.equal(starts,2);assert.equal(f.engine.manualEntryOperation(operationId)!.state,'preparing');assert.equal(f.store.data.orders.length,0);assert.equal(f.store.data.positions.length,0);
    waiting.release();await f.engine.exclusive(async()=>{});
    assert.equal(f.engine.manualEntryOperation(operationId)!.state,'completed');assert.equal(f.engine.autoEnabled,false);
  }finally{if(timer)clearTimeout(timer);waiting.release();await f.cleanup();}
});

test('one preparation failure waits for the other venue to finish before releasing the queue, with zero order intents',async()=>{
  const f=fixture(),otherStarted=deferred(),waiting=deferred();try{
    await f.observe();
    f.adapters.find(adapter=>adapter.id==='gate')!.prepareTrading=async()=>{throw new Error('Offline parameter preparation rejected');};
    f.adapters.find(adapter=>adapter.id==='bybit')!.prepareTrading=async()=>{otherStarted.release();await waiting.promise;};
    f.engine.requestManualEntry(id,operationId,Date.now()+30000,'OPEN_LIVE_HEDGE');await otherStarted.promise;
    let queuedRan=false;const queued=f.engine.exclusive(async()=>{queuedRan=true;});await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(queuedRan,false);assert.equal(f.engine.manualEntryOperation(operationId)!.state,'preparing');assert.equal(f.store.data.orders.length,0);
    waiting.release();await queued;const final=f.engine.manualEntryOperation(operationId)!;
    assert.equal(final.state,'failed');assert.equal(final.ordersSubmitted,false);assert.equal(f.store.data.orders.length,0);assert.equal(f.store.data.positions.length,0);assert.equal(f.engine.liveUnlocked,false);
  }finally{waiting.release();await f.cleanup();}
});

test('no acknowledgement cannot silently enable manual execution, and an unsubmitted preparation failure restores the old scope',async()=>{
  const f=fixture();try{
    await f.observe();f.engine.requestManualEntry(id,'without-explicit-ack',Date.now()+30_000);await f.engine.exclusive(async()=>{});
    assert.equal(f.engine.liveUnlocked,false);assert.equal(f.engine.manualEntryOperation('without-explicit-ack')!.ordersSubmitted,false);
    f.adapters.find(adapter=>adapter.id==='gate')!.prepareTrading=async()=>{throw new Error('Local preparation readback rejected');};
    f.engine.requestManualEntry(id,operationId,Date.now()+30_000,'OPEN_LIVE_HEDGE');await f.engine.exclusive(async()=>{});
    const result=f.engine.manualEntryOperation(operationId)!;assert.equal(result.state,'failed');assert.equal(result.ordersSubmitted,false);
    assert.equal(f.engine.liveUnlocked,false);assert.equal(f.engine.autoEnabled,false);assert.equal(f.store.data.positions.length,0);assert.equal(f.store.data.orders.length,0);
  }finally{await f.cleanup();}
});

test('new empty contracts that are read-only preparable remain ready before their configured leverage is written',async()=>{
  const f=fixture();try{
    // Native adapters' inspectTrading reports capability; it does not require pre-existing target settings.
    for(const adapter of f.adapters)adapter.inspectTrading=async()=>{f.events.push(`capability:${adapter.id}:empty-new-contract`);};
    await f.observe();const opportunity=f.engine.currentOpportunities().find(row=>row.id===id)!;
    assert.equal(opportunity.entryReady,true);assert.equal(f.engine.liveUnlocked,false);assert(f.events.every(event=>!event.startsWith('prepare:')));
  }finally{await f.cleanup();}
});

test('a newer permission revoke while manual preparation waits cannot be undone by its stale failure cleanup',async()=>{
  const f=fixture(),entered=deferred(),waiting=deferred();try{
    await f.observe();f.adapters.find(adapter=>adapter.id==='gate')!.prepareTrading=async()=>{entered.release();await waiting.promise;};
    f.engine.requestManualEntry(id,operationId,Date.now()+30_000,'OPEN_LIVE_HEDGE');await entered.promise;
    assert.equal(f.engine.liveUnlocked,true);
    // Model the synchronous authority portion of a newer credential revoke. No credentials or orders are written.
    (f.engine as any).startGeneration++;(f.engine as any).revokeExecutionPermission();
    assert.equal(f.engine.liveUnlocked,false);waiting.release();await f.engine.exclusive(async()=>{});
    assert.equal(f.engine.liveUnlocked,false);assert.equal(f.engine.autoEnabled,false);assert.equal(f.engine.manualEntryOperation(operationId)!.ordersSubmitted,false);
    assert.equal(f.store.data.positions.length,0);assert.equal(f.store.data.orders.length,0);
  }finally{waiting.release();await f.cleanup();}
});

test('pause or kill cancels only a pending unsubmitted manual grant before advancing authority generation',async()=>{
  for(const action of ['pause','kill']){
    const f=fixture(),entered=deferred(),waiting=deferred();try{
      await f.observe();f.adapters.find(adapter=>adapter.id==='gate')!.prepareTrading=async()=>{entered.release();await waiting.promise;};
      f.engine.requestManualEntry(id,operationId,Date.now()+30_000,'OPEN_LIVE_HEDGE');await entered.promise;assert.equal(f.engine.liveUnlocked,true);
      await f.engine.control(action);assert.equal(f.engine.liveUnlocked,false);waiting.release();await f.engine.exclusive(async()=>{});
      assert.equal(f.engine.liveUnlocked,false);assert.equal(f.engine.autoEnabled,false);assert.equal(f.engine.manualEntryOperation(operationId)!.ordersSubmitted,false);
      assert.equal(f.store.data.positions.length,0);assert.equal(f.store.data.orders.length,0);
    }finally{waiting.release();await f.cleanup();}
  }
});

test('snapshot fee overlay uses fresh exact native symbol evidence without replacing the execution quote object',async t=>{
  let clock=Date.now();t.mock.method(Date,'now',()=>clock);const f=fixture();try{
    // Isolate the native position overlay; ordinary previews make no private fee discovery calls.
    for(const adapter of f.adapters){adapter.fetchTradingFee=async()=>undefined;adapter.cachedTradingFee=()=>undefined;}
    const raw=f.engine.snapshots.find(snapshot=>snapshot.exchange==='bybit')!;
    f.nativePositions.get('bybit')!.push({base:'CT',symbol:'CT/USDT:USDT',side:'short',quantity:100,markPrice:.5,liquidationPrice:0,leverage:2,
      takerFeeRate:.0011,takerFeeAt:clock,takerFeeSource:'exchange'} as AccountPosition);
    f.nativePositions.get('gate')!.push({base:'CT',symbol:'OTHER/USDT:USDT',side:'long',quantity:100,markPrice:.5,liquidationPrice:0,leverage:2,
      takerFeeRate:.009,takerFeeAt:clock,takerFeeSource:'exchange'} as AccountPosition);
    await f.observe();const exact=f.engine.snapshot('bybit','CT') as MarketSnapshot&{takerFeeRate?:number;takerFeeSource?:string};
    assert.equal(exact,raw);assert.equal(exact.takerFeeRate,.0011);assert.equal(exact.takerFeeSource,'exchange');assert.equal(f.engine.snapshot('bybit','CT'),exact);
    assert.equal((f.engine.snapshot('gate','CT') as typeof exact).takerFeeRate,undefined);
    clock+=120001;assert.equal((f.engine.snapshot('bybit','CT') as typeof exact).takerFeeRate,undefined,'stale evidence must not retain a native-fee claim');
    assert.equal(f.engine.liveUnlocked,false);assert.equal(f.store.data.orders.length,0);
  }finally{await f.cleanup();}
});

test('read-only contract previews use reference fees for new opportunities without requesting private native fees',async()=>{
  const f=fixture();try{
    await f.observe();const opportunity=f.engine.currentOpportunities().find(row=>row.id===id)!;
    assert.equal(opportunity.entryReady,true);assert.equal(opportunity.feesSource,'reference');assert(f.events.every(event=>!event.startsWith('GET-fee:')));
    assert.equal(f.engine.snapshot('bybit','CT')!.takerFeeRate,undefined);assert.equal(f.engine.snapshot('bybit','CT')!.takerFeeSource,undefined);
    assert.equal(f.engine.liveUnlocked,false);assert.equal(f.engine.autoEnabled,false);assert.equal(f.store.data.orders.length,0);
    assert(f.events.every(event=>!event.startsWith('prepare:')));
  }finally{await f.cleanup();}
});

test('official local fee references support previews when configured and native rates are absent',async()=>{
  const f=fixture();try{
    f.engine.config.takerFees={...f.engine.config.takerFees,gate:NaN,bybit:NaN,bitget:NaN};
    const before=f.engine.currentOpportunities().find(row=>row.id===id)!;
    assert.equal(before.checks!.find(check=>check.label==='两腿手续费已知')!.pass,true);assert.equal(before.feesSource,'reference');
    await f.observe();const after=f.engine.currentOpportunities().find(row=>row.id===id)!;
    assert.equal(after.entryReady,true,after.reasons.join('；'));
    assert.equal(after.feesSource,'reference');assert(f.events.every(event=>!event.startsWith('GET-fee:')));
    assert.equal(f.engine.snapshot('gate','CT')!.takerFeeSource,undefined);assert.equal(f.engine.snapshot('bybit','CT')!.takerFeeSource,undefined);
    assert.equal(f.engine.liveUnlocked,false);assert.equal(f.engine.autoEnabled,false);assert.equal(f.store.data.orders.length,0);
    assert(f.events.every(event=>!event.startsWith('prepare:')));
  }finally{await f.cleanup();}
});

test('manual account affordability uses exact native taker fees instead of a lower configured guess',async()=>{
  const f=fixture();try{
    await f.observe();f.events.length=0;fakeSuccessfulExecution(f.engine);
    f.adapters.find(adapter=>adapter.id==='bybit')!.fetchAccount=async()=>({freeUsd:50.25,equityUsd:50.25,positions:[]});
    f.engine.requestManualEntry(id,operationId,Date.now()+30000,'OPEN_LIVE_HEDGE');await f.engine.exclusive(async()=>{});
    const receipt=f.engine.manualEntryOperation(operationId)!;assert.equal(receipt.state,'failed');assert.match(receipt.message,/bybit 合约可用余额不足/);
    assert.equal(receipt.ordersSubmitted,false);assert.equal(f.engine.liveUnlocked,false);assert.equal(f.store.data.orders.length,0);
    assert(f.events.every(event=>!event.startsWith('prepare:')));
  }finally{await f.cleanup();}
});

test('cached contract previews do not refresh native fees on a timer and expired native evidence falls back to references',async t=>{
  let clock=Date.now();t.mock.method(Date,'now',()=>clock);const f=fixture();try{
    await f.observe();const initialContracts=f.events.filter(event=>event.startsWith('GET-contract:')).length;
    assert(f.events.every(event=>!event.startsWith('GET-fee:')));
    await f.engine.adapter('bybit').fetchTradingFee!('CT/USDT:USDT');
    const raw=f.engine.snapshot('bybit','CT')!;assert.equal(raw.takerFeeAt,clock);const feeAt=raw.takerFeeAt;f.events.length=0;
    clock+=61000;for(const snapshot of f.engine.snapshots){snapshot.timestamp=clock;snapshot.observedAt=clock;}
    await f.observe();
    assert.equal(initialContracts,3);assert.equal(f.events.filter(event=>event.startsWith('GET-contract:')).length,0);
    assert(f.events.every(event=>!event.startsWith('GET-fee:')));assert.equal(f.engine.snapshot('bybit','CT'),raw);
    assert.equal(raw.takerFeeAt,feeAt);assert.equal(f.engine.currentOpportunities().find(row=>row.id===id)!.entryReady,true);
    clock+=60001;for(const snapshot of f.engine.snapshots){snapshot.timestamp=clock;snapshot.observedAt=clock;}
    await f.observe();assert(f.events.every(event=>!event.startsWith('GET-fee:')));
    assert.equal(f.engine.snapshot('bybit','CT')!.takerFeeSource,undefined);assert.equal(f.engine.snapshot('bybit','CT')!.takerFeeAt,undefined);
    assert.equal(f.engine.currentOpportunities().find(row=>row.id===id)!.feesSource,'reference');
    assert.equal(f.engine.liveUnlocked,false);assert.equal(f.store.data.orders.length,0);
  }finally{await f.cleanup();}
});

test('unavailable native fees make no background retries and reference estimates cannot authorize an explicit manual action',async t=>{
  let clock=Date.now();t.mock.method(Date,'now',()=>clock);const f=fixture();try{
    f.engine.config.takerFees={...f.engine.config.takerFees,gate:NaN,bybit:NaN,bitget:NaN};
    for(const adapter of f.adapters){adapter.cachedTradingFee=()=>undefined;adapter.fetchTradingFee=async symbol=>{f.events.push(`GET-fee:${adapter.id}:${symbol}`);return undefined;};}
    await f.observe();await f.observe();assert.equal(f.events.filter(event=>event.startsWith('GET-fee:')).length,0);
    clock+=15001;for(const snapshot of f.engine.snapshots){snapshot.timestamp=clock;snapshot.observedAt=clock;}
    await f.observe();assert.equal(f.events.filter(event=>event.startsWith('GET-fee:')).length,0,'passing the native retry window cannot create a background GET');
    const opportunity=f.engine.currentOpportunities().find(row=>row.id===id)!;assert.equal(opportunity.entryReady,true);assert.equal(opportunity.feesSource,'reference');
    assert.equal(opportunity.checks!.find(check=>check.label==='两腿手续费已知')!.pass,true);
    f.engine.requestManualEntry(id,'manual-native-unavailable',clock+30000,'OPEN_LIVE_HEDGE');await f.engine.exclusive(async()=>{});
    const receipt=f.engine.manualEntryOperation('manual-native-unavailable')!;assert.equal(receipt.state,'failed');assert.match(receipt.message,/手续费/);
    assert.equal(receipt.ordersSubmitted,false);
    assert.deepEqual(f.events.filter(event=>event.startsWith('GET-fee:')).sort(),['GET-fee:bybit:CT/USDT:USDT','GET-fee:gate:CT/USDT:USDT']);
    assert(f.events.every(event=>!event.startsWith('prepare:')));assert.equal(f.store.data.positions.length,0);
    assert.equal(f.engine.snapshot('bybit','CT')!.takerFeeRate,undefined);assert.equal(f.engine.liveUnlocked,false);assert.equal(f.store.data.orders.length,0);
  }finally{await f.cleanup();}
});

test('observed external positions get priority public snapshots without reviving an archived strategy or granting management',async()=>{
  const f=fixture();try{
    f.nativePositions.get('gate')!.push({base:'ARK',symbol:'ARK/USDT:USDT',side:'long',quantity:417,markPrice:.24,liquidationPrice:0,leverage:2});
    f.nativePositions.get('bitget')!.push({base:'ARK',symbol:'ARK/USDT:USDT',side:'short',quantity:417,markPrice:.24,liquidationPrice:0,leverage:2});
    const archived:Position={id:'archived-ark',base:'ARK',status:'closed',mode:'live',openedAt:Date.now()-1e7,closedAt:Date.now()-1e6,plannedExitAt:Date.now()-1e6,holdMode:'adaptive',
      long:{exchange:'gate',symbol:'ARK/USDT:USDT',side:'long',quantity:0,entryPrice:.24,markPrice:.24,feesUsd:0,liquidationDistancePct:null},
      short:{exchange:'bitget',symbol:'ARK/USDT:USDT',side:'short',quantity:0,entryPrice:.24,markPrice:.24,feesUsd:0,liquidationDistancePct:null},
      fundingUsd:0,feesUsd:0,transferCostUsd:0,spreadPnlUsd:0,realizedSpreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[]};
    f.store.data.positions.push(archived);const original=JSON.stringify(archived);
    await f.observe();await f.engine.tick();
    assert.equal(f.requests.get('gate')![0][0],'ARK');assert.equal(f.requests.get('bitget')![0][0],'ARK');
    assert(f.engine.state().snapshots.some(snapshot=>snapshot.exchange==='gate'&&snapshot.base==='ARK'));
    assert(f.engine.state().snapshots.some(snapshot=>snapshot.exchange==='bitget'&&snapshot.base==='ARK'));
    assert.equal(JSON.stringify(archived),original);assert.equal(f.engine.liveUnlocked,false);assert.equal(f.engine.autoEnabled,false);
    assert.equal(f.store.data.orders.length,0);assert(f.events.every(event=>!event.startsWith('prepare:')));
  }finally{await f.cleanup();}
});
