"use strict";

/* ==========================================
   Vacation Mode order-submission guard (js/cart.js)

   Covers the two guard points added to js/cart.js:
   openCheckoutModal() and submitOrder(). Both re-check
   vacation_periods live (never a cached flag) and short-circuit with
   a friendly alert() + no order-related Supabase call when a vacation
   cycle is active -- see the header comment on
   isOrderingPausedForVacation() in js/cart.js for why this exists
   independently of js/menu.js's own gate.

   Uses the same node:vm sandbox technique as
   tests/delete-order.test.js / tests/menu-item-archive.test.js:
   concatenate the real source files into one vm context with fake
   document/supabaseClient/alert globals, then call the exposed
   functions directly.
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

/** Minimal Supabase mock: only `vacation_periods` is ever expected to
 *  be queried by the guard itself. Any other table access is recorded
 *  so a test can assert the guard never touches ballot/order tables. */
function makeSupabaseClient(vacationRow) {
    const callLog = [];
    return {
        callLog,
        from(table) {
            callLog.push(table);
            if (table === "vacation_periods") {
                return {
                    select() {
                        return { maybeSingle: () => Promise.resolve({ data: vacationRow, error: null }) };
                    }
                };
            }
            return {
                select() { return { maybeSingle: () => Promise.resolve({ data: null, error: null }), eq() { return this; }, insert() { return this; } }; },
                insert() { return { select() { return { single: () => Promise.resolve({ data: null, error: null }) }; } }; }
            };
        }
    };
}

// Matches js/cart.js's own `const CART_KEY = "jess_bakes_cart";` -- cart
// is a top-level `let`, which node:vm does NOT expose as a mutable
// context property, so the only reliable way to seed it for a test is
// through localStorage, read once at module-load time, exactly like a
// real page load.
const CART_KEY = "jess_bakes_cart";

function loadCartSandbox(vacationRow, cartItems) {
    const elements = new Map();
    function fakeElement(id) {
        if (!elements.has(id)) {
            elements.set(id, { id, value: "", textContent: "", innerHTML: "", style: {}, disabled: false });
        }
        return elements.get(id);
    }

    const alertCalls = [];
    const store = new Map();
    if (cartItems !== undefined) {
        store.set(CART_KEY, JSON.stringify(cartItems));
    }
    const supabaseClient = makeSupabaseClient(vacationRow);

    const fakeDocument = {
        addEventListener: () => {},
        getElementById: (id) => fakeElement(id),
        querySelector: () => fakeElement("__query__"),
        createElement: () => ({ style: {}, classList: { add: () => {} }, appendChild: () => {}, addEventListener: () => {} }),
        body: { appendChild: () => {} }
    };

    const sandbox = {
        document: fakeDocument,
        window: {},
        console,
        supabaseClient,
        alert: (msg) => alertCalls.push(msg),
        confirm: () => true,
        crypto: { randomUUID: () => "test-uuid" },
        localStorage: {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => store.set(k, v)
        }
    };
    vm.createContext(sandbox);

    const source = [
        read("js/vacation-mode.js"),
        read("js/mix-and-match.js"),
        read("js/cart.js"),
        `
        this.__openCheckoutModal = openCheckoutModal;
        this.__submitOrder = submitOrder;
        this.__isOrderingPausedForVacation = isOrderingPausedForVacation;
        `
    ].join("\n");

    vm.runInContext(source, sandbox);

    return { sandbox, elements, alertCalls, supabaseClient, fakeElement };
}

test("1. isOrderingPausedForVacation returns true while a vacation cycle is active", async () => {
    const { sandbox } = loadCartSandbox({ id: "cycle-1" });
    const result = await sandbox.__isOrderingPausedForVacation();
    assert.equal(result, true);
});

test("2. isOrderingPausedForVacation returns false when no vacation is active", async () => {
    const { sandbox } = loadCartSandbox(null);
    const result = await sandbox.__isOrderingPausedForVacation();
    assert.equal(result, false);
});

