/*==================================================
    ADMIN MENU
==================================================*/

/*==================================================
    PAGE INITIALIZATION
==================================================*/

document.addEventListener("DOMContentLoaded", async () => {
    await requireAuth();

    setupLogout();
    ensureBallotModals();
    restoreMenuUiState();

    await Promise.all([
        loadMenuManager(),
        loadBallotManager()
    ]);

    restoreMenuScrollPosition();
});

document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;

    closeMenuItemModal();
    closeEditModal();
    closeNewBallotModal();
});

// Persisted defensively, per the redesign's own requirement, even
// though normal save/toggle/delete/duplicate never triggers a real
// reload any more (see MENU ACTIONS below) -- this only matters if
// some future action or a plain browser refresh interrupts the page.
window.addEventListener("beforeunload", persistMenuUiState);


/*==================================================
    MENU STATE
==================================================*/

let menuItems = [];
let recipes = [];
let packagingProfiles = [];

const MENU_CATEGORIES = [
    { key: "bread", label: "Bread" },
    { key: "cookie", label: "Cookies" },
    { key: "dessert", label: "Desserts" },
    { key: "seasonal", label: "Seasonal" }
];

// Toolbar/table state -- lives independently of menuItems so a save,
// toggle, delete, or duplicate (all of which now mutate menuItems in
// place, never refetch) can never reset what the admin was searching
// for, which tab they were on, or which filters were applied.
let menuSearchQuery = "";
let menuActiveCategory = "all";
let menuStatusFilter = "";   // "" | "available" | "unavailable"
let menuTypeFilter = "";     // "" | "standard" | "builder"
let menuFeaturedFilter = ""; // "" | "featured" | "not_featured"
let menuShellBuilt = false;
let menuModalDirty = false;
let menuModalSaving = false;
let menuLastFocusedElement = null;

const MENU_UI_STATE_KEY = "jb_admin_menu_ui_state";

function persistMenuUiState() {
    try {
        sessionStorage.setItem(MENU_UI_STATE_KEY, JSON.stringify({
            search: menuSearchQuery,
            category: menuActiveCategory,
            status: menuStatusFilter,
            type: menuTypeFilter,
            featured: menuFeaturedFilter,
            scrollY: window.scrollY
        }));
    } catch {
        // Not fatal -- e.g. sessionStorage disabled. The in-page state
        // (module-level variables above) is still correct either way;
        // this only affects recovery after an actual page reload.
    }
}

function restoreMenuUiState() {
    try {
        const raw = sessionStorage.getItem(MENU_UI_STATE_KEY);
        if (!raw) return;

        const saved = JSON.parse(raw);
        menuSearchQuery = saved.search || "";
        menuActiveCategory = saved.category || "all";
        menuStatusFilter = saved.status || "";
        menuTypeFilter = saved.type || "";
        menuFeaturedFilter = saved.featured || "";
    } catch {
        // Corrupt/unavailable storage -- fall back to defaults above,
        // never throw and block the page from loading.
    }
}

/** Runs once, after the shell + first filtered render exist, so
 *  there's something tall enough to scroll to. A no-op when there's
 *  no saved position (the common case -- this only matters after an
 *  actual page reload, not after a normal save/toggle/delete). */
function restoreMenuScrollPosition() {
    try {
        const raw = sessionStorage.getItem(MENU_UI_STATE_KEY);
        if (!raw) return;

        const saved = JSON.parse(raw);
        if (typeof saved.scrollY === "number" && saved.scrollY > 0) {
            window.scrollTo(0, saved.scrollY);
        }
    } catch {
        // ignore
    }
}


/*==================================================
    MENU DATA
==================================================*/

async function loadMenuManager() {
    const container = document.getElementById("menuManager");

    if (!container) return;

    // Only the very first load ever shows this -- it replaces nothing
    // but the initial "Loading..." placeholder already in the static
    // HTML. Every later data change (save/toggle/delete/duplicate)
    // mutates menuItems in place and re-renders just the table body
    // (see MENU ACTIONS below), so this teardown never runs again and
    // never costs the admin their scroll position, search, or filters.
    if (!menuShellBuilt) {
        container.innerHTML = `<p>Loading menu items...</p>`;
    }

    const [
    menuResult,
    recipeResult,
    packagingResult
] = await Promise.all([

    supabaseClient
        .from("menu_items")
        .select("*")
        .order("category", { ascending: true })
        .order("sort_order", { ascending: true })
        .order("name"),

    supabaseClient
        .from("recipes")
        .select("*")
        .order("name"),

    supabaseClient
        .from("packaging_profiles")
        .select("*")
        .order("name")

]);

const data = menuResult.data;
const error = menuResult.error;

recipes = recipeResult.data || [];
packagingProfiles = packagingResult.data || [];

    if (error) {
        console.error(error);

        container.innerHTML = `
            <p>Unable to load menu items.</p>
        `;

        return;
    }

    menuItems = data || [];

    updateMenuStats();
    renderMenuManagerShell();
    applyMenuFilters();
}

function updateMenuStats() {
    const itemCount = document.getElementById("menuItemCount");
    const availableCount = document.getElementById("availableCount");

    if (itemCount) {
        itemCount.textContent = menuItems.length;
    }

    if (availableCount) {
        availableCount.textContent =
            menuItems.filter(item => item.available).length;
    }
}


/*==================================================
    MENU RENDERING
==================================================*/

/** Builds the sticky toolbar (search/tabs/filters/add button) and the
 *  table skeleton exactly once -- idempotent, same convention as
 *  ensureBallotModals()/ensureStockModal() elsewhere in this codebase.
 *  Never rebuilt on a data change, which is what lets the admin's
 *  search text, active tab, filter selections, and scroll position
 *  all survive a save/toggle/delete/duplicate untouched. */
