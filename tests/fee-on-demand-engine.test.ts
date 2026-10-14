import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../src/core/engine.js';
import type {Store} from '../src/core/store.js';
import {defaultConfig} from '../src/shared/config.js';
import {automaticEntryCandidateReady} from '../src/shared/automatic-entry-policy.js';
import {evaluateHoldingDecision} from '../src/core/holding-decision.js';
import {profitExitPolicy} from '../src/core/profit-exit.js';
import type {AccountState,ExchangeAdapter,ExchangeId,MakerReductionObservation,MarketSnapshot,OrderRequest,OrderResult,Position,TradingFeeMetadata} from '../src/shared/types.js';

const exchanges:ExchangeId[]=['gate','bybit'],symbol='BTC/USDT:USDT';
const environment={ALLOW_LIVE_TRADING:'true',LIVE_TRADING_ACK:'I_UNDERSTAND_THE_RISKS',
  GATE_API_KEY:'OFFLINE-ON-DEMAND',GATE_API_SECRET:'OFFLINE-ON-DEMAND',BYBIT_API_KEY:'OFFLINE-ON-DEMAND',BYBIT_API_SECRET:'OFFLINE-ON-DEMAND'};
type FeeMode='normal'|'missing'|'high';
function fixture(mode:FeeMode='normal'){
  const settledAt=Date.now()+120_000;
  const config={...defaultConfig,mode:'live' as const,dataSource:'public' as const,entryPolicy:'aligned' as const,
    exchanges,symbols:['BTC'],orderNotionalUsd:100,holdMode:'adaptive' as const,maxEntryBatches:1,maxOrderRetries:0};
  const store={data:{version:1,config,positions:[],orders:[],logs:[],equity:[],killSwitch:false,fundingSeen:[]},save(){},log(){}} as unknown as Store;
  const native=new Map<ExchangeId,TradingFeeMetadata>(),accounts=new Map<ExchangeId,AccountState>(exchanges.map(id=>[id,{freeUsd:1000,equityUsd:1000,positions:[]}]));
  const fees:Array<{exchange:ExchangeId;symbol:string}>=[],orders:Array<{exchange:ExchangeId;request:OrderRequest;native:TradingFeeMetadata}>=[];
  const makers=new Map<string,{exchange:ExchangeId;request:OrderRequest;id:string;filled:number;cancelled:boolean}>();
  let inspections=0,preparations=0;
  const quote=(exchange:ExchangeId,changes:Partial<MarketSnapshot>={}):MarketSnapshot=>({exchange,base:'BTC',symbol,
    source:'public',timestamp:Date.now(),observedAt:Date.now(),fundingObservedAt:Date.now(),bookTransport:'websocket',
    markPrice:100,indexPrice:100,fundingRate:exchange==='bybit'?.005:0,nextFundingTime:settledAt,intervalHours:8,fundingHistory:[],
    bids:[{price:exchange==='gate'?99.99:100.5,quantity:10}],asks:[{price:exchange==='gate'?100:100.51,quantity:10}],
    openInterestUsd:1e8,volume24hUsd:1e8,quantityStep:.001,minQuantity:.001,minNotional:5,contractSize:1,
    feeProfile:'standard',...changes});
  const adapters=exchanges.map(id=>({id,supportsMakerReduction:()=>true,fetchSnapshots:async()=>[quote(id)],fetchExecutionSnapshots:async()=>[quote(id)],
    fetchAccount:async()=>structuredClone(accounts.get(id)!),fetchFundingPayments:async()=>[],setRealtimeBases(){},
    inspectTrading:async()=>{inspections++;},prepareTrading:async()=>{preparations++;},
    validateOrder:async(request:OrderRequest)=>{assert.notEqual(request.postOnly,true);},
    validateMakerReduction:async(request:OrderRequest)=>{assert.equal(request.reduceOnly,true);assert.equal(request.postOnly,true);},
    fetchTradingFee:async(requestedSymbol:string)=>{
      fees.push({exchange:id,symbol:requestedSymbol});assert.equal(requestedSymbol,symbol);
      if(mode==='missing')return;
      const value={takerFeeSource:'exchange' as const,takerFeeAt:Date.now(),takerFeeRate:mode==='high'?.005:id==='bybit'?.00055:.0005,
        makerFeeSource:'exchange' as const,makerFeeAt:Date.now(),makerFeeRate:mode==='high'?.005:.0002};
      native.set(id,value);return value;
    },cachedTradingFee:()=>native.get(id),
    submitMakerReduction:async(request:OrderRequest,canSubmit?:()=>boolean):Promise<OrderResult>=>{
      assert.equal(request.reduceOnly,true);assert.equal(request.postOnly,true);
      const fee=native.get(id);assert.ok(fee,'the exact account fee must exist before a Maker order');
      assert.equal(fee.makerFeeSource,'exchange');assert.ok(Number.isFinite(fee.makerFeeRate));
      if(canSubmit&&!canSubmit())return {id:'',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,
        averagePrice:0,feeUsd:0,rejectionCode:'MAKER_REDUCTION_PERMISSION_CHANGED',rejectionReason:'Offline final submission guard veto',timestamp:Date.now()};
      orders.push({exchange:id,request:{...request},native:{...fee}});
      const orderId=`offline-fee-maker-${orders.length}`;
      makers.set(request.clientOrderId,{exchange:id,request:{...request},id:orderId,filled:0,cancelled:false});
      return {id:orderId,clientOrderId:request.clientOrderId,status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:NaN,timestamp:Date.now()};
    },
    inspectMakerReduction:async(request:OrderRequest,orderId?:string):Promise<MakerReductionObservation>=>{
      const maker=makers.get(request.clientOrderId);assert.ok(maker);assert.equal(orderId,maker.id);assert.equal(maker.exchange,id);
      const quantity=maker.cancelled?maker.filled:request.quantity,fee=native.get(id)!;
      if(quantity>maker.filled){
        const row=accounts.get(id)!.positions.find(row=>row.symbol===request.symbol)!;row.quantity-=quantity-maker.filled;maker.filled=quantity;
      }
      return {activity:'terminal',executionVerified:true,observedAt:Date.now(),result:{id:maker.id,clientOrderId:request.clientOrderId,
        status:quantity===request.quantity?'filled':quantity?'partial':'cancelled',filledQuantity:quantity,
        averagePrice:quantity?request.limitPrice:0,averagePriceVerified:true,feeUsd:quantity*request.limitPrice*fee.makerFeeRate!,timestamp:Date.now()}};
    },
    cancelMakerReduction:async(request:OrderRequest,orderId:string)=>{
      const maker=makers.get(request.clientOrderId);assert.ok(maker);assert.equal(orderId,maker.id);maker.cancelled=true;
    },
    placeOrder:async(request:OrderRequest)=>{
      assert.notEqual(request.postOnly,true,'Maker reductions must use the dedicated native interface');
      const fee=native.get(id);assert.ok(fee,'the exact account fee must exist before any new order');
      orders.push({exchange:id,request:{...request},native:{...fee}});
      const account=accounts.get(id)!,side=id==='gate'?'long':'short';
      if(request.reduceOnly)account.positions=[];
      else account.positions=[{base:'BTC',symbol,side,quantity:request.quantity,markPrice:100,entryPrice:request.limitPrice,liquidationPrice:0,leverage:2}];
      return {id:`offline-fee-order-${orders.length}`,clientOrderId:request.clientOrderId,status:'filled' as const,
        filledQuantity:request.quantity,averagePrice:request.limitPrice,feeUsd:request.quantity*request.limitPrice*fee.takerFeeRate,timestamp:Date.now()};
    },reconcileOrder:async()=>{throw new Error('Unexpected offline reconciliation');},cancelOrder:async()=>{},close:async()=>{},
  } as ExchangeAdapter));
  const engine=new Engine(store,true,{adapterFactory:()=>adapters,liveEnvironment:environment});
  const internal=engine as any;
  engine.health=exchanges.map(exchange=>({exchange,status:'online',latencyMs:0,lastSuccess:Date.now(),accountStatus:'ready',accountUpdatedAt:Date.now()}));
  for(const [id,account] of accounts)engine.accounts.set(id,structuredClone(account));
  engine.snapshots=exchanges.map(id=>quote(id));
  // Mature genuine independent public-funding observations without any account-fee or financial request.
  // These tests isolate on-demand fee behavior after the new entry-only confirmation has passed.
  const confirmFunding=()=>{
    const confirmationNow=Date.now();
    for(const age of [180_000,135_000,90_000,45_000,0]){
      const observedAt=confirmationNow-age;
      engine.snapshots=exchanges.map(id=>quote(id,{timestamp:observedAt,observedAt,fundingObservedAt:observedAt}));
      internal.detailedOpportunities(observedAt);
    }
  };
  confirmFunding();
  const held=(policy:'aligned'|'dual'='aligned'):Position=>{
    const now=Date.now(),p:Position={id:'held-fee-on-demand',base:'BTC',mode:'live',status:'open',entryPolicy:policy,holdMode:'adaptive',openedAt:now-1000,plannedExitAt:settledAt+10_000,
      long:{exchange:'gate',symbol,side:'long',quantity:1,entryPrice:100,markPrice:100,feesUsd:.05,liquidationDistancePct:null},
      short:{exchange:'bybit',symbol,side:'short',quantity:1,entryPrice:100.5,markPrice:100,feesUsd:.05,liquidationDistancePct:null},
      fundingUsd:.1,feesUsd:.1,transferCostUsd:0,realizedSpreadPnlUsd:0,spreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[]};
    if(policy==='aligned')p.profitExitPolicy=profitExitPolicy(engine.snapshots[0],engine.snapshots[1],config);
    store.data.positions.push(p);
    for(const id of exchanges){
      accounts.get(id)!.positions=[{base:'BTC',symbol,side:id==='gate'?'long':'short',quantity:1,markPrice:100,liquidationPrice:0,leverage:2}];
      engine.accounts.set(id,structuredClone(accounts.get(id)!));
    }
    return p;
  };
  return {engine,internal,store,adapters,accounts,fees,orders,native,quote,held,confirmFunding,counts:()=>({inspections,preparations}),stop:()=>engine.stop()};
}

