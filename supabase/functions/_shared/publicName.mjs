/* ==========================================
   PUBLIC REVIEW DISPLAY NAME

   Derives the privacy-safe default display name ("First L.") from a
   checkout's full customer_name, and sanitizes a customer-edited
   display name so a full last name, email address, phone number, or
   URL can never end up published with a review -- enforced here,
   server-side, not left to client-side validation alone.

   Pure, dependency-free ESM (same convention as idempotency.mjs/
   validation.mjs) -- importable unmodified by both the Deno Edge
   Functions and this repo's Node test suite.
   ========================================== */

const MAX_DISPLAY_NAME_LENGTH = 60;
const EMAIL_LIKE_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const URL_LIKE_RE = /(https?:\/\/|www\.)/i;

function stripControlChars(value) {
    return String(value || "")
        .split("")
        .filter(ch => {
            const code = ch.charCodeAt(0);
            return code >= 32 && code !== 127;
        })
        .join("");
}

function tokens(value) {
    return stripControlChars(value).trim().split(/\s+/).filter(Boolean);
}

function countDigits(value) {
    return (String(value || "").match(/\d/g) || []).length;
}

/** "Jessica Holsopple" -> "Jessica H."; "Marcus Smith" -> "Marcus S.";
 * a single-word name (no last name on file) is returned as-is, never
 * padded with a fabricated initial. Empty/blank input -> "". */
export function firstNameLastInitial(fullName) {
    const parts = tokens(fullName);
    if (parts.length === 0) return "";
    if (parts.length === 1) return parts[0];

    const first = parts[0];
    const last = parts[parts.length - 1];
    const initial = last.charAt(0).toUpperCase();
    return `${first} ${initial}.`;
}

/**
 * Validates and normalizes a customer-edited public display name.
 *
 * @param {string} candidateRaw the customer's typed value (may be
 *   blank, in which case the safe default is returned).
 * @param {string} realCustomerName the order's real checkout name --
 *   NEVER sent to the client, used only here to detect/normalize a
 *   full-last-name leak.
 * @returns {{ok: true, value: string} | {ok: false, reason: string}}
 *   reason is one of: "email", "url", "phone", "too_long".
 */
export function sanitizePublicDisplayName(candidateRaw, realCustomerName) {
    const stripped = stripControlChars(candidateRaw).trim();

    if (!stripped) {
        return { ok: true, value: firstNameLastInitial(realCustomerName) };
    }

    if (EMAIL_LIKE_RE.test(stripped)) {
        return { ok: false, reason: "email" };
    }

    if (URL_LIKE_RE.test(stripped)) {
        return { ok: false, reason: "url" };
    }

    if (countDigits(stripped) >= 7) {
        return { ok: false, reason: "phone" };
    }

    if (stripped.length > 120) {
        return { ok: false, reason: "too_long" };
    }

    // Full-last-name leak guard: if the customer typed their real
    // checkout last name out in full (not just an initial), silently
    // normalize to "First L." instead of either publishing it or
    // forcing a hard rejection for an honest mistake.
    const candidateParts = stripped.split(/\s+/).filter(Boolean);
    const realParts = tokens(realCustomerName);

    if (candidateParts.length >= 2 && realParts.length >= 2) {
        const candidateLast = candidateParts[candidateParts.length - 1].toLowerCase();
        const realLast = realParts[realParts.length - 1].toLowerCase();

        if (candidateLast.length > 1 && candidateLast === realLast) {
            const initial = candidateParts[candidateParts.length - 1].charAt(0).toUpperCase();
            return { ok: true, value: `${candidateParts[0]} ${initial}.` };
        }
    }

    return { ok: true, value: stripped.slice(0, MAX_DISPLAY_NAME_LENGTH) };
}
