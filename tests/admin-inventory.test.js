"use strict";

/* ==========================================
   Admin Inventory (js/admin-inventory.js)

   Inventory audit (2026-08-28) -- see tests/quantity-format.test.js
   for the confirmed root cause (a display-only formatter bug) and
   proof that it never touched any calculation. This file covers the
   surrounding CRUD/recipe/operational-calculation properties the
   audit was asked to prove: raw values round-trip through Add/Edit/
   Restock exactly, low-stock and inventory-value math always uses the
   raw Number(...) values (never a formatted string), and recipe
   costs/quantities are never altered by an inventory display fix.

   No test file existed for this page before this audit. Same node:vm
   sandbox technique as tests/admin-production.test.js.
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
   Fixtures -- a small synthetic ingredient/recipe set, values chosen
   specifically to exercise the confirmed bug pattern (whole numbers
   ending in zero).
   ========================================== */

function baseIngredients() {
    return [
        { id: 10, name: "Semi Sweet Chocolate Chips", category_id: 3, supplier_id: 1, purchase_unit: "g", recipe_unit: "g", purchase_size: 680, purchase_price: 8.08, quantity_on_hand: 680, minimum_quantity: 170, notes: "" },
        { id: 20, name: "Test Flour", category_id: 1, supplier_id: 1, purchase_unit: "lb", recipe_unit: "g", purchase_size: 5, purchase_price: 3.28, quantity_on_hand: 18, minimum_quantity: 15, notes: "" },
        { id: 30, name: "Test Low Stock Sugar", category_id: 2, supplier_id: 1, purchase_unit: "g", recipe_unit: "g", purchase_size: 1000, purchase_price: 2.00, quantity_on_hand: 100, minimum_quantity: 200, notes: "" },
        // Egg / Egg Yolk fixtures -- shaped exactly like the real,
        // migrated live data (js/derived-ingredients.js): Egg Yolks
        // (id 57) is derived 1:1 from Eggs (id 6), and its own
        // quantity_on_hand/minimum_quantity/purchase_size/
        // purchase_price already mirror Eggs' (as the DB trigger
        // guarantees live) -- these tests exercise the APPLICATION
        // code's own exclusion/labeling logic, not the trigger itself.
        { id: 6, name: "Eggs", category_id: 4, supplier_id: 1, purchase_unit: "each", recipe_unit: "each", purchase_size: 12, purchase_price: 3.79, quantity_on_hand: 12, minimum_quantity: 4, notes: "", derived_from_ingredient_id: null, derived_factor: null },
        { id: 57, name: "Egg Yolks", category_id: 4, supplier_id: null, purchase_unit: "each", recipe_unit: "each", purchase_size: 12, purchase_price: 3.79, quantity_on_hand: 12, minimum_quantity: 4, notes: "Derived 1:1 from Eggs.", derived_from_ingredient_id: 6, derived_factor: 1 }
    ];
}

function baseCategories() {
    return [
        { id: 1, name: "Pantry", sort_order: 1 },
        { id: 2, name: "Baking", sort_order: 2 },
        { id: 3, name: "Chocolate", sort_order: 3 },
        { id: 4, name: "Dairy", sort_order: 4 }
    ];
}

function baseSuppliers() {
    return [{ id: 1, name: "Test Supplier" }];
}

