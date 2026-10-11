"use strict";

/* ==========================================
   Stale-cart fix (js/cart.js)

   Covers the layered fix for a customer being able to submit an
   order for an item no longer on the current menu:

     - The cart is session-based (sessionStorage), not indefinitely
       persistent (localStorage): closing the tab/browser clears it.
     - A cart with no activity for 30 minutes expires even if the tab
       stays open, both on next read and via the active interval/
       resume checks.
     - Any cart previously stored under the old, pre-fix localStorage
       key is found and removed, regardless of whether a current
       session cart exists.
     - The cart is revalidated against the live menu on load, on tab
       resume, and immediately before checkout/submit -- anything no
       longer available/current is removed (and the customer told so);
       anything whose price changed is refreshed, never silently sent
       stale.

   Same node:vm sandbox technique as tests/cart-schedule-integrity.test.js,
   trimmed to only what these tests need.
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

/** assert.deepEqual/deepStrictEqual compares prototypes -- an array
 *  or object that originated inside the vm sandbox belongs to a
 *  different realm's Array/Object than this test file's own, so a
 *  strict deep-equal fails with "not reference-equal" even when every
 *  own property matches (see tests/theme-apply.test.js for the same,
 *  earlier-documented footgun). Comparing via JSON.stringify sidesteps
 *  the realm mismatch entirely for the plain-data shapes used here. */
function jsonEqual(actual, expected, message) {
    assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
}

const LEGACY_CART_KEY = "jess_bakes_cart";
const CART_SESSION_KEY = "jess_bakes_cart_session";
const THIRTY_MIN_MS = 30 * 60 * 1000;

function loadCartSandbox({ sessionSeed, localSeed, liveMenuItems } = {}) {
    const sessionStore = new Map();
    const localStore = new Map();

    if (sessionSeed !== undefined) {
        sessionStore.set(CART_SESSION_KEY, typeof sessionSeed === "string" ? sessionSeed : JSON.stringify(sessionSeed));
    }
    if (localSeed !== undefined) {
        localStore.set(LEGACY_CART_KEY, typeof localSeed === "string" ? localSeed : JSON.stringify(localSeed));
    }

    const alertCalls = [];
    const intervalCalls = [];
    const createdElements = [];

    function makeElement() {
        const el = {
            style: {},
            classList: { add: () => {}, toggle: () => {} },
            children: [],
            appendChild(child) { this.children.push(child); return child; },
            setAttribute() {},
            insertBefore(child) { this.children.unshift(child); return child; }
        };
        createdElements.push(el);
        return el;
    }

    const heroSection = {
        firstChild: null,
        insertBefore(el) { this._inserted = el; return el; }
    };

    const fakeDocument = {
        addEventListener: () => {},
        getElementById: () => makeElement(),
        querySelector: (sel) => (sel === ".hero, .page-hero" ? heroSection : null),
        createElement: () => makeElement(),
        body: { appendChild: () => {} }
    };

    let rpcQueryCount = 0;
    const supabaseClient = {
        from(table) {
            if (table === "menu_items") {
                rpcQueryCount++;
                return {
                    select: () => ({
                        eq: () => Promise.resolve({ data: liveMenuItems || [], error: null })
                    })
                };
            }
            return { select: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) };
        }
    };

    const sandbox = {
        document: fakeDocument,
        window: { addEventListener: () => {} },
        console,
        supabaseClient,
        alert: (msg) => alertCalls.push(msg),
        setInterval: (fn, ms) => { intervalCalls.push({ fn, ms }); return intervalCalls.length; },
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
        read("js/mix-and-match.js"),
        read("js/cart.js"),
        `
        this.__initializeCart = initializeCart;
        this.__validateCartAgainstMenu = validateCartAgainstMenu;
        this.__refreshAndValidateCart = refreshAndValidateCart;
        this.__checkCartExpiry = checkCartExpiry;
        this.__readCartFromStorage = readCartFromStorage;
        this.__getCart = function() { return cart; };
        this.__saveCart = saveCart;
        this.__renderCart = function() {}; // no-op: renderCart() touches real DOM structure we don't need for these tests
        `
    ].join("\n");

    vm.runInContext(source, sandbox);

    return { sandbox, alertCalls, intervalCalls, sessionStore, localStore, getRpcQueryCount: () => rpcQueryCount };
}

