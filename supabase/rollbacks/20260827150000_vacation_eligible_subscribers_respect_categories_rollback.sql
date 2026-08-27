-- Deterministic rollback of 20260827150000_..._respect_categories.sql.
-- Restores the original (Phase 1) hardcoded-categories body.
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
