import test from 'node:test';
import assert from 'node:assert/strict';
import {assertCurrentIocCloseRestorationEligible,buildCurrentIocCloseRestorationAudit,type CurrentIocNativeOrderProof} from '../src/core/current-ioc-close-restoration.js';
import type {JournalOrder,Position} from '../src/shared/types.js';
import type {ManualCloseOperation} from '../src/shared/manual-close.js';

function fixture(){
  const now=20_000,p:Position={id:'original-ioc',base:'AGPU',mode:'live',status:'attention',openedAt:1000,plannedExitAt:100_000,
    entryPolicy:'aligned',automaticEntry:true,holdMode:'adaptive',feeOnly:true,executionEvidence:{version:1,method:'ioc',entryPath:'single-cycle'},
    closeRequestedAt:8000,closeAttemptedAt:10000,closeReason:'Original conditional 10 bps profit exit',closeProfitRequired:true,
    closePricing:'best-opposite',closePauseReason:'Original account proof wait',profitExitNotionalUsd:107.1,
    long:{exchange:'bitget',symbol:'AGPU/USDT:USDT',side:'long',quantity:10,entryPrice:10,markPrice:10.5,feesUsd:.102,realizedPnlUsd:.1,liquidationDistancePct:null},
    short:{exchange:'gate',symbol:'AGPU/USDT:USDT',side:'short',quantity:10,entryPrice:11,markPrice:10.9,feesUsd:.103,realizedPnlUsd:.02,liquidationDistancePct:null},
    feesUsd:.205,fundingUsd:.02,transferCostUsd:0,spreadPnlUsd:0,realizedSpreadPnlUsd:.12,netPnlUsd:0,deltaUsd:0,
    fundingEvents:['original-invoice'],riskReasons:['Restart requires exact account reconciliation']};
  const make=(index:number,leg:Position['long'],reduceOnly:boolean):JournalOrder=>{
    const clientOrderId=`original-client-${index}`,quantity=reduceOnly?.2:10.2,feeUsd=reduceOnly?(leg.side==='long'?.002:.003):.1,
      price=reduceOnly?(leg.side==='long'?10.5:10.9):leg.entryPrice;
    return {positionId:p.id,exchange:leg.exchange,createdAt:reduceOnly?9000:1100+index*100,
      request:{clientOrderId,base:p.base,symbol:leg.symbol,side:reduceOnly?(leg.side==='long'?'sell':'buy'):(leg.side==='long'?'buy':'sell'),
        quantity,limitPrice:price,reduceOnly},
      result:{id:`native-original-${index}`,clientOrderId,status:'filled',filledQuantity:quantity,averagePrice:price,
        averagePriceVerified:true,feeUsd,timestamp:reduceOnly?9100:1200+index*100},
      executionEvidence:{version:1,method:'ioc',role:reduceOnly?(leg.side==='long'?'exit':'exit-tail'):(leg.side==='long'?'hedge':'entry'),
        batchId:reduceOnly?`${p.id}:ioc-close:original-pair`:`${p.id}:opening`,bookedFeeUsd:feeUsd}};
  };
  const orders=[make(0,p.long,false),make(1,p.short,false),make(2,p.long,true),make(3,p.short,true)];
  const noSubmit=structuredClone(orders[2]);noSubmit.createdAt=8500;noSubmit.request.clientOrderId='original-local-nosubmit';
  noSubmit.result={id:'',clientOrderId:noSubmit.request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:8600,
    rejectionCode:'IOC_REDUCTION_PERMISSION_CHANGED'};noSubmit.executionEvidence!.bookedFeeUsd=0;orders.push(noSubmit);
  const positions=[p],operations:ManualCloseOperation[]=[],check=()=>assertCurrentIocCloseRestorationEligible(p,positions,orders,operations,now),
    proofs:CurrentIocNativeOrderProof[]=orders.filter(order=>order!==noSubmit).map(order=>({exchange:order.exchange,
      clientOrderId:order.request.clientOrderId,nativeOrderId:order.result!.id,observedAt:19_000}));
  return {p,positions,orders,operations,now,proofs,noSubmit,check};
}

test('complete terminal IOC and trusted local no-submit close cash is eligible without changing the old intent',()=>{
  const f=fixture(),before=JSON.stringify(f);assert.equal(f.check().length,5);assert.equal(JSON.stringify(f),before);
  assert.equal(f.p.closeRequestedAt,8000);assert.equal(f.p.profitExitNotionalUsd,107.1);
});
test('IOC restoration audit freezes original intent, protocol, native identities and booked cash as detached history',()=>{
  const f=fixture();f.check();const before=JSON.stringify(f),audit=buildCurrentIocCloseRestorationAudit(f.p,f.orders,f.proofs,f.now);
  assert.equal(JSON.stringify(f),before);assert.equal(audit.acknowledgement,'RECONCILE_CURRENT_STRATEGY_POSITIONS');
  assert.deepEqual(audit.previousCloseIntent,{requestedAt:8000,attemptedAt:10000,reason:f.p.closeReason,pricing:'best-opposite',profitRequired:true,pauseReason:f.p.closePauseReason});
  assert.equal(audit.profitExitNotionalUsd,107.1);assert.equal(audit.originalOrders.length,5);
  assert.equal(audit.originalOrders.at(-1)!.localNoSubmit,true);assert.equal(audit.originalOrders[0].nativeObservedAt,19000);
  audit.previousCloseIntent.reason='detached';audit.originalOrders[0].feeUsd=999;audit.legs[0].quantity=0;audit.previousRiskReasons.push('detached');
  assert.equal(JSON.stringify(f),before);
});

