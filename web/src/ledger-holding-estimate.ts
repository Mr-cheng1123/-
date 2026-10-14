import type {AppState,MarketSnapshot,Position,TradingFeeReference} from '../../src/shared/types';
import {bestCloseOppositeLevel,planBestPriceCloseBatch,planBestPriceReduction} from '../../src/core/close-batch';
import {quoteObservedAt} from '../../src/core/market-validity';
import {estimatedTakerFeeRate,nativeTakerFeeRate} from '../../src/shared/trading-fees';
import {accountPositionMatchesLeg} from './account-position-identity';
import {buildFundingSchedule,type FundingCashEvent} from '../../src/shared/funding-schedule';
import type {LedgerPositionMetrics} from './ledger-position-metrics';

/** The first legal close batch, alongside the whole-position conditional pricing inputs. */
export interface LedgerCloseBatch {
  kind:'paired'|'excess-long'|'excess-short'|'single-long'|'single-short';
  longQuantity:number;
  shortQuantity:number;
  longTotalQuantity:number;
  shortTotalQuantity:number;
  longEntryPrice?:number;
  shortEntryPrice?:number;
  longLimitPrice?:number;
  shortLimitPrice?:number;
  longTopQuantity?:number;
  shortTopQuantity?:number;
  longTakerFeeRate?:number;
  shortTakerFeeRate?:number;
}

/** One complete observation. Future funding and mark-price UPL are not components. */
export interface LedgerCloseBreakdown {
  pricePnlUsd:number;
  realizedPnlUsd:number;
  fundingUsd:number;
  paidFeesUsd:number;
  closingFeesUsd:number;
  transferCostUsd:number;
}

export function ledgerCloseBreakdownNet(value:LedgerCloseBreakdown):number {
  return value.pricePnlUsd+value.realizedPnlUsd+value.fundingUsd-value.paidFeesUsd-value.closingFeesUsd-value.transferCostUsd;
}

export interface LedgerHoldingEstimate {
  legs:Array<{side:'long'|'short';exchange:Position['long']['exchange'];rate?:number;intervalHours?:number;nextFundingTime?:number;observedAt?:number;
    takerFeeRate?:number;takerFeeAt?:number;takerFeeSource?:'exchange'|'reference'|'config';
    takerFeeReferenceSource?:'account-reference'|'official-reference';takerFeeReferenceAt?:number;feeProfile?:MarketSnapshot['feeProfile']}>;
  nextFundingTime?:number;
  targetFundingTime?:number;
  /** Net cash only at nextFundingTime, distinct from the complete two-leg cycle. */
  nextFundingUsd?:number;
  fundingEvents?:FundingCashEvent[];
  asynchronous?:boolean;
  firstPositiveFundingTime?:number;
  maxFundingDrawdownUsd?:number;
  nextReviewAt:number;
  fundingUsd?:number;
  fundingBps?:number;
  longFundingCount?:number;
  shortFundingCount?:number;
  closingFeesUsd?:number;
  closingFeeSource:'exchange'|'reference'|'config'|'unknown';
  closeNetPnlUsd?:number;
  closeBreakdown?:LedgerCloseBreakdown;
  /** All quantities at current opposite top prices, assuming later batches can use those same prices. */
  closePricing?:'best-opposite';
  closeBatch?:LedgerCloseBatch;
  /** Oldest observed book used by this complete closing valuation. */
  closeBookObservedAt?:number;
  /** First millisecond when either closing book is too old; now >= this is stale. */
  closeBookExpiresAt?:number;
  /** Mark-price reference for details only; never establishes executable profit or recovery. */
  markNetAfterCloseFeeUsd?:number;
  basis:'book'|'unknown';
  breakEven:'recovered'|'not_recovered'|'unknown';
  fundingReason?:string;
  exitReason?:string;
}

export function ledgerBreakEvenLabel(estimate:LedgerHoldingEstimate):string {
  if(estimate.basis!=='book'||estimate.breakEven==='unknown'||!Number.isFinite(estimate.closeNetPnlUsd))return '回本待核验';
  if(estimate.closingFeeSource==='reference')return estimate.breakEven==='recovered'?'参考已回本（本地费率）':'参考尚未回本（本地费率）';
  if(estimate.closingFeeSource!=='exchange')return estimate.breakEven==='recovered'?'参考已回本（配置费率）':'参考尚未回本（配置费率）';
  return estimate.breakEven==='recovered'?estimate.closePricing==='best-opposite'?'预计已回本（分批估算）':'已回本（可平估计）':'尚未回本';
}

