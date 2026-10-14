import type {AppConfig,ExitProfit,FundingLossExit,MarketSnapshot,Position,ProfitExitPolicy} from '../shared/types.js';
import {commonStep,quoteSkewMs,sweep} from './strategy.js';
import {quoteIsFresh,quoteObservedAt} from './market-validity.js';
import {bookIsUncrossedWhenObserved} from './funding-carry.js';
import {takerFeeRate} from '../shared/trading-fees.js';
import {effectiveFeeRate,estimateFeeRebateUsd,estimatedPositionFeeRebateUsd,feeRebatePct} from '../shared/fee-rebates.js';
import {buildFundingSchedule,type FundingSchedule} from '../shared/funding-schedule.js';
import {planBestPriceCloseBatch,type BestPriceCloseBatchPlan} from './close-batch.js';
import {bestOppositeLevel} from './entry-batch.js';
import {exitProfitThresholdUsd} from './exit-profit-threshold.js';
import {currentExitStrategyPosition,usesCurrentExitStrategy} from '../shared/current-exit-strategy.js';

export const FUNDING_LOSS_EXIT_MIN_SAVINGS_USD=.10;
export const FUNDING_LOSS_EXIT_PAYMENT_WINDOW_MS=5*60_000;

export interface ProfitExitAssessment extends ExitProfit {
  closingFeesUsd:number;
  spreadAfterClosingFeesUsd:number;
}
/** The batch is currently visible; the whole-position valuation assumes later batches keep these prices. */
export interface BestOppositeProfitExitAssessment extends ProfitExitAssessment {
  pricing:'best-opposite';
  valuation:'same-price-full-position-estimate';
  batch:BestPriceCloseBatchPlan;
}
/** A scoped confirmed tail uses both actual unequal holdings; it does not invent a paired batch. */
export interface ConfirmedLotTailProfitExitAssessment extends ProfitExitAssessment {
  pricing:'best-opposite';valuation:'actual-unequal-position-estimate';
  longQuantity:number;shortQuantity:number;longPrice:number;shortPrice:number;
}
export interface BestOppositeExitOptions {pricing:'best-opposite';batchQuantity?:number;requireNativeFees?:boolean}
export interface AlignedExitAssessment {
  fundingSchedule:FundingSchedule;
  profit?:ProfitExitAssessment;
  expectedFundingUsd:number;
  expectedFundingBps:number;
  targetFundingTime:number;
  passes:boolean;
  exitSignal?:'profit'|'funding-loss';
  fundingLossExit?:FundingLossExit;
  reason:string;
}

export function profitExitPolicy(long:MarketSnapshot,short:MarketSnapshot,config:AppConfig):ProfitExitPolicy {
  const firstFundingTime=Math.max(long.nextFundingTime,short.nextFundingTime);
  return {firstFundingTime,earliestExitAt:firstFundingTime+config.exitDelaySec*1000,minSpreadNetUsd:config.minSpreadNetUsd,minCombinedNetUsd:config.minCombinedNetUsd,
    fundingChecks:[long,short].filter(s=>config.entryPolicy==='aligned'||s.fundingRate!==0).map(s=>({exchange:s.exchange,timestamp:s.nextFundingTime}))};
}

