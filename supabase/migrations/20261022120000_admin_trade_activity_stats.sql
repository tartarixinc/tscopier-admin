/*
  # Admin trade activity statistics: hourly peak / low activity

  1. Why
    - A new admin page ("Trading Hours") charts when trading activity happens
      across the day: trades opened and signals received per hour of day (UTC),
      so the team can see peak and quiet hours at a glance.
    - trades (80k+ rows) and signals (110k+ rows) are far too large to group
      in the browser, so aggregation lives in a SECURITY DEFINER RPC next to
      the other admin statistics functions.

  2. What it returns
    - hourly: [{ hour, trades, signals }] — hour of day in UTC (0–23), one
      entry per hour even when the count is zero (generate_series), counted
      from trades.opened_at and signals.created_at.
    - total_trades / total_signals — totals over the same window, so the page
      can show summary tiles without a second query.

  3. Parameters
    - p_exclude uuid[] — team test accounts to leave out (same semantics as
      the other admin stats RPCs; rows with a null user_id always count).
    - p_days integer — window in days; NULL means all time.

  4. Security
    - SECURITY DEFINER + is_admin() guard (returns NULL for non-admins),
      EXECUTE revoked from PUBLIC/anon, granted to authenticated and
      service_role only.
*/

CREATE OR REPLACE FUNCTION public.admin_trade_activity_stats(
  p_exclude uuid[] DEFAULT '{}',
  p_days integer DEFAULT 90
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_hourly json;
  v_trades bigint;
  v_signals bigint;
  v_since timestamptz;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN NULL;
  END IF;

  v_since := CASE WHEN p_days IS NULL THEN NULL ELSE now() - make_interval(days => p_days) END;

  SELECT COALESCE(
    json_agg(json_build_object(
      'hour', h.hour,
      'trades', COALESCE(t.n, 0),
      'signals', COALESCE(s.n, 0)
    ) ORDER BY h.hour),
    '[]'::json
  ) INTO v_hourly
  FROM generate_series(0, 23) AS h(hour)
  LEFT JOIN (
    SELECT EXTRACT(HOUR FROM tr.opened_at AT TIME ZONE 'utc')::int AS hour, count(*)::bigint AS n
    FROM trades tr
    WHERE tr.opened_at IS NOT NULL
      AND (v_since IS NULL OR tr.opened_at >= v_since)
      AND (tr.user_id IS NULL OR NOT (tr.user_id = ANY(p_exclude)))
    GROUP BY 1
  ) t ON t.hour = h.hour
  LEFT JOIN (
    SELECT EXTRACT(HOUR FROM sg.created_at AT TIME ZONE 'utc')::int AS hour, count(*)::bigint AS n
    FROM signals sg
    WHERE (v_since IS NULL OR sg.created_at >= v_since)
      AND (sg.user_id IS NULL OR NOT (sg.user_id = ANY(p_exclude)))
    GROUP BY 1
  ) s ON s.hour = h.hour;

  SELECT count(*)::bigint INTO v_trades
  FROM trades tr
  WHERE tr.opened_at IS NOT NULL
    AND (v_since IS NULL OR tr.opened_at >= v_since)
    AND (tr.user_id IS NULL OR NOT (tr.user_id = ANY(p_exclude)));

  SELECT count(*)::bigint INTO v_signals
  FROM signals sg
  WHERE (v_since IS NULL OR sg.created_at >= v_since)
    AND (sg.user_id IS NULL OR NOT (sg.user_id = ANY(p_exclude)));

  RETURN json_build_object(
    'hourly', v_hourly,
    'total_trades', v_trades,
    'total_signals', v_signals
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_trade_activity_stats(uuid[], integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_trade_activity_stats(uuid[], integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_trade_activity_stats(uuid[], integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_trade_activity_stats(uuid[], integer) TO service_role;
