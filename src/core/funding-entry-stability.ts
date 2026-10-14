import type {AppConfig,MarketSnapshot,Opportunity} from '../shared/types.js';
import type {FundingEntryConfirmationEvidence,FundingEntryLegEvidence,FundingEntryStabilityDto} from '../shared/funding-entry-stability.js';
import {fundingCount} from './strategy.js';
import {quoteObservedAt} from './market-validity.js';
export type {FundingEntryConfirmationEvidence,FundingEntryStabilityDto} from '../shared/funding-entry-stability.js';

export const FUNDING_ENTRY_MIN_SAMPLES=1;
export const FUNDING_ENTRY_CONFIRM_MS=0;
export const FUNDING_ENTRY_MAX_GAP_MS=60_000;
const HOUR=3_600_000,MAX_HISTORIES=20_000;
type Config=Pick<AppConfig,'mode'|'maxSnapshotAgeMs'>;
export type FundingEntryStabilityAssessment=FundingEntryStabilityDto;
interface History {
  cycle:string;pair:string;long:FundingEntryLegEvidence;short:FundingEntryLegEvidence;
  acceptedLongAt:number;acceptedShortAt:number;blocked:boolean;
}
interface Current {
  cycle:string;pair:string;at:number;fundingUsd:number;
  long:FundingEntryLegEvidence;short:FundingEntryLegEvidence;
}
const closeEnough=(a:number,b:number)=>Math.abs(a-b)<=1e-8*Math.max(1,Math.abs(a),Math.abs(b));
const pairKey=(o:Pick<Opportunity,'base'|'longExchange'|'shortExchange'>)=>JSON.stringify([o.base,...[o.longExchange,o.shortExchange].sort()]);

function legEvidence(snapshot:MarketSnapshot,c:Config,now:number):FundingEntryLegEvidence|undefined {
  // Fast books, fee overlays and repeated cache reads cannot create a new live funding observation.
  const at=snapshot.fundingObservedAt??(c.mode==='paper'&&snapshot.source==='demo'?quoteObservedAt(snapshot):undefined);
  if(!Number.isFinite(at)||at!<=0||at!>now+5000||now-at!>Math.min(c.maxSnapshotAgeMs,30_000)||
    !Number.isFinite(snapshot.fundingRate)||!Number.isFinite(snapshot.nextFundingTime)||snapshot.nextFundingTime<=now||
    !Number.isFinite(snapshot.intervalHours)||snapshot.intervalHours<=0)return;
  const cycleStart=snapshot.nextFundingTime-snapshot.intervalHours*HOUR;
  // A rolled settlement clock cannot re-label a cached observation from the previous cycle.
  if(!Number.isFinite(cycleStart)||cycleStart>now||at!<cycleStart)return;
  return {exchange:snapshot.exchange,symbol:snapshot.symbol,source:snapshot.source,fundingRate:snapshot.fundingRate,
    fundingObservedAt:at!,nextFundingTime:snapshot.nextFundingTime,intervalHours:snapshot.intervalHours};
}

function currentEvidence(o:Opportunity,long:MarketSnapshot|undefined,short:MarketSnapshot|undefined,c:Config,now:number):Current|undefined {
  if(!Number.isFinite(now)||!Number.isFinite(c.maxSnapshotAgeMs)||c.maxSnapshotAgeMs<=0||!long||!short||
    long.exchange!==o.longExchange||short.exchange!==o.shortExchange||long.base!==o.base||short.base!==o.base||
    long.exchange===short.exchange||long.source!==short.source||long.symbol!==short.symbol||
    ![o.longQuantity,o.shortQuantity,long.markPrice,short.markPrice].every(n=>Number.isFinite(n)&&n>0)||
    o.longRate!==long.fundingRate||o.shortRate!==short.fundingRate||
    o.longIntervalHours!==long.intervalHours||o.shortIntervalHours!==short.intervalHours)return;
  const l=legEvidence(long,c,now),s=legEvidence(short,c,now);
  if(!l||!s)return;
  const policy=o.entryPolicy??'dual';
  const end=policy==='aligned'?Math.max(l.nextFundingTime,s.nextFundingTime):o.exitTime;
  const longCount=fundingCount(long,end,now),shortCount=fundingCount(short,end,now);
  if(![longCount,shortCount].every(n=>Number.isSafeInteger(n)&&n>=0)||longCount+shortCount===0||longCount+shortCount>512)return;
  const fundingUsd=o.shortQuantity*short.markPrice*s.fundingRate*shortCount-
    o.longQuantity*long.markPrice*l.fundingRate*longCount;
  if(!Number.isFinite(o.expectedFundingUsd)||!Number.isFinite(fundingUsd)||!closeEnough(fundingUsd,o.expectedFundingUsd))return;
  const cycle=JSON.stringify([o.base,c.mode,policy,l.exchange,l.symbol,l.source,l.nextFundingTime,l.intervalHours,
    s.exchange,s.symbol,s.source,s.nextFundingTime,s.intervalHours]);
  return {cycle,pair:pairKey(o),at:Math.min(now,l.fundingObservedAt,s.fundingObservedAt),fundingUsd,long:l,short:s};
}

