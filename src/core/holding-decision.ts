import type { AppConfig, HoldingDecision, MarketSnapshot, Position } from '../shared/types.js';
import { fundingCount, quoteSkewMs, sweep } from './strategy.js';
import {assessAlignedExit,assessBestOppositeProfitExit,alignedExitProfitsPass,bothExitProfitsPass,type ProfitExitAssessment} from './profit-exit.js';
import {quoteIsFresh,quoteObservedAt} from './market-validity.js';
import {bookIsUncrossedWhenObserved} from './funding-carry.js';
import {takerFeeRate} from '../shared/trading-fees.js';
import {effectiveFeeRate} from '../shared/fee-rebates.js';
import {exitProfitThresholdUsd} from './exit-profit-threshold.js';
import {currentExitStrategyPosition} from '../shared/current-exit-strategy.js';

/** Kept for old callers; stale settlement clocks never produce a forced close. */
export interface HoldingEvaluation extends HoldingDecision { forceClose?:true }

/** Preserve the existing displayed/persisted money shape; execution metadata is checked on each actual batch. */
function exitProfitAmounts(profit:ProfitExitAssessment):ProfitExitAssessment {
  return {spreadPnlUsd:profit.spreadPnlUsd,totalFeesUsd:profit.totalFeesUsd,fundingAfterFeesUsd:profit.fundingAfterFeesUsd,
    spreadAfterFeesUsd:profit.spreadAfterFeesUsd,netPnlUsd:profit.netPnlUsd,
    closingFeesUsd:profit.closingFeesUsd,spreadAfterClosingFeesUsd:profit.spreadAfterClosingFeesUsd,
    ...(profit.estimatedFeeRebateUsd!==undefined?{estimatedFeeRebateUsd:profit.estimatedFeeRebateUsd,bookedFeeRebateUsd:profit.bookedFeeRebateUsd,
      grossTotalFeesUsd:profit.grossTotalFeesUsd,grossClosingFeesUsd:profit.grossClosingFeesUsd}:{})};
}

