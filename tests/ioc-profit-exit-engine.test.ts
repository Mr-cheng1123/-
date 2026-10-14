import assert from 'node:assert/strict';
import test from 'node:test';
import {Engine} from '../src/core/engine.js';
import type {Store} from '../src/core/store.js';
import {defaultConfig,validateConfig} from '../src/shared/config.js';
import {configUpdatePolicy} from '../src/shared/config-update-policy.js';
import {startupConfig} from '../src/shared/startup-config.js';
import {parseConfigPatch} from '../src/server-input.js';
import {alignedExitProfitsPass,assessBestOppositeProfitExit} from '../src/core/profit-exit.js';
import {evaluateHoldingDecision} from '../src/core/holding-decision.js';
import type {AccountState,AppConfig,ExchangeAdapter,ExchangeId,MarketSnapshot,OrderRequest,OrderResult,Position,TradingFeeMetadata} from '../src/shared/types.js';

const BASE='IOCONE',EXCHANGES:ExchangeId[]=['gate','bybit'];
const wait=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean,label:string,diagnostic?:()=>unknown){
  for(let attempt=0;attempt<200;attempt++){if(check())return;await wait(5);}
  assert.fail(diagnostic?`${label}: ${JSON.stringify(diagnostic())}`:label);
}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return {promise,resolve};}

/** Real Engine and Execution, with account slots, fees and receipts entirely in memory. */
function fixture(options:{mode?:'maker'|'ioc';missingFees?:boolean;feeRate?:number;rebate?:boolean}={}){
  const config:AppConfig={...structuredClone(defaultConfig),mode:'live',dataSource:'public',entryPolicy:'aligned',holdMode:'adaptive',
    exchanges:EXCHANGES,symbols:[BASE],orderNotionalUsd:100,pollIntervalMs:5000,maxOrderRetries:0,minExitProfitBps:10,
    profitExitExecutionMode:options.mode??'ioc',...(options.rebate?{feeRebatePct:{gate:70}}:{})};
  const store={data:{version:1,config,positions:[],orders:[],logs:[],equity:[],killSwitch:false,fundingSeen:[]},save(){},log(){}} as unknown as Store;
  const quotes=new Map<string,MarketSnapshot>(),fees=new Map<ExchangeId,TradingFeeMetadata>(),accounts=new Map<ExchangeId,AccountState>();
  const posts:Array<{exchange:ExchangeId;request:OrderRequest}>=[],feeReads:ExchangeId[]=[],makerPosts:OrderRequest[]=[],accountReads:ExchangeId[]=[];
  for(const exchange of EXCHANGES){
    accounts.set(exchange,{freeUsd:1000,equityUsd:1000,positions:[]});
    if(!options.missingFees)fees.set(exchange,{takerFeeRate:options.feeRate??.0005,takerFeeSource:'exchange',takerFeeAt:Date.now()});
  }
  let beforePost:((request:OrderRequest,exchange:ExchangeId)=>Promise<void>)|undefined;
  const snapshot=(exchange:ExchangeId,base=BASE)=>quotes.get(`${exchange}:${base}`)!;
  const adapters=EXCHANGES.map(exchange=>({id:exchange,
    getExecutionSnapshot:(base:string)=>snapshot(exchange,base),
    fetchExecutionSnapshots:async(bases:string[])=>bases.map(base=>snapshot(exchange,base)),
    fetchSnapshots:async(bases:string[])=>bases.map(base=>snapshot(exchange,base)),
    fetchAccount:async()=>{accountReads.push(exchange);return structuredClone(accounts.get(exchange)!);},
    fetchOpenOrders:async()=>[],fetchFundingPayments:async()=>[],inspectTrading:async()=>{},prepareTrading:async()=>{},
    supportsMakerReduction:()=>false,
    submitMakerReduction:async(request:OrderRequest)=>{makerPosts.push(request);throw new Error('IOC mode must never submit a Maker');},
    fetchTradingFee:async()=>{feeReads.push(exchange);const value={takerFeeRate:options.feeRate??.0005,takerFeeSource:'exchange' as const,takerFeeAt:Date.now()};fees.set(exchange,value);return value;},
    cachedTradingFee:()=>fees.get(exchange),
    validateOrder:async(request:OrderRequest)=>{assert.equal(request.reduceOnly,true);assert.notEqual(request.postOnly,true);},
    placeOrder:async(request:OrderRequest,canSubmit?:()=>boolean):Promise<OrderResult>=>{
      await beforePost?.(request,exchange);
      if(canSubmit&&!canSubmit())return {id:'',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,
        timestamp:Date.now(),rejectionCode:'ORDER_SUBMISSION_PERMISSION_CHANGED'};
      assert.equal(request.reduceOnly,true);assert.notEqual(request.postOnly,true);
      const quote=snapshot(exchange,request.base),price=request.side==='sell'?quote.bids[0].price:quote.asks[0].price;
      assert.equal(request.limitPrice,price,'both legs use the current opposite-1 limit');
      posts.push({exchange,request:{...request}});
      const actual=accounts.get(exchange)!.positions.find(row=>row.symbol===request.symbol)!;
      assert.ok(request.quantity<=actual.quantity);actual.quantity-=request.quantity;
      return {id:`IOC-NATIVE-${exchange}-${posts.length}`,clientOrderId:request.clientOrderId,status:'filled',filledQuantity:request.quantity,
        averagePrice:request.limitPrice,averagePriceVerified:true,feeUsd:request.quantity*request.limitPrice*fees.get(exchange)!.takerFeeRate,timestamp:Date.now()};
    },reconcileOrder:async()=>{throw new Error('Unexpected reconciliation');},cancelOrder:async()=>{throw new Error('IOC has no resting remainder');},close:async()=>{},
  } as ExchangeAdapter));
  const engine=new Engine(store,true,{adapterFactory:()=>adapters,liveEnvironment:{ALLOW_LIVE_TRADING:'true',LIVE_TRADING_ACK:'I_UNDERSTAND_THE_RISKS',
    GATE_API_KEY:'OFFLINE-IOC',GATE_API_SECRET:'OFFLINE-IOC',BYBIT_API_KEY:'OFFLINE-IOC',BYBIT_API_SECRET:'OFFLINE-IOC'}});
  const addPosition=(base=BASE)=>{
    const symbol=`${base}/USDT:USDT`,at=Date.now();
    const p:Position={id:`ioc-position-${base}`,base,mode:'live',entryPolicy:'aligned',holdMode:'adaptive',status:'open',openedAt:at-2000,
      plannedExitAt:at+3_610_000,profitExitNotionalUsd:100,
      long:{exchange:'gate',symbol,side:'long',quantity:100,entryPrice:1,markPrice:1,feesUsd:.05,liquidationDistancePct:null},
      short:{exchange:'bybit',symbol,side:'short',quantity:100,entryPrice:1,markPrice:1,feesUsd:.05,liquidationDistancePct:null},
      fundingUsd:0,feesUsd:.1,transferCostUsd:0,realizedSpreadPnlUsd:0,spreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[],
      profitExitPolicy:{firstFundingTime:at+3_600_000,earliestExitAt:at+3_610_000,minSpreadNetUsd:0,minCombinedNetUsd:0,
        fundingChecks:EXCHANGES.map(exchange=>({exchange,timestamp:at+3_600_000}))}};
    store.data.positions.push(p);
    for(const exchange of EXCHANGES){
      const long=exchange==='gate';
      const quote:MarketSnapshot={exchange,base,symbol,source:'public',timestamp:at,observedAt:at,fundingObservedAt:at,bookTransport:'websocket',
        markPrice:1,indexPrice:1,fundingRate:long?0:.001,intervalHours:8,nextFundingTime:at+3_600_000,fundingHistory:[],
        bids:[{price:long?1.006:.998,quantity:100}],asks:[{price:long?1.016:1,quantity:100}],
        quantityStep:1,minQuantity:1,minNotional:1,contractSize:1,openInterestUsd:1e8,volume24hUsd:1e8,feeProfile:'standard'};
      quotes.set(`${exchange}:${base}`,quote);engine.snapshots.push(quote);
      accounts.get(exchange)!.positions.push({base,symbol,side:long?'long':'short',quantity:100,entryPrice:1,markPrice:1,liquidationPrice:0,leverage:2});
      const request:OrderRequest={clientOrderId:`opening-${exchange}-${base}`,base,symbol,side:long?'buy':'sell',quantity:100,limitPrice:1,reduceOnly:false};
      store.data.orders.push({positionId:p.id,exchange,request,createdAt:at-2000,result:{id:`opening-native-${exchange}-${base}`,clientOrderId:request.clientOrderId,
        status:'filled',filledQuantity:100,averagePrice:1,averagePriceVerified:true,feeUsd:.05,timestamp:at-2000},
        executionEvidence:{version:1,method:'ioc',role:'entry',batchId:`opening-${base}`,bookedFeeUsd:.05}});
    }
    return p;
  };
  const p=addPosition();
  for(const exchange of EXCHANGES){engine.accounts.set(exchange,structuredClone(accounts.get(exchange)!));const health=engine.health.find(row=>row.exchange===exchange)!;
    health.status='online';health.accountStatus='ready';health.accountUpdatedAt=Date.now();health.lastSuccess=Date.now();}
  const internal=engine as any;engine.running=true;internal.detailedOpportunities=()=>[];
  return {engine,internal,store,p,adapters,quotes,fees,accounts,posts,feeReads,makerPosts,accountReads,addPosition,snapshot,
    beforePost:(fn:typeof beforePost)=>beforePost=fn,
    wake:()=>internal.scheduleRealtimeProfitExits(),stop:()=>engine.stop()};
}