const refusals:Array<[string,(f:ReturnType<typeof fixture>)=>void]>=[
  ['already running closing state',f=>{f.p.status='closing';}],['open active-manager state',f=>{f.p.status='open';}],
  ['opening state',f=>{f.p.status='opening';}],['closed record',f=>{f.p.status='closed';}],
  ['manual management protection',f=>{f.p.manualCloseOnly=true;}],['manual account import',f=>{f.p.manualCloseAccountRecord=true;}],
  ['flat account archive',f=>{f.p.accountClosure={confirmedAt:15000,reason:'flat',historicalOrdersPending:false};}],
  ['manual source identity',f=>{f.p.manualCloseSourcePositionId='original';}],
  ['manual operation identity',f=>{f.p.manualCloseOperationId='manual-operation';}],
  ['manual entry source',f=>{f.p.executionEvidence!.entryPath='manual';}],['legacy source guess',f=>{f.p.executionEvidence!.entryPath='legacy';}],
  ['missing automatic origin',f=>{delete f.p.automaticEntry;}],['nonaligned old policy',f=>{f.p.entryPolicy='funding';}],
  ['nonadaptive old strategy',f=>{f.p.holdMode='once';}],['missing IOC position protocol',f=>{delete f.p.executionEvidence;}],
  ['Maker position protocol',f=>{f.p.executionEvidence!.method='maker-ioc';}],
  ['missing close intent',f=>{delete f.p.closeRequestedAt;}],['missing original close attempt',f=>{delete f.p.closeAttemptedAt;}],
  ['nonconditional manual close guard',f=>{f.p.closeProfitRequired=false;}],['different close pricing',f=>{f.p.closePricing='depth';}],
  ['changed frozen original principal',f=>{f.p.profitExitNotionalUsd=100;}],
  ['missing original fixed principal',f=>{delete f.p.profitExitNotionalUsd;}],
  ['changed remaining matched quantity',f=>{f.p.short.quantity=9;}],['forged cumulative cash fees',f=>{f.p.feesUsd=0;}],
  ['forged realized cash',f=>{f.p.realizedSpreadPnlUsd=0;}],['forged per-leg realized cash',f=>{f.p.long.realizedPnlUsd=0;}],
  ['forged original opening average',f=>{f.p.long.entryPrice=10.1;}],
  ['missing original opening receipt',f=>{f.orders.splice(0,1);}],
  ['unknown close receipt',f=>{f.orders[2].result!.status='unknown';}],
  ['no actual close order',f=>{f.orders.splice(2);} ],
  ['unverified native execution price',f=>{f.orders[2].result!.averagePriceVerified=false;}],
  ['missing real fee evidence',f=>{f.orders[2].result!.feeUsd=NaN;}],
  ['mismatched booked fee evidence',f=>{f.orders[2].executionEvidence!.bookedFeeUsd=0;}],
  ['Maker close request',f=>{f.orders[2].request.postOnly=true;}],
  ['Maker close metadata',f=>{f.orders[2].makerReduction={activity:'terminal',makerLeg:'long',deadlineAt:15000,bookedExecution:true};}],
  ['Maker parent budget',f=>{f.orders[2].executionEvidence!.makerCloseParentClientId='old-maker';}],
  ['foreign conditional batch',f=>{f.orders[2].executionEvidence!.batchId='different-position:ioc-close:batch';}],
  ['synthetic native receipt identity',f=>{f.orders[2].result!.id=f.orders[2].request.clientOrderId;}],
  ['untrusted local unknown outcome',f=>{f.noSubmit.result!.rejectionCode='NETWORK_ERROR';}],
  ['local no-submit with hidden cash',f=>{f.noSubmit.result!.filledQuantity=.1;}],
  ['duplicate client/native journal',f=>{f.orders.push(structuredClone(f.orders[0]));}],
  ['duplicate active base',f=>{f.positions.push({...structuredClone(f.p),id:'other-current'});}],
  ['foreign same-base unresolved original',f=>{const order=structuredClone(f.orders[0]);order.positionId='different';order.request.clientOrderId='different-client';order.result!.clientOrderId='different-client';order.result!.id='different-native';order.result!.status='unknown';f.orders.push(order);}],
  ['foreign new same-contract terminal trade',f=>{const order=structuredClone(f.orders[0]);order.positionId='different';order.request.clientOrderId='different-client';order.result!.clientOrderId='different-client';order.result!.id='different-native';f.orders.push(order);}],
  ['original manual close operation',f=>{f.operations.push({id:'original-manual',positionId:f.p.id,sourcePositionId:f.p.id,state:'completed',selection:'{}',createdAt:12000,expiresAt:16000});}],
];
for(const [name,change] of refusals)test(`refuses ${name} without mutating cash or original orders`,()=>{
  const f=fixture();change(f);const before=JSON.stringify(f);assert.throws(f.check);assert.equal(JSON.stringify(f),before);
});

for(const [name,change] of [
  ['missing native proof',(f:ReturnType<typeof fixture>)=>{f.proofs.pop();}],
  ['wrong native ID',(f:ReturnType<typeof fixture>)=>{f.proofs[0].nativeOrderId='different';}],
  ['wrong venue',(f:ReturnType<typeof fixture>)=>{f.proofs[0].exchange='bybit';}],
  ['duplicate client proof',(f:ReturnType<typeof fixture>)=>{f.proofs.push({...f.proofs[0]});}],
  ['old observation',(f:ReturnType<typeof fixture>)=>{f.proofs[0].observedAt=500;}],
  ['future observation',(f:ReturnType<typeof fixture>)=>{f.proofs[0].observedAt=f.now+1;}],
] as const)test(`audit refuses ${name}`,()=>{
  const f=fixture();f.check();change(f);assert.throws(()=>buildCurrentIocCloseRestorationAudit(f.p,f.orders,f.proofs,f.now));
});
