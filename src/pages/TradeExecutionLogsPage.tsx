import { useEffect, useState } from 'react';
import { authSupabase as adminSupabase, fetchDisplayNames } from '../lib/adminSupabase';
import { formatDate } from '../lib/formatters';
import { DataTable, Pagination } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import { UserLink } from '../components/UserLink';
import { JsonViewer } from '../components/JsonViewer';
import { Select } from '../components/ui/Select';
import { Card } from '../components/ui/Card';
import type { Column } from '../components/DataTable';

interface LogRow {
  id: string;
  user_id: string;
  user_display_name: string | null;
  signal_id: string | null;
  broker_account_id: string | null;
  broker_label: string | null;
  action: string;
  status: string;
  request_payload: unknown;
  response_payload: unknown;
  error_message: string | null;
  created_at: string;
}

const PAGE_SIZE = 50;

export function TradeExecutionLogsPage() {
  const [statusFilter, setStatusFilter] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [data, setData] = useState<LogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => { setPage(1); }, [statusFilter, actionFilter]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    (async () => {
      const from = (page - 1) * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      let q = adminSupabase
        .from('trade_execution_logs')
        .select('id, user_id, signal_id, broker_account_id, action, status, request_payload, response_payload, error_message, created_at', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, to);

      if (statusFilter) q = q.eq('status', statusFilter);
      if (actionFilter) q = q.eq('action', actionFilter);

      const { data: rows, count, error } = await q;
      if (cancelled) return;
      if (error) { setLoading(false); return; }

      const userIds = [...new Set((rows ?? []).map((r) => r.user_id).filter(Boolean))];
      const brokerIds = [...new Set((rows ?? []).map((r) => r.broker_account_id).filter(Boolean))];

      const [displayNames, brokerLabels] = await Promise.all([
        fetchDisplayNames(userIds),
        brokerIds.length > 0
          ? adminSupabase.from('broker_accounts').select('id, label').in('id', brokerIds)
              .then(({ data }) => {
                const m: Record<string, string> = {};
                (data ?? []).forEach((b) => { m[b.id] = b.label; });
                return m;
              })
          : Promise.resolve({} as Record<string, string>),
      ]);

      if (cancelled) return;
      setData((rows ?? []).map((r) => ({
        ...r,
        user_display_name: displayNames[r.user_id] ?? null,
        broker_label: brokerLabels[r.broker_account_id] ?? null,
      })));
      setTotal(count ?? 0);
      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [page, statusFilter, actionFilter]);

  const columns: Column<LogRow>[] = [
    { key: 'user_display_name', label: 'User', render: r => <UserLink userId={r.user_id} displayName={r.user_display_name} /> },
    { key: 'broker_label', label: 'Broker', render: r => <span className="text-xs text-slate-500">{r.broker_label ?? '—'}</span> },
    { key: 'action', label: 'Action', render: r => <span className="badge bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 text-xs">{r.action}</span> },
    { key: 'status', label: 'Status', render: r => <StatusBadge status={r.status} dot /> },
    { key: 'error_message', label: 'Error', render: r => <span className="text-xs text-error-500 max-w-xs block truncate">{r.error_message ?? '—'}</span> },
    { key: 'created_at', label: 'Created', render: r => <span className="text-xs text-slate-400">{formatDate(r.created_at)}</span> },
  ];

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="page-header">
        <h1 className="page-title">Trade Execution Logs</h1>
        <p className="page-subtitle">{total.toLocaleString()} execution attempts</p>
      </div>

      <div className="filter-bar rounded-xl">
        <Select
          options={['success', 'error', 'skipped'].map(s => ({ value: s, label: s }))}
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          placeholder="All Statuses"
          className="w-36"
        />
        <Select
          options={['open_trade', 'close_trade', 'modify_trade', 'modify_sl', 'modify_tp'].map(s => ({ value: s, label: s }))}
          value={actionFilter}
          onChange={e => setActionFilter(e.target.value)}
          placeholder="All Actions"
          className="w-40"
        />
      </div>

      <Card>
        <DataTable
          columns={columns}
          data={data}
          loading={loading}
          rowKey={r => r.id}
          onRowClick={r => setExpandedId(prev => prev === r.id ? null : r.id)}
          expandedRowKey={expandedId}
          expandedContent={r => (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <p className="text-xs font-semibold text-slate-400 mb-2">Request Payload</p>
                <JsonViewer data={r.request_payload} collapsed={false} />
              </div>
              <div>
                <p className="text-xs font-semibold text-slate-400 mb-2">Response Payload</p>
                <JsonViewer data={r.response_payload} collapsed={false} />
              </div>
              {r.error_message && (
                <div className="md:col-span-2">
                  <p className="text-xs font-semibold text-error-400 mb-1">Full Error</p>
                  <pre className="text-xs text-error-400 whitespace-pre-wrap break-all bg-slate-900 dark:bg-slate-950 p-3 rounded-lg">{r.error_message}</pre>
                </div>
              )}
            </div>
          )}
        />
        <Pagination page={page} totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))} totalCount={total} pageSize={PAGE_SIZE} onPageChange={setPage} />
      </Card>
    </div>
  );
}
