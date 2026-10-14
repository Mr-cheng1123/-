import test from 'node:test';
import assert from 'node:assert/strict';
import {createMakerCloseComparison,updateMakerCloseComparison,makerCloseComparisonReport,type MakerCloseComparisonInput} from '../src/shared/maker-close-comparison.js';
import type {JournalOrder} from '../src/shared/types.js';

const input:MakerCloseComparisonInput={timestamp:1000,longOppositePrice:100,shortOppositePrice:100,longTakerFeeRate:.0005,
  shortTakerFeeRate:.0006,makerLeg:'long',originalOneLegNotionalUsd:100,peer:{exchange:'bitget',symbol:'BTC/USDT:USDT'},feeRebatePct:{maker:70,peer:50}};
function maker():JournalOrder {
  return {positionId:'rebate-pair-offline',exchange:'gate',createdAt:1000,
    request:{clientOrderId:'rebate-maker-original',base:'BTC',symbol:'BTC/USDT:USDT',side:'sell',quantity:1,limitPrice:100,reduceOnly:true,postOnly:true},
    result:{id:'native-rebate-maker',clientOrderId:'rebate-maker-original',status:'filled',filledQuantity:1,averagePrice:100,averagePriceVerified:true,feeUsd:.02,timestamp:2000},
    makerReduction:{activity:'terminal',makerLeg:'long',deadlineAt:6000,bookedExecution:true,lastObservedAt:2000},
    executionEvidence:{version:1,method:'maker',role:'exit',batchId:'rebate-maker-batch',bookedFeeUsd:.02},
    makerCloseComparison:createMakerCloseComparison(input)};
}
function peer(quantity=1,fee=.06,id='rebate-peer-one'):JournalOrder {
  return {positionId:'rebate-pair-offline',exchange:'bitget',createdAt:2001,
    request:{clientOrderId:id,base:'BTC',symbol:'BTC/USDT:USDT',side:'buy',quantity,limitPrice:100,reduceOnly:true},
    result:{id:`native-${id}`,clientOrderId:id,status:'filled',filledQuantity:quantity,averagePrice:100,averagePriceVerified:true,feeUsd:fee,timestamp:2010},
    executionEvidence:{version:1,method:'ioc',role:'exit-tail',batchId:id,bookedFeeUsd:fee,makerCloseParentClientId:'rebate-maker-original'}};
}
const near=(actual:number|null|undefined,expected:number)=>assert.ok(typeof actual==='number'&&Math.abs(actual-expected)<1e-10,`${actual} != ${expected}`);

test('Gate maker2bps versus taker5bps saves30percent of original fee saving after70percent rebate',()=>{
  const m=maker(),p=peer();updateMakerCloseComparison(m,[m,p]);const r=m.makerCloseComparison!;
  assert.equal(r.pairedComplete,true);near(r.makerFeeSavingUsd,.03);near(r.pairTotalSavingUsd,.03);
  near(r.benchmarkPairCostUsd,.11);near(r.actualPairCostUsd,.08);
  near(r.estimatedMakerRebateUsd,.014);near(r.estimatedPeerRebateUsd,.03);
  near(r.estimatedBenchmarkFeeRebateUsd,.065);near(r.estimatedActualFeeRebateUsd,.044);
  near(r.estimatedBenchmarkPairCostAfterRebateUsd,.045);near(r.estimatedPairCostAfterRebateUsd,.036);
  near(r.estimatedPairSavingAfterRebateUsd,.009);near(r.estimatedPairSavingAfterRebateUsd,r.pairTotalSavingUsd!*.3);
  near(r.estimatedPairSavingAfterRebateBps,.9);
});

test('both baseline and actual cost use original copied policy rather than later changes to input',()=>{
  const policy={maker:70,peer:50},m=maker(),p=peer();
  m.makerCloseComparison=createMakerCloseComparison({...input,feeRebatePct:policy});policy.maker=0;policy.peer=0;
  updateMakerCloseComparison(m,[m,p]);near(m.makerCloseComparison!.estimatedPairSavingAfterRebateUsd,.009);
  assert.deepEqual(m.makerCloseComparison!.feeRebatePct,{maker:70,peer:50});
  const before=structuredClone([m,p]),first=makerCloseComparisonReport([m,p]),second=makerCloseComparisonReport([m,p]);
  assert.deepEqual(first,second);assert.deepEqual([m,p],before);
});

