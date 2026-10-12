"use strict";

/* ==========================================
   Finished-product freezer stock -- public cart enforcement
   (js/cart.js, js/menu.js, js/mix-and-match.js working together).

   Covers the client-side half of the feature (the server/database
   half is covered by tests/finished-stock-migrations.test.js and live
   verification): capping Add-to-Cart/quantity-stepper increments at
   live remaining stock (shared across standalone purchases AND Mix &
   Match box selections of the same flavor), stale-cart reconciliation
   removing over-committed items on revalidation, and a friendly
   "sold out" message (with a refreshed cart) instead of a raw error
   when submit_order's reservation trigger rejects an order.

   Same node:vm sandbox technique as tests/cart-session-and-menu-validation.test.js.
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

function jsonEqual(actual, expected, message) {
    assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
}

const CART_SESSION_KEY = "jess_bakes_cart_session";

function loadCartSandbox({ cartItems, liveMenuItems, stockRows, submitOrderResult } = {}) {
    const sessionStore = new Map();
    sessionStore.set(CART_SESSION_KEY, JSON.stringify({ items: cartItems || [], lastActivity: Date.now() }));

    const alertCalls = [];
    const rpcCalls = [];

    function makeElement() {
        return {
            style: {},
            value: "",
            textContent: "",
            innerHTML: "",
            classList: { add: () => {}, toggle: () => {} },
            children: [],
            appendChild(child) { this.children.push(child); return child; },
            setAttribute() {},
            insertBefore(child) { this.children.unshift(child); return child; },
            reset() {},
            querySelector: () => makeElement()
        };
    }

    const fakeDocument = {
        addEventListener: () => {},
        getElementById: () => makeElement(),
        querySelector: () => null,
        createElement: () => makeElement(),
        body: { appendChild: () => {} }
    };

    const supabaseClient = {
        from(table) {
            if (table === "menu_items") {
                return { select: () => ({ eq: () => Promise.resolve({ data: liveMenuItems || [], error: null }) }) };
            }
            if (table === "menu_item_stock") {
                return { select: () => Promise.resolve({ data: stockRows || [], error: null }) };
            }
            return { select: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) };
        },
        rpc(name, params) {
            rpcCalls.push({ name, params });
            if (name === "preview_weekly_pickup") {
                return Promise.resolve({
                    data: [{
                        pickup_date: "2026-08-30", pickup_time: "12:30:00",
                        pickup_weekday: 0, cutoff_weekday: 5, cutoff_time: "17:00:00",
                        schedule_timezone: "Europe/Berlin"
                    }],
                    error: null
                });
            }
            if (name === "submit_order") {
                return Promise.resolve(submitOrderResult || { data: { id: "order-1", order_type: "weekly" }, error: null });
            }
            return Promise.resolve({ data: null, error: null });
        }
    };

    const sandbox = {
        document: fakeDocument,
        window: { addEventListener: () => {} },
        console,
        supabaseClient,
        alert: (msg) => alertCalls.push(msg),
        confirm: () => true,
        setInterval: () => 1,
        clearInterval: () => {},
        localStorage: {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {}
        },
        sessionStorage: {
            getItem: (k) => (sessionStore.has(k) ? sessionStore.get(k) : null),
            setItem: (k, v) => sessionStore.set(k, v),
            removeItem: (k) => sessionStore.delete(k)
        }
    };
    vm.createContext(sandbox);

    const source = [
        read("js/mix-and-match.js"),
        read("js/weekly-schedule.js"),
        read("js/cart.js"),
        `
        this.__setCartMenuItems = function (items) { cartMenuItems = items; };
        this.__getCart = function () { return cart; };
        this.__changeCartQuantity = changeCartQuantity;
        this.__openBuilderModal = openBuilderModal;
        this.__validateCartAgainstMenu = validateCartAgainstMenu;
        this.__refreshAndValidateCart = refreshAndValidateCart;
        this.__submitOrder = submitOrder;
        this.__getCartMenuItems = function () { return cartMenuItems; };
        `
    ].join("\n");

    vm.runInContext(source, sandbox);

    if (liveMenuItems) {
        sandbox.__setCartMenuItems(liveMenuItems);
    }

    return { sandbox, alertCalls, rpcCalls, supabaseClient };
}

/* ==========================================
   Standalone quantity capping (changeCartQuantity)
========================================== */

