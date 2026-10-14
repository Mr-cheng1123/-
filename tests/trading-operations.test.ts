import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeTradingOperations,tradingOperationSample,type TradingOperation} from '../src/shared/trading-operations.js';

const now=20_000;
function operation(id='op-1',overrides:Partial<TradingOperation>={}):TradingOperation {
  return {version:1,id,positionId:'position-1',base:'BTC',mode:'live',origin:'automatic',kind:'profit-exit',protocol:'maker-ioc',
    state:'running',startedAt:1000,updatedAt:10_000,target:{long:10,short:10},confirmed:{long:0,short:0},remaining:{long:10,short:10},
    stages:{signalObservedAt:1000,preparationStartedAt:1100,preparationCompletedAt:1300,submittedAt:1500,acknowledgedAt:2000},
    attempts:{preflightNotSent:0,zeroFill:0,unknown:0,submitted:1},...overrides};
}
function complete(id='op-1',overrides:Partial<TradingOperation>={}):TradingOperation {
  return operation(id,{state:'complete',confirmed:{long:10,short:10},remaining:{long:0,short:0},endedAt:10_000,
    stages:{signalObservedAt:1000,preparationStartedAt:1100,preparationCompletedAt:1300,submittedAt:1500,acknowledgedAt:2000,
      firstFillObservedAt:3000,pairedAt:8000,accountConfirmedAt:9500},netPnlUsd:.2,...overrides});
}

test('full denominator retains running, partial, cancelled, failed and unresolved operations',()=>{
  const rows=[complete(),operation('run'),operation('partial',{state:'partial',confirmed:{long:2,short:0},remaining:{long:8,short:10}}),
    operation('unknown',{state:'unknown',attempts:{preflightNotSent:0,zeroFill:0,unknown:1,submitted:1}}),
    operation('cancel',{state:'cancelled',endedAt:9000}),operation('failure',{state:'failed',endedAt:9000})];
  const result=summarizeTradingOperations(rows,now);
  assert.equal(result.counts.total,6);assert.equal(result.counts.complete,1);assert.equal(result.completionRatePct,100/6);
  assert.equal(result.counts.unknown,1);assert.equal(result.timing.totalMs.knownCount,1);
  assert.equal(result.timing.totalMs.unknownCount,5);assert.equal(result.pendingAgeMs.knownCount,3);
  assert.equal(result.pendingAgeMs.max,19_000);
});

test('a claimed complete state needs target quantities, no unresolved requests and subsequent account evidence',()=>{
  const good=complete();
  const invalid=[complete('no-account',{stages:{...good.stages,accountConfirmedAt:undefined}}),
    complete('no-pair',{stages:{...good.stages,pairedAt:undefined}}),
    complete('early-account',{stages:{...good.stages,accountConfirmedAt:7000}}),
    complete('unknown-order',{attempts:{...good.attempts,unknown:1}}),
    complete('working-maker',{attempts:{...good.attempts,pending:1}}),
    complete('remaining',{remaining:{long:0,short:.01}}),complete('short-fill',{confirmed:{long:10,short:9}}),
    complete('unknown-target',{target:{long:10,short:null}}),complete('no-end',{endedAt:undefined})];
  const result=summarizeTradingOperations(invalid,now);
  assert.equal(result.counts.complete,0);assert.equal(result.counts.unknown,invalid.length);
  assert.equal(result.timing.totalMs.knownCount,0);assert.equal(result.amounts.knownCount,0);
  assert.ok(result.rows.every(row=>row.endedAt===undefined));
  assert.equal(invalid[0].state,'complete');
});

test('single-leg selected manual close can complete without inventing a second target',()=>{
  const result=summarizeTradingOperations([complete('single',{origin:'manual',kind:'manual-close',protocol:'ioc',
    target:{long:0,short:.1},confirmed:{long:0,short:.1},remaining:{long:0,short:0}})],now);
  assert.equal(result.counts.complete,1);assert.equal(result.counts.manual,1);
  assert.equal(result.interventionRatePct,null);
});

test('machine subtraction error can match a quantity but true off-grid residuals cannot be erased',()=>{
  const result=summarizeTradingOperations([complete('eps',{target:{long:.3,short:.3},confirmed:{long:.1+.2,short:.3}}),
    complete('real-residue',{remaining:{long:0,short:Number.EPSILON}}),
    complete('real-mismatch',{confirmed:{long:10,short:9.999999}})],now);
  assert.equal(result.counts.complete,1);assert.equal(result.counts.unknown,2);
});

