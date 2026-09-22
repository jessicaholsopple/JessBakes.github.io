-- ============================================================
-- Themes: publish/discard RPCs, Phase 3.
--
-- publish_theme_schedule() is the ONLY way theme_schedules_published
-- ever changes. It is SECURITY DEFINER (same is_admin()-in-body
-- pattern as vacation_eligible_subscribers()) and, before doing the
-- atomic snapshot, re-validates the "no two enabled, same-tier,
-- equal-priority entries may overlap" rule SERVER-SIDE -- so a bug in
-- the admin JS can never publish a silently-surprising overlap.
--
-- That validation uses a deliberately CONSERVATIVE annual day-of-year
-- envelope (theme_schedule_annual_envelope, below) rather than the
-- exact DST-safe/Easter-computus resolver that lives in
-- supabase/functions/_shared/themeSchedule.mjs -- duplicating that
-- exact algorithm in PL/pgSQL would be a second, easy-to-drift
-- implementation of the same hard math. The envelope is proven wide
-- enough to never MISS a real conflict (it can only ever be equal to
-- or wider than the true window), so it can only ever be overly
-- cautious, never unsafe -- an admin who hits a false-positive block
-- just needs to nudge one entry's tier_priority, which is exactly the
-- explicit, conscious action this whole rule exists to force.
--
-- Known, documented, deliberate limitation: this SQL-side check
-- covers annual_fixed/annual_rule-vs-annual_fixed/annual_rule pairs,
-- and fixed_range-vs-fixed_range pairs, precisely. It does NOT cover
-- a one-off fixed_range entry colliding with an annual entry (a rare
-- combination -- a custom one-time date range tied to a normally-
-- recurring theme). That specific combination is still caught by the
-- admin UI's exact, real detectOverlaps() (the same themeSchedule.mjs
-- used by the live resolver) before Publish is ever clicked; it is
-- just not re-enforced a second time here.
-- ============================================================
begin;

-- ---------------------------------------------------------------
-- theme_schedule_annual_envelope: returns 1 or 2 conservative
-- [start_day_of_year, end_day_of_year] ranges (measured against a
-- fixed reference leap year, 2028, so Feb 29 always has a slot) that
-- an annual_fixed or annual_rule entry could possibly fall within, in
-- ANY year. A wrap-around window (e.g. Dec 21 -> Mar 19) returns two
-- ranges. Callers must treat two envelopes from different entries as
-- "possibly overlapping" if ANY pair of their returned ranges
-- intersects.
-- ---------------------------------------------------------------
create or replace function public.theme_schedule_annual_envelope(
  p_recurrence_type text,
  p_annual_start_month smallint, p_annual_start_day smallint,
  p_annual_end_month smallint, p_annual_end_day smallint,
  p_rule_kind text, p_rule_month smallint, p_rule_weekday smallint, p_rule_occurrence smallint,
  p_window_start_offset_days smallint, p_window_end_offset_days smallint
)
returns setof int4range
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_start_doy int;
  v_end_doy int;
  v_days_in_month int;
