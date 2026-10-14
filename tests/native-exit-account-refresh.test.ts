import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import type {AccountState,ExchangeId,Position} from '../src/shared/types.js';
import {profitExitPolicy} from '../src/core/profit-exit.js';
import {fixture,completeKnownTail,extraUnknown,base,type Fixture,type Internal} from './native-exit-read-fixture.js';
type RefreshInternal=Internal&{
  continuingClosePositions:Set<string>;realtimeProfitPending:Set<string>;
  runRealtimeProfitExits():Promise<void>;realtimeProfitCandidate(p:Position):boolean;
  realtimeProfitAccountProof(p:Position):unknown;closeAccountsFresh(p:Position):boolean;
  accountMatchesPosition(p:Position):boolean;cacheAccount(exchange:ExchangeId,account:AccountState):boolean;
  managePositions(now:number):Promise<void>;detailedPlan(now:number):Map<ExchangeId,string[]>;
  detailedOpportunities():never[];accrueLiveFunding():Promise<void>;
};

function refreshQuotes(f:Fixture){
  for(const quote of f.quotes.values())Object.assign(quote,{timestamp:Date.now(),observedAt:Date.now(),fundingObservedAt:Date.now()});
}
function accountReadCount(f:Fixture){return f.reads.filter(value=>value.startsWith('account:')).length;}
function cacheTimes(f:Fixture){return f.engine.health.map(row=>({exchange:row.exchange,at:row.accountUpdatedAt}));}
async function restoredFixture(t:TestContext,mode:'maker'|'ioc'='ioc'){
  const f=fixture(t,{makerExchange:'gate',peerExchange:'bitget'});
  f.engine.config.profitExitExecutionMode=mode;
  if(mode==='maker')f.p.profitExitPolicy=profitExitPolicy(f.quotes.get(f.p.long.exchange)!,f.quotes.get(f.p.short.exchange)!,f.engine.config);
  completeKnownTail(f);await f.grant();
  const internal=f.engine as unknown as RefreshInternal;
  // Complete the real Engine billing-read path in memory; missing legacy
  // settlement policy must not be mistaken for complete accrued cash.
  await internal.accrueLiveFunding();
  assert.equal(f.p.status,'open');assert.notEqual(f.p.closeRequestedAt,undefined);
  assert.equal(internal.continuingClosePositions.has(f.p.id),true);
  assert.equal(f.engine.execution.hasNativeExitAuthority(f.p),true);
  assert.equal(internal.exitPendingCoin(f.p),false);
  return {...f,internal};
}
function isolateRoutineTick(f:Awaited<ReturnType<typeof restoredFixture>>){
  // Observe publication of genuine in-memory routine GETs independently of trading.
  f.internal.managePositions=async()=>{};
  f.internal.detailedPlan=()=>new Map(f.engine.config.exchanges.map(exchange=>[exchange,[base]]));
  f.internal.detailedOpportunities=()=>[];
  for(const adapter of f.adapters)adapter.fetchSnapshots=async()=>[f.quotes.get(adapter.id)!];
}
function interceptFinancialDispatch(f:Awaited<ReturnType<typeof restoredFixture>>){
  const dispatches:Array<{positionId:string;nativeAuthority:boolean;accountsFresh:boolean;quantitiesMatch:boolean}>=[];
  const capture=(position:Position)=>{
    dispatches.push({positionId:position.id,nativeAuthority:f.engine.execution.hasNativeExitAuthority(position),
      accountsFresh:f.internal.closeAccountsFresh(position),quantitiesMatch:f.internal.accountMatchesPosition(position)});
    return true;
  };
  // The real Engine economics, account reads and Maker preparation run. This
  // captures the final dispatch boundary without creating an in-memory order.
  f.engine.execution.startMakerClose=async position=>capture(position);
  f.engine.execution.dispatchIocProfitClose=position=>capture(position);
  return dispatches;
}
async function wake(f:Awaited<ReturnType<typeof restoredFixture>>){
  f.engine.running=true;
  f.internal.realtimeProfitPending.add(f.p.id);
  await f.internal.runRealtimeProfitExits();
}

test('routine fresh account reads publish after a matched native exit grant despite its exact original unknown',async t=>{
  const f=await restoredFixture(t);
  try{
    const originalUnknown=structuredClone(f.unknown),previous=new Map(f.engine.accounts),times=cacheTimes(f);
    isolateRoutineTick(f);f.advance(31_000);refreshQuotes(f);
    assert.equal(f.internal.closeAccountsFresh(f.p),false);
    const before=accountReadCount(f);await f.engine.tick();
    assert.equal(accountReadCount(f)-before,2);
    for(const [exchange,account] of previous)assert.notEqual(f.engine.accounts.get(exchange),account);
    assert.ok(cacheTimes(f).every(row=>row.at!>times.find(old=>old.exchange===row.exchange)!.at!));
    assert.equal(f.internal.closeAccountsFresh(f.p),true);
    assert.equal(f.internal.pendingCoin(base),true,'Entry exclusions retain the unresolved original receipt.');
    assert.equal(f.internal.exitPendingCoin(f.p),false);
    assert.equal(f.engine.execution.hasNativeExitAuthority(f.p),true);
    assert.deepEqual(f.unknown,originalUnknown);assert.equal(f.store.data.orders.length,5);
  }finally{await f.engine.stop();}
});

