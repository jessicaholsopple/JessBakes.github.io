"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

/* ==========================================
   Tests for supabase/functions/_shared/*.mjs -- the pure,
   dependency-free logic behind the production email system. These
   files are plain ESM using only Web-standard APIs (no Deno/Node-
   specific globals besides the WebCrypto `crypto` global, which
   Node >= 19 provides natively), so they're imported here via
   dynamic import() exactly as written, with zero mocking/shimming
   and zero duplication against what the Edge Functions actually
   ship.
   ========================================== */

const SHARED = "../supabase/functions/_shared/";

test("idempotency: key builders match the exact format the DB triggers use", async () => {
    const idem = await import(SHARED + "idempotency.mjs");

    assert.equal(idem.orderReceivedKey("abc-123"), "order_received:abc-123");
    assert.equal(idem.orderConfirmedKey("abc-123"), "order_confirmed:abc-123");
    assert.equal(idem.orderCancelledKey("abc-123"), "order_cancelled:abc-123");
    assert.equal(idem.newsletterWelcomeKey("ev-1"), "newsletter_welcome:ev-1");
    assert.equal(idem.weeklyCampaignKey("2026-08-23"), "weekly_menu:2026-08-23");
    assert.equal(
        idem.weeklyRecipientKey("weekly_menu:2026-08-23", "sub-1"),
        "weekly_menu:2026-08-23:sub-1"
    );
    assert.equal(idem.adminNewOrderKey("abc-123"), "admin_new_order:abc-123");
});

test("idempotency: different orders/consent events/campaigns never collide", async () => {
    const idem = await import(SHARED + "idempotency.mjs");
    assert.notEqual(idem.orderReceivedKey("a"), idem.orderReceivedKey("b"));
    assert.notEqual(idem.newsletterWelcomeKey("ev-1"), idem.newsletterWelcomeKey("ev-2"));
    // admin_new_order and order_received are independent email types
    // for the same order -- different keys, so a failure/retry of one
    // can never collide with or block the other.
    assert.notEqual(idem.adminNewOrderKey("order-1"), idem.orderReceivedKey("order-1"));
    assert.notEqual(idem.adminNewOrderKey("a"), idem.adminNewOrderKey("b"));
});

test("idempotency: vacation reopening keys are keyed by cycle id, one campaign per cycle, one row per (campaign, subscriber)", async () => {
    const idem = await import(SHARED + "idempotency.mjs");

    assert.equal(idem.vacationReopeningCampaignKey("cycle-1"), "vacation_reopening:cycle-1");
    assert.equal(
        idem.vacationReopeningRecipientKey("vacation_reopening:cycle-1", "sub-1"),
        "vacation_reopening:cycle-1:sub-1"
    );

    // Same cycle id requested twice (retry/double-click/scheduler +
    // manual button both firing) yields the SAME campaign key -- the
    // unique constraint on email_campaigns.campaign_key is what turns
    // a second call into a harmless "already exists" no-op.
    assert.equal(idem.vacationReopeningCampaignKey("cycle-1"), idem.vacationReopeningCampaignKey("cycle-1"));

    // Different cycles (this vacation vs. a future one) never collide,
    // so a subscriber fulfilled in a past cycle is addressable again.
    assert.notEqual(idem.vacationReopeningCampaignKey("cycle-1"), idem.vacationReopeningCampaignKey("cycle-2"));

    // Never collides with the unrelated weekly campaign's key space.
    assert.notEqual(idem.vacationReopeningCampaignKey("cycle-1"), idem.weeklyCampaignKey("cycle-1"));
});

/* ---------------- schedule.mjs (DST-safe) ---------------- */

test("schedule: due exactly at the configured Berlin local time in summer (CEST, UTC+2)", async () => {
    const { isWeeklySendDue } = await import(SHARED + "schedule.mjs");
    const settings = { weekly_weekday: 0, weekly_local_time: "18:00", weekly_timezone: "Europe/Berlin" };

    // 2026-08-23 is a Sunday. 18:00 CEST (UTC+2) == 16:00 UTC.
    const result = isWeeklySendDue(new Date("2026-08-23T16:05:00Z"), settings);
    assert.equal(result.due, true);
    assert.equal(result.campaignKey, "weekly_menu:2026-08-23");
});

test("schedule: due exactly at the configured Berlin local time in winter (CET, UTC+1)", async () => {
    const { isWeeklySendDue } = await import(SHARED + "schedule.mjs");
    const settings = { weekly_weekday: 0, weekly_local_time: "18:00", weekly_timezone: "Europe/Berlin" };

    // 2026-11-01 is a Sunday, after the Oct 25 2026 DST fallback.
    // 18:00 CET (UTC+1) == 17:00 UTC.
    const result = isWeeklySendDue(new Date("2026-11-01T17:05:00Z"), settings);
    assert.equal(result.due, true);
    assert.equal(result.campaignKey, "weekly_menu:2026-11-01");
});

