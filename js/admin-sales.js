/*==================================================
    ADMIN SALES DASHBOARD
==================================================*/

let salesOrders = [];
let salesMenuItems = [];

let revenueChart = null;
let categoryChart = null;
let currentSalesRange = "today";


document.addEventListener("DOMContentLoaded", async () => {
    await requireAuth();

    if (typeof setupLogout === "function") {
        setupLogout();
    }

    try {
        await ensureChartJs();
        bindSalesControls();
        await loadSalesDashboard();
    } catch (error) {
        console.error("Sales dashboard failed to initialize:", error);
    }
});

function ensureChartJs() {
    if (window.Chart) return Promise.resolve();

    return new Promise((resolve, reject) => {
        const existing = document.querySelector('script[src*="chart.js"]');

        if (existing) {
            existing.addEventListener("load", resolve, { once: true });
            existing.addEventListener("error", reject, { once: true });
            return;
        }

        const script = document.createElement("script");
        script.src = "https://cdn.jsdelivr.net/npm/chart.js";
        script.onload = resolve;
        script.onerror = () => reject(new Error("Chart.js could not be loaded."));
        document.head.appendChild(script);
    });
}

function bindSalesControls() {
    document.querySelectorAll(".sales-filters .filter-btn").forEach((button) => {
        button.addEventListener("click", () => {
            document.querySelectorAll(".sales-filters .filter-btn")
                .forEach((item) => item.classList.remove("active"));

            button.classList.add("active");
            currentSalesRange = normalizeRange(button.textContent);
            renderSalesDashboard();
        });
    });

    document.getElementById("exportCsv")?.addEventListener("click", exportSalesCsv);
    document.getElementById("exportExcel")?.addEventListener("click", exportSalesCsv);
    document.getElementById("printSales")?.addEventListener("click", () => window.print());
}

async function loadSalesDashboard() {
    const [
    ordersResult,
    menuResult
] = await Promise.all([

    supabaseClient
        .from("sales")
        .select(`
            *,
            sale_items(*)
        `)
        .order("completed_at", { ascending: false }),

    supabaseClient
        .from("menu_items")
        .select(`
            id,
            name,
            category,
            recipe_id,
            recipe_units_used,
            packaging_profile_id
        `)
]);

    if (ordersResult.error) {
        console.error("Unable to load orders:", ordersResult.error);
        showSalesError("Unable to load sales data.");
        return;
    }

    if (menuResult.error) {
        console.warn("Unable to load menu categories:", menuResult.error);
    }

// Phase 3: Sales reports in USD (confirmed rule — see
// docs/bakery-rebuild/03-bug-register.md BUG-06/BUG-19). Every money field
// below is read from the explicit usd_* columns, never the original EUR
// revenue/line_revenue columns (which stay untouched, frozen, in the
// database as the historical source of truth). total_cost is already
// USD-denominated (ingredient/recipe/packaging costs), so it's unchanged.
salesOrders = (ordersResult.data || []).map((sale) => ({
    ...sale,

    subtotal: Number(sale.usd_revenue) || 0,

    revenue: Number(sale.usd_revenue) || 0,
    total_cost: Number(sale.total_cost) || 0,
    profit: Number(sale.usd_profit) || 0,

    order_items: Array.isArray(sale.sale_items)
        ? sale.sale_items.map((item) => ({
            ...item,
            line_revenue: Number(item.usd_line_revenue) || 0,
            line_profit: Number(item.usd_line_profit) || 0
        }))
        : []

}));

salesMenuItems = menuResult.data || [];

renderSalesDashboard();
}

// BUG-12: the former calculateSaleCost() here was fully unused (every
// profit figure the page shows comes from the already-correct, frozen
// `sales`/`sale_items` columns via createSaleFromOrder() and
// js/sale-calculations.js — see BUG-01) and, being dead code, had drifted
// unsafe: it computed ingredient cost as purchase_price / purchase_size
// with no unit conversion at all, which would have silently mispriced any
// ingredient whose purchase unit differs from its recipe unit. Removed
// rather than fixed in place, since a correct, shared, tested
// implementation already exists in js/sale-calculations.js if a live
// recalculation feature is ever wanted here.

