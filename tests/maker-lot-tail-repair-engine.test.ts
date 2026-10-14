import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {Engine,type SelectedMakerCloseRepairRequest} from '../src/core/engine.js';
import type {Store} from '../src/core/store.js';
import type {AccountOpenOrder,AccountState,ExchangeAdapter,ExchangeId,JournalOrder,MakerReductionObservation,OrderRequest,OrderResult} from '../src/shared/types.js';
import {planConfirmedLotTailRestoration} from '../src/core/confirmed-lot-tail.js';
import {assessConfirmedLotTailFundingExit} from '../src/core/confirmed-lot-tail-funding.js';
import {FundingExitStabilityTracker} from '../src/core/funding-exit-stability.js';
import {assessAlignedExit,type AlignedExitAssessment} from '../src/core/profit-exit.js';
import type {MarketSnapshot} from '../src/shared/types.js';
import {currentExitStrategyPosition} from '../src/shared/current-exit-strategy.js';
import {lotTailFixture} from './confirmed-lot-tail-fixture.js';

/** Real Engine/native-read/account/registry guards and optional real lot Execution.
 * Financial interfaces are deterministic memory adapters. No HTTP clients exist here. */
function fixture(t:TestContext){
  const f=lotTailFixture();let clock=f.now;t.mock.method(Date,'now',()=>clock);
  f.config.exchanges=['gate','bybit'];f.config.symbols=['SKL'];
  const calls:string[]=[],actions:string[]=[],accounts=new Map<ExchangeId,AccountState>();
  let realExecution=false,nativeTerminalHook:(()=>void)|undefined;
  const nativeMakers=new Map<string,{request:OrderRequest;id:string;filled:boolean}>();
  const nativeResult=(request:OrderRequest,filled:number,id:string):OrderResult=>({id,clientOrderId:request.clientOrderId,
    status:filled===request.quantity?'filled':filled>0?'partial':'cancelled',filledQuantity:filled,
    averagePrice:filled?request.limitPrice:0,averagePriceVerified:true,
    feeUsd:filled*request.limitPrice*(request.postOnly?.0002:.0005),timestamp:Date.now()});
  for(const leg of [f.p.long,f.p.short])accounts.set(leg.exchange,{freeUsd:1000,equityUsd:1000,positionMode:'single',positions:[{
    base:f.p.base,symbol:leg.symbol,side:leg.side,quantity:leg.quantity,entryPrice:leg.entryPrice,markPrice:leg.markPrice,
    liquidationPrice:0,leverage:2,marginMode:'crossed',positionId:`original-${leg.exchange}-slot`,positionOpenedAt:f.p.openedAt}]});
  let accountHook:(exchange:ExchangeId,count:number)=>void=()=>{},makerHook:(value:MakerReductionObservation)=>MakerReductionObservation=value=>value,
    openHook:(exchange:ExchangeId)=>AccountOpenOrder[]=()=>[],phaseHook:(phase:'before-maker'|'after-maker'|'before-peer'|'after-peer'|'after-final-accounts')=>void=()=>{};
  const readCounts=new Map<ExchangeId,number>(),store={data:{version:1,config:f.config,positions:[f.p],orders:f.orders,
    logs:[],equity:[],killSwitch:false,fundingSeen:[]},save(){calls.push('save');},log(){calls.push('log');}} as unknown as Store;
  const adapters=f.config.exchanges.map(exchange=>({id:exchange,
    fetchSnapshots:async()=>[exchange==='gate'?f.long:f.short],
    fetchExecutionSnapshots:async(bases:string[])=>{assert.deepEqual(bases,[f.p.base]);assert.ok(['gate','bybit'].includes(exchange));calls.push(`book:${exchange}`);
      return [{...(exchange==='gate'?f.long:f.short),timestamp:Date.now(),observedAt:Date.now()}];},
    supportsMakerReduction:()=>realExecution,
    fetchAccount:async()=>{const count=(readCounts.get(exchange)??0)+1;readCounts.set(exchange,count);calls.push(`account:${exchange}:${count}`);
      if(realExecution)clock++;
      accountHook(exchange,count);return structuredClone(accounts.get(exchange)!);},
    fetchOpenOrders:async(symbol:string)=>{assert.equal(symbol,f.p.long.symbol);calls.push(`open:${exchange}`);return structuredClone(openHook(exchange));},
    inspectMakerReduction:async(request,nativeId)=>{assert.equal(exchange,'bybit');
      if(request.clientOrderId===f.parent.request.clientOrderId){assert.deepEqual(request,f.parent.request);
        assert.equal(nativeId,f.parent.result!.id);calls.push('native-original-maker');
        return makerHook({activity:'terminal',executionVerified:true,observedAt:Date.now(),result:structuredClone(f.parent.result!)});}
      assert.ok(realExecution);const native=nativeMakers.get(request.clientOrderId);assert.ok(native);assert.equal(nativeId,native.id);
      assert.deepEqual(request,native.request);clock++;
      if(!native.filled){native.filled=true;accounts.get('bybit')!.positions[0].quantity-=request.quantity;
        actions.push(`native-terminal-maker:${request.quantity}`);nativeTerminalHook?.();}
      return {activity:'terminal',executionVerified:true,observedAt:Date.now(),result:nativeResult(request,request.quantity,native.id)};},
    validateMakerReduction:async(request)=>{assert.ok(realExecution);assert.equal(exchange,'bybit');
      assert.equal(request.postOnly,true);assert.equal(request.reduceOnly,true);calls.push('validate-maker');},
    validateOrder:async(request)=>{assert.ok(realExecution);assert.equal(exchange,'gate');assert.equal(request.reduceOnly,true);calls.push('validate-peer');},
    placeOrder:async(request,canSubmit)=>{assert.ok(realExecution);assert.equal(exchange,'gate');assert.ok(canSubmit);
      if(!canSubmit())return {...nativeResult(request,0,''),rejectionCode:'ORDER_SUBMISSION_PERMISSION_CHANGED',rejectionReason:'Memory final peer guard veto'};
      assert.equal(accounts.get('bybit')!.positions[0].quantity,3660,'only actual terminal Maker four permits this peer');
      assert.equal(request.quantity,10);accounts.get('gate')!.positions[0].quantity-=request.quantity;
      actions.push(`native-peer:${request.quantity}`);clock++;return nativeResult(request,request.quantity,'NATIVE-NEW-PEER');},
    submitMakerReduction:async(request,canSubmit)=>{assert.ok(realExecution);assert.equal(exchange,'bybit');assert.ok(canSubmit);
      assert.equal(store.data.orders.at(-1)?.request,request,'the real executor persisted its exact new intent before the adapter call');
      assert.equal(store.data.orders.at(-1)?.result?.status,'unknown');
      if(!canSubmit())return {...nativeResult(request,0,''),rejectionCode:'MAKER_REDUCTION_PERMISSION_CHANGED',rejectionReason:'Memory final Maker guard veto'};
      assert.equal(request.quantity,4);const id='NATIVE-NEW-MAKER';nativeMakers.set(request.clientOrderId,{request:structuredClone(request),id,filled:false});
      actions.push(`native-maker:${request.quantity}`);return {...nativeResult(request,0,id),status:'unknown',feeUsd:NaN};},
    cancelMakerReduction:async()=>{throw new Error('Engine fixture cannot cancel');},
    fetchTradingFee:async()=>{assert.ok(realExecution,'No fee polling in Engine repair wrapper');calls.push(`fee:${exchange}`);
      return {takerFeeRate:.0005,takerFeeSource:'exchange',takerFeeAt:Date.now(),makerFeeRate:.0002,makerFeeSource:'exchange',makerFeeAt:Date.now()};},close:async()=>{},
    prepareTrading:async()=>{throw new Error('Engine fixture cannot alter account modes');},
    reconcileOrder:async()=>{throw new Error('Engine fixture cannot replay or reconcile writes');},
    cancelOrder:async()=>{throw new Error('Engine fixture cannot cancel');},fetchFundingPayments:async()=>[],
  } as ExchangeAdapter));
  const engine=new Engine(store,true,{adapterFactory:()=>adapters,liveEnvironment:{ALLOW_LIVE_TRADING:'true',
    LIVE_TRADING_ACK:'I_UNDERSTAND_THE_RISKS',GATE_API_KEY:'MEMORY',GATE_API_SECRET:'MEMORY',BYBIT_API_KEY:'MEMORY',BYBIT_API_SECRET:'MEMORY'}});
  engine.snapshots=[f.long,f.short];engine.autoEnabled=false;
  const internal=engine as unknown as {sessionLivePermission:boolean;sessionExchanges:Set<ExchangeId>;financialEpoch:number;reconciledPositions:Set<string>};
  internal.sessionLivePermission=true;internal.sessionExchanges=new Set(['gate','bybit']);
  const originalRepair=engine.execution.repairConfirmedMakerLotTail.bind(engine.execution);
  const plan=()=>planConfirmedLotTailRestoration({position:f.p,parent:f.parent,orders:f.orders,long:f.long,short:f.short,config:f.config,now:Date.now()});
  const book=(order:JournalOrder,side:'long'|'short')=>{
    const result=order.result!,leg=f.p[side];order.createdAt=++clock;result.timestamp=clock;
    leg.feesUsd+=result.feeUsd;f.p.feesUsd+=result.feeUsd;
    f.p.realizedSpreadPnlUsd+=(side==='long'?result.averagePrice-leg.entryPrice:leg.entryPrice-result.averagePrice)*result.filledQuantity;
    accounts.get(leg.exchange)!.positions[0].quantity=leg.quantity;
    clock++;
  };
  engine.execution.repairConfirmedMakerLotTail=async(p,parent,ensure,verifyAccounts)=>{
    assert.equal(p,f.p);assert.equal(parent,f.parent);ensure();calls.push('executor-enter');
    const ready=plan();if(ready.status==='blocked'||ready.status==='waiting')return false;
    assert.equal(ready.status,'augment-maker');assert.equal(ready.augmentationQuantity,4);
    phaseHook('before-maker');ensure();
    const previousMaker={long:p.long.quantity,short:p.short.quantity},newMaker=f.augmentation(4,4);book(newMaker,'short');
    actions.push('terminal-maker:4');ensure();phaseHook('after-maker');ensure();
    await verifyAccounts(previousMaker);ensure();
    const confirmed=plan();assert.equal(confirmed.status,'reduce-peer');assert.equal(confirmed.confirmedBudget,10);
    phaseHook('before-peer');ensure();
    const previousPeer={long:p.long.quantity,short:p.short.quantity},peer=f.peer(10);book(peer,'long');
    actions.push('terminal-peer:10');ensure();phaseHook('after-peer');ensure();
    await verifyAccounts(previousPeer);ensure();phaseHook('after-final-accounts');ensure();
    assert.equal(plan().status,'matched');return true;
  };
  const request=():SelectedMakerCloseRepairRequest=>({acknowledgement:'REPAIR_SELECTED_MAKER_CLOSE_LOT_TAIL',
    expiresAt:Date.now()+45_000,positionId:f.p.id,parentClientOrderId:f.parent.request.clientOrderId,
    expected:{base:f.p.base,openedAt:f.p.openedAt,longExchange:f.p.long.exchange,longSymbol:f.p.long.symbol,longQuantity:f.p.long.quantity,
      shortExchange:f.p.short.exchange,shortSymbol:f.p.short.symbol,shortQuantity:f.p.short.quantity}});
  return {...f,engine,store,internal,accounts,calls,actions,adapters,request,plan,advanceClock:(ms:number)=>{clock+=ms;},
    repair:(input=request())=>engine.repairSelectedMakerClose(input),
    useRealExecution:()=>{realExecution=true;engine.execution.repairConfirmedMakerLotTail=originalRepair;
      engine.health.forEach(health=>{health.status='online';health.lastSuccess=Date.now();});},
    onNativeTerminal:(hook:typeof nativeTerminalHook)=>{nativeTerminalHook=hook;},
    onAccount:(hook:typeof accountHook)=>{accountHook=hook;},onMaker:(hook:typeof makerHook)=>{makerHook=hook;},
    onOpen:(hook:typeof openHook)=>{openHook=hook;},onPhase:(hook:typeof phaseHook)=>{phaseHook=hook;}};
}

