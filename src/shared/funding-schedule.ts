import type {ExchangeId} from './types.js';

export interface FundingScheduleLeg {
  exchange:ExchangeId;side?:'long'|'short';notionalUsd:number;fundingRate:number;
  nextFundingTime:number;intervalHours:number;
}
export interface FundingCashEvent {
  time:number;longUsd:number;shortUsd:number;netUsd:number;cumulativeUsd:number;
  longCount:number;shortCount:number;
  /** This event repeats a leg's current rate into a cycle whose rate has not yet been observed. */
  projected:boolean;
}
export interface FundingEntryWindow {
  kind:'first-receipt'|'last-payment';startTime:number;endTime:number;settlementTime:number;
  /** Cycle location inferred from currently observed native clocks, not evidence of past cash receipts. */
  cycleStart:number;cycleEnd:number;smallIntervalHours:number;smallExchange:ExchangeId;smallSide:'long'|'short';smallCashUsd:number;
  phase:'before'|'open'|'after';nextStartTime?:number;nextEndTime?:number;
}
export interface FundingSchedule {
  valid:boolean;startTime:number;endTime:number;events:FundingCashEvent[];
  nextEventTime:number;nextEventUsd:number;totalUsd:number;longCount:number;shortCount:number;
  asynchronous:boolean;hasRepeatedRate:boolean;firstPositiveTime?:number;
  preReceiptPaymentsUsd:number;minCumulativeUsd:number;
  entryReady:boolean;recommendedEntryAt?:number;entryWindow?:FundingEntryWindow;reason:string;
}
export interface FundingScheduleOptions {
  now:number;entryTiming?:'last-payment'|'anytime';settlementBufferMs?:number;
  /** Compatibility input. An exit delay never adds a later cycle to the current funding window. */
  exitDelaySec?:number;
}
export const ASYNC_FUNDING_ENTRY_CHECK='异步资金费入场时点合适';
const HOUR=3_600_000,MAX_EVENTS=512,EPSILON=1e-10;
const clock=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
const money=(value:number)=>`${value<0?'−':'+'}$${Math.abs(value).toFixed(4)}`;
const cash=(leg:FundingScheduleLeg)=>leg.notionalUsd*leg.fundingRate*(leg.side==='long'?-1:1);

/** An identifiable common cycle needs native phases to agree, not merely different cycle lengths.
 * Only integer multiples are inferred. Offset, missing or changing clocks keep the event-based path. */
function cycleEntryWindow(legs:FundingScheduleLeg[],now:number,buffer:number):FundingEntryWindow|undefined {
  if(legs.length!==2||legs[0].intervalHours===legs[1].intervalHours)return;
  const [small,large]=[...legs].sort((a,b)=>a.intervalHours-b.intervalHours);
  const smallPeriod=small.intervalHours*HOUR,largePeriod=large.intervalHours*HOUR;
  if(![smallPeriod,largePeriod,small.nextFundingTime,large.nextFundingTime].every(Number.isSafeInteger)||
    smallPeriod<=2*buffer||largePeriod%smallPeriod!==0||small.nextFundingTime>large.nextFundingTime||
    (large.nextFundingTime-small.nextFundingTime)%smallPeriod!==0||
    small.nextFundingTime-smallPeriod>now||large.nextFundingTime-largePeriod>now)return;
  const smallCashUsd=cash(small);
  if(Math.abs(smallCashUsd)<=EPSILON)return;
  const cycleEnd=large.nextFundingTime,cycleStart=cycleEnd-largePeriod;
  const kind=smallCashUsd>0?'first-receipt':'last-payment';
  const settlementTime=kind==='first-receipt'?cycleStart+smallPeriod:cycleEnd;
  const startTime=(kind==='first-receipt'?cycleStart:cycleEnd-smallPeriod)+buffer;
  const endTime=settlementTime-buffer;
  const phase=now<startTime?'before':now<endTime?'open':'after';
  return {kind,startTime,endTime,settlementTime,cycleStart,cycleEnd,smallIntervalHours:small.intervalHours,
    smallExchange:small.exchange,smallSide:small.side!,smallCashUsd,phase,
    ...(phase==='after'?{nextStartTime:startTime+largePeriod,nextEndTime:endTime+largePeriod}:{})};
}