test('negative native Maker fee is actual cash and receives no additional projected rebate',()=>{
  const m=maker(),p=peer();m.result!.feeUsd=-.01;m.executionEvidence!.bookedFeeUsd=-.01;
  updateMakerCloseComparison(m,[m,p]);const r=m.makerCloseComparison!;
  near(r.makerActualFeeUsd,-.01);near(r.makerFeeSavingUsd,.06);near(r.pairTotalSavingUsd,.06);
  near(r.estimatedMakerRebateUsd,0);near(r.estimatedActualFeeRebateUsd,.03);
  near(r.estimatedPairCostAfterRebateUsd,.02);near(r.estimatedPairSavingAfterRebateUsd,.025);
});

test('mixed positive and negative peer fees rebate only each confirmed positive expense',()=>{
  const m=maker(),positive=peer(.5,.03,'rebate-peer-positive'),negative=peer(.5,-.02,'rebate-peer-negative');
  updateMakerCloseComparison(m,[m,positive,negative]);const r=m.makerCloseComparison!;
  assert.equal(r.pairedComplete,true);near(r.peerActualFeeUsd,.01);
  near(r.estimatedPeerRebateUsd,.015);near(r.estimatedActualFeeRebateUsd,.029);
  near(r.estimatedPairCostAfterRebateUsd,.001);near(r.estimatedPairSavingAfterRebateUsd,.044);
  const original=structuredClone([m,positive,negative]);updateMakerCloseComparison(m,[m,positive,negative,positive,negative]);
  assert.deepEqual([m,positive,negative],original);
});

test('an unknown peer cash or booked fee stays unknown even with100percent policy',()=>{
  for(const failure of ['unknown','fee','duplicate','price'] as const){
    const m=maker(),p=peer();m.makerCloseComparison=createMakerCloseComparison({...input,feeRebatePct:{maker:100,peer:100}});
    const orders=[m,p];
    if(failure==='unknown')p.result!.status='unknown';
    if(failure==='fee')delete p.executionEvidence!.bookedFeeUsd;
    if(failure==='duplicate')orders.push(structuredClone(p));
    if(failure==='price')p.result!.averagePriceVerified=false;
    updateMakerCloseComparison(m,orders);const r=m.makerCloseComparison!;
    assert.equal(r.pairedComplete,false,failure);assert.equal(r.estimatedPairCostAfterRebateUsd,null,failure);
    assert.equal(r.estimatedPairSavingAfterRebateUsd,null,failure);
    if(failure!=='price')assert.equal(r.estimatedPeerRebateUsd,null,failure);
    const report=makerCloseComparisonReport(orders);near(report.totals.estimatedPairSavingAfterRebateUsd,0);
    assert.equal(report.counts.rebateEstimatedPaired,0);
  }
});

test('invalid percentage policies retain unknown projections without replacing original gross savings',()=>{
  for(const percentage of [-1,101,NaN,Infinity,'70',null]){
    const m=maker(),p=peer();m.makerCloseComparison=createMakerCloseComparison({...input,feeRebatePct:{maker:percentage as number,peer:50}});
    updateMakerCloseComparison(m,[m,p]);const r=m.makerCloseComparison!;
    assert.equal(r.pairedComplete,true);near(r.pairTotalSavingUsd,.03);assert.equal(r.feeRebatePct!.maker,null);
    assert.equal(r.estimatedActualFeeRebateUsd,null);assert.equal(r.estimatedPairSavingAfterRebateUsd,null);
    const report=makerCloseComparisonReport([m,p]);assert.equal(report.totals.estimatedPairSavingAfterRebateUsd,null);
    assert.equal(report.counts.rebateEstimatedPaired,0);assert.equal(report.counts.rebateUnknownPaired,1);
  }
});

