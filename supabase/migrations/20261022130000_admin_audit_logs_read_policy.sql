/*
  # Admins can read the admin audit trail

  admin_audit_logs was created in the product repo (migration
  20260529201000_admin_audit_logs.sql) and is immutable by design:
  BEFORE UPDATE/DELETE triggers raise an exception, and RLS is enabled
  with no client policies — only the service role (the product's
  admin-mutate edge function) could touch it, so the admin dashboard
  could not show the trail.

  This adds a SELECT-only policy for admins, matching the existing
  "Admins can view all …" policies in this repo. public.is_admin() is
  the same guard the admin statistics RPCs use.

  Writes stay impossible from the client: no INSERT/UPDATE/DELETE
  policies exist, and the immutability triggers back that up.
*/

DROP POLICY IF EXISTS "Admins can view admin audit logs" ON public.admin_audit_logs;
CREATE POLICY "Admins can view admin audit logs"
  ON public.admin_audit_logs FOR SELECT
  TO authenticated
  USING (public.is_admin());
