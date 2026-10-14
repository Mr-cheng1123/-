import type { AppConfig, ExchangeId, MarketSnapshot, Opportunity } from './types.js';
import { instrumentIdentityBlockReason } from './instrument-identity.js';
import { fundingCellIsFresh, type FundingStatsCell, type FundingStatsDataset, type FundingStatsSource } from './funding-statistics.js';
import {buildFundingSchedule,type FundingSchedule} from './funding-schedule.js';
import {referenceTradingFee} from './reference-trading-fees.js';
import {effectiveFeeRate} from './fee-rebates.js';

export interface FundingCandidate {
  id:string;base:string;longExchange:ExchangeId;shortExchange:ExchangeId;
  longRate:number;shortRate:number;longIntervalHours:number;shortIntervalHours:number;
  normalized8hBps:number;aprPct:number;notionalUsd:number;nextFundingTime:number;exitTime:number;
  longFundingCount:number;shortFundingCount:number;grossFundingUsd:number;
  /** Actual event order is separate from the forecast through both next settlements. */
  fundingSchedule?:FundingSchedule;
  /** Public statistics use local official references; exact account rates are rechecked only for a financial action. */
  feesSource?:Opportunity['feesSource'];
  feesUsd:number;afterFeesUsd:number;
  slippageBudgetUsd:number;transferCostUsd:number;fundingHaircutUsd:number;basisReserveUsd:number;expectedNetUsd:number;
  /** A statistical candidate only. Execution requires an independently eligible Opportunity. */
  candidateEligible:boolean;reasons:string[];updatedAt:number;
}
export interface FundingCandidateView extends FundingCandidate {
  verification:'pending'|'verified'|'blocked';
  execution?:Opportunity;
  /** Set when the last manual verification could not produce execution detail, with the reason. */
  verifyNote?:string;
  /** Stable across a long/short reversal. Trading still uses the current directional `id`. */
  pairKey?:string;
  /** The statistical reference is kept when execution quantities/mark prices change the preferred direction. */
  statistics?:Pick<FundingCandidate,'id'|'longExchange'|'shortExchange'|'longRate'|'shortRate'|'longIntervalHours'|'shortIntervalHours'|'updatedAt'|
    'grossFundingUsd'|'feesUsd'|'feesSource'|'afterFeesUsd'|'notionalUsd'|'expectedNetUsd'|'longFundingCount'|'shortFundingCount'|'nextFundingTime'|'exitTime'|'fundingSchedule'>;
  directionChanged?:boolean;
  executionObservedAt?:number;
}
export interface FundingOpportunitiesResponse {
  source:FundingStatsSource;status:FundingStatsDataset['status'];message?:string;
  receivedAt:number;maxAgeMs:number;computedAt:number;coinCount:number;pairCount:number;verificationLimit:number;
  rows:FundingCandidateView[];
  /** Display venues backed by an actual private-account connection in live mode. */
  connectedExchanges?:ExchangeId[];
  coverage?:FundingOpportunityCoverage;
  autoVerification?:FundingAutoVerification;
}
/** Counts describe real public read attempts and currently fresh two-venue books. */
export interface FundingAutoVerification {
  enabled:boolean;running:boolean;batchSize:number;totalCoins:number;checkedCoins:number;freshCoins:number;
  pendingCoins:number;failedCoins:number;activeCoins:string[];lastBatchAt:number;nextBatchAt:number;
  /** Bounded, process-local observations. They neither grant readiness nor represent the first market signal. */
  diagnostics?:FundingVerificationDiagnostics;
}
export interface FundingVerificationReadTiming {
  exchange:ExchangeId;startedAt:number;finishedAt?:number;
  outcome:'reading'|'returned'|'failed'|'deadline'|'already-in-flight';
}
export interface FundingVerificationRouteTiming {
  id:string;base:string;longExchange:ExchangeId;shortExchange:ExchangeId;
  queuedAt:number;selectedAt:number;pairedAt?:number;
  selectionReason:'ioc-ready'|'positive-fee-net'|'ready'|'funding-priority'|'fair-rotation'|'discovery';
  missingExchanges:ExchangeId[];
}
export interface FundingVerificationBatchTiming {
  sequence:number;selectedAt:number;finishedAt?:number;publishStartedAt?:number;publishedAt?:number;
  outcome:'reading'|'published'|'discarded'|'publish-failed';
  routes:FundingVerificationRouteTiming[];reads:FundingVerificationReadTiming[];
}
export interface FundingVerificationDiagnostics {
  sampleLimit:number;sampleCount:number;totalBatches:number;
  queuedCoins:number;oldestQueuedAt?:number;
  queueWaitP95Ms?:number;readP95Ms?:number;publishP95Ms?:number;
  /** Percentiles use sampleCount capped by sampleLimit. Only the newest two
   * completed details travel with the list; the active batch is separate. */
  currentBatch?:FundingVerificationBatchTiming;recentBatches:FundingVerificationBatchTiming[];
}
export interface FundingOpportunityCoverage {
  statisticsCoinCount:number;pairedCoinCount:number;unpairedCoinCount:number;detailedPairCount:number;
  unpaired:Array<{base:string;validExchanges:ExchangeId[];reason:string}>;
}

