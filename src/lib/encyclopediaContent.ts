/*
 * System Encyclopedia — static content.
 *
 * This is the reference half of the encyclopedia page: what the system is,
 * how each pipeline stage works, and the constants an operator needs. Every
 * entry carries two layers on purpose:
 *   - `plain`     — the whole point in everyday English (no jargon).
 *   - `technical` — the concrete mechanism, for an engineer on call.
 *
 * File paths in `files` point at the TSCopier product repository
 * (~/projects/TSCopier), not this admin repo. Status lists marked "observed"
 * come from code writes, not from database constraints — the database does not
 * enforce them (see the `known-caveats` entry).
 */

export type EncyclopediaCategory = 'system' | 'components' | 'pipeline' | 'data' | 'edge' | 'reference';

export interface EncyclopediaLink {
  label: string;
  to: string;
}

export interface EncyclopediaFact {
  label: string;
  value: string;
}

export interface EncyclopediaEntry {
  id: string;
  category: EncyclopediaCategory;
  title: string;
  summary: string;
  plain: string;
  technical: string;
  facts?: EncyclopediaFact[];
  files?: string[];
  tables?: string[];
  links?: EncyclopediaLink[];
  keywords?: string[];
}

// ---------------------------------------------------------------------------
// Big picture
// ---------------------------------------------------------------------------

const SYSTEM_ENTRIES: EncyclopediaEntry[] = [
  {
    id: 'what-is-tscopier',
    category: 'system',
    title: 'What TScopier is',
    summary: 'A Telegram signal copier: it copies trade signals from Telegram channels into the user’s own MT4/MT5 account.',
    plain: `TScopier watches Telegram channels where trading signals are posted (for example "buy EURUSD at 1.0850, stop loss 1.0830").
When a message like that appears, the system reads it, works out what trade it describes, and places the same trade on every
connected broker account of every user who follows that channel — with the lot size that user chose. It then keeps managing the
trade (moving the stop loss, taking partial profit, closing when the signal says close) until the position is gone.`,
    technical: `Three moving parts: a Node.js worker pair (listener + trade executor) that speaks Telegram's MTProto protocol and the
broker APIs; Supabase (Postgres database, row-level security, edge functions in Deno) for data, auth, billing and AI glue; and a
React frontend served by Netlify. Signals flow: Telegram message → listener parses it → row in the signals table → trade worker
claims it → order sent through FxSocket or MTAPI → trades / trade_execution_logs rows record the outcome.`,
    facts: [
      { label: 'Signal source', value: 'Telegram channels, read over MTProto (GramJS)' },
      { label: 'Execution target', value: 'MT4 / MT5 accounts via FxSocket or MTAPI' },
      { label: 'Parse chain', value: 'Deterministic rules → Cerebras OSS model → GPT-4o (optional reconcile)' },
      { label: 'Copy modes', value: 'AI mode and manual mode per broker account' },
    ],
    files: ['worker/src/userListener.ts', 'worker/src/tradeExecutor/TradeExecutor.ts', 'src/App.tsx'],
    links: [
      { label: 'Dashboard', to: '/' },
      { label: 'Signals', to: '/signals' },
      { label: 'Trades', to: '/trades' },
    ],
    keywords: ['telegram', 'copier', 'signal', 'mt4', 'mt5', 'trading'],
  },
  {
    id: 'deployment-map',
    category: 'system',
    title: 'Where everything runs (deployment map)',
    summary: 'Netlify serves the web apps, Railway runs the workers, Supabase holds the database and edge functions.',
    plain: `The website and the dashboard you are using are static files served by Netlify. The "brains" that read Telegram and send
orders run as background services on Railway. All data lives in Supabase (a hosted PostgreSQL database), and small serverless
functions ("edge functions") sit next to the database for sign-in, billing, email and admin actions.`,
    technical: `Netlify: one build of the TScopier repo serves both tscopier.ai (marketing) and app.tscopier.ai (product); this admin
dashboard (tscopier-admin) is a separate Netlify site. Railway: worker services built from worker/Dockerfile, selected by
WORKER_ROLE (listener, trade, backtest) — the listener is single-replica because one Telegram session can only have one MTProto
connection. Supabase: Postgres + Realtime + ~43 edge functions (Deno), deployed with the Supabase CLI.`,
    facts: [
      { label: 'Frontend', value: 'Netlify — TScopier repo (tscopier.ai + app.tscopier.ai), tscopier-admin repo (this dashboard)' },
      { label: 'Workers', value: 'Railway — listener / trade / backtest services from one Docker image' },
      { label: 'Data + API', value: 'Supabase — Postgres, Realtime, Auth, Storage, Edge Functions' },
      { label: 'Prod project', value: 'sxkpcovbyaficvtkpsdo' },
      { label: 'Staging project', value: 'axdcledcyhyvzrnfkwat' },
    ],
    files: ['netlify.toml', 'worker/Dockerfile', 'docs/railway-architecture.md'],
    links: [
      { label: 'Systems Health', to: '/monitoring/systems-health' },
      { label: 'Worker Leases', to: '/monitoring/workers' },
    ],
    keywords: ['netlify', 'railway', 'supabase', 'deploy', 'infrastructure', 'hosting'],
  },
  {
    id: 'environments',
    category: 'system',
    title: 'Environments: PROD, STAGING, MIGRATION',
    summary: 'Three separate Supabase projects; the toggle in the top bar switches this dashboard between them.',
    plain: `Production is the live system with real customers. Staging is a copy used for testing before changes go live. Migration is a
separate branch database used while broker accounts move from FxSocket to MTAPI. The toggle at the top of this dashboard changes
which database every page reads; a coloured banner shows which one is active so nobody mistakes staging data for production.`,
    technical: `src/lib/environment.ts defines AdminEnv = 'prod' | 'staging' | 'migration', each with its own URL and anon key
(VITE_SUPABASE_* variables, set on Netlify and in the local .env). The migration branch has its own JWT secret — the production
anon key is rejected there. The active environment namespaces the auth and cache keys (adminEnvSessionKey), so switching clears
one environment's session without touching the others.`,
    facts: [
      { label: 'PROD', value: 'sxkpcovbyaficvtkpsdo — live customers' },
      { label: 'STAGING', value: 'axdcledcyhyvzrnfkwat — pre-production testing' },
      { label: 'MIGRATION', value: 'supmsgcubipmmowrzoub — MTAPI migration branch' },
      { label: 'Switch storage', value: 'localStorage[tscopier_admin_env]' },
    ],
    links: [
      { label: 'Broker Accounts', to: '/brokers' },
      { label: 'MTAPI Reconnects', to: '/brokers/mtapi-reconnects' },
    ],
    keywords: ['prod', 'staging', 'migration', 'environment', 'project'],
  },
  {
    id: 'message-journey',
    category: 'system',
    title: 'One Telegram message, end to end',
    summary: 'The full path a single signal message travels, from Telegram to a closed trade on the broker.',
    plain: `A trader posts "buy gold 2030 sl 2025 tp 2040" in a Telegram channel. The listener worker receives the message within
milliseconds, cleans it up, checks it is not a duplicate, and turns it into a structured signal (which symbol, which direction,
which prices). It saves that as a row and hands it to the trade worker. The trade worker looks at every user who follows the
channel, checks each one's settings, takes a lock so the same signal is never executed twice for the same account, and sends the
order to the broker. From then on background monitors keep the trade in step with the channel — new stop loss, partial profit,
close — until the position is closed and the profit is written back.`,
    technical: `handleMessage (worker/src/userListener.ts) → parseSignalForListener → routeSignalParse (deterministic → Cerebras
gpt-oss-120b → optional GPT-4o reconcile) → ensureSignalRow (unique key user_id+channel_id+telegram_message_id, status 'parsed')
→ POST /internal/dispatch-signal (or Redis stream signals:entry) → TradeExecutor.sweep → claimSignalBrokerDispatch (unique per
signal×account) → dispatch.handleSignal → entryPrepare → broker OrderSend (FxSocket/MTAPI) → trades + trade_execution_logs rows →
monitors (trailing stop, auto-management, partial TP, basket reconcile, drift) → close with a close_reason.`,
    files: [
      'worker/src/userListener.ts',
      'worker/src/signalIntent/parseRouting.ts',
      'worker/src/ensureSignalRow.ts',
      'worker/src/tradeExecutor/dispatch.ts',
      'worker/src/tradeExecutor/TradeExecutor.ts',
    ],
    tables: ['signals', 'signal_broker_dispatch_claims', 'trades', 'trade_execution_logs'],
    links: [
      { label: 'All Signals', to: '/signals' },
      { label: 'Execution Logs', to: '/trades/execution-logs' },
      { label: 'Systems Health', to: '/monitoring/systems-health' },
    ],
    keywords: ['journey', 'flow', 'lifecycle', 'end to end', 'signal'],
  },
  {
    id: 'repo-map',
    category: 'system',
    title: 'The codebases',
    summary: 'Three repositories: the product (TSCopier), this admin dashboard, and its docs.',
    plain: `Almost everything lives in the main TScopier repository: the website, the worker that reads Telegram and places trades, and
all database migrations. This dashboard (tscopier-admin) is a separate repository because it is an internal tool with its own
deploy. It only reads the product database and never changes product code.`,
    technical: `TSCopier repo: src/ (product + marketing frontend), worker/ (MTProto listener, trade executor, monitors),
supabase/functions/ (edge functions), supabase/migrations/ (schema), apps/backoffice/ (an older internal panel), docs/.
tscopier-admin repo (this app): src/pages (30+ pages), src/lib (query cache, realtime bridge, health logic),
supabase/ (its own admin-read RLS migrations and email functions). Deployed separately on Netlify.`,
    facts: [
      { label: 'Product', value: '~/projects/TSCopier — frontend, worker, edge functions, migrations' },
      { label: 'This dashboard', value: 'github.com/tartarixinc/tscopier-admin — Netlify, deploys from main' },
      { label: 'Migrations here', value: 'admin read policies + email campaigns only' },
    ],
    links: [{ label: 'App Settings', to: '/settings' }],
    keywords: ['repository', 'codebase', 'monorepo', 'source'],
  },
];

