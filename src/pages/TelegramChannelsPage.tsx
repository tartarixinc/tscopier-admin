import { useEffect, useState } from 'react';
import { authSupabase as adminSupabase, fetchDisplayNames } from '../lib/adminSupabase';
import { formatRelative } from '../lib/formatters';
import { DataTable, Pagination } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import { UserLink } from '../components/UserLink';
import { JsonViewer } from '../components/JsonViewer';
import { ExportButton } from '../components/ExportButton';
import { Input } from '../components/ui/Input';
import { Card } from '../components/ui/Card';
import { Search } from 'lucide-react';
import clsx from 'clsx';
import type { Column } from '../components/DataTable';

interface ChannelRow {
  id: string;
  user_id: string;
  display_name: string | null;
  user_display_name: string | null;
  channel_username: string | null;
  is_active: boolean;
  lot_size_override: number | null;
  pip_tolerance_override: number | null;
  channel_keywords: unknown;
  last_seen_at: string | null;
  last_live_at: string | null;
  created_at: string;
}

const PAGE_SIZE = 50;

function isStale(dateStr: string | null): boolean {
  if (!dateStr) return true;
  return Date.now() - new Date(dateStr).getTime() > 7 * 24 * 60 * 60 * 1000;
}

export function TelegramChannelsPage() {
  const [search, setSearch] = useState('');
  const [data, setData] = useState<ChannelRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => { setPage(1); }, [search]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    let q = adminSupabase
      .from('telegram_channels')
      .select(
        'id, user_id, display_name, channel_username, is_active, lot_size_override, pip_tolerance_override, channel_keywords, last_seen_at, last_live_at, created_at',
        { count: 'exact' }
      )
      .order('last_live_at', { ascending: false, nullsFirst: false })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

    if (search) q = q.or(`display_name.ilike.%${search}%,channel_username.ilike.%${search}%`);

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
  }, [page, search]);

  const columns: Column<ChannelRow>[] = [
    { key: 'user_display_name', label: 'User', render: r => <UserLink userId={r.user_id} displayName={r.user_display_name} /> },
    { key: 'display_name', label: 'Channel Name', render: r => <span className="font-medium">{r.display_name ?? '—'}</span> },
    { key: 'channel_username', label: 'Username', render: r => <span className="text-xs text-slate-500">@{r.channel_username ?? '—'}</span> },
    { key: 'is_active', label: 'Active', render: r => <StatusBadge status={r.is_active} /> },
    {
      key: 'last_live_at',
      label: 'Last Live',
      sortable: true,
      render: r => (
        <span className={clsx('text-xs', isStale(r.last_live_at) ? 'text-error-500 dark:text-error-400 font-medium' : 'text-slate-400')}>
          {r.last_live_at ? formatRelative(r.last_live_at) : 'Never'}
        </span>
      ),
    },
    { key: 'last_seen_at', label: 'Last Seen', render: r => <span className="text-xs text-slate-400">{formatRelative(r.last_seen_at)}</span> },
    { key: 'lot_size_override', label: 'Lot Override', render: r => r.lot_size_override != null ? <span className="font-mono text-xs">{r.lot_size_override}</span> : <span className="text-slate-400">—</span> },
    { key: 'pip_tolerance_override', label: 'Pip Override', render: r => r.pip_tolerance_override != null ? <span className="font-mono text-xs">{r.pip_tolerance_override}</span> : <span className="text-slate-400">—</span> },
  ];

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="flex flex-col sm:flex-row items-start justify-between gap-3">
        <div className="page-header mb-0">
          <h1 className="page-title">Telegram Channels</h1>
          <p className="page-subtitle">{total.toLocaleString()} channels — sorted by last live activity</p>
        </div>
        <ExportButton data={data} filename="telegram-channels" />
      </div>

      <div className="filter-bar rounded-xl">
        <Input placeholder="Search channel name or username..." value={search} onChange={e => setSearch(e.target.value)} prefix={<Search className="w-3.5 h-3.5" />} className="w-72" />
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
            <div>
              <p className="text-xs font-semibold text-slate-400 mb-2">Channel Keywords</p>
              {r.channel_keywords ? (
                <JsonViewer data={r.channel_keywords} collapsed={false} />
              ) : (
                <p className="text-xs text-slate-400">No keywords configured</p>
              )}
            </div>
          )}
        />
        <Pagination page={page} totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))} totalCount={total} pageSize={PAGE_SIZE} onPageChange={setPage} />
      </Card>
    </div>
  );
}
