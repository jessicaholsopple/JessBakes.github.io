/* ==========================================
   UNSUBSCRIBE TOKEN GENERATION + HASHING

   Uses the standard Web Crypto API (`crypto.getRandomValues`,
   `crypto.subtle.digest`), which is a global in both Deno (the Edge
   Function runtime) and Node >= 19 (this repo's test runner) --
   no import, no polyfill, one implementation for both.

   A fresh, cryptographically random token is minted for every email
   actually sent (see supabase/functions/_shared/idempotency.mjs and
   the email_unsubscribe_tokens table) -- never derived from, or
   reversible back to, a subscriber ID or email address. Only the
   SHA-256 hash is ever stored; the raw token exists only in the
   rendered email's unsubscribe link.
   ========================================== */

function toHex(buffer) {
    return Array.from(new Uint8Array(buffer))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
}

/** 32 random bytes -> 64 hex characters. Astronomically low
 * collision probability; the DB's primary key on the hash is the
 * final backstop regardless. */
export function generateUnsubscribeToken() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return toHex(bytes.buffer);
}

export async function hashToken(rawToken) {
    const data = new TextEncoder().encode(String(rawToken || ""));
    const digest = await crypto.subtle.digest("SHA-256", data);
    return toHex(digest);
}

/** Builds the public, single-purpose unsubscribe URL. Carries only
 * the opaque raw token -- never a subscriber ID, email address, or
 * any other identifying data. */
export function buildUnsubscribeUrl(siteUrl, rawToken) {
    const base = String(siteUrl || "").replace(/\/+$/, "");
    return `${base}/unsubscribe.html?t=${encodeURIComponent(rawToken)}`;
}

/** Same 32-random-byte generator as generateUnsubscribeToken -- a
 * generic name for callers (review-request links) that mint a secure
 * token for a purpose other than unsubscribing. Identical
 * implementation, kept as one alias rather than a second copy. */
export const generateSecureToken = generateUnsubscribeToken;

/** Builds the public review-request link. Carries only the opaque
 * raw token -- never an order ID, email address, or any other
 * identifying data (see review_request_tokens / validateReviewToken). */
export function buildReviewUrl(siteUrl, rawToken) {
    const base = String(siteUrl || "").replace(/\/+$/, "");
    return `${base}/reviews.html?t=${encodeURIComponent(rawToken)}`;
}
