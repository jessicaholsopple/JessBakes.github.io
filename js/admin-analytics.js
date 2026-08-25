/* ADMIN ANALYTICS — SALES-BASED */

let analyticsSales = [];
let currentAnalyticsRange = "30";
let ordersChart = null;
let popularityChart = null;

document.addEventListener("DOMContentLoaded", async () => {
    await requireAuth();
    if (typeof setupLogout === "function") setupLogout();

    try {
        await ensureChartJs();
        bindAnalyticsFilters();
        await loadAnalytics();
    } catch (error) {
        console.error("Analytics failed to initialize:", error);
        showAnalyticsError("Unable to initialize analytics.");
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

function bindAnalyticsFilters() {
    const buttons = document.querySelectorAll(".sales-filters .filter-btn");

    buttons.forEach(button => {
        button.addEventListener("click", () => {
            buttons.forEach(item => item.classList.remove("active"));
            button.classList.add("active");
            currentAnalyticsRange = normalizeAnalyticsRange(button.textContent);
            renderAnalytics();
        });
    });
}

async function loadAnalytics() {
    const { data, error } = await supabaseClient
        .from("sales")
        .select(`
            *,
            sale_items(*),
            orders(order_items(*))
        `)
        .order("completed_at", { ascending: false });

    if (error) {
        console.error("Unable to load analytics:", error);
        showAnalyticsError("Unable to load analytics data.");
        return;
    }

    // Phase 3: Analytics reports in USD (confirmed rule — see
    // docs/bakery-rebuild/03-bug-register.md BUG-06/BUG-19). revenue/profit
    // and line_revenue/line_profit are read from the explicit usd_* columns,
    // never the original EUR revenue/line_revenue columns (which stay
    // untouched, frozen, in the database). *_cost columns are already
    // USD-denominated, so they're unchanged.
    //
    // order_items (fetched via the sale's own order_id) is carried through
    // untouched, purely so Product Breakdown can reclassify Mix & Match
    // parent/child sale_items rows by their original builder_details --
    // see js/sale-calculations.js classifySaleItems. It contributes no
    // dollar figures of its own; every number displayed still comes from
    // the frozen sale_items columns above.
    analyticsSales = (data || []).map(sale => ({
        ...sale,
        revenue: Number(sale.usd_revenue) || 0,
        food_cost: Number(sale.food_cost) || 0,
        packaging_cost: Number(sale.packaging_cost) || 0,
        total_cost: Number(sale.total_cost) || 0,
        profit: Number(sale.usd_profit) || 0,
        order_items: Array.isArray(sale.orders?.order_items) ? sale.orders.order_items : [],
        sale_items: Array.isArray(sale.sale_items)
            ? sale.sale_items.map(item => ({
                ...item,
                quantity: Number(item.quantity) || 0,
                unit_price: Number(item.unit_price) || 0,
                food_cost: Number(item.food_cost) || 0,
                packaging_cost: Number(item.packaging_cost) || 0,
                total_cost: Number(item.total_cost) || 0,
                line_revenue: Number(item.usd_line_revenue) || 0,
                line_profit: Number(item.usd_line_profit) || 0
            }))
            : []
    }));

    renderAnalytics();
}

function renderAnalytics() {
    const sales = filterSalesByRange(analyticsSales, currentAnalyticsRange);

    updateOverview(sales);
    renderOrdersOverTime(sales);
    renderProductPopularity(sales);
    renderProductRankings(sales);
    renderCustomerInsights(sales);
    renderProfitInsights(sales);
    renderBakeryInsights(sales);
    renderTopCustomers(sales);
    renderProductBreakdown(sales);
}

function updateOverview(sales) {
    const customers = new Set(sales.map(getCustomerKey).filter(Boolean));

    const totalItems = sales.reduce(
        (sum, sale) => sum + sale.sale_items.reduce(
            (itemSum, item) => itemSum + item.quantity,
            0
        ),
        0
    );

    setText("totalCustomers", customers.size);
    setText("returningCustomers", getReturningCustomers(sales));
    setText("itemsSold", totalItems);
    setText("averageItems", sales.length ? (totalItems / sales.length).toFixed(1) : "0");
}

function renderOrdersOverTime(sales) {
    const container = findElement([
        "ordersOverTime",
        "ordersOverTimeChart",
        "orderTrend",
        "ordersChart"
    ]);

    if (!container || !window.Chart) return;

    const canvas = prepareCanvas(container, "ordersOverTimeCanvas");
    const grouped = new Map();

    sales.forEach(sale => {
        const date = safeDate(sale.completed_at);
        if (!date) return;

        const key = date.toISOString().split("T")[0];

        if (!grouped.has(key)) {
            grouped.set(key, {
                label: date.toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric"
                }),
                count: 0
            });
        }

        grouped.get(key).count += 1;
    });

    const points = [...grouped.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([, value]) => value);

    if (ordersChart) ordersChart.destroy();

    ordersChart = new Chart(canvas, {
        type: "line",
        data: {
            labels: points.length ? points.map(point => point.label) : ["No sales"],
            datasets: [{
                label: "Completed Sales",
                data: points.length ? points.map(point => point.count) : [0],
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
                    ticks: { precision: 0 }
                }
            },
            plugins: {
                legend: { display: false }
            }
        }
    });
}

function renderProductPopularity(sales) {
    const container = findElement([
        "productPopularity",
        "productPopularityChart",
        "popularityChart",
        "productChart"
    ]);

    if (!container || !window.Chart) return;

    const entries = Object.entries(getProductTotals(sales))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8);

    if (!entries.length) {
        if (popularityChart) {
            popularityChart.destroy();
            popularityChart = null;
        }
        replaceChartWithMessage(container, "No completed sales yet.");
        return;
    }

    const canvas = prepareCanvas(container, "productPopularityCanvas");

    if (popularityChart) popularityChart.destroy();

    popularityChart = new Chart(canvas, {

    type: "doughnut",

    data: {

        labels: entries.map(([name]) => name),

        datasets: [{

            data: entries.map(([, quantity]) => quantity),

            borderWidth: 1

        }]

    },

    options: {

        responsive: true,

        maintainAspectRatio: false,

        cutout: "62%",

        plugins: {

            legend: {

                display: true,

                position: "bottom",

                labels: {

                    padding: 18,

                    usePointStyle: true,

                    pointStyle: "circle",

                    boxWidth: 12,

                    font: {

                        size: 13

                    }

                }

            },

            tooltip: {

                callbacks: {

                    label: (context) =>
                        `${context.label}: ${context.parsed} sold`

                }

            }

        }

    }

});
}

