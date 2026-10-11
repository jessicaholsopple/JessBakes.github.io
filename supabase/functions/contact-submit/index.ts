// Public endpoint: the ONLY way a contact_messages row is ever
// created. Deployed with JWT verification ON (the anon key satisfies
// it, same as newsletter-subscribe); real protection against abuse is
// the honeypot + rate limit + validation below, not the JWT.
//
// Entirely separate from the order/email system: this never touches
// orders, order_items, or email_outbox, and never creates or updates
// a subscriber. A submission here cannot alter an order even if an
// orderReference happens to match a real one -- it's stored as a
// plain text field for the admin's own reference, nothing more.
import { getAdminClient } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handlePreflight } from "../_shared/cors.ts";
import { isHoneypotTripped, isValidEmail, normalizeEmail, sanitizeName, sanitizeMessage, isRateLimited } from "../_shared/validation.mjs";

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const MAX_ORDER_REFERENCE_LENGTH = 100;

async function hashIp(ip: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function checkAndRecordBucket(adminClient: any, bucketKey: string): Promise<boolean> {
    const cutoff = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();

    const { data: recent } = await adminClient
        .from("contact_message_attempts")
        .select("attempted_at")
        .eq("bucket_key", bucketKey)
        .gte("attempted_at", cutoff);

    const limited = isRateLimited(
        (recent || []).map((r: any) => new Date(r.attempted_at).getTime()),
        Date.now(),
        RATE_LIMIT_WINDOW_MS,
        RATE_LIMIT_MAX_ATTEMPTS
    );

    // Record this attempt regardless of outcome, and prune old rows
    // for this bucket -- self-cleaning, no separate job needed.
    await adminClient.from("contact_message_attempts").insert({ bucket_key: bucketKey });
    await adminClient.from("contact_message_attempts")
        .delete()
        .eq("bucket_key", bucketKey)
        .lt("attempted_at", cutoff);

    return limited;
}

Deno.serve(async (req) => {
    const preflight = handlePreflight(req);
    if (preflight) return preflight;

    const headers = { ...corsHeaders(req), "Content-Type": "application/json" };

    if (req.method !== "POST") {
        return new Response(JSON.stringify({ ok: false, reason: "method_not_allowed" }), { status: 405, headers });
    }

    let body: any;
    try {
        body = await req.json();
    } catch {
        return new Response(JSON.stringify({ ok: false, reason: "invalid_body" }), { status: 400, headers });
    }

    const name = sanitizeName(body.name);
    const email = normalizeEmail(body.email);
    const orderReference = sanitizeName(body.orderReference).slice(0, MAX_ORDER_REFERENCE_LENGTH);
    const message = sanitizeMessage(body.message);
    const honeypot = body.website || body.honeypot; // hidden field name kept generic

    // Never a status/reason that helps a bot distinguish "honeypot
    // tripped" from any other soft-rejection -- always a 200 with
    // ok:false, same convention as newsletter-subscribe.
    if (isHoneypotTripped(honeypot)) {
        return new Response(JSON.stringify({ ok: false, reason: "honeypot" }), { status: 200, headers });
    }

    if (!name) {
        return new Response(JSON.stringify({ ok: false, reason: "name_required" }), { status: 200, headers });
    }
    if (!isValidEmail(email)) {
        return new Response(JSON.stringify({ ok: false, reason: "invalid_email" }), { status: 200, headers });
    }
    if (!message) {
        return new Response(JSON.stringify({ ok: false, reason: "message_required" }), { status: 200, headers });
    }

    const adminClient = getAdminClient();

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const ipBucket = "contact:ip:" + (await hashIp(ip));
    const emailBucket = "contact:email:" + email;

    const ipLimited = await checkAndRecordBucket(adminClient, ipBucket);
    const emailLimited = await checkAndRecordBucket(adminClient, emailBucket);
    if (ipLimited || emailLimited) {
        return new Response(JSON.stringify({ ok: false, reason: "rate_limited" }), { status: 200, headers });
    }

    const { error } = await adminClient.from("contact_messages").insert({
        name,
        email,
        order_reference: orderReference || null,
        message
    });

    if (error) {
        console.error("contact_messages insert failed", error.code);
        return new Response(JSON.stringify({ ok: false, reason: "server_error" }), { status: 200, headers });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
});
