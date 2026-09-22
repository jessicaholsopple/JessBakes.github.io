/* ==========================================
   ADMIN: THEMES
   ==========================================

   window.ThemeSchedule (the shared DST-safe resolver from
   supabase/functions/_shared/themeSchedule.mjs) is populated by a
   small inline <script type="module"> in admin/themes.html, loaded
   BEFORE this file in document order. Module scripts are deferred
   until after parsing, same as this classic script's own
   DOMContentLoaded handler -- so window.ThemeSchedule is guaranteed
   ready by the time anything in this file actually USES it, as long
   as that use only ever happens inside (or after) the
   DOMContentLoaded handler below, never at top-level script
   evaluation. Every function here that touches window.ThemeSchedule
   is only ever called from there.

   Draft vs. published: every read/write in this file EXCEPT the
   manual-override actions and publish/discard themselves operates on
   theme_schedules (the DRAFT table) -- nothing here is customer-
   facing until publish_theme_schedule() is called. Manual override +
   "Return to Automatic"/"Set to Classic Now" write theme_state
   directly and take effect immediately, mirroring
   js/admin-vacation.js's startVacation()'s direct-write pattern.
   ========================================== */

let themeCatalog = [];
let themeCatalogByKey = {};
let themeDraftSchedules = [];
let themeStateRow = null;

let themeManualActivateInFlight = false;
let themeManualClearInFlight = false;
let themePublishInFlight = false;
let themeDiscardInFlight = false;

document.addEventListener("DOMContentLoaded", async () => {
    await requireAuth();
    wireThemeScheduleListEvents();
    wireThemePreviewEvents();
    wireThemeActionEvents();
    await loadThemeAdminData();
});

/* ==========================================
   LOAD + RENDER
   ========================================== */

async function loadThemeAdminData() {
    const [{ data: catalog, error: catalogError }, { data: schedules, error: scheduleError }, { data: state, error: stateError }] = await Promise.all([
        supabaseClient.from("theme_catalog").select("*").order("sort_order"),
        supabaseClient.from("theme_schedules").select("*").order("created_at"),
        supabaseClient.from("theme_state").select("*").maybeSingle()
    ]);

    if (catalogError || scheduleError || stateError) {
        console.error(catalogError || scheduleError || stateError);
        showThemeMessage("Couldn't load Themes data. Try reloading the page.", "error");
        return;
    }

    themeCatalog = catalog || [];
    themeCatalogByKey = {};
    themeCatalog.forEach(row => { themeCatalogByKey[row.key] = row; });
    themeDraftSchedules = schedules || [];
    themeStateRow = state || null;

    renderThemeLiveNow();
    renderManualOverrideForm();
    renderPreviewControls();
    renderScheduleEditor();
    renderOverlapWarnings();
    renderThemeTimeline();
    renderPublishStatus();
}

function renderThemeLiveNow() {
    if (!themeStateRow) return;

    const name = themeCatalogByKey[themeStateRow.resolved_theme_key]?.name
        || (themeStateRow.resolved_theme_key === "classic" ? "Classic Jess Bakes" : themeStateRow.resolved_theme_key)
        || "—";

    setText("themeLiveName", name);
    setText("themeLiveReason", formatResolvedReason(themeStateRow.resolved_reason, themeCatalogByKey));
    setText("themeLiveIntensity", themeStateRow.resolved_accent_intensity != null
        ? `${Math.round(themeStateRow.resolved_accent_intensity * 100)}%` : "—");
    setText("themeLiveGraphics", themeStateRow.resolved_graphics_visibility === "minimal" ? "Minimal" : "Normal");
    setText("themeLiveUpdatedAt", themeStateRow.resolved_at
        ? `Last checked: ${new Date(themeStateRow.resolved_at).toLocaleString()}` : "");
}

function renderManualOverrideForm() {
    const select = document.getElementById("themeManualSelect");
    if (select) {
        select.innerHTML = themeCatalog
            .map(row => `<option value="${escapeThemeHtml(row.key)}">${escapeThemeHtml(row.name)}</option>`)
            .join("");
        if (themeStateRow?.manual_theme_key) {
            select.value = themeStateRow.manual_theme_key;
        }
    }
}

function renderPreviewControls() {
    const select = document.getElementById("themePreviewThemeSelect");
    if (select) {
        select.innerHTML = themeCatalog
            .map(row => `<option value="${escapeThemeHtml(row.key)}">${escapeThemeHtml(row.name)}</option>`)
            .join("");
    }
    updateThemePreviewFrame();
}

