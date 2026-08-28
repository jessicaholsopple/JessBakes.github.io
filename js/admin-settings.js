document.addEventListener("DOMContentLoaded", async () => {

    await requireAuth();
    await loadBakerySettings();
    await initWeeklyScheduleSection();

    document
        .getElementById("saveBakerySettingsBtn")
        .addEventListener("click", saveBakerySettings);

});

function showMessage(text, kind) {

    const el = document.getElementById("settingsMessage");
    el.textContent = text;
    el.className = `admin-inline-message is-${kind}`;
    el.style.display = "block";

}

async function loadBakerySettings() {

    const { data, error } =
        await supabaseClient
            .from("bakery_settings")
            .select("pickup_location")
            .limit(1)
            .maybeSingle();

    if (error) {

        console.error(error);
        showMessage("Couldn't load settings. Try reloading the page.", "error");
        return;

    }

    document.getElementById("pickupLocation").value =
        data?.pickup_location || "";

}

async function saveBakerySettings() {

    const button = document.getElementById("saveBakerySettingsBtn");
    const pickup_location =
        document.getElementById("pickupLocation").value.trim();

    button.disabled = true;
    showMessage("Saving...", "loading");

    const { data: existing } =
        await supabaseClient
            .from("bakery_settings")
            .select("id")
            .limit(1)
            .maybeSingle();

    const { error } = existing
        ? await supabaseClient
            .from("bakery_settings")
            .update({ pickup_location, updated_at: new Date().toISOString() })
            .eq("id", existing.id)
        : await supabaseClient
            .from("bakery_settings")
            .insert({ pickup_location });

    button.disabled = false;

    if (error) {

        console.error(error);
        showMessage("Couldn't save. Please try again.", "error");
        return;

    }

    showMessage("Saved. This only appears in confirmed-order emails — never publicly.", "success");

}

/* ==========================================
   WEEKLY PICKUP SCHEDULE

   Loads/saves the same bakery_settings row (existing settings
   architecture, not a new table) and gives an immediate, always-fresh
   ("if submitted now") preview using the real database clock via the
   preview_weekly_pickup RPC -- the exact same function the public
   checkout page calls, so the admin sees precisely what a customer
   would see, never a locally-recomputed approximation.
   ========================================== */

function showScheduleMessage(text, kind) {
    const el = document.getElementById("scheduleMessage");
    if (!el) return;
    el.textContent = text;
    el.className = `admin-inline-message is-${kind}`;
    el.style.display = "block";
}

function populateWeekdaySelects() {
    const options = WeeklySchedule.WEEKDAY_NAMES
        .map((name, index) => `<option value="${index}">${name}</option>`)
        .join("");

    const pickupSelect = document.getElementById("schedulePickupWeekday");
    const cutoffSelect = document.getElementById("scheduleCutoffWeekday");
    if (pickupSelect) pickupSelect.innerHTML = options;
    if (cutoffSelect) cutoffSelect.innerHTML = options;
}

function readScheduleForm() {
    return {
        pickupWeekday: Number(document.getElementById("schedulePickupWeekday")?.value),
        pickupTime: document.getElementById("schedulePickupTime")?.value,
        cutoffWeekday: Number(document.getElementById("scheduleCutoffWeekday")?.value),
        cutoffTime: document.getElementById("scheduleCutoffTime")?.value
    };
}

async function initWeeklyScheduleSection() {

    populateWeekdaySelects();

    const { data, error } =
        await supabaseClient
            .from("bakery_settings")
            .select("weekly_pickup_weekday, weekly_pickup_time, weekly_cutoff_weekday, weekly_cutoff_time")
            .limit(1)
            .maybeSingle();

    if (error) {
        console.error(error);
        showScheduleMessage("Couldn't load the weekly pickup schedule. Try reloading the page.", "error");
        return;
    }

    const current = {
        pickupWeekday: data?.weekly_pickup_weekday ?? WeeklySchedule.DEFAULT_SCHEDULE.pickupWeekday,
        pickupTime: (data?.weekly_pickup_time || WeeklySchedule.DEFAULT_SCHEDULE.pickupTime).slice(0, 5),
        cutoffWeekday: data?.weekly_cutoff_weekday ?? WeeklySchedule.DEFAULT_SCHEDULE.cutoffWeekday,
        cutoffTime: (data?.weekly_cutoff_time || WeeklySchedule.DEFAULT_SCHEDULE.cutoffTime).slice(0, 5)
    };

    document.getElementById("schedulePickupWeekday").value = String(current.pickupWeekday);
    document.getElementById("schedulePickupTime").value = current.pickupTime;
    document.getElementById("scheduleCutoffWeekday").value = String(current.cutoffWeekday);
    document.getElementById("scheduleCutoffTime").value = current.cutoffTime;

    ["schedulePickupWeekday", "schedulePickupTime", "scheduleCutoffWeekday", "scheduleCutoffTime"]
        .forEach(id => document.getElementById(id)?.addEventListener("change", renderScheduleSummaryAndPreview));

    document
        .getElementById("saveScheduleBtn")
        .addEventListener("click", saveWeeklySchedule);

    await renderScheduleSummaryAndPreview();

}