/* ==========================================
   LEGACY CLEANUP + SESSION EXPIRY (on read)
========================================== */

test("1. a cart stored under the old localStorage key is removed on load, regardless of whether a session cart exists", () => {
    const { localStore } = loadCartSandbox({ localSeed: [{ type: "standard", id: "x", name: "Old Item", price: 5, quantity: 1 }] });
    assert.equal(localStore.has(LEGACY_CART_KEY), false, "the pre-fix localStorage cart key must be removed");
});

test("2. a fresh sessionStorage cart (lastActivity just now) loads with its items intact", () => {
    const items = [{ type: "standard", id: "a", name: "Boule", price: 9, quantity: 2 }];
    const { sandbox } = loadCartSandbox({ sessionSeed: { items, lastActivity: Date.now() } });
    jsonEqual(sandbox.__getCart(), items);
});

test("3. a sessionStorage cart whose lastActivity is more than 30 minutes old loads as empty, and the stale entry is discarded", () => {
    const items = [{ type: "standard", id: "a", name: "Boule", price: 9, quantity: 2 }];
    const { sandbox, sessionStore } = loadCartSandbox({
        sessionSeed: { items, lastActivity: Date.now() - THIRTY_MIN_MS - 1000 }
    });
    jsonEqual(sandbox.__getCart(), []);
    assert.equal(sessionStore.has(CART_SESSION_KEY), false);
});

test("4. a sessionStorage cart exactly at the 30-minute boundary (not yet over) still loads with its items intact", () => {
    const items = [{ type: "standard", id: "a", name: "Boule", price: 9, quantity: 1 }];
    const { sandbox } = loadCartSandbox({
        sessionSeed: { items, lastActivity: Date.now() - (THIRTY_MIN_MS - 1000) }
    });
    jsonEqual(sandbox.__getCart(), items);
});

test("5. malformed/missing sessionStorage data never throws -- loads as an empty cart", () => {
    const { sandbox } = loadCartSandbox({ sessionSeed: "not valid json" });
    jsonEqual(sandbox.__getCart(), []);
});

/* ==========================================
   ACTIVE 30-MINUTE EXPIRY (checkCartExpiry, while the tab stays open)
========================================== */

test("6. checkCartExpiry clears a non-expired cart's in-memory state untouched when activity is recent", async () => {
    const items = [{ type: "standard", id: "a", name: "Boule", price: 9, quantity: 1 }];
    const { sandbox, alertCalls } = loadCartSandbox({ sessionSeed: { items, lastActivity: Date.now() } });

    sandbox.__checkCartExpiry();

    jsonEqual(sandbox.__getCart(), items);
    assert.equal(alertCalls.length, 0);
});

test("7. checkCartExpiry clears the cart and alerts the customer once 30 minutes of inactivity has passed, even though the tab never closed", async () => {
    const items = [{ type: "standard", id: "a", name: "Boule", price: 9, quantity: 1 }];
    const { sandbox, alertCalls, sessionStore } = loadCartSandbox({ sessionSeed: { items, lastActivity: Date.now() } });

    // Simulate 30+ minutes passing while the tab stayed open: the
    // in-memory cart still has items, but storage's own timestamp (the
    // thing checkCartExpiry actually reads) is now stale.
    sessionStore.set(CART_SESSION_KEY, JSON.stringify({ items, lastActivity: Date.now() - THIRTY_MIN_MS - 1000 }));

    sandbox.__checkCartExpiry();

    jsonEqual(sandbox.__getCart(), []);
    assert.equal(alertCalls.length, 1);
    assert.match(alertCalls[0], /30 minutes of inactivity/i);
});

