/*
 * Systems Health — Operations Cockpit data layer (plan v2).
 *
 * Verified facts this code relies on (see docs/systems-health-plan.md):
 * - signals has NO updated_at; execution-phase timings live in
 *   trade_execution_logs.request_payload on action='pipeline_summary' rows.
 * - pipeline_ts values are epoch-ms numbers; modern keys since 2026-07-24,
 *   legacy t_* keys mirrored via fallbacks.
 * - Supabase caps queries at 1000 rows server-side: all counts use exact
 *   head-counts; row fetches declare a cap and treat saturation as an
 *   unreliable source.
 * - Dispatch claims are a mutex, not a ledger: deleted on range-wake/retry.
 *   Dispatched is therefore "attempts in window", never a divergence base.
 * - Stuck alarm = parsed beyond grace EXCLUDING range-parked signals.
 */

import { authSupabase } from './adminSupabase';

// ---------------------------------------------------------------------------
// Thresholds — single config spot, tuned after observing real behavior.
// ---------------------------------------------------------------------------

export const HEALTH_THRESHOLDS = {
  pendingStuckWarnMin: 15,
  pendingStuckRedMin: 60,
  pendingStuckRedCount: 10,

  stuckParsedWarnCount: 3,
  stuckParsedGraceMin: 10,

  deadLettersWarn: 1,
  deadLettersFail: 20,

  brokerRecoveringErrorWarnPct: 20,
  telegramListeningGap: 2,

  escalation: {
    minDistinctUsers: 2,
    minOccurrences: 5,
    baselineMultiplier: 5,
    baselineFloor: 1,
  },
} as const;

/** Row caps — a full page marks that source unreliable. */
const SIGNALS_SAMPLE_CAP = 1500;
const PARSED_OLDEST_CAP = 1000;
const CLAIMS_CAP = 20_000;
const PIPELINE_SUMMARY_CAP = 2000;
const RANGE_WAITS_CAP = 5000;
const BROKER_ERROR_KINDS_CAP = 500;
const SESSIONS_CAP = 1000;

export type HealthWindow = 1 | 6 | 24; // hours
export type HealthState = 'ok' | 'warn' | 'fail' | 'unknown';

export interface CheckResult {
  id: string;
  label: string;
  state: HealthState;
  summary: string;
  /** Concrete numbers always visible under the tile. */
  context?: string;
  /** Longer plain-English explanation for hover/expand. */
  detail?: string;
}

