import type {AppConfig,JournalOrder,Position,PositionLeg} from './types.js';
import {estimateFeeRebateUsd,estimatedPositionFeeRebateUsd,feeRebatePct} from './fee-rebates.js';
import {conflictingNativeOrderReceipts,hasBoundedOrderQuantity,hasOrderReceiptIdentity,isTerminalOrderReceipt} from './order-receipt-validity.js';

const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const sameCash=(a:number,b:number)=>Math.abs(a-b)<=Number.EPSILON*Math.max(1,Math.abs(a),Math.abs(b))*16;

/** Pure calculation from already booked cash, never an exchange rebate receipt or a trading permission.
 * Complete signed order totals allow positive charges and negative native Maker cash to be separated.
 * A leg without its old journal uses the conservative net-leg estimate; known bad evidence never falls back.
 * A previous derived projection is deliberately ignored so a changed percentage cannot reuse an old amount. */
export function projectPositionFeeRebate(p:Position,orders:readonly JournalOrder[],config:Pick<AppConfig,'feeRebatePct'>):number|undefined {
  const legs=[p.long,p.short];
  if(!legs.every(leg=>leg&&finite(leg.feesUsd))||!finite(p.feesUsd)||
    !sameCash(p.feesUsd,p.long.feesUsd+p.short.feesUsd))return;
  // No return can be invented with a disabled policy. Existing native cash guards remain the callers' responsibility.
  if(legs.every(leg=>feeRebatePct(leg.exchange,config)===0))return 0;
  if(typeof p.id!=='string'||!p.id||p.long.side!=='long'||p.short.side!=='short'||
    p.long.exchange===p.short.exchange&&p.long.symbol===p.short.symbol)return;
  const selected=orders.filter(order=>order?.positionId===p.id),conflicts=conflictingNativeOrderReceipts(orders);
  const totals=new Map<PositionLeg,{gross:number;rebate:number;count:number}>(legs.map(leg=>[leg,{gross:0,rebate:0,count:0}]));
  const clients=new Set<string>(),nativeIds=new Set<string>();
  for(const order of selected){
    const request=order.request,result=order.result;
    if(!request||!result||conflicts.has(order)||request.base!==p.base||
      !hasOrderReceiptIdentity(request,result)||!hasBoundedOrderQuantity(request,result))return;
    const candidates=legs.filter(leg=>leg.exchange===order.exchange&&leg.symbol===request.symbol&&
      request.side===(leg.side==='long'?(request.reduceOnly?'sell':'buy'):(request.reduceOnly?'buy':'sell')));
    if(candidates.length!==1||!finite(result.feeUsd))return;
    const clientKey=JSON.stringify([order.exchange,request.clientOrderId]),nativeKey=JSON.stringify([order.exchange,result.id]);
    if(clients.has(clientKey)||result.id&&nativeIds.has(nativeKey))return;
    clients.add(clientKey);if(result.id)nativeIds.add(nativeKey);
    const booked=order.executionEvidence?.bookedFeeUsd;
    if(booked!==undefined&&!finite(booked))return;
    const activeBookedMaker=order.makerReduction?.bookedExecution===true&&
      order.makerReduction.activity==='active'&&request.reduceOnly&&request.postOnly===true&&
      order.executionEvidence?.method==='maker'&&finite(booked)&&result.status==='unknown';
    if(!isTerminalOrderReceipt(request,result)&&!activeBookedMaker)return;
    const actualFee=booked??result.feeUsd,total=totals.get(candidates[0])!;
    total.gross+=actualFee;total.rebate+=estimateFeeRebateUsd(order.exchange,actualFee,config);total.count++;
    if(!finite(total.gross)||!finite(total.rebate))return;
  }
  let missingJournal=false;
  for(const leg of legs){
    const total=totals.get(leg)!;
    if(total.count){if(!sameCash(total.gross,leg.feesUsd))return;}
    else if(leg.feesUsd!==0)missingJournal=true;
  }
  if(missingJournal)return estimatedPositionFeeRebateUsd({long:p.long,short:p.short},config);
  const rebate=legs.reduce((sum,leg)=>sum+totals.get(leg)!.rebate,0);
  return finite(rebate)&&rebate>=0?rebate:undefined;
}
