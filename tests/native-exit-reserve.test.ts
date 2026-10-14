import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateNativeExitReserve,type NativeExitTakerProof} from '../src/core/native-exit-reserve.js';
import {defaultConfig} from '../src/shared/config.js';
import type {AppConfig,JournalOrder,Position} from '../src/shared/types.js';

const now=1791658000000,symbol='BTC/USDT:USDT';
const config:AppConfig={...structuredClone(defaultConfig),mode:'live',dataSource:'public',feeRebatePct:{gate:70,bitget:50}};
function position():Position {
  return {id:'OFFLINE-NATIVE-RESERVE',base:'BTC',mode:'live',status:'attention',openedAt:now-10000,plannedExitAt:now+10000,holdMode:'adaptive',
    long:{exchange:'gate',symbol,side:'long',quantity:10,entryPrice:100,markPrice:100,feesUsd:10,liquidationDistancePct:null},
    short:{exchange:'bitget',symbol,side:'short',quantity:10,entryPrice:100,markPrice:100,feesUsd:10,liquidationDistancePct:null},
    fundingUsd:0,feesUsd:20,transferCostUsd:0,realizedSpreadPnlUsd:0,spreadPnlUsd:0,netPnlUsd:0,deltaUsd:0,fundingEvents:[],riskReasons:[]};
}
function order(exchange:'gate'|'bitget'='gate'):JournalOrder {
  return {positionId:'OFFLINE-NATIVE-RESERVE',exchange,createdAt:now-2000,
    request:{clientOrderId:`offline-unknown-${exchange}`,base:'BTC',symbol,side:exchange==='gate'?'sell':'buy',
      quantity:exchange==='gate'?2:3,limitPrice:exchange==='gate'?99:101,reduceOnly:true},
    result:{id:`offline-native-${exchange}`,clientOrderId:`offline-unknown-${exchange}`,status:'unknown',filledQuantity:0,
      averagePrice:0,feeUsd:0,timestamp:now-1000},
    executionEvidence:{version:1,method:'ioc',role:'exit-tail',batchId:'offline-original',nativeTakerFeeRate:exchange==='gate'?.001:.0006,
      feeObservedAt:now-2500}};
}
function rates():NativeExitTakerProof[] {
  return [{exchange:'gate',symbol,takerFeeRate:.0005,takerFeeAt:now-1000,takerFeeSource:'exchange'},
    {exchange:'bitget',symbol,takerFeeRate:.0006,takerFeeAt:now-1000,takerFeeSource:'exchange'}];
}
const approximately=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-12,`${actual} != ${expected}`);

test('old unknown IOC fees use full original quantity, higher actual/frozen rate and confirmed rebate cost',t=>{
  t.mock.method(Date,'now',()=>now);const p=position(),orders=[order(),order('bitget')],proofs=rates();
  const before=structuredClone({p,orders,proofs,config});
  const reserve=estimateNativeExitReserve(orders,p,proofs,config);
  approximately(reserve.feeReserveUsd,2*99*.001*.3+3*101*.0006*.5);approximately(reserve.lossReserveUsd,5);
  assert.deepEqual({p,orders,proofs,config},before,'cash, quantities, observations and configuration are unchanged');
});

test('current account fee higher than original evidence is reserved, and absent old fee does not become zero',t=>{
  t.mock.method(Date,'now',()=>now);const p=position(),o=order(),proofs=rates();proofs[0].takerFeeRate=.002;
  approximately(estimateNativeExitReserve([o],p,proofs,config).feeReserveUsd,2*99*.002*.3);
  delete o.executionEvidence!.nativeTakerFeeRate;
  approximately(estimateNativeExitReserve([o],p,proofs,config).feeReserveUsd,2*99*.002*.3);
});

test('absent receipt and unknown cumulative quantity or fee cannot shorten the full-request reserve',t=>{
  t.mock.method(Date,'now',()=>now);
  for(const change of [(o:JournalOrder)=>{delete o.result;},(o:JournalOrder)=>{o.result!.filledQuantity=NaN;o.result!.feeUsd=NaN;},
    (o:JournalOrder)=>{o.result!.filledQuantity=1;o.result!.averagePrice=99;o.result!.feeUsd=NaN;}]){
    const o=order();change(o);approximately(estimateNativeExitReserve([o],position(),rates(),config).feeReserveUsd,2*99*.001*.3);
  }
});

test('favorable limit prices never manufacture profit or reduce the possible loss of another old unknown',t=>{
  t.mock.method(Date,'now',()=>now);const sell=order(),buy=order('bitget');sell.request.limitPrice=101;buy.request.limitPrice=99;
  assert.equal(estimateNativeExitReserve([sell,buy],position(),rates(),config).lossReserveUsd,0);
  sell.request.limitPrice=99;
  assert.equal(estimateNativeExitReserve([sell,buy],position(),rates(),config).lossReserveUsd,2);
});

