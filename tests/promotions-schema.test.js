"use strict";

/* ==========================================
   Structural/regression assertions against the actual applied SQL in
   supabase/migrations/20261118100000_promotions_schema.sql -- no
   local Postgres test harness exists in this repo (see every other
   *-migrations.test.js file, e.g. tests/submit-order-custom-fix.test.js,
   for the same convention). These confirm the schema's shape, safety
   constraints, and RLS posture are present in the actual SQL text,
   not a reimplementation of it.
   ========================================== */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const sql = fs.readFileSync(
    path.join(ROOT, "supabase/migrations/20261118100000_promotions_schema.sql"),
    "utf8"
);

test("1. promotions table exists with the six admin_status values", () => {
    assert.match(sql, /create table if not exists public\.promotions/);
    assert.match(sql, /admin_status text not null default 'draft'\s*\n\s*check \(admin_status in \('draft', 'enabled', 'paused', 'archived'\)\)/);
});

test("2. promotion_type is constrained to the three supported types", () => {
    assert.match(sql, /check \(promotion_type in \('free_item', 'percentage_discount', 'fixed_discount'\)\)/);
});

test("3. threshold_operator supports both strictly-greater-than and greater-or-equal", () => {
    assert.match(sql, /check \(threshold_operator in \('gt', 'gte'\)\)/);
});

test("4. a free_item promotion is constrained to require a positive reward quantity", () => {
    assert.match(sql, /promotions_free_item_requires_quantity\s*\n\s*check \(promotion_type <> 'free_item' or \(free_item_quantity is not null and free_item_quantity > 0\)\)/);
});

test("5. start_at must come before end_at when both are set", () => {
    assert.match(sql, /promotions_schedule_order\s*\n\s*check \(start_at is null or end_at is null or start_at < end_at\)/);
});

test("6. redemption_count is a non-negative concurrency-safe counter column, not computed client-side", () => {
    assert.match(sql, /redemption_count integer not null default 0\s*\n\s*check \(redemption_count >= 0\)/);
});

test("7. promotion_reward_items references the REAL menu_items table, not a synthetic id -- the shared-stock requirement", () => {
    assert.match(sql, /create table if not exists public\.promotion_reward_items/);
    assert.match(sql, /menu_item_id uuid not null references public\.menu_items\(id\)/);
});

test("8. promotion_redemptions is an immutable snapshot keyed unique per order+promotion (idempotency guard)", () => {
    assert.match(sql, /create table if not exists public\.promotion_redemptions/);
    assert.match(sql, /unique \(order_id, promotion_id\)/);
});

test("9. promotion_redemptions has RLS enabled with NO write policy for anyone -- security-definer-function-only, matching order_item_reservations", () => {
    const idx = sql.indexOf("create table if not exists public.promotion_redemptions");
    const section = sql.slice(idx, sql.indexOf("order_items gets one new nullable column"));
    assert.match(section, /alter table public\.promotion_redemptions enable row level security/);
    assert.match(section, /revoke all on public\.promotion_redemptions from anon/);
    assert.match(section, /revoke all on public\.promotion_redemptions from authenticated/);
    assert.doesNotMatch(section, /for insert|for update|for delete/);
});

test("10. order_items gets promotion_redemption_id as a nullable FK with ON DELETE SET NULL (never blocks deleting a redemption)", () => {
    assert.match(sql, /alter table public\.order_items\s*\n\s*add column if not exists promotion_redemption_id uuid references public\.promotion_redemptions\(id\) on delete set null/);
});

test("11. promotion_display_status derives all six display statuses from admin_status + schedule, in exactly one place", () => {
    assert.match(sql, /create or replace function public\.promotion_display_status/);
    const idx = sql.indexOf("create or replace function public.promotion_display_status");
    const fnBody = sql.slice(idx, idx + 1200);
    ["archived", "paused", "draft", "expired", "active", "scheduled"].forEach(status => {
        assert.match(fnBody, new RegExp(`'${status}'`));
    });
});

test("12. public_active_promotions is filtered to enabled + automatic + within schedule -- the only anon-readable promotion surface", () => {
    assert.match(sql, /create or replace view public\.public_active_promotions as/);
    const idx = sql.indexOf("create or replace view public.public_active_promotions");
    const endIdx = sql.indexOf("grant select on public.public_active_promotions", idx);
    const viewSql = sql.slice(idx, endIdx);
    assert.match(viewSql, /admin_status = 'enabled'/);
    assert.match(viewSql, /application_mode = 'automatic'/);
    assert.match(viewSql, /start_at is null or p\.start_at <= now\(\)/);
    assert.match(viewSql, /end_at is null or p\.end_at >= now\(\)/);
    assert.doesNotMatch(viewSql, /internal_notes|redemption_count|created_by/);
});

test("13. the public reward-items view only exposes rewards for promotions public_active_promotions itself returns (no draft-promotion leak)", () => {
    assert.match(sql, /create or replace view public\.public_active_promotion_reward_items as/);
    const idx = sql.indexOf("create or replace view public.public_active_promotion_reward_items");
    const viewSql = sql.slice(idx, idx + 400);
    assert.match(viewSql, /join public\.public_active_promotions pap on pap\.id = pri\.promotion_id/);
});

test("14. validate_promotion_activation fires exactly on the transition INTO 'enabled' (insert or update), the server-side activation backstop", () => {
    assert.match(sql, /before insert or update on public\.promotions\s*\n\s*for each row execute function public\.validate_promotion_activation\(\)/);
    const idx = sql.indexOf("create or replace function public.validate_promotion_activation");
    const fnBody = sql.slice(idx, idx + 2000);
    assert.match(fnBody, /new\.admin_status = 'enabled' and \(old\.admin_status is distinct from 'enabled'\)/);
    assert.match(fnBody, /no available reward items selected/);
});

test("15. duplicate_promotion resets promo_code/schedule/redemption_count and forces the copy back to draft", () => {
    assert.match(sql, /create or replace function public\.duplicate_promotion/);
    const idx = sql.indexOf("create or replace function public.duplicate_promotion");
    const fnBody = sql.slice(idx, idx + 2000);
    assert.match(fnBody, /'draft', null, null, application_mode, null,/);
});

test("16. promotions table itself has NO anon policy -- public access is exclusively through the views", () => {
    const idx = sql.indexOf("create table if not exists public.promotions");
    const endIdx = sql.indexOf("create table if not exists public.promotion_reward_items");
    const section = sql.slice(idx, endIdx);
    assert.match(section, /revoke all on public\.promotions from anon/);
    assert.doesNotMatch(section, /to anon/);
});
