import { useEffect, useState } from 'react';
import { X, FileWarning, User, Crosshair, MessageSquare } from 'lucide-react';
import { authSupabase as adminSupabase } from '../lib/adminSupabase';
import { formatDate, formatNumber } from '../lib/formatters';
import { useSignalPipeline } from '../hooks/useSignalPipeline';
import { SummaryCell } from './pipeline/PipelineSections';
import { SignalPipelineBody } from './pipeline/SignalPipelineBody';
import { JsonViewer } from './JsonViewer';
import { UserLink } from './UserLink';
import { StatusBadge } from './StatusBadge';

export interface ReportRow {
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
  entry_price: number | null;
  sl: number | null;
  tp: number | null;
  lot_size: number | null;
  created_at: string | null;
}

export const CATEGORY_LABELS: Record<string, string> = {
  wrong_entry: 'Wrong entry price',
  wrong_sl: 'Wrong stop loss',
  wrong_tp: 'Wrong take profit',
  wrong_direction: 'Wrong direction',
  wrong_lots: 'Wrong lot size',
  not_executed: 'Not executed',
  other: 'Other',
};

interface LinkedTrade {
  id: string;
  signal_id: string | null;
  broker_account_id: string | null;
  metaapi_order_id: string | null;
  symbol: string | null;
  direction: string | null;
  status: string | null;
  entry_price: number | null;
  sl: number | null;
  tp: number | null;
  lot_size: number | null;
  profit: number | null;
  opened_at: string | null;
  closed_at: string | null;
}

interface ReportDetailModalProps {
  report: ReportRow;
  onClose: () => void;
}

function SectionTitle({ icon: Icon, children }: { icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200">
      <Icon className="w-4 h-4 text-primary-500" />
      {children}
    </h3>
  );
}

