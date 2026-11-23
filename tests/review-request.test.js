"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/* ==========================================
   Tests for the automatic review-request email + secure order-linked
   review flow: supabase/functions/_shared/publicName.mjs,
   reviewOrderSnapshot.mjs, reviewToken.mjs, idempotency.mjs's
   reviewRequestKey, and templates.mjs's reviewRequestEmail. Same
   dynamic-import convention as tests/email-shared.test.js -- these
   are plain, dependency-free ESM files imported exactly as the Edge
   Functions ship them, zero mocking of the files under test
   themselves.
   ========================================== */

const SHARED = "../supabase/functions/_shared/";

/* ---------------- publicName.mjs ---------------- */

test("publicName: firstNameLastInitial formats 'First Last' as 'First L.'", async () => {
    const { firstNameLastInitial } = await import(SHARED + "publicName.mjs");
    assert.equal(firstNameLastInitial("Jessica Holsopple"), "Jessica H.");
    assert.equal(firstNameLastInitial("Marcus Smith"), "Marcus S.");
});

test("publicName: firstNameLastInitial handles a middle name (uses first + LAST token only)", async () => {
    const { firstNameLastInitial } = await import(SHARED + "publicName.mjs");
    assert.equal(firstNameLastInitial("Marcus James Smith"), "Marcus S.");
});

test("publicName: firstNameLastInitial never fabricates an initial for a single-word name", async () => {
    const { firstNameLastInitial } = await import(SHARED + "publicName.mjs");
    assert.equal(firstNameLastInitial("Cher"), "Cher");
    assert.equal(firstNameLastInitial(""), "");
    assert.equal(firstNameLastInitial(null), "");
});

test("publicName: firstNameLastInitial never includes the full last name", async () => {
    const { firstNameLastInitial } = await import(SHARED + "publicName.mjs");
    const result = firstNameLastInitial("Jessica Holsopple");
    assert.ok(!result.includes("Holsopple"));
});

test("publicName: sanitizePublicDisplayName falls back to First L. for a blank candidate", async () => {
    const { sanitizePublicDisplayName } = await import(SHARED + "publicName.mjs");
    const result = sanitizePublicDisplayName("   ", "Jessica Holsopple");
    assert.deepEqual(result, { ok: true, value: "Jessica H." });
});

test("publicName: sanitizePublicDisplayName accepts a nickname unrelated to the checkout name", async () => {
    const { sanitizePublicDisplayName } = await import(SHARED + "publicName.mjs");
    const result = sanitizePublicDisplayName("Sourdough Fan 22", "Jessica Holsopple");
    assert.deepEqual(result, { ok: true, value: "Sourdough Fan 22" });
});

test("publicName: sanitizePublicDisplayName normalizes a typed-out full real last name down to an initial, never publishing it", async () => {
    const { sanitizePublicDisplayName } = await import(SHARED + "publicName.mjs");
    const result = sanitizePublicDisplayName("Jessica Holsopple", "Jessica Holsopple");
    assert.equal(result.ok, true);
    assert.equal(result.value, "Jessica H.");
    assert.ok(!result.value.includes("Holsopple"));
});

test("publicName: sanitizePublicDisplayName is case-insensitive when matching the real last name", async () => {
    const { sanitizePublicDisplayName } = await import(SHARED + "publicName.mjs");
    const result = sanitizePublicDisplayName("jessica HOLSOPPLE", "Jessica Holsopple");
    assert.equal(result.value, "jessica H.");
});

test("publicName: sanitizePublicDisplayName rejects an email address", async () => {
    const { sanitizePublicDisplayName } = await import(SHARED + "publicName.mjs");
    const result = sanitizePublicDisplayName("jess@example.com", "Jessica Holsopple");
    assert.deepEqual(result, { ok: false, reason: "email" });
});

test("publicName: sanitizePublicDisplayName rejects a URL", async () => {
    const { sanitizePublicDisplayName } = await import(SHARED + "publicName.mjs");
    assert.equal(sanitizePublicDisplayName("https://example.com", "Jessica Holsopple").reason, "url");
    assert.equal(sanitizePublicDisplayName("www.example.com", "Jessica Holsopple").reason, "url");
});

