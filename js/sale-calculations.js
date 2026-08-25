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

    /* ==========================================
       PRODUCT BREAKDOWN (reporting-only reclassification)
       ==========================================

       Once a sale's lines are written to sale_items, the table itself
       keeps no parent/child link -- every row (a Mix & Match box's own
       revenue-owning "parent" line, each of its selected flavors' cost-
       owning "child" lines, and every ordinary standalone line) sits
       there as an independent row with no `source` column. Per-product
       reporting that just groups sale_items by item_name therefore shows
       a box's revenue and profit as identical (its own line_profit is
       always exactly its line_revenue, since its cost is 0 by design)
       and shows each of its selected flavors as a separate product with
       $0 revenue and negative profit -- both numbers are individually
       correct, but attributed to the wrong "products".

       classifySaleItems fixes the ATTRIBUTION only, never a dollar
       figure: it re-derives, from the sale's own ORIGINAL order_items
       (still available and immutable once a sale exists -- see BUG-22),
       which stored sale_items rows are which box's parent/children, and
       tags each row with the product name it should be grouped under.
       buildProductBreakdown then aggregates using that tag. Every
       revenue/cost/profit value summed is still exactly what was
       computed and frozen at sale-creation time.
       ========================================== */

    /** First not-yet-claimed row in `rows` matching `predicate`, or null. */
    function findAndClaim(rows, claimed, predicate) {
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (!claimed.has(row.id) && predicate(row)) {
                return row;
            }
        }
        return null;
    }

    /**
     * Tags each of one sale's sale_items rows with the product name it
     * should be grouped under for reporting (`bucketName`) and whether
     * its quantity represents "units of that bucket" or a different unit
     * of measure that shouldn't be added to the bucket's displayed count
     * (`isBundleChild` -- a selected flavor's quantity is a cookie/item
     * count, not a "how many boxes" count).
     *
     * Matching a stored row back to the parent/child it came from is by
     * exact (item_name, quantity, unit_price) match against the values
     * buildSaleLineItems would have produced for it -- never fuzzy, never
     * by name pattern. Every one of those stored values was copied
     * byte-for-byte from a line this same module produced at sale-
     * creation time, so an exact match is safe. If a sale's order_items
     * are unavailable, or a specific parent/child can't be matched
     * (missing or malformed builder_details -- a real, observed case in
     * this data: an old order line added before the admin editor could
     * capture Mix & Match selections), those rows are simply left
     * grouped under their own item_name -- the original, pre-fix
     * behavior -- so this can only improve attribution, never hide or
     * corrupt a row.
     */
    function classifySaleItems(saleItems, orderItems) {
        const rows = (saleItems || []).map(item => ({ ...item }));
        const claimed = new Set();
        const bucketNameById = new Map();
        const isChildById = new Map();

        (orderItems || []).forEach(orderItem => {
            const selections =
                orderItem && orderItem.builder_details && Array.isArray(orderItem.builder_details.selections)
                    ? orderItem.builder_details.selections
                    : null;

            if (!selections || !selections.length) return;

            const bucketName = orderItem.item_name;
            const orderQuantity = toNumber(orderItem.quantity, 0);
            const expectedParentPrice = toNumber(orderItem.price_at_purchase, 0);

            const parent = findAndClaim(rows, claimed, row =>
                row.item_name === bucketName &&
                toNumber(row.total_cost, 0) === 0 &&
                toNumber(row.unit_price, 0) === expectedParentPrice
            );

            if (!parent) return;

            claimed.add(parent.id);
            bucketNameById.set(parent.id, bucketName);
            isChildById.set(parent.id, false);

            selections.forEach(selection => {
                const expectedQuantity = toNumber(selection && selection.quantity, 0) * orderQuantity;
                if (expectedQuantity <= 0) return;

                const child = findAndClaim(rows, claimed, row =>
                    row.item_name === (selection && selection.name) &&
                    toNumber(row.unit_price, 0) === 0 &&
                    toNumber(row.quantity, 0) === expectedQuantity
                );

                if (!child) return;

                claimed.add(child.id);
                bucketNameById.set(child.id, bucketName);
                isChildById.set(child.id, true);
            });
        });

        return rows.map(row => ({
            ...row,
            bucketName: bucketNameById.get(row.id) || row.item_name,
            isBundleChild: isChildById.get(row.id) || false
        }));
    }

    /**
     * Aggregates classified sale_items rows (see classifySaleItems, one
     * call covering as many sales' rows as needed) into per-product
     * totals for a Product Breakdown table or export. Sums the same
     * already-frozen revenue/cost/profit fields Analytics always reads,
     * just grouped by bucketName instead of raw item_name -- so a Mix &
     * Match box's row carries its full revenue plus every one of its
     * children's real costs, revenue - cost = profit holds exactly for
     * every row (each contributing row's own profit was already correct;
     * summing it preserves that identity), and nothing is double-counted.
     */
    function buildProductBreakdown(classifiedRows) {
        const totals = {};

        (classifiedRows || []).forEach(row => {
            const name = row.bucketName || row.item_name || "Unknown Item";

            if (!totals[name]) {
                totals[name] = { name, quantity: 0, revenue: 0, cost: 0, profit: 0 };
            }

            const quantity = toNumber(row.quantity, 0);

            if (!row.isBundleChild) {
                totals[name].quantity += quantity;
            }

            totals[name].revenue += toNumber(row.line_revenue, 0);
            totals[name].cost += toNumber(row.total_cost, 0) * quantity;
            totals[name].profit += toNumber(row.line_profit, 0);
        });

        return Object.values(totals).sort((a, b) => b.revenue - a.revenue);
    }

    return {
        buildReferenceData,
        buildSaleLineItems,
        buildSaleFromOrder,
        summarizeLines,
        computeMargin,
        computeSaleFromOrder,
        classifySaleItems,
        buildProductBreakdown
    };
});
