"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const CurrencyConversion = require("../js/currency-conversion.js");

/* ==========================================
   Rounding
   ========================================== */

test("1. roundCents rounds half away from zero, matching Postgres round(x,2)", () => {
    assert.equal(CurrencyConversion.roundCents(2.005), 2.01);
    assert.equal(CurrencyConversion.roundCents(2.004), 2.00);
    // JS Math.round(-2.5) === -2 (toward +Infinity); Postgres round(-2.5) === -3
    // (away from zero). roundCents must match Postgres, not native Math.round.
    assert.equal(CurrencyConversion.roundCents(-2.005), -2.01);
    assert.equal(CurrencyConversion.roundCents(-0.005), -0.01);
});

test("2. roundCents handles zero and non-numeric input without throwing", () => {
    assert.equal(CurrencyConversion.roundCents(0), 0);
    assert.equal(CurrencyConversion.roundCents(null), 0);
    assert.equal(CurrencyConversion.roundCents(undefined), 0);
    assert.equal(CurrencyConversion.roundCents("not a number"), 0);
});

/* ==========================================
   EUR -> USD conversion
   ========================================== */

test("3. convertEurToUsd multiplies by the given rate and rounds to cents", () => {
    assert.equal(CurrencyConversion.convertEurToUsd(45.00, 1.1567), 52.05);
    assert.equal(CurrencyConversion.convertEurToUsd(15.00, 1.1435), 17.15);
});

test("4. convertEurToUsd returns null (never a silent 0 or wrong number) for a missing/invalid rate", () => {
    assert.equal(CurrencyConversion.convertEurToUsd(45.00, null), null);
    assert.equal(CurrencyConversion.convertEurToUsd(45.00, undefined), null);
    assert.equal(CurrencyConversion.convertEurToUsd(45.00, 0), null);
    assert.equal(CurrencyConversion.convertEurToUsd(45.00, -1.1), null);
    assert.equal(CurrencyConversion.convertEurToUsd(45.00, "abc"), null);
});

test("5. convertEurToUsd of zero revenue is exactly 0, not null or NaN", () => {
    const result = CurrencyConversion.convertEurToUsd(0, 1.15);
    assert.equal(result, 0);
    assert.notEqual(result, null);
});

/* ==========================================
   Sale-level USD figures
   ========================================== */

test("6. computeUsdSaleFigures converts revenue only -- cost is already USD, untouched", () => {
    const result = CurrencyConversion.computeUsdSaleFigures({
        revenue: 45.00,
        totalCost: 12.30, // already USD, per the confirmed rule
        rate: 1.1567
    });

    assert.equal(result.usdRevenue, 52.05); // 45 * 1.1567 = 52.0515 -> 52.05
    assert.equal(result.usdProfit, 39.75); // 52.05 - 12.30
});

test("7. computeUsdSaleFigures returns null when the rate is missing (never fabricates a profit)", () => {
    assert.equal(CurrencyConversion.computeUsdSaleFigures({ revenue: 45, totalCost: 10, rate: null }), null);
});

test("8. a sale can show a USD loss even on positive EUR revenue if USD cost exceeds it", () => {
    const result = CurrencyConversion.computeUsdSaleFigures({
        revenue: 10.00,
        totalCost: 15.00,
        rate: 1.10
    });

    assert.equal(result.usdRevenue, 11.00);
    assert.equal(result.usdProfit, -4.00);
});

/* ==========================================
   Item-level USD figures + same-rate-for-whole-sale guarantee
   ========================================== */

test("9. computeUsdLineFigures mirrors the sale-level formula for one line (quantity 1)", () => {
    const result = CurrencyConversion.computeUsdLineFigures({
        lineRevenue: 20.00,
        totalCost: 5.00,
        quantity: 1,
        rate: 1.1567
    });

    assert.equal(result.usdLineRevenue, 23.13); // 20 * 1.1567 = 23.134 -> 23.13
    assert.equal(result.usdLineProfit, 18.13);
});