test('public scans, account previews and automatic preparation make no private fee reads',async()=>{
  const f=fixture();try{
    await f.engine.tick();assert.equal(f.fees.length,0);
    const now=Date.now();
    await f.engine.observeAccountClosures({timestamp:now,pollIntervalMs:5000,maxAgeMs:15000,exchanges:exchanges.map(exchange=>({exchange,
      credentialsConfigured:true,status:'ready',requestedAt:now,receivedAt:now,lastSuccessAt:now,positions:[],freeUsd:1000,equityUsd:1000}))});
    await f.internal.refreshEntryContractPreviews();assert.equal(f.fees.length,0);
    const candidates=f.engine.currentOpportunities();assert.ok(candidates.some(automaticEntryCandidateReady),'reference estimates still produce an automatic candidate');
    f.engine.autoEnabled=true;await f.internal.warmRealtimeEntries();f.engine.autoEnabled=false;
    assert.ok(f.counts().inspections>=2);assert.ok(f.counts().preparations>=2,'the ordinary preparation path actually ran');
    assert.ok(f.internal.realtimePrepared.size>0);assert.equal(f.fees.length,0);assert.equal(f.orders.length,0);
  }finally{await f.stop();}
});

test('a reference candidate obtains both exact native fees before any actual opening order',async()=>{
  const f=fixture();try{
    const candidate=f.engine.currentOpportunities().find(automaticEntryCandidateReady)!;
    assert.ok(candidate);assert.equal(candidate.feesSource,'reference');assert.equal(f.native.size,0);assert.equal(f.fees.length,0);
    f.engine.autoEnabled=true;const p=await f.internal.openInternal(candidate.id,true);f.engine.autoEnabled=false;
    assert.equal(p.status,'open',JSON.stringify({closeReason:p.closeReason,stop:p.entryExecution?.stopReason,risk:p.riskReasons,orders:f.orders.length}));assert.equal(f.orders.length,2);
    assert.deepEqual([...new Set(f.fees.map(value=>value.exchange))].sort(),[...exchanges].sort());
    assert.ok(f.fees.every(value=>value.symbol===symbol));assert.ok(f.orders.every(value=>value.request.reduceOnly===false));
    assert.equal(f.store.data.orders.length,2);
    for(const order of f.store.data.orders)assert.equal(order.executionEvidence?.nativeTakerFeeRate,order.exchange==='bybit'?.00055:.0005);
  }finally{await f.stop();}
});

