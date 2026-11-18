-- ============================================================
-- Makes submit_order() promotions-aware, and adds the companion
-- admin_reconcile_order_promotions() RPC used by the admin order
-- editor. This is the one genuinely risky migration in the
-- promotions feature (it changes live order-submission behavior) --
-- apply it only after 20261118100000_promotions_schema.sql has been
-- applied and the admin Promotions UI has been exercised against it.
--
-- submit_order's signature is UNCHANGED. A promo-reward line is just
-- a normal p_items[] entry carrying one new optional key,
-- "promotion_claim": {"promotion_id": "<uuid>"}. Its menu_item_id is
-- always a REAL standard product id (the same cookie sold for money)
-- -- never null, never a synthetic id -- so it flows through the
-- exact same order_items insert + finished-stock reservation trigger
-- as a paid unit of that same cookie. The only thing that changes is
-- its price, which is forced to 0 here, server-side, only after
-- independently re-validating the claim -- the existing "never trust
-- the client's price" posture is extended, not weakened.
--
-- Processing stays two-phase, matching the function's existing
-- shape: phase 1 (the existing per-item loop) validates/re-prices
-- every PAID line and accumulates v_computed_subtotal, while
-- promotion_claim lines are set aside unprocessed (their legitimacy
-- depends on the FINAL paid subtotal, which isn't known until the
-- loop ends). Phase 2, a short second loop, validates each set-aside
-- claim against that final subtotal and the promotion's own rules,
-- then appends it to the same v_validated_items array the existing
-- insert loop already walks -- so order creation stays one
-- all-or-nothing transaction exactly as before: any raise exception
-- anywhere, including a promo-claim rejection, still rolls back the
-- whole order.
-- ============================================================
begin;

-- ---------------------------------------------------------------
-- Single implementation of "is this a real, purchasable standard
-- item right now" -- used by submit_order for BOTH an ordinary paid
-- line and a promo-reward claim, so the two paths can never drift
-- out of sync with each other.
-- ---------------------------------------------------------------
create or replace function public.resolve_purchasable_standard_item(p_menu_item_id uuid)
returns table (item_name text, item_price numeric)
language sql
stable
set search_path = public, pg_temp
as $$
  select m.name, m.price
  from public.menu_items m
  left join public.menu_item_stock ms on ms.menu_item_id = m.id
  where m.id = p_menu_item_id
    and m.product_type = 'standard'
    and m.available = true
    and (ms.stock_mode is null or ms.stock_mode <> 'limited' or ms.available_count > 0)
$$;

