"use strict";

/* ==========================================
   Quantity Format (js/quantity-format.js)

   Inventory audit (2026-08-28), triggered by a real report: "Semi
   Sweet Chocolate Chips" showed On Hand 68g / Minimum 17g / Package
   Size 68g in the Inventory card while the database and Edit form
   both correctly held 680 / 170 / 680.

   Read-only audit confirmed the database was correct throughout --
   ingredients, recipe_ingredients, and the recipe_costs Postgres view
   (which computes every cost from the RAW numeric columns, never from
   any formatted string) were all unaffected. The bug was isolated to
   js/admin-inventory.js's own formatQuantity():

       Number(value || 0).toFixed(2).replace(/\.00$/, "").replace(/0$/, "")

   The second .replace() had no decimal-point anchor -- it stripped
   the last character of ANY string ending in "0", including a plain
   integer: 680 -> "680.00" -> "680" -> "68". Same for every whole
   quantity ending in zero (170->17, 100->10, 1000->100, ...).
   Confirmed display-only: every call site only ever fed the formatted
   STRING into the DOM, never back into isLowStock/inventory-value/
   shopping-list/recipe-cost math, which all read the raw Number(...)
   value directly.

   js/admin-production.js had a second, independently-correct
   implementation (its own equivalent replace required a literal
   decimal point in the match, so it could never touch a bare
   integer) -- this module replaces BOTH with one shared, tested
   formatter per "use one tested quantity formatter for Inventory,
   Recipes, Production, and Shopping Lists."
   ========================================== */

const test = require("node:test");
const assert = require("node:assert/strict");
const QuantityFormat = require("../js/quantity-format.js");

/* ==========================================
   The exact confirmed bug + required examples from the report
   ========================================== */

test("1. whole values ending in one zero are never truncated (the exact confirmed bug)", () => {
    assert.equal(QuantityFormat.formatQuantity(680), "680");
    assert.equal(QuantityFormat.formatQuantity(170), "170");
    assert.equal(QuantityFormat.formatQuantity(100), "100");
    assert.equal(QuantityFormat.formatQuantity(110), "110");
    assert.equal(QuantityFormat.formatQuantity(200), "200");
    assert.equal(QuantityFormat.formatQuantity(500), "500");
});

test("2. whole values ending in multiple zeroes get thousands grouping, never truncation", () => {
    assert.equal(QuantityFormat.formatQuantity(1000), "1,000");
    assert.equal(QuantityFormat.formatQuantity(2500), "2,500");
    assert.equal(QuantityFormat.formatQuantity(12000), "12,000");
    assert.equal(QuantityFormat.formatQuantity(1000000), "1,000,000");
});

test("3. decimal trailing zeroes are stripped -- but only after the decimal point", () => {
    assert.equal(QuantityFormat.formatQuantity(68.0), "68");
    assert.equal(QuantityFormat.formatQuantity(1.20), "1.2");
    assert.equal(QuantityFormat.formatQuantity(0.50), "0.5");
});

test("4. leading decimal zeroes (a zero right after the decimal point) are preserved when significant", () => {
    assert.equal(QuantityFormat.formatQuantity(0.05), "0.05");
    assert.equal(QuantityFormat.formatQuantity(10.01), "10.01");
});

test("5. large values use grouping separators", () => {
    assert.equal(QuantityFormat.formatQuantity(9000), "9,000");
    assert.equal(QuantityFormat.formatQuantity(12000), "12,000");
});

test("6. negative adjustment values format with their sign, unaffected by the trailing-zero fix", () => {
    assert.equal(QuantityFormat.formatQuantity(-5), "-5");
    assert.equal(QuantityFormat.formatQuantity(-0.5), "-0.5");
    assert.equal(QuantityFormat.formatQuantity(-170), "-170");
});

test("7. zero formats as exactly '0'", () => {
    assert.equal(QuantityFormat.formatQuantity(0), "0");
});

test("8. null, undefined, empty string, and non-numeric input format as '0', never 'NaN'", () => {
    assert.equal(QuantityFormat.formatQuantity(null), "0");
    assert.equal(QuantityFormat.formatQuantity(undefined), "0");
    assert.equal(QuantityFormat.formatQuantity(""), "0");
    assert.equal(QuantityFormat.formatQuantity("not-a-number"), "0");
    assert.equal(QuantityFormat.formatQuantity(NaN), "0");
});

test("9. an infinite value never formats as 'Infinity' or crashes", () => {
    assert.doesNotThrow(() => QuantityFormat.formatQuantity(Infinity));
    assert.equal(QuantityFormat.formatQuantity(Infinity), "0");
});

