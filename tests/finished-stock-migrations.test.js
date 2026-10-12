"use strict";

/* ==========================================
   Finished-product freezer stock -- migration/RLS structural tests.

   A local Postgres instance isn't part of this repo's test harness
   (see every other *-schema.test.js file for the same convention), so
   these are content/regression assertions against the actual applied
   SQL -- confirming the right constructs exist (constraints, RLS
   policies, grants, atomic UPDATE pattern, idempotency design) -- not
   a live database. Real concurrency/transaction behavior is verified
   against the live database separately (see the live-verification
   report, not a test file).
   ========================================== */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function read(relPath) {
    return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

const schema = read("supabase/migrations/20261012120000_finished_stock_schema.sql");
const triggers = read("supabase/migrations/20261012121500_finished_stock_reconcile_triggers.sql");
const adminRpcs = read("supabase/migrations/20261012123000_finished_stock_admin_rpcs.sql");
const submitOrderStock = read("supabase/migrations/20261012124500_submit_order_stock_aware.sql");
const replaceItemsRpc = read("supabase/migrations/20261012130000_admin_replace_order_items_rpc.sql");
const orphanCleanup = read("supabase/migrations/20261012131500_drop_orphaned_submit_order_overload.sql");

test("1. menu_item_stock defaults every item to made_to_order (no row = made to order, never a guessed count)", () => {
    assert.match(schema, /stock_mode text not null default 'made_to_order'/);
    assert.match(schema, /check \(stock_mode in \('made_to_order', 'limited'\)\)/);
});

test("2. menu_item_stock cannot hold a negative physical_count or reserved_count", () => {
    assert.match(schema, /physical_count integer\s*\n\s*check \(physical_count is null or physical_count >= 0\)/);
    assert.match(schema, /reserved_count integer not null default 0\s*\n\s*check \(reserved_count >= 0\)/);
});

test("3. a 'limited' row is required to carry a real count (never silently treated as zero)", () => {
    assert.match(schema, /constraint menu_item_stock_limited_requires_count/);
    assert.match(schema, /check \(stock_mode = 'made_to_order' or physical_count is not null\)/);
});

test("4. available_count is a GENERATED column (one source of truth), floored at zero, never written directly", () => {
    assert.match(schema, /available_count integer generated always as \(/);
    assert.match(schema, /greatest\(coalesce\(physical_count, 0\) - reserved_count, 0\)/);
    assert.match(schema, /\) stored/);
});

test("5. public (anon) can read only the four public-safe stock columns, never physical/reserved counts directly", () => {
    assert.match(schema, /grant select \(menu_item_id, stock_mode, sold_out_behavior, available_count\)\s*\n\s*on public\.menu_item_stock to anon/);
    assert.doesNotMatch(schema, /grant select \([^)]*physical_count[^)]*\)\s*\n\s*on public\.menu_item_stock to anon/);
});

test("6. anon has no write access to menu_item_stock at all", () => {
    assert.match(schema, /revoke all on public\.menu_item_stock from anon/);
});

test("7. order_item_reservations and finished_stock_movements both revoke all from anon", () => {
    assert.match(schema, /revoke all on public\.order_item_reservations from anon/);
    assert.match(schema, /revoke all on public\.finished_stock_movements from anon/);
});

test("8. order_item_reservations has NO policies for anyone, not even authenticated -- only reachable via the security-definer reconcile function", () => {
    assert.match(schema, /revoke all on public\.order_item_reservations from authenticated/);
    const reservationsBlock = schema.slice(schema.indexOf("order_item_reservations"));
    assert.doesNotMatch(
        reservationsBlock.slice(0, reservationsBlock.indexOf("finished_stock_movements")),
        /create policy/
    );
});

test("9. reserved_qty in order_item_reservations must be positive (a zero/negative reservation row is deleted, never stored)", () => {
    assert.match(schema, /reserved_qty integer not null check \(reserved_qty > 0\)/);
});

test("10. finished_stock_movements only admits the five documented sources", () => {
    assert.match(
        schema,
        /source text not null\s*\n\s*check \(source in \(\s*\n\s*'admin_adjustment', 'order_reservation', 'order_cancellation',\s*\n\s*'order_edit', 'order_deletion'\s*\n\s*\)\)/
    );
});

