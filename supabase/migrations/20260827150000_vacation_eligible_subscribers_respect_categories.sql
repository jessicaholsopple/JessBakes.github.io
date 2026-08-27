-- ============================================================
-- Corrective fix to vacation_eligible_subscribers() (Phase 1,
-- 20260827094500): the original body hardcoded the default recipient
-- categories (menu_announcements OR reopening_alerts) and never
-- looked at the per-cycle `recipients_reopening_alerts` /
-- `recipients_menu_announcements` / `recipients_general_updates`
-- toggles added on vacation_periods -- so an admin turning one of
-- those off (or deliberately turning general_updates on) would have
-- had zero effect on who actually receives the campaign. Found while
-- building the admin panel's live recipient-count UI, which is
-- exactly what those toggles are supposed to drive.
--
-- Not a rollback-and-redo of the whole function -- CREATE OR REPLACE
-- keeps the same signature/grants/security-definer shape, only the
-- body changes.
-- ============================================================
begin;

create or replace function public.vacation_eligible_subscribers(p_cycle_id uuid)
returns setof public.subscribers
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_include_reopening boolean;
  v_include_menu boolean;
  v_include_general boolean;
begin
  if not (public.is_admin() or public.current_jwt_role() = 'service_role') then
    raise exception 'Not authorized';
  end if;

  select recipients_reopening_alerts, recipients_menu_announcements, recipients_general_updates
    into v_include_reopening, v_include_menu, v_include_general
    from public.vacation_periods
    where id = p_cycle_id;

  if not found then
    return; -- unknown cycle id -- empty result, not an error
  end if;

  return query
    select s.*
    from public.subscribers s
    where s.status = 'active'
      and (
        (v_include_menu and s.pref_menu_announcements = true)
        or (
          v_include_reopening
          and s.pref_reopening_alerts = true
          and s.reopening_alert_fulfilled_cycle_id is distinct from p_cycle_id
        )
        or (v_include_general and s.pref_general_updates = true)
      );
end;
$$;

revoke all on function public.vacation_eligible_subscribers(uuid) from public, anon;
grant execute on function public.vacation_eligible_subscribers(uuid) to authenticated, service_role;

commit;
