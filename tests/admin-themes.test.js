"use strict";

/* ==========================================
   Admin Themes panel (js/admin-themes.js) -- pure/testable helpers

   Covers: formatResolvedReason's plain-language translation of every
   theme_state.resolved_reason shape the resolver can produce,
   formatOverlapWarning's blocking-vs-non-blocking rendering,
   buildTimelineRows against the REAL supabase/functions/_shared/
   themeSchedule.mjs (dependency-injected, not a stub -- genuine
   integration coverage of the admin timeline against the same
   resolver theme-scheduler uses), and hasUnpublishedChanges' draft-
   vs-published comparison that drives the Publish section's banner.

   Same node:vm sandbox technique as tests/admin-vacation.test.js,
   trimmed to a minimal document/window stub since none of the
   functions under test touch real DOM elements.
   ========================================== */

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function read(relPath) {
    return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

function loadAdminThemesSandbox() {
    const sandbox = {
        document: { addEventListener: () => {} },
        window: {},
        console,
        confirm: () => true
    };
    vm.createContext(sandbox);

    const source = [
        read("js/admin-themes.js"),
        `
        this.__formatResolvedReason = formatResolvedReason;
        this.__formatOverlapWarning = formatOverlapWarning;
        this.__buildTimelineRows = buildTimelineRows;
        this.__hasUnpublishedChanges = hasUnpublishedChanges;
        this.__escapeThemeHtml = escapeThemeHtml;
        `
    ].join("\n");

    vm.runInContext(source, sandbox);
    return sandbox;
}

const CATALOG_BY_KEY = {
    halloween: { key: "halloween", name: "Halloween", tier: "holiday" },
    christmas: { key: "christmas", name: "Christmas", tier: "holiday" },
    autumn: { key: "autumn", name: "Autumn", tier: "season" },
    new_years: { key: "new_years", name: "New Year's", tier: "holiday" }
};

/* ==========================================
   formatResolvedReason
   ========================================== */

test("1. formatResolvedReason: manual override", () => {
    const { __formatResolvedReason } = loadAdminThemesSandbox();
    assert.equal(__formatResolvedReason("manual_override", CATALOG_BY_KEY), "Manual override");
});

test("2. formatResolvedReason: classic default", () => {
    const { __formatResolvedReason } = loadAdminThemesSandbox();
    assert.equal(__formatResolvedReason("classic:default", CATALOG_BY_KEY), "No holiday or season scheduled");
});

test("3. formatResolvedReason: an ordinary holiday/season resolution names the theme by its catalog display name", () => {
    const { __formatResolvedReason } = loadAdminThemesSandbox();
    assert.equal(__formatResolvedReason("holiday:halloween", CATALOG_BY_KEY), "Holiday: Halloween");
    assert.equal(__formatResolvedReason("season:autumn", CATALOG_BY_KEY), "Season: Autumn");
});

test("4. formatResolvedReason: a resolver-level conflict (should never happen in a normally-published schedule) reads as an explicit, visible warning naming both themes", () => {
    const { __formatResolvedReason } = loadAdminThemesSandbox();
    const result = __formatResolvedReason("holiday:conflict:christmas,new_years", CATALOG_BY_KEY);
    assert.match(result, /Conflict/);
    assert.match(result, /Christmas/);
    assert.match(result, /New Year's/);
});

test("5. formatResolvedReason: unknown catalog key falls back to the raw key rather than throwing", () => {
    const { __formatResolvedReason } = loadAdminThemesSandbox();
    assert.equal(__formatResolvedReason("holiday:some_future_key", {}), "Holiday: some_future_key");
});

test("6. formatResolvedReason: missing/empty reason", () => {
    const { __formatResolvedReason } = loadAdminThemesSandbox();
    assert.equal(__formatResolvedReason(null, CATALOG_BY_KEY), "Unknown");
    assert.equal(__formatResolvedReason("", CATALOG_BY_KEY), "Unknown");
});

/* ==========================================
   formatOverlapWarning
   ========================================== */

test("7. formatOverlapWarning: a blocking (equal-priority) overlap renders as an error naming both themes and the shared priority", () => {
    const { __formatOverlapWarning } = loadAdminThemesSandbox();
    const html = __formatOverlapWarning(
        { a: { theme_key: "christmas", tier_priority: 0 }, b: { theme_key: "new_years", tier_priority: 0 }, tier: "holiday", blocking: true },
        CATALOG_BY_KEY
    );
    assert.match(html, /is-error/);
    assert.match(html, /Christmas/);
    assert.match(html, /New Year/); // escapeThemeHtml renders the apostrophe as &#039;
    assert.match(html, /Publish will be blocked/);
});

test("8. formatOverlapWarning: a non-blocking overlap renders as a warning naming which theme wins", () => {
    const { __formatOverlapWarning } = loadAdminThemesSandbox();
    const html = __formatOverlapWarning(
        { a: { theme_key: "christmas", tier_priority: 5 }, b: { theme_key: "new_years", tier_priority: 0 }, tier: "holiday", blocking: false },
        CATALOG_BY_KEY
    );
    assert.match(html, /is-warning/);
    assert.match(html, /Christmas.*wins|wins.*Christmas/s);
});

/* ==========================================
   buildTimelineRows -- against the REAL resolver
   ========================================== */

test("9. buildTimelineRows: a 31-day annual_fixed entry (Halloween, Oct 1-31) appears in October's row spanning nearly the full month, and not in any other month", async () => {
    const ThemeSchedule = await import("../supabase/functions/_shared/themeSchedule.mjs");
    const { __buildTimelineRows } = loadAdminThemesSandbox();

    const halloween = {
        theme_key: "halloween", enabled: true, recurrence_type: "annual_fixed",
        annual_start_month: 10, annual_start_day: 1, annual_end_month: 10, annual_end_day: 31,
        start_time_local: "00:00", end_time_local: "23:59"
    };

    const fromDate = new Date("2026-01-01T00:00:00Z");
    const months = __buildTimelineRows([halloween], CATALOG_BY_KEY, fromDate, 12, ThemeSchedule);

    assert.equal(months.length, 12);
    const octoberRow = months.find(m => m.year === 2026 && m.month === 10);
    assert.ok(octoberRow, "expected a 2026-10 row within the 12-month window");
    assert.equal(octoberRow.segments.length, 1);
    assert.equal(octoberRow.segments[0].themeName, "Halloween");
    assert.ok(octoberRow.segments[0].widthPercent > 80, "a 31-day window should cover most of the month's bar");

    const monthsWithHalloween = months.filter(m => m.segments.some(s => s.themeKey === "halloween"));
    assert.equal(monthsWithHalloween.length, 1, "Halloween must only appear in October, not bleed into neighboring months");
});

test("10. buildTimelineRows: a Dec->Jan wrapping entry (New Year's) produces segments in BOTH December and January", async () => {
    const ThemeSchedule = await import("../supabase/functions/_shared/themeSchedule.mjs");
    const { __buildTimelineRows } = loadAdminThemesSandbox();

    const newYears = {
        theme_key: "new_years", enabled: true, recurrence_type: "annual_fixed",
        annual_start_month: 12, annual_start_day: 27, annual_end_month: 1, annual_end_day: 6,
        start_time_local: "00:00", end_time_local: "23:59"
    };

    const fromDate = new Date("2026-11-01T00:00:00Z");
    const months = __buildTimelineRows([newYears], CATALOG_BY_KEY, fromDate, 4, ThemeSchedule);

    const decRow = months.find(m => m.year === 2026 && m.month === 12);
    const janRow = months.find(m => m.year === 2027 && m.month === 1);
    assert.ok(decRow.segments.some(s => s.themeKey === "new_years"), "expected a segment in December");
    assert.ok(janRow.segments.some(s => s.themeKey === "new_years"), "expected a segment in January");
});

test("11. buildTimelineRows: a disabled entry never contributes a segment", async () => {
    const ThemeSchedule = await import("../supabase/functions/_shared/themeSchedule.mjs");
    const { __buildTimelineRows } = loadAdminThemesSandbox();

    const disabledHalloween = {
        theme_key: "halloween", enabled: false, recurrence_type: "annual_fixed",
        annual_start_month: 10, annual_start_day: 1, annual_end_month: 10, annual_end_day: 31,
        start_time_local: "00:00", end_time_local: "23:59"
    };

    const months = __buildTimelineRows([disabledHalloween], CATALOG_BY_KEY, new Date("2026-01-01T00:00:00Z"), 12, ThemeSchedule);
    assert.ok(months.every(m => m.segments.length === 0));
});

test("12. buildTimelineRows: a missing ThemeSchedule dependency returns an empty array rather than throwing", () => {
    const { __buildTimelineRows } = loadAdminThemesSandbox();
    const result = __buildTimelineRows([{}], {}, new Date(), 12, undefined);
    assert.equal(result.length, 0);
});

/* ==========================================
   hasUnpublishedChanges
   ========================================== */

test("13. hasUnpublishedChanges: a draft row updated after the last publish -> true", () => {
    const { __hasUnpublishedChanges } = loadAdminThemesSandbox();
    const result = __hasUnpublishedChanges(
        [{ updated_at: "2026-06-05T00:00:00Z" }],
        { last_published_at: "2026-06-01T00:00:00Z" }
    );
    assert.equal(result, true);
});

test("14. hasUnpublishedChanges: every draft row unchanged since the last publish -> false", () => {
    const { __hasUnpublishedChanges } = loadAdminThemesSandbox();
    const result = __hasUnpublishedChanges(
        [{ updated_at: "2026-05-01T00:00:00Z" }, { updated_at: "2026-05-15T00:00:00Z" }],
        { last_published_at: "2026-06-01T00:00:00Z" }
    );
    assert.equal(result, false);
});

test("15. hasUnpublishedChanges: never published before, but draft rows exist -> true", () => {
    const { __hasUnpublishedChanges } = loadAdminThemesSandbox();
    const result = __hasUnpublishedChanges([{ updated_at: "2026-05-01T00:00:00Z" }], { last_published_at: null });
    assert.equal(result, true);
});

test("16. hasUnpublishedChanges: no draft rows at all -> false, regardless of publish history", () => {
    const { __hasUnpublishedChanges } = loadAdminThemesSandbox();
    assert.equal(__hasUnpublishedChanges([], { last_published_at: null }), false);
    assert.equal(__hasUnpublishedChanges([], { last_published_at: "2026-06-01T00:00:00Z" }), false);
});

/* ==========================================
   escapeThemeHtml
   ========================================== */

test("17. escapeThemeHtml escapes the five dangerous characters and tolerates null/undefined", () => {
    const { __escapeThemeHtml } = loadAdminThemesSandbox();
    assert.equal(__escapeThemeHtml(`<a href="x">&'</a>`), "&lt;a href=&quot;x&quot;&gt;&amp;&#039;&lt;/a&gt;");
    assert.equal(__escapeThemeHtml(null), "");
    assert.equal(__escapeThemeHtml(undefined), "");
});
