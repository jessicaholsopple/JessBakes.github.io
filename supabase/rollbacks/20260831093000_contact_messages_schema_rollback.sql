-- Rollback for 20260831093000_contact_messages_schema.sql
--
-- Drops both new tables entirely, including all submitted contact
-- messages and rate-limit history. Only run this if the Contact Me
-- feature itself needs to be fully backed out -- this is destructive,
-- not just a policy/function revert.
begin;

drop table if exists public.contact_message_attempts;

drop trigger if exists contact_messages_set_updated_at on public.contact_messages;
drop function if exists public.set_contact_messages_updated_at();
drop table if exists public.contact_messages;

commit;
