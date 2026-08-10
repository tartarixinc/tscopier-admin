# Project Memory

## Changelog

### 2026-08-10 — Applied admin read/update policies for `trade_reports` to staging (axdcledcyhyvzrnfkwat)

- **Context (user request):** `/reports` resolve only works if `20260810000000_admin_read_update_trade_reports.sql` is applied — apply it to staging too.
- **Verified dependency:** `public.is_admin()` function exists on staging before applying.
- **What was executed** (Management API SQL endpoint): the migration's two policies — `"Admins can view all trade reports"` (SELECT, `USING (public.is_admin())`) and `"Admins can update trade reports"` (UPDATE, `USING/WITH CHECK is_admin()`) plus their `COMMENT ON POLICY`.
- **Verified post-apply:** all 4 policies on `trade_reports` (admin view `r` + admin update `w` with `is_admin()`, user insert `a` + user view `r`).
- **Affected files:** none (DB change only). `docs/PROJECT_MEMORY.md` updated.
- **Follow-up:** none — `/reports` admin view + resolve now works on staging.


### 2026-08-10 — Broker-error classifier: Errors page groups all broker-related failures under broker categories

- **Context (user request):** a broker-error interpreter spec was provided (SymbolSelect / unknown ticket / margin / invalid stops / market closed / trading disabled / account unavailable / HTTP 5xx / timeout / rate-limit categories with severity + retryable). User chose the light-weight route: "Just classify all broker related errors into broker related errors in the error page" — a rule-based classifier, not an OpenAI edge function.
- **NEW `src/lib/brokerErrors.ts`:** `classifyBrokerError(message)` returns `{ category, severity, retryable, label }` for the 10 spec categories + `other`. Rule order matters — most-specific permanent patterns first (symbol select, market closed, unknown ticket, margin, invalid stops, trading disabled, account unavailable), then transient retryable ones (http 5xx, rate limit, timeout). Plus `isBrokerError`, `brokerCategoryOf` (→ `{ key: 'broker:<category>', label: 'Broker · <label>' }`), and `applyBrokerCategory(item, cause)` which overrides the category group only when the cause is broker-related.
- **`src/pages/ErrorsPage.tsx`:** every built error item (execution logs, failed signals, broker connection errors, dead letters) is now passed through `applyBrokerCategory`, so any failure whose message matches a broker pattern groups under `Broker · <category>` instead of the generic action/connection group. Non-broker causes keep their existing group.
- **Verification:** `npm run typecheck` ✓, `npm run lint` ✓ (0 errors; 1 pre-existing `react-refresh/only-export-components` warning at `PipelineSections.tsx:329`), `npm run build` ✓.
- **Follow-up:** none. Not wired to AI yet; the spec's `user_heading`/`user_explanation`/`admin_*` strings could be added as copy per category if a user-facing error explainer is built later.

### 2026-08-10 — Reports page polish: human-readable categories + admin resolve action; new admin RLS migration for `trade_reports`

- **Context (user request):** "Finish admin Reports page polish" — make the report `category` display human-readable and let support mark reports resolved from `/reports`.
- **`src/pages/ReportsPage.tsx`:**
  - Added `CATEGORY_LABELS` mapping (wrong_entry → "Wrong entry price", wrong_sl → "Wrong stop loss", wrong_tp → "Wrong take profit", wrong_direction → "Wrong direction", wrong_lots → "Wrong lot size", not_executed → "Not executed", other → "Other") — the Category column now renders the human label instead of the snake_case key.
  - Added a Resolve/Reopen action in a new Actions column: `handleToggleStatus` does `update({ status })` on `trade_reports` by `id` (guarded by the update policy below), disables the button while in flight, and updates local rows state optimistically. Same mutation style as `AppSettingsPage`.
