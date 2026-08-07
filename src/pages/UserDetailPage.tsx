import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Server, MessageSquare, Zap, TrendingUp, FlaskConical, Mail, Send, ScrollText, ChevronDown } from 'lucide-react';
import { authSupabase as adminSupabase } from '../lib/adminSupabase';
import { formatDate, formatDateOnly, formatCurrency } from '../lib/formatters';
import { Card, CardHeader, CardContent } from '../components/ui/Card';
import { StatusBadge } from '../components/StatusBadge';
import { Button } from '../components/ui/Button';
import { UserActivityTabs } from '../components/user/UserActivityTabs';

interface UserProfile {
  user_id: string;
  display_name: string | null;
  first_name: string | null;
  last_name: string | null;
  username: string | null;
  country: string | null;
  city: string | null;
  timezone: string | null;
  base_currency: string | null;
  is_admin: boolean;
  admin_until: string | null;
  copier_paused: boolean | null;
  onboarding_completed_at: string | null;
  referred_by_user_id: string | null;
  email_verified_at: string | null;
  subscription_status: string | null;
  created_at: string;
  updated_at: string;
}

interface Subscription {
  plan: string;
  status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  extra_accounts: number;
  trial_ends_at: string | null;
  current_period_end: string | null;
  created_at: string;
}

interface TelegramAccount {
  phone_number: string | null;
  is_active: boolean;
  listener_engine: string | null;
  created_at: string;
  telegram_user_id: string | null;
  linked_at: string | null;
  is_online: boolean;
  worker_id: string | null;
  lease_expires_at: string | null;
}

interface BrokerRow {
  id: string;
  label: string;
  platform: string | null;
  connection_status: string | null;
  last_balance: number | null;
}

interface ChannelRow {
  id: string;
  display_name: string | null;
  channel_username: string | null;
  is_active: boolean;
  last_live_at: string | null;
}

interface TradeReportRow {
  id: string;
  symbol: string | null;
  direction: string | null;
  reason: string | null;
  status: string | null;
  created_at: string | null;
}

interface TgSessionRow {
  phone_number: string | null;
  is_active: boolean;
  listener_engine: string | null;
  created_at: string | null;
}

interface LeaseRow {
  worker_id: string | null;
  role: string | null;
  expires_at: string | null;
  updated_at: string | null;
}

const LIVE_ROLES = new Set(['listener', 'all', 'channel_listener']);

function isLeaseLive(lease: LeaseRow | null | undefined): boolean {
  if (!lease?.expires_at) return false;
  if (!LIVE_ROLES.has(String(lease.role ?? ''))) return false;
  return new Date(lease.expires_at).getTime() > Date.now();
}

interface TgClaimRow {
  telegram_user_id: number | null;
  linked_at: string | null;
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-4 py-2 border-b border-slate-100 dark:border-slate-700 last:border-0">
      <span className="w-36 shrink-0 text-xs font-medium text-slate-500 dark:text-slate-400 pt-0.5">{label}</span>
      <span className="text-sm text-slate-900 dark:text-slate-100">{value ?? '—'}</span>
    </div>
  );
}

