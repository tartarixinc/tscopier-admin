import { useEffect, useState } from 'react';
import { authSupabase as adminSupabase } from '../lib/adminSupabase';
import type { ExecutionLogRow } from '../components/pipeline/PipelineSections';
import { collectPipelineIssues, type PipelineIssue } from '../lib/pipelineIssues';
import {
  parsePipelineTimestamps,
  buildPipelineTimeline,
  stageStats,
  type PipelineTimelineEvent,
  type PipelineStageStat,
} from '../lib/pipelineTimeline';

export interface SignalRow {
  id: string;
  user_id: string | null;
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

export interface ChannelSignalRow {
  id: string;
  status: string | null;
  skip_reason: string | null;
  raw_message: string | null;
  parsed_data: unknown;
  pipeline_ts: unknown;
}

export interface LinkedTrade {
  id: string;
  metaapi_order_id: string | null;
  symbol: string | null;
  direction: string | null;
  status: string | null;
  profit: number | null;
  entry_price: number | null;
  sl: number | null;
  tp: number | null;
  lot_size: number | null;
  broker_account_id: string | null;
  broker_label: string | null;
  opened_at: string | null;
}

interface LinkedTradeFetchRow {
  id: string;
  metaapi_order_id: string | null;
  symbol: string | null;
  direction: string | null;
  status: string | null;
  profit: number | null;
  entry_price: number | null;
  sl: number | null;
  tp: number | null;
  lot_size: number | null;
  broker_account_id: string | null;
  opened_at: string | null;
}

export interface ListenerEventRow {
  id: string;
  event_type: string;
  detail: unknown;
  created_at: string | null;
}

export interface SignalPipelineData {
  signal: SignalRow | null;
  channelSignal: ChannelSignalRow | null;
  executionLogs: ExecutionLogRow[];
  listenerEvents: ListenerEventRow[];
  trade: LinkedTrade | null;
  loading: boolean;
  error: string | null;
  pipeline: Record<string, number> | undefined;
  events: PipelineTimelineEvent[];
  stats: PipelineStageStat[];
  durations: Record<string, number> | undefined;
  signalStatus: string | null;
  mainSkipReason: string | null;
  channelSkipReason: string | null;
  firstFailure: string | null;
  issues: PipelineIssue[];
}

/** Loads the full pipeline record for a signal: signal row, canonical channel
 *  signal, execution attempts, listener events, and the first linked trade. */
export function useSignalPipeline(signalId: string | null): SignalPipelineData {
  const [signal, setSignal] = useState<SignalRow | null>(null);
  const [channelSignal, setChannelSignal] = useState<ChannelSignalRow | null>(null);
  const [executionLogs, setExecutionLogs] = useState<ExecutionLogRow[]>([]);
  const [listenerEvents, setListenerEvents] = useState<ListenerEventRow[]>([]);
  const [trade, setTrade] = useState<LinkedTrade | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    if (!signalId) {
      setSignal(null);
      setChannelSignal(null);
      setExecutionLogs([]);
      setListenerEvents([]);
      setTrade(null);
      setLoading(false);
      setError('No linked signal — no pipeline data available.');
      return;
    }

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
          .select('id, metaapi_order_id, symbol, direction, status, profit, entry_price, sl, tp, lot_size, broker_account_id, opened_at')
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

      if (sig.telegram_message_id) {
        const { data: eventData } = await adminSupabase
          .from('listener_events')
          .select('id, event_type, detail, created_at')
          .eq('telegram_message_id', sig.telegram_message_id)
          .order('created_at', { ascending: true })
          .limit(50);
        if (!cancelled) setListenerEvents((eventData ?? []) as ListenerEventRow[]);
      }

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
            metaapi_order_id: t.metaapi_order_id,
            symbol: t.symbol ?? null,
            direction: t.direction ?? null,
            status: t.status ?? null,
            profit: t.profit ?? null,
            entry_price: t.entry_price ?? null,
            sl: t.sl ?? null,
            tp: t.tp ?? null,
            lot_size: t.lot_size ?? null,
            broker_account_id: t.broker_account_id ?? null,
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

  const issues = collectPipelineIssues(mainSkipReason, channelSkipReason, executionLogs);

  return {
    signal,
    channelSignal,
    executionLogs,
    listenerEvents,
    trade,
    loading,
    error,
    pipeline,
    events,
    stats,
    durations,
    signalStatus,
    mainSkipReason,
    channelSkipReason,
    firstFailure,
    issues,
  };
}
