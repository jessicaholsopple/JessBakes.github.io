"use strict";

/* ==========================================
   Order-confirmation payment snapshot (js/admin-orders.js's
   updateOrderStatus, Confirm-button flow)

   Adds a "Payment Options" section (Cash/Zelle/PayPal/Venmo) to the
   existing order_confirmed email. Since customers never choose a
   payment method at checkout, the EUR->USD rate and the resulting
   floored whole-dollar USD amount are resolved and SNAPSHOTTED once,
   at the exact moment an order transitions pending -> confirmed --
   reusing the identical CurrencyConversion.resolveExchangeRate path
   js/admin-orders.js's own createSaleFromOrder already uses at sale
   completion (js/currency-conversion.js) -- and saved onto the order
   row (confirmation_exchange_rate / confirmation_exchange_rate_date /
   confirmation_usd_amount) so a later resend of the same email always
   reproduces the same amount.

   This runs the REAL js/admin-orders.js code in a node:vm sandbox
   (same technique as tests/admin-order-builder.test.js), with a
   minimal Supabase mock and controllable fetch/prompt, so the actual
   Confirm-button wiring is what's tested, not a reimplementation.
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

/* ==========================================
   A minimal, chainable + directly-awaitable Supabase mock covering
   exactly the shapes updateOrderStatus (and the rate-resolution
   helpers it calls) needs:
     - orders:         select(...).eq().maybeSingle()  and  update().eq()
     - orders (bulk):  select(...).order()... (loadOrderManager's list read)
     - exchange_rates: select(...).eq().maybeSingle()  and  upsert()
     - menu_items:     select(...).eq().order().order() (loadMenuItems)
   ========================================== */
function makeQueryBuilder({ list, single }) {
    const builder = {
        select() { return builder; },
        eq() { return builder; },
        order() { return builder; },
        limit() { return builder; },
        single() { return Promise.resolve({ data: single, error: null }); },
        maybeSingle() { return Promise.resolve({ data: single, error: null }); },
        then(onFulfilled, onRejected) {
            return Promise.resolve({ data: list, error: null }).then(onFulfilled, onRejected);
        }
    };
    return builder;
}

function makeSupabaseMock({ orderRow, exchangeRateRow = null }) {
    const updates = [];
    const upserts = [];

    return {
        updates,
        upserts,
        from(table) {
            return {
                select() {
                    if (table === "orders") {
                        return makeQueryBuilder({ list: [orderRow], single: orderRow });
                    }
                    if (table === "exchange_rates") {
                        return makeQueryBuilder({ list: exchangeRateRow ? [exchangeRateRow] : [], single: exchangeRateRow });
                    }
                    return makeQueryBuilder({ list: [], single: null });
                },
                update(payload) {
                    return {
                        eq(col, val) {
                            updates.push({ table, payload: { ...payload }, col, val });
                            if (table === "orders") Object.assign(orderRow, payload);
                            return Promise.resolve({ error: null });
                        }
                    };
                },
                upsert(payload) {
                    upserts.push({ table, payload: { ...payload } });
                    return Promise.resolve({ error: null });
                }
            };
        }
    };
}

function loadSandbox({ orderRow, exchangeRateRow = null, fetchImpl = null, promptImpl = null }) {
    const alerts = [];
    const supabaseMock = makeSupabaseMock({ orderRow, exchangeRateRow });

    const elements = new Map();
    function fakeElement(id) {
        if (!elements.has(id)) {
            elements.set(id, { id, innerHTML: "", textContent: "", style: {} });
        }
        return elements.get(id);
    }

    const fakeDocument = {
        addEventListener: () => {},
        getElementById: (id) => (id === "orderManager" ? null : fakeElement(id)), // null short-circuits loadOrderManager's render
        querySelector: (selector) => fakeElement(selector),
        createElement: () => ({ style: {} }),
        body: { appendChild: () => {} }
    };

    const sandbox = {
        document: fakeDocument,
        window: { location: { search: "" } },
        console,
        alert: (msg) => alerts.push(msg),
        confirm: () => true,
        prompt: promptImpl || (() => null),
        fetch: fetchImpl || (() => Promise.reject(new Error("no fetch configured for this test"))),
        crypto: { randomUUID: () => "test-uuid" },
        supabaseClient: supabaseMock
    };
    vm.createContext(sandbox);

    const source = [
        read("js/currency-conversion.js"),
        read("js/admin-orders.js"),
        `
        this.__updateOrderStatus = updateOrderStatus;
        `
    ].join("\n");

    vm.runInContext(source, sandbox);

    return { sandbox, alerts, supabaseMock };
}

