-- ============================================================
-- Order-confirmation email: adds a "Payment Options" section
-- (Cash/Zelle/PayPal/Venmo) to the existing order_confirmed email.
-- Customers never choose a payment method at checkout, so every
-- confirmation always shows all four options -- Cash stays in EUR,
-- the electronic methods show the same USD figure.
--
-- The EUR->USD rate and the resulting floored whole-dollar USD amount
-- must be SNAPSHOTTED at the moment an order is confirmed (mirroring
-- the existing sales.exchange_rate/usd_revenue snapshot pattern) so
-- that resending the same confirmation email later never shows a
-- different amount just because the live exchange rate moved on.
-- These three columns are that snapshot, written once by
-- js/admin-orders.js's updateOrderStatus() at the pending->confirmed
-- transition and read (never recomputed) by
-- supabase/functions/_shared/processOutbox.ts every time this email
-- is rendered, including on retry/resend.
--
-- Nullable and not backfilled: existing orders were confirmed before
-- this feature existed and their confirmation emails already sent --
-- there is no trustworthy rate to reconstruct for them, so they are
-- left as NULL rather than guessed (processOutbox.ts skips rendering
-- rather than sending a fabricated amount if these are ever null).
-- ============================================================
begin;

alter table public.orders
  add column if not exists confirmation_exchange_rate numeric,
  add column if not exists confirmation_exchange_rate_date date,
  add column if not exists confirmation_usd_amount integer;

commit;
