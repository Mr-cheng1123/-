import type {BookLevel,MarketSnapshot} from '../shared/types.js';
import {commonStep,floorQuantity,isLegalQuantity,isQuantityOnStep,quantitySubtractOnStep} from './order-quantity.js';
import {bestOppositeLevel} from './entry-batch.js';

export const MAX_BEST_PRICE_CLOSE_BATCHES=8;
export const MAX_BEST_PRICE_CLOSE_MS=30_000;
/** Only a confirmed unmatched closing tail can consume this visible-price allowance. */
export const CLOSE_REPAIR_BUFFER_BPS=8;

export interface BestPriceCloseBatchPlan {
  quantity:number;longLimitPrice:number;shortLimitPrice:number;longTopQuantity:number;shortTopQuantity:number;
}
export interface BestPriceReductionPlan {quantity:number;limitPrice:number}

/** Actual bid 1 for reducing a long, ask 1 for reducing a short; duplicate rows share one level. */
export function bestCloseOppositeLevel(snapshot:MarketSnapshot,side:'long'|'short'):BookLevel|undefined {
  const bid=bestOppositeLevel(snapshot,'sell'),ask=bestOppositeLevel(snapshot,'buy');
  if(!bid||!ask||bid.price>ask.price)return;
  return side==='long'?bid:ask;
}
const validLots=(snapshot:MarketSnapshot)=>Number.isFinite(snapshot.quantityStep)&&snapshot.quantityStep>0&&
  Number.isFinite(snapshot.minQuantity)&&snapshot.minQuantity>=0;
const exceeds=(quantity:number,bound:number)=>quantity>bound+Number.EPSILON*Math.max(1,Math.abs(quantity),Math.abs(bound))*8;

/** One common, legal reduce-only batch at both best opposite prices. Opening minNotional is irrelevant. */
export function planBestPriceCloseBatch(longBook:MarketSnapshot,shortBook:MarketSnapshot,longQuantity:number,shortQuantity:number):
  BestPriceCloseBatchPlan|undefined {
  if(![longQuantity,shortQuantity].every(value=>Number.isFinite(value)&&value>0)||!validLots(longBook)||!validLots(shortBook))return;
  const sell=bestCloseOppositeLevel(longBook,'long'),buy=bestCloseOppositeLevel(shortBook,'short');
  if(!sell||!buy)return;
  const step=commonStep(longBook.quantityStep,shortBook.quantityStep);
  if(!Number.isFinite(step)||step<=0)return;
  const quantity=floorQuantity(Math.min(longQuantity,shortQuantity,sell.quantity,buy.quantity),step);
  if(!(quantity>0)||quantity<longBook.minQuantity||quantity<shortBook.minQuantity||
    [longQuantity,shortQuantity,sell.quantity,buy.quantity].some(bound=>exceeds(quantity,bound)))return;
  return {quantity,longLimitPrice:sell.price,shortLimitPrice:buy.price,longTopQuantity:sell.quantity,shortTopQuantity:buy.quantity};
}

export type ScopedFullCloseBatchAssessment=
  |{status:'paired';plan:BestPriceCloseBatchPlan}
  |{status:'wait';reason:'invalid'|'capacity'}
  |{status:'independent'};

const quantityWithin=(quantity:number,bound:number,step:number)=>quantity<=bound||
  Math.abs(quantity-bound)<=Number.EPSILON*Math.max(Math.abs(quantity),Math.abs(bound),step)*8;
const legalScopedRemainder=(held:number,quantity:number,book:MarketSnapshot)=>{
  const remaining=quantitySubtractOnStep(held,quantity,book.quantityStep);
  return remaining===0||isLegalQuantity(remaining,book.quantityStep,book.minQuantity);
};
/** Positive legal remainders share one interval; a zero remainder contributes
 * at most one isolated point per slot. No enumeration over native lot counts. */