export interface LatencyMetric {
  label: string;
  samples: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface TrendPoint {
  /** Bucket start label, e.g. "14:00". */
  label: string;
  received: number;
  tradeable: number;
  executed: number;
  failed: number;
}

export interface FlowBoard {
  reliable: boolean;
  received: number;
  tradeable: number;
  dispatchedAttempts: number;
  executed: number;
  failed: number;
  filteredOut: number;
  pendingInFlight: number;
  oldestPendingMinutes: number | null;
  stuckParsedCount: number;
  latencies: LatencyMetric[];
  /** Per-bucket signal counts over the window (for the trend chart). */
  trend: TrendPoint[];
}

export interface FleetRow {
  workerId: string;
  rolePrefix: string;
  shardId: number | null;
  shardCount: number | null;
  instanceId: string;
  buildTag: string;
  leases: number;
  lastHeartbeatAgeSec: number | null;
}

export interface TelegramPanel {
  reliable: boolean;
  linked: number;
  listeningNow: number;
  /** Lease-based count (a process holds the account) — kept for transparency. */
  listeningLeases: number;
  /**
   * True when `copier_listener_health` is reporting enough fresh rows to trust
   * it. When false, `listeningNow` falls back to the weaker lease signal.
   */
  healthReporting: boolean;
  /** True when `listeningNow` reflects real live connectivity, false when it
   *  is only a lease proxy (health source not reporting yet). */
  truthful: boolean;
  authPending: number;
  linkedNotListeningUsers: string[];
}

export interface BrokerPanel {
  reliable: boolean;
  connected: number;
  recovering: number;
  error: number;
  topErrorKinds: Array<{ kind: string; count: number }>;
}

/** Summary of Railway deployment logs (worker/realtime health), read via edge fn. */
export interface RailwayHealth {
  available: boolean;
  minutes: number;
  logLines: number;
  realtimeFailures: number;
  realtimeSubscribed: number;
  rateLimitWarnings: number;
  workerFatal: number;
  workerRestarts: number;
  uncaughtExceptions: number;
  state: 'healthy' | 'degraded' | 'storm' | 'worker_down';
  topErrorSignatures: Array<{ message: string; count: number }>;
  error?: string;
}

/** One individual failing execution within a bucket (for the drill-down modal). */
export interface ErrorBucketRow {
  id: string;
  userId: string | null;
  createdAt: string | null;
  action: string | null;
  errorMessage: string | null;
  brokerAccountId: string | null;
  signalId: string | null;
  requestPayload: unknown;
  responsePayload: unknown;
}

export interface ErrorBucketSummary {
  bucket: 'system' | 'external' | 'user' | 'unclassified';
  reasonCode: string;
  count: number;
  distinctUsers: number;
  escalated: boolean;
  /** The individual failures behind the aggregate, newest first. */
  rows: ErrorBucketRow[];
}

export interface SystemHealthReport {
  windowHours: HealthWindow;
  fetchedAt: number;
  clockOffsetMs: number;
  checks: CheckResult[];
  flow: FlowBoard;
  fleet: FleetRow[];
  shardConsistent: boolean;
  activeLeases: number;
  telegram: TelegramPanel;
  brokers: BrokerPanel;
  railway: RailwayHealth;
  errorBuckets: ErrorBucketSummary[];
  /** Average total failed executions per window over the previous 7 days — the "usual rate" every bucket is compared against. */
  failureBaselinePerWindow: number;
  deadLettersOpen: number;
  unreadableSources: string[];
  dbReachable: boolean;
}

// ---------------------------------------------------------------------------
// Ownership classification
// ---------------------------------------------------------------------------

// Bucket classification aligned with the worker's full reason-code taxonomy
// (worker/src/brokerTradeError.ts + management/queue/reconcile failure paths).
// 'user'  = that user's account/config situation (their fix, no alarm).
// 'external' = broker/market side outage (only escalates when widespread).
// 'system' = our infra/pipeline failed (always counts toward health).
// Unknown codes stay 'unclassified' — surfaced for review, never folded into
// system alarms, and never silently treated as user noise.

const USER_BUCKET_CODES = new Set([
  'INSUFFICIENT_MARGIN',
  'INVALID_LOT',
  'INVALID_STOPS',
]);

const EXTERNAL_BUCKET_CODES = new Set([
  'MARKET_CLOSED',
  'BROKER_RATE_LIMITED',
  // Broker-side "position/ticket not found" on a management op — broker state
  // diverged from ours (recurring incident class). External, but worth review.
  'UNKNOWN_TICKET',
  'BROKER_EA_NOT_READY',
]);

/** Broker rejected the order but the specific reason was unrecognized. */
const BROKER_AMBI_CODES = new Set(['BROKER_ORDER_REJECTED', 'BROKER_SYMBOL_NOT_FOUND', 'SYMBOL_UNSUPPORTED']);

const SYSTEM_BUCKET_CODES = new Set([
  'BROKER_TIMEOUT',
  'BROKER_ACCOUNT_UNAVAILABLE',
  'QUEUE_DEAD_LETTER',
  'QUEUE_MALFORMED_PAYLOAD',
  'QUEUE_READ_FAILURE',
  'QUEUE_RECLAIM_FAILURE',
  'TRADE_WORKER_PUSH_FAILED',
  'COPIER_ENGINE_OFFLINE',
  'NO_ELIGIBLE_BROKER_ACCOUNT',
  // DB/persistence + follow-up failures (worker-side, our infra).
  'BASKET_RECONCILE_ENQUEUE_FAILED',
  'BASKET_TP_SYNC_FAILED',
  'BASKET_TP_SYNC_FINAL_FAILURE',
  'BROKER_PENDING_FILL_DB_FAILURE',
  'BROKER_PENDING_FILL_FOLLOW_UP_FAILED',
  'BROKER_PENDING_FILL_RECONCILE_ENQUEUE_FAILED',
  'BROKER_PENDING_FILL_STOPS_ASSIGN_FAILED',
  'BROKER_PENDING_FILL_TP_REBALANCE_FAILED',
  'BROKER_PENDING_MATERIALIZATION_FAILED',
  'BROKER_PENDING_MATERIALIZATION_PERSIST_FAILED',
  'BROKER_PENDING_MISSING',
  'BROKER_SUCCESS_DB_FAILURE',
  'DEFERRED_VIRTUAL_MATERIALIZATION_PERSIST_FAILED',
  'LAYERING_FIRST_FILL_ACTIVATION_FAILED',
  'MANAGEMENT_MODIFY_PARTIAL',
  'MGMT_CLOSE_CLEANUP_FAILED',
  'OPEN_TRADE_RECONCILE_FAILED',
  'PARTIAL_MULTI_ACCOUNT_EXECUTION',
  'POST_FILL_FOLLOW_UP_FAILED',
  'RANGE_LEG_FIRE_FAILED',
  'RANGE_LEG_POST_NAKED_STOPS_FAILED',
  'RANGE_LEG_REANCHOR_FAILED',
  'RANGE_LEG_SL_TP_FOLLOW_UP_FAILED',
  'RANGE_LEG_TP_REBALANCE_FAILED',
  'VIRTUAL_MATERIALIZATION_FAILED',
  'VIRTUAL_MATERIALIZATION_PERSIST_FAILED',
]);

function classifyReason(code: string): ErrorBucketSummary['bucket'] {
  if (!code || code === 'UNCLASSIFIED') return 'unclassified';
  if (USER_BUCKET_CODES.has(code)) return 'user';
  if (EXTERNAL_BUCKET_CODES.has(code)) return 'external';
  if (SYSTEM_BUCKET_CODES.has(code)) return 'system';
  // Ambiguous broker rejections: treat as external-with-review (not user noise,
  // not hard system alarm) so they surface in the details table but don't
  // single-handedly redden the page.
  if (BROKER_AMBI_CODES.has(code)) return 'external';
  return 'unclassified';
}

/** Local port of worker classifyBrokerFailureReason (businessEvents.ts). */
function classifyBrokerFailureReason(message: string): string {
  const lower = String(message ?? '').toLowerCase();
  if (/margin|not enough money|insufficient funds/.test(lower)) return 'INSUFFICIENT_MARGIN';
  if (/market.*closed|off quotes|trade disabled/.test(lower)) return 'MARKET_CLOSED';
  if (/invalid volume|lot|minimum volume|min lot/.test(lower)) return 'INVALID_LOT';
  if (/symbolselect/.test(lower)
    || (/symbol|instrument/.test(lower) && /not found|unknown|disabled|unsupported|invalid|select\s+failed/.test(lower))) {
    return 'BROKER_SYMBOL_NOT_FOUND';
  }
  if (/timeout|timed out|operation timeout/.test(lower)) return 'BROKER_TIMEOUT';
  if (/not connected|disconnected|session|auth|unauthorized|forbidden|invalid api/.test(lower)) return 'BROKER_ACCOUNT_UNAVAILABLE';
  if (/rate limit|too many requests/.test(lower)) return 'BROKER_RATE_LIMITED';
  // Known broker rejection texts observed in production failures:
  if (/unknown ticket/.test(lower)) return 'UNKNOWN_TICKET'; // broker can't find the position to manage
  if (/invalid stops|invalid stop|stop loss.*invalid|invalid sl/.test(lower)) return 'INVALID_STOPS';
  if (/ea not ready|not ready to (execute|trade)|cannot execute trades/.test(lower)) return 'BROKER_EA_NOT_READY';
  return 'UNCLASSIFIED';
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

async function headCount(
  label: string,
  unreadable: string[],
  fn: () => PromiseLike<{ count: number | null; error: { message: string } | null }>,
): Promise<number | null> {
  const res = await fn();
  if (res.error) {
    const msg = res.error.message?.trim() || 'query failed';
    unreadable.push(`${label}: ${msg}`);
    return null;
  }
  return res.count ?? 0;
}

interface RowError { message: string }

async function fetchRows<T>(
  label: string,
  unreadable: string[],
  fn: () => PromiseLike<{ data: T[] | null; error: RowError | null }>,
  cap?: number,
): Promise<T[] | null> {
  const res = await fn();
  if (res.error) {
    unreadable.push(`${label}: ${res.error.message}`);
    return null;
  }
  const rows = res.data ?? [];
  if (cap != null && rows.length >= cap) {
    unreadable.push(`${label}: window exceeds ${cap}-row query cap — counts unreliable, try a shorter window`);
    return null;
  }
  return rows;
}

function tsPoint(pipelineTs: unknown, key: string): number | null {
  const v = (pipelineTs as Record<string, unknown> | null)?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** First defined value along the fallback chain. */
function tsChain(pipelineTs: unknown, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = tsPoint(pipelineTs, k);
    if (v != null) return v;
  }
  return null;
}

function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

/**
 * Defensive worker_id parse. Format `<prefix>:<shard>:<instance...>:<buildTag>`
 * where instance may contain colons (`hostname:pid`), so segment count varies.
 */
function parseWorkerId(raw: string): Omit<FleetRow, 'leases' | 'lastHeartbeatAgeSec'> {
  const parts = raw.split(':');
  const shardId = Number.isFinite(Number(parts[1])) ? Number(parts[1]) : null;
  const buildTag = parts.length > 2 ? parts[parts.length - 1] : '';
  const instanceId = parts.length > 3 ? parts.slice(2, -1).join(':') : parts[2] ?? '';
  return {
    workerId: raw,
    rolePrefix: parts[0] ?? raw,
    shardId,
    shardCount: null,
    instanceId,
    buildTag,
  };
}

// ---------------------------------------------------------------------------
// Main report builder
// ---------------------------------------------------------------------------

export async function fetchSystemHealth(windowHours: HealthWindow): Promise<SystemHealthReport> {
  const unreadableSources: string[] = [];

  // --- Clock offset proxy: freshest worker heartbeat vs local clock.
  let dbNowMs = NaN;
  const leaseClockRows = await fetchRows<{ updated_at: string | null }>(
    'clock probe',
    unreadableSources,
    () => authSupabase.from('worker_session_leases').select('updated_at').order('updated_at', { ascending: false }).limit(1),
  );
  const leaseTs = leaseClockRows?.[0]?.updated_at ? Date.parse(leaseClockRows[0].updated_at) : NaN;
  if (Number.isFinite(leaseTs)) dbNowMs = leaseTs;
  else {
    const healthRows = await fetchRows<{ updated_at: string | null }>(
      'clock probe (listener health)',
      unreadableSources,
      () => authSupabase.from('copier_listener_health').select('updated_at').order('updated_at', { ascending: false }).limit(1),
    );
    const h = healthRows?.[0]?.updated_at ? Date.parse(healthRows[0].updated_at) : NaN;
    if (Number.isFinite(h)) dbNowMs = h;
  }
  const clockOffsetMs = Number.isFinite(dbNowMs) ? Math.min(Math.max(Date.now() - dbNowMs, -120_000), 120_000) : 0;
  const serverNowMs = Date.now() - clockOffsetMs;

  const windowStartMs = serverNowMs - windowHours * 3_600_000;
  const sinceIso = new Date(windowStartMs).toISOString();
  const nowIso = new Date(serverNowMs).toISOString();

  // --- Worker fleet + active copier leases. Use the table's real role/shard
  // columns (not the worker_id string) — instance ids can contain colons.
  interface LeaseRow {
    user_id: string;
    worker_id: string;
    role: string | null;
    shard_id: number | null;
    shard_count: number | null;
    expires_at: string | null;
    updated_at: string | null;
  }
  const leases = await fetchRows<LeaseRow>(
    'worker_session_leases',
    unreadableSources,
    () => authSupabase.from('worker_session_leases').select('user_id, worker_id, role, shard_id, shard_count, expires_at, updated_at'),
  );
  const activeLeases = (leases ?? []).filter(l => l.expires_at != null && l.expires_at > nowIso);
  const fleetMap = new Map<string, FleetRow>();
  for (const l of activeLeases) {
    const base = parseWorkerId(l.worker_id);
    const entry = fleetMap.get(l.worker_id) ?? {
      ...base,
      rolePrefix: l.role ?? base.rolePrefix,
      shardId: l.shard_id ?? base.shardId,
      shardCount: l.shard_count ?? null,
      leases: 0,
      lastHeartbeatAgeSec: null,
    };
    entry.leases += 1;
    const age = l.updated_at ? Math.max(0, (serverNowMs - Date.parse(l.updated_at)) / 1000) : null;
    if (age != null && (entry.lastHeartbeatAgeSec == null || age < entry.lastHeartbeatAgeSec)) entry.lastHeartbeatAgeSec = age;
    fleetMap.set(l.worker_id, entry);
  }
  const fleet = [...fleetMap.values()].sort((a, b) => b.leases - a.leases);
  // Shard-consistency proxy: replicas must agree on shard_count.
  const distinctShardTotals = new Set(activeLeases.map(l => l.shard_count ?? -1));
  const shardConsistent = distinctShardTotals.size <= 1;
  const listeningUserIds = new Set(activeLeases.map(l => l.user_id));

  // --- Flow board head-counts (exact, zero rows).
  const countIn = async (label: string, statusFilter: string[] | null): Promise<number | null> => {
    let q = authSupabase.from('signals').select('id', { count: 'exact', head: true }).gte('created_at', sinceIso);
    if (statusFilter) q = q.in('status', statusFilter);
    return headCount(label, unreadableSources, () => q);
  };
  const [received, tradeable, executed, failed, skipped, pending] = await Promise.all([
    countIn('signals.received', null),
    countIn('signals.tradeable', ['parsed', 'executed', 'failed']),
    countIn('signals.executed', ['executed']),
    countIn('signals.failed', ['failed']),
    countIn('signals.skipped', ['skipped']),
    countIn('signals.pending', ['pending']),
  ]);

  // Oldest pending signal.
  interface PendingRow { created_at: string }
  const oldestPendingRows = await fetchRows<PendingRow>(
    'signals.pending.oldest',
    unreadableSources,
    () => authSupabase.from('signals').select('created_at').eq('status', 'pending').order('created_at', { ascending: true }).limit(1),
  );
  const oldestPendingMinutes = oldestPendingRows?.[0]?.created_at
    ? Math.max(0, (serverNowMs - Date.parse(oldestPendingRows[0].created_at)) / 60_000)
    : null;

  // --- Stuck-parsed alarm inputs: parsed signals WITHIN the selected window
  // (not all history) older than grace, excluding range-parked signals
  // (claims are released by design there).
  const graceCutoffIso = new Date(serverNowMs - HEALTH_THRESHOLDS.stuckParsedGraceMin * 60_000).toISOString();
  interface ParsedOldRow { id: string }
  const parsedOldRows = await fetchRows<ParsedOldRow>(
    'signals.parsed.old',
    unreadableSources,
    () => authSupabase
      .from('signals')
      .select('id')
      .eq('status', 'parsed')
      .gte('created_at', sinceIso)
      .lte('created_at', graceCutoffIso)
      .order('created_at', { ascending: true })
      .limit(PARSED_OLDEST_CAP),
  );
  interface WaitRow { signal_id: string }
  const waitingRows = await fetchRows<WaitRow>(
    'signal_range_entry_waits',
    unreadableSources,
    () => authSupabase.from('signal_range_entry_waits').select('signal_id').eq('status', 'waiting').limit(RANGE_WAITS_CAP),
  );
  const waitingIds = new Set((waitingRows ?? []).map(w => w.signal_id));
  const stuckParsedCount = (parsedOldRows ?? []).filter(r => !waitingIds.has(r.id)).length;

  // --- Dispatch attempts: distinct claim signal_ids created in window.
  interface ClaimRow { signal_id: string }
  const claims = await fetchRows<ClaimRow>(
    'signal_broker_dispatch_claims',
    unreadableSources,
    () => authSupabase
      .from('signal_broker_dispatch_claims')
      .select('signal_id, created_at')
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: true })
      .limit(CLAIMS_CAP),
    CLAIMS_CAP,
  );
  const dispatchedAttempts = new Set((claims ?? []).map(c => c.signal_id)).size;

