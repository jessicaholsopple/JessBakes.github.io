-- ============================================================
-- Fix: submit_order() fails for every order_type = 'custom' request
-- with "record v_pickup is not assigned yet" (SQLSTATE 55000).
--
-- Root cause: `v_pickup record` is declared but only ever SELECT INTO
-- assigned inside `if p_order_type = 'weekly' then ... end if;` -- for
-- a 'custom' order, that branch never runs, so v_pickup stays
-- unassigned and has NO known tuple descriptor. The INSERT further
-- down unconditionally references `v_pickup.pickup_date` and
-- `v_pickup.pickup_time` inside CASE expressions:
--
--   case when p_order_type = 'weekly' then v_pickup.pickup_date else p_event_date end
--
-- Even though the WHEN is false for a custom order and that branch is
-- never the one "taken" semantically, Postgres still has to resolve
-- the data TYPE of every branch of the CASE to determine the
-- expression's overall result type before the INSERT can even be
-- planned -- and resolving the type of a field access on an
-- unassigned record is itself the error, independent of which branch
-- actually executes at runtime. This is a plain PL/pgSQL record-typing
-- pitfall, not something introduced by, or specific to, the finished-
-- stock work -- it has been present since
-- 20260828120000_fix_submit_order_null_pickup_date.sql first
-- introduced this exact CASE pattern, and reproduces on every custom
-- order submitted against the live site today.
--
-- Fix: replace the RECORD variable with two plain, statically-typed
-- scalar variables (date / time). PL/pgSQL auto-initializes scalar
-- variables to NULL at declaration with a fixed, known type -- so
-- referencing them before they're assigned is completely safe and
-- type-resolves fine, unlike a record with no tuple descriptor at
-- all. For a custom order they simply stay NULL and are never used
-- (the ELSE branches -- p_event_date / null -- are what's actually
-- stored), exactly matching the pre-existing, correct custom-order
-- behavior: pickup_date/pickup_time come from nothing but
-- p_event_date, event_date is stored separately, and no pickup data
-- is invented.
--
-- Everything else in this function is BYTE-IDENTICAL to
-- 20261012124500_submit_order_stock_aware.sql: the exact same
-- signature (so this REPLACES the live function in place -- it does
-- NOT create a new overload; see
-- 20261012131500_drop_orphaned_submit_order_overload.sql for why that
-- distinction matters), the same finished-stock eligibility checks,
-- the same Mix & Match validation, the same live re-pricing, the same
-- vacation-mode/cutoff guards, and the same single-transaction
-- atomicity (one function body, no exception handler -- any
-- RAISE EXCEPTION anywhere, including from the stock-reservation
-- trigger fired by the order_items inserts, still rolls back the
-- whole order). Email-outbox enqueueing and duplicate-send protection
-- are handled entirely by a separate trigger on `orders`
-- (trg_enqueue_order_status_email) that this migration does not touch
-- at all.
-- ============================================================
begin;

