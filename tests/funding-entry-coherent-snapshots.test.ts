import test from 'node:test';
import assert from 'node:assert/strict';
import type {ExchangeId,MarketSnapshot} from '../src/shared/types.js';
import {automaticEntryCandidateReady} from '../src/shared/automatic-entry-policy.js';
import {fundingEntryFixture,confirmEntryFunding,entryStability} from './funding-entry-stability-fixture.js';

function installIndependentAdapterCache(f:ReturnType<typeof fundingEntryFixture>){
  f.engine.snapshots=f.engine.snapshots.map(quote=>structuredClone(quote));
  const latest=new Map<ExchangeId,MarketSnapshot>([...f.quotes].map(([exchange,quote])=>[exchange,structuredClone(quote)]));
  for(const adapter of f.adapters){
    adapter.getExecutionSnapshot=base=>base==='BTC'?latest.get(adapter.id):undefined;
    adapter.seedRealtimeSnapshot=quote=>{
      const prior=latest.get(adapter.id)!;
      latest.set(adapter.id,{...quote,bids:prior.bids,asks:prior.asks,bookTransport:'websocket',
        observedAt:Date.now(),timestamp:Date.now()});
    };
  }
  return latest;
}

function assertNoFinancialReadsOrOrders(f:ReturnType<typeof fundingEntryFixture>){
  assert.equal(f.counters.accounts,0);assert.equal(f.counters.fees,0);
  assert.equal(f.counters.inspections,0);assert.equal(f.counters.preparations,0);
  assert.equal(f.sent.length,0);assert.equal(f.store.data.orders.length,0);
}

for(const change of ['funding-rate','mark-price'] as const)test(`a scanner ${change} refresh immediately qualifies its current positive funding despite a newer pushed book`,async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fundingEntryFixture();
  try{
    const confirmed=confirmEntryFunding(f,ms=>t.mock.timers.tick(ms));
    const priorEvidence=structuredClone(confirmed.fundingEntryStability!);
    const latest=installIndependentAdapterCache(f);t.mock.timers.tick(1000);
    const updates=f.engine.snapshots.map(quote=>({...structuredClone(quote),bookTransport:'rest' as const,
      fundingObservedAt:Date.now()-20,observedAt:Date.now()-10,timestamp:Date.now()-10,
      ...(quote.exchange==='bybit'?change==='funding-rate'?{fundingRate:.0051}:{markPrice:101}:{})}));
    // Exercise the production scanner handoff, including its seed-before-book-age guard.
    await f.internal.publicFundingMonitor().options.publish(updates,f.engine.config);
    assert.equal(f.engine.snapshots.find(quote=>quote.exchange==='bybit')!.fundingRate,.005);
    assert.equal(f.engine.snapshots.find(quote=>quote.exchange==='bybit')!.markPrice,100);
    assert.ok(latest.get('bybit')!.fundingObservedAt!>priorEvidence.lastObservedAt!);
    const after=f.candidate()!,stability=entryStability(after);
    assert.equal(stability.status,'confirmed');assert.equal(stability.passes,true);
    assert.equal(stability.sampleCount,priorEvidence.sampleCount);
    assert.equal(stability.observedSpanMs,0);assert.equal(after.fundingEntryStability?.evidence?.version,2);
    assert.equal(after.fundingEntryStability?.evidence?.short.fundingObservedAt,latest.get('bybit')!.fundingObservedAt);
    assert.ok(after.expectedFundingUsd>confirmed.expectedFundingUsd);
    assert.equal(after.longRate,latest.get('gate')!.fundingRate);
    assert.equal(after.shortRate,latest.get('bybit')!.fundingRate);
    assertNoFinancialReadsOrOrders(f);
  }finally{await f.stop();}
});

test('calculation and current funding validation use the same single adapter read for each market',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fundingEntryFixture();
  try{
    confirmEntryFunding(f,ms=>t.mock.timers.tick(ms));installIndependentAdapterCache(f);
    const calls=new Map<ExchangeId,number>();
    for(const adapter of f.adapters){
      const original=adapter.getExecutionSnapshot!;
      adapter.getExecutionSnapshot=base=>{
        const count=(calls.get(adapter.id)??0)+1;calls.set(adapter.id,count);
        const quote=original(base)!;
        // A second read would change metadata. Later account/display previews may
        // read again, but cannot supply a different snapshot to the tracker.
        return {...quote,fundingRate:adapter.id==='bybit'?count===1?.005:.0051:0};
      };
    }
    const after=f.candidate()!;
    assert.equal(after.shortRate,.005);assert.equal(entryStability(after).status,'confirmed');
    assert.equal(entryStability(after).sampleCount,1);
    assertNoFinancialReadsOrOrders(f);
  }finally{await f.stop();}
});

test('a genuinely stale adapter funding read still clears confirmation even with a fresh stored cache',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fundingEntryFixture();
  try{
    confirmEntryFunding(f,ms=>t.mock.timers.tick(ms));const latest=installIndependentAdapterCache(f);
    latest.get('bybit')!.fundingObservedAt=Date.now()-30_001;
    const after=f.candidate()!;
    assert.equal(entryStability(after).status,'unavailable');assert.equal(entryStability(after).sampleCount,0);
    assert.equal(automaticEntryCandidateReady(after),false);
    t.mock.timers.tick(1000);
    for(const quote of latest.values()){quote.fundingObservedAt=Date.now();quote.observedAt=Date.now();quote.timestamp=Date.now();}
    const recovered=f.candidate()!;assert.equal(entryStability(recovered).sampleCount,1);assert.equal(entryStability(recovered).passes,true);
    assert.equal(automaticEntryCandidateReady(recovered),true);
    assertNoFinancialReadsOrOrders(f);
  }finally{await f.stop();}
});

