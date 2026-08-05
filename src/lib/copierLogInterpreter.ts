export type LogVerdict = 'success' | 'error' | 'warning' | 'info';

export interface InterpretedField {
  key: string;
  label: string;
  value: unknown;
}

export interface LogInterpretation {
  actionMeaning: string;
  statusMeaning: string;
  verdict: LogVerdict;
  skipReason: string | null;
  errorPlain: string | null;
  requestFields: InterpretedField[];
  responseFields: InterpretedField[];
  rawRequest: unknown;
  rawResponse: unknown;
}

export interface CopierLogLike {
  action: string;
  status: string;
  error_message: string | null;
  request_payload: unknown;
  response_payload: unknown;
}

const ACTION_DESCRIPTIONS: Record<string, string> = {
  order_send: 'Sent the order to the broker',
  dispatch_push_attempt: 'Attempted to push the signal into the execution queue',
  dispatch_skipped: 'Skipped pushing the signal into the execution queue',
  mgmt_close: 'Management instruction to close position(s)',
  mgmt_breakeven: 'Management instruction to move the stop loss to breakeven',
  mgmt_skip: 'Management instruction was skipped',
  mgmt_range_leg_followup: 'Management follow-up on a range-trade leg',
  basket_leg_modify: 'Modified one leg of a basket of trades',
  merge_anchor_selected: 'Selected the anchor trade used to merge a reply-chain',
  merge_modify_summary: 'Recorded the summary of a merged modification',
  merge_routed_modify_only: 'Routed the instruction as a modify-only merge',
  parse_shadow_diff: 'Detected a difference between shadow parse results',
  pipeline_summary: 'Summary of the signal\u2019s end-to-end pipeline timing',
  range_basket_tp_rebalance: 'Rebalanced take-profit targets across a range basket',
  range_broker_pending_inserted: 'Inserted a broker-side pending order for a range trade',
  v2_reconcile_tick: 'Reconciliation sweep tick',
  virtual_pending_cancelled: 'Cancelled a virtual pending order',
  virtual_pending_fired: 'Fired a virtual pending order into execution',
  virtual_pending_inserted: 'Registered a virtual pending order',
};

const STATUS_MEANINGS: Record<string, string> = {
  success: 'The broker/engine accepted the request.',
  failed: 'The broker/engine rejected or could not complete the request.',
  error: 'An error occurred while processing the instruction.',
  skipped: 'No action was taken for this instruction.',
};

const SKIP_REASON_HUMAN: Record<string, string> = {
  mgmt_no_open_trades_db: 'No open trades were found in the database for this user.',
  duplicate_provider_signal: 'A duplicate signal from the provider was ignored.',
  mgmt_basket_not_found: 'The basket of trades the instruction referred to was not found.',
  dispatch_queue_full: 'The execution queue was not accepting this dispatch.',
};

const ERROR_HUMAN_PATTERNS: { pattern: RegExp; text: string }[] = [
  { pattern: /unknown ticket/i, text: 'The broker referenced a ticket that cannot be tracked for this account — the position may have been closed already or opened elsewhere.' },
  { pattern: /not enough money|insufficient funds|not enough funds/i, text: 'The account did not have enough balance to place the order.' },
  { pattern: /requote/i, text: 'The broker returned a requote instead of accepting the order at the requested price.' },
  { pattern: /market.*closed|closed.*market/i, text: 'The market was closed for this symbol at the time of execution.' },
  { pattern: /invalid volume/i, text: 'The requested volume is outside the broker\u2019s allowed range.' },
  { pattern: /invalid price/i, text: 'The broker rejected the provided price as invalid or off-market.' },
  { pattern: /too many requests|rate limit/i, text: 'The broker throttled the request (rate limit).' },
  { pattern: /timeout/i, text: 'The request timed out waiting for the broker\u2019s response.' },
  { pattern: /invalid symbol/i, text: 'The symbol is not listed on this broker account.' },
];