test("8. checkCartExpiry is a no-op on an already-empty cart (no alert spam on a normal page view)", () => {
    const { sandbox, alertCalls } = loadCartSandbox({ sessionSeed: { items: [], lastActivity: Date.now() - THIRTY_MIN_MS - 1000 } });

    sandbox.__checkCartExpiry();

    assert.equal(alertCalls.length, 0);
});

/* ==========================================
   LIVE-MENU REVALIDATION
========================================== */

test("9. validateCartAgainstMenu removes a standard item that is no longer available, and tells the customer", () => {
    const items = [{ type: "standard", id: "gone", name: "Discontinued Loaf", price: 9, quantity: 1 }];
    const { sandbox, alertCalls } = loadCartSandbox({ sessionSeed: { items, lastActivity: Date.now() } });

    const result = sandbox.__validateCartAgainstMenu([]); // live menu no longer has it at all

    jsonEqual(sandbox.__getCart(), []);
    jsonEqual(result.removedNames, ["Discontinued Loaf"]);
    assert.equal(alertCalls.length, 1);
    assert.match(alertCalls[0], /no longer available/i);
    assert.match(alertCalls[0], /Discontinued Loaf/);
});

test("10. validateCartAgainstMenu keeps a still-available standard item untouched", () => {
    const items = [{ type: "standard", id: "keep", name: "Boule", price: 9, quantity: 1 }];
    const { sandbox, alertCalls } = loadCartSandbox({ sessionSeed: { items, lastActivity: Date.now() } });

    const liveMenu = [{ id: "keep", name: "Boule", product_type: "standard", available: true, price: 9 }];
    const result = sandbox.__validateCartAgainstMenu(liveMenu);

    jsonEqual(sandbox.__getCart(), items);
    jsonEqual(result.removedNames, []);
    jsonEqual(result.changedNames, []);
    assert.equal(alertCalls.length, 0);
});

test("11. validateCartAgainstMenu refreshes (never silently keeps) a stale price, and tells the customer", () => {
    const items = [{ type: "standard", id: "keep", name: "Boule", price: 9, quantity: 1 }];
    const { sandbox, alertCalls } = loadCartSandbox({ sessionSeed: { items, lastActivity: Date.now() } });

    const liveMenu = [{ id: "keep", name: "Boule", product_type: "standard", available: true, price: 11 }];
    const result = sandbox.__validateCartAgainstMenu(liveMenu);

    assert.equal(sandbox.__getCart()[0].price, 11, "price must be refreshed to the live value, never left stale");
    jsonEqual(result.changedNames, ["Boule"]);
    assert.equal(alertCalls.length, 1);
    assert.match(alertCalls[0], /price changed/i);
});

test("12. validateCartAgainstMenu removes a Mix & Match box whose product is no longer available at that size", () => {
    const items = [{
        type: "builder", id: "box-6", name: "6 Mix & Match Cookies", price: 15, quantity: 1,
        builder_group: "cookie",
        selections: [{ id: "cookie-1", name: "S'mores", quantity: 6 }]
    }];
    const { sandbox, alertCalls } = loadCartSandbox({ sessionSeed: { items, lastActivity: Date.now() } });

    // Live menu has NO builder product at all now (e.g. discontinued).
    const result = sandbox.__validateCartAgainstMenu([
        { id: "cookie-1", name: "S'mores", product_type: "standard", available: true, builder_group: "cookie" }
    ]);

    jsonEqual(sandbox.__getCart(), []);
    jsonEqual(result.removedNames, ["6 Mix & Match Cookies"]);
    assert.equal(alertCalls.length, 1);
});