test('exit mode is explicit, preserves absent legacy saved policy and round-trips the strict config API',()=>{
  const legacy=validateConfig({...defaultConfig,entryPolicy:'aligned'});
  assert.equal(Object.hasOwn(legacy,'profitExitExecutionMode'),false);
  assert.equal(Object.hasOwn(startupConfig({},legacy,'paper'),'profitExitExecutionMode'),false);
  const {partial,expectedConfig}=parseConfigPatch({profitExitExecutionMode:'ioc',expectedConfig:legacy});
  assert.equal(partial.profitExitExecutionMode,'ioc');assert.deepEqual(expectedConfig,legacy);
  const next=validateConfig({...legacy,...partial});assert.equal(startupConfig({},next,'paper').profitExitExecutionMode,'ioc');
  assert.deepEqual(configUpdatePolicy(legacy,next),{changedFields:['profitExitExecutionMode'],criticalFields:[],entryOnly:true});
  assert.throws(()=>validateConfig({...legacy,profitExitExecutionMode:'market'}));
});

test('IOC automatic capture needs only actual taker fees and no Maker support or fee',async t=>{
  const f=fixture();t.after(()=>f.stop());assert.equal(f.engine.execution.requiresMakerProfitClose(f.p),false);
  assert.deepEqual(f.internal.realtimeProfitFeesMissing(f.p),[]);f.engine.state();assert.equal(f.feeReads.length,0);f.wake();
  await until(()=>f.p.status==='closed','IOC mode failed to close two profitable legs');
  assert.equal(f.posts.length,2);assert.equal(f.makerPosts.length,0);assert.ok(f.feeReads.every(exchange=>EXCHANGES.includes(exchange)));
  assert.ok(f.posts.every(post=>post.request.reduceOnly&&post.request.postOnly!==true));
  const exits=f.store.data.orders.filter(o=>o.request.reduceOnly);
  assert.ok(exits.every(o=>o.executionEvidence?.method==='ioc'&&o.executionEvidence.role==='exit'&&o.executionEvidence.closeFeeRebatePct===0));
  assert.equal(exits[0].executionEvidence!.batchId,exits[1].executionEvidence!.batchId);
  assert.equal(f.p.profitExitNotionalUsd,100);
});