function fundingFixture(t:TestContext,samples=5,paymentDelayMs=120_000,
  historical?:Pick<ReturnType<typeof fixture>['p'],'entryPolicy'|'holdMode'>){
  const f=fixture(t);f.useRealExecution();const payAt=f.now+paymentDelayMs;
  f.p.openedAt=f.now-600_000;f.p.closeRequestedAt=f.now-250_000;
  f.parent.createdAt=f.now-249_900;f.parent.result!.timestamp=f.now-249_800;f.parent.makerReduction!.deadlineAt=f.now-244_900;
  f.long.bids[0].price=.03;f.long.asks[0].price=.03001;f.p.long.markPrice=.03;
  for(const account of f.accounts.values())account.positions[0].positionOpenedAt=f.p.openedAt;
  f.p.holdDecision={action:'hold',reason:'memory independently observed funding disadvantage',expectedFundingUsd:-1.101,
    incrementalCostUsd:0,expectedNetUsd:-1.101,nextReviewAt:f.now+5000,targetFundingTime:payAt};
  if(historical){f.p.entryPolicy=historical.entryPolicy;f.p.holdMode=historical.holdMode;}
  const tracker=(f.engine as unknown as {fundingExitStability:FundingExitStabilityTracker}).fundingExitStability;
  const update=(at:number,longRate=.01)=>{
    for(const book of new Set([f.long,f.short,...f.engine.snapshots])){book.timestamp=at;book.observedAt=at;book.fundingObservedAt=at;
      book.takerFeeAt=at;book.makerFeeAt=at;book.markPrice=.03;book.intervalHours=1;book.nextFundingTime=payAt;
      book.fundingRate=book.exchange==='gate'?longRate:0;}
    for(const leg of [f.p.long,f.p.short]){leg.fundingObservedSince=f.p.openedAt;leg.fundingObservedAt=at;}
  };
  for(const offset of [0,45_000,90_000,135_000,180_000].slice(5-samples)){
    const at=f.now-180_000+offset;update(at);
    const assessment=assessConfirmedLotTailFundingExit(f.p,f.long,f.short,f.config,at,10,4);
    assert.ok(assessment,'a complete original funding observation uses actual unequal holdings');
    tracker.evaluate(currentExitStrategyPosition(f.p,f.config),f.long,f.short,assessment,f.config,at);
  }
  update(Date.now());return {...f,tracker,update};
}

