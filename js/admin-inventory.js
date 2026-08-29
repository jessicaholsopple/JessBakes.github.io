document.addEventListener("DOMContentLoaded", async () => {

    await requireAuth();

});

/*==================================================
    INVENTORY
==================================================*/

let ingredients = [];
let categories = [];
let suppliers = [];
let recipes = [];

// Recipe costs, keyed by recipe id, sourced from the `recipe_costs`
// Postgres view — the same canonical, recursive (sub-recipe-aware),
// unit-aware source Menu and sale creation already use (BUG-04/BUG-05).
// Replaces this page's own former client-side recipe-costing logic, which
// ignored sub-recipe components and only converted mass units.
let recipeCosts = new Map();


/*==================================================
    PAGE INITIALIZATION
==================================================*/

document.addEventListener("DOMContentLoaded", async () => {
    await requireAuth();

    setupLogout();

    buildInventoryModals();

    await loadInventory();

    handleRecipeDeepLink();
});

/** Opens a recipe directly in the existing edit modal when arriving via
 * `?recipe=<id>` (used by the Recipe Cards page's "Edit Recipe" link) --
 * a pure convenience deep link into the SAME editor this page already
 * has, never a second one. Safe by construction: it only ever looks up
 * an id already present in the `recipes` array this page loaded itself
 * and opens the existing modal with it -- no new query, no write. A
 * missing/unrecognized id simply no-ops, mirroring
 * js/admin-orders.js's handleOrderDeepLink. */
function handleRecipeDeepLink() {
    const recipeId = new URLSearchParams(window.location.search).get("recipe");
    if (!recipeId) return;

    const exists = recipes.some(recipe => String(recipe.id) === String(recipeId));
    if (!exists) return;

    openRecipeModal(recipeId);
}


/*==================================================
    DATA LOADING
==================================================*/

async function loadInventory() {
    await Promise.all([
        loadCategories(),
        loadSuppliers(),
        loadIngredients(),
        loadRecipes(),
        loadRecipeCosts()
    ]);

    updateInventoryOverview();
    renderLowStockAlerts();
    renderIngredients();
    renderRecipes();
    renderRecipeCosting();
    renderShoppingList();
    renderSuppliers();
}

async function loadCategories() {
    const { data, error } = await supabaseClient
        .from("inventory_categories")
        .select("*")
        .order("sort_order", { ascending: true });

    if (error) {
        console.error(error);
        categories = [];
        return;
    }

    categories = data || [];
}

async function loadSuppliers() {
    const { data, error } = await supabaseClient
        .from("suppliers")
        .select("*")
        .order("name", { ascending: true });

    if (error) {
        console.error(error);
        suppliers = [];
        return;
    }

    suppliers = data || [];
}

async function loadIngredients() {

    const { data, error } = await supabaseClient
        .from("ingredients")
        .select("*")
        .order("name", { ascending: true });

    if (error) {

        console.error(error);

        ingredients = [];

        return;

    }

    ingredients = data || [];

}

async function loadRecipes() {

    const { data, error } = await supabaseClient
        .from("recipes")
        .select(`
            *,
            recipe_ingredients(
                *,
                ingredients(*)
            ),
            recipe_components!recipe_components_parent_recipe_id_fkey(
                *,
                component_recipe:recipes!recipe_components_component_recipe_id_fkey(
                    id,
                    name,
                    category,
                    yield_quantity,
                    yield_unit,
                    notes
                )
            )
        `)
        .order("name", { ascending: true });

    if (error) {

        console.error("Unable to load recipes:", error);

        recipes = [];

        return;

    }

    recipes = data || [];

}

async function loadRecipeCosts() {

    const { data, error } = await supabaseClient
        .from("recipe_costs")
        .select("*");

    if (error) {

        console.error("Unable to load recipe costs:", error);

        recipeCosts = new Map();

        return;

    }

    recipeCosts = RecipeCosting.buildRecipeCostsById(data);

}

/*==================================================
    OVERVIEW
==================================================*/

function updateInventoryOverview() {
    // Derived ingredients (Egg Yolks) are excluded from every purchased-
    // stock aggregate here -- they are not a second physical item, just
    // an alternate recipe-facing view of Eggs. Counting them here would
    // double-count the same physical stock (see js/derived-ingredients.js).
    const physical = DerivedIngredients.physicalOnly(ingredients);
    const lowStock = physical.filter(isLowStock);

    const inventoryValue = physical.reduce((sum, ingredient) => {
        const value =
            Number(ingredient.quantity_on_hand || 0) /
            Number(ingredient.purchase_size || 1) *
            Number(ingredient.purchase_price || 0);

        return sum + value;
    }, 0);

    setText("ingredientCount", physical.length);
    setText("lowStockCount", lowStock.length);
    setText("inventoryValue", usd(inventoryValue));
    setText("recipeCount", recipes.length);
}


/*==================================================
    PANTRY RENDERING
==================================================*/

function renderLowStockAlerts() {
    const container = document.getElementById("lowStockAlerts");

    if (!container) return;

    // A derived ingredient (Egg Yolks) is never independently low/high
    // on stock -- it always exactly mirrors its source. Alerting on
    // both would show two warnings for the same physical shortage.
    const lowStock = DerivedIngredients.physicalOnly(ingredients).filter(isLowStock);

    if (!lowStock.length) {
        container.innerHTML = "<p>Everything is stocked.</p>";
        return;
    }

    container.innerHTML = lowStock.map(ingredient => `
        <div class="inventory-alert-row">
            <div>
                <strong>${escapeHtml(ingredient.name)}</strong>
                <small>
                    ${formatQuantity(ingredient.quantity_on_hand)}
                    ${escapeHtml(ingredient.purchase_unit)}
                    remaining
                </small>
            </div>

            <span>
                Minimum:
                ${formatQuantity(ingredient.minimum_quantity)}
                ${escapeHtml(ingredient.purchase_unit)}
            </span>
        </div>
    `).join("");
}

