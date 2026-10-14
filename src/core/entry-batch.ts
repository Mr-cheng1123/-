import type {BookLevel,MarketSnapshot,Side} from '../shared/types.js';
import {commonStep,floorQuantity} from './order-quantity.js';

export const MAX_BEST_PRICE_ENTRY_BATCHES=8;
/** Stop new batches after this window; an already submitted leg still needs reconciliation/hedging. */
export const MAX_ENTRY_EXPANSION_MS=30_000;

/** Buy the best ask or sell the best bid. Duplicate native rows at that price share one level. */
export function bestOppositeLevel(snapshot:MarketSnapshot,side:Side):BookLevel|undefined {
  let price=side==='buy'?Infinity:-Infinity,quantity=0;
  for(const level of side==='buy'?snapshot.asks:snapshot.bids){
    if(!Number.isFinite(level.price)||level.price<=0||!Number.isFinite(level.quantity)||level.quantity<=0)continue;
    if(side==='buy'?level.price<price:level.price>price){price=level.price;quantity=level.quantity;}
    else if(level.price===price)quantity+=level.quantity;
  }
  return Number.isFinite(price)&&Number.isFinite(quantity)&&quantity>0?{price,quantity}:undefined;
}
export interface BestPriceEntryPlan {
  quantity:number;longLimitPrice:number;shortLimitPrice:number;targetQuantity:number;commonQuantityStep:number;
  /** Raw opposite prices and the actual visible-price buffer; absent for legacy exact-price calls. */
  longBestPrice?:number;shortBestPrice?:number;longPriceBufferBps?:number;shortPriceBufferBps?:number;
}
export interface EntryPriceBufferOptions {bufferBps:number;minEdgeBps:number}
export interface BufferedLongEntryPlan {quantity:number;limitPrice:number;bestPrice:number;priceBufferBps:number}

const priceTolerance=(...prices:number[])=>Number.EPSILON*Math.max(...prices.map(Math.abs))*8;
const validBuffer=(options:EntryPriceBufferOptions|undefined)=>!!options&&
  Number.isFinite(options.bufferBps)&&options.bufferBps>=0&&Number.isFinite(options.minEdgeBps)&&options.minEdgeBps>=0;
function availableEdge(long:MarketSnapshot,short:MarketSnapshot,buyPrice:number,sellPrice:number,options:EntryPriceBufferOptions){
  const reference=(long.indexPrice+short.indexPrice)/2;
  if(!Number.isFinite(reference)||reference<=0||!Number.isFinite(long.indexPrice)||long.indexPrice<=0||
    !Number.isFinite(short.indexPrice)||short.indexPrice<=0)return 0;
  const extra=sellPrice-buyPrice-reference*options.minEdgeBps/10_000;
  return Number.isFinite(extra)&&extra>0?extra:0;
}
const retainsMinimumEdge=(long:MarketSnapshot,short:MarketSnapshot,buy:number,sell:number,options:EntryPriceBufferOptions)=>
  (sell-buy)/((long.indexPrice+short.indexPrice)/2)*10_000>options.minEdgeBps+1e-9;
