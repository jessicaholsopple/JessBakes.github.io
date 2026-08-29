/* ==========================================
   ADMIN RECIPE CARDS

   A read-only reference/print view over the exact same canonical
   recipe data Inventory and Production already use (recipes,
   recipe_ingredients, recipe_components, menu_items) -- no second
   table, no copy, no new editor. Every write-capable Supabase call
   (`.insert(`, `.update(`, `.delete(`, `.upsert(`) is absent from this
   file by construction; see tests/admin-recipe-cards.test.js's
   "no mutation calls" check.

   Status (active/inactive/unmapped) and every data-quality warning
   are derived by js/recipe-cards-logic.js, purely from stable id
   relationships -- never a name match, never an inner join that could
   silently drop an unmapped or inactive recipe. Batch scaling is
   display-only (js/recipe-scaling.js): it never writes to Supabase,
   and reopening a recipe (or clicking 1x) always reproduces the exact
   saved base values.
   ========================================== */

document.addEventListener("DOMContentLoaded", async () => {
    await requireAuth();

    setupLogout();

    await loadRecipeCardsData();

    handleRecipeCardsDeepLink();
});

/*==================================================
    STATE
==================================================*/

let rcRecipes = [];
let rcMenuItems = [];
let rcComponentUsageIndex = new Map();
let rcRecipeViews = []; // [{ recipe, status, mappings, activeMappings, inactiveMappings, warnings }]
let rcOpenView = null;  // the currently-open detail view, or null
let rcMultiplier = RecipeScaling.DEFAULT_MULTIPLIER;

/*==================================================
    DATA LOADING (read-only)
==================================================*/

async function loadRecipeCardsData() {
    const grid = document.getElementById("recipeCardsGrid");
    if (grid) grid.innerHTML = "<p class=\"rc-empty\">Loading recipes…</p>";

    const [recipesResult, menuItemsResult] = await Promise.all([
        loadAllRecipes(),
        loadAllMenuItemMappings()
    ]);

    if (!recipesResult.ok) {
        if (grid) {
            grid.innerHTML = "<p class=\"rc-empty\">Unable to load recipes. Please refresh the page.</p>";
        }
        return;
    }

    rcRecipes = recipesResult.data;
    rcMenuItems = menuItemsResult.ok ? menuItemsResult.data : [];

    rcComponentUsageIndex = RecipeCardsLogic.buildComponentUsageIndex(rcRecipes);

    rcRecipeViews = rcRecipes.map(recipe => {
        const mappingInfo = RecipeCardsLogic.deriveRecipeStatus(recipe, rcMenuItems);
        const warnings = RecipeCardsLogic.buildRecipeWarnings(recipe, mappingInfo);
        return { recipe, ...mappingInfo, warnings };
    });

    renderDataWarningBanner();
    renderCategoryFilterOptions();
    renderGrid();
}

/** Mirrors js/admin-inventory.js's own loadRecipes() query shape
 * exactly (same embedded relationships, same lack of an explicit
 * `.order()` on the embedded recipe_ingredients/recipe_components --
 * preserving whatever order the existing recipe system already
 * returns) so every recipe this page can see is exactly what the
 * recipe editor already sees. No `.eq(...)` on any product/status
 * column -- every recipe, regardless of mapping or availability,
 * comes back. Ingredient columns are limited to what this read-only
 * page actually displays (never purchase price/supplier/stock). */
async function loadAllRecipes() {
    const { data, error } = await supabaseClient
        .from("recipes")
        .select(`
            *,
            recipe_ingredients(
                id,
                ingredient_id,
                quantity,
                ingredients(id, name, recipe_unit)
            ),
            recipe_components!recipe_components_parent_recipe_id_fkey(
                id,
                component_recipe_id,
                quantity_used,
                quantity_unit,
                component_recipe:recipes!recipe_components_component_recipe_id_fkey(
                    id,
                    name,
                    yield_quantity,
                    yield_unit
                )
            )
        `)
        .order("name", { ascending: true });

    if (error) {
        console.error("Unable to load recipes:", error);
        return { ok: false, data: [] };
    }

    return { ok: true, data: data || [] };
}

/** ALL menu_items rows with a recipe_id -- deliberately UNFILTERED by
 * `available` so an inactive/retired product's recipe is never
 * silently treated as unmapped. */
