import assert from 'node:assert/strict';
import test from 'node:test';
import {Engine} from '../src/core/engine.js';
import {FundingEntryStabilityTracker} from '../src/core/funding-entry-stability.js';
import {calculateOpportunities} from '../src/core/strategy.js';
import type {Store} from '../src/core/store.js';
import {defaultConfig} from '../src/shared/config.js';
import {evaluateHoldingDecision} from '../src/core/holding-decision.js';
import type {AccountState,AppConfig,ExchangeAdapter,ExchangeId,MarketSnapshot,Opportunity,OrderRequest,OrderResult,Position,TradingFeeMetadata} from '../src/shared/types.js';

const NOW=Date.UTC(2026,9,10,7),base='FLOWPROFIT',symbol=`${base}/USDT:USDT`;
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
async function until(check:()=>boolean,label:string){
  for(let attempt=0;attempt<80;attempt++){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.fail(label);
}
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));

/** Real Engine/Execution with every quote, native read, receipt and cash value held in memory. */
function fixture(options:{maker?:boolean;missingFees?:boolean;permission?:boolean;extraVenue?:boolean;maintenance?:boolean}={}){
  const exchanges:ExchangeId[]=options.extraVenue?['gate','bybit','binance']:['gate','bybit'];
  const config:AppConfig={...structuredClone(defaultConfig),mode:'live',dataSource:'public',entryPolicy:'aligned',
    exchanges,symbols:[base],holdMode:'adaptive',minExitProfitBps:10,pollIntervalMs:5000,maxOrderRetries:0};
  const store={data:{version:1,config,positions:[],orders:[],logs:[],equity:[],killSwitch:false,fundingSeen:[]},
    save(){},log(){}} as unknown as Store;
  const quotes=new Map<ExchangeId,MarketSnapshot>(),fees=new Map<ExchangeId,TradingFeeMetadata>(),accounts=new Map<ExchangeId,AccountState>();
  const additionalQuotes=new Map<string,MarketSnapshot>();
  const callbacks=new Map<ExchangeId,(quote:MarketSnapshot)=>void>(),feeReads:ExchangeId[]=[],accountReads:ExchangeId[]=[];
  const orders:Array<{exchange:ExchangeId;request:OrderRequest}>=[],makers:Array<{exchange:ExchangeId;request:OrderRequest;id:string}>=[];
  for(const exchange of exchanges){
    const isLong=exchange==='gate';
    quotes.set(exchange,{exchange,base,symbol,source:'public',timestamp:Date.now(),observedAt:Date.now(),fundingObservedAt:Date.now(),
      bookTransport:'websocket',markPrice:1,indexPrice:1,fundingRate:isLong?0:.001,nextFundingTime:Date.now()+3_600_000,intervalHours:8,
      fundingHistory:[],bids:[{price:isLong?1.006:.998,quantity:options.maker?25:100}],
      asks:[{price:isLong?1.016:1,quantity:options.maker?25:100}],quantityStep:1,minQuantity:1,minNotional:5,contractSize:1,
      openInterestUsd:1e6,volume24hUsd:1e6,feeProfile:'standard'});
    if(!options.missingFees)fees.set(exchange,{takerFeeRate:.0005,takerFeeAt:Date.now(),takerFeeSource:'exchange',
      makerFeeRate:.0002,makerFeeAt:Date.now(),makerFeeSource:'exchange'});
    accounts.set(exchange,{freeUsd:1000,equityUsd:1000,positions:exchange==='binance'?[]:[{base,symbol,side:isLong?'long':'short',
      quantity:100,entryPrice:1,markPrice:1,liquidationPrice:0,leverage:2}]});
  }
  const snapshot=(exchange:ExchangeId,requestedBase=base)=>requestedBase===base?quotes.get(exchange):additionalQuotes.get(`${exchange}:${requestedBase}`);
  const accountRow=(exchange:ExchangeId,requestedBase:string)=>accounts.get(exchange)!.positions.find(row=>row.base===requestedBase)!;
  const adapters=exchanges.map(exchange=>({id:exchange,startRealtime:(callback:(quote:MarketSnapshot)=>void)=>{callbacks.set(exchange,callback);},
    setRealtimeBases(){},getExecutionSnapshot:(requestedBase:string)=>snapshot(exchange,requestedBase),
    fetchSnapshots:async(requestedBases:string[])=>requestedBases.map(requestedBase=>snapshot(exchange,requestedBase)!).filter(Boolean),
    fetchExecutionSnapshots:async(requestedBases:string[])=>requestedBases.map(requestedBase=>snapshot(exchange,requestedBase)!).filter(Boolean),fetchFundingPayments:async()=>[],
    fetchAccount:async()=>{accountReads.push(exchange);return structuredClone(accounts.get(exchange)!);},
    fetchTradingFee:async()=>{feeReads.push(exchange);if(!options.missingFees)return fees.get(exchange);
      const fee:TradingFeeMetadata={takerFeeRate:.0005,takerFeeAt:Date.now(),takerFeeSource:'exchange',makerFeeRate:.0002,makerFeeAt:Date.now(),makerFeeSource:'exchange'};
      fees.set(exchange,fee);return fee;},cachedTradingFee:()=>fees.get(exchange),
    inspectTrading:async()=>{},prepareTrading:async()=>{},validateOrder:async()=>{},validateMakerReduction:async()=>{},
    supportsMakerReduction:()=>options.maker!==false,
    submitMakerReduction:async(request:OrderRequest,canSubmit?:()=>boolean):Promise<OrderResult>=>{
      assert.equal(canSubmit?.(),true);const id=`MEMORY-MAKER-${makers.length+1}`;
      makers.push({exchange,request:{...request},id});
      return {id,clientOrderId:request.clientOrderId,status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:NaN,timestamp:Date.now()};
    },inspectMakerReduction:async(request:OrderRequest,id?:string)=>{
      const maker=makers.find(value=>value.request.clientOrderId===request.clientOrderId)!;assert.equal(id,maker.id);
      accountRow(exchange,request.base).quantity-=request.quantity;
      return {activity:'terminal' as const,executionVerified:true,observedAt:Date.now(),result:{id:maker.id,clientOrderId:request.clientOrderId,
        status:'filled' as const,filledQuantity:request.quantity,averagePrice:request.limitPrice,averagePriceVerified:true,
        feeUsd:request.quantity*request.limitPrice*.0002,timestamp:Date.now()}};
    },cancelMakerReduction:async()=>{},
    placeOrder:async(request:OrderRequest):Promise<OrderResult>=>{
      assert.equal(request.reduceOnly,true);assert.notEqual(request.postOnly,true);orders.push({exchange,request:{...request}});
      accountRow(exchange,request.base).quantity-=request.quantity;
      return {id:`MEMORY-IOC-${orders.length}`,clientOrderId:request.clientOrderId,status:'filled',filledQuantity:request.quantity,
        averagePrice:request.limitPrice,averagePriceVerified:true,feeUsd:request.quantity*request.limitPrice*fees.get(exchange)!.takerFeeRate!,timestamp:Date.now()};
    },reconcileOrder:async()=>{throw new Error('Unexpected general reconciliation');},cancelOrder:async()=>{throw new Error('Unexpected general cancellation');},close:async()=>{}
  } as ExchangeAdapter));
  const engine=new Engine(store,options.permission!==false,{adapterFactory:()=>adapters,...(options.maintenance?{maintenanceExchanges:exchanges}:{}),liveEnvironment:{ALLOW_LIVE_TRADING:'true',
    LIVE_TRADING_ACK:'I_UNDERSTAND_THE_RISKS',GATE_API_KEY:'MEMORY',GATE_API_SECRET:'MEMORY',BYBIT_API_KEY:'MEMORY',BYBIT_API_SECRET:'MEMORY',
    BINANCE_API_KEY:'MEMORY',BINANCE_API_SECRET:'MEMORY'}});
  const p:Position={id:'flow-profit',base,mode:'live',entryPolicy:'aligned',holdMode:'adaptive',status:'open',openedAt:Date.now()-1000,
    plannedExitAt:Date.now()+3_610_000,profitExitNotionalUsd:100,
    long:{exchange:'gate',symbol,side:'long',quantity:100,entryPrice:1,markPrice:1,feesUsd:.05,liquidationDistancePct:null},
    short:{exchange:'bybit',symbol,side:'short',quantity:100,entryPrice:1,markPrice:1,feesUsd:.05,liquidationDistancePct:null},
    fundingUsd:0,feesUsd:.1,transferCostUsd:0,realizedSpreadPnlUsd:0,spreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[],
    profitExitPolicy:{firstFundingTime:Date.now()+3_600_000,earliestExitAt:Date.now()+3_610_000,minSpreadNetUsd:0,minCombinedNetUsd:0,
      fundingChecks:['gate','bybit'].map(exchange=>({exchange:exchange as ExchangeId,timestamp:Date.now()+3_600_000}))}};
  store.data.positions.push(p);engine.snapshots=[...quotes.values()];
  for(const [exchange,account] of accounts){engine.accounts.set(exchange,structuredClone(account));const health=engine.health.find(value=>value.exchange===exchange)!;
    health.status='online';health.lastSuccess=Date.now();health.accountStatus='ready';health.accountUpdatedAt=Date.now()-500;}
  const internal=engine as any;engine.running=true;internal.bindRealtime();internal.detailedOpportunities=()=>[];
  const emit=()=>{for(const [exchange,quote] of quotes){const fresh={...quote,timestamp:Date.now(),observedAt:Date.now(),fundingObservedAt:Date.now()};
    quotes.set(exchange,fresh);callbacks.get(exchange)!(fresh);}};
  const setClosing=(quantity=80)=>{p.status='closing';p.long.quantity=quantity;p.short.quantity=quantity;p.closeRequestedAt=Date.now()-1000;
    p.closeAttemptedAt=Date.now();p.closeProfitRequired=true;p.closePricing='best-opposite';p.closeReason='MEMORY original profit intent';
    internal.continuingClosePositions.add(p.id);for(const exchange of ['gate','bybit'] as const)accounts.get(exchange)!.positions[0].quantity=quantity;};
  return {engine,internal,store,p,quotes,additionalQuotes,fees,accounts,adapters,feeReads,accountReads,orders,makers,emit,setClosing,
    settled:()=> (engine.execution as any).context.makerCloseSettled(p),stop:()=>engine.stop()};
}

