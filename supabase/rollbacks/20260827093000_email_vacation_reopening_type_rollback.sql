-- Deterministic rollback of 20260827093000_email_vacation_reopening_type.sql.
--
-- Any 'vacation_reopening' rows already in email_campaigns/email_outbox
-- would violate the narrowed constraints, so -- mirroring how
-- 20260819120000_admin_new_order_notification_rollback.sql handles
-- the same situation for 'admin_new_order' -- pending/unsent rows are
-- deleted and the constraint is restored to its prior set. Historical
-- sent/failed rows for a real, already-communicated campaign should
-- not exist at rollback time in practice (this rollback is only ever
-- meant to run if the feature is reverted before real use); if it
-- ever needs to run afterward, delete first is still the safer choice
-- over silently mis-typing sent history to fit a narrower constraint.
begin;

delete from public.email_outbox where email_type = 'vacation_reopening';
delete from public.email_campaigns where campaign_type = 'vacation_reopening';

alter table public.email_outbox drop constraint if exists email_outbox_email_type_check;
alter table public.email_outbox
  add constraint email_outbox_email_type_check
  check (email_type in (
    'order_received', 'order_confirmed', 'order_cancelled',
    'newsletter_welcome', 'weekly_menu', 'admin_new_order'
  ));

alter table public.email_campaigns drop constraint if exists email_campaigns_campaign_type_check;
alter table public.email_campaigns
  add constraint email_campaigns_campaign_type_check
  check (campaign_type in ('weekly_menu'));

commit;
