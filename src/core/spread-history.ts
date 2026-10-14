import type { AppConfig, MarketSnapshot, SpreadAdvantage, SpreadHistoryProvider, SpreadObservation } from '../shared/types.js';
import { commonStep, floorQuantity, quoteSkewMs, sweep } from './strategy.js';
import {quoteIsFresh,quoteObservedAt} from './market-validity.js';

const MAX_ROUTES=500,MAX_SAMPLES=240;
const key=(o:Pick<SpreadObservation,'base'|'longExchange'|'shortExchange'|'longSymbol'|'shortSymbol'|'source'|'notionalUsd'>)=>
  JSON.stringify([o.source,o.base,o.longExchange,o.shortExchange,o.longSymbol,o.shortSymbol,o.notionalUsd]);
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const valid=(o:SpreadObservation)=>o&&typeof o.base==='string'&&typeof o.longSymbol==='string'&&typeof o.shortSymbol==='string'&&
  ['binance','bybit','okx','gate','bitget'].includes(o.longExchange)&&['binance','bybit','okx','gate','bitget'].includes(o.shortExchange)&&
  o.longExchange!==o.shortExchange&&['demo','public'].includes(o.source)&&[o.notionalUsd,o.timestamp,o.longAt,o.shortAt].every(v=>finite(v)&&v>0)&&
  finite(o.exitSpreadBps)&&o.timestamp===Math.max(o.longAt,o.shortAt);
const levels=(s:MarketSnapshot,side:'bids'|'asks')=>s[side].filter(l=>finite(l.price)&&l.price>0&&finite(l.quantity)&&l.quantity>0)
  .sort((a,b)=>side==='bids'?b.price-a.price:a.price-b.price);
const fresh=(s:MarketSnapshot,c:AppConfig,now:number)=>quoteIsFresh(s,c,now);

