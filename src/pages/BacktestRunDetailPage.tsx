import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { authSupabase as adminSupabase } from '../lib/adminSupabase';
import { formatDate, formatCurrency, formatPercent, formatNumber } from '../lib/formatters';
import { Card, CardHeader, CardContent } from '../components/ui/Card';
import { StatusBadge } from '../components/StatusBadge';
import { JsonViewer } from '../components/JsonViewer';
import { Button } from '../components/ui/Button';
import { CHART_PALETTE, tooltipStyle, gridStyle, axisStyle } from '../lib/chartTheme';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

interface BacktestRun {
  id: string;
  user_id: string;
  name: string;
  status: string;
  progress_pct: number | null;
  progress_message: string | null;
  config: unknown;
  summary: Record<string, unknown> | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

function SummaryCard({ summary }: { summary: Record<string, unknown> }) {
  const items = [
    { label: 'Total Trades', value: String(summary.total_trades ?? '—') },
    { label: 'Win Rate', value: formatPercent(summary.win_rate as number) },
    { label: 'Profit Factor', value: formatNumber(summary.profit_factor as number) },
    { label: 'Max Drawdown', value: formatPercent(summary.max_drawdown as number) },
    { label: 'Total P&L', value: formatCurrency(summary.total_pnl as number) },
    { label: 'Sharpe Ratio', value: formatNumber(summary.sharpe_ratio as number) },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
      {items.map(item => (
        <div key={item.label} className="text-center">
          <p className="text-2xl font-bold text-slate-900 dark:text-slate-100">{item.value}</p>
          <p className="text-xs text-slate-400 mt-0.5">{item.label}</p>
        </div>
      ))}
    </div>
  );
}

interface BacktestTradeRow {
  id: string;
  symbol: string;
  direction: string;
  outcome: string;
  tps_hit: number | null;
  pnl: number | null;
  pnl_r: number | null;
  closed_at: string | null;
}

interface EquityPointRow {
  ts: string;
  equity: number;
  balance: number;
  drawdown_pct: number;
}

interface RunChannelRow {
  channel_id: string;
  telegram_channels: { display_name: string | null; channel_username: string | null }[] | null;
}

export function BacktestRunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();

