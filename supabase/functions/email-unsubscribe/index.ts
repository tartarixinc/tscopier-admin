import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import { createHmac, timingSafeEqual } from "node:crypto";
import { PUBLIC_FUNCTION_ORIGIN } from "../_shared/publicFunctionOrigin.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="supabase-anon-key" content="">
  <title>Email Preferences - TScopier</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      background: #0f1b1a;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px 16px;
    }
    .logo { margin-bottom: 32px; }
    .logo img { height: 32px; display: block; }
    .card {
      width: 100%;
      max-width: 440px;
      background: #ffffff;
      border-radius: 16px;
      padding: 40px 32px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.25), 0 1px 3px rgba(0,0,0,0.1);
    }
    .icon-circle {
      width: 56px; height: 56px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto 20px;
    }
    .icon-circle.warning { background: #fef3c7; }
    .icon-circle.success { background: #d1fae5; }
    .icon-circle.error { background: #fee2e2; }
    .icon-circle svg { width: 28px; height: 28px; }
    h1 {
      font-size: 20px; font-weight: 700; color: #0f172a;
      text-align: center; margin-bottom: 8px; line-height: 1.3;
    }
    .subtitle {
      font-size: 14px; color: #64748b; text-align: center;
      line-height: 1.6; margin-bottom: 24px;
    }
    .reason-group { margin-bottom: 24px; }
    .reason-label {
      display: block; font-size: 13px; font-weight: 600;
      color: #334155; margin-bottom: 8px;
    }
    .reason-option {
      display: flex; align-items: center; padding: 10px 12px;
      border: 1px solid #e2e8f0; border-radius: 8px;
      margin-bottom: 6px; cursor: pointer;
      transition: border-color 0.15s, background 0.15s;
    }
    .reason-option:hover { border-color: #0d9488; background: #f0fdfa; }
    .reason-option input { margin-right: 10px; }
    .reason-option span { font-size: 13px; color: #334155; }
    .btn {
      display: block; width: 100%; padding: 12px 24px;
      font-size: 14px; font-weight: 600; border: none; border-radius: 8px;
      cursor: pointer; text-align: center; text-decoration: none;
    }
    .btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .btn-primary { background: #0f172a; color: #fff; }
    .btn-primary:hover:not(:disabled) { background: #1e293b; }
    .btn-ghost { background: transparent; color: #64748b; margin-top: 12px; }
    .btn-ghost:hover { color: #0f172a; }
    .divider { height: 1px; background: #e2e8f0; margin: 24px 0; }
    .note { font-size: 12px; color: #94a3b8; text-align: center; line-height: 1.5; }
    .note a { color: #94a3b8; text-decoration: underline; }
    .footer {
      margin-top: 32px; font-size: 11px; color: #64748b;
      text-align: center; line-height: 1.5;
    }
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <div class="logo">
    <img src="https://sso.tscopier.ai/storage/v1/object/public/email-assets/tscopierlogo-dark.png" alt="TScopier" />
  </div>

  <div id="view-loading" class="card">
    <h1>Checking link…</h1>
    <p class="subtitle">Please wait while we verify your unsubscribe request.</p>
  </div>

  <div id="view-confirm" class="card hidden">
    <div class="icon-circle warning">
      <svg viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M18.36 6.64a9 9 0 1 1-12.73 0"/>
        <line x1="12" y1="2" x2="12" y2="12"/>
      </svg>
    </div>
    <h1>Unsubscribe from emails?</h1>
    <p class="subtitle">You'll stop receiving subscription reminders and campaign emails from TScopier. Transactional emails (password resets, security alerts) will still be delivered.</p>
    <div class="reason-group">
      <span class="reason-label">Help us improve (optional)</span>
      <label class="reason-option"><input type="radio" name="reason" value="too_frequent" /><span>Too many emails</span></label>
      <label class="reason-option"><input type="radio" name="reason" value="not_relevant" /><span>Not relevant to me</span></label>
      <label class="reason-option"><input type="radio" name="reason" value="no_longer_use" /><span>I no longer use TScopier</span></label>
      <label class="reason-option"><input type="radio" name="reason" value="other" /><span>Other reason</span></label>
    </div>
    <button id="btn-unsub" type="button" class="btn btn-primary">Unsubscribe me</button>
    <a href="https://app.tscopier.ai" class="btn btn-ghost">Never mind, take me back</a>
  </div>

  <div id="view-success" class="card hidden">
    <div class="icon-circle success">
      <svg viewBox="0 0 24 24" fill="none" stroke="#059669" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    </div>
    <h1 id="success-title">You've been unsubscribed</h1>
    <p class="subtitle" id="success-sub">You won't receive any more campaign emails from TScopier.</p>
    <div class="divider"></div>
    <p class="note">Changed your mind? You can re-enable emails anytime from your <a href="https://app.tscopier.ai/settings">account settings</a>.</p>
  </div>

  <div id="view-error" class="card hidden">
    <div class="icon-circle error">
      <svg viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="15" y1="9" x2="9" y2="15"/>
        <line x1="9" y1="9" x2="15" y2="15"/>
      </svg>
    </div>
    <h1 id="error-title">Invalid link</h1>
    <p class="subtitle" id="error-sub">This unsubscribe link is missing required parameters. Please use the link directly from your email.</p>
  </div>

  <div class="footer">Tartarix Inc. &middot; 131 Continental Dr, Suite 305, Newark, DE 19713 US</div>

  <script>
    (function () {
      var FN = 'https://sso.tscopier.ai/functions/v1/email-unsubscribe'
      var ANON = ''
      var params = new URLSearchParams(window.location.search)
      var uid = params.get('uid') || ''
      var token = params.get('token') || ''
      var statusParam = params.get('status')
      var errorParam = params.get('error')

      function show(id) {
        ;['view-loading', 'view-confirm', 'view-success', 'view-error'].forEach(function (v) {
          document.getElementById(v).classList.toggle('hidden', v !== id)
        })
      }

      function showError(title, msg) {
        document.getElementById('error-title').textContent = title
        document.getElementById('error-sub').textContent = msg
        show('view-error')
      }

      if (statusParam === 'success' || statusParam === 'already') {
        if (statusParam === 'already') {
          document.getElementById('success-title').textContent = 'Already unsubscribed'
          document.getElementById('success-sub').textContent =
            "You're already unsubscribed from TScopier campaign emails. No further action is needed."
        }
        show('view-success')
        return
      }

      if (errorParam || !uid || !token) {
        if (errorParam === 'expired') {
          showError('Link expired', 'This unsubscribe link is invalid or has expired. Please use the most recent email you received.')
        } else if (errorParam === 'server') {
          showError('Something went wrong', "We couldn't process your request right now. Please try again in a moment.")
        } else {
          showError('Invalid link', 'This unsubscribe link is missing required parameters. Please use the link directly from your email.')
        }
        return
      }

      // Anon key is embedded by the upload step; fall back to reading from meta if present.
      var metaAnon = document.querySelector('meta[name="supabase-anon-key"]')
      if (metaAnon && metaAnon.content) ANON = metaAnon.content

      fetch(FN + '?uid=' + encodeURIComponent(uid) + '&token=' + encodeURIComponent(token) + '&format=json', {
        headers: {
          Accept: 'application/json',
          apikey: ANON,
          Authorization: 'Bearer ' + ANON,
        },
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d } }) })
        .then(function (res) {
          if (!res.ok || !res.d.ok) {
            showError(
              res.d.error === 'invalid_token' ? 'Link expired' : 'Invalid link',
              res.d.error === 'invalid_token'
                ? 'This unsubscribe link is invalid or has expired. Please use the most recent email you received.'
                : 'This unsubscribe link is missing required parameters. Please use the link directly from your email.',
            )
            return
          }
          if (res.d.already_unsubscribed) {
            document.getElementById('success-title').textContent = 'Already unsubscribed'
            document.getElementById('success-sub').textContent =
              "You're already unsubscribed from TScopier campaign emails. No further action is needed."
            show('view-success')
            return
          }
          show('view-confirm')
        })
        .catch(function () {
          showError('Something went wrong', 'We could not verify this link right now. Please try again in a moment.')
        })

      document.getElementById('btn-unsub').addEventListener('click', function () {
        var btn = document.getElementById('btn-unsub')
        btn.disabled = true
        btn.textContent = 'Unsubscribing…'
        var reasonEl = document.querySelector('input[name="reason"]:checked')
        var reason = reasonEl ? reasonEl.value : null
        fetch(FN, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            apikey: ANON,
            Authorization: 'Bearer ' + ANON,
          },
          body: JSON.stringify({ uid: uid, token: token, reason: reason }),
        })
          .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d } }) })
          .then(function (res) {
            if (!res.ok || !res.d.ok) {
              showError(
                res.d.error === 'invalid_token' ? 'Link expired' : 'Something went wrong',
                res.d.error === 'invalid_token'
                  ? 'This unsubscribe link is invalid or has expired.'
                  : "We couldn't process your request right now. Please try again in a moment.",
              )
              return
            }
            show('view-success')
          })
          .catch(function () {
            showError('Something went wrong', "We couldn't process your request right now. Please try again in a moment.")
          })
          .finally(function () {
            btn.disabled = false
            btn.textContent = 'Unsubscribe me'
          })
      })
    })()
  </script>
</body>
</html>
`;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function htmlPage(status = 200): Response {
  return new Response(PAGE_HTML, {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function candidateSigningKeys(): string[] {
  const keys = [SUPABASE_SERVICE_ROLE_KEY].filter((key) => Boolean(key));
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS") ?? "";
  try {
    const parsed = JSON.parse(raw) as unknown;
    const list = Array.isArray(parsed) ? parsed : [];
    for (const item of list) {
      if (typeof item === "string" && item) keys.push(item);
      else if (item && typeof item === "object") {
        const rec = item as Record<string, unknown>;
        for (const field of ["api_key", "key", "secret"]) {
          if (typeof rec[field] === "string" && rec[field]) keys.push(rec[field] as string);
        }
      }
    }
  } catch {
    // SUPABASE_SECRET_KEYS is not always JSON.
  }
  return [...new Set(keys)];
}

function verifyToken(userId: string, token: string): boolean {
  for (const key of candidateSigningKeys()) {
    const hmac = createHmac("sha256", key);
    hmac.update(userId);
    const expected = hmac.digest("hex");
    if (token.length !== expected.length) continue;
    try {
      if (timingSafeEqual(Buffer.from(token, "utf-8"), Buffer.from(expected, "utf-8"))) return true;
    } catch {
      // Try the next key.
    }
  }
  return false;
}

async function lookupUnsubscribed(uid: string): Promise<boolean> {
  const { data } = await supabase
    .from("email_unsubscribes")
    .select("user_id")
    .eq("user_id", uid)
    .maybeSingle();
  return Boolean(data);
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(req.url);
    if (url.hostname.endsWith(".supabase.co")) {
      const next = new URL(`${PUBLIC_FUNCTION_ORIGIN}/functions/v1/email-unsubscribe`);
      next.search = url.search;
      return Response.redirect(next.toString(), 302);
    }
    const wantsJson =
      url.searchParams.get("format") === "json"
      || (req.headers.get("accept") ?? "").includes("application/json");

    if (req.method === "GET") {
      const uid = url.searchParams.get("uid");
      const token = url.searchParams.get("token");

      if (wantsJson) {
        if (!uid || !token) return json({ ok: false, error: "missing_params" }, 400);
        if (!verifyToken(uid, token)) return json({ ok: false, error: "invalid_token" }, 403);
        return json({ ok: true, already_unsubscribed: await lookupUnsubscribed(uid) });
      }

      // Browsers must receive this page from the function. The public storage
      // copy is served as text/plain, so the HTML source shows instead of the page.
      return htmlPage(200);
    }

    if (req.method === "POST") {
      const contentType = req.headers.get("content-type") ?? "";
      let uid: string | null = null;
      let token: string | null = null;
      let reason: string | null = null;

      if (contentType.includes("application/json")) {
        const body = await req.json().catch(() => ({})) as Record<string, unknown>;
        uid = typeof body.uid === "string" ? body.uid : null;
        token = typeof body.token === "string" ? body.token : null;
        reason = typeof body.reason === "string" ? body.reason : null;
      } else {
        const formData = await req.formData();
        uid = formData.get("uid")?.toString() ?? null;
        token = formData.get("token")?.toString() ?? null;
        reason = formData.get("reason")?.toString() ?? null;
      }

      if (!uid || !token) {
        if (wantsJson || contentType.includes("application/json")) {
          return json({ ok: false, error: "missing_params" }, 400);
        }
        return htmlPage(400);
      }

      if (!verifyToken(uid, token)) {
        if (wantsJson || contentType.includes("application/json")) {
          return json({ ok: false, error: "invalid_token" }, 403);
        }
        return htmlPage(403);
      }

      const { error } = await supabase
        .from("email_unsubscribes")
        .upsert(
          {
            user_id: uid,
            unsubscribed_at: new Date().toISOString(),
            reason,
          },
          { onConflict: "user_id" },
        );

      if (error) {
        console.error("[email-unsubscribe] upsert error:", error.message);
        if (wantsJson || contentType.includes("application/json")) {
          return json({ ok: false, error: "server_error" }, 500);
        }
        return htmlPage(500);
      }

      if (wantsJson || contentType.includes("application/json")) {
        return json({ ok: true });
      }
      return htmlPage(200);
    }

    return json({ ok: false, error: "method_not_allowed" }, 405);
  } catch (err) {
    console.error("[email-unsubscribe] unexpected error:", err);
    return json({ ok: false, error: "server_error" }, 500);
  }
});