test('one delayed native IOC call cannot hold another coin or the financial commit queue',async t=>{
  const f=fixture(),other=f.addPosition('IOCTWO'),pending=deferred();
  f.beforePost(async request=>{if(request.base===BASE)await pending.promise;});
  t.after(async()=>{pending.resolve();await f.stop();});f.wake();
  await until(()=>other.status==='closed','another profitable coin waited for the first native IOC');
  assert.equal(await f.engine.exclusive(async()=> 'available'),'available');
  assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);assert.equal(f.makerPosts.length,0);
  pending.resolve();await until(()=>f.p.status==='closed','first pair failed after native calls resumed');
  assert.equal(f.posts.length,4);
});

test('a delayed current-close GET releases the financial queue and lets another coin on the same venues exit',async t=>{
  const f=fixture(),other=f.addPosition('IOCTWO'),entered=deferred(),release=deferred();
  let readCount=0,ordinaryDone=false,queueEntered=false;
  t.after(async()=>{release.resolve();await f.stop();});
  const createdAt=Date.now()-500;
  f.p.status='closing';f.p.closeRequestedAt=createdAt-500;f.p.closePricing='best-opposite';f.p.closeProfitRequired=true;
  f.internal.continuingClosePositions.add(f.p.id);
  const request:OrderRequest={clientOrderId:'pending-close-original-id',base:BASE,symbol:f.p.long.symbol,side:'sell',
    quantity:1,limitPrice:1.006,reduceOnly:true};
  const journal={positionId:f.p.id,exchange:'gate' as const,request,createdAt,result:{id:'',clientOrderId:request.clientOrderId,
    status:'unknown' as OrderResult['status'],filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:createdAt}};
  f.store.data.orders.push(journal);const before=structuredClone(journal);
  const gate=f.adapters.find(adapter=>adapter.id==='gate')!;
  gate.inspectOrder=async actualRequest=>{
    assert.equal(actualRequest.clientOrderId,request.clientOrderId);readCount++;entered.resolve();await release.promise;
    return {id:'pending-close-native-id',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,
      averagePrice:0,feeUsd:0,timestamp:Date.now()};
  };
  gate.reconcileOrder=async()=>{assert.fail('the background pending-close read must not call a reconciliation that may cancel');};
  const ordinary=f.engine.exclusive(()=>f.internal.managePositions(Date.now())).then(()=>{ordinaryDone=true;});
  await until(()=>readCount>0,'the pending-close manager did not start the strict original-ID GET');
  const commit=f.engine.exclusive(async()=>{queueEntered=true;});f.wake();
  await until(()=>other.status==='closed'&&queueEntered&&ordinaryDone,'a pending native GET blocked a different same-venue exit',()=>({
    otherStatus:other.status,ordinaryDone,queueEntered,posts:f.posts.length,readCount}));
  await f.engine.exclusive(()=>f.internal.managePositions(Date.now()));
  assert.equal(readCount,1,'one position cannot start overlapping reads of the original unknown ID');
  assert.deepEqual(journal,before,'a pending read cannot fabricate a receipt, fee or cash');
  assert.deepEqual([f.p.long.quantity,f.p.short.quantity,f.p.feesUsd,f.p.realizedSpreadPnlUsd],[100,100,.1,0]);
  assert.equal(f.posts.filter(post=>post.request.base===BASE).length,0,'an unresolved original ID cannot be resubmitted');
  assert.deepEqual(f.posts.map(post=>post.request.base),['IOCTWO','IOCTWO']);
  // The GET resolves after its economic trigger has gone. Only the original receipt may change.
  f.snapshot('gate').bids[0].price=.99;f.snapshot('gate').asks[0].price=1;
  release.resolve();await ordinary;await commit;
  await until(()=>journal.result.status==='cancelled','the original terminal GET receipt was not retained');
  assert.equal(journal.request.clientOrderId,request.clientOrderId);assert.equal(journal.result.id,'pending-close-native-id');
  assert.deepEqual([f.p.long.quantity,f.p.short.quantity,f.p.feesUsd,f.p.realizedSpreadPnlUsd],[100,100,.1,0]);
  assert.equal(f.posts.filter(post=>post.request.base===BASE).length,0);assert.equal(f.store.data.killSwitch,false);
});

test('an unknown-order GET connect syscall remains a local wait while another same-venue coin exits',async t=>{
  const f=fixture(),other=f.addPosition('IOCTWO');t.after(()=>f.stop());f.engine.autoEnabled=true;
  let reads=0,queueEntered=false;
  const createdAt=Date.now()-500;
  f.p.status='closing';f.p.closeRequestedAt=createdAt-500;f.p.closePricing='best-opposite';f.p.closeProfitRequired=true;
  f.internal.continuingClosePositions.add(f.p.id);
  const request:OrderRequest={clientOrderId:'unknown-network-original-id',base:BASE,symbol:f.p.long.symbol,side:'sell',
    quantity:1,limitPrice:1.006,reduceOnly:true};
  const journal={positionId:f.p.id,exchange:'gate' as const,request,createdAt,result:{id:'',clientOrderId:request.clientOrderId,
    status:'unknown' as OrderResult['status'],filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:createdAt}};
  f.store.data.orders.push(journal);const before=structuredClone(journal);
  const gate=f.adapters.find(adapter=>adapter.id==='gate')!;
  gate.inspectOrder=async actual=>{
    assert.equal(actual.clientOrderId,request.clientOrderId);reads++;
    throw Object.assign(new Error('OFFLINE original-order GET connection refused'),{syscall:'connect',code:'ECONNREFUSED'});
  };
  gate.reconcileOrder=async()=>{assert.fail('a failed original GET cannot fall back to cancellation-capable reconciliation');};
  await f.engine.exclusive(()=>f.internal.managePositions(Date.now()));
  const commit=f.engine.exclusive(async()=>{queueEntered=true;});f.wake();
  await until(()=>reads===1&&f.p.status==='attention'&&other.status==='closed'&&queueEntered,
    'a network syscall from an original-order GET stopped another coin or the financial queue',()=>({
      reads,firstStatus:f.p.status,otherStatus:other.status,queueEntered,kill:f.store.data.killSwitch,auto:f.engine.autoEnabled}));
  await commit;assert.deepEqual(journal,before);
  assert.deepEqual([f.p.long.quantity,f.p.short.quantity,f.p.feesUsd,f.p.realizedSpreadPnlUsd],[100,100,.1,0]);
  assert.equal(f.posts.filter(post=>post.request.base===BASE).length,0);assert.equal(f.posts.length,2);
  assert.equal(f.store.data.killSwitch,false);assert.equal(f.engine.autoEnabled,true);
});