test('tiny nonzero targets never become completed zero fills through an absolute epsilon floor',()=>{
  const result=summarizeTradingOperations([complete('tiny-zero',{target:{long:1e-18,short:1e-18},confirmed:{long:0,short:0}}),
    complete('tiny-half',{target:{long:1e-18,short:1e-18},confirmed:{long:5e-19,short:1e-18}}),
    complete('tiny-equal',{target:{long:1e-18,short:1e-18},confirmed:{long:1e-18,short:1e-18}})],now);
  assert.equal(result.counts.complete,1);assert.equal(result.counts.unknown,2);
});

test('an ended partial manual operation stays in the full denominator but does not accrue ongoing age',()=>{
  const partial=operation('ended-partial',{origin:'manual',kind:'manual-close',state:'partial',endedAt:9000});
  const result=summarizeTradingOperations([partial,operation('still-running')],now);
  assert.equal(result.counts.partial,1);assert.equal(result.counts.total,2);assert.equal(result.pendingAgeMs.knownCount,1);
});

test('zero-fill or no-send attempts do not manufacture an operation completion',()=>{
  const result=summarizeTradingOperations([operation('veto',{attempts:{preflightNotSent:4,zeroFill:0,unknown:0,submitted:0},stages:{}}),
    operation('zero',{attempts:{preflightNotSent:0,zeroFill:4,unknown:0,submitted:4}}),
    complete('zero-target',{target:{long:0,short:0},confirmed:{long:0,short:0}})],now);
  assert.equal(result.counts.total,3);assert.equal(result.counts.complete,0);
  assert.equal(result.rows[0].attempts.preflightNotSent,4);
  assert.equal(result.counts.running,2);assert.equal(result.counts.unknown,1);
});

test('expired observation windows leave unknown native requests unresolved',()=>{
  const result=summarizeTradingOperations([operation('old',{state:'unknown',windowEndsAt:1500,
    attempts:{preflightNotSent:0,zeroFill:0,unknown:1,submitted:1}})],now);
  assert.equal(result.rows[0].state,'unknown');assert.equal(result.pendingAgeMs.max,19_000);
  assert.equal(result.counts.failed,0);assert.equal(result.counts.complete,0);
});

test('nearest-rank latency percentiles retain missing samples and preserve caller input',()=>{
  const values=[...Array.from({length:20},(_,i)=>i+1),null,-2,NaN],before=[...values];
  const result=tradingOperationSample(values);
  assert.equal(result.p50,10);assert.equal(result.p95,19);assert.equal(result.max,20);assert.equal(result.mean,10.5);
  assert.equal(result.knownCount,20);assert.equal(result.unknownCount,3);assert.deepEqual(values,before);
});

test('stage clocks show separate latencies without summing concurrent stages or guessing missing clocks',()=>{
  const result=summarizeTradingOperations([complete(),operation('missing',{stages:{}})],now);
  assert.equal(result.timing.preparationMs.mean,200);assert.equal(result.timing.signalToSubmitMs.mean,500);
  assert.equal(result.timing.submitToAckMs.mean,500);assert.equal(result.timing.ackToFirstFillMs.mean,1000);
  assert.equal(result.timing.firstFillToPairedMs.mean,5000);assert.equal(result.timing.accountConfirmationMs.mean,1500);
  assert.equal(result.timing.totalMs.mean,9000);assert.equal(result.timing.submitToAckMs.unknownCount,1);
});

test('receipt before ACK and future clocks do not produce negative or invented latency',()=>{
  const result=summarizeTradingOperations([operation('before-ack',{stages:{submittedAt:1500,acknowledgedAt:3000,firstFillObservedAt:2500}}),
    operation('future-stage',{stages:{submittedAt:1500,acknowledgedAt:now+1}})],now);
  assert.equal(result.timing.ackToFirstFillMs.knownCount,0);assert.equal(result.timing.submitToAckMs.knownCount,1);
  assert.equal(result.timing.submitToAckMs.unknownCount,1);
});

