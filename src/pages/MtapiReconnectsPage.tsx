import { useEffect, useMemo, useState } from 'react';
import { authSupabase as adminSupabase, fetchDisplayNames } from '../lib/adminSupabase';
import { formatDate, formatRelative } from '../lib/formatters';
import { DataTable, Pagination } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import { UserLink } from '../components/UserLink';
import { ExportButton } from '../components/ExportButton';
import { Badge } from '../components/ui/Badge';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Search, AlertTriangle } from 'lucide-react';
import type { Column } from '../components/DataTable';

interface AccountRow {
  id: string;
  user_id: string;
  label: string;
  platform: string;
  provider: string | null;
  mtapi_status: string | null;
  account_login: string | null;
  broker_name: string | null;
  connection_status: string | null;
  is_active: boolean;
  last_synced_at: string | null;
}

type AccountBucket = 'connected' | 'connecting' | 'error' | 'awaiting' | 'legacy';

/** Where an account sits in the FXSocket → MTAPI switch. */
function bucketOf(account: AccountRow): AccountBucket {
  if (account.provider !== 'mtapi') return 'legacy';
  const status = (account.mtapi_status ?? '').toLowerCase();
  if (!status) return 'awaiting';
  if (status === 'connected') return 'connected';
  if (status === 'connecting') return 'connecting';
  return 'error';
}

type UserStatus = 'reconnected' | 'partial' | 'none';

interface UserSummary {
  user_id: string;
  display_name: string | null;
  total: number;
  reconnected: number;
  connected: number;
  connecting: number;
  error: number;
  awaiting: number;
  legacy: number;
  active: number;
  last_synced_at: string | null;
  status: UserStatus;
  accounts: AccountRow[];
}

const ACCOUNT_SELECT =
  'id, user_id, label, platform, provider, mtapi_status, account_login, broker_name, connection_status, is_active, last_synced_at';

const PAGE_SIZE = 25;
const FETCH_PAGE_SIZE = 1000;

const STATUS_LABEL: Record<UserStatus, string> = {
  reconnected: 'Reconnected',
  partial: 'Partly reconnected',
  none: 'Not reconnected',
};

const STATUS_VARIANT: Record<UserStatus, 'success' | 'warning' | 'error'> = {
  reconnected: 'success',
  partial: 'warning',
  none: 'error',
};

const STATUS_RANK: Record<UserStatus, number> = { none: 0, partial: 1, reconnected: 2 };

function statusOf(user: Omit<UserSummary, 'status'>): UserStatus {
  if (user.reconnected === 0) return 'none';
  if (user.awaiting === 0 && user.legacy === 0 && user.reconnected === user.total) return 'reconnected';
  return 'partial';
}

function buildSummaries(accounts: AccountRow[], names: Record<string, string | null>): UserSummary[] {
  const byUser = new Map<string, AccountRow[]>();
  for (const account of accounts) {
    const list = byUser.get(account.user_id);
    if (list) list.push(account);
    else byUser.set(account.user_id, [account]);
  }

  const summaries: UserSummary[] = [];
  for (const [userId, list] of byUser) {
    let connected = 0;
    let connecting = 0;
    let error = 0;
    let awaiting = 0;
    let legacy = 0;
    let active = 0;
    let lastSyncedAt: string | null = null;

    for (const account of list) {
      const bucket = bucketOf(account);
      if (bucket === 'connected') connected += 1;
      else if (bucket === 'connecting') connecting += 1;
      else if (bucket === 'error') error += 1;
      else if (bucket === 'awaiting') awaiting += 1;
      else legacy += 1;
      if (account.is_active) active += 1;
      if (account.last_synced_at && (!lastSyncedAt || account.last_synced_at > lastSyncedAt)) {
        lastSyncedAt = account.last_synced_at;
      }
    }

    const base = {
      user_id: userId,
      display_name: names[userId] ?? null,
      total: list.length,
      reconnected: connected + connecting + error,
      connected,
      connecting,
      error,
      awaiting,
      legacy,
      active,
      last_synced_at: lastSyncedAt,
      accounts: [...list].sort((a, b) => a.label.localeCompare(b.label)),
    };
    summaries.push({ ...base, status: statusOf(base) });
  }

  return summaries;
}

