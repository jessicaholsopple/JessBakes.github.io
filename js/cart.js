/* ==========================================
   CART.JS
========================================== */

// Pre-session-based cart key (localStorage, no expiry at all) -- kept
// only so readCartFromStorage() can find and remove it from a
// returning visitor's browser. Never written to again.
const LEGACY_CART_KEY = "jess_bakes_cart";

// The cart now lives in sessionStorage (cleared automatically when the
// tab/browser closes -- never indefinitely persistent) AND carries its
// own lastActivity timestamp so it also expires after 30 minutes of no
// cart activity even if the tab is left open. A customer was able to
// submit an order for an item no longer on the current menu because an
// old cart item survived indefinitely in localStorage; this, plus the
// live-menu revalidation below and the server-side validation in
// submit_order (see supabase/migrations/20260831090000_order_server_side_validation.sql),
// are the layered fix.
const CART_SESSION_KEY = "jess_bakes_cart_session";
const CART_EXPIRY_MS = 30 * 60 * 1000;

let cart = [];
let cartMenuItems = [];
let rerenderMenu = null;
let cartExpiryTimerId = null;
let menuRevalidationInFlight = false;

/** Reads the cart out of sessionStorage, treating it as empty (and
 *  discarding the stored value) if lastActivity is missing or more
 *  than CART_EXPIRY_MS old. Always removes the old localStorage key
 *  first, regardless of whether a session cart exists -- this is what
 *  makes "invalidate and remove any legacy cart data" true for every
 *  returning visitor's browser, not just new ones. */
function readCartFromStorage() {
    try {
        localStorage.removeItem(LEGACY_CART_KEY);
    } catch {
        // Not fatal -- e.g. localStorage disabled. The session cart
        // below is the real source of truth either way.
    }

    try {
        const raw = sessionStorage.getItem(CART_SESSION_KEY);
        if (!raw) return [];

        const parsed = JSON.parse(raw);
        const lastActivity = Number(parsed && parsed.lastActivity);
        const items = (parsed && Array.isArray(parsed.items)) ? parsed.items : [];

        if (!items.length || !Number.isFinite(lastActivity) || Date.now() - lastActivity > CART_EXPIRY_MS) {
            sessionStorage.removeItem(CART_SESSION_KEY);
            return [];
        }

        return items;
    } catch {
        return [];
    }
}

cart = readCartFromStorage();

/* ==========================================
   INITIALIZE
========================================== */

function initializeCart(menuItems, renderMenuCallback) {
    cartMenuItems = menuItems;
    rerenderMenu = renderMenuCallback;

    ensureCheckoutModal();

    // The menu this page just fetched (menu.js's loadMenu(), always
    // `.eq("available", true)`) is already live/current -- validate
    // the just-loaded cart against it synchronously, no extra network
    // round-trip needed for this first pass.
    validateCartAgainstMenu(cartMenuItems);

    renderCart();

    if (cartExpiryTimerId === null) {
        cartExpiryTimerId = setInterval(checkCartExpiry, 60 * 1000);
    }

    // Covers "returns from the background" / "resumes after being
    // idle": a tab that was hidden or unfocused for a while gets both
    // an expiry check and a fresh live-menu revalidation the moment it
    // becomes active again, never relying solely on the 60s interval
    // (which does not run reliably in a backgrounded/throttled tab).
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
            checkCartExpiry();
            refreshAndValidateCart();
        }
    });
    window.addEventListener("focus", () => {
        checkCartExpiry();
        refreshAndValidateCart();
    });
}

/* ==========================================
   SESSION STORAGE
========================================== */

function saveCart() {
    try {
        sessionStorage.setItem(CART_SESSION_KEY, JSON.stringify({
            items: cart,
            lastActivity: Date.now()
        }));
    } catch {
        // Not fatal -- the in-memory cart for this page view still works;
        // it just won't survive a reload if storage is unavailable.
    }
}

function clearCart() {
    cart = [];
    saveCart();
    renderCart();

    if (rerenderMenu) {
        rerenderMenu();
    }
}

/** Expires the cart after CART_EXPIRY_MS of no cart activity, even
 *  though the tab has stayed open the whole time (sessionStorage by
 *  itself only handles the "tab/browser closed" case). Reads the
 *  timestamp directly from storage rather than trusting any in-memory
 *  value, so it's correct even if another tab in the same session last
 *  touched the cart. */
function checkCartExpiry() {
    if (!cart.length) return;

    let lastActivity = 0;
    try {
        const raw = sessionStorage.getItem(CART_SESSION_KEY);
        lastActivity = Number(raw && JSON.parse(raw).lastActivity) || 0;
    } catch {
        lastActivity = 0;
    }

    if (lastActivity && Date.now() - lastActivity <= CART_EXPIRY_MS) {
        return;
    }

    cart = [];
    try {
        sessionStorage.removeItem(CART_SESSION_KEY);
    } catch {
        // ignore
    }
    renderCart();

    if (rerenderMenu) {
        rerenderMenu();
    }

    alert("Your cart was cleared after 30 minutes of inactivity. Please add your items again.");
}

