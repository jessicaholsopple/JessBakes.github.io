"use strict";

/* ==========================================
   Checkout scheduling integrity (js/cart.js)

   Covers the properties that make it safe to trust the pickup date a
   customer sees and confirms:

     - Every proposed pickup date comes from the preview_weekly_pickup
       RPC (a fresh network call against the database clock), never a
       value computed from the browser's own Date/timezone.
     - submitOrder() re-checks that RPC immediately before submitting,
       and if the answer changed since checkout opened (the cutoff
       crossed while the page was open), it does NOT call submit_order
       at all -- it updates the card, alerts the customer, and requires
       a second Submit click. No order is created on that first
       attempt.
     - The actual save (submit_order RPC) never sends a client-computed
       pickup_date/pickup_time at all -- structurally impossible to
       tamper with, since the RPC signature has no such parameter; the
       database computes and enforces it server-side (see
       supabase/migrations/20260828100000_weekly_pickup_schedule.sql,
       verified live and separately covered by tests/weekly-schedule.test.js).

   Same node:vm sandbox technique as tests/vacation-order-guard.test.js.
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

const CART_SESSION_KEY = "jess_bakes_cart_session";

/** `previews` is an array of successive preview_weekly_pickup responses
 *  -- the Nth call to fetchPickupPreview() (open, then again at submit
 *  time, ...) gets previews[N] (or the last entry once exhausted). This
 *  is what lets a test simulate "the cutoff crossed between checkout
 *  opening and Submit being clicked": pass two different pickup_date
 *  values. */
function makeSupabaseClient({ previews, submitResult, submitError, liveMenuItems }) {
    const callLog = [];
    const rpcCalls = [];
    let previewCallCount = 0;

    return {
        callLog,
        rpcCalls,
        from(table) {
            callLog.push(table);

            // refreshAndValidateCart()'s live-menu re-check (now called
            // by openCheckoutModal and immediately before submit_order).
            // Defaults to "whatever the test seeded the cart with is
            // still live/unchanged" so existing tests that don't care
            // about menu revalidation aren't affected by it; tests that
            // DO care pass an explicit liveMenuItems list.
            if (table === "menu_items") {
                return {
                    select() {
                        return { eq: () => Promise.resolve({ data: liveMenuItems || [], error: null }) };
                    }
                };
            }

            return {
                select() { return { maybeSingle: () => Promise.resolve({ data: null, error: null }), eq() { return this; } }; }
            };
        },
        rpc(name, params) {
            rpcCalls.push({ name, params });

            if (name === "preview_weekly_pickup") {
                const preview = previews[Math.min(previewCallCount, previews.length - 1)];
                previewCallCount++;
                return Promise.resolve({ data: [preview], error: null });
            }

            if (name === "submit_order") {
                if (submitError) {
                    return Promise.resolve({ data: null, error: submitError });
                }
                return Promise.resolve({
                    data: submitResult || { id: "order-1", order_type: params.p_order_type, pickup_date: "2026-08-30", pickup_time: "12:30:00" },
                    error: null
                });
            }

            return Promise.resolve({ data: null, error: { message: `unexpected rpc: ${name}` } });
        }
    };
}

/** Builds a live-menu snapshot that exactly matches a given cart --
 *  i.e. "nothing about the menu has changed" -- so tests that don't
 *  care about menu revalidation aren't affected by
 *  refreshAndValidateCart() now running before checkout/submit. Tests
 *  that DO care pass their own explicit liveMenuItems instead. */
function deriveMatchingLiveMenu(cartItems) {
    const rows = [];
    (cartItems || []).forEach(item => {
        if (item.type === "builder") {
            const size = (item.selections || []).reduce((sum, s) => sum + (Number(s.quantity) || 0), 0);
            rows.push({ id: item.id, product_type: "builder", available: true, price: item.price, builder_group: item.builder_group, builder_size: size });
            (item.selections || []).forEach(s => {
                rows.push({ id: s.id, product_type: "standard", available: true, price: 0, builder_group: item.builder_group });
            });
        } else {
            rows.push({ id: item.id, product_type: "standard", available: true, price: item.price });
        }
    });
    return rows;
}

// Used whenever a test doesn't care about cart CONTENT specifically
// (every scheduling-focused test below) -- just needs a realistic,
// non-empty cart so submitOrder() behaves the way it would for a real
// customer, now that it also revalidates against the live menu before
// submitting.
const DEFAULT_CART_ITEMS = [
    { type: "standard", id: "item-1", name: "Sourdough Boule", price: 9, quantity: 1 }
];