function addIndependentPosition(f:ReturnType<typeof fixture>,otherBase='FLOWPARALLEL'){
  const other=structuredClone(f.p);other.id=`position-${otherBase}`;other.base=otherBase;
  other.long.symbol=other.short.symbol=`${otherBase}/USDT:USDT`;f.store.data.positions.push(other);
  for(const exchange of ['gate','bybit'] as const){
    const quote={...f.quotes.get(exchange)!,base:otherBase,symbol:other.long.symbol};
    f.additionalQuotes.set(`${exchange}:${otherBase}`,quote);f.engine.snapshots.push(quote);
    f.accounts.get(exchange)!.positions.push({...f.accounts.get(exchange)!.positions[0],base:otherBase,symbol:other.long.symbol});
  }
  return other;
}

test('all qualifying positions submit their Maker without waiting for the first native ACK',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture(),other=addIndependentPosition(f),ack=deferred<void>();
  const gate=f.adapters.find(adapter=>adapter.id==='gate')!,submit=gate.submitMakerReduction!;
  gate.submitMakerReduction=async(request,canSubmit)=>{const result=await submit(request,canSubmit);if(request.base===base)await ack.promise;return result;};
  t.after(async()=>{ack.resolve();await f.stop();});
  f.emit();await until(()=>f.makers.some(maker=>maker.request.base===other.base),'second Maker waited for the first native ACK');
  assert.ok(f.makers.some(maker=>maker.request.base===base));
  assert.ok(f.makers.every(maker=>maker.request.postOnly===true&&maker.request.reduceOnly));
  await until(()=>other.status==='closed','independent position did not close while first Maker ACK was delayed');
  assert.equal(f.p.long.quantity,100);assert.equal(f.p.short.quantity,100);
  assert.equal(f.orders.filter(order=>order.request.base===base).length,0);
  ack.resolve();await until(()=>f.p.status==='closed','first Maker failed after its native ACK resumed');
});

test('a delayed confirmed peer does not block another position Maker, peer, or the financial commit queue',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture(),other=addIndependentPosition(f),peer=deferred<void>();
  const bybit=f.adapters.find(adapter=>adapter.id==='bybit')!,place=bybit.placeOrder;
  bybit.placeOrder=async request=>{if(request.base===base)await peer.promise;return place(request);};
  t.after(async()=>{peer.resolve();await f.stop();});
  f.emit();await until(()=>f.p.long.quantity===0&&f.engine.execution.hasMakerClose(f.p),'first confirmed Maker fill did not dispatch its peer');
  await until(()=>other.status==='closed','independent position waited for another coin peer');
  assert.equal(await f.engine.exclusive(async()=> 'commit-free'),'commit-free');
  assert.equal(f.p.short.quantity,100);assert.ok(f.orders.filter(order=>order.request.base===other.base).length>0);
  assert.ok(f.orders.every(order=>order.exchange==='bybit'&&order.request.reduceOnly&&order.request.postOnly!==true));
  peer.resolve();await until(()=>f.p.status==='closed','delayed confirmed peer did not complete');
  assert.equal(f.orders.filter(order=>order.request.base===base).length,1,'a delayed peer must not be repeated');
});

