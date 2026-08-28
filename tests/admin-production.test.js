"use strict";

/* ==========================================
   Admin Production (js/admin-production.js) -- buildPlan() and its
   supporting calculation helpers.

   Production audit (2026-08-27), triggered by a real report: "S'mores
   is missing." The read-only audit found the underlying quantity
   calculation was actually correct for every live order -- the
   confirmed, reproducible defects were:

     1. renderProducts()'s categoryOrder listed Title-Case plural labels
        ("Bread","Cookies","Cinnamon Rolls","Desserts") that never
        matched the real, canonical menu_items.category values (lowercase
        singular: "bread"/"cookie"/"dessert"/"seasonal"). Every category
        fell into the same unordered, mislabeled bucket.
     2. Mix & Match packaging was computed from each CHILD flavor's own
        packaging_profile_id (e.g. "Single Cookie Bag") instead of the
        PARENT BOX's own profile (e.g. "6 Pack Cookie Bags"), multiplied
        by box count -- both wildly wrong totals and a completely
        different set of missing/short packaging items.
     3. The product-totals loop silently dropped an unresolvable menu
        item with no warning (asymmetric with the recipe-calculation
        loop, which did warn) -- fixed by unifying both into one pass.
     4. Finish Production never actually blocked on plan.warnings, only
        on inconvertible units.
     5. No whole-batch rounding guidance, no order/date context on
        warnings, no reconciliation safety net, no explicit "which order
        statuses are included" disclosure.

   These tests exercise buildPlan() directly (bypassing the Supabase
   network calls in loadReferenceData/loadSelectedDate) against
   synthetic fixtures shaped exactly like the real live schema. Same
   node:vm sandbox technique as the other admin-*.test.js files.
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
   Fixture builders -- a small, self-consistent synthetic menu mirroring
   the real live shape (cookie flavors + two Mix & Match boxes), plus
   helpers for building order rows. Every id is a plain string/number,
   never re-using anything from the real production database.
   ========================================== */

function cookieFlavor(id, name, recipeId, { available = true, requiresRecipe = true } = {}) {
    return {
        id, name, category: "cookie", product_type: "standard",
        recipe_id: recipeId, recipe_units_used: "1",
        packaging_profile_id: "pkg-single", builder_group: "cookie",
        available, requires_recipe: requiresRecipe
    };
}

function box(id, name, size, packagingProfileId) {
    return {
        id, name, category: "cookie", product_type: "builder",
        builder_size: size, builder_group: "cookie",
        recipe_id: null, packaging_profile_id: packagingProfileId,
        recipe_units_used: "1", available: true, requires_recipe: false
    };
}

function baseMenu() {
    return [
        cookieFlavor("m-smores", "S'mores", "r-smores"),
        cookieFlavor("m-bbss", "Brown Butter Sea Salt Chocolate Chip", "r-bbss"),
        cookieFlavor("m-snick", "Browned Butter Snickerdoodle", "r-snick"),
        cookieFlavor("m-straw", "Strawberry Shortcake", "r-straw"),
        box("m-box6", "6 Mix & Match Cookies", 6, "pkg-box6"),
        box("m-box12", "12 Mix & Match Cookies", 12, "pkg-box12"),
        { id: "m-brownie", name: "Classic Sea Salt Fudge Brownie", category: "dessert", product_type: "standard", recipe_id: "r-brownie", recipe_units_used: "1", packaging_profile_id: "pkg-single", available: true, requires_recipe: true },
        { id: "m-cinn", name: "Classic Cinnamon Rolls", category: "dessert", product_type: "standard", recipe_id: "r-cinn", recipe_units_used: "4", packaging_profile_id: "pkg-single", available: true, requires_recipe: true }
    ];
}

function baseRecipes() {
    return [
        { id: "r-smores", name: "S'mores Cookies", yield_quantity: "12", yield_unit: "item", notes: "" },
        { id: "r-bbss", name: "Brown Butter Cookies", yield_quantity: "12", yield_unit: "item", notes: "" },
        { id: "r-snick", name: "Snickerdoodle Cookies", yield_quantity: "12", yield_unit: "item", notes: "" },
        { id: "r-straw", name: "Strawberry Shortcake Cookies", yield_quantity: "12", yield_unit: "item", notes: "" },
        { id: "r-brownie", name: "Fudge Brownie", yield_quantity: "9", yield_unit: "item", notes: "" },
        { id: "r-cinn", name: "Cinnamon Rolls", yield_quantity: "8", yield_unit: "item", notes: "" }
    ];
}

