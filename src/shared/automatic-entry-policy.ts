import type {Opportunity} from './types.js';

/** Automatic entry is deliberately narrower than the independent manual entry conditions. */
export const AUTO_ENTRY_MIN_OPPOSITE_EDGE_BPS=20;
export const AUTO_ENTRY_PRICE_ROUTE_MIN_OPPOSITE_EDGE_BPS=100;
export const AUTO_ENTRY_PRICE_ROUTE_MIN_IOC_EDGE_BPS=80;
export type AutomaticEntryRoute='single-cycle'|'price-100';
export interface AutomaticEntryAssessment {
  passes:boolean;
  route:AutomaticEntryRoute|null;
  /** Same full-target funding minus four fees used by the aligned positive-net opportunity tab;
   * price advantage is checked independently and is not booked as income. */
  netPnlUsd:number|null;
  /** Raw best opposite prices for this legal first batch, before the IOC price buffer. */
  oppositePriceEdgeBps:number|null;
  /** Current first-batch limit edge, including price precision and the IOC buffer. */
  iocLimitPriceEdgeBps:number|null;
  fundingUsd:number|null;
  reason?:string;
}

export function automaticEntryAssessment(opportunity:Opportunity|undefined):AutomaticEntryAssessment {
  const net=opportunity?.combinedExpectedNetUsd;
  const edge=opportunity?.entryPriceEdgeBps;
  const batch=opportunity?.entryBatch;
  const funding=opportunity?.expectedFundingUsd;
  const iocEdge=opportunity?.entryLimitPriceEdgeBps;
  const netPnlUsd=typeof net==='number'&&Number.isFinite(net)?net:null;
  const legalBatch=!!batch&&Number.isFinite(batch.batchQuantity)&&batch.batchQuantity>0;
  const oppositePriceEdgeBps=legalBatch&&
    typeof edge==='number'&&Number.isFinite(edge)?edge:null;
  const iocLimitPriceEdgeBps=legalBatch&&typeof iocEdge==='number'&&Number.isFinite(iocEdge)?iocEdge:null;
  const fundingUsd=typeof funding==='number'&&Number.isFinite(funding)?funding:null;
  const assessment={netPnlUsd,oppositePriceEdgeBps,iocLimitPriceEdgeBps,fundingUsd};
  // Exact thresholds must not pass from binary rounding such as 20.0000000000003.
  if(netPnlUsd!==null&&netPnlUsd>0&&oppositePriceEdgeBps!==null&&oppositePriceEdgeBps>AUTO_ENTRY_MIN_OPPOSITE_EDGE_BPS+1e-9)
    return {passes:true,route:'single-cycle',...assessment};
  if(fundingUsd!==null&&fundingUsd>0&&oppositePriceEdgeBps!==null&&oppositePriceEdgeBps>AUTO_ENTRY_PRICE_ROUTE_MIN_OPPOSITE_EDGE_BPS+1e-9&&
    iocLimitPriceEdgeBps!==null&&iocLimitPriceEdgeBps>AUTO_ENTRY_PRICE_ROUTE_MIN_IOC_EDGE_BPS+1e-9)
    return {passes:true,route:'price-100',...assessment};
  let reason:string;
  if(oppositePriceEdgeBps===null)reason='自动开仓等待本批对手价1报价和合法数量';
  else if(oppositePriceEdgeBps>AUTO_ENTRY_PRICE_ROUTE_MIN_OPPOSITE_EDGE_BPS+1e-9){
    if(fundingUsd===null)reason='价格优势路径等待预计净资金费核验';
    else if(fundingUsd<=0)reason='价格优势路径要求预计净资金费大于 0';
    else reason=iocLimitPriceEdgeBps===null?'价格优势路径等待本批实际 IOC 限价核验':'价格优势路径要求本批实际 IOC 限价优势严格大于 80 bps';
  }else reason='自动开仓需满足：完整目标单轮净收益 > 0 且本批对手价1优势 > 20 bps；或预计净资金费 > 0、本批对手价1优势 > 100 bps 且实际 IOC 限价优势 > 80 bps';
  return {passes:false,route:null,...assessment,reason};
}

export function automaticEntryCandidateReady(opportunity:Opportunity|undefined):boolean {
  return opportunity?.eligible===true&&opportunity.entryReady!==false&&automaticEntryAssessment(opportunity).passes&&
    opportunity.fundingEntryStability?.status==='confirmed'&&opportunity.fundingEntryStability.passes===true;
}