-- Not security definer -- it's only ever called FROM inside
-- submit_order/admin_reconcile_order_promotions's own security-
-- definer execution context, so it already runs with their elevated
-- privileges there. Revoked from PUBLIC so it isn't also left as an
-- unintended standalone public RPC endpoint (it would be harmless if
-- called directly -- it returns nothing not already on the public
-- menu -- but there's no reason to expose it as its own entry point).
revoke all on function public.resolve_purchasable_standard_item(uuid) from public;

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
    v_builder_item record;
    v_quantity integer;
    v_selections jsonb;
    v_selected_total integer;
    v_resolved_name text;
    v_resolved_price numeric;
    v_line_total numeric;
    v_computed_subtotal numeric := 0;
    v_validated_items jsonb := '[]'::jsonb;

    -- Promotion-claim handling (phase 2).
    v_promo_claims jsonb := '[]'::jsonb;
    v_promo public.promotions;
    v_claimed_menu_item_id uuid;
    v_claimed_name text;
    v_promo_claim_counts jsonb := '{}'::jsonb;
    v_claims_so_far integer;
    v_new_redemption_count integer;
    v_customer_redemption_count integer;
    v_reward_quantity integer;
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

    -- ---- Phase 1: validate and authoritatively re-price every PAID
    --      line. Promotion-claim lines are set aside into
    --      v_promo_claims -- their validity depends on the subtotal
    --      this loop is still accumulating, so they can't be checked
    --      yet. ----
    for v_item in select * from jsonb_array_elements(p_items)
    loop
        if v_item ? 'promotion_claim' and v_item->'promotion_claim' is not null and jsonb_typeof(v_item->'promotion_claim') = 'object' then
            v_promo_claims := v_promo_claims || jsonb_build_array(v_item);
            continue;
        end if;

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
            select item_name, item_price into v_resolved_name, v_resolved_price
            from public.resolve_purchasable_standard_item((v_item->>'menu_item_id')::uuid);

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

    -- ---- Phase 2: validate every set-aside promotion claim against
    --      the now-final v_computed_subtotal (paid items only -- a
    --      promo line can never count toward its own, or any other,
    --      threshold, because it was excluded from phase 1 entirely).
    -- ----
    for v_item in select * from jsonb_array_elements(v_promo_claims)
    loop
        if coalesce(v_item->'promotion_claim'->>'promotion_id', '') = '' then
            raise exception 'Invalid promotion claim.';
        end if;

        -- Row lock: this claim is about to conditionally increment
        -- promotions.redemption_count below, and must serialize
        -- against a concurrent order racing for the same limited
        -- redemption slot -- the same reason reconcile_order_stock()
        -- locks menu_item_stock rows via its own conditional UPDATE.
        select * into v_promo
        from public.promotions
        where id = (v_item->'promotion_claim'->>'promotion_id')::uuid
        for update;

        if not found then
            raise exception 'This promotion is no longer available.';
        end if;

        if v_promo.admin_status <> 'enabled' or v_promo.application_mode <> 'automatic' then
            raise exception 'This promotion is no longer available.';
        end if;

        if v_promo.start_at is not null and v_promo.start_at > now() then
            raise exception 'This promotion is no longer available.';
        end if;

        if v_promo.end_at is not null and v_promo.end_at < now() then
            raise exception 'This promotion is no longer available.';
        end if;

        if v_promo.promotion_type <> 'free_item' then
            raise exception 'This promotion cannot be claimed this way.';
        end if;

        if v_promo.threshold_operator = 'gte' then
            if v_computed_subtotal < v_promo.qualifying_subtotal_min then
                raise exception 'Your order no longer qualifies for this promotion.';
            end if;
        else
            if v_computed_subtotal <= v_promo.qualifying_subtotal_min then
                raise exception 'Your order no longer qualifies for this promotion.';
            end if;
        end if;

        v_claimed_menu_item_id := nullif(v_item->>'menu_item_id', '')::uuid;

        if v_claimed_menu_item_id is null then
            raise exception 'Please choose a reward item for this promotion.';
        end if;

        if not exists (
            select 1 from public.promotion_reward_items
            where promotion_id = v_promo.id and menu_item_id = v_claimed_menu_item_id
        ) then
            raise exception 'That reward item is not part of this promotion.';
        end if;

        select item_name into v_claimed_name
        from public.resolve_purchasable_standard_item(v_claimed_menu_item_id);

        if not found then
            raise exception 'Your chosen reward item is no longer available. Please choose another.';
        end if;

        -- Per-order cap, tracked locally since one order can legally
        -- claim the same promotion more than once only if
        -- max_redemptions_per_order allows it (always 1 for the
        -- launch promo).
        v_claims_so_far := coalesce((v_promo_claim_counts->>v_promo.id::text)::integer, 0);
        if v_claims_so_far >= v_promo.max_redemptions_per_order then
            raise exception 'This promotion can only be claimed once per order.';
        end if;
        v_promo_claim_counts := jsonb_set(v_promo_claim_counts, array[v_promo.id::text], to_jsonb(v_claims_so_far + 1));

        -- Per-customer cap (best-effort against concurrent duplicate
        -- submissions from the same customer -- a soft marketing
        -- limit, not an inventory-integrity one; the hard,
        -- concurrency-safe guarantees are the redemption_count
        -- conditional UPDATE below and the stock engine itself).
        if v_promo.max_redemptions_per_customer is not null then
            select count(*) into v_customer_redemption_count
            from public.promotion_redemptions
            where promotion_id = v_promo.id and customer_email = p_customer_email;

            if v_customer_redemption_count >= v_promo.max_redemptions_per_customer then
                raise exception 'You have already redeemed this promotion the maximum number of times.';
            end if;
        end if;

        -- Total-redemption cap: the same conditional-UPDATE oversell
        -- guard reconcile_order_stock() uses for menu_item_stock,
        -- applied here to a redemption counter instead of a unit
        -- count. Only one of two concurrent "last redemption" orders
        -- can win this race.
        update public.promotions
        set redemption_count = redemption_count + 1
        where id = v_promo.id
          and (max_total_redemptions is null or redemption_count < max_total_redemptions)
        returning redemption_count into v_new_redemption_count;

        if not found then
            raise exception 'This promotion has reached its redemption limit.';
        end if;

        v_reward_quantity := coalesce(v_promo.free_item_quantity, 1);

        v_validated_items := v_validated_items || jsonb_build_array(jsonb_build_object(
            'menu_item_id', v_claimed_menu_item_id::text,
            'item_name', v_claimed_name,
            'quantity', v_reward_quantity,
            'price_at_purchase', 0,
            'line_total', 0,
            'builder_details', null,
            '_promo_redemption', jsonb_build_object(
                'promotion_id', v_promo.id,
                'promotion_name_snapshot', v_promo.internal_name,
                'promotion_type_snapshot', v_promo.promotion_type,
                'threshold_snapshot', jsonb_build_object(
                    'qualifying_subtotal_min', v_promo.qualifying_subtotal_min,
                    'threshold_operator', v_promo.threshold_operator,
                    'paid_subtotal_at_claim', v_computed_subtotal
                ),
                'reward_snapshot', jsonb_build_object(
                    'menu_item_id', v_claimed_menu_item_id,
                    'menu_item_name', v_claimed_name,
                    'quantity', v_reward_quantity
                )
            )
        ));
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
        -- subtotal is the paid-only amount computed in phase 1 -- a
        -- promo line already contributes 0 even if included, but
        -- using v_computed_subtotal explicitly (rather than summing
        -- v_validated_items again) keeps "subtotal means what the
        -- customer paid for" unambiguous.
        p_notes, v_computed_subtotal, 'pending'
    ) returning * into v_order;

    for v_item in select * from jsonb_array_elements(v_validated_items)
    loop
        declare
            v_new_order_item_id uuid;
            v_redemption_id uuid;
        begin
            -- Each single-row insert is its own statement, so
            -- trg_reconcile_stock_after_order_items_insert fires after
            -- every one of them -- cumulative and self-healing (it always
            -- reads the full current order_items for this order), and if
            -- any one of them can't be reserved (insufficient stock), the
            -- RAISE EXCEPTION it throws rolls back this entire function,
            -- including the orders row just inserted above and every
            -- order_items row inserted by an earlier iteration of this
            -- loop. No partial order is ever left behind. This applies
            -- identically to a promo-reward line, since it carries the
            -- same real menu_item_id a paid unit of that cookie would --
            -- the stock engine cannot tell, and does not need to tell,
            -- the two apart.
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
            )
            returning id into v_new_order_item_id;

            if v_item ? '_promo_redemption' then
                insert into public.promotion_redemptions (
                    order_id, promotion_id, promotion_name_snapshot, promotion_type_snapshot,
                    threshold_snapshot, reward_snapshot, discount_amount, customer_email
                ) values (
                    v_order.id,
                    (v_item->'_promo_redemption'->>'promotion_id')::uuid,
                    v_item->'_promo_redemption'->>'promotion_name_snapshot',
                    v_item->'_promo_redemption'->>'promotion_type_snapshot',
                    v_item->'_promo_redemption'->'threshold_snapshot',
                    v_item->'_promo_redemption'->'reward_snapshot',
                    null,
                    p_customer_email
                )
                returning id into v_redemption_id;

                update public.order_items
                set promotion_redemption_id = v_redemption_id
                where id = v_new_order_item_id;
            end if;
        end;
    end loop;

    return v_order;