function loadCartSandbox({ previews, submitResult, submitError, cartItems, liveMenuItems, formValues }) {
    const elements = new Map();
    function fakeElement(id) {
        if (!elements.has(id)) {
            const initial = (formValues && formValues[id]) ?? "";
            elements.set(id, { id, value: initial, textContent: "", innerHTML: "", style: {}, disabled: false, reset: () => {} });
        }
        return elements.get(id);
    }

    const alertCalls = [];
    const sessionStore = new Map();
    const localStore = new Map();
    const resolvedCartItems = cartItems !== undefined ? cartItems : DEFAULT_CART_ITEMS;
    sessionStore.set(CART_SESSION_KEY, JSON.stringify({ items: resolvedCartItems, lastActivity: Date.now() }));
    const resolvedLiveMenuItems = liveMenuItems !== undefined ? liveMenuItems : deriveMatchingLiveMenu(resolvedCartItems);
    const supabaseClient = makeSupabaseClient({ previews, submitResult, submitError, liveMenuItems: resolvedLiveMenuItems });

    const fakeDocument = {
        addEventListener: () => {},
        getElementById: (id) => fakeElement(id),
        querySelector: () => fakeElement("__query__"),
        createElement: () => ({ style: {}, classList: { add: () => {} }, appendChild: () => {}, addEventListener: () => {} }),
        body: { appendChild: () => {} }
    };

    const sandbox = {
        document: fakeDocument,
        window: { addEventListener: () => {} },
        console,
        supabaseClient,
        alert: (msg) => alertCalls.push(msg),
        confirm: () => true,
        crypto: { randomUUID: () => "test-uuid" },
        setInterval: () => 1,
        clearInterval: () => {},
        localStorage: {
            getItem: (k) => (localStore.has(k) ? localStore.get(k) : null),
            setItem: (k, v) => localStore.set(k, v),
            removeItem: (k) => localStore.delete(k)
        },
        sessionStorage: {
            getItem: (k) => (sessionStore.has(k) ? sessionStore.get(k) : null),
            setItem: (k, v) => sessionStore.set(k, v),
            removeItem: (k) => sessionStore.delete(k)
        }
    };
    vm.createContext(sandbox);

    const source = [
        read("js/vacation-mode.js"),
        read("js/mix-and-match.js"),
        read("js/weekly-schedule.js"),
        read("js/cart.js"),
        `
        this.__openCheckoutModal = openCheckoutModal;
        this.__submitOrder = submitOrder;
        this.__updatePickupInfo = updatePickupInfo;
        this.__initializeCart = initializeCart;
        this.__validateCartAgainstMenu = validateCartAgainstMenu;
        this.__refreshAndValidateCart = refreshAndValidateCart;
        this.__checkCartExpiry = checkCartExpiry;
        this.__readCartFromStorage = readCartFromStorage;
        this.__getCart = function() { return cart; };
        `
    ].join("\n");

    vm.runInContext(source, sandbox);

    return { sandbox, elements, alertCalls, supabaseClient, fakeElement, sessionStore, localStore };
}

const PREVIEW_A = { pickup_date: "2026-08-30", pickup_time: "12:30:00", pickup_weekday: 0, cutoff_weekday: 5, cutoff_time: "17:00:00", schedule_timezone: "Europe/Berlin" };
const PREVIEW_B = { pickup_date: "2026-09-06", pickup_time: "12:30:00", pickup_weekday: 0, cutoff_weekday: 5, cutoff_time: "17:00:00", schedule_timezone: "Europe/Berlin" };

const VALID_FORM = {
    orderType: "weekly",
    customerName: "Alex",
    customerPhone: "555-0100",
    customerEmail: "alex@example.com",
    customOrderDetails: ""
};

test("1. updatePickupInfo always fetches a fresh preview -- never reuses a cached value across calls", async () => {
    const { sandbox, supabaseClient } = loadCartSandbox({ previews: [PREVIEW_A, PREVIEW_B], formValues: VALID_FORM });

    await sandbox.__updatePickupInfo();
    await sandbox.__updatePickupInfo();

    const previewCalls = supabaseClient.rpcCalls.filter(c => c.name === "preview_weekly_pickup");
    assert.equal(previewCalls.length, 2, "each call to updatePickupInfo must issue its own fresh RPC request");
});

