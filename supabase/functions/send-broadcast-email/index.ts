import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { createHmac } from "node:crypto";
import {
  buildCampaignEmailHtml,
  recipientFirstName,
  type EmailRecipient,
} from "../_shared/campaignEmailLayout.ts";
import { resolveEmailLogoUrl } from "../_shared/brandEmailAssets.ts";
import { publicUnsubscribeUrl } from "../_shared/publicFunctionOrigin.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const APP_URL = (Deno.env.get("VITE_APP_URL") || "https://app.tscopier.ai").replace(/\/$/, "");
const LOGO_URL = resolveEmailLogoUrl({
  supabaseUrl: SUPABASE_URL,
  appUrl: APP_URL,
  variant: "dark",
  explicitUrl: Deno.env.get("EMAIL_LOGO_URL"),
});
const RESEND_FROM = Deno.env.get("RESEND_CAMPAIGN_FROM") || "TScopier <account@tscopier.ai>";

const SEGMENTS = [
  "all",
  "advanced",
  "basic",
  "cancelled",
  "past_due",
  "copier_paused",
  "copier_engine_offline",
  "no_active_subscription",
] as const;

type Segment = typeof SEGMENTS[number];
type Mode = "preview" | "send" | "test";

const LIVE_ROLES = new Set(["listener", "all"]);
const PLAN_LIVE = new Set(["active", "trialing"]);
const BILLING_LIVE = new Set(["active", "trialing", "past_due"]);
const SENDS_PER_SECOND = 8;
const BATCH_PAUSE_MS = 1100;
const MAX_SEND_ATTEMPTS = 4;

interface ProfileRow {
  user_id: string;
  display_name: string | null;
  first_name: string | null;
  copier_paused: boolean | null;
  is_admin: boolean | null;
  admin_until: string | null;
}

interface SubscriptionRow {
  user_id: string;
  plan: string | null;
  status: string | null;
  updated_at: string | null;
  created_at: string | null;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isSegment(value: string): value is Segment {
  return (SEGMENTS as readonly string[]).includes(value);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function messageToHtml(message: string): string {
  const blocks = message.replace(/\r\n/g, "\n").trim().split(/\n{2,}/);
  return blocks
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const lines = escapeHtml(block).split("\n").join("<br/>");
      return `<p style="margin:0 0 16px 0;">${lines}</p>`;
    })
    .join("");
}

function unsubscribeUrl(userId: string): string {
  const hmac = createHmac("sha256", SUPABASE_SERVICE_ROLE_KEY);
  hmac.update(userId);
  const token = hmac.digest("hex");
  return publicUnsubscribeUrl(userId, token);
}

function isAdminAccessActive(profile: ProfileRow | undefined): boolean {
  if (!profile?.is_admin) return false;
  if (!profile.admin_until) return true;
  return new Date(profile.admin_until).getTime() > Date.now();
}

function latestSubscriptions(rows: SubscriptionRow[]): Map<string, SubscriptionRow> {
  const sorted = [...rows].sort((a, b) => {
    const aTime = new Date(a.updated_at ?? a.created_at ?? 0).getTime();
    const bTime = new Date(b.updated_at ?? b.created_at ?? 0).getTime();
    return bTime - aTime;
  });
  const map = new Map<string, SubscriptionRow>();
  for (const row of sorted) {
    if (!map.has(row.user_id)) map.set(row.user_id, row);
  }
  return map;
}

async function requireAdmin(
  req: Request,
  supabase: SupabaseClient,
): Promise<{ userId: string } | { error: Response }> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { error: json({ error: "Unauthorized" }, 401) };

  const { data: authData, error: authErr } = await supabase.auth.getUser(token);
  const user = authData?.user ?? null;
  if (authErr || !user) return { error: json({ error: "Unauthorized" }, 401) };

  const { data: profile } = await supabase
    .from("user_profiles")
    .select("is_admin, admin_until")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!isAdminAccessActive(profile as ProfileRow | undefined)) {
    return { error: json({ error: "Admin access required" }, 403) };
  }
  return { userId: user.id };
}

async function listAuthEmails(supabase: SupabaseClient): Promise<Map<string, string>> {
  const emails = new Map<string, string>();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(error.message);
    const users = data?.users ?? [];
    for (const user of users) {
      const email = String(user.email ?? "").trim();
      if (user.id && email) emails.set(user.id, email);
    }
    if (users.length < 1000) break;
  }
  return emails;
}

