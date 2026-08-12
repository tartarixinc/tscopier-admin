import type { ErrorSource } from './errors';

export interface FailureExplanation {
  title: string;
  explanation: string;
  actions?: string[];
}

function normalizeKey(reason: string): string {
  return reason.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

const SKIP_REASON_EXPLANATIONS: Record<string, FailureExplanation> = {
  ai_classified_as_uncertain_human_review_required: {
    title: 'AI was uncertain — review before trading',
    explanation: 'The AI parser classified this message as uncertain, so instead of executing it was held for human review.',
  },
  ai_review_expired: {
    title: 'Review window expired',
    explanation: 'The AI asked for human review, but the review window passed without an approval, so the signal was expired and never traded.',
  },
  ai_review_price_passed: {
    title: 'Price moved outside the review entry range',
    explanation: 'The AI asked for human review, but before it was approved the market price moved outside the signal\'s entry range, so the review was rejected.',
  },
  invalid_stops: {
    title: 'Broker rejected stop levels',
    explanation: 'The broker rejected the SL/TP on this order. This often happens when price moved before the order filled, or stops were on the wrong side of market.',
    actions: ['Check that SL/TP still make sense at the fill price.'],
  },
  entry_not_opened: {
    title: 'No position opened',
    explanation: 'The copier processed and dispatched this signal, but the broker ended up opening no position and no specific error was captured — entry_not_opened is the fallback reason. Either the entry never became a sendable broker order, or the broker accepted the request but returned no position.',
    actions: [
      'Check the execution attempts: if there is no order_send, the entry legs never materialized (e.g. a range entry whose price never reached the zone).',
      'If an order_send exists, the broker did not confirm a position — verify the account is live, Algo Trading is enabled, and this symbol is tradable.',
      'Entry filters on the channel/account may have blocked the trade before it reached the broker.',
    ],
  },
  entry_zone_far_from_market: {
    title: 'Entry too far from market',
    explanation: 'The signal entry zone was too far from the current market price based on the configured pip tolerance.',
  },
  broker_session_not_connected: {
    title: 'Broker not connected',
    explanation: 'The broker account was not connected when this signal was processed.',
    actions: ['Open Account Configuration and reconnect the account.'],
  },
  broker_bridge_unavailable: {
    title: 'Broker bridge unavailable',
    explanation: 'The MT5 bridge was unavailable when this signal was processed.',
    actions: ['Enable Algo Trading on MT5, keep the terminal running, and confirm the Trade EA is ready.'],
  },
  broker_reactivated_after_signal: {
    title: 'Signal arrived while broker was offline',
    explanation: 'This signal arrived while the broker was disabled or reconnecting. New signals after reconnect are copied normally; this one was not replayed automatically.',
  },
  channel_max_risk_hit: {
    title: 'Daily risk limit reached',
    explanation: 'This channel reached its configured max daily risk limit. Copying is paused until the limit resets (usually at midnight in the profile timezone) or the limit is raised.',
  },
  channel_profit_target_hit: {
    title: 'Daily profit target reached',
    explanation: 'This channel reached its configured daily profit target. Copying is paused until the limit resets or the target is adjusted.',
  },
  channel_config_missing: {
    title: 'Channel not configured',
    explanation: 'This Telegram channel has no saved trading settings.',
    actions: ['Open Account Configuration, select the channel, set lot size and trade style, then save.'],
  },
  channel_config_incomplete: {
    title: 'Channel settings incomplete',
    explanation: 'Saved settings for this channel are incomplete.',
    actions: ['Open Account Configuration and finish lot size, trade style, and channel selection.'],
  },
  channel_filter_ignored: {
    title: 'Ignored by channel filter',
    explanation: 'This message matched an Ignore or Skip keyword configured for the channel in Account Configuration.',
  },
  no_broker_channel_match: {
    title: 'No broker linked to channel',
    explanation: 'No active broker account is linked to this channel, so there was nothing configured to execute against. The signal itself is valid — the mapping is missing.',
    actions: ['Open Account Configuration → select your broker → Channels tab → enable this channel → save.'],
  },
  copier_paused: {
    title: 'Copier is paused',
    explanation: 'Signal copying is paused for this account.',
    actions: ['Resume the copier from the dashboard or Copier Engine.'],
  },
  telegram_listener_not_live: {
    title: 'Telegram not connected',
    explanation: 'Telegram was not connected when this signal arrived.',
    actions: ['Open Copier Engine and reconnect Telegram.'],
  },
  subscription_inactive: {
    title: 'Subscription inactive',
    explanation: 'The subscription is inactive.',
    actions: ['Renew the plan to resume signal copying.'],
  },
  plan_advanced_feature_required: {
    title: 'Plan upgrade required',
    explanation: 'This feature requires a higher plan.',
    actions: ['Upgrade in Billing to enable it.'],
  },
  entry_not_execution_eligible: {
    title: 'Signal not eligible to trade',
    explanation: 'The message was parsed but did not meet execution rules (for example missing NOW, SL, or TP cues for this channel).',
  },
  duplicate_provider_signal: {
    title: 'Duplicate signal',
    explanation: 'The same provider signal was already processed recently and was not copied again.',
  },
  explicit_stops_required_when_add_to_existing_off: {
    title: 'SL/TP required for this channel mode',
    explanation: 'This channel uses single-slot mode (Add to Existing Trades off). New entries must include labeled SL and TP in the message.',
  },
  basket_modify_failed: {
    title: 'Could not update open trades',
    explanation: 'The signal was received but updating SL/TP on open trades failed.',
    actions: ['Check open positions and broker connection.'],
  },
  parameter_follow_up_no_open_basket: {
    title: 'No open trade to update',
    explanation: 'This looked like an SL/TP update but there was no open trade from this channel to modify.',
  },
  mgmt_no_open_trades: {
    title: 'No matching open trade',
    explanation: 'This management instruction (close, modify, breakeven, etc.) did not match any open trade from this channel.',
  },
  mgmt_no_open_trades_db: {
    title: 'No open trade in copier',
    explanation: 'The copier had no open trade record for this channel when the management message arrived.',
  },
  mgmt_no_open_trades_broker: {
    title: 'No open position on broker',
    explanation: 'There was no open position on the broker for this channel when the management message arrived.',
  },
  mgmt_no_open_trades_symbol: {
    title: 'Symbol did not match open legs',
    explanation: 'The symbol on the management message did not match any open leg for this channel.',
  },
  no_matching_open_trade: {
    title: 'No matching open trade',
    explanation: 'No open trade matched this follow-up instruction.',
  },
  symbol_not_in_whitelist: {
    title: 'Symbol not allowed',
    explanation: 'This symbol is not in the allowed list for the broker or channel.',
  },
  symbol_excluded: {
    title: 'Symbol excluded',
    explanation: 'This symbol is excluded from copying in the account settings.',
  },
  symbol_exempted_from_trading: {
    title: 'Symbol exempted',
    explanation: 'This symbol is exempt from automated trading on this account.',
  },
  close_worse_entries_disabled: {
    title: 'Close worse entries disabled',
    explanation: 'Close worse entries is disabled in the channel or account settings.',
  },
  message_revision_direction_flip_close_failed: {
    title: 'Could not close for direction flip',
    explanation: 'Telegram edited the signal to flip buy/sell but closing the existing basket failed.',
  },
  message_revision_direction_flip_closed: {
    title: 'Closed after direction change',
    explanation: 'Telegram edited the signal to flip direction; open trades were closed and no new entry was placed.',
  },
  no_tp_ladder: {
    title: 'No take-profit ladder to redistribute',
    explanation: 'The basket take-profit rebalance was skipped, not failed. No TP ladder could be resolved: the signal carried no TP levels, and no newer TP ladder had been saved for the channel since the basket opened. Nothing was modified on the broker.',
  },
};

function explainBrokerError(message: string): FailureExplanation | null {
  const m = message.toLowerCase();
  if (m.includes('unknown ticket')) {
    return {
      title: 'The broker does not know this position ticket',
      explanation: 'This action references a broker ticket the broker cannot find. The linked trade has no valid broker ticket (metaapi_order_id), or the position was closed, replaced, or opened on a different account. Every retry hits the same error — it will not fix itself.',
      actions: [
        'Compare the "Broker ticket" shown on the linked trade with the ticket the position actually holds.',
        'Re-sync or reconcile the trade record with the broker.',
      ],
    };
  }
  if (/http 5\d\d/.test(m)) {
    return {
      title: 'Broker platform error (HTTP 5xx)',
      explanation: 'The broker returned an internal server error. This is a broker-side problem and is usually transient — a later retry often succeeds.',
    };
  }
  if (m.includes('invalid stops')) {
    return {
      title: 'Broker rejected the stop-loss / take-profit price',
      explanation: 'The requested stop loss or take profit did not meet the broker\'s price or minimum-distance rules, so the protection update was rejected.',
    };
  }
  if (m.includes('not enough money') || m.includes('not enough free') || m.includes('insufficient') || m.includes('no money')) {
    return {
      title: 'Insufficient funds or margin',
      explanation: 'The account did not have enough free margin or funds to open or manage this trade.',
    };
  }
  if (m.includes('symbol not found') || m.includes('market closed') || m.includes('unknown symbol')) {
    return {
      title: 'Broker rejected the symbol or market',
      explanation: 'The broker does not recognise the requested symbol (or the market was closed for it). The instrument name on this account differs from the signal, or the broker restricts trading on it.',
    };
  }
  if (m.includes('trade not allowed') || m.includes('not allowed') || m.includes('disabled') || m.includes('auto trading')) {
    return {
      title: 'Trading disabled or not allowed',
      explanation: 'The broker refused the action because trading is disabled for this account (e.g. Algo Trading off, symbol restricted, or the terminal is not logged in).',
    };
  }
  if (m.includes('timeout') || m.includes('timed out')) {
    return {
      title: 'Request timed out',
      explanation: 'The broker (or the connection to it) did not respond in time. This is usually transient — a retry often succeeds.',
    };
  }
  return null;
}

export function explainFailure(cause: string | null | undefined, source: ErrorSource): FailureExplanation | null {
  const text = (cause ?? '').trim();
  if (!text) return null;

  const skipReasonExplanation = SKIP_REASON_EXPLANATIONS[normalizeKey(text)];

  if (source === 'signal') {
    if (skipReasonExplanation) return skipReasonExplanation;
    return null;
  }

  // Execution / dead-letter rows carry either a raw broker error or a structured
  // skip reason (e.g. no_tp_ladder). Try the broker matchers first, then the skip keys.
  return explainBrokerError(text) ?? skipReasonExplanation ?? null;
}

export function failureTitle(cause: string | null | undefined, source: ErrorSource): string | null {
  return explainFailure(cause, source)?.title ?? null;
}
