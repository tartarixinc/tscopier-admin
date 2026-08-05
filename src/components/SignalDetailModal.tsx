import { useEffect, useState } from 'react';
import { X, Activity, AlertTriangle, CheckCircle2, Info, Gavel } from 'lucide-react';
import { authSupabase as adminSupabase } from '../lib/adminSupabase';
import { formatDate, formatCurrency } from '../lib/formatters';
import { parsePipelineTimestamps, buildPipelineTimeline, stageStats } from '../lib/pipelineTimeline';
import {
  type ExecutionLogRow,
  PipelineTimelineSection,
  LatencyGanttSection,
  LatencyBreakdownSection,
  AiExplainSection,
  ExecutionAttemptsSection,
  SummaryCell,
} from './pipeline/PipelineSections';
import { JsonViewer } from './JsonViewer';
import { StatusBadge } from './StatusBadge';

interface SignalDetailModalProps {
  signalId: string;
  onClose: () => void;
}

interface SignalRow {
  id: string;
  user_id: string;
  channel_id: string | null;
  raw_message: string | null;
  parsed_data: unknown;
  status: string | null;
  skip_reason: string | null;
  pipeline_ts: unknown;
  telegram_message_id: string | null;
  channel_signal_id: string | null;
  created_at: string | null;
  telegram_channels: { display_name: string | null; signal_channel_id: string | null }[] | null;
}

interface ChannelSignalRow {
  id: string;
  status: string | null;
  skip_reason: string | null;
  raw_message: string | null;
  parsed_data: unknown;
  pipeline_ts: unknown;
}

interface LinkedTrade {
  id: string;
  symbol: string | null;
  direction: string | null;
  status: string | null;
  profit: number | null;
  entry_price: number | null;
  broker_label: string | null;
  opened_at: string | null;
}

interface LinkedTradeFetchRow {
  id: string;
  symbol: string | null;
  direction: string | null;
  status: string | null;
  profit: number | null;
  entry_price: number | null;
  broker_account_id: string | null;
  opened_at: string | null;
}

function SkipBanner({ skipReason }: { skipReason: string | null }) {
  if (!skipReason) return null;
  return (
    <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
        <AlertTriangle className="w-3.5 h-3.5" /> Why this signal was skipped
      </p>
      <p className="text-sm text-amber-800 dark:text-amber-200 mt-1 break-words">{skipReason}</p>
    </div>
  );
}

function FailBanner({ error }: { error: string }) {
  return (
    <div className="rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-error-600 dark:text-error-400 flex items-center gap-1.5">
        <CheckCircle2 className="w-3.5 h-3.5" /> What failed
      </p>
      <p className="text-sm text-error-700 dark:text-error-200 mt-1 break-words">{error}</p>
    </div>
  );
}

