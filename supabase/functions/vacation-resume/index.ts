// Admin-triggered manual resume: { cycleId, sendEmail }. Called by
// the "Resume Ordering & Send Reopening Email" / "Resume Without
// Email" buttons on admin/settings.html (js/admin-vacation.js).
//
// Ordering and email are reported independently, per the requirement
// that a successful resume must never be hidden by an email failure:
// { ok:true, ordering:{...}, email:{...}|null }. Idempotent -- see
// _shared/vacationCampaign.ts's resumeOrdering/buildAndSendVacationCampaign
// for the actual guarantees (double-click, retry, and a scheduler
// tick racing this can never resume twice or send twice).
import { getAdminClient, isServiceRoleOrAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handlePreflight } from "../_shared/cors.ts";
import { resumeOrdering, buildAndSendVacationCampaign } from "../_shared/vacationCampaign.ts";

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

    let body: any;
    try {
        body = await req.json();
    } catch {
        return json({ ok: false, reason: "invalid_body" }, 400);
    }

    const cycleId = body.cycleId;
    const sendEmail = body.sendEmail === true;

    if (!cycleId) {
        return json({ ok: false, reason: "cycle_id_required" }, 400);
    }

    const adminClient = getAdminClient();

    const ordering = await resumeOrdering(adminClient, cycleId);
    if (!ordering.resumed && !ordering.alreadyResumed) {
        return json({ ok: false, reason: ordering.reason || "resume_failed" });
    }

    const email = sendEmail ? await buildAndSendVacationCampaign(adminClient, cycleId) : null;

    return json({ ok: true, ordering, email });
});
