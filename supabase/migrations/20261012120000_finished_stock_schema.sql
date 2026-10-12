-- ============================================================
-- Finished-product freezer stock (new feature).
--
-- Tracks how many already-baked units of a menu item are physically
-- in the freezer right now, completely separate from:
--   - raw-ingredient inventory (public.ingredients / recipe_components)
--   - production/baking batches (public.production_log, the
--     complete_production() RPC) -- that's what deducts ingredients
--     when something is BAKED; this feature is about what happens to
--     the finished product AFTER baking, and never touches ingredient
--     deduction in any way.
--   - menu_items.available -- that flag still means "shown on the
--     public menu / orderable at all" and always wins: an item with
--     available=false must never become orderable just because it
--     has freezer stock. Stock is an ADDITIONAL constraint on top,
--     never a replacement for it.
--
-- Only standard, individually-orderable products (menu_items.id) are
-- ever stock-tracked -- NOT the Mix & Match box products themselves.
-- A box's availability is fully derived from whichever of its
-- flavors are/aren't sold out (see the reconcile function in the next
-- migration); the box product never gets its own menu_item_stock row.
--
-- menu_item_stock has NO row at all for a menu item until an admin
-- explicitly switches it to "limited" via set_menu_item_stock_mode()
-- (next-but-one migration) -- this is what makes "existing products
-- default safely to Made to order, never a guessed count" true by
-- construction: absence of a row IS made-to-order.
--
-- available_count is a GENERATED column (never written directly, never
-- a second source of truth) so "live server data" always reflects
-- physical_count minus whatever is currently reserved by non-cancelled
-- orders, floored at zero for display even if an admin's manual
-- correction momentarily puts physical_count below reserved_count
-- (e.g. recording freezer damage after orders were already placed --
-- see adjust_finished_stock()'s own comments).
-- ============================================================
begin;

create table if not exists public.menu_item_stock (
  menu_item_id uuid primary key references public.menu_items(id) on delete cascade,
  stock_mode text not null default 'made_to_order'
    check (stock_mode in ('made_to_order', 'limited')),
  physical_count integer
    check (physical_count is null or physical_count >= 0),
  reserved_count integer not null default 0
    check (reserved_count >= 0),
  sold_out_behavior text not null default 'show_sold_out'
    check (sold_out_behavior in ('show_sold_out', 'hide')),
  available_count integer generated always as (
    greatest(coalesce(physical_count, 0) - reserved_count, 0)
  ) stored,
  updated_at timestamptz not null default now(),
  -- A 'limited' row must always carry a real count -- never silently
  -- treated as zero/unlimited because the admin forgot to set one.
  constraint menu_item_stock_limited_requires_count
    check (stock_mode = 'made_to_order' or physical_count is not null)
);

create or replace function public.set_menu_item_stock_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists menu_item_stock_set_updated_at on public.menu_item_stock;
create trigger menu_item_stock_set_updated_at
before update on public.menu_item_stock
for each row execute function public.set_menu_item_stock_updated_at();

alter table public.menu_item_stock enable row level security;
revoke all on public.menu_item_stock from anon;

drop policy if exists "Admins can view menu item stock" on public.menu_item_stock;
create policy "Admins can view menu item stock" on public.menu_item_stock
  for select to authenticated using (is_admin());
-- Direct admin UPDATE is intentionally allowed for sold_out_behavior
-- (a simple display preference, exactly like toggleMenuAvailability's
-- direct write to menu_items.available elsewhere in this codebase).
-- The admin dashboard's OWN code is expected to route every change to
-- stock_mode or physical_count through set_menu_item_stock_mode() /
-- adjust_finished_stock() instead (next migrations), so every
-- quantity change is paired with a finished_stock_movements ledger
-- row -- RLS can't enforce that distinction itself, the same trust
-- boundary already relied on throughout the rest of this dashboard.
drop policy if exists "Admins can update menu item stock" on public.menu_item_stock;
create policy "Admins can update menu item stock" on public.menu_item_stock
  for update to authenticated using (is_admin()) with check (is_admin());
-- No insert/delete policy for authenticated: new rows are only ever
-- created by set_menu_item_stock_mode() (security definer), and rows
-- are never deleted (an item switched back to Made to order keeps its
-- row, with stock_mode reset and its last count preserved for next
-- time) -- removed only as a side effect of the menu item itself
-- being deleted (on delete cascade above).

-- ---------------------------------------------------------------
-- Public read access: every row, but only the four public-safe
-- columns -- never physical_count/reserved_count directly, which
-- would reveal order volume. Public pages must select exactly these
-- column names (never "*") for this to resolve, same convention as
-- vacation_periods/theme_state.
-- ---------------------------------------------------------------
drop policy if exists "Public can view menu item stock" on public.menu_item_stock;
create policy "Public can view menu item stock" on public.menu_item_stock
  for select to anon
  using (true);

grant select (menu_item_id, stock_mode, sold_out_behavior, available_count)
  on public.menu_item_stock to anon;

-- ---------------------------------------------------------------
-- order_item_reservations: internal-only bookkeeping of "how much is
-- CURRENTLY reserved, per order, per item" -- never read or written
-- by any client, only by reconcile_order_stock() (next migration).
-- This is what makes reconciliation idempotent: every trigger firing
-- recomputes "what SHOULD be reserved right now" from orders.status +
-- order_items, diffs it against this table's CURRENT value, and only
-- applies the delta -- so retrying, double-clicking, or re-cancelling
-- an already-cancelled order is always a safe no-op.
-- ---------------------------------------------------------------
create table if not exists public.order_item_reservations (
  order_id uuid not null references public.orders(id) on delete cascade,
  menu_item_id uuid not null references public.menu_items(id) on delete cascade,
  reserved_qty integer not null check (reserved_qty > 0),
  updated_at timestamptz not null default now(),
  primary key (order_id, menu_item_id)
);

alter table public.order_item_reservations enable row level security;
revoke all on public.order_item_reservations from anon;
revoke all on public.order_item_reservations from authenticated;
-- No policies at all, for anyone -- every access goes through
-- reconcile_order_stock(), which is security definer and bypasses
-- RLS. Even an authenticated admin has no direct read/write access;
-- "reserved by pending orders" is shown via menu_item_stock.reserved_count
-- instead, which IS admin-readable above.

-- ---------------------------------------------------------------
-- finished_stock_movements: append-only audit ledger. Every stock
-- change -- an admin's manual adjustment, a new order's reservation,
-- a cancellation's restoration, an edited order's reconciliation, or
-- a deleted order's restoration -- gets exactly one row here, giving
-- Jessica a full "item, change, previous count, new count, reason,
-- timestamp, source" history per the admin Menu Stock page's
-- requirements.
-- ---------------------------------------------------------------
create table if not exists public.finished_stock_movements (
  id uuid primary key default gen_random_uuid(),
  menu_item_id uuid not null references public.menu_items(id) on delete cascade,
  -- Nullable + ON DELETE SET NULL: an order can still be legitimately
  -- deleted later (see js/admin-orders.js deleteOrder()); the ledger
  -- row survives as history with order_id cleared rather than being
  -- destroyed or blocking the delete.
  order_id uuid references public.orders(id) on delete set null,
  quantity_change integer not null,
  previous_count integer not null,
  new_count integer not null,
  reason text,
  source text not null
    check (source in (
      'admin_adjustment', 'order_reservation', 'order_cancellation',
      'order_edit', 'order_deletion'
    )),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_finished_stock_movements_item_created
  on public.finished_stock_movements (menu_item_id, created_at desc);
create index if not exists idx_finished_stock_movements_order
  on public.finished_stock_movements (order_id);

alter table public.finished_stock_movements enable row level security;
revoke all on public.finished_stock_movements from anon;

drop policy if exists "Admins can view finished stock movements" on public.finished_stock_movements;
create policy "Admins can view finished stock movements" on public.finished_stock_movements
  for select to authenticated using (is_admin());
-- No insert/update/delete policy for anyone: every row is written by
-- reconcile_order_stock() or adjust_finished_stock() (both security
-- definer), never directly.

commit;
