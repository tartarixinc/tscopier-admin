import { useEffect, useState } from 'react';
import { authSupabase as adminSupabase } from '../lib/adminSupabase';
import { Card, CardHeader, CardContent } from '../components/ui/Card';
import { Alert } from '../components/ui/Alert';
import { HideTestAccountsToggle } from '../components/HideTestAccountsToggle';
import { useHideTestAccounts, TEST_ACCOUNT_IDS } from '../lib/testAccounts';
import { CHART_COLORS, tooltipStyle, tooltipItemStyle, gridStyle, axisStyle } from '../lib/chartTheme';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import clsx from 'clsx';

interface HourlyActivityPoint {
  hour: number | string;
  trades: number | string;
  signals: number | string;
}

interface DowActivityPoint {
  dow: number | string;
  trades: number | string;
  signals: number | string;
}

interface TradeActivityStats {
  hourly: HourlyActivityPoint[];
  by_dow: DowActivityPoint[];
  total_trades: number;
  total_signals: number;
}

const RANGE_OPTIONS: { label: string; days: number | null }[] = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: 'All', days: null },
];

const DOW_LABELS: Record<number, string> = {
  0: 'Sunday',
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
};

const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0];

function padHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

function hourRangeLabel(hour: number): string {
  return `${padHour(hour)}–${padHour((hour + 1) % 24)} UTC`;
}

