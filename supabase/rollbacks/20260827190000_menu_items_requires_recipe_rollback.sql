-- Rollback for 20260827190000_menu_items_requires_recipe.sql
begin;

alter table public.menu_items
  drop column if exists requires_recipe;

commit;
