import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {Position} from '../src/shared/types.js';
import PositionExitNotes from '../web/src/PositionExitNotes.js';
import {positionExitReasonKind} from '../web/src/position-exit-presentation.js';

function fixture():Position {
  return {id:'owned',base:'EXAMPLE',mode:'live',status:'open',entryPolicy:'aligned',holdMode:'adaptive',openedAt:1000,plannedExitAt:9000,
    long:{exchange:'gate',symbol:'EXAMPLE/USDT:USDT',side:'long',quantity:60,entryPrice:1,markPrice:1,feesUsd:.1,liquidationDistancePct:50},
    short:{exchange:'bybit',symbol:'EXAMPLE/USDT:USDT',side:'short',quantity:60,entryPrice:1,markPrice:1,feesUsd:.1,liquidationDistancePct:50},
    fundingUsd:0,feesUsd:.2,transferCostUsd:0,spreadPnlUsd:0,realizedSpreadPnlUsd:0,netPnlUsd:-.2,deltaUsd:0,fundingEvents:[],riskReasons:[],
    holdDecision:{action:'hold',reason:'当前资金费恢复优势，继续持有',expectedFundingUsd:.2,incrementalCostUsd:0,expectedNetUsd:.2,nextReviewAt:5000,targetFundingTime:9000}};
}
const render=(position:Position)=>renderToStaticMarkup(createElement(PositionExitNotes,{position}));

test('a suspended economic trigger is visibly historical while current holdings continue',()=>{
  const position=fixture();
  position.automaticCloseHistory=[{requestedAt:2000,attemptedAt:2100,suspendedAt:3000,reason:'旧资金费劣势触发',
    suspensionReason:'资金费恢复优势，保留等量余仓',longQuantity:60,shortQuantity:60,pricing:'best-opposite'}];
  const before=structuredClone(position),html=render(position);
  assert.match(html,/上次自动减仓 · 已暂停/);assert.match(html,/原触发原因：旧资金费劣势触发/);
  assert.match(html,/停止原因：资金费恢复优势/);assert.doesNotMatch(html,/本次退出触发原因/);
  assert.equal(positionExitReasonKind(position),undefined);assert.deepEqual(position,before);
});

test('a recovered signal with an unfinished intent preserves the original trigger without claiming current economics',()=>{
  const position=fixture();position.status='closing';position.closeRequestedAt=2000;position.closeProfitRequired=true;position.closeReason='旧资金费劣势触发';
  const html=render(position);
  assert.match(html,/本次退出原触发 · 待复核/);assert.match(html,/原订单状态/);
  assert.doesNotMatch(html,/上次自动减仓 · 已暂停/,'Only the backend may confirm a suspended intent.');
  assert.doesNotMatch(html,/本次退出触发原因/);
});

test('active manual exits and completed exits retain their true reasons; unrelated old notes remain history',()=>{
  const position=fixture();position.closeReason='手动平仓';position.closeRequestedAt=2000;position.closeProfitRequired=false;position.status='closing';
  assert.match(render(position),/本次退出触发原因：手动平仓/);
  position.status='closed';assert.match(render(position),/退出原因：手动平仓/);
  position.status='open';delete position.closeRequestedAt;delete position.closeProfitRequired;
  position.closeReason='历史开仓补单未成交';
  const html=render(position);assert.match(html,/历史执行说明/);assert.match(html,/历史开仓补单未成交/);assert.doesNotMatch(html,/退出原因/);
});