function audited(o=order()):JournalOrder {
  o.result={...o.result!,filledQuantity:1,averagePrice:99,feeUsd:.099,averagePriceVerified:true};
  o.execution={bookObservedAt:now-2500,quoteAgeMs:500,bookTransport:'rest',confirmedAt:now-500};
  o.executionEvidence!.bookedFeeUsd=.099;
  o.executionEvidence!.fills=[{execId:'offline-native-trade-1',quantity:1,price:99,feeUsd:.099,feeCurrency:'USDT',
    liquidity:'taker',observedAt:now-1000}];
  return o;
}
test('only full native fill audit with saved booked fees and commit timing can credit a paid lower bound',t=>{
  t.mock.method(Date,'now',()=>now);const o=audited();
  approximately(estimateNativeExitReserve([o],position(),rates(),config).feeReserveUsd,(2*99*.001-.099)*.3);
  assert.equal(estimateNativeExitReserve([o],position(),rates(),config).lossReserveUsd,2,'price loss still reserves the whole request');
});

for(const [reason,change] of [
  ['no native fill audit',(o:JournalOrder)=>{delete o.executionEvidence!.fills;}],
  ['no native ID',(o:JournalOrder)=>{o.result!.id='';}],
  ['unverified average',(o:JournalOrder)=>{o.result!.averagePriceVerified=false;}],
  ['missing cash commit',(o:JournalOrder)=>{delete o.execution!.confirmedAt;}],
  ['missing booked fee',(o:JournalOrder)=>{delete o.executionEvidence!.bookedFeeUsd;}],
  ['different booked fee',(o:JournalOrder)=>{o.executionEvidence!.bookedFeeUsd=.1;}],
  ['different fill quantity',(o:JournalOrder)=>{o.executionEvidence!.fills![0].quantity=.5;}],
  ['different fill price',(o:JournalOrder)=>{o.executionEvidence!.fills![0].price=98;}],
  ['different fill fee',(o:JournalOrder)=>{o.executionEvidence!.fills![0].feeUsd=.098;}],
  ['foreign fee currency',(o:JournalOrder)=>{(o.executionEvidence!.fills![0] as any).feeCurrency='BTC';}],
  ['duplicate trade',(o:JournalOrder)=>{o.executionEvidence!.fills!.push(structuredClone(o.executionEvidence!.fills![0]));}],
  ['later fill audit',(o:JournalOrder)=>{o.executionEvidence!.fills![0].observedAt=now;}],
] as const){test(`${reason} never credits a presumed historical fee`,t=>{
  t.mock.method(Date,'now',()=>now);const o=audited();change(o);
  approximately(estimateNativeExitReserve([o],position(),rates(),config).feeReserveUsd,2*99*.001*.3);
});}

test('a favorable booked sell cannot use its higher paid fee to erase the unobserved remainder reserve',t=>{
  t.mock.method(Date,'now',()=>now);const o=audited();o.result!.averagePrice=199;o.result!.feeUsd=.199;
  o.executionEvidence!.bookedFeeUsd=.199;o.executionEvidence!.fills![0].price=199;o.executionEvidence!.fills![0].feeUsd=.199;
  approximately(estimateNativeExitReserve([o],position(),rates(),config).feeReserveUsd,(2*99*.001-1*99*.001)*.3);
});

test('the same native trade copied to different unknown orders never receives any duplicate fee credit',t=>{
  t.mock.method(Date,'now',()=>now);const a=audited(),b=audited();
  b.request.clientOrderId='offline-second-client';b.result!.clientOrderId=b.request.clientOrderId;b.result!.id='offline-second-native';
  approximately(estimateNativeExitReserve([a,b],position(),rates(),config).feeReserveUsd,4*99*.001*.3);
});

test('individually plausible audits must jointly fit the durable leg and group fee ledger',t=>{
  t.mock.method(Date,'now',()=>now);const a=audited(),b=audited();
  b.request.clientOrderId='offline-second-client';b.result!.clientOrderId=b.request.clientOrderId;b.result!.id='offline-second-native';
  b.executionEvidence!.fills![0].execId='offline-native-trade-2';
  for(const changedField of ['leg','group']){
    const p=position();if(changedField==='leg')p.long.feesUsd=.15;else p.feesUsd=.15;
    approximately(estimateNativeExitReserve([a,b],p,rates(),config).feeReserveUsd,4*99*.001*.3);
    approximately(estimateNativeExitReserve([b,a],p,rates(),config).feeReserveUsd,4*99*.001*.3);
  }
});

