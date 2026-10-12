const MENU_CATEGORY_NAMES = {
    bread: "Sourdough Bread",
    cookie: "Sourdough Cookies",
    dessert: "Desserts",
    seasonal: "Seasonal Specials"
};

let menuItems = [];

document.addEventListener("DOMContentLoaded", () => {
    loadMenu();
});

async function loadMenu() {

    const container = document.getElementById("menuContainer");

    container.innerHTML = "<p>Loading menu...</p>";

    const vacation = await fetchActiveVacationStatusForMenu();

    if (typeof VacationMode !== "undefined" && VacationMode.isVacationActive(vacation)) {
        await renderMenuVacationNotice(vacation);
        return;
    }

    const { data, error } = await supabaseClient
        .from("menu_items")
        .select("*")
        .eq("available", true)
        .order("category", { ascending: true })
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true });

    if (error) {

        console.error(error);

        container.innerHTML = `
            <article class="notice-card">
                <h2>Unable to load menu.</h2>
                <p>Please try again later.</p>
            </article>
        `;

        return;

    }

    menuItems = data || [];

    // Finished-product freezer stock (separate table, new feature --
    // see supabase/migrations/20261012120000_finished_stock_schema.sql).
    // Best-effort: a failure here must never block the menu from
    // rendering -- every item just falls back to its default
    // made-to-order behavior (no stock_mode set at all) if this fails.
    await attachFinishedStock(menuItems);

    menuItems = menuItems.filter(item => !isHiddenSoldOut(item));

    renderMenu();

    if (typeof initializeCart === "function") {
        initializeCart(menuItems, renderMenu);
    }

}

async function attachFinishedStock(items) {
    try {
        const { data, error } = await supabaseClient
            .from("menu_item_stock")
            .select("menu_item_id, stock_mode, sold_out_behavior, available_count");

        if (error || !data || typeof MixAndMatch === "undefined") return;

        MixAndMatch.mergeStockOntoMenuItems(items, data);
    } catch (err) {
        console.error(err);
        // Fail open -- see comment at the call site.
    }
}

/** A sold-out 'limited' item whose admin chose "hide" (rather than
 *  "show as Sold Out") disappears from the public menu entirely --
 *  menu_items.available itself is untouched, so it reappears
 *  automatically the moment stock is replenished. */
function isHiddenSoldOut(item) {
    return item.stock_mode === "limited" &&
        Number(item.available_count) <= 0 &&
        item.sold_out_behavior === "hide";
}

function renderMenu() {

    const container = document.getElementById("menuContainer");

    if (!menuItems.length) {

        container.innerHTML = `
            <article class="notice-card">
                <h2>Menu Coming Soon</h2>
                <p>Fresh bakes will appear here soon.</p>
            </article>
        `;

        return;

    }

    let html = "";

    Object.keys(MENU_CATEGORY_NAMES).forEach(category => {

        const categoryItems = menuItems.filter(
            item => item.category === category
        );

        if (!categoryItems.length) return;

        html += `

            <div class="menu-section">

                <div class="menu-section-title">

                    <h2>${MENU_CATEGORY_NAMES[category]}</h2>

                </div>

                <div class="menu-grid ${category === "cookie" ? "two" : ""}">

                    ${categoryItems.map(renderMenuCard).join("")}

                </div>

            </div>

        `;

    });

    container.innerHTML = html;

}