function baseRecipeIngredients() {
    return [
        { recipe_id: "r-smores", ingredient_id: "i-flour", quantity: "500" },
        { recipe_id: "r-smores", ingredient_id: "i-sugar", quantity: "200" },
        { recipe_id: "r-bbss", ingredient_id: "i-flour", quantity: "500" },
        { recipe_id: "r-snick", ingredient_id: "i-flour", quantity: "500" },
        { recipe_id: "r-straw", ingredient_id: "i-flour", quantity: "500" },
        { recipe_id: "r-brownie", ingredient_id: "i-sugar", quantity: "300" },
        { recipe_id: "r-cinn", ingredient_id: "i-flour", quantity: "1000" }
    ];
}

function baseIngredients() {
    return [
        { id: "i-flour", name: "Flour", recipe_unit: "g", purchase_unit: "kg", quantity_on_hand: 100, minimum_quantity: 5, purchase_size: 1, purchase_price: 3 },
        { id: "i-sugar", name: "Sugar", recipe_unit: "g", purchase_unit: "kg", quantity_on_hand: 50, minimum_quantity: 5, purchase_size: 1, purchase_price: 2 },
        { id: "i-bag-single", name: "Single Cookie Bag", recipe_unit: "each", purchase_unit: "each", quantity_on_hand: 500, minimum_quantity: 20, purchase_size: 1, purchase_price: 0.1 },
        { id: "i-bag6", name: "6 Pack Cookie Bags", recipe_unit: "each", purchase_unit: "each", quantity_on_hand: 50, minimum_quantity: 5, purchase_size: 1, purchase_price: 0.3 },
        { id: "i-box12", name: "Pastry Boxes", recipe_unit: "each", purchase_unit: "each", quantity_on_hand: 20, minimum_quantity: 5, purchase_size: 1, purchase_price: 0.6 }
    ];
}

function basePackagingItems() {
    return [
        { profile_id: "pkg-single", ingredient_id: "i-bag-single", quantity: "1" },
        { profile_id: "pkg-box6", ingredient_id: "i-bag6", quantity: "1" },
        { profile_id: "pkg-box12", ingredient_id: "i-box12", quantity: "1" }
    ];
}

function order(id, pickupDate, customerName, items, subtotal) {
    return { id, pickup_date: pickupDate, customer_name: customerName, subtotal, order_items: items };
}

function standardItem(id, menuItemId, itemName, quantity, lineTotal) {
    return { id, menu_item_id: menuItemId, item_name: itemName, quantity, line_total: lineTotal, builder_details: null };
}

function builderItem(id, itemName, quantity, selections, extra = {}) {
    return { id, menu_item_id: null, item_name: itemName, quantity, line_total: 0, builder_details: { selections, ...extra } };
}

function loadSandbox() {
    const fakeDocument = {
        addEventListener: () => {},
        getElementById: (id) => (id === "productionDate" ? { value: "2026-08-30" } : null)
    };

    const sandbox = {
        document: fakeDocument,
        window: {},
        console,
        CurrencyConversion: require(path.join(ROOT, "js/currency-conversion.js")),
        SaleCalculations: require(path.join(ROOT, "js/sale-calculations.js")),
        QuantityFormat: require(path.join(ROOT, "js/quantity-format.js"))
    };
    vm.createContext(sandbox);

    const source = [
        read("js/admin-production.js"),
        `
        this.__setData = (d) => { data = d; };
        this.__buildPlan = buildPlan;
        this.__hasBlockingErrors = () => hasBlockingErrors();
        this.__productionCategoryLabel = productionCategoryLabel;
        this.__batchRow = batchRow;
        this.__setPlan = (p) => { plan = p; };
        `
    ].join("\n");

    vm.runInContext(source, sandbox);

    return sandbox;
}