function renderSalesDashboard() {

    const completedOrders = salesOrders;

    const activeOrders = [];

    updateSalesCards(completedOrders, activeOrders);
    updateLifetimeCards(completedOrders);

    const filteredCompleted = filterOrdersByRange(completedOrders, currentSalesRange);

    renderRevenueTrend(filteredCompleted, currentSalesRange);
    renderCategoryRevenue(filteredCompleted);
    renderBestSellers(filteredCompleted);
    renderRecentSales(filteredCompleted);
    renderSalesForecast(completedOrders);
    renderBusinessInsights(completedOrders, activeOrders);
    renderMonthlyRevenue(completedOrders);
    renderProfitBreakdown(filteredCompleted);
}

// Every bucket below groups by order.completed_at (sales.completed_at
// -- database-generated at the moment the order was actually marked
// Completed) against its Europe/Berlin calendar day/week/month/year,
// never the admin's own browser timezone (js/revenue-date.js).
function updateSalesCards(completedOrders, activeOrders) {
    const now = new Date();

    const todayRevenue = sumRevenue(
        completedOrders.filter((order) => RevenueDate.isSameBerlinDay(now, order.completed_at))
    );

    const weekRevenue = sumRevenue(
        completedOrders.filter((order) => RevenueDate.isSameBerlinWeek(now, order.completed_at))
    );

    const monthRevenue = sumRevenue(
        completedOrders.filter((order) => RevenueDate.isSameBerlinMonth(now, order.completed_at))
    );

    const yearRevenue = sumRevenue(
        completedOrders.filter((order) => RevenueDate.isSameBerlinYear(now, order.completed_at))
    );

    const totalRevenue = sumRevenue(completedOrders);
    const pendingRevenue = sumRevenue(activeOrders);

    setText("salesToday", usd(todayRevenue));
    setText("salesWeek", usd(weekRevenue));
    setText("salesMonth", usd(monthRevenue));
    setText("salesYear", usd(yearRevenue));
    setText("averageOrder", usd(completedOrders.length ? totalRevenue / completedOrders.length : 0));
    setText("completedOrders", completedOrders.length);
    setText("pendingRevenue", usd(pendingRevenue));

    const profit = calculateProfit(completedOrders);
    setText("grossProfit", usd(profit.grossProfit));
}

function updateLifetimeCards(completedOrders) {
    const revenue = sumRevenue(completedOrders);
    const itemsSold = completedOrders.reduce(
        (total, order) => total + order.order_items.reduce(
            (sum, item) => sum + Number(item.quantity || 0),
            0
        ),
        0
    );

    setText("lifetimeRevenue", usd(revenue));
    setText("lifetimeOrders", completedOrders.length);
    setText("lifetimeItems", itemsSold);
    setText("lifetimeAverage", usd(completedOrders.length ? revenue / completedOrders.length : 0));
}

function renderRevenueTrend(orders, range) {
    const canvas = getOrCreateCanvas("salesChart");
    if (!canvas || !window.Chart) return;

    const grouped = buildRevenueSeries(orders, range);

    if (revenueChart) revenueChart.destroy();

    revenueChart = new Chart(canvas, {
        type: "line",
        data: {
            labels: grouped.labels,
            datasets: [{
                label: "Revenue",
                data: grouped.values,
                borderWidth: 2,
                tension: 0.3,
                fill: false
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        callback: (value) => `$${value}`
                    }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (context) => usd(context.parsed.y)
                    }
                }
            }
        }
    });
}

function buildRevenueSeries(orders, range) {
    const grouped = new Map();

    orders.forEach((order) => {
        let key;
        let label;

        if (range === "year" || range === "all") {
            key = RevenueDate.berlinMonthKey(order.completed_at);
            label = RevenueDate.formatBerlinMonthLabel(order.completed_at);
        } else {
            key = RevenueDate.berlinDateKey(order.completed_at);
            label = RevenueDate.formatBerlinDate(order.completed_at, { includeYear: false });
        }

        if (!grouped.has(key)) grouped.set(key, { label, value: 0 });
        grouped.get(key).value += Number(order.subtotal) || 0;
    });

    const sorted = [...grouped.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([, value]) => value);

    if (!sorted.length) {
        return { labels: ["No completed sales"], values: [0] };
    }

    return {
        labels: sorted.map((item) => item.label),
        values: sorted.map((item) => item.value)
    };
}

