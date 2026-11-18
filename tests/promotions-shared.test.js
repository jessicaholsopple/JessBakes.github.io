"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const PromotionsShared = require("../js/promotions-shared.js");

/* ==========================================
   FIXTURES
   ========================================== */

const BROWN_BUTTER_ID = "menu-brown-butter";
const STRAWBERRY_ID = "menu-strawberry";
const BREAD_ID = "menu-sourdough";

const FREE_COOKIE_PROMO = {
    id: "promo-free-cookie",
    customer_title: "Free Cookie with Your Order!",
    cart_message: "You've earned a free cookie! Choose your flavor below.",
    promotion_type: "free_item",
    qualifying_subtotal_min: 10,
    threshold_operator: "gt",
    priority: 100,
    free_item_quantity: 1,
    rewardItems: [
        { menu_item_id: BROWN_BUTTER_ID, sort_order: 0 },
        { menu_item_id: STRAWBERRY_ID, sort_order: 1 }
    ]
};

const LIVE_MENU_ITEMS = {
    [BROWN_BUTTER_ID]: { id: BROWN_BUTTER_ID, name: "Brown Butter Sea Salt Chocolate Chip", product_type: "standard", available: true },
    [STRAWBERRY_ID]: { id: STRAWBERRY_ID, name: "Strawberry Shortcake", product_type: "standard", available: true },
    [BREAD_ID]: { id: BREAD_ID, name: "Classic Sourdough", product_type: "standard", available: true }
};

function cartLine(id, price, quantity = 1, type = "standard") {
    return { type, id, name: LIVE_MENU_ITEMS[id] ? LIVE_MENU_ITEMS[id].name : id, price, quantity };
}

/* ==========================================
   computeQualifyingSubtotal
   ========================================== */

test("computeQualifyingSubtotal sums only non-promo paid lines", () => {
    const cart = [
        cartLine(BREAD_ID, 8, 1),
        { type: "promo", id: BROWN_BUTTER_ID, name: "Brown Butter", price: 0, quantity: 1, promotion_id: FREE_COOKIE_PROMO.id }
    ];
    assert.equal(PromotionsShared.computeQualifyingSubtotal(cart), 8);
});

test("computeQualifyingSubtotal never counts a promo line toward its own threshold even if priced nonzero by mistake", () => {
    const cart = [{ type: "promo", id: BROWN_BUTTER_ID, name: "x", price: 3.5, quantity: 1 }];
    assert.equal(PromotionsShared.computeQualifyingSubtotal(cart), 0);
});

test("computeQualifyingSubtotal respects eligibleIds scoping when provided", () => {
    const cart = [cartLine(BREAD_ID, 8, 1), cartLine(BROWN_BUTTER_ID, 3, 1)];
    const subtotal = PromotionsShared.computeQualifyingSubtotal(cart, { eligibleIds: new Set([BREAD_ID]) });
    assert.equal(subtotal, 8);
});

test("computeQualifyingSubtotal respects excludedIds scoping when provided", () => {
    const cart = [cartLine(BREAD_ID, 8, 1), cartLine(BROWN_BUTTER_ID, 3, 1)];
    const subtotal = PromotionsShared.computeQualifyingSubtotal(cart, { excludedIds: new Set([BROWN_BUTTER_ID]) });
    assert.equal(subtotal, 8);
});

test("computeQualifyingSubtotal: empty scoping sets mean everything counts (the launch promo's default)", () => {
    const cart = [cartLine(BREAD_ID, 8, 1), cartLine(BROWN_BUTTER_ID, 3, 1)];
    assert.equal(PromotionsShared.computeQualifyingSubtotal(cart, {}), 11);
});

/* ==========================================
   findApplicablePromotions / meetsThreshold
   ========================================== */

test("findApplicablePromotions: cart subtotal exactly at threshold does NOT qualify for 'gt'", () => {
    const cart = [cartLine(BREAD_ID, 10, 1)];
    const applicable = PromotionsShared.findApplicablePromotions([FREE_COOKIE_PROMO], cart);
    assert.equal(applicable.length, 0);
});

test("findApplicablePromotions: cart subtotal below threshold does not qualify", () => {
    const cart = [cartLine(BREAD_ID, 9.99, 1)];
    const applicable = PromotionsShared.findApplicablePromotions([FREE_COOKIE_PROMO], cart);
    assert.equal(applicable.length, 0);
});

