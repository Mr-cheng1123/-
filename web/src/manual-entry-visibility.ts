import type {AppState} from '../../src/shared/types';
import {manualEntryBlocksBase,manualEntryTerminal,type ManualEntryRequest} from './manual-entry';

export const MANUAL_ENTRY_HISTORY_PAGE_SIZE=3;
export const MANUAL_ENTRY_EVENT_PAGE_SIZE=50;

/** Visibility does not remove receipts or relax the original operation/duplicate-order guard. */
export function manualEntryNeedsAttention(request:ManualEntryRequest,state?:AppState|null):boolean {
  return !manualEntryTerminal(request.operation)||manualEntryBlocksBase(request,state)||
    request.operation?.result?.executionSummary?.accountingStatus==='partial';
}

export function manualEntryGroups(entries:ManualEntryRequest[],state?:AppState|null) {
  const attention:ManualEntryRequest[]=[],history:ManualEntryRequest[]=[];
  for(let index=entries.length-1;index>=0;index--){
    const request=entries[index];
    (manualEntryNeedsAttention(request,state)?attention:history).push(request);
  }
  return {attention,history};
}