- **NEW `supabase/migrations/20260810000000_admin_read_update_trade_reports.sql`:** found a real gap — `trade_reports` is NOT covered by the original admin read-policies migration (`20260529210703_add_admin_read_policies.sql`), so with only the user-level policies (`auth.uid() = user_id`) the Reports page would list ONLY reports the admin filed themselves. New migration adds `Admins can view all trade reports` (SELECT via `public.is_admin()`) and `Admins can update trade reports` (UPDATE via `public.is_admin()`), matching the `20260730121100_admin_read_worker_session_leases.sql` style.
- **Affected files:** `src/pages/ReportsPage.tsx`, `supabase/migrations/20260810000000_admin_read_update_trade_reports.sql` (new), `docs/PROJECT_MEMORY.md`.
- **Verification:** admin `npm run typecheck` + `npm run lint` (0 errors, 1 pre-existing `react-refresh/only-export-components` warning at `PipelineSections.tsx:329`) + `npm run build` all pass.
- **Follow-ups:**
  - Apply the new admin RLS migration to staging AND prod SQL editors (staging `axdcledcyhyvzrnfkwat`, prod `sxkpcovbyaficvtkpsdo`) — without it the Reports page only shows the admin's own reports and the Resolve button silently fails. Presented to the user as a prompt (repo rule: don't push migrations automatically).
  - Locale gaps fixed earlier this session in TSCopier (`trading/{ar,ja,nl,pl,ru,sv}.ts` got the 18 report keys) — typecheck passes.
  - Session work remains uncommitted (repo rule: commit only when asked).

### 2026-08-10 — Applied `trade_reports` migration to staging Supabase (axdcledcyhyvzrnfkwat)

- **Context (user request):** run the provided `trade_reports` table migration in the staging SQL editor. Admin dashboard reads this table with `is_admin()` RLS, granted by a separate admin migration that already exists in the admin repo.
- **What was executed** (via Management API SQL endpoint `POST /v1/projects/axdcledcyhyvzrnfkwat/database/query`, CLI token):
  - `CREATE TABLE IF NOT EXISTS trade_reports` (uuid PK, `user_id` FK → `auth.users` ON DELETE CASCADE, symbol/direction/reason/status with defaults, ticket/broker_label/category nullable, entry_price/sl/tp `numeric(20,8)`, lot_size `numeric(10,2)`, `created_at`/`updated_at` `timestamptz DEFAULT now()`).
  - `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`.
  - `CREATE POLICY "Users can insert own trade reports"` — `FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id)`.
  - `CREATE POLICY "Users can view own trade reports"` — `FOR SELECT TO authenticated USING (auth.uid() = user_id)`.
  - `CREATE INDEX IF NOT EXISTS trade_reports_user_created_idx` (user_id, created_at DESC) and `trade_reports_status_idx` (status).
- **Verified post-apply:** table exists (`to_regclass` non-null), `relrowsecurity = true`, both policies present (INSERT `polcmd='a'` with check expr, SELECT `polcmd='r'` with using expr), all 3 indexes present.
- **Affected files:** none (DB change only). `docs/PROJECT_MEMORY.md` updated.
- **Follow-up:** nothing pending for this migration. Note the trailing message about "verification of the locale fixes" was truncated/unrelated and not addressed.

### 2026-08-10 — Error inspection (issues enumeration + failure explainer), Errors page cause breakdown, Reports page + report-a-trade write-side in TSCopier