function frankfurterOk(rate, date) {
    return () => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ rates: { USD: rate }, date })
    });
}

function frankfurterFails() {
    return () => Promise.resolve({ ok: false });
}

/* ==========================================
   Happy path: cached rate already on file for today
   ========================================== */

test("1. confirming a pending order snapshots the exchange rate and the correctly floored USD amount", async () => {
    const today = new Date().toISOString().split("T")[0];
    const orderRow = { id: "order-1", status: "pending", subtotal: 25.00 };
    const { sandbox, supabaseMock, alerts } = loadSandbox({
        orderRow,
        exchangeRateRow: { rate_date: today, reference_date: today, rate: 1.1652, source: "ecb_frankfurter" }
    });

    await sandbox.__updateOrderStatus("order-1", "confirmed");

    assert.equal(alerts.length, 0, "no error alert on the happy path");

    const orderUpdate = supabaseMock.updates.find(u => u.table === "orders");
    assert.ok(orderUpdate, "the order row must be updated");
    assert.equal(orderUpdate.payload.status, "confirmed");
    assert.equal(orderUpdate.payload.confirmation_exchange_rate, 1.1652);
    assert.equal(orderUpdate.payload.confirmation_exchange_rate_date, today);
    // 25 * 1.1652 = 29.13 -> floored -> 29 (the exact spec example).
    assert.equal(orderUpdate.payload.confirmation_usd_amount, 29);
});

test("2. a cached rate is used without ever calling the live fetch or prompting the admin", async () => {
    const today = new Date().toISOString().split("T")[0];
    const orderRow = { id: "order-2", status: "pending", subtotal: 50.00 };
    let fetchCalled = false;
    let promptCalled = false;

    const { sandbox } = loadSandbox({
        orderRow,
        exchangeRateRow: { rate_date: today, reference_date: today, rate: 1.10, source: "ecb_frankfurter" },
        fetchImpl: () => { fetchCalled = true; return Promise.reject(new Error("should not be called")); },
        promptImpl: () => { promptCalled = true; return null; }
    });

    await sandbox.__updateOrderStatus("order-2", "confirmed");

    assert.equal(fetchCalled, false);
    assert.equal(promptCalled, false);
});

/* ==========================================
   Failure path: no cached rate, live fetch fails, admin declines the
   manual prompt -- must block the confirmation and use the existing
   Confirm-button alert() feedback, never send a guessed amount.
   ========================================== */

test("3. when no exchange rate can be resolved, the order is NOT confirmed and a useful error is shown via alert()", async () => {
    const orderRow = { id: "order-3", status: "pending", subtotal: 25.00 };
    const { sandbox, supabaseMock, alerts } = loadSandbox({
        orderRow,
        exchangeRateRow: null,
        fetchImpl: frankfurterFails(),
        promptImpl: () => null // admin declines
    });

    await sandbox.__updateOrderStatus("order-3", "confirmed");

    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /exchange rate/i);
    assert.match(alerts[0], /not confirmed/i);

    const orderUpdate = supabaseMock.updates.find(u => u.table === "orders");
    assert.equal(orderUpdate, undefined, "no update of any kind must be written when the rate cannot be resolved");
    assert.equal(orderRow.status, "pending", "the order must remain pending");
});

