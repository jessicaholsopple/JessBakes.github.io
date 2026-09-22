"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

/* ==========================================
   Tests for supabase/functions/_shared/themeSchedule.mjs -- the pure,
   dependency-free DST-safe schedule resolver behind the Themes
   feature. Plain ESM using only Web-standard APIs, imported here via
   dynamic import() exactly as written, with zero mocking and zero
   duplication against what theme-scheduler and admin/themes.html
   actually ship -- same convention as tests/email-shared.test.js.
   ========================================== */

const SHARED = "../supabase/functions/_shared/themeSchedule.mjs";

/* ==========================================
   Easter Sunday -- validated against six independently-known
   published Western Easter dates.
   ========================================== */

test("computeEasterSunday matches known published dates 2023-2028", async () => {
    const { computeEasterSunday } = await import(SHARED);
    const known = [
        [2023, 4, 9], [2024, 3, 31], [2025, 4, 20],
        [2026, 4, 5], [2027, 3, 28], [2028, 4, 16]
    ];
    for (const [year, month, day] of known) {
        const result = computeEasterSunday(year);
        assert.deepEqual(result, { month, day }, `Easter ${year}`);
    }
});

/* ==========================================
   Nth weekday of month -- Thanksgiving (4th Thursday of November)
   across several years, plus the "last occurrence" and
   nonexistent-occurrence edge cases.
   ========================================== */

test("computeNthWeekdayOfMonth: 4th Thursday of November across several years", async () => {
    const { computeNthWeekdayOfMonth } = await import(SHARED);
    assert.deepEqual(computeNthWeekdayOfMonth(2024, 11, 4, 4), { year: 2024, month: 11, day: 28 });
    assert.deepEqual(computeNthWeekdayOfMonth(2025, 11, 4, 4), { year: 2025, month: 11, day: 27 });
    assert.deepEqual(computeNthWeekdayOfMonth(2026, 11, 4, 4), { year: 2026, month: 11, day: 26 });
    assert.deepEqual(computeNthWeekdayOfMonth(2027, 11, 4, 4), { year: 2027, month: 11, day: 25 });
});

test("computeNthWeekdayOfMonth: occurrence -1 means the last occurrence in the month", async () => {
    const { computeNthWeekdayOfMonth } = await import(SHARED);
    // Last Monday of May 2026.
    const result = computeNthWeekdayOfMonth(2026, 5, 1, -1);
    assert.equal(result.month, 5);
    // Verify it's actually a Monday and there's no later Monday that month.
    const asDate = new Date(Date.UTC(2026, 4, result.day));
    assert.equal(asDate.getUTCDay(), 1);
    assert.ok(result.day > 31 - 7);
});

test("computeNthWeekdayOfMonth returns null for an occurrence that doesn't exist", async () => {
    const { computeNthWeekdayOfMonth } = await import(SHARED);
    // February 2026 (28 days) cannot have a 5th occurrence of any weekday.
    assert.equal(computeNthWeekdayOfMonth(2026, 2, 3, 5), null);
});

/* ==========================================
   zonedWallTimeToUtc -- DST-safe local -> UTC, incl. both Berlin
   transition kinds for 2026 (spring-forward: March 29, 01:00 UTC;
   fall-back: October 25, 01:00 UTC).
   ========================================== */

test("zonedWallTimeToUtc: ordinary winter/summer instants convert correctly", async () => {
    const { zonedWallTimeToUtc } = await import(SHARED);
    assert.equal(
        zonedWallTimeToUtc({ year: 2026, month: 1, day: 15, hour: 10, minute: 0 }, "Europe/Berlin").toISOString(),
        "2026-01-15T09:00:00.000Z" // CET = UTC+1
    );
    assert.equal(
        zonedWallTimeToUtc({ year: 2026, month: 7, day: 15, hour: 10, minute: 0 }, "Europe/Berlin").toISOString(),
        "2026-07-15T08:00:00.000Z" // CEST = UTC+2
    );
});

