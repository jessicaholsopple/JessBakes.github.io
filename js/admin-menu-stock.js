/* ==========================================
   ADMIN MENU STOCK (admin/menu-stock.html)
   ==========================================

   Finished-product freezer stock -- completely separate from the
   ingredient Inventory page (js/admin-inventory.js), recipe-based cost
   calculations, and production/baking batches (js/admin-production.js).
   Every write on this page goes through one of the two security-definer
   RPCs added in supabase/migrations/20261012123000_finished_stock_admin_rpcs.sql
   (set_menu_item_stock_mode / adjust_finished_stock), except the single
   sold_out_behavior toggle, which the schema migration deliberately
   leaves as a plain admin-gated UPDATE (see that migration's own
   comment on why). Order-driven reservation/restoration is handled
   entirely server-side by triggers (see
   supabase/migrations/20261012121500_finished_stock_reconcile_triggers.sql)
   -- this page never reserves or restores anything itself, it only
   reads the resulting counts and the finished_stock_movements audit
   ledger those triggers (and the two RPCs above) write to.
   ========================================== */

const STOCK_CATEGORY_NAMES = {
    bread: "Sourdough Bread",
    cookie: "Sourdough Cookies",
    dessert: "Desserts",
    seasonal: "Seasonal Specials"
};

let stockItems = [];
let stockMovements = [];

document.addEventListener("DOMContentLoaded", async () => {

    await requireAuth();

    await Promise.all([loadStock(), loadMovements()]);

    ["stockSearch", "stockCategoryFilter", "stockModeFilter", "stockAvailabilityFilter"]
        .forEach(id => {
            const el = document.getElementById(id);
            el.addEventListener("input", applyStockFilters);
            el.addEventListener("change", applyStockFilters);
        });

});

/* ==========================================
   LOAD
========================================== */

async function loadStock() {

    // Only standard, individually-orderable products are ever stock-
    // tracked -- Mix & Match box products never get their own row (see
    // the schema migration's header comment); fetched regardless of
    // menu_items.available so an admin can still manage freezer stock
    // for an item that's temporarily toggled off the public menu.
    const { data: items, error: itemsError } = await supabaseClient
        .from("menu_items")
        .select("*")
        .eq("product_type", "standard")
        .order("category", { ascending: true })
        .order("name", { ascending: true });

    if (itemsError) {
        console.error(itemsError);
        return;
    }

    const { data: stockRows, error: stockError } = await supabaseClient
        .from("menu_item_stock")
        .select("*");

    if (stockError) {
        console.error(stockError);
    }

    const stockById = new Map((stockRows || []).map(s => [s.menu_item_id, s]));

    stockItems = (items || []).map(item => {
        const stock = stockById.get(item.id);
        return {
            ...item,
            stock_mode: stock ? stock.stock_mode : "made_to_order",
            physical_count: stock ? stock.physical_count : null,
            reserved_count: stock ? stock.reserved_count : 0,
            available_count: stock ? stock.available_count : null,
            sold_out_behavior: stock ? stock.sold_out_behavior : "show_sold_out"
        };
    });

    applyStockFilters();

}

async function loadMovements() {

    const { data, error } = await supabaseClient
        .from("finished_stock_movements")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);

    if (error) {
        console.error(error);
        return;
    }

    stockMovements = data || [];
    renderMovements();

}

/* ==========================================
   RENDER -- ITEMS TABLE + STATS
========================================== */

function applyStockFilters() {

    const search = document.getElementById("stockSearch").value.toLowerCase();
    const category = document.getElementById("stockCategoryFilter").value;
    const mode = document.getElementById("stockModeFilter").value;
    const availability = document.getElementById("stockAvailabilityFilter").value;

    const filtered = stockItems.filter(item => {
        if (search && !item.name.toLowerCase().includes(search)) return false;
        if (category && item.category !== category) return false;
        if (mode && item.stock_mode !== mode) return false;

        if (availability) {
            const status = stockStatus(item);
            if (availability !== status) return false;
        }

        return true;
    });

    renderStockTable(filtered);
    renderStats();

}

/** 'available' | 'sold_out' | 'hidden' -- 'hidden' only applies to a
 *  zero-stock limited item whose admin chose to auto-hide it; a
 *  manually unavailable item (menu_items.available = false) is always
 *  reported as its own, separate thing -- never confused with sold
 *  out, since that flag must keep overriding stock everywhere. */
