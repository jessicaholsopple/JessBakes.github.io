-- Rollback for 20261012130000_admin_replace_order_items_rpc.sql
--
-- Drops the RPC. NOTE: js/admin-orders.js's saveManualOrder() must be
-- reverted to its previous direct delete()+insert() order_items calls
-- BEFORE applying this rollback, or saving any order edit from the
-- admin dashboard will fail outright with "function does not exist."
begin;

drop function if exists public.admin_replace_order_items(uuid, jsonb);

commit;