test("publicName: sanitizePublicDisplayName rejects a phone number", async () => {
    const { sanitizePublicDisplayName } = await import(SHARED + "publicName.mjs");
    const result = sanitizePublicDisplayName("443-470-0714", "Jessica Holsopple");
    assert.deepEqual(result, { ok: false, reason: "phone" });
});

test("publicName: sanitizePublicDisplayName rejects an excessively long value", async () => {
    const { sanitizePublicDisplayName } = await import(SHARED + "publicName.mjs");
    const result = sanitizePublicDisplayName("x".repeat(200), "Jessica Holsopple");
    assert.deepEqual(result, { ok: false, reason: "too_long" });
});

test("publicName: sanitizePublicDisplayName strips control characters and trims", async () => {
    const { sanitizePublicDisplayName } = await import(SHARED + "publicName.mjs");
    const result = sanitizePublicDisplayName("  Jess  B.  ", "Jessica Holsopple");
    assert.equal(result.ok, true);
    assert.equal(result.value, "Jess  B.");
});

/* ---------------- reviewOrderSnapshot.mjs ---------------- */

test("reviewOrderSnapshot: standard multi-item, multi-quantity order", async () => {
    const { buildSafeOrderItemsSummary } = await import(SHARED + "reviewOrderSnapshot.mjs");
    const summary = buildSafeOrderItemsSummary([
        { item_name: "Classic Boule", quantity: 2, price_at_purchase: 9, line_total: 18, builder_details: null, promotion_redemption_id: null },
        { item_name: "Sea Salt Cookie", quantity: 3, price_at_purchase: 3.5, line_total: 10.5, builder_details: null, promotion_redemption_id: null }
    ]);

    assert.deepEqual(summary, [
        { name: "Classic Boule", quantity: 2, isPromo: false, flavors: null },
        { name: "Sea Salt Cookie", quantity: 3, isPromo: false, flavors: null }
    ]);
});

test("reviewOrderSnapshot: never includes price fields even when present on the source row", async () => {
    const { buildSafeOrderItemsSummary } = await import(SHARED + "reviewOrderSnapshot.mjs");
    const summary = buildSafeOrderItemsSummary([
        { item_name: "Classic Boule", quantity: 1, price_at_purchase: 9, line_total: 9, menu_item_id: "menu-1" }
    ]);
    const json = JSON.stringify(summary);
    assert.ok(!json.includes("price"));
    assert.ok(!json.includes("9"));
    assert.ok(!json.includes("menu-1"));
});

test("reviewOrderSnapshot: Mix & Match box with a flavor breakdown", async () => {
    const { buildSafeOrderItemsSummary } = await import(SHARED + "reviewOrderSnapshot.mjs");
    const summary = buildSafeOrderItemsSummary([{
        item_name: "Mix & Match Cookie Box",
        quantity: 1,
        builder_details: {
            builder_group: "cookies",
            box_quantity: 1,
            selections: [
                { id: "c1", name: "Brown Butter Sea Salt", quantity: 3 },
                { id: "c2", name: "Chocolate Chip", quantity: 3 }
            ]
        },
        promotion_redemption_id: null
    }]);

    assert.deepEqual(summary, [{
        name: "Mix & Match Cookie Box",
        quantity: 1,
        isPromo: false,
        flavors: [
            { name: "Brown Butter Sea Salt", quantity: 3 },
            { name: "Chocolate Chip", quantity: 3 }
        ]
    }]);
});

test("reviewOrderSnapshot: a promotional (free) item is flagged isPromo, not inferred from price alone", async () => {
    const { buildSafeOrderItemsSummary } = await import(SHARED + "reviewOrderSnapshot.mjs");
    const summary = buildSafeOrderItemsSummary([
        { item_name: "Free Cookie", quantity: 1, price_at_purchase: 0, line_total: 0, promotion_redemption_id: "promo-redemption-1" }
    ]);
    assert.equal(summary[0].isPromo, true);
    assert.equal(summary[0].name, "Free Cookie");
});

