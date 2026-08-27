-- ============================================================
-- Subscriber preference categories, for Vacation Mode's signup
-- widget (homepage vacation section + Menu vacation notice) and its
-- reopening-email recipient targeting.
--
-- The existing `subscribers` table only ever had one implicit
-- category (the weekly-menu newsletter). This migration adds three
-- explicit, independent opt-ins:
--   * pref_reopening_alerts     -- "notify me when ordering reopens"
--   * pref_menu_announcements   -- new-menu announcements (this is
--                                  what the existing weekly_menu
--                                  campaign already targets via
--                                  `status = 'active'`; going forward
--                                  it should also require this flag --
--                                  see the follow-up note below)
--   * pref_general_updates      -- other Jess Bakes updates
--
-- `reopening_alert_fulfilled_cycle_id` marks the reopening-alert
-- preference "used" for exactly one vacation cycle (see
-- `vacation_periods.id` in 20260827090000). It is intentionally NOT a
-- one-way unsubscribe: a subscriber whose alert was fulfilled for
-- cycle A remains eligible again the moment a new cycle B exists,
-- since `reopening_alert_fulfilled_cycle_id is distinct from B`.
--
-- Backfill: existing ACTIVE subscribers already consented to the
-- weekly-menu newsletter -- that consent is preserved as
-- pref_menu_announcements = true. The other two categories default
-- to false for everyone (reopening alerts and general updates are
-- new asks this project never collected consent for before).
-- Unsubscribed/bounced/complained subscribers are left at all-false
-- (nothing to preserve; they don't receive mail regardless).
-- ============================================================
begin;

alter table public.subscribers
  add column if not exists pref_reopening_alerts boolean not null default false,
  add column if not exists pref_menu_announcements boolean not null default false,
  add column if not exists pref_general_updates boolean not null default false,
  add column if not exists reopening_alert_fulfilled_cycle_id uuid;

update public.subscribers
set pref_menu_announcements = true
where status = 'active'
  and pref_menu_announcements = false
  and pref_reopening_alerts = false
  and pref_general_updates = false;

commit;
