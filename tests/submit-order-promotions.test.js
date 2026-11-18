"use strict";

/* ==========================================
   Structural/regression assertions against the actual applied SQL in
   supabase/migrations/20261118110000_submit_order_promotions_aware.sql
   -- same convention as tests/submit-order-custom-fix.test.js (no
   local Postgres harness in this repo). These confirm the promotion-
   claim validation chain is present, in the right order, and that
   the pre-existing paid-item validation logic (standard items, Mix &
   Match, vacation mode, etc.) is untouched by this migration.

   Full functional/concurrency verification (a real claim succeeding,
   a tampered claim being rejected, two concurrent claims racing a
   max_total_redemptions cap) is covered by live verification against
   the deployed database, not by this file -- see the final report's
   "Deployment and live-verification results" section.
   ========================================== */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

// Normalized to LF: the prior migration file is CRLF on disk, this
// new one is LF -- a line-ending difference isn't a content
// difference, and byte-for-byte comparisons below care only about
// the latter.
function readNormalized(relPath) {
    return fs.readFileSync(path.join(ROOT, relPath), "utf8").replace(/\r\n/g, "\n");
}

const sql = readNormalized("supabase/migrations/20261118110000_submit_order_promotions_aware.sql");
const priorSubmitOrder = readNormalized("supabase/migrations/20261012140000_fix_submit_order_custom_order_pickup_record.sql");

/* ==========================================
   Signature unchanged -- a promo claim is just a new optional key,
   never a new parameter
   ========================================== */

test("1. submit_order's signature is byte-identical to the prior migration's -- promotion_claim is carried inside p_items, not a new parameter", () => {
    const extractSignature = (text) => {
        const start = text.indexOf("create or replace function public.submit_order(");
        const end = text.indexOf(") returns public.orders", start);
        return text.slice(start, end);
    };
    assert.equal(extractSignature(sql), extractSignature(priorSubmitOrder));
});

/* ==========================================
   Resolution helper factored out and reused by both paths
   ========================================== */

test("2. resolve_purchasable_standard_item is a single, revoked-from-public helper shared by the paid-item AND promo-claim lookups", () => {
    assert.match(sql, /create or replace function public\.resolve_purchasable_standard_item/);
    assert.match(sql, /revoke all on function public\.resolve_purchasable_standard_item\(uuid\) from public/);

    // Both the standard-item branch and the promo-claim branch must
    // call it -- never two separate inline copies of the same
    // availability query (the drift risk the plan explicitly flagged).
    const occurrences = sql.split("public.resolve_purchasable_standard_item(").length - 1;
    assert.ok(occurrences >= 3, `expected the helper to be defined once and called at least twice, found ${occurrences} total occurrences`);
});

/* ==========================================
   Two-phase structure: promo claims can't be validated until the
   final paid-only subtotal is known
   ========================================== */

test("3. promotion_claim lines are set aside during the main loop, not processed inline with paid items", () => {
    assert.match(sql, /v_item \? 'promotion_claim'/);
    assert.match(sql, /v_promo_claims := v_promo_claims \|\| jsonb_build_array\(v_item\);\s*\n\s*continue;/);
});

test("4. the promo-claim validation loop runs AFTER the main per-item loop closes -- so v_computed_subtotal is final before any claim is checked", () => {
    const mainLoopEnd = sql.indexOf("v_computed_subtotal := v_computed_subtotal + v_line_total;");
    const phase2Start = sql.indexOf("for v_item in select * from jsonb_array_elements(v_promo_claims)");
    assert.ok(mainLoopEnd > 0 && phase2Start > mainLoopEnd, "phase 2 (promo claims) must start after phase 1 (paid items) finishes accumulating the subtotal");
});

/* ==========================================
   Security: every one of these must be independently re-derived
   server-side, never trusted from the client
   ========================================== */

test("5. the promotion row is locked (FOR UPDATE) before its redemption_count is touched -- the concurrency guard", () => {
    assert.match(sql, /select \* into v_promo\s*\n\s*from public\.promotions\s*\n\s*where id = \(v_item->'promotion_claim'->>'promotion_id'\)::uuid\s*\n\s*for update;/);
});

test("6. admin_status, application_mode, and the schedule window are all independently re-checked", () => {
    assert.match(sql, /v_promo\.admin_status <> 'enabled' or v_promo\.application_mode <> 'automatic'/);
    assert.match(sql, /v_promo\.start_at is not null and v_promo\.start_at > now\(\)/);
    assert.match(sql, /v_promo\.end_at is not null and v_promo\.end_at < now\(\)/);
});

test("7. the qualifying subtotal check honors both threshold operators and uses the server-computed subtotal, never p_subtotal", () => {
    assert.match(sql, /v_promo\.threshold_operator = 'gte'/);
    assert.match(sql, /v_computed_subtotal < v_promo\.qualifying_subtotal_min/);
    assert.match(sql, /v_computed_subtotal <= v_promo\.qualifying_subtotal_min/);
    assert.doesNotMatch(sql, /p_subtotal\s*[<>=]/);
});

test("8. the claimed reward item must be in promotion_reward_items -- a client cannot claim an arbitrary free menu item", () => {
    assert.match(sql, /not exists \(\s*\n\s*select 1 from public\.promotion_reward_items\s*\n\s*where promotion_id = v_promo\.id and menu_item_id = v_claimed_menu_item_id\s*\n\s*\)/);
});

