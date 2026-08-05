import { useEffect, useState } from 'react';
import { authSupabase as adminSupabase, fetchDisplayNames } from '../lib/adminSupabase';
import { formatDate, formatCurrency } from '../lib/formatters';
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

interface BrokerRow {
  id: string;
  user_id: string;
  display_name: string | null;
  label: string;
  platform: string;
  broker_name: string | null;
  broker_server: string | null;
  account_login: string | null;
  connection_status: string | null;
  is_active: boolean;
  copier_mode: string;
  last_balance: number | null;
  last_equity: number | null;
  last_synced_at: string | null;
  fxsocket_account_id: string | null;
  fxsocket_status: string | null;
  terminal_connected: boolean | null;
  trade_allowed: boolean | null;
  connection_error: string | null;
  ai_settings: unknown;
  manual_settings: unknown;
  channel_trading_configs: unknown;
}

const PAGE_SIZE = 50;

export function BrokerAccountsPage() {
  const [platform, setPlatform] = useState('');
  const [status, setStatus] = useState('');
  const [activeOnly, setActiveOnly] = useState('');
  const [search, setSearch] = useState('');
  const [data, setData] = useState<BrokerRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => { setPage(1); }, [platform, status, activeOnly, search]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const from = (page - 1) * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    let q = adminSupabase
      .from('broker_accounts')
      .select(
        'id, user_id, label, platform, broker_name, broker_server, account_login, connection_status, is_active, copier_mode, last_balance, last_equity, last_synced_at, fxsocket_account_id, fxsocket_status, terminal_connected, trade_allowed, connection_error, ai_settings, manual_settings, channel_trading_configs',
        { count: 'exact' }
      )
      .order('last_synced_at', { ascending: false, nullsFirst: false })
      .range(from, to);

    if (platform) q = q.eq('platform', platform);
    if (status) q = q.eq('connection_status', status);
    if (activeOnly === 'true') q = q.eq('is_active', true);
    if (activeOnly === 'false') q = q.eq('is_active', false);
    if (search) q = q.ilike('label', `%${search}%`);

    q.then(async ({ data: rows, count, error }) => {
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
  }, [page, platform, status, activeOnly, search]);

  const columns: Column<BrokerRow>[] = [
    { key: 'display_name', label: 'User', render: r => <UserLink userId={r.user_id} displayName={r.display_name} /> },
    { key: 'label', label: 'Label', render: r => <span className="font-medium">{r.label}</span> },
    { key: 'platform', label: 'Platform', render: r => <span className="badge bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300">{r.platform}</span> },
    { key: 'broker_name', label: 'Broker', render: r => <span className="text-xs text-slate-500">{r.broker_name ?? '—'}</span> },
    { key: 'account_login', label: 'Login', render: r => <span className="font-mono text-xs text-slate-500">{r.account_login ?? '—'}</span> },
    { key: 'connection_status', label: 'Connection', render: r => <StatusBadge status={r.connection_status} dot /> },
    { key: 'fxsocket_status', label: 'FXSocket', render: r => <StatusBadge status={r.fxsocket_status} /> },
    { key: 'terminal_connected', label: 'Terminal', render: r => <StatusBadge status={r.terminal_connected} /> },
    { key: 'trade_allowed', label: 'Trade', render: r => <StatusBadge status={r.trade_allowed} /> },
    { key: 'is_active', label: 'Active', render: r => <StatusBadge status={r.is_active} /> },
    { key: 'copier_mode', label: 'Mode', render: r => <span className="text-xs text-slate-500">{r.copier_mode}</span> },
    { key: 'last_balance', label: 'Balance', sortable: true, render: r => formatCurrency(r.last_balance) },
    { key: 'last_equity', label: 'Equity', render: r => formatCurrency(r.last_equity) },
    { key: 'last_synced_at', label: 'Last Sync', sortable: true, render: r => <span className="text-xs text-slate-400">{formatDate(r.last_synced_at)}</span> },
  ];

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="flex flex-col sm:flex-row items-start justify-between gap-3">
        <div className="page-header mb-0">
          <h1 className="page-title">Broker Accounts</h1>
          <p className="page-subtitle">{total.toLocaleString()} accounts</p>
        </div>
        <ExportButton data={data.map(({ ai_settings, manual_settings, channel_trading_configs, ...r }) => r)} filename="broker-accounts" />
      </div>

      <div className="filter-bar rounded-xl">
        <Input placeholder="Search label..." value={search} onChange={e => setSearch(e.target.value)} prefix={<Search className="w-3.5 h-3.5" />} className="w-48" />
        <Select options={[{ value: 'MT4', label: 'MT4' }, { value: 'MT5', label: 'MT5' }]} value={platform} onChange={e => setPlatform(e.target.value)} placeholder="All Platforms" className="w-36" />
        <Select options={[{ value: 'connected', label: 'Connected' }, { value: 'error', label: 'Error' }, { value: 'pending', label: 'Pending' }]} value={status} onChange={e => setStatus(e.target.value)} placeholder="All Statuses" className="w-36" />
        <Select options={[{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }]} value={activeOnly} onChange={e => setActiveOnly(e.target.value)} placeholder="Active/Inactive" className="w-36" />
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
            <div className="space-y-4">
              {r.connection_error && (
                <div>
                  <p className="text-xs font-semibold text-error-400 mb-1">Connection Error</p>
                  <pre className="text-xs text-error-400 whitespace-pre-wrap break-all bg-slate-900 dark:bg-slate-950 p-3 rounded-lg">{r.connection_error}</pre>
                </div>
              )}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <p className="text-xs font-semibold text-slate-400 mb-1">AI Settings</p>
                  <JsonViewer data={r.ai_settings} collapsed={false} />
                </div>
                <div>
                  <p className="text-xs font-semibold text-slate-400 mb-1">Manual Settings</p>
                  <JsonViewer data={r.manual_settings} collapsed={false} />
                </div>
                <div>
                  <p className="text-xs font-semibold text-slate-400 mb-1">Channel Trading Configs</p>
                  <JsonViewer data={r.channel_trading_configs} collapsed={false} />
                </div>
              </div>
              <div className="flex gap-4 text-xs text-slate-400">
                <span>Server: <span className="text-slate-300 font-mono">{r.broker_server ?? '—'}</span></span>
                <span>FXSocket ID: <span className="text-slate-300 font-mono">{r.fxsocket_account_id ?? '—'}</span></span>
              </div>
            </div>
          )}
        />
        <Pagination page={page} totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))} totalCount={total} pageSize={PAGE_SIZE} onPageChange={setPage} />
      </Card>
    </div>
  );
}
