/* ==========================================
   HOMEPAGE PROMOTION BANNER

   Thin orchestrator for the homepage: fetches active promotions and
   renders the shared banner (js/promotion-banner.js). The homepage
   has no cart/checkout, so unlike menu.js it never needs the
   activePromotions list for anything beyond this one render call.
   ========================================== */

document.addEventListener("DOMContentLoaded", async () => {
    if (typeof fetchActivePromotionsFromServer !== "function" || typeof renderPromotionBanner !== "function") {
        return;
    }

    // Never advertise a spend-and-earn offer while ordering itself is
    // paused -- reuses the same vacation check js/vacation-homepage.js
    // already runs (fetchActiveVacationStatus()/VacationMode.isVacationActive(),
    // both loaded before this file), rather than a second implementation.
    if (typeof fetchActiveVacationStatus === "function" && typeof VacationMode !== "undefined") {
        const vacation = await fetchActiveVacationStatus();
        if (VacationMode.isVacationActive(vacation)) return;
    }

    const activePromotions = await fetchActivePromotionsFromServer();
    renderPromotionBanner(activePromotions);
});
