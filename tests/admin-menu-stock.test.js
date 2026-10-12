"use strict";

/* ==========================================
   Finished-product freezer stock -- admin Menu Stock page
   (js/admin-menu-stock.js).

   Pure-logic functions (stockStatus, needsAdjustmentConfirmation,
   applyStockRowToItem) are exercised directly in a node:vm sandbox.
   The RPC-calling write paths (saveStockMode/applyStockAdjustment) are
   covered structurally -- confirming they call the right RPC with the
   right parameter names -- since full DOM mocking for this page's
   many modal fields would test the mock more than the code; live
   verification covers the real end-to-end write behavior.
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

function loadAdminMenuStockSandbox() {
    const sandbox = {
        console,
        document: { addEventListener: () => {} },
        supabaseClient: { from: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) }
    };
    vm.createContext(sandbox);

    const source = [
        read("js/admin-menu-stock.js"),
        `
        this.__stockStatus = stockStatus;
        this.__needsAdjustmentConfirmation = needsAdjustmentConfirmation;
        this.__applyStockRowToItem = applyStockRowToItem;
        `
    ].join("\n");

    vm.runInContext(source, sandbox);

    return sandbox;
}

/* ==========================================
   stockStatus
========================================== */

test("1. a made-to-order item is 'available'", () => {
    const sandbox = loadAdminMenuStockSandbox();
    assert.equal(sandbox.__stockStatus({ available: true, stock_mode: "made_to_order" }), "available");
});

test("2. a limited item with stock remaining is 'available'", () => {
    const sandbox = loadAdminMenuStockSandbox();
    assert.equal(sandbox.__stockStatus({ available: true, stock_mode: "limited", available_count: 3 }), "available");
});

test("3. a zero-stock limited item with sold_out_behavior='show_sold_out' is 'sold_out'", () => {
    const sandbox = loadAdminMenuStockSandbox();
    assert.equal(sandbox.__stockStatus({ available: true, stock_mode: "limited", available_count: 0, sold_out_behavior: "show_sold_out" }), "sold_out");
});

test("4. a zero-stock limited item with sold_out_behavior='hide' is 'hidden'", () => {
    const sandbox = loadAdminMenuStockSandbox();
    assert.equal(sandbox.__stockStatus({ available: true, stock_mode: "limited", available_count: 0, sold_out_behavior: "hide" }), "hidden");
});

test("5. menu_items.available=false always reports 'unavailable', regardless of stock -- the manual toggle still wins", () => {
    const sandbox = loadAdminMenuStockSandbox();
    assert.equal(sandbox.__stockStatus({ available: false, stock_mode: "limited", available_count: 5 }), "unavailable");
    assert.equal(sandbox.__stockStatus({ available: false, stock_mode: "made_to_order" }), "unavailable");
});

/* ==========================================
   needsAdjustmentConfirmation
========================================== */

test("6. any 'subtract' adjustment requires confirmation, however small", () => {
    const sandbox = loadAdminMenuStockSandbox();
    assert.equal(sandbox.__needsAdjustmentConfirmation("subtract", 1), true);
});

test("7. any 'set' (exact recount) adjustment requires confirmation, however small", () => {
    const sandbox = loadAdminMenuStockSandbox();
    assert.equal(sandbox.__needsAdjustmentConfirmation("set", 1), true);
});

test("8. a small 'add' does not require confirmation", () => {
    const sandbox = loadAdminMenuStockSandbox();
    assert.equal(sandbox.__needsAdjustmentConfirmation("add", 3), false);
});

test("9. an unusually large 'add' (typo protection) requires confirmation", () => {
    const sandbox = loadAdminMenuStockSandbox();
    assert.equal(sandbox.__needsAdjustmentConfirmation("add", 50), true);
    assert.equal(sandbox.__needsAdjustmentConfirmation("add", 200), true);
});

/* ==========================================
   applyStockRowToItem
========================================== */

test("10. applyStockRowToItem copies every stock field from an RPC response onto the local item", () => {
    const sandbox = loadAdminMenuStockSandbox();
    const item = { id: "a", name: "Test", stock_mode: "made_to_order" };
    sandbox.__applyStockRowToItem(item, {
        stock_mode: "limited", physical_count: 10, reserved_count: 2, available_count: 8, sold_out_behavior: "hide"
    });

    assert.equal(item.stock_mode, "limited");
    assert.equal(item.physical_count, 10);
    assert.equal(item.reserved_count, 2);
    assert.equal(item.available_count, 8);
    assert.equal(item.sold_out_behavior, "hide");
});

test("11. applyStockRowToItem is a safe no-op when given no row (e.g. a failed/empty RPC response)", () => {
    const sandbox = loadAdminMenuStockSandbox();
    const item = { id: "a", stock_mode: "limited", physical_count: 5 };
    assert.doesNotThrow(() => sandbox.__applyStockRowToItem(item, null));
    assert.equal(item.physical_count, 5, "untouched on a null row");
});

/* ==========================================
   Structural: the correct RPCs are called with the correct params
========================================== */

const source = read("js/admin-menu-stock.js");

test("12. switching to Limited calls set_menu_item_stock_mode with p_stock_mode: 'limited' and the entered initial count", () => {
    assert.match(source, /supabaseClient\.rpc\("set_menu_item_stock_mode", \{/);
    assert.match(source, /p_stock_mode: "limited",\s*\n\s*p_initial_count: initialCount/);
});

test("13. switching to Made to Order calls set_menu_item_stock_mode with p_stock_mode: 'made_to_order'", () => {
    assert.match(source, /p_stock_mode: "made_to_order"/);
});

test("14. quantity adjustments call adjust_finished_stock, never a direct table write to physical_count", () => {
    assert.match(source, /supabaseClient\.rpc\("adjust_finished_stock", \{/);
    assert.doesNotMatch(source, /\.from\("menu_item_stock"\)\s*\n\s*\.update\(\{\s*physical_count/);
});

test("15. the only direct table write to menu_item_stock is the documented sold_out_behavior toggle", () => {
    const updateCalls = [...source.matchAll(/\.from\("menu_item_stock"\)\s*\n\s*\.update\(\{([^}]*)\}\)/g)];
    assert.equal(updateCalls.length, 1, "expected exactly one direct .update() on menu_item_stock");
    assert.match(updateCalls[0][1], /sold_out_behavior/);
});

test("16. deleting a stock-adjustment row is never offered -- the ledger is append-only (no .delete() on finished_stock_movements)", () => {
    assert.doesNotMatch(source, /finished_stock_movements["'][\s\S]{0,80}\.delete\(/);
});

test("17. only standard products are ever listed -- Mix & Match boxes are excluded at the query level", () => {
    assert.match(source, /\.eq\("product_type", "standard"\)/);
});