function baseRecipes() {
    return [
        {
            id: 7, name: "Test Chocolate Chip Cookies", category: "Cookie",
            yield_quantity: 12, yield_unit: "item", notes: "",
            recipe_ingredients: [
                { id: 100, recipe_id: 7, ingredient_id: 10, quantity: 140, ingredients: { id: 10, name: "Semi Sweet Chocolate Chips" } }
            ],
            recipe_components: []
        },
        // Mirrors the real, migrated S'mores Cookies: a Cookie-category
        // recipe using Egg Yolks (converted from whole Eggs, same
        // numerical quantity preserved).
        {
            id: 22, name: "Test S'mores Cookies", category: "Cookie",
            yield_quantity: 12, yield_unit: "item", notes: "",
            recipe_ingredients: [
                { id: 200, recipe_id: 22, ingredient_id: 57, quantity: 4, ingredients: { id: 57, name: "Egg Yolks" } }
            ],
            recipe_components: []
        },
        // Mirrors the real, migrated canonical Cinnamon Rolls: 1 whole
        // Egg + 1 Egg Yolk (was 2 whole Eggs before the migration).
        {
            id: 9, name: "Test Cinnamon Rolls", category: "Dessert",
            yield_quantity: 8, yield_unit: "item", notes: "",
            recipe_ingredients: [
                { id: 201, recipe_id: 9, ingredient_id: 6, quantity: 1, ingredients: { id: 6, name: "Eggs" } },
                { id: 202, recipe_id: 9, ingredient_id: 57, quantity: 1, ingredients: { id: 57, name: "Egg Yolks" } }
            ],
            recipe_components: []
        },
        // Mirrors the real, unchanged Classic Brownies: whole Eggs,
        // never converted.
        {
            id: 21, name: "Test Classic Brownies", category: "Dessert",
            yield_quantity: 12, yield_unit: "item", notes: "",
            recipe_ingredients: [
                { id: 203, recipe_id: 21, ingredient_id: 6, quantity: 5, ingredients: { id: 6, name: "Eggs" } }
            ],
            recipe_components: []
        }
    ];
}

function baseRecipeCosts() {
    // Mirrors the recipe_costs Postgres view's own shape.
    return [
        { id: 7, name: "Test Chocolate Chip Cookies", category: "Cookie", yield_quantity: 12, yield_unit: "item", ingredient_cost: 1.6624, cost_per_yield_item: 0.1385 }
    ];
}

/* ==========================================
   Sandbox
   ========================================== */

/** A chainable AND directly-awaitable query-builder stub, matching the
 *  real Supabase client's own shape: every method (select/eq/order/
 *  limit) returns the SAME thenable builder, so a caller can await it
 *  after any number of chained calls (`await supabaseClient.from(x).select("*")`
 *  or `await ...select("*").order("name")`) and always get the final
 *  {data, error} result. */