test("schedule: the SAME UTC hour is due in summer but not yet due in winter (proves real DST handling, not a fixed UTC offset)", async () => {
    const { isWeeklySendDue } = await import(SHARED + "schedule.mjs");
    const settings = { weekly_weekday: 0, weekly_local_time: "18:00", weekly_timezone: "Europe/Berlin" };

    // 17:00 UTC on a summer Sunday is 19:00 CEST -- already past the
    // 30-minute window that opened at 18:00 local.
    const summer = isWeeklySendDue(new Date("2026-08-23T17:05:00Z"), settings);
    assert.equal(summer.due, false);

    // 17:00 UTC on a winter Sunday is exactly 18:00 CET -- due.
    const winter = isWeeklySendDue(new Date("2026-11-01T17:05:00Z"), settings);
    assert.equal(winter.due, true);
});

test("schedule: not due on the wrong weekday", async () => {
    const { isWeeklySendDue } = await import(SHARED + "schedule.mjs");
    const settings = { weekly_weekday: 0, weekly_local_time: "18:00", weekly_timezone: "Europe/Berlin" };
    // 2026-08-24 is a Monday.
    const result = isWeeklySendDue(new Date("2026-08-24T16:05:00Z"), settings);
    assert.equal(result.due, false);
    assert.equal(result.campaignKey, null);
});

test("schedule: not due before the window opens or after it closes", async () => {
    const { isWeeklySendDue } = await import(SHARED + "schedule.mjs");
    const settings = { weekly_weekday: 0, weekly_local_time: "18:00", weekly_timezone: "Europe/Berlin" };
    assert.equal(isWeeklySendDue(new Date("2026-08-23T15:59:00Z"), settings).due, false); // 17:59 local
    assert.equal(isWeeklySendDue(new Date("2026-08-23T16:31:00Z"), settings).due, false); // 18:31 local, past 30-min window
});

test("schedule: a malformed local_time degrades to never-due rather than throwing", async () => {
    const { isWeeklySendDue } = await import(SHARED + "schedule.mjs");
    const settings = { weekly_weekday: 0, weekly_local_time: "not-a-time", weekly_timezone: "Europe/Berlin" };
    assert.equal(isWeeklySendDue(new Date("2026-08-23T16:05:00Z"), settings).due, false);
});

/* ---------------- validation.mjs ---------------- */

test("validation: accepts well-formed emails, rejects malformed ones", async () => {
    const v = await import(SHARED + "validation.mjs");
    assert.equal(v.isValidEmail("jess@example.com"), true);
    assert.equal(v.isValidEmail("not-an-email"), false);
    assert.equal(v.isValidEmail(""), false);
    assert.equal(v.isValidEmail("a@b"), false);
    assert.equal(v.isValidEmail("a".repeat(260) + "@example.com"), false);
});

test("validation: normalizeEmail trims and lowercases", async () => {
    const v = await import(SHARED + "validation.mjs");
    assert.equal(v.normalizeEmail("  Test@Example.COM  "), "test@example.com");
});

test("validation: honeypot trips on any non-empty value", async () => {
    const v = await import(SHARED + "validation.mjs");
    assert.equal(v.isHoneypotTripped(""), false);
    assert.equal(v.isHoneypotTripped("   "), false);
    assert.equal(v.isHoneypotTripped("bot-filled-this"), true);
});

test("validation: sanitizeName strips control characters and caps length", async () => {
    const v = await import(SHARED + "validation.mjs");
    assert.equal(v.sanitizeName("Jess\x00\x1F"), "Jess");
    assert.equal(v.sanitizeName("  Jess  "), "Jess");
    assert.equal(v.sanitizeName("x".repeat(200)).length, 100);
});

test("validation: full signup validation rejects honeypot, missing consent, and bad email in that priority order", async () => {
    const v = await import(SHARED + "validation.mjs");
    assert.deepEqual(v.validateSignup({ email: "a@b.com", honeypot: "x", consentChecked: true }), { ok: false, reason: "honeypot" });
    assert.deepEqual(v.validateSignup({ email: "a@b.com", honeypot: "", consentChecked: false }), { ok: false, reason: "consent_required" });
    assert.deepEqual(v.validateSignup({ email: "bad", honeypot: "", consentChecked: true }), { ok: false, reason: "invalid_email" });
    assert.deepEqual(v.validateSignup({ email: "a@b.com", honeypot: "", consentChecked: true }), { ok: true });
});

test("validation: isRateLimited counts only attempts inside the window", async () => {
    const v = await import(SHARED + "validation.mjs");
    const now = 1_000_000;
    const attempts = [now - 1000, now - 2000, now - 500_000]; // 3rd is outside a 10s window
    assert.equal(v.isRateLimited(attempts, now, 10_000, 3), false); // only 2 inside window, need 3
    assert.equal(v.isRateLimited(attempts, now, 10_000, 2), true);
});

/* ---------------- token.mjs ---------------- */

