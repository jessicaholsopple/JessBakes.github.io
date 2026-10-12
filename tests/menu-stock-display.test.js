"use strict";

/* ==========================================
   Finished-product freezer stock -- public menu display (js/menu.js)

   Covers the "Only X left" / "Sold Out" badge, the Add-to-Cart /
   quantity-stepper disabling, and the auto-hide-at-zero-stock
   filtering -- all driven purely by stock_mode/available_count/
   sold_out_behavior fields merged onto each menu item (see
   js/mix-and-match.js's mergeStockOntoMenuItems, tested separately in
   tests/mix-and-match-stock.test.js). A made-to-order item (the
   default -- no stock fields at all) must render byte-identical to
   before this feature existed.

   node:vm sandbox technique, loading only js/menu.js -- renderMenuCard
   only needs a global getCartQuantity() to exist (it's called
   directly), so a minimal stub is enough; the onclick handlers
   themselves are never invoked here.
   ========================================== */

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function read(relPath) {
    return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

function loadMenuSandbox({ cartQuantity = 0, stockData, stockError } = {}) {
    const sandbox = {
        console,
        document: { addEventListener: () => {} },
        getCartQuantity: () => cartQuantity,
        supabaseClient: {
            from(table) {
                if (table === "menu_item_stock") {
                    return { select: () => Promise.resolve({ data: stockData || [], error: stockError || null }) };
                }
                return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) };
            }
        }
    };
    vm.createContext(sandbox);

    const source = [
        read("js/mix-and-match.js"),
        read("js/menu.js"),
        `
        this.__renderMenuCard = renderMenuCard;
        this.__isHiddenSoldOut = isHiddenSoldOut;
        this.__attachFinishedStock = attachFinishedStock;
        `
    ].join("\n");

    vm.runInContext(source, sandbox);

    return sandbox;
}

/* ==========================================
   renderMenuCard -- badge + button states
========================================== */

test("1. a made-to-order item (no stock fields) shows no badge and a normal Add to Cart button", () => {
    const sandbox = loadMenuSandbox();
    const item = { id: "a", name: "Classic Cookie", price: 3, category: "cookie", product_type: "standard" };

    const html = sandbox.__renderMenuCard(item);

    assert.doesNotMatch(html, /stock-badge/);
    assert.doesNotMatch(html, /Sold Out/);
    assert.match(html, /Add to Cart/);
    assert.doesNotMatch(html, /disabled/);
});

test("2. a limited item with stock remaining shows an 'Only X left' badge and a normal Add to Cart button", () => {
    const sandbox = loadMenuSandbox();
    const item = { id: "a", name: "Wicked Caramel Apple", price: 3, category: "cookie", product_type: "standard", stock_mode: "limited", available_count: 6 };

    const html = sandbox.__renderMenuCard(item);

    assert.match(html, /Only 6 left/);
    assert.match(html, /Add to Cart/);
});

test("3. a sold-out limited item (quantity 0 in cart) shows a disabled 'Sold Out' button, never Add to Cart", () => {
    const sandbox = loadMenuSandbox({ cartQuantity: 0 });
    const item = { id: "a", name: "Snickerdoodle", price: 3, category: "cookie", product_type: "standard", stock_mode: "limited", available_count: 0 };

    const html = sandbox.__renderMenuCard(item);

    assert.match(html, /Sold Out/);
    assert.match(html, /<button type="button" class="add-cart-btn" disabled>Sold Out<\/button>/);
    assert.doesNotMatch(html, />\s*Add to Cart\s*</);
});

test("4. a limited item already at its cap in the cart shows a disabled + button (quantity stepper stays visible)", () => {
    const sandbox = loadMenuSandbox({ cartQuantity: 2 });
    const item = { id: "a", name: "Wicked Caramel Apple", price: 3, category: "cookie", product_type: "standard", stock_mode: "limited", available_count: 2 };

    const html = sandbox.__renderMenuCard(item);

    assert.match(html, />2</); // the quantity readout
    assert.match(html, /onclick="changeCartQuantity\('a',1\)"\s*\n\s*disabled>/);
});

test("5. a limited item below its cap shows an enabled + button", () => {
    const sandbox = loadMenuSandbox({ cartQuantity: 1 });
    const item = { id: "a", name: "Wicked Caramel Apple", price: 3, category: "cookie", product_type: "standard", stock_mode: "limited", available_count: 5 };

    const html = sandbox.__renderMenuCard(item);

    assert.doesNotMatch(html, /onclick="changeCartQuantity\('a',1\)"\s*\n\s*disabled>/);
});

test("6. a Mix & Match box product is never affected by stock fields (boxes are never stock-tracked themselves)", () => {
    const sandbox = loadMenuSandbox({ cartQuantity: 0 });
    const item = { id: "box", name: "6 Mix & Match Cookies", price: 15, category: "cookie", product_type: "builder" };

    const html = sandbox.__renderMenuCard(item);

    assert.doesNotMatch(html, /stock-badge/);
    assert.match(html, /openBuilderModal\('box'\)/);
});

/* ==========================================
   isHiddenSoldOut -- auto-hide behavior
========================================== */

test("7. a zero-stock item with sold_out_behavior='hide' is hidden", () => {
    const sandbox = loadMenuSandbox();
    assert.equal(sandbox.__isHiddenSoldOut({ stock_mode: "limited", available_count: 0, sold_out_behavior: "hide" }), true);
});

test("8. a zero-stock item with sold_out_behavior='show_sold_out' is NOT hidden (shows the Sold Out badge instead)", () => {
    const sandbox = loadMenuSandbox();
    assert.equal(sandbox.__isHiddenSoldOut({ stock_mode: "limited", available_count: 0, sold_out_behavior: "show_sold_out" }), false);
});

test("9. a limited item that still has stock is never hidden regardless of its sold_out_behavior setting", () => {
    const sandbox = loadMenuSandbox();
    assert.equal(sandbox.__isHiddenSoldOut({ stock_mode: "limited", available_count: 3, sold_out_behavior: "hide" }), false);
});

test("10. a made-to-order item is never hidden", () => {
    const sandbox = loadMenuSandbox();
    assert.equal(sandbox.__isHiddenSoldOut({}), false);
});

/* ==========================================
   attachFinishedStock -- best-effort fetch + merge
========================================== */

test("11. attachFinishedStock merges live stock rows onto the given items", async () => {
    const sandbox = loadMenuSandbox({
        stockData: [{ menu_item_id: "a", stock_mode: "limited", available_count: 4, sold_out_behavior: "show_sold_out" }]
    });
    const items = [{ id: "a", name: "Wicked Caramel Apple" }];

    await sandbox.__attachFinishedStock(items);

    assert.equal(items[0].stock_mode, "limited");
    assert.equal(items[0].available_count, 4);
});

test("12. attachFinishedStock fails open on a query error -- the menu still renders, every item made-to-order", async () => {
    const sandbox = loadMenuSandbox({ stockError: { message: "boom" } });
    const items = [{ id: "a", name: "Classic Cookie" }];

    await assert.doesNotReject(() => sandbox.__attachFinishedStock(items));
    assert.equal(items[0].stock_mode, undefined);
});