test("zonedWallTimeToUtc: fall-back (wall time occurs twice) resolves to the EARLIER instant", async () => {
    const { zonedWallTimeToUtc } = await import(SHARED);
    // 2026-10-25 02:30 Berlin occurs once as CEST (00:30Z) and once as
    // CET (01:30Z) -- must deterministically pick the earlier (CEST) one.
    const result = zonedWallTimeToUtc({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 }, "Europe/Berlin");
    assert.equal(result.toISOString(), "2026-10-25T00:30:00.000Z");
});

test("zonedWallTimeToUtc: spring-forward gap (wall time never occurs) rounds forward, never throws", async () => {
    const { zonedWallTimeToUtc } = await import(SHARED);
    // 2026-03-29 02:30 Berlin never happens (clocks jump 02:00 -> 03:00).
    const result = zonedWallTimeToUtc({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, "Europe/Berlin");
    assert.equal(result.toISOString(), "2026-03-29T01:30:00.000Z");

    // The result must land just after the transition -- round-trip it
    // through Intl and confirm it reads back as 03:30 local (the gap
    // duration added to the nonexistent input).
    const fmt = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit", hour12: false
    });
    assert.equal(fmt.format(result), "03:30");
});

/* ==========================================
   resolveScheduleWindow -- annual_fixed incl. Dec->Jan wrap, and
   annual_rule (both kinds).
   ========================================== */

test("resolveScheduleWindow: annual_fixed window crossing Dec 31 -> Jan 1", async () => {
    const { resolveScheduleWindow } = await import(SHARED);
    const newYears = {
        recurrence_type: "annual_fixed",
        annual_start_month: 12, annual_start_day: 27,
        annual_end_month: 1, annual_end_day: 6,
        start_time_local: "00:00", end_time_local: "23:59"
    };
    const window = resolveScheduleWindow(newYears, 2026, "Europe/Berlin");
    assert.equal(window.startUtc.toISOString(), "2026-12-26T23:00:00.000Z"); // Dec 27 00:00 CET
    assert.equal(window.endUtc.toISOString(), "2027-01-06T22:59:00.000Z");   // Jan 6 23:59 CET
});

test("resolveScheduleWindow: annual_rule easter_offset window", async () => {
    const { resolveScheduleWindow } = await import(SHARED);
    const easter = {
        recurrence_type: "annual_rule", rule_kind: "easter_offset",
        window_start_offset_days: -7, window_end_offset_days: 1,
        start_time_local: "00:00", end_time_local: "23:59"
    };
    // Easter Sunday 2026 = April 5 -> window April 5-7 = -7d to +1d.
    const window = resolveScheduleWindow(easter, 2026, "Europe/Berlin");
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", month: "2-digit", day: "2-digit" });
    assert.equal(fmt.format(window.startUtc), "03-29"); // Apr 5 - 7 days = Mar 29
    assert.equal(fmt.format(window.endUtc), "04-06");   // Apr 5 + 1 day = Apr 6
});

test("resolveScheduleWindow: annual_rule nth_weekday_offset (Thanksgiving, starting 7 days before)", async () => {
    const { resolveScheduleWindow } = await import(SHARED);
    const thanksgiving = {
        recurrence_type: "annual_rule", rule_kind: "nth_weekday_offset",
        rule_month: 11, rule_weekday: 4, rule_occurrence: 4,
        window_start_offset_days: -7, window_end_offset_days: 0,
        start_time_local: "00:00", end_time_local: "23:59"
    };
    const window = resolveScheduleWindow(thanksgiving, 2026, "Europe/Berlin");
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", month: "2-digit", day: "2-digit" });
    assert.equal(fmt.format(window.startUtc), "11-19"); // Nov 26 - 7 days
    assert.equal(fmt.format(window.endUtc), "11-26");   // Nov 26 (the day itself)
});

test("resolveScheduleWindow: malformed/incomplete entries return null instead of throwing", async () => {
    const { resolveScheduleWindow } = await import(SHARED);
    assert.equal(resolveScheduleWindow({ recurrence_type: "fixed_range" }, 2026), null);
    assert.equal(resolveScheduleWindow({ recurrence_type: "annual_fixed", annual_start_month: 3 }, 2026), null);
    assert.equal(resolveScheduleWindow({ recurrence_type: "annual_rule", rule_kind: "nth_weekday_offset" }, 2026), null);
    assert.equal(resolveScheduleWindow(null, 2026), null);
});