async function resolveSegment(
  supabase: SupabaseClient,
  segment: Segment,
): Promise<{
  recipients: EmailRecipient[];
  skippedUnsubscribed: number;
  skippedNoEmail: number;
}> {
  const [{ data: profiles }, { data: subs }, { data: unsubs }, emails] = await Promise.all([
    supabase
      .from("user_profiles")
      .select("user_id, display_name, first_name, copier_paused, is_admin, admin_until"),
    supabase
      .from("subscriptions")
      .select("user_id, plan, status, updated_at, created_at"),
    supabase.from("email_unsubscribes").select("user_id"),
    listAuthEmails(supabase),
  ]);

  const profileByUser = new Map(
    ((profiles ?? []) as ProfileRow[]).map((row) => [row.user_id, row]),
  );
  const latestSub = latestSubscriptions((subs ?? []) as SubscriptionRow[]);
  const unsubscribed = new Set(
    ((unsubs ?? []) as { user_id: string }[]).map((row) => row.user_id),
  );

  let candidateIds: string[] = [];

  if (segment === "all") {
    candidateIds = [...emails.keys()];
  } else if (segment === "advanced" || segment === "basic") {
    const plan = segment;
    candidateIds = [...latestSub.values()]
      .filter((row) => row.plan === plan && PLAN_LIVE.has(String(row.status ?? "")))
      .map((row) => row.user_id);
  } else if (segment === "cancelled") {
    candidateIds = [...latestSub.values()]
      .filter((row) => row.status === "canceled")
      .map((row) => row.user_id);
  } else if (segment === "past_due") {
    candidateIds = [...latestSub.values()]
      .filter((row) => row.status === "past_due")
      .map((row) => row.user_id);
  } else if (segment === "copier_paused") {
    candidateIds = [...profileByUser.values()]
      .filter((row) => row.copier_paused === true)
      .map((row) => row.user_id);
  } else if (segment === "no_active_subscription") {
    const billingLive = new Set<string>();
    for (const row of (subs ?? []) as SubscriptionRow[]) {
      if (BILLING_LIVE.has(String(row.status ?? ""))) billingLive.add(row.user_id);
    }
    const ids = new Set<string>([...profileByUser.keys(), ...emails.keys()]);
    candidateIds = [...ids].filter((id) => !billingLive.has(id));
  } else if (segment === "copier_engine_offline") {
    candidateIds = await offlineEngineUserIds(supabase, profileByUser, (subs ?? []) as SubscriptionRow[]);
  }

  const uniqueIds = [...new Set(candidateIds.filter(Boolean))];
  let skippedUnsubscribed = 0;
  let skippedNoEmail = 0;
  const recipients: EmailRecipient[] = [];

  for (const userId of uniqueIds) {
    const email = emails.get(userId);
    if (!email) {
      skippedNoEmail += 1;
      continue;
    }
    if (unsubscribed.has(userId)) {
      skippedUnsubscribed += 1;
      continue;
    }
    const profile = profileByUser.get(userId);
    recipients.push({
      user_id: userId,
      email,
      display_name: profile?.display_name ?? null,
      first_name: profile?.first_name ?? null,
    });
  }

  return { recipients, skippedUnsubscribed, skippedNoEmail };
}

async function offlineEngineUserIds(
  supabase: SupabaseClient,
  profileByUser: Map<string, ProfileRow>,
  subs: SubscriptionRow[],
): Promise<string[]> {
  const [{ data: sessions }, { data: leases }] = await Promise.all([
    supabase.from("telegram_sessions").select("user_id").eq("is_active", true),
    supabase.from("worker_session_leases").select("user_id, role, expires_at"),
  ]);

  const now = Date.now();
  const liveUsers = new Set<string>();
  for (const lease of (leases ?? []) as { user_id: string; role: string | null; expires_at: string | null }[]) {
    if (!lease.user_id || !lease.expires_at) continue;
    if (!LIVE_ROLES.has(String(lease.role ?? ""))) continue;
    if (new Date(lease.expires_at).getTime() > now) liveUsers.add(lease.user_id);
  }

  const billingLive = new Set<string>();
  for (const row of subs) {
    if (BILLING_LIVE.has(String(row.status ?? ""))) billingLive.add(row.user_id);
  }

  const ids = new Set<string>();
  for (const row of (sessions ?? []) as { user_id: string }[]) {
    const userId = row.user_id;
    if (!userId || liveUsers.has(userId)) continue;
    const profile = profileByUser.get(userId);
    if (profile?.copier_paused) continue;
    const eligible = billingLive.has(userId) || isAdminAccessActive(profile);
    if (eligible) ids.add(userId);
  }
  return [...ids];
}