function alignedFundingComplete(p:Position,long:MarketSnapshot,short:MarketSnapshot,c:AppConfig,now:number):boolean {
  const checks=p.profitExitPolicy?.fundingChecks??[];
  const grace=Math.max(0,c.adaptiveSettlementGraceSec??60)*1000;
  for(const snapshot of [long,short]){
    const leg=snapshot.exchange===p.long.exchange?p.long:p.short;
    // Old once/continuous entries may have no frozen first clock. They require a real
    // complete billing read, rather than treating absent historical settlement policy as zero cash.
    if(!p.profitExitPolicy&&(!Number.isFinite(leg.fundingObservedSince)||leg.fundingObservedSince!>p.openedAt||
      !Number.isFinite(leg.fundingObservedAt)||leg.fundingObservedAt!<p.openedAt||leg.fundingObservedAt!>now+1000))return false;
    const first=checks.find(check=>check?.exchange===leg.exchange);
    if(first&&!Number.isFinite(first.timestamp))return false;
    const due: number[]=[];
    if(first&&first.timestamp<=now)due.push(first.timestamp);
    if(Number.isFinite(snapshot.nextFundingTime)&&Number.isFinite(snapshot.intervalHours)&&snapshot.intervalHours>0){
      const elapsed=snapshot.nextFundingTime-snapshot.intervalHours*3_600_000;
      // The first clock frozen at entry is stronger evidence than inferring an earlier event from a changed interval.
      if(elapsed>=p.openedAt&&elapsed<=now&&(!first||elapsed>=first.timestamp-1000))due.push(elapsed);
    }
    for(const event of due){
      const received=Number.isFinite(leg.lastFundingAt)&&leg.lastFundingAt!>=event-1000&&leg.lastFundingAt!<=now+1000;
      const firstReceipt=first&&Math.abs(event-first.timestamp)<=1000&&received;
      if(firstReceipt)continue;
      const completeWindow=Number.isFinite(leg.fundingObservedSince)&&leg.fundingObservedSince!<=p.openedAt&&
        Number.isFinite(leg.fundingObservedAt)&&leg.fundingObservedAt!>=event&&leg.fundingObservedAt!<=now+1000;
      if(!completeWindow||(!received&&leg.fundingObservedAt!<event+grace))return false;
    }
  }
  return true;
}

interface ProfitExitContext {long:MarketSnapshot;short:MarketSnapshot;longFee:number;shortFee:number}
/** Shared accrued cash, exact contract, native fee and settlement evidence. It does not choose a closing price. */
function profitExitContext(p:Position,long:MarketSnapshot|undefined,short:MarketSnapshot|undefined,c:AppConfig,now:number,requireNativeFees=p.mode==='live',allowConfirmedUnequal=false):ProfitExitContext|undefined {
  p=currentExitStrategyPosition(p,c);
  const policy=p.profitExitPolicy;
  // minSpreadNetUsd is an obsolete independent gate carried by older journals.
  // An aligned position can bank a price advantage before its first funding settlement. Due payments still need evidence.
  if(!policy&&!usesCurrentExitStrategy(p,c)||policy&&!Array.isArray(policy.fundingChecks)||
    (p.entryPolicy!=='aligned'&&(!policy||now<policy.earliestExitAt||!Number.isFinite(policy.earliestExitAt)||!Number.isFinite(policy.minCombinedNetUsd)||policy.minCombinedNetUsd<0)))return;
  if(!quoteIsFresh(long,c,now)||!quoteIsFresh(short,c,now))return;
  const l=long!,s=short!;
  if(l.exchange!==p.long.exchange||s.exchange!==p.short.exchange||l.base!==p.base||s.base!==p.base||l.symbol!==p.long.symbol||s.symbol!==p.short.symbol)return;
  if(![p.long.quantity,p.short.quantity,p.long.entryPrice,p.short.entryPrice,l.quantityStep,s.quantityStep].every(v=>Number.isFinite(v)&&v>0))return;
  if(![l.quantityStep*1e12,s.quantityStep*1e12].every(Number.isFinite))return;
  if(!allowConfirmedUnequal&&Math.abs(p.long.quantity-p.short.quantity)>commonStep(l.quantityStep,s.quantityStep)*.1)return;
  const longFee=takerFeeRate(l,c,now,requireNativeFees),shortFee=takerFeeRate(s,c,now,requireNativeFees);
  if(![longFee,shortFee].every(v=>Number.isFinite(v)&&v!>=0)||
    ![p.feesUsd,p.transferCostUsd,p.fundingUsd,p.realizedSpreadPnlUsd].every(Number.isFinite))return;
  if(p.entryPolicy==='aligned'){
    if(policy?.fundingChecks.some(check=>!check||![p.long.exchange,p.short.exchange].includes(check.exchange)||!Number.isFinite(check.timestamp)))return;
    if(!alignedFundingComplete(p,l,s,c,now))return;
  }else if(policy!.fundingChecks.some(check=>{
    if(!check)return true;
    const leg=p.long.exchange===check.exchange?p.long:p.short.exchange===check.exchange?p.short:undefined;
    if(!leg||!Number.isFinite(check.timestamp))return true;
    return !Number.isFinite(leg.lastFundingAt)||leg.lastFundingAt!<check.timestamp-1000;
  }))return;
  return {long:l,short:s,longFee:longFee!,shortFee:shortFee!};
}