async function loadAllMenuItemMappings() {
    const { data, error } = await supabaseClient
        .from("menu_items")
        .select("id, name, available, recipe_id")
        .not("recipe_id", "is", null);

    if (error) {
        console.error("Unable to load menu item mappings:", error);
        return { ok: false, data: [] };
    }

    return { ok: true, data: data || [] };
}

/*==================================================
    DEEP LINK (?recipe=<id> opens that recipe directly)
==================================================*/

function handleRecipeCardsDeepLink() {
    const recipeId = new URLSearchParams(window.location.search).get("recipe");
    if (!recipeId) return;

    const view = rcRecipeViews.find(v => String(v.recipe.id) === String(recipeId));
    if (view) openRecipeDetail(view.recipe.id);
}

/*==================================================
    DATA-QUALITY WARNING BANNER (page-level, non-destructive)
==================================================*/

function renderDataWarningBanner() {
    const banner = document.getElementById("recipeCardsWarningBanner");
    if (!banner) return;

    const flagged = rcRecipeViews.filter(v => v.warnings.length > 0);

    if (!flagged.length) {
        banner.hidden = true;
        banner.innerHTML = "";
        return;
    }

    banner.hidden = false;
    banner.innerHTML = `
        <strong>${flagged.length} recipe${flagged.length === 1 ? "" : "s"} ${flagged.length === 1 ? "has" : "have"} a data-quality note.</strong>
        This is informational only — nothing has been changed automatically. Open a flagged recipe to see the detail.
    `;
}

/*==================================================
    FILTER OPTIONS
==================================================*/

function renderCategoryFilterOptions() {
    const select = document.getElementById("recipeCardsCategoryFilter");
    if (!select) return;

    const current = select.value || "all";
    const categories = RecipeCardsLogic.distinctCategories(rcRecipes);

    select.innerHTML = [
        `<option value="all">All categories</option>`,
        ...categories.map(cat => `<option value="${escapeHtml(cat)}">${escapeHtml(cat)}</option>`)
    ].join("");

    select.value = categories.includes(current) || current === "all" ? current : "all";
}

/*==================================================
    SUMMARY GRID
==================================================*/

function currentFilters() {
    return {
        search: document.getElementById("recipeCardsSearch")?.value || "",
        category: document.getElementById("recipeCardsCategoryFilter")?.value || "all",
        status: document.getElementById("recipeCardsStatusFilter")?.value || "all"
    };
}

function statusLabel(status) {
    if (status === "active") return "Active";
    if (status === "inactive") return "Inactive";
    return "Unmapped";
}

function linkedProductText(view) {
    if (!view.mappings.length) {
        const usedIn = rcComponentUsageIndex.get(String(view.recipe.id)) || [];
        if (usedIn.length) {
            return `Used in ${usedIn.length} other recipe${usedIn.length === 1 ? "" : "s"}`;
        }
        return "No linked menu product";
    }
    return view.mappings
        .map(mi => `${mi.name}${mi.available ? "" : " (inactive)"}`)
        .join(", ");
}

function renderGrid() {
    const grid = document.getElementById("recipeCardsGrid");
    const countEl = document.getElementById("recipeCardsResultCount");
    if (!grid) return;

    const visible = RecipeCardsLogic.filterRecipes(rcRecipeViews, currentFilters());

    if (countEl) {
        countEl.textContent = `${visible.length} recipe${visible.length === 1 ? "" : "s"} shown of ${rcRecipeViews.length} total`;
    }

    if (!visible.length) {
        grid.innerHTML = `<p class="rc-empty">No recipes match your search/filters.</p>`;
        return;
    }

    grid.innerHTML = visible.map(view => {
        const r = view.recipe;
        const ingredientCount = (r.recipe_ingredients || []).length;
        const warningBadge = view.warnings.length
            ? `<span class="rc-warning-pill" title="${escapeHtml(view.warnings.join(" "))}">⚠ ${view.warnings.length}</span>`
            : "";

        return `
            <article class="rc-card">
                <div class="rc-card-top">
                    <h3>${escapeHtml(r.name)}</h3>
                    <span class="rc-status rc-status-${view.status}">${statusLabel(view.status)}</span>
                </div>
                <p class="rc-card-category">${r.category ? escapeHtml(r.category) : "Uncategorized"}</p>
                <div class="rc-card-stats">
                    <div><span>Yield</span><strong>${formatYield(r)}</strong></div>
                    <div><span>Ingredients</span><strong>${ingredientCount}</strong></div>
                </div>
                <p class="rc-card-linked">${escapeHtml(linkedProductText(view))}</p>
                ${warningBadge}
                <div class="rc-card-actions">
                    <button type="button" class="primary-btn" onclick="openRecipeDetail('${r.id}')">View Recipe</button>
                    <button type="button" class="secondary-btn" onclick="printRecipeById('${r.id}')">Print Recipe</button>
                    <a class="edit-option-btn" href="inventory.html?recipe=${encodeURIComponent(r.id)}">Edit Recipe</a>
                </div>
            </article>
        `;
    }).join("");
}

