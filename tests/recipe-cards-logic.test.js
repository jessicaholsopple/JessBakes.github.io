"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const RecipeCardsLogic = require("../js/recipe-cards-logic.js");

/* ==========================================
   Recipe Cards -- pure status/warning/filter logic
   (js/recipe-cards-logic.js)

   Fixtures mirror the real, confirmed shapes: S'mores Cookies (an
   active recipe with a full ingredient list), Cream Cheese Frosting
   (a genuinely unmapped recipe that is nonetheless used as a
   component elsewhere -- not corrupt), and Classic Boule (a recipe
   with TWO menu-item mappings, neither active -- the real live
   multiple-mapping case). Synthetic-only broken rows are added
   separately to prove the warning checks fire correctly; none of
   this touches a real database.
   ========================================== */

function ingredientRow(id, ingredientId, quantity, name, recipeUnit) {
    return {
        id, ingredient_id: ingredientId, quantity,
        ingredients: ingredientId ? { id: ingredientId, name, recipe_unit: recipeUnit } : null
    };
}

function smoresRecipe() {
    return {
        id: 22, name: "S'mores Cookies", category: "Cookie",
        yield_quantity: 12, yield_unit: "item", notes: "Toast the marshmallow topping under the broiler for 30-60 seconds.",
        recipe_ingredients: [
            ingredientRow(1, 55, 125, "Sourdough Starter", "g"),
            ingredientRow(2, 1, 300, "All-Purpose Flour", "g"),
            ingredientRow(3, 2, 200, "Graham Crackers", "g"),
            ingredientRow(4, 3, 170, "Semi Sweet Chocolate Chips", "g"),
            ingredientRow(5, 4, 100, "Mini Marshmallows", "g"),
            ingredientRow(6, 5, 10, "Vanilla Extract", "mL"),
            ingredientRow(7, 6, 5, "Baking Soda", "g"),
            ingredientRow(8, 7, 5, "Salt", "g"),
            ingredientRow(9, 8, 150, "Brown Sugar", "g"),
            ingredientRow(10, 9, 100, "White Sugar", "g"),
            ingredientRow(11, 10, 227, "Butter", "g"),
            ingredientRow(12, 11, 2, "Eggs", "each"),
            ingredientRow(13, 12, 340, "Honey Graham Crumbs", "g"),
            ingredientRow(14, 13, 50, "Cocoa Powder", "g")
        ],
        recipe_components: []
    };
}

function creamCheeseFrostingRecipe() {
    return {
        id: 10, name: "Cream Cheese Frosting", category: "Dessert",
        yield_quantity: 5, yield_unit: "item", notes: null,
        recipe_ingredients: [
            ingredientRow(50, 20, 227, "Cream Cheese", "g"),
            ingredientRow(51, 21, 113, "Butter", "g")
        ],
        recipe_components: []
    };
}

function cinnamonRollsRecipe() {
    return {
        id: 9, name: "Cinnamon Rolls", category: "Dessert",
        yield_quantity: 8, yield_unit: "item", notes: null,
        recipe_ingredients: [ingredientRow(60, 22, 500, "Bread Flour", "g")],
        recipe_components: [
            { id: 7, component_recipe_id: 10, quantity_used: 4, quantity_unit: "item", component_recipe: { id: 10, name: "Cream Cheese Frosting" } }
        ]
    };
}

function classicBouleRecipe() {
    return {
        id: 1, name: "Classic Boule", category: "Bread",
        yield_quantity: 1, yield_unit: "item", notes: null,
        recipe_ingredients: [ingredientRow(70, 30, 500, "Bread Flour", "g")],
        recipe_components: []
    };
}

const CLASSIC_BOULE_MENU_ITEMS = [
    { id: "m1", name: "Classic Boule", available: false, recipe_id: 1 },
    { id: "m2", name: "Cinnamon Raisin Boule", available: false, recipe_id: 1 }
];

