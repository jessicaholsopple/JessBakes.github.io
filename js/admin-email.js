let emailSettingsId = null;

document.addEventListener("DOMContentLoaded", async () => {

    await requireAuth();
    await loadEverything();

    document.getElementById("saveEmailSettingsBtn").addEventListener("click", saveEmailSettings);
    document.getElementById("previewBtn").addEventListener("click", () => previewOrTest(false));
    document.getElementById("sendTestBtn").addEventListener("click", () => previewOrTest(true));
    document.getElementById("sendWeeklyNowBtn").addEventListener("click", sendWeeklyNow);
    document.getElementById("processOutboxBtn").addEventListener("click", processOutboxNow);
    document.getElementById("outboxSearch").addEventListener("input", renderOutboxFiltered);

});

function showMessage(text, kind) {
    const el = document.getElementById("emailMessage");
    el.textContent = text;
    el.className = `admin-inline-message is-${kind}`;
    el.style.display = "block";
}

async function loadEverything() {
    await Promise.all([
        loadEmailSettings(),
        loadStatus(),
        loadCampaigns(),
        loadOutbox()
    ]);
}

/* ============ SETTINGS ============ */

async function loadEmailSettings() {

    const { data, error } =
        await supabaseClient
            .from("email_settings")
            .select("*")
            .limit(1)
            .maybeSingle();

    if (error || !data) {
        showMessage("Couldn't load email settings.", "error");
        return;
    }

    emailSettingsId = data.id;

    document.getElementById("orderEmailsEnabled").checked = data.order_emails_enabled;
    document.getElementById("ownerNotificationsEnabled").checked = data.owner_notifications_enabled;
    // Initially populated from the existing Reply-To/business email
    // rather than hardcoded, whenever no owner notification address
    // has been set yet.
    document.getElementById("ownerNotificationEmail").value = data.owner_notification_email || data.reply_to_email || "";
    document.getElementById("newsletterEnabled").checked = data.newsletter_enabled;
    document.getElementById("weeklyWeekday").value = String(data.weekly_weekday);
    document.getElementById("weeklyLocalTime").value = data.weekly_local_time;
    document.getElementById("weeklyTimezone").value = data.weekly_timezone;
    document.getElementById("senderName").value = data.sender_name || "";
    document.getElementById("replyToEmail").value = data.reply_to_email || "";
    document.getElementById("weeklySubject").value = data.weekly_subject || "";
    document.getElementById("weeklyIntro").value = data.weekly_intro || "";
    document.getElementById("testRecipientEmail").value = data.test_recipient_email || "";
    document.getElementById("dailySendLimit").value = data.daily_send_limit ?? "";
    document.getElementById("monthlySendLimit").value = data.monthly_send_limit ?? "";

    document.getElementById("statOrderEmails").textContent = data.order_emails_enabled ? "Enabled" : "Disabled";
    document.getElementById("statNewsletter").textContent = data.newsletter_enabled ? "Enabled" : "Disabled";
    document.getElementById("statOwnerNotifications").textContent = data.owner_notifications_enabled ? "Enabled" : "Disabled";

    // Immediate, direct warning tied to the settings just loaded --
    // "the admin dashboard" per the requirement, computed the moment
    // settings/subscriber counts are known, not only inside a send.
    checkQuotaWarning(data);
}

