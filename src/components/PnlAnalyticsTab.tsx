import { useEffect, useMemo, useState } from 'react';
import { authSupabase as adminSupabase, fetchDisplayNames } from '../lib/adminSupabase';
import { formatDate, formatCurrency, formatPercent } from '../lib/formatters';
import { Card, CardHeader, CardContent } from './ui/Card';
import { UserLink } from './UserLink';
import { Select } from './ui/Select';
import { TradePipelineModal } from './TradePipelineModal';
import { CHART_PALETTE, tooltipStyle, gridStyle, axisStyle } from '../lib/chartTheme';
import clsx from 'clsx';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Cell, ReferenceLine, PieChart, Pie,
} from 'recharts';

interface TradeRow {
  id: string;
  symbol: string | null;
  direction: string | null;
  profit: number | null;
  user_id: string | null;
  closed_at: string | null;
  opened_at: string | null;
  status: string | null;
  signal_id: string | null;
  entry_price: number | null;
  sl: number | null;
  tp: number | null;
  lot_size: number | null;
  broker_label: string | null;
  broker_account_id: string | null;
  metaapi_order_id: string | null;
}

interface SymbolStat {
  symbol: string;
  count: number;
  pnl: number;
  winRate: number;
}

interface UserStat {
  user_id: string;
  display_name: string | null;
  count: number;
  pnl: number;
  winRate: number;
}

interface DailyPnl {
  date: string;
  pnl: number;
}

const PAGE_SIZE = 1000;
const TRADE_CAP = 10000;
const CUMULATIVE_CAP = 500;

