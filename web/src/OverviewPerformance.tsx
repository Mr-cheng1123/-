import {useEffect,useState,type ReactNode} from 'react';
import {Activity,ArrowDownLeft,ArrowLeftRight,ArrowUpRight,ChevronDown,ShieldAlert} from 'lucide-react';
import type {AppState,EquityPoint} from '../../src/shared/types';
import type {PerformanceRow,PerformanceSummary} from '../../src/shared/performance-types';
import {summarizePerformanceRows} from '../../src/shared/performance-aggregation';
import {overviewPerformance} from './overview-performance';
import {pendingPerformanceRecords} from './pending-performance-records';
import {feeRebatePct} from '../../src/shared/fee-rebates';

const dollars=new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const dates=new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
const money=(value:number|null,signed=false)=>value===null||!Number.isFinite(value)?'—':
  `${value<0?'−':signed&&value>0?'+':''}$${dollars.format(Math.abs(value))}`;
const tone=(value:number|null)=>value===null?'':value<0?'negative':value>0?'positive':'';
type BucketName='normal'|'abnormal'|'pending'|'external';

function Stat({label,value,caption,icon,featured=false}:{label:string;value:number|null;caption:string;icon:ReactNode;featured?:boolean}){
  return <div className={`metric-card${featured?' featured':''}`} data-performance-metric={label}>
    <div className="metric-label">{label}<span>{icon}</span></div>
    <div className={`metric-value ${label==='正常策略交易手续费'?'':tone(value)}`}>{money(value,label!=='正常策略交易手续费')}<small>USD</small></div>
    <div className="metric-caption">{caption}</div>
  </div>;
}

function GroupDetails({summary,name,title,description,showRebates=false,records,archived=false}:{summary:PerformanceSummary;name:BucketName;title:string;description:string;showRebates?:boolean;records?:PerformanceRow[];archived?:boolean}){
  const rows=records??summary.rows.filter(row=>row.category===name),bucket=records?summarizePerformanceRows(records)[name]:summary[name];
  const displayedNet=bucket.netPnlUsd??(bucket.includedCount>0?bucket.knownNetUsd:null);
  const netLabel=bucket.netPnlUsd!==null?'累计净损益':bucket.includedCount>0?'已确认部分':'净损益待核对';
  return <details className={`overview-performance-group ${name}`} data-performance-category={name} data-performance-history={archived?'archived':undefined}>
    <summary><div><b>{title}</b><span>{bucket.count} 笔</span></div>
      <div><span>{netLabel}</span><strong className={tone(displayedNet)}>{money(displayedNet,true)}</strong><ChevronDown size={15}/></div>
    </summary>
    <p>{description}{bucket.includedCount<bucket.count&&` ${bucket.count-bucket.includedCount} 笔净损益尚未完整确认，未按零处理。`}{bucket.feesUsd!==null&&` 已确认手续费合计 ${money(bucket.feesUsd)}。`}{showRebates&&` 预计返佣 ${money(bucket.estimatedFeeRebateUsd??null)}，仅按配置计算，未核对到账。`}</p>
    {rows.length?<div className="table-scroll"><table>
      <thead><tr><th>币种 / 时间</th><th>原因</th><th>资金费</th><th>已付手续费</th><th>价格损益</th><th>转账成本</th><th>实账净损益（返佣前）</th>{showRebates&&<><th>预计返佣</th><th>返佣后估算净收益</th></>}</tr></thead>
      <tbody>{rows.map(row=><tr key={row.id} data-performance-record={row.id}>
        <td><b>{row.base}</b><small>{Number.isFinite(row.openedAt)&&row.openedAt>0?dates.format(row.openedAt):'时间待核对'}</small></td>
        <td className="overview-performance-reason">{row.reason}</td>
        <td className={tone(row.fundingUsd)}>{money(row.fundingUsd,true)}</td><td>{money(row.feesUsd)}</td>
        <td className={tone(row.spreadPnlUsd)}>{money(row.spreadPnlUsd,true)}</td><td>{money(row.transferCostUsd)}</td>
        <td className={tone(row.netPnlUsd)}>{row.netPnlUsd===null?'待核对':money(row.netPnlUsd,true)}</td>
        {showRebates&&<><td className={tone(row.estimatedFeeRebateUsd??null)}>{money(row.estimatedFeeRebateUsd??null,true)}</td>
          <td className={tone(row.estimatedNetPnlAfterRebateUsd??null)}>{money(row.estimatedNetPnlAfterRebateUsd??null,true)}</td></>}
      </tr>)}</tbody>
    </table></div>:<div className="overview-performance-empty">暂无此类记录</div>}
  </details>;
}