// ---------------------------------------------------------------------------
// Components & services
// ---------------------------------------------------------------------------

const COMPONENT_ENTRIES: EncyclopediaEntry[] = [
  {
    id: 'listener-worker',
    category: 'components',
    title: 'Listener worker (Telegram ingest)',
    summary: 'The process that holds the Telegram connection and turns channel messages into signal rows.',
    plain: `For every user who links their Telegram account, the listener keeps a live connection to Telegram. Every message that
arrives in one of their followed channels is checked: is it a trade signal? If yes, it is parsed and saved. The listener also
handles edited messages (a trader adding a stop loss after posting the entry) and writes an audit trail of everything it does.`,
    technical: `worker/src/userListener.ts — handleMessage (:1954) and handleEditedMessage (:2019) registered with a NewMessage
filter; parseSignalForListener (:2509); catch-up polling after restart via pollChannelNewMessages (:4016) gated by
TELEGRAM_CATCHUP_ON_START (default true, max age 20 min). Persist through ensureSignalRow; audit through persistListenerEvent
(worker/src/listenerEvents.ts). Started by startHttpServer (worker/src/index.ts:212) which also serves the /auth/* Telegram login
routes and /internal/reconcile-signals.`,
    facts: [
      { label: 'Role env', value: 'WORKER_ROLE=listener (or all)' },
      { label: 'Replicas', value: 'Exactly 1 per session — two replicas cause AUTH_KEY_DUPLICATED' },
      { label: 'Protocol', value: 'MTProto via the telegram (GramJS) library' },
      { label: 'Inline parse', value: 'LISTENER_INLINE_PARSE=true (default) parses in-process' },
    ],
    files: ['worker/src/userListener.ts', 'worker/src/httpServer.ts', 'worker/src/authService.ts'],
    tables: ['signals', 'listener_events', 'channel_messages', 'telegram_sessions'],
    links: [
      { label: 'Listener Events', to: '/monitoring/listener-events' },
      { label: 'Telegram Sessions', to: '/telegram/sessions' },
      { label: 'Copier Engine', to: '/monitoring/copier-engine' },
    ],
    keywords: ['listener', 'ingest', 'mtproto', 'telegram connection', 'gramjs'],
  },
  {
    id: 'trade-worker',
    category: 'components',
    title: 'Trade worker (executor)',
    summary: 'The process that picks up parsed signals and places / manages orders on broker accounts.',
    plain: `The trade worker is the half that talks to brokers. It constantly sweeps for signals that are ready, decides which
accounts should copy each one, sends the orders, and then keeps managing those trades — stop loss moves, partial profit,
breakeven, closes — plus a set of background checks that repair anything the broker and our database disagree about.`,
    technical: `worker/src/tradeExecutor/TradeExecutor.ts — sweepLoop (:212) every EXECUTOR_PARSED_SWEEP_MS (default 3000 ms)
reads signals with status='parsed' created within EXECUTOR_REPLAY_MAX_AGE_MS (5 min), limit 50. dispatch.ts handleSignal (:470)
→ entryPrepare → singleEntryExecutor / rangeTradeExecutor / layeringModeIntegration → orderLegExecution. Receives pushed signals
on POST /internal/dispatch-signal (auth: x-internal-token = WORKER_INTERNAL_TOKEN). Started by startTradeMonitors (:118-181)
which also starts the HTTP server and the broker stream proxy.`,
    facts: [
      { label: 'Role env', value: 'WORKER_ROLE=trade (also trade_entry / trade_mgmt)' },
      { label: 'Sweep interval', value: 'EXECUTOR_PARSED_SWEEP_MS = 3000 ms' },
      { label: 'Concurrency', value: 'EXECUTOR_MAX_CONCURRENT_SIGNALS = 4' },
      { label: 'Broker writes', value: 'fenced by broker_accounts.writer_epoch + broker_write_leases' },
    ],
    files: [
      'worker/src/tradeExecutor/TradeExecutor.ts',
      'worker/src/tradeExecutor/dispatch.ts',
      'worker/src/tradeExecutor/entryPrepare.ts',
      'worker/src/index.ts',
    ],
    tables: ['signals', 'trades', 'trade_execution_logs', 'signal_broker_dispatch_claims'],
    links: [
      { label: 'Execution Logs', to: '/trades/execution-logs' },
      { label: 'Open Positions', to: '/trades/open' },
      { label: 'Systems Health', to: '/monitoring/systems-health' },
    ],
    keywords: ['trade worker', 'executor', 'dispatch', 'sweep', 'order send'],
  },
  {
    id: 'worker-roles',
    category: 'components',
    title: 'Worker roles',
    summary: 'One Docker image, several jobs — the WORKER_ROLE variable decides what each service does.',
    plain: `The same worker program can run as different jobs. One deployment only listens to Telegram, another only executes trades,
another only runs backtests. This lets each job scale on its own and keeps the Telegram connection separate from order sending.`,
    technical: `WORKER_ROLE parsed in worker/src/workerConfig.ts:48. Values: all (monolith — listener + monitors + backtest HTTP,
default), listener (ingest only), channel_listener (ingest sharded by signal_channel_id), trade (executor + all monitors),
trade_entry (buy/sell + execution monitors only), trade_mgmt (management + reconcile monitors only), backtest (ephemeral
Telegram client for backtest sync). Production Railway services: Listener (listener), Worker (trade), Backtest (backtest) —
docs/railway-architecture.md:9-14.`,
    facts: [
      { label: 'Default', value: 'WORKER_ROLE=all (single process runs everything)' },
      { label: 'Split roles', value: 'listener | channel_listener | trade | trade_entry | trade_mgmt | backtest' },
      { label: 'Listener hard rule', value: 'never two replicas with the same Telegram session' },
    ],
    files: ['worker/src/workerConfig.ts', 'worker/src/index.ts', 'docs/railway-architecture.md'],
    links: [{ label: 'Worker Leases', to: '/monitoring/workers' }],
    keywords: ['role', 'service', 'railway', 'listener', 'trade'],
  },
  {
    id: 'worker-sharding-leases',
    category: 'components',
    title: 'Sharding and leases',
    summary: 'Users are split across worker replicas, and lease tables stop two processes doing the same job.',
    plain: `When there are too many users for one process, they are split into shards (groups). Every worker knows which shard it owns
and only touches its own users. Small "lease" rows in the database act like a claim slip: before a worker does something
sensitive it takes the lease, and while the lease is alive no other process may do the same thing. This is what prevents double
connections to Telegram and double orders on a broker.`,
    technical: `WORKER_SHARD_ID / WORKER_SHARD_COUNT partition users by a stable hash of user_id — listener and trade services must
agree (startup exits FATAL if TRADE_WORKER_SHARD_URLS.length !== TRADE_WORKER_SHARD_COUNT, validateListenerTradeShardConfig).
Listener→trade fan-out: TRADE_WORKER_SHARD_URLS / TRADE_MGMT_WORKER_SHARD_URLS (index = shard). Lease tables:
worker_session_leases (per-user listener ownership, TTL 45 s, renewed), channel_listener_leases, broker_write_leases,
mt_server_connect_locks. worker_session_leases is readable here (Worker Leases page, Systems Health fleet panel).`,
    facts: [
      { label: 'Shard env', value: 'WORKER_SHARD_ID, WORKER_SHARD_COUNT, TRADE_WORKER_SHARD_URLS' },
      { label: 'Lease TTL', value: 'WORKER_SESSION_LEASE_TTL_MS = 45000 (renewed while alive)' },
      { label: 'Expired lease', value: 'means the worker died or restarted — shown red on Systems Health' },
    ],
    files: ['worker/src/workerConfig.ts', 'worker/src/sessionLease.ts', 'docs/staging-shard-fleet.md'],
    tables: ['worker_session_leases', 'channel_listener_leases', 'broker_write_leases'],
    links: [
      { label: 'Worker Leases', to: '/monitoring/workers' },
      { label: 'Systems Health', to: '/monitoring/systems-health' },
    ],
    keywords: ['shard', 'lease', 'fencing', 'ownership', 'replica'],
  },
  {
    id: 'edge-functions',
    category: 'components',
    title: 'Supabase edge functions',
    summary: 'Small serverless functions next to the database: sign-in, billing, email, admin actions, AI glue.',
    plain: `Anything that must happen securely on a server — sending a password reset email, creating a Stripe checkout, proxying a
retry to the worker — runs as a small standalone function inside Supabase. The dashboard calls two of them for admin reads and
writes; everything else is called by the product app, Stripe, or scheduled crons.`,
    technical: `43 function folders under supabase/functions/, each an index.ts with Deno.serve, deployed with
npm run deploy:function <name>. Shared code lives in supabase/functions/_shared/ (adminAuth, fxsocketClient, mtapiClient,
brokerCredentialsCrypto, subscriptionAccess, planLimits, listenerEvents, …). Admin access is enforced by
requireAuthedAdmin + is_admin() RLS; admin-mutate requires a reason and writes admin_audit_logs rows.`,
    facts: [
      { label: 'Count', value: '43 functions (see the Edge Functions tab for the full catalog)' },
      { label: 'Runtime', value: 'Deno / Supabase Edge — not Node' },
      { label: 'Secrets', value: 'supabase secrets set — never stored in the repo' },
      { label: 'Admin pair', value: 'admin-query (reads) and admin-mutate (writes, audited)' },
    ],
    files: ['supabase/functions/', 'supabase/functions/_shared/', 'scripts/deploy-edge-function.sh'],
    links: [{ label: 'Edge Functions (in this page)', to: '/monitoring/encyclopedia' }],
    keywords: ['edge', 'functions', 'deno', 'serverless', 'api'],
  },
  {
    id: 'product-frontend',
    category: 'components',
    title: 'Product frontend (app.tscopier.ai)',
    summary: 'The customer-facing React app: dashboard, channels, trades, billing, settings.',
    plain: `The website customers use to connect Telegram, link a broker account, choose which channels to follow, watch their trades
and manage their subscription. It reads the same database as this dashboard but through each user's own permissions — a customer
can only ever see their own rows.`,
    technical: `src/ in the TSCopier repo: Vite + React 19 + Tailwind. src/main.tsx picks the app by host (isAppHost): app.tscopier.ai
runs App.tsx (product routes /dashboard, /brokers, /account-trades, /channels, /backtest, /copier-logs, /manage-signals,
/billing, …); tscopier.ai runs MarketingApp.tsx. Env vars (VITE_*) are baked at build time — changing them needs a redeploy.`,
    facts: [
      { label: 'Product host', value: 'app.tscopier.ai' },
      { label: 'Marketing host', value: 'tscopier.ai' },
      { label: 'Build', value: 'Netlify: npm run build → dist/, SPA redirect /* → /index.html' },
    ],
    files: ['src/App.tsx', 'src/main.tsx', 'netlify.toml'],
    links: [{ label: 'All Users', to: '/users' }],
    keywords: ['frontend', 'app', 'customer', 'react', 'website'],
  },
  {
    id: 'admin-dashboard',
    category: 'components',
    title: 'Admin dashboard (this app)',
    summary: 'tscopier-admin: read-mostly internal tool over the same database, gated by is_admin().',
    plain: `This dashboard exists so support and operators can see what is happening without touching the database directly. It reads
live data from whichever environment is selected, performs a small number of audited admin actions (bans, retries, emails), and
never writes product data outside those actions.`,
    technical: `tscopier-admin repo: Vite 5 + React 18 + Tailwind v3 + react-router v7 + @supabase/supabase-js. One anon client
(src/lib/adminSupabase.ts) with the signed-in admin's session; access comes from RLS policies calling is_admin()
(Supabase function). Data layer: src/lib/queryCache.ts (SWR-style cache) + src/hooks/useCachedQuery.ts +
src/lib/realtimeBridge.ts (invalidates the cache when trades/signals change). Verification: npm run typecheck + lint + build
(no test suite).`,
    facts: [
      { label: 'Route pattern', value: 'every page wrapped in ProtectedLayout (AuthGuard + AdminShell)' },
      { label: 'Cache rule', value: 'all reads go through useCachedQuery; mutations call invalidateAll()' },
      { label: 'Realtime tables', value: 'trades and signals are the only tables in the realtime publication' },
    ],
    files: ['src/lib/adminSupabase.ts', 'src/lib/queryCache.ts', 'src/lib/realtimeBridge.ts', 'src/App.tsx'],
    links: [
      { label: 'Overview', to: '/' },
      { label: 'App Settings', to: '/settings' },
    ],
    keywords: ['admin', 'backoffice', 'dashboard', 'internal'],
  },
  {
    id: 'postgres-rls',
    category: 'components',
    title: 'Database, RLS and admin read access',
    summary: 'PostgreSQL with row-level security: users see their own rows, admins see everything they are granted.',
    plain: `Every table is protected by row-level security — a database rule that filters rows per signed-in person. A customer only
ever gets their own signals and trades. Admins get an extra rule that checks "is this user an admin?" and, if so, lets them read
the table. That is why this dashboard can show platform-wide data with nothing but a normal login.`,
    technical: `Helper public.is_admin() (SECURITY DEFINER) reads user_profiles.is_admin + admin_until. Admin SELECT policies were
added migration by migration (20260529210703, 20260529211209 — which also removed recursive EXISTS patterns, 20260702130753
trade_execution_logs, 20260730121100 worker_session_leases, 20260803000000 channel_signals, 20260902120000 assistant_threads,
20260921120000 listener_events). A table without an admin policy does not error — it silently returns zero rows.`,
    facts: [
      { label: 'Admin check', value: 'public.is_admin() — SECURITY DEFINER, checks is_admin + admin_until' },
      { label: 'Failure mode', value: 'missing policy = empty result, not an error (zeros can mean "no access")' },
      { label: 'Writes', value: 'admin-mutate edge function only, with a reason + audit row' },
    ],
    files: ['supabase/migrations/20260529211209_fix_admin_rls_security_definer.sql'],
    links: [{ label: 'Users', to: '/users' }],
    keywords: ['rls', 'row level security', 'is_admin', 'permissions', 'policy'],
  },
  {
    id: 'realtime',
    category: 'components',
    title: 'Realtime updates',
    summary: 'Postgres change events push live updates for trades and signals; everything else refreshes on a timer.',
    plain: `When a trade or signal row changes, the database sends a message to connected dashboards, which then reload their data.
That is why numbers on some pages move without you pressing refresh. Other tables are not pushed, so those pages reload their
cache every few seconds instead.`,
    technical: `src/lib/realtimeBridge.ts subscribes once to postgres_changes on trades and signals (the only tables in the
project's realtime publication — verified on prod) and calls invalidateTags(['trades'|'signals']) in src/lib/queryCache.ts.
Entries carrying those tags go stale, so mounted useCachedQuery hooks refetch. main.tsx also calls invalidateAll() on window
focus / visibilitychange / pageshow. Tables outside the publication rely purely on TTL revalidation.`,
    facts: [
      { label: 'Pushed tables', value: 'trades, signals' },
      { label: 'Channel', value: 'admin-dashboard-realtime (one shared subscription)' },
      { label: 'Fallback', value: 'TTL cache refresh + focus/visibility invalidation' },
    ],
    files: ['src/lib/realtimeBridge.ts', 'src/lib/queryCache.ts', 'src/main.tsx'],
    keywords: ['realtime', 'subscription', 'postgres_changes', 'live', 'invalidation'],
  },
  {
    id: 'redis-queue',
    category: 'components',
    title: 'Signal queue (Redis Streams, optional)',
    summary: 'An optional Upstash Redis queue between listener and trade worker, used instead of a direct HTTP push.',
    plain: `By default the listener hands each parsed signal straight to the trade worker with an HTTP request. If that fails, or if the
optional Redis queue is enabled, signals instead go into a Redis stream (a durable message list) that the trade worker reads at
its own pace. Messages that keep failing end up in a dead-letter list instead of blocking the pipeline.`,
    technical: `worker/src/queue/ — enabled when UPSTASH_REDIS_REST_URL/TOKEN are set (signalQueueConfig.ts:51). Streams:
signals:entry and signals:mgmt, sharded (TRADE_SIGNAL_QUEUE_SHARD_COUNT), consumer concurrency 8, claim idle 30 s,
max attempts 5. Idempotency via signal_queue_idempotency; failures land in signal_queue_dead_letters (readable here — the
Dead Letters page). HTTP push falls back to the queue when TRADE_SIGNAL_PUSH_FALLBACK_ON_QUEUE_FAIL=true (default).`,
    facts: [
      { label: 'Streams', value: 'signals:entry (orders) and signals:mgmt (management)' },
      { label: 'Dead letters', value: 'signal_queue_dead_letters — replayed from the Dead Letters page' },
      { label: 'Canary', value: 'TRADE_SIGNAL_QUEUE_CANARY_SHARDS limits the queue to selected shards' },
    ],
    files: ['worker/src/queue/', 'worker/src/tradeSignalPush.ts'],
    tables: ['signal_queue_idempotency', 'signal_queue_dead_letters'],
    links: [{ label: 'Dead Letters', to: '/monitoring/dead-letters' }],
    keywords: ['redis', 'queue', 'stream', 'upstash', 'dead letter'],
  },
  {
    id: 'telegram-mtproto',
    category: 'components',
    title: 'Telegram connection (MTProto)',
    summary: 'Each linked account logs into Telegram itself — not through a bot — using MTProto credentials.',
    plain: `TScopier does not use a Telegram bot. Each user links their own Telegram account by entering a phone number and code (or
scanning a QR code). That produces a session file the worker uses to read channels exactly as the user would on their phone,
including private channels they are a member of. Only one worker process may hold a session at a time.`,
    technical: `Session material lives in telegram_sessions.session_string; login flows are served by the worker HTTP API
(/auth/send_code, /auth/verify_code, /auth/start_qr, … — worker/src/httpServer.ts) and proxied by the telegram-auth edge
function (deliberately not an MTProto client itself: IP/DC churn previously caused an account ban). Duplicate use of one auth
key raises AUTH_KEY_DUPLICATED — recovery logic in worker/src/authKeyDuplicatedRecovery.ts.`,
    facts: [
      { label: 'Login routes', value: '/auth/* on the listener worker, proxied by the telegram-auth edge function' },
      { label: 'Hard rule', value: 'one MTProto connection per auth key (single-replica listener)' },
      { label: 'Catch-up', value: 'after restart, messages from the last 20 minutes are polled and parsed' },
    ],
    files: ['worker/src/authService.ts', 'worker/src/httpServer.ts', 'supabase/functions/telegram-auth/index.ts'],
    tables: ['telegram_sessions', 'telegram_auth_pending', 'telegram_account_claims'],
    links: [
      { label: 'Telegram Sessions', to: '/telegram/sessions' },
      { label: 'Auth Pending', to: '/telegram/auth-pending' },
    ],
    keywords: ['mtproto', 'session', 'login', 'qr', 'phone code', 'auth key'],
  },
  {
    id: 'fxsocket-provider',
    category: 'components',
    title: 'FxSocket (broker provider)',
    summary: 'The original broker connection layer — HTTP/WebSocket API in front of the user’s MT4/MT5 terminal.',
    plain: `Most broker accounts are reached through FxSocket: we send orders to its API, and its expert advisor inside the user's
terminal executes them on the broker. It also streams account balance, positions and connection health back to us.`,
    technical: `Edge side: supabase/functions/fxsocket-broker (connect/status/register, terminal health rows, connect-error
classification, directory search). Worker side: worker/src/brokerGateway.ts + _shared/fxsocketClient.ts patterns
(FXSOCKET_API_KEY, FXSOCKET_BASE_URL). Account fields: fxsocket_account_id, fxsocket_status, connection_status ∈
{pending, connected, recovering, error}. Default provider when broker_accounts.provider is null (providerResolver.ts:35).`,
    facts: [
      { label: 'Provider value', value: "provider = 'fxsocket' (default / legacy)" },
      { label: 'Health', value: 'heartbeat 30 s, marked down after 4 failures, reconnect backoff up to 300 s' },
      { label: 'Expire rule', value: 'cron disconnects brokers after subscription grace (disconnect-expired-fxsocket-brokers)' },
    ],
    files: ['worker/src/brokerGateway.ts', 'worker/src/providerResolver.ts', 'supabase/functions/fxsocket-broker/index.ts'],
    tables: ['broker_accounts'],
    links: [
      { label: 'Broker Accounts', to: '/brokers' },
      { label: 'Connection Errors', to: '/brokers/errors' },
    ],
    keywords: ['fxsocket', 'broker', 'provider', 'mt4', 'mt5', 'terminal'],
  },
  {
    id: 'mtapi-provider',
    category: 'components',
    title: 'MTAPI (broker provider, migration)',
    summary: 'The newer broker connection layer that every customer account is moving to.',
    plain: `MTAPI is the replacement for FxSocket. Each account is switched over individually: the customer reconnects with their
broker password, the system stores it encrypted, and from then on orders go through the MTAPI service instead. Until an account
is switched it keeps using FxSocket, so both providers can run side by side.`,
    technical: `Edge side: mtapi-broker (encrypted password handling — encryptMtPasswordRequired, prepareMtapiMigration,
account-limit assertion), provider-transition (transitionBrokerProvider with a timing-safe token, sets
provider_transition_state/target). Worker side: mtApiByAccount.ts (session resolution), mtapiProvider.ts (HTTP endpoints
/ConnectEx, /OrderSendSafe, /OrderCloseSafe, …), mtapiSessionManager.ts (flips mtapi_status to connected/error after a
reconnect attempt). An account counts as reconnected when mtapi_status IS NOT NULL.`,
    facts: [
      { label: 'Provider value', value: "provider = 'mtapi'" },
      { label: 'Status column', value: 'mtapi_status: NULL = never reconnected, then connecting → connected / error' },
      { label: 'Credentials', value: 'broker password encrypted with BROKER_CREDENTIALS_ENCRYPTION_KEY (must match the edge secret)' },
      { label: 'Fence', value: 'writer_epoch + provider_transition_state guard provider switches' },
    ],
    files: ['worker/src/mtapiProvider.ts', 'worker/src/mtapiSessionManager.ts', 'supabase/functions/mtapi-broker/index.ts'],
    tables: ['broker_accounts'],
    links: [{ label: 'MTAPI Reconnects', to: '/brokers/mtapi-reconnects' }],
    keywords: ['mtapi', 'migration', 'provider', 'reconnect', 'password'],
  },
  {
    id: 'background-monitors',
    category: 'components',
    title: 'Background monitors',
    summary: 'A dozen always-on jobs that keep open trades in sync with the channel and the broker.',
    plain: `Placing the order is only the start. These background jobs watch for stop-loss changes, take partial profit, move stops to
breakeven, apply trailing stops, close positions the broker closed on its own, repair baskets whose targets drifted, flatten
everything before major news, and reconcile any difference between what we think is open and what the broker says is open.`,
    technical: `Started by startTradeMonitors (worker/src/index.ts:118-181): VirtualPendingMonitor, RangeBrokerPendingMonitor,
CweCloseMonitor, PartialTpMonitor, SignalEntryPendingMonitor, OpenTradeReconcileMonitor, ClosedTradeFillMonitor,
TradeBrokerDriftMonitor, SignalRangeEntryMonitor (conditional), CopyLimitMonitor, TrailingStopMonitor, AutoManagementMonitor,
BasketSlTpReconcileMonitor, NewsTradingMonitor, V2ReconcileMonitor (EXECUTION_ENGINE=v2 only). Also startTradeLogRetention:
trade_execution_logs pruned every 10 min, keeping 500 rows per user.`,
    facts: [
      { label: 'Count', value: '15 monitors + log retention' },
      { label: 'Trigger style', value: 'tick + idle intervals, per-monitor env pairs (e.g. TRAILING_STOP_*)' },
      { label: 'Evidence', value: 'each action writes a trade_execution_logs row' },
    ],
    files: ['worker/src/index.ts', 'worker/src/autoManagementMonitor.ts', 'worker/src/basketSlTpReconcile.ts'],
    tables: ['trades', 'trade_execution_logs'],
    links: [{ label: 'Execution Logs', to: '/trades/execution-logs' }],
    keywords: ['monitor', 'trailing', 'breakeven', 'reconcile', 'news', 'basket'],
  },
];

