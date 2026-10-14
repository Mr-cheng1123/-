import type {AppConfig,ExchangeId,MarketSnapshot} from '../../src/shared/types';
import type {FundingCandidateView} from '../../src/shared/funding-opportunities';
import {quoteObservedAt} from '../../src/core/market-validity';
import {bestOppositeLevel} from '../../src/core/entry-batch';
import {bookIsUncrossedWhenObserved} from '../../src/core/funding-carry';
import {instrumentIdentityBlockReason} from '../../src/shared/instrument-identity';
import {entryBatchPresentation} from './entry-batch-presentation';

type PriceConfig = Pick<AppConfig,'maxSnapshotAgeMs'|'maxQuoteSkewMs'|'orderNotionalUsd'>;
export type CandidateQuoteLookup = ReadonlyMap<string,MarketSnapshot>;
const names = {binance:'Binance',bybit:'Bybit',okx:'OKX',gate:'Gate',bitget:'Bitget'};
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const positive=(value:unknown):value is number=>finite(value)&&value>0;
export const REFERENCE_BOOK_MAX_AGE_MS=10_000;
const REFERENCE_METADATA_MAX_AGE_MS=30_000;
const quoteTimeFormat=new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});

/** Keep actual received observations for a bounded display window. Never amend
 * their timestamps/transport/metadata or pass this cache to execution checks. */
export function retainCandidateReferenceQuotes(previous:CandidateQuoteLookup,snapshots:readonly MarketSnapshot[],
  exchanges:readonly ExchangeId[],now:number):Map<string,MarketSnapshot> {
  const connected=new Set(exchanges),retained=new Map<string,MarketSnapshot>();
  const retainable=(quote:MarketSnapshot)=>connected.has(quote.exchange)&&positive(quote.timestamp)&&quote.timestamp<=now+5000&&
    positive(quoteObservedAt(quote))&&quoteObservedAt(quote)<=now+5000&&now-quoteObservedAt(quote)<=REFERENCE_BOOK_MAX_AGE_MS;
  for(const [key,quote] of previous)if(retainable(quote))retained.set(key,quote);
  for(const quote of snapshots)if(retainable(quote)){
    const key=`${quote.exchange}:${quote.base}`,prior=retained.get(key);
    if(!prior||quoteObservedAt(quote)>=quoteObservedAt(prior))retained.set(key,quote);
  }
  return retained;
}

function referenceQuoteIsFresh(quote:MarketSnapshot,now:number):boolean {
  const at=quoteObservedAt(quote);
  const metadataAt=quote.fundingObservedAt??(quote.bookTransport!=='websocket'?at:undefined);
  return positive(quote.timestamp)&&quote.timestamp<=now+5000&&positive(at)&&at<=now+5000&&
    now-at<=REFERENCE_BOOK_MAX_AGE_MS&&positive(metadataAt)&&metadataAt<=now+5000&&now-metadataAt<=REFERENCE_METADATA_MAX_AGE_MS;
}

export function candidateReferenceQuoteCaption(reference:CandidateBboReference,now:number):string|undefined {
  if(reference.status!=='ready')return;
  const at=Math.min(reference.longObservedAt,reference.shortObservedAt);
  return `参考报价 ${quoteTimeFormat.format(at)} / ${Math.max(0,Math.floor((now-at)/1000))} 秒前 · 数量/IOC待核验`;
}

export type CandidateBboReference = {
  status:'ready';kind:'public-bbo-reference';edgeBps:number;referencePrice:number;
  longAskPrice:number;shortBidPrice:number;longObservedAt:number;shortObservedAt:number;
  reason:string;
} | {status:'waiting';kind:'public-bbo-reference';reason:string};