export function TradingHoursPage() {
  const [stats, setStats] = useState<TradeActivityStats | null>(null);
  const [days, setDays] = useState<number | null>(90);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hideTestAccounts] = useHideTestAccounts();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    (async () => {
      const { data, error: rpcError } = await adminSupabase.rpc('admin_trade_activity_stats', {
        p_exclude: hideTestAccounts ? TEST_ACCOUNT_IDS : [],
        p_days: days,
      });
      if (cancelled) return;
      if (rpcError) {
        setError(rpcError.message);
        setStats(null);
        setLoading(false);
        return;
      }
      if (!data) {
        setError('You do not have admin access to view these statistics.');
        setStats(null);
        setLoading(false);
        return;
      }
      setError(null);
      setStats(data as TradeActivityStats);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [days, hideTestAccounts]);

  const hourly = (stats?.hourly ?? []).map(r => ({
    hour: Number(r.hour),
    trades: Number(r.trades),
    signals: Number(r.signals),
  }));

  const busiest = hourly.reduce<{ hour: number; trades: number } | null>(
    (best, h) => (!best || h.trades > best.trades ? { hour: h.hour, trades: h.trades } : best),
    null,
  );
  const quietest = hourly.reduce<{ hour: number; trades: number } | null>(
    (low, h) => (!low || h.trades < low.trades ? { hour: h.hour, trades: h.trades } : low),
    null,
  );
  const hasActivity = hourly.some(h => h.trades > 0 || h.signals > 0);
  const rangeLabel = days === null ? 'All time' : `Last ${days} days`;

  const byDow = (stats?.by_dow ?? []).map(r => ({
    dow: Number(r.dow),
    trades: Number(r.trades),
    signals: Number(r.signals),
  }));
  const byDowSorted = DOW_ORDER
    .map(dow => byDow.find(r => r.dow === dow))
    .filter((r): r is { dow: number; trades: number; signals: number } => Boolean(r));
  const busiestDay = byDowSorted.reduce<{ dow: number; trades: number } | null>(
    (best, d) => (!best || d.trades > best.trades ? { dow: d.dow, trades: d.trades } : best),
    null,
  );
  const quietestDay = byDowSorted.reduce<{ dow: number; trades: number } | null>(
    (low, d) => (!low || d.trades < low.trades ? { dow: d.dow, trades: d.trades } : low),
    null,
  );
  const dowChart = byDowSorted.map(d => ({
    label: DOW_LABELS[d.dow].slice(0, 3),
    trades: d.trades,
    signals: d.signals,
  }));

  const chartData = hourly.map(h => ({
    label: padHour(h.hour),
    trades: h.trades,
    signals: h.signals,
  }));

  const kpis = [
    {
      label: 'Trades opened',
      value: (stats?.total_trades ?? 0).toLocaleString(),
      caption: rangeLabel,
      color: 'text-slate-900 dark:text-slate-100',
    },
    {
      label: 'Signals received',
      value: (stats?.total_signals ?? 0).toLocaleString(),
      caption: rangeLabel,
      color: 'text-primary-600 dark:text-primary-400',
    },
    {
      label: 'Busiest hour',
      value: busiest ? hourRangeLabel(busiest.hour) : '—',
      caption: busiest ? `${busiest.trades.toLocaleString()} trade${busiest.trades === 1 ? '' : 's'} opened` : '',
      color: 'text-success-600 dark:text-success-400',
    },
    {
      label: 'Quietest hour',
      value: quietest ? hourRangeLabel(quietest.hour) : '—',
      caption: quietest ? `${quietest.trades.toLocaleString()} trade${quietest.trades === 1 ? '' : 's'} opened` : '',
      color: 'text-slate-500 dark:text-slate-400',
    },
    {
      label: 'Busiest day',
      value: busiestDay ? DOW_LABELS[busiestDay.dow] : '—',
      caption: busiestDay ? `${busiestDay.trades.toLocaleString()} trade${busiestDay.trades === 1 ? '' : 's'} opened` : '',
      color: 'text-success-600 dark:text-success-400',
    },
    {
      label: 'Quietest day',
      value: quietestDay ? DOW_LABELS[quietestDay.dow] : '—',
      caption: quietestDay ? `${quietestDay.trades.toLocaleString()} trade${quietestDay.trades === 1 ? '' : 's'} opened` : '',
      color: 'text-slate-500 dark:text-slate-400',
    },
  ];

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="page-header flex items-start justify-between gap-3">
        <div>
          <h1 className="page-title">Trading Hours</h1>
          <p className="page-subtitle">Peak and low trading hours — trades opened and signals received per hour of day (UTC)</p>
        </div>
        <HideTestAccountsToggle />
      </div>

      <div className="flex items-center gap-1 rounded-lg bg-slate-100 dark:bg-slate-800 p-1 text-sm font-medium w-fit">
        {RANGE_OPTIONS.map(opt => (
          <button
            key={opt.label}
            type="button"
            onClick={() => setDays(opt.days)}
            className={clsx(
              'px-3 py-1.5 rounded-md transition-colors text-xs',
              days === opt.days
                ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200',
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {error && (
        <Alert variant="error" title="Trading activity is unavailable">
          {error}
        </Alert>
      )}

      {!error && loading && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => <div key={i} className="card p-4 skeleton h-24" />)}
          </div>
          <div className="card p-6 skeleton h-96" />
        </div>
      )}

      {!error && !loading && stats && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            {kpis.map(kpi => (
              <Card key={kpi.label}>
                <CardContent className="p-4">
                  <p className="text-xs font-medium uppercase tracking-wider text-slate-400 dark:text-slate-500">{kpi.label}</p>
                  <p className={`text-xl font-bold mt-1 ${kpi.color}`}>{kpi.value}</p>
                  {kpi.caption && <p className="text-xs text-slate-400 mt-0.5">{kpi.caption}</p>}
                </CardContent>
              </Card>
            ))}
          </div>

          <Card>
            <CardHeader>
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-sm font-semibold">Trades and Signals by Hour of Day (UTC)</h3>
                <span className="text-xs text-slate-400">{rangeLabel}</span>
              </div>
            </CardHeader>
            <CardContent>
              {!hasActivity ? (
                <p className="text-slate-400 text-sm text-center py-8">No trading activity in the selected range</p>
              ) : (
                <ResponsiveContainer width="100%" height={340}>
                  <BarChart data={chartData} margin={{ left: 8, right: 8 }}>
                    <CartesianGrid {...gridStyle} />
                    <XAxis
                      dataKey="label"
                      {...axisStyle}
                      interval={1}
                      tick={{ ...axisStyle.tick, fontSize: 10 }}
                    />
                    <YAxis {...axisStyle} allowDecimals={false} />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      itemStyle={tooltipItemStyle}
                      labelFormatter={(label) => `${label} UTC`}
                      formatter={(value, name) => [
                        Number(value).toLocaleString(),
                        name === 'trades' ? 'Trades opened' : 'Signals received',
                      ]}
                    />
                    <Legend formatter={(value) => (value === 'trades' ? 'Trades opened' : 'Signals received')} />
                    <Bar dataKey="trades" fill={CHART_COLORS.primary} radius={[3, 3, 0, 0]} />
                    <Bar dataKey="signals" fill={CHART_COLORS.info} radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
              <p className="text-xs text-slate-400 mt-3">
                Hour of day is UTC. A trade counts in the hour it was opened (opened_at); a signal counts in the hour it
                was received (created_at). The busiest hour is the hour with the most trades opened; the quietest is the
                hour with the fewest, so hours with no activity win. Change the window with the range buttons above.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-sm font-semibold">Trades and Signals by Day of Week (UTC)</h3>
                <span className="text-xs text-slate-400">{rangeLabel}</span>
              </div>
            </CardHeader>
            <CardContent>
              {!hasActivity ? (
                <p className="text-slate-400 text-sm text-center py-8">No trading activity in the selected range</p>
              ) : (
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={dowChart} margin={{ left: 8, right: 8 }}>
                    <CartesianGrid {...gridStyle} />
                    <XAxis dataKey="label" {...axisStyle} />
                    <YAxis {...axisStyle} allowDecimals={false} />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      itemStyle={tooltipItemStyle}
                      labelFormatter={(label) => `${label} (UTC)`}
                      formatter={(value, name) => [
                        Number(value).toLocaleString(),
                        name === 'trades' ? 'Trades opened' : 'Signals received',
                      ]}
                    />
                    <Legend formatter={(value) => (value === 'trades' ? 'Trades opened' : 'Signals received')} />
                    <Bar dataKey="trades" fill={CHART_COLORS.primary} radius={[3, 3, 0, 0]} />
                    <Bar dataKey="signals" fill={CHART_COLORS.info} radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
              <p className="text-xs text-slate-400 mt-3">
                Day of week is UTC, Monday first. The busiest day is the day with the most trades opened; the quietest is
                the day with the fewest. Weekend days are naturally quiet — the market is closed on Saturday and most of
                Sunday (UTC).
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
