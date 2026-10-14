import test from 'node:test';
import assert from 'node:assert/strict';
import {AutomaticEntryAttempts} from '../src/core/automatic-entry-attempts.js';
test('websocket and polling triggers cannot claim the same base twice inside the retry interval',()=>{
  const attempts=new AutomaticEntryAttempts();
  assert.equal(attempts.claim('CT',1000),true);
  for(const now of [1000,1050,6000,15999])assert.equal(attempts.claim('CT',now),false);
  assert.equal(attempts.claim('CT',16000),true);
  assert.equal(attempts.claim('SAND',16000),true);
});
test('reading readiness neither reserves a manual entry nor changes another base',()=>{
  const attempts=new AutomaticEntryAttempts();
  assert.equal(attempts.ready('CT',1000),true);assert.equal(attempts.ready('CT',1000),true);
  assert.equal(attempts.claim('CT',1000),true);assert.equal(attempts.ready('ARK',1000),true);
  assert.equal(attempts.claim('CT',NaN),false);assert.equal(attempts.ready('CT',15999),false);
});
