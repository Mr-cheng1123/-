import assert from 'node:assert/strict';
import test from 'node:test';
import {setImmediate as immediate} from 'node:timers/promises';
import {BitgetUta} from '../src/adapters/bitget-uta.js';
import {cachedBitgetAccountMode,clearBitgetAccountCache,readVerifiedBitgetSettings} from '../src/adapters/bitget-account.js';
import {withExchangeRequestContext} from '../src/adapters/network.js';

// No signer, sockets, credentials or financial writes. The held native settings
// GET represents genuine outstanding work independently of cache invalidation.
function fixture(){
  const requests:Array<{resolve:(response:any)=>void;reject:(error:unknown)=>void}>=[];
  let active=0,maxActive=0;
  const native=async()=>{
    active++;maxActive=Math.max(maxActive,active);
    let resolve!:(response:any)=>void,reject!:(error:unknown)=>void;
    const promise=new Promise<any>((done,failed)=>{resolve=done;reject=failed;});requests.push({resolve,reject});
    try{return await promise;}finally{active--;}
  };
  const client:any={apiKey:'offline-key',secret:'offline-secret',password:'offline-pass',markets:{},
    privateUtaGetV3AccountSettings:native,
    privateUtaGetV3AccountFinancialRecords:async()=>{throw new Error('offline funding transport failed');}};
  const release=(index:number,accountMode:'unified'|'hybrid'='unified')=>requests[index].resolve({code:'00000',
    data:{accountMode,accountLevel:'basic',holdMode:'one_way_mode',deltaSwitch:'no'}});
  return {client,requests,native,release,active:()=>active,maxActive:()=>maxActive};
}

test('same valid epoch joins one original settings GET and returns separate result objects',async()=>{
  const f=fixture(),first=readVerifiedBitgetSettings(f.client),second=readVerifiedBitgetSettings(f.client,true);
  await immediate();assert.equal(f.requests.length,1);assert.equal(f.active(),1);
  f.release(0);const [a,b]=await Promise.all([first,second]);
  a.data.accountMode='hybrid';assert.equal(b.data.accountMode,'unified');
  assert.equal(cachedBitgetAccountMode(f.client),'unified');assert.equal(f.maxActive(),1);
});

test('an unrelated failed funding GET cannot release a still-active settings GET or grant its old result to a new reader',async()=>{
  const f=fixture(),first=readVerifiedBitgetSettings(f.client);await immediate();
  await assert.rejects(new BitgetUta(f.client).fetchFundingPayments(Date.now()-1000),/offline funding transport failed/);
  assert.equal(f.active(),1);const next=readVerifiedBitgetSettings(f.client);await immediate();
  assert.equal(f.requests.length,1,'failed invoices invalidate proof, not outstanding native work');
  f.release(0,'unified');assert.equal((await first).data.accountMode,'unified');await immediate();
  assert.equal(cachedBitgetAccountMode(f.client),undefined,'the old epoch cannot repopulate the route cache');
  assert.equal(f.requests.length,2);f.release(1,'hybrid');assert.equal((await next).data.accountMode,'hybrid');
  assert.equal(cachedBitgetAccountMode(f.client),'classic');assert.equal(f.maxActive(),1);
});

test('repeated invalidation with several waiting callers remains single flight and performs one new native read',async()=>{
  const f=fixture(),original=readVerifiedBitgetSettings(f.client);await immediate();
  const readers=[];
  for(let i=0;i<4;i++){clearBitgetAccountCache(f.client);readers.push(readVerifiedBitgetSettings(f.client));}
  await immediate();assert.equal(f.requests.length,1);assert.equal(f.active(),1);
  f.release(0);await original;await immediate();assert.equal(f.requests.length,2);
  assert.equal(cachedBitgetAccountMode(f.client),undefined);f.release(1,'hybrid');
  assert.deepEqual((await Promise.all(readers)).map(read=>read.data.accountMode),Array(4).fill('hybrid'));
  assert.equal(f.maxActive(),1);
});