function buildFixtureData(orders) {
    return {
        orders,
        menu: baseMenu(),
        recipes: baseRecipes(),
        recipeIngredients: baseRecipeIngredients(),
        recipeComponents: [],
        ingredients: baseIngredients(),
        packagingItems: basePackagingItems(),
        recipeCosts: [],
        packagingCosts: [],
        run: null,
        currentRate: { rate: 1.1 }
    };
}

function plan(sandbox, orders) {
    sandbox.__setData(buildFixtureData(orders));
    return sandbox.__buildPlan();
}

function productByName(p, name) {
    return p.products.find(x => x.name === name);
}

function batchByRecipeName(p, name) {
    return p.batches.find(x => x.name === name);
}

/* ==========================================
   1-3. S'mores individually, in a 6-box, in a 12-box
   ========================================== */

test("1. S'mores ordered individually is counted in Product Totals and Recipe Batches", () => {
    const sandbox = loadSandbox();
    const o = order("o1", "2026-08-30", "Alex", [standardItem("oi1", "m-smores", "S'mores", 1, 3)], 3);

    const p = plan(sandbox, [o]);

    assert.equal(productByName(p, "S'mores").quantity, 1);
    assert.equal(batchByRecipeName(p, "S'mores Cookies").recipeUnits, 1);
    assert.equal(p.warnings.length, 0, JSON.stringify(p.warnings));
});

test("2. S'mores inside a 6-count Mix & Match box contributes its selected quantity, not the whole box quantity", () => {
    const sandbox = loadSandbox();
    const selections = [
        { id: "m-bbss", name: "Brown Butter Sea Salt Chocolate Chip", quantity: 3 },
        { id: "m-smores", name: "S'mores", quantity: 3 }
    ];
    const o = order("o1", "2026-08-30", "Kayla", [builderItem("oi1", "6 Mix & Match Cookies", 1, selections, { box_quantity: 1, builder_group: "cookie" })], 15);

    const p = plan(sandbox, [o]);

    assert.equal(productByName(p, "S'mores").quantity, 3);
    assert.equal(productByName(p, "6 Mix & Match Cookies"), undefined, "the box itself must never appear as a generic product");
});

test("3. S'mores inside a 12-count Mix & Match box contributes its selected quantity", () => {
    const sandbox = loadSandbox();
    const selections = [
        { id: "m-bbss", name: "Brown Butter Sea Salt Chocolate Chip", quantity: 4 },
        { id: "m-smores", name: "S'mores", quantity: 4 },
        { id: "m-snick", name: "Browned Butter Snickerdoodle", quantity: 4 }
    ];
    const o = order("o1", "2026-08-30", "Jennifer", [builderItem("oi1", "12 Mix & Match Cookies", 1, selections)], 25);

    const p = plan(sandbox, [o]);

    assert.equal(productByName(p, "S'mores").quantity, 4);
});

/* ==========================================
   4. Same flavor individual + bundle combine into one accurate total
   ========================================== */

test("4. two individual S'mores plus three inside a box combine into five total", () => {
    const sandbox = loadSandbox();
    const orders = [
        order("o1", "2026-08-30", "Alex", [standardItem("oi1", "m-smores", "S'mores", 2, 6)], 6),
        order("o2", "2026-08-30", "Priya", [builderItem("oi2", "6 Mix & Match Cookies", 1, [
            { id: "m-smores", name: "S'mores", quantity: 3 },
            { id: "m-bbss", name: "Brown Butter Sea Salt Chocolate Chip", quantity: 3 }
        ])], 15)
    ];

    const p = plan(sandbox, orders);

    assert.equal(productByName(p, "S'mores").quantity, 5);
    assert.equal(batchByRecipeName(p, "S'mores Cookies").recipeUnits, 5);
});

/* ==========================================
   5-6. Every current flavor, and a brand new one with a valid recipe
   ========================================== */

test("5. all four current cookie flavors are represented when each is ordered individually", () => {
    const sandbox = loadSandbox();
    const items = [
        standardItem("oi1", "m-smores", "S'mores", 1, 3),
        standardItem("oi2", "m-bbss", "Brown Butter Sea Salt Chocolate Chip", 1, 3),
        standardItem("oi3", "m-snick", "Browned Butter Snickerdoodle", 1, 3),
        standardItem("oi4", "m-straw", "Strawberry Shortcake", 1, 3)
    ];
    const p = plan(sandbox, [order("o1", "2026-08-30", "Alex", items, 12)]);

    for (const name of ["S'mores", "Brown Butter Sea Salt Chocolate Chip", "Browned Butter Snickerdoodle", "Strawberry Shortcake"]) {
        assert.equal(productByName(p, name).quantity, 1, `${name} should be counted`);
    }
    assert.equal(p.warnings.length, 0, JSON.stringify(p.warnings));
});

