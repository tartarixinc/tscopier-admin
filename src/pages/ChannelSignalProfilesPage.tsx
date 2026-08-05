import { useEffect, useState } from 'react';
import { authSupabase as adminSupabase, fetchDisplayNames } from '../lib/adminSupabase';
import { formatDate, formatPips } from '../lib/formatters';
import { DataTable, Pagination } from '../components/DataTable';
import { UserLink } from '../components/UserLink';
import { ExportButton } from '../components/ExportButton';
import { Card } from '../components/ui/Card';
import type { Column } from '../components/DataTable';

interface ProfileRow {
  id: string;
  user_id: string;
  user_display_name: string | null;
  channel_display_name: string | null;
  signal_type: string | null;
  tp_style: string | null;
  sl_style: string | null;
  entry_type: string | null;
  most_traded_asset: string | null;
  estimated_tp_pips: number | null;
  estimated_sl_pips: number | null;
  sample_size: number | null;
  analyzed_at: string | null;
}

const PAGE_SIZE = 50;

export function ChannelSignalProfilesPage() {
  const [data, setData] = useState<ProfileRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    adminSupabase
      .from('channel_signal_profiles')
      .select(
        'id, user_id, channel_id, signal_type, tp_style, sl_style, entry_type, most_traded_asset, estimated_tp_pips, estimated_sl_pips, sample_size, analyzed_at',
        { count: 'exact' }
      )
      .order('analyzed_at', { ascending: false, nullsFirst: false })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1)
      .then(async ({ data: rows, count, error }) => {
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
  }, [page]);

  const columns: Column<ProfileRow>[] = [
    { key: 'user_display_name', label: 'User', render: r => <UserLink userId={r.user_id} displayName={r.user_display_name} /> },
    { key: 'channel_display_name', label: 'Channel', render: r => <span className="font-medium">{r.channel_display_name ?? '—'}</span> },
    { key: 'signal_type', label: 'Signal Type', render: r => <span className="text-xs text-slate-500">{r.signal_type ?? '—'}</span> },
    { key: 'tp_style', label: 'TP Style', render: r => <span className="text-xs">{r.tp_style ?? '—'}</span> },
    { key: 'sl_style', label: 'SL Style', render: r => <span className="text-xs">{r.sl_style ?? '—'}</span> },
    { key: 'entry_type', label: 'Entry Type', render: r => <span className="text-xs">{r.entry_type ?? '—'}</span> },
    { key: 'most_traded_asset', label: 'Top Asset', render: r => <span className="font-medium text-xs">{r.most_traded_asset ?? '—'}</span> },
    { key: 'estimated_tp_pips', label: 'Est. TP', render: r => formatPips(r.estimated_tp_pips) },
    { key: 'estimated_sl_pips', label: 'Est. SL', render: r => formatPips(r.estimated_sl_pips) },
    { key: 'sample_size', label: 'Samples', render: r => r.sample_size ?? '—' },
    { key: 'analyzed_at', label: 'Analyzed', render: r => <span className="text-xs text-slate-400">{formatDate(r.analyzed_at)}</span> },
  ];

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="flex flex-col sm:flex-row items-start justify-between gap-3">
        <div className="page-header mb-0">
          <h1 className="page-title">Channel Signal Profiles</h1>
          <p className="page-subtitle">{total.toLocaleString()} profiles</p>
        </div>
        <ExportButton data={data} filename="channel-signal-profiles" />
      </div>
      <Card>
        <DataTable columns={columns} data={data} loading={loading} rowKey={r => r.id} />
        <Pagination page={page} totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))} totalCount={total} pageSize={PAGE_SIZE} onPageChange={setPage} />
      </Card>
    </div>
  );
}
