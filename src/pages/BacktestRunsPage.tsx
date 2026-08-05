import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { authSupabase as adminSupabase, fetchDisplayNames } from '../lib/adminSupabase';
import { formatDate } from '../lib/formatters';
import { DataTable, Pagination } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import { UserLink } from '../components/UserLink';
import { ExportButton } from '../components/ExportButton';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { Card } from '../components/ui/Card';
import { Search } from 'lucide-react';
import type { Column } from '../components/DataTable';

interface BacktestRow {
  id: string;
  user_id: string;
  user_display_name: string | null;
  name: string;
  status: string;
  progress_pct: number | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  config: unknown;
  summary: unknown;
}

const PAGE_SIZE = 50;

export function BacktestRunsPage() {
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [data, setData] = useState<BacktestRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  useEffect(() => { setPage(1); }, [statusFilter, search]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const from = (page - 1) * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    let q = adminSupabase
      .from('backtest_runs')
      .select('id, user_id, name, status, progress_pct, started_at, completed_at, created_at, config, summary', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to);

    if (statusFilter) q = q.eq('status', statusFilter);
    if (search) q = q.ilike('name', `%${search}%`);

    q.then(async ({ data: rows, count, error }) => {
      if (cancelled) return;
      if (!error) {
        const userIds = [...new Set((rows ?? []).map((r) => r.user_id).filter(Boolean))];
        const displayNames = await fetchDisplayNames(userIds);
        setData((rows ?? []).map((r) => ({ ...r, user_display_name: displayNames[r.user_id] ?? null })));
        setTotal(count ?? 0);
      }
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [page, statusFilter, search]);

  const columns: Column<BacktestRow>[] = [
    { key: 'user_display_name', label: 'User', render: r => <UserLink userId={r.user_id} displayName={r.user_display_name} /> },
    { key: 'name', label: 'Name', render: r => <span className="font-medium">{r.name}</span> },
    { key: 'status', label: 'Status', render: r => <StatusBadge status={r.status} dot /> },
    {
      key: 'progress_pct',
      label: 'Progress',
      render: r => (
        <div className="flex items-center gap-2 w-28">
          <div className="flex-1 bg-slate-200 dark:bg-slate-700 rounded-full h-1.5">
            <div
              className="bg-primary-500 h-1.5 rounded-full transition-all"
              style={{ width: `${r.progress_pct ?? 0}%` }}
            />
          </div>
          <span className="text-xs text-slate-400 w-8">{(r.progress_pct ?? 0).toFixed(0)}%</span>
        </div>
      ),
    },
    { key: 'started_at', label: 'Started', render: r => <span className="text-xs text-slate-400">{formatDate(r.started_at)}</span> },
    { key: 'completed_at', label: 'Completed', render: r => <span className="text-xs text-slate-400">{r.completed_at ? formatDate(r.completed_at) : '—'}</span> },
  ];

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="flex flex-col sm:flex-row items-start justify-between gap-3">
        <div className="page-header mb-0">
          <h1 className="page-title">Backtest Runs</h1>
          <p className="page-subtitle">{total.toLocaleString()} runs</p>
        </div>
        <ExportButton data={data.map(({ config, summary, ...r }) => r)} filename="backtest-runs" />
      </div>

      <div className="filter-bar rounded-xl">
        <Input placeholder="Search by name..." value={search} onChange={e => setSearch(e.target.value)} prefix={<Search className="w-3.5 h-3.5" />} className="w-52" />
        <Select
          options={['running', 'completed', 'failed', 'pending'].map(s => ({ value: s, label: s }))}
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
          onRowClick={r => navigate(`/backtests/${r.id}`)}
        />
        <Pagination page={page} totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))} totalCount={total} pageSize={PAGE_SIZE} onPageChange={setPage} />
      </Card>
    </div>
  );
}