test("9b. computeUsdLineFigures multiplies the PER-UNIT cost by quantity, matching the EUR-side formula -- the exact bug found auditing Product Breakdown", () => {
    // totalCost is per unit (as sale_items.total_cost / buildSaleLineItems
    // store it), so a quantity-3 line must have 3x the cost subtracted,
    // not 1x.
    const result = CurrencyConversion.computeUsdLineFigures({
        lineRevenue: 0,
        totalCost: 0.65, // per unit
        quantity: 3,
        rate: 1.1435
    });

    assert.equal(result.usdLineRevenue, 0);
    assert.equal(result.usdLineProfit, -1.95); // -(0.65 * 3), NOT -0.65
});

test("9c. computeUsdLineFigures defaults quantity to 1 when omitted, so an existing caller passing an already-per-line total is unaffected", () => {
    const result = CurrencyConversion.computeUsdLineFigures({
        lineRevenue: 20.00,
        totalCost: 5.00,
        rate: 1.1567
    });

    assert.equal(result.usdLineProfit, 18.13);
});

test("10. applyRateToSaleLines uses the SAME rate for every line, and a sale's usd_revenue equals the sum of its lines (standard sale)", () => {
    const lines = [
        { line_revenue: 8.00, total_cost: 1.50 },
        { line_revenue: 5.00, total_cost: 0.90 }
    ];

    const result = CurrencyConversion.applyRateToSaleLines(lines, 1.15);

    const expectedRevenue = CurrencyConversion.convertEurToUsd(8.00, 1.15);
    const expectedRevenue2 = CurrencyConversion.convertEurToUsd(5.00, 1.15);

    assert.equal(result[0].usd_line_revenue, expectedRevenue);
    assert.equal(result[1].usd_line_revenue, expectedRevenue2);

    const saleUsdRevenue = CurrencyConversion.convertEurToUsd(13.00, 1.15);
    const sumOfLines = CurrencyConversion.roundCents(result[0].usd_line_revenue + result[1].usd_line_revenue);
    assert.equal(saleUsdRevenue, sumOfLines);
});

test("11. applyRateToSaleLines on a Mix & Match sale: parent line carries all USD revenue, child lines carry only USD cost (0 revenue), correctly multiplied by each child's own quantity", () => {
    // Mirrors the BUG-01 parent/child shape from sale-calculations.js:
    // parent owns 100% of revenue, children own cost/quantity only.
    // total_cost is PER UNIT, exactly as sale_items stores it.
    const lines = [
        { item_name: "6 Mix & Match Cookies", line_revenue: 15.00, total_cost: 0, quantity: 1 }, // parent
        { item_name: "Peanut Butter Cup", line_revenue: 0, total_cost: 0.65, quantity: 3 }, // child
        { item_name: "Brown Butter Sea Salt Chocolate Chip", line_revenue: 0, total_cost: 0.65, quantity: 3 } // child
    ];

    const result = CurrencyConversion.applyRateToSaleLines(lines, 1.1435);

    const parent = result[0];
    const children = result.slice(1);

    assert.equal(parent.usd_line_revenue, CurrencyConversion.convertEurToUsd(15.00, 1.1435));
    children.forEach(child => {
        assert.equal(child.usd_line_revenue, 0); // 0 EUR revenue converts to exactly 0 USD
        assert.equal(child.usd_line_profit, -1.95); // -(0.65 per unit * 3), not -0.65
    });

    // The sale's total USD revenue (sum of all lines) must equal converting
    // the box's EUR price alone -- children never add revenue.
    const totalUsdRevenue = CurrencyConversion.roundCents(
        result.reduce((sum, line) => sum + line.usd_line_revenue, 0)
    );
    assert.equal(totalUsdRevenue, parent.usd_line_revenue);
});