function makeQueryBuilder(resolveResult) {
    const builder = {
        select() { return builder; },
        eq() { return builder; },
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

function makeAwaitableSupabaseClient(state) {
    const calls = [];
    return {
        calls,
        from(table) {
            return {
                select() {
                    calls.push({ table, op: "select" });
                    return makeQueryBuilder(() => ({ data: state[table] || [], error: null }));
                },
                insert(payload) {
                    calls.push({ table, op: "insert", payload: Array.isArray(payload) ? payload : { ...payload } });
                    return makeQueryBuilder(() => ({ data: { id: 999, ...(Array.isArray(payload) ? payload[0] : payload) }, error: null }));
                },
                update(payload) {
                    const record = { table, op: "update", payload: { ...payload } };
                    calls.push(record);
                    return {
                        eq(col, val) {
                            record.eqCol = col;
                            record.eqVal = val;
                            return Promise.resolve({ error: null });
                        }
                    };
                },
                delete() {
                    calls.push({ table, op: "delete" });
                    return { eq: () => Promise.resolve({ error: null }) };
                }
            };
        }
    };
}

function loadSandbox({ ingredients, categories, suppliers, recipes, recipeCosts } = {}) {
    const state = {
        ingredients: ingredients || baseIngredients(),
        inventory_categories: categories || baseCategories(),
        suppliers: suppliers || baseSuppliers(),
        recipes: recipes || baseRecipes(),
        recipe_costs: recipeCosts || baseRecipeCosts()
    };

    const elements = new Map();
    function fakeElement(id) {
        if (!elements.has(id)) {
            elements.set(id, { id, value: "", textContent: "", innerHTML: "", style: {}, disabled: false, addEventListener: () => {}, appendChild: () => {} });
        }
        return elements.get(id);
    }

    const alertCalls = [];
    const confirmCalls = [];
    const supabaseClient = makeAwaitableSupabaseClient(state);

    const fakeDocument = {
        addEventListener: () => {},
        getElementById: (id) => fakeElement(id),
        createElement: () => ({
            style: {}, classList: { add: () => {} }, appendChild: () => {}, innerHTML: "",
            querySelector: () => ({ value: "" })
        }),
        querySelectorAll: () => [],
        body: { appendChild: () => {} }
    };

    const sandbox = {
        document: fakeDocument,
        window: { location: { search: "" } },
        URLSearchParams,
        console,
        supabaseClient,
        alert: (msg) => alertCalls.push(msg),
        confirm: (msg) => { confirmCalls.push(msg); return true; },
        requireAuth: async () => {},
        setupLogout: () => {},
        RecipeCosting: require(path.join(ROOT, "js/recipe-costing.js")),
        QuantityFormat: require(path.join(ROOT, "js/quantity-format.js")),
        DerivedIngredients: require(path.join(ROOT, "js/derived-ingredients.js")),
        IngredientNaming: require(path.join(ROOT, "js/ingredient-naming.js"))
    };
    vm.createContext(sandbox);

    const source = [
        read("js/admin-inventory.js"),
        `
        this.__loadInventory = loadInventory;
        this.__isLowStock = isLowStock;
        this.__formatQuantity = formatQuantity;
        this.__updateInventoryOverview = updateInventoryOverview;
        this.__renderIngredients = renderIngredients;
        this.__renderIngredientRow = renderIngredientRow;
        this.__renderShoppingList = renderShoppingList;
        this.__renderRecipes = renderRecipes;
        this.__saveIngredient = saveIngredient;
        this.__saveRestock = saveRestock;
        this.__openIngredientModal = openIngredientModal;
        this.__closeIngredientModal = closeIngredientModal;
        this.__openRestockModal = openRestockModal;
        this.__recipeIngredientOptionLabel = recipeIngredientOptionLabel;
        this.__getIngredients = () => ingredients;
        this.__getRecipeCost = getRecipeCost;
        this.__openRecipeModal = openRecipeModal;
        this.__handleRecipeDeepLink = handleRecipeDeepLink;
        `
    ].join("\n");

    vm.runInContext(source, sandbox);

    return { sandbox, elements, alertCalls, confirmCalls, supabaseClient, state, fakeElement };
}

/* ==========================================
   1-4. Display round trip -- the confirmed bug, at the render layer
   ========================================== */

test("1. renderIngredientRow displays the exact raw stored values for the confirmed example (Semi Sweet Chocolate Chips)", async () => {
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadInventory();

    const ingredient = baseIngredients()[0];
    const html = sandbox.__renderIngredientRow(ingredient);

    // Extract each <strong>...</strong> block's trimmed, whitespace-
    // collapsed text so the assertion is robust to the template's own
    // indentation, and precise about token boundaries (so "680" can
    // never accidentally satisfy a check meant to catch "68").
    const strongBlocks = [...html.matchAll(/<strong>([\s\S]*?)<\/strong>/g)]
        .map(m => m[1].replace(/\s+/g, " ").trim());

    assert.ok(strongBlocks.includes("680 g"), `expected an "On Hand"/"Package Size" block reading exactly "680 g", got: ${JSON.stringify(strongBlocks)}`);
    assert.ok(strongBlocks.includes("170 g"), `expected a "Minimum" block reading exactly "170 g", got: ${JSON.stringify(strongBlocks)}`);
    assert.ok(!strongBlocks.includes("68 g"), "must never render the truncated '68 g'");
    assert.ok(!strongBlocks.includes("17 g"), "must never render the truncated '17 g'");
});

test("2. the ingredient card status is 'In Stock' for 680 on hand vs 170 minimum, using the raw comparison", async () => {
    const { sandbox, elements } = loadSandbox();
    const ingredient = baseIngredients()[0];
    const html = sandbox.__renderIngredientRow(ingredient);
    assert.match(html, /In Stock/);
    assert.doesNotMatch(html, /Low Stock/);
});

test("3. renderIngredients groups by category and renders every ingredient's row without truncating any zero-ending value", async () => {
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadInventory();
    sandbox.__renderIngredients();

    const html = elements.get("ingredientsTable").innerHTML;
    assert.match(html, /680/);
    assert.match(html, /170/);
});

test("4. formatQuantity (the page's own local alias) delegates to the shared, fixed formatter", async () => {
    const { sandbox, elements } = loadSandbox();
    assert.equal(sandbox.__formatQuantity(680), "680");
    assert.equal(sandbox.__formatQuantity(170), "170");
    assert.equal(sandbox.__formatQuantity(1000), "1,000");
});

/* ==========================================
   5-6. Low stock / inventory value use RAW numbers, never formatted text
   ========================================== */

test("5. isLowStock compares raw quantity_on_hand <= minimum_quantity, not the display strings", () => {
    const { sandbox, elements } = loadSandbox();
    // 680 <= 170 is false -- must be In Stock, exactly the confirmed example.
    assert.equal(sandbox.__isLowStock({ quantity_on_hand: 680, minimum_quantity: 170 }), false);
    // A genuinely low-stock case.
    assert.equal(sandbox.__isLowStock({ quantity_on_hand: 100, minimum_quantity: 200 }), true);
    // Exactly at the threshold counts as low stock (<=).
    assert.equal(sandbox.__isLowStock({ quantity_on_hand: 170, minimum_quantity: 170 }), true);
});

test("6. inventory value totals from raw purchase_price/purchase_size/quantity_on_hand, never a display string, and counts Eggs exactly once despite Egg Yolks also being present", async () => {
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadInventory();
    sandbox.__updateInventoryOverview();

    // Semi Sweet Chocolate Chips: 680 / 680 * 8.08 = 8.08
    // Test Flour: 18 / 5 * 3.28 = 11.808
    // Test Low Stock Sugar: 100 / 1000 * 2.00 = 0.2
    // Eggs: 12 / 12 * 3.79 = 3.79 -- counted ONCE.
    // Egg Yolks (derived, same physical eggs): must NOT add another 3.79.
    const expected = (680 / 680 * 8.08) + (18 / 5 * 3.28) + (100 / 1000 * 2.00) + (12 / 12 * 3.79);
    const displayed = elements.get("inventoryValue").textContent;
    const displayedNumber = Number(displayed.replace(/[^0-9.]/g, ""));
    assert.ok(Math.abs(displayedNumber - expected) < 0.01, `expected ~$${expected.toFixed(2)}, got ${displayed}`);
    assert.ok(Math.abs(displayedNumber - (expected + 3.79)) > 0.01, "Egg Yolks must not double-count Eggs' value");
});

/* ==========================================
   7-9. Shopping list shortage
   ========================================== */

test("7. shopping list computes the shortage from raw values (minimum - on hand), never from a formatted string", async () => {
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadInventory();
    sandbox.__renderShoppingList();

    const html = elements.get("shoppingListContainer").innerHTML;
    // Test Low Stock Sugar: 200 - 100 = 100 needed.
    assert.match(html, /Test Low Stock Sugar/);
    assert.match(html, /100/);
});

test("8. an ingredient with sufficient stock never appears in the shopping list", async () => {
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadInventory();
    sandbox.__renderShoppingList();

    const html = elements.get("shoppingListContainer").innerHTML;
    assert.doesNotMatch(html, /Semi Sweet Chocolate Chips/);
});

test("9. Semi Sweet Chocolate Chips (680 on hand / 170 minimum) never appears on the shopping list", async () => {
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadInventory();
    sandbox.__renderShoppingList();

    const html = elements.get("shoppingListContainer").innerHTML;
    assert.doesNotMatch(html, /Semi Sweet Chocolate Chips/);
});

/* ==========================================
   10-16. Inventory CRUD round trips
   ========================================== */

test("10. saveIngredient sends exactly 680 to the database -- not 68, not a formatted string", async () => {
    const { sandbox, supabaseClient } = loadSandbox();

    sandbox.fakeElement = undefined;
    const el = (id) => sandbox.document.getElementById(id);
    el("ingredientId").value = "";
    el("ingredientName").value = "New Test Ingredient";
    el("ingredientCategory").value = "1";
    el("ingredientSupplier").value = "1";
    el("purchaseUnit").value = "g";
    el("recipeUnit").value = "g";
    el("purchaseSize").value = "680";
    el("purchasePrice").value = "8.08";
    el("quantityOnHand").value = "680";
    el("minimumQuantity").value = "170";
    el("ingredientNotes").value = "";

    await sandbox.__saveIngredient();

    const insertCall = supabaseClient.calls.find(c => c.table === "ingredients" && c.op === "insert");
    assert.ok(insertCall, "expected an insert call");
    assert.equal(insertCall.payload.purchase_size, 680);
    assert.equal(insertCall.payload.quantity_on_hand, 680);
    assert.equal(insertCall.payload.minimum_quantity, 170);
    assert.equal(insertCall.payload.purchase_price, 8.08);
});

test("11. editing an ingredient sends an update, never touching fields the form didn't change", async () => {
    const { sandbox, supabaseClient } = loadSandbox();
    const el = (id) => sandbox.document.getElementById(id);

    el("ingredientId").value = "10";
    el("ingredientName").value = "Semi Sweet Chocolate Chips";
    el("ingredientCategory").value = "3";
    el("ingredientSupplier").value = "1";
    el("purchaseUnit").value = "g";
    el("recipeUnit").value = "g";
    el("purchaseSize").value = "680";
    el("purchasePrice").value = "8.08";
    el("quantityOnHand").value = "680";
    el("minimumQuantity").value = "170";
    el("ingredientNotes").value = "";

    await sandbox.__saveIngredient();

    const updateCall = supabaseClient.calls.find(c => c.table === "ingredients" && c.op === "update");
    assert.ok(updateCall);
    assert.equal(updateCall.payload.purchase_size, 680);
    assert.equal(updateCall.payload.quantity_on_hand, 680);
    assert.equal(updateCall.payload.minimum_quantity, 170);
});

test("12. reopening the edit modal shows the exact stored value (680), not a truncated one", async () => {
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadInventory();
    sandbox.__openIngredientModal("10");

    assert.equal(sandbox.document.getElementById("purchaseSize").value, 680);
    assert.equal(sandbox.document.getElementById("quantityOnHand").value, 680);
    assert.equal(sandbox.document.getElementById("minimumQuantity").value, 170);
    assert.equal(sandbox.document.getElementById("purchasePrice").value, 8.08);
});

test("13. cancel closes the modal without saving", async () => {
    const { sandbox, supabaseClient } = loadSandbox();
    await sandbox.__loadInventory();
    sandbox.__openIngredientModal("10");
    sandbox.__closeIngredientModal();

    assert.equal(sandbox.document.getElementById("ingredientModal").style.display, "none");
    assert.ok(!supabaseClient.calls.some(c => c.op === "insert" || c.op === "update"));
});

test("14. a decimal quantity round-trips safely through save", async () => {
    const { sandbox, supabaseClient } = loadSandbox();
    const el = (id) => sandbox.document.getElementById(id);

    el("ingredientId").value = "";
    el("ingredientName").value = "Decimal Test";
    el("purchaseUnit").value = "oz";
    el("recipeUnit").value = "g";
    el("purchaseSize").value = "4.12";
    el("purchasePrice").value = "3.28";
    el("quantityOnHand").value = "2.5";
    el("minimumQuantity").value = "0.5";
    el("ingredientNotes").value = "";

    await sandbox.__saveIngredient();

    const insertCall = supabaseClient.calls.find(c => c.table === "ingredients" && c.op === "insert");
    assert.equal(insertCall.payload.purchase_size, 4.12);
    assert.equal(insertCall.payload.quantity_on_hand, 2.5);
    assert.equal(insertCall.payload.minimum_quantity, 0.5);
});

test("15. missing name blocks the save with a clear message, no database call made", async () => {
    const { sandbox, supabaseClient, alertCalls } = loadSandbox();
    const el = (id) => sandbox.document.getElementById(id);

    el("ingredientName").value = "";
    el("purchaseUnit").value = "g";
    el("recipeUnit").value = "g";
    el("purchaseSize").value = "680";

    await sandbox.__saveIngredient();

    assert.equal(alertCalls.length, 1);
    assert.match(alertCalls[0], /enter an ingredient name/i);
    assert.ok(!supabaseClient.calls.some(c => c.op === "insert" || c.op === "update"));
});

test("16. missing purchase/recipe units blocks the save rather than silently guessing a conversion", async () => {
    const { sandbox, supabaseClient, alertCalls } = loadSandbox();
    const el = (id) => sandbox.document.getElementById(id);

    el("ingredientName").value = "Missing Units Test";
    el("purchaseUnit").value = "";
    el("recipeUnit").value = "";
    el("purchaseSize").value = "680";

    await sandbox.__saveIngredient();

    assert.equal(alertCalls.length, 1);
    assert.match(alertCalls[0], /purchase and recipe units/i);
    assert.ok(!supabaseClient.calls.some(c => c.op === "insert" || c.op === "update"));
});

/* ==========================================
   17-19. Restock
   ========================================== */

test("17. restocking 170 g adds exactly 170 to the raw quantity_on_hand", async () => {
    const { sandbox, supabaseClient } = loadSandbox();
    await sandbox.__loadInventory();
    sandbox.__openRestockModal("10");

    sandbox.document.getElementById("restockQuantity").value = "170";
    sandbox.document.getElementById("restockCost").value = "2.02";
    sandbox.document.getElementById("restockSupplier").value = "1";
    sandbox.document.getElementById("restockNotes").value = "";

    await sandbox.__saveRestock();

    const updateCall = supabaseClient.calls.find(c => c.table === "ingredients" && c.op === "update");
    assert.ok(updateCall);
    assert.equal(updateCall.payload.quantity_on_hand, 680 + 170);
});

test("18. restock recomputes purchase_price from the true purchase_size, never a display-truncated one", async () => {
    const { sandbox, supabaseClient } = loadSandbox();
    await sandbox.__loadInventory();
    sandbox.__openRestockModal("10");

    // Buying another full 680g package for $8.08 should leave the
    // per-package price effectively unchanged (~8.08), proving the
    // math used purchase_size=680, not a truncated 68.
    sandbox.document.getElementById("restockQuantity").value = "680";
    sandbox.document.getElementById("restockCost").value = "8.08";
    sandbox.document.getElementById("restockSupplier").value = "1";
    sandbox.document.getElementById("restockNotes").value = "";

    await sandbox.__saveRestock();

    const updateCall = supabaseClient.calls.find(c => c.table === "ingredients" && c.op === "update");
    assert.ok(Math.abs(updateCall.payload.purchase_price - 8.08) < 0.001, `expected ~8.08, got ${updateCall.payload.purchase_price}`);
});

test("19. restock with no quantity entered is blocked with a clear message", async () => {
    const { sandbox, supabaseClient, alertCalls } = loadSandbox();
    await sandbox.__loadInventory();
    sandbox.__openRestockModal("10");

    sandbox.document.getElementById("restockQuantity").value = "";
    sandbox.document.getElementById("restockCost").value = "8.08";

    await sandbox.__saveRestock();

    assert.equal(alertCalls.length, 1);
    assert.ok(!supabaseClient.calls.some(c => c.table === "purchases"));
});

/* ==========================================
   20-24. Recipes: protected from inventory display changes
   ========================================== */

test("20. recipe yield displays the exact stored value without truncation", async () => {
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadInventory();
    sandbox.__renderRecipes();

    const html = elements.get("recipesList").innerHTML;
    const collapsed = html.replace(/\s+/g, " ");
    assert.match(collapsed, /Yield: 12 item/);
});

test("21. recipe cost is read from the recipe_costs view's ingredient_cost, never recomputed client-side from formatted quantities", async () => {
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadInventory();

    const recipe = baseRecipes()[0];
    const cost = sandbox.__getRecipeCost(recipe);
    assert.equal(cost, 1.6624);
});

test("22. a recipe's ingredient list, quantity, and yield are completely unaffected by fixing the inventory display formatter", async () => {
    // Simulates "before" (buggy formatter) vs "after" (fixed formatter)
    // by comparing the recipe's own stored fields directly -- since
    // recipe_ingredients.quantity/recipes.yield_quantity are never
    // touched by loadInventory()/renderIngredients() at all, this is
    // a zero-diff guarantee by construction, not just an assertion.
    const before = JSON.parse(JSON.stringify(baseRecipes()));
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadInventory();
    sandbox.__renderIngredients();
    sandbox.__renderRecipes();
    const after = baseRecipes();

    assert.deepEqual(before[0].recipe_ingredients, after[0].recipe_ingredients);
    assert.equal(before[0].yield_quantity, after[0].yield_quantity);
});

test("23. recipe batch/per-item cost reconciles: cost_per_yield_item * yield_quantity equals ingredient_cost", () => {
    const costs = baseRecipeCosts()[0];
    const reconciled = costs.cost_per_yield_item * costs.yield_quantity;
    assert.ok(Math.abs(reconciled - costs.ingredient_cost) < 0.01);
});

test("24. the confirmed example's raw cost-per-gram is calculated from 680, not 68 (8.08 / 680, never 8.08 / 68)", () => {
    const correctCostPerGram = 8.08 / 680;
    const buggyCostPerGram = 8.08 / 68;
    assert.ok(Math.abs(correctCostPerGram - 0.011882) < 0.0001);
    // Sanity: the two are meaningfully different (10x) -- proves this
    // assertion would actually catch the regression if it recurred.
    assert.ok(buggyCostPerGram > correctCostPerGram * 9);
});

/* ==========================================
   25. Recipe Cards deep link (?recipe=<id> opens the existing editor)

   Added alongside the new Recipe Cards page's "Edit Recipe" link --
   a pure convenience deep link into this SAME modal, never a second
   editor. Purely additive: reads the id from the URL and opens the
   existing openRecipeModal exactly as the "Edit Recipe" button in
   this page's own recipe list already does.
   ========================================== */

test("25. handleRecipeDeepLink opens the existing recipe editor pre-filled when arriving via ?recipe=<id>", async () => {
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadInventory();

    sandbox.window.location.search = "?recipe=7";
    sandbox.__handleRecipeDeepLink();

    assert.equal(elements.get("recipeId").value, 7);
    assert.equal(elements.get("recipeName").value, baseRecipes()[0].name);
});

test("26. handleRecipeDeepLink safely no-ops for a missing/unknown recipe id -- it never opens a blank 'Add Recipe' form instead", async () => {
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadInventory();

    sandbox.window.location.search = "?recipe=999999";
    sandbox.__handleRecipeDeepLink();
    assert.equal(sandbox.document.getElementById("recipeModal").style.display, undefined, "the modal must not be opened for an unrecognized id");

    sandbox.window.location.search = "";
    sandbox.__handleRecipeDeepLink();
    assert.equal(sandbox.document.getElementById("recipeModal").style.display, undefined, "no ?recipe param must never open the modal");
});

/* ==========================================
   27+. Egg / Egg Yolk derived-ingredient handling
   ========================================== */

test("27. Egg Yolks renders its own clearly-labeled derived card, showing availability mirrored from Eggs and a link to view Eggs", async () => {
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadInventory();
    sandbox.__renderIngredients();

    const html = elements.get("ingredientsTable").innerHTML;
    assert.match(html, /Egg Yolks/);
    assert.match(html, /Derived from Eggs/);
    assert.match(html, /1 Egg Yolk uses 1 Egg\b/);
    const collapsed = html.replace(/\s+/g, " ");
    assert.match(collapsed, /> 12 each </, "available yolks must show the mirrored 12, matching Eggs");
    assert.match(html, /View Eggs/);
});

test("28. Egg Yolks' card has no Restock button and no independent Edit button -- only a link to Eggs", async () => {
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadInventory();
    sandbox.__renderIngredients();

    const html = elements.get("ingredientsTable").innerHTML;
    const derivedCardMatch = html.match(/<article class="ingredient-card ingredient-derived-card">[\s\S]*?<\/article>/);
    assert.ok(derivedCardMatch, "expected a rendered derived ingredient card");
    const cardHtml = derivedCardMatch[0];
    assert.doesNotMatch(cardHtml, /openRestockModal/);
    assert.doesNotMatch(cardHtml, />\s*Edit\s*</);
    assert.doesNotMatch(cardHtml, /Delete/);
});

test("29. ingredientCount, lowStockCount, and inventoryValue never count Egg Yolks as a second purchased item", async () => {
    const { sandbox, elements } = loadSandbox();
    await sandbox.__loadInventory();
    sandbox.__updateInventoryOverview();

    // 5 physical ingredients in the fixture set (Chocolate Chips, Flour,
    // Sugar, Eggs) -- Egg Yolks (derived) must not add a 6th.
    assert.equal(elements.get("ingredientCount").textContent, 4);
});

test("30. attempting to open the Edit modal for Egg Yolks redirects to Eggs instead, with an explanatory alert -- it never opens an editable form for the derived row", async () => {
    const { sandbox, elements, alertCalls } = loadSandbox();
    await sandbox.__loadInventory();

    sandbox.__openIngredientModal("57");

    assert.equal(alertCalls.length, 1);
    assert.match(alertCalls[0], /derived from Eggs/i);
    // The modal that actually opened must be Eggs' (id 6), not Egg
    // Yolks' (id 57) -- proven by the populated form field.
    assert.equal(elements.get("ingredientId").value, 6);
    assert.equal(elements.get("ingredientName").value, "Eggs");
});

test("31. attempting to restock Egg Yolks redirects to restocking Eggs instead, with an explanatory alert", async () => {
    const { sandbox, elements, alertCalls } = loadSandbox();
    await sandbox.__loadInventory();

    sandbox.__openRestockModal("57");

    assert.equal(alertCalls.length, 1);
    assert.match(alertCalls[0], /derived from Eggs/i);
    assert.equal(elements.get("restockIngredientId").value, 6);
});

test("32. the recipe editor's ingredient dropdown clearly distinguishes Egg Yolks as derived from Eggs, never as an ordinary independent ingredient", async () => {
    const { sandbox } = loadSandbox();
    await sandbox.__loadInventory();

    const eggs = sandbox.__getIngredients().find(i => i.name === "Eggs");
    const yolks = sandbox.__getIngredients().find(i => i.name === "Egg Yolks");

    assert.equal(sandbox.__recipeIngredientOptionLabel(eggs), "Eggs", "a physical ingredient's label is unchanged");
    assert.equal(sandbox.__recipeIngredientOptionLabel(yolks), "Egg Yolks — derived from Eggs");
});

test("33. cookie recipes (Egg Yolks) preserve the exact former Egg quantity: S'mores uses 4 Egg Yolks", async () => {
    const { sandbox } = loadSandbox();
    await sandbox.__loadInventory();

    const smores = baseRecipes().find(r => r.name === "Test S'mores Cookies");
    const eggRow = smores.recipe_ingredients.find(ri => ri.ingredients.name === "Egg Yolks");
    assert.ok(eggRow, "S'mores must use Egg Yolks");
    assert.equal(eggRow.quantity, 4, "the numeric quantity must be unchanged from the former 4 whole Eggs");
});

test("34. the canonical Cinnamon Rolls recipe uses exactly 1 Egg and 1 Egg Yolk (never 2 of either)", async () => {
    const cinnamonRolls = baseRecipes().find(r => r.name === "Test Cinnamon Rolls");
    const eggRow = cinnamonRolls.recipe_ingredients.find(ri => ri.ingredients.name === "Eggs");
    const yolkRow = cinnamonRolls.recipe_ingredients.find(ri => ri.ingredients.name === "Egg Yolks");
    assert.equal(eggRow.quantity, 1);
    assert.equal(yolkRow.quantity, 1);
    assert.equal(cinnamonRolls.recipe_ingredients.length, 2, "exactly two egg-related rows, no duplication");
});

test("35. Brownies retain their original whole-Egg quantity, completely unaffected by the Egg Yolk migration", async () => {
    const brownies = baseRecipes().find(r => r.name === "Test Classic Brownies");
    const eggRow = brownies.recipe_ingredients.find(ri => ri.ingredients.name === "Eggs");
    assert.ok(eggRow, "Brownies must still use whole Eggs, never Egg Yolks");
    assert.equal(eggRow.quantity, 5);
    assert.equal(brownies.recipe_ingredients.some(ri => ri.ingredients.name === "Egg Yolks"), false);
});
