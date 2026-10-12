-- Rollback for 20261012121500_finished_stock_reconcile_triggers.sql
--
-- Drops the reservation/restoration triggers and their functions.
-- Does NOT touch menu_item_stock/order_item_reservations/
-- finished_stock_movements data (see the schema migration's own
-- rollback for that) or trg_enqueue_order_status_email / the email
-- system, which this migration never modified.
begin;

drop trigger if exists trg_orders_stock_before_delete on public.orders;
drop function if exists public.trg_release_stock_before_order_delete();

drop trigger if exists trg_orders_stock_after_status_change on public.orders;
drop function if exists public.trg_reconcile_stock_on_order_status_change();

drop trigger if exists trg_order_items_stock_after_delete on public.order_items;
drop function if exists public.trg_reconcile_stock_after_order_items_delete();

drop trigger if exists trg_order_items_stock_after_insert on public.order_items;
drop function if exists public.trg_reconcile_stock_after_order_items_insert();

drop function if exists public.reconcile_order_stock(uuid, text, boolean);

commit;
