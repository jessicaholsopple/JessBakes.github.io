# 09 — BUG-01 Fix: Test Suite & Historical Regression Report

**Phase 1A.** Read-only against Supabase throughout — no database writes, no customer information exposed (only `sale_id`/`order_id`, which are internal keys, not personal data). No historical `sales`/`sale_items` rows were modified. This document reports what the fix *would* produce for the 34 existing sales; it does not apply that correction to the database.

## 1. Architecture

A single shared, pure module — `js/sale-calculations.js` — is now the one place revenue/cost/profit/margin arithmetic happens. It has zero DOM/Supabase dependency and uses a dual CommonJS/browser export (UMD-style), so the exact same code runs:

- **In the browser**, as a plain `<script>` tag (creates the global `SaleCalculations`, matching this codebase's existing no-bundler convention).
- **Under Node**, via `require("../js/sale-calculations.js")`, with zero external dependencies.

Three call sites now route through it instead of each computing independently:

| File | What it now calls |
|---|---|
| `js/admin-orders.js` (`createSaleFromOrder`) | `buildReferenceData`, `buildSaleFromOrder`, `summarizeLines` — replaces the manual per-item loop that caused BUG-01. |
| `js/admin-sales.js` (`calculateProfit`) | `computeMargin` |
| `js/admin-analytics.js` (`renderProfitInsights`) | `computeMargin` |

Tests: `tests/sale-calculations.test.js`, using Node's built-in test runner (`node:test` + `node:assert/strict`) — no dependencies installed. Run with:
```
node --test tests/sale-calculations.test.js
```

## 2. The exact formulas

**Standard (non-builder) line** — unchanged from before:
```
food_cost_per_unit      = recipe_costs.cost_per_yield_item(recipe_id) * menu_items.recipe_units_used
packaging_cost_per_unit = packaging_profile_costs.packaging_cost(packaging_profile_id)
total_cost_per_unit     = food_cost_per_unit + packaging_cost_per_unit
line_revenue            = order_items.line_total
line_profit             = line_revenue - (total_cost_per_unit * quantity)
```

**Builder (Mix & Match) line — the BUG-01 fix.** One order line becomes two or more sale-item lines:
```
PARENT line (the box itself):
  line_revenue  = order_items.line_total      <- owns 100% of the box's revenue
  food_cost     = 0
  packaging_cost = 0                          <- fully captured by children below
  line_profit   = line_revenue

CHILD line (one per selection):
  food_cost_per_unit      = recipe_costs.cost_per_yield_item(selection.recipe_id) * recipe_units_used
  packaging_cost_per_unit = packaging_profile_costs.packaging_cost(selection.packaging_profile_id)
  quantity                = selection.quantity * order_items.quantity
  line_revenue            = 0                 <- never double-counted
  line_profit             = -(total_cost_per_unit * quantity)
```

**Sale-level totals** (used identically by both Sales and Analytics):
```
revenue        = sum(line_revenue)
food_cost      = sum(food_cost_per_unit * quantity)
packaging_cost = sum(packaging_cost_per_unit * quantity)
total_cost     = food_cost + packaging_cost
profit         = revenue - total_cost
margin         = revenue > 0 ? (profit / revenue) * 100 : 0        <- never NaN/Infinity
```

## 3. Files changed or created

| File | Change |
|---|---|
| `js/sale-calculations.js` | **New.** The shared module described above. |
| `tests/sale-calculations.test.js` | **New.** 11 tests (10 required + 1 covering a discovered real-data ambiguity — see §5). |
| `js/admin-orders.js` | Modified — `createSaleFromOrder()`'s manual line-construction loop replaced with calls into `SaleCalculations`; `sales.revenue` is now also re-synced on completion (previously frozen from `orders.subtotal` and never updated), so `sales.revenue` and `sum(sale_items.line_revenue)` can never diverge again by construction. |
| `js/admin-sales.js` | Modified — `calculateProfit()`'s inline margin formula replaced with `SaleCalculations.computeMargin()`. |
| `js/admin-analytics.js` | Modified — `renderProfitInsights()`'s inline margin formula replaced with `SaleCalculations.computeMargin()`. |
| `admin/orders.html`, `admin/sales.html`, `admin/analytics.html` | Modified — one `<script src="../js/sale-calculations.js">` tag added before each page's own script, so the shared module is loaded first. No visible markup, CSS, or navigation changed. |

## 4. Test results

```
✔ 1. standard single-product order — cost and profit computed normally
✔ 2. Mix & Match box by itself — parent owns full revenue, children own cost/quantity
✔ 3. order with standard products and a Mix & Match box
✔ 4. multiple Mix & Match boxes in one order — each gets its own parent line
✔ 5. box selections with different production costs are each costed correctly
✔ 6. missing or malformed selection data is skipped, never throws, revenue preserved
✔ 7. zero revenue never produces NaN or Infinity
✔ 8. revenue is counted exactly once per box, never once per child selection
✔ 9. child quantities and identities remain available for per-product analytics
✔ resolves the correct box among multiple boxes that share one builder_group
✔ 10. Sales-style and Analytics-style aggregation agree exactly

tests 11, pass 11, fail 0
```

`node --check` also passes clean on every modified/created `.js` file.

## 5. Ambiguity discovered (and how it was resolved)

The original fix plan assumed a builder order line's own `menu_items` row could be resolved via `builder_details.builder_group`. Checked directly against live data before implementing:

```sql
select id, name, builder_group from menu_items where product_type = 'builder';
```
**Four separate, real builder products share the identical `builder_group` value `"cookie"`** ("12 Brown Butter Sea Salt Chocolate Chip Cookies", "12 Mix & Match Cookies", "6 Brown Butter Sea Salt Chocolate Chip Cookies", "6 Mix & Match Cookies") — `builder_group` marks which *standard* products are eligible choices, not which specific *box* a given order line was. It cannot uniquely resolve a box. Separately, real stored `order_items.builder_details` values were also checked directly and **never actually contain a `builder_group` key at all** — only `{"selections": [...]}` — so that field isn't even persisted per order today.

**Resolution:** the parent line resolves its own `menu_items` row via `item_name` instead (copied verbatim onto `order_items` at checkout, confirmed unique among the five live builder products). A missing or unmatched name degrades gracefully to `menu_item_id: null` rather than blocking the revenue line. Covered by its own regression test.

## 6. Historical regression: stored vs. corrected, for all 34 existing sales

Recomputed **read-only**, in two passes, against every affected sale's real stored data — nothing written back at any point. Only `sale_id`/`order_id` (internal keys) are referenced anywhere in this report; no customer name, email, or phone was queried or displayed.

### 6a. The BUG-01 fix, isolated and verified (18 sales that contain a Mix & Match box) — **€335.00, confirmed**

**Verified historical profit correction: exactly €335.00**, computed entirely from already-stored, already-correct historical values — `sales.revenue - sales.total_cost`, per sale, summed across the 18 — never touching `recipe_costs`/`packaging_profile_costs`. This matches the original security-phase audit's independently measured revenue gap (§ "18 of 34 sales... €335.00 of revenue... missing from the profit calculation") exactly, because in the correct accounting, `sales.revenue` and `sales.total_cost` were **already both correct** for all 18 sales — confirmed directly (see §6a-1 below) — so profit-delta and revenue-delta are mathematically identical once cost is held fixed at its true historical value.

| | Stored (today, live) | Corrected |
|---|---|---|
| Revenue across these 18 sales | — | **Unchanged**, delta **€0.00** — revenue was never wrong |
| Cost across these 18 sales | — | **Unchanged**, delta **€0.00** — cost was never wrong either (see below) |
| Profit across these 18 sales | lower, several falsely negative | **+€335.00 higher**, in total |

Several sales moved from a false loss to a real profit — e.g. one sale's margin corrects from **-66.97% to +36.92%**, another from **-19.51% to +46.43%**. These were never loss-making orders.

#### 6a-1. Precisely which fields were wrong, confirmed directly against live `sale_items`

Queried the actual stored `sale_items` for all 18 sales directly (not recomputed):

- `sales.revenue`: **already correct** for all 18 — set once from `orders.subtotal` at sale creation and never touched again by the bug.
- `sales.food_cost` / `packaging_cost` / `total_cost`: **already correct** for all 18 — always fully captured by the child lines, which were never missing.
- `sales.profit`: **wrong** for all 18 — this is the only sale-level field the backfill needs to touch.
- `sale_items`: **missing the parent (box) row entirely** — confirmed 0 of 18 sales have any revenue-bearing row for their box.
- `sale_items.line_profit` on the existing *child* rows: **also wrong, independently** — hardcoded to `0` at creation instead of the true negative value, so Analytics' Product Breakdown has been showing Mix & Match child products at a misleading exact-€0 profit per line historically. The backfill corrects this too.

#### 6a-2. Why the earlier €316.50 figure was invalid

The first pass of this regression (above, superseded) recomputed **all** line costs — including the 18 builder sales' child costs — using `recipe_costs`/`packaging_profile_costs` **as they are today**, rather than trusting the values already frozen in `sale_items` at each sale's completion date. Ingredient/recipe costs have moved since some of these sales were made, so "recompute everything with today's prices" produced a profit correction (**€316.50**) that silently blended two unrelated things: the real BUG-01 fix, plus incidental cost drift unrelated to it (the same drift documented harmlessly in §6b for standard sales). That number should not be used — **€335.00 is the correct, verified figure**, because it holds cost fixed at its true, already-correct, already-stored historical value and only corrects the one field that was actually wrong.

### 6b. Cost-data drift (expected, not a bug) — 8 standard-only sales

8 non-builder sales show a small profit change (roughly -€0.58 to +€1.18 each) **only when recomputed with today's ingredient costs**, with zero revenue change. Confirmed the actual stored `sale_items` values for these are static — nothing in the schema has ever updated a `sale_items` row after its one-time insert (no trigger, no code path). The drift exists only in a hypothetical "what would this cost today" recomputation, not in the database. **No action needed; must not be backfilled** — doing so would incorrectly overwrite correctly-preserved historical cost with today's prices.

### 6c. Two standard sales with a real, confirmed anomaly — now tracked as its own bug, not part of BUG-01

Root cause fully confirmed with direct evidence (not inferred) and is now filed as its own defect — see **BUG-22** in `03-bug-register.md`. Summary: both orders' `order_items` are one line short of what each sale's frozen `sale_items` snapshot totals to (€45.00 and €30.00, the *original*, accurate amounts). The completed sale record is accurate; the live `order_items` list has since drifted from it. **These two sales are not touched by, and must not be included in, the BUG-01 backfill.**

**Update 2026-08-25 (re-investigated, read-only, as part of the deleted-static-cookie-pack audit — see `03-bug-register.md` BUG-22 for the full note):** the missing line's frozen name is **"6 Pack"** (`sale_items.item_name`; `menu_item_id` is `null`, so no further identity is recoverable). Contrary to this section's original phrasing, `orders.subtotal` for both orders **still exactly matches the original €45.00/€30.00 today** — it was never reduced; only the `order_items` row itself is missing. That points to the row having been removed out-of-band (directly against the database), not through the app's own edit-and-save path, which always keeps `order_items` and `subtotal` in sync. Confirmed unrelated to the four static cookie-pack `menu_items` deleted 2026-08-24 (six weeks later than these two orders' 2026-07-12 completion date, and that FK is `ON DELETE SET NULL`, never `CASCADE`).