function stockStatus(item) {
    if (!item.available) return "unavailable";
    if (item.stock_mode !== "limited") return "available";
    const remaining = Math.max(Number(item.available_count) || 0, 0);
    if (remaining > 0) return "available";
    return item.sold_out_behavior === "hide" ? "hidden" : "sold_out";
}

function renderStats() {
    const limited = stockItems.filter(i => i.stock_mode === "limited");
    const soldOut = limited.filter(i => Math.max(Number(i.available_count) || 0, 0) <= 0);
    const unitsOnHand = limited.reduce((sum, i) => sum + (Number(i.physical_count) || 0), 0);

    document.getElementById("stockLimitedCount").textContent = limited.length;
    document.getElementById("stockSoldOutCount").textContent = soldOut.length;
    document.getElementById("stockUnitsOnHand").textContent = unitsOnHand;
}

function renderStockTable(list) {

    const tbody = document.getElementById("stockTableBody");
    tbody.innerHTML = "";

    if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="8">No menu items match these filters.</td></tr>`;
        return;
    }

    list.forEach(item => {

        const tr = document.createElement("tr");
        const status = stockStatus(item);
        const limited = item.stock_mode === "limited";

        tr.innerHTML = `
            <td>${escapeHtml(item.name)}</td>
            <td>${escapeHtml(STOCK_CATEGORY_NAMES[item.category] || item.category)}</td>
            <td>${limited ? "Limited" : "Made to Order"}</td>
            <td>${limited ? (item.physical_count ?? "—") : "—"}</td>
            <td>${limited ? item.reserved_count : "—"}</td>
            <td>${limited ? Math.max(Number(item.available_count) || 0, 0) : "Unlimited"}</td>
            <td>${renderStatusBadge(status)}</td>
            <td>
                <button class="secondary-btn" onclick="openStockModal('${item.id}')">Manage</button>
            </td>
        `;

        tbody.appendChild(tr);

    });

}

function renderStatusBadge(status) {
    const map = {
        available: `<span class="status-badge status-confirmed">Available</span>`,
        sold_out: `<span class="status-badge status-cancelled">Sold Out</span>`,
        hidden: `<span class="status-badge status-cancelled">Hidden</span>`,
        unavailable: `<span class="status-badge status-pending">Unavailable</span>`
    };
    return map[status] || "";
}

/* ==========================================
   RENDER -- MOVEMENTS HISTORY
========================================== */

function renderMovements() {

    const tbody = document.getElementById("stockMovementsTableBody");
    tbody.innerHTML = "";

    if (!stockMovements.length) {
        tbody.innerHTML = `<tr><td colspan="7">No stock adjustments yet.</td></tr>`;
        return;
    }

    const SOURCE_LABELS = {
        admin_adjustment: "Admin Adjustment",
        order_reservation: "Order Reservation",
        order_cancellation: "Order Cancelled",
        order_edit: "Order Edited",
        order_deletion: "Order Deleted"
    };

    stockMovements.forEach(movement => {

        const item = stockItems.find(i => i.id === movement.menu_item_id);
        const tr = document.createElement("tr");

        tr.innerHTML = `
            <td>${formatDateTime(movement.created_at)}</td>
            <td>${escapeHtml(item ? item.name : "(deleted item)")}</td>
            <td>${movement.quantity_change > 0 ? "+" : ""}${movement.quantity_change}</td>
            <td>${movement.previous_count}</td>
            <td>${movement.new_count}</td>
            <td>${escapeHtml(movement.reason || "—")}</td>
            <td>${SOURCE_LABELS[movement.source] || escapeHtml(movement.source)}</td>
        `;

        tbody.appendChild(tr);

    });

}

/* ==========================================
   MANAGE-STOCK MODAL
========================================== */

let openStockItemId = null;

function ensureStockModal() {
    if (document.getElementById("stockModal")) return;

    const modal = document.createElement("div");
    modal.id = "stockModal";
    modal.className = "modal-overlay";
    modal.style.display = "none";

    modal.innerHTML = `
        <div class="modal-card">
            <div class="modal-header">
                <h2 id="stockModalItemName">Manage Stock</h2>
                <button class="modal-close" onclick="closeStockModal()">✕</button>
            </div>

            <div class="modal-body">

                <label class="toggle-switch">
                    <input type="checkbox" id="stockModeToggle" onchange="onStockModeToggle()">
                    <span class="toggle-track"></span>
                    Limited freezer stock
                </label>
                <p class="stock-modal-hint">
                    Off = Made to Order (no limit, no count shown to customers).
                    On = track an exact number of finished units.
                </p>

                <div id="stockLimitedFields" style="display:none;">

                    <div id="stockInitialCountGroup" class="form-group" style="display:none;">
                        <label for="stockInitialCount">Current freezer count</label>
                        <input type="number" id="stockInitialCount" min="0" step="1">
                    </div>

                    <div id="stockCurrentStatsGroup" style="display:none;">
                        <p><strong>On hand:</strong> <span id="stockStatPhysical"></span></p>
                        <p><strong>Reserved by pending/confirmed orders:</strong> <span id="stockStatReserved"></span></p>
                        <p><strong>Available to sell now:</strong> <span id="stockStatAvailable"></span></p>
                    </div>

                    <div class="form-group">
                        <label for="stockSoldOutBehavior">When this hits zero</label>
                        <select id="stockSoldOutBehavior" onchange="updateSoldOutBehavior()">
                            <option value="show_sold_out">Show as "Sold Out" on the menu</option>
                            <option value="hide">Hide from the public menu automatically</option>
                        </select>
                    </div>

                    <div id="stockAdjustGroup" class="stock-adjust-group" style="display:none;">
                        <h3>Adjust Count</h3>
                        <div class="stock-adjust-row">
                            <select id="stockAdjustMode">
                                <option value="add">Add (newly baked)</option>
                                <option value="subtract">Subtract (damaged / sampled / gifted)</option>
                                <option value="set">Set exact count (physical recount)</option>
                            </select>
                            <input type="number" id="stockAdjustAmount" min="0" step="1" placeholder="Amount">
                        </div>
                        <input type="text" id="stockAdjustReason" placeholder="Reason (optional)">
                        <button type="button" class="secondary-btn" onclick="applyStockAdjustment()">Apply Adjustment</button>
                    </div>

                </div>

                <div id="stockModeSaveGroup" style="display:none;">
                    <button type="button" class="primary-btn" onclick="saveStockMode()">Switch to Limited Stock</button>
                </div>

            </div>

            <div class="modal-footer">
                <button class="secondary-btn" onclick="closeStockModal()">Close</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
}