test("6. a newly created cookie flavor with a valid recipe works automatically, no code change needed", () => {
    const sandbox = loadSandbox();
    const data = buildFixtureData([]);
    data.menu.push(cookieFlavor("m-newflavor", "Maple Pecan", "r-newflavor"));
    data.recipes.push({ id: "r-newflavor", name: "Maple Pecan Cookies", yield_quantity: "12", yield_unit: "item", notes: "" });
    data.recipeIngredients.push({ recipe_id: "r-newflavor", ingredient_id: "i-flour", quantity: "500" });
    data.orders = [order("o1", "2026-08-30", "Alex", [standardItem("oi1", "m-newflavor", "Maple Pecan", 2, 6)], 6)];

    sandbox.__setData(data);
    const p = sandbox.__buildPlan();

    assert.equal(productByName(p, "Maple Pecan").quantity, 2);
    assert.equal(batchByRecipeName(p, "Maple Pecan Cookies").recipeUnits, 2);
    assert.equal(p.warnings.length, 0, JSON.stringify(p.warnings));
});

/* ==========================================
   7-8. requires_recipe classification
   ========================================== */

test("7. a product explicitly classified requires_recipe:false with no recipe produces no warning and isn't blocking", () => {
    const sandbox = loadSandbox();
    const data = buildFixtureData([]);
    data.menu.push({ id: "m-merch", name: "Tote Bag", category: "seasonal", product_type: "standard", recipe_id: null, recipe_units_used: "1", packaging_profile_id: "pkg-single", available: true, requires_recipe: false });
    data.orders = [order("o1", "2026-08-30", "Alex", [standardItem("oi1", "m-merch", "Tote Bag", 1, 15)], 15)];

    sandbox.__setData(data);
    const p = sandbox.__buildPlan();

    assert.equal(productByName(p, "Tote Bag").quantity, 1);
    assert.equal(p.warnings.length, 0, JSON.stringify(p.warnings));
    sandbox.__setPlan(p);
    assert.equal(sandbox.__hasBlockingErrors(), false);
});

test("8. a standard product with NO explicit classification (requires_recipe defaults true) and no recipe still warns and blocks", () => {
    const sandbox = loadSandbox();
    const data = buildFixtureData([]);
    data.menu.push({ id: "m-unconfigured", name: "New Item", category: "bread", product_type: "standard", recipe_id: null, recipe_units_used: "1", packaging_profile_id: "pkg-single", available: true, requires_recipe: true });
    data.orders = [order("o1", "2026-08-30", "Alex", [standardItem("oi1", "m-unconfigured", "New Item", 1, 5)], 5)];

    sandbox.__setData(data);
    const p = sandbox.__buildPlan();

    assert.equal(p.warnings.length, 1);
    assert.match(p.warnings[0], /New Item.*does not have a recipe assigned/);
    assert.match(p.warnings[0], /Alex/);
    assert.match(p.warnings[0], /2026-08-30/);
});

/* ==========================================
   9-10. Yield > 1, and a pack-size multiplier
   ========================================== */

test("9. a recipe with yield greater than 1 requires the correct fractional batch count", () => {
    // r-smores yields 12 items/batch; ordering 3 needs 3/12 = 0.25 batches.
    const sandbox = loadSandbox();
    const p = plan(sandbox, [order("o1", "2026-08-30", "Alex", [standardItem("oi1", "m-smores", "S'mores", 3, 9)], 9)]);

    const batch = batchByRecipeName(p, "S'mores Cookies");
    assert.equal(batch.recipeUnits, 3);
    assert.equal(batch.batches, 3 / 12);
});

