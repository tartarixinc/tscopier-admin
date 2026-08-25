import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  applyHysteresis,
  computeVerdict,
  fetchSystemHealth,
  HEALTH_THRESHOLDS,
  type CheckResult,
  type HealthState,
  type HealthWindow,
  type PipelineFunnel,
  type ErrorBucketSummary,
} from '../lib/systemHealth';
import { ENVIRONMENTS, getAdminEnv } from '../lib/environment';

const REFRESH_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;

type Verdict = ReturnType<typeof computeVerdict>;

const STATE_STYLES: Record<HealthState, string> = {
  ok: 'bg-success-50 dark:bg-success-900/20 border-success-300 dark:border-success-700 text-success-700 dark:text-success-300',
  warn: 'bg-warning-50 dark:bg-warning-900/20 border-warning-300 dark:border-warning-700 text-warning-700 dark:text-warning-300',
  fail: 'bg-error-50 dark:bg-error-900/20 border-error-300 dark:border-error-700 text-error-700 dark:text-error-300',
  unknown: 'bg-slate-100 dark:bg-slate-800 border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300',
};

function Tile({ check }: { check: CheckResult }) {
  return (
    <div className={`border rounded-lg p-4 h-full transition-shadow hover:shadow-md ${STATE_STYLES[check.state]}`} title={check.detail ?? check.summary}>
      <p className="text-xs font-semibold uppercase tracking-wide opacity-70">{check.label}</p>
      <p className="mt-1 text-sm font-medium leading-snug">{check.summary}</p>
    </div>
  );
}

function PipelineStrip({ funnel, windowHours }: { funnel: PipelineFunnel; windowHours: HealthWindow }) {
  const stages: Array<{ label: string; count: number; to: string }> = [
    { label: 'Received', count: funnel.received, to: '/signals' },
    { label: 'Parsed', count: funnel.parsed, to: '/signals' },
    { label: 'Dispatched', count: funnel.dispatched, to: '/monitoring/listener-events' },
    { label: 'Executed', count: funnel.executed, to: '/trades/execution-logs' },
  ];
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Signal pipeline — last {windowHours}h</h2>
        <span className="text-xs text-slate-400">Log-based counts approximate (retention keeps newest 500/user)</span>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {stages.map((s, i) => (
          <div key={s.label} className="flex items-center gap-2">
            {i > 0 && <span className="text-slate-300 dark:text-slate-600 text-xl">→</span>}
            <Link
              to={s.to}
              className={`block border rounded-lg px-4 py-3 text-center min-w-[92px] transition-colors ${
                i === funnel.blockedStage
                  ? 'border-warning-400 bg-warning-50 dark:bg-warning-900/30'
                  : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:border-primary-300'
              }`}
              title={i === funnel.blockedStage && funnel.blockageDetail ? funnel.blockageDetail : undefined}
            >
              <p className={`text-2xl font-semibold ${i === funnel.blockedStage ? 'text-warning-600 dark:text-warning-400' : ''}`}>{s.count}</p>
              <p className="text-xs text-slate-500 dark:text-slate-400">{s.label}</p>
            </Link>
          </div>
        ))}
      </div>
      {funnel.blockageDetail && (
        <p className="mt-3 text-xs text-warning-700 dark:text-warning-300">{funnel.blockageDetail}</p>
      )}
    </div>
  );
}