function openStockModal(itemId) {

    ensureStockModal();

    const item = stockItems.find(i => i.id === itemId);
    if (!item) return;

    openStockItemId = itemId;

    document.getElementById("stockModalItemName").textContent = item.name;

    const limited = item.stock_mode === "limited";
    document.getElementById("stockModeToggle").checked = limited;
    document.getElementById("stockSoldOutBehavior").value = item.sold_out_behavior || "show_sold_out";

    renderStockModalFields(item, limited);

    document.getElementById("stockModal").style.display = "flex";

}

function renderStockModalFields(item, limited) {

    document.getElementById("stockLimitedFields").style.display = limited ? "block" : "none";

    const hasExistingRow = item.physical_count !== null && item.physical_count !== undefined;

    // A brand-new switch to Limited (no count on record yet) asks for
    // the current freezer count and shows the "Switch to Limited
    // Stock" save button (-> set_menu_item_stock_mode with
    // p_initial_count). An item that's ALREADY limited shows its live
    // stats and the Add/Subtract/Set adjustment panel instead
    // (-> adjust_finished_stock) -- the two never overlap, matching
    // the two RPCs' own separation of concerns.
    const needsInitialCount = limited && !hasExistingRow;

    document.getElementById("stockInitialCountGroup").style.display = needsInitialCount ? "block" : "none";
    document.getElementById("stockModeSaveGroup").style.display = needsInitialCount ? "block" : "none";
    document.getElementById("stockCurrentStatsGroup").style.display = (limited && hasExistingRow) ? "block" : "none";
    document.getElementById("stockAdjustGroup").style.display = (limited && hasExistingRow) ? "block" : "none";

    if (limited && hasExistingRow) {
        document.getElementById("stockStatPhysical").textContent = item.physical_count;
        document.getElementById("stockStatReserved").textContent = item.reserved_count;
        document.getElementById("stockStatAvailable").textContent = Math.max(Number(item.available_count) || 0, 0);
    }

    if (!limited && item.stock_mode === "limited") {
        // Toggled off from the Limited state in this modal session --
        // switching away needs its own explicit Save action too.
        document.getElementById("stockModeSaveGroup").style.display = "block";
        document.getElementById("stockModeSaveGroup").querySelector("button").textContent = "Switch to Made to Order";
    } else if (needsInitialCount) {
        document.getElementById("stockModeSaveGroup").querySelector("button").textContent = "Switch to Limited Stock";
    }

}

function onStockModeToggle() {
    const item = stockItems.find(i => i.id === openStockItemId);
    if (!item) return;
    const limited = document.getElementById("stockModeToggle").checked;
    renderStockModalFields(item, limited);
}

