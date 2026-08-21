# Project Memory

## Changelog

### 2026-08-21 - Admin Errors safe detail restore + safe AI explainer path

- **Context (user request):** restore useful Admin Error Detail operator diagnostics regressed by the recent Errors privacy work, without touching trading logic, the TSCopier worker, bare BUY/SELL behavior, or re-enabling arbitrary raw payload rendering.
- **`src/components/ErrorDetailModal.tsx`:**
  - Added a safe `Signal / trade details` section built only from known parsed fields and structured trade rows: symbol, BUY/SELL side, entry/range, SL, TP levels, lot/volume, signal time, channel, broker/account label, operation, ticket/reference, signal status, and account outcome.
  - Added a safe `Telegram signal summary` that reconstructs the operator-facing signal from parsed fields only. It does not render raw Telegram text or arbitrary `parsed_data` JSON.
  - Restored an Errors-modal AI action as `Explain with AI`, but it now sends only curated `safe_error_context` instead of using the existing raw signal explainer path.
- **`supabase/functions/trade-pipeline-explainer/index.ts`:**
  - Added a new `safe_error_context` mode. It does not query signals, trades, listener events, execution payloads, or raw Telegram messages.
  - Server-side sanitization keeps only allowlisted keys and drops raw/payload/request/response/error-message/session/auth/token/password/cookie/API-key/OTP/hash/phone-looking fields before calling OpenAI.
  - Prompt rules require the AI to use only supplied evidence and to say evidence is insufficient for `Detailed reason unavailable` / legacy fallback cases.
- **`src/lib/errors.ts`:**
  - Added management-aware status copy for structured execution failures: `Management breakeven failed`, `Take-profit management failed`, `Close failed`, and `Synchronization failed`, while preserving `Trade not opened` only for entry context.
  - Added structured `INVALID_STOPS` / broker-stops reason support and kept legacy unknown rows neutral as `Detailed reason unavailable`.
- **`src/hooks/useSignalPipeline.ts`:** included safe linked-trade fields (`sl`, `tp`, `lot_size`, `broker_account_id`) so the Errors modal can show useful trade facts without payloads.
- **Verification:** `npm.cmd run typecheck` passed; `npm.cmd run lint` passed with 0 errors and 2 pre-existing Fast Refresh warnings; `npm.cmd run build` passed with existing Browserslist/chunk-size warnings; `git -c safe.directory=... diff --check` passed with line-ending warnings only; conflict-marker scan passed; targeted privacy scan confirmed the Errors modal safe AI call uses `safe_error_context` and the full pipeline raw sections remain behind `hideRawData`.
- **Follow-up:** browser validation could not be completed in this environment because Vite background launch attempts timed out and no localhost server stayed running. Validate on staging in the browser before merge/deploy, especially the AI edge function after deploying the updated Supabase function.

### 2026-08-19 - Admin Errors continuation audit: parser-success trace made conservative

- **Context (user request):** continue the interrupted admin error-diagnostics blocker fix without reimplementing, resetting, committing, pushing, deploying, migrating, installing packages, or connecting to staging/prod. First audited the existing uncommitted implementation against the CTO checklist.
- **Blocker found:** `hasParseSuccessEvidence()` still treated generic `parsed_data` fields (`action`, `symbol`, `direction`, `side`, `confidence`, `_intent.kind`) as positive proof of successful parsing. The repo evidence shows those fields are displayed as parsed payload, but does not prove they only exist after a completed parser success path.
- **`src/lib/errors.ts`:** narrowed parser success evidence to explicit `_verification` chain records (`final`, `deterministic`, `stage2`, or `stage3`) and changed the trace copy from generic parsed-data wording to `verification chain recorded`.
- **`src/lib/errors.ts`:** split deferred-pending terminal outcomes from completed retry recovery. Pending rows now produce `Deferred pending registered` or `Recovered with pending accounts` instead of being described as completed success.
- **`src/components/ErrorDetailModal.tsx`:** changed the AI explainer context for the Errors modal so safe mode asks for safe root-cause wording and explicitly says not to include raw payloads or arbitrary raw error text.
- **`src/components/ErrorDetailModal.tsx`:** pending broker-account outcomes now render with the warning badge tone instead of muted.
- **`src/components/pipeline/SignalPipelineBody.tsx`:** when `hideRawData` is active, the raw-data AI explainer section is now hidden too. The edge function intentionally sends raw Telegram text and full execution payloads for normal signal/report views, so hiding only JSON viewers was not a hard privacy boundary for the Errors modal.
- **Deliberately not changed:** retry terminal-outcome selection, multi-account aggregation, supplemental linked-log query shape, counts, filters, pagination, analytics, and shared pipeline raw diagnostics outside the Errors modal.
- **Follow-up:** validate the conservative parser trace against staging records that include and omit `_verification` before merge/deploy.

