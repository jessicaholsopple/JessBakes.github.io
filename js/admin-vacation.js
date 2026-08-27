/* ==========================================
   ADMIN: VACATION MODE + REOPENING EMAIL
   ==========================================

   Kept as its own file/DOMContentLoaded listener, separate from
   js/admin-settings.js's existing (working) pickup-location logic --
   purely additive to that file's page.

   Edge Function contract this file calls (see
   supabase/functions/vacation-campaign, vacation-resume):
     - "vacation-campaign" (admin-gated): {action:"preview"|"test"|"retry", cycleId}
     - "vacation-resume"   (admin-gated): {cycleId, sendEmail}

   Preview/Send Test ALWAYS persist the current form fields first
   (persistReopeningEmailDraft()) before invoking the Edge Function --
   this is the fix for a real bug: previously they rendered/sent
   whatever was last SAVED in the database, silently ignoring anything
   typed into the form but not yet saved via a separate "Save
   Reopening Email" click. Now what you see in Preview (and what a
   Test Email delivers) always matches exactly what's currently in
   the form, with no separate save step required first.
   ========================================== */

let vacationCurrentCycle = null;
let vacationAvailableMenuItems = [];
let vacationEligibleRecipientCount = 0;
let vacationResumeRequestInFlight = false;
let vacationPreviewInFlight = false;
let vacationTestSendInFlight = false;
let vacationSaveDetailsInFlight = false;
let vacationSaveEmailInFlight = false;
let vacationRetryInFlight = false;
let vacationStartInFlight = false;

document.addEventListener("DOMContentLoaded", async () => {
    await requireAuth();
    await loadVacationPanel();
    wireVacationEvents();
});

function wireVacationEvents() {
    document.getElementById("vacationStartBtn")?.addEventListener("click", startVacation);
    document.getElementById("vacationSaveDetailsBtn")?.addEventListener("click", saveVacationDetails);
    document.getElementById("vacationSaveEmailBtn")?.addEventListener("click", saveReopeningEmailDraft);
    document.getElementById("vacationPreviewBtn")?.addEventListener("click", previewVacationEmail);
    document.getElementById("vacationSendTestBtn")?.addEventListener("click", sendVacationTestEmail);
    document.getElementById("vacationRetryEmailBtn")?.addEventListener("click", retryVacationEmail);

    document.getElementById("vacationResumeReviewBtn")?.addEventListener("click", openResumeReviewPanel);
    document.getElementById("vacationResumeCancelBtn")?.addEventListener("click", closeResumeReviewPanel);
    document.getElementById("vacationResumeSendBtn")?.addEventListener("click", confirmResumeWithEmail);
    document.getElementById("vacationResumeNoEmailBtn")?.addEventListener("click", showResumeWithoutEmailConfirm);
    document.getElementById("vacationResumeNoEmailConfirmBtn")?.addEventListener("click", confirmResumeWithoutEmail);

    ["vacationRecipientsReopening", "vacationRecipientsMenu", "vacationRecipientsGeneral"].forEach(id => {
        document.getElementById(id)?.addEventListener("change", refreshVacationEligibleCountFromForm);
    });
}

function showVacationMessage(text, kind) {
    const el = document.getElementById("vacationAdminMessage");
    if (!el) return;
    el.textContent = text;
    el.className = `admin-inline-message is-${kind}`;
    el.style.display = "block";
}

/* ==========================================
   INLINE ACTION FEEDBACK (beside/underneath a button --
   the distant page-level banner above is secondary at most)
   ========================================== */

/** Returns a small controller for one button+feedback-element pair:
 *  .start() disables the button, swaps its label, shows a loading
 *  pill; .success()/.error() restore the button and show a result
 *  pill in place, persisting until the next action (not auto-hidden,
 *  so it stays readable as long as the admin needs). Disabling the
 *  button synchronously at the start of the click handler IS the
 *  double-click guard -- a disabled element cannot dispatch another
 *  click -- reinforced by the in-flight boolean flags at call sites
 *  for defense in depth. */
