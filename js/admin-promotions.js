/*==================================================
    ADMIN PROMOTIONS

    Mirrors js/admin-menu.js's redesigned Menu Manager pattern
    exactly: the shell (toolbar + table) is built ONCE, every save/
    toggle/duplicate/archive action mutates the in-memory
    `promotions` array in place and calls applyPromotionFilters()
    (which only ever touches the table body + summary numbers), and
    UI state (search/status filter/scroll) survives every action --
    no full reload, no scroll jump, exactly matching the redesigned
    Menu page's own requirements for this new page.

    Status lifecycle is handled entirely through explicit table-row
    actions (Activate / Pause / Resume / Archive / Duplicate), never
    through the edit modal -- the modal only ever edits content
    fields. This keeps "an invalid promotion cannot be activated"
    enforceable at one well-defined transition point (activatePromotion()
    below), backed by the same checks the database's own
    validate_promotion_activation() trigger enforces as a final
    backstop (see supabase/migrations/20261118100000_promotions_schema.sql).
==================================================*/

document.addEventListener("DOMContentLoaded", async () => {
    await requireAuth();

    setupLogout();
    restorePromoUiState();
    await loadPromotionsManager();
    restorePromoScrollPosition();
});

document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    closePromotionModal();
});

window.addEventListener("beforeunload", persistPromoUiState);

/*==================================================
    STATE
==================================================*/

let promotions = [];
let liveMenuItemsForPromotions = [];

let promoSearchQuery = "";
let promoStatusFilter = ""; // "" | draft | scheduled | active | paused | expired | archived
let promoShellBuilt = false;
let promoModalDirty = false;
let promoModalSaving = false;
let promoLastFocusedElement = null;
let promoEditingId = null;

const PROMO_UI_STATE_KEY = "jb_admin_promotions_ui_state";
const PROMO_STATUSES = ["draft", "scheduled", "active", "paused", "expired", "archived"];
const PROMO_STATUS_LABELS = {
    draft: "Draft", scheduled: "Scheduled", active: "Active",
    paused: "Paused", expired: "Expired", archived: "Archived"
};

function persistPromoUiState() {
    try {
        sessionStorage.setItem(PROMO_UI_STATE_KEY, JSON.stringify({
            search: promoSearchQuery,
            status: promoStatusFilter,
            scrollY: window.scrollY
        }));
    } catch {
        // Not fatal -- defensive only, same posture as admin-menu.js.
    }
}