/** New joint positions may capture actual profit; continuation otherwise compares marginal future cash flow. */
export function evaluateHoldingDecision(position:Position,long:MarketSnapshot|undefined,short:MarketSnapshot|undefined,config:AppConfig,now=Date.now(),requireNativeFees=config.mode==='live'):HoldingEvaluation {
  position=currentExitStrategyPosition(position,config);
  const priorCandidate=position.holdDecision?.targetFundingTime??position.plannedExitAt-config.exitDelaySec*1000;
  const priorTarget=Number.isFinite(priorCandidate)?priorCandidate:now;
  const base={expectedFundingUsd:0,incrementalCostUsd:0,expectedNetUsd:0,nextReviewAt:now+config.pollIntervalMs,targetFundingTime:priorTarget};
  const decision=(action:HoldingDecision['action'],reason:string,extra:Partial<HoldingEvaluation>={}):HoldingEvaluation=>({...base,action,reason,...extra});
  if(!quoteIsFresh(long,config,now)||!quoteIsFresh(short,config,now))return decision('wait','等待两腿新鲜行情；未用旧报价推断续持收益');
  const l=long!,s=short!;
  if(position.entryPolicy==='aligned'&&(l.source!==s.source||quoteSkewMs(l,s)>config.maxQuoteSkewMs))
    return decision('wait','等待同一来源且同时取得的两腿报价');
  if(position.entryPolicy==='aligned'&&(!bookIsUncrossedWhenObserved(l)||!bookIsUncrossedWhenObserved(s)))
    return decision('wait','已观察买卖盘口价格倒挂，等待一致的新报价');
  if(l.exchange!==position.long.exchange||s.exchange!==position.short.exchange||l.base!==position.base||s.base!==position.base||l.symbol!==position.long.symbol||s.symbol!==position.short.symbol||
    ![position.long.quantity,position.short.quantity].every(v=>Number.isFinite(v)&&v>0))return decision('wait','行情标的或仓位数据无效，等待核验');
  const exitProfit=assessBestOppositeProfitExit(position,l,s,config,now,undefined,undefined,requireNativeFees);
  if(position.entryPolicy==='aligned'){
    if(alignedExitProfitsPass(position,exitProfit,config)){
      // Booked cash and executable prices can establish profit before the first settlement,
      // even when the next funding forecast is unavailable. Due funding still needs cash evidence.
      const forecast=assessAlignedExit(position,l,s,config,now,false,undefined,{pricing:'best-opposite',requireNativeFees});
      return decision('close',forecast?.reason??
        `按全仓对手价1条件估算，累计资金费与价格损益扣除全部开平手续费及成本后净收益 $${exitProfit!.netPnlUsd.toFixed(4)} 超过原开仓单腿本金的 ${config.minExitProfitBps??10} bps（$${exitProfitThresholdUsd(position,config).toFixed(4)}），开始盈利退出；先处理 ${exitProfit!.batch.quantity} 的共同批次，后续批次重新核验，不保证全仓同价成交`,
        {exitSignal:'profit',exitProfit:exitProfitAmounts(exitProfit!),...(forecast?{fundingSchedule:forecast.fundingSchedule,
          expectedFundingUsd:forecast.expectedFundingUsd,expectedNetUsd:forecast.expectedFundingUsd,targetFundingTime:forecast.targetFundingTime}: {})});
    }
  }else{
    if(bothExitProfitsPass(position,exitProfit))return decision('close',
      `资金费已到账，按全仓对手价1条件估算扣完全部手续费后净收益达标；先处理 ${exitProfit!.batch.quantity} 的共同批次，后续批次重新核验，不保证全仓同价成交`,
      {exitSignal:'profit',exitProfit:exitProfitAmounts(exitProfit!),targetFundingTime:position.profitExitPolicy!.firstFundingTime});
  }
  if(![l.markPrice,s.markPrice,l.intervalHours,s.intervalHours].every(v=>Number.isFinite(v)&&v>0)||
    ![l.fundingRate,s.fundingRate,l.nextFundingTime,s.nextFundingTime].every(Number.isFinite))return decision('wait','下一轮结算或价格数据无效，等待有效报价');
  // A missing clock update is missing evidence, not an economic reason to realize a loss.
  if(l.nextFundingTime<=now||s.nextFundingTime<=now)return decision('wait','等待结算时钟滚动；未更新的结算事件不计入未来收益');
  // A cached pre-settlement observation must not be reused as evidence for the next cycle.
  if(priorTarget>position.openedAt&&now>=priorTarget&&(quoteObservedAt(l)<priorTarget||quoteObservedAt(s)<priorTarget)){
    return decision('wait','等待结算后的双腿新报价；未用结算前报价判断下一轮收益');
  }
  const targetFundingTime=Math.max(l.nextFundingTime,s.nextFundingTime);
  const horizon=targetFundingTime+config.exitDelaySec*1000;
  const longValue=position.long.quantity*l.markPrice,shortValue=position.short.quantity*s.markPrice;
  const expectedFundingUsd=shortValue*s.fundingRate*fundingCount(s,horizon,now)-longValue*l.fundingRate*fundingCount(l,horizon,now);
  if(position.entryPolicy==='aligned'){
    const assessment=assessAlignedExit(position,l,s,config,now,false,undefined,{pricing:'best-opposite',requireNativeFees});
    if(!assessment)return decision('wait','续持资金费或可平盘口数据不完整，等待核验',{targetFundingTime});
    const {profit,fundingSchedule,fundingLossExit,exitSignal,expectedFundingUsd,targetFundingTime:target,passes,reason}=assessment;
    const action=passes?'close':expectedFundingUsd>0?'hold':'wait';
    // Closing now and later both pay the same closing fee; it is not charged as a new cost each funding cycle.
    return decision(action,reason,{fundingSchedule,expectedFundingUsd,incrementalCostUsd:0,expectedNetUsd:expectedFundingUsd,targetFundingTime:target,
      nextReviewAt:Math.min(now+config.pollIntervalMs,horizon),...(profit?{exitProfit:exitProfitAmounts(profit)}:{}),
      ...(fundingLossExit?{fundingLossExit}:{}),...(passes?{exitSignal}: {})});
  }
  const book=(levels:typeof l.bids,side:'bids'|'asks')=>(Array.isArray(levels)?levels:[]).filter(x=>x&&Number.isFinite(x.price)&&x.price>0&&Number.isFinite(x.quantity)&&x.quantity>0)
    .sort((a,b)=>side==='bids'?b.price-a.price:a.price-b.price);
  const bid=sweep(book(l.bids,'bids'),position.long.quantity),ask=sweep(book(s.asks,'asks'),position.short.quantity);
  if(bid.filled<position.long.quantity*(1-1e-9)||ask.filled<position.short.quantity*(1-1e-9))return decision('wait','平仓盘口深度不足，无法可靠比较现在退出和继续持有',{targetFundingTime});
  // The two fees of closing now. Opening fees are already sunk and are not charged again.
  const fees=[effectiveFeeRate(l.exchange,takerFeeRate(l,config,now,requireNativeFees),config)??NaN,
    effectiveFeeRate(s.exchange,takerFeeRate(s,config,now,requireNativeFees),config)??NaN];
  if(!fees.every(v=>Number.isFinite(v)&&v>=0))return decision('wait','平仓手续费数据无效，等待有效费率',{targetFundingTime});
  const incrementalCostUsd=bid.value*fees[0]+ask.value*fees[1];
  const expectedNetUsd=expectedFundingUsd-incrementalCostUsd;
  if(![expectedFundingUsd,incrementalCostUsd,expectedNetUsd].every(Number.isFinite))return decision('wait','续持费用估计无效，等待有效报价',{targetFundingTime});
  const hold=expectedNetUsd>0;
  const reason=hold?'下一轮资金费覆盖平仓手续费，继续持有':'下一轮资金费扣掉平仓手续费后不为正，结束持有';
  return decision(hold?'hold':'close',reason,
    {expectedFundingUsd,incrementalCostUsd,expectedNetUsd,targetFundingTime,nextReviewAt:Math.min(now+config.pollIntervalMs,horizon)});
}