test("resolveScheduleWindow: fixed_range is an absolute one-off, ignores candidateYear", async () => {
    const { resolveScheduleWindow } = await import(SHARED);
    const entry = { recurrence_type: "fixed_range", fixed_start: "2026-05-01T00:00:00Z", fixed_end: "2026-05-10T00:00:00Z" };
    const a = resolveScheduleWindow(entry, 2020);
    const b = resolveScheduleWindow(entry, 2099);
    assert.equal(a.startUtc.toISOString(), "2026-05-01T00:00:00.000Z");
    assert.equal(b.startUtc.toISOString(), "2026-05-01T00:00:00.000Z");
});

/* ==========================================
   isEntryActiveAt -- Dec->Jan wrap checked from BOTH sides of New
   Year's, plus a plain non-wrapping window.
   ========================================== */

test("isEntryActiveAt: a Dec->Jan window is active when checked from the December side AND the January side", async () => {
    const { isEntryActiveAt } = await import(SHARED);
    const newYears = {
        recurrence_type: "annual_fixed",
        annual_start_month: 12, annual_start_day: 27,
        annual_end_month: 1, annual_end_day: 6,
        start_time_local: "00:00", end_time_local: "23:59"
    };
    assert.equal(isEntryActiveAt(newYears, new Date("2026-12-30T12:00:00Z"), "Europe/Berlin").active, true);
    assert.equal(isEntryActiveAt(newYears, new Date("2027-01-02T12:00:00Z"), "Europe/Berlin").active, true);
    assert.equal(isEntryActiveAt(newYears, new Date("2026-07-01T12:00:00Z"), "Europe/Berlin").active, false);
});

/* ==========================================
   detectOverlaps -- blocking vs. non-blocking, cross-tier is never
   flagged, seed-data-shaped clean pairs stay clean.
   ========================================== */

const CATALOG = {
    winter: { key: "winter", tier: "season" },
    christmas: { key: "christmas", tier: "holiday" },
    new_years: { key: "new_years", tier: "holiday" }
};

function annualFixed(themeKey, sm, sd, em, ed, priority = 0) {
    return {
        theme_key: themeKey, enabled: true, recurrence_type: "annual_fixed",
        annual_start_month: sm, annual_start_day: sd, annual_end_month: em, annual_end_day: ed,
        start_time_local: "00:00", end_time_local: "23:59", tier_priority: priority
    };
}

test("detectOverlaps: non-overlapping same-tier entries (Christmas Dec1-25, New Year's Dec27-Jan6) report clean", async () => {
    const { detectOverlaps } = await import(SHARED);
    const christmas = annualFixed("christmas", 12, 1, 12, 25);
    const newYears = annualFixed("new_years", 12, 27, 1, 6);
    const overlaps = detectOverlaps([christmas, newYears], CATALOG, new Date("2026-06-01T00:00:00Z"), "Europe/Berlin");
    assert.deepEqual(overlaps, []);
});

test("detectOverlaps: overlapping same-tier, same-priority entries are flagged blocking", async () => {
    const { detectOverlaps } = await import(SHARED);
    const christmas = annualFixed("christmas", 12, 1, 12, 25, 0);
    const conflicting = annualFixed("new_years", 12, 20, 1, 5, 0);
    const overlaps = detectOverlaps([christmas, conflicting], CATALOG, new Date("2026-06-01T00:00:00Z"), "Europe/Berlin");
    assert.equal(overlaps.length, 1);
    assert.equal(overlaps[0].blocking, true);
});

test("detectOverlaps: overlapping same-tier entries with DIFFERENT priority are flagged non-blocking", async () => {
    const { detectOverlaps } = await import(SHARED);
    const christmas = annualFixed("christmas", 12, 1, 12, 25, 5);
    const conflicting = annualFixed("new_years", 12, 20, 1, 5, 0);
    const overlaps = detectOverlaps([christmas, conflicting], CATALOG, new Date("2026-06-01T00:00:00Z"), "Europe/Berlin");
    assert.equal(overlaps.length, 1);
    assert.equal(overlaps[0].blocking, false);
});

