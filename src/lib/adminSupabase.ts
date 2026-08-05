import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getAdminEnv, ENVIRONMENTS } from './environment';

const env = getAdminEnv();
const config = ENVIRONMENTS[env];

// Single anon client with session — all admin queries use RLS policies that check is_admin()
export const authSupabase: SupabaseClient = createClient(config.url, config.anonKey);

// Alias kept for compatibility; same client instance
export const adminSupabase = authSupabase;

/** Fetch a user_id → display_name map for a list of user IDs. */
export async function fetchDisplayNames(userIds: string[]): Promise<Record<string, string | null>> {
  if (userIds.length === 0) return {};
  const { data } = await authSupabase
    .from('user_profiles')
    .select('user_id, display_name')
    .in('user_id', userIds);
  const map: Record<string, string | null> = {};
  (data ?? []).forEach((r: { user_id: string; display_name: string | null }) => { map[r.user_id] = r.display_name ?? null; });
  return map;
}
