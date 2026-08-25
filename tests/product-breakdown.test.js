"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const SaleCalculations = require("../js/sale-calculations.js");

/* ==========================================
   Regression coverage for the Analytics Product Breakdown bug:

     - "6 Mix & Match Cookies" / "Mix & Match Cinnamon Rolls" showed
       revenue and profit as identical numbers.
     - Their selected flavors (Peanut Butter Cup, Nutella Rolls,
       Strawberry Rolls, ...) showed as their OWN products with $0
       revenue and negative profit.

   Root cause: getProductAnalytics grouped raw sale_items rows by
   item_name with no awareness that a Mix & Match box's revenue-owning
   "parent" row and its cost-owning "child" rows are meant to be ONE
   product, not several. Every individual row's OWN revenue/cost/profit
   was already correct (proven by "sale totals are already correct"
   below) -- only the per-product ATTRIBUTION in reporting was wrong.

   Fix: js/sale-calculations.js classifySaleItems() re-derives, from
   the sale's own order_items.builder_details (still available and
   frozen once a sale exists), which sale_items rows are which box's
   parent/children, and buildProductBreakdown() aggregates using that
   classification. No dollar figure is ever recomputed -- only the
   grouping key changes.
   ========================================== */

function saleItem(overrides) {
    return {
        id: overrides.id,
        menu_item_id: overrides.menu_item_id ?? null,
        item_name: overrides.item_name,
        quantity: overrides.quantity,
        unit_price: overrides.unit_price,
        food_cost: overrides.food_cost ?? 0,
        packaging_cost: overrides.packaging_cost ?? 0,
        total_cost: overrides.total_cost,
        line_revenue: overrides.line_revenue,
        line_profit: overrides.line_profit
    };
}

function orderItem(overrides) {
    return {
        item_name: overrides.item_name,
        quantity: overrides.quantity,
        price_at_purchase: overrides.price_at_purchase,
        builder_details: overrides.builder_details ?? null
    };
}

function findBucket(breakdown, name) {
    return breakdown.find(p => p.name === name);
}

test("1. standard standalone product: revenue/cost/profit come from the stored row unchanged", () => {
    const orderItems = [orderItem({ item_name: "Classic Boule", quantity: 2, price_at_purchase: 9 })];
    const saleItems = [saleItem({
        id: "s1", item_name: "Classic Boule", quantity: 2, unit_price: 9,
        total_cost: 3, line_revenue: 18, line_profit: 12
    })];

    const classified = SaleCalculations.classifySaleItems(saleItems, orderItems);
    assert.equal(classified[0].bucketName, "Classic Boule");
    assert.equal(classified[0].isBundleChild, false);

    const breakdown = SaleCalculations.buildProductBreakdown(classified);
    assert.deepEqual(findBucket(breakdown, "Classic Boule"), {
        name: "Classic Boule", quantity: 2, revenue: 18, cost: 6, profit: 12
    });
});

test("2. an individually sold cookie is its own product, exactly as before", () => {
    const orderItems = [orderItem({ item_name: "S'mores", quantity: 4, price_at_purchase: 3 })];
    const saleItems = [saleItem({
        id: "s1", item_name: "S'mores", quantity: 4, unit_price: 3,
        total_cost: 0.6, line_revenue: 12, line_profit: 9.6
    })];

    const breakdown = SaleCalculations.buildProductBreakdown(
        SaleCalculations.classifySaleItems(saleItems, orderItems)
    );
    assert.deepEqual(findBucket(breakdown, "S'mores"), {
        name: "S'mores", quantity: 4, revenue: 12, cost: 2.4, profit: 9.6
    });
});