for(const [reason,change] of [
  ['missing current account fee',(proofs:NativeExitTakerProof[])=>{delete proofs[0].takerFeeRate;}],
  ['reference source',(proofs:NativeExitTakerProof[])=>{(proofs[0] as any).takerFeeSource='official-reference';}],
  ['stale account fee',(proofs:NativeExitTakerProof[])=>{proofs[0].takerFeeAt=now-120001;}],
  ['future account fee',(proofs:NativeExitTakerProof[])=>{proofs[0].takerFeeAt=now+5001;}],
  ['foreign account',(proofs:NativeExitTakerProof[])=>{proofs[0].exchange='bybit';}],
  ['foreign contract',(proofs:NativeExitTakerProof[])=>{proofs[0].symbol='ETH/USDT:USDT';}],
  ['duplicate current proof',(proofs:NativeExitTakerProof[])=>{proofs.push(structuredClone(proofs[0]));}],
  ['negative current fee',(proofs:NativeExitTakerProof[])=>{proofs[0].takerFeeRate=-.001;}],
] as const){test(`${reason} rejects the reserve without assuming zero fees`,t=>{
  t.mock.method(Date,'now',()=>now);const proofs=rates();change(proofs);
  assert.throws(()=>estimateNativeExitReserve([order()],position(),proofs,config),/不能计算安全退出准备金/);
});}

for(const [reason,change] of [
  ['non-reduce-only',(o:JournalOrder)=>{o.request.reduceOnly=false;}],
  ['unknown PostOnly',(o:JournalOrder)=>{o.request.postOnly=true;}],
  ['malformed PostOnly',(o:JournalOrder)=>{(o.request as any).postOnly='false';}],
  ['frozen Maker evidence',(o:JournalOrder)=>{o.executionEvidence!.method='maker';}],
  ['wrong original position',(o:JournalOrder)=>{o.positionId='foreign';}],
  ['wrong base',(o:JournalOrder)=>{o.request.base='ETH';}],
  ['wrong leg direction',(o:JournalOrder)=>{o.request.side='buy';}],
  ['wrong leg symbol',(o:JournalOrder)=>{o.request.symbol='ETH/USDT:USDT';}],
  ['wrong venue',(o:JournalOrder)=>{o.exchange='bybit';}],
  ['zero request quantity',(o:JournalOrder)=>{o.request.quantity=0;}],
  ['NaN request quantity',(o:JournalOrder)=>{o.request.quantity=NaN;}],
  ['negative request quantity',(o:JournalOrder)=>{o.request.quantity=-1;}],
  ['zero limit price',(o:JournalOrder)=>{o.request.limitPrice=0;}],
  ['infinite limit price',(o:JournalOrder)=>{o.request.limitPrice=Infinity;}],
  ['negative frozen fee',(o:JournalOrder)=>{o.executionEvidence!.nativeTakerFeeRate=-.001;}],
  ['NaN frozen fee',(o:JournalOrder)=>{o.executionEvidence!.nativeTakerFeeRate=NaN;}],
  ['infinite booked fee',(o:JournalOrder)=>{o.executionEvidence!.bookedFeeUsd=Infinity;}],
  ['foreign result ID',(o:JournalOrder)=>{o.result!.clientOrderId='foreign';}],
  ['excess receipt quantity',(o:JournalOrder)=>{o.result!.filledQuantity=3;o.result!.averagePrice=99;}],
  ['negative receipt quantity',(o:JournalOrder)=>{o.result!.filledQuantity=-1;}],
  ['invalid receipt fee',(o:JournalOrder)=>{(o.result as any).feeUsd='0';}],
  ['known complete terminal',(o:JournalOrder)=>{o.result!.status='cancelled';}],
] as const){test(`${reason} cannot authorize a reserve for an unsafe historical operation`,t=>{
  t.mock.method(Date,'now',()=>now);const o=order();change(o);
  assert.throws(()=>estimateNativeExitReserve([o],position(),rates(),config),/不能计算安全退出准备金/);
});}

test('duplicate original client or native identities cannot double count or obtain repeated fee credits',t=>{
  t.mock.method(Date,'now',()=>now);const a=order(),b=structuredClone(a);
  assert.throws(()=>estimateNativeExitReserve([a,b],position(),rates(),config));
  b.request.clientOrderId='different-client';b.result!.clientOrderId=b.request.clientOrderId;
  assert.throws(()=>estimateNativeExitReserve([a,b],position(),rates(),config));
});

test('overflowing notional cannot become a finite-looking zero reserve',t=>{
  t.mock.method(Date,'now',()=>now);const o=order();o.request.quantity=Number.MAX_VALUE;o.request.limitPrice=Number.MAX_VALUE;
  assert.throws(()=>estimateNativeExitReserve([o],position(),rates(),config));
});
