CREATE POLICY "Admins can view all assistant threads"
  ON assistant_threads FOR SELECT
  TO authenticated
  USING (public.is_admin());