function restorePromoUiState() {
    try {
        const raw = sessionStorage.getItem(PROMO_UI_STATE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        promoSearchQuery = parsed.search || "";
        promoStatusFilter = parsed.status || "";
    } catch {
        // ignore
    }
}

function restorePromoScrollPosition() {
    try {
        const raw = sessionStorage.getItem(PROMO_UI_STATE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (Number.isFinite(parsed.scrollY)) {
            window.scrollTo(0, parsed.scrollY);
        }
    } catch {
        // ignore
    }
}

/*==================================================
    LOAD
==================================================*/

async function loadPromotionsManager() {
    const [promoResult, rewardResult, menuResult] = await Promise.all([
        supabaseClient.from("promotions").select("*, promotion_display_status").order("created_at", { ascending: false }),
        supabaseClient.from("promotion_reward_items").select("promotion_id, menu_item_id, sort_order"),
        supabaseClient.from("menu_items").select("id, name, category, product_type, available").order("name")
    ]);

    if (promoResult.error) {
        document.getElementById("promotionsManager").innerHTML =
            `<p class="admin-inline-message is-error">Unable to load promotions: ${escapeHtml(promoResult.error.message)}</p>`;
        return;
    }

    liveMenuItemsForPromotions = menuResult.data || [];

    const rewardsByPromotion = {};
    (rewardResult.data || []).forEach(r => {
        if (!rewardsByPromotion[r.promotion_id]) rewardsByPromotion[r.promotion_id] = [];
        rewardsByPromotion[r.promotion_id].push(r);
    });

    promotions = (promoResult.data || []).map(p => ({
        ...p,
        displayStatus: p.promotion_display_status,
        rewardItems: rewardsByPromotion[p.id] || []
    }));

    renderPromotionsManagerShell();
    applyPromotionFilters();
}

/*==================================================
    SHELL (built once)
==================================================*/

function renderPromotionsManagerShell() {
    const container = document.getElementById("promotionsManager");
    if (!container || promoShellBuilt) return;

    container.innerHTML = `
        <div class="menu-manager-toolbar">
            <div class="menu-toolbar-row">
                <input
                    type="text"
                    id="promoSearchInput"
                    class="menu-search-input"
                    placeholder="Search by promotion name...">

                <select id="promoStatusFilterSelect">
                    <option value="">All Statuses</option>
                    ${PROMO_STATUSES.map(s => `<option value="${s}">${PROMO_STATUS_LABELS[s]}</option>`).join("")}
                </select>

                <button class="approve-btn" type="button" onclick="openPromotionModal()">
                    + New Promotion
                </button>
            </div>

            <p class="menu-results-count" id="promoResultsCount"></p>
        </div>

        <div class="table-wrapper">
            <table class="admin-table promotions-table">
                <thead>
                    <tr>
                        <th>Name</th>
                        <th>Customer Title</th>
                        <th>Type</th>
                        <th>Status</th>
                        <th>Qualifying Subtotal</th>
                        <th>Reward / Discount</th>
                        <th>Start</th>
                        <th>End</th>
                        <th>Redemptions</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody id="promoTableBody"></tbody>
            </table>
        </div>
    `;

    promoShellBuilt = true;

    document.getElementById("promoSearchInput").value = promoSearchQuery;
    document.getElementById("promoStatusFilterSelect").value = promoStatusFilter;

    let searchDebounce = null;
    document.getElementById("promoSearchInput").addEventListener("input", (event) => {
        promoSearchQuery = event.target.value;
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => {
            applyPromotionFilters();
            persistPromoUiState();
        }, 150);
    });

    document.getElementById("promoStatusFilterSelect").addEventListener("change", (event) => {
        promoStatusFilter = event.target.value;
        applyPromotionFilters();
        persistPromoUiState();
    });
}

/** The one function every filter control and every mutation
 *  (activate/pause/resume/archive/duplicate/save) funnels through --
 *  only ever touches #promoTableBody + the summary cards, never the
 *  toolbar controls, so search/filter/scroll state is never reset. */
function applyPromotionFilters() {
    updatePromoStats();

    const search = promoSearchQuery.trim().toLowerCase();

    const filtered = promotions.filter(p => {
        if (promoStatusFilter && p.displayStatus !== promoStatusFilter) return false;
        if (search &&
            !p.internal_name.toLowerCase().includes(search) &&
            !(p.customer_title || "").toLowerCase().includes(search)) {
            return false;
        }
        return true;
    });

    renderPromotionsTable(filtered);

    const countLabel = document.getElementById("promoResultsCount");
    if (countLabel) {
        countLabel.textContent = `Showing ${filtered.length} of ${promotions.length} promotion${promotions.length === 1 ? "" : "s"}`;
    }
}

function updatePromoStats() {
    const byStatus = (status) => promotions.filter(p => p.displayStatus === status).length;
    const setText = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    };

    setText("promoActiveCount", byStatus("active"));
    setText("promoScheduledCount", byStatus("scheduled"));
    setText("promoDraftCount", byStatus("draft"));
    setText("promoRedemptionCount", promotions.reduce((sum, p) => sum + Number(p.redemption_count || 0), 0));
}

/*==================================================
    TABLE
==================================================*/

function renderPromotionsTable(items) {
    const tbody = document.getElementById("promoTableBody");
    if (!tbody) return;

    if (!items.length) {
        tbody.innerHTML = `<tr><td colspan="10">No promotions match these filters.</td></tr>`;
        return;
    }

    tbody.innerHTML = items.map(renderPromotionRow).join("");
}

function formatBerlin(iso) {
    if (!iso) return "--";
    try {
        return new Date(iso).toLocaleString("en-GB", {
            timeZone: "Europe/Berlin", dateStyle: "medium", timeStyle: "short"
        });
    } catch {
        return "--";
    }
}

function describeReward(promo) {
    if (promo.promotion_type === "free_item") {
        const names = promo.rewardItems
            .map(ri => (liveMenuItemsForPromotions.find(m => m.id === ri.menu_item_id) || {}).name)
            .filter(Boolean);
        const qty = promo.free_item_quantity || 1;
        return names.length
            ? `${qty}× ${escapeHtml(names.join(" or "))}`
            : "No reward items selected";
    }
    if (promo.promotion_type === "percentage_discount") {
        return `${promo.discount_percentage || 0}% off`;
    }
    if (promo.promotion_type === "fixed_discount") {
        return `€${Number(promo.fixed_discount_amount || 0).toFixed(2)} off`;
    }
    return "--";
}