test('a slow initial native Maker preparation does not delay another eligible position',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture(),other=addIndependentPosition(f),validation=deferred<void>();
  const gate=f.adapters.find(adapter=>adapter.id==='gate')!,validate=gate.validateMakerReduction!;
  gate.validateMakerReduction=async request=>{if(request.base===base)await validation.promise;await validate(request);};
  t.after(async()=>{validation.resolve();await f.stop();});
  f.emit();await until(()=>other.status==='closed','a slow initial preparation blocked another profit close');
  assert.equal(f.makers.filter(maker=>maker.request.base===base).length,0);
  assert.equal(await f.engine.exclusive(async()=>true),true);
  validation.resolve();await until(()=>f.p.status==='closed','prepared first position never resumed');
});

test('tick dispatches all qualifying Maker preparations without waiting for the first venue',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture(),other=addIndependentPosition(f),validation=deferred<void>();
  const gate=f.adapters.find(adapter=>adapter.id==='gate')!,validate=gate.validateMakerReduction!;
  gate.validateMakerReduction=async request=>{if(request.base===base)await validation.promise;await validate(request);};
  t.after(async()=>{validation.resolve();await f.stop();});
  await f.engine.tick();await until(()=>other.status==='closed','poll management serialized eligible Maker preparations');
  assert.equal(f.makers.filter(maker=>maker.request.base===base).length,0);assert.equal(f.engine.autoEnabled,false);
  validation.resolve();await until(()=>f.p.status==='closed','first poll-dispatched Maker never resumed');
});

test('unrelated financial activity preserves a selected close native proof without republishing its old account balance',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture(),read=deferred<AccountState>();f.setClosing();
  const packet=structuredClone(f.accounts.get('gate')!);packet.freeUsd=123;
  f.adapters[0].fetchAccount=async()=>{f.accountReads.push('gate');return read.promise;};
  t.after(async()=>{read.resolve(packet);await f.stop();});
  f.settled();await until(()=>f.accountReads.includes('gate'),'selected close did not acquire native accounts');
  f.internal.financialEpoch++;f.engine.accounts.set('gate',{...structuredClone(f.engine.accounts.get('gate')!),freeUsd:777});
  read.resolve(packet);await until(()=>f.p.status==='closed','another instrument invalidated an unchanged selected close proof');
  assert.equal(f.engine.accounts.get('gate')!.freeUsd,777,'old full account must never resurrect the balance used by entry or UI');
  assert.equal(f.internal.realtimeProfitAccountProofs.size,0);assert.equal(f.orders.length,1);
});

test('parallel matched continuations share one exact native account read per adapter',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture(),read=deferred<AccountState>();f.setClosing();
  f.p.closeAttemptedAt=NOW-6000;
  const other=addIndependentPosition(f);f.internal.continuingClosePositions.add(other.id);
  const packet=structuredClone(f.accounts.get('gate')!);
  f.adapters[0].fetchAccount=async()=>{f.accountReads.push('gate');return read.promise;};
  t.after(async()=>{read.resolve(packet);await f.stop();});
  f.emit();await until(()=>f.accountReads.includes('gate'),'matched continuations never requested actual holdings');
  await pause(20);assert.equal(f.accountReads.filter(exchange=>exchange==='gate').length,1);
  assert.equal(f.accountReads.filter(exchange=>exchange==='bybit').length,1);
  read.resolve(packet);await until(()=>f.p.status==='closed'&&other.status==='closed','one shared read blocked an independent continuation');
  assert.equal(f.makers.length,2);assert.equal(f.orders.length,2);assert.equal(f.internal.realtimeProfitAccountProofs.size,0);
});

test('a concurrent same-instrument journal mutation invalidates prepared Maker permission',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture(),validation=deferred<void>();let entered=false;
  const gate=f.adapters.find(adapter=>adapter.id==='gate')!,validate=gate.validateMakerReduction!;
  gate.validateMakerReduction=async request=>{entered=true;await validation.promise;await validate(request);};
  t.after(async()=>{validation.resolve();await f.stop();});
  f.emit();await until(()=>entered,'native Maker preparation was never entered');
  f.store.data.orders.push({positionId:'independent-owner',exchange:'gate',createdAt:Date.now(),
    request:{clientOrderId:'SAME-INSTRUMENT-OTHER',base,symbol,side:'sell',quantity:1,limitPrice:1.006,reduceOnly:true},
    result:{id:'SAME-INSTRUMENT-NATIVE',clientOrderId:'SAME-INSTRUMENT-OTHER',status:'filled',filledQuantity:1,
      averagePrice:1.006,averagePriceVerified:true,feeUsd:.000503,timestamp:Date.now()}});
  f.internal.financialEpoch++;validation.resolve();await pause(50);
  assert.equal(f.makers.length,0);assert.equal(f.orders.length,0);assert.equal(f.p.closeRequestedAt,undefined);
});

test('newer accepted selected-instrument native evidence vetoes an older scoped preparation',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  for(const changed of ['quantity','identity'] as const){
    const f=fixture(),validation=deferred<void>();f.setClosing();let entered=false;
    const gate=f.adapters[0],validate=gate.validateMakerReduction!;
    gate.validateMakerReduction=async request=>{entered=true;await validation.promise;await validate(request);};
    t.after(async()=>{validation.resolve();await f.stop();});
    f.settled();await until(()=>entered,'selected continuation never prepared with scoped accounts');
    t.mock.timers.setTime(NOW+100);const newer=structuredClone(f.accounts.get('gate')!);
    if(changed==='quantity')newer.positions[0].quantity=79;else newer.positions[0].positionId='new-native-position-cycle';
    newer.freeUsd=777;f.internal.accountReadAt.set(newer,Date.now());
    assert.equal(await f.engine.exclusive(async()=>f.internal.cacheAccount('gate',newer)),true);
    validation.resolve();await pause(50);
    assert.equal(f.makers.length,0,changed);assert.equal(f.orders.length,0,changed);
    assert.equal(f.engine.accounts.get('gate'),newer);assert.equal(f.p.long.quantity,80);
    assert.equal(f.internal.realtimeProfitAccountProofs.size,0);
    await f.stop();t.mock.timers.setTime(NOW);
  }
});

