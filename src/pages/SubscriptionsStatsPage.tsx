import { useEffect, useState } from 'react';
import { authSupabase as adminSupabase } from '../lib/adminSupabase';
import { Card, CardHeader, CardContent } from '../components/ui/Card';
import { Alert } from '../components/ui/Alert';
import { Modal } from '../components/ui/Modal';
import { HideTestAccountsToggle } from '../components/HideTestAccountsToggle';
import { UserLink } from '../components/UserLink';
import { Pagination } from '../components/DataTable';
import { useHideTestAccounts, TEST_ACCOUNT_IDS, withoutTestAccounts } from '../lib/testAccounts';
import { pauseReasonLabel } from '../lib/pauseReasons';
import { formatDateOnly } from '../lib/formatters';
import {
  CHART_PALETTE, CHART_COLORS, STATUS_COLORS, REASON_COLORS, tooltipStyle, tooltipItemStyle, gridStyle, axisStyle,
} from '../lib/chartTheme';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from 'recharts';

interface StatusTotal {
  status: string;
  total: number | string;
}

interface PlanStatusTotal {
  plan: string;
  status: string;
  total: number | string;
}

interface ChurnPoint {
  month: string;
  plan: string;
  total: number | string;
}

interface RetentionPlanTotal {
  plan: string;
  retained: number | string;
  churned: number | string;
}

interface SubscriptionStats {
  totals: StatusTotal[];
  by_plan: PlanStatusTotal[];
  churn: ChurnPoint[];
  started: ChurnPoint[];
  retention: RetentionPlanTotal[];
  canceled_undated: number;
  total: number;
}

interface PauseReasonTotal {
  reason: string;
  total: number | string;
}

interface PauseStats {
  reasons: PauseReasonTotal[];
  paused_total: number;
  profiles_total: number;
}

interface TrialUserRow {
  user_id: string;
  plan: string | null;
  status: string | null;
  trial_ends_at: string | null;
  joined_at: string | null;
  sub_started_at: string;
  sub_ended_at: string | null;
}

interface TrialMonthlyPoint {
  month: string;
  converted: number | string;
  not_converted: number | string;
}

interface TrialStats {
  converted: TrialUserRow[];
  not_converted: TrialUserRow[];
  in_trial: TrialUserRow[];
  monthly: TrialMonthlyPoint[];
}

type TrialGroup = 'converted' | 'converted_canceled' | 'not_converted' | 'in_trial';

interface TrialDrillRow extends TrialUserRow {
  display_name: string | null;
}

interface PlanBarRow {
  plan: string;
  [status: string]: number | string;
}

interface ChurnBarRow {
  month: string;
  [plan: string]: number | string;
}

interface DrillCell {
  plan: string;
  status: string;
}

interface DrillSubRow {
  user_id: string;
  created_at: string;
  trial_ends_at: string | null;
  current_period_end: string | null;
  canceled_at: string | null;
}

interface DrillRow extends DrillSubRow {
  display_name: string | null;
  copier_paused: boolean | null;
  copier_pause_reason: string | null;
}

interface RetentionSubRow {
  user_id: string;
  plan: string | null;
  status: string;
  created_at: string;
  trial_ends_at: string | null;
  current_period_end: string | null;
  canceled_at: string | null;
}

interface RetentionDrillRow extends RetentionSubRow {
  display_name: string | null;
  joined_at: string | null;
  copier_paused: boolean | null;
  copier_pause_reason: string | null;
}

const DRILL_PAGE_SIZE = 50;