test("reviewOrderSnapshot: an item whose menu_item_id is null (removed from the current menu) still shows its frozen name/quantity", async () => {
    const { buildSafeOrderItemsSummary } = await import(SHARED + "reviewOrderSnapshot.mjs");
    const summary = buildSafeOrderItemsSummary([
        { item_name: "Discontinued Seasonal Loaf", quantity: 1, menu_item_id: null, builder_details: null, promotion_redemption_id: null }
    ]);
    assert.deepEqual(summary, [
        { name: "Discontinued Seasonal Loaf", quantity: 1, isPromo: false, flavors: null }
    ]);
});

test("reviewOrderSnapshot: a builder line with no real selections yields flavors: null, not an empty array", async () => {
    const { buildSafeOrderItemsSummary } = await import(SHARED + "reviewOrderSnapshot.mjs");
    const summary = buildSafeOrderItemsSummary([
        { item_name: "Mix & Match Box", quantity: 1, builder_details: { builder_group: "cookies", selections: [] } }
    ]);
    assert.equal(summary[0].flavors, null);
});

/* ---------------- idempotency.mjs ---------------- */

test("idempotency: reviewRequestKey matches the SQL trigger's exact string format, keyed only by order id", async () => {
    const idem = await import(SHARED + "idempotency.mjs");
    assert.equal(idem.reviewRequestKey("order-1"), "review_request:order-1");
});

test("idempotency: reviewRequestKey never collides with another order or another email type for the same order", async () => {
    const idem = await import(SHARED + "idempotency.mjs");
    assert.notEqual(idem.reviewRequestKey("order-1"), idem.reviewRequestKey("order-2"));
    assert.notEqual(idem.reviewRequestKey("order-1"), idem.orderConfirmedKey("order-1"));
    assert.notEqual(idem.reviewRequestKey("order-1"), idem.orderReceivedKey("order-1"));
});

/* ---------------- reviewToken.mjs ---------------- */

function chainableResponse(response) {
    const node = {
        select() { return node; },
        eq() { return node; },
        maybeSingle: async () => response,
        then(resolve, reject) {
            return Promise.resolve(response).then(resolve, reject);
        }
    };
    return node;
}

function createFakeAdminClient(responsesByTable) {
    return {
        from(table) {
            return chainableResponse(responsesByTable[table] || { data: null, error: null });
        }
    };
}

const RAW_TOKEN = "a".repeat(64);
const FUTURE = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 1000).toISOString();

async function hashOf(token) {
    const { hashToken } = await import(SHARED + "token.mjs");
    return hashToken(token);
}

test("reviewToken: a valid, unexpired, unused token for a completed order with no existing review resolves ok", async () => {
    const { validateReviewToken } = await import(SHARED + "reviewToken.mjs");
    const tokenHash = await hashOf(RAW_TOKEN);

    const client = createFakeAdminClient({
        review_request_tokens: { data: { token_hash: tokenHash, order_id: "order-1", expires_at: FUTURE, used_at: null }, error: null },
        orders: { data: { id: "order-1", customer_name: "Jessica Holsopple", status: "completed" }, error: null },
        reviews: { data: null, error: null },
        order_items: { data: [{ item_name: "Classic Boule", quantity: 1, builder_details: null, promotion_redemption_id: null }], error: null }
    });

    const result = await validateReviewToken(client, RAW_TOKEN);
    assert.equal(result.ok, true);
    assert.equal(result.tokenHash, tokenHash);
    assert.equal(result.order.id, "order-1");
    assert.equal(result.items.length, 1);
});

test("reviewToken: a token not found in the table is invalid", async () => {
    const { validateReviewToken } = await import(SHARED + "reviewToken.mjs");
    const client = createFakeAdminClient({ review_request_tokens: { data: null, error: null } });
    const result = await validateReviewToken(client, RAW_TOKEN);
    assert.deepEqual(result, { ok: false, reason: "invalid" });
});

test("reviewToken: a too-short/empty token is rejected before any DB lookup", async () => {
    const { validateReviewToken } = await import(SHARED + "reviewToken.mjs");
    const client = createFakeAdminClient({});
    assert.deepEqual(await validateReviewToken(client, ""), { ok: false, reason: "invalid" });
    assert.deepEqual(await validateReviewToken(client, "short"), { ok: false, reason: "invalid" });
});

