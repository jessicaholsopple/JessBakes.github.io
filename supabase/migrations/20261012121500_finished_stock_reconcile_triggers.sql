-- ============================================================
-- Finished-stock reservation/restoration engine.
--
-- ONE function, reconcile_order_stock(), is the single source of
-- truth for "how much of each limited-stock item is reserved for this
-- order right now." It always recomputes from scratch: it reads the
-- order's CURRENT status and CURRENT order_items, decides what
-- SHOULD be reserved (nothing, if the order is cancelled or being
-- force-released; otherwise the sum of every limited item's
-- consumption), diffs that against order_item_reservations' CURRENT
-- value, and applies only the delta. Recomputing from scratch every
-- time is what makes this idempotent for free: calling it twice in a
-- row, confirming an already-confirmed order, or cancelling an
-- already-cancelled order always produces a zero delta and does
-- nothing -- there is no separate "have I already reserved/restored
-- this" flag to get out of sync.
--
-- Per-flavor consumption for a Mix & Match line uses the exact same
-- formula js/sale-calculations.js already proved out for the
-- identical ambiguity between a customer-submitted builder line
-- (quantity = box count, each selection's quantity is PER box) and an
-- admin-rebuilt one (quantity fixed at 1, each selection's quantity
-- already totaled across every box in builder_details.box_quantity):
-- selection.quantity * order_items.quantity. See that file's own
-- comment on parentQuantity/childQuantity for why this is correct
-- either way.
--
-- The actual overselling guard is the single conditional UPDATE
-- inside the per-item loop below: `set reserved_count = reserved_count
-- + delta where ... physical_count - reserved_count >= delta`. Two
-- concurrent transactions both trying to reserve the last unit will
-- have their UPDATEs serialized by Postgres's normal row lock -- the
-- second one re-evaluates the WHERE clause against the first's
-- already-committed (or rolled-back) result, so only one can ever
-- succeed. Hitting zero rows raises, which rolls back the ENTIRE
-- calling transaction (the order, every order_items row, and any
-- other reservation already applied earlier in the same loop) -- not
-- just this one item.
--
-- Triggers below call this after every order_items insert/delete
-- (statement-level, via transition tables, so one multi-row submit_order
-- or one admin edit's delete-then-insert each reconcile correctly) and
-- after every orders.status change, plus a BEFORE DELETE trigger on
-- orders that force-releases everything regardless of status (since
-- the order is about to disappear). This means submit_order, the
-- existing updateOrderStatus()/deleteOrder() flows in
-- js/admin-orders.js, and the new admin_replace_order_items() RPC
-- (later migration) all get correct reservation/restoration with NO
-- changes to their own logic -- the database enforces it underneath.
-- ============================================================
begin;

create or replace function public.reconcile_order_stock(
  p_order_id uuid,
  p_default_source text default 'order_reservation',
  p_force_release boolean default false
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_is_cancelled boolean;
  v_source text;
  v_row record;
  v_delta integer;
  v_stock record;
  v_prev_available integer;
  v_new_available integer;
begin
  select status into v_status from public.orders where id = p_order_id;

  -- The order may legitimately no longer exist (e.g. the cascade-
  -- triggered order_items delete that happens AFTER orders' own
  -- BEFORE DELETE trigger already force-released everything). A safe
  -- no-op, not an error.
  if not found and not p_force_release then
    return;
  end if;

  v_is_cancelled := p_force_release or (v_status = 'cancelled');
  v_source := case
    when p_force_release then 'order_deletion'
    when v_is_cancelled then 'order_cancellation'
    else p_default_source
  end;

  for v_row in
    with order_lines as (
      select menu_item_id, quantity, builder_details
      from public.order_items
      where order_id = p_order_id
    ),
    standard_consumption as (
      select ol.menu_item_id, ol.quantity::integer as qty
      from order_lines ol
      where ol.menu_item_id is not null
    ),
    builder_consumption as (
      select (sel->>'id')::uuid as menu_item_id,
             (coalesce((sel->>'quantity')::integer, 0) * ol.quantity)::integer as qty
      from order_lines ol
      cross join lateral jsonb_array_elements(
        case
          when jsonb_typeof(coalesce(ol.builder_details, '{}'::jsonb)->'selections') = 'array'
          then coalesce(ol.builder_details, '{}'::jsonb)->'selections'
          else '[]'::jsonb
        end
      ) as sel
      where ol.menu_item_id is null
        and coalesce(sel->>'id', '') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    ),
    required as (
      select ac.menu_item_id, sum(ac.qty)::integer as required_qty
      from (
        select * from standard_consumption
        union all
        select * from builder_consumption
      ) ac
      join public.menu_item_stock ms
        on ms.menu_item_id = ac.menu_item_id and ms.stock_mode = 'limited'
      group by ac.menu_item_id
    ),
    reserved as (
      select menu_item_id, reserved_qty
      from public.order_item_reservations
      where order_id = p_order_id
    )
    select
      coalesce(req.menu_item_id, res.menu_item_id) as menu_item_id,
      coalesce(res.reserved_qty, 0) as prev_reserved,
      case when v_is_cancelled then 0 else coalesce(req.required_qty, 0) end as new_reserved
    from required req
    full outer join reserved res on res.menu_item_id = req.menu_item_id
  loop
    v_delta := v_row.new_reserved - v_row.prev_reserved;

    if v_delta = 0 then
      continue;
    end if;

    if v_delta > 0 then
      update public.menu_item_stock
        set reserved_count = reserved_count + v_delta
        where menu_item_id = v_row.menu_item_id
          and coalesce(physical_count, 0) - reserved_count >= v_delta
        returning physical_count, reserved_count into v_stock;

      if not found then
        raise exception using
          errcode = 'P0001',
          message = format(
            'Sorry, %s no longer has enough stock remaining. Please update your cart and try again.',
            coalesce((select name from public.menu_items where id = v_row.menu_item_id), 'one of your items')
          );
      end if;
    else
      update public.menu_item_stock
        set reserved_count = reserved_count + v_delta
        where menu_item_id = v_row.menu_item_id
        returning physical_count, reserved_count into v_stock;
    end if;

    -- previous/new reflect AVAILABLE count (physical minus reserved,
    -- floored at zero) -- what the public and the admin history both
    -- actually see -- not the raw reserved_count.
    v_new_available := greatest(coalesce(v_stock.physical_count, 0) - v_stock.reserved_count, 0);
    v_prev_available := greatest(coalesce(v_stock.physical_count, 0) - (v_stock.reserved_count - v_delta), 0);

    insert into public.finished_stock_movements
      (menu_item_id, order_id, quantity_change, previous_count, new_count, reason, source)
    values
      (v_row.menu_item_id, p_order_id, -v_delta, v_prev_available, v_new_available,
       case when v_delta > 0 then 'Reserved by order' else 'Released from order' end,
       v_source);

    if v_row.new_reserved > 0 then
      insert into public.order_item_reservations (order_id, menu_item_id, reserved_qty)
      values (p_order_id, v_row.menu_item_id, v_row.new_reserved)
      on conflict (order_id, menu_item_id)
      do update set reserved_qty = excluded.reserved_qty, updated_at = now();
    else
      delete from public.order_item_reservations
      where order_id = p_order_id and menu_item_id = v_row.menu_item_id;
    end if;
  end loop;
end;
$$;

revoke execute on function public.reconcile_order_stock(uuid, text, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------
-- order_items triggers (statement-level, transition tables so a
-- multi-row insert/delete reconciles once per distinct order touched,
-- not once per row).
-- ---------------------------------------------------------------
create or replace function public.trg_reconcile_stock_after_order_items_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
begin
  for r in select distinct order_id from inserted_rows loop
    perform public.reconcile_order_stock(r.order_id, 'order_reservation');
  end loop;
  return null;
end;
$$;

revoke execute on function public.trg_reconcile_stock_after_order_items_insert() from public, anon, authenticated;

drop trigger if exists trg_order_items_stock_after_insert on public.order_items;
create trigger trg_order_items_stock_after_insert
after insert on public.order_items
referencing new table as inserted_rows
for each statement execute function public.trg_reconcile_stock_after_order_items_insert();

create or replace function public.trg_reconcile_stock_after_order_items_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
begin
  -- order_items is only ever deleted in bulk as half of an edit
  -- (js/admin-orders.js rebuilds a changed order's items by deleting
  -- all of them, then re-inserting the new set) or via the orders
  -- cascade below -- 'order_edit' is the correct label either way; if
  -- this is actually a cascade from an order being deleted outright,
  -- reconcile_order_stock() will find the order already gone and
  -- safely no-op (the real release already happened in the orders
  -- BEFORE DELETE trigger, which runs first).
  for r in select distinct order_id from deleted_rows loop
    perform public.reconcile_order_stock(r.order_id, 'order_edit');
  end loop;
  return null;
end;
$$;

revoke execute on function public.trg_reconcile_stock_after_order_items_delete() from public, anon, authenticated;

drop trigger if exists trg_order_items_stock_after_delete on public.order_items;
create trigger trg_order_items_stock_after_delete
after delete on public.order_items
referencing old table as deleted_rows
for each statement execute function public.trg_reconcile_stock_after_order_items_delete();

-- ---------------------------------------------------------------
-- orders triggers: status changes (confirm/ready/complete/cancel/
-- reopen) and the before-delete force-release. Entirely separate
-- trigger from the existing trg_enqueue_order_status_email -- Postgres
-- runs multiple triggers on the same event independently, so this
-- never touches that trigger or the email system it drives.
-- ---------------------------------------------------------------
create or replace function public.trg_reconcile_stock_on_order_status_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status is distinct from old.status then
    perform public.reconcile_order_stock(new.id, 'order_reservation');
  end if;
  return null;
end;
$$;

revoke execute on function public.trg_reconcile_stock_on_order_status_change() from public, anon, authenticated;

drop trigger if exists trg_orders_stock_after_status_change on public.orders;
create trigger trg_orders_stock_after_status_change
after update of status on public.orders
for each row execute function public.trg_reconcile_stock_on_order_status_change();

create or replace function public.trg_release_stock_before_order_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.reconcile_order_stock(old.id, 'order_deletion', true);
  return old;
end;
$$;

revoke execute on function public.trg_release_stock_before_order_delete() from public, anon, authenticated;

drop trigger if exists trg_orders_stock_before_delete on public.orders;
create trigger trg_orders_stock_before_delete
before delete on public.orders
for each row execute function public.trg_release_stock_before_order_delete();

commit;
