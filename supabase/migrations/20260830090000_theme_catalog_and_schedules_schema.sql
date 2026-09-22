-- ============================================================
-- Themes (seasonal/holiday decorative themes): catalog + schedule
-- schema, Phase 1.
--
-- Code defines WHAT a theme looks like (css/themes.css + the decor
-- catalog in js/theme-apply.js); this schema only defines WHEN a
-- theme applies. `theme_catalog` is a free-text key catalog (not a
-- hardcoded enum) specifically so a future custom/one-off theme can
-- be added later with one INSERT + one CSS block -- never a
-- migration to the scheduling tables themselves.
--
-- Draft vs. published is modeled as TWO PHYSICAL TABLES with
-- identical shape (`theme_schedules` the admin freely edits,
-- `theme_schedules_published` the live resolver's only input),
-- deliberately duplicated rather than a view/status-flag -- see
-- 20260830096000_theme_publish_rpc.sql for the atomic snapshot that
-- keeps them in sync. This makes "an unpublished draft edit can never
-- affect the live site" true by construction: the live resolver
-- simply has no code path that can read `theme_schedules` at all.
-- ============================================================
begin;

-- ---------------------------------------------------------------
-- 1) theme_catalog -- the fixed-ish list of theme identities. Public
--    read (theme names/keys are not sensitive; the admin UI and the
--    public preview/apply script both need this), admin write.
--
--    'classic' is seeded here with tier = null and is the only key
--    `theme_schedules`/`theme_schedules_published` explicitly forbid
--    scheduling (see the CHECK below) -- Classic is never "won" by a
--    schedule row, it's the resolver's deterministic fallback when
--    nothing else matches or something fails to load. Giving it a
--    real catalog row (rather than a magic string special-cased
--    elsewhere) means every consumer -- admin UI, public page, tests
--    -- has exactly one lookup path (a `theme_catalog` join), never
--    two.
-- ---------------------------------------------------------------
create table if not exists public.theme_catalog (
  key text primary key,
  name text not null,
  tier text check (tier is null or tier in ('season', 'holiday')),
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

alter table public.theme_catalog enable row level security;
revoke all on public.theme_catalog from anon;

drop policy if exists "Admins can manage theme catalog" on public.theme_catalog;
create policy "Admins can manage theme catalog" on public.theme_catalog
  for all to authenticated using (is_admin()) with check (is_admin());

drop policy if exists "Public can view theme catalog" on public.theme_catalog;
create policy "Public can view theme catalog" on public.theme_catalog
  for select to anon
  using (true);

grant select (key, name, tier, sort_order) on public.theme_catalog to anon;

insert into public.theme_catalog (key, name, tier, sort_order) values
  ('classic',         'Classic Jess Bakes', null,      0),
  ('spring',          'Spring',             'season',  10),
  ('summer',          'Summer',             'season',  11),
  ('autumn',          'Autumn',             'season',  12),
  ('winter',          'Winter',             'season',  13),
  ('new_years',       'New Year''s',        'holiday', 20),
  ('valentines',      'Valentine''s Day',   'holiday', 21),
  ('st_patricks',     'St. Patrick''s Day', 'holiday', 22),
  ('easter',          'Easter',             'holiday', 23),
  ('fourth_of_july',  'Fourth of July',     'holiday', 24),
  ('halloween',       'Halloween',          'holiday', 25),
  ('thanksgiving',    'Thanksgiving',       'holiday', 26),
  ('christmas',       'Christmas',          'holiday', 27)
on conflict (key) do nothing;

-- ---------------------------------------------------------------
-- 2) Shared updated_at trigger function (same shape as
--    set_vacation_periods_updated_at) -- one function, reused by
--    both schedule tables below since it never references the
--    table name.
-- ---------------------------------------------------------------
create or replace function public.set_theme_schedules_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------
-- 3) theme_schedules -- the DRAFT the admin freely reads/writes.
--    One row per configured occurrence. `recurrence_type` selects
--    which of the three field groups below is populated (enforced
--    by the CHECK), covering: a one-off explicit range, an annual
--    fixed month/day range (end-before-start means the window
--    crosses into the following year, e.g. Dec 27 -> Jan 6), or an
--    annual rule anchored to a computed date (either the Nth weekday
--    of a month -- Thanksgiving -- or the computed Easter Sunday),
--    expressed as a +/- day offset window around that anchor.
-- ---------------------------------------------------------------
create table if not exists public.theme_schedules (
  id uuid primary key default gen_random_uuid(),

  theme_key text not null references public.theme_catalog(key),
  check (theme_key <> 'classic'),

  label text not null,
  enabled boolean not null default true,

  recurrence_type text not null check (recurrence_type in ('fixed_range', 'annual_fixed', 'annual_rule')),

  -- fixed_range
  fixed_start timestamptz,
  fixed_end timestamptz,

  -- annual_fixed (month/day, evaluated every year in Europe/Berlin)
  annual_start_month smallint check (annual_start_month between 1 and 12),
  annual_start_day smallint check (annual_start_day between 1 and 31),
  annual_end_month smallint check (annual_end_month between 1 and 12),
  annual_end_day smallint check (annual_end_day between 1 and 31),

  -- annual_rule (an anchor date computed each year, +/- a day-offset window)
  rule_kind text check (rule_kind in ('nth_weekday_offset', 'easter_offset')),
  rule_month smallint check (rule_month between 1 and 12),
  rule_weekday smallint check (rule_weekday between 0 and 6),
  rule_occurrence smallint check (rule_occurrence between -1 and 5 and rule_occurrence <> 0),
  window_start_offset_days smallint not null default 0,
  window_end_offset_days smallint not null default 0,

  start_time_local text not null default '00:00',
  end_time_local text not null default '23:59',

  tier_priority int not null default 0,
  accent_intensity numeric(3, 2) not null default 1.0 check (accent_intensity between 0.4 and 1.0),
  graphics_visibility text not null default 'normal' check (graphics_visibility in ('minimal', 'normal')),

  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint theme_schedules_recurrence_fields_chk check (
    (recurrence_type = 'fixed_range' and fixed_start is not null and fixed_end is not null)
    or (recurrence_type = 'annual_fixed' and annual_start_month is not null and annual_start_day is not null
        and annual_end_month is not null and annual_end_day is not null)
    or (recurrence_type = 'annual_rule' and rule_kind is not null and (
          (rule_kind = 'nth_weekday_offset' and rule_month is not null and rule_weekday is not null and rule_occurrence is not null)
          or (rule_kind = 'easter_offset')
        ))
  )
);