test('scoped lot restoration confirms old native cash and exact accounts before terminal Maker four then peer ten',async t=>{
  const f=fixture(t),originalParent=JSON.stringify(f.parent),originalPolicy=structuredClone(f.p.profitExitPolicy),frozen=f.p.profitExitNotionalUsd;
  const result=await f.repair();assert.equal(result.repaired,true);assert.equal(result.longQuantity,3660);assert.equal(result.shortQuantity,3660);
  assert.deepEqual(f.actions,['terminal-maker:4','terminal-peer:10']);assert.equal(f.p.status,'open');
  assert.equal(f.p.closeRequestedAt,undefined);assert.equal(f.p.closeProfitRequired,undefined);assert.equal(f.p.automaticCloseHistory!.length,1);
  assert.equal(f.p.profitExitNotionalUsd,frozen);assert.deepEqual(f.p.profitExitPolicy,originalPolicy);assert.equal(JSON.stringify(f.parent),originalParent);
  assert.deepEqual([...f.internal.reconciledPositions],[f.p.id]);assert.equal(f.engine.autoEnabled,false);
  assert.equal(f.calls.filter(call=>call==='native-original-maker').length,1);
  assert.ok(f.calls.indexOf('executor-enter')>f.calls.indexOf('open:gate'));
  assert.ok(f.calls.filter(call=>call.startsWith('account:')).length>=16);
  const extra=f.orders.slice(1);assert.equal(extra[0].makerReduction!.lotTailOriginalParentClientId,f.parent.request.clientOrderId);
  assert.equal(extra[0].result!.filledQuantity,4);assert.equal(extra[1].result!.filledQuantity,10);
  assert.equal(extra[1].executionEvidence!.makerCloseLotTailOriginalParentClientId,f.parent.request.clientOrderId);
});

test('real Engine and Execution accept only their verified new Maker financial event before peer ten',async t=>{
  const f=fixture(t);f.useRealExecution();
  const original=structuredClone(f.parent),epoch=f.internal.financialEpoch,frozen=f.p.profitExitNotionalUsd;
  const result=await f.repair();
  assert.equal(result.repaired,true,JSON.stringify({actions:f.actions,calls:f.calls,risk:f.p.riskReasons,plan:f.plan().status}));assert.deepEqual(f.actions,['native-maker:4','native-terminal-maker:4','native-peer:10']);
  assert.equal(f.p.long.quantity,3660);assert.equal(f.p.short.quantity,3660);assert.equal(f.p.status,'open');
  assert.equal(f.p.closeRequestedAt,undefined);assert.equal(f.p.automaticCloseHistory?.length,1);
  assert.deepEqual(f.parent,original);assert.equal(f.p.profitExitNotionalUsd,frozen);
  assert.equal(f.orders.length,3);assert.equal(f.orders[1].makerReduction?.bookedExecution,true);
  assert.equal(f.orders[1].result?.filledQuantity,4);assert.equal(f.orders[1].executionEvidence?.bookedFeeUsd,f.orders[1].result?.feeUsd);
  assert.equal(f.orders[2].result?.filledQuantity,10);
  assert.deepEqual(f.orders[2].executionEvidence?.makerCloseLotTailParentClientIds,[f.parent.request.clientOrderId,f.orders[1].request.clientOrderId]);
  assert.ok(Math.abs(f.p.feesUsd-(.2+4*.03*.0002+10*.031*.0005))<1e-12);
  assert.ok(f.internal.financialEpoch>=epoch+2,'actual Maker cash increments the Engine epoch before the scope closes');
  assert.deepEqual([...f.internal.reconciledPositions],[f.p.id]);assert.equal(f.engine.autoEnabled,false);
});