/** Re-renders the plain-language rule summary (pure, local, instant --
 *  no network needed, since it's just formatting the fields already on
 *  screen) and the "if an order were submitted right now" preview
 *  (a fresh preview_weekly_pickup RPC call using the database clock and
 *  these NOT-YET-SAVED candidate values, exactly the "what if I saved
 *  this" the admin needs before committing). Runs on every field
 *  change so the wording and preview always match what's currently
 *  typed, never a stale prior save. */
async function renderScheduleSummaryAndPreview() {

    const summaryEl = document.getElementById("scheduleRuleSummary");
    const previewEl = document.getElementById("schedulePreview");
    const saveBtn = document.getElementById("saveScheduleBtn");

    const form = readScheduleForm();
    const validation = WeeklySchedule.validateScheduleSettings({ ...form, timezone: WeeklySchedule.TIMEZONE });

    if (!validation.valid) {
        summaryEl.textContent = validation.errors.join(" ");
        summaryEl.className = "admin-inline-message is-error";
        previewEl.style.display = "none";
        if (saveBtn) saveBtn.disabled = true;
        return;
    }

    if (saveBtn) saveBtn.disabled = false;

    summaryEl.textContent = WeeklySchedule.describeScheduleRule(form);
    summaryEl.className = "admin-inline-message is-info";
    summaryEl.style.display = "block";

    previewEl.textContent = "Checking the current schedule…";
    previewEl.className = "admin-inline-message is-loading";
    previewEl.style.display = "block";

    const { data, error } = await supabaseClient.rpc("preview_weekly_pickup", {
        p_pickup_weekday: form.pickupWeekday,
        p_pickup_time: form.pickupTime + ":00",
        p_cutoff_weekday: form.cutoffWeekday,
        p_cutoff_time: form.cutoffTime + ":00"
    });

    if (error) {
        console.error(error);
        previewEl.textContent = "Couldn't reach the live schedule preview right now.";
        previewEl.className = "admin-inline-message is-error";
        return;
    }

    const preview = Array.isArray(data) ? data[0] : data;

    const nextCutoffLabel = `${WeeklySchedule.weekdayName(form.cutoffWeekday)}, ${WeeklySchedule.formatTime12h(form.cutoffTime + ":00")}`;
    const nextPickupLabel = `${WeeklySchedule.formatFullDate(preview.pickup_date)}, ${WeeklySchedule.formatTime12h(preview.pickup_time)}`;

    previewEl.innerHTML = `
        <strong>Next cutoff:</strong> ${nextCutoffLabel}<br>
        <strong>Next eligible pickup:</strong> ${nextPickupLabel}<br>
        <strong>If an order were submitted right now:</strong> it would be scheduled for ${nextPickupLabel}.
    `;
    previewEl.className = "admin-inline-message is-info";

}

async function saveWeeklySchedule() {

    const button = document.getElementById("saveScheduleBtn");
    const form = readScheduleForm();

    const validation = WeeklySchedule.validateScheduleSettings({ ...form, timezone: WeeklySchedule.TIMEZONE });
    if (!validation.valid) {
        showScheduleMessage(validation.errors.join(" "), "error");
        return;
    }

    button.disabled = true;
    showScheduleMessage("Saving...", "loading");

    const { data: existing } =
        await supabaseClient
            .from("bakery_settings")
            .select("id")
            .limit(1)
            .maybeSingle();

    const payload = {
        weekly_pickup_weekday: form.pickupWeekday,
        weekly_pickup_time: form.pickupTime + ":00",
        weekly_cutoff_weekday: form.cutoffWeekday,
        weekly_cutoff_time: form.cutoffTime + ":00",
        updated_at: new Date().toISOString()
    };

    const { error } = existing
        ? await supabaseClient
            .from("bakery_settings")
            .update(payload)
            .eq("id", existing.id)
        : await supabaseClient
            .from("bakery_settings")
            .insert(payload);

    button.disabled = false;

    if (error) {
        console.error(error);
        showScheduleMessage("Couldn't save the weekly schedule. Please try again.", "error");
        return;
    }

    showScheduleMessage("Saved. New orders will use this schedule immediately -- existing orders are never moved.", "success");

    await renderScheduleSummaryAndPreview();

}
