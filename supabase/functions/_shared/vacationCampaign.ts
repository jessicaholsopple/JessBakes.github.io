// Shared logic behind both the manual resume flow
// (vacation-resume/index.ts) and the scheduled auto-resume
// (vacation-scheduler/index.ts) -- kept in exactly one place so the
// idempotency/eligibility/menu-snapshot guarantees can never drift
// between the two call sites.
import { buildVacationReopeningMenuCategories, weeklyMenuSkipReason, buildMenuSnapshotKey } from "./menu.mjs";
import { vacationReopeningCampaignKey, vacationReopeningRecipientKey } from "./idempotency.mjs";
import { processOutboxRow } from "./processOutbox.ts";

/**
 * Resumes ordering for one vacation cycle. Idempotent: calling this
 * twice (double-click, retry, a scheduler tick racing a manual click)
 * never does anything the second time -- it just reports the cycle
 * was already resumed, rather than erroring or re-running anything.
 */
export async function resumeOrdering(adminClient: any, cycleId: string) {
    const { data: cycle } = await adminClient
        .from("vacation_periods")
        .select("id, status")
        .eq("id", cycleId)
        .maybeSingle();

    if (!cycle) {
        return { resumed: false, reason: "cycle_not_found" };
    }

    if (cycle.status !== "active") {
        return { resumed: false, alreadyResumed: true };
    }

    // The `.eq("status","active")` guard makes this update itself the
    // race-safe "claim" -- if two requests hit this concurrently, only
    // one actually flips the row (the loser's update matches zero rows,
    // which Supabase reports as no error, just no data -- from the
    // caller's perspective the vacation is resumed either way, so this
    // does not need to distinguish who "won").
    const { error } = await adminClient
        .from("vacation_periods")
        .update({ status: "resumed", ended_at: new Date().toISOString() })
        .eq("id", cycleId)
        .eq("status", "active");

    if (error) {
        return { resumed: false, reason: "update_failed" };
    }

    return { resumed: true };
}

async function loadEmailSettings(adminClient: any) {
    const { data } = await adminClient.from("email_settings").select("*").limit(1).maybeSingle();
    return data || {};
}

/**
 * Builds (or reuses) the ONE reopening campaign for this vacation
 * cycle, using a fresh, live, server-side read of the menu -- never a
 * client-supplied or previously-cached snapshot -- and sends it to
 * every currently-eligible subscriber. Safe to call repeatedly for
 * the same cycle (manual click, retry, a scheduler tick, a network
 * timeout that makes the caller retry): the unique campaign_key means
 * at most one campaign row is ever created, and re-running this only
 * ever touches outbox rows that are still `pending`/`failed` for that
 * campaign -- an already-`sent` row is never re-sent, and a
 * subscriber whose alert was already fulfilled for this cycle is
 * never re-selected as a recipient.
 */
