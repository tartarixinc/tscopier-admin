/*
  # Admin trial conversion statistics function

  1. Why this exists
    - Luis wants to see, among people who had a free trial, who subscribed
      after the trial ended versus who let it expire without paying. The
      Subscriptions Statistics page shows the split; this function computes it
      in the database (same reasoning as the other admin stats functions: the
      browser must not download raw rows and count them).

  2. Function
    - `admin_trial_conversion_stats(p_exclude uuid[])` — one JSON object:
        converted:     [{ user_id, plan, status, trial_ends_at, joined_at,
                          sub_started_at, sub_ended_at }]
                       people whose trial has started AND who have paid at
                       least one invoice (invoice_payments — complete for all
                       history thanks to the billing-backfill run)
        not_converted: same shape — trial ended (trial_ends_at <= now) and
                       not a single payment on record
        in_trial:      same shape — trial not over yet and no payment yet
                       (shown for context; not part of the conversion rate)
        monthly:       [{ month, converted, not_converted }] — trials that
                       ENDED in each of the last 12 UTC months (by trial end
                       date), split by whether they ever paid; powers the
                       "Free Trials Ended by Outcome" chart
      Dates: joined_at = when the person signed up (user_profiles.created_at);
      trial_ends_at = free-trial end; sub_started_at = subscription created;
      sub_ended_at = cancellation date when canceled, otherwise the current
      billing period end.
      One row per person: their newest subscription row. Rows without a
      user_id are left out (there is no person to show). `p_exclude` removes
      test accounts, same semantics as the other stats functions.
    - Conversion rate is computed in the UI: converted / (converted +
      not_converted). In-trial people are excluded from the rate because
      their outcome is not decided yet.

  3. Security
    - SECURITY DEFINER + public.is_admin() guard: non-admins get NULL.
    - EXECUTE revoked from PUBLIC and anon; granted to authenticated and
      service_role only.
*/

CREATE OR REPLACE FUNCTION public.admin_trial_conversion_stats(p_exclude uuid[] DEFAULT '{}')
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_converted json;
  v_not_converted json;
  v_in_trial json;
  v_monthly json;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN NULL;
  END IF;

  WITH latest AS (
    SELECT DISTINCT ON (s.user_id)
      s.user_id, s.plan, s.status, s.trial_ends_at,
      s.created_at AS sub_started_at,
      COALESCE(s.canceled_at, s.current_period_end) AS sub_ended_at,
      p.created_at AS joined_at
    FROM subscriptions s
    LEFT JOIN user_profiles p ON p.user_id = s.user_id
    WHERE s.trial_ends_at IS NOT NULL
      AND s.user_id IS NOT NULL
      AND NOT (s.user_id = ANY(p_exclude))
    ORDER BY s.user_id, s.created_at DESC
  ),
  classified AS (
    SELECT l.*,
      EXISTS (
        SELECT 1 FROM invoice_payments ip WHERE ip.user_id = l.user_id
      ) AS has_paid
    FROM latest l
  )
  SELECT
    COALESCE(json_agg(json_build_object(
      'user_id', user_id, 'plan', plan, 'status', status,
      'trial_ends_at', trial_ends_at, 'joined_at', joined_at,
      'sub_started_at', sub_started_at, 'sub_ended_at', sub_ended_at
    ) ORDER BY trial_ends_at DESC) FILTER (WHERE has_paid), '[]'::json),
    COALESCE(json_agg(json_build_object(
      'user_id', user_id, 'plan', plan, 'status', status,
      'trial_ends_at', trial_ends_at, 'joined_at', joined_at,
      'sub_started_at', sub_started_at, 'sub_ended_at', sub_ended_at
    ) ORDER BY trial_ends_at DESC) FILTER (WHERE NOT has_paid AND trial_ends_at <= now()), '[]'::json),
    COALESCE(json_agg(json_build_object(
      'user_id', user_id, 'plan', plan, 'status', status,
      'trial_ends_at', trial_ends_at, 'joined_at', joined_at,
      'sub_started_at', sub_started_at, 'sub_ended_at', sub_ended_at
    ) ORDER BY trial_ends_at ASC) FILTER (WHERE NOT has_paid AND trial_ends_at > now()), '[]'::json),
    (
      SELECT COALESCE(
        json_agg(json_build_object('month', month, 'converted', converted, 'not_converted', not_converted) ORDER BY month),
        '[]'::json
      )
      FROM (
        SELECT
          to_char(c2.trial_ends_at AT TIME ZONE 'utc', 'YYYY-MM') AS month,
          count(*) FILTER (WHERE c2.has_paid)::bigint AS converted,
          count(*) FILTER (WHERE NOT c2.has_paid)::bigint AS not_converted
        FROM classified c2
        WHERE c2.trial_ends_at <= now()
          AND c2.trial_ends_at >= (date_trunc('month', now() AT TIME ZONE 'utc') - interval '11 months') AT TIME ZONE 'utc'
        GROUP BY 1
      ) mt
    )
  INTO v_converted, v_not_converted, v_in_trial, v_monthly
  FROM classified;

  RETURN json_build_object(
    'converted', v_converted,
    'not_converted', v_not_converted,
    'in_trial', v_in_trial,
    'monthly', v_monthly
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_trial_conversion_stats(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_trial_conversion_stats(uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_trial_conversion_stats(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_trial_conversion_stats(uuid[]) TO service_role;
