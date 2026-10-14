import test from 'node:test';
import assert from 'node:assert/strict';
import {createMakerCloseComparison,updateMakerCloseComparison,makerCloseComparisonReport,type MakerCloseComparisonInput} from '../src/shared/maker-close-comparison.js';
import type {JournalOrder} from '../src/shared/types.js';

const input:MakerCloseComparisonInput={timestamp:1_000,longOppositePrice:100,shortOppositePrice:101,
  longTakerFeeRate:.0005,shortTakerFeeRate:.00055,makerLeg:'long',originalOneLegNotionalUsd:100.5,
  peer:{exchange:'bybit',symbol:'BTC/USDT:USDT'}};
function maker(quantity=1):JournalOrder {
  return {positionId:'offline-position',exchange:'gate',createdAt:1_000,
    request:{clientOrderId:'offline-maker-original',base:'BTC',symbol:'BTC/USDT:USDT',side:'sell',quantity:1,limitPrice:100.8,reduceOnly:true,postOnly:true},
    result:{id:'offline-native-maker',clientOrderId:'offline-maker-original',status:quantity===1?'filled':'partial',
      filledQuantity:quantity,averagePrice:100.8,averagePriceVerified:true,feeUsd:quantity*100.8*.0002,timestamp:2_000},
    makerReduction:{activity:'terminal',makerLeg:'long',deadlineAt:6_000,bookedExecution:true,lastObservedAt:2_000},
    executionEvidence:{version:1,method:'maker',role:'exit',batchId:'offline-maker-batch',bookedFeeUsd:quantity*100.8*.0002},
    makerCloseComparison:createMakerCloseComparison(input)};
}
function peer(quantity=1,price=101.2,id='offline-peer-one'):JournalOrder {
  return {positionId:'offline-position',exchange:'bybit',createdAt:2_001,
    request:{clientOrderId:id,base:'BTC',symbol:'BTC/USDT:USDT',side:'buy',quantity,limitPrice:price,reduceOnly:true},
    result:{id:`native-${id}`,clientOrderId:id,status:'filled',filledQuantity:quantity,averagePrice:price,
      averagePriceVerified:true,feeUsd:quantity*price*.00055,timestamp:2_010},
    executionEvidence:{version:1,method:'ioc',role:'exit-tail',batchId:'offline-peer-batch',bookedFeeUsd:quantity*price*.00055,
      makerCloseParentClientId:'offline-maker-original'}};
}
const near=(actual:number|null,expected:number)=>assert.ok(actual!==null&&Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);

test('long Maker price and fee savings include the full spread and compare real paid cash to the frozen two-IOC baseline',()=>{
  const m=maker(),p=peer(),orders=[m,p];updateMakerCloseComparison(m,orders);const r=m.makerCloseComparison!;
  near(r.makerActualCashUsd,100.8);near(r.makerActualFeeUsd,.02016);
  near(r.makerBenchmarkCashUsd,100);near(r.makerBenchmarkFeeUsd,.05);
  near(r.makerPriceSavingUsd,.8);near(r.makerFeeSavingUsd,.02984);near(r.makerTotalSavingUsd,.82984);
  near(r.peerActualCashUsd,101.2);near(r.peerActualFeeUsd,.05566);
  near(r.peerBenchmarkCashUsd,101);near(r.peerBenchmarkFeeUsd,.05555);
  near(r.peerPriceSavingUsd,-.2);near(r.peerFeeSavingUsd,-.00011);near(r.peerTotalSavingUsd,-.20011);
  near(r.benchmarkPairCostUsd,1.10555);near(r.actualPairCostUsd,.47582);near(r.pairTotalSavingUsd,.62973);
  near(r.pairTotalSavingBps,.62973/100.5*10_000);assert.equal(r.status,'paired');assert.equal(r.pairedComplete,true);
  near(r.pairedQuantity,1);near(r.pairTotalSavingUsd,r.benchmarkPairCostUsd!-r.actualPairCostUsd!);
});