test("11a. usd_line_profit for a multi-quantity line is multiplied by quantity -- reproduces the exact live bug found auditing Product Breakdown (sale 0c2be140..., 'Brown Butter Sea Salt Chocolate Chip' x6)", () => {
    const lines = [
        { item_name: "6 Mix & Match Cookies", line_revenue: 15.00, total_cost: 0, quantity: 1 },
        { item_name: "Brown Butter Sea Salt Chocolate Chip", line_revenue: 0, total_cost: 0.65, quantity: 6 }
    ];

    const result = CurrencyConversion.applyRateToSaleLines(lines, 1.1377);

    // Before the fix this incorrectly returned -0.65 (missing * quantity).
    assert.equal(result[1].usd_line_profit, -3.90);
});

test("11b. applyRateToSaleLines reconciles exactly even when independently rounding each line would disagree with the sale total by a cent (real production case: sale 60d040a3, 2026-07-26 @ 1.1377)", () => {
    // Two standard products, both real revenue. Naively rounding each line
    // (6.83 + 11.38 = 18.21) disagrees by $0.01 with rounding the sale's
    // own total once (16.00 * 1.1377 = 18.2032 -> 18.20). Confirmed
    // directly against live data before this test was written -- 10 of the
    // bakery's 34 real sales hit this exact rounding case.
    const lines = [
        { item_name: "Brown Butter Sea Salt Chocolate Chip", line_revenue: 6.00, total_cost: 0.65 },
        { item_name: "Classic Boule", line_revenue: 10.00, total_cost: 2.06 }
    ];

    const result = CurrencyConversion.applyRateToSaleLines(lines, 1.1377);

    const sum = CurrencyConversion.roundCents(
        result[0].usd_line_revenue + result[1].usd_line_revenue
    );
    const saleTotal = CurrencyConversion.convertEurToUsd(16.00, 1.1377);

    assert.equal(saleTotal, 18.20);
    assert.equal(sum, saleTotal); // exact reconciliation, not "close enough"

    // The residual went to the larger line (Classic Boule, $10 > $6), not
    // an arbitrary or positional choice.
    assert.equal(result[0].usd_line_revenue, 6.83);
    assert.equal(result[1].usd_line_revenue, 11.37); // 11.38 naive, minus the $0.01 residual
});

test("11c. a rounding residual never lands on a Mix & Match child line, even when the parent's naive rounding would already reconcile without it", () => {
    // Contrived rate chosen so the parent's naive rounding alone would NOT
    // reconcile, to force a residual to be assigned -- verifying it still
    // goes to the parent (the only revenue-bearing line) and both children
    // stay at exactly 0, never inheriting a stray cent.
    const lines = [
        { item_name: "6 Mix & Match Cookies", line_revenue: 15.00, total_cost: 0 },
        { item_name: "Peanut Butter Cup", line_revenue: 0, total_cost: 1.95 },
        { item_name: "Brown Butter Sea Salt Chocolate Chip", line_revenue: 0, total_cost: 1.95 }
    ];

    const result = CurrencyConversion.applyRateToSaleLines(lines, 1.0333);

    assert.equal(result[1].usd_line_revenue, 0);
    assert.equal(result[2].usd_line_revenue, 0);

    const sum = CurrencyConversion.roundCents(
        result.reduce((total, line) => total + line.usd_line_revenue, 0)
    );
    assert.equal(sum, CurrencyConversion.convertEurToUsd(15.00, 1.0333));
});

test("12. applyRateToSaleLines propagates null (not a wrong number) for every line when the rate is invalid", () => {
    const lines = [{ line_revenue: 10, total_cost: 2 }];
    const result = CurrencyConversion.applyRateToSaleLines(lines, null);

    assert.equal(result[0].usd_line_revenue, null);
    assert.equal(result[0].usd_line_profit, null);
});

/* ==========================================
   resolveExchangeRate — cache / live fetch / manual fallback
   ========================================== */

test("13. resolveExchangeRate returns the cached rate without calling fetch or prompting", async () => {
    let fetchCalled = false;
    let promptCalled = false;

    const result = await CurrencyConversion.resolveExchangeRate("2026-08-16", {
        getCachedRate: async () => ({ rate: 1.1567, reference_date: "2026-08-14", source: "ecb_frankfurter" }),
        fetchLiveRate: async () => { fetchCalled = true; return { rate: 9.9999 }; },
        promptManualRate: async () => { promptCalled = true; return null; },
        saveRate: async () => {}
    });

    assert.equal(result.rate, 1.1567);
    assert.equal(result.rate_date, "2026-08-16");
    assert.equal(fetchCalled, false);
    assert.equal(promptCalled, false);
});