/* ==========================================
   LIVE-MENU REVALIDATION

   Removes anything from the cart that is no longer on the current,
   live menu (inactive, unavailable, deleted, or -- for a Mix & Match
   box -- no longer resolvable at its original size/flavors), and
   silently-but-visibly refreshes the price of anything still valid
   but changed, rather than ever letting a stale price reach checkout.
   This is the client-side half of defense in depth; submit_order()
   enforces the same facts authoritatively server-side regardless of
   what this function does or misses.
========================================== */

/** Total cart-wide demand for each menu item, combining standalone
 *  lines and every Mix & Match box's selections of it -- see
 *  getCommittedQuantityForMenuItem's own comment on why the two
 *  purchase paths must be summed together, never checked separately. */
function computeCartWideDemand(cartLines) {
    const demand = {};
    (cartLines || []).forEach(item => {
        if (item.type === "builder") {
            (item.selections || []).forEach(selection => {
                const id = String(selection.id);
                demand[id] = (demand[id] || 0) + Number(selection.quantity || 0) * Number(item.quantity || 0);
            });
        } else {
            const id = String(item.id);
            demand[id] = (demand[id] || 0) + Number(item.quantity || 0);
        }
    });
    return demand;
}

function validateCartAgainstMenu(menuItems) {
    const liveItems = Array.isArray(menuItems) ? menuItems : [];
    const removedNames = [];
    const changedNames = [];

    // Which limited-stock items does the WHOLE cart currently ask for
    // more of than actually remains? Computed once, up front, across
    // every line (standalone + every builder box) together, since a
    // flavor sold both ways draws from one shared stock record and
    // can't be judged a line at a time. Any line touching an
    // over-committed item is removed below, with a clear explanation
    // -- simpler and safer than guessing how to split limited stock
    // fairly between competing lines; the customer can always re-add
    // up to the new live amount. This is a client-side courtesy only:
    // submit_order()'s own trigger-enforced reservation is what
    // actually guarantees no overselling (see
    // supabase/migrations/20261012121500_finished_stock_reconcile_triggers.sql).
    const demand = computeCartWideDemand(cart);
    const overCommittedIds = new Set();
    Object.keys(demand).forEach(id => {
        const liveItem = liveItems.find(m => String(m.id) === id);
        const remaining = (typeof MixAndMatch !== "undefined") ? MixAndMatch.getRemainingStock(liveItem) : null;
        if (remaining !== null && demand[id] > remaining) {
            overCommittedIds.add(id);
        }
    });

    cart = cart.filter(item => {
        if (item.type === "builder") {
            const builderProduct = liveItems.find(
                m => m.id === item.id && m.product_type === "builder" && m.available === true
            );

            if (!builderProduct) {
                removedNames.push(item.name);
                return false;
            }

            const eligible = (typeof MixAndMatch !== "undefined")
                ? MixAndMatch.getEligibleCookies(liveItems, builderProduct)
                : [];
            const eligibleIds = new Set(eligible.map(c => String(c.id)));
            const stillEligible = (item.selections || []).every(s => eligibleIds.has(String(s.id)));
            const touchesOverCommitted = (item.selections || []).some(s => overCommittedIds.has(String(s.id)));

            if (!stillEligible || touchesOverCommitted) {
                removedNames.push(item.name);
                return false;
            }

            if (Number(builderProduct.price) !== Number(item.price)) {
                item.price = Number(builderProduct.price);
                changedNames.push(item.name);
            }

            return true;
        }

        const menuItem = liveItems.find(
            m => m.id === item.id && m.product_type === "standard" && m.available === true
        );

        if (!menuItem) {
            removedNames.push(item.name);
            return false;
        }

        if (overCommittedIds.has(String(item.id))) {
            removedNames.push(item.name);
            return false;
        }

        if (Number(menuItem.price) !== Number(item.price)) {
            item.price = Number(menuItem.price);
            changedNames.push(item.name);
        }

        return true;
    });

    if (removedNames.length || changedNames.length) {
        saveCart();
        renderCart();

        if (rerenderMenu) {
            rerenderMenu();
        }
    }

    if (removedNames.length) {
        alert(
            "Some items in your cart are no longer available and were removed: " +
            removedNames.join(", ") + "."
        );
    } else if (changedNames.length) {
        alert(
            "The price changed for: " + changedNames.join(", ") +
            ". Your cart has been updated to the current price."
        );
    }

    return { removedNames, changedNames };
}

/** Fetches the live, current menu fresh from the database (never the
 *  cartMenuItems snapshot from whenever the page first loaded) and
 *  revalidates the cart against it. Called on tab resume and
 *  immediately before checkout/submit -- never trusts that nothing
 *  changed just because this page has been open a while. */
