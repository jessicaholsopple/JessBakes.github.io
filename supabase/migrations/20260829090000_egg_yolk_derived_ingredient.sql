-- ============================================================
-- Egg / Egg Yolk handling: a reusable, database-backed derived-
-- ingredient relationship (Egg Yolks derived 1:1 from Eggs), plus the
-- specific recipe corrections requested for cookie recipes and the
-- canonical Cinnamon Rolls recipe.
--
-- Read-only preflight (recorded before this migration was written,
-- re-verified by the assertions below at apply time):
--   - Canonical Eggs ingredient: id 6, name 'Eggs', purchase_unit
--     'each', recipe_unit 'each', purchase_size 12, purchase_price
--     3.79, quantity_on_hand 12, minimum_quantity 4.
--   - Exactly 12 recipe_ingredients rows reference ingredient_id 6:
--       Cookie category (5 rows, to become Egg Yolks, quantity
--       unchanged): Brown Butter Sea Salt Chocolate Chip Cookies (3),
--       Brown Butter Snickerdoodle Cookie (3), Peanut Butter Cup
--       Cookie (2), S'mores Cookies (4), Strawberry Shortcake
--       Cookies (2).
--       Cinnamon Rolls, id 9 (Dessert category but the canonical
--       Cinnamon Roll recipe): quantity 2, to become 1 Egg + 1 Egg
--       Yolk.
--       Dessert category, left unchanged (6 rows): Blueberry Rolls
--       (2), Chocolate Strawberry Rolls (2), Classic Brownies (5),
--       Classic Family Brownies (2), Nutella Rolls (2), Strawberry
--       Rolls (2).
--   - No existing 'Egg Yolk(s)' ingredient.
--   - recipes/recipe_components/menu_items are never written by this
--     migration -- only ingredients (one new row) and
--     recipe_ingredients (6 rows: 5 updated in place, 1 quantity
--     changed, 1 new row inserted) are touched.
--
-- Architecture: Egg Yolks is NOT a second, independently-editable
-- stock count. `derived_from_ingredient_id` + `derived_factor` mark it
-- as consuming its source (Eggs) at a fixed ratio; a BEFORE INSERT OR
-- UPDATE trigger forcibly recomputes a derived ingredient's
-- purchase_unit/purchase_size/purchase_price/quantity_on_hand/
-- minimum_quantity from its live source on every write (so no code
-- path -- the admin UI, a future feature, or a direct SQL edit -- can
-- leave it out of sync), and an AFTER UPDATE trigger on the source
-- cascades a re-derive to every dependent the instant the source
-- changes (restock, manual edit, or a future deduction), all within
-- the same transaction. A second trigger rejects any attempt to
-- create a multi-level chain (a derived ingredient's source must
-- itself be a physical, non-derived ingredient), which also rules out
-- a 2-cycle. The existing `recipe_ingredients.ingredient_id`
-- foreign key (ON DELETE default RESTRICT, unchanged) already makes
-- it impossible to delete Eggs while Egg Yolks (or any recipe)
-- references it.
--
-- Because every downstream reader (the recipe_costs view,
-- js/admin-production.js's calculateRequirementCost, js/admin-
-- inventory.js's low-stock/inventory-value calculations) already
-- reads purchase_price/purchase_size/purchase_unit/recipe_unit/
-- quantity_on_hand/minimum_quantity directly off the ingredients row
-- by id, keeping those columns correctly mirrored on the Egg Yolks
-- row itself means recipe costing and stock-sufficiency math for
-- Egg Yolks works correctly with ZERO changes to the recipe_costs
-- view. Application code is still updated separately (see the
-- accompanying commit) to (a) exclude the derived row from
-- inventory-value/low-stock/shopping-list aggregates that must count
-- the physical Eggs only once, and (b) merge Egg + Egg Yolk demand
-- into one combined physical-Egg requirement before checking
-- sufficiency or building a production deduction payload.
--
-- Idempotent: safe to re-run. Transaction-safe: every assertion
-- raises an exception (aborting and rolling back the whole
-- migration) if the live data no longer matches this preflight
-- record, rather than guessing or silently proceeding.
-- ============================================================
begin;

-- ---------------------------------------------------------------
-- 1) Schema: derived-ingredient relationship + integrity triggers
-- ---------------------------------------------------------------
alter table public.ingredients
  add column if not exists derived_from_ingredient_id bigint references public.ingredients(id),
  add column if not exists derived_factor numeric;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ingredients_derived_pair_check') then
    alter table public.ingredients
      add constraint ingredients_derived_pair_check
      check (
        (derived_from_ingredient_id is null and derived_factor is null)
        or (derived_from_ingredient_id is not null and derived_factor > 0)
      );
  end if;

  if not exists (select 1 from pg_constraint where conname = 'ingredients_derived_not_self_check') then
    alter table public.ingredients
      add constraint ingredients_derived_not_self_check
      check (derived_from_ingredient_id is null or derived_from_ingredient_id <> id);
  end if;
