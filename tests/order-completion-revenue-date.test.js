"use strict";

/* ==========================================
   Order-completion revenue date fix (js/admin-orders.js +
   js/admin-dashboard.js)

   Covers:
     - createSaleFromOrder() never sets completed_at itself -- it
       relies entirely on sales.completed_at's database-level now()
       default (confirmed live via information_schema.columns:
       column_default = now(), not null), so the row is stamped with
       the ACTUAL moment of completion, never orders.created_at.
     - Idempotency: an existing sale short-circuits with no insert; a
       23505 unique-violation on the new sales_order_id_unique index
       (a genuinely concurrent/duplicate completion) is treated as
       success, not an error, and never proceeds to insert sale_items
       a second time.
     - The in-flight guard in updateOrderStatus() blocks a second
       concurrent call for the same order from this same tab.
     - Undo (removeSaleFromOrder) deletes sale_items then sales; a
       re-completion after undo creates a genuinely NEW sale row
       (proven by a second, independent insert actually firing -- not
       swallowed as a false-positive duplicate).
     - admin-dashboard.js's calculateRevenue() is structurally
       verified to source revenue from `sales`/`RevenueDate`, never
       from orders.created_at.

   Same node:vm sandbox + query-builder technique as
   tests/admin-orders-stock.test.js.
   ========================================== */

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function read(relPath) {
    return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

function makeQueryBuilder(state, resolveQuery, callLog) {
    const builder = {
        select(fields) { state.select = fields; callLog.push({ ...state, op: state.op || "select", select: fields }); return builder; },
        delete() { state.op = "delete"; callLog.push({ ...state, op: "delete" }); return builder; },
        insert(payload) { state.op = "insert"; state.payload = payload; callLog.push({ ...state }); return builder; },
        update(payload) { state.op = "update"; state.payload = payload; callLog.push({ ...state }); return builder; },
        upsert(payload) { state.op = "upsert"; state.payload = payload; callLog.push({ ...state }); return builder; },
        eq(field, value) {
            state.eq = state.eq || [];
            state.eq.push([field, value]);
            callLog.push({ ...state, op: "eq", field, value });
            return builder;
        },
        order(field) { state.order = field; return builder; },
        maybeSingle() { state.op = "maybeSingle"; callLog.push({ ...state }); return Promise.resolve(resolveQuery(state)); },
        single() { state.op = "single"; callLog.push({ ...state }); return Promise.resolve(resolveQuery(state)); },
        then(onFulfilled, onRejected) {
            return Promise.resolve(resolveQuery(state)).then(onFulfilled, onRejected);
        }
    };
    return builder;
}

function makeMockSupabase(resolveQuery) {
    const callLog = [];
    const client = {
        callLog,
        from(table) {
            return makeQueryBuilder({ table }, resolveQuery, callLog);
        }
    };
    return client;
}

function loadSandbox(resolveQuery) {
    const elements = new Map();

    function fakeElement(id) {
        if (!elements.has(id)) {
            elements.set(id, { id, value: "", textContent: "", innerHTML: "", style: {}, checked: false, disabled: false });
        }
        return elements.get(id);
    }

    const fakeDocument = {
        addEventListener: () => {},
        getElementById: (id) => fakeElement(id),
        querySelector: (selector) => fakeElement(selector),
        createElement: () => ({ style: {} }),
        body: { appendChild: () => {} }
    };

    const alertCalls = [];
    const supabaseClient = makeMockSupabase(resolveQuery);

    const sandbox = {
        document: fakeDocument,
        window: {},
        console,
        supabaseClient,
        alert: (msg) => alertCalls.push(msg),
        confirm: () => true,
        prompt: () => null,
        crypto: { randomUUID: () => "test-uuid" }
    };
    vm.createContext(sandbox);

    const source = [
        read("js/mix-and-match.js"),
        read("js/order-editor.js"),
        read("js/sale-calculations.js"),
        read("js/currency-conversion.js"),
        read("js/admin-orders.js"),
        `
        this.__createSaleFromOrder = createSaleFromOrder;
        this.__removeSaleFromOrder = removeSaleFromOrder;
        this.__updateOrderStatus = updateOrderStatus;
        `
    ].join("\n");

    vm.runInContext(source, sandbox);

    return { sandbox, elements, alertCalls, supabaseClient };
}

const SAMPLE_ORDER = { id: "order-1", customer_name: "Jamie Rivera", subtotal: 42, created_at: "2026-10-10T09:00:00Z" };
const CACHED_RATE = { rate_date: "2026-10-13", reference_date: "2026-10-13", rate: 1.1, source: "ecb_frankfurter" };

/** Builds a resolveQuery covering the full createSaleFromOrder() happy
 *  path: no existing sale, the sample order + one item, a cached FX
 *  rate (so no live-fetch/manual-prompt path is exercised), empty
 *  menu/recipe/packaging reference data, and a configurable response
 *  for the initial `sales` insert (the one place this suite varies
 *  behavior: success vs. a 23505 conflict). */
function buildResolver({ existingSale = null, saleInsertResult, saleItemsResult = { data: [{}], error: null } } = {}) {
    let saleInsertCallCount = 0;

    return (state) => {
        if (state.table === "sales" && state.op === "maybeSingle") {
            return { data: existingSale, error: null };
        }
        if (state.table === "orders" && state.op === "single") {
            return { data: SAMPLE_ORDER, error: null };
        }
        if (state.table === "order_items" && state.op === "select") {
            return { data: [{ menu_item_id: "item-1", item_name: "Boule", quantity: 1, price_at_purchase: 42, line_total: 42, builder_details: null }], error: null };
        }
        if (state.table === "exchange_rates" && state.op === "maybeSingle") {
            return { data: CACHED_RATE, error: null };
        }
        if (state.table === "sales" && state.op === "single") {
            saleInsertCallCount++;
            return saleInsertResult || { data: { id: "sale-1", name: "Jamie Rivera" }, error: null };
        }
        if (state.table === "menu_items" && state.op === "select") {
            return { data: [], error: null };
        }
        if (state.table === "recipe_costs" && state.op === "select") {
            return { data: [], error: null };
        }
        if (state.table === "packaging_profile_costs" && state.op === "select") {
            return { data: [], error: null };
        }
        if (state.table === "sale_items" && state.op === "insert") {
            return saleItemsResult;
        }
        if (state.table === "sales" && state.op === "update") {
            return { data: null, error: null };
        }
        return { data: null, error: null };
    };
}

/* ==========================================
   completed_at: database-authoritative, never copied from the order
========================================== */

test("1. the sales insert payload never includes completed_at -- the database's own now() default is the sole source of the completion timestamp", () => {
    const source = read("js/admin-orders.js");
    const insertStart = source.indexOf('.from("sales")\n            .insert({');
    const insertEnd = source.indexOf("})", insertStart);
    const insertPayload = source.slice(insertStart, insertEnd);

    assert.doesNotMatch(insertPayload, /completed_at/);
});

test("2. the sales insert payload never reads order.created_at -- revenue is never keyed off the order-placement date", () => {
    const source = read("js/admin-orders.js");
    const insertStart = source.indexOf('.from("sales")\n            .insert({');
    const insertEnd = source.indexOf("})", insertStart);
    const insertPayload = source.slice(insertStart, insertEnd);

    assert.doesNotMatch(insertPayload, /order\.created_at/);
});

test("3. a genuinely new completion inserts a sale and its sale_items, and returns true", async () => {
    const { sandbox, supabaseClient } = loadSandbox(buildResolver());

    const result = await sandbox.__createSaleFromOrder("order-1");

    assert.equal(result, true);
    assert.ok(supabaseClient.callLog.some(c => c.table === "sales" && c.op === "insert"));
    assert.ok(supabaseClient.callLog.some(c => c.table === "sale_items" && c.op === "insert"));
});

/* ==========================================
   Idempotency: existing sale, duplicate click, concurrent request
========================================== */

test("4. an order that already has a sale short-circuits -- no insert of any kind, returns true", async () => {
    const { sandbox, supabaseClient } = loadSandbox(buildResolver({ existingSale: { id: "sale-existing" } }));

    const result = await sandbox.__createSaleFromOrder("order-1");

    assert.equal(result, true);
    assert.equal(supabaseClient.callLog.filter(c => c.op === "insert").length, 0);
});

test("5. a 23505 unique-violation on the sales insert (a genuinely concurrent/duplicate completion winning the other side of the race) is treated as success, not an error", async () => {
    const { sandbox, alertCalls } = loadSandbox(buildResolver({
        saleInsertResult: { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint \"sales_order_id_unique\"" } }
    }));

    const result = await sandbox.__createSaleFromOrder("order-1");

    assert.equal(result, true);
    assert.ok(!alertCalls.some(a => /unable to create sale/i.test(a)));
});

