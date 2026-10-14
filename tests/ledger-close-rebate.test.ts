import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {defaultConfig} from '../src/shared/config.js';
import type {Position} from '../src/shared/types.js';
import type {LedgerPositionMetrics} from '../web/src/ledger-position-metrics.js';
import type {LedgerCloseValue} from '../web/src/ledger-close-value.js';
import {ledgerCloseRebate} from '../web/src/ledger-close-rebate.js';
import FeeRebateControls from '../web/src/FeeRebateControls.js';

const near=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-10,`${actual} != ${expected}`);
const fixture=()=>({
  position:{long:{exchange:'gate'},short:{exchange:'bitget'}} as Position,
  metrics:{source:'account',long:{feesUsd:.05},short:{feesUsd:.06}} as LedgerPositionMetrics,
  value:{status:'current',netPnlUsd:.04,closingFeesUsd:.11,closeBatch:{kind:'paired',longQuantity:10,shortQuantity:10,
    longTotalQuantity:100,shortTotalQuantity:100,longLimitPrice:1,shortLimitPrice:1,longTakerFeeRate:.0005,
    shortTakerFeeRate:.0006}} as LedgerCloseValue,
  config:{feeRebatePct:{gate:70,bitget:50}}
});

test('account-cycle close estimate includes paid and expected closing rebates while gross cash stays unchanged',()=>{
  const input=fixture(),before=structuredClone(input),result=ledgerCloseRebate(input.position,input.metrics,input.value,input.config)!;
  near(result.paidFeeRebateUsd,.065);near(result.closingFeeRebateUsd,.065);
  near(result.estimatedFeeRebateUsd,.13);near(result.estimatedNetPnlAfterRebateUsd,.17);
  assert.deepEqual(input,before);
});

test('negative native net fees receive no further rebate; missing observed cash is never assumed zero',()=>{
  const input=fixture();input.metrics.long.feesUsd=-.05;
  const result=ledgerCloseRebate(input.position,input.metrics,input.value,input.config)!;
  near(result.paidFeeRebateUsd,.03);near(result.estimatedFeeRebateUsd,.095);
  delete input.metrics.long.feesUsd;
  assert.equal(ledgerCloseRebate(input.position,input.metrics,input.value,input.config),undefined);
});

test('retained gross books use the current rebate config without borrowing current mark prices',()=>{
  const input=fixture();input.value.status='retained';input.metrics.long.markPrice=999;
  const result=ledgerCloseRebate(input.position,input.metrics,input.value,input.config)!;
  near(result.estimatedNetPnlAfterRebateUsd,.17);
  const changed=ledgerCloseRebate(input.position,input.metrics,input.value,{feeRebatePct:{gate:0,bitget:0}})!;
  assert.equal(changed.estimatedFeeRebateUsd,0);assert.equal(changed.estimatedNetPnlAfterRebateUsd,input.value.netPnlUsd);
});

test('pending books and mismatched full closing fee inputs cannot produce an adjusted closing estimate',()=>{
  const input=fixture();input.value.status='pending';
  assert.equal(ledgerCloseRebate(input.position,input.metrics,input.value,input.config),undefined);
  input.value.status='current';input.value.closingFeesUsd=.2;
  assert.equal(ledgerCloseRebate(input.position,input.metrics,input.value,input.config),undefined);
});

test('settings display explicit user percentages and identify them as calculation only',()=>{
  const config={...structuredClone(defaultConfig),feeRebatePct:{gate:70,bitget:50}},before=structuredClone(config);
  let calls=0;
  const html=renderToStaticMarkup(createElement(FeeRebateControls,{config,onChange:()=>{calls++;}}));
  assert.match(html,/aria-label="Gate 手续费返佣"[^>]*value="70"/);
  assert.match(html,/aria-label="Bitget 手续费返佣"[^>]*value="50"/);
  assert.match(html,/不读取返佣接口/);assert.match(html,/预计返佣不会写成实账收入/);
  assert.equal(calls,0);assert.deepEqual(config,before);
});
