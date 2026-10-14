import { useEffect, useState } from 'react';

export function boundedPage(page: number, pageCount: number): number {
  const count = Number.isFinite(pageCount) ? Math.max(1, Math.floor(pageCount)) : 1;
  return Math.min(count, Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1);
}

/** Persist the smaller page after rows disappear, so a later refresh cannot
 * send the reader back to a page that they already left. */
export function useBoundedPage(pageCount: number) {
  const [requestedPage, setPage] = useState(1);
  const page = boundedPage(requestedPage, pageCount);
  useEffect(() => { setPage(previous => boundedPage(previous, pageCount)); }, [pageCount]);
  return [page, setPage] as const;
}