test('newer native evidence for other coins preserves the selected scoped proof and newest whole cache',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture(),validation=deferred<void>();f.setClosing();let entered=false;
  const gate=f.adapters[0],validate=gate.validateMakerReduction!;
  gate.validateMakerReduction=async request=>{entered=true;await validation.promise;await validate(request);};
  t.after(async()=>{validation.resolve();await f.stop();});
  f.settled();await until(()=>entered,'selected continuation did not prepare');
  t.mock.timers.setTime(NOW+100);const newer=structuredClone(f.accounts.get('gate')!);newer.freeUsd=777;
  newer.positions.push({...newer.positions[0],base:'ANOTHERCOIN',symbol:'ANOTHERCOIN/USDT:USDT',quantity:13});
  f.internal.accountReadAt.set(newer,Date.now());
  assert.equal(await f.engine.exclusive(async()=>f.internal.cacheAccount('gate',newer)),true);
  f.internal.financialEpoch++;validation.resolve();await until(()=>f.p.status==='closed','another coin native update blocked selected close');
  assert.equal(f.engine.accounts.get('gate'),newer);assert.equal(f.engine.accounts.get('gate')!.freeUsd,777);
  assert.equal(f.engine.accounts.get('gate')!.positions.at(-1)!.quantity,13);
});

test('later workers joining an older shared GET cannot publish pre-activity whole account evidence',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture(),read=deferred<AccountState>();f.setClosing();
  const other=addIndependentPosition(f);f.internal.continuingClosePositions.add(other.id);
  const packet=structuredClone(f.accounts.get('gate')!);packet.freeUsd=123;
  f.adapters[0].fetchAccount=async()=>{f.accountReads.push('gate');return read.promise;};
  t.after(async()=>{read.resolve(packet);await f.stop();});
  f.settled();await until(()=>f.accountReads.includes('gate'),'first continuation never acquired native GET');
  f.internal.financialEpoch++;f.engine.accounts.set('gate',{...structuredClone(f.engine.accounts.get('gate')!),freeUsd:777});
  f.internal.scheduleRealtimeProfitExits(other,0);await pause(20);
  assert.equal(f.accountReads.filter(exchange=>exchange==='gate').length,1,'later candidate must join the original GET');
  read.resolve(packet);await until(()=>f.p.status==='closed'&&other.status==='closed','both unchanged selected instruments should progress');
  assert.equal(f.engine.accounts.get('gate')!.freeUsd,777,'joining at a new epoch must not re-age an old packet');
});

function warmEntryCandidate(f:ReturnType<typeof fixture>){
  const warmBase='FLOWWARM',warmSymbol=`${warmBase}/USDT:USDT`;
  for(const exchange of ['gate','bybit'] as const){const quote={...f.quotes.get(exchange)!,base:warmBase,symbol:warmSymbol};
    f.additionalQuotes.set(`${exchange}:${warmBase}`,quote);f.engine.snapshots.push(quote);}
  // This scheduling fixture reaches warm preparation only after real independent funding confirmation.
  const tracker=new FundingEntryStabilityTracker(),now=Date.now();let opportunity!:Opportunity;
  for(const age of [180_000,135_000,90_000,45_000,0]){
    const at=now-age,pair=(['gate','bybit'] as const).map(exchange=>({...f.additionalQuotes.get(`${exchange}:${warmBase}`)!,
      timestamp:at,observedAt:at,fundingObservedAt:at}));
    opportunity={...calculateOpportunities(pair,f.engine.config,at,undefined,false)[0],id:'WARM-CANDIDATE'};
    const long=pair.find(quote=>quote.exchange===opportunity.longExchange),short=pair.find(quote=>quote.exchange===opportunity.shortExchange);
    opportunity.fundingEntryStability=tracker.evaluate(opportunity,long,short,f.engine.config,at);
  }
  assert.equal(opportunity.fundingEntryStability?.passes,true);
  f.internal.detailedOpportunities=()=>[opportunity];return opportunity;
}

test('an unfinished entry warm account GET leaves confirmed Maker fills and peer dispatch unblocked',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture(),read=deferred<AccountState>();warmEntryCandidate(f);
  f.engine.autoEnabled=true;f.quotes.get('gate')!.bids[0].price=1;let prepared=0;
  for(const adapter of f.adapters)adapter.prepareTrading=async()=>{prepared++;};
  const packet=structuredClone(f.accounts.get('gate')!);packet.freeUsd=123;
  f.adapters[0].fetchAccount=async()=>{f.accountReads.push('gate');return read.promise;};
  const warming=f.internal.warmRealtimeEntries();t.after(async()=>{read.resolve(packet);await warming;await f.stop();});
  await until(()=>f.accountReads.includes('gate'),'entry warm GET did not start');
  assert.equal(await f.engine.exclusive(async()=>true),true,'GET-only entry preparation may not occupy financial queue');
  f.quotes.get('gate')!.bids[0].price=1.006;f.emit();
  await until(()=>f.p.status==='closed','Maker cash or peer waited behind an unrelated entry account GET');
  assert.equal(f.orders.length,1);assert.equal(f.makers.length,1);assert.equal(prepared,0);
  f.engine.accounts.set('gate',{...structuredClone(f.engine.accounts.get('gate')!),freeUsd:777});
  read.resolve(packet);await warming;
  assert.equal(f.internal.realtimePrepared.size,0);assert.equal(f.engine.accounts.get('gate')!.freeUsd,777);
  assert.equal(prepared,0,'crossed financial activity cannot proceed to leverage preparation');
});

test('eligible or active Maker exits prevent new automatic entry preparation IO',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();warmEntryCandidate(f);f.engine.autoEnabled=true;
  t.after(()=>f.stop());await f.internal.warmRealtimeEntries();
  assert.equal(f.accountReads.length,0);assert.equal(f.orders.length,0);assert.equal(f.internal.realtimePrepared.size,0);
  assert.equal(f.engine.config.minExitProfitBps,10);
});

test('a failed read-only Maker preflight keeps automatic entry enabled, preserves cash, and does not block another coin',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture(),other=addIndependentPosition(f);f.engine.autoEnabled=true;
  const gate=f.adapters[0],validate=gate.validateMakerReduction!;let failures=0,warnings=0;
  f.store.log=(level,..._args)=>{if(level==='warn')warnings++;};
  gate.validateMakerReduction=async request=>{if(request.base===base){failures++;throw new Error('Memory read-only native preflight unavailable');}await validate(request);};
  t.after(()=>f.stop());const cash=JSON.stringify({fees:f.p.feesUsd,funding:f.p.fundingUsd,spread:f.p.realizedSpreadPnlUsd,quantity:f.p.long.quantity});
  f.emit();await until(()=>other.status==='closed','one failed native preparation blocked another coin');
  assert.equal(f.engine.autoEnabled,true);assert.equal(f.store.data.killSwitch,false);assert.ok(failures>0);
  assert.equal(JSON.stringify({fees:f.p.feesUsd,funding:f.p.fundingUsd,spread:f.p.realizedSpreadPnlUsd,quantity:f.p.long.quantity}),cash);
  assert.equal(f.makers.filter(maker=>maker.request.base===base).length,0);assert.equal(f.p.closeRequestedAt,undefined);
  const before=warnings;f.emit();await pause(80);assert.equal(warnings,before,'identical preflight waits should be throttled');
  gate.validateMakerReduction=validate;f.emit();await until(()=>f.p.status==='closed','restored native preflight did not resume Maker');
  assert.equal(f.engine.autoEnabled,true);
});