function renderIngredients() {

    const container = document.getElementById("ingredientsTable");

    if (!container) return;

    const search =
        document.getElementById("inventorySearch")
            ?.value
            .toLowerCase()
            .trim() || "";

    const filtered = ingredients.filter(ingredient =>
        ingredient.name.toLowerCase().includes(search)
    );

    if (!filtered.length) {

        container.innerHTML = `
            <p class="inventory-empty">
                No ingredients found.
            </p>
        `;

        return;

    }

    const grouped = {};

    filtered.forEach(ingredient => {

        const category =
            categories.find(c => c.id === ingredient.category_id);

        const name = category?.name || "Other";

        if (!grouped[name]) {

            grouped[name] = [];

        }

        grouped[name].push(ingredient);

    });

    container.innerHTML = Object.entries(grouped)

        .sort((a,b)=>a[0].localeCompare(b[0]))

        .map(([categoryName, items]) => `

<section class="inventory-category">

<button
class="inventory-category-header"
onclick="toggleInventoryCategory(this)">

<div class="inventory-category-left">

<div class="inventory-category-icon">

${getCategoryEmoji(categoryName)}

</div>

<div>

<h3>${escapeHtml(categoryName)}</h3>

<small>

${items.length}
ingredient${items.length===1?"":"s"}

</small>

</div>

</div>

<div class="inventory-category-arrow">

▼

</div>

</button>

<div class="inventory-category-body">

${items
.sort((a,b)=>a.name.localeCompare(b.name))
.map(ingredient => DerivedIngredients.isDerived(ingredient) ? renderDerivedIngredientRow(ingredient) : renderIngredientRow(ingredient))
.join("")}

</div>

</section>

        `).join("");

}

function getCategoryEmoji(category){

    switch(category.toLowerCase()){

        case "pantry":
            return "🥣";

        case "dairy":
            return "🥛";

        case "produce":
            return "🥬";

        case "packaging":
            return "📦";

        case "chocolate":
            return "🍫";

        case "spices":
            return "🌿";

        case "equipment":
            return "🧁";

        case "cleaning":
            return "🧽";

        default:
            return "📋";

    }

}

function renderIngredientRow(ingredient) {

    const supplier =
        suppliers.find(s => s.id === ingredient.supplier_id);

    const lowStock = isLowStock(ingredient);

    return `

        <article class="ingredient-card ${lowStock ? "ingredient-low" : ""}">

            <div class="ingredient-card-header">

                <div>

                    <h3>${escapeHtml(ingredient.name)}</h3>

                    <p>
                        ${supplier ? escapeHtml(supplier.name) : "No Supplier"}
                    </p>

                </div>

                <div class="ingredient-status ${lowStock ? "status-low" : "status-good"}">

                    ${lowStock ? "Low Stock" : "In Stock"}

                </div>

            </div>

            <div class="ingredient-card-grid">

                <div class="ingredient-stat">

                    <span>On Hand</span>

                    <strong>

                        ${formatQuantity(ingredient.quantity_on_hand)}
                        ${escapeHtml(ingredient.purchase_unit)}

                    </strong>

                </div>

                <div class="ingredient-stat">

                    <span>Minimum</span>

                    <strong>

                        ${formatQuantity(ingredient.minimum_quantity)}
                        ${escapeHtml(ingredient.purchase_unit)}

                    </strong>

                </div>

                <div class="ingredient-stat">

                    <span>Purchase Price</span>

                    <strong>

                        ${usd(ingredient.purchase_price)}

                    </strong>

                </div>

                <div class="ingredient-stat">

                    <span>Package Size</span>

                    <strong>

                        ${formatQuantity(ingredient.purchase_size)}
                        ${escapeHtml(ingredient.purchase_unit)}

                    </strong>

                </div>

            </div>

            <div class="ingredient-card-actions">

                <button
                    class="primary-btn"
                    onclick="openRestockModal('${ingredient.id}')">

                    Restock

                </button>

                <button
                    class="edit-option-btn"
                    onclick="openIngredientModal('${ingredient.id}')">

                    Edit

                </button>

                <button
                    class="delete-btn"
                    onclick="deleteIngredient('${ingredient.id}', '${escapeJs(ingredient.name)}')">

                    Delete

                </button>

            </div>

        </article>

    `;

}

/** Cost per one recipe/purchase unit (they're the same unit for every
 * current derived ingredient -- Eggs/Egg Yolks are both "each"), used
 * only for the derived-ingredient card's "Per-Yolk Cost" display.
 * Does not attempt the general mass/volume/count unit conversion the
 * recipe_costs view already owns -- this is a simple same-unit
 * per-item price. */
function costPerRecipeUnit(ingredient) {
    const size = Number(ingredient.purchase_size || 0);
    if (size <= 0) return 0;
    return Number(ingredient.purchase_price || 0) / size;
}

/** A derived ingredient (Egg Yolks) is not a second, independently
 * purchased item -- it is always exactly Eggs, viewed at a 1:1
 * conversion (js/derived-ingredients.js / the ingredients table's
 * derived_from_ingredient_id). This card shows that plainly: current
 * availability and per-unit cost (both already correctly mirrored
 * from the source by the database trigger), a clear "Derived from"
 * label, and a single action that opens the SOURCE ingredient's own
 * edit modal -- never a Restock button, never an independent Edit
 * button, since restocking/editing Egg Yolks directly is never
 * offered here (the database itself would also silently overwrite
 * any such attempt back to the correct derived value, but the UI
 * never presents the option in the first place). */