const ACTIVE_MENU_ITEM_FOR_SMORES = { id: "m3", name: "S'mores Cookies", available: true, recipe_id: 22 };

/* ==========================================
   Status derivation
   ========================================== */

test("1. a recipe with an available mapped menu item is 'active'", () => {
    const info = RecipeCardsLogic.deriveRecipeStatus(smoresRecipe(), [ACTIVE_MENU_ITEM_FOR_SMORES]);
    assert.equal(info.status, "active");
    assert.equal(info.activeMappings.length, 1);
});

test("2. a recipe mapped only to unavailable menu items is 'inactive', not 'active' or 'unmapped'", () => {
    const info = RecipeCardsLogic.deriveRecipeStatus(classicBouleRecipe(), CLASSIC_BOULE_MENU_ITEMS);
    assert.equal(info.status, "inactive");
    assert.equal(info.activeMappings.length, 0);
    assert.equal(info.inactiveMappings.length, 2);
});

test("3. a recipe with no menu_items row referencing it at all is 'unmapped'", () => {
    const info = RecipeCardsLogic.deriveRecipeStatus(creamCheeseFrostingRecipe(), CLASSIC_BOULE_MENU_ITEMS);
    assert.equal(info.status, "unmapped");
    assert.equal(info.mappings.length, 0);
});

test("4. status matching is by id, never by name -- two differently-named products can share one recipe", () => {
    const info = RecipeCardsLogic.deriveRecipeStatus(classicBouleRecipe(), CLASSIC_BOULE_MENU_ITEMS);
    assert.equal(info.mappings.length, 2);
    assert.deepEqual(info.mappings.map(m => m.name).sort(), ["Cinnamon Raisin Boule", "Classic Boule"]);
});

test("5. an empty/undefined menu_items list never throws and yields 'unmapped'", () => {
    assert.equal(RecipeCardsLogic.deriveRecipeStatus(smoresRecipe(), []).status, "unmapped");
    assert.equal(RecipeCardsLogic.deriveRecipeStatus(smoresRecipe(), undefined).status, "unmapped");
});

/* ==========================================
   Component usage index (the "unmapped but not broken" case)
   ========================================== */

test("6. buildComponentUsageIndex correctly links Cream Cheese Frosting as used inside Cinnamon Rolls, by id", () => {
    const recipes = [cinnamonRollsRecipe(), creamCheeseFrostingRecipe()];
    const index = RecipeCardsLogic.buildComponentUsageIndex(recipes);
    const usedIn = index.get("10");
    assert.ok(usedIn, "Cream Cheese Frosting (id 10) must appear in the usage index");
    assert.equal(usedIn.length, 1);
    assert.equal(usedIn[0].parentName, "Cinnamon Rolls");
    assert.equal(usedIn[0].quantityUsed, 4);
    assert.equal(usedIn[0].quantityUnit, "item");
});

test("7. a recipe used by no one has no entry in the usage index", () => {
    const index = RecipeCardsLogic.buildComponentUsageIndex([smoresRecipe()]);
    assert.equal(index.has("22"), false);
});

/* ==========================================
   Data-quality warnings -- non-destructive, purely observational
   ========================================== */

test("8. a complete, well-formed recipe (S'mores) produces zero warnings", () => {
    const info = RecipeCardsLogic.deriveRecipeStatus(smoresRecipe(), [ACTIVE_MENU_ITEM_FOR_SMORES]);
    const warnings = RecipeCardsLogic.buildRecipeWarnings(smoresRecipe(), info);
    assert.deepEqual(warnings, []);
});

test("9. a recipe_ingredient row with a missing ingredient reference produces exactly one warning", () => {
    const broken = smoresRecipe();
    broken.recipe_ingredients.push(ingredientRow(99, null, 10, null, null));
    const info = RecipeCardsLogic.deriveRecipeStatus(broken, []);
    const warnings = RecipeCardsLogic.buildRecipeWarnings(broken, info);
    assert.ok(warnings.some(w => /missing ingredient/.test(w)));
});

