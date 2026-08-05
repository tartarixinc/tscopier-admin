import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, RotateCcw } from 'lucide-react';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { authSupabase as adminSupabase, fetchDisplayNames } from '../lib/adminSupabase';
import { formatDate, formatRelative } from '../lib/formatters';
import { DataTable } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import { UserLink } from '../components/UserLink';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Alert } from '../components/ui/Alert';
import { Badge } from '../components/ui/Badge';
import type { Column } from '../components/DataTable';

type StatusFilter = 'all' | 'online' | 'offline';

interface EngineRow {
  user_id: string;
  display_name: string | null;
  phone_number: string | null;
  listener_engine: string | null;
  copier_paused: boolean;
  subscription_status: string | null;
  subscription_plan: string | null;
  is_eligible: boolean;
  is_online: boolean;
  worker_id: string | null;
  role: string | null;
  expires_at: string | null;
  lease_updated_at: string | null;
  session_updated_at: string | null;
}

interface ReconnectResult {
  user_id?: string;
  ok?: boolean;
  online?: boolean;
  pending_lease?: boolean;
  error?: string;
  warning?: string;
  status?: number;
  channels?: number;
}

interface ReconnectResponse {
  error?: string;
  force?: boolean;
  eligible_sessions?: number;
  offline_targeted?: number;
  reconnected?: number;
  failed?: number;
  worker_url_host?: string;
  results?: ReconnectResult[];
}

const LIVE_ROLES = new Set(['listener', 'all']);

function isLeaseLive(lease: { expires_at?: string | null; role?: string | null } | null | undefined): boolean {
  if (!lease?.expires_at) return false;
  if (!LIVE_ROLES.has(String(lease.role ?? ''))) return false;
  return new Date(lease.expires_at).getTime() > Date.now();
}

function isSubscriptionActive(status: string | null | undefined, trialEndsAt: string | null | undefined): boolean {
  const s = String(status ?? '');
  // Match worker planLimits.isSubscriptionActive: paid active always counts;
  // trialing only while trial_ends_at is unset/unparseable or still in the future.
  if (s === 'active') return true;
  if (s === 'trialing') {
    if (!trialEndsAt) return true;
    const end = new Date(trialEndsAt).getTime();
    if (!Number.isFinite(end)) return true;
    return end > Date.now();
  }
  return false;
}

function isAdminActive(isAdmin: boolean | null | undefined, adminUntil: string | null | undefined): boolean {
  if (!isAdmin) return false;
  if (!adminUntil) return true;
  return new Date(adminUntil).getTime() > Date.now();
}

function isEligibleEngineUser(args: {
  copier_paused: boolean;
  subscription_status: string | null | undefined;
  trial_ends_at: string | null | undefined;
  is_admin: boolean | null | undefined;
  admin_until: string | null | undefined;
}): boolean {
  if (args.copier_paused) return false;
  return (
    isSubscriptionActive(args.subscription_status, args.trial_ends_at) ||
    isAdminActive(args.is_admin, args.admin_until)
  );
}

async function extractInvokeError(error: unknown, fallbackData?: ReconnectResponse | null): Promise<string> {
  if (fallbackData?.error) return fallbackData.error;
  if (error instanceof FunctionsHttpError) {
    try {
      const body = await error.context.json();
      if (body && typeof body === 'object') {
        const rec = body as Record<string, unknown>;
        if (typeof rec.error === 'string' && rec.error.trim()) return rec.error;
        const firstFail = Array.isArray(rec.results)
          ? (rec.results as ReconnectResult[]).find(r => r && r.ok === false)
          : null;
        if (firstFail?.error) return firstFail.error;
        return JSON.stringify(body);
      }
    } catch {
      // fall through
    }
  }
  if (error instanceof Error && error.message) return error.message;
  return 'Reconnect failed';
}

