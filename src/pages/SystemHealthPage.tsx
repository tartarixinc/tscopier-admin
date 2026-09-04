import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  applyHysteresis,
  computeVerdict,
  fetchStageDetail,
  fetchSystemHealth,
  fetchUserHealth,
  HEALTH_THRESHOLDS,
  type CheckResult,
  type HealthState,
  type HealthWindow,
  type FlowBoard,
  type StageId,
  type StageDetail,
  type ErrorBucketSummary,
  type UserHealth,
} from '../lib/systemHealth';
import { ENVIRONMENTS, getAdminEnv } from '../lib/environment';
import { authSupabase, fetchDisplayNames } from '../lib/adminSupabase';
import { UserLink } from '../components/UserLink';
import { JsonViewer } from '../components/JsonViewer';
import { ChevronDown, ChevronRight, Crosshair, User as UserIcon, Wifi, Activity, AlertTriangle, Check } from 'lucide-react';

const REFRESH_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;

type Verdict = ReturnType<typeof computeVerdict>;
type Report = Awaited<ReturnType<typeof fetchSystemHealth>>;

const STATE_DOT: Record<HealthState, string> = {
  ok: 'bg-success-500',
  warn: 'bg-warning-500',
  fail: 'bg-error-500',
  unknown: 'bg-slate-400',
};

const STATE_TEXT: Record<HealthState, string> = {
  ok: 'text-success-700 dark:text-success-300',
  warn: 'text-warning-700 dark:text-warning-300',
  fail: 'text-error-700 dark:text-error-300',
  unknown: 'text-slate-500 dark:text-slate-400',
};

const NODE_STATE_STYLE: Record<HealthState, string> = {
  ok: 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:border-primary-400',
  warn: 'border-warning-400 bg-warning-50 dark:bg-warning-900/30',
  fail: 'border-error-500 bg-error-50 dark:bg-error-900/40',
  unknown: 'border-slate-300 dark:border-slate-600 bg-slate-100 dark:bg-slate-800',
};

