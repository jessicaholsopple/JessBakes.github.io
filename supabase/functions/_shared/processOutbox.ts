// The single "render + send + record the result" path for one
// email_outbox row, shared by send-emails/index.ts's batch
// processor and its instant test-send/retry actions, and by
// weekly-scheduler/index.ts's own immediate send-after-enqueue pass.
// Keeping exactly one implementation is the whole point -- every
// safety property (idempotency already guaranteed by the unique
// constraint that got the row into the table; the is_test recipient
// guard; sanitized-only error storage; retry backoff) is enforced
// here once, not per call site.
import { sendViaResend } from "./resend.ts";
import { orderReceivedEmail, orderConfirmedEmail, orderCancelledEmail, newsletterWelcomeEmail, weeklyMenuEmail, vacationReopeningEmail, adminNewOrderEmail } from "./templates.mjs";
import { resolveSendRecipient, isPermanentFailure, nextOutboxState } from "./retry.mjs";
import { generateUnsubscribeToken, hashToken, buildUnsubscribeUrl } from "./token.mjs";
import { buildVacationReopeningMenuCategories } from "./menu.mjs";

const SITE_URL = "https://jessbakessourdough.com";
const ORDERS_FROM = "Jess Bakes Sourdough <orders@jessbakessourdough.com>";
const MENU_FROM = "Jess Bakes Sourdough <menu@jessbakessourdough.com>";
const MAX_ERROR_LENGTH = 300;

function sanitizeError(message: string | undefined): string {
    return String(message || "Unknown error").slice(0, MAX_ERROR_LENGTH);
}

function shortOrderRef(orderId: string): string {
    return String(orderId).replace(/-/g, "").slice(0, 8);
}

async function mintUnsubscribeLink(adminClient: any, subscriberId: string) {
    const rawToken = generateUnsubscribeToken();
    const tokenHash = await hashToken(rawToken);
    await adminClient.from("email_unsubscribe_tokens").insert({
        token_hash: tokenHash,
        subscriber_id: subscriberId
    });
    return buildUnsubscribeUrl(SITE_URL, rawToken);
}

/** Loads the source record(s) this row needs and renders the email.
 * Returns null if the underlying record no longer exists (e.g. an
 * order was somehow deleted) -- the caller marks the row 'skipped'
 * rather than retrying forever. */
