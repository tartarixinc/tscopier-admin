import { useEffect, useState } from 'react';
import { authSupabase as adminSupabase, fetchDisplayNames } from '../lib/adminSupabase';
import { formatDate } from '../lib/formatters';
import { DataTable } from '../components/DataTable';
import { UserLink } from '../components/UserLink';
import { Card } from '../components/ui/Card';
import { Alert } from '../components/ui/Alert';
import type { Column } from '../components/DataTable';

interface LeaseRow {
  user_id: string;
  display_name: string | null;
  worker_id: string;
  role: string | null;
  shard_id: number | null;
  shard_count: number | null;
  expires_at: string | null;
  updated_at: string | null;
}

export function WorkerLeasesPage() {
  const [data, setData] = useState<LeaseRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data: rows } = await adminSupabase
        .from('worker_session_leases')
        .select('user_id, worker_id, role, shard_id, shard_count, expires_at, updated_at')
        .order('expires_at', { ascending: false });

      const userIds = [...new Set((rows ?? []).map((r) => r.user_id).filter(Boolean))];
      const displayNames = await fetchDisplayNames(userIds);

      setData((rows ?? []).map((r) => ({ ...r, display_name: displayNames[r.user_id] ?? null })));
      setLoading(false);
    })();
  }, []);

  function isExpired(dateStr: string | null) {
    if (!dateStr) return true;
    return new Date(dateStr) < new Date();
  }

  const activeCount = data.filter(r => !isExpired(r.expires_at)).length;
  const expiredCount = data.filter(r => isExpired(r.expires_at)).length;

  const columns: Column<LeaseRow>[] = [
    { key: 'display_name', label: 'User', render: r => <UserLink userId={r.user_id} displayName={r.display_name} /> },
    { key: 'worker_id', label: 'Worker ID', render: r => <span className="font-mono text-xs text-slate-400">{r.worker_id}</span> },
    { key: 'role', label: 'Role', render: r => <span className="badge bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 text-xs">{r.role ?? '—'}</span> },
    { key: 'shard_id', label: 'Shard', render: r => <span className="font-mono text-xs">{r.shard_id ?? '—'} / {r.shard_count ?? '—'}</span> },
    {
      key: 'expires_at',
      label: 'Expires',
      render: r => (
        <span className={isExpired(r.expires_at) ? 'text-error-500 dark:text-error-400 text-xs font-medium' : 'text-success-600 dark:text-success-400 text-xs font-medium'}>
          {r.expires_at ? formatDate(r.expires_at) : '—'}
          {isExpired(r.expires_at) && ' (expired)'}
        </span>
      ),
    },
    { key: 'updated_at', label: 'Last Heartbeat', render: r => <span className="text-xs text-slate-400">{formatDate(r.updated_at)}</span> },
  ];

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="page-header">
        <h1 className="page-title">Worker Session Leases</h1>
        <p className="page-subtitle">{data.length} leases — {activeCount} active, {expiredCount} expired</p>
      </div>

      {expiredCount > 0 && (
        <Alert variant="warning" title={`${expiredCount} expired lease${expiredCount !== 1 ? 's' : ''}`}>
          These workers have not renewed their lease and may be offline.
        </Alert>
      )}

      {activeCount === 0 && !loading && data.length > 0 && (
        <Alert variant="error" title="No active workers">
          All listener workers have expired leases. Signal processing may be stalled.
        </Alert>
      )}

      <Card>
        <DataTable columns={columns} data={data} loading={loading} rowKey={r => `${r.user_id}-${r.worker_id}`} />
      </Card>
    </div>
  );
}
