import type {AppConfig,FundingExitStabilityDto,MarketSnapshot,Position} from '../shared/types.js';
import type {AlignedExitAssessment} from './profit-exit.js';
import {quoteIsFresh,quoteObservedAt} from './market-validity.js';

export const FUNDING_EXIT_DEFAULT_NEUTRAL_BPS=2;
export const FUNDING_EXIT_MIN_SAMPLES=5;
export const FUNDING_EXIT_SAMPLE_INTERVAL_MS=15_000;
export const FUNDING_EXIT_DIRECT_CONFIRM_MS=3*60_000;
export const FUNDING_EXIT_PROJECTED_CONFIRM_MS=10*60_000;
export const FUNDING_EXIT_PAYMENT_WINDOW_MS=5*60_000;
export const FUNDING_EXIT_MAX_GAP_MS=90_000;
export const FUNDING_EXIT_HISTORY_WINDOW_MS=15*60_000;
const MAX_SAMPLES=61,HOUR=3_600_000,BPS_EPSILON=1e-9;

/** Economic qualification only. Execution must separately check actual accrued cash and closing profit. */
export interface FundingExitStabilityAssessment extends FundingExitStabilityDto {passes:boolean}
interface Sample {at:number;bps:number}
interface LegObservation {at:number;rate:number}
interface History {
  cycle:string;samples:Sample[];
  long:LegObservation;short:LegObservation;
  acceptedLongAt:number;acceptedShortAt:number;seedPending:boolean;
}
interface Evidence {
  longAt:number;shortAt:number;pairAt:number;cycle:string;
  latestBps:number;observedNextNetUsd:number;projectedNetUsd:number;
  nextEventAt:number;nextPaymentAt?:number;neutralBandBps:number;
}

const median=(values:number[])=>{
  const sorted=[...values].sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);
  return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;
};
const closeEnough=(a:number,b:number)=>Math.abs(a-b)<=1e-8*Math.max(1,Math.abs(a),Math.abs(b));

/** Fee timestamps belong to the funding read, independently of fast book observations. */
function fundingAt(snapshot:MarketSnapshot,live:boolean,now:number,c:AppConfig):number|undefined {
  const at=snapshot.fundingObservedAt??(!live?quoteObservedAt(snapshot):undefined);
  if(!Number.isFinite(at)||at!<=0||at!>now+5000||now-at!>Math.min(c.maxSnapshotAgeMs,30_000))return;
  return at;
}

