# 03 — Bug Register

Severity: **Critical** (wrong money shown to the owner, or a live security exposure), **High** (wrong data reaches a report or breaks a workflow), **Medium** (real defect, contained impact), **Low** (cosmetic/cleanup).
Confidence: **High** (directly traced in code, and DB-verified where applicable), **Medium** (strongly implied, one unverifiable link), **Needs verification** (depends on live schema/data).

**Updated 2026-08-17** after directly inspecting the live Supabase project (read-only — schema, views, functions, triggers, RLS policies, grants, and the security/performance advisors; see `01-architecture-and-data-flow.md` §8 for method). Several findings below were corrected or quantified as a result; four new findings (BUG-16 through BUG-21) came directly from the database and were not visible from the application source code alone.

**Update 2026-08-17 (later the same day): BUG-16, BUG-17, and BUG-18 have been fixed, applied, and verified live.** Two migrations were applied — see `supabase/migrations/` and `08-security-repair-plan.md` Part I for the full applied SQL, verification tests, and one follow-up gap (a missing admin `INSERT` policy) found and fixed during verification.

**Update 2026-08-17 (Phase 1A/1B): BUG-01 fully resolved** — shared calculation module + tests shipped, then the 18 already-affected historical sales backfilled and verified live. See `09-bug01-regression-report.md`.

**Update 2026-08-17 (Phase 2): BUG-02, BUG-03, BUG-04, BUG-05, BUG-12, BUG-13, BUG-14, BUG-20, and BUG-22 are now resolved and verified**, covering every remaining confirmed calculation and data-integrity defect that didn't depend on the still-undecided EUR/USD exchange-rate design (BUG-06/BUG-19, deliberately deferred). Two new shared, dependency-free-tested modules were added — `js/order-editor.js` (BUG-02/BUG-22) and `js/recipe-costing.js` (BUG-04/BUG-05) — plus one narrowly-scoped, idempotent Supabase migration (BUG-20, `supabase/migrations/20260817112120_...sql`, with a deterministic rollback). Full detail in each bug's own entry below. Currency conversion, CSS cleanup, and visual redesign (BUG-06, BUG-09, BUG-19, BUG-21, Phase 3 items) remain explicitly out of scope for this phase.

**Update 2026-08-17 (Phase 3): BUG-06 and BUG-19 are now resolved and verified live** — the EUR customer-pricing vs. USD internal-reporting currency design is fully implemented: an `exchange_rates` cache table, new explicit `usd_*` columns on `sales`/`sale_items` (the original EUR columns are never repurposed), a snapshotted-per-sale exchange rate sourced from an ECB-derived, no-API-key rate service with a safe manual fallback, and a verified historical backfill of all 34 existing sales. Sales and Analytics now read and display these USD figures exclusively. Full detail in each bug's own entry and in `02-calculation-audit.md` §13. CSS cleanup and visual redesign remain explicitly out of scope.

**Update 2026-08-17 (BUG-23 fix): Production's revenue/cost/profit/margin projections are now resolved and verified**, closing the currency-mixing gap discovered while implementing Phase 3 above. Reuses the same `js/currency-conversion.js` module and rate-resolution order, but with the CURRENT (not per-sale-snapshotted) rate, since Production plans unconfirmed, in-progress orders that have no completed sale yet — that rate is never written onto any order or sale. Historical `production_runs` snapshots are unaffected. Full detail in BUG-23's own entry below.