test("10. a static multipack with a unit multiplier (recipe_units_used > 1) scales recipe demand correctly, not 1:1", () => {
    // Classic Cinnamon Rolls: 1 customer order = 4 recipe units (a 4-pack).
    const sandbox = loadSandbox();
    const p = plan(sandbox, [order("o1", "2026-08-30", "Alex", [standardItem("oi1", "m-cinn", "Classic Cinnamon Rolls", 2, 40)], 40)]);

    // 2 orders * 4 units-per-item = 8 recipe units, against an 8-item yield -> exactly 1 batch.
    const batch = batchByRecipeName(p, "Cinnamon Rolls");
    assert.equal(batch.recipeUnits, 8);
    assert.equal(batch.batches, 1);
    assert.equal(productByName(p, "Classic Cinnamon Rolls").quantity, 2, "customer-facing quantity stays the order quantity, not the recipe-unit count");
});

/* ==========================================
   11-12. Multiple orders, one date vs across dates
   ========================================== */

test("11. multiple orders for the same pickup date aggregate into one total per product", () => {
    const sandbox = loadSandbox();
    const orders = [
        order("o1", "2026-08-30", "Alex", [standardItem("oi1", "m-smores", "S'mores", 1, 3)], 3),
        order("o2", "2026-08-30", "Priya", [standardItem("oi2", "m-smores", "S'mores", 2, 6)], 6),
        order("o3", "2026-08-30", "Sam", [standardItem("oi3", "m-smores", "S'mores", 1, 3)], 3)
    ];
    const p = plan(sandbox, orders);
    assert.equal(productByName(p, "S'mores").quantity, 4);
    assert.equal(p.orderCount, 3);
});

test("12. buildPlan only ever reflects the orders it was given -- a different pickup date's orders never leak in", () => {
    // loadSelectedDate() is what filters by date server-side; buildPlan()
    // itself is date-agnostic over whatever data.orders currently holds --
    // this locks down that it never re-filters or merges in anything else.
    const sandbox = loadSandbox();
    const p = plan(sandbox, [order("o1", "2026-08-30", "Alex", [standardItem("oi1", "m-smores", "S'mores", 1, 3)], 3)]);
    assert.equal(p.orderCount, 1);
    assert.equal(productByName(p, "S'mores").quantity, 1);
});

/* ==========================================
   13. Category grouping/labels
   ========================================== */

test("13a. productionCategoryLabel maps canonical raw category values to their display labels", () => {
    const sandbox = loadSandbox();
    assert.equal(sandbox.__productionCategoryLabel("bread"), "Bread");
    assert.equal(sandbox.__productionCategoryLabel("cookie"), "Cookies");
    assert.equal(sandbox.__productionCategoryLabel("dessert"), "Desserts");
    assert.equal(sandbox.__productionCategoryLabel("seasonal"), "Seasonal");
});

test("13b. productionCategoryLabel title-cases a genuinely new category rather than dumping it in Other", () => {
    const sandbox = loadSandbox();
    assert.equal(sandbox.__productionCategoryLabel("gift-box"), "Gift Box");
});

test("13c. productionCategoryLabel falls back to Other only for a truly missing category", () => {
    const sandbox = loadSandbox();
    assert.equal(sandbox.__productionCategoryLabel(""), "Other");
    assert.equal(sandbox.__productionCategoryLabel(null), "Other");
});

test("13d. a cookie product's raw category is preserved as 'cookie' on the product record (grouping key), not pre-labeled", () => {
    const sandbox = loadSandbox();
    const p = plan(sandbox, [order("o1", "2026-08-30", "Alex", [standardItem("oi1", "m-smores", "S'mores", 1, 3)], 3)]);
    assert.equal(productByName(p, "S'mores").category, "cookie");
});

/* ==========================================
   14. Malformed Mix & Match selection
   ========================================== */

test("14. a builder box with no builder_details.selections (malformed/legacy row) produces a specific blocking warning naming the order, and is never guessed into Product Totals", () => {
    const sandbox = loadSandbox();
    const o = order("o1", "2026-08-30", "Legacy Customer", [standardItem("oi1", "m-box12", "12 Mix & Match Cookies", 1, 25)], 25);

    const p = plan(sandbox, [o]);

    assert.equal(p.warnings.length, 1);
    assert.match(p.warnings[0], /missing its Mix & Match flavor selections/);
    assert.match(p.warnings[0], /Legacy Customer/);
    assert.equal(productByName(p, "12 Mix & Match Cookies"), undefined);
    // Its packaging IS still counted -- that part is knowable from quantity alone.
    const pastryBoxes = p.packagingReq.find(x => x.name === "Pastry Boxes");
    assert.equal(pastryBoxes.required, 1);
});

