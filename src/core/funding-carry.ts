import type {AppConfig,BookLevel,MarketSnapshot,RoundTripBookCost,SpreadAdvantage} from '../shared/types.js';
import {quoteIsFresh,quoteObservedAt} from './market-validity.js';
import {takerFeeRate} from '../shared/trading-fees.js';
import {effectiveFeeRate} from '../shared/fee-rebates.js';

export interface BookSweep {filled:number;average:number;value:number;worstPrice:number}

/** Both displayed opportunity prices and submitted IOC bounds use the same index-price denominator. */
export function alignedEntryIocEdgeBps(longPrice:number,shortPrice:number,longIndex:number,shortIndex:number):number {
  const reference=(longIndex+shortIndex)/2;
  return [longPrice,shortPrice,longIndex,shortIndex].every(value=>Number.isFinite(value)&&value>0)&&reference>0?
    (shortPrice-longPrice)/reference*10000:NaN;
}
export function minimumEntryIocEdgeBps(c:AppConfig):number {
  return Number.isFinite(c.minEntryIocEdgeBps)&&c.minEntryIocEdgeBps>=0?c.minEntryIocEdgeBps:0;
}

/** Aligned entry compares funding after four trading fees; its price advantage is checked separately.
 * Opening fees use the supplied current opening prices. Future closing fees use each venue's
 * current mark as an explicit notional estimate, without requiring or predicting closing depth.
 * Live financial actions still require fresh, symbol-specific native fee evidence. */
export function estimateAlignedEntryFees(long:MarketSnapshot,short:MarketSnapshot,quantity:number,c:AppConfig,
  options:{longOpenPrice?:number;shortOpenPrice?:number;now?:number;requireNativeFees?:boolean}={}):number {
  const now=options.now??Date.now(),requireNativeFees=options.requireNativeFees??c.mode==='live';
  const longOpen=options.longOpenPrice??long.markPrice,shortOpen=options.shortOpenPrice??short.markPrice;
  const longFee=effectiveFeeRate(long.exchange,takerFeeRate(long,c,now,requireNativeFees),c),
    shortFee=effectiveFeeRate(short.exchange,takerFeeRate(short,c,now,requireNativeFees),c);
  if(![quantity,longOpen,shortOpen,long.markPrice,short.markPrice].every(value=>Number.isFinite(value)&&value>0)||
    longFee===undefined||shortFee===undefined)return NaN;
  const fees=quantity*((longOpen+long.markPrice)*longFee+(shortOpen+short.markPrice)*shortFee);
  return Number.isFinite(fees)&&fees>=0?fees:NaN;
}
export function alignedEntryPricesFavorable(longPrice:number,shortPrice:number,long:MarketSnapshot,short:MarketSnapshot,c:AppConfig):boolean {
  // Binary arithmetic can turn an exact 20 bps boundary into 20.0000000000003.
  return alignedEntryIocEdgeBps(longPrice,shortPrice,long.indexPrice,short.indexPrice)>minimumEntryIocEdgeBps(c)+1e-9;
}

/** Quantities are base coins, prices and values are USDT. Callers provide the execution order of levels. */
export function sweep(levels:BookLevel[],quantity:number):BookSweep {
  if(!Number.isFinite(quantity)||quantity<=0)return {filled:0,average:0,value:0,worstPrice:0};
  let remaining=quantity,value=0,worstPrice=0;
  for(const level of levels){
    if(!Number.isFinite(level.price)||level.price<=0||!Number.isFinite(level.quantity)||level.quantity<=0)continue;
    const q=Math.min(remaining,level.quantity);
    if(q<=0)break;
    value+=q*level.price;remaining-=q;worstPrice=level.price;
    if(remaining<1e-12)break;
  }
  return {filled:quantity-remaining,average:quantity>remaining?value/(quantity-remaining):0,value,worstPrice};
}

/** Copy before sorting; calculation must not mutate snapshots shared by the monitor and executor. */
const orderedLevels=(snapshot:MarketSnapshot,side:'bids'|'asks')=>snapshot[side]
  .filter(level=>Number.isFinite(level.price)&&level.price>0&&Number.isFinite(level.quantity)&&level.quantity>0)
  .sort((a,b)=>side==='asks'?a.price-b.price:b.price-a.price);
