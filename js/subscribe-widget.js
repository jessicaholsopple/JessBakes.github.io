/* ==========================================
   SUBSCRIBE WIDGET (reusable, Vacation Mode)
   ==========================================

   The signup component shown on both the homepage vacation section
   and the Menu page's vacation notice (js/vacation-homepage.js and
   js/menu.js). NOT the same as the original single-category
   newsletter form on index.html's hero (js/newsletter.js) -- that one
   is left exactly as it was working before. This widget offers the
   three explicit preference categories and is mounted imperatively
   (mountSubscribeWidget), not self-initializing on DOMContentLoaded,
   since it only appears while Vacation Mode is active.

   Always goes through the newsletter-subscribe Edge Function -- never
   a direct table write -- so honeypot/rate-limit/validation/consent
   recording stay server-enforced no matter what the browser sends.
   ========================================== */

const SUBSCRIBE_WIDGET_IDS = {
    form: "vacationSubscribeForm",
    email: "vacationSubscribeEmail",
    reopening: "vacationSubscribePrefReopening",
    menu: "vacationSubscribePrefMenu",
    updates: "vacationSubscribePrefUpdates",
    honeypot: "vacationSubscribeWebsite",
    message: "vacationSubscribeMessage",
    submit: "vacationSubscribeSubmit"
};

function renderSubscribeWidgetHtml() {
    const ids = SUBSCRIBE_WIDGET_IDS;
    return `
        <form id="${ids.form}" class="subscribe-widget" novalidate>
            <div class="subscribe-widget-honeypot" aria-hidden="true">
                <label for="${ids.honeypot}">Website</label>
                <input type="text" id="${ids.honeypot}" name="website" tabindex="-1" autocomplete="off">
            </div>

            <div class="form-group">
                <label for="${ids.email}">Email address</label>
                <input type="email" id="${ids.email}" name="email" required autocomplete="email" placeholder="you@example.com">
            </div>

            <fieldset class="subscribe-widget-prefs">
                <legend>What would you like to receive?</legend>
                <label class="subscribe-widget-option">
                    <input type="checkbox" id="${ids.reopening}" name="reopeningAlerts">
                    Notify me when ordering reopens
                </label>
                <label class="subscribe-widget-option">
                    <input type="checkbox" id="${ids.menu}" name="menuAnnouncements">
                    Send me new menu announcements
                </label>
                <label class="subscribe-widget-option">
                    <input type="checkbox" id="${ids.updates}" name="generalUpdates">
                    Send me other Jess Bakes updates
                </label>
            </fieldset>

            <button type="submit" id="${ids.submit}" class="primary-btn">Sign Up</button>
            <p id="${ids.message}" class="subscribe-widget-message" role="status"></p>
        </form>
    `;
}

/** Mounts the widget into `document.getElementById(containerId)` and
 *  wires its submit handler. `source` is recorded server-side as the
 *  consent source (e.g. "vacation_homepage" / "vacation_menu"). A
 *  missing container is a silent no-op, same convention as
 *  js/newsletter.js's `if (newsletterForm) {...}` guard. */
function mountSubscribeWidget(containerId, source) {
    const container = document.getElementById(containerId);
    if (!container) {
        return;
    }

    container.innerHTML = renderSubscribeWidgetHtml();

    const ids = SUBSCRIBE_WIDGET_IDS;
    const form = document.getElementById(ids.form);
    if (!form) {
        return;
    }

    form.addEventListener("submit", (event) => submitSubscribeWidget(event, source));
}

function readSubscribeWidgetPreferences() {
    const ids = SUBSCRIBE_WIDGET_IDS;
    return {
        reopeningAlerts: document.getElementById(ids.reopening)?.checked === true,
        menuAnnouncements: document.getElementById(ids.menu)?.checked === true,
        generalUpdates: document.getElementById(ids.updates)?.checked === true
    };
}

function hasAnySubscribeWidgetPreference(preferences) {
    return !!(preferences && (preferences.reopeningAlerts || preferences.menuAnnouncements || preferences.generalUpdates));
}

function subscribeWidgetResultMessage(data) {
    if (!data || !data.ok) {
        if (data && data.reason === "rate_limited") {
            return "Please wait a moment before trying again.";
        }
        return "Please enter a valid email address.";
    }

    if (!data.alreadySubscribed) {
        return "Thanks for subscribing! Check your inbox for a confirmation.";
    }

    return data.preferencesUpdated
        ? "Preferences updated!"
        : "You're already subscribed with these preferences.";
}

async function submitSubscribeWidget(event, source) {
    event.preventDefault();

    const ids = SUBSCRIBE_WIDGET_IDS;
    const form = document.getElementById(ids.form);
    const submitButton = document.getElementById(ids.submit);
    const message = document.getElementById(ids.message);

    const email = (document.getElementById(ids.email)?.value || "").trim().toLowerCase();
    const honeypot = document.getElementById(ids.honeypot)?.value || "";
    const preferences = readSubscribeWidgetPreferences();

    if (!hasAnySubscribeWidgetPreference(preferences)) {
        if (message) {
            message.textContent = "Please choose at least one option.";
        }
        return;
    }

    if (submitButton) {
        submitButton.disabled = true;
    }
    if (message) {
        message.textContent = "";
    }

    try {
        const { data, error } = await supabaseClient.functions.invoke("newsletter-subscribe", {
            body: { email, honeypot, preferences, source }
        });

        if (error) {
            if (message) {
                message.textContent = "Something went wrong. Please try again in a moment.";
            }
            return;
        }

        if (message) {
            message.textContent = subscribeWidgetResultMessage(data);
        }

        if (data && data.ok) {
            form.reset();
        }
    } finally {
        if (submitButton) {
            submitButton.disabled = false;
        }
    }
}
