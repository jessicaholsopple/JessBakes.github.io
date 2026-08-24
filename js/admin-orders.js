/* ==========================================
   ADMIN ORDERS
========================================== */

document.addEventListener("DOMContentLoaded", async () => {

    await requireAuth();

    setupLogout();

    await loadMenuItems();

    await loadOrderManager();

    handleOrderDeepLink();

});

/* ==========================================
   ORDER DEEP-LINKING (push-notification taps, ?order=<id>)

   Safe by construction: the id is only ever used as a CSS selector
   target for an id the page itself already rendered (see
   renderOrderCard's `id="order-..."`) -- never written into the DOM
   as HTML, never sent anywhere. If no order-card with that id exists
   (wrong id, order since deleted, still loading), this simply no-ops.
   ========================================== */
function handleOrderDeepLink() {

    const orderId = new URLSearchParams(window.location.search).get("order");
    if (!orderId) return;

    const card = document.getElementById(`order-${orderId}`);
    if (!card) return;

    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.add("order-card-highlight");
    setTimeout(() => card.classList.remove("order-card-highlight"), 4000);
}

let menuItems = [];
let manualOrderItems = {};

// Mix & Match ("builder") boxes in the order currently being built/edited,
// keyed by the LIVE builder product id (e.g. "6 Mix & Match Cookies").
// Fully editable here: box quantity via the same +/- control as any flat
// item, plus an embedded cookie-flavor selector once boxQuantity > 0. See
// OrderEditor.groupBuilderItemsByLiveProduct (loading an existing order)
// and OrderEditor.buildBuilderBoxOrderItems (saving). Each entry:
//   { id, name, builderGroup, builderSize, perBoxPrice, boxQuantity,
//     selections: { [cookieId]: { name, quantity } } }
let manualBuilderBoxes = {};

// Order lines that can't be safely represented by either the flat editor
// or the Mix & Match box editor above (a builder-style line whose box
// product was since renamed/deleted, or any other line with no
// resolvable menu_item_id) — preserved verbatim when editing an existing
// order so opening Edit can never silently drop them (BUG-02). Not
// addable from this editor; only carried through unchanged or removed as
// a whole line.
let manualUnresolvedBuilderItems = [];


/* ==========================================
   MENU ITEMS FOR MANUAL ORDERS
========================================== */

async function loadMenuItems() {

    const { data, error } = await supabaseClient
        .from("menu_items")
        .select("*")
        .eq("available", true)
        .order("category", { ascending: true })
        .order("sort_order", { ascending: true });

    if (error) {

        console.error(error);

        menuItems = [];

        return;

    }

    menuItems = data || [];

}


/* ==========================================
   ORDER MANAGER
========================================== */

async function loadOrderManager() {

    const orderContainer = document.getElementById("orderManager");

    if (!orderContainer) return;

    orderContainer.innerHTML = "<p>Loading orders...</p>";

    const { data: orders, error } = await supabaseClient
        .from("orders")
        .select(`
            *,
            order_items(*)
        `)
        .order("created_at", { ascending: false });

    if (error) {

        console.error(error);

        orderContainer.innerHTML = `
            <p>Unable to load orders.</p>
        `;

        return;

    }

    const safeOrders = orders || [];

    renderOrderManager(safeOrders);

}


/* ==========================================
   RENDER ORDERS
========================================== */

function renderOrderManager(orders) {

    const container = document.getElementById("orderManager");

    if (!container) return;

    if (!orders.length) {

        container.innerHTML = `
            <p>No orders yet.</p>
        `;

        return;

    }

    const pending = orders.filter(order => order.status === "pending");
    const confirmed = orders.filter(order => order.status === "confirmed");
    const ready = orders.filter(order => order.status === "ready");
    const completed = orders.filter(order => order.status === "completed");
    const cancelled = orders.filter(order => order.status === "cancelled");

    container.innerHTML = `
        <div class="orders-overview">

            <button type="button" class="order-status-card" onclick="focusOrderSection('pending-orders')">
                <strong>Pending</strong>
                <span>${pending.length}</span>
            </button>

            <button type="button" class="order-status-card" onclick="focusOrderSection('confirmed-orders')">
                <strong>Confirmed</strong>
                <span>${confirmed.length}</span>
            </button>

            <button type="button" class="order-status-card" onclick="focusOrderSection('ready-for-pickup')">
                <strong>Ready</strong>
                <span>${ready.length}</span>
            </button>

            <button type="button" class="order-status-card" onclick="focusOrderSection('completed')">
                <strong>Completed</strong>
                <span>${completed.length}</span>
            </button>

            <button type="button" class="order-status-card" onclick="focusOrderSection('cancelled')">
                <strong>Cancelled</strong>
                <span>${cancelled.length}</span>
            </button>

        </div>

        ${renderOrderSection("Pending Orders", pending)}
        ${renderOrderSection("Confirmed Orders", confirmed)}
        ${renderOrderSection("Ready for Pickup", ready)}
        ${renderOrderSection("Completed", completed)}
        ${renderOrderSection("Cancelled", cancelled)}
    `;

}

function renderOrderSection(title, orders) {

    const sectionId = title
        .toLowerCase()
        .replace(/\s+/g, "-");

    return `
        <section class="order-section">

            <button
                class="order-section-header"
                onclick="toggleOrderSection('${sectionId}')">

                <div>
                    <h3>${title}</h3>

                    <small>
                        ${orders.length}
                        order${orders.length === 1 ? "" : "s"}
                    </small>
                </div>

                <span id="${sectionId}-icon">
                    ${orders.length ? "▼" : "►"}
                </span>

            </button>

            <div
                id="${sectionId}"
                style="display:${orders.length ? "block" : "none"};">

                ${
                    orders.length
                        ? orders.map(renderOrderCard).join("")
                        : `<p class="empty-orders">No orders.</p>`
                }

            </div>

        </section>
    `;

}