test('missing native fees and actual high fees block reference-qualified automatic openings',async()=>{
  for(const mode of ['missing','high'] as const){
    const f=fixture(mode);try{
      const candidate=f.engine.currentOpportunities().find(automaticEntryCandidateReady)!;assert.ok(candidate,mode);assert.equal(candidate.feesSource,'reference');
      f.engine.autoEnabled=true;await assert.rejects(f.internal.openInternal(candidate.id,true),mode==='missing'?/手续费/:/自动开仓|复核|净收益/);f.engine.autoEnabled=false;
      assert.deepEqual([...new Set(f.fees.map(value=>value.exchange))].sort(),[...exchanges].sort());
      assert.equal(f.orders.length,0);assert.equal(f.store.data.orders.length,0);assert.equal(f.store.data.positions.length,0);
    }finally{await f.stop();}
  }
});

test('warm account/contract preflight cannot bypass native fees on the eventual opening action',async()=>{
  const f=fixture('missing');try{
    const candidate=f.engine.currentOpportunities().find(automaticEntryCandidateReady)!;assert.ok(candidate);
    f.engine.autoEnabled=true;await f.internal.warmRealtimeEntries();assert.equal(f.fees.length,0);
    const prepared=f.internal.realtimePrepared.get(candidate.id)?.context;assert.ok(prepared);
    await assert.rejects(f.internal.openInternal(candidate.id,true,prepared),/手续费/);
    assert.equal(f.fees.length,2);assert.equal(f.orders.length,0);assert.equal(f.store.data.orders.length,0);
  }finally{await f.stop();}
});

