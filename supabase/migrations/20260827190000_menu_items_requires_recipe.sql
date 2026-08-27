-- ============================================================
-- Production audit (2026-08-27): explicit classification for whether
-- a menu item needs a recipe to be represented in Production, per the
-- requirement "Do not block products that legitimately require no
-- recipe; require an explicit classification instead."
--
-- Every current live menu_items row already has a real recipe_id
-- (standard products) or is deliberately recipe-less because it's a
-- Mix & Match builder box (product_type = 'builder', which expands
-- into its child selections' own recipes instead -- see
-- js/admin-production.js). requires_recipe defaults to true so every
-- EXISTING standard product keeps exactly its current "warn if no
-- recipe is linked" behavior; only a NEW product an admin explicitly
-- marks "doesn't need a recipe" (e.g. a packaging-only or merch item)
-- silences that specific warning. Builder products are backfilled to
-- false below since a recipe was never applicable to them by design,
-- not because one is missing.
-- ============================================================
begin;

alter table public.menu_items
  add column if not exists requires_recipe boolean not null default true;

update public.menu_items
  set requires_recipe = false
  where product_type = 'builder' and requires_recipe = true;

comment on column public.menu_items.requires_recipe is
  'When true (default), Production warns/blocks if this item has no recipe_id. Set false only for a product that legitimately needs no recipe (e.g. a Mix & Match builder box, whose recipe demand comes entirely from its child selections instead).';

commit;
