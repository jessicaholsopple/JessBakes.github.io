-- ============================================================
-- Themes: theme_state, Phase 2.
--
-- Singleton (same `unique index ... ((true))` trick as
-- bakery_settings/email_settings/vacation_periods' active-row index)
-- holding BOTH the admin's manual-override input and the
-- theme-scheduler Edge Function's precomputed resolved output.
--
-- `manual_theme_key` has three uniform states: null = automatic
-- (follow the published schedule), 'classic' = manual Classic,
-- any other theme_catalog key = manual override to that theme. One
-- nullable FK, no separate boolean flag to keep in sync with it.
--
-- Public pages read ONLY the resolved_* columns (via the narrow
-- column-level grant below, mirroring vacation_periods' exact
-- pattern) -- never the schedule tables, never the manual_* input
-- columns, and never compute the resolver themselves. This is what
-- makes "reliable at the exact transition moment, not reliant on the
-- customer's device clock" true structurally: a customer's page load
-- is always just reading a value some server-side process already
-- computed, at most 5 minutes stale (the theme-scheduler cron
-- cadence), never live-computing the recurrence math against
-- whatever clock/timezone their device happens to have.
-- ============================================================
begin;

create table if not exists public.theme_state (
  id uuid primary key default gen_random_uuid(),

  manual_theme_key text references public.theme_catalog(key),
  manual_started_at timestamptz,
  manual_ends_at timestamptz,

  resolved_theme_key text not null default 'classic' references public.theme_catalog(key),
  resolved_reason text not null default 'classic:default',
  resolved_accent_intensity numeric(3, 2) not null default 1.0,
  resolved_graphics_visibility text not null default 'normal',
  resolved_source_schedule_id uuid references public.theme_schedules_published(id) on delete set null,
  resolved_at timestamptz not null default now(),

  last_published_at timestamptz,
  last_published_by text,

  updated_at timestamptz not null default now()
);

create unique index if not exists theme_state_singleton_idx on public.theme_state ((true));

insert into public.theme_state (resolved_theme_key, resolved_reason)
select 'classic', 'classic:default'
where not exists (select 1 from public.theme_state);

drop trigger if exists theme_state_set_updated_at on public.theme_state;
create trigger theme_state_set_updated_at
before update on public.theme_state
for each row execute function public.set_theme_schedules_updated_at();

alter table public.theme_state enable row level security;
revoke all on public.theme_state from anon;

drop policy if exists "Admins can view theme state" on public.theme_state;
create policy "Admins can view theme state" on public.theme_state
  for select to authenticated using (is_admin());
drop policy if exists "Admins can update theme state" on public.theme_state;
create policy "Admins can update theme state" on public.theme_state
  for update to authenticated using (is_admin()) with check (is_admin());
-- No insert/delete policy -- singleton, row pre-seeded above, same
-- shape as email_settings/bakery_settings.

-- ---------------------------------------------------------------
-- Public read access: row-scoped to the (only) row, column-scoped to
-- only the resolved_* fields -- mirrors vacation_periods' exact
-- technique (row policy + column-level grant, NOT a view -- seeing
-- that migration's own comment on why a security-definer view trips
-- the linter's security_definer_view check). Client code for public
-- pages must select exactly these five column names (never "*").
-- ---------------------------------------------------------------
drop policy if exists "Public can view resolved theme" on public.theme_state;
create policy "Public can view resolved theme" on public.theme_state
  for select to anon
  using (true);

grant select (resolved_theme_key, resolved_reason, resolved_accent_intensity, resolved_graphics_visibility, resolved_at)
  on public.theme_state to anon;

commit;
