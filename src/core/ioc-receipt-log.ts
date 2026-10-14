import type {JournalOrder} from '../shared/types.js';
import {isTerminalOrderReceipt} from '../shared/order-receipt-validity.js';
import {formatIocLogQuantity as logQuantity,iocSubmissionVetoReasons as vetoReasons} from '../shared/ioc-log-quantity.js';

/** Describes a receipt only. The optional witness is this worker's final local veto, never saved authority. */
export function iocReductionReceiptLog(order:JournalOrder,currentWorkerLocalVetoWitness=false):string {
  const {request,result}=order,prefix=`${request.base} ${order.exchange} 对手价1 IOC`,side=request.side==='buy'?'买入':'卖出';
  if(!result||result.status==='unknown')return `${prefix} 原订单状态未知；保留原 ID 查单，禁止重发`;
  if(currentWorkerLocalVetoWitness&&result.id===''&&result.clientOrderId===request.clientOrderId&&result.status==='cancelled'&&
    result.filledQuantity===0&&result.averagePrice===0&&result.feeUsd===0&&result.rejectionCode==='IOC_REDUCTION_PERMISSION_CHANGED')
    return `${prefix} 提交前核验未通过；本次未发送创建请求；${side} 0 / ${logQuantity(request.quantity)}${
      order.executionEvidence?.iocSubmissionVeto&&Object.hasOwn(vetoReasons,order.executionEvidence.iocSubmissionVeto.code)?
        `；原因：${vetoReasons[order.executionEvidence.iocSubmissionVeto.code]}`:''}`;
  if(result.id!==''&&result.filledQuantity===0&&isTerminalOrderReceipt(request,result))
    return `${prefix} 原生订单已终态，零成交（${result.status}）；${side} 0 / ${logQuantity(request.quantity)}，等待下一次核验`;
  if(result.id===''&&result.filledQuantity===0)
    return `${prefix} 零成交回执未取得原生订单 ID；${side} 0 / ${logQuantity(request.quantity)}，发送状态须按原记录核对`;
  return `${prefix} 减仓 ${side} ${logQuantity(result.filledQuantity)} / ${logQuantity(request.quantity)}`;
}
