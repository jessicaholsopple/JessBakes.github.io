"use strict";

/* ==========================================
   js/vacation-mode.js -- pure logic tests

   Covers the client-side eligibility mirror of
   public.vacation_eligible_subscribers() (kept in sync by hand -- see
   the header comment in js/vacation-mode.js and the SQL function in
   supabase/migrations/20260827094500_vacation_eligible_subscribers_fn.sql),
   the menu-snapshot staleness key used to gate reopening-email
   preview freshness, and the full readiness gate that decides whether
   the "Automatically send..." scheduled-reopening toggle may be
   turned on.
   ========================================== */

const test = require("node:test");
const assert = require("node:assert/strict");
const VacationMode = require("../js/vacation-mode.js");

/* ==========================================
   isVacationActive
   ========================================== */

test("1. isVacationActive is true for a real active-cycle row, false for null/undefined", () => {
    assert.equal(VacationMode.isVacationActive({ id: "cycle-1", heading: "Away" }), true);
    assert.equal(VacationMode.isVacationActive(null), false);
    assert.equal(VacationMode.isVacationActive(undefined), false);
    assert.equal(VacationMode.isVacationActive({}), false);
});

/* ==========================================
   buildMenuSnapshotKey
   ========================================== */

test("2. buildMenuSnapshotKey is order-independent", () => {
    const a = [
        { id: "1", name: "Sourdough Loaf", price: 8, available: true },
        { id: "2", name: "Chocolate Chip Cookie", price: 3, available: true }
    ];
    const b = [
        { id: "2", name: "Chocolate Chip Cookie", price: 3, available: true },
        { id: "1", name: "Sourdough Loaf", price: 8, available: true }
    ];
    assert.equal(VacationMode.buildMenuSnapshotKey(a), VacationMode.buildMenuSnapshotKey(b));
});

test("3. buildMenuSnapshotKey excludes unavailable items -- toggling one doesn't count as a menu change unless it flips availability", () => {
    const withHiddenItem = [
        { id: "1", name: "Sourdough Loaf", price: 8, available: true },
        { id: "9", name: "Retired Seasonal Pie", price: 12, available: false }
    ];
    const withoutHiddenItem = [
        { id: "1", name: "Sourdough Loaf", price: 8, available: true }
    ];
    assert.equal(
        VacationMode.buildMenuSnapshotKey(withHiddenItem),
        VacationMode.buildMenuSnapshotKey(withoutHiddenItem)
    );
});

test("4. buildMenuSnapshotKey changes when an available item's price/name/description changes", () => {
    const before = [{ id: "1", name: "Sourdough Loaf", price: 8, available: true, description: "Classic" }];
    const afterPriceChange = [{ id: "1", name: "Sourdough Loaf", price: 9, available: true, description: "Classic" }];
    const afterDescriptionChange = [{ id: "1", name: "Sourdough Loaf", price: 8, available: true, description: "New recipe" }];

    const beforeKey = VacationMode.buildMenuSnapshotKey(before);
    assert.notEqual(beforeKey, VacationMode.buildMenuSnapshotKey(afterPriceChange));
    assert.notEqual(beforeKey, VacationMode.buildMenuSnapshotKey(afterDescriptionChange));
});

test("5. buildMenuSnapshotKey changes when an item becomes available/unavailable (inclusion changes)", () => {
    const oneAvailable = [{ id: "1", name: "Sourdough Loaf", price: 8, available: true }];
    const twoAvailable = [
        { id: "1", name: "Sourdough Loaf", price: 8, available: true },
        { id: "2", name: "Cinnamon Roll", price: 5, available: true }
    ];
    assert.notEqual(
        VacationMode.buildMenuSnapshotKey(oneAvailable),
        VacationMode.buildMenuSnapshotKey(twoAvailable)
    );
});

test("6. buildMenuSnapshotKey handles an empty/missing menu without throwing", () => {
    assert.equal(VacationMode.buildMenuSnapshotKey([]), VacationMode.buildMenuSnapshotKey(null));
    assert.doesNotThrow(() => VacationMode.buildMenuSnapshotKey(undefined));
});

/* ==========================================
   isRecipientEligible -- mirrors
   public.vacation_eligible_subscribers(p_cycle_id)
   ========================================== */

