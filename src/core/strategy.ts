import type { AppConfig, BookLevel, EntryCheck, MarketSnapshot, Opportunity, SpreadAdvantage, SpreadHistoryProvider } from '../shared/types.js';
import { instrumentIdentityBlockReason } from '../shared/instrument-identity.js';
import {evaluateTradeEconomics} from './trade-economics.js';
import {quoteIsFresh,quoteObservedAt} from './market-validity.js';
import {takerFeeRate,nativeTakerFeeRate} from '../shared/trading-fees.js';
import {effectiveFeeRate} from '../shared/fee-rebates.js';
import {alignedEntryPricesFavorable,assessFundingCarry,bookIsUncrossedWhenObserved,estimateAlignedEntryFees,minimumEntryIocEdgeBps,sweep} from './funding-carry.js';
import {commonStep,floorQuantity} from './order-quantity.js';
import {planBestPriceEntryBatch} from './entry-batch.js';
import {buildFundingSchedule} from '../shared/funding-schedule.js';
export {sweep} from './funding-carry.js';
export {commonStep,floorQuantity} from './order-quantity.js';
export function fundingCount(s:Pick<MarketSnapshot,'nextFundingTime'|'intervalHours'>,end:number,now:number):number {
  if(!Number.isFinite(s.nextFundingTime)||s.nextFundingTime<=now||s.intervalHours<=0||end<s.nextFundingTime)return 0;
  return Math.floor((end-s.nextFundingTime)/(s.intervalHours*3600000))+1;
}
/** Gap between the moments two quotes were fetched; 0 when either side does not report it (demo data, old ledgers). */
export function quoteSkewMs(a:Pick<MarketSnapshot,'observedAt'>,b:Pick<MarketSnapshot,'observedAt'>):number {
  return Number.isFinite(a.observedAt)&&Number.isFinite(b.observedAt)?Math.abs(a.observedAt!-b.observedAt!):0;
}
const usd=(v:number|null|undefined)=>v===null||v===undefined||!Number.isFinite(v)?'—':`${v<0?'−':''}$${Math.abs(v).toFixed(2)}`;
const bps=(v:number|null|undefined)=>v===null||v===undefined||!Number.isFinite(v)?'—':`${v>0?'+':v<0?'−':''}${Math.abs(v).toFixed(2)} bps`;
const duration=(ms:number)=>{
  if(!Number.isFinite(ms))return '—';
  const s=Math.round(ms/1000);
  return s>=3600?`${Math.floor(s/3600)} 小时 ${Math.floor(s%3600/60)} 分`:s>=120?`${Math.floor(s/60)} 分 ${s%60} 秒`:`${s} 秒`;
};

/**
 * A pair qualifies when (1) the numbers are real — same instrument, fresh and simultaneously fetched quotes, a valid settlement,
 * enough opening depth, a size the exchange accepts — and (2) its selected economic model qualifies.
 * Aligned requires positive next cash funding and a legal first batch at the best opposite prices with a favorable IOC edge.
 * The full original quantity stays the target; each following batch needs fresh eligibility and depth.
 * Funding additionally requires one cycle to cover unchanged-basis round-trip costs; dual uses a historical spread advantage.
 * Aligned single-cycle income is funding minus four fees, with price advantage checked independently.
 * Future closing fees use current mark notionals; closing-depth costs remain a separate diagnostic.
 */