export default function OverviewPerformance({state,renderEquity}:{state:AppState;renderEquity:(points:EquityPoint[])=>ReactNode}){
  const [now,setNow]=useState(Date.now);
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),5000);return()=>clearInterval(timer);},[]);
  const summary=overviewPerformance(state,Math.max(now,Date.now()));
  if(!summary)return <section className="panel overview-performance-waiting" role="status">
    <ShieldAlert size={18}/><div><b>等待策略统计同步</b><p>服务端尚未返回正常策略与异常执行分类，刷新后继续同步。</p></div>
  </section>;
  const normal=summary.normal,waiting=normal.count-normal.includedCount;
  const pending=pendingPerformanceRecords(state,summary,Math.max(now,Date.now()));
  const showRebates=feeRebatePct('gate',state.config)>0||feeRebatePct('bitget',state.config)>0;
  const feeCost=showRebates?normal.feesUsd!==null&&typeof normal.estimatedFeeRebateUsd==='number'&&
    Number.isFinite(normal.estimatedFeeRebateUsd)?normal.feesUsd-normal.estimatedFeeRebateUsd:null:normal.feesUsd;
  const closedCount=summary.rows.filter(row=>row.category==='normal'&&row.closed&&row.netPnlUsd!==null).length;
  return <div className="overview-performance" data-testid="overview-performance">
    <div className="overview-performance-scope"><b>正常双腿策略 · {normal.count} 组</b>
      <span>包含正常交易的盈利与亏损{state.config.mode==='live'?'；持有仓位按最新账户价格损益计价':'；当前为纸面交易统计'}</span>
    </div>
    <div className="metrics-grid">
      <Stat label="正常策略累计净收益" value={normal.netPnlUsd} featured icon={<ArrowUpRight size={18}/>}
        caption={normal.netPnlUsd===null?normal.includedCount>0?`已确认部分 ${money(normal.knownNetUsd,true)} · ${waiting} 组待完整核对`:
          `${waiting} 组净收益待完整核对`:'返佣前实账口径 · 已实现 + 未实现，扣已付成本；未扣预计平仓费'}/>
      <Stat label="正常策略资金费收入" value={normal.fundingUsd} icon={<ArrowDownLeft size={18}/>}
        caption={state.config.mode==='paper'?'正常双腿模拟结算 · 非到账收益':'正常双腿策略全生命周期 · 已确认到账账单'}/>
      <Stat label="正常策略交易手续费" value={feeCost} icon={<ArrowLeftRight size={18}/>}
        caption={showRebates?`${feeCost===null?'返佣待核验':'返佣后估算'} · 原扣费 ${money(normal.feesUsd)}；不含失败回滚`:
          '正常双腿策略已付开平仓费用；不含失败回滚'}/>
      <Stat label="正常策略价差损益" value={normal.spreadPnlUsd} icon={<Activity size={18}/>}
        caption={normal.spreadPnlUsd===null?'等待读取匹配仓位的最新账户价格损益':'已确认已实现价格损益 + 当前持仓未实现损益'}/>
    </div>
    {showRebates&&<div className="overview-rebate-estimate" data-testid="overview-rebate-estimate">
      <div><span>预计返佣</span><b className={tone(normal.estimatedFeeRebateUsd??null)}>{money(normal.estimatedFeeRebateUsd??null,true)}</b></div>
      <div><span>返佣后估算净收益</span><b className={tone(normal.estimatedNetPnlAfterRebateUsd??null)}>{money(normal.estimatedNetPnlAfterRebateUsd??null,true)}</b></div>
      <p>Gate {feeRebatePct('gate',state.config)}% / Bitget {feeRebatePct('bitget',state.config)}% · 按已确认正手续费计算，不读取返佣；交易手续费卡片显示返佣后估算成本，明细手续费、净收益和收益曲线保留原实账口径，预计返佣未记为到账资金。</p>
    </div>}
    <section className="panel overview-normal-records">
      <GroupDetails summary={summary} name="normal" title="正常策略明细" description="成功形成双腿对冲的策略，包含正常盈利与亏损；持仓管理暂停不改变交易分类。" showRebates={showRebates}/>
    </section>
    <section className="panel overview-execution-costs">
      <div className="overview-execution-costs-heading"><ShieldAlert size={17}/><div><h2>其他执行记录</h2><p>费用和损益保留完整记录，展开查看币种与原因。</p></div></div>
      <GroupDetails summary={summary} name="abnormal" title="异常交易与回滚" description="未形成匹配双腿或发生已核实异常中断的交易，独立列示，不计入正常策略收益。" showRebates={showRebates}/>
      <GroupDetails summary={summary} name="pending" title="待核对记录" description="尚未完成独立空仓归档或仍有原订单待确认，保留当前核对；未知成交不按零处理。" records={pending.current} showRebates={showRebates}/>
      {pending.archived.length>0&&<GroupDetails summary={summary} name="pending" title="历史待核对（已归档）" description="已确认账户敞口结束的旧记录，已移出当前待核对列表；历史成交和费用仍待核对，原订单与账本保留。" records={pending.archived} archived showRebates={showRebates}/>}
      {summary.external.count>0&&<GroupDetails summary={summary} name="external" title="账户导入与手动减仓" description="没有完整策略开仓历史的账户减仓记录，不计入正常策略收益。" showRebates={showRebates}/>}
      {summary.noFillCount>0&&<div className="overview-no-fill">{summary.noFillCount} 次确认未成交的尝试 · 已确认账目成本为零</div>}
    </section>
    <div className="overview-upper fee-only-layout"><section className="panel chart-panel overview-normal-chart" data-testid="overview-normal-closed-chart">
      <div className="section-title"><div><h2>正常策略已平仓收益曲线</h2><p>按完成时间累计 · {closedCount} 笔已确认正常交易 · 不含当前未实现损益</p></div></div>
      <div className="chart-summary"><span className="legend"><i/>已平仓净收益</span><div><span>{state.config.mode==='paper'?'可用模拟余额':'可用账户余额'}</span><b>{money(state.totals.availableBalanceUsd)}</b></div></div>
      {closedCount>0?renderEquity(summary.closedNormalEquity):<div className="overview-performance-empty"><b>尚无已确认的正常平仓交易</b><p>当前持仓损益显示在上方卡片中。</p></div>}
    </section></div>
  </div>;
}