function renderScheduleEditor() {
    const list = document.getElementById("themeScheduleList");
    if (!list) return;

    if (themeDraftSchedules.length === 0) {
        list.innerHTML = `<p class="field-hint">No schedule entries yet. Use "+ Add Schedule Entry" above.</p>`;
        return;
    }

    list.innerHTML = themeDraftSchedules.map(entry => renderScheduleRowHtml(entry, themeCatalog)).join("");

    list.querySelectorAll(".theme-schedule-row").forEach(rowEl => updateScheduleRowVisibility(rowEl));
}

function renderOverlapWarnings() {
    const container = document.getElementById("themeOverlapWarnings");
    if (!container) return;

    if (typeof window.ThemeSchedule === "undefined") {
        container.innerHTML = "";
        return;
    }

    const overlaps = window.ThemeSchedule.detectOverlaps(themeDraftSchedules, themeCatalogByKey, new Date());

    if (overlaps.length === 0) {
        container.innerHTML = `<div class="admin-inline-message is-success">No overlaps detected among the enabled draft entries.</div>`;
        return;
    }

    container.innerHTML = `<div class="theme-overlap-warning-list">`
        + overlaps.map(o => formatOverlapWarning(o, themeCatalogByKey)).join("")
        + `</div>`;
}

function renderThemeTimeline() {
    const container = document.getElementById("themeTimeline");
    if (!container) return;

    if (typeof window.ThemeSchedule === "undefined") {
        container.innerHTML = "";
        return;
    }

    const months = buildTimelineRows(themeDraftSchedules, themeCatalogByKey, new Date(), 12, window.ThemeSchedule);
    container.innerHTML = months.map(renderTimelineMonthHtml).join("");
}

/** Pure: true when any draft row has been touched more recently than
 *  the last successful Publish -- drives both the "unpublished
 *  changes" banner text and is the natural hook for a future
 *  publish-button-disabled-when-clean affordance. A never-published
 *  state (last_published_at null) with any draft rows present also
 *  counts as having unpublished changes. */
function hasUnpublishedChanges(draftSchedules, stateRow) {
    const draftMaxUpdatedMs = (draftSchedules || []).reduce((max, row) => {
        const t = row.updated_at ? new Date(row.updated_at).getTime() : 0;
        return Math.max(max, t);
    }, 0);

    if (draftMaxUpdatedMs === 0) return false; // no draft rows at all

    const lastPublishedMs = stateRow?.last_published_at ? new Date(stateRow.last_published_at).getTime() : 0;
    return draftMaxUpdatedMs > lastPublishedMs;
}

function renderPublishStatus() {
    const statusEl = document.getElementById("themePublishStatus");
    const lastEl = document.getElementById("themeLastPublished");
    if (!statusEl || !lastEl || !themeStateRow) return;

    statusEl.textContent = hasUnpublishedChanges(themeDraftSchedules, themeStateRow)
        ? "You have unpublished changes."
        : "The draft matches what's currently published.";

    lastEl.textContent = themeStateRow.last_published_at
        ? `Last published: ${new Date(themeStateRow.last_published_at).toLocaleString()}${themeStateRow.last_published_by ? " by " + themeStateRow.last_published_by : ""}`
        : "Never published yet.";
}

/* ==========================================
   PURE / TESTABLE HELPERS
   ========================================== */

/** Turns a theme_state.resolved_reason machine string into the
 *  plain-language explanation shown on the Live Now card. */
function formatResolvedReason(reason, catalogByKey) {
    if (!reason) return "Unknown";
    if (reason === "manual_override") return "Manual override";
    if (reason === "classic:default") return "No holiday or season scheduled";

    const conflictMatch = /^(holiday|season):conflict:(.+)$/.exec(reason);
    if (conflictMatch) {
        const tier = conflictMatch[1];
        const names = conflictMatch[2].split(",").map(k => catalogByKey?.[k]?.name || k).join(" vs. ");
        return `Conflict between ${names} (${tier}) -- fix priorities and republish`;
    }

    const match = /^(holiday|season):(.+)$/.exec(reason);
    if (match) {
        const tierLabel = match[1] === "holiday" ? "Holiday" : "Season";
        const name = catalogByKey?.[match[2]]?.name || match[2];
        return `${tierLabel}: ${name}`;
    }

    return reason;
}

/** Formats one detectOverlaps() pair for display -- blocking pairs
 *  read as an error (Publish will refuse them); non-blocking pairs
 *  read as an informational "X wins" note. */
