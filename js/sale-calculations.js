/* ==========================================
   SALE CALCULATIONS (shared, pure)
   ==========================================

   Single source of truth for turning an order's line items into
   sale_items-shaped rows and summarizing them into revenue/cost/profit/
   margin totals. Used by:

     - js/admin-orders.js   (createSaleFromOrder — writes sale_items/sales)
     - js/admin-sales.js    (Sales dashboard totals)
     - js/admin-analytics.js (Analytics dashboard totals)

   and covered by tests/sale-calculations.test.js (Node's built-in test
   runner, no dependencies).

   This file has no dependency on the DOM or Supabase — every function here
   takes plain data in and returns plain data out, so it can run unmodified
   in the browser (as a normal <script> tag, exposing `window.SaleCalculations`)
   or under Node (via `require("./sale-calculations.js")`).

   -------------------------------------------------------------------------
   BUG-01 fix (Mix & Match / "builder" revenue-profit gap)
   -------------------------------------------------------------------------
   Previously, a Mix & Match box's own price was never recorded as revenue
   anywhere in sale_items — only its individual selections were, each priced
   at zero. Confirmed sales.revenue (from orders.subtotal) still included
   the box price, but the profit recomputed from sale_items did not, so
   revenue and profit silently disagreed for every order containing a box.

   The fix, per the confirmed design: the box itself becomes a PARENT line
   that owns 100% of its revenue and 0% of its cost (every real ingredient
   and packaging cost is already fully captured by the CHILD lines below
   it, exactly as before). Each selected product remains a CHILD line
   contributing cost and quantity, with revenue left at 0 so nothing is
   ever double-counted. Standard (non-builder) order lines are completely
   unaffected by this change.
   ========================================== */

