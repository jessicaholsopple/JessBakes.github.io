-- Rollback for 20261012123000_finished_stock_admin_rpcs.sql
--
-- Drops the two admin stock-adjustment RPCs. Does not touch any
-- stock data already recorded.
begin;

drop function if exists public.adjust_finished_stock(uuid, text, numeric, text);
drop function if exists public.set_menu_item_stock_mode(uuid, text, integer, text);

commit;
