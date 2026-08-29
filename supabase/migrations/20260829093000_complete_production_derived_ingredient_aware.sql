-- ============================================================
-- complete_production(): make the inventory-deduction loop derived-
-- ingredient-aware, so Egg Yolk consumption atomically deducts the
-- physical Eggs ingredient instead of a separate, independently-
-- tracked row.
--
-- Every requested deduction line is first resolved to its PHYSICAL
-- ingredient id (derived_from_ingredient_id, or itself if not
-- derived) and scaled by derived_factor, then GROUPED/SUMMED by that
-- physical id before any UPDATE runs. This guarantees that if a
-- production run's calculated requirements include, say, 5 whole
-- Eggs and 12 Egg Yolks, they are combined into exactly one 17-unit
-- deduction against the Eggs row -- never two independent
-- subtractions each checked/applied against the same shared stock
-- (which would silently under-deduct or misrepresent availability).
-- js/admin-production.js's own requirement aggregation is updated
-- separately (see the accompanying commit) to merge these for
-- display/shortage-checking BEFORE calling this function, but this
-- function does the same resolution itself so the deduction is
-- correct and safe regardless of what the client sends.
--
-- Everything else about this function is unchanged: SECURITY
-- DEFINER, admin-only, keyed by production_date with a row lock and
-- an `inventory_deducted` guard (idempotent -- a retried call for an
-- already-completed date raises and changes nothing further), and
-- the whole deduction loop plus the production_runs update remain one
-- atomic transaction (a failure anywhere rolls back everything this
-- call did).
-- ============================================================
begin;

create or replace function public.complete_production(p_production_date date, p_snapshot jsonb, p_deductions jsonb)
returns public.production_runs
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
    v_run public.production_runs;
    v_row record;
begin
    if not public.is_admin() then
        raise exception 'Not authorized';
    end if;

    if p_production_date is null then
        raise exception 'p_production_date is required';
    end if;

    insert into public.production_runs(production_date,status,snapshot)
    values(p_production_date,'in_progress',p_snapshot)
    on conflict(production_date)
    do update set snapshot=excluded.snapshot,updated_at=now();

    select * into v_run
    from public.production_runs
    where production_date=p_production_date
    for update;

    if v_run.inventory_deducted then
        raise exception 'Inventory already deducted for %',p_production_date;
    end if;

    for v_row in
        select
            coalesce(i.derived_from_ingredient_id, i.id) as physical_id,
            sum(
                greatest(coalesce((d.value->>'quantity_purchase_units')::numeric, 0), 0)
                * coalesce(i.derived_factor, 1)
            ) as physical_qty
        from jsonb_array_elements(coalesce(p_deductions, '[]'::jsonb)) d
        join public.ingredients i on i.id = (d.value->>'ingredient_id')::bigint
        group by coalesce(i.derived_from_ingredient_id, i.id)
    loop
        update public.ingredients
        set quantity_on_hand = greatest(coalesce(quantity_on_hand, 0) - v_row.physical_qty, 0)
        where id = v_row.physical_id;
    end loop;

    update public.production_runs
    set status='completed',snapshot=p_snapshot,inventory_deducted=true,
        completed_at=now(),updated_at=now()
    where production_date=p_production_date
    returning * into v_run;

    return v_run;
end;
$function$;

commit;
