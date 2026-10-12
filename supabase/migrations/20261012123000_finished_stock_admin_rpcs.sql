-- ============================================================
-- Admin-only RPCs for the new Menu Stock dashboard page.
--
-- set_menu_item_stock_mode() switches an item between Made to order
-- and Limited freezer stock (creating its menu_item_stock row the
-- first time it's touched -- see the schema migration's comment on
-- why "no row" IS the made-to-order default for every untouched
-- product). adjust_finished_stock() is the ONLY way physical_count
-- ever changes on an already-limited item -- both functions are the
-- sole writers of finished_stock_movements for source='admin_adjustment',
-- so every quantity change always has a matching audit row.
-- ============================================================
begin;

create or replace function public.set_menu_item_stock_mode(
  p_menu_item_id uuid,
  p_stock_mode text,
  p_initial_count integer default null,
  p_sold_out_behavior text default null
)
returns public.menu_item_stock
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item record;
  v_existing record;
  v_physical_count integer;
  v_sold_out_behavior text;
  v_result public.menu_item_stock;
begin
  if not is_admin() then
    raise exception 'Only an admin can change stock settings.';
  end if;

  if p_stock_mode not in ('made_to_order', 'limited') then
    raise exception 'Invalid stock mode: %', p_stock_mode;
  end if;

  select id, name, product_type into v_item from public.menu_items where id = p_menu_item_id;
  if not found then
    raise exception 'Menu item not found.';
  end if;
  -- Mix & Match box products never get their own stock row -- only
  -- their individual flavors (standard products) do. See the schema
  -- migration's header comment.
  if v_item.product_type <> 'standard' then
    raise exception '% is a Mix & Match box, not an individually-stocked product. Set stock on its individual flavors instead.', v_item.name;
  end if;

  select * into v_existing from public.menu_item_stock where menu_item_id = p_menu_item_id;

  v_sold_out_behavior := coalesce(p_sold_out_behavior, v_existing.sold_out_behavior, 'show_sold_out');
  if v_sold_out_behavior not in ('show_sold_out', 'hide') then
    raise exception 'Invalid sold-out behavior: %', v_sold_out_behavior;
  end if;

  if p_stock_mode = 'limited' then
    if p_initial_count is not null then
      if p_initial_count < 0 then
        raise exception 'Stock count cannot be negative.';
      end if;
      v_physical_count := p_initial_count;
    elsif v_existing.physical_count is not null then
      -- Resuming limited tracking without a new count -- keep the
      -- last known physical_count (switching to Made to order and
      -- back is not a reason to lose a real freezer count).
      v_physical_count := v_existing.physical_count;
    else
      raise exception 'Please enter the current freezer count to switch % to limited stock.', v_item.name;
    end if;
  else
    -- Switching OUT of limited: physical_count is simply left as-is
    -- (preserved for next time, exactly like toggling the other
    -- direction) but no longer enforced since made_to_order items are
    -- never capped.
    v_physical_count := v_existing.physical_count;
  end if;

  insert into public.menu_item_stock (menu_item_id, stock_mode, physical_count, sold_out_behavior)
  values (p_menu_item_id, p_stock_mode, v_physical_count, v_sold_out_behavior)
  on conflict (menu_item_id) do update set
    stock_mode = excluded.stock_mode,
    physical_count = excluded.physical_count,
    sold_out_behavior = excluded.sold_out_behavior
  returning * into v_result;

  if p_stock_mode = 'made_to_order' and v_result.reserved_count > 0 then
    -- Once an item is made_to_order, reservation is meaningless for
    -- it going forward -- reconcile_order_stock() will never touch it
    -- again (its join requires stock_mode = 'limited'), so any
    -- existing reservations against it would otherwise sit orphaned
    -- forever. Clear them deliberately, with a clear audit trail; if
    -- it's switched back to limited later, the admin sets a fresh
    -- count reflecting reality at that time and new orders reserve
    -- against it correctly from then on.
    insert into public.finished_stock_movements
      (menu_item_id, order_id, quantity_change, previous_count, new_count, reason, source, created_by)
    select
      p_menu_item_id, order_id, reserved_qty,
      greatest(coalesce(v_result.physical_count, 0) - v_result.reserved_count, 0),
      greatest(coalesce(v_result.physical_count, 0) - v_result.reserved_count, 0) + reserved_qty,
      'Switched to Made to order -- reservation cleared',
      'admin_adjustment', auth.uid()
    from public.order_item_reservations
    where menu_item_id = p_menu_item_id;

    delete from public.order_item_reservations where menu_item_id = p_menu_item_id;

    update public.menu_item_stock set reserved_count = 0 where menu_item_id = p_menu_item_id
    returning * into v_result;
  end if;

  return v_result;
end;
$$;

revoke execute on function public.set_menu_item_stock_mode(uuid, text, integer, text) from public, anon;
grant execute on function public.set_menu_item_stock_mode(uuid, text, integer, text) to authenticated;

-- ---------------------------------------------------------------
-- adjust_finished_stock(): the only way physical_count changes on an
-- already-limited item, covering all three admin actions (quick add,
-- quick subtract, exact correction) through one function and one
-- ledger-writing code path.
-- ---------------------------------------------------------------
create or replace function public.adjust_finished_stock(
  p_menu_item_id uuid,
  p_mode text,
  p_amount numeric,
  p_reason text default null
)
returns public.menu_item_stock
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item record;
  v_current record;
  v_old_physical integer;
  v_new_physical integer;
  v_prev_available integer;
  v_new_available integer;
  v_result public.menu_item_stock;
begin
  if not is_admin() then
    raise exception 'Only an admin can adjust stock.';
  end if;

  if p_mode not in ('add', 'subtract', 'set') then
    raise exception 'Invalid adjustment mode: %', p_mode;
  end if;

  if p_amount is null or p_amount < 0 then
    raise exception 'Amount must be zero or a positive number.';
  end if;

  select mis.*, mi.name into v_current
  from public.menu_item_stock mis
  join public.menu_items mi on mi.id = mis.menu_item_id
  where mis.menu_item_id = p_menu_item_id
  for update of mis;

  if not found or v_current.stock_mode <> 'limited' then
    raise exception 'This item must be switched to limited stock before its count can be adjusted.';
  end if;

  v_old_physical := coalesce(v_current.physical_count, 0);

  v_new_physical := case p_mode
    when 'add' then v_old_physical + p_amount::integer
    when 'subtract' then v_old_physical - p_amount::integer
    when 'set' then p_amount::integer
  end;

  if v_new_physical < 0 then
    raise exception 'Cannot remove % units -- only % are currently on hand.', p_amount::integer, v_old_physical;
  end if;

  update public.menu_item_stock
    set physical_count = v_new_physical
    where menu_item_id = p_menu_item_id
    returning * into v_result;

  v_prev_available := greatest(v_old_physical - v_result.reserved_count, 0);
  v_new_available := greatest(v_new_physical - v_result.reserved_count, 0);

  if v_new_available <> v_prev_available then
    insert into public.finished_stock_movements
      (menu_item_id, order_id, quantity_change, previous_count, new_count, reason, source, created_by)
    values
      (p_menu_item_id, null, v_new_available - v_prev_available, v_prev_available, v_new_available,
       coalesce(nullif(trim(p_reason), ''), initcap(p_mode) || ' adjustment'),
       'admin_adjustment', auth.uid());
  end if;

  return v_result;
end;
$$;

revoke execute on function public.adjust_finished_stock(uuid, text, numeric, text) from public, anon;
grant execute on function public.adjust_finished_stock(uuid, text, numeric, text) to authenticated;

commit;
