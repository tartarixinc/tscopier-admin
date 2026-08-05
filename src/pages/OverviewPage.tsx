import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { authSupabase as adminSupabase, fetchDisplayNames } from '../lib/adminSupabase';
import { formatNumber } from '../lib/formatters';
import { Card, CardHeader, CardContent } from '../components/ui/Card';
import { StatusBadge } from '../components/StatusBadge';
import { UserLink } from '../components/UserLink';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell
} from 'recharts';
import { CHART_PALETTE, STATUS_COLORS, tooltipStyle, gridStyle, axisStyle } from '../lib/chartTheme';

interface Stats {
  totalUsers: number;
  newToday: number;
  newThisWeek: number;
  subscriptionsByPlan: { plan: string; count: number }[];
  connectedBrokers: number;
  errorBrokers: number;
  activeTelegramChannels: number;
  signalsToday: number;
  tradesToday: number;
  lotsToday: number;
  signalsByStatus: { status: string; count: number }[];
  topUsers: { user_id: string; display_name: string | null; trade_count: number; total_pnl: number }[];
  activeWorkers: number;
  copierPausedUsers: number;
  copierEngineOffline: number;
}

function StatCard({ label, value, sub, color = 'text-slate-900 dark:text-slate-100' }: {
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="stat-card">
      <p className="stat-label">{label}</p>
      <p className={`stat-value text-2xl ${color}`}>{value}</p>
      {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
    </div>
  );
}

export function OverviewPage() {
  const [stats, setStats] = useState<Partial<Stats>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchStats() {
      const now = new Date();
      const todayBoundary = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const weekBoundary = new Date(todayBoundary);
      weekBoundary.setDate(weekBoundary.getDate() - weekBoundary.getDay());

      const [
        { count: totalUsers },
        { count: newToday },
        { count: newThisWeek },
        { data: subsRows },
        { data: brokerStatuses },
        { count: activeTelegramChannels },
        { count: signalsToday },
        { data: tradeStats },
        { data: signalsByStatus },
        { data: topUsersRaw },
        { data: workerLeases },
        { count: copierPausedCount },
        { data: activeTelegramSessions },
        { data: sessionProfiles },
      ] = await Promise.all([
        adminSupabase.from('user_profiles').select('*', { count: 'exact', head: true }),
        adminSupabase.from('user_profiles').select('*', { count: 'exact', head: true })
          .gte('created_at', todayBoundary.toISOString()),
        adminSupabase.from('user_profiles').select('*', { count: 'exact', head: true })
          .gte('created_at', weekBoundary.toISOString()),
        adminSupabase.from('subscriptions').select('user_id, plan, status, trial_ends_at'),
        adminSupabase.from('broker_accounts').select('connection_status'),
        adminSupabase.from('telegram_channels').select('*', { count: 'exact', head: true })
          .eq('is_active', true),
        adminSupabase.from('signals').select('*', { count: 'exact', head: true })
          .gte('created_at', todayBoundary.toISOString()),
        adminSupabase.from('trades')
          .select('lot_size, profit, direction, entry_price, cwe_close_price')
          .eq('status', 'closed')
          .gte('closed_at', todayBoundary.toISOString()),
        adminSupabase.from('signals').select('status'),
        adminSupabase.from('trades')
          .select('user_id, profit, direction, entry_price, cwe_close_price')
          .gte('closed_at', weekBoundary.toISOString()),
        adminSupabase.from('worker_session_leases').select('user_id, expires_at, role'),
        adminSupabase.from('user_profiles').select('*', { count: 'exact', head: true })
          .eq('copier_paused', true),
        adminSupabase.from('telegram_sessions').select('user_id').eq('is_active', true),
        adminSupabase.from('user_profiles').select('user_id, copier_paused, is_admin, admin_until'),
      ]);

      // Aggregate plan counts
      const planMap: Record<string, number> = {};
      (subsRows ?? []).forEach((s) => {
        planMap[s.plan] = (planMap[s.plan] ?? 0) + 1;
      });
      const subscriptionsByPlan = Object.entries(planMap).map(([plan, count]) => ({ plan, count }));

      // Broker statuses
      const statusMap: Record<string, number> = {};
      (brokerStatuses ?? []).forEach((b) => {
        statusMap[b.connection_status ?? 'unknown'] = (statusMap[b.connection_status ?? 'unknown'] ?? 0) + 1;
      });

      // Compute P&L from profit column if set, otherwise estimate from entry/close price
      function computePnl(t: { profit: number | null; cwe_close_price: number | null; entry_price: number | null; direction: string | null; lot_size?: number | null }): number {
        if (t.profit != null) return Number(t.profit);
        if (t.cwe_close_price != null && t.entry_price != null) {
          const diff = t.direction === 'buy'
            ? Number(t.cwe_close_price) - Number(t.entry_price)
            : Number(t.entry_price) - Number(t.cwe_close_price);
          return diff * Number(t.lot_size ?? 1) * 100;
        }
        return 0;
      }

      // Trade stats today (closed trades)
      const todayTrades = tradeStats ?? [];
      const tradesToday = todayTrades.length;
      const lotsToday = todayTrades.reduce((sum: number, t) => sum + Number(t.lot_size ?? 0), 0);


      // Signal stats
      const sigMap: Record<string, number> = {};
      (signalsByStatus ?? []).forEach((s) => {
        sigMap[s.status ?? 'unknown'] = (sigMap[s.status ?? 'unknown'] ?? 0) + 1;
      });
      const signalsByStatusArr = Object.entries(sigMap).map(([status, count]) => ({ status, count }));

      // Top users — fetch display names separately
      const uniqueUserIds = [...new Set((topUsersRaw ?? []).map((t) => t.user_id).filter(Boolean))];
      const displayNames = await fetchDisplayNames(uniqueUserIds);
      const userMap: Record<string, { user_id: string; display_name: string | null; trade_count: number; total_pnl: number }> = {};
      (topUsersRaw ?? []).forEach((t) => {
        if (!t.user_id) return;
        if (!userMap[t.user_id]) {
          userMap[t.user_id] = {
            user_id: t.user_id,
            display_name: displayNames[t.user_id] ?? null,
            trade_count: 0,
            total_pnl: 0,
          };
        }
        userMap[t.user_id].trade_count += 1;
        userMap[t.user_id].total_pnl += computePnl(t);
      });
      const topUsers = Object.values(userMap)
        .sort((a, b) => b.trade_count - a.trade_count)
        .slice(0, 10);

      const nowMs = Date.now();
      const liveRoles = new Set(['listener', 'all']);
      const activeLeases = (workerLeases ?? []).filter((l) => {
        if (!l.expires_at || new Date(l.expires_at).getTime() <= nowMs) return false;
        return liveRoles.has(String(l.role ?? ''));
      });
      const activeWorkers = activeLeases.length;
      const activeLeaseUserIds = new Set(
        activeLeases.map((l) => l.user_id).filter(Boolean)
      );

      const subByUser = new Map(
        (subsRows ?? []).map((s) => [s.user_id, s])
      );
      const profileByUser = new Map(
        (sessionProfiles ?? []).map((p) => [p.user_id, p])
      );

      function isSubscriptionActive(status: string | null | undefined, trialEndsAt: string | null | undefined): boolean {
        const s = String(status ?? '');
        // Match worker planLimits.isSubscriptionActive: paid active always counts;
        // trialing only while trial_ends_at is unset/unparseable or still in the future.
        if (s === 'active') return true;
        if (s === 'trialing') {
          if (!trialEndsAt) return true;
          const end = new Date(trialEndsAt).getTime();
          if (!Number.isFinite(end)) return true;
          return end > nowMs;
        }
        return false;
      }

      function isAdminActive(isAdmin: boolean | null | undefined, adminUntil: string | null | undefined): boolean {
        if (!isAdmin) return false;
        if (!adminUntil) return true;
        return new Date(adminUntil).getTime() > nowMs;
      }

      const copierEngineOffline = new Set(
        (activeTelegramSessions ?? [])
          .map((s) => s.user_id as string | null)
          .filter((userId): userId is string => {
            if (!userId || activeLeaseUserIds.has(userId)) return false;
            const profile = profileByUser.get(userId);
            if (profile?.copier_paused) return false;
            const sub = subByUser.get(userId);
            return (
              isSubscriptionActive(sub?.status, sub?.trial_ends_at) ||
              isAdminActive(profile?.is_admin, profile?.admin_until)
            );
          })
      ).size;

      setStats({
        totalUsers: totalUsers ?? 0,
        newToday: newToday ?? 0,
        newThisWeek: newThisWeek ?? 0,
        subscriptionsByPlan,
        connectedBrokers: statusMap['connected'] ?? 0,
        errorBrokers: statusMap['error'] ?? 0,
        activeTelegramChannels: activeTelegramChannels ?? 0,
        signalsToday: signalsToday ?? 0,
        tradesToday,
        lotsToday,
        signalsByStatus: signalsByStatusArr,
        topUsers,
        activeWorkers,
        copierPausedUsers: copierPausedCount ?? 0,
        copierEngineOffline,
      });
      setLoading(false);
    }

    fetchStats();
  }, []);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="page-header"><h1 className="page-title">Overview</h1></div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="card p-6"><div className="skeleton h-16 w-full" /></div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="page-header">
        <h1 className="page-title">Overview</h1>
        <p className="page-subtitle">Platform-wide metrics and health</p>
      </div>

      {/* User Stats */}
      <section>
        <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-3">Users</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard label="Total Users" value={stats.totalUsers ?? 0} />
          <StatCard label="New Today" value={stats.newToday ?? 0} color="text-success-600" />
          <StatCard label="New This Week" value={stats.newThisWeek ?? 0} />
          <div className="stat-card">
            <p className="stat-label mb-2">Subscriptions by Plan</p>
            {(stats.subscriptionsByPlan ?? []).map(s => (
              <div key={s.plan} className="flex items-center justify-between text-sm py-0.5">
                <StatusBadge status={s.plan} />
                <span className="font-medium text-slate-700 dark:text-slate-300">{s.count}</span>
              </div>
            ))}
            {(stats.subscriptionsByPlan ?? []).length === 0 && <p className="text-xs text-slate-400">No subscriptions</p>}
          </div>
        </div>
      </section>

      {/* Platform Health */}
      <section>
        <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-3">Platform Health</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard label="Connected Brokers" value={stats.connectedBrokers ?? 0} color="text-success-600" />
          <StatCard label="Broker Errors" value={stats.errorBrokers ?? 0} color="text-error-600" />
          <StatCard label="Active Telegram Channels" value={stats.activeTelegramChannels ?? 0} color="text-primary-600" />
        </div>
      </section>

      {/* System Health */}
      <section>
        <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-3">System Health</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard label="Active Workers" value={stats.activeWorkers ?? 0} color={(stats.activeWorkers ?? 0) > 0 ? 'text-success-600' : 'text-error-600'} />
          <StatCard label="Copier Paused Users" value={stats.copierPausedUsers ?? 0} color={(stats.copierPausedUsers ?? 0) > 0 ? 'text-warning-600' : 'text-slate-900 dark:text-slate-100'} />
          <StatCard
            label="Copier Engine Offline"
            value={stats.copierEngineOffline ?? 0}
            color={(stats.copierEngineOffline ?? 0) > 0 ? 'text-error-600' : 'text-slate-900 dark:text-slate-100'}
          />
          {(stats.copierEngineOffline ?? 0) > 0 && (
            <div className="stat-card flex flex-col justify-center">
              <Link
                to="/monitoring/copier-engine"
                className="text-sm font-medium text-primary-600 dark:text-primary-400 hover:underline"
              >
                Manage Copier Engines →
              </Link>
              <p className="text-xs text-slate-400 mt-1">Reconnect offline engines from admin</p>
            </div>
          )}
        </div>
      </section>

      {/* Trade Volume */}
      <section>
        <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-3">Today's Trading</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard label="Trades Opened" value={stats.tradesToday ?? 0} />
          <StatCard label="Total Lots" value={formatNumber(stats.lotsToday, 2)} />
          <StatCard label="Signals Today" value={stats.signalsToday ?? 0} />
        </div>
      </section>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Signal Funnel */}
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">Signal Funnel (All Time)</h3>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={stats.signalsByStatus ?? []}>
                <CartesianGrid {...gridStyle} />
                <XAxis dataKey="status" {...axisStyle} />
                <YAxis {...axisStyle} />
                <Tooltip contentStyle={tooltipStyle} />
                <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                  {(stats.signalsByStatus ?? []).map((entry, i) => (
                    <Cell key={i} fill={STATUS_COLORS[entry.status] ?? CHART_PALETTE[i % CHART_PALETTE.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Subscription Plans */}
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">Subscriptions by Plan</h3>
          </CardHeader>
          <CardContent>
            {(stats.subscriptionsByPlan ?? []).length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie
                    data={stats.subscriptionsByPlan}
                    dataKey="count"
                    nameKey="plan"
                    cx="50%"
                    cy="50%"
                    outerRadius={80}
                    label={(props: { plan?: string; percent?: number }) => `${props.plan ?? ''} ${((props.percent ?? 0) * 100).toFixed(0)}%`}
                    labelLine={false}
                  >
                    {(stats.subscriptionsByPlan ?? []).map((_, i) => (
                      <Cell key={i} fill={CHART_PALETTE[i % CHART_PALETTE.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={tooltipStyle} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-48 flex items-center justify-center text-slate-400 text-sm">No subscription data</div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Top Users Table */}
      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">Top Users by Trades (This Week)</h3>
        </CardHeader>
        <div className="overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr>
                <th>User</th>
                <th>Trades (This Week)</th>
              </tr>
            </thead>
            <tbody>
              {(stats.topUsers ?? []).length === 0 ? (
                <tr><td colSpan={2} className="text-center py-8 text-slate-400">No trades this week</td></tr>
              ) : (
                (stats.topUsers ?? []).map(u => (
                  <tr key={u.user_id}>
                    <td><UserLink userId={u.user_id} displayName={u.display_name} /></td>
                    <td className="font-medium">{u.trade_count}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

    </div>
  );
}
