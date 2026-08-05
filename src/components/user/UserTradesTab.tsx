import { useEffect, useState } from 'react';
import { authSupabase as adminSupabase } from '../../lib/adminSupabase';
import { formatDate, formatCurrency, formatLots } from '../../lib/formatters';
import { DataTable, Pagination } from '../DataTable';
import { StatusBadge } from '../StatusBadge';
import { Select } from '../ui/Select';
import { Card } from '../ui/Card';
import { TradePipelineModal } from '../TradePipelineModal';
import { DateRangeFilter } from './DateRangeFilter';
import type { Column } from '../DataTable';
import { classifyTradeExecutionType, type TradeExecutionEvidenceLog, type TradeExecutionType } from '../../lib/tradeExecutionType';

interface UserTradeRow {
  id: string;
  broker_account_id: string | null;
  metaapi_order_id: string | null;
  broker_label: string | null;
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
  channel_display_name: string | null;
  execution_type: TradeExecutionType;
}

interface UserTradesTabProps {
  userId: string;
}

const PAGE_SIZE = 20;

export function UserTradesTab({ userId }: UserTradesTabProps) {
  const [statusFilter, setStatusFilter] = useState('');
  const [directionFilter, setDirectionFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [data, setData] = useState<UserTradeRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [selectedTrade, setSelectedTrade] = useState<UserTradeRow | null>(null);

  useEffect(() => { setPage(1); }, [statusFilter, directionFilter, dateFrom, dateTo]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    (async () => {
      const from = (page - 1) * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      let q = adminSupabase
        .from('trades')
        .select('id, broker_account_id, metaapi_order_id, signal_id, telegram_channel_id, symbol, direction, entry_price, sl, tp, lot_size, status, profit, opened_at, closed_at', { count: 'exact' })
        .eq('user_id', userId)
        .order('opened_at', { ascending: false, nullsFirst: false })
        .range(from, to);

      if (statusFilter) q = q.eq('status', statusFilter);
      if (directionFilter) q = q.eq('direction', directionFilter);
      if (dateFrom) q = q.gte('opened_at', dateFrom);
      if (dateTo) q = q.lte('opened_at', dateTo + 'T23:59:59Z');

      const { data: rows, count, error } = await q;
      if (cancelled) return;
      if (error) { setLoading(false); return; }

      const brokerIds = [...new Set((rows ?? []).map((r) => r.broker_account_id).filter(Boolean))];
      const channelIds = [...new Set((rows ?? []).map((r) => r.telegram_channel_id).filter((id): id is string => Boolean(id)))];
      const signalIds = [...new Set((rows ?? []).map((r) => r.signal_id).filter((id): id is string => Boolean(id)))];
      const brokerLabels: Record<string, string> = {};
      const channelNames: Record<string, string> = {};
      const executionLogs: TradeExecutionEvidenceLog[] = [];
      const [brokerRows, channelRows, logRows] = await Promise.all([
        brokerIds.length > 0 ? adminSupabase.from('broker_accounts').select('id, label').in('id', brokerIds) : Promise.resolve({ data: [] }),
        channelIds.length > 0 ? adminSupabase.from('telegram_channels').select('id, display_name, channel_username').in('id', channelIds) : Promise.resolve({ data: [] }),
        signalIds.length > 0 ? adminSupabase.from('trade_execution_logs').select('signal_id, action, status, request_payload, response_payload').in('signal_id', signalIds).order('created_at', { ascending: false }).limit(1000) : Promise.resolve({ data: [] }),
      ]);
      (brokerRows.data ?? []).forEach((b) => { brokerLabels[b.id] = b.label; });
      (channelRows.data ?? []).forEach((channel) => { channelNames[channel.id] = channel.display_name ?? channel.channel_username ?? 'Unnamed channel'; });
      executionLogs.push(...((logRows.data ?? []) as TradeExecutionEvidenceLog[]));
      const rowsBySignalBroker = new Map<string, number>();
      (rows ?? []).forEach((r) => {
        const key = `${r.signal_id ?? 'none'}:${r.broker_account_id ?? 'none'}`;
        rowsBySignalBroker.set(key, (rowsBySignalBroker.get(key) ?? 0) + 1);
      });

      if (cancelled) return;
      setData((rows ?? []).map((r) => {
        const key = `${r.signal_id ?? 'none'}:${r.broker_account_id ?? 'none'}`;
        const logs = executionLogs.filter(log => (log as TradeExecutionEvidenceLog & { signal_id?: string }).signal_id === r.signal_id);
        const linkedTradeCount = rowsBySignalBroker.get(key) ?? 1;
        const execution_type = classifyTradeExecutionType({ logs, ticket: r.metaapi_order_id, linkedTradeCount });
        return {
        ...r,
        broker_label: brokerLabels[r.broker_account_id] ?? null,
        channel_display_name: channelNames[r.telegram_channel_id] ?? null,
        execution_type,
      };
      }));
      setTotal(count ?? 0);
      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [page, statusFilter, directionFilter, dateFrom, dateTo, userId]);

  const columns: Column<UserTradeRow>[] = [
    { key: 'symbol', label: 'Symbol', render: r => <span className="font-bold text-sm">{r.symbol}</span> },
    { key: 'direction', label: 'Dir', render: r => <StatusBadge status={r.direction} /> },
    { key: 'execution_type', label: 'Type', render: r => <span className="rounded-full bg-primary-50 dark:bg-primary-900/30 px-2 py-0.5 text-[10px] font-semibold text-primary-700 dark:text-primary-300 whitespace-nowrap">{r.execution_type}</span> },
    { key: 'channel_display_name', label: 'Channel', render: r => <span className="text-xs text-slate-500 max-w-[150px] block truncate" title={r.channel_display_name ?? undefined}>{r.channel_display_name ?? '—'}</span> },
    { key: 'entry_price', label: 'Entry', render: r => <span className="font-mono text-xs">{r.entry_price ?? '—'}</span> },
    { key: 'lot_size', label: 'Lots', render: r => formatLots(r.lot_size) },
    { key: 'status', label: 'Status', render: r => <StatusBadge status={r.status} dot /> },
    {
      key: 'profit',
      label: 'P&L',
      render: r => r.profit != null
        ? <span className={r.profit >= 0 ? 'text-success-600 dark:text-success-400 font-medium' : 'text-error-600 dark:text-error-400 font-medium'}>{formatCurrency(r.profit)}</span>
        : <span className="text-slate-400">—</span>,
    },
    { key: 'opened_at', label: 'Opened', render: r => <span className="text-xs text-slate-400">{formatDate(r.opened_at)}</span> },
    { key: 'closed_at', label: 'Closed', render: r => <span className="text-xs text-slate-400">{r.closed_at ? formatDate(r.closed_at) : '—'}</span> },
  ];

  return (
    <div className="space-y-4">
      <div className="filter-bar rounded-xl flex-wrap">
        <Select
          options={['open', 'closed', 'pending_open', 'cancelled'].map(s => ({ value: s, label: s }))}
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          placeholder="All Statuses"
          className="w-36"
        />
        <Select
          options={[{ value: 'buy', label: 'Buy' }, { value: 'sell', label: 'Sell' }]}
          value={directionFilter}
          onChange={e => setDirectionFilter(e.target.value)}
          placeholder="All Directions"
          className="w-36"
        />
        <DateRangeFilter from={dateFrom} to={dateTo} onChangeFrom={setDateFrom} onChangeTo={setDateTo} />
      </div>

      <Card>
        <DataTable
          columns={columns}
          data={data}
          loading={loading}
          rowKey={r => r.id}
          onRowClick={r => setSelectedTrade(r)}
        />
        <Pagination page={page} totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))} totalCount={total} pageSize={PAGE_SIZE} onPageChange={setPage} />
      </Card>

      {selectedTrade && (
        <TradePipelineModal
          trade={selectedTrade}
          onClose={() => setSelectedTrade(null)}
        />
      )}
    </div>
  );
}