function renderDerivedIngredientRow(ingredient) {

    const source =
        ingredients.find(item => item.id === ingredient.derived_from_ingredient_id);

    const sourceName = source ? source.name : "its source ingredient";
    const derivedSingular = IngredientNaming
        ? IngredientNaming.singularize(ingredient.name)
        : ingredient.name;
    const sourceSingular = source
        ? (IngredientNaming ? IngredientNaming.singularize(source.name) : source.name)
        : "unit";

    return `

        <article class="ingredient-card ingredient-derived-card">

            <div class="ingredient-card-header">

                <div>

                    <h3>${escapeHtml(ingredient.name)}</h3>

                    <p>
                        Derived from ${escapeHtml(sourceName)} — 1 ${escapeHtml(derivedSingular)} uses ${formatQuantity(ingredient.derived_factor)} ${escapeHtml(sourceSingular)}${Number(ingredient.derived_factor) === 1 ? "" : "s"}
                    </p>

                </div>

                <div class="ingredient-status status-derived">

                    Derived

                </div>

            </div>

            <div class="ingredient-card-grid">

                <div class="ingredient-stat">

                    <span>Available</span>

                    <strong>

                        ${formatQuantity(ingredient.quantity_on_hand)}
                        ${escapeHtml(ingredient.purchase_unit)}

                    </strong>

                </div>

                <div class="ingredient-stat">

                    <span>Per-Unit Cost</span>

                    <strong>

                        ${usd(costPerRecipeUnit(ingredient))}

                    </strong>

                </div>

            </div>

            <div class="ingredient-card-actions">

                ${source ? `
                <button
                    class="edit-option-btn"
                    onclick="openIngredientModal('${source.id}')">

                    View ${escapeHtml(source.name)}

                </button>
                ` : ""}

            </div>

        </article>

    `;

}


/*==================================================
    INGREDIENT MODAL
==================================================*/

function buildInventoryModals() {
    if (!document.getElementById("ingredientModal")) {
        document.body.appendChild(buildIngredientModal());
    }

    if (!document.getElementById("restockModal")) {
        document.body.appendChild(buildRestockModal());
    }

    if (!document.getElementById("recipeModal")) {
        document.body.appendChild(buildRecipeModal());
    }
}

function buildIngredientModal() {
    const modal = document.createElement("div");

    modal.id = "ingredientModal";
    modal.className = "modal-overlay";
    modal.style.display = "none";

    modal.innerHTML = `
        <div class="modal-card">
            <div class="modal-header">
                <h2 id="ingredientModalTitle">Add Ingredient</h2>

                <button class="modal-close" onclick="closeIngredientModal()">
                    ✕
                </button>
            </div>

            <div class="modal-body">
                <input type="hidden" id="ingredientId">

                <label>Name</label>
                <input id="ingredientName" type="text">

                <label>Category</label>
                <select id="ingredientCategory"></select>

                <label>Supplier</label>
                <select id="ingredientSupplier"></select>

                <label>Purchase Unit</label>
                <input id="purchaseUnit" type="text" placeholder="lb, oz, each">

                <label>Recipe Unit</label>
                <input id="recipeUnit" type="text" placeholder="g, each">

                <label>Purchase Size</label>
                <input id="purchaseSize" type="number" step="0.01">

                <label>Purchase Price $</label>
                <input id="purchasePrice" type="number" step="0.01">

                <label>Quantity On Hand</label>
                <input id="quantityOnHand" type="number" step="0.01">

                <label>Minimum Quantity</label>
                <input id="minimumQuantity" type="number" step="0.01">

                <label>Notes</label>
                <textarea id="ingredientNotes" rows="3"></textarea>
            </div>

            <div class="modal-footer">
                <button class="secondary-btn" onclick="closeIngredientModal()">
                    Cancel
                </button>

                <button class="primary-btn" onclick="saveIngredient()">
                    Save Ingredient
                </button>
            </div>
        </div>
    `;

    return modal;
}

function openIngredientModal(id = null) {
    const target = id
        ? ingredients.find(item => String(item.id) === String(id))
        : null;

    // A derived ingredient (Egg Yolks) has no independently-editable
    // quantity/price/unit fields -- open its SOURCE's edit modal
    // instead of a form whose numbers the database would silently
    // overwrite anyway. Restocking/editing must happen through Eggs.
    if (target && DerivedIngredients.isDerived(target)) {
        const source = ingredients.find(item => item.id === target.derived_from_ingredient_id);
        alert(
            `${target.name} is derived from ${source ? source.name : "its source ingredient"} and can't be edited directly.` +
            (source ? ` Opening ${source.name} instead.` : "")
        );
        if (source) openIngredientModal(source.id);
        return;
    }

    populateIngredientSelects();

    const ingredient = target;

    document.getElementById("ingredientModalTitle").textContent =
        ingredient ? "Edit Ingredient" : "Add Ingredient";

    document.getElementById("ingredientId").value =
        ingredient ? ingredient.id : "";

    document.getElementById("ingredientName").value =
        ingredient ? ingredient.name : "";

    document.getElementById("ingredientCategory").value =
        ingredient ? ingredient.category_id || "" : "";

    document.getElementById("ingredientSupplier").value =
        ingredient ? ingredient.supplier_id || "" : "";

    document.getElementById("purchaseUnit").value =
        ingredient ? ingredient.purchase_unit : "";

    document.getElementById("recipeUnit").value =
        ingredient ? ingredient.recipe_unit : "";

    document.getElementById("purchaseSize").value =
        ingredient ? ingredient.purchase_size : "";

    document.getElementById("purchasePrice").value =
        ingredient ? ingredient.purchase_price : "";

    document.getElementById("quantityOnHand").value =
        ingredient ? ingredient.quantity_on_hand : "";

    document.getElementById("minimumQuantity").value =
        ingredient ? ingredient.minimum_quantity : "";

    document.getElementById("ingredientNotes").value =
        ingredient ? ingredient.notes || "" : "";

    document.getElementById("ingredientModal").style.display = "flex";
}

