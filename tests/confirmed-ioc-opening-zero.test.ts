import test from 'node:test';
import assert from 'node:assert/strict';
import type {JournalOrder,Position} from '../src/shared/types.js';
import {BITGET_CANCELLED_ORDER_RETENTION_MS,isDurableConfirmedIocOpeningZero} from '../src/core/confirmed-ioc-opening-zero.js';
import {buildCurrentIocCloseRestorationAudit} from '../src/core/current-ioc-close-restoration.js';

function fixture(){
  const now=20_000_000,createdAt=now-BITGET_CANCELLED_ORDER_RETENTION_MS-1000;
  const p:Position={id:'original-ioc-position',base:'ONE',mode:'live',status:'attention',openedAt:createdAt-1000,
    plannedExitAt:now+1000,holdMode:'adaptive',entryPolicy:'aligned',automaticEntry:true,feeOnly:true,
    executionEvidence:{version:1,method:'ioc',entryPath:'single-cycle'},closeRequestedAt:now-1000,closeAttemptedAt:now-500,
    closeReason:'Original conditional profit exit',closeProfitRequired:true,closePricing:'best-opposite',profitExitNotionalUsd:100,
    long:{exchange:'bitget',symbol:'ONE/USDT:USDT',side:'long',quantity:10,entryPrice:10,markPrice:10,feesUsd:.1,liquidationDistancePct:null},
    short:{exchange:'gate',symbol:'ONE/USDT:USDT',side:'short',quantity:10,entryPrice:10,markPrice:10,feesUsd:.1,liquidationDistancePct:null},
    fundingUsd:0,feesUsd:.2,transferCostUsd:0,spreadPnlUsd:0,realizedSpreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[]};
  const order:JournalOrder={positionId:p.id,exchange:'bitget',createdAt,
    request:{clientOrderId:'original-zero-client',base:p.base,symbol:p.long.symbol,side:'buy',quantity:1,limitPrice:10,reduceOnly:false},
    result:{id:'9000000000000000002',clientOrderId:'original-zero-client',status:'cancelled',filledQuantity:0,averagePrice:0,
      averagePriceVerified:true,feeUsd:0,timestamp:createdAt+8},
    execution:{bookObservedAt:createdAt-2,quoteAgeMs:2,bookTransport:'websocket',confirmedAt:createdAt+5,confirmationMs:5},
    executionEvidence:{version:1,method:'ioc',role:'hedge',batchId:`${p.id}:opening`,submittedAt:createdAt+1,bookedFeeUsd:0}};
  const orders=[order],check=()=>isDurableConfirmedIocOpeningZero(order,p,orders,now);
  return {now,p,order,orders,check};
}

test('only retained original confirmed Bitget IOC opening zero is reused without a current lookup, cash or clock mutation',()=>{
  const f=fixture(),before=JSON.stringify(f);assert.equal(f.check(),true);assert.equal(JSON.stringify(f),before);
  const audit=buildCurrentIocCloseRestorationAudit(f.p,f.orders,[],f.now),row=audit.originalOrders[0];
  assert.deepEqual(row.durableZero,{submittedAt:f.order.executionEvidence!.submittedAt,confirmedAt:f.order.execution!.confirmedAt,
    nativeTimestamp:f.order.result!.timestamp});assert.equal(row.nativeObservedAt,undefined);assert.equal(row.localNoSubmit,undefined);
  assert.equal(JSON.stringify(f),before);row.durableZero!.confirmedAt=f.now;assert.equal(JSON.stringify(f),before);
});

test('retention boundary uses the original local confirmation time and never updates it',()=>{
  const f=fixture(),confirmed=f.order.execution!.confirmedAt!;
  assert.equal(isDurableConfirmedIocOpeningZero(f.order,f.p,f.orders,confirmed+BITGET_CANCELLED_ORDER_RETENTION_MS-1),false);
  // Keep the original conditional intent before the boundary being checked.
  f.p.closeRequestedAt=confirmed+100;f.p.closeAttemptedAt=confirmed+200;
  assert.equal(isDurableConfirmedIocOpeningZero(f.order,f.p,f.orders,confirmed+BITGET_CANCELLED_ORDER_RETENTION_MS),true);
});

