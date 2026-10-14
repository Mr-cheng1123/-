import type {AppConfig,ExchangeId,JournalOrder,MarketSnapshot,Position,Side} from '../shared/types.js';
import {nativeMakerFeeRate,nativeTakerFeeRate,takerFeeRate} from '../shared/trading-fees.js';
import {effectiveFeeRate,estimateFeeRebateUsd,estimatedPositionFeeRebateUsd} from '../shared/fee-rebates.js';
import {referenceTradingFee} from '../shared/reference-trading-fees.js';
import {bestOppositeLevel} from './entry-batch.js';
import {quoteIsFresh,quoteObservedAt} from './market-validity.js';
import {commonStep,floorQuantity,isLegalQuantity,quantityAdd,quantitySubtractOnStep} from './order-quantity.js';
import type {ProfitExitAssessment} from './profit-exit.js';
import {exitProfitThresholdUsd} from './exit-profit-threshold.js';

export type MakerCloseLeg='long'|'short';
export interface MakerClosePlanOptions {
  /** False is a local preview only. No preview can grant economic submission permission. */
  requireNativeFees?:boolean;
  /** Recheck this exact common quantity instead of choosing a new one. */
  batchQuantity?:number;
  /** Keep the side of an existing passive order when the relative widths change. */
  makerLeg?:MakerCloseLeg;
  /** The unchanged prices actually submitted; a resting Maker may now be inside the spread. */
  limits?:{longPrice:number;shortPrice:number};
}
export interface MakerClosePlan {
  quantity:number;commonQuantityStep:number;
  makerLeg:MakerCloseLeg;makerExchange:ExchangeId;makerSide:Side;makerLimitPrice:number;
  takerLeg:MakerCloseLeg;takerExchange:ExchangeId;takerSide:Side;takerLimitPrice:number;takerTopQuantity:number;
  longLimitPrice:number;shortLimitPrice:number;longSpreadBps:number;shortSpreadBps:number;
  makerFeeRate:number;takerFeeRate:number;feeSource:'native'|'reference';
  makerFeeSource:'native'|'account-reference'|'official-reference';takerFeeSource:'native'|'reference';
  profit:ProfitExitAssessment;profitThresholdUsd:number;profitPass:boolean;
  /** Economic guard only: native slot, account, session and original-order checks remain with the caller. */
  submissionAllowed:boolean;
  valuation:'same-price-full-position-estimate';
}

function top(snapshot:MarketSnapshot|undefined){
  if(!snapshot||!Array.isArray(snapshot.bids)||!Array.isArray(snapshot.asks))return;
  const bid=bestOppositeLevel(snapshot,'sell'),ask=bestOppositeLevel(snapshot,'buy');
  if(!bid||!ask||bid.price>ask.price)return;
  const midpoint=bid.price/2+ask.price/2,spreadBps=(ask.price-bid.price)/midpoint*10_000;
  return Number.isFinite(midpoint)&&midpoint>0&&Number.isFinite(spreadBps)?{bid,ask,spreadBps}:undefined;
}

/** Pure book selection, also usable before an on-demand native fee read. Ties are stable. */
export function selectMakerCloseLeg(long:MarketSnapshot|undefined,short:MarketSnapshot|undefined):MakerCloseLeg|undefined {
  const l=top(long),s=top(short);
  if(!l||!s||Math.max(l.spreadBps,s.spreadBps)<=0)return;
  return l.spreadBps>=s.spreadBps?'long':'short';
}

function makerFee(snapshot:MarketSnapshot,now:number,requireNative:boolean){
  const native=nativeMakerFeeRate(snapshot,now);
  if(native!==undefined)return {rate:native,source:'native' as const};
  if(requireNative)return;
  const saved=snapshot.feeReference;
  if(saved?.source==='account-reference'&&Number.isFinite(saved.observedAt)&&saved.observedAt>0&&saved.observedAt<=now&&
    Number.isFinite(saved.makerRate)&&Math.abs(saved.makerRate!)<=.01)
    return {rate:saved.makerRate!,source:'account-reference' as const};
  const official=referenceTradingFee(snapshot.exchange,snapshot.symbol,snapshot.feeProfile);
  if(official)return {rate:official.makerRate,source:'official-reference' as const};
}

