import { useEffect, useState } from 'react';
import { authSupabase as adminSupabase, fetchDisplayNames } from '../lib/adminSupabase';
import { formatDate, formatCurrency, formatLots } from '../lib/formatters';
import { DataTable, Pagination } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import { UserLink } from '../components/UserLink';
import { ExportButton } from '../components/ExportButton';
import { TradePipelineModal } from '../components/TradePipelineModal';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { Card } from '../components/ui/Card';
import { Search, Activity, ChevronDown, ChevronRight } from 'lucide-react';
import type { Column } from '../components/DataTable';
import { classifyTradeExecutionType, type TradeExecutionEvidenceLog, type TradeExecutionType } from '../lib/tradeExecutionType';

interface TradeRow {
  id: string;
  user_id: string;
  user_display_name: string | null;
  broker_account_id: string | null;
  broker_label: string | null;
  metaapi_order_id: string | null;
  signal_id: string | null;
  symbol: string;
  direction: string;
  entry_price: number | null;
  sl: number | null;
  tp: number | null;
  lot_size: number | null;
  status: string;
  profit: number | null;
  opened_at: string | null;
  closed_at: string | null;
  tp_levels: unknown;
  tp_open: unknown;
  next_tp_index: number | null;
  trail_peak_price: number | null;
  trail_last_sl: number | null;
  trail_start_pips: number | null;
  trail_step_pips: number | null;
  trail_distance_pips: number | null;
  auto_be_mode: string | null;
  auto_be_trigger_value: number | null;
  auto_be_tp_index: number | null;
  auto_be_type: string | null;
  auto_be_offset_pips: number | null;
  auto_be_applied_at: string | null;
  telegram_channel_id: string | null;
  channel_display_name: string | null;
  execution_type: TradeExecutionType;
}

const PAGE_SIZE = 50;

interface TradesPageProps {
  fixedStatus?: string;
  title?: string;
  subtitle?: string;
}

