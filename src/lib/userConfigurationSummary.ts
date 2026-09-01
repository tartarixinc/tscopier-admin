export interface UserConfigurationBroker {
  id: string;
  label: string | null;
  platform: string | null;
  broker_name: string | null;
  copier_mode: string | null;
  trade_allowed: boolean | null;
  manual_settings: unknown;
  ai_settings: unknown;
  channel_trading_configs: unknown;
}

export interface UserConfigurationTrade {
  broker_account_id: string | null;
  lot_size: number | null;
}

export interface UserConfigurationExecutionLog {
  action: string;
  status: string;
  request_payload: unknown;
  response_payload: unknown;
  broker_account_id?: string | null;
  created_at: string | null;
}

export interface UserConfigurationSignal {
  channel_id: string | null;
  channel_signal_id: string | null;
  parsed_data: unknown;
  skip_reason: string | null;
}

export type UserConfigurationSource = 'Execution data' | 'Broker account' | 'Account setting' | 'AI settings' | 'Channel override';
export type UserConfigurationTone = 'success' | 'warning' | 'error' | 'muted';

export interface UserConfigurationItem {
  label: string;
  value: string;
  source: UserConfigurationSource;
  tone?: UserConfigurationTone;
  priority: number;
}

export interface UserConfigurationSummary {
  brokerLabel: string | null;
  brokerPlatform: string | null;
  items: UserConfigurationItem[];
}

interface ConfigHit {
  key: string;
  value: unknown;
}

const SENSITIVE_KEY_RE = /token|secret|password|passwd|credential|session|auth|authorization|api[_-]?key|otp|cookie|bearer/i;
const MAX_DEPTH = 5;
const MAX_ITEMS = 10;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function cleanText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'Enabled' : 'Disabled';
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  if (!text) return null;
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function titleCase(value: string): string {
  return value.replace(/\b[a-z]/g, char => char.toUpperCase());
}

export function formatConfigBoolean(value: unknown, mode: 'enabled' | 'yes' = 'enabled'): string | null {
  if (typeof value !== 'boolean') return null;
  if (mode === 'yes') return value ? 'Yes' : 'No';
  return value ? 'Enabled' : 'Disabled';
}

function formatConfigValue(value: unknown, label: string): string | null {
  if (typeof value === 'boolean') {
    return formatConfigBoolean(value, /allowed|required|optional/i.test(label) ? 'yes' : 'enabled');
  }
  const text = cleanText(value);
  if (!text) return null;
  if (/mode|behavior|source|platform|broker/i.test(label)) return titleCase(text);
  return text;
}