/** All paid fees and realized price PnL are retained; only the remaining two legs add estimated closing fees. */
function pricedExitProfit(p:Position,longPrice:number,shortPrice:number,longFee:number,shortFee:number,c:AppConfig):ProfitExitAssessment|undefined {
  if(![longPrice,shortPrice].every(v=>Number.isFinite(v)&&v>0))return;
  const bookedFeeRebateUsd=estimatedPositionFeeRebateUsd(p,c);
  if(bookedFeeRebateUsd===undefined)return;
  const spreadPnlUsd=p.realizedSpreadPnlUsd+p.long.quantity*(longPrice-p.long.entryPrice)+p.short.quantity*(p.short.entryPrice-shortPrice);
  const grossLongClosingFee=p.long.quantity*longPrice*longFee,grossShortClosingFee=p.short.quantity*shortPrice*shortFee;
  const grossClosingFeesUsd=grossLongClosingFee+grossShortClosingFee,grossTotalFeesUsd=p.feesUsd+grossClosingFeesUsd;
  const estimatedFeeRebateUsd=bookedFeeRebateUsd+estimateFeeRebateUsd(p.long.exchange,grossLongClosingFee,c)+estimateFeeRebateUsd(p.short.exchange,grossShortClosingFee,c);
  const closingFeesUsd=p.long.quantity*longPrice*effectiveFeeRate(p.long.exchange,longFee,c)!+
    p.short.quantity*shortPrice*effectiveFeeRate(p.short.exchange,shortFee,c)!;
  const totalFeesUsd=p.feesUsd-bookedFeeRebateUsd+closingFeesUsd;
  const spreadAfterClosingFeesUsd=spreadPnlUsd-closingFeesUsd;
  const fundingAfterFeesUsd=p.fundingUsd-totalFeesUsd,spreadAfterFeesUsd=spreadPnlUsd-totalFeesUsd;
  const netPnlUsd=p.fundingUsd+spreadPnlUsd-totalFeesUsd-p.transferCostUsd;
  if(![spreadPnlUsd,closingFeesUsd,spreadAfterClosingFeesUsd,totalFeesUsd,fundingAfterFeesUsd,spreadAfterFeesUsd,netPnlUsd].every(Number.isFinite))return;
  return {spreadPnlUsd,closingFeesUsd,spreadAfterClosingFeesUsd,totalFeesUsd,fundingAfterFeesUsd,spreadAfterFeesUsd,netPnlUsd,
    ...([p.long,p.short].some(leg=>feeRebatePct(leg.exchange,c)>0)?
      {bookedFeeRebateUsd,estimatedFeeRebateUsd,grossClosingFeesUsd,grossTotalFeesUsd}:{})};
}

function depthExitPrices(p:Position,l:MarketSnapshot,s:MarketSnapshot,worstLimits:boolean,limits?:{longPrice:number;shortPrice:number}) {
  const levels=(snapshot:MarketSnapshot,side:'bids'|'asks')=>(Array.isArray(snapshot[side])?snapshot[side]:[]).filter(b=>b&&Number.isFinite(b.price)&&b.price>0&&Number.isFinite(b.quantity)&&b.quantity>0)
    .sort((a,b)=>side==='bids'?b.price-a.price:a.price-b.price);
  const sell=sweep(levels(l,'bids'),p.long.quantity),buy=sweep(levels(s,'asks'),p.short.quantity);
  if(sell.filled<p.long.quantity*(1-1e-9)||buy.filled<p.short.quantity*(1-1e-9))return;
  const longPrice=limits?.longPrice??(worstLimits?sell.worstPrice:sell.average),shortPrice=limits?.shortPrice??(worstLimits?buy.worstPrice:buy.average);
  return {longPrice,shortPrice};
}

