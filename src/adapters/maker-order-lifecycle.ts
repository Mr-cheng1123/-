import type {OrderRequest,OrderResult} from '../shared/types.js';

export const NATIVE_MAKER_WAIT_MS=350;
export interface NativeMakerOrderLifecycle {
  /** Pure GET inspection, including native identity and actual cash fee verification. */
  inspect:(prior:OrderResult,orderId:string)=>Promise<OrderResult>;
  cancel:(orderId:string)=>Promise<void>;
}
interface Clock {now:()=>number;wait:(ms:number)=>Promise<void>}
const liveClock:Clock={now:Date.now,wait:ms=>new Promise(resolve=>setTimeout(resolve,ms))};
const terminal=(result:OrderResult)=>['filled','partial','cancelled'].includes(result.status);

function sameOrder(request:OrderRequest,orderId:string,prior:OrderResult,next:OrderResult):boolean{
  return next.id===orderId&&next.clientOrderId===request.clientOrderId&&Number.isFinite(next.filledQuantity)&&
    next.filledQuantity+1e-12>=prior.filledQuantity&&next.filledQuantity>=0&&next.filledQuantity<=request.quantity*(1+1e-9)&&
    (!terminal(next)||Number.isFinite(next.feeUsd)&&(next.filledQuantity===0||Number.isFinite(next.averagePrice)&&next.averagePrice>0));
}

/** Post one exact Maker order, observe briefly, then cancel the remainder before exposing confirmed fills to the hedger.
 * The 350ms budget covers observation waiting. Network and cancel confirmation can take longer; it is not an exposure guarantee. */
export async function settleNativeMakerOrder(request:OrderRequest,prior:OrderResult,orderId:string|undefined,
  lifecycle:NativeMakerOrderLifecycle,clock:Clock=liveClock):Promise<OrderResult>{
  if(!orderId)return {...prior,status:'unknown'};
  let confirmed:OrderResult={...prior,id:orderId,status:'unknown'};
  const deadline=clock.now()+NATIVE_MAKER_WAIT_MS;
  while(clock.now()<deadline){
    const remaining=deadline-clock.now();let timer:ReturnType<typeof setTimeout>|undefined;
    // A slow GET must not extend the active-order wait budget. It never submits or mutates the ledger.
    const observed=await Promise.race([
      lifecycle.inspect(confirmed,orderId).catch(()=>undefined),
      new Promise<undefined>(resolve=>{timer=setTimeout(()=>resolve(undefined),remaining);}),
    ]);
    if(timer)clearTimeout(timer);
    if(!observed||!sameOrder(request,orderId,confirmed,observed))break;
    confirmed=observed;
    if(terminal(confirmed))return confirmed;
    if(confirmed.filledQuantity>0)break;
    const pause=Math.min(25,deadline-clock.now());if(pause>0)await clock.wait(pause);
  }
  // A cancellation ACK or error is not proof that the remaining order is inactive.
  // Query only this acknowledged ID afterward; unknown state must block a new entry.
  try{await lifecycle.cancel(orderId);}catch{/* A concurrent fill/cancel is resolved solely by the final native read. */}
  try{
    const final=await lifecycle.inspect(confirmed,orderId);
    if(sameOrder(request,orderId,confirmed,final))return terminal(final)?final:{...final,status:'unknown'};
  }catch{/* Keep the highest confirmed quantity, without turning an active order into a terminal partial fill. */}
  return {...confirmed,status:'unknown'};
}
