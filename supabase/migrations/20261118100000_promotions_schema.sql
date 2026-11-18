-- ============================================================
-- Reusable promotions engine (new feature) -- schema only.
--
-- This migration is deliberately inert: it adds new, empty,
-- RLS-locked tables/views/functions and one new nullable column on
-- order_items. Nothing here changes submit_order, the cart, or any
-- existing order/stock/revenue behavior -- see the separate
-- <ts>_submit_order_promotions_aware.sql migration for the actual
-- behavioral change that lets a checkout claim a promotion. Splitting
-- these two migrations lets the schema + admin UI be exercised and
-- verified before the riskier live order-submission change ships.
--
-- Design constraint this schema is built around: a "free item"
-- reward must be a REAL, already-sold menu_items row (e.g. the same
-- Brown Butter Sea Salt Chocolate Chip cookie sold for money), never
-- a duplicate zero-price SKU -- so a promotional unit automatically
-- reserves/competes for the exact same menu_item_stock pool as a
-- paid unit of that cookie via the existing reconcile_order_stock()
-- engine, with zero changes to that engine. promotion_reward_items
-- below stores real menu_items.id values for exactly this reason.
--
-- Status model: admins only ever set `admin_status` (draft / enabled
-- / paused / archived). The six customer/admin-facing statuses
-- (Draft, Scheduled, Active, Paused, Expired, Archived) are DERIVED
-- from admin_status + start_at/end_at vs now() by the single
-- promotion_display_status() function below -- never duplicated in
-- JS, so there is exactly one place "is this active" logic lives.
-- ============================================================
begin;

-- ---------------------------------------------------------------
-- promotions: the definition. One row per promotion, covering all
-- three supported types (free_item is the only one launching active;
-- percentage_discount/fixed_discount are scaffolded now so the admin
-- UI and engine are genuinely reusable, per the owner's request, not
-- a one-off free-cookie hack).
-- ---------------------------------------------------------------
create table if not exists public.promotions (
  id uuid primary key default gen_random_uuid(),

  internal_name text not null,
  customer_title text not null,
  customer_description text,
  cart_message text,
  internal_notes text,

  promotion_type text not null
    check (promotion_type in ('free_item', 'percentage_discount', 'fixed_discount')),

  -- The only status an admin ever sets directly. See
  -- promotion_display_status() for how this becomes one of six
  -- customer/admin-facing statuses.
  admin_status text not null default 'draft'
    check (admin_status in ('draft', 'enabled', 'paused', 'archived')),

  -- Absolute instants (not wall-clock-local) -- the admin UI converts
  -- a Europe/Berlin local date/time input to UTC at save time (see
  -- supabase/functions/_shared/themeSchedule.mjs for the established
  -- DST-safe conversion pattern this reuses); every later comparison
  -- here and in submit_order is then a plain UTC-instant comparison.
  start_at timestamptz,
  end_at timestamptz,

  application_mode text not null default 'automatic'
    check (application_mode in ('automatic', 'code')),
  promo_code text,

  priority integer not null default 100,
  stackable boolean not null default false,

  qualifying_subtotal_min numeric(10,2),
  threshold_operator text not null default 'gt'
    check (threshold_operator in ('gt', 'gte')),

  max_total_redemptions integer
    check (max_total_redemptions is null or max_total_redemptions > 0),
  max_redemptions_per_order integer not null default 1
    check (max_redemptions_per_order > 0),
  max_redemptions_per_customer integer
    check (max_redemptions_per_customer is null or max_redemptions_per_customer > 0),

  -- Concurrency-safe running counter, incremented by a conditional
  -- UPDATE ... WHERE redemption_count < max_total_redemptions inside
  -- submit_order -- the exact same oversell-guard idiom
  -- reconcile_order_stock() already uses for menu_item_stock, applied
  -- here to redemption caps instead of unit counts.
  redemption_count integer not null default 0
    check (redemption_count >= 0),

  -- free_item fields
  free_item_quantity integer,
  free_item_customer_chooses boolean not null default true,
  free_item_max_per_order integer,
  free_item_repeats_at_multiples boolean not null default false,

  -- percentage_discount fields
  discount_percentage numeric(5,2)
    check (discount_percentage is null or (discount_percentage > 0 and discount_percentage <= 100)),
  discount_max_amount numeric(10,2)
    check (discount_max_amount is null or discount_max_amount > 0),
  discount_applies_to text
    check (discount_applies_to is null or discount_applies_to in ('order_subtotal', 'eligible_items_only')),

  -- fixed_discount fields
  fixed_discount_amount numeric(10,2)
    check (fixed_discount_amount is null or fixed_discount_amount > 0),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),

  constraint promotions_schedule_order
    check (start_at is null or end_at is null or start_at < end_at),
  constraint promotions_free_item_requires_quantity
    check (promotion_type <> 'free_item' or (free_item_quantity is not null and free_item_quantity > 0)),
  constraint promotions_percentage_requires_value
    check (promotion_type <> 'percentage_discount' or discount_percentage is not null),
  constraint promotions_fixed_requires_amount
    check (promotion_type <> 'fixed_discount' or fixed_discount_amount is not null)
);

