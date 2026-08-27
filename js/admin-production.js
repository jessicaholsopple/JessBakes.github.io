/* ADMIN PRODUCTION */
const CHECKLIST = [
    "Review orders",
    "Feed starter",
    "Scale ingredients",
    "Mix dough and batters",
    "Prepare inclusions",
    "Complete folds / development",
    "Bulk proof on counter",
    "Cold proof / chill",
    "Divide and shape (next day)",
    "Bake (next day)",
    "Cool completely (next day)",
    "Package and label (Sunday)"
];


// Canonical menu_items.category values are lowercase/singular
// ('bread'/'cookie'/'dessert'/'seasonal' -- the same values js/menu.js's
// public Menu page and _shared/menu.mjs's vacation email both key off
// of), never the Title-Case plural labels shown to the admin. Mirrors
// the exact category-label pattern already established in
// supabase/functions/_shared/menu.mjs's categoryLabel(): a known
// category gets its nice label and canonical position; a genuinely new
// category value still gets grouped and shown (title-cased from its raw
// value) rather than silently vanishing into "Other" -- only a truly
// missing/empty category value does that.
const PRODUCTION_CATEGORY_LABELS = { bread: "Bread", cookie: "Cookies", dessert: "Desserts", seasonal: "Seasonal" };
const PRODUCTION_CATEGORY_ORDER = Object.keys(PRODUCTION_CATEGORY_LABELS);
const PRODUCTION_OTHER_LABEL = "Other";
function productionCategoryLabel(raw) {
    if (!raw) return PRODUCTION_OTHER_LABEL;
    if (PRODUCTION_CATEGORY_LABELS[raw]) return PRODUCTION_CATEGORY_LABELS[raw];
    return String(raw).split(/[-_\s]+/).filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

const MASS={g:1,gram:1,grams:1,kg:1000,kilogram:1000,kilograms:1000,oz:28.3495,ounce:28.3495,ounces:28.3495,lb:453.592,lbs:453.592,pound:453.592,pounds:453.592};
const VOLUME={ml:1,milliliter:1,milliliters:1,l:1000,liter:1000,liters:1000,tsp:4.92892,teaspoon:4.92892,teaspoons:4.92892,tbsp:14.7868,tablespoon:14.7868,tablespoons:14.7868,cup:236.588,cups:236.588,"fl oz":29.5735,floz:29.5735};
const COUNT=["each","item","items","count","piece","pieces","unit","units"];
let data = {
    orders: [],
    menu: [],
    recipes: [],
    recipeIngredients: [],
    recipeComponents: [],
    ingredients: [],
    packagingItems: [],
    recipeCosts: [],
    packagingCosts: [],
    run: null,
    // BUG-23: the current EUR->USD rate used for revenue/profit/margin
    // PROJECTIONS on this page. Resolved once per page load (not per
    // sale) via the same Phase 3 module/mechanism used at sale
    // completion -- but never snapshotted onto any order or sale, since
    // these are unconfirmed, in-progress orders with no completed sale
    // yet. null means no rate could be resolved (see resolveCurrentRate).
    currentRate: null
};
let plan=emptyPlan();

document.addEventListener("DOMContentLoaded",async()=>{await requireAuth();if(typeof setupLogout==="function")setupLogout();setDefaultDate();await loadReferenceData();await resolveCurrentRate();await loadSelectedDate();});

async function loadReferenceData() {

    const results = await Promise.all([
        supabaseClient.from("menu_items").select("*"),
        supabaseClient.from("recipes").select("*"),
        supabaseClient.from("recipe_ingredients").select("*"),
        supabaseClient.from("recipe_components").select("*"),
        supabaseClient.from("ingredients").select("*").order("name"),
        supabaseClient.from("packaging_profile_items").select("*"),
        supabaseClient.from("recipe_costs").select("*"),
        supabaseClient.from("packaging_profile_costs").select("*"),
        supabaseClient
            .from("orders")
            .select("pickup_date,status")
            .in("status", ["pending", "confirmed", "ready"])
            .order("pickup_date")
    ]);

    const failed = results.find(result => result.error);

    if (failed) {
        console.error(failed.error);
        fatal(failed.error.message);
        return;
    }

    [
        data.menu,
        data.recipes,
        data.recipeIngredients,
        data.recipeComponents,
        data.ingredients,
        data.packagingItems,
        data.recipeCosts,
        data.packagingCosts
    ] = results.slice(0, 8).map(result => result.data || []);

    populateDates(results[8].data || []);

}

/* ==========================================
   BUG-23: EUR->USD rate for revenue/profit/margin PROJECTIONS
   ==========================================

   Reuses the exact Phase 3 currency-conversion module and resolution
   order (cache -> live ECB-derived fetch -> safe administrator-entered
   manual fallback) that createSaleFromOrder() uses when a sale actually
   completes -- see js/currency-conversion.js and js/admin-orders.js.
   The key difference here: this rate is used only for this page's live
   projections and is never written onto any order or sale. Resolved
   once per page load/refresh, not once per pickup date, since it
   represents "today's rate," not a per-sale snapshot.
========================================== */

async function resolveCurrentRate() {

    const todayStr = new Date().toISOString().split("T")[0];

    try {

        data.currentRate = await CurrencyConversion.resolveExchangeRate(todayStr, {
            getCachedRate: getCachedExchangeRate,
            fetchLiveRate: CurrencyConversion.createFrankfurterFetcher(),
            promptManualRate: async (dateStr) => promptManualExchangeRate(dateStr),
            saveRate: saveExchangeRate
        });

    } catch (err) {

        console.error(err);
        data.currentRate = null;

    }

}

async function getCachedExchangeRate(dateStr) {

    const { data: row, error } =
        await supabaseClient
            .from("exchange_rates")
            .select("*")
            .eq("rate_date", dateStr)
            .maybeSingle();

    if (error) {

        console.error(error);
        return null;

    }

    return row;

}

async function saveExchangeRate(entry) {

    const { error } =
        await supabaseClient
            .from("exchange_rates")
            .upsert({

                rate_date: entry.rate_date,

                reference_date: entry.reference_date,

                rate: entry.rate,

                source: entry.source

            });

    if (error) throw error;

}

function promptManualExchangeRate(dateStr) {

    const input = prompt(
        `Couldn't retrieve today's EUR→USD exchange rate for ${dateStr}, needed to show Production's revenue/cost/profit figures in USD.\n\nEnter it manually (e.g. 1.0921), or press Cancel to leave those figures unavailable until a rate can be resolved.`
    );

    if (input === null) return null;

    const parsed = Number(input);

    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;

}

async function retryCurrentRate() {

    await resolveCurrentRate();

    plan = buildPlan();

    renderAll();

}

async function loadSelectedDate(){
 const date=selectedDate();if(!date)return;loading();
 const [ordersResult,runResult]=await Promise.all([
  supabaseClient.from("orders").select(`*,order_items(*)`).eq("pickup_date",date).in("status",["pending","confirmed","ready"]).order("created_at"),
  supabaseClient.from("production_runs").select("*").eq("production_date",date).maybeSingle()
 ]);
 if(ordersResult.error){console.error(ordersResult.error);fatal(ordersResult.error.message);return;}
 if(runResult.error&&runResult.error.code!=="42P01")console.error(runResult.error);
 data.orders=ordersResult.data||[];data.run=runResult.data||null;plan=buildPlan();renderAll();
}

function buildPlan() {

    const menuMap =
        new Map(
            data.menu.map(item => [
                String(item.id),
                item
            ])
        );

    const recipeMap =
        new Map(
            data.recipes.map(recipe => [
                String(recipe.id),
                recipe
            ])
        );

    const ingredientMap =
        new Map(
            data.ingredients.map(ingredient => [
                String(ingredient.id),
                ingredient
            ])
        );

    const packagingCostMap =
        new Map(
            data.packagingCosts.map(cost => [
                String(cost.id),
                cost
            ])
        );

    // Builder ("Mix & Match") order_items never carry a stable
    // menu_item_id -- both js/cart.js (checkout) and js/order-editor.js
    // (admin editing) deliberately write menu_item_id: null for them, by
    // design. Resolving the box product back from its item_name is the
    // SAME resolution strategy already established and tested in
    // js/sale-calculations.js (menuItemsByBuilderName) and
    // js/order-editor.js (builderProductsByName) for this exact problem
    // -- reused here rather than inventing a third interpretation. Used
    // ONLY to find the box's own packaging profile; every flavor/child
    // calculation below stays 100% id-based via selection.id and never
    // touches this map.
    const builderProductsByName =
        new Map(
            data.menu
                .filter(item => item && item.product_type === "builder" && item.name)
                .map(item => [String(item.name), item])
        );

    const products = new Map();
    const batches = new Map();
    const ingredients = new Map();
    const packaging = new Map();
    const warnings = [];

    let itemCount = 0;
    let revenue = 0;
    let packagingCost = 0;

    // Reconciliation safety net: every unit counted into itemCount must
    // end up either in a product's quantity (successfully calculated) or
    // explicitly subtracted here because a warning dropped it (an
    // unresolvable menu-item link). If a future change adds a new silent
    // early-return that skips both, the assertion after the main loop
    // below catches it and surfaces a warning instead of quietly
    // shipping an incomplete plan.
    let droppedQuantity = 0;

    function warn(message, order) {
        warnings.push(
            order
                ? `${message} (${order.customer_name || "customer"}, pickup ${order.pickup_date || "?"})`
                : message
        );
    }

    function addProductQuantity(menuItem, quantity, revenueAmount) {
        const productKey = String(menuItem.id);
        const product =
            products.get(productKey) || {
                name: menuItem.name,
                quantity: 0,
                revenue: 0,
                category: menuItem.category || "Other"
            };
        product.quantity += quantity;
        product.revenue += revenueAmount;
        products.set(productKey, product);
    }

    // Recipe/ingredient demand for one menu item at a given order
    // quantity. Shared by regular order lines and Mix & Match child
    // selections -- exactly one implementation, so they can never
    // silently diverge. Skips the "no recipe assigned" warning entirely
    // when the product has been explicitly classified as not needing one
    // (menu_items.requires_recipe = false -- see Admin Menu's "This
    // product needs a recipe" checkbox); a product with no explicit
    // classification (requires_recipe absent/true, the default) still
    // warns exactly as before.
    function addRecipeDemand(menuItem, quantity, order) {
        const parentRecipe = recipeMap.get(String(menuItem.recipe_id));

        if (!parentRecipe) {
            if (menuItem.requires_recipe !== false) {
                warn(`"${menuItem.name}" does not have a recipe assigned.`, order);
            }
            return;
        }

        const recipeUnits = quantity * Number(menuItem.recipe_units_used || 1);
        const parentYield = Number(parentRecipe.yield_quantity);

        if (!(parentYield > 0)) {
            warn(`"${parentRecipe.name}" needs a yield quantity greater than zero.`, order);
            return;
        }

        collectRecipeRequirements({
            recipe: parentRecipe,
            multiplier: recipeUnits / parentYield,
            recipeUnits,
            recipeMap,
            ingredientMap,
            ingredientTotals: ingredients,
            batchTotals: batches,
            warnings,
            path: []
        });
    }

    // Packaging for one ordinary (non-builder) product line -- unchanged
    // from before: the item's own packaging_profile_id, times how many
    // were ordered.
    function addStandardPackaging(menuItem, quantity, order) {
        if (!menuItem.packaging_profile_id) {
            warn(`"${menuItem.name}" does not have a packaging profile assigned.`, order);
            return;
        }
        addPackagingForProfile(menuItem.packaging_profile_id, quantity);
    }

    // Packaging for a Mix & Match BOX line -- the box's OWN packaging
    // profile (e.g. "6 Pack Cookie Bags" / "Pastry Boxes"), times the
    // true number of boxes, added ONCE per box line. The selected
    // cookies inside it never separately contribute packaging -- doing
    // so would both double-count materials and require a nonexistent
    // per-cookie bag for a box that is never actually bagged that way.
    function addBoxPackaging(boxProduct, boxQuantity, order) {
        if (boxQuantity <= 0) return;
        if (!boxProduct.packaging_profile_id) {
            warn(`"${boxProduct.name}" does not have a packaging profile assigned.`, order);
            return;
        }
        addPackagingForProfile(boxProduct.packaging_profile_id, boxQuantity);
    }

    function addPackagingForProfile(profileId, quantity) {
        data.packagingItems
            .filter(item => String(item.profile_id) === String(profileId))
            .forEach(profileItem => {
                const ingredient = ingredientMap.get(String(profileItem.ingredient_id));
                if (!ingredient) return;
                addReq(packaging, ingredient, Number(profileItem.quantity || 0) * quantity, "packaging");
            });

        packagingCost += Number(packagingCostMap.get(String(profileId))?.packaging_cost || 0) * quantity;
    }

    data.orders.forEach(order => {

        revenue += Number(order.subtotal || 0);

        (order.order_items || []).forEach(orderItem => {

            const selections = orderItem.builder_details?.selections;
            const isBuilder = Array.isArray(selections) && selections.length > 0;

            // A builder-type box with NO (or empty) selections is a
            // malformed or legacy row -- e.g. an order line saved before
            // the admin editor could capture Mix & Match choices. Never
            // guess which flavors were picked: surface a specific,
            // blocking warning naming the order, and still account for
            // the box's own packaging (that part is fully knowable from
            // quantity alone, independent of flavor), but never add it
            // to Product Totals or Recipe Batches, since the flavor
            // breakdown genuinely cannot be known.
            if (!isBuilder && orderItem.item_name && builderProductsByName.has(String(orderItem.item_name))) {
                warn(`"${orderItem.item_name}" is missing its Mix & Match flavor selections -- cannot calculate which cookies to bake. Re-open and re-save this order in Admin Orders to capture them.`, order);
                const boxProduct = builderProductsByName.get(String(orderItem.item_name));
                addBoxPackaging(boxProduct, Number(orderItem.quantity || 0), order);
                return;
            }

            if (isBuilder) {

                // The true box count: box_quantity when the admin editor
                // aggregated more than one box's worth of cookies into a
                // single row (quantity always 1 in that case -- see
                // js/order-editor.js), otherwise the line's own quantity
                // (the public checkout's shape -- see js/cart.js).
                const boxQuantity =
                    orderItem.builder_details.box_quantity !== undefined
                        ? Number(orderItem.builder_details.box_quantity || 0)
                        : Number(orderItem.quantity || 0);

                const boxProduct = builderProductsByName.get(String(orderItem.item_name));

                if (!boxProduct) {
                    warn(`"${orderItem.item_name}" does not match any current Mix & Match box product -- its packaging cannot be calculated.`, order);
                } else {
                    addBoxPackaging(boxProduct, boxQuantity, order);
                }

                // Each selected flavor: its own Product Totals entry (by
                // its own stable id) and its own recipe/ingredient
                // demand. Never packaging (already handled once, above,
                // by the box) and never revenue (the box's line_total
                // already owns 100% of this line's price -- adding a
                // per-cookie price here would double-count it).
                selections.forEach(selection => {
                    const quantity = Number(selection.quantity || 0);
                    if (quantity <= 0) return;

                    itemCount += quantity;

                    const menuItem = menuMap.get(String(selection.id));
                    if (!menuItem) {
                        warn(`"${selection.name}" (selected inside "${orderItem.item_name}") is not linked to a current menu item.`, order);
                        droppedQuantity += quantity;
                        return;
                    }

                    addProductQuantity(menuItem, quantity, 0);
                    addRecipeDemand(menuItem, quantity, order);
                });

                return;
            }

            // ---- Regular (non-builder) order item ----
            const quantity = Number(orderItem.quantity || 0);
            itemCount += quantity;

            const menuItem = menuMap.get(String(orderItem.menu_item_id));
            if (!menuItem) {
                warn(`"${orderItem.item_name}" is not linked to a current menu item.`, order);
                droppedQuantity += quantity;
                return;
            }

            addProductQuantity(menuItem, quantity, Number(orderItem.line_total || 0));
            addRecipeDemand(menuItem, quantity, order);
            addStandardPackaging(menuItem, quantity, order);

        });

    });

    // Reconciliation assertion (see droppedQuantity above): every counted
    // unit is either represented in a product's quantity or was
    // explicitly dropped with its own warning. A mismatch means some
    // quantity vanished silently -- surface it loudly rather than ship
    // an incomplete plan without saying so.
    const accountedQuantity =
        [...products.values()].reduce((sum, product) => sum + product.quantity, 0) +
        droppedQuantity;

    if (accountedQuantity !== itemCount) {
        warn(
            `Reconciliation check failed: ${itemCount} units were ordered but only ${accountedQuantity} are accounted for in this plan. Some quantity may be missing -- do not finish production until this is investigated.`
        );
    }

    const ingredientRequirements =
        [...ingredients.values()]
            .sort(sortName);

    const foodCost =
        ingredientRequirements.reduce(
            (sum, requirement) =>
                sum +
                calculateRequirementCost(
                    requirement
                ),
            0
        );

    const combined =
        combine([
            ...ingredientRequirements,
            ...packaging.values()
        ]);

    const shortages =
        combined.filter(item =>
            item.shortage > 0
        );

    const profit =
        revenue -
        foodCost -
        packagingCost;

    // BUG-23: revenue is EUR (order.subtotal, what the customer actually
    // pays -- unchanged above); foodCost/packagingCost are already USD
    // (recipe_costs/packaging_profile_costs). `profit`/`margin` above mix
    // the two currencies directly, which is exactly the bug. usdRevenue/
    // usdProfit/usdMargin below are the corrected, all-USD figures the
    // page actually displays, using the CURRENT rate resolved once per
    // page load (never a per-sale snapshot, since these are unconfirmed,
    // in-progress orders with no completed sale yet). If no rate could be
    // resolved, these stay null rather than silently showing a wrong
    // number -- see renderCosts()/renderAll() for how that's surfaced.
    const usdRate = data.currentRate?.rate || null;

    // Reuses the exact same function createSaleFromOrder() uses to convert
    // a completed sale's figures -- revenue (EUR) is converted, cost
    // (already USD) is not, per the confirmed Phase 3 rule.
    const usdFigures =
        usdRate !== null
            ? CurrencyConversion.computeUsdSaleFigures({
                revenue,
                totalCost: foodCost + packagingCost,
                rate: usdRate
            })
            : null;

    const usdRevenue = usdFigures ? usdFigures.usdRevenue : null;
    const usdProfit = usdFigures ? usdFigures.usdProfit : null;

    const usdMargin =
        usdRevenue !== null
            ? SaleCalculations.computeMargin(usdRevenue, usdProfit)
            : 0;

    return {
        date:
            selectedDate(),
        orders:
            data.orders,
        products:
            [...products.values()]
                .map(product => ({
                    ...product,
                    usdRevenue:
                        usdRate !== null
                            ? CurrencyConversion.convertEurToUsd(product.revenue, usdRate)
                            : null
                }))
                .sort(
                    (a, b) =>
                        b.quantity - a.quantity
                ),
        batches:
            [...batches.values()]
                .sort(
                    (a, b) =>
                        a.name.localeCompare(b.name)
                ),
        ingredientReq:
            ingredientRequirements,
        packagingReq:
            [...packaging.values()]
                .sort(sortName),
        combined,
        shortages,
        warnings:
            [...new Set(warnings)],
        orderCount:
            data.orders.length,
        itemCount,
        revenue,
        foodCost,
        packagingCost,
        totalCost:
            foodCost + packagingCost,
        profit,
        margin:
            revenue
                ? profit / revenue * 100
                : 0,
        // BUG-23: all-USD figures, the ones actually displayed. null
        // means no exchange rate could be resolved this page load.
        usdRevenue,
        usdProfit,
        usdMargin,
        rateAvailable:
            usdRate !== null,
        rateInfo:
            data.currentRate
    };

}

function collectRecipeRequirements({
    recipe,
    multiplier,
    recipeUnits,
    recipeMap,
    ingredientMap,
    ingredientTotals,
    batchTotals,
    warnings,
    path
}) {

    const recipeId =
        String(recipe.id);

    if (path.includes(recipeId)) {

        const cycleNames =
            [...path, recipeId]
                .map(id =>
                    recipeMap.get(id)?.name || id
                )
                .join(" → ");

        warnings.push(
            `Circular recipe component detected: ${cycleNames}.`
        );

        return;

    }

    const nextPath =
        [...path, recipeId];

    addRecipeBatch(
        batchTotals,
        recipe,
        multiplier,
        recipeUnits
    );

    data.recipeIngredients
        .filter(item =>
            String(item.recipe_id) ===
            recipeId
        )
        .forEach(recipeIngredient => {

            const ingredient =
                ingredientMap.get(
                    String(
                        recipeIngredient.ingredient_id
                    )
                );

            if (!ingredient) {

                warnings.push(
                    `${recipe.name} contains a missing ingredient link.`
                );

                return;

            }

            addReq(
                ingredientTotals,
                ingredient,
                Number(
                    recipeIngredient.quantity || 0
                ) * multiplier,
                "ingredient"
            );

        });

    data.recipeComponents
        .filter(component =>
            String(component.parent_recipe_id) ===
            recipeId
        )
        .forEach(component => {

            const componentRecipe =
                recipeMap.get(
                    String(
                        component.component_recipe_id
                    )
                );

            if (!componentRecipe) {

                warnings.push(
                    `${recipe.name} contains a missing component recipe.`
                );

                return;

            }

            const requiredComponentAmount =
                Number(
                    component.quantity_used || 0
                ) * multiplier;

            const componentYieldUnit =
                componentRecipe.yield_unit ||
                component.quantity_unit;

            // If both are count-based units (item, piece, unit, etc.),
            // use the quantity directly instead of attempting a weight conversion.
            const convertedAmount =
                unit(component.quantity_unit) === unit(componentYieldUnit)
                    ? requiredComponentAmount
                    : convert(
                        requiredComponentAmount,
                        component.quantity_unit,
                        componentYieldUnit
                    );

            if (convertedAmount === null) {

                warnings.push(
                    `${recipe.name} uses ${componentRecipe.name} in ${component.quantity_unit}, but that cannot be converted to the component yield unit ${componentYieldUnit}.`
                );

                return;

            }

            const componentYield =
                Number(
                    componentRecipe.yield_quantity || 0
                );

            if (componentYield <= 0) {

                warnings.push(
                    `${componentRecipe.name} needs a yield quantity greater than zero.`
                );

                return;

            }

            const componentMultiplier =
                convertedAmount /
                componentYield;

            collectRecipeRequirements({
                recipe:
                    componentRecipe,
                multiplier:
                    componentMultiplier,
                recipeUnits:
                    convertedAmount,
                recipeMap,
                ingredientMap,
                ingredientTotals,
                batchTotals,
                warnings,
                path:
                    nextPath
            });

        });

}

function addRecipeBatch(
    batchTotals,
    recipe,
    multiplier,
    recipeUnits
) {

    const key =
        String(recipe.id);

    const current =
        batchTotals.get(key) || {
            id:
                recipe.id,
            name:
                recipe.name,
            notes:
                recipe.notes || "",
            yieldQuantity:
                Number(
                    recipe.yield_quantity || 1
                ),
            yieldUnit:
                recipe.yield_unit || "items",
            recipeUnits: 0,
            batches: 0
        };

    current.recipeUnits +=
        Number(recipeUnits || 0);

    current.batches +=
        Number(multiplier || 0);

    batchTotals.set(key, current);

}

function calculateRequirementCost(requirement) {

    const ingredient =
        data.ingredients.find(item =>
            String(item.id) ===
            String(requirement.ingredientId)
        );

    if (!ingredient) return 0;

    const purchaseSizeInRecipeUnits =
        convert(
            ingredient.purchase_size,
            ingredient.purchase_unit,
            ingredient.recipe_unit
        );

    if (
        purchaseSizeInRecipeUnits === null ||
        purchaseSizeInRecipeUnits <= 0
    ) {
        return 0;
    }

    const costPerRecipeUnit =
        Number(
            ingredient.purchase_price || 0
        ) /
        purchaseSizeInRecipeUnits;

    return (
        costPerRecipeUnit *
        Number(requirement.required || 0)
    );

}
function addReq(map,ing,qty,source){const k=String(ing.id),x=map.get(k)||{ingredientId:ing.id,name:ing.name,source,recipeUnit:ing.recipe_unit,purchaseUnit:ing.purchase_unit,onHandPurchase:Number(ing.quantity_on_hand||0),minimumPurchase:Number(ing.minimum_quantity||0),required:0};x.required+=qty;map.set(k,x);}
function combine(items){const m=new Map();items.forEach(x=>{const k=String(x.ingredientId),v=m.get(k)||{...x,required:0,sources:[]};v.required+=x.required;if(!v.sources.includes(x.source))v.sources.push(x.source);m.set(k,v);});return[...m.values()].map(finalize).sort(sortName);}
function finalize(x){const have=convert(x.onHandPurchase,x.purchaseUnit,x.recipeUnit),min=convert(x.minimumPurchase,x.purchaseUnit,x.recipeUnit),ok=have!==null,safe=ok?have:0,shortage=Math.max(x.required-safe,0),remaining=safe-x.required;let status="good";if(!ok)status="unknown";else if(shortage>0)status="short";else if(min!==null&&remaining<=min)status="low";return{...x,have:safe,minimum:min||0,shortage,remaining,convertible:ok,status};}

function renderAll(){renderSubtitle();renderRun();renderWarnings();setText("productionOrderCount",plan.orderCount);setText("productionItemCount",fmt(plan.itemCount));setText("productionRevenue",plan.rateAvailable?usd(plan.usdRevenue):"—");setText("productionProfit",plan.rateAvailable?usd(plan.usdProfit):"—");setText("productionShortageCount",plan.shortages.length);renderProducts();renderBatches();renderCosts();renderIngredients();renderShopping();renderPackaging();renderChecklist();renderTimeline();renderOrders();}
function renderSubtitle(){const d=parseDate(plan.date),el=document.getElementById("productionSubtitle");if(el)el.textContent=d?`Production plan for ${d.toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"})}.`:"Select a date.";}
function renderRun(){document.getElementById("productionCompletedBanner")?.remove();const done=!!data.run?.inventory_deducted,blocked=!done&&hasBlockingErrors(),btn=document.getElementById("finishProductionBtn");if(btn){btn.disabled=done||blocked;btn.title=blocked?"Resolve the blocking warnings above before finishing production -- inventory cannot be deducted safely from an incomplete plan.":"";btn.textContent=done?"Production Completed":blocked?"Finish Production (blocked)":"Finish Production";}if(done){const b=document.createElement("div");b.id="productionCompletedBanner";b.className="production-completed-banner";b.textContent="Production is complete and inventory has already been deducted for this date.";document.querySelector(".production-kpi-grid")?.before(b);}}
// Every entry in plan.warnings and every inconvertible-unit message
// represents a plan that cannot be trusted for a safe inventory
// deduction -- both are rendered as blocking "error" messages and both
// gate Finish Production (see hasBlockingErrors()/finishProduction()).
// Inventory shortages are informational only (shown separately via the
// Shopping List/status badges) and never block finishing -- baking
// against a known shortage and restocking after is a normal, expected
// workflow here, not an error.
function hasBlockingErrors(){return plan.warnings.length>0||plan.combined.some(x=>!x.convertible);}
function renderWarnings(){const el=document.getElementById("productionWarnings"),messages=[];messages.push(["info",`Includes orders with status Pending, Confirmed, or Ready for this date. Excludes Cancelled orders and Completed orders (already sold -- see Sales).`]);if(!plan.orders.length)messages.push(["info","No pending, confirmed, or ready orders are scheduled for this date."]);plan.warnings.forEach(x=>messages.push(["error",x]));plan.combined.filter(x=>!x.convertible).forEach(x=>messages.push(["error",`${x.name}: ${x.purchaseUnit} cannot be converted to ${x.recipeUnit}. Correct its inventory units before finishing production.`]));if(plan.orders.length&&!hasBlockingErrors())messages.push(["success","All links are complete and inventory covers every calculated requirement."]);el.innerHTML=messages.map(([t,x])=>`<div class="production-warning production-warning-${t}">${esc(x)}</div>`).join("");}

function renderProducts() {

    const el = document.getElementById("productionTotals");

    if (!plan.products.length) {
        el.innerHTML = empty("No products scheduled.");
        return;
    }

    // Grouped by the RAW menu_items.category value (matches how
    // buildPlan() stored it) so two raw values that happen to produce
    // the same display label can never silently merge; only the header
    // text and sort position go through productionCategoryLabel().
    const grouped = new Map();

    plan.products.forEach(product => {

        const category = product.category || "";

        if (!grouped.has(category)) {
            grouped.set(category, []);
        }

        grouped.get(category).push(product);

    });

    grouped.forEach(items => {
        items.sort((a, b) => a.name.localeCompare(b.name));
    });

const html = [...grouped.entries()]
    .sort((a, b) => {

        const aIndex = PRODUCTION_CATEGORY_ORDER.indexOf(a[0]);
        const bIndex = PRODUCTION_CATEGORY_ORDER.indexOf(b[0]);

        // Known categories (bread/cookie/dessert/seasonal) sort first,
        // in that canonical order; a genuinely new category value sorts
        // next, alphabetically by its generated label; "Other" (a truly
        // missing category) always sorts last.
        if (a[0] === "" && b[0] !== "") return 1;
        if (b[0] === "" && a[0] !== "") return -1;
        if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
        if (aIndex !== -1) return -1;
        if (bIndex !== -1) return 1;

        return productionCategoryLabel(a[0]).localeCompare(productionCategoryLabel(b[0]));

    })
    .map(([category, items]) => {

        const total = items.reduce(
            (sum, item) => sum + item.quantity,
            0
        );

        return `
            <section class="production-category">

                <h2 class="production-category-title">
                    ${esc(productionCategoryLabel(category))} (${fmt(total)})
                </h2>

                <div class="production-total-grid">

                    ${items.map(item => `
                        <article class="production-total-card">

                            <div>
                                <h3>${esc(item.name)}</h3>
                                <small>${plan.rateAvailable?usd(item.usdRevenue):"—"}</small>
                            </div>

                            <strong>${fmt(item.quantity)}</strong>

                        </article>
                    `).join("")}

                </div>

            </section>
        `;

    }).join("");

    el.innerHTML = html;

}

    
function renderBatches(){const el=document.getElementById("recipeBatches");el.innerHTML=plan.batches.length?plan.batches.map(batchRow).join(""):empty("No linked recipes for this date.");}
// Shows the exact fractional batch count needed AND the practical
// whole-batch recommendation (rounded up) whenever they differ -- no
// established whole-batch rounding policy exists elsewhere in this
// project to defer to, so both figures are shown rather than silently
// picking one and hiding the other.
function batchRow(x){const whole=Math.ceil(x.batches-1e-9);const roundedNote=whole>0&&Math.abs(whole-x.batches)>1e-9?`<p class="production-batch-round">Round up to <strong>${whole} whole batch${whole===1?"":"es"}</strong> (${fmt(whole*x.yieldQuantity)} ${esc(x.yieldUnit)} total).</p>`:"";return`<article class="production-batch-card"><div class="production-batch-top"><div><h3>${esc(x.name)}</h3><p>Produces ${fmt(x.recipeUnits)} ${esc(x.yieldUnit)} from a ${fmt(x.yieldQuantity)} ${esc(x.yieldUnit)} base yield.</p></div><span class="production-batch-amount">${fmt(x.batches)}×</span></div>${roundedNote}${x.notes?`<p>${esc(x.notes)}</p>`:""}</article>`;}
function renderCosts(){
    // BUG-23: revenue/cost/profit/margin report in USD (Ingredient/
    // Packaging/Total cost were already USD, just mislabeled before; only
    // Expected Revenue/Estimated Profit/Estimated Margin are genuinely
    // converted, using the current rate resolved once per page load).
    const rateNotice = plan.rateAvailable
        ? ""
        : `<div class="production-warning production-warning-warning">Today's EUR→USD exchange rate is unavailable, so Expected Revenue, Estimated Profit, and Estimated Margin can't be shown right now. Ingredient/Packaging/Total cost below are unaffected (already USD). <button type="button" class="secondary-btn" onclick="retryCurrentRate()">Retry</button></div>`;
    document.getElementById("productionCosts").innerHTML=`${rateNotice}<div class="production-metric-list">${metric("Expected Revenue (USD)",plan.rateAvailable?usd(plan.usdRevenue):"—")}${metric("Ingredient Cost (USD)",usd(plan.foodCost))}${metric("Packaging Cost (USD)",usd(plan.packagingCost))}${metric("Total Estimated Cost (USD)",usd(plan.totalCost))}${metric("Estimated Profit (USD)",plan.rateAvailable?usd(plan.usdProfit):"—")}${metric("Estimated Margin",plan.rateAvailable?`${plan.usdMargin.toFixed(1)}%`:"—")}</div>`;
}
function renderIngredients(){const el=document.getElementById("ingredientRequirements"),badge=document.getElementById("ingredientStatusBadge"),rows=plan.combined.filter(x=>x.sources.includes("ingredient"));if(!rows.length){el.innerHTML=empty("No ingredient requirements calculated.");badge.textContent="No data";return;}badge.textContent=rows.some(x=>x.status==="short")?"Shopping required":"Inventory covered";el.innerHTML=`<div class="production-list">${rows.map(reqRow).join("")}</div>`;}
function reqRow(x){const label={good:"Enough",low:"Low after bake",short:"Short",unknown:"Check units"}[x.status],cls=x.status==="short"?"production-stock-short":x.status==="low"||x.status==="unknown"?"production-stock-low":"production-stock-good";return`<div class="production-row"><div><strong>${esc(x.name)}</strong><small>Stock unit: ${esc(x.purchaseUnit)}</small></div><div class="production-row-value"><small>Need</small><strong>${displayQty(x.required,x.recipeUnit)}</strong></div><div class="production-row-value"><small>Have</small><strong>${x.convertible?displayQty(x.have,x.recipeUnit):"Unknown"}</strong></div><span class="production-stock-status ${cls}">${label}</span></div>`;}
function renderShopping(){const el=document.getElementById("shoppingList");el.innerHTML=plan.shortages.length?plan.shortages.map(x=>`<div class="production-shopping-row"><label><input type="checkbox"><span>${esc(x.name)}</span></label><strong>Buy ${displayQty(x.shortage,x.recipeUnit)}</strong></div>`).join(""):empty("Nothing needs to be purchased for this date.");}
function renderPackaging(){const el=document.getElementById("packagingRequirements"),map=new Map(plan.combined.map(x=>[String(x.ingredientId),x]));el.innerHTML=plan.packagingReq.length?plan.packagingReq.map(x=>{const f=map.get(String(x.ingredientId)),cls=f?.status==="short"?"production-stock-short":f?.status==="low"?"production-stock-low":"production-stock-good",label=f?.status==="short"?"Short":f?.status==="low"?"Low after bake":"Enough";return`<div class="production-shopping-row"><span>${esc(x.name)}</span><strong>${displayQty(x.required,x.recipeUnit)}</strong>${f?`<span class="production-stock-status ${cls}">${label}</span>`:""}</div>`;}).join(""):empty("No packaging requirements calculated.");}
function renderChecklist(){const saved=data.run?.checklist||{};document.getElementById("productionChecklist").innerHTML=`<div class="production-checklist">${CHECKLIST.map((x,i)=>`<label class="production-check-item ${saved[i]?"is-complete":""}"><input type="checkbox" ${saved[i]?"checked":""} onchange="updateChecklistItem(${i},this.checked,this)"><span>${esc(x)}</span></label>`).join("")}</div>`;}

function renderTimeline() {

    const pickupDate = parseDate(plan.date);

    if (!pickupDate) {

        document.getElementById("productionTimeline").innerHTML =
            empty("Select a production date.");

        return;

    }

    const shopDay = new Date(pickupDate);
    shopDay.setDate(shopDay.getDate() - 3);

    const doughDay = new Date(pickupDate);
    doughDay.setDate(doughDay.getDate() - 2);

    const bakeDay = new Date(pickupDate);
    bakeDay.setDate(bakeDay.getDate() - 1);

    const stages = [

        [
            day(shopDay),
            "Shop for ingredients, packaging, and any missing inventory."
        ],

        [
            day(doughDay),
            "Feed starter, scale ingredients, prepare inclusions, mix dough, complete folds, bulk proof on the counter, then refrigerate overnight."
        ],

        [
            day(bakeDay),
            "Divide and shape dough, bake all products, cool completely, and prepare for pickup."
        ],

        [
            day(pickupDate),
            "Package, label, perform final quality check, and complete customer pickups."
        ]

    ];

    document.getElementById("productionTimeline").innerHTML = `
        <div class="production-timeline">
            ${stages.map(([title, text]) => `
                <div class="production-timeline-item">
                    <strong>${esc(title)}</strong>
                    <p>${esc(text)}</p>
                </div>
            `).join("")}
        </div>
    `;

}


function renderOrders(){const el=document.getElementById("includedOrders");el.innerHTML=plan.orders.length?plan.orders.map(o=>`<article class="production-order-card"><div class="production-order-header"><div><h3>${esc(o.customer_name)}</h3><small>${cap(o.status)} · ${o.order_type==="custom"?"Custom Order":"Weekly Pickup"}</small></div><strong>${euro(o.subtotal)}</strong></div><div class="production-order-items">${(o.order_items||[]).map(i=>`<div class="production-order-item"><span>${esc(i.item_name)}</span><strong>${i.quantity}×</strong></div>`).join("")}</div>${o.notes?`<p><strong>Notes:</strong> ${esc(o.notes)}</p>`:""}</article>`).join(""):empty("No active orders are included.");}

async function updateChecklistItem(i,checked,input){input?.closest(".production-check-item")?.classList.toggle("is-complete",checked);const checklist={...(data.run?.checklist||{}),[i]:checked};const {data:run,error}=await supabaseClient.from("production_runs").upsert({production_date:selectedDate(),checklist,status:checked?"in_progress":data.run?.status||"planned",updated_at:new Date().toISOString()},{onConflict:"production_date"}).select().single();if(error){console.error(error);alert("Checklist could not be saved. Run production-setup.sql first.");return;}data.run=run;}
async function finishProduction(){if(!plan.orders.length){alert("There are no active orders to finish for this date.");return;}if(data.run?.inventory_deducted){alert("Inventory has already been deducted for this date.");return;}if(plan.warnings.length){alert("Cannot finish production -- this plan has unresolved warnings and cannot be calculated safely:\n\n"+plan.warnings.join("\n"));return;}if(plan.combined.some(x=>!x.convertible)){alert("Correct incompatible inventory units before finishing production.");return;}if(!confirm(`Finish production and deduct all calculated ingredient and packaging quantities from inventory?\n\nOrders included: ${plan.orderCount}\nIngredient lines: ${plan.ingredientReq.length}\nPackaging lines: ${plan.packagingReq.length}\n\nThis can only run once for this date.`))return;const deductions=plan.combined.map(x=>({ingredient_id:x.ingredientId,quantity_purchase_units:convert(x.required,x.recipeUnit,x.purchaseUnit)||0}));const snapshot={generated_at:new Date().toISOString(),production_date:plan.date,order_ids:plan.orders.map(x=>x.id),products:plan.products,recipes:plan.batches,requirements:plan.combined,revenue:plan.revenue,food_cost:plan.foodCost,packaging_cost:plan.packagingCost,profit:plan.profit};const {data:run,error}=await supabaseClient.rpc("complete_production",{p_production_date:plan.date,p_snapshot:snapshot,p_deductions:deductions});if(error){console.error(error);alert(error.message);return;}data.run=run;await loadReferenceData();await loadSelectedDate();}

function setDefaultDate(){document.getElementById("productionDate").value=dateValue(nextSunday(new Date()));}
function changeProductionDate(){loadSelectedDate();}
function moveProductionDate(n){const d=parseDate(selectedDate())||new Date();d.setDate(d.getDate()+n);document.getElementById("productionDate").value=dateValue(d);loadSelectedDate();}
function selectToday(){document.getElementById("productionDate").value=dateValue(new Date());loadSelectedDate();}
function selectActiveDate(){const v=document.getElementById("activeDateSelect").value;if(v){document.getElementById("productionDate").value=v;loadSelectedDate();}}
function populateDates(orders){const dates=[...new Set(orders.map(x=>x.pickup_date).filter(Boolean))].sort();document.getElementById("activeDateSelect").innerHTML=`<option value="">Upcoming order dates</option>${dates.map(x=>`<option value="${x}">${parseDate(x)?.toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"})||x}</option>`).join("")}`;}
async function refreshProduction(){await loadReferenceData();await loadSelectedDate();}

function convert(q,from,to){const a=Number(q||0),f=unit(from),t=unit(to);if(f===t)return a;if(MASS[f]&&MASS[t])return a*MASS[f]/MASS[t];if(VOLUME[f]&&VOLUME[t])return a*VOLUME[f]/VOLUME[t];if(COUNT.includes(f)&&COUNT.includes(t))return a;return null;}


function displayQty(quantity, unit) {

    return `${fmt(quantity)} ${esc(unit || "")}`.trim();

}


function unit(x){return String(x||"").trim().toLowerCase().replace(/\./g,"").replace(/\s+/g," ");}
function emptyPlan(){return{date:"",orders:[],products:[],batches:[],ingredientReq:[],packagingReq:[],combined:[],shortages:[],warnings:[],orderCount:0,itemCount:0,revenue:0,foodCost:0,packagingCost:0,totalCost:0,profit:0,margin:0,usdRevenue:null,usdProfit:null,usdMargin:0,rateAvailable:false,rateInfo:null};}
function loading(){["productionTotals","recipeBatches","productionCosts","ingredientRequirements","shoppingList","packagingRequirements","productionChecklist","productionTimeline","includedOrders"].forEach(id=>{const e=document.getElementById(id);if(e)e.innerHTML=empty("Loading...");});}
function fatal(x){document.getElementById("productionWarnings").innerHTML=`<div class="production-warning production-warning-error">Unable to load production: ${esc(x)}</div>`;}
function metric(a,b){return`<div class="production-metric"><span>${esc(a)}</span><strong>${esc(b)}</strong></div>`;}
function empty(x){return`<p class="production-empty">${esc(x)}</p>`;}
function euro(x){return new Intl.NumberFormat("de-DE",{style:"currency",currency:"EUR"}).format(Number(x||0));}
// BUG-23: revenue/cost/profit/margin projections report in USD; customer-
// facing order totals (renderOrders) stay EUR via euro() above.
function usd(x){return new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(Number(x||0));}
function fmt(x){return Number(x||0).toFixed(2).replace(/\.00$/,"").replace(/(\.\d)0$/,"$1");}
function selectedDate(){return document.getElementById("productionDate")?.value||"";}
function nextSunday(d){const x=new Date(d);x.setDate(x.getDate()+(7-x.getDay())%7);return x;}
function parseDate(v){if(!v)return null;const [y,m,d]=String(v).split("-").map(Number);return y&&m&&d?new Date(y,m-1,d):null;}
function dateValue(d){return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;}
function day(d){return d.toLocaleDateString("en-US",{weekday:"long",month:"short",day:"numeric"});}
function sortName(a,b){return a.name.localeCompare(b.name);}
function cap(x){x=String(x||"");return x?x[0].toUpperCase()+x.slice(1):"";}
function setText(id,x){const e=document.getElementById(id);if(e)e.textContent=x;}
function esc(x){return String(x??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");}
window.changeProductionDate=changeProductionDate;window.moveProductionDate=moveProductionDate;window.selectToday=selectToday;window.selectActiveDate=selectActiveDate;window.refreshProduction=refreshProduction;window.updateChecklistItem=updateChecklistItem;window.finishProduction=finishProduction;window.retryCurrentRate=retryCurrentRate;
