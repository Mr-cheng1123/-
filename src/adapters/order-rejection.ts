import type {OrderRequest,OrderResult} from '../shared/types.js';

/** Only for an order proven not accepted: pre-send validation, or an explicit documented create rejection. */
export class OrderNotSubmittedError extends Error {
  constructor(message:string,readonly rejectionCode:string,readonly rejectionReason:string){super(message);this.name='OrderNotSubmittedError';}
}

export function rejectedOrder(request:OrderRequest,error:OrderNotSubmittedError):OrderResult{
  return {id:'',clientOrderId:request.clientOrderId,status:'cancelled',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:Date.now(),
    rejectionCode:error.rejectionCode,rejectionReason:error.rejectionReason};
}