test('a ledger persistence failure during preflight diagnostics keeps the original global stop',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();f.engine.autoEnabled=true;
  f.adapters[0].validateMakerReduction=async()=>{throw new Error('Memory read-only native preflight unavailable');};
  f.store.log=()=>{throw Object.assign(new Error('Memory diagnostic save unavailable'),{syscall:'write'});};
  t.after(()=>f.stop());f.emit();await until(()=>f.store.data.killSwitch,'persistence failure was hidden as a native wait');
  assert.equal(f.engine.autoEnabled,false);assert.equal(f.makers.length,0);assert.equal(f.orders.length,0);
});

test('a held profit closes from coalesced WS events while automatic entry is off, without a poll',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.stop());
  await f.engine.control('pause');assert.equal(f.internal.maintenanceTradingPending,false);
  f.emit();for(let i=0;i<20;i++)f.internal.onRealtimeSignal();
  await until(()=>f.p.status==='closed','WS profit never closed');
  assert.equal(f.engine.autoEnabled,false);assert.equal(f.orders.length,1);assert.equal(f.makers.length,1);assert.equal(f.p.holdDecision?.exitSignal,'profit');
  assert.ok(f.p.netPnlUsd>.1);assert.equal(f.p.profitExitNotionalUsd,100);
});

test('a consumed maintenance scope observes accounts but does not manage restored profit before successful startAuto',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture({maintenance:true,missingFees:true});t.after(()=>f.stop());
  const originalScope=[...f.internal.sessionExchanges];
  assert.equal(f.engine.liveUnlocked,true);assert.equal((f.engine.execution as any).context.makerActionsAllowed(),false);
  f.emit();await pause(75);await f.engine.tick();
  assert.ok(f.accountReads.length>=2);assert.equal(f.p.status,'open');assert.equal(f.feeReads.length,0);
  assert.equal(f.orders.length,0);assert.equal(f.makers.length,0);assert.equal(f.store.data.orders.length,0);
  f.store.data.killSwitch=true;await assert.rejects(f.engine.control('startAuto'),/风险开关/);
  assert.equal(f.engine.autoEnabled,false);assert.equal(f.internal.maintenanceTradingPending,true);
  assert.equal((f.engine.execution as any).context.makerActionsAllowed(),false);
  f.store.data.killSwitch=false;await f.engine.control('startAuto');
  assert.equal(f.engine.autoEnabled,true);assert.equal(f.internal.maintenanceTradingPending,false);
  assert.deepEqual([...f.internal.sessionExchanges],originalScope);
  f.emit();await until(()=>f.p.status==='closed','verified maintenance scope did not begin Maker after normal startAuto');
  assert.equal(f.makers.length,1);assert.equal(f.orders.length,1);assert.equal(f.makers[0].exchange,'gate');
  assert.equal(f.orders[0].exchange,'bybit');assert.ok(f.feeReads.length>=2);
});

test('held WS profit is not delayed by an unfinished routine public market batch',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture(),read=deferred<MarketSnapshot[]>();
  f.adapters[0].fetchSnapshots=()=>read.promise;const tick=f.engine.tick();
  t.after(async()=>{read.resolve([f.quotes.get('gate')!]);await tick;await f.stop();});
  f.emit();await until(()=>f.p.status==='closed','profit waited for public polling');assert.equal(f.orders.length,1);
  read.resolve([f.quotes.get('gate')!]);await tick;
});

test('a qualifying reference signal prepares only missing native fees outside the financial queue',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture(),fee=deferred<TradingFeeMetadata|undefined>();t.after(async()=>{fee.resolve(undefined);await f.stop();});
  f.fees.delete('gate');f.adapters[0].fetchTradingFee=async()=>{f.feeReads.push('gate');const value=await fee.promise;if(value)f.fees.set('gate',value);return value;};
  f.emit();await until(()=>f.feeReads.length===1,'missing native fee was never requested');
  assert.equal(await f.engine.exclusive(async()=> 'queue-free'),'queue-free');assert.equal(f.orders.length,0);
  fee.resolve({takerFeeRate:.0005,takerFeeAt:Date.now(),takerFeeSource:'exchange',makerFeeRate:.0002,makerFeeAt:Date.now(),makerFeeSource:'exchange'});
  await until(()=>f.p.status==='closed','fee completion did not recheck and close');assert.equal(f.orders.length,1);
});

test('a slow fee candidate does not delay another held candidate with valid native evidence',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture(),fee=deferred<TradingFeeMetadata|undefined>();t.after(async()=>{fee.resolve(undefined);await f.stop();});
  const other=structuredClone(f.p);other.id='independent-held';other.base='FLOWREADY';other.long.symbol=other.short.symbol='FLOWREADY/USDT:USDT';
  f.store.data.positions.push(other);f.fees.delete('gate');
  const otherFee:TradingFeeMetadata={takerFeeRate:.0005,takerFeeAt:Date.now(),takerFeeSource:'exchange',makerFeeRate:.0002,makerFeeAt:Date.now(),makerFeeSource:'exchange'};
  for(const exchange of ['gate','bybit'] as const){const quote={...f.quotes.get(exchange)!,base:other.base,symbol:other.long.symbol,...otherFee};
    f.additionalQuotes.set(`${exchange}:${other.base}`,quote);f.engine.snapshots.push(quote);}
  f.adapters[0].cachedTradingFee=requestedSymbol=>requestedSymbol===other.long.symbol?otherFee:f.fees.get('gate');
  f.adapters[0].fetchTradingFee=async requestedSymbol=>{if(requestedSymbol===other.long.symbol)return otherFee;f.feeReads.push('gate');return fee.promise;};
  let otherManaged=false;const manage=f.internal.managePosition.bind(f.engine);
  f.internal.managePosition=async(p:Position,...args:unknown[])=>{if(p===other){otherManaged=true;return;}return manage(p,...args);};
  f.emit();await until(()=>otherManaged,'a slow candidate blocked an independent profit wake');
  assert.equal(f.orders.length,0);assert.equal(await f.engine.exclusive(async()=>true),true);
});