  // --- Latency samples from signals.pipeline_ts (listener phase only).
  interface TsRow { pipeline_ts: unknown }
  const tsRows = await fetchRows<TsRow>(
    'signals.latency-sample',
    unreadableSources,
    () => authSupabase
      .from('signals')
      .select('pipeline_ts')
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(SIGNALS_SAMPLE_CAP),
    SIGNALS_SAMPLE_CAP,
  );
  const parseSamples: number[] = [];
  const handoffSamples: number[] = [];
  for (const row of tsRows ?? []) {
    const parseEnd = tsChain(row.pipeline_ts, 'parse_completed_at', 't_parse_done', 't_ai_parse_done');
    const parseStart = tsChain(row.pipeline_ts, 'parse_started_at', 'telegram_message_received_at');
    if (parseEnd != null && parseStart != null && parseEnd >= parseStart) parseSamples.push(parseEnd - parseStart);
    const dispatchStart = tsChain(row.pipeline_ts, 't_dispatch_sent', 'queue_published_at');
    const consumed = tsPoint(row.pipeline_ts, 'queue_consumed_at');
    if (consumed != null && dispatchStart != null && consumed >= dispatchStart) handoffSamples.push(consumed - dispatchStart);
  }
  parseSamples.sort((a, b) => a - b);
  handoffSamples.sort((a, b) => a - b);

  // --- End-to-end latency from pipeline_summary log rows.
  interface SummaryRow { total_ms: string | null }
  const summaryRows = await fetchRows<SummaryRow>(
    'trade_execution_logs.pipeline_summary',
    unreadableSources,
    () => authSupabase
      .from('trade_execution_logs')
      .select('total_ms:request_payload->>total_ms')
      .eq('action', 'pipeline_summary')
      .gte('created_at', sinceIso)
      .limit(PIPELINE_SUMMARY_CAP),
    PIPELINE_SUMMARY_CAP,
  );
  const e2eSamples = (summaryRows ?? [])
    .map(r => Number(r.total_ms))
    .filter(v => Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);

