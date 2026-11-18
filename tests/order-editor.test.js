"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const OrderEditor = require("../js/order-editor.js");

/* ==========================================
   FIXTURES
   ========================================== */

const FLAT_ITEM_A = {
    id: "oi-1",
    order_id: "order-1",
    menu_item_id: "menu-sourdough",
    item_name: "Classic Sourdough",
    quantity: 2,
    price_at_purchase: 8,
    line_total: 16,
    builder_details: null
};

const FLAT_ITEM_B = {
    id: "oi-2",
    order_id: "order-1",
    menu_item_id: "menu-baguette",
    item_name: "Baguette",
    quantity: 1,
    price_at_purchase: 5,
    line_total: 5,
    builder_details: null
};

const BUILDER_ITEM_1 = {
    id: "oi-builder-1",
    order_id: "order-1",
    menu_item_id: null,
    item_name: "6 Mix & Match Cookies",
    quantity: 1,
    price_at_purchase: 15,
    line_total: 15,
    builder_details: {
        selections: [
            { name: "Brown Butter Sea Salt Chocolate Chip", quantity: 3 },
            { name: "Peanut Butter Cup", quantity: 3 }
        ]
    }
};

const BUILDER_ITEM_2 = {
    id: "oi-builder-2",
    order_id: "order-1",
    menu_item_id: null,
    item_name: "12 Mix & Match Cookies",
    quantity: 1,
    price_at_purchase: 25,
    line_total: 25,
    builder_details: {
        selections: [
            { name: "Strawberry Shortcake", quantity: 12 }
        ]
    }
};

// A line whose linked menu item has since been deleted (menu_item_id is
// null but there is no builder_details either) — the same "unresolvable"
// hazard as a builder line, per the defensive branch in
// partitionOrderItemsForEditing.
const ORPHANED_ITEM = {
    id: "oi-orphan",
    order_id: "order-1",
    menu_item_id: null,
    item_name: "Discontinued Seasonal Loaf",
    quantity: 1,
    price_at_purchase: 9,
    line_total: 9,
    builder_details: null
};

/* ==========================================
   isOrderEditable — BUG-22
   ========================================== */

test("1. a pending order is editable", () => {
    assert.equal(OrderEditor.isOrderEditable({ status: "pending" }), true);
});

test("2. a confirmed order is editable", () => {
    assert.equal(OrderEditor.isOrderEditable({ status: "confirmed" }), true);
});

test("3. a completed order is NOT editable (BUG-22)", () => {
    assert.equal(OrderEditor.isOrderEditable({ status: "completed" }), false);
});

test("4. a missing/null order is not editable", () => {
    assert.equal(OrderEditor.isOrderEditable(null), false);
    assert.equal(OrderEditor.isOrderEditable(undefined), false);
});

/* ==========================================
   partitionOrderItemsForEditing — BUG-02
   ========================================== */

test("5. flat items are keyed by menu_item_id and preserved exactly", () => {
    const { flatItemsById, builderItems } =
        OrderEditor.partitionOrderItemsForEditing([FLAT_ITEM_A, FLAT_ITEM_B]);

    assert.equal(Object.keys(flatItemsById).length, 2);
    assert.equal(flatItemsById["menu-sourdough"].name, "Classic Sourdough");
    assert.equal(flatItemsById["menu-sourdough"].quantity, 2);
    assert.equal(flatItemsById["menu-baguette"].price, 5);
    assert.equal(builderItems.length, 0);
});

test("6. a single Mix & Match box is preserved as a builder item, not dropped", () => {
    const { flatItemsById, builderItems } =
        OrderEditor.partitionOrderItemsForEditing([FLAT_ITEM_A, BUILDER_ITEM_1]);

    assert.equal(Object.keys(flatItemsById).length, 1);
    assert.equal(builderItems.length, 1);
    assert.equal(builderItems[0].item_name, "6 Mix & Match Cookies");
    assert.deepEqual(builderItems[0].builder_details, BUILDER_ITEM_1.builder_details);
});