async function saveEmailSettings() {

    const button = document.getElementById("saveEmailSettingsBtn");
    const replyTo = document.getElementById("replyToEmail").value.trim();
    const newsletterEnabled = document.getElementById("newsletterEnabled").checked;
    const orderEmailsEnabled = document.getElementById("orderEmailsEnabled").checked;
    const ownerNotificationsEnabled = document.getElementById("ownerNotificationsEnabled").checked;
    const ownerNotificationEmail = document.getElementById("ownerNotificationEmail").value.trim();

    if ((newsletterEnabled || orderEmailsEnabled) && !replyTo) {
        showMessage("A reply-to address is required before enabling any sending.", "warning");
        return;
    }

    if (ownerNotificationsEnabled && !ownerNotificationEmail) {
        showMessage("A new order notification email is required before enabling owner notifications.", "warning");
        return;
    }

    button.disabled = true;
    showMessage("Saving...", "loading");

    const payload = {
        order_emails_enabled: orderEmailsEnabled,
        owner_notifications_enabled: ownerNotificationsEnabled,
        owner_notification_email: ownerNotificationEmail || null,
        newsletter_enabled: newsletterEnabled,
        weekly_weekday: Number(document.getElementById("weeklyWeekday").value),
        weekly_local_time: document.getElementById("weeklyLocalTime").value,
        weekly_timezone: document.getElementById("weeklyTimezone").value.trim() || "Europe/Berlin",
        sender_name: document.getElementById("senderName").value.trim() || "Jess Bakes Sourdough",
        reply_to_email: replyTo || null,
        weekly_subject: document.getElementById("weeklySubject").value.trim(),
        weekly_intro: document.getElementById("weeklyIntro").value.trim(),
        test_recipient_email: document.getElementById("testRecipientEmail").value.trim() || null,
        daily_send_limit: document.getElementById("dailySendLimit").value || null,
        monthly_send_limit: document.getElementById("monthlySendLimit").value || null,
        updated_at: new Date().toISOString()
    };

    const { error } =
        await supabaseClient
            .from("email_settings")
            .update(payload)
            .eq("id", emailSettingsId);

    button.disabled = false;

    if (error) {
        console.error(error);
        showMessage("Couldn't save settings.", "error");
        return;
    }

    showMessage("Settings saved.", "success");
    await loadEmailSettings();
}

async function checkQuotaWarning(settings) {

    const { count } =
        await supabaseClient
            .from("subscribers")
            .select("id", { count: "exact", head: true })
            .eq("status", "active");

    const warningEl = document.getElementById("quotaWarning");
    const dailyLimit = settings.daily_send_limit;
    const monthlyLimit = settings.monthly_send_limit;

    if (dailyLimit && count > dailyLimit) {
        warningEl.textContent = `${count} active subscribers exceeds your configured daily send limit of ${dailyLimit}. A single weekly send may not reach everyone in one day.`;
        warningEl.style.display = "block";
    } else if (monthlyLimit && count > monthlyLimit) {
        warningEl.textContent = `${count} active subscribers exceeds your configured monthly send limit of ${monthlyLimit}.`;
        warningEl.style.display = "block";
    } else {
        warningEl.style.display = "none";
    }
}

/* ============ STATUS ============ */

async function loadStatus() {

    const [{ count: active }, { count: unsub }, { count: bounced }, { count: complained }] = await Promise.all([
        supabaseClient.from("subscribers").select("id", { count: "exact", head: true }).eq("status", "active"),
        supabaseClient.from("subscribers").select("id", { count: "exact", head: true }).eq("status", "unsubscribed"),
        supabaseClient.from("subscribers").select("id", { count: "exact", head: true }).eq("status", "bounced"),
        supabaseClient.from("subscribers").select("id", { count: "exact", head: true }).eq("status", "complained")
    ]);

    document.getElementById("statActiveSubs").textContent = active ?? "—";
    document.getElementById("statUnsubscribed").textContent = unsub ?? "—";
    document.getElementById("statBouncedComplained").textContent = `${(bounced || 0) + (complained || 0)}`;

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { count: failed } =
        await supabaseClient
            .from("email_outbox")
            .select("id", { count: "exact", head: true })
            .eq("status", "failed")
            .gte("updated_at", sevenDaysAgo);

    document.getElementById("statFailed").textContent = failed ?? "—";

    try {
        const { data } = await supabaseClient.functions.invoke("send-emails", { body: { action: "status" } });
        document.getElementById("statResendKey").textContent = data?.resendApiKeyConfigured ? "Configured" : "Not configured";
        document.getElementById("statWebhookSecret").textContent = data?.resendWebhookSecretConfigured ? "Configured" : "Not configured";
    } catch (err) {
        document.getElementById("statResendKey").textContent = "Unavailable";
        document.getElementById("statWebhookSecret").textContent = "Unavailable";
    }
}

