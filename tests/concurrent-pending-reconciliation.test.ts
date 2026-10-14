import assert from 'node:assert/strict';
import test from 'node:test';
import {Execution,UncertainOrderError} from '../src/core/execution.js';
import type {Store} from '../src/core/store.js';
import {defaultConfig} from '../src/shared/config.js';
import type {AppConfig,ExchangeAdapter,JournalOrder,OrderResult,Position} from '../src/shared/types.js';

function deferred<T=void>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return {promise,resolve};}
function fixture(){
  let config:AppConfig={...structuredClone(defaultConfig),mode:'live',dataSource:'public',entryPolicy:'aligned',holdMode:'adaptive',profitExitExecutionMode:'ioc'};
  const p:Position={id:'read-original',base:'BTC',mode:'live',status:'closing',entryPolicy:'aligned',holdMode:'adaptive',
    openedAt:Date.now()-1000,plannedExitAt:Date.now()+600_000,closeRequestedAt:Date.now()-500,closePricing:'best-opposite',closeProfitRequired:true,
    long:{exchange:'gate',symbol:'BTC/USDT:USDT',side:'long',quantity:10,entryPrice:100,markPrice:110,feesUsd:.05,liquidationDistancePct:null},
    short:{exchange:'bybit',symbol:'BTC/USDT:USDT',side:'short',quantity:10,entryPrice:111,markPrice:110,feesUsd:.05,liquidationDistancePct:null},
    fundingUsd:0,feesUsd:.1,transferCostUsd:0,realizedSpreadPnlUsd:0,spreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[]};
  const journal:JournalOrder={positionId:p.id,exchange:'gate',createdAt:Date.now()-400,
    request:{clientOrderId:'original-unknown',base:p.base,symbol:p.long.symbol,side:'sell',quantity:2,limitPrice:110,reduceOnly:true},
    result:{id:'',clientOrderId:'original-unknown',status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now()-400},
    executionEvidence:{version:1,method:'ioc',role:'exit',batchId:'original-batch',bookedFeeUsd:0}};
  let saves=0,activity=0,writes=0,reads=0,inQueue=false,allowed=true;
  const store={data:{version:1,config,positions:[p],orders:[journal],logs:[],equity:[],fundingSeen:[],killSwitch:false},
    save(){saves++;},log(){}} as unknown as Store;
  let queue:Promise<unknown>=Promise.resolve();
  const serial=<T>(fn:()=>Promise<T>)=>{const task=queue.then(async()=>{inQueue=true;try{return await fn();}finally{inQueue=false;}});
    queue=task.then(()=>undefined,()=>undefined);return task;};
  const reply=(change:Partial<OrderResult>={}):OrderResult=>({id:'original-native',clientOrderId:journal.request.clientOrderId,status:'filled',
    filledQuantity:2,averagePrice:110,averagePriceVerified:true,feeUsd:.02,timestamp:Date.now(),...change});
  let read=async()=>reply();
  let adapter={id:'gate',inspectOrder:async()=>{assert.equal(inQueue,false,'private GET entered the cash queue');reads++;return read();},
    reconcileOrder:async()=>{writes++;throw new Error('Generic reconciliation can cancel and must not be used');},
    placeOrder:async()=>{writes++;throw new Error('Read-only reconciliation cannot submit');},
    cancelOrder:async()=>{writes++;}} as unknown as ExchangeAdapter;
  const execution=new Execution(store,{config:()=>config,adapter:()=>adapter,snapshot:()=>undefined,liveUnlocked:()=>true,
    serialize:serial,makerFinancialActivity:()=>activity++,halt:()=>{}});
  return {p,journal,store,execution,serial,reply,read:(fn:typeof read)=>read=fn,adapter:()=>adapter,
    replaceAdapter:()=>adapter={...adapter},replaceConfig:()=>config={...config},revoke:()=>allowed=false,
    run:()=>execution.reconcilePendingConcurrent(p.id,()=>allowed),saves:()=>saves,activity:()=>activity,writes:()=>writes,reads:()=>reads};
}