test('a funding-exit book GET read syscall remains local and preserves auto while another coin exits',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});
  const f=fixture();t.after(()=>f.stop());f.engine.autoEnabled=true;
  let reads=0,queueEntered=false;const paymentAt=Date.now()+240_000;
  const update=()=>{
    for(const exchange of EXCHANGES){
      const quote=f.snapshot(exchange);quote.timestamp=Date.now();quote.observedAt=Date.now();quote.fundingObservedAt=Date.now();
      quote.nextFundingTime=paymentAt;quote.fundingRate=exchange==='bybit'?-.01:0;
      quote.bids[0].price=.999;if(exchange==='gate')quote.asks[0].price=1;
      f.fees.get(exchange)!.takerFeeAt=Date.now();
    }
  };
  for(let sample=0;sample<4;sample++){
    if(sample)t.mock.timers.tick(45_000);update();await f.internal.managePosition(f.p,Date.now());
    assert.equal(f.posts.length,0);assert.equal(f.feeReads.length,0);
  }
  t.mock.timers.tick(45_000);update();const other=f.addPosition('IOCTWO');
  const preparedFees=new Map<ExchangeId,TradingFeeMetadata>();
  for(const adapter of f.adapters){
    adapter.cachedTradingFee=symbol=>symbol===f.p.long.symbol?preparedFees.get(adapter.id):f.fees.get(adapter.id);
    adapter.fetchTradingFee=async symbol=>{
      const fee:TradingFeeMetadata={takerFeeRate:.0005,takerFeeSource:'exchange',takerFeeAt:Date.now()};
      if(symbol===f.p.long.symbol)preparedFees.set(adapter.id,fee);else f.fees.set(adapter.id,fee);
      return fee;
    };
    const originalBook=adapter.fetchExecutionSnapshots!;
    adapter.fetchExecutionSnapshots=async bases=>{
      if(bases.includes(BASE)){
        reads++;throw Object.assign(new Error('OFFLINE execution-book GET socket read reset'),{syscall:'read',code:'ECONNRESET'});
      }
      return originalBook.call(adapter,bases);
    };
  }
  for(const exchange of EXCHANGES){const quote=f.snapshot(exchange);delete quote.takerFeeRate;delete quote.takerFeeAt;delete quote.takerFeeSource;}
  await f.engine.exclusive(()=>f.internal.managePositions(Date.now()));
  const commit=f.engine.exclusive(async()=>{queueEntered=true;});f.wake();
  await until(()=>reads===2&&other.status==='closed'&&queueEntered,
    'a network syscall from funding-exit preparation stopped another same-venue coin',()=>({
      reads,firstStatus:f.p.status,otherStatus:other.status,queueEntered,kill:f.store.data.killSwitch,auto:f.engine.autoEnabled}));
  await commit;await wait(30);
  assert.equal(f.p.status,'open');assert.equal(f.p.closeRequestedAt,undefined);
  assert.deepEqual([f.p.long.quantity,f.p.short.quantity,f.p.feesUsd,f.p.fundingUsd],[100,100,.1,0]);
  assert.equal(f.posts.filter(post=>post.request.base===BASE).length,0);assert.equal(f.posts.length,2);
  assert.equal(f.store.data.killSwitch,false);assert.equal(f.engine.autoEnabled,true);
});

for(const terminal of ['cancelled','rejected'] as const){
  test(`a current-session unknown close resolved as ${terminal} requires fresh accounts and retains its execution guard`,async t=>{
    t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});
    const f=fixture();t.after(()=>f.stop());f.engine.autoEnabled=true;
    f.p.status='closing';f.p.closeRequestedAt=Date.now()-1000;f.p.closePricing='best-opposite';f.p.closeProfitRequired=true;
    f.internal.continuingClosePositions.add(f.p.id);
    const request:OrderRequest={clientOrderId:`continuing-original-${terminal}`,base:BASE,symbol:f.p.long.symbol,
      side:'sell',quantity:1,limitPrice:1.006,reduceOnly:true};
    const journal={positionId:f.p.id,exchange:'gate' as const,request,createdAt:Date.now()-500,
      result:{id:'',clientOrderId:request.clientOrderId,status:'unknown' as OrderResult['status'],filledQuantity:0,
        averagePrice:0,feeUsd:0,timestamp:Date.now()-500},
      executionEvidence:{version:1 as const,method:'ioc' as const,role:'exit' as const,batchId:`original-${terminal}`,bookedFeeUsd:0}};
    f.store.data.orders.push(journal);let reads=0;
    f.adapters.find(adapter=>adapter.id==='gate')!.inspectOrder=async()=>{
      reads++;
      return {id:reads===1?'':`verified-original-${terminal}`,clientOrderId:request.clientOrderId,
        status:reads===1?'unknown':'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now(),
        ...(reads>1&&terminal==='rejected'?{rejectionCode:'ORDER_VALIDATION_FAILED'}:{})};
    };
    await f.engine.exclusive(()=>f.internal.managePositions(Date.now()));
    await until(()=>reads===1&&f.p.status==='attention','an unresolved current close did not enter its local wait');
    assert.equal(f.posts.length,0);
    t.mock.timers.tick(5000);
    for(const exchange of EXCHANGES){
      const quote=f.snapshot(exchange);quote.timestamp=Date.now();quote.observedAt=Date.now();quote.fundingObservedAt=Date.now();
      f.fees.get(exchange)!.takerFeeAt=Date.now();
    }
    await f.engine.exclusive(()=>f.internal.managePositions(Date.now()));
    await until(()=>reads===2&&journal.result.status==='cancelled','the original-ID second GET was not confirmed');
    assert.equal(f.posts.length,0,'a terminal receipt cannot substitute for a post-receipt account read');
    const accounts=await Promise.all(f.adapters.map(async adapter=>({exchange:adapter.id,account:await f.internal.readTradingAccount(adapter)})));
    await f.engine.exclusive(async()=>{for(const row of accounts)f.internal.cacheAccount(row.exchange,row.account);});
    await f.engine.exclusive(()=>f.internal.managePositions(Date.now()));f.wake();
    if(terminal==='cancelled'){
      await until(()=>f.p.status==='closed','a current-session verified cancellation stayed stuck after fresh account proof',()=>({
        status:f.p.status,reason:f.p.riskReasons,reads,posts:f.posts.length,hold:f.p.holdDecision}));
      assert.equal(f.posts.length,2);assert.deepEqual([f.p.long.quantity,f.p.short.quantity],[0,0]);
      assert.equal(f.posts.some(post=>post.request.clientOrderId===request.clientOrderId),false);
    }else{
      await wait(50);assert.equal(f.p.status,'attention');assert.equal(f.posts.length,0);
      assert.deepEqual([f.p.long.quantity,f.p.short.quantity,f.p.feesUsd,f.p.fundingUsd],[100,100,.1,0]);
    }
    assert.equal(journal.result.status,'cancelled');assert.equal(journal.request.clientOrderId,request.clientOrderId);
    assert.equal(f.store.data.killSwitch,false);assert.equal(f.engine.autoEnabled,true);
  });
}

