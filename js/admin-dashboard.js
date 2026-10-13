/*==================================================
    DASHBOARD INITIALIZATION
==================================================*/

document.addEventListener("DOMContentLoaded", async () => {

    await requireAuth();

    if (typeof setupLogout === "function") {
        setupLogout();
    }

    updateGreeting();

    await Promise.all([
        loadDashboardOrders(),
        loadDashboardReviews(),
        loadDashboardInventory()
    ]);

});


/*==================================================
    DASHBOARD HEADER
==================================================*/

function updateGreeting() {

    const greeting =
        document.getElementById("dashboardGreeting");

    const date =
        document.getElementById("dashboardDate");

    const hour =
        new Date().getHours();

    let message =
        "Good Morning,";

    if (hour >= 12) {
        message = "Good Afternoon,";
    }

    if (hour >= 17) {
        message = "Good Evening,";
    }

    if (greeting) {
        greeting.textContent = message;
    }

    if (date) {

        date.textContent =
            new Date().toLocaleDateString(
                "en-US",
                {
                    weekday: "long",
                    month: "long",
                    day: "numeric"
                }
            );

    }

}


/*==================================================
    ORDERS
==================================================*/

async function loadDashboardOrders() {

    // Orders drive everything on this page EXCEPT revenue (recent-orders
    // list, pending count, upcoming pickups, notifications) -- all keyed
    // by order_placement/pickup dates, which is correct and untouched.
    // Revenue is a SEPARATE query against `sales`, which is the only
    // table that records when an order actually became completed
    // (sales.completed_at, defaulted by the database to now() at the
    // moment js/admin-orders.js's createSaleFromOrder() inserts the
    // row -- never copied from orders.created_at). Querying `sales`
    // directly here, instead of deriving revenue from
    // orders.created_at the way this function used to, is the fix:
    // revenue for an order placed Oct 10 and completed Oct 13 must
    // land in Oct 13's total, not Oct 10's.
    const [ordersResult, salesResult] =
        await Promise.all([
            supabaseClient
                .from("orders")
                .select(`
                    *,
                    order_items(*)
                `)
                .order("created_at", { ascending: false }),

            supabaseClient
                .from("sales")
                .select("completed_at, revenue")
        ]);

    const { data, error } = ordersResult;

    if (error) {

        console.error("Dashboard orders error:", error);

        setDashboardMessage(
            "recentOrders",
            "Unable to load orders."
        );

        return;

    }

    if (salesResult.error) {
        console.error("Dashboard sales error:", salesResult.error);
    }

    const orders =
        (data || []).map(order => ({
            ...order,
            subtotal: Number(order.subtotal) || 0,
            order_items: Array.isArray(order.order_items)
                ? order.order_items
                : []
        }));

    const sales =
        (salesResult.data || []).map(sale => ({
            completed_at: sale.completed_at,
            revenue: Number(sale.revenue) || 0
        }));

    const pending =
        orders.filter(order => order.status === "pending");

    setText(
        "orderCount",
        pending.length
    );

    renderRecentOrders(
        orders.slice(0, 6)
    );

    calculateRevenue(sales);

    renderUpcomingPickups(orders);

    buildNotifications(orders);

    updateDashboardSummary(orders);

}


/*==================================================
    RECENT ORDERS
==================================================*/

function renderRecentOrders(orders) {

    const container =
        document.getElementById("recentOrders");

    if (!container) return;

    if (!orders.length) {

        container.innerHTML =
            `<p class="dashboard-home-empty">No orders yet.</p>`;

        return;

    }

    container.innerHTML =
        orders.map(order => {

            const itemCount =
                order.order_items.reduce(
                    (sum, item) =>
                        sum + Number(item.quantity || 0),
                    0
                );

            return `

                <article class="dashboard-home-order">

                    <div class="dashboard-home-order-person">

                        <div class="dashboard-home-avatar">
                            ${getInitials(order.customer_name)}
                        </div>

                        <div>

                            <strong>
                                ${escapeHtml(order.customer_name)}
                            </strong>

                            <small>
                                ${formatDate(order.created_at)}
                                ·
                                ${itemCount}
                                item${itemCount === 1 ? "" : "s"}
                            </small>

                        </div>

                    </div>

                    <div class="dashboard-home-order-meta">

                        <strong>
                            ${euro(order.subtotal)}
                        </strong>

                        <span class="status-badge status-${escapeHtml(order.status)}">
                            ${capitalize(order.status)}
                        </span>

                    </div>

                </article>

            `;

        }).join("");

}


