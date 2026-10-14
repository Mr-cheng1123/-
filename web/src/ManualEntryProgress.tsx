import { Check, Clock3, LoaderCircle, ShieldAlert, X } from 'lucide-react';
import {memo,useMemo,useState} from 'react';
import type { AppState } from '../../src/shared/types';
import type { ManualEntryExecutionSummary } from '../../src/shared/manual-entry';
import {entryTargetReached} from '../../src/shared/entry-execution-progress';
import { manualEntryBlocksBase, manualEntryStage, manualEntryTerminal, type ManualEntryRequest } from './manual-entry';
import {manualEntryOutcome} from './manual-entry-outcome';
import {manualEntryGroups,MANUAL_ENTRY_EVENT_PAGE_SIZE,MANUAL_ENTRY_HISTORY_PAGE_SIZE} from './manual-entry-visibility';
import './manual-entry.css';

const safeMessage = (value?: string) => value?.replace(/(https?:\/\/)[^\s/@]+@/gi, '$1[已隐藏]@')
  .replace(/((?:api[_-]?key|secret|signature|passphrase|token|authorization)["']?\s*[:=]\s*["']?)[^\s,"'&}]+/gi, '$1[已隐藏]').slice(0, 600);
const quantityFormatter=new Intl.NumberFormat('en-US',{maximumFractionDigits:8});
const moneyFormatter=new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:6});
const timeFormatter=new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
const number = (value: number) => quantityFormatter.format(value);
const money=(value:number|undefined,signed=false)=>value===undefined?'待核对':`${value<0?'−':signed&&value>0?'+':''}$${moneyFormatter.format(Math.abs(value))}`;
const venues={binance:'Binance',bybit:'Bybit',okx:'OKX',gate:'Gate',bitget:'Bitget'};
const statusLabels={filled:'全部成交',partial:'部分成交',cancelled:'已取消',unknown:'状态未知',pending:'等待回报',error:'提交异常'};
function ExecutionEvents({events}:{events:ManualEntryExecutionSummary['events']}){
  const [page,setPage]=useState(0);
  const ordered=useMemo(()=>[...events].sort((a,b)=>a.timestamp-b.timestamp),[events]);
  const pages=Math.max(1,Math.ceil(ordered.length/MANUAL_ENTRY_EVENT_PAGE_SIZE));
  const current=Math.min(page,pages-1);
  return <><div className="manual-entry-execution-events">{ordered.slice(current*MANUAL_ENTRY_EVENT_PAGE_SIZE,(current+1)*MANUAL_ENTRY_EVENT_PAGE_SIZE).map((event,index)=><div key={`${event.timestamp}-${current*MANUAL_ENTRY_EVENT_PAGE_SIZE+index}`}>
    <b>{venues[event.exchange]} · {event.phase==='opening'?(event.side==='buy'?'开多':'开空'):'减仓 / 平仓'} · {statusLabels[event.status]}</b>
    <span>已确认成交 {event.filledQuantity===undefined?'待核对':number(event.filledQuantity)} / 请求 {number(event.requestedQuantity)}{event.limitPrice!==undefined&&event.limitPrice>0?` · 限价 ${number(event.limitPrice)}`:''}{event.averagePrice!==undefined&&event.averagePrice>0?` · 成交均价 ${number(event.averagePrice)}`:''}</span>
    <span>手续费 {money(event.feeUsd)} · {timeFormatter.format(event.timestamp)}</span>
    {(event.rejectionCode||event.rejectionReason)&&<span className="negative">{safeMessage(event.rejectionCode)}{event.rejectionCode&&event.rejectionReason?' · ':''}{safeMessage(event.rejectionReason)}</span>}
  </div>)}</div>{pages>1&&<div className="manual-entry-pagination"><button type="button" className="btn small-btn" disabled={current===0} onClick={()=>setPage(current-1)}>上一页明细</button><span>{current+1} / {pages} · 每页 {MANUAL_ENTRY_EVENT_PAGE_SIZE} 笔</span><button type="button" className="btn small-btn" disabled={current+1>=pages} onClick={()=>setPage(current+1)}>下一页明细</button></div>}</>;
}
const ExecutionSummary=memo(function ExecutionSummary({summary,positionStatus}:{summary:ManualEntryExecutionSummary;positionStatus?:string}){
  const [detailsOpen,setDetailsOpen]=useState(false);
  const complete=summary.accountingStatus==='confirmed';
  const progress=summary.entryExecution;
  return <div className="manual-entry-outcome">
    {progress&&<div className="manual-entry-batch-progress"><p className="manual-entry-historical">对手价分批 IOC · 开仓已配对 {number(progress.matchedQuantity)} / 目标 {number(progress.targetQuantity)} 币 · 已完成 {number(progress.completedBatches)} 批</p>
      {!entryTargetReached(progress)&&progress.matchedQuantity>0&&<p>{positionStatus==='open'?'已配对部分保留为对冲持仓，原目标未全部成交。':positionStatus==='closed'?'开仓目标当时未全部成交，当前记录已关闭。':'原目标尚未全部成交；当前敞口以已确认数量及查单结果为准。'}</p>}
      {progress.stopReason&&<p className="manual-entry-sync">本次补仓停止：{safeMessage(progress.stopReason)}</p>}</div>}
    <p className="manual-entry-historical">已确认开仓成交：多 {venues[summary.long.exchange]} {number(summary.long.openedQuantity)} / 空 {venues[summary.short.exchange]} {number(summary.short.openedQuantity)}</p>
    <p className="manual-entry-historical">已确认减仓 / 平仓：多 {number(summary.long.reducedQuantity)} / 空 {number(summary.short.reducedQuantity)}</p>
    <dl className="manual-entry-costs"><div><dt>开仓手续费</dt><dd>{money(summary.openingFeesUsd)}</dd></div><div><dt>减仓 / 平仓手续费</dt><dd>{money(summary.rollbackFeesUsd)}</dd></div><div><dt>已实现价格损益</dt><dd className={(summary.realizedPricePnlUsd??0)<0?'negative':''}>{money(summary.realizedPricePnlUsd)}</dd></div><div><dt>{complete?'已核对净损益':'最终净损益'}</dt><dd className={(summary.netPnlUsd??0)<0?'negative':''}>{complete?money(summary.netPnlUsd):'待核对'}</dd></div></dl>
    {!complete&&<p>成交或费用尚未完整确认；上方仅展示已确认记录，当前数量为零不代表费用为零。</p>}
    <details className="manual-entry-event-details" open={detailsOpen} onToggle={event=>setDetailsOpen(event.currentTarget.open)}><summary>执行明细（{summary.events.length} 笔）</summary>{detailsOpen&&<ExecutionEvents events={summary.events}/>}</details>
  </div>;
});