// ---------------------------------------------------------------------------
// Pipeline stages
// ---------------------------------------------------------------------------

const PIPELINE_ENTRIES: EncyclopediaEntry[] = [
  {
    id: 'stage-ingest',
    category: 'pipeline',
    title: '1. Telegram ingest',
    summary: 'A channel message (or edit) arrives over MTProto and is picked up by the listener.',
    plain: `The moment a trader posts in a followed channel, the listener receives it. If the trader edits the message later — often to
add the stop loss — that edit arrives too and is treated as a follow-up to the original signal. After a worker restart, the
listener also reads the last 20 minutes of messages so nothing posted during the gap is lost.`,
    technical: `handleMessage (userListener.ts:1954), handleEditedMessage (:2019), NewMessage filter registered at :1433-1454.
Catch-up: pollChannelNewMessages (:4016) with TELEGRAM_CATCHUP_ON_START=true, TELEGRAM_CATCHUP_MAX_AGE_MINUTES=20,
TELEGRAM_CATCHUP_PARSE_CONCURRENCY=2, TELEGRAM_LIVE_PRIORITY_PAUSE_MS=500 (worker/.env.example:28-45). Entry settle:
teaser messages (entry first, SL/TP added by a later edit) wait ENTRY_MESSAGE_SETTLE_MS (10 s, extra 10/30 s delays).`,
    files: ['worker/src/userListener.ts'],
    tables: ['channel_messages', 'telegram_channels'],
    links: [{ label: 'Listener Events', to: '/monitoring/listener-events' }],
    keywords: ['ingest', 'newmessage', 'edit', 'catch up', 'settle'],
  },
  {
    id: 'stage-normalize-reconcile',
    category: 'pipeline',
    title: '2. Normalization and Telegram reconciliation',
    summary: 'Message text is cleaned up, and stored signals are re-checked against later Telegram edits.',
    plain: `Before anything is parsed, the raw text is normalized: emoji noise, extra spaces and stretched spellings like "breakevennn"
are cleaned so the pattern rules match reliably. Separately, a sweep runs every minute to compare stored signals with what the
channel now says — if a trader edited the original message, our copy is updated to match.`,
    technical: `normalizeTelegramMessageText + collapseCasualSignalTypos (_shared/). Reconcile sweep: SIGNAL_RECONCILE_SWEEP_MS
60 s, window 6 h, max 100 signals (worker/.env.example:263-268); backup cron signal-reconcile-sweep (edge) POSTs to
/internal/reconcile-signals every 2 min. Edits mark signals via telegram_edit_date_seen / telegram_reconciled_at and re-run the
parse for structured changes.`,
    files: ['worker/src/userListener.ts', 'supabase/functions/_shared/normalizeTelegramMessageText.ts'],
    tables: ['signals', 'channel_messages'],
    keywords: ['normalize', 'reconcile', 'edit', 'typo', 'sweep'],
  },
  {
    id: 'stage-listener-events',
    category: 'pipeline',
    title: '3. Listener event trail',
    summary: 'Every interesting listener outcome is appended to an audit table with a retention window.',
    plain: `Not every message becomes a signal — and when something goes wrong (a channel cannot be resolved, a session disconnects,
an assistant tool call runs), it is written to an audit table. That is what the Listener Events page shows, and it is usually
the first place to look when a user says "my channel stopped working".`,
    technical: `persistListenerEvent (worker/src/listenerEvents.ts) with ~30 call sites in userListener.ts; event catalogue and
retention (7 d / 30 d / 90 d by type, pruned hourly by prune_listener_events) in docs/listener-events-reference.md. Table:
listener_events (user_id, channel_row_id, telegram_message_id, event_type, detail jsonb, created_at). Admin SELECT policy:
migration 20260921120000 — apply to staging + prod before the panel shows rows.`,
    files: ['worker/src/listenerEvents.ts', 'docs/listener-events-reference.md'],
    tables: ['listener_events'],
    links: [{ label: 'Listener Events', to: '/monitoring/listener-events' }],
    keywords: ['audit', 'events', 'listener_events', 'trail'],
  },
  {
    id: 'stage-dedupe',
    category: 'pipeline',
    title: '4. Duplicate protection at persist',
    summary: 'A unique key per user + channel + message ID guarantees one real signal per Telegram message.',
    plain: `Telegram can deliver the same message more than once (reconnects, catch-up, edits). Before saving, the system checks
whether that exact message has already produced a signal for this user. If it has, it writes a harmless placeholder instead of
a second executable signal — so the same message can never open the same trade twice.`,
    technical: `ensureSignalRow (worker/src/ensureSignalRow.ts): upsert keyed on (user_id, channel_id, telegram_message_id).
If another signal already owns the message, a non-executable stub with status='skipped' is written (:87-121, stub status :104)
and the caller does not dispatch. This is guard 1 of 2; guard 2 is the dispatch claim (see duplicate-protection).`,
    files: ['worker/src/ensureSignalRow.ts'],
    tables: ['signals'],
    links: [{ label: 'All Signals', to: '/signals' }],
    keywords: ['dedupe', 'duplicate', 'unique', 'stub', 'upsert'],
  },
  {
    id: 'stage-parse',
    category: 'pipeline',
    title: '5. Parsing (rules → AI)',
    summary: 'Three-stage chain: deterministic rules first, a fast OSS model second, optional GPT-4o reconcile third.',
    plain: `Turning "buy gold 2030 sl 2025 tp 2040" into structured data happens in stages. Stage 1 is deterministic pattern matching
using each channel's own keyword list — fast and free. If that is not confident enough (or the mode says so), stage 2 asks a fast
open-source language model running on Cerebras to read the message. Stage 3, when enabled, lets GPT-4o double-check only the
uncertain cases. Which path was taken is recorded on every signal.`,
    technical: `Entry: routeSignalParse (signalIntent/parseRouting.ts:442), mode from UNIVERSAL_PARSE_MODE (off | shadow |
fastpath | primary; default shadow — deterministic result is used, stage 2 runs in background only to log a diff). Stage 1:
parseDeterministicForUniversal with per-channel channel_keywords + channel_signal_lexicon (cache TTL 5 min). Stage 2:
parseUniversalSignal — CEREBRAS_PARSE_MODEL default gpt-oss-120b, key rotation CEREBRAS_API_KEY_1..N, retries 2; falls back to
OpenAI (UNIVERSAL_PARSE_MODEL → gpt-4o-mini) when Cerebras is unavailable. Stage 3: runStageThree, default model gpt-4o, only
when UNIVERSAL_PARSE_RECONCILE_ENABLED=true (default false) and shouldReconcileSignal triggers. Extra gates: modification
grounding (an SL/TP change must target an open trade in that channel), AI veto (UNIVERSAL_PARSE_AI_VETO_ENABLED, default false),
human-review escalation (default false — otherwise uncertain signals are skipped). Legacy paths: aiParseEntry /
aiParseModification (gpt-4o-mini).`,
    facts: [
      { label: 'Modes', value: 'off | shadow (default) | fastpath | primary' },
      { label: 'Stage 2 model', value: 'gpt-oss-120b on Cerebras, OpenAI gpt-4o-mini fallback' },
      { label: 'Stage 3 model', value: 'gpt-4o, off by default (UNIVERSAL_PARSE_RECONCILE_ENABLED=false)' },
      { label: 'Recorded as', value: 'signals.pipeline_ts stage timings + trade decision chain in the admin Signals page' },
    ],
    files: [
      'worker/src/signalIntent/parseRouting.ts',
      'worker/src/signalIntent/parseConfig.ts',
      'worker/src/aiParseEntry.ts',
      'worker/src/aiParseModification.ts',
    ],
    tables: ['signals', 'channel_signal_lexicon', 'channel_signal_examples'],
    links: [{ label: 'All Signals', to: '/signals' }, { label: 'Signal Stats', to: '/signals/stats' }],
    keywords: ['parse', 'regex', 'cerebras', 'gpt-4o', 'ai', 'model', 'chain'],
  },
  {
    id: 'stage-persist',
    category: 'pipeline',
    title: '6. Persist (signals table)',
    summary: 'The parsed signal is written to the signals table with status "parsed" and full timing stamps.',
    plain: `Once understood, the signal becomes a row in the signals table: what was said, what it means, and every timestamp of how
long each step took. Status starts as "parsed", which means "ready for a trade worker to pick up".`,
    technical: `ensureSignalRow writes status='parsed' by default (:48); status column default is 'pending' (core schema
20260505092235:184), used only when LISTENER_INLINE_PARSE=false and the parse-signal edge function does it. pipeline_ts (jsonb,
migration 20260724120000) stores epoch-ms stamps — see pipeline-timestamps. Columns include raw_message, parsed_data,
user_override, skip_reason, is_modification, parent_signal_id, telegram_message_id.`,
    files: ['worker/src/ensureSignalRow.ts', 'worker/src/pipelineTimestamps.ts'],
    tables: ['signals'],
    links: [{ label: 'All Signals', to: '/signals' }],
    keywords: ['persist', 'signals row', 'parsed', 'pipeline_ts'],
  },
  {
    id: 'stage-dispatch',
    category: 'pipeline',
    title: '7. Dispatch (listener → trade worker)',
    summary: 'The signal is pushed to the trade worker by HTTP, or queued in Redis, and also swept as a fallback.',
    plain: `The listener does not place orders itself — it hands the signal to the trade worker. Three handover paths exist: a direct
HTTP push (default), an optional Redis queue, and a safety net where the trade worker scans the signals table every few seconds
for anything ready that nobody picked up. That combination means a dropped handover delays a copy by seconds, not forever.`,
    technical: `HTTP: POST {TRADE_WORKER_URL}/internal/dispatch-signal (tradeSignalPush.ts:245), timeout/attempt/retry env
TRADE_SIGNAL_PUSH_*. Queue: Redis streams signals:entry / signals:mgmt (see redis-queue entry). Sweep: TradeExecutor.sweepLoop
reads status='parsed' newer than EXECUTOR_REPLAY_MAX_AGE_MS (5 min), limit 50, every 3000 ms. Action routing:
tradeSignalActions.ts — entries (buy/sell) vs management (close, breakeven, modify, partial_*, delete_pendings); role mode
trade_entry / trade_mgmt filters which actions a service handles; priority high for entries, close, modify.`,
    files: ['worker/src/tradeSignalPush.ts', 'worker/src/tradeSignalActions.ts', 'worker/src/tradeExecutor/dispatch.ts'],
    tables: ['signals', 'signal_broker_dispatch_claims'],
    links: [{ label: 'Execution Logs', to: '/trades/execution-logs' }],
    keywords: ['dispatch', 'push', 'http', 'queue', 'sweep', 'handover'],
  },
  {
    id: 'stage-entry-execution',
    category: 'pipeline',
    title: '8. Entry execution',
    summary: 'For every eligible broker account: plan the order, take the claim, send it to the broker.',
    plain: `This is where the order is actually placed. The worker works out which of the user's accounts should copy the signal and
with what lot size, checks the channel and account settings, takes a lock so no other process can send the same order, then sends
it to the broker. If the stop loss or take profit is not known yet (a "teaser" signal), the entry waits in a holding table until
the levels arrive.`,
    technical: `dispatch.handleSignal (:470) → entryPrepare.ts (planning, merge routing, channel/broker config) →
singleEntryExecutor / rangeTradeExecutor / layeringModeIntegration → orderLegExecution → broker OrderSend. Safety rails in
order: claimSignalBrokerDispatch (unique signal×account, fail-closed) → in-flight guard → signalAlreadyHandled → range-entry
wait gate → writer_epoch fence → queue idempotency → MT_PER_ACCOUNT_TRADE_CONCURRENCY (default 3). Entry gates:
signal_entry_pending_orders + SignalEntryPendingMonitor; range waits: signal_range_entry_waits + SignalRangeEntryMonitor.
Engine: EXECUTION_ENGINE=v1 (default) or v2, staged by EXECUTION_ENGINE_V2_BROKERS / _USERS. Layering is fail-closed
(LAYERING_MODES_PREPARE_ONLY and LAYERING_MODES_KILL_SWITCH both default true).`,
    files: [
      'worker/src/tradeExecutor/entryPrepare.ts',
      'worker/src/tradeExecutor/singleEntryExecutor.ts',
      'worker/src/tradeExecutor/orderLegExecution.ts',
    ],
    tables: ['trades', 'signal_broker_dispatch_claims', 'signal_entry_pending_orders', 'signal_range_entry_waits'],
    links: [{ label: 'Open Positions', to: '/trades/open' }, { label: 'Execution Logs', to: '/trades/execution-logs' }],
    keywords: ['entry', 'order send', 'claim', 'lot size', 'layering', 'pending'],
  },
  {
    id: 'stage-management',
    category: 'pipeline',
    title: '9. Trade management',
    summary: 'Later messages modify the trade: stop loss moves, breakeven, partial profit, basket changes, closes.',
    plain: `Traders rarely post once and forget. "Move SL to entry", "close half", "TP2 hit" — each of these is a follow-up message that
the system applies to the trades it opened from that channel. Related trades for the same channel and symbol are managed together
as a "basket" so their stops and targets stay consistent.`,
    technical: `managementExecutor.ts handles close, close_worse_entries, breakeven, partial_profit, partial_breakeven, modify,
delete_pendings — each writing trade_execution_logs (action values mgmt_close, mgmt_modify, …). Merge/basket:
multiTradeMerge.ts, basketMerge/ (slTpRefresh, legTpSync), basketModFollowUp.ts, basketSlTpReconcile.ts; a basket is the latest
open set for channel+symbol (WORKER_LEGACY_MERGE_LINKING=true reverts to reply/thread linking). Parse side: modification
grounding ensures a stop-loss edit targets an open trade of that channel before it is applied.`,
    files: [
      'worker/src/tradeExecutor/managementExecutor.ts',
      'worker/src/basketMerge/slTpRefresh.ts',
      'worker/src/basketModFollowUp.ts',
    ],
    tables: ['trades', 'trade_execution_logs', 'basket_sl_tp_targets', 'layering_plans'],
    links: [{ label: 'Copier Logs', to: '/copier-logs' }, { label: 'Activities', to: '/trades/execution-logs' }],
    keywords: ['management', 'modify', 'breakeven', 'partial', 'basket', 'merge'],
  },
  {
    id: 'stage-close-reconcile',
    category: 'pipeline',
    title: '10. Close and reconcile',
    summary: 'Closes come from signals or from the broker — monitors detect both and write the reason back.',
    plain: `A trade ends in two ways: we close it because a signal said so, or the broker closes it (stop loss or take profit hit).
The first is straightforward. For the second, monitors constantly compare our records with the broker: when they see a position
has gone, they mark the trade closed, fill in the close price and profit, and record why.`,
    technical: `Close reasons (worker/src/tradeCloseReasons.ts): signal_close, signal_revision, opposite_signal, partial_tp,
auto_management, close_worse_entries, news_pre_close, copy_limit_flatten, user_force_close, position_gone. Broker-side SL/TP
closes leave close_reason NULL and are inferred from prices in the frontend. Monitors: OpenTradeReconcileMonitor,
ClosedTradeFillMonitor (backfills close_price/profit), TradeBrokerDriftMonitor (reverse reconcile), V2ReconcileMonitor;
CLOSED_TRADE_CLOSE_PRICE_* env tunes the backfill. News: NewsTradingMonitor flattens before high-impact events.`,
    files: ['worker/src/tradeCloseReasons.ts', 'worker/src/openTradeReconcileMonitor.ts'],
    tables: ['trades', 'trade_execution_logs'],
    links: [{ label: 'All Trades', to: '/trades' }, { label: 'Analytics', to: '/trades/analytics' }],
    keywords: ['close', 'reconcile', 'drift', 'position gone', 'news', 'sl', 'tp'],
  },
  {
    id: 'duplicate-protection',
    category: 'pipeline',
    title: 'Duplicate protection (the full stack)',
    summary: 'Six layers that together guarantee one Telegram message never becomes two copies on one account.',
    plain: `Copying a trade twice on someone's account is the worst bug this system could have, so duplicate prevention is layered:
dedupe at save time, a lock per signal and account before sending, an in-flight guard, a "already handled" check, a queue
idempotency record, and a revision guard for edits. Any single layer failing still leaves the others.`,
    technical: `(1) ensureSignalRow unique key (user_id, channel_id, telegram_message_id) → skipped stub. (2) claimSignalBrokerDispatch
— unique (signal_id, broker_account_id) in signal_broker_dispatch_claims, fail-closed on error (TradeExecutor.ts:1504).
(3) this.inflight set — the sweep skips rows already being handled (:702). (4) signalAlreadyHandled → markSignalExecuted
(:704-706). (5) signal_queue_idempotency for the Redis path. (6) messageRevisionIdempotency / revisionIdempotency for edited
messages. Plus range-entry waits and the writer_epoch broker-write fence.`,
    facts: [
      { label: 'Claim table', value: 'signal_broker_dispatch_claims — unique per signal × broker account' },
      { label: 'Claim caveat', value: 'a mutex, not a ledger — rows are released on range-wake/retry, so counts are attempts' },
      { label: 'Fail mode', value: 'fail-closed: a claim error stops the send rather than risking a double order' },
    ],
    files: ['worker/src/ensureSignalRow.ts', 'worker/src/tradeExecutor/TradeExecutor.ts'],
    tables: ['signal_broker_dispatch_claims', 'signal_queue_idempotency', 'signals'],
    links: [{ label: 'Systems Health', to: '/monitoring/systems-health' }],
    keywords: ['duplicate', 'idempotency', 'claim', 'mutex', 'double order'],
  },
  {
    id: 'pipeline-timestamps',
    category: 'pipeline',
    title: 'Pipeline timestamps and latency',
    summary: 'Every signal records when each step started and finished, so latency can be measured per stage.',
    plain: `Each signal carries a small timing diary: when the message arrived, when parsing finished, when it was handed over, when
the broker was asked, when the broker confirmed. From those stamps the system derives the numbers shown on the trade pipeline
analytics screens (parse time, dispatch time, total time).`,
    technical: `worker/src/pipelineTimestamps.ts → signals.pipeline_ts (jsonb, epoch ms). Legacy t_* keys
(t_telegram_event, t_stage1_started_at, t_parse_done, t_dispatch_sent, t_order_send_*, …) plus descriptive keys
(telegram_message_received_at, parse_started_at/completed_at, queue_*, execution_claim_*, broker_request_started_at,
broker_execution_confirmed_at, reconciliation_*). Derived metrics (:253-277): telegram_to_listener_ms, parse_ms, dispatch_ms,
queue_wait_ms, prep_ms, execution_claim_ms, order_send_ms, broker_ack_ms, total_ms. Execution-phase timings also land on
trade_execution_logs rows with action='pipeline_summary' (used by Systems Health end-to-end latency).`,
    files: ['worker/src/pipelineTimestamps.ts', 'worker/src/signalIntent/parseRouting.ts'],
    tables: ['signals', 'trade_execution_logs'],
    links: [
      { label: 'Trades Analytics', to: '/trades/analytics' },
      { label: 'Systems Health', to: '/monitoring/systems-health' },
    ],
    keywords: ['latency', 'timing', 'pipeline_ts', 'duration', 'p50', 'p95'],
  },
  {
    id: 'signal-actions',
    category: 'pipeline',
    title: 'Signal actions (the vocabulary of parsed_data)',
    summary: 'What parsed_data.action can mean: orders (buy/sell) vs management (close, modify, …).',
    plain: `Every parsed signal carries an action — what should happen. The two order actions are buy and sell. Everything else
manages trades that already exist: close, move the stop, take partial profit, delete pending orders. The dispatcher uses this to
decide which worker role handles the message and how urgent it is.`,
    technical: `tradeSignalActions.ts: management actions close, close_worse_entries, breakeven, partial_profit,
partial_breakeven, modify, delete_pendings (:11); entry actions buy, sell (:22); role mode trade_entry / trade_mgmt / all
(:26-31); priority high for entries, close, close_worse_entries, modify (:50). Other parsed values seen internally: ignore,
subscribe, order_send, trailing_stop, auto_be, cwe_close, partial_tp_fired, virtual_pending_*, mgmt_*, merge_*.`,
    files: ['worker/src/tradeSignalActions.ts'],
    tables: ['signals'],
    links: [{ label: 'All Signals', to: '/signals' }],
    keywords: ['action', 'buy', 'sell', 'close', 'modify', 'priority'],
  },
];