test("2. the 'Your Pickup' card renders the exact weekday/date/time from the fresh preview, not a locally-recomputed guess", async () => {
    const { sandbox, elements } = loadCartSandbox({ previews: [PREVIEW_A], formValues: VALID_FORM });

    await sandbox.__updatePickupInfo();

    const html = elements.get("pickupInfo").innerHTML;
    assert.match(html, /Sunday, August 30, 2026/);
    assert.match(html, /12:30 PM/);
});

test("3. no cutoff crossing: submitOrder proceeds to submit_order when the fresh pre-submit preview matches what was shown at open", async () => {
    const { sandbox, alertCalls, supabaseClient } = loadCartSandbox({
        previews: [PREVIEW_A, PREVIEW_A],
        formValues: VALID_FORM
    });

    await sandbox.__updatePickupInfo(); // simulates checkout opening, showing PREVIEW_A

    const fakeButton = { disabled: false, textContent: "" };
    const event = { preventDefault: () => {}, target: { querySelector: () => fakeButton } };

    await sandbox.__submitOrder(event);

    const submitCalls = supabaseClient.rpcCalls.filter(c => c.name === "submit_order");
    assert.equal(submitCalls.length, 1, "submit_order should be called exactly once when nothing changed");
    assert.equal(alertCalls.length, 0, "no cutoff-crossing alert should fire when nothing changed");
});

test("4. cutoff crossing while checkout was open: submitOrder does NOT call submit_order, updates the card, and alerts the customer to review and resubmit", async () => {
    const { sandbox, alertCalls, elements, supabaseClient } = loadCartSandbox({
        previews: [PREVIEW_A, PREVIEW_B], // open shows A; the pre-submit re-check returns B
        formValues: VALID_FORM
    });

    await sandbox.__updatePickupInfo(); // checkout opened, shows PREVIEW_A (Aug 30)

    const fakeButton = { disabled: false, textContent: "" };
    const event = { preventDefault: () => {}, target: { querySelector: () => fakeButton } };

    await sandbox.__submitOrder(event);

    // No partial order/order_items record: submit_order is never called.
    const submitCalls = supabaseClient.rpcCalls.filter(c => c.name === "submit_order");
    assert.equal(submitCalls.length, 0, "must never create an order for the stale pickup date");

    // The card is updated to the new authoritative date.
    assert.match(elements.get("pickupInfo").innerHTML, /September 6, 2026/);

    // A clear explanation is shown, and the button is re-enabled so the
    // customer can review and click Submit again.
    assert.equal(alertCalls.length, 1);
    assert.match(alertCalls[0], /cutoff passed while this page was open/i);
    assert.match(alertCalls[0], /September 6, 2026/);
    assert.equal(fakeButton.disabled, false);
    assert.equal(fakeButton.textContent, "Submit Order");
});

test("5. after a crossing, clicking Submit again (now matching) proceeds normally", async () => {
    // Open shows A; first Submit attempt's re-check also returns B (a
    // crossing is detected and blocked, as in test 4); the customer
    // reviews the updated card (now showing B) and clicks Submit a
    // second time -- this time both the "last shown" and "freshly
    // checked" values are B, so it proceeds.
    const { sandbox, alertCalls, supabaseClient } = loadCartSandbox({
        previews: [PREVIEW_A, PREVIEW_B, PREVIEW_B],
        formValues: VALID_FORM
    });

    await sandbox.__updatePickupInfo(); // shows A

    const fakeButton = { disabled: false, textContent: "" };
    const event = { preventDefault: () => {}, target: { querySelector: () => fakeButton } };

    await sandbox.__submitOrder(event); // detects A -> B crossing, blocks
    await sandbox.__submitOrder(event); // now B -> B, proceeds

    const submitCalls = supabaseClient.rpcCalls.filter(c => c.name === "submit_order");
    assert.equal(submitCalls.length, 1);
    assert.equal(alertCalls.length, 1, "only the first attempt should show the crossing alert");
});

test("6. submit_order is called with NO pickup_date/pickup_time parameter at all -- the client cannot send one even if it wanted to", async () => {
    const { sandbox, supabaseClient } = loadCartSandbox({
        previews: [PREVIEW_A, PREVIEW_A],
        formValues: VALID_FORM
    });

    await sandbox.__updatePickupInfo();

    const fakeButton = { disabled: false, textContent: "" };
    const event = { preventDefault: () => {}, target: { querySelector: () => fakeButton } };
    await sandbox.__submitOrder(event);

    const submitCall = supabaseClient.rpcCalls.find(c => c.name === "submit_order");
    assert.ok(submitCall, "expected submit_order to have been called");
    assert.equal("p_pickup_date" in submitCall.params, false);
    assert.equal("p_pickup_time" in submitCall.params, false);
});

