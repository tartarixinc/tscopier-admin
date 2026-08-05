import { useEffect, useState } from 'react';
import { authSupabase as adminSupabase, fetchDisplayNames } from '../lib/adminSupabase';
import { formatDate, formatCurrency } from '../lib/formatters';
import { DataTable } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import { UserLink } from '../components/UserLink';
import { ExportButton } from '../components/ExportButton';
import { Card, CardHeader } from '../components/ui/Card';
import type { Column } from '../components/DataTable';

interface AffiliateRow {
  user_id: string;
  display_name: string | null;
  referral_code: string;
  is_active: boolean;
  payout_email: string | null;
  total_earned_cents: number;
  total_paid_cents: number;
  created_at: string;
}

interface CommissionRow {
  id: string;
  affiliate_user_id: string;
  affiliate_display_name: string | null;
  referred_user_id: string | null;
  invoice_amount_cents: number;
  commission_rate: number;
  commission_cents: number;
  currency: string | null;
  status: string | null;
  period_start: string | null;
  period_end: string | null;
  created_at: string;
}

export function AffiliatesPage() {
  const [affiliates, setAffiliates] = useState<AffiliateRow[]>([]);
  const [commissions, setCommissions] = useState<CommissionRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const [{ data: affRows }, { data: commRows }] = await Promise.all([
        adminSupabase.from('affiliate_profiles').select('user_id, referral_code, is_active, payout_email, total_earned_cents, total_paid_cents, created_at').order('created_at', { ascending: false }),
        adminSupabase.from('commission_ledger').select('id, affiliate_user_id, referred_user_id, invoice_amount_cents, commission_rate, commission_cents, currency, status, period_start, period_end, created_at').order('created_at', { ascending: false }).limit(100),
      ]);

      const allUserIds = [
        ...new Set([
          ...(affRows ?? []).map((r) => r.user_id),
          ...(commRows ?? []).map((r) => r.affiliate_user_id),
        ].filter(Boolean)),
      ];
      const displayNames = await fetchDisplayNames(allUserIds);

      setAffiliates((affRows ?? []).map((r) => ({ ...r, display_name: displayNames[r.user_id] ?? null })));
      setCommissions((commRows ?? []).map((r) => ({ ...r, affiliate_display_name: displayNames[r.affiliate_user_id] ?? null })));
      setLoading(false);
    })();
  }, []);

  const affiliateColumns: Column<AffiliateRow>[] = [
    { key: 'display_name', label: 'User', render: r => <UserLink userId={r.user_id} displayName={r.display_name} /> },
    { key: 'referral_code', label: 'Referral Code', render: r => <span className="font-mono text-sm font-medium">{r.referral_code}</span> },
    { key: 'is_active', label: 'Active', render: r => <StatusBadge status={r.is_active} /> },
    { key: 'payout_email', label: 'Payout Email', render: r => <span className="text-xs text-slate-500">{r.payout_email ?? '—'}</span> },
    { key: 'total_earned_cents', label: 'Earned', render: r => <span className="font-medium text-success-600 dark:text-success-400">{formatCurrency(r.total_earned_cents / 100)}</span> },
    { key: 'total_paid_cents', label: 'Paid', render: r => <span className="text-xs text-slate-500">{formatCurrency(r.total_paid_cents / 100)}</span> },
    { key: 'created_at', label: 'Joined', render: r => <span className="text-xs text-slate-400">{formatDate(r.created_at)}</span> },
  ];

  const commissionColumns: Column<CommissionRow>[] = [
    { key: 'affiliate_display_name', label: 'Affiliate', render: r => <UserLink userId={r.affiliate_user_id} displayName={r.affiliate_display_name} /> },
    { key: 'invoice_amount_cents', label: 'Invoice', render: r => formatCurrency(r.invoice_amount_cents / 100) },
    { key: 'commission_rate', label: 'Rate', render: r => <span className="text-xs">{((r.commission_rate ?? 0) * 100).toFixed(0)}%</span> },
    { key: 'commission_cents', label: 'Commission', render: r => <span className="font-medium text-success-600 dark:text-success-400">{formatCurrency(r.commission_cents / 100)}</span> },
    { key: 'status', label: 'Status', render: r => <StatusBadge status={r.status} dot /> },
    { key: 'period_start', label: 'Period', render: r => <span className="text-xs text-slate-400">{r.period_start?.slice(0, 10) ?? '—'} - {r.period_end?.slice(0, 10) ?? '—'}</span> },
    { key: 'created_at', label: 'Created', render: r => <span className="text-xs text-slate-400">{formatDate(r.created_at)}</span> },
  ];

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-col sm:flex-row items-start justify-between gap-3">
        <div className="page-header mb-0">
          <h1 className="page-title">Affiliates</h1>
          <p className="page-subtitle">{affiliates.length} affiliate profiles</p>
        </div>
        <ExportButton data={affiliates} filename="affiliates" />
      </div>

      <Card>
        <CardHeader><h3 className="text-sm font-semibold">Affiliate Profiles</h3></CardHeader>
        <DataTable columns={affiliateColumns} data={affiliates} loading={loading} rowKey={r => r.user_id} />
      </Card>

      <Card>
        <CardHeader><h3 className="text-sm font-semibold">Commission Ledger (Last 100)</h3></CardHeader>
        <DataTable columns={commissionColumns} data={commissions} loading={loading} rowKey={r => r.id} emptyMessage="No commissions recorded" />
      </Card>
    </div>
  );
}