test('live marks, account valuations and display decisions during post-Maker account proofs cannot revoke real four-to-ten cash permission',async t=>{
  const f=fixture(t);f.useRealExecution();const original=JSON.stringify(f.parent),funding=f.p.fundingUsd,
    events=JSON.stringify(f.p.fundingEvents),principal=f.p.profitExitNotionalUsd;
  f.long.bookTransport='websocket';f.short.bookTransport='websocket';
  f.onMaker(value=>{f.advanceClock(2500);assert.equal(f.plan().status,'waiting','a slow original cash GET outlasts both initial BBOs');
    return {...value,observedAt:Date.now()};});
  let observations=0;
  f.onAccount(exchange=>{
    if(!f.actions.includes('native-terminal-maker:4'))return;
    observations++;const leg=exchange==='gate'?f.p.long:f.p.short,row=f.accounts.get(exchange)!.positions[0];
    leg.markPrice+=.000001;leg.liquidationDistancePct=72+observations;
    row.markPrice=leg.markPrice;row.unrealizedPnlUsd=observations/100;row.liquidationPrice=leg.markPrice/2;
    f.p.spreadPnlUsd=observations/10;f.p.netPnlUsd=observations/20;f.p.deltaUsd=observations/30;
    f.p.estimatedNetPnlAfterRebateUsd=observations/40;f.p.riskReasons=[`updated display observation ${observations}`];
    f.p.holdDecision={action:'hold',reason:'new displayed funding observation',expectedFundingUsd:0,
      incrementalCostUsd:0,expectedNetUsd:0,nextReviewAt:Date.now()+5000,targetFundingTime:Date.now()+1_800_000};
  });
  const result=await f.repair();assert.equal(result.repaired,true);
  assert.ok(observations>=4,'display observations must actually change while both new account proofs are awaited');
  assert.deepEqual(f.actions,['native-maker:4','native-terminal-maker:4','native-peer:10']);
  assert.equal(f.p.long.quantity,3660);assert.equal(f.p.short.quantity,3660);assert.equal(f.p.status,'open');
  assert.equal(f.orders.length,3);assert.equal(f.orders[1].result?.filledQuantity,4);assert.equal(f.orders[2].result?.filledQuantity,10);
  assert.equal(JSON.stringify(f.parent),original);assert.equal(f.p.fundingUsd,funding);assert.equal(JSON.stringify(f.p.fundingEvents),events);
  assert.equal(f.p.profitExitNotionalUsd,principal);assert.ok(Math.abs(f.p.feesUsd-(.2+4*.03*.0002+10*.031*.0005))<1e-12);
  assert.ok(Math.abs(f.p.realizedSpreadPnlUsd-.01)<1e-12);assert.deepEqual([...f.internal.reconciledPositions],[f.p.id]);
  assert.ok(f.calls.indexOf('book:gate')>f.calls.indexOf('native-original-maker'),'the scoped wrapper obtains a new complete BBO after original native cash');
});

test('foreign real cash, original basis, quantity, intent or booked-journal changes during post-Maker account proofs still deny peer ten',async t=>{
  const scenarios=[
    {name:'funding',mutate:(f:ReturnType<typeof fixture>)=>{f.p.fundingUsd+=.001;}},
    {name:'fee',mutate:(f:ReturnType<typeof fixture>)=>{f.p.feesUsd+=.001;}},
    {name:'realized',mutate:(f:ReturnType<typeof fixture>)=>{f.p.realizedSpreadPnlUsd+=.001;}},
    {name:'basis',mutate:(f:ReturnType<typeof fixture>)=>{f.p.short.entryPrice+=.0001;}},
    {name:'quantity',mutate:(f:ReturnType<typeof fixture>)=>{f.p.long.quantity-=10;}},
    {name:'intent',mutate:(f:ReturnType<typeof fixture>)=>{f.p.closeProfitRequired=false;}},
    {name:'new-booked-journal',mutate:(f:ReturnType<typeof fixture>)=>{const evidence=f.orders[1].executionEvidence!;evidence.bookedFeeUsd=evidence.bookedFeeUsd!+.001;}},
  ];
  for(const scenario of scenarios){const f=fixture(t);f.useRealExecution();const original=JSON.stringify(f.parent);let changed=false;
    f.onAccount(()=>{if(!changed&&f.actions.includes('native-terminal-maker:4')){changed=true;scenario.mutate(f);}});
    await assert.rejects(f.repair(),/现金|数量|身份|意图|终态/,scenario.name);
    assert.equal(changed,true,scenario.name);assert.deepEqual(f.actions,['native-maker:4','native-terminal-maker:4'],scenario.name);
    assert.equal(f.orders.length,2,scenario.name);assert.equal(f.orders[1].result?.id,'NATIVE-NEW-MAKER',scenario.name);
    assert.equal(f.orders[1].result?.filledQuantity,4,scenario.name);assert.equal(f.orders[1].makerReduction?.bookedExecution,true,scenario.name);
    assert.equal(f.p.short.quantity,3660,scenario.name);assert.equal(f.p.status,'attention',scenario.name);
    assert.equal(JSON.stringify(f.parent),original,scenario.name);assert.deepEqual([...f.internal.reconciledPositions],[],scenario.name);
    assert.equal(f.calls.includes('validate-peer'),false,scenario.name);
  }
});

test('real funding history permits the minimum Maker four, then actual peer ten even when funding reverses after the four is booked',async t=>{
  const f=fundingFixture(t),original=JSON.stringify(f.parent),funding=f.p.fundingUsd;let reversed=false;
  f.onAccount(()=>{
    if(reversed||!f.actions.includes('native-terminal-maker:4'))return;
    reversed=true;f.update(Date.now(),-.01);
    const long=f.engine.snapshot('gate',f.p.base)!,short=f.engine.snapshot('bybit',f.p.base)!,
      assessment=assessConfirmedLotTailFundingExit(f.p,long,short,f.config,Date.now(),10,4);
    assert.equal(f.tracker.evaluate(f.p,long,short,assessment,f.config,Date.now()).passes,false,
      'new reductions have lost funding qualification; already booked cash remains a different permission');
  });
  const result=await f.repair();assert.equal(result.repaired,true);assert.equal(reversed,true);
  assert.deepEqual(f.actions,['native-maker:4','native-terminal-maker:4','native-peer:10']);
  assert.equal(f.p.long.quantity,3660);assert.equal(f.p.short.quantity,3660);assert.equal(f.p.status,'open');
  assert.equal(JSON.stringify(f.parent),original);assert.equal(f.orders.length,3);assert.equal(f.orders[1].result?.filledQuantity,4);
  assert.equal(f.orders[2].result?.filledQuantity,10);assert.equal(f.p.fundingUsd,funding);
  assert.equal(f.calls.filter(call=>call.startsWith('fee:')).length,2,'only the new finer action requires actual fee reads');
  assert.ok(Math.abs(f.p.feesUsd-(.2+4*.03*.0002+10*.03*.0005))<1e-12);assert.equal(f.p.realizedSpreadPnlUsd,0);
  assert.deepEqual([...f.internal.reconciledPositions],[f.p.id]);
});

test('instant funding, insufficient history and a distant payment cannot add a new Maker despite an adverse reference carry',async t=>{
  for(const scenario of [{samples:0,delay:120_000},{samples:4,delay:120_000},{samples:5,delay:600_000}]){
    const f=fundingFixture(t,scenario.samples,scenario.delay),original=JSON.stringify(f.parent),result=await f.repair();
    assert.equal(result.repaired,false,JSON.stringify(scenario));assert.deepEqual(f.actions,[]);assert.equal(f.orders.length,1);
    assert.equal(JSON.stringify(f.parent),original);assert.equal(f.p.long.quantity,3670);assert.equal(f.p.short.quantity,3664);
    assert.equal(f.p.status,'attention');assert.deepEqual([...f.internal.reconciledPositions],[]);
    assert.equal(f.calls.includes('validate-maker'),false,'native fee refresh does not manufacture history or an open payment window');
  }
});

