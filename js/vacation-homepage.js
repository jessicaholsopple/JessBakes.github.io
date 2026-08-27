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
   ========================================== */

document.addEventListener("DOMContentLoaded", () => {
    initVacationHomepageSection();
});

async function initVacationHomepageSection() {
    const section = document.getElementById("vacationSection");
    if (!section) {
        return;
    }

    const vacation = await fetchActiveVacationStatus();

    if (!VacationMode.isVacationActive(vacation)) {
        section.hidden = true;
        return;
    }

    renderVacationHomepageSection(vacation);
    section.hidden = false;

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