create index if not exists idx_promotions_admin_status on public.promotions (admin_status);
create unique index if not exists idx_promotions_promo_code on public.promotions (promo_code) where promo_code is not null;

create or replace function public.set_promotions_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists promotions_set_updated_at on public.promotions;
create trigger promotions_set_updated_at
before update on public.promotions
for each row execute function public.set_promotions_updated_at();

-- ---------------------------------------------------------------
-- Activation guard: fires whenever a row transitions INTO
-- admin_status = 'enabled' (including on insert). This is the
-- server-side backstop behind whatever pre-activation checks the
-- admin UI itself runs -- "an invalid or incomplete promotion cannot
-- be activated" holds even against a direct SQL/API write.
-- ---------------------------------------------------------------
create or replace function public.validate_promotion_activation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_available_reward_count integer;
begin
  if new.admin_status = 'enabled' and (old.admin_status is distinct from 'enabled') then
    if new.start_at is not null and new.end_at is not null and new.start_at >= new.end_at then
      raise exception 'Start date must be before end date.';
    end if;

    if new.promotion_type = 'free_item' then
      if new.qualifying_subtotal_min is null or new.qualifying_subtotal_min <= 0 then
        raise exception 'A free-item promotion needs a qualifying subtotal greater than zero.';
      end if;

      select count(*) into v_available_reward_count
      from public.promotion_reward_items pri
      join public.menu_items m on m.id = pri.menu_item_id
      where pri.promotion_id = new.id and m.available = true;

      if v_available_reward_count = 0 then
        raise exception 'This promotion has no available reward items selected.';
      end if;
    elsif new.promotion_type = 'percentage_discount' then
      if new.qualifying_subtotal_min is null or new.qualifying_subtotal_min < 0 then
        raise exception 'A percentage discount needs a valid qualifying subtotal.';
      end if;
    elsif new.promotion_type = 'fixed_discount' then
      if new.qualifying_subtotal_min is null or new.qualifying_subtotal_min < 0 then
        raise exception 'A fixed discount needs a valid qualifying subtotal.';
      end if;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists promotions_validate_activation on public.promotions;
create trigger promotions_validate_activation
before insert or update on public.promotions
for each row execute function public.validate_promotion_activation();

alter table public.promotions enable row level security;
revoke all on public.promotions from anon;

drop policy if exists "Admins can manage promotions" on public.promotions;
create policy "Admins can manage promotions" on public.promotions
  for all to authenticated using (is_admin()) with check (is_admin());
-- No anon policy at all: public access goes exclusively through the
-- public_active_promotions view below, which exposes only
-- customer-safe columns for rows that are genuinely live right now.

-- ---------------------------------------------------------------
-- promotion_reward_items: which real menu_items a free_item
-- promotion may hand out. menu_item_id is a real, already-sold
-- product id -- see the header comment on why this is load-bearing
-- for shared stock.
-- ---------------------------------------------------------------
create table if not exists public.promotion_reward_items (
  id uuid primary key default gen_random_uuid(),
  promotion_id uuid not null references public.promotions(id) on delete cascade,
  menu_item_id uuid not null references public.menu_items(id),
  sort_order integer not null default 0,
  unique (promotion_id, menu_item_id)
);

create index if not exists idx_promotion_reward_items_promotion on public.promotion_reward_items (promotion_id);

alter table public.promotion_reward_items enable row level security;
revoke all on public.promotion_reward_items from anon;

drop policy if exists "Admins can manage promotion reward items" on public.promotion_reward_items;
create policy "Admins can manage promotion reward items" on public.promotion_reward_items
  for all to authenticated using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------
-- promotion_eligible_items / promotion_eligible_categories: optional
-- scoping of what counts toward a promotion's qualifying subtotal, or
-- what a percentage/fixed discount applies to. An EMPTY set for a
-- promotion means "applies to everything" -- this is the documented
-- default and exactly what the free-cookie launch promo uses (whole
-- order subtotal, no scoping rows at all). Admin-only for now: no
-- public exposure, since nothing customer-facing needs to read these
-- until a scoped percentage/fixed-discount promotion actually goes
-- live (add a public_* view at that point, mirroring
-- public_active_promotions below, rather than exposing unused rows
-- for every draft promotion today).
-- ---------------------------------------------------------------
create table if not exists public.promotion_eligible_items (
  id uuid primary key default gen_random_uuid(),
  promotion_id uuid not null references public.promotions(id) on delete cascade,
  menu_item_id uuid not null references public.menu_items(id),
  is_excluded boolean not null default false,
  unique (promotion_id, menu_item_id)
);

