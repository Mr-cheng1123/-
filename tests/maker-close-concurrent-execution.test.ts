import test from 'node:test';
import assert from 'node:assert/strict';
import {Execution} from '../src/core/execution.js';
import type {Store} from '../src/core/store.js';
import {defaultConfig} from '../src/shared/config.js';
import {rejectedOrder,OrderNotSubmittedError} from '../src/adapters/order-rejection.js';
import type {AppConfig,ExchangeAdapter,ExchangeId,JournalOrder,MakerReductionObservation,MarketSnapshot,OrderRequest,OrderResult,Position} from '../src/shared/types.js';

const NOW=1_791_620_050_000;
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};}
function fixture(){
  let config:AppConfig={...structuredClone(defaultConfig),mode:'live',dataSource:'public',entryPolicy:'aligned',holdMode:'adaptive',
    exchanges:['gate','bybit'],symbols:['MA','MB'],maxOrderRetries:0,minExitProfitBps:10,feeRebatePct:{gate:70,bitget:50}};
  const books=new Map<string,MarketSnapshot>(),positions=new Map<string,Position>(),saved:any[]=[],halts:string[]=[],
    makerPosts:OrderRequest[]=[],peerPosts:OrderRequest[]=[],peerCalls:OrderRequest[]=[],readIds:Array<{base:string;id?:string}>=[],
    releases:Array<()=>void>=[],natives=new Map<string,{request:OrderRequest;id:string;cancelled:boolean}>();
  const data={version:1 as const,config,positions:[] as Position[],orders:[] as JournalOrder[],logs:[],equity:[],killSwitch:false,fundingSeen:[]};
  let saveHook:()=>void=()=>{},unlocked=true,actions=true;
  const store={data,save(){saveHook();saved.push(structuredClone(data));},log(){}} as unknown as Store;
  for(const base of ['MA','MB']){
    const symbol=`${base}/USDT:USDT`,p:Position={id:`position-${base}`,base,mode:'live',entryPolicy:'aligned',holdMode:'adaptive',status:'open',
      openedAt:Date.now()-1_000,plannedExitAt:Date.now()+3_610_000,profitExitNotionalUsd:100,
      long:{exchange:'gate',symbol,side:'long',quantity:100,entryPrice:1,markPrice:1,feesUsd:.05,liquidationDistancePct:null},
      short:{exchange:'bybit',symbol,side:'short',quantity:100,entryPrice:1,markPrice:1,feesUsd:.05,liquidationDistancePct:null},
      fundingUsd:0,feesUsd:.1,transferCostUsd:0,realizedSpreadPnlUsd:0,spreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[],
      profitExitPolicy:{firstFundingTime:Date.now()+3_600_000,earliestExitAt:Date.now()+3_610_000,minSpreadNetUsd:0,minCombinedNetUsd:0,fundingChecks:[]}};
    data.positions.push(p);positions.set(base,p);
    for(const exchange of ['gate','bybit'] as const){
      const isLong=exchange==='gate',clientOrderId=`opening-${base}-${exchange}`;
      data.orders.push({positionId:p.id,exchange,createdAt:p.openedAt,request:{clientOrderId,base,symbol,side:isLong?'buy':'sell',quantity:100,limitPrice:1,reduceOnly:false},
        result:{id:clientOrderId,clientOrderId,status:'filled',filledQuantity:100,averagePrice:1,averagePriceVerified:true,feeUsd:.05,timestamp:p.openedAt}});
      books.set(`${exchange}:${base}`,{exchange,base,symbol,source:'public',timestamp:Date.now(),observedAt:Date.now(),fundingObservedAt:Date.now(),bookTransport:'websocket',
        markPrice:1,indexPrice:1,fundingRate:isLong?0:.001,intervalHours:8,nextFundingTime:Date.now()+3_600_000,fundingHistory:[],
        bids:[{price:isLong?1.006:.998,quantity:30}],asks:[{price:isLong?1.016:1,quantity:30}],quantityStep:1,minQuantity:1,minNotional:5,contractSize:1,
        openInterestUsd:1e6,volume24hUsd:1e6,
        takerFeeRate:.0005,takerFeeAt:Date.now(),takerFeeSource:'exchange',makerFeeRate:.0002,makerFeeAt:Date.now(),makerFeeSource:'exchange'});
    }
  }
  let makerBeforeGuard:(request:OrderRequest)=>Promise<void>=async()=>{},peerBeforeGuard:(request:OrderRequest)=>Promise<void>=async()=>{},
    inspectHook:(request:OrderRequest,id:string)=>Promise<MakerReductionObservation|undefined>=async()=>undefined,
    peerResult:(request:OrderRequest)=>OrderResult=(request)=>({id:`peer-${request.clientOrderId}`,clientOrderId:request.clientOrderId,status:'filled',
      filledQuantity:request.quantity,averagePrice:request.limitPrice,averagePriceVerified:true,feeUsd:request.quantity*request.limitPrice*.0005,timestamp:Date.now()});
  const adapters=new Map<ExchangeId,ExchangeAdapter>();
  for(const id of ['gate','bybit'] as const)adapters.set(id,{
    id,supportsMakerReduction:()=>true,fetchSnapshots:async()=>[],fetchFundingPayments:async()=>[],fetchAccount:async()=>({freeUsd:1000,equityUsd:1000,positions:[]}),
    prepareTrading:async()=>{},validateOrder:async()=>{},validateOrderLocally:async()=>{},validateMakerReduction:async()=>{},
    submitMakerReduction:async(request,canSubmit)=>{
      await makerBeforeGuard(request);
      if(canSubmit?.()===false)return rejectedOrder(request,new OrderNotSubmittedError('offline primary veto','MAKER_REDUCTION_PERMISSION_CHANGED','offline primary veto'));
      assert.equal(request.postOnly,true);assert.equal(request.reduceOnly,true);
      const nativeId=`maker-${request.clientOrderId}`;makerPosts.push({...request});natives.set(request.clientOrderId,{request,id:nativeId,cancelled:false});
      return {id:nativeId,clientOrderId:request.clientOrderId,status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now()};
    },
    inspectMakerReduction:async(request,nativeId)=>{
      const native=natives.get(request.clientOrderId)!;assert.ok(native);assert.equal(nativeId,native.id);readIds.push({base:request.base,id:nativeId});
      const custom=await inspectHook(request,native.id);if(custom)return custom;
      return {activity:'terminal',executionVerified:true,observedAt:Date.now(),result:{id:native.id,clientOrderId:request.clientOrderId,status:'filled',
        filledQuantity:request.quantity,averagePrice:request.limitPrice,averagePriceVerified:true,feeUsd:request.quantity*request.limitPrice*.0002,timestamp:Date.now()}};
    },
    cancelMakerReduction:async(request,nativeId)=>{const native=natives.get(request.clientOrderId)!;assert.equal(nativeId,native.id);native.cancelled=true;},
    placeOrder:async(request,canSubmit)=>{
      peerCalls.push({...request});await peerBeforeGuard(request);
      if(canSubmit?.()===false)return rejectedOrder(request,new OrderNotSubmittedError('offline peer veto','ORDER_SUBMISSION_PERMISSION_CHANGED','offline peer veto'));
      assert.equal(request.reduceOnly,true);assert.notEqual(request.postOnly,true);peerPosts.push({...request});return peerResult(request);
    },
    reconcileOrder:async(request,nativeId)=>({id:nativeId??`peer-${request.clientOrderId}`,clientOrderId:request.clientOrderId,status:'unknown',
      filledQuantity:0,averagePrice:0,feeUsd:NaN,timestamp:Date.now()}),
    cancelOrder:async()=>{throw new Error('generic cancellation must never own the primary Maker');},close:async()=>{},
  });
  let queue=Promise.resolve();
  const serial=<T>(work:()=>Promise<T>):Promise<T>=>{const next=queue.then(work,work);queue=next.then(()=>undefined,()=>undefined);return next;};
  const execution=new Execution(store,{config:()=>config,liveUnlocked:()=>unlocked,makerActionsAllowed:()=>actions,serialize:serial,
    snapshot:(exchange,base)=>books.get(`${exchange}:${base}`),adapter:exchange=>adapters.get(exchange as ExchangeId)!,canUseSnapshot:()=>true,
    refreshSnapshots:async()=>{},refreshReductionSnapshots:async()=>{throw new Error('fresh confirmed peer must not wait for public REST');},
    halt:(reason)=>{halts.push(reason);}});
  return {execution,store,positions,books,saved,halts,makerPosts,peerPosts,peerCalls,readIds,
    primaryBefore(fn:typeof makerBeforeGuard){makerBeforeGuard=fn;},peerBefore(fn:typeof peerBeforeGuard){peerBeforeGuard=fn;},
    inspect(fn:typeof inspectHook){inspectHook=fn;},result(fn:typeof peerResult){peerResult=fn;},
    saveHook(fn:typeof saveHook){saveHook=fn;},unlock(value:boolean){unlocked=value;},actions(value:boolean){actions=value;},
    reconfigure(){config={...config};data.config=config;},
    barrier(){const entered=deferred<void>(),release=deferred<void>();releases.push(()=>release.resolve());return {entered,release};},
    async start(base:string){const p=positions.get(base)!,prepared=await execution.prepareMakerClose(p);assert.ok(prepared,'profitable exact candidate must prepare');
      return serial(()=>execution.startMakerClose(p,'offline concurrent Maker exit',prepared));},
    async drain(){for(const release of releases)release();await execution.drainMakerCloses();},
    wait(base:string){return execution.waitMakerClose(positions.get(base)!);},
  };
}