### 6d. Whole-book totals (superseded — see 6a for the correct, isolated BUG-01 number)

The earlier whole-book comparison in this section mixed the (now corrected) BUG-01 effect with §6b's cost-drift artifact and §6c's unrelated anomaly. It is removed here in favor of the isolated, verified figures in 6a/6b/6c above, which do not need to be summed into one blended "book total" to be useful or accurate.

## 7. Phase 1B — historical backfill applied (2026-08-17)

The 18 historical Mix & Match sales identified in §6a have been backfilled directly in the live database, after the future-sale code fix (Phase 1A) was deployed and verified in production. Applied via `supabase/migrations/20260817105550_backfill_bug01_mix_and_match_18_historical_sales.sql`, exactly as planned in the superseded version of this section: inserted the missing revenue-bearing parent `sale_items` row for each of the 19 builder order lines (one sale has two boxes), corrected the 28 existing child rows' `line_profit` from their own already-stored `total_cost` (never recomputed), and set `sales.profit = revenue - total_cost` for all 18 — using **only** already-stored historical values, never `recipe_costs`/`packaging_profile_costs` as they stand today.

**Verified after applying:**
- All 18 sales reconcile at both the sale level (`profit = revenue - total_cost`) and the sale-item level (`revenue = sum(sale_items.line_revenue)`).
- Total profit across the 18 rose from **-€16.17 to €318.83** — a swing of exactly **€335.00**, matching every independent measurement of this bug's impact throughout this report.
- The two anomalous sales (§6c, BUG-22) and the 8 cost-drift sales (§6b) are confirmed byte-identical to their pre-migration values — untouched, as required.
- `orders`, `order_items`, `ingredients`, and `recipes` row counts are unchanged; zero duplicate revenue-bearing rows exist for any of the 18 sales.
- A safety assertion inside the migration's own transaction independently re-derived the expected profit sum and aborted automatically on first attempt (a transposition mistake in the hardcoded expected value, `145.28` instead of `318.83`) with zero side effects, before being corrected and re-applied successfully — confirming the transaction-safety design worked as intended.

A deterministic, backup-table-free rollback (derived from the exact pre-migration values captured before this ran) is recorded at `supabase/rollbacks/20260817105550_backfill_bug01_mix_and_match_18_historical_sales_rollback.sql`, scoped to precisely these 18 sale IDs.

- The two anomalous sales in §6c remain tracked as BUG-22 and were not corrected — and must not be, since their `sales`/`sale_items` records are already accurate.
- The cost-drift noise in §6b required no action — it's expected behavior of historical cost-freezing working correctly, and was not backfilled.
- No currency, CSS, navigation, or public storefront changes were made anywhere in this phase.
