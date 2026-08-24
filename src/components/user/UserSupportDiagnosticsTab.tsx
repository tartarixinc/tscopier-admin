import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Activity, AlertTriangle, MessageSquare, Server, Settings, UserRound, type LucideIcon } from 'lucide-react';
import { authSupabase as adminSupabase } from '../../lib/adminSupabase';
import { formatCurrency, formatDate, formatNumber } from '../../lib/formatters';
import { Card, CardContent, CardHeader } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { StatusBadge } from '../StatusBadge';
import { JsonViewer } from '../JsonViewer';
import { Pagination } from '../DataTable';
import {
  errorDisplayForItem,
  executionLogToErrorItem,
  failedSignalToErrorItem,
  isFailureStatus,
  type EntryExecutionLogLike,
} from '../../lib/errors';

export interface SupportUserProfile {
  user_id: string;
  display_name: string | null;
  first_name: string | null;
  last_name: string | null;
  username: string | null;
  country: string | null;
  timezone: string | null;
  base_currency: string | null;
  copier_paused: boolean | null;
  onboarding_completed_at: string | null;
  subscription_status: string | null;
  created_at: string;
}

export interface SupportSubscription {
  plan: string;
  status: string;
  current_period_end: string | null;
  trial_ends_at: string | null;
}

export interface SupportTelegramAccount {
  is_active: boolean;
  is_online: boolean;
  listener_engine: string | null;
  worker_id: string | null;
  lease_expires_at: string | null;
  linked_at: string | null;
  created_at: string;
}

export interface SupportBrokerSummary {
  id: string;
  label: string;
  platform: string | null;
  connection_status: string | null;
  last_balance: number | null;
}

export interface SupportChannelSummary {
  id: string;
  display_name: string | null;
  channel_username: string | null;
  is_active: boolean;
  last_live_at: string | null;
}

export interface SupportSummary {
  profile: SupportUserProfile;
  subscription: SupportSubscription | null;
  telegram: SupportTelegramAccount | null;
  brokers: SupportBrokerSummary[];
  channels: SupportChannelSummary[];
  counts: { signals: number; trades: number; logs: number; backtests: number };
}

interface UserSupportDiagnosticsTabProps {
  userId: string;
  summary: SupportSummary;
}

interface SupportSignalRow {
  id: string;
  user_id: string | null;
  channel_id: string | null;
  channel_signal_id: string | null;
  telegram_message_id: string | null;
  raw_message: string | null;
  parsed_data: unknown;
  status: string | null;
  skip_reason: string | null;
  created_at: string;
}

interface SupportExecutionLogRow extends EntryExecutionLogLike {
  user_id: string | null;
  signal_id: string | null;
}

interface SupportTradeRow {
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
  opened_at: string | null;
  closed_at: string | null;
}

interface BrokerConfigRow {
  id: string;
  label: string;
  platform: string | null;
  broker_name: string | null;
  broker_server: string | null;
  account_login: string | null;
  connection_status: string | null;
  is_active: boolean;
  copier_mode: string | null;
  last_balance: number | null;
  last_equity: number | null;
  last_synced_at: string | null;
  fxsocket_status: string | null;
  terminal_connected: boolean | null;
  trade_allowed: boolean | null;
  connection_error: string | null;
  ai_settings: unknown;
  manual_settings: unknown;
  channel_trading_configs: unknown;
}

interface ChannelConfigRow {
  id: string;
  display_name: string | null;
  channel_username: string | null;
  is_active: boolean;
  lot_size_override: number | null;
  pip_tolerance_override: number | null;
  channel_keywords: unknown;
  signal_channel_id: string | null;
  last_seen_at: string | null;
  last_live_at: string | null;
}

interface PresetRow {
  id: string;
  name: string;
  copier_mode: string | null;
  manual_settings: unknown;
  channel_filters: unknown;
  updated_at: string | null;
}

interface ParsedSignalSummary {
  symbol: string | null;
  direction: string | null;
  entry: string | null;
  stopLoss: string | null;
  takeProfit: string | null;
}

interface AccountOutcome {
  brokerAccountId: string | null;
  brokerLabel: string | null;
  status: 'success' | 'failed' | 'pending' | 'unknown';
  reason: string | null;
  recoveryState: string;
  source: string;
  createdAt: string | null;
}

