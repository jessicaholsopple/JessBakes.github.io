"use strict";

/* ==========================================
   Admin Recipe Cards (js/admin-recipe-cards.js)

   Executes the REAL page code in a node:vm sandbox (same technique as
   tests/admin-inventory.test.js / tests/admin-order-builder.test.js),
   against a synthetic-only fixture set shaped exactly like the real
   data: S'mores Cookies (active, 14 ingredients -- mirrors the real
   recipe's real ingredient count), Classic Boule (two menu-item
   mappings, both inactive -- mirrors the real live multi-mapping
   case), Cream Cheese Frosting (unmapped but used as a component of
   Cinnamon Rolls -- mirrors the real live "valid unmapped recipe"
   case), Cinnamon Rolls (active, consumes Cream Cheese Frosting as a
   component), and one synthetic Broken Test Recipe exercising every
   warning path at once. No real database is touched by this file.
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
   Fixtures
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
        yield_quantity: 12, yield_unit: "item",
        notes: "Toast the marshmallow topping under the broiler for 30-60 seconds.",
        recipe_ingredients: [
            ingredientRow(1, 55, 125, "Sourdough Starter", "g"),
            ingredientRow(2, 1, 300, "All-Purpose Flour", "g"),
            ingredientRow(3, 2, 200, "Graham Crackers", "g"),
            ingredientRow(4, 3, 680, "Semi Sweet Chocolate Chips", "g"),
            ingredientRow(5, 4, 100, "Mini Marshmallows", "g"),
            ingredientRow(6, 5, 10, "Vanilla Extract", "mL"),
            ingredientRow(7, 6, 5, "Baking Soda", "g"),
            ingredientRow(8, 7, 0.05, "Salt", "g"),
            ingredientRow(9, 8, 150, "Brown Sugar", "g"),
            ingredientRow(10, 9, 100, "White Sugar", "g"),
            ingredientRow(11, 10, 170, "Butter", "g"),
            // Migrated: S'mores Cookies (a Cookie-category recipe) now
            // uses Egg Yolks, not whole Eggs -- see the Egg/Egg Yolk
            // migration. Quantity matches the real live data (4).
            ingredientRow(12, 57, 4, "Egg Yolks", "each"),
            ingredientRow(13, 12, 340, "Honey Graham Crumbs", "g"),
            ingredientRow(14, 13, 50, "Cocoa Powder", "g")
        ],
        recipe_components: []
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
        recipe_ingredients: [
            ingredientRow(60, 22, 500, "Bread Flour", "g"),
            // Migrated: the canonical Cinnamon Rolls recipe now uses 1
            // whole Egg + 1 Egg Yolk (was 2 whole Eggs) -- see the
            // Egg/Egg Yolk migration.
            ingredientRow(61, 6, 1, "Eggs", "each"),
            ingredientRow(62, 57, 1, "Egg Yolks", "each")
        ],
        recipe_components: [
            { id: 7, component_recipe_id: 10, quantity_used: 4, quantity_unit: "item", component_recipe: { id: 10, name: "Cream Cheese Frosting" } }
        ]
    };
}

function brokenTestRecipe() {
    return {
        id: 999, name: "Broken Test Recipe", category: "Test",
        yield_quantity: null, yield_unit: "", notes: null,
        recipe_ingredients: [ingredientRow(90, null, 10, null, null)],
        recipe_components: []
    };
}

// Mirrors the real, unchanged Classic Brownies: whole Eggs, never
// converted to Egg Yolks by the migration (Brownies are explicitly
// excluded from that conversion regardless of category).
function classicBrowniesRecipe() {
    return {
        id: 21, name: "Classic Brownies", category: "Dessert",
        yield_quantity: 12, yield_unit: "item", notes: "13x9 pan",
        recipe_ingredients: [
            ingredientRow(80, 40, 283, "Butter", "g"),
            ingredientRow(81, 6, 5, "Eggs", "each")
        ],
        recipe_components: []
    };
}

function baseRecipes() {
    return [smoresRecipe(), classicBouleRecipe(), creamCheeseFrostingRecipe(), cinnamonRollsRecipe(), classicBrowniesRecipe(), brokenTestRecipe()];
}

function baseMenuItems() {
    return [
        { id: "m1", name: "Classic Boule", available: false, recipe_id: 1 },
        { id: "m2", name: "Cinnamon Raisin Boule", available: false, recipe_id: 1 },
        { id: "m3", name: "S'mores Cookies", available: true, recipe_id: 22 },
        { id: "m4", name: "Cinnamon Rolls", available: true, recipe_id: 9 }
    ];
}

/* ==========================================
   Sandbox
   ========================================== */

