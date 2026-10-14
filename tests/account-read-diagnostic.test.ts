import test from 'node:test';
import assert from 'node:assert/strict';
import {AccountReadPending,accountReadDiagnostic} from '../src/core/account-read-diagnostic.js';
import {ExchangeNetworkError} from '../src/adapters/network.js';

test('private account failures expose fixed classifications and only venue-validated API identifiers',()=>{
  assert.equal(accountReadDiagnostic('gate',new ExchangeNetworkError('TIMEOUT')),'账户只读请求超时（TIMEOUT）');
  assert.equal(accountReadDiagnostic('gate',new ExchangeNetworkError('ACCESS_DENIED',0,'IP_FORBIDDEN','gate')),
    '账户只读访问被拒绝（ACCESS_DENIED / IP_FORBIDDEN）');
  const raw=new Error('gate {"label":"INVALID_KEY","message":"SECRET_HEADER_BEARER"}');
  const reason=accountReadDiagnostic('gate',raw);
  assert.match(reason,/API_ERROR \/ INVALID_KEY/);assert(!reason.includes('SECRET_HEADER_BEARER'));
  assert(!accountReadDiagnostic('bybit',raw).includes('INVALID_KEY'));
});

test('a malformed native error and throwing diagnostics cannot expose arbitrary values',()=>{
  const malformed=new ExchangeNetworkError('TIMEOUT');Object.defineProperty(malformed,'code',{value:'PRIVATE_CREDENTIAL_VALUE'});
  assert.equal(accountReadDiagnostic('gate',malformed),'账户只读读取失败，原始原因未确认');
  const error=new Error();Object.defineProperty(error,'message',{get(){throw new Error('PRIVATE_DIAGNOSTIC_VALUE');}});
  assert.equal(accountReadDiagnostic('gate',error),'账户只读读取失败，原始原因未确认');
});

test('a typed local account wait has its own category without turning native failures into waiting',()=>{
  const pending=new AccountReadPending('gate');
  assert.match(pending.message,/上次只读请求尚未结束/);
  assert.equal(accountReadDiagnostic('gate',pending),'账户上次只读请求仍在途，等待原读取结束（READ_IN_PROGRESS）');
  assert.equal(accountReadDiagnostic('bybit',pending),'账户只读读取失败，原始原因未确认');
  assert.match(accountReadDiagnostic('gate',new Error(pending.message)),/API_ERROR/,'matching text alone is not local waiting proof');
  assert.equal(accountReadDiagnostic('gate',new ExchangeNetworkError('TIMEOUT')),'账户只读请求超时（TIMEOUT）');
  assert.match(accountReadDiagnostic('gate',new Error('gate {"label":"INVALID_KEY"}')),/API_ERROR \/ INVALID_KEY/);
});

test('a local wait diagnostic never reads arbitrary native messages or malformed exchange getters',()=>{
  const pending=new AccountReadPending('gate');
  Object.defineProperty(pending,'message',{get(){throw new Error('PRIVATE_WAIT_MESSAGE');}});
  assert.equal(accountReadDiagnostic('gate',pending),'账户上次只读请求仍在途，等待原读取结束（READ_IN_PROGRESS）');
  Object.defineProperty(pending,'exchange',{get(){throw new Error('PRIVATE_WAIT_EXCHANGE');}});
  assert.equal(accountReadDiagnostic('gate',pending),'账户只读读取失败，原始原因未确认');
});