function fmtDur(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

// ---------------------------------------------------------------------------
// Generic modal shell — Escape closes, backdrop click closes.
// ---------------------------------------------------------------------------

function ModalShell({ title, dotColor, onClose, children, wide }: {
  title: React.ReactNode;
  dotColor: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className={`relative w-full ${wide ? 'max-w-4xl' : 'max-w-2xl'} max-h-[85vh] overflow-y-auto card p-6 shadow-xl`}>
        <div className="flex items-start justify-between gap-4 mb-3">
          <div className="flex items-center gap-2.5">
            <span className={`h-3 w-3 rounded-full ${dotColor}`} />
            <h3 className="text-base font-bold">{title}</h3>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Signal-journey stages (the spine of the machine).
// ---------------------------------------------------------------------------

interface StageNode {
  id: StageId;
  label: string;
  count: number;
  state: HealthState;
  note: string;
}

function stageNodes(flow: FlowBoard): { main: StageNode[]; exits: StageNode[] } {
  const unresolved = Math.max(0, flow.dispatchedAttempts - flow.executed - flow.failed);
  const dispatchDivergent = flow.dispatchedAttempts > 0
    && unresolved > Math.max(5, Math.round(flow.dispatchedAttempts * 0.1));
  const failedLoud = flow.failed >= HEALTH_THRESHOLDS.escalation.minOccurrences;

  const main: StageNode[] = [
    { id: 'received', label: 'Received', count: flow.received, state: 'ok', note: 'every message captured' },
    {
      id: 'tradeable',
      label: 'Tradeable',
      count: flow.tradeable,
      state: flow.stuckParsedCount >= HEALTH_THRESHOLDS.stuckParsedWarnCount ? 'warn' : 'ok',
      note: flow.stuckParsedCount >= HEALTH_THRESHOLDS.stuckParsedWarnCount
        ? `${flow.stuckParsedCount} stuck >${HEALTH_THRESHOLDS.stuckParsedGraceMin} min`
        : 'understood as actionable',
    },
    {
      id: 'dispatched',
      label: 'Dispatched*',
      count: flow.dispatchedAttempts,
      state: dispatchDivergent ? 'warn' : 'ok',
      note: dispatchDivergent ? `${unresolved} sent but unresolved` : 'sent to brokers',
    },
    {
      id: 'executed',
      label: 'Executed',
      count: flow.executed,
      state: flow.received > 0 && flow.executed === 0 ? 'warn' : 'ok',
      note: 'at least one broker filled',
    },
  ];

  const exits: StageNode[] = [
    { id: 'filtered', label: 'Filtered out', count: flow.filteredOut, state: 'ok', note: 'by design — chatter, duplicates, pauses' },
    { id: 'failed', label: 'Failed', count: flow.failed, state: failedLoud ? 'fail' : flow.failed > 0 ? 'warn' : 'ok', note: 'broker tried, nothing opened' },
  ];
  return { main, exits };
}

function PipelineNode({ node, onClick }: { node: StageNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`relative shrink-0 w-[118px] rounded-xl border-2 px-3 py-2.5 text-center transition-all hover:-translate-y-0.5 hover:shadow-md ${NODE_STATE_STYLE[node.state]}`}
    >
      <span className={`absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full ${STATE_DOT[node.state]}`} />
      <p className="text-lg font-bold leading-none">{node.count.toLocaleString()}</p>
      <p className="mt-1 text-[11px] font-medium text-slate-600 dark:text-slate-300">{node.label}</p>
      <p className="mt-0.5 text-[9px] leading-tight text-slate-400">{node.note}</p>
    </button>
  );
}

/** Animated data-flow line; turns solid red where flow is failing. */
function FlowLine({ blocked, widthClass }: { blocked?: boolean; widthClass?: string }) {
  if (blocked) return <div className={`shrink-0 border-t-2 border-error-500 ${widthClass ?? 'w-7'}`} />;
  return (
    <div
      className={`shrink-0 h-0.5 flow-dash ${widthClass ?? 'w-7'}`}
      style={{ backgroundImage: 'linear-gradient(90deg, #94a3b8 0 7px, transparent 7px 14px)', backgroundSize: '14px 2px' }}
    />
  );
}

function StageModal({
  stage,
  windowHours,
  onClose,
}: {
  stage: StageId;
  windowHours: HealthWindow;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<StageDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    fetchStageDetail(stage, windowHours)
      .then(d => { if (!cancelled) setDetail(d); })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [stage, windowHours]);

  const stateColor = detail ? STATE_DOT[detail.state] : 'bg-slate-400';

  return (
    <ModalShell
      title={detail?.title ?? 'Loading…'}
      dotColor={stateColor}
      onClose={onClose}
    >
      {!detail && !error && <div className="skeleton h-24 w-full my-4" />}
      {error && <p className="text-sm text-error-600 dark:text-error-400">{error}</p>}

      {detail && (
        <div className="space-y-4">
          <p className="text-sm text-slate-600 dark:text-slate-300">{detail.what}</p>

          <div className="flex items-center gap-6 flex-wrap text-sm">
            <span>Total in window: <b>{detail.total?.toLocaleString() ?? '—'}</b></span>
            <span className={`flex items-center gap-1.5 ${STATE_TEXT[detail.state]}`}>
              <span className={`h-2 w-2 rounded-full ${stateColor}`} />
              {detail.stateNote || (detail.state === 'ok' ? 'no issues' : 'needs attention')}
            </span>
          </div>

          {detail.breakdown && detail.breakdown.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-1">Why signals are filtered</p>
              <div className="space-y-1">
                {detail.breakdown.map(b => (
                  <div key={b.reason} className="flex items-center gap-2 text-xs">
                    <span className="w-10 shrink-0 text-right font-medium">{b.count}×</span>
                    <span className="text-slate-600 dark:text-slate-300">{b.reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-1">Most recent</p>
            {detail.rows.length === 0 ? (
              <p className="text-sm text-slate-400">Nothing here in this window.</p>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-slate-400 uppercase tracking-wide">
                    <th className="pb-1 pr-3">{detail.columns[0]}</th>
                    <th className="pb-1 pr-3">{detail.columns[1]}</th>
                    <th className="pb-1">{detail.columns[2]}</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.rows.map((r, i) => (
                    <tr key={i} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="py-1 pr-3 font-mono">{r.primary}</td>
                      <td className="py-1 pr-3 text-slate-500 dark:text-slate-400">{r.secondary ?? '—'}</td>
                      <td className="py-1 text-slate-400">{new Date(r.at).toLocaleTimeString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="flex gap-3 pt-1">
            <Link to="/signals" className="text-xs underline text-primary-600 dark:text-primary-400">Signals page →</Link>
            <Link to="/trades/execution-logs" className="text-xs underline text-primary-600 dark:text-primary-400">Execution logs →</Link>
          </div>
        </div>
      )}
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
// System organs — the components that power the machine. Each opens its own
// modal fed entirely from the report (no extra queries needed).
// ---------------------------------------------------------------------------

type OrganId = 'workers' | 'telegram' | 'brokers' | 'railway';

const ORGAN_COPY: Record<OrganId, { label: string; what: string }> = {
  workers: {
    label: 'Workers',
    what: 'Listener workers hold a renewable lease (≈45s TTL) for every Telegram account they actively poll. A live lease proves a worker is alive and owns that user\'s listening loop.',
  },
  telegram: {
    label: 'Telegram link',
    what: 'A linked session means the user connected their Telegram account once. Listening now means a worker is actively polling that account at this moment.',
  },
  brokers: {
    label: 'Broker links',
    what: 'Each user connects broker accounts through which trades execute. Recovering means auto-reconnect is in progress; error needs the user to reconnect.',
  },
  railway: {
    label: 'Worker process logs',
    what: 'Live Railway deployment logs watched for worker crashes, realtime subscription churn, and log rate-limits — the exact pattern of the Aug 25 retry storm.',
  },
};

function organState(checks: CheckResult[], id: OrganId): CheckResult | undefined {
  return checks.find(c => c.id === id);
}

function OrganButton({ check, label, value, sub, onClick }: {
  check: CheckResult | undefined;
  label: string;
  value: string;
  sub?: string;
  onClick: () => void;
}) {
  const state: HealthState = check?.state ?? 'unknown';
  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-lg border px-3 py-2 transition-all hover:-translate-y-px hover:shadow-sm ${NODE_STATE_STYLE[state]}`}
    >
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full shrink-0 ${STATE_DOT[state]}`} />
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300 flex-1">{label}</span>
        <span className="text-sm font-bold">{value}</span>
      </div>
      {sub && <p className="mt-0.5 pl-4 text-[10px] leading-tight text-slate-400">{sub}</p>}
    </button>
  );
}

function OrganModal({ organ, report, onClose }: { organ: OrganId; report: Report; onClose: () => void }) {
  const check = organState(report.checks, organ);
  const copy = ORGAN_COPY[organ];
  const state: HealthState = check?.state ?? 'unknown';

  const fleetRows = report.fleet;

  return (
    <ModalShell title={copy.label} dotColor={STATE_DOT[state]} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-slate-600 dark:text-slate-300">{copy.what}</p>

        <div className={`rounded-lg border px-3 py-2 text-sm ${STATE_TEXT[state]} ${NODE_STATE_STYLE[state]}`}>
          <b>{check?.summary ?? 'Unknown'}</b>
          {check?.context && <span className="opacity-80"> — {check.context}</span>}
        </div>

        {organ === 'workers' && (
          <>
            <p className="text-xs text-slate-400">
              Shard consistency: {report.shardConsistent ? 'all replicas agree' : 'MISMATCH — replicas disagree on shard configuration'}.
              Total active leases: {report.activeLeases}.
            </p>
            {fleetRows.length > 0 ? (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-slate-400 uppercase tracking-wide">
                    <th className="pb-1 pr-3">Instance</th>
                    <th className="pb-1 pr-3">Role</th>
                    <th className="pb-1 pr-3">Shard</th>
                    <th className="pb-1 pr-3 text-right">Leases</th>
                    <th className="pb-1 text-right">Heartbeat</th>
                  </tr>
                </thead>
                <tbody>
                  {fleetRows.map(w => (
                    <tr key={w.workerId} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="py-1 pr-3 font-mono">{w.instanceId || w.workerId.slice(0, 20)}</td>
                      <td className="py-1 pr-3">{w.rolePrefix}</td>
                      <td className="py-1 pr-3 font-mono">{w.shardId ?? '—'}</td>
                      <td className="py-1 pr-3 text-right">{w.leases}</td>
                      <td className="py-1 text-right text-slate-400">{w.lastHeartbeatAgeSec != null ? `${Math.round(w.lastHeartbeatAgeSec)}s` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-slate-400">No replicas online.</p>
            )}
          </>
        )}

        {organ === 'telegram' && (
          <>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="rounded-lg bg-slate-50 dark:bg-slate-900/50 py-2">
                <p className="text-xl font-bold">{report.telegram.linked}</p>
                <p className="text-[10px] uppercase tracking-wide text-slate-400">linked</p>
              </div>
              <div className="rounded-lg bg-slate-50 dark:bg-slate-900/50 py-2">
                <p className="text-xl font-bold">{report.telegram.listeningNow}</p>
                <p className="text-[10px] uppercase tracking-wide text-slate-400">listening now</p>
              </div>
              <div className="rounded-lg bg-slate-50 dark:bg-slate-900/50 py-2">
                <p className="text-xl font-bold">{report.telegram.authPending}</p>
                <p className="text-[10px] uppercase tracking-wide text-slate-400">mid-login</p>
              </div>
            </div>
            {!report.telegram.truthful && (
              <p className="mt-2 text-xs text-slate-400">
                Estimated from active leases — the live-connectivity health feed
                ({report.telegram.healthReporting ? 'reporting' : 'not reporting yet'})
                isn't being used ({report.telegram.listeningLeases} accounts hold a lease).
              </p>
            )}
            <LinkedNotListening userIds={report.telegram.linkedNotListeningUsers} />
          </>
        )}

        {organ === 'brokers' && (
          <>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="rounded-lg bg-slate-50 dark:bg-slate-900/50 py-2">
                <p className="text-xl font-bold text-success-600 dark:text-success-400">{report.brokers.connected}</p>
                <p className="text-[10px] uppercase tracking-wide text-slate-400">connected</p>
              </div>
              <div className="rounded-lg bg-slate-50 dark:bg-slate-900/50 py-2">
                <p className="text-xl font-bold text-warning-600 dark:text-warning-400">{report.brokers.recovering}</p>
                <p className="text-[10px] uppercase tracking-wide text-slate-400">recovering</p>
              </div>
              <div className="rounded-lg bg-slate-50 dark:bg-slate-900/50 py-2">
                <p className="text-xl font-bold text-error-600 dark:text-error-400">{report.brokers.error}</p>
                <p className="text-[10px] uppercase tracking-wide text-slate-400">error</p>
              </div>
            </div>
            {report.brokers.topErrorKinds.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-1">Error kinds behind the failures</p>
                {report.brokers.topErrorKinds.map(k => (
                  <p key={k.kind} className="text-xs text-slate-600 dark:text-slate-300">{k.count}× {k.kind}</p>
                ))}
              </div>
            )}
            <Link to="/brokers/errors" className="text-xs underline text-primary-600 dark:text-primary-400">Broker errors page →</Link>
          </>
        )}

        {organ === 'railway' && (
          report.railway.available ? (
            <>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <p>Realtime failures: <b>{railwayFmt(report.railway.realtimeFailures)}</b></p>
                <p>Subscriptions healthy: <b>{railwayFmt(report.railway.realtimeSubscribed)}</b></p>
                <p>Rate-limit warnings: <b>{railwayFmt(report.railway.rateLimitWarnings)}</b></p>
                <p>Worker fatals: <b>{railwayFmt(report.railway.workerFatal)}</b></p>
                <p>Uncaught exceptions: <b>{railwayFmt(report.railway.uncaughtExceptions)}</b></p>
                <p>Log lines scanned: <b>{railwayFmt(report.railway.logLines)}</b></p>
              </div>
              {report.railway.topErrorSignatures.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-1">Top error signatures</p>
                  {report.railway.topErrorSignatures.map((s, i) => (
                    <p key={i} className="text-xs font-mono text-slate-600 dark:text-slate-300">{s.count}× {s.message}</p>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-slate-400">
              Railway reading isn't configured yet (needs RAILWAY_TOKEN + RAILWAY_ENV_ID function secrets in the Supabase dashboard). Database leases above still prove workers are alive.
            </p>
          )
        )}
      </div>
    </ModalShell>
  );
}

function railwayFmt(n: number): string {
  return n.toLocaleString();
}

// ---------------------------------------------------------------------------
// The machine — organs feeding the signal journey, all clickable.
// ---------------------------------------------------------------------------

function TheMachine({ report, windowHours }: { report: Report; windowHours: HealthWindow }) {
  const [openStage, setOpenStage] = useState<StageId | null>(null);
  const [openOrgan, setOpenOrgan] = useState<OrganId | null>(null);

  const flow = report.flow;
  const { main, exits } = stageNodes(flow);

  if (!flow.reliable) {
    return (
      <div className="card p-5">
        <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2">The machine</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">Cannot draw the machine — one or more core sources were unreadable. See diagnostics below.</p>
      </div>
    );
  }

  const filtered = exits.find(e => e.id === 'filtered')!;
  const failed = exits.find(e => e.id === 'failed')!;

  return (
    <div className="card p-5 space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">The machine — how a message becomes a copied trade</h2>
        <span className="text-xs text-slate-400">click anything for the full story</span>
      </div>

      <div className="grid lg:grid-cols-[210px_1fr] gap-5">
        {/* Organs rail */}
        <div className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Powered by</p>
          <OrganButton
            check={organState(report.checks, 'workers')}
            label={ORGAN_COPY.workers.label}
            value={String(report.activeLeases)}
            sub={`${report.fleet.length} replica${report.fleet.length !== 1 ? 's' : ''}`}
            onClick={() => setOpenOrgan('workers')}
          />
          <OrganButton
            check={organState(report.checks, 'telegram')}
            label={ORGAN_COPY.telegram.label}
            value={`${report.telegram.listeningNow}/${report.telegram.linked}`}
            sub="listening / linked"
            onClick={() => setOpenOrgan('telegram')}
          />
          <OrganButton
            check={organState(report.checks, 'brokers')}
            label={ORGAN_COPY.brokers.label}
            value={String(report.brokers.connected)}
            sub={`${report.brokers.error} error · ${report.brokers.recovering} recovering`}
            onClick={() => setOpenOrgan('brokers')}
          />
          <OrganButton
            check={organState(report.checks, 'railway')}
            label={ORGAN_COPY.railway.label}
            value={report.railway.available ? (railwayStateShort(report.railway.state)) : '—'}
            sub={report.railway.available ? `${railwayFmt(report.railway.realtimeFailures)} realtime fails` : 'not configured'}
            onClick={() => setOpenOrgan('railway')}
          />
        </div>

        {/* Journey */}
        <div className="space-y-4">
          <div className="overflow-x-auto pb-1">
            <div className="inline-flex items-center min-w-full">
              {main.map((node, i) => (
                <div key={node.id} className="flex items-center">
                  {i > 0 && <FlowLine blocked={node.state === 'fail'} />}
                  <PipelineNode node={node} onClick={() => setOpenStage(node.id)} />
                </div>
              ))}
            </div>
          </div>

          <div className="ml-1 pl-4 space-y-1.5 border-l-2 border-dashed border-slate-200 dark:border-slate-700">
            {[filtered, failed].map(ex => (
              <button
                key={ex.id}
                onClick={() => setOpenStage(ex.id)}
                className={`flex items-center gap-2.5 rounded-lg border px-3 py-1.5 text-left transition-colors ${NODE_STATE_STYLE[ex.state]}`}
              >
                <span className={`h-2 w-2 rounded-full ${STATE_DOT[ex.state]}`} />
                <span className="font-semibold text-sm">{ex.count.toLocaleString()}</span>
                <span className="text-xs">{ex.label}</span>
                <span className="text-[11px] text-slate-400">{ex.note}</span>
              </button>
            ))}
          </div>

          <p className="text-[11px] text-slate-400">
            Speed: parse p95 {fmtDur(flow.latencies[0]?.p95Ms)} · dispatch handoff p95 {fmtDur(flow.latencies[1]?.p95Ms)} · end-to-end p95 {fmtDur(flow.latencies[2]?.p95Ms)}
            {' '}— a sudden jump in any of these is a slowdown before it becomes a blockage.
          </p>
          <p className="text-[11px] text-slate-400">
            These alarms only fire when something is genuinely wrong: signals that should be copied have been stuck for more than {HEALTH_THRESHOLDS.stuckParsedGraceMin} minutes, broker errors are happening more often than usual, or signals were sent to brokers but never got a response.
          </p>
          <p className="text-[11px] text-slate-400">
            Dispatched means entry signals — trades that open new positions. Some signals only manage existing trades (like moving a stop loss) and don't get counted here, which is why Executed can sometimes be higher than Dispatched.
          </p>
        </div>
      </div>

      {openStage && <StageModal stage={openStage} windowHours={windowHours} onClose={() => setOpenStage(null)} />}
      {openOrgan && <OrganModal organ={openOrgan} report={report} onClose={() => setOpenOrgan(null)} />}
    </div>
  );
}

function railwayStateShort(state: 'healthy' | 'degraded' | 'storm' | 'worker_down'): string {
  switch (state) {
    case 'healthy': return 'OK';
    case 'degraded': return 'degraded';
    case 'storm': return 'STORM';
    case 'worker_down': return 'crash';
  }
}

// ---------------------------------------------------------------------------
// Support console — answers "why didn't MY trade copy?"
// ---------------------------------------------------------------------------

const LINKED_NOT_LISTENING_PREVIEW = 6;

interface NotListeningUser {
  user_id: string;
  display_name: string | null;
  sub_status: string;
  copier_paused: boolean;
}

function reasonLabel(r: NotListeningUser): string {
  const flags: string[] = [];
  if (r.sub_status !== 'active' && r.sub_status !== 'trialing') {
    flags.push(r.sub_status === 'none' ? 'no subscription' : r.sub_status.replace('_', ' '));
  }
  if (r.copier_paused) flags.push('copier paused');
  return flags.length > 0 ? flags.join(', ') : 'worker may have dropped';
}

function reasonColor(r: NotListeningUser): string {
  if (r.copier_paused) return 'text-warning-600 dark:text-warning-400';
  if (r.sub_status === 'canceled' || r.sub_status === 'past_due') return 'text-error-500 dark:text-error-400';
  if (r.sub_status === 'none') return 'text-slate-400 dark:text-slate-500';
  return 'text-slate-400 dark:text-slate-500';
}

function LinkedNotListening({ userIds }: { userIds: string[] }) {
  const [users, setUsers] = useState<NotListeningUser[] | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setUsers(null);
    if (userIds.length === 0) return;

    (async () => {
      const chunkSize = 20;
      const results: NotListeningUser[] = [];
      for (let i = 0; i < userIds.length; i += chunkSize) {
        const chunk = userIds.slice(i, i + chunkSize);
        const [names, subs, profiles] = await Promise.all([
          fetchDisplayNames(chunk),
          authSupabase.from('subscriptions').select('user_id, status').in('user_id', chunk),
          authSupabase.from('user_profiles').select('user_id, copier_paused').in('user_id', chunk),
        ]);
        if (cancelled) return;
        for (const uid of chunk) {
          const sub = (subs.data ?? []).find(s => s.user_id === uid);
          const profile = (profiles.data ?? []).find(p => p.user_id === uid);
          results.push({
            user_id: uid,
            display_name: names[uid] ?? null,
            sub_status: sub?.status ?? 'none',
            copier_paused: profile?.copier_paused ?? false,
          });
        }
      }
      if (!cancelled) setUsers(results);
    })();

    return () => { cancelled = true; };
  }, [userIds]);

  if (userIds.length === 0) return null;
  const shown = showAll ? (users ?? []) : (users ?? []).slice(0, LINKED_NOT_LISTENING_PREVIEW);

  return (
    <div className="text-xs text-slate-600 dark:text-slate-300">
      <p className="font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
        Linked but not listening ({userIds.length})
      </p>
      <ul className="mt-1.5 space-y-1">
        {users === null ? (
          <li className="text-slate-400">Loading...</li>
        ) : shown.length === 0 ? (
          <li className="text-slate-400">None found</li>
        ) : shown.map(u => (
          <li key={u.user_id} className="flex items-center gap-2">
            <span className="text-slate-700 dark:text-slate-200">{u.display_name || u.user_id.slice(0, 8)}</span>
            <span className={`font-medium ${reasonColor(u)}`}>{reasonLabel(u)}</span>
          </li>
        ))}
      </ul>
      {userIds.length > LINKED_NOT_LISTENING_PREVIEW && (
        <button onClick={() => setShowAll(v => !v)} className="mt-1.5 text-primary-600 dark:text-primary-400 underline">
          {showAll ? 'Show fewer' : `Show all ${userIds.length}`}
        </button>
      )}
    </div>
  );
}

function SupportConsole({ windowHours }: { windowHours: HealthWindow }) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<UserHealth | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestToken = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; requestToken.current += 1; };
  }, []);

  const submit = useCallback(async () => {
    const id = query.trim();
    if (!id) return;
    const token = ++requestToken.current;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const r = await fetchUserHealth(id, windowHours);
      if (!mounted.current || token !== requestToken.current) return;
      setResult(r);
      setLoading(false);
    } catch (err) {
      if (!mounted.current || token !== requestToken.current) return;
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  }, [query, windowHours]);

  const statusLabel: Record<string, string> = {
    parsed: 'understood', executed: 'copied', failed: 'failed', skipped: 'filtered', pending: 'queued',
  };

  return (
    <div className="card p-5">
      <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-1">Support console</h2>
      <p className="text-xs text-slate-400 mb-3">Paste a user ID — see their last {windowHours}h of signals and every connection they depend on.</p>
      <div className="flex gap-2">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit(); }}
          placeholder="user_id"
          className="flex-1 px-3 py-2 text-sm border rounded-md bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700"
        />
        <button
          onClick={submit}
          disabled={loading || !query.trim()}
          className="px-4 py-2 text-sm rounded-md bg-primary-600 text-white disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Look up'}
        </button>
      </div>

      {error && <p className="mt-3 text-sm text-error-600 dark:text-error-400">{error}</p>}

      {result && (
        <div className="mt-4 space-y-3 text-sm">
          {result.unreadable.length > 0 && (
            <p className="text-xs text-warning-700 dark:text-warning-300">Some sources unreadable: {result.unreadable.join('; ')}</p>
          )}
          <div className="flex gap-6 flex-wrap">
            <span>Received <b>{result.signalCounts.received}</b></span>
            <span>Copied <b>{result.signalCounts.executed}</b></span>
            <span>Failed <b className={result.signalCounts.failed > 0 ? 'text-error-600 dark:text-error-400' : ''}>{result.signalCounts.failed}</b></span>
            <span>Filtered <b>{result.signalCounts.skipped}</b></span>
            <span>Pending <b>{result.signalCounts.pending}</b></span>
          </div>
          <div className="text-xs space-y-1">
            <p>Telegram linked: <b>{result.telegramLinked ? 'yes' : 'no'}</b></p>
            <p>
              Listener: {result.lease
                ? <b className="text-success-600 dark:text-success-400">active (expires {result.lease.expires_at})</b>
                : <span className="text-warning-600 dark:text-warning-400">no live lease</span>}
            </p>
            {result.brokerStates.length > 0
              ? <p>Brokers: {result.brokerStates.map(b => `${b.count} ${b.state}`).join(' · ')}</p>
              : <p>Brokers: <span className="text-slate-400">none found</span></p>}
          </div>
          {result.recentSignals.length > 0 ? (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-400 uppercase tracking-wide">
                  <th className="pb-1 pr-3">Status</th>
                  <th className="pb-1 pr-3">Why</th>
                  <th className="pb-1">Time</th>
                </tr>
              </thead>
              <tbody>
                {result.recentSignals.map(s => (
                  <tr key={s.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="py-1 pr-3">{statusLabel[s.status] ?? s.status}</td>
                    <td className="py-1 pr-3 text-slate-500 dark:text-slate-400">{s.skip_reason ?? '—'}</td>
                    <td className="py-1 text-slate-400">{new Date(s.created_at).toLocaleTimeString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-xs text-slate-400">No signals for this user in the last 24h.</p>
          )}
        </div>
      )}
    </div>
  );
}

const BUCKET_LABEL: Record<ErrorBucketSummary['bucket'], string> = {
  system: 'System', external: 'External', user: 'User account', unclassified: 'Unclassified',
};
const BUCKET_STYLE: Record<ErrorBucketSummary['bucket'], string> = {
  system: 'badge bg-error-100 dark:bg-error-900/40 text-error-700 dark:text-error-300',
  external: 'badge bg-warning-100 dark:bg-warning-900/40 text-warning-700 dark:text-warning-300',
  user: 'badge bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300',
  unclassified: 'badge bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300',
};

function ErrorBucketsTable({ buckets, onSelect }: { buckets: ErrorBucketSummary[]; onSelect: (b: ErrorBucketSummary) => void }) {
  if (buckets.length === 0) return <p className="text-sm text-slate-400">No execution failures in this window.</p>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
          <th className="pb-2">Bucket</th>
          <th className="pb-2">Reason</th>
          <th className="pb-2 text-right">Count</th>
          <th className="pb-2 text-right">Users</th>
          <th className="pb-2 text-right">Escalated</th>
        </tr>
      </thead>
      <tbody>
        {[...buckets].sort((a, b) => b.count - a.count).map(b => (
          <tr
            key={`${b.bucket}:${b.reasonCode}`}
            onClick={() => onSelect(b)}
            className="border-t border-slate-100 dark:border-slate-700 cursor-pointer transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/60"
            title={`View ${b.count} ${b.reasonCode} failures in detail`}
          >
            <td className="py-1.5"><span className={BUCKET_STYLE[b.bucket]}>{BUCKET_LABEL[b.bucket]}</span></td>
            <td className="py-1.5 font-mono text-xs">{b.reasonCode}</td>
            <td className="py-1.5 text-right">{b.count}</td>
            <td className="py-1.5 text-right">{b.distinctUsers}</td>
            <td className="py-1.5 text-right">{b.escalated ? '⚠ yes' : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Failure bucket drill-down — every occurrence behind one reason.
// ---------------------------------------------------------------------------

/**
 * Plain-English explanation of why this failure is or isn't treated as an
 * alarm. States the facts, compares against the week's normal rate, then
 * gives a verdict — written to be understood without knowing the rule.
 */
function escalationStory(bucket: ErrorBucketSummary, baselinePerWindow: number, windowHours: HealthWindow): string {
  const esc = HEALTH_THRESHOLDS.escalation;
  const usual = Math.max(baselinePerWindow, esc.baselineFloor);
  const multiple = bucket.count / usual;
  const fmtUsual = (n: number) => (n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10));
  const fmtTimes = (m: number) => (m >= 10 ? `about ${Math.round(m)} times` : `about ${Math.round(m * 10) / 10} times`);

  const parts: string[] = [];
  parts.push(
    `In the last ${windowHours} hours, this failure happened ${bucket.count} ${bucket.count === 1 ? 'time' : 'times'} `
    + `and affected ${bucket.distinctUsers === 1 ? 'one user' : `${bucket.distinctUsers} different users`}.`,
  );
  parts.push(
    `For context, over the past week the platform averaged roughly ${fmtUsual(usual)} failed executions per `
    + `${windowHours}-hour window across all reasons combined.`,
  );

  if (bucket.escalated) {
    parts.push(
      `This one reason alone is running at ${fmtTimes(multiple)} that normal level — far past the alarm line of five times normal. `
      + `This is not routine; it deserves attention now.`,
    );
    return parts.join(' ');
  }

  const blockers: string[] = [];
  if (bucket.distinctUsers < esc.minDistinctUsers) {
    blockers.push(
      bucket.distinctUsers === 1
        ? 'it touches only one user, so it reads as that user\'s individual situation rather than something shared'
        : `it touches only ${bucket.distinctUsers} users (alarms need at least ${esc.minDistinctUsers})`,
    );
  }
  if (bucket.count < esc.minOccurrences) {
    blockers.push(`it has only happened ${bucket.count} ${bucket.count === 1 ? 'time' : 'times'} (alarms need at least ${esc.minOccurrences} to call it a pattern)`);
  }
  if (multiple <= esc.baselineMultiplier) {
    blockers.push(`this burst sits at ${fmtTimes(multiple)} the normal level, and alarms only fire past five times normal`);
  }

  parts.push(
    `It was not raised as an alarm because ${blockers.join(', and ')}. `
    + `The system treats it as routine background noise rather than a new problem — it stays on this list so you can watch whether that changes.`,
  );
  return parts.join(' ');
}

function ErrorBucketModal({ bucket, baselinePerWindow, windowHours, onClose }: {
  bucket: ErrorBucketSummary;
  baselinePerWindow: number;
  windowHours: HealthWindow;
  onClose: () => void;
}) {
  const [names, setNames] = useState<Record<string, string | null> | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const userIds = useMemo(() => [...new Set(bucket.rows.map(r => r.userId).filter((u): u is string => !!u))], [bucket.rows]);
  const perUser = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of bucket.rows) {
      if (!r.userId) continue;
      map.set(r.userId, (map.get(r.userId) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [bucket.rows]);

  const times = useMemo(() => {
    const t = bucket.rows
      .map(r => r.createdAt ? new Date(r.createdAt).getTime() : null)
      .filter((v): v is number => v != null)
      .sort((a, b) => a - b);
    return t.length ? { first: t[0], last: t[t.length - 1] } : null;
  }, [bucket.rows]);

  useEffect(() => {
    let cancelled = false;
    setNames(null);
    if (userIds.length === 0) return;
    fetchDisplayNames(userIds).then(m => { if (!cancelled) setNames(m); }).catch(() => { if (!cancelled) setNames(null); });
    return () => { cancelled = true; };
  }, [userIds]);

  const fmtTime = (iso: string | null) => iso ? new Date(iso).toLocaleString() : '—';

  return (
    <ModalShell title={<span className="font-mono">{bucket.reasonCode}</span>} dotColor={STATE_DOT.unknown} onClose={onClose} wide>
      <div className="space-y-5">
        {/* Header badges */}
        <div className="flex flex-wrap items-center gap-2">
          <span className={BUCKET_STYLE[bucket.bucket]}>{BUCKET_LABEL[bucket.bucket]}</span>
          <span className="text-xs text-slate-400">failure reason</span>
          {bucket.escalated
            ? <span className="badge bg-warning-100 dark:bg-warning-900/40 text-warning-700 dark:text-warning-300">escalated</span>
            : <span className="badge bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-300">not escalated</span>}
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
          <div className="rounded-lg bg-slate-50 dark:bg-slate-900/50 py-2">
            <p className="text-xl font-bold">{bucket.count}</p>
            <p className="text-[10px] uppercase tracking-wide text-slate-400">occurrences</p>
          </div>
          <div className="rounded-lg bg-slate-50 dark:bg-slate-900/50 py-2">
            <p className="text-xl font-bold">{bucket.distinctUsers}</p>
            <p className="text-[10px] uppercase tracking-wide text-slate-400">users</p>
          </div>
          <div className="rounded-lg bg-slate-50 dark:bg-slate-900/50 py-2">
            <p className="text-xl font-bold">{times ? new Date(times.first).toLocaleString() : '—'}</p>
            <p className="text-[10px] uppercase tracking-wide text-slate-400">first seen</p>
          </div>
          <div className="rounded-lg bg-slate-50 dark:bg-slate-900/50 py-2">
            <p className="text-xl font-bold">{times ? new Date(times.last).toLocaleString() : '—'}</p>
            <p className="text-[10px] uppercase tracking-wide text-slate-400">last seen</p>
          </div>
        </div>

        {/* Plain-English verdict: is this an alarm or background noise? */}
        <div className={`rounded-lg border px-3 py-2.5 text-xs ${bucket.escalated
          ? 'border-warning-300 dark:border-warning-800 bg-warning-50 dark:bg-warning-900/20 text-warning-700 dark:text-warning-300'
          : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/30 text-slate-600 dark:text-slate-300'}`}>
          <p className="font-semibold flex items-center gap-1.5 mb-1">
            {bucket.escalated
              ? <><AlertTriangle className="w-3.5 h-3.5" /> Should someone look at this? Yes — alarm raised</>
              : <><Check className="w-3.5 h-3.5" /> Should someone look at this? No alarm</>}
          </p>
          <p className="leading-relaxed">{escalationStory(bucket, baselinePerWindow, windowHours)}</p>
        </div>

        {/* Affected users */}
        {perUser.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-1.5">
              Affected users ({perUser.length})
            </p>
            <div className="grid sm:grid-cols-2 gap-x-4 gap-y-1.5">
              {perUser.map(([uid, count]) => (
                <div key={uid} className="flex items-center justify-between gap-2 text-xs">
                  <UserLink userId={uid} displayName={names?.[uid] ?? undefined} />
                  <span className="text-slate-400">{count}×</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Every occurrence, expandable */}
        <div>
          <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-1.5">
            Every occurrence ({bucket.rows.length}) — click for raw request/response
          </p>
          {bucket.rows.length === 0 ? (
            <p className="text-sm text-slate-400">No individual rows captured.</p>
          ) : (
            <div className="max-h-[22rem] overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-800">
              {bucket.rows.map(r => {
                const open = expandedId === r.id;
                return (
                  <div key={r.id} className="bg-white dark:bg-slate-800">
                    <button
                      type="button"
                      onClick={() => setExpandedId(open ? null : r.id)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors"
                    >
                      {open ? <ChevronDown className="w-3.5 h-3.5 shrink-0 text-slate-400" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0 text-slate-400" />}
                      <span className="whitespace-nowrap text-xs text-slate-400 w-36 shrink-0">{fmtTime(r.createdAt)}</span>
                      <span className="flex-1 truncate">
                        {r.userId
                          ? <UserLink userId={r.userId} displayName={names?.[r.userId] ?? undefined} />
                          : <span className="text-slate-400 text-xs">no user</span>}
                      </span>
                      {r.action && <span className="text-xs font-mono text-slate-500 dark:text-slate-400 shrink-0">{r.action}</span>}
                      <span className="text-xs text-slate-500 dark:text-slate-300 shrink-0 max-w-[26rem] truncate">{r.errorMessage ?? 'no message'}</span>
                    </button>

                    {open && (
                      <div className="px-3 pb-3 pt-1 space-y-3">
                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-0.5">Error message</p>
                          <p className="text-xs text-slate-600 dark:text-slate-300 break-words whitespace-pre-wrap bg-slate-50 dark:bg-slate-900/40 rounded-md px-2.5 py-2 border border-slate-200 dark:border-slate-700">
                            {r.errorMessage ?? 'No message recorded.'}
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-slate-500 dark:text-slate-400">
                          <span className="flex items-center gap-1.5"><UserIcon className="w-3 h-3" /> {r.userId ?? '—'}</span>
                          <span className="flex items-center gap-1.5"><Crosshair className="w-3 h-3" /> signal: {r.signalId ?? '—'}</span>
                          <span className="flex items-center gap-1.5"><Wifi className="w-3 h-3" /> broker: {r.brokerAccountId ?? '—'}</span>
                          <span className="flex items-center gap-1.5"><Activity className="w-3 h-3" /> log: <span className="font-mono">{r.id.slice(0, 8)}</span></span>
                        </div>

                        <div className="space-y-2">
                          <JsonViewer data={r.requestPayload ?? null} label="Request payload" />
                          <JsonViewer data={r.responsePayload ?? null} label="Response payload" />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex gap-3 pt-1">
          <Link to="/trades/execution-logs" className="text-xs underline text-primary-600 dark:text-primary-400">Execution logs →</Link>
        </div>
      </div>
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function SystemHealthPage() {
  const [windowHours, setWindowHours] = useState<HealthWindow>(24);
  const [report, setReport] = useState<Report | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(Date.now());
  const backoffMs = useRef(REFRESH_MS);
  const env = getAdminEnv();
  const envConfig = ENVIRONMENTS[env];
  const [openBucketKey, setOpenBucketKey] = useState<string | null>(null);

  const refresh = useCallback(async (isCancelled: () => boolean): Promise<boolean> => {
    try {
      const r = await fetchSystemHealth(windowHours);
      if (isCancelled()) return false;
      if (!r.dbReachable) {
        setLoadError(r.unreadableSources[0] ?? 'database unreachable');
      } else {
        setLoadError(null);
        backoffMs.current = REFRESH_MS;
        setLastSuccessAt(Date.now());
      }
      const stabilized = applyHysteresis(r.checks, windowHours);
      setReport({ ...r, checks: stabilized });
      setVerdict(computeVerdict(r, stabilized));
      return r.dbReachable;
    } catch (err) {
      if (!isCancelled()) setLoadError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }, [windowHours]);

  useEffect(() => {
    let timer: number | undefined;
    let cancelled = false;
    let consecutiveFailures = 0;
    const tick = async () => {
      const ok = await refresh(() => cancelled);
      consecutiveFailures = ok ? 0 : consecutiveFailures + 1;
      if (!ok && consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        backoffMs.current = Math.min(backoffMs.current * 2, 300_000);
      }
      if (!cancelled) timer = window.setTimeout(tick, backoffMs.current);
    };
    void tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [refresh]);

  useEffect(() => {
    const t = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const staleBanner = useMemo(() => {
    if (!loadError || !lastSuccessAt) return null;
    return `Cannot reach database (${loadError}) — showing data from ${new Date(lastSuccessAt).toLocaleTimeString()}.`;
  }, [loadError, lastSuccessAt]);

  const verdictBorder =
    verdict?.state === 'healthy' ? 'border-l-success-500'
    : verdict?.state === 'attention' ? 'border-l-warning-500'
    : verdict?.state === 'failing' ? 'border-l-error-500'
    : 'border-l-slate-400';

  const routineUserErrors = report?.errorBuckets
    .filter(b => b.bucket === 'user')
    .reduce((a, b) => a + b.count, 0) ?? 0;

  const openBucket = report?.errorBuckets.find(b => `${b.bucket}:${b.reasonCode}` === openBucketKey) ?? null;

  return (
    <div className="space-y-5 animate-fade-in">
      {/* WHAT + WHEN — the honest mouth of the page */}
      <div className={`card border-l-4 ${verdictBorder} p-5`}>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="page-title">Systems Health</h1>
            <p className="page-subtitle">
              <b className={verdict ? STATE_TEXT[verdict.state === 'undetermined' ? 'unknown' : verdict.state === 'failing' ? 'fail' : verdict.state === 'attention' ? 'warn' : 'ok'].replace('text-', 'text-') : ''}>
                {verdict?.sentence ?? 'Checking…'}
              </b>
              {' · '}
              <span className="font-medium">{envConfig.label}</span>
              {report && <span className="text-xs"> · showing last {windowHours}h</span>}
              {lastSuccessAt && <span className="text-xs"> · checked {Math.max(0, Math.round((nowTick - lastSuccessAt) / 1000))}s ago</span>}
            </p>
          </div>
          <div className="flex gap-1">
            {([1, 6, 24] as HealthWindow[]).map(h => (
              <button
                key={h}
                onClick={() => setWindowHours(h)}
                className={`px-3 py-1.5 text-xs rounded-md border transition-colors ${
                  windowHours === h
                    ? 'bg-primary-600 text-white border-primary-600'
                    : 'bg-transparent text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700 hover:border-primary-300'
                }`}
              >
                {h}h
              </button>
            ))}
          </div>
        </div>
      </div>

      {staleBanner && (
        <div className="rounded-md bg-warning-50 dark:bg-warning-900/30 border border-warning-300 dark:border-warning-700 px-4 py-2 text-sm text-warning-700 dark:text-warning-300">
          {staleBanner}
        </div>
      )}

      {!report ? (
        <div className="card p-6"><div className="skeleton h-40 w-full" /></div>
      ) : (
        <>
          <TheMachine report={report} windowHours={report.windowHours} />

          <div className="grid lg:grid-cols-2 gap-5">
            <SupportConsole windowHours={windowHours} />

            <details className="card p-5">
              <summary className="cursor-pointer text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                Failure details
                {report.unreadableSources.length > 0 ? ` · ${report.unreadableSources.length} unreadable source${report.unreadableSources.length !== 1 ? 's' : ''}` : ''}
              </summary>
              <div className="mt-4 space-y-4">
                {report.railway.available && report.railway.topErrorSignatures.length > 0 && (
                  <div className="text-xs">
                    <p className="font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-1">Top error signatures (Railway logs)</p>
                    {report.railway.topErrorSignatures.map((s, i) => (
                      <p key={i} className="font-mono text-slate-600 dark:text-slate-300">{s.count}× {s.message}</p>
                    ))}
                  </div>
                )}
                {report.unreadableSources.length > 0 && (
                  <div className="text-xs text-error-600 dark:text-error-400 space-y-1">
                    {report.unreadableSources.map(s => <p key={s}>{s}</p>)}
                  </div>
                )}
                <ErrorBucketsTable
                  buckets={report.errorBuckets}
                  onSelect={b => setOpenBucketKey(`${b.bucket}:${b.reasonCode}`)}
                />
                {routineUserErrors > 0 && (
                  <p className="text-xs text-slate-400">
                    {routineUserErrors} of these are routine user-account issues — individual situations, not system problems.
                  </p>
                )}
                <p className="text-xs text-slate-400">
                  Escalation rule: ≥{HEALTH_THRESHOLDS.escalation.minDistinctUsers} users AND ≥{HEALTH_THRESHOLDS.escalation.minOccurrences} occurrences AND &gt;{HEALTH_THRESHOLDS.escalation.baselineMultiplier}× baseline.
                  Clock offset vs DB: {report.clockOffsetMs >= 0 ? '+' : ''}{Math.round(report.clockOffsetMs / 1000)}s.
                </p>
              </div>
            </details>
          </div>

          {openBucket && (
            <ErrorBucketModal
              bucket={openBucket}
              baselinePerWindow={report.failureBaselinePerWindow}
              windowHours={report.windowHours}
              onClose={() => setOpenBucketKey(null)}
            />
          )}
        </>
      )}
    </div>
  );
}