/** Display evidence only. It never creates a batch, IOC limit or eligibility. */
export function candidateBboReference(row:Pick<FundingCandidateView,'base'|'longExchange'|'shortExchange'>,
  quotes:CandidateQuoteLookup,config:PriceConfig,now:number):CandidateBboReference {
  const wait=(reason:string):CandidateBboReference=>({status:'waiting',kind:'public-bbo-reference',reason});
  const identity=instrumentIdentityBlockReason(row.base,row.longExchange,row.shortExchange);
  if(identity)return wait(identity);
  const long=quotes.get(`${row.longExchange}:${row.base}`),short=quotes.get(`${row.shortExchange}:${row.base}`);
  const missing=[!long?names[row.longExchange]:undefined,!short?names[row.shortExchange]:undefined].filter(Boolean);
  if(missing.length)return wait(`${missing.join(' / ')} 未收到 10 秒内的有效参考盘口`);
  if(long!.exchange!==row.longExchange||short!.exchange!==row.shortExchange||long!.base!==row.base||short!.base!==row.base)
    return wait('两腿盘口与当前币种或交易所不匹配');
  for(const quote of [long!,short!]){
    const venueName=names[quote.exchange];
    if(!referenceQuoteIsFresh(quote,now))return wait(`${venueName} 参考盘口超过 10 秒或价格元数据已过期，等待同步`);
    if(!positive(quote.indexPrice))return wait(`${venueName} 指数价格无效，参考价差待计算`);
    if(!bookIsUncrossedWhenObserved(quote))return wait(`${venueName} 买卖盘口倒挂，等待一致报价`);
  }
  if(long!.source!==short!.source)return wait('两腿盘口数据来源不一致');
  const longAt=quoteObservedAt(long!),shortAt=quoteObservedAt(short!);
  const skew=Math.abs(longAt-shortAt);
  if(!finite(config.maxQuoteSkewMs)||config.maxQuoteSkewMs<0||skew>config.maxQuoteSkewMs)
    return wait(`两腿盘口采集相差 ${Math.round(skew)} 毫秒，超过允许时差`);
  const buy=bestOppositeLevel(long!,'buy'),sell=bestOppositeLevel(short!,'sell');
  if(!buy||!sell)return wait('两腿最佳对手价或首档数量不足，等待当前报价');
  const reference=(long!.indexPrice+short!.indexPrice)/2;
  const edge=(sell.price-buy.price)/reference*10000;
  if(!positive(reference)||!finite(edge))return wait('参考对手价1价差无法计算');
  return {status:'ready',kind:'public-bbo-reference',edgeBps:edge,referencePrice:reference,
    longAskPrice:buy.price,shortBidPrice:sell.price,longObservedAt:longAt,shortObservedAt:shortAt,
    reason:'仅参考最近实际收到的最佳对手价；本批数量与实际 IOC 限价仍待完整核验'};
}

export interface CandidatePricePresentation {
  kind:'batch'|'reference'|'waiting';edgeBps:number|null;iocEdgeBps:number|null;
  label:'本批对手价1价格优势'|'参考对手价1价差';reason:string;
  reference:CandidateBboReference;
  batch?:ReturnType<typeof entryBatchPresentation>;
}

/** Prefer a genuinely current execution plan. Explicit observations are required
 * for a batch label; old legacy payloads may still be used by existing gates. */
export function candidatePricePresentation(row:FundingCandidateView,quotes:CandidateQuoteLookup,
  config:PriceConfig,now:number):CandidatePricePresentation {
  const reference=candidateBboReference(row,quotes,config,now);
  const execution=row.execution,batch=entryBatchPresentation(execution,config.orderNotionalUsd);
  const observations=[execution?.longObservedAt,execution?.shortObservedAt];
  const venues=[row.longExchange,row.shortExchange];
  const timesCurrent=observations.every((at,index)=>{
    const quote=quotes.get(`${venues[index]}:${row.base}`);
    const maxAge=quote?.bookTransport==='rest'?config.maxSnapshotAgeMs:Math.min(config.maxSnapshotAgeMs,2000);
    return positive(at)&&at<=now+5000&&now-at<=maxAge;
  });
  const paired=timesCurrent&&Math.abs(observations[0]!-observations[1]!)<=config.maxQuoteSkewMs;
  const executionAt=execution&&row.executionObservedAt;
  const observedCurrent=executionAt===undefined||positive(executionAt)&&executionAt<=now+5000&&now-executionAt<=config.maxSnapshotAgeMs;
  if(batch&&paired&&observedCurrent&&finite(execution?.entryPriceEdgeBps)&&
    execution?.base===row.base&&execution.longExchange===row.longExchange&&execution.shortExchange===row.shortExchange){
    return {kind:'batch',label:'本批对手价1价格优势',edgeBps:execution.entryPriceEdgeBps,
      iocEdgeBps:finite(execution.entryLimitPriceEdgeBps)?execution.entryLimitPriceEdgeBps:null,
      batch,reference,reason:'本批数量与限价来自当前完整核验结果，提交前仍重新检查'};
  }
  return {kind:reference.status==='ready'?'reference':'waiting',label:'参考对手价1价差',
    edgeBps:reference.status==='ready'?reference.edgeBps:null,iocEdgeBps:null,reference,
    reason:candidateReferenceQuoteCaption(reference,now)??reference.reason};
}
