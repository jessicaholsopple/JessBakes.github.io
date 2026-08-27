-- ============================================================
-- Recognize the new 'vacation_reopening' campaign/email type,
-- following exactly the pattern already used to add 'admin_new_order'
-- in 20260819120000_admin_new_order_notification.sql: widen the two
-- check constraints, nothing else. Sending logic (Edge Functions,
-- idempotency keys, templates) is added in a later phase; this
-- migration only makes the schema able to hold such rows.
-- ============================================================
begin;

alter table public.email_campaigns drop constraint if exists email_campaigns_campaign_type_check;
alter table public.email_campaigns
  add constraint email_campaigns_campaign_type_check
  check (campaign_type in ('weekly_menu', 'vacation_reopening'));

alter table public.email_outbox drop constraint if exists email_outbox_email_type_check;
alter table public.email_outbox
  add constraint email_outbox_email_type_check
  check (email_type in (
    'order_received', 'order_confirmed', 'order_cancelled',
    'newsletter_welcome', 'weekly_menu', 'admin_new_order',
    'vacation_reopening'
  ));

commit;
