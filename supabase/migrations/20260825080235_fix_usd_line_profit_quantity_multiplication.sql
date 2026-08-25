-- Fix live bug found auditing the Analytics Product Breakdown (see
-- js/currency-conversion.js applyRateToSaleLines / computeUsdLineFigures):
-- sale_items.usd_line_profit was computed as
--   usd_line_revenue - total_cost
-- but total_cost is a PER-UNIT figure (food_cost + packaging_cost for
-- ONE unit -- see js/sale-calculations.js buildSaleLineItems), exactly
-- mirroring the already-correct EUR-side formula:
--   line_profit = line_revenue - (total_cost * quantity)
-- The USD formula was missing "* quantity", so every sale_items row with
-- quantity > 1 understated its true USD cost (and overstated its USD
-- profit) by a factor of its own quantity. This was invisible at the
-- sale level (sales.usd_profit is computed independently, from the
-- already-correctly-multiplied sale-wide total_cost -- see
-- js/sale-calculations.js summarizeLines) and only surfaced once
-- Analytics Product Breakdown started summing PER-LINE usd_line_profit
-- values directly.
--
-- This migration corrects the stored usd_line_profit for every affected
-- row using ONLY already-stored, frozen historical values (its own
-- usd_line_revenue, total_cost, and quantity) -- no recipe, packaging,
-- ingredient, or inventory cost is re-derived from current data, and no
-- other column (usd_line_revenue, total_cost, quantity, the EUR-side
-- line_profit, or any sales-table column) is touched.
--
-- Idempotent: only rows where the corrected value actually differs from
-- the stored value are touched; a second run of this file is a safe
-- no-op. Deterministic rollback, if ever needed: the pre-fix value is
-- recoverable as round(usd_line_revenue - total_cost, 2) (i.e. the same
-- formula without "* quantity") -- no backup/point-in-time restore is
-- required to undo this change.

do $$
declare
    mismatched_before int;
    mismatched_after int;
begin
    select count(*) into mismatched_before
    from sale_items
    where usd_line_revenue is not null
      and usd_line_profit is not null
      and round((usd_line_revenue - total_cost * quantity)::numeric, 2) <> usd_line_profit;

    -- Preflight sanity bound: this bug can only ever have affected rows
    -- with quantity <> 1, and this bakery's total sale_items row count is
    -- small. A count wildly outside this range would mean the WHERE
    -- clause above is matching something unexpected -- abort rather than
    -- risk touching unrelated rows.
    if mismatched_before > 500 then
        raise exception
            'Preflight check failed: % mismatched sale_items rows is far more than expected -- aborting without making changes.',
            mismatched_before;
    end if;

    raise notice 'Backfilling usd_line_profit for % sale_items row(s)...', mismatched_before;

    update sale_items
    set usd_line_profit = round((usd_line_revenue - total_cost * quantity)::numeric, 2)
    where usd_line_revenue is not null
      and usd_line_profit is not null
      and round((usd_line_revenue - total_cost * quantity)::numeric, 2) <> usd_line_profit;

    select count(*) into mismatched_after
    from sale_items
    where usd_line_revenue is not null
      and usd_line_profit is not null
      and round((usd_line_revenue - total_cost * quantity)::numeric, 2) <> usd_line_profit;

    if mismatched_after <> 0 then
        raise exception
            'Backfill did not converge: % row(s) still mismatched after update -- transaction rolled back.',
            mismatched_after;
    end if;

    raise notice 'usd_line_profit backfill complete and verified (0 mismatches remain).';
end $$;
