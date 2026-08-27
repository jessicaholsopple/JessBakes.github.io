"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SaleCalculations = require("../js/sale-calculations.js");
const MixAndMatch = require("../js/mix-and-match.js");

const ROOT = path.join(__dirname, "..");

function read(relPath) {
    return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

/* ==========================================
   Regression coverage for the safe product-retirement (archive) system,
   added after auditing the four static cookie-pack products deleted on
   2026-08-24 when they were replaced by the 6/12 Mix & Match builders.

   Audit finding (see the final report for full detail): those four
   products were never referenced by any order or sale, so their
   deletion caused no historical data loss. But nothing at the time
   would have STOPPED deleting a product that WAS referenced --
   menu_items -> order_items/sale_items is ON DELETE SET NULL, not
   RESTRICT, so a referenced product could be permanently deleted,
   silently severing (not removing) its historical link.

   Fix: js/admin-menu.js's Delete action now counts real references
   (order_items + sale_items) before allowing a permanent delete, and
   blocks it with a clear explanation if any exist. The existing
   Hide/Show toggle (already the correct "archive" mechanism -- it just
   flips menu_items.available, which every public/new-order/Mix & Match
   query already filters on) is relabeled Archive/Restore so the two
   actions are unambiguous in the UI.

   Tests run against the REAL js/admin-menu.js code in a vm sandbox
   (same technique as tests/delete-order.test.js), with a mock Supabase
   query builder that records every call made.
   ========================================== */

function makeQueryBuilder(state, resolveQuery, callLog) {
    const builder = {
        select(fields, options) {
            state.select = fields;
            state.selectOptions = options;
            callLog.push({ ...state, op: state.op || "select" });
            return builder;
        },
        delete() { state.op = "delete"; callLog.push({ ...state }); return builder; },
        update(payload) { state.op = "update"; state.payload = payload; callLog.push({ ...state }); return builder; },
        eq(field, value) {
            state.eq = state.eq || [];
            state.eq.push([field, value]);
            callLog.push({ ...state, op: "eq", field, value });
            return builder;
        },
        order() { return builder; },
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
    return {
        callLog,
        from(table) {
            return makeQueryBuilder({ table }, resolveQuery, callLog);
        }
    };
}

function loadAdminMenuSandbox(resolveQuery) {
    const elements = new Map();

    function fakeElement(id) {
        if (!elements.has(id)) {
            elements.set(id, {
                id, value: "", textContent: "", innerHTML: "",
                style: {}, checked: false, disabled: false
            });
        }
        return elements.get(id);
    }

    const fakeDocument = {
        addEventListener: () => {},
        getElementById: (id) => fakeElement(id),
        querySelector: () => null,
        createElement: () => ({ style: {}, innerHTML: "" }),
        body: { appendChild: () => {} }
    };

    const alertCalls = [];
    const confirmCalls = [];
    let confirmReturnValue = true;

    const supabaseClient = makeMockSupabase(resolveQuery);

    const sandbox = {
        document: fakeDocument,
        window: {},
        console,
        supabaseClient,
        alert: (msg) => alertCalls.push(msg),
        confirm: (msg) => { confirmCalls.push(msg); return confirmReturnValue; }
    };
    vm.createContext(sandbox);

    const source = [
        read("js/admin-menu.js"),
        `
        this.__deleteMenuItem = deleteMenuItem;
        this.__toggleMenuAvailability = toggleMenuAvailability;
        this.__countMenuItemReferences = countMenuItemReferences;
        `
    ].join("\n");

    vm.runInContext(source, sandbox);

    return {
        sandbox, elements, alertCalls, confirmCalls, supabaseClient,
        setConfirm(value) { confirmReturnValue = value; }
    };
}

function referenceResolver({ orderCount, saleCount }) {
    return (state) => {
        if (state.table === "order_items" && state.eq?.some(([f]) => f === "menu_item_id")) {
            return { data: null, count: orderCount, error: null };
        }
        if (state.table === "sale_items" && state.eq?.some(([f]) => f === "menu_item_id")) {
            return { data: null, count: saleCount, error: null };
        }
        if (state.table === "menu_items" && state.op === "delete") {
            return { data: [{ id: "item-1" }], error: null };
        }
        if (state.table === "menu_items" && state.op === "update") {
            return { data: [{ id: "item-1" }], error: null };
        }
        return { data: [], error: null };
    };
}

/* ---------------- Archive: always allowed, references or not ---------------- */

test("1. archiving a product referenced by a pending order succeeds and never touches order_items/sale_items", async () => {
    const { sandbox, supabaseClient } = loadAdminMenuSandbox(referenceResolver({ orderCount: 3, saleCount: 0 }));

    await sandbox.__toggleMenuAvailability("item-1", true); // available -> archive

    const updateCall = supabaseClient.callLog.find(c => c.table === "menu_items" && c.op === "update");
    assert.ok(updateCall, "must update menu_items");
    assert.equal(updateCall.payload.available, false);

    assert.ok(!supabaseClient.callLog.some(c => c.table === "order_items"), "archiving must never touch order_items");
    assert.ok(!supabaseClient.callLog.some(c => c.table === "sale_items"), "archiving must never touch sale_items");
});

test("2. archiving a product referenced by a completed order/sale still succeeds (archiving is never blocked)", async () => {
    const { sandbox, supabaseClient, alertCalls } = loadAdminMenuSandbox(referenceResolver({ orderCount: 1, saleCount: 1 }));

    await sandbox.__toggleMenuAvailability("item-1", true);

    const updateCall = supabaseClient.callLog.find(c => c.table === "menu_items" && c.op === "update");
    assert.ok(updateCall);
    assert.equal(updateCall.payload.available, false);
    assert.equal(alertCalls.length, 0, "no blocking message -- archive is always the normal, allowed action");
});

test("3. archiving a product referenced by a historical sale (order gone, sale remains) still succeeds", async () => {
    const { sandbox, supabaseClient } = loadAdminMenuSandbox(referenceResolver({ orderCount: 0, saleCount: 2 }));

    await sandbox.__toggleMenuAvailability("item-1", true);

    const updateCall = supabaseClient.callLog.find(c => c.table === "menu_items" && c.op === "update");
    assert.ok(updateCall);
    assert.equal(updateCall.payload.available, false);
});

test("4. restoring an archived product (Restore) flips it back to available", async () => {
    const { sandbox, supabaseClient } = loadAdminMenuSandbox(referenceResolver({ orderCount: 0, saleCount: 0 }));

    await sandbox.__toggleMenuAvailability("item-1", false); // currently archived -> restore

    const updateCall = supabaseClient.callLog.find(c => c.table === "menu_items" && c.op === "update");
    assert.equal(updateCall.payload.available, true);
});

/* ---------------- Permanent delete: reference-checked ---------------- */

test("5. permanently deleting a truly unused product (0 references) succeeds", async () => {
    const { sandbox, supabaseClient, setConfirm } = loadAdminMenuSandbox(referenceResolver({ orderCount: 0, saleCount: 0 }));
    setConfirm(true);

    await sandbox.__deleteMenuItem("item-1", "Test Seasonal Loaf");

    assert.ok(supabaseClient.callLog.some(c => c.table === "menu_items" && c.op === "delete"));
});

test("6. permanent deletion of a product referenced by orders is blocked -- no delete call is ever issued", async () => {
    const { sandbox, supabaseClient, alertCalls, setConfirm } = loadAdminMenuSandbox(referenceResolver({ orderCount: 5, saleCount: 0 }));
    setConfirm(true); // even if the admin would have confirmed, it must never reach that point

    await sandbox.__deleteMenuItem("item-1", "6 Peanut Butter Cup Cookies");

    assert.ok(!supabaseClient.callLog.some(c => c.table === "menu_items" && c.op === "delete"), "delete must never be issued");
    assert.equal(alertCalls.length, 1);
    assert.match(alertCalls[0], /5 order/);
    assert.match(alertCalls[0], /Archive/);
});

test("6b. permanent deletion of a product referenced only by historical sales (order since deleted) is also blocked", async () => {
    const { sandbox, supabaseClient, alertCalls, setConfirm } = loadAdminMenuSandbox(referenceResolver({ orderCount: 0, saleCount: 2 }));
    setConfirm(true);

    await sandbox.__deleteMenuItem("item-1", "12 Brown Butter Sea Salt Chocolate Chip Cookies");

    assert.ok(!supabaseClient.callLog.some(c => c.table === "menu_items" && c.op === "delete"));
    assert.match(alertCalls[0], /2 sale/);
});

test("7. a failed reference check refuses to delete rather than risk an unsafe delete", async () => {
    const resolveQuery = (state) => {
        if (state.table === "order_items" && state.eq?.some(([f]) => f === "menu_item_id")) {
            return { data: null, count: null, error: { message: "network error" } };
        }
        return { data: [], count: 0, error: null };
    };
    const { sandbox, supabaseClient, alertCalls, setConfirm } = loadAdminMenuSandbox(resolveQuery);
    setConfirm(true);

    await sandbox.__deleteMenuItem("item-1", "Some Product");

    assert.ok(!supabaseClient.callLog.some(c => c.table === "menu_items" && c.op === "delete"));
    assert.equal(alertCalls.length, 1);
    assert.match(alertCalls[0], /not deleted/i);
});

test("8. cancelling the confirm on a genuinely unused product deletes nothing", async () => {
    const { sandbox, supabaseClient, setConfirm } = loadAdminMenuSandbox(referenceResolver({ orderCount: 0, saleCount: 0 }));
    setConfirm(false);

    await sandbox.__deleteMenuItem("item-1", "Test Seasonal Loaf");

    assert.ok(!supabaseClient.callLog.some(c => c.table === "menu_items" && c.op === "delete"));
});

test("9. the Archive/Delete buttons are labeled and titled to clearly distinguish the two actions", () => {
    const source = read("js/admin-menu.js");
    assert.match(source, /\$\{item\.available \? "Archive" : "Restore"\}/);
    assert.match(source, /Permanently delete -- only allowed for an item that has never been used/);
    assert.match(source, />Archived</);
});

/* ---------------- Historical rendering never depends on the live menu_items row ---------------- */

test("10. historical order rendering (admin-orders.js) never joins or looks up menu_items -- renders from order_items' own frozen fields", () => {
    const source = read("js/admin-orders.js");
    // No embed/join syntax anywhere in this file's Supabase queries.
    assert.doesNotMatch(source, /select\(`[^`]*menu_items|select\("[^"]*menu_items/);
});

test("11. no historical-display Supabase query anywhere in the app embeds/inner-joins menu_items (which could hide an archived/deleted product's row)", () => {
    const files = ["js/admin-orders.js", "js/admin-sales.js", "js/admin-analytics.js", "js/admin-production.js"];
    files.forEach(file => {
        const source = read(file);
        assert.doesNotMatch(source, /select\(`[^`]*menu_items\(|select\("[^"]*menu_items\(/, `${file} must not embed menu_items into a historical query`);
    });
});

test("12. historical Sales/Analytics reclassification (classifySaleItems/buildProductBreakdown) works correctly for a sale referencing a since-deleted/archived product, using only frozen sale_items fields", () => {
    // Simulates exactly the audited scenario: order_items has no
    // builder_details (a plain standalone product), and its menu_item_id
    // is null (archived/deleted product) -- the sale must still show
    // its true historical revenue/cost/profit.
    const orderItems = [{ item_name: "6 Peanut Butter Cup Cookies", quantity: 1, price_at_purchase: 9, builder_details: null }];
    const saleItems = [{
        id: "s1", menu_item_id: null, item_name: "6 Peanut Butter Cup Cookies",
        quantity: 1, unit_price: 9, total_cost: 3.2, line_revenue: 9, line_profit: 5.8
    }];

    const classified = SaleCalculations.classifySaleItems(saleItems, orderItems);
    assert.equal(classified[0].bucketName, "6 Peanut Butter Cup Cookies");

    const breakdown = SaleCalculations.buildProductBreakdown(classified);
    assert.equal(breakdown.length, 1);
    assert.equal(breakdown[0].revenue, 9);
    assert.equal(breakdown[0].cost, 3.2);
    assert.equal(breakdown[0].profit, 5.8);
});

test("13. admin-sales.js's category lookup degrades to \"other\" (never throws, never hides revenue) when a sale_items row's product is archived/deleted", () => {
    const source = read("js/admin-sales.js");
    const fn = source.match(/function getItemCategory\(item\)\s*\{[\s\S]*?\n\}/)[0];
    assert.match(fn, /menuItem\?\.category \|\| "other"/, "must safely fall back, never crash, when the menu_items lookup finds nothing");
});

test("14. order-confirmation/status emails render from order_items' own stored fields only -- no menu_items dependency", () => {
    const source = read("supabase/functions/_shared/processOutbox.ts");
    assert.match(source, /select\("item_name, quantity, price_at_purchase, line_total"\)/);

    // Scoped to just the order_received/order_confirmed/order_cancelled/
    // admin_new_order branch (from its own `if` down to the next
    // email-type branch) -- NOT the whole file. Vacation Mode's
    // reopening-email branch legitimately reads menu_items (a live
    // published-menu read is the entire point of that feature); this
    // guard is specifically about order-status emails never depending
    // on current menu state, not a whole-file ban on the string.
    const orderBranch = source.slice(
        source.indexOf('if (row.email_type === "order_received" ||'),
        source.indexOf('if (row.email_type === "newsletter_welcome")')
    );
    assert.ok(orderBranch.length > 0, "order-email branch not found -- test needs updating to match processOutbox.ts's current structure");
    assert.doesNotMatch(orderBranch, /menu_items/);
});

test("15. the Sales CSV export renders every line from order_items' own item_name/quantity -- no menu_items dependency", () => {
    const source = read("js/admin-sales.js");
    const fn = source.match(/function exportSalesCsv\(\)\s*\{[\s\S]*?\n\}/)[0];
    assert.doesNotMatch(fn, /menu_items/);
    assert.match(fn, /item\.item_name/);
});

/* ---------------- Mix & Match eligibility: old packs vs current products ---------------- */

const SIX_BUILDER = { id: "b6", name: "6 Mix & Match Cookies", product_type: "builder", builder_group: "cookie", builder_size: 6, available: true };
const TWELVE_BUILDER = { id: "b12", name: "12 Mix & Match Cookies", product_type: "builder", builder_group: "cookie", builder_size: 12, available: true };

test("16. an archived old static six-cookie pack never appears in the Mix & Match selector", () => {
    const menuItems = [
        SIX_BUILDER, TWELVE_BUILDER,
        { id: "old-1", name: "6 Brown Butter Sea Salt Chocolate Chip Cookies", product_type: "standard", builder_group: "cookie", available: false },
        { id: "cur-1", name: "Brown Butter Sea Salt Chocolate Chip", product_type: "standard", builder_group: "cookie", available: true }
    ];

    const eligible = MixAndMatch.getEligibleCookies(menuItems, SIX_BUILDER);
    assert.deepEqual(eligible.map(c => c.name), ["Brown Butter Sea Salt Chocolate Chip"]);
});

test("17. an archived old static twelve-cookie pack never appears in the Mix & Match selector", () => {
    const menuItems = [
        SIX_BUILDER, TWELVE_BUILDER,
        { id: "old-2", name: "12 Peanut Butter Cup Cookies", product_type: "standard", builder_group: "cookie", available: false }
    ];

    assert.deepEqual(MixAndMatch.getEligibleCookies(menuItems, TWELVE_BUILDER), []);
});

test("18. current 6 and 12 Mix & Match products and every individually sold cookie remain fully functional, including newly added flavors", () => {
    const menuItems = [
        SIX_BUILDER, TWELVE_BUILDER,
        { id: "c1", name: "S'mores", product_type: "standard", builder_group: "cookie", available: true },
        { id: "c2", name: "Strawberry Shortcake", product_type: "standard", builder_group: "cookie", available: true },
        { id: "c3", name: "Browned Butter Snickerdoodle", product_type: "standard", builder_group: "cookie", available: true },
        // A brand-new flavor added after archiving the old packs -- must
        // work with zero code changes, per the eligibility rule being
        // driven entirely by builder_group/available/product_type.
        { id: "c4", name: "Maple Pecan Snap (New)", product_type: "standard", builder_group: "cookie", available: true }
    ];

    for (const builder of [SIX_BUILDER, TWELVE_BUILDER]) {
        const eligible = MixAndMatch.getEligibleCookies(menuItems, builder).map(c => c.name);
        assert.deepEqual(eligible.sort(), ["Browned Butter Snickerdoodle", "Maple Pecan Snap (New)", "S'mores", "Strawberry Shortcake"]);
    }
});

test("19. archiving never creates orphaned order_items or sale_items -- it never writes to either table (the subsequent list refresh only reads menu-catalog tables)", async () => {
    const { sandbox, supabaseClient } = loadAdminMenuSandbox(referenceResolver({ orderCount: 4, saleCount: 3 }));

    await sandbox.__toggleMenuAvailability("item-1", true);

    assert.ok(!supabaseClient.callLog.some(c => c.table === "order_items"));
    assert.ok(!supabaseClient.callLog.some(c => c.table === "sale_items"));
    assert.ok(supabaseClient.callLog.some(c => c.table === "menu_items" && c.op === "update"));
});

test("20. blocking a permanent delete leaves order_items and sale_items completely untouched (read-only reference check only)", async () => {
    const { sandbox, supabaseClient, setConfirm } = loadAdminMenuSandbox(referenceResolver({ orderCount: 2, saleCount: 1 }));
    setConfirm(true);

    await sandbox.__deleteMenuItem("item-1", "Referenced Product");

    // order_items/sale_items were only ever SELECTed (the reference
    // count), never written to.
    assert.ok(!supabaseClient.callLog.some(c => c.table === "order_items" && (c.op === "delete" || c.op === "update")));
    assert.ok(!supabaseClient.callLog.some(c => c.table === "sale_items" && (c.op === "delete" || c.op === "update")));
});

test("21. archived products stay off the live public menu and the admin New Order picker (both still filter on available = true)", () => {
    const menuSource = read("js/menu.js");
    assert.match(menuSource, /\.eq\("available",\s*true\)/);

    const ordersSource = read("js/admin-orders.js");
    const fn = ordersSource.match(/async function loadMenuItems\(\)\s*\{[\s\S]*?\n\}/)[0];
    assert.match(fn, /\.eq\("available",\s*true\)/);
});
