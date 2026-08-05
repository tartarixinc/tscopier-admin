import { useEffect, useState } from 'react';
import { authSupabase as adminSupabase, fetchDisplayNames } from '../lib/adminSupabase';
import { formatDate, truncate } from '../lib/formatters';
import { DataTable, Pagination } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import { UserLink } from '../components/UserLink';
import { JsonViewer } from '../components/JsonViewer';
import { ExportButton } from '../components/ExportButton';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { Card } from '../components/ui/Card';
import { Search } from 'lucide-react';
import type { Column } from '../components/DataTable';

interface SignalRow {
  id: string;
  user_id: string;
  user_display_name: string | null;
  channel_display_name: string | null;
  status: string;
  raw_message: string | null;
  parsed_data: unknown;
  is_modification: boolean;
  parent_signal_id: string | null;
  telegram_message_id: number | null;
  created_at: string;
}

const PAGE_SIZE = 50;

export function SignalsPage() {
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [data, setData] = useState<SignalRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => { setPage(1); }, [statusFilter, search, dateFrom, dateTo]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const from = (page - 1) * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    let q = adminSupabase
      .from('signals')
      .select(
        'id, user_id, channel_id, status, raw_message, parsed_data, is_modification, parent_signal_id, telegram_message_id, created_at',
        { count: 'exact' }
      )
      .order('created_at', { ascending: false })
      .range(from, to);

    if (statusFilter) q = q.eq('status', statusFilter);
    if (search) {
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (UUID_RE.test(search.trim())) {
        q = q.eq('user_id', search.trim());
      }
    }
    if (dateFrom) q = q.gte('created_at', dateFrom);
    if (dateTo) q = q.lte('created_at', dateTo + 'T23:59:59Z');

    q.then(async ({ data: rows, count, error }) => {
      if (cancelled) return;
      if (!error) {
        const userIds = [...new Set((rows ?? []).map((r) => r.user_id).filter(Boolean))];
        const channelIds = [...new Set((rows ?? []).map((r) => r.channel_id).filter(Boolean))];
        const [displayNames, channelNames] = await Promise.all([
          fetchDisplayNames(userIds),
          channelIds.length > 0
            ? adminSupabase.from('telegram_channels').select('id, display_name').in('id', channelIds)
                .then(({ data }) => {
                  const m: Record<string, string | null> = {};
                  (data ?? []).forEach((c) => { m[c.id] = c.display_name ?? null; });
                  return m;
                })
            : Promise.resolve({} as Record<string, string | null>),
        ]);
        setData((rows ?? []).map((r) => ({
          ...r,
          user_display_name: displayNames[r.user_id] ?? null,
          channel_display_name: channelNames[r.channel_id] ?? null,
        })));
        setTotal(count ?? 0);
      }
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [page, statusFilter, search, dateFrom, dateTo]);

  const columns: Column<SignalRow>[] = [
    { key: 'user_display_name', label: 'User', render: r => <UserLink userId={r.user_id} displayName={r.user_display_name} /> },
    { key: 'channel_display_name', label: 'Channel', render: r => <span className="text-xs text-slate-500">{r.channel_display_name ?? '—'}</span> },
    { key: 'status', label: 'Status', render: r => <StatusBadge status={r.status} dot /> },
    {
      key: 'raw_message',
      label: 'Message',
      render: r => (
        <span className="text-xs text-slate-500 font-mono max-w-xs block">
          {truncate(r.raw_message, 80)}
        </span>
      ),
    },
    { key: 'is_modification', label: 'Mod', render: r => r.is_modification ? <span className="badge bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">MOD</span> : null },
    { key: 'telegram_message_id', label: 'TG Msg ID', render: r => <span className="font-mono text-xs text-slate-400">{r.telegram_message_id ?? '—'}</span> },
    { key: 'created_at', label: 'Created', sortable: true, render: r => <span className="text-xs text-slate-400">{formatDate(r.created_at)}</span> },
  ];

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="flex flex-col sm:flex-row items-start justify-between gap-3">
        <div className="page-header mb-0">
          <h1 className="page-title">Signals</h1>
          <p className="page-subtitle">{total.toLocaleString()} signals</p>
        </div>
        <ExportButton data={data.map(({ parsed_data, ...r }) => r)} filename="signals" />
      </div>

      <div className="filter-bar rounded-xl flex-wrap">
        <Input placeholder="Search by user ID..." value={search} onChange={e => setSearch(e.target.value)} prefix={<Search className="w-3.5 h-3.5" />} className="w-52" />
        <Select
          options={['pending', 'parsed', 'executed', 'skipped', 'failed'].map(s => ({ value: s, label: s }))}
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          placeholder="All Statuses"
          className="w-36"
        />
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-500">From</label>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="input-base py-1.5 text-xs w-36" />
          <label className="text-xs text-slate-500">To</label>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="input-base py-1.5 text-xs w-36" />
        </div>
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
                <p className="text-xs font-semibold text-slate-400 mb-2">Full Raw Message</p>
                <pre className="text-xs text-slate-300 bg-slate-900 dark:bg-slate-950 p-3 rounded-lg overflow-x-auto whitespace-pre-wrap max-h-48">{r.raw_message ?? '—'}</pre>
              </div>
              <div>
                <p className="text-xs font-semibold text-slate-400 mb-2">Parsed Data</p>
                <JsonViewer data={r.parsed_data} collapsed={false} />
              </div>
            </div>
          )}
        />
        <Pagination page={page} totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))} totalCount={total} pageSize={PAGE_SIZE} onPageChange={setPage} />
      </Card>
    </div>
  );
}
