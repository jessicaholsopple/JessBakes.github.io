// Admin actions for preparing a vacation reopening campaign, called
// from admin/settings.html (js/admin-vacation.js):
//   { action: "preview", cycleId } -- pure render from a LIVE menu
//                                     read, no send; persists the
//                                     preview-staleness marker used by
//                                     the readiness check.
//   { action: "test", cycleId }    -- render + send to the configured
//                                     test recipient ONLY (same
//                                     resolveSendRecipient() safety
//                                     guard as every other email type).
//   { action: "retry", cycleId }   -- re-run buildAndSendVacationCampaign,
//                                     which only ever touches that
//                                     campaign's still-pending/failed
//                                     outbox rows -- never resends an
//                                     already-`sent` one.
import { getAdminClient, isServiceRoleOrAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handlePreflight } from "../_shared/cors.ts";
import { buildVacationReopeningMenuCategories, weeklyMenuSkipReason, buildMenuSnapshotKey } from "../_shared/menu.mjs";
import { vacationReopeningEmail } from "../_shared/templates.mjs";
import { processOutboxRow } from "../_shared/processOutbox.ts";
import { buildAndSendVacationCampaign } from "../_shared/vacationCampaign.ts";

async function loadSettings(adminClient: any) {
    const { data } = await adminClient.from("email_settings").select("*").limit(1).maybeSingle();
    return data || {};
}

async function loadLiveMenuRows(adminClient: any) {
    const { data } = await adminClient
        .from("menu_items")
        .select("id, name, description, price, available, product_type, category, sort_order");
    return data || [];
}

Deno.serve(async (req) => {
    const preflight = handlePreflight(req);
    if (preflight) return preflight;

    const headers = { ...corsHeaders(req), "Content-Type": "application/json" };
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers });

    if (req.method !== "POST") {
        return json({ ok: false, reason: "method_not_allowed" }, 405);
    }

    const authorized = await isServiceRoleOrAdmin(req);
    if (!authorized) {
        return json({ ok: false, reason: "forbidden" }, 403);
    }

    let body: any = {};
    try {
        body = await req.json();
    } catch {
        return json({ ok: false, reason: "invalid_body" }, 400);
    }

    const action = body.action;
    const cycleId = body.cycleId;
    if (!cycleId) {
        return json({ ok: false, reason: "cycle_id_required" }, 400);
    }

    const adminClient = getAdminClient();

    const { data: cycle } = await adminClient
        .from("vacation_periods")
        .select("*")
        .eq("id", cycleId)
        .maybeSingle();

    if (!cycle) {
        return json({ ok: false, reason: "cycle_not_found" }, 404);
    }

    if (action === "preview") {
        const menuRows = await loadLiveMenuRows(adminClient);
        const { categories, warnings } = buildVacationReopeningMenuCategories(menuRows);
        const skipReason = weeklyMenuSkipReason(categories);
        const menuSnapshotKey = buildMenuSnapshotKey(menuRows);

        const rendered = vacationReopeningEmail({
            additionalMessage: cycle.email_intro || "",
            categories,
            unsubscribeUrl: "https://jessbakessourdough.com/unsubscribe.html?t=preview"
        });

        // This IS the authoritative "you looked at a preview of
        // exactly this menu" record -- the admin UI's readiness check
        // compares its own live menu-snapshot key against this value.
        await adminClient.from("vacation_periods").update({
            preview_menu_snapshot_key: menuSnapshotKey,
            preview_generated_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        }).eq("id", cycleId);

        // Preview always completes (never blocked) -- but surfaces a
        // clear warning naming any product that landed in "Other" for
        // lacking a category, per the requirement that a known product
        // must never silently vanish into that bucket unnoticed.
        return json({
            ok: true,
            subject: cycle.email_subject || "We're back! Ordering is open again",
            html: rendered.html,
            text: rendered.text,
            menuSnapshotKey,
            skipReason,
            warnings
        });
    }

    if (action === "test") {
        const settings = await loadSettings(adminClient);
        if (!settings.test_recipient_email) {
            return json({ ok: false, reason: "missing_test_recipient" });
        }

        // A test send must not go out with a knowingly malformed menu
        // either -- same guard as the real campaign path.
        const menuRows = await loadLiveMenuRows(adminClient);
        const { warnings } = buildVacationReopeningMenuCategories(menuRows);
        if (warnings.length > 0) {
            return json({ ok: false, reason: "uncategorized_products", products: warnings });
        }

        // Structurally incapable of reaching a real subscriber: no
        // recipient_ref_id, is_test:true -- processOutboxRow's
        // resolveSendRecipient() ignores recipient_email entirely for
        // is_test rows and only ever uses the configured test address.
        const { data: row, error } = await adminClient.from("email_outbox").insert({
            email_type: "vacation_reopening",
            idempotency_key: `test:${crypto.randomUUID()}`,
            recipient_email: settings.test_recipient_email,
            campaign_id: cycle.campaign_id || null,
            is_test: true
        }).select().single();

        if (error || !row) {
            return json({ ok: false, reason: "enqueue_failed" });
        }

        const outcome = await processOutboxRow(adminClient, row, settings);
        return json({ ok: outcome.success, testRecipient: settings.test_recipient_email });
    }

    if (action === "retry") {
        const result = await buildAndSendVacationCampaign(adminClient, cycleId);
        return json(result);
    }

    return json({ ok: false, reason: "unknown_action" }, 400);
});