export async function buildAndSendVacationCampaign(adminClient: any, cycleId: string) {
    const { data: cycle } = await adminClient
        .from("vacation_periods")
        .select("*")
        .eq("id", cycleId)
        .maybeSingle();

    if (!cycle) {
        return { ok: false, reason: "cycle_not_found" };
    }

    if (!cycle.reopening_email_enabled) {
        return { ok: false, skipped: true, reason: "reopening_email_disabled" };
    }

    if (!cycle.email_subject || !String(cycle.email_subject).trim()) {
        return { ok: false, skipped: true, reason: "missing_subject" };
    }

    // Live, server-side re-read of the menu -- this is "the current
    // published menu at the moment ordering resumes," never a stale
    // snapshot from when Vacation Mode was first turned on.
    const { data: menuRows, error: menuError } = await adminClient
        .from("menu_items")
        .select("id, name, description, price, available, product_type, category, sort_order");

    if (menuError) {
        return { ok: false, skipped: true, reason: "menu_load_failed" };
    }

    const { categories, warnings } = buildVacationReopeningMenuCategories(menuRows || []);
    const skipReason = weeklyMenuSkipReason(categories);
    if (skipReason) {
        return { ok: false, skipped: true, reason: skipReason };
    }

    // A real (or test) send must never go out with products silently
    // dumped into "Other" -- that's a classification problem the
    // admin needs to fix, not something to mail around.
    if (warnings.length > 0) {
        return { ok: false, skipped: true, reason: "uncategorized_products", products: warnings };
    }

    const menuSnapshotKey = buildMenuSnapshotKey(menuRows || []);

    // Single source of truth for "who's eligible" -- respects this
    // cycle's own recipient-category toggles and never re-includes a
    // subscriber already fulfilled for this exact cycle.
    const { data: recipients, error: recipientsError } = await adminClient
        .rpc("vacation_eligible_subscribers", { p_cycle_id: cycleId });

    if (recipientsError) {
        return { ok: false, reason: "recipient_lookup_failed" };
    }
    if (!recipients || recipients.length === 0) {
        return { ok: false, skipped: true, reason: "no_eligible_recipients" };
    }

    const campaignKey = vacationReopeningCampaignKey(cycleId);

    let campaign = (await adminClient
        .from("email_campaigns")
        .select("*")
        .eq("campaign_key", campaignKey)
        .maybeSingle()).data;

    if (!campaign) {
        const { data: created, error: createError } = await adminClient
            .from("email_campaigns")
            .insert({
                campaign_type: "vacation_reopening",
                campaign_key: campaignKey,
                status: "sending",
                scheduled_for: new Date().toISOString(),
                started_at: new Date().toISOString(),
                recipient_count: recipients.length,
                menu_snapshot: categories
            })
            .select()
            .single();

        if (createError || !created) {
            // A unique-constraint conflict here means a concurrent
            // invocation just created it -- use that row instead of
            // treating this as a failure.
            const { data: raced } = await adminClient
                .from("email_campaigns")
                .select("*")
                .eq("campaign_key", campaignKey)
                .maybeSingle();
            if (!raced) {
                return { ok: false, reason: "campaign_create_failed" };
            }
            campaign = raced;
        } else {
            campaign = created;
        }

        // Link the cycle to its campaign, once.
        await adminClient
            .from("vacation_periods")
            .update({ campaign_id: campaign.id })
            .eq("id", cycleId)
            .is("campaign_id", null);
    }

    const settings = await loadEmailSettings(adminClient);

    // Enqueue one outbox row per eligible recipient. A duplicate
    // enqueue attempt (retry) hits the idempotency_key's unique
    // constraint and is silently skipped -- not an error.
    let enqueued = 0;
    for (const sub of recipients) {
        const { error } = await adminClient.from("email_outbox").insert({
            email_type: "vacation_reopening",
            idempotency_key: vacationReopeningRecipientKey(campaignKey, sub.id),
            recipient_email: sub.email,
            recipient_ref_table: "subscribers",
            recipient_ref_id: sub.id,
            campaign_id: campaign.id
        });
        if (!error) enqueued++;
    }

    // Send immediately, same pattern as weekly-scheduler.ts -- only
    // rows still pending/failed for THIS campaign are ever touched,
    // so a retry can never re-send an already-`sent` row.
    const { data: pendingRows } = await adminClient
        .from("email_outbox")
        .select("*")
        .eq("campaign_id", campaign.id)
        .in("status", ["pending", "failed"]);

    let sent = 0, failed = 0;
    for (const row of pendingRows || []) {
        const { data: claimed } = await adminClient
            .from("email_outbox")
            .update({ status: "sending", updated_at: new Date().toISOString() })
            .eq("id", row.id)
            .in("status", ["pending", "failed"])
            .select()
            .maybeSingle();

        if (!claimed) continue;
        const outcome = await processOutboxRow(adminClient, claimed, settings);

        if (outcome.success) {
            sent++;
            if (claimed.recipient_ref_table === "subscribers" && claimed.recipient_ref_id) {
                // One-time reopening-alert fulfillment, scoped to THIS
                // cycle only -- never touches pref_menu_announcements/
                // pref_general_updates, and a future vacation gets a
                // new cycle id, so this subscriber is naturally
                // eligible again next time.
                await adminClient
                    .from("subscribers")
                    .update({ reopening_alert_fulfilled_cycle_id: cycleId })
                    .eq("id", claimed.recipient_ref_id)
                    .eq("pref_reopening_alerts", true);
            }
        } else {
            failed++;
        }
    }

    const totalSent = (campaign.sent_count || 0) + sent;
    const totalFailed = (campaign.failed_count || 0) + failed;

    await adminClient.from("email_campaigns").update({
        status: totalFailed > 0 && totalSent === 0 ? "failed" : "sent",
        recipient_count: Math.max(campaign.recipient_count || 0, enqueued),
        sent_count: totalSent,
        failed_count: totalFailed,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    }).eq("id", campaign.id);

    await adminClient.from("vacation_periods").update({
        preview_menu_snapshot_key: menuSnapshotKey,
        last_send_error: (totalFailed > 0 && totalSent === 0) ? "send_failed" : null,
        updated_at: new Date().toISOString()
    }).eq("id", cycleId);

    return {
        ok: true,
        campaignId: campaign.id,
        recipientCount: recipients.length,
        sent,
        failed
    };
}
