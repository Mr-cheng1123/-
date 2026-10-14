import {useEffect,useMemo,useState,type ReactNode} from 'react';
import {ArrowUpRight,ShieldAlert,Wallet} from 'lucide-react';
import type {AppState,ExchangeId,Position} from '../../src/shared/types';
import {LivePositions} from './LivePositions';
import {positionCloseAction,currentCloseOrdersUnknown,currentCloseOperationInFlight} from './position-close-action';
import {positionCloseProgressLabel} from './position-exit-presentation';
import PositionExitNotes from './PositionExitNotes';
import {ledgerPositionMetrics,type LedgerPositionMetrics} from './ledger-position-metrics';
import {ledgerCashPresentation} from './ledger-cash-presentation';
import {ledgerAccountProjection} from './ledger-account-projection';
import {ledgerHoldingEstimate,type LedgerHoldingEstimate} from './ledger-holding-estimate';
import {ledgerCloseValue,ledgerCloseValueBreakEvenLabel,ledgerCloseValueDeadline,updateLedgerCloseValueCache,type LedgerCloseValueCache} from './ledger-close-value';
import {ledgerCloseRebate} from './ledger-close-rebate';
import LedgerClosedNet from './LedgerClosedNet';
import {feeRebatePct} from '../../src/shared/fee-rebates';
import {positionMoney as money,positionNumber as num,positionPrice as price,positionDate as date,positionTime as time,positionLiquidationLabel as liquidationObservationLabel} from './position-formatters';
import {PositionCountdown,usePositionDisplayClock} from './position-display-clock';
import FundingExitStabilityDetails from './FundingExitStabilityDetails';
import FundingLossExitDetails from './FundingLossExitDetails';
import {FUNDING_LOSS_EXIT_EXPLANATION} from './holding-policy-presentation';
import './position-ledger.css';

const venues:Record<ExchangeId,string>={binance:'Binance',bybit:'Bybit',okx:'OKX',gate:'Gate',bitget:'Bitget'};
const tone=(value:number|undefined)=>value===undefined?'':value<0?'negative':value>0?'positive':'';
function Badge({children,kind='neutral'}:{children:ReactNode;kind?:'neutral'|'green'|'orange'}){return <span className={`badge ${kind}`}>{children}</span>;}
const entryLabel=(p:Position)=>p.manualCloseOnly?'手动平仓记录':p.entryPolicy==='aligned'?'资金费＋价格同向':p.entryPolicy==='dual'?'双优势':p.entryPolicy==='funding'?'资金费覆盖成本':p.mode==='paper'&&(p.feeOnly||p.paperFeeOnly)?'仅手续费预算':'历史策略记录';
const feeSourceLabel=(leg:LedgerHoldingEstimate['legs'][number])=>leg.takerFeeSource==='exchange'?
  `交易所账户读取 ${time(leg.takerFeeAt)}`:leg.takerFeeSource==='reference'?
    leg.takerFeeReferenceSource==='account-reference'?`本地参考 · 原账户读数 ${time(leg.takerFeeReferenceAt)} · 按需实盘核对`:
      '本地参考 · 官方基准 · 按需实盘核对':leg.takerFeeSource==='config'?'模拟配置费率':'费率待核验';