test('a saved-only attention close with a verified cancellation and fresh accounts cannot create a current-session exit',async t=>{
  const f=fixture();t.after(()=>f.stop());f.engine.autoEnabled=true;
  f.p.status='attention';f.p.closeRequestedAt=Date.now()-1000;f.p.closePricing='best-opposite';f.p.closeProfitRequired=true;
  const request:OrderRequest={clientOrderId:'saved-only-original-cancelled',base:BASE,symbol:f.p.long.symbol,
    side:'sell',quantity:1,limitPrice:1.006,reduceOnly:true};
  const journal={positionId:f.p.id,exchange:'gate' as const,request,createdAt:Date.now()-500,
    result:{id:'saved-only-native-id',clientOrderId:request.clientOrderId,status:'cancelled' as const,filledQuantity:0,
      averagePrice:0,feeUsd:0,timestamp:Date.now()-500},
    executionEvidence:{version:1 as const,method:'ioc' as const,role:'exit' as const,batchId:'saved-only-original',bookedFeeUsd:0}};
  f.store.data.orders.push(journal);const before=structuredClone(journal);
  const accounts=await Promise.all(f.adapters.map(async adapter=>({exchange:adapter.id,account:await f.internal.readTradingAccount(adapter)})));
  await f.engine.exclusive(async()=>{for(const row of accounts)f.internal.cacheAccount(row.exchange,row.account);});
  await f.engine.exclusive(()=>f.internal.managePositions(Date.now()));f.wake();await wait(50);
  assert.equal(f.p.status,'attention');assert.equal(f.posts.length,0);assert.deepEqual(journal,before);
  assert.deepEqual([f.p.long.quantity,f.p.short.quantity,f.p.feesUsd,f.p.fundingUsd],[100,100,.1,0]);
  assert.equal(f.store.data.killSwitch,false);assert.equal(f.engine.autoEnabled,true);
});

test('a plain save error after funding-exit preparation halts before any financial POST',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});
  const f=fixture(),originalSave=f.store.save;t.after(async()=>{f.store.save=originalSave;await f.stop();});f.engine.autoEnabled=true;
  const paymentAt=Date.now()+240_000;
  const update=()=>{
    for(const exchange of EXCHANGES){
      const quote=f.snapshot(exchange);quote.timestamp=Date.now();quote.observedAt=Date.now();quote.fundingObservedAt=Date.now();
      quote.nextFundingTime=paymentAt;quote.fundingRate=exchange==='bybit'?-.01:0;quote.bids[0].price=.999;
      if(exchange==='gate')quote.asks[0].price=1;f.fees.get(exchange)!.takerFeeAt=Date.now();
    }
  };
  for(let sample=0;sample<4;sample++){
    if(sample)t.mock.timers.tick(45_000);update();await f.internal.managePosition(f.p,Date.now());assert.equal(f.posts.length,0);
  }
  t.mock.timers.tick(45_000);update();const preparedFees=new Map<ExchangeId,TradingFeeMetadata>();let nativeFeeReads=0,saveFailures=0;
  for(const adapter of f.adapters){
    adapter.cachedTradingFee=()=>preparedFees.get(adapter.id);
    adapter.fetchTradingFee=async()=>{
      nativeFeeReads++;const fee:TradingFeeMetadata={takerFeeRate:.0005,takerFeeSource:'exchange',takerFeeAt:Date.now()};
      preparedFees.set(adapter.id,fee);return fee;
    };
    const quote=f.snapshot(adapter.id);delete quote.takerFeeRate;delete quote.takerFeeAt;delete quote.takerFeeSource;
  }
  f.store.save=()=>{saveFailures++;throw new Error('OFFLINE durable save rejected without syscall metadata');};
  await f.engine.exclusive(()=>f.internal.managePositions(Date.now()));
  await until(()=>saveFailures>0&&f.store.data.killSwitch,'a genuine plain persistence failure was softened as a read-only wait');
  await f.engine.execution.waitIocProfitClose(f.p);
  assert.ok(nativeFeeReads>=2);assert.equal(f.engine.autoEnabled,false);assert.equal(f.posts.length,0);
  assert.deepEqual([f.p.long.quantity,f.p.short.quantity,f.p.feesUsd,f.p.fundingUsd],[100,100,.1,0]);
});

