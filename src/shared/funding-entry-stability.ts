import type {ExchangeId,MarketSnapshot} from './types.js';

/** Original public funding observations, independent of order-book or account-fee refreshes. */
export interface FundingEntryLegEvidence {
  exchange:ExchangeId;symbol:string;source:MarketSnapshot['source'];
  fundingRate:number;fundingObservedAt:number;nextFundingTime:number;intervalHours:number;
}
export interface FundingEntryConfirmationEvidence {
  /** v1: historical continuous confirmation; v2: current paired funding check, without waiting. */
  version:1|2;base:string;entryPolicy:'aligned'|'funding'|'dual';
  firstObservedAt:number;lastObservedAt:number;sampleCount:number;observedSpanMs:number;
  requiredSamples:number;requiredSpanMs:number;minimumFundingUsd:number;
  long:FundingEntryLegEvidence;short:FundingEntryLegEvidence;
  /** Accepted independent paired read times and their whole-target forecasts. Never actual settled cash. */
  samples:{at:number;longObservedAt:number;shortObservedAt:number;fundingUsd:number}[];
}
export interface FundingEntryStabilityDto {
  status:'unavailable'|'nonpositive'|'observing'|'confirmed';passes:boolean;reason:string;
  sampleCount:number;requiredSamples:number;observedSpanMs:number;requiredSpanMs:number;
  lastObservedAt?:number;latestFundingUsd?:number;minimumFundingUsd?:number;
  evidence?:FundingEntryConfirmationEvidence;
}