function renderProductRankings(sales) {
    const container = document.getElementById("productRankings");
    if (!container) return;

    const ranking = Object.entries(getProductTotals(sales))
        .sort((a, b) => b[1] - a[1]);

    if (!ranking.length) {
        container.innerHTML = "<p>No completed sales yet.</p>";
        return;
    }

    container.innerHTML = ranking.slice(0, 10).map(([name, quantity], index) => `
        <div class="ranking-row">
            <strong>${index + 1}. ${escapeHtml(name)}</strong>
            <span>${quantity} sold</span>
        </div>
    `).join("");
}

function renderCustomerInsights(sales) {
    const container = document.getElementById("customerInsights");
    if (!container) return;

    const customers = new Set(sales.map(getCustomerKey).filter(Boolean));
    const returning = getReturningCustomers(sales);
    const repeatRate = customers.size ? Math.round(returning / customers.size * 100) : 0;
    const revenue = sumRevenue(sales);
    const averageOrder = sales.length ? revenue / sales.length : 0;

    container.innerHTML = `
        <div class="analytics-stat-list">
            <p>Total Customers <strong>${customers.size}</strong></p>
            <p>Returning Customers <strong>${returning}</strong></p>
            <p>Repeat Rate <strong>${repeatRate}%</strong></p>
            <p>Average Order <strong>${usd(averageOrder)}</strong></p>
        </div>
    `;
}