async function refreshAndValidateCart() {
    const noChange = { removedNames: [], changedNames: [] };

    if (menuRevalidationInFlight || typeof supabaseClient === "undefined") {
        return noChange;
    }

    menuRevalidationInFlight = true;

    try {
        const [menuResult, stockResult] = await Promise.all([
            supabaseClient.from("menu_items").select("*").eq("available", true),
            supabaseClient.from("menu_item_stock").select("menu_item_id, stock_mode, sold_out_behavior, available_count")
        ]);

        const { data, error } = menuResult;

        if (error || !data) {
            return noChange;
        }

        // Best-effort: a stock-fetch failure never blocks the
        // availability/price revalidation that already protects
        // checkout -- every item just falls back to made-to-order.
        if (!stockResult.error && stockResult.data && typeof MixAndMatch !== "undefined") {
            MixAndMatch.mergeStockOntoMenuItems(data, stockResult.data);
        }

        cartMenuItems = data;
        return validateCartAgainstMenu(cartMenuItems);
    } finally {
        menuRevalidationInFlight = false;
    }
}

/* ==========================================
   QUANTITY
========================================== */

function getCartQuantity(itemId) {
    const existing = cart.find(item => item.id === itemId);
    return existing ? existing.quantity : 0;
}

/** How many units of this menu item the cart ALREADY counts on right
 *  now, combining standalone lines and every Mix & Match box's
 *  selections of it -- the two purchase paths share one physical
 *  stock record (see MixAndMatch.hasAvailableStock's own comment), so
 *  a flavor sold both ways must be capped against their combined
 *  total, never either path in isolation. Per-flavor consumption for
 *  a builder line is selection.quantity * line.quantity, matching the
 *  exact formula the server's reconcile_order_stock() uses. */
function getCommittedQuantityForMenuItem(itemId) {
    let total = 0;
    cart.forEach(item => {
        if (item.type === "builder") {
            (item.selections || []).forEach(selection => {
                if (String(selection.id) === String(itemId)) {
                    total += Number(selection.quantity || 0) * Number(item.quantity || 0);
                }
            });
        } else if (String(item.id) === String(itemId)) {
            total += Number(item.quantity || 0);
        }
    });
    return total;
}

/** null = unlimited (made_to_order or untracked); a number = how many
 *  MORE units of this item can still be added to the cart right now,
 *  i.e. the live available_count minus whatever this cart already
 *  committed to it across every line. This never reserves anything by
 *  itself -- it's purely a client-side cap computed from the live
 *  menu snapshot, exactly like price/availability elsewhere in this
 *  file; the server is still the only real source of truth. */
function getRemainingStockForMenuItem(itemId) {
    const menuItem = cartMenuItems.find(item => item.id === itemId);
    const remaining = (typeof MixAndMatch !== "undefined")
        ? MixAndMatch.getRemainingStock(menuItem)
        : null;

    if (remaining === null) return null;

    return Math.max(remaining - getCommittedQuantityForMenuItem(itemId), 0);
}

function changeCartQuantity(itemId, change) {
    const menuItem = cartMenuItems.find(item => item.id === itemId);

    if (!menuItem) return;

    if (change > 0) {
        const remainingToAdd = getRemainingStockForMenuItem(itemId);
        if (remainingToAdd !== null && remainingToAdd <= 0) {
            alert(`Sorry, ${menuItem.name} is sold out.`);
            return;
        }
    }

    const existing = cart.find(item => item.id === itemId);

    if (!existing && change > 0) {
        cart.push({
    type: "standard",

    id: menuItem.id,

    name: menuItem.name,

    price: Number(menuItem.price),

    quantity: 1
});
    } else if (existing) {
        existing.quantity += change;

        if (existing.quantity <= 0) {
            cart = cart.filter(item => item.id !== itemId);
        }
    }

    saveCart();
    renderCart();

    if (rerenderMenu) {
        rerenderMenu();
    }
}

/* ==========================================
   BUILDER PRODUCTS
========================================== */

function openBuilderModal(builderId){

    const builder =
        cartMenuItems.find(i => i.id === builderId);

    if(!builder) return;

    // Shared with the Admin Orders editor (js/mix-and-match.js) so both
    // interfaces derive eligible flavors identically -- never a separate
    // hardcoded list, never a name match. cartMenuItems is already the
    // full, current, available-only menu_items fetch (see js/menu.js
    // loadMenu()), so no extra network round-trip is needed here.
    const options = MixAndMatch.getEligibleCookies(cartMenuItems, builder);

    showBuilderModal(builder,options);
}