test('a crossed financial epoch refreshes warm evidence and the accepted entry still completes its own hedge',async()=>{
  const f=fixture();try{
    const candidate=f.engine.currentOpportunities().find(automaticEntryCandidateReady)!;assert.ok(candidate);
    f.engine.autoEnabled=true;await f.internal.warmRealtimeEntries();
    const old=f.internal.realtimePrepared.get(candidate.id);assert.ok(old);
    f.internal.financialEpoch++;
    for(const account of f.accounts.values()){account.freeUsd=777;account.equityUsd=777;}
    await f.internal.warmRealtimeEntries();
    const proof=f.internal.realtimePrepared.get(candidate.id);assert.ok(proof);assert.notEqual(proof,old);
    assert.equal(proof.financialEpoch,f.internal.financialEpoch);
    assert.equal(proof.context.preflight.accounts.get('gate').freeUsd,777);
    assert.equal(f.engine.accounts.get('gate')!.freeUsd,777);
    assert.equal(f.fees.length,0,'refreshing the native account proof still does not request private fees');
    const originalEpoch=f.internal.financialEpoch,preparations=f.counts().preparations;
    const p=await f.internal.openInternal(candidate.id,true,proof.context);
    assert.equal(p.status,'open',JSON.stringify({risk:p.riskReasons,stop:p.entryExecution?.stopReason}));
    assert.equal(f.orders.length,2);assert.equal(p.long.quantity,p.short.quantity);
    assert.ok(f.internal.financialEpoch>originalEpoch,'first submit changed the epoch without revoking its own peer continuation');
    assert.equal(f.counts().preparations,preparations,'the accepted proof retains its prepared contract settings');
    assert.equal(f.internal.realtimePrepared.size,0,'first submit invalidates warm evidence for other entries');
    assert.ok(f.orders.every(order=>order.request.reduceOnly===false));
  }finally{await f.stop();}
});

test('ordinary positive funding below the accrued-profit exit threshold does not fetch account fees',async()=>{
  for(const policy of ['aligned','dual'] as const){
    const f=fixture();try{
      const p=f.held(policy);f.store.data.config.adaptiveConfirmations=1;
      assert.equal(evaluateHoldingDecision(p,f.engine.snapshots[0],f.engine.snapshots[1],f.engine.config,Date.now(),false).action,'hold');
      await f.internal.managePositions(Date.now());assert.equal(p.status,'open');assert.equal(f.fees.length,0);assert.equal(f.orders.length,0);
    }finally{await f.stop();}
  }
});