test("7. isRecipientEligible: active + menu_announcements is eligible regardless of reopening pref", () => {
    assert.equal(
        VacationMode.isRecipientEligible(
            { status: "active", pref_menu_announcements: true, pref_reopening_alerts: false },
            "cycle-a"
        ),
        true
    );
});

test("8. isRecipientEligible: active + reopening_alerts, never fulfilled, is eligible", () => {
    assert.equal(
        VacationMode.isRecipientEligible(
            {
                status: "active",
                pref_menu_announcements: false,
                pref_reopening_alerts: true,
                reopening_alert_fulfilled_cycle_id: null
            },
            "cycle-a"
        ),
        true
    );
});

test("9. isRecipientEligible: reopening_alerts already fulfilled for THIS cycle is not eligible again", () => {
    assert.equal(
        VacationMode.isRecipientEligible(
            {
                status: "active",
                pref_menu_announcements: false,
                pref_reopening_alerts: true,
                reopening_alert_fulfilled_cycle_id: "cycle-a"
            },
            "cycle-a"
        ),
        false
    );
});

test("10. isRecipientEligible: reopening_alerts fulfilled for a DIFFERENT (past) cycle is eligible again for a new one", () => {
    assert.equal(
        VacationMode.isRecipientEligible(
            {
                status: "active",
                pref_menu_announcements: false,
                pref_reopening_alerts: true,
                reopening_alert_fulfilled_cycle_id: "cycle-old"
            },
            "cycle-new"
        ),
        true
    );
});

test("11. isRecipientEligible: only general_updates selected is NOT eligible", () => {
    assert.equal(
        VacationMode.isRecipientEligible(
            {
                status: "active",
                pref_menu_announcements: false,
                pref_reopening_alerts: false,
                pref_general_updates: true
            },
            "cycle-a"
        ),
        false
    );
});

test("12. isRecipientEligible: non-active status is never eligible even with matching preferences", () => {
    for (const status of ["unsubscribed", "bounced", "complained"]) {
        assert.equal(
            VacationMode.isRecipientEligible(
                { status, pref_menu_announcements: true, pref_reopening_alerts: true },
                "cycle-a"
            ),
            false
        );
    }
});

test("13. isRecipientEligible: null/undefined subscriber never throws, never eligible", () => {
    assert.equal(VacationMode.isRecipientEligible(null, "cycle-a"), false);
    assert.equal(VacationMode.isRecipientEligible(undefined, "cycle-a"), false);
});

test("13a. isRecipientEligible: menu_announcements category turned OFF excludes an otherwise-eligible subscriber", () => {
    assert.equal(
        VacationMode.isRecipientEligible(
            { status: "active", pref_menu_announcements: true, pref_reopening_alerts: false },
            "cycle-a",
            { reopeningAlerts: true, menuAnnouncements: false, generalUpdates: false }
        ),
        false
    );
});

test("13b. isRecipientEligible: general_updates category turned ON includes a general-updates-only subscriber", () => {
    assert.equal(
        VacationMode.isRecipientEligible(
            { status: "active", pref_menu_announcements: false, pref_reopening_alerts: false, pref_general_updates: true },
            "cycle-a",
            { reopeningAlerts: true, menuAnnouncements: true, generalUpdates: true }
        ),
        true
    );
});

test("13c. isRecipientEligible: omitting categories defaults to reopening+menu, matching the SQL function's own default", () => {
    assert.equal(
        VacationMode.isRecipientEligible(
            { status: "active", pref_menu_announcements: true },
            "cycle-a"
        ),
        true
    );
    assert.equal(
        VacationMode.isRecipientEligible(
            { status: "active", pref_general_updates: true },
            "cycle-a"
        ),
        false
    );
});

/* ==========================================
   describeRecipientCategories
   ========================================== */

test("14. describeRecipientCategories lists only the enabled categories, in a stable order", () => {
    assert.deepEqual(
        VacationMode.describeRecipientCategories({
            recipients_reopening_alerts: true,
            recipients_menu_announcements: true,
            recipients_general_updates: false
        }),
        ["Reopening alerts", "Menu announcements"]
    );
    assert.deepEqual(VacationMode.describeRecipientCategories({}), []);
});

/* ==========================================
   computeReadiness
   ========================================== */

