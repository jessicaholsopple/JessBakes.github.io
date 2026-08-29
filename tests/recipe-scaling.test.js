"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const RecipeScaling = require("../js/recipe-scaling.js");

/* ==========================================
   Recipe Cards -- batch scaling (js/recipe-scaling.js)

   Display-only: this module never touches Supabase and is never given
   a client to write with. See tests/admin-recipe-cards.test.js for the
   proof that scaling in the real page never issues a mutation call.
   ========================================== */

test("1. parseMultiplier accepts positive finite numbers, including decimals", () => {
    assert.equal(RecipeScaling.parseMultiplier(0.5), 0.5);
    assert.equal(RecipeScaling.parseMultiplier(1), 1);
    assert.equal(RecipeScaling.parseMultiplier(2), 2);
    assert.equal(RecipeScaling.parseMultiplier(3), 3);
    assert.equal(RecipeScaling.parseMultiplier("1.5"), 1.5);
    assert.equal(RecipeScaling.parseMultiplier(2.75), 2.75);
});

test("2. parseMultiplier rejects zero, negative, NaN, Infinity, and non-numeric input", () => {
    assert.equal(RecipeScaling.parseMultiplier(0), null);
    assert.equal(RecipeScaling.parseMultiplier(-1), null);
    assert.equal(RecipeScaling.parseMultiplier(-0.5), null);
    assert.equal(RecipeScaling.parseMultiplier(NaN), null);
    assert.equal(RecipeScaling.parseMultiplier(Infinity), null);
    assert.equal(RecipeScaling.parseMultiplier("abc"), null);
    assert.equal(RecipeScaling.parseMultiplier(null), null);
    assert.equal(RecipeScaling.parseMultiplier(undefined), null);
    assert.equal(RecipeScaling.parseMultiplier(""), null);
});

test("3. the four preset multipliers are exactly 0.5x, 1x, 2x, 3x", () => {
    assert.deepEqual(RecipeScaling.PRESET_MULTIPLIERS, [0.5, 1, 2, 3]);
    assert.equal(RecipeScaling.DEFAULT_MULTIPLIER, 1);
});

test("4. scaleQuantity multiplies correctly at every preset", () => {
    assert.equal(RecipeScaling.scaleQuantity(680, 0.5), 340);
    assert.equal(RecipeScaling.scaleQuantity(680, 1), 680);
    assert.equal(RecipeScaling.scaleQuantity(680, 2), 1360);
    assert.equal(RecipeScaling.scaleQuantity(680, 3), 2040);
});

test("5. scaleQuantity is decimal-safe against float noise (0.1 * 3 must be exactly 0.3, not 0.30000000000000004)", () => {
    assert.equal(RecipeScaling.scaleQuantity(0.1, 3), 0.3);
    assert.equal(RecipeScaling.scaleQuantity(1.1, 3), 3.3);
});

test("6. a very small stored quantity (0.05) scales precisely, never losing precision", () => {
    assert.equal(RecipeScaling.scaleQuantity(0.05, 2), 0.1);
    assert.equal(RecipeScaling.scaleQuantity(0.05, 1), 0.05);
    assert.equal(RecipeScaling.scaleQuantity(0.05, 0.5), 0.025);
});

test("7. a custom multiplier scales correctly (e.g. 1.5x, 2.25x)", () => {
    assert.equal(RecipeScaling.scaleQuantity(200, 1.5), 300);
    assert.equal(RecipeScaling.scaleQuantity(200, 2.25), 450);
});

test("8. scaleQuantity returns null (never a guessed number) for an invalid multiplier", () => {
    assert.equal(RecipeScaling.scaleQuantity(100, 0), null);
    assert.equal(RecipeScaling.scaleQuantity(100, -1), null);
    assert.equal(RecipeScaling.scaleQuantity(100, "not a number"), null);
});

test("9. scaleQuantity treats a genuine zero quantity as valid (scales to 0), not as an error", () => {
    assert.equal(RecipeScaling.scaleQuantity(0, 2), 0);
});

test("10. scaleYield scales identically to scaleQuantity (same rounding, same rules)", () => {
    assert.equal(RecipeScaling.scaleYield(12, 2), 24);
    assert.equal(RecipeScaling.scaleYield(12, 0.5), 6);
    assert.equal(RecipeScaling.scaleYield(12, 3), 36);
});

test("11. isBaseMultiplier is true only for exactly 1x", () => {
    assert.equal(RecipeScaling.isBaseMultiplier(1), true);
    assert.equal(RecipeScaling.isBaseMultiplier("1"), true);
    assert.equal(RecipeScaling.isBaseMultiplier(0.5), false);
    assert.equal(RecipeScaling.isBaseMultiplier(2), false);
    assert.equal(RecipeScaling.isBaseMultiplier(1.0001), false);
});

test("12. returning to 1x reproduces the exact saved base quantity (round trip through 2x and back)", () => {
    const base = 680;
    const scaled = RecipeScaling.scaleQuantity(base, 2);
    assert.equal(scaled, 1360);
    const backToBase = RecipeScaling.scaleQuantity(base, 1);
    assert.equal(backToBase, base, "1x must reproduce the exact original value");
});

test("13. scaleIngredientList scales every row's quantity while preserving every other field untouched", () => {
    const rows = [
        { id: 1, ingredient_id: 10, quantity: 680, ingredients: { name: "Chocolate Chips", recipe_unit: "g" } },
        { id: 2, ingredient_id: 20, quantity: 0.05, ingredients: { name: "Salt", recipe_unit: "g" } }
    ];
    const scaled = RecipeScaling.scaleIngredientList(rows, 2);

    assert.equal(scaled[0].baseQuantity, 680);
    assert.equal(scaled[0].scaledQuantity, 1360);
    assert.equal(scaled[0].ingredients.name, "Chocolate Chips");
    assert.equal(scaled[0].ingredients.recipe_unit, "g", "unit is never converted or altered by scaling");

    assert.equal(scaled[1].baseQuantity, 0.05);
    assert.equal(scaled[1].scaledQuantity, 0.1);

    // Original rows must be untouched.
    assert.equal(rows[0].quantity, 680);
    assert.equal(rows[1].quantity, 0.05);
});

test("14. scaling never converts or infers a different unit -- the unit is not a scaleQuantity concern at all", () => {
    // scaleQuantity's signature takes only a number; passing "unit-ish"
    // data has no effect because there is no unit parameter to begin
    // with -- this test documents that guarantee structurally.
    assert.equal(RecipeScaling.scaleQuantity.length, 2);
});
