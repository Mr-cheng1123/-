import { useEffect, useMemo, useRef, useState } from 'react';
import type { ManualEntryOperation } from '../../src/shared/manual-entry';
import type { AppState } from '../../src/shared/types';
import { applyManualEntryReceipt, createManualEntryRequest, isManualEntryReceipt, manualEntryBlocksBase,
  manualEntryStorageKey, manualEntryTerminal, missingManualEntryExpired, restoreManualEntries, type ManualEntryRequest } from './manual-entry';

class EntryHttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
async function requestReceipt(path: string, request: ManualEntryRequest, method = 'GET', body?: unknown) {
  const response = await fetch(`/api${path}`, { method, cache: 'no-store', signal: AbortSignal.timeout(5_000),
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'funding-arb' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const result: { operation?: unknown; error?: string } = await response.json();
  if (isManualEntryReceipt(result.operation, request)) return result.operation;
  if (!response.ok) throw new EntryHttpError(response.status, result.error || '开仓状态查询未完成');
  throw new Error('尚未取得有效开仓回执，继续按原操作编号查询');
}

export function useManualEntries(state: AppState | null) {
  const [registry] = useState(() => {
    let restored: ManualEntryRequest[] = [];
    try { restored = restoreManualEntries(sessionStorage.getItem(manualEntryStorageKey)); } catch { /* Storage can be unavailable. */ }
    return { requests: new Map(restored.map(request => [request.id, request])), signatures: new Map<string, string>(),
      hydrations: new Set(restored.filter(request => manualEntryTerminal(request.operation) &&
        request.operation?.ordersSubmitted && !request.operation.result?.executionSummary).map(request => request.id)) };
  });
  const requests = useRef(registry.requests);
  // Old terminal receipts need one read to add durable native order history. Never recreate them.
  const restoredHydrations = useRef(registry.hydrations);
  const inFlight = useRef(new Set<string>()), cancellations = useRef(new Set<string>());
  const [version, changed] = useState(0);
  const stateRef = useRef(state); stateRef.current = state;
  const mounted = useRef(false);
  const publish = (request: ManualEntryRequest | string) => {
    if (typeof request === 'string') {
      if (!requests.current.delete(request)) return;
      registry.signatures.delete(request);
    } else {
      const previous = requests.current.get(request.id);
      if (previous === request) return;
      const signature = JSON.stringify(request);
      const previousSignature = registry.signatures.get(request.id) ?? (previous ? JSON.stringify(previous) : undefined);
      // Compare the full evidence, including uncertain/partial fills, not just timestamps or state names.
      if (signature === previousSignature) { registry.signatures.set(request.id, signature); return; }
      registry.signatures.set(request.id, signature);
      requests.current.set(request.id, request);
    }
    try { sessionStorage.setItem(manualEntryStorageKey, JSON.stringify([...requests.current.values()])); } catch { /* Keep the in-memory duplicate guard. */ }
    if (mounted.current) changed(version => version + 1);
  };
  const accept = (id: string, operation: ManualEntryOperation) => {
    const request = requests.current.get(id); if (!request) return;
    publish(applyManualEntryReceipt(request, operation));
  };
  const uncertain = (id: string) => {
    const request = requests.current.get(id); if (!request || manualEntryTerminal(request.operation)) return;
    publish({ ...request, sync: 'uncertain', syncMessage: request.operation?.ordersSubmitted ?
      '连接暂未恢复，订单已经提交；正在查询原操作，不能重新开仓' :
      '连接暂未恢复，正在查询原操作；准备阶段到期后不会继续开仓，不会自动重发' });
  };
  const poll = async (id: string) => {
    const request = requests.current.get(id);
    if (!request || inFlight.current.has(id) || manualEntryTerminal(request.operation) &&
      !manualEntryBlocksBase(request, stateRef.current) && !restoredHydrations.current.has(id)) return;
    inFlight.current.add(id);
    try {
      accept(id, await requestReceipt(`/entry-operations/${encodeURIComponent(id)}`, request));
      // A failed first read is not a hydrated history receipt. Keep the same ID
      // eligible for GET retries until one valid response has been accepted.
      restoredHydrations.current.delete(id);
    }
    catch (error) {
      if (error instanceof EntryHttpError && error.status === 404) {
        const current = requests.current.get(id);
        if (current) {
          const expired = missingManualEntryExpired(current, Date.now());
          if (expired !== current) publish(expired); else uncertain(id);
        }
      } else uncertain(id);
    } finally { inFlight.current.delete(id); }
  };
  useEffect(() => {
    mounted.current = true;
    const tick = () => { for (const id of requests.current.keys()) void poll(id); };
    tick(); const interval = setInterval(tick, 1_000);
    return () => { mounted.current = false; clearInterval(interval); };
  }, []);

  const start = (opportunityId: string) => {
    const request = createManualEntryRequest(opportunityId);
    if ([...requests.current.values()].some(item => item.base === request.base && manualEntryBlocksBase(item, stateRef.current))) {
      throw new Error(`${request.base} 开仓正在处理或等待核对，不能重复提交`);
    }
    publish(request); inFlight.current.add(request.id);
    void requestReceipt('/positions', request, 'POST', { opportunityId, operationId: request.id, expiresAt: request.expiresAt, acknowledgement: 'OPEN_LIVE_HEDGE' })
      .then(operation => accept(request.id, operation))
      .catch(error => {
        if (error instanceof EntryHttpError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
          const current = requests.current.get(request.id);
          // A structured HTTP rejection applies only before any receipt or committed evidence exists.
          if (current && !current.operation) publish({ ...current, sync: 'connected', operation: {
            id: current.id, opportunityId, state: 'failed', createdAt: current.requestedAt, updatedAt: Date.now(),
            expiresAt: current.expiresAt, leaseExpiresAt: current.expiresAt, ordersSubmitted: false, cancelable: false,
            message: '请求未被接受，未提交订单', error: error.message,
          } });
          else uncertain(request.id);
        } else uncertain(request.id);
      }).finally(() => { inFlight.current.delete(request.id); void poll(request.id); });
  };
  const cancel = async (id: string) => {
    const request = requests.current.get(id);
    if (!request?.operation?.cancelable || request.operation.ordersSubmitted || cancellations.current.has(id)) return;
    cancellations.current.add(id); changed(version => version + 1);
    try { accept(id, await requestReceipt(`/entry-operations/${encodeURIComponent(id)}/cancel`, request, 'POST', {})); }
    catch { uncertain(id); }
    finally { cancellations.current.delete(id); if (mounted.current) changed(version => version + 1); void poll(id); }
  };
  const entries = useMemo(() => [...requests.current.values()], [version]);
  const pendingBases = useMemo(() => new Set(entries.filter(request => manualEntryBlocksBase(request, state)).map(request => request.base)),
    [entries, state?.positions, state?.unconfirmedOrders]);
  return { entries, pendingBases, start, cancel, cancelPending: cancellations.current,
    dismiss: (id: string) => { const request = requests.current.get(id); if (request && !manualEntryBlocksBase(request, state)) publish(id); } };
}
