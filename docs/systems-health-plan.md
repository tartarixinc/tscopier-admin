# Systems Health — Operations Cockpit Plan v2 (verified 2026-08-25)

Supersedes v1 (below, kept for history). v2 incorporates three audit rounds:
signal-lifecycle semantics, prod data availability, and query/latency verification.

## Goal

A full operations cockpit at `/monitoring/systems-health` in tscopier-admin: data-dense,
every signal accounted for, blockages visible anywhere (counts AND ages), every number
explainable, unknown sources never rendered green.

---

## 1. Command header

Environment badge · freshness stamp · overall verdict · headline counters
(workers online, users listening, brokers connected, executions in window) · DB clock offset.
Single shared refresh cycle; stale-data banner + exponential backoff on unreachable DB.

## 2. Signal flow control board

Full accounting — every windowed signal lands in exactly one bucket:

| Stage | Definition | Query |
|---|---|---|
| Received | all rows projected in window | head-count `created_at >= since` |
| Tradeable | entered execution funnel: `status IN ('parsed','executed','failed')` | head-count |
| Dispatched (attempts) | distinct `signal_id` among claims created in window; labeled attempts (claims are a mutex — deleted on range-wake/retry) | one bounded windowed fetch + client distinct |
| Executed | `status='executed'` (proof-gated upstream by signalExecutionProven) | head-count |
| Failed | `status='failed'` (broker attempted, nothing opened) | head-count |
| Filtered out | `status='skipped'` — exit lane with skip-reason breakdown, NOT a stage | head-count |
| Pending in flight | `status='pending'` + oldest age (>15 min warn / >60 min or >10 stuck red) | oldest-row fetch |

**Stage ages:** median/P95 per stage from `pipeline_ts` epoch-ms keys.
Verified mapping (worker/src/pipelineTimestamps.ts):
- Parse latency = `parse_completed_at − parse_started_at`
  (fallback end `t_parse_done ?? t_ai_parse_done`; fallback start `telegram_message_received_at`)
- Dispatch/handoff latency = `queue_consumed_at − t_dispatch_sent` (fallback start `queue_published_at`)
- End-to-end = `trade_execution_logs.pipeline_summary.total_ms` (`action='pipeline_summary'`)
  — execution-phase stamps do NOT live in signals.pipeline_ts
- Each metric counts its own samples; documented gaps: primary-projector rows drop
  pipeline_ts, revision re-dispatch overwrites it, FK-stub rows have none,
  `reconciliation_*` keys are dead code.

## 3. Worker fleet table

One row per live replica. Parse `worker_id` defensively: segment[0]=role prefix
(`listener`|`channel_listener`), [1]=shard, LAST=build tag, middle=instance
(instance may contain colons — `hostname:pid`). Only listener roles write leases today.
Columns: role · shard · leases held · last heartbeat · build. Shard-count disagreement
highlighted. Zero rows = red.

## 4. Telegram connectivity

