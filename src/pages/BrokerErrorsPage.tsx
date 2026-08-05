import { useEffect, useState } from 'react';
import { authSupabase as adminSupabase, fetchDisplayNames } from '../lib/adminSupabase';
import { formatDate } from '../lib/formatters';
import { DataTable, Pagination } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import { UserLink } from '../components/UserLink';
import { Card } from '../components/ui/Card';
import { Alert } from '../components/ui/Alert';
import type { Column } from '../components/DataTable';

interface ErrorRow {
  id: string;
  user_id: string;
  display_name: string | null;
  label: string;
  platform: string;
  broker_name: string | null;
  account_login: string | null;
  connection_error: string | null;
  fxsocket_status: string | null;
  terminal_connected: boolean | null;
  last_synced_at: string | null;
}

const PAGE_SIZE = 50;

export function BrokerErrorsPage() {
  const [data, setData] = useState<ErrorRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const from = (page - 1) * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    adminSupabase
      .from('broker_accounts')
      .select(
        'id, user_id, label, platform, broker_name, account_login, connection_error, fxsocket_status, terminal_connected, last_synced_at',
        { count: 'exact' }
      )
      .eq('connection_status', 'error')
      .order('last_synced_at', { ascending: false, nullsFirst: false })
      .range(from, to)
      .then(async ({ data: rows, count, error }) => {
        if (cancelled) return;
        if (!error) {
          const userIds = [...new Set((rows ?? []).map((r) => r.user_id).filter(Boolean))];
          const displayNames = await fetchDisplayNames(userIds);
          setData((rows ?? []).map((r) => ({ ...r, display_name: displayNames[r.user_id] ?? null })));
          setTotal(count ?? 0);
        }
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [page]);

  const columns: Column<ErrorRow>[] = [
    { key: 'display_name', label: 'User', render: r => <UserLink userId={r.user_id} displayName={r.display_name} /> },
    { key: 'label', label: 'Label', render: r => <span className="font-medium">{r.label}</span> },
    { key: 'platform', label: 'Platform' },
    { key: 'broker_name', label: 'Broker', render: r => <span className="text-xs text-slate-500">{r.broker_name ?? '—'}</span> },
    { key: 'connection_error', label: 'Error', render: r => <span className="text-xs text-error-600 dark:text-error-400 font-medium max-w-xs block truncate">{r.connection_error ?? '—'}</span> },
    { key: 'fxsocket_status', label: 'FXSocket', render: r => <StatusBadge status={r.fxsocket_status} /> },
    { key: 'terminal_connected', label: 'Terminal', render: r => <StatusBadge status={r.terminal_connected} /> },
    { key: 'last_synced_at', label: 'Last Sync', render: r => <span className="text-xs text-slate-400">{formatDate(r.last_synced_at)}</span> },
  ];

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="page-header">
        <h1 className="page-title">Broker Connection Errors</h1>
        <p className="page-subtitle">{total.toLocaleString()} accounts with errors</p>
      </div>

      {total > 0 && (
        <Alert variant="error" title={`${total} broker account${total !== 1 ? 's' : ''} have connection errors`}>
          These accounts are currently unable to receive or execute trades.
        </Alert>
      )}

      <Card>
        <DataTable
          columns={columns}
          data={data}
          loading={loading}
          rowKey={r => r.id}
          onRowClick={r => setExpandedId(prev => prev === r.id ? null : r.id)}
          expandedRowKey={expandedId}
          expandedContent={r => (
            <div>
              <p className="text-xs font-semibold text-slate-400 mb-1">Full Error Message</p>
              <pre className="text-xs text-error-400 whitespace-pre-wrap break-all bg-slate-900 dark:bg-slate-950 p-3 rounded-lg">{r.connection_error ?? '—'}</pre>
              {r.account_login && (
                <p className="text-xs text-slate-400 mt-2">Account Login: <span className="font-mono">{r.account_login}</span></p>
              )}
            </div>
          )}
        />
        <Pagination page={page} totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))} totalCount={total} pageSize={PAGE_SIZE} onPageChange={setPage} />
      </Card>
    </div>
  );
}