export function SignalDetailModal({ signalId, onClose }: SignalDetailModalProps) {
  const [signal, setSignal] = useState<SignalRow | null>(null);
  const [channelSignal, setChannelSignal] = useState<ChannelSignalRow | null>(null);
  const [executionLogs, setExecutionLogs] = useState<ExecutionLogRow[]>([]);
  const [trade, setTrade] = useState<LinkedTrade | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const [{ data: sigData }, { data: logData }, { data: tradeData }] = await Promise.all([
        adminSupabase
          .from('signals')
          .select('id, user_id, channel_id, raw_message, parsed_data, status, skip_reason, pipeline_ts, telegram_message_id, channel_signal_id, created_at, telegram_channels(display_name, signal_channel_id)')
          .eq('id', signalId)
          .maybeSingle(),
        adminSupabase
          .from('trade_execution_logs')
          .select('id, action, status, error_message, request_payload, response_payload, created_at')
          .eq('signal_id', signalId)
          .order('created_at', { ascending: false })
          .limit(50),
        adminSupabase
          .from('trades')
          .select('id, symbol, direction, status, profit, entry_price, broker_account_id, opened_at')
          .eq('signal_id', signalId)
          .maybeSingle(),
      ]);

      if (cancelled) return;
      const sig = sigData as SignalRow | null;
      if (!sig) {
        setError('Signal not found.');
        setLoading(false);
        return;
      }
      setSignal(sig);
      setExecutionLogs((logData ?? []) as ExecutionLogRow[]);

      let brokerLabel: string | null = null;
      if (tradeData) {
        const t = tradeData as LinkedTradeFetchRow;
        const brokerId = t.broker_account_id;
        if (brokerId) {
          const { data: brokerRow } = await adminSupabase
            .from('broker_accounts')
            .select('label')
            .eq('id', brokerId)
            .maybeSingle();
          brokerLabel = (brokerRow as { label?: string } | null)?.label ?? null;
        }
        if (!cancelled) {
          setTrade({
            id: t.id,
            symbol: t.symbol ?? null,
            direction: t.direction ?? null,
            status: t.status ?? null,
            profit: t.profit ?? null,
            entry_price: t.entry_price ?? null,
            broker_label: brokerLabel,
            opened_at: t.opened_at ?? null,
          });
        }
      }

      let channelData: ChannelSignalRow | null = null;
      if (sig.channel_signal_id) {
        const { data } = await adminSupabase
          .from('channel_signals')
          .select('id, status, skip_reason, raw_message, parsed_data, pipeline_ts')
          .eq('id', sig.channel_signal_id)
          .maybeSingle();
        channelData = data as ChannelSignalRow | null;
      } else {
        // signals.channel_id is a telegram_channels FK — NOT channel_signals.signal_channel_id.
        // Resolve the canonical channel id via the embedded telegram_channels row.
        const channelRow = (sig.telegram_channels as { signal_channel_id?: string | null }[] | null)?.[0] ?? null;
        if (channelRow?.signal_channel_id && sig.telegram_message_id) {
          const { data } = await adminSupabase
            .from('channel_signals')
            .select('id, status, skip_reason, raw_message, parsed_data, pipeline_ts')
            .eq('signal_channel_id', channelRow.signal_channel_id)
            .eq('telegram_message_id', sig.telegram_message_id)
            .maybeSingle();
          channelData = data as ChannelSignalRow | null;
        }
      }
      if (!cancelled) setChannelSignal(channelData);

      if (cancelled) return;
      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [signalId]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const pipeline = signal ? parsePipelineTimestamps(signal.pipeline_ts ?? channelSignal?.pipeline_ts) : undefined;
  const events = pipeline ? buildPipelineTimeline(pipeline) : [];
  const stats = pipeline ? stageStats(pipeline) : [];

  const durations = pipeline ? (() => {
    const out: Record<string, number> = {};
    for (const { key, value } of stageStats(pipeline)) out[key] = value ?? 0;
    return out;
  })() : undefined;

  const signalStatus = signal?.status ?? null;
  const mainSkipReason = signal?.skip_reason ?? channelSignal?.skip_reason ?? null;
  const channelSkipReason = channelSignal?.skip_reason ?? null;

  const failures = executionLogs.filter(l => l.status === 'failed');
  const firstFailure = failures[failures.length - 1]?.error_message ?? null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:p-6" onClick={onClose}>
      <div
        className="w-full max-w-6xl my-4 sm:my-8 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-xl animate-fade-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 dark:border-slate-700 sticky top-0 bg-white dark:bg-slate-800 rounded-t-xl z-10">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">
                Signal <span className="font-mono text-xs">{signalId.slice(0, 8)}</span>
              </h2>
              <StatusBadge status={signalStatus} dot />
            </div>
            <p className="text-[11px] text-slate-400 mt-0.5 leading-tight">
              {signal?.telegram_channels?.[0]?.display_name ?? 'Unknown channel'}
              {signal?.created_at ? ` · ${formatDate(signal.created_at)}` : ''}
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

        <div className="px-5 py-4 space-y-6 max-h-[calc(100vh-12rem)] overflow-y-auto">
          {loading ? (
            <div className="space-y-3">
              <div className="h-5 rounded skeleton" />
              <div className="h-40 rounded skeleton" />
              <div className="h-24 rounded skeleton" />
            </div>
          ) : error ? (
            <p className="text-sm text-slate-500">{error}</p>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <SummaryCell label="Status" value={signalStatus ?? '—'} />
                <SummaryCell label="Channel" value={signal?.telegram_channels?.[0]?.display_name ?? '—'} />
                <SummaryCell label="Signal ID" value={signalId.slice(0, 8)} mono />
                <SummaryCell label="Created" value={signal?.created_at ? formatDate(signal.created_at) : '—'} />
              </div>

              {(mainSkipReason || channelSkipReason) && (
                <SkipBanner skipReason={channelSkipReason ?? mainSkipReason} />
              )}

              {(signalStatus === 'failed' || failures.length > 0) && firstFailure && (
                <FailBanner error={firstFailure} />
              )}

              {trade && (
                <section>
                  <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">
                    <Gavel className="w-4 h-4 text-primary-500" />
                    Linked trade
                  </h3>
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                    <SummaryCell label="Symbol" value={trade.symbol ?? '—'} />
                    <SummaryCell label="Direction" value={trade.direction ?? '—'} />
                    <SummaryCell label="Status" value={trade.status ?? '—'} />
                    <SummaryCell label="Profit" value={trade.profit != null ? formatCurrency(trade.profit) : '—'} tone={trade.profit != null ? (trade.profit >= 0 ? 'success' : 'error') : undefined} />
                    <SummaryCell label="Opened" value={trade.opened_at ? formatDate(trade.opened_at) : '—'} />
                  </div>
                </section>
              )}

              {(pipeline || channelSignal?.pipeline_ts) && (
                <section>
                  <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3">
                    <Activity className="w-4 h-4 text-primary-500" />
                    Pipeline timeline
                  </h3>
                  {events.length === 0 ? (
                    <p className="text-xs text-slate-400">No pipeline timestamps recorded for this signal.</p>
                  ) : (
                    <PipelineTimelineSection events={events} finalStatus={signalStatus} />
                  )}
                </section>
              )}

              <LatencyGanttSection durations={durations} />

              <AiExplainSection signalId={signalId} />

              <LatencyBreakdownSection stats={stats} />

              <section>
                <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">Signal data</h3>
                <div className="space-y-2">
                  <JsonViewer data={signal?.raw_message ?? null} label="Raw message" />
                  <JsonViewer data={signal?.parsed_data ?? null} label="Parsed data" />
                  {channelSignal && channelSignal.id !== signal?.channel_signal_id && (
                    <p className="text-xs text-slate-400 flex items-center gap-1.5">
                      <Info className="w-3.5 h-3.5" />
                      Canonical channel signal (shared by all users on this channel)
                    </p>
                  )}
                </div>
              </section>

              {channelSignal?.raw_message != null && channelSignal.raw_message !== signal?.raw_message && (
                <section>
                  <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">Canonical channel signal</h3>
                  <div className="space-y-2">
                    <JsonViewer data={channelSignal.raw_message ?? null} label="Raw message" />
                    <JsonViewer data={channelSignal.parsed_data ?? null} label="Parsed data" />
                  </div>
                </section>
              )}

              <ExecutionAttemptsSection logs={executionLogs} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}