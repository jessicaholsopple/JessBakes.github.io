-- Rollback for 20260828120000_fix_submit_order_null_pickup_date.sql
-- Restores submit_order() to the version from
-- 20260828100000_weekly_pickup_schedule.sql (the one with the NULL
-- pickup_date bug for authenticated-admin callers -- only use this if
-- the hotfix itself needs to be backed out for some reason).
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

commit;
