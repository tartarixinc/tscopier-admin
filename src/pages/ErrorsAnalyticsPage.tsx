import { useEffect, useMemo, useState } from 'react';
import { authSupabase as adminSupabase } from '../lib/adminSupabase';
import { formatDateOnly } from '../lib/formatters';
import { Card, CardHeader, CardContent } from '../components/ui/Card';
import { CHART_COLORS, tooltipStyle, gridStyle, axisStyle } from '../lib/chartTheme';
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { TrendingDown, TrendingUp } from 'lucide-react';
import clsx from 'clsx';

type ErrorSourceKey = 'execution' | 'signal' | 'broker' | 'deadLetter';

interface DailyBucket {
  date: string;
  execution: number;
  signal: number;
  broker: number;
  deadLetter: number;
  total: number;
}

const RANGE_OPTIONS: { label: string; days: number | null }[] = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '180d', days: 180 },
  { label: '1y', days: 365 },
  { label: 'All', days: null },
];

const SOURCE_KEYS: ErrorSourceKey[] = ['execution', 'signal', 'broker', 'deadLetter'];

const SOURCE_META: { key: ErrorSourceKey; label: string; color: string }[] = [
  { key: 'execution', label: 'Execution', color: CHART_COLORS.error },
  { key: 'signal', label: 'Signal', color: CHART_COLORS.warning },
  { key: 'broker', label: 'Broker', color: CHART_COLORS.info },
  { key: 'deadLetter', label: 'Dead letter', color: CHART_COLORS.purple },
];

const PAGE_SIZE = 1000;
const ROW_CAP = 50000;

function toUtcKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Fetches just the timestamps for one error source, bucketed client-side by UTC day. */
async function fetchDayCounts(
  source: ErrorSourceKey,
  fromDate: string | null,
  capRef: { value: boolean },
): Promise<Record<string, number>> {
  const timestampCol = source === 'broker' ? 'last_synced_at' : 'created_at';
  const table = source === 'execution'
    ? 'trade_execution_logs'
    : source === 'signal'
      ? 'signals'
      : source === 'broker'
        ? 'broker_accounts'
        : 'signal_queue_dead_letters';

  const map: Record<string, number> = {};
  let fetched = 0;

  for (let page = 0; page < 200; page += 1) {
    const fromIdx = page * PAGE_SIZE;
    const q = adminSupabase
      .from(table)
      .select(`id, ${timestampCol}`)
      .order(timestampCol, { ascending: false, nullsFirst: false });

    const filtered = source === 'execution'
      ? q.in('status', ['failed', 'error'])
      : source === 'signal'
        ? q.eq('status', 'failed')
        : source === 'broker'
          ? q.eq('connection_status', 'error')
          : q.neq('status', 'replayed');

    const finalQ = fromDate ? filtered.gte(timestampCol, fromDate) : filtered;
    const { data } = await finalQ.range(fromIdx, fromIdx + PAGE_SIZE - 1);
    const rows = (data ?? []) as Record<string, string | null>[];

    for (const r of rows) {
      const key = (r[timestampCol] ?? '').slice(0, 10);
      if (key) map[key] = (map[key] ?? 0) + 1;
    }
    fetched += rows.length;
    if (rows.length < PAGE_SIZE) break;
    if (fetched >= ROW_CAP) {
      capRef.value = true;
      break;
    }
  }

  return map;
}