type ScheduledCell=FundingStatsCell&{intervalHours:number;nextFundingTime:number};
const HOUR_MS=3_600_000;
export function fundingPairKey(pair:Pick<FundingCandidate,'base'|'longExchange'|'shortExchange'>):string {
  return JSON.stringify([pair.base,...[pair.longExchange,pair.shortExchange].sort()]);
}
/** Same venue pair survives direction changes. Public statistics remain visible even
 * when the execution check is occupied, unauthorized, warming or unavailable. */
export function pairFundingCandidateDetails(candidates:FundingCandidate[],opportunities:Opportunity[],
  snapshots:MarketSnapshot[]=[],verificationFailure:(id:string)=>string|undefined=()=>undefined,now=Date.now()):FundingCandidateView[] {
  const detailed=new Map(opportunities.map(opportunity=>[fundingPairKey(opportunity),opportunity]));
  const quotes=new Map(snapshots.map(snapshot=>[`${snapshot.exchange}:${snapshot.base}`,snapshot]));
  return candidates.map(candidate=>{
    const pairKey=fundingPairKey(candidate),execution=detailed.get(pairKey);
    const verifyNote=execution?undefined:verificationFailure(candidate.id)??verificationFailure(`${candidate.base}-${candidate.shortExchange}-${candidate.longExchange}`);
    if(!execution)return {...candidate,pairKey,verification:candidate.candidateEligible&&!verifyNote?'pending':'blocked',...(verifyNote?{verifyNote}:{})};
    const longQuote=quotes.get(`${execution.longExchange}:${execution.base}`),shortQuote=quotes.get(`${execution.shortExchange}:${execution.base}`);
    const observations=[longQuote,shortQuote].map(quote=>quote?.observedAt??quote?.timestamp);
    const executionObservedAt=observations.every(at=>typeof at==='number'&&Number.isFinite(at)&&at>0)?Math.min(...observations as number[]):undefined;
    const directionChanged=candidate.longExchange!==execution.longExchange||candidate.shortExchange!==execution.shortExchange;
    const financial=Number.isFinite(execution.expectedFundingUsd)&&Number.isFinite(execution.feesUsd)&&execution.feesUsd>=0?
      {grossFundingUsd:execution.expectedFundingUsd,feesUsd:execution.feesUsd,feesSource:execution.feesSource,
        afterFeesUsd:execution.fundingAfterFeesUsd??execution.expectedFundingUsd-execution.feesUsd,
        expectedNetUsd:Number.isFinite(execution.expectedNetUsd)?execution.expectedNetUsd:candidate.expectedNetUsd}:{};
    const fundingEndTime=execution.entryPolicy==='aligned'?execution.fundingSchedule?.endTime??
      (longQuote&&shortQuote?Math.max(longQuote.nextFundingTime,shortQuote.nextFundingTime):execution.exitTime):execution.exitTime;
    const counts=(quote:MarketSnapshot|undefined,fallback:number)=>quote&&quote.intervalHours>0&&quote.nextFundingTime>now?
      fundingCount({...quote,nextFundingTime:quote.nextFundingTime,intervalHours:quote.intervalHours},fundingEndTime):fallback;
    return {...candidate,pairKey,statistics:{id:candidate.id,longExchange:candidate.longExchange,shortExchange:candidate.shortExchange,
      longRate:candidate.longRate,shortRate:candidate.shortRate,longIntervalHours:candidate.longIntervalHours,
      shortIntervalHours:candidate.shortIntervalHours,updatedAt:candidate.updatedAt,grossFundingUsd:candidate.grossFundingUsd,
      feesUsd:candidate.feesUsd,feesSource:candidate.feesSource,afterFeesUsd:candidate.afterFeesUsd,notionalUsd:candidate.notionalUsd,expectedNetUsd:candidate.expectedNetUsd,
      longFundingCount:candidate.longFundingCount,shortFundingCount:candidate.shortFundingCount,nextFundingTime:candidate.nextFundingTime,exitTime:candidate.exitTime,
      ...(candidate.fundingSchedule?{fundingSchedule:candidate.fundingSchedule}:{})},
      directionChanged,...(executionObservedAt!==undefined?{executionObservedAt}:{}),
      id:execution.id,base:execution.base,longExchange:execution.longExchange,shortExchange:execution.shortExchange,
      longRate:execution.longRate,shortRate:execution.shortRate,longIntervalHours:execution.longIntervalHours,shortIntervalHours:execution.shortIntervalHours,
      normalized8hBps:execution.normalized8hBps,aprPct:execution.aprPct,notionalUsd:execution.notionalUsd,
      nextFundingTime:execution.nextFundingTime,exitTime:execution.exitTime,
      ...(execution.fundingSchedule?{fundingSchedule:execution.fundingSchedule}:directionChanged?{fundingSchedule:undefined}:{}),
      longFundingCount:counts(longQuote,directionChanged?candidate.shortFundingCount:candidate.longFundingCount),
      shortFundingCount:counts(shortQuote,directionChanged?candidate.longFundingCount:candidate.shortFundingCount),
      ...financial,execution,verification:execution.eligible?'verified':'blocked'};
  });
}
function validCell(cell:FundingStatsCell,dataset:FundingStatsDataset,now:number):cell is ScheduledCell {
  return fundingCellIsFresh(cell,dataset,now)&&Number.isFinite(cell.rate)&&Number.isFinite(cell.updatedAt)&&cell.updatedAt>0&&
    cell.intervalHours!==null&&Number.isFinite(cell.intervalHours)&&cell.intervalHours>0&&Number.isFinite(cell.rate/cell.intervalHours)&&
    cell.nextFundingTime!==null&&Number.isFinite(cell.nextFundingTime)&&cell.nextFundingTime>now;
}
function fundingCount(cell:Pick<ScheduledCell,'nextFundingTime'|'intervalHours'>,end:number):number {
  return end<cell.nextFundingTime?0:Math.floor((end-cell.nextFundingTime)/(cell.intervalHours*HOUR_MS))+1;
}
export function fundingOpportunityCoverage(dataset:FundingStatsDataset,config:AppConfig,candidates:FundingCandidate[],
  rows:FundingCandidateView[],now=Date.now()):FundingOpportunityCoverage {
  const enabled=new Set(config.exchanges),valid=new Map<string,Set<ExchangeId>>();
  for(const row of dataset.rows){
    if(!valid.has(row.base))valid.set(row.base,new Set());
    for(const cell of Object.values(row.cells))if(cell&&enabled.has(cell.exchange)&&validCell(cell,dataset,now))valid.get(row.base)!.add(cell.exchange);
  }
  const paired=new Set(candidates.map(candidate=>candidate.base));
  const unpaired=[...valid].filter(([base])=>!paired.has(base)).sort(([a],[b])=>a.localeCompare(b)).map(([base,venues])=>({
    base,validExchanges:[...venues].sort(),reason:venues.size===1?'仅一家交易所有当前有效费率与下一次结算时间':
      !venues.size?'当前有效费率、周期或下一次结算时间不足':'统计来源尚未就绪或已过期，等待重新同步',
  }));
  return {statisticsCoinCount:valid.size,pairedCoinCount:paired.size,unpairedCoinCount:unpaired.length,
    detailedPairCount:rows.filter(row=>!!row.execution).length,unpaired};
}

