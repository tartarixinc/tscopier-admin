import { useEffect, useState } from 'react';
import { authSupabase as adminSupabase, fetchDisplayNames } from '../lib/adminSupabase';
import { formatDate, shortId } from '../lib/formatters';
import { DataTable, Pagination } from '../components/DataTable';
import { UserLink } from '../components/UserLink';
import { JsonViewer } from '../components/JsonViewer';
import { Modal } from '../components/ui/Modal';
import { Card } from '../components/ui/Card';
import { Alert } from '../components/ui/Alert';
import type { Column } from '../components/DataTable';

interface AuditLogRow {
  id: string;
  actor_user_id: string;
  actor_display_name: string | null;
  target_user_id: string | null;
  target_display_name: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  reason: string | null;
  request_payload: unknown;
  before_state: unknown;
  after_state: unknown;
  correlation_id: string | null;
  created_at: string;
}

const PAGE_SIZE = 50;

export function AuditLogsPage() {
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [search, setSearch] = useState('');
  const [data, setData] = useState<AuditLogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AuditLogRow | null>(null);

  useEffect(() => { setPage(1); }, [dateFrom, dateTo, search]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      const from = (page - 1) * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      let q = adminSupabase
        .from('admin_audit_logs')
        .select('id, actor_user_id, target_user_id, action, entity_type, entity_id, reason, request_payload, before_state, after_state, correlation_id, created_at', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, to);

      if (dateFrom) q = q.gte('created_at', dateFrom);
      if (dateTo) q = q.lte('created_at', dateTo + 'T23:59:59Z');

      const term = search.trim().replace(/[,()]/g, '');
      if (term) {
        q = q.or(`action.ilike.%${term}%,entity_id.ilike.%${term}%,reason.ilike.%${term}%`);
      }

      const { data: rows, count, error: qError } = await q;
      if (cancelled) return;
      if (qError) {
        setError(qError.message);
        setData([]);
        setTotal(0);
        setLoading(false);
        return;
      }

      const ids = [...new Set((rows ?? []).flatMap(r => [r.actor_user_id, r.target_user_id]).filter((id): id is string => Boolean(id)))];
      const names = ids.length > 0 ? await fetchDisplayNames(ids) : {};
      if (cancelled) return;

      setData((rows ?? []).map(r => ({
        ...r,
        actor_display_name: names[r.actor_user_id] ?? null,
        target_display_name: r.target_user_id ? names[r.target_user_id] ?? null : null,
      })));
      setTotal(count ?? 0);
      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [page, dateFrom, dateTo, search]);

  const columns: Column<AuditLogRow>[] = [
    {
      key: 'created_at',
      label: 'When',
      render: r => <span className="text-xs text-slate-400 whitespace-nowrap">{formatDate(r.created_at)}</span>,
    },
    {
      key: 'actor_user_id',
      label: 'Actor',
      render: r => <UserLink userId={r.actor_user_id} displayName={r.actor_display_name} />,
    },
    {
      key: 'action',
      label: 'Action',
      render: r => <span className="font-mono text-xs px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">{r.action}</span>,
    },
    {
      key: 'target_user_id',
      label: 'Target',
      render: r => r.target_user_id
        ? <UserLink userId={r.target_user_id} displayName={r.target_display_name} />
        : <span className="text-xs text-slate-400">—</span>,
    },
    {
      key: 'entity',
      label: 'Entity',
      render: r => (
        <span className="text-xs text-slate-500">
          {r.entity_type ?? '—'}{r.entity_id ? ` · ${shortId(r.entity_id)}` : ''}
        </span>
      ),
    },
    {
      key: 'reason',
      label: 'Reason',
      render: r => <span className="text-xs text-slate-500 max-w-xs block truncate">{r.reason ?? '—'}</span>,
    },
    {
      key: 'details',
      label: '',
      className: 'text-right',
      render: r => (
        <button
          onClick={() => setSelected(r)}
          className="text-xs text-primary-600 dark:text-primary-400 hover:underline"
        >
          Details
        </button>
      ),
    },
  ];

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="page-header">
        <h1 className="page-title">Audit Logs</h1>
        <p className="page-subtitle">
          {total.toLocaleString()} recorded admin actions — the immutable trail of changes made through the product
        </p>
      </div>

      <div className="filter-bar rounded-xl flex-wrap">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search action, entity id or reason"
          className="input-base py-1.5 text-xs w-64"
        />
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-500">From</label>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="input-base py-1.5 text-xs w-36" />
          <label className="text-xs text-slate-500">To</label>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="input-base py-1.5 text-xs w-36" />
        </div>
      </div>

      {error && (
        <Alert variant="error" title="Audit logs could not be loaded">
          {error}
        </Alert>
      )}

      <Card>
        <DataTable
          columns={columns}
          data={data}
          loading={loading}
          rowKey={r => r.id}
          emptyMessage="No audited admin actions recorded yet"
        />
        <Pagination
          page={page}
          totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))}
          totalCount={total}
          pageSize={PAGE_SIZE}
          onPageChange={setPage}
        />
      </Card>

      {!loading && !error && total === 0 && (
        <p className="text-xs text-slate-400">
          Entries appear here when an admin action is performed through the product — bans and unbans, admin access
          changes, broker and channel toggles, alert acknowledgements and rule changes. Each entry is written by the
          product's admin-mutate function and can never be edited or deleted.
        </p>
      )}

      <Modal
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? `Audit entry · ${selected.action}` : 'Audit entry'}
        subtitle={selected ? formatDate(selected.created_at) : ''}
      >
        {selected && (
          <div className="space-y-4 text-sm">
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <dt className="text-xs uppercase tracking-wider text-slate-400">Actor</dt>
                <dd className="mt-0.5"><UserLink userId={selected.actor_user_id} displayName={selected.actor_display_name} /></dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wider text-slate-400">Target</dt>
                <dd className="mt-0.5">
                  {selected.target_user_id
                    ? <UserLink userId={selected.target_user_id} displayName={selected.target_display_name} />
                    : <span className="text-slate-400">—</span>}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wider text-slate-400">Entity</dt>
                <dd className="mt-0.5 font-mono text-xs text-slate-600 dark:text-slate-300">
                  {selected.entity_type ?? '—'}{selected.entity_id ? ` · ${selected.entity_id}` : ''}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wider text-slate-400">Correlation ID</dt>
                <dd className="mt-0.5 font-mono text-xs text-slate-600 dark:text-slate-300">{selected.correlation_id ?? '—'}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs uppercase tracking-wider text-slate-400">Reason</dt>
                <dd className="mt-0.5 text-slate-700 dark:text-slate-200">{selected.reason ?? '—'}</dd>
              </div>
            </dl>

            <div className="space-y-3">
              <div>
                <p className="text-xs uppercase tracking-wider text-slate-400 mb-1">Request payload</p>
                <JsonViewer data={selected.request_payload} />
              </div>
              <div>
                <p className="text-xs uppercase tracking-wider text-slate-400 mb-1">Before state</p>
                <JsonViewer data={selected.before_state} />
              </div>
              <div>
                <p className="text-xs uppercase tracking-wider text-slate-400 mb-1">After state</p>
                <JsonViewer data={selected.after_state} />
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
