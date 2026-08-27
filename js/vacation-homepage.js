/* ==========================================
   VACATION MODE -- homepage section
   ==========================================

   Populates the static #vacationSection shell already in index.html
   (heading/message/reopen-date/mount points), or hides it cleanly
   when no vacation is active. Deliberately does NOT duplicate the
   existing ballot renderer (js/ballot.js, its own <section
   class="ballot-section"> elsewhere on this same page) -- it only
   shows a small teaser + anchor link down to it when an active ballot
   exists, per "do not create a second ballot system."

   Also controls which of the normal marketing sections (hero,
   "Stay Updated," Current Favorites, the suggestion form, Community
   Favorites, the closing promo section -- everything tagged
   `.js-vacation-hide` in index.html) are visible: they start `hidden`
   directly in the HTML so neither the normal homepage nor the
   vacation homepage ever flashes the wrong one while this status
   check is in flight. If this script never resolves for any reason
   (a bug, a blocked/failed script load that still let this far,
   an unexpected hang), a short watchdog timeout reveals the normal
   homepage rather than leaving it blank forever -- see
   index.html's <noscript> block for the JS-disabled case, which this
   doesn't cover.
   ========================================== */

const VACATION_HOMEPAGE_WATCHDOG_MS = 4000;

document.addEventListener("DOMContentLoaded", () => {
    initVacationHomepageSection();
});

let vacationHomepageResolved = false;

function showNormalHomepage() {
    document.querySelectorAll(".js-vacation-hide").forEach(el => {
        el.hidden = false;
    });
    const section = document.getElementById("vacationSection");
    if (section) {
        section.hidden = true;
    }
}

async function initVacationHomepageSection() {
    // Failsafe: if something goes wrong and this never finishes, show
    // the normal homepage rather than leaving the marketing sections
    // hidden indefinitely.
    const watchdog = setTimeout(() => {
        if (!vacationHomepageResolved) {
            console.error("Vacation Mode status check did not resolve in time -- showing the normal homepage.");
            showNormalHomepage();
        }
    }, VACATION_HOMEPAGE_WATCHDOG_MS);

    const section = document.getElementById("vacationSection");
    const vacation = await fetchActiveVacationStatus();

    vacationHomepageResolved = true;
    clearTimeout(watchdog);

    if (!VacationMode.isVacationActive(vacation)) {
        showNormalHomepage();
        return;
    }

    // Active: marketing sections stay hidden (their default state);
    // reveal only the vacation section.
    renderVacationHomepageSection(vacation);
    if (section) {
        section.hidden = false;
    }

    const hasActiveBallot = await checkActiveBallotExists();
    toggleVacationBallotTeaser(hasActiveBallot);

    if (typeof mountSubscribeWidget === "function") {
        mountSubscribeWidget("vacationSubscribeMount", "vacation_homepage");
    }
}

async function fetchActiveVacationStatus() {
    const { data, error } = await supabaseClient
        .from("vacation_periods")
        .select("id, heading, message, reopen_at, next_pickup_at")
        .maybeSingle();

    if (error) {
        console.error(error);
        return null;
    }

    return data || null;
}

function renderVacationHomepageSection(vacation) {
    const heading = document.getElementById("vacationHeading");
    const message = document.getElementById("vacationMessage");
    const reopenDate = document.getElementById("vacationReopenDate");

    if (heading) {
        heading.textContent = vacation.heading || "We're on a baking break!";
    }
    if (message) {
        message.textContent = vacation.message || "";
        message.style.display = vacation.message ? "" : "none";
    }
    if (reopenDate) {
        const label = VacationMode.formatBakeryDateTime(vacation.reopen_at);
        reopenDate.textContent = label || "Coming soon — check back for an exact date!";
    }
}

async function checkActiveBallotExists() {
    const { data, error } = await supabaseClient
        .from("ballot_settings")
        .select("id")
        .eq("active", true)
        .limit(1)
        .maybeSingle();

    if (error) {
        console.error(error);
        return false;
    }

    return !!data;
}

function toggleVacationBallotTeaser(show) {
    const teaser = document.getElementById("vacationBallotTeaser");
    if (teaser) {
        teaser.hidden = !show;
    }
}