function makeQueryBuilder(resolveResult) {
    const builder = {
        select() { return builder; },
        eq() { return builder; },
        not() { return builder; },
        order() { return builder; },
        limit() { return builder; },
        single() { return Promise.resolve(resolveResult()); },
        maybeSingle() { return Promise.resolve(resolveResult()); },
        then(onFulfilled, onRejected) {
            return Promise.resolve(resolveResult()).then(onFulfilled, onRejected);
        }
    };
    return builder;
}

function makeSupabaseMock(state) {
    const calls = [];
    return {
        calls,
        from(table) {
            const record = (op, extra) => calls.push({ table, op, ...extra });
            return {
                select() {
                    record("select");
                    return makeQueryBuilder(() => ({ data: state[table] || [], error: null }));
                },
                insert(payload) { record("insert", { payload }); return makeQueryBuilder(() => ({ data: null, error: null })); },
                update(payload) { record("update", { payload }); return { eq: () => Promise.resolve({ error: null }) }; },
                upsert(payload) { record("upsert", { payload }); return Promise.resolve({ error: null }); },
                delete() { record("delete"); return { eq: () => Promise.resolve({ error: null }) }; }
            };
        }
    };
}

function loadSandbox(state = { recipes: baseRecipes(), menu_items: baseMenuItems() }) {
    const elements = new Map();
    function fakeElement(id) {
        if (!elements.has(id)) {
            elements.set(id, {
                id, value: "", textContent: "", innerHTML: "", hidden: false,
                style: {}, href: ""
            });
        }
        return elements.get(id);
    }

    const bodyClasses = new Set();
    const printCalls = [];
    const afterPrintHandlers = [];

    const fakeDocument = {
        addEventListener: () => {},
        getElementById: (id) => fakeElement(id),
        querySelector: () => null,
        createElement: () => ({ style: {} }),
        body: {
            classList: {
                add: (c) => bodyClasses.add(c),
                remove: (c) => bodyClasses.delete(c),
                contains: (c) => bodyClasses.has(c)
            }
        }
    };

    let requireAuthCalls = 0;
    let setupLogoutCalls = 0;

    const supabaseMock = makeSupabaseMock(state);

    const sandbox = {
        document: fakeDocument,
        window: {
            location: { search: "" },
            addEventListener: (evt, handler) => { if (evt === "afterprint") afterPrintHandlers.push(handler); },
            removeEventListener: () => {},
            print: () => printCalls.push(true)
        },
        console,
        URLSearchParams,
        requireAuth: async () => { requireAuthCalls++; },
        setupLogout: () => { setupLogoutCalls++; },
        supabaseClient: supabaseMock
    };
    vm.createContext(sandbox);

    const source = [
        read("js/quantity-format.js"),
        read("js/recipe-scaling.js"),
        read("js/ingredient-naming.js"),
        read("js/recipe-cards-logic.js"),
        read("js/admin-recipe-cards.js"),
        `
        this.__loadRecipeCardsData = loadRecipeCardsData;
        this.__getViews = function () { return rcRecipeViews; };
        this.__getOpenView = function () { return rcOpenView; };
        this.__getMultiplier = function () { return rcMultiplier; };
        `
    ].join("\n");

    vm.runInContext(source, sandbox);

    return {
        sandbox, elements, supabaseMock,
        bodyClasses, printCalls, afterPrintHandlers,
        getRequireAuthCalls: () => requireAuthCalls,
        getSetupLogoutCalls: () => setupLogoutCalls
    };
}

/* ==========================================
   Load + coverage: every recipe appears exactly once
   ========================================== */