/** Compatibility: actual accrued funding and complete executable closing depth, never a mark-price estimate. */
export function assessProfitExit(p:Position,long:MarketSnapshot|undefined,short:MarketSnapshot|undefined,c:AppConfig,now=Date.now(),worstLimits=false,limits?:{longPrice:number;shortPrice:number},requireNativeFees=p.mode==='live'):ProfitExitAssessment|undefined {
  const context=profitExitContext(p,long,short,c,now,requireNativeFees);
  if(!context)return;
  const {long:l,short:s,longFee,shortFee}=context,prices=depthExitPrices(p,l,s,worstLimits,limits);
  return prices?pricedExitProfit(p,prices.longPrice,prices.shortPrice,longFee,shortFee,c):undefined;
}

/** Current bid 1 / ask 1 and one legal common batch. Full net is a conditional same-price valuation,
 * not proof that the full remaining quantity can execute at these prices now. A specified batch is
 * validated exactly; it does not add a new independent profit threshold or pro-rate paid cash flows.
 * Supplied limits are the unchanged IOC bounds actually being submitted after a favorable book update. */
export function assessBestOppositeProfitExit(p:Position,long:MarketSnapshot|undefined,short:MarketSnapshot|undefined,c:AppConfig,now=Date.now(),batchQuantity?:number,limits?:{longPrice:number;shortPrice:number},requireNativeFees=p.mode==='live'):BestOppositeProfitExitAssessment|undefined {
  const context=profitExitContext(p,long,short,c,now,requireNativeFees);
  if(!context)return;
  const {long:l,short:s,longFee,shortFee}=context;
  if(l.source!==s.source||quoteSkewMs(l,s)>c.maxQuoteSkewMs||!bookIsUncrossedWhenObserved(l)||!bookIsUncrossedWhenObserved(s))return;
  let batch=planBestPriceCloseBatch(l,s,p.long.quantity,p.short.quantity);
  if(!batch)return;
  if(batchQuantity!==undefined){
    const tolerance=Number.EPSILON*Math.max(1,Math.abs(batchQuantity),Math.abs(batch.quantity))*8;
    if(!Number.isFinite(batchQuantity)||batchQuantity<=0||batchQuantity>batch.quantity+tolerance)return;
    const exact=planBestPriceCloseBatch(l,s,batchQuantity,batchQuantity);
    if(!exact||Math.abs(exact.quantity-batchQuantity)>tolerance)return;
    batch=exact;
  }
  if(limits){
    if(![limits.longPrice,limits.shortPrice].every(price=>Number.isFinite(price)&&price>0)||
      limits.longPrice>batch.longLimitPrice||limits.shortPrice<batch.shortLimitPrice)return;
    batch={...batch,longLimitPrice:limits.longPrice,shortLimitPrice:limits.shortPrice};
  }
  const profit=pricedExitProfit(p,batch.longLimitPrice,batch.shortLimitPrice,longFee,shortFee,c);
  return profit?{...profit,pricing:'best-opposite',valuation:'same-price-full-position-estimate',batch}:undefined;
}

/** Only a separately verified confirmed-lot restoration may use this signal. It grants no
 * order or peer budget: all cash/quantities stay actual and due funding remains mandatory.
 * Reference fees are permitted only for discovering a candidate, never for the real planner. */