function closeIngredientModal() {
    document.getElementById("ingredientModal").style.display = "none";
}

function populateIngredientSelects() {
    const categorySelect = document.getElementById("ingredientCategory");
    const supplierSelect = document.getElementById("ingredientSupplier");

    categorySelect.innerHTML = `
        <option value="">Uncategorized</option>
        ${categories.map(category => `
            <option value="${category.id}">
                ${escapeHtml(category.name)}
            </option>
        `).join("")}
    `;

    supplierSelect.innerHTML = `
        <option value="">No supplier</option>
        ${suppliers.map(supplier => `
            <option value="${supplier.id}">
                ${escapeHtml(supplier.name)}
            </option>
        `).join("")}
    `;
}

async function saveIngredient() {
    const id = document.getElementById("ingredientId").value;

    const payload = {
        name: document.getElementById("ingredientName").value.trim(),
        category_id: valueOrNull(document.getElementById("ingredientCategory").value),
        supplier_id: valueOrNull(document.getElementById("ingredientSupplier").value),
        purchase_unit: document.getElementById("purchaseUnit").value.trim(),
        recipe_unit: document.getElementById("recipeUnit").value.trim(),
        purchase_size: Number(document.getElementById("purchaseSize").value),
        purchase_price: Number(document.getElementById("purchasePrice").value),
        quantity_on_hand: Number(document.getElementById("quantityOnHand").value || 0),
        minimum_quantity: Number(document.getElementById("minimumQuantity").value || 0),
        notes: document.getElementById("ingredientNotes").value.trim()
    };

    if (!payload.name) {
        alert("Please enter an ingredient name.");
        return;
    }

    if (!payload.purchase_unit || !payload.recipe_unit) {
        alert("Please enter purchase and recipe units.");
        return;
    }

    const query = id
        ? supabaseClient.from("ingredients").update(payload).eq("id", id)
        : supabaseClient.from("ingredients").insert(payload);

    const { error } = await query;

    if (error) {
        console.error(error);
        alert(error.message);
        return;
    }

    closeIngredientModal();
    await loadInventory();
}

async function deleteIngredient(id, name) {
    // BUG-14: check real usage first and give a friendly, specific warning
    // instead of only surfacing the database's raw foreign-key error after
    // the fact. The database itself still safely blocks the delete either
    // way (RESTRICT/NO ACTION foreign keys) — this is a friendlier
    // pre-check, not a replacement for that safety.
    const [{ count: recipeUsage, error: recipeUsageError }, { count: packagingUsage, error: packagingUsageError }] =
        await Promise.all([
            supabaseClient
                .from("recipe_ingredients")
                .select("id", { count: "exact", head: true })
                .eq("ingredient_id", id),
            supabaseClient
                .from("packaging_profile_items")
                .select("id", { count: "exact", head: true })
                .eq("ingredient_id", id)
        ]);

    if (recipeUsageError || packagingUsageError) {
        console.error(recipeUsageError || packagingUsageError);
        alert((recipeUsageError || packagingUsageError).message);
        return;
    }

    const usageCount = (recipeUsage || 0) + (packagingUsage || 0);

    if (usageCount > 0) {
        alert(
            `"${name}" is used in ${usageCount} recipe(s) or packaging profile(s) and can't be deleted while it's in use. Remove it from those first.`
        );
        return;
    }

    if (!confirm(`Delete "${name}" from inventory?`)) return;

    const { error } = await supabaseClient
        .from("ingredients")
        .delete()
        .eq("id", id);

    if (error) {
        console.error(error);
        alert(error.message);
        return;
    }

    await loadInventory();
}


/*==================================================
    RESTOCK
==================================================*/

function buildRestockModal() {
    const modal = document.createElement("div");

    modal.id = "restockModal";
    modal.className = "modal-overlay";
    modal.style.display = "none";

    modal.innerHTML = `
        <div class="modal-card">
            <div class="modal-header">
                <h2>Restock Ingredient</h2>

                <button class="modal-close" onclick="closeRestockModal()">
                    ✕
                </button>
            </div>

            <div class="modal-body">
                <input type="hidden" id="restockIngredientId">

                <p id="restockIngredientName"></p>

                <label>Quantity Added</label>
                <input id="restockQuantity" type="number" step="0.01">

                <label>Total Cost $</label>
                <input id="restockCost" type="number" step="0.01">

                <label>Supplier</label>
                <select id="restockSupplier"></select>

                <label>Notes</label>
                <textarea id="restockNotes" rows="3"></textarea>
            </div>

            <div class="modal-footer">
                <button class="secondary-btn" onclick="closeRestockModal()">
                    Cancel
                </button>

                <button class="primary-btn" onclick="saveRestock()">
                    Save Restock
                </button>
            </div>
        </div>
    `;

    return modal;
}