test("token: generateUnsubscribeToken produces distinct 64-char hex tokens", async () => {
    const t = await import(SHARED + "token.mjs");
    const a = t.generateUnsubscribeToken();
    const b = t.generateUnsubscribeToken();
    assert.equal(a.length, 64);
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notEqual(a, b);
});

test("token: hashToken is deterministic and one-way (same input -> same hash, different input -> different hash)", async () => {
    const t = await import(SHARED + "token.mjs");
    const h1 = await t.hashToken("raw-token-value");
    const h2 = await t.hashToken("raw-token-value");
    const h3 = await t.hashToken("different-token");
    assert.equal(h1, h2);
    assert.notEqual(h1, h3);
    assert.match(h1, /^[0-9a-f]{64}$/);
});

test("token: buildUnsubscribeUrl carries only the opaque token, never an ID", async () => {
    const t = await import(SHARED + "token.mjs");
    const url = t.buildUnsubscribeUrl("https://jessbakessourdough.com", "abc123");
    assert.equal(url, "https://jessbakessourdough.com/unsubscribe.html?t=abc123");
    assert.doesNotMatch(url, /[0-9a-f]{8}-[0-9a-f]{4}-/); // no UUID-shaped substring
});

/* ---------------- webhook.mjs ---------------- */

function buildSvixSignature(secretB64, svixId, svixTimestamp, body) {
    const secretBytes = Buffer.from(secretB64, "base64");
    const signedContent = `${svixId}.${svixTimestamp}.${body}`;
    const sig = crypto.createHmac("sha256", secretBytes).update(signedContent).digest("base64");
    return `v1,${sig}`;
}

test("webhook: verifySvixSignature accepts a correctly-signed payload", async () => {
    const w = await import(SHARED + "webhook.mjs");
    const secretB64 = "dGVzdC1zZWNyZXQta2V5LWJ5dGVz"; // arbitrary base64 secret bytes
    const secret = "whsec_" + secretB64;
    const svixId = "msg_123";
    const nowSeconds = 1_700_000_000;
    const svixTimestamp = String(nowSeconds);
    const body = JSON.stringify({ type: "email.delivered" });
    const svixSignature = buildSvixSignature(secretB64, svixId, svixTimestamp, body);

    const result = await w.verifySvixSignature({
        secret, svixId, svixTimestamp, svixSignature, body, nowSeconds
    });
    assert.equal(result.valid, true);
});

test("webhook: verifySvixSignature rejects a tampered body", async () => {
    const w = await import(SHARED + "webhook.mjs");
    const secretB64 = "dGVzdC1zZWNyZXQta2V5LWJ5dGVz";
    const secret = "whsec_" + secretB64;
    const svixId = "msg_123";
    const nowSeconds = 1_700_000_000;
    const svixTimestamp = String(nowSeconds);
    const body = JSON.stringify({ type: "email.delivered" });
    const svixSignature = buildSvixSignature(secretB64, svixId, svixTimestamp, body);

    const result = await w.verifySvixSignature({
        secret, svixId, svixTimestamp, svixSignature,
        body: JSON.stringify({ type: "email.bounced" }), // tampered
        nowSeconds
    });
    assert.equal(result.valid, false);
    assert.equal(result.reason, "signature_mismatch");
});

test("webhook: verifySvixSignature rejects a stale timestamp (replay protection)", async () => {
    const w = await import(SHARED + "webhook.mjs");
    const secretB64 = "dGVzdC1zZWNyZXQta2V5LWJ5dGVz";
    const secret = "whsec_" + secretB64;
    const svixId = "msg_123";
    const oldTimestamp = String(1_700_000_000);
    const nowSeconds = 1_700_000_000 + 10_000; // way outside 300s tolerance
    const body = "{}";
    const svixSignature = buildSvixSignature(secretB64, svixId, oldTimestamp, body);

    const result = await w.verifySvixSignature({
        secret, svixId, svixTimestamp: oldTimestamp, svixSignature, body, nowSeconds
    });
    assert.equal(result.valid, false);
    assert.equal(result.reason, "timestamp_out_of_tolerance");
});

test("webhook: verifySvixSignature rejects when headers are missing", async () => {
    const w = await import(SHARED + "webhook.mjs");
    const result = await w.verifySvixSignature({ secret: "whsec_x", body: "{}" });
    assert.equal(result.valid, false);
    assert.equal(result.reason, "missing_headers");
});

test("webhook: classifyResendEvent maps bounce/complaint to suppression, delivery events to no-op", async () => {
    const w = await import(SHARED + "webhook.mjs");
    assert.deepEqual(w.classifyResendEvent("email.bounced"), { subscriberStatus: "bounced", suppress: true });
    assert.deepEqual(w.classifyResendEvent("email.complained"), { subscriberStatus: "complained", suppress: true });
    assert.deepEqual(w.classifyResendEvent("email.delivered"), { subscriberStatus: null, suppress: false });
    assert.deepEqual(w.classifyResendEvent("email.some_future_event"), { subscriberStatus: null, suppress: false });
});

/* ---------------- batching.mjs ---------------- */