  const latencies: LatencyMetric[] = [
    { label: 'Parse', samples: parseSamples.length, p50Ms: percentile(parseSamples, 50), p95Ms: percentile(parseSamples, 95) },
    { label: 'Dispatch handoff', samples: handoffSamples.length, p50Ms: percentile(handoffSamples, 50), p95Ms: percentile(handoffSamples, 95) },
    { label: 'End-to-end', samples: e2eSamples.length, p50Ms: percentile(e2eSamples, 50), p95Ms: percentile(e2eSamples, 95) },
  ];

  // --- Hourly trend buckets for the chart (bounded tiny-column fetch).
  interface TrendRow { status: string | null; created_at: string }
  const trendRows = await fetchRows<TrendRow>(
    'signals.trend',
    unreadableSources,
    () => authSupabase
      .from('signals')
      .select('status,created_at')
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(3000),
    3000,
  );
  const bucketMs = windowHours <= 1 ? 5 * 60_000 : windowHours <= 6 ? 30 * 60_000 : 60 * 60_000;
  const trend: TrendPoint[] = [];
  if (Array.isArray(trendRows)) {
    const lastBucketStart = Math.floor(serverNowMs / bucketMs) * bucketMs;
    const bucketCount = Math.ceil((serverNowMs - windowStartMs) / bucketMs);
    for (let i = bucketCount - 1; i >= 0; i -= 1) {
      const start = lastBucketStart - i * bucketMs;
      const dt = new Date(start);
      trend.push({
        label: `${String(dt.getUTCHours()).padStart(2, '0')}:${String(Math.floor(dt.getUTCMinutes() / 5) * 5).padStart(2, '0')}`,
        received: 0,
        tradeable: 0,
        executed: 0,
        failed: 0,
      });
    }
    for (const r of trendRows) {
      const t = Date.parse(r.created_at);
      if (!Number.isFinite(t) || t < windowStartMs) continue;
      const idx = Math.floor((t - windowStartMs) / bucketMs);
      const point = trend[Math.max(0, Math.min(trend.length - 1, trend.length - 1 - idx))];
      if (!point) continue;
      point.received += 1;
      const status = (r.status ?? '').toLowerCase();
      if (status === 'parsed' || status === 'executed' || status === 'failed') point.tradeable += 1;
      if (status === 'executed') point.executed += 1;
      if (status === 'failed') point.failed += 1;
    }
  }

  const flowReliable =
    received != null && tradeable != null && executed != null && failed != null
    && skipped != null && pending != null && claims != null;

  const flow: FlowBoard = {
    reliable: flowReliable,
    received: received ?? 0,
    tradeable: tradeable ?? 0,
    dispatchedAttempts,
    executed: executed ?? 0,
    failed: failed ?? 0,
    filteredOut: skipped ?? 0,
    pendingInFlight: pending ?? 0,
    oldestPendingMinutes,
    stuckParsedCount,
    latencies,
    trend: Array.isArray(trendRows) ? trend : [],
  };

  // --- Telegram panel.
  interface SessionRow { user_id: string }
  const sessions = await fetchRows<SessionRow>(
    'telegram_sessions',
    unreadableSources,
    () => authSupabase.from('telegram_sessions').select('user_id').limit(SESSIONS_CAP),
    SESSIONS_CAP,
  );
  const sessionUserIds = new Set((sessions ?? []).map(s => s.user_id));
  // Auth-pending is a worker-only table with no admin SELECT policy, so this is
  // best-effort: a failure must NOT count as an unreadable source (that would
  // permanently force the "cannot determine" verdict). It just shows 0.
  let authPendingCount = 0;
  const authPendingRes = await authSupabase
    .from('telegram_auth_pending')
    .select('user_id', { count: 'exact', head: true })
    .gt('expires_at', nowIso);
  if (!authPendingRes.error) authPendingCount = authPendingRes.count ?? 0;

  // --- Live-connectivity truth signal (copier_listener_health).
  // Preferred when the worker actually reports: a user only counts as genuinely
  // "listening" when their row says connected + mtproto_connected + fresh.
  // Fall back to the weaker lease signal when the table is empty or unreadable
  // (e.g. before the health writer is deployed) so we never invent an outage
  // from missing data.
  interface HealthRow {
    user_id: string;
    listener_status: string | null;
    mtproto_connected: boolean | null;
    worker_ownership_status: string | null;
    updated_at: string | null;
    last_successful_probe_at: string | null;
    freshness_threshold_ms: number | null;
  }
  const healthRows = await fetchRows<HealthRow>(
    'listener_health',
    unreadableSources,
    () => authSupabase.from('copier_listener_health')
      .select('user_id, listener_status, mtproto_connected, worker_ownership_status, updated_at, last_successful_probe_at, freshness_threshold_ms'),
  );
  const healthLive = new Set<string>();
  const healthReportingUsers = new Set<string>();
  for (const h of healthRows ?? []) {
    const updatedMs = h.updated_at ? Date.parse(h.updated_at) : NaN;
    const probeMs = h.last_successful_probe_at ? Date.parse(h.last_successful_probe_at) : NaN;
    const updatedFresh = Number.isFinite(updatedMs) ? serverNowMs - updatedMs : null;
    const threshold = Number.isFinite(h.freshness_threshold_ms as number) && (h.freshness_threshold_ms as number) > 0
      ? Math.max(1_000, Math.min(10 * 60_000, Math.floor(h.freshness_threshold_ms as number)))
      : 90_000;
    const rowIsReporting = updatedFresh != null && updatedFresh <= threshold;
    if (rowIsReporting) healthReportingUsers.add(h.user_id);
    const probeFresh = Number.isFinite(probeMs) ? serverNowMs - probeMs <= threshold : false;
    if (h.listener_status === 'connected' && h.mtproto_connected === true && rowIsReporting && probeFresh) {
      healthLive.add(h.user_id);
    }
  }
  const healthReadable = !unreadableSources.includes('listener_health');
  // Trust the truth table only when it is readable AND at least one user is
  // actively reporting a fresh row. Otherwise fall back to leases.
  const useHealth = healthReadable && healthReportingUsers.size > 0;

  // Effective "listening" set: live-health rows when available, else active leases.
  const effectiveListening =
    useHealth
      ? [...healthLive].filter(u => sessionUserIds.has(u))
      : [...listeningUserIds].filter(u => sessionUserIds.has(u));
  const listeningLeases = [...listeningUserIds].filter(u => sessionUserIds.has(u)).length;
  const linkedNotListeningUsers = [...sessionUserIds].filter(u => !new Set(effectiveListening).has(u));
  const telegram: TelegramPanel = {
    reliable: sessions != null && activeLeases != null,
    linked: sessionUserIds.size,
    listeningNow: effectiveListening.length,
    listeningLeases,
    healthReporting: useHealth,
    truthful: useHealth,
    authPending: authPendingCount,
    linkedNotListeningUsers,
  };