function formatOverlapWarning(overlap, catalogByKey) {
    const nameA = catalogByKey?.[overlap.a.theme_key]?.name || overlap.a.theme_key;
    const nameB = catalogByKey?.[overlap.b.theme_key]?.name || overlap.b.theme_key;

    if (overlap.blocking) {
        return `<div class="admin-inline-message is-error"><strong>${escapeThemeHtml(nameA)}</strong> and <strong>${escapeThemeHtml(nameB)}</strong> are both enabled at the same priority (${overlap.a.tier_priority}) and their windows may overlap -- Publish will be blocked until you give one a higher priority or disable one.</div>`;
    }

    const winnerName = overlap.a.tier_priority >= overlap.b.tier_priority ? nameA : nameB;
    return `<div class="admin-inline-message is-warning"><strong>${escapeThemeHtml(nameA)}</strong> and <strong>${escapeThemeHtml(nameB)}</strong> overlap -- <strong>${escapeThemeHtml(winnerName)}</strong> wins (higher priority).</div>`;
}

/** Builds `monthsAhead` calendar months of {year, month, label,
 *  segments:[{themeKey, themeName, startPercent, widthPercent}]}
 *  starting from `fromDate`'s month, for the enabled draft entries.
 *  `ThemeSchedule` is passed in (rather than read from a module-level
 *  import) specifically so this stays a pure, dependency-injected
 *  function callable from tests with a stub. */
function buildTimelineRows(entries, catalogByKey, fromDate, monthsAhead, ThemeSchedule) {
    if (!ThemeSchedule) return [];

    const enabled = (entries || []).filter(e => e && e.enabled);
    const rangeStart = fromDate;
    const rangeEnd = new Date(fromDate.getTime());
    rangeEnd.setUTCMonth(rangeEnd.getUTCMonth() + monthsAhead);

    const fromYear = fromDate.getUTCFullYear();
    const candidateYears = [fromYear - 1, fromYear, fromYear + 1, fromYear + 2];

    const segments = [];
    for (const entry of enabled) {
        const catalogRow = catalogByKey?.[entry.theme_key];
        const windows = entry.recurrence_type === "fixed_range"
            ? [ThemeSchedule.resolveScheduleWindow(entry, null)].filter(Boolean)
            : candidateYears.map(year => ThemeSchedule.resolveScheduleWindow(entry, year)).filter(Boolean);

        for (const w of windows) {
            const clippedStart = w.startUtc < rangeStart ? rangeStart : w.startUtc;
            const clippedEnd = w.endUtc > rangeEnd ? rangeEnd : w.endUtc;
            if (clippedStart >= clippedEnd) continue;
            segments.push({
                themeKey: entry.theme_key,
                themeName: catalogRow?.name || entry.theme_key,
                start: clippedStart,
                end: clippedEnd
            });
        }
    }

    // Month BUCKET boundaries must be Europe/Berlin-local midnights,
    // not raw UTC calendar months -- a plain Date.UTC(y, m, 1)
    // boundary sits up to 2 hours (the CET/CEST offset) away from the
    // bakery's actual local month boundary, which let a window ending
    // right at a Berlin month edge visually spill a couple hours into
    // the wrong month's bar. zonedWallTimeToUtc (DST-safe, same as
    // every other instant in this file) fixes that.
    const timeZone = "Europe/Berlin";
    const startParts = ThemeSchedule.zonedParts(fromDate, timeZone);

    const months = [];
    const DAY_MS = 24 * 60 * 60 * 1000;
    let cursorYear = startParts.year;
    let cursorMonth = startParts.month; // 1-12

    for (let i = 0; i < monthsAhead; i++) {
        const nextMonth = cursorMonth === 12 ? 1 : cursorMonth + 1;
        const nextMonthYear = cursorMonth === 12 ? cursorYear + 1 : cursorYear;

        const monthStart = ThemeSchedule.zonedWallTimeToUtc({ year: cursorYear, month: cursorMonth, day: 1, hour: 0, minute: 0 }, timeZone);
        const monthEnd = ThemeSchedule.zonedWallTimeToUtc({ year: nextMonthYear, month: nextMonth, day: 1, hour: 0, minute: 0 }, timeZone);
        const daysInMonth = Math.round((monthEnd - monthStart) / DAY_MS);

        const monthSegments = segments
            .filter(s => s.start < monthEnd && s.end > monthStart)
            .map(s => {
                const segStart = s.start < monthStart ? monthStart : s.start;
                const segEnd = s.end > monthEnd ? monthEnd : s.end;
                const startDay = (segStart - monthStart) / DAY_MS;
                const endDay = (segEnd - monthStart) / DAY_MS;
                return {
                    themeKey: s.themeKey,
                    themeName: s.themeName,
                    startPercent: (startDay / daysInMonth) * 100,
                    widthPercent: Math.max(2, ((endDay - startDay) / daysInMonth) * 100)
                };
            });

        months.push({
            year: cursorYear,
            month: cursorMonth,
            label: monthStart.toLocaleString("en-US", { month: "short", year: "numeric", timeZone }),
            segments: monthSegments
        });

        cursorYear = nextMonthYear;
        cursorMonth = nextMonth;
    }

    return months;
}