function closeStockModal() {
    const modal = document.getElementById("stockModal");
    if (modal) modal.style.display = "none";
    openStockItemId = null;
}

/* ==========================================
   WRITES
========================================== */

async function saveStockMode() {

    const item = stockItems.find(i => i.id === openStockItemId);
    if (!item) return;

    const limited = document.getElementById("stockModeToggle").checked;

    if (limited) {

        const initialCountInput = document.getElementById("stockInitialCount").value;
        const initialCount = initialCountInput === "" ? null : Number(initialCountInput);

        if (initialCount === null || Number.isNaN(initialCount) || initialCount < 0) {
            alert("Please enter the current freezer count (0 or more).");
            return;
        }

        const { data, error } = await supabaseClient.rpc("set_menu_item_stock_mode", {
            p_menu_item_id: item.id,
            p_stock_mode: "limited",
            p_initial_count: initialCount,
            p_sold_out_behavior: document.getElementById("stockSoldOutBehavior").value
        });

        if (error) {
            alert(error.message);
            return;
        }

        applyStockRowToItem(item, data);

    } else {

        if (item.reserved_count > 0 && !confirm(
            `${item.name} currently has ${item.reserved_count} unit(s) reserved by pending or confirmed orders. ` +
            `Switching to Made to Order clears this item's stock tracking (those orders are NOT affected). Continue?`
        )) {
            return;
        }

        const { data, error } = await supabaseClient.rpc("set_menu_item_stock_mode", {
            p_menu_item_id: item.id,
            p_stock_mode: "made_to_order"
        });

        if (error) {
            alert(error.message);
            return;
        }

        applyStockRowToItem(item, data);

    }

    await loadMovements();
    applyStockFilters();
    closeStockModal();

}

function applyStockRowToItem(item, stockRow) {
    if (!stockRow) return;
    item.stock_mode = stockRow.stock_mode;
    item.physical_count = stockRow.physical_count;
    item.reserved_count = stockRow.reserved_count;
    item.available_count = stockRow.available_count;
    item.sold_out_behavior = stockRow.sold_out_behavior;
}

/** True when an adjustment is large/destructive enough to require an
 *  explicit confirmation: any subtract, any exact "set" correction
 *  (an absolute override can silently zero something out), or an
 *  unusually large add (likely a typo). */
function needsAdjustmentConfirmation(mode, amount) {
    if (mode === "subtract" || mode === "set") return true;
    return mode === "add" && amount >= 50;
}

async function applyStockAdjustment() {

    const item = stockItems.find(i => i.id === openStockItemId);
    if (!item) return;

    const mode = document.getElementById("stockAdjustMode").value;
    const amountInput = document.getElementById("stockAdjustAmount").value;
    const amount = Number(amountInput);
    const reason = document.getElementById("stockAdjustReason").value.trim();

    if (amountInput === "" || Number.isNaN(amount) || amount < 0) {
        alert("Please enter a valid amount (0 or more).");
        return;
    }

    if (needsAdjustmentConfirmation(mode, amount)) {
        const verb = mode === "add" ? "add" : mode === "subtract" ? "subtract" : "set the count to";
        if (!confirm(`Are you sure you want to ${verb} ${amount} for ${item.name}? This cannot be undone automatically.`)) {
            return;
        }
    }

    const { data, error } = await supabaseClient.rpc("adjust_finished_stock", {
        p_menu_item_id: item.id,
        p_mode: mode,
        p_amount: amount,
        p_reason: reason || null
    });

    if (error) {
        alert(error.message);
        return;
    }

    applyStockRowToItem(item, data);
    renderStockModalFields(item, true);

    document.getElementById("stockAdjustAmount").value = "";
    document.getElementById("stockAdjustReason").value = "";

    await loadMovements();
    applyStockFilters();

}

async function updateSoldOutBehavior() {

    const item = stockItems.find(i => i.id === openStockItemId);
    if (!item || item.stock_mode !== "limited") return;

    const value = document.getElementById("stockSoldOutBehavior").value;

    const { error } = await supabaseClient
        .from("menu_item_stock")
        .update({ sold_out_behavior: value })
        .eq("menu_item_id", item.id);

    if (error) {
        alert(error.message);
        return;
    }

    item.sold_out_behavior = value;
    applyStockFilters();

}

/* ==========================================
   HELPERS
========================================== */

function formatDateTime(date) {
    return new Date(date).toLocaleString();
}

function escapeHtml(text) {
    return String(text ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}