  const [run, setRun] = useState<BacktestRun | null>(null);
  const [trades, setTrades] = useState<BacktestTradeRow[]>([]);
  const [equityPoints, setEquityPoints] = useState<EquityPointRow[]>([]);
  const [channels, setChannels] = useState<RunChannelRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!runId) return;
    async function load() {
      const [
        { data: r },
        { data: t },
        { data: ep },
        { data: ch },
      ] = await Promise.all([
        adminSupabase.from('backtest_runs').select('*').eq('id', runId!).maybeSingle(),
        adminSupabase.from('backtest_trades').select('*').eq('run_id', runId!).order('signal_at', { ascending: true }).limit(1000),
        adminSupabase.from('backtest_equity_points').select('ts, equity, balance, drawdown_pct').eq('run_id', runId!).order('ts', { ascending: true }),
        adminSupabase.from('backtest_run_channels').select('channel_id, telegram_channels(display_name, channel_username)').eq('run_id', runId!),
      ]);

      setRun(r as BacktestRun);
      setTrades(t ?? []);
      setEquityPoints((ep ?? []).map((p) => ({ ...p, ts: p.ts?.slice(0, 10) })));
      setChannels(ch ?? []);
      setLoading(false);
    }
    load();
  }, [runId]);

  if (loading) {
    return <div className="space-y-4"><div className="skeleton h-8 w-48 mb-4" />{Array.from({ length: 3 }).map((_, i) => <div key={i} className="card p-6 skeleton h-48" />)}</div>;
  }

  if (!run) {
    return <div className="text-slate-400 text-center py-16">Backtest run not found</div>;
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate('/backtests')}>
          <ArrowLeft className="w-4 h-4" /> Back
        </Button>
        <div>
          <h1 className="page-title">{run.name}</h1>
          <div className="flex items-center gap-2 mt-1">
            <StatusBadge status={run.status} dot />
            {run.progress_pct != null && <span className="text-xs text-slate-400">{run.progress_pct.toFixed(0)}%</span>}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
        {[
          { label: 'Started', value: formatDate(run.started_at) },
          { label: 'Completed', value: run.completed_at ? formatDate(run.completed_at) : '—' },
          { label: 'Trades', value: trades.length },
          { label: 'Channels', value: channels.length },
        ].map(s => (
          <div key={s.label} className="stat-card">
            <p className="stat-label">{s.label}</p>
            <p className="text-lg font-semibold text-slate-900 dark:text-slate-100 mt-1">{s.value}</p>
          </div>
        ))}
      </div>

      {run.error_message && (
        <Card padding="md" className="border-error-200 dark:border-error-800">
          <p className="text-xs font-semibold text-error-600 dark:text-error-400 mb-1">Error</p>
          <pre className="text-xs text-error-500 whitespace-pre-wrap">{run.error_message}</pre>
        </Card>
      )}

      {/* Summary */}
      {run.summary && (
        <Card>
          <CardHeader><h3 className="text-sm font-semibold">Performance Summary</h3></CardHeader>
          <CardContent>
            <SummaryCard summary={run.summary} />
          </CardContent>
        </Card>
      )}

      {/* Equity Curve */}
      {equityPoints.length > 0 && (
        <Card>
          <CardHeader><h3 className="text-sm font-semibold">Equity Curve</h3></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={equityPoints}>
                <CartesianGrid {...gridStyle} />
                <XAxis dataKey="ts" {...axisStyle} interval="preserveStartEnd" />
                <YAxis yAxisId="left" {...axisStyle} tickFormatter={v => `$${v.toFixed(0)}`} />
                <YAxis yAxisId="right" orientation="right" {...axisStyle} tickFormatter={v => `${v.toFixed(1)}%`} />
                <Tooltip contentStyle={tooltipStyle} />
                <Legend />
                <Line yAxisId="left" type="monotone" dataKey="equity" stroke={CHART_PALETTE[0]} dot={false} strokeWidth={2} name="Equity" />
                <Line yAxisId="left" type="monotone" dataKey="balance" stroke={CHART_PALETTE[1]} dot={false} strokeWidth={1.5} strokeDasharray="4 2" name="Balance" />
                <Line yAxisId="right" type="monotone" dataKey="drawdown_pct" stroke={CHART_PALETTE[4]} dot={false} strokeWidth={1.5} name="Drawdown %" />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Config & channels */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader><h3 className="text-sm font-semibold">Channels ({channels.length})</h3></CardHeader>
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead><tr><th>Channel</th><th>Username</th></tr></thead>
              <tbody>
                {channels.length === 0 ? (
                  <tr><td colSpan={2} className="text-center py-6 text-slate-400">No channels</td></tr>
                ) : channels.map((c) => (
                  <tr key={c.channel_id}>
                    <td className="font-medium">{c.telegram_channels?.[0]?.display_name ?? '—'}</td>
                    <td className="text-slate-500 text-xs">@{c.telegram_channels?.[0]?.channel_username ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card>
          <CardHeader><h3 className="text-sm font-semibold">Config</h3></CardHeader>
          <CardContent>
            <JsonViewer data={run.config} collapsed={false} />
          </CardContent>
        </Card>
      </div>

      {/* Trades table */}
      <Card>
        <CardHeader><h3 className="text-sm font-semibold">Backtest Trades ({trades.length})</h3></CardHeader>
        <div className="overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr>
                <th>Symbol</th><th>Direction</th><th>Outcome</th><th>TPs Hit</th>
                <th>P&L</th><th>P&L (R)</th><th>Closed</th>
              </tr>
            </thead>
            <tbody>
              {trades.length === 0 ? (
                <tr><td colSpan={7} className="text-center py-8 text-slate-400">No trades</td></tr>
              ) : trades.slice(0, 100).map((t) => (
                <tr key={t.id}>
                  <td className="font-bold">{t.symbol}</td>
                  <td><StatusBadge status={t.direction} /></td>
                  <td><StatusBadge status={t.outcome} /></td>
                  <td className="text-xs">{t.tps_hit ?? 0}</td>
                  <td className={t.pnl != null ? (t.pnl >= 0 ? 'text-success-600 dark:text-success-400 font-medium' : 'text-error-600 dark:text-error-400 font-medium') : ''}>
                    {formatCurrency(t.pnl)}
                  </td>
                  <td className="text-xs text-slate-400">{t.pnl_r != null ? `${t.pnl_r.toFixed(2)}R` : '—'}</td>
                  <td className="text-xs text-slate-400">{formatDate(t.closed_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {trades.length > 100 && (
          <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-700 text-xs text-slate-400">
            Showing first 100 of {trades.length} trades
          </div>
        )}
      </Card>
    </div>
  );
}
