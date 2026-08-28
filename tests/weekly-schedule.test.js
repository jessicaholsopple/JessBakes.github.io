"use strict";

/* ==========================================
   Weekly Pickup Schedule (js/weekly-schedule.js)

   The pure JS twin of the authoritative Postgres algorithm (see
   supabase/migrations/20260828100000_weekly_pickup_schedule.sql --
   compute_weekly_pickup_from). Verified byte-for-byte identical to it
   for every case below via live, read-only Supabase calls during
   development (see the final report); this file locks the JS side down
   with node:test so the full clock-boundary matrix runs instantly,
   without needing a live database for every case.

   All instants below are given as UTC ISO strings equivalent to a
   specific Europe/Berlin wall-clock moment (CEST = UTC+2 in summer,
   CET = UTC+1 in winter) -- written out in each test's own comment so
   the intent is legible without doing the arithmetic in your head.
   ========================================== */

const test = require("node:test");
const assert = require("node:assert/strict");
const WeeklySchedule = require("../js/weekly-schedule.js");

const DEFAULT = {}; // computeNextPickup fills in DEFAULT_SCHEDULE when omitted

function pickup(isoUtc, schedule) {
    return WeeklySchedule.computeNextPickup(new Date(isoUtc), schedule || DEFAULT);
}

/* ==========================================
   Default rule (Sunday 12:30 PM pickup / Friday 5:00 PM cutoff / Europe/Berlin)
   ========================================== */

test("1. Thursday before cutoff -> immediately upcoming Sunday", () => {
    // Thu Aug 27 2026, 10:00 CEST
    const r = pickup("2026-08-27T08:00:00Z");
    assert.equal(r.pickupDate, "2026-08-30");
    assert.equal(r.pickupTime, "12:30:00");
});

test("2. Friday at 4:59:59 PM -> immediately upcoming Sunday", () => {
    // Fri Aug 28 2026, 16:59:59 CEST
    const r = pickup("2026-08-28T14:59:59Z");
    assert.equal(r.pickupDate, "2026-08-30");
});

test("3. Friday at exactly 5:00:00 PM -> Sunday one week later (cutoff is EXCLUSIVE)", () => {
    // Fri Aug 28 2026, 17:00:00 CEST -- the exact boundary instant
    const r = pickup("2026-08-28T15:00:00Z");
    assert.equal(r.pickupDate, "2026-09-06");
});

test("4. Friday after 5:00 PM -> Sunday one week later", () => {
    // Fri Aug 28 2026, 17:00:01 CEST
    const r = pickup("2026-08-28T15:00:01Z");
    assert.equal(r.pickupDate, "2026-09-06");
});

test("5. Saturday -> following Sunday", () => {
    // Sat Aug 29 2026, 09:00 CEST
    const r = pickup("2026-08-29T07:00:00Z");
    assert.equal(r.pickupDate, "2026-09-06");
});

test("6. Sunday before pickup time -> following Sunday, because Friday's cutoff already passed", () => {
    // Sun Aug 30 2026, 08:00 CEST (well before the 12:30 PM pickup that same day)
    const r = pickup("2026-08-30T06:00:00Z");
    assert.equal(r.pickupDate, "2026-09-06");
});

test("7. Sunday after pickup time -> following Sunday", () => {
    // Sun Aug 30 2026, 15:00 CEST
    const r = pickup("2026-08-30T13:00:00Z");
    assert.equal(r.pickupDate, "2026-09-06");
});

test("8. Month boundary", () => {
    // Thu Jan 29 2026, 10:00 CET -- upcoming Sunday crosses into February
    const r = pickup("2026-01-29T09:00:00Z");
    assert.equal(r.pickupDate, "2026-02-01");
});

test("9. Year boundary", () => {
    // Thu Dec 31 2026, 10:00 CET -- upcoming Sunday crosses into 2027
    const r = pickup("2026-12-31T09:00:00Z");
    assert.equal(r.pickupDate, "2027-01-03");
});