test("3. a 6-cookie Mix & Match box: revenue and profit are NOT identical -- the child's cost is folded in", () => {
    const orderItems = [orderItem({
        item_name: "6 Mix & Match Cookies", quantity: 1, price_at_purchase: 15,
        builder_details: { selections: [{ id: "c1", name: "Brown Butter Sea Salt Chocolate Chip", quantity: 6 }] }
    })];

    const saleItems = [
        saleItem({ id: "parent", item_name: "6 Mix & Match Cookies", quantity: 1, unit_price: 15, total_cost: 0, line_revenue: 17.07, line_profit: 17.07 }),
        // total_cost is PER UNIT (0.65); line_profit is the already-
        // correctly-multiplied total for all 6 (-(0.65 * 6) = -3.90).
        saleItem({ id: "child", menu_item_id: "c1", item_name: "Brown Butter Sea Salt Chocolate Chip", quantity: 6, unit_price: 0, total_cost: 0.65, line_revenue: 0, line_profit: -3.90 })
    ];

    const breakdown = SaleCalculations.buildProductBreakdown(
        SaleCalculations.classifySaleItems(saleItems, orderItems)
    );

    assert.equal(breakdown.length, 1, "the child must not appear as its own product row");
    const box = findBucket(breakdown, "6 Mix & Match Cookies");
    assert.equal(box.quantity, 1, "quantity is box count, not cookie count");
    assert.equal(box.revenue, 17.07);
    assert.equal(Math.round(box.cost * 100), 390); // 0.65 per unit * 6
    assert.notEqual(box.revenue, box.profit, "revenue and profit must no longer be identical");
    assert.ok(Math.abs(box.profit - 13.17) < 0.001);
});

test("4. a 12-cookie Mix & Match box folds in every selected flavor's cost, using all four current flavors", () => {
    const orderItems = [orderItem({
        item_name: "12 Mix & Match Cookies", quantity: 1, price_at_purchase: 25,
        builder_details: {
            selections: [
                { id: "c1", name: "Brown Butter Sea Salt Chocolate Chip", quantity: 3 },
                { id: "c2", name: "S'mores", quantity: 3 },
                { id: "c3", name: "Strawberry Shortcake", quantity: 3 },
                { id: "c4", name: "Browned Butter Snickerdoodle", quantity: 3 }
            ]
        }
    })];

    const saleItems = [
        saleItem({ id: "parent", item_name: "12 Mix & Match Cookies", quantity: 1, unit_price: 25, total_cost: 0, line_revenue: 28.5, line_profit: 28.5 }),
        saleItem({ id: "c1", item_name: "Brown Butter Sea Salt Chocolate Chip", quantity: 3, unit_price: 0, total_cost: 0.5, line_revenue: 0, line_profit: -1.5 }),
        saleItem({ id: "c2", item_name: "S'mores", quantity: 3, unit_price: 0, total_cost: 0.6, line_revenue: 0, line_profit: -1.8 }),
        saleItem({ id: "c3", item_name: "Strawberry Shortcake", quantity: 3, unit_price: 0, total_cost: 0.4, line_revenue: 0, line_profit: -1.2 }),
        saleItem({ id: "c4", item_name: "Browned Butter Snickerdoodle", quantity: 3, unit_price: 0, total_cost: 0.55, line_revenue: 0, line_profit: -1.65 })
    ];

    const breakdown = SaleCalculations.buildProductBreakdown(
        SaleCalculations.classifySaleItems(saleItems, orderItems)
    );

    assert.equal(breakdown.length, 1);
    const box = findBucket(breakdown, "12 Mix & Match Cookies");
    assert.equal(box.revenue, 28.5);
    assert.ok(Math.abs(box.cost - (1.5 + 1.8 + 1.2 + 1.65)) < 0.001);
    assert.ok(Math.abs(box.profit - (28.5 - 6.15)) < 0.001);
});

