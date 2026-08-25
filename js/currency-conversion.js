/* ==========================================
   CURRENCY CONVERSION (shared, pure)
   ==========================================

   Single source of truth for the EUR (customer-facing) -> USD (internal
   reporting) conversion introduced in Phase 3.

   -------------------------------------------------------------------------
   Confirmed design
   -------------------------------------------------------------------------
   - Customers always see and pay EUR. Public Menu, Cart, Checkout, and
     Orders stay EUR and are completely untouched by this module.
   - Ingredient/recipe/packaging costs already report in USD (the app's
     existing Inventory/Packaging convention) -- no conversion needed for
     any *_cost column, on sales or sale_items. Only revenue, which is the
     EUR amount the customer actually paid, needs converting.
   - Sales, profit, margin, and Analytics report in USD, computed from a
     rate SNAPSHOTTED once per sale at completion time and frozen forever
     -- later exchange-rate changes must never alter a historical sale's
     USD figures (the same freezing principle this codebase already
     applies to ingredient/recipe costs at sale time).
   - Every sale_items line for a given sale uses that SAME snapshotted
     rate -- never a per-line lookup -- so a sale's usd_revenue always
     equals the sum of its lines' usd_line_revenue.
   - Rounding is "round half away from zero" to the cent, matching
     Postgres's numeric round(x, 2), so this module and the SQL migration
     that seeds/backfills exchange_rates/usd_* columns can never disagree
     by a fraction of a cent on the same input.

   Used by js/admin-orders.js (resolving/snapshotting a rate at sale
   completion) and covered by tests/currency-conversion.test.js (Node's
   built-in test runner, no dependencies). The pure arithmetic functions
   here have no dependency on the DOM, Supabase, or the network --
   resolveExchangeRate() is the one exception, and it takes every
   side-effecting operation (cache lookup, live fetch, manual prompt, save)
   as an injected function specifically so it can be tested the same way.
   ========================================== */

