/**
 * reconnect-offline-listeners — ops/admin tool.
 * Force-reconnects Telegram listener sessions with missing/stale worker leases.
 *
 * Hardening vs v2:
 * - Normalize WORKER_URL (add https:// when scheme missing)
 * - Clear stale leases + auth holds before calling worker
 * - Optional force mode for a specific user_id (admin UI)
 * - Unpause copier when forcing a reconnect
 * - Retry worker call with backoff
 * - Confirm lease became live after reconnect
 */

// @ts-expect-error Deno runtime
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4"

// @ts-expect-error Deno globals
declare const Deno: {
  env: { get(name: string): string | undefined }
  serve: (handler: (req: Request) => Response | Promise<Response>) => void
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? ""
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
const WORKER_INTERNAL_TOKEN = Deno.env.get("WORKER_INTERNAL_TOKEN") ?? ""
const MAX_USERS = Math.max(1, Math.min(40, Number(Deno.env.get("RECONNECT_MAX_USERS") ?? 25)))
const STAGGER_MS = Math.max(0, Math.min(15_000, Number(Deno.env.get("RECONNECT_STAGGER_MS") ?? 2500)))
const RETRY_COUNT = Math.max(1, Math.min(5, Number(Deno.env.get("RECONNECT_RETRY_COUNT") ?? 3)))
const CONFIRM_WAIT_MS = Math.max(0, Math.min(20_000, Number(Deno.env.get("RECONNECT_CONFIRM_WAIT_MS") ?? 4000)))

function normalizeWorkerBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "")
  if (!trimmed) return ""
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

const WORKER_URL = normalizeWorkerBaseUrl(
  Deno.env.get("TELEGRAM_LISTENER_URL") ?? Deno.env.get("WORKER_URL") ?? "",
)

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    },
  })
}

function isSubscriptionActive(status: string | null | undefined, trialEndsAt: string | null | undefined): boolean {
  const s = String(status ?? "")
  // Match worker planLimits.isSubscriptionActive: paid active always counts;
  // trialing only while trial_ends_at is unset/unparseable or still in the future.
  if (s === "active") return true
  if (s === "trialing") {
    if (!trialEndsAt) return true
    const end = new Date(trialEndsAt).getTime()
    if (!Number.isFinite(end)) return true
    return end > Date.now()
  }
  return false
}

function isLeaseLive(row: { expires_at?: string | null; role?: string | null } | null | undefined): boolean {
  if (!row?.expires_at) return false
  const role = String(row.role ?? "")
  if (role !== "listener" && role !== "all" && role !== "channel_listener") return false
  return new Date(row.expires_at).getTime() > Date.now()
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

type Sb = ReturnType<typeof createClient>

async function prepareSessionForReconnect(supabase: Sb, userId: string, opts: { unpause: boolean }) {
  // Drop any lease so the worker can acquire a fresh one.
  await supabase.from("worker_session_leases").delete().eq("user_id", userId)

  // Clear auth holds that can block reconnect.
  await supabase.from("telegram_auth_pending").delete().eq("user_id", userId)

  // Ensure the stored session is marked active.
  await supabase
    .from("telegram_sessions")
    .update({ is_active: true, updated_at: new Date().toISOString() })
    .eq("user_id", userId)

  if (opts.unpause) {
    await supabase
      .from("user_profiles")
      .update({ copier_paused: false, updated_at: new Date().toISOString() })
      .eq("user_id", userId)
  }
}

async function callWorkerReconnect(userId: string): Promise<{
  ok: boolean
  status: number
  data: Record<string, unknown>
  error?: string
}> {
  let lastStatus = 0
  let lastData: Record<string, unknown> = {}
  let lastError: string | undefined

  for (let attempt = 1; attempt <= RETRY_COUNT; attempt++) {
    try {
      const res = await fetch(`${WORKER_URL}/auth/reconnect_telegram`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-token": WORKER_INTERNAL_TOKEN,
        },
        body: JSON.stringify({ user_id: userId, force: true }),
      })
      lastStatus = res.status
      const text = await res.text()
      try {
        lastData = text ? JSON.parse(text) as Record<string, unknown> : {}
      } catch {
        lastData = { raw: text }
      }

      if (res.ok && !lastData.error) {
        return { ok: true, status: res.status, data: lastData }
      }

      lastError = String(lastData.error ?? lastData.message ?? res.statusText ?? "worker reconnect failed")
      // Retry transient worker/network failures.
      if (attempt < RETRY_COUNT && (res.status >= 500 || res.status === 429 || res.status === 408)) {
        await sleep(750 * attempt)
        continue
      }
      break
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      if (attempt < RETRY_COUNT) {
        await sleep(750 * attempt)
        continue
      }
    }
  }

  return { ok: false, status: lastStatus, data: lastData, error: lastError }
}