export function UserDetailPage() {
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [telegram, setTelegram] = useState<TelegramAccount | null>(null);
  const [brokers, setBrokers] = useState<BrokerRow[]>([]);
  const [channels, setChannels] = useState<ChannelRow[]>([]);
  const [reportedTrades, setReportedTrades] = useState<TradeReportRow[]>([]);
  const [counts, setCounts] = useState({ signals: 0, trades: 0, logs: 0, backtests: 0 });
  const [loading, setLoading] = useState(true);
  const [emailSending, setEmailSending] = useState<string | null>(null);
  const [emailResult, setEmailResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [showEmailMenu, setShowEmailMenu] = useState(false);
  const [showBrokers, setShowBrokers] = useState(false);
  const [showChannels, setShowChannels] = useState(false);
  const [showReportedTrades, setShowReportedTrades] = useState(false);

  const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
  const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

  async function sendSubscriptionEmail(campaign: string) {
    setEmailSending(campaign);
    setEmailResult(null);
    setShowEmailMenu(false);
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/send-subscription-email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ user_id: userId, campaign }),
      });
      const data = await res.json();
      if (!res.ok) {
        setEmailResult({ type: 'error', message: data.error || 'Failed to send email' });
      } else {
        setEmailResult({ type: 'success', message: `Sent "${campaign.replace(/_/g, ' ')}" email to ${data.email}` });
      }
    } catch (err) {
      setEmailResult({ type: 'error', message: (err as Error).message });
    } finally {
      setEmailSending(null);
    }
  }

  async function sendInvoiceDueEmail() {
    setEmailSending('invoice_due');
    setEmailResult(null);
    setShowEmailMenu(false);
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/send-invoice-due-email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ user_id: userId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setEmailResult({ type: 'error', message: data.error || 'Failed to send invoice email' });
      } else {
        const amountMsg = data.amount_due ? ` ($${data.amount_due})` : '';
        setEmailResult({ type: 'success', message: `Sent invoice due email${amountMsg} to ${data.email}` });
      }
    } catch (err) {
      setEmailResult({ type: 'error', message: (err as Error).message });
    } finally {
      setEmailSending(null);
    }
  }

  useEffect(() => {
    if (!userId) return;
    async function load() {
      const [
        { data: prof },
        { data: sub },
        { data: brok },
        { data: chans },
        { count: btCount },
        { count: sigCount },
        { count: tradeCount },
        { count: logCount },
        { data: tgSessionRaw },
        { data: tgClaimRaw },
        { data: reportRows },
        { data: leaseRaw },
      ] = await Promise.all([
        adminSupabase.from('user_profiles').select('*').eq('user_id', userId!).maybeSingle(),
        adminSupabase.from('subscriptions').select('*').eq('user_id', userId!).maybeSingle(),
        adminSupabase.from('broker_accounts').select('id, label, platform, connection_status, last_balance').eq('user_id', userId!),
        adminSupabase.from('telegram_channels').select('id, display_name, channel_username, is_active, last_live_at').eq('user_id', userId!),
        adminSupabase.from('trade_reports').select('id, symbol, direction, reason, status, created_at').eq('user_id', userId!).order('created_at', { ascending: false }),
        adminSupabase.from('backtest_runs').select('*', { count: 'exact', head: true }).eq('user_id', userId!),
        adminSupabase.from('signals').select('id', { count: 'exact', head: true }).eq('user_id', userId!),
        adminSupabase.from('trades').select('id', { count: 'exact', head: true }).eq('user_id', userId!),
        adminSupabase.from('trade_execution_logs').select('id', { count: 'exact', head: true }).eq('user_id', userId!),
        adminSupabase.from('telegram_sessions').select('phone_number, is_active, listener_engine, created_at').eq('user_id', userId!).order('created_at', { ascending: false }).limit(1).maybeSingle(),
        adminSupabase.from('telegram_account_claims').select('telegram_user_id, linked_at').eq('user_id', userId!).maybeSingle(),
        adminSupabase.from('worker_session_leases').select('worker_id, role, expires_at, updated_at').eq('user_id', userId!).order('updated_at', { ascending: false }).limit(1).maybeSingle(),
      ]);

      setProfile(prof as UserProfile);
      setSubscription(sub as Subscription);
      const tgSession = tgSessionRaw as TgSessionRow | null;
      const tgClaim = tgClaimRaw as TgClaimRow | null;
      const lease = leaseRaw as LeaseRow | null;
      const liveLease = isLeaseLive(lease);
      setTelegram(tgSession || tgClaim || liveLease ? {
        phone_number: tgSession?.phone_number ?? null,
        is_active: tgSession?.is_active ?? false,
        listener_engine: tgSession?.listener_engine ?? null,
        created_at: tgSession?.created_at ?? tgClaim?.linked_at ?? '',
        telegram_user_id: tgClaim?.telegram_user_id?.toString() ?? null,
        linked_at: tgClaim?.linked_at ?? null,
        is_online: liveLease || Boolean(tgSession?.is_active),
        worker_id: lease?.worker_id ?? null,
        lease_expires_at: lease?.expires_at ?? null,
      } : null);
      setBrokers((brok ?? []) as BrokerRow[]);
      setChannels((chans ?? []) as ChannelRow[]);
      setReportedTrades((reportRows ?? []) as TradeReportRow[]);
      setCounts({
        signals: sigCount ?? 0,
        trades: tradeCount ?? 0,
        logs: logCount ?? 0,
        backtests: btCount ?? 0,
      });
      setLoading(false);
    }
    load();
  }, [userId]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-8 w-48" />
        <div className="grid grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="card p-6 skeleton h-32" />)}
        </div>
      </div>
    );
  }

  if (!profile) {
    return <div className="text-slate-400 text-center py-16">User not found</div>;
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate('/users')}>
          <ArrowLeft className="w-4 h-4" /> Back
        </Button>
        <div>
          <h1 className="page-title">{profile.display_name ?? profile.user_id.slice(0, 8)}</h1>
          <p className="page-subtitle font-mono text-xs">{profile.user_id}</p>
        </div>
        {profile.is_admin && <StatusBadge status="active" />}

        <div className="ml-auto relative">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowEmailMenu(!showEmailMenu)}
            disabled={!!emailSending}
          >
            {emailSending ? (
              <>
                <Send className="w-4 h-4 animate-pulse" /> Sending...
              </>
            ) : (
              <>
                <Mail className="w-4 h-4" /> Send Email
              </>
            )}
          </Button>

          {showEmailMenu && (
            <div className="absolute right-0 top-full mt-2 w-64 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg z-50 overflow-hidden">
              <button
                className="w-full text-left px-4 py-3 text-sm hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors border-b border-slate-100 dark:border-slate-700"
                onClick={() => sendSubscriptionEmail('no_subscription_nudge')}
              >
                <span className="font-medium text-slate-900 dark:text-slate-100">No Subscription Nudge</span>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Remind user to activate a plan</p>
              </button>
              <button
                className="w-full text-left px-4 py-3 text-sm hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                onClick={() => sendSubscriptionEmail('trial_expired')}
              >
                <span className="font-medium text-slate-900 dark:text-slate-100">Trial Expired</span>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Notify that trial has ended</p>
              </button>
              {subscription?.status === 'past_due' && subscription?.stripe_customer_id && (
                <button
                  className="w-full text-left px-4 py-3 text-sm hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors border-t border-slate-100 dark:border-slate-700"
                  onClick={() => sendInvoiceDueEmail()}
                >
                  <span className="font-medium text-amber-700 dark:text-amber-400">Invoice Due</span>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Send overdue invoice reminder from billing</p>
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {emailResult && (
        <div className={`px-4 py-3 rounded-lg text-sm ${
          emailResult.type === 'success'
            ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'
            : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800'
        }`}>
          {emailResult.message}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Profile */}
        <Card>
          <CardHeader><h3 className="text-sm font-semibold">Profile</h3></CardHeader>
          <CardContent className="p-4">
            <InfoRow label="Display Name" value={profile.display_name} />
            <InfoRow label="First / Last" value={[profile.first_name, profile.last_name].filter(Boolean).join(' ') || null} />
            <InfoRow label="Username" value={profile.username} />
            <InfoRow label="Country" value={profile.country} />
            <InfoRow label="City" value={profile.city} />
            <InfoRow label="Timezone" value={profile.timezone} />
            <InfoRow label="Base Currency" value={profile.base_currency} />
            <InfoRow label="Copier" value={profile.copier_paused ? <span className="text-warning-600 dark:text-warning-400 font-medium">Paused</span> : <span className="text-success-600 dark:text-success-400 font-medium">Active</span>} />
            <InfoRow label="Onboarded" value={profile.onboarding_completed_at ? formatDate(profile.onboarding_completed_at) : 'Not completed'} />
            <InfoRow label="Email Verified" value={profile.email_verified_at ? formatDate(profile.email_verified_at) : 'Not verified'} />
            <InfoRow label="Admin Until" value={profile.admin_until ? formatDateOnly(profile.admin_until) : (profile.is_admin ? 'Permanent' : '—')} />
            <InfoRow label="Referred By" value={profile.referred_by_user_id ? <span className="font-mono text-xs">{profile.referred_by_user_id.slice(0, 8)}...</span> : null} />
            <InfoRow label="Joined" value={formatDate(profile.created_at)} />
          </CardContent>
        </Card>

        <div className="space-y-6">
          {/* Subscription */}
          <Card>
            <CardHeader><h3 className="text-sm font-semibold">Subscription</h3></CardHeader>
            <CardContent className="p-4">
              {subscription ? (
                <>
                  <InfoRow label="Plan" value={<StatusBadge status={subscription.plan} />} />
                  <InfoRow label="Status" value={<StatusBadge status={subscription.status} />} />
                  <InfoRow label="Extra Accounts" value={subscription.extra_accounts} />
                  <InfoRow label="Period End" value={formatDateOnly(subscription.current_period_end)} />
                  <InfoRow label="Trial Ends" value={formatDateOnly(subscription.trial_ends_at)} />
                  <InfoRow label="Stripe Customer" value={<span className="font-mono text-xs">{subscription.stripe_customer_id ?? '—'}</span>} />
                  <InfoRow label="Stripe Sub ID" value={<span className="font-mono text-xs break-all">{subscription.stripe_subscription_id ?? '—'}</span>} />
                </>
              ) : (
                <p className="text-slate-400 text-sm">No subscription</p>
              )}
            </CardContent>
          </Card>

          {/* Telegram Account */}
          <Card>
            <CardHeader><h3 className="text-sm font-semibold">Telegram Account</h3></CardHeader>
            <CardContent className="p-4">
              {telegram ? (
                <>
                  <InfoRow label="Phone" value={telegram.phone_number ? <span className="font-mono text-xs">{telegram.phone_number}</span> : null} />
                  <InfoRow label="Session Status" value={
                    telegram.is_online
                      ? <span className="text-success-600 dark:text-success-400 font-medium">Connected</span>
                      : <span className="text-warning-600 dark:text-warning-400 font-medium">Disconnected</span>
                  } />
                  <InfoRow label="Listener Engine" value={telegram.listener_engine} />
                  <InfoRow label="Telegram ID" value={telegram.telegram_user_id ? <span className="font-mono text-xs">{telegram.telegram_user_id}</span> : null} />
                  <InfoRow label="Linked At" value={telegram.linked_at ? formatDate(telegram.linked_at) : null} />
                  <InfoRow label="Session Created" value={telegram.created_at ? formatDate(telegram.created_at) : null} />
                  {telegram.worker_id && <InfoRow label="Listener Worker" value={<span className="font-mono text-xs">{telegram.worker_id}</span>} />}
                  {telegram.lease_expires_at && <InfoRow label="Lease Expires" value={formatDate(telegram.lease_expires_at)} />}
                </>
              ) : (
                <p className="text-slate-400 text-sm">No Telegram account connected</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
        {[
          { icon: Server, label: 'Broker Accounts', value: brokers.length },
          { icon: MessageSquare, label: 'Telegram Channels', value: channels.length },
          { icon: Zap, label: 'Signals', value: counts.signals },
          { icon: TrendingUp, label: 'Trades', value: counts.trades },
          { icon: ScrollText, label: 'Copier Logs', value: counts.logs },
          { icon: FlaskConical, label: 'Backtests', value: counts.backtests },
        ].map(stat => (
          <div key={stat.label} className="stat-card text-center">
            <stat.icon className="w-5 h-5 mx-auto text-primary-500 mb-2" />
            <p className="text-2xl font-bold text-slate-900 dark:text-slate-100">{stat.value.toLocaleString()}</p>
            <p className="text-xs text-slate-400 mt-0.5">{stat.label}</p>
          </div>
        ))}
      </div>

      {/* Broker accounts */}
      <Card>
        <CardHeader>
          <button
            className="flex items-center justify-between w-full gap-2 group"
            onClick={() => setShowBrokers(!showBrokers)}
          >
            <h3 className="text-sm font-semibold">Broker Accounts ({brokers.length})</h3>
            <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${showBrokers ? 'rotate-180' : ''}`} />
          </button>
        </CardHeader>
        {showBrokers && (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead><tr><th>Label</th><th>Platform</th><th>Status</th><th>Balance</th></tr></thead>
              <tbody>
                {brokers.length === 0 ? (
                  <tr><td colSpan={4} className="text-center py-6 text-slate-400">No broker accounts</td></tr>
                ) : brokers.map((b: BrokerRow) => (
                  <tr key={b.id}>
                    <td className="font-medium">{b.label}</td>
                    <td>{b.platform}</td>
                    <td><StatusBadge status={b.connection_status} /></td>
                    <td>{formatCurrency(b.last_balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Telegram channels */}
      <Card>
        <CardHeader>
          <button
            className="flex items-center justify-between w-full gap-2 group"
            onClick={() => setShowChannels(!showChannels)}
          >
            <h3 className="text-sm font-semibold">Telegram Channels ({channels.length})</h3>
            <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${showChannels ? 'rotate-180' : ''}`} />
          </button>
        </CardHeader>
        {showChannels && (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead><tr><th>Name</th><th>Username</th><th>Active</th><th>Last Live</th></tr></thead>
              <tbody>
                {channels.length === 0 ? (
                  <tr><td colSpan={4} className="text-center py-6 text-slate-400">No channels</td></tr>
                ) : channels.map((c: ChannelRow) => (
                  <tr key={c.id}>
                    <td className="font-medium">{c.display_name}</td>
                    <td className="text-slate-500">{c.channel_username}</td>
                    <td><StatusBadge status={c.is_active ? 'active' : 'inactive'} /></td>
                    <td className="text-xs text-slate-400">{formatDate(c.last_live_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Reported trades */}
      <Card>
        <CardHeader>
          <button
            className="flex items-center justify-between w-full gap-2 group"
            onClick={() => setShowReportedTrades(!showReportedTrades)}
          >
            <h3 className="text-sm font-semibold">Reported Trades ({reportedTrades.length})</h3>
            <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${showReportedTrades ? 'rotate-180' : ''}`} />
          </button>
        </CardHeader>
        {showReportedTrades && (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead><tr><th>Symbol</th><th>Direction</th><th>Reason</th><th>Status</th><th>Reported At</th></tr></thead>
              <tbody>
                {reportedTrades.length === 0 ? (
                  <tr><td colSpan={5} className="text-center py-6 text-slate-400">No reported trades</td></tr>
                ) : reportedTrades.map((r: TradeReportRow) => (
                  <tr key={r.id}>
                    <td className="font-medium">{r.symbol}</td>
                    <td><StatusBadge status={r.direction} /></td>
                    <td className="text-slate-500">{r.reason ?? '—'}</td>
                    <td><StatusBadge status={r.status} /></td>
                    <td className="text-xs text-slate-400">{formatDate(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* User activity tabs */}
      <UserActivityTabs userId={profile.user_id} counts={counts} />
    </div>
  );
}