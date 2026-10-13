"use strict";

/* ==========================================
   Admin Menu Manager redesign (js/admin-menu.js)

   Covers the compact toolbar/table layout and the "no full reload on
   save" fix: search/category/status/type/featured filtering, modal
   open/close with unsaved-changes protection, async save success and
   failure (in-place state mutation, never a loadMenuManager()
   refetch), duplicate-submit prevention, delete confirmation,
   sessionStorage UI-state persistence, and structural regression
   coverage for Mix & Match / finished-stock-adjacent fields and
   mobile CSS.

   Same node:vm sandbox + fake chainable Supabase client technique as
   tests/cart-schedule-integrity.test.js and
   tests/admin-menu-stock.test.js.
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

/* ==========================================
   FAKE SUPABASE CLIENT

   Generic chainable mock: every filter/select/order call returns the
   same chain object; .update()/.insert()/.delete() switch the
   "kind" used to key the configured response, so a read vs. a write
   vs. a delete against the same table can be configured
   independently. Both `.single()` and plain `await chain` (the
   thenable itself) resolve from the same per-(table,kind) queue.
   ========================================== */

function makeSupabaseClient(responseQueues = {}) {
    const calls = [];
    const used = {};

    function nextResponse(key, fallback) {
        used[key] = used[key] || 0;
        const queue = responseQueues[key] || [];
        const resp = queue.length ? queue[Math.min(used[key], queue.length - 1)] : fallback;
        used[key]++;
        return resp;
    }

    function makeChain(table, kind) {
        const chain = {
            select: (...a) => { calls.push({ table, kind, method: "select", args: a }); return chain; },
            order: (...a) => { calls.push({ table, kind, method: "order", args: a }); return chain; },
            eq: (...a) => { calls.push({ table, kind, method: "eq", args: a }); return chain; },
            update: (...a) => { calls.push({ table, kind: "write", method: "update", args: a }); return makeChain(table, "write"); },
            insert: (...a) => { calls.push({ table, kind: "write", method: "insert", args: a }); return makeChain(table, "write"); },
            delete: (...a) => { calls.push({ table, kind: "delete", method: "delete", args: a }); return makeChain(table, "delete"); },
            single: () => Promise.resolve(nextResponse(`${table}.${kind}`, { data: null, error: null })),
            then: (resolve) => resolve(nextResponse(`${table}.${kind}`, { data: [], error: null, count: 0 }))
        };
        return chain;
    }

    return {
        calls,
        writeCallCount: (table) => calls.filter(c => c.table === table && c.kind === "write").length,
        deleteCallCount: (table) => calls.filter(c => c.table === table && c.kind === "delete").length,
        from: (table) => makeChain(table, "read")
    };
}

/* ==========================================
   FAKE DOM
   ========================================== */

