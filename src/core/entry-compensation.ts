import type {AppConfig,MarketSnapshot} from '../shared/types.js';
import type {CompensationAlternative,CompensationComparisonEvidence} from '../shared/execution-statistics.js';
import {effectiveFeeRate,feeRebatePct} from '../shared/fee-rebates.js';
import {bestOppositeLevel} from './entry-batch.js';
import {floorQuantity} from './order-quantity.js';
import {alignedEntryIocEdgeBps,bookIsUncrossedWhenObserved,sweepBook} from './funding-carry.js';

export interface EntryCompensationInput {
  observedAt:number;batchId:string;long:MarketSnapshot;short:MarketSnapshot;
  longQuantity:number;shortQuantity:number;previousMatched:number;frozenTarget:number;
  /** Verified actual basis of THIS batch's unmatched leg, never the blended older position. */
  unmatchedEntryPrice:number;averagePriceVerified:boolean;originalIntentsConfirmed:boolean;
  longTakerFeeRate:number|undefined;shortTakerFeeRate:number|undefined;
  /** User-confirmed return percentages affect future cost estimates only, never native fee evidence. */
  feeRebatePct?:AppConfig['feeRebatePct'];
  /** Full missing quantity at an actual visible opposite level, including any guarded IOC buffer. */
  hedgeLimitPrice?:number;minimumPriceEdgeBps:number;
  /** Forecast for these exact paired tail coins through the same native funding-cycle endpoint. */
  predictedFundingUsd:number|undefined;projectionUntil:number;
}
export interface EntryCompensationPlan {
  evidence:CompensationComparisonEvidence&{feeRebatePct?:AppConfig['feeRebatePct']};
  reason:'unconfirmed-basis'|'invalid-quantity'|'invalid-book-or-fees'|'no-legal-alternative'|
    'hedge-cheaper'|'hedge-only-legal'|'rollback-cheaper-or-hedge-ineligible';
}
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const positive=(value:unknown):value is number=>finite(value)&&value>0;
const nonnegative=(value:unknown):value is number=>finite(value)&&value>=0;
const equal=(left:number,right:number)=>Math.abs(left-right)<=Math.max(1e-12,Math.max(Math.abs(left),Math.abs(right))*Number.EPSILON*8);
const legalQuantity=(q:number,s:MarketSnapshot)=>positive(s.quantityStep)&&nonnegative(s.minQuantity)&&q>=s.minQuantity&&
  equal(floorQuantity(q,s.quantityStep),q);

/**
 * Compare the SAME unmatched coins. Rollback closes the original leg now. Hedge opens only
 * the missing leg, then conditionally closes BOTH legs at the current close-book VWAP at
 * the funding-cycle endpoint. The existing opening fee is sunk in both alternatives.
 * Initial cross-venue price advantage is cancelled by the projected close basis; it is
 * never mistaken for realized income. Forecast funding and all future fills remain conditional.
 * This pure planner does not authorize an order or alter any booked cash.
 */
