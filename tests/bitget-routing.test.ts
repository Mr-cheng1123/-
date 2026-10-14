import test from 'node:test';
import assert from 'node:assert/strict';
import {bitgetAccount,bitgetAccountReadError} from '../src/adapters/bitget-account.js';
import {BitgetClassic} from '../src/adapters/bitget-classic.js';
import {BitgetUta} from '../src/adapters/bitget-uta.js';
import {ExchangeNetworkError} from '../src/adapters/network.js';

test('Bitget routes explicit unified to UTA and hybrid to Classic using settings reads alone',async()=>{
  for(const mode of ['unified','hybrid']){
    let reads=0;const client={privateUtaGetV3AccountSettings:async()=>{reads++;return{code:'00000',data:{accountMode:mode}};}};
    const selected=await bitgetAccount(client);assert.equal(reads,1);
    assert(mode==='unified'?selected instanceof BitgetUta:selected instanceof BitgetClassic);
  }
});

test('missing UTA permission or an unknown account mode never falls back to a misleading Classic zero',async()=>{
  let classicReads=0;const classic=async()=>{classicReads++;return {code:'00000',data:[]};};
  for(const mode of ['upgrading','switching','unknown',undefined])await assert.rejects(bitgetAccount({privateUtaGetV3AccountSettings:async()=>({code:'00000',data:{accountMode:mode}}),privateMixGetV2MixAccountAccounts:classic}));
  for(const failure of [()=>({code:'40014'}),()=>{throw new ExchangeNetworkError('API_ERROR',0,'40014');}]){
    await assert.rejects(bitgetAccount({privateUtaGetV3AccountSettings:async()=>failure(),privateMixGetV2MixAccountAccounts:classic}),(error:unknown)=>{
      assert.match(bitgetAccountReadError(error)??'',/40014.*UTA/);return true;
    });
  }
  assert.equal(classicReads,0);assert.equal(bitgetAccountReadError(new Error('private raw key=secret')),undefined);
});

test('known UTA execution incompatibility is distinguished from authentication without echoing private errors',()=>{
  assert.match(bitgetAccountReadError(new Error('bitget: UTA holding mode must be verified'))??'',/连接已通过.*尚未确认.*开平仓参数/);
  assert.match(bitgetAccountReadError(new Error('bitget: UTA negative or unverified asset equity is unsupported for execution'))??'',/负权益/);
  assert.equal(bitgetAccountReadError(new Error('bitget: UTA holding mode must be verified secret=private')),undefined);
  assert.equal(bitgetAccountReadError(new Error('toString')),undefined);
  assert.match(bitgetAccountReadError(new Error('bitget: UTA symbol margin/leverage configuration unavailable'))??'',/读取不完整.*是否已有设置/);
});