function withButtonFeedback(buttonId, feedbackId, busyLabel) {
    const button = document.getElementById(buttonId);
    const idleLabel = button ? button.textContent : "";

    return {
        start() {
            if (button) {
                button.disabled = true;
                button.textContent = busyLabel;
            }
            setActionFeedback(feedbackId, "loading", "Working…");
        },
        success(message) {
            if (button) {
                button.disabled = false;
                button.textContent = idleLabel;
            }
            setActionFeedback(feedbackId, "success", message);
        },
        error(message) {
            if (button) {
                button.disabled = false;
                button.textContent = idleLabel;
            }
            setActionFeedback(feedbackId, "error", message);
        }
    };
}

function setActionFeedback(feedbackId, kind, text) {
    const el = document.getElementById(feedbackId);
    if (!el) return;
    el.textContent = text || "";
    el.className = `vacation-action-feedback${text ? ` is-${kind}` : ""}`;
}

/* ==========================================
   LOAD
   ========================================== */

async function loadVacationPanel() {
    const { data: cycle, error } = await supabaseClient
        .from("vacation_periods")
        .select("*")
        .eq("status", "active")
        .limit(1)
        .maybeSingle();

    if (error) {
        console.error(error);
        showVacationMessage("Couldn't load Vacation Mode status. Try reloading the page.", "error");
        return;
    }

    vacationCurrentCycle = cycle || null;

    const { data: menuItems, error: menuError } = await supabaseClient
        .from("menu_items")
        .select("id, name, price, description, product_type, available, category, sort_order")
        .eq("available", true);

    if (menuError) {
        console.error(menuError);
    }
    vacationAvailableMenuItems = menuItems || [];

    if (!vacationCurrentCycle) {
        await renderVacationNotActiveView();
    } else {
        await renderVacationActiveView();
    }
}

async function loadLastCompletedCycleSummary() {
    const { data: lastCycle, error } = await supabaseClient
        .from("vacation_periods")
        .select("*")
        .eq("status", "resumed")
        .order("ended_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error || !lastCycle) {
        return null;
    }

    if (!lastCycle.campaign_id) {
        return { cycle: lastCycle, campaign: null };
    }

    const { data: campaign } = await supabaseClient
        .from("email_campaigns")
        .select("status, recipient_count, sent_count, failed_count, completed_at")
        .eq("id", lastCycle.campaign_id)
        .maybeSingle();

    return { cycle: lastCycle, campaign: campaign || null };
}

/* ==========================================
   NOT ACTIVE VIEW
   ========================================== */

async function renderVacationNotActiveView() {
    setDisplay("vacationNotActiveView", "block");
    setDisplay("vacationActiveView", "none");

    const summary = await loadLastCompletedCycleSummary();
    const summaryBox = document.getElementById("vacationLastCycleSummary");
    if (!summary || !summaryBox) {
        if (summaryBox) summaryBox.style.display = "none";
        return;
    }

    summaryBox.style.display = "block";
    setText("vacationLastSentDate", summary.campaign?.completed_at
        ? new Date(summary.campaign.completed_at).toLocaleString()
        : "Not sent");
    setText("vacationLastRecipientCount", summary.campaign?.recipient_count ?? "—");
    setText("vacationLastSentCount", summary.campaign?.sent_count ?? "—");
    setText("vacationLastFailedCount", summary.campaign?.failed_count ?? "—");
}

async function startVacation() {
    if (vacationStartInFlight) return;
    vacationStartInFlight = true;

    const feedback = withButtonFeedback("vacationStartBtn", "vacationStartFeedback", "Starting…");
    feedback.start();

    const heading = (document.getElementById("vacationStartHeading")?.value || "").trim() || "We're on a baking break!";
    const message = (document.getElementById("vacationStartMessage")?.value || "").trim();
    const reopenAt = toIsoOrNull(document.getElementById("vacationStartReopenAt")?.value);
    const pickupAt = toIsoOrNull(document.getElementById("vacationStartPickupAt")?.value);

    try {
        const { error } = await supabaseClient.from("vacation_periods").insert({
            heading, message: message || null, reopen_at: reopenAt, next_pickup_at: pickupAt
        });

        if (error) {
            console.error(error);
            feedback.error("Couldn't start Vacation Mode. Please try again.");
            return;
        }

        feedback.success("Vacation Mode is now active. Ordering is paused.");
        await loadVacationPanel();
    } finally {
        vacationStartInFlight = false;
    }
}

