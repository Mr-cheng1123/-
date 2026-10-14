import type {AppConfig,Position} from '../../src/shared/types';
import {estimateFeeRebateUsd} from '../../src/shared/fee-rebates';
import type {LedgerPositionMetrics} from './ledger-position-metrics';
import type {LedgerCloseValue} from './ledger-close-value';

export interface LedgerCloseRebateEstimate {
  paidFeeRebateUsd:number;closingFeeRebateUsd:number;estimatedFeeRebateUsd:number;
  estimatedNetPnlAfterRebateUsd:number;
}

/** Separate display projection for this observed account cycle. Retained books
 * keep their original price/rate inputs; rebates use the current declared policy.
 * Positive net charged fees per observed leg are the conservative paid-fee base.
 * Nothing here reads a rebate or writes a receipt, cash amount or close decision. */
export function ledgerCloseRebate(position:Position,metrics:LedgerPositionMetrics,value:LedgerCloseValue,
  config:Pick<AppConfig,'feeRebatePct'>):LedgerCloseRebateEstimate|undefined {
  if(metrics.source!=='account'||value.status==='pending'||!Number.isFinite(value.netPnlUsd)||!value.closeBatch||
    !Number.isFinite(value.closingFeesUsd))return;
  let paidFeeRebateUsd=0,closingFeeRebateUsd=0,grossClosingFeesUsd=0;
  for(const side of ['long','short'] as const){
    const exchange=position[side].exchange,fees=metrics[side].feesUsd;
    if(!Number.isFinite(fees))return;
    paidFeeRebateUsd+=estimateFeeRebateUsd(exchange,fees!,config);
    const batch=value.closeBatch,quantity=side==='long'?batch.longTotalQuantity:batch.shortTotalQuantity;
    if(quantity===0)continue;
    const price=side==='long'?batch.longLimitPrice:batch.shortLimitPrice;
    const rate=side==='long'?batch.longTakerFeeRate:batch.shortTakerFeeRate;
    if(!Number.isFinite(quantity)||quantity<0||!Number.isFinite(price)||price!<=0||!Number.isFinite(rate)||rate!<0)return;
    const fee=quantity*price!*rate!;
    grossClosingFeesUsd+=fee;closingFeeRebateUsd+=estimateFeeRebateUsd(exchange,fee,config);
  }
  if(Math.abs(grossClosingFeesUsd-value.closingFeesUsd!)>Math.max(1e-10,Math.abs(value.closingFeesUsd!)*1e-10))return;
  const estimatedFeeRebateUsd=paidFeeRebateUsd+closingFeeRebateUsd;
  const estimatedNetPnlAfterRebateUsd=value.netPnlUsd!+estimatedFeeRebateUsd;
  if(![paidFeeRebateUsd,closingFeeRebateUsd,estimatedFeeRebateUsd,estimatedNetPnlAfterRebateUsd].every(Number.isFinite))return;
  return {paidFeeRebateUsd,closingFeeRebateUsd,estimatedFeeRebateUsd,estimatedNetPnlAfterRebateUsd};
}