/* ============ PREVIEW / SEND TEST ============ */

async function previewOrTest(sendTest) {

    const emailType = document.getElementById("previewEmailType").value;
    const sample = buildSampleData(emailType);

    if (!sendTest) {

        const { data, error } =
            await supabaseClient
                .functions
                .invoke("send-emails", { body: { action: "preview", emailType, sample } });

        if (error || !data?.ok) {
            showMessage("Couldn't build preview.", "error");
            return;
        }

        const frame = document.getElementById("previewFrame");
        frame.style.display = "block";
        frame.srcdoc = data.html;
        return;

    }

    const testRecipient = document.getElementById("testRecipientEmail").value.trim();
    if (!testRecipient) {
        showMessage("Set an admin test recipient above before sending a test.", "warning");
        return;
    }

    showMessage("Sending test...", "loading");

    const { data, error } =
        await supabaseClient
            .functions
            .invoke("send-emails", { body: { action: "test", emailType } });

    if (error || !data?.ok) {
        showMessage("Test send failed. Check Resend configuration.", "error");
        return;
    }

    showMessage(`Test email sent to ${data.testRecipient}.`, "success");
    await loadOutbox();
}

function buildSampleData(emailType) {
    const common = {
        customerName: "Alex Example",
        orderRef: "sample01",
        orderType: "weekly",
        pickupDate: "2026-08-23"
    };

    switch (emailType) {
        case "order_received":
            return {
                ...common,
                items: [{ name: "Sourdough Boule", quantity: 1, lineTotalEur: 9 }],
                subtotalEur: 9,
                specialInstructions: "Please slice it"
            };
        case "order_confirmed":
            return { ...common, pickupLocation: "123 Bakery Lane" };
        case "order_cancelled":
            return common;
        case "admin_new_order":
            return {
                ...common,
                customerEmail: "alex@example.com",
                customerPhone: "+1 (555) 010-0100",
                preferredContact: "text",
                items: [
                    { name: "Sourdough Boule", quantity: 1, unitPriceEur: 9, lineTotalEur: 9 },
                    { name: "Sea Salt Cookie", quantity: 3, unitPriceEur: 3.5, lineTotalEur: 10.5 }
                ],
                subtotalEur: 19.5,
                specialInstructions: "Please slice the boule",
                submittedAt: new Date().toISOString()
            };
        case "review_request":
            return {
                ...common,
                items: [
                    { name: "Sourdough Boule", quantity: 1, isPromo: false, flavors: null },
                    { name: "Mix & Match Cookie Box", quantity: 1, isPromo: false, flavors: [{ name: "Brown Butter Sea Salt", quantity: 3 }, { name: "Chocolate Chip", quantity: 3 }] }
                ]
            };
        case "newsletter_welcome":
            return { name: "Alex" };
        case "weekly_menu":
            return {
                introMessage: "Here's what's fresh this week!",
                items: [
                    { name: "Sourdough Boule", description: "Classic tangy sourdough", priceEur: 9 },
                    { name: "Sea Salt Cookie", description: "", priceEur: 3.5 }
                ]
            };
        default:
            return {};
    }
}

/* ============ SEND NOW / PROCESS OUTBOX ============ */

async function sendWeeklyNow() {

    if (!confirm("Send this week's menu email to every active subscriber right now?")) return;

    showMessage("Sending weekly menu...", "loading");

    const { data, error } =
        await supabaseClient
            .functions
            .invoke("weekly-scheduler", { body: { force: true } });

    if (error) {
        showMessage("Couldn't send the weekly menu.", "error");
        return;
    }

    if (data?.skipped) {
        showMessage(`Skipped: ${data.reason}.`, "warning");
    } else if (data?.alreadyExists) {
        showMessage("This week's campaign was already sent.", "warning");
    } else {
        showMessage(`Sent to ${data.sent} of ${data.recipientCount} subscribers.`, "success");
    }

    await Promise.all([loadCampaigns(), loadOutbox(), loadStatus()]);
}