test('a current zero carry cannot inherit a positive stored opportunity or its confirmation',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fundingEntryFixture();
  try{
    confirmEntryFunding(f,ms=>t.mock.timers.tick(ms));const latest=installIndependentAdapterCache(f);
    t.mock.timers.tick(1000);
    for(const quote of latest.values()){quote.fundingRate=0;quote.fundingObservedAt=Date.now();quote.observedAt=Date.now();quote.timestamp=Date.now();}
    const after=f.engine.currentOpportunities()[0];
    assert.equal(after.expectedFundingUsd,0);assert.equal(entryStability(after).status,'nonpositive');
    assert.equal(automaticEntryCandidateReady(after),false);
    t.mock.timers.tick(1000);latest.get('bybit')!.fundingRate=.005;
    for(const quote of latest.values()){quote.fundingObservedAt=Date.now();quote.observedAt=Date.now();quote.timestamp=Date.now();}
    const recovered=f.candidate()!;assert.equal(entryStability(recovered).sampleCount,1);assert.equal(entryStability(recovered).passes,true);
    assert.equal(automaticEntryCandidateReady(recovered),true);
    assertNoFinancialReadsOrOrders(f);
  }finally{await f.stop();}
});

test('a stale pushed book still blocks entry while its genuine funding observations remain confirmed',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fundingEntryFixture();
  try{
    confirmEntryFunding(f,ms=>t.mock.timers.tick(ms));const latest=installIndependentAdapterCache(f);
    latest.get('bybit')!.observedAt=Date.now()-2001;
    const after=f.candidate()!;
    assert.equal(entryStability(after).status,'confirmed');
    assert.equal(after.checks?.find(check=>check.label==='两腿报价新鲜且同时取得')?.pass,false);
    assert.equal(automaticEntryCandidateReady(after),false);
    assertNoFinancialReadsOrOrders(f);
  }finally{await f.stop();}
});

test('a valid positive reversed funding direction qualifies immediately but cannot bypass its adverse entry price',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fundingEntryFixture();
  try{
    confirmEntryFunding(f,ms=>t.mock.timers.tick(ms));const latest=installIndependentAdapterCache(f);
    t.mock.timers.tick(1000);latest.get('bybit')!.fundingRate=-.005;
    for(const quote of latest.values()){quote.fundingObservedAt=Date.now();quote.observedAt=Date.now();quote.timestamp=Date.now();}
    const reversed=f.engine.currentOpportunities()[0];
    assert.equal(reversed.longExchange,'bybit');assert.equal(reversed.shortExchange,'gate');
    assert.equal(entryStability(reversed).status,'confirmed');assert.equal(entryStability(reversed).sampleCount,1);
    assert.equal(entryStability(reversed).passes,true);
    assert.equal(entryStability(reversed).observedSpanMs,0);
    assert.equal(automaticEntryCandidateReady(reversed),false);
    assertNoFinancialReadsOrOrders(f);
  }finally{await f.stop();}
});

for(const change of ['same-time-rate-conflict','settlement-clock','settlement-interval'] as const)test(`the current adapter ${change} is validated without relying on an old confirmation window`,async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fundingEntryFixture();
  try{
    confirmEntryFunding(f,ms=>t.mock.timers.tick(ms));const latest=installIndependentAdapterCache(f);
    const bybit=latest.get('bybit')!;
    if(change==='same-time-rate-conflict')bybit.fundingRate=.0051;
    else if(change==='settlement-clock')bybit.nextFundingTime+=3_600_000;
    else bybit.intervalHours=2;
    const after=f.candidate()!;
    assert.equal(entryStability(after).passes,false);
    assert.equal(entryStability(after).observedSpanMs,0);
    assert.equal(automaticEntryCandidateReady(after),false);
    if(change==='same-time-rate-conflict')assert.equal(entryStability(after).status,'unavailable');
    t.mock.timers.tick(1);
    for(const quote of latest.values()){quote.fundingObservedAt=Date.now();quote.observedAt=Date.now();quote.timestamp=Date.now();}
    const fresh=f.candidate()!;
    assert.equal(entryStability(fresh).passes,change!=='settlement-clock');
    assert.equal(automaticEntryCandidateReady(fresh),change!=='settlement-clock');
    assertNoFinancialReadsOrOrders(f);
  }finally{await f.stop();}
});

test('a genuine new settlement cycle qualifies after one current pair rather than restarting three minutes',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fundingEntryFixture();
  try{
    confirmEntryFunding(f,ms=>t.mock.timers.tick(ms));const latest=installIndependentAdapterCache(f);
    t.mock.timers.tick(31*60_000);
    for(const quote of latest.values()){
      quote.nextFundingTime+=3_600_000;quote.fundingObservedAt=Date.now();quote.observedAt=Date.now();quote.timestamp=Date.now();
    }
    // Keep the fixture's unchanged memory accounts current after advancing the
    // settlement clock; account expiry remains a separate production guard.
    f.publish(false);
    const next=f.candidate()!;assert.equal(entryStability(next).passes,true);assert.equal(entryStability(next).sampleCount,1);
    assert.equal(entryStability(next).observedSpanMs,0);assert.equal(automaticEntryCandidateReady(next),true);
    assert.equal(next.fundingEntryStability?.evidence?.long.nextFundingTime,latest.get('gate')!.nextFundingTime);
    assertNoFinancialReadsOrOrders(f);
  }finally{await f.stop();}
});
