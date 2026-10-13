/*
  Admin read access for the Systems Health monitoring tables
  (created in the TSCopier repo: 20261012120000..20261012120300).

  Adds SELECT policies so admins can read probe state/history/samples,
  broker connection events, and the alert rules/events/recipients tables.
  Uses the SECURITY DEFINER is_admin() helper (see
  20260529211209_fix_admin_rls_security_definer.sql) — a subquery against
  user_profiles would recurse under RLS and always fail.

  Writes (rule edits, recipients, acknowledge) are NOT granted here: they go
  through the admin-mutate edge function with a reason and audit entry.
*/

CREATE POLICY "Admins can view system_probe_state"
  ON public.system_probe_state FOR SELECT
  TO authenticated
  USING (public.is_admin());

CREATE POLICY "Admins can view system_probe_samples"
  ON public.system_probe_samples FOR SELECT
  TO authenticated
  USING (public.is_admin());

CREATE POLICY "Admins can view system_probe_events"
  ON public.system_probe_events FOR SELECT
  TO authenticated
  USING (public.is_admin());

CREATE POLICY "Admins can view broker_connection_events"
  ON public.broker_connection_events FOR SELECT
  TO authenticated
  USING (public.is_admin());

CREATE POLICY "Admins can view alert_rules"
  ON public.alert_rules FOR SELECT
  TO authenticated
  USING (public.is_admin());

CREATE POLICY "Admins can view alert_events"
  ON public.alert_events FOR SELECT
  TO authenticated
  USING (public.is_admin());

CREATE POLICY "Admins can view alert_recipients"
  ON public.alert_recipients FOR SELECT
  TO authenticated
  USING (public.is_admin());