test('one primary native submit can wait while another qualifying coin submits Maker and closes its confirmed peer',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.drain());const blocked=f.barrier();
  f.primaryBefore(async request=>{if(request.base==='MA'){blocked.entered.resolve();await blocked.release.promise;}});
  assert.equal(await f.start('MA'),true);await blocked.entered.promise;
  assert.equal(await f.start('MB'),true);await f.wait('MB');
  assert.deepEqual(f.makerPosts.map(request=>request.base),['MB']);assert.deepEqual(f.peerPosts.map(request=>request.base),['MB']);
  assert.equal(f.positions.get('MA')!.long.quantity,100);assert.equal(f.positions.get('MB')!.long.quantity,70);
  blocked.release.resolve();await f.wait('MA');assert.deepEqual(f.makerPosts.map(request=>request.base),['MB','MA']);
  assert.ok(f.makerPosts.every(request=>request.postOnly));assert.equal(f.peerPosts.length,2);
});

test('an original Maker GET can wait while another qualifying coin starts and finishes without bypassing cash commits',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.drain());const blocked=f.barrier();
  f.inspect(async request=>{if(request.base==='MA'){blocked.entered.resolve();await blocked.release.promise;}return undefined;});
  await f.start('MA');await blocked.entered.promise;await f.start('MB');await f.wait('MB');
  assert.equal(f.positions.get('MA')!.long.quantity,100);assert.equal(f.positions.get('MB')!.long.quantity,70);
  assert.equal(f.peerPosts.length,1);assert.equal(f.peerPosts[0].base,'MB');
  blocked.release.resolve();await f.wait('MA');assert.equal(f.peerPosts.length,2);
});