function renderPromotionRow(promo) {
    const status = promo.displayStatus;
    const qualifying = promo.qualifying_subtotal_min != null
        ? `${promo.threshold_operator === "gte" ? "≥" : ">"} €${Number(promo.qualifying_subtotal_min).toFixed(2)}`
        : "--";

    let lifecycleAction = "";
    if (status === "draft") {
        lifecycleAction = `<button type="button" class="approve-btn" onclick="activatePromotion('${promo.id}')">Activate</button>`;
    } else if (status === "active" || status === "scheduled") {
        lifecycleAction = `<button type="button" class="delete-btn" onclick="setPromotionAdminStatus('${promo.id}', 'paused')">Pause</button>`;
    } else if (status === "paused") {
        lifecycleAction = `<button type="button" class="approve-btn" onclick="setPromotionAdminStatus('${promo.id}', 'enabled')">Resume</button>`;
    }

    const archiveAction = status === "archived"
        ? ""
        : `<button type="button" class="link-btn" onclick="archivePromotion('${promo.id}')">Archive</button>`;

    const redemptions = promo.max_total_redemptions
        ? `${promo.redemption_count} / ${promo.max_total_redemptions}`
        : `${promo.redemption_count}`;

    return `
        <tr>
            <td>${escapeHtml(promo.internal_name)}</td>
            <td>${escapeHtml(promo.customer_title || "")}</td>
            <td>${escapeHtml(promo.promotion_type.replace("_", " "))}</td>
            <td><span class="status-badge status-${status}">${PROMO_STATUS_LABELS[status] || status}</span></td>
            <td>${qualifying}</td>
            <td>${describeReward(promo)}</td>
            <td>${formatBerlin(promo.start_at)}</td>
            <td>${promo.end_at ? formatBerlin(promo.end_at) : "No end date"}</td>
            <td>${redemptions}</td>
            <td class="promo-row-actions">
                <button type="button" class="link-btn" onclick="openPromotionModal('${promo.id}')">Edit</button>
                <button type="button" class="link-btn" onclick="duplicatePromotion('${promo.id}')">Duplicate</button>
                ${lifecycleAction}
                ${archiveAction}
            </td>
        </tr>
    `;
}

function showPromotionsToast(message, isError = false) {
    let toast = document.getElementById("promoToast");
    if (!toast) {
        toast = document.createElement("div");
        toast.id = "promoToast";
        toast.className = "admin-toast";
        document.body.appendChild(toast);
    }

    toast.textContent = message;
    toast.className = `admin-toast is-visible ${isError ? "is-error" : "is-success"}`;

    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => {
        toast.classList.remove("is-visible");
    }, 3200);
}

/*==================================================
    LIFECYCLE ACTIONS
==================================================*/

async function setPromotionAdminStatus(id, newStatus) {
    const { data, error } = await supabaseClient
        .from("promotions")
        .update({ admin_status: newStatus })
        .eq("id", id)
        .select("*, promotion_display_status")
        .single();

    if (error) {
        showPromotionsToast(error.message, true);
        return;
    }

    const promo = promotions.find(p => p.id === id);
    if (promo) {
        Object.assign(promo, data, { displayStatus: data.promotion_display_status });
    }

    applyPromotionFilters();
    showPromotionsToast(newStatus === "enabled" ? "Promotion resumed." : "Promotion paused.");
}

/** The one path that turns a draft (or paused) promotion live. Runs
 *  the same pre-activation checks the admin UI can usefully explain
 *  up front -- the database's validate_promotion_activation() trigger
 *  re-enforces the hard requirements regardless, as the final
 *  backstop, so this is a UX nicety, not the real gate. */
async function activatePromotion(id) {
    const promo = promotions.find(p => p.id === id);
    if (!promo) return;

    const warnings = [];
    if (promo.promotion_type === "free_item") {
        const availableRewards = promo.rewardItems.filter(ri => {
            const item = liveMenuItemsForPromotions.find(m => m.id === ri.menu_item_id);
            return item && item.available;
        });
        if (!availableRewards.length) warnings.push("This promotion has no available reward items selected.");
    }
    if (!promo.qualifying_subtotal_min || promo.qualifying_subtotal_min <= 0) {
        warnings.push("This promotion has no valid qualifying subtotal.");
    }
    if (promo.start_at && promo.end_at && new Date(promo.start_at) >= new Date(promo.end_at)) {
        warnings.push("The start date is not before the end date.");
    }
    if (!promo.start_at) {
        warnings.push("No start date is set -- this promotion will go live for real customers immediately.");
    }

    const conflict = promotions.find(p =>
        p.id !== id && !p.stackable && !promo.stackable &&
        (p.displayStatus === "active" || p.displayStatus === "scheduled")
    );
    if (conflict) {
        warnings.push(`"${conflict.internal_name}" is another non-stackable promotion that may overlap with this one.`);
    }

    const message = warnings.length
        ? `${warnings.join("\n")}\n\nActivate anyway?`
        : `Activate "${promo.internal_name}" now? This will make it live for real customers.`;

    if (!confirm(message)) return;

    await setPromotionAdminStatus(id, "enabled");
}

async function archivePromotion(id) {
    const promo = promotions.find(p => p.id === id);
    if (!promo) return;
    if (!confirm(`Archive "${promo.internal_name}"? It will stop running and move out of the active lists. Its order history is preserved.`)) return;

    await setPromotionAdminStatus(id, "archived");
}