export function ErrorsAnalyticsPage() {
  const [rangeDays, setRangeDays] = useState<number | null>(30);
  const [buckets, setBuckets] = useState<DailyBucket[]>([]);
  const [loading, setLoading] = useState(true);
  const [capped, setCapped] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setCapped(false);

    (async () => {
      const capRef = { value: false };
      const fromDate = rangeDays != null
        ? new Date(Date.now() - rangeDays * 86400000).toISOString()
        : null;

      const results = await Promise.all(SOURCE_KEYS.map(k => fetchDayCounts(k, fromDate, capRef)));
      if (cancelled) return;

      const maps = Object.fromEntries(SOURCE_KEYS.map((k, i) => [k, results[i]])) as Record<ErrorSourceKey, Record<string, number>>;

      const todayKey = toUtcKey(new Date());
      let firstKey = fromDate ? fromDate.slice(0, 10) : todayKey;
      if (!fromDate) {
        const allKeys = SOURCE_KEYS.flatMap(k => Object.keys(maps[k]));
        if (allKeys.length > 0) firstKey = allKeys.sort()[0];
      }

      const built: DailyBucket[] = [];
      const cur = new Date(`${firstKey}T00:00:00Z`);
      const end = new Date(`${todayKey}T00:00:00Z`);
      while (cur <= end) {
        const key = toUtcKey(cur);
        const execution = maps.execution[key] ?? 0;
        const signal = maps.signal[key] ?? 0;
        const broker = maps.broker[key] ?? 0;
        const deadLetter = maps.deadLetter[key] ?? 0;
        built.push({ date: key, execution, signal, broker, deadLetter, total: execution + signal + broker + deadLetter });
        cur.setUTCDate(cur.getUTCDate() + 1);
      }

      setBuckets(built);
      setCapped(capRef.value);
      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [rangeDays]);

  const stats = useMemo(() => {
    if (buckets.length === 0) {
      return { total: 0, avg: 0, peak: null as { date: string; total: number } | null, recent: 0, previous: 0, trendPct: 0 };
    }
    const total = buckets.reduce((a, b) => a + b.total, 0);
    const avg = total / buckets.length;
    const peak = buckets.reduce<(DailyBucket | null)>((a, b) => (a === null || b.total > a.total ? b : a), null);
    const recent = buckets.slice(-7).reduce((a, b) => a + b.total, 0);
    const previous = buckets.slice(-14, -7).reduce((a, b) => a + b.total, 0);
    const trendPct = previous > 0 ? ((recent - previous) / previous) * 100 : 0;
    return { total, avg, peak: peak ? { date: peak.date, total: peak.total } : null, recent, previous, trendPct };
  }, [buckets]);

  const cumulative = useMemo(() => {
    let running = 0;
    return buckets.map(b => ({ date: b.date, total: (running += b.total) }));
  }, [buckets]);

  const perSource = useMemo(() => {
    const total = stats.total || 0;
    return SOURCE_META
      .map(s => ({ ...s, count: buckets.reduce((a, b) => a + b[s.key], 0) }))
      .sort((a, b) => b.count - a.count)
      .map(s => ({ ...s, pct: total > 0 ? (s.count / total) * 100 : 0 }));
  }, [buckets, stats.total]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="page-header"><h1 className="page-title">Error Analytics</h1></div>
        <div className="grid grid-cols-1 gap-6">
          {Array.from({ length: 3 }).map((_, i) => <div key={i} className="card p-6 skeleton h-72" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="page-header">
        <h1 className="page-title">Error Analytics</h1>
        <p className="page-subtitle">Rise and fall of errors over time — failed executions, failed signals, broker connection errors and dead letters</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg bg-slate-100 dark:bg-slate-800 p-1 text-sm font-medium">
          {RANGE_OPTIONS.map(opt => (
            <button
              key={opt.label}
              type="button"
              onClick={() => setRangeDays(opt.days)}
              className={clsx(
                'px-3 py-1.5 rounded-md transition-colors text-xs',
                rangeDays === opt.days
                  ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200',
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-4">
        <StatPill label="Total errors" value={stats.total.toLocaleString()} />
        <StatPill label="Avg per day" value={stats.avg.toFixed(1)} />
        <StatPill label="Peak day" value={stats.peak ? `${formatDateOnly(stats.peak.date)} · ${stats.peak.total.toLocaleString()}` : '—'} small />
        <StatPill label="Last 7d vs prior 7d" value={`${stats.recent.toLocaleString()} vs ${stats.previous.toLocaleString()}`} small />
        <TrendPill pct={stats.trendPct} hasBaseline={stats.previous > 0} />
      </div>

      {capped && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Analysis capped at {ROW_CAP.toLocaleString()} rows per source — refine the range for full coverage.
        </p>
      )}

      <Card>
        <CardHeader><h3 className="text-sm font-semibold">Errors per day by source</h3></CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={buckets}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" {...axisStyle} tickFormatter={d => d.slice(5)} interval="preserveStartEnd" />
              <YAxis {...axisStyle} allowDecimals={false} />
              <Tooltip contentStyle={tooltipStyle} labelFormatter={d => formatDateOnly(String(d))} />
              {SOURCE_META.map(s => (
                <Bar key={s.key} dataKey={s.key} name={s.label} stackId="errors" fill={s.color} />
              ))}
            </BarChart>
          </ResponsiveContainer>
          <div className="flex flex-wrap justify-center gap-4 text-xs mt-3">
            {SOURCE_META.map(s => (
              <span key={s.key} className="flex items-center gap-1.5 text-slate-500">
                <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: s.color }} />
                {s.label}
              </span>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader><h3 className="text-sm font-semibold">Total errors over time</h3></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={cumulative}>
                <defs>
                  <linearGradient id="errorsGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={CHART_COLORS.error} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={CHART_COLORS.error} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid {...gridStyle} />
                <XAxis dataKey="date" {...axisStyle} tickFormatter={d => d.slice(5)} interval="preserveStartEnd" />
                <YAxis {...axisStyle} allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} labelFormatter={d => formatDateOnly(String(d))} formatter={(v) => [Number(v).toLocaleString(), 'Total errors']} />
                <Area type="monotone" dataKey="total" stroke={CHART_COLORS.error} strokeWidth={2} fill="url(#errorsGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><h3 className="text-sm font-semibold">By source</h3></CardHeader>
          <CardContent className="space-y-4">
            {perSource.map(s => (
              <div key={s.key}>
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
                    <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: s.color }} />
                    {s.label}
                  </span>
                  <span className="text-slate-400">
                    {s.count.toLocaleString()} · {s.pct.toFixed(0)}%
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-slate-100 dark:bg-slate-700 overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${s.pct}%`, backgroundColor: s.color }} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatPill({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return (
    <div className="card px-4 py-3 flex-1 min-w-40">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
      <p className={clsx('mt-1 font-bold text-slate-900 dark:text-slate-100', small ? 'text-base' : 'text-xl')}>
        {value}
      </p>
    </div>
  );
}

function TrendPill({ pct, hasBaseline }: { pct: number; hasBaseline: boolean }) {
  const rising = pct > 0;
  return (
    <div className="card px-4 py-3 flex-1 min-w-40">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Trend (last 7d)</p>
      <p className={clsx('mt-1 font-bold text-base flex items-center gap-1.5', rising ? 'text-error-600 dark:text-error-400' : 'text-success-600 dark:text-success-400')}>
        {hasBaseline ? (
          <>
            {rising ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
            {pct >= 0 ? '+' : ''}{pct.toFixed(0)}%
          </>
        ) : '—'}
      </p>
    </div>
  );
}