/** Recorded executable closing spreads only. Current observations never enter their own baseline. */
export class SpreadHistory implements SpreadHistoryProvider {
  private routes=new Map<string,SpreadObservation[]>();
  constructor(saved:SpreadObservation[]=[]){
    if(Array.isArray(saved))for(const o of saved.filter(valid).sort((a,b)=>a.timestamp-b.timestamp))this.append(o);
  }
  private append(o:SpreadObservation){
    const route=key(o),samples=this.routes.get(route)??[],prior=samples.at(-1);
    if(prior&&(o.longAt<=prior.longAt||o.shortAt<=prior.shortAt))return;
    samples.push(o);this.routes.delete(route);this.routes.set(route,samples.slice(-MAX_SAMPLES));
    while(this.routes.size>MAX_ROUTES)this.routes.delete(this.routes.keys().next().value!);
  }
  observe(snapshots:MarketSnapshot[],c:AppConfig,now=Date.now()){
    const quotes=snapshots.filter(s=>fresh(s,c,now));
    for(const long of quotes)for(const short of quotes){
      if(long.exchange===short.exchange||long.base!==short.base||long.source!==short.source)continue;
      // Books fetched seconds apart would record a spread that never existed; keep them out of the baseline.
      if(quoteSkewMs(long,short)>c.maxQuoteSkewMs)continue;
      const ref=(long.indexPrice+short.indexPrice)/2;
      if(!(finite(ref)&&ref>0&&finite(long.quantityStep)&&long.quantityStep>0&&finite(short.quantityStep)&&short.quantityStep>0))continue;
      const q=floorQuantity(c.orderNotionalUsd/ref,commonStep(long.quantityStep,short.quantityStep));
      if(!(q>0&&q>=long.minQuantity&&q>=short.minQuantity))continue;
      const sell=sweep(levels(long,'bids'),q),buy=sweep(levels(short,'asks'),q);
      if(sell.filled<q*(1-1e-9)||buy.filled<q*(1-1e-9))continue;
      const o:SpreadObservation={base:long.base,longExchange:long.exchange,shortExchange:short.exchange,
        longSymbol:long.symbol,shortSymbol:short.symbol,source:long.source,notionalUsd:c.orderNotionalUsd,
        timestamp:Math.max(quoteObservedAt(long),quoteObservedAt(short)),longAt:quoteObservedAt(long),shortAt:quoteObservedAt(short),
        exitSpreadBps:(buy.average-sell.average)/ref*10000};
      const prior=this.routes.get(key(o))?.at(-1);
      if(prior&&o.timestamp-prior.timestamp<c.spreadSampleIntervalSec*1000)continue;
      this.append(o);
    }
    this.prune(c,now);
  }
  private prune(c:AppConfig,now:number){
    for(const [route,observations] of this.routes){
      const samples=observations.filter(o=>o.timestamp<=now&&o.timestamp>=now-c.spreadLookbackMinutes*60000&&o.notionalUsd===c.orderNotionalUsd);
      if(samples.length)this.routes.set(route,samples);else this.routes.delete(route);
    }
  }
  serialize():SpreadObservation[]{return [...this.routes.values()].flat();}
  assess(long:MarketSnapshot,short:MarketSnapshot,quantity:number,c:AppConfig,now:number):SpreadAdvantage {
    const ref=(long.indexPrice+short.indexPrice)/2;
    const longBuy=sweep(levels(long,'asks'),quantity),shortSell=sweep(levels(short,'bids'),quantity);
    const entrySpreadBps=(shortSell.average-longBuy.average)/ref*10000;
    const route=key({base:long.base,longExchange:long.exchange,shortExchange:short.exchange,longSymbol:long.symbol,
      shortSymbol:short.symbol,source:long.source,notionalUsd:c.orderNotionalUsd});
    // Require strictly older observations on BOTH venues, avoiding self-inclusion and cached duplicates.
    const samples=(this.routes.get(route)??[]).filter(o=>o.timestamp>=now-c.spreadLookbackMinutes*60000&&o.timestamp<now&&
      o.longAt<quoteObservedAt(long)&&o.shortAt<quoteObservedAt(short)&&o.notionalUsd===c.orderNotionalUsd);
    const span=samples.length>1?(samples.at(-1)!.timestamp-samples[0].timestamp)/1000:0;
    const result:SpreadAdvantage={status:'warming',samples:samples.length,requiredSamples:c.spreadMinSamples,
      observedSpanSec:span,requiredSpanSec:c.spreadMinSpanSec,longEntryPrice:longBuy.average,shortEntryPrice:shortSell.average,
      entrySpreadBps,expectedExitSpreadBps:null,spreadAdvantageBps:null,expectedSpreadPnlUsd:null};
    if(long.source!==short.source||!fresh(long,c,now)||!fresh(short,c,now)||!(finite(ref)&&ref>0&&quantity>0)||
      longBuy.filled<quantity*(1-1e-9)||shortSell.filled<quantity*(1-1e-9))return {...result,reason:'完整新鲜盘口不足，无法判断价差优势'};
    if(samples.length<c.spreadMinSamples||span<c.spreadMinSpanSec)return {...result,
      reason:`价差观察积累中：${samples.length}/${c.spreadMinSamples} 个样本，${Math.floor(span)}/${c.spreadMinSpanSec} 秒`};
    if(now-samples.at(-1)!.timestamp>Math.max(c.maxSnapshotAgeMs,c.spreadSampleIntervalSec*2000))return {...result,reason:'价差历史最近观察已过期，等待连续行情'};
    const sorted=samples.map(o=>o.exitSpreadBps).sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);
    const expectedExitSpreadBps=sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;
    const spreadAdvantageBps=entrySpreadBps-expectedExitSpreadBps;
    return {...result,status:'ready',expectedExitSpreadBps,spreadAdvantageBps,
      expectedSpreadPnlUsd:quantity*ref*spreadAdvantageBps/10000,baselineUpdatedAt:samples.at(-1)!.timestamp};
  }
}