function showBuilderModal(builder, options) {

   const builderSize = Number(builder.builder_size) || 4;

    let modal = document.getElementById("builderModal");

    if (!modal) {

        modal = document.createElement("div");

        modal.id = "builderModal";
        modal.className = "checkout-modal";

        document.body.appendChild(modal);

    }

    const selections = {};

    options.forEach(option => {

        selections[option.id] = 0;

    });

    function totalSelected() {

        return Object.values(selections)
            .reduce((a,b)=>a+b,0);

    }

    function render() {

        modal.innerHTML = `

<div class="checkout-card">

<div class="checkout-header">

<h2>${builder.name}</h2>

<button onclick="document.getElementById('builderModal').style.display='none'">

×

</button>

</div>

<p>

Pick exactly <strong>${builderSize}</strong> items.

</p>

${options.length === 0 ? `<p class="builder-empty-notice">No flavors are available for Mix &amp; Match right now -- please check back soon.</p>` : `

<div class="builder-options">

${options.map(option=>{
    const remainingToAdd = getRemainingStockForMenuItem(option.id);
    const atCap = remainingToAdd !== null && selections[option.id] >= remainingToAdd;
    const liveRemaining = (typeof MixAndMatch !== "undefined") ? MixAndMatch.getRemainingStock(option) : null;
    return `

<div class="builder-row">

<div>

<strong>${option.name}</strong>

${liveRemaining !== null ? `<span class="builder-stock-note">Only ${liveRemaining} left</span>` : ""}

</div>

<div class="builder-counter">

<button
type="button"
onclick="updateBuilderSelection('${option.id}',-1)">

−

</button>

<span>

${selections[option.id]}

</span>

<button
type="button"
onclick="updateBuilderSelection('${option.id}',1)"
${atCap ? "disabled" : ""}>

+

</button>

</div>

</div>

`;}).join("")}

</div>

`}

<hr>

<div class="checkout-total">

<span>

Selected

</span>

<strong>

${totalSelected()} / ${builderSize}

</strong>

</div>

<button

class="primary-btn"

${totalSelected() !== builderSize ? "disabled" : ""}

onclick="finishBuilderSelection()">

Add Box

</button>

</div>

`;

    }

    window.updateBuilderSelection=function(id,change){

        if (change > 0 && totalSelected() >= builderSize)
    return;

        if (change > 0) {
            const remainingToAdd = getRemainingStockForMenuItem(id);
            if (remainingToAdd !== null && selections[id] >= remainingToAdd) {
                return;
            }
        }

        selections[id]+=change;

        if(selections[id]<0){

            selections[id]=0;

        }

        render();

    }

    window.finishBuilderSelection=function(){

       if (totalSelected() !== builderSize) {

    alert(
        `Please select exactly ${builderSize} items.`
    );

    return;

}

        const chosen=[];

        options.forEach(option=>{

            if(selections[option.id]>0){

                chosen.push({

                    id:option.id,

                    name:option.name,

                    quantity:selections[option.id]

                });

            }

        });

        addBuilderToCart({

    type:"builder",

    id:builder.id,

    name:builder.name,

    price:Number(builder.price),

    quantity:1,

    builder_group:builder.builder_group,

    selections:chosen

});

        modal.style.display="none";

    }

    modal.style.display="flex";

    render();

}

function addBuilderToCart(builderProduct) {

    const existing = cart.find(item =>
        item.type === "builder" &&
        item.id === builderProduct.id &&
        JSON.stringify(item.selections) === JSON.stringify(builderProduct.selections)
    );

    if (existing) {

        existing.quantity++;

    } else {

        cart.push({

            type: "builder",

            id: builderProduct.id,

            name: builderProduct.name,

            price: Number(builderProduct.price),

            quantity: 1,

            selections: builderProduct.selections

        });

    }

    saveCart();

    renderCart();

    if (rerenderMenu) {
        rerenderMenu();
    }

}

/* ==========================================
   TOTALS
========================================== */

function getSubtotal() {
    return cart.reduce(
        (sum, item) => sum + item.price * item.quantity,
        0
    );
}

function getItemCount() {
    return cart.reduce(
        (sum, item) => sum + item.quantity,
        0
    );
}

/* ==========================================
   FLOATING CART
========================================== */

