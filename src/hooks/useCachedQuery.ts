import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cachedQuery, cachedQueryFresh, isCached, readCache, subscribeCache,
  type CacheOptions,
} from '../lib/queryCache';

export interface CachedQueryResult<T> {
  /** Latest known value (cached or freshly fetched), or null before the first load. */
  data: T | null;
  /** True while the very first load for this key is in flight. */
  loading: boolean;
  /** Set when the latest refresh failed (data may still be shown). */
  error: string | null;
  /** True while a background refresh is running. */
  isRefreshing: boolean;
  /** True when the shown data is older than `maxStaleMs` — the view is
   *  waiting on a blocking refresh and should say so. */
  beyondMaxStale: boolean;
  /** Timestamp of the data currently shown, or null if never loaded. */
  lastUpdated: number | null;
  /** Force a background refresh now. */
  refresh: () => void;
}

/**
 * SWR-style cached query:
 * - First mount fetches and shows a skeleton.
 * - Remounts paint instantly from the module cache (no DB hit).
 * - Stale entries refresh in the background without hiding data.
 * - `invalidateTags` (realtime events / manual refresh) marks matching keys
 *   stale, which immediately triggers a background refresh on mounted views.
 * - Data older than `maxStaleMs` blocks on a fresh fetch instead of being
 *   shown silently stale (recovers after sleep/backgrounding).
 */
export function useCachedQuery<T>(
  key: string,
  fn: () => Promise<T>,
  opts: CacheOptions,
): CachedQueryResult<T> {
  const [version, setVersion] = useState(0);
  const [refreshTick, setRefreshTick] = useState(0);
  const [loading, setLoading] = useState(!isCached(key));
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [beyondMaxStale, setBeyondMaxStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const fnRef = useRef(fn);
  const optsRef = useRef(opts);
  const tokenRef = useRef(0);
  const lastTickRef = useRef(refreshTick);
  fnRef.current = fn;
  optsRef.current = opts;

  useEffect(() => subscribeCache(() => setVersion(v => v + 1)), []);

  useEffect(() => {
    const token = ++tokenRef.current;
    const { ttlMs, maxStaleMs } = optsRef.current;
    const cached = readCache<T>(key);
    // Only a manual refresh bumps the tick; a key or cache-version change
    // must not force, or every realtime event would bypass the TTL.
    const forced = refreshTick !== lastTickRef.current;
    lastTickRef.current = refreshTick;

    if (cached) {
      const age = Date.now() - cached.fetchedAt;
      setLoading(false);
      setLastUpdated(cached.fetchedAt || null);
      setError(cached.error);
      setIsRefreshing(age > ttlMs);
      if (maxStaleMs != null && age > maxStaleMs) setBeyondMaxStale(true);
    } else {
      // A new cache key (different user, environment or date range) has no
      // data yet: show the loading state instead of leaving the view blank.
      setLoading(true);
      setError(null);
      setIsRefreshing(false);
      setBeyondMaxStale(false);
      setLastUpdated(null);
    }

    const mustBlock = cached != null
      && maxStaleMs != null
      && Date.now() - cached.fetchedAt > maxStaleMs;
    const query = forced
      ? cachedQuery<T>(key, fnRef.current, optsRef.current, true)
      : mustBlock
        ? cachedQueryFresh<T>(key, fnRef.current, optsRef.current)
        : cachedQuery<T>(key, fnRef.current, optsRef.current);

    query
      .then(() => {
        if (token !== tokenRef.current) return;
        const entry = readCache<T>(key);
        // A background refresh that failed keeps the old rows and stores the
        // error on the entry — read it back so the view can say so.
        setError(entry?.error ?? null);
        setLastUpdated(entry?.fetchedAt ?? Date.now());
        setIsRefreshing(false);
        setBeyondMaxStale(false);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (token !== tokenRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
        setIsRefreshing(false);
        setBeyondMaxStale(false);
      });
  }, [key, version, refreshTick]);

  const refresh = useCallback(() => setRefreshTick(t => t + 1), []);

  const cached = readCache<T>(key);
  return {
    data: cached?.data ?? null,
    loading,
    error,
    isRefreshing,
    beyondMaxStale,
    lastUpdated,
    refresh,
  };
}
