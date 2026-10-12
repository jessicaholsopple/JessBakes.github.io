-- Rollback for 20261012124500_submit_order_stock_aware.sql
--
-- Restores submit_order() to the version from
-- 20260831090000_order_server_side_validation.sql (full price/
-- availability/Mix & Match validation, but with no awareness of
-- finished-product stock at all -- a sold-out item would once again
-- be orderable as long as menu_items.available = true). Does not
-- touch the anon insert revokes from that migration, and does not
-- touch any finished-stock table or the reconcile triggers -- those
-- are rolled back independently by their own migrations' rollback
-- files if needed.
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
