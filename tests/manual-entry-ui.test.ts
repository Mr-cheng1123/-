import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppState } from '../src/shared/types.js';
import type { ManualEntryExecutionSummary,ManualEntryOperation } from '../src/shared/manual-entry.js';
import { applyManualEntryReceipt, createManualEntryRequest, manualEntryBlocksBase, manualEntryStage,
  isManualEntryReceipt,missingManualEntryExpired, restoreManualEntries } from '../web/src/manual-entry.js';
import {manualEntryOutcome} from '../web/src/manual-entry-outcome.js';

const request = () => createManualEntryRequest('CT-gate-bitget', 1_000_000, 'ct-request-0001');
function receipt(patch: Partial<ManualEntryOperation> = {}): ManualEntryOperation {
  const entry = request();
  return { id: entry.id, opportunityId: entry.opportunityId, createdAt: entry.requestedAt, updatedAt: entry.requestedAt + 1,
    expiresAt: entry.expiresAt, leaseExpiresAt: entry.requestedAt + 12_000, state: 'checking', message: '检查中',
    ordersSubmitted: false, cancelable: true, ...patch };
}

test('a manual click freezes one opportunity, operation ID and absolute deadline', () => {
  const entry = request();
  assert.equal(entry.expiresAt - entry.requestedAt, 30_000);
  assert.equal(entry.base, 'CT'); assert.equal(manualEntryBlocksBase(entry), true);
  assert.equal(manualEntryStage(entry), '正在接收开仓请求');
  for (const value of ['CT-bitget', 'ct-gate-bitget', 'CT-gate-secret', 'CT<script>-gate-bitget']) {
    assert.throws(() => createManualEntryRequest(value, 1_000_000, 'ct-request-0001'));
  }
});

test('late or mismatched receipt cannot regress a committed or final operation', () => {
  const entry = applyManualEntryReceipt(request(), receipt({ state: 'reconciling', updatedAt: 1_000_020, ordersSubmitted: true, cancelable: false }));
  assert.equal(applyManualEntryReceipt(entry, receipt({ updatedAt: 1_000_019 })), entry);
  assert.equal(applyManualEntryReceipt(entry, receipt({ updatedAt: 1_000_025 })), entry);
  assert.throws(() => applyManualEntryReceipt(entry, receipt({ opportunityId: 'CT-gate-bybit' })));
  const complete = applyManualEntryReceipt(entry, receipt({ state: 'completed', updatedAt: 1_000_030, ordersSubmitted: true,
    result: { positionStatus: 'closed', base: 'CT', longQuantity: 0, shortQuantity: 0 } }));
  assert.equal(applyManualEntryReceipt(complete, receipt({ state: 'reconciling', updatedAt: 1_000_040, ordersSubmitted: true })), complete);
  assert.equal(manualEntryStage(complete), '未形成对冲，当前记录已关闭');
  assert.equal(manualEntryBlocksBase(complete), false);
});

const executionSummary=():ManualEntryExecutionSummary=>({
  long:{exchange:'gate',openedQuantity:160,reducedQuantity:160,openingAttempts:1},
  short:{exchange:'bitget',openedQuantity:0,reducedQuantity:0,openingAttempts:3},
  openingFeesUsd:.05984256,rollbackFeesUsd:.05964,realizedPricePnlUsd:-.3376,netPnlUsd:-.45708256,accountingStatus:'confirmed',
  events:[{exchange:'gate',phase:'opening',side:'buy',status:'filled',requestedQuantity:160,filledQuantity:160,
    limitPrice:.624,averagePrice:.62336,feeUsd:.05984256,timestamp:1000010},
    {exchange:'bitget',phase:'opening',side:'sell',status:'cancelled',requestedQuantity:160,filledQuantity:0,
      limitPrice:.6255,feeUsd:0,timestamp:1000020,rejectionCode:'EC_NoImmediateQtyToFill',rejectionReason:'IOC 限价内无可立即成交数量，已取消'},
    {exchange:'gate',phase:'reducing',side:'sell',status:'filled',requestedQuantity:160,filledQuantity:160,
      averagePrice:.62125,feeUsd:.05964,timestamp:1000030}],
});

