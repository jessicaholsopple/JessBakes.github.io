// Cron-invoked (every 5 minutes, see the
// vacation-scheduler pg_cron job) authoritative scheduled reopening:
// auto-resumes ordering once `reopen_at` has passed for the active
// vacation cycle, and -- only if the admin turned on
// `auto_send_on_resume` AND the campaign passes a full, fresh
// readiness re-check -- also sends the reopening campaign. If it's
// not ready, ordering still resumes (the saved reopening setting is
// authoritative) and the reason is recorded on the cycle for the
// admin's Retry/Send Now action, per "do not send an incomplete or
// stale email."
//
// Also callable by an admin session (not just cron) for a manual
// "check now" -- isServiceRoleOrAdmin covers both.
import { getAdminClient, isServiceRoleOrAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handlePreflight } from "../_shared/cors.ts";
import { buildMenuSnapshotKey } from "../_shared/menu.mjs";
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

    const adminClient = getAdminClient();

    const { data: cycle } = await adminClient
        .from("vacation_periods")
        .select("*")
        .eq("status", "active")
        .limit(1)
        .maybeSingle();

    if (!cycle) {
        return json({ ok: true, skipped: true, reason: "no_active_cycle" });
    }

    if (!cycle.reopen_at || new Date(cycle.reopen_at).getTime() > Date.now()) {
        return json({ ok: true, skipped: true, reason: "not_due" });
    }

    const ordering = await resumeOrdering(adminClient, cycle.id);
    if (!ordering.resumed && !ordering.alreadyResumed) {
        return json({ ok: false, reason: ordering.reason || "resume_failed" });
    }

    if (!cycle.auto_send_on_resume) {
        return json({ ok: true, ordering, email: { skipped: true, reason: "auto_send_disabled" } });
    }

    // Full, fresh readiness re-check -- an unattended auto-send must
    // never fire an incomplete or stale campaign just because no
    // human is watching at this exact moment.
    const { data: menuRows } = await adminClient
        .from("menu_items")
        .select("id, name, description, price, available, product_type");
    const availableCount = (menuRows || []).filter((r: any) => r.available === true).length;
    const menuSnapshotKey = buildMenuSnapshotKey(menuRows || []);

    const { data: recipients } = await adminClient
        .rpc("vacation_eligible_subscribers", { p_cycle_id: cycle.id });
    const eligibleCount = (recipients || []).length;

    const reasons: string[] = [];
    if (!cycle.reopening_email_enabled) reasons.push("reopening_email_disabled");
    if (!cycle.email_subject || !String(cycle.email_subject).trim()) reasons.push("missing_subject");
    if (availableCount < 1) reasons.push("empty_menu");
    if (!cycle.preview_menu_snapshot_key || cycle.preview_menu_snapshot_key !== menuSnapshotKey) reasons.push("stale_or_missing_preview");
    if (eligibleCount < 1) reasons.push("no_eligible_recipients");

    if (reasons.length > 0) {
        const reason = reasons.join(",");
        await adminClient.from("vacation_periods").update({
            last_send_error: `auto_send_skipped: ${reason}`,
            updated_at: new Date().toISOString()
        }).eq("id", cycle.id);

        return json({ ok: true, ordering, email: { skipped: true, reason } });
    }

    const email = await buildAndSendVacationCampaign(adminClient, cycle.id);
    return json({ ok: true, ordering, email });
});