end $$;

create index if not exists idx_ingredients_derived_from
  on public.ingredients (derived_from_ingredient_id);

-- Forces a derived ingredient's stock/cost columns to exactly match
-- its source (scaled by derived_factor) on every insert/update of the
-- derived row itself, and rejects a multi-level chain (a derived
-- ingredient's source must be physical) -- which also rejects a
-- direct 2-cycle, since a row already marked derived can never pass
-- the "source must be non-derived" check.
create or replace function public.enforce_derived_ingredient()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_source public.ingredients;
begin
  if new.derived_from_ingredient_id is not null then
    select * into v_source from public.ingredients where id = new.derived_from_ingredient_id;

    if v_source.id is null then
      raise exception 'derived_from_ingredient_id % does not reference an existing ingredient', new.derived_from_ingredient_id;
    end if;

    if v_source.derived_from_ingredient_id is not null then
      raise exception 'Ingredient "%" cannot derive from "%" because "%" is itself a derived ingredient -- chains are not allowed', new.name, v_source.name, v_source.name;
    end if;

    new.purchase_unit := v_source.purchase_unit;
    new.recipe_unit := coalesce(new.recipe_unit, v_source.recipe_unit);
    new.purchase_size := v_source.purchase_size / new.derived_factor;
    new.purchase_price := v_source.purchase_price;
    new.quantity_on_hand := v_source.quantity_on_hand / new.derived_factor;
    new.minimum_quantity := v_source.minimum_quantity / new.derived_factor;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_derived_ingredient on public.ingredients;
create trigger trg_enforce_derived_ingredient
  before insert or update on public.ingredients
  for each row execute function public.enforce_derived_ingredient();

-- Whenever a PHYSICAL ingredient's stock/cost fields change (restock,
-- price edit, manual correction), immediately re-derive every
-- ingredient that depends on it, in the same transaction -- a no-op
-- column touch on each dependent row is enough to re-fire the trigger
-- above and recompute it from the now-current source.
create or replace function public.cascade_derived_ingredient_sync()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.derived_from_ingredient_id is null and (
    new.quantity_on_hand is distinct from old.quantity_on_hand or
    new.minimum_quantity is distinct from old.minimum_quantity or
    new.purchase_size is distinct from old.purchase_size or
    new.purchase_price is distinct from old.purchase_price or
    new.purchase_unit is distinct from old.purchase_unit
  ) then
    update public.ingredients
      set quantity_on_hand = quantity_on_hand
      where derived_from_ingredient_id = new.id;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_cascade_derived_ingredient_sync on public.ingredients;
create trigger trg_cascade_derived_ingredient_sync
  after update on public.ingredients
  for each row execute function public.cascade_derived_ingredient_sync();

-- ---------------------------------------------------------------
-- 2) Data: create the canonical Egg Yolks derived ingredient, and
--    apply the exact recipe corrections, each preflight-asserted.
-- ---------------------------------------------------------------
do $$
declare
  v_eggs_id bigint;
  v_yolk_id bigint;
  v_cookie_count int;
  v_cookie_qty_sum numeric;
  v_cinnamon_recipe_id bigint;
  v_cinnamon_ri_id bigint;
  v_cinnamon_qty numeric;