/* Clicking a status-summary card (Pending/Confirmed/Ready/Completed/
   Cancelled) jumps to and opens that status's section below --
   always ENSURES it's open (never closes an already-open section the
   way toggleOrderSection does), then scrolls it into view. This is
   the one status/filter grid left after consolidating the old
   duplicate display-only summary that used to sit above it. */
function focusOrderSection(id) {

    const section = document.getElementById(id);
    const icon = document.getElementById(id + "-icon");
    const header = icon ? icon.closest(".order-section-header") : null;

    if (!section) return;

    section.style.display = "block";
    if (icon) icon.textContent = "▼";

    (header || section).scrollIntoView({ behavior: "smooth", block: "start" });

}

function toggleOrderSection(id) {

    const section = document.getElementById(id);
    const icon = document.getElementById(id + "-icon");

    if (!section || !icon) return;

    if (section.style.display === "none") {

        section.style.display = "block";
        icon.textContent = "▼";

    } else {

        section.style.display = "none";
        icon.textContent = "►";

    }

}


/* ==========================================
   ORDER CARD
========================================== */

function renderOrderCard(order) {

    const items = order.order_items || [];

    const totalItems = items.reduce(
        (sum, item) => sum + Number(item.quantity || 0),
        0
    );

    return `
        <article class="order-card" id="order-${escapeHtml(order.id)}">

            <div class="order-card-header">

                <div>
                    <h3>${escapeHtml(order.customer_name)}</h3>

                    <div class="customer-contact">
                        📱 ${escapeHtml(order.customer_phone)}
                    </div>

                    ${
                        order.customer_email
                            ? `
                                <div class="customer-contact">
                                    📧 ${escapeHtml(order.customer_email)}
                                </div>
                            `
                            : ""
                    }

                    <div style="margin-top:10px;">
                        <span class="order-type-badge ${
                            order.order_type === "custom"
                                ? "order-type-custom"
                                : "order-type-weekly"
                        }">
                            ${
                                order.order_type === "custom"
                                    ? "🎂 Custom Order"
                                    : "🧺 Weekly Pickup"
                            }
                        </span>
                    </div>
                </div>

                <div>
                    <span class="status-badge status-${order.status}">
                        ${capitalize(order.status)}
                    </span>
                </div>

            </div>

            <div class="order-meta">

                <div>
                    <strong>
                        ${
                            order.order_type === "custom"
                                ? "Needed By"
                                : "Pickup"
                        }
                    </strong>

                    <p>
                        ${
                            order.order_type === "custom"
                                ? (
                                    order.event_date
                                        ? formatDate(order.event_date)
                                        : "No event date selected"
                                )
                                : `
                                    ${formatDate(order.pickup_date)}
                                    <br>
                                    <small>12:30 PM</small>
                                `
                        }
                    </p>
                </div>

                <div>
                    <strong>Total</strong>
                    <p>€${Number(order.subtotal || 0).toFixed(2)}</p>
                </div>

                <div>
                    <strong>Items</strong>
                    <p>${totalItems}</p>
                </div>

                <div>
                    <strong>Preferred Contact</strong>
                    <p>
                        ${
                            order.preferred_contact === "email"
                                ? "Email"
                                : "Text Message"
                        }
                    </p>
                </div>

                <div>
                    <strong>Order Placed</strong>
                    <p>${formatDate(order.created_at)}</p>
                </div>

            </div>

            ${
                order.notes
                    ? `
                        <div class="order-notes">
                            <strong>Special Instructions</strong>

                            <p>
                                ${escapeHtml(order.notes).replace(/\n/g, "<br>")}
                            </p>
                        </div>
                    `
                    : ""
            }

            <div class="order-items">
                <strong>Items Ordered</strong>
                ${renderOrderItems(items)}
            </div>

            <div class="order-actions">

    ${renderStatusButtons(order)}

    ${
        order.status === "pending" ||
        order.status === "confirmed"

            ? `
                <button
                    class="secondary-btn"
                    onclick="editOrder('${order.id}')">

                    Edit

                </button>
            `

            : ""
    }

    <button
        class="delete-btn"
        onclick="deleteOrder('${order.id}')">

        Delete

    </button>

</div>

        </article>
    `;

}


/* ==========================================
   ORDER ITEMS
========================================== */

function renderOrderItems(items) {

    if (!items.length) {
        return `<p>No items.</p>`;
    }

    return `
        <div class="order-items-list">
           ${items.map(item => {

    let builderHtml = "";

    if (item.builder_details?.selections?.length) {

        builderHtml = `
            <div class="builder-order-details">

                ${item.builder_details.selections.map(selection => `

                    <div class="builder-order-line">

                        • ${escapeHtml(selection.name)}

                        × ${selection.quantity}

                    </div>

                `).join("")}

            </div>
        `;

    }

    return `

        <div class="order-item-row">

            <div class="order-item-left">

                <span class="order-item-qty">

                    ${item.builder_details?.box_quantity ?? item.quantity}×

                </span>

                <div>

                    <span class="order-item-name">

                        ${escapeHtml(item.item_name)}

                    </span>

                    ${builderHtml}

                </div>

            </div>

            <div class="order-item-right">

                €${Number(item.line_total || 0).toFixed(2)}

            </div>

        </div>

    `;

}).join("")}
        </div>
    `;

}


/* ==========================================
   STATUS BUTTONS
========================================== */