(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.SaleCalculations = factory();
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    /* ==========================================
       HELPERS
       ========================================== */

    function toNumber(value, fallback) {
        const n = Number(value);
        return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
    }

    function key(value) {
        return value === null || value === undefined ? null : String(value);
    }

    /**
     * Builds the lookup maps buildSaleLineItems/buildSaleFromOrder need,
     * from the plain arrays every caller already fetches from Supabase
     * (menu_items, recipe_costs, packaging_profile_costs). Every map is
     * keyed with the same String() coercion on both insert and lookup, so
     * it behaves identically whether the underlying id is a uuid (menu
     * items) or a bigint (recipes/packaging profiles) — see BUG-03 in
     * docs/bakery-rebuild/03-bug-register.md for the inconsistent-casting
     * pitfall this deliberately avoids.
     */
    function buildReferenceData(menuItems, recipeCosts, packagingCosts) {
        const menuItemsById = new Map();

        // Resolving a builder ("Mix & Match") order line back to its own
        // menu_items row cannot be done via builder_group: in the live data,
        // multiple distinct box products intentionally share one
        // builder_group (it marks which STANDARD products are eligible
        // choices, not which BOX a given order line was). item_name, copied
        // verbatim onto order_items at checkout, reliably identifies the
        // specific box instead — confirmed unique among the live builder
        // products. See docs/bakery-rebuild/08-security-repair-plan.md /
        // 09-bug01-regression-report.md for this ambiguity in full.
        const menuItemsByBuilderName = new Map();

        (menuItems || []).forEach(item => {
            if (item && item.id !== undefined) {
                menuItemsById.set(key(item.id), item);
            }
            if (item && item.product_type === "builder" && item.name) {
                menuItemsByBuilderName.set(key(item.name), item);
            }
        });

        const recipeCostsByRecipeId = new Map(
            (recipeCosts || [])
                .filter(recipe => recipe && recipe.id !== undefined)
                .map(recipe => [key(recipe.id), recipe])
        );

        const packagingCostsByProfileId = new Map(
            (packagingCosts || [])
                .filter(profile => profile && profile.id !== undefined)
                .map(profile => [key(profile.id), profile])
        );

        return {
            menuItemsById,
            menuItemsByBuilderName,
            recipeCostsByRecipeId,
            packagingCostsByProfileId
        };
    }

    function getMenuItem(menuItemsById, id) {
        return menuItemsById.get(key(id));
    }

    function getRecipeCostPerUnit(menuItem, recipeCostsByRecipeId) {
        if (!menuItem || menuItem.recipe_id === null || menuItem.recipe_id === undefined) {
            return 0;
        }

        const recipeCost = recipeCostsByRecipeId.get(key(menuItem.recipe_id));
        const costPerYieldItem = toNumber(recipeCost && recipeCost.cost_per_yield_item, 0);
        const unitsUsed = toNumber(menuItem.recipe_units_used, 1);

        return costPerYieldItem * unitsUsed;
    }

    function getPackagingCostPerUnit(menuItem, packagingCostsByProfileId) {
        if (!menuItem || menuItem.packaging_profile_id === null || menuItem.packaging_profile_id === undefined) {
            return 0;
        }

        const packagingCost = packagingCostsByProfileId.get(key(menuItem.packaging_profile_id));
        return toNumber(packagingCost && packagingCost.packaging_cost, 0);
    }

    /* ==========================================
       LINE BUILDING
       ========================================== */

    /**
     * Turns one order_items row into one or more sale_items-shaped line
     * objects. Never throws on missing/malformed builder selection data —
     * a selection with no id, an unknown id, or a non-positive quantity is
     * silently skipped, and the parent line's revenue is unaffected either
     * way.
     *
     * referenceData is the object returned by buildReferenceData().
     */
    function buildSaleLineItems(orderItem, referenceData) {
        const { menuItemsById, menuItemsByBuilderName, recipeCostsByRecipeId, packagingCostsByProfileId } = referenceData;

        const quantity = toNumber(orderItem && orderItem.quantity, 0);
        const unitPrice = toNumber(orderItem && orderItem.price_at_purchase, 0);
        const lineRevenue = toNumber(orderItem && orderItem.line_total, 0);

        const selections =
            orderItem && orderItem.builder_details && Array.isArray(orderItem.builder_details.selections)
                ? orderItem.builder_details.selections
                : null;

        const isBuilder = !!(selections && selections.length);

        if (!isBuilder) {
            const menuItem = getMenuItem(menuItemsById, orderItem && orderItem.menu_item_id);
            const foodCost = getRecipeCostPerUnit(menuItem, recipeCostsByRecipeId);
            const packagingCost = getPackagingCostPerUnit(menuItem, packagingCostsByProfileId);
            const totalCost = foodCost + packagingCost;

            return [{
                source: "standard",
                menu_item_id: (orderItem && orderItem.menu_item_id) ?? null,
                item_name: orderItem && orderItem.item_name,
                quantity,
                unit_price: unitPrice,
                food_cost: foodCost,
                packaging_cost: packagingCost,
                total_cost: totalCost,
                line_revenue: lineRevenue,
                line_profit: lineRevenue - (totalCost * quantity)
            }];
        }

        // ---- Mix & Match (builder) order line ----
        //
        // Parent: owns 100% of the revenue, 0% of the cost (cost is fully
        // captured by the child lines below). Resolving the box's own
        // menu_items row is best-effort, purely so the parent row carries a
        // real menu_item_id when possible — an unmatched name does not
        // block the revenue line, it just leaves menu_item_id null.
        const builderMenuItem = orderItem.item_name ? menuItemsByBuilderName.get(key(orderItem.item_name)) : undefined;

        // The parent line's OWN displayed quantity is the true box count.
        // For ordinary rows that's just `quantity` (unchanged, and still
        // exactly what the child multiplication below uses). The Admin
        // Orders editor can additionally combine more than one box's
        // worth of cookies into a single order_items row (quantity: 1,
        // selections already totaled across every box) and records the
        // real box count separately as builder_details.box_quantity --
        // when present, that's what the parent line shows instead, purely
        // for display/reporting (Sales' "items sold", etc.). It never
        // affects childQuantity below, which is deliberately still based
        // on `quantity` alone so cost/profit stay correct either way.
        const parentQuantity = orderItem.builder_details && orderItem.builder_details.box_quantity !== undefined
            ? toNumber(orderItem.builder_details.box_quantity, quantity)
            : quantity;

        const lines = [{
            source: "builder-parent",
            menu_item_id: builderMenuItem ? builderMenuItem.id : null,
            item_name: orderItem.item_name,
            quantity: parentQuantity,
            unit_price: unitPrice,
            food_cost: 0,
            packaging_cost: 0,
            total_cost: 0,
            line_revenue: lineRevenue,
            line_profit: lineRevenue
        }];

        selections.forEach(selection => {
            if (!selection || selection.id === null || selection.id === undefined) {
                return;
            }

            const selectedMenuItem = getMenuItem(menuItemsById, selection.id);

            if (!selectedMenuItem) {
                return;
            }

            const selectionQuantity = toNumber(selection.quantity, 0);

            if (selectionQuantity <= 0) {
                return;
            }

            const foodCost = getRecipeCostPerUnit(selectedMenuItem, recipeCostsByRecipeId);
            const packagingCost = getPackagingCostPerUnit(selectedMenuItem, packagingCostsByProfileId);
            const totalCost = foodCost + packagingCost;
            const childQuantity = selectionQuantity * quantity;

            lines.push({
                source: "builder-child",
                menu_item_id: selectedMenuItem.id,
                item_name: selectedMenuItem.name,
                quantity: childQuantity,
                unit_price: 0,
                food_cost: foodCost,
                packaging_cost: packagingCost,
                total_cost: totalCost,
                line_revenue: 0,
                line_profit: -(totalCost * childQuantity)
            });
        });

        return lines;
    }

    /**
     * Builds the complete sale_items-shaped line list for every item in an
     * order. `orderItems` is the plain array from `order_items` (or the
     * equivalent test fixture) — order is preserved, one or more output
     * lines per input item.
     */
    function buildSaleFromOrder(orderItems, referenceData) {
        const lines = [];

        (orderItems || []).forEach(orderItem => {
            buildSaleLineItems(orderItem, referenceData).forEach(line => lines.push(line));
        });

        return lines;
    }

    /* ==========================================
       SUMMARIZING
       ========================================== */

    /**
     * The one place revenue, cost, profit, and margin are computed from a
     * set of sale_items-shaped lines. Sales and Analytics must both route
     * through this (directly, or by trusting numbers this function
     * produced at sale-creation time) so they can never independently
     * drift from each other.
     */
    function summarizeLines(lines) {
        let revenue = 0;
        let foodCost = 0;
        let packagingCost = 0;

        (lines || []).forEach(line => {
            const quantity = toNumber(line && line.quantity, 0);

            revenue += toNumber(line && line.line_revenue, 0);
            foodCost += toNumber(line && line.food_cost, 0) * quantity;
            packagingCost += toNumber(line && line.packaging_cost, 0) * quantity;
        });

        const totalCost = foodCost + packagingCost;
        const profit = revenue - totalCost;

        return {
            revenue,
            foodCost,
            packagingCost,
            totalCost,
            profit,
            margin: computeMargin(revenue, profit)
        };
    }

    /**
     * Shared margin formula. Guards against division by zero / NaN —
     * revenue of exactly 0 (or negative, which shouldn't happen but is
     * still handled) always yields a margin of 0, never NaN or Infinity.
     */
    function computeMargin(revenue, profit) {
        const safeRevenue = toNumber(revenue, 0);
        const safeProfit = toNumber(profit, 0);

        return safeRevenue > 0 ? (safeProfit / safeRevenue) * 100 : 0;
    }

    /**
     * Convenience one-shot: order_items + reference arrays in, both the
     * line list and the summary out. This is what createSaleFromOrder
     * calls; Sales/Analytics use summarizeLines/computeMargin directly
     * against data already read from Supabase.
     */
    function computeSaleFromOrder(orderItems, menuItems, recipeCosts, packagingCosts) {
        const referenceData = buildReferenceData(menuItems, recipeCosts, packagingCosts);
        const lines = buildSaleFromOrder(orderItems, referenceData);
        const totals = summarizeLines(lines);

        return { lines, totals };
    }

    return {
        buildReferenceData,
        buildSaleLineItems,
        buildSaleFromOrder,
        summarizeLines,
        computeMargin,
        computeSaleFromOrder
    };
});
