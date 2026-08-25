/*
 * Systems Health data layer.
 *
 * All checks are database-only (phase 1, plan: docs/systems-health-plan.md).
 * Every check resolves to a definitive state — 'ok' | 'warn' | 'fail' — or
 * 'unknown' when its source cannot be read. Unknown never counts as healthy:
 * the page verdict becomes "cannot be fully determined" instead.
 */

import { authSupabase } from './adminSupabase';

// ---------------------------------------------------------------------------
// Thresholds (plan decision 2). Single config spot; tune after observing real
// behavior. Times in minutes unless noted.
// ---------------------------------------------------------------------------

export const HEALTH_THRESHOLDS = {
  /** Signals stuck in `pending` longer than this are considered stuck. */
  pendingStuckMinutes: 15,
  /** Minimum drop-off ratio between consecutive pipeline stages before warn. */
  pipelineDropOffWarnRatio: 0.6,
  /** Parsed count below this makes stage ratios statistically meaningless. */
  pipelineMinParsedForRatio: 5,
  /** User-bucket error escalation (all three must hold to alert). */
  escalation: {
    minDistinctUsers: 2,
    minOccurrences: 5,
    baselineMultiplier: 5,
    /** Baseline floor per window so quiet hours can't produce infinite spikes. */
    baselineFloor: 1,
  },
  /** Dead-letter counts above these levels flag the waiting-queue tile. */
  deadLettersWarn: 1,
  deadLettersFail: 20,
} as const;

/** Row caps per query — a full page marks the source unreadable (counts unreliable). */
const SIGNALS_CAP = 2000;
const EXECUTED_CAP = 5000;
const CLAIMS_CAP = 5000;
const EXEC_LOGS_CAP = 3000;
const DEAD_LETTERS_CAP = 1000;

export type HealthState = 'ok' | 'warn' | 'fail' | 'unknown';

export type HealthWindow = 1 | 6 | 24; // hours

export interface CheckResult {
  id: string;
  label: string;
  state: HealthState;
  /** Short plain-English line shown under the tile. */
  summary: string;
  /** Longer plain-English explanation for hover/expand. */
  detail?: string;
}

export interface PipelineFunnel {
  received: number;
  parsed: number;
  dispatched: number;
  executed: number;
  /** Oldest still-pending signal age in minutes (null if none pending). */
  oldestPendingMinutes: number | null;
  /** Stage index where a blockage was detected (-1 = none). */
  blockedStage: number;
  blockageDetail: string | null;
}

export interface ErrorBucketSummary {
  bucket: 'system' | 'external' | 'user' | 'unclassified';
  reasonCode: string;
  count: number;
  distinctUsers: number;
  escalated: boolean;
}

export interface SystemHealthReport {
  windowHours: HealthWindow;
  fetchedAt: number;
  /** Server-clock offset proxy in ms (Date.now() - serverNow estimate). */
  clockOffsetMs: number;
  checks: CheckResult[];
  funnel: PipelineFunnel;
  errorBuckets: ErrorBucketSummary[];
  /** Sources that could not be read (permissions/network), with reasons. */
  unreadableSources: string[];
  dbReachable: boolean;
}

// ---------------------------------------------------------------------------
// Ownership classification (mirrors worker classifyBrokerFailureReason codes).
// Plan: User bucket = that user's own situation; External = third party;
// System = our infra. Unclassified stays its own bucket.
// ---------------------------------------------------------------------------

const USER_BUCKET_CODES = new Set([
  'INSUFFICIENT_MARGIN',
  'INVALID_LOT',
]);

const EXTERNAL_BUCKET_CODES = new Set([
  'MARKET_CLOSED',
  'BROKER_RATE_LIMITED',
]);

const SYSTEM_BUCKET_CODES = new Set([
  'BROKER_TIMEOUT',
  'BROKER_ACCOUNT_UNAVAILABLE',
  'BROKER_SYMBOL_NOT_FOUND',
  'BROKER_ORDER_REJECTED', // generic sink — counted but flagged unclassified-ish
]);

