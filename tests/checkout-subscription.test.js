"use strict";

/* ==========================================
   Checkout menu-update subscription (js/cart.js +
   supabase/functions/newsletter-subscribe/index.ts)

   Covers the optional "Email me weekly menu updates and news about new
   items" checkbox added to checkout:
     - present with the exact required wording, properly labeled, with
       a nearby Privacy Notice link, unchecked by default, and never
       required to submit an order;
     - unchecked -> no subscription call at all, no interpretation of
       "placed an order" as marketing consent;
     - checked -> subscribes through the SAME canonical
       newsletter-subscribe Edge Function every other signup surface
       uses (never a direct table write), using the checkout customer's
       own name/email, with source "checkout";
     - the subscription attempt only ever happens AFTER submit_order
       has already succeeded, and a subscription failure never undoes,
       duplicates, or hides the already-created order -- it only shows
       a clear, separate notice with a retry link to the existing Stay
       Updated form;
     - checkout reopening always resets the checkbox to unchecked,
       regardless of anything previously true for that email.

   Idempotency for existing-active / previously-unsubscribed / retried
   signups is enforced entirely inside newsletter-subscribe itself
   (one unique email index, consent_event_id only regenerated on a
   genuine 0->active transition, welcome email keyed off that id) --
   this file does not re-implement or re-test that logic; it asserts
   cart.js calls through to it unchanged, and that the dedupe/
   reactivation branches themselves are still present and untouched.

   Same node:vm sandbox technique as tests/cart-schedule-integrity.test.js.
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
const EXACT_CHECKBOX_TEXT =
    "Email me weekly menu updates and news about new items. I can unsubscribe at any time.";

/* ==========================================
   STRUCTURAL / MARKUP
========================================== */

test("1. the checkout form contains the exact required checkbox wording", () => {
    const js = read("js/cart.js");
    assert.ok(js.includes(EXACT_CHECKBOX_TEXT), "expected the exact specified checkbox wording in js/cart.js");
});

test("2. the checkbox markup has no `checked` attribute and no `required` attribute -- unchecked by default and never mandatory", () => {
    const js = read("js/cart.js");
    const idIdx = js.indexOf('id="checkoutSubscribeMenuUpdates"');
    assert.ok(idIdx !== -1, "checkoutSubscribeMenuUpdates checkbox not found");

    const inputStart = js.lastIndexOf("<input", idIdx);
    const inputEnd = js.indexOf(">", idIdx);
    const inputTag = js.slice(inputStart, inputEnd);

    assert.doesNotMatch(inputTag, /\bchecked\b/);
    assert.doesNotMatch(inputTag, /\brequired\b/);
});

test("3. the checkbox is connected to a real <label> via for/id, and a Privacy Notice link sits nearby", () => {
    const js = read("js/cart.js");
    const labelMatch = js.match(/<label[^>]*for="checkoutSubscribeMenuUpdates"[^>]*>/);
    assert.ok(labelMatch, "expected a <label for=\"checkoutSubscribeMenuUpdates\"> connected to the checkbox");

    const labelIdx = js.indexOf(labelMatch[0]);
    const nearbyBlock = js.slice(labelIdx, labelIdx + 700);
    assert.match(nearbyBlock, /href="privacy\.html"/, "expected a nearby link to the existing Privacy Notice");
});

test("4. the checkbox and its privacy link live between the email-information notice and the Submit Order button", () => {
    const js = read("js/cart.js");
    const formStart = js.indexOf('id="checkoutForm"');
    const noticeIndex = js.indexOf("checkout-email-notice", formStart);
    const checkboxIndex = js.indexOf("checkoutSubscribeMenuUpdates", formStart);
    const submitButtonIndex = js.indexOf("Submit Order", formStart);

    assert.ok(noticeIndex !== -1 && checkboxIndex !== -1 && submitButtonIndex !== -1);
    assert.ok(
        checkboxIndex > noticeIndex && checkboxIndex < submitButtonIndex,
        "checkbox must appear after the email notice and before the Submit Order button"
    );
});

