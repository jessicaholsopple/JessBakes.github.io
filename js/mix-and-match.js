/* ==========================================
   MIX & MATCH (shared, pure)
   ==========================================

   Single canonical source of truth for Mix & Match ("builder") box
   eligibility and validation, shared by:

     - js/cart.js          (public Menu page checkout builder)
     - js/admin-orders.js  (Admin Orders "New/Edit Order" embedded
                             cookie selector)

   Both interfaces call the SAME functions here to decide which flavors
   are offered and whether a selection is complete -- so they can never
   drift apart into two different eligibility rules. See also
   js/order-editor.js, which uses buildBuilderDetails's shape when
   saving an admin-built box.

   This file has no dependency on the DOM or Supabase -- every function
   here takes plain data in and returns plain data out, so it can run
   unmodified in the browser (as a normal <script> tag, exposing
   `window.MixAndMatch`) or under Node (via `require("./mix-and-match.js")`).
   ========================================== */

(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.MixAndMatch = factory();
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    function toNumber(value, fallback) {
        const n = Number(value);
        return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
    }

    /**
     * The one canonical Mix & Match eligibility rule. A menu item is an
     * eligible flavor for a given builder (box) product when it is:
     *   - a standard, individually-orderable product -- never another
     *     builder/box product, and never a bread/dessert/seasonal item
     *     that happens to reuse the same builder_group text;
     *   - currently available;
     *   - tagged into the SAME builder_group as the box itself.
     * Matches on the stable builder_group field and product_type only --
     * never on the product's name, so a future flavor becomes eligible
     * automatically the moment it's created with the right fields, no
     * code change required anywhere that calls this function.
     */
    function isEligibleCookie(menuItem, builderProduct) {
        return !!(
            menuItem &&
            builderProduct &&
            menuItem.product_type === "standard" &&
            menuItem.available === true &&
            menuItem.builder_group &&
            menuItem.builder_group === builderProduct.builder_group
        );
    }

    /** Every eligible flavor for a builder product, sorted by name --
     *  exactly what both selectors display. */
    function getEligibleCookies(menuItems, builderProduct) {
        return (menuItems || [])
            .filter(item => isEligibleCookie(item, builderProduct))
            .slice()
            .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    }

    /** required = builder_size * how many boxes of it are being ordered. */
    function getRequiredCount(builderSize, boxQuantity) {
        return toNumber(builderSize, 0) * toNumber(boxQuantity, 0);
    }

    function getSelectedTotal(selections) {
        return (selections || []).reduce((sum, s) => sum + toNumber(s && s.quantity, 0), 0);
    }

    /**
     * Validates one Mix & Match box line. `selections` is the canonical
     * array shape ([{id, name, quantity}, ...]); `eligibleCookies` is the
     * result of getEligibleCookies() for this same builder product right
     * now. Returns a status the UI can key off of directly, plus the
     * numbers needed to render "Selected: X / Y":
     *
     *   ok       -- boxQuantity is 0 (nothing required), OR the selected
     *               total exactly matches the required total and every
     *               selection refers to a currently eligible flavor.
     *   stale    -- one or more selected flavors are no longer eligible
     *               (deleted, marked unavailable, or moved out of this
     *               builder_group since the selection was made) and need
     *               administrator review before the box can be saved.
     *   missing  -- boxQuantity > 0 but there are no selections at all.
     *   under    -- fewer cookies selected than required.
     *   over     -- more cookies selected than required.
     */
    function validateBoxSelection(builderSize, boxQuantity, selections, eligibleCookies) {
        const required = getRequiredCount(builderSize, boxQuantity);
        const list = selections || [];
        const selected = getSelectedTotal(list);

        if (toNumber(boxQuantity, 0) <= 0) {
            return { status: "ok", required, selected, staleSelections: [] };
        }

        const eligibleIds = new Set((eligibleCookies || []).map(c => String(c.id)));
        const staleSelections = list.filter(
            s => s && toNumber(s.quantity, 0) > 0 && !eligibleIds.has(String(s.id))
        );

        if (staleSelections.length) {
            return { status: "stale", required, selected, staleSelections };
        }

        if (!list.length || selected === 0) {
            return { status: "missing", required, selected, staleSelections: [] };
        }

        if (selected < required) {
            return { status: "under", required, selected, staleSelections: [] };
        }

        if (selected > required) {
            return { status: "over", required, selected, staleSelections: [] };
        }

        return { status: "ok", required, selected, staleSelections: [] };
    }

    /**
     * The canonical order_items.builder_details payload -- the exact
     * shape the public checkout (js/cart.js) writes: { builder_group,
     * selections }. box_quantity is an additive, backward-compatible
     * extra field (absent on every pre-existing row) that records the
     * true box count for a line whose selections combine more than one
     * box's worth of cookies into a single aggregate order_items row --
     * see js/order-editor.js for how this is built/consumed.
     */
    function buildBuilderDetails(builderGroup, boxQuantity, selections) {
        return {
            builder_group: builderGroup,
            selections: (selections || []).filter(s => toNumber(s && s.quantity, 0) > 0),
            box_quantity: toNumber(boxQuantity, 0)
        };
    }

    return {
        isEligibleCookie,
        getEligibleCookies,
        getRequiredCount,
        getSelectedTotal,
        validateBoxSelection,
        buildBuilderDetails
    };
});