test('a funding reversal at the actual native Maker permission guard cannot submit the planned new four',async t=>{
  const f=fundingFixture(t),original=JSON.stringify(f.parent),bybit=f.adapters.find(adapter=>adapter.id==='bybit')!,submit=bybit.submitMakerReduction!;
  bybit.submitMakerReduction=async(request,permission)=>{assert.equal(request.quantity,4);f.advanceClock(1);f.update(Date.now(),-.01);
    return submit(request,permission);};
  const result=await f.repair();assert.equal(result.repaired,false);assert.deepEqual(f.actions,[]);
  assert.equal(f.orders.length,2);assert.equal(f.orders[1].result?.filledQuantity,0);assert.equal(f.orders[1].result?.id,'');
  assert.equal(f.orders[1].result?.rejectionCode,'MAKER_REDUCTION_PERMISSION_CHANGED');assert.equal(f.orders[1].makerReduction?.bookedExecution,true);
  assert.equal(JSON.stringify(f.parent),original);assert.equal(f.p.long.quantity,3670);assert.equal(f.p.short.quantity,3664);
  assert.equal(f.p.status,'attention');assert.deepEqual([...f.internal.reconciledPositions],[]);assert.equal(f.calls.includes('validate-peer'),false);
});

test('an explicitly unavailable finer or peer feed at native permission preserves history but cannot submit new funding-loss cash',async t=>{
  for(const exchange of ['gate','bybit'] as const){const f=fundingFixture(t),original=JSON.stringify(f.parent),
      bybit=f.adapters.find(adapter=>adapter.id==='bybit')!,submit=bybit.submitMakerReduction!;
    const internal=f.engine as unknown as {unavailableSnapshots:Set<string>;
      confirmLotTailFundingExit(position:typeof f.p,assessment:AlignedExitAssessment,long:MarketSnapshot,short:MarketSnapshot,now:number):boolean};
    let denied=0;
    bybit.submitMakerReduction=async(request,permission)=>{
      denied++;internal.unavailableSnapshots.add(`${exchange}:${f.p.base}`);
      const long=f.engine.snapshot('gate',f.p.base)!,short=f.engine.snapshot('bybit',f.p.base)!,
        assessment=assessConfirmedLotTailFundingExit(f.p,long,short,f.config,Date.now(),10,4)!;
      assert.ok(assessment);assert.equal(internal.confirmLotTailFundingExit(f.p,assessment,long,short,Date.now()),false);
      assert.equal(f.p.holdDecision?.fundingExitStability?.sampleCount,5,'a short explicit feed outage preserves genuine prior observations');
      assert.equal(f.p.holdDecision?.fundingExitStability?.status,'unavailable');return submit(request,permission);
    };
    const result=await f.repair();assert.equal(result.repaired,false,exchange);assert.ok(denied>0);assert.deepEqual(f.actions,[]);
    assert.equal(f.orders.length,1+denied);assert.equal(JSON.stringify(f.parent),original);assert.equal(f.p.long.quantity,3670);assert.equal(f.p.short.quantity,3664);
    for(const order of f.orders.slice(1)){assert.equal(order.result?.filledQuantity,0);assert.equal(order.result?.id,'');
      assert.equal(order.result?.rejectionCode,'MAKER_REDUCTION_PERMISSION_CHANGED');assert.equal(order.makerReduction?.bookedExecution,true);}
    assert.equal(f.calls.includes('validate-peer'),false);assert.deepEqual([...f.internal.reconciledPositions],[]);
  }
});

test('a matched true-cash repair retains same-session funding history for actual remaining holdings but clears it on neutral or positive reads',async t=>{
  const f=fundingFixture(t),result=await f.repair();assert.equal(result.repaired,true);
  assert.equal(f.p.status,'open');assert.equal(f.p.long.quantity,3660);assert.equal(f.p.short.quantity,3660);
  const evaluate=(tracker=f.tracker)=>{const long=f.engine.snapshot('gate',f.p.base)!,short=f.engine.snapshot('bybit',f.p.base)!,
      assessment=assessAlignedExit(f.p,long,short,f.config,Date.now(),false,undefined,{pricing:'best-opposite',requireNativeFees:true});
    assert.ok(assessment);return tracker.evaluate(f.p,long,short,assessment,f.config,Date.now());};
  const retained=evaluate();assert.equal(retained.passes,true);assert.equal(retained.sampleCount,5);assert.equal(retained.observedSpanMs,180_000);
  assert.equal(f.p.holdDecision?.fundingExitStability?.sampleCount,5,'the original DTO is retained only as display evidence');
  const restarted=evaluate(new FundingExitStabilityTracker());assert.equal(restarted.passes,false);assert.equal(restarted.sampleCount,1);
  for(const rate of [.0001,-.01]){f.advanceClock(1);f.update(Date.now(),rate);const cleared=evaluate();
    assert.equal(cleared.status,rate>0?'neutral':'positive');assert.equal(cleared.passes,false);assert.equal(cleared.sampleCount,0);
    f.advanceClock(1);f.update(Date.now());const adverseAgain=evaluate();assert.equal(adverseAgain.passes,false);
    assert.equal(adverseAgain.sampleCount,1);assert.equal(adverseAgain.observedSpanMs,0);
  }
  assert.deepEqual(f.actions,['native-maker:4','native-terminal-maker:4','native-peer:10']);assert.equal(f.orders.length,3);
  assert.equal(f.calls.filter(call=>call.startsWith('fee:')).length,2,'read-only stability evaluations never fetch fees');
});

