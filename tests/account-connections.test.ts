import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import dotenv from 'dotenv';
import { AccountConnections,saveLocalCredentials } from '../src/core/account-connections.js';
import { defaultConfig } from './legacy-config.js';
import type { AccountState,AccountOverview } from '../src/shared/types.js';

function fixture(){const dir=mkdtempSync(join(tmpdir(),'funding-account-'));return {path:join(dir,'.env'),env:{} as Record<string,string|undefined>,cleanup:()=>{
  const target=resolve(dir);assert.equal(dirname(target),resolve(tmpdir()));assert(basename(target).startsWith('funding-account-'));rmSync(target,{recursive:true,force:true});
}};}
const credentials={apiKey:'test-key',apiSecret:'test-secret',passphrase:'test-passphrase'};

test('UTA overview preserves its separate balance units and scope after expiry or permission failure',async()=>{
  const f=fixture(),originalNow=Date.now;let fail=false;
  try{
    const overview:AccountOverview={freeUsd:90,equityUsd:400,positionCount:0,balanceScope:'unified_usdt',accountType:'unified',accountMode:'basic',positionMode:'one_way_mode',executionSupported:true,usdtAvailableUsd:300,marginAvailableUsd:90};
    const connections=new AccountConnections(f.path,()=>defaultConfig,{env:f.env,createClient:()=>({fetchAccount:async()=>{
      if(fail)throw Object.assign(new Error('private key must never appear'),{apiCode:'40014'});return overview;
    },close:async()=>{}})});
    connections.save('bitget',credentials);
    const checked=await connections.check('bitget');assert.equal(checked.freeUsd,90);assert.equal(checked.usdtAvailableUsd,300);assert.equal(checked.marginAvailableUsd,90);assert.equal(checked.equityUsd,400);
    Date.now=()=>originalNow()+61000;
    const expired=connections.list().find(x=>x.exchange==='bitget')!;assert.equal(expired.balanceScope,'unified_usdt');assert.equal(expired.accountType,'unified');assert.equal(expired.freeUsd,undefined);assert.equal(expired.usdtAvailableUsd,undefined);
    Date.now=originalNow;fail=true;const failed=await connections.check('bitget');assert.equal(failed.status,'error');assert.match(failed.message!,/40014.*UTA/);assert.doesNotMatch(failed.message!,/private key/);
    assert.equal(failed.balanceScope,'unified_usdt');assert.equal(failed.freeUsd,undefined);assert.equal(failed.usdtAvailableUsd,undefined);
  }finally{Date.now=originalNow;f.cleanup();}
});
test('local key storage preserves execution locks and unrelated settings; responses never reveal key values',()=>{
  const f=fixture();try{
    writeFileSync(f.path,'# preserve\nALLOW_LIVE_TRADING=false\nEXCHANGE_PROXY_URL=http://127.0.0.1:17893\nBITGET_API_KEY=old\nBITGET_API_KEY=duplicate\n');
    const connections=new AccountConnections(f.path,()=>defaultConfig,{env:f.env});
    const saved=connections.save('bitget',credentials),text=readFileSync(f.path,'utf8'),parsed=dotenv.parse(text);
    assert.equal(parsed.BITGET_API_KEY,credentials.apiKey);assert.equal(parsed.BITGET_PASSPHRASE,credentials.passphrase);
    assert.equal(parsed.ALLOW_LIVE_TRADING,'false');assert.equal(parsed.EXCHANGE_PROXY_URL,'http://127.0.0.1:17893');
    assert.equal(text.split('BITGET_API_KEY=').length-1,1);assert.equal(saved.status,'unchecked');
    const response=JSON.stringify(connections.list());for(const value of Object.values(credentials))assert(!response.includes(value));
  }finally{f.cleanup();}
});
test('credential input cannot inject dotenv settings; passphrase required for OKX and Bitget',()=>{
  const f=fixture();try{
    writeFileSync(f.path,'ALLOW_LIVE_TRADING=false\n');
    assert.throws(()=>saveLocalCredentials(f.path,'binance',{apiKey:'x\nALLOW_LIVE_TRADING=true',apiSecret:'x'},f.env));
    for(const id of ['okx','bitget'] as const)assert.throws(()=>saveLocalCredentials(f.path,id,{apiKey:'x',apiSecret:'y'},f.env),/Passphrase/);
    assert.throws(()=>saveLocalCredentials(f.path,'binance',{...credentials,ALLOW_LIVE_TRADING:'true'},f.env));
    assert.equal(readFileSync(f.path,'utf8'),'ALLOW_LIVE_TRADING=false\n');assert.deepEqual(f.env,{});
  }finally{f.cleanup();}
});
test('quoted credential values round-trip exactly without exposing other dotenv variables',()=>{
  const f=fixture();try{
    const secret='value#with"quotes-and\\slash';
    saveLocalCredentials(f.path,'okx',{apiKey:'k',apiSecret:secret,passphrase:'pass with spaces # x'},f.env);
    const parsed=dotenv.parse(readFileSync(f.path));assert.equal(parsed.OKX_API_SECRET,secret);assert.equal(parsed.OKX_PASSPHRASE,'pass with spaces # x');
  }finally{f.cleanup();}
});
test('account checks use only account reads; unconfigured venues make no client calls',async()=>{
  const f=fixture();try{
    let reads=0,closed=0;
    const connections=new AccountConnections(f.path,()=>defaultConfig,{env:f.env,createClient:()=>({
      fetchAccount:async()=>{reads++;return {freeUsd:0,equityUsd:20,positions:[]};},close:async()=>{closed++;},
    })});
    assert.equal((await connections.check('binance')).status,'not_configured');assert.equal(reads,0);
    connections.save('binance',credentials);const result=await connections.check('binance');
    assert.equal(result.status,'connected');assert.equal(result.freeUsd,0);assert.equal(result.positionCount,0);assert.equal(reads,1);assert.equal(closed,1);
    assert(!JSON.stringify(result).includes('test-secret'));
  }finally{f.cleanup();}
});
test('timeout is bounded, late reads cannot revive a failed check, and concurrent checks share one read',async()=>{
  const f=fixture();try{
    let finish!:(value:AccountState)=>void,reads=0;
    const raw=new Promise<AccountState>(resolve=>{finish=resolve;});
    const connections=new AccountConnections(f.path,()=>defaultConfig,{env:f.env,timeoutMs:15,createClient:()=>({
      fetchAccount:async()=>{reads++;return raw;},close:async()=>{},
    })});
    connections.save('gate',credentials);const first=connections.check('gate'),second=connections.check('gate');assert.equal(first,second);
    assert.equal((await first).status,'error');assert.equal(reads,1);
    assert.equal((await connections.check('gate')).status,'error');assert.equal(reads,1);
    assert.throws(()=>connections.assertCanSave('gate'),/检查/);assert.doesNotThrow(()=>connections.assertCanSave('bybit'));
    assert.throws(()=>connections.save('gate',credentials),/检查/);
    finish({freeUsd:12,equityUsd:12,positions:[]});await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(connections.list().find(x=>x.exchange==='gate')?.status,'error');
    assert.doesNotThrow(()=>connections.assertCanSave('gate'));
  }finally{f.cleanup();}
});
test('private API exception payloads are never returned and stale balances are removed on failure',async()=>{
  const f=fixture();try{
    let fails=false;
    const connections=new AccountConnections(f.path,()=>defaultConfig,{env:f.env,createClient:()=>({fetchAccount:async()=>{
      if(fails)throw new Error('https://private.example?secret=test-secret account=private');
      return {freeUsd:8,equityUsd:8,positions:[]};},close:async()=>{},
    })});
    connections.save('bybit',credentials);assert.equal((await connections.check('bybit')).freeUsd,8);
    fails=true;const result=await connections.check('bybit');assert.equal(result.status,'error');assert.equal(result.freeUsd,undefined);
    assert(!JSON.stringify(result).includes('private'));assert(!JSON.stringify(result).includes('test-secret'));
  }finally{f.cleanup();}
});
test('successful account reads expire after sixty seconds and no longer expose cached balances',async t=>{
  const f=fixture();let now=100000;
  t.mock.method(Date,'now',()=>now);
  try{
    const connections=new AccountConnections(f.path,()=>defaultConfig,{env:f.env,createClient:()=>({
      fetchAccount:async()=>({freeUsd:8,equityUsd:9,positions:[]}),close:async()=>{},
    })});
    connections.save('okx',credentials);await connections.check('okx');
    assert.equal(connections.list().find(x=>x.exchange==='okx')?.freeUsd,8);
    now+=60001;
    const expired=connections.list().find(x=>x.exchange==='okx');
    assert.equal(expired?.status,'unchecked');assert.equal(expired?.freeUsd,undefined);assert.equal(expired?.positionCount,undefined);
  }finally{f.cleanup();}
});
test('read-only Bitget overview preserves distinct balance scopes without turning spot funds into futures margin',async t=>{
  const f=fixture();let now=100000;t.mock.method(Date,'now',()=>now);
  try{
    const connections=new AccountConnections(f.path,()=>defaultConfig,{env:f.env,createClient:()=>({
      fetchAccount:async()=>({freeUsd:0,equityUsd:0,positionCount:0,balanceScope:'usdt_futures' as const,isolatedAvailableUsd:0,spotAvailableUsd:300.04,spotStatus:'available' as const}),close:async()=>{},
    })});
    connections.save('bitget',credentials);const state=await connections.check('bitget');
    assert.equal(state.freeUsd,0);assert.equal(state.isolatedAvailableUsd,0);assert.equal(state.spotAvailableUsd,300.04);assert.equal(state.balanceScope,'usdt_futures');
    now+=60001;const expired=connections.list().find(x=>x.exchange==='bitget');
    assert.equal(expired?.spotAvailableUsd,undefined);assert.equal(expired?.isolatedAvailableUsd,undefined);
  }finally{f.cleanup();}
});
test('an unavailable spot read preserves the confirmed futures balance and does not invent a zero spot balance',async()=>{
  const f=fixture();try{
    const connections=new AccountConnections(f.path,()=>defaultConfig,{env:f.env,createClient:()=>({
      fetchAccount:async()=>({freeUsd:100,equityUsd:120,positionCount:2,balanceScope:'usdt_futures' as const,isolatedAvailableUsd:90,spotStatus:'unavailable' as const,warnings:['现货余额暂不可用']}),close:async()=>{},
    })});
    connections.save('bitget',credentials);const state=await connections.check('bitget');
    assert.equal(state.status,'connected');assert.equal(state.freeUsd,100);assert.equal(state.spotAvailableUsd,undefined);assert.equal(state.spotStatus,'unavailable');assert.deepEqual(state.warnings,['现货余额暂不可用']);
  }finally{f.cleanup();}
});