Linked (`telegram_sessions` rows — invalidation deletes rows, nothing sets is_active=false)
· Listening now (fresh listener-role leases ≤120s) · Auth pending (`telegram_auth_pending`
non-expired). Flagged list: linked-but-not-listening users (support's top ticket).
Upgrade path: when prod workers ship PR #82, `copier_listener_health` fills and the tile
switches to per-user listener_status/MTProto state automatically (expected empty until then).

## 5. Broker connections

`broker_accounts.connection_status` mix (connected/recovering/error) + top
connection_error_kind table + affected-user counts. Answers "broker outage vs our bug".

## 6. Execution quality

Failure buckets (system/external/user/unclassified; UNCLASSIFIED never alarms) ·
escalation ≥2 users AND ≥5 occurrences AND >5× floored baseline · recent failed-signals
table · success rate excluding user-bucket noise.
Execution-log statuses are ONLY attempt|success|failed|skipped (no rejected/error).

## 7. Queue & dead letters

Dead-letter table by lane/status/attempts with replay links; unresolved count;
oldest pending age. RLS caveat: dead letters has no admin SELECT policy in repo —
verify prod before shipping this panel or it renders silent-empty.

## 8. Support console

Paste user_id → last-24h per-user: signal counts by status, recent signals+skip reasons,
lease state, telegram linkage, broker connection states. Feasibility proven:
idx_signals_user_created_at exists; UserDetailPage already runs the same shapes.

## 9. Diagnostics drawer

Unreadable/saturated sources with exact errors · clock offset · escalation reference ·
per-source freshness.

---

## Alarm rules (the only things that go amber/red)

1. Stuck-parsed alarm: `status='parsed'` beyond 10-min grace EXCLUDING range-parked
   (`signal_range_entry_waits.status='waiting'`); warn ≥3–5 stuck confirmed twice ~5 min apart.
   Claims-based "dispatched minus executed" is INVALID (claim deletions undercount).
2. `failed` signals present beyond noise floor (same escalation gates as buckets).
3. Workers zero / shard mismatch / queue stuck / dead letters ≥20 / broker connected=0
   while listening>0 / linked≫listening gap.
4. Unknown/unreadable source ⇒ verdict "cannot be determined" — never green.

## Engineering rules

Exact head-counts everywhere (count=exact, zero rows) — immune to Supabase 1000-row cap.
Server-clock windows from lease heartbeats only. Hysteresis keyed per window.
Unmount-safe setState. No raw payloads outside existing modals. Env badge in page body.

## Required migrations (apply STAGING first)

```sql
CREATE INDEX IF NOT EXISTS idx_signals_created_at ON public.signals (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trade_exec_logs_created_at ON public.trade_execution_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dispatch_claims_created_at ON public.signal_broker_dispatch_claims (created_at);
```

Pre-launch checklist: verify on PROD that public.is_admin() exists, admin SELECT policies
exist for signal_broker_dispatch_claims AND signal_queue_dead_letters, and no new missing
migrations (see docs/prod-missing-migrations-2026-08-16.md precedent).

## Build phases

- Phase A: index migration file + systemHealth.ts rework (head-counts, ts-key aliases,
  stuck-alarm formula, latency metrics incl. logs join) + header, flow board, fleet, queue.
- Phase B: Telegram/broker/execution sections with fallback sources.
- Phase C: support console + diagnostics drawer + prod verification checklist.

---
---

# v1 PLAN (historical)

# Systems Health Page — Plan (approved 2026-08-25)

Single admin page at `/monitoring/systems-health` answering one question at a glance:
is everything working right now, and if not, what part?

## Decisions approved

1. **RLS step 0:** admin read access verified by usage — every table this page needs
   (`signals`, `trade_execution_logs`, `worker_session_leases`, `copier_listener_health`,
   `listener_events`, `signal_broker_dispatch_claims`, `signal_queue_dead_letters`) is
   already queried successfully by existing admin pages on both environments. No new
   migration required. The page treats "source unreadable" as a first-class state,
   never folded into green.
2. **Noise thresholds:** user-level broker errors escalate to system alerts only when
   ALL of: ≥2 distinct users, ≥5 occurrences in window, and >5× floored baseline
   (baseline = prior-7-days average for same window length, floored at ≥1).
3. **Scope: Option A.** Phase 1 is database-only. The Telegram realtime tile uses
   `copier_listener_health` (DB ground truth written by workers). No Railway-log
   edge function in this phase.

(Design details of v1 intentionally retained in git history; see commit e9ce213.)

## Post-build corrections (2026-08-25, live-data verification)

Verified the dashboard against real prod data via SQL the admin ran in the
Supabase editor. Three real bugs surfaced and were fixed:

1. **Failure reasons read the wrong column.** Worker writes `reason_code` into
   `request_payload`, not `response_payload` — everything showed UNCLASSIFIED.
   Fixed the read + verified against live data (INVALID_STOPS, BROKER_ORDER_REJECTED,
   INSUFFICIENT_MARGIN now classify correctly).
2. **Classifier taxonomy too small.** Only ~5 codes known; real worker codes
   (QUEUE_*, *_FAILED, COPIER_ENGINE_OFFLINE, INVALID_STOPS, UNKNOWN_TICKET,
   BROKER_EA_NOT_READY) fell into UNCLASSIFIED and were silently quarantined.
   Expanded to the worker's full set + known broker rejection texts.
3. **telegram_auth_pending forced "cannot determine".** Worker-only table, no
   admin SELECT policy → its query error polluted unreadableSources → permanent
   undetermined verdict. Now best-effort (shows 0, never blocks verdict).

Also fixed: "Linked but not listening" rendered 54 raw UUIDs → now display names,
capped + collapsible. Added Support Console (paste user_id → pipeline + connection
state). Added UNCLASSIFIED-drift guard (if >50% of failures lack a reason, warn —
catches a worker regression that would silently re-hide everything).

Known env gap (not a code bug): `broker_accounts.connection_error_kind` missing on
STAGING (migration drift) — broker error-kinds list renders only on prod until that
migration is applied to staging.

## Deploy status
- Railway storm fix: origin/staging + upstream staging+dev (fe0bd785). Railway verified
  healthy both envs (no storm, 0 rate limits). PROD still on pre-fix code — must reach
  prod (gated on staging validation).
- Admin cockpit + edge function: built + verified locally; NOT deployed. Deploy requires
  a working Supabase CLI token (`supabase login` — current ~/.supabase/access-token is
  Unauthorized) to apply index migration to staging + deploy systems-health-railway fn.
- No commits yet (per user).
