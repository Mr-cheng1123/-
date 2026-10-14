import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createMakerCloseComparison,type MakerCloseComparisonReport,type MakerCloseComparisonRow} from '../src/shared/maker-close-comparison.js';
import MakerCloseComparisons,{MakerCloseComparisonTable} from '../web/src/MakerCloseComparisons.js';

const row=(id:string,policy=true):MakerCloseComparisonRow=>({...createMakerCloseComparison({timestamp:1000,
  longOppositePrice:1,shortOppositePrice:1,longTakerFeeRate:.0005,shortTakerFeeRate:.0006,makerLeg:'long',originalOneLegNotionalUsd:100,
  ...(policy?{feeRebatePct:{maker:70,peer:50}}:{})}),batchId:id,positionId:'strategy',base:'ORCA',makerExchange:'gate',peerExchange:'bitget',
  status:'paired',pairedComplete:true,pairedQuantity:10,benchmarkPairCostUsd:.11,actualPairCostUsd:.12,pairTotalSavingUsd:-.01,pairTotalSavingBps:-1,
  ...(policy?{estimatedBenchmarkFeeRebateUsd:.065,estimatedActualFeeRebateUsd:.055,estimatedBenchmarkPairCostAfterRebateUsd:.045,
    estimatedPairCostAfterRebateUsd:.065,estimatedPairSavingAfterRebateUsd:-.02,estimatedPairSavingAfterRebateBps:-2}:{})});
const report=(rows:MakerCloseComparisonRow[]):MakerCloseComparisonReport=>({benchmark:'submission-opposite-1',label:'静态基准',rows,
  counts:{total:rows.length,confirmedPaired:rows.length,pending:0,zeroFill:0,
    rebateEstimatedPaired:rows.filter(item=>item.feeRebatePct).length,rebateUnknownPaired:rows.filter(item=>!item.feeRebatePct).length},
  totals:{pairedQuantity:rows.length*10,makerPriceSavingUsd:0,makerFeeSavingUsd:0,makerTotalSavingUsd:0,
    peerPriceSavingUsd:0,peerFeeSavingUsd:0,pairTotalSavingUsd:-.02,benchmarkPairCostUsd:.22,actualPairCostUsd:.24,
    estimatedBenchmarkPairCostAfterRebateUsd:.045,estimatedPairCostAfterRebateUsd:.065,estimatedPairSavingAfterRebateUsd:-.02}});
const html=(value:MakerCloseComparisonReport)=>renderToStaticMarkup(createElement(MakerCloseComparisonTable,{report:value}));

test('Maker view keeps gross cash comparison and clearly separates frozen-policy rebate estimates and sample coverage',()=>{
  const value=report([row('new'),row('old',false)]),before=structuredClone(value),shown=html(value);
  assert.match(shown,/原扣费实际平仓成本/);assert.match(shown,/返佣后估算实际成本/);
  assert.match(shown,/原扣费平仓总节省/);assert.match(shown,/预计返佣后节省/);
  assert.match(shown,/覆盖 1 批/);assert.match(shown,/另有 1 批/);assert.match(shown,/样本范围可能不同/);
  assert.match(shown,/Maker 70%/);assert.match(shown,/对侧 50%/);assert.match(shown,/−\$0\.02/);assert.match(shown,/-2\.00 bps/);
  assert.match(shown,/价格改善与手续费差/);assert.match(shown,/未核对到账/);assert.match(shown,/不重复加入实账利润/);
  assert.deepEqual(value,before);
});

test('legacy batches retain original cost and saving without inventing rebate ratios or projected subtotal cash',()=>{
  const value=report([row('legacy',false)]);delete value.counts.rebateEstimatedPaired;delete value.counts.rebateUnknownPaired;
  const shown=html(value);
  assert.match(shown,/未记录 · 不参与预计小计/);assert.match(shown,/无已记录比例样本/);
  assert.match(shown,/另有 1 批/);assert.match(shown,/\$0\.11/);assert.match(shown,/\$0\.12/);
  assert.ok(!shown.includes('Maker 70%'));assert.ok(!shown.includes('实际 $0.065'));
});

test('explicit zero rebate is a recorded policy while unknown projected costs remain unknown',()=>{
  const item=row('zero-policy');item.feeRebatePct={maker:0,peer:0};item.estimatedPairCostAfterRebateUsd=null;
  item.estimatedPairSavingAfterRebateUsd=null;item.estimatedPairSavingAfterRebateBps=null;
  const shown=html(report([item]));
  assert.match(shown,/Maker 0%/);assert.match(shown,/对侧 0%/);assert.match(shown,/实际 待核对/);assert.match(shown,/bps 待核对/);
  assert.ok(!shown.includes('实际 $0.00'));
});

test('opening the Maker comparison component has no render-time query and explicitly offers local manual refresh',t=>{
  let queries=0;t.mock.method(globalThis,'fetch',async()=>{queries++;throw new Error('Unexpected render-time query');});
  const shown=renderToStaticMarkup(createElement(MakerCloseComparisons));
  assert.match(shown,/刷新平仓比较/);assert.match(shown,/打开页面或点击刷新读取本机记录/);assert.match(shown,/等待平仓比较记录同步/);
  assert.equal(queries,0);
});
