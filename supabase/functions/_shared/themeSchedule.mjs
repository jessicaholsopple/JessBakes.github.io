/* ==========================================
   THEMES -- DST-SAFE SCHEDULE RESOLVER

   The single authoritative implementation of "what theme is active
   right now" (and "when will it next change"), shared by three
   consumers with zero duplication:

     - supabase/functions/theme-scheduler (Deno, cron, every 5 min --
       writes the result onto theme_state; the ONLY place a customer-
       facing decision actually gets made)
     - admin/themes.html (loaded as a native <script type="module">,
       for live preview/timeline/overlap-warning UI against the DRAFT
       schedule -- never customer-facing)
     - tests/theme-schedule.test.js (Node, via dynamic import())

   Public pages never import this file and never run this resolver --
   they only ever read theme_state's precomputed resolved_* columns
   (see js/theme-apply.js), which is what makes "reliable at the
   exact transition moment" true structurally rather than by
   convention: a customer's page load is always reading a value some
   server-side process already computed, never live-computing this
   recurrence/DST math against their own device clock.

   All time math is Europe/Berlin (the bakery's own timezone,
   regardless of visitor timezone) and DST-safe via
   Intl.DateTimeFormat with an explicit timeZone -- exactly the
   technique already used by ./schedule.mjs (zonedParts,
   parseLocalTimeToMinutes, reused here unmodified). This file adds
   the one piece schedule.mjs doesn't have: the DST-safe INVERSE
   (local wall-clock -> UTC instant), needed because a schedule
   entry's start/end are specified as local wall time, not UTC.
   ========================================== */

import { zonedParts, parseLocalTimeToMinutes } from "./schedule.mjs";

// Re-exported for convenience -- consumers that need a UTC->local
// read (e.g. admin/js/admin-themes.js's timeline month boundaries)
// shouldn't need a second import from ./schedule.mjs just for this.
export { zonedParts };

const DEFAULT_TIMEZONE = "Europe/Berlin";

/* ==========================================
   DST-SAFE LOCAL WALL-TIME -> UTC INSTANT
   ========================================== */

function offsetMsAt(instantMs, timeZone) {
    const parts = zonedParts(new Date(instantMs), timeZone);
    const renderedAsUtcMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    return renderedAsUtcMs - instantMs;
}

function rendersToWallTime(instantMs, desired, timeZone) {
    const parts = zonedParts(new Date(instantMs), timeZone);
    return parts.year === desired.year && parts.month === desired.month && parts.day === desired.day
        && parts.hour === desired.hour && parts.minute === desired.minute;
}

/**
 * Converts a { year, month(1-12), day, hour, minute } wall-clock time
 * in `timeZone` to the UTC instant it represents -- the DST-safe
 * inverse of zonedParts.
 *
 * Probes the UTC offset actually in effect at two reference points --
 * the naive guess (wall time treated as UTC) and the same instant 24
 * hours earlier (guaranteed to sit on the other side of any DST
 * transition that could possibly affect the naive guess, since
 * transitions are single instants at least months apart) -- rather
 * than iteratively refining a single guess, which can converge back
 * to the same offset regime it started in and silently miss a
 * fall-back ambiguity. This two-independent-probe approach is enough
 * to detect (and deterministically resolve) both kinds of DST
 * irregularity:
 *
 *   - Fall-back (the wall time occurs TWICE, e.g. 02:30 on the
 *     October transition): always resolves to the EARLIER of the two
 *     real instants.
 *   - Spring-forward (the wall time never occurs at all, e.g. 02:30
 *     on the March transition when clocks jump 02:00 -> 03:00):
 *     rounds forward into the new offset, preserving the requested
 *     minute-of-hour (2:30 input -> 3:30 local result for a 1-hour
 *     gap) -- the same convention used by Luxon/moment-timezone.
 *     Never throws.
 */