for(const delay of ['fee','book'] as const){
  for(const changed of ['unchanged','funding-reversed','actual-fee-higher','fee-policy-changed','quantity-changed','close-request-changed','native-fee-unavailable'] as const){
    test(`confirmed funding-loss ${delay} preparation does not block a different coin; ${changed} is rechecked before POST`,async t=>{
      t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});
      const f=fixture(),entered=deferred(),release=deferred();
      f.engine.autoEnabled=true;
      let ordinaryDone=false,queueEntered=false,preparationDone=false,holdingFeeReads=0,holdingBookReads=0;
      t.after(async()=>{release.resolve();await f.stop();});
      const paymentAt=Date.now()+240_000;
      const update=()=>{
        for(const exchange of EXCHANGES){
          const quote=f.snapshot(exchange);quote.timestamp=Date.now();quote.observedAt=Date.now();quote.fundingObservedAt=Date.now();
          quote.nextFundingTime=paymentAt;quote.fundingRate=exchange==='bybit'?-.01:0;
          quote.bids[0].price=.999;if(exchange==='gate')quote.asks[0].price=1;
          const fee=f.fees.get(exchange)!;fee.takerFeeAt=Date.now();
        }
      };
      // Four genuine dated observations are insufficient; the fifth spans the original three minutes.
      for(let sample=0;sample<4;sample++){
        if(sample)t.mock.timers.tick(45_000);update();await f.internal.managePosition(f.p,Date.now());
        assert.equal(f.posts.length,0);assert.equal(f.feeReads.length,0);assert.equal(f.p.closeRequestedAt,undefined);
      }
      t.mock.timers.tick(45_000);update();const other=f.addPosition('IOCTWO');
      const preparedFees=new Map<ExchangeId,TradingFeeMetadata>();
      for(const adapter of f.adapters){
        adapter.cachedTradingFee=symbol=>symbol===f.p.long.symbol?preparedFees.get(adapter.id):f.fees.get(adapter.id);
        const originalBook=adapter.fetchExecutionSnapshots!;
        adapter.fetchExecutionSnapshots=async bases=>{
          if(bases.includes(BASE))holdingBookReads++;
          if(delay==='book'&&bases.includes(BASE)){entered.resolve();await release.promise;preparationDone=true;}
          return originalBook.call(adapter,bases);
        };
        adapter.fetchTradingFee=async symbol=>{
          f.feeReads.push(adapter.id);
          if(symbol===f.p.long.symbol)holdingFeeReads++;
          if(symbol===f.p.long.symbol&&delay==='fee'){entered.resolve();await release.promise;preparationDone=true;}
          if(symbol===f.p.long.symbol&&changed==='native-fee-unavailable')throw new Error('OFFLINE actual account fee temporarily unavailable');
          const fee:TradingFeeMetadata={takerFeeRate:symbol===f.p.long.symbol&&changed==='actual-fee-higher'?.009:.0005,
            takerFeeSource:'exchange',takerFeeAt:Date.now()};
          if(symbol===f.p.long.symbol)preparedFees.set(adapter.id,fee);else f.fees.set(adapter.id,fee);
          return fee;
        };
      }
      for(const exchange of EXCHANGES){const quote=f.snapshot(exchange);delete quote.takerFeeRate;delete quote.takerFeeAt;delete quote.takerFeeSource;}
      const ordinary=f.engine.exclusive(()=>f.internal.managePositions(Date.now())).then(()=>{ordinaryDone=true;});
      await entered.promise;
      const commit=f.engine.exclusive(async()=>{queueEntered=true;});f.wake();
      await until(()=>other.status==='closed'&&queueEntered&&ordinaryDone,'a confirmed funding-loss preparation blocked another same-venue coin',()=>({
        otherStatus:other.status,ordinaryDone,queueEntered,posts:f.posts.length,hold:f.p.holdDecision}));
      assert.equal(f.posts.filter(post=>post.request.base===BASE).length,0);assert.equal(f.p.closeRequestedAt,undefined);
      assert.deepEqual([f.p.long.quantity,f.p.short.quantity,f.p.feesUsd,f.p.fundingUsd],[100,100,.1,0]);
      const pendingReadCounts=[holdingFeeReads,holdingBookReads];
      for(let repeat=0;repeat<3;repeat++)await f.engine.exclusive(()=>f.internal.managePositions(Date.now()));
      assert.deepEqual([holdingFeeReads,holdingBookReads],pendingReadCounts,'one coin started overlapping fee/book preparations');
      if(changed==='funding-reversed')f.snapshot('bybit').fundingRate=.01;
      if(changed==='fee-policy-changed')await f.engine.updateConfig({feeRebatePct:{gate:70}});
      if(changed==='quantity-changed')f.p.long.quantity=90;
      if(changed==='close-request-changed'){
        f.p.closeRequestedAt=Date.now();f.p.closePricing='best-opposite';f.p.closeProfitRequired=true;
        f.p.closeReason='A separate current action owns the changed request';
      }
      const currentFinancials=[f.p.long.quantity,f.p.short.quantity,f.p.feesUsd,f.p.fundingUsd];
      release.resolve();await ordinary;await commit;
      await until(()=>preparationDone,'the pending observation did not finish');
      if(changed==='unchanged'){
        await until(()=>f.p.status==='closed','a confirmed funding exit failed after independent reads resumed',()=>({
          status:f.p.status,hold:f.p.holdDecision,reason:f.p.riskReasons,feeReads:f.feeReads,posts:f.posts}));
        assert.equal(f.posts.filter(post=>post.request.base===BASE).length,2);
        assert.ok(f.p.realizedSpreadPnlUsd<0);assert.equal(f.p.fundingUsd,0);
      }else{
        await wait(50);
        if(changed==='funding-reversed'||changed==='actual-fee-higher'){
          await f.engine.exclusive(()=>f.internal.managePositions(Date.now()));await wait(30);
        }
        assert.equal(f.posts.filter(post=>post.request.base===BASE).length,0,'an old funding signal cannot authorize a new POST');
        assert.deepEqual([f.p.long.quantity,f.p.short.quantity,f.p.feesUsd,f.p.fundingUsd],currentFinancials);
        if(changed==='native-fee-unavailable'){
          const failedReadCounts=[holdingFeeReads,holdingBookReads];
          for(let repeat=0;repeat<3;repeat++)await f.engine.exclusive(()=>f.internal.managePositions(Date.now()));
          assert.deepEqual([holdingFeeReads,holdingBookReads],failedReadCounts,'failed exact fees were hot-retried');
          t.mock.timers.tick(14_999);update();
          await f.engine.exclusive(()=>f.internal.managePositions(Date.now()));
          assert.deepEqual([holdingFeeReads,holdingBookReads],failedReadCounts,'failed fees were retried before the 15-second deadline');
          t.mock.timers.tick(1);update();
          await f.engine.exclusive(()=>f.internal.managePositions(Date.now()));
          await until(()=>holdingFeeReads>failedReadCounts[0],'failed fees could not retry after their bounded deadline');
          assert.equal(f.engine.autoEnabled,true,'a read failure must preserve the existing auto-entry switch');
          assert.equal(f.posts.filter(post=>post.request.base===BASE).length,0);
        }
      }
      assert.equal(f.store.data.killSwitch,false);assert.equal(f.makerPosts.length,0);
    });
  }
}

