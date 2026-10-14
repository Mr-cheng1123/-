import type {OrderResult} from '../shared/types.js';

type Diagnostic=Pick<OrderResult,'rejectionCode'|'rejectionReason'>;
interface NativeDiagnostic {orderStatus?:unknown;rejectReason?:unknown;cancelType?:unknown}

// Fixed text only. Never copy a private response or an unrecognised reason into the ledger/UI.
// https://bybit-exchange.github.io/docs/v5/enum#rejectreason
// https://bybit-exchange.github.io/docs/v5/enum#canceltype
const reasons:Record<string,string>={
  EC_NoImmediateQtyToFill:'IOC 委托在指定限价内无可立即成交数量，本单已取消',
  EC_NoEnoughQtyToFill:'交易所返回可成交数量不足，本单未成交',
  EC_LimitOrderInvalidPrice:'交易所拒绝无效的限价',
  EC_InvalidPriceScale:'交易所拒绝不符合价格精度的委托',
  EC_InvalidSymbolStatus:'合约当前状态不允许该委托',
  EC_QtyCannotBeZero:'交易所拒绝数量为零的委托',
  EC_EcInvalidQty:'交易所拒绝无效的委托数量',
  EC_InvalidAmount:'交易所拒绝无效的委托金额',
  EC_ReachRiskPriceLimit:'委托触及交易所风险价格限制',
  EC_BySelfMatch:'委托触发自成交保护，本单已取消',
  EC_StopBySelfMatch:'委托触发自成交保护，本单已停止',
  EC_PerCancelRequest:'交易所按取消请求取消本单',
  EC_CancelForNoFullFill:'委托未满足全部成交要求，本单已取消',
  CancelByUser:'交易所按用户取消请求取消本单',
  CancelByReduceOnly:'交易所因只减仓规则取消本单',
  CancelByPrepareLiq:'交易所为准备强平并释放保证金取消本单',
  CancelAllBeforeLiq:'交易所为准备强平并释放保证金取消本单',
  CancelByPrepareAdl:'交易所因自动减仓准备取消本单',
  CancelAllBeforeAdl:'交易所因自动减仓取消本单',
  CancelByAdmin:'交易所管理端取消本单',
  CancelBySettle:'交易所因合约结算或下架取消本单',
  CancelByTpSlTsClear:'持仓清空后，交易所取消关联止盈止损委托',
  CancelBySmp:'交易所因自成交保护取消本单',
  CancelByDCP:'交易所因断连保护触发取消本单',
  CancelByRebalance:'交易所因价差交易单腿价格超出范围取消本单',
  CancelByOCOTpCanceledBySlTriggered:'止损触发后，交易所取消关联止盈委托',
  CancelByOCOSlCanceledByTpTriggered:'止盈触发后，交易所取消关联止损委托',
  BYBIT_CANCELLED_ZERO_FILL:'委托已取消且未成交，具体取消原因尚未识别',
  BYBIT_REJECTED_ZERO_FILL:'委托已被拒绝且未成交，具体拒绝原因尚未识别',
  BYBIT_EXPIRED_ZERO_FILL:'委托已到期且未成交，具体原因尚未识别',
};
const cancellationStatuses=new Set(['Cancelled','Rejected','Deactivated','PartiallyFilledCanceled','canceled','cancelled','rejected','expired']);

/** Rebuild trusted text from a known code; opening and reduction have different zero-fill effects. */
export function bybitOrderDiagnosticReason(code:unknown,reduceOnly:boolean):string|undefined{
  if(typeof code!=='string'||!Object.hasOwn(reasons,code))return;
  return `Bybit ${reasons[code]}；${reduceOnly?'仓位尚未因此减少':'本单未形成新仓位'}`;
}

/** A cancelled zero-fill order is evidence of no execution, not evidence of a particular failure. */
export function bybitOrderDiagnostic(raw:NativeDiagnostic,filledQuantity:number,reduceOnly:boolean,priorCode?:string):Diagnostic|undefined{
  if(filledQuantity!==0||typeof raw.orderStatus!=='string'||!cancellationStatuses.has(raw.orderStatus))return;
  const rejectReason=raw.rejectReason,cancelType=raw.cancelType;
  let rejectionCode=typeof rejectReason==='string'&&Object.hasOwn(reasons,rejectReason)?rejectReason:
    typeof cancelType==='string'&&Object.hasOwn(reasons,cancelType)?cancelType:
    ['Rejected','rejected'].includes(raw.orderStatus)?'BYBIT_REJECTED_ZERO_FILL':
    raw.orderStatus==='expired'?'BYBIT_EXPIRED_ZERO_FILL':'BYBIT_CANCELLED_ZERO_FILL';
  // Later cumulative events can omit metadata; retain an earlier identified cause for this exact order.
  if(rejectionCode.startsWith('BYBIT_')&&typeof priorCode==='string'&&!priorCode.startsWith('BYBIT_')&&Object.hasOwn(reasons,priorCode))
    rejectionCode=priorCode;
  return {rejectionCode,rejectionReason:bybitOrderDiagnosticReason(rejectionCode,reduceOnly)};
}