export function assessConfirmedLotTailProfitExit(p:Position,long:MarketSnapshot|undefined,short:MarketSnapshot|undefined,c:AppConfig,now=Date.now(),requireNativeFees=true):ConfirmedLotTailProfitExitAssessment|undefined {
  if(!usesCurrentExitStrategy(p,c))return;
  const context=profitExitContext(p,long,short,c,now,requireNativeFees,true);
  if(!context)return;
  const {long:l,short:s,longFee,shortFee}=context;
  if(l.source!==s.source||quoteSkewMs(l,s)>c.maxQuoteSkewMs||!bookIsUncrossedWhenObserved(l)||!bookIsUncrossedWhenObserved(s))return;
  const sell=bestOppositeLevel(l,'sell'),buy=bestOppositeLevel(s,'buy');
  if(!sell||!buy)return;
  const profit=pricedExitProfit(p,sell.price,buy.price,longFee,shortFee,c);
  return profit?{...profit,pricing:'best-opposite',valuation:'actual-unequal-position-estimate',
    longQuantity:p.long.quantity,shortQuantity:p.short.quantity,longPrice:sell.price,shortPrice:buy.price}:undefined;
}

/** Conservative cost allowance, not an assertion that closing fees are unique to exiting now.
 * Cash, costs and the full-remaining $0.10 margin scale together for the concrete common batch.
 * Sunk opening costs, realized PnL and accrued funding never enter this marginal comparison. */
function assessFundingLossExit(p:Position,l:MarketSnapshot,s:MarketSnapshot,schedule:FundingSchedule,
  profit:ProfitExitAssessment,longPrice:number,shortPrice:number,quantity:number,now:number):FundingLossExit|undefined {
  if(p.holdMode!=='adaptive'||schedule.totalUsd>=0||![quantity,p.long.quantity,p.short.quantity,longPrice,shortPrice].every(v=>Number.isFinite(v)&&v>0)||
    quantity>Math.min(p.long.quantity,p.short.quantity))return;
  const midpoint=(snapshot:MarketSnapshot)=>{
    const bid=bestOppositeLevel(snapshot,'sell'),ask=bestOppositeLevel(snapshot,'buy');
    if(!bid||!ask||bid.price>ask.price)return;
    const mid=bid.price/2+ask.price/2;
    return Number.isFinite(mid)&&mid>0?mid:undefined;
  };
  const longMid=midpoint(l),shortMid=midpoint(s);
  if(longMid===undefined||shortMid===undefined)return;
  const ratio=quantity/p.long.quantity;
  const expectedFundingLossUsd=-schedule.totalUsd*ratio,closingFeesUsd=profit.closingFeesUsd*ratio;
  // Clamp each leg separately: a favorable quote cannot subsidize an adverse price on its peer.
  const spreadCostUsd=quantity*(Math.max(0,longMid-longPrice)+Math.max(0,shortPrice-shortMid));
  const exitCostAllowanceUsd=closingFeesUsd+spreadCostUsd,minimumSavingsUsd=FUNDING_LOSS_EXIT_MIN_SAVINGS_USD*ratio;
  const expectedSavingsUsd=expectedFundingLossUsd-exitCostAllowanceUsd;
  if(![expectedFundingLossUsd,closingFeesUsd,spreadCostUsd,exitCostAllowanceUsd,minimumSavingsUsd,expectedSavingsUsd].every(Number.isFinite))return;
  const nextPaymentAt=schedule.events.find(event=>event.netUsd<0)?.time;
  // Unlike the legacy profit path, accepting a loss always waits for an actual imminent payment.
  const paymentWindowOpen=nextPaymentAt!==undefined&&nextPaymentAt===schedule.nextEventTime&&
    nextPaymentAt>now&&nextPaymentAt-now<=FUNDING_LOSS_EXIT_PAYMENT_WINDOW_MS;
  return {quantity,expectedFundingLossUsd,closingFeesUsd,spreadCostUsd,exitCostAllowanceUsd,minimumSavingsUsd,
    expectedSavingsUsd,...(nextPaymentAt!==undefined?{nextPaymentAt}:{}),paymentWindowOpen};
}

/** Profit is bankable independently of future carry. Funding-loss candidates still need independent
 * funding observations through FundingExitStabilityTracker before each new automatic closing batch. */