function HoldDecision({position,estimate,external,executionLabel}:{position:Position;estimate:LedgerHoldingEstimate;external:boolean;executionLabel?:string}){
  if(position.status==='closed'||position.accountClosure)return null;
  const decision=position.holdDecision;
  const monitoring=external||position.status==='attention';
  const hasReceipt=estimate.fundingEvents?.some(event=>event.netUsd>1e-10);
  return <div className="hold-decision"><div className="hold-decision-heading"><Badge kind={executionLabel?'orange':monitoring?'neutral':decision?.action==='hold'?'green':decision?.action==='close'?'orange':'neutral'}>{executionLabel??(external?'外部持仓 · 仅监测':monitoring?'等待管理核验':decision?.action==='hold'?'继续持有':decision?.action==='close'?decision.exitSignal==='funding-loss'?'避免费损退出':'决定退出':'等待检查')}</Badge></div>
    <div className="ledger-forecast-line"><span>最近一次结算</span><b>{estimate.nextFundingTime?date(estimate.nextFundingTime):'结算时钟待更新'}</b></div>
    <div className="ledger-forecast-line"><span>该次预计净资金费</span><b className={tone(estimate.nextFundingUsd)}>{estimate.nextFundingUsd===undefined?'行情同步中':money(estimate.nextFundingUsd,true)}</b></div>
    <div className="ledger-forecast-line"><span>双方本轮覆盖截止</span><b>{estimate.targetFundingTime?date(estimate.targetFundingTime):'结算时钟待更新'}</b></div>
    <div className="ledger-forecast-line"><span>本轮预计资金费合计</span><b className={tone(estimate.fundingUsd)}>{estimate.fundingUsd===undefined?'行情同步中':money(estimate.fundingUsd,true)}</b></div>
    {estimate.fundingUsd!==undefined&&<div className="ledger-forecast-line"><span>本轮结算次数</span><b>多 {estimate.longFundingCount??'—'} 次 / 空 {estimate.shortFundingCount??'—'} 次</b></div>}
    {estimate.asynchronous&&<p className={`ledger-funding-timing ${estimate.nextFundingUsd!==undefined&&estimate.nextFundingUsd<0?'pay-first':''}`}>{estimate.nextFundingUsd!==undefined&&estimate.nextFundingUsd<0?<>异步结算 · {hasReceipt?'先付后收':'先支付资金费'}。最近该次预计支付 {money(-estimate.nextFundingUsd)}；{estimate.firstPositiveFundingTime?<>本轮资金费累计预计转正时刻 {date(estimate.firstPositiveFundingTime)}。</>:'本轮累计资金费预计未转正。'}</>:'异步结算：最近单次费用与双方本轮合计分别计算。'}</p>}
    {estimate.legs.map(leg=><div className="ledger-rate-leg" key={`${leg.exchange}-${leg.side}`}><b>{leg.side==='long'?'多':'空'} {venues[leg.exchange]} · {leg.rate===undefined?'费率待读取':`${(leg.rate*100).toFixed(4)}%`} / {leg.intervalHours??'—'}h</b><span>{leg.nextFundingTime?<>结算 {time(leg.nextFundingTime)} · 剩余 <PositionCountdown timestamp={leg.nextFundingTime}/></>:'结算时钟待更新'}</span><span>资金费数据同步 {leg.observedAt?time(leg.observedAt):'等待新行情'}</span></div>)}
    <div className="ledger-forecast-line"><span>{monitoring?'下次监测估算':'下次评估'}</span><b>{time(estimate.nextReviewAt)}</b></div>
    <p>{external?estimate.fundingUsd===undefined?estimate.fundingReason:estimate.fundingUsd>0?'双方本轮资金费合计仍有优势；这里持续监测，不会自动处理未接管仓位。':'双方本轮资金费合计优势已弱化或为负；退出需比较后续预计支出与当前平仓成本，这里只监测，不自动平仓。':monitoring?'正在复核原订单与剩余数量；自动退出是否继续，以本次管理核验结果和当前执行权限为准。':decision?.reason??'等待首次续持评估；逐次费用预测仍按实际持仓持续显示。'}</p>
    {!monitoring&&decision?.action==='close'&&decision.exitSignal==='funding-loss'&&<p className="cell-caption">{FUNDING_LOSS_EXIT_EXPLANATION}</p>}
    <details><summary>本轮判断明细 / 逐次结算</summary><dl><div><dt>最近单次资金费</dt><dd>{money(estimate.nextFundingUsd,true)}</dd></div><div><dt>本轮预计资金费合计</dt><dd>{money(estimate.fundingUsd,true)}</dd></div><div><dt>覆盖结算次数</dt><dd>多 {estimate.longFundingCount??'—'} / 空 {estimate.shortFundingCount??'—'}</dd></div><div><dt>本轮预测截止</dt><dd>{estimate.targetFundingTime?date(estimate.targetFundingTime):'等待有效时钟'}</dd></div>{estimate.maxFundingDrawdownUsd!==undefined&&estimate.maxFundingDrawdownUsd>0&&<div><dt>本轮累计资金费最低值</dt><dd className="negative">{money(-estimate.maxFundingDrawdownUsd,true)}</dd></div>}<div><dt>预计平仓手续费</dt><dd>{money(estimate.closingFeesUsd)} · {estimate.closingFeeSource==='exchange'?'交易所合约费率':estimate.closingFeeSource==='reference'?'本地参考 · 按需实盘核对':estimate.closingFeeSource==='config'?'模拟配置费率':'费率待核验'}</dd></div></dl>
      {position.entryPolicy==='aligned'&&position.holdMode==='adaptive'&&<FundingExitStabilityDetails stability={decision?.fundingExitStability} monitoring={monitoring} exitSignal={decision?.action==='close'?decision.exitSignal:undefined}/>}
      {!monitoring&&decision?.fundingLossExit&&<FundingLossExitDetails estimate={decision.fundingLossExit}/>}
      {estimate.fundingEvents?.length?<div className="ledger-funding-events"><table aria-label="本轮逐次资金费预测"><thead><tr><th>结算时间</th><th>多腿</th><th>空腿</th><th>该次合计</th><th>累计</th></tr></thead><tbody>{estimate.fundingEvents.map(event=><tr key={event.time}><td>{date(event.time)}{event.projected&&<small>当前费率推算</small>}</td><td className={tone(event.longUsd)}>{event.longCount?money(event.longUsd,true):'本次不结算'}</td><td className={tone(event.shortUsd)}>{event.shortCount?money(event.shortUsd,true):'本次不结算'}</td><td className={tone(event.netUsd)}>{money(event.netUsd,true)}</td><td className={tone(event.cumulativeUsd)}>{money(event.cumulativeUsd,true)}</td></tr>)}</tbody></table></div>:<p>{estimate.fundingReason??'等待有效费率和结算时钟，暂不推算逐次资金费。'}</p>}
      {estimate.legs.map(leg=><p key={`${leg.exchange}-${leg.side}-fee`}>{leg.side==='long'?'多':'空'} {venues[leg.exchange]} 吃单手续费：{leg.takerFeeRate===undefined?'待核验':`${(leg.takerFeeRate*100).toFixed(4)}% · ${feeSourceLabel(leg)}`}</p>)}<p>最近单次只计算该时刻结算的合约；本轮合计覆盖至两腿下一结算均完成，不含平仓等待期间的后续资金费。未来费率和标记价仍可能变化；重复结算按当前值推算，预计收入未计入到账收益或回本。预计平仓手续费可使用本地参考；实际开仓和平仓时按需核对具体合约账户费率。下次监测是刷新计划，资金费结算另按交易所时钟。</p></details></div>;
}