function classifyReason(code: string): ErrorBucketSummary['bucket'] {
  if (!code || code === 'UNCLASSIFIED') return 'unclassified';
  if (USER_BUCKET_CODES.has(code)) return 'user';
  if (EXTERNAL_BUCKET_CODES.has(code)) return 'external';
  if (SYSTEM_BUCKET_CODES.has(code)) return 'system';
  return 'unclassified';
}

/** Local port of worker's classifyBrokerFailureReason (businessEvents.ts:211). */
export function classifyBrokerFailureReason(message: string): string {
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
  return 'UNCLASSIFIED';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Queryable {
  data: unknown;
  error: { message: string; code?: string } | null;
}

async function runQuery<T>(
  label: string,
  unreadable: string[],
  fn: () => PromiseLike<Queryable>,
  /** If set, a full page means truncation → counts unreliable → mark source unreadable. */
  cap?: number,
): Promise<T[] | null> {
  const res = await fn();
  if (res.error) {
    unreadable.push(`${label}: ${res.error.message}`);
    return null;
  }
  const rows = (res.data as T[]) ?? [];
  if (cap != null && rows.length >= cap) {
    unreadable.push(`${label}: window exceeds query cap of ${cap} rows — counts unreliable for this range, try a shorter window`);
    return null;
  }
  return rows;
}

function minutesSince(iso: string | null | undefined, serverNowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (serverNowMs - t) / 60_000);
}

/** Epoch-ms jsonb field reader for signals.pipeline_ts. */
function tsPoint(pipelineTs: unknown, key: string): number | null {
  const v = (pipelineTs as Record<string, unknown> | null)?.[key];
  return typeof v === 'number' ? v : typeof v === 'string' && Number.isFinite(Number(v)) ? Number(v) : null;
}

// ---------------------------------------------------------------------------
// Main report builder
// ---------------------------------------------------------------------------