test('aligned accrued profit obtains both native fees immediately while positive funding remains',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});
  const f=fixture();try{
    const p=f.held();
    const quotes=()=>[f.quote('gate',{bids:[{price:100.20,quantity:10}],asks:[{price:100.21,quantity:10}]}),
      f.quote('bybit',{bids:[{price:100.29,quantity:10}],asks:[{price:100.30,quantity:10}]})];
    f.engine.snapshots=quotes();
    for(const adapter of f.adapters)adapter.fetchExecutionSnapshots=async()=>[quotes().find(value=>value.exchange===adapter.id)!];
    const preview=evaluateHoldingDecision(p,f.engine.snapshots[0],f.engine.snapshots[1],f.engine.config,Date.now(),false);
    assert.equal(preview.exitSignal,'profit');assert.ok(preview.expectedFundingUsd>0);assert.ok(preview.exitProfit!.netPnlUsd>.1);
    await f.internal.managePositions(Date.now());
    await f.engine.execution.waitMakerClose(p);
    assert.equal(f.fees.length,4,'The same management turn checks both native fees for the candidate and the submitted batch');
    assert.equal(p.status,'closed');assert.equal(f.orders.length,2);assert.equal(f.store.data.orders.length,2);
    assert.ok(f.orders.every(order=>order.request.reduceOnly&&order.request.quantity===1));
    assert.deepEqual(f.orders.map(order=>[order.exchange,order.request.side,order.request.postOnly===true]),[['gate','sell',true],['bybit','buy',false]]);
    assert.equal(f.orders[0].request.limitPrice,100.21);assert.equal(f.orders[1].request.limitPrice,100.30);
    assert.equal(f.store.data.orders[0].executionEvidence?.nativeMakerFeeRate,.0002);
    assert.equal(p.long.quantity,0);assert.equal(p.short.quantity,0);assert.ok(p.netPnlUsd>.1);
  }finally{await f.stop();}
});

test('aligned immediate reference-profit exits retain holdings when native fees are missing or remove profit',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});
  for(const mode of ['missing','high'] as const){
    const f=fixture(mode);try{
      const p=f.held();
      const quotes=()=>[f.quote('gate',{bids:[{price:100.20,quantity:10}],asks:[{price:100.21,quantity:10}]}),
        f.quote('bybit',{bids:[{price:100.29,quantity:10}],asks:[{price:100.30,quantity:10}]})];
      f.engine.snapshots=quotes();
      for(const adapter of f.adapters)adapter.fetchExecutionSnapshots=async()=>[quotes().find(value=>value.exchange===adapter.id)!];
      assert.equal(evaluateHoldingDecision(p,f.engine.snapshots[0],f.engine.snapshots[1],f.engine.config,Date.now(),false).exitSignal,'profit');
      await f.internal.managePositions(Date.now());
      assert.equal(f.fees.length,2,mode);assert.equal(p.status,'open',mode);
      assert.equal(p.holdDecision?.action,mode==='missing'?'wait':'hold',mode);
      assert.equal(p.closeRequestedAt,undefined,mode);assert.equal(f.orders.length,0,mode);assert.equal(f.store.data.orders.length,0,mode);
      assert.equal(p.long.quantity,1,mode);assert.equal(p.short.quantity,1,mode);
    }finally{await f.stop();}
  }
});

test('legacy exit preview counts distinct quotes across native waits and cannot authorize closing from reference profit',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});
  const f=fixture('missing');try{
    const p=f.held('dual');f.store.data.config.entryPolicy='dual';f.store.data.config.adaptiveConfirmations=3;
    p.profitExitPolicy={firstFundingTime:Date.now()-10_000,earliestExitAt:Date.now()-1000,minSpreadNetUsd:0,minCombinedNetUsd:.05,fundingChecks:[]};
    const update=()=>{f.engine.snapshots=[f.quote('gate',{bids:[{price:100.10,quantity:10}],asks:[{price:100.11,quantity:10}]}),
      f.quote('bybit',{fundingRate:.02,bids:[{price:100.39,quantity:10}],asks:[{price:100.40,quantity:10}]})];};
    update();assert.equal(evaluateHoldingDecision(p,f.engine.snapshots[0],f.engine.snapshots[1],f.engine.config,Date.now(),false).exitSignal,'profit');
    for(let i=0;i<3;i++)await f.internal.managePositions(Date.now());assert.equal(f.fees.length,0,'reusing the same quote cannot satisfy confirmations');
    t.mock.timers.tick(1000);update();await f.internal.managePositions(Date.now());assert.equal(f.fees.length,0);
    t.mock.timers.tick(1000);update();await f.internal.managePositions(Date.now());
    assert.equal(f.fees.length,2,'the third independent preview must reach its explicit native fee check');
    assert.equal(p.status,'open');assert.equal(p.holdDecision?.action,'wait');assert.equal(p.closeRequestedAt,undefined);assert.equal(f.orders.length,0);
  }finally{await f.stop();}
});

