import {useEffect,useRef,useState} from 'react';
import {RefreshCw} from 'lucide-react';
import type {MakerCloseComparisonReport} from '../../src/shared/maker-close-comparison';

const amounts=new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:6});
const dates=new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const usd=(value:number|null|undefined,signed=false)=>!finite(value)?'待核对':
  `${value<0?'−':signed&&value>0?'+':''}$${amounts.format(Math.abs(value))}`;
const tone=(value:number|null|undefined)=>!finite(value)?'':value>0?'positive':value<0?'negative':'';
const percentage=(value:number|null|undefined)=>finite(value)&&value>=0&&value<=100?`${value}%`:'未记录';

/** The local report preserves submission-time policies. Current settings never fill in old batches. */
export function MakerCloseComparisonTable({report}:{report:MakerCloseComparisonReport}){
  const estimated=report.counts.rebateEstimatedPaired??0;
  const unknown=report.counts.rebateUnknownPaired??report.counts.confirmedPaired;
  const rows=report.rows.slice().sort((a,b)=>(b.timestamp??0)-(a.timestamp??0)||(a.batchId??'').localeCompare(b.batchId??''));
  const total=report.totals;
  return <div data-testid="maker-close-comparison-report">
    <p className="execution-stats-note">已完整配对 {report.counts.confirmedPaired} 批 · 待核对 {report.counts.pending} 批 · 零成交 {report.counts.zeroFill} 批。</p>
    <div className="execution-stats-cards">
      <div className="execution-stats-card"><span>原扣费对手价1基准成本</span><strong>{usd(total.benchmarkPairCostUsd)}</strong>
        <p>返佣后估算基准成本 {estimated>0?usd(total.estimatedBenchmarkPairCostAfterRebateUsd):'无已记录比例样本'}</p></div>
      <div className="execution-stats-card"><span>原扣费实际平仓成本</span><strong>{usd(total.actualPairCostUsd)}</strong>
        <p>返佣后估算实际成本 {estimated>0?usd(total.estimatedPairCostAfterRebateUsd):'无已记录比例样本'}</p></div>
      <div className="execution-stats-card"><span>原扣费平仓总节省</span><strong className={tone(total.pairTotalSavingUsd)}>{usd(total.pairTotalSavingUsd,true)}</strong>
        <p>预计返佣后节省 {estimated>0?usd(total.estimatedPairSavingAfterRebateUsd,true):'无已记录比例样本'}</p></div>
    </div>
    <p className="execution-stats-note">原扣费汇总覆盖全部已完整配对批次；返佣后估算小计覆盖 {estimated} 批，另有 {unknown} 批返佣比例或完整估算未记录、不参与该小计。两种汇总的样本范围可能不同。</p>
    {rows.length?<details className="maker-close-comparison-records"><summary>每批 Maker 平仓比较 · {rows.length} 批</summary>
      <div className="table-scroll"><table><thead><tr><th>币种 / 提交时间 / 状态</th><th>Maker / 对侧 / 已配对数量</th>
        <th>原扣费基准 / 实际成本</th><th>原扣费节省</th><th>提交时冻结返佣比例</th><th>预计返佣基准 / 实际</th>
        <th>返佣后估算基准 / 实际成本</th><th>预计返佣后节省</th></tr></thead><tbody>{rows.map((row,index)=>
        <tr key={`${row.batchId??'unknown'}:${index}`} data-maker-close-batch={row.batchId??'unrecorded'}>
          <td><b>{row.base??'币种待核对'}</b><small>{finite(row.timestamp)&&row.timestamp>0?dates.format(row.timestamp):'时间待核对'}<br/>
            {row.status==='paired'?'已完整配对':row.status==='zero-fill'?'确认零成交':'待核对'}</small><code>{row.batchId??'批次 ID 未记录'}</code></td>
          <td>Maker {row.makerExchange??'待核对'}<small>对侧 {row.peerExchange??'待核对'}<br/>{finite(row.pairedQuantity)?amounts.format(row.pairedQuantity):'数量待核对'} 币</small></td>
          <td>{usd(row.benchmarkPairCostUsd)}<small>实际 {usd(row.actualPairCostUsd)}</small></td>
          <td className={tone(row.pairTotalSavingUsd)}>{usd(row.pairTotalSavingUsd,true)}<small>{finite(row.pairTotalSavingBps)?`${amounts.format(row.pairTotalSavingBps)} bps`:'bps 待核对'}</small></td>
          <td>{row.feeRebatePct?<>Maker {percentage(row.feeRebatePct.maker)}<small>对侧 {percentage(row.feeRebatePct.peer)}</small></>:'未记录'}</td>
          <td>{row.feeRebatePct?<>基准 {usd(row.estimatedBenchmarkFeeRebateUsd)}<small>实际 {usd(row.estimatedActualFeeRebateUsd)}</small></>:'未记录'}</td>
          <td>{row.feeRebatePct?<>基准 {usd(row.estimatedBenchmarkPairCostAfterRebateUsd)}<small>实际 {usd(row.estimatedPairCostAfterRebateUsd)}</small></>:'未记录'}</td>
          <td className={tone(row.estimatedPairSavingAfterRebateUsd)}>{row.feeRebatePct?<> {usd(row.estimatedPairSavingAfterRebateUsd,true)}
            <small>{finite(row.estimatedPairSavingAfterRebateBps)?`${amounts.format(row.estimatedPairSavingAfterRebateBps)} bps`:'bps 待核对'}</small></>:'未记录 · 不参与预计小计'}</td>
        </tr>)}</tbody></table></div></details>:<div className="execution-stats-empty">尚无 Maker 平仓比较记录</div>}
    <p className="execution-stats-note">基准为每批提交时双腿对手价1和当时账户 Taker 费率，按实际成交量比较。总节省包含价格改善与手续费差，负值表示额外成本；不保证原时点双 IOC 可成交相同数量。返佣后值只按该批冻结比例估算，未核对到账，不重复加入实账利润。旧批次不会套用当前返佣配置。</p>
  </div>;
}

