import type {Opportunity} from '../../src/shared/types';

const positive=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>0;
const amountFormat=new Intl.NumberFormat('en-US',{maximumFractionDigits:8});
const amount=(value:number)=>amountFormat.format(value);
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const buffer=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;

/** A first-batch plan is not evidence that the full target already traded. */
export function entryBatchPresentation(opportunity:Opportunity|undefined,budgetUsd:number){
  const plan=opportunity?.entryBatch;
  if(!plan||plan.pricing!=='best-opposite'||![plan.targetQuantity,plan.batchQuantity,plan.longLimitPrice,plan.shortLimitPrice].every(positive)||
    plan.batchQuantity>plan.targetQuantity+Math.max(1e-9,plan.targetQuantity*1e-9))return;
  const bestPrices=[positive(plan.longBestPrice)?`多腿卖一 ${amount(plan.longBestPrice)}`:undefined,
    positive(plan.shortBestPrice)?`空腿买一 ${amount(plan.shortBestPrice)}`:undefined].filter(Boolean).join(' · ');
  const priceBuffers=[buffer(plan.longPriceBufferBps)?`多腿 ${amount(plan.longPriceBufferBps)} bps`:undefined,
    buffer(plan.shortPriceBufferBps)?`空腿 ${amount(plan.shortPriceBufferBps)} bps`:undefined].filter(Boolean).join(' · ');
  return {plan,label:`对手价分批 IOC · 本批 ${amount(plan.batchQuantity)} 币 · 目标 ${amount(plan.targetQuantity)} 币${positive(budgetUsd)?` / 每腿 ${amount(budgetUsd)} U`:''}`,
    prices:`多腿 IOC 买入限价 ${amount(plan.longLimitPrice)} · 空腿 IOC 卖出限价 ${amount(plan.shortLimitPrice)}`,
    bestPrices:bestPrices?`首批对手价：${bestPrices}`:undefined,
    priceBuffers:priceBuffers?`限价相对对手价缓冲：${priceBuffers}`:undefined,
    bestPriceEdge:finite(opportunity?.entryPriceEdgeBps)?`本批对手价1价格优势 ${amount(opportunity.entryPriceEdgeBps)} bps`:undefined,
    limitPriceEdge:finite(opportunity?.entryLimitPriceEdgeBps)?`本批 IOC 实际限价价格优势 ${amount(opportunity.entryLimitPriceEdgeBps)} bps`:undefined,
    forecastNote:'列表收益与费用按完整目标条件预估；首批分项按本批数量独立估算。每批重新核验价格和资金费，未成交的目标数量不计为持仓。'};
}