test('reference nonprofit, missing settlement receipts, unknown originals and permission locks never acquire fees or submit',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  for(const kind of ['nonprofit','settlement','unknown','permission','manual','attention','kill'] as const){
    const f=fixture({missingFees:true,permission:kind!=='permission'});t.after(()=>f.stop());
    if(kind==='nonprofit')f.quotes.get('gate')!.bids[0].price=1;
    if(kind==='settlement')f.p.profitExitPolicy!.fundingChecks![0].timestamp=Date.now()-1;
    if(kind==='manual')f.p.manualCloseOnly=true;
    if(kind==='attention')f.p.status='attention';
    if(kind==='kill')f.store.data.killSwitch=true;
    if(kind==='unknown')f.store.data.orders.push({positionId:f.p.id,exchange:'gate',createdAt:Date.now()-100,
      request:{clientOrderId:'MEMORY-UNKNOWN',base,symbol,side:'sell',quantity:1,limitPrice:1.006,reduceOnly:true},
      result:{id:'MEMORY-ORIGINAL',clientOrderId:'MEMORY-UNKNOWN',status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:NaN,timestamp:Date.now()-100}});
    f.emit();await pause(75);assert.equal(f.feeReads.length,0,kind);assert.equal(f.orders.length,0,kind);assert.equal(f.makers.length,0,kind);
  }
});

test('queued held profit rechecks current prices and session generation before any intent',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  for(const kind of ['price','generation','permission'] as const){
    const f=fixture(),release=deferred<void>();t.after(async()=>{release.resolve();await f.stop();});
    const occupied=f.engine.exclusive(()=>release.promise);f.emit();
    await until(()=>f.internal.realtimeProfitPreparing.has(f.p.id),'queued held exit preparation did not start');
    if(kind==='price')f.quotes.get('gate')!.bids[0].price=1;
    if(kind==='generation')f.internal.startGeneration++;
    if(kind==='permission')f.internal.revokeExecutionPermission();
    release.resolve();await occupied;
    await until(()=>!f.internal.realtimeProfitPreparing.has(f.p.id),'queued held exit preparation did not settle');
    assert.equal(f.orders.length,0,kind);assert.equal(f.p.closeRequestedAt,undefined,kind);
  }
});

test('late valid native cache evidence overrides failure backoff on the next held quote',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture({missingFees:true});t.after(()=>f.stop());
  for(const adapter of f.adapters)adapter.fetchTradingFee=async()=>{f.feeReads.push(adapter.id);return undefined;};
  f.emit();await until(()=>f.feeReads.length===2,'reference profit did not request native evidence');await pause(10);f.emit();await pause(65);
  assert.equal(f.feeReads.length,2);assert.equal(f.orders.length,0);
  for(const exchange of ['gate','bybit'] as const)f.fees.set(exchange,{takerFeeRate:.0005,takerFeeAt:Date.now(),takerFeeSource:'exchange',
    makerFeeRate:.0002,makerFeeAt:Date.now(),makerFeeSource:'exchange'});
  f.emit();await until(()=>f.p.status==='closed','late valid cache evidence stayed trapped behind retry delay');
});

test('known Maker terminal completion immediately continues matched residuals using fresh account GETs',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture({maker:true});t.after(()=>f.stop());
  f.emit();await until(()=>f.p.status==='closed','Maker residuals still waited for the five-second poll');
  assert.deepEqual(f.makers.map(value=>value.request.quantity),[25,25,25,25]);assert.deepEqual(f.orders.map(value=>value.request.quantity),[25,25,25,25]);
  assert.ok(f.orders.every(value=>value.exchange==='bybit'),'only the confirmed Maker budget may use peer IOC');
  assert.ok(f.accountReads.length>=6);assert.equal(f.p.profitExitNotionalUsd,100);assert.ok(f.p.netPnlUsd>.1);
  assert.equal(f.engine.execution.hasMakerClose(f.p),false);
});

test('a settlement wake cannot restore a historical closing intent or attention manager',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  for(const kind of ['historical','attention','unequal','unknown'] as const){
    const f=fixture();t.after(()=>f.stop());f.setClosing();
    if(kind==='historical')f.internal.continuingClosePositions.clear();
    if(kind==='attention')f.p.status='attention';
    if(kind==='unequal')f.p.short.quantity--;
    if(kind==='unknown')f.store.data.orders.push({positionId:f.p.id,exchange:'gate',createdAt:Date.now(),
      request:{clientOrderId:'OLD',base,symbol,side:'sell',quantity:1,limitPrice:1.006,reduceOnly:true},
      result:{id:'OLD',clientOrderId:'OLD',status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:NaN,timestamp:Date.now()}});
    f.settled();await pause(75);assert.equal(f.orders.length,0,kind);assert.equal(f.accountReads.length,0,kind);assert.equal(f.p.long.quantity,80);
  }
});

test('a post-Maker account proof crossing its own financial activity is discarded instead of authorizing a new batch',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture(),read=deferred<AccountState>();t.after(async()=>{read.resolve(structuredClone(f.accounts.get('gate')!));await f.stop();});
  f.setClosing();f.adapters[0].fetchAccount=async()=>{f.accountReads.push('gate');return read.promise;};f.settled();
  await until(()=>f.accountReads.includes('gate'),'Maker settlement did not request actual residuals');
  f.internal.financialEpoch++;f.p.fundingUsd+=.01;read.resolve(structuredClone(f.accounts.get('gate')!));await pause(35);
  assert.equal(f.orders.length,0);assert.equal(f.p.status,'closing');assert.equal(f.engine.accounts.get('gate')!.positions[0].quantity,100);
});

test('a fresh mismatched residual or IOC profitability loss prevents fast continuation',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  for(const kind of ['account','profit'] as const){
    const f=fixture();t.after(()=>f.stop());f.setClosing();
    if(kind==='account')f.accounts.get('gate')!.positions[0].quantity=79;
    if(kind==='profit')f.quotes.get('gate')!.bids[0].price=1;
    f.settled();await pause(80);assert.equal(f.orders.length,0,kind);assert.equal(f.p.long.quantity,80,kind);assert.equal(f.p.status,'closing',kind);
  }
});

test('routine polling accepts post-terminal closing quantities instead of freezing all account caches',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.stop());f.setClosing();
  await f.engine.tick();assert.equal(f.engine.accounts.get('gate')!.positions[0].quantity,80);assert.equal(f.engine.accounts.get('bybit')!.positions[0].quantity,80);
  assert.equal(f.p.status,'closing');assert.equal(f.orders.length,0);
});

test('an active Maker blocks only its involved venue account proofs, leaving independent venues updating',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture({extraVenue:true});t.after(()=>f.stop());f.setClosing();
  const hasMaker=f.engine.execution.hasMakerClose.bind(f.engine.execution);f.engine.execution.hasMakerClose=p=>p===f.p||hasMaker(p);
  f.engine.accounts.set('binance',{freeUsd:777,equityUsd:777,positions:[]});await f.engine.tick();
  assert.equal(f.engine.accounts.get('binance')!.freeUsd,1000);assert.equal(f.engine.accounts.get('gate')!.positions[0].quantity,100);assert.equal(f.orders.length,0);
});