test("14. resolveExchangeRate falls back to a live fetch on a cache miss, and caches the result", async () => {
    let saved = null;

    const result = await CurrencyConversion.resolveExchangeRate("2026-08-10", {
        getCachedRate: async () => null,
        fetchLiveRate: async (dateStr) => ({ rate: 1.1555, reference_date: dateStr }),
        promptManualRate: async () => null,
        saveRate: async (entry) => { saved = entry; }
    });

    assert.equal(result.rate, 1.1555);
    assert.equal(result.source, "ecb_frankfurter");
    assert.ok(saved, "a successfully fetched rate must be cached");
    assert.equal(saved.rate, 1.1555);
});

test("15. resolveExchangeRate uses the reference date returned by the API for weekends/holidays (latest valid reference rate)", async () => {
    // Requesting a Sunday; the live API returns the preceding Friday as
    // reference_date, per real Frankfurter/ECB behavior verified directly
    // against api.frankfurter.dev.
    const result = await CurrencyConversion.resolveExchangeRate("2026-08-16", {
        getCachedRate: async () => null,
        fetchLiveRate: async () => ({ rate: 1.1567, reference_date: "2026-08-14" }),
        promptManualRate: async () => null,
        saveRate: async () => {}
    });

    assert.equal(result.rate_date, "2026-08-16"); // the date we looked up FOR
    assert.equal(result.reference_date, "2026-08-14"); // the actual ECB rate used
    assert.equal(result.rate, 1.1567);
});

test("16. resolveExchangeRate falls back to the manual prompt when the live fetch throws (API failure)", async () => {
    let saved = null;

    const result = await CurrencyConversion.resolveExchangeRate("2026-08-17", {
        getCachedRate: async () => null,
        fetchLiveRate: async () => { throw new Error("network down"); },
        promptManualRate: async () => 1.12,
        saveRate: async (entry) => { saved = entry; }
    });

    assert.equal(result.rate, 1.12);
    assert.equal(result.source, "manual");
    assert.equal(saved.source, "manual");
});

test("17. resolveExchangeRate falls back to the manual prompt when the live fetch returns no usable rate", async () => {
    const result = await CurrencyConversion.resolveExchangeRate("2026-08-17", {
        getCachedRate: async () => null,
        fetchLiveRate: async () => null, // e.g. non-OK HTTP response
        promptManualRate: async () => 1.09,
        saveRate: async () => {}
    });

    assert.equal(result.rate, 1.09);
    assert.equal(result.source, "manual");
});

test("18. resolveExchangeRate returns null (never a fabricated default) when the manual prompt is declined", async () => {
    const result = await CurrencyConversion.resolveExchangeRate("2026-08-17", {
        getCachedRate: async () => null,
        fetchLiveRate: async () => { throw new Error("network down"); },
        promptManualRate: async () => null, // admin cancelled
        saveRate: async () => {}
    });

    assert.equal(result, null);
});

test("19. resolveExchangeRate returns null when the manual entry is invalid (zero/negative/non-numeric), not a bad rate", async () => {
    for (const badInput of [0, -1, NaN, "not a number"]) {
        const result = await CurrencyConversion.resolveExchangeRate("2026-08-17", {
            getCachedRate: async () => null,
            fetchLiveRate: async () => null,
            promptManualRate: async () => badInput,
            saveRate: async () => {}
        });

        assert.equal(result, null, `expected null for manual input ${badInput}`);
    }
});

test("20. resolveExchangeRate still returns the resolved rate even if saveRate itself fails (a cache-write failure must not block completing the sale)", async () => {
    const result = await CurrencyConversion.resolveExchangeRate("2026-08-10", {
        getCachedRate: async () => null,
        fetchLiveRate: async () => ({ rate: 1.1555 }),
        promptManualRate: async () => null,
        saveRate: async () => { throw new Error("db write failed"); }
    });

    assert.equal(result.rate, 1.1555);
});