test('short Maker buy savings have the inverse cash direction and the long peer sell can give savings back',()=>{
  const m=maker(),p=peer();m.exchange='bybit';m.request.side='buy';m.request.limitPrice=101;m.result!.averagePrice=101;
  m.result!.feeUsd=.0202;m.executionEvidence!.bookedFeeUsd=.0202;m.makerReduction!.makerLeg='short';
  m.makerCloseComparison=createMakerCloseComparison({...input,makerLeg:'short',shortOppositePrice:101.1,peer:{exchange:'gate',symbol:p.request.symbol}});
  p.exchange='gate';p.request.side='sell';p.request.limitPrice=99.9;p.result!.averagePrice=99.9;p.result!.feeUsd=.04995;p.executionEvidence!.bookedFeeUsd=.04995;
  updateMakerCloseComparison(m,[m,p]);const r=m.makerCloseComparison!;
  near(r.makerPriceSavingUsd,.1);near(r.makerFeeSavingUsd,.035405);near(r.peerPriceSavingUsd,-.1);
  near(r.peerFeeSavingUsd,.00005);near(r.pairTotalSavingUsd,.035455);assert.equal(r.pairedComplete,true);
});

test('a peer delayed enough to outweigh Maker savings retains a negative whole-pair saving',()=>{
  const m=maker(),p=peer(1,102);updateMakerCloseComparison(m,[m,p]);const r=m.makerCloseComparison!;
  near(r.peerPriceSavingUsd,-1);near(r.peerFeeSavingUsd,-.00055);near(r.pairTotalSavingUsd,-.17071);
  assert.equal(r.pairedComplete,true);near(makerCloseComparisonReport([m,p]).totals.pairTotalSavingUsd,-.17071);
});

test('actual Maker rebates are retained and are never replaced by estimated positive fees',()=>{
  const m=maker(),p=peer();m.result!.feeUsd=-.01;m.executionEvidence!.bookedFeeUsd=-.01;
  updateMakerCloseComparison(m,[m,p]);near(m.makerCloseComparison!.makerActualFeeUsd,-.01);
  near(m.makerCloseComparison!.makerFeeSavingUsd,.06);near(m.makerCloseComparison!.makerTotalSavingUsd,.86);
});

test('each cumulative Maker update recomputes one record while all confirmed peer IOC batches accumulate once',()=>{
  const m=maker(.2),first=peer(.2),record=m.makerCloseComparison!;
  m.result!.status='unknown';m.makerReduction!.activity='active';updateMakerCloseComparison(m,[m,first]);
  assert.equal(record.quantitiesMatched,true);assert.equal(record.pairedComplete,false);near(record.pairedQuantity,.2);
  near(record.pairTotalSavingUsd,.2*.62973);assert.equal(makerCloseComparisonReport([m,first]).counts.pending,1);
  const second=peer(.3,101.2,'offline-peer-two');m.result!.filledQuantity=.5;m.result!.status='partial';
  m.result!.feeUsd=.5*100.8*.0002;m.executionEvidence!.bookedFeeUsd=m.result!.feeUsd;m.makerReduction!.activity='terminal';
  const orders=[m,first,second],before=structuredClone(orders.map(order=>({request:order.request,result:order.result,evidence:order.executionEvidence})));
  updateMakerCloseComparison(m,orders);assert.equal(m.makerCloseComparison,record);near(record.peerQuantity,.5);
  near(record.pairTotalSavingUsd,.5*.62973);assert.equal(record.pairedComplete,true);assert.equal(record.peerConfirmedOrderCount,2);
  const once=structuredClone(record);updateMakerCloseComparison(m,orders);assert.deepEqual(record,once);
  assert.deepEqual(orders.map(order=>({request:order.request,result:order.result,evidence:order.executionEvidence})),before);
  const report=makerCloseComparisonReport(orders);assert.equal(report.counts.confirmedPaired,1);near(report.totals.pairTotalSavingUsd,.5*.62973);
});

test('mismatched quantities use all filled cash and fees, without prorating the larger leg down to paired quantity',()=>{
  const m=maker(),p=peer(.5);updateMakerCloseComparison(m,[m,p]);const r=m.makerCloseComparison!;
  near(r.pairedQuantity,.5);near(r.makerActualCashUsd,100.8);near(r.peerActualCashUsd,50.6);
  near(r.makerPriceSavingUsd,.8);near(r.peerPriceSavingUsd,-.1);near(r.pairTotalSavingUsd,.729785);
  assert.equal(r.quantitiesMatched,false);assert.equal(r.pairedComplete,false);assert.equal(r.status,'pending');
  assert.equal(makerCloseComparisonReport([m,p]).counts.confirmedPaired,0);
});