### 2026-08-19 - Admin Errors: deterministic `entry_not_opened` root-cause diagnostics

- **Context (user request):** finish the CTO-reviewed gap where `entry_not_opened` remained the largest bucket but still did not explain why trades were not entered. Scope stayed admin-only: no TScopier edits, no DB migrations, no prod connection, no deploy, no commit, no query/count/date/pagination/analytics semantics change.
- **Root cause found:** `/errors` built failed `signals` rows and failed/error `trade_execution_logs` rows independently. A failed signal with `skip_reason='entry_not_opened'` was not enriched from its linked execution logs by `signal_id`, so the row and modal often stopped at generic "No position opened" even when `request_payload` / `response_payload` carried structured `trade_failure`, `reason_code`, `failure_reason`, `skip_reason`, broker error evidence, or a later account-specific failure.
- **`src/lib/errors.ts`:**
  - Added central pure root-cause diagnostics for `entry_not_opened`: structured `trade_failure` -> structured `reason_code` -> explicit `failure_reason` / `skip_reason` (except fallback `entry_not_opened`) -> normalized broker classification -> execution `error_message` -> neutral legacy fallback.
  - Added structured reason-code copy for known codes such as `BROKER_SYMBOL_NOT_FOUND`, `SIGNAL_MISSING_REQUIRED_SL`, `INSUFFICIENT_MARGIN`, `MARKET_CLOSED`, and `BROKER_TIMEOUT`, while preferring stored structured title/explanation/action when present.
  - Added account-level diagnostics for fan-out signals. Linked logs are grouped by `broker_account_id`; each account uses the latest meaningful failure evidence by `created_at`; mixed failures summarize at signal level and preserve per-account reasons.
  - Added a lightweight trace (`Signal received`, `Signal parsed`, `Execution planned` / `Deferred pending registered`, `Broker attempted`, `Outcome`) using existing evidence only.
  - Tightened `safeContext` to an allowlist plus sensitive-key exclusion before display.
- **`src/pages/ErrorsPage.tsx`:**
  - Fetches linked execution logs for already-loaded failed signals by `signal_id` in chunked/paginated supplemental reads. These rows only enrich diagnostics; they are not added to the error list, so `filtered.length`, total counts, date filters, pagination, and analytics source semantics remain unchanged.
  - `entry_not_opened` list rows now show concise diagnostic labels such as `No position opened - Symbol not found`, `No position opened - Insufficient margin`, or `No position opened - Detailed reason unavailable`.
- **`src/components/ErrorDetailModal.tsx`, `src/components/pipeline/SignalPipelineBody.tsx`, `src/components/pipeline/PipelineSections.tsx`:**
  - Error detail now answers status, stage, reason, explanation, recommended action, evidence source, diagnostic trace, and broker-account outcomes.
  - The Errors modal passes `hideRawData` into the full pipeline view so raw Telegram messages, parsed payload JSON, request payloads, response payloads, and payload-derived issue markers are not rendered in this diagnostic context.
- **Verification:** `npm.cmd run typecheck` passed, `npm.cmd run lint` passed with 0 errors and 2 pre-existing Fast Refresh warnings, `npm.cmd run build` passed with pre-existing Browserslist/chunk-size warnings.
- **Follow-up:** validate against staging data in the browser before merge/deploy. If linked execution logs for older `entry_not_opened` records do not contain structured/explicit/broker/error evidence, admin will correctly show `Detailed reason unavailable`; no TScopier change is required unless staging proves current worker events still fail to store the needed evidence.

### 2026-08-14 — Error classification audit blockers fixed: safeContext privacy + parser-stage evidence narrowed

- **Context (user request):** fix only the two blockers from the final read-only audit of the admin error-classification patch. No query/count/analytics changes, no modal redesign, no TScopier changes, no DB/migration/deploy/commit/prod access.
- **`src/lib/errors.ts`:**
  - `safeContext` now excludes sensitive-looking keys matching `token|secret|password|credential|session|auth|authorization|key|phone|otp|hash|cookie|bearer` case-insensitively. This covers common styles such as `phone_number`, `otpCode`, `phoneCodeHash`, `sessionString`, `accessToken`, `apiKey`, `authorizationHeader`, `set_cookie`, and `bearer_token`. Sensitive fields are excluded entirely; values are not sanitized/retained.
  - Parser-failure classification no longer treats plain `parsed_data.stage === "parse"` as proof of parse failure. Accepted parser evidence remains explicit cause keys (`parse_failed`, `signal_parse_failed`, `parser_failed`, `signal_parser_failed`) and explicit failure-stage fields (`failed_stage` / `failure_stage`) identifying parser stage.