function renderStatusButtons(order) {

    switch (order.status) {

        case "pending":
            return `
                <button
                    class="approve-btn"
                    onclick="updateOrderStatus('${order.id}','confirmed')">
                    Confirm
                </button>

                <button
                    class="remove-option-btn"
                    onclick="updateOrderStatus('${order.id}','cancelled')">
                    Cancel
                </button>
            `;

        case "confirmed":
            return `
                <button
                    class="approve-btn"
                    onclick="updateOrderStatus('${order.id}','ready')">
                    Ready
                </button>

                <button
                    class="remove-option-btn"
                    onclick="updateOrderStatus('${order.id}','cancelled')">
                    Cancel
                </button>
            `;

        case "ready":
            return `
                <button
                    class="approve-btn"
                    onclick="updateOrderStatus('${order.id}','completed')">
                    Complete
                </button>
            `;

       case "completed":
    return `
        <button
            class="edit-option-btn"
            onclick="reopenOrder('${order.id}')">

            Undo Completion

        </button>
    `;

        case "cancelled":
            return `
                <span class="order-finished">
                    Cancelled
                </span>
            `;

        default:
            return "";

    }

}


/* ==========================================
   UPDATE STATUS
========================================== */

async function updateOrderStatus(orderId, status) {

    const { data: currentOrder } =
        await supabaseClient
            .from("orders")
            .select("status")
            .eq("id", orderId)
            .maybeSingle();

    const previousStatus = currentOrder?.status;

    const { error } = await supabaseClient
        .from("orders")
        .update({ status })
        .eq("id", orderId);

    if (error) {

        console.error(error);
        alert(error.message);
        return;

    }

    if (status === "completed") {

    const saleCreated = await createSaleFromOrder(orderId);

    // If the sale couldn't be created (e.g. no EUR->USD exchange rate
    // could be resolved and the admin didn't enter one manually), don't
    // leave the order stuck as "completed" with no sale record -- revert
    // it to whatever it was before this action.
    if (!saleCreated && previousStatus) {

        await supabaseClient
            .from("orders")
            .update({ status: previousStatus })
            .eq("id", orderId);

    }

}

if (status === "cancelled") {

    await removeSaleFromOrder(orderId);

}

    await loadOrderManager();

}

async function removeSaleFromOrder(orderId) {

    const { data: sale, error } =
        await supabaseClient
            .from("sales")
            .select("id")
            .eq("order_id", orderId)
            .maybeSingle();

    if (error) {

        console.error(error);
        return;

    }

    if (!sale) {

        return;

    }

    const { error: saleItemsError } =
        await supabaseClient
            .from("sale_items")
            .delete()
            .eq("sale_id", sale.id);

    if (saleItemsError) {

        console.error(saleItemsError);
        return;

    }

    const { error: saleError } =
        await supabaseClient
            .from("sales")
            .delete()
            .eq("id", sale.id);

    if (saleError) {

        console.error(saleError);

    }

}

async function createSaleFromOrder(orderId) {

    const { data: existingSale } =
        await supabaseClient
            .from("sales")
            .select("id")
            .eq("order_id", orderId)
            .maybeSingle();

    if (existingSale) {

        return true;

    }

    const { data: order, error: orderError } =
        await supabaseClient
            .from("orders")
            .select("*")
            .eq("id", orderId)
            .single();

    if (orderError) {

        console.error(orderError);
        alert("Unable to load order.");
        return false;

    }

    const { data: items, error: itemsError } =
        await supabaseClient
            .from("order_items")
            .select("*")
            .eq("order_id", orderId);

    if (itemsError) {

        console.error(itemsError);
        alert("Unable to load order items.");
        return false;

    }

    // Phase 3: resolve today's EUR->USD rate BEFORE writing anything, so a
    // rate that can't be resolved never leaves a half-completed sale.
    // Snapshotted once here and reused for the sale AND every one of its
    // sale_items rows — never a per-line lookup (see js/currency-conversion.js).
    const todayStr = new Date().toISOString().split("T")[0];

    const rateEntry = await CurrencyConversion.resolveExchangeRate(todayStr, {
        getCachedRate: getCachedExchangeRate,
        fetchLiveRate: CurrencyConversion.createFrankfurterFetcher(),
        promptManualRate: async (dateStr) => promptManualExchangeRate(dateStr),
        saveRate: saveExchangeRate
    });

    if (!rateEntry) {

        alert(
            "Could not determine today's EUR→USD exchange rate, and no manual rate was entered. This order was NOT marked completed — try again once a rate is available."
        );
        return false;

    }

    const { data: sale, error: saleError } =
        await supabaseClient
            .from("sales")
            .insert({

                order_id: order.id,

                customer_name: order.customer_name,

                revenue: Number(order.subtotal || 0),

                food_cost: 0,

                packaging_cost: 0,

                total_cost: 0,

                profit: 0,

                exchange_rate: rateEntry.rate,

                exchange_rate_date: rateEntry.rate_date,

                exchange_rate_source: rateEntry.source,

                usd_revenue: 0,

                usd_profit: 0

            })
            .select()
            .single();

    if (saleError) {

        console.error(saleError);
        alert("Unable to create sale.");
        return false;

    }

    const { data: menuItems, error: menuError } =
        await supabaseClient
            .from("menu_items")
            .select("*");

    if (menuError) {

        console.error(menuError);
        return false;

    }

    const { data: recipeCosts, error: recipeCostError } =
        await supabaseClient
            .from("recipe_costs")
            .select("*");

    if (recipeCostError) {

        console.error(recipeCostError);
        return false;

    }

    const { data: packagingCosts, error: packagingCostError } =
        await supabaseClient
            .from("packaging_profile_costs")
            .select("*");

    if (packagingCostError) {

        console.error(packagingCostError);
        return false;

    }

    // Shared, pure, tested calculation module (js/sale-calculations.js) —
    // see tests/sale-calculations.test.js. This is the BUG-01 fix: a
    // builder ("Mix & Match") order line now produces a parent line that
    // owns its full revenue plus one child line per selection carrying
    // cost/quantity only, so the box's price is counted exactly once
    // instead of never. Standard order lines are unaffected.
    const referenceData =
        SaleCalculations.buildReferenceData(menuItems, recipeCosts, packagingCosts);

    const lines =
        SaleCalculations.buildSaleFromOrder(items, referenceData);

    // Phase 3: every line gets its USD figures from this SAME snapshotted
    // rate (js/currency-conversion.js), including guaranteeing the sum of
    // the lines' usd_line_revenue always reconciles exactly with the
    // sale's own usd_revenue — see applyRateToSaleLines for the rounding-
    // residual handling this requires.
    const linesWithUsd =
        CurrencyConversion.applyRateToSaleLines(lines, rateEntry.rate);

    const saleItems = linesWithUsd.map(line => ({

        sale_id: sale.id,

        menu_item_id: line.menu_item_id,

        item_name: line.item_name,

        quantity: line.quantity,

        unit_price: line.unit_price,

        food_cost: line.food_cost,

        packaging_cost: line.packaging_cost,

        total_cost: line.total_cost,

        line_revenue: line.line_revenue,

        line_profit: line.line_profit,

        usd_line_revenue: line.usd_line_revenue,

        usd_line_profit: line.usd_line_profit

    }));

    const { error: saleItemsError } =
        await supabaseClient
            .from("sale_items")
            .insert(saleItems);

    if (saleItemsError) {

        console.error(saleItemsError);
        alert("Unable to save sale items.");
        return false;

    }

    const totals = SaleCalculations.summarizeLines(lines);

    const usdTotals = CurrencyConversion.computeUsdSaleFigures({
        revenue: totals.revenue,
        totalCost: totals.totalCost,
        rate: rateEntry.rate
    });

    const { error: updateSaleError } =
        await supabaseClient
            .from("sales")
            .update({

                revenue: totals.revenue,

                food_cost: totals.foodCost,

                packaging_cost: totals.packagingCost,

                total_cost: totals.totalCost,

                profit: totals.profit,

                usd_revenue: usdTotals ? usdTotals.usdRevenue : null,

                usd_profit: usdTotals ? usdTotals.usdProfit : null

            })
            .eq("id", sale.id);

    if (updateSaleError) {

        console.error(updateSaleError);
        alert("Unable to finalize sale.");
        return false;

    }

    return true;

}