/* ==========================================
   15. Archived child flavor still referenced in a current order
   ========================================== */

test("15. an archived (available:false) flavor still selected inside a current order's box is still calculated, never dropped for being unavailable", () => {
    const sandbox = loadSandbox();
    const data = buildFixtureData([]);
    data.menu.push(cookieFlavor("m-retired", "Retired Flavor", "r-retired", { available: false }));
    data.recipes.push({ id: "r-retired", name: "Retired Flavor Cookies", yield_quantity: "12", yield_unit: "item", notes: "" });
    data.recipeIngredients.push({ recipe_id: "r-retired", ingredient_id: "i-flour", quantity: "500" });
    data.orders = [order("o1", "2026-08-30", "Alex", [builderItem("oi1", "6 Mix & Match Cookies", 1, [
        { id: "m-retired", name: "Retired Flavor", quantity: 6 }
    ])], 15)];

    sandbox.__setData(data);
    const p = sandbox.__buildPlan();

    assert.equal(productByName(p, "Retired Flavor").quantity, 6);
});

/* ==========================================
   16-17. Missing recipe, invalid/zero yield
   ========================================== */

test("16. a product with a recipe_id that doesn't resolve to any current recipe warns and blocks, same as no recipe at all", () => {
    const sandbox = loadSandbox();
    const data = buildFixtureData([]);
    data.menu.push({ id: "m-orphan", name: "Orphan Product", category: "bread", product_type: "standard", recipe_id: "r-does-not-exist", recipe_units_used: "1", packaging_profile_id: "pkg-single", available: true, requires_recipe: true });
    data.orders = [order("o1", "2026-08-30", "Alex", [standardItem("oi1", "m-orphan", "Orphan Product", 1, 5)], 5)];

    sandbox.__setData(data);
    const p = sandbox.__buildPlan();

    assert.equal(p.warnings.length, 1);
    assert.match(p.warnings[0], /does not have a recipe assigned/);
});

test("17. a recipe with a zero yield_quantity warns instead of silently defaulting to 1", () => {
    const sandbox = loadSandbox();
    const data = buildFixtureData([]);
    data.menu.push(cookieFlavor("m-zeroyield", "Zero Yield Flavor", "r-zeroyield"));
    data.recipes.push({ id: "r-zeroyield", name: "Zero Yield Cookies", yield_quantity: "0", yield_unit: "item", notes: "" });
    data.orders = [order("o1", "2026-08-30", "Alex", [standardItem("oi1", "m-zeroyield", "Zero Yield Flavor", 1, 3)], 3)];

    sandbox.__setData(data);
    const p = sandbox.__buildPlan();

    assert.equal(p.warnings.length, 1);
    assert.match(p.warnings[0], /yield quantity greater than zero/);
    assert.equal(batchByRecipeName(p, "Zero Yield Cookies"), undefined, "must never fabricate a batch entry from an invalid yield");
});

/* ==========================================
   18-19. Ingredient unit aggregation, compatible and incompatible
   ========================================== */

test("18. compatible ingredient units (g and kg both map to the same MASS family) aggregate into one accurate total", () => {
    const sandbox = loadSandbox();
    const p = plan(sandbox, [order("o1", "2026-08-30", "Alex", [standardItem("oi1", "m-smores", "S'mores", 2, 6)], 6)]);

    const flour = p.combined.find(x => x.name === "Flour");
    // recipe qty 500g * (2 S'mores / 12-item yield) = 83.33g
    assert.ok(Math.abs(flour.required - (500 * 2 / 12)) < 1e-9);
    assert.equal(flour.convertible, true);
    assert.equal(flour.status, "good");
});