function openRestockModal(id) {
    const ingredient = ingredients.find(item => String(item.id) === String(id));

    if (!ingredient) return;

    // Egg Yolks (or any derived ingredient) cannot be independently
    // restocked -- restocking must happen through its source (Eggs).
    if (DerivedIngredients.isDerived(ingredient)) {
        const source = ingredients.find(item => item.id === ingredient.derived_from_ingredient_id);
        alert(
            `${ingredient.name} is derived from ${source ? source.name : "its source ingredient"} and can't be restocked directly.` +
            (source ? ` Opening a restock for ${source.name} instead.` : "")
        );
        if (source) openRestockModal(source.id);
        return;
    }

    document.getElementById("restockIngredientId").value = ingredient.id;
    document.getElementById("restockIngredientName").textContent =
        `${ingredient.name} (${ingredient.purchase_unit})`;

    document.getElementById("restockQuantity").value = "";
    document.getElementById("restockCost").value = "";
    document.getElementById("restockNotes").value = "";

    const supplierSelect = document.getElementById("restockSupplier");

    supplierSelect.innerHTML = `
        <option value="">No supplier</option>
        ${suppliers.map(supplier => `
            <option value="${supplier.id}">
                ${escapeHtml(supplier.name)}
            </option>
        `).join("")}
    `;

    supplierSelect.value = ingredient.supplier_id || "";

    document.getElementById("restockModal").style.display = "flex";
}

function closeRestockModal() {
    document.getElementById("restockModal").style.display = "none";
}

async function saveRestock() {
    const id = document.getElementById("restockIngredientId").value;
    const quantity = Number(document.getElementById("restockQuantity").value);
    const totalCost = Number(document.getElementById("restockCost").value);
    const supplierId = valueOrNull(document.getElementById("restockSupplier").value);
    const notes = document.getElementById("restockNotes").value.trim();

    const ingredient = ingredients.find(item => String(item.id) === String(id));

    if (!ingredient) return;

    if (!quantity || quantity <= 0) {
        alert("Please enter the quantity added.");
        return;
    }

    if (!totalCost || totalCost < 0) {
        alert("Please enter the total cost.");
        return;
    }

    const newQuantity =
        Number(ingredient.quantity_on_hand || 0) + quantity;

    const updatedPurchasePrice =
        totalCost / (quantity / Number(ingredient.purchase_size || 1));

    const { error: purchaseError } = await supabaseClient
        .from("purchases")
        .insert({
            ingredient_id: ingredient.id,
            supplier_id: supplierId,
            quantity,
            total_cost: totalCost,
            notes
        });

    if (purchaseError) {
        console.error(purchaseError);
        alert(purchaseError.message);
        return;
    }

    const { error: updateError } = await supabaseClient
        .from("ingredients")
        .update({
            quantity_on_hand: newQuantity,
            purchase_price: updatedPurchasePrice,
            supplier_id: supplierId || ingredient.supplier_id
        })
        .eq("id", ingredient.id);

    if (updateError) {
        console.error(updateError);
        alert(updateError.message);
        return;
    }

    closeRestockModal();
    await loadInventory();
}


/*==================================================
    RECIPES
==================================================*/

function renderRecipes() {
    const container = document.getElementById("recipesList");

    if (!container) return;

    if (!recipes.length) {
        container.innerHTML = "<p>No recipes yet.</p>";
        return;
    }

    container.innerHTML = recipes.map(recipe => `
        <article class="inventory-card">
            <div>
                <h3>${escapeHtml(recipe.name)}</h3>
                <p>${escapeHtml(recipe.category || "Recipe")}</p>
                <small>
                    Yield:
                    ${formatQuantity(recipe.yield_quantity)}
                    ${escapeHtml(recipe.yield_unit)}
                </small>
            </div>

            <div>
                <strong>${usd(getRecipeCost(recipe))}</strong>
                <small>Estimated ingredient cost</small>
            </div>

            <div class="inventory-actions">
                <button class="edit-option-btn" onclick="openRecipeModal('${recipe.id}')">
                    Edit
                </button>

                <button class="edit-option-btn" onclick="duplicateRecipe('${recipe.id}')">
                    Duplicate
                </button>

                <button class="delete-btn" onclick="deleteRecipe('${recipe.id}', '${escapeJs(recipe.name)}')">
                    Delete
                </button>
            </div>
        </article>
    `).join("");
}

function renderRecipeCosting() {
    const container = document.getElementById("recipeCosting");

    if (!container) return;

    if (!recipes.length) {
        container.innerHTML = "<p>No recipes yet.</p>";
        return;
    }

    container.innerHTML = recipes.map(recipe => `
        <div class="recipe-cost-row">
            <strong>${escapeHtml(recipe.name)}</strong>
            <span>${usd(getRecipeCost(recipe))}</span>
        </div>
    `).join("");
}

