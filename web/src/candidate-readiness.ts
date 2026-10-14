import type { AppState } from '../../src/shared/types';
import { fundingPairKey, type FundingCandidateView, type FundingOpportunitiesResponse } from '../../src/shared/funding-opportunities';
import { isPositionActive } from '../../src/shared/ledger-lifecycle';
import { compareCandidateProfits, type CandidateSortKey } from './candidate-profit';
import { entryExecutionReady, iocEdgeExceeds } from './entry-policy';

export interface CandidateReadinessContext {
  state:AppState;
  data:FundingOpportunitiesResponse|null;
  now:number;
  synchronized:boolean;
  unavailable?:boolean;
  pendingBases?:ReadonlySet<string>;
  verifyingPairs?:ReadonlySet<string>;
}

const validTime=(value:number):boolean=>Number.isFinite(value)&&value>0;
export function candidateIsFresh(row:FundingCandidateView,data:FundingOpportunitiesResponse,now:number):boolean {
  return Number.isFinite(now)&&data.status==='ready'&&Number.isFinite(data.maxAgeMs)&&data.maxAgeMs>0&&validTime(row.updatedAt)&&row.updatedAt<=now+5000&&now-row.updatedAt<=data.maxAgeMs&&Number.isFinite(row.nextFundingTime)&&row.nextFundingTime>now&&Number.isFinite(row.exitTime)&&row.exitTime>now;
}

export function candidateOccupiedReason(row:FundingCandidateView,state:AppState,pendingBases?:ReadonlySet<string>):string|undefined {
  if(pendingBases?.has(row.base))return '该币种请求尚未确认，等待订单核对';
  if(state.positions.some(position=>position.base===row.base&&isPositionActive(position)))return '已持有·继续监测，仅禁止重复开仓';
  return state.liveReadiness?.excludedCoins?.find(item=>item.base===row.base)?.reasons.join('；');
}

/** Read-only preparation is visible before the session can submit orders. The
 * server must confirm the complete pair; configured credentials alone cannot
 * invent an account or an executable price. */
export function candidateReadyToStart(row:FundingCandidateView,context:CandidateReadinessContext):boolean {
  const {state,data,now,synchronized,pendingBases,unavailable,verifyingPairs}=context;
  if(unavailable||!synchronized||state.killSwitch||!data)return false;
  const opportunity=row.execution;
  // Most full-market rows have no executable evidence. Reject them before
  // scanning account positions or constructing pair keys on every clock tick.
  if(!opportunity||opportunity.entryReady!==true&&opportunity.eligible!==true)return false;
  if(!candidateIsFresh(row,data,now)||verifyingPairs?.size&&verifyingPairs.has(fundingPairKey(row))||candidateOccupiedReason(row,state,pendingBases))return false;
  const legacyAuthorized=state.config.mode!=='live'||state.liveUnlocked&&state.liveReadiness?.unlocked&&[row.longExchange,row.shortExchange].every(venue=>state.liveReadiness?.exchanges.find(item=>item.exchange===venue)?.executionAuthorized===true);
  const serverReady=opportunity?.entryReady===true||(opportunity?.entryReady===undefined&&opportunity?.eligible===true&&legacyAuthorized);
  if(!serverReady||!opportunity||!entryExecutionReady(state.config,opportunity))return false;
  if(opportunity.checks?.some(check=>check.label!=='两腿交易账户已授权'&&(check.pass===false||(check.pass===null&&check.group!=='account'))))return false;
  if(state.config.mode==='live'){
    for(const venue of [row.longExchange,row.shortExchange]){
      const account=state.liveReadiness?.exchanges.find(item=>item.exchange===venue);
      if(account?.credentialsConfigured!==true||account.supported===false)return false;
      if(opportunity.entryReady===true){
        const observed=state.livePortfolio?.exchanges.find(item=>item.exchange===venue),maxAge=state.livePortfolio?.maxAgeMs;
        if(observed?.credentialsConfigured!==true||observed.status!=='ready'||typeof observed.receivedAt!=='number'||!validTime(observed.receivedAt)||observed.receivedAt>now+5000||typeof maxAge!=='number'||!Number.isFinite(maxAge)||maxAge<=0||now-observed.receivedAt>maxAge||typeof observed.freeUsd!=='number'||!Number.isFinite(observed.freeUsd)||observed.freeUsd<0)return false;
        if(observed.positions.some(position=>position.base===row.base&&position.quantity>0))return false;
      }
    }
  }
  return candidateExecutionIsFresh(row,state,now);
}

