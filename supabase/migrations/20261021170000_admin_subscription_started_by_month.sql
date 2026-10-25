/*
  # Admin subscription stats: add "started by month" series

  1. Why
    - The Subscriptions Statistics page now gets a "New Subscriptions
      Started" chart alongside the existing cancellations-by-month chart.
    - `admin_subscription_stats` already returns `churn` (cancellations per
      UTC month, from the now-backfilled subscriptions.canceled_at). This
      adds the mirror series from subscriptions.created_at so Luis can see
      starts vs. endings side by side over the same last-12-month window.

  2. Change
    - CREATE OR REPLACE of public.admin_subscription_stats with one added
      key in the returned JSON:
        started: [{ month, plan, total }]  subscription rows created per
                                           UTC month and plan, last 12 months
      Everything else (totals, by_plan, churn, canceled_undated, total,
      p_exclude semantics) is identical to
      20261021130000_admin_subscription_stats_functions.sql.
    - Grants unchanged (this replace keeps existing ACLs); the security
      model is re-declared anyway: SECURITY DEFINER + is_admin() guard,
      EXECUTE revoked from PUBLIC/anon, granted to authenticated and
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
  v_started json;
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

  SELECT COALESCE(
    json_agg(json_build_object('month', month, 'plan', plan, 'total', total) ORDER BY month, plan),
    '[]'::json
  ) INTO v_started
  FROM (
    SELECT
      to_char(s.created_at AT TIME ZONE 'utc', 'YYYY-MM') AS month,
      COALESCE(s.plan, 'unknown')::text AS plan,
      count(*)::bigint AS total
    FROM subscriptions s
    WHERE s.created_at >= (date_trunc('month', now() AT TIME ZONE 'utc') - interval '11 months') AT TIME ZONE 'utc'
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
    'started', v_started,
    'canceled_undated', v_undated,
    'total', v_total
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_subscription_stats(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_subscription_stats(uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_subscription_stats(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_subscription_stats(uuid[]) TO service_role;