function renderCart() {
    let cartBox = document.getElementById("floatingCart");

    if (!cartBox) {
        cartBox = document.createElement("div");
        cartBox.id = "floatingCart";
        cartBox.className = "floating-cart";
        document.body.appendChild(cartBox);
    }

    if (!cart.length) {
        cartBox.style.display = "none";
        cartBox.innerHTML = "";
        return;
    }

    cartBox.style.display = "block";

    cartBox.innerHTML = `
        <div class="floating-cart-header">
            <strong>Your Order</strong>
            <span>${getItemCount()} item${getItemCount() === 1 ? "" : "s"}</span>
        </div>

        <div class="floating-cart-items">
            ${cart.map(item => {

    if (item.type === "builder") {

        return `

            <div class="floating-cart-line builder-cart-line">

                <div>

                    <strong>${escapeHtml(item.name)}</strong>

                    ${item.selections.map(selection => `

                        <div class="builder-selection">

                            • ${escapeHtml(selection.name)} × ${selection.quantity}

                        </div>

                    `).join("")}

                    <div>

                        Box × ${item.quantity}

                    </div>

                </div>

                <strong>

                    €${formatPrice(item.price * item.quantity)}

                </strong>

            </div>

        `;

    }

    return `

        <div class="floating-cart-line">

            <span>

                ${escapeHtml(item.name)} × ${item.quantity}

            </span>

            <strong>

                €${formatPrice(item.quantity * item.price)}

            </strong>

        </div>

    `;

}).join("")}
        </div>

        <div class="floating-cart-total">
            <span>Subtotal</span>
            <strong>€${formatPrice(getSubtotal())}</strong>
        </div>

        <button
            type="button"
            class="primary-btn cart-checkout-btn"
            onclick="openCheckoutModal()">
            Checkout
        </button>
    `;
}

/* ==========================================
   CHECKOUT MODAL
========================================== */

function ensureCheckoutModal() {
    if (document.getElementById("checkoutModal")) return;

    const modal = document.createElement("div");

    modal.id = "checkoutModal";
    modal.className = "checkout-modal";
    modal.style.display = "none";

    modal.innerHTML = `
        <div class="checkout-card">

            <div class="checkout-header">
                <h2>Checkout</h2>

                <button
                    type="button"
                    onclick="closeCheckoutModal()">
                    ×
                </button>
            </div>

            <div id="checkoutSummary"></div>

            <form id="checkoutForm" class="checkout-form">

                <div class="form-group">
                    <label>Full Name(First and Last)</label>
                    <input
                        id="customerName"
                        type="text"
                        required>
                </div>

                <div class="form-group">
                    <label>Email</label>
                    <input
                        id="customerEmail"
                        type="email"
                        required>
                </div>

                <div class="form-group">
                    <label>Phone</label>
                    <input
                        id="customerPhone"
                        type="tel"
                        required>
                </div>

                <div class="form-group">
                    <label>Order Type</label>

                    <select
                        id="orderType"
                        required
                        onchange="toggleCustomOrderDetails()">

                        <option value="weekly">
                            Weekly Sunday Pickup
                        </option>

                        <option value="custom">
                            Custom Order or Special Event
                        </option>

                    </select>

                    <div id="pickupInfo" class="pickup-info-card">

                    </div>
                </div>

                <div
                    id="customOrderDetailsGroup"
                    class="form-group"
                    style="display:none;">

                   <label>Event Date *</label>

                   <input
                   type="date"
                   id="eventDate">

                  <label style="margin-top:20px;">
                   Order Details
                  </label>

                  <textarea
                   id="customOrderDetails"
                   rows="5"
                   placeholder="Insert order details here...">
                  </textarea>

                  </div>

                <p class="checkout-email-notice">
                    Order updates are sent by email. After submitting your order, you'll receive an email confirming that your order request was received. Once your order is approved, you'll receive a second "Order Confirmed" email containing your payment options, order total, pickup date and time, and pickup-location information. Please make sure your email address is correct and check your spam or junk folder if you don't see either message.
                </p>

                <button
                    type="submit"
                    class="primary-btn">
                    Submit Order
                </button>

            </form>

            <div
                id="checkoutSuccess"
                class="checkout-success"
                style="display:none;">

                <h3>Thank you!</h3>

                <p>
                    Your order request has been submitted.
                    I'll review it and contact you shortly.
                </p>

                <p id="checkoutSuccessPickup"></p>

                <button
                    class="primary-btn"
                    onclick="closeCheckoutModal()">
                    Close
                </button>

            </div>

        </div>
    `;

    document.body.appendChild(modal);

    document
        .getElementById("checkoutForm")
        .addEventListener("submit", submitOrder);
}

/* ==========================================
   ORDER TYPE UI
========================================== */

/* ==========================================
   WEEKLY PICKUP SCHEDULE

   Every proposed pickup date shown to the customer -- both the initial
   "Your Pickup" card and the pre-submit re-check -- comes from the
   preview_weekly_pickup Supabase RPC, which computes the answer from
   the DATABASE clock and the currently saved schedule (never the
   customer's device clock/timezone, never a cached value: every call
   here is a fresh network request). The actually-saved order's
   pickup_date/pickup_time is independently enforced server-side too
   (the enforce_weekly_pickup_schedule trigger on orders -- see
   supabase/migrations/20260828100000_weekly_pickup_schedule.sql) --
   this module's job is only to show the customer an accurate preview
   and to catch the "cutoff crossed while checkout was open" case
   before submitting, never to be the actual authority for what gets
   saved.
   ========================================== */

