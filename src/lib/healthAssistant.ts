/**
 * Client for the Systems Health AI assistant: builds a compact snapshot of the
 * current health report and sends the operator's question (plus chat history)
 * to the `systems-health-assistant` edge function. The assistant is read-only —
 * it answers from the snapshot and cannot take actions or fetch fresh data.
 */

import { authSupabase, fetchDisplayNames } from './adminSupabase';
import {
  MAP_KEY_TO_CHECK,
  MAP_KEY_TO_PROBE,
  MAP_NODE_COPY,
  ORGAN_COPY,
  probeHealth,
  railwayBox,
} from './healthMapCopy';
import type { MonitoringOverlay } from './monitoringOverlay';
import {
  fetchStageDetail,
  type HealthState,
  type NotListeningDetail,
  type StageDetail,
  type StageId,
  type SystemHealthReport,
  type VerdictState,
} from './systemHealth';

/** A connection-map component exactly as its modal shows it. */
export interface SnapshotComponent {
  key: string;
  label: string;
  value: string;
  state: HealthState;
  /** Current status line (check summary, or the probe's derived title). */
  status: string;
  /** Check detail — the sentence under the status in the modal. */
  statusDetail?: string;
  what: string;
  impact: string;
  /** Alert rule codes whose open events belong to this component. */
  rules: string[];
  /** Probe target when this component has one; full metrics live in `probes`. */
  probeTarget?: string;
}

/** Stage-modal content (totals, filter breakdown, most recent rows). */
export interface SnapshotStageDetail {
  stage: string;
  title: string;
  what: string;
  state: string;
  stateNote: string;
  total: number | null;
  breakdown?: Array<{ reason: string; count: number }>;
  rows: Array<{ primary: string; secondary: string | null; at: string }>;
}

export interface HealthAssistantSnapshot {
  env: string;
  windowHours: number;
  snapshotAt: string;
  clockOffsetMs: number;
  verdict: { state: VerdictState; sentence: string };
  checks: Array<{ id: string; label: string; state: string; summary: string; context?: string; detail?: string }>;
  flow: {
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
    latencies: Array<{ label: string; samples: number; p50Ms: number | null; p95Ms: number | null }>;
  };
  fleet: SystemHealthReport['fleet'];
  shardConsistent: boolean;
  activeLeases: number;
  telegram: {
    reliable: boolean;
    linked: number;
    listeningNow: number;
    /** Lease-based count — how many accounts a process is actively polling. */
    listeningLeases: number;
    healthReporting: boolean;
    truthful: boolean;
    authPending: number;
    linkedNotListeningTotal: number;
    linkedNotListening: Array<{ id: string; name: string | null }>;
    /** Who IS listening right now (capped at 40) — names the few that work. */
    listeningUsers: Array<{ id: string; name: string | null }>;
    /** Per-account root-cause rows (lease / MTProto / subscription state). */
    notListeningDetail: Array<NotListeningDetail & { name: string | null }>;
  };
  /** Connection-map components — the exact content of the on-screen modals. */
  components: SnapshotComponent[];
  /** Plain-English intro shown at the top of each organ modal. */
  organCopy: typeof ORGAN_COPY;
  /** Stage-modal content for the stages that matter this window (bounded). */
  stageDetails: SnapshotStageDetail[];
  brokers: SystemHealthReport['brokers'];
  railway: {
    available: boolean;
    state: string;
    minutes: number;
    logLines: number;
    realtimeFailures: number;
    workerFatal: number;
    workerRestarts: number;
    uncaughtExceptions: number;
    topErrorSignatures: Array<{ message: string; count: number }>;
  };
  errorBuckets: Array<{
    bucket: string;
    reasonCode: string;
    count: number;
    distinctUsers: number;
    escalated: boolean;
    lastSeen: string | null;
    /** Most recent failures with small fields only — request/response payloads stay out. */
    samples: Array<{ id: string; at: string | null; userId: string | null; user: string | null; action: string | null; error: string | null }>;
  }>;
  failureBaselinePerWindow: number;
  deadLettersOpen: number;
  unreadableSources: string[];
  dbReachable: boolean;
  probes: Array<{
    target: string;
    state: string;
    latencyMs: number | null;
    lastReportAt: string | null;
    downSince: string | null;
    consecutiveFailures: number;
    uptime24hPct: number | null;
    p95LatencyMs: number | null;
    detail?: string;
    recentEvents: Array<{ state: string; at: string; latencyMs: number | null; detail: string | null }>;
  }> | null;
  openAlerts: Array<{
    severity: string;
    state: string;
    ruleCode: string;
    message: string;
    createdAt: string;
  }> | null;
  /** Honest availability of the probe/alert overlay: when a source is not readable its list is null, never []. */
  overlay: {
    available: boolean;
    probesReadable: boolean;
    alertsReadable: boolean;
  };
}

