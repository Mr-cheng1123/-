import type {AppConfig,FundingLossExit,MarketSnapshot,Position} from '../shared/types.js';
import {buildFundingSchedule,type FundingSchedule} from '../shared/funding-schedule.js';
import {effectiveFeeRate} from '../shared/fee-rebates.js';
import {nativeMakerFeeRate,takerFeeRate} from '../shared/trading-fees.js';
import {quoteObservedAt} from './market-validity.js';
import {bestOppositeLevel} from './entry-batch.js';
import {isLegalQuantity} from './order-quantity.js';
import {assessConfirmedLotTailProfitExit,FUNDING_LOSS_EXIT_MIN_SAVINGS_USD,
  FUNDING_LOSS_EXIT_PAYMENT_WINDOW_MS,type AlignedExitAssessment} from './profit-exit.js';

/** Forecasts for the exact new reductions, never the already filled original Maker quantity. */
export interface ConfirmedLotTailFundingLossExit extends FundingLossExit {
  longReduction:number;shortReduction:number;reductionFundingSchedule:FundingSchedule;savingsRatio:number;
  makerLeg:'long'|'short';
  longGrossFeeRate:number;shortGrossFeeRate:number;longEffectiveFeeRate:number;shortEffectiveFeeRate:number;
  longClosingFeeUsd:number;shortClosingFeeUsd:number;longSpreadCostUsd:number;shortSpreadCostUsd:number;
}

/**
 * Economic qualification only. The complete real holding remains the funding
 * history denominator; the new reductions have their own exact marginal cash.
 * The caller must also require the existing independent funding confirmation,
 * original-order/account scope and native permission at the final create boundary.
 * Explicit reference mode only discovers a candidate and never reads an account.
 */