**Update 2026-08-17 (Phase 4): admin dashboard reorganization and CSS refactor complete.** All 13 admin pages now share one nav-rendering module (`js/admin-shell.js`) instead of 13 hand-copied `<nav>` blocks, grouped into Overview/Orders/Production/Catalog/Inventory/Sales/Community with a working mobile off-canvas toggle. The CSS refactor consolidated 108 duplicate top-level selector groups in `css/admin.css` into single, cascade-correct definitions; removed a confirmed set of dead selectors (an old pre-multi-page admin.js-era layout, plus a few superseded component variants); and fixed a real structural bug — an unclosed `@media (max-width: 1000px)` had been silently trapping ~1,100 lines of Dashboard CSS so it only ever applied at narrow viewports. The stranded, minified `.production-*` block was moved into a real `css/production.css` (BUG-09). Two more undefined `var()` references (`--border-color`, `--burgundy`) were found and fixed. BUG-07/BUG-08/BUG-09/BUG-11 resolved; BUG-10 remains open (out of this phase's scope, see its own entry). No calculation, currency, or database logic was touched. Full detail in `04-admin-ux-audit.md` and `05-css-audit.md`'s Phase 4 updates.

**Update 2026-08-17 (Phase 5): public-site polish and CSS cleanup complete.** `css/style.css` (1,724 → 1,578 lines): consolidated its 7 duplicate top-level selector groups; removed confirmed-dead selectors from an earlier design iteration (`.jess-note*`, a removed "note" section; `.builder-order-*`, superseded cart markup; `.secondary-btn`, never used anywhere); and fixed three previously-undiscovered bugs — a duplicated `background:` property name that made `body`'s entire gradient background declaration invalid CSS (silently dropped by the browser), a typo'd `olor:` property (should be `color:`, on `.footer-bottom`), and three undefined `var(--text-light)`/`var(--deep-burgundy)` references (mapped to the real `--muted`/`--burgundy` tokens, matching what a later, correct duplicate definition already used). Added a global `:focus-visible` ring, `prefers-reduced-motion` support, and a skip-to-content link on all 4 public pages (index/menu/reviews/contact) — none existed before. Resolved **BUG-10** (see its own entry): extracted the one genuinely-duplicated piece of `js/admin-dashboard.js`/`js/admin-reviews.js` (the pending-reviews query) into a small shared, tested module, `js/admin-reviews-shared.js`, while deliberately leaving their different render/action logic alone. No ordering, calculation, currency, admin, or Supabase logic was touched; confirmed via the full existing test suite passing unchanged. Full detail in `05-css-audit.md`'s Phase 5 update.

---

### BUG-16 — Row Level Security is disabled on `orders` and `order_items`; all customer data and order data is publicly readable and writable — **RESOLVED (2026-08-17)**
- **Status: Fixed and verified live.** RLS enabled on both tables via `supabase/migrations/20260817092629_security_repair_bug16_17_18_orders_rls_admin_functions_cost_views.sql`. Verified: `anon` blocked from `SELECT`/`UPDATE`/`DELETE` on both tables (`42501 permission denied`, at the grant layer); the legitimate anon `INSERT`-only checkout flow still works; the real approved administrator retains full read access. Row counts unchanged before/after (35 orders, 60 order items).
- **Follow-up found during verification, also fixed:** the migration correctly preserved the pre-existing `SELECT`/`UPDATE`/`DELETE` admin policies but — matching the pre-RLS policy set exactly — never added an `INSERT` policy for `authenticated`, since none had ever been needed while RLS was disabled. This surfaced as a real failed checkout (`new row violates row-level security policy for table "orders"`), traced via Postgres logs to a request running as `authenticated` rather than `anon` (most likely an admin session already active in the same browser while testing checkout — determined by reasoning about the policy definitions themselves, without displaying any token or personal information). Fixed by a second migration, `supabase/migrations/20260817094213_restore_admin_insert_orders_order_items.sql`, adding `is_admin()`-gated `INSERT` policies for `authenticated` on both tables. Verified: the real admin can insert; a simulated authenticated non-admin is correctly rejected; anonymous checkout and the anon read/write blocks are unaffected. Full incident writeup in `08-security-repair-plan.md` Part I.
- **Affected pages:** Every page that touches orders (Orders, Production, Sales at one remove via `sales.order_id`) — but really, this affects the database directly, independent of any page.
- **Where:** `public.orders`, `public.order_items` (confirmed via Supabase security advisor + `pg_policies`)
- **Current behavior:** Both tables have admin-only RLS policies already defined and named correctly ("Admins can view/update/delete orders", "Public can create orders", and the equivalent for `order_items`) — but **Row Level Security itself was never enabled on either table**, so none of those policies are enforced. The site's public anon key is embedded in every visitor's browser (`js/supabase.js`). Right now, any internet visitor — logged in or not — can read every customer's name, email, phone number, and full order history directly from the Supabase REST API, and can insert, modify, or delete any order or order line, with no authentication at all.
- **Expected behavior:** RLS enabled on both tables so the existing policies actually take effect.
- **Severity:** **Critical** — this is a live, exploitable data exposure of customer PII and financial records, not a display bug. It is unrelated to every other finding in this audit and should be treated as urgent regardless of when the calculation fixes happen.
- **Confidence:** High — confirmed directly by the Supabase security advisor and by reading the actual RLS state and policy list.
- **Remediation (not applied — inspect-only per this audit's constraints):**
  ```sql
  ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
  ```
  The existing policies on both tables already look correctly scoped (admin-only for read/update/delete, public-insert-only for new orders) — turning RLS on should not require also rewriting the policies, but this should be verified in a safe/staging context before flipping it in production, since enabling RLS with no matching policy for a given operation blocks that operation entirely.
- **Dependencies:** None technical. This is a database change (not application source), and per this audit's scope was flagged for the owner's decision, not applied.
- **Recommended phase:** **Before Phase 1** — this should not wait for the calculation fixes.

---

### BUG-17 — Two `SECURITY DEFINER` functions are callable by unauthenticated users — **RESOLVED (2026-08-17)**
- **Status: Fixed and verified live**, via the same migration as BUG-16. Both functions now check `public.is_admin()` internally (raising an exception if the caller isn't the approved admin), have a fixed `search_path`, and had `EXECUTE` revoked from `anon`/`PUBLIC`. Verified: `anon` calling either function is rejected with `42501 permission denied` before the function body even runs; the real admin's `is_admin()` check (confirmed via their actual identity, not just a role switch) returns `true`, so their calls are unaffected. `prepare_new_ballot` and `rls_auto_enable` also received the fixed-`search_path`/grant hygiene fixes described in the plan.
- **Affected pages:** Production (`complete_production`), the ballot feature (`end_current_ballot`) — but exploitable directly via the API, bypassing any page.
- **Where:** `public.complete_production(p_production_date, p_snapshot, p_deductions)`, `public.end_current_ballot(ballot_uuid)`
- **Current behavior:** Both functions run with elevated database privileges (`SECURITY DEFINER`) and are exposed at `/rest/v1/rpc/...` to the `anon` role (confirmed via the security advisor). `complete_production` really does deduct `ingredients.quantity_on_hand` and mark a `production_runs` row completed (its own logic is correct and safe — row-locked, floors at zero, refuses to double-run — see `01-architecture-and-data-flow.md` §8) — but nothing stops anyone from calling it directly with fabricated deduction amounts for any date, with no login. `end_current_ballot` lets anyone archive the currently active ballot at will (its ID is publicly readable via `ballot_settings`' own public SELECT policy).
- **Expected behavior:** These functions should only be callable by authenticated admins.
- **Severity:** High — `complete_production` can corrupt real inventory records without any authentication; `end_current_ballot` is lower-stakes (a customer-facing voting feature) but has the same underlying gap.
- **Confidence:** High.
- **Remediation (not applied):** Revoke `EXECUTE` from `anon` (and, if these should only ever be called by the admin dashboard, from `authenticated` too, or add a caller check inside the function) — the exact fix is a database change and an owner decision on intended access, not made in this audit-only pass.
- **Recommended phase:** Before Phase 1, alongside BUG-16.

---

### BUG-18 — Internal cost data is publicly queryable — **RESOLVED (2026-08-17)**
- **Status: Fixed and verified live**, via the same migration as BUG-16/17. Both views converted to `security_invoker = true`, so they now run with the querying role's own privileges instead of the view owner's — they inherit the same `authenticated`-only restriction already correctly in place on the underlying `ingredients`/`recipes`/`packaging_profiles` tables. `anon`'s grant on both views was also revoked directly. Verified: `anon` querying either view is rejected with `42501 permission denied for view`; the real admin retains full access, confirmed reading a row count matching every real recipe/packaging profile in the database.
- **Affected pages:** None directly — exploitable via the API regardless of page.
- **Where:** `public.recipe_costs`, `public.packaging_profile_costs` (both views)
- **Current behavior:** Both views are flagged `SECURITY DEFINER` by the advisor and confirmed (via `information_schema.role_table_grants`) to grant `SELECT` to `anon`. The underlying `ingredients`/`recipes`/`recipe_ingredients` tables are correctly restricted to `authenticated` only — but because these views run with the view-owner's elevated privileges, that restriction doesn't apply to them. In practice, anyone can query the bakery's internal ingredient cost, recipe cost, and packaging cost — commercially sensitive numbers the owner would reasonably not want a competitor or the general public to see — without logging in.
- **Expected behavior:** These views should be restricted to `authenticated` (or rebuilt as `SECURITY INVOKER`, which Postgres supports for views, so they naturally inherit the caller's own RLS restrictions instead of the owner's).
- **Severity:** High (business-sensitive data exposure; not a customer-safety issue the way BUG-16 is, but still a real confidentiality gap).
- **Confidence:** High.
- **Recommended phase:** Before Phase 1, alongside BUG-16/17.

---

### BUG-19 — No currency or exchange-rate columns exist in the schema — **RESOLVED (Phase 3, 2026-08-17)**
- **Status: Fixed and verified live.** `sales` gained `exchange_rate`, `exchange_rate_date`, `exchange_rate_source`, `usd_revenue`, `usd_profit`; `sale_items` gained `usd_line_revenue`, `usd_line_profit` — all new, explicit, unambiguous columns (the original EUR `revenue`/`line_revenue` are never repurposed or converted in place). A new `exchange_rates` cache table stores EUR→USD daily reference rates. See BUG-06 below for the full design and live verification.
- **Superseded:** the original recommendation that `ingredients`/`purchases` need a per-row currency field (since purchases are genuinely made in both USD and EUR) is no longer the owner's direction — the owner's Phase 3 confirmed rule is simpler: Inventory, recipe costs, and packaging costs report in USD, full stop (this was already true — Inventory has always displayed `$`). No ingredient/purchase schema change was made or is currently wanted.
- **Affected pages:** Sales, Analytics.
- **Where:** `sales`, `sale_items` (new columns), `exchange_rates` (new table).
- **Severity:** Resolved (was Medium).
- **Confidence:** High (verified live).
- **Recommended phase:** Phase 3 — **done**.

---

### BUG-20 — Deleting a component recipe silently cascades, removing it from every recipe that uses it — **RESOLVED (Phase 2, 2026-08-17)**
- **Status: Fixed and verified live.** Re-confirmed live before fixing (`confdeltype = 'c'`, i.e. CASCADE). Fixed via a narrowly-scoped, idempotent, constraint-only migration, `supabase/migrations/20260817112120_bug20_recipe_components_restrict_component_delete.sql`, changing `recipe_components_component_recipe_id_fkey` to `ON DELETE RESTRICT` — matching the safe behavior already correct for the other two "still in use" cases. `recipe_components_parent_recipe_id_fkey` (deleting a recipe should still remove its own component-link rows) was deliberately left as CASCADE. **Verified live**: `confdeltype` is now `r`; a transaction-wrapped, rolled-back test delete of "Cream Cheese Frosting" (confirmed used by 4 real recipes) now fails with `23503 violates foreign key constraint` instead of silently cascading. Deterministic rollback recorded in `supabase/rollbacks/`; no data was read, written, or needed backfilling (constraint-only change). Paired with a friendly pre-delete usage check in `deleteRecipe()`/`deleteIngredient()` — see BUG-14.
- **Affected pages:** Inventory (Recipes tab)
- **Where:** `recipe_components_component_recipe_id_fkey`.
- **Severity:** Medium — narrower than originally suspected (only affected component recipes specifically, not ingredients or standalone recipes, both of which were already safely blocked by the database), but was a confirmed, real, silent-data-loss path.
- **Confidence:** High (confirmed directly via `pg_constraint`, both before and after).
- **Recommended phase:** Phase 2 — **done**.

---

### BUG-21 — Minor Supabase hardening and performance items — **RESOLVED (all SQL/code-fixable items), 1 item Accepted plan limitation (2026-08-18)**
- **Affected pages:** None directly.
- **Update 2026-08-18:** The old `gallery_items` table (zero rows, RLS-enabled-no-policy) no longer exists — it was dropped by the Gallery feature migration (`20260817163139_gallery_photos_albums_storage.sql`), which replaced it with `gallery_albums`/`gallery_photos`, both fully RLS-policied from the start (public can view published/available rows; admins have full CRUD). That sub-item is resolved as a side effect of shipping Gallery, not by this pass.
- **Status: The three DB-safe items are fixed and verified live**, via `supabase/migrations/20260818090000_bug21_fk_indexes_redundant_rls_search_path.sql` (deterministic rollback in `supabase/rollbacks/`):
  1. **15 unindexed foreign keys** (re-confirmed live, one more than originally estimated: `ingredients.category_id`/`supplier_id`, `menu_items.packaging_profile_id`/`recipe_id`, both `order_items` FKs, both `purchases` FKs, both `recipe_components` FKs, both `recipe_ingredients` FKs, both `sale_items` FKs, `sales.order_id`) — all now covered by a plain `create index if not exists`, purely additive.
  2. **Redundant permissive RLS policies** on `gallery_photos`, `menu_items`, and `reviews` (each had a "Public can view ..." policy granted to the `public` pseudo-role, which overlaps `authenticated` with the "Admins can view all ..." policy already granting unconditional SELECT) — scoped the public policy to `anon` only on all three; `suggestions`' two literally-identical `authenticated`/SELECT/`true` policies were de-duplicated to one. Verified via `information_schema.role_table_grants` before applying that `anon` already holds an explicit table-level SELECT grant on all three tables, so anonymous visitors keep identical access; admins keep unconditional access via their own unchanged policy.
  3. **`set_packaging_updated_at`'s mutable search_path** — fixed with `alter function ... set search_path = public`, matching the convention already used for every other function in `20260817092629_...`.
  - **Verified live:** re-running the Supabase performance and security advisors after applying shows all three targeted categories (`unindexed_foreign_keys`, `multiple_permissive_policies`, `function_search_path_mutable`) gone. No table's row data was read, written, or deleted (indexes/policies/function options only).
- **Deliberately left alone, not part of this fix:**
  - `admins` RLS-enabled-no-policy — intentional; the table is only ever read through the `SECURITY DEFINER` `is_admin()` function, not directly.
  - The three `authenticated`-executable `SECURITY DEFINER` function warnings (`complete_production`/`end_current_ballot`/`is_admin`) — legitimate: the real admin calls these as an authenticated user, and each already gates on `is_admin()` internally (see BUG-17). Revoking `authenticated` `EXECUTE` would break the admin dashboard.
  - **Leaked-password protection — Accepted plan limitation, not open/broken/unresolved.** This is a Supabase Auth setting, not SQL-reachable, so no migration in this repo can touch it — but it is *also* not just a dashboard toggle away: confirmed 2026-08-18 via the project's own Supabase dashboard that this project is on the **Free** plan, and leaked-password protection (checking new passwords against HaveIBeenPwned) is a **Pro-plan-and-above** feature. It cannot be enabled at the current plan tier, full stop. **It remains disabled today** — nothing in this repository has enabled it, and nothing here claims otherwise. Upgrading the project to Supabase **Pro** (or higher) would make the setting available at Dashboard → Authentication → Policies → Password Security → "Leaked password protection." Until/unless the owner upgrades, this item is accepted as-is rather than treated as an outstanding defect.
- **Severity:** Low across the board (unchanged). The one remaining item is a plan-tier limitation, not a severity/risk judgment call.
- **Confidence:** High (verified live via advisors, policy inspection, and grant inspection both before and after; plan tier confirmed directly in the Supabase dashboard).
- **Recommended phase:** Opportunistic — **done: every SQL/code-fixable item resolved 2026-08-18.** Leaked-password protection: **Accepted plan limitation** — revisit only if the project is upgraded to Supabase Pro or higher.

---

### BUG-22 — Completed orders can still be edited, letting live `orders`/`order_items` diverge from the frozen `sales`/`sale_items` record — **RESOLVED (Phase 2, 2026-08-17)**
- **Status: Fixed and verified.** Confirmed live before fixing: the order card's Edit button was already conditionally hidden for non-pending/confirmed orders, but neither `editOrder()` nor `saveManualOrder()` itself enforced this — there was no guard against the function being reached another way, and no guard at all against the order's status changing *while* the editor was open (e.g. someone else completing it in another tab).
- **Fix:** Two independent, defense-in-depth guards, both built on the same shared `OrderEditor.isOrderEditable(order)` pure check (`js/order-editor.js`): (1) `editOrder()` now refuses to open the editor at all if the just-fetched order is already `completed`; (2) `saveManualOrder()`, when editing, re-fetches the order's *live* status immediately before writing and aborts if it is now `completed` — closing the race where status changes after the editor was opened. Completed orders remain fully visible on their order card either way (viewing was never gated on the editor); only the edit action is blocked.
- **Test coverage:** `tests/order-editor.test.js` tests 1-4 cover `isOrderEditable()` directly (pending/confirmed → editable, completed → not editable, missing order → not editable).
- **The two already-diverged historical orders were intentionally left untouched** — their frozen `sales`/`sale_items` records are already correct and must stay exactly as they are (see `09-bug01-regression-report.md` §6c); this fix only prevents new instances, per the original scope note.
- **Update 2026-08-25 (re-investigated, read-only, as part of the deleted-static-cookie-pack audit):** confirmed these are the same two sales, not a new/separate defect, and not connected to the four static cookie-pack `menu_items` deleted 2026-08-24 (that deletion happened 6 weeks later, and `menu_items → order_items` is `ON DELETE SET NULL`, never `CASCADE`, so it structurally cannot remove an `order_items` row either way). The removed line's frozen name, recovered from `sale_items.item_name`, was **"6 Pack"** (`sale_items.menu_item_id` is `null` for this row in both sales, so it cannot be cross-referenced to any menu item, past or present — its original identity beyond this name is not recoverable). One refinement to the finding above: `orders.subtotal` for both orders **still exactly matches the sale's original total today** (€30.00 and €45.00) — it was never reduced. Only the `order_items` *rows* are short by the one "6 Pack" line each. Since a normal edit-and-save (`saveManualOrder()`) always recomputes `order_items` and `subtotal` together atomically, subtotal staying correct while only the row disappeared indicates that `order_items` row was removed **out-of-band** (directly against the database, not through the app's editor) — sometime before this fix existed. This also means the divergence is visibly self-flagging on the order card today (a total that doesn't match its own listed items), not a silently-wrong number. No code or data change is needed beyond what's already fixed here.
- **Affected pages:** Orders (`admin-orders.js`'s manual order editor); downstream effect on Sales/Analytics for any sale whose order is later edited.
- **Files/functions:** `js/order-editor.js` (new, `isOrderEditable`), `js/admin-orders.js` `editOrder()`, `saveManualOrder()`.
- **Severity:** Medium — the frozen `sales`/`sale_items` record itself was never at risk (this was never a financial-accuracy bug the way BUG-01 was), but it meant the live `orders`/`order_items` view of a completed order could silently stop matching the sale that was actually recorded.
- **Confidence:** High.
- **Dependencies:** None remaining.
- **Recommended phase:** Phase 2 — **done**.

---

### BUG-23 — Production's "Estimated Profit"/cost figures mix EUR revenue with USD cost, all labeled `€` — **RESOLVED (2026-08-17)**
- **Discovered:** 2026-08-17, while implementing Phase 3's confirmed currency rule ("Inventory, recipe costs, packaging costs, Sales, profit, margin, and Analytics report in USD").
- **Affected pages:** Production (`admin/production.html`'s "Expected Revenue"/"Ingredient Cost"/"Packaging Cost"/"Total Estimated Cost"/"Estimated Profit"/"Estimated Margin" cards, and each product's revenue subtext on the Products tab).
- **Files/functions:** `js/admin-production.js` `buildPlan()`, `renderAll()`, `renderCosts()`, `renderProducts()`.
- **Original behavior:** `revenue` was summed from `order.subtotal` (EUR) and `foodCost`/`packagingCost` from `recipe_costs`/`packaging_profile_costs` (USD, per the confirmed rule), then `profit = revenue - foodCost - packagingCost` and `margin = profit/revenue` combined the two currencies directly with no conversion, all formatted with `euro()` and displayed with `€`.
- **Status: Fixed and verified.** `buildPlan()` now resolves the CURRENT EUR→USD rate once per page load — via `resolveCurrentRate()`, reusing `CurrencyConversion.resolveExchangeRate()` (cache → live ECB-derived fetch → safe administrator-entered manual fallback) exactly as `createSaleFromOrder()` does for a completed sale — and reuses `CurrencyConversion.computeUsdSaleFigures()` to convert `revenue` (EUR) and combine it with `foodCost + packagingCost` (already USD, unchanged) into `usdRevenue`/`usdProfit`; margin is derived from those via the existing shared `SaleCalculations.computeMargin()`. Every product's per-product revenue subtext is converted with that same rate. **The rate is used only for this page's live projections and is never written onto any order or sale** — unconfirmed, in-progress orders have no completed sale to snapshot a rate onto, per the confirmed design; `plan.revenue`/`plan.profit`/`plan.margin` (the original EUR-based figures) are left completely unchanged internally and still feed `finishProduction()`'s `production_runs` snapshot exactly as before, so no historical record's shape or values were touched by this fix.
- **Failure/fallback handling:** if no rate can be resolved (no cache, live fetch fails, and the admin declines/cancels the manual prompt), `usdRevenue`/`usdProfit` stay `null` rather than silently showing a wrong or fabricated number — the affected KPI cards and metrics show `—` instead, with a dismissable warning and a **Retry** button (`retryCurrentRate()`) so the admin isn't stuck reloading the whole page.
- **Explicit USD labels:** KPI card labels ("Expected Revenue (USD)", "Estimated Profit (USD)") and the Costs panel's metric labels (all six, including the already-correct Ingredient/Packaging/Total cost) now say `(USD)` explicitly, formatted with a new `usd()` function (`$`, `en-US`) alongside the existing `euro()` (still used, unchanged, for the customer-facing order totals in the Included Orders section — those correctly stay EUR).
- **Test coverage:** `tests/production-currency.test.js`, 7 tests, exercising the exact reused `computeUsdSaleFigures`/`computeMargin` call shape with realistic Production figures: the mixed-currency-vs-converted reconciliation (test 1, the direct BUG-23 regression), margin correctness (2), missing-rate safety (3), invalid-rate safety (4), a zero-revenue day (5), same-rate-across-products consistency (6), and rounding consistency with Sales' own convention (7).
- **Severity:** Resolved (was Medium).
- **Confidence:** High — verified via 7/7 new tests plus the full existing suite (61/61 total), and the underlying conversion function is the same one already covered by `currency-conversion.test.js`'s 23 tests.
- **Recommended phase:** Fixed on request, same day as discovery.

---

### BUG-01 — Builder ("Mix & Match") sales show correct revenue but understated profit/margin
- **Affected pages:** Sales, Analytics (both read the `sales`/`sale_items` tables this bug corrupts)
- **Files/functions:** `js/admin-orders.js:648-958` `createSaleFromOrder()`
- **Current behavior:** When an order containing a Mix & Match box is completed, `sales.revenue` is set from `orders.subtotal` (correct, includes the box price), but every `sale_items` row generated for the box's contents is hard-coded `unit_price: 0, line_revenue: 0`. `sales.profit` is then recomputed from the sum of `sale_items.line_revenue` (which excludes the box price) minus the box's real ingredient/packaging cost (which **is** included correctly). `sales.revenue` is never re-synced.
- **Confirmed against live data (2026-08-17):** of the bakery's **34 completed sales, 18 (53%) contain a builder item, and all 18 show the predicted gap** (a direct, non-PII aggregate query — sale IDs and money columns only). **€335.00 of real revenue is currently missing from the profit calculation** across those 18 sales; several individual sales currently show a negative `profit` in the database despite having real, positive revenue. The 16 non-builder sales all reconcile exactly (`sum(sale_items.line_revenue) = sales.revenue`), confirming the defect is specific to builder products, not a general revenue bug.
- **Expected behavior / confirmed fix (owner decision, 2026-08-17):** The builder box itself becomes the parent sale line and carries all of that line's revenue; its selected products remain child lines contributing cost and quantity only, with no revenue attributed to them (to avoid double-counting). Concretely: insert one additional `sale_items` row per builder order line, using the builder's own `menu_items` row, carrying the real `unit_price`/`line_revenue`; leave the existing per-selection child rows exactly as they are (cost/quantity only, revenue at 0). See `02-calculation-audit.md` §5 for the full mechanics.
- **Severity:** Critical — directly misstates gross profit/margin on the two pages whose entire purpose is showing the owner accurate profit, and is already actively affecting the majority of recorded sales history.
- **Confidence:** High — traced in code **and** empirically confirmed against every affected row in production.
- **Dependencies:** None remaining — fix design is confirmed by the owner.
- **Status: Fixed and verified live — code fix deployed (Phase 1A) and historical data corrected (Phase 1B).** `js/sale-calculations.js` (new, shared, tested) plus a fixed `createSaleFromOrder()` in `js/admin-orders.js` prevent this from happening to any order completed from here forward — verified by an 11-test suite (`tests/sale-calculations.test.js`, `node --test`, all passing) covering standard orders, single and multiple builder boxes, mixed orders, differing per-selection costs, malformed selection data, zero-revenue edge cases, and confirming Sales/Analytics can never independently drift again. The 18 already-affected historical sales were then backfilled directly in the database via `supabase/migrations/20260817105550_backfill_bug01_mix_and_match_18_historical_sales.sql`, using only each sale's own already-stored `revenue`/`total_cost` (never today's ingredient costs): the missing revenue-bearing parent line was inserted for each builder box, the existing child lines' `line_profit` was corrected from their own stored `total_cost`, and each sale's `profit` was reset to `revenue - total_cost`. Verified after applying: all 18 sales reconcile at both the sale and sale-item level, total profit across the 18 rose from -€16.17 to €318.83 (a swing of exactly **€335.00**, matching every independent measurement of this bug's impact), the two BUG-22 anomaly sales and the 8 cost-drift sales are unchanged, and no duplicate rows were created. A deterministic, backup-table-free rollback is recorded in `supabase/rollbacks/20260817105550_backfill_bug01_mix_and_match_18_historical_sales_rollback.sql`. Full detail in `09-bug01-regression-report.md`. See also BUG-22, a separate, unrelated defect discovered while validating this fix.
- **Recommended phase:** Phase 1 code fix — **done**. Historical backfill — Phase 1B — **done**.

---

### BUG-02 — Editing an order containing a Mix & Match box silently deletes the box's contents — **RESOLVED (Phase 2, 2026-08-17)**
- **Status: Fixed and verified.** Root cause confirmed exactly as originally traced: `editOrder()` reconstructed `manualOrderItems` keyed by `menu_item_id`, and every builder line has `menu_item_id: null` — so two or more builder boxes in the same order collided on that single `null` key and only the last one survived; `saveManualOrder()` then rewrote `order_items` with no `builder_details` at all.
- **Fix:** Extracted the editor's item-reconciliation logic into a new shared, pure module, `js/order-editor.js` (`partitionOrderItemsForEditing`/`buildOrderItemsPayload`), used by `editOrder()`/`saveManualOrder()`. Builder lines (and any other line whose `menu_item_id` can't be resolved, e.g. a deleted menu item) are now partitioned into their own array — never a single shared key — and rendered as preserved, individually-removable-but-not-editable lines with their original `builder_details` carried through unchanged on save. Standard flat-item editing is completely unaffected.
- **Test coverage:** `tests/order-editor.test.js`, 13 tests (Node's built-in test runner), including a direct regression test for the exact two-boxes-collide-on-`null` scenario (test 7) and a full partition→rebuild round-trip (tests 9-11) confirming no line is ever silently dropped.
- **Affected pages:** Orders (edit flow); downstream effects on Production and Sales.
- **Files/functions:** `js/order-editor.js` (new), `js/admin-orders.js` `editOrder()`, `renderManualMenuItem()`/`renderManualBuilderItems()`, `saveManualOrder()`.
- **Severity:** High — was silent, irreversible data loss on save; corrupted downstream production planning and sale revenue for that order.
- **Confidence:** High — traced in code, root cause confirmed, and now covered by a direct regression test for the specific collision mechanism.
- **Dependencies:** None remaining.
- **Recommended phase:** Phase 2 — **done**.

---

### BUG-03 — Inconsistent ID-casting for packaging cost lookups (confirmed NOT a live bug)
- **Affected pages:** Menu (Menu Manager cards' "Packaging" cost, "Total Cost", "Estimated Profit")
- **Files/functions:** `js/admin-menu.js:108-113, 1694-1701` `getPackagingCost()`
- **Current behavior:** `packagingCosts` map is built from `packaging_profile_costs` keyed by raw `id`, but looked up via `Number(profileId)`. Two other files read the same view with two other conventions (`String(...)` in `admin-production.js`, raw/no-cast in `admin-orders.js`).
- **Resolved 2026-08-17:** Directly confirmed via Supabase that `packaging_profiles.id`/`packaging_profile_costs.id` are `bigint`, not UUIDs, and that real IDs are small integers (`2`–`6`). Cross-checked every live packaging profile against `menu_items.packaging_profile_id` and every lookup resolves correctly with real, non-zero costs. **The original hypothesis (that this silently zeroes out every menu card's packaging cost) does not hold** — `Number()` on a small integer is a harmless no-op.
- **Expected behavior:** Still worth standardizing on one casting convention across the three files, purely for consistency and to avoid this becoming a real bug if `packaging_profiles` is ever migrated to UUIDs (as most of the rest of the schema already uses).
- **Status: Resolved (Phase 2, 2026-08-17).** Standardized on `String(...)` everywhere: `js/admin-menu.js`'s `recipeCosts`/`packagingCosts` maps are now built and looked up with a consistent `String()` cast (previously raw key / `Number()`); `js/admin-production.js` already used `String()`; `js/admin-orders.js` routes through `js/sale-calculations.js`'s own consistent `key()` helper (added in Phase 1A). All sites now agree.
- **Severity:** Downgraded from Critical to **Low** — code-style inconsistency, not a functional defect.
- **Confidence:** High (directly verified against live schema and data).
- **Dependencies:** None.
- **Recommended phase:** Phase 2/3, opportunistic cleanup alongside other shared-utility consolidation — **done**.

---

### BUG-04 — Recipe cost on the Inventory tab silently ignores sub-recipe components (confirmed confined to that one tab)
- **Affected pages:** Inventory (Recipes tab, "Recipe Costing" panel) **only** — confirmed not to reach Menu, Sales, or Analytics.
- **Files/functions:** `js/admin-inventory.js:1446-1452` `getRecipeCost(recipe)`
- **Current behavior:** Sums only `recipe.recipe_ingredients`; never looks at `recipe.recipe_components` (sub-recipes).
- **Resolved 2026-08-17:** The canonical `recipe_costs` Postgres view (used by Menu and by sale creation) was inspected directly and **does** correctly and recursively include sub-recipe components, with cycle protection and full mass/volume/count unit conversion — better than any client-side implementation in the repo. Cross-checked against the 4 real recipes that use a shared component ("Cream Cheese Frosting"): the Inventory tab's display understates their true cost by **29–47%** (e.g. Cinnamon Rolls: DB-correct $7.70 vs. Inventory tab's $4.26).
- **Expected behavior:** The Inventory tab should either call the same view or replicate its recursive logic, so its displayed number matches reality.
- **Status: Resolved (Phase 2, 2026-08-17).** The Inventory tab's own duplicate `getRecipeCost()`/`getIngredientCost()`/`convertUnit()` were deleted entirely and replaced with a lookup into the real `recipe_costs` view, via a new shared module `js/recipe-costing.js` (`buildRecipeCostsById`/`resolveRecipeCost`). Recipe cost display now reads the same recursive, sub-recipe-aware figure Menu and sale creation already use — verified live against the exact 4 previously-understated recipes (e.g. Cinnamon Rolls now correctly shows $7.70, not $4.26). Covered by `tests/recipe-costing.test.js` (7 tests), including a direct regression test asserting the fixed value and explicitly asserting against the old wrong one.
- **Severity:** Downgraded from "affects costing everywhere" to **Medium** — confirmed display-only, confined to one tab, and confirmed not to affect pricing, sale creation, or Sales/Analytics.
- **Confidence:** High (verified against live view definition and real data).
- **Dependencies:** None remaining.
- **Recommended phase:** Phase 2 — **done**.

---

### BUG-05 — Ingredient/recipe unit conversion is incomplete on the Inventory tab (confirmed zero live impact today)
- **Affected pages:** Inventory (Recipes tab, "Recipe Costing" panel)
- **Files/functions:** `js/admin-inventory.js:1473-1495` `convertUnit()`
- **Current behavior:** Only converts between mass units (g/kg/lb/oz). Volume (mL/L/tsp/tbsp/cup) or count-unit-pair conversions return `null`, and the caller (`getIngredientCost`) treats that as **$0 cost**, with no warning shown. `admin-production.js`'s `convert()`, and the canonical `recipe_costs` database view, both correctly handle mass, volume, and count.
- **Resolved 2026-08-17:** Queried every ingredient's real `purchase_unit`/`recipe_unit`. **No ingredient in the live data uses a volume unit at all**, and every `each`-unit ingredient is purchased and used in the same unit (hitting the trivial same-unit branch, not the lookup table). The 11 ingredients with differing purchase/recipe units are all mass-to-mass (lb→g, oz→g), which this function already handles correctly. **The gap is real in the code but is not currently corrupting any number.**
- **Expected behavior:** One shared conversion utility (matching the database view's capability), used everywhere, so the gap can't become live the moment a new ingredient with a volume unit is added.
- **Status: Resolved (Phase 2, 2026-08-17).** Rather than reimplementing volume/count conversion a fourth time client-side, the Inventory tab's own unit-conversion logic (`convertUnit()`/`getIngredientCost()`) was deleted along with `getRecipeCost()` (BUG-04) and replaced with a lookup into the `recipe_costs` view, which already performs correct mass, volume, and count conversion server-side (verified in `01-architecture-and-data-flow.md`/`02-calculation-audit.md` §1). There is now exactly one conversion implementation actually reached by any page's *displayed* cost — the database view — eliminating the class of bug rather than patching the client copy.
- **Severity:** Downgraded from High to **Low** (currently zero impact) — but should still be fixed proactively rather than waiting for it to break.
- **Confidence:** High (verified against every real ingredient row).
- **Dependencies:** None.
- **Recommended phase:** Phase 2/3 — **done**.

---

### BUG-06 — Currency handling needs three different treatments, not one fix — **RESOLVED (Phase 3, 2026-08-17)**
- **Affected pages:** Inventory, Packaging (USD), Menu (mixes `$` and `€` on the same card), vs. Dashboard, Orders, Production, Sales, Analytics, and the entire public site (EUR)
- **Owner-confirmed final design (2026-08-17), simpler than the original nuance below:**
  1. Customers always see/pay EUR — unchanged. Public Menu, Cart, Checkout, and Orders stay EUR and were not touched.
  2. Inventory, recipe costs, packaging costs, Sales, profit, margin, and Analytics all report in **USD**. Inventory/Packaging were already USD-formatted (no ingredient/purchase currency field needed — see BUG-19's "Superseded" note).
  3. Sales and Analytics revenue/profit/margin are now genuinely converted from the underlying EUR sale amount using a **snapshotted, frozen exchange rate** captured once at sale-completion time — not just a relabeled formatter.
- **Status: Fixed and verified live.** `js/currency-conversion.js` (new, shared, pure, 23 tests) provides the conversion arithmetic, rate-resolution orchestration (cache → live ECB-derived fetch via `api.frankfurter.dev`, no API key → safe administrator-entered manual fallback), and the rounding-reconciliation logic that guarantees a sale's `usd_revenue` always equals the exact sum of its own `sale_items.usd_line_revenue` (including correctly handling the real rounding edge case found in 10 of the 34 historical sales — see the migration for detail — without ever letting a rounding residual land on a Mix & Match child line). `js/admin-orders.js`'s `createSaleFromOrder()` resolves and snapshots one rate per sale, applied identically to every one of that sale's lines. `js/admin-sales.js` and `js/admin-analytics.js` now read the explicit `usd_revenue`/`usd_profit`/`usd_line_revenue`/`usd_line_profit` columns exclusively for all money display, formatted with an unambiguous `$` (`euro()` renamed to `usd()` in both files, matching the site's existing Inventory convention). The 34 historical sales were backfilled using the exchange rate applicable to each one's actual completion date. Full detail in `02-calculation-audit.md` §13 and the migration itself.
- **Confidence:** High (verified live + 23/23 currency-conversion tests + full existing suite still passing).
- **Recommended phase:** Phase 3 — **done**.

---

### BUG-07 — `js/admin.js` is dead, unreachable, and does not even parse — **RESOLVED (Phase 4, 2026-08-17)**
- **Status: Fixed and verified.** Re-confirmed live before deleting: `grep`-searched every `admin/*.html`, `admin.html`, and every other page in the repo for `admin.js` — zero references anywhere (proof required before removal, per this bug's own remediation note). `js/admin.js` deleted outright (was 837 lines, didn't parse, contained a duplicate self-contained login/dashboard/reviews/ballot implementation predating the multi-page admin). Verified after deleting: `node --check` now passes on every remaining file in `js/`; `tests/admin-shell.test.js` test 10 asserts no admin page references it and that the file no longer exists, as a permanent regression guard.
- **Affected pages:** None (it was never loaded).
- **Severity:** Resolved (was Low/latent).
- **Confidence:** High.
- **Recommended phase:** Phase 0/1 cleanup — **done (Phase 4)**.

---

### BUG-08 — Leftover dead markup in `admin.html` — **RESOLVED (Phase 4, 2026-08-17)**
- **Status: Fixed and verified.** Removed the `#dashboard`/`#editOptionModal`/`#newBallotModal` block (built for the now-deleted `js/admin.js`, never used by `login.js`, the script that actually runs on this page). `admin.html` now contains only the login screen and its three scripts (`supabase.js`, `login.js`, and the Supabase CDN tag).
- **Affected pages:** `admin.html` (the login gate).
- **Severity:** Resolved (was Low).
- **Confidence:** High.
- **Recommended phase:** Phase 0/1 cleanup — **done (Phase 4)**.

---

### BUG-09 — `css/production.css` is referenced but does not exist — **RESOLVED (Phase 4, 2026-08-17)**
- **Status: Fixed and verified.** The ~9,000-character minified `.production-*` block that had been pasted onto the end of `admin.css` (see `05-css-audit.md`) was moved into a real, properly formatted `css/production.css` — exactly where `admin/production.html`'s existing `<link>` already pointed. Verified: `css/production.css` exists and is well-formed (brace-balanced); `tests/admin-shell.test.js` tests 11/15 assert the file exists and both `admin.css`/`production.css` are brace-balanced, as a permanent regression guard.
- **Affected pages:** `admin/production.html`.
- **Severity:** Resolved (was Low functional impact).
- **Confidence:** High.
- **Recommended phase:** Phase 1, bundled with the CSS cleanup — **done (Phase 4)**.

---

### BUG-10 — Duplicated pending-reviews logic (Dashboard vs. Reviews page) — **RESOLVED (Phase 5, 2026-08-17)**
- **Affected pages:** Dashboard, Reviews.
- **Files/functions:** `js/admin-dashboard.js` vs. `js/admin-reviews.js`.
- **Re-verified before fixing:** the two implementations had already drifted apart since this bug was first written — `admin-dashboard.js`'s reviews section is now a distinct, simpler read-only preview widget (pending count + top 3 cards, no actions), not the near-identical `renderPendingReviews`/`approveReview`/`deleteReview` CRUD the original finding described. The **only** piece still genuinely, exactly duplicated was the fetch query itself: `supabaseClient.from("reviews").select("*").eq("approved", false).order("created_at", {ascending: true})`, byte-for-byte identical in both files.
- **Status: Fixed and verified.** Extracted that one query into a new shared, UMD-exported module, `js/admin-reviews-shared.js` (`fetchPendingReviews(supabaseClient)`), used by both files. Deliberately did **not** try to unify the render/action logic downstream of it — the Dashboard's read-only preview and the Reviews page's full Approve/Delete list are genuinely different behavior, and forcing them into one shared render function would violate "don't force unlike functionality into one abstraction."
- **Test coverage:** `tests/admin-reviews-shared.test.js`, 5 tests — the exact query shape (verified against a fake chainable Supabase client, not a real network call), pass-through of both success and error results, a source-level check that neither file inlines the query anymore, and that both pages load the shared script before their own.
- **Severity:** Resolved (was Low/Medium risk).
- **Confidence:** High.
- **Recommended phase:** Phase 5 — **done**.

---

### BUG-11 — Duplicated ballot-manager logic (three copies) — **RESOLVED (Phase 4, 2026-08-17)**
- **Status: Resolved automatically by BUG-07's fix**, exactly as this entry originally predicted — the dead copy in `js/admin.js` no longer exists. `js/admin-menu.js`'s live ballot manager is unaffected.
- **Severity:** Resolved (was Low).
- **Confidence:** High.
- **Recommended phase:** Done (Phase 4).

---

### BUG-12 — Dead, unit-conversion-free cost function in `admin-sales.js`
- **Affected pages:** None currently (unused code), but a latent trap
- **Files/functions:** `js/admin-sales.js` `calculateSaleCost()`
- **Current behavior:** Fully implemented, never called. Computes ingredient cost as `purchase_price / purchase_size` with no unit conversion — would be wrong the moment purchase unit and recipe unit differ.
- **Expected behavior:** Removed, or if a "live recalculation" feature is wanted, rebuilt on the shared costing/conversion logic recommended elsewhere in this audit.
- **Status: Resolved (Phase 2, 2026-08-17).** Removed entirely, along with the four data fetches (`recipes`, `recipe_ingredients`, `packaging_profile_items`, `packaging_profiles`) that existed only to feed it — those queries ran on every Sales page load for a function nothing called. A correct, shared, tested implementation (`js/sale-calculations.js`) already exists if a live recalculation feature is ever wanted on this page.
- **Severity:** Low today; would have been a Critical-severity bug if ever wired up as-is.
- **Confidence:** High.
- **Recommended phase:** Phase 0/1 cleanup — **done (Phase 2)**.

---

### BUG-13 — Debug `console.log` statements left in production code
- **Affected pages:** Sales
- **Files/functions:** `js/admin-sales.js` (two call sites)
- **Current behavior:** Noisy console output on a real, customer-data-adjacent admin page — one dumped every sale's customer/revenue/date on every dashboard load, the other logged the full profit-breakdown input on every re-render.
- **Status: Resolved (Phase 2, 2026-08-17).** Both `console.log` statements removed.
- **Severity:** Low.
- **Confidence:** High.
- **Recommended phase:** Phase 1 (trivial, do alongside any other edit to this file) — **done (Phase 2)**.

---

### BUG-14 — No safeguard when deleting an ingredient or recipe still in use (now precisely characterized) — **RESOLVED (Phase 2, 2026-08-17)**
- **Affected pages:** Inventory
- **Files/functions:** `js/admin-inventory.js` `deleteIngredient()`, `deleteRecipe()`
- **Current behavior:** No client-side check or warning before deleting. **Resolved 2026-08-17** — the actual database behavior is now confirmed and is a mix of safe and unsafe:
  - Deleting an **ingredient** still referenced by `recipe_ingredients` or `packaging_profile_items` is **safely blocked** by the database (`NO ACTION`/`RESTRICT` foreign keys) — the delete fails and the admin sees a raw Postgres error via `alert()`. Data-safe, just an unfriendly error message.
  - Deleting a **recipe** still referenced by `menu_items.recipe_id` is likewise **safely blocked**.
  - Deleting a **recipe that is used as a component in another recipe** (`recipe_components.component_recipe_id`) was **not blocked — it cascaded silently** (`ON DELETE CASCADE`) — see BUG-20, now fixed at the database level.
- **Expected behavior:** A friendlier pre-delete warning ("used in N recipes/products") for the two blocked cases, and the same or a hard block for the unblocked (component-recipe) case.
- **Status: Fixed and verified.** Both `deleteIngredient()` and `deleteRecipe()` now query real usage counts (`recipe_ingredients`/`packaging_profile_items` for ingredients; `menu_items`/`recipe_components` for recipes) before attempting the delete, and show a specific, friendly message ("used in N recipe(s)...") instead of relying on the database's raw error text. The database itself remains the authoritative safety net for all three cases (two pre-existing RESTRICT/NO ACTION foreign keys, plus BUG-20's newly-fixed one) — this is a friendlier front end to that same guarantee, not a replacement for it.
- **Severity:** Medium (unfriendly-but-safe for ingredients/recipes; see BUG-20 for the one genuinely unsafe case, now also fixed).
- **Confidence:** High (directly verified via `pg_constraint`).
- **Recommended phase:** Phase 2 — **done**.

---

### BUG-15 — Discounts, taxes, refunds, and waste — confirmed out of scope by the owner
- **Affected pages:** Orders, Sales, Analytics (anywhere revenue/COGS is shown)
- **Current behavior:** No field for tax, discount, fee, refund, or waste exists anywhere in `orders`, `order_items`, `sales`, or `sale_items` — confirmed both in the application code and directly against the live schema (no such columns exist on any table).
- **Owner confirmed (2026-08-17):** There are no discounts, no taxes, no refunds, and no waste in this business today. **Resolved — not in scope for this repair project.** No code or schema change is needed for this item.
- **Severity:** N/A — closed.
- **Confidence:** High.
- **Recommended phase:** None — closed, revisit only if the business practice changes in the future.

---

## Summary table (updated 2026-08-17; BUG-16/17/18 resolved same day, BUG-01 resolved as Phase 1A/1B, BUG-02/03/04/05/12/13/14/20/22 resolved as Phase 2, BUG-06/19/23 resolved as Phase 3, BUG-07/08/09/11 resolved as Phase 4, BUG-10 resolved as Phase 5)

| ID | Summary | Severity | Confidence | Phase |
|---|---|---|---|---|
| BUG-16 | RLS disabled on `orders`/`order_items` — customer data publicly exposed | **RESOLVED** (was Critical) | High (fixed & verified live) | Done |
| BUG-17 | `complete_production`/`end_current_ballot` callable by anyone, unauthenticated | **RESOLVED** (was High) | High (fixed & verified live) | Done |
| BUG-18 | Internal cost data (`recipe_costs`/`packaging_profile_costs`) publicly queryable | **RESOLVED** (was High) | High (fixed & verified live) | Done |
| BUG-01 | Builder sales: revenue right, profit wrong — confirmed on 18/34 sales, €335 correction verified | **RESOLVED** (code fix + historical backfill both deployed) | High (verified live + 11/11 tests) | 1A done / 1B done |
| BUG-02 | Editing an order with a builder box deletes it | **RESOLVED** (was High) | High (13/13 tests) | 2 — done |
| BUG-22 | Completed orders can still be edited; live order data can drift from the frozen sale record | **RESOLVED** (was Medium) | High (4/4 tests) | 2 — done |
| BUG-04 | Inventory tab recipe cost ignores sub-recipes — confirmed confined to that tab, 29–47% understated | **RESOLVED** (was Medium) | High (verified live + 7/7 tests) | 2 — done |
| BUG-20 | Deleting a component recipe silently cascades, dropping it from recipes that use it | **RESOLVED** (was Medium) | High (verified live) | 2 — done |
| BUG-14 | Ingredient/recipe delete: safe-but-unfriendly for 2 of 3 cases (see BUG-20 for the unsafe one) | **RESOLVED** (was Medium) | High (verified) | 2 — done |
| BUG-03 | Packaging cost ID-cast inconsistency — confirmed **not** a live bug | **RESOLVED** (was Low) | High (verified) | 2 — done |
| BUG-05 | Inventory unit conversion missing volume/count — confirmed zero live impact today | **RESOLVED** (was Low) | High (verified) | 2 — done |
| BUG-12 | Dead, unsafe cost function in Sales | **RESOLVED** (was Low, latent) | High | 2 — done |
| BUG-13 | Debug console.log left in Sales | **RESOLVED** (was Low) | High | 2 — done |
| BUG-19 | No currency/exchange-rate columns exist | **RESOLVED** (was Medium) | High (verified live) | 3 — done |
| BUG-06 | Currency needs 3 different treatments (customer EUR, inventory/costs/Sales/Analytics USD) | **RESOLVED** (was Medium) | High (verified live + 23/23 tests) | 3 — done |
| BUG-21 | Minor Supabase hardening/performance items (advisors) | **RESOLVED** (all SQL/code-fixable items); leaked-password protection = **Accepted plan limitation** (Free plan; needs Supabase Pro+) | High (verified live) | Done (2026-08-18) |
| BUG-23 | Production mixed EUR revenue with USD cost in its profit/margin figures, all labeled € | **RESOLVED** (was Medium) | High (verified + 7/7 tests) | 3 — done |
| BUG-07 | `admin.js` dead and broken | **RESOLVED** (was Low) | High (verified, file deleted) | 4 — done |
| BUG-08 | Dead markup in `admin.html` | **RESOLVED** (was Low) | High (verified) | 4 — done |
| BUG-09 | Missing `production.css` | **RESOLVED** (was Low) | High (verified) | 4 — done |
| BUG-10 | Duplicated pending-reviews logic | **RESOLVED** (was Low/Medium) | High (verified + 5/5 tests) | 5 — done |
| BUG-11 | Duplicated ballot-manager logic | **RESOLVED** (was Low) | High | resolved w/ BUG-07 |
| BUG-15 | No discount/tax/refund/waste support | **Closed — confirmed out of scope by owner** | High | none |
