/*
  # Admin read access for listener_events

  Adds a SELECT policy so admins can read all listener_events rows,
  enabling the Telegram Event Logs panel in the user detail view.
  Uses the SECURITY DEFINER is_admin() helper (see
  20260529211209_fix_admin_rls_security_definer.sql) — a subquery
  against user_profiles would recurse under RLS and always fail.
*/

CREATE POLICY "Admins can view all listener_events"
  ON listener_events FOR SELECT
  TO authenticated
  USING (public.is_admin());