test('unknown peer IOC lower bounds leave complete peer and pair cash null while preserving already confirmed subtotals',()=>{
  const m=maker(.5),known=peer(.3),unknown=peer(.2,101.2,'offline-peer-unknown');unknown.result!.status='unknown';
  updateMakerCloseComparison(m,[m,known,unknown]);const r=m.makerCloseComparison!;
  near(r.makerActualCashUsd,50.4);near(r.makerFeeSavingUsd,.01492);
  assert.equal(r.peerQuantity,null);assert.equal(r.peerActualCashUsd,null);assert.equal(r.peerActualFeeUsd,null);
  assert.equal(r.peerPriceSavingUsd,null);assert.equal(r.pairTotalSavingUsd,null);assert.equal(r.pairedQuantity,null);
  near(r.peerKnownQuantity,.3);near(r.peerKnownCashUsd,30.36);near(r.peerKnownFeeUsd,.016698);
  assert.equal(r.peerConfirmedOrderCount,1);assert.equal(r.peerPendingOrderCount,1);assert.equal(r.pairedComplete,false);
});

test('unbooked positive Maker quantities are unknown rather than a fabricated zero execution',()=>{
  const m=maker(.5);m.result!.status='unknown';m.makerReduction!.activity='active';delete m.makerReduction!.bookedExecution;
  updateMakerCloseComparison(m,[m]);const r=m.makerCloseComparison!;
  assert.equal(r.makerQuantity,null);assert.equal(r.makerActualCashUsd,null);assert.equal(r.makerActualFeeUsd,null);
  assert.equal(r.makerTotalSavingUsd,null);assert.equal(r.status,'pending');assert.equal(makerCloseComparisonReport([m]).counts.zeroFill,0);
});

test('unknown or unbooked actual fees are null, without fees being inferred from rates or missing values as zero',()=>{
  for(const makerBad of ['missing','nan','mismatch'] as const){
    const m=maker(),p=peer();if(makerBad==='missing')delete m.executionEvidence!.bookedFeeUsd;
    if(makerBad==='nan')m.result!.feeUsd=NaN;if(makerBad==='mismatch')m.executionEvidence!.bookedFeeUsd=0;
    updateMakerCloseComparison(m,[m,p]);const r=m.makerCloseComparison!;near(r.makerQuantity,1);near(r.makerPriceSavingUsd,.8);
    assert.equal(r.makerActualFeeUsd,null);assert.equal(r.makerFeeSavingUsd,null);assert.equal(r.pairTotalSavingUsd,null);
    assert.equal(r.pairedComplete,false);
  }
  const m=maker(),p=peer();delete p.executionEvidence!.bookedFeeUsd;updateMakerCloseComparison(m,[m,p]);
  assert.equal(m.makerCloseComparison!.peerQuantity,null);assert.equal(m.makerCloseComparison!.peerActualFeeUsd,null);
});

test('unknown cash price or unverifiable precision keeps price saving null while an actual booked fee remains known',()=>{
  for(const change of [{averagePrice:NaN},{averagePrice:0},{averagePriceVerified:false}]){
    const m=maker(),p=peer();Object.assign(m.result!,change);updateMakerCloseComparison(m,[m,p]);const r=m.makerCloseComparison!;
    assert.equal(r.makerActualCashUsd,null);assert.equal(r.makerPriceSavingUsd,null);near(r.makerActualFeeUsd,.02016);
    near(r.makerFeeSavingUsd,.02984);assert.equal(r.pairTotalSavingUsd,null);assert.equal(r.pairedComplete,false);
  }
});

test('only a trusted cancelled zero can be classified zero-fill and is excluded from filled-pair totals',()=>{
  const m=maker(0);m.result!.status='cancelled';m.result!.averagePrice=0;delete m.makerReduction!.bookedExecution;
  updateMakerCloseComparison(m,[m]);const r=m.makerCloseComparison!;assert.equal(r.status,'zero-fill');assert.equal(r.pairedComplete,false);
  near(r.makerQuantity,0);near(r.makerActualCashUsd,0);near(r.makerActualFeeUsd,0);
  const report=makerCloseComparisonReport([m]);assert.deepEqual(report.counts,{total:1,confirmedPaired:0,pending:0,zeroFill:1});
  near(report.totals.pairTotalSavingUsd,0);
  const ack=maker(0);ack.result!.status='unknown';ack.makerReduction!.activity='unknown';delete ack.makerReduction!.bookedExecution;
  updateMakerCloseComparison(ack,[ack]);assert.equal(ack.makerCloseComparison!.makerQuantity,null);assert.equal(ack.makerCloseComparison!.status,'pending');
});