export default function ManualEntryProgress({ entries, state, cancelPending, onCancel, onDismiss }: {
  entries: ManualEntryRequest[]; state: AppState | null; cancelPending: ReadonlySet<string>;
  onCancel: (id: string) => Promise<void>; onDismiss: (id: string) => void;
}) {
  const [historyPage,setHistoryPage]=useState(0);
  const {attention,history}=useMemo(()=>manualEntryGroups(entries,state),[entries,state?.positions,state?.unconfirmedOrders]);
  const historyPages=Math.max(1,Math.ceil(history.length/MANUAL_ENTRY_HISTORY_PAGE_SIZE));
  const currentHistoryPage=Math.min(historyPage,historyPages-1);
  const visibleEntries=[...attention,...history.slice(currentHistoryPage*MANUAL_ENTRY_HISTORY_PAGE_SIZE,(currentHistoryPage+1)*MANUAL_ENTRY_HISTORY_PAGE_SIZE)];
  if (!entries.length) return null;
  return <aside className="manual-entry-progress" aria-label="手动开仓进度" aria-live="polite">
    <header><Clock3 size={15}/><b>手动开仓进度</b><span>每次点击均按原操作编号追踪</span></header>
    <div className="manual-entry-progress-list">{attention.length>0&&<div className="manual-entry-list-caption">处理中 / 待核对 {attention.length} 条 · 始终展示</div>}{visibleEntries.map((request,index) => {
      const operation = request.operation, terminal = manualEntryTerminal(operation), blocked = manualEntryBlocksBase(request, state);
      const success = terminal && operation?.result?.positionStatus === 'open';
      const pending = !terminal;
      const outcome=manualEntryOutcome(request,state);
      const partialTarget=operation?.state==='completed'&&operation.result?.positionStatus==='open'&&
        outcome.summary?.entryExecution&&!entryTargetReached(outcome.summary.entryExecution);
      return <article key={request.id} data-operation-id={request.id} data-needs-attention={index<attention.length?'true':'false'} className={success ? 'complete' : terminal ? 'ended' : 'processing'}>
        <div className="manual-entry-title">{pending ? <LoaderCircle size={15} className="spin"/> : success ? <Check size={15}/> : <ShieldAlert size={15}/>}<b>{request.base} · {manualEntryStage(request)}</b>
          {!blocked && <button className="icon-btn" onClick={() => onDismiss(request.id)} aria-label={`关闭 ${request.base} 开仓结果`}><X size={14}/></button>}
        </div>
        <p>{partialTarget?'本次已形成部分双腿对冲，尚未达到原目标数量。':safeMessage(operation?.message) || '已记录本次点击，正在获取双腿执行进度。'}</p>
        {operation?.error && <p className="negative">{safeMessage(operation.error)}</p>}
        {request.syncMessage && <p className="manual-entry-sync">{request.syncMessage}</p>}
        {operation?.result && <p className="manual-entry-quantities">当前已确认剩余：多腿 {number(operation.result.longQuantity)} / 空腿 {number(operation.result.shortQuantity)}{operation.result.positionStatus === 'closed' ? ' · 当前记录已关闭' : ''}</p>}
        {outcome.summary&&<ExecutionSummary summary={outcome.summary} positionStatus={operation?.result?.positionStatus}/>}
        {!outcome.summary&&outcome.ledger&&<div className="manual-entry-outcome"><p>旧回执未保存逐笔过程，以下为该仓位原账本记录：</p><dl className="manual-entry-costs"><div><dt>已记录手续费合计</dt><dd>{money(outcome.ledger.feesUsd)}</dd></div><div><dt>已记录价格损益</dt><dd>{money(outcome.ledger.realizedPricePnlUsd)}</dd></div><div><dt>已记录净损益</dt><dd>{money(outcome.ledger.netPnlUsd)}</dd></div></dl><p>历史成交数量与拒绝原因仍待原订单核对，不从当前零数量推算。</p></div>}
        <div className="manual-entry-footer"><small>操作编号 {request.id.slice(0, 8)} · {timeFormatter.format(request.requestedAt)}</small>
          {operation?.cancelable && !operation.ordersSubmitted && <button className="btn small-btn" disabled={cancelPending.has(request.id)} onClick={() => void onCancel(request.id)}>{cancelPending.has(request.id) ? '取消中' : '取消本次开仓'}</button>}
          {operation?.ordersSubmitted && pending && <span>已提交，等待双腿最终结果</span>}
          {terminal && blocked && <span>成交仍待核对，保留该币种限制</span>}
        </div>
      </article>;
    })}</div>{history.length>0&&<div className="manual-entry-history"><span>已结束回执 {history.length} 条 · 保留全部记录</span>{historyPages>1&&<div className="manual-entry-pagination"><button type="button" className="btn small-btn" aria-label="上一页开仓历史" disabled={currentHistoryPage===0} onClick={()=>setHistoryPage(currentHistoryPage-1)}>上一页</button><span>{currentHistoryPage+1} / {historyPages}</span><button type="button" className="btn small-btn" aria-label="下一页开仓历史" disabled={currentHistoryPage+1>=historyPages} onClick={()=>setHistoryPage(currentHistoryPage+1)}>下一页</button></div>}</div>}
  </aside>;
}
