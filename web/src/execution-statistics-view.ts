import {
  summarizeExecutionStatisticsRows,
  type ExecutionEntryPath,
  type ExecutionMethod,
  type ExecutionMoneyMetric,
  type ExecutionSampleMetric,
  type ExecutionStatisticsRow,
  type ExecutionStatisticsSummary,
} from '../../src/shared/execution-statistics';
import {
  summarizeTradingOperations,type TradingOperation,type TradingOperationKind,type TradingOperationProtocol,
  type TradingOperationSample,type TradingOperationState,type TradingOperationsSummary,
} from '../../src/shared/trading-operations';

export type ExecutionResultFilter='all'|'closed-normal'|'held'|'abnormal'|'no-fill'|'pending'|'external';
export interface ExecutionScope {
  method:ExecutionMethod|'all';entryPath:ExecutionEntryPath|'all';mode:'live'|'paper'|'all';
}
export const executionMethodLabels:Record<ExecutionMethod,string>={ioc:'对手价1 IOC','maker-ioc':'Maker + IOC'};
export const executionPathLabels:Record<ExecutionEntryPath,string>={
  'single-cycle':'自动单轮收益','price-100':'自动价差路径',manual:'手动开仓',legacy:'历史记录',
};
export const executionResultLabels:Record<ExecutionResultFilter,string>={
  all:'全部结果','closed-normal':'正常已闭合',held:'双腿持有',abnormal:'异常执行',
  'no-fill':'确认未成交',pending:'待核对',external:'账户导入',
};
const dollars=new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const numbers=new Intl.NumberFormat('en-US',{maximumFractionDigits:8});
const dates=new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
export const executionMoney=(value:number|null|undefined,signed=false)=>typeof value!=='number'||!Number.isFinite(value)?'—':
  `${value<0?'−':signed&&value>0?'+':''}$${dollars.format(Math.abs(value))}`;
export const executionNumber=(value:number|null|undefined)=>typeof value==='number'&&Number.isFinite(value)?numbers.format(value):'—';
export const executionTime=(value:number|null|undefined)=>typeof value==='number'&&Number.isFinite(value)&&value>0?dates.format(value):'时间待核对';
export const executionDuration=(value:number|null|undefined)=>typeof value!=='number'||!Number.isFinite(value)?'—':value<1000?
  `${executionNumber(value)} ms`:`${executionNumber(value/1000)} 秒`;
export const tradingOperationKindLabels:Record<TradingOperationKind,string>={entry:'开仓',close:'策略平仓',
  'manual-close':'手动平仓','profit-exit':'自动盈利退出','funding-exit':'资金费劣势退出','emergency-close':'紧急减仓'};
export const tradingOperationProtocolLabels:Record<TradingOperationProtocol,string>={ioc:'IOC',
  'maker-ioc':'Maker + IOC',maker:'Maker',mixed:'多种方式',unknown:'方式未记录'};
export const tradingOperationStateLabels:Record<TradingOperationState,string>={running:'进行中',complete:'完整完成',
  partial:'部分完成',cancelled:'已取消',failed:'未完成',unknown:'结果未知'};
export interface TradingOperationScope {mode:'live'|'paper'|'all';kind:TradingOperationKind|'all';protocol:TradingOperationProtocol|'all'}
/** The operation cohort is independent of the historical entry-method filters. */
export function tradingOperationScopeSummary(summary:TradingOperationsSummary,scope:TradingOperationScope):TradingOperationsSummary {
  if(scope.mode==='all'&&scope.kind==='all'&&scope.protocol==='all')return summary;
  return summarizeTradingOperations(summary.rows.filter(row=>(scope.mode==='all'||row.mode===scope.mode)&&
    (scope.kind==='all'||row.kind===scope.kind)&&(scope.protocol==='all'||row.protocol===scope.protocol)),summary.timestamp);
}
export function tradingOperationRecentRows(rows:readonly TradingOperation[],limit=50):TradingOperation[] {
  const size=Number.isFinite(limit)&&limit>0?Math.min(50,Math.floor(limit)):50;
  return [...rows].sort((a,b)=>b.startedAt-a.startedAt||a.id.localeCompare(b.id)).slice(0,size);
}
export function tradingOperationPercent(value:number|null):string {
  return value===null||!Number.isFinite(value)?'无样本':`${executionNumber(Math.round(value*10)/10)}%`;
}
export function tradingOperationMetricText(metric:TradingOperationSample,value:'p50'|'p95'|'max'='p50'):string {
  return metric.knownCount>0&&metric[value]!==null?executionDuration(metric[value]):metric.unknownCount>0?'未记录':'无样本';
}
export function tradingOperationAge(row:TradingOperation,now:number):number|null {
  return ['running','partial','unknown'].includes(row.state)&&Number.isFinite(now)&&now>=row.startedAt?now-row.startedAt:null;
}
export const executionTone=(value:number|null|undefined)=>typeof value!=='number'?'':value<0?'negative':value>0?'positive':'';

