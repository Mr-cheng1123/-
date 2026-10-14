import type {AppConfig,JournalOrder,MarketSnapshot,Position,PositionLeg} from '../shared/types.js';
import {effectiveFeeRate} from '../shared/fee-rebates.js';
import {nativeTakerFeeRate} from '../shared/trading-fees.js';
import {isUnconfirmedJournalOrder} from '../shared/ledger-lifecycle.js';

export type NativeExitTakerProof=Pick<MarketSnapshot,'exchange'|'symbol'|'takerFeeRate'|'takerFeeAt'|'takerFeeSource'>;
export interface NativeExitReserve {feeReserveUsd:number;lossReserveUsd:number}
const positive=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>0;
const nonnegative=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const near=(a:number,b:number)=>Math.abs(a-b)<=Math.max(1e-12,Math.max(Math.abs(a),Math.abs(b))*Number.EPSILON*32);
const failure=()=>new Error('原未知减仓缺少有效身份、合法金额或当前实际费率，不能计算安全退出准备金');
const missingAmount=(value:unknown)=>value===undefined||value===null||typeof value==='number'&&Number.isNaN(value);

/** A booked-fee field alone is not proof that a historical unknown prefix was paid.
 * Credit only a complete, independently identified native fill audit matching the
 * saved receipt and its durable cash-commit timing. All other histories reserve
 * the whole request fee again, which is deliberately conservative. */
function auditedBookedFee(order:JournalOrder,leg:PositionLeg,position:Position,now:number,rate:number,duplicateExecIds:ReadonlySet<string>):number {
  const result=order.result,evidence=order.executionEvidence,fills=evidence?.fills,committedAt=order.execution?.confirmedAt;
  if(!result||!result.id||result.id===order.request.clientOrderId||result.clientOrderId!==order.request.clientOrderId||
    result.averagePriceVerified!==true||!positive(result.filledQuantity)||!positive(result.averagePrice)||
    !nonnegative(result.feeUsd)||!nonnegative(evidence?.bookedFeeUsd)||!near(result.feeUsd,evidence.bookedFeeUsd)||
    !positive(committedAt)||committedAt<order.createdAt||committedAt>now+5000||!Array.isArray(fills)||!fills.length)return 0;
  let quantity=0,cash=0,fee=0;const seen=new Set<string>();
  for(const fill of fills){
    if(!fill||typeof fill.execId!=='string'||!fill.execId||seen.has(fill.execId)||
      duplicateExecIds.has(JSON.stringify([order.exchange,order.request.symbol,fill.execId]))||fill.feeCurrency!=='USDT'||fill.liquidity!=='taker'||
      !positive(fill.quantity)||!positive(fill.price)||!nonnegative(fill.feeUsd)||!positive(fill.observedAt)||
      fill.observedAt>committedAt||fill.observedAt>now+5000)return 0;
    seen.add(fill.execId);quantity+=fill.quantity;cash+=fill.quantity*fill.price;fee+=fill.feeUsd;
  }
  if(![quantity,cash,fee].every(Number.isFinite)||!near(quantity,result.filledQuantity)||
    !near(cash,result.filledQuantity*result.averagePrice)||!near(fee,result.feeUsd)||
    !Number.isFinite(leg.feesUsd)||!Number.isFinite(position.feesUsd)||
    leg.feesUsd<fee||position.feesUsd<fee)return 0;
  // A favorable known sell can pay more fee than the limit-price model for that
  // same prefix. Subtracting that larger fee would erase the remaining unknown
  // fee reserve; credit at most this prefix's limit-price fee equivalent.
  return Math.min(fee,quantity*order.request.limitPrice*rate);
}

/** Conditional economic reserve only. It never resolves a historical order,
 * changes actual quantities/fees, credits possible profit or grants a POST.
 * For reduce-only IOC, the buy limit bounds the maximum buy cost and the sell
 * limit bounds the minimum sell income. With valid nonnegative rates <=100%,
 * the combined price/fee outcome is worst at that limit; no favorable price is
 * counted here. The full original request quantity is always reserved. */