end;
$$;

-- ---------------------------------------------------------------
-- admin_reconcile_order_promotions: companion to the existing
-- admin_replace_order_items RPC. Called as a SECOND RPC from the
-- admin order editor's save action (not folded into
-- admin_replace_order_items itself, whose contract is deliberately
-- generic/dumb and shouldn't grow promotion-specific business
-- rules). Reconciles promotion_redemptions rows against an order the
-- admin has just edited: adds new claims (re-running the same
-- eligibility logic submit_order uses, against the order's
-- POST-EDIT state) and/or removes redemptions the admin has deleted
-- the corresponding free line for.
-- ---------------------------------------------------------------
create or replace function public.admin_reconcile_order_promotions(
    p_order_id uuid,
    p_add_promotion_claims jsonb default '[]'::jsonb,
    p_remove_redemption_ids uuid[] default '{}'::uuid[]
) returns setof public.promotion_redemptions
language plpgsql
security definer
set search_path to 'public'
as $$
declare
    v_order public.orders;
    v_paid_subtotal numeric;
    v_claim jsonb;
    v_promo public.promotions;
    v_claimed_menu_item_id uuid;
    v_claimed_name text;
    v_reward_quantity integer;
    v_redemption_id uuid;
    v_new_order_item_id uuid;
    v_remove_id uuid;
    v_new_redemption_count integer;
