-- ============================================================
-- One-time resend of the updated order-confirmation email (adds the
-- Payment Options section) to real customer orders that were
-- confirmed before that feature existed.
--
-- Adds exactly one new email_outbox.email_type value,
-- 'order_confirmed_resend' -- a DISTINCT type from 'order_confirmed',
-- never a re-use of the original key, so this can never collide with
-- or double up on a customer's original confirmation email (see
-- supabase/functions/_shared/idempotency.mjs's orderConfirmedResendKey
-- and the accompanying processOutbox.ts/templates.mjs changes).
--
-- No other schema change. Idempotent (safe to re-run).
-- ============================================================
begin;

alter table public.email_outbox
  drop constraint if exists email_outbox_email_type_check;

alter table public.email_outbox
  add constraint email_outbox_email_type_check
  check (email_type = any (array[
    'order_received', 'order_confirmed', 'order_confirmed_resend',
    'order_cancelled', 'newsletter_welcome', 'weekly_menu',
    'admin_new_order', 'vacation_reopening'
  ]));

commit;