const SIGNAL_PAGE_SIZE = 10;
const LOG_FETCH_CHUNK_SIZE = 10;
const LOG_FETCH_PAGE_SIZE = 1000;
const TRADE_FETCH_CHUNK_SIZE = 10;
const TRADE_FETCH_PAGE_SIZE = 1000;
const ENTRY_SUCCESS_ACTIONS = new Set(['order_send', 'open_trade', 'virtual_pending_fired']);
const DEFERRED_SUCCESS_ACTIONS = new Set(['virtual_pending_inserted', 'range_broker_pending_inserted']);
const TRADE_SUCCESS_STATUSES = new Set(['open', 'closed']);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function firstText(record: Record<string, unknown> | null, ...keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function normalizeAction(action: string | null | undefined): string {
  return String(action ?? '').trim().toLowerCase();
}

function formatNumericValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return formatNumber(value, 2);
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  const numeric = Number(text);
  return Number.isFinite(numeric) && /^[+-]?\d+(\.\d+)?$/.test(text) ? formatNumber(numeric, 2) : text;
}

function valueList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(formatNumericValue).filter((v): v is string => Boolean(v));
  }
  const record = asRecord(value);
  if (record) {
    return Object.keys(record)
      .sort()
      .map(key => formatNumericValue(record[key]))
      .filter((v): v is string => Boolean(v));
  }
  const single = formatNumericValue(value);
  return single ? [single] : [];
}

function parsedSignalSummary(parsedData: unknown): ParsedSignalSummary {
  const parsed = asRecord(parsedData);
  const intent = asRecord(parsed?._intent);
  const symbol = firstText(parsed, 'symbol', 'instrument', 'requested_symbol', 'broker_symbol')
    ?? firstText(intent, 'symbol', 'instrument');
  const directionRaw = firstText(parsed, 'direction', 'side', 'order_side', 'action')
    ?? firstText(intent, 'direction', 'side', 'order_side');
  const direction = (() => {
    const d = directionRaw?.toLowerCase();
    if (d === 'buy' || d === 'long') return 'BUY';
    if (d === 'sell' || d === 'short') return 'SELL';
    return directionRaw ?? null;
  })();
  const entry = formatNumericValue(parsed?.entry ?? parsed?.entry_price ?? parsed?.entryPrice ?? parsed?.price)
    ?? (() => {
      const range = valueList(parsed?.entry_range ?? parsed?.entryRange);
      if (range.length >= 2) return `${range[0]} - ${range[1]}`;
      const low = formatNumericValue(parsed?.entry_min ?? parsed?.entry_from);
      const high = formatNumericValue(parsed?.entry_max ?? parsed?.entry_to);
      return low && high ? `${low} - ${high}` : null;
    })();
  const takeProfits = [
    ...valueList(parsed?.tp_levels),
    ...valueList(parsed?.take_profits),
    ...valueList(parsed?.takeProfits),
    ...valueList(parsed?.targets),
    ...valueList(parsed?.tp),
    ...valueList(parsed?.take_profit),
  ];
  for (let i = 1; i <= 8; i += 1) {
    const level = formatNumericValue(parsed?.[`tp${i}`] ?? parsed?.[`take_profit_${i}`]);
    if (level) takeProfits.push(level);
  }

  return {
    symbol: symbol?.toUpperCase() ?? null,
    direction,
    entry,
    stopLoss: formatNumericValue(parsed?.sl ?? parsed?.stop_loss ?? parsed?.stopLoss ?? parsed?.stoploss),
    takeProfit: [...new Set(takeProfits)].join(' / ') || null,
  };
}

function sensitiveKey(key: string): boolean {
  return /token|secret|password|passwd|credential|session|auth|authorization|api[_-]?key|otp|cookie|bearer/i.test(key);
}

const LABELED_SECRET_PATTERN = /\b(password|passwd|token|session(?:[_-]?string)?|api[_-]?key|apikey|secret|cookie|otp|credential)(\s*[:=]\s*|\s+)(\S.*)$/i;
const BEARER_SECRET_PATTERN = /\b((?:authorization\s*[:=]?\s*)?bearer)(\s+)(\S.*)$/i;

function sanitizeSensitiveText(text: string): string {
  return text
    .split(/\r?\n/)
    .map(line => line
      .replace(BEARER_SECRET_PATTERN, (_match, label: string, separator: string) => `${label}${separator}[REDACTED]`)
      .replace(LABELED_SECRET_PATTERN, (match, label: string, separator: string, value: string) => {
        const normalizedLabel = label.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (normalizedLabel === 'session' && /^\s*starts?\b/i.test(value)) return match;
        return `${label}${separator}[REDACTED]`;
      }))
    .join('\n');
}