/* ==========================================
   EXCHANGE RATE HELPERS (Phase 3)
========================================== */

async function getCachedExchangeRate(dateStr) {

    const { data, error } =
        await supabaseClient
            .from("exchange_rates")
            .select("*")
            .eq("rate_date", dateStr)
            .maybeSingle();

    if (error) {

        console.error(error);
        return null;

    }

    return data;

}

async function saveExchangeRate(entry) {

    const { error } =
        await supabaseClient
            .from("exchange_rates")
            .upsert({

                rate_date: entry.rate_date,

                reference_date: entry.reference_date,

                rate: entry.rate,

                source: entry.source

            });

    if (error) throw error;

}

function promptManualExchangeRate(dateStr) {

    const input = prompt(
        `Couldn't retrieve the EUR→USD exchange rate for ${dateStr} from the live rate service.\n\nEnter it manually (e.g. 1.0921) to complete this sale, or press Cancel to leave the order as it was.`
    );

    if (input === null) return null;

    const parsed = Number(input);

    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;

}


/* ==========================================
   DELETE
========================================== */

async function deleteOrder(orderId) {

    if (!confirm("Delete this order?")) return;

    const { error } = await supabaseClient
        .from("orders")
        .delete()
        .eq("id", orderId);

    if (error) {

        console.error(error);
        alert(error.message);
        return;

    }

    await loadOrderManager();

}


/* ==========================================
   MANUAL ORDER MODAL
========================================== */

function openManualOrderModal() {

    manualOrderItems = {};
    manualBuilderBoxes = {};
    manualUnresolvedBuilderItems = [];

   document.querySelector(
    "#manualOrderModal .modal-header h2"
).textContent = "New Order";

document.querySelector(
    "#manualOrderModal .modal-footer .primary-btn"
).textContent = "Save Order";

    const modal = document.getElementById("manualOrderModal");

    if (!modal) return;

    resetManualOrderForm();

    modal.style.display = "flex";

    renderManualMenuItems();

    updateManualOrderSummary();

}

function closeManualOrderModal() {

    const modal =
        document.getElementById("manualOrderModal");

    if (modal) {

        modal.style.display = "none";

    }

    document.getElementById("editingOrderId").value = "";

    document.querySelector(
        "#manualOrderModal .modal-header h2"
    ).textContent = "New Order";

    document.querySelector(
        "#manualOrderModal .modal-footer .primary-btn"
    ).textContent = "Save Order";

    manualOrderItems = {};
    manualBuilderBoxes = {};
    manualUnresolvedBuilderItems = [];

}

function resetManualOrderForm() {

    setInputValue("manualCustomerName", "");
    setInputValue("manualCustomerPhone", "");
    setInputValue("manualCustomerEmail", "");
    setInputValue("manualContact", "text");
    setInputValue("manualSource", "website");
    setInputValue("manualOrderType", "weekly");
    setInputValue("manualPickupDate", getNextSundayForManualOrder());
    setInputValue("manualEventDate", "");
    setInputValue("manualCustomPickupDate", "");
    setInputValue("manualNotes", "");
    setInputValue("manualStatus", "pending");

    toggleManualOrderType();

}