const validAccountFeeReference=(value:TradingFeeReference|undefined,now:number):value is TradingFeeReference=>
  value?.source==='account-reference'&&Number.isFinite(value.observedAt)&&value.observedAt>0&&value.observedAt<=now&&
  Number.isFinite(value.takerRate)&&value.takerRate>=0&&value.takerRate<=.01;

/** Read-only valuation of actual account quantities. Missing native cash never becomes zero. */
export function ledgerHoldingEstimate(position:Position,metrics:LedgerPositionMetrics,state:AppState,now=Date.now()):LedgerHoldingEstimate {
  const nextReviewAt=position.holdDecision?.nextReviewAt&&position.holdDecision.nextReviewAt>now?
    position.holdDecision.nextReviewAt:now+state.config.pollIntervalMs;
  const result:LedgerHoldingEstimate={nextReviewAt,basis:'unknown',breakEven:'unknown',closingFeeSource:'unknown',legs:[]};
  if(metrics.source!=='account'||!['paired','imbalanced','single'].includes(metrics.holding)){
    result.fundingReason='等待读取当前实际持仓';result.exitReason='当前数量或账户数据未完整返回';return result;
  }
  const legs=(['long','short'] as const).map(side=>({side,contract:position[side],observed:metrics[side],
    quote:state.snapshots.filter(quote=>quote.exchange===position[side].exchange&&quote.symbol===position[side].symbol&&
      quote.base===position.base&&quote.source===state.config.dataSource).sort((a,b)=>quoteObservedAt(b)-quoteObservedAt(a))[0]}))
    .filter(leg=>(leg.observed.quantity??0)>0).map(leg=>{
      const accountFee=nativeTakerFeeRate(leg.observed,now),nativeRate=accountFee??nativeTakerFeeRate(leg.quote,now);
      const account=state.livePortfolio?.exchanges.find(item=>item.exchange===leg.contract.exchange);
      const rows=account?.positions.filter(row=>accountPositionMatchesLeg(account.exchange,row,leg.contract)&&row.quantity>0)??[];
      const references=rows.map(row=>row.feeReference);
      const accountReference=references.length&&references.every(value=>validAccountFeeReference(value,now))&&
        new Set(references.map(value=>value!.takerRate)).size===1?
        {...references[0]!,observedAt:Math.min(...references.map(value=>value!.observedAt))}:undefined;
      const feeReference=accountReference??(validAccountFeeReference(leg.quote?.feeReference,now)?leg.quote!.feeReference:undefined);
      const input={exchange:leg.contract.exchange,symbol:leg.contract.symbol,feeProfile:leg.quote?.feeProfile,feeReference};
      const feeRate=nativeRate??(position.mode==='live'?estimatedTakerFeeRate(input,now):state.config.takerFees[leg.contract.exchange]);
      const feeSource=nativeRate!==undefined?'exchange' as const:position.mode==='live'?'reference' as const:'config' as const;
      return {...leg,feeRate,feeSource,feeVerified:nativeRate!==undefined,
        takerFeeAt:nativeRate===undefined?undefined:accountFee!==undefined?leg.observed.takerFeeAt:leg.quote?.takerFeeAt,
        takerFeeReferenceSource:feeSource==='reference'?(feeReference?'account-reference' as const:'official-reference' as const):undefined,
        takerFeeReferenceAt:feeSource==='reference'?feeReference?.observedAt:undefined,feeProfile:leg.quote?.feeProfile};
    });
  const bookMaxAge=(quote:MarketSnapshot)=>quote.bookTransport==='websocket'?
    Math.min(state.config.maxSnapshotAgeMs,2000):state.config.maxSnapshotAgeMs;
  // Closing valuation depends on books and observed account cash, not the future funding forecast.
  // This display validator retains execution book age/skew limits without changing core execution.
  const fresh=(quote:MarketSnapshot|undefined):quote is MarketSnapshot=>{
    if(!quote||!Number.isFinite(quote.timestamp)||quote.timestamp>now+5000)return false;
    const observed=quoteObservedAt(quote);
    return Number.isFinite(observed)&&observed>0&&observed<=now+5000&&now-observed<=bookMaxAge(quote);
  };
  // Funding clocks remain readable independently of an executable closing book.
  const fundingFresh=(quote:MarketSnapshot|undefined)=>{
    if(!quote)return false;
    const observed=quote.fundingObservedAt===undefined?
      quote.bookTransport==='websocket'?undefined:quoteObservedAt(quote):quote.fundingObservedAt;
    return observed!==undefined&&Number.isFinite(observed)&&observed>0&&observed<=now+5000&&
      now-observed<=Math.min(state.config.maxSnapshotAgeMs,30000);
  };
  result.legs=legs.map(leg=>({side:leg.side,exchange:leg.contract.exchange,
    takerFeeRate:leg.feeRate,takerFeeAt:leg.takerFeeAt,takerFeeSource:leg.feeRate===undefined?undefined:leg.feeSource,
    takerFeeReferenceSource:leg.takerFeeReferenceSource,takerFeeReferenceAt:leg.takerFeeReferenceAt,feeProfile:leg.feeProfile,...(fundingFresh(leg.quote)?{
    rate:Number.isFinite(leg.quote!.fundingRate)?leg.quote!.fundingRate:undefined,
    intervalHours:Number.isFinite(leg.quote!.intervalHours)&&leg.quote!.intervalHours>0?leg.quote!.intervalHours:undefined,
    nextFundingTime:Number.isFinite(leg.quote!.nextFundingTime)&&leg.quote!.nextFundingTime>now?leg.quote!.nextFundingTime:undefined,
    observedAt:leg.quote!.fundingObservedAt??quoteObservedAt(leg.quote!)}:{})}));
  const clocks=legs.filter(leg=>fundingFresh(leg.quote)&&Number.isFinite(leg.quote?.nextFundingTime)&&leg.quote!.nextFundingTime>now);
  if(clocks.length)result.nextFundingTime=Math.min(...clocks.map(leg=>leg.quote!.nextFundingTime));
  const validFunding=legs.length>0&&legs.every(leg=>fundingFresh(leg.quote)&&Number.isFinite(leg.quote!.fundingRate)&&
    leg.quote!.intervalHours>0&&Number.isFinite(leg.quote!.intervalHours)&&Number.isFinite(leg.quote!.markPrice)&&
    leg.quote!.markPrice>0&&leg.quote!.nextFundingTime>now);
  if(validFunding){
    const schedule=buildFundingSchedule(legs.map(leg=>({side:leg.side,exchange:leg.contract.exchange,
      nextFundingTime:leg.quote!.nextFundingTime,intervalHours:leg.quote!.intervalHours,
      fundingRate:leg.quote!.fundingRate,notionalUsd:leg.observed.quantity!*leg.quote!.markPrice})),
      {now,exitDelaySec:state.config.exitDelaySec});
    if(schedule.valid){
      result.nextFundingTime=schedule.nextEventTime;result.nextFundingUsd=schedule.nextEventUsd;
      result.targetFundingTime=schedule.endTime;result.fundingUsd=schedule.totalUsd;
      result.fundingEvents=schedule.events;result.longFundingCount=schedule.longCount;result.shortFundingCount=schedule.shortCount;
      result.asynchronous=schedule.asynchronous;
      result.firstPositiveFundingTime=schedule.events.find(event=>event.cumulativeUsd>1e-10)?.time;
      result.maxFundingDrawdownUsd=Math.max(0,-schedule.minCumulativeUsd);
      const value=legs.reduce((total,leg)=>total+leg.observed.quantity!*leg.quote!.markPrice,0)/legs.length;
      result.fundingBps=result.fundingUsd/value*10000;
    }else result.fundingReason=schedule.reason;
  }else result.fundingReason='等待实际持仓合约的最新费率和结算时钟';

  if(legs.length&&legs.every(leg=>Number.isFinite(leg.feeRate)&&leg.feeRate!>=0))
    result.closingFeeSource=legs.every(leg=>leg.feeVerified)?'exchange':position.mode==='live'?'reference':'config';
  if(!legs.length||legs.some(leg=>!Number.isFinite(leg.feeRate)||leg.feeRate!<0)){
    result.exitReason='等待读取有效平仓费率';return result;
  }
  const transferCost=position.transferCostUsd;
  if(legs.every(leg=>Number.isFinite(leg.observed.markPrice)&&leg.observed.markPrice!>0)){
    const markFees=legs.reduce((total,leg)=>total+leg.observed.quantity!*leg.observed.markPrice!*leg.feeRate!,0);
    result.closingFeesUsd=markFees;
    if(Number.isFinite(metrics.netPnlUsd)&&Number.isFinite(transferCost)&&transferCost>=0)
      result.markNetAfterCloseFeeUsd=metrics.netPnlUsd!-markFees-transferCost;
  }
  if(metrics.cycleMismatch&&!position.id.startsWith('account-display:')){
    result.exitReason='账户当前开仓周期与原记录不一致，暂不估算原策略平仓净损益';return result;
  }
  if(legs.some(leg=>!Number.isFinite(leg.observed.entryPrice)||leg.observed.entryPrice!<=0)){
    result.exitReason='账户当前开仓均价未完整返回，不使用旧成交账本替代';return result;
  }
  const cashComplete=[metrics.realizedPnlUsd,metrics.fundingUsd,metrics.feesUsd,transferCost].every(Number.isFinite)&&transferCost>=0;
  const quoteTimes=legs.map(leg=>leg.quote?quoteObservedAt(leg.quote):NaN);
  const synchronized=quoteTimes.every(Number.isFinite)&&Math.max(...quoteTimes)-Math.min(...quoteTimes)<=state.config.maxQuoteSkewMs;
  const priced=legs.map(leg=>({...leg,top:leg.quote?bestCloseOppositeLevel(leg.quote,leg.side):undefined}));
  const booksReady=synchronized&&priced.every(leg=>fresh(leg.quote)&&!!leg.top);
  let batch:LedgerCloseBatch|undefined;
  if(booksReady){
    const long=priced.find(leg=>leg.side==='long'),short=priced.find(leg=>leg.side==='short');
    const longQuantity=metrics.long.quantity??0,shortQuantity=metrics.short.quantity??0;
    const total={longTotalQuantity:longQuantity,shortTotalQuantity:shortQuantity,
      ...(long?{longEntryPrice:long.observed.entryPrice,longLimitPrice:long.top!.price,longTopQuantity:long.top!.quantity,longTakerFeeRate:long.feeRate}:{}),
      ...(short?{shortEntryPrice:short.observed.entryPrice,shortLimitPrice:short.top!.price,shortTopQuantity:short.top!.quantity,shortTakerFeeRate:short.feeRate}:{})};
    const difference=longQuantity-shortQuantity,tolerance=Math.max(1e-10,Math.max(longQuantity,shortQuantity)*1e-8);
    if(long&&short&&Math.abs(difference)<=tolerance){
      const plan=planBestPriceCloseBatch(long.quote!,short.quote!,longQuantity,shortQuantity);
      if(plan)batch={...total,kind:'paired',longQuantity:plan.quantity,shortQuantity:plan.quantity};
    }else{
      // A single or imbalanced pair first reduces only its existing excess; the
      // conditional estimate still includes every actual held coin on both legs.
      const side=difference>0?'long':'short',excess=side==='long'?long:short;
      const plan=excess?planBestPriceReduction(excess.quote!,side,Math.abs(difference)):undefined;
      if(plan)batch={...total,kind:long&&short?side==='long'?'excess-long':'excess-short':side==='long'?'single-long':'single-short',
        longQuantity:side==='long'?plan.quantity:0,shortQuantity:side==='short'?plan.quantity:0};
    }
  }
  if(batch){
    let pricePnl=0,bookFees=0;
    for(const leg of priced){
      const value=leg.top!.price*leg.observed.quantity!;
      pricePnl+=(leg.side==='long'?1:-1)*(leg.top!.price-leg.observed.entryPrice!)*leg.observed.quantity!;
      bookFees+=value*leg.feeRate!;
    }
    result.closingFeesUsd=bookFees;result.basis='book';
    result.closePricing='best-opposite';result.closeBatch=batch;
    result.closeBookObservedAt=Math.min(...quoteTimes);
    result.closeBookExpiresAt=Math.min(...legs.map(leg=>quoteObservedAt(leg.quote!)+bookMaxAge(leg.quote!)+1));
    if(cashComplete){
      result.closeBreakdown={pricePnlUsd:pricePnl,realizedPnlUsd:metrics.realizedPnlUsd!,fundingUsd:metrics.fundingUsd!,
        paidFeesUsd:metrics.feesUsd!,closingFeesUsd:bookFees,transferCostUsd:transferCost};
      result.closeNetPnlUsd=ledgerCloseBreakdownNet(result.closeBreakdown);
    }
  }else result.exitReason=booksReady?'当前对手价1尚不足一个合法平仓批次，等待首档数量更新':'平仓盘口未完整同步，等待同口径盘口估值';
  if(!cashComplete)result.exitReason='账户资金费、手续费、已实现价格损益或转账成本未完整返回，暂不判断回本';
  else if(Number.isFinite(result.closeNetPnlUsd))result.breakEven=result.closeNetPnlUsd!>=0?'recovered':'not_recovered';
  return result;
}