test('historical funding, dual and missing entry policies use current funding-loss management without rewriting the original strategy fields',async t=>{
  const histories:NonNullable<Parameters<typeof fundingFixture>[3]>[]=[
    {entryPolicy:'funding',holdMode:'once'},{entryPolicy:'dual',holdMode:'continuous'},{entryPolicy:undefined,holdMode:'once'}];
  for(const historical of histories){const f=fundingFixture(t,5,120_000,historical),original=JSON.stringify(f.parent),policy=JSON.stringify(f.p.profitExitPolicy);
    const result=await f.repair();assert.equal(result.repaired,true,JSON.stringify(historical));
    assert.deepEqual(f.actions,['native-maker:4','native-terminal-maker:4','native-peer:10']);assert.equal(f.orders.length,3);
    assert.equal(f.p.long.quantity,3660);assert.equal(f.p.short.quantity,3660);assert.equal(f.p.status,'open');
    assert.equal(f.p.entryPolicy,historical.entryPolicy);assert.equal(f.p.holdMode,historical.holdMode);
    assert.equal(JSON.stringify(f.parent),original);assert.equal(JSON.stringify(f.p.profitExitPolicy),policy);
    const savedOrders=JSON.stringify(f.orders);let ordinaryGuards=0;
    f.engine.execution.close=async(position,_reason,qualify,options)=>{
      assert.equal(position,f.p);assert.equal(options?.pricing,'best-opposite');assert.equal(options?.requireProfit,true);assert.ok(qualify);
      assert.equal(qualify(.03,.03001,10),true,'the ordinary callback must recompute full matched carry and reuse the same genuine five-observation history');
      assert.equal(f.p.holdDecision?.fundingExitStability?.sampleCount,5);assert.equal(f.p.holdDecision?.fundingExitStability?.observedSpanMs,180_000);
      assert.equal(f.p.holdDecision?.fundingExitStability?.status,'confirmed');ordinaryGuards++;return false;
    };
    await (f.engine as unknown as {managePosition(position:typeof f.p,now:number):Promise<void>}).managePosition(f.p,Date.now());
    assert.equal(ordinaryGuards,1,JSON.stringify(historical));assert.equal(JSON.stringify(f.orders),savedOrders,'capturing ordinary eligibility creates no extra financial intent');
    assert.equal(f.p.entryPolicy,historical.entryPolicy);assert.equal(f.p.holdMode,historical.holdMode);
    assert.equal(JSON.stringify(f.parent),original);assert.equal(JSON.stringify(f.p.profitExitPolicy),policy);
    assert.equal(f.calls.filter(call=>call.startsWith('fee:')).length,2);assert.equal(f.store.data.killSwitch,false);
  }
});

function appendNeverSentAugmentation(f:ReturnType<typeof fixture>){
  const order=f.augmentation(4,0);order.result!.id='';order.result!.rejectionCode='MAKER_REDUCTION_PERMISSION_CHANGED';
  order.result!.rejectionReason='Memory native final guard prevented creation';return order;
}

test('a related proved never-sent four remains immutable while real Engine and Execution confirm a new four then peer ten',async t=>{
  const f=fixture(t);f.useRealExecution();const old=appendNeverSentAugmentation(f),saved=JSON.stringify(old),parent=JSON.stringify(f.parent);
  const bybit=f.adapters.find(adapter=>adapter.id==='bybit')!,submit=bybit.submitMakerReduction!,inspect=bybit.inspectMakerReduction!;
  bybit.submitMakerReduction=async(request,permission)=>{assert.notEqual(request.clientOrderId,old.request.clientOrderId,'the old local intent must never be replayed');
    return submit(request,permission);};
  bybit.inspectMakerReduction=async(request,id)=>{assert.ok(id,'a local no-create witness has no native order to GET');
    assert.notEqual(request.clientOrderId,old.request.clientOrderId);return inspect(request,id);};
  const result=await f.repair();assert.equal(result.repaired,true);
  assert.deepEqual(f.actions,['native-maker:4','native-terminal-maker:4','native-peer:10']);
  assert.equal(f.p.long.quantity,3660);assert.equal(f.p.short.quantity,3660);assert.equal(f.p.status,'open');
  assert.equal(f.orders.length,4);assert.equal(JSON.stringify(old),saved);assert.equal(JSON.stringify(f.parent),parent);
  assert.equal(f.orders[2].result!.filledQuantity,4);assert.equal(f.orders[2].makerReduction?.bookedExecution,true);
  assert.equal(f.orders[3].result!.filledQuantity,10);assert.equal(f.calls.filter(call=>call==='native-original-maker').length,1);
});

test('generic, hard, unknown and unbooked augmentation receipts cannot use the never-sent exception',async t=>{
  const cases:Array<(order:JournalOrder)=>void>=[
    order=>{order.result!.rejectionCode='ORDER_SUBMISSION_PERMISSION_CHANGED';},
    order=>{order.result!.rejectionCode='110017';},order=>{order.result!.rejectionCode='PRE_SUBMISSION_CHECK_FAILED';},
    order=>{order.result!.status='unknown';},order=>{order.makerReduction!.activity='unknown';},
    order=>{order.makerReduction!.bookedExecution=false;},order=>{order.result!.averagePrice=.03;},
    order=>{order.executionEvidence!.bookedFeeUsd=.001;},order=>{order.result!.feeUsd=.001;},
  ];
  for(const [index,mutate] of cases.entries()){const f=fixture(t);f.useRealExecution();const old=appendNeverSentAugmentation(f);mutate(old);
    const original=JSON.stringify(f.orders);await assert.rejects(f.repair(),`augmentation rejection case ${index}`);
    assert.equal(JSON.stringify(f.orders),original);assert.equal(f.orders.length,2);assert.deepEqual(f.actions,[]);
    assert.equal(f.p.long.quantity,3670);assert.equal(f.p.short.quantity,3664);assert.deepEqual([...f.internal.reconciledPositions],[]);}
});

test('an empty original root ID cannot borrow the related local no-create exception',async t=>{
  const f=fixture(t);f.useRealExecution();f.parent.result={...f.parent.result!,id:'',status:'cancelled',filledQuantity:0,
    averagePrice:0,feeUsd:0,rejectionCode:'MAKER_REDUCTION_PERMISSION_CHANGED'};
  f.parent.executionEvidence!.bookedFeeUsd=0;const original=JSON.stringify(f.parent);
  await assert.rejects(f.repair());assert.equal(JSON.stringify(f.parent),original);assert.equal(f.orders.length,1);
  assert.deepEqual(f.actions,[]);assert.equal(f.calls.includes('native-original-maker'),false);
});

