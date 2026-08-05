import { useState, useEffect, useCallback } from 'react';

interface UsePaginatedQueryOptions<T> {
  queryFn: (opts: { from: number; to: number }) => Promise<{ data: T[] | null; error: { message: string } | null; count: number | null }>;
  pageSize?: number;
  deps?: unknown[];
}

interface PaginatedResult<T> {
  data: T[];
  loading: boolean;
  error: string | null;
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  goToPage: (p: number) => void;
  setPageSize: (s: number) => void;
  refresh: () => void;
}

export function usePaginatedQuery<T>({
  queryFn,
  pageSize: initialPageSize = 50,
  deps = [],
}: UsePaginatedQueryOptions<T>): PaginatedResult<T> {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState(initialPageSize);
  const [data, setData] = useState<T[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    queryFn({ from, to })
      .then(({ data: rows, error: err, count }: { data: T[] | null; error: { message: string } | null; count: number | null }) => {
        if (cancelled) return;
        if (err) {
          setError(err.message);
        } else {
          setData(rows ?? []);
          setTotalCount(count ?? 0);
        }
        setLoading(false);
      });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, tick, ...deps]);

  const goToPage = useCallback((p: number) => setPage(p), []);

  const setPageSize = useCallback((s: number) => {
    setPageSizeState(s);
    setPage(1);
  }, []);

  const refresh = useCallback(() => setTick(t => t + 1), []);

  return {
    data,
    loading,
    error,
    page,
    pageSize,
    totalCount,
    totalPages: Math.max(1, Math.ceil(totalCount / pageSize)),
    goToPage,
    setPageSize,
    refresh,
  };
}