test("10. Leap year (Feb 29, 2028 exists and is handled by real date arithmetic)", () => {
    // Thu Feb 24 2028, 10:00 CET -- upcoming Sunday is Feb 27, 2028
    const r1 = pickup("2028-02-24T09:00:00Z");
    assert.equal(r1.pickupDate, "2028-02-27");
    // Fri Feb 25 2028, 17:00:01 CET (leap year, past cutoff) -> Mar 5 2028,
    // correctly stepping over Feb 29.
    const r2 = pickup("2028-02-25T16:00:01Z");
    assert.equal(r2.pickupDate, "2028-03-05");
});

test("11. Europe/Berlin daylight-saving START (clocks spring forward, last Sunday of March)", () => {
    // Fri Mar 27 2026, 16:59:59 CET (before cutoff, DST hasn't started yet)
    const before = pickup("2026-03-27T15:59:59Z");
    assert.equal(before.pickupDate, "2026-03-29"); // the DST-start Sunday itself

    // Fri Mar 27 2026, 17:00:01 CET (after cutoff)
    const after = pickup("2026-03-27T16:00:01Z");
    assert.equal(after.pickupDate, "2026-04-05");
});

test("12. Europe/Berlin daylight-saving END (clocks fall back, last Sunday of October)", () => {
    // Fri Oct 23 2026, 16:59:59 CEST (before cutoff)
    const before = pickup("2026-10-23T14:59:59Z");
    assert.equal(before.pickupDate, "2026-10-25"); // the DST-end Sunday itself

    // Fri Oct 23 2026, 17:00:01 CEST (after cutoff)
    const after = pickup("2026-10-23T15:00:01Z");
    assert.equal(after.pickupDate, "2026-11-01");
});

/* ==========================================
   Configurable behavior
   ========================================== */

test("13. changing the cutoff to Thursday 6:00 PM shifts the boundary correctly", () => {
    const schedule = { cutoffWeekday: 4, cutoffTime: "18:00:00" }; // Thursday 6pm
    // Thu Aug 27 2026, 17:59:59 CEST -- before the new cutoff
    const before = pickup("2026-08-27T15:59:59Z", schedule);
    assert.equal(before.pickupDate, "2026-08-30");
    // Thu Aug 27 2026, 18:00:00 CEST -- at the new cutoff, exclusive
    const at = pickup("2026-08-27T16:00:00Z", schedule);
    assert.equal(at.pickupDate, "2026-09-06");
});

test("14. changing the pickup time changes what's returned, not just displayed", () => {
    const schedule = { pickupTime: "14:00:00" };
    const r = pickup("2026-08-27T08:00:00Z", schedule);
    assert.equal(r.pickupTime, "14:00:00");
    assert.equal(r.pickupDate, "2026-08-30");
});

test("15. changing the pickup weekday to Saturday recalculates the whole rule", () => {
    const schedule = { pickupWeekday: 6, cutoffWeekday: 4, cutoffTime: "17:00:00" }; // Saturday pickup, Thursday cutoff
    // Wed Aug 26 2026, 10:00 CEST -- before Thursday's cutoff
    const before = pickup("2026-08-26T08:00:00Z", schedule);
    assert.equal(before.pickupDate, "2026-08-29"); // upcoming Saturday
    // Thu Aug 27 2026, 17:00:01 CEST -- after the new cutoff
    const after = pickup("2026-08-27T15:00:01Z", schedule);
    assert.equal(after.pickupDate, "2026-09-05"); // following Saturday
});

test("16. admin what-if preview (describeScheduleRule) updates wording for the new configuration", () => {
    const summary = WeeklySchedule.describeScheduleRule({ pickupWeekday: 6, pickupTime: "10:00:00", cutoffWeekday: 3, cutoffTime: "12:00:00" });
    assert.match(summary, /Orders submitted before Wednesday at 12:00 PM/);
    assert.match(summary, /upcoming Saturday at 10:00 AM/);
    assert.match(summary, /following Saturday/);
});

test("17. checkout explanation (describeScheduleRuleShort) reflects the default rule exactly as specified", () => {
    const summary = WeeklySchedule.describeScheduleRuleShort(WeeklySchedule.DEFAULT_SCHEDULE);
    assert.equal(
        summary,
        "Orders submitted before Friday at 5:00 PM are scheduled for the upcoming Sunday. Orders submitted at or after the cutoff are scheduled for the following Sunday."
    );
});

