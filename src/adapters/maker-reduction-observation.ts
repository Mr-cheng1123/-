import type {MakerReductionObservation,OrderRequest,OrderResult} from '../shared/types.js';
import {hasBoundedOrderQuantity,hasOrderReceiptIdentity,isTerminalOrderReceipt,orderAverageRespectsLimit} from '../shared/order-receipt-validity.js';
import {OrderNotSubmittedError} from './order-rejection.js';

export function assertMakerReductionRequest(request:OrderRequest):void {
  if(request.reduceOnly!==true||request.postOnly!==true||!request.clientOrderId||
    !['buy','sell'].includes(request.side)||![request.quantity,request.limitPrice].every(value=>Number.isFinite(value)&&value>0))
    throw new Error('Maker reduction requires an exact PostOnly reduce-only request');
}

/** The last synchronous boundary before native creation, after any asynchronous account checks. */
export function assertMakerReductionPermission(canSubmit?:()=>boolean):void {
  if(!canSubmit)return;
  let allowed=false;try{allowed=canSubmit()===true;}catch{/* A failed permit check is a proven local veto. */}
  if(!allowed)throw new OrderNotSubmittedError('Maker reduction permission changed before creation','MAKER_REDUCTION_PERMISSION_CHANGED',
    'Maker 减仓提交前交易许可、期限或原订单范围已变化，本次未发送创建请求');
}

/** A failed GET never replaces earlier verified cash with an unverified cumulative summary. */
export function unknownMakerReduction(prior:OrderResult,observedAt=Date.now()):MakerReductionObservation {
  return {activity:'unknown',executionVerified:false,result:{...prior,status:'unknown'},observedAt};
}

/** Called only after all native executions cover the order's cumulative quantity and USDT cash fees. */
export function verifiedMakerReduction(request:OrderRequest,result:OrderResult,activity:'active'|'terminal',observedAt=Date.now()):MakerReductionObservation {
  assertMakerReductionRequest(request);
  if(!hasOrderReceiptIdentity(request,result)||!result.id||!hasBoundedOrderQuantity(request,result)||
    !Number.isFinite(result.feeUsd)||!Number.isFinite(result.timestamp)||result.timestamp<=0||result.timestamp>observedAt+5000||
    result.filledQuantity>0&&(!Number.isFinite(result.averagePrice)||result.averagePrice<=0||!orderAverageRespectsLimit(request,result)))
    throw new Error('Maker reduction execution is incomplete or outside the original request');
  const tolerance=Number.EPSILON*Math.max(Math.abs(request.quantity),Math.abs(result.filledQuantity))*8;
  const verified:OrderResult={...result,averagePriceVerified:true,status:activity==='active'?'unknown':
    Math.abs(result.filledQuantity-request.quantity)<=tolerance?'filled':result.filledQuantity>0?'partial':'cancelled'};
  delete verified.confirmation;
  if(activity==='terminal'&&!isTerminalOrderReceipt(request,verified))throw new Error('Maker reduction terminal quantity is contradictory');
  return {activity,executionVerified:true,result:verified,observedAt};
}
