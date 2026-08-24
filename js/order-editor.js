/* ==========================================
   ORDER EDITOR (shared, pure)
   ==========================================

   Single source of truth for the two order-editing defects fixed in
   Phase 2:

     - BUG-02: opening the manual order editor on an order containing a
       Mix & Match ("builder") box silently dropped it, because the editor
       only understood flat menu items keyed by menu_item_id, and every
       builder line has menu_item_id: null — so every builder line (and any
       other line whose linked menu item was later deleted) collided on the
       single key `null` and only the last one survived.
     - BUG-22: editing an order whose sale has already been completed and
       frozen could silently rewrite orders/order_items out from under that
       frozen sales/sale_items record, with no guard anywhere.

   Used by js/admin-orders.js (the manual order editor) and covered by
   tests/order-editor.test.js (Node's built-in test runner, no
   dependencies).

   This file has no dependency on the DOM or Supabase — every function here
   takes plain data in and returns plain data out, so it can run unmodified
   in the browser (as a normal <script> tag, exposing `window.OrderEditor`)
   or under Node (via `require("./order-editor.js")`).
   ========================================== */

(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.OrderEditor = factory();
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    function toNumber(value, fallback) {
        const n = Number(value);
        return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
    }

    /**
     * BUG-22: an order is safe to edit through the normal editor only while
     * it has not yet been completed — once completed, its sale/sale_items
     * record is frozen elsewhere in the schema, and editing orders/
     * order_items further would let the two silently diverge.
     */
    function isOrderEditable(order) {
        return Boolean(order) && order.status !== "completed";
    }

    /**
     * BUG-02 fix. Splits an order's real order_items rows into:
     *   - flatItemsById: a plain object keyed by menu_item_id, one entry
     *     per distinct flat menu item — safe, because a real flat item
     *     always has a real, unique menu_item_id.
     *   - builderItems: an ARRAY (never keyed by the shared `null`) of
     *     every line that can't be safely represented by the flat editor —
     *     Mix & Match builder boxes (menu_item_id: null, builder_details
     *     present) and any other line with no resolvable menu_item_id
     *     (e.g. its linked menu item was since deleted). Each entry keeps
     *     its own order_items.id as localId, so it can be individually
     *     removed without disturbing any other preserved line, and its
     *     builder_details is carried through byte-for-byte.
     *
     * Every input row appears in exactly one of the two outputs — nothing
     * is ever silently dropped.
     */
    function partitionOrderItemsForEditing(orderItems) {
        const flatItemsById = {};
        const builderItems = [];

        (orderItems || []).forEach(item => {
            if (!item.menu_item_id) {
                builderItems.push({
                    localId: item.id,
                    menu_item_id: null,
                    item_name: item.item_name,
                    price_at_purchase: toNumber(item.price_at_purchase),
                    quantity: toNumber(item.quantity),
                    builder_details: item.builder_details || null
                });
                return;
            }

            flatItemsById[item.menu_item_id] = {
                id: item.menu_item_id,
                name: item.item_name,
                price: toNumber(item.price_at_purchase),
                quantity: toNumber(item.quantity)
            };
        });

        return { flatItemsById, builderItems };
    }

    /**
     * The exact inverse of partitionOrderItemsForEditing's flat side, plus
     * builder items carried through unchanged: builds the order_items rows
     * to insert for a (new or edited) order, given the editor's current
     * in-memory state. Builder items always keep their original
     * builder_details, price, and quantity — the editor never modifies
     * their contents, only whether the whole line stays or is removed.
     */
    function buildOrderItemsPayload(orderId, flatItemsById, builderItems) {
        const flatOrderItems = Object.values(flatItemsById || {}).map(item => ({
            order_id: orderId,
            menu_item_id: item.id,
            item_name: item.name,
            quantity: item.quantity,
            price_at_purchase: item.price,
            line_total: item.price * item.quantity
        }));

        const builderOrderItems = (builderItems || []).map(item => ({
            order_id: orderId,
            menu_item_id: item.menu_item_id,
            item_name: item.item_name,
            quantity: item.quantity,
            price_at_purchase: item.price_at_purchase,
            line_total: item.price_at_purchase * item.quantity,
            builder_details: item.builder_details
        }));

        return [...flatOrderItems, ...builderOrderItems];
    }

    /** Total line count across both flat and preserved builder items. */
    function computeManualOrderItemCount(flatItemsById, builderItems) {
        const flatCount = Object.values(flatItemsById || {}).reduce(
            (sum, item) => sum + toNumber(item.quantity), 0
        );
        const builderCount = (builderItems || []).reduce(
            (sum, item) => sum + toNumber(item.quantity), 0
        );
        return flatCount + builderCount;
    }

    /** Subtotal across both flat and preserved builder items. */
    function computeManualOrderSubtotal(flatItemsById, builderItems) {
        const flatSubtotal = Object.values(flatItemsById || {}).reduce(
            (sum, item) => sum + toNumber(item.price) * toNumber(item.quantity), 0
        );
        const builderSubtotal = (builderItems || []).reduce(
            (sum, item) => sum + toNumber(item.price_at_purchase) * toNumber(item.quantity), 0
        );
        return flatSubtotal + builderSubtotal;
    }

    /**
     * Adds one canonical selection ({id, name, quantity}) into a running
     * {id: {name, quantity}} map, summing quantities for the same id.
     * Used both when merging several existing order_items rows that
     * resolve to the same live builder product, and by the admin editor
     * UI to keep its own live selection state.
     */
    function addSelectionToMap(map, selection) {
        if (!selection || selection.id === null || selection.id === undefined) return;

        const id = String(selection.id);
        const quantity = toNumber(selection.quantity, 0);
        const existing = map[id];

        map[id] = {
            name: (existing && existing.name) || selection.name,
            quantity: (existing ? existing.quantity : 0) + quantity
        };
    }

    /**
     * Mix & Match admin-editor support (embedded box builder in the
     * order editor). Takes the `builderItems` array already produced by
     * partitionOrderItemsForEditing() -- fully additive/opt-in: existing
     * callers that only use partitionOrderItemsForEditing's original two
     * fields are completely unaffected.
     *
     * Splits those preserved lines further into:
     *   - builderBoxesById: one EDITABLE entry per live builder (box)
     *     product matched by item_name (the same name-based resolution
     *     sale-calculations.js already relies on, since builder lines
     *     always have menu_item_id: null). If an order happens to
     *     contain more than one existing row for the same box product
     *     (e.g. two separate customer-built combos), they're merged into
     *     one editable entry -- their selections are summed per flavor
     *     and their box quantities added together, exactly mirroring how
     *     this same editor already merges duplicate flat items by id.
     *   - unresolvedBuilderItems: anything that can't be safely mapped
     *     back to a current, live builder product (its box product was
     *     renamed/deleted, or its builder_details is missing/malformed)
     *     -- preserved verbatim, remove-only, exactly like the original
     *     opaque builderItems behavior.
     *
     * Each builderBoxesById entry's perBoxPrice is derived from the
     * ORIGINAL stored price_at_purchase (never the live/current menu
     * price), so editing something unrelated on an order never silently
     * changes what an already-purchased box is worth.
     */
    function groupBuilderItemsByLiveProduct(builderItems, builderProducts) {
        const builderProductsByName = new Map(
            (builderProducts || [])
                .filter(p => p && p.name !== undefined && p.name !== null)
                .map(p => [String(p.name), p])
        );

        const builderBoxesById = {};
        const unresolvedBuilderItems = [];

        (builderItems || []).forEach(item => {
            const selections =
                item.builder_details && Array.isArray(item.builder_details.selections)
                    ? item.builder_details.selections
                    : null;

            const matchedProduct = selections ? builderProductsByName.get(String(item.item_name)) : null;

            if (!matchedProduct) {
                unresolvedBuilderItems.push(item);
                return;
            }

            const boxQuantity = toNumber(
                item.builder_details.box_quantity !== undefined
                    ? item.builder_details.box_quantity
                    : item.quantity,
                0
            );

            let box = builderBoxesById[matchedProduct.id];

            if (!box) {
                box = builderBoxesById[matchedProduct.id] = {
                    id: matchedProduct.id,
                    name: matchedProduct.name,
                    builderGroup: item.builder_details.builder_group || matchedProduct.builder_group,
                    builderSize: toNumber(matchedProduct.builder_size, 0),
                    boxQuantity: 0,
                    totalPriceAtPurchase: 0,
                    selections: {}
                };
            }

            box.boxQuantity += boxQuantity;
            box.totalPriceAtPurchase += toNumber(item.price_at_purchase, 0);

            selections.forEach(selection => addSelectionToMap(box.selections, selection));
        });

        Object.values(builderBoxesById).forEach(box => {
            box.perBoxPrice = box.boxQuantity > 0
                ? box.totalPriceAtPurchase / box.boxQuantity
                : toNumber(
                    (builderProducts || []).find(p => String(p.id) === String(box.id)) &&
                        (builderProducts || []).find(p => String(p.id) === String(box.id)).price,
                    0
                );
            delete box.totalPriceAtPurchase;
        });

        return { builderBoxesById, unresolvedBuilderItems };
    }

    /**
     * Builds the order_items rows for every editable Mix & Match box the
     * admin editor currently holds (see groupBuilderItemsByLiveProduct
     * and admin-orders.js's changeManualBuilderBoxQuantity). Boxes at
     * quantity 0 produce no row -- removing a box removes its selection
     * details with it (nothing to preserve once the whole line is gone).
     *
     * Saved in exactly the same shape the public checkout writes
     * (menu_item_id: null, item_name, builder_details: {builder_group,
     * selections}), plus the additive box_quantity field. quantity is
     * always 1 and price_at_purchase is perBoxPrice * boxQuantity, so:
     *   - revenue (line_total = price_at_purchase * quantity) is exactly
     *     the fixed per-box price times how many boxes were ordered --
     *     never inflated by individual cookie prices;
     *   - sale-calculations.js's child-cost formula
     *     (selectionQuantity * quantity) reduces to exactly
     *     selectionQuantity, i.e. the true total picked per flavor, with
     *     no risk of double-counting regardless of how unevenly flavors
     *     are split across multiple boxes in one line.
     */
    function buildBuilderBoxOrderItems(orderId, builderBoxesById) {
        return Object.values(builderBoxesById || {})
            .filter(box => toNumber(box.boxQuantity, 0) > 0)
            .map(box => {
                const boxQuantity = toNumber(box.boxQuantity, 0);

                const selections = Object.keys(box.selections || {})
                    .map(id => ({
                        id,
                        name: box.selections[id].name,
                        quantity: toNumber(box.selections[id].quantity, 0)
                    }))
                    .filter(selection => selection.quantity > 0);

                const priceAtPurchase = toNumber(box.perBoxPrice, 0) * boxQuantity;

                return {
                    order_id: orderId,
                    menu_item_id: null,
                    item_name: box.name,
                    quantity: 1,
                    price_at_purchase: priceAtPurchase,
                    line_total: priceAtPurchase,
                    builder_details: {
                        builder_group: box.builderGroup,
                        selections,
                        box_quantity: boxQuantity
                    }
                };
            });
    }

    /** Box-line item count, for the editor's "Total Items" summary. */
    function computeBuilderBoxItemCount(builderBoxesById) {
        return Object.values(builderBoxesById || {}).reduce(
            (sum, box) => sum + toNumber(box.boxQuantity, 0), 0
        );
    }

    /** Box-line subtotal (fixed per-box price only -- never individual
     *  cookie prices), for the editor's "Subtotal" summary. */
    function computeBuilderBoxSubtotal(builderBoxesById) {
        return Object.values(builderBoxesById || {}).reduce(
            (sum, box) => sum + toNumber(box.perBoxPrice, 0) * toNumber(box.boxQuantity, 0), 0
        );
    }

    return {
        isOrderEditable,
        partitionOrderItemsForEditing,
        buildOrderItemsPayload,
        computeManualOrderItemCount,
        computeManualOrderSubtotal,
        addSelectionToMap,
        groupBuilderItemsByLiveProduct,
        buildBuilderBoxOrderItems,
        computeBuilderBoxItemCount,
        computeBuilderBoxSubtotal
    };
});