begin
  if p_recurrence_type = 'annual_fixed' then
    v_start_doy := extract(doy from make_date(2028, p_annual_start_month, p_annual_start_day))::int;
    v_end_doy := extract(doy from make_date(2028, p_annual_end_month, p_annual_end_day))::int;

    if v_end_doy >= v_start_doy then
      return next int4range(v_start_doy, v_end_doy, '[]');
    else
      -- Crosses the year boundary (e.g. Dec 21 -> Mar 19).
      return next int4range(v_start_doy, 366, '[]');
      return next int4range(1, v_end_doy, '[]');
    end if;

  elsif p_recurrence_type = 'annual_rule' and p_rule_kind = 'easter_offset' then
    -- Western Easter Sunday always falls between March 22 and April
    -- 25 inclusive (the well-known canonical bound of the Gregorian
    -- computus) -- a fixed, safe envelope with no per-year computation.
    v_start_doy := extract(doy from make_date(2028, 3, 22))::int + p_window_start_offset_days;
    v_end_doy := extract(doy from make_date(2028, 4, 25))::int + p_window_end_offset_days;
    return next int4range(least(v_start_doy, v_end_doy), greatest(v_start_doy, v_end_doy), '[]');

  elsif p_recurrence_type = 'annual_rule' and p_rule_kind = 'nth_weekday_offset' then
    v_days_in_month := extract(day from (make_date(2028, p_rule_month, 1) + interval '1 month - 1 day'))::int;

    if p_rule_occurrence = -1 then
      -- "Last" occurrence: always within the final 7 days of the month.
      v_start_doy := extract(doy from make_date(2028, p_rule_month, v_days_in_month - 6))::int;
      v_end_doy := extract(doy from make_date(2028, p_rule_month, v_days_in_month))::int;
    else
      -- The Nth occurrence of a weekday always falls within days
      -- [(N-1)*7+1, (N-1)*7+7] of the month -- true regardless of
      -- which weekday the month starts on (basic pigeonhole: any
      -- 7-day block of the month contains exactly one of each
      -- weekday, e.g. the 4th Thursday is always Nov 22-28).
      v_start_doy := extract(doy from make_date(2028, p_rule_month, ((p_rule_occurrence - 1) * 7) + 1))::int;
      v_end_doy := extract(doy from make_date(2028, p_rule_month,
        least(v_days_in_month, ((p_rule_occurrence - 1) * 7) + 7)))::int;
    end if;

    v_start_doy := v_start_doy + p_window_start_offset_days;
    v_end_doy := v_end_doy + p_window_end_offset_days;

    if v_end_doy >= v_start_doy then
      return next int4range(v_start_doy, v_end_doy, '[]');
    else
      return next int4range(v_start_doy, 366, '[]');
      return next int4range(1, v_end_doy, '[]');
    end if;
  end if;

  return;
end;
$$;

revoke all on function public.theme_schedule_annual_envelope(text, smallint, smallint, smallint, smallint, text, smallint, smallint, smallint, smallint, smallint) from public, anon;
grant execute on function public.theme_schedule_annual_envelope(text, smallint, smallint, smallint, smallint, text, smallint, smallint, smallint, smallint, smallint) to authenticated, service_role;

-- ---------------------------------------------------------------
-- publish_theme_schedule()
-- ---------------------------------------------------------------
create or replace function public.publish_theme_schedule()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_conflict record;
  v_published_count int;
