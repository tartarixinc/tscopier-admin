import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? ""
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? ""
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } })
}

function duration(end: number | null | undefined, start: number | null | undefined): number | null {
  if (end == null || start == null) return null
  return Math.max(0, end - start)
}

const STAGE_LABELS: Record<string, string> = {
  telegram_to_listener_ms: "Telegram → listener",
  parse_ms: "Parse",
  signal_persist_ms: "Signal persist",
  dispatch_ms: "Dispatch to queue",
  queue_wait_ms: "Queue wait",
  prep_ms: "Pre-execution prep",
  planning_ms: "Execution planning",
  execution_claim_ms: "Execution claim",
  order_send_ms: "Order send",
  broker_send_ms: "Broker request/response",
  broker_ack_ms: "Broker ack",
  broker_resolve_ms: "Broker session resolve",
  reconciliation_ms: "Reconciliation",
  telegram_receipt_to_broker_request_ms: "Receipt → broker request",
  telegram_receipt_to_broker_confirmation_ms: "Receipt → broker confirmation",
  total_ms: "Total",
}

function computeDurations(ts: Record<string, unknown>): Record<string, number> {
  const n = (k: string): number | null => {
    const v = ts[k]
    return typeof v === "number" && Number.isFinite(v) ? v : null
  }
  const out: Record<string, number> = {}
  const add = (key: string, end: number | null, start: number | null) => {
    const d = duration(end, start)
    if (d != null) out[key] = d
  }
  add("telegram_to_listener_ms", n("telegram_message_received_at"), n("telegram_source_message_at"))
  add("parse_ms", n("parse_completed_at"), n("parse_started_at") ?? n("telegram_message_received_at"))
  add("signal_persist_ms", n("signal_persist_completed_at"), n("signal_persist_started_at"))
  add("dispatch_ms", n("queue_published_at"), n("queue_publish_started_at"))
  add("queue_wait_ms", n("queue_consumed_at"), n("queue_published_at"))
  add("prep_ms", n("execution_planning_started_at"), n("queue_consumed_at"))
  add("planning_ms", n("execution_planning_completed_at"), n("execution_planning_started_at"))
  add("execution_claim_ms", n("execution_claim_acquired_at"), n("execution_claim_started_at"))
  add("order_send_ms", n("execution_state_persisted_at"), n("execution_planning_started_at"))
  add("broker_send_ms", n("broker_response_received_at"), n("broker_request_started_at"))
  add("broker_ack_ms", n("broker_execution_confirmed_at"), n("broker_request_started_at"))
  add("broker_resolve_ms", n("broker_ready_at"), n("broker_resolution_started_at") ?? n("execution_planning_started_at"))
  add("reconciliation_ms", n("reconciliation_completed_at"), n("reconciliation_started_at"))
  add("telegram_receipt_to_broker_request_ms", n("broker_request_started_at"), n("telegram_message_received_at"))
  add("telegram_receipt_to_broker_confirmation_ms", n("broker_execution_confirmed_at"), n("telegram_message_received_at"))
  const t0 = n("telegram_source_message_at") ?? n("telegram_message_received_at") ?? n("queue_consumed_at")
  const tEnd = n("reconciliation_completed_at") ?? n("execution_state_persisted_at") ?? n("broker_execution_confirmed_at") ?? n("broker_response_received_at") ?? n("queue_consumed_at")
  add("total_ms", tEnd, t0)
  return out
}

async function requireAdmin(supabase: ReturnType<typeof createClient>, req: Request): Promise<boolean> {
  const auth = req.headers.get("Authorization") ?? ""
  const token = auth.replace(/^Bearer\s+/i, "").trim()
  if (!token) return false
  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) return false
  const { data: profile } = await supabase
    .from("user_profiles")
    .select("is_admin")
    .eq("user_id", user.id)
    .maybeSingle()
  return profile?.is_admin === true
}

async function callOpenAI(system: string, user: string): Promise<{ content: string; status: number; error: string | null }> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  })
  if (!res.ok) {
    const errText = await res.text()
    return { content: "", status: res.status, error: errText.slice(0, 200) }
  }
  const completion = await res.json()
  return { content: completion?.choices?.[0]?.message?.content ?? "", status: 200, error: null }
}

function snippet(value: unknown, max: number): string {
  if (value == null) return "(none)"
  if (typeof value === "string") return value.slice(0, max)
  try {
    return JSON.stringify(value).slice(0, max)
  } catch {
    return String(value).slice(0, max)
  }
}