/** Explicit manual readiness permits a click before automatic trading starts.
 * The server authorizes only that pair after another fresh account/contract check. */
export function candidateCanSubmit(row:FundingCandidateView,context:CandidateReadinessContext):boolean {
  const {state}=context,opportunity=row.execution;
  if(!candidateReadyToStart(row,context)||row.verification!=='verified'||!opportunity)return false;
  const manualReady=state.config.mode==='live'&&opportunity.entryReady===true;
  if(manualReady)return !opportunity.checks?.some(check=>check.pass===false&&check.label!=='两腿交易账户已授权');
  if(!opportunity.eligible||opportunity.checks?.some(check=>check.pass===false))return false;
  if(state.config.mode==='live'){
    if(!state.liveUnlocked||!state.liveReadiness?.unlocked)return false;
    if([row.longExchange,row.shortExchange].some(venue=>state.liveReadiness?.exchanges.find(item=>item.exchange===venue)?.executionAuthorized!==true))return false;
  }
  return true;
}

/** A fixed, explicit partition: complete account/market readiness plus IOC > 20 bps. */
export function candidateReadyWithIoc20(row:FundingCandidateView,context:CandidateReadinessContext):boolean {
  return candidateReadyToStart(row,context)&&iocEdgeExceeds(row.execution?.entryLimitPriceEdgeBps,20);
}

export function candidateExecutionIsFresh(row:FundingCandidateView,state:AppState,now:number):boolean {
  const opportunity=row.execution;
  if(!opportunity)return false;
  const maxAge=state.config.maxSnapshotAgeMs;
  const times=[opportunity.longObservedAt,opportunity.shortObservedAt];
  // Compatible older payloads have no quote observation fields. Explicit
  // observations, when supplied, must be valid and current on both legs.
  if(times.some(time=>time!==undefined)){
    if(times.some(time=>typeof time!=='number'||!validTime(time)||time>now+5000||now-time>maxAge))return false;
    if(Math.abs(times[0]!-times[1]!)>state.config.maxQuoteSkewMs)return false;
  }
  if(row.executionObservedAt!==undefined&&(!validTime(row.executionObservedAt)||row.executionObservedAt>now+5000||now-row.executionObservedAt>maxAge))return false;
  return true;
}

/** All counts use the same displayed rows and evaluation clock as the existing
 * action guards. Missing observations are not failed trading conditions. */
export function summarizeCandidateReadiness(context:CandidateReadinessContext) {
  const {data,state,now}=context,prepared=new Set<FundingCandidateView>(),ioc20=new Set<FundingCandidateView>(),submittable=new Set<FundingCandidateView>();
  let executionMissing=0,executionStale=0,executionCurrent=0,marketChecksFailed=0,marketChecksPending=0;
  for(const row of data?.rows??[]){
    if(!row.execution)executionMissing++;
    else if(!candidateIsFresh(row,data!,now)||!candidateExecutionIsFresh(row,state,now))executionStale++;
    else {
      executionCurrent++;
      const checks=row.execution.checks?.filter(check=>check.group!=='account');
      if(checks?.some(check=>check.pass===false))marketChecksFailed++;
      else if(!checks?.length||checks.some(check=>check.pass===null))marketChecksPending++;
    }
    if(candidateReadyToStart(row,context)){
      prepared.add(row);if(iocEdgeExceeds(row.execution?.entryLimitPriceEdgeBps,20))ioc20.add(row);
      if(candidateCanSubmit(row,context))submittable.add(row);
    }
  }
  return {prepared,ioc20,submittable,total:data?.rows.length??0,executionMissing,executionStale,executionCurrent,marketChecksFailed,marketChecksPending,
    computedAt:data?.computedAt,evaluatedAt:now,observationUnavailable:!!context.unavailable||!context.synchronized||!data};
}

/** Keep all rows. Prepared pairs rank first before and after the strategy starts. */
export function sortCandidateRows(rows:ReadonlyArray<FundingCandidateView>,key:CandidateSortKey,direction:'asc'|'desc',context:CandidateReadinessContext,prioritize=true):FundingCandidateView[] {
  return rows.map(row=>({row,ready:prioritize&&candidateReadyToStart(row,context)})).sort((a,b)=>Number(b.ready)-Number(a.ready)||compareCandidateProfits(a.row,b.row,key,direction,true,{requireNative:context.state.config.mode==='live',entryPolicy:context.state.config.entryPolicy})).map(item=>item.row);
}