/* ==========================================
   Extended matrix: every value the spec explicitly requires
   ========================================== */

test("10. the complete required formatting matrix, run together", () => {
    const cases = [
        [680, "680"], [170, "170"], [100, "100"], [1000, "1,000"], [2500, "2,500"],
        [68.0, "68"], [1.20, "1.2"], [0.50, "0.5"], [0.05, "0.05"], [10.01, "10.01"]
    ];
    for (const [input, expected] of cases) {
        assert.equal(QuantityFormat.formatQuantity(input), expected, `formatQuantity(${input})`);
    }
});

test("11. 110 g must never become 11 g", () => {
    assert.notEqual(QuantityFormat.formatQuantity(110), "11");
    assert.equal(QuantityFormat.formatQuantity(110), "110");
});

test("12. 200 g must never become 2 g", () => {
    assert.notEqual(QuantityFormat.formatQuantity(200), "2");
    assert.equal(QuantityFormat.formatQuantity(200), "200");
});

test("13. 1000 g must never become 1 g", () => {
    assert.notEqual(QuantityFormat.formatQuantity(1000), "1");
    assert.equal(QuantityFormat.formatQuantity(1000), "1,000");
});

/* ==========================================
   parseQuantity -- raw numeric parsing, kept separate from display
   ========================================== */

test("14. parseQuantity returns a real number for valid input", () => {
    assert.equal(QuantityFormat.parseQuantity("680"), 680);
    assert.equal(QuantityFormat.parseQuantity(170), 170);
    assert.equal(QuantityFormat.parseQuantity(0.05), 0.05);
});

test("15. parseQuantity returns null (never 0) for missing/invalid input -- distinguishable from an explicit zero", () => {
    assert.equal(QuantityFormat.parseQuantity(null), null);
    assert.equal(QuantityFormat.parseQuantity(undefined), null);
    assert.equal(QuantityFormat.parseQuantity(""), null);
    assert.equal(QuantityFormat.parseQuantity("abc"), null);
    assert.notEqual(QuantityFormat.parseQuantity(0), null);
    assert.equal(QuantityFormat.parseQuantity(0), 0);
});

/* ==========================================
   normalizeUnit -- unit alias safety, case/whitespace-insensitive,
   never inferring a conversion
   ========================================== */

test("16. normalizeUnit is case-insensitive", () => {
    assert.equal(QuantityFormat.normalizeUnit("G"), "g");
    assert.equal(QuantityFormat.normalizeUnit("Kg"), "kg");
    assert.equal(QuantityFormat.normalizeUnit("EACH"), "each");
});

test("17. normalizeUnit trims whitespace and a trailing period", () => {
    assert.equal(QuantityFormat.normalizeUnit("  g  "), "g");
    assert.equal(QuantityFormat.normalizeUnit("oz."), "oz");
});

test("18. normalizeUnit collapses internal whitespace without altering the unit itself", () => {
    assert.equal(QuantityFormat.normalizeUnit("fl   oz"), "fl oz");
});

test("19. normalizeUnit never fabricates or infers a conversion -- it only normalizes text", () => {
    // 'g' and 'kg' are genuinely different units; normalizing case/
    // whitespace must never make them compare equal.
    assert.notEqual(QuantityFormat.normalizeUnit("g"), QuantityFormat.normalizeUnit("kg"));
    assert.notEqual(QuantityFormat.normalizeUnit("each"), QuantityFormat.normalizeUnit("g"));
});

test("20. normalizeUnit handles a missing/null unit safely", () => {
    assert.equal(QuantityFormat.normalizeUnit(null), "");
    assert.equal(QuantityFormat.normalizeUnit(undefined), "");
});

/* ==========================================
   Currency stays a separate concern
   ========================================== */

test("21. formatQuantity never produces a currency symbol -- quantity and currency formatting are structurally different functions", () => {
    assert.doesNotMatch(QuantityFormat.formatQuantity(8.08), /\$/);
    assert.doesNotMatch(QuantityFormat.formatQuantity(680), /\$/);
});

test("22. formatQuantity is not currency-rounded (currency rounds to exactly 2 decimals; a quantity's insignificant trailing zero is stripped instead)", () => {
    // $8.08 (a real price) stays as entered when passed through
    // formatQuantity purely as a numeric formatting exercise -- but
    // 8.10 (a currency-shaped value) still drops its insignificant
    // zero here, proving this is quantity formatting, not currency
    // formatting reused by mistake (the exact anti-pattern the audit
    // was asked to check for).
    assert.equal(QuantityFormat.formatQuantity(8.10), "8.1");
});
