export type ErrorSource = 'execution' | 'signal' | 'broker' | 'dead_letter';

export type ErrorSeverity = 'transient' | 'major';

export interface SeverityClassification {
  severity: ErrorSeverity;
  reason: string;
}

export interface ErrorItem {
  id: string;
  source: ErrorSource;
  categoryKey: string;
  categoryLabel: string;
  user_id: string | null;
  user_display_name: string | null;
  trade_context: string | null;
  cause: string | null;
  detail: unknown;
  raw_message?: string | null;
  signal_id: string | null;
  broker_account_id: string | null;
  broker_label: string | null;
  attempts?: number | null;
  created_at: string | null;
}

const MAJOR_PATTERNS: RegExp[] = [
  /invalid stops/i,
  /invalid/i,
  /rejected/i,
  /denied/i,
  /not found/i,
  /insufficient/i,
  /forbidden/i,
  /unauthorized/i,
  /\b401\b/i,
  /\b403\b/i,
  /\b404\b/i,
  /expired/i,
  /unknown symbol/i,
  /authentication/i,
  /not subscribed/i,
  /margin/i,
  /wrong symbol/i,
  /no access/i,
  /credentials/i,
  /unknown ticket/i,
  /no_broker_channel_match/i,
  /not configured/i,
  /unconfigured/i,
  /misconfigured/i,
  /banned/i,
  /blocked/i,
  /not enough money/i,
  /not enough free/i,
];

const TRANSIENT_PATTERNS: RegExp[] = [
  /timeout/i,
  /timed out/i,
  /temporary/i,
  /transient/i,
  /rate limit/i,
  /too many/i,
  /http 50[0-9]/i,
  /\b500\b/i,
  /\b502\b/i,
  /\b503\b/i,
  /\b504\b/i,
  /service unavailable/i,
  /network/i,
  /connection reset/i,
  /socket hang/i,
  /econnreset/i,
  /econnrefused/i,
  /busy/i,
  /maintenance/i,
  /no response/i,
  /did not respond/i,
  /retry/i,
  /throttled/i,
  /\b429\b/i,
  /queue full/i,
  /backpressure/i,
  /internet/i,
  /reconnect/i,
];

export function classifyErrorSeverity(message: string | null | undefined): SeverityClassification {
  const text = (message ?? '').trim();
  if (!text) {
    return { severity: 'major', reason: 'No error message recorded — treated as major until reviewed.' };
  }
  const major = MAJOR_PATTERNS.find(p => p.test(text));
  if (major) {
    return { severity: 'major', reason: `Matched permanent-failure pattern: ${String(major)}` };
  }
  const transient = TRANSIENT_PATTERNS.find(p => p.test(text));
  if (transient) {
    return { severity: 'transient', reason: `Matched retryable pattern: ${String(transient)}` };
  }
  return { severity: 'major', reason: 'No known retryable pattern — treated as major until reviewed.' };
}

export const ACTION_LABELS: Record<string, string> = {
  order_send: 'Order send',
  dispatch_push_attempt: 'Queue push attempt',
  dispatch_skipped: 'Dispatch skipped',
  mgmt_close: 'Management close',
  mgmt_breakeven: 'Management breakeven',
  mgmt_skip: 'Management skip',
  mgmt_range_leg_followup: 'Range leg follow-up',
  basket_leg_modify: 'Basket leg modify',
  merge_anchor_selected: 'Merge anchor selected',
  merge_modify_summary: 'Merge summary',
  merge_routed_modify_only: 'Merge modify-only',
  parse_shadow_diff: 'Shadow parse diff',
  pipeline_summary: 'Pipeline summary',
  range_basket_tp_rebalance: 'Range basket TP rebalance',
  range_broker_pending_inserted: 'Range pending insert',
  v2_reconcile_tick: 'Reconciliation tick',
  virtual_pending_cancelled: 'Virtual pending cancel',
  virtual_pending_fired: 'Virtual pending fire',
  virtual_pending_inserted: 'Virtual pending insert',
  partial_tp_fired: 'Partial TP fired',
  modify_sl: 'Modify stop loss',
  modify_tp: 'Modify take profit',
  close_trade: 'Close trade',
  open_trade: 'Open trade',
  trailing_stop: 'Trailing stop',
  auto_be: 'Auto breakeven',
  breakeven: 'Breakeven',
  cancel_pending: 'Cancel pending',
};

export function actionLabel(action: string | null | undefined): string {
  const a = (action ?? '').trim();
  if (!a) return 'Unknown action';
  return ACTION_LABELS[a] ?? a.replace(/_/g, ' ');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== 'object') return null;
  return value as Record<string, unknown>;
}

function firstString(record: Record<string, unknown> | null, ...keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return null;
}

/** When an execution row has no error_message, the failure reason may still be
 *  embedded in the request_payload — summary actions like mgmt_modify_broker_summary
 *  write skip_reasons there instead of a top-level message. */