const THEME_COLOR_MAP = {
    spring: "#d68fa3", summer: "#e0a63a", autumn: "#b5651d", winter: "#6f95b0",
    new_years: "#b08d2f", valentines: "#c2385a", st_patricks: "#2f7d4f", easter: "#c98ab0",
    fourth_of_july: "#3a5a9c", halloween: "#b5601a", thanksgiving: "#9c5a2a", christmas: "#2f6b45"
};

function themeColorFor(key) {
    return THEME_COLOR_MAP[key] || "#8a6a5a";
}

function renderTimelineMonthHtml(monthRow) {
    const bars = monthRow.segments.map(seg =>
        `<div class="theme-timeline-bar" style="left:${seg.startPercent}%;width:${seg.widthPercent}%;background:${themeColorFor(seg.themeKey)};" title="${escapeThemeHtml(seg.themeName)}">${escapeThemeHtml(seg.themeName)}</div>`
    ).join("");

    return `<div class="theme-timeline-month">
        <div class="theme-timeline-month-label">${escapeThemeHtml(monthRow.label)}</div>
        <div class="theme-timeline-track">${bars}</div>
    </div>`;
}

/* ==========================================
   SCHEDULE ROW MARKUP + FIELD COLLECTION
   ========================================== */

const THEME_MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const THEME_WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const THEME_OCCURRENCE_OPTIONS = [[1, "1st"], [2, "2nd"], [3, "3rd"], [4, "4th"], [5, "5th"], [-1, "Last"]];

function themeMonthSelectHtml(field, selected) {
    return `<select data-field="${field}">` + THEME_MONTH_NAMES.map((name, i) =>
        `<option value="${i + 1}" ${Number(selected) === i + 1 ? "selected" : ""}>${name}</option>`
    ).join("") + `</select>`;
}

function themeWeekdaySelectHtml(field, selected) {
    return `<select data-field="${field}">` + THEME_WEEKDAY_NAMES.map((name, i) =>
        `<option value="${i}" ${Number(selected) === i ? "selected" : ""}>${name}</option>`
    ).join("") + `</select>`;
}

function themeOccurrenceSelectHtml(field, selected) {
    return `<select data-field="${field}">` + THEME_OCCURRENCE_OPTIONS.map(([value, label]) =>
        `<option value="${value}" ${Number(selected) === value ? "selected" : ""}>${label}</option>`
    ).join("") + `</select>`;
}