function renderMenuManagerShell() {
    const container = document.getElementById("menuManager");

    if (!container || menuShellBuilt) return;

    container.innerHTML = `
        <div class="menu-manager-toolbar">
            <div class="menu-toolbar-row">
                <input
                    type="text"
                    id="menuSearchInput"
                    class="menu-search-input"
                    placeholder="Search by item name...">

                <select id="menuStatusFilterSelect">
                    <option value="">All Availability</option>
                    <option value="available">Available</option>
                    <option value="unavailable">Unavailable</option>
                </select>

                <select id="menuTypeFilterSelect">
                    <option value="">All Types</option>
                    <option value="standard">Standard</option>
                    <option value="builder">Mix & Match Builder</option>
                </select>

                <select id="menuFeaturedFilterSelect">
                    <option value="">All Items</option>
                    <option value="featured">Featured Only</option>
                    <option value="not_featured">Not Featured</option>
                </select>

                <button
                    class="approve-btn"
                    type="button"
                    onclick="openMenuItemModal(menuActiveCategory !== 'all' ? menuActiveCategory : null)">
                    + Add Menu Item
                </button>

                <a class="menu-stock-link" href="menu-stock.html">
                    Manage Freezer Stock →
                </a>
            </div>

            <div class="menu-category-tabs" role="tablist" aria-label="Filter by category" id="menuCategoryTabs">
                <button
                    type="button"
                    class="menu-category-tab"
                    role="tab"
                    data-category="all"
                    onclick="setMenuCategoryFilter('all')">
                    All Items
                </button>

                ${MENU_CATEGORIES.map(category => `
                    <button
                        type="button"
                        class="menu-category-tab"
                        role="tab"
                        data-category="${category.key}"
                        onclick="setMenuCategoryFilter('${category.key}')">
                        ${category.label}
                    </button>
                `).join("")}
            </div>

            <p class="menu-results-count" id="menuResultsCount"></p>
        </div>

        <div class="table-wrapper">
            <table class="admin-table menu-items-table">
                <thead>
                    <tr>
                        <th>Item</th>
                        <th>Category</th>
                        <th>Type</th>
                        <th>Price</th>
                        <th>Available</th>
                        <th>Featured</th>
                        <th>Sort</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody id="menuTableBody"></tbody>
            </table>
        </div>
    `;

    menuShellBuilt = true;

    document.getElementById("menuSearchInput").value = menuSearchQuery;
    document.getElementById("menuStatusFilterSelect").value = menuStatusFilter;
    document.getElementById("menuTypeFilterSelect").value = menuTypeFilter;
    document.getElementById("menuFeaturedFilterSelect").value = menuFeaturedFilter;

    let searchDebounce = null;
    document.getElementById("menuSearchInput").addEventListener("input", (event) => {
        menuSearchQuery = event.target.value;
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => {
            applyMenuFilters();
            persistMenuUiState();
        }, 150);
    });

    document.getElementById("menuStatusFilterSelect").addEventListener("change", (event) => {
        menuStatusFilter = event.target.value;
        applyMenuFilters();
        persistMenuUiState();
    });

    document.getElementById("menuTypeFilterSelect").addEventListener("change", (event) => {
        menuTypeFilter = event.target.value;
        applyMenuFilters();
        persistMenuUiState();
    });

    document.getElementById("menuFeaturedFilterSelect").addEventListener("change", (event) => {
        menuFeaturedFilter = event.target.value;
        applyMenuFilters();
        persistMenuUiState();
    });

    updateMenuCategoryTabsUi();
}

function setMenuCategoryFilter(categoryKey) {
    menuActiveCategory = categoryKey;
    updateMenuCategoryTabsUi();
    applyMenuFilters();
    persistMenuUiState();
}

function updateMenuCategoryTabsUi() {
    const tabs = document.getElementById("menuCategoryTabs");
    if (!tabs) return;

    tabs.querySelectorAll(".menu-category-tab").forEach(tab => {
        const isActive = tab.dataset.category === menuActiveCategory;
        tab.classList.toggle("is-active", isActive);
        tab.setAttribute("aria-selected", isActive ? "true" : "false");
    });
}

/** The one function every filter/search/tab control and every data
 *  mutation (save/toggle/delete/duplicate/sort) funnels through. It
 *  only ever touches #menuTableBody and the three summary numbers --
 *  never the toolbar/search/tab controls themselves -- so nothing the
 *  admin typed or selected is ever reset by it. */
function applyMenuFilters() {
    // Keeps the page-level overview cards (#menuItemCount/#availableCount,
    // already shared with the Ballot section above) correct after every
    // mutation too -- not just the initial load.
    updateMenuStats();

    const search = menuSearchQuery.trim().toLowerCase();

    const filtered = menuItems.filter(item => {
        if (menuActiveCategory !== "all" && item.category !== menuActiveCategory) return false;
        if (search && !item.name.toLowerCase().includes(search)) return false;

        if (menuStatusFilter === "available" && !item.available) return false;
        if (menuStatusFilter === "unavailable" && item.available) return false;

        if (menuTypeFilter && (item.product_type || "standard") !== menuTypeFilter) return false;

        if (menuFeaturedFilter === "featured" && !item.featured) return false;
        if (menuFeaturedFilter === "not_featured" && item.featured) return false;

        return true;
    }).sort(sortMenuCategoryItems);

    renderMenuTable(filtered);

    const countLabel = document.getElementById("menuResultsCount");
    if (countLabel) {
        countLabel.textContent =
            `Showing ${filtered.length} of ${menuItems.length} item${menuItems.length === 1 ? "" : "s"}`;
    }
}