for(const mode of ['maker','ioc'] as const)test(`an open restored ${mode} close intent obtains its own fresh paired account proof before dispatch`,async t=>{
  const f=await restoredFixture(t,mode);
  try{
    const originalUnknown=structuredClone(f.unknown),dispatches=interceptFinancialDispatch(f);
    f.advance(31_000);refreshQuotes(f);
    assert.equal(f.internal.closeAccountsFresh(f.p),false);
    const before=accountReadCount(f);await wake(f);
    assert.equal(accountReadCount(f)-before,2);
    assert.deepEqual(dispatches,[{positionId:f.p.id,nativeAuthority:true,accountsFresh:true,quantitiesMatch:true}]);
    assert.equal(f.internal.realtimeProfitAccountProof(f.p),undefined,'Scoped evidence is released after the exact wake.');
    assert.deepEqual(f.unknown,originalUnknown);assert.equal(f.store.data.orders.length,5);
  }finally{await f.engine.stop();}
});

test('a revoked native exit grant never exempts its original unknown from routine account busy protection',async t=>{
  const f=await restoredFixture(t);
  try{
    f.engine.execution.revokeNativeExitAuthority(f.p,'memory test revocation');
    const previous=new Map(f.engine.accounts),times=cacheTimes(f);isolateRoutineTick(f);
    f.advance(31_000);refreshQuotes(f);await f.engine.tick();
    for(const [exchange,account] of previous)assert.equal(f.engine.accounts.get(exchange),account);
    assert.deepEqual(cacheTimes(f),times);assert.equal(f.internal.exitPendingCoin(f.p),true);
  }finally{await f.engine.stop();}
});

test('a later unknown on the granted position keeps routine account evidence busy',async t=>{
  const f=await restoredFixture(t);
  try{
    extraUnknown(f);const previous=new Map(f.engine.accounts),times=cacheTimes(f);isolateRoutineTick(f);
    f.advance(31_000);refreshQuotes(f);await f.engine.tick();
    for(const [exchange,account] of previous)assert.equal(f.engine.accounts.get(exchange),account);
    assert.deepEqual(cacheTimes(f),times);assert.equal(f.internal.exitPendingCoin(f.p),true);
  }finally{await f.engine.stop();}
});

for(const scope of ['position','coin','contract','unidentified'] as const)test(`a new ${scope} unknown cannot use the old grant to refresh and dispatch another close`,async t=>{
  const f=await restoredFixture(t);
  try{
    extraUnknown(f,scope);const dispatches=interceptFinancialDispatch(f),before=accountReadCount(f);
    f.advance(31_000);refreshQuotes(f);await wake(f);
    assert.equal(f.internal.exitPendingCoin(f.p),true);assert.equal(accountReadCount(f),before);
    assert.equal(dispatches.length,0);assert.equal(f.store.data.orders.length,6);
  }finally{await f.engine.stop();}
});

test('a restored open intent with mismatched fresh native quantity does not progress to IOC dispatch',async t=>{
  const f=await restoredFixture(t);
  try{
    f.nativeAccounts.get(f.p.long.exchange)!.positions[0].quantity=94;
    const dispatches=interceptFinancialDispatch(f),before=accountReadCount(f);
    f.advance(31_000);refreshQuotes(f);await wake(f);
    assert.equal(accountReadCount(f)-before,2);assert.equal(dispatches.length,0);
    assert.equal(f.store.data.orders.length,5);assert.equal(f.p.long.quantity,95);
  }finally{await f.engine.stop();}
});

test('a different-contract financial epoch change permits scoped fresh quantities but never publishes the old whole account',async t=>{
  const f=await restoredFixture(t);
  try{
    const previous=new Map(f.engine.accounts),times=cacheTimes(f),dispatches=interceptFinancialDispatch(f);
    f.onAccount(()=>{f.internal.financialEpoch++;});
    f.advance(31_000);refreshQuotes(f);await wake(f);
    assert.deepEqual(dispatches,[{positionId:f.p.id,nativeAuthority:true,accountsFresh:true,quantitiesMatch:true}]);
    for(const [exchange,account] of previous)assert.equal(f.engine.accounts.get(exchange),account);
    assert.deepEqual(cacheTimes(f),times);assert.equal(f.store.data.orders.length,5);
  }finally{await f.engine.stop();}
});

test('selected-position cash changing during its fresh paired read denies dispatch',async t=>{
  const f=await restoredFixture(t);
  try{
    const dispatches=interceptFinancialDispatch(f);let changed=false;
    f.onAccount(()=>{if(!changed){changed=true;f.p.feesUsd+=.01;}});
    f.advance(31_000);refreshQuotes(f);const before=accountReadCount(f);await wake(f);
    assert.equal(accountReadCount(f)-before,2);assert.equal(dispatches.length,0);
    assert.equal(f.internal.realtimeProfitAccountProof(f.p),undefined);assert.equal(f.store.data.orders.length,5);
  }finally{await f.engine.stop();}
});

test('pausing an in-progress refresh permission denies the open restored intent without publishing fresh balances',async t=>{
  const f=await restoredFixture(t);
  try{
    const previous=new Map(f.engine.accounts),dispatches=interceptFinancialDispatch(f);
    f.onAccount(()=>{f.internal.sessionExchanges.clear();});
    f.advance(31_000);refreshQuotes(f);const before=accountReadCount(f);await wake(f);
    assert.equal(accountReadCount(f)-before,2);assert.equal(dispatches.length,0);
    assert.equal(f.engine.liveUnlocked,false);
    for(const [exchange,account] of previous)assert.equal(f.engine.accounts.get(exchange),account);
    assert.equal(f.store.data.orders.length,5);
  }finally{await f.engine.stop();}
});