function findConfigHit(value: unknown, aliases: readonly string[], depth = 0): ConfigHit | null {
  if (depth > MAX_DEPTH || value == null) return null;
  const aliasSet = new Set(aliases.map(normalizeKey));
  const record = asRecord(value);
  if (record) {
    for (const [key, raw] of Object.entries(record)) {
      if (SENSITIVE_KEY_RE.test(key)) continue;
      if (aliasSet.has(normalizeKey(key))) return { key, value: raw };
    }
    for (const [key, raw] of Object.entries(record)) {
      if (SENSITIVE_KEY_RE.test(key)) continue;
      const found = findConfigHit(raw, aliases, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const raw of value) {
      const found = findConfigHit(raw, aliases, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function findConfigValue(value: unknown, aliases: readonly string[], depth = 0): unknown {
  return findConfigHit(value, aliases, depth)?.value;
}

function firstRenderedValue(value: unknown, aliases: readonly string[], label: string): string | null {
  return formatConfigValue(findConfigValue(value, aliases), label);
}

function firstRenderedHit(value: unknown, aliases: readonly string[], label: string): { value: string; raw: unknown; key: string } | null {
  const hit = findConfigHit(value, aliases);
  const rendered = formatConfigValue(hit?.value, label);
  return hit && rendered ? { value: rendered, raw: hit.value, key: hit.key } : null;
}

function firstLotHit(value: unknown, aliases: readonly string[]): { value: string; raw: unknown; key: string } | null {
  const hit = findConfigHit(value, aliases);
  const rendered = formatLotValue(hit?.value);
  return hit && rendered ? { value: rendered, raw: hit.value, key: hit.key } : null;
}

function firstRiskHit(value: unknown, aliases: readonly string[]): { value: string; raw: unknown; key: string } | null {
  const hit = findConfigHit(value, aliases);
  const rendered = hit ? formatRiskValue(hit.value, hit.key) : null;
  return hit && rendered ? { value: rendered, raw: hit.value, key: hit.key } : null;
}

function channelOverrideRoot(value: unknown, signal: UserConfigurationSignal | null): unknown {
  if (!signal) return null;
  const ids = [signal.channel_id, signal.channel_signal_id].filter((id): id is string => Boolean(id));
  if (ids.length === 0) return null;

  const record = asRecord(value);
  if (record) {
    for (const id of ids) {
      if (record[id] != null) return record[id];
    }
    for (const raw of Object.values(record)) {
      const candidate = asRecord(raw);
      if (!candidate) continue;
      const candidateIds = [
        candidate.channel_id,
        candidate.telegram_channel_id,
        candidate.signal_channel_id,
        candidate.id,
      ].map(item => typeof item === 'string' ? item : null);
      if (candidateIds.some(id => id != null && ids.includes(id))) return candidate;
    }
  }

  if (Array.isArray(value)) {
    for (const raw of value) {
      const candidate = asRecord(raw);
      if (!candidate) continue;
      const candidateIds = [
        candidate.channel_id,
        candidate.telegram_channel_id,
        candidate.signal_channel_id,
        candidate.id,
      ].map(item => typeof item === 'string' ? item : null);
      if (candidateIds.some(id => id != null && ids.includes(id))) return candidate;
    }
  }

  return null;
}

function parsedSignalFocus(signal: UserConfigurationSignal | null): Set<string> {
  const text = [
    signal?.skip_reason,
    cleanText(asRecord(signal?.parsed_data)?.reason_code),
    cleanText(asRecord(signal?.parsed_data)?.reasonCode),
  ].filter(Boolean).join(' ').toLowerCase();
  const focus = new Set<string>();
  if (/entry|range|price/.test(text)) focus.add('entry');
  if (/sl|stop/.test(text)) focus.add('stop');
  if (/ai|manual|review|uncertain|parse/.test(text)) focus.add('ai');
  return focus;
}

function item(
  label: string,
  value: string | null,
  source: UserConfigurationSource,
  priority: number,
  tone?: UserConfigurationTone,
): UserConfigurationItem | null {
  if (!value) return null;
  return { label, value, source, priority, tone };
}

function isNumericValue(value: unknown): value is number | string {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string') return false;
  return value.trim() !== '' && Number.isFinite(Number(value));
}

function formatNumberValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function formatLotValue(value: unknown): string | null {
  if (!isNumericValue(value)) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return `${formatNumberValue(numeric)} lots`;
}

function formatRiskValue(value: unknown, key: string): string | null {
  if (!isNumericValue(value)) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  const formatted = formatNumberValue(numeric);
  return /percent|percentage|pct/i.test(key) ? `${formatted}%` : formatted;
}

function toneForBooleanText(value: string | null, positiveGood = true): UserConfigurationTone | undefined {
  if (!value) return undefined;
  const positive = value === 'Enabled' || value === 'Yes';
  return positive === positiveGood ? 'success' : 'warning';
}

const LOT_ALIASES = [
  'lot_size',
  'lotSize',
  'lots',
  'lot',
  'volume',
  'order_volume',
  'orderVolume',
  'calculated_lot',
  'calculatedLot',
  'calculated_lot_size',
  'calculatedLotSize',
  'final_lot_size',
  'finalLotSize',
  'effective_lot_size',
  'effectiveLotSize',
  'trade_lot_size',
  'tradeLotSize',
];

const RISK_ALIASES = [
  'risk_percent',
  'riskPercent',
  'risk_percentage',
  'riskPercentage',
  'risk_pct',
  'riskPct',
  'risk_value',
  'riskValue',
  'risk_used',
  'riskUsed',
  'applied_risk_percent',
  'appliedRiskPercent',
  'calculated_risk_percent',
  'calculatedRiskPercent',
  'effective_risk_percent',
  'effectiveRiskPercent',
];

function executionHits(logs: UserConfigurationExecutionLog[] | undefined, aliases: readonly string[]): ConfigHit[] {
  if (!logs || logs.length === 0) return [];
  const priorityLogs = [...logs].sort((a, b) => {
    const aRelevant = /open|order|send|dispatch|execute|entry/i.test(a.action) ? 0 : 1;
    const bRelevant = /open|order|send|dispatch|execute|entry/i.test(b.action) ? 0 : 1;
    if (aRelevant !== bRelevant) return aRelevant - bRelevant;
    const aSuccess = a.status === 'success' ? 0 : 1;
    const bSuccess = b.status === 'success' ? 0 : 1;
    if (aSuccess !== bSuccess) return aSuccess - bSuccess;
    return new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime();
  });

  const hits: ConfigHit[] = [];
  for (const log of priorityLogs) {
    const requestHit = findConfigHit(log.request_payload, aliases);
    if (requestHit) hits.push(requestHit);
    const responseHit = findConfigHit(log.response_payload, aliases);
    if (responseHit) hits.push(responseHit);
  }
  return hits;
}

function firstExecutionHit(logs: UserConfigurationExecutionLog[] | undefined, aliases: readonly string[]): ConfigHit | null {
  return executionHits(logs, aliases)[0] ?? null;
}

function equivalentValue(left: unknown, right: unknown): boolean {
  if (isNumericValue(left) && isNumericValue(right)) return Math.abs(Number(left) - Number(right)) < 0.000001;
  return String(left ?? '').trim().toLowerCase() === String(right ?? '').trim().toLowerCase();
}

function sourceForExecutionValue(executionValue: unknown, channelHit: { raw: unknown } | null): UserConfigurationSource {
  return channelHit && equivalentValue(executionValue, channelHit.raw) ? 'Channel override' : 'Execution data';
}

export function buildUserConfigurationSummary(
  broker: UserConfigurationBroker | null,
  signal: UserConfigurationSignal | null,
  evidence?: {
    trade?: UserConfigurationTrade | null;
    executionLogs?: UserConfigurationExecutionLog[];
  },
): UserConfigurationSummary {
  if (!broker) return { brokerLabel: null, brokerPlatform: null, items: [] };

  const manual = broker.manual_settings;
  const ai = broker.ai_settings;
  const channelOverride = channelOverrideRoot(broker.channel_trading_configs, signal);
  const focus = parsedSignalFocus(signal);
  const stopBoost = focus.has('stop') ? -20 : 0;
  const entryBoost = focus.has('entry') ? -20 : 0;
  const aiBoost = focus.has('ai') ? -20 : 0;

  const tradeAllowed = formatConfigBoolean(broker.trade_allowed, 'yes');
  const lotExecutionHit = firstExecutionHit(evidence?.executionLogs, LOT_ALIASES);
  const lotFromTrade = formatLotValue(evidence?.trade?.lot_size);
  const lotFromExecution = lotFromTrade ?? formatLotValue(lotExecutionHit?.value);
  const channelLot = firstLotHit(channelOverride, ['lot_size_override', 'lotSizeOverride', 'fixed_lot_size', 'fixedLotSize', 'lot_size', 'lotSize']);
  const accountLot = firstLotHit(manual, ['fixed_lot_size', 'fixedLotSize', 'lot_size', 'lotSize', 'default_lot_size', 'defaultLotSize']);
  const lotSource = lotFromExecution
    ? sourceForExecutionValue(evidence?.trade?.lot_size ?? lotExecutionHit?.value, channelLot)
    : channelLot
      ? 'Channel override'
      : 'Account setting';

  const riskExecutionHit = firstExecutionHit(evidence?.executionLogs, RISK_ALIASES);
  const riskFromExecution = riskExecutionHit ? formatRiskValue(riskExecutionHit.value, riskExecutionHit.key) : null;
  const channelRisk = firstRiskHit(channelOverride, ['risk_percent', 'riskPercent', 'risk_percentage', 'riskPercentage', 'risk_pct', 'riskPct']);
  const accountRisk = firstRiskHit(manual, ['risk_percent', 'riskPercent', 'risk_percentage', 'riskPercentage', 'risk_pct', 'riskPct']);
  const riskSource = riskFromExecution
    ? sourceForExecutionValue(riskExecutionHit?.value, channelRisk)
    : channelRisk
      ? 'Channel override'
      : 'Account setting';

  const channelRange = firstRenderedHit(channelOverride, ['range_trading_enabled', 'rangeTradingEnabled', 'allow_range_trading', 'range_trading', 'range_mode'], 'Range trading');
  const channelSl = firstRenderedHit(channelOverride, ['sl_required', 'require_sl', 'requireStopLoss', 'stop_loss_required', 'stopLossRequired'], 'Stop loss required');
  const channelLayering = firstRenderedHit(channelOverride, ['layering_mode', 'layeringMode', 'layer_mode', 'layerMode', 'layering', 'split_tp', 'splitTp', 'tp_layers', 'tpLayers'], 'Layering mode');
  const channelTp = firstRenderedHit(channelOverride, ['tp_mode', 'tpMode', 'take_profit_mode', 'takeProfitMode', 'take_profit_behavior', 'takeProfitBehavior'], 'Take profit behavior');
  const channelBreakeven = firstRenderedHit(channelOverride, ['breakeven_enabled', 'breakevenEnabled', 'auto_be', 'autoBE', 'autoBreakeven', 'move_sl_to_be', 'moveSlToBE'], 'Breakeven');
  const channelTrailing = firstRenderedHit(channelOverride, ['trailing_stop_enabled', 'trailingStopEnabled', 'trailing_stop', 'trailingStop', 'trailing'], 'Trailing stop');
  const channelCopyLimit = firstRenderedHit(channelOverride, ['copy_limit', 'copyLimit', 'max_positions', 'maxPositions', 'max_open_trades', 'maxOpenTrades'], 'Copy limit');
  const rangeTrading = channelRange?.value
    ?? firstRenderedValue(manual, ['range_trading_enabled', 'rangeTradingEnabled', 'allow_range_trading', 'range_trading', 'range_mode'], 'Range trading');
  const slRequired = channelSl?.value
    ?? firstRenderedValue(manual, ['sl_required', 'require_sl', 'requireStopLoss', 'stop_loss_required', 'stopLossRequired'], 'Stop loss required');
  const aiMode = firstRenderedValue(ai, ['ai_mode', 'aiMode', 'parser_mode', 'parserMode', 'verification_mode', 'verificationMode'], 'AI/manual mode')
    ?? firstRenderedValue(ai, ['ai_enabled', 'aiEnabled', 'use_ai', 'useAi'], 'AI/manual mode');

  const items = [
    item('Copier mode', formatConfigValue(broker.copier_mode, 'Copier mode'), 'Broker account', 10, 'muted'),
    item('Broker / platform', [broker.broker_name, broker.platform].filter(Boolean).join(' / ') || null, 'Broker account', 15, 'muted'),
    item('Trading allowed', tradeAllowed, 'Broker account', 20, toneForBooleanText(tradeAllowed)),
    item('Risk mode', firstRenderedValue(manual, ['risk_mode', 'riskMode', 'lot_sizing_mode', 'lotSizingMode', 'position_size_mode', 'positionSizeMode'], 'Risk mode'), 'Account setting', 30),
    item(lotFromExecution ? 'Lot size used' : 'Configured lot size', lotFromExecution ?? channelLot?.value ?? accountLot?.value ?? null, lotSource, 24 + entryBoost),
    item(riskFromExecution ? 'Risk used' : 'Configured risk %', riskFromExecution ?? channelRisk?.value ?? accountRisk?.value ?? null, riskSource, 26 + entryBoost),
    item('Stop loss required', slRequired, channelSl ? 'Channel override' : 'Account setting', 25 + stopBoost, toneForBooleanText(slRequired)),
    item('Take profit behavior', channelTp?.value ?? firstRenderedValue(manual, ['tp_mode', 'tpMode', 'take_profit_mode', 'takeProfitMode', 'take_profit_behavior', 'takeProfitBehavior'], 'Take profit behavior'), channelTp ? 'Channel override' : 'Account setting', 45),
    item('Breakeven', channelBreakeven?.value ?? firstRenderedValue(manual, ['breakeven_enabled', 'breakevenEnabled', 'auto_be', 'autoBE', 'autoBreakeven', 'move_sl_to_be', 'moveSlToBE'], 'Breakeven'), channelBreakeven ? 'Channel override' : 'Account setting', 50),
    item('Trailing stop', channelTrailing?.value ?? firstRenderedValue(manual, ['trailing_stop_enabled', 'trailingStopEnabled', 'trailing_stop', 'trailingStop', 'trailing'], 'Trailing stop'), channelTrailing ? 'Channel override' : 'Account setting', 52),
    item('Layering mode', channelLayering?.value
      ?? firstRenderedValue(manual, ['layering_mode', 'layeringMode', 'layer_mode', 'layerMode', 'layering', 'split_tp', 'splitTp', 'tp_layers', 'tpLayers'], 'Layering mode'), channelLayering ? 'Channel override' : 'Account setting', 40 + entryBoost),
    item('Range trading', rangeTrading, channelRange ? 'Channel override' : 'Account setting', 38 + entryBoost, toneForBooleanText(rangeTrading)),
    item('Copy limit', channelCopyLimit?.value
      ?? firstRenderedValue(manual, ['copy_limit', 'copyLimit', 'max_positions', 'maxPositions', 'max_open_trades', 'maxOpenTrades'], 'Copy limit'), channelCopyLimit ? 'Channel override' : 'Account setting', 55),
    item('AI/manual mode', aiMode, 'AI settings', 32 + aiBoost),
  ].filter((entry): entry is UserConfigurationItem => entry != null);

  const deduped = new Map<string, UserConfigurationItem>();
  for (const entry of items) {
    if (!deduped.has(entry.label)) deduped.set(entry.label, entry);
  }

  return {
    brokerLabel: broker.label,
    brokerPlatform: broker.platform,
    items: [...deduped.values()]
      .sort((a, b) => a.priority - b.priority || a.label.localeCompare(b.label))
      .slice(0, MAX_ITEMS),
  };
}
