# Systems Health Page — Plan (approved 2026-08-25)

Single admin page at `/monitoring/systems-health` answering one question at a glance:
is the platform working right now, and if not, which part?

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

## Design

### Three-layer progressive disclosure
- **Layer 1 — verdict sentence.** Computed only from System-bucket checks.
  States: "Everything is working normally." / "N things need attention." /
  "Health cannot be fully determined." (any unreadable source forces this).
- **Layer 2 — six tiles** (one number + one word each):
  Trade copying · Telegram connection · Broker orders · Workers running ·
  Waiting queue · User sessions.
- **Layer 3 — pipeline strip** (blockage spotter):
  `Received → Parsed → Dispatched → Executed`, counts per stage over a selectable
  window (1h/6h/24h). A stage where counts pile up turns amber/red with a plain-
  English hover sentence; clicking deep-links to the relevant detail page.

### Ownership buckets (definitive data, not noise)
Every classified error maps to exactly one bucket:
- **System** — worker down, stuck queue, stale claims, DB errors. Always counts.
- **External** — market closed, third-party outage. Counts only if widespread.
- **User** — insufficient funds/margin, invalid lot, expired session. Never counts
  toward system health unless escalation thresholds (above) are met.
Unknown/unmatched reasons go to an explicit `UNCLASSIFIED` bucket, counted but
never silently treated as System or User.

### Pipeline stage definitions (review-corrected)
- Received: `signals.created_at` in window.
- Parsed: `pipeline_ts.parsed_at` in window; fallback `status != 'pending'` with
  `created_at` in window (legacy rows).
- Dispatched: **distinct** `signal_id` count from `signal_broker_dispatch_claims`
  with `created_at` in window (claims fan out per broker — never compared raw).
- Executed: `status='executed'` signals whose `pipeline_ts.executed_at`
  (fallback `updated_at`) falls in the window.
Known distortion documented in-page: `trade_execution_logs` retention keeps newest
500 rows/user, so log-based counts are annotated as approximate.
Replays re-enter mid-funnel via `pipeline_ts.parsed_at`; they are counted as Parsed
only if that timestamp lies inside the window.

### Clock handling
All ages compare DB timestamps against a server-time estimate derived from
`max(signals.updated_at)` (clock-offset proxy), never raw laptop time.

### Stability rules
- Hysteresis: a check must fail 2 consecutive samples before showing red;
  recover to green only after 2 consecutive healthy samples.
- One shared fetch cycle fans out all queries; on repeated failure the page shows
  an explicit "Cannot reach database — showing data from HH:MM:SS" banner and
  backs off instead of hammering.
- Environment badge rendered inside the page body (not just the shell).

### Checks → tiles mapping
| Tile | Source | OK | Warn | Fail |
|---|---|---|---|---|
| Workers running | `worker_session_leases` | active leases > 0, consistent shard_count | shard_count inconsistency across leases | 0 active leases |
| Telegram connection | `copier_listener_health` | all connected, fresh `updated_at` (< freshness_threshold_ms) | some reconnecting/stale | majority failed/disconnected |
| User sessions | `copier_listener_health` + leases | matches expectations | N users disconnected | — |
| Waiting queue | `signals.status='pending'` age + dead letters unresolved | nothing stuck older than 15 min | stuck pending > 0 / few dead letters | many stuck |
| Broker orders | `trade_execution_logs` outcomes + classification | success rate high after excluding User bucket | elevated System/External errors | execution failing broadly |
| Trade copying | pipeline strip health (drop-off between stages) | flow-through normal | mild drop-off | hard blockage |

## Out of scope (later phases)
Railway-log edge function tile · cron/CI alerting · historical trend charts.

## Implementation status (2026-08-25)

Built and verified: typecheck ✓, eslint (changed files) ✓, vite build ✓.
Files: src/lib/systemHealth.ts, src/pages/SystemHealthPage.tsx, routes in
src/App.tsx, sidebar entry in src/components/AdminShell.tsx.

Review cycle: code-review initially FAIL (2 HIGH blockers + 5 MEDIUMs); all
fixed and re-reviewed PASS (A-/A/A/A-). Fixes applied:
- Query-cap saturation → source unreadable → verdict "undetermined" (never green).
- Baseline via exact head-count; backoff/stale-banner now engage on !dbReachable.
- Executed stage counts pre-window signals executed inside the window
  (second bounded fetch on updated_at, merged by id, window-checked).
- Single server-clock base for every window bound; hysteresis keyed per window;
  unmount-safe setState; empty copier_listener_health renders unknown, not green.
Remaining follow-ups: Railway-log edge-function tile (phase 2), cron/CI alerting,
classifier parity test vs worker's classifyBrokerFailureReason.
