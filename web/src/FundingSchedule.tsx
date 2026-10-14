import type {FundingSchedule as FundingScheduleData} from '../../src/shared/funding-schedule';

const timeFormat=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',
  hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
const moneyFormat=new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:4});
const time=(value:number|undefined)=>value!==undefined&&Number.isFinite(value)&&value>0?timeFormat.format(value):'待同步';
const money=(value:number)=>Number.isFinite(value)?`${value<0?'−':value>0?'+':''}$${moneyFormat.format(Math.abs(value))}`:'待同步';
const tone=(value:number)=>value>0?'positive':value<0?'negative':'';
const venues={binance:'Binance',bybit:'Bybit',okx:'OKX',gate:'Gate',bitget:'Bitget'};

const entryWindowLabel=(kind:'first-receipt'|'last-payment')=>kind==='first-receipt'?'首轮收款窗口':'末轮避付款窗口';
export function fundingEntryWindowCaption(schedule:FundingScheduleData|undefined):string|undefined {
  const window=schedule?.entryWindow;
  if(!schedule?.valid||!window)return undefined;
  const range=`${time(window.startTime)}—${time(window.endTime)} 前`;
  if(window.phase==='after')return `已错过${entryWindowLabel(window.kind)}；${window.nextStartTime!==undefined&&window.nextEndTime!==undefined?`下一窗口 ${time(window.nextStartTime)}—${time(window.nextEndTime)} 前`:schedule.recommendedEntryAt!==undefined?`下次 ${time(schedule.recommendedEntryAt)}`:'等待下一共同周期'}`;
  return `${entryWindowLabel(window.kind)} ${range}`;
}

export interface FundingScheduleProps {
  schedule?:FundingScheduleData;
  title?:string;
  /** A public statistics forecast does not establish current executable prices or account readiness. */
  referenceOnly?:boolean;
  /** The new-entry recommendation never asks an existing position to close or reopen. */
  forEntry?:boolean;
}

export default function FundingSchedule({schedule,title='资金费结算时序',referenceOnly=false,forEntry=false}:FundingScheduleProps){
  if(!schedule?.valid)return <section className="funding-cash-schedule funding-cash-unknown" aria-label={title}>
    <h3>{title}</h3><p>{schedule?.reason??'等待交易所有效资金费率与结算时钟；尚不能估算逐次收付。'}</p>
  </section>;
  const window=schedule.entryWindow;
  return <section className="funding-cash-schedule" aria-label={title}>
    <div className="funding-cash-heading"><h3>{title}</h3><span>{schedule.asynchronous?'异步结算 · 分开收付':'同时结算 · 按单次净额'}{referenceOnly?' · 统计参考，盘口待核验':''}</span></div>
    <dl className="funding-cash-summary">
      <div><dt>最近一次结算</dt><dd>{time(schedule.nextEventTime)}</dd></div>
      <div><dt>最近单次预计净资金费</dt><dd className={tone(schedule.nextEventUsd)}>{money(schedule.nextEventUsd)}</dd></div>
      <div><dt>双方本轮覆盖截至</dt><dd>{time(schedule.endTime)}</dd></div>
      <div><dt>本轮合计预计资金费</dt><dd className={tone(schedule.totalUsd)}>{money(schedule.totalUsd)}</dd></div>
    </dl>
    {forEntry&&<div className={`funding-cash-entry ${schedule.entryReady?'ready':'waiting'}`}>
      <strong>{schedule.entryReady?window?.phase==='open'?'当前在入场窗口':window?'任意时点模式 · 可继续核验':'结算时点已就绪':window?.phase==='after'?'已错过本轮入场窗口':'等待入场窗口'}</strong>
      {window&&<div className="funding-cash-window">
        <span><b>{entryWindowLabel(window.kind)}</b> {time(window.startTime)}—{time(window.endTime)} 前</span>
        <span>共同结算周期 {time(window.cycleStart)}—{time(window.cycleEnd)} · {venues[window.smallExchange]} {window.smallSide==='long'?'多腿':'空腿'} · {window.smallIntervalHours}h 小周期{window.smallCashUsd>0?'净收款':'净付款'} {money(window.smallCashUsd)}</span>
        <span>提交截止比结算 {time(window.settlementTime)} 提前 {Math.round((window.settlementTime-window.endTime)/1000)} 秒；周期位置按当前结算时钟推算，历史到账以账单为准。</span>
        {window.phase==='after'&&!schedule.entryReady&&<span>{window.kind==='first-receipt'?'本轮首个小周期窗口已结束':'本轮最后一个小周期窗口已结束'}，等待下一共同周期；不开中途仓。</span>}
        {window.phase==='after'&&!schedule.entryReady&&window.nextStartTime!==undefined&&window.nextEndTime!==undefined&&<span>下一入场窗口 {time(window.nextStartTime)}—{time(window.nextEndTime)} 前，届时重新核验；上方本轮合计不代表下一周期收入。</span>}
      </div>}
      <span>首次预计净收入 {schedule.firstPositiveTime===undefined?'本轮尚无净收入事件':time(schedule.firstPositiveTime)} · 此前预计净支出 {money(-schedule.preReceiptPaymentsUsd)}</span>
      {!schedule.entryReady&&schedule.recommendedEntryAt!==undefined&&<span>建议 {time(schedule.recommendedEntryAt)} 后重新核验，再判断是否开仓</span>}
      <p>{schedule.reason}</p>
    </div>}
    <details className="funding-cash-events"><summary>逐次收付与累计金额 · 多 {schedule.longCount} 次 / 空 {schedule.shortCount} 次</summary>
      <div className="funding-cash-table-scroll"><table><thead><tr><th>结算时间</th><th>多腿资金费</th><th>空腿资金费</th><th>单次净额</th><th>累计净额</th></tr></thead>
        <tbody>{schedule.events.map(event=><tr key={event.time}><td>{time(event.time)}{event.projected&&<small>后续费率按当前值假设</small>}</td>
          <td className={tone(event.longUsd)}>{event.longCount?money(event.longUsd):'本次不结算'}</td>
          <td className={tone(event.shortUsd)}>{event.shortCount?money(event.shortUsd):'本次不结算'}</td>
          <td className={tone(event.netUsd)}>{money(event.netUsd)}</td><td className={tone(event.cumulativeUsd)}>{money(event.cumulativeUsd)}</td></tr>)}</tbody></table></div>
    </details>
    <p className="funding-cash-note">{schedule.hasRepeatedRate?'后续多轮尚未公布的费率按当前值假设，实际会刷新；':''}以上仅为资金费收付，不含手续费与价格损益。最近单次金额与本轮合计分别计算。</p>
  </section>;
}