function evidence(p:Position,long:MarketSnapshot|undefined,short:MarketSnapshot|undefined,
  c:AppConfig,now:number):Evidence|undefined {
  if(!Number.isFinite(now)||!Number.isFinite(c.maxSnapshotAgeMs)||c.maxSnapshotAgeMs<=0||
    p.entryPolicy!=='aligned'||!long||!short)return;
  const l=long!,s=short!,neutralBandBps=c.exitWeakFundingBps??FUNDING_EXIT_DEFAULT_NEUTRAL_BPS;
  if(!Number.isFinite(neutralBandBps)||neutralBandBps<0||l.source!==s.source||
    l.exchange!==p.long.exchange||s.exchange!==p.short.exchange||l.base!==p.base||s.base!==p.base||
    l.symbol!==p.long.symbol||s.symbol!==p.short.symbol||
    ![p.long.quantity,p.short.quantity,l.markPrice,s.markPrice,l.intervalHours,s.intervalHours].every(v=>Number.isFinite(v)&&v>0)||
    ![l.fundingRate,s.fundingRate,l.nextFundingTime,s.nextFundingTime].every(Number.isFinite)||
    l.nextFundingTime<=now||s.nextFundingTime<=now)return;
  const longAt=fundingAt(l,p.mode==='live',now,c),shortAt=fundingAt(s,p.mode==='live',now,c);
  if(longAt===undefined||shortAt===undefined)return;
  const end=Math.max(l.nextFundingTime,s.nextFundingTime);
  const longCount=Math.floor((end-l.nextFundingTime)/(l.intervalHours*HOUR))+1;
  const shortCount=Math.floor((end-s.nextFundingTime)/(s.intervalHours*HOUR))+1;
  if(![longCount,shortCount].every(n=>Number.isSafeInteger(n)&&n>0)||longCount+shortCount>512)return;
  const longValue=p.long.quantity*l.markPrice,shortValue=p.short.quantity*s.markPrice;
  const longCash=-longValue*l.fundingRate,shortCash=shortValue*s.fundingRate;
  const observedNextNetUsd=longCash+shortCash,fullCash=longCash*longCount+shortCash*shortCount;
  const latestBps=fullCash/((longValue+shortValue)/2)*10_000;
  if(![observedNextNetUsd,fullCash,latestBps].every(Number.isFinite))return;
  const nextEvents=new Map<number,number>();
  nextEvents.set(l.nextFundingTime,longCash);
  nextEvents.set(s.nextFundingTime,(nextEvents.get(s.nextFundingTime)??0)+shortCash);
  const events=[...nextEvents].sort((a,b)=>a[0]-b[0]);
  const nextPaymentAt=events.find(([,cash])=>cash<0)?.[0];
  // A settlement clock, interval, market or configured neutral band change starts a new evidence window.
  const cycle=JSON.stringify([p.base,p.mode,l.exchange,l.symbol,l.source,l.nextFundingTime,l.intervalHours,
    s.exchange,s.symbol,s.source,s.nextFundingTime,s.intervalHours,neutralBandBps,observedNextNetUsd>0?'projected':'direct']);
  return {longAt,shortAt,pairAt:Math.min(longAt,shortAt),cycle,latestBps,observedNextNetUsd,
    projectedNetUsd:fullCash-observedNextNetUsd,nextEventAt:events[0][0],
    ...(nextPaymentAt!==undefined?{nextPaymentAt}:{}),neutralBandBps};
}

function metadataConflict(history:History,current:Evidence,long:MarketSnapshot,short:MarketSnapshot):boolean {
  return current.longAt<history.long.at||current.shortAt<history.short.at||
    current.longAt===history.long.at&&long.fundingRate!==history.long.rate||
    current.shortAt===history.short.at&&short.fundingRate!==history.short.rate;
}

function clearConflictedSamples(history:History,current:Evidence,long:MarketSnapshot,short:MarketSnapshot):void {
  history.samples=[];history.seedPending=false;
  history.acceptedLongAt=Math.max(history.acceptedLongAt,current.longAt);
  history.acceptedShortAt=Math.max(history.acceptedShortAt,current.shortAt);
  if(current.longAt>=history.long.at)history.long={at:current.longAt,rate:long.fundingRate};
  if(current.shortAt>=history.short.at)history.short={at:current.shortAt,rate:short.fundingRate};
}

/** Short-lived flips cannot submit an ordinary new shared close batch. Already filled one-leg repairs
 * deliberately live outside this tracker. Histories are process-local and cannot survive a restart as permission. */
export class FundingExitStabilityTracker {
  private histories=new Map<string,History>();
  forget(id:string):void {this.histories.delete(id);}
  clear():void {this.histories.clear();}

