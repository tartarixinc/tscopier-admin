import { useEffect, useState } from 'react';
import { authSupabase as adminSupabase, fetchDisplayNames } from '../lib/adminSupabase';
import { formatDate } from '../lib/formatters';
import { DataTable } from '../components/DataTable';
import { UserLink } from '../components/UserLink';
import { Card } from '../components/ui/Card';
import { Alert } from '../components/ui/Alert';
import type { Column } from '../components/DataTable';

interface AuthPendingRow {
  user_id: string;
  phone: string | null;
  expires_at: string | null;
  awaiting_password: boolean;
  display_name: string | null;
}

export function TelegramAuthPendingPage() {
  const [data, setData] = useState<AuthPendingRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminSupabase
      .from('telegram_auth_pending')
      .select('user_id, phone, expires_at, awaiting_password')
      .then(async ({ data: rows, error }) => {
        if (!error) {
          const userIds = [...new Set((rows ?? []).map((r) => r.user_id).filter(Boolean))];
          const displayNames = await fetchDisplayNames(userIds);
          setData((rows ?? []).map((r) => ({ ...r, display_name: displayNames[r.user_id] ?? null })));
        }
        setLoading(false);
      });
  }, []);

  function isExpired(expires_at: string | null) {
    if (!expires_at) return true;
    return new Date(expires_at) < new Date();
  }

  const columns: Column<AuthPendingRow>[] = [
    { key: 'display_name', label: 'User', render: r => <UserLink userId={r.user_id} displayName={r.display_name} /> },
    { key: 'phone', label: 'Phone', render: r => <span className="font-mono text-sm">{r.phone ?? '—'}</span> },
    {
      key: 'awaiting_password',
      label: 'Awaiting Password',
      render: r => r.awaiting_password
        ? <span className="badge bg-warning-100 text-warning-800 dark:bg-warning-900/40 dark:text-warning-300">Yes</span>
        : <span className="text-slate-400 text-xs">No</span>,
    },
    {
      key: 'expires_at',
      label: 'Expires',
      render: r => (
        <span className={isExpired(r.expires_at) ? 'text-error-500 dark:text-error-400 text-xs font-medium' : 'text-xs text-slate-400'}>
          {r.expires_at ? formatDate(r.expires_at) : '—'}
          {isExpired(r.expires_at) && ' (expired)'}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="page-header">
        <h1 className="page-title">Telegram Auth Pending</h1>
        <p className="page-subtitle">Stuck or in-progress authentication flows</p>
      </div>

      {data.length > 0 && (
        <Alert variant="warning" title={`${data.length} pending auth flow${data.length !== 1 ? 's' : ''}`}>
          These users have started but not completed Telegram authentication.
        </Alert>
      )}

      <Card>
        <DataTable columns={columns} data={data} loading={loading} rowKey={r => r.user_id} emptyMessage="No pending auth flows" />
      </Card>
    </div>
  );
}
