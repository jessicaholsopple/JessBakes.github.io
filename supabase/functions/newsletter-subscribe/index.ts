// Public endpoint: the ONLY way a subscriber row is ever created,
// reactivated, or has its preferences changed. Deployed with JWT
// verification ON (the anon key satisfies it); real protection
// against abuse is the honeypot + rate limit + email format checks
// below, not the JWT.
//
// Backward compatible with the original single-category widget
// (js/newsletter.js, still live on index.html's hero section): a
// request with no `preferences` object is treated exactly as before
// (an implicit "menu announcements" signup, gated by the existing
// `consent` checkbox). The newer preference-aware widget
// (js/subscribe-widget.js, used by the Vacation Mode homepage section
// and Menu vacation notice) sends an explicit `preferences` object
// instead of `consent` -- selecting at least one preference IS the
// consent for that category, validated both client- and server-side.
import { getAdminClient } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handlePreflight } from "../_shared/cors.ts";
import { validateSignup, normalizeEmail, sanitizeName, isRateLimited } from "../_shared/validation.mjs";
import { newsletterWelcomeKey } from "../_shared/idempotency.mjs";

const PRIVACY_VERSION = "2026-08-18";
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const ALLOWED_SOURCES = ["newsletter_form", "vacation_homepage", "vacation_menu"];

