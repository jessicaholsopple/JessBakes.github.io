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

    await Promise.all([
        loadMenuManager(),
        loadBallotManager()
    ]);
});

document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;

    closeMenuItemModal();
    closeEditModal();
    closeNewBallotModal();
});


/*==================================================
    MENU STATE
==================================================*/

let menuItems = [];
let recipes = [];
let packagingProfiles = [];

let recipeCosts = new Map();
let packagingCosts = new Map();

const MENU_CATEGORIES = [
    { key: "bread", label: "Bread" },
    { key: "cookie", label: "Cookies" },
    { key: "dessert", label: "Desserts" },
    { key: "seasonal", label: "Seasonal" }
];


/*==================================================
    MENU DATA
==================================================*/

async function loadMenuManager() {
    const container = document.getElementById("menuManager");

    if (!container) return;

    container.innerHTML = `<p>Loading menu items...</p>`;

    const [
    menuResult,
    recipeResult,
    packagingResult,
    recipeCostResult,
    packagingCostResult
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
        .order("name"),

    supabaseClient
        .from("recipe_costs")
        .select("*"),

    supabaseClient
        .from("packaging_profile_costs")
        .select("*")

]);

const data = menuResult.data;
const error = menuResult.error;

recipes = recipeResult.data || [];
packagingProfiles = packagingResult.data || [];

    // BUG-03: keys are consistently String()-coerced here and at both
    // lookup sites below, matching the convention already used in
    // admin-production.js and js/sale-calculations.js's own key() helper.
    // Confirmed against live data that both IDs are `bigint`, not UUID, so
    // this was never a live bug — purely a consistency/robustness fix.
    recipeCosts = new Map(
    (recipeCostResult.data || []).map(recipe => [
        String(recipe.id),
        recipe
    ])
);

packagingCosts = new Map(
    (packagingCostResult.data || []).map(profile => [
        String(profile.id),
        profile
    ])
);

    if (error) {
        console.error(error);

        container.innerHTML = `
            <p>Unable to load menu items.</p>
        `;

        return;
    }

    menuItems = data || [];

    updateMenuStats();
    renderMenuManager();
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

function renderMenuManager() {
    const container = document.getElementById("menuManager");

    if (!container) return;

    container.innerHTML = `
        <div class="menu-admin-toolbar">
            <button
                class="approve-btn"
                onclick="openMenuItemModal()">
                + Add Menu Item
            </button>
        </div>

        <div class="menu-admin-summary">
            <div>
                <strong>Total Items</strong>
                <p>${menuItems.length}</p>
            </div>

            <div>
                <strong>Available</strong>
                <p>${menuItems.filter(item => item.available).length}</p>
            </div>

            <div>
                <strong>Featured</strong>
                <p>${menuItems.filter(item => item.featured).length}</p>
            </div>
        </div>

        <div class="menu-admin-sections">
            ${MENU_CATEGORIES.map(category => {
                const items = menuItems
                    .filter(item => item.category === category.key)
                    .sort(sortMenuCategoryItems);

                return renderMenuCategory(category, items);
            }).join("")}
        </div>
    `;
}

function renderMenuCategory(category, items) {
    return `
        <section class="menu-admin-category">
            <div class="menu-category-header">
                <div>
                    <h3>${category.label}</h3>
                    <p>${items.length} item${items.length === 1 ? "" : "s"}</p>
                </div>

                <button
                    class="add-option-btn"
                    onclick="openMenuItemModal('${category.key}')">
                    + Add
                </button>
            </div>

            ${
                !items.length
                    ? `<p class="empty-menu-category">No ${category.label.toLowerCase()} yet.</p>`
                    : items.map(renderMenuItemCard).join("")
            }
        </section>
    `;
}