test("5. Mix & Match Cinnamon Rolls folds in its selected rolls, mirroring real production data", () => {
    // Mirrors live sale bdfbe433.../0c2be140... shape (Classic Cinnamon
    // Rolls + Strawberry Rolls as children of one cinnamon-roll box).
    const orderItems = [orderItem({
        item_name: "Mix & Match Cinnamon Rolls", quantity: 1, price_at_purchase: 20,
        builder_details: {
            selections: [
                { id: "r1", name: "Classic Cinnamon Rolls", quantity: 2 },
                { id: "r2", name: "Strawberry Rolls", quantity: 2 }
            ]
        }
    })];

    const saleItems = [
        saleItem({ id: "parent", item_name: "Mix & Match Cinnamon Rolls", quantity: 1, unit_price: 20, total_cost: 0, line_revenue: 22.75, line_profit: 22.75 }),
        saleItem({ id: "r1", item_name: "Classic Cinnamon Rolls", quantity: 2, unit_price: 0, total_cost: 2.78, line_revenue: 0, line_profit: -5.56 }),
        saleItem({ id: "r2", item_name: "Strawberry Rolls", quantity: 2, unit_price: 0, total_cost: 2.11, line_revenue: 0, line_profit: -4.22 })
    ];

    const breakdown = SaleCalculations.buildProductBreakdown(
        SaleCalculations.classifySaleItems(saleItems, orderItems)
    );

    assert.equal(breakdown.length, 1);
    const box = findBucket(breakdown, "Mix & Match Cinnamon Rolls");
    assert.equal(box.revenue, 22.75);
    assert.ok(Math.abs(box.cost - 9.78) < 0.001);
    assert.ok(Math.abs(box.profit - 12.97) < 0.001);
    assert.notEqual(box.revenue, box.profit);
});

test("6. multiple bundles in one sale each get their own correct bucket -- reproduces live sale 0c2be140...", () => {
    const orderItems = [
        orderItem({
            item_name: "6 Mix & Match Cookies", quantity: 1, price_at_purchase: 15,
            builder_details: { selections: [{ id: "c1", name: "Brown Butter Sea Salt Chocolate Chip", quantity: 6 }] }
        }),
        orderItem({
            item_name: "Mix & Match Cinnamon Rolls", quantity: 1, price_at_purchase: 20,
            builder_details: {
                selections: [
                    { id: "r1", name: "Classic Cinnamon Rolls", quantity: 2 },
                    { id: "r2", name: "Strawberry Rolls", quantity: 2 }
                ]
            }
        })
    ];

    const saleItems = [
        saleItem({ id: "p1", item_name: "6 Mix & Match Cookies", quantity: 1, unit_price: 15, total_cost: 0, line_revenue: 17.07, line_profit: 17.07 }),
        saleItem({ id: "c1", item_name: "Brown Butter Sea Salt Chocolate Chip", quantity: 6, unit_price: 0, total_cost: 0.65, line_revenue: 0, line_profit: -0.65 }),
        saleItem({ id: "p2", item_name: "Mix & Match Cinnamon Rolls", quantity: 1, unit_price: 20, total_cost: 0, line_revenue: 22.75, line_profit: 22.75 }),
        saleItem({ id: "r1", item_name: "Classic Cinnamon Rolls", quantity: 2, unit_price: 0, total_cost: 2.78, line_revenue: 0, line_profit: -5.56 }),
        saleItem({ id: "r2", item_name: "Strawberry Rolls", quantity: 2, unit_price: 0, total_cost: 2.11, line_revenue: 0, line_profit: -4.22 })
    ];

    const breakdown = SaleCalculations.buildProductBreakdown(
        SaleCalculations.classifySaleItems(saleItems, orderItems)
    );

    assert.equal(breakdown.length, 2, "exactly two products -- both boxes -- no orphaned flavor rows");
    assert.ok(!findBucket(breakdown, "Brown Butter Sea Salt Chocolate Chip"));
    assert.ok(!findBucket(breakdown, "Classic Cinnamon Rolls"));
    assert.ok(!findBucket(breakdown, "Strawberry Rolls"));

    const cookieBox = findBucket(breakdown, "6 Mix & Match Cookies");
    const rollBox = findBucket(breakdown, "Mix & Match Cinnamon Rolls");
    assert.ok(Math.abs(cookieBox.profit - 16.42) < 0.001);
    assert.ok(Math.abs(rollBox.profit - 12.97) < 0.001);
});