export function assessConfirmedLotTailFundingExit(p:Position,long:MarketSnapshot|undefined,
  short:MarketSnapshot|undefined,c:AppConfig,now:number,longReduction:number,shortReduction:number,
  requireNativeFees=true):AlignedExitAssessment|undefined {
  const profit=assessConfirmedLotTailProfitExit(p,long,short,c,now,requireNativeFees);
  if(!profit||!long||!short||!Number.isFinite(now)||
    ![longReduction,shortReduction].every(quantity=>Number.isFinite(quantity)&&quantity>0)||
    longReduction>p.long.quantity||shortReduction>p.short.quantity||
    !isLegalQuantity(longReduction,long.quantityStep,long.minQuantity)||
    !isLegalQuantity(shortReduction,short.quantityStep,short.minQuantity)||long.quantityStep===short.quantityStep||
    ![long.markPrice,short.markPrice,long.intervalHours,short.intervalHours].every(value=>Number.isFinite(value)&&value>0)||
    ![long.fundingRate,short.fundingRate,long.nextFundingTime,short.nextFundingTime].every(Number.isFinite)||
    long.nextFundingTime<=now||short.nextFundingTime<=now)return;
  const priorTarget=p.holdDecision?.targetFundingTime??p.plannedExitAt-c.exitDelaySec*1000;
  if(Number.isFinite(priorTarget)&&priorTarget>p.openedAt&&now>=priorTarget&&
    (quoteObservedAt(long)<priorTarget||quoteObservedAt(short)<priorTarget))return;
  const longNotional=p.long.quantity*long.markPrice,shortNotional=p.short.quantity*short.markPrice;
  const fundingSchedule=buildFundingSchedule({...long,notionalUsd:longNotional},{...short,notionalUsd:shortNotional},{now});
  const reductionFundingSchedule=buildFundingSchedule({...long,notionalUsd:longReduction*long.markPrice},
    {...short,notionalUsd:shortReduction*short.markPrice},{now});
  if(!fundingSchedule.valid||!reductionFundingSchedule.valid)return;
  const expectedFundingUsd=fundingSchedule.totalUsd,expectedFundingBps=expectedFundingUsd/((longNotional+shortNotional)/2)*10_000,
    targetFundingTime=fundingSchedule.endTime;
  if(![expectedFundingUsd,expectedFundingBps,targetFundingTime].every(Number.isFinite))return;
  const base={fundingSchedule,profit,expectedFundingUsd,expectedFundingBps,targetFundingTime,passes:false};
  if(expectedFundingUsd>=0)return {...base,reason:'完整真实剩余双腿资金费未形成负向支出，不以尾差恢复新增资金费退出'};
  if(reductionFundingSchedule.totalUsd>=0)return {...base,reason:'本次实际新增减仓的两腿净资金费未形成支出，不能把原已成交量或全仓支出按共同量重复计入节省'};
  const makerLeg=long.quantityStep<short.quantityStep?'long':'short',makerFee=nativeMakerFeeRate(makerLeg==='long'?long:short,now),
    longTaker=takerFeeRate(long,c,now,requireNativeFees),shortTaker=takerFeeRate(short,c,now,requireNativeFees);
  if(longTaker===undefined||shortTaker===undefined||requireNativeFees&&makerFee===undefined)return;
  // The finer leg rests as Maker. Its real fee can exceed Taker, so Taker alone
  // is a conservative allowance only when the verified Maker fee is no higher.
  const longGrossFeeRate=makerLeg==='long'?Math.max(longTaker,makerFee??longTaker):longTaker,
    shortGrossFeeRate=makerLeg==='short'?Math.max(shortTaker,makerFee??shortTaker):shortTaker,
    longEffectiveFeeRate=effectiveFeeRate(long.exchange,longGrossFeeRate,c),
    shortEffectiveFeeRate=effectiveFeeRate(short.exchange,shortGrossFeeRate,c);
  if(longEffectiveFeeRate===undefined||shortEffectiveFeeRate===undefined)return;
  const midpoint=(snapshot:MarketSnapshot)=>{
    const bid=bestOppositeLevel(snapshot,'sell'),ask=bestOppositeLevel(snapshot,'buy');
    if(!bid||!ask||bid.price>ask.price)return;
    const mid=bid.price/2+ask.price/2;return Number.isFinite(mid)&&mid>0?mid:undefined;
  };
  const longMid=midpoint(long),shortMid=midpoint(short);
  if(longMid===undefined||shortMid===undefined)return;
  const expectedFundingLossUsd=-reductionFundingSchedule.totalUsd,
    longClosingFeeUsd=longReduction*profit.longPrice*longEffectiveFeeRate,
    shortClosingFeeUsd=shortReduction*profit.shortPrice*shortEffectiveFeeRate,
    longSpreadCostUsd=longReduction*Math.max(0,longMid-profit.longPrice),
    shortSpreadCostUsd=shortReduction*Math.max(0,profit.shortPrice-shortMid),
    closingFeesUsd=longClosingFeeUsd+shortClosingFeeUsd,spreadCostUsd=longSpreadCostUsd+shortSpreadCostUsd,
    exitCostAllowanceUsd=closingFeesUsd+spreadCostUsd,savingsRatio=Math.max(longReduction/p.long.quantity,shortReduction/p.short.quantity),
    minimumSavingsUsd=FUNDING_LOSS_EXIT_MIN_SAVINGS_USD*savingsRatio,expectedSavingsUsd=expectedFundingLossUsd-exitCostAllowanceUsd;
  if(![expectedFundingLossUsd,longClosingFeeUsd,shortClosingFeeUsd,longSpreadCostUsd,shortSpreadCostUsd,
    closingFeesUsd,spreadCostUsd,exitCostAllowanceUsd,savingsRatio,minimumSavingsUsd,expectedSavingsUsd].every(Number.isFinite))return;
  const nextPaymentAt=fundingSchedule.events.find(event=>event.netUsd<0)?.time,
    reductionNextPaymentAt=reductionFundingSchedule.events.find(event=>event.netUsd<0)?.time,
    paymentWindowOpen=nextPaymentAt!==undefined&&nextPaymentAt===fundingSchedule.nextEventTime&&
      reductionNextPaymentAt===reductionFundingSchedule.nextEventTime&&reductionNextPaymentAt===nextPaymentAt&&
      nextPaymentAt>now&&nextPaymentAt-now<=FUNDING_LOSS_EXIT_PAYMENT_WINDOW_MS;
  const fundingLossExit:ConfirmedLotTailFundingLossExit={
    // Compatibility display only. Never submit this as a fictitious equal-leg quantity.
    quantity:Math.max(longReduction,shortReduction),longReduction,shortReduction,reductionFundingSchedule,savingsRatio,makerLeg,
    longGrossFeeRate,shortGrossFeeRate,longEffectiveFeeRate,shortEffectiveFeeRate,
    longClosingFeeUsd,shortClosingFeeUsd,longSpreadCostUsd,shortSpreadCostUsd,
    expectedFundingLossUsd,closingFeesUsd,spreadCostUsd,exitCostAllowanceUsd,minimumSavingsUsd,expectedSavingsUsd,
    ...(nextPaymentAt!==undefined?{nextPaymentAt}:{}),paymentWindowOpen};
  const passes=paymentWindowOpen&&expectedSavingsUsd>minimumSavingsUsd+1e-10;
  return {...base,fundingLossExit,passes,...(passes?{exitSignal:'funding-loss' as const}:{}),
    reason:`完整真实持仓本轮净资金费 ${expectedFundingBps.toFixed(2)} bps；仅本次新增减多 ${longReduction}／减空 ${shortReduction} 的预计资金费支出 $${expectedFundingLossUsd.toFixed(6)}，扣实际费用保守额度 $${closingFeesUsd.toFixed(6)} 与盘口成本 $${spreadCostUsd.toFixed(6)} 后节省 $${expectedSavingsUsd.toFixed(6)}，须超过 $${minimumSavingsUsd.toFixed(6)}；${paymentWindowOpen?'下一实际付款已进入 5 分钟窗口':'下一实际付款尚未进入 5 分钟窗口或此前先有收款'}；${passes?'经济条件达标，仍须独立资金费持续确认与原生提交守卫':'受控尾差资金费退出条件未达标'}；原已成交量及历史亏损不重复计入节省，未来费率仍可能变化`};
}