- **Verification:** `.\node_modules\.bin\tsc.cmd --noEmit -p tsconfig.app.json` ✓, `.\node_modules\.bin\eslint.cmd .` ✓ (0 errors; 2 pre-existing Fast Refresh warnings), `npm.cmd run build` ✓ (pre-existing Browserslist/chunk-size warnings), `git diff --check` ✓ (line-ending warnings only), conflict-marker scan ✓.

### 2026-08-14 — Errors page: stop labeling every failed signal as "Signal parse failed"

- **Context (user request):** implement the minimal admin-only fix from the read-only audit: `signals.status = failed` does not prove parser failure, and `entry_not_opened` must not display as "Signal parse failed." No TSCopier worker changes, DB migrations, production access, deploy, commit, or count/analytics changes.
- **`src/lib/errors.ts`:**
  - Added a centralized pure classification path for failed signal rows. `Signal parse failed` is now used only when explicit parser-stage evidence exists (`parse_failed`/parser failure keys or parser-stage markers in parsed data). Generic failed signals now show `Signal failed`; `entry_not_opened` shows `No position opened`.
  - Added defensive structured failure extraction for existing selected execution payloads (`reason_code`/`reasonCode`, `trade_failure`/`tradeFailure`, safe fields such as `title`, `explanation`, `recommendedAction`, `retryable`, `userActionRequired`, and allowlisted `safeContext`). Structured metadata now takes precedence over legacy `error_message`/regex fallback when present.
  - Added item-level severity classification so structured `retryable:false` is respected instead of being described as transient/retryable by regex.
- **`src/pages/ErrorsPage.tsx`:** switched severity calculations/display to the item-level classifier. Did not change the four source queries, date filters, aggregation sources, pagination, `/errors` total (`filtered.length`), or `/errors/analytics`.
- **`src/components/ErrorDetailModal.tsx`:** modal now prefers structured title/explanation/recommended action when available and avoids the generic "Transient = retry" wording when structured metadata says `retryable:false`. No retry controls were added.
- **Verification:** `.\node_modules\.bin\tsc.cmd --noEmit -p tsconfig.app.json` ✓, `.\node_modules\.bin\eslint.cmd .` ✓ (0 errors; 2 pre-existing Fast Refresh warnings), `npm.cmd run build` ✓ (pre-existing Browserslist/chunk-size warnings), `git diff --check` ✓ (line-ending warnings only), conflict-marker scan ✓.
- **Follow-up:** add regression tests if/when this repo gains a test harness; validate on staging data before merge/deploy.

### 2026-08-11 — Model decision chain: truthful Cerebras labels + fallback notes gated on evidence (admin display fix)

- **Context (user report):** an Aug 11 signal showed `source: 'openai'` in the Model decision chain and a note claiming `Skipped stage 2 — Cerebras unavailable, fell back to OpenAI` even though no `ai_parse_fallback` event existed. Investigation with the main-repo worker debug endpoint (`POST <listener>/internal/parse-ai-debug`, token from user) against prod `https://tscopier-listener-production.up.railway.app` proved **Cerebras is working** on prod right now — both a modify and an entry test message went through stage 2 with `source: "cerebras"` (~700–950 ms, `mode: "fastpath"`), no fallback. The old signal's `openai` source means it was parsed while Cerebras wasn't running (pre-fix build or an outage window); that state is no longer reproducible. So no Railway/env changes were needed — only the admin display was lying to the user.
- **`src/components/pipeline/PipelineSections.tsx`:**
  - `SOURCE_BADGES`: `cerebras` → **"Cerebras (OpenAI OSS)"**, `openai` → **"OpenAI"** (was "OpenAI (OSS fallback)"), `gpt4o` unchanged. The "OSS fallback" claim is no longer attached to the plain OpenAI badge.
  - `stage2FallbackNote` (Model decision chain): now rendered **only when an `ai_parse_fallback` event actually exists** AND `chain.stage2.source === 'openai'`; reworded to `Cerebras request failed[: <reason>] — stage 2 ran via the OpenAI API fallback.` A bare `openai` source with no event now shows just the "OpenAI" badge with no note (no more invented "Skipped stage 2 — Cerebras unavailable").
  - `AiVerificationSection`: "AI source" summary cell now maps the raw value through `sourceBadge` (so `cerebras`/`openai` show friendly labels, not raw strings). The fallback alert box title now says "Cerebras request failed — stage 2 ran via the OpenAI API fallback." when the event's `ai_source` is `openai` (was always "AI was unavailable — deterministic policy ran", which contradicted the recorded `ai_source: openai`); the generic deterministic-policy wording is kept only for fallback events without an OpenAI source.
- **Verification:** `npm run typecheck` ✓, `npm run lint` ✓ (0 errors; 2 pre-existing `react-refresh/only-export-components` warnings), `npm run build` ✓ (pre-existing chunk-size warning only).
- **Follow-up:** none required. (Optional, for certainty on the old signal only: compare its `created_at` to the Railway deploy timestamp of the Cerebras fix — nothing actionable either way.)