test("batching: chunk splits into batches of the given size, including a partial final batch", async () => {
    const b = await import(SHARED + "batching.mjs");
    const batches = b.chunk([1, 2, 3, 4, 5], 2);
    assert.deepEqual(batches, [[1, 2], [3, 4], [5]]);
});

test("batching: chunk of an empty list is an empty list of batches", async () => {
    const b = await import(SHARED + "batching.mjs");
    assert.deepEqual(b.chunk([], 100), []);
});

test("batching: checkQuota warns only when a configured limit would be exceeded", async () => {
    const b = await import(SHARED + "batching.mjs");
    assert.equal(b.checkQuota(50, { dailyLimit: 100, sentToday: 40 }).warn, false);
    assert.equal(b.checkQuota(50, { dailyLimit: 100, sentToday: 60 }).exceedsDaily, true);
    assert.equal(b.checkQuota(50, { dailyLimit: null, monthlyLimit: null }).warn, false); // no configured limit
    assert.equal(b.checkQuota(1000, { monthlyLimit: 500, sentThisMonth: 0 }).exceedsMonthly, true);
});

/* ---------------- menu.mjs ---------------- */

test("menu: buildWeeklyMenuItems keeps only available items, sorted by category then sort_order", async () => {
    const m = await import(SHARED + "menu.mjs");
    const rows = [
        { name: "Sourdough Boule", available: true, category: "bread", sort_order: 2, price: "9.00", description: "Classic" },
        { name: "Sold Out Loaf", available: false, category: "bread", sort_order: 1, price: "9.00" },
        { name: "Cookie", available: true, category: "bread", sort_order: 1, price: "3.50", description: null }
    ];
    const items = m.buildWeeklyMenuItems(rows);
    assert.equal(items.length, 2);
    assert.equal(items[0].name, "Cookie");
    assert.equal(items[1].name, "Sourdough Boule");
    assert.equal(items[0].priceEur, 3.5);
    assert.equal(items[0].description, "");
});

test("menu: weeklyMenuSkipReason flags empty menus and load failures without ever throwing", async () => {
    const m = await import(SHARED + "menu.mjs");
    assert.equal(m.weeklyMenuSkipReason([]), "empty_menu");
    assert.equal(m.weeklyMenuSkipReason(null), "menu_load_failed");
    assert.equal(m.weeklyMenuSkipReason([{ name: "x", priceEur: 1 }]), null);
});

test("menu: buildMenuSnapshotKey (server) is byte-for-byte identical to VacationMode.buildMenuSnapshotKey (client) for the same input", async () => {
    // Two independent implementations (no shared build step between
    // the browser UMD script and this Deno ESM module) that MUST
    // agree, since the admin's client-side preview-staleness check
    // compares a client-computed key against one this server module
    // produces. This is the safeguard against them drifting apart.
    const VacationMode = require("../js/vacation-mode.js");
    const m = await import(SHARED + "menu.mjs");

    const fixtures = [
        [],
        [{ id: "1", name: "Sourdough Boule", price: 8, available: true, description: "Classic", product_type: "standard" }],
        [
            { id: "2", name: "Cookie", price: 3.5, available: true, description: "", product_type: "standard" },
            { id: "1", name: "Sourdough Boule", price: 8, available: true, description: "Classic", product_type: "standard" },
            { id: "9", name: "Archived Pie", price: 12, available: false, description: "", product_type: "standard" }
        ]
    ];

    for (const items of fixtures) {
        assert.equal(m.buildMenuSnapshotKey(items), VacationMode.buildMenuSnapshotKey(items));
    }
});

test("menu: buildVacationReopeningMenuCategories groups by category, in the canonical bread/cookie/dessert/seasonal order, alphabetized within each", async () => {
    const m = await import(SHARED + "menu.mjs");
    const rows = [
        { name: "S'mores", available: true, category: "cookie", product_type: "standard" },
        { name: "Brown Butter Sea Salt Chocolate Chip", available: true, category: "cookie", product_type: "standard" },
        { name: "Strawberry Shortcake", available: true, category: "cookie", product_type: "standard" },
        { name: "Sea Salt Fudge Brownie", available: true, category: "dessert", product_type: "standard" },
        { name: "Cinnamon Rolls", available: true, category: "dessert", product_type: "standard" },
        { name: "Classic Boule", available: true, category: "bread", product_type: "standard" },
        { name: "Archived Item", available: false, category: "bread", product_type: "standard" }
    ];

    const categories = m.buildVacationReopeningMenuCategories(rows);

    assert.equal(categories.length, 3);
    assert.deepEqual(categories.map(c => c.categoryLabel), ["Sourdough Bread", "Sourdough Cookies", "Desserts"]);

    const bread = categories.find(c => c.categoryLabel === "Sourdough Bread");
    assert.deepEqual(bread.items.map(i => i.name), ["Classic Boule"]);

    const cookies = categories.find(c => c.categoryLabel === "Sourdough Cookies");
    assert.deepEqual(cookies.items.map(i => i.name), [
        "Brown Butter Sea Salt Chocolate Chip", "S'mores", "Strawberry Shortcake"
    ]);

    const desserts = categories.find(c => c.categoryLabel === "Desserts");
    assert.deepEqual(desserts.items.map(i => i.name), ["Cinnamon Rolls", "Sea Salt Fudge Brownie"]);
});

