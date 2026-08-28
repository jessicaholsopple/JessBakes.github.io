/* ==========================================
   WEEKLY PICKUP SCHEDULE (shared, pure)
   ==========================================

   Single canonical source of truth for weekly-pickup scheduling LOGIC
   shared by:

     - Admin Settings' live "if I saved this" preview (js/admin-settings.js)
       -- computed from the admin's own device clock, which is fine here:
       this is a cosmetic, non-authoritative preview for an authenticated
       admin, never what actually gets stored.
     - Formatting/wording helpers used by both js/admin-settings.js and
       js/cart.js (weekday names, 12-hour time, the "Orders submitted
       before X are scheduled for Y" explanation sentence).

   The AUTHORITATIVE calculation -- the one that actually decides what
   pickup_date/pickup_time a real order gets -- lives in Postgres
   (supabase/migrations/20260828100000_weekly_pickup_schedule.sql:
   compute_weekly_pickup_from/compute_weekly_pickup/preview_weekly_pickup),
   using the DATABASE clock, never the browser's. js/cart.js always asks
   the database for the real answer (via the preview_weekly_pickup RPC
   for a live preview, and implicitly via the enforce_weekly_pickup_schedule
   trigger at actual submission time) -- it never trusts this module's
   own computeNextPickup() as the final word for an order a customer is
   about to submit.

   computeNextPickup() below is still a byte-for-byte mirror of the SQL
   algorithm (same field names, same 0=Sunday..6=Saturday convention,
   same exclusive-cutoff rule, same DST-aware Europe/Berlin wall-clock
   extraction via Intl) -- hand-kept in sync with it, exactly like
   buildMenuSnapshotKey's browser/Deno pair elsewhere in this project.
   Keeping a pure, fast, Node-testable twin here is what lets the full
   battery of clock-boundary tests (Friday 4:59:59 vs 5:00:00, DST
   transitions, leap years, ...) run instantly with node:test instead of
   needing a live database for every case.

   This file has no dependency on the DOM or Supabase -- every function
   here takes plain data in and returns plain data out, so it can run
   unmodified in the browser (as a normal <script> tag, exposing
   `window.WeeklySchedule`) or under Node (via `require("./weekly-schedule.js")`).
   ========================================== */

