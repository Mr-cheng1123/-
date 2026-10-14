import type {JournalOrder,OrderRequest,OrderResult,OrderConfirmationDiagnostic} from './types.js';
import {sanitizeApiMessage} from './exchange-api-diagnostic.js';

const confirmationStages=new Set(['pre-submit','create','order-read','receipt']);
const confirmationReasons=new Set(['pre-submit-failed','request-failed','acknowledgement-missing','not-found',
  'identity-mismatch','invalid-execution','nonterminal','fee-unverified','malformed-response']);
/** Fixed phase labels plus a bounded native business message; never retain a private response body. */
export function safeOrderConfirmation(value:unknown):OrderConfirmationDiagnostic|undefined {
  if(!value||typeof value!=='object')return;
  const own=(key:string)=>Object.getOwnPropertyDescriptor(value,key)?.value;
  const diagnostic={stage:own('stage'),reason:own('reason'),apiCode:own('apiCode'),apiMessage:own('apiMessage'),observedAt:own('observedAt')} as Partial<OrderConfirmationDiagnostic>;
  if(!confirmationStages.has(diagnostic.stage??'')||!confirmationReasons.has(diagnostic.reason??''))return;
  const code=diagnostic.apiCode;
  const apiMessage=sanitizeApiMessage(diagnostic.apiMessage),observedAt=diagnostic.observedAt;
  return {stage:diagnostic.stage!,reason:diagnostic.reason!,
    ...(typeof code==='string'&&(/^-?\d{4,8}$/.test(code)||/^[A-Z][A-Z0-9_]{0,63}$/.test(code))?{apiCode:code}:{}),
    ...(apiMessage?{apiMessage}:{}),...(typeof observedAt==='number'&&Number.isFinite(observedAt)&&observedAt>0?{observedAt}:{})};
}
export function orderConfirmationText(value:unknown):string|undefined {
  const diagnostic=safeOrderConfirmation(value);if(!diagnostic)return;
  const stage={ 'pre-submit':'提交前检查','create':'创建请求','order-read':'原订单查询','receipt':'成交回执'}[diagnostic.stage];
  const reason={ 'pre-submit-failed':'检查未通过','request-failed':'请求未确认','acknowledgement-missing':'缺少创建确认',
    'not-found':'暂未查到原订单','identity-mismatch':'订单身份不一致','invalid-execution':'成交数据无效',
    'nonterminal':'尚未终态','fee-unverified':'实际费用未确认','malformed-response':'回包格式不完整'}[diagnostic.reason];
  return `${stage}：${reason}${diagnostic.apiCode?` (${diagnostic.apiCode})`:''}${diagnostic.apiMessage?`；${diagnostic.apiMessage}`:''}`;
}

const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const positive=(value:unknown):value is number=>finite(value)&&value>0;
export const orderQuantityTolerance=(quantity:number)=>Math.abs(quantity)*Number.EPSILON*8;
const equal=(left:number,right:number)=>Math.abs(left-right)<=Math.max(orderQuantityTolerance(left),orderQuantityTolerance(right));
// Mirrors the proven local rejections and explicit Bybit create refusals already emitted by the adapters.
// Network/internal/duplicate/processing errors are intentionally absent and remain unknown.
// 110126 is emitted only after the Bybit create adapter proves the exact native agreement message and API_ERROR;
// its numeric diagnostic alone never proves zero execution or resolves a historical unknown.
// IOC_REDUCTION_PERMISSION_CHANGED is mapped only by the current IOC worker after its own
// final permission callback witnesses that this new intent was not sent. It is scoped
// separately below: entries, PostOnly orders and old unknown receipts cannot borrow it.
const provenNoSubmitCodes=new Set(['PRE_SUBMISSION_CHECK_FAILED','INVALID_ORDER_PARAMETERS','INVALID_ORDER_PRECISION','AUTOMATIC_ENTRY_PERMISSION_CHANGED',
  'INVALID_ORDER_QUANTITY','INVALID_ORDER_PRICE','INVALID_ORDER_SIZE','INVALID_MAKER_ORDER','INVALID_CLOSE_SELECTOR',
  'CLOSE_POSITION_UNVERIFIED','CLOSE_POSITION_CHANGED','UNVERIFIED_PRODUCT_ACCESS','MAKER_REDUCTION_PERMISSION_CHANGED','10001','10002','10003','10004','10005','10007','10010',
  '10024','10027','10029','110003','110004','110006','110007','110012','110017','110020','110021','110023',
  '110032','110040','110044','110045','110066','110074','110086','110090','110094','110123','110125','110126',
  '110132','110134','30208','30209']);