create index if not exists idx_theme_schedules_theme_key on public.theme_schedules (theme_key);

drop trigger if exists theme_schedules_set_updated_at on public.theme_schedules;
create trigger theme_schedules_set_updated_at
before update on public.theme_schedules
for each row execute function public.set_theme_schedules_updated_at();

alter table public.theme_schedules enable row level security;
revoke all on public.theme_schedules from anon;

drop policy if exists "Admins can manage draft theme schedules" on public.theme_schedules;
create policy "Admins can manage draft theme schedules" on public.theme_schedules
  for all to authenticated using (is_admin()) with check (is_admin());
-- No anon policy at all -- the draft is never public, by design.

-- ---------------------------------------------------------------
-- 4) theme_schedules_published -- identical shape to theme_schedules
--    above, deliberately duplicated (not a view, not LIKE-derived)
--    so a future column addition to one table is never silently
--    missing from the other -- both must be edited by hand together.
--
--    This is the ONLY table the live resolver (theme-scheduler Edge
--    Function) ever reads. It has NO admin RLS policies at all --
--    not even select -- because the admin UI never reads it
--    directly, only through publish_theme_schedule()'s return value
--    / theme_state.last_published_at. It is written only by
--    publish_theme_schedule() (SECURITY DEFINER) and read only by
--    the SECURITY DEFINER / service-role scheduler, both of which
--    bypass RLS entirely -- the revoke-all below is the actual
--    guard against any other access path.
-- ---------------------------------------------------------------
create table if not exists public.theme_schedules_published (
  id uuid primary key default gen_random_uuid(),

  theme_key text not null references public.theme_catalog(key),
  check (theme_key <> 'classic'),

  label text not null,
  enabled boolean not null default true,

  recurrence_type text not null check (recurrence_type in ('fixed_range', 'annual_fixed', 'annual_rule')),

  fixed_start timestamptz,
  fixed_end timestamptz,

  annual_start_month smallint check (annual_start_month between 1 and 12),
  annual_start_day smallint check (annual_start_day between 1 and 31),
  annual_end_month smallint check (annual_end_month between 1 and 12),
  annual_end_day smallint check (annual_end_day between 1 and 31),

  rule_kind text check (rule_kind in ('nth_weekday_offset', 'easter_offset')),
  rule_month smallint check (rule_month between 1 and 12),
  rule_weekday smallint check (rule_weekday between 0 and 6),
  rule_occurrence smallint check (rule_occurrence between -1 and 5 and rule_occurrence <> 0),
  window_start_offset_days smallint not null default 0,
  window_end_offset_days smallint not null default 0,

  start_time_local text not null default '00:00',
  end_time_local text not null default '23:59',

  tier_priority int not null default 0,
  accent_intensity numeric(3, 2) not null default 1.0 check (accent_intensity between 0.4 and 1.0),
  graphics_visibility text not null default 'normal' check (graphics_visibility in ('minimal', 'normal')),

  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint theme_schedules_published_recurrence_fields_chk check (
    (recurrence_type = 'fixed_range' and fixed_start is not null and fixed_end is not null)
    or (recurrence_type = 'annual_fixed' and annual_start_month is not null and annual_start_day is not null
        and annual_end_month is not null and annual_end_day is not null)
    or (recurrence_type = 'annual_rule' and rule_kind is not null and (
          (rule_kind = 'nth_weekday_offset' and rule_month is not null and rule_weekday is not null and rule_occurrence is not null)
          or (rule_kind = 'easter_offset')
        ))
  )
);

create index if not exists idx_theme_schedules_published_theme_key on public.theme_schedules_published (theme_key);

drop trigger if exists theme_schedules_published_set_updated_at on public.theme_schedules_published;
create trigger theme_schedules_published_set_updated_at
before update on public.theme_schedules_published
for each row execute function public.set_theme_schedules_updated_at();

alter table public.theme_schedules_published enable row level security;
revoke all on public.theme_schedules_published from anon;
-- Intentionally zero policies (no admin, no anon) -- see comment above.

commit;
