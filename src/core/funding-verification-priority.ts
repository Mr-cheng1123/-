import {fundingPairKey,type FundingCandidate} from '../shared/funding-opportunities.js';
import {instrumentIdentityBlockReason} from '../shared/instrument-identity.js';
import type {AppConfig,Opportunity} from '../shared/types.js';

export interface FundingVerificationPriorityOptions {
  config:Pick<AppConfig,'mode'|'entryPolicy'>;
  opportunities:readonly Opportunity[];
  prefer:(candidate:FundingCandidate)=>boolean;
  /** The caller validates both legs' current books and entry readiness. */
  ready:(opportunity:Opportunity)=>boolean;
}

const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const feeSourceKnown=(source:Opportunity['feesSource'],mode:AppConfig['mode'])=>mode==='live'
  ?source==='exchange'||source==='reference'
  :source===undefined||source==='simulation'||source==='exchange'||source==='reference';

/** Read priorities grant observation time only, never financial execution permission.
 * Complete execution finances take precedence over their nominal statistics;
 * aligned estimates subtract four fees without adding book losses or basis PnL. */
export function buildFundingVerificationPriorities(candidates:readonly FundingCandidate[],options:FundingVerificationPriorityOptions):Map<string,number> {
  const details=new Map(options.opportunities.map(opportunity=>[fundingPairKey(opportunity),opportunity]));
  const priorities=new Map<string,number>();
  for(const candidate of candidates){
    let priority=0;
    if(options.prefer(candidate)&&!instrumentIdentityBlockReason(candidate.base,candidate.longExchange,candidate.shortExchange)){
      const opportunity=details.get(fundingPairKey(candidate));
      const ready=!!opportunity&&options.ready(opportunity);
      if(ready&&finite(opportunity!.entryLimitPriceEdgeBps)&&opportunity!.entryLimitPriceEdgeBps!>20+1e-9)priority=4;
      else {
        const executionFinancial=!!opportunity&&feeSourceKnown(opportunity.feesSource,options.config.mode)&&
          finite(opportunity.expectedFundingUsd)&&opportunity.expectedFundingUsd>=0&&finite(opportunity.feesUsd)&&opportunity.feesUsd>=0;
        const referenceFinancial=!opportunity&&(options.config.mode==='live'?candidate.feesSource==='reference':feeSourceKnown(candidate.feesSource,options.config.mode))&&
          finite(candidate.grossFundingUsd)&&finite(candidate.feesUsd)&&candidate.feesUsd>=0;
        const fundingAfterFees=executionFinancial?opportunity!.expectedFundingUsd-opportunity!.feesUsd:
          referenceFinancial?candidate.grossFundingUsd-candidate.feesUsd:NaN;
        const aligned=(opportunity?.entryPolicy??options.config.entryPolicy)==='aligned';
        const completeNetPositive=!aligned&&executionFinancial&&finite(opportunity!.combinedExpectedNetUsd)&&opportunity!.combinedExpectedNetUsd!>0;
        if(finite(fundingAfterFees)&&fundingAfterFees>0||completeNetPositive)priority=3;
        else if(ready)priority=2;
      }
    }
    priorities.set(candidate.id,priority);
  }
  return priorities;
}

const descendingFinite=(a:number,b:number)=>finite(a)?finite(b)?b-a:-1:finite(b)?1:0;

/** Existing discovery ordering owns tier zero, including its fairness history. */
export function compareFundingVerificationPriority(a:FundingCandidate,b:FundingCandidate,priorities:ReadonlyMap<string,number>):number {
  const aPriority=priorities.get(a.id)??0,bPriority=priorities.get(b.id)??0;
  return bPriority-aPriority||(aPriority>0?descendingFinite(a.normalized8hBps,b.normalized8hBps)||
    descendingFinite(a.grossFundingUsd,b.grossFundingUsd)||a.id.localeCompare(b.id):0);
}