/** Adapters emit an empty native ID only for a proven pre-send/documented create refusal. */
export function isProvenNoSubmitReceipt(request:OrderRequest,result:OrderResult|undefined):boolean {
  return !!result&&result.clientOrderId===request.clientOrderId&&result.id===''&&result.status==='cancelled'&&
    result.filledQuantity===0&&result.feeUsd===0&&typeof result.rejectionCode==='string'&&
    (provenNoSubmitCodes.has(result.rejectionCode)||request.postOnly===true&&request.reduceOnly&&result.rejectionCode==='GATE_MAKER_POST_ONLY_WOULD_TAKE'||
      request.reduceOnly===true&&request.postOnly!==true&&result.rejectionCode==='IOC_REDUCTION_PERMISSION_CHANGED'&&
      result.averagePrice===0&&positive(result.timestamp));
}
export function hasOrderReceiptIdentity(request:OrderRequest,result:OrderResult|undefined):result is OrderResult {
  return !!result&&typeof request.clientOrderId==='string'&&request.clientOrderId.length>0&&
    result.clientOrderId===request.clientOrderId&&typeof result.id==='string'&&
    ['filled','partial','cancelled','unknown'].includes(result.status)&&
    (result.id.length>0||isProvenNoSubmitReceipt(request,result)||result.status==='unknown'&&result.filledQuantity===0);
}
export function hasBoundedOrderQuantity(request:OrderRequest,result:OrderResult):boolean {
  return positive(request.quantity)&&finite(result.filledQuantity)&&result.filledQuantity>=0&&
    result.filledQuantity<=request.quantity+orderQuantityTolerance(request.quantity);
}
export function orderAverageRespectsLimit(request:OrderRequest,result:OrderResult):boolean {
  if(result.filledQuantity===0)return true;
  if(!positive(request.limitPrice)||!positive(result.averagePrice))return false;
  const tolerance=Math.max(1e-12,Math.max(request.limitPrice,result.averagePrice)*Number.EPSILON*8);
  return request.side==='buy'?result.averagePrice<=request.limitPrice+tolerance:result.averagePrice>=request.limitPrice-tolerance;
}
/** Quantities may be known while historical native prices or fees remain unavailable. */
export function isTerminalOrderReceipt(request:OrderRequest,result:OrderResult|undefined):boolean {
  return hasOrderReceiptIdentity(request,result)&&result.status!=='unknown'&&hasBoundedOrderQuantity(request,result)&&
    !(result.status==='filled'&&(!positive(result.filledQuantity)||!equal(result.filledQuantity,request.quantity)))&&
    !(positive(result.averagePrice)&&result.averagePriceVerified!==false&&!orderAverageRespectsLimit(request,result));
}
/**
 * Normalize only a receipt for the original request. Contradictory terminal status is unknown,
 * while an identity-matched valid cumulative fill remains a lower bound. A bad later GET
 * never discards the original trusted unknown quantity or promotes it into confirmed profit.
 */
