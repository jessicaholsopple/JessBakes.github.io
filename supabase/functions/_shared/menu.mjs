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

/** Same filter/sort as buildWeeklyMenuItems, plus `productType` so
 * the vacation-reopening template can summarize Mix & Match boxes as
 * one line instead of enumerating every flavor (see
 * vacationReopeningEmail in templates.mjs). Only ever reads live
 * `menu_items` -- archived/unavailable/unpublished products, and
 * ballot options that were never actually published as a menu item,
 * are excluded by construction, never by a special case here. */
export function buildVacationReopeningMenuItems(menuItemsRows) {
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
            priceEur: Number(row.price) || 0,
            productType: row.product_type || "standard"
        }));
}