const REQUEST_FIELD_LABELS: Record<string, string> = {
  action: 'Instruction',
  mgmt_action: 'Management action',
  operation: 'Operation',
  symbol: 'Symbol',
  trade_symbol: 'Trade symbol',
  signal_symbol: 'Signal symbol',
  broker_symbol: 'Broker symbol',
  deterministic_symbol: 'Resolved symbol',
  universal_symbol: 'Universal symbol',
  price: 'Reference price',
  trigger_price: 'Trigger price',
  volume: 'Volume (lots)',
  slippage: 'Max slippage',
  stoploss: 'Stop loss',
  takeprofit: 'Take profit',
  desired_sl: 'Desired SL',
  desired_tp: 'Desired TP',
  target_sl: 'Target SL',
  target_tp: 'Target TP',
  ticket: 'Ticket',
  comment: 'Comment',
  expertID: 'Expert ID',
  metaapi_account_id: 'MetaApi account',
  base_url: 'Broker base URL',
  max_attempts: 'Max attempts',
  attempt: 'Attempt',
  reason: 'Reason',
  failure_reason: 'Failure reason',
  skip_reason: 'Skip reason',
  leg: 'Leg',
  leg_index: 'Leg index',
  mgmt_scope: 'Management scope',
  anchor_signal_id: 'Anchor signal',
  basket_anchor_signal_id: 'Basket anchor signal',
  basket_signal_id: 'Basket signal',
  mgmt_parent_signal_id: 'Parent signal',
  parent_signal_id: 'Parent signal',
};

const RESPONSE_FIELD_LABELS: Record<string, string> = {
  ok: 'OK',
  ticket: 'Ticket',
  price: 'Base price',
  fill_price: 'Fill price',
  latency_ms: 'Broker latency',
  pipeline_ms: 'Pipeline time',
  total: 'Total legs',
  leg: 'Leg',
  status_code: 'Status code',
  tickets: 'Tickets',
  retryable: 'Retryable',
  transient: 'Transient',
  attempted: 'Attempted',
  failed: 'Failed',
  closed: 'Closed',
  modified: 'Modified',
  any_opened: 'Opened any',
  opened_naked: 'Opened naked',
  modifyFailed: 'Modify failed',
  skippedNoTicket: 'Skipped: no ticket',
  skippedNotOnBroker: 'Skipped: not on broker',
  skippedUnfixable: 'Skipped: unfixable',
  failure_reason: 'Failure reason',
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function humanizeSkipReason(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  return SKIP_REASON_HUMAN[trimmed] ?? trimmed;
}

function humanizeError(value: string | null): string | null {
  if (!value || !value.trim()) return null;
  for (const { pattern, text } of ERROR_HUMAN_PATTERNS) {
    if (pattern.test(value)) return text;
  }
  return value.trim();
}

function pickFields(payload: unknown, labels: Record<string, string>): InterpretedField[] {
  const rec = asRecord(payload);
  if (!rec) return [];
  const out: InterpretedField[] = [];
  for (const [key, label] of Object.entries(labels)) {
    if (key in rec && rec[key] !== null && rec[key] !== undefined && rec[key] !== '') {
      out.push({ key, label, value: rec[key] });
    }
  }
  return out;
}

function verdictFor(status: string, skipReason: string | null, errorPlain: string | null): LogVerdict {
  const s = status.toLowerCase();
  if (s === 'success') return 'success';
  if (s === 'failed' || s === 'error' || errorPlain) return 'error';
  if (s === 'skipped' || skipReason) return 'warning';
  return 'info';
}

export function interpretCopierLog(log: CopierLogLike): LogInterpretation {
  const request = asRecord(log.request_payload);
  const skipRaw = request?.skip_reason ?? request?.reason ?? null;
  const skipReason = typeof skipRaw === 'string' && skipRaw.length > 0 ? humanizeSkipReason(skipRaw) : null;
  const errorPlain = humanizeError(log.error_message);
  const status = log.status ?? '';

  return {
    actionMeaning: ACTION_DESCRIPTIONS[log.action] ?? log.action,
    statusMeaning: STATUS_MEANINGS[status] ?? 'Status recorded by the engine.',
    verdict: verdictFor(status, skipReason, errorPlain),
    skipReason,
    errorPlain,
    requestFields: pickFields(log.request_payload, REQUEST_FIELD_LABELS),
    responseFields: pickFields(log.response_payload, RESPONSE_FIELD_LABELS),
    rawRequest: log.request_payload,
    rawResponse: log.response_payload,
  };
}