function buildRecipeModal() {
    const modal = document.createElement("div");

    modal.id = "recipeModal";
    modal.className = "modal-overlay";
    modal.style.display = "none";

    modal.innerHTML = `
        <div class="modal-card large-modal">
            <div class="modal-header">
                <h2 id="recipeModalTitle">Add Recipe</h2>

                <button class="modal-close" onclick="closeRecipeModal()">
                    ✕
                </button>
            </div>

            <div class="modal-body">
                <input type="hidden" id="recipeId">

                <label>Recipe Name</label>
                <input id="recipeName" type="text">

                <label>Category</label>
                <input id="recipeCategory" type="text" placeholder="Bread, Cookie, Dessert">

                <label>Yield Quantity</label>
                <input id="recipeYieldQuantity" type="number" step="0.01" value="1">

                <label>Yield Unit</label>
                <input id="recipeYieldUnit" type="text" value="item">

                <label>Notes</label>
                <textarea id="recipeNotes" rows="3"></textarea>

                <hr>

               <hr>

<h3>Ingredients</h3>

<div id="recipeIngredientRows"></div>

<button
    class="secondary-btn"
    type="button"
    onclick="addRecipeIngredientRow()">

    + Add Ingredient

</button>

<hr>

<h3>Recipe Components</h3>

<div id="recipeComponentRows"></div>

<button
    class="secondary-btn"
    type="button"
    onclick="addRecipeComponentRow()">

    + Add Component

</button>
            </div>

            <div class="modal-footer">
                <button class="secondary-btn" onclick="closeRecipeModal()">
                    Cancel
                </button>

                <button class="primary-btn" onclick="saveRecipe()">
                    Save Recipe
                </button>
            </div>
        </div>
    `;

    return modal;
}

function openRecipeModal(id = null) {
    const recipe = id
        ? recipes.find(item => String(item.id) === String(id))
        : null;

    document.getElementById("recipeModalTitle").textContent =
        recipe ? "Edit Recipe" : "Add Recipe";

    document.getElementById("recipeId").value =
        recipe ? recipe.id : "";

    document.getElementById("recipeName").value =
        recipe ? recipe.name : "";

    document.getElementById("recipeCategory").value =
        recipe ? recipe.category || "" : "";

    document.getElementById("recipeYieldQuantity").value =
        recipe ? recipe.yield_quantity || 1 : 1;

    document.getElementById("recipeYieldUnit").value =
        recipe ? recipe.yield_unit || "item" : "item";

    document.getElementById("recipeNotes").value =
        recipe ? recipe.notes || "" : "";

    const rows =
    document.getElementById("recipeIngredientRows");

rows.innerHTML = "";

const componentRows =
    document.getElementById("recipeComponentRows");

componentRows.innerHTML = "";

if (recipe?.recipe_ingredients?.length) {

    recipe.recipe_ingredients.forEach(item => {

        addRecipeIngredientRow(
            item.ingredient_id,
            item.quantity
        );

    });

}
else {

    addRecipeIngredientRow();

}

if (recipe?.recipe_components?.length) {

    recipe.recipe_components.forEach(component => {

        addRecipeComponentRow(

            component.component_recipe_id,

            component.quantity_used,

            component.quantity_unit

        );

    });

}

document.getElementById("recipeModal").style.display = "flex";
}

function closeRecipeModal() {
    document.getElementById("recipeModal").style.display = "none";
}

/** The recipe editor's ingredient dropdown must clearly distinguish a
 * physical, independently-purchased ingredient from a derived one
 * (Egg Yolks) so an admin picking an ingredient can see at a glance
 * that "Egg Yolks" is not a second, independently-stocked item --
 * without inventing a second editor or hiding it from the list. */
function recipeIngredientOptionLabel(ingredient) {
    if (!DerivedIngredients.isDerived(ingredient)) return ingredient.name;
    const source = ingredients.find(item => item.id === ingredient.derived_from_ingredient_id);
    return `${ingredient.name} — derived from ${source ? source.name : "another ingredient"}`;
}

function addRecipeIngredientRow(
    ingredientId = "",
    quantity = ""
) {

    const container =
        document.getElementById(
            "recipeIngredientRows"
        );

    if (!container) return;

    const row =
        document.createElement("div");

    row.className =
        "recipe-ingredient-row";

    row.innerHTML = `
        <select class="recipeIngredientSelect">

            <option value="">
                Choose Ingredient
            </option>

            ${ingredients.map(ingredient => `
                <option value="${ingredient.id}">
                    ${escapeHtml(recipeIngredientOptionLabel(ingredient))}
                </option>
            `).join("")}

        </select>

        <input
            class="recipeIngredientQuantity"
            type="number"
            step="0.01"
            placeholder="Quantity">

        <button
            class="delete-btn"
            type="button"
            onclick="this.parentElement.remove()">

            Remove

        </button>
    `;

    container.appendChild(row);

    row.querySelector(
        ".recipeIngredientSelect"
    ).value = ingredientId;

    row.querySelector(
        ".recipeIngredientQuantity"
    ).value = quantity;

}

function addRecipeComponentRow(
    recipeId = "",
    quantity = "",
    unit = "item"
) {

    const container =
        document.getElementById("recipeComponentRows");

    const currentRecipe =
        document.getElementById("recipeId").value;

    const row =
        document.createElement("div");

    row.className = "recipe-component-row";

    row.innerHTML = `

<select class="recipeComponentSelect">

<option value="">Choose Recipe</option>

${recipes
.filter(r => String(r.id) !== String(currentRecipe))
.map(recipe => `
<option value="${recipe.id}">
${escapeHtml(recipe.name)}
(${recipe.yield_quantity} ${recipe.yield_unit})
</option>
`).join("")}

</select>

<input
class="recipeComponentQuantity"
type="number"
step="0.01"
placeholder="Quantity">

<select class="recipeComponentUnit">

    <option value="item">item</option>
    <option value="each">each</option>

    <option value="g">g</option>
    <option value="kg">kg</option>

    <option value="mL">mL</option>
    <option value="L">L</option>

</select>

<button
class="delete-btn"
type="button"
onclick="this.parentElement.remove()">

Remove

</button>

`;

    container.appendChild(row);

    row.querySelector(".recipeComponentSelect").value =
        recipeId;

    row.querySelector(".recipeComponentQuantity").value =
        quantity;

    row.querySelector(".recipeComponentUnit").value =
        unit;

}