// ---------------------------------------------------------------------------
// Reference
// ---------------------------------------------------------------------------

const REFERENCE_ENTRIES: EncyclopediaEntry[] = [
  {
    id: 'signal-statuses',
    category: 'reference',
    title: 'signals.status values (observed)',
    summary: 'pending → parsed → executed / failed / skipped, with "skipped" also used for duplicate stubs.',
    plain: `Every signal row has a status that says how far it got. "pending" means not parsed yet; "parsed" means ready to copy;
"executed" means we finished attempting it; "failed" means the attempt failed; "skipped" means we deliberately did not copy it
(for example a duplicate, or a filter rejected it) — the reason is in skip_reason.`,
    technical: `Observed values (no DB CHECK constraint — derived from code writes): pending (DDL default, core schema :184;
edge-parse fallback userListener.ts:3380), parsed (ensureSignalRow.ts:48 and re-queues in dispatch.ts), skipped (duplicate stub
ensureSignalRow.ts:104 + dispatch/management skip paths), executed (dispatch.ts:417, managementExecutor, TradeExecutor.ts:770),
failed (dispatch.ts:1100). PARSED_STATUSES = {'parsed'} is the only claimable state (tradeExecutor/types.ts:29).`,
    facts: [
      { label: 'pending', value: 'not yet parsed (edge-parse mode or DDL default)' },
      { label: 'parsed', value: 'ready for a trade worker — the only claimable state' },
      { label: 'executed', value: 'execution attempt finished successfully' },
      { label: 'failed', value: 'execution attempt failed — see trade_execution_logs' },
      { label: 'skipped', value: 'deliberately not copied — reason in skip_reason (includes duplicate stubs)' },
    ],
    tables: ['signals'],
    links: [{ label: 'All Signals', to: '/signals' }, { label: 'Signal Stats', to: '/signals/stats' }],
    keywords: ['status', 'enum', 'pending', 'parsed', 'executed', 'failed', 'skipped'],
  },
  {
    id: 'trade-statuses',
    category: 'reference',
    title: 'trades.status values (observed)',
    summary: 'open, closed, cancelled, pending — with closed/cancelled both counted as "done".',
    plain: `A trade row is "open" while the position is live at the broker, and "closed" once it is finished. "cancelled" appears when
an order never became a position, and "pending" when a trade is staged but not yet live.`,
    technical: `Observed values: open, closed, cancelled, pending (no DB constraint; the frontend normalises closed/cancelled into
one bucket — src/lib/dbTradesFallback.ts:68 in the product repo). Key fields: symbol, direction, entry_price, sl, tp, tp_levels,
lot_size, opened_at, closed_at, close_reason, profit, close_price, broker_account_id, signal_id.`,
    facts: [
      { label: 'open', value: 'position live at the broker; profit column tracks floating P&L' },
      { label: 'closed', value: 'finished; closed_at + profit + close_price set (sometimes backfilled by monitors)' },
      { label: 'cancelled', value: 'order never became a position' },
      { label: 'pending', value: 'staged, not yet live' },
    ],
    tables: ['trades'],
    links: [{ label: 'All Trades', to: '/trades' }, { label: 'Open Positions', to: '/trades/open' }],
    keywords: ['trade status', 'open', 'closed', 'cancelled'],
  },
  {
    id: 'execution-log-statuses',
    category: 'reference',
    title: 'trade_execution_logs: statuses and actions',
    summary: 'attempt / success / failed per action — this is the copier log feed.',
    plain: `Every order attempt, modification and close leaves a log line: what was attempted (action), whether it succeeded
(status), and the broker's answer if it failed. This is the raw material behind the Copier Logs and Execution Logs pages and the
failure analysis on Systems Health.`,
    technical: `Statuses: attempt, success, failed. Actions include entry/order send plus management values (mgmt_close,
mgmt_modify, mgmt_breakeven, mgmt_partial_profit, …), monitor actions (trailing stop, auto management, basket reconcile) and
diagnostic rows (action='pipeline_summary' carries end-to-end timing in request_payload.total_ms). Workers write reason_code
into request_payload; Systems Health classifies failures into system / external / user / unclassified buckets from it (or from
error_message text when missing). Retention: pruned every 10 min keeping 500 rows per user.`,
    facts: [
      { label: 'Statuses', value: 'attempt | success | failed' },
      { label: 'Reason codes', value: 'request_payload.reason_code (e.g. INSUFFICIENT_MARGIN, MARKET_CLOSED, UNKNOWN_TICKET)' },
      { label: 'Retention', value: 'TRADE_LOG_RETENTION_INTERVAL_MS = 10 min, keep 500 per user' },
    ],
    tables: ['trade_execution_logs'],
    links: [
      { label: 'Execution Logs', to: '/trades/execution-logs' },
      { label: 'Copier Logs', to: '/copier-logs' },
      { label: 'Errors', to: '/errors' },
    ],
    keywords: ['logs', 'attempt', 'success', 'failed', 'reason code', 'action'],
  },
  {
    id: 'close-reasons',
    category: 'reference',
    title: 'trades.close_reason values',
    summary: 'Why a trade ended: signal, management, news, limits, force close, or position gone.',
    plain: `When a trade closes, the system records why. This distinguishes "the channel said close", "we closed it before the news
release", and "the broker closed it on its own (stop loss hit)" — the last of which leaves the field empty and is inferred from
prices.`,
    technical: `worker/src/tradeCloseReasons.ts (kept in sync with the product's src/lib/tradeCloseReason.ts): signal_close,
signal_revision, opposite_signal, partial_tp, auto_management, close_worse_entries, news_pre_close, copy_limit_flatten,
user_force_close, position_gone. NULL = broker-side SL/TP fill (inferred from entry/close prices in the UI).`,
    facts: [
      { label: 'signal_close', value: 'a close message arrived in the channel' },
      { label: 'position_gone', value: 'the broker position disappeared — detected by drift reconcile' },
      { label: 'news_pre_close', value: 'flattened ahead of a high-impact news event' },
      { label: 'NULL', value: 'broker closed it (SL/TP hit) — inferred, not stamped' },
    ],
    tables: ['trades'],
    links: [{ label: 'All Trades', to: '/trades' }],
    keywords: ['close reason', 'exit', 'news', 'force close', 'position gone'],
  },
  {
    id: 'env-worker',
    category: 'reference',
    title: 'Worker environment variables (grouped)',
    summary: 'The ~190 settings the worker reads, grouped by area, with the important defaults.',
    plain: `Every behaviour of the background workers is tuned with environment variables on Railway: which role the process plays,
how often it checks for new work, which AI model to call, how long to wait for the broker, and which test flags exist. The table
below lists the groups; the authoritative file is worker/.env.example in the product repo (383 lines).`,
    technical: `Groups (defaults from worker/.env.example): Core — SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TELEGRAM_API_ID/HASH,
FXSOCKET_API_KEY, WORKER_INTERNAL_TOKEN, WORKER_PORT=8080. Parse — LISTENER_INLINE_PARSE=true, PARSE_SIGNAL_TIMEOUT_MS=6000,
CHANNEL_PARSE_CACHE_TTL_MS=300000. Executor — EXECUTOR_PARSED_SWEEP_MS=3000, EXECUTOR_REPLAY_MAX_AGE_MS=300000,
EXECUTOR_MAX_CONCURRENT_SIGNALS=4. Telegram — TELEGRAM_CATCHUP_ON_START=true, TELEGRAM_CATCHUP_MAX_AGE_MINUTES=20,
WORKER_HEALTH_STALE_MS=180000. Roles/sharding — WORKER_ROLE, WORKER_SHARD_ID/COUNT, TRADE_WORKER_SHARD_URLS,
TRADE_SIGNAL_PUSH_*. Queue — UPSTASH_REDIS_REST_URL/TOKEN, TRADE_SIGNAL_QUEUE_* (streams signals:entry / signals:mgmt).
AI — OPENAI_API_KEY, CEREBRAS_API_KEY_1..N, UNIVERSAL_PARSE_MODE=shadow, UNIVERSAL_PARSE_RECONCILE_ENABLED=false.
Broker — BROKER_SESSION_HEARTBEAT_MS=30000, BROKER_RECONNECT_BACKOFF_MAX_MS=300000, MT_PER_ACCOUNT_TRADE_CONCURRENCY=3,
BROKER_CREDENTIALS_ENCRYPTION_KEY. Monitors — *_TICK_MS / *_IDLE_MS pairs per monitor. Retention —
TRADE_LOG_RETENTION_INTERVAL_MS=600000, TRADE_LOG_RETENTION_KEEP=500. Engine — EXECUTION_ENGINE=v1, LAYERING_* fail-closed
switches. Staging-only test flags are ignored when the environment is production.`,
    facts: [
      { label: 'Authoritative file', value: 'worker/.env.example (383 lines, ~190 names)' },
      { label: 'Secrets', value: 'set in Railway variables — never committed' },
      { label: 'Diagnostics', value: 'replay-parse, push-signal-stops, rebalance-open-baskets (+ :dev variants)' },
    ],
    files: ['worker/.env.example', 'worker/src/workerConfig.ts'],
    links: [{ label: 'Systems Health', to: '/monitoring/systems-health' }],
    keywords: ['env', 'environment', 'variables', 'config', 'defaults'],
  },
  {
    id: 'env-frontend-edge',
    category: 'reference',
    title: 'Frontend and edge-function secrets',
    summary: 'VITE_* build variables for the web apps, and the secret list held by Supabase.',
    plain: `The websites get their configuration at build time — the Supabase URL, the Turnstile site key, feature flags. The
server-side secrets (Stripe, Resend email, FMP news, the FxSocket API key, Railway tokens) are never in the code; they live in
Supabase's secret store and are set with the CLI.`,
    technical: `Root .env.example (frontend): VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_TURNSTILE_SITE_KEY, VITE_APP_URL,
VITE_MARKETING_URL (+ optional VITE_DEV_SITE, VITE_BACKTEST_ENABLED, VITE_WORKER_URL for the /broker/stream proxy).
Documented Supabase edge secrets (supabase secrets set): TURNSTILE_SECRET_KEY, BEFORE_USER_CREATED_HOOK_SECRET,
SIGNUP_BLOCKED_EMAIL_PATTERNS, RESEND_API_KEY, EMAIL_LOGO_URL, FMP_API_KEY, STRIPE_SECRET_KEY + price IDs, FXSOCKET_API_KEY,
WORKER_PUBLIC_URL, MTAPI_INTERNAL_TOKEN / MTAPI_API_KEY / MTAPI_BASE_URL, RAILWAY_TOKEN (+ RAILWAY_ENV_ID,
RAILWAY_SERVICE_NAMES), EMAIL_UNSUBSCRIBE_PAGE_URL, SIGNAL_REVIEW_EMAIL_FROM, MARKETING_URL.`,
    facts: [
      { label: 'Build-time vars', value: 'VITE_* — changing one requires a Netlify redeploy' },
      { label: 'Edge secrets', value: 'supabase secrets set — prod and staging are separate' },
      { label: 'Admin dashboard vars', value: 'VITE_SUPABASE_URL/ANON_KEY + _STAGING + _MIGRATION on Netlify' },
    ],
    files: ['.env.example', 'worker/.env.example'],
    keywords: ['secrets', 'env', 'vite', 'turnstile', 'stripe', 'resend', 'fmp'],
  },
  {
    id: 'hosting-deploys',
    category: 'reference',
    title: 'How things ship (deploys)',
    summary: 'Netlify builds on push; Railway deploys the worker from the staging branch; edge functions deploy individually.',
    plain: `Three different release paths: the websites rebuild themselves when their branches are pushed; the workers redeploy when
the staging branch changes on Railway; and serverless functions are released one at a time with an explicit command. Database
changes are SQL migrations applied by hand — nothing migrates itself.`,
    technical: `Netlify: npm run build → publish dist/, SPA redirect /* → /index.html, immutable caching for /assets/*.
Railway: services built from worker/Dockerfile which runs npm run build; deploys from the staging branch (per AGENTS.md).
Edge functions: npm run deploy:function <name> (scripts/deploy-edge-function.sh). Migrations: supabase/migrations applied via
the Management API / supabase db query --linked and recorded in supabase_migrations.schema_migrations — the TSCopier repo has a
check script (npm run migrations:check).`,
    facts: [
      { label: 'Websites', value: 'Netlify — deploy on push' },
      { label: 'Workers', value: 'Railway — staging branch first, then main after validation' },
      { label: 'Edge functions', value: 'explicit deploy per function' },
      { label: 'Database', value: 'manual SQL migrations; never automatic' },
    ],
    files: ['netlify.toml', 'worker/Dockerfile', 'scripts/deploy-edge-function.sh'],
    keywords: ['deploy', 'netlify', 'railway', 'migration', 'release', 'ci'],
  },
  {
    id: 'glossary',
    category: 'reference',
    title: 'Glossary',
    summary: 'The words this system uses, in plain English.',
    plain: `Signal — one Telegram message that describes a trade. Copy / copying — placing that trade on a customer's account.
Basket — all open trades from one channel for one symbol, managed together. Claim — the lock taken before sending an order so
it cannot be sent twice. Lease — a short-lived ownership row proving a worker process is alive and responsible. Shard — one
slice of the user list owned by one replica. Layering — splitting one signal into several staged orders. Provider — which
broker connection system an account uses (fxsocket or mtapi). Listener — the process reading Telegram. Trade worker — the
process sending and managing orders. Edge function — a small serverless function running next to the database.`,
    technical: `Cross-references: basket → stage-management; claim → duplicate-protection; lease → worker-sharding-leases;
shard → worker-sharding-leases; provider → fxsocket-provider / mtapi-provider; layering → stage-entry-execution;
listener → listener-worker; trade worker → trade-worker; edge function → edge-functions.`,
    keywords: ['glossary', 'terms', 'definitions', 'vocabulary'],
  },
  {
    id: 'known-caveats',
    category: 'reference',
    title: 'Known caveats when reading this data',
    summary: 'Where counts can mislead: no DB constraints on statuses, claims are not a ledger, missing policies read as zero.',
    plain: `A few things to keep in mind when reading numbers anywhere in this dashboard. Status values are enforced by code, not by
the database, so an unexpected value can appear. Counting dispatch claims counts attempts, not unique executions. And a table
without an admin read permission does not raise an error — it quietly shows zero, which can be mistaken for "nothing there".`,
    technical: `(1) signals.status / trades.status have no CHECK constraints — the enums here are observed values.
(2) signal_broker_dispatch_claims is a mutex, not a ledger: rows are released on range-wake/retry, so a claim count is
"attempts in window" and never a divergence base (documented in src/lib/systemHealth.ts header). (3) Missing admin RLS policy
= empty result, not an error; tables without one (e.g. telegram_auth_pending for counts) may show 0. (4) Supabase caps a query
at 1000 rows — always use exact head counts for totals. (5) listener_events' admin read migration (20260921120000) must be
applied to an environment before its rows are visible. (6) Production worker topology (3 services vs a sharded fleet) is
documented for staging — confirm in Railway before treating a diagram as current.`,
    facts: [
      { label: 'Statuses', value: 'observed from code, not schema-enforced' },
      { label: 'Claims', value: 'attempts in window — released rows are not counted' },
      { label: 'Zero vs blocked', value: 'a missing policy shows 0 rows, not an error' },
      { label: 'Row cap', value: '1000 rows per query — use count: exact with head: true' },
    ],
    links: [{ label: 'Systems Health', to: '/monitoring/systems-health' }],
    keywords: ['caveat', 'gotcha', 'limitation', 'reliability', 'zero', 'cap'],
  },
];

export const ENCYCLOPEDIA_ENTRIES: EncyclopediaEntry[] = [
  ...SYSTEM_ENTRIES,
  ...COMPONENT_ENTRIES,
  ...PIPELINE_ENTRIES,
  ...REFERENCE_ENTRIES,
];

/** Tab → categories shown together. */
export const TAB_CATEGORIES: Record<string, EncyclopediaCategory[]> = {
  architecture: ['system', 'components'],
  pipeline: ['pipeline'],
  reference: ['reference'],
};

export function searchEntries(entries: EncyclopediaEntry[], query: string): EncyclopediaEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  const terms = q.split(/\s+/).filter(Boolean);
  return entries.filter(entry => {
    const haystack = [
      entry.title,
      entry.summary,
      entry.plain,
      entry.technical,
      ...(entry.keywords ?? []),
      ...(entry.files ?? []),
      ...(entry.tables ?? []),
      ...(entry.facts ?? []).map(f => `${f.label} ${f.value}`),
    ].join('\n').toLowerCase();
    return terms.every(term => haystack.includes(term));
  });
}