function renderScheduleRowHtml(entry, catalog) {
    const themeOptions = catalog
        .filter(row => row.key !== "classic")
        .map(row => `<option value="${escapeThemeHtml(row.key)}" ${row.key === entry.theme_key ? "selected" : ""}>${escapeThemeHtml(row.name)}</option>`)
        .join("");

    return `
    <div class="theme-schedule-row${entry.enabled ? "" : " is-disabled"}" data-row-id="${entry.id}">

        <div class="theme-schedule-row-header">
            <h3>${escapeThemeHtml(entry.label || "Untitled")}</h3>
            <label class="toggle-switch">
                <input type="checkbox" data-field="enabled" ${entry.enabled ? "checked" : ""}>
                <span class="toggle-track"></span> Enabled
            </label>
        </div>

        <div class="theme-schedule-field-grid">
            <div class="form-group"><label>Theme<select data-field="theme_key">${themeOptions}</select></label></div>
            <div class="form-group"><label>Label<input type="text" data-field="label" value="${escapeThemeHtml(entry.label || "")}"></label></div>
            <div class="form-group"><label>Recurrence<select data-field="recurrence_type">
                <option value="fixed_range" ${entry.recurrence_type === "fixed_range" ? "selected" : ""}>One-time date range</option>
                <option value="annual_fixed" ${entry.recurrence_type === "annual_fixed" ? "selected" : ""}>Annual fixed dates</option>
                <option value="annual_rule" ${entry.recurrence_type === "annual_rule" ? "selected" : ""}>Annual rule (Nth weekday / Easter)</option>
            </select></label></div>
            <div class="form-group"><label>Priority (higher wins ties)<input type="number" data-field="tier_priority" value="${entry.tier_priority ?? 0}"></label></div>
        </div>

        <div class="theme-schedule-field-grid" data-group="fixed_range">
            <div class="form-group"><label>Start<input type="datetime-local" data-field="fixed_start" value="${themeToLocalInputValue(entry.fixed_start)}"></label></div>
            <div class="form-group"><label>End<input type="datetime-local" data-field="fixed_end" value="${themeToLocalInputValue(entry.fixed_end)}"></label></div>
        </div>

        <div class="theme-schedule-field-grid" data-group="annual_fixed">
            <div class="form-group"><label>Start month${themeMonthSelectHtml("annual_start_month", entry.annual_start_month)}</label></div>
            <div class="form-group"><label>Start day<input type="number" min="1" max="31" data-field="annual_start_day" value="${entry.annual_start_day ?? ""}"></label></div>
            <div class="form-group"><label>End month${themeMonthSelectHtml("annual_end_month", entry.annual_end_month)}</label></div>
            <div class="form-group"><label>End day<input type="number" min="1" max="31" data-field="annual_end_day" value="${entry.annual_end_day ?? ""}"></label></div>
        </div>

        <div class="theme-schedule-field-grid" data-group="annual_rule">
            <div class="form-group"><label>Rule<select data-field="rule_kind">
                <option value="nth_weekday_offset" ${entry.rule_kind === "nth_weekday_offset" ? "selected" : ""}>Nth weekday of month (e.g. Thanksgiving)</option>
                <option value="easter_offset" ${entry.rule_kind === "easter_offset" ? "selected" : ""}>Easter Sunday</option>
            </select></label></div>
            <div class="form-group" data-group="nth_weekday_fields"><label>Month${themeMonthSelectHtml("rule_month", entry.rule_month)}</label></div>
            <div class="form-group" data-group="nth_weekday_fields"><label>Weekday${themeWeekdaySelectHtml("rule_weekday", entry.rule_weekday)}</label></div>
            <div class="form-group" data-group="nth_weekday_fields"><label>Occurrence${themeOccurrenceSelectHtml("rule_occurrence", entry.rule_occurrence)}</label></div>
            <div class="form-group"><label>Window start offset (days, e.g. -7)<input type="number" data-field="window_start_offset_days" value="${entry.window_start_offset_days ?? 0}"></label></div>
            <div class="form-group"><label>Window end offset (days)<input type="number" data-field="window_end_offset_days" value="${entry.window_end_offset_days ?? 0}"></label></div>
        </div>

        <div class="theme-schedule-field-grid">
            <div class="form-group"><label>Start time (local)<input type="time" data-field="start_time_local" value="${entry.start_time_local || "00:00"}"></label></div>
            <div class="form-group"><label>End time (local)<input type="time" data-field="end_time_local" value="${entry.end_time_local || "23:59"}"></label></div>
            <div class="form-group"><label>Accent intensity<input type="range" min="0.4" max="1" step="0.05" data-field="accent_intensity" value="${entry.accent_intensity ?? 1}"></label></div>
            <div class="form-group"><label>Graphics<select data-field="graphics_visibility">
                <option value="normal" ${entry.graphics_visibility !== "minimal" ? "selected" : ""}>Normal</option>
                <option value="minimal" ${entry.graphics_visibility === "minimal" ? "selected" : ""}>Minimal</option>
            </select></label></div>
        </div>

        <div class="form-group"><label>Notes<textarea data-field="notes" rows="2">${escapeThemeHtml(entry.notes || "")}</textarea></label></div>

        <div class="theme-schedule-row-footer theme-action-row">
            <button type="button" class="secondary-btn" data-action="delete">Delete</button>
            <button type="button" class="primary-btn" data-action="save">Save Row</button>
            <span class="theme-action-feedback" data-role="feedback"></span>
        </div>

    </div>`;
}