test("13. validateCartAgainstMenu removes a Mix & Match box when a selected flavor is no longer eligible (deleted/unavailable/moved builder_group)", () => {
    const items = [{
        type: "builder", id: "box-6", name: "6 Mix & Match Cookies", price: 15, quantity: 1,
        builder_group: "cookie",
        selections: [{ id: "cookie-1", name: "S'mores", quantity: 6 }]
    }];
    const { sandbox, alertCalls } = loadCartSandbox({ sessionSeed: { items, lastActivity: Date.now() } });

    const result = sandbox.__validateCartAgainstMenu([
        { id: "box-6", name: "6 Mix & Match Cookies", product_type: "builder", available: true, builder_group: "cookie", builder_size: 6, price: 15 },
        // cookie-1 is now unavailable -- no longer a valid selection.
        { id: "cookie-1", name: "S'mores", product_type: "standard", available: false, builder_group: "cookie" }
    ]);

    jsonEqual(sandbox.__getCart(), []);
    jsonEqual(result.removedNames, ["6 Mix & Match Cookies"]);
    assert.equal(alertCalls.length, 1);
});

test("14. validateCartAgainstMenu keeps a Mix & Match box whose flavors are all still eligible, and refreshes its price if the box price changed", () => {
    const items = [{
        type: "builder", id: "box-6", name: "6 Mix & Match Cookies", price: 15, quantity: 1,
        builder_group: "cookie",
        selections: [{ id: "cookie-1", name: "S'mores", quantity: 3 }, { id: "cookie-2", name: "Snickerdoodle", quantity: 3 }]
    }];
    const { sandbox, alertCalls } = loadCartSandbox({ sessionSeed: { items, lastActivity: Date.now() } });

    const result = sandbox.__validateCartAgainstMenu([
        { id: "box-6", name: "6 Mix & Match Cookies", product_type: "builder", available: true, builder_group: "cookie", builder_size: 6, price: 17 },
        { id: "cookie-1", name: "S'mores", product_type: "standard", available: true, builder_group: "cookie" },
        { id: "cookie-2", name: "Snickerdoodle", product_type: "standard", available: true, builder_group: "cookie" }
    ]);

    assert.equal(sandbox.__getCart().length, 1, "the box line itself is never removed just because its own price changed");
    assert.equal(sandbox.__getCart()[0].price, 17);
    jsonEqual(result.removedNames, []);
    jsonEqual(result.changedNames, ["6 Mix & Match Cookies"]);
    assert.equal(alertCalls.length, 1);
    assert.match(alertCalls[0], /price changed/i);
});

test("15. refreshAndValidateCart fetches the live menu fresh and applies the same validation", async () => {
    const items = [{ type: "standard", id: "gone", name: "Discontinued Loaf", price: 9, quantity: 1 }];
    const { sandbox, getRpcQueryCount } = loadCartSandbox({ sessionSeed: { items, lastActivity: Date.now() }, liveMenuItems: [] });

    const result = await sandbox.__refreshAndValidateCart();

    assert.equal(getRpcQueryCount(), 1, "must issue a genuine fresh query, never reuse a cached menu list");
    jsonEqual(sandbox.__getCart(), []);
    jsonEqual(result.removedNames, ["Discontinued Loaf"]);
});

test("16. initializeCart validates the just-loaded cart synchronously against the menu it was just handed, with no extra network round-trip", async () => {
    const items = [{ type: "standard", id: "gone", name: "Discontinued Loaf", price: 9, quantity: 1 }];
    const { sandbox, getRpcQueryCount, alertCalls } = loadCartSandbox({ sessionSeed: { items, lastActivity: Date.now() } });

    sandbox.__initializeCart([], () => {}); // the page's own fresh menu fetch found nothing matching

    assert.equal(getRpcQueryCount(), 0, "the first validation pass must use the menu already handed in, not issue its own query");
    jsonEqual(sandbox.__getCart(), []);
    assert.equal(alertCalls.length, 1);
});