  // --- Broker connection mix.
  const [connected, recovering, errored] = await Promise.all([
    headCount('broker_accounts.connected', unreadableSources,
      () => authSupabase.from('broker_accounts').select('id', { count: 'exact', head: true }).eq('connection_status', 'connected')),
    headCount('broker_accounts.recovering', unreadableSources,
      () => authSupabase.from('broker_accounts').select('id', { count: 'exact', head: true }).eq('connection_status', 'recovering')),
    headCount('broker_accounts.error', unreadableSources,
      () => authSupabase.from('broker_accounts').select('id', { count: 'exact', head: true }).eq('connection_status', 'error')),
  ]);
  interface BrokerErrRow { connection_error_kind: string | null }
  const brokerErrRows = await fetchRows<BrokerErrRow>(
    'broker_accounts.errors',
    unreadableSources,
    () => authSupabase.from('broker_accounts').select('connection_error_kind').eq('connection_status', 'error').limit(BROKER_ERROR_KINDS_CAP),
  );
  const kindMap = new Map<string, number>();
  for (const r of brokerErrRows ?? []) {
    const kind = r.connection_error_kind || 'unspecified';
    kindMap.set(kind, (kindMap.get(kind) ?? 0) + 1);
  }
  const brokers: BrokerPanel = {
    reliable: connected != null && recovering != null && errored != null,
    connected: connected ?? 0,
    recovering: recovering ?? 0,
    error: errored ?? 0,
    topErrorKinds: [...kindMap.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
  };

  // --- Dead letters.
  const deadLettersOpen = (await headCount(
    'signal_queue_dead_letters',
    unreadableSources,
    () => authSupabase.from('signal_queue_dead_letters').select('id', { count: 'exact', head: true }).is('replayed_at', null),
  )) ?? 0;

  // --- Execution failure buckets.
  interface ExecLogRow {
    id: string;
    user_id: string | null;
    status: string | null;
    action: string | null;
    error_message: string | null;
    broker_account_id: string | null;
    signal_id: string | null;
    request_payload: unknown;
    response_payload: unknown;
    created_at: string | null;
  }
  const execLogs = await fetchRows<ExecLogRow>(
    'trade_execution_logs.failures',
    unreadableSources,
    () => authSupabase
      .from('trade_execution_logs')
      .select('id, user_id, status, action, error_message, broker_account_id, signal_id, request_payload, response_payload, created_at')
      .eq('status', 'failed')
      .gte('created_at', sinceIso)
      .limit(3000),
    3000,
  );
  const bucketAgg = new Map<string, { count: number; users: Set<string>; rows: ErrorBucketRow[] }>();
  for (const log of execLogs ?? []) {
    // Worker writes reason_code into request_payload (not response_payload).
    const payloadCode = (log.request_payload as Record<string, unknown> | null)?.reason_code;
    const code = typeof payloadCode === 'string' && payloadCode
      ? payloadCode.toUpperCase()
      : classifyBrokerFailureReason(log.error_message ?? '');
    const bucket = classifyReason(code);
    const key = `${bucket}:${code}`;
    const agg = bucketAgg.get(key) ?? { count: 0, users: new Set<string>(), rows: [] };
    agg.count += 1;
    if (log.user_id) agg.users.add(log.user_id);
    agg.rows.push({
      id: log.id,
      userId: log.user_id,
      createdAt: log.created_at,
      action: log.action,
      errorMessage: log.error_message,
      brokerAccountId: log.broker_account_id,
      signalId: log.signal_id,
      requestPayload: log.request_payload,
      responsePayload: log.response_payload,
    });
    bucketAgg.set(key, agg);
  }
  const errorBuckets: ErrorBucketSummary[] = [...bucketAgg.entries()].map(([key, agg]) => {
    const [bucket, reasonCode] = key.split(':') as [ErrorBucketSummary['bucket'], string];
    agg.rows.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    return { bucket, reasonCode, count: agg.count, distinctUsers: agg.users.size, escalated: false, rows: agg.rows };
  });

  const baselineSince = new Date(serverNowMs - (7 * 24 + windowHours) * 3_600_000).toISOString();
  const baselineUntil = new Date(serverNowMs - windowHours * 3_600_000).toISOString();
  const baselineRes = await authSupabase
    .from('trade_execution_logs')
    .select('status', { count: 'exact', head: true })
    .eq('status', 'failed')
    .gte('created_at', baselineSince)
    .lt('created_at', baselineUntil);
  if (baselineRes.error) unreadableSources.push(`execution baseline: ${baselineRes.error.message}`);
  const baselineTotal = baselineRes.count ?? 0;
  const baselinePerWindow = baselineTotal / ((7 * 24) / windowHours);

  const esc = HEALTH_THRESHOLDS.escalation;
  for (const e of errorBuckets) {
    const flooredBaseline = Math.max(baselinePerWindow, esc.baselineFloor);
    e.escalated =
      e.distinctUsers >= esc.minDistinctUsers &&
      e.count >= esc.minOccurrences &&
      e.count > esc.baselineMultiplier * flooredBaseline;
  }

  const dbReachable = unreadableSources.length === 0;

  const railway = await fetchRailwayHealth(windowHours);

  const checks = buildChecks({
    unreadableSources, serverNowMs, activeLeases: activeLeases.length,
    shardConsistent, fleet, telegram, brokers, flow, deadLettersOpen, errorBuckets, railway,
    windowHours,
  });

  return {
    windowHours,
    fetchedAt: Date.now(),
    clockOffsetMs,
    checks,
    flow,
    fleet,
    shardConsistent,
    activeLeases: activeLeases.length,
    telegram,
    brokers,
    railway,
    errorBuckets,
    failureBaselinePerWindow: baselinePerWindow,
    deadLettersOpen,
    unreadableSources,
    dbReachable,
  };
}

/**
 * Read Railway deployment logs via the systems-health-railway edge function.
 * Best-effort: if the function/secret is unavailable the panel reports
 * `available:false` rather than failing the whole report.
 */
async function fetchRailwayHealth(windowHours: HealthWindow): Promise<RailwayHealth> {
  try {
    const { data, error } = await authSupabase.functions.invoke('systems-health-railway', {
      body: { minutes: windowHours * 60 },
    });
    if (error || !data || typeof data !== 'object' || data.health == null) {
      return { available: false, minutes: windowHours * 60, logLines: 0, realtimeFailures: 0, realtimeSubscribed: 0, rateLimitWarnings: 0, workerFatal: 0, workerRestarts: 0, uncaughtExceptions: 0, state: 'healthy', topErrorSignatures: [], error: data?.error ?? error?.message ?? 'Railway panel unavailable' };
    }
    const h = data.health as Record<string, unknown>;
    return {
      available: true,
      minutes: Number(data.minutes ?? windowHours * 60),
      logLines: Number(data.logLines ?? 0),
      realtimeFailures: Number(h.realtimeFailures ?? 0),
      realtimeSubscribed: Number(h.realtimeSubscribed ?? 0),
      rateLimitWarnings: Number(h.rateLimitWarnings ?? 0),
      workerFatal: Number(h.workerFatal ?? 0),
      workerRestarts: Number(h.workerRestarts ?? 0),
      uncaughtExceptions: Number(h.uncaughtExceptions ?? 0),
      state: (data.state as RailwayHealth['state']) ?? 'healthy',
      topErrorSignatures: Array.isArray(h.topErrorSignatures) ? h.topErrorSignatures as RailwayHealth['topErrorSignatures'] : [],
    };
  } catch {
    return { available: false, minutes: windowHours * 60, logLines: 0, realtimeFailures: 0, realtimeSubscribed: 0, rateLimitWarnings: 0, workerFatal: 0, workerRestarts: 0, uncaughtExceptions: 0, state: 'healthy', topErrorSignatures: [] };
  }
}

// ---------------------------------------------------------------------------
// Checks → tiles
// ---------------------------------------------------------------------------

function fmtDur(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function buildChecks(ctx: {
  unreadableSources: string[]
  serverNowMs: number
  activeLeases: number
  shardConsistent: boolean
  fleet: FleetRow[]
  telegram: TelegramPanel
  brokers: BrokerPanel
  flow: FlowBoard
  deadLettersOpen: number
  errorBuckets: ErrorBucketSummary[]
  railway: RailwayHealth
  windowHours: HealthWindow
}): CheckResult[] {
  const { unreadableSources, activeLeases, shardConsistent, fleet, telegram, brokers, flow, deadLettersOpen, errorBuckets, railway, windowHours } = ctx;
  const checks: CheckResult[] = [];

  const workersUnreadable = unreadableSources.some(s => s.startsWith('clock probe') || s.startsWith('worker_session_leases'));
  checks.push(
    workersUnreadable
      ? { id: 'workers', label: 'Workers running', state: 'unknown', summary: 'Cannot read worker leases', context: `sources: ${unreadableSources.filter(s => s.startsWith('clock probe') || s.startsWith('worker_session_leases')).join('; ')}` }
      : activeLeases === 0
        ? { id: 'workers', label: 'Workers running', state: 'fail', summary: 'No workers online', context: '0 live leases', detail: 'All listener workers have expired leases. Signal processing may be stalled. Restart the Listener service.' }
        : !shardConsistent
          ? { id: 'workers', label: 'Workers running', state: 'warn', summary: `${activeLeases} online · shards differ`, context: `${fleet.length} replica${fleet.length !== 1 ? 's' : ''}`, detail: 'Replicas disagree on shard configuration — some channels may be uncovered.' }
          : { id: 'workers', label: 'Workers running', state: 'ok', summary: `${activeLeases} online`, context: `${fleet.length} replica${fleet.length !== 1 ? 's' : ''}` },
  );

  const tgUnreadable = unreadableSources.some(s => s.startsWith('telegram_sessions'));
  checks.push(
    tgUnreadable
      ? { id: 'telegram', label: 'Telegram linked', state: 'unknown', summary: 'Cannot read sessions', context: '' }
      : telegram.linked === 0
        ? { id: 'telegram', label: 'Telegram linked', state: 'unknown', summary: 'No linked accounts found' }
        : telegram.linked - telegram.listeningNow > HEALTH_THRESHOLDS.telegramListeningGap
          ? { id: 'telegram', label: 'Telegram linked', state: 'warn', summary: `${telegram.listeningNow}/${telegram.linked} listening`, context: `${telegram.linkedNotListeningUsers.length} user(s) not being listened to`, detail: telegram.truthful
              ? 'Live-connectivity check (listener connected + fresh) shows gaps for these linked accounts. Restart the Listener service if this persists.'
              : 'Linked accounts without a live listener lease — a worker may have dropped them mid-cycle. Restart the Listener service if this persists.' }
          : { id: 'telegram', label: 'Telegram linked', state: 'ok', summary: `${telegram.listeningNow}/${telegram.linked} listening`, context: telegram.truthful
              ? `${telegram.authPending} auth in progress · verified live`
              : `${telegram.authPending} auth in progress · lease-based` },
  );

  const brUnreadable = unreadableSources.some(s => s.startsWith('broker_accounts'));
  const brokerBadPct = (brokers.recovering + brokers.error) > 0 && (brokers.connected + brokers.recovering + brokers.error) > 0
    ? ((brokers.recovering + brokers.error) / (brokers.connected + brokers.recovering + brokers.error)) * 100
    : 0;
  checks.push(
    brUnreadable
      ? { id: 'brokers', label: 'Broker connections', state: 'unknown', summary: 'Cannot read broker accounts', context: '' }
      : brokers.connected === 0 && (brokers.recovering + brokers.error) > 0
        ? { id: 'brokers', label: 'Broker connections', state: 'fail', summary: 'None connected', context: `${brokers.recovering} recovering · ${brokers.error} error`, detail: 'Every broker account is down or recovering — copies cannot execute. Likely broker-side outage; notify users.' }
        : brokerBadPct >= HEALTH_THRESHOLDS.brokerRecoveringErrorWarnPct
          ? { id: 'brokers', label: 'Broker connections', state: 'warn', summary: `${brokers.connected} connected`, context: `${brokers.recovering} recovering · ${brokers.error} error` }
          : { id: 'brokers', label: 'Broker connections', state: 'ok', summary: `${brokers.connected} connected`, context: `${brokers.recovering} recovering · ${brokers.error} error` },
  );

  checks.push(
    unreadableSources.some(s => s.startsWith('signals'))
      ? { id: 'queue', label: 'Waiting queue', state: 'unknown', summary: 'Cannot read queue', context: '' }
      : (flow.oldestPendingMinutes ?? 0) > HEALTH_THRESHOLDS.pendingStuckRedMin || flow.pendingInFlight >= HEALTH_THRESHOLDS.pendingStuckRedCount
        ? { id: 'queue', label: 'Waiting queue', state: 'fail', summary: flow.pendingInFlight >= HEALTH_THRESHOLDS.pendingStuckRedCount ? `${flow.pendingInFlight} stuck pending` : `Stuck ${Math.round(flow.oldestPendingMinutes!)} min`, context: `${flow.pendingInFlight} pending · oldest ${Math.round(flow.oldestPendingMinutes ?? 0)} min · ${deadLettersOpen} dead letters`, detail: 'Signals are not being processed. Restart the Trade service; if it persists, capture the oldest signal ID and open an incident writeup.' }
        : deadLettersOpen >= HEALTH_THRESHOLDS.deadLettersFail
          ? { id: 'queue', label: 'Waiting queue', state: 'fail', summary: `${deadLettersOpen} dead letters`, context: `${flow.pendingInFlight} pending` }
          : (flow.oldestPendingMinutes ?? 0) > HEALTH_THRESHOLDS.pendingStuckWarnMin || deadLettersOpen >= HEALTH_THRESHOLDS.deadLettersWarn
            ? { id: 'queue', label: 'Waiting queue', state: 'warn', summary: `${flow.pendingInFlight} pending`, context: `oldest ${Math.round(flow.oldestPendingMinutes ?? 0)} min · ${deadLettersOpen} dead letters` }
            : { id: 'queue', label: 'Waiting queue', state: 'ok', summary: 'Nothing stuck', context: `${flow.pendingInFlight} pending · ${deadLettersOpen} dead letters` },
  );

  const systemErrorCount = errorBuckets.filter(e => e.bucket === 'system').reduce((a, e) => a + e.count, 0);
  const externalEscalated = errorBuckets.some(e => e.bucket === 'external' && e.escalated);
  const userRoutine = errorBuckets.filter(e => e.bucket === 'user').reduce((a, e) => a + e.count, 0);
  const unclassifiedCount = errorBuckets.filter(e => e.bucket === 'unclassified').reduce((a, e) => a + e.count, 0);
  const totalFailures = errorBuckets.reduce((a, e) => a + e.count, 0);

  // Railway worker/realtime health — the origin signal for the 2026-08-25 storm.
  checks.push(
    !railway.available
      ? { id: 'railway', label: 'Worker logs (Railway)', state: 'unknown', summary: 'Panel unavailable', context: railway.error ? railway.error.slice(0, 80) : undefined, detail: 'The Railway log reader is not configured (edge function secret/token). DB leases still prove workers are alive.' }
      : railway.state === 'worker_down'
        ? { id: 'railway', label: 'Worker logs (Railway)', state: 'fail', summary: 'Worker crash detected', context: `${railway.workerFatal} fatal · ${railway.uncaughtExceptions} uncaught · ${railway.workerRestarts} restarts`, detail: 'A worker logged a fatal/uncaught exception in the window. Check Railway deploy logs and the flow board below.' }
        : railway.state === 'storm'
          ? { id: 'railway', label: 'Worker logs (Railway)', state: 'fail', summary: 'Realtime retry storm', context: `${railway.realtimeFailures} subscription failures · ${railway.rateLimitWarnings} rate-limit warnings`, detail: 'Realtime subscriptions churning and/or Railway is dropping logs. This is the 2026-08-25 storm pattern — investigate immediately.' }
          : railway.state === 'degraded'
            ? { id: 'railway', label: 'Worker logs (Railway)', state: 'warn', summary: 'Elevated realtime failures', context: `${railway.realtimeFailures} subscription failures in window` }
            : { id: 'railway', label: 'Worker logs (Railway)', state: 'ok', summary: 'Clean', context: `${railway.logLines} log lines · ${railway.realtimeFailures} realtime failures`, detail: 'No worker crashes, retry storms, or log rate-limits in the window.' },
  );

  checks.push(
    unreadableSources.some(s => s.startsWith('trade_execution_logs'))
      ? { id: 'executions', label: 'Executions', state: 'unknown', summary: 'Cannot read execution logs', context: '' }
      : externalEscalated || systemErrorCount >= HEALTH_THRESHOLDS.escalation.minOccurrences * 2
        ? { id: 'executions', label: 'Executions', state: 'fail', summary: 'Elevated system failures', context: `${systemErrorCount} system-side · ${userRoutine} user-account`, detail: 'Broker-side failures beyond routine account-level noise. Open the details drawer and check recent failed signals.' }
        : systemErrorCount > 0
          ? { id: 'executions', label: 'Executions', state: 'warn', summary: `${systemErrorCount} system-side failures`, context: `${userRoutine} routine user-account issues` }
          : unclassifiedCount > 0 && unclassifiedCount >= totalFailures * 0.5
            ? { id: 'executions', label: 'Executions', state: 'warn', summary: `${unclassifiedCount} unclassified failures`, context: 'over half of failures carry no reason — check worker reason_code stamping', detail: 'A large share of failures have no reason_code. This can mean unrecognized broker errors, or that the worker stopped stamping reasons (regression). Review the UNCLASSIFIED rows.' }
            : { id: 'executions', label: 'Executions', state: 'ok', summary: 'Working', context: userRoutine > 0 ? `${userRoutine} routine user-account issues (do not affect health)` : undefined },
  );

  checks.push(
    !flow.reliable
      ? { id: 'copying', label: 'Trade copying', state: 'unknown', summary: 'Cannot read pipeline', context: '', detail: 'One or more pipeline sources were unreadable — see diagnostics.' }
      : flow.stuckParsedCount >= HEALTH_THRESHOLDS.stuckParsedWarnCount || flow.failed >= HEALTH_THRESHOLDS.escalation.minOccurrences
        ? { id: 'copying', label: 'Trade copying', state: 'warn', summary: 'Blockage detected', context: `${flow.stuckParsedCount} stuck parsed · ${flow.failed} failed`, detail: `${flow.stuckParsedCount} signals were understood but not resolved within ${HEALTH_THRESHOLDS.stuckParsedGraceMin} minutes, and ${flow.failed} failed at the broker (last ${windowHours}h). Check the flow board below.` }
        : { id: 'copying', label: 'Trade copying', state: 'ok', summary: flow.executed > 0 ? `${flow.executed} copied` : 'No trades in window', context: `${fmtDur(flow.latencies[0]?.p95Ms ?? 0)} p95 parse` },
  );

  return checks;
}

// ---------------------------------------------------------------------------
// Verdict + hysteresis
// ---------------------------------------------------------------------------

export type VerdictState = 'healthy' | 'attention' | 'failing' | 'undetermined';

const badStreaks = new Map<string, number>();
const goodStreaks = new Map<string, number>();
const displayStates = new Map<string, HealthState>();

function requiredConsecutiveFailures(id: string): number {
  return id === 'workers' || id === 'queue' ? 1 : 2;
}

export function applyHysteresis(checks: CheckResult[], windowHours: HealthWindow): CheckResult[] {
  const key = (id: string) => `${windowHours}:${id}`;
  return checks.map(check => {
    const k = key(check.id);
    const isBad = check.state === 'warn' || check.state === 'fail';
    const isGood = check.state === 'ok';

    if (check.state === 'unknown') {
      badStreaks.delete(k);
      goodStreaks.delete(k);
      displayStates.delete(k);
      return check;
    }

    const badStreak = isBad ? (badStreaks.get(k) ?? 0) + 1 : 0;
    const goodStreak = isGood ? (goodStreaks.get(k) ?? 0) + 1 : 0;
    badStreaks.set(k, badStreak);
    goodStreaks.set(k, goodStreak);

    const needed = requiredConsecutiveFailures(check.id);
    // Confirm onset: only promote to warn/fail after `needed` consecutive bad
    // samples. Before that, keep whatever was last displayed (or 'ok' if none)
    // so a single blip does not immediately redden the page (review fix).
    if (isBad && badStreak >= needed) {
      displayStates.set(k, check.state);
      return check;
    }
    if (isGood && goodStreak >= 2) {
      displayStates.delete(k);
      return check;
    }
    const remembered = displayStates.get(k) ?? (isBad ? 'ok' : check.state);
    return remembered === check.state ? check : { ...check, state: remembered };
  });
}

export function computeVerdict(report: SystemHealthReport, stabilizedChecks: CheckResult[]): {
  state: VerdictState
  sentence: string
} {
  if (!report.dbReachable) {
    return { state: 'undetermined', sentence: 'Health cannot be fully determined — some data sources are unreachable.' };
  }
  if (stabilizedChecks.some(c => c.state === 'unknown')) {
    return { state: 'undetermined', sentence: 'Health cannot be fully determined — some data sources are unreadable.' };
  }
  const failing = stabilizedChecks.filter(c => c.state === 'fail');
  const warning = stabilizedChecks.filter(c => c.state === 'warn');
  if (failing.length > 0) {
    return { state: 'failing', sentence: `${failing[0].label}: ${failing[0].summary.toLowerCase()}.` };
  }
  if (warning.length > 0) {
    return { state: 'attention', sentence: `${warning.length} thing${warning.length !== 1 ? 's' : ''} need${warning.length === 1 ? 's' : ''} attention.` };
  }
  return { state: 'healthy', sentence: 'Everything is working normally.' };
}

// ---------------------------------------------------------------------------
// Pipeline stage details — powers the clickable pipeline nodes' modals.
// ---------------------------------------------------------------------------

export type StageId = 'received' | 'tradeable' | 'dispatched' | 'executed' | 'failed' | 'filtered';

export interface StageRow {
  primary: string;
  secondary: string | null;
  at: string;
}

export interface StageDetail {
  stage: StageId;
  title: string;
  what: string;
  state: HealthState;
  stateNote: string;
  total: number | null;
  columns: [string, string, string];
  rows: StageRow[];
  breakdown?: Array<{ reason: string; count: number }>;
}

export async function fetchStageDetail(stage: StageId, windowHours: HealthWindow): Promise<StageDetail> {
  const sinceIso = new Date(Date.now() - windowHours * 3_600_000).toISOString();
  const base = {
    stage,
    columns: ['Signal', 'Detail', 'Time'] as [string, string, string],
    rows: [] as StageRow[],
    total: null as number | null,
    title: '',
    what: '',
    state: 'ok' as HealthState,
    stateNote: '',
  };

  if (stage === 'dispatched') {
    const res = await authSupabase
      .from('signal_broker_dispatch_claims')
      .select('signal_id, created_at')
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(20);
    const cnt = await authSupabase
      .from('signal_broker_dispatch_claims')
      .select('signal_id', { count: 'exact', head: true })
      .gte('created_at', sinceIso);
    return {
      ...base,
      title: 'Dispatched (entry attempts)',
      what: 'A dispatch claim is a lock taken right before an order is sent to a broker account — one per signal × broker. Claims are released when an entry is deferred or retried, so this count is a lower bound on real dispatches.',
      total: cnt.count ?? null,
      rows: ((res.data ?? []) as Array<{ signal_id: string; created_at: string }>).map(r => ({
        primary: r.signal_id.slice(0, 8),
        secondary: `claim acquired`,
        at: r.created_at,
      })),
    };
  }

  const statusFilter: Record<StageId, string[] | null> = {
    received: null,
    tradeable: ['parsed', 'executed', 'failed'],
    dispatched: null,
    executed: ['executed'],
    failed: ['failed'],
    filtered: ['skipped'],
  };

  const titles: Record<StageId, { t: string; w: string }> = {
    received: { t: 'Received', w: 'Every message captured from monitored channels — including chatter that is not a trade. This is the top of the funnel.' },
    tradeable: { t: 'Tradeable', w: 'Messages understood as actionable trade signals (parsed, executed, or failed). Messages born skipped never enter here.' },
    dispatched: { t: 'Dispatched', w: '' },
    executed: { t: 'Executed', w: 'At least one broker account materialized the trade. Management-only signals finalize executed without a dispatch claim.' },
    failed: { t: 'Failed', w: 'The broker was attempted but nothing opened anywhere. These are real execution failures — the alarm class.' },
    filtered: { t: 'Filtered out', w: 'Signals intentionally not copied: chatter, duplicates, missing SL/TP structure, paused users, no matching broker, copy limits. Normal behavior — never an alarm.' },
  };

  const meta = titles[stage as Exclude<StageId, 'dispatched'>];
  const statusF = statusFilter[stage];

  let q = authSupabase
    .from('signals')
    .select('id, status, skip_reason, created_at')
    .gte('created_at', sinceIso);
  if (statusF) q = q.in('status', statusF);
  const recentRes = await q.order('created_at', { ascending: false }).limit(15);
  if (recentRes.error && !recentRes.data) {
    return { ...base, title: meta.t, what: meta.w, state: 'unknown', stateNote: recentRes.error.message };
  }

  let hc = authSupabase.from('signals').select('id', { count: 'exact', head: true }).gte('created_at', sinceIso);
  if (statusF) hc = hc.in('status', statusF);
  const cntRes = await hc;

  // Skip-reason breakdown for the filtered stage.
  let breakdown: Array<{ reason: string; count: number }> = [];
  if (stage === 'filtered') {
    const bRes = await authSupabase
      .from('signals')
      .select('skip_reason')
      .eq('status', 'skipped')
      .gte('created_at', sinceIso)
      .limit(1000);
    const m = new Map<string, number>();
    for (const r of (bRes.data ?? []) as Array<{ skip_reason: string | null }>) {
      const k = r.skip_reason || 'unspecified';
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    breakdown = [...m.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 8);
  }

  const rows = ((recentRes.data ?? []) as Array<{ id: string; status: string; skip_reason: string | null; created_at: string }>).map(r => ({
    primary: `${r.id.slice(0, 8)} · ${r.status}`,
    secondary: r.skip_reason ?? null,
    at: r.created_at,
  }));

  let state: HealthState = 'ok';
  let stateNote = '';
  if (stage === 'failed') {
    const n = cntRes.count ?? 0;
    state = n >= HEALTH_THRESHOLDS.escalation.minOccurrences ? 'warn' : n > 0 ? 'ok' : 'ok';
    stateNote = n > 0 ? `${n} in window — each one is a broker attempt that produced nothing.` : 'none in window';
  }
  if (stage === 'filtered') {
    state = 'ok';
    stateNote = 'by design — see the reason breakdown below';
  }

  return {
    ...base,
    title: meta.t,
    what: meta.w,
    total: cntRes.count ?? null,
    rows,
    state,
    stateNote,
    breakdown: breakdown.length > 0 ? breakdown : undefined,
  };
}

// ---------------------------------------------------------------------------
// Support console — answers "why didn't MY trade copy?" for a given user.
// ---------------------------------------------------------------------------
export interface UserHealth {
  userId: string;
  unreadable: string[];
  signalCounts: { received: number; tradeable: number; executed: number; failed: number; skipped: number; pending: number };
  recentSignals: Array<{ id: string; status: string; skip_reason: string | null; created_at: string }>;
  lease: { worker_id: string; expires_at: string } | null;
  telegramLinked: boolean;
  brokerStates: Array<{ state: string; count: number }>;
}

export async function fetchUserHealth(userId: string, windowHours: HealthWindow = 24): Promise<UserHealth> {
  const unreadable: string[] = [];
  const sinceIso = new Date(Date.now() - windowHours * 3_600_000).toISOString();

  const countIn = async (statusFilter: string[] | null): Promise<number> => {
    let q = authSupabase.from('signals').select('id', { count: 'exact', head: true }).eq('user_id', userId).gte('created_at', sinceIso);
    if (statusFilter) q = q.in('status', statusFilter);
    const res = await q;
    if (res.error) { unreadable.push(`signals: ${res.error.message}`); return 0; }
    return res.count ?? 0;
  };

  const [received, tradeable, executed, failed, skipped, pending] = await Promise.all([
    countIn(null),
    countIn(['parsed', 'executed', 'failed']),
    countIn(['executed']),
    countIn(['failed']),
    countIn(['skipped']),
    countIn(['pending']),
  ]);

  interface RecentRow { id: string; status: string; skip_reason: string | null; created_at: string }
  const recentRes = await authSupabase
    .from('signals')
    .select('id, status, skip_reason, created_at')
    .eq('user_id', userId)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(10);
  if (recentRes.error) unreadable.push(`signals.recent: ${recentRes.error.message}`);
  const recentSignals = (recentRes.data as RecentRow[] | null) ?? [];

  const leaseRes = await authSupabase
    .from('worker_session_leases')
    .select('worker_id, expires_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (leaseRes.error) unreadable.push(`lease: ${leaseRes.error.message}`);
  const lease = leaseRes.data ? { worker_id: leaseRes.data.worker_id, expires_at: leaseRes.data.expires_at } : null;

  const sessRes = await authSupabase
    .from('telegram_sessions')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (sessRes.error) unreadable.push(`telegram_sessions: ${sessRes.error.message}`);

  const brokerRes = await authSupabase
    .from('broker_accounts')
    .select('connection_status')
    .eq('user_id', userId);
  if (brokerRes.error) unreadable.push(`broker_accounts: ${brokerRes.error.message}`);
  const stateCounts = new Map<string, number>();
  for (const b of (brokerRes.data ?? []) as Array<{ connection_status: string | null }>) {
    const s = b.connection_status ?? 'unknown';
    stateCounts.set(s, (stateCounts.get(s) ?? 0) + 1);
  }

  return {
    userId,
    unreadable,
    signalCounts: { received, tradeable, executed, failed, skipped, pending },
    recentSignals,
    lease,
    telegramLinked: sessRes.data != null,
    brokerStates: [...stateCounts.entries()].map(([state, count]) => ({ state, count })).sort((a, b) => b.count - a.count),
  };
}

