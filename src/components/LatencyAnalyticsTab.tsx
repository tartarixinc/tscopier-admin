import { useEffect, useMemo, useState } from 'react';
import { authSupabase as adminSupabase } from '../lib/adminSupabase';
import { formatDate } from '../lib/formatters';
import { Card, CardHeader, CardContent } from './ui/Card';
import { Select } from './ui/Select';
import { SignalDetailModal } from './SignalDetailModal';
import { parsePipelineTimestamps, computeStageDurations, STAGE_STAT_LABELS } from '../lib/pipelineTimeline';
import { CHART_PALETTE, tooltipStyle, gridStyle, axisStyle } from '../lib/chartTheme';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend,
  ScatterChart, Scatter, ZAxis, Cell,
} from 'recharts';
import clsx from 'clsx';

interface LatencyStat {
  key: string;
  label: string;
  count: number;
  avg: number;
  p50: number;
  p95: number;
}

interface DailyPoint {
  date: string;
  p50: number;
  p95: number;
  count: number;
}

interface ScatterPoint {
  signalId: string;
  openedAtMs: number;
  totalMs: number;
}

interface DrillRow {
  signalId: string;
  openedAtMs: number;
  totalMs: number;
  slowKey: string | null;
  slowMs: number;
}

type DrillFilter = 'all' | 'fast' | 'slow' | 'critical';

interface FailureStats {
  totalAttempts: number;
  failed: number;
  skipped: number;
  retriedSignals: number;
  retryAddedMsAvg: number | null;
  retryAddedMsP95: number | null;
  worst: { signalId: string; attempts: number; failed: number; addedMs: number }[];
}

interface DailyFailurePoint {
  date: string;
  failed: number;
  skipped: number;
  success: number;
}

const CHUNK_SIZE = 400;
const SIGNAL_CAP = 10000;
const SCATTER_CAP = 3000;
const DRILL_CAP = 500;

// Speed thresholds used everywhere on this page (green / amber / red).
const FAST_MS = 500;
const CRITICAL_MS = 2000;

