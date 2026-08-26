import { AlertTriangle, CheckCircle2, Activity, Gavel, Info } from 'lucide-react';
import { formatDate, formatCurrency } from '../../lib/formatters';
import {
  PipelineTimelineSection,
  LatencyGanttSection,
  LatencyBreakdownSection,
  AiExplainSection,
  AiVerificationSection,
  ModelDecisionChainSection,
  UserConfigurationSection,
  IssuesFoundSection,
  SummaryCell,
} from './PipelineSections';
import { JsonViewer } from '../JsonViewer';
import type { SignalPipelineData } from '../../hooks/useSignalPipeline';

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

function ManagementFailBanner({ error, count }: { error: string; count: number }) {
  return (
    <div className="rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-error-600 dark:text-error-400 flex items-center gap-1.5">
        <AlertTriangle className="w-3.5 h-3.5" /> Signal executed — {count} later management attempt{count !== 1 ? 's' : ''} failed
      </p>
      <p className="text-sm text-error-700 dark:text-error-200 mt-1 break-words">{error}</p>
      <p className="text-[11px] text-slate-500 mt-1">
        These failures happened after the trade opened and are not the entry. They are take-profit / stop management actions
        (e.g. partial TP closes) retrying against a broker position that cannot be resolved.
      </p>
    </div>
  );
}

/** Renders the full pipeline record for a signal: decision chain, verification,
 *  failure/skip banners, linked trade, timeline, user configuration, latency, and deep evidence. */
export function SignalPipelineBody(data: SignalPipelineData & {
  report?: { category?: string | null; reason?: string | null; symbol?: string | null; direction?: string | null } | null;
  context?: string | null;
  hideRawData?: boolean;
}) {
  const {
    signal,
    channelSignal,
    executionLogs,
    listenerEvents,
    trade,
    brokerConfigs,
    loading,
    error,
    events,
    stats,
    durations,
    signalStatus,
    mainSkipReason,
    channelSkipReason,
    firstFailure,
    issues,
    report,
    context,
    hideRawData,
  } = data;

  const failures = executionLogs.filter(l => l.status === 'failed');
  const signalFailed = signalStatus === 'failed';
  const managementFailures = !signalFailed && failures.length > 0;

  return (
    <div className="space-y-6">
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
            <SummaryCell label="Signal ID" value={signal?.id ? signal.id.slice(0, 8) : '—'} mono />
            <SummaryCell label="Created" value={signal?.created_at ? formatDate(signal.created_at) : '—'} />
          </div>

          {!hideRawData && <IssuesFoundSection issues={issues} />}

          <ModelDecisionChainSection signal={signal} listenerEvents={listenerEvents} />
          <AiVerificationSection signal={signal} listenerEvents={listenerEvents} />

          {(mainSkipReason || channelSkipReason) && (
            <SkipBanner skipReason={channelSkipReason ?? mainSkipReason} />
          )}

          {!hideRawData && signalFailed && firstFailure && <FailBanner error={firstFailure} />}
          {!hideRawData && managementFailures && firstFailure && <ManagementFailBanner error={firstFailure} count={failures.length} />}

          {trade && (
            <section>
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">
                <Gavel className="w-4 h-4 text-primary-500" />
                Linked trade
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                <SummaryCell label="Symbol" value={trade.symbol ?? '—'} />
                <SummaryCell label="Direction" value={trade.direction ?? '—'} />
                <SummaryCell label="Status" value={trade.status ?? '—'} />
                <SummaryCell label="Broker ticket" value={trade.metaapi_order_id ?? 'None'} mono />
                <SummaryCell label="Profit" value={trade.profit != null ? formatCurrency(trade.profit) : '—'} tone={trade.profit != null ? (trade.profit >= 0 ? 'success' : 'error') : undefined} />
                <SummaryCell label="Opened" value={trade.opened_at ? formatDate(trade.opened_at) : '—'} />
              </div>
              {managementFailures && !trade.metaapi_order_id && (
                <div className="mt-3 rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                  This trade has <span className="font-semibold">no broker ticket</span> (metaapi_order_id). Every management attempt
                  (partial TP close, stop updates) fails with "unknown ticket" because there is no broker position to act on.
                </div>
              )}
            </section>
          )}

          {(data.pipeline || channelSignal?.pipeline_ts) && (
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

          {!hideRawData && <AiExplainSection signalId={signal?.id ?? null} tradeId={trade?.id ?? null} report={report} context={context} />}

          <UserConfigurationSection
            brokerConfigs={brokerConfigs}
            signal={signal ? {
              channel_id: signal.channel_id,
              channel_signal_id: signal.channel_signal_id ?? signal.telegram_channels?.[0]?.signal_channel_id ?? null,
              parsed_data: signal.parsed_data,
              skip_reason: signal.skip_reason ?? channelSkipReason,
            } : null}
            trade={trade}
            executionLogs={executionLogs}
            tradeBrokerAccountId={trade?.broker_account_id ?? null}
          />

          <LatencyBreakdownSection stats={stats} />

          {!hideRawData && (
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
          )}

          {!hideRawData && channelSignal?.raw_message != null && channelSignal.raw_message !== signal?.raw_message && (
            <section>
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">Canonical channel signal</h3>
              <div className="space-y-2">
                <JsonViewer data={channelSignal.raw_message ?? null} label="Raw message" />
                <JsonViewer data={channelSignal.parsed_data ?? null} label="Parsed data" />
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
