import {useMemo,useState} from 'react';
import type {TradingOperationKind,TradingOperationProtocol,TradingOperationsSummary} from '../../src/shared/trading-operations';
import {
  executionDuration,executionNumber,executionTime,tradingOperationAge,tradingOperationKindLabels,
  tradingOperationMetricText,tradingOperationPercent,tradingOperationProtocolLabels,tradingOperationRecentRows,
  tradingOperationScopeSummary,tradingOperationStateLabels,type TradingOperationScope,
} from './execution-statistics-view';
const quantity=(value:number|null)=>value!==null&&Number.isFinite(value)&&value!==0&&Math.abs(value)<1e-6?value.toExponential(8):executionNumber(value);

export default function TradingOperationStatistics({summary}:{summary?:TradingOperationsSummary}) {
  const [mode,setMode]=useState<TradingOperationScope['mode']>('live');
  const [kind,setKind]=useState<TradingOperationKind|'all'>('all');
  const [protocol,setProtocol]=useState<TradingOperationProtocol|'all'>('all');
  const scoped=useMemo(()=>summary?tradingOperationScopeSummary(summary,{mode,kind,protocol}):undefined,[summary,mode,kind,protocol]);
  const rows=useMemo(()=>scoped?tradingOperationRecentRows(scoped.rows):[],[scoped]);
  if(!summary||!scoped)return <section className="panel execution-operation-summary" data-testid="trading-operation-statistics">
    <header><div><h3>一次操作的完成情况</h3><p>本版本开始记录，历史操作未重建。等待服务端返回新的操作记录。</p></div></header>
  </section>;
  const counts=scoped.counts;
  const earliest=scoped.rows.reduce<number|null>((first,row)=>first===null?row.startedAt:Math.min(first,row.startedAt),null);
  const timing:Array<[string,keyof TradingOperationsSummary['timing']]>=[['完整操作','totalMs'],['准备盘口与账户','preparationMs'],
    ['发现信号至首次下单调用','signalToSubmitMs'],['下单调用至首次回执','submitToAckMs'],['回执至首次成交观察','ackToFirstFillMs'],
    ['首次成交至目标确认','firstFillToPairedMs'],['目标确认至账户确认','accountConfirmationMs']];
  return <section className="panel execution-operation-summary" data-testid="trading-operation-statistics">
    <header><div><h3>一次操作的完成情况</h3><p>每次提交或自动触发计一次，分批和重试合并记录。退出按本次实际执行方式统计。</p>
      <p>观察窗口 {earliest===null?'尚无操作':executionTime(earliest)} → {executionTime(summary.timestamp)} · 历史未记录操作不补造</p></div>
      <div className="execution-stats-record-controls">
        <label>模式<select aria-label="操作交易模式" value={mode} onChange={event=>setMode(event.target.value as TradingOperationScope['mode'])}>
          <option value="live">实盘</option><option value="paper">模拟</option><option value="all">全部</option></select></label>
        <label>操作<select aria-label="操作类型" value={kind} onChange={event=>setKind(event.target.value as TradingOperationKind|'all')}>
          <option value="all">全部操作</option>{Object.entries(tradingOperationKindLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
        <label>实际方式<select aria-label="本次操作实际方式" value={protocol} onChange={event=>setProtocol(event.target.value as TradingOperationProtocol|'all')}>
          <option value="all">全部方式</option>{Object.entries(tradingOperationProtocolLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      </div>
    </header>
    {summary.diagnosticError&&<p className="execution-stats-note" role="status">{summary.diagnosticError}</p>}
    {summary.coverageLimited&&<p className="execution-stats-note">统计仅覆盖保留样本，未表示全部历史操作。保留起点 {executionTime(summary.retainedFrom)}；新旧方案比较应使用相同观察窗口。</p>}
    <div className="execution-stats-cards">
      <div className="execution-stats-card featured"><span>完整完成率</span><strong>{tradingOperationPercent(scoped.completionRatePct)}</strong>
        <p>{counts.complete} / {counts.total} 次操作<br/>未知、部分完成和进行中保留在分母</p></div>
      <div className="execution-stats-card"><span>进行中 / 部分完成 / 结果未知</span><strong>{counts.running} / {counts.partial} / {counts.unknown}</strong>
        <p>已取消 {counts.cancelled} · 未完成 {counts.failed}<br/>完整完成须有数量及账户确认</p></div>
      <div className="execution-stats-card"><span>尚未完整完成的等待年龄 · P95</span><strong>{tradingOperationMetricText(scoped.pendingAgeMs,'p95')}</strong>
        <p>最长 {tradingOperationMetricText(scoped.pendingAgeMs,'max')}<br/>{scoped.pendingAgeMs.knownCount} 次有时钟 · {scoped.pendingAgeMs.unknownCount} 次未记录</p></div>
      <div className="execution-stats-card"><span>有证据的自动操作人工介入</span><strong>{counts.automatic?`${counts.intervention} / ${counts.automatic}`:'无自动样本'}</strong>
        <p>{counts.intervention} 次已记录介入 · {counts.manual} 次手动操作<br/>缺介入记录不能判定无需救援</p></div>
    </div>
    {summary.counts.invalid>0&&<p className="execution-stats-note">另有 {summary.counts.invalid} 条操作记录字段不完整；无法分配到筛选分组，全部范围保留为未知。</p>}
    {summary.counts.duplicateIds>0&&<p className="execution-stats-note">检测到 {summary.counts.duplicateIds} 条重复编号记录；冲突记录按未知核对，不重复计为成功。</p>}
    <details className="execution-operation-timing"><summary>阶段耗时与裸露证据</summary>
      <div className="table-scroll"><table className="execution-stats-record-table"><thead><tr><th>本地观察阶段</th><th>P50</th><th>P95</th><th>最长</th><th>有时钟 / 未计入</th></tr></thead>
        <tbody>{timing.map(([label,key])=><tr key={key}><td>{label}</td><td>{tradingOperationMetricText(scoped.timing[key])}</td><td>{tradingOperationMetricText(scoped.timing[key],'p95')}</td>
          <td>{tradingOperationMetricText(scoped.timing[key],'max')}</td><td>{scoped.timing[key].knownCount} / {scoped.timing[key].unknownCount}</td></tr>)}</tbody></table></div>
      <p className="execution-stats-note">完整耗时只统计已完整完成记录；未完成操作同时列出等待年龄。阶段时钟缺失不按零计算。下单调用包含适配器内部检查，不证明已经发出HTTP请求。P50、P95按本地观察样本计算，不表示交易所原生成交时间，少量样本不能证明稳定。</p>
      <p className="execution-stats-note">裸露观察：{scoped.exposure.observedMs.knownCount} 次有完整证据 · {scoped.exposure.observedMs.unknownCount} 次未知；
        最长 {tradingOperationMetricText(scoped.exposure.observedMs,'max')}，已记录最大名义金额 {scoped.exposure.maxNotionalUsd.knownCount?`$${executionNumber(scoped.exposure.maxNotionalUsd.max)}`:'未知'}。未记录不代表无单腿。</p>
    </details>
    <details className="execution-operation-records"><summary>最近操作明细 · {rows.length} / {scoped.rows.length} 次有完整身份的记录</summary>
      {rows.length?<div className="table-scroll"><table className="execution-stats-record-table"><thead><tr><th>币种 / 开始时间</th><th>操作 / 实际方式</th><th>结果 / 当前原因</th><th>目标 / 已确认 / 剩余币数</th><th>等待年龄 / 本地尝试</th></tr></thead>
        <tbody>{rows.map(row=><tr key={row.id} data-trading-operation={row.id}>
          <td><b className="execution-stats-row-title">{row.base}</b><small>{executionTime(row.startedAt)}<br/>{row.mode==='live'?'实盘':'模拟'} · {row.origin==='automatic'?'自动触发':'手动提交'}</small></td>
          <td>{tradingOperationKindLabels[row.kind]}<small>{tradingOperationProtocolLabels[row.protocol]}{row.attempts.submitted===0?'（未调用）':''}</small></td>
          <td><span className={`execution-stats-result ${row.state==='unknown'?'pending':row.state==='partial'||row.state==='failed'?'abnormal':''}`}>{tradingOperationStateLabels[row.state]}</span>
            <small className="execution-stats-record-reason">{row.waitReason?.text??(row.state==='complete'?'数量与账户已确认':'当前阶段未记录')}</small></td>
          <td>多 {quantity(row.target.long)} / {quantity(row.confirmed.long)} / {quantity(row.remaining.long)}
            <small>空 {quantity(row.target.short)} / {quantity(row.confirmed.short)} / {quantity(row.remaining.short)}</small></td>
          <td>{tradingOperationAge(row,summary.timestamp)===null?'已结束':executionDuration(tradingOperationAge(row,summary.timestamp))}
            <small>未发送 {row.attempts.preflightNotSent} · 确认零成交 {row.attempts.zeroFill}<br/>下单调用 {row.attempts.submitted} · 在途 {row.attempts.pending??0} · 原单待确认 {row.attempts.unknown}</small></td>
        </tr>)}</tbody></table></div>:<div className="execution-stats-empty">本版本尚无符合范围的新操作；历史操作未重建。</div>}
      <p className="execution-stats-note">仅展示最近50次操作，统计包含筛选范围内全部样本。按开始时间和编号固定排序，状态变化不调换位置。</p>
    </details>
  </section>;
}