function updateScheduleRowVisibility(rowEl) {
    if (!rowEl) return;

    const recurrenceType = rowEl.querySelector('[data-field="recurrence_type"]')?.value;
    rowEl.querySelectorAll('[data-group="fixed_range"], [data-group="annual_fixed"], [data-group="annual_rule"]').forEach(el => {
        el.hidden = el.dataset.group !== recurrenceType;
    });

    const ruleKind = rowEl.querySelector('[data-field="rule_kind"]')?.value;
    rowEl.querySelectorAll('[data-group="nth_weekday_fields"]').forEach(el => {
        el.hidden = ruleKind !== "nth_weekday_offset";
    });
}

function collectScheduleRowPayload(rowEl) {
    const getField = (name) => rowEl.querySelector(`[data-field="${name}"]`);
    const recurrenceType = getField("recurrence_type").value;
    const ruleKind = getField("rule_kind")?.value || null;

    const payload = {
        theme_key: getField("theme_key").value,
        label: getField("label").value.trim() || "Untitled",
        enabled: getField("enabled").checked,
        recurrence_type: recurrenceType,
        start_time_local: getField("start_time_local").value || "00:00",
        end_time_local: getField("end_time_local").value || "23:59",
        tier_priority: Number(getField("tier_priority").value) || 0,
        accent_intensity: Number(getField("accent_intensity").value) || 1,
        graphics_visibility: getField("graphics_visibility").value,
        notes: getField("notes").value.trim() || null,
        fixed_start: null, fixed_end: null,
        annual_start_month: null, annual_start_day: null, annual_end_month: null, annual_end_day: null,
        rule_kind: null, rule_month: null, rule_weekday: null, rule_occurrence: null,
        window_start_offset_days: 0, window_end_offset_days: 0
    };

    if (recurrenceType === "fixed_range") {
        payload.fixed_start = themeToIsoOrNull(getField("fixed_start").value);
        payload.fixed_end = themeToIsoOrNull(getField("fixed_end").value);
    } else if (recurrenceType === "annual_fixed") {
        payload.annual_start_month = Number(getField("annual_start_month").value) || null;
        payload.annual_start_day = Number(getField("annual_start_day").value) || null;
        payload.annual_end_month = Number(getField("annual_end_month").value) || null;
        payload.annual_end_day = Number(getField("annual_end_day").value) || null;
    } else if (recurrenceType === "annual_rule") {
        payload.rule_kind = ruleKind;
        payload.window_start_offset_days = Number(getField("window_start_offset_days").value) || 0;
        payload.window_end_offset_days = Number(getField("window_end_offset_days").value) || 0;
        if (ruleKind === "nth_weekday_offset") {
            payload.rule_month = Number(getField("rule_month").value) || null;
            payload.rule_weekday = Number(getField("rule_weekday").value);
            payload.rule_occurrence = Number(getField("rule_occurrence").value) || null;
        }
    }

    return payload;
}

/* ==========================================
   EVENT WIRING
   ========================================== */

function wireThemeScheduleListEvents() {
    const list = document.getElementById("themeScheduleList");
    if (!list) return;

    list.addEventListener("change", (event) => {
        const field = event.target.dataset.field;
        const rowEl = event.target.closest(".theme-schedule-row");
        if (!rowEl) return;

        if (field === "recurrence_type" || field === "rule_kind") {
            updateScheduleRowVisibility(rowEl);
        }
        if (field === "enabled") {
            rowEl.classList.toggle("is-disabled", !event.target.checked);
        }
    });

    list.addEventListener("click", async (event) => {
        const action = event.target.dataset.action;
        if (!action) return;
        const rowEl = event.target.closest(".theme-schedule-row");
        const rowId = rowEl?.dataset.rowId;

        if (action === "save") {
            await saveScheduleRow(rowEl, rowId, event.target);
        } else if (action === "delete") {
            await deleteScheduleRow(rowId, event.target);
        }
    });

    document.getElementById("themeAddScheduleBtn")?.addEventListener("click", addScheduleRow);
}

function wireThemePreviewEvents() {
    ["themePreviewPageSelect", "themePreviewThemeSelect", "themePreviewIntensity", "themePreviewGraphics"].forEach(id => {
        document.getElementById(id)?.addEventListener("input", updateThemePreviewFrame);
        document.getElementById(id)?.addEventListener("change", updateThemePreviewFrame);
    });

    document.getElementById("themePreviewMobileBtn")?.addEventListener("click", () => {
        document.getElementById("themePreviewFrame")?.classList.add("is-mobile-preview");
    });
    document.getElementById("themePreviewDesktopBtn")?.addEventListener("click", () => {
        document.getElementById("themePreviewFrame")?.classList.remove("is-mobile-preview");
    });
}