test('a reference profit candidate is retained when actual native closing fees remove its profit',async()=>{
  const f=fixture('high');try{
    const p=f.held('dual');f.store.data.config.entryPolicy='dual';f.store.data.config.adaptiveConfirmations=1;
    p.profitExitPolicy={firstFundingTime:Date.now()-10_000,earliestExitAt:Date.now()-1000,minSpreadNetUsd:0,minCombinedNetUsd:.05,fundingChecks:[]};
    const long=f.quote('gate',{bids:[{price:100.10,quantity:10}],asks:[{price:100.11,quantity:10}]}),
      short=f.quote('bybit',{fundingRate:.02,bids:[{price:100.39,quantity:10}],asks:[{price:100.40,quantity:10}]});
    f.engine.snapshots=[long,short];
    for(const adapter of f.adapters)adapter.fetchExecutionSnapshots=async()=>[adapter.id==='gate'?{...long,timestamp:Date.now(),observedAt:Date.now()}:{...short,timestamp:Date.now(),observedAt:Date.now()}];
    assert.equal(evaluateHoldingDecision(p,long,short,f.engine.config,Date.now(),false).exitSignal,'profit');
    await f.internal.managePositions(Date.now());assert.equal(f.fees.length,2);
    assert.equal(p.status,'open');assert.equal(p.holdDecision?.action,'hold');assert.equal(p.closeRequestedAt,undefined);assert.equal(f.orders.length,0);assert.equal(f.store.data.orders.length,0);
  }finally{await f.stop();}
});

test('aligned loss exits obtain native fees only after the original funding stability window and recheck real costs',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});
  const f=fixture('high');try{
    const p=f.held(),paymentAt=Date.now()+240_000;p.short.entryPrice=100;
    const quotes=()=>[f.quote('gate',{nextFundingTime:paymentAt,bids:[{price:99.99,quantity:10}],asks:[{price:100,quantity:10}]}),
      f.quote('bybit',{nextFundingTime:paymentAt,fundingRate:-.005,bids:[{price:100.01,quantity:10}],asks:[{price:100.02,quantity:10}]})];
    f.engine.snapshots=quotes();p.profitExitPolicy=profitExitPolicy(f.engine.snapshots[0],f.engine.snapshots[1],f.engine.config);
    for(const adapter of f.adapters)adapter.fetchExecutionSnapshots=async()=>[quotes().find(value=>value.exchange===adapter.id)!];
    assert.equal(evaluateHoldingDecision(p,f.engine.snapshots[0],f.engine.snapshots[1],f.engine.config,Date.now(),false).exitSignal,'funding-loss');
    for(let sample=0;sample<5;sample++){
      if(sample)t.mock.timers.tick(45_000);f.engine.snapshots=quotes();await f.internal.managePositions(Date.now());
      if(sample<4)assert.equal(f.fees.length,0,`sample ${sample+1} cannot start native fee preparation`);
    }
    assert.equal(f.fees.length,2,'five independent funding samples over three minutes reach preparation');
    assert.equal(p.status,'open');assert.equal(p.holdDecision?.exitSignal,undefined);assert.equal(p.closeRequestedAt,undefined);
    assert.equal(f.orders.length,0);assert.equal(f.store.data.orders.length,0);
  }finally{await f.stop();}
});