function maximumScopedReduction(slots:{quantity:number;book:MarketSnapshot}[],step:number,capacity:number):number|undefined {
  const interval=floorQuantity(Math.min(capacity,...slots.map(slot=>quantitySubtractOnStep(slot.quantity,slot.book.minQuantity,slot.book.quantityStep))),step);
  const candidates=[interval,...slots.map(slot=>floorQuantity(slot.quantity,step))].filter(quantity=>quantity>0&&quantityWithin(quantity,capacity,step)&&
    isQuantityOnStep(quantity,step)&&slots.every(slot=>isLegalQuantity(quantity,slot.book.quantityStep,slot.book.minQuantity)&&
      legalScopedRemainder(slot.quantity,quantity,slot.book)));
  return candidates.length?Math.max(...candidates):undefined;
}

/** A newly confirmed full manual exit must not create a remainder below either
 * native lot. Compare feasible holdings before visible capacity: a small top
 * must never authorize splitting an otherwise closable shared holding. */
export function planScopedFullCloseBatch(longBook:MarketSnapshot,shortBook:MarketSnapshot,longQuantity:number,shortQuantity:number):
  ScopedFullCloseBatchAssessment {
  if(![longQuantity,shortQuantity].every(value=>Number.isFinite(value)&&value>0)||!validLots(longBook)||!validLots(shortBook))
    return {status:'wait',reason:'invalid'};
  const step=commonStep(longBook.quantityStep,shortBook.quantityStep);
  if(!Number.isFinite(step)||step<=0)return {status:'wait',reason:'invalid'};
  if(!isLegalQuantity(longQuantity,longBook.quantityStep,longBook.minQuantity)||
    !isLegalQuantity(shortQuantity,shortBook.quantityStep,shortBook.minQuantity))return {status:'wait',reason:'invalid'};
  const sell=bestCloseOppositeLevel(longBook,'long'),buy=bestCloseOppositeLevel(shortBook,'short');
  if(!sell||!buy)return {status:'wait',reason:'invalid'};
  const slots=[{quantity:longQuantity,book:longBook},{quantity:shortQuantity,book:shortBook}];
  const maximum=(capacity:number)=>maximumScopedReduction(slots,step,capacity);
  const holdingsMaximum=maximum(Math.min(longQuantity,shortQuantity));
  if(holdingsMaximum===undefined)return {status:'independent'};
  const quantity=maximum(Math.min(longQuantity,shortQuantity,sell.quantity,buy.quantity));
  if(quantity===undefined)return {status:'wait',reason:'capacity'};
  return {status:'paired',plan:{quantity,longLimitPrice:sell.price,shortLimitPrice:buy.price,
    longTopQuantity:sell.quantity,shortTopQuantity:buy.quantity}};
}

/** The independent phase of an explicit full manual exit still preserves legal
 * native slot and total holding remainders. scopeQuantity is a slot upper bound,
 * never evidence that the aggregate holding is flat after closing this slot. */
export function planScopedFullReduction(snapshot:MarketSnapshot,side:'long'|'short',holdingQuantity:number,
  scopeQuantity=holdingQuantity):BestPriceReductionPlan|undefined {
  if(!validLots(snapshot)||!isLegalQuantity(holdingQuantity,snapshot.quantityStep,snapshot.minQuantity)||
    !isLegalQuantity(scopeQuantity,snapshot.quantityStep,snapshot.minQuantity)||scopeQuantity>holdingQuantity)return;
  const top=bestCloseOppositeLevel(snapshot,side);if(!top)return;
  const slots=[{quantity:holdingQuantity,book:snapshot},{quantity:scopeQuantity,book:snapshot}];
  const quantity=maximumScopedReduction(slots,snapshot.quantityStep,Math.min(holdingQuantity,scopeQuantity,top.quantity));
  if(quantity===undefined)return;
  return {quantity,limitPrice:top.price};
}

/** A single confirmed reduction, bounded by its own legal lot and visible opposite level. */
export function planBestPriceReduction(snapshot:MarketSnapshot,side:'long'|'short',quantity:number):BestPriceReductionPlan|undefined {
  if(!Number.isFinite(quantity)||quantity<=0||!validLots(snapshot))return;
  const top=bestCloseOppositeLevel(snapshot,side);if(!top)return;
  const bounded=floorQuantity(Math.min(quantity,top.quantity),snapshot.quantityStep);
  if(!(bounded>0)||bounded<snapshot.minQuantity||exceeds(bounded,quantity)||exceeds(bounded,top.quantity))return;
  return {quantity:bounded,limitPrice:top.price};
}