### 2026-08-11 — Error Analytics page: rise/fall of errors over time, with an Analytics button on the Errors page

- **Context (user request):** "Add a button on this page for analytics that we can use to see the rise and falls of total errors, make it a proper analytics page."
- **NEW `src/pages/ErrorsAnalyticsPage.tsx`** at route `/errors/analytics`:
  - Range selector pills (7d / 30d / 90d / 180d / 1y / All, default 30d) matching the `TradesAnalyticsPage` pattern.
  - Data source mirrors the Errors page filters exactly: `trade_execution_logs` (`status in failed,error`), `signals` (`status = failed`), `broker_accounts` (`connection_status = error`, bucketed on `last_synced_at`), `signal_queue_dead_letters` (`status != replayed`) — skipped rows never counted, consistent with `isFailureStatus`.
  - Lightweight fetches (`id, <timestamp>` only, paginated 1000/page, 50k-row cap per source with a cap notice) bucketed client-side by UTC day; zero-days filled so the series is continuous from the range start to today.
  - Stat pills: Total errors, Avg per day, Peak day, Last 7d vs prior 7d, and a Trend pill (last-7d vs previous-7d percent change; red when rising, green when falling).
  - Charts: stacked bar per-day by source (Execution / Signal / Broker / Dead letter) with a manual legend, and a cumulative area chart of total errors over time. "By source" card with share bars.
- **`src/pages/ErrorsPage.tsx`:** added an "Error analytics" button (BarChart3 icon) in the page header that navigates to `/errors/analytics` (`useNavigate`).
- **`src/components/AdminShell.tsx`:** added "Errors Analytics" under the Monitoring nav group (after Errors).
- **`src/App.tsx`:** new protected route `/errors/analytics`.
- **Verification:** `npm run typecheck` ✓, `npm run lint` ✓ (0 errors; 2 pre-existing `react-refresh/only-export-components` warnings), `npm run build` ✓ (pre-existing chunk-size warning only).
- **Follow-up:** none.

### 2026-08-11 — Errors page: table paginated (50/page); summary numbers + Failure causes stay accurate over the FULL error set

- **Context (user request):** after the cap removal the page loaded all ~2,002 errors at once — user: "We can paginate the errors, so that they all don't drop in at once, but total number and failure causes should be accurate". So: the table render must be paginated, but the stat cards (Errors/Transient/Major/Reviewed as major) and the Failure causes panel must keep aggregating every error matching the current filters.
- **Design:** data loading is unchanged — all four source queries still fetch the full date-filtered set (exec `status in failed/error`, signals `status=failed`, broker `connection_status=error`, dead letters `status != replayed`). Only the `<table>` render is paginated client-side, so the summary + cause buckets (derived from the full `filtered` memo) remain exact.
- **`src/pages/ErrorsPage.tsx`:**
  - `const PAGE_SIZE = 50`; new `page` state; `useEffect` resets `page` to 1 whenever `categoryFilter`/`severityFilter`/`causeFilter`/`search`/`dateFrom`/`dateTo` change (matches the pattern in ReportsPage/SignalsPage/etc.).
  - `paged = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)`; table maps over `paged` instead of `sorted`.
  - Added the shared `<Pagination>` component (from `components/DataTable.tsx`, same one used by every list page) under the table with `totalCount={sorted.length}` and `onPageChange={setPage}`. The 20s poll updates `items` without resetting `page` (filters unchanged), so the user's page position persists across refreshes.
  - **Unchanged:** `totals`, `causeBreakdown`, and `categoryCount` all still derive from the full `filtered` set — totals are accurate regardless of the current page.
- **Verification:** `npm run typecheck` ✓, `npm run lint` ✓ (0 errors; 2 pre-existing `react-refresh/only-export-components` warnings), `npm run build` ✓ (pre-existing chunk-size warning only).
- **Follow-up:** none.

### 2026-08-11 — Errors page: Failure-causes titles restored + summary numbers now aggregate ALL errors (PAGE_LIMIT cap removed)

