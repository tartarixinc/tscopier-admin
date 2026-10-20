/*
 * System Encyclopedia — catalog content: database tables and edge functions.
 *
 * Split from encyclopediaContent.ts purely to keep each file readable.
 * `DataEntry.table` names the table a live row count is fetched for (null when
 * the dashboard does not hold an admin read on it — the UI then shows "—").
 * `EdgeEntry.group` is the display grouping for the Edge Functions tab.
 */

import type { EncyclopediaEntry } from './encyclopediaContent';

export interface DataEntry extends EncyclopediaEntry {
  category: 'data';
  table: string | null;
}

export interface EdgeEntry extends EncyclopediaEntry {
  category: 'edge';
  group: string;
}

// ---------------------------------------------------------------------------
// Database tables
// ---------------------------------------------------------------------------

export const DATA_ENTRIES: DataEntry[] = [
  {
    id: 'table-signals',
    category: 'data',
    table: 'signals',
    title: 'signals',
    summary: 'One row per Telegram signal: raw text, structured parse, status, and the full timing diary.',
    plain: `The heart of the system. Every message that was understood as a trade signal becomes one row here, holding both what the
trader actually wrote and what we understood it to mean. Its status drives the whole pipeline, and its timing stamps are what
the latency screens measure.`,
    technical: `Key columns: id, user_id, channel_id, telegram_message_id (part of the duplicate key with user_id + channel_id),
raw_message, parsed_data (jsonb — symbol, action, entry, sl, tp, …), user_override, status (pending/parsed/executed/failed/
skipped), skip_reason, is_modification, parent_signal_id, pipeline_ts (jsonb timing stamps), created_at. Indexes on user_id,
channel_id, status. Related: signal_broker_dispatch_claims, signal_entry_pending_orders, signal_range_entry_waits.`,
    files: ['supabase/migrations/20260505092235_create_core_schema.sql'],
    tables: ['signals'],
    links: [{ label: 'All Signals', to: '/signals' }, { label: 'Signal Stats', to: '/signals/stats' }],
    keywords: ['signals', 'table', 'parsed_data', 'pipeline_ts'],
  },
  {
    id: 'table-trades',
    category: 'data',
    table: 'trades',
    title: 'trades',
    summary: 'One row per copied position: prices, lots, status, close reason and profit.',
    plain: `Every position the copier opened (or tried to open) for a customer lives here. While it is open the profit column tracks
floating profit; when it closes, the close time, close price, profit and the reason it ended are filled in.`,
    technical: `Key columns: id, user_id, signal_id, broker_account_id, metaapi_order_id (legacy name, kept for compatibility),
symbol, direction, entry_price, sl, tp, tp_levels, lot_size, status (open/closed/cancelled/pending), opened_at, closed_at,
close_reason, profit, close_price, cwe_close_price, telegram_channel_id. Written by the trade worker; backfilled by
ClosedTradeFillMonitor when the broker closes first.`,
    tables: ['trades'],
    links: [
      { label: 'All Trades', to: '/trades' },
      { label: 'Open Positions', to: '/trades/open' },
      { label: 'Analytics', to: '/trades/analytics' },
    ],
    keywords: ['trades', 'positions', 'profit', 'lot'],
  },
  {
    id: 'table-trade-execution-logs',
    category: 'data',
    table: 'trade_execution_logs',
    title: 'trade_execution_logs',
    summary: 'Every order attempt and management action, with status, payloads and the broker error if any.',
    plain: `The copier's logbook. Each attempt to place, modify or close an order writes one row: what was attempted, whether it
worked, and exactly what the broker replied when it did not. Support questions ("why did this not copy?") are answered from
here.`,
    technical: `Columns: id, user_id, channel_id, signal_id, broker_account_id, action, status (attempt/success/failed),
request_payload, response_payload, error_message, created_at. reason_code is stamped into request_payload and drives failure
bucketing in src/lib/systemHealth.ts. action='pipeline_summary' rows carry end-to-end timings. Retention: pruned every 10 min,
500 rows kept per user.`,
    tables: ['trade_execution_logs'],
    links: [
      { label: 'Execution Logs', to: '/trades/execution-logs' },
      { label: 'Copier Logs', to: '/copier-logs' },
      { label: 'Errors', to: '/errors' },
    ],
    keywords: ['execution logs', 'copier logs', 'attempt', 'error_message'],
  },
  {
    id: 'table-signal-broker-dispatch-claims',
    category: 'data',
    table: 'signal_broker_dispatch_claims',
    title: 'signal_broker_dispatch_claims',
    summary: 'The per-signal × per-account lock that prevents a signal being executed twice.',
    plain: `Before an order is sent, the worker writes a lock row here combining the signal and the account. If the row already
exists, the signal was already handled for that account, so nothing is sent again. It is released and rewritten during retries,
so it proves attempts, not a permanent history.`,
    technical: `Unique index on (signal_id, broker_account_id). Inserted fail-closed by claimSignalBrokerDispatch
(TradeExecutor.ts:1504); released at :1501 and :1550 and also used from entryPrepare (:770, :1054). Because rows are deleted on
range-wake/retry, Systems Health counts distinct signal_ids in the window as "dispatch attempts" and never as a divergence base.`,
    tables: ['signal_broker_dispatch_claims'],
    links: [{ label: 'Systems Health', to: '/monitoring/systems-health' }],
    keywords: ['claim', 'lock', 'duplicate', 'dispatch'],
  },
  {
    id: 'table-listener-events',
    category: 'data',
    table: 'listener_events',
    title: 'listener_events',
    summary: 'Append-only audit trail of listener outcomes: links, failures, disconnects, assistant tool calls.',
    plain: `A diary of everything the Telegram listener did besides parsing signals — a channel linked, a session dropped, a tool call
by the assistant. When a user reports a problem this is the first table to check.`,
    technical: `Columns: user_id, channel_row_id, telegram_message_id, event_type, detail (jsonb), created_at. Event catalogue
and retention (7/30/90 days by type, pruned hourly by prune_listener_events) in docs/listener-events-reference.md. Admin read
granted by migration 20260921120000_admin_read_listener_events.sql — apply to an environment before rows appear (a missing
policy shows zero rows, not an error).`,
    files: ['worker/src/listenerEvents.ts'],
    tables: ['listener_events'],
    links: [
      { label: 'Listener Events', to: '/monitoring/listener-events' },
      { label: 'User detail (panel)', to: '/users' },
    ],
    keywords: ['listener_events', 'audit', 'event_type'],
  },
  {
    id: 'table-telegram-channels',
    category: 'data',
    table: 'telegram_channels',
    title: 'telegram_channels',
    summary: 'Each user’s followed channels, with per-channel overrides (lot size, pip tolerance, keywords).',
    plain: `One row for every channel a user follows, holding their personal settings for it: lot size, how many pips of slippage is
acceptable, and any keywords that filter which messages count. The listener uses this list to know what to watch.`,
    technical: `Key columns: id, user_id, channel_id, channel_username, display_name, is_active, signal_channel_id (points at the
global registry), lot_size_override, pip_tolerance_override, channel_keywords, last_seen_message_id, last_seen_at, last_live_at.`,
    tables: ['telegram_channels', 'signal_channels'],
    links: [
      { label: 'Telegram Channels', to: '/telegram/channels' },
      { label: 'Signal Profiles', to: '/telegram/profiles' },
    ],
    keywords: ['channels', 'followed', 'keywords', 'override'],
  },
  {
    id: 'table-signal-channels',
    category: 'data',
    table: 'channel_signals',
    title: 'channel_signals (global registry)',
    summary: 'The platform-wide record of signal channels, independent of which user follows them.',
    plain: `While telegram_channels is personal (one row per user per channel), this is the shared registry of the channels
themselves — one row per channel for the whole platform, used for channel-level analysis and backtests.`,
    technical: `Created by migration 20260627120000_signal_channels_registry.sql: telegram_chat_id, channel_username,
display_name, subscriber_count, plus example/lexicon/profile child tables (channel_signal_examples, channel_signal_lexicon,
channel_signal_profiles) that feed the parser's per-channel knowledge. Admin read: migration 20260803000000.`,
    tables: ['channel_signals', 'channel_signal_examples', 'channel_signal_lexicon', 'channel_signal_profiles'],
    links: [{ label: 'Signal Profiles', to: '/telegram/profiles' }],
    keywords: ['registry', 'signal_channels', 'lexicon', 'examples'],
  },
  {
    id: 'table-telegram-sessions',
    category: 'data',
    table: 'telegram_sessions',
    title: 'telegram_sessions',
    summary: 'The MTProto session material for each linked Telegram account (one active session per user).',
    plain: `When a user links Telegram, a session is created here. It is the credential the listener uses to read their channels.
"Linked" counts on this dashboard come from this table.`,
    technical: `Columns include session_string (the MTProto auth material — never exposed in admin selects), phone_number,
is_active, user_id. Only one worker process may use a session at a time (AUTH_KEY_DUPLICATED otherwise). Companion tables:
telegram_auth_pending (in-flight login codes, worker-only), telegram_account_claims (prevents two users claiming one Telegram
account).`,
    tables: ['telegram_sessions', 'telegram_auth_pending', 'telegram_account_claims'],
    links: [{ label: 'Telegram Sessions', to: '/telegram/sessions' }],
    keywords: ['session', 'mtproto', 'linked', 'auth'],
  },
  {
    id: 'table-broker-accounts',
    category: 'data',
    table: 'broker_accounts',
    title: 'broker_accounts',
    summary: 'Connected broker accounts: provider (fxsocket/mtapi), connection health, balances and copy settings.',
    plain: `One row per customer trading account. It records how we connect to it (the old FxSocket or the new MTAPI), whether it is
connected right now, the last known balance, and how trades should be sized on it.`,
    technical: `Key columns: user_id, label, platform, provider ('fxsocket' | 'mtapi', default fxsocket), mtapi_status,
fxsocket_account_id, fxsocket_status, connection_status (pending/connected/recovering/error), writer_epoch (broker-write
fence), provider_transition_state/target, last_balance/equity, is_active, copier_mode (ai/manual), default_lot_size,
pip_tolerance, signal_channel_ids, disconnect_reason. Credentials are encrypted (broker_credentials_crypto) and not readable
here.`,
    tables: ['broker_accounts'],
    links: [
      { label: 'Broker Accounts', to: '/brokers' },
      { label: 'Connection Errors', to: '/brokers/errors' },
      { label: 'MTAPI Reconnects', to: '/brokers/mtapi-reconnects' },
    ],
    keywords: ['broker', 'accounts', 'provider', 'mtapi', 'fxsocket', 'connection'],
  },
  {
    id: 'table-user-profiles',
    category: 'data',
    table: 'user_profiles',
    title: 'user_profiles',
    summary: 'User settings, admin flags, copier pause switch and base currency.',
    plain: `The profile row for every registered user: their name, whether the copier is paused, whether they are an admin (and until
when), and their display settings. The is_admin flag here is what unlocks this dashboard.`,
    technical: `Key columns: user_id (FK), display_name, first_name, last_name, base_currency, copier_paused, is_admin,
admin_until (admin access is active only while in the future — isAdminAccessActive), created_at. Admin policies across the
dashboard depend on public.is_admin() reading this table.`,
    tables: ['user_profiles'],
    links: [{ label: 'All Users', to: '/users' }],
    keywords: ['profile', 'admin', 'copier_paused', 'user'],
  },
  {
    id: 'table-subscriptions',
    category: 'data',
    table: 'subscriptions',
    title: 'subscriptions',
    summary: 'Plan, status and trial dates — the entitlement the copier checks before executing.',
    plain: `Who is paid up, on which plan, and when their trial ends. The worker checks this before copying: active plans always
copy, trials copy only until the trial date passes.`,
    technical: `Key columns: user_id, plan (basic/advanced observed), status (active/trialing/past_due/canceled/incomplete/…),
trial_ends_at, stripe customer/subscription ids. Kept in sync by stripe-webhook (rebuilds from all of a customer's
subscriptions) and reconcile-stripe-entitlement; trials are closed out by the reconcile-expired-trials cron. The worker's rule
(planLimits.isSubscriptionActive): 'active' always counts; 'trialing' counts while trial_ends_at is unset or in the future.`,
    tables: ['subscriptions'],
    links: [{ label: 'All Users', to: '/users' }],
    keywords: ['subscription', 'plan', 'trial', 'billing', 'entitlement'],
  },
  {
    id: 'table-worker-session-leases',
    category: 'data',
    table: 'worker_session_leases',
    title: 'worker_session_leases',
    summary: 'Proof that a worker process is alive and owns a user’s listener slot (renewed every few seconds).',
    plain: `Each worker writes a row saying "I am handling this user" with an expiry time a short while in the future, and keeps
renewing it while alive. If the row expires, the process died — that is how the dashboard knows a listener is offline.`,
    technical: `Columns: user_id, worker_id (format <role>:<shard>:<instance>:<buildTag>), role, shard_id, shard_count,
expires_at, updated_at. TTL: WORKER_SESSION_LEASE_TTL_MS = 45000, renewed while healthy. Used by Worker Leases page, the
Systems Health fleet panel and the Copier Engine page. Read via migration 20260730121100.`,
    tables: ['worker_session_leases'],
    links: [
      { label: 'Worker Leases', to: '/monitoring/workers' },
      { label: 'Systems Health', to: '/monitoring/systems-health' },
    ],
    keywords: ['lease', 'heartbeat', 'worker', 'online', 'shard'],
  },
  {
    id: 'table-copier-listener-health',
    category: 'data',
    table: 'copier_listener_health',
    title: 'copier_listener_health',
    summary: 'Per-user live listener health: connected, MTProto up, last probe — the truth signal for "is it listening".',
    plain: `While leases prove a process is running, this table says whether the Telegram connection itself is healthy for each user.
The dashboard prefers it over leases when it is reporting fresh rows, because a process can be alive while its Telegram
connection is not.`,
    technical: `Columns: user_id, listener_status (connected/…), mtproto_connected (bool), worker_ownership_status, updated_at,
last_successful_probe_at, freshness_threshold_ms. Written by the worker via RPC upsert_copier_listener_health
(worker/src/copierHealth.ts:233). Systems Health trusts it only when readable and at least one row is fresh within its
threshold, otherwise falls back to leases.`,
    tables: ['copier_listener_health'],
    links: [{ label: 'Copier Engine', to: '/monitoring/copier-engine' }],
    keywords: ['health', 'listener', 'mtproto', 'probe', 'connected'],
  },
  {
    id: 'table-signal-queue-dead-letters',
    category: 'data',
    table: 'signal_queue_dead_letters',
    title: 'signal_queue_dead_letters',
    summary: 'Queue messages that failed repeatedly, parked for manual replay instead of blocking the stream.',
    plain: `If the Redis queue cannot deliver a message after several attempts, it is parked here rather than left to jam the
pipeline. Operators can replay them from the Dead Letters page once the cause is fixed.`,
    technical: `Written by worker/src/queue/ after TRADE_SIGNAL_QUEUE_MAX_ATTEMPTS (default 5) failures; replayed_at marks a
replayed row (Systems Health counts open ones = replayed_at IS NULL). Reasons recorded in the row payload include
QUEUE_DEAD_LETTER, QUEUE_MALFORMED_PAYLOAD and read/claim failures.`,
    tables: ['signal_queue_dead_letters', 'signal_queue_idempotency'],
    links: [{ label: 'Dead Letters', to: '/monitoring/dead-letters' }],
    keywords: ['dead letter', 'queue', 'replay', 'failed message'],
  },
  {
    id: 'table-channel-trading-config',
    category: 'data',
    table: 'broker_channel_trading_configs',
    title: 'channel_trading_presets / broker_channel_trading_configs',
    summary: 'The execution settings that decide how a signal is copied: mode, lot size, filters, management.',
    plain: `Two related tables hold the copying rules: reusable presets, and the per-account × per-channel configuration actually
applied at execution time (AI mode or manual mode, lot size, risk limits, keyword filters, management switches).`,
    technical: `channel_trading_presets — named reusable presets. broker_channel_trading_configs — per (broker_account,
channel) row with copier_mode ('ai' | 'manual'), manual_settings, ai_settings (JSON), enforce filters; referenced by
brokerChannelTradingConfigs.ts / brokerChannelFilter.ts in the worker. Related: broker_accounts.signal_channel_ids (which
channels an account copies at all).`,
    tables: ['channel_trading_presets', 'broker_channel_trading_configs'],
    links: [{ label: 'Trading Presets', to: '/presets' }, { label: 'Channel configs (user detail)', to: '/users' }],
    keywords: ['config', 'preset', 'copier mode', 'lot', 'filter'],
  },
  {
    id: 'table-layering',
    category: 'data',
    table: 'layering_plans',
    title: 'layering_plans / range_pending_legs',
    summary: 'Staged entries: the plan for splitting one signal into several orders, and the individual pending legs.',
    plain: `When layering is on, one signal becomes several orders placed at different prices. The plan table tracks the lifecycle of
that split, and the legs table tracks each individual pending order — waiting, filled, or cancelled.`,
    technical: `layering_plans.status (observed): prepared, activating, active, entries_complete, completed, cancelling,
cancellation_pending, cancellation_manual_review, cancelled, invalid. range_pending_legs: per-leg status, ticket,
claimed_at/claimed_by, expires_at; guarded by range_pending_tp_locks. Execution is fail-closed:
LAYERING_MODES_EXECUTION_ENABLED / LAYERING_STATIC|DYNAMIC_EXECUTION_ENABLED / LAYERING_MODES_ACCOUNT_ALLOWLIST +
LAYERING_MODES_PREPARE_ONLY=true + LAYERING_MODES_KILL_SWITCH=true. Settings written by the update-layering-settings edge
function; capabilities checked by layering-mode-capabilities (static 1–20 layers, dynamic step > 0).`,
    tables: ['layering_plans', 'range_pending_legs', 'partial_tp_legs'],
    keywords: ['layering', 'range', 'pending legs', 'staged entry'],
  },
  {
    id: 'table-backtest-runs',
    category: 'data',
    table: 'backtest_runs',
    title: 'backtest_runs (and backtest children)',
    summary: 'Historical re-runs of a channel: the run, its trades, equity points and channel linkage.',
    plain: `Backtests replay a channel's past signals to show what copying it would have done. Each run has its own trades, equity
curve and list of channels involved, kept separate from live data.`,
    technical: `Tables: backtest_runs (status observed: running/completed), backtest_trades, backtest_equity_points,
backtest_run_channels, backtest_channel_signals. Driven by the backtest-run edge function (market data via FxSocket) and the
backtest worker role (ephemeral Telegram client for history import).`,
    tables: ['backtest_runs', 'backtest_trades', 'backtest_equity_points'],
    links: [{ label: 'Backtest Runs', to: '/backtests' }],
    keywords: ['backtest', 'simulation', 'equity', 'history'],
  },
  {
    id: 'table-commission-ledger',
    category: 'data',
    table: 'commission_ledger',
    title: 'commission_ledger',
    summary: 'Affiliate commission rows (pending/paid) between a referred user and their affiliate.',
    plain: `When a referred customer generates a commission, a row is added here for the affiliate. The Affiliates page pays these
out; the row records who referred whom, how much, and whether it has been paid.`,
    technical: `Columns include affiliate_user_id, referred_user_id, commission_cents, status (pending/…), created_at; paid rows
are grouped into payout_batches. Written via the referral/affiliate edge functions (apply-referral-code sources: signup_url,
signup_form, onboarding, admin) and Stripe Connect onboarding via affiliate-connect.`,
    tables: ['commission_ledger', 'affiliate_profiles', 'referral_attributions'],
    links: [{ label: 'Affiliate Profiles', to: '/affiliates' }],
    keywords: ['affiliate', 'commission', 'payout', 'referral'],
  },
  {
    id: 'table-assistant-threads',
    category: 'data',
    table: 'assistant_threads',
    title: 'assistant_threads',
    summary: 'Conversations with the in-app AI assistant: messages, tool calls and attached images.',
    plain: `Every chat a customer has with the built-in assistant is stored here as a thread with messages. The dashboard reads them
for support; images are stored inline with the messages.`,
    technical: `Messages column is JSONB holding the full conversation including tool-call results and base64 data-URL images.
Admin read granted by migration 20260902120000_admin_read_assistant_threads.sql (applied to staging + prod 2026-09-02).
Written by the assistant-chat edge function (OpenAI tool calling, guarded by assistantGuard.ts).`,
    tables: ['assistant_threads'],
    links: [{ label: 'Assistant Chats', to: '/assistant-chats' }],
    keywords: ['assistant', 'chat', 'ai', 'transcript'],
  },
  {
    id: 'table-trade-reports',
    category: 'data',
    table: 'trade_reports',
    title: 'trade_reports',
    summary: 'User-submitted reports about copied trades, reviewed from the Reports page.',
    plain: `If a customer believes a copy went wrong, they can file a report. Each report is a row here that staff review in the
Reports section of this dashboard.`,
    technical: `Admin read via migration 20260810000000_admin_read_update_trade_reports.sql. Linked to the user and usually the
affected trade/signal; updated through admin actions (the admin-mutate edge function writes the audit trail).`,
    tables: ['trade_reports'],
    links: [{ label: 'Reports', to: '/reports' }],
    keywords: ['report', 'support', 'dispute'],
  },
  {
    id: 'table-channel-messages',
    category: 'data',
    table: 'channel_messages',
    title: 'channel_messages',
    summary: 'Raw archive of channel messages, used for reconciliation and backtests.',
    plain: `A copy of the messages seen in each channel. It exists so the system can compare what was stored with what the channel
said (when a trader edits a message) and so backtests have real history to replay.`,
    technical: `Written by the listener per signal_channel_id. Consumed by the reconcile sweep (SIGNAL_RECONCILE_SWEEP_MS=60 s,
6 h window) and backtest history import (/auth/import_backtest_history, /auth/backtest_sync_signals).`,
    tables: ['channel_messages'],
    keywords: ['archive', 'raw message', 'history', 'reconcile'],
  },
  {
    id: 'table-app-settings',
    category: 'data',
    table: 'app_settings',
    title: 'app_settings',
    summary: 'Platform-wide key/value settings (banners, announcements, feature switches).',
    plain: `A small table of global switches and text the product shows to everyone — maintenance banners, announcements, and
feature flags read by both the app and the workers.`,
    technical: `Read by the product via realtime channels (app_settings_banner / app_settings_announcement in
AppBannerContext / AppAnnouncementContext). Managed from the App Settings page here; the campaigns cron
(send-subscription-campaigns) and invoice-due recipients RPC also live alongside related settings.`,
    tables: ['app_settings'],
    links: [{ label: 'App Settings', to: '/settings' }],
    keywords: ['settings', 'banner', 'announcement', 'flag'],
  },
];

