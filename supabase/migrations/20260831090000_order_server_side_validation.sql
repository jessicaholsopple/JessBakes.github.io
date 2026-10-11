-- ============================================================
-- Server-side order validation (closes a real security/integrity
-- gap found during a stale-cart investigation).
--
-- Two problems, fixed together because they're the same underlying
-- issue -- the public checkout path never actually trusted the
-- database as the source of truth for what's orderable:
--
-- 1. submit_order() inserted whatever menu_item_id/price_at_purchase/
--    line_total/builder_details the BROWSER sent, with zero check
--    against the live menu_items table. A stale cart (or a
--    hand-crafted request) could submit a deleted/unavailable item,
--    a stale price, or an invalid Mix & Match flavor selection, and
--    it would be accepted as-is.
--
-- 2. `grant insert on public.orders/order_items to anon` (from
--    20260817092629_security_repair_...) was still in place from
--    before submit_order() existed. The real app never uses it --
--    js/cart.js has only ever called the submit_order RPC -- but it
--    meant a raw REST POST to /rest/v1/orders could bypass the RPC
--    (and therefore bypass vacation-mode, pickup-schedule, and now
--    this new validation) entirely. Revoked below; every public order
--    must now go through submit_order(), the one place all of this
--    is enforced. Authenticated-admin order creation/editing
--    (js/admin-orders.js, direct .from("orders") calls) is
--    unaffected -- it's governed by the separate "Admins can..."
--    policies, not the anon grant.
--
-- Pricing/availability is now re-derived from public.menu_items
-- inside the function for every line, never trusted from the
-- caller:
--   - Standard items: looked up by the sent menu_item_id, must be
--     product_type='standard' and available=true. Name and price
--     are taken from the live row.
--   - Mix & Match boxes: the client has never sent an id for the box
--     product itself (menu_item_id: null is a deliberate, long-
--     standing convention for every builder line -- see
--     js/order-editor.js -- relied on throughout admin order
--     editing, production, and recipe aggregation; NOT changed
--     here). The box is instead resolved by builder_group +
--     builder_size, where builder_size is derived from the SUM of
--     the selected flavor quantities (a box's selections always add
--     up to exactly that box's size -- enforced client-side by
--     MixAndMatch.validateBoxSelection, re-derived and re-checked
--     here rather than trusted). This also disambiguates between
--     same-builder_group boxes of different sizes (e.g. the current
--     "6 Mix & Match Cookies" / "12 Mix & Match Cookies"). Every
--     selected flavor must still satisfy the exact same eligibility
--     rule as MixAndMatch.isEligibleCookie: product_type='standard',
--     available=true, same builder_group.
--
-- Any validation failure raises and the whole function body (one
-- implicit transaction) rolls back -- no orders/order_items row is
-- ever left partially created.
--
-- p_preferred_contact now defaults to 'email' (named-parameter RPC
-- calls are unaffected by this ordering) -- js/cart.js no longer
-- sends it at all, having removed the preferred-contact-method
-- picker from checkout. The column itself, and every historical
-- value in it, is untouched.
-- ============================================================
begin;

revoke insert on public.orders from anon;
revoke insert on public.order_items from anon;

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
    v_pickup record;
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
            where m.id = (v_item->>'menu_item_id')::uuid
              and m.product_type = 'standard'
              and m.available = true;

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
                        where m.id = (v_selection->>'id')::uuid
                          and m.product_type = 'standard'
                          and m.available = true
                          and m.builder_group = v_builder_item.builder_group
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
    -- which session calls it.
    if p_order_type = 'weekly' then
        select * into v_pickup from public.compute_weekly_pickup(now());
    end if;

    insert into public.orders (
        customer_name, customer_email, customer_phone, preferred_contact,
        order_type, pickup_date, pickup_time, event_date, notes, subtotal, status
    ) values (
        p_customer_name, p_customer_email, p_customer_phone, coalesce(nullif(trim(p_preferred_contact), ''), 'email'),
        p_order_type,
        case when p_order_type = 'weekly' then v_pickup.pickup_date else p_event_date end,
        case when p_order_type = 'weekly' then v_pickup.pickup_time else null end,
        case when p_order_type = 'custom' then p_event_date else null end,
        p_notes, v_computed_subtotal, 'pending'
    ) returning * into v_order;

    for v_item in select * from jsonb_array_elements(v_validated_items)
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