async function explainSignal(
  supabase: ReturnType<typeof createClient>,
  signalId: string,
  focusedTradeId: string | null,
  focusedBrokerAccountId: string | null,
): Promise<Response> {
  const [{ data: signal }, { data: trades }, { data: logs }, { data: logStatuses }] = await Promise.all([
    supabase.from("signals").select("raw_message, parsed_data, status, skip_reason, pipeline_ts, channel_signal_id, channel_id, telegram_message_id, created_at, telegram_channels(display_name, signal_channel_id)").eq("id", signalId).maybeSingle(),
    supabase.from("trades").select("id, broker_account_id, metaapi_order_id, symbol, direction, status, entry_price, sl, tp, lot_size, profit, opened_at, closed_at").eq("signal_id", signalId),
    // Newest first — old failures (e.g. "Not enough money" before funding) must not
    // overshadow later successes; the model needs the outcome timeline, not just the first attempts.
    supabase.from("trade_execution_logs").select("action, status, error_message, request_payload, response_payload, created_at").eq("signal_id", signalId).order("created_at", { ascending: false }).limit(50),
    supabase.from("trade_execution_logs").select("status").eq("signal_id", signalId),
  ])

  if (!signal) return json({ error: "signal not found" }, 404)

  const allTrades = trades ?? []
  const focusedTrade = focusedTradeId
    ? allTrades.find((row) => row.id === focusedTradeId) ?? null
    : null
  const focusedTrades = focusedBrokerAccountId
    ? allTrades.filter((row) => row.broker_account_id === focusedBrokerAccountId)
    : allTrades

  const ticketOf = (row: { metaapi_order_id?: string | null }) => row.metaapi_order_id ? String(row.metaapi_order_id) : null
  const focusedTicket = focusedTrade ? ticketOf(focusedTrade) : null
  const orderLogs = (logs ?? []).filter((log) => log.action === "order_send" && log.status === "success")
  const managementLogs = (logs ?? []).filter((log) => ["trailing_stop", "auto_be", "breakeven", "range_basket_tp_rebalance", "virtual_pending_fired"].includes(log.action))
  const ticketFromPayload = (log: { request_payload?: unknown; response_payload?: unknown }) => {
    const request = log.request_payload as { ticket?: unknown } | null
    const response = log.response_payload as { ticket?: unknown } | null
    return request?.ticket != null ? String(request.ticket) : response?.ticket != null ? String(response.ticket) : null
  }
  const focusedManagementLogs = focusedTicket
    ? managementLogs.filter((log) => ticketFromPayload(log) === focusedTicket)
    : []
  const mismatchedManagementTickets = focusedTicket
    ? [...new Set(managementLogs.map(ticketFromPayload).filter((ticket): ticket is string => Boolean(ticket && ticket !== focusedTicket)))]
    : []
  const rangeEvidence = (logs ?? []).filter((log) => ["virtual_pending_fired", "range_basket_tp_rebalance", "range_broker_pending_inserted", "multi_range_plan"].includes(log.action))

  let channelSkipReason: string | null = null
  let channelName: string | null = null
  if (signal.channel_signal_id) {
    const { data: cs } = await supabase.from("channel_signals").select("skip_reason, status").eq("id", signal.channel_signal_id).maybeSingle()
    channelSkipReason = cs?.skip_reason ?? null
  } else {
    // signals.channel_id is a telegram_channels FK — NOT channel_signals.signal_channel_id.
    // Resolve the canonical channel id via the embedded telegram_channels row.
    const channelRow = (signal.telegram_channels as { display_name?: string | null; signal_channel_id?: string | null }[] | null)?.[0] ?? null
    channelName = channelRow?.display_name ?? null
    if (channelRow?.signal_channel_id && signal.telegram_message_id) {
      const { data: cs } = await supabase.from("channel_signals").select("skip_reason, status").eq("signal_channel_id", channelRow.signal_channel_id).eq("telegram_message_id", signal.telegram_message_id).maybeSingle()
      channelSkipReason = cs?.skip_reason ?? null
    }
  }

  // Aggregate the FULL attempt history (statuses-only query, no limits).
  const counts = { total: 0, failed: 0, skipped: 0, success: 0 }
  for (const row of (logStatuses ?? []) as { status: string }[]) {
    counts.total += 1
    const s = String(row.status ?? "").toLowerCase()
    if (s === "failed") counts.failed += 1
    else if (s === "skipped") counts.skipped += 1
    else if (s === "success") counts.success += 1
  }

  const durations = computeDurations(signal.pipeline_ts as Record<string, unknown> ?? {})
  const stageLines = Object.entries(durations)
    .filter(([k]) => k !== "total_ms" && STAGE_LABELS[k])
    .map(([k, v]) => `${STAGE_LABELS[k]}: ${v} ms`)
    .join(", ")

  const systemPrompt = [
    "You are the analyst for TScopier, a Telegram trade-signal copier.",
    "Explain what happened with the selected trade in plain English for an administrator who needs to decide whether broker execution was safe.",
    "Rules:",
    "- Start with the direct answer in 2-4 short sentences. State whether the selected trade had a broker-confirmed initial stop loss and take profit.",
    "- Treat a request value of stoploss=0 or takeprofit=0 as NOT SENT. A value stored on the trade row is not proof that the broker received it.",
    "- Match management actions to the selected broker ticket. Do not use an action for another ticket to explain this trade.",
    "- If a management action points to another ticket, call out the ticket mismatch clearly and say that protection for the selected trade cannot be confirmed from these records.",
    "- Explain Invalid stops as: the broker rejected that stop update. Do not invent the exact distance or price reason unless the payload contains it.",
    "- If virtual pending or range basket actions are present, identify the trade as a range trade or range basket when supported by the evidence. Do not call it layered without layer evidence.",
    "- You are given the FULL attempt history as counts plus the newest attempts (newest first).",
    "- If early attempts failed but later ones succeeded (e.g. 'Not enough money' then success after funding), SAY SO — describe the outcome timeline, do not conclude the signal failed overall.",
    "- If the signal was SKIPPED, lead with the skip reason and explain in plain terms why the trade was not taken.",
    "- If ALL attempts failed, explain exactly which stage failed, the error, and its likely cause.",
    "- Mention timing only after explaining execution and protection. Avoid words such as pipeline, dispatch, claim, persistence, or reconciliation unless you immediately explain them.",
    "- If timestamps are missing or a stage is absent, say what cannot be determined.",
    "- Be factual and concise. Use short sentences and ordinary words.",
    "Reply with strict JSON: {\"summary\": string, \"anomalies\": string[], \"overall\": \"fast\"|\"normal\"|\"slow\"}.",
  ].join("\n")

  const userPrompt = [
    `Signal status: ${signal.status ?? "unknown"}`,
    `Channel: ${channelName ?? "(unknown)"}`,
    `Signal skip reason: ${signal.skip_reason ?? "(none)"}`,
    `Canonical channel signal skip reason: ${channelSkipReason ?? "(none)"}`,
    `Selected trade: ${snippet(focusedTrade, 1200)}`,
    `Trades linked to this signal and broker account: ${snippet(focusedTrades, 3000)}`,
    `All linked trades for this signal: ${snippet(allTrades, 4000)}`,
    `Successful order sends: ${snippet(orderLogs, 3500)}`,
    `Management actions matching the selected ticket: ${snippet(focusedManagementLogs, 3000)}`,
    `Management tickets that do not match the selected ticket: ${mismatchedManagementTickets.join(", ") || "none recorded"}`,
    `Range-trade evidence: ${snippet(rangeEvidence, 2500)}`,
    `Stage durations: ${stageLines || "none recorded"}`,
    `Attempt history (all time): ${counts.total} total — ${counts.failed} failed, ${counts.skipped} skipped, ${counts.success} succeeded.`,
    `Newest attempts (newest first): ${(logs ?? []).map((l) => `${l.action}=${l.status}${l.error_message ? ` (${l.error_message.slice(0, 120)})` : ""} @ ${l.created_at ?? ""}`).join("; ") || "none"}`,
    `Raw message: ${snippet(signal.raw_message, 1000)}`,
    `Parsed: ${snippet(signal.parsed_data, 600)}`,
  ].join("\n")

  const { content, status, error } = await callOpenAI(systemPrompt, userPrompt)
  if (error) return json({ error: `OpenAI request failed: ${status} ${error}` }, 502)

  let parsed: { summary?: string; anomalies?: string[]; overall?: string } = {}
  try {
    parsed = JSON.parse(content ?? "{}")
  } catch {
    parsed = { summary: content ?? "No explanation returned." }
  }

  return json({
    explanation: parsed.summary ?? "No explanation returned.",
    anomalies: Array.isArray(parsed.anomalies) ? parsed.anomalies : [],
    overall: ["fast", "normal", "slow"].includes(parsed.overall ?? "") ? parsed.overall : "normal",
  })
}