test("menu: buildVacationReopeningMenuCategories excludes unavailable/archived items entirely (never an empty category)", async () => {
    const m = await import(SHARED + "menu.mjs");
    const categories = m.buildVacationReopeningMenuCategories([
        { name: "Archived Item", available: false, category: "bread", product_type: "standard" }
    ]);
    assert.deepEqual(categories, []);
});

test("menu: buildVacationReopeningMenuCategories includes a future/unknown category automatically, sorted after the known ones", async () => {
    const m = await import(SHARED + "menu.mjs");
    const categories = m.buildVacationReopeningMenuCategories([
        { name: "Sourdough Boule", available: true, category: "bread", product_type: "standard" },
        { name: "Mystery Muffin", available: true, category: "pastry", product_type: "standard" }
    ]);
    assert.equal(categories.length, 2);
    assert.equal(categories[0].categoryLabel, "Sourdough Bread");
    assert.equal(categories[1].categoryLabel, "Pastry");
});

test("menu: buildVacationReopeningMenuCategories tags builder products with productType, for the 'choose your flavors' note", async () => {
    const m = await import(SHARED + "menu.mjs");
    const categories = m.buildVacationReopeningMenuCategories([
        { name: "6 or 12 Cookie Box", available: true, category: "cookie", product_type: "builder" }
    ]);
    assert.equal(categories[0].items[0].productType, "builder");
});

test("menu: weeklyMenuSkipReason applies identically to a vacation-reopening category list (shared, not weekly-specific logic)", async () => {
    const m = await import(SHARED + "menu.mjs");
    assert.equal(m.weeklyMenuSkipReason(m.buildVacationReopeningMenuCategories([])), "empty_menu");
    assert.equal(
        m.weeklyMenuSkipReason(m.buildVacationReopeningMenuCategories([
            { name: "x", available: true, category: "bread", product_type: "standard" }
        ])),
        null
    );
});

/* ---------------- retry.mjs ---------------- */

test("retry: computeBackoffMs grows exponentially and is capped", async () => {
    const r = await import(SHARED + "retry.mjs");
    assert.equal(r.computeBackoffMs(1), 2 * 60 * 1000);
    assert.equal(r.computeBackoffMs(2), 4 * 60 * 1000);
    assert.equal(r.computeBackoffMs(3), 8 * 60 * 1000);
    assert.equal(r.computeBackoffMs(20), 6 * 60 * 60 * 1000); // capped at 6h
});

test("retry: isPermanentFailure classifies client errors as permanent, rate limits/timeouts/server errors as transient", async () => {
    const r = await import(SHARED + "retry.mjs");
    assert.equal(r.isPermanentFailure({ status: 422 }), true);
    assert.equal(r.isPermanentFailure({ code: "invalid_recipient" }), true);
    assert.equal(r.isPermanentFailure({ status: 401 }), true);
    assert.equal(r.isPermanentFailure({ status: 429 }), false);
    assert.equal(r.isPermanentFailure({ status: 408 }), false);
    assert.equal(r.isPermanentFailure({ status: 500 }), false);
    assert.equal(r.isPermanentFailure({}), false); // network error, no status
});

test("retry: nextOutboxState retries transient failures with a future next_attempt_at, and terminates permanent ones or exhausted attempts", async () => {
    const r = await import(SHARED + "retry.mjs");
    const now = 1_700_000_000_000;

    const transient = r.nextOutboxState({ attempts: 0, maxAttempts: 5, permanent: false, nowMs: now });
    assert.equal(transient.terminal, false);
    assert.equal(transient.attempts, 1);
    assert.ok(transient.nextAttemptAt.getTime() > now);

    const permanent = r.nextOutboxState({ attempts: 0, maxAttempts: 5, permanent: true, nowMs: now });
    assert.equal(permanent.terminal, true);
    assert.equal(permanent.nextAttemptAt, null);

    const exhausted = r.nextOutboxState({ attempts: 4, maxAttempts: 5, permanent: false, nowMs: now });
    assert.equal(exhausted.terminal, true);
    assert.equal(exhausted.attempts, 5);
});

test("retry: resolveSendRecipient NEVER returns the real recipient when isTest is true, even if a test recipient is misconfigured", async () => {
    const r = await import(SHARED + "retry.mjs");

    const real = r.resolveSendRecipient({ isTest: false, realRecipientEmail: "customer@example.com" });
    assert.deepEqual(real, { ok: true, recipient: "customer@example.com" });

    const test1 = r.resolveSendRecipient({
        isTest: true, testRecipientEmail: "admin@example.com", realRecipientEmail: "customer@example.com"
    });
    assert.deepEqual(test1, { ok: true, recipient: "admin@example.com" });

    const test2 = r.resolveSendRecipient({
        isTest: true, testRecipientEmail: null, realRecipientEmail: "customer@example.com"
    });
    assert.equal(test2.ok, false);
    assert.equal(test2.reason, "missing_test_recipient");
    assert.equal(test2.recipient, undefined); // never silently falls back to the real address
});