test('zero-fill IOC residuals retain their polling cooldown despite repeated profitable WS events',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.stop());f.setClosing();
  f.store.data.orders.push({positionId:f.p.id,exchange:'gate',createdAt:Date.now(),
    request:{clientOrderId:'ZERO',base,symbol,side:'sell',quantity:1,limitPrice:1.006,reduceOnly:true},
    result:{id:'ZERO',clientOrderId:'ZERO',status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now()}});
  for(let i=0;i<5;i++)f.emit();await pause(80);assert.equal(f.orders.length,0);assert.equal(f.accountReads.length,0);assert.equal(f.p.status,'closing');
});

test('execution fee and symbol-specific book reads start independently while fee evidence is delayed',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture(),fee=deferred<TradingFeeMetadata|undefined>();let bookEntered=false;
  t.after(async()=>{fee.resolve(f.fees.get('gate'));await f.stop();});
  f.adapters[0].fetchTradingFee=()=>fee.promise;f.adapters[0].fetchExecutionSnapshots=async()=>{bookEntered=true;return [f.quotes.get('gate')!];};
  const refresh=f.internal.refreshExecutionSnapshots(base,['gate']);await until(()=>bookEntered,'book refresh waited for fee GET');
  assert.equal(f.orders.length,0);fee.resolve(f.fees.get('gate'));await refresh;
});

test('an unsupported wider Maker venue waits with a diagnosis instead of acquiring fees or reverting that leg to IOC',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture({maker:false,missingFees:true});t.after(()=>f.stop());
  f.emit();await pause(75);assert.equal(f.feeReads.length,0);assert.equal(f.orders.length,0);assert.equal(f.makers.length,0);
  await f.engine.exclusive(()=>f.internal.managePosition(f.p,Date.now()));
  assert.equal(f.feeReads.length,0);assert.equal(f.p.status,'open');assert.equal(f.p.holdDecision?.action,'wait');
  assert.match(f.p.holdDecision!.reason,/尚未支持.*Maker.*未改用.*IOC/);
});

test('a funding-loss IOC becoming profitable during its actual refresh yields to Maker before any wide-leg IOC',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.stop());f.quotes.get('gate')!.bids[0].price=1;
  f.p.holdDecision={...evaluateHoldingDecision(f.p,f.engine.snapshot('gate',base),f.engine.snapshot('bybit',base),f.engine.config),
    action:'close',exitSignal:'funding-loss',reason:'MEMORY previously confirmed funding-loss'};
  f.adapters[0].fetchExecutionSnapshots=async()=>{f.quotes.get('gate')!.bids[0].price=1.006;return [f.quotes.get('gate')!];};
  await f.engine.exclusive(()=>f.internal.continueClosing(f.p,f.p.holdDecision!.reason,{pricing:'best-opposite',requireProfit:true}));
  assert.equal(f.orders.length,0);assert.equal(f.makers.length,0);assert.equal(f.store.data.orders.length,0);assert.equal(f.p.closeRequestedAt,undefined);
  assert.match(f.p.holdDecision!.reason,/Maker.*宽盘口腿 IOC/);
  f.emit();await until(()=>f.p.status==='closed','new profitability did not return to Maker');
  assert.equal(f.makers.length,1);assert.ok(f.orders.every(value=>value.exchange==='bybit'));
});

test('Maker retry cooldown schedules a fresh matched continuation without private preparation before its deadline',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.stop());f.setClosing();
  f.engine.execution.makerCloseRetryAfter=()=>NOW+500;f.settled();f.emit();await pause(75);
  assert.equal(f.feeReads.length,0);assert.equal(f.accountReads.length,0);assert.equal(f.orders.length,0);assert.equal(f.makers.length,0);
  t.mock.timers.setTime(NOW+500);f.emit();await until(()=>f.p.status==='closed','cooldown completed but current matched intent did not continue');
  assert.equal(f.makers.length,1);assert.ok(f.orders.every(value=>value.exchange==='bybit'));
});

test('legacy un-frozen holdings discover profit against original booked opening basis without mutating the ledger',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture({missingFees:true});t.after(()=>f.stop());
  delete f.p.profitExitNotionalUsd;f.p.long.quantity=80;f.p.short.quantity=80;f.p.feesUsd=.12;f.p.transferCostUsd=.18;
  f.p.long.feesUsd=.06;f.p.short.feesUsd=.06;
  for(const exchange of ['gate','bybit'] as const){
    f.accounts.get(exchange)!.positions[0].quantity=80;const clientOrderId=`MEMORY-BOOKED-${exchange}`;
    f.store.data.orders.push({positionId:f.p.id,exchange,createdAt:Date.now()-500,
      request:{clientOrderId,base,symbol,side:exchange==='gate'?'sell':'buy',quantity:20,limitPrice:1,reduceOnly:true},
      result:{id:clientOrderId,clientOrderId,status:'filled',filledQuantity:20,averagePrice:1,averagePriceVerified:true,feeUsd:.01,timestamp:Date.now()-500}});
  }
  const before=JSON.stringify(f.store.data);f.emit();await pause(80);
  assert.equal(f.feeReads.length,0);assert.equal(f.makers.length,0);assert.equal(f.orders.length,0);assert.equal(f.p.profitExitNotionalUsd,undefined);
  assert.equal(JSON.stringify(f.store.data),before);
});

/** A terminal zero Maker owns no peer budget and does not prove that cached holdings are fresh. */
function confirmedZeroClose(f:ReturnType<typeof fixture>){
  f.setClosing();f.p.closeRequestedAt=NOW-10_000;f.p.closeAttemptedAt=NOW-6000;
  const clientOrderId='MEMORY-KNOWN-ZERO-MAKER';
  f.store.data.orders.push({positionId:f.p.id,exchange:'gate',createdAt:NOW-450,
    request:{clientOrderId,base,symbol,side:'sell',quantity:25,limitPrice:1.016,reduceOnly:true,postOnly:true},
    result:{id:'MEMORY-NATIVE-KNOWN-ZERO',clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,averagePriceVerified:true,feeUsd:0,timestamp:NOW-400},
    makerReduction:{activity:'terminal',makerLeg:'long',deadlineAt:NOW-350,bookedExecution:true,lastObservedAt:NOW-400},
    executionEvidence:{version:1,method:'maker',role:'exit',batchId:'MEMORY-ZERO-BATCH',bookedFeeUsd:0}});
}
async function freshCloseAccounts(f:ReturnType<typeof fixture>){
  await f.engine.exclusive(async()=>{
    for(const adapter of f.adapters){const account=await f.internal.readTradingAccount(adapter);assert.equal(f.internal.cacheAccount(adapter.id,account),true);}
  });
}

