# Latency Monitoring — Options A and B

Decision date: 2026-08-03
Decision: **Option A implemented now**; Option B deferred (evaluate when failure-path
monitoring or SQL-side aggregation is needed).

## Context

The worker (`TSCopier/worker/src/pipelineTimestamps.ts`) already instruments the
full trade path with 22+ timestamps — Telegram source message → listener receipt →
parse → signal persist → queue publish → queue consume → execution planning →
claim → broker resolution → broker request → broker response → execution confirmed →
state persisted → reconciliation. It is designed to never slow trading down:
in-memory `Date.now()` stamps, fire-and-forget event emission (`setImmediate`),
everything wrapped in try/catch ("Observability must never affect trade execution").
Stamps are persisted today on `signals.pipeline_ts` (jsonb) and
`channel_signals.pipeline_ts`.

## Option A — Read what is already stored (implemented)

**What it gives you:**
- Per-trade pipeline timeline and latency breakdown for every executed trade
  (from `signals.pipeline_ts` via `trades.signal_id`).
- Aggregate latency stats (avg / p50 / p95 per stage) computed client-side in the
  admin over the last 30 days.

**How:**
- Admin-only work: `lib/pipelineTimeline.ts`, `TradePipelineModal.tsx`,
  latency tab on `TradesAnalyticsPage.tsx`.
- Zero new instrumentation, zero new DB writes, zero worker changes.

**Limits:**
- Only signals that became rows (`signals` / `channel_signals`). Failed parses,
  skipped signals, duplicates, and dead letters that never persisted a row are
  NOT captured in `pipeline_ts` (they exist only in worker stdout logs).
- Aggregation happens in the browser; at very large trade volumes the 30-day
  fetch of `pipeline_ts` becomes heavy (acceptable at current scale).
- `pipeline_ts` on `signals` was added recently (`20260724120000_signals_pipeline_ts.sql`),
  so no history before that migration.

## Option B — New event-stream table `trade_pipeline_events` (deferred)

**What it gives you:**
- A first-class, queryable event stream: one row per pipeline event
  (`signal_received`, `parse_failed`, `queue_consumed`, `broker_request_succeeded`,
  `execution_reconciled`, …) with correlation ids (`signal_id`,
  `telegram_message_id`, `channel_id`, `queue_message_id`, `execution_attempt_id`,
  `broker_request_id`, `worker_id`, `shard_id`).
- Covers the failure paths Option A cannot see (failed/skipped/duplicate signals,
  dead letters) — answers "why did this signal never execute?".
- SQL-side percentile/aggregation queries at scale; retention/pruning policy.

**How (when we build it):**
- New table + RLS (admin read) + retention cron, in a migration.
- Worker writes events through the existing `emitPipelineEvent()` fire-and-forget
  pattern (or a small batched writer) — never awaited on the execution path, so
  the latency guarantee holds. The event payload (redacted, correlation ids +
  durations) is already constructed in `pipelineTimestamps.ts` today.
- Admin reads the table for the timeline + analytics instead of parsing
  `signals.pipeline_ts`.

**Costs:**
- New table + index + retention policy; storage growth; more worker code to
  review and deploy; backfill of pre-migration history is impossible (events are
  currently stdout-only).

## Recommendation

Ship A now — it fully answers "what happened for this executed trade, and how
fast?" with zero risk to the trading path. Revisit B when (a) you want a UI for
failed/skipped signals with their reasons, or (b) client-side aggregation gets too
slow at scale.