export function assessAlignedExit(p:Position,long:MarketSnapshot|undefined,short:MarketSnapshot|undefined,c:AppConfig,now=Date.now(),worstLimits=false,limits?:{longPrice:number;shortPrice:number},options?:BestOppositeExitOptions):AlignedExitAssessment|undefined {
  p=currentExitStrategyPosition(p,c);
  if(p.entryPolicy!=='aligned'||!quoteIsFresh(long,c,now)||!quoteIsFresh(short,c,now))return;
  const l=long!,s=short!;
  if(l.source!==s.source||quoteSkewMs(l,s)>c.maxQuoteSkewMs||!bookIsUncrossedWhenObserved(l)||!bookIsUncrossedWhenObserved(s))return;
  if(l.exchange!==p.long.exchange||s.exchange!==p.short.exchange||l.base!==p.base||s.base!==p.base||l.symbol!==p.long.symbol||s.symbol!==p.short.symbol)return;
  if(![p.long.quantity,p.short.quantity,l.markPrice,s.markPrice,l.intervalHours,s.intervalHours].every(v=>Number.isFinite(v)&&v>0)||
    ![l.fundingRate,s.fundingRate,l.nextFundingTime,s.nextFundingTime].every(Number.isFinite)||l.nextFundingTime<=now||s.nextFundingTime<=now)return;
  const priorTarget=p.holdDecision?.targetFundingTime??p.plannedExitAt-c.exitDelaySec*1000;
  if(Number.isFinite(priorTarget)&&priorTarget>p.openedAt&&now>=priorTarget&&(quoteObservedAt(l)<priorTarget||quoteObservedAt(s)<priorTarget))return;
  const targetFundingTime=Math.max(l.nextFundingTime,s.nextFundingTime);
  const longValue=p.long.quantity*l.markPrice,shortValue=p.short.quantity*s.markPrice;
  const fundingSchedule=buildFundingSchedule({...l,notionalUsd:longValue},{...s,notionalUsd:shortValue},{now});
  if(!fundingSchedule.valid)return;
  const expectedFundingUsd=fundingSchedule.totalUsd;
  const expectedFundingBps=expectedFundingUsd/((longValue+shortValue)/2)*10000;
  const profitThreshold=exitProfitThresholdUsd(p,c);
  if(![expectedFundingUsd,expectedFundingBps,profitThreshold].every(Number.isFinite)||profitThreshold<0)return;
  // Explicit legacy limit/depth callers keep their old complete-depth semantics.
  const firstPrice=options?.pricing==='best-opposite'||(!worstLimits&&!limits);
  const requireNativeFees=options?.requireNativeFees??p.mode==='live';
  const bestProfit=firstPrice?assessBestOppositeProfitExit(p,l,s,c,now,options?.batchQuantity,limits,requireNativeFees):undefined;
  const profit=firstPrice?bestProfit:assessProfitExit(p,l,s,c,now,worstLimits,limits,requireNativeFees);
  const estimate=firstPrice?'全仓对手价1条件估算净收益':'当前可平净收益';
  const execution=bestProfit?`；先按对手价1分批处理 ${bestProfit.batch.quantity}，后续批次重新核验，估算不保证全仓同价成交`:'';
  const carry=`双方本轮净资金费合计 ${expectedFundingBps.toFixed(2)} bps（截至 ${new Date(targetFundingTime).toLocaleTimeString('zh-CN',{hour12:false})}）`;
  const pendingPayment=fundingSchedule.nextEventUsd<0&&expectedFundingUsd>0?`；最近单次预计先付 $${Math.abs(fundingSchedule.nextEventUsd).toFixed(4)}，收入在后续结算，不能把本轮合计视为最近一次到账`:'';
  const projection=fundingSchedule.hasRepeatedRate?'；后续未公布轮次按当前费率推算，非确定收益':'';
  if(alignedExitProfitsPass(p,profit,c))return {profit,fundingSchedule,expectedFundingUsd,expectedFundingBps,targetFundingTime,passes:true,exitSignal:'profit',
    reason:`累计资金费与价格损益合计扣除全部开平手续费及成本后，${estimate} $${profit!.netPnlUsd.toFixed(4)} 超过 $${profitThreshold.toFixed(2)}，开始盈利退出${execution}；${carry}${pendingPayment}${projection}`};
  if(expectedFundingUsd>0)return {profit,fundingSchedule,expectedFundingUsd,expectedFundingBps,targetFundingTime,passes:false,
    reason:`${carry} 仍为正，继续持有；当前可平净收益尚未超过 $${profitThreshold.toFixed(2)}${pendingPayment}${projection}${profit?'':'；当前可平净收益尚待核验'}`};
  if(!profit)return {fundingSchedule,expectedFundingUsd,expectedFundingBps,targetFundingTime,passes:false,reason:`${carry}；实际资金费、成本或可平盘口尚未完整确认，等待核验`};
  // Reuse the exact prices used by the accrued-profit valuation, including conservative IOC limits.
  const quantity=bestProfit?.batch.quantity??p.long.quantity;
  const prices=bestProfit?{longPrice:bestProfit.batch.longLimitPrice,shortPrice:bestProfit.batch.shortLimitPrice}:depthExitPrices(p,l,s,worstLimits,limits);
  const fundingLossExit=prices&&assessFundingLossExit(p,l,s,fundingSchedule,profit,prices.longPrice,prices.shortPrice,quantity,now);
  const base={profit,fundingSchedule,expectedFundingUsd,expectedFundingBps,targetFundingTime};
  if(!fundingLossExit)return {...base,passes:false,
    reason:`${carry} 已无优势；${estimate} $${profit.netPnlUsd.toFixed(4)} 未超过 $${profitThreshold.toFixed(2)}，等待盈利或受控退出条件，不因一次资金费翻负直接亏损平仓${execution}`};
  const comparison=`本批 ${quantity} 的预计资金费支出 $${fundingLossExit.expectedFundingLossUsd.toFixed(4)}，平仓手续费 $${fundingLossExit.closingFeesUsd.toFixed(4)}＋盘口让价 $${fundingLossExit.spreadCostUsd.toFixed(4)}，扣除后余量 $${fundingLossExit.expectedSavingsUsd.toFixed(4)}，须超过 $${fundingLossExit.minimumSavingsUsd.toFixed(4)}（全仓剩余数量余量 $${FUNDING_LOSS_EXIT_MIN_SAVINGS_USD.toFixed(2)}，本批按比例）`;
  const window=fundingLossExit.paymentWindowOpen?'下一实际付款已进入 5 分钟窗口':'下一实际付款尚未进入 5 分钟窗口或此前先有收款';
  const savingsPass=fundingLossExit.expectedSavingsUsd>fundingLossExit.minimumSavingsUsd+1e-10;
  const passes=savingsPass&&fundingLossExit.paymentWindowOpen;
  return {...base,fundingLossExit,passes,...(passes?{exitSignal:'funding-loss' as const}:{}),
    reason:`${carry} 已无优势；${comparison}；${window}；${passes?'准备受控退出，可接受已形成的亏损':'继续复核，受控退出条件未达标'}；${estimate} $${profit.netPnlUsd.toFixed(4)}；历史亏损不计入继续持有成本${projection}${execution}`};
}

/** Current aligned profit guard, shared by previews and each submitted common closing batch. */
export function alignedExitProfitsPass(p:Position,profit:ExitProfit|undefined,c:AppConfig):boolean {
  p=currentExitStrategyPosition(p,c);
  const threshold=exitProfitThresholdUsd(p,c);
  return p.entryPolicy==='aligned'&&!!profit&&Number.isFinite(profit.netPnlUsd)&&Number.isFinite(threshold)&&threshold>=0&&profit.netPnlUsd>threshold;
}

/** Compatibility rule for legacy joint positions, whose frozen thresholds remain unchanged. */
export function bothExitProfitsPass(p:Position,profit:ExitProfit|undefined):boolean {
  const threshold=p.profitExitPolicy?.minCombinedNetUsd;
  return !!profit&&Number.isFinite(profit.netPnlUsd)&&Number.isFinite(threshold)&&threshold!>=0&&profit.netPnlUsd>threshold!;
}