export function buildFundingSchedule(legs:FundingScheduleLeg[],options:FundingScheduleOptions):FundingSchedule;
export function buildFundingSchedule(long:FundingScheduleLeg,short:FundingScheduleLeg,options:FundingScheduleOptions):FundingSchedule;
/** Observed next clocks define the complete window. Later rates are explicit unchanged-rate projections.
 * Timing applies to a NEW hedge only. It is never a recommendation to liquidate an existing position. */
export function buildFundingSchedule(first:FundingScheduleLeg[]|FundingScheduleLeg,second:FundingScheduleOptions|FundingScheduleLeg,third?:FundingScheduleOptions):FundingSchedule {
  const options=Array.isArray(first)?second as FundingScheduleOptions:third!;
  const legs=Array.isArray(first)?first:[{...first,side:'long' as const},{...second as FundingScheduleLeg,side:'short' as const}];
  const now=options.now,endTime=Math.max(...legs.map(leg=>leg.nextFundingTime));
  const invalid=():FundingSchedule=>({valid:false,startTime:now,endTime:Number.isFinite(endTime)?endTime:now,events:[],
    nextEventTime:0,nextEventUsd:0,totalUsd:0,longCount:0,shortCount:0,asynchronous:false,hasRepeatedRate:false,
    preReceiptPaymentsUsd:0,minCumulativeUsd:0,entryReady:false,reason:'等待有效结算时钟和资金费数据；未知现金流不按零收入处理'});
  if(!Number.isFinite(now)||legs.length<1||legs.length>2||!Number.isFinite(endTime)||
    legs.some(leg=>!['long','short'].includes(leg.side??'')||
      ![leg.notionalUsd,leg.intervalHours,leg.nextFundingTime].every(value=>Number.isFinite(value)&&value>0)||
      leg.nextFundingTime<=now||!Number.isFinite(leg.fundingRate)||!Number.isFinite(cash(leg))))return invalid();
  const eventMap=new Map<number,FundingCashEvent>();
  let occurrences=0;
  for(const leg of legs){
    const interval=leg.intervalHours*HOUR;
    if(!Number.isFinite(interval)||interval<1)return invalid();
    const count=Math.floor((endTime-leg.nextFundingTime)/interval)+1;
    if(!Number.isSafeInteger(count)||count<1||occurrences+count>MAX_EVENTS)return invalid();
    occurrences+=count;
    for(let index=0;index<count;index++){
      const time=leg.nextFundingTime+index*interval;
      const event=eventMap.get(time)??{time,longUsd:0,shortUsd:0,netUsd:0,cumulativeUsd:0,longCount:0,shortCount:0,projected:false};
      if(leg.side==='long'){event.longUsd+=cash(leg);event.longCount++;}
      else{event.shortUsd+=cash(leg);event.shortCount++;}
      event.projected ||= index>0;eventMap.set(time,event);
    }
  }
  const events=[...eventMap.values()].sort((a,b)=>a.time-b.time);
  let cumulative=0,minCumulativeUsd=0;
  for(const event of events){
    event.netUsd=event.longUsd+event.shortUsd;cumulative+=event.netUsd;event.cumulativeUsd=cumulative;
    minCumulativeUsd=Math.min(minCumulativeUsd,cumulative);
    if(![event.netUsd,cumulative].every(Number.isFinite))return invalid();
  }
  const firstPositive=events.find(event=>event.netUsd>EPSILON);
  const payments=firstPositive?events.filter(event=>event.time<firstPositive.time&&event.netUsd<-EPSILON):[];
  const preReceiptPaymentsUsd=-payments.reduce((sum,event)=>sum+event.netUsd,0);
  // Settlement participants within a few seconds of the boundary are uncertain. Require
  // both fresh rolled clocks AND at least ten seconds after the avoided payment.
  const buffer=Math.max(10_000,Number.isFinite(options.settlementBufferMs)?options.settlementBufferMs!:10_000);
  let recommendedEntryAt=payments.length?payments.at(-1)!.time+buffer:undefined;
  if(firstPositive){
    const recentPrevious=new Map<number,number>();
    for(const leg of legs){
      const previous=leg.nextFundingTime-leg.intervalHours*HOUR;
      if(previous<=now&&now<previous+buffer&&previous<firstPositive.time)
        recentPrevious.set(previous,(recentPrevious.get(previous)??0)+cash(leg));
    }
    // The previous fee is unknown after rollover; this short grace is conservative timing,
    // and never inserted into the future forecast or claimed as an actual paid fee.
    for(const [time,amount] of recentPrevious)if(amount<-EPSILON)recommendedEntryAt=Math.max(recommendedEntryAt??0,time+buffer);
  }
  const entryWindow=cycleEntryWindow(legs,now,buffer);
  // In a verified common cycle, the small leg's CASH direction selects exactly one window.
  // A positive small leg enters before the first small settlement; a negative small leg
  // skips prior payments and enters only after the final early payment. Positive aggregate
  // carry does not permit opening in the middle of an already-started income cycle.
  if(entryWindow)recommendedEntryAt=entryWindow.phase==='before'?entryWindow.startTime:
    entryWindow.phase==='after'?entryWindow.nextStartTime:undefined;
  const wait=options.entryTiming!=='anytime'&&(entryWindow?entryWindow.phase!=='open':recommendedEntryAt!==undefined&&now<recommendedEntryAt);
  const windowName=entryWindow?.kind==='first-receipt'?'小周期收款首轮窗口':'小周期付款末轮窗口';
  const windowRange=entryWindow?`${clock.format(entryWindow.startTime)}—${clock.format(entryWindow.endTime)}`:'';
  const cycleReason=entryWindow?.phase==='after'?`${windowName} ${windowRange} 已过；等待下一共同周期的 ${clock.format(entryWindow.nextStartTime!)}—${clock.format(entryWindow.nextEndTime!)} 窗口，届时重新核验资金费与 IOC 优势。当前本轮预测不代表下一窗口收益`:
    entryWindow?.phase==='before'?`${windowName} ${windowRange} 尚未开始；${entryWindow.kind==='last-payment'?'先付后收，跳过前面小周期付款':'两所共同结算后、第一轮小周期收款前入场'}，结算边界前后至少留 10 秒，届时重新核验`:
    `${windowName} ${windowRange} 已开放；小周期单次预计 ${money(entryWindow?.smallCashUsd??0)}，仍须资金费与 IOC 价格优势同时通过`;
  const differentPeriods=legs.length===2&&legs[0].intervalHours!==legs[1].intervalHours;
  const neutralSmall=differentPeriods&&Math.abs(cash(legs[0].intervalHours<legs[1].intervalHours?legs[0]:legs[1]))<=EPSILON;
  const fallbackNote=neutralSmall?'；小周期当前预计净收付为零，不按首末收付窗口限制':differentPeriods&&!entryWindow?
    '；当前周期倍数或时钟相位不能确认共同周期，按实际事件判断，不假定共同结算已发生':'';
  const reason=options.entryTiming==='anytime'?'允许任意时点新建仓，不按首末窗口限制；逐次现金流仅作展示，资金费与 IOC 优势仍须通过':
    entryWindow?cycleReason:wait?`先付后收：首次净收入前有先行支出，建议 ${clock.format(recommendedEntryAt!)} 后重新核验时钟、资金费与 IOC 价格优势；结算后至少等待 10 秒${fallbackNote}`:
      `资金费入场时点已就绪；最近单次预计 ${money(events[0].netUsd)}，本轮合计 ${money(cumulative)}（费率仍会变化）${fallbackNote}`;
  return {valid:true,startTime:now,endTime,events,nextEventTime:events[0].time,nextEventUsd:events[0].netUsd,totalUsd:cumulative,
    longCount:events.reduce((sum,event)=>sum+event.longCount,0),shortCount:events.reduce((sum,event)=>sum+event.shortCount,0),
    asynchronous:legs.length>1&&(legs[0].nextFundingTime!==legs[1].nextFundingTime||legs[0].intervalHours!==legs[1].intervalHours),
    hasRepeatedRate:events.some(event=>event.projected),...(firstPositive?{firstPositiveTime:firstPositive.time}:{}),
    preReceiptPaymentsUsd,minCumulativeUsd,entryReady:!wait,...(recommendedEntryAt!==undefined?{recommendedEntryAt}:{}),...(entryWindow?{entryWindow}:{}),reason};
}
