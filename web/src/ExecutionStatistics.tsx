import {Fragment,useMemo,useState,type ReactNode} from 'react';
import {BarChart3,ChevronDown,ChevronLeft,ChevronRight,Download,Search} from 'lucide-react';
import {useBoundedPage} from './use-bounded-page';
import MakerCloseComparisons from './MakerCloseComparisons';
import TradingOperationStatistics from './TradingOperationStatistics';
import type {
  CompensationAlternative,ExecutionEntryPath,ExecutionMethod,ExecutionMoneyMetric,ExecutionSampleMetric,
  ExecutionStatisticsOrder,ExecutionStatisticsRow,ExecutionStatisticsSummary,
} from '../../src/shared/execution-statistics';
import {
  executionAbnormalSummary,executionOrderCallGapMetric,executionClosedCsv,executionDuration,executionEntrySuccess,executionEvidenceJson,executionMethodLabels,executionMoney,
  executionMoneyPresentation,executionNormalClosedSummary,executionNumber,executionPathLabels,executionResultLabels,
  executionRowsPage,executionSamplePresentation,executionScopeRows,executionScopeSummary,executionTime,executionTone,executionVisibleRows,
  type ExecutionResultFilter,type ExecutionScope,
} from './execution-statistics-view';

const methods:ExecutionMethod[]=['ioc','maker-ioc'];
const paths:ExecutionEntryPath[]=['single-cycle','price-100','manual','legacy'];
const roleLabels:Record<string,string>={entry:'入场首批',hedge:'补齐对冲','entry-tail':'入场回撤',exit:'平仓首批','exit-tail':'平仓尾量'};
const orderStatusLabels:Record<ExecutionStatisticsOrder['status'],string>={filled:'已成交',partial:'部分成交',cancelled:'已撤销',unknown:'待确认'};
const resultLabel=(row:ExecutionStatisticsRow)=>row.status==='hedged'?(row.closed||row.closeRecorded?'正常已闭合':'双腿持有'):
  row.status==='no-fill'?'确认未成交':row.status==='abnormal'?'异常执行':row.status==='external'?'账户导入':'待核对';
