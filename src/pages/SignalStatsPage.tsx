import { useEffect, useState } from 'react';
import { authSupabase as adminSupabase } from '../lib/adminSupabase';
import { Card, CardHeader, CardContent } from '../components/ui/Card';
import { Alert } from '../components/ui/Alert';
import { HideTestAccountsToggle } from '../components/HideTestAccountsToggle';
import { useHideTestAccounts, TEST_ACCOUNT_IDS } from '../lib/testAccounts';
import { CHART_PALETTE, STATUS_COLORS, tooltipStyle, tooltipItemStyle, gridStyle, axisStyle } from '../lib/chartTheme';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell,
} from 'recharts';

interface SignalStat {
  status: string;
  count: number;
}

interface DailyStat {
  date: string;
  count: number;
}

interface ChannelStat {
  channel: string;
  count: number;
}

interface StatusCountRow {
  status: string;
  total: number | string;
}

interface DailyCountRow {
  day: string;
  total: number | string;
}

interface ChannelCountRow {
  channel: string;
  total: number | string;
}

export function SignalStatsPage() {
  const [byStatus, setByStatus] = useState<SignalStat[]>([]);
  const [daily, setDaily] = useState<DailyStat[]>([]);
  const [byChannel, setByChannel] = useState<ChannelStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hideTestAccounts] = useHideTestAccounts();

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const pFrom = thirtyDaysAgo.toISOString();
      const pExclude = hideTestAccounts ? TEST_ACCOUNT_IDS : [];

      const [statusResult, dailyResult, channelResult] = await Promise.all([
        adminSupabase.rpc('admin_signal_status_counts', { p_exclude: pExclude }),
        adminSupabase.rpc('admin_signal_daily_counts', { p_from: pFrom, p_exclude: pExclude }),
        adminSupabase.rpc('admin_signal_channel_counts', { p_from: pFrom, p_exclude: pExclude }),
      ]);

      if (cancelled) return;

      const firstError = statusResult.error ?? dailyResult.error ?? channelResult.error;
      if (firstError) {
        setError(firstError.message);
        setByStatus([]);
        setDaily([]);
        setByChannel([]);
        setLoading(false);
        return;
      }

      setError(null);
      setByStatus(
        ((statusResult.data ?? []) as StatusCountRow[])
          .map(r => ({ status: r.status, count: Number(r.total) }))
      );
      setDaily(
        ((dailyResult.data ?? []) as DailyCountRow[])
          .map(r => ({ date: r.day, count: Number(r.total) }))
      );
      setByChannel(
        ((channelResult.data ?? []) as ChannelCountRow[])
          .map(r => ({ channel: r.channel, count: Number(r.total) }))
          .slice(0, 20)
      );
      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [hideTestAccounts]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="page-header"><h1 className="page-title">Signal Stats</h1></div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {Array.from({ length: 3 }).map((_, i) => <div key={i} className="card p-6 skeleton h-72" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="page-header flex items-start justify-between gap-3">
        <div>
          <h1 className="page-title">Signal Stats</h1>
          <p className="page-subtitle">Last 30 days of signal activity</p>
        </div>
        <HideTestAccountsToggle />
      </div>

      {error && (
        <Alert variant="error" title="Signal counts are unavailable">
          {error}
        </Alert>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* By Status Pie */}
        <Card>
          <CardHeader><h3 className="text-sm font-semibold">Signals by Status (All Time)</h3></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie data={byStatus} dataKey="count" nameKey="status" cx="50%" cy="50%" outerRadius={100} label={(props: { status?: string; percent?: number }) => `${props.status ?? ''} ${((props.percent ?? 0) * 100).toFixed(0)}%`} labelLine={false}>
                  {byStatus.map((entry, i) => (
                    <Cell key={i} fill={STATUS_COLORS[entry.status] ?? CHART_PALETTE[i % CHART_PALETTE.length]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={tooltipStyle} itemStyle={tooltipItemStyle} />
              </PieChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Daily signals */}
        <Card>
          <CardHeader><h3 className="text-sm font-semibold">Daily Signals (Last 30 Days)</h3></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={daily}>
                <CartesianGrid {...gridStyle} />
                <XAxis dataKey="date" {...axisStyle} tickFormatter={d => d.slice(5)} interval="preserveStartEnd" />
                <YAxis {...axisStyle} />
                <Tooltip contentStyle={tooltipStyle} itemStyle={tooltipItemStyle} />
                <Bar dataKey="count" fill={CHART_PALETTE[0]} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* By channel horizontal bar */}
      <Card>
        <CardHeader><h3 className="text-sm font-semibold">Top 20 Channels by Signal Count (Last 30 Days)</h3></CardHeader>
        <CardContent>
          {byChannel.length === 0 ? (
            <p className="text-slate-400 text-sm text-center py-8">No signal data</p>
          ) : (
            <ResponsiveContainer width="100%" height={Math.max(300, byChannel.length * 28)}>
              <BarChart data={byChannel} layout="vertical">
                <CartesianGrid {...gridStyle} />
                <XAxis type="number" {...axisStyle} />
                <YAxis type="category" dataKey="channel" width={160} {...axisStyle} tick={{ ...axisStyle.tick, fontSize: 10 }} />
                <Tooltip contentStyle={tooltipStyle} itemStyle={tooltipItemStyle} />
                <Bar dataKey="count" fill={CHART_PALETTE[1]} radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
