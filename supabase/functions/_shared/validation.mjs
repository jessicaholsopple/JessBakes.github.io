/* ==========================================
   NEWSLETTER SIGNUP VALIDATION, HONEYPOT, AND RATE-LIMIT MATH

   All pure functions -- no DB/network access. The Edge Function
   fetches recent-attempt timestamps from newsletter_signup_attempts
   and passes them into isRateLimited(); this file never queries
   anything itself, which is what makes it directly unit-testable.
   ========================================== */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const MAX_NAME_LENGTH = 100;
const MAX_MESSAGE_LENGTH = 4000;

export function normalizeEmail(email) {
    return String(email || "").trim().toLowerCase();
}

export function isValidEmail(email) {
    const value = String(email || "").trim();
    if (!value || value.length > MAX_EMAIL_LENGTH) return false;
    return EMAIL_RE.test(value);
}

/** True when the honeypot field was filled in -- a real visitor
 * never sees or fills this field (it's hidden from view and
 * unlabeled to screen readers), so any non-empty value is a bot. */
export function isHoneypotTripped(honeypotValue) {
    return String(honeypotValue || "").trim().length > 0;
}

/** Strips ASCII control characters (codes below 32, plus DEL/127)
 * without relying on a regex hex-escape character class, then trims
 * and length-caps. */
export function sanitizeName(name) {
    const stripped = String(name || "")
        .split("")
        .filter(ch => {
            const code = ch.charCodeAt(0);
            return code >= 32 && code !== 127;
        })
        .join("");

    return stripped.trim().slice(0, MAX_NAME_LENGTH);
}

/** Same ASCII control-character stripping as sanitizeName(), but
 *  keeps \n (10) and \r (13) so a multi-line message (e.g. the
 *  contact form) doesn't get collapsed to one line. Trims and
 *  length-caps at MAX_MESSAGE_LENGTH. */
export function sanitizeMessage(message) {
    const stripped = String(message || "")
        .split("")
        .filter(ch => {
            const code = ch.charCodeAt(0);
            return (code >= 32 && code !== 127) || code === 10 || code === 13;
        })
        .join("");

    return stripped.trim().slice(0, MAX_MESSAGE_LENGTH);
}

/**
 * @param {number[]} recentAttemptTimestampsMs epoch-ms of this
 *   bucket's attempts within (at most) the lookback window.
 * @param {number} nowMs
 * @param {number} windowMs
 * @param {number} maxAttempts
 */
export function isRateLimited(recentAttemptTimestampsMs, nowMs, windowMs, maxAttempts) {
    const cutoff = nowMs - windowMs;
    const withinWindow = (recentAttemptTimestampsMs || []).filter(t => t > cutoff);
    return withinWindow.length >= maxAttempts;
}

/** Full pre-insert validation in one call, so the Edge Function has
 * a single source of truth for "should this signup be accepted."
 * Returns { ok: true } or { ok: false, reason }. */
export function validateSignup({ email, honeypot, consentChecked }) {
    if (isHoneypotTripped(honeypot)) {
        return { ok: false, reason: "honeypot" };
    }
    if (!consentChecked) {
        return { ok: false, reason: "consent_required" };
    }
    if (!isValidEmail(email)) {
        return { ok: false, reason: "invalid_email" };
    }
    return { ok: true };
}