test('fee discovery is on demand and a higher actual taker cost vetoes the reference candidate',async t=>{
  const f=fixture({missingFees:true,feeRate:.004});t.after(()=>f.stop());
  f.engine.state();assert.equal(f.feeReads.length,0);f.wake();
  await until(()=>f.feeReads.length===2,'qualified reference candidate did not fetch exact two taker rates');
  await until(()=>f.internal.realtimeProfitPreparing.size===0,'fee preparation did not settle');
  assert.equal(f.posts.length,0);assert.equal(f.makerPosts.length,0);assert.equal(f.p.closeRequestedAt,undefined);
});

test('the fixed original principal remains the profit threshold after partial exits',async t=>{
  const f=fixture();t.after(()=>f.stop());f.p.profitExitNotionalUsd=1000;
  f.wake();await wait(35);
  assert.equal(f.posts.length,0);assert.equal(f.feeReads.length,0);assert.equal(f.p.profitExitNotionalUsd,1000);
});

test('configured Gate rebate can qualify an IOC exit while gross fee cost alone does not',async t=>{
  const f=fixture({feeRate:.003,rebate:true});t.after(()=>f.stop());f.wake();
  await until(()=>f.p.status==='closed','net-of-rebate IOC qualification was lost',()=>({status:f.p.status,
    quantities:[f.p.long.quantity,f.p.short.quantity],reason:f.p.riskReasons,kill:f.store.data.killSwitch,
    lastReceipts:f.store.data.orders.slice(-2).map(o=>({exchange:o.exchange,result:o.result,executionEvidence:o.executionEvidence}))}));
  assert.equal(f.posts.length,2);
  const exits=f.store.data.orders.filter(o=>o.request.reduceOnly);
  assert.equal(exits.find(o=>o.exchange==='gate')!.executionEvidence!.closeFeeRebatePct,70);
  assert.equal(exits.find(o=>o.exchange==='bybit')!.executionEvidence!.closeFeeRebatePct,0);
});

test('IOC preserves the controlled funding-loss path only after independent stability and current native fees',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});
  const f=fixture();t.after(()=>f.stop());const paymentAt=Date.now()+240_000;
  const update=()=>{
    for(const exchange of EXCHANGES){
      const quote=f.snapshot(exchange);quote.timestamp=Date.now();quote.observedAt=Date.now();quote.fundingObservedAt=Date.now();
      quote.nextFundingTime=paymentAt;quote.fundingRate=exchange==='bybit'?-.01:0;
      if(exchange==='gate'){quote.bids[0].price=.999;quote.asks[0].price=1;}
      else quote.bids[0].price=.999;
    }
  };
  update();assert.equal(alignedExitProfitsPass(f.p,assessBestOppositeProfitExit(f.p,f.engine.snapshot('gate',BASE),
    f.engine.snapshot('bybit',BASE),f.engine.config),f.engine.config),false);
  for(let sample=0;sample<5;sample++){
    if(sample)t.mock.timers.tick(45_000);update();
    if(sample===4){const preview=evaluateHoldingDecision(f.p,f.engine.snapshot('gate',BASE),f.engine.snapshot('bybit',BASE),f.engine.config,Date.now(),false);
      assert.equal(preview.exitSignal,'funding-loss',JSON.stringify(preview));}
    await f.internal.managePosition(f.p,Date.now());
    if(sample<4){assert.equal(f.posts.length,0);assert.equal(f.p.closeRequestedAt,undefined);assert.equal(f.feeReads.length,0);}
  }
  await until(()=>f.p.status==='closed','confirmed adverse funding was blocked by the profit-only IOC gate',()=>({
    status:f.p.status,hold:f.p.holdDecision,close:f.p.closeRequestedAt,feeReads:f.feeReads,posts:f.posts.length,
    orders:f.store.data.orders.slice(-2).map(o=>({exchange:o.exchange,result:o.result}))}));
  assert.equal(f.posts.length,2);assert.equal(f.makerPosts.length,0);assert.equal(f.p.profitExitNotionalUsd,100);
  assert.ok(f.p.realizedSpreadPnlUsd<0,'this is the existing controlled loss, not a new profit threshold');
  assert.equal(f.p.fundingUsd,0,'predicted adverse funding is never booked as received cash');
  assert.deepEqual([...new Set(f.feeReads)].sort(),['bybit','gate']);
});

test('idle exit-mode changes preserve clients and original principal and pause new entries',async t=>{
  const f=fixture({mode:'maker'});t.after(()=>f.stop());const before=f.engine.adapters;f.engine.autoEnabled=true;
  await f.engine.updateConfig({profitExitExecutionMode:'ioc'});
  assert.equal(f.engine.config.profitExitExecutionMode,'ioc');assert.equal(f.engine.adapters,before);
  assert.equal(f.engine.autoEnabled,false);assert.equal(f.p.profitExitNotionalUsd,100);assert.equal(f.posts.length,0);
});

