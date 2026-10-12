"use strict";

/* ==========================================
   Finished-product freezer stock -- admin Orders integration
   (js/admin-orders.js).

   Covers:
     - orderInvolvesLimitedStock(): the heads-up check behind the
       delete flow's second, stock-specific confirmation.
     - deleteOrder(): the stock confirmation fires AFTER the existing
       generic confirm() (so declining the first one still makes zero
       Supabase calls, preserving tests/delete-order.test.js's own
       guarantee), and declining the SECOND one also aborts cleanly
       with no delete.
     - saveManualOrder()'s order-items write path is checked
       structurally (RPC name + params) rather than fully simulated --
       see js/admin-menu-stock.js's own test file for the same,
       deliberate tradeoff and its reasoning.

   Same node:vm sandbox technique as tests/delete-order.test.js, with
   a query builder additionally supporting .in().
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
        eq(field, value) {
            state.eq = state.eq || [];
            state.eq.push([field, value]);
            callLog.push({ ...state, op: "eq", field, value });
            return builder;
        },
        in(field, values) {
            state.in = [field, values];
            callLog.push({ ...state, op: "in", field, values });
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

function makeMockSupabase(resolveQuery, rpcHandler) {
    const callLog = [];
    const rpcCalls = [];
    const client = {
        callLog,
        rpcCalls,
        from(table) {
            return makeQueryBuilder({ table }, resolveQuery, callLog);
        },
        rpc(name, params) {
            rpcCalls.push({ name, params });
            return Promise.resolve((rpcHandler && rpcHandler(name, params)) || { data: null, error: null });
        }
    };
    return client;
}

function loadAdminOrdersSandbox(resolveQuery, rpcHandler) {
    const elements = new Map();

    function fakeElement(id) {
        if (!elements.has(id)) {
            elements.set(id, {
                id, value: "", textContent: "", innerHTML: "",
                style: {}, checked: false, disabled: false, title: ""
            });
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

    const confirmCalls = [];
    const alertCalls = [];
    let confirmReturnValues = [true];
    let confirmCallIndex = 0;

    const supabaseClient = makeMockSupabase(resolveQuery, rpcHandler);

    const sandbox = {
        document: fakeDocument,
        window: {},
        console,
        supabaseClient,
        alert: (msg) => alertCalls.push(msg),
        confirm: (msg) => {
            confirmCalls.push(msg);
            const value = confirmReturnValues[confirmCallIndex] !== undefined ? confirmReturnValues[confirmCallIndex] : true;
            confirmCallIndex++;
            return value;
        },
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
        this.__deleteOrder = deleteOrder;
        this.__orderInvolvesLimitedStock = orderInvolvesLimitedStock;
        `
    ].join("\n");

    vm.runInContext(source, sandbox);

    return {
        sandbox,
        elements,
        confirmCalls,
        alertCalls,
        supabaseClient,
        setConfirmSequence(values) { confirmReturnValues = values; confirmCallIndex = 0; }
    };
}

/* ==========================================
   orderInvolvesLimitedStock
========================================== */

test("1. returns true when a standalone order_item references a limited-stock menu item", async () => {
    const resolveQuery = (state) => {
        if (state.table === "order_items") {
            return { data: [{ menu_item_id: "a", builder_details: null }], error: null };
        }
        if (state.table === "menu_item_stock") {
            return { data: [{ menu_item_id: "a" }], error: null };
        }
        return { data: [], error: null };
    };
    const { sandbox } = loadAdminOrdersSandbox(resolveQuery);

    assert.equal(await sandbox.__orderInvolvesLimitedStock("order-1"), true);
});

test("2. returns true when a Mix & Match box's selection references a limited-stock flavor", async () => {
    const resolveQuery = (state) => {
        if (state.table === "order_items") {
            return {
                data: [{ menu_item_id: null, builder_details: { builder_group: "cookie", selections: [{ id: "flavor-1", quantity: 2 }] } }],
                error: null
            };
        }
        if (state.table === "menu_item_stock") {
            return { data: [{ menu_item_id: "flavor-1" }], error: null };
        }
        return { data: [], error: null };
    };
    const { sandbox } = loadAdminOrdersSandbox(resolveQuery);

    assert.equal(await sandbox.__orderInvolvesLimitedStock("order-1"), true);
});

test("3. returns false when no item in the order is currently limited-stock", async () => {
    const resolveQuery = (state) => {
        if (state.table === "order_items") {
            return { data: [{ menu_item_id: "a", builder_details: null }], error: null };
        }
        if (state.table === "menu_item_stock") {
            return { data: [], error: null }; // "a" not in the limited set
        }
        return { data: [], error: null };
    };
    const { sandbox } = loadAdminOrdersSandbox(resolveQuery);

    assert.equal(await sandbox.__orderInvolvesLimitedStock("order-1"), false);
});

test("4. fails safe (false) on a query error -- never blocks or crashes the delete flow", async () => {
    const resolveQuery = (state) => {
        if (state.table === "order_items") {
            return { data: null, error: { message: "boom" } };
        }
        return { data: [], error: null };
    };
    const { sandbox } = loadAdminOrdersSandbox(resolveQuery);

    assert.equal(await sandbox.__orderInvolvesLimitedStock("order-1"), false);
});