function StatCard({ label, value, sub, color }: {
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="stat-card">
      <p className="stat-label">{label}</p>
      <p className={`stat-value text-2xl ${color ?? ''}`}>{value}</p>
      {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
    </div>
  );
}

export function MtapiReconnectsPage() {
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [displayNames, setDisplayNames] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'awaiting', dir: 'desc' });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    let stale = false;

    async function load(showLoading: boolean) {
      if (showLoading) {
        setLoading(true);
        setError(null);
      }
      try {
        const rows: AccountRow[] = [];
        let total = 0;

        for (let offset = 0; ; offset += FETCH_PAGE_SIZE) {
          const { data, count, error: err } = await adminSupabase
            .from('broker_accounts')
            .select(ACCOUNT_SELECT, { count: 'exact' })
            .order('created_at', { ascending: true })
            .order('id', { ascending: true })
            .range(offset, offset + FETCH_PAGE_SIZE - 1)
            .returns<AccountRow[]>();

          if (stale) return;
          if (err) {
            setError(err.message ?? 'Could not load broker accounts.');
            return;
          }

          rows.push(...(data ?? []));
          total = count ?? rows.length;
          if (!data || data.length < FETCH_PAGE_SIZE || rows.length >= total) break;
        }

        const names = await fetchDisplayNames(rows.map(r => r.user_id));
        if (stale) return;
        setError(null);
        setDisplayNames(names);
        setAccounts(rows);
      } catch (e) {
        if (stale) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!stale && showLoading) setLoading(false);
      }
    }

    void load(true);
    // Other pages are revalidated when the tab comes back through the query
    // cache; this page is not in that cache, so it re-reads on its own instead
    // of showing counts from the moment it was opened.
    const refresh = () => {
      if (document.visibilityState === 'visible') void load(false);
    };
    document.addEventListener('visibilitychange', refresh);
    return () => {
      stale = true;
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [retryTick]);

  const userSummaries = useMemo(() => buildSummaries(accounts, displayNames), [accounts, displayNames]);

  const totals = useMemo(() => {
    let connected = 0;
    let connecting = 0;
    let error = 0;
    let awaiting = 0;
    let legacy = 0;
    for (const account of accounts) {
      const bucket = bucketOf(account);
      if (bucket === 'connected') connected += 1;
      else if (bucket === 'connecting') connecting += 1;
      else if (bucket === 'error') error += 1;
      else if (bucket === 'awaiting') awaiting += 1;
      else legacy += 1;
    }
    const reconnected = connected + connecting + error;
    const awaitingUsers = userSummaries.filter(u => u.awaiting > 0).length;
    const partial = userSummaries.filter(u => u.status === 'partial').length;
    const none = userSummaries.filter(u => u.status === 'none').length;
    const full = userSummaries.filter(u => u.status === 'reconnected').length;
    return {
      accounts: accounts.length,
      users: userSummaries.length,
      connected,
      connecting,
      error,
      awaiting,
      legacy,
      reconnected,
      awaitingUsers,
      partial,
      none,
      full,
      pct: accounts.length === 0 ? 0 : Math.round((reconnected / accounts.length) * 100),
    };
  }, [accounts, userSummaries]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return userSummaries.filter(u => {
      if (statusFilter && u.status !== statusFilter) return false;
      if (!term) return true;
      return (u.display_name ?? '').toLowerCase().includes(term) || u.user_id.toLowerCase().includes(term);
    });
  }, [userSummaries, search, statusFilter]);

  const sorted = useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      switch (sort.key) {
        case 'display_name':
          return dir * (a.display_name ?? a.user_id).localeCompare(b.display_name ?? b.user_id);
        case 'accounts':
          return dir * (a.total - b.total);
        case 'reconnected':
          return dir * (a.reconnected - b.reconnected);
        case 'status':
          return dir * (STATUS_RANK[a.status] - STATUS_RANK[b.status]);
        case 'last_sync': {
          const av = a.last_synced_at ? Date.parse(a.last_synced_at) : 0;
          const bv = b.last_synced_at ? Date.parse(b.last_synced_at) : 0;
          return dir * (av - bv);
        }
        default:
          return dir * (a.awaiting - b.awaiting);
      }
    });
  }, [filtered, sort]);

  useEffect(() => { setPage(1); }, [search, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const failed = !loading && Boolean(error) && accounts.length === 0;
  const accountsSub = [
    `${totals.pct}% of ${totals.accounts.toLocaleString()}`,
    `${totals.connected} connected now`,
    totals.connecting > 0 ? `${totals.connecting} connecting` : null,
    totals.error > 0 ? `${totals.error} failed` : null,
    totals.legacy > 0 ? `${totals.legacy} still on FXSocket` : null,
  ].filter((part): part is string => part !== null).join(' · ');

  // Keep the page number inside the result set when the data shrinks.
  useEffect(() => {
    setPage(current => (current > totalPages ? totalPages : current));
  }, [totalPages]);

  const columns: Column<UserSummary>[] = [
    {
      key: 'display_name',
      label: 'User',
      sortable: true,
      render: u => <UserLink userId={u.user_id} displayName={u.display_name} />,
    },
    { key: 'accounts', label: 'Broker Accounts', sortable: true, render: u => <span className="font-medium">{u.total}</span> },
    {
      key: 'reconnected',
      label: 'Reconnected',
      sortable: true,
      render: u => <span className="text-success-600 dark:text-success-400 font-medium">{u.reconnected}</span>,
    },
    {
      key: 'awaiting',
      label: 'Awaiting',
      sortable: true,
      render: u => u.awaiting > 0
        ? <span className="text-warning-600 dark:text-warning-400 font-medium">{u.awaiting}</span>
        : <span className="text-slate-400">0</span>,
    },
    {
      key: 'status',
      label: 'Status',
      sortable: true,
      render: u => (
        <Badge variant={STATUS_VARIANT[u.status]} dot>
          {STATUS_LABEL[u.status]}
        </Badge>
      ),
    },
    {
      key: 'last_sync',
      label: 'Last Sync',
      sortable: true,
      render: u => <span className="text-xs text-slate-400">{formatRelative(u.last_synced_at)}</span>,
    },
  ];

  const exportRows = sorted.map(u => ({
    user_id: u.user_id,
    display_name: u.display_name,
    broker_accounts: u.total,
    reconnected: u.reconnected,
    connected_now: u.connected,
    connecting: u.connecting,
    error_or_disconnected: u.error,
    awaiting_reconnect: u.awaiting,
    legacy_fxsocket: u.legacy,
    active_accounts: u.active,
    status: STATUS_LABEL[u.status],
    last_sync: u.last_synced_at ? formatDate(u.last_synced_at) : '',
  }));

  // With no data, the counts are unknown rather than zero — say so.
  const header = (showCounts: boolean) => (
    <div className="flex flex-col sm:flex-row items-start justify-between gap-3">
      <div className="page-header mb-0">
        <h1 className="page-title">MTAPI Reconnects</h1>
        <p className="page-subtitle">
          {showCounts
            ? `${totals.users.toLocaleString()} users · ${totals.accounts.toLocaleString()} broker accounts`
            : 'Reconnect status of every broker account since the MTAPI switch'}
        </p>
      </div>
      {showCounts && <ExportButton data={exportRows} filename="mtapi-reconnects" />}
    </div>
  );

  // No rows and a failed query: show why, instead of counters that read zero.
  if (failed) {
    return (
      <div className="space-y-4 animate-fade-in">
        {header(false)}
        <Card padding="md">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-4 h-4 text-error-500 mt-0.5 shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium text-error-600 dark:text-error-400">
                Could not load broker accounts
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{error}</p>
            </div>
            <Button variant="secondary" size="sm" onClick={() => setRetryTick(t => t + 1)}>
              Try again
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-fade-in">
      {header(true)}

      {error && !loading && (
        <div className="flex items-start gap-2 rounded-xl border border-error-200 dark:border-error-800 bg-error-50 dark:bg-error-900/20 p-4">
          <AlertTriangle className="w-4 h-4 text-error-500 mt-0.5 shrink-0" />
          <p className="text-sm text-error-600 dark:text-error-400">
            Could not refresh broker accounts: {error}. The counts below are from the last successful load.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => <div key={i} className="stat-card skeleton h-24" />)
        ) : (
          <>
            <StatCard
              label="Users"
              value={totals.users.toLocaleString()}
              sub={`${totals.accounts.toLocaleString()} broker accounts`}
            />
            <StatCard
              label="Users fully reconnected"
              value={totals.full.toLocaleString()}
              sub={`${totals.partial} partly · ${totals.none} not started`}
              color="text-success-600 dark:text-success-400"
            />
            <StatCard
              label="Accounts reconnected"
              value={totals.reconnected.toLocaleString()}
              sub={accountsSub}
              color="text-success-600 dark:text-success-400"
            />
            <StatCard
              label="Awaiting reconnect"
              value={totals.awaiting.toLocaleString()}
              sub={`across ${totals.awaitingUsers.toLocaleString()} users`}
              color="text-warning-600 dark:text-warning-400"
            />
          </>
        )}
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        An account counts as reconnected once the customer has completed the reconnect step — its MTAPI status is set.
        That status then says whether the account is connected, still connecting, failed or disconnected. An account
        that is already on MTAPI is awaiting reconnect while that status is still empty, which is the account the app
        keeps prompting the customer about. Select a row to see the individual accounts.
      </p>

      <div className="filter-bar rounded-xl">
        <Input
          placeholder="Search user..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          prefix={<Search className="w-3.5 h-3.5" />}
          className="w-56"
        />
        <Select
          options={[
            { value: 'reconnected', label: 'Fully reconnected' },
            { value: 'partial', label: 'Partly reconnected' },
            { value: 'none', label: 'Not reconnected' },
          ]}
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          placeholder="All Statuses"
          className="w-48"
        />
      </div>

      <Card>
        <DataTable
          columns={columns}
          data={pageRows}
          loading={loading}
          rowKey={u => u.user_id}
          emptyMessage="No users match the current filters"
          sortKey={sort.key}
          sortDir={sort.dir}
          onSort={(key, dir) => setSort({ key, dir })}
          onRowClick={u => setExpandedId(prev => prev === u.user_id ? null : u.user_id)}
          expandedRowKey={expandedId}
          expandedContent={u => (
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Label</th>
                    <th>Platform</th>
                    <th>Login</th>
                    <th>Broker</th>
                    <th>MTAPI</th>
                    <th>Connection</th>
                    <th>Active</th>
                    <th>Last Sync</th>
                  </tr>
                </thead>
                <tbody>
                  {u.accounts.map(account => (
                    <tr key={account.id}>
                      <td className="font-medium">{account.label}</td>
                      <td>
                        <span className="badge bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
                          {account.platform}
                        </span>
                      </td>
                      <td className="font-mono text-xs text-slate-500">{account.account_login ?? '—'}</td>
                      <td className="text-xs text-slate-500">{account.broker_name ?? '—'}</td>
                      <td>
                        {account.provider !== 'mtapi'
                          ? <span className="text-xs text-slate-400">FXSocket</span>
                          : account.mtapi_status
                            ? <StatusBadge status={account.mtapi_status} dot />
                            : <Badge variant="muted">Never connected</Badge>}
                      </td>
                      <td><StatusBadge status={account.connection_status} dot /></td>
                      <td><StatusBadge status={account.is_active} /></td>
                      <td className="text-xs text-slate-400">{formatDate(account.last_synced_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        />
        <Pagination
          page={safePage}
          totalPages={totalPages}
          totalCount={sorted.length}
          pageSize={PAGE_SIZE}
          onPageChange={setPage}
        />
      </Card>
    </div>
  );
}