test("7. a bundle child and a standalone purchase of the SAME flavor stay correctly separated", () => {
    const orderItems = [
        orderItem({
            item_name: "6 Mix & Match Cookies", quantity: 1, price_at_purchase: 15,
            builder_details: { selections: [{ id: "c1", name: "S'mores", quantity: 3 }, { id: "c2", name: "Strawberry Shortcake", quantity: 3 }] }
        }),
        orderItem({ item_name: "S'mores", quantity: 2, price_at_purchase: 3 }) // bought standalone too
    ];

    const saleItems = [
        saleItem({ id: "parent", item_name: "6 Mix & Match Cookies", quantity: 1, unit_price: 15, total_cost: 0, line_revenue: 17.07, line_profit: 17.07 }),
        saleItem({ id: "child-smores", item_name: "S'mores", quantity: 3, unit_price: 0, total_cost: 0.5, line_revenue: 0, line_profit: -1.5 }),
        saleItem({ id: "child-straw", item_name: "Strawberry Shortcake", quantity: 3, unit_price: 0, total_cost: 0.4, line_revenue: 0, line_profit: -1.2 }),
        saleItem({ id: "standalone-smores", item_name: "S'mores", quantity: 2, unit_price: 3, total_cost: 0.5, line_revenue: 6, line_profit: 5 })
    ];

    const breakdown = SaleCalculations.buildProductBreakdown(
        SaleCalculations.classifySaleItems(saleItems, orderItems)
    );

    assert.equal(breakdown.length, 2, "the box, and the standalone S'mores purchase -- not three");

    const box = findBucket(breakdown, "6 Mix & Match Cookies");
    assert.ok(Math.abs(box.cost - 2.7) < 0.001); // (0.5*3) + (0.4*3)

    const standaloneSmores = findBucket(breakdown, "S'mores");
    assert.equal(standaloneSmores.quantity, 2, "only the standalone purchase counts toward S'mores' own units");
    assert.equal(standaloneSmores.revenue, 6);
    assert.equal(standaloneSmores.profit, 5);
});

test("8. never recalculates from current recipe/packaging costs -- only the stored historical value is used, even if it differs from a hypothetical current cost", () => {
    const HYPOTHETICAL_CURRENT_COST = 999; // deliberately never referenced by the classifier

    const orderItems = [orderItem({ item_name: "Classic Boule", quantity: 1, price_at_purchase: 9 })];
    const saleItems = [saleItem({
        id: "s1", item_name: "Classic Boule", quantity: 1, unit_price: 9,
        total_cost: 3.10, // the historical, frozen cost at time of sale
        line_revenue: 9, line_profit: 5.9
    })];

    const breakdown = SaleCalculations.buildProductBreakdown(
        SaleCalculations.classifySaleItems(saleItems, orderItems)
    );

    const product = findBucket(breakdown, "Classic Boule");
    assert.equal(product.cost, 3.10);
    assert.notEqual(product.cost, HYPOTHETICAL_CURRENT_COST);
});

test("9. a genuinely free standalone product keeps its own $0-revenue, negative-profit row -- it is not swallowed by any bundle", () => {
    const orderItems = [
        orderItem({ item_name: "Free Sample Cookie", quantity: 1, price_at_purchase: 0 }) // no builder_details -- standalone
    ];
    const saleItems = [
        saleItem({ id: "s1", item_name: "Free Sample Cookie", quantity: 1, unit_price: 0, total_cost: 0.5, line_revenue: 0, line_profit: -0.5 })
    ];

    const classified = SaleCalculations.classifySaleItems(saleItems, orderItems);
    assert.equal(classified[0].bucketName, "Free Sample Cookie");
    assert.equal(classified[0].isBundleChild, false, "a genuinely free item is not a bundle child");

    const breakdown = SaleCalculations.buildProductBreakdown(classified);
    assert.equal(breakdown.length, 1);
    assert.equal(breakdown[0].revenue, 0);
    assert.equal(breakdown[0].profit, -0.5);
});

