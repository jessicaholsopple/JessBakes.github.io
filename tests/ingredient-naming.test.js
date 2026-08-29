"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const IngredientNaming = require("../js/ingredient-naming.js");

/* ==========================================
   Ingredient naming (js/ingredient-naming.js) -- grammatically
   correct singular/plural DISPLAY for count-unit recipe ingredients
   (Eggs / Egg Yolks), without ever changing the stored canonical name.
   ========================================== */

test("1. singularize strips a trailing s: Eggs -> Egg, Egg Yolks -> Egg Yolk", () => {
    assert.equal(IngredientNaming.singularize("Eggs"), "Egg");
    assert.equal(IngredientNaming.singularize("Egg Yolks"), "Egg Yolk");
});

test("2. singularize leaves a name with no trailing s unchanged", () => {
    assert.equal(IngredientNaming.singularize("Butter"), "Butter");
    assert.equal(IngredientNaming.singularize("Flour"), "Flour");
});

test("3. singularize never strips from a word ending in ss", () => {
    assert.equal(IngredientNaming.singularize("Swiss"), "Swiss");
});

test("4. singularize handles empty/null/undefined safely", () => {
    assert.equal(IngredientNaming.singularize(""), "");
    assert.equal(IngredientNaming.singularize(null), "");
    assert.equal(IngredientNaming.singularize(undefined), "");
});

test("5. pluralDisplayName: quantity 1 shows the singular form (2 Egg Yolks example -> at qty 1, '1 Egg Yolk')", () => {
    assert.equal(IngredientNaming.pluralDisplayName("Egg Yolks", 1), "Egg Yolk");
    assert.equal(IngredientNaming.pluralDisplayName("Eggs", 1), "Egg");
});

test("6. pluralDisplayName: any other quantity keeps the stored plural name unchanged", () => {
    assert.equal(IngredientNaming.pluralDisplayName("Eggs", 2), "Eggs");
    assert.equal(IngredientNaming.pluralDisplayName("Egg Yolks", 4), "Egg Yolks");
    assert.equal(IngredientNaming.pluralDisplayName("Eggs", 0), "Eggs");
    assert.equal(IngredientNaming.pluralDisplayName("Egg Yolks", 0.5), "Egg Yolks");
});

test("7. pluralDisplayName is decimal-safe at exactly 1 (e.g. a scaled 0.5x of 2 Egg Yolks), and float noise indistinguishable from 1 still singularizes", () => {
    assert.equal(IngredientNaming.pluralDisplayName("Egg Yolks", 1.0), "Egg Yolk");
    // Genuinely different from 1 (0.999) must stay plural.
    assert.equal(IngredientNaming.pluralDisplayName("Egg Yolks", 0.999), "Egg Yolks");
    // Float noise indistinguishable from 1 within a tiny epsilon (e.g.
    // 0.1 * 3 * (1/0.3) type rounding artifacts) still singularizes.
    assert.equal(IngredientNaming.pluralDisplayName("Egg Yolks", 0.9999999999), "Egg Yolk");
});

test("8. pluralDisplayName never mutates the input string / has no side effects", () => {
    const name = "Egg Yolks";
    IngredientNaming.pluralDisplayName(name, 1);
    assert.equal(name, "Egg Yolks");
});

test("9. the exact required examples: '2 Egg Yolks', '1 Egg', '1 Egg Yolk'", () => {
    assert.equal(IngredientNaming.pluralDisplayName("Egg Yolks", 2), "Egg Yolks");
    assert.equal(IngredientNaming.pluralDisplayName("Eggs", 1), "Egg");
    assert.equal(IngredientNaming.pluralDisplayName("Egg Yolks", 1), "Egg Yolk");
});
