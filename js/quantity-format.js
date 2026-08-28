/* ==========================================
   QUANTITY FORMAT (shared, pure)
   ==========================================

   Single canonical quantity-display formatter for Inventory, Recipes,
   Production, and Shopping Lists -- replaces two independent,
   hand-rolled implementations that had drifted apart:

     - js/admin-inventory.js's old formatEQuantity() ended with
       .replace(/0$/, "") -- a regex with no decimal-point anchor, so
       it stripped the LAST character of any string ending in "0",
       including a plain integer. 680 -> "680.00" -> (first replace)
       "680" -> (second replace) "68". Same for every whole quantity
       ending in zero: 170 -> 17, 100 -> 10, 1000 -> 100, etc. This was
       the confirmed root cause of the "grams displaying wrong"
       report -- proven display-only: every call site here only ever
       feeds a formatted STRING into the DOM, never back into a
       calculation (isLowStock, inventory value, shopping-list
       shortfall, and every recipe/production cost all read the raw
       Number(...) value directly, never this formatter's output).
     - js/admin-production.js's old fmt() was written correctly
       (.replace(/(\.\d)0$/,"$1") -- the decimal point is a required,
       literal part of the match, so it can never touch a bare
       integer) but was a second, separately-maintained copy of the
       same responsibility. Verified to produce identical output to
       this shared version for every value Production actually uses
       (whole batch counts, fractional batches, recipe-unit
       quantities) before the swap.

   Kept deliberately separate from currency formatting (usd() stays
   local to each page -- a price is never a measurement and must never
   share a formatter with one) and from unit conversion (that lives in
   the recipe_costs Postgres view / js/admin-production.js's own
   convert(), not here -- this module only ever formats a number that
   has ALREADY been resolved to its final unit).

   This file has no dependency on the DOM or Supabase -- runs
   unmodified in the browser (as a normal <script> tag, exposing
   `window.QuantityFormat`) or under Node (via
   `require("./quantity-format.js")`).
   ========================================== */

(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.QuantityFormat = factory();
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    /**
     * Parses a raw value (string, number, null, undefined) into a
     * finite number, or null when it can't be safely interpreted as
     * one. Deliberately returns null rather than 0 for a genuinely
     * invalid/missing value -- formatQuantity() below is the one place
     * that decides null displays as "0"; a caller that needs to tell
     * "explicitly zero" apart from "missing/invalid" can use this
     * directly instead.
     */
    function parseQuantity(value) {
        if (value === null || value === undefined || value === "") return null;
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }

    /**
     * Formats a raw numeric quantity for display:
     *   - up to 2 decimal places, insignificant trailing zeros AFTER
     *     the decimal point removed (1.20 -> "1.2", 0.50 -> "0.5")
     *   - thousands-grouped (1000 -> "1,000", 2500 -> "2,500")
     *   - NEVER touches a meaningful integer digit -- 680 stays
     *     "680", 170 stays "170", 1000 stays "1,000", never "68",
     *     "17", or "100"
     *   - invalid/missing values format as "0", never "NaN"
     *
     * Raw numeric values must stay separate from this formatted
     * string everywhere else in the app: never parse a quantity back
     * out of this function's output for a calculation.
     */
    function formatQuantity(value) {
        const n = parseQuantity(value);
        if (n === null) return "0";
        return new Intl.NumberFormat("en-US", {
            minimumFractionDigits: 0,
            maximumFractionDigits: 2
        }).format(n);
    }

    /**
     * Normalizes a unit string for case/whitespace/trailing-period-
     * insensitive comparison ("G" / "g." / " g " all normalize to
     * "g") without inferring or fabricating any conversion. Matches
     * the exact normalization the recipe_costs Postgres view and
     * js/admin-production.js's own unit() helper already apply
     * (lower-case, trim, single internal spaces) -- kept in sync by
     * hand across the SQL/JS boundary, the same convention used
     * elsewhere in this project for a dual-environment pure function.
     */
    function normalizeUnit(unit) {
        return String(unit || "")
            .trim()
            .toLowerCase()
            .replace(/\.$/, "")
            .replace(/\s+/g, " ");
    }

    return {
        parseQuantity,
        formatQuantity,
        normalizeUnit
    };
});