function renderMenuItemCard(item) {

    const isBuilder = item.product_type === "builder";

    const recipe = isBuilder
        ? null
        : getRecipe(item.recipe_id);

    const packaging = getPackaging(item.packaging_profile_id);

    const recipeCost = isBuilder
        ? 0
        : Number(getRecipeCost(item.recipe_id)) *
          Number(item.recipe_units_used || 1);

    const packagingCost =
        Number(getPackagingCost(item.packaging_profile_id));

    const totalCost =
        recipeCost + packagingCost;

    const profit =
        Number(item.price) - totalCost;

    let profitClass = "profit-good";

    if (profit < 5) {
        profitClass = "profit-low";
    } else if (profit < 8) {
        profitClass = "profit-medium";
    }

    return `

<article class="menu-admin-item ${item.available ? "" : "is-disabled"}">

<div class="menu-product-card">

<div class="menu-card-header">

<div>

<div class="menu-item-title-row">

<h4>${escapeHtml(item.name)}</h4>

<span class="menu-category-pill">
${escapeHtml(item.category)}
</span>

<span class="menu-category-pill">
${isBuilder ? "Builder" : "Standard"}
</span>

${item.featured
? `<span class="featured-pill">★ Featured</span>`
: ""}

${!item.available
? `<span class="disabled-pill">Archived</span>`
: ""}

</div>

<p class="menu-description">
${escapeHtml(item.description || "").replace(/\n/g,"<br>")}
</p>

</div>

<div class="menu-price-badge">
€${formatMenuPrice(item.price)}
</div>

</div>

<div class="menu-details-grid">

<div class="menu-detail-box">

<small>${isBuilder ? "Builder Group" : "Recipe"}</small>

<strong>
${isBuilder
    ? escapeHtml(item.builder_group || "Not Assigned")
    : (recipe ? escapeHtml(recipe.name) : "Not Assigned")}
</strong>

<span>
${
    isBuilder
        ? `${item.builder_size || 4} Items`
        : `$${formatMoney(recipeCost)}`
}
</span>

</div>

<div class="menu-detail-box">

<small>Packaging</small>

<strong>
${packaging ? escapeHtml(packaging.name) : "Not Assigned"}
</strong>

<span>
$${formatMoney(packagingCost)}
</span>

</div>

</div>

<div class="menu-summary-row">

<div>

<small>Total Cost</small>

<strong>
$${formatMoney(totalCost)}
</strong>

</div>

<div class="${profitClass}">

<small>Estimated Profit</small>

<strong>
€${formatMoney(profit)}
</strong>

</div>

</div>

<div class="menu-product-toolbar">

<button
class="edit-option-btn"
onclick="openMenuItemModal(null,'${item.id}')">
Edit
</button>

<button
class="add-option-btn"
onclick="toggleFeatured('${item.id}',${Boolean(item.featured)})">
${item.featured ? "Unfeature" : "Feature"}
</button>

<button
class="edit-option-btn"
onclick="updateSortOrder('${item.id}',-1)">
↑
</button>

<button
class="edit-option-btn"
onclick="updateSortOrder('${item.id}',1)">
↓
</button>

<button
class="remove-option-btn"
title="${item.available
    ? "Remove from the public menu, New Order picker, and Mix & Match selectors -- past orders and sales keep showing it exactly as they were."
    : "Make available on the public menu and New Order picker again."}"
onclick="toggleMenuAvailability('${item.id}',${Boolean(item.available)})">
${item.available ? "Archive" : "Restore"}
</button>

<button
class="delete-btn"
title="Permanently delete -- only allowed for an item that has never been used in any order or sale."
onclick="deleteMenuItem('${item.id}','${escapeJs(item.name)}')">
Delete
</button>

</div>

</div>

</article>

`;

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

    const item = itemId
        ? menuItems.find(menuItem => menuItem.id === itemId)
        : null;

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

    modal.style.display = "flex";
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
                    class="secondary-btn"
                    type="button"
                    onclick="closeMenuItemModal()">
                    Cancel
                </button>

                <button
                    class="primary-btn"
                    type="button"
                    onclick="saveMenuItem()">
                    Save Item
                </button>
            </div>
        </div>
    `;

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
}


function closeMenuItemModal() {
    const modal = document.getElementById("menuItemModal");

    if (modal) {
        modal.style.display = "none";
    }
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

    if (!name) {
        alert("Please enter an item name.");
        return;
    }

    if (Number.isNaN(price) || price < 0) {
        alert("Please enter a valid price.");
        return;
    }

    if (productType === "standard" && !recipeId) {
        alert("Please select a recipe for this standard product.");
        return;
    }

    if (productType === "builder" && !builderGroup) {
        alert("Please enter a builder group.");
        return;
    }

    if (!packagingProfileId) {
        alert("Please select a packaging profile.");
        return;
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
        : supabaseClient
            .from("menu_items")
            .insert(payload);

    const { error } = await query;

    if (error) {
        console.error(error);
        alert(error.message);
        return;
    }

    closeMenuItemModal();
    await loadMenuManager();
}


async function toggleMenuAvailability(id, currentlyAvailable) {
    const { error } = await supabaseClient
        .from("menu_items")
        .update({
            available: !currentlyAvailable
        })
        .eq("id", id);

    if (error) {
        console.error(error);
        alert(error.message);
        return;
    }

    await loadMenuManager();
}

async function toggleFeatured(itemId, currentValue) {
    const { error } = await supabaseClient
        .from("menu_items")
        .update({
            featured: !currentValue
        })
        .eq("id", itemId);

    if (error) {
        console.error(error);
        alert(error.message);
        return;
    }

    await loadMenuManager();
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
        alert(error.message);
        return;
    }

    await loadMenuManager();
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

    const { error } = await supabaseClient
        .from("menu_items")
        .insert(copy);

    if (error) {
        console.error(error);
        alert(error.message);
        return;
    }

    await loadMenuManager();
}


async function updateSortOrder(itemId, direction) {
    const item = menuItems.find(menuItem => menuItem.id === itemId);

    if (!item) return;

    const newOrder = Math.max(
        1,
        Number(item.sort_order || 1) + direction
    );

    const { error } = await supabaseClient
        .from("menu_items")
        .update({
            sort_order: newOrder
        })
        .eq("id", itemId);

    if (error) {
        console.error(error);
        alert(error.message);
        return;
    }

    await loadMenuManager();
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

function getRecipe(recipeId) {

    return recipes.find(recipe =>
        recipe.id === recipeId
    );

}

function getPackaging(profileId) {

    return packagingProfiles.find(profile =>
        profile.id === profileId
    );

}

function getRecipeCost(recipeId) {

    return Number(
        recipeCosts.get(String(recipeId))?.cost_per_yield_item || 0
    );

}

function getPackagingCost(profileId) {

    const profile =
        packagingCosts.get(String(profileId));

    return Number(profile?.packaging_cost || 0);

}


function formatMoney(value) {

    return Number(value || 0).toFixed(2);

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
window.duplicateMenuItem = duplicateMenuItem;
window.updateSortOrder = updateSortOrder;
window.toggleMenuProductFields = toggleMenuProductFields;

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
