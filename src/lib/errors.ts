import { classifyBrokerError } from './brokerErrors';

export type ErrorSource = 'execution' | 'signal' | 'broker' | 'dead_letter';

export type ErrorSeverity = 'transient' | 'major';

export interface SeverityClassification {
  severity: ErrorSeverity;
  reason: string;
}

export interface StructuredFailure {
  reasonCode: string | null;
  category: string | null;
  title: string | null;
  explanation: string | null;
  recommendedAction: string | null;
  retryable: boolean | null;
  userActionRequired: boolean | null;
  safeContext: Record<string, string | number | boolean | null>;
}

export type RootCauseEvidence =
  | 'structured_trade_failure'
  | 'structured_reason_code'
  | 'explicit_failure_reason'
  | 'normalized_broker_error'
  | 'execution_error_message'
  | 'legacy_fallback';

export interface ErrorRootCause {
  status: string;
  stage: string;
  reason: string;
  explanation: string;
  recommendedAction: string | null;
  retryable: boolean | null;
  userActionRequired: boolean | null;
  safeContext: Record<string, string | number | boolean | null>;
  evidence: RootCauseEvidence;
  evidenceLabel: string;
  sourceLogId: string | null;
  created_at: string | null;
}

export interface AccountDiagnostic {
  broker_account_id: string | null;
  broker_label: string | null;
  outcome: 'success' | 'failed' | 'pending' | 'unknown';
  rootCause: ErrorRootCause | null;
  created_at: string | null;
}

export interface DiagnosticTraceStep {
  label: string;
  state: 'success' | 'failed' | 'pending' | 'unknown';
  detail: string | null;
}

export interface ErrorDiagnostics {
  rootCause: ErrorRootCause;
  accountDiagnostics: AccountDiagnostic[];
  trace: DiagnosticTraceStep[];
  selectionRule: string;
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
  structured_failure?: StructuredFailure | null;
  diagnostics?: ErrorDiagnostics | null;
}

export interface ErrorDisplay {
  title: string;
  reason: string;
  explanation: string;
  nextAction: string | null;
  evidenceLabel: string | null;
  causeKey: string;
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

export function classifyErrorItemSeverity(item: Pick<ErrorItem, 'cause' | 'structured_failure' | 'diagnostics'>): SeverityClassification {
  if (item.diagnostics?.rootCause.retryable === false) {
    return { severity: 'major', reason: 'Root-cause metadata marks this event as non-retryable.' };
  }
  if (item.diagnostics?.rootCause.retryable === true) {
    return { severity: 'transient', reason: 'Root-cause metadata marks this event as retryable.' };
  }
  if (item.structured_failure?.retryable === false) {
    return { severity: 'major', reason: 'Structured failure metadata marks this event as non-retryable.' };
  }
  if (item.structured_failure?.retryable === true) {
    return { severity: 'transient', reason: 'Structured failure metadata marks this event as retryable.' };
  }
  return classifyErrorSeverity(item.cause);
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

function normalizeKey(reason: string | null | undefined): string {
  return String(reason ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function safeText(value: unknown, maxLength = 500): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/\s+/g, ' ');
  if (!text) return null;
  return text.slice(0, maxLength);
}

function safeReasonCode(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : null;
  if (!text || !/^[A-Z0-9_:-]{2,100}$/.test(text)) return null;
  return text;
}

function safeLegacyReasonKey(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : null;
  if (!text || !/^[a-zA-Z0-9_:-]{2,100}$/.test(text)) return null;
  if (isSensitiveContextKey(text)) return null;
  return text;
}

function safeBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function isSensitiveContextKey(key: string): boolean {
  return /token|secret|password|credential|session|auth|authorization|key|phone|otp|hash|cookie|bearer/i.test(key);
}

const SAFE_CONTEXT_KEYS = new Set([
  'accountlabel',
  'action',
  'brokerlabel',
  'brokername',
  'brokersymbol',
  'category',
  'direction',
  'entry',
  'latencyms',
  'lotsize',
  'marketstate',
  'ordertype',
  'price',
  'reasoncode',
  'requestedsymbol',
  'retryafterms',
  'side',
  'sl',
  'stage',
  'status',
  'symbol',
  'timeoutms',
  'tp',
  'usersymbol',
]);

function safeContext(value: unknown): Record<string, string | number | boolean | null> {
  const record = asRecord(value);
  if (!record) return {};

  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (!/^[a-zA-Z0-9_]{1,40}$/.test(key)) continue;
    if (isSensitiveContextKey(key)) continue;
    if (!SAFE_CONTEXT_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''))) continue;
    if (typeof raw === 'string') out[key] = safeText(raw, 160);
    else if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw;
    else if (typeof raw === 'boolean' || raw === null) out[key] = raw;
  }
  return out;
}

function structuredCandidateFrom(payload: unknown): Record<string, unknown> | null {
  const root = asRecord(payload);
  if (!root) return null;

  const nested = asRecord(root.trade_failure) ?? asRecord(root.tradeFailure);
  if (nested) return { ...root, ...nested };

  if (root.reason_code != null || root.reasonCode != null) return root;
  return null;
}

