/*
 * System Encyclopedia — live data layer.
 *
 * Everything here reads the active environment (PROD / STAGING / MIGRATION)
 * through the shared anon client with the admin RLS policies. Only tables the
 * dashboard already reads elsewhere are used, so no new access path is opened.
 *
 * Counting rules (kept identical to SystemHealth where they overlap):
 * - Supabase caps a query at 1000 rows, so every total is an exact head count
 *   (`count: 'exact', head: true`) — never a row-fetch length.
 * - A failed query reports `null` (shown as "—"), never a fabricated 0.
 * - Signal window is the last 24 hours; execution window is the last hour.
 */

import { authSupabase } from './adminSupabase';

export const FLOW_WINDOW_HOURS = 24;
export const EXEC_WINDOW_MINUTES = 60;

/** Observed `signals.status` values (no DB constraint — see the reference entry). */
export const SIGNAL_STATUSES = ['pending', 'parsed', 'executed', 'failed', 'skipped'] as const;
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];

export interface SignalStatusCounts {
  pending: number | null;
  parsed: number | null;
  executed: number | null;
  failed: number | null;
  skipped: number | null;
}

export interface BrokerStatusCounts {
  total: number | null;
  connected: number | null;
  recovering: number | null;
  error: number | null;
}

export interface FlowSnapshot {
  fetchedAt: number;
  signals24h: number | null;
  byStatus: SignalStatusCounts;
  oldestPendingMinutes: number | null;
  dispatchClaims24h: number | null;
  openTrades: number | null;
  closedToday: number | null;
  executionsLastHour: number | null;
  failedExecutionsLastHour: number | null;
  activeLeases: number | null;
  workerReplicas: number | null;
  linkedSessions: number | null;
  brokers: BrokerStatusCounts;
  /** Source labels that failed to read — rendered as a note, never as zeros. */
  unreadable: string[];
}

export interface SignalFeedRow {
  id: string;
  status: string | null;
  created_at: string;
  symbol: string | null;
  action: string | null;
  is_modification: boolean;
}

export interface ExecutionFeedRow {
  id: string;
  action: string | null;
  status: string | null;
  error_message: string | null;
  created_at: string;
}

export interface TradeFeedRow {
  id: string;
  symbol: string;
  direction: string | null;
  status: string | null;
  profit: number | null;
  created_at: string;
}

export type TableCounts = Record<string, number | null>;

async function headCount(
  label: string,
  unreadable: string[],
  fn: () => PromiseLike<{ count: number | null; error: { message: string } | null }>,
): Promise<number | null> {
  const res = await fn();
  if (res.error) {
    unreadable.push(`${label}: ${res.error.message}`);
    return null;
  }
  return res.count ?? 0;
}

