import type {AppConfig,JournalOrder,Position} from './types.js';
import {hasOrderReceiptIdentity,hasBoundedOrderQuantity} from './order-receipt-validity.js';

/** One-leg opening notional, independent of leverage, current prices and remaining quantity. */
export function profitExitNotionalUsd(position:Position):number|undefined {
  const frozen=position.profitExitNotionalUsd;
  if(frozen!==undefined)return Number.isFinite(frozen)&&frozen>0?frozen:undefined;
  const values=[position.long.quantity,position.short.quantity,position.long.entryPrice,position.short.entryPrice];
  if(!values.every(value=>Number.isFinite(value)&&value>0))return;
  const notional=(position.long.quantity*position.long.entryPrice+position.short.quantity*position.short.entryPrice)/2;
  return Number.isFinite(notional)&&notional>0?notional:undefined;
}

/** Recover legacy opening quantities only from the position's own booked closing receipts. */
export function freezeProfitExitNotional(position:Position,orders:readonly JournalOrder[]):boolean {
  if(position.profitExitNotionalUsd!==undefined||position.manualCloseOnly||position.status==='opening')return false;
  let longQuantity=position.long.quantity,shortQuantity=position.short.quantity;
  for(const order of orders){
    if(order.positionId!==position.id||!order.request.reduceOnly||order.executionEvidence?.role==='entry-tail')continue;
    const result=order.result;
    if(!result||!hasOrderReceiptIdentity(order.request,result)||!hasBoundedOrderQuantity(order.request,result)||result.filledQuantity<=0)continue;
    // For a supervised active Maker, result contains only cumulative quantities already booked.
    if(result.status==='unknown'&&!order.makerReduction?.bookedExecution)continue;
    const leg=[position.long,position.short].find(leg=>leg.exchange===order.exchange&&leg.symbol===order.request.symbol&&
      order.request.side===(leg.side==='long'?'sell':'buy'));
    if(leg===position.long)longQuantity+=result.filledQuantity;
    else if(leg===position.short)shortQuantity+=result.filledQuantity;
  }
  const values=[longQuantity,shortQuantity,position.long.entryPrice,position.short.entryPrice];
  if(!values.every(value=>Number.isFinite(value)&&value>0))return false;
  const notional=(longQuantity*position.long.entryPrice+shortQuantity*position.short.entryPrice)/2;
  if(!Number.isFinite(notional)||notional<=0)return false;
  position.profitExitNotionalUsd=notional;return true;
}

export function exitProfitThresholdUsd(position:Position,config:AppConfig):number {
  const notional=profitExitNotionalUsd(position),bps=config.minExitProfitBps??10;
  return notional!==undefined&&Number.isFinite(bps)&&bps>=0?notional*bps/10000:NaN;
}

export function exitNetProfitBps(position:Position,netProfitUsd:number):number|undefined {
  const notional=profitExitNotionalUsd(position);
  return notional!==undefined&&Number.isFinite(netProfitUsd)?netProfitUsd/notional*10000:undefined;
}
