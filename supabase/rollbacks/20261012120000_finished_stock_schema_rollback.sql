-- Rollback for 20261012120000_finished_stock_schema.sql
--
-- Drops all three new tables entirely, including every stock count,
-- reservation, and the full adjustment/audit history. Only run this
-- if the finished-product freezer stock feature itself needs to be
-- fully backed out -- this is destructive, not just a policy revert.
-- Does NOT touch menu_items, orders, order_items, or any ingredient/
-- production/recipe table.
begin;

drop table if exists public.finished_stock_movements;
drop table if exists public.order_item_reservations;

drop trigger if exists menu_item_stock_set_updated_at on public.menu_item_stock;
drop function if exists public.set_menu_item_stock_updated_at();
drop table if exists public.menu_item_stock;

commit;