// The most recently fetched preview, used only to detect "the cutoff
// moved since we last showed this" immediately before submit -- see
// submitOrder(). Never used as the value actually sent to the server.
let lastPickupPreview = null;

async function fetchPickupPreview() {

    const { data, error } = await supabaseClient.rpc("preview_weekly_pickup");

    if (error) {
        console.error(error);
        return null;
    }

    return Array.isArray(data) ? data[0] : data;

}

function renderPickupCard(preview) {

    const schedule = {
        pickupWeekday: preview.pickup_weekday,
        cutoffWeekday: preview.cutoff_weekday,
        cutoffTime: preview.cutoff_time
    };

    return `

        <strong>Weekly ${escapeHtml(WeeklySchedule.weekdayName(preview.pickup_weekday))} Pickup</strong>

        <p>
            ${escapeHtml(WeeklySchedule.describeScheduleRuleShort(schedule))}
        </p>

        <div class="pickup-date">

            <h4>Your Pickup</h4>

            <p>
                ${escapeHtml(WeeklySchedule.formatFullDate(preview.pickup_date))}
                <br>
                ${escapeHtml(WeeklySchedule.formatTime12h(preview.pickup_time))}
            </p>

            <p>
                The exact pickup location will be sent to you once your order is confirmed.
            </p>

        </div>

    `;

}

async function updatePickupInfo() {

    const box = document.getElementById("pickupInfo");

    const orderType = document.getElementById("orderType").value;

    if (orderType === "custom") {

        box.innerHTML = `

            <strong>Custom Orders</strong>

            <p>

               *** Custom orders must have a have a total of over €30 ***
               <br>
               -- For example, an order with a total less than €30 may not be ordered for pickup
               outside of the weekly Sunday pickup day. --
               <br>

                Select the date you need your order.
                <br>

                Use the notes below for anything else you'd like me to know.
                <br><br>

                The exact pickup location will be sent to you once your order is confirmed.

            </p>

        `;

        return;

    }

    box.innerHTML = `<p>Checking the current pickup schedule…</p>`;

    const preview = await fetchPickupPreview();

    // Vacation Mode (or any other transient error) could make this fail
    // -- never leave the checkout showing a stale or fabricated date.
    if (!preview) {
        box.innerHTML = `<p>Unable to determine the next pickup date right now. Please close and reopen checkout, or try again in a moment.</p>`;
        return;
    }

    lastPickupPreview = preview;

    box.innerHTML = renderPickupCard(preview);

}

async function toggleCustomOrderDetails() {
    const orderType = document.getElementById("orderType").value;
    const detailsGroup = document.getElementById("customOrderDetailsGroup");

    if (orderType === "custom") {
        detailsGroup.style.display = "block";
    } else {
        detailsGroup.style.display = "none";
        document.getElementById("customOrderDetails").value = "";
    }
   await updatePickupInfo();
}


/* ==========================================
   VACATION MODE GUARD

   A fresh, live check (never a cached flag) so that if Vacation Mode
   is turned on while a customer already has this page open, they
   still can't slip an order through. Independent of menu.js's own
   vacation check (which normally prevents this UI from ever being
   reachable in the first place, by never calling initializeCart()
   while a vacation is active) -- this is defense in depth, not the
   only guard. Fails OPEN (treats a query error as "not on vacation")
   so an unrelated network hiccup can never block ordinary ordering
   the rest of the year; see js/vacation-mode.js for the pure
   eligibility/status logic this mirrors.
========================================== */

async function isOrderingPausedForVacation() {
    if (typeof supabaseClient === "undefined") {
        return false;
    }

    const { data, error } = await supabaseClient
        .from("vacation_periods")
        .select("id")
        .maybeSingle();

    if (error) {
        console.error(error);
        return false;
    }

    return typeof VacationMode !== "undefined"
        ? VacationMode.isVacationActive(data)
        : !!(data && data.id);
}

const VACATION_ORDER_PAUSED_MESSAGE =
    "We're on a baking break right now and can't take new orders. Check the Menu page for details on when we reopen!";

/* ==========================================
   OPEN / CLOSE
========================================== */

async function openCheckoutModal() {
    if (!cart.length) {
        alert("Your cart is empty.");
        return;
    }

    if (await isOrderingPausedForVacation()) {
        alert(VACATION_ORDER_PAUSED_MESSAGE);
        return;
    }

    // Re-check the live menu right before showing checkout -- never
    // trust that cartMenuItems (fetched whenever this page first
    // loaded) is still accurate, especially after the cart survived a
    // tab resume. validateCartAgainstMenu() inside this call may empty
    // the cart entirely (and already alerts the customer why).
    await refreshAndValidateCart();

    if (!cart.length) {
        return;
    }

    document.getElementById("checkoutModal").style.display = "flex";
    document.getElementById("checkoutForm").style.display = "grid";
    document.getElementById("checkoutSuccess").style.display = "none";

    renderCheckoutSummary();
    await toggleCustomOrderDetails();
}

