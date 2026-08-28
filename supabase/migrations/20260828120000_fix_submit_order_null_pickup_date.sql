-- ============================================================
-- Hotfix (2026-08-28): submit_order() left pickup_date NULL for a
-- weekly order whenever the CALLING session happened to be an
-- authenticated admin (e.g. the admin testing checkout from the same
-- browser as an active /admin/* session -- Supabase auth sessions are
-- shared across same-origin pages via localStorage).
--
-- Root cause: submit_order() intentionally inserted pickup_date: NULL
-- for weekly orders, relying entirely on the BEFORE INSERT trigger
-- (enforce_weekly_pickup_schedule) to fill it in. That trigger
-- deliberately skips its recompute when is_admin() is true, to
-- preserve an admin's ability to manually override a pickup date when
-- editing an order directly. submit_order() is the CUSTOMER-CHECKOUT
-- path -- it must always produce a correct, non-null pickup_date for
-- a weekly order regardless of who happens to be calling it, so it
-- must not depend on that admin-gated trigger for its own correctness.
--
-- Confirmed no partial order was created by the failing test: the
-- NOT NULL constraint violation aborted the whole transaction (the
-- entire function body is one implicit transaction), so no orphaned
-- orders/order_items row exists from it.
--
-- Fix: submit_order() now calls compute_weekly_pickup() itself and
-- inserts the result directly for weekly orders -- exactly the same
-- authoritative function the trigger and preview_weekly_pickup use,
-- just called explicitly instead of assumed. The trigger is left
-- completely unchanged and still fires as a redundant backstop for
-- any other (non-admin) insert path; for a submit_order-created row it
-- is now a no-op either way (the value it would compute already
-- matches what was just inserted).
-- ============================================================
begin;

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
    v_pickup record;
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

    -- Computed directly here (never left to the admin-gated trigger to
    -- fill in) so this RPC is correct for a weekly order no matter
    -- which session calls it.
    if p_order_type = 'weekly' then
        select * into v_pickup from public.compute_weekly_pickup(now());
    end if;

    insert into public.orders (
        customer_name, customer_email, customer_phone, preferred_contact,
        order_type, pickup_date, pickup_time, event_date, notes, subtotal, status
    ) values (
        p_customer_name, p_customer_email, p_customer_phone, p_preferred_contact,
        p_order_type,
        case when p_order_type = 'weekly' then v_pickup.pickup_date else p_event_date end,
        case when p_order_type = 'weekly' then v_pickup.pickup_time else null end,
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

commit;
