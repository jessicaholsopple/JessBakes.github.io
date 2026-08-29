-- Rollback for 20260829090000_egg_yolk_derived_ingredient.sql
--
-- Restores the exact original recipe_ingredients rows (cookie rows
-- back to Eggs, Cinnamon Rolls back to 2 whole Eggs, its companion
-- Egg Yolk row removed) and removes the derived ingredient/schema
-- additions -- but only deletes the Egg Yolks ingredient row if
-- nothing still references it (never destroys a real, in-use
-- ingredient just to "clean up").
begin;

do $$
declare
  v_eggs_id bigint;
  v_yolk_id bigint;
  v_cinnamon_recipe_id bigint;
begin
  select id into v_eggs_id from public.ingredients where name = 'Eggs';
  select id into v_yolk_id from public.ingredients where name = 'Egg Yolks';
  select id into v_cinnamon_recipe_id from public.recipes where name = 'Cinnamon Rolls';

  if v_yolk_id is not null then
    -- Cinnamon Rolls: remove the companion Egg Yolk row and restore
    -- the whole-Egg row to quantity 2.
    if v_cinnamon_recipe_id is not null then
      delete from public.recipe_ingredients
        where recipe_id = v_cinnamon_recipe_id and ingredient_id = v_yolk_id;

      if v_eggs_id is not null then
        update public.recipe_ingredients
          set quantity = 2
          where recipe_id = v_cinnamon_recipe_id and ingredient_id = v_eggs_id and quantity = 1;
      end if;
    end if;

    -- Cookie recipes: restore Egg Yolk rows back to Eggs.
    if v_eggs_id is not null then
      update public.recipe_ingredients ri
        set ingredient_id = v_eggs_id
        from public.recipes r
        where ri.recipe_id = r.id
          and r.category = 'Cookie'
          and ri.ingredient_id = v_yolk_id;
    end if;

    -- Only remove the derived ingredient row if it is no longer
    -- referenced by any recipe -- never delete real, in-use data.
    if not exists (select 1 from public.recipe_ingredients where ingredient_id = v_yolk_id) then
      delete from public.ingredients where id = v_yolk_id;
    else
      raise notice 'Egg Yolks ingredient (id=%) is still referenced by at least one recipe -- left in place rather than deleted.', v_yolk_id;
    end if;
  end if;
end $$;

drop trigger if exists trg_cascade_derived_ingredient_sync on public.ingredients;
drop trigger if exists trg_enforce_derived_ingredient on public.ingredients;
drop function if exists public.cascade_derived_ingredient_sync();
drop function if exists public.enforce_derived_ingredient();

drop index if exists public.idx_ingredients_derived_from;

alter table public.ingredients
  drop constraint if exists ingredients_derived_not_self_check,
  drop constraint if exists ingredients_derived_pair_check;

alter table public.ingredients
  drop column if exists derived_factor,
  drop column if exists derived_from_ingredient_id;

commit;