function summarizeReconnect(result: ReconnectResponse | null): { variant: 'success' | 'error' | 'warning'; text: string } {
  if (!result) return { variant: 'error', text: 'Empty response from reconnect function' };

  const ok = result.reconnected ?? 0;
  const failed = result.failed ?? 0;
  const targeted = result.offline_targeted ?? 0;
  const pending = (result.results ?? []).filter(r => r.pending_lease).length;
  const online = (result.results ?? []).filter(r => r.online).length;
  const firstError = (result.results ?? []).find(r => r.ok === false)?.error;

  if (targeted === 0) {
    return {
      variant: 'warning',
      text: 'No session was targeted. It may already be online, or the Telegram session is missing.',
    };
  }

  if (failed > 0 && ok === 0) {
    return {
      variant: 'error',
      text: `Reconnect failed for ${failed} session${failed === 1 ? '' : 's'}${firstError ? `: ${firstError}` : ''}`,
    };
  }

  if (failed > 0) {
    return {
      variant: 'warning',
      text: `Partial reconnect: ${ok} ok (${online} lease confirmed), ${failed} failed${firstError ? ` — ${firstError}` : ''}`,
    };
  }

  if (pending > 0 && online === 0) {
    return {
      variant: 'warning',
      text: `Worker accepted reconnect for ${ok} session${ok === 1 ? '' : 's'}, but lease not confirmed yet. Refreshing…`,
    };
  }

  return {
    variant: 'success',
    text: `Reconnected ${ok} session${ok === 1 ? '' : 's'} (${online} lease confirmed).`,
  };
}