function downloadLocalFile(name:string,content:string,type:string) {
  const url=URL.createObjectURL(new Blob([content],{type}));
  const link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function MoneyStat({label,metric,caption,featured=false,cost=false}:{label:string;metric:ExecutionMoneyMetric;caption:string;featured?:boolean;cost?:boolean}){
  const shown=executionMoneyPresentation(metric,true);
  return <div className={`execution-stats-card${featured?' featured':''}`} data-execution-stat={label}>
    <span>{label}</span><strong className={executionTone(cost&&shown.value!==null?-shown.value:shown.value)}>{shown.text}</strong>
    <p>{shown.caption}<br/>{caption}</p>
  </div>;
}
function MoneyCell({metric,signed=false,cost=false}:{metric:ExecutionMoneyMetric;signed?:boolean;cost?:boolean}){
  const shown=executionMoneyPresentation(metric,signed);
  return <><b className={executionTone(cost&&shown.value!==null?-shown.value:shown.value)}>{shown.text}</b><small>{shown.caption}</small></>;
}
function SampleCell({metric,unit='duration',showMax=false}:{metric:ExecutionSampleMetric;unit?:'duration'|'bps';showMax?:boolean}){
  const shown=executionSamplePresentation(metric,unit);
  return <><b>{shown.text}</b><small>{shown.caption}{showMax&&metric.max!==null&&` · 最长 ${executionDuration(metric.max)}`}</small></>;
}
function EntryRate({rows}:{rows:readonly ExecutionStatisticsRow[]}){
  const rate=executionEntrySuccess(rows);
  return <><b>{rate.percent===null?'无样本':`${executionNumber(Math.round(rate.percent*10)/10)}%`}</b>
    <small>{rate.succeeded} / {rate.resolved} 次已确定尝试{rate.unknown>0&&` · ${rate.unknown} 次待核对`}</small></>;
}
function CompensationValue({value}:{value?:CompensationAlternative}){
  return value?<><b>预测成本 {executionMoney(value.costUsd,true)}</b><small>{executionNumber(value.quantity)} 币 · 限价 {executionNumber(value.limitPrice)}<br/>
    条件价格损益 {executionMoney(value.pricePnlUsd,true)}<br/>预计资金费 {executionMoney(value.predictedFundingUsd,true)}<br/>
    {value.basis==='current-book-at-cycle-end'?'新增开仓及两腿平仓预计费':value.basis==='immediate-rollback'?'立即撤回预计费':'预计费用'} {executionMoney(value.feesUsd)}<br/>
    {value.basis==='current-book-at-cycle-end'?'当前平仓盘口保持到周期末':value.basis==='immediate-rollback'?'立即撤回已成交余量':'预测口径未记录'}
    {value.basis==='current-book-at-cycle-end'&&<><br/>多腿平仓价 {executionNumber(value.longClosePrice)} / 空腿平仓价 {executionNumber(value.shortClosePrice)}</>}
  </small></>:<>无记录</>;
}
const compensationConstraints:Record<string,string>={'retry-budget':'补齐重试预算已用完','explicit-rejection':'补腿被交易所明确拒绝',
  'no-supported-hedge':'当前没有可提交的补齐方案','no-fresh-refresh':'缺少新鲜盘口刷新','validation-failed':'补齐复核未通过'};

/** Evidence is rendered on demand. It contains original journal facts, never a trading control. */
export function ExecutionRowEvidence({row}:{row:ExecutionStatisticsRow}){
  const ordered=[...row.orders].sort((a,b)=>a.createdAt-b.createdAt||a.key.localeCompare(b.key));
  return <div className="execution-stats-evidence" data-execution-evidence={row.id}>
    <h4>{row.base} · 原始执行证据</h4>
    <p>{row.reason} · 策略 ID <code>{row.id}</code></p>
    <dl>
      <div><dt>执行方式来源</dt><dd>{row.methodSource==='recorded'?'开仓时记录': '历史 IOC 流程推断'} · {executionMethodLabels[row.method]}</dd></div>
      <div><dt>入场分区来源</dt><dd>{row.pathSource==='recorded'?'开仓时记录':'历史未记录入场来源'} · {executionPathLabels[row.entryPath]}</dd></div>
      <div><dt>生命周期</dt><dd>{executionTime(row.openedAt)} → {row.closedAt?executionTime(row.closedAt):(row.closeRecorded?'关闭时间待核对':'仍未闭合')}</dd></div>
      <div><dt>数量 · 基础币</dt><dd>多 {executionNumber(row.longQuantity)} / 空 {executionNumber(row.shortQuantity)}</dd></div>
      <div><dt>已确认资金费 / 转账费用</dt><dd>{executionMoney(row.amounts.fundingUsd,true)} / {executionMoney(row.amounts.transferCostUsd)}</dd></div>
      <div><dt>{row.closed||row.closeRecorded?'已实现价格损益':'当前标记价格损益 · 不计入闭合净收益'}</dt><dd>{executionMoney(row.amounts.spreadPnlUsd,true)}</dd></div>
      <div><dt>两腿下单调用 / 确认间隔</dt><dd>{executionDuration(row.timing.firstLegSubmissionGapMs)} / {executionDuration(row.timing.firstLegConfirmationGapMs)}</dd></div>
      <div><dt>下单调用间隔口径</dt><dd>{row.timingBasis?.submission==='outbound'?'本地 adapter 下单调用起点':row.timingBasis?.submission==='journal-intent'?'历史仅订单记录时刻':'下单调用时刻未完整记录'}</dd></div>
      <div><dt>观察到的裸露时间 / 最长一次</dt><dd>{executionDuration(row.timing.unhedgedObservedMs)} / {executionDuration(row.timing.longestUnhedgedObservedMs)}</dd></div>
      <div><dt>实际 Maker 手续费节省</dt><dd>{executionMoney(row.amounts.makerFeeSavingUsd,true)}</dd></div>
    </dl>
    <p>滑点按订单准备时记录的对手价比较；正值表示额外成本，负值表示成交改善。下单调用起点包含 adapter 内部参数准备，不表示交易所收单或成交时刻。裸露时间仅用完整逐笔成交的本地观察时钟，历史缺记录时显示未知。</p>
    {ordered.length?<div className="table-scroll"><table><thead><tr>
      <th>订单 / 交易所</th><th>阶段 / 方式 / 状态</th><th>请求数量 / 限价</th><th>成交数量 / 均价</th><th>准备时对手价 / 报价时间</th>
      <th>订单记录 / 下单调用起点 / 确认</th><th>已付费用 / 滑点</th><th>Maker 节省</th>
    </tr></thead><tbody>{ordered.map(order=><tr key={order.key} data-execution-order={order.key}>
      <td><b>{order.exchange} · {order.symbol}</b><code>客户 ID {order.clientOrderId}</code><code>交易所 ID {order.nativeOrderId??'待核对'}</code>
        {order.batchId&&<code>批次 {order.batchId}</code>}</td>
      <td>{order.side==='buy'?'买入':'卖出'} · {order.reduceOnly?'只减仓':'开仓'}<small>{roleLabels[order.role??'']??'阶段未记录'} · {order.method==='maker'?'Maker':'IOC'}</small>
        <span className="execution-stats-order-status">{orderStatusLabels[order.status]}</span>{order.rejectionCode&&<code>{order.rejectionCode}</code>}</td>
      <td>{executionNumber(order.requestQuantity)}<small>限价 {executionNumber(order.limitPrice)}</small></td>
      <td>{executionNumber(order.filledQuantity)}<small>实际均价 {executionNumber(order.averagePrice)}</small></td>
      <td>{executionNumber(order.referencePrice)}<small>对手价观察 {executionTime(order.referenceObservedAt)}<br/>盘口采集 {executionTime(order.bookObservedAt)}<br/>
        报价年龄 {executionDuration(order.quoteAgeMs)}</small></td>
      <td>{executionTime(order.createdAt)}<small>下单调用起点 {executionTime(order.submittedAt)}<br/>确认 {executionTime(order.confirmedAt)}<br/>从记录到确认 {executionDuration(order.confirmationMs)}</small></td>
      <td>{executionMoney(order.feeUsd)}<small>滑点 {executionMoney(order.slippageUsd,true)} / {order.slippageBps===null?'—':`${executionNumber(order.slippageBps)} bps`}</small></td>
      <td>{executionMoney(order.makerFeeSavingUsd,true)}</td>
    </tr>)}</tbody></table></div>:<div className="execution-stats-evidence-missing">原始订单尚未同步，保留该条策略记录；未将缺失费用或成交按零处理。</div>}
    {row.prediction&&<><h4>开仓前预测 · 不计入已确认损益</h4><dl>
      <div><dt>预计资金费</dt><dd>{executionMoney(row.prediction.fundingUsd,true)}</dd></div>
      <div><dt>单轮预计净收益</dt><dd>{executionMoney(row.prediction.singleCycleNetUsd,true)}</dd></div>
      <div><dt>本批对手价1价格优势</dt><dd>{typeof row.prediction.rawOppositeEdgeBps==='number'?`${executionNumber(row.prediction.rawOppositeEdgeBps)} bps`:'—'}</dd></div>
      <div><dt>预计 Maker 费用节省</dt><dd>{executionMoney(row.prediction.makerFeeSavingUsd,true)}</dd></div>
    </dl></>}
    {row.compensations.length>0&&<><h4>补齐与回撤 · 决策时预测</h4><p>补齐方案假设当前两所平仓盘口保持到本周期末，预计成本包含补腿开仓费、未来双腿平仓费、条件价差损益与预计本周期资金费。已付首腿开仓费是共同沉没成本，不重复扣。预测不计入已实现损益；实际补偿成本另按成交账本统计。预测选择与实际结果分开：选择补齐后仍可能未成交，实际减掉多余数量。历史未记录的条件或结果显示未知。</p>
      <div className="table-scroll"><table><thead><tr><th>观察时间 / 批次 / 周期截止</th><th>多余数量</th><th>补齐方案预测</th><th>立即撤回方案预测</th><th>盘口 / 官方费率证据</th><th>预测选择 / 执行限制</th><th>实际结果 / 已确认数量</th></tr></thead>
        <tbody>{row.compensations.map((item,index)=><tr key={`${item.batchId}:${item.observedAt}:${index}`}>
          <td>{executionTime(item.observedAt)}<code>{item.batchId}</code><small>周期截止 {executionTime(item.projectionUntil)}</small></td><td>{item.unmatchedSide==='long'?'多腿':'空腿'} {executionNumber(item.unmatchedQuantity)}</td>
          <td><CompensationValue value={item.hedge}/></td><td><CompensationValue value={item.rollback}/></td>
          <td>多腿盘口 {executionTime(item.longBookObservedAt)}<small>空腿盘口 {executionTime(item.shortBookObservedAt)}<br/>
            多腿 Taker {typeof item.longTakerFeeRate==='number'?`${executionNumber(item.longTakerFeeRate*100)}%`:'—'}<br/>
            空腿 Taker {typeof item.shortTakerFeeRate==='number'?`${executionNumber(item.shortTakerFeeRate*100)}%`:'—'}</small></td>
          <td>{item.decision==='hedge'?'补齐':item.decision==='rollback'?'回撤':'等待'}{item.constraint&&<small>{compensationConstraints[item.constraint]??'执行条件受限'}</small>}</td>
          <td>{item.outcome==='hedged'?'已补齐对冲':item.outcome==='rollback'?'已执行回撤':item.outcome==='unresolved'?'未完成 / 待核对':'实际结果未记录'}<small>
            补齐成交 {executionNumber(item.hedgeFilledQuantity)}<br/>减多腿 {executionNumber(item.reducedLongQuantity)} / 减空腿 {executionNumber(item.reducedShortQuantity)}<br/>数量单位：基础币</small></td>
        </tr>)}</tbody></table></div></>}
  </div>;
}

export default function ExecutionStatistics({summary}:{summary?:ExecutionStatisticsSummary}){
  const [method,setMethod]=useState<ExecutionScope['method']>('all');
  const [entryPath,setEntryPath]=useState<ExecutionScope['entryPath']>('all');
  const [mode,setMode]=useState<ExecutionScope['mode']>('live');
  const [search,setSearch]=useState(''),[result,setResult]=useState<ExecutionResultFilter>('all');
  const [pageSize,setPageSize]=useState(25);
  const [expanded,setExpanded]=useState<Set<string>>(()=>new Set());
  const scoped=useMemo(()=>summary?executionScopeSummary(summary,{method,entryPath,mode}):undefined,[summary,method,entryPath,mode]);
  const comparison=useMemo(()=>summary?methods.map(item=>executionScopeSummary(summary,{method:item,entryPath,mode})):[],[summary,entryPath,mode]);
  const visible=useMemo(()=>scoped?executionVisibleRows(scoped.rows,search,result):[],[scoped,search,result]);
  const [page,setPage]=useBoundedPage(Math.max(1,Math.ceil(visible.length/pageSize)));
  const paging=executionRowsPage(visible,page,pageSize);
  if(!summary||!scoped)return <section className="panel execution-stats-waiting" role="status"><BarChart3 size={20}/>
    <div><b>等待执行统计同步</b><p>等待服务端返回订单与费用核对结果。</p></div></section>;
  const normal=executionNormalClosedSummary(scoped),abnormal=executionAbnormalSummary(scoped),rate=executionEntrySuccess(scoped.rows);
  const resetPage=()=>setPage(1);
  const closedExportCount=visible.filter(row=>row.status!=='external'&&row.status!=='no-fill'&&(row.closed||row.closeRecorded)).length;
  const exportDay=new Date(summary.timestamp>0&&Number.isFinite(summary.timestamp)?summary.timestamp:Date.now()).toISOString().slice(0,10);
  const toggle=(id:string)=>setExpanded(previous=>{const next=new Set(previous);if(next.has(id))next.delete(id);else next.add(id);return next;});
  const count=(filter:Partial<ExecutionScope>)=>executionScopeRows(summary.rows,{method:'all',entryPath:'all',mode,...filter}).length;
  const compareRows:Array<{label:string;render:(value:ExecutionStatisticsSummary)=>ReactNode}>=[
    {label:'执行样本 / 待核对',render:value=><><b>{value.counts.total} 次</b><small>双腿完成 {value.counts.hedged} · 未成交 {value.counts.noFill} · 异常 {value.counts.abnormal} · 待核对 {value.counts.pending}</small></>},
    {label:'双腿开仓完成率',render:value=><EntryRate rows={value.rows}/>},
    {label:'已确认闭合净损益',render:value=><MoneyCell metric={value.amounts.closedNetPnlUsd} signed/>},
    {label:'已付手续费 · 含持仓',render:value=><MoneyCell metric={value.amounts.feesUsd}/>},
    {label:'成交滑点成本',render:value=><MoneyCell metric={value.slippageUsd} signed cost/>},
    {label:'平均成交滑点',render:value=><SampleCell metric={value.slippageBps} unit="bps"/>},
    {label:'平均两腿下单调用间隔',render:value=><SampleCell metric={executionOrderCallGapMetric(value.rows)}/>},
    {label:'平均两腿确认间隔',render:value=><SampleCell metric={value.timing.firstLegConfirmationGapMs}/>},
    {label:'平均观察裸露时间',render:value=><SampleCell metric={value.timing.unhedgedObservedMs} showMax/>},
    {label:'平均最长连续裸露时间',render:value=><SampleCell metric={value.timing.longestUnhedgedObservedMs} showMax/>},
    {label:'已确认补偿成本',render:value=><MoneyCell metric={value.amounts.rollbackCostUsd} signed cost/>},
    {label:'实际 Maker 手续费节省',render:value=><MoneyCell metric={value.amounts.makerFeeSavingUsd} signed/>},
  ];
  return <div className="execution-statistics" data-testid="execution-statistics">
    <section className="panel execution-stats-intro"><div><h2>策略结果与执行质量</h2><p>查看每次操作的完成情况、阶段等待和真实账本结果；入场方式与本次平仓方式分别统计。</p></div>
      <span className="execution-stats-updated">账本同步 {executionTime(summary.timestamp)}</span></section>
    <TradingOperationStatistics summary={summary.operations}/>
    <section className="panel execution-stats-controls" aria-label="统计范围">
      <div className="execution-stats-filter-line"><span>入场方式</span><div className="execution-stats-segment">
        <button type="button" aria-pressed={method==='all'} onClick={()=>{setMethod('all');resetPage();}}>全部<small>{count({entryPath})}</small></button>
        {methods.map(item=><button key={item} type="button" aria-pressed={method===item} onClick={()=>{setMethod(item);resetPage();}}>{executionMethodLabels[item]}<small>{count({method:item,entryPath})}</small></button>)}
      </div></div>
      <div className="execution-stats-filter-line"><span>入场分区</span><div className="execution-stats-segment">
        <button type="button" aria-pressed={entryPath==='all'} onClick={()=>{setEntryPath('all');resetPage();}}>全部<small>{count({method})}</small></button>
        {paths.map(item=><button key={item} type="button" aria-pressed={entryPath===item} onClick={()=>{setEntryPath(item);resetPage();}}>{executionPathLabels[item]}<small>{count({method,entryPath:item})}</small></button>)}
      </div></div>
      <div className="execution-stats-filter-line"><span>交易模式</span><div className="execution-stats-segment">
        {([['live','实盘'],['paper','模拟'],['all','全部']] as const).map(([item,label])=><button key={item} type="button" aria-pressed={mode===item} onClick={()=>{setMode(item);resetPage();}}>{label}</button>)}
      </div></div>
      <p className="execution-stats-scope">自动单轮收益：单轮预计净收益为正，且本批对手价1价格优势 &gt;20 bps。自动价差路径：本批对手价1 &gt;100 bps、实际 IOC 限价优势 &gt;80 bps、预计净资金费 &gt;0。</p>
    </section>
    <div className="execution-stats-cards">
      <MoneyStat label="正常闭合净收益" metric={normal.amounts.closedNetPnlUsd} featured caption="成功形成双腿对冲后闭合的利润与亏损"/>
      <MoneyStat label="异常执行成本" metric={abnormal.amounts.rollbackCostUsd} cost caption="已确认补偿费用减价格损益；正值为成本"/>
      <MoneyStat label="全部已确认闭合净损益" metric={scoped.amounts.closedNetPnlUsd} caption="含正常与异常闭合结果，扣已付费用"/>
      <div className="execution-stats-card" data-execution-stat="双腿开仓完成率"><span>双腿开仓完成率</span><strong>{rate.percent===null?'无样本':`${executionNumber(Math.round(rate.percent*10)/10)}%`}</strong>
        <p>{rate.succeeded} / {rate.resolved} 次已确定尝试<br/>{rate.unknown} 次待核对 · {rate.external} 条导入记录不计入分母</p></div>
    </div>
    <section className="panel execution-stats-comparison"><header><h3>入场方式 · IOC / Maker + IOC 对比</h3><p>{entryPath==='all'?'全部入场分区':executionPathLabels[entryPath]} · {mode==='live'?'实盘':mode==='paper'?'模拟':'实盘与模拟'} · 按入场方式归组，不代表平仓方式；完成率以已确定入场尝试为分母，待核对另列。</p></header>
      <div className="table-scroll"><table><thead><tr><th>指标</th>{methods.map((item,index)=><th key={item}>{executionMethodLabels[item]}<small>{comparison[index].counts.total?'已记录实际执行':'无样本'}</small></th>)}</tr></thead>
        <tbody>{compareRows.map(item=><tr key={item.label}><td>{item.label}</td>{comparison.map((value,index)=><td key={methods[index]}>{item.render(value)}</td>)}</tr>)}</tbody></table></div>
      <p className="execution-stats-note">手续费、滑点与补偿成本有重叠，不能重复相加。净收益只用闭合成交与已确认账单；持仓标记损益和开仓前预测不计入。两腿下单调用间隔按本地 adapter 调用起点统计，包含其内部准备，不能当作交易所收单间隔或裸露时间；历史订单记录间隔留在证据中。Maker 节省须有实际 Maker 成交及同期官方 Taker 费率证据，空样本不代表已运行。不同样本的结果只作观察比较。</p>
    </section>
    <MakerCloseComparisons/>
    <section className="panel execution-stats-records"><header><div><h3>执行明细</h3><p>按开仓时间和策略 ID 固定排序；数值更新不会改变位置。</p></div>
      <div className="execution-stats-record-controls"><label><Search size={14}/><input aria-label="搜索执行明细" value={search} placeholder="币种、交易所或订单 ID" onChange={event=>{setSearch(event.target.value);resetPage();}}/></label>
        <label>结果<select aria-label="执行结果筛选" value={result} onChange={event=>{setResult(event.target.value as ExecutionResultFilter);resetPage();}}>
          {Object.entries(executionResultLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}
        </select></label></div></header>
      <div className="execution-stats-exports"><span>下载当前筛选范围的全部页，仅保存到本机。CSV 包含闭合记录，空值表示待核对；JSON 保留持仓、原订单与预测证据。</span>
        <div><button type="button" disabled={!closedExportCount} onClick={()=>downloadLocalFile(`execution-closed-${exportDay}.csv`,executionClosedCsv(visible),'text/csv;charset=utf-8')}><Download size={13}/>闭合明细 CSV ({closedExportCount})</button>
          <button type="button" disabled={!visible.length} onClick={()=>downloadLocalFile(`execution-evidence-${exportDay}.json`,executionEvidenceJson(visible,summary.timestamp,{method,entryPath,mode},search,result),'application/json;charset=utf-8')}><Download size={13}/>完整证据 JSON</button></div>
      </div>
      <p className="execution-stats-note">搜索和结果筛选仅作用于明细；上方统计按执行方式、入场分区及交易模式计算。点击证据查看原始订单和当时预测。</p>
      {paging.rows.length?<div className="table-scroll"><table className="execution-stats-record-table"><thead><tr>
        <th>币种 / 开仓时间</th><th>方式 / 入场分区</th><th>结果</th><th>闭合净损益 / 费用</th><th>滑点 / 补偿成本</th><th>下单调用间隔 / 裸露时间</th><th>证据</th>
      </tr></thead><tbody>{paging.rows.map(row=><Fragment key={row.id}><tr data-execution-record={row.id}>
        <td><b className="execution-stats-row-title">{row.base}</b><small>{executionTime(row.openedAt)}<br/>多 {row.longExchange??'—'} / 空 {row.shortExchange??'—'}</small></td>
        <td>{executionMethodLabels[row.method]}<small>{executionPathLabels[row.entryPath]} · {row.mode==='live'?'实盘':'模拟'}</small></td>
        <td><span className={`execution-stats-result ${row.status==='abnormal'?'abnormal':row.status==='pending'?'pending':''}`}>{resultLabel(row)}</span><small className="execution-stats-record-reason">{row.reason}</small></td>
        <td><b className={executionTone(row.amounts.closedNetPnlUsd)}>{row.closed||row.closeRecorded?(row.amounts.closedNetPnlUsd===null?'待核对':executionMoney(row.amounts.closedNetPnlUsd,true)):'尚未闭合'}</b><small>已付费用 {executionMoney(row.amounts.feesUsd)}</small></td>
        <td>{executionMoney(row.slippageUsd,true)}<small>补偿成本 {executionMoney(row.amounts.rollbackCostUsd,true)}</small></td>
        <td>{executionDuration(row.timingBasis?.submission==='outbound'?row.timing.firstLegSubmissionGapMs:null)}<small>裸露 {executionDuration(row.timing.unhedgedObservedMs)}</small></td>
        <td><button type="button" className="execution-stats-evidence-toggle" aria-expanded={expanded.has(row.id)} aria-controls={`execution-evidence-${row.id}`} onClick={()=>toggle(row.id)}>
          {expanded.has(row.id)?'收起':'展开'}<ChevronDown size={13}/></button></td>
      </tr>{expanded.has(row.id)&&<tr className="execution-stats-evidence-row"><td colSpan={7} id={`execution-evidence-${row.id}`}><ExecutionRowEvidence row={row}/></td></tr>}</Fragment>)}</tbody></table></div>:
        <div className="execution-stats-empty">{scoped.counts.total?'没有符合筛选条件的执行记录':'该统计范围暂无执行样本'}</div>}
      <div className="execution-stats-pagination"><span>第 {paging.start}–{paging.end} 条 / {visible.length} 条</span><label>每页 <select aria-label="每页执行记录数" value={pageSize} onChange={event=>{setPageSize(Number(event.target.value));resetPage();}}>{[10,25,50].map(size=><option key={size} value={size}>{size}</option>)}</select> 条</label>
        <div><button type="button" disabled={paging.page<=1} onClick={()=>setPage(paging.page-1)} aria-label="执行明细上一页"><ChevronLeft size={14}/></button>
          <span>{paging.page} / {paging.pageCount}</span><button type="button" disabled={paging.page>=paging.pageCount} onClick={()=>setPage(paging.page+1)} aria-label="执行明细下一页"><ChevronRight size={14}/></button></div></div>
    </section>
  </div>;
}