function wireThemeActionEvents() {
    document.getElementById("themeManualActivateBtn")?.addEventListener("click", activateManualOverride);
    document.getElementById("themeReturnAutoBtn")?.addEventListener("click", returnToAutomaticSchedule);
    document.getElementById("themeSetClassicBtn")?.addEventListener("click", setClassicNow);
    document.getElementById("themePublishBtn")?.addEventListener("click", publishThemeSchedule);
    document.getElementById("themeDiscardBtn")?.addEventListener("click", discardThemeDraft);
}

function updateThemePreviewFrame() {
    const frame = document.getElementById("themePreviewFrame");
    if (!frame) return;

    const page = document.getElementById("themePreviewPageSelect")?.value || "index.html";
    const key = document.getElementById("themePreviewThemeSelect")?.value || "classic";
    const intensity = document.getElementById("themePreviewIntensity")?.value || "1";
    const graphics = document.getElementById("themePreviewGraphics")?.value || "normal";

    const params = new URLSearchParams({ themePreview: key, intensity, graphics });
    frame.src = `../${page}?${params.toString()}`;
}

/* ==========================================
   ACTIONS
   ========================================== */

async function triggerThemeSchedulerCheck() {
    try {
        await supabaseClient.functions.invoke("theme-scheduler", { body: {} });
    } catch (err) {
        // Non-fatal -- the cron job re-checks every 5 minutes
        // regardless; this is just an instant-feedback nicety after a
        // manual admin action.
        console.error(err);
    }
}

async function activateManualOverride() {
    if (themeManualActivateInFlight || !themeStateRow) return;
    themeManualActivateInFlight = true;

    const feedback = withThemeButtonFeedback("themeManualActivateBtn", "themeManualActivateFeedback", "Activating…");
    feedback.start();

    try {
        const key = document.getElementById("themeManualSelect")?.value;
        const endsAtLocal = document.getElementById("themeManualEndsAt")?.value;

        const { error } = await supabaseClient.from("theme_state").update({
            manual_theme_key: key,
            manual_started_at: new Date().toISOString(),
            manual_ends_at: themeToIsoOrNull(endsAtLocal)
        }).eq("id", themeStateRow.id);

        if (error) {
            console.error(error);
            feedback.error("Couldn't activate. Please try again.");
            return;
        }

        feedback.success("Activated.");
        await triggerThemeSchedulerCheck();
        await loadThemeAdminData();
    } finally {
        themeManualActivateInFlight = false;
    }
}

async function clearManualOverride(nextThemeKey) {
    if (themeManualClearInFlight || !themeStateRow) return;
    themeManualClearInFlight = true;

    const feedback = withThemeButtonFeedback(
        nextThemeKey === "classic" ? "themeSetClassicBtn" : "themeReturnAutoBtn",
        "themeManualClearFeedback",
        "Working…"
    );
    feedback.start();

    try {
        const payload = nextThemeKey === "classic"
            ? { manual_theme_key: "classic", manual_started_at: new Date().toISOString(), manual_ends_at: null }
            : { manual_theme_key: null, manual_started_at: null, manual_ends_at: null };

        const { error } = await supabaseClient.from("theme_state").update(payload).eq("id", themeStateRow.id);

        if (error) {
            console.error(error);
            feedback.error("Couldn't update. Please try again.");
            return;
        }

        feedback.success(nextThemeKey === "classic" ? "Set to Classic." : "Back to automatic scheduling.");
        await triggerThemeSchedulerCheck();
        await loadThemeAdminData();
    } finally {
        themeManualClearInFlight = false;
    }
}

function returnToAutomaticSchedule() {
    return clearManualOverride(null);
}

function setClassicNow() {
    return clearManualOverride("classic");
}

async function saveScheduleRow(rowEl, rowId, buttonEl) {
    if (!rowEl || !rowId) return;

    const feedbackEl = rowEl.querySelector('[data-role="feedback"]');
    setThemeInlineFeedback(feedbackEl, "loading", "Saving…");
    buttonEl.disabled = true;

    try {
        const payload = collectScheduleRowPayload(rowEl);
        const { error } = await supabaseClient.from("theme_schedules").update(payload).eq("id", rowId);

        if (error) {
            console.error(error);
            setThemeInlineFeedback(feedbackEl, "error", "Couldn't save. Please try again.");
            return;
        }

        setThemeInlineFeedback(feedbackEl, "success", "Saved.");
        await loadThemeAdminData();
    } finally {
        buttonEl.disabled = false;
    }
}