/** Read-only display projection. It selects existing server facts without inferring fills or cash. */
export function executionScopeRows(rows:readonly ExecutionStatisticsRow[],scope:ExecutionScope):ExecutionStatisticsRow[] {
  return rows.filter(row=>(scope.method==='all'||row.method===scope.method)&&
    (scope.entryPath==='all'||row.entryPath===scope.entryPath)&&(scope.mode==='all'||row.mode===scope.mode));
}
export function executionScopeSummary(summary:ExecutionStatisticsSummary,scope:ExecutionScope):ExecutionStatisticsSummary {
  return summarizeExecutionStatisticsRows(executionScopeRows(summary.rows,scope),summary.timestamp);
}
export function executionNormalClosedSummary(summary:ExecutionStatisticsSummary):ExecutionStatisticsSummary {
  return summarizeExecutionStatisticsRows(summary.rows.filter(row=>row.status==='hedged'&&(row.closed||row.closeRecorded)),summary.timestamp);
}
export function executionAbnormalSummary(summary:ExecutionStatisticsSummary):ExecutionStatisticsSummary {
  return summarizeExecutionStatisticsRows(summary.rows.filter(row=>row.status==='abnormal'),summary.timestamp);
}
export function executionEntrySuccess(rows:readonly ExecutionStatisticsRow[]) {
  const succeeded=rows.filter(row=>row.status==='hedged').length;
  const resolved=rows.filter(row=>['hedged','no-fill','abnormal'].includes(row.status)).length;
  return {succeeded,resolved,unknown:rows.filter(row=>row.status==='pending').length,
    external:rows.filter(row=>row.status==='external').length,percent:resolved>0?100*succeeded/resolved:null};
}
export function executionMoneyPresentation(metric:ExecutionMoneyMetric,signed=false) {
  if(metric.knownCount===0)return {text:metric.unknownCount>0?'待核对':'无样本',caption:metric.unknownCount>0?
    `${metric.unknownCount} 笔金额待核对`:'暂无已确认金额',value:null};
  return {text:executionMoney(metric.valueUsd??metric.knownUsd,signed),value:metric.valueUsd??metric.knownUsd,
    caption:metric.unknownCount>0?`已确认部分 · ${metric.knownCount} 笔已知 / ${metric.unknownCount} 笔待核对`:`${metric.knownCount} 笔已确认`};
}
export function executionSamplePresentation(metric:ExecutionSampleMetric,unit:'duration'|'bps') {
  if(metric.mean===null||metric.knownCount===0)return {text:'无样本',caption:metric.unknownCount>0?`${metric.unknownCount} 笔无完整观察`:'暂无观察'};
  return {text:unit==='duration'?executionDuration(metric.mean):`${executionNumber(metric.mean)} bps`,
    caption:`${metric.knownCount} 笔已观察${metric.unknownCount?` / ${metric.unknownCount} 笔缺记录`:''}`};
}
/** Local adapter-call clocks include preparation inside the adapter; they are not exchange receive times. */
export function executionOrderCallGapMetric(rows:readonly ExecutionStatisticsRow[]):ExecutionSampleMetric {
  const values=rows.filter(row=>row.timingBasis?.submission==='outbound').map(row=>row.timing.firstLegSubmissionGapMs)
    .filter((value):value is number=>typeof value==='number'&&Number.isFinite(value));
  return {mean:values.length?values.reduce((sum,value)=>sum+value,0)/values.length:null,max:values.length?Math.max(...values):null,
    knownCount:values.length,unknownCount:rows.length-values.length};
}
function resultMatches(row:ExecutionStatisticsRow,result:ExecutionResultFilter):boolean {
  if(result==='all')return true;
  if(result==='closed-normal')return row.status==='hedged'&&(row.closed||row.closeRecorded);
  if(result==='held')return row.status==='hedged'&&!row.closed&&!row.closeRecorded;
  return row.status===result;
}
export function executionVisibleRows(rows:readonly ExecutionStatisticsRow[],search:string,result:ExecutionResultFilter):ExecutionStatisticsRow[] {
  const needle=search.trim().toLocaleLowerCase();
  return rows.filter(row=>resultMatches(row,result)&&(!needle||[
    row.base,row.id,row.longExchange??'',row.shortExchange??'',
    ...row.orders.flatMap(order=>[order.clientOrderId,order.nativeOrderId??'',order.symbol,order.exchange]),
  ].some(value=>value.toLocaleLowerCase().includes(needle))))
    .sort((a,b)=>(Number.isFinite(b.openedAt)?b.openedAt:0)-(Number.isFinite(a.openedAt)?a.openedAt:0)||a.id.localeCompare(b.id));
}
export function executionRowsPage<T>(rows:readonly T[],page:number,pageSize:number) {
  const size=Number.isFinite(pageSize)&&pageSize>0?Math.floor(pageSize):25;
  const pageCount=Math.max(1,Math.ceil(rows.length/size));
  const current=Math.min(Math.max(1,Number.isFinite(page)?Math.floor(page):1),pageCount);
  return {rows:rows.slice((current-1)*size,current*size),page:current,pageCount,start:rows.length?(current-1)*size+1:0,
    end:Math.min(current*size,rows.length)};
}