/*==================================================
    REVENUE
==================================================*/

/** `sales` here is the completed-order revenue ledger fetched in
 *  loadDashboardOrders() -- NOT the `orders` table. Each row's own
 *  `completed_at` (database-generated at the moment the order was
 *  actually marked Completed) is what every bucket below is grouped
 *  by, via Europe/Berlin calendar-day/week/month boundaries
 *  (js/revenue-date.js) -- never the admin's own browser timezone. */
function calculateRevenue(sales) {

    const now = new Date();

    let todayTotal = 0;
    let weekTotal = 0;
    let monthTotal = 0;

    sales.forEach(sale => {

        if (!sale.completed_at) {
            return;
        }

        const revenue = sale.revenue;

        if (RevenueDate.isSameBerlinDay(now, sale.completed_at)) {
            todayTotal += revenue;
        }

        if (RevenueDate.isSameBerlinWeek(now, sale.completed_at)) {
            weekTotal += revenue;
        }

        if (RevenueDate.isSameBerlinMonth(now, sale.completed_at)) {
            monthTotal += revenue;
        }

    });

    setText(
        "salesToday",
        euro(todayTotal)
    );

    setText(
        "salesWeek",
        euro(weekTotal)
    );

    setText(
        "salesMonth",
        euro(monthTotal)
    );

}


/*==================================================
    UPCOMING PICKUPS
==================================================*/

function renderUpcomingPickups(orders) {

    const container =
        document.getElementById("upcomingPickups");

    if (!container) return;

    const upcoming =
        orders
            .filter(order =>
                ["confirmed", "ready"].includes(order.status)
            )
            .sort((a, b) => {

                const dateA =
                    new Date(
                        a.event_date ||
                        a.pickup_date ||
                        a.created_at
                    );

                const dateB =
                    new Date(
                        b.event_date ||
                        b.pickup_date ||
                        b.created_at
                    );

                return dateA - dateB;

            })
            .slice(0, 5);

    if (!upcoming.length) {

        container.innerHTML =
            `<p class="dashboard-home-empty">No upcoming pickups.</p>`;

        return;

    }

    container.innerHTML =
        upcoming.map(order => {

            const pickupDate =
                order.event_date ||
                order.pickup_date ||
                order.created_at;

            return `

                <article class="dashboard-home-pickup">

                    <div class="dashboard-home-pickup-date">

                        <strong>
                            ${formatShortDay(pickupDate)}
                        </strong>

                        <span>
                            ${formatShortMonth(pickupDate)}
                        </span>

                    </div>

                    <div class="dashboard-home-pickup-person">

                        <strong>
                            ${escapeHtml(order.customer_name)}
                        </strong>

                        <small>
                            ${
                                order.order_type === "custom"
                                    ? "Custom order"
                                    : "Weekly pickup"
                            }
                        </small>

                    </div>

                    <span class="status-badge status-${escapeHtml(order.status)}">
                        ${capitalize(order.status)}
                    </span>

                </article>

            `;

        }).join("");

}


/*==================================================
    NOTIFICATIONS
==================================================*/

function buildNotifications(orders) {

    const panel =
        document.getElementById("notificationsPanel");

    if (!panel) return;

    const notifications = [];

    const pending =
        orders.filter(order => order.status === "pending").length;

    const ready =
        orders.filter(order => order.status === "ready").length;

    const custom =
        orders.filter(order => order.order_type === "custom").length;

    if (pending) {

        notifications.push({
            tone: "warning",
            label:
                `${pending} pending order${pending === 1 ? "" : "s"} need confirmation.`
        });

    }

    if (ready) {

        notifications.push({
            tone: "success",
            label:
                `${ready} order${ready === 1 ? " is" : "s are"} ready for pickup.`
        });

    }

    if (custom) {

        notifications.push({
            tone: "info",
            label:
                `${custom} custom order${custom === 1 ? "" : "s"} on the schedule.`
        });

    }

    if (!notifications.length) {

        notifications.push({
            tone: "success",
            label:
                "Everything looks good today."
        });

    }

    panel.innerHTML =
        notifications.map(notification => `

            <div class="dashboard-home-notification dashboard-home-notification-${notification.tone}">

                <span class="dashboard-home-notification-dot"></span>

                <p>
                    ${escapeHtml(notification.label)}
                </p>

            </div>

        `).join("");

}


