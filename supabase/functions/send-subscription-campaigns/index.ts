import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import { createHmac } from "node:crypto";
import {
  buildCampaignEmailHtml,
  recipientFirstName,
} from "../_shared/campaignEmailLayout.ts";
import { resolveEmailLogoUrl } from "../_shared/brandEmailAssets.ts";
import { publicUnsubscribeUrl } from "../_shared/publicFunctionOrigin.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const APP_URL = (Deno.env.get("VITE_APP_URL") || "https://app.tscopier.ai").replace(/\/$/, "");
const LOGO_URL = resolveEmailLogoUrl({
  supabaseUrl: SUPABASE_URL,
  appUrl: APP_URL,
  variant: "dark",
  explicitUrl: Deno.env.get("EMAIL_LOGO_URL"),
});
const RESEND_FROM = Deno.env.get("RESEND_CAMPAIGN_FROM") || "TScopier <account@tscopier.ai>";
const RESEND_BILLING_FROM = "TScopier Billing <billing@tscopier.ai>";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function generateUnsubscribeToken(userId: string): string {
  const hmac = createHmac("sha256", SUPABASE_SERVICE_ROLE_KEY);
  hmac.update(userId);
  return hmac.digest("hex");
}

function getUnsubscribeUrl(userId: string): string {
  const token = generateUnsubscribeToken(userId);
  return publicUnsubscribeUrl(userId, token);
}

interface EmailRecipient {
  user_id: string;
  email: string;
  display_name: string | null;
  first_name: string | null;
}

interface InvoiceDueRecipient extends EmailRecipient {
  stripe_customer_id: string;
}

function buildNoSubscriptionEmail(
  recipient: EmailRecipient,
  unsubscribeUrl: string,
): string {
  const name = recipientFirstName(recipient);

  return buildCampaignEmailHtml({
    appUrl: APP_URL,
    logoUrl: LOGO_URL,
    preheader: "Activate a plan to start copying signals to your broker.",
    eyebrow: "Subscription required",
    title: "Activate a plan to go live",
    greeting: name,
    bodyHtml: `
      <p style="margin:0 0 16px 0;">Your TScopier account is ready, but <strong style="color:#0f172a;">signal copying is off</strong> because there's no active subscription.</p>
      <p style="margin:0;">Subscribe to start copying Telegram signals to your broker automatically. Your channels, broker connections, and settings are saved and waiting.</p>
    `,
    primaryCta: {
      label: "View plans & subscribe",
      url: `${APP_URL}/pricing`,
    },
    closingHtml: `Questions? Email us at <a href="mailto:support@tscopier.ai" style="color:#0d9488;text-decoration:underline;">support@tscopier.ai</a><br/>Live support is available 24/7 via the app.`,
    unsubscribeUrl,
  });
}

function buildTrialExpiredEmail(
  recipient: EmailRecipient,
  unsubscribeUrl: string,
  invoiceUrl?: string,
): string {
  const name = recipientFirstName(recipient);
  const hasInvoice = !!invoiceUrl;
  const ctaUrl = invoiceUrl || `${APP_URL}/pricing`;
  const ctaLabel = hasInvoice ? "Pay & reactivate" : "Subscribe now";

  return buildCampaignEmailHtml({
    appUrl: APP_URL,
    logoUrl: LOGO_URL,
    preheader: "Your free trial has ended. Subscribe to resume trade copying.",
    eyebrow: "Trial ended",
    title: "Subscribe to keep copying",
    greeting: name,
    bodyHtml: `
      <p style="margin:0 0 16px 0;">Your <strong style="color:#0f172a;">10-day trial has ended</strong> and signal copying is now paused.</p>
      <p style="margin:0;">Your broker connections, channels, and settings are still saved. Subscribe to resume automated copying instantly.</p>
    `,
    primaryCta: {
      label: ctaLabel,
      url: ctaUrl,
    },
    closingHtml: `Questions? Email us at <a href="mailto:support@tscopier.ai" style="color:#0d9488;text-decoration:underline;">support@tscopier.ai</a><br/>Live support is available 24/7 via the app.`,
    unsubscribeUrl,
  });
}

function buildInvoiceDueEmail(
  recipient: EmailRecipient,
  unsubscribeUrl: string,
  amountDue?: string,
  invoiceUrl?: string,
): string {
  const name = recipientFirstName(recipient);
  const amountLine = amountDue
    ? ` of <strong style="color:#0f172a;">$${amountDue}</strong>`
    : "";
  const ctaUrl = invoiceUrl || `${APP_URL}/billing`;

  return buildCampaignEmailHtml({
    appUrl: APP_URL,
    logoUrl: LOGO_URL,
    preheader: "You have an overdue invoice. Please update your payment method.",
    eyebrow: "Payment required",
    title: "Your invoice is overdue",
    greeting: name,
    bodyHtml: `
      <p style="margin:0 0 16px 0;">We were unable to process your recent payment${amountLine} for your TScopier subscription.</p>
      <p style="margin:0 0 16px 0;">Your account access may be limited until the balance is settled. Please update your payment method or pay the outstanding invoice to restore full service.</p>
      <p style="margin:0;">If you've already resolved this, please disregard this message.</p>
    `,
    primaryCta: {
      label: "Pay invoice now",
      url: ctaUrl,
    },
    closingHtml: `Need help? Email us at <a href="mailto:billing@tscopier.ai" style="color:#0d9488;text-decoration:underline;">billing@tscopier.ai</a><br/>We're happy to assist with any billing questions.`,
    unsubscribeUrl,
  });
}

let lastSendError: string | null = null;

