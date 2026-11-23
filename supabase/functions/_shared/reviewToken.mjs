/* ==========================================
   REVIEW-REQUEST TOKEN VALIDATION

   The single place that decides whether a raw review-link token is
   currently usable. Shared by get-review-order (read-only lookup)
   and submit-review (same checks, immediately before inserting the
   review), so the two can never drift apart on what counts as
   "valid" -- a token altered by even one character hashes to
   something that will never match a stored row (no partial/prefix
   lookup is ever done), which is what makes it impossible to tamper
   a token into addressing a different order.

   Takes an already-constructed Supabase client (service-role in
   production, a fake chainable stub in tests -- same technique
   js/admin-reviews-shared.js's own tests use) rather than importing
   one itself, so this file has no Deno-specific dependency and is
   fully Node-testable.
   ========================================== */
import { hashToken } from "./token.mjs";

const MIN_TOKEN_LENGTH = 32;

/**
 * @returns one of:
 *   { ok: false, reason: "invalid" | "expired" | "used" }
 *   { ok: true, tokenHash, order: {id, customer_name, status}, items: [...] }
 *
 * "invalid" is deliberately reused for "token not found", "order
 * missing", and "order not completed" -- a public caller is never
 * told WHICH of those is true, so a guess can't be narrowed down by
 * response shape (order enumeration resistance).
 */
export async function validateReviewToken(adminClient, rawToken) {
    const token = String(rawToken || "").trim();

    if (!token || token.length < MIN_TOKEN_LENGTH) {
        return { ok: false, reason: "invalid" };
    }

    const tokenHash = await hashToken(token);

    const { data: tokenRow } = await adminClient
        .from("review_request_tokens")
        .select("*")
        .eq("token_hash", tokenHash)
        .maybeSingle();

    if (!tokenRow) {
        return { ok: false, reason: "invalid" };
    }

    if (tokenRow.used_at) {
        return { ok: false, reason: "used" };
    }

    if (new Date(tokenRow.expires_at).getTime() < Date.now()) {
        return { ok: false, reason: "expired" };
    }

    const { data: order } = await adminClient
        .from("orders")
        .select("id, customer_name, status")
        .eq("id", tokenRow.order_id)
        .maybeSingle();

    // An order that no longer exists, or has been moved (e.g. Undo
    // Completion) out of 'completed' since the link was minted, is
    // treated the same as an invalid link -- the link resumes working
    // on its own if the order is later re-completed, since nothing
    // here is destructive.
    if (!order || order.status !== "completed") {
        return { ok: false, reason: "invalid" };
    }

    const { data: existingReview } = await adminClient
        .from("reviews")
        .select("id")
        .eq("order_id", order.id)
        .maybeSingle();

    if (existingReview) {
        return { ok: false, reason: "used" };
    }

    const { data: items } = await adminClient
        .from("order_items")
        .select("item_name, quantity, builder_details, promotion_redemption_id")
        .eq("order_id", order.id);

    return { ok: true, tokenHash, order, items: items || [] };
}