/** A limit is always a real, visible price; no guessed tick or synthetic slippage price is used. */
function bufferedVisiblePrice(snapshot:MarketSnapshot,side:Side,bestPrice:number,maxDistance:number,quantity:number):number {
  let chosen=bestPrice;
  if(!(Number.isFinite(maxDistance)&&maxDistance>0))return chosen;
  for(const level of side==='buy'?snapshot.asks:snapshot.bids){
    if(!Number.isFinite(level.price)||level.price<=0||!Number.isFinite(level.quantity)||level.quantity<=0)continue;
    const distance=side==='buy'?level.price-bestPrice:bestPrice-level.price;
    if(distance<0||distance>maxDistance+priceTolerance(bestPrice,level.price,maxDistance))continue;
    // A lower sell limit must still leave this fixed quantity above the venue minimum notional.
    if(quantity*level.price<snapshot.minNotional)continue;
    if(side==='buy'?level.price>chosen:level.price<chosen)chosen=level.price;
  }
  return chosen;
}
const actualBufferBps=(best:number,limit:number,side:Side)=>Math.max(0,(side==='buy'?limit-best:best-limit)/best*10_000);
/** One shared legal batch, bounded by the original remaining target and BOTH visible best levels. */
export function planBestPriceEntryBatch(long:MarketSnapshot,short:MarketSnapshot,remainingQuantity:number,options?:EntryPriceBufferOptions):BestPriceEntryPlan|undefined {
  if(!Number.isFinite(remainingQuantity)||remainingQuantity<=0||
    ![long.quantityStep,short.quantityStep].every(value=>Number.isFinite(value)&&value>0)||
    ![long.minQuantity,short.minQuantity,long.minNotional,short.minNotional].every(value=>Number.isFinite(value)&&value>=0))return;
  const buy=bestOppositeLevel(long,'buy'),sell=bestOppositeLevel(short,'sell');
  if(!buy||!sell)return;
  const step=commonStep(long.quantityStep,short.quantityStep);
  if(!(Number.isFinite(step)&&step>0))return;
  const quantity=floorQuantity(Math.min(remainingQuantity,buy.quantity,sell.quantity),step);
  const tolerance=(bound:number)=>Number.EPSILON*Math.max(1,Math.abs(quantity),Math.abs(bound))*8;
  // Round-off tolerance never permits consuming beyond the actual top level or exceeding the target.
  if(!(quantity>0)||quantity>remainingQuantity+tolerance(remainingQuantity)||quantity>buy.quantity+tolerance(buy.quantity)||quantity>sell.quantity+tolerance(sell.quantity)||
    quantity<long.minQuantity||quantity<short.minQuantity||quantity*buy.price<long.minNotional||quantity*sell.price<short.minNotional)return;
  const plan:BestPriceEntryPlan={quantity,longLimitPrice:buy.price,shortLimitPrice:sell.price,targetQuantity:remainingQuantity,commonQuantityStep:step};
  if(options){
    const extra=validBuffer(options)?availableEdge(long,short,buy.price,sell.price,options):0;
    // Each leg can consume at most one quarter of the excess edge, retaining at least half for the pair.
    const buyDistance=Math.min(buy.price*options.bufferBps/10_000,extra*.25);
    const sellDistance=Math.min(sell.price*options.bufferBps/10_000,extra*.25);
    plan.longLimitPrice=bufferedVisiblePrice(long,'buy',buy.price,buyDistance,quantity);
    plan.shortLimitPrice=bufferedVisiblePrice(short,'sell',sell.price,sellDistance,quantity);
    // Near a floating-point threshold, retain the original bounds and let the entry guard decide.
    if(extra>0&&!retainsMinimumEdge(long,short,plan.longLimitPrice,plan.shortLimitPrice,options)){
      plan.longLimitPrice=buy.price;plan.shortLimitPrice=sell.price;
    }
    plan.longBestPrice=buy.price;plan.shortBestPrice=sell.price;
    plan.longPriceBufferBps=actualBufferBps(buy.price,plan.longLimitPrice,'buy');
    plan.shortPriceBufferBps=actualBufferBps(sell.price,plan.shortLimitPrice,'sell');
  }
  return plan;
}

/** Price a missing long against this batch's actual short fill, never an earlier batch's profit. */
export function planBufferedLongEntry(long:MarketSnapshot,short:MarketSnapshot,missingQuantity:number,actualShortAveragePrice:number,
  options?:EntryPriceBufferOptions):BufferedLongEntryPlan|undefined {
  if(!Number.isFinite(missingQuantity)||missingQuantity<=0||!Number.isFinite(actualShortAveragePrice)||actualShortAveragePrice<=0||
    !Number.isFinite(long.quantityStep)||long.quantityStep<=0||
    ![long.minQuantity,long.minNotional].every(value=>Number.isFinite(value)&&value>=0))return;
  const buy=bestOppositeLevel(long,'buy');if(!buy)return;
  const quantity=floorQuantity(Math.min(missingQuantity,buy.quantity),long.quantityStep);
  const tolerance=(bound:number)=>Number.EPSILON*Math.max(1,Math.abs(quantity),Math.abs(bound))*8;
  if(!(quantity>0)||quantity>missingQuantity+tolerance(missingQuantity)||quantity>buy.quantity+tolerance(buy.quantity)||
    quantity<long.minQuantity||quantity*buy.price<long.minNotional)return;
  const extra=validBuffer(options)?availableEdge(long,short,buy.price,actualShortAveragePrice,options!):0;
  // A repair consumes no more than 25% of its own remaining advantage and at most 8 bps.
  const maxDistance=validBuffer(options)?Math.min(buy.price*Math.min(options!.bufferBps,8)/10_000,extra*.25):0;
  let limitPrice=bufferedVisiblePrice(long,'buy',buy.price,maxDistance,quantity);
  if(extra>0&&!retainsMinimumEdge(long,short,limitPrice,actualShortAveragePrice,options!))limitPrice=buy.price;
  return {quantity,limitPrice,bestPrice:buy.price,priceBufferBps:actualBufferBps(buy.price,limitPrice,'buy')};
}
