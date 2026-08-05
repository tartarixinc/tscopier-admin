# User Activity Tabs + Deep-Dive Modals (2026-08-04)

Feature work on `feat/trade-pipeline-analytics`. Replaces the three stacked cards on the
user detail page (`/users/:userId`) with tabs, enables browsing **all** of a user's rows,
and adds per-row deep-dive modals with AI explanations.

## Tabs

`src/components/user/UserActivityTabs.tsx` renders `Tabs` (`src/components/ui/Tabs.tsx`)
with counts, defaulting to **Signals**:

| Tab | Component | Page size | Filters | Row click opens |
|---|---|---|---|---|
| Signals | `UserSignalsTab.tsx` | 20 | status, date range | `SignalDetailModal` |
| Trades | `UserTradesTab.tsx` | 20 | status, direction, date range | `TradePipelineModal` (existing) |
| Copier Logs | `UserCopierLogsTab.tsx` | 30 | status, action, date range | `CopierLogDetailModal` |

Pagination is server-side (`range`) against the user's rows, latest first. Profile /
subscription / telegram / brokers / channels sections are unchanged; quick-stats now show
real totals from count-only queries (`select('id', { count: 'exact', head: true })`).

## Modals

### Latency modal — `TradePipelineModal`

The per-trade pipeline deep-dive (built in the 2026-08-03 analytics session, refactored
this session). Opened by clicking a row in **TradesPage** or the **Trades tab**
(`UserTradesTab`). It renders:

- **Summary cells** — entry, SL/TP, lots, P&L (green/red), broker, opened, closed, signal ID.
- **Pipeline timeline** — vertical event list of the signal's journey
  (Telegram source → listener → parse → persist → queue → planning → claim → broker →
  reconciliation), each step with timestamp, offset, and duration vs the previous step;
  dot color = fast/slow/critical, final signal status badge on the last step.
- **Latency graph (Gantt)** — each stage on its own row; bar position = when it
  happened, bar length = how long it took; green <500 ms, amber 500 ms–2 s, red ≥2 s;
  header shows total journey time.
- **What happened (AI)** — "Explain this trade" button calling the
  `trade-pipeline-explainer` edge function (signal mode); result cached per `signal_id`
  in a module-level `Map`; shows overall badge (fast/normal/slow) + anomaly list.
- **Latency breakdown** — per-stage table (duration ms + % of total with bars),
  including the `total_ms` headline row.
- **Signal data** — raw message + parsed data JSON, plus canonical `channel_signals`
  raw message and skip reason when found.
- **Execution attempts** — numbered attempt list (order shows retries), each with
  action, status, error message, request/response JSON; "retried — X across attempts"
  pill when more than one attempt exists.

All sections live in `src/components/pipeline/PipelineSections.tsx`
(`PipelineTimelineSection`, `LatencyGanttSection`, `LatencyBreakdownSection`,
`AiExplainSection`, `ExecutionAttemptsSection`, `SummaryCell`) and are shared with
`SignalDetailModal` — the latency modal itself only handles data fetching + layout.
Pipeline parsing/stat logic: `src/lib/pipelineTimeline.ts` (`parsePipelineTimestamps`,
`buildPipelineTimeline`, `stageStats`).

### Signal modal — `SignalDetailModal`

Signal summary, skip banner (signal + canonical `channel_signals.skip_reason`),
"what failed" banner (first failed execution error), linked trade card, pipeline
timeline / latency Gantt / breakdown, raw + parsed JSON, execution attempts, AI button.
Reuses the latency modal's shared sections.

### Copier log modal — `CopierLogDetailModal`

Verdict banner (Succeeded / Failed / Skipped), humanized interpretation
(`src/lib/copierLogInterpreter.ts`), labeled request/response field grids, raw
payload toggles, AI button.

## Log interpreter (`src/lib/copierLogInterpreter.ts`)

Rule-based, no AI needed for the base view:

- `ACTION_DESCRIPTIONS` — covers all 22 actions observed in staging
  `trade_execution_logs` (order_send, dispatch_*, mgmt_*, basket_leg_modify, merge_*,
  virtual_pending_*, …).
- Skip reason codes (`mgmt_no_open_trades_db`, `duplicate_provider_signal`, …) and error
  patterns ("unknown ticket", "requote", insufficient funds, timeouts, invalid symbol…)
  mapped to plain English; unknown values fall back to the raw string.
- Curated `REQUEST_FIELD_LABELS` / `RESPONSE_FIELD_LABELS` surface the meaningful fields
  (ticket, symbol, price, volume, SL/TP, latency, tickets, fill price…); anything not
  mapped stays visible in the raw payloads.

## Edge function (`supabase/functions/trade-pipeline-explainer`)

Not deployed yet (blocked on `OPENAI_API_KEY`). Two modes:

- `{ signal_id }` — pipeline/latency analysis; now also includes both skip reasons and is
  instructed to explain **why** a signal was skipped or what failed.
- `{ log_id }` — explains a single copier log entry → `{ explanation, details[] }`.

Both require an admin JWT (`is_admin` check) and use gpt-4o-mini with JSON response.

## Verification

- `npx tsc -b` — clean
- `npm run lint` — 0 errors / 0 warnings (repo-wide cleanup, see PROJECT_MEMORY 2026-08-04)
- `npm run build` — succeeds
- Manual check still needed: click through all 3 tabs + 3 modals on dev (staging env);
  AI buttons only work after the edge function is deployed with the OpenAI key.