- **Context (user request):** surface "why" a signal/trade failed — not just the raw skip code (`entry_not_opened`) — and "add the error page + a Reports page". Verified against the real backend in `~/projects/TSCopier` (read-only scans; no backend edits except the new report-a-trade flow below).
- **Key root-cause finding — `entry_not_opened` is a FALLBACK, not a specific error.** In `TSCopier/worker/src/tradeExecutor/dispatch.ts:975` (`entryFailureReason ?? SKIP_REASON_ENTRY_NOT_OPENED`) and `orderLegExecution.ts:113-122` (no sendable legs + nothing materialized ⇒ `failureReason: entry_not_opened`). Dispatch itself succeeds (that's why execution attempts log `success`), but the broker opened no position and no specific error was captured. Authoritative product copy: label "No position opened", detail "The copier processed this signal but the broker did not open a position. This can happen when entry filters block the trade or the broker rejects the order." (source: `TSCopier/src/lib/copierSkipReasonLabels.ts` + i18n locales).
- **NEW `src/lib/failureExplainer.ts`:** `explainFailure(cause, source)` / `failureTitle(cause, source)` — ports all `COPIER_SKIP_REASON_LABELS/DETAILS` from the backend (now the correct human copy for every skip reason) + broker-error heuristics (unknown ticket, HTTP 5xx, invalid stops, insufficient funds/margin, symbol-not-found/market-closed, trading-disabled, timeout).
- **NEW `src/lib/pipelineIssues.ts`:** `collectPipelineIssues(signalSkip, channelSkip, logs)` / `collectExecutionIssues` — recursively scans execution-attempt `request_payload`/`response_payload` for embedded problem markers (`error`, `error_message`, `reason`, `skip_reason`, `note`, `warning`, `status` not in OK set, `success:false`/`ok:false`), dedupes, classifies severity → `PipelineIssue[]`.
- **`src/hooks/useSignalPipeline.ts`:** now returns `issues` (via `collectPipelineIssues`); **`src/components/pipeline/PipelineSections.tsx`** adds `IssuesFoundSection` (source badge, action, severity, humanized title, raw, embedded-in-payload marker, time); **`SignalPipelineBody.tsx`** renders it right after the summary grid.
- **Failed rows now open `ErrorDetailModal`:** `CopierLogsPage`, `TradeExecutionLogsPage` (failed/error rows → `executionLogToErrorItem`), `SignalsPage` (failed rows → `failedSignalToErrorItem`; now fetches `skip_reason`); success rows still open `SignalDetailModal`. `ErrorDetailModal` renders an "Issues found" section and a decoded "What actually happened" block; signal raw-message view falls back to `parsed_data.raw_instruction`.
- **`src/pages/ErrorsPage.tsx`:** refactored onto shared builders (`executionLogToErrorItem`, `failedSignalToErrorItem`, `categoryOf` — removed local `categoryOf`/`actionLabel`). Added `causeFilter` state, a top **"Failure causes" panel** (top-15 distinct causes with humanized title, raw, count, severity badges, % bar — click to filter), per-category cause chips in each card header, and humanized cause column (title + raw).
- **NEW `src/pages/ReportsPage.tsx` (route `/reports`, nav Trades > Reports):** summary cards (Total/Open/Reviewed/Resolution rate), reports-by-status bar chart, direction-mix donut, top-symbols chips (click to filter), table (user, symbol, direction, category, ticket, reason, status, reported) + filters + `ExportButton`. Reads `trade_reports` (limit 500); status summary keys off `open`/`resolved` (schema uses `open|resolved`, NOT `pending`); fetches `category`/`ticket`/`broker_label`.
- **Report-a-trade write-side built in `~/projects/TSCopier`** (the admin page was reading `trade_reports` but NOTHING wrote to it — only migration `supabase/migrations/20260810000000_trade_reports.sql` existed, no UI/edge function/insert):
  - NEW `TSCopier/src/components/trades/ReportTradeModal.tsx` — category pills (wrong_entry/wrong_sl/wrong_tp/wrong_direction/wrong_lots/not_executed/other) + reason textarea; direct `supabase.from('trade_reports').insert({...})` (RLS policy `Users can insert own trade reports` allows `auth.uid() = user_id`); success state; Escape/backdrop close.
  - `TSCopier/src/components/trades/TradeDetailModal.tsx` — "Report" button next to "Manage" opens the modal (works even without a linked signal).
  - i18n: added report keys to `TradesTranslations` (`src/i18n/locales/types.ts`) + `en.ts` / `fr.ts` / `es.ts` `trades` modules. Other locales inherit English (shallow bundle merge from `en`).
- **Affected files (admin):** `src/lib/failureExplainer.ts`, `src/lib/pipelineIssues.ts` (new), `src/hooks/useSignalPipeline.ts`, `src/components/pipeline/PipelineSections.tsx`, `src/components/pipeline/SignalPipelineBody.tsx`, `src/components/ErrorDetailModal.tsx`, `src/pages/CopierLogsPage.tsx`, `src/pages/TradeExecutionLogsPage.tsx`, `src/pages/SignalsPage.tsx`, `src/pages/ErrorsPage.tsx`, `src/pages/ReportsPage.tsx` (new), `src/App.tsx`, `src/components/AdminShell.tsx`. **Affected files (TSCopier):** `src/components/trades/ReportTradeModal.tsx` (new), `src/components/trades/TradeDetailModal.tsx`, `src/i18n/locales/{types,en,fr,es}.ts`.
- **Verification:** admin `npm run typecheck` + `npm run build` + `npm run lint` pass (1 pre-existing `react-refresh/only-export-components` warning at `PipelineSections.tsx:329` for the `MANAGEMENT_ACTIONS` const export). TSCopier changes typecheck via that repo's own tooling when CI runs.
- **Follow-ups:**
  - Apply migration `20260810000000_trade_reports.sql` to the Supabase project(s) before reports can actually be inserted (write-side UI assumes it's deployed).
  - Admin Reports page is read-mostly, fetch-limited to 500 recent rows; no status mutation action yet (admin can't resolve reports).
  - `category` values stored as snake-case keys (`wrong_entry`, …); admin page renders them capitalized — optional future mapping to human labels.
  - Session work is uncommitted (repo rule: commit only when asked). Recent commits before this session are tagged "DO NOT PUSH TO PROD UNTIL TESTING COMPLETE" — keep untested UI off the prod deploy until verified on staging.

### 2026-08-10 — AGENTS.md + PROJECT_MEMORY.md created (fresh agent onboarding)

- **Context (user request):** "Go to projects/tscopier-admin, and setup the agents.md and project_memory.md thee" — mirror the main TSCopier repo's agent setup for the admin dashboard repo `tartarixinc/tscopier-admin`.
- **What this repo is (captured for future sessions):** internal admin dashboard for the TSCopier copier platform. Single-source repo (no fork/upstream — `origin` is `tartarixinc/tscopier-admin`, `main` is production). Netlify-deployed, SPA redirect. React 18 + Vite 5 + TS + Tailwind v3 + React Router v7 + `@supabase/supabase-js` + Recharts + lucide-react. **No test suite** — verification is `npm run typecheck` + `npm run lint` + `npm run build`.
- **Auth model:** one anon Supabase client (`src/lib/adminSupabase.ts`); RLS `is_admin()` policies control what each signed-in admin can read. `AuthGuard` verifies the real session AND a `sessionStorage` flag (`admin_authed_<env>`); env is switchable PROD/STAGING at runtime via `src/lib/environment.ts` (`localStorage[tscopier_admin_env]`).
- **Data layer:** TTL query cache (`src/lib/queryCache.ts`) + hooks (`usePaginatedQuery`, `useCachedQuery`) + realtime bridge (`src/lib/realtimeBridge.ts`); `main.tsx` invalidates all on focus/visibility/pageshow. All mutations must invalidate.
- **Supabase admin bits in this repo:** 12 migrations in `supabase/migrations/` (admin read RPCs/grants, email-campaign fixes, worker-session-leases, channel-signals) and 7 edge functions in `supabase/functions/` (email-unsubscribe, reconnect-offline-listeners, send-invoice-due-email, send-subscription-campaigns, send-subscription-email, send-test-email, trade-pipeline-explainer).
- **Changes:** NEW `AGENTS.md` (session context, quick start, commands, architecture, key constraints, deployment, instruction files, session-memory rules, agent behavior rules + structured response format), NEW `docs/PROJECT_MEMORY.md` (this file).
- **Affected files:** `AGENTS.md` (new), `docs/PROJECT_MEMORY.md` (new).
- **Follow-up:** none — setup only, no code changed.