const READY_BASE = {
    reopeningEmailEnabled: true,
    subject: "We're back!",
    pickupAt: "2026-09-10T15:00:00.000Z",
    nowMs: Date.parse("2026-09-01T00:00:00.000Z"),
    previewMenuSnapshotKey: "abc",
    currentMenuSnapshotKey: "abc",
    availableMenuCount: 3,
    eligibleRecipientCount: 12
};

test("15. computeReadiness: all conditions satisfied -> ready with no reasons", () => {
    const result = VacationMode.computeReadiness(READY_BASE);
    assert.equal(result.ready, true);
    assert.deepEqual(result.reasons, []);
});

test("16. computeReadiness: reopening email disabled blocks readiness", () => {
    const result = VacationMode.computeReadiness({ ...READY_BASE, reopeningEmailEnabled: false });
    assert.equal(result.ready, false);
    assert.ok(result.reasons.some(r => /turned off/.test(r)));
});

test("17. computeReadiness: blank subject blocks readiness", () => {
    const result = VacationMode.computeReadiness({ ...READY_BASE, subject: "   " });
    assert.equal(result.ready, false);
    assert.ok(result.reasons.some(r => /subject/i.test(r)));
});

test("18. computeReadiness: missing or past pickup date blocks readiness", () => {
    const missing = VacationMode.computeReadiness({ ...READY_BASE, pickupAt: null });
    assert.equal(missing.ready, false);
    assert.ok(missing.reasons.some(r => /pickup date/i.test(r)));

    const past = VacationMode.computeReadiness({ ...READY_BASE, pickupAt: "2026-08-01T00:00:00.000Z" });
    assert.equal(past.ready, false);
    assert.ok(past.reasons.some(r => /pickup date/i.test(r)));
});

test("19. computeReadiness: no available menu items blocks readiness", () => {
    const result = VacationMode.computeReadiness({ ...READY_BASE, availableMenuCount: 0 });
    assert.equal(result.ready, false);
    assert.ok(result.reasons.some(r => /menu item/i.test(r)));
});

test("20. computeReadiness: stale/missing preview blocks readiness (menu changed since preview)", () => {
    const stale = VacationMode.computeReadiness({ ...READY_BASE, currentMenuSnapshotKey: "different" });
    assert.equal(stale.ready, false);
    assert.ok(stale.reasons.some(r => /preview/i.test(r)));

    const never = VacationMode.computeReadiness({ ...READY_BASE, previewMenuSnapshotKey: null });
    assert.equal(never.ready, false);
    assert.ok(never.reasons.some(r => /preview/i.test(r)));
});

test("21. computeReadiness: zero eligible recipients blocks readiness", () => {
    const result = VacationMode.computeReadiness({ ...READY_BASE, eligibleRecipientCount: 0 });
    assert.equal(result.ready, false);
    assert.ok(result.reasons.some(r => /recipient/i.test(r)));
});

/* ==========================================
   formatBakeryDateTime
   ========================================== */

test("23. formatBakeryDateTime formats a real ISO timestamp in Europe/Berlin, never 'Invalid Date'", () => {
    // 2026-09-14T10:30:00Z is 12:30 PM in Berlin (CEST, UTC+2) in September.
    const label = VacationMode.formatBakeryDateTime("2026-09-14T10:30:00.000Z");
    assert.match(label, /September 14, 2026/);
    assert.match(label, /12:30\s*PM/);
    assert.doesNotMatch(label, /Invalid/);
});

test("24. formatBakeryDateTime returns an empty string for missing/invalid input rather than throwing or showing 'Invalid Date'", () => {
    assert.equal(VacationMode.formatBakeryDateTime(null), "");
    assert.equal(VacationMode.formatBakeryDateTime(undefined), "");
    assert.equal(VacationMode.formatBakeryDateTime(""), "");
    assert.equal(VacationMode.formatBakeryDateTime("not-a-date"), "");
});

test("22. computeReadiness: multiple simultaneous problems are all reported, not just the first", () => {
    const result = VacationMode.computeReadiness({
        ...READY_BASE,
        subject: "",
        availableMenuCount: 0,
        eligibleRecipientCount: 0
    });
    assert.equal(result.ready, false);
    assert.equal(result.reasons.length, 3);
});
