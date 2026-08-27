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
            product_type: item.product_type || "standard",
            builder_size: item.builder_size == null ? null : Number(item.builder_size)
        }))
        .sort((a, b) => a.id.localeCompare(b.id));

    return JSON.stringify(rows);
}

/** Canonical customer-facing category labels and deliberate display
 * order -- the KEYS match js/menu.js's own MENU_CATEGORY_NAMES keys
 * exactly (same canonical `menu_items.category` column, same values:
 * 'bread'/'cookie'/'dessert'/'seasonal'), so the reopening email
 * groups/orders categories using the identical data-driven source the
 * public Menu page uses -- never a name/ID guess. The LABEL TEXT for
 * 'dessert' is deliberately "Sourdough Desserts" here even though the
 * public Menu page's own on-page heading says plain "Desserts" -- an
 * explicit, requested difference in wording only; the underlying
 * category value/order is identical. Duplicated (not imported) for
 * the same reason buildMenuSnapshotKey is duplicated above: no build
 * step shares one implementation between the browser script and this
 * Deno module. A category value not in this map still gets included
 * automatically -- see categoryLabel() below -- it just sorts after
 * the known ones, alphabetically by its generated label. */
const VACATION_MENU_CATEGORY_LABELS = {
    bread: "Sourdough Bread",
    cookie: "Sourdough Cookies",
    dessert: "Sourdough Desserts",
    seasonal: "Seasonal Specials"
};

const VACATION_MENU_CATEGORY_ORDER = Object.keys(VACATION_MENU_CATEGORY_LABELS);

const OTHER_LABEL = "Other";

/** Turns a raw (but non-empty) category value into a readable label:
 * the known map above, or -- for a genuinely new category nobody has
 * hardcoded a label for yet -- a title-cased version of the raw
 * value ("gift-box"/"gift_box" -> "Gift Box"). This is the "configured
 * display label" fallback: it only ever runs for a category that
 * actually HAS a value, never for a missing one (see the Other-bucket
 * handling in buildVacationReopeningMenuCategories). */
function categoryLabel(category) {
    if (VACATION_MENU_CATEGORY_LABELS[category]) {
        return VACATION_MENU_CATEGORY_LABELS[category];
    }
    return String(category)
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
}

function localeCompareNames(a, b) {
    return String(a || "").localeCompare(String(b || ""), undefined, { sensitivity: "base" });
}

/**
 * Renderer-boundary guard: if the caller's query forgot to SELECT the
 * `category` column, every row's `.category` key is simply absent
 * (not null -- genuinely not a property on the object at all), and
 * every product would silently collapse into one "Other" heading --
 * exactly the bug this guard exists to catch loudly instead. A
 * legitimately uncategorized product (selected the column, got back
 * an actual null/empty value) is a completely different, expected
 * case and is handled by the Other bucket below, not by this throw.
 */
function assertMenuRowsHaveCategoryField(rows) {
    if (rows.length > 0 && rows.every(row => !("category" in row))) {
        throw new Error(
            "buildVacationReopeningMenuCategories: every menu_items row is missing the 'category' " +
            "property -- the caller's .select(...) almost certainly forgot to include 'category'. " +
            "Refusing to silently group every product under \"Other\"."
        );
    }
}

/**
 * Groups the live, available menu into the shape
 * vacationReopeningEmail() renders: `{ categories, warnings }`.
 *
 * `categories` is `[{ categoryLabel, items: [{ name, productType, builderSize }] }]`,
 * in the canonical bread/cookie/dessert/seasonal order (any
 * legitimately-new category value sorts after those, alphabetically
 * by its generated label). WITHIN each category, regular (non-builder)
 * products sort alphabetically first, then Mix & Match/builder
 * products sort last, ordered by their numeric `builder_size` (box
 * capacity) ascending -- never by name. Both are real, stable
 * `menu_items` columns already used by the Mix & Match eligibility
 * system (js/mix-and-match.js) -- never a name/substring/ID guess, so
 * a future flavor or a future builder size is classified and ordered
 * correctly automatically. A final "Other" category is included ONLY
 * when at least one product has a genuinely missing category
 * (null/empty) -- a known or legitimately-new category value NEVER
 * lands in Other.
 *
 * `warnings` lists the exact product names that landed in Other, so
 * the admin preview can surface them -- see vacation-campaign/
 * index.ts and _shared/vacationCampaign.ts, which block an actual
 * send whenever this is non-empty rather than silently mailing a
 * malformed menu.
 *
 * Only ever reads live `menu_items` -- archived/unavailable/
 * unpublished products, and ballot options that were never actually
 * published as a menu item, are excluded by construction (the
 * `available === true` filter), never by a special case here. No
 * description or price is included -- the reopening email is a
 * simple, scannable name list, not a priced menu (customers place the
 * actual order on the Menu page).
 */
function sortCategoryItems(items) {
    const standard = items
        .filter(item => item.productType !== "builder")
        .sort((a, b) => localeCompareNames(a.name, b.name));
    const builders = items
        .filter(item => item.productType === "builder")
        .sort((a, b) => (a.builderSize ?? Infinity) - (b.builderSize ?? Infinity));
    return [...standard, ...builders];
}

export function buildVacationReopeningMenuCategories(menuItemsRows) {
    const allRows = Array.isArray(menuItemsRows) ? menuItemsRows : [];
    assertMenuRowsHaveCategoryField(allRows);

    const rows = allRows.filter(row => row && row.available === true);

    const byCategory = new Map();
    const warnings = [];

    for (const row of rows) {
        const raw = row.category == null ? "" : String(row.category).trim();
        const key = raw === "" ? OTHER_LABEL : raw;

        if (raw === "") {
            warnings.push(row.name);
        }

        if (!byCategory.has(key)) {
            byCategory.set(key, []);
        }
        byCategory.get(key).push({
            name: row.name,
            productType: row.product_type || "standard",
            builderSize: row.builder_size == null ? null : Number(row.builder_size)
        });
    }

    const categoryKeys = Array.from(byCategory.keys()).filter(k => k !== OTHER_LABEL).sort((a, b) => {
        const ai = VACATION_MENU_CATEGORY_ORDER.indexOf(a);
        const bi = VACATION_MENU_CATEGORY_ORDER.indexOf(b);
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        return localeCompareNames(categoryLabel(a), categoryLabel(b));
    });

    const categories = categoryKeys.map(key => ({
        categoryLabel: categoryLabel(key),
        items: sortCategoryItems(byCategory.get(key))
    }));

    // Other is always last, and only appears when it's genuinely non-empty.
    if (byCategory.has(OTHER_LABEL)) {
        categories.push({
            categoryLabel: OTHER_LABEL,
            items: sortCategoryItems(byCategory.get(OTHER_LABEL))
        });
    }

    return { categories, warnings };
}