function toggleManualOrderType() {

    const orderType = document.getElementById("manualOrderType")?.value || "weekly";
    const isCustom = orderType === "custom";

    const weeklyFields = document.getElementById("weeklyFields");
    const customFields = document.getElementById("customFields");

    if (weeklyFields) {
        weeklyFields.style.display = isCustom ? "none" : "block";
    }

    if (customFields) {
        customFields.style.display = isCustom ? "block" : "none";
    }

}

function renderManualMenuItems() {

    const container = document.getElementById("manualItems");

    if (!container) return;

    if (!menuItems.length) {

        container.innerHTML = `
            <p>No available menu items found.</p>
        `;

        return;

    }

    container.innerHTML = `
        ${renderManualUnresolvedBuilderItems()}

        <div class="manual-pos-list">
            ${menuItems.map(item => renderManualMenuItem(item)).join("")}
        </div>

        <div class="manual-order-summary">
            <div>
                <span>Total Items</span>
                <strong id="manualTotalItems">0</strong>
            </div>

            <div>
                <span>Subtotal</span>
                <strong id="manualSubtotal">€0.00</strong>
            </div>
        </div>
    `;

    updateManualSaveButtonState();

}

function renderManualUnresolvedBuilderItems() {

    if (!manualUnresolvedBuilderItems.length) return "";

    return `
        <div class="manual-pos-list" style="margin-bottom:16px;">
            <p><strong>Other custom items in this order</strong></p>
            <p><small>These can't be edited here — remove and have the customer re-build them at checkout if the contents need to change. Everything else on this order can still be edited normally.</small></p>

            ${manualUnresolvedBuilderItems.map(item => `
                <div class="manual-pos-item">
                    <div>
                        <strong>${escapeHtml(item.item_name)}</strong>
                        <small>
                            Qty ${item.quantity}
                            •
                            €${Number(item.price_at_purchase).toFixed(2)} each
                        </small>
                    </div>

                    <div class="manual-pos-controls">
                        <button
                            type="button"
                            class="delete-btn"
                            onclick="removeManualUnresolvedBuilderItem('${item.localId}')">
                            Remove
                        </button>
                    </div>
                </div>
            `).join("")}
        </div>
    `;

}

function removeManualUnresolvedBuilderItem(localId) {

    if (!confirm(
        "Remove this item from the order? Its full contents will be removed."
    )) return;

    manualUnresolvedBuilderItems = manualUnresolvedBuilderItems.filter(
        item => String(item.localId) !== String(localId)
    );

    renderManualMenuItems();
    updateManualOrderSummary();

}

function renderManualMenuItem(item) {

    if (item.product_type === "builder") {
        return renderManualBuilderBoxItem(item);
    }

    const price = Number(item.price || 0);

    return `
        <div class="manual-pos-item">

            <div>
                <strong>${escapeHtml(item.name)}</strong>

                <small>
                    ${escapeHtml(item.category || "Menu")}
                    •
                    €${price.toFixed(2)}
                </small>
            </div>

            <div class="manual-pos-controls">

                <button
                    type="button"
                    class="secondary-btn"
                    onclick="changeManualItemQuantity('${item.id}', -1)">
                    −
                </button>

                <span id="manualQty-${item.id}">
    ${manualOrderItems[item.id]?.quantity || 0}
</span>

                <button
                    type="button"
                    class="primary-btn"
                    onclick="changeManualItemQuantity('${item.id}', 1)">
                    +
                </button>

            </div>

        </div>
    `;

}

/* ==========================================
   MIX & MATCH BOX (embedded in the order editor)

   Reuses the same canonical eligibility/validation rules as the public
   Menu checkout (js/mix-and-match.js) -- never a hardcoded flavor list.
   ========================================== */

function renderManualBuilderBoxItem(item) {

    const box = manualBuilderBoxes[item.id];
    const boxQuantity = box ? box.boxQuantity : 0;
    const price = Number(item.price || 0);

    return `
        <div class="manual-pos-item manual-builder-box">

            <div>
                <strong>${escapeHtml(item.name)}</strong>

                <small>
                    ${escapeHtml(item.category || "Menu")}
                    •
                    €${price.toFixed(2)} per box
                </small>
            </div>

            <div class="manual-pos-controls">

                <button
                    type="button"
                    class="secondary-btn"
                    onclick="changeManualItemQuantity('${item.id}', -1)">
                    −
                </button>

                <span id="manualQty-${item.id}">
    ${boxQuantity}
</span>

                <button
                    type="button"
                    class="primary-btn"
                    onclick="changeManualItemQuantity('${item.id}', 1)">
                    +
                </button>

            </div>

        </div>

        ${boxQuantity > 0 ? renderManualBuilderSelector(item, box) : ""}
    `;

}

