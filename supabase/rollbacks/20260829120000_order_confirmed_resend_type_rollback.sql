-- Rollback for 20260829120000_order_confirmed_resend_type.sql
-- Only safe to run if no email_outbox row uses 'order_confirmed_resend'.
begin;

alter table public.email_outbox
  drop constraint if exists email_outbox_email_type_check;

alter table public.email_outbox
  add constraint email_outbox_email_type_check
  check (email_type = any (array[
    'order_received', 'order_confirmed', 'order_cancelled',
    'newsletter_welcome', 'weekly_menu', 'admin_new_order',
    'vacation_reopening'
  ]));

commit;