function loadAdminMenuSandbox({ responseQueues, confirmResult = true } = {}) {
    const elements = new Map();
    const sessionStore = new Map();
    const confirmCalls = [];
    const alertCalls = [];

    function makeFakeElement(id) {
        return {
            id: id || "",
            value: "", checked: false, textContent: "", innerHTML: "",
            style: {}, disabled: false, className: "",
            classList: { add() {}, remove() {}, toggle() {} },
            dataset: {},
            addEventListener: () => {},
            removeEventListener: () => {},
            setAttribute: () => {},
            getAttribute: () => null,
            querySelector: () => makeFakeElement(""),
            querySelectorAll: () => [],
            appendChild: (child) => { if (child && child.id) elements.set(child.id, child); },
            focus: () => {},
            reset: () => {}
        };
    }

    function fakeElement(id) {
        if (!elements.has(id)) elements.set(id, makeFakeElement(id));
        return elements.get(id);
    }

    const supabaseClient = makeSupabaseClient(responseQueues);

    const fakeDocument = {
        addEventListener: () => {},
        getElementById: (id) => fakeElement(id),
        createElement: () => makeFakeElement(""),
        body: { appendChild: (el) => { if (el && el.id) elements.set(el.id, el); } },
        activeElement: makeFakeElement("__body__")
    };

    const sandbox = {
        document: fakeDocument,
        window: { addEventListener: () => {}, scrollY: 0, scrollTo: () => {} },
        console,
        supabaseClient,
        confirm: (msg) => { confirmCalls.push(msg); return confirmResult; },
        alert: (msg) => alertCalls.push(msg),
        sessionStorage: {
            getItem: (k) => (sessionStore.has(k) ? sessionStore.get(k) : null),
            setItem: (k, v) => sessionStore.set(k, v),
            removeItem: (k) => sessionStore.delete(k)
        },
        setTimeout: (fn) => { fn(); return 1; }, // synchronous, so debounced search resolves immediately in tests
        clearTimeout: () => {}
    };
    vm.createContext(sandbox);

    const source = [
        read("js/admin-menu.js"),
        `
        this.__applyMenuFilters = applyMenuFilters;
        this.__renderMenuManagerShell = renderMenuManagerShell;
        this.__openMenuItemModal = openMenuItemModal;
        this.__closeMenuItemModal = closeMenuItemModal;
        this.__saveMenuItem = saveMenuItem;
        this.__toggleMenuAvailability = toggleMenuAvailability;
        this.__toggleFeatured = toggleFeatured;
        this.__deleteMenuItem = deleteMenuItem;
        this.__updateSortOrder = updateSortOrder;
        this.__setMenuCategoryFilter = setMenuCategoryFilter;
        this.__persistMenuUiState = persistMenuUiState;
        this.__restoreMenuUiState = restoreMenuUiState;

        this.__getMenuItems = function() { return menuItems; };
        this.__setMenuItems = function(items) { menuItems = items; };
        this.__getSearch = function() { return menuSearchQuery; };
        this.__setSearch = function(v) { menuSearchQuery = v; };
        this.__getCategory = function() { return menuActiveCategory; };
        this.__setStatusFilter = function(v) { menuStatusFilter = v; };
        this.__setTypeFilter = function(v) { menuTypeFilter = v; };
        this.__setFeaturedFilter = function(v) { menuFeaturedFilter = v; };
        this.__setModalDirty = function(v) { menuModalDirty = v; };
        this.__getModalDirty = function() { return menuModalDirty; };
        this.__setModalSaving = function(v) { menuModalSaving = v; };
        `
    ].join("\n");

    vm.runInContext(source, sandbox);

    return { sandbox, elements, supabaseClient, sessionStore, confirmCalls, alertCalls, fakeElement };
}

const SAMPLE_ITEMS = [
    { id: "a1", name: "Sourdough Boule", category: "bread", product_type: "standard", price: 9, available: true, featured: true, sort_order: 1, builder_group: null },
    { id: "a2", name: "Chai Sugar Cookie", category: "cookie", product_type: "standard", price: 3, available: true, featured: false, sort_order: 1, builder_group: "cookie" },
    { id: "a3", name: "Archived Loaf", category: "bread", product_type: "standard", price: 8, available: false, featured: false, sort_order: 2, builder_group: null },
    { id: "a4", name: "6 Mix & Match Cookies", category: "cookie", product_type: "builder", price: 15, available: true, featured: false, sort_order: 2, builder_group: "cookie", builder_size: 6 }
];

function seedAndRender(sandbox, items = SAMPLE_ITEMS) {
    sandbox.__renderMenuManagerShell();
    sandbox.__setMenuItems(items.map(i => ({ ...i })));
    sandbox.__applyMenuFilters();
}

function tableHtml(elements) {
    return elements.get("menuTableBody").innerHTML;
}

/* ==========================================
   FILTERING: search / category / status / type / featured
========================================== */

