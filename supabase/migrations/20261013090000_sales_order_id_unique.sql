-- ============================================================
-- One active sale per order, enforced by the database -- not just by
-- js/admin-orders.js's createSaleFromOrder() checking for an existing
-- sale before inserting a new one.
--
-- That client-side check-then-insert is a classic TOCTOU race: two
-- near-simultaneous "Complete" clicks (an accidental double-click, a
-- network retry after a slow response the admin didn't realize
-- succeeded, or two genuinely concurrent requests) can both pass the
-- "does a sale already exist for this order?" check before either has
-- finished inserting, producing two sales rows for the same order and
-- double-counting its revenue everywhere (Dashboard, Sales,
-- Analytics). Nothing in the schema stopped this before now --
-- sales.order_id has only ever had a plain foreign key, confirmed live
-- via pg_constraint (sales_order_id_fkey + sales_pkey, no unique
-- constraint of any kind).
--
-- A plain `unique` constraint can't be used here because manual
-- (non-order) sales -- a workflow this project's schema already
-- supports (order_id is nullable) even though no UI currently creates
-- one -- legitimately need MANY rows with order_id = null. Postgres
-- unique indexes already treat every NULL as distinct from every other
-- NULL, so a partial index scoped to `where order_id is not null`
-- gives exactly the right rule: at most one sale per real order, no
-- limit on how many order-less manual sales exist.
--
-- Purely additive and reversible: no data is changed, no column is
-- added or removed. Safe to apply directly against production data --
-- confirmed via a live, read-only query (see this project's
-- conversation log) that every existing sales.order_id value is
-- already unique, so creating this index cannot fail against current
-- data.
-- ============================================================
begin;

create unique index if not exists sales_order_id_unique
  on public.sales (order_id)
  where order_id is not null;

commit;
