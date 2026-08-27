-- ============================================================
-- Vacation Mode: core schema.
--
-- One row per vacation cycle in `vacation_periods` -- the row's own
-- `id` IS the "vacation/reopening cycle ID" used everywhere else
-- (campaign keys, per-subscriber fulfillment tracking) to guarantee
-- exactly one reopening campaign per cycle and to let a subscriber's
-- one-time "notify me when ordering reopens" request become eligible
-- again on a future vacation without re-subscribing.
--
-- At most one row may have status='active' at a time -- enforced by
-- a partial unique index on a constant expression, the same trick
-- already used for the `bakery_settings`/`email_settings` singleton
-- tables (`unique index ... ((true))`), scoped here to the active
-- partial set instead of the whole table so historical (resumed)
-- cycles can accumulate freely.
--
-- The admin-facing columns (email draft, recipient settings, etc.)
-- stay behind admin-only RLS, same shape as `bakery_settings`/
-- `email_settings`. Public read access is granted narrowly at the
-- COLUMN level (`grant select (id, heading, message, reopen_at,
-- next_pickup_at) to anon`), combined with a row-level policy scoped
-- to `status = 'active'` -- NOT a view. An earlier draft of this
-- migration used a view that bypassed the base table's RLS for anon
-- (Postgres/Supabase's "security definer view" pattern); that trips
-- the linter's ERROR-level `security_definer_view` check for good
-- reason (it grants blanket row access under the view owner's
-- privileges), so it was replaced with this column-grant + policy
-- combination before ever being deployed. Client code for the public
-- pages must always select these five columns explicitly (never
-- `select("*")`) -- `select *` fails for a role that only holds
-- column-level privileges on part of the table.
-- ============================================================
begin;

create table if not exists public.vacation_periods (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'active' check (status in ('active', 'resumed')),

  started_at timestamptz not null default now(),
  ended_at timestamptz,

  -- Public-facing content.
  heading text not null default 'We''re on a baking break!',
  message text,
  reopen_at timestamptz,
  next_pickup_at timestamptz,

  -- Reopening-email draft (admin-only; never exposed by the public view).
  reopening_email_enabled boolean not null default true,
  email_subject text not null default 'We''re back! Ordering is open again',
  email_preview_text text,
  email_intro text,
  email_closing text,
  recipients_reopening_alerts boolean not null default true,
  recipients_menu_announcements boolean not null default true,
  recipients_general_updates boolean not null default false,
  auto_send_on_resume boolean not null default false,

  -- Preview-staleness tracking: set when the admin last generated a
  -- preview; compared against a fresh snapshot of the live menu at
  -- send time (and at UI-render time) to detect "menu changed since
  -- you last looked at this."
  preview_menu_snapshot_key text,
  preview_generated_at timestamptz,

  -- Populated once a reopening campaign has been created for this cycle.
  campaign_id uuid references public.email_campaigns(id) on delete set null,
  last_send_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists vacation_periods_one_active_idx
  on public.vacation_periods ((true))
  where status = 'active';

create index if not exists idx_vacation_periods_status on public.vacation_periods (status);
create index if not exists idx_vacation_periods_campaign on public.vacation_periods (campaign_id);

create or replace function public.set_vacation_periods_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists vacation_periods_set_updated_at on public.vacation_periods;
create trigger vacation_periods_set_updated_at
before update on public.vacation_periods
for each row execute function public.set_vacation_periods_updated_at();

alter table public.vacation_periods enable row level security;
revoke all on public.vacation_periods from anon;

drop policy if exists "Admins can view vacation periods" on public.vacation_periods;
create policy "Admins can view vacation periods" on public.vacation_periods
  for select to authenticated using (is_admin());
drop policy if exists "Admins can insert vacation periods" on public.vacation_periods;
create policy "Admins can insert vacation periods" on public.vacation_periods
  for insert to authenticated with check (is_admin());
drop policy if exists "Admins can update vacation periods" on public.vacation_periods;
create policy "Admins can update vacation periods" on public.vacation_periods
  for update to authenticated using (is_admin()) with check (is_admin());
-- No delete policy: vacation cycles are historical records, same
-- "archive don't delete" ethos as the rest of this project -- a
-- cycle is ended by flipping status to 'resumed', never removed.

-- ---------------------------------------------------------------
-- Public read access: row-scoped to the active cycle, column-scoped
-- to only the five public-safe fields. index.html / menu.html must
-- select exactly these column names (never "*") for this to resolve.
-- ---------------------------------------------------------------
drop policy if exists "Public can view active vacation status" on public.vacation_periods;
create policy "Public can view active vacation status" on public.vacation_periods
  for select to anon
  using (status = 'active');

grant select (id, heading, message, reopen_at, next_pickup_at)
  on public.vacation_periods to anon;

commit;
