import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../src/core/engine.js';
import {ExchangeNetworkError} from '../src/adapters/network.js';
import {AccountReadPending} from '../src/core/account-read-diagnostic.js';

function fixture(){
 const logs:string[]=[],health:any={exchange:'gate',status:'degraded',errorCode:'RATE_LIMITED',route:'proxy',accountStatus:'ready',balanceUsd:100};
 const engine:any={accounts:new Map([['gate',{freeUsd:100}]]),health:[health],store:{data:{killSwitch:false},log(_level:string,message:string){logs.push(message);}},
  autoEnabled:true,persistenceFailures:new Set(),execution:{isObservationPersistenceFailure:()=>false}};
 Object.setPrototypeOf(engine,Engine.prototype);return {engine,health,logs};
}

test('account health records its own private error and deduplicates identical causes while retaining changed causes',()=>{
 const {engine,health,logs}=fixture();
 engine.accountReadFailed('gate',new ExchangeNetworkError('TIMEOUT'));
 assert.equal(engine.accounts.has('gate'),false);assert.equal(health.balanceUsd,undefined);
 assert.match(health.accountError,/TIMEOUT/);assert(!health.accountError.includes('RATE_LIMITED'));
 engine.accountReadFailed('gate',new ExchangeNetworkError('TIMEOUT'));assert.equal(logs.length,1);
 engine.accountReadFailed('gate',new ExchangeNetworkError('ACCESS_DENIED',0,'IP_FORBIDDEN','gate'));
 assert.equal(logs.length,2);assert.match(logs[1],/ACCESS_DENIED \/ IP_FORBIDDEN/);
 assert.equal(engine.autoEnabled,true);assert.equal(engine.store.data.killSwitch,false);
});

test('failure to persist the account diagnostic uses the existing real-write halt boundary',()=>{
 const {engine,health}=fixture(),failure=new Error('ordinary error from actual diagnostic save');
 engine.store.log=()=>{throw failure;};
 assert.throws(()=>engine.accountReadFailed('gate',new ExchangeNetworkError('TIMEOUT')),error=>error===failure);
 assert.equal(health.accountStatus,'error');assert.equal(engine.autoEnabled,false);assert.equal(engine.store.data.killSwitch,true);
 assert(engine.persistenceFailures.has(failure));
});

test('local account waiting remains unavailable for entry and does not become a native API failure',()=>{
 const {engine,health,logs}=fixture();
 engine.accountReadFailed('gate',new AccountReadPending('gate'));
 assert.equal(engine.accounts.has('gate'),false);assert.equal(health.balanceUsd,undefined);
 assert.equal(health.accountStatus,'error');assert.match(health.accountError,/READ_IN_PROGRESS/);
 assert(!health.accountError.includes('API_ERROR'));assert.equal(health.errorCode,'RATE_LIMITED');
 engine.accountReadFailed('gate',new AccountReadPending('gate'));assert.equal(logs.length,1);
 engine.accountReadFailed('gate',new ExchangeNetworkError('TIMEOUT'));
 assert.equal(logs.length,2);assert.match(logs[1],/TIMEOUT/);
 assert.equal(engine.accounts.has('gate'),false);assert.equal(engine.autoEnabled,true);assert.equal(engine.store.data.killSwitch,false);
});

test('account polling keeps the original pending read and discards its late result with a waiting diagnostic',async()=>{
 const {engine,health,logs}=fixture();
 engine.privateReadRequests=new Map();engine.accountReadAt=new WeakMap();engine.options={privateReadDeadlineMs:10};
 engine.store.data.config={maxSnapshotAgeMs:30000};
 let release!:(account:unknown)=>void,calls=0;
 const adapter={id:'gate',fetchAccount(){calls++;return new Promise(resolve=>{release=resolve;});}};
 const timeout=await engine.readTradingAccount(adapter).then(()=>undefined,(error:unknown)=>error);
 assert(timeout instanceof ExchangeNetworkError);assert.equal(timeout.code,'TIMEOUT');engine.accountReadFailed('gate',timeout);
 const pending=engine.privateReadRequests.get(adapter).get('account');
 const wait=await engine.readTradingAccount(adapter).then(()=>undefined,(error:unknown)=>error);
 assert(wait instanceof AccountReadPending);engine.accountReadFailed('gate',wait);
 assert.equal(calls,1);assert.equal(engine.privateReadRequests.get(adapter).get('account'),pending);
 assert.match(health.accountError,/READ_IN_PROGRESS/);assert.equal(engine.accounts.has('gate'),false);
 assert.equal(logs.length,2);
 release({freeUsd:200,equityUsd:200,positions:[]});await pending;await new Promise<void>(resolve=>setImmediate(resolve));
 assert.equal(engine.privateReadRequests.get(adapter).has('account'),false);
 assert.equal(engine.accounts.has('gate'),false,'a late raw result is not new account evidence');
 assert.equal(health.accountStatus,'error');assert.equal(engine.autoEnabled,true);assert.equal(engine.store.data.killSwitch,false);
});