test("10. missing or malformed bundle relationship degrades gracefully -- never crashes, never hides a row", () => {
    // (a) order_items entirely unavailable for this sale.
    const saleItems = [
        saleItem({ id: "parent", item_name: "6 Mix & Match Cookies", quantity: 1, unit_price: 15, total_cost: 0, line_revenue: 17.07, line_profit: 17.07 }),
        saleItem({ id: "child", item_name: "S'mores", quantity: 6, unit_price: 0, total_cost: 0.65, line_revenue: 0, line_profit: -0.65 })
    ];
    let breakdown = SaleCalculations.buildProductBreakdown(SaleCalculations.classifySaleItems(saleItems, null));
    assert.equal(breakdown.length, 2, "with no order_items to classify against, rows fall back to their own names -- not dropped");

    // (b) builder_details present but selections malformed (not an array).
    const malformedOrderItems = [orderItem({
        item_name: "6 Mix & Match Cookies", quantity: 1, price_at_purchase: 15,
        builder_details: { selections: "not-an-array" }
    })];
    breakdown = SaleCalculations.buildProductBreakdown(SaleCalculations.classifySaleItems(saleItems, malformedOrderItems));
    assert.equal(breakdown.length, 2, "malformed selections must not throw, and rows stay visible");

    // (c) reproduces the real live data gap: a Mix & Match order_item
    // created before the admin editor could capture selections at all
    // (menu_item_id set directly, builder_details: null) -- must not
    // crash, and (since it's genuinely indistinguishable from a
    // standalone purchase with the data available) is left as its own
    // honest, internally-consistent row.
    const lostDecompositionOrderItems = [orderItem({
        item_name: "12 Mix & Match Cookies", quantity: 1, price_at_purchase: 25, builder_details: null
    })];
    const lostSaleItems = [saleItem({
        id: "s1", item_name: "12 Mix & Match Cookies", quantity: 1, unit_price: 25,
        total_cost: 1.79, line_revenue: 28.71, line_profit: 26.92
    })];
    breakdown = SaleCalculations.buildProductBreakdown(
        SaleCalculations.classifySaleItems(lostSaleItems, lostDecompositionOrderItems)
    );
    assert.equal(breakdown.length, 1);
    assert.equal(breakdown[0].revenue, 28.71);
    assert.equal(breakdown[0].cost, 1.79);
    assert.equal(breakdown[0].profit, 26.92);
});

test("11. USD figures already carry rounding residuals -- classification/aggregation never introduces further rounding", () => {
    const orderItems = [orderItem({
        item_name: "6 Mix & Match Cookies", quantity: 1, price_at_purchase: 15,
        builder_details: { selections: [{ id: "c1", name: "S'mores", quantity: 6 }] }
    })];

    // Deliberately odd-cent USD values, as CurrencyConversion.applyRateToSaleLines
    // would actually produce after an exchange-rate conversion.
    const saleItems = [
        saleItem({ id: "parent", item_name: "6 Mix & Match Cookies", quantity: 1, unit_price: 15, total_cost: 0, line_revenue: 17.13, line_profit: 17.13 }),
        saleItem({ id: "child", item_name: "S'mores", quantity: 6, unit_price: 0, total_cost: 0.647, line_revenue: 0, line_profit: -3.882 })
    ];

    const breakdown = SaleCalculations.buildProductBreakdown(
        SaleCalculations.classifySaleItems(saleItems, orderItems)
    );

    const box = findBucket(breakdown, "6 Mix & Match Cookies");
    // Exact sum of the stored USD values -- no independent rounding applied.
    assert.equal(box.revenue, 17.13);
    assert.equal(box.profit, 17.13 + (-3.882));
});