test("5. returns false immediately for an order with no items at all -- no menu_item_stock query needed", async () => {
    const resolveQuery = (state) => {
        if (state.table === "order_items") {
            return { data: [], error: null };
        }
        if (state.table === "menu_item_stock") {
            throw new Error("must not query menu_item_stock when there are no items");
        }
        return { data: [], error: null };
    };
    const { sandbox } = loadAdminOrdersSandbox(resolveQuery);

    assert.equal(await sandbox.__orderInvolvesLimitedStock("order-1"), false);
});

/* ==========================================
   deleteOrder -- two-stage confirmation
========================================== */

test("6. declining the FIRST (generic) confirm makes zero Supabase calls -- the stock check never runs either", async () => {
    const { sandbox, supabaseClient, setConfirmSequence } = loadAdminOrdersSandbox(() => ({ data: null, error: null }));
    setConfirmSequence([false]);

    await sandbox.__deleteOrder("order-1", "Jamie Rivera", "Aug 30, 2026", "pending");

    assert.equal(supabaseClient.callLog.length, 0);
});

test("7. an order involving limited stock shows a SECOND, stock-specific confirmation after the first", async () => {
    const resolveQuery = (state) => {
        if (state.table === "orders" && state.op === "maybeSingle") {
            return { data: { status: "pending" }, error: null };
        }
        if (state.table === "order_items") {
            return { data: [{ menu_item_id: "a", builder_details: null }], error: null };
        }
        if (state.table === "menu_item_stock") {
            return { data: [{ menu_item_id: "a" }], error: null };
        }
        if (state.table === "orders" && state.op === "delete") {
            return { data: [{ id: "order-1" }], error: null };
        }
        return { data: [], error: null };
    };
    const { sandbox, confirmCalls, setConfirmSequence } = loadAdminOrdersSandbox(resolveQuery);
    setConfirmSequence([true, true]);

    await sandbox.__deleteOrder("order-1", "Jamie Rivera", "Aug 30, 2026", "pending");

    assert.equal(confirmCalls.length, 2);
    assert.match(confirmCalls[1], /limited-stock/i);
    assert.match(confirmCalls[1], /restore/i);
});

test("8. declining the SECOND (stock) confirmation aborts without deleting", async () => {
    const resolveQuery = (state) => {
        if (state.table === "orders" && state.op === "maybeSingle") {
            return { data: { status: "pending" }, error: null };
        }
        if (state.table === "order_items") {
            return { data: [{ menu_item_id: "a", builder_details: null }], error: null };
        }
        if (state.table === "menu_item_stock") {
            return { data: [{ menu_item_id: "a" }], error: null };
        }
        if (state.table === "orders" && state.op === "delete") {
            throw new Error("must never delete after declining the stock confirmation");
        }
        return { data: [], error: null };
    };
    const { sandbox, supabaseClient, setConfirmSequence } = loadAdminOrdersSandbox(resolveQuery);
    setConfirmSequence([true, false]);

    await sandbox.__deleteOrder("order-1", "Jamie Rivera", "Aug 30, 2026", "pending");

    assert.ok(!supabaseClient.callLog.some(c => c.op === "delete"));
});

test("9. an order with no limited-stock involvement only ever shows the one generic confirmation", async () => {
    const resolveQuery = (state) => {
        if (state.table === "orders" && state.op === "maybeSingle") {
            return { data: { status: "pending" }, error: null };
        }
        if (state.table === "order_items") {
            return { data: [{ menu_item_id: "a", builder_details: null }], error: null };
        }
        if (state.table === "menu_item_stock") {
            return { data: [], error: null };
        }
        if (state.table === "orders" && state.op === "delete") {
            return { data: [{ id: "order-1" }], error: null };
        }
        return { data: [], error: null };
    };
    const { sandbox, confirmCalls, setConfirmSequence } = loadAdminOrdersSandbox(resolveQuery);
    setConfirmSequence([true]);

    await sandbox.__deleteOrder("order-1", "Jamie Rivera", "Aug 30, 2026", "pending");

    assert.equal(confirmCalls.length, 1);
});

/* ==========================================
   saveManualOrder -- structural RPC wiring check
========================================== */

const adminOrdersSource = read("js/admin-orders.js");

test("10. editing an order's items goes through admin_replace_order_items, never a direct order_items.delete()", () => {
    const saveManualOrderFn = adminOrdersSource.slice(adminOrdersSource.indexOf("async function saveManualOrder"));
    assert.match(saveManualOrderFn, /supabaseClient\.rpc\("admin_replace_order_items", \{/);
    assert.match(saveManualOrderFn, /p_order_id: order\.id,\s*\n\s*p_items: orderItems/);
    assert.doesNotMatch(saveManualOrderFn.slice(0, saveManualOrderFn.indexOf('rpc("admin_replace_order_items"')), /\.from\("order_items"\)\s*\n\s*\.delete\(\)/);
});

test("11. creating a brand-new order still inserts order_items directly (nothing to atomically replace)", () => {
    const saveManualOrderFn = adminOrdersSource.slice(adminOrdersSource.indexOf("async function saveManualOrder"));
    assert.match(saveManualOrderFn, /\.from\("order_items"\)\s*\n\s*\.insert\(orderItems\)/);
});
