import type { ManualEntryExecutionSummary,ManualEntryOperation } from '../../src/shared/manual-entry';
import type { AppState } from '../../src/shared/types';
import {copyEntryExecutionProgress,entryTargetReached} from '../../src/shared/entry-execution-progress';

export interface ManualEntryRequest {
  id: string;
  opportunityId: string;
  base: string;
  requestedAt: number;
  expiresAt: number;
  operation?: ManualEntryOperation;
  sync: 'sending' | 'connected' | 'uncertain';
  syncMessage?: string;
}

export const manualEntryStorageKey = 'funding-arb-manual-entry-operations-v1';
export const manualEntryLifetimeMs = 30_000;
const states = new Set(['queued', 'checking', 'preparing', 'submitting', 'reconciling', 'completed', 'failed', 'cancelled', 'expired']);
const operationIdPattern = /^[A-Za-z0-9_-]{8,80}$/;
const opportunityPattern = /^[A-Z0-9]{2,30}-(?:binance|bybit|okx|gate|bitget)-(?:binance|bybit|okx|gate|bitget)$/;
const finitePositive=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>0;
const finiteNonnegative=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const optionalNumber=(value:unknown,nonnegative=false)=>value===undefined||typeof value==='number'&&Number.isFinite(value)&&(!nonnegative||value>=0);
export function isManualExecutionSummary(value:unknown,opportunityId:string):value is ManualEntryExecutionSummary {
  if(!value||typeof value!=='object')return false;
  const summary=value as ManualEntryExecutionSummary,[,longExchange,shortExchange]=opportunityId.split('-');
  const leg=(item:ManualEntryExecutionSummary['long'],exchange:string)=>item&&item.exchange===exchange&&
    finiteNonnegative(item.openedQuantity)&&finiteNonnegative(item.reducedQuantity)&&
    Number.isSafeInteger(item.openingAttempts)&&item.openingAttempts>=0;
  if(!leg(summary.long,longExchange)||!leg(summary.short,shortExchange)||!['confirmed','partial'].includes(summary.accountingStatus)||
    !Array.isArray(summary.events)||summary.events.length>5000||
    summary.entryExecution!==undefined&&!copyEntryExecutionProgress(summary.entryExecution)||
    ![summary.openingFeesUsd,summary.rollbackFeesUsd].every(value=>optionalNumber(value))||
    ![summary.realizedPricePnlUsd,summary.netPnlUsd].every(value=>optionalNumber(value)))return false;
  return summary.events.every(event=>event&&[longExchange,shortExchange].includes(event.exchange)&&
    ['opening','reducing'].includes(event.phase)&&['buy','sell'].includes(event.side)&&
    ['filled','partial','cancelled','unknown','pending','error'].includes(event.status)&&finitePositive(event.timestamp)&&
    finiteNonnegative(event.requestedQuantity)&&optionalNumber(event.filledQuantity,true)&&
    optionalNumber(event.limitPrice,true)&&optionalNumber(event.averagePrice,true)&&optionalNumber(event.feeUsd)&&
    (event.rejectionCode===undefined||typeof event.rejectionCode==='string'&&event.rejectionCode.length<=100)&&
    (event.rejectionReason===undefined||typeof event.rejectionReason==='string'&&event.rejectionReason.length<=2000));
}

export const manualEntryTerminal = (operation?: ManualEntryOperation) => !!operation && ['completed', 'failed', 'cancelled', 'expired'].includes(operation.state);

export function createManualEntryRequest(opportunityId: string, now = Date.now(), id: string = crypto.randomUUID()): ManualEntryRequest {
  if (!opportunityPattern.test(opportunityId) || !operationIdPattern.test(id)) throw new Error('开仓机会或操作编号无效，请刷新机会列表');
  return { id, opportunityId, base: opportunityId.split('-')[0], requestedAt: now, expiresAt: now + manualEntryLifetimeMs, sync: 'sending' };
}

export function isManualEntryReceipt(value: unknown, request: Pick<ManualEntryRequest, 'id' | 'opportunityId'>): value is ManualEntryOperation {
  if (!value || typeof value !== 'object') return false;
  const operation = value as ManualEntryOperation;
  return operation.id === request.id && operation.opportunityId === request.opportunityId && states.has(operation.state) &&
    Number.isFinite(operation.createdAt) && Number.isFinite(operation.updatedAt) && Number.isFinite(operation.expiresAt) &&
    Number.isFinite(operation.leaseExpiresAt) && typeof operation.ordersSubmitted === 'boolean' &&
    typeof operation.cancelable === 'boolean' && typeof operation.message === 'string' && operation.message.length <= 2000 &&
    (operation.result === undefined || typeof operation.result.positionStatus === 'string' &&
      operation.result.base === request.opportunityId.split('-')[0] &&
      [operation.result.longQuantity, operation.result.shortQuantity].every(value => Number.isFinite(value) && value >= 0)&&
      (operation.result.executionSummary===undefined||isManualExecutionSummary(operation.result.executionSummary,request.opportunityId)));
}

