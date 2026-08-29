/* ==========================================
   RECIPE CARDS -- pure data logic (shared, no DOM/network)
   ==========================================

   Status, data-quality warnings, component-usage linking, and
   search/filter for the Admin Recipe Cards page. Deliberately kept
   pure and separate from js/admin-recipe-cards.js's rendering code so
   every rule here is directly unit-testable with plain fixture data,
   matching this project's established pattern (js/quantity-format.js,
   js/currency-conversion.js, js/vacation-mode.js, ...).

   Read-only by construction: every function here only ever reads its
   arguments and returns a new value. Nothing in this file can create,
   update, delete, or archive a recipe, ingredient, or product mapping
   -- there is no Supabase client in scope at all.

   -------------------------------------------------------------------
   On "status" (active / inactive / unmapped)
   -------------------------------------------------------------------
   This schema has no `archived` or `status` column on `recipes` or
   `menu_items` -- only `menu_items.available` (a plain boolean).
   Status here is therefore derived ONLY from real, stable
   relationships (menu_items rows whose recipe_id matches this
   recipe's id, matched by id -- never by name):
     - "active"   -- at least one mapped menu_items row is available
     - "inactive" -- mapped, but every mapped row is unavailable
     - "unmapped" -- no menu_items row references this recipe at all
   An "archived" recipe, in the sense of a deliberately retired product
   whose recipe is kept for reference, is represented in this data as
   an "inactive" (unavailable) or "unmapped" recipe -- there is no
   separate archived flag to read, and none is invented here.
   ========================================== */

