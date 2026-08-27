-- Deterministic rollback of 20260827091500_subscribers_preference_categories.sql.
-- Drops the four added columns. The backfill itself needs no explicit
-- undo -- it only ever set pref_menu_announcements, which is dropped
-- along with the column.
begin;

alter table public.subscribers
  drop column if exists pref_reopening_alerts,
  drop column if exists pref_menu_announcements,
  drop column if exists pref_general_updates,
  drop column if exists reopening_alert_fulfilled_cycle_id;

commit;