- **Context (user report):** (1) the big bold titles in the "Failure causes" panel had disappeared — only "No position opened" (`entry_not_opened`) and "Broker rejected stop levels" (`invalid_stops`) still had one; (2) the summary numbers were pinned at Errors 602 even as new errors came in. User: the page "is supposed to aggregate all". Explicit instruction: NO reverting — diagnose via `git diff` and reapply, do not revert uncommitted work.
- **Title bug root cause:** `causeBreakdown` (ErrorsPage.tsx) called `failureTitle(cause, 'signal')` unconditionally. The working-tree `explainFailure` (from the `no_tp_ladder` change above) intentionally returns `null` for `source === 'signal'` unless the cause normalizes to a skip-reason key (`SKIP_REASON_EXPLANATIONS`) — broker-style causes (`unknown ticket`, `Not enough money`, `Market closed`, `HTTP 5xx`, `Symbol not found`) only resolve through the execution/dead-letter path (`explainBrokerError`). So only `invalid_stops` + `entry_not_opened` (which ARE skip keys) kept titles. The committed version fell through to `explainBrokerError` for all sources, which is why it worked before.
- **`src/pages/ErrorsPage.tsx` (`causeBreakdown`):** each cause bucket now tracks the distinct `sources: Set<ErrorSource>` it appears in; the title is the first non-null `failureTitle(cause, source)` tried across that bucket's sources. Broker causes now resolve via `explainBrokerError`, skip-reason causes via `SKIP_REASON_EXPLANATIONS`. Row-level titles in the table were already source-aware (`failureTitle(item.cause, item.source)`) and were never broken.
- **Pinned-numbers root cause:** every source query capped at `PAGE_LIMIT = 300` rows, and ALL four stat cards derived from `filtered` (the capped window). As new errors streamed in, old ones rotated out of the 300-window, so the total hovered at ~602 regardless of growth. The page already renders every filtered row with no pagination, so the cap only ever hid data from the stats.
- **`src/pages/ErrorsPage.tsx` (fetch):** removed `const PAGE_LIMIT = 300` and the four `.limit(PAGE_LIMIT)` calls (exec `status in failed/error`, signals `status=failed`, broker `connection_status=error`, dead letters `status != replayed`). Same date filters still apply. Summary cards now aggregate the complete matching set; the "Reviewed as major" card subtitle now reads "of all errors" instead of "of the visible errors". Note: skipped rows still never reach this page because `isFailureStatus` only accepts `failed`/`error` (unchanged).
- **Verification:** `npm run typecheck` ✓, `npm run lint` ✓ (0 errors; 2 pre-existing `react-refresh/only-export-components` warnings in ReportDetailModal/PipelineSections), `npm run build` ✓ (pre-existing chunk-size warning only).
- **Follow-up:** none required. If the error volume grows to tens of thousands of rows, revisit with real count queries or table pagination (the 20s poll refetches the full matching set).

### 2026-08-11 — `range_basket_tp_rebalance` skip now explained in admin (worker emits `status='skipped'` + `skipped_reason='no_tp_ladder'`); pipeline shows skip reason, Errors pages won't list skips as Major

- **Context (main repo investigation, signal `e2fbd5c5`, XAUUSD "Gold Buy Now!", Luis ESp):** admin showed `range_basket_tp_rebalance` as **Major / "unknown ticket"** with `{phase:"layering_rebalance", failed:1, attempted:1, modified:0, open_legs:13, target_tp_counts:{}}`. Root cause (worker, in `~/projects/TSCopier`, NOT this repo): the skip branch in `rangeBasketTpSync.ts:735-752` logged the "no TP ladder" skip as `status:'failed'` (`attempted:1, failed:1`) with no reason. It was a correct skip, not a failure — the basket rebalance simply had no TP ladder to redistribute (signal `tp:[]`, no channel TP memory newer than basket open, single-TP-across-many-legs guard rejects). No broker call happened; the fired leg opened with stops.
- **Worker change (main repo, done + tested, not yet committed/pushed):** skip branch now logs `attempted:0, failed:0, skippedReason:'no_tp_ladder'`; new exported `rangeBasketTpRebalanceStatus()` maps `skippedReason → 'skipped'`, else `modified>0 || attempted===0 ? 'success' : 'failed'`.
- **THIS repo — `src/lib/failureExplainer.ts`:**
  - Added `no_tp_ladder` to `SKIP_REASON_EXPLANATIONS` ("No take-profit ladder to redistribute — skipped, not failed; nothing modified on the broker").
  - Generalized `explainFailure(cause, source)`: execution/dead-letter rows now fall back to `SKIP_REASON_EXPLANATIONS[normalizeKey(cause)]` when the broker-error matchers return null (previously only `source==='signal'` looked those up). This matters because `executionLogToErrorItem` derives `cause` from `request_payload.skipped_reason` when `error_message` is null, so the modal/ErrorsPage title now resolves for `no_tp_ladder` rows.
- **THIS repo — `src/components/pipeline/PipelineSections.tsx`:**
  - Added `payloadSkipReason(log)` helper (reads `request_payload.skipped_reason ?? skip_reason` when `status==='skipped'`).
  - `ExecutionAttemptsSection` (line ~421): for `MANAGEMENT_ACTIONS` rows that are `skipped`, it now shows `Skipped — no broker action. Reason: <reason>.` instead of the misleading `Broker ticket for this action: none on linked trade — this is why it fails with "unknown ticket"` (that ticket line is now only shown for non-skipped rows).
