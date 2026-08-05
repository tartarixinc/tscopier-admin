import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { createHmac } from "node:crypto";
import {
  buildCampaignEmailHtml,
  recipientFirstName,
  type EmailRecipient,
} from "../_shared/campaignEmailLayout.ts";
import { resolveEmailLogoUrl } from "../_shared/brandEmailAssets.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_URL = (
  Deno.env.get("VITE_APP_URL") || "https://app.tscopier.ai"
).replace(/\/$/, "");
const LOGO_URL = resolveEmailLogoUrl({
  supabaseUrl: SUPABASE_URL,
  appUrl: APP_URL,
  variant: "dark",
  explicitUrl: Deno.env.get("EMAIL_LOGO_URL"),
});
const RESEND_FROM = "TScopier Billing <billing@tscopier.ai>";

function getUnsubscribeUrl(userId: string): string {
  const hmac = createHmac("sha256", SUPABASE_SERVICE_ROLE_KEY);
  hmac.update(userId);
  const token = hmac.digest("hex");
  return `${SUPABASE_URL}/functions/v1/email-unsubscribe?uid=${userId}&token=${token}`;
}

interface StripeInvoice {
  id: string;
  amount_due: number;
  currency: string;
  hosted_invoice_url: string | null;
  status: string;
}

async function fetchOpenInvoice(
  stripeCustomerId: string,
): Promise<StripeInvoice | null> {
  const params = new URLSearchParams({
    customer: stripeCustomerId,
    status: "open",
    limit: "1",
  });

  const res = await fetch(
    `https://api.stripe.com/v1/invoices?${params.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      },
    },
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
    status: inv.status,
  };
}

function formatAmount(cents: number, _currency: string): string {
  return (cents / 100).toFixed(2);
}

function buildInvoiceDueHtml(
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
    preheader:
      "You have an overdue invoice. Please update your payment method.",
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const { user_id } = await req.json();

    if (!user_id) {
      return new Response(
        JSON.stringify({ error: "user_id is required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: authUser, error: authErr } = await supabase.auth.admin
      .getUserById(user_id);
    if (authErr || !authUser?.user?.email) {
      return new Response(
        JSON.stringify({
          error: "Could not find user email",
          details: authErr?.message,
        }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const email = authUser.user.email;

    const { data: unsub } = await supabase
      .from("email_unsubscribes")
      .select("id")
      .eq("user_id", user_id)
      .maybeSingle();

    if (unsub) {
      return new Response(
        JSON.stringify({ error: "User has unsubscribed from emails" }),
        {
          status: 422,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const { data: sub } = await supabase
      .from("subscriptions")
      .select("stripe_customer_id")
      .eq("user_id", user_id)
      .maybeSingle();

    if (!sub?.stripe_customer_id) {
      return new Response(
        JSON.stringify({ error: "User has no Stripe customer ID" }),
        {
          status: 422,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const invoice = await fetchOpenInvoice(sub.stripe_customer_id);

    let amountDue: string | undefined;
    let invoiceUrl: string | undefined;

    if (invoice) {
      amountDue = formatAmount(invoice.amount_due, invoice.currency);
      invoiceUrl = invoice.hosted_invoice_url || undefined;
    }

    const { data: profile } = await supabase
      .from("user_profiles")
      .select("display_name, first_name")
      .eq("user_id", user_id)
      .maybeSingle();

    const recipient: EmailRecipient = {
      user_id,
      email,
      display_name: profile?.display_name ?? null,
      first_name: profile?.first_name ?? null,
    };

    const unsubUrl = getUnsubscribeUrl(user_id);
    const html = buildInvoiceDueHtml(recipient, unsubUrl, amountDue, invoiceUrl);

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [email],
        subject: "Action required — your TScopier invoice is overdue",
        html,
      }),
    });

    const resData = await res.json();

    if (!res.ok) {
      return new Response(
        JSON.stringify({
          error: "Resend API error",
          status: res.status,
          details: resData,
        }),
        {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    await supabase.from("email_campaign_log").insert({
      user_id,
      campaign_type: "invoice_due",
      email_address: email,
      metadata: {
        triggered_by: "admin_manual",
        resend_id: resData.id,
        invoice_id: invoice?.id ?? null,
        amount_due: amountDue ?? null,
      },
    });

    return new Response(
      JSON.stringify({
        success: true,
        email,
        campaign: "invoice_due",
        resend_id: resData.id,
        invoice_id: invoice?.id ?? null,
        amount_due: amountDue ?? null,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
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