create or replace function public.submit_order(
    p_customer_name text,
    p_customer_email text,
    p_customer_phone text,
    p_order_type text,
    p_event_date date,
    p_notes text,
    p_subtotal numeric,
    p_items jsonb,
    p_preferred_contact text default 'email'
) returns public.orders
language plpgsql
security definer
set search_path to 'public'
as $$
declare
    v_order public.orders;
    v_item jsonb;
    v_selection jsonb;
    v_vacation_active boolean;
    v_weekly_pickup_date date;
    v_weekly_pickup_time time;
    v_menu_item record;
    v_builder_item record;
    v_quantity integer;
    v_selections jsonb;
    v_selected_total integer;
    v_resolved_name text;
    v_resolved_price numeric;
    v_line_total numeric;
    v_computed_subtotal numeric := 0;
    v_validated_items jsonb := '[]'::jsonb;
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

    if coalesce(trim(p_customer_email), '') = '' or p_customer_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
        raise exception 'A valid customer_email is required';
    end if;

    if coalesce(trim(p_customer_phone), '') = '' then
        raise exception 'customer_phone is required';
    end if;

    if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
        raise exception 'At least one item is required';
    end if;

    -- ---- Validate and authoritatively re-price every line BEFORE
    --      inserting anything. ----
    for v_item in select * from jsonb_array_elements(p_items)
    loop
        begin
            v_quantity := (v_item->>'quantity')::integer;
        exception when others then
            raise exception 'Invalid quantity for %', coalesce(v_item->>'item_name', 'an item');
        end;

        if v_quantity is null or v_quantity < 1 then
            raise exception 'Invalid quantity for %', coalesce(v_item->>'item_name', 'an item');
        end if;

        if coalesce(v_item->>'menu_item_id', '') <> '' then
            -- ---- Standard (single) item. ----
            select m.name, m.price into v_resolved_name, v_resolved_price
            from public.menu_items m
            left join public.menu_item_stock ms on ms.menu_item_id = m.id
            where m.id = (v_item->>'menu_item_id')::uuid
              and m.product_type = 'standard'
              and m.available = true
              and (ms.stock_mode is null or ms.stock_mode <> 'limited' or ms.available_count > 0);

            if not found then
                raise exception '% is no longer available. Please remove it from your cart and try again.', coalesce(v_item->>'item_name', 'An item in your cart');
            end if;

            v_line_total := v_resolved_price * v_quantity;

            v_validated_items := v_validated_items || jsonb_build_array(jsonb_build_object(
                'menu_item_id', v_item->>'menu_item_id',
                'item_name', v_resolved_name,
                'quantity', v_quantity,
                'price_at_purchase', v_resolved_price,
                'line_total', v_line_total,
                'builder_details', null
            ));
        else
            -- ---- Mix & Match builder box. ----
            if v_item->'builder_details' is null or coalesce(v_item->'builder_details'->>'builder_group', '') = '' then
                raise exception 'Invalid Mix & Match selection.';
            end if;

            v_selections := coalesce(v_item->'builder_details'->'selections', '[]'::jsonb);

            select coalesce(sum((s->>'quantity')::integer), 0) into v_selected_total
            from jsonb_array_elements(v_selections) s;

            if v_selected_total is null or v_selected_total <= 0 then
                raise exception 'Invalid Mix & Match selection.';
            end if;

            select m.name, m.price, m.builder_group into v_builder_item
            from public.menu_items m
            where m.product_type = 'builder'
              and m.builder_group = (v_item->'builder_details'->>'builder_group')
              and m.builder_size = v_selected_total
              and m.available = true;

            if not found then
                raise exception '% is no longer available in that size. Please remove it from your cart and try again.', coalesce(v_item->>'item_name', 'A Mix & Match box');
            end if;

            for v_selection in select * from jsonb_array_elements(v_selections)
            loop
                if coalesce((v_selection->>'quantity')::integer, 0) > 0 then
                    if not exists (
                        select 1 from public.menu_items m
                        left join public.menu_item_stock ms on ms.menu_item_id = m.id
                        where m.id = (v_selection->>'id')::uuid
                          and m.product_type = 'standard'
                          and m.available = true
                          and m.builder_group = v_builder_item.builder_group
                          and (ms.stock_mode is null or ms.stock_mode <> 'limited' or ms.available_count > 0)
                    ) then
                        raise exception '% is no longer available. Please update your Mix & Match box and try again.', coalesce(v_selection->>'name', 'A selected flavor');
                    end if;
                end if;
            end loop;

            v_line_total := v_builder_item.price * v_quantity;

            v_validated_items := v_validated_items || jsonb_build_array(jsonb_build_object(
                'menu_item_id', null,
                'item_name', v_builder_item.name,
                'quantity', v_quantity,
                'price_at_purchase', v_builder_item.price,
                'line_total', v_line_total,
                'builder_details', jsonb_build_object(
                    'builder_group', v_builder_item.builder_group,
                    'selections', v_selections
                )
            ));
        end if;

        v_computed_subtotal := v_computed_subtotal + v_line_total;
    end loop;

    -- Computed directly here (never left to the admin-gated trigger to
    -- fill in) so this RPC is correct for a weekly order no matter
    -- which session calls it. For a custom order these stay NULL and
    -- are never read below -- p_event_date is the only source of
    -- custom-order scheduling data, exactly as before this fix.
    if p_order_type = 'weekly' then
        select pickup_date, pickup_time
        into v_weekly_pickup_date, v_weekly_pickup_time
        from public.compute_weekly_pickup(now());
    end if;

    insert into public.orders (
        customer_name, customer_email, customer_phone, preferred_contact,
        order_type, pickup_date, pickup_time, event_date, notes, subtotal, status
    ) values (
        p_customer_name, p_customer_email, p_customer_phone, coalesce(nullif(trim(p_preferred_contact), ''), 'email'),
        p_order_type,
        case when p_order_type = 'weekly' then v_weekly_pickup_date else p_event_date end,
        case when p_order_type = 'weekly' then v_weekly_pickup_time else null end,
        case when p_order_type = 'custom' then p_event_date else null end,
        p_notes, v_computed_subtotal, 'pending'
    ) returning * into v_order;

    for v_item in select * from jsonb_array_elements(v_validated_items)
    loop
        -- Each single-row insert is its own statement, so
        -- trg_reconcile_stock_after_order_items_insert fires after
        -- every one of them -- cumulative and self-healing (it always
        -- reads the full current order_items for this order), and if
        -- any one of them can't be reserved (insufficient stock), the
        -- RAISE EXCEPTION it throws rolls back this entire function,
        -- including the orders row just inserted above and every
        -- order_items row inserted by an earlier iteration of this
        -- loop. No partial order is ever left behind.
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
