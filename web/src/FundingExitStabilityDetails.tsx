import type {FundingExitStabilityDto,HoldingDecision} from '../../src/shared/types';
import {positionDate as date,positionTime as time} from './position-formatters';
import {FUNDING_LOSS_EXIT_EXPLANATION} from './holding-policy-presentation';

const statusLabels:Record<FundingExitStabilityDto['status'],string>={
  positive:'资金费优势仍为正',neutral:'零附近缓冲 · 继续观察',observing:'劣势观察中',
  confirmed:'持续劣势已确认', 'projection-wait':'远期推算待确认',unavailable:'稳定性证据待更新'
};
const finite=(value:number|undefined)=>typeof value==='number'&&Number.isFinite(value);
const bps=(value:number|undefined)=>finite(value)?`${value!>0?'+':''}${value!.toFixed(2)} bps`:'待建立';
const cash=(value:number|undefined)=>finite(value)?`${value!<0?'−':value!>0?'+':''}$${Math.abs(value!).toFixed(4)}`:'待读取';
const duration=(value:number)=>Number.isFinite(value)&&value>=0?`${(value/60_000).toFixed(1)} 分钟`:'待建立';

/** The evidence is shown inside the existing decision fold, independently of the close-value display. */
export default function FundingExitStabilityDetails({stability,monitoring=false,exitSignal}:{stability?:FundingExitStabilityDto;monitoring?:boolean;exitSignal?:HoldingDecision['exitSignal']}){
  const profitExit=!monitoring&&exitSignal==='profit';
  const profitReason='本轮按扣费净收益选择获利退出；正资金费及劣势持续确认不阻挡该退出。每批仍重新核验实际费用、现金和盘口。';
  if(!stability)return <div className="ledger-funding-stability" aria-label="资金费稳定性"><p>资金费稳定性待建立{monitoring?' · 仅监测，不触发策略平仓':''}</p>{profitExit&&<p>{profitReason}</p>}</div>;
  return <div className="ledger-note ledger-funding-stability" aria-label="资金费稳定性">
    <p><b>本轮资金费评估</b> · {statusLabels[stability.status]}{monitoring?' · 仅监测，不触发策略平仓':''}</p>
    <dl>
      <div><dt>当前整轮资金费优势</dt><dd>{bps(stability.latestBps)}</dd></div>
      <div><dt>观察样本中位数</dt><dd>{bps(stability.medianBps)}</dd></div>
      {finite(stability.neutralBandBps)&&<div><dt>负向劣势缓冲</dt><dd>{bps(stability.neutralBandBps)}</dd></div>}
      <div><dt>每腿仅下一次合计</dt><dd>{cash(stability.observedNextNetUsd)}</dd></div>
      <div><dt>更远结算推算合计</dt><dd>{cash(stability.projectedNetUsd)}</dd></div>
      <div><dt>独立双腿费率样本</dt><dd>{stability.sampleCount} / {stability.requiredSamples} 个</dd></div>
      <div><dt>连续观察覆盖时长</dt><dd>{duration(stability.observedSpanMs)} / {duration(stability.requiredSpanMs)}</dd></div>
      <div><dt>下次预计付款</dt><dd>{stability.nextPaymentAt?date(stability.nextPaymentAt):'未读取到下次付款时刻'}</dd></div>
      <div><dt>最近费率样本</dt><dd>{stability.lastObservedAt?time(stability.lastObservedAt):'等待双腿新费率样本'}</dd></div>
    </dl>
    <p>{profitExit?profitReason:stability.reason}</p>
    <p>每腿仅下一次使用当前费率，结算前仍可能变化；更远轮次重复使用当前费率推算，不能当作已确定付款或到账收入。盘口更新不会重复计入费率样本。{monitoring?'这里展示监测或原判断记录，当前仓位未由自动策略接管。':'资金费劣势确认用于受控亏损退出；盈利退出须满足配置的扣费净收益门槛，达标后优先分批处理。'}</p>
    {!monitoring&&!profitExit&&<p>{FUNDING_LOSS_EXIT_EXPLANATION}</p>}
  </div>;
}
