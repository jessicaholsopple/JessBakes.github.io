/* ==========================================
   INGREDIENT NAMING (shared, pure)
   ==========================================

   Grammatically correct singular/plural DISPLAY for a stored
   ingredient name, without ever changing the stored canonical name
   itself (e.g. "Eggs" and "Egg Yolks" stay stored exactly as-is;
   only what's shown next to a specific quantity is adjusted).

   Deliberately a plain trailing-"s" rule, not a general English
   pluralization library: this bakery's only count-unit ("each")
   recipe ingredients are Eggs and Egg Yolks (verified directly
   against live data during the Egg/Egg Yolk audit -- every other
   "each"-unit ingredient is a packaging item, never a recipe
   ingredient), so a small, predictable, auditable rule is safer than
   a general-purpose grammar dependency that could mishandle an
   ingredient added later. Words ending in "ss" (e.g. a hypothetical
   "Swiss ...") are deliberately never singularized by this rule.
   ========================================== */

(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.IngredientNaming = factory();
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    /** "Eggs" -> "Egg", "Egg Yolks" -> "Egg Yolk". Leaves a name with
     * no trailing "s" (or ending in "ss") completely unchanged. */
    function singularize(name) {
        const trimmed = String(name || "").trim();
        if (!trimmed) return trimmed;
        if (/ss$/.test(trimmed)) return trimmed;
        if (/s$/.test(trimmed)) return trimmed.slice(0, -1);
        return trimmed;
    }

    /** The stored name is assumed to already be the natural PLURAL
     * form (matching this codebase's convention -- "Eggs", "Egg
     * Yolks"). Returns the singular form only when quantity is
     * exactly 1 (decimal-safe); any other quantity (0, 0.5, 2, 3, ...)
     * keeps the stored plural name unchanged. */
    function pluralDisplayName(name, quantity) {
        const n = Number(quantity);
        if (Number.isFinite(n) && Math.abs(n - 1) < 1e-9) {
            return singularize(name);
        }
        return String(name || "");
    }

    return { singularize, pluralDisplayName };
});