export function TradesPage({ fixedStatus, title = 'Trades', subtitle }: TradesPageProps) {
  const [status, setStatus] = useState(fixedStatus ?? '');
  const [direction, setDirection] = useState('');
  const [symbol, setSymbol] = useState('');
  const [userId, setUserId] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [data, setData] = useState<TradeRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pipelineTrade, setPipelineTrade] = useState<TradeRow | null>(null);

  useEffect(() => { setPage(1); }, [status, direction, symbol, userId, dateFrom, dateTo]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    (async () => {
      const from = (page - 1) * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      let q = adminSupabase
        .from('trades')
        .select(
          'id, user_id, broker_account_id, metaapi_order_id, signal_id, telegram_channel_id, symbol, direction, entry_price, sl, tp, lot_size, status, profit, opened_at, closed_at, tp_levels, tp_open, next_tp_index, trail_peak_price, trail_last_sl, trail_start_pips, trail_step_pips, trail_distance_pips, auto_be_mode, auto_be_trigger_value, auto_be_tp_index, auto_be_type, auto_be_offset_pips, auto_be_applied_at',
          { count: 'exact' }
        )
        .order('opened_at', { ascending: false, nullsFirst: false })
        .range(from, to);

      if (status) q = q.eq('status', status);
      if (direction) q = q.eq('direction', direction);
      if (symbol) q = q.ilike('symbol', `%${symbol}%`);
      if (userId) q = q.eq('user_id', userId);
      if (dateFrom) q = q.gte('opened_at', dateFrom);
      if (dateTo) q = q.lte('opened_at', dateTo + 'T23:59:59Z');

      const { data: rows, count, error } = await q;
      if (cancelled) return;
      if (error) { setLoading(false); return; }

      const userIds = [...new Set((rows ?? []).map((r) => r.user_id).filter(Boolean))];
      const brokerIds = [...new Set((rows ?? []).map((r) => r.broker_account_id).filter(Boolean))];
      const channelIds = [...new Set((rows ?? []).map((r) => r.telegram_channel_id).filter((id): id is string => Boolean(id)))];
      const signalIds = [...new Set((rows ?? []).map((r) => r.signal_id).filter((id): id is string => Boolean(id)))];

      const [displayNames, brokerLabels, channelRows, logRows] = await Promise.all([
        fetchDisplayNames(userIds),
        brokerIds.length > 0
          ? adminSupabase.from('broker_accounts').select('id, label').in('id', brokerIds)
              .then(({ data }) => {
                const m: Record<string, string> = {};
                (data ?? []).forEach((b) => { m[b.id] = b.label; });
                return m;
              })
          : Promise.resolve({} as Record<string, string>),
        channelIds.length > 0 ? adminSupabase.from('telegram_channels').select('id, display_name, channel_username').in('id', channelIds) : Promise.resolve({ data: [] }),
        signalIds.length > 0 ? adminSupabase.from('trade_execution_logs').select('signal_id, action, status, request_payload, response_payload').in('signal_id', signalIds).order('created_at', { ascending: false }).limit(2000) : Promise.resolve({ data: [] }),
      ]);

      if (cancelled) return;
      const channelNames: Record<string, string> = {};
      (channelRows.data ?? []).forEach((channel) => { channelNames[channel.id] = channel.display_name ?? channel.channel_username ?? 'Unnamed channel'; });
      const logs = (logRows.data ?? []) as (TradeExecutionEvidenceLog & { signal_id?: string })[];
      const linkedCounts = new Map<string, number>();
      (rows ?? []).forEach((r) => {
        const key = `${r.signal_id ?? 'none'}:${r.broker_account_id ?? 'none'}`;
        linkedCounts.set(key, (linkedCounts.get(key) ?? 0) + 1);
      });
      setData((rows ?? []).map((r) => {
        const key = `${r.signal_id ?? 'none'}:${r.broker_account_id ?? 'none'}`;
        const rowLogs = logs.filter(log => log.signal_id === r.signal_id);
        return {
          ...r,
          user_display_name: displayNames[r.user_id] ?? null,
          broker_label: brokerLabels[r.broker_account_id] ?? null,
          channel_display_name: channelNames[r.telegram_channel_id] ?? null,
          execution_type: classifyTradeExecutionType({ logs: rowLogs, ticket: r.metaapi_order_id, linkedTradeCount: linkedCounts.get(key) ?? 1 }),
        };
      }));
      setTotal(count ?? 0);
      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [page, status, direction, symbol, userId, dateFrom, dateTo]);

  const columns: Column<TradeRow>[] = [
    { key: 'user_display_name', label: 'User', render: r => <UserLink userId={r.user_id} displayName={r.user_display_name} /> },
    { key: 'broker_label', label: 'Broker', render: r => <span className="text-xs text-slate-500">{r.broker_label ?? '—'}</span> },
    { key: 'symbol', label: 'Symbol', render: r => <span className="font-bold text-sm">{r.symbol}</span> },
    { key: 'direction', label: 'Dir', render: r => <StatusBadge status={r.direction} /> },
    { key: 'execution_type', label: 'Type', render: r => <span className="rounded-full bg-primary-50 dark:bg-primary-900/30 px-2 py-0.5 text-[10px] font-semibold text-primary-700 dark:text-primary-300 whitespace-nowrap">{r.execution_type}</span> },
    { key: 'channel_display_name', label: 'Channel', render: r => <span className="text-xs text-slate-500 max-w-[150px] block truncate" title={r.channel_display_name ?? undefined}>{r.channel_display_name ?? '—'}</span> },
    { key: 'entry_price', label: 'Entry', render: r => <span className="font-mono text-xs">{r.entry_price ?? '—'}</span> },
    { key: 'sl', label: 'SL', render: r => <span className="font-mono text-xs text-error-500">{r.sl ?? '—'}</span> },
    { key: 'lot_size', label: 'Lots', sortable: true, render: r => formatLots(r.lot_size) },
    { key: 'status', label: 'Status', render: r => <StatusBadge status={r.status} dot /> },
    {
      key: 'profit',
      label: 'P&L',
      sortable: true,
      render: r => r.profit != null
        ? <span className={r.profit >= 0 ? 'text-success-600 dark:text-success-400 font-medium' : 'text-error-600 dark:text-error-400 font-medium'}>{formatCurrency(r.profit)}</span>
        : <span className="text-slate-400">—</span>,
    },
    { key: 'opened_at', label: 'Opened', sortable: true, render: r => <span className="text-xs text-slate-400">{formatDate(r.opened_at)}</span> },
    { key: 'closed_at', label: 'Closed', render: r => <span className="text-xs text-slate-400">{r.closed_at ? formatDate(r.closed_at) : '—'}</span> },
    {
      key: 'actions',
      label: '',
      className: 'text-right',
      render: r => (
        <div className="flex items-center justify-end gap-1">
          <button
            type="button"
            title="Open trade pipeline"
            onClick={e => { e.stopPropagation(); setPipelineTrade(r); }}
            className="p-1.5 rounded-lg text-slate-400 hover:text-primary-600 dark:hover:text-primary-400 hover:bg-primary-50 dark:hover:bg-primary-900/30 transition-colors"
          >
            <Activity className="w-4 h-4" />
          </button>
          <button
            type="button"
            title="Toggle trade details"
            onClick={e => { e.stopPropagation(); setExpandedId(prev => prev === r.id ? null : r.id); }}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
          >
            {expandedId === r.id ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="flex flex-col sm:flex-row items-start justify-between gap-3">
        <div className="page-header mb-0">
          <h1 className="page-title">{title}</h1>
          <p className="page-subtitle">{subtitle ?? `${total.toLocaleString()} trades`}</p>
        </div>
        <ExportButton data={data.map(({ tp_levels, tp_open, ...r }) => r)} filename="trades" />
      </div>

      <div className="filter-bar rounded-xl flex-wrap">
        <Input placeholder="Search symbol..." value={symbol} onChange={e => setSymbol(e.target.value)} prefix={<Search className="w-3.5 h-3.5" />} className="w-36" />
        <Input placeholder="User ID..." value={userId} onChange={e => setUserId(e.target.value)} className="w-36" />
        {!fixedStatus && (
          <Select options={['open', 'closed', 'pending_open', 'cancelled'].map(s => ({ value: s, label: s }))} value={status} onChange={e => setStatus(e.target.value)} placeholder="All Statuses" className="w-36" />
        )}
        <Select options={[{ value: 'buy', label: 'Buy' }, { value: 'sell', label: 'Sell' }]} value={direction} onChange={e => setDirection(e.target.value)} placeholder="All Directions" className="w-36" />
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-500">From</label>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="input-base py-1.5 text-xs w-36" />
          <label className="text-xs text-slate-500">To</label>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="input-base py-1.5 text-xs w-36" />
        </div>
      </div>

      <Card>
        <DataTable
          columns={columns}
          data={data}
          loading={loading}
          rowKey={r => r.id}
          onRowClick={r => setPipelineTrade(r)}
          expandedRowKey={expandedId}
          expandedContent={r => (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div>
                <p className="text-xs font-semibold text-slate-400 mb-2">TP Levels</p>
                {Array.isArray(r.tp_levels) && r.tp_levels.length > 0 ? (
                  <div className="space-y-1">
                    {(r.tp_levels as number[]).map((tp, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs">
                        <span className={i === (r.next_tp_index ?? 0) ? 'text-primary-500 font-bold' : 'text-slate-400'}>TP{i + 1}</span>
                        <span className="font-mono text-slate-300">{tp}</span>
                        {Array.isArray(r.tp_open) && (r.tp_open as boolean[])[i] === false && (
                          <span className="text-success-500 text-[10px]">HIT</span>
                        )}
                      </div>
                    ))}
                    <p className="text-[10px] text-slate-500 mt-1">Next TP Index: {r.next_tp_index ?? 0}</p>
                  </div>
                ) : (
                  <p className="text-xs text-slate-500">Single TP: <span className="font-mono">{r.tp ?? '—'}</span></p>
                )}
              </div>

              <div>
                <p className="text-xs font-semibold text-slate-400 mb-2">Trailing Stop</p>
                {r.trail_start_pips != null ? (
                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between"><span className="text-slate-500">Start Pips</span><span className="font-mono text-slate-300">{r.trail_start_pips}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">Step Pips</span><span className="font-mono text-slate-300">{r.trail_step_pips ?? '—'}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">Distance Pips</span><span className="font-mono text-slate-300">{r.trail_distance_pips ?? '—'}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">Peak Price</span><span className="font-mono text-slate-300">{r.trail_peak_price ?? '—'}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">Last SL</span><span className="font-mono text-slate-300">{r.trail_last_sl ?? '—'}</span></div>
                  </div>
                ) : (
                  <p className="text-xs text-slate-500">Not configured</p>
                )}
              </div>

              <div>
                <p className="text-xs font-semibold text-slate-400 mb-2">Auto Breakeven</p>
                {r.auto_be_mode ? (
                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between"><span className="text-slate-500">Mode</span><span className="font-mono text-slate-300">{r.auto_be_mode}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">Type</span><span className="font-mono text-slate-300">{r.auto_be_type ?? '—'}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">Trigger</span><span className="font-mono text-slate-300">{r.auto_be_trigger_value ?? '—'}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">TP Index</span><span className="font-mono text-slate-300">{r.auto_be_tp_index ?? '—'}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">Offset Pips</span><span className="font-mono text-slate-300">{r.auto_be_offset_pips ?? '—'}</span></div>
                    {r.auto_be_applied_at && (
                      <div className="flex justify-between"><span className="text-slate-500">Applied</span><span className="text-success-400">{formatDate(r.auto_be_applied_at)}</span></div>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-slate-500">Not configured</p>
                )}
              </div>
            </div>
          )}
        />
        <Pagination page={page} totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))} totalCount={total} pageSize={PAGE_SIZE} onPageChange={setPage} />
      </Card>

      {pipelineTrade && (
        <TradePipelineModal
          trade={pipelineTrade}
          onClose={() => setPipelineTrade(null)}
        />
      )}
    </div>
  );
}