async function confirmLeaseLive(supabase: Sb, userId: string): Promise<{
  online: boolean
  lease: Record<string, unknown> | null
}> {
  if (CONFIRM_WAIT_MS > 0) await sleep(CONFIRM_WAIT_MS)
  const { data } = await supabase
    .from("worker_session_leases")
    .select("user_id, worker_id, role, expires_at, updated_at")
    .eq("user_id", userId)
    .maybeSingle()
  const lease = (data as Record<string, unknown> | null) ?? null
  return { online: isLeaseLive(lease as { expires_at?: string; role?: string } | null), lease }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    })
  }

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return json({ error: "missing supabase env" }, 500)
  }
  if (!WORKER_URL || !WORKER_INTERNAL_TOKEN) {
    return json({ error: "WORKER_URL or WORKER_INTERNAL_TOKEN not configured" }, 503)
  }

  const body = req.method === "POST"
    ? await req.json().catch(() => ({})) as Record<string, unknown>
    : {}
  const dryRun = Boolean(body.dry_run)
  const force = Boolean(body.force)
  const onlyUserId = String(body.user_id ?? "").trim() || null
  const limit = Math.max(1, Math.min(MAX_USERS, Number(body.limit ?? MAX_USERS)))

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  const { data: sessions, error: sessErr } = await supabase
    .from("telegram_sessions")
    .select("user_id, is_active")
    .eq("is_active", true)

  if (sessErr) return json({ error: sessErr.message }, 500)

  const userIds = [...new Set(
    (sessions ?? [])
      .map((r) => String((r as { user_id?: string }).user_id ?? ""))
      .filter(Boolean),
  )]

  // Force mode for a single user can target even if session row was inactive
  // (prepareSessionForReconnect will flip is_active).
  if (onlyUserId && force && !userIds.includes(onlyUserId)) {
    userIds.push(onlyUserId)
  }

  if (userIds.length === 0) {
    return json({
      eligible_sessions: 0,
      offline_targeted: 0,
      reconnected: 0,
      failed: 0,
      results: [],
    })
  }

  const { data: subs } = await supabase
    .from("subscriptions")
    .select("user_id, status, trial_ends_at")
    .in("user_id", userIds)

  const eligible = new Set(
    (subs ?? [])
      .filter((s) => isSubscriptionActive(
        (s as { status?: string }).status,
        (s as { trial_ends_at?: string | null }).trial_ends_at,
      ))
      .map((s) => String((s as { user_id: string }).user_id)),
  )

  const { data: profiles } = await supabase
    .from("user_profiles")
    .select("user_id, is_admin, admin_until, copier_paused")
    .in("user_id", userIds)

  const pausedByUser = new Map<string, boolean>()
  for (const row of profiles ?? []) {
    const r = row as {
      user_id: string
      is_admin?: boolean
      admin_until?: string | null
      copier_paused?: boolean
    }
    pausedByUser.set(r.user_id, Boolean(r.copier_paused))
    if (!r.is_admin) continue
    if (r.admin_until && new Date(r.admin_until).getTime() <= Date.now()) continue
    eligible.add(r.user_id)
  }

  // Admin force on a specific user bypasses subscription gate.
  if (onlyUserId && force) {
    eligible.add(onlyUserId)
  }

  const { data: leases } = await supabase
    .from("worker_session_leases")
    .select("user_id, expires_at, role, worker_id")
    .in("user_id", [...eligible])

  const leaseByUser = new Map(
    (leases ?? []).map((l) => [String((l as { user_id: string }).user_id), l as {
      user_id: string
      expires_at: string
      role: string
      worker_id: string
    }]),
  )

  const offline = [...eligible]
    .filter((id) => !onlyUserId || id === onlyUserId)
    .filter((id) => {
      if (force && onlyUserId && id === onlyUserId) return true
      return !isLeaseLive(leaseByUser.get(id) ?? null)
    })
    .slice(0, limit)

  if (dryRun) {
    return json({
      dry_run: true,
      force,
      worker_url_host: (() => {
        try { return new URL(WORKER_URL).host } catch { return "invalid" }
      })(),
      eligible_sessions: eligible.size,
      offline_count: offline.length,
      offline_user_ids: offline,
      lease_snapshot: Object.fromEntries(
        offline.map((id) => [id, leaseByUser.get(id) ?? null]),
      ),
    })
  }

  const results: Array<Record<string, unknown>> = []
  let okCount = 0
  let failCount = 0

  for (let i = 0; i < offline.length; i++) {
    const userId = offline[i]!
    if (i > 0 && STAGGER_MS > 0) {
      await sleep(STAGGER_MS)
    }

    const wasPaused = pausedByUser.get(userId) === true
    await prepareSessionForReconnect(supabase, userId, {
      // Unpause when forcing, or when the user was paused (paused sessions won't stay connected).
      unpause: force || wasPaused,
    })

    const worker = await callWorkerReconnect(userId)
    if (!worker.ok) {
      failCount += 1
      results.push({
        user_id: userId,
        ok: false,
        status: worker.status,
        error: worker.error ?? "worker reconnect failed",
        worker_response: worker.data,
      })
      continue
    }

    const confirm = await confirmLeaseLive(supabase, userId)
    if (confirm.online) {
      okCount += 1
      results.push({
        user_id: userId,
        ok: true,
        online: true,
        channels: Array.isArray(worker.data.channels) ? (worker.data.channels as unknown[]).length : undefined,
        lease: confirm.lease,
        unpaused: force || wasPaused,
      })
    } else {
      // Worker accepted, but lease not confirmed yet — treat as partial success.
      okCount += 1
      results.push({
        user_id: userId,
        ok: true,
        online: false,
        pending_lease: true,
        channels: Array.isArray(worker.data.channels) ? (worker.data.channels as unknown[]).length : undefined,
        worker_response: worker.data,
        warning: "Worker accepted reconnect but lease not live yet",
      })
    }
  }

  return json({
    force,
    eligible_sessions: eligible.size,
    offline_targeted: offline.length,
    reconnected: okCount,
    failed: failCount,
    stagger_ms: STAGGER_MS,
    retry_count: RETRY_COUNT,
    confirm_wait_ms: CONFIRM_WAIT_MS,
    worker_url_host: (() => {
      try { return new URL(WORKER_URL).host } catch { return "invalid" }
    })(),
    results,
  })
})