test("10. a recipe_ingredient row with a null/invalid quantity is flagged, distinctly from a missing ingredient", () => {
    const broken = smoresRecipe();
    broken.recipe_ingredients[0].quantity = null;
    const info = RecipeCardsLogic.deriveRecipeStatus(broken, []);
    const warnings = RecipeCardsLogic.buildRecipeWarnings(broken, info);
    assert.ok(warnings.some(w => /missing or invalid quantity/.test(w)));
    assert.ok(!warnings.some(w => /missing ingredient/.test(w)), "a resolved ingredient with a bad quantity is not also reported as a missing ingredient");
});

test("11. an ingredient with no saved recipe_unit is flagged", () => {
    const broken = smoresRecipe();
    broken.recipe_ingredients[0].ingredients.recipe_unit = null;
    const info = RecipeCardsLogic.deriveRecipeStatus(broken, []);
    const warnings = RecipeCardsLogic.buildRecipeWarnings(broken, info);
    assert.ok(warnings.some(w => /no saved recipe unit/.test(w)));
});

test("12. a recipe with zero ingredients and zero components is flagged as empty", () => {
    const empty = { id: 999, name: "Empty Test Recipe", category: "Test", yield_quantity: 1, yield_unit: "item", notes: null, recipe_ingredients: [], recipe_components: [] };
    const info = RecipeCardsLogic.deriveRecipeStatus(empty, []);
    const warnings = RecipeCardsLogic.buildRecipeWarnings(empty, info);
    assert.ok(warnings.some(w => /no ingredients or components/.test(w)));
});

test("13. a missing or invalid stored yield is flagged (quantity and unit are checked independently)", () => {
    const badYieldQty = { ...smoresRecipe(), yield_quantity: null };
    const w1 = RecipeCardsLogic.buildRecipeWarnings(badYieldQty, RecipeCardsLogic.deriveRecipeStatus(badYieldQty, []));
    assert.ok(w1.some(w => /yield quantity is missing or invalid/.test(w)));

    const zeroYield = { ...smoresRecipe(), yield_quantity: 0 };
    const w2 = RecipeCardsLogic.buildRecipeWarnings(zeroYield, RecipeCardsLogic.deriveRecipeStatus(zeroYield, []));
    assert.ok(w2.some(w => /yield quantity is missing or invalid/.test(w)));

    const badYieldUnit = { ...smoresRecipe(), yield_unit: "" };
    const w3 = RecipeCardsLogic.buildRecipeWarnings(badYieldUnit, RecipeCardsLogic.deriveRecipeStatus(badYieldUnit, []));
    assert.ok(w3.some(w => /yield unit is missing/.test(w)));
});

test("14. a recipe_components row referencing a missing component recipe is flagged", () => {
    const broken = cinnamonRollsRecipe();
    broken.recipe_components[0].component_recipe = null;
    const info = RecipeCardsLogic.deriveRecipeStatus(broken, []);
    const warnings = RecipeCardsLogic.buildRecipeWarnings(broken, info);
    assert.ok(warnings.some(w => /recipe component.*missing recipe/.test(w)));
});

test("15. multiple ACTIVE menu-item mappings for one recipe are flagged as unusual", () => {
    const recipe = smoresRecipe();
    const twoActiveMappings = [
        { id: "a", name: "S'mores Cookies", available: true, recipe_id: 22 },
        { id: "b", name: "S'mores Cookies (Large Box)", available: true, recipe_id: 22 }
    ];
    const info = RecipeCardsLogic.deriveRecipeStatus(recipe, twoActiveMappings);
    const warnings = RecipeCardsLogic.buildRecipeWarnings(recipe, info);
    assert.ok(warnings.some(w => /2 active menu products/.test(w)));
});

test("16. a valid unmapped recipe (no data problems) still produces zero warnings -- unmapped is not treated as automatically corrupt", () => {
    const info = RecipeCardsLogic.deriveRecipeStatus(creamCheeseFrostingRecipe(), []);
    const warnings = RecipeCardsLogic.buildRecipeWarnings(creamCheeseFrostingRecipe(), info);
    assert.deepEqual(warnings, []);
});

