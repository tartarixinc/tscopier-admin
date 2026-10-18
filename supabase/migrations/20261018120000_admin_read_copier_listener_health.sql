/*
  Admin read access for `copier_listener_health`.

  This table holds one row per user reporting whether their listener is
  connected, whether the MTProto connection is up, which worker owns the
  account, why the copier stopped, and when it last reported. It is the only
  place that answers "is this customer's copier running right now".

  Until now the only SELECT policy was `copier_listener_health_user_read`
  (`auth.uid() = user_id`), so the admin dashboard — which signs in as a user
  and reads through RLS with the anon key — silently received zero rows for
  every other customer. The per-user statistics page reports that honestly as
  "not readable" rather than showing an empty health card.

  This adds a SELECT policy for admins only. Writes stay where they are: the
  worker writes through `upsert_copier_listener_health` (SECURITY DEFINER), and
  clients still cannot insert or update the table.

  Uses the SECURITY DEFINER `is_admin()` helper from
  20260529211209_fix_admin_rls_security_definer.sql — a subquery against
  user_profiles would recurse under RLS and always fail.
*/

DROP POLICY IF EXISTS "Admins can view all copier_listener_health"
  ON public.copier_listener_health;

CREATE POLICY "Admins can view all copier_listener_health"
  ON public.copier_listener_health FOR SELECT
  TO authenticated
  USING (public.is_admin());