/*==================================================
    REVIEWS
==================================================*/

async function loadDashboardReviews() {

    const { data, error } =
        await AdminReviewsShared.fetchPendingReviews(supabaseClient);

    if (error) {

        console.error("Dashboard reviews error:", error);

        setDashboardMessage(
            "recentReviews",
            "Unable to load reviews."
        );

        return;

    }

    const reviews =
        data || [];

    setText(
        "pendingReviewCount",
        reviews.length
    );

    renderRecentReviews(
        reviews.slice(0, 3)
    );

}


/*==================================================
    RECENT REVIEWS
==================================================*/

function renderRecentReviews(reviews) {

    const container =
        document.getElementById("recentReviews");

    if (!container) return;

    if (!reviews.length) {

        container.innerHTML =
            `<p class="dashboard-home-empty">No pending reviews.</p>`;

        return;

    }

    container.innerHTML =
        reviews.map(review => `

            <article class="dashboard-home-review">

                <div class="dashboard-home-review-stars">
                    ${renderStars(review.rating)}
                </div>

                <p>
                    “${escapeHtml(review.review)}”
                </p>

                <strong>
                    ${escapeHtml(review.name)}
                </strong>

            </article>

        `).join("");

}


/*==================================================
    INVENTORY
==================================================*/

async function loadDashboardInventory() {

    const { data, error } =
        await supabaseClient
            .from("ingredients")
            .select("*");

    if (error) {

        console.warn("Dashboard inventory error:", error);

        setText(
            "inventoryAlerts",
            "0"
        );

        return;

    }

    const ingredients =
        data || [];

    const lowStock =
        ingredients.filter(item => {

            const quantity =
                Number(
                    item.quantity ??
                    item.quantity_on_hand ??
                    item.current_quantity ??
                    0
                );

            const minimum =
                Number(
                    item.minimum_quantity ??
                    item.minimum_stock ??
                    item.reorder_level ??
                    0
                );

            return minimum > 0 && quantity <= minimum;

        });

    setText(
        "inventoryAlerts",
        lowStock.length
    );

}


/*==================================================
    DASHBOARD SUMMARY
==================================================*/

function updateDashboardSummary(orders) {

    const summary =
        document.getElementById("dashboardSummary");

    if (!summary) return;

    const pending =
        orders.filter(order => order.status === "pending").length;

    const upcoming =
        orders.filter(order =>
            ["confirmed", "ready"].includes(order.status)
        ).length;

    summary.textContent =
        `${pending} order${pending === 1 ? "" : "s"} waiting · ` +
        `${upcoming} upcoming pickup${upcoming === 1 ? "" : "s"}`;

}


/*==================================================
    HELPERS
==================================================*/

function euro(value) {

    return new Intl.NumberFormat(
        "de-DE",
        {
            style: "currency",
            currency: "EUR"
        }
    ).format(
        Number(value) || 0
    );

}

function formatDate(date) {

    if (!date) {
        return "Not set";
    }

    return new Date(date)
        .toLocaleDateString(
            "en-US",
            {
                month: "short",
                day: "numeric",
                year: "numeric"
            }
        );

}

function formatShortDay(date) {

    return new Date(date)
        .toLocaleDateString(
            "en-US",
            {
                day: "2-digit"
            }
        );

}

function formatShortMonth(date) {

    return new Date(date)
        .toLocaleDateString(
            "en-US",
            {
                month: "short"
            }
        )
        .toUpperCase();

}

function capitalize(text) {

    const value =
        String(text || "");

    return (
        value.charAt(0).toUpperCase() +
        value.slice(1)
    );

}

function getInitials(name) {

    const initials =
        String(name || "?")
            .trim()
            .split(/\s+/)
            .slice(0, 2)
            .map(part => part.charAt(0))
            .join("")
            .toUpperCase();

    return initials || "?";

}

function renderStars(rating) {

    const value =
        Math.max(
            0,
            Math.min(
                5,
                Number(rating) || 0
            )
        );

    return (
        "★".repeat(value) +
        "☆".repeat(5 - value)
    );

}

function setText(id, value) {

    const element =
        document.getElementById(id);

    if (element) {
        element.textContent = value;
    }

}

function setDashboardMessage(id, message) {

    const element =
        document.getElementById(id);

    if (element) {

        element.innerHTML =
            `<p class="dashboard-home-empty">${escapeHtml(message)}</p>`;

    }

}

function escapeHtml(text) {

    return String(text || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");

}