test("1. with no filters, every item appears in the table", () => {
    const { sandbox, elements } = loadAdminMenuSandbox();
    seedAndRender(sandbox);

    const html = tableHtml(elements);
    assert.match(html, /Sourdough Boule/);
    assert.match(html, /Chai Sugar Cookie/);
    assert.match(html, /Archived Loaf/);
    assert.match(html, /6 Mix &amp; Match Cookies/);
});

test("2. search filters by item name, case-insensitively", () => {
    const { sandbox, elements } = loadAdminMenuSandbox();
    seedAndRender(sandbox);

    sandbox.__setSearch("sourdough");
    sandbox.__applyMenuFilters();

    const html = tableHtml(elements);
    assert.match(html, /Sourdough Boule/);
    assert.doesNotMatch(html, /Chai Sugar Cookie/);
});

test("3. category tab filters to just that category", () => {
    const { sandbox, elements } = loadAdminMenuSandbox();
    seedAndRender(sandbox);

    sandbox.__setMenuCategoryFilter("cookie");

    const html = tableHtml(elements);
    assert.doesNotMatch(html, /Sourdough Boule/);
    assert.match(html, /Chai Sugar Cookie/);
    assert.equal(sandbox.__getCategory(), "cookie");
});

test("4. 'All Items' shows every category again", () => {
    const { sandbox, elements } = loadAdminMenuSandbox();
    seedAndRender(sandbox);

    sandbox.__setMenuCategoryFilter("cookie");
    sandbox.__setMenuCategoryFilter("all");

    const html = tableHtml(elements);
    assert.match(html, /Sourdough Boule/);
    assert.match(html, /Chai Sugar Cookie/);
});

test("5. status filter: 'unavailable' shows only archived items", () => {
    const { sandbox, elements } = loadAdminMenuSandbox();
    seedAndRender(sandbox);

    sandbox.__setStatusFilter("unavailable");
    sandbox.__applyMenuFilters();

    const html = tableHtml(elements);
    assert.match(html, /Archived Loaf/);
    assert.doesNotMatch(html, /Sourdough Boule/);
});

test("6. type filter: 'builder' shows only Mix & Match box products", () => {
    const { sandbox, elements } = loadAdminMenuSandbox();
    seedAndRender(sandbox);

    sandbox.__setTypeFilter("builder");
    sandbox.__applyMenuFilters();

    const html = tableHtml(elements);
    assert.match(html, /6 Mix &amp; Match Cookies/);
    assert.doesNotMatch(html, /Sourdough Boule/);
});

test("7. featured filter: 'featured' shows only featured items", () => {
    const { sandbox, elements } = loadAdminMenuSandbox();
    seedAndRender(sandbox);

    sandbox.__setFeaturedFilter("featured");
    sandbox.__applyMenuFilters();

    const html = tableHtml(elements);
    assert.match(html, /Sourdough Boule/);
    assert.doesNotMatch(html, /Chai Sugar Cookie/);
});

test("8. combined filters (category + search) narrow correctly, and the empty state shows when nothing matches", () => {
    const { sandbox, elements } = loadAdminMenuSandbox();
    seedAndRender(sandbox);

    sandbox.__setMenuCategoryFilter("bread");
    sandbox.__setSearch("cookie");
    sandbox.__applyMenuFilters();

    const html = tableHtml(elements);
    assert.match(html, /No menu items match these filters/);
});

test("9. the results-count label reflects filtered vs. total", () => {
    const { sandbox, elements } = loadAdminMenuSandbox();
    seedAndRender(sandbox);

    sandbox.__setMenuCategoryFilter("cookie");

    assert.match(elements.get("menuResultsCount").textContent, /Showing 2 of 4/);
});

/* ==========================================
   MODAL: open/close, unsaved-changes protection
========================================== */

test("10. opening the editor for an existing item populates the hidden id field", () => {
    const { sandbox, elements } = loadAdminMenuSandbox();
    seedAndRender(sandbox);

    sandbox.__openMenuItemModal(null, "a1");

    assert.equal(elements.get("menuItemId").value, "a1");
    assert.equal(elements.get("menuItemName").value, "Sourdough Boule");
});