test("6. after a 23505 conflict, sale_items is never inserted a second time by this call -- the winning request owns that work", async () => {
    const { sandbox, supabaseClient } = loadSandbox(buildResolver({
        saleInsertResult: { data: null, error: { code: "23505", message: "duplicate" } }
    }));

    await sandbox.__createSaleFromOrder("order-1");

    assert.equal(supabaseClient.callLog.filter(c => c.table === "sale_items" && c.op === "insert").length, 0);
});

test("7. a genuine (non-conflict) insert error still fails loudly and reverts -- never silently swallowed like a 23505", async () => {
    const { sandbox, alertCalls } = loadSandbox(buildResolver({
        saleInsertResult: { data: null, error: { code: "23502", message: "null value in column revenue violates not-null constraint" } }
    }));

    const result = await sandbox.__createSaleFromOrder("order-1");

    assert.equal(result, false);
    assert.ok(alertCalls.some(a => /unable to create sale/i.test(a)));
});

test("8. updateOrderStatus's in-flight guard: a second call for the SAME order while the first is still running is a no-op", async () => {
    let ordersUpdateCount = 0;
    const resolveQuery = (state) => {
        if (state.table === "orders" && state.op === "maybeSingle") {
            return { data: { status: "confirmed", subtotal: 42 }, error: null };
        }
        if (state.table === "orders" && state.op === "update") {
            ordersUpdateCount++;
        }
        return { data: null, error: null };
    };
    const { sandbox } = loadSandbox(resolveQuery);

    // Fired without awaiting the first -- both calls enter
    // updateOrderStatus() before either has a chance to finish.
    const first = sandbox.__updateOrderStatus("order-1", "ready");
    const second = sandbox.__updateOrderStatus("order-1", "ready");

    await Promise.all([first, second]);

    assert.equal(ordersUpdateCount, 1, "the second concurrent call for the same order must be a no-op");
});