async function renderForRow(adminClient: any, row: any) {
    if (row.email_type === "order_received" || row.email_type === "order_confirmed" || row.email_type === "order_cancelled" || row.email_type === "admin_new_order") {
        const { data: order } = await adminClient
            .from("orders")
            .select("id, customer_name, customer_email, customer_phone, preferred_contact, order_type, pickup_date, notes, subtotal, created_at")
            .eq("id", row.recipient_ref_id)
            .maybeSingle();

        if (!order) return null;

        const orderRef = shortOrderRef(order.id);

        if (row.email_type === "admin_new_order") {
            const { data: items } = await adminClient
                .from("order_items")
                .select("item_name, quantity, price_at_purchase, line_total")
                .eq("order_id", order.id);

            return {
                from: ORDERS_FROM,
                ...adminNewOrderEmail({
                    customerName: order.customer_name,
                    customerEmail: order.customer_email,
                    customerPhone: order.customer_phone,
                    preferredContact: order.preferred_contact,
                    orderRef,
                    orderType: order.order_type,
                    pickupDate: order.pickup_date,
                    items: (items || []).map((i: any) => ({
                        name: i.item_name, quantity: i.quantity,
                        unitPriceEur: i.price_at_purchase, lineTotalEur: i.line_total
                    })),
                    subtotalEur: order.subtotal,
                    specialInstructions: order.notes,
                    submittedAt: order.created_at
                })
            };
        }

        if (row.email_type === "order_received") {
            const { data: items } = await adminClient
                .from("order_items")
                .select("item_name, quantity, line_total")
                .eq("order_id", order.id);

            return {
                from: ORDERS_FROM,
                ...orderReceivedEmail({
                    customerName: order.customer_name,
                    orderRef,
                    items: (items || []).map((i: any) => ({
                        name: i.item_name, quantity: i.quantity, lineTotalEur: i.line_total
                    })),
                    subtotalEur: order.subtotal,
                    orderType: order.order_type,
                    pickupDate: order.pickup_date,
                    specialInstructions: order.order_type === "custom" ? order.notes : null
                })
            };
        }

        if (row.email_type === "order_confirmed") {
            const { data: bakerySettings } = await adminClient
                .from("bakery_settings")
                .select("pickup_location")
                .limit(1)
                .maybeSingle();

            return {
                from: ORDERS_FROM,
                ...orderConfirmedEmail({
                    customerName: order.customer_name,
                    orderRef,
                    orderType: order.order_type,
                    pickupDate: order.pickup_date,
                    pickupLocation: bakerySettings?.pickup_location || null
                })
            };
        }

        // order_cancelled
        return {
            from: ORDERS_FROM,
            ...orderCancelledEmail({ customerName: order.customer_name, orderRef })
        };
    }

    if (row.email_type === "newsletter_welcome") {
        const { data: subscriber } = await adminClient
            .from("subscribers")
            .select("id, name, status")
            .eq("id", row.recipient_ref_id)
            .maybeSingle();

        if (!subscriber) return null;

        const unsubscribeUrl = await mintUnsubscribeLink(adminClient, subscriber.id);

        return {
            from: MENU_FROM,
            ...newsletterWelcomeEmail({ name: subscriber.name, unsubscribeUrl })
        };
    }

    if (row.email_type === "weekly_menu") {
        const { data: campaign } = await adminClient
            .from("email_campaigns")
            .select("id, menu_snapshot")
            .eq("id", row.campaign_id)
            .maybeSingle();

        if (!campaign) return null;

        const { data: settings } = await adminClient
            .from("email_settings")
            .select("weekly_subject, weekly_intro")
            .limit(1)
            .maybeSingle();

        let unsubscribeUrl = `${SITE_URL}/unsubscribe.html`;
        if (row.recipient_ref_id) {
            unsubscribeUrl = await mintUnsubscribeLink(adminClient, row.recipient_ref_id);
        }

        const rendered = weeklyMenuEmail({
            introMessage: settings?.weekly_intro || "Here's what's fresh this week.",
            items: campaign.menu_snapshot || [],
            unsubscribeUrl
        });

        return {
            from: MENU_FROM,
            subject: settings?.weekly_subject || "This Week's Menu at Jess Bakes Sourdough",
            html: rendered.html,
            text: rendered.text
        };
    }

    if (row.email_type === "vacation_reopening") {
        let cycle: any = null;
        let categories: any[] = [];

        if (row.campaign_id) {
            // The normal path: a real campaign already exists (created
            // by resumeOrdering+buildAndSendVacationCampaign), so the
            // menu is the exact categorized snapshot taken at that
            // moment.
            const { data: campaign } = await adminClient
                .from("email_campaigns")
                .select("id, menu_snapshot")
                .eq("id", row.campaign_id)
                .maybeSingle();
            if (!campaign) return null;
            categories = campaign.menu_snapshot || [];

            const { data: cycleByCampaign } = await adminClient
                .from("vacation_periods")
                .select("email_subject, email_intro, email_preview_text")
                .eq("campaign_id", row.campaign_id)
                .maybeSingle();
            if (!cycleByCampaign) return null;
            cycle = cycleByCampaign;
        } else {
            // A "Send Test Email" row created before any real campaign
            // exists for this cycle -- fall back to the single active
            // cycle and a fresh live menu read (there is no snapshot
            // to reuse yet).
            const { data: activeCycle } = await adminClient
                .from("vacation_periods")
                .select("email_subject, email_intro, email_preview_text")
                .eq("status", "active")
                .limit(1)
                .maybeSingle();
            if (!activeCycle) return null;
            cycle = activeCycle;

            const { data: menuRows } = await adminClient
                .from("menu_items")
                .select("id, name, description, price, available, product_type, category, sort_order, builder_size");
            categories = buildVacationReopeningMenuCategories(menuRows || []).categories;
        }

        let unsubscribeUrl = `${SITE_URL}/unsubscribe.html`;
        if (row.recipient_ref_id) {
            unsubscribeUrl = await mintUnsubscribeLink(adminClient, row.recipient_ref_id);
        }

        const rendered = vacationReopeningEmail({
            additionalMessage: cycle.email_intro || "",
            categories,
            previewText: cycle.email_preview_text || "",
            unsubscribeUrl
        });

        return {
            from: MENU_FROM,
            subject: cycle.email_subject || "We're back! Ordering is open again",
            html: rendered.html,
            text: rendered.text
        };
    }

    return null;
}

export async function processOutboxRow(adminClient: any, row: any, settings: any) {
    const rendered = await renderForRow(adminClient, row);

    if (!rendered) {
        await adminClient.from("email_outbox").update({
            status: "skipped",
            last_error: "source_record_missing",
            updated_at: new Date().toISOString()
        }).eq("id", row.id);
        return { success: false, skipped: true };
    }

    const recipientResult = resolveSendRecipient({
        isTest: row.is_test,
        testRecipientEmail: settings?.test_recipient_email,
        realRecipientEmail: row.recipient_email
    });

    if (!recipientResult.ok) {
        await adminClient.from("email_outbox").update({
            status: "failed",
            last_error: recipientResult.reason,
            next_attempt_at: null,
            updated_at: new Date().toISOString()
        }).eq("id", row.id);
        return { success: false, terminal: true };
    }

    const result = await sendViaResend({
        from: rendered.from,
        to: recipientResult.recipient,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        replyTo: settings?.reply_to_email || null
    });

    if (result.ok) {
        await adminClient.from("email_outbox").update({
            status: "sent",
            sent_at: new Date().toISOString(),
            provider_message_id: result.id || null,
            attempts: (row.attempts || 0) + 1,
            updated_at: new Date().toISOString()
        }).eq("id", row.id);
        return { success: true };
    }

    const permanent = isPermanentFailure({ status: result.status, code: result.code });
    const next = nextOutboxState({
        attempts: row.attempts || 0,
        maxAttempts: row.max_attempts || 5,
        permanent,
        nowMs: Date.now()
    });

    await adminClient.from("email_outbox").update({
        status: next.status,
        attempts: next.attempts,
        next_attempt_at: next.nextAttemptAt ? next.nextAttemptAt.toISOString() : null,
        last_error: sanitizeError(result.message),
        updated_at: new Date().toISOString()
    }).eq("id", row.id);

    return { success: false, terminal: next.terminal };
}