test('a related zero with a real native ID still requires its exact native cash GET and cannot hide a mismatch',async t=>{
  const f=fixture(t);f.useRealExecution();const old=appendNeverSentAugmentation(f);old.result!.id='NATIVE-ACTUAL-ZERO-AUGMENTATION';
  const original=JSON.stringify(old),bybit=f.adapters.find(adapter=>adapter.id==='bybit')!,inspect=bybit.inspectMakerReduction!;
  bybit.inspectMakerReduction=async(request,id)=>{if(request.clientOrderId!==old.request.clientOrderId)return inspect(request,id);
    assert.equal(id,old.result!.id);assert.deepEqual(request,old.request);f.calls.push('native-real-zero-augmentation');
    return {activity:'terminal',executionVerified:true,observedAt:Date.now(),result:{...structuredClone(old.result!),feeUsd:.001}};};
  await assert.rejects(f.repair(),/原生身份|完整现金/);assert.equal(f.calls.filter(call=>call==='native-real-zero-augmentation').length,1);
  assert.equal(JSON.stringify(old),original);assert.equal(f.orders.length,2);assert.deepEqual(f.actions,[]);
  assert.equal(f.p.long.quantity,3670);assert.equal(f.p.short.quantity,3664);assert.deepEqual([...f.internal.reconciledPositions],[]);
});

test('an unrelated real financial event cannot be adopted as the new Maker epoch and never consumes peer budget',async t=>{
  const f=fixture(t);f.useRealExecution();const original=structuredClone(f.parent);
  const context=(f.engine.execution as unknown as {context:{makerFinancialActivity?:(journal?:JournalOrder)=>void}}).context;
  f.onNativeTerminal(()=>context.makerFinancialActivity?.(f.parent));
  await assert.rejects(f.repair(),/授权|运行状态|确认期限/);
  assert.deepEqual(f.actions,['native-maker:4','native-terminal-maker:4']);assert.equal(f.orders.length,2);
  assert.equal(f.orders[1].makerReduction?.bookedExecution,true);assert.equal(f.orders[1].result?.filledQuantity,4);
  assert.equal(f.p.long.quantity,3670);assert.equal(f.p.short.quantity,3660);assert.equal(f.p.status,'attention');
  assert.deepEqual(f.parent,original);assert.deepEqual([...f.internal.reconciledPositions],[]);
  assert.equal(f.calls.includes('validate-peer'),false);assert.ok(f.p.closeRequestedAt);
});

test('consistent native account prices from another basis cannot seed the scoped original lot restoration',async t=>{
  const f=fixture(t);f.useRealExecution();const original=structuredClone(f.parent);
  f.accounts.get('bybit')!.positions[0].entryPrice=.0301;
  await assert.rejects(f.repair(),/均价|成本/);assert.deepEqual(f.actions,[]);assert.equal(f.orders.length,1);
  assert.deepEqual(f.parent,original);assert.deepEqual([...f.internal.reconciledPositions],[]);
});

test('invalid lot acknowledgement, stale scope and widening old-peer or fee-correction inputs cannot add a reduction',async t=>{
  const f=fixture(t),valid=f.request(),bad=[{...valid,acknowledgement:'WRONG'},{...valid,expiresAt:Date.now()-1},
    {...valid,expected:{...valid.expected,shortQuantity:3663}},{...valid,legacyPeerClientOrderIds:[]},
    {...valid,expectedPeerFeeCorrections:[]}];
  for(const input of bad){await assert.rejects(f.repair(input as SelectedMakerCloseRepairRequest));assert.deepEqual(f.actions,[]);assert.equal(f.orders.length,1);}
});

test('inconsistent original native Maker quantity or real cash never reaches a new reduction',async t=>{
  const f=fixture(t),original=JSON.stringify(f.parent);
  for(const mismatch of ['fee','quantity','id','client','active','unverified','stale'] as const){
    f.onMaker(value=>{const result=structuredClone(value);
      if(mismatch==='fee')result.result.feeUsd+=.001;
      else if(mismatch==='quantity')result.result.filledQuantity=5;
      else if(mismatch==='id')result.result.id='foreign-native';
      else if(mismatch==='client')result.result.clientOrderId='foreign-client';
      else if(mismatch==='active')result.activity='active';
      else if(mismatch==='unverified')result.executionVerified=false;
      else result.observedAt=Date.now()-1;return result;});
    await assert.rejects(f.repair());assert.deepEqual(f.actions,[]);assert.equal(f.orders.length,1);assert.equal(JSON.stringify(f.parent),original);
  }
});

test('foreign same-coin unknown original intent freezes scoped lot restoration before any new action',async t=>{
  const f=fixture(t),unknown=structuredClone(f.parent);unknown.positionId='another-origin';unknown.request.clientOrderId='foreign-unknown-client';
  unknown.result!.clientOrderId=unknown.request.clientOrderId;unknown.result!.id='foreign-unknown-native';unknown.result!.status='unknown';
  unknown.makerReduction!.activity='unknown';f.orders.push(unknown);
  const original=JSON.stringify(f.orders);await assert.rejects(f.repair());assert.deepEqual(f.actions,[]);
  assert.equal(JSON.stringify(f.orders),original);assert.deepEqual([...f.internal.reconciledPositions],[]);
});

test('the second initial account proof cannot replace the original native slot before augmentation',async t=>{
  const f=fixture(t);f.onAccount((exchange,count)=>{if(exchange==='bybit'&&count===2)f.accounts.get(exchange)!.positions[0].positionId='replacement-slot';});
  await assert.rejects(f.repair(),/身份|账户/);assert.deepEqual(f.actions,[]);assert.equal(f.orders.length,1);
});

test('a new account identity after confirmed Maker cash stops peer consumption and preserves the real four fill',async t=>{
  const f=fixture(t),original=JSON.stringify(f.parent);f.onPhase(phase=>{if(phase==='after-maker')f.accounts.get('bybit')!.positions[0].positionId='replacement-slot';});
  await assert.rejects(f.repair(),/身份/);assert.deepEqual(f.actions,['terminal-maker:4']);assert.equal(f.orders.length,2);
  assert.equal(f.p.short.quantity,3660);assert.equal(f.p.long.quantity,3670);assert.equal(JSON.stringify(f.parent),original);
  assert.equal(f.p.status,'attention');assert.deepEqual([...f.internal.reconciledPositions],[]);
});

test('a current unprofitable additional common reduction waits without consuming the original six budget',async t=>{
  const f=fixture(t);f.long.bids[0].price=.029;f.long.asks[0].price=.02901;assert.equal(f.plan().status,'waiting');
  const original=JSON.stringify(f.parent),result=await f.repair();assert.equal(result.repaired,false);assert.deepEqual(f.actions,[]);
  assert.equal(f.p.long.quantity,3670);assert.equal(f.p.short.quantity,3664);assert.equal(f.orders.length,1);assert.equal(JSON.stringify(f.parent),original);
  assert.deepEqual([...f.internal.reconciledPositions],[]);
});