function formatYield(recipe) {
    const qty = QuantityFormat.formatQuantity(recipe.yield_quantity);
    const unit = recipe.yield_unit ? escapeHtml(recipe.yield_unit) : "";
    return `${qty}${unit ? " " + unit : ""}`;
}

/*==================================================
    RECIPE DETAIL (view-only)
==================================================*/

function openRecipeDetail(id) {
    const view = rcRecipeViews.find(v => String(v.recipe.id) === String(id));
    if (!view) return;

    rcOpenView = view;
    rcMultiplier = RecipeScaling.DEFAULT_MULTIPLIER; // always default to 1x on open

    const customInput = document.getElementById("rcCustomMultiplier");
    if (customInput) customInput.value = "";
    hideScaleError();

    renderDetail();

    const editLink = document.getElementById("rcEditLink");
    if (editLink) editLink.href = `inventory.html?recipe=${encodeURIComponent(view.recipe.id)}`;

    document.getElementById("recipeDetailModal").style.display = "flex";
}

function closeDetail() {
    document.getElementById("recipeDetailModal").style.display = "none";
    rcOpenView = null;
}

function renderScalePresets() {
    const container = document.getElementById("rcScalePresets");
    if (!container) return;

    container.innerHTML = RecipeScaling.PRESET_MULTIPLIERS.map(value => {
        const isActive = value === rcMultiplier;
        return `<button type="button" class="rc-scale-btn${isActive ? " active" : ""}" onclick="setMultiplier(${value})">${value}×</button>`;
    }).join("");
}

function setMultiplier(value) {
    const parsed = RecipeScaling.parseMultiplier(value);
    if (parsed === null) {
        showScaleError("Enter a multiplier greater than 0.");
        return;
    }
    rcMultiplier = parsed;
    hideScaleError();
    const customInput = document.getElementById("rcCustomMultiplier");
    if (customInput) customInput.value = "";
    renderDetail();
}

function applyCustomMultiplier() {
    const raw = document.getElementById("rcCustomMultiplier")?.value;
    const parsed = RecipeScaling.parseMultiplier(raw);
    if (parsed === null) {
        showScaleError("Enter a multiplier greater than 0.");
        return;
    }
    rcMultiplier = parsed;
    hideScaleError();
    renderDetail();
}

function showScaleError(message) {
    const el = document.getElementById("rcScaleError");
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
}

function hideScaleError() {
    const el = document.getElementById("rcScaleError");
    if (!el) return;
    el.hidden = true;
    el.textContent = "";
}

