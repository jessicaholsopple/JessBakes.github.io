/* ==========================================
   PROMOTION BANNER (shared)

   The public "you qualify for X" notice, shared between the homepage
   (index.html, via js/homepage-promotion.js) and the menu page
   (menu.html, orchestrated directly by js/menu.js's loadMenu() since
   it also needs the same active-promotions list for cart/checkout
   eligibility). Pulled into its own file -- rather than left inside
   cart.js/menu.js -- specifically so the homepage can show it without
   loading all of cart.js (checkout/session-cart logic it has no use
   for).

   Self-contained escaping (doesn't assume js/cart.js's escapeHtml is
   on the page -- it isn't, on the homepage) and no dependency on any
   particular page structure beyond a <main id="main-content"> to
   insert into, so the exact same two functions work unmodified on
   both pages.
   ========================================== */

function promotionBannerEscapeHtml(text) {
    return String(text == null ? "" : text)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

/** Fetches every currently-active automatic promotion, joined with
 *  its reward items, from the public-safe views (see
 *  supabase/migrations/20261118100000_promotions_schema.sql) --
 *  shaped exactly as js/promotions-shared.js expects. Fails open to
 *  an empty list -- a promotions-fetch failure must never block the
 *  homepage, menu, or checkout from working. */
async function fetchActivePromotionsFromServer() {
    if (typeof supabaseClient === "undefined") return [];

    try {
        const [promoResult, rewardResult] = await Promise.all([
            supabaseClient.from("public_active_promotions").select("*"),
            supabaseClient.from("public_active_promotion_reward_items").select("promotion_id, menu_item_id, sort_order")
        ]);

        if (promoResult.error || !promoResult.data) return [];

        const rewardsByPromotion = {};
        (rewardResult.data || []).forEach(r => {
            if (!rewardsByPromotion[r.promotion_id]) rewardsByPromotion[r.promotion_id] = [];
            rewardsByPromotion[r.promotion_id].push({ menu_item_id: r.menu_item_id, sort_order: r.sort_order });
        });

        return promoResult.data.map(p => ({
            ...p,
            rewardItems: rewardsByPromotion[p.id] || []
        }));
    } catch (err) {
        console.error(err);
        return [];
    }
}

/** Tasteful but eye-catching notice for whatever automatic
 *  promotion(s) are active right now -- never a popup/modal, never
 *  blocking, always a normal part of the page's own flow.
 *  Auto-appears/disappears purely because activePromotions is already
 *  scoped to "enabled, automatic, within schedule" by the
 *  public_active_promotions view itself -- this function does no
 *  additional date math of its own. Shows only the highest-priority
 *  promotion if more than one is active, to stay uncluttered.
 *
 *  Reuses an existing #promotionBanner element if the page already
 *  has one; otherwise creates it as the first thing inside
 *  <main id="main-content"> -- works identically on index.html and
 *  menu.html without either page needing its own insertion logic. */
function renderPromotionBanner(activePromotions) {
    let banner = document.getElementById("promotionBanner");

    const promo = (activePromotions || [])
        .slice()
        .sort((a, b) => Number(a.priority || 100) - Number(b.priority || 100))[0];

    if (!promo) {
        // Hidden rather than removed from the DOM -- simpler, and
        // avoids depending on Element.remove()/parentNode existing in
        // every environment this function might run in.
        if (banner) {
            banner.innerHTML = "";
            banner.style.display = "none";
        }
        return;
    }

    if (!banner) {
        banner = document.createElement("div");
        banner.id = "promotionBanner";
        banner.className = "promo-banner";
        const main = document.getElementById("main-content");
        if (!main) return;
        main.insertBefore(banner, main.firstChild);
    }

    banner.style.display = "flex";

    banner.innerHTML = `
        <span class="promo-banner-icon" aria-hidden="true">🍪</span>
        <span class="promo-banner-text">
            <strong>${promotionBannerEscapeHtml(promo.customer_title || "")}</strong>
            <p>${promotionBannerEscapeHtml(promo.customer_description || "")}</p>
        </span>
    `;
}