test("9. updateOrderStatus still processes a DIFFERENT order concurrently -- the in-flight guard is keyed per-order, not global", async () => {
    let ordersUpdateCount = 0;
    const resolveQuery = (state) => {
        if (state.table === "orders" && state.op === "maybeSingle") {
            return { data: { status: "confirmed", subtotal: 42 }, error: null };
        }
        if (state.table === "orders" && state.op === "update") {
            ordersUpdateCount++;
        }
        return { data: null, error: null };
    };
    const { sandbox } = loadSandbox(resolveQuery);

    await Promise.all([
        sandbox.__updateOrderStatus("order-1", "ready"),
        sandbox.__updateOrderStatus("order-2", "ready")
    ]);

    assert.equal(ordersUpdateCount, 2);
});

/* ==========================================
   Undo Completion + re-completion
========================================== */

test("10. removeSaleFromOrder deletes sale_items before sales, and is a safe no-op when there's nothing to remove", async () => {
    const order = ["sale_items delete", "sales delete"];
    const seen = [];
    const resolveQuery = (state) => {
        if (state.table === "sales" && state.op === "maybeSingle") {
            return { data: { id: "sale-1" }, error: null };
        }
        if (state.table === "sale_items" && state.op === "delete") {
            seen.push("sale_items delete");
            return { data: null, error: null };
        }
        if (state.table === "sales" && state.op === "delete") {
            seen.push("sales delete");
            return { data: null, error: null };
        }
        return { data: null, error: null };
    };
    const { sandbox } = loadSandbox(resolveQuery);

    await sandbox.__removeSaleFromOrder("order-1");

    assert.deepEqual(seen, order);
});

test("11. removeSaleFromOrder with no linked sale makes no delete calls at all", async () => {
    const resolveQuery = (state) => {
        if (state.table === "sales" && state.op === "maybeSingle") {
            return { data: null, error: null };
        }
        if (state.op === "delete") {
            throw new Error("must not attempt a delete when no sale exists");
        }
        return { data: null, error: null };
    };
    const { sandbox } = loadSandbox(resolveQuery);

    await assert.doesNotReject(() => sandbox.__removeSaleFromOrder("order-1"));
});

test("12. re-completing an order after Undo creates a genuinely NEW sale -- a second, independent insert actually fires, not blocked as a false-positive duplicate", async () => {
    // "Undo" between the two completions is modeled the same way
    // removeSaleFromOrder leaves things in reality: no row in `sales`
    // for this order -- so BOTH completions see existingSale === null
    // and BOTH must perform their own real insert, each therefore
    // getting its own fresh database-generated completed_at.
    let insertChainResolutions = 0;
    const resolver = buildResolver();
    const statefulResolver = (state) => {
        if (state.table === "sales" && state.op === "maybeSingle") {
            return { data: null, error: null };
        }
        if (state.table === "sales" && state.op === "single") {
            insertChainResolutions++;
        }
        return resolver(state);
    };

    const { sandbox } = loadSandbox(statefulResolver);

    const first = await sandbox.__createSaleFromOrder("order-1");
    const second = await sandbox.__createSaleFromOrder("order-1"); // stands in for completing again after an intervening Undo

    assert.equal(first, true);
    assert.equal(second, true);
    assert.equal(
        insertChainResolutions,
        2,
        "each completion after an Undo must perform its own fresh insert (and therefore get its own fresh completed_at)"
    );
});