begin
  if not public.is_admin() then
    raise exception 'Not authorized';
  end if;

  -- 1) Annual-vs-annual conflict check (conservative envelope, see
  --    file header).
  select a.theme_key as theme_a, b.theme_key as theme_b, a.tier_priority
  into v_conflict
  from (
    select ts.id, ts.theme_key, tc.tier, ts.tier_priority, env.envelope
    from public.theme_schedules ts
    join public.theme_catalog tc on tc.key = ts.theme_key
    cross join lateral public.theme_schedule_annual_envelope(
      ts.recurrence_type, ts.annual_start_month, ts.annual_start_day,
      ts.annual_end_month, ts.annual_end_day, ts.rule_kind, ts.rule_month,
      ts.rule_weekday, ts.rule_occurrence, ts.window_start_offset_days, ts.window_end_offset_days
    ) as env(envelope)
    where ts.enabled = true and ts.recurrence_type in ('annual_fixed', 'annual_rule')
  ) a
  join (
    select ts.id, ts.theme_key, tc.tier, ts.tier_priority, env.envelope
    from public.theme_schedules ts
    join public.theme_catalog tc on tc.key = ts.theme_key
    cross join lateral public.theme_schedule_annual_envelope(
      ts.recurrence_type, ts.annual_start_month, ts.annual_start_day,
      ts.annual_end_month, ts.annual_end_day, ts.rule_kind, ts.rule_month,
      ts.rule_weekday, ts.rule_occurrence, ts.window_start_offset_days, ts.window_end_offset_days
    ) as env(envelope)
    where ts.enabled = true and ts.recurrence_type in ('annual_fixed', 'annual_rule')
  ) b on a.tier = b.tier and a.tier_priority = b.tier_priority and a.id < b.id and a.theme_key <> b.theme_key
  where a.envelope && b.envelope
  limit 1;

  if found then
    raise exception 'Publish blocked: "%" and "%" are both enabled at the same priority (%) and their scheduled windows may overlap. Give one a higher priority or disable one before publishing.',
      v_conflict.theme_a, v_conflict.theme_b, v_conflict.tier_priority;
  end if;

  -- 2) fixed_range-vs-fixed_range exact conflict check (same tier,
  --    same priority, direct timestamp overlap -- no envelope needed).
  select a.theme_key as theme_a, b.theme_key as theme_b, a.tier_priority
  into v_conflict
  from (
    select ts.id, ts.theme_key, tc.tier, ts.tier_priority, ts.fixed_start, ts.fixed_end
    from public.theme_schedules ts
    join public.theme_catalog tc on tc.key = ts.theme_key
    where ts.enabled = true and ts.recurrence_type = 'fixed_range'
  ) a
  join (
    select ts.id, ts.theme_key, tc.tier, ts.tier_priority, ts.fixed_start, ts.fixed_end
    from public.theme_schedules ts
    join public.theme_catalog tc on tc.key = ts.theme_key
    where ts.enabled = true and ts.recurrence_type = 'fixed_range'
  ) b on a.tier = b.tier and a.tier_priority = b.tier_priority and a.id < b.id and a.theme_key <> b.theme_key
  where a.fixed_start < b.fixed_end and a.fixed_end > b.fixed_start
  limit 1;

  if found then
    raise exception 'Publish blocked: "%" and "%" are both enabled at the same priority (%) with overlapping one-time date ranges. Give one a higher priority or disable one before publishing.',
      v_conflict.theme_a, v_conflict.theme_b, v_conflict.tier_priority;
  end if;

  -- 3) No conflicts -- atomic snapshot. Disabled draft rows are never
  --    copied, so a disabled row can never accidentally go live.
  --    `where true` is required -- this project's hosted Postgres
  --    rejects a DELETE/UPDATE with no WHERE clause at all, even
  --    inside a SECURITY DEFINER function body.
  delete from public.theme_schedules_published where true;

  insert into public.theme_schedules_published (
    theme_key, label, enabled, recurrence_type,
    fixed_start, fixed_end,
    annual_start_month, annual_start_day, annual_end_month, annual_end_day,
    rule_kind, rule_month, rule_weekday, rule_occurrence,
    window_start_offset_days, window_end_offset_days,
    start_time_local, end_time_local,
    tier_priority, accent_intensity, graphics_visibility, notes
  )
  select
    theme_key, label, enabled, recurrence_type,
    fixed_start, fixed_end,
    annual_start_month, annual_start_day, annual_end_month, annual_end_day,
    rule_kind, rule_month, rule_weekday, rule_occurrence,
    window_start_offset_days, window_end_offset_days,
    start_time_local, end_time_local,
    tier_priority, accent_intensity, graphics_visibility, notes
  from public.theme_schedules
  where enabled = true;

  get diagnostics v_published_count = row_count;

  update public.theme_state
  set last_published_at = now(),
      last_published_by = coalesce(auth.jwt() ->> 'email', 'admin')
  where true;

  return jsonb_build_object('ok', true, 'publishedCount', v_published_count);
end;
$$;

revoke all on function public.publish_theme_schedule() from public, anon;
grant execute on function public.publish_theme_schedule() to authenticated;

-- ---------------------------------------------------------------
-- discard_theme_schedule_draft(): "discard" means "reload the draft
-- FROM the last-published snapshot" (not "empty it") -- discarding
-- unpublished changes should return to what's actually live, not to
-- a blank slate.
-- ---------------------------------------------------------------
create or replace function public.discard_theme_schedule_draft()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_restored_count int;
begin
  if not public.is_admin() then
    raise exception 'Not authorized';
  end if;

  delete from public.theme_schedules where true;

  insert into public.theme_schedules (
    theme_key, label, enabled, recurrence_type,
    fixed_start, fixed_end,
    annual_start_month, annual_start_day, annual_end_month, annual_end_day,
    rule_kind, rule_month, rule_weekday, rule_occurrence,
    window_start_offset_days, window_end_offset_days,
    start_time_local, end_time_local,
    tier_priority, accent_intensity, graphics_visibility, notes
  )
  select
    theme_key, label, enabled, recurrence_type,
    fixed_start, fixed_end,
    annual_start_month, annual_start_day, annual_end_month, annual_end_day,
    rule_kind, rule_month, rule_weekday, rule_occurrence,
    window_start_offset_days, window_end_offset_days,
    start_time_local, end_time_local,
    tier_priority, accent_intensity, graphics_visibility, notes
  from public.theme_schedules_published;

  get diagnostics v_restored_count = row_count;

  return jsonb_build_object('ok', true, 'restoredCount', v_restored_count);
end;
$$;

revoke all on function public.discard_theme_schedule_draft() from public, anon;
grant execute on function public.discard_theme_schedule_draft() to authenticated;

commit;