/* ==========================================
   ACTIVE VIEW
   ========================================== */

async function renderVacationActiveView() {
    setDisplay("vacationNotActiveView", "none");
    setDisplay("vacationActiveView", "block");

    const cycle = vacationCurrentCycle;

    setText("vacationActiveStartedAt", cycle.started_at ? new Date(cycle.started_at).toLocaleString() : "—");
    setText("vacationActiveReopenAt", VacationMode.formatBakeryDateTime(cycle.reopen_at) || "Not set");
    setText("vacationActivePickupAt", VacationMode.formatBakeryDateTime(cycle.next_pickup_at) || "Not set");

    setValue("vacationHeadingInput", cycle.heading || "");
    setValue("vacationMessageInput", cycle.message || "");
    setValue("vacationReopenAtInput", toLocalInputValue(cycle.reopen_at));
    setValue("vacationPickupAtInput", toLocalInputValue(cycle.next_pickup_at));

    setChecked("vacationEmailEnabledToggle", cycle.reopening_email_enabled !== false);
    setValue("vacationEmailSubject", cycle.email_subject || "");
    setValue("vacationEmailPreviewText", cycle.email_preview_text || "");
    setValue("vacationAdditionalMessage", cycle.email_intro || "");
    setChecked("vacationRecipientsReopening", cycle.recipients_reopening_alerts !== false);
    setChecked("vacationRecipientsMenu", cycle.recipients_menu_announcements !== false);
    setChecked("vacationRecipientsGeneral", cycle.recipients_general_updates === true);

    setText("vacationMenuItemCount", vacationAvailableMenuItems.length);

    await refreshVacationEligibleCount();
    renderVacationReadiness();
}

async function saveVacationDetails() {
    if (vacationSaveDetailsInFlight) return;
    vacationSaveDetailsInFlight = true;

    const feedback = withButtonFeedback("vacationSaveDetailsBtn", "vacationSaveDetailsFeedback", "Saving…");
    feedback.start();

    const heading = (document.getElementById("vacationHeadingInput")?.value || "").trim() || "We're on a baking break!";
    const message = (document.getElementById("vacationMessageInput")?.value || "").trim();
    const reopenAt = toIsoOrNull(document.getElementById("vacationReopenAtInput")?.value);
    const pickupAt = toIsoOrNull(document.getElementById("vacationPickupAtInput")?.value);

    try {
        const { error } = await supabaseClient
            .from("vacation_periods")
            .update({ heading, message: message || null, reopen_at: reopenAt, next_pickup_at: pickupAt })
            .eq("id", vacationCurrentCycle.id);

        if (error) {
            console.error(error);
            feedback.error("Couldn't save. Please try again.");
            return;
        }

        feedback.success("Vacation details saved.");
        await loadVacationPanel();
    } finally {
        vacationSaveDetailsInFlight = false;
    }
}

/** Reads the Reopening Email form. `email_intro` is the DB column
 *  behind the single "Additional message" field (renamed in the UI,
 *  column kept as-is -- see 20260827180000's migration comment).
 *  There is no more separate "closing text" field to read. */
function readReopeningEmailForm() {
    return {
        reopening_email_enabled: document.getElementById("vacationEmailEnabledToggle")?.checked === true,
        email_subject: (document.getElementById("vacationEmailSubject")?.value || "").trim(),
        email_preview_text: (document.getElementById("vacationEmailPreviewText")?.value || "").trim() || null,
        email_intro: (document.getElementById("vacationAdditionalMessage")?.value || "").trim() || null,
        recipients_reopening_alerts: document.getElementById("vacationRecipientsReopening")?.checked === true,
        recipients_menu_announcements: document.getElementById("vacationRecipientsMenu")?.checked === true,
        recipients_general_updates: document.getElementById("vacationRecipientsGeneral")?.checked === true
    };
}

/** The actual persistence, shared by the explicit "Save Reopening
 *  Email" button AND by Preview/Send Test (which now always save
 *  first, so what's rendered/sent can never silently drift from
 *  what's in the form). Updates the in-memory vacationCurrentCycle on
 *  success so readiness/preview-staleness checks stay consistent
 *  without needing a full panel reload. */
