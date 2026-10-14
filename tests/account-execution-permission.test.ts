import test from 'node:test';
import assert from 'node:assert/strict';
import {accountExecutionPermission} from '../web/src/account-execution-permission.js';
import type {ExchangeId,LiveExchangeReadiness} from '../src/shared/types.js';

const venue=(exchange:ExchangeId,changes:Partial<LiveExchangeReadiness>={}):LiveExchangeReadiness=>({exchange,supported:true,credentialsConfigured:true,executionAuthorized:false,...changes});

test('all five venue cards expose their explicit current session permission separately from configured credentials',()=>{
  for(const exchange of ['binance','bybit','okx','gate','bitget'] as ExchangeId[]){
    assert.deepEqual(accountExecutionPermission(venue(exchange),true),{label:'待提交前授权',authorized:false});
    assert.deepEqual(accountExecutionPermission(venue(exchange,{executionAuthorized:true}),true),{label:'会话已授权',authorized:true});
    assert.deepEqual(accountExecutionPermission(venue(exchange,{credentialsConfigured:false,executionAuthorized:true}),true),{label:'未配置',authorized:false});
    assert.deepEqual(accountExecutionPermission(venue(exchange,{supported:false,executionAuthorized:true}),true),{label:'未启用',authorized:false});
  }
});

test('missing or old payload permissions never claim that credentials, a global unlock or an old check authorized a venue',()=>{
  assert.deepEqual(accountExecutionPermission(undefined,false),{label:'授权待同步',authorized:false});
  assert.deepEqual(accountExecutionPermission(undefined,true),{label:'未启用',authorized:false});
  assert.deepEqual(accountExecutionPermission(venue('gate',{executionAuthorized:undefined}),true),{label:'授权待同步',authorized:false});
});

test('the next server state immediately reflects revocation without retaining an earlier displayed grant',()=>{
  const account=venue('gate',{executionAuthorized:true});
  assert.equal(accountExecutionPermission(account,true).label,'会话已授权');
  account.executionAuthorized=false;
  assert.equal(accountExecutionPermission(account,true).label,'待提交前授权');
});
