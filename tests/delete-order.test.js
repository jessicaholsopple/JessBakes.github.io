"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

function read(relPath) {
    return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

/* ==========================================
   Regression coverage for the broken Delete button on admin Orders.

   Diagnosis: the confirm dialog never identified which order was about
   to be deleted; there was no live re-check of the order's status right
   before deleting, so a completed order (which owns a permanent, frozen
   `sales` record) could be deleted -- orders.order_id -> sales.order_id
   is ON DELETE SET NULL, not RESTRICT, so this would silently orphan
   that sale instead of failing loudly; there was no loading state on
   the button and no check that the delete actually removed a row -- a
   Postgres RLS policy that blocks a DELETE affects 0 rows with NO
   error, so a silently-blocked delete would look identical to success
   with nothing happening.

   Fix (js/admin-orders.js deleteOrder): the confirm dialog now shows
   the customer name and date (passed straight from the button's own
   onclick -- no network round-trip needed to show it); the order's
   live status is re-checked via OrderEditor.isOrderEditable (the same
   BUG-22 guard already used for editing) before deleting, with a clear
   explanatory message if it's already completed; the delete call ends
   with .select("id") so an empty result (RLS-blocked or already gone)
   is distinguishable from a real success and reported clearly; the
   button shows "Deleting..." and is restored on every failure path.

   Tests run against the REAL js/admin-orders.js code in a vm sandbox
   (same technique as tests/admin-order-builder.test.js), with a mock
   Supabase query builder that records every call made.
   ========================================== */

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

function loadAdminOrdersSandbox(resolveQuery) {
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

    const querySelectorTargets = {
        "#manualOrderModal .modal-header h2": "manualModalTitle",
        "#manualOrderModal .modal-footer .primary-btn": "manualSaveButton"
    };

    const fakeDocument = {
        addEventListener: () => {},
        getElementById: (id) => fakeElement(id),
        querySelector: (selector) => fakeElement(querySelectorTargets[selector] || selector),
        createElement: () => ({ style: {} }),
        body: { appendChild: () => {} }
    };

    const confirmCalls = [];
    const alertCalls = [];
    let confirmReturnValue = true;

    const supabaseClient = makeMockSupabase(resolveQuery);

    const sandbox = {
        document: fakeDocument,
        window: {},
        console,
        supabaseClient,
        alert: (msg) => alertCalls.push(msg),
        confirm: (msg) => { confirmCalls.push(msg); return confirmReturnValue; },
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
        `
    ].join("\n");

    vm.runInContext(source, sandbox);

    return {
        sandbox,
        elements,
        confirmCalls,
        alertCalls,
        supabaseClient,
        setConfirm(value) { confirmReturnValue = value; }
    };
}

test("1. the confirmation identifies the correct customer and date", async () => {
    const { sandbox, confirmCalls, supabaseClient, setConfirm } = loadAdminOrdersSandbox(() => ({ data: null, error: null }));
    setConfirm(false); // decline -- proves nothing further runs either

    await sandbox.__deleteOrder("order-1", "Jamie Rivera", "Aug 30, 2026", "pending");

    assert.equal(confirmCalls.length, 1);
    assert.match(confirmCalls[0], /Jamie Rivera/);
    assert.match(confirmCalls[0], /Aug 30, 2026/);
});

test("2. cancelling the confirmation makes no Supabase calls at all -- nothing changes", async () => {
    const { sandbox, supabaseClient, setConfirm } = loadAdminOrdersSandbox(() => ({ data: null, error: null }));
    setConfirm(false);

    await sandbox.__deleteOrder("order-1", "Jamie Rivera", "Aug 30, 2026", "pending");

    assert.equal(supabaseClient.callLog.length, 0);
});

test("3. confirming deletes a non-completed order and verifies a row was actually removed", async () => {
    const resolveQuery = (state) => {
        if (state.table === "orders" && state.op === "maybeSingle") {
            return { data: { status: "pending" }, error: null };
        }
        if (state.table === "orders" && state.op === "delete") {
            return { data: [{ id: "order-1" }], error: null };
        }
        return { data: [], error: null }; // loadOrderManager's list refetch
    };

    const { sandbox, alertCalls, supabaseClient, setConfirm } = loadAdminOrdersSandbox(resolveQuery);
    setConfirm(true);

    await sandbox.__deleteOrder("order-1", "Jamie Rivera", "Aug 30, 2026", "pending");

    const deleteCall = supabaseClient.callLog.find(c => c.op === "delete");
    assert.ok(deleteCall, "must issue a delete against orders");

    // the delete().eq("id", orderId) call itself:
    assert.ok(supabaseClient.callLog.some(c => c.field === "id" && c.value === "order-1"));

    assert.equal(alertCalls.length, 0, "no error/warning alert on a clean success");
});

test("4. a completed order is never deleted -- the UI explains why instead of silently failing or succeeding", async () => {
    const resolveQuery = (state) => {
        if (state.table === "orders" && state.op === "maybeSingle") {
            return { data: { status: "completed" }, error: null };
        }
        // A delete call here would be the bug -- fail loudly if one happens.
        if (state.table === "orders" && state.op === "delete") {
            throw new Error("must never call delete on a completed order");
        }
        return { data: [], error: null };
    };

    const { sandbox, alertCalls, supabaseClient, setConfirm } = loadAdminOrdersSandbox(resolveQuery);
    setConfirm(true);

    await sandbox.__deleteOrder("order-1", "Jamie Rivera", "Aug 30, 2026", "completed");

    assert.ok(!supabaseClient.callLog.some(c => c.op === "delete"), "delete must never be issued for a completed order");
    assert.equal(alertCalls.length, 1);
    assert.match(alertCalls[0], /completed/i);
    assert.match(alertCalls[0], /sales record|sale/i);
});

test("5. an order completed by someone else since the page loaded is caught by the live re-check, not the stale onclick status", async () => {
    // The button's own onclick still says "pending" (stale, from when the
    // page was rendered) -- the live re-check must still block it.
    const resolveQuery = (state) => {
        if (state.table === "orders" && state.op === "maybeSingle") {
            return { data: { status: "completed" }, error: null };
        }
        if (state.table === "orders" && state.op === "delete") {
            throw new Error("must never call delete once the live check finds it completed");
        }
        return { data: [], error: null };
    };

    const { sandbox, alertCalls, setConfirm } = loadAdminOrdersSandbox(resolveQuery);
    setConfirm(true);

    await sandbox.__deleteOrder("order-1", "Jamie Rivera", "Aug 30, 2026", "pending");

    assert.match(alertCalls[0], /completed/i);
});

test("6. an RLS-blocked delete (0 rows affected, no error) is reported clearly, not silently treated as success", async () => {
    const resolveQuery = (state) => {
        if (state.table === "orders" && state.op === "maybeSingle") {
            return { data: { status: "pending" }, error: null };
        }
        if (state.table === "orders" && state.op === "delete") {
            return { data: [], error: null }; // the exact silent-RLS-block shape
        }
        return { data: [], error: null };
    };

    const { sandbox, alertCalls, setConfirm } = loadAdminOrdersSandbox(resolveQuery);
    setConfirm(true);

    await sandbox.__deleteOrder("order-1", "Jamie Rivera", "Aug 30, 2026", "pending");

    assert.equal(alertCalls.length, 1);
    assert.match(alertCalls[0], /permission|already been removed/i);
});

test("7. a real database error during delete shows a useful message and restores the button from its loading state", async () => {
    const resolveQuery = (state) => {
        if (state.table === "orders" && state.op === "maybeSingle") {
            return { data: { status: "pending" }, error: null };
        }
        if (state.table === "orders" && state.op === "delete") {
            return { data: null, error: { message: "network error" } };
        }
        return { data: [], error: null };
    };

    const { sandbox, alertCalls, elements: els, setConfirm } = loadAdminOrdersSandbox(resolveQuery);
    setConfirm(true);
    els.set("delete-btn-order-1", { id: "delete-btn-order-1", textContent: "Delete", disabled: false });

    await sandbox.__deleteOrder("order-1", "Jamie Rivera", "Aug 30, 2026", "pending");

    assert.equal(alertCalls.length, 1);
    assert.match(alertCalls[0], /network error/);

    const button = els.get("delete-btn-order-1");
    assert.equal(button.disabled, false, "button must be restored (re-enabled) after a failure");
    assert.equal(button.textContent, "Delete", "button label must be restored, not stuck on \"Deleting...\"");
});

test("8. the button shows a loading state while the delete is in flight", async () => {
    let sawLoadingState = false;

    const resolveQuery = (state) => {
        if (state.table === "orders" && state.op === "maybeSingle") {
            const button = elementsRef.get("delete-btn-order-1");
            if (button && button.disabled && button.textContent === "Deleting...") {
                sawLoadingState = true;
            }
            return { data: { status: "pending" }, error: null };
        }
        if (state.table === "orders" && state.op === "delete") {
            return { data: [{ id: "order-1" }], error: null };
        }
        return { data: [], error: null };
    };

    const { sandbox, elements: elementsRef, setConfirm } = loadAdminOrdersSandbox(resolveQuery);
    setConfirm(true);
    elementsRef.set("delete-btn-order-1", { id: "delete-btn-order-1", textContent: "Delete", disabled: false });

    await sandbox.__deleteOrder("order-1", "Jamie Rivera", "Aug 30, 2026", "pending");

    assert.ok(sawLoadingState, "the button must be disabled and show \"Deleting...\" while the request is in flight");
});

test("9. the order list (and therefore status counts) refreshes after a successful delete", async () => {
    let orderListRefetched = false;

    const resolveQuery = (state) => {
        if (state.table === "orders" && state.op === "maybeSingle") {
            return { data: { status: "pending" }, error: null };
        }
        if (state.table === "orders" && state.op === "delete") {
            return { data: [{ id: "order-1" }], error: null };
        }
        if (state.table === "orders" && state.order) {
            orderListRefetched = true;
            return { data: [], error: null };
        }
        return { data: [], error: null };
    };

    const { sandbox, setConfirm } = loadAdminOrdersSandbox(resolveQuery);
    setConfirm(true);

    await sandbox.__deleteOrder("order-1", "Jamie Rivera", "Aug 30, 2026", "pending");

    assert.ok(orderListRefetched, "loadOrderManager must re-fetch the full order list (which recomputes status counts) after a successful delete");
});

test("10. deleting an order never touches sales or sale_items -- only orders is called", async () => {
    const resolveQuery = (state) => {
        if (state.table === "orders" && state.op === "maybeSingle") {
            return { data: { status: "pending" }, error: null };
        }
        if (state.table === "orders" && state.op === "delete") {
            return { data: [{ id: "order-1" }], error: null };
        }
        return { data: [], error: null };
    };

    const { sandbox, supabaseClient, setConfirm } = loadAdminOrdersSandbox(resolveQuery);
    setConfirm(true);

    await sandbox.__deleteOrder("order-1", "Jamie Rivera", "Aug 30, 2026", "pending");

    assert.ok(!supabaseClient.callLog.some(c => c.table === "sales"));
    assert.ok(!supabaseClient.callLog.some(c => c.table === "sale_items"));
});

test("11. the delete button's onclick passes the customer name, date, and status straight from the rendered order -- render-level regression guard", () => {
    const source = read("js/admin-orders.js");
    assert.match(
        source,
        /id="delete-btn-\$\{order\.id\}"\s*\n\s*onclick="deleteOrder\('\$\{order\.id\}',\s*'\$\{escapeJs\(order\.customer_name\)\}',\s*'\$\{escapeJs\(formatDate\(order\.pickup_date \|\| order\.event_date\)\)\}',\s*'\$\{order\.status\}'\)"/
    );
});

test("12. Edit and the Mix & Match embedded selector are completely unaffected by the delete fix", () => {
    const source = read("js/admin-orders.js");
    // Same checks as tests/admin-order-builder.test.js's render-level
    // regression guards -- confirms this change didn't touch that code.
    assert.match(source, /function renderManualBuilderBoxItem\(item\)/);
    assert.match(source, /function changeManualBuilderCookieQuantity\(/);
    assert.match(source, /onclick="editOrder\('\$\{order\.id\}'\)"/);
});