function renderManualBuilderSelector(item, box) {

    const eligibleCookies = MixAndMatch.getEligibleCookies(menuItems, item);
    const selectionsArray = builderSelectionsToArray(box.selections);
    const validation = MixAndMatch.validateBoxSelection(
        item.builder_size, box.boxQuantity, selectionsArray, eligibleCookies
    );

    const messages = {
        under: `Select ${validation.required - validation.selected} more to reach the required total.`,
        over: `Remove ${validation.selected - validation.required} to match the required total.`,
        missing: `This box needs ${validation.required} cookies selected below before it can be saved.`,
        stale: "One or more previously selected flavors are no longer available — remove or replace them below before saving."
    };

    return `
        <div class="manual-builder-selector">

            <div class="manual-builder-summary ${validation.status !== "ok" ? "manual-builder-summary-error" : ""}">
                Selected: ${validation.selected} / ${validation.required}
            </div>

            ${messages[validation.status] ? `<p class="manual-builder-message">${escapeHtml(messages[validation.status])}</p>` : ""}

            <div class="manual-builder-flavors">

                ${eligibleCookies.map(cookie => `
                    <div class="manual-builder-flavor-row">
                        <span>${escapeHtml(cookie.name)}</span>

                        <div class="manual-pos-controls">
                            <button
                                type="button"
                                class="secondary-btn"
                                onclick="changeManualBuilderCookieQuantity('${item.id}','${cookie.id}','${escapeJs(cookie.name)}',-1)">
                                −
                            </button>

                            <span>${(box.selections[cookie.id] && box.selections[cookie.id].quantity) || 0}</span>

                            <button
                                type="button"
                                class="primary-btn"
                                onclick="changeManualBuilderCookieQuantity('${item.id}','${cookie.id}','${escapeJs(cookie.name)}',1)">
                                +
                            </button>
                        </div>
                    </div>
                `).join("")}

                ${validation.staleSelections.map(selection => `
                    <div class="manual-builder-flavor-row manual-builder-flavor-stale">
                        <span>${escapeHtml(selection.name || "Unknown item")} — no longer available</span>

                        <div class="manual-pos-controls">
                            <button
                                type="button"
                                class="delete-btn"
                                onclick="removeManualBuilderStaleSelection('${item.id}','${selection.id}')">
                                Remove
                            </button>
                        </div>
                    </div>
                `).join("")}

            </div>

        </div>
    `;

}

/** {id: {name, quantity}} -> [{id, name, quantity}], canonical shape. */
function builderSelectionsToArray(selections) {
    return Object.keys(selections || {}).map(id => ({
        id,
        name: selections[id].name,
        quantity: selections[id].quantity
    }));
}

function changeManualItemQuantity(itemId, change) {

    const item = menuItems.find(menuItem => String(menuItem.id) === String(itemId));

    if (!item) return;

    if (item.product_type === "builder") {
        changeManualBuilderBoxQuantity(item, change);
        return;
    }

    const current = manualOrderItems[itemId]?.quantity || 0;
    const next = Math.max(0, current + change);

    if (next === 0) {

        delete manualOrderItems[itemId];

    } else {

        manualOrderItems[itemId] = {
            id: item.id,
            name: item.name,
            price: Number(item.price || 0),
            quantity: next
        };

    }

    const qtyElement = document.getElementById(`manualQty-${itemId}`);

    if (qtyElement) {
        qtyElement.textContent = next;
    }

    updateManualOrderSummary();

}

function changeManualBuilderBoxQuantity(builderProduct, change) {

    const existing = manualBuilderBoxes[builderProduct.id];
    const current = existing ? existing.boxQuantity : 0;
    const next = Math.max(0, current + change);

    if (next === 0) {

        // Requirement: removing a box removes its selection details with
        // it -- nothing to preserve once the whole line is gone.
        delete manualBuilderBoxes[builderProduct.id];

    } else if (existing) {

        existing.boxQuantity = next;

    } else {

        manualBuilderBoxes[builderProduct.id] = {
            id: builderProduct.id,
            name: builderProduct.name,
            builderGroup: builderProduct.builder_group,
            builderSize: Number(builderProduct.builder_size || 0),
            perBoxPrice: Number(builderProduct.price || 0),
            boxQuantity: next,
            selections: {}
        };

    }

    // A full re-render is needed either way: growing from 0 must reveal
    // the embedded selector, and shrinking to 0 must hide it again.
    renderManualMenuItems();
    updateManualOrderSummary();

}

function changeManualBuilderCookieQuantity(builderProductId, cookieId, cookieName, change) {

    const box = manualBuilderBoxes[builderProductId];

    if (!box) return;

    const current = (box.selections[cookieId] && box.selections[cookieId].quantity) || 0;
    const next = Math.max(0, current + change);

    if (next === 0) {
        delete box.selections[cookieId];
    } else {
        box.selections[cookieId] = { name: cookieName, quantity: next };
    }

    renderManualMenuItems();
    updateManualOrderSummary();

}

function removeManualBuilderStaleSelection(builderProductId, cookieId) {

    const box = manualBuilderBoxes[builderProductId];

    if (!box) return;

    delete box.selections[cookieId];

    renderManualMenuItems();
    updateManualOrderSummary();

}

/** Every Mix & Match box currently in an invalid state (see
 *  js/mix-and-match.js validateBoxSelection), used to disable Save and
 *  show inline messages -- boxes with no issue are excluded. */
function getManualBuilderValidationIssues() {

    return Object.values(manualBuilderBoxes)
        .map(box => {
            const liveProduct = menuItems.find(m => String(m.id) === String(box.id));
            const eligibleCookies = liveProduct
                ? MixAndMatch.getEligibleCookies(menuItems, liveProduct)
                : [];

            const validation = MixAndMatch.validateBoxSelection(
                box.builderSize,
                box.boxQuantity,
                builderSelectionsToArray(box.selections),
                eligibleCookies
            );

            return { box, validation };
        })
        .filter(({ validation }) => validation.status !== "ok");

}

function updateManualSaveButtonState() {

    const saveBtn = document.querySelector("#manualOrderModal .modal-footer .primary-btn");

    if (!saveBtn) return;

    const hasIssues = getManualBuilderValidationIssues().length > 0;

    saveBtn.disabled = hasIssues;
    saveBtn.title = hasIssues
        ? "Fix the Mix & Match selection issues above before saving."
        : "";

}

