import { useEffect, useMemo, useState } from 'react';
import type { AppState, LivePortfolio } from '../../src/shared/types';
import { nextPortfolioTransition } from './portfolio-clock';
import { nextPositionDisplayTransition } from './position-display-deadline';

function useDeadlineClock<T>(data: T, nextTransition: (data: T, now: number) => number | undefined, additionalDeadline?: number) {
  const [revision, setRevision] = useState(0);
  const now = useMemo(() => Date.now(), [data, revision]);
  useEffect(() => {
    const transition = nextTransition(data, now);
    const deadline = Math.min(transition ?? Infinity, Number.isFinite(additionalDeadline) ? additionalDeadline! : Infinity);
    if (!Number.isFinite(deadline)) return;
    const timer = setTimeout(() => setRevision(value => value + 1), Math.min(2_147_483_647, Math.max(1, deadline - Date.now())));
    return () => clearTimeout(timer);
  }, [data, nextTransition, now, additionalDeadline]);
  return now;
}

export const usePositionDisplayClock = (state: AppState, additionalDeadline?: number) => useDeadlineClock(state, nextPositionDisplayTransition, additionalDeadline);
export const usePortfolioDisplayClock = (portfolio: LivePortfolio | undefined) => useDeadlineClock(portfolio, nextPortfolioTransition);

function useSecondClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return now;
}

export function PositionCountdown({ timestamp }: { timestamp: number }) {
  const now = useSecondClock(), seconds = Math.max(0, Math.ceil((timestamp - now) / 1000));
  return <>{Math.floor(seconds / 3600)}:{Math.floor(seconds % 3600 / 60).toString().padStart(2, '0')}:{(seconds % 60).toString().padStart(2, '0')}</>;
}

export function AccountAge({ timestamp }: { timestamp: number }) {
  const now = useSecondClock();
  return <>{Math.max(0, Math.floor((now - timestamp) / 1000))} 秒前</>;
}