test("3. isOrderingPausedForVacation fails OPEN on a query error (never blocks ordinary ordering on an unrelated glitch)", async () => {
    const { sandbox, supabaseClient } = loadCartSandbox(null);
    supabaseClient.from = (table) => {
        supabaseClient.callLog.push(table);
        return { select() { return { maybeSingle: () => Promise.resolve({ data: null, error: { message: "boom" } }) }; } };
    };
    const result = await sandbox.__isOrderingPausedForVacation();
    assert.equal(result, false);
});

test("5. openCheckoutModal: vacation active -> alert shown, modal never opened, no cart/order table touched", async () => {
    const { sandbox, elements, alertCalls, supabaseClient } = loadCartSandbox(
        { id: "cycle-1" },
        [{ id: "1", name: "Cookie", price: 3, quantity: 1 }]
    );

    await sandbox.__openCheckoutModal();

    assert.equal(alertCalls.length, 1);
    assert.match(alertCalls[0], /baking break/i);
    // Blocked before the modal element is ever even looked up.
    assert.equal(elements.has("checkoutModal"), false);
    assert.ok(!supabaseClient.callLog.includes("orders"));
});

test("6. openCheckoutModal: vacation inactive -> proceeds normally (modal opens)", async () => {
    const { sandbox, elements, alertCalls } = loadCartSandbox(
        null,
        [{ id: "1", name: "Cookie", price: 3, quantity: 1 }]
    );

    await sandbox.__openCheckoutModal();

    assert.equal(alertCalls.length, 0);
    assert.equal(elements.get("checkoutModal").style.display, "flex");
});

test("7. openCheckoutModal: empty cart still short-circuits before the vacation check even runs", async () => {
    const { sandbox, alertCalls, supabaseClient } = loadCartSandbox({ id: "cycle-1" }, []);

    await sandbox.__openCheckoutModal();

    assert.equal(alertCalls.length, 1);
    assert.match(alertCalls[0], /cart is empty/i);
    // Never even queried vacation status -- the empty-cart check comes first.
    assert.ok(!supabaseClient.callLog.includes("vacation_periods"));
});

test("8. submitOrder: vacation active -> blocks before touching the submit button or any order table", async () => {
    const { sandbox, alertCalls, supabaseClient } = loadCartSandbox({ id: "cycle-1" });

    const fakeButton = { disabled: false, textContent: "" };
    const event = {
        preventDefault: () => {},
        target: { querySelector: () => fakeButton }
    };

    await sandbox.__submitOrder(event);

    assert.equal(alertCalls.length, 1);
    assert.match(alertCalls[0], /baking break/i);
    assert.equal(fakeButton.disabled, false, "submit button must never be left in a stuck 'Submitting...' state when blocked");
    assert.ok(!supabaseClient.callLog.includes("orders"));
    assert.ok(!supabaseClient.callLog.includes("order_items"));
});

test("9. submitOrder: vacation inactive -> proceeds past the guard into normal validation", async () => {
    const { sandbox, alertCalls } = loadCartSandbox(null);

    const fakeButton = { disabled: false, textContent: "" };
    const event = {
        preventDefault: () => {},
        target: { querySelector: () => fakeButton }
    };

    await sandbox.__submitOrder(event);

    // Every form field is blank in this fixture, so it proceeds to the
    // pre-existing "Please enter your name." validation -- proof it
    // got past the vacation guard, not evidence of a full checkout.
    assert.equal(alertCalls.length, 1);
    assert.match(alertCalls[0], /enter your name/i);
});

test("10. the vacation guard never queries ballot tables (voting stays fully independent of the order-pause guard)", async () => {
    const { sandbox, supabaseClient } = loadCartSandbox({ id: "cycle-1" });
    await sandbox.__isOrderingPausedForVacation();
    assert.ok(!supabaseClient.callLog.includes("votes"));
    assert.ok(!supabaseClient.callLog.includes("ballot_settings"));
    assert.ok(!supabaseClient.callLog.includes("ballot_options"));
});
