-- ============================================================
-- Public "Contact Me" form (new feature).
--
-- contact_messages is written ONLY by the contact-submit Edge
-- Function (service-role client, bypasses RLS) -- never directly by
-- anon. This mirrors the exact reasoning newsletter-subscribe already
-- established for subscribers/newsletter_signup_attempts: a narrowly-
-- scoped server-side function enforces honeypot/rate-limit/validation
-- no matter what the browser sends, and the table itself grants the
-- public role nothing at all, so there is no parallel direct-insert
-- path to secure later. is_read/is_resolved are two independent
-- booleans (not one status enum) so a message can be read-but-
-- unresolved, read-and-resolved, or (rare) resolved-without-having-
-- been-opened, without conflating "have I seen this" and "is this
-- done."
--
-- This is entirely separate from the order/email system: submitting
-- this form never touches orders, order_items, or email_outbox, and
-- never creates a subscriber.
-- ============================================================
begin;

create table if not exists public.contact_messages (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  order_reference text,
  message text not null,
  is_read boolean not null default false,
  is_resolved boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_contact_messages_created_at
  on public.contact_messages (created_at desc);
create index if not exists idx_contact_messages_is_read
  on public.contact_messages (is_read);

create or replace function public.set_contact_messages_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists contact_messages_set_updated_at on public.contact_messages;
create trigger contact_messages_set_updated_at
before update on public.contact_messages
for each row execute function public.set_contact_messages_updated_at();

alter table public.contact_messages enable row level security;
revoke all on public.contact_messages from anon;

drop policy if exists "Admins can view contact messages" on public.contact_messages;
create policy "Admins can view contact messages" on public.contact_messages
  for select to authenticated using (is_admin());
drop policy if exists "Admins can update contact messages" on public.contact_messages;
create policy "Admins can update contact messages" on public.contact_messages
  for update to authenticated using (is_admin()) with check (is_admin());
drop policy if exists "Admins can delete contact messages" on public.contact_messages;
create policy "Admins can delete contact messages" on public.contact_messages
  for delete to authenticated using (is_admin());
-- No insert policy at all, for anon OR authenticated: every row is
-- created by the contact-submit Edge Function's service-role client,
-- which bypasses RLS entirely. Even the admin dashboard never inserts
-- a contact_messages row directly.

-- ---------------------------------------------------------------
-- Rate-limit bucket for the contact form, same self-pruning
-- bucket-key pattern as newsletter_signup_attempts (see
-- 20260818121500_email_newsletter_rate_limits.sql) -- a dedicated
-- table rather than reusing that one, so the two forms' abuse
-- patterns/history stay independently inspectable.
-- ---------------------------------------------------------------

create table if not exists public.contact_message_attempts (
  id bigint generated always as identity primary key,
  bucket_key text not null,
  attempted_at timestamptz not null default now()
);

create index if not exists idx_contact_message_attempts_bucket
  on public.contact_message_attempts (bucket_key, attempted_at desc);

alter table public.contact_message_attempts enable row level security;
revoke all on public.contact_message_attempts from anon;

drop policy if exists "Admins can view contact message attempts" on public.contact_message_attempts;
create policy "Admins can view contact message attempts" on public.contact_message_attempts
  for select to authenticated using (is_admin());

commit;
