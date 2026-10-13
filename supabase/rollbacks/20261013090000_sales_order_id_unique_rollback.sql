-- Rollback for 20261013090000_sales_order_id_unique.sql
--
-- Drops the partial unique index on sales.order_id, restoring the
-- prior (unconstrained) state. Only run this if the constraint itself
-- needs to be backed out -- it does not affect any data.
begin;

drop index if exists public.sales_order_id_unique;

commit;