function closeCheckoutModal() {
    document.getElementById("checkoutModal").style.display = "none";
    document.getElementById("checkoutForm").reset();

   toggleCustomOrderDetails();
}

/* ==========================================
   SUMMARY
========================================== */

function renderCheckoutSummary() {
    const summary = document.getElementById("checkoutSummary");

    summary.innerHTML = `
        <div class="checkout-summary">
            ${cart.map(item => {

    if (item.type === "builder") {

        return `

            <div class="checkout-line">

                <div>

                    <strong>${escapeHtml(item.name)}</strong>

                    ${item.selections.map(selection => `

                        <div class="builder-selection">

                            • ${escapeHtml(selection.name)} × ${selection.quantity}

                        </div>

                    `).join("")}

                    <div>

                        Box × ${item.quantity}

                    </div>

                </div>

                <strong>

                    €${formatPrice(item.price * item.quantity)}

                </strong>

            </div>

        `;

    }

    return `

        <div class="checkout-line">

            <span>

                ${escapeHtml(item.name)} × ${item.quantity}

            </span>

            <strong>

                €${formatPrice(item.price * item.quantity)}

            </strong>

        </div>

    `;

}).join("")}

            <div class="checkout-total">
                <span>Subtotal</span>
                <strong>€${formatPrice(getSubtotal())}</strong>
            </div>
        </div>
    `;
}

/* ==========================================
   SUBMIT ORDER
========================================== */