export function normalizeOrderReceipt(request:OrderRequest,result:OrderResult|undefined,now=Date.now(),prior?:OrderResult):OrderResult {
  const confirmation=safeOrderConfirmation(result?.confirmation)??safeOrderConfirmation(prior?.confirmation);
  const confirmed=(value:OrderResult):OrderResult=>{
    const diagnostic=value.status==='unknown'?confirmation:safeOrderConfirmation(result?.confirmation);
    const output={...value};delete output.confirmation;delete output.originalConfirmation;delete output.orderReadAt;
    if(diagnostic)output.confirmation=diagnostic;
    const source=result?.clientOrderId===request.clientOrderId?result:prior;
    const original=safeOrderConfirmation(source?.originalConfirmation);
    if(original)output.originalConfirmation=original;
    const readAt=source?.orderReadAt;
    if(typeof readAt==='number'&&Number.isFinite(readAt)&&readAt>0&&readAt<=now+5000&&readAt>=(prior?.orderReadAt??0))output.orderReadAt=readAt;
    else if(prior?.clientOrderId===request.clientOrderId&&typeof prior.orderReadAt==='number'&&Number.isFinite(prior.orderReadAt)&&prior.orderReadAt>0&&prior.orderReadAt<=now+5000)output.orderReadAt=prior.orderReadAt;
    return output;
  };
  const empty=():OrderResult=>({id:'',clientOrderId:request.clientOrderId,status:'unknown',filledQuantity:0,averagePrice:0,feeUsd:0,timestamp:now});
  const fallback=()=>prior&&hasOrderReceiptIdentity(request,prior)&&hasBoundedOrderQuantity(request,prior)&&
    (prior.filledQuantity===0||positive(prior.averagePrice))?{...prior,status:'unknown' as const}:empty();
  // A current operation's local no-send witness cannot establish the outcome of an
  // already-unknown original request, even when that original has a zero lower bound.
  if(result?.rejectionCode==='IOC_REDUCTION_PERMISSION_CHANGED'&&prior?.status==='unknown')return confirmed(fallback());
  if(!hasOrderReceiptIdentity(request,result)||!hasBoundedOrderQuantity(request,result)||
    result.filledQuantity>0&&!positive(result.averagePrice)||!positive(result.timestamp)||result.timestamp>now+5000)return confirmed(fallback());
  if(prior&&hasOrderReceiptIdentity(request,prior)&&
    (prior.id&&result.id!==prior.id||result.filledQuantity<prior.filledQuantity-orderQuantityTolerance(prior.filledQuantity)))return confirmed(fallback());
  if(!orderAverageRespectsLimit(request,result))return confirmed(result.averagePriceVerified===false?{...result,status:'unknown'}:fallback());
  return confirmed(!finite(result.feeUsd)||result.status!=='unknown'&&!isTerminalOrderReceipt(request,result)?{...result,status:'unknown'}:result);
}

/** A venue/symbol native order cannot belong to two intents, and one client intent cannot be counted twice. */
export function conflictingNativeOrderReceipts(orders:readonly JournalOrder[]):Set<JournalOrder> {
  const grouped=new Map<string,JournalOrder[]>(),clients=new Map<string,JournalOrder[]>(),conflicts=new Set<JournalOrder>();
  for(const order of orders){
    const request=order?.request,result=order?.result;
    if(request&&typeof request.clientOrderId==='string'&&request.clientOrderId&&typeof request.symbol==='string'){
      const key=JSON.stringify([order.exchange,request.symbol,request.clientOrderId]),group=clients.get(key)??[];
      group.push(order);clients.set(key,group);
    }
    if(!request||!result||typeof result.id!=='string'||!result.id||typeof request.symbol!=='string')continue;
    const key=JSON.stringify([order.exchange,request.symbol,result.id]),group=grouped.get(key)??[];
    group.push(order);grouped.set(key,group);
  }
  for(const group of grouped.values())if(new Set(group.map(order=>JSON.stringify([order.positionId,order.request.clientOrderId]))).size>1)
    for(const order of group)conflicts.add(order);
  for(const group of clients.values())if(group.length>1)for(const order of group)conflicts.add(order);
  return conflicts;
}