function renderMenuTable(items) {
    const tbody = document.getElementById("menuTableBody");
    if (!tbody) return;

    if (!items.length) {
        tbody.innerHTML = `
            <tr class="menu-empty-row">
                <td colspan="8">No menu items match these filters.</td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = items.map(renderMenuItemRow).join("");
}

const MENU_CATEGORY_LABELS = Object.fromEntries(
    MENU_CATEGORIES.map(category => [category.key, category.label])
);

function renderMenuItemRow(item) {
    const isBuilder = item.product_type === "builder";

    return `
        <tr class="${item.available ? "" : "is-disabled"}">
            <td class="menu-item-name-cell" data-label="Item">
                <strong>${escapeHtml(item.name)}</strong>
                ${!item.available ? `<span class="disabled-pill">Archived</span>` : ""}
                ${isBuilder ? `<span>Builder group: ${escapeHtml(item.builder_group || "Not assigned")}</span>` : ""}
            </td>

            <td data-label="Category">${escapeHtml(MENU_CATEGORY_LABELS[item.category] || item.category)}</td>

            <td data-label="Type">${isBuilder ? "Builder" : "Standard"}</td>

            <td data-label="Price">€${formatMenuPrice(item.price)}</td>

            <td data-label="Available">
                <label class="toggle-switch">
                    <input
                        type="checkbox"
                        ${item.available ? "checked" : ""}
                        onchange="toggleMenuAvailability('${item.id}', ${Boolean(item.available)})">
                    <span class="toggle-track"></span>
                </label>
            </td>

            <td data-label="Featured">
                <label class="toggle-switch">
                    <input
                        type="checkbox"
                        ${item.featured ? "checked" : ""}
                        onchange="toggleFeatured('${item.id}', ${Boolean(item.featured)})">
                    <span class="toggle-track"></span>
                </label>
            </td>

            <td data-label="Sort">
                <div class="menu-sort-cell">
                    <button type="button" class="menu-sort-btn" title="Move earlier" onclick="updateSortOrder('${item.id}', -1)">↑</button>
                    <span>${item.sort_order ?? 0}</span>
                    <button type="button" class="menu-sort-btn" title="Move later" onclick="updateSortOrder('${item.id}', 1)">↓</button>
                </div>
            </td>

            <td data-label="">
                <button type="button" class="menu-edit-btn" onclick="openMenuItemModal(null, '${item.id}')">
                    Edit
                </button>
            </td>
        </tr>
    `;
}

/** Fixed-position confirmation, shown after every successful write
 *  (save/toggle/delete/duplicate/sort). Nothing before this redesign
 *  gave the admin ANY feedback beyond the page silently re-rendering
 *  -- this is new, not a replacement of an existing component. */
function showMenuToast(message, isError = false) {
    let toast = document.getElementById("menuToast");

    if (!toast) {
        toast = document.createElement("div");
        toast.id = "menuToast";
        toast.className = "admin-toast";
        document.body.appendChild(toast);
    }

    toast.textContent = message;
    toast.className = `admin-toast is-visible ${isError ? "is-error" : "is-success"}`;

    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => {
        toast.classList.remove("is-visible");
    }, 3200);
}


/*==================================================
    MENU ITEM MODAL
==================================================*/

function openMenuItemModal(category = null, itemId = null) {
    let modal = document.getElementById("menuItemModal");

    if (!modal) {
        modal = buildMenuItemModal();
        document.body.appendChild(modal);
    }

    // So focus can return to exactly where it came from (the row's
    // Edit button, or the toolbar's Add button) once the modal closes
    // -- keyboard users never lose their place on the page.
    menuLastFocusedElement = document.activeElement;

    const item = itemId
        ? menuItems.find(menuItem => menuItem.id === itemId)
        : null;

    hideMenuModalError();

    const duplicateBtn = document.getElementById("menuDuplicateBtn");
    const deleteBtn = document.getElementById("menuDeleteBtn");
    if (duplicateBtn) duplicateBtn.style.display = item ? "inline-block" : "none";
    if (deleteBtn) deleteBtn.style.display = item ? "inline-block" : "none";

    document.getElementById("menuModalTitle").textContent =
        item ? "Edit Menu Item" : "Add Menu Item";

    document.getElementById("menuItemId").value =
        item ? item.id : "";

    document.getElementById("menuItemName").value =
        item ? item.name : "";

    document.getElementById("menuItemPrice").value =
        item ? item.price : "";

    document.getElementById("menuItemDescription").value =
        item ? item.description || "" : "";

    const effectiveCategory =
        item ? item.category : category || "bread";

    document.getElementById("menuItemCategory").value =
        effectiveCategory;

    document.getElementById("menuProductType").value =
        item?.product_type || "standard";

    document.getElementById("menuBuilderGroup").value =
        item?.builder_group || "";

    document.getElementById("menuBuilderSize").value =
    item?.builder_size ?? 4;

    // Cookie eligibility checkbox (standard, category === "cookie" only).
    // Existing item: reflects whatever builder_group is already set (any
    // truthy value counts as "in" -- the checkbox always writes back the
    // canonical "cookie" group on save). New item: defaults to checked
    // whenever the item is being created in the Cookie category, so a
    // newly added individual cookie is automatically eligible for both
    // Mix & Match selectors without the admin needing to do anything else.
    document.getElementById("menuAvailableInMixMatch").checked = item
        ? Boolean(item.builder_group)
        : effectiveCategory === "cookie";

    // New item defaults to true (the common case -- almost every product
    // is baked from a recipe); an existing item reflects its stored value,
    // defaulting true only when the column is genuinely absent (should
    // never happen post-migration, but never silently treat a real false
    // as true).
    document.getElementById("menuRequiresRecipe").checked =
        item ? item.requires_recipe !== false : true;

    const recipeSelect =
        document.getElementById("menuRecipe");

    recipeSelect.innerHTML =
        '<option value="">Select Recipe</option>';

    recipes.forEach(recipe => {
        recipeSelect.innerHTML += `
            <option value="${recipe.id}">
                ${escapeHtml(recipe.name)}
            </option>
        `;
    });

    recipeSelect.value =
        item?.recipe_id || "";

    const packagingSelect =
        document.getElementById("menuPackaging");

    packagingSelect.innerHTML =
        '<option value="">Select Packaging</option>';

    packagingProfiles.forEach(profile => {
        packagingSelect.innerHTML += `
            <option value="${profile.id}">
                ${escapeHtml(profile.name)}
            </option>
        `;
    });

    packagingSelect.value =
        item?.packaging_profile_id || "";

    document.getElementById("menuRecipeUnitsUsed").value =
        item?.recipe_units_used ?? 1;

    document.getElementById("menuItemSort").value =
        item ? item.sort_order || 0 : 0;

    document.getElementById("menuItemAvailable").checked =
        item ? Boolean(item.available) : true;

    document.getElementById("menuItemFeatured").checked =
        item ? Boolean(item.featured) : false;

    toggleMenuProductFields();

    const saveBtn = document.getElementById("menuSaveBtn");
    if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = "Save Item";
    }
    menuModalSaving = false;

    modal.style.display = "flex";

    // Reset AFTER every field above has been programmatically set --
    // populating the form must never itself count as an unsaved edit.
    menuModalDirty = false;

    const nameInput = document.getElementById("menuItemName");
    if (nameInput) {
        nameInput.focus();
    }
}

function buildMenuItemModal() {
    const modal = document.createElement("div");

    modal.id = "menuItemModal";
    modal.className = "modal-overlay";
    modal.style.display = "none";

    modal.innerHTML = `
        <div class="modal-card">
            <div class="modal-header">
                <h2 id="menuModalTitle">Add Menu Item</h2>

                <button
                    class="modal-close"
                    type="button"
                    onclick="closeMenuItemModal()">
                    ✕
                </button>
            </div>

            <div class="modal-body">
                <div
                    id="menuModalError"
                    class="admin-inline-message is-error"
                    style="display:none;"
                    role="alert"></div>

                <input type="hidden" id="menuItemId">

                <label for="menuItemName">Name</label>
                <input
                    type="text"
                    id="menuItemName"
                    placeholder="Classic Sourdough Boule">

                <label for="menuItemPrice">Price €</label>
                <input
                    type="number"
                    id="menuItemPrice"
                    step="0.01"
                    min="0"
                    placeholder="10">

                <label for="menuItemDescription">Description</label>
                <textarea
                    id="menuItemDescription"
                    rows="5"
                    placeholder="Short menu description"></textarea>

                <label for="menuItemCategory">Category</label>
                <select
                    id="menuItemCategory"
                    onchange="toggleMenuProductFields()">
                    <option value="bread">Bread</option>
                    <option value="cookie">Cookie</option>
                    <option value="dessert">Dessert</option>
                    <option value="seasonal">Seasonal</option>
                </select>

                <label for="menuProductType">Product Type</label>
                <select
                    id="menuProductType"
                    onchange="toggleMenuProductFields()">
                    <option value="standard">Standard Product</option>
                    <option value="builder">Mix & Match Builder</option>
                </select>

               <div id="menuBuilderFields">

    <label for="menuBuilderGroup">Builder Group</label>

    <input
        type="text"
        id="menuBuilderGroup"
        placeholder="cinnamon-roll">

    <label for="menuBuilderSize">
        Number of Items
    </label>

    <input
        id="menuBuilderSize"
        type="number"
        min="1"
        value="4">

    <p class="field-help">
        Number of products required to complete this Mix & Match box.
    </p>

    <p class="field-help">
        Use the same builder group on this builder and every standard product
        that should appear as one of its choices.
        Example: cinnamon-roll
    </p>

</div>

                <div id="menuCookieBuilderField" style="display:none;">
                    <div class="modal-checkboxes">
                        <label>
                            <input
                                type="checkbox"
                                id="menuAvailableInMixMatch">
                            Available in Mix & Match boxes
                        </label>
                    </div>

                    <p class="field-help">
                        When checked, this cookie automatically appears as a
                        choice in both the 6 Mix &amp; Match and 12 Mix &amp; Match
                        selectors on the Menu page. Uncheck to exclude this
                        cookie from Mix &amp; Match boxes.
                    </p>
                </div>

                <div id="menuStandardFields">
                    <div class="modal-checkboxes">
                        <label>
                            <input
                                type="checkbox"
                                id="menuRequiresRecipe"
                                checked
                                onchange="toggleRequiresRecipeField()">
                            This product needs a recipe
                        </label>
                    </div>

                    <p class="field-help">
                        Uncheck only for a product that is legitimately never
                        baked from a recipe (e.g. a packaging-only or merch
                        item). Production will skip its "missing recipe"
                        warning instead of blocking on it.
                    </p>

                    <label for="menuRecipe">Recipe</label>
                    <select id="menuRecipe">
                        <option value="">Select Recipe</option>
                    </select>

                    <label for="menuRecipeUnitsUsed">
                        Recipe Units Used
                    </label>

                    <input
                        id="menuRecipeUnitsUsed"
                        type="number"
                        min="1"
                        step="1"
                        value="1">

                    <p class="field-help">
                        Examples: Bread = 1, single cookie = 1,
                        6-pack = 6, 12-pack = 12.
                    </p>
                </div>

                <label for="menuPackaging">Packaging</label>
                <select id="menuPackaging">
                    <option value="">Select Packaging</option>
                </select>

                <label for="menuItemSort">Sort Order</label>
                <input
                    type="number"
                    id="menuItemSort"
                    step="1"
                    placeholder="1">

                <div class="modal-checkboxes">
                    <label>
                        <input
                            type="checkbox"
                            id="menuItemAvailable">
                        Available
                    </label>

                    <label>
                        <input
                            type="checkbox"
                            id="menuItemFeatured">
                        Featured
                    </label>
                </div>
            </div>

            <div class="modal-footer">
                <button
                    id="menuDeleteBtn"
                    class="delete-btn"
                    type="button"
                    style="display:none; margin-right:auto;"
                    title="Permanently delete -- only allowed for an item that has never been used in any order or sale."
                    onclick="deleteMenuItemFromModal()">
                    Delete
                </button>

                <button
                    id="menuDuplicateBtn"
                    class="secondary-btn"
                    type="button"
                    style="display:none;"
                    onclick="duplicateMenuItemFromModal()">
                    Duplicate
                </button>

                <button
                    class="secondary-btn"
                    type="button"
                    onclick="closeMenuItemModal()">
                    Cancel
                </button>

                <button
                    id="menuSaveBtn"
                    class="primary-btn"
                    type="button"
                    onclick="saveMenuItem()">
                    Save Item
                </button>
            </div>
        </div>
    `;

    // Dirty-tracking via delegation, wired once at build time (not
    // re-attached on every open) -- any real user input/change inside
    // the form marks it dirty; openMenuItemModal() resets the flag
    // back to false AFTER it finishes programmatically populating
    // every field, so loading an item for editing is never itself
    // treated as an unsaved change.
    modal.querySelector(".modal-body").addEventListener("input", () => { menuModalDirty = true; });
    modal.querySelector(".modal-body").addEventListener("change", () => { menuModalDirty = true; });

    return modal;
}

function toggleMenuProductFields() {
    const productType =
        document.getElementById("menuProductType")?.value || "standard";

    const category =
        document.getElementById("menuItemCategory")?.value || "bread";

    const standardFields =
        document.getElementById("menuStandardFields");

    const builderFields =
        document.getElementById("menuBuilderFields");

    const cookieBuilderField =
        document.getElementById("menuCookieBuilderField");

    if (standardFields) {
        standardFields.style.display =
            productType === "standard" ? "block" : "none";
    }

    if (builderFields) {
        builderFields.style.display =
            productType === "builder" ? "block" : "none";
    }

    // Only individually-orderable cookies get the Mix & Match eligibility
    // checkbox -- box/builder products and non-cookie standard products
    // (bread, dessert, seasonal) never show it.
    if (cookieBuilderField) {
        cookieBuilderField.style.display =
            productType === "standard" && category === "cookie" ? "block" : "none";
    }

    toggleRequiresRecipeField();
}

/** Disables (rather than hides) the Recipe select when "This product
 *  needs a recipe" is unchecked -- the choice stays visible/reviewable,
 *  it just can't be edited while irrelevant. Mirrors the requires_recipe
 *  column added for the Production audit (2026-08-27). */
function toggleRequiresRecipeField() {
    const requiresRecipe =
        document.getElementById("menuRequiresRecipe")?.checked ?? true;

    const recipeSelect =
        document.getElementById("menuRecipe");

    if (recipeSelect) {
        recipeSelect.disabled = !requiresRecipe;
    }
}


/** `force=true` skips the unsaved-changes confirmation -- used right
 *  after a successful save, where there's nothing left to discard. A
 *  plain Cancel click, the ✕ button, or Escape all go through the
 *  normal (non-forced) path and must never silently discard an edit
 *  the admin hasn't saved yet. */
function closeMenuItemModal(force = false) {
    const modal = document.getElementById("menuItemModal");

    if (!modal || modal.style.display === "none") return;

    if (!force && menuModalDirty) {
        const discard = confirm("You have unsaved changes. Discard them?");
        if (!discard) return;
    }

    modal.style.display = "none";
    menuModalDirty = false;

    if (menuLastFocusedElement && typeof menuLastFocusedElement.focus === "function") {
        menuLastFocusedElement.focus();
    }
    menuLastFocusedElement = null;
}

function showMenuModalError(message) {
    const banner = document.getElementById("menuModalError");
    if (!banner) return;
    banner.textContent = message;
    banner.style.display = "block";
}

function hideMenuModalError() {
    const banner = document.getElementById("menuModalError");
    if (!banner) return;
    banner.style.display = "none";
    banner.textContent = "";
}


/*==================================================
    MENU ACTIONS
==================================================*/

async function saveMenuItem() {
    const id =
        document.getElementById("menuItemId").value;

    const name =
        document.getElementById("menuItemName").value.trim();

    const price =
        Number(document.getElementById("menuItemPrice").value);

    const description =
        document.getElementById("menuItemDescription").value.trim();

    const category =
        document.getElementById("menuItemCategory").value;

    const productType =
        document.getElementById("menuProductType").value;

    const availableInMixMatch =
        document.getElementById("menuAvailableInMixMatch").checked;

    const rawBuilderGroup =
        document.getElementById("menuBuilderGroup").value.trim() || null;

    // Individually-orderable cookies get their Mix & Match eligibility
    // from the checkbox (always the canonical "cookie" group -- matching
    // both the 6 and 12 Mix & Match builders' own builder_group -- or
    // null when unchecked), never from typed-in text. Every other case
    // (the builder products themselves, and non-cookie standard products
    // such as the existing cinnamon-roll builder lineup) keeps using the
    // raw Builder Group field exactly as before, so nothing about those
    // unrelated products changes.
    const builderGroup =
        productType === "standard" && category === "cookie"
            ? (availableInMixMatch ? "cookie" : null)
            : rawBuilderGroup;

const builderSize =
    Number(
        document.getElementById("menuBuilderSize").value
    ) || 4;

const requiresRecipe =
    document.getElementById("menuRequiresRecipe")?.checked ?? true;

const recipeId =
    document.getElementById("menuRecipe").value || null;

    const packagingProfileId =
        document.getElementById("menuPackaging").value || null;

    const recipeUnitsUsed =
        Number(
            document.getElementById("menuRecipeUnitsUsed").value
        ) || 1;

    const sortOrder =
        Number(document.getElementById("menuItemSort").value || 0);

    const available =
        document.getElementById("menuItemAvailable").checked;

    const featured =
        document.getElementById("menuItemFeatured").checked;

    hideMenuModalError();

    if (!name) {
        showMenuModalError("Please enter an item name.");
        return;
    }

    if (Number.isNaN(price) || price < 0) {
        showMenuModalError("Please enter a valid price.");
        return;
    }

    if (productType === "standard" && requiresRecipe && !recipeId) {
        showMenuModalError("Please select a recipe for this standard product, or uncheck \"This product needs a recipe\" if it legitimately has none.");
        return;
    }

    if (productType === "builder" && !builderGroup) {
        showMenuModalError("Please enter a builder group.");
        return;
    }

    if (!packagingProfileId) {
        showMenuModalError("Please select a packaging profile.");
        return;
    }

    if (menuModalSaving) return; // duplicate-submit guard (double click / double Enter)
    menuModalSaving = true;

    const saveBtn = document.getElementById("menuSaveBtn");
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = "Saving...";
    }

    const payload = {
        name,
        price,
        description,
        category,
        product_type: productType,
        builder_group: builderGroup,

builder_size:
    productType === "builder"
        ? builderSize
        : null,
        recipe_id:
            productType === "standard"
                ? recipeId
                : null,
        // Builder boxes never have a recipe of their own -- their demand
        // comes entirely from expanding their child selections in
        // Production -- so this is always false for them, matching the
        // requires_recipe migration's own backfill. For a standard
        // product it reflects the admin's explicit checkbox choice.
        requires_recipe:
            productType === "standard"
                ? requiresRecipe
                : false,
        packaging_profile_id:
            packagingProfileId,
        recipe_units_used:
            productType === "standard"
                ? recipeUnitsUsed
                : 1,
        sort_order:
            sortOrder,
        available,
        featured
    };

    const query = id
        ? supabaseClient
            .from("menu_items")
            .update(payload)
            .eq("id", id)
            .select()
            .single()
        : supabaseClient
            .from("menu_items")
            .insert(payload)
            .select()
            .single();

    const { data: savedItem, error } = await query;

    menuModalSaving = false;
    if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = "Save Item";
    }

    if (error) {
        console.error(error);
        // Form stays open with every field exactly as the admin left
        // it -- nothing is cleared or reset on a failed save.
        showMenuModalError(error.message);
        return;
    }

    if (id) {
        const index = menuItems.findIndex(menuItem => menuItem.id === id);
        if (index !== -1) menuItems[index] = savedItem;
    } else {
        menuItems.push(savedItem);
    }

    applyMenuFilters();
    showMenuToast(`"${savedItem.name}" saved.`);
    closeMenuItemModal(true);
}


async function toggleMenuAvailability(id, currentlyAvailable) {
    const { data, error } = await supabaseClient
        .from("menu_items")
        .update({
            available: !currentlyAvailable
        })
        .eq("id", id)
        .select()
        .single();

    if (error) {
        console.error(error);
        showMenuToast(error.message, true);
        applyMenuFilters(); // snaps the toggle back to the real (unchanged) value
        return;
    }

    const item = menuItems.find(menuItem => menuItem.id === id);
    if (item) Object.assign(item, data);

    applyMenuFilters();
    showMenuToast(data.available ? `"${data.name}" is now available.` : `"${data.name}" was archived.`);
}

async function toggleFeatured(itemId, currentValue) {
    const { data, error } = await supabaseClient
        .from("menu_items")
        .update({
            featured: !currentValue
        })
        .eq("id", itemId)
        .select()
        .single();

    if (error) {
        console.error(error);
        showMenuToast(error.message, true);
        applyMenuFilters();
        return;
    }

    const item = menuItems.find(menuItem => menuItem.id === itemId);
    if (item) Object.assign(item, data);

    applyMenuFilters();
    showMenuToast(data.featured ? `"${data.name}" is now featured.` : `"${data.name}" is no longer featured.`);
}

/**
 * A menu product referenced by any past order or sale must never be
 * physically deleted -- order_items.menu_item_id / sale_items.menu_item_id
 * both SET NULL (not RESTRICT/CASCADE) on delete, so nothing in Postgres
 * itself stops this at the database level; every historical row would
 * survive with its own frozen name/price/quantity intact, but its link
 * back to this product would be silently severed, and any future
 * reporting that leans on that link (see js/admin-sales.js
 * getItemCategory) would quietly degrade. This is the application-level
 * guard: counts real references so deleteMenuItem can refuse before that
 * ever happens.
 */
async function countMenuItemReferences(itemId) {
    const [orderItemsResult, saleItemsResult] = await Promise.all([
        supabaseClient
            .from("order_items")
            .select("id", { count: "exact", head: true })
            .eq("menu_item_id", itemId),
        supabaseClient
            .from("sale_items")
            .select("id", { count: "exact", head: true })
            .eq("menu_item_id", itemId)
    ]);

    if (orderItemsResult.error || saleItemsResult.error) {
        return { error: orderItemsResult.error || saleItemsResult.error };
    }

    return {
        orderCount: orderItemsResult.count || 0,
        saleCount: saleItemsResult.count || 0
    };
}

async function deleteMenuItem(itemId, itemName) {

    const references = await countMenuItemReferences(itemId);

    if (references.error) {
        console.error(references.error);
        alert(
            `Could not check whether "${itemName}" is used in any past orders or sales, so it was not deleted. Please try again.`
        );
        return;
    }

    const { orderCount, saleCount } = references;

    if (orderCount > 0 || saleCount > 0) {
        alert(
            `"${itemName}" can't be permanently deleted -- it's used in ${orderCount} order${orderCount === 1 ? "" : "s"} and ${saleCount} sale${saleCount === 1 ? "" : "s"}, and deleting it would disconnect that history.\n\nUse Archive instead: it removes "${itemName}" from the public menu, the New Order picker, and Mix & Match selectors right away, while every past order, sale, and report keeps showing it exactly as it was.`
        );
        return;
    }

    const confirmed = confirm(
        `Permanently delete "${itemName}"?\n\nIt has never been used in any order or sale, so this is safe -- but it cannot be undone.`
    );

    if (!confirmed) return;

    const { error } = await supabaseClient
        .from("menu_items")
        .delete()
        .eq("id", itemId);

    if (error) {
        console.error(error);
        showMenuToast(error.message, true);
        return;
    }

    const index = menuItems.findIndex(menuItem => menuItem.id === itemId);
    if (index !== -1) menuItems.splice(index, 1);

    applyMenuFilters();
    showMenuToast(`"${itemName}" deleted.`);
}

/** Wired from the modal footer's Delete button -- looks up the
 *  currently-open item's id/name from the hidden field + in-memory
 *  menuItems so the row-level delete flow above (reference check,
 *  confirmation, in-place removal) is reused exactly as-is. */
async function deleteMenuItemFromModal() {
    const id = document.getElementById("menuItemId").value;
    const item = menuItems.find(menuItem => menuItem.id === id);
    if (!item) return;

    await deleteMenuItem(id, item.name);

    // Only close if the delete actually went through -- a cancelled
    // confirmation or a failed delete must leave the form open with
    // the item's data still showing, same as any other failed save.
    if (!menuItems.some(menuItem => menuItem.id === id)) {
        closeMenuItemModal(true);
    }
}

async function duplicateMenuItemFromModal() {
    const id = document.getElementById("menuItemId").value;
    await duplicateMenuItem(id);
    closeMenuItemModal(true);
}

async function duplicateMenuItem(itemId) {
    const item =
        menuItems.find(menuItem => menuItem.id === itemId);

    if (!item) return;

    const copy = {
        name:
            item.name + " Copy",
        price:
            item.price,
        description:
            item.description,
        category:
            item.category,
        product_type:
            item.product_type || "standard",
        builder_group:
            item.builder_group || null,
        recipe_id:
            item.recipe_id,
        packaging_profile_id:
            item.packaging_profile_id,
        recipe_units_used:
            item.recipe_units_used || 1,
        featured:
            false,
        available:
            item.available,
        sort_order:
            Number(item.sort_order || 0) + 1
    };

    const { data, error } = await supabaseClient
        .from("menu_items")
        .insert(copy)
        .select()
        .single();

    if (error) {
        console.error(error);
        showMenuToast(error.message, true);
        return;
    }

    menuItems.push(data);
    applyMenuFilters();
    showMenuToast(`"${data.name}" created.`);
}


async function updateSortOrder(itemId, direction) {
    const item = menuItems.find(menuItem => menuItem.id === itemId);

    if (!item) return;

    const newOrder = Math.max(
        1,
        Number(item.sort_order || 1) + direction
    );

    const { data, error } = await supabaseClient
        .from("menu_items")
        .update({
            sort_order: newOrder
        })
        .eq("id", itemId)
        .select()
        .single();

    if (error) {
        console.error(error);
        showMenuToast(error.message, true);
        return;
    }

    Object.assign(item, data);
    applyMenuFilters();
}


/*==================================================
    BALLOT DATA
==================================================*/

async function loadBallotManager() {
    const container = document.getElementById("ballotManager");

    if (!container) return;

    container.innerHTML = `<p>Loading ballot...</p>`;

    const [settingsResult, optionsResult, votesResult] = await Promise.all([
        supabaseClient
            .from("ballot_settings")
            .select("*")
            .eq("active", true)
            .limit(1)
            .maybeSingle(),

        supabaseClient
            .from("ballot_options")
            .select("*")
            .eq("active", true)
            .order("category")
            .order("name"),

        supabaseClient
            .from("votes")
            .select("*")
    ]);

    if (settingsResult.error) {
        console.error(settingsResult.error);

        container.innerHTML = `<p>Unable to load ballot settings.</p>`;

        return;
    }

    if (optionsResult.error) {
        console.error(optionsResult.error);

        container.innerHTML = `<p>Unable to load ballot options.</p>`;

        return;
    }

    if (votesResult.error) {
        console.error(votesResult.error);

        container.innerHTML = `<p>Unable to load ballot votes.</p>`;

        return;
    }

    const settings = settingsResult.data;
    const options = optionsResult.data || [];
    const votes = votesResult.data || [];

    updateBallotStats(settings, options);
    renderBallotManager(settings, options, votes);
}

function updateBallotStats(settings, options) {
    const ballotOptionCount = document.getElementById("ballotOptionCount");
    const activeBallot = document.getElementById("activeBallot");

    if (ballotOptionCount) {
        ballotOptionCount.textContent = options.length;
    }

    if (activeBallot) {
        activeBallot.textContent = settings?.active ? "Yes" : "No";
    }
}


/*==================================================
    BALLOT RENDERING
==================================================*/

function renderBallotManager(settings, options, votes) {
    const container = document.getElementById("ballotManager");

    if (!container) return;

    if (!settings) {
        container.innerHTML = `
            <div class="ballot-admin-toolbar">
                <button
                    class="approve-btn"
                    onclick="openNewBallotModal()">
                    Start New Ballot
                </button>
            </div>

            <p>No active ballot found.</p>
        `;

        return;
    }

    const bread = options.filter(option => option.category === "bread");
    const cookies = options.filter(option => option.category === "cookie");
    const desserts = options.filter(option => option.category === "dessert");

    container.innerHTML = `
        <div class="ballot-admin-toolbar">
            <button
                class="approve-btn"
                onclick="openNewBallotModal()">
                Start New Ballot
            </button>
        </div>

        <div class="ballot-admin-overview">
            <div>
                <strong>Status</strong>
                <p>${settings.active ? "Active" : "Closed"}</p>
            </div>

            <div>
                <strong>Voting Ends</strong>
                <p>${formatDate(settings.end_date)}</p>
            </div>

            <div>
                <strong>Total Votes</strong>
                <p>${votes.length}</p>
            </div>
        </div>

        <div class="ballot-date-editor">
            <label for="ballotEndDate">
                Change Voting End Date
            </label>

            <input
                type="date"
                id="ballotEndDate"
                value="${formatDateForInput(settings.end_date)}">

            <button
                class="edit-option-btn"
                onclick="saveBallotEndDate('${settings.id}')">
                Save Date
            </button>
        </div>

        <div class="ballot-admin-grid">
            ${renderBallotCategory("Bread", "bread", bread, votes)}
            ${renderBallotCategory("Cookies", "cookie", cookies, votes)}
            ${renderBallotCategory("Desserts", "dessert", desserts, votes)}
        </div>
    `;
}

function renderBallotCategory(title, category, options, votes) {
    return `
        <div class="ballot-admin-category">
            <div class="ballot-category-header">
                <h3>${title}</h3>

                <button
                    class="add-option-btn"
                    onclick="openNewOptionModal('${category}')">
                    + Add
                </button>
            </div>

            ${
                !options.length
                    ? `<p>No options yet.</p>`
                    : options.map(option => {
                        const voteCount =
                            votes.filter(vote => vote.option_id === option.id).length;

                        return `
                            <div class="ballot-option-row">
                                <div>
                                    <strong>${escapeHtml(option.name)}</strong>
                                    <small>${voteCount} vote${voteCount === 1 ? "" : "s"}</small>
                                </div>

                                <div class="ballot-row-actions">
                                    <button
                                        class="edit-option-btn"
                                        onclick="editBallotOption('${option.id}')">
                                        Edit
                                    </button>

                                    <button
                                        class="remove-option-btn"
                                        onclick="removeBallotOption('${option.id}', '${escapeJs(option.name)}')">
                                        Remove
                                    </button>
                                </div>
                            </div>
                        `;
                    }).join("")
            }
        </div>
    `;
}


/*==================================================
    BALLOT OPTION MODAL
==================================================*/

function ensureBallotModals() {
    if (!document.getElementById("editOptionModal")) {
        document.body.appendChild(buildEditOptionModal());
    }

    if (!document.getElementById("newBallotModal")) {
        document.body.appendChild(buildNewBallotModal());
    }
}

function buildEditOptionModal() {
    const modal = document.createElement("div");

    modal.id = "editOptionModal";
    modal.className = "modal-overlay";
    modal.style.display = "none";

    modal.innerHTML = `
        <div class="modal-card">
            <div class="modal-header">
                <h2 id="optionModalTitle">Edit Ballot Option</h2>

                <button
                    class="modal-close"
                    onclick="closeEditModal()">
                    ✕
                </button>
            </div>

            <div class="modal-body">
                <input type="hidden" id="editOptionId">

                <label>Name</label>
                <input
                    type="text"
                    id="editOptionName">

                <label>Category</label>
                <select id="editOptionCategory">
                    <option value="bread">Bread</option>
                    <option value="cookie">Cookie</option>
                    <option value="dessert">Dessert</option>
                </select>

                <div class="modal-checkboxes">
                    <label>
                        <input
                            type="checkbox"
                            id="editOptionActive">
                        Active
                    </label>
                </div>
            </div>

            <div class="modal-footer">
                <button
                    class="secondary-btn"
                    onclick="closeEditModal()">
                    Cancel
                </button>

                <button
                    class="primary-btn"
                    onclick="saveBallotOption()">
                    Save Changes
                </button>
            </div>
        </div>
    `;

    return modal;
}

function buildNewBallotModal() {
    const modal = document.createElement("div");

    modal.id = "newBallotModal";
    modal.className = "modal-overlay";
    modal.style.display = "none";

    modal.innerHTML = `
        <div class="modal-card">
            <div class="modal-header">
                <h2>Start New Ballot</h2>

                <button
                    class="modal-close"
                    onclick="closeNewBallotModal()">
                    ✕
                </button>
            </div>

            <div class="modal-body">
                <label>Ballot Title</label>
                <input
                    type="text"
                    id="newBallotTitle"
                    placeholder="September Bakery Ballot">

                <label>Voting Ends</label>
                <input
                    type="date"
                    id="newBallotEndDate">

                <hr>

                <h3>Bread Options</h3>
                <div id="breadInputs"></div>

                <button
                    class="secondary-btn"
                    type="button"
                    onclick="addBallotInput('bread')">
                    + Add Bread
                </button>

                <hr>

                <h3>Cookie Options</h3>
                <div id="cookieInputs"></div>

                <button
                    class="secondary-btn"
                    type="button"
                    onclick="addBallotInput('cookie')">
                    + Add Cookie
                </button>

                <hr>

                <h3>Dessert Options</h3>
                <div id="dessertInputs"></div>

                <button
                    class="secondary-btn"
                    type="button"
                    onclick="addBallotInput('dessert')">
                    + Add Dessert
                </button>
            </div>

            <div class="modal-footer">
                <button
                    class="secondary-btn"
                    onclick="closeNewBallotModal()">
                    Cancel
                </button>

                <button
                    class="primary-btn"
                    onclick="startNewBallot()">
                    Start New Ballot
                </button>
            </div>
        </div>
    `;

    return modal;
}

function openNewOptionModal(category) {
    document.getElementById("optionModalTitle").textContent =
        "Add Ballot Option";

    document.getElementById("editOptionId").value = "";
    document.getElementById("editOptionName").value = "";
    document.getElementById("editOptionCategory").value = category;
    document.getElementById("editOptionActive").checked = true;
    document.getElementById("editOptionModal").style.display = "flex";
}

async function editBallotOption(id) {
    const { data, error } = await supabaseClient
        .from("ballot_options")
        .select("*")
        .eq("id", id)
        .single();

    if (error) {
        console.error(error);
        alert(error.message);
        return;
    }

    document.getElementById("optionModalTitle").textContent =
        "Edit Ballot Option";

    document.getElementById("editOptionId").value = data.id;
    document.getElementById("editOptionName").value = data.name;
    document.getElementById("editOptionCategory").value = data.category;
    document.getElementById("editOptionActive").checked = data.active;
    document.getElementById("editOptionModal").style.display = "flex";
}

function closeEditModal() {
    const modal = document.getElementById("editOptionModal");

    if (modal) {
        modal.style.display = "none";
    }
}


/*==================================================
    BALLOT ACTIONS
==================================================*/

async function saveBallotOption() {
    const id = document.getElementById("editOptionId").value;
    const name = document.getElementById("editOptionName").value.trim();
    const category = document.getElementById("editOptionCategory").value;
    const active = document.getElementById("editOptionActive").checked;

    if (!name) {
        alert("Please enter a ballot option.");
        return;
    }

    const payload = {
        name,
        category,
        active
    };

    const query = id
        ? supabaseClient.from("ballot_options").update(payload).eq("id", id)
        : supabaseClient.from("ballot_options").insert(payload);

    const { error } = await query;

    if (error) {
        console.error(error);
        alert(error.message);
        return;
    }

    closeEditModal();
    await loadBallotManager();
}

async function removeBallotOption(id, name) {
    if (!confirm(`Remove "${name}" from this ballot?`)) return;

    const { error } = await supabaseClient
        .from("ballot_options")
        .update({
            active: false
        })
        .eq("id", id);

    if (error) {
        console.error(error);
        alert(error.message);
        return;
    }

    await loadBallotManager();
}

async function saveBallotEndDate(ballotId) {
    const endDate = document.getElementById("ballotEndDate").value;

    if (!endDate) {
        alert("Please select an end date.");
        return;
    }

    const { error } = await supabaseClient
        .from("ballot_settings")
        .update({
            end_date: endDate
        })
        .eq("id", ballotId);

    if (error) {
        console.error(error);
        alert(error.message);
        return;
    }

    await loadBallotManager();
}


/*==================================================
    NEW BALLOT
==================================================*/

function openNewBallotModal() {
    ensureBallotModals();

    document.getElementById("newBallotModal").style.display = "flex";
    document.getElementById("newBallotTitle").value = "";

    const endDate = new Date();
    endDate.setDate(endDate.getDate() + 30);

    document.getElementById("newBallotEndDate").value =
        endDate.toISOString().split("T")[0];

    ["bread", "cookie", "dessert"].forEach(category => {
        const container = document.getElementById(category + "Inputs");

        container.innerHTML = "";

        for (let i = 0; i < 5; i++) {
            addBallotInput(category);
        }
    });
}

function closeNewBallotModal() {
    const modal = document.getElementById("newBallotModal");

    if (modal) {
        modal.style.display = "none";
    }
}

function addBallotInput(category) {
    const container = document.getElementById(category + "Inputs");

    if (!container) return;

    const input = document.createElement("input");

    input.type = "text";
    input.className = "ballot-input";
    input.placeholder = "Option name";

    container.appendChild(input);
}

async function startNewBallot() {
    const title = document
        .getElementById("newBallotTitle")
        .value
        .trim();

    const endDate =
        document.getElementById("newBallotEndDate").value;

    if (!title) {
        alert("Please enter a ballot title.");
        return;
    }

    if (!endDate) {
        alert("Please choose an end date.");
        return;
    }

    const bread = getNewBallotInputs("bread");
    const cookies = getNewBallotInputs("cookie");
    const desserts = getNewBallotInputs("dessert");

    if (!bread.length || !cookies.length || !desserts.length) {
        alert("Please enter at least one option for every category.");
        return;
    }

    if (!confirm(
        "Start a new ballot? This will archive the current ballot and begin a new one."
    )) return;

    const { error: rpcError } =
        await supabaseClient.rpc("prepare_new_ballot");

    if (rpcError) {
        console.error(rpcError);
        alert(rpcError.message);
        return;
    }

    const { data: settings, error: settingsLookupError } =
        await supabaseClient
            .from("ballot_settings")
            .select("id")
            .limit(1)
            .single();

    if (settingsLookupError) {
        console.error(settingsLookupError);
        alert(settingsLookupError.message);
        return;
    }

    const { error: settingsError } =
        await supabaseClient
            .from("ballot_settings")
            .update({
                title,
                description:
                    "Vote for the next bread, cookie, and dessert you'd like to see.",
                start_date: new Date().toISOString(),
                end_date: endDate,
                active: true,
                show_results: true
            })
            .eq("id", settings.id);

    if (settingsError) {
        console.error(settingsError);
        alert(settingsError.message);
        return;
    }

    const options = [
        ...bread.map(name => ({
            category: "bread",
            name,
            active: true
        })),

        ...cookies.map(name => ({
            category: "cookie",
            name,
            active: true
        })),

        ...desserts.map(name => ({
            category: "dessert",
            name,
            active: true
        }))
    ];

    const { error: optionError } =
        await supabaseClient
            .from("ballot_options")
            .insert(options);

    if (optionError) {
        console.error(optionError);
        alert(optionError.message);
        return;
    }

    closeNewBallotModal();
    await loadBallotManager();
}

function getNewBallotInputs(category) {
    return [...document.querySelectorAll(`#${category}Inputs input`)]
        .map(input => input.value.trim())
        .filter(Boolean);
}


/*==================================================
    HELPERS
==================================================*/

function sortMenuCategoryItems(a, b) {
    const orderA = Number(a.sort_order || 0);
    const orderB = Number(b.sort_order || 0);

    if (orderA !== orderB) {
        return orderA - orderB;
    }

    return a.name.localeCompare(b.name);
}

function formatMenuPrice(price) {
    const value = Number(price);

    if (Number.isNaN(value)) return "0";

    return value
        .toFixed(2)
        .replace(/\.00$/, "");
}

function formatDate(dateString) {
    if (!dateString) return "Not set";

    return new Date(dateString).toLocaleDateString(
        "en-US",
        {
            month: "short",
            day: "numeric",
            year: "numeric"
        }
    );
}

function formatDateForInput(dateString) {
    if (!dateString) return "";

    return new Date(dateString)
        .toISOString()
        .split("T")[0];
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

/*==================================================
    GLOBAL EXPORTS
==================================================*/

window.loadMenuManager = loadMenuManager;
window.openMenuItemModal = openMenuItemModal;
window.closeMenuItemModal = closeMenuItemModal;
window.saveMenuItem = saveMenuItem;
window.toggleMenuAvailability = toggleMenuAvailability;
window.toggleFeatured = toggleFeatured;
window.deleteMenuItem = deleteMenuItem;
window.deleteMenuItemFromModal = deleteMenuItemFromModal;
window.duplicateMenuItem = duplicateMenuItem;
window.duplicateMenuItemFromModal = duplicateMenuItemFromModal;
window.updateSortOrder = updateSortOrder;
window.toggleMenuProductFields = toggleMenuProductFields;
window.setMenuCategoryFilter = setMenuCategoryFilter;
window.applyMenuFilters = applyMenuFilters;

window.loadBallotManager = loadBallotManager;
window.openNewOptionModal = openNewOptionModal;
window.editBallotOption = editBallotOption;
window.closeEditModal = closeEditModal;
window.saveBallotOption = saveBallotOption;
window.removeBallotOption = removeBallotOption;
window.saveBallotEndDate = saveBallotEndDate;
window.openNewBallotModal = openNewBallotModal;
window.closeNewBallotModal = closeNewBallotModal;
window.addBallotInput = addBallotInput;
window.startNewBallot = startNewBallot;