create index if not exists idx_promotion_eligible_items_promotion on public.promotion_eligible_items (promotion_id);

alter table public.promotion_eligible_items enable row level security;
revoke all on public.promotion_eligible_items from anon;

drop policy if exists "Admins can manage promotion eligible items" on public.promotion_eligible_items;
create policy "Admins can manage promotion eligible items" on public.promotion_eligible_items
  for all to authenticated using (is_admin()) with check (is_admin());

create table if not exists public.promotion_eligible_categories (
  id uuid primary key default gen_random_uuid(),
  promotion_id uuid not null references public.promotions(id) on delete cascade,
  category text not null,
  is_excluded boolean not null default false,
  unique (promotion_id, category)
);

create index if not exists idx_promotion_eligible_categories_promotion on public.promotion_eligible_categories (promotion_id);

alter table public.promotion_eligible_categories enable row level security;
revoke all on public.promotion_eligible_categories from anon;

drop policy if exists "Admins can manage promotion eligible categories" on public.promotion_eligible_categories;
create policy "Admins can manage promotion eligible categories" on public.promotion_eligible_categories
  for all to authenticated using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------
-- promotion_redemptions: immutable audit/snapshot row, one per
-- order+promotion. This is the single source of truth for "was this
-- promotion actually applied to this order" -- independent of
-- whatever order_items rows exist -- and is never overwritten by a
-- later edit to the promotion definition (editing promotions.* has
-- no effect on historical snapshot_* columns here). Only ever
-- written by security-definer functions (submit_order,
-- admin_reconcile_order_promotions -- see the next migration), never
-- directly by any client, same posture as order_item_reservations.
-- ---------------------------------------------------------------
create table if not exists public.promotion_redemptions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  promotion_id uuid not null references public.promotions(id),

  promotion_name_snapshot text not null,
  promotion_type_snapshot text not null,
  threshold_snapshot jsonb not null default '{}'::jsonb,
  reward_snapshot jsonb,
  discount_amount numeric(10,2),

  customer_email text,
  applied_at timestamptz not null default now(),

  unique (order_id, promotion_id)
);

create index if not exists idx_promotion_redemptions_promotion on public.promotion_redemptions (promotion_id);
create index if not exists idx_promotion_redemptions_customer_email on public.promotion_redemptions (promotion_id, customer_email);

alter table public.promotion_redemptions enable row level security;
revoke all on public.promotion_redemptions from anon;
revoke all on public.promotion_redemptions from authenticated;

drop policy if exists "Admins can view promotion redemptions" on public.promotion_redemptions;
create policy "Admins can view promotion redemptions" on public.promotion_redemptions
  for select to authenticated using (is_admin());
-- No insert/update/delete policy for anyone, admin included: every
-- row is written by a security-definer function that bypasses RLS,
-- exactly like finished_stock_movements/order_item_reservations.

-- ---------------------------------------------------------------
-- order_items gets one new nullable column: an explicit discriminator
-- for "this line is a promotional reward", rather than inferring it
-- from price_at_purchase = 0 (which could in principle describe some
-- other, non-promotional free line in the future). Email rendering,
-- the admin order editor, and reporting all join through this column
-- back to the full immutable snapshot in promotion_redemptions.
-- ---------------------------------------------------------------
alter table public.order_items
  add column if not exists promotion_redemption_id uuid references public.promotion_redemptions(id) on delete set null;

create index if not exists idx_order_items_promotion_redemption on public.order_items (promotion_redemption_id) where promotion_redemption_id is not null;

-- ---------------------------------------------------------------
-- promotion_display_status: the single place the six display
-- statuses (Draft/Scheduled/Active/Paused/Expired/Archived) are
-- derived. Takes a whole-row parameter so PostgREST exposes it as a
-- computed column (e.g. select=*,promotion_display_status) -- the
-- admin UI only ever reads this value, never reimplements the logic.
-- ---------------------------------------------------------------
create or replace function public.promotion_display_status(p public.promotions)
returns text
language sql
stable
as $$
  select case
    when p.admin_status = 'archived' then 'archived'
    when p.admin_status = 'paused' then 'paused'
    when p.admin_status = 'draft' then 'draft'
    when p.admin_status = 'enabled' and p.end_at is not null and p.end_at < now() then 'expired'
    when p.admin_status = 'enabled' and (p.start_at is null or p.start_at <= now()) then 'active'
    else 'scheduled'
  end