test('a zero-fill native cash charge remains recorded instead of becoming a profitable filled sample',()=>{
  const m=maker(0);m.result!.status='cancelled';m.result!.averagePrice=0;m.result!.feeUsd=.02;m.executionEvidence!.bookedFeeUsd=.02;
  updateMakerCloseComparison(m,[m]);near(m.makerCloseComparison!.makerActualFeeUsd,.02);near(m.makerCloseComparison!.makerFeeSavingUsd,-.02);
  assert.equal(m.makerCloseComparison!.status,'zero-fill');assert.equal(makerCloseComparisonReport([m]).counts.confirmedPaired,0);
});

test('malformed baselines preserve unknown benchmark rates and prices instead of inventing zero costs',()=>{
  for(const patch of [{longTakerFeeRate:NaN},{longTakerFeeRate:-1},{longTakerFeeRate:Infinity},{longOppositePrice:0},{longOppositePrice:NaN}]){
    const m=maker(),p=peer();m.makerCloseComparison=createMakerCloseComparison({...input,...patch});updateMakerCloseComparison(m,[m,p]);
    assert.equal(m.makerCloseComparison!.makerFeeSavingUsd,null);assert.equal(m.makerCloseComparison!.pairTotalSavingUsd,null);
    assert.equal(m.makerCloseComparison!.pairedComplete,false);
  }
  const r=createMakerCloseComparison({...input,originalOneLegNotionalUsd:NaN});assert.equal(r.originalOneLegNotionalUsd,null);
  const zeroRate=maker(),p=peer();zeroRate.makerCloseComparison=createMakerCloseComparison({...input,longTakerFeeRate:0});
  updateMakerCloseComparison(zeroRate,[zeroRate,p]);near(zeroRate.makerCloseComparison!.makerFeeSavingUsd,-.02016);
});

test('same parent ID cannot link foreign positions or silently mix wrong peer contracts, directions or venues',()=>{
  const foreign=peer();foreign.positionId='unrelated-position';const m=maker();updateMakerCloseComparison(m,[m,foreign]);
  near(m.makerCloseComparison!.peerQuantity,0);assert.equal(m.makerCloseComparison!.peerOrderCount,0);assert.equal(m.makerCloseComparison!.pairedComplete,false);
  for(const bad of ['symbol','side','venue','base','opening','maker'] as const){
    const original=maker(),p=peer();if(bad==='symbol')p.request.symbol='ETH/USDT:USDT';if(bad==='side')p.request.side='sell';
    if(bad==='venue')p.exchange='binance';if(bad==='base')p.request.base='ETH';if(bad==='opening')p.request.reduceOnly=false;if(bad==='maker')p.request.postOnly=true;
    updateMakerCloseComparison(original,[original,p]);assert.equal(original.makerCloseComparison!.peerQuantity,null);
    assert.equal(original.makerCloseComparison!.peerPendingOrderCount,1);assert.equal(original.makerCloseComparison!.pairedComplete,false);
  }
});

test('peer retries without the frozen parent ID are excluded and omitted peers never become phantom fills',()=>{
  const m=maker(),p=peer();p.executionEvidence!.makerCloseParentClientId='other-maker';updateMakerCloseComparison(m,[m,p]);
  near(m.makerCloseComparison!.peerQuantity,0);near(m.makerCloseComparison!.peerActualCashUsd,0);assert.equal(m.makerCloseComparison!.pairedComplete,false);
});

test('duplicate cumulative array observations are idempotent, while conflicting duplicate receipts stay unknown',()=>{
  const m=maker(),p=peer();updateMakerCloseComparison(m,[m,p,p]);near(m.makerCloseComparison!.peerQuantity,1);
  const report=makerCloseComparisonReport([m,m,p,p]);assert.equal(report.counts.total,1);near(report.totals.pairTotalSavingUsd,.62973);
  const clone=structuredClone(p);updateMakerCloseComparison(m,[m,p,clone]);assert.equal(m.makerCloseComparison!.peerQuantity,null);
  assert.equal(m.makerCloseComparison!.pairTotalSavingUsd,null);assert.equal(m.makerCloseComparison!.pairedComplete,false);
});