export default function PositionLedger({state,onClose,preview=false,onMore,pendingPositionIds,pendingCloseBases}:{state:AppState;onClose:(position:Position)=>void;preview?:boolean;onMore:()=>void;pendingPositionIds?:ReadonlySet<string>;pendingCloseBases?:ReadonlySet<string>}){
  const [showClosed,setShowClosed]=useState(false);
  const [closeValueCache,setCloseValueCache]=useState<ReadonlyMap<string,LedgerCloseValueCache>>(()=>new Map());
  const now=usePositionDisplayClock(state,ledgerCloseValueDeadline(closeValueCache));
  const {allPositions,externalIds,historyOnlyIds,metrics,estimates}=useMemo(()=>{
    const displayRecords=ledgerAccountProjection(state,now),allPositions=displayRecords.map(record=>record.position);
    const externalIds=new Set(displayRecords.filter(record=>record.origin==='account').map(record=>record.position.id));
    const historyOnlyIds=new Set(displayRecords.filter(record=>record.historyOnly).map(record=>record.position.id));
    const metrics=new Map(allPositions.map(p=>[p.id,ledgerPositionMetrics(historyOnlyIds.has(p.id)?{...p,status:'closed'}:p,state.livePortfolio,now)]));
    const estimates=new Map(allPositions.map(p=>[p.id,ledgerHoldingEstimate(p,metrics.get(p.id)!,state,now)]));
    return {allPositions,externalIds,historyOnlyIds,metrics,estimates};
  },[state,now]);
  const closeValues=useMemo(()=>new Map(allPositions.map(position=>[position.id,
    ledgerCloseValue(position,metrics.get(position.id)!,estimates.get(position.id)!,state,now,closeValueCache.get(position.id))])),
    [allPositions,metrics,estimates,state,now,closeValueCache]);
  useEffect(()=>{setCloseValueCache(previous=>updateLedgerCloseValueCache(previous,closeValues));},[closeValues]);
  const isHistorical=(p:Position)=>historyOnlyIds.has(p.id)||p.status==='closed'||metrics.get(p.id)!.observation.status==='account_flat';
  const paired=(p:Position)=>['paired','imbalanced'].includes(metrics.get(p.id)!.holding);
  const positions=allPositions.filter(p=>showClosed||!isHistorical(p)).sort((a,b)=>
    Number(isHistorical(a))-Number(isHistorical(b))||Number(paired(b))-Number(paired(a))||a.base.localeCompare(b.base)||b.openedAt-a.openedAt);
  const historicalCount=allPositions.filter(isHistorical).length;
  const showRebates=feeRebatePct('gate',state.config)>0||feeRebatePct('bitget',state.config)>0;
  const unknownLeg=(p:Position,exchange:ExchangeId)=>{
    if(state.unconfirmedOrders!==undefined)return state.unconfirmedOrders.some(order=>order.positionId===p.id&&order.exchange===exchange);
    const reasons=p.riskReasons.filter(reason=>/订单状态未知|未确认订单|等待.*对账/.test(reason));
    const specific=reasons.filter(reason=>Object.keys(venues).some(venue=>reason.includes(venue)));
    return p.status==='attention'&&(specific.length?specific.some(reason=>reason.includes(exchange)):reasons.length>0);
  };
  const quantity=(p:Position,side:'long'|'short')=>{
    const leg=p[side],m=metrics.get(p.id)!;
    if(historyOnlyIds.has(p.id))return <span className={side==='short'?'cell-caption':undefined}>{side==='long'?'多':'空'} {venues[leg.exchange]}：历史成交 {num(leg.quantity)}<small className="cell-caption">原持仓周期记录 · 不关联当前新仓</small></span>;
    if(externalIds.has(p.id))return <span className={side==='short'?'cell-caption':undefined}>{side==='long'?'多':'空'} {venues[leg.exchange]}：{m[side].quantity===undefined?'待读取':num(m[side].quantity!)}<small className="cell-caption">当前真实账户数量 · 无原策略成交记录</small></span>;
    if(p.accountClosure)return <span className={side==='short'?'cell-caption':undefined}>{side==='long'?'多':'空'} {venues[leg.exchange]}：历史成交 {num(leg.quantity)}<small className="cell-caption">已归档记录；不关联后续新仓{unknownLeg(p,leg.exchange)?' · 原订单待核对':''}</small></span>;
    if(p.mode==='live'&&m.source==='account')return <span className={side==='short'?'cell-caption':undefined}>{side==='long'?'多':'空'} {venues[leg.exchange]}：{m[side].quantity===undefined?'待读取':num(m[side].quantity!)}<small className="cell-caption">历史已确认成交 {num(leg.quantity)}{unknownLeg(p,leg.exchange)?' · 原订单待核对':''}</small></span>;
    return <span className={side==='short'?'cell-caption':undefined}>{side==='long'?'多':'空'} {venues[leg.exchange]}：{unknownLeg(p,leg.exchange)?'待确认':num(leg.quantity)}</span>;
  };
  const currentCash=(p:Position,m:LedgerPositionMetrics)=>m.source==='account'&&!isHistorical(p);
  const status=(p:Position,m:LedgerPositionMetrics)=>{
    if(historyOnlyIds.has(p.id))return <><Badge>原持仓周期 · 历史记录</Badge><span className="cell-caption">当前账户已是另一个开仓周期，其数量与现金费用在外部账户行单独展示；原账本最终平仓仍需核对。</span></>;
    if(m.observation.status==='account_flat')return <><Badge>{p.accountClosure?'已归档 · 历史成交待核对':'账户已空仓 · 历史成交待核对'}</Badge><span className="cell-caption">已于 {date(m.observation.observedAt)} 确认两所无该币持仓；最终损益等待平仓成交核对。</span>{(unknownLeg(p,p.long.exchange)||unknownLeg(p,p.short.exchange))&&<span className="cell-caption">原订单状态仍待核对；历史订单不代表当前仓位。</span>}</>;
    if(m.observation.status==='unverified')return <><Badge kind="orange">账户待读取 · 当前持仓未知</Badge><span className="cell-caption">需要两所新鲜账户快照，不能使用历史成交数量判断当前持仓。</span></>;
    const executionLabel=currentCloseOrdersUnknown(p,state)?'订单待核对':currentCloseOperationInFlight(p,state)?'手动平仓处理中':p.status==='closing'?positionCloseProgressLabel(p):undefined;
    const label=m.source==='ledger'?p.status==='closed'?'已平仓':p.status==='open'?'对冲持有':p.status==='opening'?'开仓中':executionLabel??'管理待核对':
      m.holding==='paired'?'双腿在仓':m.holding==='imbalanced'?'双腿在仓 · 数量不等':m.holding==='single'?'单腿在仓':'同币其他合约在仓';
    const external=externalIds.has(p.id);
    return <><Badge kind={m.holding==='paired'?'green':m.holding==='historical'?'neutral':'orange'}>{label}</Badge>{external?<span className="cell-caption">外部账户持仓 · 未自动接管交易</span>:p.status==='attention'&&<span className="cell-caption">管理核验待完成 · 账户数量和损益已读取</span>}{!external&&m.cycleMismatch&&<span className="cell-caption">当前账户周期与原记录不一致，分开核对</span>}{!external&&m.ledgerQuantitiesMatch===false&&<span className="cell-caption">实际数量与历史成交不同，以账户当前值为准</span>}{p.riskReasons.length>0&&<details className="ledger-note"><summary>管理 / 订单核对详情</summary><p>{p.riskReasons.join('；')}</p></details>}<PositionExitNotes position={p}/><HoldDecision position={p} estimate={estimates.get(p.id)!} external={external} executionLabel={executionLabel}/></>;
  };
  return <><LivePositions state={state}/><section className="panel position-ledger" data-testid="position-ledger">
    <div className="section-title"><div><h2>{state.config.mode==='live'?'持仓收益与回本 · 全部真实账户':'持仓管理'}</h2><p>{state.config.mode==='live'?'全部当前账户持仓均展示，包括没有原策略记录的持仓；原成交账本独立保留，已空仓记录归入历史。':'逐腿跟踪成交、资金费与基差损益'}</p></div>{preview?<button className="text-btn" onClick={onMore}>全部记录 <ArrowUpRight size={15}/></button>:<label className="check-label"><input type="checkbox" checked={showClosed} onChange={e=>setShowClosed(e.target.checked)}/>{state.config.mode==='live'?'显示历史记录':'显示已平仓'}{historicalCount>0?`（${historicalCount}）`:''}</label>}</div>
    {showRebates&&<p className="data-footnote">Gate {feeRebatePct('gate',state.config)}%、Bitget {feeRebatePct('bitget',state.config)}% 返佣参与自动退出估算；10 bps 仍按原开仓单腿本金固定计算。原可平净损益与返佣后估算值分别显示，返佣不当作已到账资金费。账户当前周期估值与原策略完整生命周期可能不同，实际策略还会核对原成交记录与账户费率。</p>}
    {positions.some(p=>p.status==='attention'&&!isHistorical(p))&&<div className="info-strip" role="status"><ShieldAlert size={17}/><span>部分记录正在核对管理状态，账户数据持续显示；“待核对”不代表双腿缺仓。</span></div>}
    {historicalCount>0&&!showClosed&&<div className="data-footnote">已将 {historicalCount} 条已平仓或账户已空仓记录归入历史；原订单和费用记录完整保留。</div>}
    {positions.length?<div className="table-scroll"><table><thead><tr><th>策略记录 / 原账本</th><th>{state.config.mode==='live'?'当前数量 / 历史成交':'已确认双腿数量'}</th><th>{state.config.mode==='live'?'当前仓位资金费':'已记录资金费'}</th><th>{state.config.mode==='live'?'当前价格损益 / 已付手续费':'价差损益 / 手续费'}</th><th>预计平仓净损益<span className="th-note">已付费＋预计平仓费均计入</span></th><th>Delta / 当前强平距离</th><th>状态</th><th/></tr></thead><tbody>{(preview?positions.slice(0,4):positions).map(p=>{
      const m=metrics.get(p.id)!,activeAccount=currentCash(p,m),historical=isHistorical(p),funding=activeAccount?m.fundingUsd:p.fundingUsd,fees=activeAccount?m.feesUsd:p.feesUsd;
      const cash=ledgerCashPresentation(p,m);
      const missing=[m.unrealizedPnlUsd===undefined?'未实现损益':null,m.realizedPnlUsd===undefined?'已实现价格损益':null,m.fundingUsd===undefined?'资金费':null,m.feesUsd===undefined?'手续费':null].filter(Boolean).join('、');
      const estimate=estimates.get(p.id)!,external=externalIds.has(p.id);
      const closeAction=positionCloseAction(p,state,now),closePending=!!pendingPositionIds?.has(p.id)||!!pendingCloseBases?.has(p.base);
      const closeReason=closePending?'平仓正在处理或结果待确认，请勿重复提交':closeAction.reason;
      const exitRecord=p.manualCloseAccountRecord===true;
      const closeValue=closeValues.get(p.id)!;
      const rebate=showRebates&&!historical?ledgerCloseRebate(p,m,closeValue,state.config):undefined;
      const closeBatch=closeValue.closeBatch;
      const breakdown=closeValue.breakdown;
      const net=exitRecord&&historical?undefined:historical||p.mode!=='live'?m.netPnlUsd??m.observedSubtotalUsd:closeValue.netPnlUsd;
      return <tr key={p.id} data-position-id={p.id}>
        <td><b>{p.base}</b><span className="position-test-badge"><Badge>{external?'外部账户持仓':entryLabel(p)}</Badge></span><span className="cell-caption">{external&&m.holding==='single'?(p.long.quantity>0?'多':'空')+' '+venues[(p.long.quantity>0?p.long:p.short).exchange]+' · 未配对':'多 '+venues[p.long.exchange]+' / 空 '+venues[p.short.exchange]}</span><span className="cell-caption">{external?'只读监测':p.holdMode==='once'?`单次 · ${time(p.plannedExitAt)} 计划退出`:p.holdMode==='adaptive'?'自主判断 · 每轮续持/退出':'持续持有'} · {p.openedAt>1?date(p.openedAt):'开仓时间未返回'}</span>{!external&&<details className="ledger-note"><summary>原成交账本</summary><dl><div><dt>已记录资金费</dt><dd>{money(p.fundingUsd,true)} · {p.fundingEvents.length} 笔</dd></div><div><dt>已记录手续费</dt><dd>{money(p.feesUsd)}</dd></div><div><dt>已实现价格损益</dt><dd>{money(p.realizedSpreadPnlUsd,true)}</dd></div><div><dt>原账本净值</dt><dd>{money(p.netPnlUsd,true)}</dd></div></dl><p>历史成交与现金记录保留；未确认最终平仓的记录不视为最终净收益。</p></details>}</td>
        <td>{quantity(p,'long')}{quantity(p,'short')}</td>
        <td><span className={tone(funding)}>{exitRecord&&!activeAccount?'原持仓资金费待归集':funding===undefined?cash.fundingLabel:money(funding,true)}</span><span className="cell-caption">{!activeAccount?'原成交账本':!external&&m.cycleMismatch?'账户另一个持仓周期 · 不归入原账本':'交易所当前持仓周期'}</span>{activeAccount&&funding===undefined&&cash.fundingReasons.map(reason=><span key={reason} className="cell-caption">{reason}</span>)}{activeAccount&&!external&&funding===undefined&&<span className="cell-caption">已记录参考 {money(p.fundingUsd,true)} · 不补入当前现金</span>}</td>
        <td><span className={tone(m.unrealizedPnlUsd)}>{m.unrealizedPnlUsd===undefined?historical?'待核对最终价格损益':'等待读取实时损益':money(m.unrealizedPnlUsd,true)}</span><span className="cell-caption">{m.source==='account'&&!historical?'账户浮盈（标记价，未扣费）':p.status==='closed'?'已核对成交账本':'外部平仓成交未确认'}</span>{activeAccount&&<span className="cell-caption">当前周期已实现 {m.realizedPnlUsd===undefined?cash.realizedLabel:money(m.realizedPnlUsd,true)}</span>}<span className="cell-caption">手续费 {fees===undefined?cash.feesLabel:money(fees)}</span>{activeAccount&&!external&&fees===undefined&&<span className="cell-caption">已记录参考 {money(p.feesUsd)}</span>}</td>
        <td className="ledger-close-value" data-close-value-status={historical||p.mode!=='live'?'historical':closeValue.status==='retained'?'cached':closeValue.status==='pending'?'unavailable':'current'}>
          {historical&&p.mode==='live'&&!exitRecord?<LedgerClosedNet position={p} state={state} grossNet={net} showRebates={showRebates}/>:<>
            <b className={tone(net)} data-testid="ledger-close-net">{net===undefined?historical?exitRecord?'完整周期收益待核对':'—':cash.closePendingLabel(closeValue.pendingReason):money(net,true)}</b>
            <span className="cell-caption ledger-close-caption">{historical||p.mode!=='live'?exitRecord?'仅本次平仓成交；原开仓费用及资金费未归集':'成交账本口径（返佣前）':closeValue.status==='pending'?'平仓净损益条件未完整核对':'按开仓均价与对手价1估算 · 已扣全部费用'}</span>
          </>}
          {showRebates&&rebate&&<><span className="cell-caption">预计返佣 {money(rebate.estimatedFeeRebateUsd,true)} · 含预计平仓费返佣</span>
            <span className="cell-caption">返佣后估算平仓净收益 <b className={tone(rebate.estimatedNetPnlAfterRebateUsd)}>{money(rebate.estimatedNetPnlAfterRebateUsd,true)}</b></span></>}
          {!historical&&closeValue.pendingReason==='cash'&&cash.details.length>0&&<span className="cell-caption">{cash.details[0]}{cash.details.length>1?' · 其余见明细':''}</span>}
          {!historical&&p.mode==='live'&&<details className="ledger-note ledger-valuation-detail">
            <summary>估值明细</summary>
            <dl>
              <div><dt>估值状态</dt><dd>{closeValue.status==='current'?'最新有效盘口':closeValue.status==='retained'?'最近有效估值 · 盘口更新中':cash.closePendingLabel(closeValue.pendingReason)}</dd></div>
              {cash.details.length>0&&<div><dt>未核对现金项</dt><dd>{cash.details.map(reason=><div key={reason}>{reason}</div>)}</dd></div>}
              {cash.observations.length>0&&<div><dt>账单更新状态</dt><dd>{cash.observations.map(reason=><div key={reason}>{reason}</div>)}</dd></div>}
              {(['long','short'] as const).map(side=>m[side].cashFlowAt&&<div key={`${side}-cash-observed`}><dt>{side==='long'?'多':'空'} {venues[p[side].exchange]} 账单采样</dt><dd>{time(m[side].cashFlowAt)}{m[side].cashFlowStatus==='ready'?' · 已核对':' · 最近已核现金'}</dd></div>)}
              <div><dt>回本判断</dt><dd><span data-testid="ledger-close-recovery"><Badge kind={closeValue.breakEven==='recovered'?'green':closeValue.breakEven==='not_recovered'?'orange':'neutral'}>{ledgerCloseValueBreakEvenLabel(closeValue)}</Badge></span></dd></div>
              <div><dt>平仓盘口采样</dt><dd>{closeValue.bookObservedAt?time(closeValue.bookObservedAt):'等待同步'}</dd></div>
              <div><dt>首批方式</dt><dd>{closeBatch?.kind==='paired'?'双腿等量分批':closeBatch?.kind==='excess-long'?'先减多腿超额':closeBatch?.kind==='excess-short'?'先减空腿超额':closeBatch?.kind==='single-long'?'多腿单独分批':closeBatch?.kind==='single-short'?'空腿单独分批':'等待合法首档批次'}</dd></div>
              <div><dt>本批多腿 / 总持仓</dt><dd>{closeBatch?`${num(closeBatch.longQuantity)} / ${num(closeBatch.longTotalQuantity)}`:'待估算'}</dd></div>
              <div><dt>本批空腿 / 总持仓</dt><dd>{closeBatch?`${num(closeBatch.shortQuantity)} / ${num(closeBatch.shortTotalQuantity)}`:'待估算'}</dd></div>
              <div><dt>账户多腿开仓均价</dt><dd data-testid="ledger-close-long-entry">{price(closeBatch?.longEntryPrice)}</dd></div>
              <div><dt>账户空腿开仓均价</dt><dd data-testid="ledger-close-short-entry">{price(closeBatch?.shortEntryPrice)}</dd></div>
              <div><dt>多腿买1价 / 首档量</dt><dd>{closeBatch?.longLimitPrice!==undefined?`${price(closeBatch.longLimitPrice)} / ${num(closeBatch.longTopQuantity!)}`:'—'}</dd></div>
              <div><dt>空腿卖1价 / 首档量</dt><dd>{closeBatch?.shortLimitPrice!==undefined?`${price(closeBatch.shortLimitPrice)} / ${num(closeBatch.shortTopQuantity!)}`:'—'}</dd></div>
              <div><dt>盘口价格损益</dt><dd className={tone(breakdown?.pricePnlUsd)} data-testid="ledger-close-price-pnl">{money(breakdown?.pricePnlUsd,true)}</dd></div>
              <div><dt>本周期已实现价格损益</dt><dd data-testid="ledger-close-realized-pnl">{money(breakdown?.realizedPnlUsd,true)}</dd></div>
              <div><dt>已到账资金费</dt><dd data-testid="ledger-close-funding">{money(breakdown?.fundingUsd,true)}</dd></div>
              <div><dt>已付手续费</dt><dd data-testid="ledger-close-paid-fees">{money(breakdown?.paidFeesUsd)}</dd></div>
              <div><dt>预计平仓手续费</dt><dd data-testid="ledger-close-fees">{closeValue.closingFeesUsd===undefined?'可平估值同步中':money(closeValue.closingFeesUsd)}</dd></div>
              {showRebates&&<><div><dt>已付费用预计返佣</dt><dd>{money(rebate?.paidFeeRebateUsd,true)}</dd></div>
                <div><dt>预计平仓费用返佣</dt><dd>{money(rebate?.closingFeeRebateUsd,true)}</dd></div>
                <div><dt>返佣后估算平仓净收益</dt><dd>{money(rebate?.estimatedNetPnlAfterRebateUsd,true)}</dd></div></>}
              <div><dt>本策略转账成本</dt><dd data-testid="ledger-close-transfer-cost">{money(breakdown?.transferCostUsd)}</dd></div>
              <div><dt>手续费来源</dt><dd>{closeValue.closingFeeSource==='exchange'?'交易所合约真实费率':closeValue.closingFeeSource==='reference'?'本地参考 · 按需实盘核对':'费率及盘口同步后更新'}</dd></div>
              <div><dt>多腿吃单费率</dt><dd>{closeBatch?.longTakerFeeRate===undefined?'—':`${(closeBatch.longTakerFeeRate*100).toFixed(4)}% · ${closeValue.feeLegs?.find(leg=>leg.side==='long')?feeSourceLabel(closeValue.feeLegs.find(leg=>leg.side==='long')!):'费率待核验'}`}</dd></div>
              <div><dt>空腿吃单费率</dt><dd>{closeBatch?.shortTakerFeeRate===undefined?'—':`${(closeBatch.shortTakerFeeRate*100).toFixed(4)}% · ${closeValue.feeLegs?.find(leg=>leg.side==='short')?feeSourceLabel(closeValue.feeLegs.find(leg=>leg.side==='short')!):'费率待核验'}`}</dd></div>
              <div><dt>账户标记净值（核对用）</dt><dd>{money(m.netPnlUsd??m.observedSubtotalUsd,true)}{m.netPnlUsd===undefined?' · 已同步字段小计':''}</dd></div>
              <div><dt>账户采样时间（核对用）</dt><dd>{m.observedAt?time(m.observedAt):'等待同步'}</dd></div>
            </dl>
            <p>净损益＝盘口价格损益＋本周期已实现＋已到账资金费－已付手续费－预计平仓手续费－转账成本。价格损益直接按账户开仓均价和实际持仓计算，账户浮盈不重复计入。</p>
            {showRebates&&<p>返佣后值仅为估算：在原净损益上增加当前账户周期两腿正净手续费及预计平仓费用的配置返佣。若同腿包含负原生手续费，按净正费用保守估算；不读取返佣、不计为已到账资金费，不改变上面的原实账金额。原策略全生命周期返佣见总览明细。</p>}
            <p>这是全部持仓按首档价分批完成的条件估算。本批只可平上列数量；后续批次价格会变化，不保证整仓按该价格成交。</p>
            <p>盘口暂缺时最多保留采样起 10 秒的整次估值、分解和本批数量，不作为当前回本确认。标记价与买1／卖1不同，账户浮盈和盘口价格损益可以不同；账户标记净值仅供核对，下一轮预计资金费未计入主值。</p>
            {(missing||estimate.exitReason)&&<p>{missing?'待同步 '+missing:estimate.exitReason}</p>}
          </details>}
          {historical&&p.status!=='closed'&&<span className="cell-caption">最终平仓成交未完整核对</span>}
        </td>
        <td>{m.deltaUsd===undefined?historical?'历史记录':'待读取':money(m.deltaUsd)}{m.deltaQuantity!==undefined&&<span className="cell-caption">币数量差 {num(m.deltaQuantity)}</span>}<span className="cell-caption">多：{historical?'历史记录':liquidationObservationLabel(m.long)}</span><span className="cell-caption">空：{historical?'历史记录':liquidationObservationLabel(m.short)}</span></td>
        <td>{status(p,m)}</td>
        <td className="ledger-close-action">{!historical&&<><button className="btn small-btn" disabled={closePending||!closeAction.enabled} title={closeReason??'确认所选账户当前持仓，手动平仓无需启动自动策略'} onClick={()=>onClose(p)}>{closePending?'平仓处理中':'平仓'}</button><span className="cell-caption">{closeReason??(external?'手动平仓 · 未自动接管':'手动平仓')}</span></>}</td>
      </tr>;
    })}</tbody></table></div>:<div className="empty"><Wallet size={27}/><strong>{state.config.mode==='live'?'没有待管理的策略持仓记录':'暂无持仓，等待合适的机会'}</strong><p>{state.config.mode==='live'?'实际仓位以上方交易所账户快照为准；已空仓的旧记录可在历史记录中查看。':'手动选择机会建立对冲，或启动自动策略后按入场规则开仓。'}</p></div>}
    <div className="data-footnote">预计平仓净损益直接按账户开仓均价、对手价1和全部真实持仓计算，计入本周期已实现价格损益与已到账资金费，扣除已付费用、预计平仓手续费及转账成本；假设后续批次仍可按当前首档价成交，不保证全部持仓立即成交，本批数量及金额分解见估值明细。账户浮盈使用标记价，可与盘口价格损益不同。盘口暂缺时最多保留最早采样起 10 秒的整次估值；到期显示盘口同步中。均价、数量、持仓周期、现金费用变化或账户数据未核实时，旧值失效。下一轮资金费为预测，不计入当前回本。</div>
  </section></>;
}
