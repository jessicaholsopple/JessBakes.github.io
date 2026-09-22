// Cron-invoked (every 5 minutes, see the theme-scheduler pg_cron job)
// authoritative Themes resolver: recomputes "what theme is active
// right now" from theme_schedules_published + theme_state's manual
// override, and writes the result onto theme_state.resolved_* --
// the ONLY place a customer-facing theming decision actually gets
// made. Public pages (js/theme-apply.js) only ever read that
// precomputed result; they never run this resolver themselves. Also
// callable by an admin session (not just cron) for a manual
// "check now" -- isServiceRoleOrAdmin covers both, same pattern as
// vacation-scheduler.
import { getAdminClient, isServiceRoleOrAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handlePreflight } from "../_shared/cors.ts";
import { resolveActiveTheme } from "../_shared/themeSchedule.mjs";

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
    const nowUtc = new Date();

    const [{ data: catalogRows }, { data: publishedRows }, { data: state }] = await Promise.all([
        adminClient.from("theme_catalog").select("key, tier"),
        adminClient.from("theme_schedules_published").select("*"),
        adminClient.from("theme_state").select("*").maybeSingle()
    ]);

    if (!state) {
        return json({ ok: false, reason: "theme_state_missing" }, 500);
    }

    const catalogByKey: Record<string, { key: string; tier: string | null }> = {};
    for (const row of catalogRows || []) {
        catalogByKey[row.key] = { key: row.key, tier: row.tier };
    }

    // An expired manual override reverts to automatic scheduling on
    // its own, with no separate admin action required.
    let manualThemeKey: string | null = state.manual_theme_key;
    let manualEndsAt: string | null = state.manual_ends_at;
    const overrideExpired = manualThemeKey && manualEndsAt && new Date(manualEndsAt) <= nowUtc;

    if (overrideExpired) {
        await adminClient
            .from("theme_state")
            .update({ manual_theme_key: null, manual_started_at: null, manual_ends_at: null })
            .eq("id", state.id);
        manualThemeKey = null;
        manualEndsAt = null;
    }

    const manualOverride = manualThemeKey ? { theme_key: manualThemeKey, ends_at: manualEndsAt } : null;

    const resolution = resolveActiveTheme({
        catalogByKey,
        scheduleEntries: publishedRows || [],
        manualOverride,
        nowUtc
    });

    const changed =
        resolution.resolvedThemeKey !== state.resolved_theme_key ||
        resolution.resolvedReason !== state.resolved_reason ||
        resolution.accentIntensity !== state.resolved_accent_intensity ||
        resolution.graphicsVisibility !== state.resolved_graphics_visibility ||
        resolution.sourceScheduleId !== state.resolved_source_schedule_id;

    if (changed) {
        await adminClient
            .from("theme_state")
            .update({
                resolved_theme_key: resolution.resolvedThemeKey,
                resolved_reason: resolution.resolvedReason,
                resolved_accent_intensity: resolution.accentIntensity,
                resolved_graphics_visibility: resolution.graphicsVisibility,
                resolved_source_schedule_id: resolution.sourceScheduleId,
                resolved_at: nowUtc.toISOString()
            })
            .eq("id", state.id);
    }

    return json({ ok: true, changed, resolution, overrideExpired: !!overrideExpired });
});