// ---------------------------------------------------------------------------
// Edge functions (43, TSCopier repo supabase/functions/)
// ---------------------------------------------------------------------------

function edge(
  name: string,
  group: string,
  summary: string,
  plain: string,
  technical: string,
): EdgeEntry {
  return {
    id: `edge-${name}`,
    category: 'edge',
    group,
    title: name,
    summary,
    plain,
    technical,
    files: [`supabase/functions/${name}/index.ts`],
    keywords: [name.replace(/-/g, ' ')],
  };
}

export const EDGE_ENTRIES: EdgeEntry[] = [
  edge('telegram-auth', 'Auth & onboarding',
    'Proxy in front of the worker’s Telegram login API (send code, verify, QR, channels).',
    `Lets the website start a Telegram login without ever touching Telegram itself: the request is forwarded to the worker,
which is the only component allowed to hold an MTProto connection.`,
    `Deliberately not an MTProto client — earlier direct use caused IP/DC churn and an account ban (comment in index.ts).
Forwards to WORKER_URL with WORKER_INTERNAL_TOKEN.`),
  edge('auth-before-user-created', 'Auth & onboarding',
    'Signup webhook that blocks suspicious email addresses before the account exists.',
    `Runs the moment Supabase is about to create a new account, and refuses addresses that match known spam patterns.`,
    `Supabase Auth before-user-created webhook, verified with a standardwebhooks signature; uses isSuspiciousSignupEmail from
_shared/emailSignupPolicy.ts (patterns configurable via SIGNUP_BLOCKED_EMAIL_PATTERNS).`),
  edge('send-verification-email', 'Auth & onboarding',
    'Sends the email-verification message, with Turnstile and per-IP rate limits.',
    `Delivers the "confirm your email" message and makes sure one person cannot flood the system by requesting it repeatedly.`,
    `Turnstile verification (TURNSTILE_SECRET_KEY) + signupAbuseGuard per-IP rate limit; layout from _shared/authEmailLayout.ts.`),
  edge('send-password-reset-email', 'Auth & onboarding',
    'Sends password-reset emails with global and per-IP rate limits.',
    `Handles "I forgot my password": sends the reset link and throttles requests so the endpoint cannot be abused.`,
    `Global + IP rate limits and Turnstile; shared email layout from _shared/.`),

  edge('create-checkout-session', 'Billing & entitlement',
    'Creates a Stripe Checkout session for a subscription.',
    `Starts the payment flow: builds the Stripe checkout page for the chosen plan and returns its URL.`,
    `Invoked with the user JWT; STRIPE_SECRET_KEY + price IDs come from edge secrets.`),
  edge('confirm-checkout', 'Billing & entitlement',
    'Syncs the local subscription right after checkout succeeds.',
    `When payment finishes, this makes the local subscription record match Stripe straight away, so the copier unlocks without
waiting for the webhook.`,
    `Self-contained sync after Checkout success (header comment index.ts:1-8); complements stripe-webhook.`),
  edge('stripe-webhook', 'Billing & entitlement',
    'Receives Stripe events and rebuilds the customer’s entitlement.',
    `The always-on listener for everything Stripe says about a customer — payment succeeded, subscription canceled — which it
turns into the correct local subscription state.`,
    `Rebuilds entitlement from ALL of the customer's subscriptions (so a lower plan no longer overwrites a higher one).`),
  edge('customer-portal', 'Billing & entitlement',
    'Opens the Stripe billing portal (update card, cancel, invoices).',
    `Gives customers the Stripe-hosted page where they manage their payment method and subscription.`,
    `Returns a portal session URL; scoped to the signed-in customer.`),
  edge('billing-history', 'Billing & entitlement',
    'Lists invoices with the service period each one paid for.',
    `Shows the customer their past invoices and which dates each invoice covered.`,
    `Derives service periods from Stripe subscription line items.`),
  edge('update-extra-accounts', 'Billing & entitlement',
    'Adds or removes extra broker accounts through Stripe.',
    `When a customer buys room for another trading account, this changes the Stripe subscription accordingly.`,
    `Upgrade/downgrade path for extra-account line items.`),
  edge('reconcile-expired-trials', 'Billing & entitlement',
    'Hourly cron: closes trials that ran past their end date.',
    `Once a trial expires, this stops it from continuing to copy trades: it syncs with Stripe and revokes access.`,
    `Rows stuck 'trialing' past trial_ends_at → Stripe sync → entitlement revoked.`),
  edge('reconcile-stripe-entitlement', 'Billing & entitlement',
    'Recomputes a customer’s plan from all their Stripe subscriptions.',
    `A repair tool: rebuilds the local subscription from Stripe data when the two have drifted apart.`,
    `Service-role or admin caller; fixes the "Basic overwriting Advanced" class of drift.`),
  edge('disconnect-expired-fxsocket-brokers', 'Billing & entitlement',
    'Cron that disconnects FxSocket brokers after the subscription grace period.',
    `If a subscription lapses long enough, the broker connection is dropped rather than left open indefinitely.`,
    `Sets DISCONNECT_REASON = subscription_expired_grace_elapsed on affected broker_accounts rows.`),

  edge('parse-signal', 'Signals & trading',
    'Edge-side signal parsing (fallback path and UI previews).',
    `A backup place where message text can be turned into a structured signal, used when the listener is configured to parse
off-process, and by preview tools.`,
    `Used when LISTENER_INLINE_PARSE=false; imports the shared guards (tradableSymbol, signalCommentaryGuard,
signalEntryNowRequirement, multilingualSignalTerms).`),
  edge('signal-override', 'Signals & trading',
    'Applies a user’s stop-loss / take-profit override to a signal.',
    `Lets a customer impose their own stop loss or take profit on incoming signals instead of the channel’s values.`,
    `Validates positive levels and normalises the TP array; worker counterpart applySignalOverride.ts.`),
  edge('signal-reconcile-sweep', 'Signals & trading',
    'Backup cron that re-checks stored signals against Telegram every 2 minutes.',
    `If a trader edits their message, this sweep catches the change and updates our copy — a safety net for the worker’s own
minute-by-minute check.`,
    `POSTs to the listener worker’s /internal/reconcile-signals (worker’s 60 s loop is primary).`),
  edge('signal-review-email', 'Signals & trading',
    'Escalation email for signals held for human review.',
    `When human review is switched on, uncertain signals wait for approval; this sends the reviewer an email about them.`,
    `REVIEW_WINDOW_MS = 2 min must match AI_REVIEW_MAX_AGE_MS in worker/src/retrySignal.ts (feature default: off).`),
  edge('retry-signal', 'Signals & trading',
    'Re-runs a signal through the trade worker.',
    `When a signal failed or needs another attempt, this asks the worker to process it again.`,
    `Proxies to POST {TRADE_WORKER_URL}/internal/retry-signal.`),
  edge('retry-activity', 'Signals & trading',
    'Retries one specific management action from a log row.',
    `If a single "move stop" or "close" action failed, this retries just that action instead of the whole signal.`,
    `POSTs /internal/retry-activity for actions like mgmt_breakeven, mgmt_close, mgmt_modify, mgmt_partial_profit.`),
  edge('force-close-trades', 'Signals & trading',
    'Flattens trades for a user, account, channel or signal on demand.',
    `An emergency "close everything" switch, scoped to exactly what the operator chooses.`,
    `Proxies to the worker /internal/force-close-trades, which is shard-checked (returns reason 'wrong_shard' if the user
belongs elsewhere).`),
  edge('execute-trade', 'Signals & trading',
    'Deprecated stub — trade execution lives in the worker now.',
    `Kept only so old callers fail loudly instead of silently doing nothing; it no longer places any orders.`,
    `Logs execute_trade_stub and exits; superseded by the TradeExecutor (header comment index.ts:1-7).`),
  edge('analyze-channel-profile', 'Signals & trading',
    'Builds a channel’s signal examples and keyword knowledge for the parser.',
    `Learns how one channel writes its signals so the parser understands that channel better next time.`,
    `Writes channel_signal_examples + management keyword groups consumed by the parse chain.`),
  edge('clear-channel-active-params', 'Signals & trading',
    'Clears a channel’s active basket parameters when the position is flat.',
    `Once a channel and symbol have no open trades, its remembered basket settings are wiped so the next signal starts clean.`,
    `Invoked by pg_net from the trades close trigger and called synchronously by the worker.`),
  edge('layering-mode-capabilities', 'Signals & trading',
    'Reports which layering modes the user’s plan unlocks.',
    `Tells the app whether this customer may use static or dynamic layering, and within which limits.`,
    `Limits: static 1–20 layers, dynamic step > 0, max 1–20 layers; plan/allowlist gated.`),
  edge('update-layering-settings', 'Signals & trading',
    'Writes the user’s layering settings.',
    `Saves how this customer wants entries split into layers (mode, layer count, step).`,
    `Gated by plan + admin; fields: layering_mode, range_layering_type, static_layer_count, …`),
  edge('backtest-run', 'Signals & trading',
    'Runs, continues or re-simulates a backtest.',
    `Executes the historical replay that shows what copying a channel would have done.`,
    `Market data from FxSocket via FXSOCKET_API_KEY; can re-simulate a single trade or delete a backtest trade.`),

  edge('fxsocket-broker', 'Broker providers',
    'FxSocket account connect / status / register and broker directory search.',
    `Handles everything FxSocket-specific: connecting an account, checking it is alive, and searching the broker list.`,
    `Writes terminal health rows; classifies connect errors via _shared/brokerConnectError.ts.`),
  edge('mtapi-broker', 'Broker providers',
    'MTAPI connect path: encrypted password storage and migration preparation.',
    `The new-broker connection flow: encrypts the customer’s password, prepares the account for MTAPI, and enforces the
account limit.`,
    `encryptMtPasswordRequired, prepareMtapiMigration, account-limit assertion; status flips via the worker
(mtapiSessionManager).`),
  edge('provider-transition', 'Broker providers',
    'Moves one account between FxSocket and MTAPI safely.',
    `Switches an account from the old connection system to the new one (and back) without losing track of open trades.`,
    `transitionBrokerProvider with a timing-safe token; sets provider_transition_state / provider_transition_target.`),
  edge('systems-health-railway', 'Broker providers',
    'Admin-only reader of Railway deployment logs for the Systems Health cockpit.',
    `Feeds the "worker logs" panel: counts crashes, restarts and realtime failures from Railway’s own log stream.`,
    `RAILWAY_TOKEN + RAILWAY_ENV_ID + RAILWAY_SERVICE_NAMES; called with authSupabase.functions.invoke from systemHealth.ts.`),

  edge('market-news', 'Content feeds',
    'Normalised market news feed (Financial Modeling Prep) with a 5-minute cache.',
    `Powers the Market News page: headlines, cleaned up and enriched, without hammering the news provider.`,
    `FMP_API_KEY; OG-image enrichment; 5 min in-memory cache.`),
  edge('economic-calendar', 'Content feeds',
    'Filtered economic calendar events with a 20-minute cache.',
    `The economic calendar page’s data: upcoming events, filtered to what matters to traders.`,
    `FMP_API_KEY; 20 min in-memory cache.`),

  edge('send-subscription-email', 'Email',
    'Sends a single subscription-related email (invoice, renewal, trial).',
    `Delivers one-off subscription messages to a customer using the shared branded layout.`,
    `Resend (RESEND_API_KEY); layout from _shared/authEmailLayout.ts + brandEmailAssets.ts.`),
  edge('send-subscription-campaigns', 'Email',
    'Campaign runner: batches subscription emails with unsubscribe links.',
    `Sends campaign-style emails to many customers in batches, each with a working unsubscribe link.`,
    `Shared campaign layout; scheduled by the cron created in migration 20260702143623.`),
  edge('email-unsubscribe', 'Email',
    'Unsubscribe endpoint with a signed, tamper-proof token.',
    `When someone clicks "unsubscribe", this validates their personal link and records the choice safely.`,
    `HMAC-signed token compared with timingSafeEqual; renders the unsubscribe page.`),
  edge('manual-broker-override-email', 'Email',
    'Notifies a user about a manual broker override applied by staff.',
    `When an operator overrides something on a broker account, the customer gets an email explaining it.`,
    `Uses the shared branded email layout.`),

  edge('assistant-chat', 'Assistant',
    'The in-app AI assistant: tool-calling chat over the user’s own data.',
    `Answers customer questions and performs confirmed actions (with their approval) by calling tools against their own data.`,
    `OpenAI tool calling with {messages, locale} or {execute:{tool,args}}; guarded by assistantGuard.ts
(guardAssistantUserMessage, sanitizeAssistantText, sanitizeToolArgs) + assistantKnowledge.ts. Writes assistant_threads.`),

  edge('affiliate-profile', 'Affiliate',
    'Creates or normalises a user’s referral code.',
    `Gives each affiliate their shareable code and keeps the profile consistent.`,
    `Normalises the code and creates the affiliate_profiles row when missing.`),
  edge('apply-referral-code', 'Affiliate',
    'Applies a referral code at signup or onboarding.',
    `Records who referred a new customer so the affiliate gets credit.`,
    `Sources: signup_url, signup_form, onboarding, admin; writes referral_attributions + commission_ledger entries.`),
  edge('affiliate-connect', 'Affiliate',
    'Connects an affiliate to Stripe Connect for payouts.',
    `Onboards affiliates so commissions can be paid out to their bank account.`,
    `Stripe Connect flow; payout batches settle commission_ledger rows.`),

  edge('admin-query', 'Admin & internal',
    'Audited read API for this dashboard (overview, users, trades, logs, payouts).',
    `The dashboard’s main way of reading data it cannot query directly: it checks the caller is an admin, runs the read, and
returns JSON.`,
    `requireAuthedAdmin + writeAdminAudit support; actions: overview, users_list, user_360, user_trades, trades_recent,
channels_recent, backtests_recent, copier_logs_recent, affiliate_payouts_overview.`),
  edge('admin-mutate', 'Admin & internal',
    'Audited write API for this dashboard — every mutation needs a reason.',
    `The only way this dashboard writes anything: it requires a human-readable reason, snapshots before/after, and logs who
did what.`,
    `Non-empty reason required; before/after row snapshots; admin_audit_logs entries.`),
  edge('upsert-telegram-channel', 'Admin & internal',
    'Adds or updates a Telegram channel in the registry (with a channel limit).',
    `The method used to register a new signal channel or fix its details, enforcing the allowed number of channels.`,
    `assertTelegramChannelLimit; writes telegram_channels / signal_channels registry rows.`),
];

export const EDGE_GROUPS: readonly string[] = [
  'Auth & onboarding',
  'Billing & entitlement',
  'Signals & trading',
  'Broker providers',
  'Content feeds',
  'Email',
  'Assistant',
  'Affiliate',
  'Admin & internal',
];