begin
    if not is_admin() then
        raise exception 'Admins only.';
    end if;

    select * into v_order from public.orders where id = p_order_id;
    if not found then
        raise exception 'Order not found.';
    end if;

    -- Removals first: delete the order_items row(s) linked to each
    -- redemption, then the redemption row itself. Deleting the
    -- order_items row fires the existing stock-release trigger
    -- naturally, exactly like any other order-edit removal.
    foreach v_remove_id in array p_remove_redemption_ids
    loop
        delete from public.order_items where promotion_redemption_id = v_remove_id;
        delete from public.promotion_redemptions where id = v_remove_id and order_id = p_order_id;
    end loop;

    -- Paid-only subtotal, recomputed from the order's current (post-
    -- edit, post-removal) order_items -- never trusted from the
    -- client, same posture as submit_order.
    select coalesce(sum(line_total), 0) into v_paid_subtotal
    from public.order_items
    where order_id = p_order_id and promotion_redemption_id is null;

    for v_claim in select * from jsonb_array_elements(coalesce(p_add_promotion_claims, '[]'::jsonb))
    loop
        select * into v_promo
        from public.promotions
        where id = (v_claim->>'promotion_id')::uuid
        for update;

        if not found then
            raise exception 'Promotion not found.';
        end if;

        if v_promo.admin_status <> 'enabled' then
            raise exception 'This promotion is not currently enabled.';
        end if;

        if v_promo.promotion_type <> 'free_item' then
            raise exception 'This promotion cannot be claimed this way.';
        end if;

        if v_promo.threshold_operator = 'gte' then
            if v_paid_subtotal < v_promo.qualifying_subtotal_min then
                raise exception 'This order does not qualify for this promotion.';
            end if;
        else
            if v_paid_subtotal <= v_promo.qualifying_subtotal_min then
                raise exception 'This order does not qualify for this promotion.';
            end if;
        end if;

        v_claimed_menu_item_id := (v_claim->>'menu_item_id')::uuid;

        if not exists (
            select 1 from public.promotion_reward_items
            where promotion_id = v_promo.id and menu_item_id = v_claimed_menu_item_id
        ) then
            raise exception 'That reward item is not part of this promotion.';
        end if;

        select item_name into v_claimed_name
        from public.resolve_purchasable_standard_item(v_claimed_menu_item_id);

        if not found then
            raise exception 'That reward item is no longer available.';
        end if;

        update public.promotions
        set redemption_count = redemption_count + 1
        where id = v_promo.id
          and (max_total_redemptions is null or redemption_count < max_total_redemptions)
        returning redemption_count into v_new_redemption_count;

        if not found then
            raise exception 'This promotion has reached its redemption limit.';
        end if;

        v_reward_quantity := coalesce(v_promo.free_item_quantity, 1);

        insert into public.order_items (
            order_id, menu_item_id, item_name, quantity, price_at_purchase, line_total, builder_details
        ) values (
            p_order_id, v_claimed_menu_item_id, v_claimed_name, v_reward_quantity, 0, 0, null
        )
        returning id into v_new_order_item_id;

        insert into public.promotion_redemptions (
            order_id, promotion_id, promotion_name_snapshot, promotion_type_snapshot,
            threshold_snapshot, reward_snapshot, discount_amount, customer_email
        ) values (
            p_order_id, v_promo.id, v_promo.internal_name, v_promo.promotion_type,
            jsonb_build_object(
                'qualifying_subtotal_min', v_promo.qualifying_subtotal_min,
                'threshold_operator', v_promo.threshold_operator,
                'paid_subtotal_at_claim', v_paid_subtotal
            ),
            jsonb_build_object(
                'menu_item_id', v_claimed_menu_item_id,
                'menu_item_name', v_claimed_name,
                'quantity', v_reward_quantity
            ),
            null,
            v_order.customer_email
        )
        returning id into v_redemption_id;

        update public.order_items set promotion_redemption_id = v_redemption_id where id = v_new_order_item_id;
    end loop;

    return query select * from public.promotion_redemptions where order_id = p_order_id;
end;
$$;

revoke all on function public.admin_reconcile_order_promotions(uuid, jsonb, uuid[]) from public;
grant execute on function public.admin_reconcile_order_promotions(uuid, jsonb, uuid[]) to authenticated;

commit;