/** Match the existing aligned accrued-cash guard without requiring the Maker leg's unused Taker fee.
 * Initial due clocks and later elapsed settlements need receipts or a complete post-grace ledger read. */
function fundingComplete(p:Position,long:MarketSnapshot,short:MarketSnapshot,c:AppConfig,now:number):boolean {
  const checks=p.profitExitPolicy?.fundingChecks;
  if(!Array.isArray(checks)||checks.some(check=>!check||![p.long.exchange,p.short.exchange].includes(check.exchange)||!Number.isFinite(check.timestamp)))return false;
  const grace=Math.max(0,c.adaptiveSettlementGraceSec??60)*1000;
  for(const snapshot of [long,short]){
    const leg=snapshot.exchange===p.long.exchange?p.long:p.short,first=checks.find(check=>check.exchange===leg.exchange),due:number[]=[];
    if(first&&first.timestamp<=now)due.push(first.timestamp);
    if(Number.isFinite(snapshot.nextFundingTime)&&Number.isFinite(snapshot.intervalHours)&&snapshot.intervalHours>0){
      const elapsed=snapshot.nextFundingTime-snapshot.intervalHours*3_600_000;
      if(elapsed>=p.openedAt&&elapsed<=now&&(!first||elapsed>=first.timestamp-1000))due.push(elapsed);
    }
    for(const event of due){
      const received=Number.isFinite(leg.lastFundingAt)&&leg.lastFundingAt!>=event-1000&&leg.lastFundingAt!<=now+1000;
      if(first&&Math.abs(event-first.timestamp)<=1000&&received)continue;
      const complete=Number.isFinite(leg.fundingObservedSince)&&leg.fundingObservedSince!<=p.openedAt&&
        Number.isFinite(leg.fundingObservedAt)&&leg.fundingObservedAt!>=event&&leg.fundingObservedAt!<=now+1000;
      if(!complete||(!received&&leg.fundingObservedAt!<event+grace))return false;
    }
  }
  return true;
}

const within=(quantity:number,bound:number,step:number)=>quantity<=bound||
  quantity-bound<=Math.min(step*1e-7,Number.EPSILON*Math.max(Math.abs(quantity),Math.abs(bound),step)*8);

/** A Maker order need not fit its own visible level. Its confirmed fills must fit the peer's IOC capacity.
 * Reduce-only opening minNotional is irrelevant; both reductions and any remaining holdings stay legal. */
function commonQuantity(p:Position,long:MarketSnapshot,short:MarketSnapshot,capacity:number,exact?:number):number|undefined {
  const step=commonStep(long.quantityStep,short.quantityStep);
  if(!Number.isFinite(step)||step<=0)return;
  const slots=[{held:p.long.quantity,book:long},{held:p.short.quantity,book:short}];
  const legal=(quantity:number)=>Number.isFinite(quantity)&&within(quantity,capacity,step)&&slots.every(({held,book})=>
    within(quantity,held,step)&&isLegalQuantity(quantity,book.quantityStep,book.minQuantity)&&
    ((remaining)=>remaining===0||isLegalQuantity(remaining,book.quantityStep,book.minQuantity))(
      quantitySubtractOnStep(held,quantity,book.quantityStep)));
  if(exact!==undefined)return legal(exact)?exact:undefined;
  const interval=floorQuantity(Math.min(capacity,...slots.map(({held,book})=>
    quantitySubtractOnStep(held,book.minQuantity,book.quantityStep))),step);
  const candidates=[interval,...slots.map(({held})=>floorQuantity(held,step))].filter(legal);
  return candidates.length?Math.max(...candidates):undefined;
}

/** One passive wider-spread leg followed by the peer IOC. This never fetches fees or mutates cash.
 * As in the current profit-exit rule, paid cash is counted once and the remaining full position is valued
 * conditionally at the actual submitted pair prices; the first batch is not a separate profit threshold. */