test("4. a live fetch failure falls back to a manual rate entered by the admin, and that rate is what gets snapshotted", async () => {
    const orderRow = { id: "order-4", status: "pending", subtotal: 25.00 };
    const { sandbox, supabaseMock } = loadSandbox({
        orderRow,
        exchangeRateRow: null,
        fetchImpl: frankfurterFails(),
        promptImpl: () => "1.2000"
    });

    await sandbox.__updateOrderStatus("order-4", "confirmed");

    const orderUpdate = supabaseMock.updates.find(u => u.table === "orders");
    assert.equal(orderUpdate.payload.confirmation_exchange_rate, 1.2);
    // 25 * 1.2 = 30 exactly.
    assert.equal(orderUpdate.payload.confirmation_usd_amount, 30);
});

/* ==========================================
   Unaffected transitions -- the rate is resolved ONLY on a genuine
   pending -> confirmed transition, exactly mirroring the DB trigger's
   own `old.status is distinct from 'confirmed'` guard.
   ========================================== */

test("5. cancelling an order never touches exchange-rate resolution or the payment snapshot columns", async () => {
    const orderRow = { id: "order-5", status: "pending", subtotal: 25.00 };
    let fetchCalled = false;

    const { sandbox, supabaseMock } = loadSandbox({
        orderRow,
        fetchImpl: () => { fetchCalled = true; return Promise.reject(new Error("must not be called")); }
    });

    await sandbox.__updateOrderStatus("order-5", "cancelled");

    assert.equal(fetchCalled, false);
    const orderUpdate = supabaseMock.updates.find(u => u.table === "orders");
    assert.equal(orderUpdate.payload.status, "cancelled");
    assert.equal("confirmation_exchange_rate" in orderUpdate.payload, false);
    assert.equal("confirmation_usd_amount" in orderUpdate.payload, false);
});

test("6. re-clicking Confirm on an already-confirmed order is a no-op that never re-resolves or re-prompts for a rate", async () => {
    const orderRow = { id: "order-6", status: "confirmed", subtotal: 25.00 };
    let fetchCalled = false;
    let promptCalled = false;

    const { sandbox, supabaseMock } = loadSandbox({
        orderRow,
        fetchImpl: () => { fetchCalled = true; return Promise.reject(new Error("must not be called")); },
        promptImpl: () => { promptCalled = true; return null; }
    });

    await sandbox.__updateOrderStatus("order-6", "confirmed");

    assert.equal(fetchCalled, false);
    assert.equal(promptCalled, false);
    const orderUpdate = supabaseMock.updates.find(u => u.table === "orders");
    assert.equal("confirmation_usd_amount" in orderUpdate.payload, false);
});

/* ==========================================
   Resending preserves the snapshot -- proven at the template/outbox
   level in tests/email-shared.test.js (same usdAmount always renders
   identically); here we prove the snapshot, once written, is never
   silently overwritten by a second confirm attempt on the same order.
   ========================================== */

test("7. the snapshot columns are exactly the floored, decimal-safe amount -- never the unrounded or cent-rounded figure", async () => {
    const today = new Date().toISOString().split("T")[0];
    const orderRow = { id: "order-7", status: "pending", subtotal: 25.00 };
    const { sandbox, supabaseMock } = loadSandbox({
        orderRow,
        // A rate that produces $29.99 (not $30) once converted.
        exchangeRateRow: { rate_date: today, reference_date: today, rate: 1.1996, source: "ecb_frankfurter" }
    });

    await sandbox.__updateOrderStatus("order-7", "confirmed");

    const orderUpdate = supabaseMock.updates.find(u => u.table === "orders");
    // 25 * 1.1996 = 29.99 -> floors to 29, never rounds to 30.
    assert.equal(orderUpdate.payload.confirmation_usd_amount, 29);
});
