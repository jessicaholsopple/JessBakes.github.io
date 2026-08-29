/* ==========================================
   IDEMPOTENCY KEY BUILDERS

   Pure, dependency-free. Used both by the database triggers (as
   plain SQL string concatenation matching these exact formats --
   see supabase/migrations/20260818120000_email_system_schema.sql)
   and by the Edge Functions for the two email types no trigger
   enqueues (newsletter_welcome, weekly_menu).

   Plain ESM, zero Deno/Node-specific APIs -- imported directly by
   both the Deno Edge Functions and this repo's Node test suite via
   the same relative path, so there is exactly one implementation.
   ========================================== */

export function orderReceivedKey(orderId) {
    return `order_received:${orderId}`;
}

export function orderConfirmedKey(orderId) {
    return `order_confirmed:${orderId}`;
}

export function orderCancelledKey(orderId) {
    return `order_cancelled:${orderId}`;
}

/** One-time resend of the updated order-confirmation template (adds
 * the Payment Options section) to orders that were confirmed before
 * that feature existed. A distinct email_type from orderConfirmedKey
 * -- not a re-use of the original key -- so it can never collide with
 * or double up on the customer's original confirmation email, and so
 * a second, unrelated future resend need would get its own new type
 * rather than overloading this one. Exactly one ever exists per
 * order, enforced the same way as every other key here: the unique
 * constraint on email_outbox.idempotency_key. */
export function orderConfirmedResendKey(orderId) {
    return `order_confirmed_resend:${orderId}`;
}

/** Internal owner notification -- one per order, independent from
 * orderReceivedKey (a different email_type, a different outbox row),
 * so the two can succeed/fail/retry completely independently. */
export function adminNewOrderKey(orderId) {
    return `admin_new_order:${orderId}`;
}

/** Web Push "new order" event -- one push_outbox row per order,
 * independent of both order_received and admin_new_order (a separate
 * table/queue entirely; see 20260819140000_web_push_notifications.sql).
 * The row is fanned out to every active admin device at send time,
 * so it never needs to be re-keyed per subscription. */
export function pushOrderNewKey(orderId) {
    return `push_order_new:${orderId}`;
}

/** Keyed by consent_event_id, not subscriber id, so a genuine
 * resubscribe (which mints a fresh consent_event_id -- see the
 * subscribers trigger) gets its own welcome email, while a
 * duplicate form-submit for the same still-active subscription
 * (same consent_event_id) does not. */
export function newsletterWelcomeKey(consentEventId) {
    return `newsletter_welcome:${consentEventId}`;
}

/** The Berlin-local Sunday date (or whatever weekday is configured)
 * this campaign covers, e.g. "2026-08-23". One campaign per key,
 * ever -- enforced by email_campaigns.campaign_key's unique
 * constraint. */
export function weeklyCampaignKey(isoDate) {
    return `weekly_menu:${isoDate}`;
}

/** One outbox row per (campaign, subscriber) pair -- enforced by
 * email_outbox.idempotency_key's unique constraint, so a scheduler
 * retry or a batch re-run can never send the same campaign twice to
 * the same recipient. */
export function weeklyRecipientKey(campaignKey, subscriberId) {
    return `${campaignKey}:${subscriberId}`;
}

/** Keyed by the vacation cycle's own id (vacation_periods.id) --
 * exactly one reopening campaign ever exists per vacation cycle, no
 * matter how many times the manual "Resume Ordering & Send" button,
 * a page reload, or the scheduled auto-resume cron invokes campaign
 * creation: email_campaigns.campaign_key's unique constraint turns
 * every retry after the first into a no-op "already exists" lookup. */
export function vacationReopeningCampaignKey(cycleId) {
    return `vacation_reopening:${cycleId}`;
}

/** One outbox row per (vacation campaign, subscriber) pair -- same
 * shape and same guarantee as weeklyRecipientKey. */
export function vacationReopeningRecipientKey(campaignKey, subscriberId) {
    return `${campaignKey}:${subscriberId}`;
}
