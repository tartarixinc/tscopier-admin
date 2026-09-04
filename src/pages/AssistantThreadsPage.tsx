import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { authSupabase as adminSupabase } from '../lib/adminSupabase';
import { formatDate } from '../lib/formatters';
import { DataTable, Pagination } from '../components/DataTable';
import { UserLink } from '../components/UserLink';
import { Input } from '../components/ui/Input';
import { Card } from '../components/ui/Card';
import { Search, X, AlertTriangle } from 'lucide-react';
import type { Column } from '../components/DataTable';

interface ThreadRow {
  id: string;
  user_id: string;
  title: string;
  message_count: number;
  created_at: string;
  updated_at: string;
}

const PAGE_SIZE = 50;

export function AssistantThreadsPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<ThreadRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => { setPage(1); }, [debouncedSearch]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      const from = (page - 1) * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      const { data: rows, count, error: qErr } = await adminSupabase
        .from('assistant_threads')
        .select('id, user_id, title, messages, created_at, updated_at', { count: 'exact' })
        .order('updated_at', { ascending: false })
        .range(from, to);

      if (cancelled) return;
      if (qErr) { setError(qErr.message); setLoading(false); return; }

      const userIds = [...new Set((rows ?? []).map(r => r.user_id).filter(Boolean))];
      const userNames: Record<string, string> = {};

      if (userIds.length > 0) {
        const { data: profiles } = await adminSupabase
          .from('user_profiles')
          .select('user_id, display_name, first_name, last_name')
          .in('user_id', userIds);
        (profiles ?? []).forEach((p) => {
          const first = (p.first_name ?? '').trim();
          const last = (p.last_name ?? '').trim();
          userNames[p.user_id] = [first, last].filter(Boolean).join(' ')
            || (p.display_name ?? '').trim()
            || 'Unnamed';
        });
      }

      if (cancelled) return;
      setData((rows ?? []).map(r => ({
        id: r.id,
        user_id: r.user_id,
        title: r.title || '(untitled)',
        message_count: Array.isArray(r.messages) ? r.messages.length : 0,
        created_at: r.created_at,
        updated_at: r.updated_at,
        _userName: userNames[r.user_id] ?? 'Unknown',
      })));
      setTotal(count ?? 0);
      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [page, debouncedSearch]);

  const filteredData = debouncedSearch.trim()
    ? data.filter(r => {
        const q = debouncedSearch.toLowerCase();
        return (r.title ?? '').toLowerCase().includes(q)
          || (r as ThreadRow & { _userName?: string })._userName?.toLowerCase().includes(q)
          || r.user_id.toLowerCase().includes(q);
      })
    : data;

  const columns: Column<ThreadRow & { _userName?: string }>[] = [
    {
      key: 'title',
      label: 'Title',
      render: r => (
        <button
          onClick={() => navigate(`/assistant-chats/${r.id}`)}
          className="text-primary-600 dark:text-primary-400 hover:text-primary-800 dark:hover:text-primary-300 font-medium text-left truncate max-w-[240px] block"
          title={r.title}
        >
          {r.title}
        </button>
      ),
    },
    {
      key: '_userName',
      label: 'User',
      render: r => <UserLink userId={r.user_id} displayName={r._userName} />,
    },
    {
      key: 'message_count',
      label: 'Messages',
      render: r => <span className="text-xs text-slate-500">{r.message_count}</span>,
    },
    { key: 'created_at', label: 'Created', render: r => <span className="text-xs text-slate-400">{formatDate(r.created_at)}</span> },
    { key: 'updated_at', label: 'Last Activity', render: r => <span className="text-xs text-slate-400">{formatDate(r.updated_at)}</span> },
  ];

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="page-header mb-0">
        <h1 className="page-title">Assistant Chats</h1>
        <p className="page-subtitle">{total.toLocaleString()} threads across all users</p>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 text-sm border border-red-200 dark:border-red-800">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="filter-bar rounded-xl">
        <div className="flex-1 min-w-[200px]">
          <Input
            placeholder="Search by title, user name, or user ID..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            prefix={<Search className="w-3.5 h-3.5" />}
            suffix={search ? (
              <button onClick={() => setSearch('')}><X className="w-3 h-3" /></button>
            ) : null}
          />
        </div>
      </div>

      <Card>
        <DataTable
          columns={columns}
          data={filteredData}
          loading={loading}
          rowKey={r => r.id}
          onRowClick={r => navigate(`/assistant-chats/${r.id}`)}
          emptyMessage={debouncedSearch ? 'No threads match your search' : 'No assistant threads yet'}
        />
        <Pagination
          page={page}
          totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))}
          totalCount={total}
          pageSize={PAGE_SIZE}
          onPageChange={setPage}
        />
      </Card>
    </div>
  );
}