export function extractStructuredFailure(...payloads: unknown[]): StructuredFailure | null {
  for (const payload of payloads) {
    const candidate = structuredCandidateFrom(payload);
    if (!candidate) continue;

    const reasonCode = safeReasonCode(candidate.reason_code ?? candidate.reasonCode);
    const title = safeText(candidate.title, 140);
    const explanation = safeText(candidate.explanation, 800);
    const recommendedAction = safeText(candidate.recommendedAction ?? candidate.recommended_action, 500);
    const category = safeText(candidate.category, 100);
    const retryable = safeBoolean(candidate.retryable);
    const userActionRequired = safeBoolean(candidate.userActionRequired ?? candidate.user_action_required);
    const context = safeContext(candidate.safeContext ?? candidate.safe_context);

    if (!reasonCode && !title && !explanation && !recommendedAction) continue;

    return {
      reasonCode,
      category,
      title,
      explanation,
      recommendedAction,
      retryable,
      userActionRequired,
      safeContext: context,
    };
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

function explicitFailureReason(...payloads: unknown[]): string | null {
  for (const payload of payloads) {
    const record = asRecord(payload);
    const reason = firstString(record, 'failure_reason', 'failureReason', 'skip_reason', 'skipReason', 'skipped_reason', 'skippedReason');
    if (reason) return reason;
  }
  return null;
}

function structuredCause(structured: StructuredFailure | null): string | null {
  return structured?.reasonCode ?? structured?.title ?? null;
}

type RootCauseContext = 'entry' | 'execution';

function actionKey(action: string | null | undefined): string {
  return normalizeKey(action);
}

const ENTRY_SUCCESS_ACTIONS = new Set([
  'order_send',
  'open_trade',
  'virtual_pending_fired',
]);

const DEFERRED_SUCCESS_ACTIONS = new Set([
  'virtual_pending_inserted',
  'range_broker_pending_inserted',
]);

const PLANNING_ACTIONS = new Set([
  'dispatch_push_attempt',
  'order_send',
  'open_trade',
  'virtual_pending_inserted',
  'range_broker_pending_inserted',
]);

const BROKER_ATTEMPT_ACTIONS = new Set([
  'order_send',
  'open_trade',
  'virtual_pending_fired',
]);

function isFailedStatus(status: string | null | undefined): boolean {
  return ['failed', 'error'].includes(String(status ?? '').toLowerCase());
}

function isSuccessStatus(status: string | null | undefined): boolean {
  return String(status ?? '').toLowerCase() === 'success';
}

function isMeaningfulEntrySuccess(log: EntryExecutionLogLike): boolean {
  if (!isSuccessStatus(log.status)) return false;
  const action = actionKey(log.action);
  return ENTRY_SUCCESS_ACTIONS.has(action) || DEFERRED_SUCCESS_ACTIONS.has(action);
}

function isDeferredSuccess(log: EntryExecutionLogLike): boolean {
  return isSuccessStatus(log.status) && DEFERRED_SUCCESS_ACTIONS.has(actionKey(log.action));
}

interface OperationFallback {
  title: string;
  stage: string;
  explanation: string;
  nextAction: string | null;
}

function operationFallback(context: RootCauseContext, action?: string | null): OperationFallback {
  const key = actionKey(action);
  if (context === 'entry') {
    return {
      title: 'No position opened',
      stage: 'Broker execution',
      explanation: 'The signal was processed but the stored execution record does not contain enough information to identify why no broker position was opened.',
      nextAction: 'Review linked execution attempts and broker account state.',
    };
  }
  if (key.includes('reconcile')) {
    return {
      title: 'Trade reconciliation failed',
      stage: 'Reconciliation',
      explanation: 'TScopier attempted to reconcile stored trade state with broker state, but this older execution record did not preserve the exact rejection or mismatch reason.',
      nextAction: 'Review the linked trade, broker account state, and latest reconciliation attempt.',
    };
  }
  if (key.includes('basket') && (key.includes('tp') || key.includes('sl') || key.includes('sync') || key.includes('rebalance') || key.includes('modify'))) {
    return {
      title: 'Basket protection sync failed',
      stage: 'Basket protection sync',
      explanation: 'TScopier attempted to synchronize basket stop-loss or take-profit protection, but this older execution record did not preserve the broker rejection reason.',
      nextAction: 'Review the basket trades and broker account state before changing protection levels.',
    };
  }
  if (key === 'order_send' || key === 'open_trade' || key === 'virtual_pending_fired') {
    return {
      title: 'Order send failed',
      stage: 'Broker execution',
      explanation: 'TScopier attempted to send an order to the broker, but this older execution record did not preserve the broker rejection reason.',
      nextAction: 'Review the linked execution attempt and broker account state.',
    };
  }
  if (key === 'order_close' || key === 'close_trade' || key.includes('close')) {
    return {
      title: 'Trade close failed',
      stage: 'Close execution',
      explanation: 'TScopier attempted to close an existing trade, but this older execution record did not preserve the broker rejection reason.',
      nextAction: 'Confirm the broker ticket still exists and review the account state.',
    };
  }
  if (key === 'mgmt_modify' || key === 'mgmt_modify_broker_summary' || key.startsWith('mgmt_') || key.includes('management')) {
    return {
      title: 'Management modification failed',
      stage: 'Management execution',
      explanation: 'TScopier attempted to update an existing trade or basket, but this older execution record did not preserve the broker rejection reason.',
      nextAction: 'Review the linked execution attempts and current broker account state.',
    };
  }
  if (key === 'order_modify' || key.includes('modify') || key.includes('sl') || key.includes('tp') || key.includes('trailing')) {
    return {
      title: 'Trade modification failed',
      stage: 'Management execution',
      explanation: 'TScopier attempted to modify an existing trade, but this older execution record did not preserve the broker rejection reason.',
      nextAction: 'Review the current broker ticket, SL/TP values, and account state.',
    };
  }
  if (key.includes('sync')) {
    return {
      title: 'Synchronization failed',
      stage: 'Synchronization',
      explanation: 'TScopier attempted to synchronize trade state, but this older execution record did not preserve the exact failure reason.',
      nextAction: 'Review the linked trade and broker account state.',
    };
  }
  return {
    title: 'Execution failed',
    stage: 'Execution',
    explanation: 'TScopier recorded an execution failure, but this older record did not preserve the exact reason.',
    nextAction: 'Review linked execution attempts and account state.',
  };
}

function statusForContext(context: RootCauseContext, action?: string | null): string {
  return operationFallback(context, action).title;
}

function stageFromAction(action: string | null | undefined, context: RootCauseContext): string {
  return operationFallback(context, action).stage;
}

function titleFromReasonCode(reasonCode: string): string {
  return reasonCode
    .toLowerCase()
    .replace(/^broker_/, '')
    .replace(/^signal_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function knownReasonTitle(normalizedCode: string, reasonCode: string): string {
  if (['broker_symbol_not_found', 'symbol_not_found', 'broker_symbol_select_failed'].includes(normalizedCode)) return 'Symbol not found';
  if (['invalid_stops', 'broker_invalid_stops', 'broker_stops_rejected', 'stops_rejected'].includes(normalizedCode)) return 'Invalid stops';
  if (['signal_missing_required_sl', 'missing_required_sl', 'stop_loss_missing'].includes(normalizedCode)) return 'Stop loss missing';
  if (['insufficient_margin', 'broker_insufficient_margin', 'insufficient_funds'].includes(normalizedCode)) return 'Insufficient margin';
  if (['market_closed', 'broker_market_closed'].includes(normalizedCode)) return 'Market closed';
  if (['trading_disabled', 'broker_trading_disabled', 'trade_not_allowed'].includes(normalizedCode)) return 'Trading disabled';
  if (['unknown_ticket', 'broker_unknown_ticket'].includes(normalizedCode)) return 'Unknown ticket';
  if (['no_broker_session', 'broker_session_unavailable', 'broker_verification_failed', 'broker_verification_failure'].includes(normalizedCode)) return 'Broker session unavailable';
  if (['http_5xx', 'broker_http_5xx', 'broker_server_error'].includes(normalizedCode)) return 'HTTP 5xx';
  if (['rate_limit', 'broker_rate_limit', 'too_many_requests'].includes(normalizedCode)) return 'Rate limited';
  if (['broker_timeout', 'timeout', 'broker_request_timeout'].includes(normalizedCode)) return 'Broker timeout';
  return titleFromReasonCode(reasonCode);
}

function knownReasonExplanation(normalizedCode: string): string {
  if (['broker_symbol_not_found', 'symbol_not_found', 'broker_symbol_select_failed'].includes(normalizedCode)) {
    return 'The requested instrument was not available on this broker account under a recognized symbol.';
  }
  if (['invalid_stops', 'broker_invalid_stops', 'broker_stops_rejected', 'stops_rejected'].includes(normalizedCode)) {
    return 'The broker rejected the requested stop-loss or take-profit levels for this execution action.';
  }
  if (['signal_missing_required_sl', 'missing_required_sl', 'stop_loss_missing'].includes(normalizedCode)) {
    return 'The signal did not include the required stop loss value for this product rule or account configuration.';
  }
  if (['insufficient_margin', 'broker_insufficient_margin', 'insufficient_funds'].includes(normalizedCode)) {
    return 'The broker account did not have enough free margin to open the requested position.';
  }
  if (['market_closed', 'broker_market_closed'].includes(normalizedCode)) {
    return 'The broker market for this instrument was closed when execution was attempted.';
  }
  if (['trading_disabled', 'broker_trading_disabled', 'trade_not_allowed'].includes(normalizedCode)) {
    return 'The broker account or terminal was not allowed to trade at the time of execution.';
  }
  if (['unknown_ticket', 'broker_unknown_ticket'].includes(normalizedCode)) {
    return 'The broker did not recognize the ticket referenced by the execution action.';
  }
  if (['no_broker_session', 'broker_session_unavailable', 'broker_verification_failed', 'broker_verification_failure'].includes(normalizedCode)) {
    return 'The broker session was unavailable or could not be verified when execution was attempted.';
  }
  if (['http_5xx', 'broker_http_5xx', 'broker_server_error'].includes(normalizedCode)) {
    return 'The broker platform returned a server-side HTTP error during execution.';
  }
  if (['rate_limit', 'broker_rate_limit', 'too_many_requests'].includes(normalizedCode)) {
    return 'The broker or bridge throttled the request.';
  }
  if (['broker_timeout', 'timeout', 'broker_request_timeout'].includes(normalizedCode)) {
    return 'The broker request did not complete before the timeout recorded by the execution layer.';
  }
  return 'A structured reason code was recorded, but no more specific explanation was stored with it.';
}

function knownReasonAction(normalizedCode: string): string | null {
  if (['broker_symbol_not_found', 'symbol_not_found', 'broker_symbol_select_failed'].includes(normalizedCode)) {
    return 'Check the account/channel symbol mapping for this broker account.';
  }
  if (['invalid_stops', 'broker_invalid_stops', 'broker_stops_rejected', 'stops_rejected'].includes(normalizedCode)) {
    return 'Review the requested SL/TP against broker stop-distance and current-price rules.';
  }
  if (['signal_missing_required_sl', 'missing_required_sl', 'stop_loss_missing'].includes(normalizedCode)) {
    return 'Review the signal source and only configure a fallback stop loss if product rules allow it.';
  }
  if (['insufficient_margin', 'broker_insufficient_margin', 'insufficient_funds'].includes(normalizedCode)) {
    return 'Ask the user to reduce risk or add funds before retrying new entries.';
  }
  if (['market_closed', 'broker_market_closed'].includes(normalizedCode)) {
    return 'Wait until the market is open, then process a new valid signal.';
  }
  if (['trading_disabled', 'broker_trading_disabled', 'trade_not_allowed'].includes(normalizedCode)) {
    return 'Confirm the account is connected and automated trading is enabled.';
  }
  if (['unknown_ticket', 'broker_unknown_ticket'].includes(normalizedCode)) {
    return 'Confirm the broker ticket still exists before retrying the management action.';
  }
  if (['no_broker_session', 'broker_session_unavailable', 'broker_verification_failed', 'broker_verification_failure'].includes(normalizedCode)) {
    return 'Reconnect or verify the broker account before retrying.';
  }
  return null;
}

function displayKey(title: string, reason: string): string {
  return `${normalizeKey(title) || 'unknown'}:${normalizeKey(reason) || 'unknown'}`;
}

export function errorDisplayForItem(item: ErrorItem): ErrorDisplay {
  const rootCause = item.diagnostics?.rootCause ?? null;
  if (rootCause) {
    return {
      title: rootCause.status,
      reason: rootCause.reason,
      explanation: rootCause.explanation,
      nextAction: rootCause.recommendedAction,
      evidenceLabel: rootCause.evidenceLabel,
      causeKey: displayKey(rootCause.status, rootCause.reason),
    };
  }

  if (item.structured_failure) {
    const reason = item.structured_failure.title
      ?? item.structured_failure.reasonCode
      ?? 'Structured trade failure';
    const title = item.categoryLabel || 'Execution failed';
    return {
      title,
      reason,
      explanation: item.structured_failure.explanation ?? 'Structured failure metadata was recorded, but no detailed explanation was stored.',
      nextAction: item.structured_failure.recommendedAction,
      evidenceLabel: 'Structured trade_failure',
      causeKey: displayKey(title, reason),
    };
  }

  const broker = classifyBrokerError(item.cause);
  if (broker.category !== 'other') {
    const root = rootCauseFromBrokerError(item.cause ?? broker.label, null, item.created_at, 'execution', null);
    const title = item.categoryLabel || 'Broker error';
    return {
      title,
      reason: broker.label,
      explanation: root?.explanation ?? 'The error matched a known broker failure category.',
      nextAction: root?.recommendedAction ?? null,
      evidenceLabel: 'Normalized broker error',
      causeKey: displayKey(title, broker.label),
    };
  }

  const safeExplicit = safeLegacyReasonKey(item.cause);
  const reason = safeExplicit ? titleFromReasonCode(safeExplicit) : 'Reason not recorded';
  const title = item.categoryLabel || SOURCE_LABELS[item.source];
  return {
    title,
    reason,
    explanation: 'The stored admin row identifies what failed, but it does not contain a safe normalized root cause.',
    nextAction: 'Review the linked source record and account state before taking action.',
    evidenceLabel: safeExplicit ? 'Explicit failure_reason / skip_reason' : 'Reason not recorded',
    causeKey: displayKey(title, reason),
  };
}

function rootCauseFromReasonCode(
  reasonCode: string,
  structured: StructuredFailure | null,
  sourceLogId: string | null,
  createdAt: string | null,
  context: RootCauseContext,
  action: string | null | undefined,
): ErrorRootCause {
  const code = normalizeKey(reasonCode);
  const hasStructuredCopy = Boolean(structured?.title || structured?.explanation || structured?.recommendedAction);

  return {
    status: statusForContext(context, action),
    stage: code.startsWith('signal_') ? 'Signal validation' : stageFromAction(action, context),
    reason: structured?.title ?? knownReasonTitle(code, reasonCode),
    explanation: structured?.explanation ?? knownReasonExplanation(code),
    recommendedAction: structured?.recommendedAction ?? knownReasonAction(code),
    retryable: structured?.retryable ?? null,
    userActionRequired: structured?.userActionRequired ?? null,
    safeContext: structured?.safeContext ?? {},
    evidence: hasStructuredCopy ? 'structured_trade_failure' : 'structured_reason_code',
    evidenceLabel: hasStructuredCopy ? 'Structured trade_failure' : 'Structured reason_code',
    sourceLogId,
    created_at: createdAt,
  };
}

function rootCauseFromStructuredFailure(
  structured: StructuredFailure,
  sourceLogId: string | null,
  createdAt: string | null,
  context: RootCauseContext,
  action: string | null | undefined,
): ErrorRootCause {
  if (structured.reasonCode) {
    return rootCauseFromReasonCode(structured.reasonCode, structured, sourceLogId, createdAt, context, action);
  }

  return {
    status: statusForContext(context, action),
    stage: structured.category?.toLowerCase().includes('signal') ? 'Signal validation' : stageFromAction(action, context),
    reason: structured.title ?? 'Trade execution failed',
    explanation: structured.explanation ?? 'Structured failure metadata was recorded, but no detailed explanation was stored.',
    recommendedAction: structured.recommendedAction,
    retryable: structured.retryable,
    userActionRequired: structured.userActionRequired,
    safeContext: structured.safeContext,
    evidence: 'structured_trade_failure',
    evidenceLabel: 'Structured trade_failure',
    sourceLogId,
    created_at: createdAt,
  };
}

function rootCauseFromBrokerError(message: string, sourceLogId: string | null, createdAt: string | null, context: RootCauseContext, action: string | null | undefined): ErrorRootCause | null {
  const broker = classifyBrokerError(message);
  if (broker.category === 'other') return null;

  const explanation = (() => {
    if (broker.category === 'symbol_select_failed') return 'The broker did not expose the requested instrument under a recognized symbol.';
    if (broker.category === 'margin') return 'The broker account did not have enough free margin or funds to open or manage the trade.';
    if (broker.category === 'market_closed') return 'The broker market was closed for this instrument when execution was attempted.';
    if (broker.category === 'stops_rejected') return 'The broker rejected the stop loss or take profit levels for this order.';
    if (broker.category === 'trading_disabled') return 'The broker account or terminal was not allowed to trade at the time of execution.';
    if (broker.category === 'account_unavailable') return 'The broker account was unavailable or not logged in when execution was attempted.';
    if (broker.category === 'http_5xx') return 'The broker platform returned a server-side HTTP error during execution.';
    if (broker.category === 'timeout') return 'The broker or bridge did not respond before the execution request timed out.';
    if (broker.category === 'rate_limit') return 'The broker or bridge throttled the request.';
    if (broker.category === 'unknown_ticket') return 'The broker did not recognize the ticket referenced by the execution action.';
    return 'The broker error matched a known normalized category.';
  })();

  const recommendedAction = (() => {
    if (broker.category === 'symbol_select_failed') return 'Check the account/channel symbol mapping for this broker account.';
    if (broker.category === 'margin') return 'Ask the user to reduce risk or add funds before retrying new entries.';
    if (broker.category === 'market_closed') return 'Wait until the market is open, then process a new valid signal.';
    if (broker.category === 'stops_rejected') return 'Review the requested SL/TP against the broker stop-distance rules.';
    if (broker.category === 'trading_disabled') return 'Confirm the account is connected and automated trading is enabled.';
    if (broker.category === 'account_unavailable') return 'Reconnect the broker account and confirm the terminal is logged in.';
    return null;
  })();

  return {
    status: statusForContext(context, action),
    stage: stageFromAction(action, context),
    reason: broker.label,
    explanation,
    recommendedAction,
    retryable: broker.retryable,
    userActionRequired: broker.severity === 'major',
    safeContext: {},
    evidence: 'normalized_broker_error',
    evidenceLabel: 'Normalized broker error',
    sourceLogId,
    created_at: createdAt,
  };
}

function categoryFromStructuredFailure(structured: StructuredFailure | null, fallback: { key: string; label: string }): { key: string; label: string } {
  if (!structured) return fallback;
  const keyPart = normalizeKey(structured.reasonCode ?? structured.category ?? structured.title ?? 'structured_trade_failure') || 'structured_trade_failure';
  return {
    key: `trade_failure:${keyPart}`,
    label: structured.title ?? (structured.reasonCode ? knownReasonTitle(normalizeKey(structured.reasonCode), structured.reasonCode) : structured.category) ?? 'Trade execution failed',
  };
}

function hasParseFailureEvidence(cause: string | null, parsedData: unknown): boolean {
  const key = normalizeKey(cause);
  if (['parse_failed', 'signal_parse_failed', 'parser_failed', 'signal_parser_failed'].includes(key)) return true;

  const parsed = asRecord(parsedData);
  const stage = normalizeKey(firstString(parsed, 'failed_stage', 'failure_stage'));
  if (stage === 'parse' || stage === 'parser' || stage === 'signal_parse') return true;

  const errorType = normalizeKey(firstString(parsed, 'error_type', 'failure_type'));
  return ['parse_failed', 'signal_parse_failed', 'parser_failed', 'parse_error'].includes(errorType);
}

function hasParseSuccessEvidence(parsedData: unknown): boolean {
  const parsed = asRecord(parsedData);
  if (!parsed) return false;
  const verification = asRecord(parsed._verification);
  if (!verification) return false;
  return asRecord(verification.final) != null
    || asRecord(verification.deterministic) != null
    || asRecord(verification.stage2) != null
    || asRecord(verification.stage3) != null;
}

function categoryFromSignalFailure(cause: string | null, parsedData: unknown): { key: string; label: string } {
  if (hasParseFailureEvidence(cause, parsedData)) {
    return { key: 'signal_parse_failed', label: 'Signal parse failed' };
  }
  if (normalizeKey(cause) === 'entry_not_opened') {
    return { key: 'signal_entry_not_opened', label: 'No position opened' };
  }
  if (cause?.trim()) {
    return { key: 'signal_failed', label: 'Signal failed' };
  }
  return { key: 'signal_failed_unknown', label: 'Signal failed' };
}

function rootCauseFromLegacyFallback(sourceLogId: string | null, createdAt: string | null, context: RootCauseContext = 'entry', action?: string | null): ErrorRootCause {
  const fallback = operationFallback(context, action);
  return {
    status: fallback.title,
    stage: fallback.stage,
    reason: 'Reason not recorded',
    explanation: fallback.explanation,
    recommendedAction: fallback.nextAction,
    retryable: null,
    userActionRequired: null,
    safeContext: {},
    evidence: 'legacy_fallback',
    evidenceLabel: 'Reason not recorded',
    sourceLogId,
    created_at: createdAt,
  };
}

export interface EntryExecutionLogLike {
  id: string;
  broker_account_id: string | null;
  broker_label: string | null;
  action: string | null;
  status: string;
  error_message: string | null;
  request_payload: unknown;
  response_payload: unknown;
  created_at: string | null;
}

function rootCauseFromExecutionLog(log: EntryExecutionLogLike, context: RootCauseContext = 'execution'): ErrorRootCause | null {
  if (!isFailedStatus(log.status)) return null;

  const structured = extractStructuredFailure(log.request_payload, log.response_payload);
  if (structured) return rootCauseFromStructuredFailure(structured, log.id, log.created_at, context, log.action);

  const reasonCode = firstString(asRecord(log.request_payload), 'reason_code', 'reasonCode')
    ?? firstString(asRecord(log.response_payload), 'reason_code', 'reasonCode');
  if (reasonCode && safeReasonCode(reasonCode)) {
    return rootCauseFromReasonCode(reasonCode, null, log.id, log.created_at, context, log.action);
  }

  const explicitReason = explicitFailureReason(log.request_payload, log.response_payload);
  const safeExplicitReason = safeLegacyReasonKey(explicitReason);
  if (safeExplicitReason && normalizeKey(safeExplicitReason) !== 'entry_not_opened') {
    const brokerRoot = rootCauseFromBrokerError(safeExplicitReason, log.id, log.created_at, context, log.action);
    return brokerRoot ?? {
      status: statusForContext(context, log.action),
      stage: normalizeKey(safeExplicitReason).startsWith('signal_') ? 'Signal validation' : 'Execution planning',
      reason: titleFromReasonCode(safeExplicitReason),
      explanation: 'The execution layer recorded this explicit failure or skip reason for the signal.',
      recommendedAction: null,
      retryable: null,
      userActionRequired: null,
      safeContext: {},
      evidence: 'explicit_failure_reason',
      evidenceLabel: 'Explicit failure_reason / skip_reason',
      sourceLogId: log.id,
      created_at: log.created_at,
    };
  }

  if (log.error_message?.trim()) {
    const errorMessage = log.error_message.trim();
    return rootCauseFromBrokerError(errorMessage, log.id, log.created_at, context, log.action)
      ?? rootCauseFromLegacyFallback(log.id, log.created_at, context, log.action);
  }

  return rootCauseFromLegacyFallback(log.id, log.created_at, context, log.action);
}

function logTime(log: EntryExecutionLogLike): number {
  const ms = new Date(log.created_at ?? 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function compareNewest(a: EntryExecutionLogLike, b: EntryExecutionLogLike): number {
  return logTime(b) - logTime(a);
}

function accountKey(log: EntryExecutionLogLike): string {
  return log.broker_account_id ?? 'unknown';
}

interface AccountTerminalOutcome {
  outcome: 'success' | 'failed' | 'pending';
  rootCause: ErrorRootCause | null;
  log: EntryExecutionLogLike;
}

function latestMeaningfulAccountOutcome(groupLogs: EntryExecutionLogLike[]): AccountTerminalOutcome | null {
  const newestFirst = groupLogs.slice().sort(compareNewest);
  for (const log of newestFirst) {
    if (isMeaningfulEntrySuccess(log)) {
      return {
        outcome: isDeferredSuccess(log) ? 'pending' : 'success',
        rootCause: null,
        log,
      };
    }
    if (isFailedStatus(log.status)) {
      return {
        outcome: 'failed',
        rootCause: rootCauseFromExecutionLog(log, 'entry') ?? rootCauseFromLegacyFallback(log.id, log.created_at, 'entry'),
        log,
      };
    }
  }
  return null;
}

function buildTrace(
  rootCause: ErrorRootCause,
  logs: EntryExecutionLogLike[],
  signalStatus: string | null,
  signalCause: string | null,
  parsedData: unknown,
): DiagnosticTraceStep[] {
  const parserFailed = hasParseFailureEvidence(signalCause, parsedData);
  const parserSucceeded = hasParseSuccessEvidence(parsedData);
  const plannedLog = logs.find(log => PLANNING_ACTIONS.has(actionKey(log.action)));
  const deferredLog = logs.find(isDeferredSuccess);
  const brokerAttemptLog = logs.find(log => BROKER_ATTEMPT_ACTIONS.has(actionKey(log.action)) && (isSuccessStatus(log.status) || isFailedStatus(log.status)));
  const latestTerminal = latestMeaningfulAccountOutcome(logs);
  const outcomeState: DiagnosticTraceStep['state'] = rootCause.status === 'Recovered after retry'
    ? 'success'
    : rootCause.status === 'Deferred pending registered' || rootCause.status === 'Recovered with pending accounts' || latestTerminal?.outcome === 'pending'
      ? 'pending'
      : 'failed';

  return [
    { label: 'Signal received', state: signalStatus ? 'success' : 'unknown', detail: signalStatus ? `status: ${signalStatus}` : 'signal row status not recorded' },
    {
      label: 'Signal parsed',
      state: parserFailed ? 'failed' : parserSucceeded ? 'success' : 'unknown',
      detail: parserFailed ? 'parser failure evidence recorded' : parserSucceeded ? 'verification chain recorded' : 'parser outcome not recorded',
    },
    {
      label: deferredLog ? 'Deferred pending registered' : 'Execution planned',
      state: deferredLog || plannedLog ? 'success' : 'unknown',
      detail: deferredLog ? 'waiting for price or pending trigger' : plannedLog ? actionLabel(plannedLog.action) : 'planning evidence not recorded',
    },
    {
      label: 'Broker attempted',
      state: brokerAttemptLog ? (rootCause.stage === 'Broker execution' && rootCause.status !== 'Recovered after retry' ? 'failed' : 'success') : 'unknown',
      detail: brokerAttemptLog ? actionLabel(brokerAttemptLog.action) : 'broker-attempt evidence not recorded',
    },
    {
      label: 'Outcome',
      state: outcomeState,
      detail: rootCause.status === 'Recovered after retry' && latestTerminal
        ? `${rootCause.status}; latest terminal status: ${latestTerminal.log.status}`
        : rootCause.status,
    },
  ];
}

export function extractEntryNotOpenedDiagnostics(
  signal: Pick<FailedSignalLike, 'status' | 'skip_reason' | 'parsed_data' | 'created_at'>,
  linkedExecutionLogs: EntryExecutionLogLike[],
): ErrorDiagnostics {
  const parsed = (signal.parsed_data ?? {}) as Record<string, unknown>;
  const verification = parsed._verification as { final?: { skip_reason?: string | null } } | null;
  const signalCause = signal.skip_reason ?? verification?.final?.skip_reason ?? null;
  const sortedLogs = linkedExecutionLogs.slice().sort(compareNewest);
  const grouped = new Map<string, EntryExecutionLogLike[]>();

  for (const log of sortedLogs) {
    const group = grouped.get(accountKey(log)) ?? [];
    group.push(log);
    grouped.set(accountKey(log), group);
  }

  const accountDiagnostics: AccountDiagnostic[] = [...grouped.values()].map(groupLogs => {
    const latest = groupLogs[0];
    const terminal = latestMeaningfulAccountOutcome(groupLogs);
    return {
      broker_account_id: latest?.broker_account_id ?? null,
      broker_label: latest?.broker_label ?? null,
      outcome: terminal?.outcome ?? 'unknown',
      rootCause: terminal?.rootCause ?? null,
      created_at: terminal?.log.created_at ?? latest?.created_at ?? null,
    };
  });

  const failedAccounts = accountDiagnostics.filter(a => a.outcome === 'failed' && a.rootCause);
  const successfulAccounts = accountDiagnostics.filter(a => a.outcome === 'success');
  const pendingAccounts = accountDiagnostics.filter(a => a.outcome === 'pending');
  let rootCause: ErrorRootCause;

  if (failedAccounts.length === 1 && failedAccounts[0].rootCause) {
    rootCause = failedAccounts[0].rootCause;
  } else if (failedAccounts.length > 1) {
    const uniqueReasons = new Set(failedAccounts.map(a => a.rootCause?.reason).filter(Boolean));
    const firstRoot = failedAccounts[0].rootCause ?? rootCauseFromLegacyFallback(null, signal.created_at, 'entry');
    rootCause = {
      ...firstRoot,
      reason: uniqueReasons.size === 1 ? firstRoot.reason : `${failedAccounts.length} broker accounts failed`,
      explanation: uniqueReasons.size === 1
        ? firstRoot.explanation
        : `${failedAccounts.length} linked broker accounts recorded different failure reasons. Review the account-level diagnostics below for the exact cause on each account.`,
      recommendedAction: uniqueReasons.size === 1 ? firstRoot.recommendedAction : 'Review each failed broker account separately before taking action.',
    };
  } else if (pendingAccounts.length > 0) {
    rootCause = {
      status: successfulAccounts.length > 0 ? 'Recovered with pending accounts' : 'Deferred pending registered',
      stage: 'Execution outcome',
      reason: successfulAccounts.length > 0 ? 'Some broker accounts recovered; some are pending' : 'Deferred pending registered',
      explanation: 'The latest meaningful linked execution evidence includes deferred-pending entry outcomes. This is not a completed broker-open success until a later entry fire or order-send success is recorded.',
      recommendedAction: null,
      retryable: null,
      userActionRequired: null,
      safeContext: {},
      evidence: 'legacy_fallback',
      evidenceLabel: 'Latest meaningful terminal outcome',
      sourceLogId: null,
      created_at: signal.created_at,
    };
  } else if (successfulAccounts.length > 0) {
    rootCause = {
      status: 'Recovered after retry',
      stage: 'Execution outcome',
      reason: successfulAccounts.length === 1 ? 'Recovered after retry' : `${successfulAccounts.length} broker accounts recovered`,
      explanation: 'The latest meaningful linked execution evidence is completed entry success. Older failed attempts are retained as history but do not define the current account outcome.',
      recommendedAction: null,
      retryable: null,
      userActionRequired: null,
      safeContext: {},
      evidence: 'legacy_fallback',
      evidenceLabel: 'Latest meaningful terminal outcome',
      sourceLogId: null,
      created_at: signal.created_at,
    };
  } else {
    rootCause = rootCauseFromLegacyFallback(null, signal.created_at, 'entry');
  }

  return {
    rootCause,
    accountDiagnostics,
    trace: buildTrace(rootCause, sortedLogs, signal.status, signalCause, signal.parsed_data),
    selectionRule: 'For each broker account, admin sorts linked trade_execution_logs by created_at descending and uses the latest meaningful terminal outcome: known success/deferred entry actions or failed/error rows. Later success/deferred outcomes supersede older failures; later failures supersede older failures. Informational rows are ignored.',
  };
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
  if (source === 'signal') return { key: 'signal_failed', label: 'Signal failed' };
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
  const structured = extractStructuredFailure(r.request_payload, r.response_payload);
  const rootCause = rootCauseFromExecutionLog(r);
  const { key, label } = categoryFromStructuredFailure(structured, categoryOf('execution', r.action));
  const legacyCause = (r.error_message ?? '').trim() || causeFromRequestPayload(r.request_payload);
  const cause = rootCause?.reason ?? structuredCause(structured) ?? legacyCause;
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
    structured_failure: structured,
    diagnostics: rootCause
      ? {
        rootCause,
        accountDiagnostics: [{
          broker_account_id: r.broker_account_id,
          broker_label: r.broker_label,
          outcome: 'failed',
          rootCause,
          created_at: r.created_at,
        }],
        trace: [
          { label: 'Signal received', state: r.signal_id ? 'success' : 'unknown', detail: r.signal_id ? null : 'no linked signal_id' },
          { label: 'Execution log recorded', state: 'success', detail: r.action ? actionLabel(r.action) : null },
          { label: 'Outcome', state: 'failed', detail: rootCause.status },
        ],
        selectionRule: 'Execution-log rows use their own request_payload, response_payload, reason_code, skip/failure reason, broker classification, and error_message in that order.',
      }
      : null,
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

export function failedSignalToErrorItem(r: FailedSignalLike, linkedExecutionLogs: EntryExecutionLogLike[] = []): ErrorItem {
  const parsed = (r.parsed_data ?? {}) as Record<string, unknown>;
  const verification = parsed._verification as { final?: { skip_reason?: string | null } } | null;
  const signalCause = r.skip_reason ?? verification?.final?.skip_reason ?? null;
  const diagnostics = normalizeKey(signalCause) === 'entry_not_opened'
    ? extractEntryNotOpenedDiagnostics(r, linkedExecutionLogs)
    : null;
  const cause = diagnostics?.rootCause.reason ?? signalCause;
  const { key, label } = categoryFromSignalFailure(signalCause, r.parsed_data);
  return {
    id: r.id,
    source: 'signal',
    categoryKey: key,
    categoryLabel: label,
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
    structured_failure: null,
    diagnostics,
  };
}

const FAILED_STATUSES = new Set(['failed', 'error']);

export function isFailureStatus(status: string | null | undefined): boolean {
  return FAILED_STATUSES.has(String(status ?? '').toLowerCase());
}