test("reviewToken: an expired token is rejected even though it was once valid", async () => {
    const { validateReviewToken } = await import(SHARED + "reviewToken.mjs");
    const tokenHash = await hashOf(RAW_TOKEN);
    const client = createFakeAdminClient({
        review_request_tokens: { data: { token_hash: tokenHash, order_id: "order-1", expires_at: PAST, used_at: null }, error: null }
    });
    const result = await validateReviewToken(client, RAW_TOKEN);
    assert.deepEqual(result, { ok: false, reason: "expired" });
});

test("reviewToken: an already-used token is rejected", async () => {
    const { validateReviewToken } = await import(SHARED + "reviewToken.mjs");
    const tokenHash = await hashOf(RAW_TOKEN);
    const client = createFakeAdminClient({
        review_request_tokens: { data: { token_hash: tokenHash, order_id: "order-1", expires_at: FUTURE, used_at: new Date().toISOString() }, error: null }
    });
    const result = await validateReviewToken(client, RAW_TOKEN);
    assert.deepEqual(result, { ok: false, reason: "used" });
});

test("reviewToken: an order that is no longer 'completed' (e.g. Undo Completion) is treated as invalid, not leaked as a distinct reason", async () => {
    const { validateReviewToken } = await import(SHARED + "reviewToken.mjs");
    const tokenHash = await hashOf(RAW_TOKEN);
    const client = createFakeAdminClient({
        review_request_tokens: { data: { token_hash: tokenHash, order_id: "order-1", expires_at: FUTURE, used_at: null }, error: null },
        orders: { data: { id: "order-1", customer_name: "Jessica Holsopple", status: "confirmed" }, error: null }
    });
    const result = await validateReviewToken(client, RAW_TOKEN);
    assert.deepEqual(result, { ok: false, reason: "invalid" });
});

test("reviewToken: a second attempt against an order that already has a review is rejected as used (duplicate-review prevention)", async () => {
    const { validateReviewToken } = await import(SHARED + "reviewToken.mjs");
    const tokenHash = await hashOf(RAW_TOKEN);
    const client = createFakeAdminClient({
        review_request_tokens: { data: { token_hash: tokenHash, order_id: "order-1", expires_at: FUTURE, used_at: null }, error: null },
        orders: { data: { id: "order-1", customer_name: "Jessica Holsopple", status: "completed" }, error: null },
        reviews: { data: { id: "existing-review" }, error: null }
    });
    const result = await validateReviewToken(client, RAW_TOKEN);
    assert.deepEqual(result, { ok: false, reason: "used" });
});

test("reviewToken: a single altered character produces a different hash and fails lookup -- tokens cannot be tampered to address another order", async () => {
    const { validateReviewToken } = await import(SHARED + "reviewToken.mjs");

    const validHash = await hashOf(RAW_TOKEN);
    const alteredToken = "b" + RAW_TOKEN.slice(1); // one character changed

    const rowsByHash = { [validHash]: { token_hash: validHash, order_id: "order-1", expires_at: FUTURE, used_at: null } };
    const otherTableResponses = {
        orders: { data: { id: "order-1", customer_name: "Jessica Holsopple", status: "completed" }, error: null },
        reviews: { data: null, error: null },
        order_items: { data: [], error: null }
    };

    const client = {
        from(table) {
            if (table !== "review_request_tokens") {
                return chainableResponse(otherTableResponses[table] || { data: null, error: null });
            }
            let filterValue;
            const node = {
                select() { return node; },
                eq(_col, val) { filterValue = val; return node; },
                maybeSingle: async () => ({ data: rowsByHash[filterValue] || null, error: null })
            };
            return node;
        }
    };

    const validResult = await validateReviewToken(client, RAW_TOKEN);
    assert.equal(validResult.ok, true); // proves the correct raw token's hash matched the stored row

    const alteredResult = await validateReviewToken(client, alteredToken);
    assert.deepEqual(alteredResult, { ok: false, reason: "invalid" }); // a different hash -> no matching row
});

/* ---------------- templates.mjs: reviewRequestEmail ---------------- */

