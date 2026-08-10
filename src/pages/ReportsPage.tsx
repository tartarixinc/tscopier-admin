import { useEffect, useMemo, useState } from 'react';
import { authSupabase as adminSupabase, fetchDisplayNames } from '../lib/adminSupabase';
import { formatDate } from '../lib/formatters';
import { DataTable, Pagination } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import { UserLink } from '../components/UserLink';
import { ExportButton } from '../components/ExportButton';
import { Card } from '../components/ui/Card';
import { Select } from '../components/ui/Select';
import { Input } from '../components/ui/Input';
import { Search, FileWarning } from 'lucide-react';
import clsx from 'clsx';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, PieChart, Pie, Legend } from 'recharts';
import { CHART_PALETTE, tooltipStyle, gridStyle, axisStyle } from '../lib/chartTheme';
import type { Column } from '../components/DataTable';

interface ReportRow {
  id: string;
  user_id: string | null;
  user_display_name: string | null;
  symbol: string | null;
  direction: string | null;
  category: string | null;
  ticket: string | null;
  broker_label: string | null;
  reason: string | null;
  status: string | null;
  created_at: string | null;
}

const PAGE_SIZE = 50;
const FETCH_LIMIT = 500;

const CATEGORY_LABELS: Record<string, string> = {
  wrong_entry: 'Wrong entry price',
  wrong_sl: 'Wrong stop loss',
  wrong_tp: 'Wrong take profit',
  wrong_direction: 'Wrong direction',
  wrong_lots: 'Wrong lot size',
  not_executed: 'Not executed',
  other: 'Other',
};

