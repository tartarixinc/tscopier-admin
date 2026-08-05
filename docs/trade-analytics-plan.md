# Trade Analytics & Staging Environment — Implementation Plan

Status: Approved for implementation (Option A) — 2026-08-03
Repo: `tartarixinc/tscopier-admin` — branch `feat/trade-pipeline-analytics`

## Goal

1. Give the admin dashboard a staging environment switch (top navbar toggle) so the
   same app can operate against the production Supabase project and the staging
   Supabase project without a separate deployment.
2. Trade analytics: list of every executed trade, click-through to a modal showing
   the full trade pipeline — every event from the Telegram message to broker
   execution — with timestamps and per-stage latency. Aggregate latency stats
   (avg / p50 / p95 per stage) on the Trade Analytics page.

## Latency safety requirement

The latency monitoring MUST NOT add latency to the Telegram → execution path.
This plan adds **zero** new instrumentation and **zero** new writes to the worker.
Everything displayed already exists in the database today:

- `signals.pipeline_ts` (jsonb) — stamped by the worker's `pipelineTimestamps.ts`
  at every stage (telegram source → listener → parse → persist → queue →
  planning → broker request → response → confirmation → reconciliation).
- `signals.raw_message`, `signals.parsed_data`, `signals.status` — the signal
  content and parse result.
- `trade_execution_logs` — every broker call attempt with request/response payloads.
- `channel_signals` — ingest-side record (raw message, skip reason) linked by
  (signal_channel_id, telegram_message_id).

## Part 1 — Environment switching (Production / Staging)

### Configuration

- Prod: existing `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` (unchanged, already
  set on the Netlify deploy — no action needed for prod).
- Staging: new `VITE_SUPABASE_URL_STAGING` + `VITE_SUPABASE_ANON_KEY_STAGING`.
  Values: https://axdcledcyhyvzrnfkwat.supabase.co + its anon key.
  To activate the toggle in prod, these two vars must be added to the Netlify
  site settings (Site settings → Environment variables). If they are absent, the
  toggle is hidden and the app behaves exactly as before.

### Behaviour

- `src/lib/environment.ts`: `AdminEnv = 'prod' | 'staging'`; current env persisted
  in `localStorage` (`tscopier_admin_env`); environment config read from the
  Vite env vars above.
- `src/lib/adminSupabase.ts`: client built once at module load from the *current*
  env. Switching env persists the choice and reloads the page, so every page
  automatically re-binds to the new client. No per-page changes needed.
- Auth sessions are project-scoped: supabase-js stores them per project URL, so
  prod and staging sessions never collide. The `admin_authed` / `admin_user_id` /
  `admin_display_name` sessionStorage flags become per-env
  (`admin_authed_prod`, `admin_authed_staging`, …) so a user logged into prod
  must (once) log in to staging.
- Top navbar toggle (AdminShell): segmented control [Production | Staging] +
  persistent amber `STAGING` banner across the top when staging is active so the
  environment can never be mistaken.
- Login page shows which environment it is logging into.

### RLS on staging

The admin pages rely on RLS policies that check `is_admin()`. Staging is a
branching preview of prod, so it inherits prod's schema — but the newest admin
migrations (e.g. `20260730121100_admin_read_worker_session_leases.sql`,
`20260702130753_add_admin_policy_trade_execution_logs.sql`) were applied to prod
directly and may not exist on the preview branch. Verification + remediation is
part of this task (see Verification).

## Part 2 — Trade pipeline analytics (Option A)

### New files

| File | Purpose |
|---|---|
| `src/lib/pipelineTimeline.ts` | Parse `pipeline_ts` (mirror of worker logic), compute per-stage durations, build an ordered event list for the timeline. |
| `src/components/TradePipelineModal.tsx` | Modal showing one trade's full pipeline: timeline + latency breakdown + signal raw data + execution log attempts. |

### Modal content (opened from a Trades row)

1. Trade summary: symbol, direction, status, P&L, lots, entry, SL/TP, opened/closed.
2. **Pipeline timeline** (vertical, ordered): each event with wall-clock time
   (UTC ms) and duration from the previous stage:
   Telegram message sent → listener received → normalized → parse started →
   parse completed → signal persisted → queue published → queue consumed →
   planning → claim acquired → broker ready → broker request started →
   broker response → execution confirmed → state persisted → reconciliation.
   Segments colored by magnitude (green < 500ms, amber < 2s, red ≥ 2s).
3. **Latency breakdown table**: stage, duration ms, % of total; headline metrics
   `telegram_to_listener_ms`, `parse_ms`, `queue_wait_ms`, `order_send_ms`,
   `broker_send_ms`, `total_ms` (Telegram source → broker confirmation).
4. Signal data: raw message, parsed data, status (JsonViewer).
5. Execution attempts from `trade_execution_logs` (action, status, error, request
   and response payloads via JsonViewer).

### Data sources per trade

- `trades` row (already loaded) + `trades.signal_id`.
- `signals` row: `raw_message, parsed_data, status, pipeline_ts, telegram_message_id, channel_id`.
- `channel_signals` row (if any) by `(signal_channel_id, telegram_message_id)`: raw message, skip reason, status.
- `trade_execution_logs` rows by `signal_id` (created_at desc).

**New RLS policy required:** no admin read policy exists for `channel_signals`.
Migration `supabase/migrations/20260803000000_admin_read_channel_signals.sql`
adds one (same pattern as the other admin read policies). Must be applied to
prod and staging.

### Trade Analytics page

Add a "Latency" tab to `src/pages/TradesAnalyticsPage.tsx`:
- Range selector (30d / 90d / 180d / 1y / All) drives **both** the P&L tab and the
  Latency tab — analytics cover the full trade history, not just live/open trades.
- Latency tab: fetch closed trades in the range with `signal_id` (paginated — no
  hard 2000-row cap; analysis capped at 10,000 signals for the "All" range with a
  visible notice), fetch their signals' `pipeline_ts` in chunks, compute per-stage
  duration arrays client-side.
- Render: stage table with count / avg / p50 / p95, plus a bar chart of median
  per-stage latency.
- Pure read path — no worker changes, no new tables.
- Known limit surfaced in the UI: `signals.pipeline_ts` exists from
  `20260724120000_signals_pipeline_ts.sql` (2026-07-24) onward, so trades before
  that date have no latency data.

## Out of scope (Option B — documented separately)

`docs/latency-monitoring-options.md` covers the future event-stream table.

## Deploy

1. Push branch → open PR into `tartarixinc/tscopier-admin` `main` (or merge per
   repo workflow).
2. Netlify rebuild of the admin site (current admin dashboard).
3. Add `VITE_SUPABASE_URL_STAGING` / `VITE_SUPABASE_ANON_KEY_STAGING` to Netlify
   env vars to enable the toggle in production.
4. Apply the `channel_signals` admin policy migration to prod and staging.
5. Verify staging RLS coverage (worker leases read, trade execution logs admin
   policy) and that an admin user exists in staging.

## Verification checklist

- [ ] `npm run build` clean (typecheck + vite).
- [ ] Prod mode loads current data, toggle visible only if staging vars present.
- [ ] Toggle → staging: banner appears, data loads from `axdcledcyhyvzrnfkwat`,
      separate login session.
- [ ] Trades row click → modal shows a real pipeline with sane durations for a
      known recent trade.
- [ ] Latency tab renders stats for last 30 days.
- [ ] Staging project: `channel_signals`, `signals`, `trades`,
      `trade_execution_logs`, `worker_session_leases` readable by an admin login.
