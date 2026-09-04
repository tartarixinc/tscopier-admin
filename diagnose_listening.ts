import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

const url = process.env.VITE_SUPABASE_URL!;
const key = process.env.VITE_SUPABASE_ANON_KEY!;
const supabase = createClient(url, key);

async function diagnose() {
  const { data: sessions } = await supabase
    .from('telegram_sessions')
    .select('user_id, is_active, phone_number');

  const { data: leases } = await supabase
    .from('worker_session_leases')
    .select('user_id, role, expires_at')
    .gt('expires_at', new Date().toISOString());

  const listeningUserIds = new Set((leases ?? []).map(l => l.user_id));
  const sessionUserIds = new Set((sessions ?? []).map(s => s.user_id));
  const linkedNotListening = [...sessionUserIds].filter(u => !listeningUserIds.has(u));

  if (linkedNotListening.length === 0) {
    console.log('All linked users are listening!');
    return;
  }

  const chunkSize = 20;
  const results: { user_id: string; display_name: string; sub_status: string; copier_paused: boolean; session_active: boolean }[] = [];
  for (let i = 0; i < linkedNotListening.length; i += chunkSize) {
    const chunk = linkedNotListening.slice(i, i + chunkSize);
    const [subs, profiles, sessData] = await Promise.all([
      supabase.from('subscriptions').select('user_id, status').in('user_id', chunk),
      supabase.from('user_profiles').select('user_id, copier_paused, display_name').in('user_id', chunk),
      supabase.from('telegram_sessions').select('user_id, is_active').in('user_id', chunk),
    ]);
    for (const uid of chunk) {
      const sub = (subs.data ?? []).find(s => s.user_id === uid);
      const profile = (profiles.data ?? []).find(p => p.user_id === uid);
      const session = (sessData.data ?? []).find(s => s.user_id === uid);
      results.push({
        user_id: uid,
        display_name: profile?.display_name ?? '—',
        sub_status: sub?.status ?? 'none',
        copier_paused: profile?.copier_paused ?? false,
        session_active: session?.is_active ?? false,
      });
    }
  }

  const reasons: Record<string, number> = {};
  for (const r of results) {
    const flags: string[] = [];
    if (r.sub_status !== 'active' && r.sub_status !== 'trialing') flags.push(`sub=${r.sub_status}`);
    if (r.copier_paused) flags.push('copier_paused');
    if (!r.session_active) flags.push('session_inactive');
    const reason = flags.length > 0 ? flags.join(', ') : 'no_flags';
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }

  console.log(`\n=== ${linkedNotListening.length} users linked but not listening ===\n`);
  console.log('Reason breakdown:');
  for (const [reason, count] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count}x — ${reason}`);
  }
  console.log('\nFirst 25 users:');
  for (const r of results.slice(0, 25)) {
    const flags: string[] = [];
    if (r.sub_status !== 'active' && r.sub_status !== 'trialing') flags.push(`sub:${r.sub_status}`);
    if (r.copier_paused) flags.push('paused');
    if (!r.session_active) flags.push('session_off');
    console.log(`  ${r.display_name.padEnd(35)} ${flags.length > 0 ? flags.join(', ') : 'no flags'}`);
  }
}

diagnose().catch(console.error);