/** Statistics screen only: identity, future settlement clocks and raw funding.
 * Live statistics never consult configured trading fees; private native fees belong to execution detail.
 * Paper statistics retain configured simulation fees. Books and spread history are checked later. */
export function calculateFundingCandidates(dataset:FundingStatsDataset,config:AppConfig,now=Date.now()):FundingCandidate[]{
  if(dataset.range!=='current'||dataset.status!=='ready'||!Number.isFinite(now)||
    !Number.isFinite(dataset.maxAgeMs)||dataset.maxAgeMs<=0||!Number.isFinite(dataset.receivedAt)||dataset.receivedAt<=0||
    now-dataset.receivedAt>dataset.maxAgeMs||dataset.receivedAt>now+5000)return [];
  const n=config.orderNotionalUsd,deadline=now+config.maxHoldHours*HOUR_MS;
  if(!Number.isFinite(n)||n<=0||!Number.isFinite(deadline)||deadline<=now)return [];
  const enabled=new Set(config.exchanges),byBase=new Map<string,Map<ExchangeId,ScheduledCell>>();
  for(const row of dataset.rows){
    if(typeof row.base!=='string'||!row.base)continue;
    for(const cell of Object.values(row.cells)){
      if(!cell||!enabled.has(cell.exchange)||!validCell(cell,dataset,now))continue;
      const venues=byBase.get(row.base)??new Map<ExchangeId,ScheduledCell>();
      if(!venues.has(cell.exchange))venues.set(cell.exchange,cell);
      byBase.set(row.base,venues);
    }
  }
  const candidates:FundingCandidate[]=[];
  for(const [base,venues] of byBase){
    // Stable tie-breaking makes IDs independent of API row order.
    const cells=[...venues.values()].sort((a,b)=>a.exchange.localeCompare(b.exchange));
    for(let i=0;i<cells.length;i++)for(let j=i+1;j<cells.length;j++){
      const a=cells[i],b=cells[j];
      const exitTime=config.holdMode==='continuous'&&config.entryPolicy!=='aligned'?deadline:Math.max(a.nextFundingTime,b.nextFundingTime)+config.exitDelaySec*1000;
      const fundingEndTime=config.entryPolicy==='aligned'?Math.max(a.nextFundingTime,b.nextFundingTime):exitTime;
      const orientations=[{long:a,short:b},{long:b,short:a}].map(pair=>({...pair,cash:pair.short.rate*fundingCount(pair.short,fundingEndTime)-pair.long.rate*fundingCount(pair.long,fundingEndTime)}));
      orientations.sort((x,y)=>y.cash-x.cash||(y.short.rate/y.short.intervalHours-y.long.rate/y.long.intervalHours)-(x.short.rate/x.short.intervalHours-x.long.rate/x.long.intervalHours)||x.long.exchange.localeCompare(y.long.exchange));
      const {long,short}=orientations[0];
      const hourly=short.rate/short.intervalHours-long.rate/long.intervalHours;
      const normalized8hBps=hourly*8*10000;
      const longFundingCount=fundingCount(long,fundingEndTime),shortFundingCount=fundingCount(short,fundingEndTime);
      if(!Number.isSafeInteger(longFundingCount)||!Number.isSafeInteger(shortFundingCount))continue;
      const grossFundingUsd=n*(short.rate*shortFundingCount-long.rate*longFundingCount);
      const fundingSchedule=buildFundingSchedule({...long,fundingRate:long.rate,notionalUsd:n},
        {...short,fundingRate:short.rate,notionalUsd:n},
        {now,exitDelaySec:config.exitDelaySec,entryTiming:config.asyncFundingEntryTiming??'last-payment'});
      const live=config.mode==='live';
      const symbol=`${base}/USDT:USDT`;
      const longReference=live?referenceTradingFee(long.exchange,symbol):undefined,shortReference=live?referenceTradingFee(short.exchange,symbol):undefined;
      const longFee=effectiveFeeRate(long.exchange,live?longReference?.takerRate:config.takerFees[long.exchange],config),
        shortFee=effectiveFeeRate(short.exchange,live?shortReference?.takerRate:config.takerFees[short.exchange],config);
      const feesUsd=longFee!==undefined&&shortFee!==undefined?2*n*(longFee+shortFee):NaN;
      const feesSource=live?Number.isFinite(feesUsd)?'reference' as const:'pending' as const:'simulation' as const;
      const afterFeesUsd=grossFundingUsd-feesUsd;
      // Retired cost budgets stay on the row so old UI fields still parse, and they are always zero.
      const slippageBudgetUsd=0,transferCostUsd=0,fundingHaircutUsd=0,basisReserveUsd=0,expectedNetUsd=afterFeesUsd;
      const aprPct=hourly*24*365*100;
      if(![grossFundingUsd,slippageBudgetUsd,transferCostUsd,fundingHaircutUsd,basisReserveUsd,normalized8hBps,aprPct,exitTime].every(Number.isFinite)||
        !live&&![feesUsd,afterFeesUsd,expectedNetUsd].every(Number.isFinite))continue;
      const blockers:string[]=[];
      const identityReason=instrumentIdentityBlockReason(base,long.exchange,short.exchange);
      if(identityReason)blockers.push(identityReason);
      const nextFundingTime=Math.min(long.nextFundingTime,short.nextFundingTime);
      // Statistics-level screen = the first question of the full check; the rest needs the order books and spread history.
      if(nextFundingTime-now<=3000)blockers.push('距离结算过近');
      if(longFundingCount<1||shortFundingCount<1)blockers.push('持有期无法覆盖两腿下一次结算');
      if(grossFundingUsd<=0)blockers.push('预计资金费不为正');
      if(config.entryPolicy==='aligned'&&!fundingSchedule.entryReady)blockers.push(fundingSchedule.reason);
      const pending=config.entryPolicy==='aligned'?['实时可成交多空价格与账户余额待核验','资金费与可成交价差同向待核验']:
        config.entryPolicy==='funding'?['完整开平仓盘口与账户余额待核验','按基差不变估算的往返成本待核验']:['盘口可成交量、价差历史和账户余额待核验','实际开仓价差与历史退出价差待核验'];
      candidates.push({id:`${base}-${long.exchange}-${short.exchange}`,base,longExchange:long.exchange,shortExchange:short.exchange,
        longRate:long.rate,shortRate:short.rate,longIntervalHours:long.intervalHours,shortIntervalHours:short.intervalHours,
        normalized8hBps,aprPct,notionalUsd:n,nextFundingTime,exitTime,longFundingCount,shortFundingCount,grossFundingUsd,fundingSchedule,feesUsd,feesSource,afterFeesUsd,
        slippageBudgetUsd,transferCostUsd,fundingHaircutUsd,basisReserveUsd,expectedNetUsd,candidateEligible:blockers.length===0,
        reasons:[...blockers,...pending],updatedAt:Math.min(long.updatedAt,short.updatedAt)});
    }
  }
  // Live discovery has raw funding evidence, while its private trading fees remain unknown.
  // Blocked rows remain visible; eligibility never changes this discovery order.
  return candidates.sort((a,b)=>(config.mode==='live'||config.entryPolicy==='aligned'?b.grossFundingUsd-a.grossFundingUsd:b.expectedNetUsd-a.expectedNetUsd)||a.id.localeCompare(b.id));
}