/* ==========================================
   Search / category / status filtering
   ========================================== */

function buildViews(menuItems) {
    const recipes = [smoresRecipe(), creamCheeseFrostingRecipe(), classicBouleRecipe()];
    return recipes.map(recipe => {
        const info = RecipeCardsLogic.deriveRecipeStatus(recipe, menuItems);
        return { recipe, ...info, warnings: RecipeCardsLogic.buildRecipeWarnings(recipe, info) };
    });
}

test("17. search matches by name, case-insensitively, and returns every current recipe when empty", () => {
    const views = buildViews([ACTIVE_MENU_ITEM_FOR_SMORES, ...CLASSIC_BOULE_MENU_ITEMS]);

    const smoresOnly = RecipeCardsLogic.filterRecipes(views, { search: "s'mores" });
    assert.equal(smoresOnly.length, 1);
    assert.equal(smoresOnly[0].recipe.name, "S'mores Cookies");

    const all = RecipeCardsLogic.filterRecipes(views, { search: "" });
    assert.equal(all.length, 3);
});

test("18. category filter returns only recipes in that exact category", () => {
    const views = buildViews([]);
    const breadOnly = RecipeCardsLogic.filterRecipes(views, { category: "Bread" });
    assert.equal(breadOnly.length, 1);
    assert.equal(breadOnly[0].recipe.name, "Classic Boule");
});

test("19. status filter returns exactly the recipes with that derived status", () => {
    const views = buildViews([ACTIVE_MENU_ITEM_FOR_SMORES, ...CLASSIC_BOULE_MENU_ITEMS]);

    const active = RecipeCardsLogic.filterRecipes(views, { status: "active" });
    assert.deepEqual(active.map(v => v.recipe.name), ["S'mores Cookies"]);

    const inactive = RecipeCardsLogic.filterRecipes(views, { status: "inactive" });
    assert.deepEqual(inactive.map(v => v.recipe.name), ["Classic Boule"]);

    const unmapped = RecipeCardsLogic.filterRecipes(views, { status: "unmapped" });
    assert.deepEqual(unmapped.map(v => v.recipe.name), ["Cream Cheese Frosting"]);
});

test("20. search, category, and status filters combine (AND, not OR)", () => {
    const views = buildViews([ACTIVE_MENU_ITEM_FOR_SMORES]);
    const result = RecipeCardsLogic.filterRecipes(views, { search: "cookies", category: "Cookie", status: "active" });
    assert.equal(result.length, 1);
    assert.equal(result[0].recipe.name, "S'mores Cookies");

    const noMatch = RecipeCardsLogic.filterRecipes(views, { search: "cookies", category: "Bread" });
    assert.equal(noMatch.length, 0);
});

test("21. filterRecipes preserves the given order -- it never re-sorts", () => {
    const views = buildViews([]);
    const result = RecipeCardsLogic.filterRecipes(views, {});
    assert.deepEqual(result.map(v => v.recipe.id), views.map(v => v.recipe.id));
});

/* ==========================================
   Category list -- built from real data, never hardcoded
   ========================================== */

test("22. distinctCategories returns the real, alphabetized categories actually present", () => {
    const recipes = [smoresRecipe(), creamCheeseFrostingRecipe(), classicBouleRecipe()];
    assert.deepEqual(RecipeCardsLogic.distinctCategories(recipes), ["Bread", "Cookie", "Dessert"]);
});

test("23. distinctCategories ignores null/blank categories rather than adding an empty option", () => {
    const recipes = [{ id: 1, name: "X", category: null }, { id: 2, name: "Y", category: "  " }, { id: 3, name: "Z", category: "Bread" }];
    assert.deepEqual(RecipeCardsLogic.distinctCategories(recipes), ["Bread"]);
});