async function persistReopeningEmailDraft() {
    const payload = readReopeningEmailForm();
    const { error } = await supabaseClient
        .from("vacation_periods")
        .update(payload)
        .eq("id", vacationCurrentCycle.id);

    if (!error) {
        Object.assign(vacationCurrentCycle, payload);
    }

    return { error };
}

async function saveReopeningEmailDraft() {
    if (vacationSaveEmailInFlight) return;
    vacationSaveEmailInFlight = true;

    const feedback = withButtonFeedback("vacationSaveEmailBtn", "vacationSaveEmailFeedback", "Saving…");
    feedback.start();

    try {
        const { error } = await persistReopeningEmailDraft();

        if (error) {
            console.error(error);
            feedback.error("Couldn't save. Please try again.");
            return;
        }

        feedback.success("Reopening email saved.");
        await refreshVacationEligibleCount();
        renderVacationReadiness();
    } finally {
        vacationSaveEmailInFlight = false;
    }
}

/* ==========================================
   ELIGIBLE RECIPIENT COUNT + READINESS
   ========================================== */

async function refreshVacationEligibleCount() {
    if (!vacationCurrentCycle) return;

    const { data, error } = await supabaseClient.rpc("vacation_eligible_subscribers", {
        p_cycle_id: vacationCurrentCycle.id
    });

    if (error) {
        console.error(error);
        vacationEligibleRecipientCount = 0;
    } else {
        vacationEligibleRecipientCount = (data || []).length;
    }

    setText("vacationEligibleCount", vacationEligibleRecipientCount);
}

/** The category checkboxes change the SAVED cycle's eligibility --
 *  re-running the live count against unsaved checkbox state would be
 *  misleading, so this just re-renders readiness with a note that the
 *  count reflects the last SAVED categories until "Save Reopening
 *  Email" is clicked. */
function refreshVacationEligibleCountFromForm() {
    renderVacationReadiness();
}

function renderVacationReadiness() {
    if (!vacationCurrentCycle) return;

    const form = readReopeningEmailForm();
    const currentMenuSnapshotKey = VacationMode.buildMenuSnapshotKey(vacationAvailableMenuItems);

    const readiness = VacationMode.computeReadiness({
        reopeningEmailEnabled: form.reopening_email_enabled,
        subject: form.email_subject,
        previewMenuSnapshotKey: vacationCurrentCycle.preview_menu_snapshot_key,
        currentMenuSnapshotKey,
        availableMenuCount: vacationAvailableMenuItems.length,
        eligibleRecipientCount: vacationEligibleRecipientCount
    });

    const badge = document.getElementById("vacationReadinessBadge");
    if (badge) {
        badge.textContent = readiness.ready ? "Ready" : "Not Ready";
    }

    const reasonsBox = document.getElementById("vacationReadinessReasons");
    if (reasonsBox) {
        if (readiness.ready) {
            reasonsBox.style.display = "none";
        } else {
            reasonsBox.style.display = "block";
            reasonsBox.innerHTML = "<strong>Before this can send automatically:</strong><ul style='margin:8px 0 0 20px;padding:0;'>"
                + readiness.reasons.map(r => `<li>${escapeVacationHtml(r)}</li>`).join("")
                + "</ul>";
        }
    }

    const autoSendToggle = document.getElementById("vacationAutoSendToggle");
    if (autoSendToggle) {
        autoSendToggle.disabled = !readiness.ready;
        autoSendToggle.checked = readiness.ready && vacationCurrentCycle.auto_send_on_resume === true;
    }

    return readiness;
}

/* ==========================================
   PREVIEW / TEST / RETRY
   ========================================== */