test('a peer native wait releases the financial queue so another qualifying Maker executes independently',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.drain());const blocked=f.barrier();
  f.peerBefore(async request=>{if(request.base==='MA'){blocked.entered.resolve();await blocked.release.promise;}});
  await f.start('MA');await blocked.entered.promise;await f.start('MB');await f.wait('MB');
  assert.equal(f.positions.get('MA')!.long.quantity,70);assert.equal(f.positions.get('MA')!.short.quantity,100);
  assert.equal(f.positions.get('MB')!.long.quantity,70);assert.equal(f.positions.get('MB')!.short.quantity,70);
  blocked.release.resolve();await f.wait('MA');assert.equal(f.positions.get('MA')!.short.quantity,70);
});

for(const change of ['unlock','actions','config','kill','manual'] as const)test(`primary ${change} revocation during native GET vetoes its first PostOnly create`,async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.drain());const blocked=f.barrier();
  f.primaryBefore(async()=>{blocked.entered.resolve();await blocked.release.promise;});await f.start('MA');await blocked.entered.promise;
  if(change==='unlock')f.unlock(false);if(change==='actions')f.actions(false);if(change==='config')f.reconfigure();
  if(change==='kill')f.store.data.killSwitch=true;if(change==='manual')f.positions.get('MA')!.manualCloseOnly=true;
  blocked.release.resolve();await f.wait('MA');assert.equal(f.makerPosts.length,0);assert.equal(f.peerPosts.length,0);
  assert.equal(f.positions.get('MA')!.long.quantity,100);assert.equal(f.positions.get('MA')!.short.quantity,100);
});

for(const change of ['unlock','actions','config','kill','parent-removed','parent-request'] as const)test(`peer ${change} revocation during native GET never spends an invalidated confirmed budget`,async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.drain());const blocked=f.barrier();
  f.peerBefore(async()=>{blocked.entered.resolve();await blocked.release.promise;});await f.start('MA');await blocked.entered.promise;
  const parent=f.store.data.orders.find(order=>order.positionId==='position-MA'&&order.makerReduction)!;
  if(change==='unlock')f.unlock(false);if(change==='actions')f.actions(false);if(change==='config')f.reconfigure();if(change==='kill')f.store.data.killSwitch=true;
  if(change==='parent-removed')f.store.data.orders.splice(f.store.data.orders.indexOf(parent),1);
  if(change==='parent-request')parent.request.limitPrice+=.001;
  blocked.release.resolve();await f.wait('MA');assert.equal(f.makerPosts.length,1);assert.equal(f.peerPosts.length,0);
  assert.equal(f.peerCalls.length,1,'A vetoed original scope cannot be re-approved by creating another intent');
  assert.equal(f.store.data.orders.filter(order=>order.executionEvidence?.makerCloseParentClientId).length,1);
  assert.equal(f.positions.get('MA')!.long.quantity,70);assert.equal(f.positions.get('MA')!.short.quantity,100);
});