function ErrorBucketsTable({ buckets }: { buckets: ErrorBucketSummary[] }) {
  if (buckets.length === 0) return <p className="text-sm text-slate-400">No execution failures in this window.</p>;
  const bucketLabel: Record<ErrorBucketSummary['bucket'], string> = {
    system: 'System',
    external: 'External',
    user: 'User account',
    unclassified: 'Unclassified',
  };
  const bucketStyle: Record<ErrorBucketSummary['bucket'], string> = {
    system: 'badge bg-error-100 dark:bg-error-900/40 text-error-700 dark:text-error-300',
    external: 'badge bg-warning-100 dark:bg-warning-900/40 text-warning-700 dark:text-warning-300',
    user: 'badge bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300',
    unclassified: 'badge bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300',
  };
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
          <tr key={`${b.bucket}:${b.reasonCode}`} className="border-t border-slate-100 dark:border-slate-700">
            <td className="py-1.5"><span className={bucketStyle[b.bucket]}>{bucketLabel[b.bucket]}</span></td>
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

export function SystemHealthPage() {
  const [windowHours, setWindowHours] = useState<HealthWindow>(24);
  const [report, setReport] = useState<Awaited<ReturnType<typeof fetchSystemHealth>> | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);
  const backoffMs = useRef(REFRESH_MS);
  const env = getAdminEnv();
  const envConfig = ENVIRONMENTS[env];

  const refresh = useCallback(async (isCancelled: () => boolean): Promise<boolean> => {
    try {
      const r = await fetchSystemHealth(windowHours);
      if (isCancelled()) return false;
      // An unreachable/partially-readable database is a failure for the
      // purposes of the stale-data banner and backoff (review fix #2).
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
      if (!isCancelled()) {
        setLoadError(err instanceof Error ? err.message : String(err));
      }
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

  // Keep the "checked Ns ago" stamp honest between refreshes.
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const staleBanner = useMemo(() => {
    if (!loadError || !lastSuccessAt) return null;
    return `Cannot reach database (${loadError}) — showing data from ${new Date(lastSuccessAt).toLocaleTimeString()}.`;
  }, [loadError, lastSuccessAt]);

  const routineUserErrors = report?.errorBuckets
    .filter(b => b.bucket === 'user' && !b.escalated)
    .reduce((a, b) => a + b.count, 0) ?? 0;

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="page-header flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="page-title">Systems Health</h1>
          <p className="page-subtitle">
            {verdict?.sentence ?? 'Checking…'}
            {' · '}
            <span className="font-medium">{envConfig.label}</span>
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

      {staleBanner && (
        <div className="rounded-md bg-warning-50 dark:bg-warning-900/30 border border-warning-300 dark:border-warning-700 px-4 py-2 text-sm text-warning-700 dark:text-warning-300">
          {staleBanner}
        </div>
      )}

      {!report ? (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="card p-6"><div className="skeleton h-16 w-full" /></div>
          ))}
        </div>
      ) : (
        <>
          {/* Layer 2 — six plain-word tiles */}
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            {report.checks.map(c => <Tile key={c.id} check={c} />)}
          </div>

          {/* Layer 3 — pipeline blockage strip */}
          <PipelineStrip funnel={report.funnel} windowHours={report.windowHours} />

          {/* Routine noise line — present but explicitly non-alarming */}
          {routineUserErrors > 0 && (
            <p className="text-xs text-slate-400">
              {routineUserErrors} routine account-level rejection{routineUserErrors !== 1 ? 's' : ''} in this window
              {' '}(<Link to="/brokers/errors" className="underline hover:text-slate-500">view</Link>) —
              these are individual user situations and do not affect system health.
            </p>
          )}

          {/* Collapsed details */}
          {(report.errorBuckets.length > 0 || report.unreadableSources.length > 0) && (
            <details className="card p-5">
              <summary className="cursor-pointer text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                Show details{report.unreadableSources.length > 0 ? ` · ${report.unreadableSources.length} unreadable source${report.unreadableSources.length !== 1 ? 's' : ''}` : ''}
              </summary>
              <div className="mt-4 space-y-4">
                {report.unreadableSources.length > 0 && (
                  <div className="text-xs text-error-600 dark:text-error-400 space-y-1">
                    {report.unreadableSources.map(s => <p key={s}>{s}</p>)}
                  </div>
                )}
                <ErrorBucketsTable buckets={report.errorBuckets} />
                <p className="text-xs text-slate-400">
                  Escalation rule: ≥{HEALTH_THRESHOLDS.escalation.minDistinctUsers} users AND ≥{HEALTH_THRESHOLDS.escalation.minOccurrences} occurrences AND &gt;{HEALTH_THRESHOLDS.escalation.baselineMultiplier}× baseline.
                  Clock offset vs database: {report.clockOffsetMs >= 0 ? '+' : ''}{Math.round(report.clockOffsetMs / 1000)}s.
                </p>
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}