/* ---------------- templates.mjs ---------------- */

test("templates: orderReceivedEmail clearly labels itself as a request, not final approval, and includes every required field", async () => {
    const t = await import(SHARED + "templates.mjs");
    const result = t.orderReceivedEmail({
        customerName: "Alex",
        orderRef: "ab12cd34",
        items: [{ name: "Sourdough Boule", quantity: 2, lineTotalEur: 18 }],
        subtotalEur: 18,
        orderType: "weekly",
        pickupDate: "2026-08-23",
        specialInstructions: "Please slice it"
    });

    assert.match(result.subject, /order request received/i);
    assert.doesNotMatch(result.subject, /confirmed/i);
    assert.match(result.html, /order request received/i);
    assert.match(result.html, /not final approval/i);
    assert.match(result.html, /Alex/);
    assert.match(result.html, /ab12cd34/);
    assert.match(result.html, /Sourdough Boule/);
    assert.match(result.html, /€18\.00/);
    assert.match(result.html, /12:30 PM/);
    assert.match(result.html, /Please slice it/);
    assert.match(result.text, /not final approval/i);
    assert.match(result.text, /€18\.00/);
});

test("templates: orderReceivedEmail never includes admin-only information", async () => {
    const t = await import(SHARED + "templates.mjs");
    const result = t.orderReceivedEmail({
        customerName: "Alex",
        orderRef: "ab12cd34",
        items: [{ name: "Cookie", quantity: 1, lineTotalEur: 3.5 }],
        subtotalEur: 3.5,
        orderType: "weekly",
        pickupDate: "2026-08-23"
    });
    for (const forbidden of ["food_cost", "packaging_cost", "profit", "wholesale", "ingredient_cost"]) {
        assert.doesNotMatch(result.html.toLowerCase(), new RegExp(forbidden));
        assert.doesNotMatch(result.text.toLowerCase(), new RegExp(forbidden));
    }
});

test("templates: orderConfirmedEmail includes pickup date/time, and gracefully handles no pickup_location configured yet", async () => {
    const t = await import(SHARED + "templates.mjs");

    const withLocation = t.orderConfirmedEmail({
        customerName: "Alex", orderRef: "abc123", orderType: "weekly",
        pickupDate: "2026-08-23", pickupLocation: "123 Bakery Lane"
    });
    assert.match(withLocation.html, /123 Bakery Lane/);
    assert.match(withLocation.html, /12:30 PM/);

    const withoutLocation = t.orderConfirmedEmail({
        customerName: "Alex", orderRef: "abc123", orderType: "custom",
        pickupDate: "2026-08-30", pickupLocation: null
    });
    assert.doesNotMatch(withoutLocation.html, /null/i);
    assert.match(withoutLocation.html, /sent separately/i);
    assert.match(withoutLocation.html, /confirm the exact time/i);
});

test("templates: orderCancelledEmail is brief and includes a Contact link", async () => {
    const t = await import(SHARED + "templates.mjs");
    const result = t.orderCancelledEmail({ customerName: "Alex", orderRef: "abc123" });
    assert.match(result.subject, /cancelled/i);
    assert.match(result.html, /abc123/);
    assert.match(result.html, /contact\.html/);
});

test("templates: newsletterWelcomeEmail is informational only -- no verification link, includes a real unsubscribe link", async () => {
    const t = await import(SHARED + "templates.mjs");
    const result = t.newsletterWelcomeEmail({
        name: "Alex",
        unsubscribeUrl: "https://jessbakessourdough.com/unsubscribe.html?t=deadbeef"
    });
    assert.doesNotMatch(result.html.toLowerCase(), /verify|confirm your email|click to activate/);
    assert.match(result.html, /unsubscribe\.html\?t=deadbeef/);
    assert.match(result.text, /unsubscribe\.html\?t=deadbeef/);
});

test("templates: weeklyMenuEmail lists only the given items with EUR prices, a Menu button, and an unsubscribe link", async () => {
    const t = await import(SHARED + "templates.mjs");
    const result = t.weeklyMenuEmail({
        introMessage: "Fresh this week!",
        items: [
            { name: "Sourdough Boule", description: "Classic", priceEur: 9 },
            { name: "Cookie", description: "", priceEur: 3.5 }
        ],
        unsubscribeUrl: "https://jessbakessourdough.com/unsubscribe.html?t=abc"
    });
    assert.match(result.html, /Sourdough Boule/);
    assert.match(result.html, /€9\.00/);
    assert.match(result.html, /€3\.50/);
    assert.match(result.html, /menu\.html/);
    assert.match(result.html, /gallery\.html/);
    assert.match(result.html, /contact\.html/);
    assert.match(result.html, /privacy\.html/);
    assert.match(result.html, /unsubscribe\.html\?t=abc/);
});