test('missing, over-request or mismatched native receipts cannot produce a saving sample',()=>{
  for(const bad of ['missing','client','overflow','native'] as const){
    const m=maker(),p=peer();if(bad==='missing')delete m.result;if(bad==='client')m.result!.clientOrderId='wrong-client';
    if(bad==='overflow')m.result!.filledQuantity=2;if(bad==='native')m.result!.id='';
    updateMakerCloseComparison(m,[m,p]);assert.equal(m.makerCloseComparison!.makerQuantity,null);
    assert.equal(m.makerCloseComparison!.pairTotalSavingUsd,null);assert.equal(m.makerCloseComparison!.pairedComplete,false);
  }
});

test('a readonly report rebuilds persisted cumulative money, excludes pending samples, whitelists metadata and does not mutate the ledger',()=>{
  const complete=maker(),p=peer(),pending=maker(.5),zero=maker(0);
  pending.positionId='offline-pending';pending.request.clientOrderId=pending.result!.clientOrderId='offline-pending-maker';
  pending.result!.id='offline-native-pending-maker';
  pending.result!.status='unknown';pending.makerReduction!.activity='active';
  zero.positionId='offline-zero';zero.request.clientOrderId=zero.result!.clientOrderId='offline-zero-maker';zero.result!.status='cancelled';zero.result!.averagePrice=0;
  zero.result!.id='offline-native-zero-maker';
  complete.error='private-do-not-report';(complete.result as any).raw={apiKey:'private-do-not-report'};
  (complete.makerCloseComparison as any).secret='private-do-not-report';(complete.makerCloseComparison!.peer as any).secret='private-do-not-report';
  const orders=JSON.parse(JSON.stringify([complete,p,pending,zero])) as JournalOrder[],before=structuredClone(orders),report=makerCloseComparisonReport(orders);
  assert.deepEqual(report.counts,{total:3,confirmedPaired:1,pending:1,zeroFill:1});near(report.totals.pairTotalSavingUsd,.62973);
  assert.equal(report.rows[0].batchId,'offline-maker-batch');assert.equal(report.rows[0].base,'BTC');assert.equal(report.rows[0].makerExchange,'gate');
  assert.equal(report.rows[0].peerExchange,'bybit');assert.match(report.label,/静态基准/);assert.match(report.label,/不保证/);
  const json=JSON.stringify(report);assert.ok(!json.includes('private-do-not-report'));assert.ok(!json.includes('offline-native-maker'));
  assert.deepEqual(orders,before);assert.equal(orders[0].makerCloseComparison!.pairTotalSavingUsd,null,'readonly report did not write derived cash back');
});

test('a comparison is never synthesized after the event for a journal lacking a submission baseline',()=>{
  const m=maker(),p=peer();delete m.makerCloseComparison;const before=structuredClone([m,p]);
  updateMakerCloseComparison(m,[m,p]);assert.equal(m.makerCloseComparison,undefined);
  assert.equal(makerCloseComparisonReport([m,p]).counts.total,0);assert.deepEqual([m,p],before);
});

test('optional peer identity fallback requires one compatible peer venue and the exact standardized contract',()=>{
  const m=maker(),p=peer();m.makerCloseComparison=createMakerCloseComparison({...input,peer:undefined});updateMakerCloseComparison(m,[m,p]);
  assert.equal(m.makerCloseComparison!.pairedComplete,true);
  const other=peer(.1,101.2,'offline-foreign-venue');other.exchange='binance';updateMakerCloseComparison(m,[m,p,other]);
  assert.equal(m.makerCloseComparison!.peerQuantity,null);assert.equal(m.makerCloseComparison!.pairedComplete,false);
});

test('many tiny confirmed peer fills keep matched quantity and full cash without an accumulation-created residual',()=>{
  const m=maker(),peers=Array.from({length:1_000},(_,index)=>peer(.001,101.2,`offline-tiny-peer-${index}`));
  updateMakerCloseComparison(m,[m,...peers]);const r=m.makerCloseComparison!;
  assert.equal(r.peerQuantity,1);assert.equal(r.pairedComplete,true);near(r.peerActualCashUsd,101.2);
  near(r.peerActualFeeUsd,.05566);near(r.pairTotalSavingUsd,.62973);
});

