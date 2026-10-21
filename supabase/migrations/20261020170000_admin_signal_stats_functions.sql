/*
# Admin signal statistics functions

1. Why these exist
  - The Overview "Signal Funnel" and the Signal Stats page used to download raw
    `signals` rows and count them in the browser. Supabase returns at most 1,000
    rows per request, so both charts silently under-counted (funnel showed
    ~1,000 while a single day already had more). These functions count inside
    the database, where no row limit applies, and return only the finished
    totals.

2. Functions
  - `admin_signal_status_counts(p_exclude uuid[])` — total signals per status,
    all time. `p_exclude` is a list of user ids to leave out (test accounts).
  - `admin_signal_daily_counts(p_from, p_to, p_exclude)` — total signals per
    UTC day for the given time window. `p_to` NULL means "until now".
  - `admin_signal_channel_counts(p_from, p_to, p_exclude)` — total signals per
    channel display name for the given time window.

3. Security
  - SECURITY DEFINER + `public.is_admin()` guard: a caller who is not a signed-in
    admin gets an empty result, never the counts.
  - EXECUTE is revoked from PUBLIC and anon; granted to authenticated and
    service_role only.
*/

CREATE OR REPLACE FUNCTION public.admin_signal_status_counts(p_exclude uuid[] DEFAULT '{}')
RETURNS TABLE (status text, total bigint)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT
    COALESCE(s.status, 'unknown')::text AS status,
    count(*)::bigint AS total
  FROM signals s
  WHERE s.user_id IS NULL OR NOT (s.user_id = ANY(p_exclude))
  GROUP BY 1
  ORDER BY count(*) DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_signal_daily_counts(
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL,
  p_exclude uuid[] DEFAULT '{}'
)
RETURNS TABLE (day date, total bigint)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT
    (s.created_at AT TIME ZONE 'utc')::date AS day,
    count(*)::bigint AS total
  FROM signals s
  WHERE (p_from IS NULL OR s.created_at >= p_from)
    AND (p_to IS NULL OR s.created_at < p_to)
    AND (s.user_id IS NULL OR NOT (s.user_id = ANY(p_exclude)))
  GROUP BY 1
  ORDER BY 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_signal_channel_counts(
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL,
  p_exclude uuid[] DEFAULT '{}'
)
RETURNS TABLE (channel text, total bigint)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT
    COALESCE(NULLIF(tc.display_name, ''), NULLIF(tc.channel_username, ''), 'Unknown')::text AS channel,
    count(*)::bigint AS total
  FROM signals s
  LEFT JOIN telegram_channels tc ON tc.id = s.channel_id
  WHERE (p_from IS NULL OR s.created_at >= p_from)
    AND (p_to IS NULL OR s.created_at < p_to)
    AND (s.user_id IS NULL OR NOT (s.user_id = ANY(p_exclude)))
  GROUP BY 1
  ORDER BY count(*) DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_signal_status_counts(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_signal_status_counts(uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_signal_status_counts(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_signal_status_counts(uuid[]) TO service_role;

REVOKE ALL ON FUNCTION public.admin_signal_daily_counts(timestamptz, timestamptz, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_signal_daily_counts(timestamptz, timestamptz, uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_signal_daily_counts(timestamptz, timestamptz, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_signal_daily_counts(timestamptz, timestamptz, uuid[]) TO service_role;

REVOKE ALL ON FUNCTION public.admin_signal_channel_counts(timestamptz, timestamptz, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_signal_channel_counts(timestamptz, timestamptz, uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_signal_channel_counts(timestamptz, timestamptz, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_signal_channel_counts(timestamptz, timestamptz, uuid[]) TO service_role;
