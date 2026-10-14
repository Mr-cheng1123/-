import {AUTO_ENTRY_MIN_OPPOSITE_EDGE_BPS,AUTO_ENTRY_PRICE_ROUTE_MIN_OPPOSITE_EDGE_BPS,AUTO_ENTRY_PRICE_ROUTE_MIN_IOC_EDGE_BPS} from '../../src/shared/automatic-entry-policy';
import type {Opportunity} from '../../src/shared/types';
export {AUTO_ENTRY_MIN_OPPOSITE_EDGE_BPS,AUTO_ENTRY_PRICE_ROUTE_MIN_OPPOSITE_EDGE_BPS,AUTO_ENTRY_PRICE_ROUTE_MIN_IOC_EDGE_BPS};

/** Display the shared automatic-only requirements without changing manual entry readiness. */
export const AUTOMATIC_ENTRY_CONDITIONS=`完整目标单轮预计净收益（资金费 − 四笔手续费）> 0 且本批对手价1价格优势 > ${AUTO_ENTRY_MIN_OPPOSITE_EDGE_BPS} bps；或预计净资金费 > 0、本批对手价1价格优势 > ${AUTO_ENTRY_PRICE_ROUTE_MIN_OPPOSITE_EDGE_BPS} bps 且实际 IOC 限价优势 > ${AUTO_ENTRY_PRICE_ROUTE_MIN_IOC_EDGE_BPS} bps`;
export const AUTOMATIC_FUNDING_STABILITY_RULE='自动入场核验当前 30 秒内的新鲜双腿资金费数据，预计净资金费 > 0 且与当前机会一致即可通过本项；不再等待连续确认。';
export const AUTOMATIC_ENTRY_RULE=`${AUTOMATIC_FUNDING_STABILITY_RULE}确认后仍须满足任一路径：${AUTOMATIC_ENTRY_CONDITIONS}。单轮参考收益不计盘口损耗与未实现价差；价格优势路径允许持有多轮，不要求单轮回本；手动开仓按原条件独立。`;
export const AUTOMATIC_ENTRY_MODE=`当前新鲜双腿资金费收益 > 0：单轮净收益 > 0 且对手价1 > ${AUTO_ENTRY_MIN_OPPOSITE_EDGE_BPS} bps；或净资金费 > 0、对手价1 > ${AUTO_ENTRY_PRICE_ROUTE_MIN_OPPOSITE_EDGE_BPS} bps 且 IOC > ${AUTO_ENTRY_PRICE_ROUTE_MIN_IOC_EDGE_BPS} bps`;

export interface AutomaticFundingStabilityPresentation {
  label:string;
  kind:'green'|'orange'|'neutral';
  reason:string;
  progress:string;
}

/** Automatic-only evidence; this caption never grants or removes manual submission readiness. */
export function automaticFundingStabilityPresentation(opportunity:Opportunity|undefined):AutomaticFundingStabilityPresentation {
  const stability=opportunity?.fundingEntryStability;
  if(!stability||stability.status==='observing')return {label:'自动资金费确认待更新',kind:'orange',
    reason:'等待重新核验当前双腿资金费；连续确认等待已取消。',progress:'等待新鲜双腿资金费数据'};
  if(stability.status==='confirmed'&&stability.passes)
    return {label:'自动资金费优势已确认',kind:'green',reason:stability.reason,progress:'当前双腿资金费收益 > 0'};
  if(stability.status==='nonpositive')return {label:'自动资金费暂无优势',kind:'neutral',reason:stability.reason,progress:'预计净资金费需 > 0'};
  return {label:'自动资金费确认待更新',kind:'orange',reason:stability.reason,progress:'等待新鲜双腿资金费数据'};
}