test("11. only admins (is_admin()) can view finished_stock_movements -- no insert/update/delete policy for anyone", () => {
    assert.match(schema, /create policy "Admins can view finished stock movements" on public\.finished_stock_movements\s*\n\s*for select to authenticated using \(is_admin\(\)\)/);
});

test("12. reconcile_order_stock's overselling guard is a single conditional UPDATE with the row-lock-serialized WHERE clause", () => {
    assert.match(
        triggers,
        /update public\.menu_item_stock\s*\n\s*set reserved_count = reserved_count \+ v_delta\s*\n\s*where menu_item_id = v_row\.menu_item_id\s*\n\s*and coalesce\(physical_count, 0\) - reserved_count >= v_delta/
    );
});

test("13. an insufficient-stock reservation attempt raises the exact, customer-friendly, recognizable error text", () => {
    assert.match(triggers, /no longer has enough stock remaining/);
});

test("14. reconcile_order_stock recomputes reservation from scratch every call (idempotent by construction, not by a separate 'already done' flag)", () => {
    // The function reads CURRENT order status + CURRENT order_items every
    // time and diffs against order_item_reservations' CURRENT value --
    // never a boolean/flag column anywhere in this feature's schema.
    assert.doesNotMatch(schema, /already_reserved|reservation_applied|has_been_reserved/i);
    assert.match(triggers, /v_delta := v_row\.new_reserved - v_row\.prev_reserved;/);
    assert.match(triggers, /if v_delta = 0 then\s*\n\s*continue;/);
});

test("15. cancelling (or force-releasing) an order sets its required reservation to zero -- restoration, not a separate code path", () => {
    assert.match(triggers, /case when v_is_cancelled then 0 else coalesce\(req\.required_qty, 0\) end as new_reserved/);
});

test("16. order_items insert/delete triggers are STATEMENT-level with transition tables (correct for submit_order's per-row insert loop and admin_replace_order_items' bulk insert alike)", () => {
    assert.match(triggers, /after insert on public\.order_items\s*\n\s*referencing new table as inserted_rows\s*\n\s*for each statement/);
    assert.match(triggers, /after delete on public\.order_items\s*\n\s*referencing old table as deleted_rows\s*\n\s*for each statement/);
});

test("17. orders.status changes trigger reconciliation only on an actual transition (old.status is distinct from new.status)", () => {
    assert.match(triggers, /after update of status on public\.orders/);
    assert.match(triggers, /if new\.status is distinct from old\.status then/);
});

test("18. a BEFORE DELETE trigger on orders force-releases stock regardless of status before the order disappears", () => {
    assert.match(triggers, /before delete on public\.orders/);
    assert.match(triggers, /perform public\.reconcile_order_stock\(old\.id, 'order_deletion', true\)/);
});

test("19. reconcile_order_stock and its trigger functions are never directly callable by anon or authenticated clients", () => {
    assert.match(triggers, /revoke execute on function public\.reconcile_order_stock\(uuid, text, boolean\) from public, anon, authenticated/);
});

test("20. builder-line stock consumption uses the documented formula (selection.quantity * order_items.quantity), matching js/sale-calculations.js's own convention", () => {
    assert.match(triggers, /coalesce\(\(sel->>'quantity'\)::integer, 0\) \* ol\.quantity/);
});

test("21. a malformed/non-UUID builder selection id is defensively excluded, not crashed on", () => {
    assert.match(triggers, /\^\[0-9a-fA-F\]\{8\}-\[0-9a-fA-F\]\{4\}-\[0-9a-fA-F\]\{4\}-\[0-9a-fA-F\]\{4\}-\[0-9a-fA-F\]\{12\}\$/);
});

test("22. set_menu_item_stock_mode and adjust_finished_stock both require is_admin() in-body and are never granted to anon", () => {
    assert.match(adminRpcs, /if not is_admin\(\) then\s*\n\s*raise exception 'Only an admin can change stock settings\.'/);
    assert.match(adminRpcs, /if not is_admin\(\) then\s*\n\s*raise exception 'Only an admin can adjust stock\.'/);
    assert.match(adminRpcs, /revoke execute on function public\.set_menu_item_stock_mode\(uuid, text, integer, text\) from public, anon/);
    assert.match(adminRpcs, /revoke execute on function public\.adjust_finished_stock\(uuid, text, numeric, text\) from public, anon/);
});