export function zonedWallTimeToUtc(desired, timeZone = DEFAULT_TIMEZONE) {
    const desiredAsUtcMs = Date.UTC(desired.year, desired.month - 1, desired.day, desired.hour, desired.minute);
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;

    const offsetNear = offsetMsAt(desiredAsUtcMs, timeZone);
    const offsetDayBefore = offsetMsAt(desiredAsUtcMs - ONE_DAY_MS, timeZone);

    const candidateNear = desiredAsUtcMs - offsetNear;
    const candidateDayBefore = desiredAsUtcMs - offsetDayBefore;

    const nearValid = rendersToWallTime(candidateNear, desired, timeZone);
    const dayBeforeValid = rendersToWallTime(candidateDayBefore, desired, timeZone);

    if (nearValid && dayBeforeValid) {
        return new Date(Math.min(candidateNear, candidateDayBefore));
    }
    if (nearValid) return new Date(candidateNear);
    if (dayBeforeValid) return new Date(candidateDayBefore);

    // Neither candidate round-trips -- the wall time falls inside a
    // spring-forward gap. Round forward into the later-offset regime.
    return new Date(Math.max(candidateNear, candidateDayBefore));
}

function addDaysToYmd({ year, month, day }, deltaDays) {
    const d = new Date(Date.UTC(year, month - 1, day + deltaDays));
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function ymdAndMinutesToUtc(ymd, minutesSinceMidnight, timeZone) {
    const hour = Math.floor(minutesSinceMidnight / 60);
    const minute = minutesSinceMidnight % 60;
    return zonedWallTimeToUtc({ ...ymd, hour, minute }, timeZone);
}

/* ==========================================
   MOVABLE-HOLIDAY DATE MATH
   ========================================== */

/**
 * Western (Gregorian) Easter Sunday for a given year, via the
 * Anonymous Gregorian algorithm (Meeus/Jones/Butcher) -- pure integer
 * arithmetic, no lookup table. Returns { month, day }. Validated in
 * tests against six independently-known published Easter dates.
 */
export function computeEasterSunday(year) {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return { month, day };
}

/**
 * The Nth occurrence of a weekday (0=Sunday..6=Saturday) within a
 * given month/year -- e.g. computeNthWeekdayOfMonth(2026, 11, 4, 4)
 * is "the 4th Thursday of November 2026" (Thanksgiving).
 * `occurrence` of -1 means "the last occurrence in the month."
 * Returns { year, month, day }, or null if that occurrence doesn't
 * exist in the month (e.g. a requested 5th occurrence that month
 * only has 4 of).
 */
export function computeNthWeekdayOfMonth(year, month, weekday, occurrence) {
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

    if (occurrence === -1) {
        const lastOfMonthWeekday = new Date(Date.UTC(year, month - 1, daysInMonth)).getUTCDay();
        const diff = (lastOfMonthWeekday - weekday + 7) % 7;
        return { year, month, day: daysInMonth - diff };
    }

    const firstOfMonthWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    const offsetToFirstMatch = (weekday - firstOfMonthWeekday + 7) % 7;
    const day = 1 + offsetToFirstMatch + (occurrence - 1) * 7;

    return day <= daysInMonth ? { year, month, day } : null;
}

/* ==========================================
   PER-ENTRY WINDOW RESOLUTION
   ========================================== */

/**
 * Resolves one theme_schedules(_published) row to a concrete
 * { startUtc, endUtc } window for one candidate anchor year (ignored
 * for `fixed_range`, which is absolute). Returns null for malformed/
 * incomplete entries (missing required fields for their
 * recurrence_type, or a nth_weekday_offset occurrence that doesn't
 * exist that year) rather than throwing -- callers treat null as
 * "this entry contributes no window," never as an error.
 */
export function resolveScheduleWindow(entry, candidateYear, timeZone = DEFAULT_TIMEZONE) {
    if (!entry || !entry.recurrence_type) return null;

    const startMinutes = parseLocalTimeToMinutes(entry.start_time_local) ?? 0;
    const endMinutesRaw = parseLocalTimeToMinutes(entry.end_time_local);
    const endMinutes = endMinutesRaw === null ? (23 * 60 + 59) : endMinutesRaw;

    if (entry.recurrence_type === "fixed_range") {
        if (!entry.fixed_start || !entry.fixed_end) return null;
        const startUtc = new Date(entry.fixed_start);
        const endUtc = new Date(entry.fixed_end);
        if (Number.isNaN(startUtc.getTime()) || Number.isNaN(endUtc.getTime())) return null;
        return { startUtc, endUtc };
    }

    if (entry.recurrence_type === "annual_fixed") {
        const sm = entry.annual_start_month, sd = entry.annual_start_day;
        const em = entry.annual_end_month, ed = entry.annual_end_day;
        if (!sm || !sd || !em || !ed) return null;

        const wraps = (em < sm) || (em === sm && ed < sd);
        const startYmd = { year: candidateYear, month: sm, day: sd };
        const endYmd = { year: wraps ? candidateYear + 1 : candidateYear, month: em, day: ed };

        return {
            startUtc: ymdAndMinutesToUtc(startYmd, startMinutes, timeZone),
            endUtc: ymdAndMinutesToUtc(endYmd, endMinutes, timeZone)
        };
    }

    if (entry.recurrence_type === "annual_rule") {
        let anchor = null;
        if (entry.rule_kind === "easter_offset") {
            anchor = computeEasterSunday(candidateYear);
        } else if (entry.rule_kind === "nth_weekday_offset") {
            if (!entry.rule_month || entry.rule_weekday === null || entry.rule_weekday === undefined || !entry.rule_occurrence) return null;
            anchor = computeNthWeekdayOfMonth(candidateYear, entry.rule_month, entry.rule_weekday, entry.rule_occurrence);
        }
        if (!anchor) return null;

        const anchorYmd = { year: candidateYear, month: anchor.month, day: anchor.day };
        const startYmd = addDaysToYmd(anchorYmd, entry.window_start_offset_days || 0);
        const endYmd = addDaysToYmd(anchorYmd, entry.window_end_offset_days || 0);

        return {
            startUtc: ymdAndMinutesToUtc(startYmd, startMinutes, timeZone),
            endUtc: ymdAndMinutesToUtc(endYmd, endMinutes, timeZone)
        };
    }

    return null;
}

/**
 * Whether `entry` is active at `nowUtc`. Checks three candidate
 * anchor years (now's Berlin-local year, and one on either side) so
 * a window crossing Dec 31 -> Jan 1 resolves correctly regardless of
 * which side of New Year's `now` falls on.
 */
export function isEntryActiveAt(entry, nowUtc, timeZone = DEFAULT_TIMEZONE) {
    if (!entry) return { active: false, window: null };

    if (entry.recurrence_type === "fixed_range") {
        const window = resolveScheduleWindow(entry, null, timeZone);
        if (!window) return { active: false, window: null };
        const active = nowUtc >= window.startUtc && nowUtc <= window.endUtc;
        return { active, window };
    }

    const nowYear = zonedParts(nowUtc, timeZone).year;
    for (const candidateYear of [nowYear - 1, nowYear, nowYear + 1]) {
        const window = resolveScheduleWindow(entry, candidateYear, timeZone);
        if (!window) continue;
        if (nowUtc >= window.startUtc && nowUtc <= window.endUtc) {
            return { active: true, window };
        }
    }
    return { active: false, window: null };
}

/* ==========================================
   OVERLAP DETECTION (admin UI warnings; the SQL-side
   publish_theme_schedule() enforces a conservative version of this
   same rule independently at publish time -- see that migration's
   header comment for why the two aren't the same implementation)
   ========================================== */

/**
 * Pairs of ENABLED entries in the same tier whose windows intersect
 * within the next few years (a "will they ever collide" check, not
 * tied to one instant). Each result is
 * { a, b, tier, blocking }, where `blocking` is true only when both
 * entries also share the same tier_priority -- an unambiguous
 * same-priority collision, exactly the case
 * publish_theme_schedule() refuses to publish.
 */
export function detectOverlaps(scheduleEntries, catalogByKey, nowUtc, timeZone = DEFAULT_TIMEZONE) {
    const enabled = (scheduleEntries || []).filter(e => e && e.enabled);
    const nowYear = zonedParts(nowUtc, timeZone).year;
    const years = [nowYear - 1, nowYear, nowYear + 1, nowYear + 2];
    const overlaps = [];

    const windowsFor = (entry) => {
        if (entry.recurrence_type === "fixed_range") {
            const w = resolveScheduleWindow(entry, null, timeZone);
            return w ? [w] : [];
        }
        return years
            .map(year => resolveScheduleWindow(entry, year, timeZone))
            .filter(Boolean);
    };

    for (let i = 0; i < enabled.length; i++) {
        for (let j = i + 1; j < enabled.length; j++) {
            const a = enabled[i], b = enabled[j];
            const tierA = catalogByKey?.[a.theme_key]?.tier;
            const tierB = catalogByKey?.[b.theme_key]?.tier;
            if (!tierA || !tierB || tierA !== tierB) continue;

            const windowsA = windowsFor(a);
            const windowsB = windowsFor(b);
            const intersects = windowsA.some(wa =>
                windowsB.some(wb => wa.startUtc <= wb.endUtc && wa.endUtc >= wb.startUtc)
            );

            if (intersects) {
                overlaps.push({ a, b, tier: tierA, blocking: a.tier_priority === b.tier_priority });
            }
        }
    }

    return overlaps;
}

/* ==========================================
   MASTER RESOLVER
   ========================================== */

const CLASSIC_RESULT = Object.freeze({
    resolvedThemeKey: "classic",
    resolvedReason: "classic:default",
    accentIntensity: 1.0,
    graphicsVisibility: "normal",
    sourceScheduleId: null
});

/**
 * The full priority resolution: manual override (if not expired) ->
 * holiday -> season -> Classic. Within a tier, the highest
 * tier_priority wins; a genuine tie falls back to the most-recently-
 * updated entry (a defensive last resort only -- publish_theme_
 * schedule() already refuses to publish an equal-priority overlap,
 * so this should never actually decide anything in a normally-
 * published schedule) and the returned reason is explicitly flagged
 * as a conflict so it's never mistaken for an ordinary resolution
 * wherever it's read.
 *
 * @param {object} params
 * @param {Record<string,{key:string,tier:string|null}>} params.catalogByKey
 * @param {object[]} params.scheduleEntries -- normally theme_schedules_published's rows
 * @param {{theme_key:string, ends_at:string|null}|null} params.manualOverride
 * @param {Date} params.nowUtc
 * @param {string} [params.timeZone]
 */
export function resolveActiveTheme({ catalogByKey, scheduleEntries, manualOverride, nowUtc, timeZone = DEFAULT_TIMEZONE }) {
    if (manualOverride && manualOverride.theme_key) {
        const notExpired = !manualOverride.ends_at || new Date(manualOverride.ends_at) > nowUtc;
        if (notExpired) {
            return {
                resolvedThemeKey: manualOverride.theme_key,
                resolvedReason: "manual_override",
                accentIntensity: 1.0,
                graphicsVisibility: "normal",
                sourceScheduleId: null
            };
        }
    }

    for (const tier of ["holiday", "season"]) {
        const active = (scheduleEntries || [])
            .filter(e => e && e.enabled && catalogByKey?.[e.theme_key]?.tier === tier)
            .map(entry => ({ entry, ...isEntryActiveAt(entry, nowUtc, timeZone) }))
            .filter(r => r.active);

        if (active.length === 0) continue;

        active.sort((x, y) => {
            if (y.entry.tier_priority !== x.entry.tier_priority) return y.entry.tier_priority - x.entry.tier_priority;
            const xUpdated = x.entry.updated_at ? new Date(x.entry.updated_at).getTime() : 0;
            const yUpdated = y.entry.updated_at ? new Date(y.entry.updated_at).getTime() : 0;
            return yUpdated - xUpdated;
        });

        const winner = active[0].entry;
        const tied = active.filter(r => r.entry.tier_priority === winner.tier_priority);
        const reason = tied.length > 1
            ? `${tier}:conflict:${tied.map(r => r.entry.theme_key).sort().join(",")}`
            : `${tier}:${winner.theme_key}`;

        return {
            resolvedThemeKey: winner.theme_key,
            resolvedReason: reason,
            accentIntensity: winner.accent_intensity ?? 1.0,
            graphicsVisibility: winner.graphics_visibility ?? "normal",
            sourceScheduleId: winner.id ?? null
        };
    }

    return { ...CLASSIC_RESULT };
}