export async function fetchSystemHealth(windowHours: HealthWindow): Promise<SystemHealthReport> {
  const unreadableSources: string[] = [];

  // --- Clock offset proxy: newest row touch vs local clock.
  const clockRows = await runQuery<{ updated_at: string | null }>(
    'clock probe',
    unreadableSources,
    () => authSupabase.from('signals').select('updated_at').order('updated_at', { ascending: false }).limit(1),
  );
  const dbNowMs = clockRows?.[0]?.updated_at ? Date.parse(clockRows[0].updated_at) : NaN;
  const clockOffsetMs = Number.isFinite(dbNowMs) ? Math.min(Math.max(Date.now() - dbNowMs, -120_000), 120_000) : 0;
  const serverNowMs = Date.now() - clockOffsetMs;

  // All window bounds derive from the server-clock estimate (single base).
  const windowStartMs = serverNowMs - windowHours * 3_600_000;
  const sinceIso = new Date(windowStartMs).toISOString();

  // --- Workers: leases + shard consistency.
  interface LeaseRow { user_id: string; role: string | null; shard_id: number | null; shard_count: number | null; expires_at: string | null }
  const leases = await runQuery<LeaseRow>(
    'worker_session_leases',
    unreadableSources,
    () => authSupabase.from('worker_session_leases').select('user_id, role, shard_id, shard_count, expires_at'),
  );
  const nowIso = new Date(serverNowMs).toISOString();
  const activeLeases = (leases ?? []).filter(l => l.expires_at && l.expires_at > nowIso);
  const shardCounts = new Set(activeLeases.map(l => l.shard_count).filter((v): v is number => v != null));
  const shardConsistent = shardCounts.size <= 1;

  // --- Copier/listener + Telegram connection health.
  interface CopierHealthRow {
    user_id: string;
    listener_status: string | null;
    mtproto_connected: boolean | null;
    updated_at: string | null;
    freshness_threshold_ms: number | null;
  }
  const copierHealth = await runQuery<CopierHealthRow>(
    'copier_listener_health',
    unreadableSources,
    () => authSupabase.from('copier_listener_health').select('user_id, listener_status, mtproto_connected, updated_at, freshness_threshold_ms'),
  );
  let connectedCopiers = 0;
  let reconnectingCopiers = 0;
  let staleCopiers = 0;
  let failedCopiers = 0;
  for (const row of copierHealth ?? []) {
    const ageMin = minutesSince(row.updated_at, serverNowMs);
    const stale = ageMin == null || ageMin * 60_000 > (row.freshness_threshold_ms ?? 90_000);
    if (stale) { staleCopiers += 1; continue; }
    switch (row.listener_status) {
      case 'connected': connectedCopiers += 1; break;
      case 'reconnecting': reconnectingCopiers += 1; break;
      case 'failed': case 'disconnected': failedCopiers += 1; break;
      default: break;
    }
  }
  const knownCopiers = (copierHealth ?? []).length;

  // --- Signals funnel (window-scoped, review fixes #2/#3).
  interface SignalRow {
    id: string;
    status: string | null;
    created_at: string | null;
    updated_at: string | null;
    pipeline_ts: unknown;
  }
  const signals = await runQuery<SignalRow>(
    'signals',
    unreadableSources,
    // Select only what the funnel needs; window filter on created_at keeps it bounded.
    () => authSupabase
      .from('signals')
      .select('id, status, created_at, updated_at, pipeline_ts')
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(SIGNALS_CAP),
    SIGNALS_CAP,
  );
  let received = 0;
  let parsed = 0;
  let executed = 0;
  let oldestPendingMinutes: number | null = null;
  for (const s of signals ?? []) {
    received += 1;
    const status = (s.status ?? '').toLowerCase();
    const parsedAt = tsPoint(s.pipeline_ts, 'parsed_at');
    const inWindowParsed = parsedAt != null ? parsedAt >= windowStartMs : status !== 'pending';
    if (inWindowParsed) parsed += 1;
    if (status === 'pending') {
      const age = minutesSince(s.created_at, serverNowMs);
      if (age != null && (oldestPendingMinutes == null || age > oldestPendingMinutes)) oldestPendingMinutes = age;
    }
  }

  // Executed stage: contract is "status executed whose executed_at (fallback
  // updated_at) falls in the window" — signals received BEFORE the window but
  // executed inside it must count too, so run a second bounded fetch keyed on
  // updated_at and merge by id.
  interface SignalRow2 { id: string; status: string | null; pipeline_ts: unknown; updated_at: string | null }
  const executedRows = await runQuery<SignalRow2>(
    'signals(executed)',
    unreadableSources,
    () => authSupabase
      .from('signals')
      .select('id, status, pipeline_ts, updated_at')
      .eq('status', 'executed')
      .gte('updated_at', sinceIso)
      .order('updated_at', { ascending: false })
      .limit(EXECUTED_CAP),
    EXECUTED_CAP,
  );
  const seenExecuted = new Set<string>();
  for (const s of executedRows ?? []) {
    const at = tsPoint(s.pipeline_ts, 'executed_at') ?? (s.updated_at ? Date.parse(s.updated_at) : null);
    if (at == null || at < windowStartMs) continue;
    seenExecuted.add(s.id);
  }
  // Merge with rows already fetched from the created_at-windowed query.
  for (const s of signals ?? []) {
    if ((s.status ?? '').toLowerCase() !== 'executed' || seenExecuted.has(s.id)) continue;
    const at = tsPoint(s.pipeline_ts, 'executed_at') ?? (s.updated_at ? Date.parse(s.updated_at) : null);
    if (at != null && at >= windowStartMs) seenExecuted.add(s.id);
  }
  executed = seenExecuted.size;

  // Dispatched: distinct signal ids among claims created in-window.
  interface ClaimRow { signal_id: string }
  const claims = await runQuery<ClaimRow>(
    'signal_broker_dispatch_claims',
    unreadableSources,
    () => authSupabase
      .from('signal_broker_dispatch_claims')
      .select('signal_id, created_at')
      .gte('created_at', sinceIso)
      .limit(CLAIMS_CAP),
    CLAIMS_CAP,
  );
  const distinctDispatched = new Set((claims ?? []).map(c => c.signal_id)).size;

  // --- Dead letters (waiting-queue tile).
  interface DeadLetterRow { status: string | null }
  const deadLetters = await runQuery<DeadLetterRow>(
    'signal_queue_dead_letters',
    unreadableSources,
    () => authSupabase.from('signal_queue_dead_letters').select('status').is('replayed_at', null).limit(DEAD_LETTERS_CAP),
    DEAD_LETTERS_CAP,
  );
  const openDeadLetters = (deadLetters ?? []).length;

  // --- Execution errors + ownership buckets.
  interface ExecLogRow { user_id: string | null; status: string | null; error_message: string | null; response_payload: unknown }
  const execLogs = await runQuery<ExecLogRow>(
    'trade_execution_logs',
    unreadableSources,
    () => authSupabase
      .from('trade_execution_logs')
      .select('user_id, status, error_message, response_payload')
      .gte('created_at', sinceIso)
      .limit(EXEC_LOGS_CAP),
    EXEC_LOGS_CAP,
  );

  // Single pass: bucket key → count + distinct users (review fix #10).
  const bucketAgg = new Map<string, { count: number; users: Set<string> }>();
  for (const log of execLogs ?? []) {
    const status = (log.status ?? '').toLowerCase();
    if (status === 'success' || status === 'filled' || status === 'ok') { continue; }
    if (status !== 'failed' && status !== 'rejected' && status !== 'error') continue;
    // Prefer structured payload reason_code; fall back to message regex.
    const payloadCode = (log.response_payload as Record<string, unknown> | null)?.reason_code;
    const code = typeof payloadCode === 'string' && payloadCode
      ? payloadCode.toUpperCase()
      : classifyBrokerFailureReason(log.error_message ?? '');
    const bucket = classifyReason(code);
    const key = `${bucket}:${code}`;
    const agg = bucketAgg.get(key) ?? { count: 0, users: new Set<string>() };
    agg.count += 1;
    if (log.user_id) agg.users.add(log.user_id);
    bucketAgg.set(key, agg);
  }
  const errorBuckets: ErrorBucketSummary[] = [...bucketAgg.entries()].map(([key, agg]) => {
    const [bucket, reasonCode] = key.split(':') as [ErrorBucketSummary['bucket'], string];
    return { bucket, reasonCode, count: agg.count, distinctUsers: agg.users.size, escalated: false };
  });

  // Baseline: exact head-count of failures over prior 7 days (no row fetch).
  const baselineSince = new Date(serverNowMs - (7 * 24 + windowHours) * 3_600_000).toISOString();
  const baselineUntil = new Date(serverNowMs - windowHours * 3_600_000).toISOString();
  const baselineRes = await authSupabase
    .from('trade_execution_logs')
    .select('status', { count: 'exact', head: true })
    .in('status', ['failed', 'rejected', 'error'])
    .gte('created_at', baselineSince)
    .lt('created_at', baselineUntil);
  if (baselineRes.error) {
    unreadableSources.push(`execution baseline: ${baselineRes.error.message}`);
  }
  const baselineTotal = baselineRes.count ?? 0;
  const baselinePerWindow = baselineTotal / (7 * 24 / windowHours);

  // Escalation (plan decision 2): ALL of breadth ≥2, occurrences ≥5, spike >5× floored baseline.
  const esc = HEALTH_THRESHOLDS.escalation;
  for (const e of errorBuckets) {
    const flooredBaseline = Math.max(baselinePerWindow, esc.baselineFloor);
    e.escalated =
      e.distinctUsers >= esc.minDistinctUsers &&
      e.count >= esc.minOccurrences &&
      e.count > esc.baselineMultiplier * flooredBaseline;
  }

  // --- Funnel blockage detection.
  const funnel: PipelineFunnel = {
    received,
    parsed,
    dispatched: distinctDispatched,
    executed,
    oldestPendingMinutes,
    blockedStage: -1,
    blockageDetail: null,
  };
  const stages: Array<[string, number]> = [
    ['Received', received],
    ['Parsed', parsed],
    ['Dispatched', distinctDispatched],
    ['Executed', executed],
  ];
  for (let i = 1; i < stages.length; i += 1) {
    const [prevLabel, prevCount] = stages[i - 1];
    const [label, count] = stages[i];
    if (prevCount < HEALTH_THRESHOLDS.pipelineMinParsedForRatio) continue;
    if (count / prevCount < HEALTH_THRESHOLDS.pipelineDropOffWarnRatio) {
      funnel.blockedStage = i;
      funnel.blockageDetail =
        `${prevCount - count} of ${prevCount} ${prevLabel.toLowerCase()} signals did not reach "${label}" in the last ${windowHours}h.`;
      break;
    }
  }

  const dbReachable = unreadableSources.length === 0;

  // --- Checks → tiles (System bucket only feeds fail/warn states).
  const checks: CheckResult[] = [];

  checks.push(
    unreadableSources.some(s => s.startsWith('worker_session_leases'))
      ? { id: 'workers', label: 'Workers running', state: 'unknown', summary: 'Cannot read worker leases' }
      : activeLeases.length === 0
        ? { id: 'workers', label: 'Workers running', state: 'fail', summary: 'No workers online', detail: 'All listener workers have expired leases. Signal processing may be stalled.' }
        : !shardConsistent
          ? { id: 'workers', label: 'Workers running', state: 'warn', summary: `${activeLeases.length} online`, detail: 'Inconsistent shard configuration across replicas — some channels may be uncovered.' }
          : { id: 'workers', label: 'Workers running', state: 'ok', summary: `${activeLeases.length} online` },
  );

  const tgUnreadable = unreadableSources.some(s => s.startsWith('copier_listener_health'));
  const tgMajorityBad = knownCopiers > 0 && failedCopiers > knownCopiers / 2;
  checks.push(
    tgUnreadable
      ? { id: 'telegram', label: 'Telegram connection', state: 'unknown', summary: 'Cannot read listener health' }
      : knownCopiers === 0
        ? { id: 'telegram', label: 'Telegram connection', state: 'unknown', summary: 'No listener health rows found', detail: 'The copier_listener_health table is empty — either nothing has connected yet or the source is being filtered.' }
        : tgMajorityBad
        ? { id: 'telegram', label: 'Telegram connection', state: 'fail', summary: `${failedCopiers} disconnected`, detail: 'Most copier listeners are failed/disconnected and their rows are fresh.' }
        : reconnectingCopiers > 0 || failedCopiers > 0 || staleCopiers > 0
          ? { id: 'telegram', label: 'Telegram connection', state: 'warn', summary: `${connectedCopiers} connected`, detail: `${reconnectingCopiers} reconnecting · ${failedCopiers} disconnected · ${staleCopiers} stale.` }
          : { id: 'telegram', label: 'Telegram connection', state: 'ok', summary: `${connectedCopiers} connected` },
  );

  const disconnectedUsers = failedCopiers + reconnectingCopiers;
  checks.push(
    tgUnreadable
      ? { id: 'sessions', label: 'User sessions', state: 'unknown', summary: 'Cannot read sessions' }
      : knownCopiers === 0
        ? { id: 'sessions', label: 'User sessions', state: 'unknown', summary: 'No session data found' }
        : disconnectedUsers >= 3
        ? { id: 'sessions', label: 'User sessions', state: 'warn', summary: `${disconnectedUsers} users affected`, detail: `${failedCopiers} disconnected · ${reconnectingCopiers} reconnecting.` }
        : { id: 'sessions', label: 'User sessions', state: 'ok', summary: `${Math.max(knownCopiers - disconnectedUsers, 0)} healthy` },
  );

  checks.push(
    unreadableSources.some(s => s.startsWith('signals'))
      ? { id: 'queue', label: 'Waiting queue', state: 'unknown', summary: 'Cannot read queue' }
      : (oldestPendingMinutes ?? 0) > HEALTH_THRESHOLDS.pendingStuckMinutes
        ? { id: 'queue', label: 'Waiting queue', state: 'fail', summary: `Stuck ${Math.round(oldestPendingMinutes!)} min`, detail: `Oldest unprocessed signal is ${Math.round(oldestPendingMinutes!)} minutes old (threshold ${HEALTH_THRESHOLDS.pendingStuckMinutes}).` }
        : openDeadLetters >= HEALTH_THRESHOLDS.deadLettersFail
          ? { id: 'queue', label: 'Waiting queue', state: 'fail', summary: `${openDeadLetters} dead letters`, detail: 'High number of unresolved dead letters — events are being dropped without replay.' }
          : openDeadLetters >= HEALTH_THRESHOLDS.deadLettersWarn
            ? { id: 'queue', label: 'Waiting queue', state: 'warn', summary: `${openDeadLetters} dead letter${openDeadLetters !== 1 ? 's' : ''}` }
            : { id: 'queue', label: 'Waiting queue', state: 'ok', summary: 'Nothing stuck' },
  );

  const systemErrorCount = errorBuckets.filter(e => e.bucket === 'system' || e.bucket === 'unclassified').reduce((a, e) => a + e.count, 0);
  const externalEscalated = errorBuckets.some(e => e.bucket === 'external' && e.escalated);
  checks.push(
    unreadableSources.some(s => s.startsWith('trade_execution_logs'))
      ? { id: 'broker', label: 'Broker orders', state: 'unknown', summary: 'Cannot read execution logs' }
      : externalEscalated || systemErrorCount >= HEALTH_THRESHOLDS.escalation.minOccurrences * 2
        ? { id: 'broker', label: 'Broker orders', state: 'fail', summary: 'Elevated failures', detail: 'Widespread broker-side failures detected beyond routine account-level noise.' }
        : systemErrorCount > 0
          ? { id: 'broker', label: 'Broker orders', state: 'warn', summary: `${systemErrorCount} system-side failure${systemErrorCount !== 1 ? 's' : ''}` }
          : { id: 'broker', label: 'Broker orders', state: 'ok', summary: 'Working' },
  );

  checks.push(
    unreadableSources.some(s => s.startsWith('signals'))
      ? { id: 'copying', label: 'Trade copying', state: 'unknown', summary: 'Cannot read pipeline' }
      : funnel.blockedStage >= 0
        ? { id: 'copying', label: 'Trade copying', state: funnel.blockedStage === stages.length - 1 ? 'warn' : 'fail', summary: 'Flow interrupted', detail: funnel.blockageDetail ?? undefined }
        : { id: 'copying', label: 'Trade copying', state: 'ok', summary: `${executed} copied` },
  );

  return {
    windowHours,
    fetchedAt: Date.now(),
    clockOffsetMs,
    checks,
    funnel,
    errorBuckets,
    unreadableSources,
    dbReachable,
  };
}

// ---------------------------------------------------------------------------
// Verdict + hysteresis (review fix #5). A check must be bad for 2 consecutive
// samples before the verdict escalates, and good for 2 before recovering.
// ---------------------------------------------------------------------------

export type VerdictState = 'healthy' | 'attention' | 'failing' | 'undetermined';

/** Display-state memory, keyed by `${windowHours}:${checkId}` so streaks never
 *  leak semantics across window switches (review fix #5). */
const badStreaks = new Map<string, number>();
const goodStreaks = new Map<string, number>();
const displayStates = new Map<string, HealthState>();

function requiredConsecutiveFailures(id: string): number {
  // Fail fast on hard-outage signals (workers offline / queue stuck) so real
  // incidents surface on first sample; everything else needs confirmation.
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
    if (isBad && badStreak >= needed) {
      displayStates.set(k, check.state);
      return check;
    }
    if (isGood && goodStreak >= 2) {
      displayStates.delete(k);
      return check;
    }
    const remembered = displayStates.get(k);
    return remembered ? { ...check, state: remembered } : check;
  });
}

export function computeVerdict(report: SystemHealthReport, stabilizedChecks: CheckResult[]): {
  state: VerdictState;
  sentence: string;
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
