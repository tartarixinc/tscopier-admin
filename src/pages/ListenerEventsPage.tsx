import { useEffect, useState } from 'react';
import { authSupabase as adminSupabase, fetchDisplayNames } from '../lib/adminSupabase';
import { formatDate } from '../lib/formatters';
import { DataTable, Pagination } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import { UserLink } from '../components/UserLink';
import { Select } from '../components/ui/Select';
import { Card } from '../components/ui/Card';
import type { Column } from '../components/DataTable';

interface EventRow {
  id: string;
  user_id: string;
  user_display_name: string | null;
  channel_row_id: string | null;
  channel_name: string | null;
  telegram_message_id: number | null;
  event_type: string;
  detail: string | Record<string, unknown> | null;
  created_at: string;
}

const PAGE_SIZE = 50;

export function ListenerEventsPage() {
  const [eventType, setEventType] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [data, setData] = useState<EventRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  useEffect(() => { setPage(1); }, [eventType, dateFrom, dateTo]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    (async () => {
      const from = (page - 1) * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      let q = adminSupabase
        .from('listener_events')
        .select('id, user_id, channel_row_id, telegram_message_id, event_type, detail, created_at', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, to);

      if (eventType) q = q.eq('event_type', eventType);
      if (dateFrom) q = q.gte('created_at', dateFrom);
      if (dateTo) q = q.lte('created_at', dateTo + 'T23:59:59Z');

      const { data: rows, count, error } = await q;
      if (cancelled) return;
      if (error) { setLoading(false); return; }

      const userIds = [...new Set((rows ?? []).map((r) => r.user_id).filter(Boolean))];
      const channelIds = [...new Set((rows ?? []).map((r) => r.channel_row_id).filter(Boolean))];

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

      if (cancelled) return;
      setData((rows ?? []).map((r) => ({
        ...r,
        user_display_name: displayNames[r.user_id] ?? null,
        channel_name: channelNames[r.channel_row_id] ?? null,
      })));
      setTotal(count ?? 0);
      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [page, eventType, dateFrom, dateTo]);

  const columns: Column<EventRow>[] = [
    { key: 'user_display_name', label: 'User', render: r => <UserLink userId={r.user_id} displayName={r.user_display_name} /> },
    { key: 'channel_name', label: 'Channel', render: r => <span className="text-xs text-slate-500">{r.channel_name ?? '—'}</span> },
    { key: 'event_type', label: 'Event Type', render: r => <StatusBadge status={r.event_type} dot /> },
    { key: 'telegram_message_id', label: 'TG Msg ID', render: r => <span className="font-mono text-xs text-slate-400">{r.telegram_message_id ?? '—'}</span> },
    { key: 'detail', label: 'Detail', render: r => <span className="text-xs text-slate-500 max-w-xs block truncate">{r.detail == null ? '—' : typeof r.detail === 'object' ? JSON.stringify(r.detail) : r.detail}</span> },
    { key: 'created_at', label: 'Created', render: r => <span className="text-xs text-slate-400">{formatDate(r.created_at)}</span> },
  ];

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="page-header">
        <h1 className="page-title">Listener Events</h1>
        <p className="page-subtitle">{total.toLocaleString()} events — message processing activity</p>
      </div>

      <div className="filter-bar rounded-xl flex-wrap">
        <Select
          options={['new_message', 'edit_message', 'skip', 'error', 'signal_created', 'duplicate'].map(s => ({ value: s, label: s }))}
          value={eventType}
          onChange={e => setEventType(e.target.value)}
          placeholder="All Event Types"
          className="w-44"
        />
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-500">From</label>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="input-base py-1.5 text-xs w-36" />
          <label className="text-xs text-slate-500">To</label>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="input-base py-1.5 text-xs w-36" />
        </div>
      </div>

      <Card>
        <DataTable columns={columns} data={data} loading={loading} rowKey={r => r.id} />
        <Pagination page={page} totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))} totalCount={total} pageSize={PAGE_SIZE} onPageChange={setPage} />
      </Card>
    </div>
  );
}