export function sweepBook(snapshot:MarketSnapshot,side:'bids'|'asks',quantity:number):BookSweep {
  return sweep(orderedLevels(snapshot,side),quantity);
}
/** Missing opposite-side depth is not an entry gate, but an observed crossed book is inconsistent evidence. */
export function bookIsUncrossedWhenObserved(snapshot:MarketSnapshot):boolean {
  const valid=(level:BookLevel)=>Number.isFinite(level.price)&&level.price>0&&Number.isFinite(level.quantity)&&level.quantity>0;
  let bestBid=-Infinity,bestAsk=Infinity;
  for(const level of snapshot.bids)if(valid(level))bestBid=Math.max(bestBid,level.price);
  for(const level of snapshot.asks)if(valid(level))bestAsk=Math.min(bestAsk,level.price);
  return !Number.isFinite(bestBid)||!Number.isFinite(bestAsk)||bestBid<=bestAsk;
}

/** Sum only the price distance consumed behind the best level. Subtracting large notionals or
 * cross-venue prices first can erase a small spread cost when a venue's price basis is large. */
function depthImpactUsd(levels:BookLevel[],quantity:number,side:'bids'|'asks'):number {
  const best=levels[0].price;
  let remaining=quantity,cost=0;
  for(const level of levels){
    if(remaining<=1e-12)break;
    const filled=Math.min(remaining,level.quantity);
    cost+=filled*(side==='asks'?level.price-best:best-level.price);
    remaining-=filled;
  }
  return cost;
}

/**
 * Estimates the full round trip without predicting convergence. Holding-period basis is assumed unchanged:
 * sell-short proceeds minus buy-long cost plus sell-long proceeds minus buy-short cost.
 * A large cross-venue price difference cancels here; each venue's bid/ask spread and consumed depth do not.
 * This is a conditional estimate, not a promise that the future closing books will stay at today's levels.
 */