test("templates: reviewRequestEmail uses the exact subject/heading/button copy and singular first-person language", async () => {
    const t = await import(SHARED + "templates.mjs");
    const result = t.reviewRequestEmail({
        customerName: "Jessica H.",
        orderRef: "abc12345",
        items: [{ name: "Classic Boule", quantity: 1, isPromo: false, flavors: null }],
        reviewUrl: "https://jessbakessourdough.com/reviews.html?t=rawtoken"
    });

    assert.equal(result.subject, "How did everything taste? \u{1F36A}");
    assert.ok(result.html.includes("I'd love your feedback!"));
    assert.ok(result.html.includes("Leave a Review"));
    assert.ok(result.html.includes("https://jessbakessourdough.com/reviews.html?t=rawtoken"));
    assert.ok(result.text.includes("https://jessbakessourdough.com/reviews.html?t=rawtoken"));

    // Singular "I/me/my" voice, never "we/our" -- Jess Bakes Sourdough
    // is run by one person.
    assert.ok(result.text.includes("Jess\nJess Bakes Sourdough"));
    assert.ok(!/\bwe\b|\bour\b/i.test(result.text));
});

test("templates: reviewRequestEmail never shows a price for any item", async () => {
    const t = await import(SHARED + "templates.mjs");
    const result = t.reviewRequestEmail({
        customerName: "Jessica H.",
        orderRef: "abc12345",
        items: [{ name: "Classic Boule", quantity: 2, isPromo: false, flavors: null }],
        reviewUrl: "https://jessbakessourdough.com/reviews.html?t=rawtoken"
    });

    assert.ok(!/[$€]/.test(result.html));
    assert.ok(!/[$€]/.test(result.text));
});

test("templates: reviewRequestEmail lists a Mix & Match flavor breakdown and labels a promo item as free", async () => {
    const t = await import(SHARED + "templates.mjs");
    const result = t.reviewRequestEmail({
        customerName: "Jessica H.",
        orderRef: "abc12345",
        items: [
            { name: "Mix & Match Box", quantity: 1, isPromo: false, flavors: [{ name: "Chocolate Chip", quantity: 3 }] },
            { name: "Free Cookie", quantity: 1, isPromo: true, flavors: null }
        ],
        reviewUrl: "https://jessbakessourdough.com/reviews.html?t=rawtoken"
    });

    assert.ok(result.html.includes("Chocolate Chip"));
    assert.ok(result.html.includes("Free Cookie"));
    assert.ok(/free/i.test(result.html));
});

/* ---------------- static HTML/JS: stale picker removed ---------------- */

test("reviews.html no longer contains the hardcoded product dropdown", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "reviews.html"), "utf8");
    assert.ok(!html.includes("reviewProduct"));
    assert.ok(!html.includes("Select an item"));
    assert.ok(!html.includes("Classic Boule"));
    assert.ok(!html.includes("Jalapeño Cheddar Boule"));
});

test("js/reviews.js no longer references a product select element", () => {
    const js = fs.readFileSync(path.join(__dirname, "..", "js", "reviews.js"), "utf8");
    assert.ok(!js.includes("reviewProduct"));
});

/* ---------------- send-emails/index.ts: master toggle gating ----------------
   processPending() is Deno-only TypeScript (can't be imported under
   node:test -- same limitation as the rest of the Edge Function entry
   points, see docs/bakery-rebuild/10-email-system.md section 8), so this is a static
   source check rather than a behavioral one: it would have caught the
   real bug found during this feature's own live-verification pass,
   where 'review_request' doesn't share the "order_" prefix every
   other order-lifecycle email_type uses, and so silently bypassed the
   order_emails_enabled master toggle entirely until both of these
   lines were added. */
test("send-emails: review_request is gated by order_emails_enabled like every other order-lifecycle email", () => {
    const ts = fs.readFileSync(
        path.join(__dirname, "..", "supabase", "functions", "send-emails", "index.ts"),
        "utf8"
    );

    assert.match(
        ts,
        /disabledTypes\.push\("order_received", "order_confirmed", "order_confirmed_resend", "order_cancelled", "review_request"\)/
    );
    assert.match(
        ts,
        /row\.email_type\.startsWith\("order_"\)\s*\|\|\s*row\.email_type === "review_request"/
    );
});