function sanitizeConfig(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[nested data hidden]';
  if (typeof value === 'string') return sanitizeSensitiveText(value);
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(item => sanitizeConfig(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sensitiveKey(key) ? '[secret field hidden]' : sanitizeConfig(raw, depth + 1);
    }
    return out;
  }
  return null;
}

function sanitizeRawSignalText(raw: string | null): string | null {
  if (!raw) return null;
  return raw
    .split(/\r?\n/)
    .map(sanitizeSensitiveText)
    .join('\n');
}

function logTime(log: SupportExecutionLogRow): number {
  const time = new Date(log.created_at ?? 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function isSuccessLog(log: SupportExecutionLogRow): boolean {
  return String(log.status ?? '').toLowerCase() === 'success';
}

function latestMeaningfulOutcome(logs: SupportExecutionLogRow[]): SupportExecutionLogRow | null {
  const newestFirst = logs.slice().sort((a, b) => logTime(b) - logTime(a));
  for (const log of newestFirst) {
    const action = normalizeAction(log.action);
    if (isSuccessLog(log) && (ENTRY_SUCCESS_ACTIONS.has(action) || DEFERRED_SUCCESS_ACTIONS.has(action))) return log;
    if (isFailureStatus(log.status)) return log;
  }
  return null;
}

function tradeTime(trade: SupportTradeRow): number {
  const time = new Date(trade.opened_at ?? trade.closed_at ?? 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function successfulTradeProof(trades: SupportTradeRow[]): SupportTradeRow | null {
  return trades
    .filter(trade => TRADE_SUCCESS_STATUSES.has(String(trade.status ?? '').toLowerCase()))
    .sort((a, b) => tradeTime(b) - tradeTime(a))[0] ?? null;
}

function brokerLabelFor(id: string | null, brokers: Map<string, BrokerConfigRow>): string | null {
  return id ? brokers.get(id)?.label ?? null : null;
}

function buildAccountOutcomes(
  signal: SupportSignalRow,
  logs: SupportExecutionLogRow[],
  trades: SupportTradeRow[],
  brokerMap: Map<string, BrokerConfigRow>,
): AccountOutcome[] {
  const entryDiagnosticsByAccount = new Map<string, AccountOutcome>();
  if ((signal.skip_reason ?? '').toLowerCase() === 'entry_not_opened') {
    const item = failedSignalToErrorItem({
      id: signal.id,
      user_id: signal.user_id,
      user_display_name: null,
      status: signal.status ?? 'failed',
      skip_reason: signal.skip_reason,
      raw_message: signal.raw_message,
      parsed_data: signal.parsed_data,
      created_at: signal.created_at,
    }, logs);
    const diagnostics = item.diagnostics?.accountDiagnostics ?? [];
    diagnostics.forEach(account => {
      const key = account.broker_account_id ?? 'unknown';
      entryDiagnosticsByAccount.set(key, {
        brokerAccountId: account.broker_account_id,
        brokerLabel: account.broker_label ?? brokerLabelFor(account.broker_account_id, brokerMap),
        status: account.outcome,
        reason: account.rootCause?.reason ?? null,
        recoveryState: account.outcome === 'success'
          ? 'Recovered after retry'
          : account.outcome === 'pending'
            ? 'Deferred or pending'
            : account.outcome === 'failed'
              ? 'Latest meaningful outcome failed'
              : 'Outcome unknown',
        source: account.rootCause?.evidenceLabel ?? 'Linked execution evidence',
        createdAt: account.created_at,
      });
    });
  }

  const accountIds = new Set<string>();
  logs.forEach(log => { if (log.broker_account_id) accountIds.add(log.broker_account_id); });
  trades.forEach(trade => { if (trade.broker_account_id) accountIds.add(trade.broker_account_id); });
  entryDiagnosticsByAccount.forEach((_outcome, accountId) => { if (accountId !== 'unknown') accountIds.add(accountId); });

  if (accountIds.size === 0) {
    const proofTrade = successfulTradeProof(trades);
    return [{
      brokerAccountId: null,
      brokerLabel: null,
      status: proofTrade ? 'success' : 'unknown',
      reason: null,
      recoveryState: proofTrade ? `Trade row proves ${proofTrade.status}` : 'No linked execution evidence',
      source: proofTrade ? 'Linked trade row' : 'Signal row only',
      createdAt: proofTrade?.opened_at ?? signal.created_at,
    }];
  }

  return [...accountIds].map(accountId => {
    const accountLogs = logs.filter(log => log.broker_account_id === accountId);
    const accountTrades = trades.filter(trade => trade.broker_account_id === accountId);
    const latest = latestMeaningfulOutcome(accountLogs);
    const proofTrade = successfulTradeProof(accountTrades);
    const proofTradeTime = proofTrade ? tradeTime(proofTrade) : 0;

    if (latest) {
      const action = normalizeAction(latest.action);
      if (isSuccessLog(latest)) {
        return {
          brokerAccountId: accountId,
          brokerLabel: brokerLabelFor(accountId, brokerMap),
          status: DEFERRED_SUCCESS_ACTIONS.has(action) ? 'pending' : 'success',
          reason: null,
          recoveryState: DEFERRED_SUCCESS_ACTIONS.has(action) ? 'Deferred or pending' : 'Recovered/opened',
          source: latest.action ?? 'Execution log',
          createdAt: latest.created_at,
        };
      }
      if (proofTrade && proofTradeTime >= logTime(latest)) {
        return {
          brokerAccountId: accountId,
          brokerLabel: brokerLabelFor(accountId, brokerMap),
          status: 'success',
          reason: null,
          recoveryState: `Trade row proves ${proofTrade.status} after earlier failure`,
          source: 'Linked trade row',
          createdAt: proofTrade.opened_at ?? proofTrade.closed_at,
        };
      }
      const entryDiagnostic = entryDiagnosticsByAccount.get(accountId);
      if (entryDiagnostic) return entryDiagnostic;
      const item = executionLogToErrorItem({
        id: latest.id,
        user_id: latest.user_id,
        user_display_name: null,
        broker_account_id: latest.broker_account_id,
        broker_label: brokerLabelFor(accountId, brokerMap),
        signal_id: latest.signal_id,
        action: latest.action,
        status: latest.status,
        error_message: latest.error_message,
        request_payload: latest.request_payload,
        response_payload: latest.response_payload,
        created_at: latest.created_at ?? signal.created_at,
      });
      const display = errorDisplayForItem(item);
      return {
        brokerAccountId: accountId,
        brokerLabel: brokerLabelFor(accountId, brokerMap),
        status: 'failed',
        reason: display.reason,
        recoveryState: 'Latest meaningful outcome failed',
        source: display.evidenceLabel ?? latest.action ?? 'Execution log',
        createdAt: latest.created_at,
      };
    }

    const trade = proofTrade;
    return {
      brokerAccountId: accountId,
      brokerLabel: brokerLabelFor(accountId, brokerMap),
      status: trade ? 'success' : 'unknown',
      reason: null,
      recoveryState: trade ? `Trade row proves ${trade.status}` : 'No terminal execution evidence',
      source: trade ? 'Linked trade row' : 'Linked ids',
      createdAt: trade?.opened_at ?? null,
    };
  });
}

function supportDiagnosis(signal: SupportSignalRow, outcomes: AccountOutcome[]): string {
  if (signal.skip_reason && signal.skip_reason !== 'entry_not_opened') {
    return `Signal was skipped or failed with stored reason: ${signal.skip_reason}.`;
  }
  const failed = outcomes.filter(outcome => outcome.status === 'failed');
  if (failed.length > 0) {
    const labels = failed.map(outcome => `${outcome.brokerLabel ?? outcome.brokerAccountId ?? 'Unknown account'}: ${outcome.reason ?? 'Reason not recorded'}`);
    return `Execution needs review on ${failed.length} broker account${failed.length === 1 ? '' : 's'}: ${labels.join('; ')}.`;
  }
  const pending = outcomes.filter(outcome => outcome.status === 'pending');
  if (pending.length > 0) {
    return `Execution evidence is pending or deferred on ${pending.length} broker account${pending.length === 1 ? '' : 's'}.`;
  }
  const success = outcomes.filter(outcome => outcome.status === 'success');
  if (success.length > 0) {
    return `Execution evidence shows success or a recorded trade on ${success.length} broker account${success.length === 1 ? '' : 's'}.`;
  }
  return 'No linked trade or execution-log evidence was found for this signal in the current support page query.';
}

function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

async function fetchExecutionLogsForSignals(
  signalIds: string[],
  isCancelled: () => boolean,
): Promise<SupportExecutionLogRow[]> {
  const rows: SupportExecutionLogRow[] = [];
  for (const chunk of chunked(signalIds, LOG_FETCH_CHUNK_SIZE)) {
    for (let from = 0; ; from += LOG_FETCH_PAGE_SIZE) {
      if (isCancelled()) return [];
      const { data, error } = await adminSupabase
        .from('trade_execution_logs')
        .select('id, user_id, signal_id, broker_account_id, action, status, error_message, request_payload, response_payload, created_at')
        .in('signal_id', chunk)
        .order('created_at', { ascending: false })
        .range(from, from + LOG_FETCH_PAGE_SIZE - 1);
      if (isCancelled()) return [];
      if (error) throw error;
      const pageRows = (data ?? []) as SupportExecutionLogRow[];
      rows.push(...pageRows);
      if (pageRows.length < LOG_FETCH_PAGE_SIZE) break;
    }
  }
  return rows;
}

async function fetchTradesForSignals(
  signalIds: string[],
  isCancelled: () => boolean,
): Promise<SupportTradeRow[]> {
  const rows: SupportTradeRow[] = [];
  for (const chunk of chunked(signalIds, TRADE_FETCH_CHUNK_SIZE)) {
    for (let from = 0; ; from += TRADE_FETCH_PAGE_SIZE) {
      if (isCancelled()) return [];
      const { data, error } = await adminSupabase
        .from('trades')
        .select('id, signal_id, broker_account_id, metaapi_order_id, symbol, direction, status, entry_price, sl, tp, lot_size, opened_at, closed_at')
        .in('signal_id', chunk)
        .order('opened_at', { ascending: false, nullsFirst: false })
        .range(from, from + TRADE_FETCH_PAGE_SIZE - 1);
      if (isCancelled()) return [];
      if (error) throw error;
      const pageRows = (data ?? []) as SupportTradeRow[];
      rows.push(...pageRows);
      if (pageRows.length < TRADE_FETCH_PAGE_SIZE) break;
    }
  }
  return rows;
}

function SectionTitle({ icon: Icon, title }: { icon: LucideIcon; title: string }) {
  return (
    <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200">
      <Icon className="w-4 h-4 text-primary-500" />
      {title}
    </h3>
  );
}

function InfoPill({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg bg-slate-50 dark:bg-slate-900/50 border border-slate-100 dark:border-slate-700/60 px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
      <div className="text-sm mt-0.5 text-slate-800 dark:text-slate-100 break-words">{value ?? <span className="text-slate-400">-</span>}</div>
    </div>
  );
}

function ParsedSignalGrid({ parsed }: { parsed: ParsedSignalSummary }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
      <InfoPill label="Symbol" value={<span className="font-mono text-xs">{parsed.symbol ?? '-'}</span>} />
      <InfoPill label="Direction" value={parsed.direction ?? '-'} />
      <InfoPill label="Entry" value={<span className="font-mono text-xs">{parsed.entry ?? '-'}</span>} />
      <InfoPill label="SL" value={<span className="font-mono text-xs">{parsed.stopLoss ?? '-'}</span>} />
      <InfoPill label="TP" value={<span className="font-mono text-xs">{parsed.takeProfit ?? '-'}</span>} />
    </div>
  );
}

export function UserSupportDiagnosticsTab({ userId, summary }: UserSupportDiagnosticsTabProps) {
  const [signals, setSignals] = useState<SupportSignalRow[]>([]);
  const [signalTotal, setSignalTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [logsBySignal, setLogsBySignal] = useState<Record<string, SupportExecutionLogRow[]>>({});
  const [tradesBySignal, setTradesBySignal] = useState<Record<string, SupportTradeRow[]>>({});
  const [brokers, setBrokers] = useState<BrokerConfigRow[]>([]);
  const [channels, setChannels] = useState<ChannelConfigRow[]>([]);
  const [presets, setPresets] = useState<PresetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [configLoading, setConfigLoading] = useState(true);

  useEffect(() => { setPage(1); }, [userId]);

  useEffect(() => {
    let cancelled = false;
    setConfigLoading(true);

    (async () => {
      const [brokerResult, channelResult, presetResult] = await Promise.all([
        adminSupabase
          .from('broker_accounts')
          .select('id, label, platform, broker_name, broker_server, account_login, connection_status, is_active, copier_mode, last_balance, last_equity, last_synced_at, fxsocket_status, terminal_connected, trade_allowed, connection_error, ai_settings, manual_settings, channel_trading_configs')
          .eq('user_id', userId)
          .order('created_at', { ascending: false }),
        adminSupabase
          .from('telegram_channels')
          .select('id, display_name, channel_username, is_active, lot_size_override, pip_tolerance_override, channel_keywords, signal_channel_id, last_seen_at, last_live_at')
          .eq('user_id', userId)
          .order('last_live_at', { ascending: false, nullsFirst: false }),
        adminSupabase
          .from('channel_trading_presets')
          .select('id, name, copier_mode, manual_settings, channel_filters, updated_at')
          .eq('user_id', userId)
          .order('updated_at', { ascending: false, nullsFirst: false }),
      ]);
      if (cancelled) return;
      setBrokers((brokerResult.data ?? []) as BrokerConfigRow[]);
      setChannels((channelResult.data ?? []) as ChannelConfigRow[]);
      setPresets((presetResult.data ?? []) as PresetRow[]);
      setConfigLoading(false);
    })();

    return () => { cancelled = true; };
  }, [userId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    (async () => {
      try {
      const from = (page - 1) * SIGNAL_PAGE_SIZE;
      const to = from + SIGNAL_PAGE_SIZE - 1;
      const { data: signalRows, count, error } = await adminSupabase
        .from('signals')
        .select('id, user_id, channel_id, channel_signal_id, telegram_message_id, raw_message, parsed_data, status, skip_reason, created_at', { count: 'exact' })
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .range(from, to);

      if (cancelled) return;
      if (error) {
        setSignals([]);
        setSignalTotal(0);
        setLogsBySignal({});
        setTradesBySignal({});
        setLoading(false);
        return;
      }

      const loadedSignals = (signalRows ?? []) as SupportSignalRow[];
      const signalIds = loadedSignals.map(signal => signal.id);
      const [logRows, tradeRows] = await Promise.all([
        signalIds.length > 0
          ? fetchExecutionLogsForSignals(signalIds, () => cancelled)
          : Promise.resolve([] as SupportExecutionLogRow[]),
        signalIds.length > 0
          ? fetchTradesForSignals(signalIds, () => cancelled)
          : Promise.resolve([] as SupportTradeRow[]),
      ]);

      if (cancelled) return;
      const nextLogsBySignal: Record<string, SupportExecutionLogRow[]> = {};
      logRows.forEach(log => {
        if (!log.signal_id) return;
        nextLogsBySignal[log.signal_id] = [...(nextLogsBySignal[log.signal_id] ?? []), log];
      });
      const nextTradesBySignal: Record<string, SupportTradeRow[]> = {};
      tradeRows.forEach(trade => {
        if (!trade.signal_id) return;
        nextTradesBySignal[trade.signal_id] = [...(nextTradesBySignal[trade.signal_id] ?? []), trade];
      });

      setSignals(loadedSignals);
      setSignalTotal(count ?? 0);
      setLogsBySignal(nextLogsBySignal);
      setTradesBySignal(nextTradesBySignal);
      setLoading(false);
      } catch {
        if (cancelled) return;
        setSignals([]);
        setSignalTotal(0);
        setLogsBySignal({});
        setTradesBySignal({});
        setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [page, userId]);

  const brokerMap = useMemo(() => new Map(brokers.map(broker => [broker.id, broker])), [brokers]);
  const channelMap = useMemo(() => new Map(channels.map(channel => [channel.id, channel])), [channels]);

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <SectionTitle icon={UserRound} title="User summary" />
        </CardHeader>
        <CardContent className="p-4 space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <InfoPill label="User" value={summary.profile.display_name ?? summary.profile.user_id} />
            <InfoPill label="Plan" value={summary.subscription ? <StatusBadge status={summary.subscription.plan} /> : 'No subscription'} />
            <InfoPill label="Subscription" value={summary.subscription ? <StatusBadge status={summary.subscription.status} /> : <StatusBadge status={summary.profile.subscription_status} />} />
            <InfoPill label="Copier state" value={summary.profile.copier_paused ? <Badge variant="warning">Paused</Badge> : <Badge variant="success">Active</Badge>} />
            <InfoPill label="Telegram" value={summary.telegram ? <StatusBadge status={summary.telegram.is_online ? 'online' : 'offline'} /> : 'Not connected'} />
            <InfoPill label="Broker accounts" value={`${summary.brokers.length} stored`} />
            <InfoPill label="Channels" value={`${summary.channels.length} stored`} />
            <InfoPill label="Signals / Trades" value={`${summary.counts.signals.toLocaleString()} / ${summary.counts.trades.toLocaleString()}`} />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <InfoPill label="Profile" value={[summary.profile.first_name, summary.profile.last_name].filter(Boolean).join(' ') || summary.profile.username || summary.profile.country || '-'} />
            <InfoPill label="Telegram listener" value={summary.telegram?.worker_id ? `${summary.telegram.worker_id} (${summary.telegram.listener_engine ?? 'unknown engine'})` : summary.telegram?.listener_engine ?? '-'} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <SectionTitle icon={Settings} title="Configuration" />
        </CardHeader>
        <CardContent className="p-4 space-y-4">
          {configLoading ? (
            <div className="space-y-2">
              <div className="skeleton h-16 rounded" />
              <div className="skeleton h-16 rounded" />
            </div>
          ) : (
            <>
              <div className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Account settings</p>
                {brokers.length === 0 ? (
                  <p className="text-xs text-slate-400">No broker account configuration found.</p>
                ) : brokers.map(broker => (
                  <div key={broker.id} className="rounded-xl border border-slate-200 dark:border-slate-700 p-3 space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Server className="w-4 h-4 text-primary-500" />
                      <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{broker.label}</p>
                      <StatusBadge status={broker.connection_status} dot />
                      <span className="text-xs text-slate-400">{broker.platform ?? '-'}</span>
                    </div>
                    <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
                      <InfoPill label="Account setting: mode" value={broker.copier_mode ?? '-'} />
                      <InfoPill label="Account setting: trade allowed" value={<StatusBadge status={broker.trade_allowed} />} />
                      <InfoPill label="Account setting: terminal" value={<StatusBadge status={broker.terminal_connected} />} />
                      <InfoPill label="Stored balance" value={formatCurrency(broker.last_balance)} />
                      <InfoPill label="Stored equity" value={formatCurrency(broker.last_equity)} />
                    </div>
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                      <div>
                        <p className="text-xs font-semibold text-slate-400 mb-1">Account setting: manual settings</p>
                        <JsonViewer data={sanitizeConfig(broker.manual_settings)} />
                      </div>
                      <div>
                        <p className="text-xs font-semibold text-slate-400 mb-1">Account setting: AI settings</p>
                        <JsonViewer data={sanitizeConfig(broker.ai_settings)} />
                      </div>
                      <div>
                        <p className="text-xs font-semibold text-slate-400 mb-1">Stored setting: channel trading configs</p>
                        <JsonViewer data={sanitizeConfig(broker.channel_trading_configs)} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Channel overrides</p>
                {channels.length === 0 ? (
                  <p className="text-xs text-slate-400">No Telegram channel configuration found.</p>
                ) : channels.map(channel => (
                  <div key={channel.id} className="rounded-xl border border-slate-200 dark:border-slate-700 p-3 space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <MessageSquare className="w-4 h-4 text-primary-500" />
                      <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{channel.display_name ?? channel.channel_username ?? 'Unnamed channel'}</p>
                      <StatusBadge status={channel.is_active} />
                      {channel.last_live_at && <span className="text-xs text-slate-400">Last live {formatDate(channel.last_live_at)}</span>}
                    </div>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                      <InfoPill label="Channel override: lot" value={channel.lot_size_override ?? '-'} />
                      <InfoPill label="Channel override: pip tolerance" value={channel.pip_tolerance_override ?? '-'} />
                      <InfoPill label="Stored channel id" value={<span className="font-mono text-xs">{channel.id.slice(0, 8)}</span>} />
                      <InfoPill label="Canonical signal channel" value={<span className="font-mono text-xs">{channel.signal_channel_id?.slice(0, 8) ?? '-'}</span>} />
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-slate-400 mb-1">Stored setting: channel keywords / filters</p>
                      <JsonViewer data={sanitizeConfig(channel.channel_keywords)} />
                    </div>
                  </div>
                ))}
              </div>

              {presets.length > 0 && (
                <div className="space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Trading presets</p>
                  {presets.map(preset => (
                    <div key={preset.id} className="rounded-xl border border-slate-200 dark:border-slate-700 p-3 space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{preset.name}</p>
                        <Badge variant="muted">{preset.copier_mode ?? 'mode not recorded'}</Badge>
                        {preset.updated_at && <span className="text-xs text-slate-400">Updated {formatDate(preset.updated_at)}</span>}
                      </div>
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                        <div>
                          <p className="text-xs font-semibold text-slate-400 mb-1">Stored setting: preset manual settings</p>
                          <JsonViewer data={sanitizeConfig(preset.manual_settings)} />
                        </div>
                        <div>
                          <p className="text-xs font-semibold text-slate-400 mb-1">Stored setting: preset channel filters</p>
                          <JsonViewer data={sanitizeConfig(preset.channel_filters)} />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <p className="text-[11px] text-slate-400">
                These are stored account/channel/preset settings. This view does not label historical values as effective unless execution records prove the value used.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SectionTitle icon={Activity} title="Recent signals and execution outcome" />
            <span className="text-xs text-slate-400">{signalTotal.toLocaleString()} total signals</span>
          </div>
        </CardHeader>
        <CardContent className="p-4 space-y-4">
          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, index) => <div key={index} className="skeleton h-40 rounded-xl" />)}
            </div>
          ) : signals.length === 0 ? (
            <p className="text-sm text-slate-400">No signals found for this user.</p>
          ) : signals.map(signal => {
            const parsed = parsedSignalSummary(signal.parsed_data);
            const signalLogs = logsBySignal[signal.id] ?? [];
            const signalTrades = tradesBySignal[signal.id] ?? [];
            const outcomes = buildAccountOutcomes(signal, signalLogs, signalTrades, brokerMap);
            const channel = signal.channel_id ? channelMap.get(signal.channel_id) : null;
            const safeRaw = sanitizeRawSignalText(signal.raw_message);

            return (
              <section key={signal.id} className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={signal.status} dot />
                      <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                        {channel?.display_name ?? channel?.channel_username ?? 'Unknown channel'}
                      </p>
                    </div>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {formatDate(signal.created_at)}
                      <span className="font-mono ml-2">{signal.id.slice(0, 8)}</span>
                      {signal.telegram_message_id && <span className="font-mono ml-2">TG {signal.telegram_message_id}</span>}
                    </p>
                  </div>
                  {signal.skip_reason && (
                    <Badge variant={signal.skip_reason === 'entry_not_opened' ? 'warning' : 'error'}>
                      {signal.skip_reason}
                    </Badge>
                  )}
                </div>

                <div>
                  <p className="text-xs font-semibold text-slate-400 mb-1">Raw Telegram message</p>
                  {safeRaw ? (
                    <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950 text-slate-100 p-3 text-xs leading-relaxed border border-slate-800">
                      {safeRaw}
                    </pre>
                  ) : (
                    <p className="text-xs text-slate-400">No raw Telegram message recorded.</p>
                  )}
                </div>

                <div>
                  <p className="text-xs font-semibold text-slate-400 mb-2">Parsed interpretation</p>
                  <ParsedSignalGrid parsed={parsed} />
                </div>

                <div className="space-y-2">
                  <p className="text-xs font-semibold text-slate-400">Execution outcome by broker account</p>
                  {outcomes.map((outcome, index) => (
                    <div key={`${outcome.brokerAccountId ?? 'unknown'}-${index}`} className="rounded-lg bg-slate-50 dark:bg-slate-900/50 border border-slate-100 dark:border-slate-700/60 px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                          {outcome.brokerLabel ?? outcome.brokerAccountId ?? 'Unknown broker account'}
                        </p>
                        <StatusBadge status={outcome.status} dot />
                        <span className="text-[10px] text-slate-400">{outcome.recoveryState}</span>
                        {outcome.createdAt && <span className="text-[10px] text-slate-400 ml-auto">{formatDate(outcome.createdAt)}</span>}
                      </div>
                      {outcome.reason && <p className="text-xs text-slate-600 dark:text-slate-300 mt-1">{outcome.reason}</p>}
                      <p className="text-[10px] text-slate-400 mt-1">Evidence: {outcome.source}</p>
                    </div>
                  ))}
                </div>

                {signalTrades.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-slate-400">Linked trades</p>
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
                      {signalTrades.map(trade => (
                        <div key={trade.id} className="rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-semibold text-slate-700 dark:text-slate-200">{trade.symbol ?? '-'}</span>
                            <StatusBadge status={trade.status} dot />
                            <span>{trade.direction ?? '-'}</span>
                            <span className="font-mono text-slate-400">{trade.metaapi_order_id ?? 'No ticket'}</span>
                          </div>
                          <p className="mt-1 text-slate-500 dark:text-slate-400">
                            Entry {trade.entry_price ?? '-'} / SL {trade.sl ?? '-'} / TP {trade.tp ?? '-'} / Lots {trade.lot_size ?? '-'}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2">
                  <p className="text-xs font-semibold text-slate-400 mb-1 flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    Support diagnosis
                  </p>
                  <p className="text-sm text-slate-700 dark:text-slate-200 leading-relaxed">{supportDiagnosis(signal, outcomes)}</p>
                </div>
              </section>
            );
          })}
        </CardContent>
        <Pagination
          page={page}
          totalPages={Math.max(1, Math.ceil(signalTotal / SIGNAL_PAGE_SIZE))}
          totalCount={signalTotal}
          pageSize={SIGNAL_PAGE_SIZE}
          onPageChange={setPage}
        />
      </Card>
    </div>
  );
}
