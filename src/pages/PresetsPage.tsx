import { useEffect, useState } from 'react';
import { authSupabase as adminSupabase, fetchDisplayNames } from '../lib/adminSupabase';
import { formatDate } from '../lib/formatters';
import { DataTable, Pagination } from '../components/DataTable';
import { UserLink } from '../components/UserLink';
import { JsonViewer } from '../components/JsonViewer';
import { ExportButton } from '../components/ExportButton';
import { Card } from '../components/ui/Card';
import type { Column } from '../components/DataTable';

interface PresetRow {
  id: string;
  user_id: string;
  user_display_name: string | null;
  name: string;
  copier_mode: string;
  manual_settings: unknown;
  channel_filters: unknown;
  created_at: string;
  updated_at: string;
}

const PAGE_SIZE = 50;

export function PresetsPage() {
  const [data, setData] = useState<PresetRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    adminSupabase
      .from('channel_trading_presets')
      .select('id, user_id, name, copier_mode, manual_settings, channel_filters, created_at, updated_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1)
      .then(async ({ data: rows, count, error }) => {
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
  }, [page]);

  const columns: Column<PresetRow>[] = [
    { key: 'user_display_name', label: 'User', render: r => <UserLink userId={r.user_id} displayName={r.user_display_name} /> },
    { key: 'name', label: 'Name', render: r => <span className="font-medium">{r.name}</span> },
    { key: 'copier_mode', label: 'Mode', render: r => <span className="badge bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 text-xs">{r.copier_mode}</span> },
    { key: 'created_at', label: 'Created', render: r => <span className="text-xs text-slate-400">{formatDate(r.created_at)}</span> },
  ];

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="flex flex-col sm:flex-row items-start justify-between gap-3">
        <div className="page-header mb-0">
          <h1 className="page-title">Trading Presets</h1>
          <p className="page-subtitle">{total.toLocaleString()} presets — click to expand settings</p>
        </div>
        <ExportButton data={data.map(({ manual_settings, channel_filters, ...r }) => r)} filename="trading-presets" />
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
                <p className="text-xs font-semibold text-slate-400 mb-2">Manual Settings</p>
                <JsonViewer data={r.manual_settings} collapsed={false} />
              </div>
              <div>
                <p className="text-xs font-semibold text-slate-400 mb-2">Channel Filters</p>
                <JsonViewer data={r.channel_filters} collapsed={false} />
              </div>
            </div>
          )}
        />
        <Pagination page={page} totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))} totalCount={total} pageSize={PAGE_SIZE} onPageChange={setPage} />
      </Card>
    </div>
  );
}