export function compareEntryCompensation(input:EntryCompensationInput):EntryCompensationPlan {
  const {long,short}=input,unmatchedSide=input.longQuantity>input.shortQuantity?'long':'short',
    q=Math.abs(input.longQuantity-input.shortQuantity);
  const evidence:EntryCompensationPlan['evidence']={observedAt:input.observedAt,batchId:input.batchId,
    unmatchedSide,unmatchedQuantity:q,decision:'wait'};
  const result=(reason:EntryCompensationPlan['reason']):EntryCompensationPlan=>({evidence,reason});
  if(!input.originalIntentsConfirmed||!input.averagePriceVerified||!positive(input.unmatchedEntryPrice))return result('unconfirmed-basis');
  if(![input.longQuantity,input.shortQuantity,input.previousMatched].every(nonnegative)||!positive(q)||
    !positive(input.frozenTarget)||Math.min(input.longQuantity,input.shortQuantity)<input.previousMatched-1e-10||
    Math.max(input.longQuantity,input.shortQuantity)>input.frozenTarget+1e-10)return result('invalid-quantity');
  const longFee=input.longTakerFeeRate,shortFee=input.shortTakerFeeRate;
  if(long.base!==short.base||long.exchange===short.exchange||long.source!==short.source||
    ![long.indexPrice,short.indexPrice].every(positive)||!bookIsUncrossedWhenObserved(long)||!bookIsUncrossedWhenObserved(short)||
    ![longFee,shortFee].every(nonnegative)||longFee!>1||shortFee!>1||!positive(input.observedAt))return result('invalid-book-or-fees');
  evidence.longTakerFeeRate=longFee!;evidence.shortTakerFeeRate=shortFee!;
  const rebateConfig={feeRebatePct:input.feeRebatePct},
    effectiveLongFee=effectiveFeeRate(long.exchange,longFee,rebateConfig)!,
    effectiveShortFee=effectiveFeeRate(short.exchange,shortFee,rebateConfig)!;
  if(input.feeRebatePct!==undefined)evidence.feeRebatePct={
    [long.exchange]:feeRebatePct(long.exchange,rebateConfig),[short.exchange]:feeRebatePct(short.exchange,rebateConfig)};
  const longAt=long.observedAt??long.timestamp,shortAt=short.observedAt??short.timestamp;
  if(positive(longAt))evidence.longBookObservedAt=longAt;
  if(positive(shortAt))evidence.shortBookObservedAt=shortAt;
  if(positive(input.projectionUntil))evidence.projectionUntil=input.projectionUntil;
  const closeLong=sweepBook(long,'bids',q),closeShort=sweepBook(short,'asks',q),
    original=unmatchedSide==='long'?long:short,rollback=unmatchedSide==='long'?closeLong:closeShort,
    complete=(book:typeof closeLong)=>book.filled>=q*(1-1e-9)&&positive(book.average)&&positive(book.value)&&positive(book.worstPrice);
  if(legalQuantity(q,original)&&complete(rollback)){
    const pricePnlUsd=q*(unmatchedSide==='long'?rollback.average-input.unmatchedEntryPrice:input.unmatchedEntryPrice-rollback.average),
      feesUsd=rollback.value*(unmatchedSide==='long'?effectiveLongFee:effectiveShortFee);
    const alternative:CompensationAlternative={quantity:q,limitPrice:rollback.worstPrice,pricePnlUsd,feesUsd,
      costUsd:feesUsd-pricePnlUsd,predictedFundingUsd:0,basis:'immediate-rollback',
      ...(unmatchedSide==='long'?{longClosePrice:rollback.average}:{shortClosePrice:rollback.average})};
    if([pricePnlUsd,feesUsd,alternative.costUsd].every(finite))evidence.rollback=alternative;
  }
  const missing=unmatchedSide==='short'?long:short,side=unmatchedSide==='short'?'buy':'sell',
    top=bestOppositeLevel(missing,side),hedgePrice=input.hedgeLimitPrice;
  const openingLong=unmatchedSide==='short'?hedgePrice:input.unmatchedEntryPrice,
    openingShort=unmatchedSide==='long'?hedgePrice:input.unmatchedEntryPrice;
  const visible=positive(hedgePrice)&&(side==='buy'?missing.asks:missing.bids).some(level=>level.price===hedgePrice&&positive(level.quantity));
  const edge=positive(openingLong)&&positive(openingShort)?
    alignedEntryIocEdgeBps(openingLong,openingShort,long.indexPrice,short.indexPrice):NaN;
  if(top&&q<=top.quantity+Math.max(1e-12,Math.abs(top.quantity)*Number.EPSILON*8)&&legalQuantity(q,missing)&&
    nonnegative(missing.minNotional)&&positive(hedgePrice)&&q*hedgePrice>=missing.minNotional&&visible&&
    (side==='buy'?hedgePrice>=top.price:hedgePrice<=top.price)&&
    nonnegative(input.minimumPriceEdgeBps)&&finite(edge)&&edge>input.minimumPriceEdgeBps+1e-9&&
    positive(input.predictedFundingUsd)&&input.projectionUntil>input.observedAt&&complete(closeLong)&&complete(closeShort)){
    const pricePnlUsd=q*(openingShort!-openingLong!+closeLong.average-closeShort.average),
      feesUsd=q*hedgePrice*(side==='buy'?effectiveLongFee:effectiveShortFee)+
        closeLong.value*effectiveLongFee+closeShort.value*effectiveShortFee,
      costUsd=feesUsd-pricePnlUsd-input.predictedFundingUsd;
    if([pricePnlUsd,feesUsd,costUsd].every(finite))evidence.hedge={quantity:q,limitPrice:hedgePrice,pricePnlUsd,feesUsd,costUsd,
      predictedFundingUsd:input.predictedFundingUsd,basis:'current-book-at-cycle-end',
      longClosePrice:closeLong.average,shortClosePrice:closeShort.average};
  }
  if(evidence.hedge&&(!evidence.rollback||evidence.hedge.costUsd<evidence.rollback.costUsd-1e-10)){
    evidence.decision='hedge';return result(evidence.rollback?'hedge-cheaper':'hedge-only-legal');
  }
  if(evidence.rollback){evidence.decision='rollback';return result('rollback-cheaper-or-hedge-ineligible');}
  return result('no-legal-alternative');
}