test("19. incompatible ingredient units (count-based recipe unit vs a mass/volume purchase unit) never produce a false combined total -- marked unconvertible with a warning instead", () => {
    const sandbox = loadSandbox();
    const data = buildFixtureData([]);
    data.ingredients.push({ id: "i-bad", name: "Mystery Ingredient", recipe_unit: "each", purchase_unit: "kg", quantity_on_hand: 10, minimum_quantity: 1, purchase_size: 1, purchase_price: 1 });
    data.recipeIngredients.push({ recipe_id: "r-smores", ingredient_id: "i-bad", quantity: "1" });
    data.orders = [order("o1", "2026-08-30", "Alex", [standardItem("oi1", "m-smores", "S'mores", 1, 3)], 3)];

    sandbox.__setData(data);
    const p = sandbox.__buildPlan();

    const mystery = p.combined.find(x => x.name === "Mystery Ingredient");
    assert.equal(mystery.convertible, false);
    assert.equal(mystery.status, "unknown");
});

/* ==========================================
   20. Ingredient shortages are informational, never blocking
   ========================================== */

test("20. an ingredient shortage is surfaced but does not add a blocking warning or count toward hasBlockingErrors", () => {
    const sandbox = loadSandbox();
    const data = buildFixtureData([]);
    data.ingredients = data.ingredients.map(i => i.id === "i-flour" ? { ...i, quantity_on_hand: 0.001 } : i);
    data.orders = [order("o1", "2026-08-30", "Alex", [standardItem("oi1", "m-smores", "S'mores", 5, 15)], 15)];

    sandbox.__setData(data);
    const p = sandbox.__buildPlan();

    assert.ok(p.shortages.length > 0, "expected a real shortage given almost no flour on hand");
    assert.equal(p.warnings.length, 0, JSON.stringify(p.warnings));
});

/* ==========================================
   21-22. Packaging: box owns its own profile, never the children's
   ========================================== */

test("21. a 6-count box's packaging is ONE '6 Pack Cookie Bags' set, never one 'Single Cookie Bag' per selected cookie", () => {
    const sandbox = loadSandbox();
    const selections = [
        { id: "m-bbss", name: "Brown Butter Sea Salt Chocolate Chip", quantity: 3 },
        { id: "m-smores", name: "S'mores", quantity: 3 }
    ];
    const o = order("o1", "2026-08-30", "Kayla", [builderItem("oi1", "6 Mix & Match Cookies", 1, selections, { box_quantity: 1 })], 15);

    const p = plan(sandbox, [o]);

    const sixPack = p.packagingReq.find(x => x.name === "6 Pack Cookie Bags");
    const singleBag = p.packagingReq.find(x => x.name === "Single Cookie Bag");

    assert.equal(sixPack.required, 1, "exactly one 6-pack bag for one box, regardless of how many flavors were mixed in");
    assert.equal(singleBag, undefined, "individual cookies inside a box must never separately require a single-cookie bag");
});

test("22. two 6-count boxes (box_quantity: 2) require two sets of box packaging and twelve total child-cookie selections", () => {
    const sandbox = loadSandbox();
    const selections = [
        { id: "m-bbss", name: "Brown Butter Sea Salt Chocolate Chip", quantity: 6 },
        { id: "m-smores", name: "S'mores", quantity: 6 }
    ];
    const o = order("o1", "2026-08-30", "Kayla", [builderItem("oi1", "6 Mix & Match Cookies", 1, selections, { box_quantity: 2 })], 30);

    const p = plan(sandbox, [o]);

    const sixPack = p.packagingReq.find(x => x.name === "6 Pack Cookie Bags");
    assert.equal(sixPack.required, 2);
    assert.equal(productByName(p, "S'mores").quantity, 6);
    assert.equal(productByName(p, "Brown Butter Sea Salt Chocolate Chip").quantity, 6);
});

test("22b. a 12-count box uses Pastry Boxes packaging, not the 6-count box's profile", () => {
    const sandbox = loadSandbox();
    const selections = [{ id: "m-bbss", name: "Brown Butter Sea Salt Chocolate Chip", quantity: 12 }];
    const o = order("o1", "2026-08-30", "Jennifer", [builderItem("oi1", "12 Mix & Match Cookies", 1, selections)], 25);

    const p = plan(sandbox, [o]);

    assert.equal(p.packagingReq.find(x => x.name === "Pastry Boxes").required, 1);
    assert.equal(p.packagingReq.find(x => x.name === "6 Pack Cookie Bags"), undefined);
});

