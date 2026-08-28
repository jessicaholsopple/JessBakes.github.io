-- Rollback for 20260828100000_weekly_pickup_schedule.sql
begin;

create policy "Public can create orders" on public.orders
    for insert to anon with check (true);

create policy "Public can create order items" on public.order_items
    for insert to anon with check (true);

drop function if exists public.submit_order(text, text, text, text, text, date, text, numeric, jsonb);

drop trigger if exists trg_enforce_weekly_pickup_schedule on public.orders;
drop function if exists public.enforce_weekly_pickup_schedule();

drop function if exists public.preview_weekly_pickup(smallint, time, smallint, time);
drop function if exists public.compute_weekly_pickup(timestamptz);
drop function if exists public.compute_weekly_pickup_from(timestamptz, smallint, time, smallint, time);

alter table public.orders drop column if exists pickup_time;

alter table public.bakery_settings drop constraint if exists bakery_settings_weekly_schedule_timezone_check;
alter table public.bakery_settings drop constraint if exists bakery_settings_weekly_cutoff_weekday_check;
alter table public.bakery_settings drop constraint if exists bakery_settings_weekly_pickup_weekday_check;

alter table public.bakery_settings
    drop column if exists weekly_pickup_weekday,
    drop column if exists weekly_pickup_time,
    drop column if exists weekly_cutoff_weekday,
    drop column if exists weekly_cutoff_time,
    drop column if exists weekly_schedule_timezone;

commit;