test("11. opening the editor resets the dirty flag, even if it was left dirty from a previous session", () => {
    const { sandbox } = loadAdminMenuSandbox();
    seedAndRender(sandbox);

    sandbox.__setModalDirty(true);
    sandbox.__openMenuItemModal(null, "a1");

    assert.equal(sandbox.__getModalDirty(), false);
});

test("12. closing a dirty editor without confirming leaves it open (modal stays visible)", () => {
    const { sandbox, elements, confirmResult } = { ...loadAdminMenuSandbox({ confirmResult: false }) };
    seedAndRender(sandbox);

    sandbox.__openMenuItemModal(null, "a1");
    sandbox.__setModalDirty(true);
    sandbox.__closeMenuItemModal();

    assert.equal(elements.get("menuItemModal").style.display, "flex");
});

test("13. closing a dirty editor and confirming discard actually closes it", () => {
    const { sandbox, elements } = loadAdminMenuSandbox({ confirmResult: true });
    seedAndRender(sandbox);

    sandbox.__openMenuItemModal(null, "a1");
    sandbox.__setModalDirty(true);
    sandbox.__closeMenuItemModal();

    assert.equal(elements.get("menuItemModal").style.display, "none");
});

test("14. closing a clean (non-dirty) editor never prompts for confirmation", () => {
    const { sandbox, confirmCalls } = loadAdminMenuSandbox();
    seedAndRender(sandbox);

    sandbox.__openMenuItemModal(null, "a1");
    sandbox.__closeMenuItemModal();

    assert.equal(confirmCalls.length, 0);
});

/* ==========================================
   SAVE: success, failure, duplicate-submit guard
========================================== */

function seedValidForm(fakeElement) {
    fakeElement("menuItemId").value = "a1";
    fakeElement("menuItemName").value = "Sourdough Boule";
    fakeElement("menuItemPrice").value = "11";
    fakeElement("menuItemDescription").value = "";
    fakeElement("menuItemCategory").value = "bread";
    fakeElement("menuProductType").value = "standard";
    fakeElement("menuAvailableInMixMatch").checked = false;
    fakeElement("menuBuilderGroup").value = "";
    fakeElement("menuBuilderSize").value = "4";
    fakeElement("menuRequiresRecipe").checked = false; // skips the recipe-required validation path
    fakeElement("menuRecipe").value = "";
    fakeElement("menuPackaging").value = "pkg-1";
    fakeElement("menuRecipeUnitsUsed").value = "1";
    fakeElement("menuItemSort").value = "1";
    fakeElement("menuItemAvailable").checked = true;
    fakeElement("menuItemFeatured").checked = true;
}

test("15. a successful save updates the item in place (no refetch) and closes the modal", async () => {
    const savedRow = { id: "a1", name: "Sourdough Boule (Updated)", category: "bread", product_type: "standard", price: 11, available: true, featured: true, sort_order: 1 };
    const { sandbox, elements, supabaseClient, fakeElement } = loadAdminMenuSandbox({
        responseQueues: { "menu_items.write": [{ data: savedRow, error: null }] }
    });
    seedAndRender(sandbox);
    sandbox.__openMenuItemModal(null, "a1");
    seedValidForm(fakeElement);

    const readCallsBefore = supabaseClient.calls.filter(c => c.table === "menu_items" && c.kind === "read").length;

    await sandbox.__saveMenuItem();

    const readCallsAfter = supabaseClient.calls.filter(c => c.table === "menu_items" && c.kind === "read").length;
    assert.equal(readCallsAfter, readCallsBefore, "a save must never trigger a fresh menu_items read/refetch");

    const updated = sandbox.__getMenuItems().find(i => i.id === "a1");
    assert.equal(updated.name, "Sourdough Boule (Updated)");

    assert.equal(elements.get("menuItemModal").style.display, "none");
    assert.match(elements.get("menuToast").textContent, /saved/i);
});