test("detectOverlaps: entries in DIFFERENT tiers never conflict, however their dates relate", async () => {
    const { detectOverlaps } = await import(SHARED);
    const winter = annualFixed("winter", 12, 21, 3, 19); // season
    const christmas = annualFixed("christmas", 12, 1, 12, 25); // holiday, fully inside winter's window
    const overlaps = detectOverlaps([winter, christmas], CATALOG, new Date("2026-06-01T00:00:00Z"), "Europe/Berlin");
    assert.deepEqual(overlaps, []);
});

/* ==========================================
   resolveActiveTheme -- the master priority resolution: manual ->
   holiday -> season -> classic, incl. manual-override expiry.
   ========================================== */

test("resolveActiveTheme: an active holiday wins over an active season", async () => {
    const { resolveActiveTheme } = await import(SHARED);
    const winter = annualFixed("winter", 12, 21, 3, 19);
    const christmas = annualFixed("christmas", 12, 1, 12, 25);
    const result = resolveActiveTheme({
        catalogByKey: CATALOG,
        scheduleEntries: [winter, christmas],
        manualOverride: null,
        nowUtc: new Date("2026-12-24T12:00:00Z"),
        timeZone: "Europe/Berlin"
    });
    assert.equal(result.resolvedThemeKey, "christmas");
    assert.equal(result.resolvedReason, "holiday:christmas");
});

test("resolveActiveTheme: nothing scheduled falls back to Classic", async () => {
    const { resolveActiveTheme } = await import(SHARED);
    const christmas = annualFixed("christmas", 12, 1, 12, 25);
    const result = resolveActiveTheme({
        catalogByKey: CATALOG,
        scheduleEntries: [christmas],
        manualOverride: null,
        nowUtc: new Date("2026-07-15T12:00:00Z"),
        timeZone: "Europe/Berlin"
    });
    assert.equal(result.resolvedThemeKey, "classic");
    assert.equal(result.resolvedReason, "classic:default");
});

test("resolveActiveTheme: an active manual override always wins, regardless of any schedule", async () => {
    const { resolveActiveTheme } = await import(SHARED);
    const christmas = annualFixed("christmas", 12, 1, 12, 25);
    const result = resolveActiveTheme({
        catalogByKey: CATALOG,
        scheduleEntries: [christmas],
        manualOverride: { theme_key: "winter", ends_at: null },
        nowUtc: new Date("2026-12-24T12:00:00Z"),
        timeZone: "Europe/Berlin"
    });
    assert.equal(result.resolvedThemeKey, "winter");
    assert.equal(result.resolvedReason, "manual_override");
});

test("resolveActiveTheme: an EXPIRED manual override is ignored, falling through to the schedule", async () => {
    const { resolveActiveTheme } = await import(SHARED);
    const christmas = annualFixed("christmas", 12, 1, 12, 25);
    const result = resolveActiveTheme({
        catalogByKey: CATALOG,
        scheduleEntries: [christmas],
        manualOverride: { theme_key: "winter", ends_at: "2026-12-01T00:00:00Z" },
        nowUtc: new Date("2026-12-24T12:00:00Z"),
        timeZone: "Europe/Berlin"
    });
    assert.equal(result.resolvedThemeKey, "christmas");
    assert.equal(result.resolvedReason, "holiday:christmas");
});

test("resolveActiveTheme: malformed/empty schedule input still falls back to Classic, never throws", async () => {
    const { resolveActiveTheme } = await import(SHARED);
    const result = resolveActiveTheme({
        catalogByKey: {},
        scheduleEntries: [],
        manualOverride: null,
        nowUtc: new Date("2026-12-24T12:00:00Z")
    });
    assert.equal(result.resolvedThemeKey, "classic");

    const resultWithGarbage = resolveActiveTheme({
        catalogByKey: undefined,
        scheduleEntries: [{ theme_key: "nope", enabled: true, recurrence_type: "bogus" }],
        manualOverride: undefined,
        nowUtc: new Date()
    });
    assert.equal(resultWithGarbage.resolvedThemeKey, "classic");
});