function buildHtml(
  recipient: EmailRecipient,
  title: string,
  message: string,
  cta: { label: string; url: string } | null,
  unsubscribeOverride?: string,
): string {
  const greeting = escapeHtml(recipientFirstName(recipient));
  const safeTitle = escapeHtml(title);
  const preheader = message.replace(/\s+/g, " ").trim().slice(0, 140);
  return buildCampaignEmailHtml({
    appUrl: APP_URL,
    logoUrl: LOGO_URL,
    preheader: escapeHtml(preheader),
    eyebrow: "TScopier",
    title: safeTitle,
    greeting,
    bodyHtml: messageToHtml(message),
    primaryCta: cta ?? { label: "Open TScopier", url: APP_URL },
    closingHtml: `Questions? Email us at <a href="mailto:support@tscopier.ai" style="color:#0d9488;text-decoration:underline;">support@tscopier.ai</a>`,
    unsubscribeUrl: unsubscribeOverride ?? unsubscribeUrl(recipient.user_id),
  });
}

async function sendOne(
  recipient: EmailRecipient,
  subject: string,
  html: string,
): Promise<{ ok: true; resendId: string | null } | { ok: false; error: string; status: number }> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [recipient.email],
      subject,
      html,
    }),
  });
  const data = await res.json().catch(() => ({})) as { id?: string; message?: string; error?: string };
  if (!res.ok) {
    return { ok: false, status: res.status, error: data.message || data.error || `Resend ${res.status}` };
  }
  return { ok: true, resendId: data.id ?? null };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimited(status: number, error: string): boolean {
  return status === 429 || /too many requests/i.test(error);
}

async function sendWithRetry(
  recipient: EmailRecipient,
  subject: string,
  html: string,
): Promise<{ ok: true; resendId: string | null } | { ok: false; error: string; status: number }> {
  let last: { ok: false; error: string; status: number } = { ok: false, error: "send failed", status: 0 };
  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    last = await sendOne(recipient, subject, html) as typeof last;
    if (last.ok) return last;
    if (!isRateLimited(last.status, last.error) || attempt === MAX_SEND_ATTEMPTS) return last;
    const retryAfter = Math.min(8000, 1000 * attempt);
    await sleep(retryAfter);
  }
  return last;
}

async function alreadySentUserIds(supabase: SupabaseClient, broadcastId: string): Promise<Set<string>> {
  const sent = new Set<string>();
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("email_campaign_log")
      .select("user_id, metadata")
      .eq("campaign_type", "broadcast")
      .filter("metadata->>broadcast_id", "eq", broadcastId)
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as { user_id: string; metadata: { status?: string } | null }[];
    for (const row of rows) {
      if (row.metadata?.status === "failed") continue;
      if (row.user_id) sent.add(row.user_id);
    }
    if (rows.length < 1000) break;
    from += 1000;
  }
  return sent;
}

