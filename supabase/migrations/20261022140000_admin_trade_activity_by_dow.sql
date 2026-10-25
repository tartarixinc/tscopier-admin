/*
  # Admin trade activity statistics: add day-of-week series

  1. Why
    - The Trading Hours page now also shows activity per day of the week
      (Monday–Sunday), alongside the existing hour-of-day chart, so peak and
      low days are visible as well as peak and low hours.
    - trades and signals are too large to group in the browser, so the counts
      join the existing SECURITY DEFINER RPC.

  2. Change
    - CREATE OR REPLACE of public.admin_trade_activity_stats with one added
      key in the returned JSON:
        by_dow: [{ dow, trades, signals }] — 7 entries (0 = Sunday, 6 =
                Saturday, matching Postgres EXTRACT(DOW)), one per day even
                when the count is zero, counted from trades.opened_at and
                signals.created_at in UTC.
      Everything else (hourly, total_trades, total_signals, p_exclude, p_days,
      security model) is identical to
      20261022120000_admin_trade_activity_stats.sql.
    - Grants unchanged (this replace keeps existing ACLs); the security model
      is re-declared anyway: SECURITY DEFINER + is_admin() guard, EXECUTE
      revoked from PUBLIC/anon, granted to authenticated and service_role only.
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
  v_by_dow json;
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

  SELECT COALESCE(
    json_agg(json_build_object(
      'dow', d.dow,
      'trades', COALESCE(t.n, 0),
      'signals', COALESCE(s.n, 0)
    ) ORDER BY d.dow),
    '[]'::json
  ) INTO v_by_dow
  FROM generate_series(0, 6) AS d(dow)
  LEFT JOIN (
    SELECT EXTRACT(DOW FROM tr.opened_at AT TIME ZONE 'utc')::int AS dow, count(*)::bigint AS n
    FROM trades tr
    WHERE tr.opened_at IS NOT NULL
      AND (v_since IS NULL OR tr.opened_at >= v_since)
      AND (tr.user_id IS NULL OR NOT (tr.user_id = ANY(p_exclude)))
    GROUP BY 1
  ) t ON t.dow = d.dow
  LEFT JOIN (
    SELECT EXTRACT(DOW FROM sg.created_at AT TIME ZONE 'utc')::int AS dow, count(*)::bigint AS n
    FROM signals sg
    WHERE (v_since IS NULL OR sg.created_at >= v_since)
      AND (sg.user_id IS NULL OR NOT (sg.user_id = ANY(p_exclude)))
    GROUP BY 1
  ) s ON s.dow = d.dow;

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
    'by_dow', v_by_dow,
    'total_trades', v_trades,
    'total_signals', v_signals
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_trade_activity_stats(uuid[], integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_trade_activity_stats(uuid[], integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_trade_activity_stats(uuid[], integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_trade_activity_stats(uuid[], integer) TO service_role;
