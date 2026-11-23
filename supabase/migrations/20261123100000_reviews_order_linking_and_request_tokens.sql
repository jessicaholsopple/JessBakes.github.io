-- ============================================================
-- Reworks the review flow around real completed orders:
--   * reviews gains order_id (one review per order, enforced by a
--     unique partial index), show_order_items (explicit customer
--     choice, default true), and order_items_snapshot (a SAFE
--     product-name/quantity/flavor-breakdown/promo-flag snapshot
--     captured at submission time -- never prices, never raw
--     order_items rows -- so later menu/order edits can never change
--     an already-submitted review).
--   * review_request_tokens: one-row-per-order, hash-only secure
--     token storage (same pattern as email_unsubscribe_tokens),
--     minted/re-minted at SEND time by the Edge Function (see
--     processOutbox.ts), never by this migration or any trigger --
--     consistent with the existing project rule that a raw token is
--     only ever generated right before the email that carries it.
--   * review_submission_attempts: a self-pruning rate-limit bucket
--     table, same shape as newsletter_signup_attempts, shared by the
--     new get-review-order/submit-review Edge Functions.
--   * email_outbox.email_type gains 'review_request', and
--     enqueue_order_status_email() gains a branch that enqueues it
--     exactly once per order the instant status transitions INTO
--     'completed' -- same ON CONFLICT DO NOTHING idempotency-key
--     guarantee as order_confirmed/order_cancelled, so a retried
--     completion, an Undo Completion, or a re-completion can never
--     create a second request email. The email send itself happens
--     later, out of band, in send-emails -- a failed/slow send can
--     never roll back the order status write that already committed.
--   * The pre-existing reviews RLS was looser than every other table
--     in this project ("Admins can update/delete reviews" used
--     USING (true) for ANY authenticated user, not is_admin()) --
--     tightened here to match the rest of the schema while this
--     table is already being touched.
--   * A public "Public can submit reviews" direct-insert policy
--     stays (the general, no-order-link review form still posts
--     straight to this table), but its WITH CHECK now forces
--     order_id/order_items_snapshot to NULL and show_order_items to
--     true/approved+featured to false on that path -- an order-linked
--     review can only ever be created by the submit-review Edge
--     Function (service-role, bypasses RLS, and only after validating
--     a real unexpired/unused token against a completed order).
--   * public_reviews: a SELECT-only view that is the sole public read
--     path going forward. It enforces show_order_items = false at the
--     database layer (nulling order_items_snapshot), not just in the
--     UI -- the raw `reviews` table's anon SELECT grant is revoked so
--     a client can no longer bypass that masking by querying the
--     table directly.
-- ============================================================
begin;

-- ---------------------------------------------------------------
-- 1) reviews: new columns.
-- ---------------------------------------------------------------
alter table public.reviews
  add column if not exists order_id uuid references public.orders(id) on delete set null,
  add column if not exists show_order_items boolean not null default true,
  add column if not exists order_items_snapshot jsonb;

-- One review per order, ever. Partial so legacy/general reviews
-- (order_id is null) are never constrained by each other.
create unique index if not exists reviews_order_id_unique_idx
  on public.reviews (order_id)
  where order_id is not null;

create index if not exists idx_reviews_order_id on public.reviews (order_id)
  where order_id is not null;

-- ---------------------------------------------------------------
-- 2) reviews RLS: tighten admin policies to is_admin() (matching
--    every other table in this schema), and scope the public
--    direct-insert path so it can never fabricate an order link.
-- ---------------------------------------------------------------
drop policy if exists "Admins can update reviews" on public.reviews;
create policy "Admins can update reviews" on public.reviews
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "admins can delete reviews" on public.reviews;
drop policy if exists "Admins can delete reviews" on public.reviews;
create policy "Admins can delete reviews" on public.reviews
  for delete to authenticated
  using (public.is_admin());

drop policy if exists "Admins can view all reviews" on public.reviews;
create policy "Admins can view all reviews" on public.reviews
  for select to authenticated
  using (public.is_admin());