/** Read the existing local journal report once when this page opens, or on explicit refresh.
 * This GET performs no exchange, fee or rebate query and never controls a trade. */
export default function MakerCloseComparisons(){
  const [report,setReport]=useState<MakerCloseComparisonReport>();
  const [error,setError]=useState(''),[loading,setLoading]=useState(false);
  const controller=useRef<AbortController|null>(null);
  const refresh=async()=>{
    if(controller.current)return;
    const request=new AbortController();controller.current=request;setLoading(true);setError('');
    try{
      const response=await fetch('/api/maker-close-comparisons',{cache:'no-store',signal:request.signal});
      if(!response.ok)throw new Error(`读取失败（HTTP ${response.status}）`);
      const result=await response.json() as MakerCloseComparisonReport;
      if(result?.benchmark!=='submission-opposite-1'||!Array.isArray(result.rows)||!result.counts||!result.totals)
        throw new Error('平仓比较尚未完整同步');
      if(!request.signal.aborted)setReport(result);
    }catch(cause){if(!request.signal.aborted)setError(cause instanceof Error?cause.message:'读取失败');}
    finally{if(controller.current===request){controller.current=null;if(!request.signal.aborted)setLoading(false);}}
  };
  useEffect(()=>{void refresh();return()=>{controller.current?.abort();controller.current=null;};},[]);
  return <section className="panel execution-stats-comparison maker-close-comparisons">
    <header><div><h3>Maker 平仓与对手价1成本对比</h3><p>全部平仓批次，独立于开仓统计筛选；打开页面或点击刷新读取本机记录。</p></div>
      <button type="button" className="btn small-btn" onClick={()=>void refresh()} disabled={loading}><RefreshCw size={13} className={loading?'spin':''}/>刷新平仓比较</button></header>
    {error&&<p className="execution-stats-note" role="status">{error}{report?'；保留上次读取的记录，点击刷新重试。':'，点击刷新重试。'}</p>}
    {report?<MakerCloseComparisonTable report={report}/>:<p className="execution-stats-note" role="status">{loading?'正在读取平仓比较记录…':'等待平仓比较记录同步'}</p>}
  </section>;
}