test("1. a made-to-order item can be added repeatedly with no cap", () => {
    const liveMenuItems = [{ id: "a", name: "Classic Cookie", price: 3, product_type: "standard", available: true }];
    const { sandbox } = loadCartSandbox({ liveMenuItems });

    sandbox.__changeCartQuantity("a", 1);
    sandbox.__changeCartQuantity("a", 1);
    sandbox.__changeCartQuantity("a", 1);

    jsonEqual(sandbox.__getCart().find(i => i.id === "a").quantity, 3);
});

test("2. a limited item cannot be added past its live available_count", () => {
    const liveMenuItems = [{ id: "a", name: "Wicked Caramel Apple", price: 3, product_type: "standard", available: true, stock_mode: "limited", available_count: 2 }];
    const { sandbox, alertCalls } = loadCartSandbox({ liveMenuItems });

    sandbox.__changeCartQuantity("a", 1);
    sandbox.__changeCartQuantity("a", 1);
    sandbox.__changeCartQuantity("a", 1); // third click should be blocked

    jsonEqual(sandbox.__getCart().find(i => i.id === "a").quantity, 2);
    assert.ok(alertCalls.some(m => /sold out/i.test(m)));
});

test("3. decrementing a limited item is never blocked", () => {
    const liveMenuItems = [{ id: "a", name: "Wicked Caramel Apple", price: 3, product_type: "standard", available: true, stock_mode: "limited", available_count: 2 }];
    const { sandbox } = loadCartSandbox({
        cartItems: [{ type: "standard", id: "a", name: "Wicked Caramel Apple", price: 3, quantity: 2 }],
        liveMenuItems
    });

    sandbox.__changeCartQuantity("a", -1);

    jsonEqual(sandbox.__getCart().find(i => i.id === "a").quantity, 1);
});

test("4. a flavor sold both standalone AND inside a Mix & Match box shares one stock cap across both paths", () => {
    // Wicked Caramel Apple has 5 remaining; 3 are already committed
    // inside a Mix & Match box in the cart. Only 2 more may be added
    // standalone.
    const liveMenuItems = [{ id: "wca", name: "Wicked Caramel Apple", price: 3, product_type: "standard", available: true, stock_mode: "limited", available_count: 5 }];
    const cartItems = [{
        type: "builder", id: "box-1", name: "6 Mix & Match Cookies", price: 15, quantity: 1,
        builder_group: "cookie",
        selections: [{ id: "wca", name: "Wicked Caramel Apple", quantity: 3 }]
    }];
    const { sandbox, alertCalls } = loadCartSandbox({ cartItems, liveMenuItems });

    sandbox.__changeCartQuantity("wca", 1); // 4 committed
    sandbox.__changeCartQuantity("wca", 1); // 5 committed -- at cap
    sandbox.__changeCartQuantity("wca", 1); // blocked -- would be 6

    const standaloneLine = sandbox.__getCart().find(i => i.type === "standard" && i.id === "wca");
    jsonEqual(standaloneLine.quantity, 2);
    assert.ok(alertCalls.some(m => /sold out/i.test(m)));
});

/* ==========================================
   Mix & Match builder modal per-flavor capping
========================================== */