async function previewVacationEmail() {
    if (vacationPreviewInFlight) return;
    vacationPreviewInFlight = true;

    const feedback = withButtonFeedback("vacationPreviewBtn", "vacationPreviewFeedback", "Generating Preview…");
    feedback.start();

    try {
        const { error: saveError } = await persistReopeningEmailDraft();
        if (saveError) {
            console.error(saveError);
            feedback.error("Couldn't save your changes before previewing. Please try again.");
            return;
        }

        const { data, error } = await supabaseClient.functions.invoke("vacation-campaign", {
            body: { action: "preview", cycleId: vacationCurrentCycle.id }
        });

        if (error || !data?.ok) {
            console.error(error || data);
            feedback.error("Couldn't generate a preview. Please try again.");
            return;
        }

        const frame = document.getElementById("vacationPreviewFrame");
        if (frame) {
            frame.srcdoc = data.html;
            frame.style.display = "block";
        }

        if (data.menuSnapshotKey) {
            vacationCurrentCycle.preview_menu_snapshot_key = data.menuSnapshotKey;
            vacationCurrentCycle.preview_generated_at = new Date().toISOString();
        }

        feedback.success("Preview generated from the current published menu and your saved draft.");
        renderVacationReadiness();
    } finally {
        vacationPreviewInFlight = false;
    }
}

async function sendVacationTestEmail() {
    if (vacationTestSendInFlight) return;
    vacationTestSendInFlight = true;

    const feedback = withButtonFeedback("vacationSendTestBtn", "vacationSendTestFeedback", "Sending Test Email…");
    feedback.start();

    try {
        const { error: saveError } = await persistReopeningEmailDraft();
        if (saveError) {
            console.error(saveError);
            feedback.error("Couldn't save your changes before sending. Please try again.");
            return;
        }

        const { data, error } = await supabaseClient.functions.invoke("vacation-campaign", {
            body: { action: "test", cycleId: vacationCurrentCycle.id }
        });

        if (error || !data?.ok) {
            console.error(error || data);
            feedback.error(
                data?.reason === "missing_test_recipient"
                    ? "Set a test recipient email on the Email page first."
                    : "Couldn't send the test email. Please try again."
            );
            return;
        }

        feedback.success(`Test email sent successfully to ${data.testRecipient}.`);
    } finally {
        vacationTestSendInFlight = false;
    }
}

async function retryVacationEmail() {
    if (vacationRetryInFlight) return;
    vacationRetryInFlight = true;

    const feedback = withButtonFeedback("vacationRetryEmailBtn", "vacationRetryFeedback", "Retrying…");
    feedback.start();

    try {
        const { data, error } = await supabaseClient.functions.invoke("vacation-campaign", {
            body: { action: "retry", cycleId: vacationCurrentCycle.id }
        });

        if (error || !data?.ok) {
            console.error(error || data);
            feedback.error("Retry failed. Please try again.");
            return;
        }

        feedback.success(`Retry complete: ${data.sent || 0} sent, ${data.failed || 0} failed.`);
        await loadVacationPanel();
    } finally {
        vacationRetryInFlight = false;
    }
}

/* ==========================================
   RESUME ORDERING
   ========================================== */

async function openResumeReviewPanel() {
    await refreshVacationEligibleCount();
    const readiness = renderVacationReadiness();

    const { data: ballot } = await supabaseClient
        .from("ballot_settings")
        .select("id")
        .eq("active", true)
        .limit(1)
        .maybeSingle();

    const categories = VacationMode.describeRecipientCategories({
        recipients_reopening_alerts: document.getElementById("vacationRecipientsReopening")?.checked,
        recipients_menu_announcements: document.getElementById("vacationRecipientsMenu")?.checked,
        recipients_general_updates: document.getElementById("vacationRecipientsGeneral")?.checked
    });

    const summary = document.getElementById("vacationResumeSummary");
    if (summary) {
        summary.innerHTML = [
            `<li><strong>Ordering reopens:</strong> ${escapeVacationHtml(VacationMode.formatBakeryDateTime(vacationCurrentCycle.reopen_at) || "Immediately")}</li>`,
            `<li><strong>Next pickup:</strong> ${escapeVacationHtml(VacationMode.formatBakeryDateTime(vacationCurrentCycle.next_pickup_at) || "Not set")}</li>`,
            `<li><strong>Email subject:</strong> ${escapeVacationHtml(document.getElementById("vacationEmailSubject")?.value || "")}</li>`,
            `<li><strong>Current menu:</strong> ${vacationAvailableMenuItems.length} available item(s)</li>`,
            `<li><strong>Recipient categories:</strong> ${categories.length ? escapeVacationHtml(categories.join(", ")) : "None selected"}</li>`,
            `<li><strong>Eligible recipients:</strong> ${vacationEligibleRecipientCount}</li>`,
            `<li><strong>Ballot:</strong> ${ballot ? "Still open -- unaffected by resuming ordering" : "No active ballot"}</li>`
        ].join("");
    }

    const problems = document.getElementById("vacationResumeProblems");
    if (problems) {
        if (readiness.ready) {
            problems.style.display = "none";
        } else {
            problems.style.display = "block";
            problems.innerHTML = "<strong>Readiness problems (email will not send if you choose to send it):</strong><ul style='margin:8px 0 0 20px;padding:0;'>"
                + readiness.reasons.map(r => `<li>${escapeVacationHtml(r)}</li>`).join("")
                + "</ul>";
        }
    }

    setDisplay("vacationResumePanel", "block");
    setDisplay("vacationResumeNoEmailConfirm", "none");
    setDisplay("vacationResumeResult", "none");
}