/** Local midnight (the same boundary the Overview page uses for "today"). */
function todayStartIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export async function fetchFlowSnapshot(): Promise<FlowSnapshot> {
  const unreadable: string[] = [];
  const now = Date.now();
  const since24h = new Date(now - FLOW_WINDOW_HOURS * 3_600_000).toISOString();
  const sinceExec = new Date(now - EXEC_WINDOW_MINUTES * 60_000).toISOString();
  const nowIso = new Date(now).toISOString();

  const countSignals = (status?: SignalStatus) => {
    let q = authSupabase.from('signals').select('*', { count: 'exact', head: true })
      .gte('created_at', since24h);
    if (status) q = q.eq('status', status);
    return q;
  };

  const [
    signals24h,
    pending,
    parsed,
    executed,
    failed,
    skipped,
    claims24h,
    openTrades,
    closedToday,
    executionsLastHour,
    failedExecLastHour,
    linkedSessions,
    brokerTotal,
    brokerConnected,
    brokerRecovering,
    brokerError,
  ] = await Promise.all([
    headCount('signals (24h)', unreadable, () => countSignals()),
    headCount('signals.pending', unreadable, () => countSignals('pending')),
    headCount('signals.parsed', unreadable, () => countSignals('parsed')),
    headCount('signals.executed', unreadable, () => countSignals('executed')),
    headCount('signals.failed', unreadable, () => countSignals('failed')),
    headCount('signals.skipped', unreadable, () => countSignals('skipped')),
    headCount('signal_broker_dispatch_claims (24h)', unreadable, () =>
      authSupabase.from('signal_broker_dispatch_claims')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', since24h)),
    headCount('trades.open', unreadable, () =>
      authSupabase.from('trades').select('*', { count: 'exact', head: true })
        .eq('status', 'open')),
    headCount('trades.closed today', unreadable, () =>
      authSupabase.from('trades').select('*', { count: 'exact', head: true })
        .eq('status', 'closed')
        .gte('closed_at', todayStartIso())),
    headCount('trade_execution_logs (1h)', unreadable, () =>
      authSupabase.from('trade_execution_logs').select('*', { count: 'exact', head: true })
        .gte('created_at', sinceExec)),
    headCount('trade_execution_logs failed (1h)', unreadable, () =>
      authSupabase.from('trade_execution_logs').select('*', { count: 'exact', head: true })
        .eq('status', 'failed')
        .gte('created_at', sinceExec)),
    headCount('telegram_sessions', unreadable, () =>
      authSupabase.from('telegram_sessions').select('*', { count: 'exact', head: true })
        .eq('is_active', true)),
    headCount('broker_accounts', unreadable, () =>
      authSupabase.from('broker_accounts').select('*', { count: 'exact', head: true })),
    headCount('broker_accounts.connected', unreadable, () =>
      authSupabase.from('broker_accounts').select('*', { count: 'exact', head: true })
        .eq('connection_status', 'connected')),
    headCount('broker_accounts.recovering', unreadable, () =>
      authSupabase.from('broker_accounts').select('*', { count: 'exact', head: true })
        .eq('connection_status', 'recovering')),
    headCount('broker_accounts.error', unreadable, () =>
      authSupabase.from('broker_accounts').select('*', { count: 'exact', head: true })
        .eq('connection_status', 'error')),
  ]);

  // Oldest waiting signal — the queue-lag gauge.
  let oldestPendingMinutes: number | null = null;
  const oldestRes = await authSupabase
    .from('signals')
    .select('created_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1);
  if (oldestRes.error) {
    unreadable.push(`signals.pending.oldest: ${oldestRes.error.message}`);
  } else {
    const createdAt = oldestRes.data?.[0]?.created_at;
    const parsedTs = createdAt ? Date.parse(createdAt) : NaN;
    if (Number.isFinite(parsedTs)) {
      oldestPendingMinutes = Math.max(0, (now - parsedTs) / 60_000);
    }
  }

  // Worker fleet — active (unexpired) leases only, matching Systems Health.
  let activeLeases: number | null = null;
  let workerReplicas: number | null = null;
  const leaseRes = await authSupabase
    .from('worker_session_leases')
    .select('worker_id, expires_at');
  if (leaseRes.error) {
    unreadable.push(`worker_session_leases: ${leaseRes.error.message}`);
  } else {
    const active = (leaseRes.data ?? []).filter(
      l => typeof l.expires_at === 'string' && l.expires_at > nowIso,
    );
    activeLeases = active.length;
    workerReplicas = new Set(active.map(l => l.worker_id)).size;
  }

  return {
    fetchedAt: now,
    signals24h,
    byStatus: { pending, parsed, executed, failed, skipped },
    oldestPendingMinutes,
    dispatchClaims24h: claims24h,
    openTrades,
    closedToday,
    executionsLastHour,
    failedExecutionsLastHour: failedExecLastHour,
    activeLeases,
    workerReplicas,
    linkedSessions,
    brokers: {
      total: brokerTotal,
      connected: brokerConnected,
      recovering: brokerRecovering,
      error: brokerError,
    },
    unreadable,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  const v = record?.[key];
  return typeof v === 'string' && v.trim() ? v : null;
}

export async function fetchRecentSignals(limit = 12): Promise<SignalFeedRow[]> {
  const { data, error } = await authSupabase
    .from('signals')
    .select('id, status, created_at, parsed_data, is_modification')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []).map(row => {
    const parsed = asRecord(row.parsed_data);
    return {
      id: String(row.id),
      status: row.status ?? null,
      created_at: String(row.created_at),
      symbol: readString(parsed, 'symbol') ?? readString(parsed, 'pair'),
      action: readString(parsed, 'action'),
      is_modification: row.is_modification === true,
    };
  });
}

export async function fetchRecentExecutions(limit = 12): Promise<ExecutionFeedRow[]> {
  const { data, error } = await authSupabase
    .from('trade_execution_logs')
    .select('id, action, status, error_message, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []).map(row => ({
    id: String(row.id),
    action: row.action ?? null,
    status: row.status ?? null,
    error_message: row.error_message ?? null,
    created_at: String(row.created_at),
  }));
}

export async function fetchRecentTrades(limit = 12): Promise<TradeFeedRow[]> {
  const { data, error } = await authSupabase
    .from('trades')
    .select('id, symbol, direction, status, profit, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []).map(row => ({
    id: String(row.id),
    symbol: String(row.symbol ?? ''),
    direction: row.direction ?? null,
    status: row.status ?? null,
    profit: row.profit === null || row.profit === undefined ? null : Number(row.profit),
    created_at: String(row.created_at),
  }));
}

/**
 * Tables that carry a row count in the Data tab. Every entry here is a table
 * the dashboard already reads with admin RLS elsewhere, so a count query opens
 * no new access path. `null` means the count could not be read (shown as "—").
 */
export const COUNTED_TABLES: readonly string[] = [
  'signals',
  'trades',
  'trade_execution_logs',
  'signal_broker_dispatch_claims',
  'listener_events',
  'telegram_channels',
  'telegram_sessions',
  'broker_accounts',
  'user_profiles',
  'subscriptions',
  'worker_session_leases',
  'copier_listener_health',
  'signal_queue_dead_letters',
  'backtest_runs',
  'commission_ledger',
  'assistant_threads',
  'trade_reports',
  'channel_signals',
];

export async function fetchTableCounts(): Promise<TableCounts> {
  const entries = await Promise.all(COUNTED_TABLES.map(async table => {
    const { count, error } = await authSupabase
      .from(table)
      .select('*', { count: 'exact', head: true });
    return [table, error ? null : (count ?? 0)] as const;
  }));
  return Object.fromEntries(entries);
}
