-- Allow admins to read and update all trade reports.
-- The Reports page (/reports) lists every user-submitted report and lets
-- support staff mark reports resolved. Without these policies admins would
-- only ever see reports they filed themselves (the user policies gate on
-- auth.uid() = user_id).

CREATE POLICY "Admins can view all trade reports"
  ON public.trade_reports
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

CREATE POLICY "Admins can update trade reports"
  ON public.trade_reports
  FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

COMMENT ON POLICY "Admins can view all trade reports" ON public.trade_reports IS
  'Admin dashboard Reports page needs full visibility over user-submitted trade reports.';

COMMENT ON POLICY "Admins can update trade reports" ON public.trade_reports IS
  'Admin dashboard Reports page marks reports as resolved.';