test('verified legacy .9 peer proof preserves the old journal while a late .1 completes the original comparison at negative total saving',()=>{
  const m=maker(),legacy=peer(.9,101.2,'offline-legacy-peer'),tail=peer(.1,110,'offline-repaired-tail');
  delete legacy.executionEvidence!.makerCloseParentClientId;
  const originalLegacy=structuredClone(legacy);
  updateMakerCloseComparison(m,[m,legacy]);near(m.makerCloseComparison!.peerQuantity,0);
  m.makerReduction!.recoveredPeers={verifiedAt:3_000,clientOrderIds:[legacy.request.clientOrderId]};
  updateMakerCloseComparison(m,[m,legacy]);near(m.makerCloseComparison!.peerQuantity,.9);
  assert.equal(m.makerCloseComparison!.status,'pending');assert.deepEqual(legacy,originalLegacy);
  updateMakerCloseComparison(m,[m,legacy,tail]);const r=m.makerCloseComparison!;
  assert.equal(r.status,'paired');near(r.peerQuantity,1);assert.equal(r.peerConfirmedOrderCount,2);
  near(r.makerActualCashUsd,100.8);near(r.peerActualCashUsd,102.08);near(r.peerActualFeeUsd,.056144);
  near(r.peerPriceSavingUsd,-1.08);near(r.pairTotalSavingUsd,-.250754);
  near(r.benchmarkPairCostUsd!-r.actualPairCostUsd!,r.pairTotalSavingUsd!);
  const ledger=structuredClone([m,legacy,tail]),report=makerCloseComparisonReport([m,legacy,tail]);
  assert.deepEqual(report.counts,{total:1,confirmedPaired:1,pending:0,zeroFill:0});
  near(report.totals.pairTotalSavingUsd,-.250754);assert.deepEqual([m,legacy,tail],ledger);
  assert.deepEqual(legacy,originalLegacy);
});

test('invalid or multiply claimed legacy peer proofs retain unknown comparison cash instead of counting a repaired sample',()=>{
  for(const failure of ['no-proof','duplicate-client','duplicate-claim','foreign-parent','foreign-symbol','old-receipt','unbooked-fee'] as const){
    const m=maker(),legacy=peer(.9,101.2,'offline-legacy-peer'),tail=peer(.1,101.2,'offline-repaired-tail');
    delete legacy.executionEvidence!.makerCloseParentClientId;
    m.makerReduction!.recoveredPeers={verifiedAt:3_000,clientOrderIds:[legacy.request.clientOrderId]};
    const orders=[m,legacy,tail];
    if(failure==='no-proof')m.makerReduction!.recoveredPeers!.verifiedAt=NaN;
    if(failure==='duplicate-client')orders.push(structuredClone(legacy));
    if(failure==='duplicate-claim'){
      const other=maker();other.request.clientOrderId=other.result!.clientOrderId='other-maker-original';
      other.result!.id='other-maker-native';other.makerReduction!.recoveredPeers={verifiedAt:3_000,clientOrderIds:[legacy.request.clientOrderId]};
      orders.push(other);
    }
    if(failure==='foreign-parent')legacy.executionEvidence!.makerCloseParentClientId='other-maker-parent';
    if(failure==='foreign-symbol')legacy.request.symbol='ETH/USDT:USDT';
    if(failure==='old-receipt')legacy.createdAt=m.createdAt-1;
    if(failure==='unbooked-fee')delete legacy.executionEvidence!.bookedFeeUsd;
    updateMakerCloseComparison(m,orders);
    assert.equal(m.makerCloseComparison!.peerQuantity,null,failure);assert.equal(m.makerCloseComparison!.pairTotalSavingUsd,null,failure);
    assert.equal(m.makerCloseComparison!.pairedComplete,false,failure);
  }
});

test('a missing receipt named by a recovery proof cannot be replaced by an otherwise complete new peer batch',()=>{
  const m=maker(),p=peer();
  m.makerReduction!.recoveredPeers={verifiedAt:3_000,clientOrderIds:['missing-original-peer']};
  updateMakerCloseComparison(m,[m,p]);
  assert.equal(m.makerCloseComparison!.pairedComplete,false);
  assert.equal(m.makerCloseComparison!.peerQuantity,null);assert.equal(m.makerCloseComparison!.pairTotalSavingUsd,null);
  assert.equal(makerCloseComparisonReport([m,p]).counts.confirmedPaired,0);
});