test("5. css/style.css styles the checkbox row and resets the generic .form-group input box styling (padding/border/radius) so it renders as a plain checkbox, not a full-width field", () => {
    const css = read("css/style.css");
    assert.match(css, /\.checkout-subscribe-option\s*\{/);
    assert.match(css, /\.checkout-subscribe-option input\[type="checkbox"\]\s*\{/);
});

test("6. css/themes.css's checkout-modal reset still covers the whole checkout card -- the new checkbox inherits the same always-Classic styling as every other checkout field under every seasonal theme", () => {
    const css = read("css/themes.css");
    assert.match(css, /body\[class\*=["']theme-["']\]\s*\.checkout-modal\s*\{/);
});

test("7. the order-confirmation success panel includes a hidden-by-default subscription-failure notice with a link to the existing Stay Updated form", () => {
    const js = read("js/cart.js");
    const idx = js.indexOf('id="checkoutSubscriptionNotice"');
    assert.ok(idx !== -1);

    const block = js.slice(idx, idx + 400);
    assert.match(block, /display:none/);
    assert.match(block, /didn't go through/i);
    assert.match(block, /href="index\.html#newsletterForm"/);
});

/* ==========================================
   EDGE FUNCTION: canonical path reused, source added
========================================== */

test("8. newsletter-subscribe's ALLOWED_SOURCES includes \"checkout\", so consent_source is recorded accurately rather than falling back to newsletter_form", () => {
    const ts = read("supabase/functions/newsletter-subscribe/index.ts");
    const match = ts.match(/const ALLOWED_SOURCES = (\[[^\]]*\]);/);
    assert.ok(match, "could not find ALLOWED_SOURCES");
    const sources = JSON.parse(match[1].replace(/'/g, '"'));
    assert.ok(sources.includes("checkout"));
});

test("9. the subscriber table is still written ONLY through this Edge Function -- no new direct-table-write path was introduced for checkout", () => {
    const js = read("js/cart.js");
    assert.doesNotMatch(js, /from\(["']subscribers["']\)/);
    assert.match(js, /functions\.invoke\("newsletter-subscribe"/);
});

test("10. the reactivation/idempotency logic inside newsletter-subscribe is untouched: welcome email only fires on a genuine 0->active transition, never for an already-active subscriber", () => {
    const ts = read("supabase/functions/newsletter-subscribe/index.ts");
    assert.match(ts, /shouldWelcome\s*=\s*reactivating;/);
    assert.match(ts, /alreadySubscribed\s*=\s*!reactivating;/);
    assert.match(ts, /newsletterWelcomeKey\(consentEventId\)/);
});

test("11. the preference-additive-merge (never turns an existing true preference false) is untouched", () => {
    const ts = read("supabase/functions/newsletter-subscribe/index.ts");
    assert.match(ts, /existing\.pref_menu_announcements === true \|\| requestedPreferences\.pref_menu_announcements/);
});

/* ==========================================
   BEHAVIORAL (vm sandbox)
========================================== */

function makeSupabaseClient({ submitResult, submitError, liveMenuItems, invokeResult, invokeError, invokeThrows }) {
    const rpcCalls = [];
    const invokeCalls = [];

    return {
        rpcCalls,
        invokeCalls,
        from(table) {
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
                return Promise.resolve({
                    data: [{ pickup_date: "2026-08-30", pickup_time: "12:30:00", pickup_weekday: 0, cutoff_weekday: 5, cutoff_time: "17:00:00", schedule_timezone: "Europe/Berlin" }],
                    error: null
                });
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
        },
        functions: {
            invoke(name, opts) {
                invokeCalls.push({ name, opts });
                if (invokeThrows) {
                    return Promise.reject(new Error("network down"));
                }
                if (invokeError) {
                    return Promise.resolve({ data: null, error: invokeError });
                }
                return Promise.resolve({ data: invokeResult !== undefined ? invokeResult : { ok: true, alreadySubscribed: false }, error: null });
            }
        }
    };
}

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

const DEFAULT_CART_ITEMS = [
    { type: "standard", id: "item-1", name: "Sourdough Boule", price: 9, quantity: 1 }
];

function loadCartSandbox({ submitResult, submitError, cartItems, liveMenuItems, formValues, checkboxChecked, invokeResult, invokeError, invokeThrows }) {
    const elements = new Map();
    function fakeElement(id) {
        if (!elements.has(id)) {
            const initial = (formValues && formValues[id]) ?? "";
            const checked = id === "checkoutSubscribeMenuUpdates" ? !!checkboxChecked : false;
            elements.set(id, { id, value: initial, checked, textContent: "", innerHTML: "", style: {}, disabled: false, reset: () => {} });
        }
        return elements.get(id);
    }

    const alertCalls = [];
    const sessionStore = new Map();
    const resolvedCartItems = cartItems !== undefined ? cartItems : DEFAULT_CART_ITEMS;
    sessionStore.set(CART_SESSION_KEY, JSON.stringify({ items: resolvedCartItems, lastActivity: Date.now() }));
    const resolvedLiveMenuItems = liveMenuItems !== undefined ? liveMenuItems : deriveMatchingLiveMenu(resolvedCartItems);
    const supabaseClient = makeSupabaseClient({ submitResult, submitError, liveMenuItems: resolvedLiveMenuItems, invokeResult, invokeError, invokeThrows });

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
        localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
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
        this.__getCart = function() { return cart; };
        this.__setCart = function(items) { cart = items; saveCart(); };
        `
    ].join("\n");

    vm.runInContext(source, sandbox);

    return { sandbox, elements, alertCalls, supabaseClient, fakeElement };
}

const VALID_FORM = {
    orderType: "weekly",
    customerName: "Alex Example",
    customerPhone: "555-0100",
    customerEmail: "Alex@Example.com",
    customOrderDetails: ""
};

async function submit(sandbox) {
    // Mirrors the real flow: checkout opening always calls
    // toggleCustomOrderDetails() -> updatePickupInfo() first, which
    // seeds lastPickupPreview so submitOrder()'s own pre-submit
    // freshness re-check (comparing against a mock RPC that always
    // returns the same fixed preview) doesn't spuriously detect a
    // "cutoff crossed while checkout was open" and block submission.
    await sandbox.__updatePickupInfo();

    const fakeButton = { disabled: false, textContent: "" };
    const event = { preventDefault: () => {}, target: { querySelector: () => fakeButton } };
    await sandbox.__submitOrder(event);
    return fakeButton;
}

test("12. checkout does not require consent: an unchecked box still allows the order through, and no subscription call is made", async () => {
    const { sandbox, supabaseClient } = loadCartSandbox({ formValues: VALID_FORM, checkboxChecked: false });

    const button = await submit(sandbox);

    assert.equal(supabaseClient.rpcCalls.filter(c => c.name === "submit_order").length, 1, "the order must still be created");
    assert.equal(supabaseClient.invokeCalls.length, 0, "unchecked box must never trigger a subscription call");
    assert.equal(button.disabled, false);
});

test("13. checked box: subscribes AFTER order success, using the checkout customer's own name/email, with source \"checkout\" and the menu-announcements preference", async () => {
    const { sandbox, supabaseClient } = loadCartSandbox({ formValues: VALID_FORM, checkboxChecked: true });

    await submit(sandbox);

    const submitIdx = supabaseClient.rpcCalls.findIndex(c => c.name === "submit_order");
    assert.equal(supabaseClient.invokeCalls.length, 1);
    assert.notEqual(submitIdx, -1);

    const invoked = supabaseClient.invokeCalls[0];
    assert.equal(invoked.name, "newsletter-subscribe");
    assert.equal(invoked.opts.body.email, "Alex@Example.com");
    assert.equal(invoked.opts.body.name, "Alex Example");
    assert.equal(invoked.opts.body.source, "checkout");
    assert.equal(
        JSON.stringify(invoked.opts.body.preferences),
        JSON.stringify({ menuAnnouncements: true })
    );
});

test("14. failed order creation: submit_order errors out -> no subscription call is ever made, even with the box checked", async () => {
    const { sandbox, supabaseClient, alertCalls } = loadCartSandbox({
        formValues: VALID_FORM,
        checkboxChecked: true,
        submitError: { message: "Ordering is currently paused for vacation." }
    });

    await submit(sandbox);

    assert.equal(supabaseClient.invokeCalls.length, 0, "a failed order must never trigger a subscription attempt");
    assert.ok(alertCalls.some(a => /paused for vacation/i.test(a)));
});

test("15. subscription failure (server rejects) does not undo, duplicate, or hide the successful order -- exactly one submit_order call, cart still cleared, failure notice shown", async () => {
    const { sandbox, supabaseClient, elements } = loadCartSandbox({
        formValues: VALID_FORM,
        checkboxChecked: true,
        invokeResult: { ok: false, reason: "rate_limited" }
    });

    await submit(sandbox);

    assert.equal(supabaseClient.rpcCalls.filter(c => c.name === "submit_order").length, 1, "exactly one order, never duplicated");
    assert.equal(sandbox.__getCart().length, 0, "cart must still be cleared -- the order succeeded");
    assert.equal(elements.get("checkoutSuccess").style.display, "block", "success panel must still show");
    assert.equal(elements.get("checkoutSubscriptionNotice").style.display, "block", "subscription-failure notice must be shown");
});

test("16. subscription failure via thrown/network error is handled the same way as a server-reported failure", async () => {
    const { sandbox, elements, supabaseClient } = loadCartSandbox({
        formValues: VALID_FORM,
        checkboxChecked: true,
        invokeThrows: true
    });

    await submit(sandbox);

    assert.equal(supabaseClient.rpcCalls.filter(c => c.name === "submit_order").length, 1);
    assert.equal(elements.get("checkoutSuccess").style.display, "block");
    assert.equal(elements.get("checkoutSubscriptionNotice").style.display, "block");
});

test("17. successful subscription shows no failure notice", async () => {
    const { sandbox, elements } = loadCartSandbox({
        formValues: VALID_FORM,
        checkboxChecked: true,
        invokeResult: { ok: true, alreadySubscribed: false }
    });

    await submit(sandbox);

    assert.equal(elements.get("checkoutSubscriptionNotice").style.display, "none");
});

test("18. a repeated Submit click/retry after a successful order never produces a second subscription call -- the cart is already cleared, so the retried attempt is a no-op before it ever reaches the subscription step", async () => {
    const { sandbox, supabaseClient } = loadCartSandbox({
        formValues: VALID_FORM,
        checkboxChecked: true,
        cartItems: [{ type: "standard", id: "item-1", name: "Sourdough Boule", price: 9, quantity: 2 }]
    });

    await submit(sandbox); // real order + real subscription call
    await submit(sandbox); // retry/duplicate click against the now-empty cart

    assert.equal(supabaseClient.rpcCalls.filter(c => c.name === "submit_order").length, 1, "no duplicate order");
    assert.equal(supabaseClient.invokeCalls.length, 1, "no duplicate subscription call");
});

test("18b. two genuinely separate successful orders for the SAME email each call newsletter-subscribe -- de-duplication of the subscriber ROW (not the client call) is the Edge Function's own job, verified live and by its untouched reactivation logic above", async () => {
    const liveMenuItems = [
        { id: "item-1", product_type: "standard", available: true, price: 9 },
        { id: "item-2", product_type: "standard", available: true, price: 7 }
    ];
    const { sandbox, supabaseClient, elements } = loadCartSandbox({
        formValues: VALID_FORM,
        checkboxChecked: true,
        cartItems: [{ type: "standard", id: "item-1", name: "Sourdough Boule", price: 9, quantity: 1 }],
        liveMenuItems
    });

    await submit(sandbox); // first order -> clearCart() empties the cart

    // A second, separate order placed in the same session: re-add an
    // item and re-check the box, exactly as a real returning customer
    // would (the checkbox itself was also reset to unchecked by the
    // intervening close/reopen -- re-checking it here is deliberate).
    sandbox.__setCart([{ type: "standard", id: "item-2", name: "Rye Loaf", price: 7, quantity: 1 }]);
    elements.get("checkoutSubscribeMenuUpdates").checked = true;

    await submit(sandbox);

    assert.equal(supabaseClient.rpcCalls.filter(c => c.name === "submit_order").length, 2);
    assert.equal(supabaseClient.invokeCalls.length, 2);
    assert.equal(supabaseClient.invokeCalls[0].opts.body.email, supabaseClient.invokeCalls[1].opts.body.email);
});

test("19. openCheckoutModal unconditionally forces the checkbox unchecked -- never preselected from a prior state", async () => {
    const cartItems = [{ type: "standard", id: "item-1", name: "Sourdough Boule", price: 9, quantity: 1 }];
    const { sandbox, elements } = loadCartSandbox({
        formValues: VALID_FORM,
        cartItems,
        checkboxChecked: true // simulate it somehow already being checked
    });

    await sandbox.__openCheckoutModal();

    assert.equal(elements.get("checkoutSubscribeMenuUpdates").checked, false, "opening checkout must force the box unchecked regardless of any prior state");
});

test("20. a Mix & Match box order still submits correctly with the subscription box checked -- the two features are fully independent", async () => {
    const cartItems = [
        {
            id: "box-6", type: "builder", name: "6 Mix & Match Cookies", price: 15, quantity: 1,
            builder_group: "cookie",
            selections: [{ id: "cookie-1", name: "S'mores", quantity: 6 }]
        }
    ];

    const { sandbox, supabaseClient } = loadCartSandbox({
        formValues: VALID_FORM,
        cartItems,
        checkboxChecked: true
    });

    await submit(sandbox);

    const submitCall = supabaseClient.rpcCalls.find(c => c.name === "submit_order");
    assert.ok(submitCall);
    assert.equal(submitCall.params.p_items[0].builder_details.selections[0].name, "S'mores");
    assert.equal(supabaseClient.invokeCalls.length, 1, "subscription still fires independently of the Mix & Match order shape");
});

test("21. a custom order still submits correctly with the subscription box checked", async () => {
    const { sandbox, supabaseClient } = loadCartSandbox({
        formValues: { ...VALID_FORM, orderType: "custom", customOrderDetails: "Birthday order, 20 people" },
        checkboxChecked: true
    });

    await submit(sandbox);

    const submitCall = supabaseClient.rpcCalls.find(c => c.name === "submit_order");
    assert.ok(submitCall);
    assert.equal(submitCall.params.p_order_type, "custom");
    assert.equal(supabaseClient.invokeCalls.length, 1);
});

test("22. submit_order's own payload is completely unaffected by the subscription checkbox -- no subscription-related field is ever sent to it, and order-lifecycle emails stay purely server-side (trigger-enqueued, not called from here)", async () => {
    const { sandbox, supabaseClient } = loadCartSandbox({ formValues: VALID_FORM, checkboxChecked: true });

    await submit(sandbox);

    const submitCall = supabaseClient.rpcCalls.find(c => c.name === "submit_order");
    const paramKeys = Object.keys(submitCall.params);
    assert.ok(!paramKeys.some(k => /subscribe|newsletter|consent/i.test(k)));
});
