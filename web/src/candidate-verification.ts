import type { Opportunity } from '../../src/shared/types';
import { fundingPairKey, type FundingCandidateView } from '../../src/shared/funding-opportunities';

/** A direction may flip on fresh books, but the coin and the two venues must match. */
export const sameCandidatePair=(row:FundingCandidateView,opportunity:Opportunity):boolean=>fundingPairKey(row)===fundingPairKey(opportunity);

export function applyCandidateVerification(row:FundingCandidateView,opportunity?:Opportunity,note?:string):FundingCandidateView {
  if(!opportunity)return {...row,execution:undefined,verification:'blocked',verifyNote:note};
  if(!sameCandidatePair(row,opportunity))throw new Error('核验结果与当前币种及交易所组合不一致，请重新核验。');
  const statistics=row.statistics??{id:row.id,longExchange:row.longExchange,shortExchange:row.shortExchange,longRate:row.longRate,shortRate:row.shortRate,longIntervalHours:row.longIntervalHours,shortIntervalHours:row.shortIntervalHours,updatedAt:row.updatedAt,grossFundingUsd:row.grossFundingUsd,
    feesUsd:row.feesUsd,feesSource:row.feesSource,afterFeesUsd:row.afterFeesUsd,notionalUsd:row.notionalUsd,expectedNetUsd:row.expectedNetUsd,longFundingCount:row.longFundingCount,shortFundingCount:row.shortFundingCount,nextFundingTime:row.nextFundingTime,exitTime:row.exitTime};
  const complete=Number.isFinite(opportunity.expectedFundingUsd)&&Number.isFinite(opportunity.feesUsd)&&opportunity.feesUsd>=0;
  const swapped=row.longExchange!==opportunity.longExchange;
  return {...row,pairKey:fundingPairKey(row),statistics,directionChanged:statistics.longExchange!==opportunity.longExchange,
    id:opportunity.id,longExchange:opportunity.longExchange,shortExchange:opportunity.shortExchange,
    longRate:opportunity.longRate,shortRate:opportunity.shortRate,longIntervalHours:opportunity.longIntervalHours,shortIntervalHours:opportunity.shortIntervalHours,
    longFundingCount:swapped?row.shortFundingCount:row.longFundingCount,shortFundingCount:swapped?row.longFundingCount:row.shortFundingCount,
    normalized8hBps:opportunity.normalized8hBps,aprPct:opportunity.aprPct,notionalUsd:opportunity.notionalUsd,
    ...(complete?{grossFundingUsd:opportunity.expectedFundingUsd,feesUsd:opportunity.feesUsd,feesSource:opportunity.feesSource,afterFeesUsd:opportunity.fundingAfterFeesUsd??opportunity.expectedFundingUsd-opportunity.feesUsd}:{}),
    nextFundingTime:opportunity.nextFundingTime,exitTime:opportunity.exitTime,execution:opportunity,verifyNote:undefined,verification:opportunity.eligible?'verified':'blocked'};
}