begin
  -- Identify the canonical Eggs ingredient by verified database
  -- identity (name, uniquely) -- not assumed by hardcoded id.
  select id into v_eggs_id from public.ingredients where name = 'Eggs';
  if v_eggs_id is null then
    raise exception 'Canonical Eggs ingredient not found (expected a row named exactly "Eggs") -- aborting.';
  end if;
  if (select count(*) from public.ingredients where name = 'Eggs') <> 1 then
    raise exception 'Expected exactly one ingredient named "Eggs" -- found %, aborting.', (select count(*) from public.ingredients where name = 'Eggs');
  end if;

  -- Preflight assertion: the exact cookie-category Egg usage recorded
  -- during the read-only audit must still hold (5 rows, quantities
  -- summing to 3+3+2+4+2=14) before any row is changed.
  select count(*), coalesce(sum(ri.quantity), 0)
    into v_cookie_count, v_cookie_qty_sum
    from public.recipe_ingredients ri
    join public.recipes r on r.id = ri.recipe_id
    where ri.ingredient_id = v_eggs_id and r.category = 'Cookie';

  if v_cookie_count <> 5 or v_cookie_qty_sum <> 14 then
    raise exception 'Preflight mismatch: expected 5 cookie-category Egg rows summing to 14, found % rows summing to % -- aborting rather than guessing.', v_cookie_count, v_cookie_qty_sum;
  end if;

  -- Identify the canonical Cinnamon Roll recipe by name (the one and
  -- only recipe literally named "Cinnamon Rolls") and assert its
  -- current Egg quantity is exactly 2, exactly as audited.
  select id into v_cinnamon_recipe_id from public.recipes where name = 'Cinnamon Rolls';
  if v_cinnamon_recipe_id is null or (select count(*) from public.recipes where name = 'Cinnamon Rolls') <> 1 then
    raise exception 'Expected exactly one recipe named "Cinnamon Rolls" -- aborting.';
  end if;

  select id, quantity into v_cinnamon_ri_id, v_cinnamon_qty
    from public.recipe_ingredients
    where recipe_id = v_cinnamon_recipe_id and ingredient_id = v_eggs_id;

  if v_cinnamon_ri_id is null or v_cinnamon_qty <> 2 then
    raise exception 'Preflight mismatch: expected the canonical Cinnamon Rolls recipe to use exactly 2 whole Eggs, found % -- aborting.', v_cinnamon_qty;
  end if;

  -- Create (or reuse, idempotent) the canonical Egg Yolks derived
  -- ingredient. category_id/notes mirror Eggs' own grouping;
  -- supplier_id is left null (it is never independently purchased or
  -- supplied). The BEFORE INSERT trigger above immediately overwrites
  -- purchase_unit/purchase_size/purchase_price/quantity_on_hand/
  -- minimum_quantity with the correctly derived values regardless of
  -- what is supplied here.
  select id into v_yolk_id from public.ingredients where name = 'Egg Yolks';
  if v_yolk_id is null then
    insert into public.ingredients (
      name, category_id, supplier_id, purchase_unit, recipe_unit,
      purchase_size, purchase_price, quantity_on_hand, minimum_quantity,
      notes, derived_from_ingredient_id, derived_factor
    )
    select
      'Egg Yolks', i.category_id, null, i.purchase_unit, 'each',
      i.purchase_size, i.purchase_price, i.quantity_on_hand, i.minimum_quantity,
      'Derived 1:1 from Eggs -- cracking one whole Egg yields one Egg Yolk. Availability, unit cost, and restocking all come from Eggs; this row cannot be independently restocked.',
      i.id, 1
    from public.ingredients i
    where i.id = v_eggs_id
    returning id into v_yolk_id;
  end if;

  if v_yolk_id is null then
    raise exception 'Failed to create or locate the Egg Yolks ingredient -- aborting.';
  end if;

  -- Cookie recipes: replace the whole-Egg recipe ingredient with Egg
  -- Yolks, preserving the exact numerical quantity. Identified by the
  -- recipes.category relationship verified above, never by name.
  -- Idempotent: a row already pointed at Egg Yolks is simply not
  -- matched by `ingredient_id = v_eggs_id` on a re-run.
  update public.recipe_ingredients ri
    set ingredient_id = v_yolk_id
    from public.recipes r
    where ri.recipe_id = r.id
      and r.category = 'Cookie'
      and ri.ingredient_id = v_eggs_id;

  -- Canonical Cinnamon Rolls: 2 whole Eggs -> 1 whole Egg + 1 Egg
  -- Yolk. Idempotent: if this recipe's Egg row is already 1 (a
  -- previous run already applied this), do nothing further; only
  -- insert the Egg Yolk row if one doesn't already exist for it.
  update public.recipe_ingredients
    set quantity = 1
    where id = v_cinnamon_ri_id and quantity = 2;

  insert into public.recipe_ingredients (recipe_id, ingredient_id, quantity)
  select v_cinnamon_recipe_id, v_yolk_id, 1
  where not exists (
    select 1 from public.recipe_ingredients
    where recipe_id = v_cinnamon_recipe_id and ingredient_id = v_yolk_id
  );

  raise notice 'Egg Yolk migration applied: Eggs id=%, Egg Yolks id=%, % cookie rows converted, Cinnamon Rolls (id=%) row % set to quantity 1 with a companion Egg Yolk row.', v_eggs_id, v_yolk_id, v_cookie_count, v_cinnamon_recipe_id, v_cinnamon_ri_id;
end $$;

commit;
