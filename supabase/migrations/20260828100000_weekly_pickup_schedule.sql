-- ============================================================
-- Configurable weekly-pickup cutoff system (2026-08-28).
--
-- Replaces every hand-rolled, device-clock-trusting "next Sunday"
-- calculation (js/cart.js getNextPickupDate(), js/admin-orders.js
-- getNextSundayForManualOrder()) with ONE canonical, authoritative
-- algorithm that lives here in Postgres and runs against the DATABASE
-- clock, in Europe/Berlin wall-clock time, DST-aware by construction
-- (Postgres resolves 'Europe/Berlin' via its own IANA tzdata).
--
-- Root cause of the old Monday-Thursday/Friday-Sunday split: the old
-- code only ever compared calendar days (JS Date.getDay(), on the
-- CUSTOMER's device clock/timezone), never a specific cutoff TIME --
-- effectively "Friday" through "Sunday" were all crudely treated as
-- one lump "past cutoff" bucket because there was no HH:MM boundary
-- concept at all, and the pickup_date sent to the database was
-- whatever the browser computed, with zero server-side validation
-- (orders' anon INSERT policy had with_check: true -- any value was
-- accepted).
--
-- Default rule: weekly pickup Sunday 12:30 PM, order cutoff Friday
-- 5:00 PM, Europe/Berlin. Cutoff is EXCLUSIVE: at or after 5:00:00 PM
-- the upcoming Sunday is closed and the next eligible pickup becomes
-- the following Sunday.
-- ============================================================
begin;

-- ---- 1. Configurable schedule on bakery_settings (existing settings
--         architecture -- reused, not duplicated) ----------------

alter table public.bakery_settings
  add column if not exists weekly_pickup_weekday smallint not null default 0,
  add column if not exists weekly_pickup_time time not null default '12:30:00',
  add column if not exists weekly_cutoff_weekday smallint not null default 5,
  add column if not exists weekly_cutoff_time time not null default '17:00:00',
  add column if not exists weekly_schedule_timezone text not null default 'Europe/Berlin';

alter table public.bakery_settings drop constraint if exists bakery_settings_weekly_pickup_weekday_check;
alter table public.bakery_settings
  add constraint bakery_settings_weekly_pickup_weekday_check check (weekly_pickup_weekday between 0 and 6);

alter table public.bakery_settings drop constraint if exists bakery_settings_weekly_cutoff_weekday_check;
alter table public.bakery_settings
  add constraint bakery_settings_weekly_cutoff_weekday_check check (weekly_cutoff_weekday between 0 and 6);

-- Fixed to Europe/Berlin for now (the same zone every other bakery-wide
-- time calculation in this project already treats as canonical --
-- js/vacation-mode.js's formatBakeryDateTime, the weekly-menu-email
-- scheduler). Stored as a real column (not hardcoded in application
-- code) so it stays visible/inspectable, per the requirement, even
-- though the Admin Settings UI renders it as a fixed, read-only label
-- rather than an editable field.
alter table public.bakery_settings drop constraint if exists bakery_settings_weekly_schedule_timezone_check;
alter table public.bakery_settings
  add constraint bakery_settings_weekly_schedule_timezone_check check (weekly_schedule_timezone = 'Europe/Berlin');

comment on column public.bakery_settings.weekly_pickup_weekday is 'Weekly pickup day of week, 0=Sunday..6=Saturday (matches JS Date.getDay() and Postgres EXTRACT(DOW)).';
comment on column public.bakery_settings.weekly_cutoff_weekday is 'Order cutoff day of week, 0=Sunday..6=Saturday. The cutoff for a given pickup is the most recent occurrence of this weekday at or before the pickup.';

-- ---- 2. orders.pickup_time -- the exact time half of the
--         authoritative pickup moment. pickup_date (date) is
--         preserved unchanged for backward compatibility; every
--         existing weekly order gets this backfilled to 12:30:00,
--         the one and only pickup time that has EVER been offered
--         system-wide until now (it was hardcoded everywhere) -- this
--         fills in a previously-unstored fact, it does not recompute
--         or move any order's pickup_date. ------------------------

alter table public.orders add column if not exists pickup_time time;

update public.orders
  set pickup_time = '12:30:00'
  where order_type = 'weekly' and pickup_time is null;

comment on column public.orders.pickup_time is 'The exact pickup time paired with pickup_date, set authoritatively by the enforce_weekly_pickup_schedule trigger for weekly orders at insert time. Null for custom orders (pickup_date there mirrors the admin-negotiated event_date).';

-- ---- 3. The canonical algorithm, stateless and pure (no table
--         reads) -- everything else calls this. Mirrors, field for
--         field, the pure JS twin in js/weekly-schedule.js; the two
--         are hand-kept in sync, exactly like buildMenuSnapshotKey's
--         browser/Deno pair elsewhere in this project. If you change
--         one, change the other. --------------------------------

create or replace function public.compute_weekly_pickup_from(
    p_now timestamptz,
    p_pickup_weekday smallint,
    p_pickup_time time,
    p_cutoff_weekday smallint,
    p_cutoff_time time
) returns table(pickup_date date, pickup_time time)
language plpgsql
stable
as $$
declare
    v_now_berlin timestamp;
    v_now_weekday smallint;
    v_days_until_pickup smallint;
    v_candidate_date date;
    v_days_before_pickup smallint;
    v_candidate_cutoff timestamp;
    v_i smallint;
begin
    -- Wall-clock time in Berlin right now, DST-correct via Postgres's
    -- own IANA tzdata -- never a raw UTC-weekday comparison.
    v_now_berlin := p_now at time zone 'Europe/Berlin';
    v_now_weekday := extract(dow from v_now_berlin)::smallint; -- 0=Sun..6=Sat, same convention as p_pickup_weekday

    -- Nearest occurrence of the pickup weekday, INCLUDING today if
    -- today already is that weekday (whether pickup_time has passed
    -- today or not is irrelevant here -- only the cutoff check below
    -- decides eligibility).
    v_days_until_pickup := ((p_pickup_weekday - v_now_weekday) + 7) % 7;
    v_candidate_date := (v_now_berlin::date) + v_days_until_pickup;

    -- How many days before its pickup the cutoff falls, within one
    -- weekly cycle (0 = same day as pickup).
    v_days_before_pickup := ((p_pickup_weekday - p_cutoff_weekday) + 7) % 7;

    -- Bounded loop (a full cycle is at most 7 days away, but a couple
    -- of extra iterations cost nothing and remove any need to reason
    -- about whether one bump is always enough for every configurable
    -- combination of days/times).
    for v_i in 0..3 loop
        v_candidate_cutoff := (v_candidate_date - v_days_before_pickup) + p_cutoff_time;

        -- Exclusive cutoff: once the clock reaches exactly the cutoff
        -- moment, that pickup is closed.
        if v_now_berlin < v_candidate_cutoff then
            pickup_date := v_candidate_date;
            pickup_time := p_pickup_time;
            return next;
            return;
        end if;

        v_candidate_date := v_candidate_date + 7;
    end loop;

    -- Unreachable given the loop bound above, but never return nothing.
    pickup_date := v_candidate_date;
    pickup_time := p_pickup_time;
    return next;
end;
$$;

-- ---- 4. Reads the saved settings and calls the pure algorithm with
--         the real database clock. This is "the" authoritative
--         answer -- the trigger below and the RPC both call this,
--         never reimplement it. ------------------------------------

create or replace function public.compute_weekly_pickup(p_now timestamptz default now())
returns table(pickup_date date, pickup_time time)
language plpgsql
stable
as $$
declare
    v_settings record;
begin
    select weekly_pickup_weekday, weekly_pickup_time, weekly_cutoff_weekday, weekly_cutoff_time
    into v_settings
    from public.bakery_settings
    limit 1;

    if v_settings is null then
        return query select * from public.compute_weekly_pickup_from(p_now, 0::smallint, '12:30:00'::time, 5::smallint, '17:00:00'::time);
    else
        return query select * from public.compute_weekly_pickup_from(
            p_now, v_settings.weekly_pickup_weekday, v_settings.weekly_pickup_time,
            v_settings.weekly_cutoff_weekday, v_settings.weekly_cutoff_time
        );
    end if;
end;
$$;

-- ---- 5. Public, read-only preview -- the ONE function both the
--         checkout page (no override args -- the saved settings) and
--         the Admin Settings "if changed" live preview (override args
--         -- the not-yet-saved candidate values) call. Always uses
--         now() (the database clock), never a client-supplied time,
--         so even the *preview* the customer sees is never based on
--         their device clock. SECURITY DEFINER so anon can call it
--         without any broader grant on bakery_settings itself (only
--         these specific, safe fields are ever exposed, via the
--         function's own return columns -- pickup_location and every
--         other bakery_settings column stay exactly as private as
--         before). ---------------------------------------------

create or replace function public.preview_weekly_pickup(
    p_pickup_weekday smallint default null,
    p_pickup_time time default null,
    p_cutoff_weekday smallint default null,
    p_cutoff_time time default null
) returns table(
    pickup_date date,
    pickup_time time,
    pickup_weekday smallint,
    cutoff_weekday smallint,
    cutoff_time time,
    schedule_timezone text
)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
    v_settings record;
    v_pickup_weekday smallint;
    v_pickup_time time;
    v_cutoff_weekday smallint;
    v_cutoff_time time;
    v_computed record;
begin
    select weekly_pickup_weekday, weekly_pickup_time, weekly_cutoff_weekday, weekly_cutoff_time, weekly_schedule_timezone
    into v_settings
    from public.bakery_settings
    limit 1;

    v_pickup_weekday := coalesce(p_pickup_weekday, v_settings.weekly_pickup_weekday, 0::smallint);
    v_pickup_time := coalesce(p_pickup_time, v_settings.weekly_pickup_time, '12:30:00'::time);
    v_cutoff_weekday := coalesce(p_cutoff_weekday, v_settings.weekly_cutoff_weekday, 5::smallint);
    v_cutoff_time := coalesce(p_cutoff_time, v_settings.weekly_cutoff_time, '17:00:00'::time);

    select * into v_computed
    from public.compute_weekly_pickup_from(now(), v_pickup_weekday, v_pickup_time, v_cutoff_weekday, v_cutoff_time);

    pickup_date := v_computed.pickup_date;
    pickup_time := v_computed.pickup_time;
    pickup_weekday := v_pickup_weekday;
    cutoff_weekday := v_cutoff_weekday;
    cutoff_time := v_cutoff_time;
    schedule_timezone := coalesce(v_settings.weekly_schedule_timezone, 'Europe/Berlin');
    return next;
end;
$$;

grant execute on function public.preview_weekly_pickup(smallint, time, smallint, time) to anon, authenticated;

-- ---- 6. Authoritative enforcement trigger. Fires on every insert
--         into orders regardless of HOW it got there (the submit_order
--         RPC below, or -- as a structural backstop -- any future
--         direct write) and, for a non-admin weekly order, throws away
--         whatever pickup_date/pickup_time was submitted and replaces
--         it with the freshly computed authoritative value. Admin
--         (is_admin()) inserts are completely untouched, preserving
--         the existing free-form manual pickup-date override in Admin
--         New Order/Edit Order. Also re-checks Vacation Mode for any
--         non-admin insert (both order types), the same authoritative
--         boundary the app-level guard in js/cart.js already checks
--         before ever reaching this point -- defense in depth, not a
--         behavior change. --------------------------------------

create or replace function public.enforce_weekly_pickup_schedule()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
    v_vacation_active boolean;
    v_computed record;
begin
    if not public.is_admin() then

        select exists(select 1 from public.vacation_periods where status = 'active') into v_vacation_active;
        if v_vacation_active then
            raise exception 'Ordering is currently paused for vacation.';
        end if;

        if NEW.order_type = 'weekly' then
            select * into v_computed from public.compute_weekly_pickup(now());
            NEW.pickup_date := v_computed.pickup_date;
            NEW.pickup_time := v_computed.pickup_time;
        end if;

    end if;

    return NEW;
end;
$$;

drop trigger if exists trg_enforce_weekly_pickup_schedule on public.orders;
create trigger trg_enforce_weekly_pickup_schedule
    before insert on public.orders
    for each row execute function public.enforce_weekly_pickup_schedule();

-- ---- 7. Atomic order + order_items submission. The sole path for
--         customer (anon) order creation going forward -- see step 8,
--         which removes the old blanket anon INSERT policies these
--         replace. Runs as one implicit transaction: if any item
--         insert fails, the whole thing (including the orders row)
--         rolls back, so a network hiccup mid-checkout can never leave
--         a headless orders row with no order_items. -----------------

create or replace function public.submit_order(
    p_customer_name text,
    p_customer_email text,
    p_customer_phone text,
    p_preferred_contact text,
    p_order_type text,
    p_event_date date,
    p_notes text,
    p_subtotal numeric,
    p_items jsonb
) returns public.orders
language plpgsql
security definer
set search_path to 'public'
as $$
declare
    v_order public.orders;
    v_item jsonb;
    v_vacation_active boolean;
begin
    select exists(select 1 from public.vacation_periods where status = 'active') into v_vacation_active;
    if v_vacation_active then
        raise exception 'Ordering is currently paused for vacation.';
    end if;

    if p_order_type not in ('weekly', 'custom') then
        raise exception 'Invalid order_type: %', p_order_type;
    end if;

    if p_order_type = 'custom' and p_event_date is null then
        raise exception 'event_date is required for custom orders';
    end if;

    if coalesce(trim(p_customer_name), '') = '' then
        raise exception 'customer_name is required';
    end if;

    if coalesce(trim(p_customer_phone), '') = '' then
        raise exception 'customer_phone is required';
    end if;

    if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
        raise exception 'At least one item is required';
    end if;

    -- pickup_date/pickup_time is intentionally NOT set here for weekly
    -- orders -- the BEFORE INSERT trigger (step 6) computes it
    -- authoritatively from the database clock and overwrites whatever
    -- this insert would otherwise have produced (nothing, since it's
    -- omitted). For custom orders, pickup_date mirrors the
    -- admin-negotiated event_date, exactly as before this migration.
    insert into public.orders (
        customer_name, customer_email, customer_phone, preferred_contact,
        order_type, pickup_date, event_date, notes, subtotal, status
    ) values (
        p_customer_name, p_customer_email, p_customer_phone, p_preferred_contact,
        p_order_type,
        case when p_order_type = 'custom' then p_event_date else null end,
        case when p_order_type = 'custom' then p_event_date else null end,
        p_notes, p_subtotal, 'pending'
    ) returning * into v_order;

    for v_item in select * from jsonb_array_elements(p_items)
    loop
        insert into public.order_items (
            order_id, menu_item_id, item_name, quantity, price_at_purchase, line_total, builder_details
        ) values (
            v_order.id,
            nullif(v_item->>'menu_item_id', '')::uuid,
            v_item->>'item_name',
            (v_item->>'quantity')::integer,
            (v_item->>'price_at_purchase')::numeric,
            (v_item->>'line_total')::numeric,
            v_item->'builder_details'
        );
    end loop;

    return v_order;
end;
$$;

grant execute on function public.submit_order(text, text, text, text, text, date, text, numeric, jsonb) to anon;

-- ---- 8. Close the direct-REST-API attack vector: customer order
--         creation now goes exclusively through submit_order() (step
--         7), which is SECURITY DEFINER and unaffected by RLS on its
--         own internal inserts. Nothing else in this codebase writes
--         orders/order_items as anon (admin's own create/edit flow is
--         authenticated + is_admin(), a separate, untouched policy
--         pair below). Without this, a crafted request straight to
--         PostgREST could still insert an arbitrary pickup_date. -----

drop policy if exists "Public can create orders" on public.orders;
drop policy if exists "Public can create order items" on public.order_items;

commit;