test("16. a failed save shows an inline error, keeps the modal open, and re-enables the Save button", async () => {
    const { sandbox, elements, fakeElement } = loadAdminMenuSandbox({
        responseQueues: { "menu_items.write": [{ data: null, error: { message: "Network error" } }] }
    });
    seedAndRender(sandbox);
    sandbox.__openMenuItemModal(null, "a1");
    seedValidForm(fakeElement);

    await sandbox.__saveMenuItem();

    assert.equal(elements.get("menuItemModal").style.display, "flex", "modal must stay open on failure");
    assert.equal(elements.get("menuModalError").style.display, "block");
    assert.match(elements.get("menuModalError").textContent, /Network error/);
    assert.equal(elements.get("menuSaveBtn").disabled, false);
    assert.equal(elements.get("menuSaveBtn").textContent, "Save Item");
});

test("17. validation failure (no name) shows inline error and never calls the server", async () => {
    const { sandbox, elements, supabaseClient, fakeElement } = loadAdminMenuSandbox();
    seedAndRender(sandbox);
    sandbox.__openMenuItemModal(null, "a1");
    seedValidForm(fakeElement);
    fakeElement("menuItemName").value = "   ";

    await sandbox.__saveMenuItem();

    assert.equal(supabaseClient.writeCallCount("menu_items"), 0);
    assert.match(elements.get("menuModalError").textContent, /enter an item name/i);
});

test("18. duplicate-submit guard: a save already in flight blocks a second concurrent call", async () => {
    const { sandbox, supabaseClient, fakeElement } = loadAdminMenuSandbox({
        responseQueues: { "menu_items.write": [{ data: { id: "a1", name: "X", category: "bread" }, error: null }] }
    });
    seedAndRender(sandbox);
    sandbox.__openMenuItemModal(null, "a1");
    seedValidForm(fakeElement);

    sandbox.__setModalSaving(true);
    await sandbox.__saveMenuItem();

    assert.equal(supabaseClient.writeCallCount("menu_items"), 0, "a save already marked in-flight must not fire a second request");
});

/* ==========================================
   STATE PRESERVATION: search/category/filters survive a mutation
========================================== */

test("19. toggling availability preserves the active search, category, and filters", async () => {
    const updatedRow = { id: "a2", name: "Chai Sugar Cookie", category: "cookie", product_type: "standard", price: 3, available: false, featured: false, sort_order: 1 };
    const { sandbox } = loadAdminMenuSandbox({
        responseQueues: { "menu_items.write": [{ data: updatedRow, error: null }] }
    });
    seedAndRender(sandbox);

    sandbox.__setSearch("cookie");
    sandbox.__setMenuCategoryFilter("cookie");
    sandbox.__setStatusFilter("available");

    await sandbox.__toggleMenuAvailability("a2", true);

    assert.equal(sandbox.__getSearch(), "cookie");
    assert.equal(sandbox.__getCategory(), "cookie");
});

test("20. a failed toggle reverts the row to its real server state (re-renders from the unmutated item)", async () => {
    const { sandbox, elements } = loadAdminMenuSandbox({
        responseQueues: { "menu_items.write": [{ data: null, error: { message: "RLS denied" } }] }
    });
    seedAndRender(sandbox);

    await sandbox.__toggleFeatured("a1", true);

    const item = sandbox.__getMenuItems().find(i => i.id === "a1");
    assert.equal(item.featured, true, "in-memory item must be unchanged on a failed write");
    assert.match(elements.get("menuToast").textContent, /RLS denied/);
});

/* ==========================================
   DELETE CONFIRMATION
========================================== */

test("21. declining the delete confirmation never calls the server and keeps the item", async () => {
    const { sandbox, supabaseClient } = loadAdminMenuSandbox({ confirmResult: false });
    seedAndRender(sandbox);

    await sandbox.__deleteMenuItem("a1", "Sourdough Boule");

    assert.equal(supabaseClient.deleteCallCount("menu_items"), 0);
    assert.ok(sandbox.__getMenuItems().some(i => i.id === "a1"));
});