- **Deliberately NOT changed:** `src/lib/errors.ts` `classifyErrorSeverity` — new `skipped` rows never reach the Errors pages because `isFailureStatus` only accepts `failed`/`error`. A skip will not show as Major. Historical pre-change `failed` rows (24 for this action) remain as-is in the DB.
- **Verification status:** NOT yet verified in this repo — `npm run typecheck` / `npm run lint` pending (handing off to another agent). Worker + frontend tests pass in the main repo (`rangeBasketTpSync.test.ts` 32/32, `channelWorkerLogMessage.test.ts` 27/27).
- **Handoff note for the agent taking over:** the admin working tree already contains OTHER uncommitted changes NOT from this task (`src/components/ErrorDetailModal.tsx`, `ReportDetailModal.tsx`, `SignalDetailModal.tsx`, `TradePipelineModal.tsx`, `SignalPipelineBody.tsx`, `src/lib/errors.ts`, `src/pages/ErrorsPage.tsx`, `supabase/functions/trade-pipeline-explainer/index.ts`, plus this repo's `docs/PROJECT_MEMORY.md`). Do not bundle them with this change.
- **Follow-up:** typecheck + lint this repo; deploy admin after the main-repo worker change ships (skipped rows only exist once the new worker emits them).

### 2026-08-11 — Errors page: one aggregated list instead of per-category cards; Failure causes panel kept

- **Context (user request):** user saw the page split into multiple category cards, each with its own table, so the newest error differed depending on which card/filter was viewed. User: "THERE ARE DIFFERENT LIST CATEGORIES... WE SHOULD HAVE ONE AGGREGATED LIST, THEN THE FILTERS SHOW ONLY THE TRADES NEEDED." They explicitly asked to KEEP the "Failure causes" panel ("I STILL WANT THIS KEPT OH, THIS IS VERY USEFUL").
- **`src/pages/ErrorsPage.tsx`:**
  - Removed the `CategoryGroup` interface and `newestItemTimestamp()` helper (no longer needed).
  - Replaced the `{ categories, totals }` memo with a `totals` memo (adds `categoryCount` from distinct category keys across filtered items) plus a `sorted` memo (all filtered items, newest-first by `created_at`).
  - Stat card now uses `totals.categoryCount` instead of `categories.length`.
  - Replaced the per-category `<Card>` loop with a single aggregated `<table>`: adds a `Category` column (source icon + `categoryLabel`), then User / Trade / Cause / Severity / Created. Row click still opens `ErrorDetailModal`.
  - **Kept unchanged:** the "Failure causes" breakdown card (clickable causes, count/severity badges, `Clear cause filter`), the filter bar (search / category / severity / date range), and the summary stat cards.
- **Behavior:** at rest, one list sorted newest-first across ALL sources/categories; the category filter narrows the same single list; clicking a cause in Failure causes narrows it too.
- **Verification:** `npm run typecheck` ✓, `npm run lint` ✓ (0 errors; 2 pre-existing `react-refresh/only-export-components` warnings in unrelated files).
- **Follow-up:** none.

### 2026-08-11 — Errors page: category cards now ordered by newest error (not count), so the latest error is on top with or without filters

- **Context (user request):** on `/errors`, unfiltered the top card (`Signal parse failed`, 238 items) showed its newest error at 08:25, while with the "today" filter applied the top card (`Broker · Stops rejected`, 180 items) showed 12:43 — user: "at rest, the latest error is at 8am, but with the filter applied, the latest error is 12pm". No data was actually missing (the failure-causes panel showed `Invalid stops 180` in both views); the 12:43 errors were simply one card down in the unfiltered list.
- **Root cause:** `ErrorsPage` sorted category cards by item count (`b.items.length - a.items.length`). Without filters, `Signal parse failed` (238) is biggest so it renders first and its newest (08:25) leads the page; the today filter shrinks that card to 13, promoting `Broker · Stops rejected` (180) to the top.
- **`src/pages/ErrorsPage.tsx`:** added `newestItemTimestamp(group)` helper (max `created_at` across a card's items) and changed the category-card sort to recency-descending. Items within each card were already newest-first, so the top card is now always the one containing the globally latest error. Count-based ranking still lives in the "Failure causes" panel.
- **Verification:** `npm run typecheck` ✓, `npm run lint` ✓ (0 errors; 2 pre-existing `react-refresh/only-export-components` warnings in unrelated files).
- **Follow-up:** none.

### 2026-08-11 — Errors page cause filter: normalize keys so clicking any cause (incl. "(no message)") actually filters

- **Context (user request):** On `/errors`, clicking the "(no message)" cause in the Failure causes panel (or the "Invalid stops" / "Not enough money" chips) cleared the list to 0 — "when clicked on, the errors are empty". The "(no message)" bucket had 69 rows and the modal showed no reason.
- **Root cause (two parts):**
  1. **Data:** `trade_execution_logs` has 197 `failed`/`error` rows with `NULL error_message` — all from `mgmt_modify_broker_summary` (173) and `range_basket_tp_rebalance` (24). The worker writes those two actions with `status:'failed'` but no `error_message` (failure detail is only inside `request_payload.skip_reasons`, e.g. `["Invalid stops"]`) — `channelStopApply.ts:832-862` (`logMgmtModifyBrokerSummaries`) and `rangeBasketTpSync.ts:294-333` (`logRangeBasketTpRebalance`). That is why the Errors page grouped them as "(no message)" and the modal had no message to show. Broker errors are stored capitalized (`Invalid stops`, `Not enough money`); signals always carry `skip_reason`.
  2. **Filter bug:** `ErrorsPage` grouped causes by the raw trimmed string (`(item.cause ?? '').trim() || '(no message)'`) but the filter compared `(item.cause ?? '').toLowerCase() !== causeFilter` against the raw click value. So lowercase causes matched only by luck (`entry_not_opened`, `unknown ticket`), while `(no message)` (item cause `''`/null) and capitalized causes (`Invalid stops` → `invalid stops` vs raw) always filtered to zero rows.
- **`src/pages/ErrorsPage.tsx`:** added `causeKey(cause)` = `(cause ?? '').trim().toLowerCase() || '(no message)'` and used it for the filter predicate, the `causeBreakdown` grouping (display keeps the original trimmed text via `entry.cause`), the per-category cause chips, and the click handlers so the filter value always equals the canonical key.
- **Second fix (same session, "no message" data):** `mgmt_modify_broker_summary` / `range_basket_tp_rebalance` failed rows have `error_message = NULL`, but the real cause is embedded in `request_payload` (`skip_reasons: ["Invalid stops"]`, `skipped_reason`, `reason`, `error`). `src/lib/errors.ts`:
  - New `causeFromRequestPayload(payload)` — reads `skip_reasons[]` (first non-empty string) then `skipped_reason`/`skip_reason`/`failure_reason`/`reason`/`error`.
  - `executionLogToErrorItem` now falls back to `causeFromRequestPayload(r.request_payload)` when `error_message` is empty, so the 68 "(no message)" rows now render with a real cause ("Invalid stops") and group under the correct `Broker · <category>` bucket via `applyBrokerCategory`.
  - `extractTradeContext` now also digs symbol/direction/ticket out of a nested `request_payload`, so those rows show the trade instead of "—".
- **Verification:** `npm run typecheck` ✓, `npm run lint` ✓ (0 errors; 2 pre-existing `react-refresh/only-export-components` warnings), `npm run build` ✓. Prod SQL cross-check confirmed the data shape (197 null-message exec rows, capitalized broker errors).
- **Follow-up:** worker-side improvement (optional, in `~/projects/TSCopier`, NOT this repo): have `logMgmtModifyBrokerSummaries`/`logRangeBasketTpRebalance` write `error_message` from `skip_reasons` so these failures show a real cause instead of "(no message)".

### 2026-08-10 — Report modal: full pipeline added, Telegram section kept, AI gets modal context; edge function DEPLOYED

- **Context (user request):** "The AI needs to focus on what was reported and the issue", "Do not remove the telegram message, it is important", "The AI should read the telegram message", messages were "too short" and lacked context, and the AI must know "which modal it is in and what to prioritize inside that modal."
- **Root cause:** (1) the `trade-pipeline-explainer` edge function had **never been redeployed** — prod was still running the old prompt that ignored the report entirely; (2) the old prompt capped the summary at "2-4 short sentences"; (3) the AI had no idea where its output was displayed, so it answered the same generic latency question everywhere.
- **`supabase/functions/trade-pipeline-explainer/index.ts` (DEPLOYED to prod `sxkpcovbyaficvtkpsdo` + staging `jolsabyxmjuhohozwdrc`):** summary rule now demands 4-8 sentences and leads with a verdict (VALID / PARTIALLY VALID / NOT VALID / CANNOT VERIFY) when a report is present; new rule forces reading + quoting the Raw message line-by-line and comparing declared SL/TP/entry/direction/lots vs parsed data vs actual trade; user prompt marks the raw message as "read this FIRST, quote it". New optional `context` field accepted in the body and injected as a CONTEXT line in the system prompt telling the AI which modal it is in and what to prioritize.
- **`src/components/pipeline/PipelineSections.tsx` (`AiExplainSection`):** new optional `context` prop forwarded in the invoke body and added to the cache key.
- **`src/components/pipeline/SignalPipelineBody.tsx`:** threads `context` through and now passes `tradeId` to `AiExplainSection`.
- **`src/components/ReportDetailModal.tsx`:** keeps the dedicated "Telegram message & channel" section; replaces the separate AI section with the full `SignalPipelineBody` (issues, model chain, execution attempts, latency, AI analysis) inside a "Signal pipeline" section; passes report + a USER COMPLAINT MODAL context string; modal height raised from `max-h-[calc(100vh-12rem)]` to `calc(100vh-6rem)`.
- **`src/components/SignalDetailModal.tsx` / `ErrorDetailModal.tsx` / `TradePipelineModal.tsx`:** each passes a bespoke `context` string (signal outcome first / lead with failure / trade+broker protection first respectively).
- **Verification:** `npm run typecheck` ✓, `npm run lint` ✓ (0 errors, 2 pre-existing warnings), `npm run build` ✓. Edge function deployed to both projects (Docker warning only; upload succeeded).
- **Follow-up:** verify in the browser on a reported trade — the AI should now quote the Telegram signal and rule on the complaint.<｜end▁of▁thinking｜>



- **Context (user request):** the AI analysis for a reported trade ("Wrong stop loss — No SL") answered the wrong question — it only commented on pipeline latency ("Telegram to listener took 4062 ms") and never addressed the report. User: "See how stupid the ai analysis for a reported trade is" and "It should be able to read the telegram message too."
- **Root cause:** `AiExplainSection` invoked the `trade-pipeline-explainer` edge function with only signal/trade/broker IDs. The report (category + reason) was never sent, so the prompt had no complaint to judge. The raw Telegram message WAS already in the input, but no rule told the AI to use it.
- **`supabase/functions/trade-pipeline-explainer/index.ts`:** `explainSignal` now takes an optional `report` object. New system rule: when a USER REPORT is present it is the PRIMARY question — read the original Telegram signal text and the actual trade, judge whether the complaint is valid (e.g. "No SL" → is stoploss 0 or unconfirmed?), and lead the summary with the verdict. User prompt gains a `USER REPORT (answer this first):` line with category/reason/symbol/direction. Handler parses `body.report`.
- **`src/components/pipeline/PipelineSections.tsx` (`AiExplainSection`):** accepts an optional `report` prop, forwards it in the invoke body, and includes category+reason in the cache key so report-aware analyses aren't served from the plain-pipeline cache.
- **`src/components/ReportDetailModal.tsx`:** passes the report (category/reason/symbol/direction) into `AiExplainSection`.
- **Verification:** `npm run typecheck` ✓, `npm run lint` ✓ (0 errors, 2 pre-existing-style `react-refresh/only-export-components` warnings), `npm run build` ✓. Deno typecheck of the edge function not run (no `deno` binary on PATH).
- **Follow-up:** deploy the updated `trade-pipeline-explainer` edge function (Netlify/Supabase) for the report-aware prompt to take effect.

### 2026-08-10 — Reports page: click a report row to open full detail modal (report, trade, Telegram message + AI analysis)

- **Context (user request):** "For reported trades, i should be able to open it, see the details of what the user reported, the details of the trade, the telegram message and channel, an ai analysis of the trade too."
- **NEW `src/components/ReportDetailModal.tsx`:** exports `ReportRow` (now includes `entry_price`/`sl`/`tp`/`lot_size`) and `CATEGORY_LABELS`. Sections:
  - **What the user reported** — category, reason, ticket, broker, entry/SL/TP/lot as submitted.
  - **The trade** — matches the report's `ticket` against `trades.metaapi_order_id` (+ `user_id`), lists up to 5 matching trades with status/profit/entry/SL/TP/opened/closed. The report ticket equals the broker ticket at report time; trades store the same value in `metaapi_order_id`.
  - **Telegram message & channel** — via `useSignalPipeline(firstTrade.signal_id)`: channel display name, signal status, raw message (uncollapsed), parsed data.
  - **AI analysis** — reuses the existing `AiExplainSection` (edge function `trade-pipeline-explainer`) with `signalId`/`tradeId`/`brokerAccountId` from the first linked trade. Falls back to a note when no linked signal exists.
- **`src/pages/ReportsPage.tsx`:** imports `ReportRow`/`CATEGORY_LABELS` from the modal (dedup); query now selects the extra report fields; table rows are clickable (`onRowClick` → `setSelectedReport`); Resolve/Reopen button calls `e.stopPropagation()` so it doesn't open the modal; modal rendered at the bottom.
- **Verification:** `npm run typecheck` ✓, `npm run lint` ✓ (0 errors; 2 `react-refresh/only-export-components` warnings — the pre-existing `PipelineSections.tsx` one plus the new `ReportDetailModal.tsx` one for its shared type/const exports), `npm run build` ✓.
- **Follow-up:** none.

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
