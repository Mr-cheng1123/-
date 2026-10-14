import assert from 'node:assert/strict';
import test from 'node:test';
import {manualEntryOpportunityBase,pendingManualEntryBases,type ManualEntryOperation,type ManualEntryState} from '../src/shared/manual-entry.js';

function operation(state:ManualEntryState,opportunityId='FOO-BAR-bybit-gate'):ManualEntryOperation {
  return {id:`operation-${state}`,opportunityId,state,createdAt:1,updatedAt:2,expiresAt:3,leaseExpiresAt:4,
    message:'offline fixture',cancelable:true,ordersSubmitted:false};
}

test('manual opportunity parsing preserves the full hyphenated base and validates both exchange suffixes',()=>{
  assert.equal(manualEntryOpportunityBase('FOO-BAR-bybit-gate'),'FOO-BAR');
  assert.equal(manualEntryOpportunityBase('FOO-BAR-gate-bybit'),'FOO-BAR');
  assert.equal(manualEntryOpportunityBase('bybit-token-bybit-bitget'),'BYBIT-TOKEN');
  assert.equal(manualEntryOpportunityBase('BTC-okx-binance'),'BTC');
  for(const id of ['FOO-BAR','BTC-gate','BTC-unknown-gate','BTC-bybit-unknown','-bybit-gate','   -bybit-gate'])assert.equal(manualEntryOpportunityBase(id),undefined,id);
});

test('all unpersisted pending states occupy only the exact coin even after their deadlines',()=>{
  const operations=(['queued','checking','preparing','submitting','reconciling'] as const).map(state=>operation(state));
  const before=structuredClone(operations),bases=pendingManualEntryBases(operations);
  assert.deepEqual([...bases],['FOO-BAR']);
  assert.equal(bases.has('FOO'),false);
  assert.deepEqual(operations,before,'occupancy must not expire, mutate or persist operations');
});

test('terminal manual states release occupancy and a recorded result base is authoritative',()=>{
  const terminal=(['completed','failed','cancelled','expired'] as const).map(state=>operation(state,'CLOSED-bybit-gate'));
  const recorded={...operation('reconciling','WRONG-bybit-gate'),result:{base:' exact-base ',positionStatus:'attention',longQuantity:1,shortQuantity:0}};
  assert.deepEqual([...pendingManualEntryBases([...terminal,recorded,operation('queued','BAD-ID')])],['EXACT-BASE']);
});