test('an in-flight IOC vetoes changing execution mode before its two receipts settle',async t=>{
  const f=fixture(),pending=deferred();f.beforePost(async()=>pending.promise);
  t.after(async()=>{pending.resolve();await f.stop();});f.wake();
  await until(()=>f.engine.execution.hasIocProfitClose(f.p),'IOC worker was not registered');
  await assert.rejects(f.engine.updateConfig({profitExitExecutionMode:'maker'}),/原平仓动作或已确认尾差/);
  assert.equal(f.engine.config.profitExitExecutionMode,'ioc');pending.resolve();
  await until(()=>f.p.status==='closed','unchanged IOC worker failed to finish');
});

for(const blockingMethod of ['hasMakerClose','hasPendingMakerCloseTail','hasPendingIocProfitTail'] as const){
  test(`${blockingMethod} prevents an execution-mode switch from creating a competing reducer`,async t=>{
    const f=fixture({mode:'maker'});t.after(()=>f.stop());
    f.engine.execution[blockingMethod]=()=>true;
    await assert.rejects(f.engine.updateConfig({profitExitExecutionMode:'ioc'}));
    assert.equal(f.engine.config.profitExitExecutionMode,'maker');
    assert.deepEqual([f.p.long.quantity,f.p.short.quantity,f.p.feesUsd],[100,100,.1]);
    assert.equal(f.posts.length,0);assert.equal(f.feeReads.length,0);
  });
}

test('an idle native exit authority refuses a mode change instead of stranding its config-bound grant',async t=>{
  const f=fixture({mode:'maker'});t.after(()=>f.stop());f.engine.execution.hasNativeExitAuthority=()=>true;
  await assert.rejects(f.engine.updateConfig({profitExitExecutionMode:'ioc'}));
  assert.equal(f.engine.config.profitExitExecutionMode,'maker');assert.equal(f.posts.length,0);
  assert.deepEqual([f.p.long.quantity,f.p.short.quantity,f.p.feesUsd],[100,100,.1]);
});

test('a confirmed current IOC tail takes priority over an exhausted historical native Maker parent',async t=>{
  const f=fixture();t.after(()=>f.stop());f.p.status='closing';f.p.long.quantity=80;f.p.short.quantity=90;
  f.p.closeRequestedAt=Date.now()-1000;f.p.closeProfitRequired=true;f.p.closePricing='best-opposite';
  const calls:Array<{reason:string;validator:unknown}>=[];
  f.engine.execution.hasPendingIocProfitTail=()=>true;f.engine.execution.hasNativeExitAuthority=()=>true;
  f.engine.execution.dispatchIocProfitClose=(_p,reason,validator)=>{calls.push({reason,validator});return true;};
  f.engine.execution.repairNativeConfirmedTail=async()=>{assert.fail('current IOC tail was routed to historical Maker');};
  await f.internal.managePosition(f.p,Date.now());
  assert.equal(calls.length,1);assert.equal(calls[0].validator,undefined);assert.deepEqual([f.p.long.quantity,f.p.short.quantity],[80,90]);
});

test('a native market GET failure before any IOC intent waits without stopping every coin, then retries on a new book',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});
  const f=fixture();t.after(()=>f.stop());f.engine.autoEnabled=true;
  let reads=0;const original=f.adapters.map(adapter=>adapter.fetchExecutionSnapshots);
  for(const adapter of f.adapters)adapter.fetchExecutionSnapshots=async()=>{reads++;throw new Error('MEMORY market GET timed out before any intention');};
  f.wake();await until(()=>reads>0,'IOC did not reach its read-only preparation');await f.engine.execution.waitIocProfitClose(f.p);
  assert.equal(f.store.data.killSwitch,false,'a preparation GET is not a financial persistence failure');
  assert.equal(f.engine.autoEnabled,true);assert.equal(f.p.status,'open');assert.equal(f.p.closeRequestedAt,undefined);
  assert.equal(f.store.data.orders.filter(order=>order.request.reduceOnly).length,0);assert.equal(f.posts.length,0);
  assert.deepEqual([f.p.long.quantity,f.p.short.quantity,f.p.feesUsd],[100,100,.1]);
  const retryAt=f.engine.execution.iocProfitCloseRetryAfter(f.p);
  assert.ok(retryAt-Date.now()>=1400,'read-only failures require a bounded retry delay');
  f.wake();await wait(35);assert.equal(reads,2,'fresh book events must not start another GET before the retry deadline');
  assert.equal(f.internal.realtimeProfitRetryTimers.has(f.p.id),true,'the scheduler must retain a deadline timer without hot polling');
  for(let i=0;i<f.adapters.length;i++)f.adapters[i].fetchExecutionSnapshots=original[i];
  await until(()=>f.internal.realtimeProfitPreparing.size===0,'initial preparation did not release');
  t.mock.timers.tick(retryAt-Date.now());
  f.wake();await until(()=>f.p.status==='closed','a fresh observation could not retry after a no-intent GET failure');
  assert.equal(f.posts.length,2);assert.equal(f.store.data.killSwitch,false);
});

test('saving the IOC close intent still halts before POST even when no IOC order has been created yet',async t=>{
  const f=fixture();t.after(()=>f.stop());f.engine.autoEnabled=true;let failures=0;
  f.store.save=()=>{if(f.p.closeRequestedAt!==undefined&&failures++===0)
    throw Object.assign(new Error('MEMORY durable IOC close write failed'),{syscall:'write',code:'EIO'});};
  f.wake();await until(()=>f.store.data.killSwitch,'durable close write failure was softened as a no-order preflight wait');
  await f.engine.execution.waitIocProfitClose(f.p);
  assert.equal(f.engine.autoEnabled,false);assert.equal(f.posts.length,0);
  assert.equal(f.store.data.orders.filter(order=>order.request.reduceOnly).length,0);
  assert.deepEqual([f.p.long.quantity,f.p.short.quantity,f.p.feesUsd],[100,100,.1]);
  assert.equal(f.p.status,'attention');
});