/* ==========================================
   admin-dashboard.js: revenue sourced from `sales`, not orders.created_at
========================================== */

const dashboardSource = read("js/admin-dashboard.js");

test("13. loadDashboardOrders() fetches `sales` (completed_at, revenue) and calculateRevenue() is called with that result, not the raw orders array", () => {
    assert.match(dashboardSource, /\.from\("sales"\)\s*\n\s*\.select\("completed_at, revenue"\)/);
    assert.match(dashboardSource, /calculateRevenue\(sales\)/);
});

test("14. calculateRevenue() uses RevenueDate's Berlin-aware comparisons, never a raw orders.created_at Date comparison", () => {
    const fnStart = dashboardSource.indexOf("function calculateRevenue");
    const relativeEnd = dashboardSource.slice(fnStart).search(/\r?\n\}\r?\n/);
    const fn = dashboardSource.slice(fnStart, fnStart + relativeEnd);

    assert.match(fn, /RevenueDate\.isSameBerlinDay/);
    assert.match(fn, /RevenueDate\.isSameBerlinWeek/);
    assert.match(fn, /RevenueDate\.isSameBerlinMonth/);
    assert.doesNotMatch(fn, /order\.created_at/);
    assert.doesNotMatch(fn, /\.subtotal/);
});

test("15. the old local-timezone isSameDay/isSameMonth/isThisWeek helpers were removed from admin-dashboard.js, not left as dead/confusing code", () => {
    assert.doesNotMatch(dashboardSource, /function isSameDay/);
    assert.doesNotMatch(dashboardSource, /function isSameMonth/);
    assert.doesNotMatch(dashboardSource, /function isThisWeek/);
});

/* ==========================================
   admin-sales.js / admin-analytics.js: Berlin bucketing, source untouched
========================================== */

const salesSource = read("js/admin-sales.js");
const analyticsSource = read("js/admin-analytics.js");

test("16. admin-sales.js still sources revenue from sales.completed_at (already correct) and now buckets it via RevenueDate", () => {
    assert.match(salesSource, /\.order\("completed_at", \{ ascending: false \}\)/);
    assert.match(salesSource, /RevenueDate\.isSameBerlinDay\(now, order\.completed_at\)/);
    assert.match(salesSource, /RevenueDate\.isSameBerlinWeek\(now, order\.completed_at\)/);
    assert.match(salesSource, /RevenueDate\.isSameBerlinMonth\(now, order\.completed_at\)/);
    assert.match(salesSource, /RevenueDate\.isSameBerlinYear\(now, order\.completed_at\)/);
});

test("17. admin-sales.js's chart/monthly-table grouping uses RevenueDate's Berlin month/day keys, not a UTC toISOString split or local getFullYear/getMonth", () => {
    assert.match(salesSource, /RevenueDate\.berlinDateKey/);
    assert.match(salesSource, /RevenueDate\.berlinMonthKey/);

    // Scoped to the actual grouping functions -- exportSalesCsv's
    // unrelated use of toISOString() for today's date in the download
    // FILENAME (cosmetic, not a revenue-bucketing concern) is fine and
    // deliberately untouched.
    const seriesFn = salesSource.slice(salesSource.indexOf("function buildRevenueSeries"), salesSource.indexOf("function renderCategoryRevenue"));
    const monthlyFn = salesSource.slice(salesSource.indexOf("function renderMonthlyRevenue"), salesSource.indexOf("function renderProfitBreakdown"));
    assert.doesNotMatch(seriesFn, /\.toISOString\(\)\.split\("T"\)\[0\]/);
    assert.doesNotMatch(monthlyFn, /getFullYear\(\)|getMonth\(\)/);
});

test("18. admin-analytics.js's orders-over-time chart groups by RevenueDate.berlinDateKey, not a UTC toISOString split", () => {
    assert.match(analyticsSource, /RevenueDate\.berlinDateKey\(date\)/);
    assert.doesNotMatch(analyticsSource, /date\.toISOString\(\)\.split\("T"\)\[0\]/);
});

test("19. admin-analytics.js's year-range filter uses RevenueDate.isSameBerlinYear, not a local getFullYear comparison", () => {
    assert.match(analyticsSource, /RevenueDate\.isSameBerlinYear\(now, date\)/);
});
