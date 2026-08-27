/* ==========================================
   VACATION MODE (shared, pure)
   ==========================================

   Single canonical source of truth for Vacation Mode logic that has
   no business living in the DOM or Supabase layer, shared by:

     - js/cart.js            (order-submission guard)
     - js/menu.js             (public Menu vacation notice)
     - js/vacation-homepage.js (homepage vacation section)
     - js/admin-vacation.js   (admin Settings vacation panel)

   `isRecipientEligible` mirrors the SQL function
   `public.vacation_eligible_subscribers(p_cycle_id)` (see
   supabase/migrations/20260827094500_vacation_eligible_subscribers_fn.sql)
   field-for-field. The SQL function is the authoritative source for
   actual sending; this is a client-side mirror used only for display
   estimates (e.g. an admin toggling a preference in the UI before
   saving) and must be kept in sync with it by hand if that rule ever
   changes.

   `buildMenuSnapshotKey` is used both to detect "the reopening-email
   preview is stale because the menu changed since it was generated"
   and, at send time, to build the actual menu content of the email --
   it deliberately only includes items that would actually appear
   (available === true), so an unrelated change to an unavailable/
   archived item never falsely marks a preview stale.

   This file has no dependency on the DOM or Supabase -- every function
   here takes plain data in and returns plain data out, so it can run
   unmodified in the browser (as a normal <script> tag, exposing
   `window.VacationMode`) or under Node (via `require("./vacation-mode.js")`).
   ========================================== */

(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.VacationMode = factory();
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    function toNumber(value, fallback) {
        const n = Number(value);
        return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
    }

    function isNonEmptyString(value) {
        return typeof value === "string" && value.trim().length > 0;
    }

    /** True while a vacation cycle is active. `statusRow` is whatever
     *  a `.maybeSingle()` query against the public vacation_periods
     *  columns (`id, heading, message, reopen_at, next_pickup_at`) --
     *  or the admin's full-row query -- resolved to. null/undefined
     *  means no active cycle. */
    function isVacationActive(statusRow) {
        return !!(statusRow && statusRow.id);
    }

    /**
     * Canonical, order-independent snapshot key for "the menu as it
     * would appear in the reopening email right now." Only items that
     * would actually be included (available === true) participate, so
     * archived/unavailable-item churn never falsely invalidates a
     * generated preview.
     */
    function buildMenuSnapshotKey(menuItems) {
        const rows = (menuItems || [])
            .filter(item => item && item.available === true)
            .map(item => ({
                id: String(item.id),
                name: item.name || "",
                price: toNumber(item.price, 0),
                description: item.description || "",
                product_type: item.product_type || "standard",
                builder_size: item.builder_size == null ? null : Number(item.builder_size)
            }))
            .sort((a, b) => a.id.localeCompare(b.id));

        return JSON.stringify(rows);
    }

    const DEFAULT_RECIPIENT_CATEGORIES = {
        reopeningAlerts: true,
        menuAnnouncements: true,
        generalUpdates: false
    };

    /**
     * Mirrors public.vacation_eligible_subscribers(p_cycle_id) exactly,
     * including its per-cycle category gating (the `categories` param
     * mirrors that cycle's recipients_reopening_alerts /
     * recipients_menu_announcements / recipients_general_updates
     * columns -- omit it to get the same default set the SQL function
     * assumes when none is given: reopening alerts + menu
     * announcements, never general-updates-only):
     *   status = 'active'
     *   AND ( (menuAnnouncements category AND pref_menu_announcements)
     *         OR (reopeningAlerts category AND pref_reopening_alerts
     *             AND fulfilled cycle != this one)
     *         OR (generalUpdates category AND pref_general_updates) )
     */
    function isRecipientEligible(subscriber, cycleId, categories) {
        const cats = categories || DEFAULT_RECIPIENT_CATEGORIES;

        if (!subscriber || subscriber.status !== "active") {
            return false;
        }

        if (cats.menuAnnouncements && subscriber.pref_menu_announcements === true) {
            return true;
        }

        if (
            cats.reopeningAlerts &&
            subscriber.pref_reopening_alerts === true &&
            subscriber.reopening_alert_fulfilled_cycle_id !== cycleId
        ) {
            return true;
        }

        return !!(cats.generalUpdates && subscriber.pref_general_updates === true);
    }

    /** Human-readable labels for whichever recipient categories a
     *  cycle is configured to include -- used by the admin panel's
     *  "who's this going to" summary. */
    function describeRecipientCategories(cycle) {
        const labels = [];
        if (cycle && cycle.recipients_reopening_alerts) {
            labels.push("Reopening alerts");
        }
        if (cycle && cycle.recipients_menu_announcements) {
            labels.push("Menu announcements");
        }
        if (cycle && cycle.recipients_general_updates) {
            labels.push("General updates");
        }
        return labels;
    }

    /**
     * The full "is the reopening campaign Ready" gate -- used both to
     * render the admin's readiness badge/reasons list and to decide
     * whether the "Automatically send..." toggle may be turned on.
     * Every reason string is written to be shown directly to the admin.
     *
     * Deliberately does NOT check the pickup date -- the reopening
     * email never mentions pickup at all (reopening date and pickup
     * date are separate concepts), and the reopening SCHEDULE itself
     * is governed by `reopen_at` elsewhere (vacation-scheduler only
     * fires once that has passed), not by this readiness gate.
     */
    function computeReadiness(input) {
        const {
            reopeningEmailEnabled,
            subject,
            previewMenuSnapshotKey,
            currentMenuSnapshotKey,
            availableMenuCount,
            eligibleRecipientCount
        } = input || {};

        const reasons = [];

        if (!reopeningEmailEnabled) {
            reasons.push("Reopening email is turned off for this vacation.");
        }

        if (!isNonEmptyString(subject)) {
            reasons.push("Email subject is required.");
        }

        if (toNumber(availableMenuCount, 0) < 1) {
            reasons.push("Publish at least one available menu item.");
        }

        if (!previewMenuSnapshotKey || previewMenuSnapshotKey !== currentMenuSnapshotKey) {
            reasons.push("Preview is missing or outdated -- refresh the preview.");
        }

        if (toNumber(eligibleRecipientCount, 0) < 1) {
            reasons.push("No eligible recipients yet.");
        }

        return { ready: reasons.length === 0, reasons };
    }

    /**
     * Formats an ISO timestamp for public/admin display in the
     * bakery's own local time (Europe/Berlin -- the same timezone
     * `email_settings.weekly_timezone` defaults to; pickup happens at
     * one physical location, so this is deliberately NOT the
     * visitor's device timezone). Returns "" for a missing/invalid
     * date rather than "Invalid Date".
     */
    function formatBakeryDateTime(iso) {
        if (!iso) {
            return "";
        }
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) {
            return "";
        }
        return new Intl.DateTimeFormat("en-US", {
            timeZone: "Europe/Berlin",
            weekday: "long",
            month: "long",
            day: "numeric",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit"
        }).format(date);
    }

    return {
        isVacationActive,
        buildMenuSnapshotKey,
        isRecipientEligible,
        describeRecipientCategories,
        computeReadiness,
        formatBakeryDateTime
    };
});