test("1. every current recipe appears exactly once after loading", async () => {
    const { sandbox } = loadSandbox();
    await sandbox.__loadRecipeCardsData();
    const views = sandbox.__getViews();

    assert.equal(views.length, 6);
    const ids = views.map(v => v.recipe.id);
    assert.equal(new Set(ids).size, ids.length, "no duplicate recipe appears twice");
});

test("2. S'mores Cookies appears with its complete stored ingredient list (14 ingredients)", async () => {
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadRecipeCardsData();

    const views = sandbox.__getViews();
    const smores = views.find(v => v.recipe.name === "S'mores Cookies");
    assert.ok(smores, "S'mores Cookies must be present");
    assert.equal(smores.recipe.recipe_ingredients.length, 14);

    sandbox.openRecipeDetail(22);
    const html = elements.get("rcIngredientList").innerHTML;
    // Every one of the 14 ingredient names must render.
    smores.recipe.recipe_ingredients.forEach(row => {
        assert.ok(html.includes(row.ingredients.name), `expected ${row.ingredients.name} in the rendered ingredient list`);
    });
});

test("3. active, inactive, and unmapped recipes all remain viewable (no default filtering hides any of them)", async () => {
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadRecipeCardsData();

    const gridHtml = elements.get("recipeCardsGrid").innerHTML;
    assert.match(gridHtml, /S&#039;mores Cookies|S'mores Cookies/);
    assert.match(gridHtml, /Classic Boule/);
    assert.match(gridHtml, /Cream Cheese Frosting/);

    const views = sandbox.__getViews();
    assert.equal(views.find(v => v.recipe.name === "S'mores Cookies").status, "active");
    assert.equal(views.find(v => v.recipe.name === "Classic Boule").status, "inactive");
    assert.equal(views.find(v => v.recipe.name === "Cream Cheese Frosting").status, "unmapped");

    // Each must be independently openable.
    sandbox.openRecipeDetail(1);
    assert.equal(elements.get("rcDetailName").textContent, "Classic Boule");
    sandbox.openRecipeDetail(10);
    assert.equal(elements.get("rcDetailName").textContent, "Cream Cheese Frosting");
});

/* ==========================================
   Search and filters
   ========================================== */

test("4. search filters the grid by name and updates the result count", async () => {
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadRecipeCardsData();

    elements.get("recipeCardsSearch").value = "cinnamon";
    sandbox.renderGrid();

    const html = elements.get("recipeCardsGrid").innerHTML;
    assert.match(html, /Cinnamon Rolls/);
    assert.doesNotMatch(html, /Classic Boule/);
    assert.match(elements.get("recipeCardsResultCount").textContent, /1 recipe shown of 6 total/);
});

test("5. category filter narrows to only that category", async () => {
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadRecipeCardsData();

    elements.get("recipeCardsCategoryFilter").value = "Bread";
    sandbox.renderGrid();

    const html = elements.get("recipeCardsGrid").innerHTML;
    assert.match(html, /Classic Boule/);
    assert.doesNotMatch(html, /S&#039;mores|Cinnamon Rolls|Cream Cheese/);
});

test("6. status filter narrows to only that derived status", async () => {
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadRecipeCardsData();

    elements.get("recipeCardsStatusFilter").value = "unmapped";
    sandbox.renderGrid();

    const html = elements.get("recipeCardsGrid").innerHTML;
    assert.match(html, /Cream Cheese Frosting/);
    assert.doesNotMatch(html, /S&#039;mores|Classic Boule|Cinnamon Rolls/);
});

/* ==========================================
   Ingredient order preservation
   ========================================== */

test("7. ingredient order is preserved exactly as stored (not alphabetized or reordered)", async () => {
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadRecipeCardsData();

    sandbox.openRecipeDetail(22);
    const html = elements.get("rcIngredientList").innerHTML;
    const names = smoresRecipe().recipe_ingredients.map(r => r.ingredients.name);

    let lastIndex = -1;
    names.forEach(name => {
        const idx = html.indexOf(name);
        assert.ok(idx > lastIndex, `${name} must appear after the previous ingredient in stored order`);
        lastIndex = idx;
    });
});

/* ==========================================
   Quantity/unit display exactness (Inventory-audit formatter)
   ========================================== */

test("8. whole gram values ending in zero are never truncated (680 stays 680, not 68)", async () => {
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadRecipeCardsData();
    sandbox.openRecipeDetail(22);

    const html = elements.get("rcIngredientList").innerHTML;
    assert.match(html, />680 g</);
    assert.doesNotMatch(html, />68 g</);
});

test("9. decimal quantities remain precise (0.05 g stays 0.05 g, not rounded away)", async () => {
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadRecipeCardsData();
    sandbox.openRecipeDetail(22);

    const html = elements.get("rcIngredientList").innerHTML;
    assert.match(html, />0\.05 g</);
});

test("10. a purchase-vs-recipe-unit mixup never occurs -- the ingredient's own recipe_unit is always shown, never a purchase unit", async () => {
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadRecipeCardsData();
    sandbox.openRecipeDetail(22);

    const html = elements.get("rcIngredientList").innerHTML;
    // Vanilla Extract's saved recipe_unit is mL -- must render as mL, not g or any other unit.
    assert.match(html, />10 mL</);
});

/* ==========================================
   Batch scaling -- 0.5x, 1x, 2x, 3x, custom
   ========================================== */

test("11. opening a recipe defaults to 1x every time", async () => {
    const { sandbox } = loadSandbox();
    await sandbox.__loadRecipeCardsData();
    sandbox.openRecipeDetail(22);
    assert.equal(sandbox.__getMultiplier(), 1);
});

test("12. each preset multiplier (0.5x, 1x, 2x, 3x) scales ingredient quantities correctly", async () => {
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadRecipeCardsData();
    sandbox.openRecipeDetail(22); // Chocolate Chips: 680 g base

    sandbox.setMultiplier(0.5);
    assert.match(elements.get("rcIngredientList").innerHTML, />340 g</);

    sandbox.setMultiplier(2);
    assert.match(elements.get("rcIngredientList").innerHTML, />1,360 g</);

    sandbox.setMultiplier(3);
    assert.match(elements.get("rcIngredientList").innerHTML, />2,040 g</);

    sandbox.setMultiplier(1);
    assert.match(elements.get("rcIngredientList").innerHTML, />680 g</);
});

test("13. a custom multiplier applies correctly and updates the scaled yield", async () => {
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadRecipeCardsData();
    sandbox.openRecipeDetail(22); // yield 12 item

    elements.get("rcCustomMultiplier").value = "1.5";
    sandbox.applyCustomMultiplier();

    assert.equal(sandbox.__getMultiplier(), 1.5);
    assert.match(elements.get("rcScaledYield").innerHTML, /18 item/);
    assert.match(elements.get("rcIngredientList").innerHTML, />1,020 g</); // 680 * 1.5
});

test("14. an invalid or zero custom multiplier shows validation instead of a nonsense quantity", async () => {
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadRecipeCardsData();
    sandbox.openRecipeDetail(22);

    elements.get("rcCustomMultiplier").value = "0";
    sandbox.applyCustomMultiplier();
    assert.equal(elements.get("rcScaleError").hidden, false);
    assert.equal(sandbox.__getMultiplier(), 1, "the multiplier must not change on an invalid entry");

    elements.get("rcCustomMultiplier").value = "-2";
    sandbox.applyCustomMultiplier();
    assert.equal(elements.get("rcScaleError").hidden, false);

    elements.get("rcCustomMultiplier").value = "not a number";
    sandbox.applyCustomMultiplier();
    assert.equal(elements.get("rcScaleError").hidden, false);
});

test("15. resetting to 1x reproduces the exact saved base values", async () => {
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadRecipeCardsData();
    sandbox.openRecipeDetail(22);

    sandbox.setMultiplier(3);
    assert.match(elements.get("rcIngredientList").innerHTML, />2,040 g</);

    sandbox.setMultiplier(1);
    const html = elements.get("rcIngredientList").innerHTML;
    assert.match(html, />680 g</);
    assert.match(html, />170 g</); // Butter, base value
    assert.match(html, />0\.05 g</); // Salt, base value
});

test("16. scaling never mutates the underlying recipe data", async () => {
    const { sandbox } = loadSandbox();
    await sandbox.__loadRecipeCardsData();
    sandbox.openRecipeDetail(22);

    const before = JSON.parse(JSON.stringify(sandbox.__getOpenView().recipe));
    sandbox.setMultiplier(3);
    sandbox.setMultiplier(0.5);
    const after = sandbox.__getOpenView().recipe;

    assert.deepEqual(after, before, "the base recipe object must be byte-for-byte unchanged after scaling");
});

/* ==========================================
   No mutation calls can ever originate from this page
   ========================================== */

test("17. loading, searching, filtering, opening, scaling, and printing never issue an insert/update/delete/upsert call", async () => {
    const { sandbox, elements, supabaseMock } = loadSandbox();
    await sandbox.__loadRecipeCardsData();

    elements.get("recipeCardsSearch").value = "cookie";
    sandbox.renderGrid();
    elements.get("recipeCardsCategoryFilter").value = "Cookie";
    sandbox.renderGrid();
    elements.get("recipeCardsStatusFilter").value = "active";
    sandbox.renderGrid();

    sandbox.openRecipeDetail(22);
    sandbox.setMultiplier(0.5);
    sandbox.setMultiplier(2);
    sandbox.setMultiplier(3);
    elements.get("rcCustomMultiplier").value = "1.75";
    sandbox.applyCustomMultiplier();
    sandbox.setMultiplier(1);

    sandbox.printOpenRecipe();
    sandbox.closeDetail();
    sandbox.printAllVisible();

    const mutationOps = supabaseMock.calls.filter(c => ["insert", "update", "upsert", "delete"].includes(c.op));
    assert.deepEqual(mutationOps, [], "no mutation call may ever originate from the Recipe Cards page");

    const tablesTouched = new Set(supabaseMock.calls.map(c => c.table));
    assert.deepEqual([...tablesTouched].sort(), ["menu_items", "recipes"], "only recipes and menu_items are ever read");
});

/* ==========================================
   Missing relationships produce visible warnings
   ========================================== */

test("18. a recipe with a missing ingredient reference and invalid yield shows visible warnings, not a silent hide", async () => {
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadRecipeCardsData();

    const banner = elements.get("recipeCardsWarningBanner");
    assert.equal(banner.hidden, false);
    assert.match(banner.innerHTML, /1 recipe has a data-quality note/);

    sandbox.openRecipeDetail(999);
    const warningsEl = elements.get("rcDetailWarnings");
    assert.equal(warningsEl.hidden, false);
    assert.match(warningsEl.innerHTML, /missing ingredient/);
    assert.match(warningsEl.innerHTML, /yield quantity is missing or invalid/);
    assert.match(warningsEl.innerHTML, /yield unit is missing/);
});

test("19. a recipe with no data-quality problems shows no warning block", async () => {
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadRecipeCardsData();
    sandbox.openRecipeDetail(22);
    assert.equal(elements.get("rcDetailWarnings").hidden, true);
});

test("20. an unmapped-but-valid recipe (Cream Cheese Frosting) shows its component usage instead of an alarming warning", async () => {
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadRecipeCardsData();
    sandbox.openRecipeDetail(10);

    assert.equal(elements.get("rcDetailWarnings").hidden, true, "a valid unmapped recipe must not itself carry a warning");
    assert.equal(elements.get("rcUsedInSection").hidden, false);
    assert.match(elements.get("rcUsedInText").textContent, /Cinnamon Rolls/);
});

/* ==========================================
   Notes / instructions
   ========================================== */

test("21. an existing recipe note is shown verbatim; a recipe with none shows the calm placeholder, never invented instructions", async () => {
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadRecipeCardsData();

    sandbox.openRecipeDetail(22);
    assert.match(elements.get("rcNotes").textContent, /Toast the marshmallow topping/);

    sandbox.openRecipeDetail(1); // Classic Boule has notes: null
    assert.equal(elements.get("rcNotes").textContent, "No preparation instructions have been saved for this recipe.");
});

/* ==========================================
   Printing
   ========================================== */

test("22. Print Recipe (one) populates #printArea with that recipe's ingredients and toggles the printing-one body class during print", async () => {
    const { sandbox, elements, bodyClasses, printCalls, afterPrintHandlers } = loadSandbox();
    await sandbox.__loadRecipeCardsData();
    sandbox.openRecipeDetail(22);
    sandbox.setMultiplier(2);

    sandbox.printOpenRecipe();

    assert.equal(printCalls.length, 1);
    assert.equal(bodyClasses.has("printing-one"), true);
    const printHtml = elements.get("printArea").innerHTML;
    assert.match(printHtml, /S&#039;mores Cookies|S'mores Cookies/);
    assert.match(printHtml, /2× batch/);
    assert.match(printHtml, />1,360 g</); // 680 * 2

    // afterprint cleanup must remove the class and clear the print area.
    afterPrintHandlers.forEach(h => h());
    assert.equal(bodyClasses.has("printing-one"), false);
    assert.equal(elements.get("printArea").innerHTML, "");
});

test("23. Print All Visible Recipes prints only the currently filtered set, each at the base (1x) recipe", async () => {
    const { sandbox, elements, bodyClasses } = loadSandbox();
    await sandbox.__loadRecipeCardsData();

    elements.get("recipeCardsCategoryFilter").value = "Bread";
    sandbox.renderGrid();

    sandbox.printAllVisible();

    assert.equal(bodyClasses.has("printing-all"), true);
    const printHtml = elements.get("printArea").innerHTML;
    assert.match(printHtml, /Classic Boule/);
    assert.doesNotMatch(printHtml, /S&#039;mores|Cinnamon Rolls|Cream Cheese/);
    assert.doesNotMatch(printHtml, /×\s*batch/, "the all-visible print must show the base recipe, never a scaled label");
});

/* ==========================================
   Authentication
   ========================================== */

test("24. requireAuth and setupLogout are called on load -- authentication is never bypassed", async () => {
    const { sandbox, getRequireAuthCalls, getSetupLogoutCalls } = loadSandbox();
    // Simulate the real DOMContentLoaded flow directly (the vm sandbox
    // doesn't fire real DOM events), matching this repo's established
    // pattern for these page-init tests.
    await sandbox.requireAuth();
    sandbox.setupLogout();
    assert.equal(getRequireAuthCalls(), 1);
    assert.equal(getSetupLogoutCalls(), 1);
});

/* ==========================================
   Deep link (?recipe=<id>)
   ========================================== */

test("25. a ?recipe=<id> URL opens that recipe's detail automatically", async () => {
    const { sandbox, elements } = loadSandbox();
    sandbox.window.location.search = "?recipe=10";
    await sandbox.__loadRecipeCardsData();
    sandbox.handleRecipeCardsDeepLink();

    assert.equal(elements.get("rcDetailName").textContent, "Cream Cheese Frosting");
});

/* ==========================================
   26+. Egg / Egg Yolk display wording and scaling
   ========================================== */

test("26. S'mores Cookies displays '4 Egg Yolks' at 1x -- correct plural, no redundant unit word", async () => {
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadRecipeCardsData();
    sandbox.openRecipeDetail(22);

    const html = elements.get("rcIngredientList").innerHTML;
    const collapsed = html.replace(/\s+/g, " ");
    assert.ok(collapsed.includes(">4</span><span class=\"rc-ingredient-name\">Egg Yolks<"), "expected " + ">4</span><span class=\"rc-ingredient-name\">Egg Yolks<");
    assert.doesNotMatch(collapsed, /4 each Egg Yolks/, "the redundant unit word must be omitted for count-unit ingredients");
});

test("27. canonical Cinnamon Rolls displays '1 Egg' and '1 Egg Yolk' at 1x (singular, grammatically correct)", async () => {
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadRecipeCardsData();
    sandbox.openRecipeDetail(9);

    const html = elements.get("rcIngredientList").innerHTML;
    const collapsed = html.replace(/\s+/g, " ");
    assert.ok(collapsed.includes(">1</span><span class=\"rc-ingredient-name\">Egg<"), "expected " + ">1</span><span class=\"rc-ingredient-name\">Egg<");
    assert.ok(collapsed.includes(">1</span><span class=\"rc-ingredient-name\">Egg Yolk<"), "expected " + ">1</span><span class=\"rc-ingredient-name\">Egg Yolk<");
    assert.doesNotMatch(collapsed, /1 Eggs</, "must never show the plural at quantity 1");
});

test("28. a 2x cookie recipe containing Egg Yolks scales the displayed quantity correctly (4 Egg Yolks -> 8 Egg Yolks)", async () => {
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadRecipeCardsData();
    sandbox.openRecipeDetail(22);
    sandbox.setMultiplier(2);

    const html = elements.get("rcIngredientList").innerHTML;
    const collapsed = html.replace(/\s+/g, " ");
    assert.ok(collapsed.includes(">8</span><span class=\"rc-ingredient-name\">Egg Yolks<"), "expected " + ">8</span><span class=\"rc-ingredient-name\">Egg Yolks<");
});

test("29. a 2x Cinnamon Rolls recipe displays '2 Eggs' and '2 Egg Yolks' (both pluralize correctly together)", async () => {
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadRecipeCardsData();
    sandbox.openRecipeDetail(9);
    sandbox.setMultiplier(2);

    const html = elements.get("rcIngredientList").innerHTML;
    const collapsed = html.replace(/\s+/g, " ");
    assert.ok(collapsed.includes(">2</span><span class=\"rc-ingredient-name\">Eggs<"), "expected " + ">2</span><span class=\"rc-ingredient-name\">Eggs<");
    assert.ok(collapsed.includes(">2</span><span class=\"rc-ingredient-name\">Egg Yolks<"), "expected " + ">2</span><span class=\"rc-ingredient-name\">Egg Yolks<");

    // Scaling is display-only -- the underlying stored recipe must be
    // completely unaffected.
    const eggRow = sandbox.__getOpenView().recipe.recipe_ingredients.find(r => r.ingredients.name === "Eggs");
    const yolkRow = sandbox.__getOpenView().recipe.recipe_ingredients.find(r => r.ingredients.name === "Egg Yolks");
    assert.equal(eggRow.quantity, 1);
    assert.equal(yolkRow.quantity, 1);

    // Resetting to 1x reproduces the exact base display.
    sandbox.setMultiplier(1);
    const backToBase = elements.get("rcIngredientList").innerHTML.replace(/\s+/g, " ");
    assert.ok(backToBase.includes(">1</span><span class=\"rc-ingredient-name\">Egg<"), "expected " + ">1</span><span class=\"rc-ingredient-name\">Egg<");
    assert.ok(backToBase.includes(">1</span><span class=\"rc-ingredient-name\">Egg Yolk<"), "expected " + ">1</span><span class=\"rc-ingredient-name\">Egg Yolk<");
});

test("30. Classic Brownies keeps whole Eggs unaffected, at any scale ('5 Eggs' at 1x, '10 Eggs' at 2x, never Egg Yolks)", async () => {
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadRecipeCardsData();
    sandbox.openRecipeDetail(21);

    let html = elements.get("rcIngredientList").innerHTML.replace(/\s+/g, " ");
    assert.ok(html.includes(">5</span><span class=\"rc-ingredient-name\">Eggs<"), "expected " + ">5</span><span class=\"rc-ingredient-name\">Eggs<");
    assert.doesNotMatch(html, /Egg Yolk/);

    sandbox.setMultiplier(2);
    html = elements.get("rcIngredientList").innerHTML.replace(/\s+/g, " ");
    assert.ok(html.includes(">10</span><span class=\"rc-ingredient-name\">Eggs<"), "expected " + ">10</span><span class=\"rc-ingredient-name\">Eggs<");
});

test("31. printing a recipe with Egg/Egg Yolk ingredients shows the same correct wording as the on-screen detail", async () => {
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadRecipeCardsData();
    sandbox.openRecipeDetail(9);

    sandbox.printOpenRecipe();
    const printHtml = elements.get("printArea").innerHTML.replace(/\s+/g, " ");
    assert.ok(printHtml.includes(">1</span><span class=\"rc-ingredient-name\">Egg<"), "expected " + ">1</span><span class=\"rc-ingredient-name\">Egg<");
    assert.ok(printHtml.includes(">1</span><span class=\"rc-ingredient-name\">Egg Yolk<"), "expected " + ">1</span><span class=\"rc-ingredient-name\">Egg Yolk<");
});