function renderDetail() {
    if (!rcOpenView) return;
    const view = rcOpenView;
    const r = view.recipe;

    document.getElementById("rcDetailName").textContent = r.name;

    const metaParts = [r.category || "Uncategorized", statusLabel(view.status)];
    document.getElementById("rcDetailMeta").textContent = metaParts.join(" · ");

    renderScalePresets();

    const scaledYieldQty = RecipeScaling.scaleYield(r.yield_quantity, rcMultiplier);
    const yieldLine = scaledYieldQty === null
        ? "Yield unavailable"
        : `${QuantityFormat.formatQuantity(scaledYieldQty)} ${escapeHtml(r.yield_unit || "")}`.trim();
    const multiplierLabel = RecipeScaling.isBaseMultiplier(rcMultiplier) ? "1× (base recipe)" : `${rcMultiplier}× batch`;
    document.getElementById("rcScaledYield").innerHTML =
        `<strong>${multiplierLabel}</strong> — Yield: ${yieldLine}`;

    // Warnings
    const warningsEl = document.getElementById("rcDetailWarnings");
    if (view.warnings.length) {
        warningsEl.hidden = false;
        warningsEl.innerHTML = `<strong>Data-quality note${view.warnings.length === 1 ? "" : "s"}:</strong><ul>${
            view.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join("")
        }</ul>`;
    } else {
        warningsEl.hidden = true;
        warningsEl.innerHTML = "";
    }

    // Ingredients
    document.getElementById("rcIngredientList").innerHTML = renderIngredientListHtml(r.recipe_ingredients, rcMultiplier);

    // Components (sub-recipes THIS recipe is made of)
    const componentSection = document.getElementById("rcComponentSection");
    const components = r.recipe_components || [];
    if (components.length) {
        componentSection.hidden = false;
        document.getElementById("rcComponentList").innerHTML = renderComponentListHtml(components, rcMultiplier);
    } else {
        componentSection.hidden = true;
    }

    // Used as a component elsewhere
    const usedInSection = document.getElementById("rcUsedInSection");
    const usedIn = rcComponentUsageIndex.get(String(r.id)) || [];
    if (usedIn.length) {
        usedInSection.hidden = false;
        document.getElementById("rcUsedInText").textContent =
            usedIn.map(u => u.parentName).join(", ");
    } else {
        usedInSection.hidden = true;
    }

    // Notes / instructions -- only ever the recipe's own stored notes
    // field. Never invented from the ingredient list.
    const notesEl = document.getElementById("rcNotes");
    if (r.notes && String(r.notes).trim()) {
        notesEl.textContent = r.notes;
    } else {
        notesEl.textContent = "No preparation instructions have been saved for this recipe.";
    }
}

// Count-family units (whole items, never weight/volume) read better
// without a redundant unit word -- "4 Eggs" / "1 Egg", not "4 each
// Eggs" / "1 each Eggs". Every other unit (g, kg, mL, cups, ...) keeps
// showing its unit exactly as before ("250 g Butter"). Mirrors the
// same count-unit family js/recipe-scaling.js and js/admin-
// production.js already recognize.
const RC_COUNT_UNITS = new Set(["each", "item", "items", "count", "piece", "pieces", "unit", "units"]);

function isCountUnit(unit) {
    return RC_COUNT_UNITS.has(String(unit || "").trim().toLowerCase());
}

function renderIngredientListHtml(ingredientRows, multiplier) {
    const rows = ingredientRows || [];
    if (!rows.length) {
        return `<li class="rc-ingredient-missing">No ingredients saved for this recipe.</li>`;
    }
    return rows.map(row => {
        if (!row.ingredient_id || !row.ingredients) {
            return `<li class="rc-ingredient-missing">⚠ A saved ingredient reference could not be found.</li>`;
        }
        const scaled = RecipeScaling.scaleQuantity(row.quantity, multiplier);
        const qtyText = scaled === null ? "—" : QuantityFormat.formatQuantity(scaled);

        // A count-unit ingredient (Eggs, Egg Yolks, ...) shows just the
        // quantity next to a grammatically correct singular/plural
        // name -- the stored canonical name ("Eggs", "Egg Yolks") is
        // never changed, only how it's displayed alongside this
        // specific (possibly scaled) quantity.
        if (row.ingredients.recipe_unit && isCountUnit(row.ingredients.recipe_unit)) {
            const displayName = IngredientNaming
                ? IngredientNaming.pluralDisplayName(row.ingredients.name, scaled)
                : row.ingredients.name;
            return `<li><span class="rc-ingredient-qty">${qtyText}</span><span class="rc-ingredient-name">${escapeHtml(displayName)}</span></li>`;
        }

        const unit = row.ingredients.recipe_unit
            ? escapeHtml(row.ingredients.recipe_unit)
            : `<span class="rc-ingredient-missing-inline">no unit saved</span>`;
        return `<li><span class="rc-ingredient-qty">${qtyText} ${unit}</span><span class="rc-ingredient-name">${escapeHtml(row.ingredients.name)}</span></li>`;
    }).join("");
}