test("22c. Mix & Match child selections never add their own price/revenue -- the box's line_total already owns 100% of it", () => {
    const sandbox = loadSandbox();
    const selections = [{ id: "m-smores", name: "S'mores", quantity: 6 }];
    const o = order("o1", "2026-08-30", "Kayla", [builderItem("oi1", "6 Mix & Match Cookies", 1, selections)], 15);

    const p = plan(sandbox, [o]);

    assert.equal(productByName(p, "S'mores").revenue, 0);
    assert.equal(p.revenue, 15); // from order.subtotal only
});

/* ==========================================
   23. Reconciliation invariant holds for a complex, correct scenario
   ========================================== */

test("23. the reconciliation check produces no warning for a correctly-processed complex plan (positive-path lock on the invariant)", () => {
    const sandbox = loadSandbox();
    const orders = [
        order("o1", "2026-08-30", "Kayla", [
            standardItem("oi1", "m-brownie", "Classic Sea Salt Fudge Brownie", 2, 10),
            builderItem("oi2", "6 Mix & Match Cookies", 1, [
                { id: "m-bbss", name: "Brown Butter Sea Salt Chocolate Chip", quantity: 2 },
                { id: "m-snick", name: "Browned Butter Snickerdoodle", quantity: 2 },
                { id: "m-smores", name: "S'mores", quantity: 2 }
            ])
        ], 25),
        order("o2", "2026-08-30", "Jennifer", [
            builderItem("oi3", "12 Mix & Match Cookies", 1, [
                { id: "m-bbss", name: "Brown Butter Sea Salt Chocolate Chip", quantity: 3 },
                { id: "m-snick", name: "Browned Butter Snickerdoodle", quantity: 3 },
                { id: "m-smores", name: "S'mores", quantity: 3 },
                { id: "m-straw", name: "Strawberry Shortcake", quantity: 3 }
            ])
        ], 25)
    ];

    const p = plan(sandbox, orders);

    assert.equal(p.warnings.filter(w => w.includes("Reconciliation check failed")).length, 0, JSON.stringify(p.warnings));
});

/* ==========================================
   24. Finish Production blocking wiring
   ========================================== */

test("24a. hasBlockingErrors is true whenever plan.warnings is non-empty", () => {
    const sandbox = loadSandbox();
    const data = buildFixtureData([]);
    data.menu.push({ id: "m-broken", name: "Broken Product", category: "bread", product_type: "standard", recipe_id: null, recipe_units_used: "1", packaging_profile_id: "pkg-single", available: true, requires_recipe: true });
    data.orders = [order("o1", "2026-08-30", "Alex", [standardItem("oi1", "m-broken", "Broken Product", 1, 5)], 5)];
    sandbox.__setData(data);
    const p = sandbox.__buildPlan();
    sandbox.__setPlan(p);

    assert.equal(p.warnings.length > 0, true);
    assert.equal(sandbox.__hasBlockingErrors(), true);
});

test("24b. hasBlockingErrors is false for a fully clean plan with no warnings and no shortages", () => {
    const sandbox = loadSandbox();
    const p = plan(sandbox, [order("o1", "2026-08-30", "Alex", [standardItem("oi1", "m-smores", "S'mores", 1, 3)], 3)]);
    sandbox.__setPlan(p);

    assert.equal(p.warnings.length, 0, JSON.stringify(p.warnings));
    assert.equal(sandbox.__hasBlockingErrors(), false);
});

/* ==========================================
   Whole-batch rounding
   ========================================== */

test("25a. batchRow shows a whole-batch rounding recommendation when the exact batch count isn't already whole", () => {
    const sandbox = loadSandbox();
    const html = sandbox.__batchRow({ name: "S'mores Cookies", recipeUnits: 3, yieldQuantity: 12, yieldUnit: "item", batches: 0.25, notes: "" });
    assert.match(html, /Round up to/);
    assert.match(html, /1 whole batch/);
});

test("25b. batchRow omits the rounding note when the exact batch count is already whole", () => {
    const sandbox = loadSandbox();
    const html = sandbox.__batchRow({ name: "S'mores Cookies", recipeUnits: 12, yieldQuantity: 12, yieldUnit: "item", batches: 1, notes: "" });
    assert.doesNotMatch(html, /Round up to/);
});
