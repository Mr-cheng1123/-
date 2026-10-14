import test from 'node:test';
import assert from 'node:assert/strict';
import {automaticEntryAssessment,automaticEntryCandidateReady} from '../src/shared/automatic-entry-policy.js';
import {fundingEntryFixture,entryStability,confirmEntryFunding} from './funding-entry-stability-fixture.js';

test('the first valid positive funding pair is automatic-ready without advancing time or issuing observation fee requests',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fundingEntryFixture();
  try{
    const candidate=f.candidate()!;assert.equal(candidate.eligible,true);assert.equal(automaticEntryAssessment(candidate).passes,true);
    assert.equal(entryStability(candidate).passes,true);assert.equal(automaticEntryCandidateReady(candidate),true);
    assert.equal(entryStability(candidate).sampleCount,1);assert.equal(entryStability(candidate).observedSpanMs,0);
    assert.equal(f.counters.accounts,0);assert.equal(f.counters.fees,0);assert.equal(f.counters.inspections,0);assert.equal(f.counters.preparations,0);
    assert.equal(f.sent.length,0);assert.equal(f.store.data.orders.length,0);assert.equal(f.store.data.positions.length,0);
  }finally{await f.stop();}
});

test('first-pair automatic entry reaches both native fills immediately and still verifies actual account fees',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fundingEntryFixture();
  try{
    const initialTime=Date.now(),candidate=confirmEntryFunding(f,ms=>t.mock.timers.tick(ms));assert.equal(automaticEntryCandidateReady(candidate),true);
    assert.equal(Date.now(),initialTime,'qualifying current funding must not advance a confirmation timer');
    assert.equal(f.counters.fees,0);assert.equal(f.counters.accounts,0);assert.equal(f.counters.preparations,0);assert.equal(f.sent.length,0);
    f.engine.autoEnabled=true;const p=await f.internal.openInternal(candidate.id,true);
    assert.equal(p.status,'open');assert.equal(p.automaticEntry,true);assert.equal(p.long.quantity,p.short.quantity);
    assert.equal(f.sent.length,2);assert.ok(f.counters.fees>=2);assert.ok(f.counters.submissionGuards>=1);
    assert.equal(Date.now(),initialTime);assert.equal(p.executionEvidence?.fundingEntryStability?.version,2);
    assert.equal(p.executionEvidence?.fundingEntryStability?.sampleCount,1);
  }finally{await f.stop();}
});

test('fast book updates cannot renew current funding evidence and an expired pair immediately loses permission',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fundingEntryFixture();
  try{
    const first=entryStability(f.candidate());
    for(let i=0;i<20;i++){t.mock.timers.tick(500);f.publish(false);f.candidate();}
    const repeated=entryStability(f.candidate());assert.equal(repeated.sampleCount,first.sampleCount);assert.equal(repeated.observedSpanMs,0);
    assert.equal(repeated.passes,true);assert.equal(f.counters.fees,0);assert.equal(f.sent.length,0);
    assert.equal(f.candidate()!.fundingEntryStability?.evidence?.lastObservedAt,2_000_000_000_000);
    t.mock.timers.tick(20_001);f.publish(false);
    const expired=f.candidate()!;assert.equal(entryStability(expired).passes,false);assert.equal(automaticEntryCandidateReady(expired),false);
    f.engine.autoEnabled=true;await assert.rejects(f.internal.openInternal(expired.id,true),/资金费|读数|过期/);
    assert.equal(f.counters.fees,0);assert.equal(f.counters.accounts,0);assert.equal(f.sent.length,0);
  }finally{await f.stop();}
});

test('a new current positive funding direction recovers immediately after adverse funding without a new waiting window',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fundingEntryFixture();
  try{
    confirmEntryFunding(f,ms=>t.mock.timers.tick(ms));
    t.mock.timers.tick(15_000);f.quotes.get('bybit')!.fundingRate=-.005;f.publish();const reversed=f.engine.currentOpportunities()[0];
    assert.equal(reversed.longExchange,'bybit');assert.equal(reversed.shortExchange,'gate');
    assert.equal(automaticEntryCandidateReady(reversed),false,'funding permission cannot bypass the unchanged price advantage condition');
    t.mock.timers.tick(15_000);f.quotes.get('bybit')!.fundingRate=.005;f.publish();
    const restored=f.candidate()!,result=entryStability(restored);
    assert.equal(result.passes,true);assert.equal(automaticEntryCandidateReady(restored),true);assert.equal(result.observedSpanMs,0);
    assert.equal(f.sent.length,0);assert.equal(f.counters.fees,0);
  }finally{await f.stop();}
});

test('an invalid future settlement clock still blocks entry while a genuine current interval change needs no waiting',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});
  for(const change of ['clock','interval'] as const){const f=fundingEntryFixture();try{
    confirmEntryFunding(f,ms=>t.mock.timers.tick(ms));t.mock.timers.tick(15_000);
    for(const quote of f.quotes.values()){if(change==='clock')quote.nextFundingTime+=3_600_000;else quote.intervalHours=2;}
    f.publish();const changed=f.candidate()!;assert.equal(entryStability(changed).passes,change==='interval',change);
    assert.equal(entryStability(changed).observedSpanMs,0,change);assert.equal(automaticEntryCandidateReady(changed),change==='interval',change);
    assert.equal(f.counters.fees,0);assert.equal(f.sent.length,0);
  }finally{await f.stop();}}
});

test('manual opening remains independent of the automatic original-funding observation guard',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fundingEntryFixture();
  try{
    // Existing REST manual execution can rely on its freshly observed combined
    // response; the automatic funding guard still requires original funding time.
    for(const quote of f.quotes.values()){quote.fundingObservedAt=undefined;quote.bookTransport='rest';}
    f.publish(false);const candidate=f.candidate()!;assert.equal(entryStability(candidate).passes,false);
    const p=await f.internal.openInternal(candidate.id,false);assert.equal(p.status,'open');assert.equal(p.automaticEntry,false);
    assert.equal(f.sent.length,2);assert.equal(p.long.quantity,p.short.quantity);
  }finally{await f.stop();}
});

test('engine polling can submit a new automatic entry from its first positive funding pair after existing native guards',async t=>{
  t.mock.timers.enable({apis:['Date'],now:2_000_000_000_000});const f=fundingEntryFixture();
  try{
    f.engine.autoEnabled=true;await f.engine.tick();f.engine.autoEnabled=false;
    assert.equal(f.sent.length,2);assert.equal(f.store.data.orders.length,2);assert.ok(f.counters.fees>=2);
    const position=f.store.data.positions[0];assert.equal(position.status,'open');assert.equal(position.long.quantity,position.short.quantity);
    assert.equal(position.executionEvidence?.fundingEntryStability?.version,2);
    assert.equal(position.executionEvidence?.fundingEntryStability?.observedSpanMs,0);
  }finally{await f.stop();}
});