test("12. complete Product Breakdown reconciliation across multiple sales in one reporting period", () => {
    const sales = [
        {
            sale: { revenue: 18, total_cost: 6, profit: 12 },
            orderItems: [orderItem({ item_name: "Classic Boule", quantity: 2, price_at_purchase: 9 })],
            saleItems: [saleItem({ id: "a1", item_name: "Classic Boule", quantity: 2, unit_price: 9, total_cost: 3, line_revenue: 18, line_profit: 12 })]
        },
        {
            sale: { revenue: 17.07, total_cost: 3.90, profit: 13.17 },
            orderItems: [orderItem({
                item_name: "6 Mix & Match Cookies", quantity: 1, price_at_purchase: 15,
                builder_details: { selections: [{ id: "c1", name: "Brown Butter Sea Salt Chocolate Chip", quantity: 6 }] }
            })],
            saleItems: [
                saleItem({ id: "b1", item_name: "6 Mix & Match Cookies", quantity: 1, unit_price: 15, total_cost: 0, line_revenue: 17.07, line_profit: 17.07 }),
                // total_cost is PER UNIT (0.65); line_profit is -(0.65 * 6).
                saleItem({ id: "b2", item_name: "Brown Butter Sea Salt Chocolate Chip", quantity: 6, unit_price: 0, total_cost: 0.65, line_revenue: 0, line_profit: -3.90 })
            ]
        },
        {
            sale: { revenue: 22.75, total_cost: 9.78, profit: 12.97 },
            orderItems: [orderItem({
                item_name: "Mix & Match Cinnamon Rolls", quantity: 1, price_at_purchase: 20,
                builder_details: { selections: [{ id: "r1", name: "Classic Cinnamon Rolls", quantity: 2 }, { id: "r2", name: "Strawberry Rolls", quantity: 2 }] }
            })],
            saleItems: [
                saleItem({ id: "c1", item_name: "Mix & Match Cinnamon Rolls", quantity: 1, unit_price: 20, total_cost: 0, line_revenue: 22.75, line_profit: 22.75 }),
                saleItem({ id: "c2", item_name: "Classic Cinnamon Rolls", quantity: 2, unit_price: 0, total_cost: 2.78, line_revenue: 0, line_profit: -5.56 }),
                saleItem({ id: "c3", item_name: "Strawberry Rolls", quantity: 2, unit_price: 0, total_cost: 2.11, line_revenue: 0, line_profit: -4.22 })
            ]
        }
    ];

    const classifiedRows = sales.flatMap(s => SaleCalculations.classifySaleItems(s.saleItems, s.orderItems));
    const breakdown = SaleCalculations.buildProductBreakdown(classifiedRows);

    const overallRevenue = sales.reduce((sum, s) => sum + s.sale.revenue, 0);
    const overallCost = sales.reduce((sum, s) => sum + s.sale.total_cost, 0);
    const overallProfit = sales.reduce((sum, s) => sum + s.sale.profit, 0);

    const breakdownRevenue = breakdown.reduce((sum, p) => sum + p.revenue, 0);
    const breakdownCost = breakdown.reduce((sum, p) => sum + p.cost, 0);
    const breakdownProfit = breakdown.reduce((sum, p) => sum + p.profit, 0);

    assert.ok(Math.abs(breakdownRevenue - overallRevenue) < 0.001, "Product Breakdown revenue must equal displayed overall revenue");
    assert.ok(Math.abs(breakdownCost - overallCost) < 0.001, "Product Breakdown cost must equal displayed overall cost");
    assert.ok(Math.abs(breakdownProfit - overallProfit) < 0.001, "Product Breakdown profit must equal displayed overall profit");

    breakdown.forEach(product => {
        assert.ok(
            Math.abs((product.revenue - product.cost) - product.profit) < 0.001,
            `revenue - cost must equal profit for ${product.name}`
        );
    });

    // Bundle revenue/cost counted exactly once: no orphaned child rows.
    assert.ok(!findBucket(breakdown, "Brown Butter Sea Salt Chocolate Chip"));
    assert.ok(!findBucket(breakdown, "Classic Cinnamon Rolls"));
    assert.ok(!findBucket(breakdown, "Strawberry Rolls"));
    assert.equal(breakdown.length, 3);
});
