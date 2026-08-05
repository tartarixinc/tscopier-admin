import { useEffect, useState } from 'react';
import { authSupabase as adminSupabase } from '../../lib/adminSupabase';
import { formatRelative, truncate } from '../../lib/formatters';
import { DataTable, Pagination } from '../DataTable';
import { StatusBadge } from '../StatusBadge';
import { Select } from '../ui/Select';
import { Card } from '../ui/Card';
import { CopierLogDetailModal, type CopierLogDetailRow } from '../CopierLogDetailModal';
import { DateRangeFilter } from './DateRangeFilter';
import type { Column } from '../DataTable';

interface UserCopierLogsTabProps {
  userId: string;
}

const PAGE_SIZE = 30;

export function UserCopierLogsTab({ userId }: UserCopierLogsTabProps) {
  const [statusFilter, setStatusFilter] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [data, setData] = useState<CopierLogDetailRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [selectedLog, setSelectedLog] = useState<CopierLogDetailRow | null>(null);

  useEffect(() => { setPage(1); }, [statusFilter, actionFilter, dateFrom, dateTo]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    (async () => {
      const from = (page - 1) * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      let q = adminSupabase
        .from('trade_execution_logs')
        .select('id, broker_account_id, signal_id, action, status, error_message, request_payload, response_payload, created_at', { count: 'exact' })
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .range(from, to);

      if (statusFilter) q = q.eq('status', statusFilter);
      if (actionFilter) q = q.eq('action', actionFilter);
      if (dateFrom) q = q.gte('created_at', dateFrom);
      if (dateTo) q = q.lte('created_at', dateTo + 'T23:59:59Z');

      const { data: rows, count, error } = await q;
      if (cancelled) return;
      if (error) { setLoading(false); return; }

      const brokerIds = [...new Set((rows ?? []).map((r) => r.broker_account_id).filter(Boolean))];
      const brokerLabels: Record<string, string> = {};
      if (brokerIds.length > 0) {
        const { data: brokerRows } = await adminSupabase.from('broker_accounts').select('id, label').in('id', brokerIds);
        (brokerRows ?? []).forEach((b) => { brokerLabels[b.id] = b.label; });
      }

      if (cancelled) return;
      setData((rows ?? []).map((r) => ({
        ...r,
        broker_label: brokerLabels[r.broker_account_id] ?? null,
      })));
      setTotal(count ?? 0);
      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [page, statusFilter, actionFilter, dateFrom, dateTo, userId]);

  const columns: Column<CopierLogDetailRow>[] = [
    { key: 'created_at', label: 'Time', render: r => <span className="text-xs text-slate-400 whitespace-nowrap">{formatRelative(r.created_at)}</span> },
    { key: 'action', label: 'Action', render: r => <span className="badge bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 text-xs">{r.action}</span> },
    { key: 'status', label: 'Status', render: r => <StatusBadge status={r.status} dot /> },
    {
      key: 'outcome',
      label: 'What happened',
      render: r => {
        const skip = (r.request_payload as { skip_reason?: string } | null)?.skip_reason ?? null;
        const text = skip || r.error_message || null;
        return text
          ? <span className="text-xs text-slate-500 max-w-[240px] block truncate" title={text}>{truncate(text, 80)}</span>
          : <span className="text-xs text-success-600 dark:text-success-400">Accepted</span>;
      },
    },
    { key: 'signal_id', label: 'Signal', render: r => <span className="text-xs text-slate-400 font-mono">{r.signal_id ? truncate(r.signal_id, 8) : '—'}</span> },
  ];

  return (
    <div className="space-y-4">
      <div className="filter-bar rounded-xl flex-wrap">
        <Select
          options={['success', 'failed', 'skipped'].map(s => ({ value: s, label: s }))}
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          placeholder="All Statuses"
          className="w-36"
        />
        <Select
          options={['order_send', 'dispatch_push_attempt', 'dispatch_skipped', 'mgmt_close', 'mgmt_breakeven', 'mgmt_skip', 'mgmt_range_leg_followup', 'basket_leg_modify', 'merge_anchor_selected', 'merge_modify_summary', 'merge_routed_modify_only', 'parse_shadow_diff', 'pipeline_summary', 'range_basket_tp_rebalance', 'range_broker_pending_inserted', 'v2_reconcile_tick', 'virtual_pending_cancelled', 'virtual_pending_fired', 'virtual_pending_inserted'].map(s => ({ value: s, label: s }))}
          value={actionFilter}
          onChange={e => setActionFilter(e.target.value)}
          placeholder="All Actions"
          className="w-44"
        />
        <DateRangeFilter from={dateFrom} to={dateTo} onChangeFrom={setDateFrom} onChangeTo={setDateTo} />
      </div>

      <Card>
        <DataTable
          columns={columns}
          data={data}
          loading={loading}
          rowKey={r => r.id}
          onRowClick={r => setSelectedLog(r)}
        />
        <Pagination page={page} totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))} totalCount={total} pageSize={PAGE_SIZE} onPageChange={setPage} />
      </Card>

      {selectedLog && (
        <CopierLogDetailModal log={selectedLog} onClose={() => setSelectedLog(null)} />
      )}
    </div>
  );
}