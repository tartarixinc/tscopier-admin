import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getAdminEnv, ENVIRONMENTS } from './environment';

const env = getAdminEnv();
const config = ENVIRONMENTS[env];

// Single anon client with session — all admin queries use RLS policies that check is_admin()
export const authSupabase: SupabaseClient = createClient(config.url, config.anonKey);

// Alias kept for compatibility; same client instance
export const adminSupabase = authSupabase;

const DISPLAY_NAME_CACHE_TTL_MS = 5 * 60 * 1000;
const DISPLAY_NAME_CHUNK_SIZE = 200;

const displayNameCache = new Map<string, { value: string | null; fetchedAt: number }>();

function chunk<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/** Fetch a user_id → display_name map for a list of user IDs. */
export async function fetchDisplayNames(userIds: string[]): Promise<Record<string, string | null>> {
  const uniqueUserIds = [...new Set(userIds.filter(Boolean))];
  if (uniqueUserIds.length === 0) return {};

  const now = Date.now();
  const map: Record<string, string | null> = {};
  const missing: string[] = [];

  uniqueUserIds.forEach(userId => {
    const cached = displayNameCache.get(userId);
    if (cached && now - cached.fetchedAt < DISPLAY_NAME_CACHE_TTL_MS) {
      map[userId] = cached.value;
    } else {
      missing.push(userId);
    }
  });

  for (const ids of chunk(missing, DISPLAY_NAME_CHUNK_SIZE)) {
    const { data } = await authSupabase
      .from('user_profiles')
      .select('user_id, display_name')
      .in('user_id', ids);

    const returned = new Set<string>();
    (data ?? []).forEach((r: { user_id: string; display_name: string | null }) => {
      returned.add(r.user_id);
      const value = r.display_name ?? null;
      displayNameCache.set(r.user_id, { value, fetchedAt: now });
      map[r.user_id] = value;
    });

    ids.forEach(userId => {
      if (returned.has(userId)) return;
      displayNameCache.set(userId, { value: null, fetchedAt: now });
      map[userId] = null;
    });
  }

  return map;
}