/** Receipt polling can race the initial acknowledgement. Never regress committed or final evidence. */
export function applyManualEntryReceipt(request: ManualEntryRequest, receipt: ManualEntryOperation): ManualEntryRequest {
  if (!isManualEntryReceipt(receipt, request)) throw new Error('开仓状态与当前操作不一致，继续查询原操作编号');
  const previous = request.operation;
  if (previous && (receipt.updatedAt < previous.updatedAt ||
    previous.ordersSubmitted && !receipt.ordersSubmitted ||
    manualEntryTerminal(previous) && !manualEntryTerminal(receipt))) return request;
  const rank = { queued: 0, checking: 1, preparing: 2, submitting: 3, reconciling: 4, completed: 5, failed: 5, cancelled: 5, expired: 5 };
  if (previous && receipt.updatedAt === previous.updatedAt && rank[receipt.state] < rank[previous.state]) return request;
  return { ...request, operation: receipt, sync: 'connected', syncMessage: undefined };
}

export function restoreManualEntries(saved: string | null): ManualEntryRequest[] {
  try {
    const parsed: unknown = JSON.parse(saved || '[]');
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed.filter((value): value is ManualEntryRequest => {
      if (!value || typeof value !== 'object') return false;
      const request = value as ManualEntryRequest;
      if (!operationIdPattern.test(request.id) || !opportunityPattern.test(request.opportunityId) ||
        request.base !== request.opportunityId.split('-')[0] || !Number.isFinite(request.requestedAt) ||
        request.requestedAt <= 0 || request.expiresAt !== request.requestedAt + manualEntryLifetimeMs || seen.has(request.id) ||
        request.operation && !isManualEntryReceipt(request.operation, request)) return false;
      seen.add(request.id); return true;
    }).map(request => ({ ...request, sync: manualEntryTerminal(request.operation) ? 'connected' : 'uncertain',
      syncMessage: manualEntryTerminal(request.operation) ? undefined : '正在恢复原操作状态，不会重新提交订单' }));
  } catch { return []; }
}

export function manualEntryBlocksBase(request: ManualEntryRequest, state?: AppState | null): boolean {
  const operation = request.operation;
  if (!manualEntryTerminal(operation)) return true;
  if (!operation!.ordersSubmitted) return false;
  if (operation!.positionId && state?.unconfirmedOrders?.some(order => order.positionId === operation!.positionId && !order.historical)) return true;
  const position = operation!.positionId ? state?.positions.find(item => item.id === operation!.positionId) : undefined;
  if (position && !state?.unconfirmedOrders?.some(order => order.positionId === position.id && !order.historical) &&
    (position.status === 'closed' || position.status === 'open' || position.accountClosure?.confirmedAt && position.accountClosure.confirmedAt >= request.requestedAt)) return false;
  const result = operation!.result;
  if (!result) return true;
  if (result.positionStatus === 'closed') return result.longQuantity !== 0 || result.shortQuantity !== 0;
  return result.positionStatus !== 'open' || result.longQuantity <= 0 || result.shortQuantity <= 0;
}

export function manualEntryStage(request: ManualEntryRequest): string {
  if (!request.operation) return request.sync === 'sending' ? '正在接收开仓请求' : '正在确认请求是否接收';
  const labels: Record<ManualEntryOperation['state'], string> = {
    queued: '等待执行', checking: '检查双腿账户与盘口', preparing: '准备双腿合约参数',
    submitting: '提交双腿订单', reconciling: '核对成交与未配对数量', completed: '本次处理完成',
    failed: '本次开仓未完成', cancelled: '已取消，未提交订单', expired: '已过期，未提交订单',
  };
  const operation = request.operation;
  if (operation.state === 'completed' && operation.result?.positionStatus === 'open') {
    const progress=operation.result.executionSummary?.entryExecution;
    return progress&&!entryTargetReached(progress)?'已保留部分对冲，目标未补满':'双腿开仓完成';
  }
  if (manualEntryTerminal(operation)&&operation.ordersSubmitted&&operation.result?.positionStatus === 'closed'){
    const summary=operation.result.executionSummary;
    if(summary?.accountingStatus==='partial')return '未形成对冲，成交仍待核对';
    if(summary&&summary.long.openedQuantity===0&&summary.short.openedQuantity===0)return '双腿未成交，当前无仓位';
    if(operation.state==='completed'&&summary&&summary.long.openedQuantity>0&&summary.short.openedQuantity>0)return '双腿已平仓';
    return summary?'未配成双腿，已撤回成交数量':'未形成对冲，当前记录已关闭';
  }
  if (operation.state === 'failed' && !operation.ordersSubmitted) return '检查未通过，未提交订单';
  return labels[operation.state];
}

export function missingManualEntryExpired(request: ManualEntryRequest, now: number): ManualEntryRequest {
  // Only a confirmed GET 404 after the deadline may use this helper. A network error is not absence.
  if (request.operation || now < request.expiresAt + 5_000) return request;
  return { ...request, sync: 'connected', syncMessage: undefined, operation: {
    id: request.id, opportunityId: request.opportunityId, state: 'expired', createdAt: request.requestedAt,
    updatedAt: now, expiresAt: request.expiresAt, leaseExpiresAt: request.expiresAt, cancelable: false,
    ordersSubmitted: false, message: '服务端未接收此操作，开仓期限已结束；迟到请求不会提交订单',
  } };
}