  evaluate(p:Position,long:MarketSnapshot|undefined,short:MarketSnapshot|undefined,
    assessment:AlignedExitAssessment|undefined,c:AppConfig,now=Date.now()):FundingExitStabilityAssessment {
    const current=evidence(p,long,short,c,now);
    const unavailable=(reason:string):FundingExitStabilityAssessment=>({status:'unavailable',passes:false,reason,
      sampleCount:0,requiredSamples:FUNDING_EXIT_MIN_SAMPLES,observedSpanMs:0,requiredSpanMs:FUNDING_EXIT_DIRECT_CONFIRM_MS});
    if(!current){this.forget(p.id);return unavailable('资金费观测时刻或当前结算数据不完整，等待独立资金费更新，未用盘口刷新代替资金费确认');}
    const {longAt,shortAt,pairAt,cycle,latestBps,observedNextNetUsd,projectedNetUsd,nextPaymentAt,neutralBandBps}=current;
    const projectedOnly=observedNextNetUsd>0;
    const requiredSpanMs=projectedOnly?FUNDING_EXIT_PROJECTED_CONFIRM_MS:FUNDING_EXIT_DIRECT_CONFIRM_MS;
    // A supplied assessment must match current funding, even when its books are temporarily unusable.
    // Missing assessments are different: a short book outage must not restart valid economic history.
    if(assessment&&(!assessment.fundingSchedule.valid||
      ![assessment.expectedFundingUsd,assessment.expectedFundingBps].every(Number.isFinite)||
      assessment.targetFundingTime!==Math.max(long!.nextFundingTime,short!.nextFundingTime)||
      !closeEnough(observedNextNetUsd+projectedNetUsd,assessment.expectedFundingUsd)||
      !closeEnough(latestBps,assessment.expectedFundingBps))){
      this.forget(p.id);return unavailable('退出估计与最新资金费数据不一致，已清除确认，等待当前资金费与盘口重新核验');
    }
    if(!assessment||!quoteIsFresh(long,c,now)||!quoteIsFresh(short,c,now)){
      const previous=this.histories.get(p.id),last=previous?.samples.at(-1);
      if(!previous||previous.cycle!==cycle||!last||now-last.at>FUNDING_EXIT_MAX_GAP_MS||pairAt-last.at>FUNDING_EXIT_MAX_GAP_MS){
        this.forget(p.id);return unavailable('平仓盘口暂不可用，等待当前盘口；资金费窗口尚未建立、已变化或观测中断超过 90 秒');
      }
      if(metadataConflict(previous,current,long!,short!)){
        clearConflictedSamples(previous,current,long!,short!);
        return unavailable('资金费时刻回退或同一时刻数据冲突，已清除退出确认，等待新的独立资金费读数');
      }
      previous.long={at:longAt,rate:long!.fundingRate};previous.short={at:shortAt,rate:short!.fundingRate};
      if(latestBps>=-neutralBandBps-BPS_EPSILON){
        previous.samples=[];previous.seedPending=false;
        previous.acceptedLongAt=longAt;previous.acceptedShortAt=shortAt;
        return {...unavailable('资金费已恢复正值或中性区，已撤销劣势退出确认；等待可用盘口，本次不提交平仓'),
          neutralBandBps,requiredSpanMs,lastObservedAt:pairAt};
      }
      return {status:'unavailable',passes:false,reason:'平仓盘口暂不可用，保留 90 秒内的资金费历史，等待可用盘口；本次未增加确认或提交平仓',
        neutralBandBps,sampleCount:previous.samples.length,requiredSamples:FUNDING_EXIT_MIN_SAMPLES,
        observedSpanMs:last.at-previous.samples[0].at,requiredSpanMs,
        medianBps:median(previous.samples.map(sample=>sample.bps)),lastObservedAt:last.at};
    }
    const values={latestBps,observedNextNetUsd,projectedNetUsd,neutralBandBps,
      ...(nextPaymentAt!==undefined?{nextPaymentAt}:{}),lastObservedAt:pairAt};
    const result=(status:FundingExitStabilityDto['status'],reason:string,history:History,passes=false):FundingExitStabilityAssessment=>{
      const samples=history.samples,observedSpanMs=samples.length>1?Math.max(0,samples.at(-1)!.at-samples[0].at):0;
      return {...values,status,passes,reason,sampleCount:samples.length,requiredSamples:FUNDING_EXIT_MIN_SAMPLES,
        observedSpanMs,requiredSpanMs,...(samples.length?{medianBps:median(samples.map(sample=>sample.bps))}: {})};
    };
    let history=this.histories.get(p.id);
    const create=():History=>({cycle,samples:[],long:{at:longAt,rate:long!.fundingRate},short:{at:shortAt,rate:short!.fundingRate},
      acceptedLongAt:longAt,acceptedShortAt:shortAt,seedPending:true});
    if(history&&metadataConflict(history,current,long!,short!)){
      clearConflictedSamples(history,current,long!,short!);history.cycle=cycle;
      return result('unavailable','资金费数据变化但独立观测时刻未推进，已清除退出确认，等待两腿新的资金费读数',history);
    }
    if(!history||history.cycle!==cycle){history=create();this.histories.set(p.id,history);}
    else {
      history.long={at:longAt,rate:long!.fundingRate};history.short={at:shortAt,rate:short!.fundingRate};
    }
    if(latestBps>0){
      history.samples=[];history.seedPending=false;history.acceptedLongAt=longAt;history.acceptedShortAt=shortAt;
      return result('positive','最新资金费合计恢复为正，继续持有，已清除劣势退出确认',history);
    }
    if(latestBps>=-neutralBandBps-BPS_EPSILON){
      history.samples=[];history.seedPending=false;history.acceptedLongAt=longAt;history.acceptedShortAt=shortAt;
      return result('neutral',`最新资金费位于 −${neutralBandBps.toFixed(2)} 至 0 bps 的中性区，继续观察，轻微波动不触发退出`,history);
    }
    const last=history.samples.at(-1);
    if(last&&(pairAt-last.at>FUNDING_EXIT_MAX_GAP_MS||now-last.at>FUNDING_EXIT_MAX_GAP_MS)){
      history=create();this.histories.set(p.id,history);
    }
    // Keep a changed-rate timestamp collision from becoming a sample on its next identical book event.
    const freshPair=longAt>history.acceptedLongAt&&shortAt>history.acceptedShortAt;
    const currentLast=history.samples.at(-1);
    if(history.seedPending||freshPair&&(!currentLast||pairAt-currentLast.at>=FUNDING_EXIT_SAMPLE_INTERVAL_MS)){
      history.samples.push({at:pairAt,bps:latestBps});history.seedPending=false;history.acceptedLongAt=longAt;history.acceptedShortAt=shortAt;
    }
    history.samples=history.samples.filter(sample=>pairAt-sample.at<=FUNDING_EXIT_HISTORY_WINDOW_MS).slice(-MAX_SAMPLES);
    const candidate=result('observing','等待资金费持续劣势确认',history);
    const stable=candidate.sampleCount>=FUNDING_EXIT_MIN_SAMPLES&&candidate.observedSpanMs>=requiredSpanMs&&
      candidate.medianBps!==undefined&&candidate.medianBps<-neutralBandBps-BPS_EPSILON;
    if(!stable)return {...candidate,reason:`等待独立资金费确认 ${candidate.sampleCount}/${FUNDING_EXIT_MIN_SAMPLES}，持续 ${(candidate.observedSpanMs/60_000).toFixed(1)}/${requiredSpanMs/60_000} 分钟；${projectedOnly?'负值主要来自未公布轮次推算，不因一次预测翻负退出':'当前与窗口中位数均须超过负方向中性区'}`};
    if(projectedOnly&&(nextPaymentAt===undefined||nextPaymentAt!==current.nextEventAt||
      nextPaymentAt<=now||nextPaymentAt-now>FUNDING_EXIT_PAYMENT_WINDOW_MS))
      return result('projection-wait','推算劣势已持续，但下一实际付款尚未进入 5 分钟窗口或此前先有收款，继续持有并复核',history);
    return result('confirmed',`资金费劣势已按独立读数持续确认 ${requiredSpanMs/60_000} 分钟${projectedOnly?'，下一实际付款已临近':''}；仍须核验盈利退出或受控资金费退出条件`,history,true);
  }
}