export function ReportsPage() {
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [symbolSearch, setSymbolSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  useEffect(() => { setPage(1); }, [statusFilter, symbolSearch, dateFrom, dateTo]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    (async () => {
      let q = adminSupabase
        .from('trade_reports')
        .select('id, user_id, symbol, direction, category, ticket, broker_label, reason, status, created_at')
        .order('created_at', { ascending: false })
        .limit(FETCH_LIMIT);
      if (dateFrom) q = q.gte('created_at', `${dateFrom}T00:00:00Z`);
      if (dateTo) q = q.lte('created_at', `${dateTo}T23:59:59Z`);

      const { data, error } = await q;
      if (cancelled) return;
      if (error) { setLoading(false); return; }

      const userIds = [...new Set((data ?? []).map(r => r.user_id).filter(Boolean))];
      const displayNames = await fetchDisplayNames(userIds);

      if (cancelled) return;
      setRows((data ?? []).map(r => ({
        ...r,
        user_display_name: displayNames[r.user_id ?? ''] ?? null,
      })));
      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [dateFrom, dateTo]);

  const filtered = useMemo(() => {
    const term = symbolSearch.trim().toUpperCase();
    return rows.filter(r => {
      if (statusFilter && (r.status ?? '') !== statusFilter) return false;
      if (term && !(r.symbol ?? '').toUpperCase().includes(term)) return false;
      return true;
    });
  }, [rows, statusFilter, symbolSearch]);

  const summary = useMemo(() => {
    const total = filtered.length;
    const byStatus = new Map<string, number>();
    const bySymbol = new Map<string, number>();
    const byDirection = new Map<string, number>();
    filtered.forEach(r => {
      const status = (r.status ?? 'unknown') || 'unknown';
      byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
      const symbol = (r.symbol ?? 'unknown') || 'unknown';
      bySymbol.set(symbol, (bySymbol.get(symbol) ?? 0) + 1);
      const direction = (r.direction ?? 'unknown') || 'unknown';
      byDirection.set(direction, (byDirection.get(direction) ?? 0) + 1);
    });
    const statusData = [...byStatus.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
    const symbolData = [...bySymbol.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
    const directionData = [...byDirection.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
    const pending = byStatus.get('open') ?? 0;
    const resolved = total - pending;
    return { total, pending, resolved, statusData, symbolData, directionData };
  }, [filtered]);

  const allStatuses = useMemo(() => {
    const s = new Set<string>();
    rows.forEach(r => { if (r.status) s.add(r.status); });
    return [...s].sort();
  }, [rows]);

  const columns: Column<ReportRow>[] = [
    { key: 'user_display_name', label: 'User', render: r => r.user_id ? <UserLink userId={r.user_id} displayName={r.user_display_name} /> : <span className="text-slate-400 text-xs">—</span> },
    { key: 'symbol', label: 'Symbol', render: r => <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">{r.symbol ?? '—'}</span> },
    { key: 'direction', label: 'Direction', render: r => r.direction ? <StatusBadge status={r.direction} dot /> : <span className="text-slate-400 text-xs">—</span> },
    { key: 'category', label: 'Category', render: r => r.category ? <span className="text-xs text-slate-600 dark:text-slate-300">{CATEGORY_LABELS[r.category] ?? r.category}</span> : <span className="text-slate-400 text-xs">—</span> },
    { key: 'ticket', label: 'Ticket', render: r => r.ticket ? <span className="font-mono text-xs text-slate-500">{r.ticket}</span> : <span className="text-slate-400 text-xs">—</span> },
    { key: 'reason', label: 'Reason', render: r => <span className="text-xs text-slate-500 max-w-xs block truncate" title={r.reason ?? ''}>{r.reason ?? '—'}</span> },
    { key: 'status', label: 'Status', render: r => r.status ? <StatusBadge status={r.status} dot /> : <span className="text-slate-400 text-xs">—</span> },
    { key: 'created_at', label: 'Reported', render: r => <span className="text-xs text-slate-400">{r.created_at ? formatDate(r.created_at) : '—'}</span> },
    { key: 'actions', label: '', render: r => (
      <button
        type="button"
        disabled={updatingId === r.id}
        onClick={() => handleToggleStatus(r)}
        className={clsx(
          'text-[11px] font-medium px-2.5 py-1 rounded-md border transition-colors whitespace-nowrap',
          (r.status ?? '') === 'resolved'
            ? 'border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
            : 'border-success-300 bg-success-50 text-success-700 hover:bg-success-100 dark:border-success-700 dark:bg-success-900/30 dark:text-success-300 dark:hover:bg-success-900/50',
          updatingId === r.id && 'opacity-50 pointer-events-none'
        )}
      >
        {(r.status ?? '') === 'resolved' ? 'Reopen' : 'Resolve'}
      </button>
    ) },
  ];

  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const handleToggleStatus = async (r: ReportRow) => {
    const next = (r.status ?? '') === 'resolved' ? 'open' : 'resolved';
    setUpdatingId(r.id);
    const { error } = await adminSupabase
      .from('trade_reports')
      .update({ status: next })
      .eq('id', r.id);
    setUpdatingId(null);
    if (error) return;
    setRows(prev => prev.map(x => x.id === r.id ? { ...x, status: next } : x));
  };

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="flex flex-col sm:flex-row items-start justify-between gap-3">
        <div className="page-header mb-0">
          <h1 className="page-title">Reports</h1>
          <p className="page-subtitle">Trade reports submitted by users — what they flagged and why</p>
        </div>
        <ExportButton data={filtered.map(({ user_display_name, ...r }) => r)} filename="reports" />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="stat-card">
          <p className="stat-label">Reports</p>
          <p className="stat-value text-2xl">{summary.total.toLocaleString()}</p>
          <p className="text-xs text-slate-400 mt-0.5">{summary.symbolData.length} symbol{summary.symbolData.length !== 1 ? 's' : ''} involved</p>
        </div>
        <div className="stat-card">
          <p className="stat-label">Open</p>
          <p className="stat-value text-2xl text-amber-500">{summary.pending.toLocaleString()}</p>
          <p className="text-xs text-slate-400 mt-0.5">Awaiting review</p>
        </div>
        <div className="stat-card">
          <p className="stat-label">Reviewed</p>
          <p className="stat-value text-2xl text-success-600">{summary.resolved.toLocaleString()}</p>
          <p className="text-xs text-slate-400 mt-0.5">Resolved / closed</p>
        </div>
        <div className="stat-card">
          <p className="stat-label">Resolution rate</p>
          <p className="stat-value text-2xl text-slate-900 dark:text-slate-100">{Math.round((summary.resolved / Math.max(1, summary.total)) * 100)}%</p>
          <p className="text-xs text-slate-400 mt-0.5">of reports reviewed</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <div className="px-4 pt-3 pb-2 border-b border-slate-100 dark:border-slate-700">
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Reports by status</h3>
          </div>
          <div className="p-4 h-56">
            {summary.statusData.length === 0 ? (
              <p className="text-sm text-slate-400 text-center pt-16">No data</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={summary.statusData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                  <CartesianGrid {...gridStyle} vertical={false} />
                  <XAxis dataKey="name" {...axisStyle} />
                  <YAxis {...axisStyle} allowDecimals={false} />
                  <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'rgba(148,163,184,0.1)' }} />
                  <Bar dataKey="value" name="Reports" radius={[4, 4, 0, 0]}>
                    {summary.statusData.map((_, i) => <Cell key={i} fill={CHART_PALETTE[i % CHART_PALETTE.length]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>

        <Card>
          <div className="px-4 pt-3 pb-2 border-b border-slate-100 dark:border-slate-700">
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Direction mix</h3>
          </div>
          <div className="p-4 h-56">
            {summary.directionData.length === 0 ? (
              <p className="text-sm text-slate-400 text-center pt-16">No data</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={summary.directionData} dataKey="value" nameKey="name" innerRadius={45} outerRadius={70} paddingAngle={2}>
                    {summary.directionData.map((_, i) => <Cell key={i} fill={CHART_PALETTE[i % CHART_PALETTE.length]} />)}
                  </Pie>
                  <Tooltip contentStyle={tooltipStyle} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>
      </div>

      <Card>
        <div className="px-4 pt-3 pb-2 border-b border-slate-100 dark:border-slate-700">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-2">
            <FileWarning className="w-4 h-4 text-primary-500" />
            Top reported symbols
          </h3>
        </div>
        <div className="flex flex-wrap gap-1.5 px-4 py-3">
          {summary.symbolData.slice(0, 12).map(s => (
            <button
              key={s.name}
              type="button"
              onClick={() => setSymbolSearch(s.name === 'unknown' ? '' : s.name)}
              className={clsx(
                'text-[10px] font-medium px-2 py-1 rounded-full border transition-colors',
                symbolSearch.toUpperCase() === s.name
                  ? 'border-primary-400 bg-primary-50 text-primary-700 dark:bg-primary-900/40 dark:text-primary-300'
                  : 'border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
              )}
            >
              {s.name} · {s.value}
            </button>
          ))}
        </div>
      </Card>

      <div className="filter-bar rounded-xl flex-wrap">
        <Input
          placeholder="Filter by symbol..."
          value={symbolSearch}
          onChange={e => setSymbolSearch(e.target.value)}
          prefix={<Search className="w-3.5 h-3.5" />}
          className="w-44"
        />
        <Select
          options={allStatuses.map(s => ({ value: s, label: s }))}
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
          data={paged}
          loading={loading}
          rowKey={r => r.id}
        />
        <Pagination page={page} totalPages={Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))} totalCount={filtered.length} pageSize={PAGE_SIZE} onPageChange={setPage} />
      </Card>
    </div>
  );
}
