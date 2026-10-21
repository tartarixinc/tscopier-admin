/*
  # Admin subscription statistics functions + invoice_payments read access

  1. Why these exist
    - Batch 3 of Luis's dashboard feedback asks for a Subscriptions Statistics
      page with a per-plan split and a pause-reason breakdown. The page must
      not download raw `subscriptions` / `user_profiles` rows and count them in
      the browser: Supabase returns at most 1,000 rows per request, and both
      tables grow unbounded. These functions count inside the database and
      return only the finished totals (same reasoning as
      20261020170000_admin_signal_stats_functions.sql).

  2. Functions
    - `admin_subscription_stats(p_exclude uuid[])` — one JSON object:
        totals:      [{ status, total }]           all statuses, all time
        by_plan:     [{ plan, status, total }]     per-plan × status split
        churn:       [{ month, plan, total }]      canceled_at by UTC month,
                                                   last 12 months
        canceled_undated: count of canceled rows with no canceled_at (they
                                                   cannot be placed in a month)
        total:       all subscription rows
      `p_exclude` is a list of user ids to leave out (test accounts).
    - `admin_pause_reason_stats(p_exclude uuid[])` — one JSON object:
        reasons:     [{ reason, total }]           copier_paused profiles by
                                                   copier_pause_reason
                                                   ('unrecorded' when NULL)
        paused_total / profiles_total
    - `p_exclude` behaves like the signal functions: NULL user_id rows are
      always counted.

  3. invoice_payments read access
    - The table was created in TSCopier migration
      20261021120000_invoice_payments_copier_pause_reason.sql with RLS enabled
      and deliberately no policies ("admin read policy added in the
      tscopier-admin migrations"). This adds that policy: admins only, SELECT.
      Writes stay exclusively with the Stripe webhook and the backfill
      function (service role).
    - The policy statement runs only when the table exists, because the
      TSCopier migration is applied to staging first; re-running this file on
      a project where the table has since appeared creates the policy.

  4. Security
    - SECURITY DEFINER + `public.is_admin()` guard: a caller who is not a
      signed-in admin gets NULL (the page reports "not authorized"), never the
      counts.
    - EXECUTE revoked from PUBLIC and anon; granted to authenticated and
      service_role only.
*/

CREATE OR REPLACE FUNCTION public.admin_subscription_stats(p_exclude uuid[] DEFAULT '{}')
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_totals json;
  v_by_plan json;
  v_churn json;
  v_undated bigint;
  v_total bigint;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(
    json_agg(json_build_object('status', status, 'total', total) ORDER BY total DESC),
    '[]'::json
  ) INTO v_totals
  FROM (
    SELECT COALESCE(s.status, 'unknown')::text AS status, count(*)::bigint AS total
    FROM subscriptions s
    WHERE s.user_id IS NULL OR NOT (s.user_id = ANY(p_exclude))
    GROUP BY 1
  ) t;

  SELECT COALESCE(
    json_agg(json_build_object('plan', plan, 'status', status, 'total', total) ORDER BY plan, status),
    '[]'::json
  ) INTO v_by_plan
  FROM (
    SELECT
      COALESCE(s.plan, 'unknown')::text AS plan,
      COALESCE(s.status, 'unknown')::text AS status,
      count(*)::bigint AS total
    FROM subscriptions s
    WHERE s.user_id IS NULL OR NOT (s.user_id = ANY(p_exclude))
    GROUP BY 1, 2
  ) t;

  SELECT COALESCE(
    json_agg(json_build_object('month', month, 'plan', plan, 'total', total) ORDER BY month, plan),
    '[]'::json
  ) INTO v_churn
  FROM (
    SELECT
      to_char(s.canceled_at AT TIME ZONE 'utc', 'YYYY-MM') AS month,
      COALESCE(s.plan, 'unknown')::text AS plan,
      count(*)::bigint AS total
    FROM subscriptions s
    WHERE s.canceled_at IS NOT NULL
      AND s.canceled_at >= (date_trunc('month', now() AT TIME ZONE 'utc') - interval '11 months') AT TIME ZONE 'utc'
      AND (s.user_id IS NULL OR NOT (s.user_id = ANY(p_exclude)))
    GROUP BY 1, 2
  ) t;

  SELECT count(*)::bigint INTO v_undated
  FROM subscriptions s
  WHERE s.status = 'canceled'
    AND s.canceled_at IS NULL
    AND (s.user_id IS NULL OR NOT (s.user_id = ANY(p_exclude)));

  SELECT count(*)::bigint INTO v_total
  FROM subscriptions s
  WHERE s.user_id IS NULL OR NOT (s.user_id = ANY(p_exclude));

  RETURN json_build_object(
    'totals', v_totals,
    'by_plan', v_by_plan,
    'churn', v_churn,
    'canceled_undated', v_undated,
    'total', v_total
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_pause_reason_stats(p_exclude uuid[] DEFAULT '{}')
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_reasons json;
  v_paused bigint;
  v_profiles bigint;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(
    json_agg(json_build_object('reason', reason, 'total', total) ORDER BY sort),
    '[]'::json
  ) INTO v_reasons
  FROM (
    SELECT
      COALESCE(NULLIF(p.copier_pause_reason, ''), 'unrecorded')::text AS reason,
      count(*)::bigint AS total,
      CASE COALESCE(NULLIF(p.copier_pause_reason, ''), 'unrecorded')
        WHEN 'user_paused' THEN 1
        WHEN 'trial_expired' THEN 2
        WHEN 'payment_failed' THEN 3
        WHEN 'subscription_ended' THEN 4
        WHEN 'admin' THEN 5
        WHEN 'unknown' THEN 6
        ELSE 7
      END AS sort
    FROM user_profiles p
    WHERE p.copier_paused IS TRUE
      AND (p.user_id IS NULL OR NOT (p.user_id = ANY(p_exclude)))
    GROUP BY 1, 3
  ) t;

  SELECT count(*)::bigint INTO v_paused
  FROM user_profiles p
  WHERE p.copier_paused IS TRUE
    AND (p.user_id IS NULL OR NOT (p.user_id = ANY(p_exclude)));

  SELECT count(*)::bigint INTO v_profiles
  FROM user_profiles p
  WHERE p.user_id IS NULL OR NOT (p.user_id = ANY(p_exclude));

  RETURN json_build_object(
    'reasons', v_reasons,
    'paused_total', v_paused,
    'profiles_total', v_profiles
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_subscription_stats(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_subscription_stats(uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_subscription_stats(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_subscription_stats(uuid[]) TO service_role;

REVOKE ALL ON FUNCTION public.admin_pause_reason_stats(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_pause_reason_stats(uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_pause_reason_stats(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_pause_reason_stats(uuid[]) TO service_role;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'invoice_payments'
  ) THEN
    DROP POLICY IF EXISTS "Admins can view all invoice_payments"
      ON public.invoice_payments;
    CREATE POLICY "Admins can view all invoice_payments"
      ON public.invoice_payments FOR SELECT
      TO authenticated
      USING (public.is_admin());
  END IF;
END $$;