export interface HoldingConfirmation {action:'hold'|'close';count:number;longAt:number;shortAt:number;targetFundingTime:number;exitSignal?:HoldingDecision['exitSignal']}
/** Both observations must advance. Calling the same snapshot repeatedly cannot satisfy confirmations. */
export function confirmHoldingDecision(evaluation:HoldingEvaluation,previous:HoldingConfirmation|undefined,longAt:number,shortAt:number,required:number):{decision:HoldingDecision;confirmation?:HoldingConfirmation}{
  const {forceClose,...raw}=evaluation;
  if(raw.action==='wait')return {decision:raw};
  if(![longAt,shortAt].every(v=>Number.isFinite(v)&&v>0))return {decision:{...raw,action:'wait',reason:'等待有效的双腿报价时间，尚未确认持仓决策'}};
  const needed=Number.isFinite(required)?Math.max(1,Math.ceil(required)):1;
  if(previous&&(![previous.count,previous.longAt,previous.shortAt,previous.targetFundingTime].every(Number.isFinite)||previous.count<0))previous=undefined;
  const same=previous?.action===raw.action&&previous.targetFundingTime===raw.targetFundingTime&&previous.exitSignal===raw.exitSignal;
  const advanced=!previous||(longAt>previous.longAt&&shortAt>previous.shortAt);
  const count=same?previous!.count+(advanced?1:0):advanced?1:0;
  const confirmation:HoldingConfirmation={action:raw.action,count:Math.min(count,needed),...(raw.exitSignal?{exitSignal:raw.exitSignal}:{}),longAt:advanced?longAt:previous!.longAt,
    shortAt:advanced?shortAt:previous!.shortAt,targetFundingTime:raw.targetFundingTime};
  return {decision:count>=needed?raw:{...raw,action:'wait',reason:`等待连续新鲜报价确认 ${count}/${needed}：${raw.reason}`},confirmation};
}
