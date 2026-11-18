/* ==========================================
   PROMOTIONS (shared, pure)
   ==========================================

   Single source of truth for "does this cart qualify for a
   promotion, and what reward choices does it offer right now" --
   used by js/cart.js (the real customer-facing behavior), js/menu.js
   (the public promo banner), and js/admin-promotions.js (the admin
   preview panel, so a preview can never drift from real behavior
   since both call the exact same functions).

   This module NEVER decides whether an order is actually allowed to
   claim a promotion -- that is submit_order()'s job, re-validated
   fully server-side from scratch. Everything here is advisory/UX
   only: showing the right banner, the right reward choices, and
   catching an out-of-date cart before the customer even tries to
   check out. See supabase/migrations/<ts>_submit_order_promotions_aware.sql
   for the authoritative, non-bypassable version of these same rules.

   Pure, DOM/Supabase-free -- every function takes plain data in and
   returns plain data out, so it runs unmodified in the browser (as a
   normal <script> tag, exposing `window.PromotionsShared`) or under
   Node (via `require("./promotions-shared.js")`), matching
   js/order-editor.js and js/mix-and-match.js.
   ========================================== */

(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.PromotionsShared = factory();
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    function toNumber(value, fallback) {
        const n = Number(value);
        return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
    }

    /** Mirrors MixAndMatch.hasAvailableStock (js/mix-and-match.js) on
     *  purpose rather than importing it: both are tiny, independently
     *  testable pure utilities, and a promo reward item is checked
     *  against the exact same made_to_order/limited stock convention
     *  every other sellable item uses -- no row = made_to_order,
     *  'limited' + available_count > 0 = in stock. */
    function hasAvailableStock(menuItem) {
        if (!menuItem) return false;
        if (menuItem.stock_mode !== "limited") return true;
        return toNumber(menuItem.available_count, 0) > 0;
    }

    function isRewardMenuItemAvailable(menuItem) {
        return Boolean(
            menuItem &&
            menuItem.product_type === "standard" &&
            menuItem.available === true &&
            hasAvailableStock(menuItem)
        );
    }

    /** Sums only non-promo paid cart lines toward a promotion's
     *  qualifying subtotal -- a promo line (type:"promo") never
     *  counts toward its own, or any other, threshold. `eligibleIds`/
     *  `excludedIds` are optional Sets of menu_item_id; when both are
     *  empty/omitted every paid line counts (the documented default,
     *  and exactly what the free-cookie launch promo uses -- whole
     *  order subtotal, no scoping). */
    function computeQualifyingSubtotal(cartItems, options) {
        const opts = options || {};
        const eligibleIds = opts.eligibleIds;
        const excludedIds = opts.excludedIds;

        return (cartItems || []).reduce((sum, item) => {
            if (!item || item.type === "promo") return sum;
            if (excludedIds && excludedIds.size && excludedIds.has(item.id)) return sum;
            if (eligibleIds && eligibleIds.size && !eligibleIds.has(item.id)) return sum;
            return sum + toNumber(item.price, 0) * toNumber(item.quantity, 0);
        }, 0);
    }

    function meetsThreshold(subtotal, promotion) {
        const min = toNumber(promotion && promotion.qualifying_subtotal_min, 0);
        if (promotion && promotion.threshold_operator === "gte") {
            return subtotal >= min;
        }
        return subtotal > min;
    }

    /** Filters already-fetched active promotions (the "is it active
     *  right now" window check is already baked into which rows the
     *  public_active_promotions view returned -- this function only
     *  does cart-shape matching) down to those the cart currently
     *  qualifies for, sorted by priority ascending (lower number =
     *  checked/offered first). */
    function findApplicablePromotions(activePromotions, cartItems) {
        const subtotal = computeQualifyingSubtotal(cartItems);
        return (activePromotions || [])
            .filter((promo) => meetsThreshold(subtotal, promo))
            .slice()
            .sort((a, b) => toNumber(a.priority, 100) - toNumber(b.priority, 100));
    }

    /** All reward choices for a free_item promotion, each flagged
     *  with live availability -- used to render "this flavor is sold
     *  out" rather than silently hiding it, per spec. `rewardItems`
     *  is the promotion's joined reward-item list
     *  ({menu_item_id, sort_order}[]); `liveMenuItemsById` is a plain
     *  object/Map of live menu_items (with stock fields merged on,
     *  the same shape js/menu.js already builds via
     *  MixAndMatch.mergeStockOntoMenuItems). */
    function getRewardChoices(promotion, liveMenuItemsById) {
        const rewardItems = (promotion && promotion.rewardItems) || [];
        const byId = liveMenuItemsById instanceof Map
            ? (id) => liveMenuItemsById.get(id)
            : (id) => (liveMenuItemsById || {})[id];

        return rewardItems
            .slice()
            .sort((a, b) => toNumber(a.sort_order, 0) - toNumber(b.sort_order, 0))
            .map((ri) => {
                const menuItem = byId(ri.menu_item_id);
                return {
                    id: ri.menu_item_id,
                    name: menuItem ? menuItem.name : null,
                    available: isRewardMenuItemAvailable(menuItem)
                };
            });
    }

    /** Validates a customer's chosen reward flavor and builds the
     *  cart "promo" line for it. Returns {ok:true, line} or
     *  {ok:false, reason}. Never trusts anything but the live menu
     *  data passed in -- this is advisory only, submit_order() is the
     *  real gate. */
    function buildPromoLineCandidate(promotion, chosenMenuItemId, liveMenuItemsById) {
        if (!promotion || promotion.promotion_type !== "free_item") {
            return { ok: false, reason: "invalid_promotion" };
        }

        const rewardItems = promotion.rewardItems || [];
        const isEligibleReward = rewardItems.some((ri) => ri.menu_item_id === chosenMenuItemId);
        if (!isEligibleReward) {
            return { ok: false, reason: "not_eligible" };
        }

        const byId = liveMenuItemsById instanceof Map
            ? liveMenuItemsById.get(chosenMenuItemId)
            : (liveMenuItemsById || {})[chosenMenuItemId];

        if (!isRewardMenuItemAvailable(byId)) {
            return { ok: false, reason: "unavailable" };
        }

        return {
            ok: true,
            line: {
                type: "promo",
                id: chosenMenuItemId,
                name: byId.name,
                price: 0,
                quantity: 1,
                promotion_id: promotion.id,
                promotion_name: promotion.customer_title,
                locked: true
            }
        };
    }

    /** Re-checks an existing cart "promo" line against the current
     *  cart contents, the current list of active promotions, and
     *  current live menu/stock data. Called on every cart
     *  revalidation pass (tab resume, checkout open) so a stale promo
     *  line is caught the same way a stale standard/builder line
     *  already is. Returns {ok:true} or {ok:false, reason}. */
    function isPromoLineStillValid(promoLine, cartItems, activePromotions, liveMenuItemsById) {
        if (!promoLine || promoLine.type !== "promo") {
            return { ok: false, reason: "not_a_promo_line" };
        }

        const promotion = (activePromotions || []).find((p) => p.id === promoLine.promotion_id);
        if (!promotion) {
            return { ok: false, reason: "promotion_no_longer_active" };
        }

        const subtotal = computeQualifyingSubtotal(cartItems);
        if (!meetsThreshold(subtotal, promotion)) {
            return { ok: false, reason: "no_longer_qualifies" };
        }

        const candidate = buildPromoLineCandidate(promotion, promoLine.id, liveMenuItemsById);
        if (!candidate.ok) {
            return { ok: false, reason: candidate.reason };
        }

        return { ok: true };
    }

    return {
        computeQualifyingSubtotal,
        meetsThreshold,
        findApplicablePromotions,
        getRewardChoices,
        buildPromoLineCandidate,
        isPromoLineStillValid,
        isRewardMenuItemAvailable
    };
});