$$;

-- ---------------------------------------------------------------
-- public_active_promotions: the ONLY way anon ever reads promotion
-- data -- customer-safe columns only (no internal_notes,
-- redemption_count, admin_status, created_by), and only rows that
-- are genuinely enabled+automatic+within their schedule window right
-- now. A plain view (not security_invoker) so it can read the full
-- promotions table under the view owner's privileges while the WHERE
-- clause and column list are what actually keep it safe -- exact same
-- pattern as the existing menu_item_stock anon-column-grant.
-- ---------------------------------------------------------------
create or replace view public.public_active_promotions as
select
  p.id,
  p.customer_title,
  p.customer_description,
  p.cart_message,
  p.promotion_type,
  p.qualifying_subtotal_min,
  p.threshold_operator,
  p.start_at,
  p.end_at,
  p.priority,
  p.stackable,
  p.free_item_quantity,
  p.free_item_customer_chooses,
  p.free_item_max_per_order,
  p.free_item_repeats_at_multiples,
  p.discount_percentage,
  p.discount_max_amount,
  p.discount_applies_to,
  p.fixed_discount_amount
from public.promotions p
where p.admin_status = 'enabled'
  and p.application_mode = 'automatic'
  and (p.start_at is null or p.start_at <= now())
  and (p.end_at is null or p.end_at >= now());

grant select on public.public_active_promotions to anon, authenticated;

-- Companion view: reward items for only the promotions the view
-- above actually exposes -- avoids leaking a draft/paused
-- promotion's reward-item selections to the public.
create or replace view public.public_active_promotion_reward_items as
select pri.id, pri.promotion_id, pri.menu_item_id, pri.sort_order
from public.promotion_reward_items pri
join public.public_active_promotions pap on pap.id = pri.promotion_id;

grant select on public.public_active_promotion_reward_items to anon, authenticated;

-- ---------------------------------------------------------------
-- duplicate_promotion: copies a promotion (and its reward/eligibility
-- child rows) into a new draft, forcing promo_code/schedule/
-- redemption_count to reset so the copy can never silently inherit a
-- live window or collide on a unique code -- the admin must
-- explicitly re-schedule and re-activate it.
-- ---------------------------------------------------------------
create or replace function public.duplicate_promotion(p_promotion_id uuid)
returns public.promotions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_new public.promotions;
begin
  if not is_admin() then
    raise exception 'Admins only.';
  end if;

  insert into public.promotions (
    internal_name, customer_title, customer_description, cart_message, internal_notes,
    promotion_type, admin_status, start_at, end_at, application_mode, promo_code,
    priority, stackable, qualifying_subtotal_min, threshold_operator,
    max_total_redemptions, max_redemptions_per_order, max_redemptions_per_customer,
    free_item_quantity, free_item_customer_chooses, free_item_max_per_order, free_item_repeats_at_multiples,
    discount_percentage, discount_max_amount, discount_applies_to, fixed_discount_amount,
    created_by
  )
  select
    internal_name || ' (copy)', customer_title, customer_description, cart_message, internal_notes,
    promotion_type, 'draft', null, null, application_mode, null,
    priority, stackable, qualifying_subtotal_min, threshold_operator,
    max_total_redemptions, max_redemptions_per_order, max_redemptions_per_customer,
    free_item_quantity, free_item_customer_chooses, free_item_max_per_order, free_item_repeats_at_multiples,
    discount_percentage, discount_max_amount, discount_applies_to, fixed_discount_amount,
    auth.uid()
  from public.promotions
  where id = p_promotion_id
  returning * into v_new;

  if v_new.id is null then
    raise exception 'Promotion not found.';
  end if;

  insert into public.promotion_reward_items (promotion_id, menu_item_id, sort_order)
  select v_new.id, menu_item_id, sort_order
  from public.promotion_reward_items
  where promotion_id = p_promotion_id;

  insert into public.promotion_eligible_items (promotion_id, menu_item_id, is_excluded)
  select v_new.id, menu_item_id, is_excluded
  from public.promotion_eligible_items
  where promotion_id = p_promotion_id;

  insert into public.promotion_eligible_categories (promotion_id, category, is_excluded)
  select v_new.id, category, is_excluded
  from public.promotion_eligible_categories
  where promotion_id = p_promotion_id;

  return v_new;
end;
$$;

revoke all on function public.duplicate_promotion(uuid) from public;
grant execute on function public.duplicate_promotion(uuid) to authenticated;

commit;
