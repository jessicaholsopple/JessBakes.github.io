/* ==========================================
   WEEKLY MENU CONTENT BUILDER

   Pure transform from raw `menu_items` rows (as returned by a
   Supabase query) into the flat {name, description, priceEur} shape
   the weekly template renders -- and the "is this menu empty/unfit
   to send" check the scheduler uses to decide between sending and
   recording a skipped campaign.
   ========================================== */

/** Keeps only currently-available products, sorted by category then
 * sort_order (matching the public Menu page's own ordering), mapped
 * to exactly the fields the email needs. */
export function buildWeeklyMenuItems(menuItemsRows) {
    const rows = Array.isArray(menuItemsRows) ? menuItemsRows : [];

    return rows
        .filter(row => row && row.available === true)
        .sort((a, b) => {
            const cat = String(a.category || "").localeCompare(String(b.category || ""));
            if (cat !== 0) return cat;
            return (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0);
        })
        .map(row => ({
            name: row.name,
            description: row.description || "",
            priceEur: Number(row.price) || 0
        }));
}

/** A campaign should never send a broken/empty email. Returns a
 * skip reason string, or null if it's safe to proceed. Generic over
 * any built-menu-items array (weekly menu, vacation reopening) --
 * "empty" and "failed to load" mean the same thing for either. */
export function weeklyMenuSkipReason(items) {
    if (!Array.isArray(items)) return "menu_load_failed";
    if (items.length === 0) return "empty_menu";
    return null;
}

/**
 * Server-side twin of js/vacation-mode.js's buildMenuSnapshotKey --
 * MUST stay byte-for-byte identical to it (same field selection, same
 * sort, same JSON.stringify shape), since the admin's client-side
 * preview-staleness check compares a client-computed key against the
 * key this server-side function produces at preview/send time. There
 * is no build step in this repo to share one implementation across
 * the browser (UMD script) and Deno (ESM) runtimes, so the two are
 * hand-kept in sync -- verified by a cross-check test in
 * tests/email-shared.test.js that imports both and asserts identical
 * output for the same fixture. If you change one, change the other.
 */
export function buildMenuSnapshotKey(menuItemsRows) {
    const rows = (Array.isArray(menuItemsRows) ? menuItemsRows : [])
        .filter(item => item && item.available === true)
        .map(item => ({
            id: String(item.id),
            name: item.name || "",
            price: Number(item.price) || 0,
            description: item.description || "",
            product_type: item.product_type || "standard"
        }))
        .sort((a, b) => a.id.localeCompare(b.id));

    return JSON.stringify(rows);
}

/** Canonical customer-facing category labels and deliberate display
 * order -- copied from js/menu.js's own MENU_CATEGORY_NAMES so the
 * reopening email groups/orders categories exactly like the public
 * Menu page does. Duplicated (not imported) for the same reason
 * buildMenuSnapshotKey is duplicated above: no build step shares one
 * implementation between the browser script and this Deno module. A
 * category not in this map still gets included automatically --
 * see categoryLabel() below -- it just sorts after the known ones,
 * alphabetically by its generated label. */
const VACATION_MENU_CATEGORY_LABELS = {
    bread: "Sourdough Bread",
    cookie: "Sourdough Cookies",
    dessert: "Desserts",
    seasonal: "Seasonal Specials"
};

const VACATION_MENU_CATEGORY_ORDER = Object.keys(VACATION_MENU_CATEGORY_LABELS);

function categoryLabel(category) {
    if (VACATION_MENU_CATEGORY_LABELS[category]) {
        return VACATION_MENU_CATEGORY_LABELS[category];
    }
    const raw = String(category || "").trim();
    if (!raw) {
        return "Other";
    }
    return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/**
 * Groups the live, available menu into the shape
 * vacationReopeningEmail() renders: an array of
 * `{ categoryLabel, items: [{ name, productType }] }`, categories in
 * the canonical bread/cookie/dessert/seasonal order (any unrecognized
 * category sorts after those, alphabetically by its own label), items
 * alphabetized by name within each category. Only ever reads live
 * `menu_items` -- archived/unavailable/unpublished products, and
 * ballot options that were never actually published as a menu item,
 * are excluded by construction (the `available === true` filter),
 * never by a special case here. No description or price is included
 * -- the reopening email is a simple, scannable name list, not a
 * priced menu (customers place the actual order on the Menu page).
 */
export function buildVacationReopeningMenuCategories(menuItemsRows) {
    const rows = (Array.isArray(menuItemsRows) ? menuItemsRows : [])
        .filter(row => row && row.available === true);

    const byCategory = new Map();
    for (const row of rows) {
        const key = row.category || "";
        if (!byCategory.has(key)) {
            byCategory.set(key, []);
        }
        byCategory.get(key).push({
            name: row.name,
            productType: row.product_type || "standard"
        });
    }

    const categoryKeys = Array.from(byCategory.keys()).sort((a, b) => {
        const ai = VACATION_MENU_CATEGORY_ORDER.indexOf(a);
        const bi = VACATION_MENU_CATEGORY_ORDER.indexOf(b);
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        return categoryLabel(a).localeCompare(categoryLabel(b));
    });

    return categoryKeys.map(key => ({
        categoryLabel: categoryLabel(key),
        items: byCategory.get(key)
            .slice()
            .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")))
    }));
}