export function planMakerClose(p:Position,long:MarketSnapshot|undefined,short:MarketSnapshot|undefined,c:AppConfig,now=Date.now(),options:MakerClosePlanOptions={}):MakerClosePlan|undefined {
  if(p.entryPolicy!=='aligned'||p.holdMode!=='adaptive'||p.manualCloseOnly||p.accountClosure||
    !quoteIsFresh(long,c,now)||!quoteIsFresh(short,c,now))return;
  const l=long!,s=short!;
  if(l.source!==s.source||Math.abs(quoteObservedAt(l)-quoteObservedAt(s))>c.maxQuoteSkewMs||
    l.exchange!==p.long.exchange||s.exchange!==p.short.exchange||l.exchange===s.exchange||
    l.base!==p.base||s.base!==p.base||l.symbol!==p.long.symbol||s.symbol!==p.short.symbol||
    p.long.side!=='long'||p.short.side!=='short')return;
  if(![p.long.entryPrice,p.short.entryPrice].every(value=>Number.isFinite(value)&&value>0)||
    !isLegalQuantity(p.long.quantity,l.quantityStep,l.minQuantity)||!isLegalQuantity(p.short.quantity,s.quantityStep,s.minQuantity))return;
  const step=commonStep(l.quantityStep,s.quantityStep),tolerance=Math.min(step*1e-7,
    Number.EPSILON*Math.max(p.long.quantity,p.short.quantity)*8);
  if(!Number.isFinite(step)||step<=0||Math.abs(p.long.quantity-p.short.quantity)>tolerance||
    ![p.fundingUsd,p.realizedSpreadPnlUsd,p.feesUsd,p.transferCostUsd].every(Number.isFinite)||!fundingComplete(p,l,s,c,now))return;
  const threshold=exitProfitThresholdUsd(p,c);
  if(!Number.isFinite(threshold)||threshold<0)return;
  const makerLeg=options.makerLeg??selectMakerCloseLeg(l,s),ltop=top(l),stop=top(s);
  if(!makerLeg||!['long','short'].includes(makerLeg)||!ltop||!stop)return;
  const makerBook=makerLeg==='long'?l:s,takerBook=makerLeg==='long'?s:l;
  const makerSide=makerLeg==='long'?'sell' as const:'buy' as const,takerSide=makerLeg==='long'?'buy' as const:'sell' as const;
  const takerTop=makerLeg==='long'?stop.ask:ltop.bid;
  const quantity=commonQuantity(p,l,s,takerTop.quantity,options.batchQuantity);
  if(quantity===undefined)return;
  const longLimitPrice=options.limits?.longPrice??(makerLeg==='long'?ltop.ask.price:ltop.bid.price),
    shortLimitPrice=options.limits?.shortPrice??(makerLeg==='short'?stop.bid.price:stop.ask.price);
  if(![longLimitPrice,shortLimitPrice].every(price=>Number.isFinite(price)&&price>0)||
    (makerLeg==='long'?(longLimitPrice<=ltop.bid.price||shortLimitPrice<stop.ask.price):
      (shortLimitPrice>=stop.ask.price||longLimitPrice>ltop.bid.price)))return;
  const requireNative=options.requireNativeFees??p.mode==='live',maker=makerFee(makerBook,now,requireNative);
  const nativeTaker=nativeTakerFeeRate(takerBook,now),taker=requireNative?nativeTaker:takerFeeRate(takerBook,c,now,false);
  if(!maker||taker===undefined||!Number.isFinite(taker)||taker<0)return;
  const bookedFeeRebateUsd=estimatedPositionFeeRebateUsd(p,c);
  if(bookedFeeRebateUsd===undefined)return;
  const longFee=makerLeg==='long'?maker.rate:taker,shortFee=makerLeg==='short'?maker.rate:taker;
  const spreadPnlUsd=p.realizedSpreadPnlUsd+p.long.quantity*(longLimitPrice-p.long.entryPrice)+
    p.short.quantity*(p.short.entryPrice-shortLimitPrice);
  const grossLongClosingFee=p.long.quantity*longLimitPrice*longFee,grossShortClosingFee=p.short.quantity*shortLimitPrice*shortFee;
  const grossClosingFeesUsd=grossLongClosingFee+grossShortClosingFee,grossTotalFeesUsd=p.feesUsd+grossClosingFeesUsd;
  const estimatedFeeRebateUsd=bookedFeeRebateUsd+estimateFeeRebateUsd(p.long.exchange,grossLongClosingFee,c)+estimateFeeRebateUsd(p.short.exchange,grossShortClosingFee,c);
  const closingFeesUsd=p.long.quantity*longLimitPrice*effectiveFeeRate(p.long.exchange,longFee,c)!+
    p.short.quantity*shortLimitPrice*effectiveFeeRate(p.short.exchange,shortFee,c)!;
  const totalFeesUsd=p.feesUsd-bookedFeeRebateUsd+closingFeesUsd,netPnlUsd=p.fundingUsd+spreadPnlUsd-totalFeesUsd-p.transferCostUsd;
  const profit:ProfitExitAssessment={spreadPnlUsd,closingFeesUsd,totalFeesUsd,netPnlUsd,
    spreadAfterClosingFeesUsd:spreadPnlUsd-closingFeesUsd,fundingAfterFeesUsd:p.fundingUsd-totalFeesUsd,
    spreadAfterFeesUsd:spreadPnlUsd-totalFeesUsd,bookedFeeRebateUsd,estimatedFeeRebateUsd,grossTotalFeesUsd,grossClosingFeesUsd};
  if(!Object.values(profit).every(Number.isFinite))return;
  const feeSource=maker.source==='native'&&nativeTaker!==undefined?'native' as const:'reference' as const,profitPass=netPnlUsd>threshold;
  return {quantity,commonQuantityStep:step,makerLeg,makerExchange:makerBook.exchange,makerSide,
    makerLimitPrice:makerLeg==='long'?longLimitPrice:shortLimitPrice,takerLeg:makerLeg==='long'?'short':'long',
    takerExchange:takerBook.exchange,takerSide,takerLimitPrice:makerLeg==='long'?shortLimitPrice:longLimitPrice,takerTopQuantity:takerTop.quantity,
    longLimitPrice,shortLimitPrice,longSpreadBps:ltop.spreadBps,shortSpreadBps:stop.spreadBps,
    makerFeeRate:maker.rate,takerFeeRate:taker,feeSource,makerFeeSource:maker.source,takerFeeSource:nativeTaker!==undefined?'native':'reference',
    profit,profitThresholdUsd:threshold,profitPass,submissionAllowed:requireNative&&feeSource==='native'&&profitPass,valuation:'same-price-full-position-estimate'};
}

