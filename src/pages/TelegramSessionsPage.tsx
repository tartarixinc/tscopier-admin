import { useEffect, useState } from 'react';
import { authSupabase as adminSupabase, fetchDisplayNames } from '../lib/adminSupabase';
import { formatDate } from '../lib/formatters';
import { DataTable, Pagination } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import { UserLink } from '../components/UserLink';
import { ExportButton } from '../components/ExportButton';
import { Card } from '../components/ui/Card';
import type { Column } from '../components/DataTable';

interface SessionRow {
  id: string;
  user_id: string;
  display_name: string | null;
  phone_number: string | null;
  is_active: boolean;
  created_at: string;
}

const PAGE_SIZE = 50;

export function TelegramSessionsPage() {
  const [data, setData] = useState<SessionRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    adminSupabase
      .from('telegram_sessions')
      .select('id, user_id, phone_number, is_active, created_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1)
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

  const columns: Column<SessionRow>[] = [
    { key: 'display_name', label: 'User', render: r => <UserLink userId={r.user_id} displayName={r.display_name} /> },
    { key: 'phone_number', label: 'Phone', render: r => <span className="font-mono text-sm">{r.phone_number ?? '—'}</span> },
    { key: 'is_active', label: 'Active', render: r => <StatusBadge status={r.is_active} /> },
    { key: 'created_at', label: 'Created', render: r => <span className="text-xs text-slate-400">{formatDate(r.created_at)}</span> },
  ];

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="flex flex-col sm:flex-row items-start justify-between gap-3">
        <div className="page-header mb-0">
          <h1 className="page-title">Telegram Sessions</h1>
          <p className="page-subtitle">{total.toLocaleString()} sessions</p>
        </div>
        <ExportButton data={data} filename="telegram-sessions" />
      </div>

      <Card>
        <DataTable columns={columns} data={data} loading={loading} rowKey={r => r.id} />
        <Pagination page={page} totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))} totalCount={total} pageSize={PAGE_SIZE} onPageChange={setPage} />
      </Card>
    </div>
  );
}
