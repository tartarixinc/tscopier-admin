import { useEffect, useState } from 'react';
import { authSupabase as adminSupabase } from '../../lib/adminSupabase';
import { formatDate, truncate } from '../../lib/formatters';
import { DataTable, Pagination } from '../DataTable';
import { StatusBadge } from '../StatusBadge';
import { Select } from '../ui/Select';
import { Card } from '../ui/Card';
import { SignalDetailModal } from '../SignalDetailModal';
import { DateRangeFilter } from './DateRangeFilter';
import type { Column } from '../DataTable';

interface UserSignalRow {
  id: string;
  status: string;
  skip_reason: string | null;
  raw_message: string | null;
  telegram_message_id: string | null;
  created_at: string;
  channel_display_name: string | null;
}

interface UserSignalsTabProps {
  userId: string;
}

const PAGE_SIZE = 20;

export function UserSignalsTab({ userId }: UserSignalsTabProps) {
  const [statusFilter, setStatusFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [data, setData] = useState<UserSignalRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [selectedSignalId, setSelectedSignalId] = useState<string | null>(null);

  useEffect(() => { setPage(1); }, [statusFilter, dateFrom, dateTo]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    (async () => {
      const from = (page - 1) * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      let q = adminSupabase
        .from('signals')
        .select(
          'id, channel_id, status, skip_reason, raw_message, telegram_message_id, created_at, telegram_channels(display_name)',
          { count: 'exact' }
        )
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .range(from, to);

      if (statusFilter) q = q.eq('status', statusFilter);
      if (dateFrom) q = q.gte('created_at', dateFrom);
      if (dateTo) q = q.lte('created_at', dateTo + 'T23:59:59Z');

      const { data: rows, count, error } = await q;
      if (cancelled) return;
      if (!error) {
        const channelIds = [...new Set((rows ?? []).map((r) => r.channel_id).filter((id): id is string => Boolean(id)))];
        const channelNames: Record<string, string> = {};
        if (channelIds.length > 0) {
          const { data: channelRows } = await adminSupabase
            .from('telegram_channels')
            .select('id, display_name, channel_username')
            .in('id', channelIds);
          (channelRows ?? []).forEach((channel) => {
            channelNames[channel.id] = channel.display_name ?? channel.channel_username ?? 'Unnamed channel';
          });
        }
        if (cancelled) return;
        setData((rows ?? []).map((r) => ({
          id: r.id,
          status: r.status,
          skip_reason: r.skip_reason,
          raw_message: r.raw_message,
          telegram_message_id: r.telegram_message_id,
          created_at: r.created_at,
          channel_display_name: channelNames[r.channel_id] ?? (r.telegram_channels as { display_name: string | null }[] | null)?.[0]?.display_name ?? null,
        })));
        setTotal(count ?? 0);
      }
      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [page, statusFilter, dateFrom, dateTo, userId]);

  const columns: Column<UserSignalRow>[] = [
    { key: 'status', label: 'Status', render: r => <StatusBadge status={r.status} dot /> },
    {
      key: 'skip_reason',
      label: 'Skip / Failure',
      render: r => r.skip_reason
        ? <span className="text-xs text-warning-600 dark:text-warning-400 max-w-[200px] block truncate" title={r.skip_reason}>{truncate(r.skip_reason, 60)}</span>
        : <span className="text-slate-400 text-xs">—</span>,
    },
    { key: 'channel_display_name', label: 'Channel', render: r => <span className="text-xs text-slate-500">{r.channel_display_name ?? '—'}</span> },
    { key: 'raw_message', label: 'Message', render: r => <span className="text-xs text-slate-500 font-mono max-w-xs block truncate">{truncate(r.raw_message, 80)}</span> },
    { key: 'telegram_message_id', label: 'TG Msg ID', render: r => <span className="font-mono text-xs text-slate-400">{r.telegram_message_id ?? '—'}</span> },
    { key: 'created_at', label: 'Created', render: r => <span className="text-xs text-slate-400">{formatDate(r.created_at)}</span> },
  ];

  return (
    <div className="space-y-4">
      <div className="filter-bar rounded-xl flex-wrap">
        <Select
          options={['pending', 'parsed', 'executed', 'skipped', 'failed'].map(s => ({ value: s, label: s }))}
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          placeholder="All Statuses"
          className="w-36"
        />
        <DateRangeFilter from={dateFrom} to={dateTo} onChangeFrom={setDateFrom} onChangeTo={setDateTo} />
      </div>

      <Card>
        <DataTable
          columns={columns}
          data={data}
          loading={loading}
          rowKey={r => r.id}
          onRowClick={r => setSelectedSignalId(r.id)}
        />
        <Pagination page={page} totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))} totalCount={total} pageSize={PAGE_SIZE} onPageChange={setPage} />
      </Card>

      {selectedSignalId && (
        <SignalDetailModal signalId={selectedSignalId} onClose={() => setSelectedSignalId(null)} />
      )}
    </div>
  );
}