drop policy if exists "Public can submit reviews" on public.reviews;
create policy "Public can submit reviews" on public.reviews
  for insert to anon, authenticated
  with check (
    order_id is null
    and order_items_snapshot is null
    and show_order_items = true
    and approved = false
    and featured = false
  );

-- The raw table is no longer a public read surface -- public_reviews
-- (below) is, so show_order_items = false is enforced server-side
-- regardless of what a client queries directly.
drop policy if exists "Public can view approved reviews" on public.reviews;
revoke select on public.reviews from anon;

-- ---------------------------------------------------------------
-- 3) public_reviews: the one public read path. Masks
--    order_items_snapshot to NULL whenever show_order_items is
--    false, and never exposes order_id, approved/featured flags, or
--    any other internal column.
-- ---------------------------------------------------------------
create or replace view public.public_reviews
  with (security_invoker = true)
as
select
  id,
  name as public_name,
  rating,
  review,
  product,
  case when show_order_items then order_items_snapshot else null end as order_items_snapshot,
  created_at
from public.reviews
where approved = true;

grant select on public.public_reviews to anon, authenticated;

-- ---------------------------------------------------------------
-- 4) review_request_tokens: one row per order (unique), hash-only.
--    Minted/re-minted only by the Edge Function right before a
--    review_request email is actually sent -- never a raw token
--    stored anywhere, never generated by SQL/triggers.
-- ---------------------------------------------------------------
create table if not exists public.review_request_tokens (
  token_hash text primary key,
  order_id uuid not null unique references public.orders(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_review_request_tokens_order on public.review_request_tokens (order_id);

alter table public.review_request_tokens enable row level security;
revoke all on public.review_request_tokens from anon, authenticated;

-- ---------------------------------------------------------------
-- 5) review_submission_attempts: self-pruning rate-limit bucket,
--    same shape/convention as newsletter_signup_attempts. Only ever
--    written/read by the service-role Edge Functions.
-- ---------------------------------------------------------------
create table if not exists public.review_submission_attempts (
  id uuid primary key default gen_random_uuid(),
  bucket_key text not null,
  attempted_at timestamptz not null default now()
);

create index if not exists idx_review_submission_attempts_bucket
  on public.review_submission_attempts (bucket_key, attempted_at);

alter table public.review_submission_attempts enable row level security;
revoke all on public.review_submission_attempts from anon, authenticated;

-- ---------------------------------------------------------------
-- 6) email_outbox: add the 'review_request' type.
-- ---------------------------------------------------------------
alter table public.email_outbox
  drop constraint if exists email_outbox_email_type_check;

alter table public.email_outbox
  add constraint email_outbox_email_type_check
  check (email_type = any (array[
    'order_received', 'order_confirmed', 'order_confirmed_resend',
    'order_cancelled', 'newsletter_welcome', 'weekly_menu',
    'admin_new_order', 'vacation_reopening', 'review_request'
  ]));

-- ---------------------------------------------------------------
-- 7) Enqueue a review_request on the pending/ready -> 'completed'
--    transition. ON CONFLICT DO NOTHING on the unique idempotency_key
--    (keyed only by order_id, matching every other order-lifecycle
--    email) means a retried completion click, an Undo Completion
--    followed by a re-completion, or any other repeat of this same
--    transition can never enqueue a second row -- exactly the same
--    guarantee order_confirmed/order_cancelled already rely on.
-- ---------------------------------------------------------------
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

  if new.status = 'completed' and (old.status is distinct from 'completed') then
    if new.customer_email is not null and btrim(new.customer_email) <> '' then
      insert into public.email_outbox (
        email_type, idempotency_key, recipient_email,
        recipient_ref_table, recipient_ref_id
      ) values (
        'review_request',
        'review_request:' || new.id::text,
        lower(btrim(new.customer_email)),
        'orders', new.id
      )
      on conflict (idempotency_key) do nothing;
    end if;
  end if;

  return new;
end;
$$;

commit;