async function hashIp(ip: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function checkAndRecordBucket(adminClient: any, bucketKey: string): Promise<boolean> {
    const cutoff = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();

    const { data: recent } = await adminClient
        .from("newsletter_signup_attempts")
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
    await adminClient.from("newsletter_signup_attempts").insert({ bucket_key: bucketKey });
    await adminClient.from("newsletter_signup_attempts")
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

    const email = normalizeEmail(body.email);
    const name = sanitizeName(body.name);
    const honeypot = body.website || body.honeypot; // hidden field name kept generic

    // Preferences: an explicit `preferences` object (the newer,
    // category-aware widget) or, if absent, the legacy implicit
    // "menu announcements" signup (the original single-category form).
    const hasPreferences = body.preferences && typeof body.preferences === "object";
    const requestedPreferences = hasPreferences
        ? {
            pref_reopening_alerts: body.preferences.reopeningAlerts === true,
            pref_menu_announcements: body.preferences.menuAnnouncements === true,
            pref_general_updates: body.preferences.generalUpdates === true
        }
        : { pref_reopening_alerts: false, pref_menu_announcements: true, pref_general_updates: false };

    const anyPreferenceSelected =
        requestedPreferences.pref_reopening_alerts ||
        requestedPreferences.pref_menu_announcements ||
        requestedPreferences.pref_general_updates;

    if (hasPreferences && !anyPreferenceSelected) {
        // Same "still a 200" convention as every other soft-rejection
        // below -- never a 4xx that helps a bot distinguish failure
        // reasons.
        return new Response(JSON.stringify({ ok: false, reason: "preference_required" }), { status: 200, headers });
    }

    const source = ALLOWED_SOURCES.includes(body.source) ? body.source : "newsletter_form";

    // Selecting at least one preference IS the consent for the
    // preference-aware widget; the legacy widget still requires its
    // own explicit checkbox.
    const consentChecked = body.consent === true || (hasPreferences && anyPreferenceSelected);

    const validation = validateSignup({ email, honeypot, consentChecked });
    if (!validation.ok) {
        return new Response(JSON.stringify({ ok: false, reason: validation.reason }), { status: 200, headers });
    }

    const adminClient = getAdminClient();

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const ipBucket = "ip:" + (await hashIp(ip));
    const emailBucket = "email:" + email;

    const ipLimited = await checkAndRecordBucket(adminClient, ipBucket);
    const emailLimited = await checkAndRecordBucket(adminClient, emailBucket);
    if (ipLimited || emailLimited) {
        return new Response(JSON.stringify({ ok: false, reason: "rate_limited" }), { status: 200, headers });
    }

    const { data: existing } = await adminClient
        .from("subscribers")
        .select("id, status, consent_event_id, pref_reopening_alerts, pref_menu_announcements, pref_general_updates")
        .eq("email", email)
        .maybeSingle();

    let subscriberId: string;
    let consentEventId: string;
    let shouldWelcome: boolean;
    let alreadySubscribed: boolean;
    let preferencesUpdated: boolean;

    if (!existing) {
        const { data: created, error } = await adminClient
            .from("subscribers")
            .insert({
                email, name,
                status: "active",
                consent_at: new Date().toISOString(),
                consent_source: source,
                privacy_version: PRIVACY_VERSION,
                ...requestedPreferences
            })
            .select("id, consent_event_id")
            .single();

        if (error || !created) {
            return new Response(JSON.stringify({ ok: false, reason: "server_error" }), { status: 200, headers });
        }

        subscriberId = created.id;
        consentEventId = created.consent_event_id;
        shouldWelcome = true;
        alreadySubscribed = false;
        preferencesUpdated = anyPreferenceSelected;
    } else {
        // Additive-only merge -- never turns an existing true
        // preference false. A subscriber who already gets menu
        // announcements and now also asks for reopening alerts keeps
        // both; nothing already-consented-to is silently removed.
        const mergedPreferences = {
            pref_reopening_alerts: existing.pref_reopening_alerts === true || requestedPreferences.pref_reopening_alerts,
            pref_menu_announcements: existing.pref_menu_announcements === true || requestedPreferences.pref_menu_announcements,
            pref_general_updates: existing.pref_general_updates === true || requestedPreferences.pref_general_updates
        };
        preferencesUpdated =
            mergedPreferences.pref_reopening_alerts !== (existing.pref_reopening_alerts === true) ||
            mergedPreferences.pref_menu_announcements !== (existing.pref_menu_announcements === true) ||
            mergedPreferences.pref_general_updates !== (existing.pref_general_updates === true);

        const reactivating = existing.status !== "active";

        const updatePayload: Record<string, unknown> = {
            ...mergedPreferences,
            consent_at: new Date().toISOString(),
            consent_source: source,
            privacy_version: PRIVACY_VERSION,
            name: name || undefined
        };
        if (reactivating) {
            // The subscribers trigger mints a fresh consent_event_id
            // automatically on this status transition.
            updatePayload.status = "active";
        }

        const { data: updated, error } = await adminClient
            .from("subscribers")
            .update(updatePayload)
            .eq("id", existing.id)
            .select("id, consent_event_id")
            .single();

        if (error || !updated) {
            return new Response(JSON.stringify({ ok: false, reason: "server_error" }), { status: 200, headers });
        }

        subscriberId = updated.id;
        consentEventId = updated.consent_event_id;
        // A welcome email only ever fires on a genuine 0->active
        // transition (brand new subscriber or a resubscribe) -- never
        // for an already-active subscriber who's just adding one more
        // preference category.
        shouldWelcome = reactivating;
        alreadySubscribed = !reactivating;
    }

    if (shouldWelcome) {
        const { error: enqueueError } = await adminClient.from("email_outbox").insert({
            email_type: "newsletter_welcome",
            idempotency_key: newsletterWelcomeKey(consentEventId),
            recipient_email: email,
            recipient_ref_table: "subscribers",
            recipient_ref_id: subscriberId
        });
        // A 23505 unique-violation here just means this exact consent
        // event's welcome email was already enqueued (e.g. a retried
        // request) -- not an error worth surfacing to the caller.
        if (enqueueError && enqueueError.code !== "23505") {
            console.error("welcome enqueue failed", enqueueError.code);
        }
    }

    return new Response(
        JSON.stringify({ ok: true, alreadySubscribed, preferencesUpdated }),
        { status: 200, headers }
    );
});