// Plain-English meaning of each pipeline stage (tooltips + callout).
const STAGE_GLOSSARY: Record<string, string> = {
  telegram_to_listener_ms: 'Telegram servers delivering the message to our listener',
  parse_ms: 'Reading the message and extracting the trade (incl. AI parse)',
  signal_persist_ms: 'Saving the signal to the database',
  dispatch_ms: 'Pushing the signal into the execution queue',
  queue_wait_ms: 'Time spent waiting in the queue for a worker',
  prep_ms: 'Preparing before execution (broker session, params)',
  planning_ms: 'Building the order plan (lots, SL/TP, legs)',
  execution_claim_ms: 'Claiming an execution slot so only one worker runs it',
  order_send_ms: 'Sending the order to the broker',
  broker_send_ms: 'Broker round-trip: request sent until response received',
  broker_ack_ms: 'Broker confirming the execution',
  broker_resolve_ms: 'Connecting to / resolving the broker session',
  reconciliation_ms: 'Final check that the trade matches the signal',
  telegram_receipt_to_broker_request_ms: 'Whole path: message received → order sent',
  telegram_receipt_to_broker_confirmation_ms: 'Whole path: message received → execution confirmed',
  total_ms: 'Complete journey from Telegram to done',
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function formatMs(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function toneFor(ms: number | null): 'success' | 'warning' | 'error' {
  if (ms == null) return 'success';
  if (ms < FAST_MS) return 'success';
  if (ms < CRITICAL_MS) return 'warning';
  return 'error';
}

const TONE_TEXT: Record<'success' | 'warning' | 'error', string> = {
  success: 'text-success-600 dark:text-success-400',
  warning: 'text-warning-600 dark:text-warning-400',
  error: 'text-error-600 dark:text-error-400',
};

export function LatencyAnalyticsTab({ rangeDays }: { rangeDays: number | null }) {
  const [stats, setStats] = useState<LatencyStat[]>([]);
  const [daily, setDaily] = useState<DailyPoint[]>([]);
  const [scatter, setScatter] = useState<ScatterPoint[]>([]);
  const [failures, setFailures] = useState<FailureStats>({
    totalAttempts: 0,
    failed: 0,
    skipped: 0,
    retriedSignals: 0,
    retryAddedMsAvg: null,
    retryAddedMsP95: null,
    worst: [],
  });
  const [dailyFailures, setDailyFailures] = useState<DailyFailurePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [tradeCount, setTradeCount] = useState(0);
  const [withPipeline, setWithPipeline] = useState(0);
  const [capped, setCapped] = useState(false);
  const [drillRows, setDrillRows] = useState<DrillRow[]>([]);
  const [drillFilter, setDrillFilter] = useState<DrillFilter>('all');
  const [selectedSignalId, setSelectedSignalId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setStats([]);
    setDaily([]);
    setScatter([]);
    setFailures({ totalAttempts: 0, failed: 0, skipped: 0, retriedSignals: 0, retryAddedMsAvg: null, retryAddedMsP95: null, worst: [] });
    setDailyFailures([]);
    setTradeCount(0);
    setWithPipeline(0);
    setCapped(false);
    setDrillRows([]);
    setDrillFilter('all');
    setSelectedSignalId(null);

    (async () => {
      const signalIds: string[] = [];
      const seen = new Set<string>();
      const openedAtBySignal = new Map<string, number>();

      for (let page = 0; page < 200; page += 1) {
        if (cancelled) return;
        const fromIdx = page * 1000;
        let pageQ = adminSupabase
          .from('trades')
          .select('signal_id, opened_at', { count: 'exact' })
          .eq('status', 'closed')
          .not('signal_id', 'is', null)
          .order('opened_at', { ascending: false });

        if (rangeDays != null) {
          const from = new Date();
          from.setDate(from.getDate() - rangeDays);
          pageQ = pageQ.gte('opened_at', from.toISOString());
        }

        const { data, count } = await pageQ.range(fromIdx, fromIdx + 999);

        for (const row of (data ?? []) as { signal_id: string | null; opened_at: string | null }[]) {
          if (row.signal_id && !seen.has(row.signal_id)) {
            seen.add(row.signal_id);
            signalIds.push(row.signal_id);
            if (row.opened_at) openedAtBySignal.set(row.signal_id, new Date(row.opened_at).getTime());
          }
        }

        if (cancelled) return;
        const total = count ?? 0;
        const fetched = fromIdx + ((data ?? []).length || 0);
        if (signalIds.length >= SIGNAL_CAP) {
          setCapped(true);
          break;
        }
        if (fetched >= total || (data ?? []).length === 0) break;
      }

      if (cancelled) return;
      setTradeCount(signalIds.length);

      const byStage: Record<string, number[]> = {};
      const drill: DrillRow[] = [];
      let withTs = 0;

      for (let i = 0; i < signalIds.length; i += CHUNK_SIZE) {
        if (cancelled) return;
        const chunk = signalIds.slice(i, i + CHUNK_SIZE);
        const { data: signalRows } = await adminSupabase
          .from('signals')
          .select('id, pipeline_ts')
          .in('id', chunk);

        for (const row of (signalRows ?? []) as { id: string; pipeline_ts: unknown }[]) {
          const ts = parsePipelineTimestamps(row.pipeline_ts);
          if (!ts) continue;
          withTs += 1;
          const durations = computeStageDurations(ts);
          let slowKey: string | null = null;
          let slowMs = 0;
          for (const [key, value] of Object.entries(durations)) {
            if (value == null) continue;
            if (key === 'total_ms' || key === 'telegram_receipt_to_broker_request_ms' || key === 'telegram_receipt_to_broker_confirmation_ms') continue;
            (byStage[key] ??= []).push(value);
            if (value > slowMs) {
              slowMs = value;
              slowKey = key;
            }
          }
          const totalMs = durations.total_ms;
          if (totalMs != null) {
            drill.push({
              signalId: row.id,
              openedAtMs: openedAtBySignal.get(row.id) ?? 0,
              totalMs,
              slowKey,
              slowMs,
            });
          }
        }
      }

      if (cancelled) return;
      setWithPipeline(withTs);

      const sortedDrill = [...drill].sort((a, b) => b.openedAtMs - a.openedAtMs);
      setDrillRows(sortedDrill.slice(0, DRILL_CAP));
      setScatter(sortedDrill
        .filter(p => p.openedAtMs > 0)
        .slice(0, SCATTER_CAP)
        .map(p => ({ signalId: p.signalId, openedAtMs: p.openedAtMs, totalMs: p.totalMs })));

      const computed: LatencyStat[] = Object.entries(byStage)
        .map(([key, values]) => {
          const sorted = [...values].sort((a, b) => a - b);
          const sum = sorted.reduce((acc, v) => acc + v, 0);
          return {
            key,
            label: STAGE_STAT_LABELS[key] ?? key,
            count: sorted.length,
            avg: sum / sorted.length,
            p50: percentile(sorted, 50),
            p95: percentile(sorted, 95),
          };
        })
        .sort((a, b) => a.p50 - b.p50);

      setStats(computed);

      const dailyMap = new Map<string, number[]>();
      for (const point of drill) {
        const date = point.openedAtMs > 0 ? new Date(point.openedAtMs).toISOString().slice(0, 10) : null;
        if (!date) continue;
        const bucket = dailyMap.get(date) ?? [];
        bucket.push(point.totalMs);
        dailyMap.set(date, bucket);
      }
      setDaily([...dailyMap.entries()]
        .map(([date, values]) => {
          const sorted = [...values].sort((a, b) => a - b);
          return { date, p50: percentile(sorted, 50), p95: percentile(sorted, 95), count: values.length };
        })
        .sort((a, b) => a.date.localeCompare(b.date)));

      const perSignalLogs = new Map<string, { attempts: number; failed: number; skipped: number; firstMs: number; lastMs: number }>();
      const dailyFailMap = new Map<string, { failed: number; skipped: number; success: number }>();
      let totalAttempts = 0;
      let totalFailed = 0;
      let totalSkipped = 0;

      for (let i = 0; i < signalIds.length; i += CHUNK_SIZE) {
        if (cancelled) return;
        const chunk = signalIds.slice(i, i + CHUNK_SIZE);
        const { data: logRows } = await adminSupabase
          .from('trade_execution_logs')
          .select('signal_id, status, created_at')
          .in('signal_id', chunk);

        for (const row of (logRows ?? []) as { signal_id: string; status: string; created_at: string }[]) {
          const status = row.status;
          if (status !== 'failed' && status !== 'skipped' && status !== 'success' && status !== 'attempt') continue;
          const sig = perSignalLogs.get(row.signal_id) ?? { attempts: 0, failed: 0, skipped: 0, firstMs: 0, lastMs: 0 };
          const createdMs = row.created_at ? new Date(row.created_at).getTime() : 0;
          sig.attempts += 1;
          if (status === 'failed') sig.failed += 1;
          if (status === 'skipped') sig.skipped += 1;
          if (createdMs > 0) {
            if (sig.firstMs === 0 || createdMs < sig.firstMs) sig.firstMs = createdMs;
            if (createdMs > sig.lastMs) sig.lastMs = createdMs;
          }
          perSignalLogs.set(row.signal_id, sig);

          const date = row.created_at ? row.created_at.slice(0, 10) : null;
          if (date) {
            const bucket = dailyFailMap.get(date) ?? { failed: 0, skipped: 0, success: 0 };
            if (status === 'failed') bucket.failed += 1;
            else if (status === 'skipped') bucket.skipped += 1;
            else bucket.success += 1;
            dailyFailMap.set(date, bucket);
          }
        }
      }

      if (cancelled) return;
      const addedMsList: number[] = [];
      let retriedSignals = 0;
      const worst: FailureStats['worst'] = [];
      for (const [signalId, sig] of perSignalLogs.entries()) {
        totalAttempts += sig.attempts;
        totalFailed += sig.failed;
        totalSkipped += sig.skipped;
        if (sig.attempts > 1) {
          retriedSignals += 1;
          const addedMs = Math.max(0, sig.lastMs - sig.firstMs);
          addedMsList.push(addedMs);
          worst.push({ signalId, attempts: sig.attempts, failed: sig.failed, addedMs });
        }
      }
      worst.sort((a, b) => b.addedMs - a.addedMs);
      const addedSorted = [...addedMsList].sort((a, b) => a - b);
      setFailures({
        totalAttempts,
        failed: totalFailed,
        skipped: totalSkipped,
        retriedSignals,
        retryAddedMsAvg: addedSorted.length > 0 ? addedSorted.reduce((a, b) => a + b, 0) / addedSorted.length : null,
        retryAddedMsP95: addedSorted.length > 0 ? percentile(addedSorted, 95) : null,
        worst: worst.slice(0, 10),
      });
      setDailyFailures([...dailyFailMap.entries()]
        .map(([date, b]) => ({ date, failed: b.failed, skipped: b.skipped, success: b.success }))
        .sort((a, b) => a.date.localeCompare(b.date)));

      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [rangeDays]);

  const chartData = useMemo(
    () => stats.filter(s => s.key !== 'total_ms').map(s => ({ key: s.key, label: s.label, p50: Math.round(s.p50) })),
    [stats],
  );

  const totalStat = stats.find(s => s.key === 'total_ms') ?? null;
  const medianTotal = totalStat?.p50 ?? null;
  const p95Total = totalStat?.p95 ?? null;
  const failureRate = failures.totalAttempts > 0 ? (failures.failed / failures.totalAttempts) * 100 : 0;
  const failureTone: 'success' | 'warning' | 'error' = failures.failed === 0 ? 'success' : failureRate < 10 ? 'warning' : 'error';

  // Slowest stages first (biggest bars at the top).
  const sortedChartData = useMemo(() => [...chartData].sort((a, b) => b.p50 - a.p50), [chartData]);
  const slowestStages = useMemo(() => sortedChartData.slice(0, 3), [sortedChartData]);

  const visibleDrill = useMemo(() => {
    if (drillFilter === 'all') return drillRows;
    return drillRows.filter(d => {
      if (drillFilter === 'fast') return d.totalMs < FAST_MS;
      if (drillFilter === 'slow') return d.totalMs >= FAST_MS && d.totalMs < CRITICAL_MS;
      return d.totalMs >= CRITICAL_MS;
    });
  }, [drillRows, drillFilter]);

  if (loading) {
    return <div className="card p-6 skeleton h-72" />;
  }

  return (
    <div className="space-y-6">
      {/* Speed legend — the color language used everywhere below */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
        <span className="font-semibold uppercase tracking-wider text-[10px]">Speed legend</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-success-500" /> Fast — under {formatMs(FAST_MS)}</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-amber-500" /> Slow — {formatMs(FAST_MS)} to {formatMs(CRITICAL_MS)}</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-error-500" /> Critical — over {formatMs(CRITICAL_MS)}</span>
      </div>

      {/* Headline — how fast is the copier, right now */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <HealthPill label="Signals analyzed" value={withPipeline.toLocaleString()} tone="neutral" hint={`${tradeCount.toLocaleString()} closed trades in range — of which ${withPipeline.toLocaleString()} have latency data (telemetry began 2026-07-24)`} />
        <HealthPill
          label="Typical journey (median)"
          value={formatMs(medianTotal)}
          tone={toneFor(medianTotal)}
          hint="How long half of all signals take from Telegram to broker confirmation. Under 0.5s is healthy."
        />
        <HealthPill
          label="Slowest 5% (p95)"
          value={formatMs(p95Total)}
          tone={toneFor(p95Total)}
          hint="The worst 5% of journeys take at least this long — the tail you want to shrink."
        />
        <HealthPill
          label="Failed attempts"
          value={failures.failed.toLocaleString()}
          tone={failureTone}
          hint={failures.totalAttempts > 0 ? `${failureRate.toFixed(1)}% of ${failures.totalAttempts.toLocaleString()} execution attempts failed.` : 'No execution attempts in this range.'}
        />
      </div>

      {capped && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Analysis capped at the first {SIGNAL_CAP.toLocaleString()} signals for this range — refine the range for full coverage.
        </p>
      )}

      {tradeCount > 0 && withPipeline === 0 && (
        <p className="text-xs text-slate-400">
          No pipeline timestamps found. Pipeline telemetry began on 2026-07-24 (migration 20260724120000_signals_pipeline_ts) — trades older than that have no latency data.
        </p>
      )}

      {/* Trend over time */}
      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold">Journey time over time</h3>
          <p className="text-xs text-slate-400">
            How long a signal takes from Telegram to broker confirmation, per day. Read it like a health chart: a rising line means the system is getting slower.
            Teal = typical journey (median), red = slowest 5%.
          </p>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={daily}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" {...axisStyle} tickFormatter={d => d.slice(5)} interval="preserveStartEnd" />
              <YAxis {...axisStyle} tickFormatter={v => formatMs(v as number)} />
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(v, name) => [formatMs(Number(v)), name === 'p50' ? 'Typical (median)' : 'Slowest 5% (p95)']}
                labelFormatter={(label, payload) => `Date: ${label} — ${(payload?.[0]?.payload as { count?: number } | undefined)?.count ?? 0} trades`}
              />
              <Legend />
              <Line type="monotone" dataKey="p50" name="Typical (median)" stroke={CHART_PALETTE[0]} strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="p95" name="Slowest 5% (p95)" stroke="#ef4444" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Where the time goes */}
      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold">Where the time goes</h3>
          <p className="text-xs text-slate-400">
            Typical (median) time spent in each stage of the journey, slowest first. Red and amber stages are where delay accumulates — hover a stage for its meaning.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {slowestStages.length > 0 && (
            <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40 px-4 py-3">
              <p className="text-xs text-slate-600 dark:text-slate-300">
                <span className="font-semibold text-slate-800 dark:text-slate-100">Most time is spent in:</span>{' '}
                {slowestStages.map((s, i) => (
                  <span key={s.key}>
                    {i > 0 && ', '}
                    <span className={clsx('font-medium', TONE_TEXT[toneFor(s.p50)])}>
                      {s.label} ({formatMs(s.p50)})
                    </span>
                  </span>
                ))}
                .
                {slowestStages[0] && (
                  <span className="block mt-1 text-slate-500 dark:text-slate-400">
                    {slowestStages[0].label} = {STAGE_GLOSSARY[slowestStages[0].key] ?? 'see table below'}.
                  </span>
                )}
              </p>
            </div>
          )}
          <ResponsiveContainer width="100%" height={Math.max(250, chartData.length * 28)}>
            <BarChart data={sortedChartData} layout="vertical" margin={{ left: 8, right: 24 }}>
              <CartesianGrid {...gridStyle} horizontal={false} />
              <XAxis type="number" {...axisStyle} tickFormatter={v => formatMs(v as number)} />
              <YAxis type="category" dataKey="label" width={190} {...axisStyle} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v) => [formatMs(Number(v)), 'Typical (median)']} labelFormatter={(label, payload) => {
                const key = (payload?.[0]?.payload as { key?: string } | undefined)?.key ?? '';
                return `${label} — ${STAGE_GLOSSARY[key] ?? ''}`;
              }} />
              <Bar dataKey="p50" radius={[0, 3, 3, 0]}>
                {sortedChartData.map((d, i) => (
                  <Cell key={i} fill={d.p50 < FAST_MS ? '#22c55e' : d.p50 < CRITICAL_MS ? '#f59e0b' : '#ef4444'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Stage detail table */}
      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold">Stage breakdown — detail</h3>
          <p className="text-xs text-slate-400">
            For each stage: how many trades it was measured on, average, typical (median) and slowest 5% (p95). Hover a stage name for its meaning.
          </p>
        </CardHeader>
        <div className="overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr>
                <th>Stage</th>
                <th className="text-right">Trades</th>
                <th className="text-right">Average</th>
                <th className="text-right">Typical (p50)</th>
                <th className="text-right">Slowest 5% (p95)</th>
              </tr>
            </thead>
            <tbody>
              {stats.length === 0 ? (
                <tr><td colSpan={5} className="text-center py-8 text-slate-400">No pipeline data in this range</td></tr>
              ) : stats.map(s => (
                <tr key={s.key}>
                  <td className={s.key === 'total_ms' ? 'font-semibold' : ''} title={STAGE_GLOSSARY[s.key]}>{s.label}</td>
                  <td className="text-right text-slate-400">{s.count.toLocaleString()}</td>
                  <td className="text-right font-mono">{formatMs(s.avg)}</td>
                  <td className={clsx('text-right font-mono', TONE_TEXT[toneFor(s.p50)])}>{formatMs(s.p50)}</td>
                  <td className={clsx('text-right font-mono', TONE_TEXT[toneFor(s.p95)])}>{formatMs(s.p95)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* The trades behind these numbers */}
      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold">The trades behind these numbers</h3>
          <p className="text-xs text-slate-400">
            The latest {drillRows.length.toLocaleString()} executed trades with latency data and where each one lost time.
            Click a row to open the full signal story — pipeline timeline, AI explanation and execution attempts.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Select
              options={[
                { value: 'all', label: 'All speeds' },
                { value: 'fast', label: 'Fast only (<0.5s)' },
                { value: 'slow', label: 'Slow only (0.5–2s)' },
                { value: 'critical', label: 'Critical only (>2s)' },
              ]}
              value={drillFilter}
              onChange={e => setDrillFilter(e.target.value as DrillFilter)}
              className="w-44"
            />
            <span className="text-xs text-slate-400">
              {visibleDrill.length.toLocaleString()} of {drillRows.length.toLocaleString()} shown — click a row for details
            </span>
          </div>

          {visibleDrill.length === 0 ? (
            <p className="text-xs text-slate-400">No trades match this filter.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Opened</th>
                    <th className="text-right">Total journey</th>
                    <th>Slowest stage</th>
                    <th>Speed</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleDrill.map(d => (
                    <tr
                      key={d.signalId}
                      className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50"
                      onClick={() => setSelectedSignalId(d.signalId)}
                      title="Open full signal details"
                    >
                      <td className="text-xs text-slate-400 whitespace-nowrap">
                        {d.openedAtMs > 0 ? formatDate(new Date(d.openedAtMs).toISOString()) : '—'}
                      </td>
                      <td className={clsx('text-right font-mono', TONE_TEXT[toneFor(d.totalMs)])}>{formatMs(d.totalMs)}</td>
                      <td className="text-xs" title={d.slowKey ? STAGE_GLOSSARY[d.slowKey] : ''}>
                        {d.slowKey ? `${STAGE_STAT_LABELS[d.slowKey] ?? d.slowKey} (${formatMs(d.slowMs)})` : '—'}
                      </td>
                      <td>
                        <span className={clsx('text-xs font-semibold', TONE_TEXT[toneFor(d.totalMs)])}>
                          {d.totalMs < FAST_MS ? 'Fast' : d.totalMs < CRITICAL_MS ? 'Slow' : 'Critical'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Problems */}
      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold">Problems: failures, skips & retries</h3>
          <p className="text-xs text-slate-400">
            Every execution attempt is logged per signal. A signal with multiple attempts was retried — retries add delay.
            {failures.retriedSignals > 0 && failures.retryAddedMsAvg != null && (
              <> On average retries added <span className="font-medium text-amber-600 dark:text-amber-400">{formatMs(failures.retryAddedMsAvg)}</span> (slowest 5%: {formatMs(failures.retryAddedMsP95)}).</>
            )}
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <HealthPill label="Execution attempts" value={failures.totalAttempts.toLocaleString()} tone="neutral" />
            <HealthPill label="Failed attempts" value={failures.failed.toLocaleString()} tone={failureTone} hint={`${failureRate.toFixed(1)}% of all attempts`} />
            <HealthPill label="Skipped" value={failures.skipped.toLocaleString()} tone="warning" hint="Instructions intentionally not executed (e.g. no open trade to close)" />
            <HealthPill label="Trades retried" value={failures.retriedSignals.toLocaleString()} tone="warning" hint="Signals that needed more than one execution attempt" />
          </div>

          {dailyFailures.some(d => d.failed > 0 || d.skipped > 0) && (
            <div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">Outcome of execution attempts per day — red failed, amber skipped, green succeeded.</p>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={dailyFailures}>
                  <CartesianGrid {...gridStyle} />
                  <XAxis dataKey="date" {...axisStyle} tickFormatter={d => d.slice(5)} interval="preserveStartEnd" />
                  <YAxis {...axisStyle} />
                  <Tooltip contentStyle={tooltipStyle} labelFormatter={d => `Date: ${d}`} />
                  <Legend />
                  <Bar dataKey="failed" name="Failed" stackId="a" fill="#ef4444" />
                  <Bar dataKey="skipped" name="Skipped" stackId="a" fill="#f59e0b" />
                  <Bar dataKey="success" name="Succeeded" stackId="a" fill="#22c55e" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {failures.worst.length > 0 && (
            <div className="overflow-x-auto">
              <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">Worst retries — signals where retrying added the most delay.</p>
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Signal ID</th>
                    <th className="text-right">Attempts</th>
                    <th className="text-right">Failed</th>
                    <th className="text-right">Added latency (across attempts)</th>
                  </tr>
                </thead>
                <tbody>
                  {failures.worst.map(w => (
                    <tr
                      key={w.signalId}
                      className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50"
                      onClick={() => setSelectedSignalId(w.signalId)}
                      title="Open full signal details"
                    >
                      <td className="font-mono text-xs">{w.signalId.slice(0, 8)}…</td>
                      <td className="text-right">{w.attempts}</td>
                      <td className={`text-right ${w.failed > 0 ? 'text-error-600 dark:text-error-400' : 'text-slate-400'}`}>{w.failed}</td>
                      <td className={clsx('text-right font-mono', TONE_TEXT[toneFor(w.addedMs)])}>{formatMs(w.addedMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {failures.totalAttempts === 0 && (
            <p className="text-xs text-slate-400">No execution log entries in this range.</p>
          )}
        </CardContent>
      </Card>

      {/* Raw scatter — appendix */}
      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold">Raw view — every trade</h3>
          <p className="text-xs text-slate-400">
            One dot per executed trade: green fast, amber slow, red critical (latest {SCATTER_CAP.toLocaleString()} trades). Useful for spotting clusters of slow trades.
          </p>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={320}>
            <ScatterChart>
              <CartesianGrid {...gridStyle} />
              <XAxis
                type="number"
                dataKey="openedAtMs"
                name="Time"
                {...axisStyle}
                tickFormatter={ms => new Date(Number(ms)).toISOString().slice(5, 10)}
                domain={['dataMin', 'dataMax']}
              />
              <YAxis type="number" dataKey="totalMs" name="Total latency" {...axisStyle} tickFormatter={v => formatMs(Number(v))} />
              <ZAxis range={[24, 24]} />
              <Tooltip
                contentStyle={tooltipStyle}
                cursor={{ strokeDasharray: '3 3' }}
                formatter={(v, name, item) => {
                  if (name === 'Total latency') return [formatMs(Number(v)), 'Total latency'];
                  const ts = (item?.payload as { openedAtMs?: number } | undefined)?.openedAtMs;
                  return [ts ? new Date(ts).toLocaleString() : String(v), 'Opened'];
                }}
              />
              <Scatter
                data={scatter}
                fill={CHART_PALETTE[0]}
                style={{ cursor: 'pointer' }}
                onClick={(point) => {
                  const signalId = (point as { signalId?: string } | undefined)?.signalId;
                  if (signalId) setSelectedSignalId(signalId);
                }}
              >
                {scatter.map((point, i) => (
                  <Cell
                    key={i}
                    fill={point.totalMs < FAST_MS ? '#22c55e' : point.totalMs < CRITICAL_MS ? '#f59e0b' : '#ef4444'}
                  />
                ))}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {selectedSignalId && (
        <SignalDetailModal signalId={selectedSignalId} onClose={() => setSelectedSignalId(null)} />
      )}
    </div>
  );
}

function HealthPill({ label, value, tone, hint }: { label: string; value: string; tone: 'success' | 'warning' | 'error' | 'neutral'; hint?: string }) {
  return (
    <div className="card px-4 py-3" title={hint}>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
      <p className={clsx('text-xl font-bold mt-1', tone === 'neutral' ? 'text-slate-900 dark:text-slate-100' : TONE_TEXT[tone])}>{value}</p>
      {hint && <p className="text-[10px] text-slate-400 mt-1 leading-snug">{hint}</p>}
    </div>
  );
}