test('local rebates preserve authenticated clients and real cash; observations do not fetch private fees',async()=>{
  const f=fixture();try{
    const p=f.held(),clients=[...f.internal.adapters],before=structuredClone(p),balance=f.engine.totals().availableBalanceUsd;
    await f.engine.updateConfig({feeRebatePct:{gate:70,bitget:50}});
    assert.deepEqual(f.internal.adapters,clients);assert.equal(f.engine.liveUnlocked,true);
    assert.equal(f.engine.autoEnabled,false);assert.equal(f.engine.totals().availableBalanceUsd,balance);
    const state=f.engine.state(),row=state.positions.find(row=>row.id===p.id)!;
    assert.ok(Math.abs(row.estimatedFeeRebateUsd!-.035)<1e-12);
    assert.ok(Math.abs(row.estimatedNetPnlAfterRebateUsd!-(p.netPnlUsd+.035))<1e-12);
    assert.equal(p.estimatedFeeRebateUsd,undefined);assert.equal(p.estimatedNetPnlAfterRebateUsd,undefined);
    assert.equal(p.feesUsd,before.feesUsd);assert.equal(p.netPnlUsd,before.netPnlUsd);
    f.engine.currentOpportunities();await f.internal.refreshEntryContractPreviews();
    assert.equal(f.fees.length,0);assert.equal(f.orders.length,0);
  }finally{await f.stop();}
});

test('even100 percent rebates require actual native fees before an opening action',async()=>{
  const f=fixture('missing');try{
    await f.engine.updateConfig({feeRebatePct:{gate:100,bybit:100}});
    f.confirmFunding();
    const candidate=f.engine.currentOpportunities().find(automaticEntryCandidateReady)!;assert.ok(candidate);
    f.engine.autoEnabled=true;await assert.rejects(f.internal.openInternal(candidate.id,true),/手续费/);
    assert.equal(f.fees.length,2);assert.equal(f.orders.length,0);assert.equal(f.store.data.orders.length,0);
  }finally{await f.stop();}
});

test('rebate-qualified10bps opposite-price profit passes durable Maker submission and books native gross fees',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fixture();try{
    const p=f.held();await f.engine.updateConfig({feeRebatePct:{gate:70,bitget:50},minExitProfitBps:10});
    p.profitExitNotionalUsd=100;
    for(const leg of [p.long,p.short]){const clientOrderId=`rebate-open-${leg.exchange}`;
      f.store.data.orders.push({positionId:p.id,exchange:leg.exchange,createdAt:p.openedAt,request:{clientOrderId,base:p.base,symbol:leg.symbol,
        side:leg.side==='long'?'buy':'sell',quantity:1,limitPrice:leg.entryPrice,reduceOnly:false},result:{id:clientOrderId,clientOrderId,
          status:'filled',filledQuantity:1,averagePrice:leg.entryPrice,averagePriceVerified:true,feeUsd:leg.feesUsd,timestamp:p.openedAt}});}
    const quotes=()=>[f.quote('gate',{bids:[{price:99.99,quantity:10}],asks:[{price:100.01,quantity:10}]}),
      f.quote('bybit',{bids:[{price:100.29,quantity:10}],asks:[{price:100.30,quantity:10}]})];
    f.engine.snapshots=quotes();for(const adapter of f.adapters)adapter.fetchExecutionSnapshots=async()=>[quotes().find(value=>value.exchange===adapter.id)!];
    const plain=evaluateHoldingDecision(p,f.engine.snapshots[0],f.engine.snapshots[1],{...f.engine.config,feeRebatePct:undefined},Date.now(),false);
    assert.equal(plain.exitSignal,undefined);assert.ok(plain.exitProfit!.netPnlUsd<.1);
    await f.internal.managePositions(Date.now());await f.engine.execution.waitMakerClose(p);
    assert.equal(p.status,'closed');assert.equal(f.orders.length,2);assert.equal(f.store.data.orders.length,4);
    assert.equal(f.orders[0].request.postOnly,true);assert.equal(f.orders[1].request.postOnly,undefined);
    const maker=f.store.data.orders.find(order=>order.request.postOnly)!;
    assert.deepEqual(maker.makerCloseComparison!.feeRebatePct,{maker:70,peer:0});
    assert.equal(maker.executionEvidence!.nativeMakerFeeRate,.0002);
    const grossFees=.1+100.01*.0002+100.30*.00055;
    assert.ok(Math.abs(p.feesUsd-grossFees)<1e-12);
    const rebate=f.engine.state().positions.find(row=>row.id===p.id)!.estimatedFeeRebateUsd!;
    assert.ok(Math.abs(rebate-(.05+100.01*.0002)*.7)<1e-12);
    assert.equal(p.estimatedFeeRebateUsd,undefined);
  }finally{await f.stop();}
});