const ACTION_GLOSSARY: Record<string, string> = {
  order_send: "Sent the order to the broker",
  dispatch_push_attempt: "Attempted to push the signal into the execution queue",
  dispatch_skipped: "Skipped pushing the signal into the execution queue",
  mgmt_close: "Management instruction to close position(s)",
  mgmt_breakeven: "Management instruction to move the stop loss to breakeven",
  mgmt_skip: "Management instruction that was skipped",
  mgmt_range_leg_followup: "Management follow-up on a range-trade leg",
  basket_leg_modify: "Modified one leg of a basket of trades",
  merge_anchor_selected: "Selected the anchor trade used to merge a reply-chain",
  merge_modify_summary: "Recorded the summary of a merged modification",
  merge_routed_modify_only: "Routed the instruction as a modify-only merge",
  parse_shadow_diff: "Detected a difference between shadow parse results",
  pipeline_summary: "Summary of the signal's end-to-end pipeline timing",
  range_basket_tp_rebalance: "Rebalanced take-profit targets across a range basket",
  range_broker_pending_inserted: "Inserted a broker-side pending order for a range trade",
  v2_reconcile_tick: "Reconciliation sweep tick",
  virtual_pending_cancelled: "Cancelled a virtual pending order",
  virtual_pending_fired: "Fired a virtual pending order into execution",
  virtual_pending_inserted: "Registered a virtual pending order",
}