function renderCategoryRevenue(orders) {
    const container = document.getElementById("categoryRevenue");
    if (!container) return;

    container.innerHTML = `<div style="height:320px;"><canvas id="categoryRevenueChart"></canvas></div>`;
    const canvas = document.getElementById("categoryRevenueChart");

    const totals = { bread: 0, cookie: 0, dessert: 0, seasonal: 0, other: 0 };

    orders.forEach((order) => {
        order.order_items.forEach((item) => {
            const category = getItemCategory(item);
            // sale_items rows carry line_revenue (already remapped to the
            // USD figure above), not order_items' line_total/price_at_purchase
            // — those fields don't exist here. This was silently always 0.
            const lineTotal = Number(item.line_revenue) || 0;
            totals[category] = (totals[category] || 0) + lineTotal;
        });
    });

    const entries = Object.entries(totals).filter(([, value]) => value > 0);

    if (!entries.length) {
        container.innerHTML = "<p>No completed sales in this period.</p>";
        return;
    }

    if (categoryChart) categoryChart.destroy();

    categoryChart = new Chart(canvas, {
        type: "doughnut",
        data: {
            labels: entries.map(([key]) => formatCategory(key)),
            datasets: [{
                data: entries.map(([, value]) => value),
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                tooltip: {
                    callbacks: {
                        label: (context) => `${context.label}: ${usd(context.parsed)}`
                    }
                }
            }
        }
    });
}

function renderBestSellers(orders) {
    const container = document.getElementById("bestSellers");
    if (!container) return;

    const totals = {};

    orders.forEach((order) => {
        order.order_items.forEach((item) => {
            const name = item.item_name || "Unknown item";
            totals[name] = (totals[name] || 0) + Number(item.quantity || 0);
        });
    });

    const sorted = Object.entries(totals)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

    if (!sorted.length) {
        container.innerHTML = "<p>No completed sales in this period.</p>";
        return;
    }

    container.innerHTML = sorted.map(([name, quantity], index) => `
        <div class="best-seller-row">
            <span>${index + 1}. ${escapeHtml(name)}</span>
            <strong>${quantity} sold</strong>
        </div>
    `).join("");
}

function renderRecentSales(orders) {

    const container =
        document.getElementById("recentSales");

    if (!container) return;

    if (!orders.length) {

        container.innerHTML =
            "<p>No completed sales in this period.</p>";

        return;

    }

    container.innerHTML =
        orders
            .slice()
            .sort(
                (a, b) =>
                    new Date(b.completed_at) -
                    new Date(a.completed_at)
            )
            .slice(0, 10)
            .map(renderSaleCard)
            .join("");

}

function renderSaleCard(order) {

    const items =
        order.order_items
            .map(item => `

                <div class="sale-item-row">

                    <span>

                        ${escapeHtml(item.item_name)}

                    </span>

                    <strong>

                        ×${item.quantity}

                    </strong>

                </div>

            `)
            .join("");

    return `

<div class="sale-card">

    <button
        class="sale-toggle"
        onclick="toggleSaleDetails('${order.id}')">

        View Details

    </button>

    <div class="sale-card-header">

        <div>

            <h3>

                ${escapeHtml(order.customer_name)}

            </h3>

            <small>

                ${formatDate(order.completed_at)}

            </small>

        </div>

        <strong>

            ${usd(order.subtotal)}

        </strong>

    </div>

    <div
    class="sale-details"
    id="sale-${order.id}"
    style="display:none;">

    <div class="sale-items">

        ${items}

    </div>

</div>

<div class="sale-summary">

        <div>

            Revenue

            <strong>

                ${usd(order.subtotal)}

            </strong>

        </div>

        <div>

            Profit

            <strong>

                ${usd(
    calculateProfit([order]).grossProfit
)}

            </strong>

        </div>

    </div>

</div>

`;

}

function toggleSaleDetails(id) {

    const details =
        document.getElementById(`sale-${id}`);

    if (!details) return;

    details.style.display =
        details.style.display === "none"
            ? "block"
            : "none";

}


function renderSalesForecast(completedOrders) {
    const container = document.getElementById("salesForecast");
    if (!container) return;

    const recentStart = new Date();
    recentStart.setDate(recentStart.getDate() - 28);
    recentStart.setHours(0, 0, 0, 0);

    const recentOrders = completedOrders.filter(
        (order) => new Date(order.completed_at) >= recentStart
    );

    const recentRevenue = sumRevenue(recentOrders);
    const weeklyAverage = recentRevenue / 4;
    const monthlyForecast = weeklyAverage * 4.345;

    container.innerHTML = `
        <div class="sales-metric-list">
            <div><span>Average weekly revenue</span><strong>${usd(weeklyAverage)}</strong></div>
            <div><span>Projected next 30 days</span><strong>${usd(monthlyForecast)}</strong></div>
        </div>
        <small>Forecast is based on the most recent 28 days of completed sales.</small>
    `;
}

function renderBusinessInsights(completedOrders, activeOrders) {
    const container = document.getElementById("salesInsights");
    if (!container) return;

    const insights = [];

    if (!completedOrders.length) {
        insights.push("Complete orders to begin building sales insights.");
    } else {
        const totalRevenue = sumRevenue(completedOrders);
        const average = totalRevenue / completedOrders.length;
        insights.push(`Your completed-order average is ${usd(average)}.`);

        const bestSeller = getTopSeller(completedOrders);
        if (bestSeller) {
            insights.push(`${bestSeller.name} is your top seller with ${bestSeller.quantity} sold.`);
        }

        const bestDay = getBestSalesDay(completedOrders);
        if (bestDay) {
            insights.push(`${bestDay.label} is currently your strongest sales day.`);
        }
    }

    if (activeOrders.length) {
        insights.push(`${activeOrders.length} active order${activeOrders.length === 1 ? "" : "s"} represent ${usd(sumRevenue(activeOrders))} in pending revenue.`);
    }

    container.innerHTML = `<ul class="sales-insights-list">${insights.map((insight) => `<li>${escapeHtml(insight)}</li>`).join("")}</ul>`;
}

function renderMonthlyRevenue(completedOrders) {
    const container = document.getElementById("monthlyRevenue");
    if (!container) return;

    const grouped = {};

    completedOrders.forEach((order) => {
        const key = RevenueDate.berlinMonthKey(order.completed_at);
        const label = RevenueDate.formatBerlinMonthLabelLong(order.completed_at);

        if (!grouped[key]) grouped[key] = { label, revenue: 0, orders: 0 };
        grouped[key].revenue += Number(order.subtotal) || 0;
        grouped[key].orders += 1;
    });

    const rows = Object.entries(grouped)
        .sort((a, b) => b[0].localeCompare(a[0]))
        .slice(0, 12);

    if (!rows.length) {
        container.innerHTML = "<p>No monthly revenue yet.</p>";
        return;
    }

    container.innerHTML = `
        <div class="sales-table">
            <div class="sales-table-row sales-table-header">
                <span>Month</span><span>Orders</span><span>Revenue</span>
            </div>
            ${rows.map(([, item]) => `
                <div class="sales-table-row">
                    <span>${escapeHtml(item.label)}</span>
                    <span>${item.orders}</span>
                    <strong>${usd(item.revenue)}</strong>
                </div>
            `).join("")}
        </div>
    `;
}

function renderProfitBreakdown(orders) {
    const container = document.getElementById("profitBreakdown");
    if (!container) return;

    const profit = calculateProfit(orders);

    container.innerHTML = `
        <div class="sales-metric-list">
            <div><span>Revenue</span><strong>${usd(profit.revenue)}</strong></div>
            <div><span>Estimated cost</span><strong>${usd(profit.cost)}</strong></div>
            <div><span>Gross profit</span><strong>${usd(profit.grossProfit)}</strong></div>
            <div><span>Gross margin</span><strong>${profit.margin.toFixed(1)}%</strong></div>
        </div>
    `;
}

function calculateProfit(sales) {

    let revenue = 0;
    let cost = 0;
    let grossProfit = 0;

    sales.forEach(order => {

        revenue += Number(order.revenue || 0);

        cost += Number(order.total_cost || 0);

        grossProfit += Number(order.profit || 0);

    });


    return {

        revenue,

        cost,

        grossProfit,

        margin:
            SaleCalculations.computeMargin(revenue, grossProfit)

    };

}


function exportSalesCsv() {
    const completedOrders = salesOrders;
    const rows = [["Order ID", "Customer", "Date", "Status", "Items", "Subtotal (USD)"]];

    completedOrders.forEach((order) => {
        const itemSummary = order.order_items
            .map((item) => `${item.item_name} x${item.quantity}`)
            .join("; ");

        rows.push([
            order.id,
            order.customer_name,
            formatDate(order.completed_at),
            "Completed",
            itemSummary,
            Number(order.subtotal).toFixed(2)
        ]);
    });

    const csv = rows.map((row) =>
        row.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",")
    ).join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `jess-bakes-sales-${new Date().toISOString().split("T")[0]}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
}

function filterOrdersByRange(orders, range) {
    if (range === "all") return orders.slice();

    const now = new Date();

    return orders.filter((order) => {
        if (range === "today") return RevenueDate.isSameBerlinDay(now, order.completed_at);
        if (range === "week") return RevenueDate.isSameBerlinWeek(now, order.completed_at);
        if (range === "month") return RevenueDate.isSameBerlinMonth(now, order.completed_at);
        if (range === "year") return RevenueDate.isSameBerlinYear(now, order.completed_at);
        return true;
    });
}

function normalizeRange(text) {
    const value = String(text || "").trim().toLowerCase();
    if (value.includes("all")) return "all";
    if (value.includes("week")) return "week";
    if (value.includes("month")) return "month";
    if (value.includes("year")) return "year";
    return "today";
}

function getTopSeller(orders) {
    const totals = {};

    orders.forEach((order) => {
        order.order_items.forEach((item) => {
            const name = item.item_name || "Unknown item";
            totals[name] = (totals[name] || 0) + Number(item.quantity || 0);
        });
    });

    const top = Object.entries(totals).sort((a, b) => b[1] - a[1])[0];
    return top ? { name: top[0], quantity: top[1] } : null;
}

function getBestSalesDay(orders) {
    const totals = {};

    orders.forEach((order) => {
        const label = RevenueDate.berlinWeekdayName(order.completed_at);
        totals[label] = (totals[label] || 0) + Number(order.subtotal || 0);
    });

    const top = Object.entries(totals).sort((a, b) => b[1] - a[1])[0];
    return top ? { label: top[0], revenue: top[1] } : null;
}

function getItemCategory(item) {
    const menuItem = salesMenuItems.find(
        (menu) => String(menu.id) === String(item.menu_item_id)
    );

    const category = menuItem?.category || "other";
    return ["bread", "cookie", "dessert", "seasonal"].includes(category)
        ? category
        : "other";
}

function formatCategory(category) {
    const labels = {
        bread: "Bread",
        cookie: "Cookies",
        dessert: "Desserts",
        seasonal: "Seasonal",
        other: "Other"
    };

    return labels[category] || category;
}

function getOrCreateCanvas(id) {
    const element = document.getElementById(id);
    if (!element) return null;
    if (element.tagName === "CANVAS") return element;

    element.innerHTML = `<canvas id="${id}Canvas"></canvas>`;
    return document.getElementById(`${id}Canvas`);
}

function showSalesError(message) {
    [
        "recentSales",
        "bestSellers",
        "categoryRevenue",
        "salesForecast",
        "salesInsights",
        "monthlyRevenue",
        "profitBreakdown"
    ].forEach((id) => {
        const element = document.getElementById(id);
        if (element) element.innerHTML = `<p>${escapeHtml(message)}</p>`;
    });
}

function sumRevenue(orders) {
    return orders.reduce((total, order) => total + (Number(order.subtotal) || 0), 0);
}

function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
}

// Phase 3: Sales reports in USD (confirmed rule), formatted unambiguously
// with the $ symbol so it's never mistaken for the EUR amounts customers
// actually pay (Menu/Cart/Checkout/Orders — unaffected by this change).
function usd(value) {
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD"
    }).format(Number(value) || 0);
}

// Displayed in Europe/Berlin, not the admin's own browser timezone --
// consistent with the Berlin calendar day this sale is actually
// grouped/totaled under everywhere above (RevenueDate.isSameBerlinDay
// and friends), so a sale completed right around midnight never shows
// a date that disagrees with which day's revenue it was counted in.
function formatDate(date) {
    return RevenueDate.formatBerlinDate(date);
}

function escapeHtml(text) {
    return String(text || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

window.loadSalesDashboard = loadSalesDashboard;
window.exportSalesCsv = exportSalesCsv;