async function sendEmail(
  to: string,
  subject: string,
  html: string,
  from?: string,
): Promise<string | null> {
  if (!RESEND_API_KEY) {
    lastSendError = "RESEND_API_KEY missing";
    console.error("[send-subscription-campaigns] RESEND_API_KEY missing");
    return null;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: from || RESEND_FROM,
        to: [to],
        subject,
        html,
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      lastSendError = `Resend ${res.status}: ${errText.slice(0, 200)}`;
      console.error("[send-subscription-campaigns] Resend error:", errText);
      return null;
    }
    const data = await res.json();
    return data.id ?? "sent";
  } catch (err) {
    lastSendError = `Exception: ${(err as Error).message}`;
    console.error("[send-subscription-campaigns] send failed:", err);
    return null;
  }
}

async function fetchOpenInvoice(
  stripeCustomerId: string,
): Promise<{ id: string; amount_due: number; currency: string; hosted_invoice_url: string | null } | null> {
  if (!STRIPE_SECRET_KEY) return null;
  try {
    const params = new URLSearchParams({
      customer: stripeCustomerId,
      status: "open",
      limit: "1",
    });
    const res = await fetch(
      `https://api.stripe.com/v1/invoices?${params.toString()}`,
      { headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` } },
    );
    if (!res.ok) return null;
    const body = await res.json();
    if (!body.data?.length) return null;
    const inv = body.data[0];
    return {
      id: inv.id,
      amount_due: inv.amount_due,
      currency: inv.currency,
      hosted_invoice_url: inv.hosted_invoice_url,
    };
  } catch {
    return null;
  }
}

async function processNoSubscriptionNudge(): Promise<number> {
  const { data: eligibleUsers, error } = await supabase.rpc(
    "get_no_subscription_nudge_recipients",
  );

  if (error) {
    lastSendError = `RPC nudge error: ${error.message}`;
    console.error("[send-subscription-campaigns] nudge rpc:", error.message);
    return 0;
  }
  if (!eligibleUsers?.length) {
    lastSendError = lastSendError || "nudge RPC returned 0 recipients";
    return 0;
  }

  let sent = 0;
  for (const user of eligibleUsers as EmailRecipient[]) {
    const unsubscribeUrl = getUnsubscribeUrl(user.user_id);
    const html = buildNoSubscriptionEmail(user, unsubscribeUrl);
    const resendId = await sendEmail(
      user.email,
      "Activate TScopier — start copying Telegram signals to your broker",
      html,
    );

    if (resendId) {
      await supabase.from("email_campaign_log").insert({
        user_id: user.user_id,
        campaign_type: "no_subscription_nudge",
        email_address: user.email,
        metadata: { triggered_by: "cron", resend_id: resendId },
      });
      sent++;
    }
  }

  return sent;
}

async function processTrialExpired(): Promise<number> {
  const { data: eligibleUsers, error } = await supabase.rpc(
    "get_trial_expired_recipients",
  );

  if (error) {
    console.error("[send-subscription-campaigns] trial_expired rpc:", error.message);
    return 0;
  }
  if (!eligibleUsers?.length) return 0;

  let sent = 0;
  for (const user of eligibleUsers as InvoiceDueRecipient[]) {
    let invoiceUrl: string | undefined;
    let invoiceId: string | null = null;

    if (user.stripe_customer_id) {
      const invoice = await fetchOpenInvoice(user.stripe_customer_id);
      invoiceUrl = invoice?.hosted_invoice_url || undefined;
      invoiceId = invoice?.id ?? null;
    }

    const unsubscribeUrl = getUnsubscribeUrl(user.user_id);
    const html = buildTrialExpiredEmail(user, unsubscribeUrl, invoiceUrl);
    const resendId = await sendEmail(
      user.email,
      "Your TScopier trial ended — subscribe to resume copying",
      html,
    );

    if (resendId) {
      await supabase.from("email_campaign_log").insert({
        user_id: user.user_id,
        campaign_type: "trial_expired",
        email_address: user.email,
        metadata: { triggered_by: "cron", resend_id: resendId, invoice_id: invoiceId },
      });
      sent++;
    }
  }

  return sent;
}

async function processInvoiceDue(): Promise<number> {
  const { data: eligibleUsers, error } = await supabase.rpc(
    "get_invoice_due_recipients",
  );

  if (error) {
    console.error("[send-subscription-campaigns] invoice_due rpc:", error.message);
    return 0;
  }
  if (!eligibleUsers?.length) return 0;

  let sent = 0;
  for (const user of eligibleUsers as InvoiceDueRecipient[]) {
    const invoice = await fetchOpenInvoice(user.stripe_customer_id);
    const amountDue = invoice ? (invoice.amount_due / 100).toFixed(2) : undefined;
    const invoiceUrl = invoice?.hosted_invoice_url || undefined;

    const unsubscribeUrl = getUnsubscribeUrl(user.user_id);
    const html = buildInvoiceDueEmail(user, unsubscribeUrl, amountDue, invoiceUrl);
    const resendId = await sendEmail(
      user.email,
      "Action required — your TScopier invoice is overdue",
      html,
      RESEND_BILLING_FROM,
    );

    if (resendId) {
      await supabase.from("email_campaign_log").insert({
        user_id: user.user_id,
        campaign_type: "invoice_due",
        email_address: user.email,
        metadata: {
          triggered_by: "cron",
          resend_id: resendId,
          invoice_id: invoice?.id ?? null,
          amount_due: amountDue ?? null,
        },
      });
      sent++;
    }
  }

  return sent;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const nudgeSent = await processNoSubscriptionNudge();
    const trialSent = await processTrialExpired();
    const invoiceSent = await processInvoiceDue();

    return new Response(
      JSON.stringify({
        success: true,
        no_subscription_nudge_sent: nudgeSent,
        trial_expired_sent: trialSent,
        invoice_due_sent: invoiceSent,
        last_error: lastSendError,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
