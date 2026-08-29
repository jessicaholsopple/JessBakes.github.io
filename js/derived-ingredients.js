/* ==========================================
   DERIVED INGREDIENTS (shared, pure)
   ==========================================

   Reads the derived_from_ingredient_id / derived_factor relationship
   added by the Egg/Egg Yolk migration (supabase/migrations/
   20260829090000_egg_yolk_derived_ingredient.sql). This is the ONE
   place any admin page resolves "is this ingredient derived, and
   from what" -- always by stable ingredient id, never by comparing
   ingredient names.

   The database is the actual source of truth for the NUMBERS (a
   trigger forces a derived ingredient's quantity_on_hand/
   minimum_quantity/purchase_size/purchase_price to always equal its
   source, scaled by derived_factor -- see the migration) -- these
   functions exist so every page's DISPLAY/aggregation logic can
   consistently identify and exclude/merge derived rows without
   duplicating that knowledge, not to recompute or duplicate the
   trigger's own math.
   ========================================== */

(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.DerivedIngredients = factory();
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    function isDerived(ingredient) {
        return !!(ingredient && ingredient.derived_from_ingredient_id);
    }

    /** Only the physical, independently-purchased ingredients --
     * excludes any derived row (e.g. Egg Yolks). Used everywhere a
     * count/sum/list is meant to represent actual purchased stock
     * (inventory value, low-stock counts, shopping lists, restock
     * recommendations, ingredient row counts) so a derived ingredient
     * is never double-counted alongside its own source. */
    function physicalOnly(ingredientList) {
        return (ingredientList || []).filter(ingredient => !isDerived(ingredient));
    }

    function buildIngredientMap(ingredientList) {
        return new Map((ingredientList || []).map(ingredient => [String(ingredient.id), ingredient]));
    }

    /** Resolves one ingredient to the physical ingredient that actually
     * carries its stock -- itself, if it isn't derived, or its source
     * (looked up by id in `ingredientsById`, a Map) otherwise. Returns
     * null only if the ingredient is derived but its source can no
     * longer be found (a broken link) -- callers must not guess a
     * physical id in that case. */
    function resolvePhysical(ingredient, ingredientsById) {
        if (!ingredient) return null;
        if (!isDerived(ingredient)) {
            return { physical: ingredient, factor: 1, isDerived: false };
        }
        const source = ingredientsById && ingredientsById.get
            ? ingredientsById.get(String(ingredient.derived_from_ingredient_id))
            : null;
        if (!source) return null;
        return { physical: source, factor: Number(ingredient.derived_factor) || 1, isDerived: true };
    }

    /** Resolves + scales a quantity of `ingredient` (which may be
     * derived) into the equivalent quantity of its physical source.
     * `1 Egg Yolk` -> `{ ingredient: <Eggs row>, quantity: 1 }`;
     * `12 Egg Yolks` -> `{ ingredient: <Eggs row>, quantity: 12 }`
     * (factor 1). A non-derived ingredient resolves to itself with the
     * quantity unchanged. Returns null (never a guessed amount) if the
     * derived link is broken. */
    function resolvePhysicalQuantity(ingredient, quantity, ingredientsById) {
        const resolved = resolvePhysical(ingredient, ingredientsById);
        if (!resolved) return null;
        return {
            ingredient: resolved.physical,
            quantity: Number(quantity || 0) * resolved.factor,
            isDerived: resolved.isDerived,
            sourceLabel: ingredient.name
        };
    }

    return {
        isDerived,
        physicalOnly,
        buildIngredientMap,
        resolvePhysical,
        resolvePhysicalQuantity
    };
});
