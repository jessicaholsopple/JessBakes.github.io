-- Rollback for 20260828150000_order_confirmation_payment_snapshot.sql
begin;

alter table public.orders
  drop column if exists confirmation_exchange_rate,
  drop column if exists confirmation_exchange_rate_date,
  drop column if exists confirmation_usd_amount;

commit;
