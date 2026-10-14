import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {Execution,refreshPnl} from '../src/core/execution.js';
import {Store} from '../src/core/store.js';
import {defaultConfig} from '../src/shared/config.js';
import type {JournalOrder,OrderResult,Position} from '../src/shared/types.js';

function fixture(){
  const root=path.resolve(tmpdir()),dir=mkdtempSync(path.join(root,'confirmed-peer-fee-'));
  const config={...defaultConfig,mode:'live' as const,dataSource:'public' as const},store=new Store(path.join(dir,'state.json'),config),now=Date.now();
  const p:Position={id:'one-fee',base:'ONE',mode:'live',status:'attention',entryPolicy:'aligned',holdMode:'adaptive',
    profitExitNotionalUsd:81.9943586247,profitExitPolicy:{firstFundingTime:now-30_000,earliestExitAt:now-30_000,minSpreadNetUsd:0,minCombinedNetUsd:.0819943586247,fundingChecks:[]},
    closeRequestedAt:now-1000,closeProfitRequired:true,closePricing:'best-opposite',
    long:{exchange:'gate',symbol:'ONE/USDT:USDT',side:'long',quantity:39240,entryPrice:.00208,markPrice:.00206,feesUsd:.04,liquidationDistancePct:null},
    short:{exchange:'bitget',symbol:'ONE/USDT:USDT',side:'short',quantity:39240,entryPrice:.00209,markPrice:.00208,feesUsd:.072042245,liquidationDistancePct:null},
    openedAt:now-50_000,plannedExitAt:now+30_000,fundingUsd:.03063734895,feesUsd:.112042245,transferCostUsd:0,
    spreadPnlUsd:0,realizedSpreadPnlUsd:-.01314285002,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:['waiting']};
  const parent:JournalOrder={positionId:p.id,exchange:'gate',createdAt:now-20_000,
    request:{clientOrderId:'maker-one',base:'ONE',symbol:p.long.symbol,side:'sell',quantity:10,limitPrice:.002025,reduceOnly:true,postOnly:true},
    result:{id:'gate-native',clientOrderId:'maker-one',status:'filled',filledQuantity:10,averagePrice:.002025,averagePriceVerified:true,feeUsd:.00000405,timestamp:now-19_000},
    makerReduction:{activity:'terminal',makerLeg:'long',deadlineAt:now-10_000,bookedExecution:true,hedgeCompletedAt:now-15_000},
    executionEvidence:{version:1,method:'maker',role:'exit',batchId:'maker-one',bookedFeeUsd:.00000405}};
  const peer:JournalOrder={positionId:p.id,exchange:'bitget',createdAt:now-18_000,
    request:{clientOrderId:'peer-one',base:'ONE',symbol:p.short.symbol,side:'buy',quantity:10,limitPrice:.002083,reduceOnly:true},
    result:{id:'bitget-native',clientOrderId:'peer-one',status:'filled',filledQuantity:10,averagePrice:.002083,averagePriceVerified:true,feeUsd:.00001249,timestamp:now-17_000},
    executionEvidence:{version:1,method:'ioc',role:'exit',batchId:'peer-one',makerCloseParentClientId:'maker-one',bookedFeeUsd:.00001249}};
  store.data.positions.push(p);store.data.orders.push(parent,peer);refreshPnl(p);store.save();
  const current:OrderResult={...peer.result!,feeUsd:.000012498,orderReadAt:Date.now()};
  let unlocked=true;
  const execution=new Execution(store,{config:()=>config,liveUnlocked:()=>unlocked,snapshot:()=>undefined,
    adapter:()=>{throw new Error('A cash correction must never access an order submission adapter');},halt:()=>{}});
  const clean=()=>{const relative=path.relative(root,path.resolve(dir));assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));rmSync(dir,{recursive:true,force:true});};
  return {store,p,parent,peer,current,execution,config,clean,setUnlocked:(value:boolean)=>{unlocked=value;}};
}

