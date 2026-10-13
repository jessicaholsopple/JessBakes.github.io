/* ==========================================
   REVENUE DATE (shared, pure)
   ==========================================

   Europe/Berlin-timezone-correct date bucketing for revenue reporting
   (admin/dashboard.html, admin/sales.html, admin/analytics.html).
   Every place that groups a completed sale into "today", "this
   week", "this month", "this year", or a specific calendar day/month
   must go through here -- never a raw `new Date(...).getDate()` (the
   ADMIN'S BROWSER's local timezone, which can silently disagree with
   Berlin depending on device/location) and never a UTC
   `.toISOString().split("T")[0]` split (a third, different timezone).

   Built entirely on WeeklySchedule.getBerlinParts (js/weekly-schedule.js),
   which already does the DST-safe Intl.DateTimeFormat extraction this
   project establishes everywhere else -- the Berlin wall-clock math
   itself is NOT reimplemented here, only composed into day/week/month/
   year bucketing on top of it.

   Pure functions, no DOM/Supabase dependency -- runs unmodified in the
   browser (as a normal <script> tag, exposing `window.RevenueDate`) or
   under Node (via `require("./revenue-date.js")`), exactly like
   js/weekly-schedule.js itself.
   ========================================== */

(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory(require("./weekly-schedule.js"));
    } else {
        root.RevenueDate = factory(root.WeeklySchedule);
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function (WeeklySchedule) {
    "use strict";

    function pad2(n) {
        return String(n).padStart(2, "0");
    }

    function parts(value) {
        return WeeklySchedule.getBerlinParts(new Date(value));
    }

    /** "YYYY-MM-DD" for the given instant's Europe/Berlin calendar date
     *  -- the one grouping key every day-level bucket (today, daily
     *  chart points, CSV rows) should use. */
    function berlinDateKey(value) {
        const p = parts(value);
        return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
    }

    /** "YYYY-MM" for the given instant's Europe/Berlin calendar month. */
    function berlinMonthKey(value) {
        const p = parts(value);
        return `${p.year}-${pad2(p.month)}`;
    }

    function berlinYear(value) {
        return parts(value).year;
    }

    function isSameBerlinDay(valueA, valueB) {
        return berlinDateKey(valueA) === berlinDateKey(valueB);
    }

    function isSameBerlinMonth(valueA, valueB) {
        return berlinMonthKey(valueA) === berlinMonthKey(valueB);
    }

    function isSameBerlinYear(valueA, valueB) {
        return berlinYear(valueA) === berlinYear(valueB);
    }

    /** A pure day-number (days since the Unix epoch, as a Berlin
     *  calendar date) -- the stable integer week/day-window math below
     *  is built on, so DST transitions (which only ever shift
     *  wall-clock HOUR, never which calendar day a date falls on)
     *  never perturb it. */
    function berlinDayNumber(value) {
        const p = parts(value);
        return Math.floor(Date.UTC(p.year, p.month - 1, p.day) / 86400000);
    }

    /** Monday-start week (matching the pre-existing isThisWeek()
     *  convention this replaces in admin-dashboard.js/admin-sales.js),
     *  computed entirely from Berlin calendar-date integers -- correct
     *  even when a DST transition falls inside the week, since only
     *  whole calendar days are compared, never a raw millisecond
     *  range. WeeklySchedule.getBerlinParts().weekday is 0=Sunday.. */
    function isSameBerlinWeek(valueA, valueB) {
        const pA = parts(valueA);
        const pB = parts(valueB);

        const dayNumA = Math.floor(Date.UTC(pA.year, pA.month - 1, pA.day) / 86400000);
        const dayNumB = Math.floor(Date.UTC(pB.year, pB.month - 1, pB.day) / 86400000);

        const mondayOffsetA = (pA.weekday + 6) % 7;
        const mondayOffsetB = (pB.weekday + 6) % 7;

        return (dayNumA - mondayOffsetA) === (dayNumB - mondayOffsetB);
    }

    /** Berlin weekday name ("Sunday".."Saturday") for the given
     *  instant -- for "which weekday is your best sales day" style
     *  reporting, consistent with the same Berlin calendar date used
     *  everywhere else here. */
    function berlinWeekdayName(value) {
        return WeeklySchedule.WEEKDAY_NAMES[parts(value).weekday];
    }

    const MONTH_NAMES_SHORT = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
    ];

    const MONTH_NAMES_LONG = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
    ];

    /** Human-readable "Mon DD, YYYY" (or without year) rendered from
     *  the Berlin calendar date -- NOT the browser's local timezone --
     *  so a sale shown as belonging to a given day's revenue always
     *  displays that same day, even right around midnight. */
    function formatBerlinDate(value, { includeYear = true } = {}) {
        const p = parts(value);
        const month = MONTH_NAMES_SHORT[p.month - 1];
        return includeYear ? `${month} ${p.day}, ${p.year}` : `${month} ${p.day}`;
    }

    /** "Oct 2026" -- for chart-axis labels grouping by Berlin month. */
    function formatBerlinMonthLabel(value) {
        const p = parts(value);
        return `${MONTH_NAMES_SHORT[p.month - 1]} ${p.year}`;
    }

    /** "October 2026" -- for the Monthly Revenue table's long-form label. */
    function formatBerlinMonthLabelLong(value) {
        const p = parts(value);
        return `${MONTH_NAMES_LONG[p.month - 1]} ${p.year}`;
    }

    return {
        berlinDateKey,
        berlinMonthKey,
        berlinYear,
        berlinDayNumber,
        berlinWeekdayName,
        isSameBerlinDay,
        isSameBerlinWeek,
        isSameBerlinMonth,
        isSameBerlinYear,
        formatBerlinDate,
        formatBerlinMonthLabel,
        formatBerlinMonthLabelLong
    };
});
