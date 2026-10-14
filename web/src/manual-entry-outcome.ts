import type {ManualEntryExecutionSummary} from '../../src/shared/manual-entry';
import type {AppState} from '../../src/shared/types';
import type {ManualEntryRequest} from './manual-entry';

export interface ManualEntryOutcome {
  summary?:ManualEntryExecutionSummary;
  /** Old receipts may show the existing same-position journal, never invented execution quantities. */
  ledger?:{feesUsd?:number;realizedPricePnlUsd?:number;netPnlUsd?:number};
}
const known=(value:number|undefined)=>typeof value==='number'&&Number.isFinite(value)?value:undefined;
export function manualEntryOutcome(request:ManualEntryRequest,state?:AppState|null):ManualEntryOutcome {
  const operation=request.operation;
  if(operation?.result?.executionSummary)return {summary:operation.result.executionSummary};
  if(!operation?.ordersSubmitted||operation.result?.positionStatus!=='closed'||!operation.positionId)return {};
  const position=state?.positions.find(item=>item.id===operation.positionId&&item.base===request.base&&item.status==='closed');
  if(!position)return {};
  return {ledger:{feesUsd:known(position.feesUsd),realizedPricePnlUsd:known(position.realizedSpreadPnlUsd),netPnlUsd:known(position.netPnlUsd)}};
}