test('current-session attention after confirmed zero Maker waits on absent or old accounts then resumes only on fresh matching GETs',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  for(const evidence of ['missing','old-mismatched'] as const){
    const f=fixture();t.after(()=>f.stop());confirmedZeroClose(f);f.p.status='attention';
    f.p.riskReasons=['平仓未完成：实际仓位尚未与成交记录核对一致'];
    if(evidence==='missing')f.engine.accounts.delete('gate');
    const originalOrders=structuredClone(f.store.data.orders),cash={fees:f.p.feesUsd,funding:f.p.fundingUsd,realized:f.p.realizedSpreadPnlUsd};
    await f.engine.exclusive(()=>f.internal.managePosition(f.p,Date.now()));
    assert.equal(f.makers.length,0,evidence);assert.equal(f.orders.length,0,evidence);
    assert.equal(f.p.long.quantity,80);assert.equal(f.p.short.quantity,80);
    assert.match(f.p.riskReasons.join(' '),/等待.*新鲜账户|新鲜账户.*等待/,evidence);
    assert.deepEqual(f.store.data.orders,originalOrders);assert.deepEqual({fees:f.p.feesUsd,funding:f.p.fundingUsd,realized:f.p.realizedSpreadPnlUsd},cash);
    await freshCloseAccounts(f);
    await f.engine.exclusive(()=>f.internal.managePosition(f.p,Date.now()));
    await until(()=>f.p.status==='closed','fresh current-session attention did not dispatch prepared Maker');
    assert.equal(f.makers.length,1,evidence);assert.equal(f.orders.length,1,evidence);
    assert.equal(f.makers[0].exchange,'gate');assert.equal(f.orders[0].exchange,'bybit');
    assert.equal(f.p.status,'closed',evidence);assert.deepEqual(f.store.data.orders[0],originalOrders[0]);
  }
});

test('matching stale closing cache cannot start another Maker before post-zero fresh account proofs',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.stop());confirmedZeroClose(f);
  for(const [exchange,account] of f.accounts)f.engine.accounts.set(exchange,structuredClone(account));
  assert.equal(f.internal.accountMatchesPosition(f.p),true);assert.equal(f.internal.closeAccountsFresh(f.p,Date.now()),false);
  const before=structuredClone(f.store.data.orders);
  await f.engine.exclusive(()=>f.internal.managePosition(f.p,Date.now()));
  await f.engine.execution.waitMakerClose(f.p);
  assert.equal(f.makers.length,0);assert.equal(f.orders.length,0);assert.deepEqual(f.store.data.orders,before);
  assert.equal(f.p.long.quantity,80);assert.equal(f.p.short.quantity,80);
  await freshCloseAccounts(f);await f.engine.exclusive(()=>f.internal.managePosition(f.p,Date.now()));
  await until(()=>f.p.status==='closed','fresh matched continuation did not dispatch prepared Maker');assert.equal(f.makers.length,1);assert.equal(f.orders.length,1);
});

test('a conditional zero-fill suspension keeps original cash until fresh matching accounts release its intent',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.stop());confirmedZeroClose(f);
  f.quotes.get('gate')!.bids[0].price=1;
  const suspended=await f.engine.exclusive(async()=>f.engine.execution.suspendAutomaticClose(f.p,'MEMORY profitable close conditions no longer hold'));
  assert.equal(suspended,false);assert.equal(f.p.status,'attention');assert.ok(f.p.closePauseReason);
  const before=structuredClone(f.store.data.orders),cash={fees:f.p.feesUsd,funding:f.p.fundingUsd,realized:f.p.realizedSpreadPnlUsd};
  await f.engine.exclusive(()=>f.internal.managePosition(f.p,Date.now()));
  assert.equal(f.makers.length,0);assert.equal(f.orders.length,0);assert.ok(f.p.closeRequestedAt);
  assert.match(f.p.riskReasons.join(' '),/等待.*账户/);
  await freshCloseAccounts(f);await f.engine.exclusive(()=>f.internal.managePosition(f.p,Date.now()));
  assert.equal(f.p.status,'open');assert.equal(f.p.closeRequestedAt,undefined);assert.equal(f.p.closePauseReason,undefined);
  assert.equal(f.internal.continuingClosePositions.has(f.p.id),false);assert.equal(f.p.automaticCloseHistory!.length,1);
  assert.deepEqual(f.store.data.orders,before);assert.deepEqual({fees:f.p.feesUsd,funding:f.p.fundingUsd,realized:f.p.realizedSpreadPnlUsd},cash);
});

test('fresh native holdings that really differ after a zero Maker retain attention and never authorize a new reduction',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.stop());confirmedZeroClose(f);f.p.status='attention';
  f.accounts.get('gate')!.positions[0].quantity=79;
  await freshCloseAccounts(f);assert.equal(f.internal.closeAccountsFresh(f.p,Date.now()),true);
  const before=structuredClone(f.store.data.orders);
  await f.engine.exclusive(()=>f.internal.managePosition(f.p,Date.now()));
  assert.equal(f.p.status,'attention');assert.match(f.p.riskReasons.join(' '),/实际仓位.*核对一致/);
  assert.equal(f.makers.length,0);assert.equal(f.orders.length,0);assert.equal(f.p.long.quantity,80);assert.equal(f.p.short.quantity,80);
  assert.deepEqual(f.store.data.orders,before);
});

test('fresh accounts and a known zero receipt cannot restore historical attention lacking current-session continuation ownership',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture({missingFees:true});t.after(()=>f.stop());confirmedZeroClose(f);
  f.p.status='attention';f.internal.continuingClosePositions.clear();await freshCloseAccounts(f);
  const before=structuredClone(f.store.data.orders);
  await f.engine.exclusive(()=>f.internal.managePosition(f.p,Date.now()));
  assert.equal(f.p.status,'attention');assert.equal(f.makers.length,0);assert.equal(f.orders.length,0);assert.equal(f.feeReads.length,0);
  assert.ok(f.p.closeRequestedAt);assert.equal(f.internal.continuingClosePositions.has(f.p.id),false);assert.deepEqual(f.store.data.orders,before);
});

test('a native hard refusal remains blocked even when current-session zero-fill continuation accounts match freshly',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const f=fixture();t.after(()=>f.stop());confirmedZeroClose(f);f.p.status='attention';
  const zero=f.store.data.orders[0];zero.result!.rejectionCode='INVALID_PARAMETER';zero.result!.rejectionReason='MEMORY native hard refusal';
  await freshCloseAccounts(f);const before=structuredClone(f.store.data.orders);
  await f.engine.exclusive(()=>f.internal.managePosition(f.p,Date.now()));
  assert.equal(f.makers.length,0);assert.equal(f.orders.length,0);assert.deepEqual(f.store.data.orders,before);
  assert.equal(f.p.long.quantity,80);assert.equal(f.p.short.quantity,80);
});