function closeResumeReviewPanel() {
    setDisplay("vacationResumePanel", "none");
}

function showResumeWithoutEmailConfirm() {
    setDisplay("vacationResumeNoEmailConfirm", "block");
}

async function confirmResumeWithEmail() {
    await submitResume(true);
}

async function confirmResumeWithoutEmail() {
    const checkbox = document.getElementById("vacationResumeNoEmailConfirmCheckbox");
    if (checkbox?.checked !== true) {
        alert("Please check the box to confirm you understand no reopening email will be sent.");
        return;
    }
    await submitResume(false);
}

async function submitResume(sendEmail) {
    if (vacationResumeRequestInFlight) {
        return;
    }
    vacationResumeRequestInFlight = true;

    const sendBtn = document.getElementById("vacationResumeSendBtn");
    const noEmailBtn = document.getElementById("vacationResumeNoEmailConfirmBtn");
    if (sendBtn) sendBtn.disabled = true;
    if (noEmailBtn) noEmailBtn.disabled = true;

    const resultBox = document.getElementById("vacationResumeResult");
    if (resultBox) {
        resultBox.style.display = "block";
        resultBox.className = "admin-inline-message is-loading";
        resultBox.textContent = "Resuming ordering...";
    }

    try {
        const { data, error } = await supabaseClient.functions.invoke("vacation-resume", {
            body: { cycleId: vacationCurrentCycle.id, sendEmail }
        });

        if (error || !data?.ok) {
            console.error(error || data);
            if (resultBox) {
                resultBox.className = "admin-inline-message is-error";
                resultBox.textContent = "Couldn't resume ordering. Please try again.";
            }
            return;
        }

        const orderingLine = data.ordering?.resumed
            ? "Ordering resumed."
            : "Ordering was already resumed (no change).";
        const emailLine = !sendEmail
            ? "No reopening email was sent (by your choice)."
            : data.email?.skipped
                ? `Reopening email not sent: ${data.email.reason || "not ready"}.`
                : data.email?.ok === false
                    ? "Ordering resumed, but the reopening email failed to queue. Use Retry Email on the panel below."
                    : `Reopening email queued: ${data.email?.sent ?? 0} sent, ${data.email?.failed ?? 0} failed, of ${data.email?.recipientCount ?? 0} eligible.`;

        if (resultBox) {
            resultBox.className = "admin-inline-message is-success";
            resultBox.textContent = `${orderingLine} ${emailLine}`;
        }

        await loadVacationPanel();
    } finally {
        vacationResumeRequestInFlight = false;
        if (sendBtn) sendBtn.disabled = false;
        if (noEmailBtn) noEmailBtn.disabled = false;
    }
}

/* ==========================================
   SMALL DOM HELPERS
   ========================================== */

function setDisplay(id, value) {
    const el = document.getElementById(id);
    if (el) el.style.display = value;
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function setValue(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value;
}

function setChecked(id, value) {
    const el = document.getElementById(id);
    if (el) el.checked = !!value;
}

function toIsoOrNull(localValue) {
    if (!localValue) return null;
    const date = new Date(localValue);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Converts a stored ISO timestamp to the value a
 *  <input type="datetime-local"> expects (local time, no seconds/Z). */
function toLocalInputValue(iso) {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function escapeVacationHtml(text) {
    return String(text || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}