test("templates: vacationReopeningEmail always includes the standard reopening sentence, the additional message below it, categorized menu, a Menu button, and an unsubscribe link -- never any pickup wording", async () => {
    const t = await import(SHARED + "templates.mjs");
    const result = t.vacationReopeningEmail({
        additionalMessage: "Thanks for your patience while we were away.",
        categories: [
            { categoryLabel: "Sourdough Bread", items: [{ name: "Classic Boule", productType: "standard" }] },
            { categoryLabel: "Sourdough Cookies", items: [{ name: "6 or 12 Cookie Mix & Match Box", productType: "builder" }] }
        ],
        unsubscribeUrl: "https://jessbakessourdough.com/unsubscribe.html?t=abc"
    });

    assert.match(result.html, /We're back from vacation and ordering is now open!/);
    assert.match(result.html, /Thanks for your patience/);
    assert.match(result.html, /Sourdough Bread/);
    assert.match(result.html, /Classic Boule/);
    assert.match(result.html, /Sourdough Cookies/);
    assert.match(result.html, /menu\.html/);
    assert.match(result.html, /View Menu/);
    assert.match(result.html, /unsubscribe\.html\?t=abc/);
    assert.match(result.text, /We're back from vacation and ordering is now open!/);
    assert.match(result.text, /Thanks for your patience/);
    assert.match(result.text, /unsubscribe\.html\?t=abc/);

    // Pickup wording must never appear in either version, in any form.
    for (const content of [result.html, result.text]) {
        assert.doesNotMatch(content, /next pickup/i);
        assert.doesNotMatch(content, /pickup date/i);
        assert.doesNotMatch(content, /check the menu for details/i);
    }
});

test("templates: vacationReopeningEmail shows the standard sentence even when there is no additional message, and omits the additional-message block entirely rather than showing an empty one", async () => {
    const t = await import(SHARED + "templates.mjs");
    const result = t.vacationReopeningEmail({
        additionalMessage: "",
        categories: [{ categoryLabel: "Sourdough Bread", items: [{ name: "Classic Boule", productType: "standard" }] }],
        unsubscribeUrl: "https://jessbakessourdough.com/unsubscribe.html?t=abc"
    });

    assert.match(result.html, /We're back from vacation and ordering is now open!/);
    assert.doesNotMatch(result.html, /<p style="margin:0 0 14px 0;"><\/p>/);
});

test("templates: vacationReopeningEmail preserves paragraph breaks in the additional message but strips any HTML/script injection attempt", async () => {
    const t = await import(SHARED + "templates.mjs");
    const result = t.vacationReopeningEmail({
        additionalMessage: "First paragraph.\n\nSecond paragraph.<script>alert(1)</script>",
        categories: [{ categoryLabel: "Sourdough Bread", items: [{ name: "Classic Boule", productType: "standard" }] }],
        unsubscribeUrl: "https://jessbakessourdough.com/unsubscribe.html?t=abc"
    });

    assert.match(result.html, /First paragraph\./);
    assert.match(result.html, /Second paragraph\./);
    // Two distinct <p> blocks, not one blob with the newline lost.
    assert.equal((result.html.match(/<p style="margin:0 0 14px 0;">/g) || []).length, 2);
    assert.doesNotMatch(result.html, /<script>/);
    assert.match(result.html, /&lt;script&gt;/);
});

test("templates: vacationReopeningEmail category headings render distinctly from item names (heading markup vs plain row)", async () => {
    const t = await import(SHARED + "templates.mjs");
    const result = t.vacationReopeningEmail({
        additionalMessage: "",
        categories: [{ categoryLabel: "Sourdough Cookies", items: [{ name: "S'mores", productType: "standard" }] }],
        unsubscribeUrl: "https://jessbakessourdough.com/unsubscribe.html?t=abc"
    });

    assert.match(result.html, /<h2[^>]*>Sourdough Cookies<\/h2>/);
    assert.doesNotMatch(result.html, /<h2[^>]*>S&#039;mores<\/h2>/);
});

test("templates: vacationReopeningEmail summarizes a Mix & Match box as one line -- never enumerates every flavor", async () => {
    const t = await import(SHARED + "templates.mjs");
    const result = t.vacationReopeningEmail({
        additionalMessage: "",
        categories: [{ categoryLabel: "Sourdough Cookies", items: [{ name: "6 or 12 Cookie Mix & Match Box", productType: "builder" }] }],
        unsubscribeUrl: "https://jessbakessourdough.com/unsubscribe.html?t=abc"
    });

    assert.match(result.html, /choose your own flavors on the Menu/i);
    // No per-flavor names ever appear -- this template is only ever
    // given the box product itself, never its eligible-cookie list.
    assert.doesNotMatch(result.html, /Chocolate Chip/);
    assert.doesNotMatch(result.html, /Snickerdoodle/);
});

test("templates: adminNewOrderEmail includes the required subject format, every requested field, unit prices, and an admin link", async () => {
    const t = await import(SHARED + "templates.mjs");
    const result = t.adminNewOrderEmail({
        customerName: "Alex Example",
        customerEmail: "alex@example.com",
        customerPhone: "+1 (555) 010-0100",
        preferredContact: "text",
        orderRef: "ab12cd34",
        orderType: "weekly",
        pickupDate: "2026-08-23",
        items: [
            { name: "Sourdough Boule", quantity: 2, unitPriceEur: 9, lineTotalEur: 18 },
            { name: "Sea Salt Cookie", quantity: 3, unitPriceEur: 3.5, lineTotalEur: 10.5 }
        ],
        subtotalEur: 28.5,
        specialInstructions: "Please slice the boule",
        submittedAt: "2026-08-19T14:05:00Z"
    });

    assert.equal(result.subject, "New Jess Bakes order — Alex Example");
    assert.match(result.html, /ab12cd34/);
    assert.match(result.html, /Alex Example/);
    assert.match(result.html, /alex@example\.com/);
    assert.match(result.html, /\+1 \(555\) 010-0100/);
    assert.match(result.html, /Text/);
    assert.match(result.html, /12:30 PM/);
    assert.match(result.html, /Sourdough Boule/);
    assert.match(result.html, /€9\.00 ea/); // unit price shown
    assert.match(result.html, /€18\.00/);   // line total shown
    assert.match(result.html, /€28\.50/);   // order total
    assert.match(result.html, /Please slice the boule/);
    assert.match(result.html, /admin\/orders\.html/);
    assert.match(result.text, /admin\/orders\.html/);
    assert.match(result.text, /€9\.00/);
});

test("templates: adminNewOrderEmail is independent from orderReceivedEmail -- same order data, two distinct emails", async () => {
    const t = await import(SHARED + "templates.mjs");
    const order = {
        customerName: "Alex", orderRef: "abc123", orderType: "custom",
        pickupDate: "2026-08-30"
    };
    const customerEmail = t.orderReceivedEmail({
        ...order, items: [{ name: "Cookie", quantity: 1, lineTotalEur: 3.5 }], subtotalEur: 3.5
    });
    const ownerEmail = t.adminNewOrderEmail({
        ...order,
        customerEmail: "alex@example.com", customerPhone: "555-0100", preferredContact: "email",
        items: [{ name: "Cookie", quantity: 1, unitPriceEur: 3.5, lineTotalEur: 3.5 }],
        subtotalEur: 3.5, submittedAt: "2026-08-19T14:05:00Z"
    });

    assert.notEqual(customerEmail.subject, ownerEmail.subject);
    assert.match(ownerEmail.subject, /^New Jess Bakes order/);
    assert.doesNotMatch(customerEmail.subject, /^New Jess Bakes order/);
    // The owner email is internal -- it says so, and is never marketed
    // as something the customer receives.
    assert.match(ownerEmail.text, /internal notification/i);
});

test("templates: every template escapes HTML in user-supplied fields (no injection via name/notes/menu text)", async () => {
    const t = await import(SHARED + "templates.mjs");
    const result = t.orderReceivedEmail({
        customerName: '<img src=x onerror=alert(1)>',
        orderRef: "abc123",
        items: [{ name: "Cookie", quantity: 1, lineTotalEur: 3.5 }],
        subtotalEur: 3.5,
        orderType: "weekly",
        pickupDate: "2026-08-23",
        specialInstructions: '"><script>evil()</script>'
    });
    assert.doesNotMatch(result.html, /<img src=x onerror/);
    assert.doesNotMatch(result.html, /<script>evil\(\)/);
    assert.match(result.html, /&lt;img/);

    const owner = t.adminNewOrderEmail({
        customerName: '<img src=x onerror=alert(1)>',
        customerEmail: "a@b.com", customerPhone: "555", preferredContact: "text",
        orderRef: "abc123", orderType: "weekly", pickupDate: "2026-08-23",
        items: [{ name: "Cookie", quantity: 1, unitPriceEur: 3.5, lineTotalEur: 3.5 }],
        subtotalEur: 3.5, specialInstructions: '"><script>evil()</script>',
        submittedAt: "2026-08-19T14:05:00Z"
    });
    assert.doesNotMatch(owner.html, /<img src=x onerror/);
    assert.doesNotMatch(owner.html, /<script>evil\(\)/);
    assert.match(owner.html, /&lt;img/);

    const vacation = t.vacationReopeningEmail({
        additionalMessage: '"><script>evil()</script>',
        categories: [{ categoryLabel: '<img src=x onerror=alert(1)>', items: [{ name: '<img src=x onerror=alert(1)>', productType: "standard" }] }],
        unsubscribeUrl: "https://jessbakessourdough.com/unsubscribe.html?t=abc"
    });
    assert.doesNotMatch(vacation.html, /<img src=x onerror/);
    assert.doesNotMatch(vacation.html, /<script>evil\(\)/);
    assert.match(vacation.html, /&lt;img/);
});