test('closed zero current quantities retain confirmed historical fills, rollback cost and exact native cancellation cause',()=>{
  const summary=executionSummary(),entry=applyManualEntryReceipt(request(),receipt({state:'failed',ordersSubmitted:true,cancelable:false,
    positionId:'position-ct',result:{positionStatus:'closed',base:'CT',longQuantity:0,shortQuantity:0,executionSummary:summary}}));
  assert.equal(manualEntryStage(entry),'未配成双腿，已撤回成交数量');
  const outcome=manualEntryOutcome(entry);assert.deepEqual(outcome.summary,summary);assert.equal(outcome.ledger,undefined);
  assert.equal(outcome.summary!.long.openedQuantity,160);assert.equal(outcome.summary!.short.openedQuantity,0);
  assert.equal(outcome.summary!.events[1].rejectionCode,'EC_NoImmediateQtyToFill');
  assert.equal(outcome.summary!.netPnlUsd,-.45708256);assert.equal(manualEntryBlocksBase(entry),false);
  assert.deepEqual(restoreManualEntries(JSON.stringify([entry]))[0].operation!.result!.executionSummary,summary);
});

test('partial and missing execution evidence never invents historical fills, zero costs or final profit',()=>{
  const partial=executionSummary();partial.accountingStatus='partial';delete partial.rollbackFeesUsd;delete partial.realizedPricePnlUsd;delete partial.netPnlUsd;
  partial.events[2]={exchange:'gate',phase:'reducing',side:'sell',status:'unknown',requestedQuantity:160,timestamp:1000030};
  const entry=applyManualEntryReceipt(request(),receipt({state:'failed',ordersSubmitted:true,cancelable:false,
    result:{positionStatus:'attention',base:'CT',longQuantity:160,shortQuantity:0,executionSummary:partial}}));
  assert.equal(manualEntryOutcome(entry).summary!.rollbackFeesUsd,undefined);assert.equal(manualEntryOutcome(entry).summary!.netPnlUsd,undefined);
  assert.equal(manualEntryBlocksBase(entry),true);
  const old=applyManualEntryReceipt(request(),receipt({state:'failed',ordersSubmitted:true,cancelable:false,positionId:'position-ct',
    result:{positionStatus:'closed',base:'CT',longQuantity:0,shortQuantity:0}}));
  assert.deepEqual(manualEntryOutcome(old),{});
  const state={positions:[{id:'position-ct',base:'CT',status:'closed',feesUsd:.12,realizedSpreadPnlUsd:-.3376,netPnlUsd:-.4576}]} as AppState;
  const legacy=manualEntryOutcome(old,state);assert.equal(legacy.summary,undefined);assert.deepEqual(legacy.ledger,{feesUsd:.12,realizedPricePnlUsd:-.3376,netPnlUsd:-.4576});
  state.positions[0].id='other-position';assert.deepEqual(manualEntryOutcome(old,state),{});
});

test('an invalid execution summary cannot replace the original receipt or clear an unknown-order guard',()=>{
  const make=(summary:ManualEntryExecutionSummary)=>receipt({state:'failed',ordersSubmitted:true,
    result:{positionStatus:'closed',base:'CT',longQuantity:0,shortQuantity:0,executionSummary:summary}});
  for(const patch of [
    (s:ManualEntryExecutionSummary)=>{s.long.exchange='bybit';},
    (s:ManualEntryExecutionSummary)=>{s.events[0].exchange='bybit';},
    (s:ManualEntryExecutionSummary)=>{s.events[0].feeUsd=NaN;},
    (s:ManualEntryExecutionSummary)=>{s.openingFeesUsd=Infinity;},
    (s:ManualEntryExecutionSummary)=>{s.netPnlUsd=Infinity;},
  ]){const summary=executionSummary();patch(summary);assert.equal(isManualEntryReceipt(make(summary),request()),false);}
  assert.equal(isManualEntryReceipt(make(executionSummary()),request()),true);
  const rebate=executionSummary();rebate.events[0].feeUsd=-.01;rebate.openingFeesUsd=-.01;
  assert.equal(isManualEntryReceipt(make(rebate),request()),true,'A native exchange rebate is a signed cash flow.');
});