test('financial cash mutations at the last augmentation guard never add a Maker intent',async t=>{
  const f=fixture(t);f.onPhase(phase=>{if(phase==='before-maker')f.p.fundingUsd+=1;});
  await assert.rejects(f.repair(),/现金|意图/);assert.deepEqual(f.actions,[]);assert.equal(f.orders.length,1);
});

test('session changes after verified finer cash deny the peer final guard without losing the new native receipt',async t=>{
  const f=fixture(t);f.onPhase(phase=>{if(phase==='before-peer')f.engine.autoEnabled=true;});
  await assert.rejects(f.repair(),/授权|运行状态/);assert.deepEqual(f.actions,['terminal-maker:4']);
  assert.equal(f.orders.length,2);assert.equal(f.orders[1].result!.filledQuantity,4);assert.equal(f.p.short.quantity,3660);
  assert.equal(f.p.long.quantity,3670);assert.deepEqual([...f.internal.reconciledPositions],[]);
});

test('a native conditional close-all order cannot be treated as a proved empty list',async t=>{
  const f=fixture(t);f.onOpen(()=>[{id:'conditional',base:f.p.base,symbol:f.p.long.symbol,quantity:0,remainingQuantity:0,kind:'conditional'}]);
  await assert.rejects(f.repair(),/挂单/);assert.deepEqual(f.actions,[]);assert.equal(f.orders.length,1);
});

type ScheduledEngine={
  scheduleConfirmedLotTailRestoration(position:ReturnType<typeof fixture>['p'],now:number):boolean;
  repairSelectedMakerLotTail(request:SelectedMakerCloseRepairRequest,automatic?:boolean):ReturnType<ReturnType<typeof fixture>['repair']>;
};

test('reference discovery queues one strict automatic verification without an order or native-fee submission permit',async t=>{
  const f=fixture(t),scheduled=f.engine as unknown as ScheduledEngine,queued:Array<{request:SelectedMakerCloseRepairRequest;automatic?:boolean}>=[];
  delete f.short.takerFeeRate;delete f.short.makerFeeRate;
  assert.equal(f.plan().status,'waiting','current native fees are absent even though reference profit is attractive');
  f.engine.running=true;f.engine.autoEnabled=true;
  scheduled.repairSelectedMakerLotTail=async(request,automatic)=>{queued.push({request:structuredClone(request),automatic});
    return {positionId:f.p.id,repaired:false,longQuantity:f.p.long.quantity,shortQuantity:f.p.short.quantity,checkedAt:Date.now()};};
  assert.equal(scheduled.scheduleConfirmedLotTailRestoration(f.p,Date.now()),true);
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(queued.length,1);assert.equal(queued[0].automatic,true);assert.equal(queued[0].request.parentClientOrderId,f.parent.request.clientOrderId);
  assert.equal(queued[0].request.expected.shortQuantity,3664);assert.deepEqual(f.actions,[]);assert.equal(f.orders.length,1);
  assert.equal(f.calls.filter(call=>call.startsWith('native-')||call.startsWith('account:')).length,0);
  assert.equal(scheduled.scheduleConfirmedLotTailRestoration(f.p,Date.now()),true,'the same position/root remains managed but is throttled after its verification settles');
  assert.equal(queued.length,1);
  f.engine.autoEnabled=false;assert.equal(scheduled.scheduleConfirmedLotTailRestoration(f.p,Date.now()+60_001),false);
  assert.equal(queued.length,1);assert.deepEqual([...f.internal.reconciledPositions],[]);
});

test('mature funding-only reference discovery queues strict verification with no private market, cash or fee request',async t=>{
  const f=fundingFixture(t),scheduled=f.engine as unknown as ScheduledEngine,queued:SelectedMakerCloseRepairRequest[]=[];
  for(const book of [f.long,f.short]){delete book.takerFeeRate;delete book.makerFeeRate;}
  f.engine.running=true;f.engine.autoEnabled=true;
  scheduled.repairSelectedMakerLotTail=async(request,automatic)=>{assert.equal(automatic,true);queued.push(structuredClone(request));
    return {positionId:f.p.id,repaired:false,longQuantity:f.p.long.quantity,shortQuantity:f.p.short.quantity,checkedAt:Date.now()};};
  assert.equal(scheduled.scheduleConfirmedLotTailRestoration(f.p,Date.now()),true);
  await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(queued.length,1);
  assert.equal(queued[0].parentClientOrderId,f.parent.request.clientOrderId);assert.equal(queued[0].expected.longQuantity,3670);
  assert.equal(queued[0].expected.shortQuantity,3664);assert.deepEqual(f.actions,[]);assert.equal(f.orders.length,1);
  assert.equal(f.calls.filter(call=>/^(fee:|book:|account:|native-)/.test(call)).length,0);
  assert.equal(f.p.holdDecision?.fundingExitStability?.sampleCount,5);assert.equal(f.p.holdDecision?.fundingExitStability?.observedSpanMs,180_000);
  assert.equal(scheduled.scheduleConfirmedLotTailRestoration(f.p,Date.now()),true);await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(queued.length,1);assert.deepEqual(f.actions,[]);
});

test('pausing automatic execution while original native cash is awaited revokes the queued lot repair permission',async t=>{
  const f=fixture(t),scheduled=f.engine as unknown as ScheduledEngine;
  let started!:()=>void,release!:()=>void;
  const nativeStarted=new Promise<void>(resolve=>{started=resolve;}),nativeReleased=new Promise<void>(resolve=>{release=resolve;});
  f.adapters.find(adapter=>adapter.id==='bybit')!.inspectMakerReduction=async(request,nativeId)=>{
    assert.deepEqual(request,f.parent.request);assert.equal(nativeId,f.parent.result!.id);started();await nativeReleased;
    return {activity:'terminal',executionVerified:true,observedAt:Date.now(),result:structuredClone(f.parent.result!)};
  };
  f.engine.running=true;f.engine.autoEnabled=true;
  assert.equal(scheduled.scheduleConfirmedLotTailRestoration(f.p,Date.now()),true);
  await nativeStarted;f.engine.autoEnabled=false;release();await new Promise<void>(resolve=>setImmediate(resolve));
  assert.deepEqual(f.actions,[]);assert.equal(f.orders.length,1);assert.equal(f.p.long.quantity,3670);assert.equal(f.p.short.quantity,3664);
  assert.equal(f.calls.filter(call=>call==='executor-enter'||call.startsWith('account:')).length,0);
  assert.deepEqual([...f.internal.reconciledPositions],[]);assert.equal(f.engine.autoEnabled,false);
});