async function submitOrder(event) {
    event.preventDefault();

    if (await isOrderingPausedForVacation()) {
        alert(VACATION_ORDER_PAUSED_MESSAGE);
        return;
    }

    const submitButton = event.target.querySelector("button[type='submit']");

    submitButton.disabled = true;
    submitButton.textContent = "Submitting...";

    const customer_name = document.getElementById("customerName").value.trim();
    const customer_email = document.getElementById("customerEmail").value.trim();
    const customer_phone = document.getElementById("customerPhone").value.trim();
    const order_type = document.getElementById("orderType").value;
    const custom_details = document.getElementById("customOrderDetails").value.trim();

    if (!customer_name) {
        alert("Please enter your name.");
        submitButton.disabled = false;
        submitButton.textContent = "Submit Order";
        return;
    }

    // Email is the only way order-received/order-confirmed updates ever
    // reach a customer -- required here even though the <input required>
    // attribute already blocks most empty submissions, since this
    // function is also exercised directly (tests, programmatic retries).
    if (!customer_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer_email)) {
        alert("Please enter a valid email address -- that's how I'll send your order updates.");
        submitButton.disabled = false;
        submitButton.textContent = "Submit Order";
        return;
    }

    if (!customer_phone) {
        alert("Please enter your phone number.");
        submitButton.disabled = false;
        submitButton.textContent = "Submit Order";
        return;
    }

    if (order_type === "custom" && !custom_details) {
        alert("Please add details for your custom order or event.");
        submitButton.disabled = false;
        submitButton.textContent = "Submit Order";
        return;
    }

    let event_date = null;
    let notes = custom_details;

    if (order_type === "weekly") {

        // Recalculate against the database clock immediately before
        // creating the order -- never trust whatever was shown when
        // checkout was first opened (the cutoff may have passed in the
        // meantime), the customer's device clock/timezone, or any
        // cached value. This is a genuinely fresh network request every
        // time submitOrder runs.
        const fresh = await fetchPickupPreview();

        if (!fresh) {
            alert("Unable to confirm your pickup date right now. Please try again.");

            submitButton.disabled = false;
            submitButton.textContent = "Submit Order";

            return;
        }

        const stale =
            !lastPickupPreview ||
            fresh.pickup_date !== lastPickupPreview.pickup_date ||
            fresh.pickup_time !== lastPickupPreview.pickup_time;

        if (stale) {

            // The cutoff crossed (or something else changed the
            // schedule) while checkout was open. Never submit the order
            // for the date that was shown a moment ago -- update the
            // card to the new authoritative date, explain what
            // happened, and require the customer to review and click
            // Submit again. No orders/order_items row is created on
            // this attempt.
            lastPickupPreview = fresh;
            document.getElementById("pickupInfo").innerHTML = renderPickupCard(fresh);

            alert(
                "The order cutoff passed while this page was open, so your pickup date just changed to " +
                WeeklySchedule.formatFullDate(fresh.pickup_date) +
                ". Please review your updated pickup date above and click Submit Order again to confirm."
            );

            submitButton.disabled = false;
            submitButton.textContent = "Submit Order";

            return;

        }

        notes = `Weekly ${WeeklySchedule.weekdayName(fresh.pickup_weekday)} Pickup`;

    } else {

        event_date =
            document.getElementById("eventDate").value;

    }

    // Final, fresh re-check against the live menu immediately before
    // submitting -- the same reasoning as the pickup-date re-check
    // above (never trust what was true when checkout first opened).
    // If anything was removed or had its price refreshed, do NOT
    // submit this attempt: the customer needs to see the updated
    // summary/total and click Submit again to confirm, exactly like
    // the pickup-cutoff-crossed case below.
    const revalidation = await refreshAndValidateCart();

    if (!cart.length) {
        submitButton.disabled = false;
        submitButton.textContent = "Submit Order";
        return;
    }

    if (revalidation.removedNames.length || revalidation.changedNames.length) {
        renderCheckoutSummary();

        submitButton.disabled = false;
        submitButton.textContent = "Submit Order";

        return;
    }

    const items = cart.map(item => ({

        menu_item_id:
            item.type === "builder"
                ? null
                : item.id,

        item_name: item.name,

        quantity: item.quantity,

        price_at_purchase: item.price,

        line_total:
            item.price * item.quantity,

        builder_details:
            item.type === "builder"
                ? {
                    builder_group: item.builder_group,
                    selections: item.selections
                }
                : null

    }));

    // One atomic call: the pickup_date/pickup_time actually saved for a
    // weekly order is computed authoritatively server-side (see
    // enforce_weekly_pickup_schedule in the migration) from the exact
    // same database clock fetchPickupPreview() just checked above --
    // never from anything this function sends. Likewise, every item's
    // price_at_purchase/line_total/builder_details and the order's own
    // subtotal are re-derived server-side from the live menu_items
    // table (see supabase/migrations/20260831090000_order_server_side_validation.sql)
    // -- whatever this function sends for those fields is validated,
    // never trusted outright, so a stale cart can never submit a
    // deleted/unavailable item or an old price. Both the order and
    // every order_items row are created in one transaction, so a
    // failure partway through (including a failed validation) can
    // never leave a headless order with no items, or a partial order
    // at all.
    const { data: order, error } = await supabaseClient.rpc("submit_order", {
        p_customer_name: customer_name,
        p_customer_email: customer_email,
        p_customer_phone: customer_phone,
        p_order_type: order_type,
        p_event_date: event_date,
        p_notes: notes,
        p_subtotal: getSubtotal(),
        p_items: items
    });

    if (error) {
        console.error(error);

        // Lost a last-moment race for limited freezer stock -- another
        // customer's order reserved it first (reconcile_order_stock()
        // raises this exact, friendly, recognizable message; see
        // supabase/migrations/20261012121500_finished_stock_reconcile_triggers.sql).
        // No order, no order_items, no stock movement was created for
        // this attempt. Refresh the cart to the new reality (this will
        // remove or already reflect the now-sold-out item) instead of
        // just showing a raw error -- the customer sees an updated
        // summary, not a dead end.
        if (/no longer has enough stock remaining/i.test(error.message || "")) {
            const revalidation = await refreshAndValidateCart();
            renderCheckoutSummary();

            if (!cart.length) {
                closeCheckoutModal();
            }

            // validateCartAgainstMenu() already alerted the customer by
            // name if it found and explained the change itself; only
            // fall back to the server's own (still friendly) message
            // when the client-side pass didn't already cover it.
            if (!revalidation.removedNames.length && !revalidation.changedNames.length) {
                alert(error.message);
            }

            submitButton.disabled = false;
            submitButton.textContent = "Submit Order";

            return;
        }

        alert(error.message);

        submitButton.disabled = false;
        submitButton.textContent = "Submit Order";

        return;
    }

    lastPickupPreview = null;
    clearCart();

    // Confirms the saved order matches exactly what the customer just
    // reviewed and submitted -- reads back the authoritative
    // pickup_date/pickup_time this same submit_order call actually
    // wrote, not anything computed client-side. Defensively unwraps in
    // case PostgREST returns a single-row RPC result as a 1-element
    // array rather than a bare object.
    const orderRow = Array.isArray(order) ? order[0] : order;
    const pickupNotice = document.getElementById("checkoutSuccessPickup");
    if (pickupNotice) {
        pickupNotice.textContent = (orderRow && orderRow.order_type === "weekly" && orderRow.pickup_date)
            ? `Pickup: ${WeeklySchedule.formatFullDate(orderRow.pickup_date)}, ${WeeklySchedule.formatTime12h(orderRow.pickup_time)}`
            : "";
    }

    document.getElementById("checkoutForm").reset();
    document.getElementById("customOrderDetailsGroup").style.display = "none";

    document.getElementById("checkoutForm").style.display = "none";
    document.getElementById("checkoutSuccess").style.display = "block";

    submitButton.disabled = false;
    submitButton.textContent = "Submit Order";
}

/* ==========================================
   HELPERS
========================================== */

function formatPrice(price) {
    return Number(price)
        .toFixed(2)
        .replace(/\.00$/, "");
}

function escapeHtml(text) {
    return String(text || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}
