// The outbox processor. Handles three actions, all requiring
// service-role (cron) or admin auth -- never public:
//   { action: "process" }                 -- work the pending queue
//   { action: "preview", emailType, ... } -- render only, never sends
//   { action: "test", emailType, ... }    -- render + send to the
//                                             configured test
//                                             recipient ONLY
//   { action: "retry", outboxIds: [...] } -- requeue + immediately
//                                             reprocess specific
//                                             failed rows
import { getAdminClient, isServiceRoleOrAdmin } from "../_shared/supabaseAdmin.ts";
import { processOutboxRow } from "../_shared/processOutbox.ts";
import { corsHeaders, handlePreflight } from "../_shared/cors.ts";
import {
    orderReceivedEmail, orderConfirmedEmail, orderCancelledEmail,
    newsletterWelcomeEmail, weeklyMenuEmail, adminNewOrderEmail
} from "../_shared/templates.mjs";

const BATCH_SIZE = 25;

async function loadSettings(adminClient: any) {
    const { data } = await adminClient.from("email_settings").select("*").limit(1).maybeSingle();
    return data || {};
}

async function processPending(adminClient: any) {
    const settings = await loadSettings(adminClient);
    const now = new Date().toISOString();

    // Order-type rows only proceed once order_emails_enabled is on;
    // newsletter-type rows only proceed once newsletter_enabled is
    // on. Rows for a disabled category are simply left pending --
    // no special-casing needed at enqueue time, and nothing is lost
    // when the admin later flips the toggle on.
    //
    // Disabled-category rows must also be excluded from the batch
    // query itself, not just skipped once fetched: this query is
    // ordered oldest-first and capped at BATCH_SIZE, so a backlog of
    // gated rows (e.g. admin_new_order sitting pending since
    // owner_notifications_enabled was turned off) would otherwise
    // fill every batch slot run after run and starve enabled
    // categories -- like order_received/order_confirmed -- queued
    // behind them. is_test rows are still exempt from the gate.
    const disabledTypes: string[] = [];
    if (!settings.order_emails_enabled) {
        disabledTypes.push("order_received", "order_confirmed", "order_confirmed_resend", "order_cancelled");
    }
    if (!settings.owner_notifications_enabled) {
        disabledTypes.push("admin_new_order");
    }
    if (!settings.newsletter_enabled) {
        disabledTypes.push("newsletter_welcome", "weekly_menu");
    }

    let query = adminClient
        .from("email_outbox")
        .select("*")
        .in("status", ["pending", "failed"])
        .not("next_attempt_at", "is", null)
        .lte("next_attempt_at", now)
        .order("created_at", { ascending: true })
        .limit(BATCH_SIZE);

    if (disabledTypes.length) {
        query = query.or(`is_test.eq.true,email_type.not.in.(${disabledTypes.join(",")})`);
    }

    const { data: rows } = await query;
    const results = { processed: 0, sent: 0, failed: 0, skipped: 0 };

    for (const row of rows || []) {
        const isOrderType = row.email_type.startsWith("order_");
        const isAdminOrderType = row.email_type === "admin_new_order";
        const isNewsletterType = row.email_type === "newsletter_welcome" || row.email_type === "weekly_menu";

        // Test rows (is_test:true) are exempt from the enabled-flag
        // gate -- that's the entire point of a test send: verifying
        // the pipeline works BEFORE flipping production sending on.
        // resolveSendRecipient() inside processOutboxRow() is what
        // actually keeps a test row from ever reaching a real
        // recipient, regardless of this gate. admin_new_order has its
        // own independent toggle (owner_notifications_enabled) --
        // separate from order_emails_enabled, which only governs the
        // customer-facing order_* emails.
        if (!row.is_test && (
            (isOrderType && !settings.order_emails_enabled) ||
            (isAdminOrderType && !settings.owner_notifications_enabled) ||
            (isNewsletterType && !settings.newsletter_enabled)
        )) {
            continue; // left pending, tried again next run once enabled
        }

        // Optimistic lock: only one processor run can claim a given row.
        const { data: claimed } = await adminClient
            .from("email_outbox")
            .update({ status: "sending", updated_at: new Date().toISOString() })
            .eq("id", row.id)
            .in("status", ["pending", "failed"])
            .select()
            .maybeSingle();

        if (!claimed) continue; // lost the race to another invocation

        const outcome = await processOutboxRow(adminClient, claimed, settings);
        results.processed++;
        if (outcome.success) results.sent++;
        else if (outcome.skipped) results.skipped++;
        else results.failed++;
    }

    return results;
}

