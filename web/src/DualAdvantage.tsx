import type { AppConfig, Opportunity } from '../../src/shared/types';
import type { FundingCandidateView } from '../../src/shared/funding-opportunities';
import { candidateProfit } from './candidate-profit';
import { entryPolicy, iocEdgeExceeds, roundsEstimate } from './entry-policy';
import {entryBatchPresentation} from './entry-batch-presentation';
import type {CandidatePricePresentation} from './candidate-price-reference';
import {AUTOMATIC_ENTRY_RULE} from './automatic-entry-presentation';
import { bookCostMoney, bookCostScope, bookPrice, opportunityBookLoss } from './book-cost-presentation';
import './dual-advantage.css';
import {feeRebatePct} from '../../src/shared/fee-rebates';

const usd=(n:number|null|undefined)=>n===null||n===undefined||!Number.isFinite(n)?'—':`${n>0?'+':n<0?'−':''}$${Math.abs(n).toFixed(2)}`;
const bps=(n:number|null|undefined)=>n===null||n===undefined||!Number.isFinite(n)?'—':`${n>0?'+':''}${n.toFixed(2)} bps`;
/** Both policies count the four trading fees once; funding mode uses current books without waiting for history. */
export function DualAdvantage({opportunity,candidate,config,pricePresentation}:{opportunity?:Opportunity;candidate?:FundingCandidateView;config:AppConfig;pricePresentation?:CandidatePricePresentation}){
  const execution=opportunity??candidate?.execution;
  const batch=pricePresentation?pricePresentation.batch:entryBatchPresentation(execution,config.orderNotionalUsd);
  const spread=execution?.spreadAdvantage,ready=spread?.status==='ready';
  const bookLoss=opportunityBookLoss(execution);
  const fundingPolicy=entryPolicy(config,execution)==='funding';
  const alignedPolicy=entryPolicy(config,execution)==='aligned';
  const profit=candidate?candidateProfit(candidate,{requireNative:config.mode==='live',entryPolicy:config.entryPolicy}):alignedPolicy&&execution?candidateProfit({execution} as FundingCandidateView,{requireNative:config.mode==='live',entryPolicy:config.entryPolicy}):undefined;
  const feesSource=profit?.feesSource??execution?.feesSource;
  const feeReady=config.mode!=='live'||feesSource==='exchange'||feesSource==='reference';
  const funding=profit?.fundingUsd??execution?.expectedFundingUsd;
  const fees=profit?profit.feesUsd:feeReady?execution?.feesUsd:null;
  const showRebates=feeRebatePct('gate',config)>0||feeRebatePct('bitget',config)>0;
  const combined=profit?profit.combinedNetUsd:ready&&feeReady?execution?.combinedExpectedNetUsd:null;
  const fundingPass=funding!=null&&funding>0;
  const spreadPass=ready&&spread!.spreadAdvantageBps!>0;
  const totalPass=ready&&combined!=null&&combined>config.minCombinedNetUsd;
  const minimumIocEdge=config.minEntryIocEdgeBps??0;
  const priceEdge=pricePresentation?pricePresentation.edgeBps:execution?.entryPriceEdgeBps;
  const iocEdge=pricePresentation?pricePresentation.iocEdgeBps:execution?.entryLimitPriceEdgeBps;
  const currentExecution=!pricePresentation||pricePresentation.kind==='batch';
  const iocPass=iocEdgeExceeds(iocEdge,minimumIocEdge);
  return <section className="dual-advantage" aria-label="入场规则的三个数字">
    <h3>{alignedPolicy?`手动入场规则：资金费为正 + 实际 IOC 价格优势 > ${minimumIocEdge} bps`:fundingPolicy?'手动入场规则：资金费为正 + 扣手续费与盘口开平损耗后达标':'手动入场规则：资金费为正 + 价差有优势 + 合计扣费后达标'}</h3>
    <p data-testid="automatic-entry-rule">{AUTOMATIC_ENTRY_RULE}</p>
    {batch&&<p className="entry-batch-plan"><b>{batch.label}</b><br/>{batch.prices}</p>}
    <div className="dual-signal-grid">
      <div className={fundingPass?'dual-pass':'dual-wait'}><span>{batch?'完整目标预计资金费':'预计资金费'}</span><strong>{usd(funding)}</strong><small>{batch?'全部目标成交后的条件预估 · ':''}{fundingPass?'资金费为正':'等待资金费为正'}</small></div>
      {alignedPolicy?<div className={!currentExecution&&priceEdge!=null?'dual-neutral':(priceEdge??0)>0?'dual-pass':'dual-wait'}><span>{pricePresentation?pricePresentation.label:batch?'本批对手价1价格优势':'开仓价格优势'}</span><strong>{bps(priceEdge)}</strong><small>{pricePresentation&&!currentExecution?pricePresentation.reason:batch?'本批空腿买一 − 多腿卖一，须为正':'开空成交均价 − 开多成交均价，须为正'}</small></div>:fundingPolicy?<div className={bookLoss!==null?'dual-neutral':'dual-wait'}><span>盘口开平损耗</span><strong>{bookCostMoney(bookLoss)}</strong><small>{bookCostScope(execution)} · 基差不变估计</small></div>:<div className={spreadPass?'dual-pass':'dual-wait'}><span>价差优势（开仓价差 − 历史退出价差）</span><strong>{ready?bps(spread!.spreadAdvantageBps):'—'}</strong><small>{ready?'须大于 0 bps':'积累历史退出价差'}</small></div>}
      {alignedPolicy?<div className={iocPass?'dual-pass':'dual-wait'}><span>{batch?'本批 IOC 限价价格优势':'实际 IOC 限价价格优势'}</span><strong>{!currentExecution?'待核验':bps(iocEdge)}</strong><small>{batch?'按本批实际 IOC 委托限价核对':'按最坏允许开仓价格核对'}，须大于 {minimumIocEdge} bps（{(minimumIocEdge/100).toFixed(2)}%）</small></div>:<div className={totalPass?'dual-pass':'dual-wait'}><span>合计净收益</span><strong>{combined==null?fundingPolicy?'待核验盘口':'待计算价差':usd(combined)}</strong><small>{fundingPolicy?'资金费 − 盘口开平损耗 − 四笔手续费':'资金费 + 预计价差收益 − 四笔手续费'}（只扣一次），须高于 {usd(config.minCombinedNetUsd)}</small></div>}
    </div>
    <dl>
      <div><dt>{alignedPolicy&&pricePresentation?pricePresentation.label:batch?'完整目标盘口开仓价差（条件预估）':'实际盘口开仓价差'}</dt><dd>{bps(alignedPolicy&&pricePresentation?priceEdge:spread?.entrySpreadBps)}</dd></div>
      {alignedPolicy&&<><div><dt>{batch?'本批 IOC 实际限价':!currentExecution?'参考多腿卖一 / 空腿买一':'开多 / 开空盘口均价'}</dt><dd>{batch?batch.prices:!currentExecution?pricePresentation?.reference.status==='ready'?`${bookPrice(pricePresentation.reference.longAskPrice)} / ${bookPrice(pricePresentation.reference.shortBidPrice)}`:'待同步':`${bookPrice(spread?.longEntryPrice)} / ${bookPrice(spread?.shortEntryPrice)}`}</dd></div>
        <div><dt>{batch?'完整目标单轮净收益（条件参考）':'单轮预计净收益（仅参考）'}</dt><dd>{usd(combined)}</dd></div>
        <div><dt>按本轮假设预计回本</dt><dd>{feeReady?roundsEstimate(execution?.breakEvenRounds):'手续费待计算'}</dd></div></>}
      {!alignedPolicy&&<div><dt>{fundingPolicy?'当前盘口退出价差':'历史退出价差中位数'}</dt><dd>{bps(spread?.expectedExitSpreadBps)}</dd></div>}
      {(!fundingPolicy&&!alignedPolicy)&&<div><dt>预计价差毛收益</dt><dd>{ready?usd(spread?.expectedSpreadPnlUsd):'待计算'}</dd></div>}
      <div><dt>{showRebates?'四笔净手续费合计（返佣后估算）':batch?'完整目标四笔手续费合计':'四笔手续费合计'}</dt><dd>{fees==null?'手续费待计算':usd(-fees)}</dd></div>
      {fundingPolicy&&<div><dt>实际 IOC 限价净收益</dt><dd>{usd(feeReady?execution?.entryLimitNetUsd:null)}</dd></div>}
      {!fundingPolicy&&!alignedPolicy&&<div><dt>历史有效观察</dt><dd>{spread?.samples??0} / {config.spreadMinSamples} 个 · {Math.floor(spread?.observedSpanSec??0)} / {config.spreadMinSpanSec} 秒</dd></div>}
      {(fundingPolicy||alignedPolicy)&&execution?.historicalSpreadAdvantage&&<div><dt>历史价差参考（不影响入场）</dt><dd>{execution.historicalSpreadAdvantage.status==='ready'?bps(execution.historicalSpreadAdvantage.expectedExitSpreadBps):`采样中 ${execution.historicalSpreadAdvantage.samples} 个`}</dd></div>}
    </dl>
    {batch&&<p>{batch.forecastNote}</p>}
    {showRebates&&<p>费用与净收益已计入配置返佣：Gate {feeRebatePct('gate',config)}% / Bitget {feeRebatePct('bitget',config)}%。返佣仅估算，未核对到账；原账户费率核验保留。</p>}
    <p>{alignedPolicy?`单轮参考收益＝资金费－四笔手续费，不计盘口损耗与未实现价差。手动开仓要求预计资金费为正且实际 IOC 价格优势超过 ${minimumIocEdge} bps，可持有多轮；${batch?'每批重核当前对手价与实际 IOC 限价，条件变化即停止补仓，已配对数量继续管理。':''}单轮净收益为负不单独阻挡手动开仓；自动开仓另按两条路径筛选。预计回本轮数假设后续费率和结算结构重复本轮；实际收益按成交、手续费与资金费账单核算。`:fundingPolicy?'按基差不变估计，使用当前盘口开仓和平仓的成交价格计算损耗；不等待历史样本。实际持有期间基差仍会变化。':spread?.reason??(ready?'退出价差采用历史估计，仍可能扩大；预计收益尚未实现。':'等待双腿盘口核验。')} 两腿按相同币数量对冲。{feesSource==='reference'?' 手续费按官方本地参考费率估算，下单前核对账户实际费率。':feesSource==='exchange'?' 手续费按交易所账户实际费率估算。':''}</p>
  </section>;
}
