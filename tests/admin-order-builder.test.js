"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const OrderEditor = require("../js/order-editor.js");
const MixAndMatch = require("../js/mix-and-match.js");
const SaleCalculations = require("../js/sale-calculations.js");

const ROOT = path.join(__dirname, "..");

function read(relPath) {
    return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

/* ==========================================
   Regression coverage for: Admin Dashboard -> Orders -> Edit Order could
   increase/decrease a Mix & Match box's quantity like any ordinary item,
   but gave no way to pick its cookie flavors, leaving the order without
   the required selection details.

   Fix: an embedded cookie-flavor selector (js/admin-orders.js), built on
   the SAME canonical eligibility module the public Menu checkout uses
   (js/mix-and-match.js) and a set of new pure, shared save/load
   functions (js/order-editor.js) -- never a separate hardcoded flavor
   list or a separate validation rule.

   PART 1 (below) tests the pure logic directly -- exactly like this
   repo's existing order-editor.test.js / sale-calculations.test.js.
   PART 2 (further down) executes the REAL js/admin-orders.js UI code in
   a vm sandbox to prove the editor's rendering/interaction wiring itself.
   ========================================== */

const SIX_BUILDER = {
    id: "builder-6", name: "6 Mix & Match Cookies", product_type: "builder",
    builder_group: "cookie", builder_size: 6, price: 15, available: true, category: "cookie"
};

const TWELVE_BUILDER = {
    id: "builder-12", name: "12 Mix & Match Cookies", product_type: "builder",
    builder_group: "cookie", builder_size: 12, price: 25, available: true, category: "cookie"
};

function cookie(id, name, overrides = {}) {
    return {
        id, name,
        product_type: "standard",
        category: "cookie",
        builder_group: "cookie",
        available: true,
        price: 3,
        recipe_id: `recipe-${id}`,
        packaging_profile_id: "pkg-cookie",
        recipe_units_used: 1,
        ...overrides
    };
}

const COOKIE_A = cookie("cookie-a", "Brown Butter Sea Salt Chocolate Chip");
const COOKIE_B = cookie("cookie-b", "S'mores");
const COOKIE_C = cookie("cookie-c", "Strawberry Shortcake");
const COOKIE_D = cookie("cookie-d", "Browned Butter Snickerdoodle");

const ALL_MENU_ITEMS = [SIX_BUILDER, TWELVE_BUILDER, COOKIE_A, COOKIE_B, COOKIE_C, COOKIE_D];

function selections(...pairs) {
    // pairs of [cookie, quantity]
    return pairs.map(([c, quantity]) => ({ id: c.id, name: c.name, quantity }));
}

function selectionsMap(...pairs) {
    const map = {};
    pairs.forEach(([c, quantity]) => { map[c.id] = { name: c.name, quantity }; });
    return map;
}

/* ==========================================
   PART 1 -- pure logic (order-editor.js + mix-and-match.js +
   sale-calculations.js), required directly, no DOM/vm involved.
   ========================================== */

test("1. adding one 6-count box and selecting exactly 6 cookies validates ok and saves the fixed €15 revenue", () => {
    const eligible = MixAndMatch.getEligibleCookies(ALL_MENU_ITEMS, SIX_BUILDER);
    const chosen = selections([COOKIE_A, 3], [COOKIE_B, 3]);
    const validation = MixAndMatch.validateBoxSelection(SIX_BUILDER.builder_size, 1, chosen, eligible);

    assert.equal(validation.status, "ok");
    assert.equal(validation.required, 6);
    assert.equal(validation.selected, 6);

    const boxesById = {
        [SIX_BUILDER.id]: {
            id: SIX_BUILDER.id, name: SIX_BUILDER.name, builderGroup: "cookie",
            builderSize: 6, perBoxPrice: 15, boxQuantity: 1,
            selections: selectionsMap([COOKIE_A, 3], [COOKIE_B, 3])
        }
    };

    const payload = OrderEditor.buildBuilderBoxOrderItems("order-1", boxesById);
    assert.equal(payload.length, 1);
    assert.equal(payload[0].quantity, 1);
    assert.equal(payload[0].price_at_purchase, 15);
    assert.equal(payload[0].line_total, 15);
    assert.equal(payload[0].menu_item_id, null);
    const total = payload[0].builder_details.selections.reduce((s, x) => s + x.quantity, 0);
    assert.equal(total, 6);
});

test("2. adding one 12-count box and selecting exactly 12 cookies validates ok and saves the fixed €25 revenue", () => {
    const eligible = MixAndMatch.getEligibleCookies(ALL_MENU_ITEMS, TWELVE_BUILDER);
    const chosen = selections([COOKIE_C, 8], [COOKIE_D, 4]);
    const validation = MixAndMatch.validateBoxSelection(TWELVE_BUILDER.builder_size, 1, chosen, eligible);

    assert.equal(validation.status, "ok");
    assert.equal(validation.required, 12);

    const boxesById = {
        [TWELVE_BUILDER.id]: {
            id: TWELVE_BUILDER.id, name: TWELVE_BUILDER.name, builderGroup: "cookie",
            builderSize: 12, perBoxPrice: 25, boxQuantity: 1,
            selections: selectionsMap([COOKIE_C, 8], [COOKIE_D, 4])
        }
    };

    const payload = OrderEditor.buildBuilderBoxOrderItems("order-1", boxesById);
    assert.equal(payload[0].price_at_purchase, 25);
    assert.equal(payload[0].line_total, 25);
});

test("3. multiple boxes require the correctly calculated total (quantity × builder_size)", () => {
    assert.equal(MixAndMatch.getRequiredCount(6, 1), 6);
    assert.equal(MixAndMatch.getRequiredCount(6, 2), 12);
    assert.equal(MixAndMatch.getRequiredCount(6, 3), 18);
    assert.equal(MixAndMatch.getRequiredCount(12, 2), 24);

    // 2 boxes, unevenly split (5 + 7 = 12) must still validate ok -- any
    // valid combination of flavors is allowed, not just even splits.
    const eligible = MixAndMatch.getEligibleCookies(ALL_MENU_ITEMS, SIX_BUILDER);
    const chosen = selections([COOKIE_A, 5], [COOKIE_B, 7]);
    const validation = MixAndMatch.validateBoxSelection(6, 2, chosen, eligible);
    assert.equal(validation.status, "ok");
    assert.equal(validation.required, 12);

    const boxesById = {
        [SIX_BUILDER.id]: {
            id: SIX_BUILDER.id, name: SIX_BUILDER.name, builderGroup: "cookie",
            builderSize: 6, perBoxPrice: 15, boxQuantity: 2,
            selections: selectionsMap([COOKIE_A, 5], [COOKIE_B, 7])
        }
    };
    const payload = OrderEditor.buildBuilderBoxOrderItems("order-1", boxesById);
    // Correct fixed box revenue: 15 × 2 boxes = 30 -- never inflated by
    // individual €3 cookie prices (which would give 15*2 + 3*12 = 66).
    assert.equal(payload[0].price_at_purchase, 30);
    assert.equal(payload[0].line_total, 30);
    assert.equal(payload[0].builder_details.box_quantity, 2);
});

test("4. all four current flavors can be used in one box", () => {
    const eligible = MixAndMatch.getEligibleCookies(ALL_MENU_ITEMS, TWELVE_BUILDER);
    assert.deepEqual(
        eligible.map(c => c.name).sort(),
        ["Brown Butter Sea Salt Chocolate Chip", "Browned Butter Snickerdoodle", "S'mores", "Strawberry Shortcake"]
    );

    const chosen = selections([COOKIE_A, 3], [COOKIE_B, 3], [COOKIE_C, 3], [COOKIE_D, 3]);
    const validation = MixAndMatch.validateBoxSelection(12, 1, chosen, eligible);
    assert.equal(validation.status, "ok");
    assert.equal(validation.selected, 12);
});

test("5. loading an existing order pre-fills its Mix & Match selection, and it can be changed", () => {
    const existingRow = {
        id: "oi-1", order_id: "order-1", menu_item_id: null,
        item_name: "6 Mix & Match Cookies", quantity: 1, price_at_purchase: 15, line_total: 15,
        builder_details: { builder_group: "cookie", selections: selections([COOKIE_A, 6]), box_quantity: 1 }
    };

    const partitioned = OrderEditor.partitionOrderItemsForEditing([existingRow]);
    const grouped = OrderEditor.groupBuilderItemsByLiveProduct(partitioned.builderItems, [SIX_BUILDER, TWELVE_BUILDER]);

    const box = grouped.builderBoxesById[SIX_BUILDER.id];
    assert.ok(box, "the existing box must load into an editable entry");
    assert.equal(box.boxQuantity, 1);
    assert.equal(box.perBoxPrice, 15);
    assert.equal(box.selections["cookie-a"].quantity, 6);

    // The administrator changes the selection: swap 2 of flavor A for 2 of flavor B.
    box.selections["cookie-a"].quantity -= 2;
    box.selections["cookie-b"] = { name: COOKIE_B.name, quantity: 2 };

    const payload = OrderEditor.buildBuilderBoxOrderItems("order-1", grouped.builderBoxesById);
    const total = payload[0].builder_details.selections.reduce((s, x) => s + x.quantity, 0);
    assert.equal(total, 6);
    assert.equal(payload[0].price_at_purchase, 15, "the box price itself is untouched by a flavor change");
});

test("6. editing something unrelated on the order leaves an untouched Mix & Match selection exactly as it was", () => {
    const existingRow = {
        id: "oi-1", order_id: "order-1", menu_item_id: null,
        item_name: "12 Mix & Match Cookies", quantity: 1, price_at_purchase: 25, line_total: 25,
        builder_details: {
            builder_group: "cookie",
            selections: selections([COOKIE_A, 4], [COOKIE_C, 8]),
            box_quantity: 1
        }
    };

    const partitioned = OrderEditor.partitionOrderItemsForEditing([existingRow]);
    const grouped = OrderEditor.groupBuilderItemsByLiveProduct(partitioned.builderItems, [SIX_BUILDER, TWELVE_BUILDER]);

    // Simulates "the admin only edited the customer's phone number" --
    // the box state is loaded and saved right back without modification.
    const payload = OrderEditor.buildBuilderBoxOrderItems("order-1", grouped.builderBoxesById);

    assert.equal(payload.length, 1);
    assert.equal(payload[0].item_name, "12 Mix & Match Cookies");
    assert.equal(payload[0].price_at_purchase, 25);
    assert.deepEqual(
        payload[0].builder_details.selections.map(s => [s.id, s.quantity]).sort(),
        [["cookie-a", 4], ["cookie-c", 8]]
    );
});

test("7. reducing box quantity does not silently trim selections -- the excess must be corrected before saving", () => {
    const eligible = MixAndMatch.getEligibleCookies(ALL_MENU_ITEMS, SIX_BUILDER);
    const box = {
        id: SIX_BUILDER.id, name: SIX_BUILDER.name, builderGroup: "cookie",
        builderSize: 6, perBoxPrice: 15, boxQuantity: 2,
        selections: selectionsMap([COOKIE_A, 6], [COOKIE_B, 6]) // 12 selected, correct for 2 boxes
    };

    // Administrator reduces the box from 2 -> 1 without touching selections.
    box.boxQuantity = 1;

    const chosen = Object.keys(box.selections).map(id => ({ id, ...box.selections[id] }));
    const validation = MixAndMatch.validateBoxSelection(box.builderSize, box.boxQuantity, chosen, eligible);

    assert.equal(validation.status, "over");
    assert.equal(validation.required, 6);
    assert.equal(validation.selected, 12, "selections must be preserved, not silently trimmed");
});

test("8. removing a box entirely removes its selection details from the saved order", () => {
    const boxesById = {
        [SIX_BUILDER.id]: {
            id: SIX_BUILDER.id, name: SIX_BUILDER.name, builderGroup: "cookie",
            builderSize: 6, perBoxPrice: 15, boxQuantity: 0, // removed
            selections: selectionsMap([COOKIE_A, 6])
        }
    };

    const payload = OrderEditor.buildBuilderBoxOrderItems("order-1", boxesById);
    assert.equal(payload.length, 0, "a box at quantity 0 must produce no order_items row at all");
});

test("9. incomplete or excessive selections are rejected, distinctly from a fully missing selection", () => {
    const eligible = MixAndMatch.getEligibleCookies(ALL_MENU_ITEMS, SIX_BUILDER);

    const under = MixAndMatch.validateBoxSelection(6, 1, selections([COOKIE_A, 4]), eligible);
    assert.equal(under.status, "under");

    const over = MixAndMatch.validateBoxSelection(6, 1, selections([COOKIE_A, 8]), eligible);
    assert.equal(over.status, "over");

    const missing = MixAndMatch.validateBoxSelection(6, 1, [], eligible);
    assert.equal(missing.status, "missing");

    const stale = MixAndMatch.validateBoxSelection(6, 1, selections([{ id: "deleted-id", name: "Ghost Cookie" }, 6]), eligible);
    assert.equal(stale.status, "stale");
});

test("10. selected-cookie costs and fixed box revenue flow correctly through the shared sale-calculations module", () => {
    const menuItemsForSale = ALL_MENU_ITEMS;
    const recipeCosts = [
        { id: "recipe-cookie-a", cost_per_yield_item: 0.5 },
        { id: "recipe-cookie-b", cost_per_yield_item: 0.6 }
    ];
    const packagingCosts = [{ id: "pkg-cookie", packaging_cost: 0.1 }];

    const boxesById = {
        [SIX_BUILDER.id]: {
            id: SIX_BUILDER.id, name: SIX_BUILDER.name, builderGroup: "cookie",
            builderSize: 6, perBoxPrice: 15, boxQuantity: 2,
            selections: selectionsMap([COOKIE_A, 6], [COOKIE_B, 6]) // 2 boxes, 12 total, true totals (not per-box)
        }
    };

    const orderItems = OrderEditor.buildBuilderBoxOrderItems("order-1", boxesById);
    const referenceData = SaleCalculations.buildReferenceData(menuItemsForSale, recipeCosts, packagingCosts);
    const lines = SaleCalculations.buildSaleFromOrder(orderItems, referenceData);

    const parent = lines.find(l => l.source === "builder-parent");
    assert.equal(parent.line_revenue, 30, "parent owns the full fixed box revenue (15 × 2 boxes)");
    assert.equal(parent.total_cost, 0);
    assert.equal(parent.quantity, 2, "the parent line reports the true box count (from builder_details.box_quantity), not the row's own quantity: 1");

    const childA = lines.find(l => l.item_name === "Brown Butter Sea Salt Chocolate Chip");
    const childB = lines.find(l => l.item_name === "S'mores");
    assert.equal(childA.quantity, 6, "child quantity is the true total picked, not multiplied again by box count");
    assert.equal(childB.quantity, 6);
    assert.equal(childA.line_revenue, 0, "children never carry revenue -- no double counting");
    assert.equal(Math.round(childA.total_cost * 100), 60); // (0.5 + 0.1) per cookie
    assert.equal(Math.round(childB.total_cost * 100), 70); // (0.6 + 0.1) per cookie

    const totalRevenue = lines.reduce((s, l) => s + l.line_revenue, 0);
    assert.equal(totalRevenue, 30, "revenue counted exactly once (the box price), never per selected cookie");
});

test("11. the saved order_items shape matches the same canonical fields the public checkout writes", () => {
    const boxesById = {
        [SIX_BUILDER.id]: {
            id: SIX_BUILDER.id, name: SIX_BUILDER.name, builderGroup: "cookie",
            builderSize: 6, perBoxPrice: 15, boxQuantity: 1,
            selections: selectionsMap([COOKIE_A, 6])
        }
    };
    const [row] = OrderEditor.buildBuilderBoxOrderItems("order-1", boxesById);

    assert.deepEqual(
        Object.keys(row).sort(),
        ["builder_details", "item_name", "line_total", "menu_item_id", "order_id", "price_at_purchase", "quantity"].sort()
    );
    assert.deepEqual(Object.keys(row.builder_details).sort(), ["box_quantity", "builder_group", "selections"].sort());
    assert.equal(row.menu_item_id, null, "matches cart.js's own convention for builder lines");
});

test("12. reopening a saved order reproduces the exact same box quantity and selections (round-trip)", () => {
    const boxesById = {
        [TWELVE_BUILDER.id]: {
            id: TWELVE_BUILDER.id, name: TWELVE_BUILDER.name, builderGroup: "cookie",
            builderSize: 12, perBoxPrice: 25, boxQuantity: 2,
            selections: selectionsMap([COOKIE_A, 8], [COOKIE_C, 16])
        }
    };

    const savedRows = OrderEditor.buildBuilderBoxOrderItems("order-1", boxesById);

    // Simulate reopening: the saved rows come back from Supabase exactly
    // as inserted, get partitioned and re-grouped by the editor again.
    const partitioned = OrderEditor.partitionOrderItemsForEditing(savedRows);
    const grouped = OrderEditor.groupBuilderItemsByLiveProduct(partitioned.builderItems, [SIX_BUILDER, TWELVE_BUILDER]);

    const reopened = grouped.builderBoxesById[TWELVE_BUILDER.id];
    assert.equal(reopened.boxQuantity, 2);
    assert.equal(reopened.perBoxPrice, 25);
    assert.equal(reopened.selections["cookie-a"].quantity, 8);
    assert.equal(reopened.selections["cookie-c"].quantity, 16);
});

test("13. Production's raw (non-multiplied) reading of builder_details.selections still gets the true total, since box_quantity is folded in at save time", () => {
    const boxesById = {
        [SIX_BUILDER.id]: {
            id: SIX_BUILDER.id, name: SIX_BUILDER.name, builderGroup: "cookie",
            builderSize: 6, perBoxPrice: 15, boxQuantity: 3,
            selections: selectionsMap([COOKIE_A, 18])
        }
    };
    const [row] = OrderEditor.buildBuilderBoxOrderItems("order-1", boxesById);

    // Mirrors admin-production.js's own (unmultiplied) consumption of
    // builder_details.selections[i].quantity.
    const productionCount = row.builder_details.selections.reduce((s, x) => s + Number(x.quantity), 0);
    assert.equal(productionCount, 18, "3 boxes × 6 of the same flavor = 18, correctly represented with quantity: 1 on the row");
});

test("14. two existing order_items rows for the same box product merge into exactly one editable/saved line -- no duplicates", () => {
    const rowA = {
        id: "oi-1", order_id: "order-1", menu_item_id: null, item_name: "6 Mix & Match Cookies",
        quantity: 1, price_at_purchase: 15, line_total: 15,
        builder_details: { builder_group: "cookie", selections: selections([COOKIE_A, 6]), box_quantity: 1 }
    };
    const rowB = {
        id: "oi-2", order_id: "order-1", menu_item_id: null, item_name: "6 Mix & Match Cookies",
        quantity: 1, price_at_purchase: 15, line_total: 15,
        builder_details: { builder_group: "cookie", selections: selections([COOKIE_B, 6]), box_quantity: 1 }
    };

    const partitioned = OrderEditor.partitionOrderItemsForEditing([rowA, rowB]);
    const grouped = OrderEditor.groupBuilderItemsByLiveProduct(partitioned.builderItems, [SIX_BUILDER, TWELVE_BUILDER]);

    assert.equal(Object.keys(grouped.builderBoxesById).length, 1);
    const box = grouped.builderBoxesById[SIX_BUILDER.id];
    assert.equal(box.boxQuantity, 2);
    assert.equal(box.selections["cookie-a"].quantity, 6);
    assert.equal(box.selections["cookie-b"].quantity, 6);

    const payload = OrderEditor.buildBuilderBoxOrderItems("order-1", grouped.builderBoxesById);
    assert.equal(payload.length, 1, "must save back as exactly one row, not two");
    assert.equal(payload[0].price_at_purchase, 30);
});

test("15. loading an existing order into the editor never mutates the original order_items rows -- no changes to historical data unless explicitly edited", () => {
    const existingRow = {
        id: "oi-1", order_id: "order-1", menu_item_id: null, item_name: "6 Mix & Match Cookies",
        quantity: 1, price_at_purchase: 15, line_total: 15,
        builder_details: { builder_group: "cookie", selections: selections([COOKIE_A, 6]), box_quantity: 1 }
    };
    const snapshot = JSON.parse(JSON.stringify(existingRow));

    const partitioned = OrderEditor.partitionOrderItemsForEditing([existingRow]);
    OrderEditor.groupBuilderItemsByLiveProduct(partitioned.builderItems, [SIX_BUILDER, TWELVE_BUILDER]);

    assert.deepEqual(existingRow, snapshot, "the input row object must be left completely untouched by loading it for editing");
});

test("16. a builder box and a regular flat item in the same order both save correctly together", () => {
    const flatItemsById = { "menu-sourdough": { id: "menu-sourdough", name: "Classic Sourdough", price: 8, quantity: 2 } };
    const boxesById = {
        [SIX_BUILDER.id]: {
            id: SIX_BUILDER.id, name: SIX_BUILDER.name, builderGroup: "cookie",
            builderSize: 6, perBoxPrice: 15, boxQuantity: 1,
            selections: selectionsMap([COOKIE_A, 6])
        }
    };

    const payload = [
        ...OrderEditor.buildOrderItemsPayload("order-1", flatItemsById, []),
        ...OrderEditor.buildBuilderBoxOrderItems("order-1", boxesById)
    ];

    assert.equal(payload.length, 2);
    assert.ok(payload.some(row => row.item_name === "Classic Sourdough" && row.line_total === 16));
    assert.ok(payload.some(row => row.item_name === "6 Mix & Match Cookies" && row.line_total === 15));
});

/* ==========================================
   PART 2 -- the real js/admin-orders.js UI code, executed in a vm
   sandbox (same technique as tests/mix-and-match-eligibility.test.js's
   cart.js harness) so the actual rendering/interaction wiring is what
   gets tested, not a reimplementation of it.
   ========================================== */

function loadAdminOrdersSandbox() {
    const elements = new Map();

    function fakeElement(id) {
        if (!elements.has(id)) {
            elements.set(id, {
                id, value: "", textContent: "", innerHTML: "",
                style: {}, checked: false, disabled: false, title: ""
            });
        }
        return elements.get(id);
    }

    const querySelectorTargets = {
        "#manualOrderModal .modal-header h2": "manualModalTitle",
        "#manualOrderModal .modal-footer .primary-btn": "manualSaveButton"
    };

    const fakeDocument = {
        addEventListener: () => {}, // DOMContentLoaded auto-run is never triggered
        getElementById: (id) => fakeElement(id),
        querySelector: (selector) => fakeElement(querySelectorTargets[selector] || selector),
        createElement: () => ({ style: {} }),
        body: { appendChild: () => {} }
    };

    const sandbox = {
        document: fakeDocument,
        window: {},
        console,
        alert: () => {},
        confirm: () => true,
        crypto: { randomUUID: () => "test-uuid" }
    };
    vm.createContext(sandbox);

    const source = [
        read("js/mix-and-match.js"),
        read("js/order-editor.js"),
        read("js/sale-calculations.js"),
        read("js/currency-conversion.js"),
        read("js/admin-orders.js"),
        `
        this.__setMenuItems = function (items) { menuItems = items; };
        this.__getManualBuilderBoxes = function () { return manualBuilderBoxes; };
        this.__setManualBuilderBoxes = function (boxes) { manualBuilderBoxes = boxes; };
        this.__getManualOrderItems = function () { return manualOrderItems; };
        this.__changeManualItemQuantity = changeManualItemQuantity;
        this.__changeManualBuilderCookieQuantity = changeManualBuilderCookieQuantity;
        this.__removeManualBuilderStaleSelection = removeManualBuilderStaleSelection;
        this.__renderManualMenuItems = renderManualMenuItems;
        this.__updateManualOrderSummary = updateManualOrderSummary;
        this.__closeManualOrderModal = closeManualOrderModal;
        this.__buildSavePayloadPreview = function (orderId) {
            return [
                ...OrderEditor.buildOrderItemsPayload(orderId, manualOrderItems, manualUnresolvedBuilderItems),
                ...OrderEditor.buildBuilderBoxOrderItems(orderId, manualBuilderBoxes)
            ];
        };
        `
    ].join("\n");

    vm.runInContext(source, sandbox);

    sandbox.__setMenuItems(ALL_MENU_ITEMS);
    sandbox.__renderManualMenuItems();

    return { sandbox, elements };
}

function itemsContainerHtml(elements) {
    return elements.get("manualItems").innerHTML;
}

test("17. increasing a Mix & Match box from 0 to 1 reveals the embedded selector with every eligible flavor", () => {
    const { sandbox, elements } = loadAdminOrdersSandbox();

    sandbox.__changeManualItemQuantity(SIX_BUILDER.id, 1);

    const html = itemsContainerHtml(elements);
    assert.match(html, /Selected: 0 \/ 6/);
    // Rendered through escapeHtml(), so an apostrophe becomes &#039;.
    ["Brown Butter Sea Salt Chocolate Chip", "S&#039;mores", "Strawberry Shortcake", "Browned Butter Snickerdoodle"]
        .forEach(name => assert.ok(html.includes(name), `expected ${name} in the rendered selector`));
});

test("18. clicking + on flavors updates \"Selected: X / Y\" live, and Save is disabled until it matches exactly", () => {
    const { sandbox, elements } = loadAdminOrdersSandbox();

    sandbox.__changeManualItemQuantity(SIX_BUILDER.id, 1); // 1 box, need 6
    assert.equal(elements.get("manualSaveButton").disabled, true);

    for (let i = 0; i < 6; i++) {
        sandbox.__changeManualBuilderCookieQuantity(SIX_BUILDER.id, COOKIE_A.id, COOKIE_A.name, 1);
    }

    assert.match(itemsContainerHtml(elements), /Selected: 6 \/ 6/);
    assert.equal(elements.get("manualSaveButton").disabled, false, "Save must re-enable once the selection exactly matches");

    // One more pushes it over -- Save must disable again.
    sandbox.__changeManualBuilderCookieQuantity(SIX_BUILDER.id, COOKIE_B.id, COOKIE_B.name, 1);
    assert.match(itemsContainerHtml(elements), /Selected: 7 \/ 6/);
    assert.equal(elements.get("manualSaveButton").disabled, true);
});

test("19. reducing the box back to 0 removes the embedded selector and its selections entirely", () => {
    const { sandbox, elements } = loadAdminOrdersSandbox();

    sandbox.__changeManualItemQuantity(SIX_BUILDER.id, 1);
    sandbox.__changeManualBuilderCookieQuantity(SIX_BUILDER.id, COOKIE_A.id, COOKIE_A.name, 6);
    assert.ok(sandbox.__getManualBuilderBoxes()[SIX_BUILDER.id]);

    sandbox.__changeManualItemQuantity(SIX_BUILDER.id, -1);

    assert.equal(sandbox.__getManualBuilderBoxes()[SIX_BUILDER.id], undefined);
    assert.doesNotMatch(itemsContainerHtml(elements), /Selected:/);
    assert.equal(elements.get("manualSaveButton").disabled, false);
});

test("20. a flavor that becomes unavailable while selected is flagged for review and blocks Save until removed", () => {
    const { sandbox, elements } = loadAdminOrdersSandbox();

    sandbox.__setManualBuilderBoxes({
        [SIX_BUILDER.id]: {
            id: SIX_BUILDER.id, name: SIX_BUILDER.name, builderGroup: "cookie",
            builderSize: 6, perBoxPrice: 15, boxQuantity: 1,
            selections: selectionsMap([COOKIE_A, 6])
        }
    });

    // The previously-chosen flavor is now unavailable.
    sandbox.__setMenuItems(ALL_MENU_ITEMS.map(item =>
        item.id === COOKIE_A.id ? { ...item, available: false } : item
    ));
    sandbox.__renderManualMenuItems();

    assert.match(itemsContainerHtml(elements), /no longer available/);
    assert.equal(elements.get("manualSaveButton").disabled, true);

    sandbox.__removeManualBuilderStaleSelection(SIX_BUILDER.id, COOKIE_A.id);
    assert.doesNotMatch(itemsContainerHtml(elements), /no longer available/);
});

test("21. Cancel (closing the editor) discards all in-progress state without saving anything", () => {
    const { sandbox } = loadAdminOrdersSandbox();

    sandbox.__changeManualItemQuantity(SIX_BUILDER.id, 1);
    sandbox.__changeManualBuilderCookieQuantity(SIX_BUILDER.id, COOKIE_A.id, COOKIE_A.name, 6);
    assert.ok(Object.keys(sandbox.__getManualBuilderBoxes()).length > 0);

    sandbox.__closeManualOrderModal();

    // Cross-realm objects (created inside the vm sandbox) compare equal in
    // content but not via deepStrictEqual's prototype check, so compare
    // by key count instead.
    assert.equal(Object.keys(sandbox.__getManualBuilderBoxes()).length, 0);
    assert.equal(Object.keys(sandbox.__getManualOrderItems()).length, 0);
});

test("22. a regular non-builder item still edits normally alongside the Mix & Match UI changes", () => {
    const { sandbox } = loadAdminOrdersSandbox();

    const flatItem = { id: "menu-sourdough", name: "Classic Sourdough", product_type: "standard", category: "bread", price: 8 };
    sandbox.__setMenuItems([...ALL_MENU_ITEMS, flatItem]);

    sandbox.__changeManualItemQuantity("menu-sourdough", 1);
    sandbox.__changeManualItemQuantity("menu-sourdough", 1);

    assert.equal(sandbox.__getManualOrderItems()["menu-sourdough"].quantity, 2);
    assert.equal(sandbox.__getManualOrderItems()["menu-sourdough"].price, 8);
});

test("23. the final save payload combines the flat item and the completed Mix & Match box with no duplicates", () => {
    const { sandbox } = loadAdminOrdersSandbox();

    const flatItem = { id: "menu-sourdough", name: "Classic Sourdough", product_type: "standard", category: "bread", price: 8 };
    sandbox.__setMenuItems([...ALL_MENU_ITEMS, flatItem]);

    sandbox.__changeManualItemQuantity("menu-sourdough", 1);
    sandbox.__changeManualItemQuantity(SIX_BUILDER.id, 1);
    for (let i = 0; i < 6; i++) {
        sandbox.__changeManualBuilderCookieQuantity(SIX_BUILDER.id, COOKIE_A.id, COOKIE_A.name, 1);
    }

    const payload = sandbox.__buildSavePayloadPreview("order-new");
    assert.equal(payload.length, 2);
    assert.equal(payload.filter(row => row.item_name === "6 Mix & Match Cookies").length, 1);
    assert.equal(payload.find(row => row.item_name === "6 Mix & Match Cookies").line_total, 15);
    assert.equal(payload.find(row => row.item_name === "Classic Sourdough").line_total, 8);
});