test('a deferred pending-order GET releases the cash queue and books its actual receipt exactly once',async()=>{
  const f=fixture(),entered=deferred(),release=deferred<OrderResult>();
  f.read(async()=>{entered.resolve();return release.promise;});const task=f.run();await entered.promise;
  assert.equal(await f.serial(async()=> 'queue-free'),'queue-free');assert.equal(f.p.long.quantity,10);
  release.resolve(f.reply());await task;
  assert.equal(f.p.long.quantity,8);assert.equal(f.p.realizedSpreadPnlUsd,20);assert.equal(f.p.feesUsd,.12000000000000001);
  assert.equal(f.journal.result!.status,'filled');assert.equal(f.activity(),1);assert.equal(f.writes(),0);
  await f.run();assert.equal(f.reads(),1);assert.equal(f.p.long.quantity,8);assert.equal(f.activity(),1);
});

test('another contract cash event cannot reject an unchanged selected native receipt',async()=>{
  const f=fixture(),entered=deferred(),release=deferred<OrderResult>();f.read(async()=>{entered.resolve();return release.promise;});
  const other=structuredClone(f.p);other.id='another-position';other.base='ETH';other.long.symbol=other.short.symbol='ETH/USDT:USDT';
  f.store.data.positions.push(other);const task=f.run();await entered.promise;
  await f.serial(async()=>{other.feesUsd+=2;other.long.quantity-=1;});release.resolve(f.reply());await task;
  assert.equal(f.p.long.quantity,8);assert.equal(other.long.quantity,9);assert.equal(f.activity(),1);
});

for(const [name,change] of [
  ['own quantity',(f:ReturnType<typeof fixture>)=>{f.p.long.quantity=9;}],
  ['own actual fee',(f:ReturnType<typeof fixture>)=>{f.p.feesUsd=.2;}],
  ['own funding cash',(f:ReturnType<typeof fixture>)=>{f.p.fundingUsd=.5;}],
  ['position identity',(f:ReturnType<typeof fixture>)=>{f.store.data.positions[0]=structuredClone(f.p);} ],
  ['leg identity',(f:ReturnType<typeof fixture>)=>{f.p.long={...f.p.long};}],
  ['journal identity',(f:ReturnType<typeof fixture>)=>{f.store.data.orders[0]=structuredClone(f.journal);}],
  ['request mutation',(f:ReturnType<typeof fixture>)=>{f.journal.request.quantity=1;}],
  ['config identity',(f:ReturnType<typeof fixture>)=>f.replaceConfig()],
  ['adapter identity',(f:ReturnType<typeof fixture>)=>f.replaceAdapter()],
  ['manager permission',(f:ReturnType<typeof fixture>)=>f.revoke()],
] as const)test(`a changed ${name} retains native observation separately and never guesses its cash`,async()=>{
  const f=fixture(),entered=deferred(),release=deferred<OrderResult>();f.read(async()=>{entered.resolve();return release.promise;});
  const result=f.reply(),task=f.run();await entered.promise;await f.serial(async()=>change(f));
  const before=structuredClone({p:f.p,result:f.store.data.orders[0].result});release.resolve(result);
  await assert.rejects(task,UncertainOrderError);assert.deepEqual({p:f.p,result:f.store.data.orders[0].result},before);
  assert.equal(f.activity(),0);assert.equal(f.writes(),0);
  const evidence=f.store.data.orders[0].reconciliationEvidence?.at(-1);
  assert.equal(evidence?.reason,'scope-changed');assert.equal(evidence?.request.quantity,2);assert.equal(evidence?.result.filledQuantity,2);
});

test('a cancelled zero native receipt does not invent a fill or fee and still invalidates old account proofs',async()=>{
  const f=fixture();f.read(async()=>f.reply({status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0}));await f.run();
  assert.equal(f.p.long.quantity,10);assert.equal(f.p.feesUsd,.1);assert.equal(f.p.realizedSpreadPnlUsd,0);
  assert.equal(f.journal.result!.status,'cancelled');assert.equal(f.activity(),1);assert.equal(f.writes(),0);
});

test('unknown original GET observations preserve trusted original cash and never resend',async()=>{
  const f=fixture(),before=structuredClone(f.p);f.read(async()=>f.reply({status:'unknown',filledQuantity:1,averagePrice:110,feeUsd:.03,
    confirmation:{stage:'order-read',reason:'not-found'},orderReadAt:Date.now()}));
  await assert.rejects(f.run(),UncertainOrderError);assert.deepEqual(f.p,before);assert.equal(f.journal.result!.status,'unknown');
  assert.equal(f.journal.result!.filledQuantity,0);assert.equal(f.journal.result!.feeUsd,0);assert.equal(f.activity(),0);assert.equal(f.writes(),0);
});

