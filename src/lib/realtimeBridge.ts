import { authSupabase } from './adminSupabase';
import { invalidateTags } from './queryCache';

/**
 * One shared Supabase Realtime subscription for the admin dashboard.
 *
 * `trades` and `signals` are the only tables in the project's realtime
 * publication (verified on the prod project). Every other metric is covered
 * by TTL-based background revalidation in the query cache, so this bridge
 * delivers live updates for exactly the tables that can push them — with no
 * polling, and no DB load for the rest.
 */
let started = false;

export function startRealtime(): void {
  if (started) return;
  started = true;

  authSupabase
    .channel('admin-dashboard-realtime')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'trades' }, () => {
      invalidateTags(['trades']);
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'signals' }, () => {
      invalidateTags(['signals']);
    })
    .subscribe((status) => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        started = false;
      }
    });
}

export function stopRealtime(): void {
  if (!started) return;
  started = false;
  for (const ch of authSupabase.getChannels()) {
    if (ch.topic.startsWith('realtime:admin-dashboard-realtime')) {
      void authSupabase.removeChannel(ch);
    }
  }
}