function readCompose(body: Record<string, unknown>): {
  subject: string;
  title: string;
  message: string;
  cta: { label: string; url: string } | null;
} | { error: string } {
  const subject = String(body.subject ?? "").trim();
  const title = String(body.title ?? "").trim();
  const message = String(body.message ?? "").trim();
  const ctaLabel = String(body.cta_label ?? "").trim();
  const ctaUrl = String(body.cta_url ?? "").trim();

  if (!subject || subject.length > 200) return { error: "subject is required (max 200 characters)" };
  if (!title || title.length > 200) return { error: "title is required (max 200 characters)" };
  if (!message || message.length > 20000) return { error: "message is required (max 20000 characters)" };

  if (ctaLabel || ctaUrl) {
    if (!ctaLabel || !ctaUrl) return { error: "Button label and link are both required" };
    if (!/^https?:\/\//i.test(ctaUrl)) return { error: "Button link must start with http:// or https://" };
    return { subject, title, message, cta: { label: ctaLabel.slice(0, 80), url: ctaUrl } };
  }

  return { subject, title, message, cta: null };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "missing supabase env" }, 500);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const admin = await requireAdmin(req, supabase);
  if ("error" in admin) return admin.error;

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const mode = String(body.mode ?? "").trim() as Mode;
  const segmentRaw = String(body.segment ?? "").trim();
  if (mode !== "preview" && mode !== "send" && mode !== "test") {
    return json({ error: "mode must be preview, send, or test" }, 400);
  }
  if (!isSegment(segmentRaw)) {
    return json({ error: "Unknown segment" }, 400);
  }
  const segment = segmentRaw;

  try {
    if (mode === "test") {
      if (!RESEND_API_KEY) return json({ error: "RESEND_API_KEY is not configured" }, 503);
      const composed = readCompose(body);
      if ("error" in composed) return json({ error: composed.error }, 400);
      const testEmail = String(body.test_email ?? "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testEmail)) {
        return json({ error: "Enter a valid email address" }, 400);
      }

      const emails = await listAuthEmails(supabase);
      let matchedUserId: string | null = null;
      for (const [userId, email] of emails) {
        if (email.toLowerCase() === testEmail) {
          matchedUserId = userId;
          break;
        }
      }

      let displayName: string | null = null;
      let firstName: string | null = null;
      if (matchedUserId) {
        const { data: profile } = await supabase
          .from("user_profiles")
          .select("display_name, first_name")
          .eq("user_id", matchedUserId)
          .maybeSingle();
        displayName = (profile as ProfileRow | null)?.display_name ?? null;
        firstName = (profile as ProfileRow | null)?.first_name ?? null;
      }

      const recipient: EmailRecipient = {
        user_id: matchedUserId ?? admin.userId,
        email: testEmail,
        display_name: displayName,
        first_name: firstName,
      };
      const html = buildHtml(
        recipient,
        composed.title,
        composed.message,
        composed.cta,
        matchedUserId ? undefined : APP_URL,
      );
      const sent = await sendOne(recipient, `[Test] ${composed.subject}`, html);
      if (!sent.ok) return json({ error: sent.error }, 502);
      return json({ success: true, email: testEmail, mode: "test" });
    }

    const resolved = await resolveSegment(supabase, segment);

    if (mode === "preview") {
      return json({
        segment,
        count: resolved.recipients.length,
        skipped_unsubscribed: resolved.skippedUnsubscribed,
        skipped_no_email: resolved.skippedNoEmail,
      });
    }

    if (!RESEND_API_KEY) return json({ error: "RESEND_API_KEY is not configured" }, 503);

    const composed = readCompose(body);
    if ("error" in composed) return json({ error: composed.error }, 400);
    const { subject, title, message, cta } = composed;

    const continueId = String(body.broadcast_id ?? "").trim();
    const broadcastId = continueId || crypto.randomUUID();
    let recipients = resolved.recipients;
    let alreadySent = 0;
    if (continueId) {
      const done = await alreadySentUserIds(supabase, continueId);
      alreadySent = recipients.filter((recipient) => done.has(recipient.user_id)).length;
      recipients = recipients.filter((recipient) => !done.has(recipient.user_id));
    }

    const failures: { user_id: string; error: string }[] = [];
    let sent = 0;
    const logRows: Record<string, unknown>[] = [];

    for (let index = 0; index < recipients.length; index += SENDS_PER_SECOND) {
      const batch = recipients.slice(index, index + SENDS_PER_SECOND);
      const outcomes = await Promise.all(batch.map(async (recipient) => {
        const html = buildHtml(recipient, title, message, cta);
        const result = await sendWithRetry(recipient, subject, html);
        return { recipient, result };
      }));
      for (const outcome of outcomes) {
        const failed = !outcome.result.ok;
        if (failed) failures.push({ user_id: outcome.recipient.user_id, error: outcome.result.error });
        else sent += 1;
        logRows.push({
          user_id: outcome.recipient.user_id,
          campaign_type: "broadcast",
          email_address: outcome.recipient.email,
          metadata: {
            broadcast_id: broadcastId,
            segment,
            subject,
            title,
            status: failed ? "failed" : "sent",
            error: failed ? outcome.result.error : null,
            resend_id: outcome.result.ok ? outcome.result.resendId : null,
            triggered_by: admin.userId,
          },
        });
      }
      if (index + SENDS_PER_SECOND < recipients.length) await sleep(BATCH_PAUSE_MS);
    }

    if (logRows.length > 0) {
      const { error: logErr } = await supabase.from("email_campaign_log").insert(logRows);
      if (logErr) console.warn("[send-broadcast-email] log insert failed:", logErr.message);
    }

    return json({
      success: failures.length === 0,
      broadcast_id: broadcastId,
      segment,
      sent,
      already_sent: alreadySent,
      skipped_unsubscribed: resolved.skippedUnsubscribed,
      skipped_no_email: resolved.skippedNoEmail,
      failed: failures.length,
      failures: failures.slice(0, 25),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Broadcast failed";
    console.error("[send-broadcast-email]", message);
    return json({ error: message }, 500);
  }
});
