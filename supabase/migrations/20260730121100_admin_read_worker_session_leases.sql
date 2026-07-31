-- Allow admins to read all listener leases (matches other admin SELECT policies).
CREATE POLICY "Admins can view all worker session leases"
  ON public.worker_session_leases
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

COMMENT ON POLICY "Admins can view all worker session leases" ON public.worker_session_leases IS
  'Admin dashboard Copier Engine / Worker Leases pages need full lease visibility.';