async function saveRecipe() {
    const id = document.getElementById("recipeId").value;

    const payload = {
        name: document.getElementById("recipeName").value.trim(),
        category: document.getElementById("recipeCategory").value.trim(),
        yield_quantity: Number(document.getElementById("recipeYieldQuantity").value || 1),
        yield_unit: document.getElementById("recipeYieldUnit").value.trim(),
        notes: document.getElementById("recipeNotes").value.trim()
    };

    if (!payload.name) {
        alert("Please enter a recipe name.");
        return;
    }

    const query = id
        ? supabaseClient.from("recipes").update(payload).eq("id", id).select().single()
        : supabaseClient.from("recipes").insert(payload).select().single();

    const { data: savedRecipe, error } = await query;

    if (error) {
        console.error(error);
        alert(error.message);
        return;
    }

    const recipeId = savedRecipe.id;

    await supabaseClient
        .from("recipe_ingredients")
        .delete()
        .eq("recipe_id", recipeId);

    const ingredientRows = [
    ...document.querySelectorAll("#recipeIngredientRows .recipe-ingredient-row")
];

    const recipeIngredients = ingredientRows
        .map(row => ({
            recipe_id: recipeId,
            ingredient_id: valueOrNull(row.querySelector(".recipeIngredientSelect").value),
            quantity: Number(row.querySelector(".recipeIngredientQuantity").value)
        }))
        .filter(item => item.ingredient_id && item.quantity > 0);

    if (recipeIngredients.length) {
        const { error: ingredientError } = await supabaseClient
            .from("recipe_ingredients")
            .insert(recipeIngredients);

        if (ingredientError) {
            console.error(ingredientError);
            alert(ingredientError.message);
            return;
        }
    }

    await supabaseClient
    .from("recipe_components")
    .delete()
    .eq("parent_recipe_id", recipeId);

const componentRows = [
    ...document.querySelectorAll("#recipeComponentRows .recipe-component-row")
];

const recipeComponents = componentRows
    .map(row => ({

        parent_recipe_id: recipeId,

        component_recipe_id:
            valueOrNull(
                row.querySelector(".recipeComponentSelect").value
            ),

        quantity_used:
            Number(
                row.querySelector(".recipeComponentQuantity").value
            ),

        quantity_unit:
            row.querySelector(".recipeComponentUnit").value

    }))
    .filter(component =>
        component.component_recipe_id &&
        component.quantity_used > 0
    );

if (recipeComponents.length) {

    const { error: componentError } =
        await supabaseClient
            .from("recipe_components")
            .insert(recipeComponents);

    if (componentError) {

        console.error(componentError);
        alert(componentError.message);
        return;

    }

}

    closeRecipeModal();
    await loadInventory();
}

async function deleteRecipe(id, name) {
    // BUG-14/BUG-20: friendly pre-checks for both usage cases before
    // attempting the delete. The menu-item case was already safely blocked
    // by the database; the component-recipe case previously cascaded
    // silently (ON DELETE CASCADE) and is now also blocked at the database
    // level by a narrowly-scoped migration converting it to RESTRICT — this
    // pre-check just gives a specific, friendly message instead of a raw
    // Postgres error for either case.
    const [{ count: menuUsage, error: menuUsageError }, { count: componentUsage, error: componentUsageError }] =
        await Promise.all([
            supabaseClient
                .from("menu_items")
                .select("id", { count: "exact", head: true })
                .eq("recipe_id", id),
            supabaseClient
                .from("recipe_components")
                .select("id", { count: "exact", head: true })
                .eq("component_recipe_id", id)
        ]);

    if (menuUsageError || componentUsageError) {
        console.error(menuUsageError || componentUsageError);
        alert((menuUsageError || componentUsageError).message);
        return;
    }

    if ((menuUsage || 0) > 0) {
        alert(
            `"${name}" is linked to ${menuUsage} menu item(s) and can't be deleted while it's in use. Update or remove those menu items first.`
        );
        return;
    }

    if ((componentUsage || 0) > 0) {
        alert(
            `"${name}" is used as a component in ${componentUsage} other recipe(s) and can't be deleted while it's in use. Remove it from those recipes first.`
        );
        return;
    }

    if (!confirm(`Delete "${name}"?`)) return;

    const { error } = await supabaseClient
        .from("recipes")
        .delete()
        .eq("id", id);

    if (error) {
        console.error(error);
        alert(error.message);
        return;
    }

    await loadInventory();
}

async function duplicateRecipe(id) {
    const recipe = recipes.find(item => String(item.id) === String(id));

    if (!recipe) return;

    const { data: newRecipe, error } = await supabaseClient
        .from("recipes")
        .insert({
            name: `${recipe.name} Copy`,
            category: recipe.category,
            yield_quantity: recipe.yield_quantity,
            yield_unit: recipe.yield_unit,
            notes: recipe.notes
        })
        .select()
        .single();

    if (error) {
        console.error(error);
        alert(error.message);
        return;
    }

    const copiedIngredients =
        (recipe.recipe_ingredients || []).map(item => ({
            recipe_id: newRecipe.id,
            ingredient_id: item.ingredient_id,
            quantity: item.quantity
        }));

    if (copiedIngredients.length) {
        const { error: copyError } = await supabaseClient
            .from("recipe_ingredients")
            .insert(copiedIngredients);

        if (copyError) {
            console.error(copyError);
            alert(copyError.message);
            return;
        }
    }

    await loadInventory();
}


/*==================================================
    SHOPPING
==================================================*/

