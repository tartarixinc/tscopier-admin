import { useEffect, useState } from 'react';
import { X, Activity } from 'lucide-react';
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

export interface TradePipelineModalProps {
  trade: {
    id: string;
    broker_account_id: string | null;
    metaapi_order_id: string | null;
    symbol: string;
    direction: string;
    status: string;
    profit: number | null;
    entry_price: number | null;
    sl: number | null;
    tp: number | null;
    lot_size: number | null;
    opened_at: string | null;
    closed_at: string | null;
    broker_label: string | null;
    signal_id: string | null;
  };
  onClose: () => void;
}

interface SignalRow {
  raw_message: string | null;
  parsed_data: unknown;
  status: string | null;
  skip_reason: string | null;
  pipeline_ts: unknown;
  telegram_message_id: string | null;
  channel_id: string | null;
  channel_signal_id: string | null;
  created_at: string | null;
  telegram_channels: { display_name: string | null; signal_channel_id: string | null }[] | null;
}

interface ChannelSignalRow {
  raw_message: string | null;
  parsed_data: unknown;
  status: string | null;
  skip_reason: string | null;
  pipeline_ts: unknown;
}

interface RelatedTradeRow {
  id: string;
  metaapi_order_id: string | null;
  symbol: string | null;
  direction: string | null;
  lot_size: number | null;
  entry_price: number | null;
  sl: number | null;
  tp: number | null;
  status: string | null;
  opened_at: string | null;
  closed_at: string | null;
}

interface DispatchClaimRow {
  id: string;
  created_at: string | null;
}

interface ListenerEventRow {
  id: string;
  event_type: string;
  detail: unknown;
  created_at: string | null;
}