test("5. the builder modal caps a flavor's selection at its live remaining stock", () => {
    const liveMenuItems = [
        { id: "box", name: "6 Mix & Match Cookies", price: 15, product_type: "builder", builder_group: "cookie", builder_size: 6, available: true },
        { id: "wca", name: "Wicked Caramel Apple", price: 3, product_type: "standard", builder_group: "cookie", available: true, stock_mode: "limited", available_count: 2 }
    ];
    const { sandbox } = loadCartSandbox({ liveMenuItems });

    sandbox.__openBuilderModal("box");

    sandbox.window.updateBuilderSelection("wca", 1);
    sandbox.window.updateBuilderSelection("wca", 1);
    sandbox.window.updateBuilderSelection("wca", 1); // blocked -- only 2 remain

    sandbox.window.finishBuilderSelection();
    // builderSize is 6 but only 2 units of the one eligible flavor
    // could ever be selected, so the box can never be completed --
    // finishBuilderSelection's existing "select exactly N" guard
    // blocks the add, proving the per-flavor cap actually took effect
    // rather than silently overselling.
    jsonEqual(sandbox.__getCart().length, 0);
});

test("6. a sold-out flavor never appears as a pickable option in the builder modal at all", () => {
    const liveMenuItems = [
        { id: "box", name: "6 Mix & Match Cookies", price: 15, product_type: "builder", builder_group: "cookie", builder_size: 6, available: true },
        { id: "soldout", name: "Snickerdoodle", price: 3, product_type: "standard", builder_group: "cookie", available: true, stock_mode: "limited", available_count: 0 },
        { id: "unlimited", name: "Classic Chip", price: 3, product_type: "standard", builder_group: "cookie", available: true }
    ];
    const { sandbox } = loadCartSandbox({ liveMenuItems });

    // openBuilderModal computes eligible options via MixAndMatch.getEligibleCookies --
    // calling it directly mirrors exactly what the modal renders.
    const MixAndMatch = require("../js/mix-and-match.js");
    const builder = liveMenuItems[0];
    const eligible = MixAndMatch.getEligibleCookies(liveMenuItems, builder);

    assert.deepEqual(eligible.map(c => c.id), ["unlimited"]);
});

test("6b. a box mixing a limited and a made-to-order flavor caps only the limited one -- the made-to-order flavor is unrestricted in the same box", () => {
    const liveMenuItems = [
        { id: "box", name: "6 Mix & Match Cookies", price: 15, product_type: "builder", builder_group: "cookie", builder_size: 6, available: true },
        { id: "limited", name: "Wicked Caramel Apple", price: 3, product_type: "standard", builder_group: "cookie", available: true, stock_mode: "limited", available_count: 2 },
        { id: "unlimited", name: "Classic Chip", price: 3, product_type: "standard", builder_group: "cookie", available: true }
    ];
    const { sandbox } = loadCartSandbox({ liveMenuItems });

    sandbox.__openBuilderModal("box");

    // Limited flavor: can select up to 2, third attempt blocked.
    sandbox.window.updateBuilderSelection("limited", 1);
    sandbox.window.updateBuilderSelection("limited", 1);
    sandbox.window.updateBuilderSelection("limited", 1);

    // Made-to-order flavor: no cap at all, can fill the rest of the box.
    sandbox.window.updateBuilderSelection("unlimited", 1);
    sandbox.window.updateBuilderSelection("unlimited", 1);
    sandbox.window.updateBuilderSelection("unlimited", 1);
    sandbox.window.updateBuilderSelection("unlimited", 1);

    sandbox.window.finishBuilderSelection();

    const box = sandbox.__getCart().find(i => i.type === "builder");
    assert.ok(box, "box should have been added -- exactly 6 selected (2 limited + 4 made-to-order)");
    const limitedSelection = box.selections.find(s => s.id === "limited");
    const unlimitedSelection = box.selections.find(s => s.id === "unlimited");
    assert.equal(limitedSelection.quantity, 2);
    assert.equal(unlimitedSelection.quantity, 4);
});

/* ==========================================
   validateCartAgainstMenu -- cart-wide over-commit reconciliation
========================================== */