test("22. confirming delete (with zero order/sale references) removes the item in place", async () => {
    const { sandbox } = loadAdminMenuSandbox({
        confirmResult: true,
        responseQueues: {
            "order_items.read": [{ data: [], error: null, count: 0 }],
            "sale_items.read": [{ data: [], error: null, count: 0 }],
            "menu_items.delete": [{ data: null, error: null }]
        }
    });
    seedAndRender(sandbox);

    await sandbox.__deleteMenuItem("a1", "Sourdough Boule");

    assert.equal(sandbox.__getMenuItems().some(i => i.id === "a1"), false);
});

test("23. an item referenced by past orders/sales is refused with an explanation, and is never deleted", async () => {
    const { sandbox, alertCalls, supabaseClient } = loadAdminMenuSandbox({
        confirmResult: true,
        responseQueues: {
            "order_items.read": [{ data: [], error: null, count: 3 }],
            "sale_items.read": [{ data: [], error: null, count: 0 }]
        }
    });
    seedAndRender(sandbox);

    await sandbox.__deleteMenuItem("a1", "Sourdough Boule");

    assert.equal(supabaseClient.deleteCallCount("menu_items"), 0);
    assert.ok(alertCalls.some(a => /can't be permanently deleted/i.test(a)));
    assert.ok(sandbox.__getMenuItems().some(i => i.id === "a1"));
});

/* ==========================================
   SORT ORDER (no reload)
========================================== */

test("24. bumping sort order mutates in place and never refetches", async () => {
    const { sandbox, supabaseClient } = loadAdminMenuSandbox({
        responseQueues: { "menu_items.write": [{ data: { id: "a1", name: "Sourdough Boule", category: "bread", sort_order: 2 }, error: null }] }
    });
    seedAndRender(sandbox);

    const readCallsBefore = supabaseClient.calls.filter(c => c.table === "menu_items" && c.kind === "read").length;
    await sandbox.__updateSortOrder("a1", 1);
    const readCallsAfter = supabaseClient.calls.filter(c => c.table === "menu_items" && c.kind === "read").length;

    assert.equal(readCallsAfter, readCallsBefore);
    assert.equal(sandbox.__getMenuItems().find(i => i.id === "a1").sort_order, 2);
});

/* ==========================================
   SESSIONSTORAGE UI-STATE PERSISTENCE
========================================== */

test("25. persistMenuUiState writes search/category/filters to sessionStorage", () => {
    const { sandbox, sessionStore } = loadAdminMenuSandbox();
    sandbox.__setSearch("boule");
    sandbox.__setMenuCategoryFilter("bread");
    sandbox.__setStatusFilter("available");

    sandbox.__persistMenuUiState();

    const saved = JSON.parse(sessionStore.get("jb_admin_menu_ui_state"));
    assert.equal(saved.search, "boule");
    assert.equal(saved.category, "bread");
    assert.equal(saved.status, "available");
});

test("26. restoreMenuUiState reads a previously-saved state back into the module", () => {
    const { sandbox, sessionStore } = loadAdminMenuSandbox();
    sessionStore.set("jb_admin_menu_ui_state", JSON.stringify({
        search: "cookie", category: "cookie", status: "", type: "builder", featured: "featured", scrollY: 400
    }));

    sandbox.__restoreMenuUiState();

    assert.equal(sandbox.__getSearch(), "cookie");
    assert.equal(sandbox.__getCategory(), "cookie");
});

test("27. a corrupt sessionStorage value never throws and falls back to defaults", () => {
    const { sandbox, sessionStore } = loadAdminMenuSandbox();
    sessionStore.set("jb_admin_menu_ui_state", "{not valid json");

    assert.doesNotThrow(() => sandbox.__restoreMenuUiState());
    assert.equal(sandbox.__getSearch(), "");
});

/* ==========================================
   STRUCTURAL: Mix & Match / finished-stock regression, mobile CSS
========================================== */

const jsSource = read("js/admin-menu.js");
const cssSource = read("css/admin.css");

test("28. the Mix & Match eligibility checkbox, builder group/size fields, and requires_recipe are all still read and sent on save -- unchanged by the redesign", () => {
    assert.match(jsSource, /menuAvailableInMixMatch/);
    assert.match(jsSource, /menuBuilderGroup/);
    assert.match(jsSource, /menuBuilderSize/);
    assert.match(jsSource, /requires_recipe:/);
    assert.match(jsSource, /builder_group:\s*builderGroup/);
});

test("29. the save payload still includes every pre-existing menu_items column -- no field was dropped", () => {
    const payloadStart = jsSource.indexOf("const payload = {");
    const payloadEnd = jsSource.indexOf("};", payloadStart);
    const payloadBlock = jsSource.slice(payloadStart, payloadEnd);

    ["name", "price", "description", "category", "product_type", "builder_group",
     "builder_size", "recipe_id", "requires_recipe", "packaging_profile_id",
     "recipe_units_used", "sort_order", "available", "featured"
    ].forEach(field => {
        // Shorthand properties (e.g. plain `name,`) and explicit `field:
        // value` are both valid -- just confirm the field is referenced
        // somewhere in the payload object literal.
        assert.match(payloadBlock, new RegExp("\\b" + field + "\\b"), `payload missing field: ${field}`);
    });
});

test("30. the page links to the existing Menu Stock page rather than duplicating a stock UI", () => {
    assert.match(jsSource, /href="menu-stock\.html"/);
    assert.doesNotMatch(jsSource, /stockModeToggle|adjust_finished_stock|set_menu_item_stock_mode/);
});

test("31. the reference-check guard against deleting an item used in past orders/sales is unchanged", () => {
    assert.match(jsSource, /countMenuItemReferences/);
    assert.match(jsSource, /from\("order_items"\)/);
    assert.match(jsSource, /from\("sale_items"\)/);
});

test("32. the ballot manager code (loadBallotManager and friends) is untouched by this redesign", () => {
    assert.match(jsSource, /async function loadBallotManager\(\)/);
    assert.match(jsSource, /function renderBallotManager\(/);
});

test("33. css/admin.css defines the mobile card transform scoped to .menu-items-table, never the generic .admin-table (so admin/menu-stock.html's table is unaffected)", () => {
    const mobileBlockMatch = cssSource.match(/@media \(max-width: 600px\) \{[\s\S]*?\.menu-items-table[\s\S]*?\n\}/);
    assert.ok(mobileBlockMatch, "expected a mobile @media block defining .menu-items-table rules");
    assert.match(mobileBlockMatch[0], /\.menu-items-table td::before/);
});

test("34. css/admin.css defines a base .admin-table style (previously missing) with real borders/padding", () => {
    assert.match(cssSource, /\.admin-table \{[\s\S]{0,120}border-collapse: collapse/);
    assert.match(cssSource, /\.admin-table td \{[\s\S]{0,120}border-bottom/);
});

test("35. css/admin.css defines the toast component with success/error variants", () => {
    assert.match(cssSource, /\.admin-toast \{/);
    assert.match(cssSource, /\.admin-toast\.is-success \{/);
    assert.match(cssSource, /\.admin-toast\.is-error \{/);
});

test("36. the sticky toolbar explicitly falls back to static positioning at mobile widths (avoiding a collision with .mobile-appbar's own sticky top:0)", () => {
    assert.match(cssSource, /\.menu-manager-toolbar \{[\s\S]{0,200}position: sticky/);
    const mobileOverride = cssSource.match(/@media \(max-width: 1000px\) \{\s*\.menu-manager-toolbar \{[\s\S]{0,100}position: static/);
    assert.ok(mobileOverride, "expected the toolbar to become position:static under max-width:1000px");
});