function TradeIntegritySection({
  trade,
  relatedTrades,
  claim,
  listenerEvents,
  executionLogs,
}: {
  trade: TradePipelineModalProps['trade'];
  relatedTrades: RelatedTradeRow[];
  claim: DispatchClaimRow | null;
  listenerEvents: ListenerEventRow[];
  executionLogs: ExecutionLogRow[];
}) {
  const ticketIds = relatedTrades.map(row => row.metaapi_order_id).filter((id): id is string => Boolean(id));
  const duplicateSignatures = new Set(
    relatedTrades.map(row => [row.symbol, row.direction, row.lot_size, row.sl, row.tp].join('|')),
  ).size < relatedTrades.length;
  const reviewRequired = relatedTrades.length > 1;
  const currentLog = executionLogs.find(log => {
    if (log.action !== 'order_send' || log.status !== 'success') return false;
    const response = log.response_payload as { ticket?: unknown } | null;
    return response?.ticket != null && String(response.ticket) === String(trade.metaapi_order_id ?? '');
  });
  const currentRequest = currentLog?.request_payload as { comment?: unknown; stoploss?: unknown; takeprofit?: unknown } | null;
  const currentComment = typeof currentRequest?.comment === 'string' ? currentRequest.comment : null;
  const comment = currentComment?.toLowerCase() ?? '';
  const rangeEvidence = executionLogs.some(log =>
    ['virtual_pending_fired', 'range_basket_tp_rebalance', 'range_broker_pending_inserted', 'multi_range_plan'].includes(log.action),
  );
  const isRangeBasket = rangeEvidence || relatedTrades.length > 1 && executionLogs.some(log => log.action === 'range_basket_tp_rebalance');
  const selectedTicket = trade.metaapi_order_id;
  const managementTickets = [...new Set(
    executionLogs
      .filter(log => ['trailing_stop', 'auto_be', 'breakeven'].includes(log.action))
      .map(log => {
        const request = log.request_payload as { ticket?: unknown } | null;
        const response = log.response_payload as { ticket?: unknown } | null;
        return request?.ticket != null ? String(request.ticket) : response?.ticket != null ? String(response.ticket) : null;
      })
      .filter((ticket): ticket is string => Boolean(ticket)),
  )];
  const mismatchedManagementTickets = managementTickets.filter(ticket => ticket !== selectedTicket);
  const actualTradeType = comment.includes(':rg') && comment.includes(':tp')
    ? 'range + layered'
    : comment.includes(':rg')
      ? 'range'
      : comment.includes(':tp') || comment.includes('layer_')
        ? 'layered'
        : rangeEvidence
          ? 'range basket'
        : relatedTrades.length === 1 && currentComment
          ? 'single'
          : duplicateSignatures
            ? 'duplicate replay candidate'
            : relatedTrades.length > 1
              ? 'multi — subtype unknown'
              : 'unknown';
  const typeReason = currentComment
    ? `Evidence: ${currentComment}`
    : 'No successful order comment was found for this broker ticket.';

  return (
    <section className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Dispatch & trade integrity</h3>
          <p className="text-xs text-slate-400 mt-0.5">Same signal and broker account — compare the claim with every linked trade.</p>
        </div>
        {reviewRequired ? (
          <span className="rounded-full bg-amber-100 dark:bg-amber-900/30 px-2.5 py-1 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
            Review {relatedTrades.length} linked trades
          </span>
        ) : (
          <span className="rounded-full bg-emerald-100 dark:bg-emerald-900/30 px-2.5 py-1 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
            One linked trade
          </span>
        )}
      </div>

      {duplicateSignatures && !isRangeBasket && (
        <div className="rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">
          Multiple linked trades share the same symbol, direction, lot size, SL, and TP. This is a duplicate-trade warning for a single-trade execution.
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <SummaryCell label="Linked trades" value={String(relatedTrades.length)} />
        <SummaryCell label="Broker tickets" value={String(ticketIds.length)} />
        <SummaryCell label="Dispatch claim" value={claim ? 'Created' : 'Not found'} tone={claim ? 'success' : 'error'} />
        <SummaryCell label="Listener events" value={String(listenerEvents.length)} />
      </div>

      <div className="rounded-lg bg-slate-50 dark:bg-slate-900/40 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Actual execution type</span>
          <span className="rounded-full bg-primary-100 dark:bg-primary-900/30 px-2 py-0.5 text-xs font-semibold text-primary-700 dark:text-primary-300">
            {actualTradeType}
          </span>
        </div>
        <p className="text-[10px] text-slate-400 mt-1 break-words">{typeReason}</p>
      </div>

      <div className="rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">Stop protection evidence</p>
        {currentLog ? (
          <div className="space-y-1 text-slate-600 dark:text-slate-300">
            <p>Initial stop loss sent to broker: <span className="font-semibold">{currentRequest?.stoploss == null || Number(currentRequest.stoploss) === 0 ? 'No' : String(currentRequest.stoploss)}</span></p>
            <p>Initial take profit sent to broker: <span className="font-semibold">{currentRequest?.takeprofit == null || Number(currentRequest.takeprofit) === 0 ? 'No' : String(currentRequest.takeprofit)}</span></p>
            <p className="text-slate-400">The SL/TP values shown above are stored trade values. They do not prove the broker received the protection.</p>
          </div>
        ) : (
          <p className="text-slate-400">No successful order record was found for this broker ticket, so initial protection cannot be confirmed.</p>
        )}
      </div>

      <div className="space-y-1.5">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Broker tickets and trade records</p>
        {relatedTrades.map(row => (
          <div key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-slate-50 dark:bg-slate-900/40 px-3 py-2 text-xs">
            <span className="font-mono text-slate-600 dark:text-slate-300">{row.metaapi_order_id ?? 'No ticket'}</span>
            <StatusBadge status={row.status ?? 'unknown'} />
            <span>{row.symbol ?? '—'} {row.direction ?? '—'}</span>
            <span className="text-slate-400">{row.lot_size ?? '—'} lots</span>
            <span className="text-slate-400">{row.opened_at ? formatDate(row.opened_at) : '—'}</span>
            <span className="ml-auto font-mono text-[10px] text-slate-400">{row.id.slice(0, 8)}</span>
          </div>
        ))}
      </div>

      <div className="space-y-1.5">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Claim and listener history</p>
        {claim && <p className="text-xs text-slate-500">Claim created: <span className="font-mono">{claim.created_at ? formatDate(claim.created_at) : '—'}</span></p>}
        {listenerEvents.length === 0 ? (
          <p className="text-xs text-slate-400">No listener events found for this Telegram message.</p>
        ) : (
          <div className="space-y-1">
            {listenerEvents.slice(0, 12).map(event => (
              <div key={event.id} className="flex items-start justify-between gap-3 text-xs">
                <span className="font-mono text-slate-600 dark:text-slate-300">{event.event_type}</span>
                <span className="text-slate-400">{event.created_at ? formatDate(event.created_at) : '—'}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="text-[10px] text-slate-400">Signal {trade.signal_id?.slice(0, 8) ?? '—'} · broker account {trade.broker_account_id?.slice(0, 8) ?? '—'} · current ticket {trade.metaapi_order_id ?? '—'}</p>
      {mismatchedManagementTickets.length > 0 && (
        <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          Stop-management records point to ticket {mismatchedManagementTickets.join(', ')}, not the selected ticket {selectedTicket ?? '—'}. This trade’s stop protection cannot be confirmed from those records.
        </div>
      )}
    </section>
  );
}

export function TradePipelineModal({ trade, onClose }: TradePipelineModalProps) {
  const [signal, setSignal] = useState<SignalRow | null>(null);
  const [channelSignal, setChannelSignal] = useState<ChannelSignalRow | null>(null);
  const [executionLogs, setExecutionLogs] = useState<ExecutionLogRow[]>([]);
  const [relatedTrades, setRelatedTrades] = useState<RelatedTradeRow[]>([]);
  const [dispatchClaim, setDispatchClaim] = useState<DispatchClaimRow | null>(null);
  const [listenerEvents, setListenerEvents] = useState<ListenerEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!trade.signal_id) {
        setLoading(false);
        setError('This trade has no linked signal — no pipeline data available.');
        return;
      }

      const relatedTradesQuery = adminSupabase
        .from('trades')
        .select('id, metaapi_order_id, symbol, direction, lot_size, entry_price, sl, tp, status, opened_at, closed_at')
        .eq('signal_id', trade.signal_id)
        .eq('broker_account_id', trade.broker_account_id ?? '')
        .order('opened_at', { ascending: true, nullsFirst: false });
      const claimQuery = trade.broker_account_id
        ? adminSupabase
          .from('signal_broker_dispatch_claims')
          .select('id, created_at')
          .eq('signal_id', trade.signal_id)
          .eq('broker_account_id', trade.broker_account_id)
          .maybeSingle()
        : Promise.resolve({ data: null, error: null });

      const [{ data: signalData }, { data: logData }, { data: relatedTradeData }, { data: claimData }] = await Promise.all([
        adminSupabase
          .from('signals')
          .select('raw_message, parsed_data, status, skip_reason, pipeline_ts, telegram_message_id, channel_id, channel_signal_id, created_at, telegram_channels(display_name, signal_channel_id)')
          .eq('id', trade.signal_id)
          .maybeSingle(),
        adminSupabase
          .from('trade_execution_logs')
          .select('id, action, status, error_message, request_payload, response_payload, created_at')
          .eq('signal_id', trade.signal_id)
          .order('created_at', { ascending: false })
          .limit(50),
        relatedTradesQuery,
        claimQuery,
      ]);

      if (cancelled) return;
      const sig = signalData as SignalRow | null;
      let resolvedSig = sig;
      if (sig?.channel_id && !sig.telegram_channels?.[0]?.display_name) {
        const { data: channelRow } = await adminSupabase
          .from('telegram_channels')
          .select('display_name, signal_channel_id')
          .eq('id', sig.channel_id)
          .maybeSingle();
        if (channelRow) {
          resolvedSig = {
            ...sig,
            telegram_channels: [{ display_name: channelRow.display_name, signal_channel_id: channelRow.signal_channel_id }],
          };
        }
      }
      setSignal(resolvedSig);
      setExecutionLogs((logData ?? []) as ExecutionLogRow[]);
      setRelatedTrades((relatedTradeData ?? []) as RelatedTradeRow[]);
      setDispatchClaim(claimData as DispatchClaimRow | null);

      if (resolvedSig?.telegram_message_id) {
        const { data: eventData } = await adminSupabase
          .from('listener_events')
          .select('id, event_type, detail, created_at')
          .eq('telegram_message_id', resolvedSig.telegram_message_id)
          .order('created_at', { ascending: true })
          .limit(50);
        if (!cancelled) setListenerEvents((eventData ?? []) as ListenerEventRow[]);
      }

      // Canonical channel signal lookup: prefer signals.channel_signal_id (direct FK),
      // fall back to telegram_channels.signal_channel_id + telegram_message_id.
      // NOTE: signals.channel_id is a telegram_channels FK — NOT the channel_signals
      // signal_channel_id — using it here would never match.
      if (resolvedSig) {
        let channelData: ChannelSignalRow | null = null;
        const channelRow = (resolvedSig.telegram_channels as { display_name: string | null; signal_channel_id: string | null }[] | null)?.[0] ?? null;
        if (resolvedSig.channel_signal_id) {
          const { data } = await adminSupabase
            .from('channel_signals')
            .select('raw_message, parsed_data, status, skip_reason, pipeline_ts')
            .eq('id', resolvedSig.channel_signal_id)
            .maybeSingle();
          channelData = data as ChannelSignalRow | null;
        } else if (channelRow?.signal_channel_id && resolvedSig.telegram_message_id) {
          const { data } = await adminSupabase
            .from('channel_signals')
            .select('raw_message, parsed_data, status, skip_reason, pipeline_ts')
            .eq('signal_channel_id', channelRow.signal_channel_id)
            .eq('telegram_message_id', resolvedSig.telegram_message_id)
            .maybeSingle();
          channelData = data as ChannelSignalRow | null;
        }
        if (!cancelled) setChannelSignal(channelData);
      }

      if (cancelled) return;
      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [trade.signal_id, trade.broker_account_id]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const pipeline = signal ? parsePipelineTimestamps(signal.pipeline_ts) : undefined;
  const events = pipeline ? buildPipelineTimeline(pipeline) : [];
  const stats = pipeline ? stageStats(pipeline) : [];

  const durations = pipeline ? (() => {
    const out: Record<string, number> = {};
    for (const { key, value } of stageStats(pipeline)) out[key] = value ?? 0;
    return out;
  })() : undefined;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:p-6" onClick={onClose}>
      <div
        className="w-full max-w-6xl my-4 sm:my-8 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-xl animate-fade-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700 sticky top-0 bg-white dark:bg-slate-800 rounded-t-xl z-10">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">
                {trade.symbol} <span className="font-mono text-sm">· {trade.direction}</span>
              </h2>
              <StatusBadge status={trade.status} dot />
            </div>
            <p className="text-xs text-slate-400 truncate mt-0.5">
              {signal?.telegram_channels?.[0]?.display_name ? `${signal.telegram_channels[0].display_name} · ` : ''}
              <span className="font-mono">{trade.id}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700"
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
                <SummaryCell label="Entry" value={trade.entry_price != null ? String(trade.entry_price) : '—'} mono />
                <SummaryCell label="SL / TP" value={`${trade.sl ?? '—'} / ${trade.tp ?? '—'}`} mono />
                <SummaryCell label="Lots" value={trade.lot_size != null ? String(trade.lot_size) : '—'} mono />
                <SummaryCell
                  label="P&L"
                  value={trade.profit != null ? formatCurrency(trade.profit) : '—'}
                  tone={trade.profit != null ? (trade.profit >= 0 ? 'success' : 'error') : undefined}
                />
                <SummaryCell label="Broker" value={trade.broker_label ?? '—'} />
                <SummaryCell label="Opened" value={trade.opened_at ? formatDate(trade.opened_at) : '—'} />
                <SummaryCell label="Closed" value={trade.closed_at ? formatDate(trade.closed_at) : '—'} />
                <SummaryCell label="Signal" value={trade.signal_id ? trade.signal_id.slice(0, 8) : '—'} mono />
              </div>

              <TradeIntegritySection
                trade={trade}
                relatedTrades={relatedTrades}
                claim={dispatchClaim}
                listenerEvents={listenerEvents}
                executionLogs={executionLogs}
              />

              <section>
                <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3">
                  <Activity className="w-4 h-4 text-primary-500" />
                  Pipeline timeline
                </h3>
                {events.length === 0 ? (
                  <p className="text-xs text-slate-400">No pipeline timestamps recorded for this signal.</p>
                ) : (
                  <PipelineTimelineSection events={events} finalStatus={signal?.status ?? null} />
                )}
              </section>

              <LatencyGanttSection durations={durations} />

              <AiExplainSection
                signalId={trade.signal_id}
                tradeId={trade.id}
                brokerAccountId={trade.broker_account_id}
              />

              <LatencyBreakdownSection stats={stats} />

              <section>
                <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">Signal data</h3>
                <div className="space-y-2">
                  {signal?.telegram_channels?.[0]?.display_name && (
                    <p className="text-xs text-slate-500">Channel: <span className="font-medium">{signal.telegram_channels[0].display_name}</span></p>
                  )}
                  {signal?.skip_reason && (
                    <p className="text-xs text-amber-700 dark:text-amber-400">
                      <span className="font-semibold">Signal skip reason:</span> {signal.skip_reason}
                    </p>
                  )}
                  <JsonViewer data={signal?.raw_message ?? null} label="Raw message" />
                  <JsonViewer data={signal?.parsed_data ?? null} label="Parsed data" />
                  {channelSignal && (
                    <>
                      <JsonViewer data={channelSignal.raw_message ?? null} label="Channel signal raw message" />
                      {channelSignal.skip_reason && (
                        <p className="text-xs text-amber-700 dark:text-amber-400">
                          <span className="font-semibold">Channel signal skip reason:</span> {channelSignal.skip_reason}
                        </p>
                      )}
                    </>
                  )}
                </div>
              </section>

              <ExecutionAttemptsSection logs={executionLogs} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