async function deleteScheduleRow(rowId, buttonEl) {
    if (!rowId) return;
    if (!confirm("Delete this schedule entry? This can't be undone (it has no live effect until you Publish).")) return;

    buttonEl.disabled = true;
    try {
        const { error } = await supabaseClient.from("theme_schedules").delete().eq("id", rowId);
        if (error) {
            console.error(error);
            showThemeMessage("Couldn't delete that entry. Please try again.", "error");
            return;
        }
        await loadThemeAdminData();
    } finally {
        buttonEl.disabled = false;
    }
}

async function addScheduleRow() {
    const defaultThemeKey = themeCatalog.find(row => row.key !== "classic")?.key;
    if (!defaultThemeKey) return;

    const { error } = await supabaseClient.from("theme_schedules").insert({
        theme_key: defaultThemeKey,
        label: `${themeCatalogByKey[defaultThemeKey]?.name || defaultThemeKey} schedule`,
        recurrence_type: "annual_fixed",
        annual_start_month: 1, annual_start_day: 1, annual_end_month: 1, annual_end_day: 7
    });

    if (error) {
        console.error(error);
        showThemeMessage("Couldn't add a new schedule entry. Please try again.", "error");
        return;
    }

    await loadThemeAdminData();
}

async function publishThemeSchedule() {
    if (themePublishInFlight) return;
    themePublishInFlight = true;

    const feedback = withThemeButtonFeedback("themePublishBtn", "themePublishFeedback", "Publishing…");
    feedback.start();

    try {
        const { data, error } = await supabaseClient.rpc("publish_theme_schedule");

        if (error) {
            console.error(error);
            feedback.error(error.message || "Publish failed -- fix any blocking overlaps and try again.");
            return;
        }

        const count = data?.publishedCount ?? 0;
        feedback.success(`Published ${count} schedule ${count === 1 ? "entry" : "entries"}.`);
        await triggerThemeSchedulerCheck();
        await loadThemeAdminData();
    } finally {
        themePublishInFlight = false;
    }
}

async function discardThemeDraft() {
    if (themeDiscardInFlight) return;
    if (!confirm("Discard every unpublished change and reload the draft from what's currently published?")) return;

    themeDiscardInFlight = true;
    const feedback = withThemeButtonFeedback("themeDiscardBtn", "themeDiscardFeedback", "Discarding…");
    feedback.start();

    try {
        const { error } = await supabaseClient.rpc("discard_theme_schedule_draft");

        if (error) {
            console.error(error);
            feedback.error("Couldn't discard. Please try again.");
            return;
        }

        feedback.success("Draft reset to match what's published.");
        await loadThemeAdminData();
    } finally {
        themeDiscardInFlight = false;
    }
}

/* ==========================================
   SMALL DOM HELPERS
   ========================================== */

function showThemeMessage(text, kind) {
    const el = document.getElementById("themeAdminMessage");
    if (!el) return;
    el.textContent = text;
    el.className = `admin-inline-message is-${kind}`;
    el.style.display = "block";
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function setThemeInlineFeedback(el, kind, text) {
    if (!el) return;
    el.textContent = text || "";
    el.className = `theme-action-feedback${text ? ` is-${kind}` : ""}`;
}

/** Same shape/contract as admin-vacation.js's withButtonFeedback --
 *  see that file's comment for the double-click-guard reasoning. */
function withThemeButtonFeedback(buttonId, feedbackId, busyLabel) {
    const button = document.getElementById(buttonId);
    const idleLabel = button ? button.textContent : "";
    const feedbackEl = document.getElementById(feedbackId);

    return {
        start() {
            if (button) { button.disabled = true; button.textContent = busyLabel; }
            setThemeInlineFeedback(feedbackEl, "loading", "Working…");
        },
        success(message) {
            if (button) { button.disabled = false; button.textContent = idleLabel; }
            setThemeInlineFeedback(feedbackEl, "success", message);
        },
        error(message) {
            if (button) { button.disabled = false; button.textContent = idleLabel; }
            setThemeInlineFeedback(feedbackEl, "error", message);
        }
    };
}

function themeToIsoOrNull(localValue) {
    if (!localValue) return null;
    const date = new Date(localValue);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function themeToLocalInputValue(iso) {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function escapeThemeHtml(text) {
    return String(text ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}