export function assessFundingCarry(long:MarketSnapshot,short:MarketSnapshot,quantity:number,c:AppConfig,now=Date.now(),requireNativeFees=c.mode==='live'){
  const longAsks=orderedLevels(long,'asks'),longBids=orderedLevels(long,'bids'),shortAsks=orderedLevels(short,'asks'),shortBids=orderedLevels(short,'bids');
  const openLong=sweep(longAsks,quantity),openShort=sweep(shortBids,quantity);
  const closeLong=sweep(longBids,quantity),closeShort=sweep(shortAsks,quantity);
  const ref=(long.indexPrice+short.indexPrice)/2;
  const full=(result:BookSweep)=>quantity>0&&result.filled>=quantity*(1-1e-9)&&
    [result.average,result.value,result.worstPrice].every(value=>Number.isFinite(value)&&value>0);
  const complete=[openLong,openShort,closeLong,closeShort].every(full);
  const skew=Number.isFinite(long.observedAt)&&Number.isFinite(short.observedAt)?Math.abs(long.observedAt!-short.observedAt!):0;
  const fresh=quoteIsFresh(long,c,now)&&quoteIsFresh(short,c,now)&&skew<=c.maxQuoteSkewMs;
  const sameInstrument=long.base===short.base&&long.exchange!==short.exchange&&long.source===short.source;
  // Crossed books on one venue imply a malformed/inconsistent snapshot, not instant arbitrage income.
  const uncrossed=(bids:BookLevel[],asks:BookLevel[])=>!!bids[0]&&!!asks[0]&&bids[0].price<=asks[0].price;
  const pricesValid=Number.isFinite(ref)&&ref>0&&Number.isFinite(quantity)&&quantity>0&&sameInstrument&&
    fresh&&complete&&uncrossed(longBids,longAsks)&&uncrossed(shortBids,shortAsks);
  const longFee=effectiveFeeRate(long.exchange,takerFeeRate(long,c,now,requireNativeFees),c)??NaN,
    shortFee=effectiveFeeRate(short.exchange,takerFeeRate(short,c,now,requireNativeFees),c)??NaN;
  const feesValid=[longFee,shortFee].every(value=>Number.isFinite(value)&&value>=0);
  const feesUsd=pricesValid&&feesValid?(openLong.value+closeLong.value)*longFee+(openShort.value+closeShort.value)*shortFee:NaN;
  const limitFeesUsd=pricesValid&&feesValid?(quantity*openLong.worstPrice+closeLong.value)*longFee+
    (quantity*openShort.worstPrice+closeShort.value)*shortFee:NaN;
  let bookCost:RoundTripBookCost|undefined,limitBookLossUsd=NaN;
  if(pricesValid){
    // A buy and a sell each pay half of their venue's best bid/ask spread against its own midpoint.
    // Computing the half spread directly avoids subtracting a rounded midpoint from huge prices.
    const spreadHalf=quantity*((longAsks[0].price-longBids[0].price)/2+(shortAsks[0].price-shortBids[0].price)/2);
    const openingDepthImpactUsd=depthImpactUsd(longAsks,quantity,'asks')+depthImpactUsd(shortBids,quantity,'bids');
    const closingDepthImpactUsd=depthImpactUsd(longBids,quantity,'bids')+depthImpactUsd(shortAsks,quantity,'asks');
    const openingCostUsd=spreadHalf+openingDepthImpactUsd,closingCostUsd=spreadHalf+closingDepthImpactUsd;
    const roundTripBookLossUsd=openingCostUsd+closingCostUsd;
    limitBookLossUsd=spreadHalf+quantity*((openLong.worstPrice-longAsks[0].price)+(shortBids[0].price-openShort.worstPrice))+closingCostUsd;
    if([spreadHalf,openingDepthImpactUsd,closingDepthImpactUsd,openingCostUsd,closingCostUsd,roundTripBookLossUsd]
      .every(value=>Number.isFinite(value)&&value>=0))bookCost={quantity,longObservedAt:quoteObservedAt(long),shortObservedAt:quoteObservedAt(short),
      longOpenPrice:openLong.average,longClosePrice:closeLong.average,shortOpenPrice:openShort.average,shortClosePrice:closeShort.average,
      openingSpreadCostUsd:spreadHalf,openingDepthImpactUsd,closingSpreadCostUsd:spreadHalf,closingDepthImpactUsd,
      openingCostUsd,closingCostUsd,roundTripBookLossUsd,feesUsd:Number.isFinite(feesUsd)?feesUsd:null};
  }
  const estimateReady=pricesValid&&bookCost!==undefined;
  const entrySpreadBps=complete&&Number.isFinite(ref)&&ref>0?(openShort.average-openLong.average)/ref*10000:NaN;
  const expectedExitSpreadBps=estimateReady?(closeShort.average-closeLong.average)/ref*10000:null;
  const expectedSpreadPnlUsd=bookCost?-bookCost.roundTripBookLossUsd:null;
  const spread:SpreadAdvantage={estimateMethod:'current-book',status:estimateReady?'ready':'warming',samples:0,requiredSamples:0,
    observedSpanSec:0,requiredSpanSec:0,longEntryPrice:openLong.average,shortEntryPrice:openShort.average,entrySpreadBps,
    expectedExitSpreadBps,spreadAdvantageBps:estimateReady?expectedSpreadPnlUsd!/quantity/ref*10000:null,expectedSpreadPnlUsd,
    ...(estimateReady?{baselineUpdatedAt:Math.max(quoteObservedAt(long),quoteObservedAt(short))}:
      {reason:!sameInstrument?'两腿合约标的或数据来源不一致':!fresh?'开平仓盘口过期或两腿采集时间不同步':
        !complete?'完整开平仓盘口不足，不能估计整笔成交成本':'开平仓盘口价格无效或买卖报价倒挂'})};
  return {spread,bookCost,limitBookLossUsd,feesUsd,limitFeesUsd,openLong,openShort,closeLong,closeShort,complete,pricesValid,feesValid};
}