export function PnlAnalyticsTab({ rangeDays }: { rangeDays: number | null }) {
  const [trades, setTrades] = useState<TradeRow[]>([]);
  const [symbolStats, setSymbolStats] = useState<SymbolStat[]>([]);
  const [userStats, setUserStats] = useState<UserStat[]>([]);
  const [dailyPnl, setDailyPnl] = useState<DailyPnl[]>([]);
  const [cumulative, setCumulative] = useState<DailyPnl[]>([]);
  const [directionData, setDirectionData] = useState<{ name: string; value: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [capped, setCapped] = useState(false);
  const [pnlFilter, setPnlFilter] = useState<'all' | 'winners' | 'losers'>('all');
  const [selectedTrade, setSelectedTrade] = useState<{
    id: string;
    symbol: string;
    direction: string;
    status: string;
    profit: number | null;
    entry_price: number | null;
    sl: number | null;
    tp: number | null;
    lot_size: number | null;
    opened_at: string | null;
    closed_at: string | null;
    broker_label: string | null;
    signal_id: string | null;
    broker_account_id: string | null;
    metaapi_order_id: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setTrades([]);
    setSymbolStats([]);
    setUserStats([]);
    setDailyPnl([]);
    setCumulative([]);
    setDirectionData([]);
    setCapped(false);

    (async () => {
      const rows: TradeRow[] = [];
      for (let page = 0; page < 200; page += 1) {
        if (cancelled) return;
        let q = adminSupabase
          .from('trades')
          .select('id, symbol, direction, profit, user_id, closed_at, opened_at, status, signal_id, entry_price, sl, tp, lot_size, broker_account_id, metaapi_order_id')
          .eq('status', 'closed')
          .order('closed_at', { ascending: false });

        if (rangeDays != null) {
          const from = new Date();
          from.setDate(from.getDate() - rangeDays);
          q = q.gte('closed_at', from.toISOString());
        }

        const fromIdx = page * PAGE_SIZE;
        const { data } = await q.range(fromIdx, fromIdx + PAGE_SIZE - 1);

        rows.push(...((data ?? []) as TradeRow[]));
        if (rows.length >= TRADE_CAP) {
          setCapped(true);
          break;
        }
        if ((data ?? []).length < PAGE_SIZE) break;
      }

      if (cancelled) return;
      setTrades(rows);

      const withPnl = rows.filter(t => t.profit != null);

      const pnlMap: Record<string, number> = {};
      for (const t of withPnl) {
        const date = t.closed_at?.slice(0, 10);
        if (date) pnlMap[date] = (pnlMap[date] ?? 0) + (t.profit ?? 0);
      }
      setDailyPnl(Object.entries(pnlMap).sort((a, b) => a[0].localeCompare(b[0])).map(([date, pnl]) => ({ date, pnl })));

      const sortedByClose = [...withPnl].filter(t => t.closed_at).sort((a, b) => (a.closed_at ?? '').localeCompare(b.closed_at ?? ''));
      const cum: DailyPnl[] = [];
      let running = 0;
      const step = Math.max(1, Math.ceil(sortedByClose.length / CUMULATIVE_CAP));
      for (let i = 0; i < sortedByClose.length; i += step) {
        const slice = sortedByClose.slice(i, i + step);
        running += slice.reduce((a, t) => a + (t.profit ?? 0), 0);
        cum.push({ date: slice[slice.length - 1].closed_at?.slice(0, 10) ?? '', pnl: running });
      }
      if (sortedByClose.length > 0 && cum.length === 0) {
        cum.push({ date: sortedByClose[sortedByClose.length - 1].closed_at?.slice(0, 10) ?? '', pnl: withPnl.reduce((a, t) => a + (t.profit ?? 0), 0) });
      }
      setCumulative(cum);

      const buyCount = rows.filter(t => t.direction === 'buy').length;
      const sellCount = rows.filter(t => t.direction === 'sell').length;
      setDirectionData([
        { name: 'Buy', value: buyCount },
        { name: 'Sell', value: sellCount },
      ].filter(d => d.value > 0));

      const symMap = new Map<string, { count: number; pnl: number; wins: number }>();
      for (const t of withPnl) {
        if (!t.symbol) continue;
        const s = symMap.get(t.symbol) ?? { count: 0, pnl: 0, wins: 0 };
        s.count += 1;
        s.pnl += t.profit ?? 0;
        if ((t.profit ?? 0) > 0) s.wins += 1;
        symMap.set(t.symbol, s);
      }
      setSymbolStats([...symMap.entries()]
        .map(([symbol, s]) => ({ symbol, count: s.count, pnl: s.pnl, winRate: (s.wins / s.count) * 100 }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 15));

      const userMap = new Map<string, { count: number; pnl: number; wins: number }>();
      for (const t of withPnl) {
        if (!t.user_id) continue;
        const u = userMap.get(t.user_id) ?? { count: 0, pnl: 0, wins: 0 };
        u.count += 1;
        u.pnl += t.profit ?? 0;
        if ((t.profit ?? 0) > 0) u.wins += 1;
        userMap.set(t.user_id, u);
      }
      const topUsers = [...userMap.entries()]
        .map(([userId, u]) => ({ user_id: userId, display_name: null as string | null, count: u.count, pnl: u.pnl, winRate: (u.wins / u.count) * 100 }))
        .sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl))
        .slice(0, 10);

      const names = await fetchDisplayNames(topUsers.map(u => u.user_id));
      for (const u of topUsers) u.display_name = names[u.user_id] ?? null;
      if (cancelled) return;
      setUserStats(topUsers);
      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [rangeDays]);

  const visibleTrades = useMemo(() => {
    const filtered = pnlFilter === 'all'
      ? trades
      : trades.filter(t => pnlFilter === 'winners' ? (t.profit ?? 0) > 0 : (t.profit ?? 0) < 0);
    return filtered.slice(0, 200);
  }, [trades, pnlFilter]);

  if (loading) {
    return <div className="grid grid-cols-1 gap-6">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="card p-6 skeleton h-72" />)}</div>;
  }

  const withPnl = trades.filter(t => t.profit != null);
  const netPnl = withPnl.reduce((a, t) => a + (t.profit ?? 0), 0);
  const wins = withPnl.filter(t => (t.profit ?? 0) > 0);
  const losses = withPnl.filter(t => (t.profit ?? 0) < 0);
  const grossProfit = wins.reduce((a, t) => a + (t.profit ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + (t.profit ?? 0), 0));
  const winRate = withPnl.length > 0 ? (wins.length / withPnl.length) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);
  const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
  const avgTrade = withPnl.length > 0 ? netPnl / withPnl.length : 0;
  const totalTrades = trades.length;

  const openTradeModal = (t: TradeRow) => setSelectedTrade({
    id: t.id,
    symbol: t.symbol ?? '—',
    direction: t.direction ?? '—',
    status: t.status ?? '—',
    profit: t.profit,
    entry_price: t.entry_price,
    sl: t.sl,
    tp: t.tp,
    lot_size: t.lot_size,
    opened_at: t.opened_at,
    closed_at: t.closed_at,
    broker_label: t.broker_label,
    signal_id: t.signal_id,
    broker_account_id: t.broker_account_id,
    metaapi_order_id: t.metaapi_order_id,
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-4">
        <StatPill label="Net P&L" value={formatCurrency(netPnl)} tone={netPnl >= 0 ? 'success' : 'error'} />
        <StatPill label="Win rate" value={formatPercent(winRate)} />
        <StatPill label="Profit factor" value={Number.isFinite(profitFactor) ? profitFactor.toFixed(2) : '∞'} />
        <StatPill label="Avg win / loss" value={`${formatCurrency(avgWin)} / ${formatCurrency(avgLoss)}`} small />
        <StatPill label="Closed trades" value={totalTrades.toLocaleString()} />
        <StatPill label="Avg per trade" value={formatCurrency(avgTrade)} tone={avgTrade >= 0 ? 'success' : 'error'} />
      </div>

      {capped && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Analysis capped at the first {TRADE_CAP.toLocaleString()} closed trades in this range — refine the range for full coverage.
        </p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader><h3 className="text-sm font-semibold">Cumulative P&L</h3></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={cumulative}>
                <defs>
                  <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={netPnl >= 0 ? '#22c55e' : '#ef4444'} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={netPnl >= 0 ? '#22c55e' : '#ef4444'} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid {...gridStyle} />
                <XAxis dataKey="date" {...axisStyle} tickFormatter={d => d.slice(5)} interval="preserveStartEnd" />
                <YAxis {...axisStyle} tickFormatter={v => formatCurrency(Number(v))} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v) => [formatCurrency(Number(v)), 'Cumulative P&L']} />
                <ReferenceLine y={0} stroke="#334155" />
                <Area type="monotone" dataKey="pnl" stroke={netPnl >= 0 ? '#22c55e' : '#ef4444'} strokeWidth={2} fill="url(#pnlGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><h3 className="text-sm font-semibold">Direction split</h3></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={directionData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={2}>
                  {directionData.map((_, i) => (
                    <Cell key={i} fill={CHART_PALETTE[i % CHART_PALETTE.length]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={tooltipStyle} />
              </PieChart>
            </ResponsiveContainer>
            <div className="flex justify-center gap-4 text-xs">
              {directionData.map((d, i) => (
                <span key={d.name} className="flex items-center gap-1.5 text-slate-500">
                  <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: CHART_PALETTE[i % CHART_PALETTE.length] }} />
                  {d.name}: {d.value.toLocaleString()} ({totalTrades > 0 ? Math.round((d.value / totalTrades) * 100) : 0}%)
                </span>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><h3 className="text-sm font-semibold">Daily P&L (All Users Combined)</h3></CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={dailyPnl}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" {...axisStyle} tickFormatter={d => d.slice(5)} interval="preserveStartEnd" />
              <YAxis {...axisStyle} tickFormatter={v => formatCurrency(Number(v))} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v) => [formatCurrency(Number(v)), 'P&L']} />
              <ReferenceLine y={0} stroke="#334155" />
              <Bar dataKey="pnl" radius={[3, 3, 0, 0]}>
                {dailyPnl.map((entry, i) => (
                  <Cell key={i} fill={entry.pnl >= 0 ? '#22c55e' : '#ef4444'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader><h3 className="text-sm font-semibold">Top Symbols</h3></CardHeader>
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead><tr><th>Symbol</th><th className="text-right">Trades</th><th className="text-right">Win rate</th><th className="text-right">P&L</th></tr></thead>
              <tbody>
                {symbolStats.length === 0 ? (
                  <tr><td colSpan={4} className="text-center py-8 text-slate-400">No data</td></tr>
                ) : symbolStats.map(s => (
                  <tr key={s.symbol}>
                    <td className="font-bold text-sm">{s.symbol}</td>
                    <td className="text-right text-slate-400">{s.count.toLocaleString()}</td>
                    <td className="text-right">{formatPercent(s.winRate)}</td>
                    <td className={clsx('text-right font-medium', s.pnl >= 0 ? 'text-success-600 dark:text-success-400' : 'text-error-600 dark:text-error-400')}>{formatCurrency(s.pnl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card>
          <CardHeader><h3 className="text-sm font-semibold">Top Users by P&L</h3></CardHeader>
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead><tr><th>User</th><th className="text-right">Trades</th><th className="text-right">Win rate</th><th className="text-right">P&L</th></tr></thead>
              <tbody>
                {userStats.length === 0 ? (
                  <tr><td colSpan={4} className="text-center py-8 text-slate-400">No data</td></tr>
                ) : userStats.map(u => (
                  <tr key={u.user_id}>
                    <td><UserLink userId={u.user_id} displayName={u.display_name} /></td>
                    <td className="text-right text-slate-400">{u.count.toLocaleString()}</td>
                    <td className="text-right">{formatPercent(u.winRate)}</td>
                    <td className={clsx('text-right font-medium', u.pnl >= 0 ? 'text-success-600 dark:text-success-400' : 'text-error-600 dark:text-error-400')}>{formatCurrency(u.pnl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {/* The trades behind these numbers */}
      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold">The trades behind these numbers</h3>
          <p className="text-xs text-slate-400">
            The latest {visibleTrades.length.toLocaleString()} closed trades in this range. Click a row for the full pipeline — timeline, latency, AI explanation and execution attempts.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Select
              options={[
                { value: 'all', label: 'All trades' },
                { value: 'winners', label: 'Winners only' },
                { value: 'losers', label: 'Losers only' },
              ]}
              value={pnlFilter}
              onChange={e => setPnlFilter(e.target.value as 'all' | 'winners' | 'losers')}
              className="w-40"
            />
            <span className="text-xs text-slate-400">
              {visibleTrades.length.toLocaleString()} of {trades.length.toLocaleString()} shown — click a row for details
            </span>
          </div>

          {visibleTrades.length === 0 ? (
            <p className="text-xs text-slate-400">No trades match this filter.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Opened</th>
                    <th>Symbol</th>
                    <th>Dir</th>
                    <th>Status</th>
                    <th className="text-right">P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleTrades.map(t => (
                    <tr
                      key={t.id}
                      className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50"
                      onClick={() => openTradeModal(t)}
                      title="Open trade pipeline"
                    >
                      <td className="text-xs text-slate-400 whitespace-nowrap">{t.closed_at ? formatDate(t.closed_at) : '—'}</td>
                      <td className="font-bold text-sm">{t.symbol ?? '—'}</td>
                      <td><span className="badge bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 text-xs">{t.direction ?? '—'}</span></td>
                      <td><span className="badge bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 text-xs">{t.status ?? '—'}</span></td>
                      <td className={clsx('text-right font-medium', (t.profit ?? 0) >= 0 ? 'text-success-600 dark:text-success-400' : 'text-error-600 dark:text-error-400')}>
                        {t.profit != null ? formatCurrency(t.profit) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {selectedTrade && (
        <TradePipelineModal trade={selectedTrade} onClose={() => setSelectedTrade(null)} />
      )}
    </div>
  );
}

function StatPill({ label, value, tone, small }: { label: string; value: string; tone?: 'success' | 'error'; small?: boolean }) {
  return (
    <div className="card px-4 py-3 flex-1 min-w-40">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
      <p className={clsx('mt-1 font-bold text-slate-900 dark:text-slate-100', small ? 'text-base' : 'text-xl', tone === 'success' && 'text-success-600 dark:text-success-400', tone === 'error' && 'text-error-600 dark:text-error-400')}>
        {value}
      </p>
    </div>
  );
}
