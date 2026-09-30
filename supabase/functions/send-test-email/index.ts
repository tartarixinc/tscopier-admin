import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const APP_URL = Deno.env.get("VITE_APP_URL") || "https://app.tscopier.com";

const unsubscribeUrl = "https://sso.tscopier.ai/functions/v1/email-unsubscribe?uid=test&token=test";

const noSubscriptionHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
          <tr>
            <td style="background-color:#0f172a;padding:32px 40px;text-align:center;">
              <h1 style="color:#ffffff;font-size:22px;margin:0;">TSCopier</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:40px;">
              <h2 style="color:#1e293b;font-size:20px;margin:0 0 16px;">Hey Martins,</h2>
              <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 16px;">
                Your TSCopier account is all set up, but you haven't activated a subscription yet. Without an active plan, your signals won't be copied to your broker account.
              </p>
              <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 24px;">
                Subscribe now to start copying trades automatically from your Telegram channels.
              </p>
              <table cellpadding="0" cellspacing="0" style="margin:0 auto 32px;">
                <tr>
                  <td style="background-color:#2563eb;border-radius:8px;">
                    <a href="${APP_URL}/pricing" style="display:inline-block;padding:14px 32px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">
                      View Plans &amp; Subscribe
                    </a>
                  </td>
                </tr>
              </table>
              <p style="color:#94a3b8;font-size:13px;line-height:1.5;margin:0;">
                If you have any questions, just reply to this email. We're happy to help.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#f8fafc;padding:24px 40px;border-top:1px solid #e2e8f0;">
              <p style="color:#94a3b8;font-size:12px;line-height:1.5;margin:0 0 8px;text-align:center;">
                Tartarix Inc. | 131 Continental Dr, Suite 305, Newark, DE 19713 US
              </p>
              <p style="color:#94a3b8;font-size:12px;margin:0;text-align:center;">
                <a href="${unsubscribeUrl}" style="color:#94a3b8;text-decoration:underline;">Unsubscribe</a> from these emails
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

const trialExpiredHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
          <tr>
            <td style="background-color:#0f172a;padding:32px 40px;text-align:center;">
              <h1 style="color:#ffffff;font-size:22px;margin:0;">TSCopier</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:40px;">
              <h2 style="color:#1e293b;font-size:20px;margin:0 0 16px;">Hey Martins,</h2>
              <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 16px;">
                Your free trial has ended. Signal copying is now paused on your account.
              </p>
              <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 24px;">
                Subscribe to a plan to resume automated trade copying from your Telegram channels. Your broker accounts and channel configurations are still saved and ready to go.
              </p>
              <table cellpadding="0" cellspacing="0" style="margin:0 auto 32px;">
                <tr>
                  <td style="background-color:#2563eb;border-radius:8px;">
                    <a href="${APP_URL}/pricing" style="display:inline-block;padding:14px 32px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">
                      Subscribe Now
                    </a>
                  </td>
                </tr>
              </table>
              <p style="color:#94a3b8;font-size:13px;line-height:1.5;margin:0;">
                Questions? Just reply to this email and we'll get back to you.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#f8fafc;padding:24px 40px;border-top:1px solid #e2e8f0;">
              <p style="color:#94a3b8;font-size:12px;line-height:1.5;margin:0 0 8px;text-align:center;">
                Tartarix Inc. | 131 Continental Dr, Suite 305, Newark, DE 19713 US
              </p>
              <p style="color:#94a3b8;font-size:12px;margin:0;text-align:center;">
                <a href="${unsubscribeUrl}" style="color:#94a3b8;text-decoration:underline;">Unsubscribe</a> from these emails
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const to = "martins.osodi@gmail.com";
    const results: Record<string, unknown>[] = [];

    // Send no-subscription nudge email
    const res1 = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "TSCopier <account@tscopier.ai>",
        to: [to],
        subject: "[TEST] Start copying signals - activate your TSCopier subscription",
        html: noSubscriptionHtml,
      }),
    });
    const data1 = await res1.json();
    results.push({ campaign: "no_subscription_nudge", status: res1.status, data: data1 });

    // Send trial expired email
    const res2 = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "TSCopier <account@tscopier.ai>",
        to: [to],
        subject: "[TEST] Your TSCopier trial has ended - subscribe to keep copying",
        html: trialExpiredHtml,
      }),
    });
    const data2 = await res2.json();
    results.push({ campaign: "trial_expired", status: res2.status, data: data2 });

    return new Response(JSON.stringify({ results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