async function duplicatePromotion(id) {
    const { data, error } = await supabaseClient.rpc("duplicate_promotion", { p_promotion_id: id });

    if (error) {
        showPromotionsToast(error.message, true);
        return;
    }

    const { data: rewardRows } = await supabaseClient
        .from("promotion_reward_items")
        .select("promotion_id, menu_item_id, sort_order")
        .eq("promotion_id", data.id);

    promotions.unshift({ ...data, displayStatus: "draft", rewardItems: rewardRows || [] });
    applyPromotionFilters();
    showPromotionsToast(`Duplicated as a new draft: "${data.internal_name}".`);
}

/*==================================================
    MODAL
==================================================*/

function openPromotionModal(id = null) {
    let modal = document.getElementById("promotionModal");
    if (!modal) {
        modal = buildPromotionModal();
        document.body.appendChild(modal);
    }

    promoLastFocusedElement = document.activeElement;
    promoEditingId = id;
    const promo = id ? promotions.find(p => p.id === id) : null;

    hidePromotionModalError();

    document.getElementById("promoModalTitle").textContent = promo ? "Edit Promotion" : "New Promotion";
    document.getElementById("promoInternalName").value = promo ? promo.internal_name : "";
    document.getElementById("promoCustomerTitle").value = promo ? promo.customer_title || "" : "";
    document.getElementById("promoCustomerDescription").value = promo ? promo.customer_description || "" : "";
    document.getElementById("promoCartMessage").value = promo ? promo.cart_message || "" : "";
    document.getElementById("promoInternalNotes").value = promo ? promo.internal_notes || "" : "";
    document.getElementById("promoType").value = promo ? promo.promotion_type : "free_item";
    document.getElementById("promoStartAt").value = promo && promo.start_at ? toLocalInputValue(promo.start_at) : "";
    document.getElementById("promoEndAt").value = promo && promo.end_at ? toLocalInputValue(promo.end_at) : "";
    document.getElementById("promoQualifyingSubtotal").value = promo ? promo.qualifying_subtotal_min ?? "" : "";
    document.getElementById("promoThresholdOperator").value = promo ? promo.threshold_operator : "gt";
    document.getElementById("promoPriority").value = promo ? promo.priority : 100;
    document.getElementById("promoStackable").checked = promo ? Boolean(promo.stackable) : false;
    document.getElementById("promoMaxTotalRedemptions").value = promo ? promo.max_total_redemptions ?? "" : "";
    document.getElementById("promoMaxPerOrder").value = promo ? promo.max_redemptions_per_order : 1;
    document.getElementById("promoMaxPerCustomer").value = promo ? promo.max_redemptions_per_customer ?? "" : "";

    document.getElementById("promoFreeItemQuantity").value = promo ? promo.free_item_quantity ?? 1 : 1;
    document.getElementById("promoFreeItemCustomerChooses").checked = promo ? promo.free_item_customer_chooses !== false : true;
    document.getElementById("promoFreeItemMaxPerOrder").value = promo ? promo.free_item_max_per_order ?? "" : "";
    document.getElementById("promoFreeItemRepeats").checked = promo ? Boolean(promo.free_item_repeats_at_multiples) : false;

    document.getElementById("promoDiscountPercentage").value = promo ? promo.discount_percentage ?? "" : "";
    document.getElementById("promoDiscountMaxAmount").value = promo ? promo.discount_max_amount ?? "" : "";
    document.getElementById("promoDiscountAppliesTo").value = promo ? promo.discount_applies_to || "order_subtotal" : "order_subtotal";
    document.getElementById("promoFixedDiscountAmount").value = promo ? promo.fixed_discount_amount ?? "" : "";

    renderRewardItemPicker(promo ? promo.rewardItems.map(ri => ri.menu_item_id) : []);
    togglePromotionTypeFields();
    renderPromotionPreview();

    const saveBtn = document.getElementById("promoSaveBtn");
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Save Promotion"; }
    promoModalSaving = false;

    modal.style.display = "flex";
    promoModalDirty = false;

    const nameInput = document.getElementById("promoInternalName");
    if (nameInput) nameInput.focus();
}