function updateManualOrderSummary() {

    const totalItems =
        OrderEditor.computeManualOrderItemCount(manualOrderItems, manualUnresolvedBuilderItems) +
        OrderEditor.computeBuilderBoxItemCount(manualBuilderBoxes);

    const subtotal = getManualOrderSubtotal();

    setText("manualTotalItems", totalItems);
    setText("manualSubtotal", `€${subtotal.toFixed(2)}`);

    updateManualSaveButtonState();

}

function getManualOrderItems() {

    return Object.values(manualOrderItems);

}

function getManualOrderSubtotal() {

    return OrderEditor.computeManualOrderSubtotal(manualOrderItems, manualUnresolvedBuilderItems) +
        OrderEditor.computeBuilderBoxSubtotal(manualBuilderBoxes);

}

async function saveManualOrder() {

   
    const editingOrderId = document.getElementById("editingOrderId").value;
    const customer_name = document.getElementById("manualCustomerName")?.value.trim();
    const customer_phone = document.getElementById("manualCustomerPhone")?.value.trim();
    const customer_email = document.getElementById("manualCustomerEmail")?.value.trim();
    const preferred_contact = document.getElementById("manualContact")?.value || "text";
    const source = document.getElementById("manualSource")?.value || "manual";
    const order_type = document.getElementById("manualOrderType")?.value || "weekly";
    const status = document.getElementById("manualStatus")?.value || "pending";
    const notesRaw = document.getElementById("manualNotes")?.value.trim();

    let pickup_date = null;
    let event_date = null;

    if (!customer_name) {
        alert("Please enter the customer name.");
        return;
    }

    if (!customer_phone) {
        alert("Please enter the customer phone number.");
        return;
    }

    const items = getManualOrderItems();

    const hasBuilderBoxes = Object.values(manualBuilderBoxes)
        .some(box => Number(box.boxQuantity || 0) > 0);

    if (!items.length && !manualUnresolvedBuilderItems.length && !hasBuilderBoxes) {
        alert("Please add at least one item.");
        return;
    }

    // Backstop for the disabled Save button (belt-and-braces in case it
    // was somehow bypassed): never write an order with an incomplete,
    // excessive, or stale Mix & Match selection.
    if (getManualBuilderValidationIssues().length) {
        alert("Please fix the Mix & Match selection issues before saving.");
        return;
    }

    // BUG-22 guard: re-check the order's *live* status right before writing,
    // not just when the editor was opened, so a completed order's frozen
    // sale record can never be silently invalidated by an edit — including
    // if it was completed by someone else in the time the editor was open.
    if (editingOrderId) {

        const { data: liveOrder, error: statusCheckError } =
            await supabaseClient
                .from("orders")
                .select("status")
                .eq("id", editingOrderId)
                .single();

        if (statusCheckError) {
            console.error(statusCheckError);
            alert(statusCheckError.message);
            return;
        }

        if (!OrderEditor.isOrderEditable(liveOrder)) {
            alert(
                "This order is already completed and its sale has been finalized, so it can no longer be edited. Its details are still visible on the order card."
            );
            closeManualOrderModal();
            await loadOrderManager();
            return;
        }

    }

    if (order_type === "weekly") {

        pickup_date = document.getElementById("manualPickupDate")?.value;

        if (!pickup_date) {
            alert("Please select a pickup date.");
            return;
        }

    } else {

        event_date = document.getElementById("manualEventDate")?.value;
        pickup_date = document.getElementById("manualCustomPickupDate")?.value;

        if (!event_date) {
            alert("Please select an event date.");
            return;
        }

        if (!pickup_date) {
            alert("Please select a pickup date.");
            return;
        }

    }

    const sourceLabel = getSourceLabel(source);

    const notes = [
        sourceLabel ? `Source: ${sourceLabel}` : "",
        notesRaw || ""
    ]
        .filter(Boolean)
        .join("\n\n");

    const subtotal = getManualOrderSubtotal();

    let order;
let error;

if (editingOrderId) {

    ({ data: order, error } =
        await supabaseClient
            .from("orders")
            .update({

                customer_name,
                customer_phone,
                customer_email,
                preferred_contact,
                order_type,
                pickup_date,
                event_date,
                notes,
                subtotal,
                status

            })
            .eq("id", editingOrderId)
            .select()
            .single());

} else {

    ({ data: order, error } =
        await supabaseClient
            .from("orders")
            .insert({

                customer_name,
                customer_phone,
                customer_email,
                preferred_contact,
                order_type,
                pickup_date,
                event_date,
                notes,
                subtotal,
                status

            })
            .select()
            .single());

}

    if (error) {

        console.error(error);
        alert(error.message);
        return;

    }

   if (editingOrderId) {

    const { error: deleteError } =
        await supabaseClient
            .from("order_items")
            .delete()
            .eq("order_id", editingOrderId);

    if (deleteError) {

        console.error(deleteError);
        alert(deleteError.message);
        return;

    }

}

    // BUG-02 fix: built by the shared, tested OrderEditor module. Any
    // unresolvable preserved lines are carried through exactly as loaded,
    // and every Mix & Match box (new or edited) is built fresh from its
    // live selections -- so re-inserting order_items on save can never
    // silently drop or corrupt a box.
    const orderItems = [
        ...OrderEditor.buildOrderItemsPayload(order.id, manualOrderItems, manualUnresolvedBuilderItems),
        ...OrderEditor.buildBuilderBoxOrderItems(order.id, manualBuilderBoxes)
    ];

    const { error: itemError } = await supabaseClient
        .from("order_items")
        .insert(orderItems);

    if (itemError) {

        console.error(itemError);
        alert(itemError.message);
        return;

    }

    closeManualOrderModal();

    await loadOrderManager();

}


