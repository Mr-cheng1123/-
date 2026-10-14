import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {TradingOperation} from '../src/shared/trading-operations.js';
import {tradingOperationProgress} from '../web/src/trading-operation-progress.js';
import TradingOperationProgress from '../web/src/TradingOperationProgress.js';

const operation=(changes:Partial<TradingOperation>={}):TradingOperation=>({version:1,id:'operation-1',positionId:'position-1',base:'ARK',
  mode:'live',origin:'manual',kind:'manual-close',protocol:'ioc',state:'running',startedAt:1000,updatedAt:1500,windowEndsAt:31000,
  target:{long:10,short:10},confirmed:{long:0,short:0},remaining:{long:10,short:10},stages:{preparationStartedAt:1000},
  attempts:{preflightNotSent:0,zeroFill:0,unknown:0,submitted:0},...changes});

test('confirmed target without account confirmation displays await-account instead of complete',()=>{
  const row=operation({confirmed:{long:10,short:10},remaining:{long:0,short:0},stages:{firstFillObservedAt:1200,pairedAt:1300}}),before=structuredClone(row);
  const shown=tradingOperationProgress(row,2000)!;
  assert.equal(shown.state,'await-account');assert.equal(shown.reason,'成交已确认，等待账户数量核对');
  assert.equal(shown.quantityLabels.remaining,'多 0 / 空 0');assert.deepEqual(row,before);
  const bogus=tradingOperationProgress({...row,state:'complete',endedAt:1500},2000)!;
  assert.equal(bogus.state,'unknown');assert.doesNotMatch(bogus.title,/完整完成/);
});

test('only final target and subsequent account confirmation support a completed presentation',()=>{
  const row=operation({state:'complete',endedAt:1500,confirmed:{long:10,short:10},remaining:{long:0,short:0},
    stages:{firstFillObservedAt:1200,pairedAt:1300,accountConfirmedAt:1400}});
  assert.equal(tradingOperationProgress(row,2000)!.state,'complete');
  assert.equal(tradingOperationProgress({...row,stages:{pairedAt:1400,accountConfirmedAt:1300}},2000)!.state,'unknown');
  assert.equal(tradingOperationProgress({...row,attempts:{...row.attempts,unknown:1}},2000)!.state,'unknown');
});

test('unknown quantities, native results and illegal clocks are never shown as confirmed zero or successful closes',()=>{
  const row=operation({state:'unknown',confirmed:{long:null,short:5},remaining:{long:null,short:5},
    attempts:{preflightNotSent:0,zeroFill:0,unknown:1,submitted:2},waitReason:{code:'original-unknown',text:'原单仍在核对'}});
  const shown=tradingOperationProgress(row,2000)!;
  assert.equal(shown.state,'unknown');assert.equal(shown.quantityLabels.confirmed,'多 — / 空 5');assert.equal(shown.reason,'原单仍在核对');
  assert.equal(tradingOperationProgress({...row,updatedAt:2500},2000)!.state,'unknown');
  assert.equal(tradingOperationProgress({...row,updatedAt:2500},2000)!.quantityLabels.remaining,'多 — / 空 —');
  assert.equal(tradingOperationProgress({...row,stages:{submittedAt:2500}},2000)!.state,'unknown');
  assert.equal(tradingOperationProgress(row,Number.NaN)!.state,'unknown');
  assert.equal(tradingOperationProgress(undefined,2000),undefined);
});

test('the 30-second window ending remains distinct from completion, with partial quantities preserved',()=>{
  const row=operation({state:'partial',updatedAt:31000,confirmed:{long:8,short:8},remaining:{long:2,short:2},
    waitReason:{code:'window-ended',text:'本次处理窗口结束，剩余数量需要重新确认'}});
  const active=tradingOperationProgress(row,31000)!;
  assert.equal(active.state,'partial');assert.equal(active.window,'处理窗口已结束，剩余数量需确认');
  assert.equal(active.quantityLabels.remaining,'多 2 / 空 2');
  assert.equal(tradingOperationProgress({...row,windowEndsAt:500},31000)!.window,'处理窗口待核对');
  assert.match(tradingOperationProgress(operation(),2000)!.window,/处理窗口截止/);
  assert.doesNotMatch(tradingOperationProgress(operation(),2000)!.window,/29|剩余.*秒/,'No new ticking duration is introduced.');
});

test('holding progress renders bounded Chinese status with collapsed quantities and no trading controls or clock timer',()=>{
  const row=operation({state:'partial',confirmed:{long:8,short:8},remaining:{long:2,short:2},
    waitReason:{code:'local-only-diagnostic',text:'盘口更新后等待本批重新检查'}}),before=structuredClone(row);
  const html=renderToStaticMarkup(createElement(TradingOperationProgress,{operation:row,now:2000}));
  assert.match(html,/手动平仓 · 部分完成/);assert.match(html,/本次目标/);assert.match(html,/多 10 \/ 空 10/);
  assert.match(html,/多 8 \/ 空 8/);assert.match(html,/多 2 \/ 空 2/);assert.match(html,/当前账户持仓仍以交易所新鲜快照为准/);
  assert.doesNotMatch(html,/local-only-diagnostic|<button|<details open|剩余.*秒/);
  assert.deepEqual(row,before);assert.equal(renderToStaticMarkup(createElement(TradingOperationProgress,{now:2000})), '');
});

test('real tiny quantities remain nonzero and cannot masquerade as a filled target',()=>{
  const row=operation({target:{long:1e-18,short:1e-18},confirmed:{long:0,short:0},remaining:{long:0,short:0},stages:{pairedAt:1300}});
  const shown=tradingOperationProgress(row,2000)!;
  assert.equal(shown.state,'running');assert.match(shown.quantityLabels.target,/1\.00000000e-18/);
  assert.equal(shown.quantityLabels.confirmed,'多 0 / 空 0');
  const invocation=tradingOperationProgress(operation({stages:{submittedAt:1200},attempts:{preflightNotSent:0,zeroFill:0,unknown:0,submitted:1,pending:1}}),2000)!;
  assert.equal(invocation.reason,'已调用下单适配器，等待原单回执');
});
