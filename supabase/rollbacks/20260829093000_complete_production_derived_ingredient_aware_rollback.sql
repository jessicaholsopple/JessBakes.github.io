-- Rollback for 20260829093000_complete_production_derived_ingredient_aware.sql
-- Restores the exact prior function body (from
-- 20260817092629_security_repair_bug16_17_18_orders_rls_admin_functions_cost_views.sql).
begin;

create or replace function public.complete_production(p_production_date date, p_snapshot jsonb, p_deductions jsonb)
returns public.production_runs
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
    v_run public.production_runs;
    v_item jsonb;
    v_id bigint;
    v_qty numeric;
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

    for v_item in
        select value from jsonb_array_elements(coalesce(p_deductions,'[]'::jsonb))
    loop
        v_id=(v_item->>'ingredient_id')::bigint;
        v_qty=greatest(coalesce((v_item->>'quantity_purchase_units')::numeric,0),0);
        update public.ingredients
        set quantity_on_hand=greatest(coalesce(quantity_on_hand,0)-v_qty,0)
        where id=v_id;
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