function renderProfitInsights(sales) {
    const container = document.getElementById("pickupTrends");
    if (!container) return;

    const revenue = sumRevenue(sales);
    const foodCost = sales.reduce((sum, sale) => sum + sale.food_cost, 0);
    const packagingCost = sales.reduce((sum, sale) => sum + sale.packaging_cost, 0);
    const profit = sales.reduce((sum, sale) => sum + sale.profit, 0);
    const margin = SaleCalculations.computeMargin(revenue, profit);

    container.innerHTML = `
        <div class="analytics-stat-list">
            <p>Food Cost <strong>${usd(foodCost)}</strong></p>
            <p>Packaging Cost <strong>${usd(packagingCost)}</strong></p>
            <p>Gross Profit <strong>${usd(profit)}</strong></p>
            <p>Gross Margin <strong>${margin.toFixed(1)}%</strong></p>
        </div>
    `;
}

function renderBakeryInsights(sales) {
    const container = document.getElementById("bakeryInsights");
    if (!container) return;

    if (!sales.length) {
        container.innerHTML = "<p>No completed sales yet.</p>";
        return;
    }

    const largestSale = [...sales].sort((a, b) => b.revenue - a.revenue)[0];
    const revenue = sumRevenue(sales);
    const profit = sales.reduce((sum, sale) => sum + sale.profit, 0);
    const averageOrder = revenue / sales.length;
    const topProduct = getTopProduct(sales);

    container.innerHTML = `
        <div class="analytics-stat-list">
            <p>Largest Sale <strong>${usd(largestSale.revenue)}</strong></p>
            <p>Average Order <strong>${usd(averageOrder)}</strong></p>
            <p>Revenue <strong>${usd(revenue)}</strong></p>
            <p>Gross Profit <strong>${usd(profit)}</strong></p>
            ${topProduct ? `
                <p>Top Product <strong>${escapeHtml(topProduct.name)} (${topProduct.quantity})</strong></p>
            ` : ""}
        </div>
    `;
}

function renderTopCustomers(sales) {
    const container = document.getElementById("topCustomers");
    if (!container) return;

    const totals = {};

    sales.forEach(sale => {
        const key = getCustomerKey(sale) || String(sale.id);

        if (!totals[key]) {
            totals[key] = {
                name: sale.customer_name || "Unknown Customer",
                total: 0,
                profit: 0,
                orders: 0,
                lastOrder: sale.completed_at
            };
        }

        totals[key].total += sale.revenue;
        totals[key].profit += sale.profit;
        totals[key].orders += 1;

        const currentDate = safeDate(sale.completed_at);
        const previousDate = safeDate(totals[key].lastOrder);

        if (currentDate && (!previousDate || currentDate > previousDate)) {
            totals[key].lastOrder = sale.completed_at;
        }
    });

    const customers = Object.values(totals)
        .sort((a, b) => b.total - a.total)
        .slice(0, 5);

    if (!customers.length) {
        container.innerHTML = "<p>No customers yet.</p>";
        return;
    }

    container.innerHTML = customers.map((customer, index) => {
        const medal = index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : "";
        const average = customer.total / customer.orders;

        return `
            <div class="customer-card">
                <div class="customer-header">
                    <strong>${medal} ${escapeHtml(customer.name)}</strong>
                    <span>${usd(customer.total)}</span>
                </div>
                <div class="customer-details">
                    <span>${customer.orders} order${customer.orders === 1 ? "" : "s"}</span>
                    <span>Avg ${usd(average)}</span>
                    <span>Profit ${usd(customer.profit)}</span>
                    <span>Last: ${formatDate(customer.lastOrder)}</span>
                </div>
            </div>
        `;
    }).join("");
}

function renderProductBreakdown(sales) {
    const container = document.getElementById("productBreakdown");
    if (!container) return;

    const products = getProductAnalytics(sales);

    if (!products.length) {
        container.innerHTML = "<p>No completed sales yet.</p>";
        return;
    }

    container.innerHTML = `
        <div class="sales-table">
            <div class="sales-table-row product-breakdown-row sales-table-header">
                <span>Product</span>
                <span>Units</span>
                <span>Revenue</span>
                <span>Cost</span>
                <span>Profit</span>
            </div>

            ${products.map((product, index) => `
                <div class="sales-table-row product-breakdown-row">
                    <span>${index + 1}. ${escapeHtml(product.name)}</span>
                    <span>${product.quantity}</span>
                    <span>${usd(product.revenue)}</span>
                    <span>${usd(product.cost)}</span>
                    <strong>${usd(product.profit)}</strong>
                </div>
            `).join("")}
        </div>
    `;
}