async function explainLog(supabase: ReturnType<typeof createClient>, logId: string): Promise<Response> {
  const { data: log } = await supabase
    .from("trade_execution_logs")
    .select("action, status, error_message, request_payload, response_payload, created_at")
    .eq("id", logId)
    .maybeSingle()

  if (!log) return json({ error: "log entry not found" }, 404)

  const systemPrompt = [
    "You are the operator assistant for TScopier, a Telegram trade-signal copier.",
    "A single copier execution log entry will be given to you.",
    "Explain in plain English what this entry means, what the outcome was, and whether it is a problem.",
    "Use the action glossary for context but do not repeat it verbatim.",
    `Action glossary: ${JSON.stringify(ACTION_GLOSSARY)}`,
    "Rules:",
    "- status=success: confirm what succeeded.",
    "- status=failed: explain the failure, cite the error message, and give the likely cause.",
    "- status=skipped: explain why it was skipped (skip_reason in request payload) and the impact.",
    "- Interpret the request/response payloads concretely (ticket, symbol, price, lots, fill price, latency).",
    "- Be factual and concise (2-4 sentences).",
    "Reply with strict JSON: {\"explanation\": string, \"details\": string[]}.",
  ].join("\n")

  const userPrompt = [
    `Action: ${log.action ?? "unknown"}`,
    `Status: ${log.status ?? "unknown"}`,
    `Error message: ${log.error_message ?? "(none)"}`,
    `Request payload: ${snippet(log.request_payload, 800)}`,
    `Response payload: ${snippet(log.response_payload, 800)}`,
    `Timestamp: ${log.created_at ?? "unknown"}`,
  ].join("\n")

  const { content, status, error } = await callOpenAI(systemPrompt, userPrompt)
  if (error) return json({ error: `OpenAI request failed: ${status} ${error}` }, 502)

  let parsed: { explanation?: string; details?: string[] } = {}
  try {
    parsed = JSON.parse(content ?? "{}")
  } catch {
    parsed = { explanation: content ?? "No explanation returned." }
  }

  return json({
    explanation: parsed.explanation ?? "No explanation returned.",
    details: Array.isArray(parsed.details) ? parsed.details : [],
  })
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders })
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)

  try {
    if (!OPENAI_API_KEY) return json({ error: "OPENAI_API_KEY not configured on this project" }, 500)

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    if (!(await requireAdmin(supabase, req))) return json({ error: "Unauthorized" }, 401)

    const body = await req.json()
    const signalId = typeof body?.signal_id === "string" ? body.signal_id : null
    const focusedTradeId = typeof body?.trade_id === "string" ? body.trade_id : null
    const focusedBrokerAccountId = typeof body?.broker_account_id === "string" ? body.broker_account_id : null
    const logId = typeof body?.log_id === "string" ? body.log_id : null

    if (logId) return await explainLog(supabase, logId)
    if (signalId) return await explainSignal(supabase, signalId, focusedTradeId, focusedBrokerAccountId)
    return json({ error: "signal_id or log_id is required" }, 400)
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})