function causeFromRequestPayload(payload: unknown): string | null {
  const record = asRecord(payload);
  if (!record) return null;
  const skipReasons = record.skip_reasons;
  if (Array.isArray(skipReasons)) {
    const first = skipReasons.find(s => typeof s === 'string' && s.trim());
    if (first) return first.trim();
  }
  return firstString(record, 'skipped_reason', 'skip_reason', 'failure_reason', 'reason', 'error');
}

/** Best-effort human label for the trade a failed step was about. */
export function extractTradeContext(detail: unknown, raw_message: string | null | undefined): string | null {
  const record = asRecord(detail);
  const payload = asRecord(record?.request_payload);
  const symbol = firstString(record, 'symbol', 'symbol_orig', 'instrument')
    ?? firstString(payload, 'symbol', 'symbol_orig', 'instrument');
  const direction = firstString(record, 'direction', 'side', 'action')
    ?? firstString(payload, 'direction', 'side', 'action');
  const ticket = firstString(record, 'ticket', 'metaapi_order_id', 'order_id', 'deal_id')
    ?? firstString(payload, 'ticket', 'metaapi_order_id', 'order_id', 'deal_id');
  const parts: string[] = [];
  if (symbol) parts.push(String(symbol).toUpperCase());
  if (direction && !['buy', 'sell'].includes(String(direction).toLowerCase())) {
    // direction key may actually hold a non-side value; only include if it looks like a side
  } else if (direction) {
    parts.push(String(direction).toLowerCase());
  }
  if (ticket) parts.push(`#${ticket}`);
  if (parts.length === 0 && raw_message) {
    const m = raw_message.match(/XAUUSD|XAGUSD|EURUSD|GBPUSD|BTCUSD|USDJPY|US30|NAS100|GER40|SPX500/i);
    if (m) parts.push(m[0]);
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

export const SOURCE_LABELS: Record<ErrorSource, string> = {
  execution: 'Execution',
  signal: 'Signal',
  broker: 'Broker',
  dead_letter: 'Dead letter',
};

export function categoryOf(source: ErrorSource, action: string | null | undefined): { key: string; label: string } {
  if (source === 'execution') {
    return { key: `action:${action ?? 'unknown'}`, label: actionLabel(action) };
  }
  if (source === 'signal') return { key: 'signal_failed', label: 'Signal parse failed' };
  if (source === 'broker') return { key: 'broker_connection', label: 'Broker connection error' };
  return { key: 'dead_letter', label: 'Dead letter (retries exhausted)' };
}

export interface ExecutionLogLike {
  id: string;
  user_id: string | null;
  user_display_name: string | null;
  broker_account_id: string | null;
  broker_label: string | null;
  signal_id: string | null;
  action: string | null;
  status: string;
  error_message: string | null;
  request_payload: unknown;
  response_payload: unknown;
  created_at: string;
}

export function executionLogToErrorItem(r: ExecutionLogLike): ErrorItem {
  const detail = { action: r.action, request_payload: r.request_payload, response_payload: r.response_payload };
  const { key, label } = categoryOf('execution', r.action);
  const cause = (r.error_message ?? '').trim() || causeFromRequestPayload(r.request_payload);
  return {
    id: r.id,
    source: 'execution',
    categoryKey: key,
    categoryLabel: label,
    user_id: r.user_id,
    user_display_name: r.user_display_name,
    trade_context: extractTradeContext(detail, null),
    cause,
    detail,
    signal_id: r.signal_id,
    broker_account_id: r.broker_account_id,
    broker_label: r.broker_label,
    created_at: r.created_at,
  };
}

export interface FailedSignalLike {
  id: string;
  user_id: string | null;
  user_display_name: string | null;
  status: string;
  skip_reason: string | null;
  raw_message: string | null;
  parsed_data: unknown;
  created_at: string;
}

export function failedSignalToErrorItem(r: FailedSignalLike): ErrorItem {
  const parsed = (r.parsed_data ?? {}) as Record<string, unknown>;
  const verification = parsed._verification as { final?: { skip_reason?: string | null } } | null;
  const cause = r.skip_reason ?? verification?.final?.skip_reason ?? null;
  return {
    id: r.id,
    source: 'signal',
    categoryKey: 'signal_failed',
    categoryLabel: 'Signal parse failed',
    user_id: r.user_id,
    user_display_name: r.user_display_name,
    trade_context: extractTradeContext(r.parsed_data, r.raw_message),
    cause,
    detail: r.parsed_data,
    raw_message: r.raw_message,
    signal_id: r.id,
    broker_account_id: null,
    broker_label: null,
    created_at: r.created_at,
  };
}

const FAILED_STATUSES = new Set(['failed', 'error']);

export function isFailureStatus(status: string | null | undefined): boolean {
  return FAILED_STATUSES.has(String(status ?? '').toLowerCase());
}