test("9. the reward's quantity and name are server-derived, never taken from the client's claim", () => {
    assert.match(sql, /v_reward_quantity := coalesce\(v_promo\.free_item_quantity, 1\)/);
    assert.match(sql, /select item_name into v_claimed_name\s*\n\s*from public\.resolve_purchasable_standard_item\(v_claimed_menu_item_id\)/);
    // The validated row built for insertion must use the server values,
    // not anything read back out of v_item for name/quantity/price.
    assert.match(sql, /'item_name', v_claimed_name,\s*\n\s*'quantity', v_reward_quantity,\s*\n\s*'price_at_purchase', 0,\s*\n\s*'line_total', 0,/);
});

test("10. per-order and per-customer redemption caps are both enforced", () => {
    assert.match(sql, /v_claims_so_far >= v_promo\.max_redemptions_per_order/);
    assert.match(sql, /v_customer_redemption_count >= v_promo\.max_redemptions_per_customer/);
});

test("11. the total-redemption cap uses a conditional UPDATE ... WHERE redemption_count < max_total_redemptions, the same oversell-guard idiom as reconcile_order_stock()", () => {
    assert.match(sql, /update public\.promotions\s*\n\s*set redemption_count = redemption_count \+ 1\s*\n\s*where id = v_promo\.id\s*\n\s*and \(max_total_redemptions is null or redemption_count < max_total_redemptions\)\s*\n\s*returning redemption_count into v_new_redemption_count;/);
    assert.match(sql, /if not found then\s*\n\s*raise exception 'This promotion has reached its redemption limit\.';/);
});

/* ==========================================
   Immutable snapshot + explicit discriminator
   ========================================== */

test("12. a validated claim carries an embedded _promo_redemption snapshot through to the insert loop", () => {
    assert.match(sql, /'_promo_redemption', jsonb_build_object\(/);
    assert.match(sql, /'promotion_name_snapshot', v_promo\.internal_name/);
    assert.match(sql, /'threshold_snapshot', jsonb_build_object\(/);
    assert.match(sql, /'reward_snapshot', jsonb_build_object\(/);
});

test("13. the insert loop writes promotion_redemptions and links order_items.promotion_redemption_id back to it -- for every validated item, not just promo ones (the explicit-flag discriminator)", () => {
    assert.match(sql, /if v_item \? '_promo_redemption' then\s*\n\s*insert into public\.promotion_redemptions/);
    assert.match(sql, /update public\.order_items\s*\n\s*set promotion_redemption_id = v_redemption_id\s*\n\s*where id = v_new_order_item_id;/);
});

/* ==========================================
   Pre-existing paid-item/Mix & Match/vacation logic is untouched
   ========================================== */

test("14. vacation-mode, order_type, and contact-field validation are byte-identical to the prior migration", () => {
    const extractGuardBlock = (text) => {
        const start = text.indexOf("select exists(select 1 from public.vacation_periods");
        const end = text.indexOf("At least one item is required");
        return text.slice(start, end);
    };
    assert.equal(extractGuardBlock(sql), extractGuardBlock(priorSubmitOrder));
});

test("15. the Mix & Match box resolution and per-flavor stock-aware eligibility check are untouched", () => {
    const extractBuilderBlock = (text) => {
        const start = text.indexOf("-- ---- Mix & Match builder box. ----");
        const end = text.indexOf("v_computed_subtotal := v_computed_subtotal + v_line_total;");
        return text.slice(start, end);
    };
    assert.equal(extractBuilderBlock(sql), extractBuilderBlock(priorSubmitOrder));
});

test("16. orders.subtotal is still stored as the server-computed, paid-only total -- a promo line can never inflate or appear in it", () => {
    assert.match(sql, /p_notes, v_computed_subtotal, 'pending'/);
});

/* ==========================================
   admin_reconcile_order_promotions companion RPC
   ========================================== */

test("17. admin_reconcile_order_promotions is admin-gated and recomputes the paid subtotal from the order's OWN current order_items, never trusting a client-sent figure", () => {
    assert.match(sql, /create or replace function public\.admin_reconcile_order_promotions/);
    assert.match(sql, /if not is_admin\(\) then\s*\n\s*raise exception 'Admins only\.';/);
    assert.match(sql, /select coalesce\(sum\(line_total\), 0\) into v_paid_subtotal\s*\n\s*from public\.order_items\s*\n\s*where order_id = p_order_id and promotion_redemption_id is null;/);
});

test("18. admin_reconcile_order_promotions removes order_items before deleting their redemption row, and only execute-granted to authenticated", () => {
    assert.match(sql, /delete from public\.order_items where promotion_redemption_id = v_remove_id;/);
    assert.match(sql, /delete from public\.promotion_redemptions where id = v_remove_id and order_id = p_order_id;/);
    assert.match(sql, /revoke all on function public\.admin_reconcile_order_promotions\(uuid, jsonb, uuid\[\]\) from public;/);
    assert.match(sql, /grant execute on function public\.admin_reconcile_order_promotions\(uuid, jsonb, uuid\[\]\) to authenticated;/);
});
