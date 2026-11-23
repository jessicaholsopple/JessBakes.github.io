-- Rollback for 20261123100000_reviews_order_linking_and_request_tokens.sql
-- Only safe to run if no email_outbox row uses 'review_request' and no
-- review has order_id/order_items_snapshot set that must be preserved.
begin;

create or replace function public.enqueue_order_status_email()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'confirmed' and (old.status is distinct from 'confirmed') then
    if new.customer_email is not null and btrim(new.customer_email) <> '' then
      insert into public.email_outbox (
        email_type, idempotency_key, recipient_email,
        recipient_ref_table, recipient_ref_id
      ) values (
        'order_confirmed',
        'order_confirmed:' || new.id::text,
        lower(btrim(new.customer_email)),
        'orders', new.id
      )
      on conflict (idempotency_key) do nothing;
    end if;
  end if;

  if new.status = 'cancelled' and (old.status is distinct from 'cancelled') then
    if new.customer_email is not null and btrim(new.customer_email) <> '' then
      insert into public.email_outbox (
        email_type, idempotency_key, recipient_email,
        recipient_ref_table, recipient_ref_id
      ) values (
        'order_cancelled',
        'order_cancelled:' || new.id::text,
        lower(btrim(new.customer_email)),
        'orders', new.id
      )
      on conflict (idempotency_key) do nothing;
    end if;
  end if;

  return new;
end;
$$;

alter table public.email_outbox
  drop constraint if exists email_outbox_email_type_check;

alter table public.email_outbox
  add constraint email_outbox_email_type_check
  check (email_type = any (array[
    'order_received', 'order_confirmed', 'order_confirmed_resend',
    'order_cancelled', 'newsletter_welcome', 'weekly_menu',
    'admin_new_order', 'vacation_reopening'
  ]));

drop table if exists public.review_submission_attempts;
drop table if exists public.review_request_tokens;

drop view if exists public.public_reviews;

drop policy if exists "Public can submit reviews" on public.reviews;
create policy "Public can submit reviews" on public.reviews
  for insert to public
  with check (true);

drop policy if exists "Admins can update reviews" on public.reviews;
create policy "Admins can update reviews" on public.reviews
  for update to authenticated
  using (true)
  with check (true);

drop policy if exists "Admins can delete reviews" on public.reviews;
create policy "admins can delete reviews" on public.reviews
  for delete to authenticated
  using (true);

drop policy if exists "Admins can view all reviews" on public.reviews;
create policy "Admins can view all reviews" on public.reviews
  for select to authenticated
  using (true);

create policy "Public can view approved reviews" on public.reviews
  for select to anon
  using (approved = true);

grant select on public.reviews to anon;

drop index if exists public.reviews_order_id_unique_idx;
drop index if exists public.idx_reviews_order_id;

alter table public.reviews
  drop column if exists order_items_snapshot,
  drop column if exists show_order_items,
  drop column if exists order_id;

commit;
