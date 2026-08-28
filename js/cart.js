/* ==========================================
   CART.JS
========================================== */

const CART_KEY = "jess_bakes_cart";

let cart = [];
let cartMenuItems = [];
let rerenderMenu = null;

try {
    cart = JSON.parse(localStorage.getItem(CART_KEY)) || [];
} catch {
    cart = [];
}

/* ==========================================
   INITIALIZE
========================================== */

function initializeCart(menuItems, renderMenuCallback) {
    cartMenuItems = menuItems;
    rerenderMenu = renderMenuCallback;

    ensureCheckoutModal();
    renderCart();
}

/* ==========================================
   LOCAL STORAGE
========================================== */

function saveCart() {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
}

function clearCart() {
    cart = [];
    saveCart();
    renderCart();

    if (rerenderMenu) {
        rerenderMenu();
    }
}

/* ==========================================
   QUANTITY
========================================== */

function getCartQuantity(itemId) {
    const existing = cart.find(item => item.id === itemId);
    return existing ? existing.quantity : 0;
}

function changeCartQuantity(itemId, change) {
    const menuItem = cartMenuItems.find(item => item.id === itemId);

    if (!menuItem) return;

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

<div class="builder-options">

${options.map(option=>`

<div class="builder-row">

<div>

<strong>${option.name}</strong>

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
onclick="updateBuilderSelection('${option.id}',1)">

+

</button>

</div>

</div>

`).join("")}

</div>

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
                        type="email">
                </div>

                <div class="form-group">
                    <label>Phone</label>
                    <input
                        id="customerPhone"
                        type="tel"
                        required>
                </div>

                <div class="form-group">

    <label>Preferred Contact Method</label>

    <select id="preferredContact" required>

        <option value="text">
            Text Message
        </option>

        <option value="email">
            Email
        </option>

    </select>

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
    const preferred_contact = document.getElementById("preferredContact").value;
    const order_type = document.getElementById("orderType").value;
    const custom_details = document.getElementById("customOrderDetails").value.trim();

    if (!customer_name) {
        alert("Please enter your name.");
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
    // never from anything this function sends. Both the order and every
    // order_items row are created in one transaction, so a failure
    // partway through can never leave a headless order with no items.
    const { data: order, error } = await supabaseClient.rpc("submit_order", {
        p_customer_name: customer_name,
        p_customer_email: customer_email,
        p_customer_phone: customer_phone,
        p_preferred_contact: preferred_contact,
        p_order_type: order_type,
        p_event_date: event_date,
        p_notes: notes,
        p_subtotal: getSubtotal(),
        p_items: items
    });

    if (error) {
        console.error(error);
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