test('a missing native GET interface does not fall back to possibly cancelling generic reconciliation',async()=>{
  const f=fixture();delete f.adapter().inspectOrder;await assert.rejects(f.run(),UncertainOrderError);
  assert.equal(f.reads(),0);assert.equal(f.writes(),0);assert.equal(f.journal.result!.status,'unknown');
});

test('a financial save failure is surfaced instead of softened as a private GET retry',async()=>{
  const f=fixture(),failure=Object.assign(new Error('MEMORY actual ledger save failed'),{syscall:'write',code:'EIO'});
  f.store.save=()=>{throw failure;};await assert.rejects(f.run(),error=>error===failure);
  assert.equal(f.writes(),0);assert.equal(f.journal.result!.status,'filled');assert.equal(f.p.long.quantity,8);
  assert.equal(f.store.data.killSwitch,true);
});

for(const syscall of ['connect','getaddrinfo'])test(`a private GET ${syscall} syscall is a local wait and cannot masquerade as a ledger write failure`,async()=>{
  const f=fixture();f.read(async()=>{throw Object.assign(new Error('MEMORY private payload must stay hidden'),{syscall,code:'ETIMEDOUT'});});
  await assert.rejects(f.run(),error=>error instanceof UncertainOrderError&&!(error as NodeJS.ErrnoException).syscall&&
    !error.message.includes('private payload'));
  assert.equal(f.p.long.quantity,10);assert.equal(f.p.feesUsd,.1);assert.equal(f.store.data.killSwitch,false);assert.equal(f.writes(),0);
});

test('a real cash persistence failure without an OS syscall still halts trading at the actual write boundary',async()=>{
  const f=fixture(),failure=new Error('MEMORY durable write failed');f.store.save=()=>{throw failure;};
  await assert.rejects(f.run(),error=>error===failure);assert.equal(f.store.data.killSwitch,true);
  assert.equal(f.journal.result!.status,'filled');assert.equal(f.p.long.quantity,8);assert.equal(f.writes(),0);
});

test('failure to save an unknown query diagnostic retains original cash and stops further trading',async()=>{
  const f=fixture();f.read(async()=>f.reply({status:'unknown',confirmation:{stage:'order-read',reason:'not-found'},orderReadAt:Date.now()}));
  const failure=new Error('MEMORY diagnostic persistence failure');f.store.save=()=>{throw failure;};
  await assert.rejects(f.run(),error=>error===failure);assert.equal(f.store.data.killSwitch,true);
  assert.equal(f.p.long.quantity,10);assert.equal(f.p.feesUsd,.1);assert.equal(f.journal.result!.status,'unknown');assert.equal(f.writes(),0);
});

test('removed or duplicated original journals are never restored or selected as an interchangeable cash owner',async()=>{
  for(const mode of ['removed','duplicate']){
    const f=fixture(),entered=deferred(),release=deferred<OrderResult>();f.read(async()=>{entered.resolve();return release.promise;});
    const task=f.run();await entered.promise;
    if(mode==='removed')f.store.data.orders=[];else f.store.data.orders.push(structuredClone(f.journal));
    release.resolve(f.reply());await assert.rejects(task,UncertainOrderError);
    assert.equal(f.p.long.quantity,10);assert.equal(f.p.feesUsd,.1);assert.equal(f.store.data.orders.length,mode==='removed'?0:2);
    assert.equal(f.journal.result!.status,'unknown');assert.equal(f.writes(),0);assert.equal(f.activity(),0);
  }
});

test('an eight-second read deadline retains one native GET and books no late cash',async t=>{
  t.mock.timers.enable({apis:['setTimeout'],now:Date.now()});
  const f=fixture(),entered=deferred(),release=deferred<OrderResult>();f.read(async()=>{entered.resolve();return release.promise;});
  const task=f.run();await entered.promise;t.mock.timers.tick(8000);await assert.rejects(task,UncertainOrderError);
  await assert.rejects(f.run(),UncertainOrderError);assert.equal(f.reads(),1);assert.equal(f.p.long.quantity,10);
  release.resolve(f.reply());await new Promise<void>(done=>setImmediate(done));await f.serial(async()=>{});
  assert.equal(f.p.long.quantity,10);assert.equal(f.journal.result!.status,'unknown');assert.equal(f.activity(),0);
  assert.equal(f.journal.reconciliationEvidence?.at(-1)?.reason,'late-read');assert.equal(f.writes(),0);
});