function renderComponentListHtml(componentRows, multiplier) {
    return (componentRows || []).map(row => {
        if (!row.component_recipe_id || !row.component_recipe) {
            return `<li class="rc-ingredient-missing">⚠ A saved recipe-component reference could not be found.</li>`;
        }
        const scaled = RecipeScaling.scaleQuantity(row.quantity_used, multiplier);
        const qtyText = scaled === null ? "—" : QuantityFormat.formatQuantity(scaled);
        const unit = row.quantity_unit ? escapeHtml(row.quantity_unit) : "";
        return `<li><span class="rc-ingredient-qty">${qtyText} ${unit}</span><span class="rc-ingredient-name">${escapeHtml(row.component_recipe.name)}</span></li>`;
    }).join("");
}

/*==================================================
    PRINTING (display/print only -- no data is ever written)
==================================================*/

function buildPrintableRecipeHtml(view, multiplier) {
    const r = view.recipe;
    const scaledYieldQty = RecipeScaling.scaleYield(r.yield_quantity, multiplier);
    const yieldLine = scaledYieldQty === null
        ? "Yield unavailable"
        : `${QuantityFormat.formatQuantity(scaledYieldQty)} ${escapeHtml(r.yield_unit || "")}`.trim();
    const scaleNote = RecipeScaling.isBaseMultiplier(multiplier) ? "" : `<p class="print-scale-note">${multiplier}× batch</p>`;

    const linked = linkedProductText(view);
    const notes = r.notes && String(r.notes).trim()
        ? escapeHtml(r.notes)
        : "No preparation instructions have been saved for this recipe.";

    const componentsHtml = (r.recipe_components || []).length
        ? `<h4>Made with these recipes</h4><ul>${renderComponentListHtml(r.recipe_components, multiplier)}</ul>`
        : "";

    return `
        <section class="print-recipe">
            <h2>${escapeHtml(r.name)}</h2>
            <p class="print-recipe-meta">${escapeHtml(r.category || "Uncategorized")} · ${escapeHtml(statusLabel(view.status))} · ${escapeHtml(linked)}</p>
            ${scaleNote}
            <p class="print-recipe-yield">Yield: ${yieldLine}</p>
            <h4>Ingredients</h4>
            <ul>${renderIngredientListHtml(r.recipe_ingredients, multiplier)}</ul>
            ${componentsHtml}
            <h4>Recipe Notes</h4>
            <p>${notes}</p>
        </section>
    `;
}

function finishPrint(bodyClass) {
    function cleanup() {
        document.body.classList.remove(bodyClass);
        const area = document.getElementById("printArea");
        if (area) area.innerHTML = "";
        window.removeEventListener("afterprint", cleanup);
    }
    window.addEventListener("afterprint", cleanup);
    window.print();
}

function printOpenRecipe() {
    if (!rcOpenView) return;
    const area = document.getElementById("printArea");
    area.innerHTML = buildPrintableRecipeHtml(rcOpenView, rcMultiplier);
    document.body.classList.add("printing-one");
    finishPrint("printing-one");
}

function printRecipeById(id) {
    const view = rcRecipeViews.find(v => String(v.recipe.id) === String(id));
    if (!view) return;
    const area = document.getElementById("printArea");
    area.innerHTML = buildPrintableRecipeHtml(view, RecipeScaling.DEFAULT_MULTIPLIER);
    document.body.classList.add("printing-one");
    finishPrint("printing-one");
}

function printAllVisible() {
    const visible = RecipeCardsLogic.filterRecipes(rcRecipeViews, currentFilters());
    const area = document.getElementById("printArea");
    area.innerHTML = `<h1 class="print-all-title">Recipe Cards</h1>` +
        visible.map(view => buildPrintableRecipeHtml(view, RecipeScaling.DEFAULT_MULTIPLIER)).join("");
    document.body.classList.add("printing-all");
    finishPrint("printing-all");
}

/*==================================================
    UTIL
==================================================*/

function escapeHtml(value) {
    return String(value || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

window.renderGrid = renderGrid;
window.openRecipeDetail = openRecipeDetail;
window.closeDetail = closeDetail;
window.setMultiplier = setMultiplier;
window.applyCustomMultiplier = applyCustomMultiplier;
window.printOpenRecipe = printOpenRecipe;
window.printRecipeById = printRecipeById;
window.printAllVisible = printAllVisible;