test('automatic rescue requires explicit evidence and normal manual work is not a rescue',()=>{
  const proof={kind:'recovery' as const,evidenceId:'audit-1',requiredAt:5000};
  const result=summarizeTradingOperations([operation('auto-recovery',{intervention:proof}),operation('auto-normal'),
    operation('manual',{origin:'manual',kind:'manual-close',intervention:proof}),
    operation('no-proof',{intervention:{...proof,evidenceId:''}})],now);
  assert.equal(result.counts.automatic,3);assert.equal(result.counts.manual,1);assert.equal(result.counts.intervention,1);
  assert.equal(result.interventionRatePct,100/3);
});

test('duplicate operation identity cannot double count a completion or silently replace conflicting evidence',()=>{
  const first=complete();
  const repeated=summarizeTradingOperations([first,structuredClone(first)],now);
  assert.equal(repeated.counts.total,1);assert.equal(repeated.counts.complete,1);assert.equal(repeated.counts.duplicateIds,1);
  const conflicting=summarizeTradingOperations([first,complete(first.id,{confirmed:{long:9,short:10}})],now);
  assert.equal(conflicting.counts.total,1);assert.equal(conflicting.counts.complete,0);assert.equal(conflicting.counts.unknown,1);
  assert.equal(conflicting.rows[0].waitReason?.code,'duplicate-operation-evidence');
});

test('invalid records remain visible in denominator and evidence coverage rather than improving reported success',()=>{
  const rows=[complete(),operation('bad-clock',{startedAt:now+1,updatedAt:now+1}),
    operation('negative',{confirmed:{long:-1,short:0}}),operation('bad-attempt',{attempts:{preflightNotSent:0,zeroFill:.5,unknown:0,submitted:1}})];
  const result=summarizeTradingOperations(rows,now);
  assert.equal(result.counts.total,4);assert.equal(result.counts.invalid,3);assert.equal(result.counts.unknown,3);
  assert.equal(result.completionRatePct,25);assert.equal(result.rows.length,1);assert.equal(result.timing.totalMs.unknownCount,3);
});

test('invalid pending counts do not conceal an unconfirmed order',()=>{
  const result=summarizeTradingOperations([complete('pending-negative',{attempts:{preflightNotSent:0,zeroFill:0,unknown:0,submitted:1,pending:-1}})],now);
  assert.equal(result.counts.invalid,1);assert.equal(result.counts.unknown,1);assert.equal(result.counts.complete,0);
});

test('incomplete fills do not become zero exposure and amounts keep real losses and unknown coverage separate',()=>{
  const result=summarizeTradingOperations([complete('loss',{netPnlUsd:-.5,
    exposure:{complete:true,maxNotionalUsd:10,notionalTimeUsdMs:20_000,observedMs:2000}}),
    complete('unknown',{netPnlUsd:null,exposure:{complete:false,maxNotionalUsd:0,notionalTimeUsdMs:0,observedMs:0}})],now);
  assert.equal(result.exposure.maxNotionalUsd.knownCount,1);assert.equal(result.exposure.maxNotionalUsd.unknownCount,1);
  assert.equal(result.exposure.notionalTimeUsdMs.mean,20_000);assert.equal(result.amounts.netPnlUsd,null);
  assert.equal(result.amounts.knownNetPnlUsd,-.5);assert.equal(result.amounts.unknownCount,1);
});

test('empty input has no percentage or money sample and aggregation does not mutate frozen evidence',()=>{
  const empty=summarizeTradingOperations([],now);assert.equal(empty.completionRatePct,null);assert.equal(empty.interventionRatePct,null);
  assert.equal(empty.timing.totalMs.p95,null);assert.equal(empty.amounts.netPnlUsd,null);
  const row=complete(),before=structuredClone(row);Object.freeze(row.stages);Object.freeze(row);
  const result=summarizeTradingOperations([row],now);assert.deepEqual(row,before);
  result.rows[0].target.long=999;assert.equal(row.target.long,10);
});

test('exit protocol remains distinct from entry method and does not infer absent historical operations',()=>{
  const result=summarizeTradingOperations([operation('entry',{kind:'entry',protocol:'ioc'}),
    complete('close',{kind:'profit-exit',protocol:'maker-ioc'})],now);
  assert.equal(result.rows.find(row=>row.kind==='entry')?.protocol,'ioc');
  assert.equal(result.rows.find(row=>row.kind==='profit-exit')?.protocol,'maker-ioc');assert.equal(result.counts.total,2);
});