test('an unknown original peer is recorded once and cannot dispatch or submit another reduction',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.drain());
  f.result(request=>({id:`peer-${request.clientOrderId}`,clientOrderId:request.clientOrderId,status:request.base==='MA'?'unknown':'filled',
    filledQuantity:request.base==='MA'?5:request.quantity,averagePrice:request.limitPrice,averagePriceVerified:true,
    feeUsd:request.base==='MA'?.0025:request.quantity*request.limitPrice*.0005,timestamp:Date.now()}));
  await f.start('MA');await f.wait('MA');const p=f.positions.get('MA')!,peers=f.store.data.orders.filter(order=>order.executionEvidence?.makerCloseParentClientId);
  assert.equal(f.peerPosts.length,1);assert.equal(peers.length,1);assert.equal(peers[0].result!.status,'unknown');assert.equal(peers[0].result!.filledQuantity,5);
  assert.equal(p.long.quantity,70);assert.equal(p.short.quantity,95);assert.equal(p.status,'attention');
  assert.equal(f.execution.dispatchMakerCloseTail(p),false);assert.equal(await f.execution.prepareMakerClose(p),undefined);assert.equal(f.peerPosts.length,1);
  assert.ok(Math.abs(p.feesUsd-(.1+30*1.016*.0002+.0025))<1e-12);
  assert.equal(f.store.data.killSwitch,false);await f.start('MB');await f.wait('MB');
  assert.equal(f.positions.get('MB')!.long.quantity,70);assert.equal(f.positions.get('MB')!.short.quantity,70);
  assert.equal(f.peerPosts.filter(request=>request.base==='MA').length,1);assert.equal(f.peerPosts.length,2);
});

test('explicit Maker stop during a peer native GET vetoes its pending new POST and preserves the confirmed tail',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.drain());const blocked=f.barrier();
  f.peerBefore(async()=>{blocked.entered.resolve();await blocked.release.promise;});await f.start('MA');await blocked.entered.promise;
  const p=f.positions.get('MA')!;f.execution.requestMakerCloseStop(p,'offline explicit stop while peer account GET waits');
  blocked.release.resolve();await f.wait('MA');
  assert.equal(f.makerPosts.length,1);assert.equal(f.peerPosts.length,0);assert.equal(p.long.quantity,70);assert.equal(p.short.quantity,100);
  assert.ok(f.store.data.orders.filter(order=>order.executionEvidence?.makerCloseParentClientId).every(order=>order.result?.filledQuantity===0));
});

test('peer intent persistence failure stops before POST and retains the primary true fill',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.drain());let failed=false;
  f.saveHook(()=>{if(!failed&&f.store.data.orders.some(order=>order.executionEvidence?.makerCloseParentClientId&&!order.result)){
    failed=true;throw new Error('offline peer intent disk failure');}});
  await f.start('MA');await f.wait('MA');assert.equal(failed,true);assert.equal(f.peerPosts.length,0);assert.equal(f.store.data.killSwitch,true);
  assert.equal(f.positions.get('MA')!.long.quantity,70);assert.equal(f.positions.get('MA')!.short.quantity,100);
});

test('peer cash persistence failure keeps its actual fill once and prohibits later POST or tail replay',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.drain());let failed=false;
  f.saveHook(()=>{if(!failed&&f.store.data.orders.some(order=>order.executionEvidence?.makerCloseParentClientId&&order.result?.filledQuantity)){
    failed=true;throw new Error('offline peer cash disk failure');}});
  await f.start('MA');await f.wait('MA');const p=f.positions.get('MA')!;
  assert.equal(failed,true);assert.equal(f.peerPosts.length,1);assert.equal(f.store.data.killSwitch,true);assert.equal(p.long.quantity,70);assert.equal(p.short.quantity,70);
  assert.ok(Math.abs(p.feesUsd-(.1+30*1.016*.0002+30*.0005))<1e-12);
  assert.equal(f.execution.dispatchMakerCloseTail(p),false);assert.equal(await f.execution.prepareMakerClose(p),undefined);assert.equal(f.peerPosts.length,1);
});
