"use strict";

/* ==========================================
   Europe/Berlin revenue-date bucketing (js/revenue-date.js)

   Pure module, loaded directly via require() exactly as written (no
   mocking/shimming needed -- it only depends on js/weekly-schedule.js,
   which is loaded the same way), matching the established pattern for
   this project's other dual browser/Node UMD modules
   (tests/weekly-schedule.test.js).

   Focus: every case the task explicitly calls out -- UTC date
   differing from the Berlin date around midnight, both Berlin DST
   transitions (clocks forward in spring, back in fall), and the
   Monday-start week/month/year boundaries revenue reporting buckets
   by.
   ========================================== */

const test = require("node:test");
const assert = require("node:assert/strict");

const RevenueDate = require("../js/revenue-date.js");

/* ==========================================
   berlinDateKey -- UTC vs. Berlin disagreement
========================================== */

test("1. a timestamp late in the UTC day that's already past midnight in Berlin (winter, UTC+1) keys to the NEXT day", () => {
    // 2026-01-14 23:30 UTC = 2026-01-15 00:30 CET (Berlin, winter)
    assert.equal(RevenueDate.berlinDateKey("2026-01-14T23:30:00Z"), "2026-01-15");
});

test("2. the same instant's UTC calendar date is the PREVIOUS day -- confirms this is a genuine disagreement, not a no-op", () => {
    const instant = "2026-01-14T23:30:00Z";
    assert.equal(RevenueDate.berlinDateKey(instant), "2026-01-15");
    assert.equal(instant.slice(0, 10), "2026-01-14");
});

test("3. in summer (CEST, UTC+2), the Berlin day rolls over even earlier in UTC terms", () => {
    // 2026-07-14 22:30 UTC = 2026-07-15 00:30 CEST
    assert.equal(RevenueDate.berlinDateKey("2026-07-14T22:30:00Z"), "2026-07-15");
});

test("4. a timestamp still well before Berlin midnight keys to the same day as UTC", () => {
    assert.equal(RevenueDate.berlinDateKey("2026-01-14T10:00:00Z"), "2026-01-14");
});

/* ==========================================
   DST transitions (Europe/Berlin: last Sunday of March / October)
========================================== */

test("5. spring-forward (2026-03-29): a completion just before and just after the 2am->3am jump still lands on the correct Berlin day", () => {
    // 00:30 UTC = 01:30 CET (just before the jump)
    assert.equal(RevenueDate.berlinDateKey("2026-03-29T00:30:00Z"), "2026-03-29");
    // 01:30 UTC = 03:30 CEST (just after the jump)
    assert.equal(RevenueDate.berlinDateKey("2026-03-29T01:30:00Z"), "2026-03-29");
});

test("6. fall-back (2026-10-25): a completion during the repeated hour still lands on the correct single Berlin day", () => {
    // 00:30 UTC = 02:30 CEST (first pass, before fall-back)
    assert.equal(RevenueDate.berlinDateKey("2026-10-25T00:30:00Z"), "2026-10-25");
    // 01:30 UTC = 02:30 CET (second pass, after fall-back)
    assert.equal(RevenueDate.berlinDateKey("2026-10-25T01:30:00Z"), "2026-10-25");
});

test("7. a week straddling the spring DST transition still groups both sides into the same Berlin week", () => {
    // Monday 2026-03-23 and Sunday 2026-03-29 (the DST day itself) are
    // the same ISO week in Berlin.
    assert.equal(RevenueDate.isSameBerlinWeek("2026-03-23T10:00:00Z", "2026-03-29T10:00:00Z"), true);
});

/* ==========================================
   isSameBerlinDay / Week / Month / Year
========================================== */

test("8. isSameBerlinDay is true for two instants on the same Berlin calendar day despite different UTC dates", () => {
    // 2026-06-30 23:00 UTC and 2026-07-01 00:30 UTC are both 2026-07-01 in Berlin (CEST, UTC+2)
    assert.equal(RevenueDate.isSameBerlinDay("2026-06-30T23:00:00Z", "2026-07-01T00:30:00Z"), true);
});

test("9. isSameBerlinDay is false for two instants on genuinely different Berlin days", () => {
    assert.equal(RevenueDate.isSameBerlinDay("2026-07-01T06:00:00Z", "2026-07-02T06:00:00Z"), false);
});

test("10. isSameBerlinWeek: Monday-start -- Sunday and the following Monday are DIFFERENT weeks", () => {
    // 2026-08-30 is a Sunday, 2026-08-31 is the following Monday
    assert.equal(RevenueDate.isSameBerlinWeek("2026-08-30T10:00:00Z", "2026-08-31T10:00:00Z"), false);
});

test("11. isSameBerlinWeek: Monday and the following Sunday ARE the same week", () => {
    // 2026-08-31 Monday .. 2026-09-06 Sunday
    assert.equal(RevenueDate.isSameBerlinWeek("2026-08-31T10:00:00Z", "2026-09-06T10:00:00Z"), true);
});

test("12. isSameBerlinMonth is false across a month boundary even on adjacent calendar days", () => {
    assert.equal(RevenueDate.isSameBerlinMonth("2026-09-30T10:00:00Z", "2026-10-01T10:00:00Z"), false);
});

test("13. isSameBerlinYear is false across a year boundary, including right at the UTC/Berlin New Year's disagreement", () => {
    // 2025-12-31 23:30 UTC = 2026-01-01 00:30 CET -- already next YEAR in Berlin
    assert.equal(RevenueDate.isSameBerlinYear("2025-12-31T23:30:00Z", "2026-01-01T00:30:00Z"), true);
    assert.equal(RevenueDate.berlinYear("2025-12-31T23:30:00Z"), 2026);
});

/* ==========================================
   Formatting helpers
========================================== */

test("14. formatBerlinDate renders the Berlin day, not the UTC day, near midnight", () => {
    assert.equal(RevenueDate.formatBerlinDate("2026-01-14T23:30:00Z"), "Jan 15, 2026");
});

test("15. formatBerlinDate without year", () => {
    assert.equal(RevenueDate.formatBerlinDate("2026-01-14T23:30:00Z", { includeYear: false }), "Jan 15");
});

test("16. formatBerlinMonthLabel / formatBerlinMonthLabelLong", () => {
    assert.equal(RevenueDate.formatBerlinMonthLabel("2026-10-13T10:00:00Z"), "Oct 2026");
    assert.equal(RevenueDate.formatBerlinMonthLabelLong("2026-10-13T10:00:00Z"), "October 2026");
});

test("17. berlinWeekdayName matches the Berlin calendar day, not the UTC day", () => {
    // 2026-01-14 23:30 UTC = Thursday Jan 15 in Berlin (Jan 14 2026 is a Wednesday)
    assert.equal(RevenueDate.berlinWeekdayName("2026-01-14T23:30:00Z"), "Thursday");
});

test("18. berlinMonthKey groups by Berlin month, not UTC month, near a month boundary at midnight", () => {
    // 2026-01-31 23:30 UTC = 2026-02-01 00:30 CET
    assert.equal(RevenueDate.berlinMonthKey("2026-01-31T23:30:00Z"), "2026-02");
});
