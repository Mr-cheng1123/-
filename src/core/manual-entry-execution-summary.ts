import type {ManualEntryExecutionEvent,ManualEntryExecutionSummary} from '../shared/manual-entry.js';
import type {JournalOrder,Position} from '../shared/types.js';
import {copyEntryExecutionProgress} from '../shared/entry-execution-progress.js';
import {bybitOrderDiagnosticReason} from '../adapters/bybit-order-diagnostics.js';

const positive=(value:number|undefined):value is number=>Number.isFinite(value)&&value!>0;
const nonnegative=(value:number|undefined):value is number=>Number.isFinite(value)&&value!>=0;
const fixedRejections:Record<string,string>={
  EC_NoImmediateQtyToFill:'IOC 限价内无可立即成交数量，交易所已取消本单',
  PRE_SUBMISSION_CHECK_FAILED:'委托发送前检查失败，本次未发送创建订单请求',
  INVALID_ORDER_PARAMETERS:'本地下单参数无效，本次未发送订单',
  INVALID_ORDER_PRECISION:'数量或价格无法按交易所精度转换，本次未发送订单',
  INVALID_ORDER_QUANTITY:'数量不符合交易所最小步长，本次未发送订单',
  INVALID_ORDER_PRICE:'交易所价格精度无法满足委托限价，本次未发送订单',
  INVALID_ORDER_SIZE:'数量或名义价值不符合交易所上下限，本次未发送订单',
};

/** Projection only. Never modifies a journal, forecasts a fee, or substitutes mark-price PnL for actual fills. */
export function manualEntryExecutionSummary(position:Position,journal:JournalOrder[],ordersSubmitted:boolean):ManualEntryExecutionSummary{
  const orders=journal.filter(order=>order.positionId===position.id).sort((a,b)=>a.createdAt-b.createdAt);
  const summary:ManualEntryExecutionSummary={
    long:{exchange:position.long.exchange,openedQuantity:0,reducedQuantity:0,openingAttempts:0},
    short:{exchange:position.short.exchange,openedQuantity:0,reducedQuantity:0,openingAttempts:0},
    accountingStatus:'partial',events:[],
  };
  const entryExecution=copyEntryExecutionProgress(position.entryExecution);
  if(entryExecution)summary.entryExecution=entryExecution;
  let allKnown=orders.length>0,openingFees=0,reducingFees=0,openingFeesKnown=true,reducingFeesKnown=true,cash=0,pricesKnown=true;
  for(const order of orders){
    const request=order.request,result=order.result,phase=request.reduceOnly?'reducing':'opening';
    const leg=[position.long,position.short].find(item=>item.exchange===order.exchange&&item.symbol===request.symbol);
    const expectedSide=leg?(request.reduceOnly?(leg.side==='long'?'sell':'buy'):(leg.side==='long'?'buy':'sell')):undefined;
    const matches=!!leg&&request.base===position.base&&request.side===expectedSide&&positive(request.quantity);
    const known=matches&&!!result&&['filled','partial','cancelled'].includes(result.status)&&nonnegative(result.filledQuantity)&&
      result.filledQuantity<=request.quantity+Math.max(1e-9,request.quantity*1e-9);
    const feeKnown=known&&Number.isFinite(result!.feeUsd);
    const status:ManualEntryExecutionEvent['status']=matches?(result?.status??(order.error?'error':'pending')):'unknown';
    const event:ManualEntryExecutionEvent={exchange:order.exchange,phase,side:request.side,status,
      requestedQuantity:positive(request.quantity)?request.quantity:0,
      timestamp:positive(result?.timestamp)?result!.timestamp:positive(order.createdAt)?order.createdAt:position.openedAt};
    if(positive(request.limitPrice))event.limitPrice=request.limitPrice;
    if(known)event.filledQuantity=result!.filledQuantity;
    if(known&&positive(result!.averagePrice)&&result!.averagePriceVerified!==false)event.averagePrice=result!.averagePrice;
    if(feeKnown)event.feeUsd=result!.feeUsd;
    if(known&&status==='cancelled'&&result!.filledQuantity===0){
      const code=result!.rejectionCode??(order.exchange==='bybit'?'BYBIT_CANCELLED_ZERO_FILL':undefined);
      const bybitReason=order.exchange==='bybit'?bybitOrderDiagnosticReason(code,request.reduceOnly):undefined;
      if(bybitReason){event.rejectionCode=code;event.rejectionReason=bybitReason;}
      else if(code&&Object.hasOwn(fixedRejections,code)){event.rejectionCode=code;event.rejectionReason=fixedRejections[code];}
      else if(code&&/^\d{3,8}$/.test(code)){event.rejectionCode=code;event.rejectionReason='交易所明确拒绝该委托';}
    }
    summary.events.push(event);
    if(matches&&!request.reduceOnly)summary[leg!.side].openingAttempts++;
    if(!known){allKnown=false;if(phase==='opening')openingFeesKnown=false;else reducingFeesKnown=false;continue;}
    const quantity=result!.filledQuantity;
    if(request.reduceOnly)summary[leg!.side].reducedQuantity+=quantity;else summary[leg!.side].openedQuantity+=quantity;
    if(!feeKnown){allKnown=false;if(phase==='opening')openingFeesKnown=false;else reducingFeesKnown=false;}
    else if(request.reduceOnly)reducingFees+=result!.feeUsd;else openingFees+=result!.feeUsd;
    if(quantity>0){
      if(!positive(result!.averagePrice)||result!.averagePriceVerified===false){pricesKnown=false;allKnown=false;}
      else cash+=(request.side==='sell'?1:-1)*quantity*result!.averagePrice;
    }
  }
  if(!orders.length&&!ordersSubmitted)summary.accountingStatus='confirmed';
  else if(allKnown)summary.accountingStatus='confirmed';
  if(orders.length&&openingFeesKnown)summary.openingFeesUsd=openingFees;
  if(orders.length&&reducingFeesKnown)summary.rollbackFeesUsd=reducingFees;
  const flat=['long','short'].every(side=>{
    const leg=summary[side as 'long'|'short'],current=position[side as 'long'|'short'].quantity;
    return nonnegative(current)&&current===0&&Math.abs(leg.openedQuantity-leg.reducedQuantity)<=Math.max(1e-9,leg.openedQuantity*1e-9);
  });
  if(position.status==='closed'&&allKnown&&pricesKnown&&flat){
    summary.realizedPricePnlUsd=cash;
    if(Number.isFinite(position.fundingUsd)&&Number.isFinite(position.transferCostUsd))summary.netPnlUsd=cash+position.fundingUsd-openingFees-reducingFees-position.transferCostUsd;
  }
  return summary;
}
