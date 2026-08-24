"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

function read(relPath) {
    return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

/* ==========================================
   Regression coverage for the live bug: the two newest individual
   cookies ("S'mores" and "Browned Butter Snickerdoodle") were missing
   from both the 6 and 12 Mix & Match selectors because they were
   created with a null builder_group -- the Admin Menu form hid that
   field for standard products, so there was no way to set it.

   Root-cause fix:
     1. Data: the two live products now have builder_group = "cookie"
        (supabase/migrations/20260824200000_fix_mix_and_match_cookie_eligibility.sql).
     2. Code: js/admin-menu.js now shows a clearly labeled "Available in
        Mix & Match boxes" checkbox for standard products in the Cookie
        category, defaulted to checked for newly created cookies, which
        drives the same existing builder_group field (canonical value
        "cookie") -- no new database column, no hardcoded name list.

   The tests below execute the REAL js/cart.js builder-selection code
   (the exact function the live storefront runs) against an in-memory
   stand-in for the Supabase query it issues, so this proves the actual
   production eligibility rule -- not a reimplementation of it.
   ========================================== */

function loadCartSandbox() {
    const fakeModal = { id: "", className: "", style: {}, innerHTML: "" };

    const fakeDocument = {
        getElementById: () => null, // always "not created yet" -- fine for one modal open per test
        createElement: () => fakeModal,
        body: { appendChild: () => {} }
    };

    // Mimics only the chain js/cart.js's openBuilderModal actually issues:
    // .from("menu_items").select("*").eq("builder_group",...).eq("product_type","standard").eq("available",true).order("name")
    // Each .eq() narrows an in-memory copy of the table using the exact
    // same field/value predicate the real Postgres query would apply.
    function makeQuery(rows) {
        return {
            select() { return this; },
            eq(field, value) {
                return makeQuery(rows.filter(r => r[field] === value));
            },
            order(field) {
                const sorted = [...rows].sort((a, b) => String(a[field]).localeCompare(String(b[field])));
                return Promise.resolve({ data: sorted, error: null });
            }
        };
    }

    const fakeSupabase = {
        from(table) {
            assert.equal(table, "menu_items", "openBuilderModal must query menu_items");
            return makeQuery(fakeSupabase.__table);
        },
        __table: []
    };

    const sandbox = { document: fakeDocument, supabaseClient: fakeSupabase, window: {}, console };
    vm.createContext(sandbox);

    const source = read("js/cart.js");
    const glue = `
        this.__setCartMenuItems = function (items) { cartMenuItems = items; };
        this.__openBuilderModal = openBuilderModal;
    `;
    vm.runInContext(source + "\n" + glue, sandbox);

    return { sandbox, fakeModal, fakeSupabase };
}

function cookieRow(id, name, { available = true, builderGroup = "cookie" } = {}) {
    return {
        id, name,
        product_type: "standard",
        category: "cookie",
        available,
        builder_group: builderGroup,
        price: 3
    };
}

const SIX_BUILDER = {
    id: "2dfec176-0e71-429b-a62f-4b337ff33d71",
    name: "6 Mix & Match Cookies",
    product_type: "builder",
    builder_group: "cookie",
    builder_size: 6,
    price: 15
};

const TWELVE_BUILDER = {
    id: "22a1b32f-a307-4dec-b5e3-2b014bb8ade0",
    name: "12 Mix & Match Cookies",
    product_type: "builder",
    builder_group: "cookie",
    builder_size: 12,
    price: 25
};

async function optionNamesFor(sandbox, fakeSupabase, fakeModal, table, builder) {
    fakeSupabase.__table = table;
    sandbox.__setCartMenuItems(table);
    await sandbox.__openBuilderModal(builder.id);
    // Matches only each builder-row's own `<div><strong>NAME</strong></div>`
    // wrapper -- deliberately narrower than a bare <strong> search, since
    // the modal also renders "Pick exactly N items" and "X / N selected"
    // text through <strong> tags that aren't option names.
    return [...fakeModal.innerHTML.matchAll(/<div>\s*<strong>([^<]*)<\/strong>\s*<\/div>/g)].map(m => m[1]);
}

test("a newly created, available individual cookie automatically appears in both the 6 and 12 Mix & Match selectors", async () => {
    const { sandbox, fakeModal, fakeSupabase } = loadCartSandbox();

    const table = [
        SIX_BUILDER,
        TWELVE_BUILDER,
        cookieRow("cookie-1", "Brown Butter Sea Salt Chocolate Chip"),
        cookieRow("cookie-2", "Strawberry Shortcake"),
        // Simulates a flavor just added through the Admin Menu page with
        // the new "Available in Mix & Match boxes" checkbox left checked
        // (its default for a new cookie) -- no code change required.
        cookieRow("cookie-new", "Salted Caramel Snickerdoodle")
    ];

    for (const builder of [SIX_BUILDER, TWELVE_BUILDER]) {
        const names = await optionNamesFor(sandbox, fakeSupabase, fakeModal, table, builder);
        assert.deepEqual(
            new Set(names),
            new Set(["Brown Butter Sea Salt Chocolate Chip", "Strawberry Shortcake", "Salted Caramel Snickerdoodle"]),
            `${builder.name} selector must include every available cookie, exactly as named on the Menu page`
        );
    }
});

test("that same cookie disappears from both selectors as soon as it is marked unavailable", async () => {
    const { sandbox, fakeModal, fakeSupabase } = loadCartSandbox();

    const table = [
        SIX_BUILDER,
        TWELVE_BUILDER,
        cookieRow("cookie-1", "Brown Butter Sea Salt Chocolate Chip"),
        cookieRow("cookie-new", "Salted Caramel Snickerdoodle", { available: false })
    ];

    for (const builder of [SIX_BUILDER, TWELVE_BUILDER]) {
        const names = await optionNamesFor(sandbox, fakeSupabase, fakeModal, table, builder);
        assert.ok(names.includes("Brown Butter Sea Salt Chocolate Chip"));
        assert.ok(!names.includes("Salted Caramel Snickerdoodle"), `${builder.name} must not offer an unavailable cookie`);
    }
});

test("reproduces the actual live bug: a cookie with builder_group left null is excluded from both selectors until corrected", async () => {
    const { sandbox, fakeModal, fakeSupabase } = loadCartSandbox();

    const table = [
        SIX_BUILDER,
        TWELVE_BUILDER,
        cookieRow("cookie-1", "Brown Butter Sea Salt Chocolate Chip"),
        // Exactly reproduces how S'mores / Browned Butter Snickerdoodle
        // were created before this fix.
        cookieRow("cookie-broken", "S'mores", { builderGroup: null })
    ];

    let names = await optionNamesFor(sandbox, fakeSupabase, fakeModal, table, SIX_BUILDER);
    assert.ok(!names.includes("S'mores"), "a null builder_group must exclude the cookie -- this is the bug being fixed");

    table[3].builder_group = "cookie";
    names = await optionNamesFor(sandbox, fakeSupabase, fakeModal, table, SIX_BUILDER);
    assert.ok(names.includes("S'mores"), "setting builder_group = 'cookie' must make it appear");
});

test("the box products themselves, unavailable products, and non-cookie products never leak into the cookie selector", async () => {
    const { sandbox, fakeModal, fakeSupabase } = loadCartSandbox();

    const table = [
        SIX_BUILDER,
        TWELVE_BUILDER,
        cookieRow("cookie-1", "Brown Butter Sea Salt Chocolate Chip"),
        cookieRow("cookie-hidden", "Peanut Butter Cup", { available: false }),
        {
            id: "bread-1", name: "Classic Boule", product_type: "standard",
            category: "bread", available: true, builder_group: null, price: 10
        },
        {
            id: "roll-1", name: "Classic Cinnamon Rolls", product_type: "standard",
            category: "dessert", available: true, builder_group: "cinnamon-roll", price: 20
        }
    ];

    const names = await optionNamesFor(sandbox, fakeSupabase, fakeModal, table, SIX_BUILDER);
    assert.deepEqual(names, ["Brown Butter Sea Salt Chocolate Chip"]);
});

test("js/cart.js's builder query still filters by builder_group/product_type/available -- never by a hardcoded cookie name list", () => {
    const source = read("js/cart.js");
    assert.match(source, /\.eq\(\s*"builder_group"\s*,\s*builder\.builder_group\s*\)/);
    assert.match(source, /\.eq\(\s*"product_type"\s*,\s*"standard"\s*\)/);
    assert.match(source, /\.eq\(\s*"available"\s*,\s*true\s*\)/);

    // Guard against ever "fixing" this by hardcoding the two previously
    // missing flavor names into the modal, per the explicit requirement.
    assert.doesNotMatch(source, /S['’]mores/);
    assert.doesNotMatch(source, /Browned Butter Snickerdoodle/);
});

test("js/menu.js never hardcodes a cookie name list either -- the Menu page and the builder read the same live table", () => {
    const source = read("js/menu.js");
    assert.doesNotMatch(source, /S['’]mores/);
    assert.doesNotMatch(source, /Browned Butter Snickerdoodle/);
});

/* ---------------- Admin Menu form: eligibility control ---------------- */

test('js/admin-menu.js adds a clearly labeled "Available in Mix & Match boxes" checkbox for standard cookie products', () => {
    const source = read("js/admin-menu.js");
    assert.match(source, /id="menuAvailableInMixMatch"/);
    assert.match(source, /Available in Mix & Match boxes/);
});

test("the checkbox is only shown for standard products in the Cookie category (never for builder/box products or other categories)", () => {
    const source = read("js/admin-menu.js");
    const fn = source.match(/function toggleMenuProductFields\(\)\s*\{[\s\S]*?\n\}/)[0];
    assert.match(fn, /cookieBuilderField\.style\.display\s*=\s*\n?\s*productType === "standard" && category === "cookie" \? "block" : "none"/);
});

test("saving a standard cookie product writes builder_group from the checkbox (canonical \"cookie\"), never from typed-in text", () => {
    const source = read("js/admin-menu.js");
    const fn = source.match(/async function saveMenuItem\(\)\s*\{[\s\S]*?\n\}/)[0];
    assert.match(fn, /productType === "standard" && category === "cookie"\s*\n?\s*\?\s*\(availableInMixMatch \? "cookie" : null\)\s*\n?\s*:\s*rawBuilderGroup/);
});

test("saving any other product (builders, or standard bread/dessert/seasonal) still uses the original raw Builder Group field -- unrelated products are unaffected", () => {
    const source = read("js/admin-menu.js");
    assert.match(source, /const rawBuilderGroup =\s*\n?\s*document\.getElementById\("menuBuilderGroup"\)\.value\.trim\(\) \|\| null;/);
});

test("a brand-new cookie item defaults the checkbox to checked; an existing item reflects its actual builder_group", () => {
    const source = read("js/admin-menu.js");
    const fn = source.match(/function openMenuItemModal\([^)]*\)\s*\{[\s\S]*?\n\}/)[0];
    assert.match(
        fn,
        /document\.getElementById\("menuAvailableInMixMatch"\)\.checked = item\s*\n?\s*\?\s*Boolean\(item\.builder_group\)\s*\n?\s*:\s*effectiveCategory === "cookie";/
    );
});

test("the two previously-broken live product IDs are pinned to builder_group = 'cookie' in the fix migration", () => {
    const migrationFiles = fs.readdirSync(path.join(ROOT, "supabase", "migrations"));
    const file = migrationFiles.find(f => f.includes("fix_mix_and_match_cookie_eligibility"));
    assert.ok(file, "expected a migration fixing the two cookies' builder_group");

    const sql = read(path.join("supabase", "migrations", file));
    assert.match(sql, /c1cad663-08a8-480e-a5a2-ce7995ebf7b7/); // S'mores
    assert.match(sql, /7a1eddcb-a28d-4c78-832c-5ece055a0905/); // Browned Butter Snickerdoodle
    assert.match(sql, /builder_group = 'cookie'/);
});
