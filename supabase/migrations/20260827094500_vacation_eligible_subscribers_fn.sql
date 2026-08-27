-- ============================================================
-- vacation_eligible_subscribers(p_cycle_id): single source of truth
-- for "who receives the reopening campaign for this vacation cycle."
-- Used identically by the admin's live recipient-count UI and by the
-- Edge Functions that actually build/send the campaign, so the two
-- can never drift apart.
--
-- Eligibility (mirrors the default recipient rule the user specified):
--   status = 'active' (never unsubscribed/bounced/complained/suppressed --
--     `status` already reflects all of those via the existing
--     `sync_subscriber_is_active` trigger and webhook handling)
--   AND (
--     pref_menu_announcements = true
--     OR (pref_reopening_alerts = true
--         AND reopening_alert_fulfilled_cycle_id IS DISTINCT FROM p_cycle_id)
--   )
-- A subscriber who selected ONLY "general updates" is correctly
-- excluded -- matches "do not automatically include people who
-- selected only unrelated updates."
--
-- SECURITY DEFINER because it must read across `subscribers` RLS for
-- the caller (an admin's authenticated session, or a service-role
-- Edge Function) -- but it explicitly re-checks authorization inside
-- the function body (is_admin() OR service_role), the same pattern
-- already used by complete_production()/end_current_ballot() in
-- 20260817092629_..., rather than relying on the GRANT alone. This
-- returns full subscriber rows (email addresses), so it must never be
-- reachable by a non-admin authenticated caller.
-- ============================================================
begin;

create or replace function public.vacation_eligible_subscribers(p_cycle_id uuid)
returns setof public.subscribers
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not (public.is_admin() or public.current_jwt_role() = 'service_role') then
    raise exception 'Not authorized';
  end if;

  return query
    select s.*
    from public.subscribers s
    where s.status = 'active'
      and (
        s.pref_menu_announcements = true
        or (
          s.pref_reopening_alerts = true
          and s.reopening_alert_fulfilled_cycle_id is distinct from p_cycle_id
        )
      );
end;
$$;

revoke all on function public.vacation_eligible_subscribers(uuid) from public, anon;
grant execute on function public.vacation_eligible_subscribers(uuid) to authenticated, service_role;

commit;