const MAX_LINKED_NOT_LISTENING = 40;
const MAX_ERROR_SIGNATURES = 8;
const MAX_OPEN_ALERTS = 20;
const MAX_BUCKET_SAMPLES = 3;
const MAX_PROBE_EVENTS = 4;

export async function buildHealthAssistantSnapshot(
  report: SystemHealthReport,
  verdict: { state: VerdictState; sentence: string },
  overlay: MonitoringOverlay | null,
  envLabel: string,
): Promise<HealthAssistantSnapshot> {
  const notListeningIds = report.telegram.linkedNotListeningUsers.slice(0, MAX_LINKED_NOT_LISTENING);
  const listeningIds = report.telegram.listeningUserIds.slice(0, MAX_LINKED_NOT_LISTENING);
  const bucketSamples = report.errorBuckets.slice(0, 20).map(b => ({ bucket: b, samples: b.rows.slice(0, MAX_BUCKET_SAMPLES) }));
  const nameIds = [
    ...notListeningIds,
    ...listeningIds,
    ...bucketSamples.flatMap(s => s.samples.map(r => r.userId).filter((u): u is string => !!u)),
  ];
  const nowTick = Date.now();
  const checksById = new Map(report.checks.map(c => [c.id, c]));

  // Stage-modal content: the alarm stage always, plus stages with visible
  // trouble in this window — bounded so a send stays a handful of queries.
  const stageIds: StageId[] = ['failed'];
  if (report.flow.filteredOut > 0) stageIds.push('filtered');
  if (report.flow.stuckParsedCount > 0) stageIds.push('tradeable');
  if ((checksById.get('telegram')?.state ?? 'ok') !== 'ok') stageIds.push('received');

  const [names, stageResults] = await Promise.all([
    fetchDisplayNames(nameIds),
    Promise.all(stageIds.map(s => fetchStageDetail(s, report.windowHours).catch(() => null))),
  ]);
  const stageDetails: SnapshotStageDetail[] = stageResults
    .filter((s): s is StageDetail => s != null)
    .map(s => ({
      stage: s.stage,
      title: s.title,
      what: s.what,
      state: s.state,
      stateNote: s.stateNote,
      total: s.total,
      ...(s.breakdown && s.breakdown.length > 0 ? { breakdown: s.breakdown.slice(0, 8) } : {}),
      rows: s.rows.slice(0, 5).map(r => ({ primary: r.primary, secondary: r.secondary, at: r.at })),
    }));

  // Connection-map components — same derivation as the on-screen map
  // (lib/healthMapCopy is the shared source), so the assistant reads exactly
  // what an operator would see by clicking each box.
  const findProbe = (t: string) => (overlay?.probesReadable ? overlay.probes.find(p => p.target === t) : undefined);
  const probeNode = (t: string) => {
    const h = probeHealth(findProbe(t), nowTick);
    return { value: h.value, state: h.state, title: h.title };
  };
  const checkNode = (id: string, value: string) => {
    const c = checksById.get(id);
    return { value, state: c?.state ?? ('unknown' as HealthState), title: c?.summary ?? '' };
  };
  const DYN: Record<string, () => { value: string; state: HealthState; title?: string }> = {
    'telegram-src': () => checkNode('telegram', `${report.telegram.listeningNow}/${report.telegram.linked}`),
    listeners: () => checkNode('workers', String(report.activeLeases)),
    signals: () => checkNode('copying', report.flow.reliable ? report.flow.received.toLocaleString() : '—'),
    queue: () => checkNode('queue', String(report.flow.pendingInFlight)),
    'trade-workers': () => probeNode('worker_trade'),
    'bridge-mt5': () => probeNode('bridge_mt5'),
    'bridge-mt4': () => probeNode('bridge_mt4'),
    scheduler: () => {
      const h = probeNode('alert_evaluator');
      return { ...h, title: h.title || 'Cron-driven alert evaluator, runs every minute' };
    },
    database: () => ({
      value: report.dbReachable ? 'reachable' : 'DOWN',
      state: report.dbReachable ? 'ok' : 'fail',
      title: `Clock offset vs DB: ${report.clockOffsetMs >= 0 ? '+' : ''}${Math.round(report.clockOffsetMs / 1000)}s`,
    }),
    railway: () => railwayBox(probeNode('worker_trade').state, checksById.get('workers')?.state),
    backtest: () => ({ value: 'on demand', state: 'unknown' as HealthState, title: 'Backtest runs are triggered manually from the Backtests page — idle is normal.' }),
    'broker-accounts': () => checkNode('brokers', String(report.brokers.connected + report.brokers.recovering + report.brokers.error)),
  };
  const components: SnapshotComponent[] = Object.keys(MAP_NODE_COPY).map(key => {
    const copy = MAP_NODE_COPY[key];
    const dyn = DYN[key]?.() ?? { value: '—', state: 'unknown' as HealthState };
    const checkId = MAP_KEY_TO_CHECK[key];
    const check = checkId ? checksById.get(checkId) : undefined;
    const probeTarget = MAP_KEY_TO_PROBE[key];
    return {
      key,
      label: copy.label,
      value: dyn.value,
      state: dyn.state,
      status: check?.summary ?? dyn.title ?? '',
      ...(check?.detail ? { statusDetail: check.detail } : {}),
      what: copy.what,
      impact: copy.impact,
      rules: copy.rules,
      ...(probeTarget && overlay?.probesReadable ? { probeTarget } : {}),
    };
  });

  return {
    env: envLabel,
    windowHours: report.windowHours,
    snapshotAt: new Date(report.fetchedAt).toISOString(),
    clockOffsetMs: report.clockOffsetMs,
    verdict,
    checks: report.checks.map(c => ({
      id: c.id,
      label: c.label,
      state: c.state,
      summary: c.summary,
      ...(c.context ? { context: c.context } : {}),
      ...(c.detail ? { detail: c.detail } : {}),
    })),
    flow: {
      reliable: report.flow.reliable,
      received: report.flow.received,
      tradeable: report.flow.tradeable,
      dispatchedAttempts: report.flow.dispatchedAttempts,
      executed: report.flow.executed,
      failed: report.flow.failed,
      filteredOut: report.flow.filteredOut,
      pendingInFlight: report.flow.pendingInFlight,
      oldestPendingMinutes: report.flow.oldestPendingMinutes,
      stuckParsedCount: report.flow.stuckParsedCount,
      latencies: report.flow.latencies,
    },
    fleet: report.fleet,
    shardConsistent: report.shardConsistent,
    activeLeases: report.activeLeases,
    telegram: {
      reliable: report.telegram.reliable,
      linked: report.telegram.linked,
      listeningNow: report.telegram.listeningNow,
      listeningLeases: report.telegram.listeningLeases,
      healthReporting: report.telegram.healthReporting,
      truthful: report.telegram.truthful,
      authPending: report.telegram.authPending,
      linkedNotListeningTotal: report.telegram.linkedNotListeningUsers.length,
      linkedNotListening: notListeningIds.map(id => ({ id, name: names[id] ?? null })),
      listeningUsers: listeningIds.map(id => ({ id, name: names[id] ?? null })),
      notListeningDetail: report.telegram.notListeningDetail.map(d => ({ ...d, name: names[d.userId] ?? null })),
    },
    components,
    organCopy: ORGAN_COPY,
    stageDetails,
    brokers: report.brokers,
    railway: {
      available: report.railway.available,
      state: report.railway.state,
      minutes: report.railway.minutes,
      logLines: report.railway.logLines,
      realtimeFailures: report.railway.realtimeFailures,
      workerFatal: report.railway.workerFatal,
      workerRestarts: report.railway.workerRestarts,
      uncaughtExceptions: report.railway.uncaughtExceptions,
      topErrorSignatures: report.railway.topErrorSignatures.slice(0, MAX_ERROR_SIGNATURES),
    },
    // Full request/response payloads stay out; each bucket carries a few
    // recent small-field samples so the assistant can quote real failures.
    errorBuckets: bucketSamples.map(({ bucket: b, samples }) => ({
      bucket: b.bucket,
      reasonCode: b.reasonCode,
      count: b.count,
      distinctUsers: b.distinctUsers,
      escalated: b.escalated,
      lastSeen: b.rows[0]?.createdAt ?? null,
      samples: samples.map(r => ({
        id: r.id,
        at: r.createdAt,
        userId: r.userId,
        user: r.userId ? names[r.userId] ?? null : null,
        action: r.action,
        error: r.errorMessage ? r.errorMessage.slice(0, 200) : null,
      })),
    })),
    failureBaselinePerWindow: report.failureBaselinePerWindow,
    deadLettersOpen: report.deadLettersOpen,
    unreadableSources: report.unreadableSources,
    dbReachable: report.dbReachable,
    probes: !overlay || !overlay.probesReadable
      ? null
      : overlay.probes.map(p => ({
          target: p.target,
          state: p.state,
          latencyMs: p.latencyMs,
          lastReportAt: p.lastReportAt,
          downSince: p.downSince,
          consecutiveFailures: p.consecutiveFailures,
          uptime24hPct: p.uptime24hPct,
          p95LatencyMs: p.p95LatencyMs,
          ...(p.detail ? { detail: p.detail } : {}),
          recentEvents: p.recentEvents.slice(0, MAX_PROBE_EVENTS).map(e => ({
            state: e.state,
            at: e.created_at,
            latencyMs: e.latency_ms,
            detail: e.detail,
          })),
        })),
    openAlerts: !overlay || !overlay.alertsReadable
      ? null
      : overlay.openAlerts.slice(0, MAX_OPEN_ALERTS).map(a => ({
          severity: a.severity,
          state: a.state,
          ruleCode: a.rule_code,
          message: a.message,
          createdAt: a.created_at,
        })),
    overlay: {
      available: overlay !== null,
      probesReadable: overlay?.probesReadable ?? false,
      alertsReadable: overlay?.alertsReadable ?? false,
    },
  };
}