test('old records keep gross comparison without retroactively inventing a rebate policy or estimate',()=>{
  const m=maker(),p=peer();m.makerCloseComparison=createMakerCloseComparison({...input,feeRebatePct:undefined});
  const raw=structuredClone([m,p]),report=makerCloseComparisonReport([m,p]);
  assert.equal('feeRebatePct' in report.rows[0],false);assert.equal('estimatedPairSavingAfterRebateUsd' in report.rows[0],false);
  assert.equal('estimatedPairSavingAfterRebateUsd' in report.totals,false);assert.equal('rebateEstimatedPaired' in report.counts,false);
  near(report.totals.pairTotalSavingUsd,.03);assert.deepEqual([m,p],raw);
  updateMakerCloseComparison(m,[m,p]);assert.equal('feeRebatePct' in m.makerCloseComparison!,false);
});

test('mixed old and frozen-policy report separates confirmed projection coverage and never changes ledger',()=>{
  const m=maker(),p=peer(),old=maker(),oldPeer=peer();
  old.positionId=oldPeer.positionId='legacy-pair';old.request.clientOrderId=old.result!.clientOrderId='legacy-maker';old.result!.id='native-legacy-maker';
  oldPeer.request.clientOrderId=oldPeer.result!.clientOrderId='legacy-peer';oldPeer.result!.id='native-legacy-peer';
  oldPeer.executionEvidence!.makerCloseParentClientId='legacy-maker';old.makerCloseComparison=createMakerCloseComparison({...input,feeRebatePct:undefined});
  const orders=[m,p,old,oldPeer],before=structuredClone(orders),report=makerCloseComparisonReport(orders);
  assert.equal(report.counts.confirmedPaired,2);assert.equal(report.counts.rebateEstimatedPaired,1);assert.equal(report.counts.rebateUnknownPaired,1);
  near(report.totals.pairTotalSavingUsd,.06);near(report.totals.estimatedPairSavingAfterRebateUsd,.009);
  assert.deepEqual(orders,before);assert.match(report.label,/尚未确认返佣到账/);assert.match(report.label,/旧批次不补造比例/);
});

test('policy and estimate DTO fields are whitelisted and rebuilt from confirmed cash',()=>{
  const m=maker(),p=peer();(m.makerCloseComparison!.feeRebatePct as any).secret='private-secret';
  (m.makerCloseComparison as any).estimatedActualFeeRebateUsd=999;(m.makerCloseComparison as any).hidden='private-secret';
  const before=structuredClone([m,p]),report=makerCloseComparisonReport([m,p]);
  near(report.rows[0].estimatedActualFeeRebateUsd,.044);assert.deepEqual(report.rows[0].feeRebatePct,{maker:70,peer:50});
  assert.ok(!JSON.stringify(report).includes('private-secret'));assert.deepEqual([m,p],before);
});

test('short Maker inverse price direction uses the same frozen percentages and preserves loss signs',()=>{
  const m=maker(),p=peer();m.exchange='bitget';m.request.side='buy';m.makerReduction!.makerLeg='short';
  m.makerCloseComparison=createMakerCloseComparison({...input,makerLeg:'short',feeRebatePct:{maker:50,peer:70},peer:{exchange:'gate',symbol:p.request.symbol}});
  p.exchange='gate';p.request.side='sell';p.result!.feeUsd=.05;p.executionEvidence!.bookedFeeUsd=.05;
  updateMakerCloseComparison(m,[m,p]);const r=m.makerCloseComparison!;
  near(r.pairTotalSavingUsd,.04);near(r.estimatedPairSavingAfterRebateUsd,.02);near(r.estimatedMakerRebateUsd,.01);near(r.estimatedPeerRebateUsd,.035);
  p.result!.averagePrice=p.request.limitPrice=99;updateMakerCloseComparison(m,[m,p]);
  assert.ok(m.makerCloseComparison!.pairTotalSavingUsd!<0);assert.ok(m.makerCloseComparison!.estimatedPairSavingAfterRebateUsd!<0);
});