for(const field of ['apiKey','secret','password','privateUtaGetV3AccountSettings','privateUtaGetV3AccountAssets','privateMixGetV2MixAccountAccount']){
  test(`changing ${field} preserves native ownership and requires a new identity proof after the old GET settles`,async()=>{
    const f=fixture(),first=readVerifiedBitgetSettings(f.client);await immediate();
    f.client[field]=field.startsWith('private')?async()=>f.native():`changed-offline-${field}`;
    const next=readVerifiedBitgetSettings(f.client);await immediate();assert.equal(f.requests.length,1);
    f.release(0,'unified');await first;await immediate();assert.equal(f.requests.length,2);
    assert.equal(cachedBitgetAccountMode(f.client),undefined);f.release(1,'hybrid');
    assert.equal((await next).data.accountMode,'hybrid');assert.equal(cachedBitgetAccountMode(f.client),'classic');
    assert.equal(f.maxActive(),1);
  });
}

test('an invalidated old native rejection is drained without an unhandled rejection and a new GET can recover',async()=>{
  const f=fixture(),original=readVerifiedBitgetSettings(f.client);
  const checked=assert.rejects(original,/offline original settings failed/);await immediate();
  clearBitgetAccountCache(f.client);const next=readVerifiedBitgetSettings(f.client),unhandled:unknown[]=[];
  const capture=(error:unknown)=>{unhandled.push(error);};process.on('unhandledRejection',capture);
  try{
    await immediate();assert.equal(f.requests.length,1);f.requests[0].reject(new Error('offline original settings failed'));
    await checked;await immediate();assert.equal(f.requests.length,2);assert.equal(f.active(),1);
    f.release(1,'hybrid');assert.equal((await next).data.accountMode,'hybrid');
    await immediate();assert.deepEqual(unhandled,[]);assert.equal(f.maxActive(),1);
  }finally{process.off('unhandledRejection',capture);}
});

test('a new reader deadline that expires while draining cannot dispatch another native GET after release',async t=>{
  const f=fixture();let now=2_000_000;t.mock.method(Date,'now',()=>now);
  const first=readVerifiedBitgetSettings(f.client);await immediate();clearBitgetAccountCache(f.client);
  const next=withExchangeRequestContext(f.client,{deadlineAt:now+25},()=>readVerifiedBitgetSettings(f.client));
  const rejected=assert.rejects(next,(error:any)=>error.code==='TIMEOUT');await immediate();assert.equal(f.requests.length,1);
  now+=25;f.release(0);await first;await rejected;assert.equal(f.requests.length,1);
  assert.equal(cachedBitgetAccountMode(f.client),undefined);
  const fresh=readVerifiedBitgetSettings(f.client);await immediate();f.release(1,'hybrid');
  assert.equal((await fresh).data.accountMode,'hybrid');assert.equal(f.maxActive(),1);
});

test('a new reader cancellation while draining cannot dispatch another settings GET after release',async()=>{
  const f=fixture(),first=readVerifiedBitgetSettings(f.client);await immediate();clearBitgetAccountCache(f.client);
  const controller=new AbortController();
  const next=withExchangeRequestContext(f.client,{signal:controller.signal},()=>readVerifiedBitgetSettings(f.client));
  const rejected=assert.rejects(next,(error:any)=>error.code==='TIMEOUT');await immediate();assert.equal(f.requests.length,1);
  controller.abort();f.release(0);await first;await rejected;assert.equal(f.requests.length,1);
  assert.equal(cachedBitgetAccountMode(f.client),undefined);assert.equal(f.maxActive(),1);
});

test('a second invalidation while the replacement GET is active drains that GET before obtaining a third fresh proof',async()=>{
  const f=fixture(),first=readVerifiedBitgetSettings(f.client);await immediate();clearBitgetAccountCache(f.client);
  const second=readVerifiedBitgetSettings(f.client);f.release(0);await first;await immediate();assert.equal(f.requests.length,2);
  clearBitgetAccountCache(f.client);const third=readVerifiedBitgetSettings(f.client);await immediate();assert.equal(f.requests.length,2);
  f.release(1,'unified');await second;await immediate();assert.equal(f.requests.length,3);
  assert.equal(cachedBitgetAccountMode(f.client),undefined);f.release(2,'hybrid');
  assert.equal((await third).data.accountMode,'hybrid');assert.equal(f.maxActive(),1);
});
