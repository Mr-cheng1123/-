import type {FundingCandidate} from '../shared/funding-opportunities.js';
import {compareFundingVerificationPriority} from './funding-verification-priority.js';

export interface FundingWatchSelection {
  candidate:FundingCandidate;expiresAt:number;selectedAt:number;manual:boolean;
  kind?:'core'|'discovery';
}
export interface FundingWatchScheduleInput {
  candidates:readonly FundingCandidate[];
  watched:ReadonlyMap<string,FundingWatchSelection>;
  checked:ReadonlyMap<string,number>;
  excludedBases:ReadonlySet<string>;
  now:number;durationMs:number;limit:number;discoverySlots:number;
  ranking?:'after-fees'|'gross-funding';
  /** Trading-ready routes receive core priority, while public discovery remains available. */
  preferCore?:(candidate:FundingCandidate)=>boolean;
  /** Keep actionable pairs fresh instead of evicting them for an unchecked high rate. */
  readyBases?:ReadonlySet<string>;
  /** Read scheduling evidence only; never creates execution readiness. */
  verificationPriorities?:ReadonlyMap<string,number>;
  canFit:(candidate:FundingCandidate,selected:ReadonlyMap<string,FundingWatchSelection>)=>boolean;
}

/** Four income-ranked coins keep a continuous baseline; two discovery coins rotate
 * within the same profitability tier. Selection never manufactures market observations. */
export function scheduleFundingWatches(input:FundingWatchScheduleInput):{
  watched:Map<string,FundingWatchSelection>;checked:Map<string,number>;
} {
  const {candidates,watched,excludedBases,now,durationMs,limit,canFit}=input;
  const score=(candidate:FundingCandidate)=>input.ranking==='gross-funding'?candidate.grossFundingUsd:candidate.afterFeesUsd;
  const priority=(candidate:FundingCandidate)=>input.verificationPriorities?.get(candidate.id)??0;
  const priorityOrder=(a:FundingCandidate,b:FundingCandidate)=>input.verificationPriorities?
    compareFundingVerificationPriority(a,b,input.verificationPriorities):0;
  const tier=(candidate:FundingCandidate)=>candidate.candidateEligible?(score(candidate)>0?2:1):0;
  const profitOrder=(a:FundingCandidate,b:FundingCandidate)=>priorityOrder(a,b)||tier(b)-tier(a)||score(b)-score(a)||a.id.localeCompare(b.id);
  const checked=new Map(input.checked),selected=new Map<string,FundingWatchSelection>();
  const current=new Map(candidates.map(candidate=>[candidate.id,candidate]));
  const best=new Map<string,FundingCandidate>();
  for(const candidate of [...candidates].sort(profitOrder))if(!excludedBases.has(candidate.base)&&!best.has(candidate.base))best.set(candidate.base,candidate);
  const latest=(watch:FundingWatchSelection)=>current.get(watch.candidate.id)??best.get(watch.candidate.base);
  const remember=(candidate:FundingCandidate,at:number)=>{
    checked.set(candidate.id,Math.max(checked.get(candidate.id)??0,at));
    checked.set(`base:${candidate.base}`,Math.max(checked.get(`base:${candidate.base}`)??0,at));
  };
  const add=(candidate:FundingCandidate,prior?:FundingWatchSelection,manual=false,kind:FundingWatchSelection['kind']='discovery')=>{
    if(selected.has(candidate.base)||selected.size>=limit||!canFit(candidate,selected))return false;
    const retain=prior&&prior.expiresAt>now;
    const watch:FundingWatchSelection={candidate,selectedAt:retain?prior.selectedAt:now,
      expiresAt:retain?Math.max(prior.expiresAt,manual?prior.selectedAt+durationMs:0):now+durationMs,manual,kind};
    selected.set(candidate.base,watch);
    if(!retain)remember(candidate,now);
    return true;
  };
  for(const watch of watched.values()){
    if(watch.expiresAt<=now)remember(watch.candidate,now);
    else remember(watch.candidate,watch.selectedAt);
  }
  // A manual lookup receives its whole observation window even if it ranks below
  // automatically chosen coins. Newer manual selections win if capacity changed.
  const manual=[...watched.values()].filter(w=>w.manual&&Math.max(w.expiresAt,w.selectedAt+durationMs)>now&&!excludedBases.has(w.candidate.base))
    .sort((a,b)=>b.selectedAt-a.selectedAt||a.candidate.id.localeCompare(b.candidate.id));
  for(const watch of manual){const candidate=latest(watch)??(!candidates.length?watch.candidate:undefined);if(candidate)add(candidate,watch,true);}

  // A transient statistics outage must not discard unexpired observations. Quotes
  // can still be collected; execution separately requires a fresh candidate.
  if(!candidates.length){
    for(const watch of [...watched.values()].sort((a,b)=>profitOrder(a.candidate,b.candidate)))
      if(!excludedBases.has(watch.candidate.base)&&watch.expiresAt>now)add(watch.candidate,watch,watch.manual,watch.kind);
    return {watched:selected,checked};
  }

  const coreLimit=Math.max(0,limit-Math.min(limit,Math.max(0,input.discoverySlots)));
  const ranked=[...best.values()].sort(profitOrder);
  const preferred=new Map<string,FundingCandidate>();
  for(const candidate of [...candidates].filter(candidate=>input.preferCore?.(candidate)!==false).sort(profitOrder))
    if(!excludedBases.has(candidate.base)&&!preferred.has(candidate.base))preferred.set(candidate.base,candidate);
  for(const candidate of [...preferred.values()].sort((a,b)=>priorityOrder(a,b)||Number(input.readyBases?.has(b.base))-Number(input.readyBases?.has(a.base))||profitOrder(a,b))){
    if(selected.size>=coreLimit)break;
    // A positive fee-net reference still needs books before its settlement
    // window opens. Observation priority does not bypass that entry check.
    if(tier(candidate)!==2&&priority(candidate)<3||input.preferCore?.(candidate)===false)continue;
    add(candidate,watched.get(candidate.base),false,'core');
  }
  // Income-negative routes are still discoverable (a price advantage can pay the
  // fees), but they cannot displace income-positive routes from the core slots.
  const discovery=ranked.filter(candidate=>!selected.has(candidate.base));
  const highestTier=discovery.length?Math.max(...discovery.map(tier)):-1;
  const highestPriority=discovery.length?Math.max(...discovery.map(priority)):0;
  for(const prior of [...watched.values()].sort((a,b)=>Number(b.kind==='discovery')-Number(a.kind==='discovery')||a.selectedAt-b.selectedAt||a.candidate.id.localeCompare(b.candidate.id))){
    const candidate=best.get(prior.candidate.base);
    if(!candidate||selected.has(candidate.base)||prior.expiresAt<=now||priority(candidate)<highestPriority||
      highestPriority===0&&tier(candidate)<highestTier)continue;
    add(candidate,prior);
  }
  discovery.sort((a,b)=>priority(b)-priority(a)||tier(b)-tier(a)||(checked.get(`base:${a.base}`)??0)-(checked.get(`base:${b.base}`)??0)||
    (checked.get(a.id)??0)-(checked.get(b.id)??0)||priorityOrder(a,b)||score(b)-score(a)||a.id.localeCompare(b.id));
  for(const candidate of discovery)add(candidate);
  return {watched:selected,checked};
}