(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.WeeklySchedule = factory();
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const TIMEZONE = "Europe/Berlin";

    const DEFAULT_SCHEDULE = {
        pickupWeekday: 0,      // Sunday
        pickupTime: "12:30:00",
        cutoffWeekday: 5,      // Friday
        cutoffTime: "17:00:00",
        timezone: TIMEZONE
    };

    const WEEKDAY_NAMES = [
        "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"
    ];

    function toNumber(value, fallback) {
        const n = Number(value);
        return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
    }

    /** Parses "HH:MM" or "HH:MM:SS" into {hour, minute, second}. Returns
     *  null for anything that isn't a valid 24-hour time. */
    function parseTime(value) {
        const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(value || "").trim());
        if (!match) return null;
        const hour = Number(match[1]);
        const minute = Number(match[2]);
        const second = match[3] !== undefined ? Number(match[3]) : 0;
        if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null;
        return { hour, minute, second };
    }

    function timeToSeconds(t) {
        return t.hour * 3600 + t.minute * 60 + t.second;
    }

    /** The wall-clock date/time in Europe/Berlin for a given instant,
     *  DST-correct via the environment's own IANA tzdata (the same
     *  mechanism js/vacation-mode.js's formatBakeryDateTime already
     *  relies on) -- never a raw UTC offset guess. */
    function getBerlinParts(date) {
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: TIMEZONE,
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit",
            hour12: false,
            weekday: "short"
        }).formatToParts(date);

        const get = (type) => parts.find(p => p.type === type)?.value;
        const weekdayShort = get("weekday");
        const weekdayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekdayShort);

        // Intl's hour12:false renders midnight as "24" in some engines --
        // normalize back to 0 so downstream arithmetic never sees an
        // out-of-range hour.
        const hour = Number(get("hour")) % 24;

        return {
            year: Number(get("year")),
            month: Number(get("month")),
            day: Number(get("day")),
            hour,
            minute: Number(get("minute")),
            second: Number(get("second")),
            weekday: weekdayIndex
        };
    }

    function makeUtcDateForBerlinMidnight(year, month, day) {
        // A UTC Date whose calendar date matches (year, month, day) --
        // used only as a neutral day-counter (date-only arithmetic),
        // never combined with a real time-of-day, so DST never enters
        // into it.
        return new Date(Date.UTC(year, month - 1, day));
    }

    function addDaysToDateOnly(dateOnlyUtc, days) {
        const d = new Date(dateOnlyUtc.getTime());
        d.setUTCDate(d.getUTCDate() + days);
        return d;
    }

    function formatDateOnly(dateOnlyUtc) {
        const y = dateOnlyUtc.getUTCFullYear();
        const m = String(dateOnlyUtc.getUTCMonth() + 1).padStart(2, "0");
        const d = String(dateOnlyUtc.getUTCDate()).padStart(2, "0");
        return `${y}-${m}-${d}`;
    }

    /**
     * The canonical algorithm (mirrors compute_weekly_pickup_from() in
     * supabase/migrations/20260828100000_weekly_pickup_schedule.sql
     * field for field): the earliest pickup-weekday occurrence (today
     * included, if today matches) whose associated cutoff -- the most
     * recent occurrence of cutoffWeekday+cutoffTime at or before that
     * pickup -- has not yet passed. Cutoff is EXCLUSIVE: at the exact
     * cutoff instant, that pickup is already closed.
     *
     * `now` is a JS Date representing the instant to evaluate from (NOT
     * necessarily the caller's own clock -- pass whatever instant is
     * appropriate; the browser call sites in this project only ever use
     * this for a cosmetic admin preview, never as the authoritative
     * answer for a real order).
     */
    function computeNextPickup(now, schedule) {
        const s = { ...DEFAULT_SCHEDULE, ...(schedule || {}) };
        const pickupTime = parseTime(s.pickupTime);
        const cutoffTime = parseTime(s.cutoffTime);
        const pickupWeekday = toNumber(s.pickupWeekday, 0);
        const cutoffWeekday = toNumber(s.cutoffWeekday, 5);

        if (!pickupTime || !cutoffTime || pickupWeekday < 0 || pickupWeekday > 6 || cutoffWeekday < 0 || cutoffWeekday > 6) {
            return null;
        }

        const berlinNow = getBerlinParts(now);
        const nowSeconds = timeToSeconds(berlinNow);
        const todayUtc = makeUtcDateForBerlinMidnight(berlinNow.year, berlinNow.month, berlinNow.day);

        const daysUntilPickup = ((pickupWeekday - berlinNow.weekday) + 7) % 7;
        let candidateDate = addDaysToDateOnly(todayUtc, daysUntilPickup);

        const daysBeforePickup = ((pickupWeekday - cutoffWeekday) + 7) % 7;
        const cutoffSeconds = timeToSeconds(cutoffTime);

        for (let i = 0; i < 4; i++) {
            const cutoffDate = addDaysToDateOnly(candidateDate, -daysBeforePickup);
            const cutoffDayDiff = Math.round((cutoffDate.getTime() - todayUtc.getTime()) / 86400000);

            // now < cutoff instant?  Compare by (days from today, seconds
            // within day) so we never need a second timezone conversion.
            const nowIsBeforeCutoff =
                cutoffDayDiff > 0 ||
                (cutoffDayDiff === 0 && nowSeconds < cutoffSeconds);

            if (nowIsBeforeCutoff) {
                return {
                    pickupDate: formatDateOnly(candidateDate),
                    pickupTime: s.pickupTime.length === 5 ? s.pickupTime + ":00" : s.pickupTime,
                    cutoffDate: formatDateOnly(cutoffDate),
                    cutoffTime: s.cutoffTime.length === 5 ? s.cutoffTime + ":00" : s.cutoffTime
                };
            }

            candidateDate = addDaysToDateOnly(candidateDate, 7);
        }

        // Unreachable given the loop bound, but never return nothing.
        return {
            pickupDate: formatDateOnly(candidateDate),
            pickupTime: s.pickupTime.length === 5 ? s.pickupTime + ":00" : s.pickupTime,
            cutoffDate: formatDateOnly(addDaysToDateOnly(candidateDate, -daysBeforePickup)),
            cutoffTime: s.cutoffTime.length === 5 ? s.cutoffTime + ":00" : s.cutoffTime
        };
    }

    function weekdayName(weekday) {
        return WEEKDAY_NAMES[toNumber(weekday, 0)] || "";
    }

    /** "17:00:00" / "17:00" -> "5:00 PM". Returns "" for anything invalid. */
    function formatTime12h(value) {
        const t = parseTime(value);
        if (!t) return "";
        const period = t.hour >= 12 ? "PM" : "AM";
        const hour12 = t.hour % 12 === 0 ? 12 : t.hour % 12;
        return `${hour12}:${String(t.minute).padStart(2, "0")} ${period}`;
    }

    /** "YYYY-MM-DD" -> "Sunday, August 30, 2026" (no timezone conversion
     *  -- a plain calendar date is formatted as itself, exactly like
     *  every other date-only field in this project). */
    function formatFullDate(isoDate) {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ""));
        if (!match) return "";
        const d = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
        return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    }

    /**
     * The one explanation sentence used verbatim by both the checkout
     * page and Admin Settings' rule summary -- generated purely from the
     * configured fields, never hardcoded Monday-Thursday/Friday-Sunday
     * copy. Updates automatically whenever pickup/cutoff day or time
     * changes.
     */
    function describeScheduleRule(schedule) {
        const s = { ...DEFAULT_SCHEDULE, ...(schedule || {}) };
        const pickupDay = weekdayName(s.pickupWeekday);
        const cutoffDay = weekdayName(s.cutoffWeekday);
        const cutoffTimeLabel = formatTime12h(s.cutoffTime);
        const pickupTimeLabel = formatTime12h(s.pickupTime);

        return `Orders submitted before ${cutoffDay} at ${cutoffTimeLabel} are scheduled for the upcoming ${pickupDay} at ${pickupTimeLabel}. Orders submitted at or after the cutoff are scheduled for the following ${pickupDay}.`;
    }

    /** Short form for checkout copy (no explicit pickup time repeated --
     *  the "Your Pickup" card already shows it on its own line). */
    function describeScheduleRuleShort(schedule) {
        const s = { ...DEFAULT_SCHEDULE, ...(schedule || {}) };
        const pickupDay = weekdayName(s.pickupWeekday);
        const cutoffDay = weekdayName(s.cutoffWeekday);
        const cutoffTimeLabel = formatTime12h(s.cutoffTime);

        return `Orders submitted before ${cutoffDay} at ${cutoffTimeLabel} are scheduled for the upcoming ${pickupDay}. Orders submitted at or after the cutoff are scheduled for the following ${pickupDay}.`;
    }

    /**
     * Validates a candidate schedule configuration. Returns
     * {valid, errors: string[]}. Never silently accepts a malformed
     * time, a missing/out-of-range day, or a cutoff that would occur at
     * or after its own pickup within the same weekly cycle (a cutoff
     * that can never actually gate anything is not a usable rule).
     */
    function validateScheduleSettings(input) {
        const errors = [];
        const s = input || {};

        // Number(null) is 0 and Number("") is also 0 -- both would
        // silently pass as "Sunday" if coerced first, hiding a genuinely
        // missing selection. Check for that explicitly before coercing.
        const pickupWeekdayMissing = s.pickupWeekday === null || s.pickupWeekday === undefined || s.pickupWeekday === "";
        const cutoffWeekdayMissing = s.cutoffWeekday === null || s.cutoffWeekday === undefined || s.cutoffWeekday === "";

        const pickupWeekday = Number(s.pickupWeekday);
        const cutoffWeekday = Number(s.cutoffWeekday);

        if (pickupWeekdayMissing || !Number.isInteger(pickupWeekday) || pickupWeekday < 0 || pickupWeekday > 6) {
            errors.push("Pickup day must be selected.");
        }

        if (cutoffWeekdayMissing || !Number.isInteger(cutoffWeekday) || cutoffWeekday < 0 || cutoffWeekday > 6) {
            errors.push("Cutoff day must be selected.");
        }

        const pickupTime = parseTime(s.pickupTime);
        if (!pickupTime) {
            errors.push("Pickup time must be a valid time.");
        }

        const cutoffTime = parseTime(s.cutoffTime);
        if (!cutoffTime) {
            errors.push("Cutoff time must be a valid time.");
        }

        if (s.timezone !== undefined && s.timezone !== TIMEZONE) {
            errors.push(`Timezone must be ${TIMEZONE}.`);
        }

        if (
            Number.isInteger(pickupWeekday) && pickupWeekday >= 0 && pickupWeekday <= 6 &&
            Number.isInteger(cutoffWeekday) && cutoffWeekday >= 0 && cutoffWeekday <= 6 &&
            pickupTime && cutoffTime
        ) {
            const daysBeforePickup = ((pickupWeekday - cutoffWeekday) + 7) % 7;
            const usable = daysBeforePickup > 0 || (daysBeforePickup === 0 && timeToSeconds(cutoffTime) < timeToSeconds(pickupTime));
            if (!usable) {
                errors.push("The cutoff must fall before its pickup -- right now it would occur at or after the pickup it's supposed to gate, which can never close a pickup in time.");
            }
        }

        return { valid: errors.length === 0, errors };
    }

    return {
        TIMEZONE,
        DEFAULT_SCHEDULE,
        WEEKDAY_NAMES,
        parseTime,
        getBerlinParts,
        computeNextPickup,
        weekdayName,
        formatTime12h,
        formatFullDate,
        describeScheduleRule,
        describeScheduleRuleShort,
        validateScheduleSettings
    };
});