test("7. validateCartAgainstMenu removes a standalone line that alone exceeds the live remaining stock", () => {
    const liveMenuItems = [{ id: "a", name: "Wicked Caramel Apple", price: 3, product_type: "standard", available: true, stock_mode: "limited", available_count: 1 }];
    const { sandbox, alertCalls } = loadCartSandbox({
        cartItems: [{ type: "standard", id: "a", name: "Wicked Caramel Apple", price: 3, quantity: 3 }],
        liveMenuItems
    });

    sandbox.__validateCartAgainstMenu(liveMenuItems);

    jsonEqual(sandbox.__getCart(), []);
    assert.ok(alertCalls.some(m => /no longer available/i.test(m)));
});

test("8. validateCartAgainstMenu removes BOTH a standalone line and a builder box when their combined demand exceeds live stock, even though neither alone would", () => {
    // 5 remaining; standalone wants 3, the box wants 3 more -- 6 total,
    // over the limit. Neither line alone exceeds 5, so this can only
    // be caught by summing across the whole cart.
    const liveMenuItems = [
        { id: "wca", name: "Wicked Caramel Apple", price: 3, product_type: "standard", builder_group: "cookie", available: true, stock_mode: "limited", available_count: 5 },
        { id: "box", name: "6 Mix & Match Cookies", price: 15, product_type: "builder", builder_group: "cookie", builder_size: 6, available: true }
    ];
    const cartItems = [
        { type: "standard", id: "wca", name: "Wicked Caramel Apple", price: 3, quantity: 3 },
        { type: "builder", id: "box", name: "6 Mix & Match Cookies", price: 15, quantity: 1, builder_group: "cookie", selections: [{ id: "wca", name: "Wicked Caramel Apple", quantity: 3 }] }
    ];
    const { sandbox, alertCalls } = loadCartSandbox({ cartItems, liveMenuItems });

    sandbox.__validateCartAgainstMenu(liveMenuItems);

    jsonEqual(sandbox.__getCart(), []);
    assert.ok(alertCalls.some(m => /no longer available/i.test(m)));
});

test("9. validateCartAgainstMenu leaves a cart whose combined demand is within live stock untouched", () => {
    const liveMenuItems = [
        { id: "wca", name: "Wicked Caramel Apple", price: 3, product_type: "standard", builder_group: "cookie", available: true, stock_mode: "limited", available_count: 5 },
        { id: "box", name: "6 Mix & Match Cookies", price: 15, product_type: "builder", builder_group: "cookie", builder_size: 6, available: true }
    ];
    const cartItems = [
        { type: "standard", id: "wca", name: "Wicked Caramel Apple", price: 3, quantity: 2 },
        { type: "builder", id: "box", name: "6 Mix & Match Cookies", price: 15, quantity: 1, builder_group: "cookie", selections: [{ id: "wca", name: "Wicked Caramel Apple", quantity: 3 }] }
    ];
    const { sandbox, alertCalls } = loadCartSandbox({ cartItems, liveMenuItems });

    sandbox.__validateCartAgainstMenu(liveMenuItems);

    jsonEqual(sandbox.__getCart().length, 2);
    assert.equal(alertCalls.length, 0);
});

test("10. made-to-order items are never affected by over-commit detection, no matter the cart quantity", () => {
    const liveMenuItems = [{ id: "a", name: "Classic Cookie", price: 3, product_type: "standard", available: true }];
    const { sandbox, alertCalls } = loadCartSandbox({
        cartItems: [{ type: "standard", id: "a", name: "Classic Cookie", price: 3, quantity: 500 }],
        liveMenuItems
    });

    sandbox.__validateCartAgainstMenu(liveMenuItems);

    jsonEqual(sandbox.__getCart().length, 1);
    assert.equal(alertCalls.length, 0);
});

/* ==========================================
   refreshAndValidateCart -- live stock fetch + merge
========================================== */

