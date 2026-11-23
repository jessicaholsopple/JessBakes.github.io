// Public endpoint: the ONLY way the review form can ever learn what
// was in a customer's order. Takes nothing but an opaque token --
// never an order ID, email address, or any other identifying data --
// and returns only the safe fields a review form needs. The orders/
// order_items tables themselves grant anon nothing at all (see
// supabase/schemas/public/tables/orders.sql / order_items.sql);
// this Edge Function (service-role, bypasses RLS) is the narrowly-
// scoped boundary that stands in for a public read, same pattern as
// every other public write/read in this project.
import { getAdminClient } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handlePreflight } from "../_shared/cors.ts";
import { validateReviewToken } from "../_shared/reviewToken.mjs";
import { buildSafeOrderItemsSummary } from "../_shared/reviewOrderSnapshot.mjs";
import { firstNameLastInitial } from "../_shared/publicName.mjs";

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RATE_LIMIT_MAX_ATTEMPTS = 30; // page loads/reloads are frequent and harmless; this only guards against brute-forcing tokens

async function hashIp(ip: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function isRateLimitedBucket(adminClient: any, bucketKey: string): Promise<boolean> {
    const cutoff = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();

    const { data: recent } = await adminClient
        .from("review_submission_attempts")
        .select("id")
        .eq("bucket_key", bucketKey)
        .gte("attempted_at", cutoff);

    const limited = (recent || []).length >= RATE_LIMIT_MAX_ATTEMPTS;

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
    const adminClient = getAdminClient();

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const limited = await isRateLimitedBucket(adminClient, "review_lookup:ip:" + (await hashIp(ip)));
    if (limited) {
        return json({ ok: false, reason: "rate_limited" }, 200);
    }

    const result = await validateReviewToken(adminClient, token);
    if (!result.ok) {
        return json({ ok: false, reason: result.reason }, 200);
    }

    return json({
        ok: true,
        suggestedName: firstNameLastInitial(result.order.customer_name),
        items: buildSafeOrderItemsSummary(result.items)
    }, 200);
});