async function processOutboxNow() {

    showMessage("Processing outbox...", "loading");

    const { data, error } =
        await supabaseClient
            .functions
            .invoke("send-emails", { body: { action: "process" } });

    if (error) {
        showMessage("Couldn't process the outbox.", "error");
        return;
    }

    showMessage(`Processed ${data.processed} (${data.sent} sent, ${data.failed} failed, ${data.skipped} skipped).`, "success");
    await Promise.all([loadOutbox(), loadStatus()]);
}

/* ============ CAMPAIGN HISTORY ============ */

async function loadCampaigns() {

    const { data, error } =
        await supabaseClient
            .from("email_campaigns")
            .select("*")
            .order("created_at", { ascending: false })
            .limit(20);

    const tbody = document.getElementById("campaignTableBody");

    if (error || !data) {
        tbody.innerHTML = `<tr><td colspan="6">Couldn't load campaign history.</td></tr>`;
        return;
    }

    if (data.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6">No campaigns yet.</td></tr>`;
        return;
    }

    tbody.innerHTML = data.map(c => `
        <tr>
            <td>${escapeHtml(c.campaign_key)}${c.is_test ? " (test)" : ""}</td>
            <td>${escapeHtml(c.status)}</td>
            <td>${c.recipient_count}</td>
            <td>${c.sent_count}</td>
            <td>${c.failed_count}</td>
            <td>${escapeHtml(c.skip_reason || "—")}</td>
        </tr>
    `).join("");
}

/* ============ OUTBOX ============ */

let outboxRows = [];

async function loadOutbox() {

    const { data, error } =
        await supabaseClient
            .from("email_outbox")
            .select("*")
            .order("updated_at", { ascending: false })
            .limit(100);

    if (error) {
        document.getElementById("outboxTableBody").innerHTML = `<tr><td colspan="7">Couldn't load the outbox.</td></tr>`;
        return;
    }

    outboxRows = data || [];
    renderOutboxFiltered();
}

function renderOutboxFiltered() {

    const search = document.getElementById("outboxSearch").value.trim().toLowerCase();

    const filtered = search
        ? outboxRows.filter(r =>
            (r.recipient_email || "").toLowerCase().includes(search) ||
            (r.recipient_ref_id || "").toLowerCase().includes(search) ||
            (r.email_type || "").toLowerCase().includes(search) ||
            (r.status || "").toLowerCase().includes(search))
        : outboxRows;

    const tbody = document.getElementById("outboxTableBody");

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7">No matching emails.</td></tr>`;
        return;
    }

    tbody.innerHTML = filtered.map(row => `
        <tr>
            <td>${escapeHtml(row.email_type)}</td>
            <td>${escapeHtml(row.recipient_email)}</td>
            <td>${escapeHtml(row.status)}${row.is_test ? " (test)" : ""}</td>
            <td>${row.attempts}</td>
            <td>${escapeHtml(row.last_error || "—")}</td>
            <td>${new Date(row.updated_at).toLocaleString()}</td>
            <td>
                ${row.status === "failed"
            ? `<button class="secondary-btn" onclick="retryOutboxRow('${row.id}')">Resend</button>`
            : ""}
            </td>
        </tr>
    `).join("");
}

async function retryOutboxRow(id) {

    showMessage("Retrying...", "loading");

    const { data, error } =
        await supabaseClient
            .functions
            .invoke("send-emails", { body: { action: "retry", outboxIds: [id] } });

    if (error || !data?.ok) {
        showMessage("Retry failed.", "error");
        return;
    }

    showMessage(data.sent > 0 ? "Resent successfully." : "Retried, but it failed again.", data.sent > 0 ? "success" : "warning");
    await loadOutbox();
}

function escapeHtml(text) {
    return String(text ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}
