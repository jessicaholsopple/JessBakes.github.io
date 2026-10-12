-- ============================================================
-- admin_replace_order_items(): the one new RPC needed on the admin
-- side of this feature.
--
-- js/admin-orders.js's manual order editor (saveManualOrder()) today
-- replaces an order's items as two separate, non-atomic REST calls:
-- `order_items.delete()` then `order_items.insert()`. Each is its own
-- transaction, so the finished-stock triggers (previous migration)
-- would correctly reconcile each step on its own, but NOT atomically
-- as one edit -- a failure on the insert half (e.g. the new quantity
-- exceeds what's now available) would leave the delete's release
-- already committed, with no items re-inserted at all.
--
-- This RPC wraps both statements in one transaction. The SAME
-- statement-level triggers from the previous migration fire for the
-- DELETE and the INSERT inside it exactly as they would outside it --
-- nothing stock-specific is duplicated here. If the insert half's
-- trigger raises (insufficient stock for the new quantities), the
-- whole RPC rolls back, so the delete half is undone too and the
-- order's items are left completely unchanged. This is what makes
-- "atomically reconcile the difference between old and new
-- quantities" true: the admin can freely increase a line up to
-- whatever becomes available once their OWN old reservation is
-- released in the same transaction, and any shortfall rejects the
-- whole edit cleanly.
--
-- Pricing, Mix & Match composition, and the BUG-02/BUG-22 guards are
-- completely unchanged -- this RPC only replaces the mechanics of
-- "write these order_items rows for this order," not what rows
-- js/order-editor.js builds or how admin-orders.js validates them
-- first.
-- ============================================================
begin;

create or replace function public.admin_replace_order_items(
  p_order_id uuid,
  p_items jsonb
)
returns setof public.order_items
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not is_admin() then
    raise exception 'Only an admin can edit order items.';
  end if;

  if not exists (select 1 from public.orders where id = p_order_id) then
    raise exception 'Order not found.';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Items must be a JSON array.';
  end if;

  delete from public.order_items where order_id = p_order_id;

  insert into public.order_items (
    order_id, menu_item_id, item_name, quantity, price_at_purchase, line_total, builder_details
  )
  select
    p_order_id,
    x.menu_item_id,
    x.item_name,
    x.quantity,
    x.price_at_purchase,
    x.line_total,
    x.builder_details
  from jsonb_to_recordset(p_items) as x(
    menu_item_id uuid,
    item_name text,
    quantity integer,
    price_at_purchase numeric,
    line_total numeric,
    builder_details jsonb
  );

  return query select * from public.order_items where order_id = p_order_id;
end;
$$;

revoke execute on function public.admin_replace_order_items(uuid, jsonb) from public, anon;
grant execute on function public.admin_replace_order_items(uuid, jsonb) to authenticated;

commit;