export function calculateOpportunities(snapshots:MarketSnapshot[],c:AppConfig,now=Date.now(),history?:SpreadHistoryProvider,requireNativeFees=c.mode==='live'):Opportunity[] {
  const output:Opportunity[]=[];
  const fundingPolicy=c.entryPolicy==='funding',alignedPolicy=c.entryPolicy==='aligned';
  const currentBookPolicy=fundingPolicy||alignedPolicy;
  for(let i=0;i<snapshots.length;i++)for(let j=i+1;j<snapshots.length;j++){
    const a=snapshots[i],b=snapshots[j];
    if(a.base!==b.base||a.exchange===b.exchange||![a.markPrice,b.markPrice,a.indexPrice,b.indexPrice,a.quantityStep,b.quantityStep,a.intervalHours,b.intervalHours].every(v=>Number.isFinite(v)&&v>0))continue;
    const ref=(a.indexPrice+b.indexPrice)/2;
    const quantity=floorQuantity(c.orderNotionalUsd/ref,commonStep(a.quantityStep,b.quantityStep));
    const horizon=now+c.maxHoldHours*3600000;
    // Adaptive enters for the first settlement only; continuing later must earn a fresh decision.
    const exitTime=c.holdMode==='continuous'&&!alignedPolicy?horizon:Math.max(a.nextFundingTime,b.nextFundingTime)+c.exitDelaySec*1000;
    // A post-settlement execution delay is not another funding cycle. Aligned
    // cash forecasts end when both next settlements have been covered.
    const fundingEndTime=alignedPolicy?Math.max(a.nextFundingTime,b.nextFundingTime):exitTime;
    const orientations=[{long:a,short:b},{long:b,short:a}].map(pair=>({...pair,
      cash:quantity*pair.short.markPrice*pair.short.fundingRate*fundingCount(pair.short,fundingEndTime,now)-quantity*pair.long.markPrice*pair.long.fundingRate*fundingCount(pair.long,fundingEndTime,now)}));
    orientations.sort((x,y)=>y.cash-x.cash||(y.short.fundingRate/y.short.intervalHours-y.long.fundingRate/y.long.intervalHours)-(x.short.fundingRate/x.short.intervalHours-x.long.fundingRate/x.long.intervalHours)||x.long.exchange.localeCompare(y.long.exchange));
    const {long,short}=orientations[0];
    const lq=quantity,sq=quantity,lv=lq*long.markPrice,sv=sq*short.markPrice,n=(lv+sv)/2;
    if(n<=0)continue;
    const funding=sv*short.fundingRate*fundingCount(short,fundingEndTime,now)-lv*long.fundingRate*fundingCount(long,fundingEndTime,now);
    // Keep the paired-horizon funding forecast intact, but expose the actual sequence
    // of receipts and payments. Entry timing acts only on a new aligned hedge.
    const fundingSchedule=buildFundingSchedule({...long,notionalUsd:lv},{...short,notionalUsd:sv},
      {now,exitDelaySec:c.exitDelaySec,entryTiming:c.asyncFundingEntryTiming??'last-payment'});
    const book=(levels:BookLevel[])=>levels.filter(level=>Number.isFinite(level.price)&&level.price>0&&Number.isFinite(level.quantity)&&level.quantity>0);
    const carry=currentBookPolicy?assessFundingCarry(long,short,lq,c,now,requireNativeFees):undefined;
    const buy=carry?.openLong??sweep(book(long.asks).sort((x,y)=>x.price-y.price),lq);
    const sell=carry?.openShort??sweep(book(short.bids).sort((x,y)=>y.price-x.price),sq);
    const openingComplete=buy.filled>=lq*(1-1e-9)&&sell.filled>=sq*(1-1e-9)&&
      [buy.average,buy.value,buy.worstPrice,sell.average,sell.value,sell.worstPrice].every(value=>Number.isFinite(value)&&value>0);
    const entryBatch=alignedPolicy?planBestPriceEntryBatch(long,short,quantity,
      {bufferBps:c.entryIocBufferBps??8,minEdgeBps:minimumEntryIocEdgeBps(c)}):undefined;
    // The first best-price batch consumes a different amount of closing depth than the full target.
    // Re-sweep its own four sides; a scaled full-target cost is not its execution economics.
    const batchCarry=entryBatch?entryBatch.quantity===quantity&&carry?carry:
      assessFundingCarry(long,short,entryBatch.quantity,c,now,requireNativeFees):undefined;
    const batchFunding=entryBatch?entryBatch.quantity*(short.markPrice*short.fundingRate*fundingCount(short,fundingEndTime,now)-
      long.markPrice*long.fundingRate*fundingCount(long,fundingEndTime,now)):undefined;
    const batchFees=entryBatch?estimateAlignedEntryFees(long,short,entryBatch.quantity,c,
      {longOpenPrice:entryBatch.longLimitPrice,shortOpenPrice:entryBatch.shortLimitPrice,now,requireNativeFees}):NaN;
    const batchNet=Number.isFinite(batchFunding)&&Number.isFinite(batchFees)?batchFunding!-batchFees:null;
    const longFee=effectiveFeeRate(long.exchange,takerFeeRate(long,c,now,requireNativeFees),c)??NaN,
      shortFee=effectiveFeeRate(short.exchange,takerFeeRate(short,c,now,requireNativeFees),c)??NaN;
    const feesKnown=[longFee,shortFee].every(value=>Number.isFinite(value)&&value>=0);
    const nativeFees=[long,short].every(snapshot=>nativeTakerFeeRate(snapshot,now)!==undefined);
    const feesSource=c.mode==='live'?(nativeFees?'exchange':!requireNativeFees&&feesKnown?'reference':'pending'):'simulation';
    const entryPriceEdgeBps=alignedPolicy?(entryBatch?(entryBatch.shortBestPrice!-entryBatch.longBestPrice!)/ref*10000:null):
      openingComplete?(sell.average-buy.average)/ref*10000:null;
    const entryLimitPriceEdgeBps=alignedPolicy?(entryBatch?(entryBatch.shortLimitPrice-entryBatch.longLimitPrice)/ref*10000:null):
      openingComplete?(sell.worstPrice-buy.worstPrice)/ref*10000:null;
    // Aligned funding income does not depend on a future closing book. Funding and dual retain their existing fee conventions.
    const fees=alignedPolicy?estimateAlignedEntryFees(long,short,quantity,c,
      {longOpenPrice:openingComplete?buy.average:long.markPrice,shortOpenPrice:openingComplete?sell.average:short.markPrice,now,requireNativeFees}):
      carry?.feesUsd??(buy.value*longFee+sell.value*shortFee+lv*longFee+sv*shortFee);
    const spread:SpreadAdvantage=carry?.spread??history?.assess(long,short,lq,c,now)??{
      status:'warming',samples:0,requiredSamples:c.spreadMinSamples,observedSpanSec:0,requiredSpanSec:c.spreadMinSpanSec,
      longEntryPrice:buy.average,shortEntryPrice:sell.average,entrySpreadBps:(sell.average-buy.average)/ref*10000,
      expectedExitSpreadBps:null,spreadAdvantageBps:null,expectedSpreadPnlUsd:null,reason:'价差观察尚未开始，等待双腿盘口历史'};
    const ready=spread.status==='ready';
    const fundingAfterFeesUsd=funding-fees;
    const spreadAfterFeesUsd=ready?spread.expectedSpreadPnlUsd!-fees:null;
    const limitFees=alignedPolicy?entryBatch?estimateAlignedEntryFees(long,short,quantity,c,
      {longOpenPrice:entryBatch.longLimitPrice,shortOpenPrice:entryBatch.shortLimitPrice,now,requireNativeFees}):NaN:
      carry?.limitFeesUsd??(lq*buy.worstPrice*longFee+sq*sell.worstPrice*shortFee+lv*longFee+sv*shortFee);
    // Full-target carry remains a conditional forecast. A smaller best-price batch cannot guarantee full-target IOC bounds.
    const fullEntryLimitKnown=!alignedPolicy||!!entryBatch&&entryBatch.quantity>=quantity*(1-1e-9);
    const entryLimitSpreadAfterFeesUsd=alignedPolicy?fullEntryLimitKnown&&Number.isFinite(limitFees)?-limitFees:null:
      ready&&fullEntryLimitKnown?currentBookPolicy?
      -carry!.limitBookLossUsd-limitFees:
      sq*sell.worstPrice-lq*buy.worstPrice-lq*ref*spread.expectedExitSpreadBps!/10000-limitFees:null;
    // Preserve the full-target VWAP forecast; only the executable first batch determines aligned eligibility.
    const entryLimitNetUsd=currentBookPolicy&&(alignedPolicy||ready)&&Number.isFinite(funding)&&Number.isFinite(entryLimitSpreadAfterFeesUsd)?
      funding+entryLimitSpreadAfterFeesUsd!:null;
    const economics=evaluateTradeEconomics({fundingUsd:funding,spreadUsd:alignedPolicy?0:spread.expectedSpreadPnlUsd??0,feesUsd:fees,minCombinedNetUsd:c.minCombinedNetUsd,requireSpreadPositive:!currentBookPolicy});
    const net=economics.netUsd;
    const combinedExpectedNetUsd=(alignedPolicy||ready)&&economics.valid?net:null;
    // Aligned fee-recovery rounds use funding and four fees only; no cross-venue basis is booked as income.
    const breakEvenRounds=alignedPolicy&&economics.valid&&funding>0?
      Math.max(0,Math.ceil(fees/funding)):null;
    const basis=(short.markPrice-long.markPrice)/ref*10000,delta=(lq-sq)*ref;
    const skew=Math.abs(long.nextFundingTime-short.nextFundingTime)/1000;
    const hourly=sv/n*short.fundingRate/short.intervalHours-lv/n*long.fundingRate/long.intervalHours;
    const reasons:string[]=[],checks:EntryCheck[]=[];
    // The checklist and the decision are the same list, so the screen can never disagree with the engine.
    // `ok===null` = cannot judge yet (history still warming): shown as waiting, never as a failed condition.
    const check=(group:EntryCheck['group'],label:string,ok:boolean|null,reason:string,actual?:string,required?:string)=>{
      checks.push({group,label,pass:ok,reason,...(actual!==undefined?{actual}:{}),...(required!==undefined?{required}:{})});
      if(ok===false)reasons.push(reason);
    };
    const identityReason=instrumentIdentityBlockReason(a.base,a.exchange,b.exchange);
    if(identityReason)check('market','两腿是同一种合约标的',false,identityReason);

    // 1. The numbers are real.
    const quoteSkew=quoteSkewMs(long,short);
    check('market','两腿报价新鲜且同时取得',
      quoteIsFresh(long,c,now)&&quoteIsFresh(short,c,now)&&quoteSkew<=c.maxQuoteSkewMs,
      quoteSkew>c.maxQuoteSkewMs?'两腿行情采集时间相差过大，价差可能不是同一时刻':'行情过期或时钟偏移',
      `最旧 ${duration(Math.max(now-quoteObservedAt(long),now-quoteObservedAt(short)))}前 · 两腿相差 ${Math.round(quoteSkew)} 毫秒`,`≤ ${Math.round(c.maxSnapshotAgeMs/1000)} 秒 · ≤ ${c.maxQuoteSkewMs} 毫秒`);
    check('timing','下一次结算时间有效',![funding,exitTime,long.nextFundingTime,short.nextFundingTime].every(Number.isFinite)||long.nextFundingTime<=now+3000||short.nextFundingTime<=now+3000?false:true,
      '结算时间无效或距离结算过近',`距结算 ${duration(Math.min(long.nextFundingTime,short.nextFundingTime)-now)}`,'> 3 秒');
    if(alignedPolicy)check('timing','异步资金费入场时点合适',fundingSchedule.entryReady,fundingSchedule.reason,
      `首轮净资金费 ${usd(fundingSchedule.nextEventUsd)} · 首次收入前支出 ${usd(fundingSchedule.preReceiptPaymentsUsd)}`,
      c.asyncFundingEntryTiming==='anytime'?'任意时点允许新建仓':'小周期收款仅首轮入场，付款仅末轮入场；结算前后留 10 秒');
    check('market',alignedPolicy?'双腿开仓盘口够成交整笔数量':fundingPolicy?'四边开平仓盘口够成交整笔数量':'盘口深度够成交整笔数量',
      alignedPolicy?!!entryBatch:fundingPolicy?carry!.complete:!(buy.filled<lq*(1-1e-9)||sell.filled<sq*(1-1e-9)),
      alignedPolicy?'最佳对手价深度不足以成交一批合法数量':'盘口深度不足',
      alignedPolicy?`最佳对手价首批 ${entryBatch?.quantity??0} / 完整目标 ${quantity}`:undefined,
      alignedPolicy?'两腿最佳对手价支持同一批合法数量；后续批次重新核验':undefined);
    const validMinimums=[long.minQuantity,short.minQuantity,long.minNotional,short.minNotional].every(value=>Number.isFinite(value)&&value>=0);
    check('market','数量达到交易所最小下单量',alignedPolicy?!!entryBatch:validMinimums&&!(lq<long.minQuantity||sq<short.minQuantity||
      (currentBookPolicy?buy.value:lv)<long.minNotional||(currentBookPolicy?sell.value:sv)<short.minNotional),
      alignedPolicy?'最佳对手价首批低于交易所最小下单量或金额':'低于交易所最小下单量');

    // 2. There is an edge.
    check('funding','预计资金费为正',economics.fundingPositive,'预计资金费不为正：持有到结算并不赚资金费',usd(funding),'> $0.00');
    if(alignedPolicy){
      check('market','两腿数据来源一致',long.source===short.source,'两腿行情数据来源不一致');
      check('market','已观察买卖盘口价格一致',bookIsUncrossedWhenObserved(long)&&bookIsUncrossedWhenObserved(short),
        '交易所买卖盘口价格倒挂，等待一致的新报价');
      check('market','两腿手续费已知',feesKnown,c.mode==='live'?'等待交易所当前账户合约手续费':'模拟手续费参数缺失或无效',feesKnown?nativeFees?'按交易所当前合约费率估计，不要求一轮覆盖全费':'模拟模式：按配置费率计算':'手续费同步中',c.mode==='live'?'两腿当前账户合约 taker 费率':'已知有效 taker 费率');
      check('spread','开多均价低于开空均价',entryPriceEdgeBps!==null&&entryPriceEdgeBps>0,
        '开仓价格没有优势：开多均价不低于开空均价',bps(entryPriceEdgeBps),'> 0 bps');
      const minimumIocEdge=minimumEntryIocEdgeBps(c);
      check('execution','实际 IOC 开仓价格优势达标',entryBatch!==undefined&&alignedEntryPricesFavorable(entryBatch.longLimitPrice,entryBatch.shortLimitPrice,long,short,c),
        `实际 IOC 开仓价格优势须大于 ${minimumIocEdge} bps`,bps(entryLimitPriceEdgeBps),`> ${minimumIocEdge} bps`);
    }else if(fundingPolicy){
      check('spread','当前开平仓盘口可估算往返成本',ready,spread.reason??'完整新鲜开平仓盘口不足',ready?usd(carry!.bookCost?.roundTripBookLossUsd):'—','基差不变，不要求价差单独盈利');
      check('market','两腿手续费已知',carry!.feesValid,c.mode==='live'?'等待交易所当前账户合约手续费':'模拟手续费参数缺失或无效',carry!.feesValid?usd(fees):'手续费同步中','四笔手续费各计算一次');
    }else{
      check('market','两腿手续费已知',feesKnown,c.mode==='live'?'等待交易所当前账户合约手续费':'模拟手续费参数缺失或无效',feesKnown?usd(fees):'手续费同步中','四笔手续费各计算一次');
      check('spread','价差历史样本充足',ready?true:null,spread.reason??'价差历史样本不足',
        `${spread.samples} / ${c.spreadMinSamples} 个 · ${Math.floor(spread.observedSpanSec)} / ${c.spreadMinSpanSec} 秒`,'样本数与覆盖时长都达标');
      check('spread','开仓价差优于历史退出价差',ready?economics.spreadPositive:null,'价差没有优势：开仓价差不优于历史退出价差',ready?bps(spread.spreadAdvantageBps):'—','> 0 bps');
    }
    if(!alignedPolicy)check('funding','资金费 + 价差扣四笔手续费后净收益达标',combinedExpectedNetUsd===null?null:economics.netPass,'资金费与价差合计净收益不足',usd(combinedExpectedNetUsd),`> ${usd(c.minCombinedNetUsd)}`);
    if(fundingPolicy)check('execution','实际 IOC 限价净收益达标',entryLimitNetUsd===null?null:entryLimitNetUsd>c.minCombinedNetUsd,
      '实际 IOC 限价对应的扣费净收益不足',usd(entryLimitNetUsd),`> ${usd(c.minCombinedNetUsd)}`);

    const confidence=long.fundingHistory.length>=3&&short.fundingHistory.length>=3?.85:.55;
    output.push({id:`${a.base}-${long.exchange}-${short.exchange}`,base:a.base,longExchange:long.exchange,shortExchange:short.exchange,feesSource,entryPolicy:alignedPolicy?'aligned':fundingPolicy?'funding':'dual',
      longRate:long.fundingRate,shortRate:short.fundingRate,longIntervalHours:long.intervalHours,shortIntervalHours:short.intervalHours,
      longObservedAt:quoteObservedAt(long),shortObservedAt:quoteObservedAt(short),
      longQuantity:lq,shortQuantity:sq,notionalUsd:n,grossExposureUsd:lv+sv,netRateBps:funding/n*10000,normalized8hBps:hourly*8*10000,
      aprPct:hourly*24*365*100,capitalAprPct:hourly*24*365*100*c.leverage/2,
      expectedFundingUsd:funding,fundingSchedule,feesUsd:fees,slippageUsd:0,transferCostUsd:0,basisStressUsd:0,expectedNetUsd:net,
      fundingAfterFeesUsd,spreadAfterFeesUsd,entryLimitSpreadAfterFeesUsd,...(currentBookPolicy?{entryLimitNetUsd}:{}),
      ...(alignedPolicy?{entryPriceEdgeBps,entryLimitPriceEdgeBps,breakEvenRounds,
        ...(entryBatch?{entryBatch:{pricing:'best-opposite' as const,targetQuantity:quantity,batchQuantity:entryBatch.quantity,
          longLimitPrice:entryBatch.longLimitPrice,shortLimitPrice:entryBatch.shortLimitPrice,
          longBestPrice:entryBatch.longBestPrice,shortBestPrice:entryBatch.shortBestPrice,
          longPriceBufferBps:entryBatch.longPriceBufferBps,shortPriceBufferBps:entryBatch.shortPriceBufferBps,
          ...(batchCarry?.bookCost?{bookCost:batchCarry.bookCost}:{}),
          ...(Number.isFinite(batchFunding)?{expectedFundingUsd:batchFunding}:{}),expectedNetUsd:batchNet}}:{})}:{}),
      ...(carry?.bookCost?{bookCost:carry.bookCost}:{}),combinedExpectedNetUsd,spreadAdvantage:spread,
      basisBps:basis,deltaUsd:delta,nextFundingTime:Math.min(long.nextFundingTime,short.nextFundingTime),exitTime,settlementSkewSec:skew,
      liquidityUsd:Math.min(long.bids.reduce((n,x)=>n+x.price*x.quantity,0),long.asks.reduce((n,x)=>n+x.price*x.quantity,0),short.bids.reduce((n,x)=>n+x.price*x.quantity,0),short.asks.reduce((n,x)=>n+x.price*x.quantity,0)),
      eligible:(alignedPolicy?!!entryBatch:ready)&&reasons.length===0,reasons,checks,risk:reasons.length?'high':'low',confidence});
  }
  return output.sort((a,b)=>Number(b.eligible)-Number(a.eligible)||b.expectedNetUsd-a.expectedNetUsd);
}
