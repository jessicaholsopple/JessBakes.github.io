"use strict";

/* ==========================================
   Checkout email notice (js/cart.js)

   Structural/regression tests for the informational notice added to
   the checkout form explaining the two-email order flow (order
   received -> order confirmed). Pure text/markup assertions against
   the real source -- no DOM/vm sandbox needed since this is static
   HTML baked into ensureCheckoutModal()'s template string.
   ========================================== */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function read(relPath) {
    return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

const EXACT_NOTICE_TEXT =
    "Order updates are sent by email. After submitting your order, you'll receive an email confirming that your order request was received. Once your order is approved, you'll receive a second \"Order Confirmed\" email containing your payment options, order total, pickup date and time, and pickup-location information. Please make sure your email address is correct and check your spam or junk folder if you don't see either message.";

test("1. checkout form contains the exact required email-notice wording", () => {
    const js = read("js/cart.js");
    assert.ok(
        js.includes(EXACT_NOTICE_TEXT),
        "expected js/cart.js to contain the exact specified checkout email notice text"
    );
});

test("2. the notice lives inside .checkout-email-notice, between the custom-order-details group and the Submit Order button", () => {
    const js = read("js/cart.js");
    const formStart = js.indexOf('id="checkoutForm"');
    const customOrderEnd = js.indexOf("customOrderDetailsGroup", formStart);
    const noticeIndex = js.indexOf("checkout-email-notice", formStart);
    const submitButtonIndex = js.indexOf("Submit Order", formStart);

    assert.ok(formStart !== -1, "checkoutForm not found");
    assert.ok(noticeIndex !== -1, ".checkout-email-notice class not found");
    assert.ok(
        noticeIndex > customOrderEnd && noticeIndex < submitButtonIndex,
        "notice must appear after the custom-order-details group and before the Submit Order button"
    );
});

test("3. the notice does not introduce a new checkbox or require explicit acknowledgment", () => {
    const js = read("js/cart.js");
    const noticeStart = js.indexOf("checkout-email-notice");
    const noticeBlockEnd = js.indexOf("</p>", noticeStart);
    const noticeBlock = js.slice(noticeStart, noticeBlockEnd);

    assert.doesNotMatch(noticeBlock, /type=["']checkbox["']/);
    assert.doesNotMatch(noticeBlock, /\bI acknowledge\b/i);
    assert.doesNotMatch(noticeBlock, /\bI agree\b/i);
});

test("4. the notice frames submission as a request, and approval as a separate, later, conditional step", () => {
    const js = read("js/cart.js");
    const noticeStart = js.indexOf("checkout-email-notice");
    const noticeBlockEnd = js.indexOf("</p>", noticeStart);
    const noticeBlock = js.slice(noticeStart, noticeBlockEnd);

    // The first email must confirm only that the REQUEST was received,
    // not that it was approved -- "Once your order is approved" is the
    // correct conditional framing for the second email and must not be
    // collapsed into a bare "your order is/has been approved" claim
    // about the first (submission) email.
    assert.match(noticeBlock, /order request was received/i);
    assert.match(noticeBlock, /once your order is approved/i);
    // Any "approved" claim must be part of the "once ... approved"
    // conditional, never a bare claim that it already happened.
    assert.doesNotMatch(noticeBlock, /(?<!once )your order (?:is|has been) approved/i);
});

test("5. css/style.css styles .checkout-email-notice (not left unstyled)", () => {
    const css = read("css/style.css");
    assert.match(css, /\.checkout-email-notice\s*\{/);
});

test("6. css/themes.css resets the checkout modal's core tokens, so the notice box reads consistently under every seasonal theme", () => {
    const css = read("css/themes.css");
    assert.match(css, /body\[class\*=["']theme-["']\]\s*\.checkout-modal\s*\{/);
});

test("7. the existing order-received/order-confirmed email templates and triggers are untouched by this change", () => {
    const js = read("js/cart.js");
    // submit_order RPC call itself must still exist, unmodified by this
    // feature -- this is purely a client-side informational addition.
    assert.match(js, /supabaseClient\.rpc\("submit_order"/);
});