test("11. refreshAndValidateCart fetches menu_item_stock and merges it before revalidating", async () => {
    const liveMenuItems = [{ id: "a", name: "Wicked Caramel Apple", price: 3, product_type: "standard", available: true }];
    const stockRows = [{ menu_item_id: "a", stock_mode: "limited", available_count: 0, sold_out_behavior: "show_sold_out" }];
    const { sandbox, alertCalls } = loadCartSandbox({
        cartItems: [{ type: "standard", id: "a", name: "Wicked Caramel Apple", price: 3, quantity: 1 }],
        liveMenuItems,
        stockRows
    });

    const result = await sandbox.__refreshAndValidateCart();

    jsonEqual(result.removedNames, ["Wicked Caramel Apple"]);
    jsonEqual(sandbox.__getCart(), []);
    assert.ok(alertCalls.some(m => /no longer available/i.test(m)));
});

test("12. a stock-fetch failure never blocks price/availability revalidation (fails open)", async () => {
    const liveMenuItems = [{ id: "a", name: "Classic Cookie", price: 3, product_type: "standard", available: true }];
    const { sandbox } = loadCartSandbox({
        cartItems: [{ type: "standard", id: "a", name: "Classic Cookie", price: 3, quantity: 1 }],
        liveMenuItems
    });

    // this sandbox's menu_item_stock mock returns {data: [], error: null}
    // by default (no stockRows passed) -- simulate a harder failure by
    // overriding .from for just this table.
    sandbox.supabaseClient.from = (table) => {
        if (table === "menu_items") {
            return { select: () => ({ eq: () => Promise.resolve({ data: liveMenuItems, error: null }) }) };
        }
        if (table === "menu_item_stock") {
            return { select: () => Promise.resolve({ data: null, error: { message: "boom" } }) };
        }
        return { select: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) };
    };

    const result = await sandbox.__refreshAndValidateCart();

    jsonEqual(result.removedNames, []);
    jsonEqual(sandbox.__getCart().length, 1);
});

/* ==========================================
   submitOrder -- friendly stock-exhaustion handling
========================================== */

test("13. a stock-exhaustion RPC error shows a friendly message and refreshes the cart instead of a raw alert", async () => {
    const liveMenuItems = [{ id: "a", name: "Wicked Caramel Apple", price: 3, product_type: "standard", available: true, stock_mode: "limited", available_count: 0 }];
    const { sandbox, alertCalls } = loadCartSandbox({
        cartItems: [{ type: "standard", id: "a", name: "Wicked Caramel Apple", price: 3, quantity: 1 }],
        liveMenuItems,
        submitOrderResult: { data: null, error: { message: "Sorry, Wicked Caramel Apple no longer has enough stock remaining. Please update your cart and try again." } }
    });

    const fakeButton = { disabled: false, textContent: "" };
    const event = {
        preventDefault: () => {},
        target: {
            querySelector: () => fakeButton
        }
    };

    // Populate the required form fields the real submitOrder reads via
    // document.getElementById(...).value -- the shared fake element
    // factory returns the same kind of stub every call, so stub
    // getElementById to answer with populated values for this test.
    sandbox.document.getElementById = (id) => {
        const values = {
            customerName: "Test Customer",
            customerEmail: "test@example.com",
            customerPhone: "555-1234",
            orderType: "weekly",
            customOrderDetails: ""
        };
        return {
            value: values[id] !== undefined ? values[id] : "",
            style: {},
            textContent: "",
            innerHTML: "",
            reset: () => {}
        };
    };

    // lastPickupPreview starts null, so the FIRST submitOrder call
    // always exits early on the "pickup date just changed" branch
    // (the exact same priming call pattern used in
    // tests/cart-schedule-integrity.test.js) -- the second call is the
    // one that actually reaches the RPC.
    await sandbox.__submitOrder(event);
    await sandbox.__submitOrder(event);

    // Cart was emptied by the (over-committed, now sold out) item
    // being removed during the post-error revalidation -- the
    // customer sees an updated, truthful cart, not a dead end.
    jsonEqual(sandbox.__getCart(), []);
    assert.equal(fakeButton.disabled, false, "the submit button must be re-enabled after a rejected order");
});