function csvField(value:string|number|null|undefined):string {
  if(value===null||value===undefined)return '';
  if(typeof value==='number')return Number.isFinite(value)?String(value):'';
  // Prefix spreadsheet formulas originating from text fields; numerical facts stay numeric.
  const safe=/^[\s]*[=+@-]/.test(value)?`'${value}`:value;
  return `"${safe.replaceAll('"','""')}"`;
}
/** Exports only filtered, closed strategy facts. Null amounts remain empty, never zero. */
export function executionClosedCsv(rows:readonly ExecutionStatisticsRow[]):string {
  const headers=['策略ID','币种','模式','执行方式','方式来源','入场分区','分区来源','结果','开仓本地时间戳','关闭本地时间戳',
    '已确认闭合净损益USD','资金费USD','已付费用USD','已实现价格损益USD','转账费用USD','补偿成本USD','实际Maker手续费节省USD',
    '多腿数量','空腿数量','两腿下单调用或记录间隔ms','两腿确认间隔ms','观察裸露时间ms','最长连续裸露ms','滑点成本USD','平均滑点bps','下单调用间隔口径','裸露时间口径',
    '订单证据JSON','开仓前预测JSON_不计入实际损益','补偿比较及实际结果JSON_预测成本不计入实际损益'];
  const lines=rows.filter(row=>row.status!=='external'&&row.status!=='no-fill'&&(row.closed||row.closeRecorded)).map(row=>[
    row.id,row.base,row.mode,row.method,row.methodSource,row.entryPath,row.pathSource,row.status,row.openedAt,row.closedAt,
    row.amounts.closedNetPnlUsd,row.amounts.fundingUsd,row.amounts.feesUsd,row.amounts.spreadPnlUsd,row.amounts.transferCostUsd,
    row.amounts.rollbackCostUsd,row.amounts.makerFeeSavingUsd,row.longQuantity,row.shortQuantity,
    row.timing.firstLegSubmissionGapMs,row.timing.firstLegConfirmationGapMs,row.timing.unhedgedObservedMs,
    row.timing.longestUnhedgedObservedMs,row.slippageUsd,row.slippageBps,row.timingBasis?.submission??'unknown',row.timingBasis?.exposure??'unknown',JSON.stringify(row.orders),
    row.prediction?JSON.stringify(row.prediction):null,row.compensations.length?JSON.stringify(row.compensations):null,
  ].map(csvField).join(','));
  return '\uFEFF'+[headers.map(csvField).join(','),...lines].join('\r\n');
}
export function executionEvidenceJson(rows:readonly ExecutionStatisticsRow[],timestamp:number,scope:ExecutionScope,search:string,result:ExecutionResultFilter):string {
  return JSON.stringify({version:1,exportedSnapshotAt:timestamp,scope,detailFilter:{search,result},
    notes:'金额为原始统计事实；null 为待核对；prediction 与 compensations 中的方案金额为决策时预测，不计入已确认收益；compensations 的 outcome 和已确认数量保留实际执行结果。',rows},null,2);
}