function renderMenuCard(item) {

    const quantity =
        typeof getCartQuantity === "function"
            ? getCartQuantity(item.id)
            : 0;

    // Finished-product freezer stock badge/cap -- made_to_order items
    // (stock_mode unset, the default for every item until an admin
    // explicitly switches it) are completely unaffected: `limited` is
    // false, no badge, no cap, exactly today's behavior.
    const limited = item.stock_mode === "limited";
    const remaining = limited ? Math.max(Number(item.available_count) || 0, 0) : null;
    const soldOut = limited && remaining <= 0;
    const atStockCap = limited && quantity >= remaining;

    const stockBadge = soldOut
        ? `<span class="stock-badge stock-badge-soldout">Sold out</span>`
        : limited
            ? `<span class="stock-badge">Only ${remaining} left</span>`
            : "";

    return `

<article class="menu-item ${item.category === "cookie" ? "full" : ""}">

    <div class="menu-item-top">

        <h3>

            ${escapeHtml(item.name)}

            ${item.featured
                ? `<span class="featured-badge">★ Featured</span>`
                : ""}

        </h3>

        <span class="price">

            €${formatPrice(item.price)}

        </span>

    </div>

    <p class="menu-description">

        ${escapeHtml(item.description || "").replace(/\n/g,"<br>")}

    </p>

    ${stockBadge}

    <div class="menu-order-actions">

        ${
            soldOut && quantity === 0

                ? `<button type="button" class="add-cart-btn" disabled>Sold Out</button>`

                : quantity > 0

                ? `

                    <button
                        type="button"
                        onclick="changeCartQuantity('${item.id}',-1)">

                        −

                    </button>

                    <span>${quantity}</span>

                    <button
                        type="button"
                        onclick="changeCartQuantity('${item.id}',1)"
                        ${atStockCap ? "disabled" : ""}>

                        +

                    </button>

                `

                : `

                    <button
    type="button"
    class="add-cart-btn"
    onclick="${
        item.product_type === "builder"
            ? `openBuilderModal('${item.id}')`
            : `changeCartQuantity('${item.id}',1)`
    }">

    Add to Cart

</button>

                `

        }

    </div>

</article>

`;

}

function formatPrice(price) {

    const value = Number(price);

    if (Number.isNaN(value)) {

        return "0";

    }

    return value
        .toFixed(2)
        .replace(/\.00$/, "");

}

/* ==========================================
   VACATION MODE -- Menu page notice

   Checked BEFORE the orderable-menu query even runs, so no Add to
   Cart control or checkout modal is ever created while a vacation is
   active (initializeCart() is simply never called). Fails OPEN on a
   query error -- see the identical reasoning in js/cart.js's
   isOrderingPausedForVacation(), which independently re-checks at
   checkout time regardless of what this page rendered.
   ========================================== */

async function fetchActiveVacationStatusForMenu() {

    const { data, error } = await supabaseClient
        .from("vacation_periods")
        .select("id, heading, message, reopen_at, next_pickup_at")
        .maybeSingle();

    if (error) {
        console.error(error);
        return null;
    }

    return data || null;

}

async function renderMenuVacationNotice(vacation) {

    const container = document.getElementById("menuContainer");
    const reopenLabel = typeof VacationMode !== "undefined"
        ? VacationMode.formatBakeryDateTime(vacation.reopen_at)
        : "";

    container.innerHTML = `
        <article class="notice-card vacation-notice">
            <h2>${escapeHtml(vacation.heading || "We're on a baking break!")}</h2>
            ${vacation.message ? `<p>${escapeHtml(vacation.message).replace(/\n/g, "<br>")}</p>` : ""}
            ${reopenLabel ? `<p><strong>Ordering reopens:</strong> ${escapeHtml(reopenLabel)}</p>` : ""}
            <div id="menuVacationBallotLink" class="vacation-ballot-link" hidden>
                <a href="index.html#ballotContainer">Help choose what we bake next &rarr;</a>
            </div>
            <div id="menuVacationSubscribeMount"></div>
        </article>
    `;

    if (typeof mountSubscribeWidget === "function") {
        mountSubscribeWidget("menuVacationSubscribeMount", "vacation_menu");
    }

    const hasBallot = await checkActiveBallotExistsForMenu();
    const link = document.getElementById("menuVacationBallotLink");
    if (link) {
        link.hidden = !hasBallot;
    }

}

async function checkActiveBallotExistsForMenu() {

    const { data, error } = await supabaseClient
        .from("ballot_settings")
        .select("id")
        .eq("active", true)
        .limit(1)
        .maybeSingle();

    if (error) {
        console.error(error);
        return false;
    }

    return !!data;

}

function escapeHtml(text) {

    return String(text || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");

}