test("findApplicablePromotions: cart subtotal above threshold qualifies", () => {
    const cart = [cartLine(BREAD_ID, 10.01, 1)];
    const applicable = PromotionsShared.findApplicablePromotions([FREE_COOKIE_PROMO], cart);
    assert.equal(applicable.length, 1);
    assert.equal(applicable[0].id, FREE_COOKIE_PROMO.id);
});

test("findApplicablePromotions: 'gte' operator qualifies exactly at threshold", () => {
    const gtePromo = { ...FREE_COOKIE_PROMO, threshold_operator: "gte" };
    const cart = [cartLine(BREAD_ID, 10, 1)];
    const applicable = PromotionsShared.findApplicablePromotions([gtePromo], cart);
    assert.equal(applicable.length, 1);
});

test("findApplicablePromotions sorts by priority ascending", () => {
    const low = { ...FREE_COOKIE_PROMO, id: "low", priority: 50, qualifying_subtotal_min: 0 };
    const high = { ...FREE_COOKIE_PROMO, id: "high", priority: 200, qualifying_subtotal_min: 0 };
    const cart = [cartLine(BREAD_ID, 20, 1)];
    const applicable = PromotionsShared.findApplicablePromotions([high, low], cart);
    assert.deepEqual(applicable.map(p => p.id), ["low", "high"]);
});

/* ==========================================
   getRewardChoices
   ========================================== */

test("getRewardChoices flags a sold-out flavor as unavailable rather than omitting it", () => {
    const menuWithSoldOut = {
        ...LIVE_MENU_ITEMS,
        [STRAWBERRY_ID]: { ...LIVE_MENU_ITEMS[STRAWBERRY_ID], stock_mode: "limited", available_count: 0 }
    };
    const choices = PromotionsShared.getRewardChoices(FREE_COOKIE_PROMO, menuWithSoldOut);
    assert.equal(choices.length, 2);
    const strawberry = choices.find(c => c.id === STRAWBERRY_ID);
    assert.equal(strawberry.available, false);
    const brownButter = choices.find(c => c.id === BROWN_BUTTER_ID);
    assert.equal(brownButter.available, true);
});

test("getRewardChoices: both flavors unavailable is representable (neither flagged available)", () => {
    const menuAllSoldOut = {
        [BROWN_BUTTER_ID]: { ...LIVE_MENU_ITEMS[BROWN_BUTTER_ID], stock_mode: "limited", available_count: 0 },
        [STRAWBERRY_ID]: { ...LIVE_MENU_ITEMS[STRAWBERRY_ID], stock_mode: "limited", available_count: 0 }
    };
    const choices = PromotionsShared.getRewardChoices(FREE_COOKIE_PROMO, menuAllSoldOut);
    assert.ok(choices.every(c => c.available === false));
});

test("getRewardChoices works with a Map, not just a plain object", () => {
    const map = new Map(Object.entries(LIVE_MENU_ITEMS));
    const choices = PromotionsShared.getRewardChoices(FREE_COOKIE_PROMO, map);
    assert.equal(choices.length, 2);
    assert.ok(choices.every(c => c.available));
});

/* ==========================================
   buildPromoLineCandidate
   ========================================== */

test("buildPromoLineCandidate: Brown Butter selection succeeds", () => {
    const result = PromotionsShared.buildPromoLineCandidate(FREE_COOKIE_PROMO, BROWN_BUTTER_ID, LIVE_MENU_ITEMS);
    assert.equal(result.ok, true);
    assert.deepEqual(result.line, {
        type: "promo", id: BROWN_BUTTER_ID, name: "Brown Butter Sea Salt Chocolate Chip",
        price: 0, quantity: 1, promotion_id: FREE_COOKIE_PROMO.id,
        promotion_name: FREE_COOKIE_PROMO.customer_title, locked: true
    });
});

test("buildPromoLineCandidate: Strawberry Shortcake selection succeeds", () => {
    const result = PromotionsShared.buildPromoLineCandidate(FREE_COOKIE_PROMO, STRAWBERRY_ID, LIVE_MENU_ITEMS);
    assert.equal(result.ok, true);
    assert.equal(result.line.id, STRAWBERRY_ID);
    assert.equal(result.line.price, 0);
});

test("buildPromoLineCandidate rejects a menu item not in the promotion's reward list", () => {
    const result = PromotionsShared.buildPromoLineCandidate(FREE_COOKIE_PROMO, BREAD_ID, LIVE_MENU_ITEMS);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "not_eligible");
});