/* ==========================================
   MANUAL ORDER HELPERS
========================================== */

function getNextSundayForManualOrder() {

    const today = new Date();
    const day = today.getDay();

    const daysUntilSunday =
        day === 0
            ? 7
            : 7 - day;

    const pickup = new Date(today);

    pickup.setDate(today.getDate() + daysUntilSunday);

    return pickup.toISOString().split("T")[0];

}

function getSourceLabel(source) {

    const labels = {
        website: "Website",
        facebook: "Facebook",
        messenger: "Messenger",
        instagram: "Instagram",
        phone: "Phone",
        text: "Text Message",
        in_person: "In Person",
        other: "Other",
        manual: "Manual"
    };

    return labels[source] || source;

}


/* ==========================================
   HELPERS
========================================== */

function capitalize(text) {

    const value = String(text || "");

    return value.charAt(0).toUpperCase() + value.slice(1);

}

function escapeHtml(text) {

    return String(text || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");

}

function escapeJs(value) {

    return String(value || "")
        .replaceAll("\\", "\\\\")
        .replaceAll("'", "\\'")
        .replaceAll('"', "&quot;")
        .replaceAll("\n", " ");

}

function formatDate(date) {

    if (!date) return "Not set";

    return new Date(date).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric"
    });

}

function setText(id, value) {

    const element = document.getElementById(id);

    if (element) {
        element.textContent = value;
    }

}

function setInputValue(id, value) {

    const element = document.getElementById(id);

    if (element) {
        element.value = value;
    }

}

async function reopenOrder(orderId) {

    if (
        !confirm(
            "Move this order back to Confirmed?\n\nThis will remove it from Sales."
        )
    ) {
        return;
    }

    await removeSaleFromOrder(orderId);

    const { error: orderError } =
        await supabaseClient
            .from("orders")
            .update({
                status: "confirmed"
            })
            .eq("id", orderId);

    if (orderError) {

        alert(orderError.message);
        return;

    }

    await loadOrderManager();

}

async function editOrder(orderId) {

    const { data: order, error } =
        await supabaseClient
            .from("orders")
            .select(`
                *,
                order_items(*)
            `)
            .eq("id", orderId)
            .single();

    if (error) {

        console.error(error);
        alert(error.message);
        return;

    }

    // BUG-22: a completed order's sale/sale_items record is already frozen
    // elsewhere in the schema. Editing it here would let orders/order_items
    // silently drift out of sync with that finalized record, so the editor
    // refuses to open at all for a completed order. The order itself stays
    // fully visible on its card either way.
    if (!OrderEditor.isOrderEditable(order)) {
        alert(
            "This order is already completed and its sale has been finalized, so it can no longer be edited. Its details are still visible on the order card."
        );
        return;
    }

    openManualOrderModal();

    document.getElementById("editingOrderId").value = order.id;

    document.querySelector("#manualOrderModal .modal-header h2").textContent =
        "Edit Order";

    document.querySelector(
        "#manualOrderModal .modal-footer .primary-btn"
    ).textContent = "Save Changes";

    setInputValue("manualCustomerName", order.customer_name);
    setInputValue("manualCustomerPhone", order.customer_phone);
    setInputValue("manualCustomerEmail", order.customer_email);
    setInputValue("manualContact", order.preferred_contact || "text");
    setInputValue("manualOrderType", order.order_type || "weekly");
    setInputValue("manualStatus", order.status || "pending");
    setInputValue("manualNotes", order.notes || "");

    if (order.order_type === "weekly") {

        setInputValue("manualPickupDate", order.pickup_date);

    } else {

        setInputValue("manualEventDate", order.event_date);
        setInputValue("manualCustomPickupDate", order.pickup_date);

    }

    toggleManualOrderType();

    // BUG-02 fix: partitioned by the shared, tested OrderEditor module so a
    // builder line (or any line with no resolvable menu_item_id) can never
    // collide with another under the single key `null` the way the old
    // inline logic here did. Builder lines are then matched back to their
    // live builder products (by name -- see groupBuilderItemsByLiveProduct)
    // so their existing Mix & Match selections load pre-filled and fully
    // editable; anything that can't be matched stays preserved, remove-only.
    const partitioned = OrderEditor.partitionOrderItemsForEditing(order.order_items);
    manualOrderItems = partitioned.flatItemsById;

    const liveBuilderProducts = menuItems.filter(m => m.product_type === "builder");
    const grouped = OrderEditor.groupBuilderItemsByLiveProduct(partitioned.builderItems, liveBuilderProducts);

    manualBuilderBoxes = grouped.builderBoxesById;
    manualUnresolvedBuilderItems = grouped.unresolvedBuilderItems;

   renderManualMenuItems();
updateManualOrderSummary();

}


/* ==========================================
   GLOBAL EXPORTS
========================================== */

window.toggleOrderSection = toggleOrderSection;
window.updateOrderStatus = updateOrderStatus;
window.deleteOrder = deleteOrder;
window.reopenOrder = reopenOrder;
window.editOrder = editOrder;

window.openManualOrderModal = openManualOrderModal;
window.closeManualOrderModal = closeManualOrderModal;
window.toggleManualOrderType = toggleManualOrderType;
window.changeManualItemQuantity = changeManualItemQuantity;
window.changeManualBuilderCookieQuantity = changeManualBuilderCookieQuantity;
window.removeManualBuilderStaleSelection = removeManualBuilderStaleSelection;
window.removeManualUnresolvedBuilderItem = removeManualUnresolvedBuilderItem;
window.saveManualOrder = saveManualOrder;
