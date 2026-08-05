import { useEffect, useState } from 'react';
import { authSupabase as adminSupabase } from '../lib/adminSupabase';
import { Card, CardHeader, CardContent } from '../components/ui/Card';
import { CHART_PALETTE, STATUS_COLORS, tooltipStyle, gridStyle, axisStyle } from '../lib/chartTheme';
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

export function SignalStatsPage() {
  const [byStatus, setByStatus] = useState<SignalStat[]>([]);
  const [daily, setDaily] = useState<DailyStat[]>([]);
  const [byChannel, setByChannel] = useState<ChannelStat[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const [{ data: allStatuses }, { data: recentSignals }, { data: channelSignals }] = await Promise.all([
        adminSupabase.from('signals').select('status'),
        adminSupabase.from('signals').select('created_at, status').gte('created_at', thirtyDaysAgo.toISOString()),
        adminSupabase.from('signals').select('telegram_channels(display_name)').gte('created_at', thirtyDaysAgo.toISOString()),
      ]);

      // By status
      const statusMap: Record<string, number> = {};
      (allStatuses ?? []).forEach((s) => {
        statusMap[s.status ?? 'unknown'] = (statusMap[s.status ?? 'unknown'] ?? 0) + 1;
      });
      setByStatus(Object.entries(statusMap).map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count));

      // Daily
      const dailyMap: Record<string, number> = {};
      (recentSignals ?? []).forEach((s) => {
        const date = s.created_at?.slice(0, 10);
        if (date) dailyMap[date] = (dailyMap[date] ?? 0) + 1;
      });
      const sortedDates = Object.keys(dailyMap).sort();
      setDaily(sortedDates.map(date => ({ date, count: dailyMap[date] })));

      // By channel
      const chanMap: Record<string, number> = {};
      (channelSignals ?? []).forEach((s) => {
        const name = (s.telegram_channels as { display_name: string | null }[] | null)?.[0]?.display_name ?? 'Unknown';
        chanMap[name] = (chanMap[name] ?? 0) + 1;
      });
      setByChannel(
        Object.entries(chanMap)
          .map(([channel, count]) => ({ channel, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 20)
      );

      setLoading(false);
    }

    load();
  }, []);

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
      <div className="page-header">
        <h1 className="page-title">Signal Stats</h1>
        <p className="page-subtitle">Last 30 days of signal activity</p>
      </div>

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
                <Tooltip contentStyle={tooltipStyle} />
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
                <Tooltip contentStyle={tooltipStyle} />
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
                <Tooltip contentStyle={tooltipStyle} />
                <Bar dataKey="count" fill={CHART_PALETTE[1]} radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
