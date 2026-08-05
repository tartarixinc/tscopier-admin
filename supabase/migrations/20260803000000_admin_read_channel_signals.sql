-- Admin read access to channel_signals for the trade pipeline modal.
-- Mirrors the existing admin read policies (see 20260529210703_add_admin_read_policies.sql).

CREATE POLICY "Admins can view all channel signals"
  ON public.channel_signals FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.user_id = auth.uid() AND up.is_admin = true
    )
  );