test("7. TWO Mix & Match boxes in one order both survive (the exact BUG-02 collision)", () => {
    // Before the fix, both builder lines were written into the same
    // manualOrderItems[null] slot, so only the last one processed survived
    // and the other vanished silently on save. This is the regression test
    // for that specific collision.
    const { builderItems } =
        OrderEditor.partitionOrderItemsForEditing([BUILDER_ITEM_1, BUILDER_ITEM_2]);

    assert.equal(builderItems.length, 2);
    const names = builderItems.map(item => item.item_name).sort();
    assert.deepEqual(names, ["12 Mix & Match Cookies", "6 Mix & Match Cookies"]);
    // Each keeps its own distinct localId, so either can be removed
    // individually without disturbing the other.
    assert.notEqual(builderItems[0].localId, builderItems[1].localId);
});

test("8. an order line with no resolvable menu item (builder_details also null) is preserved defensively, not dropped", () => {
    const { flatItemsById, builderItems } =
        OrderEditor.partitionOrderItemsForEditing([ORPHANED_ITEM]);

    assert.equal(Object.keys(flatItemsById).length, 0);
    assert.equal(builderItems.length, 1);
    assert.equal(builderItems[0].item_name, "Discontinued Seasonal Loaf");
    assert.equal(builderItems[0].builder_details, null);
});

test("9. every input row appears in exactly one output — nothing is silently dropped", () => {
    const input = [FLAT_ITEM_A, FLAT_ITEM_B, BUILDER_ITEM_1, BUILDER_ITEM_2, ORPHANED_ITEM];
    const { flatItemsById, builderItems } = OrderEditor.partitionOrderItemsForEditing(input);

    const totalOut = Object.keys(flatItemsById).length + builderItems.length;
    assert.equal(totalOut, input.length);
});

/* ==========================================
   partitionOrderItemsForEditing — promotional reward lines

   A promo reward reuses the SAME real menu_item_id as a paid line of
   that cookie (see js/promotions-shared.js) -- these tests confirm
   that never collides with flatItemsById's id-keyed map, the exact
   bug class BUG-02 already fixed for builder lines above.
   ========================================== */

const PROMO_ITEM = {
    id: "oi-promo-1",
    order_id: "order-1",
    menu_item_id: "menu-brown-butter",
    item_name: "Brown Butter Sea Salt Chocolate Chip",
    quantity: 1,
    price_at_purchase: 0,
    line_total: 0,
    builder_details: null,
    promotion_redemption_id: "redemption-1"
};

const PAID_LINE_SAME_MENU_ITEM = {
    id: "oi-paid-brown-butter",
    order_id: "order-1",
    menu_item_id: "menu-brown-butter",
    item_name: "Brown Butter Sea Salt Chocolate Chip",
    quantity: 2,
    price_at_purchase: 4,
    line_total: 8,
    builder_details: null
};

test("11. a promo reward line is partitioned into its own array, not flatItemsById", () => {
    const { flatItemsById, promoItems } = OrderEditor.partitionOrderItemsForEditing([PROMO_ITEM]);

    assert.equal(Object.keys(flatItemsById).length, 0);
    assert.equal(promoItems.length, 1);
    assert.equal(promoItems[0].menu_item_id, "menu-brown-butter");
    assert.equal(promoItems[0].promotionRedemptionId, "redemption-1");
});

test("12. a promo reward line and a PAID line of the SAME menu item both survive distinctly -- the id-collision case", () => {
    const { flatItemsById, promoItems } =
        OrderEditor.partitionOrderItemsForEditing([PAID_LINE_SAME_MENU_ITEM, PROMO_ITEM]);

    assert.equal(flatItemsById["menu-brown-butter"].quantity, 2);
    assert.equal(flatItemsById["menu-brown-butter"].price, 4);
    assert.equal(promoItems.length, 1);
    assert.equal(promoItems[0].price_at_purchase, 0);
});

test("13. every input row still appears in exactly one output once promoItems exists as a third bucket", () => {
    const input = [FLAT_ITEM_A, BUILDER_ITEM_1, PROMO_ITEM];
    const { flatItemsById, builderItems, promoItems } = OrderEditor.partitionOrderItemsForEditing(input);

    const totalOut = Object.keys(flatItemsById).length + builderItems.length + promoItems.length;
    assert.equal(totalOut, input.length);
});

