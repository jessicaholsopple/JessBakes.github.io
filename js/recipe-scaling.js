/* ==========================================
   RECIPE SCALING (shared, pure, display-only)
   ==========================================

   Pure arithmetic for the Recipe Cards page's batch-scaling control
   (0.5x / 1x / 2x / 3x / custom). Deliberately isolated from any DOM,
   Supabase, or rendering code -- this module only ever answers "what
   would this quantity look like at this multiplier," it never reads
   or writes a recipe. Nothing here can save, and nothing here mutates
   its inputs.

   Decimal-safe: floating-point multiplication can introduce noise
   (e.g. 0.1 * 3 === 0.30000000000000004 in raw IEEE-754 math).
   scaleQuantity rounds to 6 decimal places -- far beyond any real
   recipe quantity's precision -- using the same Number.EPSILON guard
   js/currency-conversion.js's roundCents already uses for currency,
   just at a finer grain appropriate for ingredient quantities (a
   currency amount never needs more than 2 decimal places; a recipe
   quantity like 0.05 g does).

   Unit-agnostic by design: scaleQuantity only ever multiplies the
   stored NUMBER. It never inspects, converts, or infers a unit --
   grams stay grams, cups stay cups, a scaled 3x batch of "0.05 g"
   becomes "0.15 g", never "150 mg" or any other automatic conversion.
   ========================================== */

(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.RecipeScaling = factory();
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const PRESET_MULTIPLIERS = [0.5, 1, 2, 3];
    const DEFAULT_MULTIPLIER = 1;

    /** Validates a candidate multiplier (typically from the "Custom"
     * input). Only a positive, finite number is valid -- zero, negative,
     * NaN, Infinity, and non-numeric input are all rejected so the
     * caller can show validation instead of producing a nonsense
     * (negative or infinite) scaled quantity. Returns null, never a
     * fabricated fallback, when invalid. */
    function parseMultiplier(value) {
        if (value === null || value === undefined || value === "") return null;
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return null;
        return n;
    }

    /** Multiplies a single stored quantity by a multiplier, decimal-safe.
     * Returns null (never a guessed number) if either input isn't a
     * valid positive-multiplier situation -- callers should already have
     * validated the multiplier via parseMultiplier before reaching here,
     * but this stays defensive on its own. A quantity of exactly 0 is a
     * legitimate value (scales to 0), so it is NOT treated as invalid. */
    function scaleQuantity(quantity, multiplier) {
        const q = Number(quantity);
        const m = parseMultiplier(multiplier);
        if (!Number.isFinite(q) || m === null) return null;

        const raw = q * m;
        return Math.round((raw + Number.EPSILON) * 1e6) / 1e6;
    }

    /** Scales a recipe's base yield the same way as any ingredient
     * quantity -- same function, same rounding, so yield and ingredient
     * scaling can never silently disagree. */
    function scaleYield(yieldQuantity, multiplier) {
        return scaleQuantity(yieldQuantity, multiplier);
    }

    /** Scales every ingredient in a recipe_ingredients-shaped list,
     * preserving every other field (id, ingredient_id, the embedded
     * ingredient, its unit) untouched -- only the numeric quantity is
     * multiplied. Returns the ORIGINAL, unscaled quantity under
     * `baseQuantity` alongside the new `scaledQuantity`, so a caller can
     * always show or reconcile both without re-deriving the base value.
     * Never mutates the input array or its objects. */
    function scaleIngredientList(ingredientRows, multiplier) {
        return (ingredientRows || []).map(row => ({
            ...row,
            baseQuantity: Number(row.quantity),
            scaledQuantity: scaleQuantity(row.quantity, multiplier)
        }));
    }

    /** true only for the exact base multiplier (1x) -- used to confirm
     * "returning to 1x reproduces the exact saved base recipe" (scaling
     * at 1x must be a no-op, not merely "close"). */
    function isBaseMultiplier(multiplier) {
        return parseMultiplier(multiplier) === DEFAULT_MULTIPLIER;
    }

    return {
        PRESET_MULTIPLIERS,
        DEFAULT_MULTIPLIER,
        parseMultiplier,
        scaleQuantity,
        scaleYield,
        scaleIngredientList,
        isBaseMultiplier
    };
});
