/*
 * Module-level query cache (SWR-style).
 *
 * - Survives navigation: cached rows are served instantly when a page remounts.
 * - Stale-while-revalidate: expired entries are still served while a background
 *   refetch refreshes them, so the UI never flashes skeletons for known data.
 * - Tag-based invalidation: realtime events (or manual refresh) mark every entry
 *   carrying a matching tag as stale, which pushes updates to mounted views.
 * - In-flight dedupe: concurrent requests for the same key share one promise.
 */

export interface CacheOptions {
  ttlMs: number;
  tags?: readonly string[];
  /** Hard staleness cap: data older than this blocks on a fresh fetch
   *  instead of being shown silently stale. Default: no cap. */
  maxStaleMs?: number;
}

interface CacheEntry<T> {
  value: T;
  fetchedAt: number;
  tags: readonly string[];
  ttlMs: number;
  error: string | null;
  inFlight: Promise<T> | null;
}

const store = new Map<string, CacheEntry<unknown>>();
const listeners = new Set<() => void>();
const MAX_ENTRIES = 500;

function notify(): void {
  for (const l of listeners) l();
}

function evictIfNeeded(): void {
  if (store.size <= MAX_ENTRIES) return;
  const keys = [...store.entries()]
    .sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)
    .slice(0, store.size - MAX_ENTRIES)
    .map(([k]) => k);
  for (const k of keys) store.delete(k);
}

export function subscribeCache(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Read the cached entry for a key, if present. */
export function readCache<T>(key: string): { data: T; fetchedAt: number; error: string | null } | null {
  const entry = store.get(key) as CacheEntry<T> | undefined;
  if (!entry) return null;
  return { data: entry.value, fetchedAt: entry.fetchedAt, error: entry.error };
}

export function isFresh(key: string, now = Date.now()): boolean {
  const entry = store.get(key);
  if (!entry) return false;
  return now - entry.fetchedAt <= entry.ttlMs;
}

export function isCached(key: string): boolean {
  return store.has(key);
}

/**
 * Fetch through the cache. Always resolves with the best value currently
 * available:
 * - fresh entry → served instantly, no network.
 * - stale entry → served instantly while a background refetch replaces it.
 * - no entry → fetches and resolves with the network result.
 *
 * `force` marks the entry stale (used by manual refresh buttons) so the
 * background refetch always runs, while mounted views keep showing data.
 */
export function cachedQuery<T>(
  key: string,
  fn: () => Promise<T>,
  opts: CacheOptions,
  force = false,
): Promise<T> {
  const now = Date.now();
  const existing = store.get(key) as CacheEntry<T> | undefined;

  if (existing) {
    const fresh = !force && now - existing.fetchedAt <= existing.ttlMs;
    if (!fresh && !existing.inFlight) {
      existing.inFlight = runFetch(key, existing.value, fn, opts)
        .finally(() => { if (existing) existing.inFlight = null; });
    }
    return Promise.resolve(existing.value);
  }

  const entry: CacheEntry<T> = {
    value: undefined as T,
    fetchedAt: 0,
    tags: opts.tags ?? [],
    ttlMs: opts.ttlMs,
    error: null,
    inFlight: null,
  };
  store.set(key, entry as CacheEntry<unknown>);
  entry.inFlight = runFetch(key, undefined, fn, opts)
    .finally(() => { entry.inFlight = null; });
  return entry.inFlight;
}

async function runFetch<T>(
  key: string,
  previous: T | undefined,
  fn: () => Promise<T>,
  opts: CacheOptions,
): Promise<T> {
  try {
    const value = await fn();
    const entry: CacheEntry<T> = {
      value,
      fetchedAt: Date.now(),
      tags: opts.tags ?? [],
      ttlMs: opts.ttlMs,
      error: null,
      inFlight: null,
    };
    store.set(key, entry as CacheEntry<unknown>);
    evictIfNeeded();
    notify();
    return value;
  } catch (err) {
    const entry = store.get(key) as CacheEntry<T> | undefined;
    if (entry) entry.error = err instanceof Error ? err.message : String(err);
    notify();
    if (previous !== undefined) return previous;
    throw err;
  }
}

/**
 * Mark every cached entry carrying any of the given tags as stale and notify
 * mounted hooks so they revalidate in the background. Realtime event handler.
 */
export function invalidateTags(tags: readonly string[]): void {
  if (tags.length === 0) return;
  let touched = false;
  for (const entry of store.values()) {
    if (entry.tags.some(t => tags.includes(t))) {
      entry.fetchedAt = 0;
      touched = true;
    }
  }
  if (touched) notify();
}

/**
 * Mark every cached entry stale (window focus / tab visibility). Mounted
 * views revalidate immediately in the background; nothing is hidden.
 */
export function invalidateAll(): void {
  let touched = false;
  for (const entry of store.values()) {
    if (entry.fetchedAt !== 0) {
      entry.fetchedAt = 0;
      touched = true;
    }
  }
  if (touched) notify();
}

/**
 * Like `cachedQuery` but blocks on the network when the entry is stale —
 * used when data is older than `maxStaleMs` and showing it would mislead
 * (e.g. after the laptop slept). Fresh entries still resolve instantly;
 * on failure the old value stays readable in the cache and the error
 * propagates to the caller.
 */
export function cachedQueryFresh<T>(
  key: string,
  fn: () => Promise<T>,
  opts: CacheOptions,
): Promise<T> {
  const now = Date.now();
  const existing = store.get(key) as CacheEntry<T> | undefined;
  if (existing && now - existing.fetchedAt <= existing.ttlMs) {
    return Promise.resolve(existing.value);
  }
  if (existing?.inFlight) return existing.inFlight;

  const entry: CacheEntry<T> = {
    value: existing?.value as T,
    fetchedAt: existing?.fetchedAt ?? 0,
    tags: opts.tags ?? [],
    ttlMs: opts.ttlMs,
    error: null,
    inFlight: null,
  };
  store.set(key, entry as CacheEntry<unknown>);
  entry.inFlight = runFetch(key, undefined, fn, opts)
    .finally(() => { entry.inFlight = null; });
  return entry.inFlight;
}

/** Drop every cached entry. Used on logout / env switch. */
export function clearCache(): void {
  if (store.size === 0) return;
  store.clear();
  notify();
}