export function ReportDetailModal({ report, onClose }: ReportDetailModalProps) {
  const [linkedTrades, setLinkedTrades] = useState<LinkedTrade[]>([]);
  const [tradesLoading, setTradesLoading] = useState(true);

  const firstTrade = linkedTrades[0] ?? null;
  const pipeline = useSignalPipeline(firstTrade?.signal_id ?? null);
  const signal = pipeline.signal;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setTradesLoading(true);

    (async () => {
      if (!report.ticket) {
        setTradesLoading(false);
        return;
      }
      // The report stores the broker ticket at report time; trades store the
      // same broker ticket in metaapi_order_id. Match on ticket + user so the
      // report resolves to the actual trade even if the symbol string differs.
      const { data, error } = await adminSupabase
        .from('trades')
        .select('id, signal_id, broker_account_id, metaapi_order_id, symbol, direction, status, entry_price, sl, tp, lot_size, profit, opened_at, closed_at')
        .eq('user_id', report.user_id ?? '')
        .eq('metaapi_order_id', report.ticket)
        .order('opened_at', { ascending: false })
        .limit(5);
      if (cancelled) return;
      if (error) { setTradesLoading(false); return; }

      const rows = (data ?? []) as LinkedTrade[];
      if (!cancelled) {
        setLinkedTrades(rows);
        setTradesLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [report.user_id, report.ticket]);

  const status = report.status ?? 'open';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:p-6" onClick={onClose}>
      <div
        className="w-full max-w-6xl my-4 sm:my-8 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-xl animate-fade-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 dark:border-slate-700 sticky top-0 bg-white dark:bg-slate-800 rounded-t-xl z-10">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">
                {CATEGORY_LABELS[report.category ?? ''] ?? report.category ?? 'Trade report'}
              </h2>
              <StatusBadge status={status} dot />
              <span className="font-mono text-xs text-slate-400">{report.id.slice(0, 8)}</span>
            </div>
            <p className="text-[11px] text-slate-400 mt-0.5 leading-tight">
              {report.user_display_name ?? 'Unknown user'}
              {report.created_at ? ` · ${formatDate(report.created_at)}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-6 max-h-[calc(100vh-6rem)] overflow-y-auto">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="rounded-lg bg-slate-50 dark:bg-slate-900/50 border border-slate-100 dark:border-slate-700/60 px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1">
                <User className="w-3 h-3" /> Reported by
              </p>
              <p className="text-sm mt-0.5 truncate">
                {report.user_id
                  ? <UserLink userId={report.user_id} displayName={report.user_display_name} />
                  : <span className="text-slate-400">—</span>}
              </p>
            </div>
            <SummaryCell label="Symbol" value={report.symbol ?? '—'} />
            <SummaryCell label="Direction" value={report.direction ?? '—'} />
            <SummaryCell label="Reported" value={report.created_at ? formatDate(report.created_at) : '—'} />
          </div>

          <section className="space-y-3">
            <SectionTitle icon={FileWarning}>What the user reported</SectionTitle>
            <div className="rounded-xl border border-slate-200 dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-700/60 overflow-hidden">
              <div className="px-3 py-2.5 flex items-start gap-3">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 w-24 shrink-0 pt-0.5">Category</span>
                <span className="text-sm text-slate-800 dark:text-slate-100">{CATEGORY_LABELS[report.category ?? ''] ?? report.category ?? '—'}</span>
              </div>
              <div className="px-3 py-2.5 flex items-start gap-3">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 w-24 shrink-0 pt-0.5">Reason</span>
                <p className="text-sm text-slate-700 dark:text-slate-200 whitespace-pre-wrap break-words">{report.reason || '—'}</p>
              </div>
              <div className="px-3 py-2.5 flex items-start gap-3">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 w-24 shrink-0 pt-0.5">Trade context</span>
                <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-slate-700 dark:text-slate-200">
                  <span><span className="text-slate-400">Ticket:</span> <span className="font-mono">{report.ticket ?? '—'}</span></span>
                  <span><span className="text-slate-400">Broker:</span> {report.broker_label ?? '—'}</span>
                  <span><span className="text-slate-400">Entry:</span> {report.entry_price != null ? formatNumber(report.entry_price) : '—'}</span>
                  <span><span className="text-slate-400">SL:</span> {report.sl != null ? formatNumber(report.sl) : '—'}</span>
                  <span><span className="text-slate-400">TP:</span> {report.tp != null ? formatNumber(report.tp) : '—'}</span>
                  <span><span className="text-slate-400">Lot size:</span> {report.lot_size != null ? formatNumber(report.lot_size) : '—'}</span>
                </div>
              </div>
            </div>
          </section>

          <section className="space-y-3">
            <SectionTitle icon={Crosshair}>The trade</SectionTitle>
            {tradesLoading ? (
              <div className="h-16 rounded skeleton" />
            ) : linkedTrades.length === 0 ? (
              <p className="text-xs text-slate-400">
                No matching trade found{report.ticket ? ` for broker ticket #${report.ticket}` : ' (report has no ticket)'}. The trade may have been closed or opened under a different ticket.
              </p>
            ) : (
              <div className="space-y-3">
                {linkedTrades.map(t => (
                  <div key={t.id} className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-3">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <SummaryCell label="Status" value={t.status ?? '—'} />
                      <SummaryCell label="Symbol" value={t.symbol ?? '—'} />
                      <SummaryCell label="Direction" value={t.direction ?? '—'} />
                      <SummaryCell label="Profit" value={t.profit != null ? formatNumber(t.profit) : '—'} tone={t.profit != null ? (t.profit >= 0 ? 'success' : 'error') : undefined} />
                      <SummaryCell label="Entry" value={t.entry_price != null ? formatNumber(t.entry_price) : '—'} />
                      <SummaryCell label="SL" value={t.sl != null ? formatNumber(t.sl) : '—'} />
                      <SummaryCell label="TP" value={t.tp != null ? formatNumber(t.tp) : '—'} />
                      <SummaryCell label="Opened" value={t.opened_at ? formatDate(t.opened_at) : '—'} />
                    </div>
                    <p className="text-[11px] text-slate-400 flex items-center gap-1.5">
                      <span className="font-mono">#{t.metaapi_order_id ?? 'no ticket'}</span>
                      {t.closed_at && <span>· closed {formatDate(t.closed_at)}</span>}
                      {t.signal_id && (
                        <>
                          <span>· signal <span className="font-mono">{t.signal_id.slice(0, 8)}</span></span>
                        </>
                      )}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="space-y-3">
            <SectionTitle icon={MessageSquare}>Telegram message & channel</SectionTitle>
            {!firstTrade?.signal_id ? (
              <p className="text-xs text-slate-400">
                No linked signal for this trade, so the original Telegram message cannot be shown.
              </p>
            ) : pipeline.loading ? (
              <div className="h-16 rounded skeleton" />
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <SummaryCell label="Channel" value={signal?.telegram_channels?.[0]?.display_name ?? '—'} />
                  <SummaryCell label="Status" value={pipeline.signalStatus ?? '—'} />
                  <SummaryCell label="Signal" value={signal?.id ? signal.id.slice(0, 8) : '—'} mono />
                  <SummaryCell label="Created" value={signal?.created_at ? formatDate(signal.created_at) : '—'} />
                </div>
                <JsonViewer data={signal?.raw_message ?? null} label="Raw message" collapsed={false} />
                <JsonViewer data={signal?.parsed_data ?? null} label="Parsed data" />
              </div>
            )}
          </section>

          <section className="space-y-3">
            <SectionTitle icon={MessageSquare}>Signal pipeline</SectionTitle>
            {!firstTrade?.signal_id ? (
              <p className="text-xs text-slate-400">
                No linked signal for this trade, so the pipeline, execution attempts and AI analysis cannot be shown.
              </p>
            ) : (
              <SignalPipelineBody {...pipeline} report={{
                category: report.category,
                reason: report.reason,
                symbol: report.symbol,
                direction: report.direction,
              }} context="USER COMPLAINT MODAL — the administrator is investigating a trade report. The reported category and reason are the single most important thing. Priorities: (1) give a clear verdict on each claim in the report (VALID / PARTIALLY VALID / NOT VALID / CANNOT VERIFY), comparing what the Telegram signal actually said (quote exact lines) against what was sent to the broker and what is on the trade row; (2) explain exactly what went wrong if the complaint is valid; (3) keep the rest (latency, model chain, execution attempts) brief unless it explains the reported problem. Do not lead with latency or pipeline timing when a complaint is on the table." />
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
