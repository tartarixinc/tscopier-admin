import { useEffect, useState } from 'react';
import { authSupabase as adminSupabase, fetchDisplayNames } from '../lib/adminSupabase';
import { formatDate, shortId } from '../lib/formatters';
import { DataTable, Pagination } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import { UserLink } from '../components/UserLink';
import { JsonViewer } from '../components/JsonViewer';
import { Select } from '../components/ui/Select';
import { Card } from '../components/ui/Card';
import { Alert } from '../components/ui/Alert';
import type { Column } from '../components/DataTable';

interface DeadLetterRow {
  id: string;
  stream_key: string | null;
  message_id: string | null;
  idempotency_key: string | null;
  signal_id: string | null;
  user_id: string | null;
  user_display_name: string | null;
  lane: string | null;
  shard_id: number | null;
  attempts: number | null;
  reason: string | null;
  payload: unknown;
  status: string | null;
  replayed_at: string | null;
  created_at: string;
}

const PAGE_SIZE = 50;

export function DeadLettersPage() {
  const [statusFilter, setStatusFilter] = useState('');
  const [data, setData] = useState<DeadLetterRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => { setPage(1); }, [statusFilter]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    (async () => {
      const from = (page - 1) * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      let q = adminSupabase
        .from('signal_queue_dead_letters')
        .select('id, stream_key, message_id, idempotency_key, signal_id, user_id, lane, shard_id, attempts, reason, payload, status, replayed_at, created_at', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, to);

      if (statusFilter) q = q.eq('status', statusFilter);

      const { data: rows, count, error } = await q;
      if (cancelled) return;
      if (error) { setLoading(false); return; }

      const userIds = [...new Set((rows ?? []).map((r) => r.user_id).filter(Boolean))];
      const displayNames = await fetchDisplayNames(userIds);

      if (cancelled) return;
      setData((rows ?? []).map((r) => ({
        ...r,
        user_display_name: displayNames[r.user_id] ?? null,
      })));
      setTotal(count ?? 0);
      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [page, statusFilter]);

  const unreplayedCount = data.filter(r => r.status !== 'replayed').length;

  const columns: Column<DeadLetterRow>[] = [
    { key: 'user_display_name', label: 'User', render: r => r.user_id ? <UserLink userId={r.user_id} displayName={r.user_display_name} /> : <span className="text-slate-400">—</span> },
    { key: 'signal_id', label: 'Signal ID', render: r => <span className="font-mono text-xs text-slate-400">{r.signal_id ? shortId(r.signal_id) : '—'}</span> },
    { key: 'lane', label: 'Lane', render: r => <span className="text-xs text-slate-500">{r.lane ?? '—'}</span> },
    { key: 'shard_id', label: 'Shard', render: r => <span className="font-mono text-xs">{r.shard_id ?? '—'}</span> },
    { key: 'attempts', label: 'Attempts', render: r => <span className="font-mono text-xs text-warning-500">{r.attempts ?? 0}</span> },
    { key: 'reason', label: 'Reason', render: r => <span className="text-xs text-error-500 max-w-xs block truncate">{r.reason ?? '—'}</span> },
    { key: 'status', label: 'Status', render: r => <StatusBadge status={r.status} dot /> },
    { key: 'created_at', label: 'Created', render: r => <span className="text-xs text-slate-400">{formatDate(r.created_at)}</span> },
  ];

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="page-header">
        <h1 className="page-title">Dead Letters</h1>
        <p className="page-subtitle">{total.toLocaleString()} dead letter entries</p>
      </div>

      {unreplayedCount > 0 && (
        <Alert variant="warning" title={`${unreplayedCount} unprocessed dead letter${unreplayedCount !== 1 ? 's' : ''}`}>
          These signal processing attempts have exhausted retries and need investigation.
        </Alert>
      )}

      <div className="filter-bar rounded-xl">
        <Select
          options={[{ value: 'pending', label: 'Pending' }, { value: 'replayed', label: 'Replayed' }]}
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          placeholder="All Statuses"
          className="w-36"
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
            <div className="space-y-4">
              <div>
                <p className="text-xs font-semibold text-slate-400 mb-1">Full Reason</p>
                <pre className="text-xs text-error-400 whitespace-pre-wrap break-all bg-slate-900 dark:bg-slate-950 p-3 rounded-lg">{r.reason ?? '—'}</pre>
              </div>
              <div>
                <p className="text-xs font-semibold text-slate-400 mb-2">Payload</p>
                <JsonViewer data={r.payload} collapsed={false} />
              </div>
              <div className="flex gap-4 text-xs text-slate-400">
                <span>Stream: <span className="font-mono text-slate-300">{r.stream_key ?? '—'}</span></span>
                <span>Message ID: <span className="font-mono text-slate-300">{r.message_id ?? '—'}</span></span>
                <span>Idempotency Key: <span className="font-mono text-slate-300">{r.idempotency_key ?? '—'}</span></span>
                {r.replayed_at && <span>Replayed: <span className="text-success-400">{formatDate(r.replayed_at)}</span></span>}
              </div>
            </div>
          )}
        />
        <Pagination page={page} totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))} totalCount={total} pageSize={PAGE_SIZE} onPageChange={setPage} />
      </Card>
    </div>
  );
}
