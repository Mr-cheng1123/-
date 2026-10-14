/** Only browser display polling is slowed while hidden. Server strategies and
 * per-operation receipt tracking have their own unchanged lifecycle. */
export function displayPollInterval(intervalMs: number): number {
  return typeof document !== 'undefined' && document.hidden ? Math.max(15_000, intervalMs) : intervalMs;
}

export function listenForForeground(refresh: () => void): () => void {
  const onVisibility = () => { if (!document.hidden) refresh(); };
  document.addEventListener('visibilitychange', onVisibility);
  return () => document.removeEventListener('visibilitychange', onVisibility);
}
