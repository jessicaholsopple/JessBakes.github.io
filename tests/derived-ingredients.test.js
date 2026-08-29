"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const DerivedIngredients = require("../js/derived-ingredients.js");

/* ==========================================
   Derived ingredients (js/derived-ingredients.js) -- Egg Yolks
   derived 1:1 from Eggs. Pure logic only; the actual drift-proofing
   (a derived ingredient's stock/cost columns are forced to match its
   source on every write) lives in the database trigger
   (supabase/migrations/20260829090000_egg_yolk_derived_ingredient.sql),
   verified live/read-only during that migration's rollout. These
   tests cover the shared resolution logic every admin page (Inventory,
   Production) uses to identify and merge derived ingredients, always
   by stable id -- never by name.
   ========================================== */

function eggs(overrides = {}) {
    return {
        id: 6, name: "Eggs", purchase_unit: "each", recipe_unit: "each",
        purchase_size: 12, purchase_price: 3.79, quantity_on_hand: 12, minimum_quantity: 4,
        derived_from_ingredient_id: null, derived_factor: null,
        ...overrides
    };
}

function eggYolks(overrides = {}) {
    return {
        id: 57, name: "Egg Yolks", purchase_unit: "each", recipe_unit: "each",
        purchase_size: 12, purchase_price: 3.79, quantity_on_hand: 12, minimum_quantity: 4,
        derived_from_ingredient_id: 6, derived_factor: 1,
        ...overrides
    };
}

test("1. isDerived is true only for a row with a derived_from_ingredient_id", () => {
    assert.equal(DerivedIngredients.isDerived(eggYolks()), true);
    assert.equal(DerivedIngredients.isDerived(eggs()), false);
    assert.equal(DerivedIngredients.isDerived(null), false);
    assert.equal(DerivedIngredients.isDerived(undefined), false);
});

test("2. physicalOnly excludes every derived ingredient, keeping physical ones untouched", () => {
    const list = [eggs(), eggYolks(), { id: 1, name: "Flour" }];
    const result = DerivedIngredients.physicalOnly(list);
    assert.equal(result.length, 2);
    assert.ok(result.every(i => !DerivedIngredients.isDerived(i)));
});

test("3. resolvePhysical returns the ingredient itself, factor 1, for a non-derived ingredient", () => {
    const flour = { id: 1, name: "Flour" };
    const resolved = DerivedIngredients.resolvePhysical(flour, new Map());
    assert.equal(resolved.physical, flour);
    assert.equal(resolved.factor, 1);
    assert.equal(resolved.isDerived, false);
});

test("4. resolvePhysical resolves Egg Yolks to Eggs by id, with the correct factor", () => {
    const map = DerivedIngredients.buildIngredientMap([eggs(), eggYolks()]);
    const resolved = DerivedIngredients.resolvePhysical(eggYolks(), map);
    assert.equal(resolved.physical.id, 6);
    assert.equal(resolved.physical.name, "Eggs");
    assert.equal(resolved.factor, 1);
    assert.equal(resolved.isDerived, true);
});

test("5. resolvePhysical returns null (never guesses) when the derived link is broken", () => {
    const map = DerivedIngredients.buildIngredientMap([eggYolks()]); // Eggs (id 6) missing
    const resolved = DerivedIngredients.resolvePhysical(eggYolks(), map);
    assert.equal(resolved, null);
});

test("6. resolvePhysicalQuantity: 1 Egg Yolk consumes 1 Egg", () => {
    const map = DerivedIngredients.buildIngredientMap([eggs(), eggYolks()]);
    const result = DerivedIngredients.resolvePhysicalQuantity(eggYolks(), 1, map);
    assert.equal(result.ingredient.name, "Eggs");
    assert.equal(result.quantity, 1);
});

test("7. resolvePhysicalQuantity: 12 Egg Yolks consume 12 Eggs (1:1 factor)", () => {
    const map = DerivedIngredients.buildIngredientMap([eggs(), eggYolks()]);
    const result = DerivedIngredients.resolvePhysicalQuantity(eggYolks(), 12, map);
    assert.equal(result.quantity, 12);
});

test("8. resolvePhysicalQuantity: 1 whole Egg consumes 1 Egg (non-derived, unchanged)", () => {
    const map = DerivedIngredients.buildIngredientMap([eggs()]);
    const result = DerivedIngredients.resolvePhysicalQuantity(eggs(), 1, map);
    assert.equal(result.ingredient.name, "Eggs");
    assert.equal(result.quantity, 1);
});

test("9. resolvePhysicalQuantity carries the original ingredient's name as sourceLabel, for breakdown display", () => {
    const map = DerivedIngredients.buildIngredientMap([eggs(), eggYolks()]);
    const result = DerivedIngredients.resolvePhysicalQuantity(eggYolks(), 4, map);
    assert.equal(result.sourceLabel, "Egg Yolks");
    assert.equal(result.isDerived, true);
});

test("10. Availability always equals the source: Egg Yolks' own quantity_on_hand field already mirrors Eggs' (proven by the DB trigger; this documents the invariant this module relies on)", () => {
    // resolvePhysicalQuantity intentionally reads the PHYSICAL row's own
    // quantity_on_hand for stock checks -- never the derived row's --
    // so a caller comparing availability always compares against Eggs'
    // real number, not a possibly-stale mirrored copy.
    const map = DerivedIngredients.buildIngredientMap([eggs({ quantity_on_hand: 24 }), eggYolks({ quantity_on_hand: 24 })]);
    const resolved = DerivedIngredients.resolvePhysical(eggYolks(), map);
    assert.equal(resolved.physical.quantity_on_hand, 24);
});

test("11. buildIngredientMap keys by string id, usable directly with resolvePhysical/resolvePhysicalQuantity", () => {
    const map = DerivedIngredients.buildIngredientMap([eggs()]);
    assert.equal(map.get("6").name, "Eggs");
});

test("12. a broken derived link is reported distinctly (null), never silently treated as zero requirement", () => {
    const map = new Map(); // empty -- nothing resolvable
    assert.equal(DerivedIngredients.resolvePhysicalQuantity(eggYolks(), 5, map), null);
});