test("7. a failed submit_order call (e.g. Vacation Mode activated mid-checkout) surfaces the server's error and re-enables the button, without altering the pickup card", async () => {
    const { sandbox, alertCalls, elements } = loadCartSandbox({
        previews: [PREVIEW_A, PREVIEW_A],
        submitError: { message: "Ordering is currently paused for vacation." },
        formValues: VALID_FORM
    });

    await sandbox.__updatePickupInfo();

    const fakeButton = { disabled: false, textContent: "" };
    const event = { preventDefault: () => {}, target: { querySelector: () => fakeButton } };
    await sandbox.__submitOrder(event);

    assert.equal(alertCalls.length, 1);
    assert.match(alertCalls[0], /paused for vacation/i);
    assert.equal(fakeButton.disabled, false);
});

test("8. the items array sent to submit_order never includes a per-child price for Mix & Match selections", async () => {
    const cartItems = [
        {
            id: "box-6", type: "builder", name: "6 Mix & Match Cookies", price: 15, quantity: 1,
            builder_group: "cookie",
            selections: [{ id: "cookie-1", name: "S'mores", quantity: 6 }]
        }
    ];

    const { sandbox, supabaseClient } = loadCartSandbox({
        previews: [PREVIEW_A, PREVIEW_A],
        cartItems,
        formValues: VALID_FORM
    });

    await sandbox.__updatePickupInfo();

    const fakeButton = { disabled: false, textContent: "" };
    const event = { preventDefault: () => {}, target: { querySelector: () => fakeButton } };
    await sandbox.__submitOrder(event);

    const submitCall = supabaseClient.rpcCalls.find(c => c.name === "submit_order");
    assert.ok(submitCall);
    assert.equal(submitCall.params.p_items.length, 1, "one order_items row for the box line, not one per selected flavor");
    assert.equal(submitCall.params.p_items[0].builder_details.selections[0].name, "S'mores");
});

test("9. openCheckoutModal re-validates against the live menu before showing checkout -- if that empties the cart, checkout never opens and no submit_order call is possible", async () => {
    const cartItems = [{ type: "standard", id: "gone", name: "Discontinued Loaf", price: 9, quantity: 1 }];

    const { sandbox, elements, alertCalls, supabaseClient } = loadCartSandbox({
        previews: [PREVIEW_A],
        cartItems,
        liveMenuItems: [], // the live menu no longer has this item at all
        formValues: VALID_FORM
    });

    await sandbox.__openCheckoutModal();

    assert.equal(elements.has("checkoutModal"), false, "checkout modal must never even be looked up, let alone shown, once the cart is empty");
    assert.ok(alertCalls.some(a => /no longer available/i.test(a)));
    assert.equal(supabaseClient.rpcCalls.filter(c => c.name === "submit_order").length, 0);
});

test("10. submitOrder re-validates against the live menu immediately before submitting -- a changed price blocks THIS attempt (no submit_order call) and requires a second, now-accurate Submit click", async () => {
    const cartItems = [{ type: "standard", id: "item-1", name: "Sourdough Boule", price: 9, quantity: 1 }];
    // The live price is now 11, not the 9 the cart still has.
    const changedMenu = [{ id: "item-1", name: "Sourdough Boule", product_type: "standard", available: true, price: 11 }];

    const { sandbox, supabaseClient, alertCalls } = loadCartSandbox({
        previews: [PREVIEW_A, PREVIEW_A, PREVIEW_A],
        cartItems,
        liveMenuItems: changedMenu,
        formValues: VALID_FORM
    });

    await sandbox.__updatePickupInfo();

    const fakeButton = { disabled: false, textContent: "" };
    const event = { preventDefault: () => {}, target: { querySelector: () => fakeButton } };

    await sandbox.__submitOrder(event); // first attempt: price just changed, must be blocked

    assert.equal(supabaseClient.rpcCalls.filter(c => c.name === "submit_order").length, 0, "the stale price must never reach submit_order");
    assert.ok(alertCalls.some(a => /price changed/i.test(a)));
    assert.equal(fakeButton.disabled, false, "the button must be re-enabled so the customer can review and submit again");

    await sandbox.__submitOrder(event); // second attempt: nothing changed since the refresh above, proceeds

    const submitCalls = supabaseClient.rpcCalls.filter(c => c.name === "submit_order");
    assert.equal(submitCalls.length, 1, "the second, now-accurate attempt should succeed");
});
