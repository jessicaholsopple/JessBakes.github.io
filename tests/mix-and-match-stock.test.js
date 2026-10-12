"use strict";

/* ==========================================
   Finished-product freezer stock -- shared pure helpers in
   js/mix-and-match.js (hasAvailableStock, getRemainingStock,
   mergeStockOntoMenuItems, and isEligibleCookie's stock-aware
   extension). These are plain data-in/data-out functions, loaded
   directly under Node exactly like tests/mix-and-match-eligibility.test.js
   already does for the rest of this module.
   ========================================== */

const test = require("node:test");
const assert = require("node:assert/strict");

const MixAndMatch = require("../js/mix-and-match.js");

/* ==========================================
   hasAvailableStock / getRemainingStock
========================================== */

test("1. an item with no stock_mode at all is made_to_order (unlimited) by default", () => {
    const item = { id: "a", product_type: "standard" };
    assert.equal(MixAndMatch.hasAvailableStock(item), true);
    assert.equal(MixAndMatch.getRemainingStock(item), null);
});

test("2. an item explicitly stock_mode='made_to_order' is unlimited regardless of any stray count fields", () => {
    const item = { stock_mode: "made_to_order", available_count: 0 };
    assert.equal(MixAndMatch.hasAvailableStock(item), true);
    assert.equal(MixAndMatch.getRemainingStock(item), null);
});

test("3. a limited item with available_count > 0 has stock", () => {
    const item = { stock_mode: "limited", available_count: 3 };
    assert.equal(MixAndMatch.hasAvailableStock(item), true);
    assert.equal(MixAndMatch.getRemainingStock(item), 3);
});

test("4. a limited item with available_count === 0 is sold out", () => {
    const item = { stock_mode: "limited", available_count: 0 };
    assert.equal(MixAndMatch.hasAvailableStock(item), false);
    assert.equal(MixAndMatch.getRemainingStock(item), 0);
});

test("5. getRemainingStock never returns a negative number even on bad/negative input", () => {
    const item = { stock_mode: "limited", available_count: -5 };
    assert.equal(MixAndMatch.getRemainingStock(item), 0);
});

test("6. hasAvailableStock is false for a missing/null menu item", () => {
    assert.equal(MixAndMatch.hasAvailableStock(null), false);
    assert.equal(MixAndMatch.hasAvailableStock(undefined), false);
});

/* ==========================================
   isEligibleCookie -- stock-aware extension
========================================== */

const builder = { id: "box-1", product_type: "builder", builder_group: "cookie", builder_size: 6 };

test("7. a made-to-order flavor is eligible exactly as before (zero behavior change for untouched products)", () => {
    const flavor = { id: "f1", product_type: "standard", available: true, builder_group: "cookie" };
    assert.equal(MixAndMatch.isEligibleCookie(flavor, builder), true);
});

test("8. a limited flavor with stock remaining is still eligible", () => {
    const flavor = { id: "f2", product_type: "standard", available: true, builder_group: "cookie", stock_mode: "limited", available_count: 2 };
    assert.equal(MixAndMatch.isEligibleCookie(flavor, builder), true);
});

test("9. a limited flavor at zero stock becomes ineligible -- disappears from the Mix & Match selector exactly like its own product card", () => {
    const flavor = { id: "f3", product_type: "standard", available: true, builder_group: "cookie", stock_mode: "limited", available_count: 0 };
    assert.equal(MixAndMatch.isEligibleCookie(flavor, builder), false);
});

test("10. getEligibleCookies filters out sold-out flavors but keeps made-to-order and in-stock limited ones, sorted by name", () => {
    const menuItems = [
        { id: "a", name: "Zesty Lemon", product_type: "standard", available: true, builder_group: "cookie" },
        { id: "b", name: "Snickerdoodle", product_type: "standard", available: true, builder_group: "cookie", stock_mode: "limited", available_count: 0 },
        { id: "c", name: "Wicked Caramel Apple", product_type: "standard", available: true, builder_group: "cookie", stock_mode: "limited", available_count: 5 }
    ];
    const eligible = MixAndMatch.getEligibleCookies(menuItems, builder);
    assert.deepEqual(eligible.map(c => c.id), ["c", "a"]);
});

/* ==========================================
   mergeStockOntoMenuItems
========================================== */

test("11. mergeStockOntoMenuItems attaches stock_mode/available_count/sold_out_behavior by matching id", () => {
    const items = [{ id: "x" }, { id: "y" }];
    const stockRows = [{ menu_item_id: "x", stock_mode: "limited", available_count: 4, sold_out_behavior: "hide" }];

    MixAndMatch.mergeStockOntoMenuItems(items, stockRows);

    assert.equal(items[0].stock_mode, "limited");
    assert.equal(items[0].available_count, 4);
    assert.equal(items[0].sold_out_behavior, "hide");
    assert.equal(items[1].stock_mode, undefined, "an item with no matching stock row is left untouched -- stays made_to_order by absence");
});

test("12. mergeStockOntoMenuItems matches ids as strings (uuid vs stringified uuid never silently mismatches)", () => {
    const items = [{ id: "123" }];
    const stockRows = [{ menu_item_id: "123", stock_mode: "limited", available_count: 1, sold_out_behavior: "show_sold_out" }];

    MixAndMatch.mergeStockOntoMenuItems(items, stockRows);

    assert.equal(items[0].stock_mode, "limited");
});

test("13. mergeStockOntoMenuItems tolerates empty/missing inputs without throwing", () => {
    assert.doesNotThrow(() => MixAndMatch.mergeStockOntoMenuItems([], []));
    assert.doesNotThrow(() => MixAndMatch.mergeStockOntoMenuItems(null, null));
    assert.doesNotThrow(() => MixAndMatch.mergeStockOntoMenuItems([{ id: "a" }], undefined));
});

test("14. mergeStockOntoMenuItems mutates and returns the same array (chainable)", () => {
    const items = [{ id: "a" }];
    const result = MixAndMatch.mergeStockOntoMenuItems(items, [{ menu_item_id: "a", stock_mode: "limited", available_count: 1, sold_out_behavior: "show_sold_out" }]);
    assert.equal(result, items);
});