test('complete exact native peer fee corrects cash once, preserves original receipt and never submits or changes quantities',()=>{
  const f=fixture();try{
    const original=structuredClone(f.peer.result!),before=structuredClone(f.p),parent=structuredClone(f.parent),delta=f.current.feeUsd-original.feeUsd;
    assert.equal(f.execution.reconcileConfirmedMakerPeerFee(f.peer,f.current,original.feeUsd),true);
    assert.equal(f.p.feesUsd,before.feesUsd+delta);assert.equal(f.p.short.feesUsd,before.short.feesUsd+delta);
    assert.equal(f.p.long.feesUsd,before.long.feesUsd);assert.equal(f.p.long.quantity,before.long.quantity);assert.equal(f.p.short.quantity,before.short.quantity);
    assert.equal(f.p.realizedSpreadPnlUsd,before.realizedSpreadPnlUsd);assert.equal(f.p.fundingUsd,before.fundingUsd);assert.equal(f.p.profitExitNotionalUsd,before.profitExitNotionalUsd);
    assert.equal(f.p.closeRequestedAt,before.closeRequestedAt);assert.equal(f.p.status,'attention');assert.deepEqual(f.parent,parent);
    assert.deepEqual(f.peer.result,{...original,feeUsd:f.current.feeUsd});assert.equal(f.peer.executionEvidence!.bookedFeeUsd,f.current.feeUsd);
    const audits=f.peer.confirmedPeerFeeCorrections!;assert.equal(audits.length,1);assert.equal(audits[0].feeDeltaUsd,delta);
    assert.deepEqual(audits[0].originalResult,original);assert.deepEqual(audits[0].nativeResult,f.current);
    const saved=JSON.parse(readFileSync(f.store.path,'utf8'));assert.deepEqual(saved.orders[1].confirmedPeerFeeCorrections,audits);
    assert.throws(()=>f.execution.reconcileConfirmedMakerPeerFee(f.peer,f.current,original.feeUsd));
    assert.equal(f.execution.reconcileConfirmedMakerPeerFee(f.peer,f.current,f.current.feeUsd),false);assert.equal(audits.length,1);
  }finally{f.clean();}
});

const refusals:Array<[string,(f:ReturnType<typeof fixture>)=>void]>=[
  ['wrong native ID',f=>{f.current.id='foreign';}],['wrong client ID',f=>{f.current.clientOrderId='foreign';}],
  ['changed quantity',f=>{f.current.filledQuantity=9;}],['changed average',f=>{f.current.averagePrice=.002082;}],
  ['unknown native receipt',f=>{f.current.status='unknown';}],['unverified native price',f=>{f.current.averagePriceVerified=false;}],
  ['missing fresh read',f=>{delete f.current.orderReadAt;}],['stale read',f=>{f.current.orderReadAt=Date.now()-f.config.maxSnapshotAgeMs-1000;}],
  ['future read',f=>{f.current.orderReadAt=Date.now()+10_000;}],['unknown fee',f=>{f.current.feeUsd=NaN;}],
  ['mismatched booked fee',f=>{f.peer.executionEvidence!.bookedFeeUsd=.0000124;}],['duplicate native receipt',f=>{f.store.data.orders.push({...structuredClone(f.peer),request:{...f.peer.request,clientOrderId:'duplicate'}});}],
  ['missing parent',f=>{f.peer.executionEvidence!.makerCloseParentClientId='foreign';}],['active parent',f=>{f.parent.makerReduction!.activity='active';}],
  ['unbooked parent',f=>{f.parent.makerReduction!.bookedExecution=false;}],['unknown parent cash',f=>{f.parent.result!.averagePriceVerified=false;}],
  ['wrong parent booked fee',f=>{f.parent.executionEvidence!.bookedFeeUsd=0;}],['peer predates parent',f=>{f.peer.createdAt=f.parent.createdAt-1;}],
  ['wrong peer direction',f=>{f.peer.request.side='sell';}],['unmatched position',f=>{f.p.short.quantity+=10;}],
  ['no conditional intent',f=>{delete f.p.closeRequestedAt;}],['manual close',f=>{f.p.manualCloseOnly=true;}],
  ['missing live permission',f=>{f.setUnlocked(false);}],['invalid local fees',f=>{f.p.short.feesUsd=NaN;}],
];
for(const [name,change] of refusals)test(`peer fee correction rejects ${name} without cash or journal mutation`,()=>{
  const f=fixture();try{change(f);const before=structuredClone({p:f.p,orders:f.store.data.orders});
    assert.throws(()=>f.execution.reconcileConfirmedMakerPeerFee(f.peer,f.current,.00001249));
    assert.deepEqual({p:f.p,orders:f.store.data.orders},before);
  }finally{f.clean();}
});

test('persistence failure leaves actual correction audited but cannot restore a manager',()=>{
  const f=fixture();try{
    f.store.save=()=>{throw new Error('disk unavailable');};
    assert.throws(()=>f.execution.reconcileConfirmedMakerPeerFee(f.peer,f.current,.00001249),/disk unavailable/);
    assert.equal(f.p.status,'attention');assert.equal(f.peer.result!.feeUsd,f.current.feeUsd);
    assert.equal(f.peer.confirmedPeerFeeCorrections!.length,1);assert.equal(f.p.long.quantity,39240);assert.equal(f.p.short.quantity,39240);
  }finally{f.clean();}
});