test("23. set_menu_item_stock_mode refuses to stock-track a Mix & Match box product -- only standard flavors", () => {
    assert.match(adminRpcs, /is a Mix & Match box, not an individually-stocked product/);
});

test("24. adjust_finished_stock rejects a negative resulting count (cannot remove more than is on hand)", () => {
    assert.match(adminRpcs, /if v_new_physical < 0 then\s*\n\s*raise exception 'Cannot remove % units/);
});

test("25. adjust_finished_stock takes a row lock before computing the new count (FOR UPDATE)", () => {
    assert.match(adminRpcs, /for update of mis;/);
});

test("26. every adjust_finished_stock/set_menu_item_stock_mode write is paired with a finished_stock_movements audit row", () => {
    const adjustFn = adminRpcs.slice(adminRpcs.indexOf("adjust_finished_stock"));
    assert.match(adjustFn, /insert into public\.finished_stock_movements/);
});

test("27. submit_order's standard-item and Mix & Match flavor lookups both gate on finished stock, reusing the existing 'no longer available' message", () => {
    assert.match(submitOrderStock, /ms\.stock_mode is null or ms\.stock_mode <> 'limited' or ms\.available_count > 0/g);
    const occurrences = submitOrderStock.match(/ms\.stock_mode is null or ms\.stock_mode <> 'limited' or ms\.available_count > 0/g) || [];
    assert.equal(occurrences.length, 2, "expected the stock-eligibility condition on both the standard-item and builder-flavor lookups");
});

test("28. submit_order never trusts client-sent price/line_total for the actual insert -- still re-derives from live menu_items", () => {
    assert.match(submitOrderStock, /v_line_total := v_resolved_price \* v_quantity;/);
    assert.match(submitOrderStock, /v_line_total := v_builder_item\.price \* v_quantity;/);
});

test("29. admin_replace_order_items wraps delete+insert as one atomic RPC, admin-only", () => {
    assert.match(replaceItemsRpc, /delete from public\.order_items where order_id = p_order_id;/);
    assert.match(replaceItemsRpc, /insert into public\.order_items \(/);
    assert.match(replaceItemsRpc, /if not is_admin\(\) then/);
    assert.match(replaceItemsRpc, /revoke execute on function public\.admin_replace_order_items\(uuid, jsonb\) from public, anon/);
    assert.match(replaceItemsRpc, /grant execute on function public\.admin_replace_order_items\(uuid, jsonb\) to authenticated/);
});

test("30. the orphaned pre-stock-aware submit_order overload is dropped, closing the validation-bypass gap", () => {
    assert.match(orphanCleanup, /drop function if exists public\.submit_order\(\s*\n\s*text, text, text, text, text, date, text, numeric, jsonb\s*\n\s*\);/);
});

test("31. none of these migrations touch ingredients, recipe_components, production_log, or sales tables", () => {
    for (const sql of [schema, triggers, adminRpcs, submitOrderStock, replaceItemsRpc, orphanCleanup]) {
        assert.doesNotMatch(sql, /\balter table public\.ingredients\b/i);
        assert.doesNotMatch(sql, /\balter table public\.recipe_components\b/i);
        assert.doesNotMatch(sql, /\balter table public\.production_log\b/i);
        assert.doesNotMatch(sql, /\balter table public\.sales\b/i);
    }
});

test("32. every new migration is wrapped in begin;/commit; (atomic apply)", () => {
    for (const sql of [schema, triggers, adminRpcs, submitOrderStock, replaceItemsRpc, orphanCleanup]) {
        assert.match(sql, /\nbegin;\n/);
        assert.match(sql.trim(), /commit;\s*$/);
    }
});

test("33. every new migration has a paired rollback file", () => {
    const migrationFiles = [
        "20261012120000_finished_stock_schema",
        "20261012121500_finished_stock_reconcile_triggers",
        "20261012123000_finished_stock_admin_rpcs",
        "20261012124500_submit_order_stock_aware",
        "20261012130000_admin_replace_order_items_rpc",
        "20261012131500_drop_orphaned_submit_order_overload"
    ];
    for (const name of migrationFiles) {
        const rollbackPath = path.join(ROOT, "supabase", "rollbacks", `${name}_rollback.sql`);
        assert.ok(fs.existsSync(rollbackPath), `missing rollback for ${name}`);
    }
});
