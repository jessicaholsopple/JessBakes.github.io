/* ==========================================
   SAFE ORDER-ITEM SNAPSHOT FOR REVIEWS

   The one canonical place that turns raw order_items rows into the
   public-safe shape shown on the review form, in the review-request
   email, and persisted onto reviews.order_items_snapshot at
   submission time. Reads ONLY item_name, quantity, builder_details,
   and promotion_redemption_id -- never price_at_purchase/line_total,
   never menu_item_id (so a since-removed/renamed menu item is
   unaffected: item_name is already a frozen snapshot column on
   order_items itself, written once at order time and never re-joined
   to the live menu_items table for display).

   Pure, dependency-free ESM -- shared by get-review-order,
   submit-review, and processOutbox.ts's review_request render path,
   so the three can never disagree about what counts as "safe".
   ========================================== */

function toNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

/** Mix & Match flavor breakdown, if this line has one -- the exact
 * `builder_details.selections` shape written by submit_order/
 * js/mix-and-match.js ([{id, name, quantity}, ...]), reduced to only
 * name/quantity. Returns null for a non-builder line (no flavor
 * breakdown to show), never an empty array. */
function flavorBreakdown(builderDetails) {
    if (!builderDetails || !Array.isArray(builderDetails.selections)) {
        return null;
    }

    const selections = builderDetails.selections
        .map(s => ({
            name: String((s && s.name) || ""),
            quantity: toNumber(s && s.quantity, 0)
        }))
        .filter(s => s.name && s.quantity > 0);

    return selections.length ? selections : null;
}

/** orderItemsRows: whatever came back from
 * `.from("order_items").select("item_name, quantity, builder_details, promotion_redemption_id")`.
 * Returns the safe, display-ready array -- never prices, never
 * internal IDs. */
export function buildSafeOrderItemsSummary(orderItemsRows) {
    return (orderItemsRows || []).map(item => ({
        name: String((item && item.item_name) || ""),
        quantity: toNumber(item && item.quantity, 0),
        isPromo: Boolean(item && item.promotion_redemption_id),
        flavors: flavorBreakdown(item && item.builder_details)
    }));
}