/* ==========================================
   isValidRate
   ========================================== */

test("21. isValidRate accepts positive finite numbers and rejects everything else", () => {
    assert.equal(CurrencyConversion.isValidRate(1.15), true);
    assert.equal(CurrencyConversion.isValidRate(0.5), true);
    assert.equal(CurrencyConversion.isValidRate(0), false);
    assert.equal(CurrencyConversion.isValidRate(-1), false);
    assert.equal(CurrencyConversion.isValidRate(null), false);
    assert.equal(CurrencyConversion.isValidRate(undefined), false);
    assert.equal(CurrencyConversion.isValidRate(NaN), false);
    assert.equal(CurrencyConversion.isValidRate(Infinity), false);
    assert.equal(CurrencyConversion.isValidRate("1.15"), true); // Number("1.15") is finite
    assert.equal(CurrencyConversion.isValidRate("abc"), false);
});

/* ==========================================
   convertEurToUsdFlooredWhole -- order-confirmation payment amounts
   (Zelle/PayPal/Venmo). Always a whole dollar, always rounded DOWN --
   never the cent-precision rounding convertEurToUsd uses for
   accounting/Analytics.
   ========================================== */

test("22. the exact spec example: €25 at a $29.13 rate displays $29, not $29.13 or $30", () => {
    // 25 * (29.13 / 25) reproduces a live rate that converts €25 to
    // exactly $29.13 before flooring.
    const rate = 29.13 / 25;
    assert.equal(CurrencyConversion.convertEurToUsdFlooredWhole(25, rate), 29);
});

test("23. $29.99, $29.13, and $29.00 all floor to $29", () => {
    assert.equal(CurrencyConversion.convertEurToUsdFlooredWhole(100, 0.2999), 29); // -> 29.99
    assert.equal(CurrencyConversion.convertEurToUsdFlooredWhole(100, 0.2913), 29); // -> 29.13
    assert.equal(CurrencyConversion.convertEurToUsdFlooredWhole(100, 0.29), 29);   // -> 29.00 exactly
});

test("24. never rounds UP to the next dollar, however close the cents are", () => {
    assert.equal(CurrencyConversion.convertEurToUsdFlooredWhole(1, 29.999), 29);
    assert.notEqual(CurrencyConversion.convertEurToUsdFlooredWhole(1, 29.999), 30);
});

test("25. float noise landing a hair under a true whole dollar still floors to that whole dollar (decimal-safety)", () => {
    // 25 * 1.16 = 29.000000000000004 in raw IEEE-754 float math --
    // convertEurToUsdFlooredWhole must still land on 29, not 28.
    assert.equal(CurrencyConversion.convertEurToUsdFlooredWhole(25, 1.16), 29);
});

test("26. returns null (never a guessed amount) for a missing or invalid rate", () => {
    assert.equal(CurrencyConversion.convertEurToUsdFlooredWhole(25, null), null);
    assert.equal(CurrencyConversion.convertEurToUsdFlooredWhole(25, undefined), null);
    assert.equal(CurrencyConversion.convertEurToUsdFlooredWhole(25, 0), null);
    assert.equal(CurrencyConversion.convertEurToUsdFlooredWhole(25, -1.1), null);
});

test("27. Zelle and PayPal (and Venmo) must display the identical amount for the same order -- one conversion, reused, not three separate lookups", () => {
    const rate = 1.1652;
    const a = CurrencyConversion.convertEurToUsdFlooredWhole(25, rate);
    const b = CurrencyConversion.convertEurToUsdFlooredWhole(25, rate);
    const c = CurrencyConversion.convertEurToUsdFlooredWhole(25, rate);
    assert.equal(a, b);
    assert.equal(b, c);
});

test("28. a zero-value order floors to exactly $0, not null", () => {
    assert.equal(CurrencyConversion.convertEurToUsdFlooredWhole(0, 1.15), 0);
});
