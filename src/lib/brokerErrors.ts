export type BrokerErrorCategory =
  | 'symbol_select_failed'
  | 'unknown_ticket'
  | 'margin'
  | 'stops_rejected'
  | 'market_closed'
  | 'trading_disabled'
  | 'account_unavailable'
  | 'http_5xx'
  | 'timeout'
  | 'rate_limit'
  | 'other';

export interface BrokerErrorClassification {
  category: BrokerErrorCategory;
  severity: 'transient' | 'major';
  retryable: boolean;
  label: string;
}

export const BROKER_CATEGORY_LABELS: Record<BrokerErrorCategory, string> = {
  symbol_select_failed: 'Symbol select failed',
  unknown_ticket: 'Unknown ticket',
  margin: 'Insufficient margin',
  stops_rejected: 'Stops rejected',
  market_closed: 'Market closed',
  trading_disabled: 'Trading disabled',
  account_unavailable: 'Account unavailable',
  http_5xx: 'HTTP 5xx',
  timeout: 'Timeout',
  rate_limit: 'Rate limited',
  other: 'Other',
};

const OTHER: BrokerErrorClassification = {
  category: 'other',
  severity: 'major',
  retryable: false,
  label: BROKER_CATEGORY_LABELS.other,
};

function classify(
  category: BrokerErrorCategory,
  severity: 'transient' | 'major',
  retryable: boolean,
): BrokerErrorClassification {
  return { category, severity, retryable, label: BROKER_CATEGORY_LABELS[category] };
}

/** Rule-based broker-error classifier. Order matters: the most specific
 *  pattern wins, and permanent-failure patterns are checked before retryable
 *  ones so a message can never fall through to a transient label. */
export function classifyBrokerError(message: string | null | undefined): BrokerErrorClassification {
  const text = (message ?? '').trim();
  if (!text) return OTHER;

  if (/symbol ?select|unknown symbol|not selectable|symbol could not be loaded/i.test(text)) {
    return classify('symbol_select_failed', 'major', false);
  }
  if (/market.{0,12}closed/i.test(text)) {
    return classify('market_closed', 'major', false);
  }
  if (/unknown ticket|no such order|already closed/i.test(text)) {
    return classify('unknown_ticket', 'major', false);
  }
  if (/not enough money|not enough free|insufficient (funds|balance|margin|money)|no money|free margin|\bmargin\b/i.test(text)) {
    return classify('margin', 'major', false);
  }
  if (/invalid stops|stop level|stops?_level|stops? rejected/i.test(text)) {
    return classify('stops_rejected', 'major', false);
  }
  if (/trade not allowed|trading (disabled|not allowed)|not allowed to trade|auto trading/i.test(text)) {
    return classify('trading_disabled', 'major', false);
  }
  if (/account (unavailable|not found)|login failed|not logged in|wrong login|invalid login/i.test(text)) {
    return classify('account_unavailable', 'major', false);
  }
  if (/http 5\d\d|\b(50[0-9]|51[0-9]|52[0-9]|53[0-9]|54[0-9])\b/i.test(text)) {
    return classify('http_5xx', 'transient', true);
  }
  if (/rate limit|too many|throttl|\b429\b/i.test(text)) {
    return classify('rate_limit', 'transient', true);
  }
  if (/timeout|timed out|no response|did not respond/i.test(text)) {
    return classify('timeout', 'transient', true);
  }

  return OTHER;
}

/** True when the message matches a specific broker error category (not "other"). */
export function isBrokerError(message: string | null | undefined): boolean {
  return classifyBrokerError(message).category !== 'other';
}

/** Category group override for an error whose cause is a broker error,
 *  or null when it is not broker-related. Used by the Errors page to group
 *  all broker-related failures under broker categories. */
export function brokerCategoryOf(message: string | null | undefined): { key: string; label: string } | null {
  const c = classifyBrokerError(message);
  if (c.category === 'other') return null;
  return { key: `broker:${c.category}`, label: `Broker · ${c.label}` };
}

export interface BrokerCategorized {
  categoryKey: string;
  categoryLabel: string;
}

/** Returns the broker-category override for an item's cause, keeping the
 *  original group when the error is not broker-related. */
export function applyBrokerCategory(item: BrokerCategorized, cause: string | null | undefined): BrokerCategorized {
  const broker = brokerCategoryOf(cause);
  if (!broker) return { categoryKey: item.categoryKey, categoryLabel: item.categoryLabel };
  return { categoryKey: broker.key, categoryLabel: broker.label };
}