function displayLabel(value: string): string {
  if (value === 'trialing') return 'Free Trial';
  if (!value) return value;
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function drillStatusExplanation(status: string): string {
  switch (status) {
    case 'active': return 'currently active — the date column shows the end of the current billing period';
    case 'trialing': return 'still in their free trial — the date column shows when the trial ends';
    case 'past_due': return 'past due — a payment failed and renewal is pending — the date column shows the current billing period end';
    case 'canceled': return 'canceled — the date column shows the cancellation date';
    case 'incomplete': return 'an incomplete checkout — the first payment has never completed, so no Stripe subscription exists for them';
    case 'incomplete_expired': return 'an expired checkout — the setup window closed before the first payment completed';
    case 'unpaid': return 'marked unpaid in Stripe';
    default: return 'with this status';
  }
}

function toNumber(value: number | string | undefined): number {
  return value === undefined ? 0 : Number(value);
}

export function SubscriptionsStatsPage() {
  const [stats, setStats] = useState<SubscriptionStats | null>(null);
  const [pause, setPause] = useState<PauseStats | null>(null);
  const [trial, setTrial] = useState<TrialStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hideTestAccounts] = useHideTestAccounts();

  const [drillCell, setDrillCell] = useState<DrillCell | null>(null);
  const [drillRows, setDrillRows] = useState<DrillRow[]>([]);
  const [drillTotal, setDrillTotal] = useState(0);
  const [drillPage, setDrillPage] = useState(1);
  const [drillLoading, setDrillLoading] = useState(false);
  const [drillError, setDrillError] = useState<string | null>(null);

  const [trialGroup, setTrialGroup] = useState<TrialGroup | null>(null);
  const [trialDrillPage, setTrialDrillPage] = useState(1);
  const [trialNames, setTrialNames] = useState<Map<string, string | null>>(new Map());

  const [retentionOpen, setRetentionOpen] = useState<string | null>(null);
  const [retentionRows, setRetentionRows] = useState<RetentionDrillRow[]>([]);
  const [retentionPage, setRetentionPage] = useState(1);
  const [retentionLoading, setRetentionLoading] = useState(false);
  const [retentionError, setRetentionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const pExclude = hideTestAccounts ? TEST_ACCOUNT_IDS : [];

      const [subResult, pauseResult, trialResult] = await Promise.all([
        adminSupabase.rpc('admin_subscription_stats', { p_exclude: pExclude }),
        adminSupabase.rpc('admin_pause_reason_stats', { p_exclude: pExclude }),
        adminSupabase.rpc('admin_trial_conversion_stats', { p_exclude: pExclude }),
      ]);

      if (cancelled) return;

      const firstError = subResult.error ?? pauseResult.error ?? trialResult.error;
      if (firstError) {
        setError(firstError.message);
        setStats(null);
        setPause(null);
        setTrial(null);
        setLoading(false);
        return;
      }

      const subData = subResult.data as SubscriptionStats | null;
      const pauseData = pauseResult.data as PauseStats | null;
      const trialData = trialResult.data as TrialStats | null;
      if (!subData || !pauseData || !trialData) {
        setError('You do not have admin access to view these statistics.');
      } else {
        setError(null);
      }
      setStats(subData);
      setPause(pauseData);
      setTrial(trialData);
      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [hideTestAccounts]);

  useEffect(() => {
    if (!drillCell) return;
    let cancelled = false;
    setDrillLoading(true);
    setDrillError(null);

    (async () => {
      const from = (drillPage - 1) * DRILL_PAGE_SIZE;
      let subQuery = adminSupabase
        .from('subscriptions')
        .select('user_id, created_at, trial_ends_at, current_period_end, canceled_at', { count: 'exact' })
        .eq('plan', drillCell.plan)
        .eq('status', drillCell.status)
        .order('created_at', { ascending: false })
        .range(from, from + DRILL_PAGE_SIZE - 1);
      subQuery = withoutTestAccounts(subQuery, hideTestAccounts);

      const { data: subRows, count, error: subError } = await subQuery;
      if (cancelled) return;
      if (subError) {
        setDrillError(subError.message);
        setDrillRows([]);
        setDrillTotal(0);
        setDrillLoading(false);
        return;
      }

      const subs = (subRows ?? []) as DrillSubRow[];
      const profilesByUser = new Map<string, { display_name: string | null; copier_paused: boolean | null; copier_pause_reason: string | null }>();
      if (subs.length > 0) {
        const { data: profileRows, error: profileError } = await adminSupabase
          .from('user_profiles')
          .select('user_id, display_name, copier_paused, copier_pause_reason')
          .in('user_id', subs.map(s => s.user_id));
        if (cancelled) return;
        if (profileError) {
          setDrillError(profileError.message);
          setDrillRows([]);
          setDrillTotal(0);
          setDrillLoading(false);
          return;
        }
        (profileRows ?? []).forEach(p => {
          profilesByUser.set(p.user_id, {
            display_name: p.display_name,
            copier_paused: p.copier_paused,
            copier_pause_reason: p.copier_pause_reason,
          });
        });
      }

      setDrillRows(subs.map(s => ({
        ...s,
        display_name: profilesByUser.get(s.user_id)?.display_name ?? null,
        copier_paused: profilesByUser.get(s.user_id)?.copier_paused ?? null,
        copier_pause_reason: profilesByUser.get(s.user_id)?.copier_pause_reason ?? null,
      })));
      setDrillTotal(count ?? 0);
      setDrillLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [drillCell, drillPage, hideTestAccounts]);

  useEffect(() => {
    if (!trialGroup || !trial) return;
    let cancelled = false;
    const rows = trialGroup === 'converted' ? trial.converted
      : trialGroup === 'converted_canceled' ? trial.converted.filter(r => r.status === 'canceled')
      : trialGroup === 'not_converted' ? trial.not_converted
      : trial.in_trial;
    const ids = rows.map(r => r.user_id).slice(0, 500);
    if (ids.length === 0) {
      setTrialNames(new Map());
      return;
    }
    (async () => {
      const { data } = await adminSupabase
        .from('user_profiles')
        .select('user_id, display_name')
        .in('user_id', ids);
      if (cancelled) return;
      const map = new Map<string, string | null>();
      (data ?? []).forEach(p => map.set(p.user_id, p.display_name));
      setTrialNames(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [trialGroup, trial]);

  useEffect(() => {
    if (!retentionOpen) return;
    let cancelled = false;
    setRetentionLoading(true);
    setRetentionError(null);

    (async () => {
      let subQuery = adminSupabase
        .from('subscriptions')
        .select('user_id, plan, status, created_at, trial_ends_at, current_period_end, canceled_at')
        .in('status', ['active', 'past_due', 'canceled'])
        .order('created_at', { ascending: false });
      if (retentionOpen !== 'overall') subQuery = subQuery.eq('plan', retentionOpen);
      subQuery = withoutTestAccounts(subQuery, hideTestAccounts);

      const { data: subRows, error: subError } = await subQuery;
      if (cancelled) return;
      if (subError) {
        setRetentionError(subError.message);
        setRetentionRows([]);
        setRetentionLoading(false);
        return;
      }

      const { data: payRows, error: payError } = await adminSupabase
        .from('invoice_payments')
        .select('user_id');
      if (cancelled) return;
      if (payError) {
        setRetentionError(payError.message);
        setRetentionRows([]);
        setRetentionLoading(false);
        return;
      }
      const paidUsers = new Set<string>(((payRows ?? []) as { user_id: string }[]).map(r => r.user_id));
      const matched = ((subRows ?? []) as RetentionSubRow[]).filter(r => paidUsers.has(r.user_id));

      const profilesByUser = new Map<string, { display_name: string | null; joined_at: string | null; copier_paused: boolean | null; copier_pause_reason: string | null }>();
      if (matched.length > 0) {
        const { data: profileRows, error: profileError } = await adminSupabase
          .from('user_profiles')
          .select('user_id, display_name, created_at, copier_paused, copier_pause_reason')
          .in('user_id', matched.map(s => s.user_id).slice(0, 500));
        if (cancelled) return;
        if (profileError) {
          setRetentionError(profileError.message);
          setRetentionRows([]);
          setRetentionLoading(false);
          return;
        }
        (profileRows ?? []).forEach(p => {
          profilesByUser.set(p.user_id, {
            display_name: p.display_name,
            joined_at: p.created_at,
            copier_paused: p.copier_paused,
            copier_pause_reason: p.copier_pause_reason,
          });
        });
      }

      const statusRank = (status: string) => (status === 'active' ? 0 : status === 'past_due' ? 1 : 2);
      const rows = matched
        .map(s => ({
          ...s,
          display_name: profilesByUser.get(s.user_id)?.display_name ?? null,
          joined_at: profilesByUser.get(s.user_id)?.joined_at ?? null,
          copier_paused: profilesByUser.get(s.user_id)?.copier_paused ?? null,
          copier_pause_reason: profilesByUser.get(s.user_id)?.copier_pause_reason ?? null,
        }))
        .sort((a, b) => statusRank(a.status) - statusRank(b.status));
      setRetentionRows(rows);
      setRetentionLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [retentionOpen, hideTestAccounts]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="page-header"><h1 className="page-title">Subscription Stats</h1></div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="card p-6 skeleton h-72" />)}
        </div>
      </div>
    );
  }

  const totalsByStatus = new Map<string, number>();
  (stats?.totals ?? []).forEach(r => totalsByStatus.set(r.status, toNumber(r.total)));

  const kpis: { label: string; value: number; color: string }[] = [
    { label: 'Total', value: toNumber(stats?.total), color: 'text-slate-900 dark:text-slate-100' },
    { label: 'Active', value: totalsByStatus.get('active') ?? 0, color: 'text-success-600 dark:text-success-400' },
    { label: 'Free Trial', value: totalsByStatus.get('trialing') ?? 0, color: 'text-purple-600 dark:text-purple-400' },
    { label: 'Past due', value: totalsByStatus.get('past_due') ?? 0, color: 'text-warning-600 dark:text-warning-400' },
    { label: 'Canceled', value: totalsByStatus.get('canceled') ?? 0, color: 'text-slate-500 dark:text-slate-400' },
  ];

  const byPlan = stats?.by_plan ?? [];
  const statusOrder = Array.from(new Set(byPlan.map(r => r.status))).sort((a, b) => {
    const order = ['active', 'trialing', 'past_due', 'canceled', 'incomplete', 'incomplete_expired', 'unpaid', 'unknown'];
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
  });
  const planOrder = Array.from(new Set(byPlan.map(r => r.plan))).sort();
  const planChart: PlanBarRow[] = planOrder.map(plan => {
    const row: PlanBarRow = { plan };
    byPlan
      .filter(r => r.plan === plan)
      .forEach(r => { row[r.status] = toNumber(r.total); });
    return row;
  });

  const churn = stats?.churn ?? [];
  const churnMonths = Array.from(new Set(churn.map(r => r.month))).sort();
  const churnPlans = Array.from(new Set(churn.map(r => r.plan))).sort();
  const churnChart: ChurnBarRow[] = churnMonths.map(month => {
    const row: ChurnBarRow = { month };
    churn
      .filter(r => r.month === month)
      .forEach(r => { row[r.plan] = toNumber(r.total); });
    return row;
  });

  const started = stats?.started ?? [];
  const startedMonths = Array.from(new Set(started.map(r => r.month))).sort();
  const startedPlans = Array.from(new Set(started.map(r => r.plan))).sort();
  const startedChart: ChurnBarRow[] = startedMonths.map(month => {
    const row: ChurnBarRow = { month };
    started
      .filter(r => r.month === month)
      .forEach(r => { row[r.plan] = toNumber(r.total); });
    return row;
  });

  const reasons = pause?.reasons ?? [];
  const reasonChart = reasons.map(r => ({
    reason: r.reason,
    count: toNumber(r.total),
    fill: REASON_COLORS[r.reason] ?? CHART_PALETTE[6],
  }));
  const pausedTotal = toNumber(pause?.paused_total);
  const profilesTotal = toNumber(pause?.profiles_total);
  const pausedPercent = profilesTotal > 0 ? ((pausedTotal / profilesTotal) * 100).toFixed(1) : '0.0';

  const trialConvertedAll = trial?.converted ?? [];
  const trialConvertedActive = trialConvertedAll.filter(r => r.status !== 'canceled');
  const trialConvertedCanceled = trialConvertedAll.filter(r => r.status === 'canceled');
  const trialNotConverted = trial?.not_converted ?? [];
  const trialInTrial = trial?.in_trial ?? [];
  const trialDecided = trialConvertedAll.length + trialNotConverted.length;
  const trialRate = trialDecided > 0 ? `${((trialConvertedAll.length / trialDecided) * 100).toFixed(1)}%` : '—';
  const trialMonthChart = (trial?.monthly ?? []).map(r => ({
    month: r.month,
    converted: toNumber(r.converted),
    not_converted: toNumber(r.not_converted),
  }));
  const trialRowsAll: TrialDrillRow[] = (trialGroup === 'converted' ? trialConvertedActive
    : trialGroup === 'converted_canceled' ? trialConvertedCanceled
    : trialGroup === 'not_converted' ? trialNotConverted
    : trialInTrial)
    .map(r => ({ ...r, display_name: trialNames.get(r.user_id) ?? null }));
  const trialPageRows = trialRowsAll.slice(
    (trialDrillPage - 1) * DRILL_PAGE_SIZE,
    trialDrillPage * DRILL_PAGE_SIZE,
  );

  const retentionCounts = (stats?.retention ?? []).map(r => ({
    plan: r.plan,
    retained: toNumber(r.retained),
    churned: toNumber(r.churned),
  }));
  const retentionPlans = retentionCounts.filter(r => r.retained + r.churned > 0);
  const retentionTotals = retentionCounts.reduce(
    (acc, r) => ({ retained: acc.retained + r.retained, churned: acc.churned + r.churned }),
    { retained: 0, churned: 0 },
  );
  const retentionRate = (retained: number, churned: number) =>
    retained + churned > 0 ? `${((retained / (retained + churned)) * 100).toFixed(1)}%` : '—';
  const retentionPageRows = retentionRows.slice(
    (retentionPage - 1) * DRILL_PAGE_SIZE,
    retentionPage * DRILL_PAGE_SIZE,
  );

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="page-header flex items-start justify-between gap-3">
        <div>
          <h1 className="page-title">Subscription Stats</h1>
          <p className="page-subtitle">Subscription status, per-plan split, cancellations, retention and copier pause reasons</p>
        </div>
        <HideTestAccountsToggle />
      </div>

      {error && (
        <Alert variant="error" title="Subscription statistics are unavailable">
          {error}
        </Alert>
      )}

      {!error && !stats && !pause && (
        <Alert variant="error" title="No data">
          The statistics functions returned no data.
        </Alert>
      )}

      {stats && (
        <>
          {/* KPI row */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
            {kpis.map(kpi => (
              <Card key={kpi.label}>
                <CardContent className="p-4">
                  <p className="text-xs font-medium uppercase tracking-wider text-slate-400 dark:text-slate-500">{kpi.label}</p>
                  <p className={`text-2xl font-bold mt-1 ${kpi.color}`}>{kpi.value.toLocaleString()}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Status pie */}
            <Card>
              <CardHeader><h3 className="text-sm font-semibold">Subscriptions by Status (All Time)</h3></CardHeader>
              <CardContent>
                {(stats.totals ?? []).length === 0 ? (
                  <p className="text-slate-400 text-sm text-center py-8">No subscriptions</p>
                ) : (
                  <ResponsiveContainer width="100%" height={280}>
                    <PieChart>
                      <Pie
                        data={stats.totals.map(r => ({ status: displayLabel(r.status), count: toNumber(r.total) }))}
                        dataKey="count"
                        nameKey="status"
                        cx="50%"
                        cy="50%"
                        outerRadius={100}
                        label={(props: { status?: string; percent?: number }) => `${props.status ?? ''} ${((props.percent ?? 0) * 100).toFixed(0)}%`}
                        labelLine={false}
                      >
                        {stats.totals.map((entry, i) => (
                          <Cell key={i} fill={STATUS_COLORS[entry.status] ?? CHART_PALETTE[i % CHART_PALETTE.length]} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={tooltipStyle} itemStyle={tooltipItemStyle} />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            {/* Per-plan stacked bar */}
            <Card>
              <CardHeader><h3 className="text-sm font-semibold">Per-Plan Split by Status</h3></CardHeader>
              <CardContent>
                {planChart.length === 0 ? (
                  <p className="text-slate-400 text-sm text-center py-8">No subscriptions</p>
                ) : (
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart data={planChart}>
                      <CartesianGrid {...gridStyle} />
                      <XAxis dataKey="plan" {...axisStyle} />
                      <YAxis {...axisStyle} />
                      <Tooltip
                        contentStyle={tooltipStyle}
                        itemStyle={tooltipItemStyle}
                        formatter={(value, name) => [String(value), displayLabel(String(name))]}
                      />
                      <Legend formatter={(value) => displayLabel(String(value))} />
                      {statusOrder.map((status, i) => (
                        <Bar
                          key={status}
                          dataKey={status}
                          stackId="plans"
                          fill={STATUS_COLORS[status] ?? CHART_PALETTE[i % CHART_PALETTE.length]}
                          radius={status === statusOrder[statusOrder.length - 1] ? [3, 3, 0, 0] : [0, 0, 0, 0]}
                        />
                      ))}
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Status × plan matrix */}
          <Card>
            <CardHeader>
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-sm font-semibold">Status × Plan</h3>
                <span className="text-xs text-slate-400">Click a number to see the users behind it</span>
              </div>
            </CardHeader>
            <CardContent>
              {planChart.length === 0 ? (
                <p className="text-slate-400 text-sm text-center py-8">No subscriptions</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase tracking-wider text-slate-400 dark:text-slate-500 border-b border-slate-200 dark:border-slate-700">
                        <th className="py-2 pr-4 font-medium">Plan</th>
                        {statusOrder.map(status => (
                          <th key={status} className="py-2 px-3 font-medium text-right">{displayLabel(status)}</th>
                        ))}
                        <th className="py-2 pl-3 font-medium text-right">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {planChart.map(row => {
                        const rowTotal = statusOrder.reduce((sum, status) => sum + toNumber(row[status]), 0);
                        return (
                          <tr key={row.plan} className="border-b border-slate-100 dark:border-slate-800">
                            <td className="py-2 pr-4 font-medium capitalize">{row.plan}</td>
                            {statusOrder.map(status => {
                              const count = toNumber(row[status]);
                              return (
                                <td key={status} className="py-1 px-1 text-right">
                                  {count > 0 ? (
                                    <button
                                      onClick={() => { setDrillCell({ plan: row.plan, status }); setDrillPage(1); }}
                                      className="w-full px-3 py-1.5 rounded-md text-right tabular-nums font-medium text-primary-700 dark:text-primary-300 hover:bg-primary-50 dark:hover:bg-primary-900/30 cursor-pointer transition-colors"
                                      title={`View ${row.plan} ${displayLabel(status)} users`}
                                    >
                                      {count.toLocaleString()}
                                    </button>
                                  ) : (
                                    <span className="px-3 text-slate-300 dark:text-slate-600">—</span>
                                  )}
                                </td>
                              );
                            })}
                            <td className="py-2 pl-3 text-right font-semibold tabular-nums">{rowTotal.toLocaleString()}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Churn by month */}
            <Card>
              <CardHeader><h3 className="text-sm font-semibold">Cancellations by Month (Last 12 Months)</h3></CardHeader>
              <CardContent>
                {churnChart.length === 0 ? (
                  <p className="text-slate-400 text-sm text-center py-8">
                    No cancellations with a recorded date in the last 12 months
                  </p>
                ) : (
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart data={churnChart}>
                      <CartesianGrid {...gridStyle} />
                      <XAxis dataKey="month" {...axisStyle} interval="preserveStartEnd" />
                      <YAxis {...axisStyle} allowDecimals={false} />
                      <Tooltip contentStyle={tooltipStyle} itemStyle={tooltipItemStyle} />
                      <Legend />
                      {churnPlans.map((plan, i) => (
                        <Bar
                          key={plan}
                          dataKey={plan}
                          stackId="churn"
                          fill={STATUS_COLORS[plan] ?? CHART_PALETTE[i % CHART_PALETTE.length]}
                        />
                      ))}
                    </BarChart>
                  </ResponsiveContainer>
                )}
                {toNumber(stats.canceled_undated) > 0 && (
                  <p className="text-xs text-slate-400 mt-2">
                    {toNumber(stats.canceled_undated).toLocaleString()} canceled subscription
                    {toNumber(stats.canceled_undated) === 1 ? ' has' : 's have'} no cancellation date recorded and is not shown above.
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Pause reasons */}
            <Card>
              <CardHeader>
                <div>
                  <h3 className="text-sm font-semibold">Copier Pause Reasons</h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {pausedTotal.toLocaleString()} of {profilesTotal.toLocaleString()} copiers paused ({pausedPercent}%)
                  </p>
                </div>
              </CardHeader>
              <CardContent>
                {reasonChart.length === 0 ? (
                  <p className="text-slate-400 text-sm text-center py-8">No copiers are paused</p>
                ) : (
                  <ResponsiveContainer width="100%" height={Math.max(220, reasonChart.length * 44)}>
                    <BarChart data={reasonChart} layout="vertical" margin={{ left: 8 }}>
                      <CartesianGrid {...gridStyle} />
                      <XAxis type="number" {...axisStyle} allowDecimals={false} />
                      <YAxis
                        type="category"
                        dataKey="reason"
                        width={150}
                        {...axisStyle}
                        tick={{ ...axisStyle.tick, fontSize: 11 }}
                      />
                      <Tooltip contentStyle={tooltipStyle} itemStyle={tooltipItemStyle} />
                      <Bar dataKey="count" radius={[0, 3, 3, 0]}>
                        {reasonChart.map((entry, i) => (
                          <Cell key={i} fill={entry.fill} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* New subscriptions started */}
            <Card>
              <CardHeader><h3 className="text-sm font-semibold">New Subscriptions Started (Last 12 Months)</h3></CardHeader>
              <CardContent>
                {startedChart.length === 0 ? (
                  <p className="text-slate-400 text-sm text-center py-8">No subscriptions created in the last 12 months</p>
                ) : (
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart data={startedChart}>
                      <CartesianGrid {...gridStyle} />
                      <XAxis dataKey="month" {...axisStyle} interval="preserveStartEnd" />
                      <YAxis {...axisStyle} allowDecimals={false} />
                      <Tooltip contentStyle={tooltipStyle} itemStyle={tooltipItemStyle} />
                      <Legend />
                      {startedPlans.map((plan, i) => (
                        <Bar
                          key={plan}
                          dataKey={plan}
                          stackId="started"
                          fill={STATUS_COLORS[plan] ?? CHART_PALETTE[i % CHART_PALETTE.length]}
                        />
                      ))}
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            {/* Free trials ended by outcome */}
            <Card>
              <CardHeader><h3 className="text-sm font-semibold">Free Trials Ended by Outcome (Last 12 Months)</h3></CardHeader>
              <CardContent>
                {trialMonthChart.length === 0 ? (
                  <p className="text-slate-400 text-sm text-center py-8">No free trials ended in the last 12 months</p>
                ) : (
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart data={trialMonthChart}>
                      <CartesianGrid {...gridStyle} />
                      <XAxis dataKey="month" {...axisStyle} interval="preserveStartEnd" />
                      <YAxis {...axisStyle} allowDecimals={false} />
                      <Tooltip contentStyle={tooltipStyle} itemStyle={tooltipItemStyle} />
                      <Legend formatter={(value) => (value === 'converted' ? 'Subscribed after trial' : 'Trial ended, never paid')} />
                      <Bar dataKey="converted" stackId="trials" fill={CHART_COLORS.success} />
                      <Bar dataKey="not_converted" stackId="trials" fill={CHART_COLORS.error} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Trial conversion */}
          <Card>
            <CardHeader>
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-sm font-semibold">Free Trial Conversion</h3>
                <span className="text-xs text-slate-400">Click a number to see the people behind it</span>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
                <button
                  onClick={() => { setTrialGroup('converted'); setTrialDrillPage(1); }}
                  className="text-left rounded-lg border border-slate-200 dark:border-slate-700 p-4 hover:border-success-400 dark:hover:border-success-500 hover:bg-success-50/50 dark:hover:bg-success-900/10 cursor-pointer transition-colors"
                  title="View people who subscribed after their trial and still have a subscription"
                >
                  <p className="text-xs font-medium uppercase tracking-wider text-slate-400 dark:text-slate-500">Subscribed after trial</p>
                  <p className="text-2xl font-bold mt-1 text-success-600 dark:text-success-400">{trialConvertedActive.length.toLocaleString()}</p>
                </button>
                <button
                  onClick={() => { setTrialGroup('converted_canceled'); setTrialDrillPage(1); }}
                  className="text-left rounded-lg border border-slate-200 dark:border-slate-700 p-4 hover:border-warning-400 dark:hover:border-warning-500 hover:bg-warning-50/50 dark:hover:bg-warning-900/10 cursor-pointer transition-colors"
                  title="View people who subscribed after their trial and later canceled"
                >
                  <p className="text-xs font-medium uppercase tracking-wider text-slate-400 dark:text-slate-500">Subscribed, then canceled</p>
                  <p className="text-2xl font-bold mt-1 text-warning-600 dark:text-warning-400">{trialConvertedCanceled.length.toLocaleString()}</p>
                </button>
                <button
                  onClick={() => { setTrialGroup('not_converted'); setTrialDrillPage(1); }}
                  className="text-left rounded-lg border border-slate-200 dark:border-slate-700 p-4 hover:border-danger-400 dark:hover:border-danger-500 hover:bg-danger-50/50 dark:hover:bg-danger-900/10 cursor-pointer transition-colors"
                  title="View people whose trial ended without subscribing"
                >
                  <p className="text-xs font-medium uppercase tracking-wider text-slate-400 dark:text-slate-500">Trial ended, never paid</p>
                  <p className="text-2xl font-bold mt-1 text-danger-600 dark:text-danger-400">{trialNotConverted.length.toLocaleString()}</p>
                </button>
                <button
                  onClick={() => { setTrialGroup('in_trial'); setTrialDrillPage(1); }}
                  className="text-left rounded-lg border border-slate-200 dark:border-slate-700 p-4 hover:border-purple-400 dark:hover:border-purple-500 hover:bg-purple-50/50 dark:hover:bg-purple-900/10 cursor-pointer transition-colors"
                  title="View people currently in their free trial"
                >
                  <p className="text-xs font-medium uppercase tracking-wider text-slate-400 dark:text-slate-500">Still in trial</p>
                  <p className="text-2xl font-bold mt-1 text-purple-600 dark:text-purple-400">{trialInTrial.length.toLocaleString()}</p>
                </button>
                <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-4">
                  <p className="text-xs font-medium uppercase tracking-wider text-slate-400 dark:text-slate-500">Conversion rate</p>
                  <p className="text-2xl font-bold mt-1 text-slate-900 dark:text-slate-100">{trialRate}</p>
                </div>
              </div>
              <p className="text-xs text-slate-400 mt-3">
                Of people whose free trial has started: those who paid at least one invoice after the trial versus those
                whose trial ended without a single payment. People who subscribed and later canceled count as converted
                (they did pay) and are listed separately. People still inside their trial are not part of the rate.
              </p>
            </CardContent>
          </Card>

          {/* Subscription retention */}
          <Card>
            <CardHeader>
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-sm font-semibold">Subscription Retention</h3>
                <span className="text-xs text-slate-400">Click a rate to see the people behind it</span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Of everyone who has ever paid, the share still subscribed today
              </p>
            </CardHeader>
            <CardContent>
              {retentionTotals.retained + retentionTotals.churned === 0 ? (
                <p className="text-slate-400 text-sm text-center py-8">No paying subscribers yet</p>
              ) : (
                <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
                  <button
                    onClick={() => { setRetentionOpen('overall'); setRetentionPage(1); }}
                    className="text-left rounded-lg border border-slate-200 dark:border-slate-700 p-4 hover:border-success-400 dark:hover:border-success-500 hover:bg-success-50/50 dark:hover:bg-success-900/10 cursor-pointer transition-colors"
                    title="View the paying subscribers behind the overall retention rate"
                  >
                    <p className="text-xs font-medium uppercase tracking-wider text-slate-400 dark:text-slate-500">Overall</p>
                    <p className="text-2xl font-bold mt-1 text-success-600 dark:text-success-400">
                      {retentionRate(retentionTotals.retained, retentionTotals.churned)}
                    </p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {retentionTotals.retained.toLocaleString()} of {(retentionTotals.retained + retentionTotals.churned).toLocaleString()} still subscribed
                    </p>
                  </button>
                  {retentionPlans.map(r => (
                    <button
                      key={r.plan}
                      onClick={() => { setRetentionOpen(r.plan); setRetentionPage(1); }}
                      className="text-left rounded-lg border border-slate-200 dark:border-slate-700 p-4 hover:border-success-400 dark:hover:border-success-500 hover:bg-success-50/50 dark:hover:bg-success-900/10 cursor-pointer transition-colors"
                      title={`View the paying subscribers behind the ${r.plan} retention rate`}
                    >
                      <p className="text-xs font-medium uppercase tracking-wider text-slate-400 dark:text-slate-500 capitalize">{r.plan}</p>
                      <p className="text-2xl font-bold mt-1 text-success-600 dark:text-success-400">
                        {retentionRate(r.retained, r.churned)}
                      </p>
                      <p className="text-xs text-slate-400 mt-0.5">
                        {r.retained.toLocaleString()} of {(r.retained + r.churned).toLocaleString()} still subscribed
                      </p>
                    </button>
                  ))}
                </div>
              )}
              <p className="text-xs text-slate-400 mt-3">
                Counted from people who have paid at least one invoice. "Still subscribed" means active now, or past due
                with the payment being retried — they have not canceled. People who canceled after paying count as lost.
                People who never paid — incomplete checkouts, and trials that ended without payment — are not in the rate
                at all, and neither are trials still running.
              </p>
            </CardContent>
          </Card>
        </>
      )}

      <Modal
        open={drillCell !== null}
        onClose={() => setDrillCell(null)}
        title={drillCell ? `${displayLabel(drillCell.status)} · ${drillCell.plan}` : ''}
        subtitle={drillCell ? `${drillTotal.toLocaleString()} subscription${drillTotal === 1 ? '' : 's'}${hideTestAccounts ? ' · test accounts excluded' : ''}` : ''}
      >
        {drillCell && (
          <div className="rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 p-3 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
            <p>
              <span className="font-semibold text-slate-700 dark:text-slate-200">What you're seeing:</span>{' '}
              every user whose subscription is on the <b className="capitalize">{drillCell.plan}</b> plan and is{' '}
              {drillStatusExplanation(drillCell.status)} — the same number you clicked in the Status × Plan table.
              Listed newest first. The Copier column shows whether that user's copy trading is running and, when it is
              paused, why. Click a name to open their full profile.
              {hideTestAccounts
                ? ' The two team test accounts are excluded while the toggle is on.'
                : ' Test accounts are included right now (toggle is off).'}
            </p>
          </div>
        )}
        {drillError && (
          <Alert variant="error" title="Could not load users">{drillError}</Alert>
        )}
        <div className="overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr>
                <th>User</th>
                <th>Copier</th>
                <th>Joined</th>
                <th>
                  {drillCell?.status === 'canceled' ? 'Canceled'
                    : drillCell?.status === 'trialing' ? 'Trial Ends'
                    : 'Period End'}
                </th>
              </tr>
            </thead>
            <tbody>
              {drillLoading ? (
                Array.from({ length: 5 }).map((_, index) => (
                  <tr key={index}>
                    <td colSpan={4} className="px-4 py-3"><div className="skeleton h-4 w-full" /></td>
                  </tr>
                ))
              ) : drillRows.length === 0 ? (
                <tr><td colSpan={4} className="text-center py-6 text-slate-400">No users in this group</td></tr>
              ) : drillRows.map(row => (
                <tr key={row.user_id}>
                  <td><UserLink userId={row.user_id} displayName={row.display_name} /></td>
                  <td className="text-xs">
                    {row.copier_paused ? (
                      <span className="text-warning-700 dark:text-warning-400 font-medium">Paused · {pauseReasonLabel(row.copier_pause_reason)}</span>
                    ) : drillCell?.status === 'incomplete' || drillCell?.status === 'incomplete_expired' ? (
                      <span className="text-slate-400">Never started — no payment, no copier</span>
                    ) : (
                      <span className="text-success-600 dark:text-success-400">Active</span>
                    )}
                  </td>
                  <td className="text-xs text-slate-400">{formatDateOnly(row.created_at)}</td>
                  <td className="text-xs text-slate-500 dark:text-slate-400">
                    {drillCell?.status === 'canceled'
                      ? (row.canceled_at ? formatDateOnly(row.canceled_at) : '—')
                      : drillCell?.status === 'trialing'
                        ? (row.trial_ends_at ? formatDateOnly(row.trial_ends_at) : '—')
                        : (row.current_period_end ? formatDateOnly(row.current_period_end) : '—')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {drillTotal > DRILL_PAGE_SIZE && (
          <Pagination
            page={drillPage}
            totalPages={Math.max(1, Math.ceil(drillTotal / DRILL_PAGE_SIZE))}
            totalCount={drillTotal}
            pageSize={DRILL_PAGE_SIZE}
            onPageChange={setDrillPage}
          />
        )}
      </Modal>

      <Modal
        open={trialGroup !== null}
        onClose={() => setTrialGroup(null)}
        title={trialGroup === 'converted' ? 'Subscribed after trial' : trialGroup === 'converted_canceled' ? 'Subscribed, then canceled' : trialGroup === 'not_converted' ? 'Trial ended, never paid' : trialGroup === 'in_trial' ? 'Still in trial' : ''}
        subtitle={trialGroup ? `${trialRowsAll.length.toLocaleString()} people${hideTestAccounts ? ' · test accounts excluded' : ''}` : ''}
      >
        {trialGroup && (
          <div className="rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 p-3 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
            <p>
              <span className="font-semibold text-slate-700 dark:text-slate-200">What you're seeing:</span>{' '}
              {trialGroup === 'converted'
                ? 'people whose free trial has started, who paid at least one invoice, and who still have a subscription — they subscribed after the trial and have not canceled.'
                : trialGroup === 'converted_canceled'
                  ? 'people who did subscribe after their trial (at least one payment on record) but whose subscription has since ended — they are no longer paying.'
                  : trialGroup === 'not_converted'
                    ? 'people whose free trial has ended without a single payment on record — they never subscribed.'
                    : 'people whose free trial has not ended yet and who have not paid — the outcome is not decided yet. Soonest trial end first, so the top rows are the ones deciding soon.'}{' '}
              One row per person (their newest subscription),{' '}
              {trialGroup === 'in_trial' ? 'soonest trial end first' : 'newest trial end first'}. Dates: <b>Joined</b> is when they
              signed up, <b>Trial Ended</b> is the free-trial end, <b>Sub Started</b> is when the subscription was
              created, <b>Sub Ended</b> is the cancellation date or — for still-running subscriptions — the end of the
              current billing period (people still in a free trial show a dash there: their subscription has not
              started yet). Click a name to open their full profile.
              {hideTestAccounts
                ? ' The two team test accounts are excluded while the toggle is on.'
                : ' Test accounts are included right now (toggle is off).'}
            </p>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr>
                <th>User</th>
                <th>Plan</th>
                <th>Status</th>
                <th>Joined</th>
                <th>Trial Ended</th>
                <th>Sub Started</th>
                <th>Sub Ended</th>
              </tr>
            </thead>
            <tbody>
              {trialPageRows.length === 0 ? (
                <tr><td colSpan={7} className="text-center py-6 text-slate-400">No people in this group</td></tr>
              ) : trialPageRows.map(row => (
                <tr key={row.user_id}>
                  <td><UserLink userId={row.user_id} displayName={row.display_name} /></td>
                  <td className="text-xs capitalize">{row.plan ?? '—'}</td>
                  <td className="text-xs capitalize">{displayLabel(row.status ?? '') || '—'}</td>
                  <td className="text-xs text-slate-400">{row.joined_at ? formatDateOnly(row.joined_at) : '—'}</td>
                  <td className="text-xs text-slate-500 dark:text-slate-400">
                    {row.trial_ends_at ? formatDateOnly(row.trial_ends_at) : '—'}
                  </td>
                  <td className="text-xs text-slate-400">{formatDateOnly(row.sub_started_at)}</td>
                  <td className={`text-xs font-medium ${row.status === 'canceled' ? 'text-warning-600 dark:text-warning-400' : 'text-slate-400 dark:text-slate-500'}`}>
                    {row.status === 'trialing' || !row.sub_ended_at ? '—' : formatDateOnly(row.sub_ended_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {trialRowsAll.length > DRILL_PAGE_SIZE && (
          <Pagination
            page={trialDrillPage}
            totalPages={Math.max(1, Math.ceil(trialRowsAll.length / DRILL_PAGE_SIZE))}
            totalCount={trialRowsAll.length}
            pageSize={DRILL_PAGE_SIZE}
            onPageChange={setTrialDrillPage}
          />
        )}
      </Modal>

      <Modal
        open={retentionOpen !== null}
        onClose={() => setRetentionOpen(null)}
        title={`Subscription Retention${retentionOpen && retentionOpen !== 'overall' ? ` · ${retentionOpen}` : ''}`}
        subtitle={`${retentionRows.length.toLocaleString()} paying subscriber${retentionRows.length === 1 ? '' : 's'}${hideTestAccounts ? ' · test accounts excluded' : ''}`}
      >
        {retentionOpen && (
          <div className="rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 p-3 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
            <p>
              <span className="font-semibold text-slate-700 dark:text-slate-200">What you're seeing:</span>{' '}
              every person who has paid at least one invoice and whose newest subscription is{' '}
              {retentionOpen === 'overall' ? 'on any plan' : <>on the <b className="capitalize">{retentionOpen}</b> plan</>} —
              the same people the retention rate counts. Rows with status <b>Still subscribed</b> are active now or past due
              with the payment being retried (they have not canceled); rows with <b>Lost after paying</b> canceled after
              paying. Still-subscribed rows are listed first, then lost rows, each group newest first. Dates: <b>Joined</b>{' '}
              is when they signed up, <b>Trial Ended</b> is the free-trial end if they had one, <b>Sub Started</b> is when
              the subscription was created, <b>Sub Ended</b> is the cancellation date or the end of the current billing
              period. Click a name to open their full profile.
              {hideTestAccounts
                ? ' The two team test accounts are excluded while the toggle is on.'
                : ' Test accounts are included right now (toggle is off).'}
            </p>
          </div>
        )}
        {retentionError && (
          <Alert variant="error" title="Could not load paying subscribers">{retentionError}</Alert>
        )}
        <div className="overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr>
                <th>User</th>
                <th>Plan</th>
                <th>Status</th>
                <th>Outcome</th>
                <th>Copier</th>
                <th>Joined</th>
                <th>Trial Ended</th>
                <th>Sub Started</th>
                <th>Sub Ended</th>
              </tr>
            </thead>
            <tbody>
              {retentionLoading ? (
                Array.from({ length: 5 }).map((_, index) => (
                  <tr key={index}>
                    <td colSpan={9} className="px-4 py-3"><div className="skeleton h-4 w-full" /></td>
                  </tr>
                ))
              ) : retentionPageRows.length === 0 ? (
                <tr><td colSpan={9} className="text-center py-6 text-slate-400">No paying subscribers in this group</td></tr>
              ) : retentionPageRows.map(row => (
                <tr key={row.user_id}>
                  <td><UserLink userId={row.user_id} displayName={row.display_name} /></td>
                  <td className="text-xs capitalize">{row.plan ?? '—'}</td>
                  <td className="text-xs capitalize">{displayLabel(row.status)}</td>
                  <td className="text-xs">
                    {row.status === 'canceled' ? (
                      <span className="text-warning-600 dark:text-warning-400 font-medium">Lost after paying</span>
                    ) : (
                      <span className="text-success-600 dark:text-success-400 font-medium">Still subscribed</span>
                    )}
                  </td>
                  <td className="text-xs">
                    {row.copier_paused ? (
                      <span className="text-warning-700 dark:text-warning-400 font-medium">Paused · {pauseReasonLabel(row.copier_pause_reason)}</span>
                    ) : (
                      <span className="text-success-600 dark:text-success-400">Active</span>
                    )}
                  </td>
                  <td className="text-xs text-slate-400">{row.joined_at ? formatDateOnly(row.joined_at) : formatDateOnly(row.created_at)}</td>
                  <td className="text-xs text-slate-500 dark:text-slate-400">
                    {row.trial_ends_at ? formatDateOnly(row.trial_ends_at) : '—'}
                  </td>
                  <td className="text-xs text-slate-400">{formatDateOnly(row.created_at)}</td>
                  <td className={`text-xs font-medium ${row.status === 'canceled' ? 'text-warning-600 dark:text-warning-400' : 'text-slate-400 dark:text-slate-500'}`}>
                    {row.status === 'canceled'
                      ? (row.canceled_at ? formatDateOnly(row.canceled_at) : '—')
                      : (row.current_period_end ? formatDateOnly(row.current_period_end) : '—')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {retentionRows.length > DRILL_PAGE_SIZE && (
          <Pagination
            page={retentionPage}
            totalPages={Math.max(1, Math.ceil(retentionRows.length / DRILL_PAGE_SIZE))}
            totalCount={retentionRows.length}
            pageSize={DRILL_PAGE_SIZE}
            onPageChange={setRetentionPage}
          />
        )}
      </Modal>
    </div>
  );
}