const refusals:Array<[string,(f:ReturnType<typeof fixture>)=>void]>=[
  ['active closing manager',f=>{f.p.status='closing';}],['active open manager',f=>{f.p.status='open';}],
  ['paper mode',f=>{f.p.mode='paper';}],['manual management',f=>{f.p.manualCloseOnly=true;}],
  ['missing automatic origin',f=>{delete f.p.automaticEntry;}],['nonconditional old intent',f=>{f.p.closeProfitRequired=false;}],
  ['Maker position protocol',f=>{f.p.executionEvidence!.method='maker-ioc';}],['manual position origin',f=>{f.p.executionEvidence!.entryPath='manual';}],
  ['other exchange',f=>{f.order.exchange='gate';}],['opening is actually a reduction',f=>{f.order.request.reduceOnly=true;}],
  ['PostOnly opening',f=>{f.order.request.postOnly=true;}],['unknown original result',f=>{f.order.result!.status='unknown';}],
  ['unverified original zero',f=>{f.order.result!.averagePriceVerified=false;}],['positive original fill',f=>{f.order.result!.filledQuantity=.1;}],
  ['nonzero original price',f=>{f.order.result!.averagePrice=10;}],['nonzero original fee',f=>{f.order.result!.feeUsd=.1;}],
  ['unknown original fee',f=>{f.order.result!.feeUsd=NaN;}],['missing native ID',f=>{f.order.result!.id='';}],
  ['synthetic native ID',f=>{f.order.result!.id=f.order.request.clientOrderId;}],['mismatched receipt client',f=>{f.order.result!.clientOrderId='other';}],
  ['active unknown diagnostic',f=>{f.order.result!.confirmation={stage:'order-read',reason:'not-found'};}],
  ['rejected local order',f=>{f.order.result!.rejectionCode='IOC_REDUCTION_PERMISSION_CHANGED';}],
  ['original execution error',f=>{f.order.error='network error';}],['Maker receipt metadata',f=>{f.order.makerReduction={activity:'terminal',makerLeg:'long',deadlineAt:f.now};}],
  ['missing original confirmation',f=>{delete f.order.execution!.confirmedAt;}],['missing original submission',f=>{delete f.order.executionEvidence!.submittedAt;}],
  ['false quote clock',f=>{f.order.execution!.quoteAgeMs=0;}],['false confirmation clock',f=>{f.order.execution!.confirmationMs=0;}],
  ['confirmation before submission',f=>{f.order.execution!.confirmedAt=f.order.createdAt;}],
  ['unbounded native timestamp',f=>{f.order.result!.timestamp=f.order.execution!.confirmedAt!+5001;}],
  ['missing committed zero fee',f=>{delete f.order.executionEvidence!.bookedFeeUsd;}],
  ['peer budget ancestry',f=>{f.order.executionEvidence!.makerCloseParentClientId='parent';}],
  ['duplicate original client',f=>{const o=structuredClone(f.order);o.positionId='other';o.result!.id='other-native';f.orders.push(o);}],
  ['duplicate native ID on another symbol',f=>{const o=structuredClone(f.order);o.positionId='other';o.request.symbol='OTHER/USDT:USDT';
    o.request.clientOrderId='other-client';o.result!.clientOrderId='other-client';f.orders.push(o);}],
  ['same-contract unknown',f=>{const o=structuredClone(f.order);o.positionId='other';o.request.clientOrderId='unknown-client';
    o.result!.clientOrderId='unknown-client';o.result!.id='unknown-native';o.result!.status='unknown';f.orders.push(o);}],
  ['unapplied contradictory native observation',f=>{f.order.reconciliationEvidence=[{observedAt:f.now,reason:'late-read',
    positionId:f.p.id,exchange:'bitget',request:structuredClone(f.order.request),result:{...structuredClone(f.order.result!),status:'unknown'}}];}],
];
for(const [name,mutate] of refusals)test(`durable IOC zero refuses ${name} without changing the original journal`,()=>{
  const f=fixture();mutate(f);const before=JSON.stringify(f);assert.equal(f.check(),false);assert.equal(JSON.stringify(f),before);
});

test('durable IOC zero neither adopts unrelated unknowns nor grants a proof for any positive original cash',()=>{
  const f=fixture(),unrelated=structuredClone(f.order);unrelated.positionId='unrelated';unrelated.exchange='bybit';
  unrelated.request.base='OTHER';unrelated.request.symbol='OTHER/USDT:USDT';unrelated.request.clientOrderId='old-unknown';
  unrelated.result={id:'',clientOrderId:'old-unknown',status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:f.now};
  f.orders.push(unrelated);assert.equal(f.check(),true);assert.equal(unrelated.result.status,'unknown');
  const positive=structuredClone(f.order);positive.request.clientOrderId='positive-original';positive.result!.clientOrderId='positive-original';
  positive.result!.id='positive-native';positive.result!.status='filled';positive.result!.filledQuantity=1;positive.result!.averagePrice=10;
  positive.result!.feeUsd=.01;positive.executionEvidence!.bookedFeeUsd=.01;f.orders.push(positive);
  assert.throws(()=>buildCurrentIocCloseRestorationAudit(f.p,f.orders,[],f.now));assert.equal(unrelated.result.status,'unknown');
});