test("buildPromoLineCandidate rejects an unavailable (sold out) reward item", () => {
    const menuWithSoldOut = {
        ...LIVE_MENU_ITEMS,
        [BROWN_BUTTER_ID]: { ...LIVE_MENU_ITEMS[BROWN_BUTTER_ID], stock_mode: "limited", available_count: 0 }
    };
    const result = PromotionsShared.buildPromoLineCandidate(FREE_COOKIE_PROMO, BROWN_BUTTER_ID, menuWithSoldOut);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unavailable");
});

test("buildPromoLineCandidate rejects a non-free_item promotion type", () => {
    const pctPromo = { ...FREE_COOKIE_PROMO, promotion_type: "percentage_discount" };
    const result = PromotionsShared.buildPromoLineCandidate(pctPromo, BROWN_BUTTER_ID, LIVE_MENU_ITEMS);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid_promotion");
});

/* ==========================================
   isPromoLineStillValid (revalidation)
   ========================================== */

test("isPromoLineStillValid: a valid promo line with a qualifying cart stays valid", () => {
    const cart = [cartLine(BREAD_ID, 15, 1), { type: "promo", id: BROWN_BUTTER_ID, name: "x", price: 0, quantity: 1, promotion_id: FREE_COOKIE_PROMO.id }];
    const result = PromotionsShared.isPromoLineStillValid(cart[1], cart, [FREE_COOKIE_PROMO], LIVE_MENU_ITEMS);
    assert.equal(result.ok, true);
});

test("isPromoLineStillValid: invalid once the cart drops to/below the threshold", () => {
    const cart = [cartLine(BREAD_ID, 5, 1), { type: "promo", id: BROWN_BUTTER_ID, name: "x", price: 0, quantity: 1, promotion_id: FREE_COOKIE_PROMO.id }];
    const result = PromotionsShared.isPromoLineStillValid(cart[1], cart, [FREE_COOKIE_PROMO], LIVE_MENU_ITEMS);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "no_longer_qualifies");
});

test("isPromoLineStillValid: invalid once the promotion is no longer in the active list (paused/expired)", () => {
    const cart = [cartLine(BREAD_ID, 15, 1), { type: "promo", id: BROWN_BUTTER_ID, name: "x", price: 0, quantity: 1, promotion_id: FREE_COOKIE_PROMO.id }];
    const result = PromotionsShared.isPromoLineStillValid(cart[1], cart, [], LIVE_MENU_ITEMS);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "promotion_no_longer_active");
});

test("isPromoLineStillValid: invalid once the chosen reward item sells out", () => {
    const cart = [cartLine(BREAD_ID, 15, 1), { type: "promo", id: BROWN_BUTTER_ID, name: "x", price: 0, quantity: 1, promotion_id: FREE_COOKIE_PROMO.id }];
    const menuWithSoldOut = {
        ...LIVE_MENU_ITEMS,
        [BROWN_BUTTER_ID]: { ...LIVE_MENU_ITEMS[BROWN_BUTTER_ID], stock_mode: "limited", available_count: 0 }
    };
    const result = PromotionsShared.isPromoLineStillValid(cart[1], cart, [FREE_COOKIE_PROMO], menuWithSoldOut);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unavailable");
});

test("isPromoLineStillValid rejects a non-promo line defensively", () => {
    const result = PromotionsShared.isPromoLineStillValid(cartLine(BREAD_ID, 10, 1), [], [FREE_COOKIE_PROMO], LIVE_MENU_ITEMS);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "not_a_promo_line");
});

/* ==========================================
   Mix & Match / quantity isolation
   ========================================== */

test("a promo line never contributes to the subtotal even when summed via computeQualifyingSubtotal alongside a builder line", () => {
    const cart = [
        cartLine(BREAD_ID, 8, 1),
        { type: "builder", id: "builder-1", name: "6 Mix & Match Cookies", price: 15, quantity: 1, builder_group: "cookie", selections: [{ id: BROWN_BUTTER_ID, name: "Brown Butter", quantity: 6 }] },
        { type: "promo", id: STRAWBERRY_ID, name: "Strawberry", price: 0, quantity: 1, promotion_id: FREE_COOKIE_PROMO.id }
    ];
    // Builder lines count by their own box price (15), standard bread (8) -- promo contributes 0.
    assert.equal(PromotionsShared.computeQualifyingSubtotal(cart), 23);
});