export interface HealthAssistantTurn {
  role: 'user' | 'assistant';
  content: string;
}

export async function sendHealthAssistantQuestion(args: {
  question: string;
  history: HealthAssistantTurn[];
  snapshot: HealthAssistantSnapshot;
}): Promise<string> {
  const { data, error } = await authSupabase.functions.invoke('systems-health-assistant', {
    body: {
      question: args.question,
      history: args.history,
      report: args.snapshot,
    },
  });
  if (error) {
    // supabase-js wraps non-2xx responses: the server's own message
    // ("question is too long", "not deployed", …) lives on error.context.
    const context = (error as { context?: Response }).context;
    let serverMessage: string | null = null;
    if (context && typeof context.json === 'function') {
      try {
        const body = (await context.json()) as { error?: unknown };
        if (typeof body?.error === 'string' && body.error) serverMessage = body.error;
      } catch {
        serverMessage = null;
      }
    }
    throw new Error(serverMessage ?? (error as { message?: string }).message ?? 'assistant request failed');
  }
  const reply = (data as { reply?: unknown })?.reply;
  if (typeof reply !== 'string' || !reply) {
    const errMsg = (data as { error?: unknown })?.error;
    throw new Error(typeof errMsg === 'string' && errMsg ? errMsg : 'assistant returned an empty reply');
  }
  return reply;
}