test('confirmed zero-fill attempts distinguish a cancelled entry from a paid rollback',()=>{
  const summary=executionSummary();summary.long.openedQuantity=0;summary.long.reducedQuantity=0;summary.short.openingAttempts=1;
  summary.openingFeesUsd=0;summary.rollbackFeesUsd=0;summary.realizedPricePnlUsd=0;summary.netPnlUsd=0;
  summary.events=summary.events.filter(event=>event.exchange==='bitget');
  const entry=applyManualEntryReceipt(request(),receipt({state:'failed',ordersSubmitted:true,cancelable:false,
    result:{positionStatus:'closed',base:'CT',longQuantity:0,shortQuantity:0,executionSummary:summary}}));
  assert.equal(manualEntryStage(entry),'双腿未成交，当前无仓位');assert.equal(manualEntryOutcome(entry).summary!.openingFeesUsd,0);
});

test('submitted terminal failure retains the coin guard until independent reconciliation confirms a result', () => {
  const entry = applyManualEntryReceipt(request(), receipt({ state: 'failed', ordersSubmitted: true, positionId: 'position-ct', cancelable: false,
    result: { positionStatus: 'attention', base: 'CT', longQuantity: 190, shortQuantity: 0 } }));
  assert.equal(manualEntryBlocksBase(entry), true);
  const state = { positions: [{ id: 'position-ct', status: 'closed' }], unconfirmedOrders: [{ positionId: 'position-ct', historical: false }] } as AppState;
  assert.equal(manualEntryBlocksBase(entry, state), true, 'Closed local quantity does not override an unknown live order.');
  state.unconfirmedOrders = [];
  assert.equal(manualEntryBlocksBase(entry, state), false);
});

test('an open receipt cannot release an explicitly unknown order', () => {
  const entry = applyManualEntryReceipt(request(), receipt({ state: 'completed', ordersSubmitted: true, positionId: 'position-ct',
    result: { positionStatus: 'open', base: 'CT', longQuantity: 190, shortQuantity: 190 } }));
  const state = { positions: [], unconfirmedOrders: [{ positionId: 'position-ct', historical: false }] } as unknown as AppState;
  assert.equal(manualEntryBlocksBase(entry, state), true);
  assert.equal(manualEntryBlocksBase(entry), false);
});

test('only confirmed absence beyond the absolute deadline releases an unreceived request', () => {
  const entry = request();
  assert.equal(missingManualEntryExpired(entry, entry.expiresAt + 4_999), entry);
  const expired = missingManualEntryExpired(entry, entry.expiresAt + 5_000);
  assert.equal(expired.operation?.state, 'expired'); assert.equal(expired.operation?.ordersSubmitted, false);
  assert.equal(manualEntryBlocksBase(expired), false);
  const known = applyManualEntryReceipt(entry, receipt({ state: 'submitting', ordersSubmitted: true }));
  assert.equal(missingManualEntryExpired(known, entry.expiresAt + 999_999), known);
});

test('page reload restores the same operation without treating interrupted requests as rejected', () => {
  const entry = request();
  const restored = restoreManualEntries(JSON.stringify([entry]));
  assert.equal(restored[0].id, entry.id); assert.equal(restored[0].sync, 'uncertain');
  assert.equal(manualEntryBlocksBase(restored[0]), true);
  assert.match(restored[0].syncMessage!, /不会重新提交/);
  assert.deepEqual(restoreManualEntries('invalid json'), []);
  assert.deepEqual(restoreManualEntries(JSON.stringify([{ ...entry, expiresAt: entry.expiresAt + 1 }])), []);
  assert.equal(restoreManualEntries(JSON.stringify([entry, entry])).length, 1);
  assert.deepEqual(restoreManualEntries(JSON.stringify([{ ...entry, operation: receipt({ result: { positionStatus: 'open', base: 'WRONG', longQuantity: 1, shortQuantity: 1 } }) }])), []);
});