export function CopierEnginePage() {
  const [data, setData] = useState<EngineRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [reconnectingId, setReconnectingId] = useState<string | null>(null);
  const [bulkReconnecting, setBulkReconnecting] = useState(false);
  const [actionMessage, setActionMessage] = useState<{ variant: 'success' | 'error' | 'warning'; text: string } | null>(null);

  const loadEngines = useCallback(async (opts?: { keepMessage?: boolean }) => {
    setLoading(true);
    if (!opts?.keepMessage) setActionMessage(null);

    const { data: sessions } = await adminSupabase
      .from('telegram_sessions')
      .select('user_id, phone_number, listener_engine, is_active, updated_at')
      .eq('is_active', true)
      .order('updated_at', { ascending: false });

    const userIds = [...new Set((sessions ?? []).map((s) => s.user_id).filter(Boolean))];

    if (userIds.length === 0) {
      setData([]);
      setLoading(false);
      return;
    }

    const [{ data: leases }, { data: profiles }, { data: subs }, displayNames] = await Promise.all([
      adminSupabase
        .from('worker_session_leases')
        .select('user_id, worker_id, role, expires_at, updated_at')
        .in('user_id', userIds),
      adminSupabase
        .from('user_profiles')
        .select('user_id, display_name, copier_paused, is_admin, admin_until')
        .in('user_id', userIds),
      adminSupabase
        .from('subscriptions')
        .select('user_id, status, plan, trial_ends_at')
        .in('user_id', userIds),
      fetchDisplayNames(userIds),
    ]);

    const leaseByUser = new Map(
      (leases ?? []).map((l) => [l.user_id, l])
    );
    const profileByUser = new Map(
      (profiles ?? []).map((p) => [p.user_id, p])
    );
    const subByUser = new Map(
      (subs ?? []).map((s) => [s.user_id, s])
    );

    const rows: EngineRow[] = (sessions ?? []).map((s) => {
      const lease = leaseByUser.get(s.user_id) ?? null;
      const profile = profileByUser.get(s.user_id);
      const sub = subByUser.get(s.user_id);
      const copierPaused = Boolean(profile?.copier_paused);
      const eligible = isEligibleEngineUser({
        copier_paused: copierPaused,
        subscription_status: sub?.status,
        trial_ends_at: sub?.trial_ends_at,
        is_admin: profile?.is_admin,
        admin_until: profile?.admin_until,
      });

      return {
        user_id: s.user_id,
        display_name: displayNames[s.user_id] ?? profile?.display_name ?? null,
        phone_number: s.phone_number ?? null,
        listener_engine: s.listener_engine ?? null,
        copier_paused: copierPaused,
        subscription_status: sub?.status ?? null,
        subscription_plan: sub?.plan ?? null,
        is_eligible: eligible,
        is_online: isLeaseLive(lease),
        worker_id: lease?.worker_id ?? null,
        role: lease?.role ?? null,
        expires_at: lease?.expires_at ?? null,
        lease_updated_at: lease?.updated_at ?? null,
        session_updated_at: s.updated_at ?? null,
      };
    });

    rows.sort((a, b) => {
      const aNeedsAttention = Number(!a.is_online && a.is_eligible);
      const bNeedsAttention = Number(!b.is_online && b.is_eligible);
      return bNeedsAttention - aNeedsAttention
        || Number(a.is_online) - Number(b.is_online)
        || (a.display_name ?? '').localeCompare(b.display_name ?? '');
    });
    setData(rows);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadEngines();
    const timer = window.setInterval(() => {
      loadEngines({ keepMessage: true });
    }, 20_000);
    return () => window.clearInterval(timer);
  }, [loadEngines]);

  const onlineCount = data.filter(r => r.is_online).length;
  const offlineCount = data.filter(r => !r.is_online && r.is_eligible).length;
  const reconnectableCount = offlineCount;

  const filtered = useMemo(() => {
    if (statusFilter === 'online') return data.filter(r => r.is_online);
    if (statusFilter === 'offline') return data.filter(r => !r.is_online && r.is_eligible);
    // All = online + eligible offline (hide unpaid/paused noise)
    return data.filter(r => r.is_online || r.is_eligible);
  }, [data, statusFilter]);

  async function invokeReconnect(body: Record<string, unknown>): Promise<ReconnectResponse | null> {
    const { data: result, error } = await adminSupabase.functions.invoke<ReconnectResponse>(
      'reconnect-offline-listeners',
      { body }
    );

    if (error) {
      const detail = await extractInvokeError(error, result);
      throw new Error(detail);
    }
    if (result?.error) throw new Error(result.error);
    return result;
  }

  async function reconnectUser(userId: string, opts?: { forceOnline?: boolean }) {
    setReconnectingId(userId);
    setActionMessage(null);

    try {
      const result = await invokeReconnect({
        user_id: userId,
        force: true,
        // force already re-targets even if lease looks live
        limit: 1,
      });
      const summary = summarizeReconnect(result);
      // If operator forced an already-online row, still show outcome.
      if (opts?.forceOnline && (result?.offline_targeted ?? 0) > 0) {
        setActionMessage(summary);
      } else {
        setActionMessage(summary);
      }
      await loadEngines({ keepMessage: true });
      // Second refresh after worker heartbeat settles.
      setTimeout(() => { loadEngines({ keepMessage: true }); }, 5000);
    } catch (err) {
      setActionMessage({
        variant: 'error',
        text: err instanceof Error ? err.message : 'Reconnect failed',
      });
    } finally {
      setReconnectingId(null);
    }
  }

  async function reconnectAllOffline() {
    if (reconnectableCount === 0) return;
    setBulkReconnecting(true);
    setActionMessage(null);

    try {
      const result = await invokeReconnect({
        force: true,
        limit: Math.min(40, reconnectableCount),
      });
      setActionMessage(summarizeReconnect(result));
      await loadEngines({ keepMessage: true });
      setTimeout(() => { loadEngines({ keepMessage: true }); }, 5000);
    } catch (err) {
      setActionMessage({
        variant: 'error',
        text: err instanceof Error ? err.message : 'Bulk reconnect failed',
      });
    } finally {
      setBulkReconnecting(false);
    }
  }

  const columns: Column<EngineRow>[] = [
    {
      key: 'display_name',
      label: 'User',
      render: r => <UserLink userId={r.user_id} displayName={r.display_name} />,
    },
    {
      key: 'is_online',
      label: 'Engine',
      render: r => <StatusBadge status={r.is_online ? 'online' : 'offline'} dot />,
    },
    {
      key: 'listener_engine',
      label: 'Listener',
      render: r => <span className="font-mono text-xs text-slate-500">{r.listener_engine ?? '—'}</span>,
    },
    {
      key: 'worker_id',
      label: 'Worker',
      render: r => (
        <div className="space-y-0.5">
          <span className="font-mono text-xs text-slate-400 block">{r.worker_id ?? '—'}</span>
          {r.role && <Badge variant="muted">{r.role}</Badge>}
        </div>
      ),
    },
    {
      key: 'subscription_status',
      label: 'Subscription',
      render: r => (
        <div className="flex flex-col gap-1 items-start">
          <StatusBadge status={r.subscription_status} />
          {r.subscription_plan && <span className="text-[11px] text-slate-400">{r.subscription_plan}</span>}
        </div>
      ),
    },
    {
      key: 'copier_paused',
      label: 'Copier',
      render: r => (
        r.copier_paused
          ? <Badge variant="warning">Paused</Badge>
          : <Badge variant="success">Active</Badge>
      ),
    },
    {
      key: 'expires_at',
      label: 'Lease / Heartbeat',
      render: r => (
        <div className="text-xs text-slate-400 space-y-0.5">
          <div>{r.expires_at ? `Expires ${formatDate(r.expires_at)}` : 'No lease'}</div>
          <div>HB {formatRelative(r.lease_updated_at ?? r.session_updated_at)}</div>
        </div>
      ),
    },
    {
      key: 'actions',
      label: '',
      render: r => {
        const busy = bulkReconnecting || (reconnectingId != null && reconnectingId !== r.user_id);
        if (r.is_online) {
          return (
            <Button
              size="sm"
              variant="ghost"
              loading={reconnectingId === r.user_id}
              disabled={busy}
              onClick={() => reconnectUser(r.user_id, { forceOnline: true })}
              title="Force session reconnect even if lease looks live"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Force
            </Button>
          );
        }
        if (!r.is_eligible) {
          return (
            <span className="text-xs text-slate-400" title="Needs active subscription/admin and copier not paused">
              Ineligible
            </span>
          );
        }
        return (
          <Button
            size="sm"
            variant="primary"
            loading={reconnectingId === r.user_id}
            disabled={busy}
            onClick={() => reconnectUser(r.user_id)}
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reconnect
          </Button>
        );
      },
    },
  ];

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="flex flex-col sm:flex-row items-start justify-between gap-3">
        <div className="page-header mb-0">
          <h1 className="page-title">Copier Engine</h1>
          <p className="page-subtitle">
            {onlineCount + offlineCount} eligible sessions — {onlineCount} online, {offlineCount} offline
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => loadEngines()}
            disabled={loading || bulkReconnecting}
          >
            <RefreshCw className="w-4 h-4" /> Reload
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={bulkReconnecting}
            disabled={reconnectableCount === 0 || reconnectingId != null}
            onClick={reconnectAllOffline}
          >
            <RotateCcw className="w-4 h-4" />
            Force Reconnect Offline
          </Button>
        </div>
      </div>

      {actionMessage && (
        <Alert variant={actionMessage.variant}>{actionMessage.text}</Alert>
      )}

      <div className="flex gap-2">
        {([
          ['all', `All (${onlineCount + offlineCount})`],
          ['online', `Online (${onlineCount})`],
          ['offline', `Offline (${offlineCount})`],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setStatusFilter(key)}
            className={
              statusFilter === key
                ? 'badge bg-primary-100 text-primary-800 dark:bg-primary-900/40 dark:text-primary-300 cursor-pointer'
                : 'badge bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300 cursor-pointer hover:bg-slate-200 dark:hover:bg-slate-600'
            }
          >
            {label}
          </button>
        ))}
      </div>

      <Card>
        <DataTable
          columns={columns}
          data={filtered}
          loading={loading}
          rowKey={r => r.user_id}
          emptyMessage="No copier engines found"
        />
      </Card>
    </div>
  );
}