/** Rest permission for this verified, still-active original order only. It cannot authorize a new batch.
 * A finer-lot Maker can accumulate a real sub-lot carry until its peer can reduce a legal quantity. */
export function canRestConfirmedMakerClose(p:Position,journal:JournalOrder,long:MarketSnapshot|undefined,short:MarketSnapshot|undefined,
  c:AppConfig,now=Date.now()):boolean {
  const state=journal.makerReduction,result=journal.result;
  if(!state||state.activity!=='active'||!state.bookedExecution||!result||result.filledQuantity<=0||
    result.status!=='unknown'||!Number.isFinite(result.feeUsd)||result.averagePriceVerified===false||
    !Number.isFinite(result.averagePrice)||result.averagePrice<=0||p.closeProfitRequired!==true||
    p.entryPolicy!=='aligned'||p.holdMode!=='adaptive'||p.manualCloseOnly||p.accountClosure||
    !quoteIsFresh(long,c,now)||!quoteIsFresh(short,c,now)||now>=state.deadlineAt)return false;
  const l=long!,s=short!,ltop=top(l),stop=top(s),maker=p[state.makerLeg],peer=p[state.makerLeg==='long'?'short':'long'];
  const makerBook=state.makerLeg==='long'?l:s,peerBook=state.makerLeg==='long'?s:l;
  if(!ltop||!stop||l.source!==s.source||Math.abs(quoteObservedAt(l)-quoteObservedAt(s))>c.maxQuoteSkewMs||
    l.exchange!==p.long.exchange||s.exchange!==p.short.exchange||l.exchange===s.exchange||l.base!==p.base||s.base!==p.base||
    l.symbol!==p.long.symbol||s.symbol!==p.short.symbol||journal.positionId!==p.id||journal.exchange!==maker.exchange||
    journal.request.base!==p.base||journal.request.symbol!==maker.symbol||!journal.request.reduceOnly||!journal.request.postOnly||
    journal.request.side!==(state.makerLeg==='long'?'sell':'buy')||p.long.side!=='long'||p.short.side!=='short'||
    ![p.long.entryPrice,p.short.entryPrice].every(value=>Number.isFinite(value)&&value>0)||
    ![p.fundingUsd,p.realizedSpreadPnlUsd,p.feesUsd,p.transferCostUsd].every(Number.isFinite)||!fundingComplete(p,l,s,c,now)||
    !isLegalQuantity(maker.quantity,makerBook.quantityStep,makerBook.minQuantity)||
    !isLegalQuantity(peer.quantity,peerBook.quantityStep,peerBook.minQuantity))return false;
  const remaining=quantitySubtractOnStep(journal.request.quantity,result.filledQuantity,state.quantityStep??NaN);
  const carry=quantitySubtractOnStep(peer.quantity,maker.quantity,peerBook.quantityStep);
  // A legal peer lot is hedged immediately; only a smaller residual can wait on the original Maker.
  if(!(carry>0)||isLegalQuantity(carry,peerBook.quantityStep,peerBook.minQuantity)||
    carry>=Math.max(peerBook.quantityStep,peerBook.minQuantity)||
    !isLegalQuantity(remaining,makerBook.quantityStep,makerBook.minQuantity)||remaining>maker.quantity)return false;
  const eventualPeer=quantityAdd(carry,remaining),peerTop=state.makerLeg==='long'?stop.ask:ltop.bid;
  if(!isLegalQuantity(eventualPeer,peerBook.quantityStep,peerBook.minQuantity)||eventualPeer>peer.quantity||eventualPeer>peerTop.quantity)return false;
  const makerRetained=quantitySubtractOnStep(maker.quantity,remaining,makerBook.quantityStep),
    peerRetained=quantitySubtractOnStep(peer.quantity,eventualPeer,peerBook.quantityStep);
  const tolerance=Number.EPSILON*Math.max(maker.quantity,peer.quantity)*8;
  if(Math.abs(makerRetained-peerRetained)>tolerance||![{q:makerRetained,b:makerBook},{q:peerRetained,b:peerBook}]
    .every(({q,b})=>q===0||isLegalQuantity(q,b.quantityStep,b.minQuantity)))return false;
  const lf=nativeTakerFeeRate(l,now),sf=nativeTakerFeeRate(s,now),mf=nativeMakerFeeRate(makerBook,now),limit=journal.request.limitPrice;
  const threshold=exitProfitThresholdUsd(p,c);
  if(lf===undefined||sf===undefined||mf===undefined||!Number.isFinite(threshold)||threshold<0||
    !Number.isFinite(limit)||limit<=0||(state.makerLeg==='long'?limit<=ltop.bid.price:limit>=stop.ask.price))return false;
  const bookedFeeRebateUsd=estimatedPositionFeeRebateUsd(p,c);
  if(bookedFeeRebateUsd===undefined)return false;
  const net=(lp:number,sp:number,longFee:number,shortFee:number)=>p.fundingUsd+p.realizedSpreadPnlUsd-p.feesUsd+bookedFeeRebateUsd-p.transferCostUsd+
    p.long.quantity*(lp-p.long.entryPrice)+p.short.quantity*(p.short.entryPrice-sp)-
    p.long.quantity*lp*effectiveFeeRate(p.long.exchange,longFee,c)!-p.short.quantity*sp*effectiveFeeRate(p.short.exchange,shortFee,c)!;
  const originalIoc=net(ltop.bid.price,stop.ask.price,lf,sf),makerEstimate=state.makerLeg==='long'?
    net(limit,stop.ask.price,mf,sf):net(ltop.bid.price,limit,lf,mf);
  return Number.isFinite(originalIoc)&&Number.isFinite(makerEstimate)&&originalIoc>threshold&&makerEstimate>threshold;
}