function renderPreview(emailType: string, sample: any) {
    switch (emailType) {
        case "order_received":
            return orderReceivedEmail(sample);
        case "order_confirmed":
            return orderConfirmedEmail(sample);
        case "order_cancelled":
            return orderCancelledEmail(sample);
        case "admin_new_order":
            return adminNewOrderEmail(sample);
        case "newsletter_welcome":
            return newsletterWelcomeEmail({ ...sample, unsubscribeUrl: "https://jessbakessourdough.com/unsubscribe.html?t=preview" });
        case "weekly_menu":
            return weeklyMenuEmail({ ...sample, unsubscribeUrl: "https://jessbakessourdough.com/unsubscribe.html?t=preview" });
        default:
            return null;
    }
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
        // process/no-body invocations (cron) are fine with an empty body
    }

    const action = body.action || "process";
    const adminClient = getAdminClient();

    if (action === "status") {
        // Reports only whether each secret is SET -- never its value,
        // never even its length. Safe to expose to any authenticated
        // admin session.
        return json({
            ok: true,
            resendApiKeyConfigured: Boolean(Deno.env.get("RESEND_API_KEY")),
            resendWebhookSecretConfigured: Boolean(Deno.env.get("RESEND_WEBHOOK_SECRET"))
        });
    }

    if (action === "process") {
        const results = await processPending(adminClient);
        return json({ ok: true, ...results });
    }

    if (action === "preview") {
        const rendered = renderPreview(body.emailType, body.sample || {});
        if (!rendered) {
            return json({ ok: false, reason: "unknown_email_type" }, 400);
        }
        return json({ ok: true, ...rendered });
    }

    if (action === "test") {
        // A synthetic, is_test:true outbox row -- structurally
        // incapable of reaching a real customer/subscriber, since
        // processOutboxRow's resolveSendRecipient() ignores
        // recipient_email entirely whenever is_test is true and
        // refuses to send at all if no test recipient is configured.
        const settings = await loadSettings(adminClient);

        const { data: row, error } = await adminClient.from("email_outbox").insert({
            email_type: body.emailType,
            idempotency_key: `test:${crypto.randomUUID()}`,
            recipient_email: settings.test_recipient_email || "unset@example.com",
            recipient_ref_table: body.recipientRefTable || null,
            recipient_ref_id: body.recipientRefId || null,
            campaign_id: body.campaignId || null,
            is_test: true
        }).select().single();

        if (error || !row) {
            return json({ ok: false, reason: "enqueue_failed" }, 500);
        }

        const outcome = await processOutboxRow(adminClient, row, settings);
        return json({ ok: outcome.success, testRecipient: settings.test_recipient_email || null });
    }

    if (action === "retry") {
        const ids: string[] = Array.isArray(body.outboxIds) ? body.outboxIds : [];
        const settings = await loadSettings(adminClient);
        let retried = 0, sent = 0;

        for (const id of ids) {
            const { data: row } = await adminClient
                .from("email_outbox")
                .update({ status: "sending", updated_at: new Date().toISOString() })
                .eq("id", id)
                .eq("status", "failed")
                .select()
                .maybeSingle();

            if (!row) continue;
            retried++;
            const outcome = await processOutboxRow(adminClient, row, settings);
            if (outcome.success) sent++;
        }

        return json({ ok: true, retried, sent });
    }

    return json({ ok: false, reason: "unknown_action" }, 400);
});