(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.CurrencyConversion = factory();
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    // ECB-derived, no-API-key-required historical/latest rate source.
    // Frankfurter republishes the European Central Bank's daily reference
    // rates; requesting a weekend/holiday date returns the latest valid
    // reference rate before it (ECB's own convention -- verified directly:
    // requesting a Saturday returns the preceding Friday's rate), so no
    // separate weekend/holiday handling is needed here.
    const FRANKFURTER_BASE_URL = "https://api.frankfurter.dev/v1";

    function toNumber(value, fallback) {
        const n = Number(value);
        return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
    }

    /**
     * Round half-away-from-zero to 2 decimal places (cents) -- matches
     * Postgres's `round(numeric, 2)`, unlike JS's native Math.round (which
     * rounds -2.5 to -2, toward +Infinity, not away from zero).
     */
    function roundCents(value) {
        const n = toNumber(value);
        const sign = n < 0 ? -1 : 1;
        return sign * Math.round((Math.abs(n) + Number.EPSILON) * 100) / 100;
    }

    function isValidRate(rate) {
        const n = Number(rate);
        return Number.isFinite(n) && n > 0;
    }

    /** EUR -> USD for a single amount, using a sale's snapshotted rate.
     * Returns null (never a silently-wrong number) if the rate is missing
     * or invalid -- callers must treat null as "cannot convert." */
    function convertEurToUsd(eurAmount, rate) {
        if (!isValidRate(rate)) return null;
        return roundCents(toNumber(eurAmount) * Number(rate));
    }

    /**
     * Sale-level USD figures. total_cost is already USD-denominated (see
     * the confirmed rule above) -- only revenue is converted.
     */
    function computeUsdSaleFigures({ revenue, totalCost, rate }) {
        const usdRevenue = convertEurToUsd(revenue, rate);
        if (usdRevenue === null) return null;

        return {
            usdRevenue,
            usdProfit: roundCents(usdRevenue - toNumber(totalCost))
        };
    }

    /**
     * Same shape as computeUsdSaleFigures, for one sale_items line.
     * totalCost here is PER UNIT (matching sale_items.total_cost /
     * sale-calculations.js's buildSaleLineItems, which stores food_cost +
     * packaging_cost per unit, not pre-multiplied by quantity) -- so it
     * must be multiplied by quantity here, exactly as the EUR-side
     * line_profit already is (line_revenue - totalCost * quantity).
     * quantity defaults to 1 for a caller that already has a per-line
     * (not per-unit) total, so a single-unit line's result is unchanged.
     */
    function computeUsdLineFigures({ lineRevenue, totalCost, quantity, rate }) {
        const usdLineRevenue = convertEurToUsd(lineRevenue, rate);
        if (usdLineRevenue === null) return null;

        return {
            usdLineRevenue,
            usdLineProfit: roundCents(usdLineRevenue - toNumber(totalCost) * toNumber(quantity, 1))
        };
    }

    /**
     * Applies ONE snapshotted rate across every line of a sale. This is the
     * direct mechanism behind "use the same snapshotted rate for a sale and
     * all its sale-item revenue calculations" -- every line's USD figures
     * come from the exact same `rate` argument, never a per-line lookup.
     *
     * Rounding EACH line independently and separately rounding the sale's
     * own total can legitimately disagree by a cent -- confirmed directly
     * against real production data (10 of the bakery's 34 sales hit this
     * exact case). To guarantee sale-level and item-level figures always
     * reconcile EXACTLY, the sale's usd_revenue is computed once
     * (authoritative), each line is rounded independently, and any leftover
     * rounding residual (always ±0.01 for realistic line counts) is
     * assigned to the line with the LARGEST EUR line_revenue -- never to a
     * zero-revenue line. This is deliberate: a Mix & Match sale's child
     * lines always have EUR line_revenue: 0 (BUG-01's parent-owns-100%-
     * revenue invariant), and a zero-revenue line can never be "largest"
     * while any line has positive revenue, so the residual can never land
     * on a child and silently reintroduce a USD-side version of BUG-01.
     */
    function applyRateToSaleLines(lines, rate) {
        const safeLines = lines || [];

        if (!isValidRate(rate)) {
            return safeLines.map(line => ({
                ...line,
                usd_line_revenue: null,
                usd_line_profit: null
            }));
        }

        const totalEurRevenue = safeLines.reduce(
            (sum, line) => sum + toNumber(line.line_revenue), 0
        );
        const saleUsdRevenue = roundCents(totalEurRevenue * Number(rate));

        const naiveRounded = safeLines.map(line => convertEurToUsd(line.line_revenue, rate));
        const naiveSum = roundCents(naiveRounded.reduce((sum, value) => sum + value, 0));
        const residual = roundCents(saleUsdRevenue - naiveSum);

        let residualIndex = 0;
        let largestRevenue = -Infinity;
        safeLines.forEach((line, index) => {
            const value = toNumber(line.line_revenue);
            if (value > largestRevenue) {
                largestRevenue = value;
                residualIndex = index;
            }
        });

        return safeLines.map((line, index) => {
            const usdLineRevenue = index === residualIndex
                ? roundCents(naiveRounded[index] + residual)
                : naiveRounded[index];

            // BUG (found during the Product Breakdown audit): line.total_cost
            // is PER UNIT (see sale-calculations.js buildSaleLineItems), so
            // it must be multiplied by the line's own quantity here -- the
            // same way the EUR-side line_profit already is -- or every line
            // with quantity > 1 silently understates its true USD cost (and
            // overstates its USD profit) by a factor of its own quantity.
            return {
                ...line,
                usd_line_revenue: usdLineRevenue,
                usd_line_profit: roundCents(usdLineRevenue - toNumber(line.total_cost) * toNumber(line.quantity, 1))
            };
        });
    }

    /**
     * Resolves an EUR->USD rate for a given date through, in order:
     *   1. an already-cached rate for that exact date;
     *   2. a live fetch (ECB-derived, no key);
     *   3. a safe administrator-entered manual fallback.
     * Every side-effecting step is an injected function so this is fully
     * testable without a real network or database:
     *   - getCachedRate(dateStr) -> { rate, reference_date, source } | null
     *   - fetchLiveRate(dateStr) -> { rate, reference_date } | null/throws
     *   - promptManualRate(dateStr) -> number | null (null = declined)
     *   - saveRate(entry) -> persists entry (e.g. upsert into
     *     exchange_rates); errors are swallowed here since a save failure
     *     shouldn't block using the rate that was already resolved.
     * Returns null (never a fabricated or default rate) if the date's rate
     * genuinely cannot be resolved at all -- callers must not proceed with
     * a sale's currency conversion in that case.
     */
    async function resolveExchangeRate(dateStr, { getCachedRate, fetchLiveRate, promptManualRate, saveRate }) {
        const cached = await getCachedRate(dateStr);
        if (cached && isValidRate(cached.rate)) {
            return {
                rate_date: dateStr,
                reference_date: cached.reference_date || dateStr,
                rate: Number(cached.rate),
                source: cached.source || "ecb_frankfurter"
            };
        }

        try {
            const live = await fetchLiveRate(dateStr);
            if (live && isValidRate(live.rate)) {
                const entry = {
                    rate_date: dateStr,
                    reference_date: live.reference_date || dateStr,
                    rate: Number(live.rate),
                    source: "ecb_frankfurter"
                };

                try { await saveRate(entry); } catch (saveErr) { /* non-fatal */ }

                return entry;
            }
        } catch (fetchErr) {
            // Fall through to the manual fallback below.
        }

        const manualRate = await promptManualRate(dateStr);
        if (!isValidRate(manualRate)) return null;

        const entry = {
            rate_date: dateStr,
            reference_date: dateStr,
            rate: Number(manualRate),
            source: "manual"
        };

        try { await saveRate(entry); } catch (saveErr) { /* non-fatal */ }

        return entry;
    }

    /** Builds the fetchLiveRate function's real implementation against the
     * live Frankfurter API (browser-only; uses the global fetch()). Kept
     * separate from resolveExchangeRate itself so tests never need a real
     * network call. */
    function createFrankfurterFetcher(fetchImpl) {
        const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);

        return async function fetchLiveRate(dateStr) {
            if (!doFetch) return null;

            const response = await doFetch(
                `${FRANKFURTER_BASE_URL}/${dateStr}?base=EUR&symbols=USD`
            );

            if (!response.ok) return null;

            const json = await response.json();
            const rate = json?.rates?.USD;

            if (!isValidRate(rate)) return null;

            return { rate: Number(rate), reference_date: json.date || dateStr };
        };
    }

    return {
        roundCents,
        isValidRate,
        convertEurToUsd,
        computeUsdSaleFigures,
        computeUsdLineFigures,
        applyRateToSaleLines,
        resolveExchangeRate,
        createFrankfurterFetcher,
        FRANKFURTER_BASE_URL
    };
});