(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.RecipeCardsLogic = factory();
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    /** Every menu_items row referencing this recipe's id -- ALL of
     * them, active or not. Never `.eq("available", true)`-filtered at
     * the query level and never re-filtered here either -- that inner-
     * join-to-active-product trap is exactly what silently hides a
     * recipe like an inactive/retired product's. Matched by id, never
     * by name (two differently-named menu products can legitimately
     * share one base recipe -- see Classic Boule / Cinnamon Raisin
     * Boule in the live data). */
    function mappingsForRecipe(recipe, menuItems) {
        return (menuItems || []).filter(mi => String(mi.recipe_id) === String(recipe.id));
    }

    function deriveRecipeStatus(recipe, menuItems) {
        const mappings = mappingsForRecipe(recipe, menuItems);
        const activeMappings = mappings.filter(mi => mi.available === true);
        const inactiveMappings = mappings.filter(mi => mi.available !== true);

        let status;
        if (activeMappings.length > 0) status = "active";
        else if (inactiveMappings.length > 0) status = "inactive";
        else status = "unmapped";

        return { status, mappings, activeMappings, inactiveMappings };
    }

    /** Reverse index: recipe id (string key) -> [{parentId, parentName,
     * quantityUsed, quantityUnit}] for every OTHER recipe that consumes
     * it as a sub-recipe component (recipe_components). Built entirely
     * from the recipe_components rows already embedded on each loaded
     * recipe -- no second query, and every link is by id, never a name
     * match. This is what correctly explains an "unmapped" recipe like
     * Cream Cheese Frosting: it has no menu product of its own, but IS
     * used inside Cinnamon Rolls/Strawberry Rolls/Nutella Rolls/
     * Blueberry Rolls -- a normal, valid case, not a broken one. */
    function buildComponentUsageIndex(recipes) {
        const index = new Map();
        (recipes || []).forEach(parent => {
            (parent.recipe_components || []).forEach(component => {
                if (!component.component_recipe_id) return;
                const key = String(component.component_recipe_id);
                if (!index.has(key)) index.set(key, []);
                index.get(key).push({
                    parentId: parent.id,
                    parentName: parent.name,
                    quantityUsed: component.quantity_used,
                    quantityUnit: component.quantity_unit
                });
            });
        });
        return index;
    }

    /** Non-destructive, read-only data-quality warnings for one recipe.
     * `mappingInfo` is the result of deriveRecipeStatus, passed in so it
     * is never recomputed. Every check only describes what is already
     * stored -- nothing here repairs, guesses, or writes anything. */
    function buildRecipeWarnings(recipe, mappingInfo) {
        const warnings = [];
        const ingredientRows = recipe.recipe_ingredients || [];
        const componentRows = recipe.recipe_components || [];

        const missingIngredientRefs = ingredientRows.filter(row => !row.ingredient_id || !row.ingredients);
        if (missingIngredientRefs.length > 0) {
            warnings.push(
                `${missingIngredientRefs.length} recipe ingredient${missingIngredientRefs.length === 1 ? "" : "s"} ` +
                `reference${missingIngredientRefs.length === 1 ? "s" : ""} a missing ingredient.`
            );
        }

        const badQuantities = ingredientRows.filter(row =>
            row.ingredient_id && row.ingredients &&
            (row.quantity === null || row.quantity === undefined || !Number.isFinite(Number(row.quantity)))
        );
        if (badQuantities.length > 0) {
            warnings.push(
                `${badQuantities.length} ingredient${badQuantities.length === 1 ? "" : "s"} ` +
                `${badQuantities.length === 1 ? "has" : "have"} a missing or invalid quantity.`
            );
        }

        const missingUnits = ingredientRows.filter(row =>
            row.ingredient_id && row.ingredients && !row.ingredients.recipe_unit
        );
        if (missingUnits.length > 0) {
            warnings.push(
                `${missingUnits.length} ingredient${missingUnits.length === 1 ? "" : "s"} ` +
                `${missingUnits.length === 1 ? "has" : "have"} no saved recipe unit.`
            );
        }

        if (ingredientRows.length === 0 && componentRows.length === 0) {
            warnings.push("This recipe has no ingredients or components saved.");
        }

        const yieldQty = Number(recipe.yield_quantity);
        if (recipe.yield_quantity === null || recipe.yield_quantity === undefined || !Number.isFinite(yieldQty) || yieldQty <= 0) {
            warnings.push("This recipe's yield quantity is missing or invalid.");
        }
        if (!recipe.yield_unit || !String(recipe.yield_unit).trim()) {
            warnings.push("This recipe's yield unit is missing.");
        }

        const missingComponentRefs = componentRows.filter(row => !row.component_recipe_id || !row.component_recipe);
        if (missingComponentRefs.length > 0) {
            warnings.push(
                `${missingComponentRefs.length} recipe component${missingComponentRefs.length === 1 ? "" : "s"} ` +
                `reference${missingComponentRefs.length === 1 ? "s" : ""} a missing recipe.`
            );
        }

        if (mappingInfo && mappingInfo.activeMappings && mappingInfo.activeMappings.length > 1) {
            warnings.push(`${mappingInfo.activeMappings.length} active menu products are currently mapped to this recipe.`);
        }

        return warnings;
    }

    /** Search (by name) + category + status filter, applied together.
     * Pure -- takes the full list of {recipe, status, ...} views
     * (already annotated by the caller via deriveRecipeStatus) and
     * returns the filtered subset in the SAME order it was given
     * (the underlying query is already ordered by name -- this never
     * re-sorts). */
    function filterRecipes(recipeViews, { search, category, status } = {}) {
        const term = String(search || "").trim().toLowerCase();
        return (recipeViews || []).filter(view => {
            if (term && !String(view.recipe.name || "").toLowerCase().includes(term)) return false;
            if (category && category !== "all" && (view.recipe.category || "") !== category) return false;
            if (status && status !== "all" && view.status !== status) return false;
            return true;
        });
    }

    /** Distinct, real recipe categories present in the loaded data,
     * alphabetized -- built from the data itself so the filter can
     * never drift from what's actually stored (never a hardcoded
     * list). */
    function distinctCategories(recipes) {
        const set = new Set();
        (recipes || []).forEach(r => {
            if (r.category && String(r.category).trim()) set.add(r.category);
        });
        return Array.from(set).sort((a, b) => a.localeCompare(b));
    }

    return {
        mappingsForRecipe,
        deriveRecipeStatus,
        buildComponentUsageIndex,
        buildRecipeWarnings,
        filterRecipes,
        distinctCategories
    };
});