test("14. buildOrderItemsPayload carries a kept promo item through at price 0, with its real menu_item_id", () => {
    const { flatItemsById, builderItems, promoItems } = OrderEditor.partitionOrderItemsForEditing([FLAT_ITEM_A, PROMO_ITEM]);
    const payload = OrderEditor.buildOrderItemsPayload("order-1", flatItemsById, builderItems, promoItems);

    const promoRow = payload.find(row => row.menu_item_id === "menu-brown-butter" && row.item_name === "Brown Butter Sea Salt Chocolate Chip");
    assert.ok(promoRow);
    assert.equal(promoRow.price_at_purchase, 0);
    assert.equal(promoRow.line_total, 0);
    assert.equal(payload.length, 2);
});

test("15. buildOrderItemsPayload omits a promo item that was removed from the promoItems array (admin clicked Remove)", () => {
    const { flatItemsById, builderItems } = OrderEditor.partitionOrderItemsForEditing([FLAT_ITEM_A, PROMO_ITEM]);
    const payload = OrderEditor.buildOrderItemsPayload("order-1", flatItemsById, builderItems, []);

    assert.equal(payload.length, 1);
    assert.equal(payload[0].menu_item_id, "menu-sourdough");
});

/* ==========================================
   buildOrderItemsPayload — round-trip
   ========================================== */

test("10. partition -> rebuild round-trips a mixed order without losing or altering any line", () => {
    const input = [FLAT_ITEM_A, FLAT_ITEM_B, BUILDER_ITEM_1, BUILDER_ITEM_2];
    const { flatItemsById, builderItems } = OrderEditor.partitionOrderItemsForEditing(input);

    const payload = OrderEditor.buildOrderItemsPayload("order-1", flatItemsById, builderItems);

    assert.equal(payload.length, input.length);

    const builderRows = payload.filter(row => row.menu_item_id === null);
    assert.equal(builderRows.length, 2);
    builderRows.forEach(row => {
        assert.ok(row.builder_details, "builder_details must survive the round-trip");
        assert.equal(row.line_total, row.price_at_purchase * row.quantity);
    });

    const flatRows = payload.filter(row => row.menu_item_id !== null);
    assert.equal(flatRows.length, 2);
    const sourdoughRow = flatRows.find(row => row.menu_item_id === "menu-sourdough");
    assert.equal(sourdoughRow.line_total, 16);
});

test("11. removing one preserved builder item before rebuilding leaves the other and every flat item intact", () => {
    const input = [FLAT_ITEM_A, BUILDER_ITEM_1, BUILDER_ITEM_2];
    const { flatItemsById, builderItems } = OrderEditor.partitionOrderItemsForEditing(input);

    const remaining = builderItems.filter(item => item.localId !== BUILDER_ITEM_1.id);
    const payload = OrderEditor.buildOrderItemsPayload("order-1", flatItemsById, remaining);

    assert.equal(payload.length, 2);
    assert.ok(payload.some(row => row.item_name === "Classic Sourdough"));
    assert.ok(payload.some(row => row.item_name === "12 Mix & Match Cookies"));
    assert.ok(!payload.some(row => row.item_name === "6 Mix & Match Cookies"));
});

/* ==========================================
   Summary helpers
   ========================================== */

test("12. item count and subtotal include both flat and preserved builder items", () => {
    const { flatItemsById, builderItems } =
        OrderEditor.partitionOrderItemsForEditing([FLAT_ITEM_A, FLAT_ITEM_B, BUILDER_ITEM_1]);

    // FLAT_ITEM_A qty 2 + FLAT_ITEM_B qty 1 + BUILDER_ITEM_1 qty 1 = 4
    assert.equal(OrderEditor.computeManualOrderItemCount(flatItemsById, builderItems), 4);

    // 16 + 5 + 15 = 36
    assert.equal(OrderEditor.computeManualOrderSubtotal(flatItemsById, builderItems), 36);
});

test("13. an order with only builder items still sums correctly (empty flat side)", () => {
    const { flatItemsById, builderItems } =
        OrderEditor.partitionOrderItemsForEditing([BUILDER_ITEM_1, BUILDER_ITEM_2]);

    assert.equal(OrderEditor.computeManualOrderSubtotal(flatItemsById, builderItems), 40);
    assert.equal(OrderEditor.computeManualOrderItemCount(flatItemsById, builderItems), 2);
});
