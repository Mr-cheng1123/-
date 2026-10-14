import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import FundingExitStabilityDetails from '../web/src/FundingExitStabilityDetails.js';
import FundingLossExitDetails from '../web/src/FundingLossExitDetails.js';
import type {FundingExitStabilityDto,FundingLossExit,HoldingDecision} from '../src/shared/types.js';

const evidence=(changes:Partial<FundingExitStabilityDto>={}):FundingExitStabilityDto=>({
  status:'projection-wait',reason:'当前仅远期重复项把整轮拖负，先观察，不按瞬时预测退出',
  latestBps:-3.54,medianBps:-3.60,observedNextNetUsd:.310899,projectedNetUsd:-.345036,
  neutralBandBps:2,sampleCount:7,requiredSamples:5,observedSpanMs:240_000,requiredSpanMs:600_000,
  nextPaymentAt:Date.parse('2026-10-03T18:00:00+08:00'),lastObservedAt:Date.parse('2026-10-03T17:10:37+08:00'),
  ...changes
});
const render=(stability?:FundingExitStabilityDto,monitoring=false,exitSignal?:HoldingDecision['exitSignal'])=>renderToStaticMarkup(createElement(FundingExitStabilityDetails,{stability,monitoring,exitSignal}));

test('MANA-like projected adversity is distinguished from the positive next event estimate and never presented as booked cash',()=>{
  const markup=render(evidence());
  assert.match(markup,/远期推算待确认/);
  assert.match(markup,/每腿仅下一次合计.*\+\$0\.3109/);
  assert.match(markup,/更远结算推算合计.*−\$0\.3450/);
  assert.match(markup,/7 \/ 5 个/);assert.match(markup,/4\.0 分钟 \/ 10\.0 分钟/);
  assert.match(markup,/当前整轮资金费优势.*-3\.54 bps/);
  assert.match(markup,/不能当作已确定付款或到账收入/);
  assert.match(markup,/盈利退出须满足配置的扣费净收益门槛/);
  assert.match(markup,/受控亏损退出比较未来预计净资金费支出与当前平仓手续费、盘口损耗及 \$0\.10 余量/);
  assert.match(markup,/既有亏损不阻挡退出/);
  assert.match(markup,/下一次实际结算为付款且在结算前 5 分钟内/);
  assert.match(markup,/每批按实际数量重新核验/);
  assert.match(markup,/\$0\.10 为整仓余量，分批按数量比例分摊/);
  assert.match(markup,/未来费率和后续成交价格可能变化/);
  assert.doesNotMatch(markup,/决定退出|自动平仓已通过|已到账 \+\$0\.3109/);
});

test('missing stability evidence and missing individual cash fields are unknown rather than invented zero confirmations',()=>{
  const empty=render();
  assert.match(empty,/资金费稳定性待建立/);
  assert.doesNotMatch(empty,/已确认|0 \/ 5|\$0\.0000|中位数/);
  const partial=render(evidence({status:'unavailable',latestBps:undefined,medianBps:NaN,observedNextNetUsd:undefined,projectedNetUsd:Infinity}));
  assert.match(partial,/稳定性证据待更新/);assert.match(partial,/待读取/);assert.match(partial,/待建立/);
  assert.doesNotMatch(partial,/NaN|Infinity|\$0\.0000|持续劣势已确认/);
});

test('confirmed historical evidence on an unmanaged position cannot claim strategy ownership or authorize a close',()=>{
  const markup=render(evidence({status:'confirmed',reason:'原观察期间持续劣势已确认'}),true);
  assert.match(markup,/仅监测，不触发策略平仓/);
  assert.match(markup,/监测或原判断记录，当前仓位未由自动策略接管/);
  assert.doesNotMatch(markup,/决定退出|自动平仓已通过|受控亏损退出比较|既有亏损不阻挡退出/);
  assert.match(render(undefined,true),/资金费稳定性待建立 · 仅监测，不触发策略平仓/);
});

test('neutral and positive funding evidence describes funding independently of the current profit decision',()=>{
  assert.match(render(evidence({status:'neutral',latestBps:-.43,medianBps:-.21})),/零附近缓冲 · 继续观察/);
  assert.match(render(evidence({status:'positive',latestBps:.43,medianBps:.21})),/资金费优势仍为正/);
  assert.doesNotMatch(render(evidence({status:'neutral'})),/资金费为零或负数.*立即退出/);
});

test('profit decision takes precedence over positive or unconfirmed funding without presenting a contradictory hold reason',()=>{
  for(const stability of [
    evidence({status:'positive',reason:'最新资金费合计恢复为正，继续持有，已清除劣势退出确认'}),
    evidence({status:'observing',reason:'劣势持续跨度不足，继续持有并观察'}),
    evidence({status:'projection-wait',reason:'等待远期劣势持续确认，继续持有'})
  ]){
    const markup=render(stability,false,'profit');
    assert.match(markup,/本轮资金费评估/);assert.match(markup,/本轮按扣费净收益选择获利退出/);
    assert.match(markup,/正资金费及劣势持续确认不阻挡该退出/);
    assert.match(markup,/每批仍重新核验实际费用、现金和盘口/);
    assert.doesNotMatch(markup,/继续持有|受控亏损退出比较/);
  }
  const noFundingEvidence=render(undefined,false,'profit');
  assert.match(noFundingEvidence,/资金费稳定性待建立/);
  assert.match(noFundingEvidence,/本轮按扣费净收益选择获利退出/);
  assert.doesNotMatch(render(evidence({status:'positive'}),true,'profit'),/本轮按扣费净收益选择获利退出/,
    'unmanaged monitoring never adopts a stored profit signal as a live decision');
});

test('controlled loss comparisons display actual batch costs and scaled margin without promising whole-position savings',()=>{
  const estimate:FundingLossExit={quantity:20,expectedFundingLossUsd:.061,closingFeesUsd:.005,
    spreadCostUsd:.002,exitCostAllowanceUsd:.007,minimumSavingsUsd:.01,expectedSavingsUsd:.054,
    nextPaymentAt:Date.parse('2026-10-04T01:00:00+08:00'),paymentWindowOpen:true};
  const markup=renderToStaticMarkup(createElement(FundingLossExitDetails,{estimate}));
  assert.match(markup,/本批双腿共同可平数量.*20/);
  assert.match(markup,/本批预计净资金费支出.*\$0\.0610/);
  assert.match(markup,/本批退出成本合计.*\$0\.0070/);
  assert.match(markup,/本批最低余量.*\$0\.0100/);
  assert.match(markup,/预计支出扣退出成本后余量.*\$0\.0540/);
  assert.match(markup,/已进入结算前 5 分钟/);
  assert.match(markup,/最低余量按本批数量分摊整仓 \$0\.10/);
  assert.match(markup,/表中余量不保证实际节省或盈利/);
  assert.match(markup,/每批提交前按最新盘口和实际限价重新核验/);
  assert.doesNotMatch(markup,/已节省|整仓预计节省|自动平仓已通过/);
  const pending=renderToStaticMarkup(createElement(FundingLossExitDetails,{estimate:{...estimate,
    expectedFundingLossUsd:NaN,expectedSavingsUsd:Infinity,paymentWindowOpen:false}}));
  assert.match(pending,/等待下一次实际付款前 5 分钟/);
  assert.match(pending,/待核验/);
  assert.doesNotMatch(pending,/NaN|Infinity|已进入结算前/);
});
