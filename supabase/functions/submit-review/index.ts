// Public endpoint: the ONLY way an order-linked review is ever
// created. The general (no-order-link) review form still inserts
// directly into `reviews` under its own RLS policy, but that policy
// forces order_id/order_items_snapshot to NULL -- so this is the one
// and only path that can ever attach a real order to a review, and
// only after validating a real, unexpired, unused token against a
// completed order (see _shared/reviewToken.mjs). Service-role,
// bypasses RLS, exactly like every other public write in this
// project (newsletter-subscribe, contact-submit, ...).
import { getAdminClient } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handlePreflight } from "../_shared/cors.ts";
import { validateReviewToken } from "../_shared/reviewToken.mjs";
import { buildSafeOrderItemsSummary } from "../_shared/reviewOrderSnapshot.mjs";
import { sanitizePublicDisplayName } from "../_shared/publicName.mjs";
import { sanitizeMessage } from "../_shared/validation.mjs";
import { hashToken } from "../_shared/token.mjs";

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const IP_RATE_LIMIT_MAX_ATTEMPTS = 10;
const TOKEN_RATE_LIMIT_MAX_ATTEMPTS = 5;

async function hashIp(ip: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function isRateLimitedBucket(adminClient: any, bucketKey: string, maxAttempts: number): Promise<boolean> {
    const cutoff = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();

    const { data: recent } = await adminClient
        .from("review_submission_attempts")
        .select("id")
        .eq("bucket_key", bucketKey)
        .gte("attempted_at", cutoff);

    const limited = (recent || []).length >= maxAttempts;

    await adminClient.from("review_submission_attempts").insert({ bucket_key: bucketKey });
    await adminClient.from("review_submission_attempts")
        .delete()
        .eq("bucket_key", bucketKey)
        .lt("attempted_at", cutoff);

    return limited;
}

Deno.serve(async (req) => {
    const preflight = handlePreflight(req);
    if (preflight) return preflight;

    const headers = { ...corsHeaders(req), "Content-Type": "application/json" };
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers });

    if (req.method !== "POST") {
        return json({ ok: false, reason: "method_not_allowed" }, 405);
    }

    let body: any;
    try {
        body = await req.json();
    } catch {
        return json({ ok: false, reason: "invalid" }, 200);
    }

    const token = String(body.token || "");
    if (!token) {
        return json({ ok: false, reason: "invalid" }, 200);
    }

    const adminClient = getAdminClient();

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const ipLimited = await isRateLimitedBucket(adminClient, "review_submit:ip:" + (await hashIp(ip)), IP_RATE_LIMIT_MAX_ATTEMPTS);
    const tokenHashForRateLimit = await hashToken(token);
    const tokenLimited = await isRateLimitedBucket(adminClient, "review_submit:token:" + tokenHashForRateLimit, TOKEN_RATE_LIMIT_MAX_ATTEMPTS);

    if (ipLimited || tokenLimited) {
        return json({ ok: false, reason: "rate_limited" }, 200);
    }

    const result = await validateReviewToken(adminClient, token);
    if (!result.ok) {
        return json({ ok: false, reason: result.reason }, 200);
    }

    const rating = Number(body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return json({ ok: false, reason: "invalid_rating" }, 200);
    }

    const reviewText = sanitizeMessage(body.reviewText || "");
    if (!reviewText) {
        return json({ ok: false, reason: "invalid_review" }, 200);
    }

    const nameResult = sanitizePublicDisplayName(body.publicName || "", result.order.customer_name);
    if (!nameResult.ok) {
        return json({ ok: false, reason: `invalid_name_${nameResult.reason}` }, 200);
    }

    const showOrderItems = body.showOrderItems !== false;
    const snapshot = buildSafeOrderItemsSummary(result.items);

    const { error: insertError } = await adminClient.from("reviews").insert({
        name: nameResult.value,
        product: null,
        rating,
        review: reviewText,
        approved: false,
        featured: false,
        order_id: result.order.id,
        show_order_items: showOrderItems,
        order_items_snapshot: snapshot
    });

    if (insertError) {
        // 23505 = the unique-per-order-id index already has a row --
        // someone else (or a retried request) already reviewed this
        // exact order. Never surfaced as a server error.
        if (insertError.code === "23505") {
            return json({ ok: false, reason: "used" }, 200);
        }
        return json({ ok: false, reason: "server_error" }, 200);
    }

    // Only marked used AFTER a successful insert, so a failed insert
    // (e.g. a transient DB error) leaves the token usable for a retry.
    await adminClient
        .from("review_request_tokens")
        .update({ used_at: new Date().toISOString() })
        .eq("token_hash", result.tokenHash);

    return json({ ok: true }, 200);
});