function renderShoppingList() {
    const container = document.getElementById("shoppingListContainer");

    if (!container) return;

    const needed = DerivedIngredients.physicalOnly(ingredients).filter(isLowStock);

    if (!needed.length) {
        container.innerHTML = "<p>No shopping needed right now.</p>";
        return;
    }

    container.innerHTML = needed.map(ingredient => {
        // needed is already physical-only (see below) -- a derived
        // ingredient (Egg Yolks) never generates its own line here;
        // buying Eggs is what a low Egg Yolk availability actually means.
        const neededQuantity =
            Number(ingredient.minimum_quantity || 0) -
            Number(ingredient.quantity_on_hand || 0);

        return `
            <div class="shopping-row">
                <label>
                    <input type="checkbox">
                    ${escapeHtml(ingredient.name)}
                </label>

                <strong>
                    Buy at least
                    ${formatQuantity(Math.abs(neededQuantity))}
                    ${escapeHtml(ingredient.purchase_unit)}
                </strong>
            </div>
        `;
    }).join("");
}

function printShoppingList() {
    window.print();
}


/*==================================================
    SUPPLIERS
==================================================*/

function renderSuppliers() {
    const container = document.getElementById("suppliersList");

    if (!container) return;

    if (!suppliers.length) {
        container.innerHTML = "<p>No suppliers yet.</p>";
        return;
    }

    container.innerHTML = suppliers.map(supplier => `
        <div class="supplier-row">
            <strong>${escapeHtml(supplier.name)}</strong>
            <span>
                ${
                    ingredients.filter(item => item.supplier_id === supplier.id).length
                }
                item(s)
            </span>
        </div>
    `).join("");
}


/*==================================================
    COSTING
==================================================*/

function getRecipeCost(recipe) {
    // Sourced from the `recipe_costs` Postgres view via the shared
    // js/recipe-costing.js module (BUG-04/BUG-05) — the same recursive,
    // sub-recipe-aware, mass/volume/count-unit-aware calculation Menu and
    // sale creation already rely on, instead of this page's own former
    // duplicate that ignored sub-recipe components and only understood
    // mass units.
    return RecipeCosting.resolveRecipeCost(recipeCosts, recipe);
}


/*==================================================
    TABS
==================================================*/

function showInventoryTab(tab, button) {
    document
        .querySelectorAll(".inventory-tab-panel")
        .forEach(panel => {
            panel.style.display = "none";
        });

    document.getElementById(`tab-${tab}`).style.display = "block";

    document
        .querySelectorAll(".inventory-tabs .filter-btn")
        .forEach(btn => {
            btn.classList.remove("active");
        });

    button.classList.add("active");
}


/*==================================================
    HELPERS
==================================================*/

function isLowStock(ingredient) {
    return Number(ingredient.quantity_on_hand || 0) <=
        Number(ingredient.minimum_quantity || 0);
}

function setText(id, value) {
    const element = document.getElementById(id);

    if (element) {
        element.textContent = value;
    }
}

function usd(value) {
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD"
    }).format(Number(value || 0));
}

// Sourced from js/quantity-format.js (shared with Production) --
// see that file's header comment for the exact bug this used to have
// (a regex with no decimal-point anchor stripped a meaningful trailing
// zero from plain integers: 680 -> "68", 170 -> "17"). Kept as a thin
// local alias so every existing call site below is unchanged.
function formatQuantity(value) {
    return QuantityFormat.formatQuantity(value);
}

function valueOrNull(value) {
    return value === "" ? null : value;
}

function escapeHtml(value) {
    return String(value || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function escapeJs(value) {
    return String(value || "")
        .replaceAll("\\", "\\\\")
        .replaceAll("'", "\\'")
        .replaceAll('"', "&quot;")
        .replaceAll("\n", " ");
}


function toggleInventoryCategory(button) {

    const category =
        button.parentElement;

    const body =
        button.nextElementSibling;

    const arrow =
        button.querySelector(".inventory-category-arrow");

    const isOpen =
        category.classList.contains("open");

    if (isOpen) {

        body.style.maxHeight =
            body.scrollHeight + "px";

        requestAnimationFrame(() => {

            body.style.maxHeight = "0px";
            body.style.opacity = "0";

        });

        category.classList.remove("open");

    }

    else {

        category.classList.add("open");

        body.style.display = "grid";

        body.style.maxHeight = "0px";
        body.style.opacity = "0";

        requestAnimationFrame(() => {

            body.style.maxHeight =
                body.scrollHeight + "px";

            body.style.opacity = "1";

        });

    }

    body.addEventListener("transitionend", function handler() {

        if (category.classList.contains("open")) {

            body.style.maxHeight = "none";

        }

        body.removeEventListener("transitionend", handler);

    });

}

/*==================================================
    GLOBAL EXPORTS
==================================================*/

window.showInventoryTab = showInventoryTab;

window.openIngredientModal = openIngredientModal;
window.closeIngredientModal = closeIngredientModal;
window.saveIngredient = saveIngredient;
window.deleteIngredient = deleteIngredient;

window.openRestockModal = openRestockModal;
window.closeRestockModal = closeRestockModal;
window.saveRestock = saveRestock;

window.openRecipeModal = openRecipeModal;
window.closeRecipeModal = closeRecipeModal;
window.addRecipeIngredientRow = addRecipeIngredientRow;
window.saveRecipe = saveRecipe;
window.deleteRecipe = deleteRecipe;
window.duplicateRecipe = duplicateRecipe;

window.printShoppingList = printShoppingList;
window.toggleInventoryCategory = toggleInventoryCategory;