function metadataConflict(previous:History,current:Current):boolean {
  return current.long.fundingObservedAt<previous.long.fundingObservedAt||current.short.fundingObservedAt<previous.short.fundingObservedAt||
    current.long.fundingObservedAt===previous.long.fundingObservedAt&&current.long.fundingRate!==previous.long.fundingRate||
    current.short.fundingObservedAt===previous.short.fundingObservedAt&&current.short.fundingRate!==previous.short.fundingRate;
}

/** Validate the current paired funding observations for a NEW entry without a time window.
 * Local metadata fences reject conflicting clocks; no stored assessment grants permission.
 * This never refreshes data, queries fees, or authorizes a one-leg repair. */
export class FundingEntryStabilityTracker {
  private histories=new Map<string,History>();
  private directions=new Map<string,string>();

  forget(id:string):void {
    const old=this.histories.get(id);this.histories.delete(id);
    if(old&&this.directions.get(old.pair)===id)this.directions.delete(old.pair);
  }
  clear():void {this.histories.clear();this.directions.clear();}
  invalidateMissing(active:readonly Pick<Opportunity,'id'>[],now=Date.now()):void {
    const ids=new Set(active.map(o=>o.id));
    for(const [id,history] of this.histories){
      const last=Math.min(history.long.fundingObservedAt,history.short.fundingObservedAt);
      if(!ids.has(id)||now-last>FUNDING_ENTRY_MAX_GAP_MS)this.forget(id);
    }
  }

  evaluate(o:Opportunity,long:MarketSnapshot|undefined,short:MarketSnapshot|undefined,c:Config,now=Date.now()):FundingEntryStabilityAssessment {
    const empty=(status:FundingEntryStabilityDto['status'],reason:string):FundingEntryStabilityAssessment=>({status,passes:false,reason,
      sampleCount:0,requiredSamples:FUNDING_ENTRY_MIN_SAMPLES,observedSpanMs:0,requiredSpanMs:FUNDING_ENTRY_CONFIRM_MS});
    const current=currentEvidence(o,long,short,c,now);
    if(!current){this.forget(o.id);return empty('unavailable','资金费原始观测缺失、过期、跨结算轮次或与当前机会不一致，等待两腿新的资金费读数');}
    const opposite=this.directions.get(current.pair);
    if(opposite&&opposite!==o.id)this.forget(opposite);
    this.directions.set(current.pair,o.id);
    let history=this.histories.get(o.id);
    if(history&&metadataConflict(history,current)){
      history.blocked=true;history.cycle=current.cycle;
      history.acceptedLongAt=Math.max(history.acceptedLongAt,current.long.fundingObservedAt);
      history.acceptedShortAt=Math.max(history.acceptedShortAt,current.short.fundingObservedAt);
      if(current.long.fundingObservedAt>=history.long.fundingObservedAt)history.long=current.long;
      if(current.short.fundingObservedAt>=history.short.fundingObservedAt)history.short=current.short;
      return empty('unavailable','资金费时刻回退或同一观测时刻费率冲突，等待两腿新的独立资金费读数');
    }
    const freshPair=!!history&&current.long.fundingObservedAt>history.acceptedLongAt&&current.short.fundingObservedAt>history.acceptedShortAt;
    if(history&&(history.blocked||history.cycle!==current.cycle)&&!freshPair){
      history.blocked=true;history.long=current.long;history.short=current.short;
      return empty('unavailable','资金费观测冲突或结算元数据变化，等待两腿新的独立资金费读数');
    }
    if(!history){
      history={cycle:current.cycle,pair:current.pair,long:current.long,short:current.short,
        acceptedLongAt:current.long.fundingObservedAt,acceptedShortAt:current.short.fundingObservedAt,blocked:false};
      this.histories.set(o.id,history);
      // Bound only metadata fences; each assessment still checks the current observations.
      if(this.histories.size>MAX_HISTORIES)this.forget(this.histories.keys().next().value!);
    }else{
      history.cycle=current.cycle;history.long=current.long;history.short=current.short;history.blocked=false;
      history.acceptedLongAt=current.long.fundingObservedAt;history.acceptedShortAt=current.short.fundingObservedAt;
    }
    if(current.fundingUsd<=0){
      return {...empty('nonpositive','当前预计资金费合计不为正，自动开仓资金费收益门槛未通过'),latestFundingUsd:current.fundingUsd,lastObservedAt:current.at};
    }
    const evidence:FundingEntryConfirmationEvidence={version:2,base:o.base,entryPolicy:o.entryPolicy??'dual',
      firstObservedAt:current.at,lastObservedAt:current.at,sampleCount:1,observedSpanMs:0,
      requiredSamples:FUNDING_ENTRY_MIN_SAMPLES,requiredSpanMs:FUNDING_ENTRY_CONFIRM_MS,minimumFundingUsd:current.fundingUsd,
      long:{...current.long},short:{...current.short},samples:[{at:current.at,longObservedAt:current.long.fundingObservedAt,
        shortObservedAt:current.short.fundingObservedAt,fundingUsd:current.fundingUsd}]};
    return {status:'confirmed',passes:true,
      reason:'当前双腿资金费数据有效且预计净资金费为正；提交前仍须复核收益、盘口及账户费用',
      sampleCount:1,requiredSamples:FUNDING_ENTRY_MIN_SAMPLES,observedSpanMs:0,requiredSpanMs:FUNDING_ENTRY_CONFIRM_MS,
      lastObservedAt:current.at,latestFundingUsd:current.fundingUsd,minimumFundingUsd:current.fundingUsd,evidence};
  }
}