export function estimateNativeExitReserve(unknownOrders:readonly JournalOrder[],position:Position,
  currentNativeTakerRates:readonly NativeExitTakerProof[],config:AppConfig):NativeExitReserve {
  const now=Date.now(),clients=new Set<string>(),nativeIds=new Set<string>();
  let feeReserveUsd=0,lossReserveUsd=0;
  if(!position||typeof position.id!=='string'||!position.id||typeof position.base!=='string'||!position.base||
    !Array.isArray(unknownOrders)||!Array.isArray(currentNativeTakerRates))throw failure();
  const seenExecIds=new Set<string>(),duplicateExecIds=new Set<string>();
  for(const order of unknownOrders){
    const fills=order?.executionEvidence?.fills;if(!Array.isArray(fills))continue;
    for(const fill of fills){
      if(!fill)continue;const key=JSON.stringify([order.exchange,order.request?.symbol,fill.execId]);
      if(seenExecIds.has(key))duplicateExecIds.add(key);seenExecIds.add(key);
    }
  }
  const reserves:{order:JournalOrder;leg:PositionLeg;grossFee:number;feeCredit:number}[]=[];
  for(const order of unknownOrders){
    const request=order?.request;
    if(!order||order.positionId!==position.id||!request||typeof request.clientOrderId!=='string'||!request.clientOrderId||
      clients.has(request.clientOrderId)||request.base!==position.base||request.reduceOnly!==true||
      request.postOnly!==undefined&&request.postOnly!==false||
      order.makerReduction||order.executionEvidence?.method==='maker'||!positive(request.quantity)||!positive(request.limitPrice)||!positive(order.createdAt)||
      !isUnconfirmedJournalOrder(order))throw failure();
    clients.add(request.clientOrderId);
    const legs=[position.long,position.short].filter(leg=>leg&&leg.exchange===order.exchange&&leg.symbol===request.symbol&&
      request.side===(leg.side==='long'?'sell':leg.side==='short'?'buy':undefined));
    if(legs.length!==1||!positive(legs[0].entryPrice)||!nonnegative(legs[0].quantity))throw failure();
    const leg=legs[0],result=order.result;
    if(result){
      if(result.clientOrderId!==request.clientOrderId||typeof result.id!=='string'||
        !missingAmount(result.filledQuantity)&&(!nonnegative(result.filledQuantity)||result.filledQuantity>request.quantity)||
        !missingAmount(result.feeUsd)&&!(typeof result.feeUsd==='number'&&Number.isFinite(result.feeUsd))||
        !missingAmount(result.averagePrice)&&!nonnegative(result.averagePrice)||
        positive(result.filledQuantity)&&!positive(result.averagePrice))throw failure();
      if(result.id){
        const key=JSON.stringify([order.exchange,request.symbol,result.id]);
        if(nativeIds.has(key))throw failure();nativeIds.add(key);
      }
    }
    const oldFee=order.executionEvidence?.nativeTakerFeeRate,bookedFee=order.executionEvidence?.bookedFeeUsd;
    if(oldFee!==undefined&&!(nonnegative(oldFee)&&oldFee<=1)||
      !missingAmount(bookedFee)&&!(typeof bookedFee==='number'&&Number.isFinite(bookedFee)))throw failure();
    const proofs=currentNativeTakerRates.filter(proof=>proof.exchange===order.exchange&&proof.symbol===request.symbol);
    if(proofs.length!==1)throw failure();
    const currentFee=nativeTakerFeeRate(proofs[0],now);
    if(currentFee===undefined)throw failure();
    const rate=Math.max(currentFee,oldFee??currentFee),grossFee=request.quantity*request.limitPrice*rate;
    const feeCredit=auditedBookedFee(order,leg,position,now,rate,duplicateExecIds);
    const loss=request.quantity*Math.max(0,leg.side==='short'?request.limitPrice-leg.entryPrice:leg.entryPrice-request.limitPrice);
    if(![grossFee,loss].every(Number.isFinite))throw failure();
    reserves.push({order,leg,grossFee,feeCredit});lossReserveUsd+=loss;
    if(!Number.isFinite(lossReserveUsd))throw failure();
  }
  const creditedFees=(leg?:PositionLeg)=>reserves.reduce((total,row)=>total+(row.feeCredit>0&&(!leg||row.leg===leg)?row.order.result!.feeUsd:0),0);
  // Each audit must fit the durable ledger jointly, not only in isolation. A
  // duplicated/misattributed historical prefix cannot obtain repeated credits.
  const groupCreditValid=Number.isFinite(creditedFees())&&creditedFees()<=position.feesUsd;
  for(const row of reserves){
    const legCreditValid=Number.isFinite(creditedFees(row.leg))&&creditedFees(row.leg)<=row.leg.feesUsd;
    const feeCredit=groupCreditValid&&legCreditValid?row.feeCredit:0;
    // Apply the configured rebate once to the reserved positive expense, never
    // rewrite gross booked fees or count a negative receipt as a rebate estimate.
    const reservedFee=effectiveFeeRate(row.order.exchange,Math.max(0,row.grossFee-feeCredit),config);
    if(reservedFee===undefined||!Number.isFinite(reservedFee))throw failure();
    feeReserveUsd+=reservedFee;if(!Number.isFinite(feeReserveUsd))throw failure();
  }
  return {feeReserveUsd,lossReserveUsd};
}
