"use strict";

/* ==========================================
   Contact form security + structure (new feature)

   Structural/text-based regression tests (no live Postgres/Deno
   available in this environment -- the actual RLS/Edge Function
   behavior is verified live, with synthetic data, as part of
   deployment -- see the delivery report). These tests guard against
   the specific regressions that would reopen the exact holes this
   feature was built to avoid: a public insert/select path on
   contact_messages that bypasses the Edge Function's honeypot/rate-
   limit/validation, or a checkout-style direct-table-write creeping
   back in.
   ========================================== */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function read(relPath) {
    return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

const MIGRATION = "supabase/migrations/20260831093000_contact_messages_schema.sql";
const FUNCTION_INDEX = "supabase/functions/contact-submit/index.ts";

/* ---------------- RLS / schema ---------------- */

test("1. contact_messages revokes all anon privileges and has no INSERT policy for anyone -- every row must be created by the service-role Edge Function", () => {
    const sql = read(MIGRATION);

    assert.match(sql, /revoke all on public\.contact_messages from anon;/);
    assert.doesNotMatch(sql, /for insert[\s\S]{0,200}public\.contact_messages/i, "no insert policy of any kind should exist on contact_messages");
    assert.doesNotMatch(sql, /grant insert on public\.contact_messages/i);
});

test("2. contact_messages grants admins select/update/delete, gated by is_admin()", () => {
    const sql = read(MIGRATION);

    assert.match(sql, /create policy "Admins can view contact messages" on public\.contact_messages[\s\S]{0,120}is_admin\(\)/);
    assert.match(sql, /create policy "Admins can update contact messages" on public\.contact_messages[\s\S]{0,160}is_admin\(\)/);
    assert.match(sql, /create policy "Admins can delete contact messages" on public\.contact_messages[\s\S]{0,120}is_admin\(\)/);
});

test("3. contact_message_attempts (the rate-limit bucket table) also revokes all anon privileges", () => {
    const sql = read(MIGRATION);
    assert.match(sql, /revoke all on public\.contact_message_attempts from anon;/);
});

test("4. contact_messages has independent is_read/is_resolved booleans, not one conflated status enum", () => {
    const sql = read(MIGRATION);
    assert.match(sql, /is_read boolean not null default false/);
    assert.match(sql, /is_resolved boolean not null default false/);
});

/* ---------------- Edge Function wiring ---------------- */

test("5. contact-submit uses the service-role admin client, never a plain/anon client, to write contact_messages", () => {
    const ts = read(FUNCTION_INDEX);
    assert.match(ts, /import \{ getAdminClient \} from "\.\.\/_shared\/supabaseAdmin\.ts";/);
    assert.match(ts, /getAdminClient\(\)/);
});

test("6. contact-submit checks the honeypot before ever touching the database", () => {
    const ts = read(FUNCTION_INDEX);
    const honeypotCheckIndex = ts.indexOf("isHoneypotTripped(honeypot)");
    const firstDbCallIndex = ts.indexOf("getAdminClient()");
    assert.ok(honeypotCheckIndex > -1, "expected an isHoneypotTripped check");
    assert.ok(firstDbCallIndex > -1, "expected a getAdminClient() call");
    assert.ok(honeypotCheckIndex < firstDbCallIndex, "the honeypot check must happen before any database access");
});

test("7. contact-submit validates name/email/message are present before inserting", () => {
    const ts = read(FUNCTION_INDEX);
    assert.match(ts, /reason: "name_required"/);
    assert.match(ts, /reason: "invalid_email"/);
    assert.match(ts, /reason: "message_required"/);
});

test("8. contact-submit rate-limits by both IP hash and normalized email, against the dedicated contact_message_attempts bucket table", () => {
    const ts = read(FUNCTION_INDEX);
    assert.match(ts, /"contact_message_attempts"/);
    assert.match(ts, /"contact:ip:"/);
    assert.match(ts, /"contact:email:"/);
    assert.match(ts, /reason: "rate_limited"/);
    // The raw IP itself is never stored/compared directly -- only its hash.
    assert.doesNotMatch(ts, /bucket_key:\s*"?ip:"?\s*\+\s*ip\b/);
});

test("9. contact-submit never touches orders, order_items, email_outbox, or subscribers -- entirely separate from the order/email workflow", () => {
    const ts = read(FUNCTION_INDEX);
    assert.doesNotMatch(ts, /\.from\("orders"\)/);
    assert.doesNotMatch(ts, /\.from\("order_items"\)/);
    assert.doesNotMatch(ts, /\.from\("email_outbox"\)/);
    assert.doesNotMatch(ts, /\.from\("subscribers"\)/);
});

/* ---------------- Public page structure ---------------- */

test("10. contact.html has a form with required name/email/message fields, an optional order-reference field, and a honeypot", () => {
    const html = read("contact.html");

    const nameField = html.match(/<input[^>]*id="contactName"[^>]*>/)?.[0] || "";
    const emailField = html.match(/<input[^>]*id="contactEmail"[^>]*>/)?.[0] || "";
    const messageField = html.match(/<textarea[^>]*id="contactMessageText"[^>]*>/)?.[0] || "";
    const orderRefField = html.match(/<input[^>]*id="contactOrderReference"[^>]*>/)?.[0] || "";

    assert.match(nameField, /\brequired\b/);
    assert.match(emailField, /\brequired\b/);
    assert.match(emailField, /type="email"/);
    assert.match(messageField, /\brequired\b/);
    assert.doesNotMatch(orderRefField, /\brequired\b/);

    assert.match(html, /id="contactWebsite"/);
    assert.match(html, /class="form-honeypot"/);
});

test("11. contact.html loads js/contact-form.js and links to the official Facebook URL", () => {
    const html = read("contact.html");
    assert.match(html, /<script src="js\/contact-form\.js"><\/script>/);

    const facebookLinks = [...html.matchAll(/href="(https:\/\/www\.facebook\.com\/[^"]+)"/g)].map(m => m[1]);
    assert.ok(facebookLinks.length > 0, "expected at least one Facebook link on the Contact page");
    facebookLinks.forEach(url => {
        assert.equal(url, "https://www.facebook.com/jessbakessourdough", `every Facebook link on contact.html must be the official URL, got: ${url}`);
    });
});

test("12. contact-form.js submits via the contact-submit Edge Function, never a direct table insert", () => {
    const js = read("js/contact-form.js");
    assert.match(js, /supabaseClient\.functions\.invoke\("contact-submit"/);
    assert.doesNotMatch(js, /\.from\("contact_messages"\)/);
});

test("13. contact-form.js disables the submit button for the duration of the request (duplicate-submission guard)", () => {
    const js = read("js/contact-form.js");
    assert.match(js, /if \(submitButton\.disabled\) return;/);
    assert.match(js, /submitButton\.disabled = true;/);
});