/* ==========================================
   Validation
   ========================================== */

test("18. valid default settings pass validation", () => {
    const result = WeeklySchedule.validateScheduleSettings({
        pickupWeekday: 0, pickupTime: "12:30", cutoffWeekday: 5, cutoffTime: "17:00", timezone: "Europe/Berlin"
    });
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
});

test("19. missing pickup day is rejected", () => {
    const result = WeeklySchedule.validateScheduleSettings({ pickupWeekday: null, pickupTime: "12:30", cutoffWeekday: 5, cutoffTime: "17:00" });
    assert.equal(result.valid, false);
    assert.match(result.errors.join(" "), /Pickup day/);
});

test("20. an out-of-range weekday (7) is rejected", () => {
    const result = WeeklySchedule.validateScheduleSettings({ pickupWeekday: 7, pickupTime: "12:30", cutoffWeekday: 5, cutoffTime: "17:00" });
    assert.equal(result.valid, false);
});

test("21. a malformed time string is rejected, not silently coerced", () => {
    const result = WeeklySchedule.validateScheduleSettings({ pickupWeekday: 0, pickupTime: "not-a-time", cutoffWeekday: 5, cutoffTime: "17:00" });
    assert.equal(result.valid, false);
    assert.match(result.errors.join(" "), /Pickup time/);
});

test("22. a timezone other than Europe/Berlin is rejected", () => {
    const result = WeeklySchedule.validateScheduleSettings({ pickupWeekday: 0, pickupTime: "12:30", cutoffWeekday: 5, cutoffTime: "17:00", timezone: "America/New_York" });
    assert.equal(result.valid, false);
    assert.match(result.errors.join(" "), /Europe\/Berlin/);
});

test("23. a cutoff that would land at or after its own pickup (same day, later time) is rejected as an unusable rule", () => {
    const result = WeeklySchedule.validateScheduleSettings({ pickupWeekday: 0, pickupTime: "12:30", cutoffWeekday: 0, cutoffTime: "15:00" });
    assert.equal(result.valid, false);
    assert.match(result.errors.join(" "), /cutoff must fall before its pickup/);
});

test("24. a same-day cutoff BEFORE the pickup time is a legitimate, valid configuration", () => {
    const result = WeeklySchedule.validateScheduleSettings({ pickupWeekday: 0, pickupTime: "12:30", cutoffWeekday: 0, cutoffTime: "09:00" });
    assert.equal(result.valid, true);
});

/* ==========================================
   Formatting helpers
   ========================================== */

test("25. weekdayName maps 0-6 to Sunday..Saturday", () => {
    assert.equal(WeeklySchedule.weekdayName(0), "Sunday");
    assert.equal(WeeklySchedule.weekdayName(5), "Friday");
    assert.equal(WeeklySchedule.weekdayName(6), "Saturday");
});

test("26. formatTime12h renders 24-hour times correctly, including midnight and noon", () => {
    assert.equal(WeeklySchedule.formatTime12h("17:00:00"), "5:00 PM");
    assert.equal(WeeklySchedule.formatTime12h("12:30:00"), "12:30 PM");
    assert.equal(WeeklySchedule.formatTime12h("00:00:00"), "12:00 AM");
    assert.equal(WeeklySchedule.formatTime12h("09:05:00"), "9:05 AM");
});

test("27. formatFullDate renders the exact concrete example from the spec", () => {
    assert.equal(WeeklySchedule.formatFullDate("2026-08-30"), "Sunday, August 30, 2026");
});

/* ==========================================
   Same flavor of case the concrete spec example gives, spelled out
   exactly as written in the request.
   ========================================== */

test("28. the exact three-point Friday boundary example from the spec, together", () => {
    assert.equal(pickup("2026-08-28T14:59:59Z").pickupDate, "2026-08-30"); // 4:59:59 PM
    assert.equal(pickup("2026-08-28T15:00:00Z").pickupDate, "2026-09-06"); // 5:00:00 PM
    assert.equal(pickup("2026-08-28T16:30:00Z").pickupDate, "2026-09-06"); // after 5 PM
});
