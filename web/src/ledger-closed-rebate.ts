import type {Position} from '../../src/shared/types';
import type {PerformanceRow} from '../../src/shared/performance-types';

export interface LedgerClosedRebate {
  cashNetPnlUsd:number;grossFeesUsd:number;estimatedFeeRebateUsd:number;estimatedNetPnlAfterRebateUsd:number;
}
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const same=(left:number,right:number)=>Math.abs(left-right)<=Math.max(1e-10,Math.max(Math.abs(left),Math.abs(right))*1e-10);

/** Only the server's complete terminal lifecycle proof may project closed profits.
 * A derived per-position rebate alone does not establish missing order cash.
 * No query, calculation fallback, current market price or receipt is created here. */
export function ledgerClosedRebate(position:Position,rows:readonly PerformanceRow[]|undefined,
  unknownOrders:readonly {positionId:string}[]|undefined):LedgerClosedRebate|undefined {
  if(position.mode!=='live'||position.status!=='closed'||position.manualCloseAccountRecord||
    !Array.isArray(rows)||!Array.isArray(unknownOrders)||unknownOrders.some(order=>order.positionId===position.id))return;
  const selected=rows.filter(row=>row.id===position.id);
  if(selected.length!==1)return;
  const row=selected[0];
  if(!row.closed||!['normal','abnormal'].includes(row.category)||row.base!==position.base||row.openedAt!==position.openedAt||
    ![row.fundingUsd,row.feesUsd,row.spreadPnlUsd,row.transferCostUsd,row.netPnlUsd,row.estimatedFeeRebateUsd,row.estimatedNetPnlAfterRebateUsd].every(finite)||
    row.estimatedFeeRebateUsd!<0||!same(row.netPnlUsd!,row.fundingUsd!+row.spreadPnlUsd!-row.feesUsd!-row.transferCostUsd!)||
    !same(row.estimatedNetPnlAfterRebateUsd!,row.netPnlUsd!+row.estimatedFeeRebateUsd!))return;
  return {cashNetPnlUsd:row.netPnlUsd!,grossFeesUsd:row.feesUsd!,estimatedFeeRebateUsd:row.estimatedFeeRebateUsd!,
    estimatedNetPnlAfterRebateUsd:row.estimatedNetPnlAfterRebateUsd!};
}
