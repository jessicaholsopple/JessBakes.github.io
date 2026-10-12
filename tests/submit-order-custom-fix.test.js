"use strict";

/* ==========================================
   Fix: submit_order() "record v_pickup is not assigned yet" for
   custom orders (SQLSTATE 55000).

   Root cause: v_pickup RECORD was only SELECT-INTO assigned inside
   the `if p_order_type = 'weekly'` branch, but its fields were
   referenced in CASE expressions evaluated for every order type --
   Postgres must resolve the data type of every CASE branch before the
   INSERT can be planned, and an unassigned record has no tuple
   descriptor to resolve, regardless of which branch actually executes
   at runtime.

   Fix: replace the RECORD with two plain, statically-typed scalar
   variables (date/time), which PL/pgSQL auto-initializes to NULL with
   a known type -- safe to reference in a CASE branch that never
   actually runs.

   No local Postgres test harness exists in this repo (see every
   other *-migrations.test.js file for the same convention) -- these
   are structural/regression assertions against the actual applied
   SQL, confirming the fix pattern is present and every pre-existing
   behavior this migration must NOT change is still there untouched.
   Live functional verification (real custom/weekly/stock-limited/
   made-to-order/invalid submissions against the live database) is
   covered separately, not by a test file.
   ========================================== */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function read(relPath) {
    return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

const fixMigration = read("supabase/migrations/20261012140000_fix_submit_order_custom_order_pickup_record.sql");
const priorMigration = read("supabase/migrations/20261012124500_submit_order_stock_aware.sql");
const rollback = read("supabase/rollbacks/20261012140000_fix_submit_order_custom_order_pickup_record_rollback.sql");

// The header comments in these files legitimately quote old/new code
// (including literal "v_pickup.pickup_date") as prose explaining the
// fix -- assertions about what the actual SQL body does/doesn't
// contain must only look at the body, starting from the first real
// statement, never the explanatory comment block above it.
function sqlBody(sql) {
    const idx = sql.indexOf("\nbegin;\n");
    return idx === -1 ? sql : sql.slice(idx);
}

const fixBody = sqlBody(fixMigration);
const priorBody = sqlBody(priorMigration);

/* ==========================================
   The actual fix
========================================== */

test("1. the buggy RECORD variable (v_pickup record) is gone from the fixed function", () => {
    assert.doesNotMatch(fixBody, /v_pickup\s+record;/);
    assert.doesNotMatch(fixBody, /v_pickup\.pickup_date/);
    assert.doesNotMatch(fixBody, /v_pickup\.pickup_time/);
});

test("2. replaced by two plain, statically-typed scalar variables (date / time)", () => {
    assert.match(fixBody, /v_weekly_pickup_date\s+date;/);
    assert.match(fixBody, /v_weekly_pickup_time\s+time;/);
});

test("3. the scalar variables are assigned via a column-list SELECT INTO, only inside the weekly branch", () => {
    assert.match(
        fixBody,
        /if p_order_type = 'weekly' then\s*\n\s*select pickup_date, pickup_time\s*\n\s*into v_weekly_pickup_date, v_weekly_pickup_time\s*\n\s*from public\.compute_weekly_pickup\(now\(\)\);\s*\n\s*end if;/
    );
});

test("4. the INSERT's CASE expressions reference the new scalar variables, not a record field", () => {
    assert.match(fixBody, /case when p_order_type = 'weekly' then v_weekly_pickup_date else p_event_date end/);
    assert.match(fixBody, /case when p_order_type = 'weekly' then v_weekly_pickup_time else null end/);
});

test("5. the prior (buggy) migration did reference v_pickup.pickup_date/pickup_time unconditionally -- confirms this is a genuine regression fix, not a no-op", () => {
    assert.match(priorBody, /v_pickup\.pickup_date/);
    assert.match(priorBody, /v_pickup\.pickup_time/);
});

/* ==========================================
   Custom-order scheduling is unchanged -- no invented pickup data
========================================== */

test("6. a custom order's event_date still comes ONLY from p_event_date -- never from the weekly pickup computation", () => {
    assert.match(fixBody, /case when p_order_type = 'custom' then p_event_date else null end/);
});

test("7. event_date is required for custom orders -- this guard is untouched", () => {
    assert.match(fixBody, /if p_order_type = 'custom' and p_event_date is null then\s*\n\s*raise exception 'event_date is required for custom orders';/);
});

/* ==========================================
   Everything else must be byte-for-byte preserved
========================================== */

test("8. the function signature is IDENTICAL to the prior migration -- this REPLACES the live function, it does not create a new overload", () => {
    const extractSignature = (sql) => {
        const match = sql.match(/create or replace function public\.submit_order\(([\s\S]*?)\) returns public\.orders/);
        return match ? match[1].replace(/\s+/g, " ").trim() : null;
    };
    const fixedSig = extractSignature(fixBody);
    const priorSig = extractSignature(priorBody);
    assert.ok(fixedSig, "could not find signature in fix migration");
    assert.equal(fixedSig, priorSig);
});

test("9. vacation-mode guard is untouched", () => {
    assert.match(fixBody, /select exists\(select 1 from public\.vacation_periods where status = 'active'\) into v_vacation_active;/);
    assert.match(fixBody, /raise exception 'Ordering is currently paused for vacation\.';/);
});

test("10. invalid order_type is still rejected", () => {
    assert.match(fixBody, /if p_order_type not in \('weekly', 'custom'\) then\s*\n\s*raise exception 'Invalid order_type: %', p_order_type;/);
});

test("11. finished-stock eligibility checks (standard item + Mix & Match flavor) are both still present and unchanged", () => {
    const occurrences = fixBody.match(/ms\.stock_mode is null or ms\.stock_mode <> 'limited' or ms\.available_count > 0/g) || [];
    assert.equal(occurrences.length, 2, "expected the stock-eligibility condition on both the standard-item and builder-flavor lookups");
});

test("12. Mix & Match box/flavor validation (builder_group, builder_size, per-flavor eligibility) is untouched", () => {
    assert.match(fixBody, /m\.builder_group = \(v_item->'builder_details'->>'builder_group'\)/);
    assert.match(fixBody, /m\.builder_size = v_selected_total/);
    assert.match(fixBody, /m\.builder_group = v_builder_item\.builder_group/);
});

test("13. live re-pricing (never trusting client-sent price/line_total) is untouched", () => {
    assert.match(fixBody, /v_line_total := v_resolved_price \* v_quantity;/);
    assert.match(fixBody, /v_line_total := v_builder_item\.price \* v_quantity;/);
});

test("14. invalid/missing quantity is still rejected per item", () => {
    assert.match(fixBody, /if v_quantity is null or v_quantity < 1 then\s*\n\s*raise exception 'Invalid quantity for %'/);
});

test("15. required customer fields (name/email/phone) are still validated", () => {
    assert.match(fixBody, /raise exception 'customer_name is required';/);
    assert.match(fixBody, /raise exception 'A valid customer_email is required';/);
    assert.match(fixBody, /customer_phone is required/);
});

test("16. order_items are still inserted one row per statement inside the function (so the stock-reservation statement trigger fires correctly and atomically)", () => {
    assert.match(fixBody, /for v_item in select \* from jsonb_array_elements\(v_validated_items\)\s*\n\s*loop/);
    assert.match(fixBody, /insert into public\.order_items \(/);
});

test("17. no exception handler wraps the function body -- any RAISE EXCEPTION anywhere (including from the stock trigger) still aborts and rolls back the entire order atomically", () => {
    // The only `exception when others` in the file must be the narrow,
    // pre-existing per-item quantity-parsing guard -- never a
    // function-wide catch that could swallow a stock-reservation
    // failure and leave a partial order behind.
    const occurrences = fixBody.match(/exception when others then/g) || [];
    assert.equal(occurrences.length, 1);
    assert.match(fixBody, /exception when others then\s*\n\s*raise exception 'Invalid quantity for %'/);
});

test("18. this migration is additive/atomic (begin;/commit;) and has a paired rollback file", () => {
    assert.match(fixBody, /\nbegin;\n/);
    assert.match(fixBody.trim(), /commit;\s*$/);
    assert.ok(rollback.length > 0);
});

test("19. the rollback restores the exact prior (buggy) v_pickup record pattern -- a true, reversible undo", () => {
    assert.match(rollback, /v_pickup\s+record;/);
    assert.match(rollback, /v_pickup\.pickup_date/);
    assert.match(rollback, /v_pickup\.pickup_time/);
});

test("20. the rollback only replaces the submit_order function body -- no schema changes, no dropped/created tables or other functions", () => {
    assert.doesNotMatch(rollback, /drop function/i);
    assert.doesNotMatch(rollback, /create table/i);
    assert.doesNotMatch(rollback, /create trigger/i);
    const replaceCount = (rollback.match(/create or replace function/gi) || []).length;
    assert.equal(replaceCount, 1, "expected exactly one function replaced (submit_order)");
});