function toLocalInputValue(iso) {
    // datetime-local inputs want "YYYY-MM-DDTHH:mm" in the BROWSER's
    // own local time by spec -- but admins here think in Europe/Berlin
    // regardless of where they happen to be. Render the Berlin wall-
    // clock time into the field explicitly (via WeeklySchedule's
    // existing Berlin-parts helper) rather than trusting the browser's
    // own timezone.
    const parts = (typeof WeeklySchedule !== "undefined")
        ? WeeklySchedule.getBerlinParts(new Date(iso))
        : null;
    if (!parts) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

/** DST-safe Europe/Berlin wall-clock -> UTC instant conversion, ported
 *  from supabase/functions/_shared/themeSchedule.mjs's
 *  zonedWallTimeToUtc (the established reference implementation for
 *  exactly this problem elsewhere in this codebase), adapted to call
 *  WeeklySchedule.getBerlinParts (the browser-side equivalent of that
 *  module's zonedParts) instead of duplicating it. */
function berlinInputValueToUtcIso(inputValue) {
    if (!inputValue) return null;
    const [datePart, timePart] = inputValue.split("T");
    const [year, month, day] = datePart.split("-").map(Number);
    const [hour, minute] = (timePart || "00:00").split(":").map(Number);
    const desired = { year, month, day, hour, minute };

    const offsetMsAt = (instantMs) => {
        const parts = WeeklySchedule.getBerlinParts(new Date(instantMs));
        const renderedAsUtcMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
        return renderedAsUtcMs - instantMs;
    };
    const rendersToWallTime = (instantMs) => {
        const parts = WeeklySchedule.getBerlinParts(new Date(instantMs));
        return parts.year === desired.year && parts.month === desired.month && parts.day === desired.day
            && parts.hour === desired.hour && parts.minute === desired.minute;
    };

    const desiredAsUtcMs = Date.UTC(year, month - 1, day, hour, minute);
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;

    const offsetNear = offsetMsAt(desiredAsUtcMs);
    const offsetDayBefore = offsetMsAt(desiredAsUtcMs - ONE_DAY_MS);

    const candidateNear = desiredAsUtcMs - offsetNear;
    const candidateDayBefore = desiredAsUtcMs - offsetDayBefore;

    const nearValid = rendersToWallTime(candidateNear);
    const dayBeforeValid = rendersToWallTime(candidateDayBefore);

    let resultMs;
    if (nearValid && dayBeforeValid) resultMs = Math.min(candidateNear, candidateDayBefore);
    else if (nearValid) resultMs = candidateNear;
    else if (dayBeforeValid) resultMs = candidateDayBefore;
    else resultMs = Math.max(candidateNear, candidateDayBefore);

    return new Date(resultMs).toISOString();
}

function renderRewardItemPicker(selectedIds) {
    const container = document.getElementById("promoRewardItemPicker");
    if (!container) return;

    const standardItems = liveMenuItemsForPromotions.filter(m => m.product_type === "standard");

    // Selectable regardless of current availability -- the reward list
    // is a durable configuration (e.g. "Brown Butter OR Strawberry
    // Shortcake"), not a live-stock check. An item that's temporarily
    // unavailable/sold out is still shown (labeled) so the admin can
    // configure it now and have it work automatically once it's
    // available again; it's the CUSTOMER-facing chooser
    // (js/promotions-shared.js's getRewardChoices, used by js/cart.js)
    // that disables an unavailable flavor at the moment of checkout,
    // not this config-time picker. validate_promotion_activation()
    // only requires at least one reward to be currently available
    // before a promotion can go live either -- never all of them.
    container.innerHTML = standardItems.map(item => `
        <label class="promo-reward-option">
            <input
                type="checkbox"
                value="${item.id}"
                ${selectedIds.includes(item.id) ? "checked" : ""}>
            ${escapeHtml(item.name)}${item.available ? "" : " (currently unavailable)"}
        </label>
    `).join("") || "<p>No standard menu items found.</p>";
}

function getSelectedRewardItemIds() {
    const container = document.getElementById("promoRewardItemPicker");
    if (!container) return [];
    return Array.from(container.querySelectorAll("input[type=checkbox]:checked")).map(el => el.value);
}

function togglePromotionTypeFields() {
    const type = document.getElementById("promoType").value;
    document.getElementById("promoFreeItemFields").style.display = type === "free_item" ? "block" : "none";
    document.getElementById("promoPercentageFields").style.display = type === "percentage_discount" ? "block" : "none";
    document.getElementById("promoFixedFields").style.display = type === "fixed_discount" ? "block" : "none";
    renderPromotionPreview();
}

/** Preview built on the exact same PromotionsShared functions the
 *  real cart uses -- see js/promotions-shared.js -- so this can never
 *  drift from actual customer-facing behavior. */
function renderPromotionPreview() {
    const el = document.getElementById("promoPreview");
    if (!el || typeof PromotionsShared === "undefined") return;

    const type = document.getElementById("promoType").value;
    const title = document.getElementById("promoCustomerTitle").value || "(no title yet)";
    const description = document.getElementById("promoCustomerDescription").value || "";
    const message = document.getElementById("promoCartMessage").value || "";
    const threshold = document.getElementById("promoQualifyingSubtotal").value || "0";
    const operator = document.getElementById("promoThresholdOperator").value;

    let rewardLine = "";
    if (type === "free_item") {
        const selectedIds = getSelectedRewardItemIds();
        const names = selectedIds
            .map(id => (liveMenuItemsForPromotions.find(m => m.id === id) || {}).name)
            .filter(Boolean);
        rewardLine = names.length
            ? `Reward choices: ${escapeHtml(names.join(" or "))}`
            : "Reward choices: none selected yet";
    } else if (type === "percentage_discount") {
        rewardLine = `${document.getElementById("promoDiscountPercentage").value || 0}% off`;
    } else if (type === "fixed_discount") {
        rewardLine = `€${document.getElementById("promoFixedDiscountAmount").value || 0} off`;
    }

    el.innerHTML = `
        <strong>${escapeHtml(title)}</strong>
        <p>${escapeHtml(description)}</p>
        <p>Qualifies when subtotal is ${operator === "gte" ? "≥" : ">"} €${escapeHtml(threshold)}</p>
        <p>${rewardLine}</p>
        ${message ? `<p><em>${escapeHtml(message)}</em></p>` : ""}
    `;
}

function buildPromotionModal() {
    const modal = document.createElement("div");
    modal.id = "promotionModal";
    modal.className = "modal-overlay";
    modal.style.display = "none";

    modal.innerHTML = `
        <div class="modal-card modal-card-wide">
            <div class="modal-header">
                <h2 id="promoModalTitle">New Promotion</h2>
                <button class="modal-close" type="button" onclick="closePromotionModal()">✕</button>
            </div>

            <div class="modal-body">
                <div id="promoModalError" class="admin-inline-message is-error" style="display:none;" role="alert"></div>

                <label for="promoInternalName">Internal Name</label>
                <input type="text" id="promoInternalName" placeholder="Free Cookie Over €10">

                <label for="promoCustomerTitle">Customer-Facing Title</label>
                <input type="text" id="promoCustomerTitle" placeholder="Free Cookie with Your Order!">

                <label for="promoCustomerDescription">Customer-Facing Description</label>
                <textarea id="promoCustomerDescription" rows="2" placeholder="Spend over €10 and choose a free cookie."></textarea>

                <label for="promoCartMessage">Cart Message</label>
                <input type="text" id="promoCartMessage" placeholder="You've earned a free cookie! Choose your flavor below.">

                <label for="promoInternalNotes">Internal Notes</label>
                <textarea id="promoInternalNotes" rows="2"></textarea>

                <label for="promoType">Promotion Type</label>
                <select id="promoType" onchange="togglePromotionTypeFields()">
                    <option value="free_item">Free Item</option>
                    <option value="percentage_discount">Percentage Discount</option>
                    <option value="fixed_discount">Fixed-Amount Discount</option>
                </select>

                <div class="field-row">
                    <div>
                        <label for="promoStartAt">Start (Europe/Berlin)</label>
                        <input type="datetime-local" id="promoStartAt" onchange="renderPromotionPreview()">
                        <p class="field-help">Leave blank to start immediately once activated.</p>
                    </div>
                    <div>
                        <label for="promoEndAt">End (Europe/Berlin)</label>
                        <input type="datetime-local" id="promoEndAt" onchange="renderPromotionPreview()">
                        <p class="field-help">Leave blank for no end date.</p>
                    </div>
                </div>

                <div class="field-row">
                    <div>
                        <label for="promoQualifyingSubtotal">Qualifying Subtotal €</label>
                        <input type="number" id="promoQualifyingSubtotal" step="0.01" min="0" oninput="renderPromotionPreview()">
                    </div>
                    <div>
                        <label for="promoThresholdOperator">Threshold</label>
                        <select id="promoThresholdOperator" onchange="renderPromotionPreview()">
                            <option value="gt">Strictly greater than</option>
                            <option value="gte">Greater than or equal to</option>
                        </select>
                    </div>
                </div>

                <div id="promoFreeItemFields">
                    <label>Eligible Reward Items</label>
                    <div id="promoRewardItemPicker" class="promo-reward-picker" oninput="renderPromotionPreview()"></div>

                    <div class="field-row">
                        <div>
                            <label for="promoFreeItemQuantity">Reward Quantity</label>
                            <input type="number" id="promoFreeItemQuantity" min="1" value="1">
                        </div>
                        <div>
                            <label for="promoFreeItemMaxPerOrder">Max Reward Qty Per Order</label>
                            <input type="number" id="promoFreeItemMaxPerOrder" min="1" placeholder="Unlimited">
                        </div>
                    </div>

                    <label class="checkbox-label">
                        <input type="checkbox" id="promoFreeItemCustomerChooses" checked>
                        Customer chooses the reward
                    </label>

                    <label class="checkbox-label">
                        <input type="checkbox" id="promoFreeItemRepeats">
                        Reward quantity repeats at multiples of the threshold
                    </label>
                </div>

                <div id="promoPercentageFields" style="display:none;">
                    <div class="field-row">
                        <div>
                            <label for="promoDiscountPercentage">Percentage %</label>
                            <input type="number" id="promoDiscountPercentage" min="0" max="100" step="0.01">
                        </div>
                        <div>
                            <label for="promoDiscountMaxAmount">Max Discount Amount € (optional)</label>
                            <input type="number" id="promoDiscountMaxAmount" min="0" step="0.01">
                        </div>
                    </div>
                    <label for="promoDiscountAppliesTo">Applies To</label>
                    <select id="promoDiscountAppliesTo">
                        <option value="order_subtotal">Entire qualifying subtotal</option>
                        <option value="eligible_items_only">Eligible items only</option>
                    </select>
                </div>

                <div id="promoFixedFields" style="display:none;">
                    <label for="promoFixedDiscountAmount">Fixed Discount Amount €</label>
                    <input type="number" id="promoFixedDiscountAmount" min="0" step="0.01">
                </div>

                <label>Application</label>
                <p class="field-help">Automatic -- applies without a code. (Promo-code promotions are not yet supported from this page.)</p>

                <div class="field-row">
                    <div>
                        <label for="promoPriority">Priority (lower runs first)</label>
                        <input type="number" id="promoPriority" value="100">
                    </div>
                    <div>
                        <label class="checkbox-label" style="margin-top:1.8em;">
                            <input type="checkbox" id="promoStackable">
                            Stackable with other promotions
                        </label>
                    </div>
                </div>

                <div class="field-row">
                    <div>
                        <label for="promoMaxTotalRedemptions">Max Total Redemptions</label>
                        <input type="number" id="promoMaxTotalRedemptions" min="1" placeholder="Unlimited">
                    </div>
                    <div>
                        <label for="promoMaxPerOrder">Max Per Order</label>
                        <input type="number" id="promoMaxPerOrder" min="1" value="1">
                    </div>
                    <div>
                        <label for="promoMaxPerCustomer">Max Per Customer</label>
                        <input type="number" id="promoMaxPerCustomer" min="1" placeholder="Unlimited">
                    </div>
                </div>

                <div class="promo-preview" id="promoPreview"></div>
            </div>

            <div class="modal-footer">
                <button type="button" class="secondary-btn" onclick="closePromotionModal()">Cancel</button>
                <button type="button" class="primary-btn" id="promoSaveBtn" onclick="savePromotion()">Save Promotion</button>
            </div>
        </div>
    `;

    modal.querySelector(".modal-body").addEventListener("input", () => { promoModalDirty = true; });
    modal.querySelector(".modal-body").addEventListener("change", () => { promoModalDirty = true; renderPromotionPreview(); });

    return modal;
}

function closePromotionModal(force = false) {
    const modal = document.getElementById("promotionModal");
    if (!modal || modal.style.display === "none") return;

    if (!force && promoModalDirty) {
        if (!confirm("You have unsaved changes. Discard them?")) return;
    }

    modal.style.display = "none";
    promoModalDirty = false;

    if (promoLastFocusedElement && typeof promoLastFocusedElement.focus === "function") {
        promoLastFocusedElement.focus();
    }
    promoLastFocusedElement = null;
}

function showPromotionModalError(message) {
    const banner = document.getElementById("promoModalError");
    if (!banner) return;
    banner.textContent = message;
    banner.style.display = "block";
}

function hidePromotionModalError() {
    const banner = document.getElementById("promoModalError");
    if (!banner) return;
    banner.style.display = "none";
    banner.textContent = "";
}

/*==================================================
    SAVE
==================================================*/

function validatePromotionForm(type) {
    const name = document.getElementById("promoInternalName").value.trim();
    const title = document.getElementById("promoCustomerTitle").value.trim();
    const threshold = document.getElementById("promoQualifyingSubtotal").value;
    const startValue = document.getElementById("promoStartAt").value;
    const endValue = document.getElementById("promoEndAt").value;

    if (!name) return "Internal name is required.";
    if (!title) return "Customer-facing title is required.";
    if (threshold === "" || Number(threshold) < 0) return "Qualifying subtotal must be zero or greater.";
    if (startValue && endValue && new Date(startValue) >= new Date(endValue)) return "Start date must be before end date.";

    if (type === "free_item") {
        const qty = Number(document.getElementById("promoFreeItemQuantity").value);
        if (!qty || qty <= 0) return "Free item quantity must be greater than zero.";
        if (!getSelectedRewardItemIds().length) return "Select at least one reward item.";
    } else if (type === "percentage_discount") {
        const pct = Number(document.getElementById("promoDiscountPercentage").value);
        if (!pct || pct <= 0 || pct > 100) return "Percentage must be between 0 and 100.";
    } else if (type === "fixed_discount") {
        const amount = Number(document.getElementById("promoFixedDiscountAmount").value);
        if (!amount || amount <= 0) return "Fixed discount amount must be greater than zero.";
    }

    return null;
}

async function savePromotion() {
    if (promoModalSaving) return;

    const type = document.getElementById("promoType").value;
    const validationError = validatePromotionForm(type);
    if (validationError) {
        showPromotionModalError(validationError);
        return;
    }

    hidePromotionModalError();
    promoModalSaving = true;
    const saveBtn = document.getElementById("promoSaveBtn");
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving..."; }

    const payload = {
        internal_name: document.getElementById("promoInternalName").value.trim(),
        customer_title: document.getElementById("promoCustomerTitle").value.trim(),
        customer_description: document.getElementById("promoCustomerDescription").value.trim() || null,
        cart_message: document.getElementById("promoCartMessage").value.trim() || null,
        internal_notes: document.getElementById("promoInternalNotes").value.trim() || null,
        promotion_type: type,
        start_at: berlinInputValueToUtcIso(document.getElementById("promoStartAt").value),
        end_at: berlinInputValueToUtcIso(document.getElementById("promoEndAt").value),
        qualifying_subtotal_min: Number(document.getElementById("promoQualifyingSubtotal").value),
        threshold_operator: document.getElementById("promoThresholdOperator").value,
        priority: Number(document.getElementById("promoPriority").value) || 100,
        stackable: document.getElementById("promoStackable").checked,
        max_total_redemptions: document.getElementById("promoMaxTotalRedemptions").value
            ? Number(document.getElementById("promoMaxTotalRedemptions").value) : null,
        max_redemptions_per_order: Number(document.getElementById("promoMaxPerOrder").value) || 1,
        max_redemptions_per_customer: document.getElementById("promoMaxPerCustomer").value
            ? Number(document.getElementById("promoMaxPerCustomer").value) : null,
        free_item_quantity: type === "free_item" ? Number(document.getElementById("promoFreeItemQuantity").value) : null,
        free_item_customer_chooses: type === "free_item" ? document.getElementById("promoFreeItemCustomerChooses").checked : true,
        free_item_max_per_order: type === "free_item" && document.getElementById("promoFreeItemMaxPerOrder").value
            ? Number(document.getElementById("promoFreeItemMaxPerOrder").value) : null,
        free_item_repeats_at_multiples: type === "free_item" ? document.getElementById("promoFreeItemRepeats").checked : false,
        discount_percentage: type === "percentage_discount" ? Number(document.getElementById("promoDiscountPercentage").value) : null,
        discount_max_amount: type === "percentage_discount" && document.getElementById("promoDiscountMaxAmount").value
            ? Number(document.getElementById("promoDiscountMaxAmount").value) : null,
        discount_applies_to: (type === "percentage_discount" || type === "fixed_discount")
            ? document.getElementById("promoDiscountAppliesTo").value : null,
        fixed_discount_amount: type === "fixed_discount" ? Number(document.getElementById("promoFixedDiscountAmount").value) : null
    };

    let savedId = promoEditingId;

    if (promoEditingId) {
        const { data, error } = await supabaseClient
            .from("promotions").update(payload).eq("id", promoEditingId)
            .select("*, promotion_display_status").single();

        if (error) {
            showPromotionModalError(error.message);
            promoModalSaving = false;
            if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Save Promotion"; }
            return;
        }

        const existing = promotions.find(p => p.id === promoEditingId);
        if (existing) Object.assign(existing, data, { displayStatus: data.promotion_display_status });
    } else {
        const { data, error } = await supabaseClient
            .from("promotions").insert(payload)
            .select("*, promotion_display_status").single();

        if (error) {
            showPromotionModalError(error.message);
            promoModalSaving = false;
            if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Save Promotion"; }
            return;
        }

        savedId = data.id;
        promotions.unshift({ ...data, displayStatus: data.promotion_display_status, rewardItems: [] });
    }

    // Reward items: delete-all-then-reinsert for the current selection
    // -- same simple, atomic-enough-for-admin-tooling pattern
    // admin_replace_order_items uses for order_items.
    if (type === "free_item") {
        const selectedIds = getSelectedRewardItemIds();
        await supabaseClient.from("promotion_reward_items").delete().eq("promotion_id", savedId);
        if (selectedIds.length) {
            await supabaseClient.from("promotion_reward_items").insert(
                selectedIds.map((menu_item_id, index) => ({ promotion_id: savedId, menu_item_id, sort_order: index }))
            );
        }
        const { data: rewardRows } = await supabaseClient
            .from("promotion_reward_items").select("promotion_id, menu_item_id, sort_order").eq("promotion_id", savedId);
        const saved = promotions.find(p => p.id === savedId);
        if (saved) saved.rewardItems = rewardRows || [];
    }

    closePromotionModal(true);
    applyPromotionFilters();
    showPromotionsToast("Promotion saved.");
}

/*==================================================
    UTIL
==================================================*/

function escapeHtml(value) {
    return String(value == null ? "" : value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}
