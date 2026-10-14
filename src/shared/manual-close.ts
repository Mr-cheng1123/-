import type {ManualCloseLegTarget} from '../core/manual-close-selection.js';

export interface ManualCloseRequest {
  operationId:string;expiresAt:number;base:string;legs:ManualCloseLegTarget[];
  acknowledgement:'CLOSE_SELECTED_POSITION'|'CLOSE_SELECTED_ACCOUNT_POSITION';
}
export interface ManualCloseOperation {
  id:string;selection:string;createdAt:number;expiresAt:number;
  state:'checking'|'closing'|'completed'|'failed';positionId?:string;sourcePositionId?:string;error?:string;
}