function filterSalesByRange(sales, range) {
    if (range === "all") return sales.slice();

    const now = new Date();

    return sales.filter(sale => {
        const date = safeDate(sale.completed_at);
        if (!date) return false;

        const days = (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24);

        if (range === "30") return days >= 0 && days <= 30;
        if (range === "90") return days >= 0 && days <= 90;
        if (range === "year") return date.getFullYear() === now.getFullYear();

        return true;
    });
}

function normalizeAnalyticsRange(text) {
    const value = String(text || "").trim().toLowerCase();

    if (value.includes("30")) return "30";
    if (value.includes("90")) return "90";
    if (value.includes("year")) return "year";

    return "all";
}

function getProductTotals(sales) {
    const totals = {};

    sales.forEach(sale => {
        sale.sale_items.forEach(item => {
            const name = item.item_name || "Unknown Item";
            totals[name] = (totals[name] || 0) + item.quantity;
        });
    });

    return totals;
}

function getProductAnalytics(sales) {
    // Reclassify each sale's sale_items independently (a box's parent/
    // children only ever live within their own sale), then aggregate all
    // of them together -- see js/sale-calculations.js classifySaleItems/
    // buildProductBreakdown for why this is needed: a Mix & Match box's
    // selected flavors must be folded into the box's own product row,
    // never shown as their own $0-revenue, negative-profit "products".
    const classifiedRows = sales.flatMap(sale =>
        SaleCalculations.classifySaleItems(sale.sale_items, sale.order_items)
    );

    return SaleCalculations.buildProductBreakdown(classifiedRows);
}

function getTopProduct(sales) {
    const top = Object.entries(getProductTotals(sales))
        .sort((a, b) => b[1] - a[1])[0];

    return top ? { name: top[0], quantity: top[1] } : null;
}

function getCustomerKey(sale) {
    return String(sale.customer_name || "").trim().toLowerCase();
}

function getReturningCustomers(sales) {
    const counts = {};

    sales.forEach(sale => {
        const key = getCustomerKey(sale);
        if (!key) return;
        counts[key] = (counts[key] || 0) + 1;
    });

    return Object.values(counts).filter(count => count > 1).length;
}

function sumRevenue(sales) {
    return sales.reduce((sum, sale) => sum + sale.revenue, 0);
}

function findElement(ids) {
    for (const id of ids) {
        const element = document.getElementById(id);
        if (element) return element;
    }

    return null;
}

function prepareCanvas(element, canvasId) {
    if (element.tagName === "CANVAS") {
        const wrapper = element.parentElement;

        if (wrapper) {
            wrapper.style.position = "relative";
            wrapper.style.height = "320px";
            wrapper.style.overflow = "hidden";
        }

        return element;
    }

    element.innerHTML = `
        <div style="position:relative;height:320px;overflow:hidden;">
            <canvas id="${canvasId}"></canvas>
        </div>
    `;

    return document.getElementById(canvasId);
}

function replaceChartWithMessage(element, message) {
    if (element.tagName === "CANVAS") {
        const parent = element.parentElement;
        if (parent) parent.innerHTML = `<p>${escapeHtml(message)}</p>`;
        return;
    }

    element.innerHTML = `<p>${escapeHtml(message)}</p>`;
}

function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
}

// Phase 3: Analytics reports in USD (confirmed rule), formatted
// unambiguously with the $ symbol so it's never mistaken for the EUR
// amounts customers actually pay.
function usd(value) {
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD"
    }).format(Number(value) || 0);
}

function safeDate(value) {
    if (!value) return null;

    const date = new Date(value);

    return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value) {
    const date = safeDate(value);

    if (!date) return "Unknown";

    return date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric"
    });
}

function showAnalyticsError(message) {
    [
        "productRankings",
        "customerInsights",
        "pickupTrends",
        "bakeryInsights",
        "topCustomers",
        "productBreakdown"
    ].forEach(id => {
        const element = document.getElementById(id);
        if (element) element.innerHTML = `<p>${escapeHtml(message)}</p>`;
    });
}

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

window.loadAnalytics = loadAnalytics;
window.renderAnalytics = renderAnalytics;
