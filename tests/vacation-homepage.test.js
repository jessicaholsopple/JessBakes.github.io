"use strict";

/* ==========================================
   Vacation Mode homepage section (js/vacation-homepage.js)

   Covers: the section stays hidden with no active cycle; renders
   heading/message/reopen date and mounts the subscribe widget when
   active; shows the ballot teaser only when an active ballot exists,
   and omits it cleanly (no empty card) otherwise; the marketing
   sections (.js-vacation-hide -- hero, Stay Updated, Current
   Favorites, suggestion form, Community Favorites, closing promo)
   are revealed only when vacation is confirmed INACTIVE, and left
   untouched (still hidden, their default state in the real HTML)
   when active; a watchdog reveals the normal homepage if the status
   check never resolves, so a bug can never leave the homepage
   permanently blank.

   Same node:vm sandbox technique as the other vacation-mode tests.
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

function makeSupabaseClient({ vacationRow = null, ballotRow = null, vacationError = null } = {}) {
    const callLog = [];
    return {
        callLog,
        from(table) {
            callLog.push(table);
            if (table === "vacation_periods") {
                return { select: () => ({ maybeSingle: () => Promise.resolve({ data: vacationRow, error: vacationError }) }) };
            }
            if (table === "ballot_settings") {
                return {
                    select: () => ({
                        eq: () => ({
                            limit: () => ({
                                maybeSingle: () => Promise.resolve({ data: ballotRow, error: null })
                            })
                        })
                    })
                };
            }
            throw new Error("Unexpected table queried by vacation-homepage.js: " + table);
        }
    };
}

function loadHomepageSandbox(options) {
    const elements = new Map();
    function fakeElement(id) {
        if (!elements.has(id)) {
            elements.set(id, {
                id, value: "", textContent: "", innerHTML: "", style: {}, hidden: false,
                addEventListener: () => {}
            });
        }
        return elements.get(id);
    }

    // Simulates the 6 real .js-vacation-hide elements, each starting
    // hidden:true (their default state in the real HTML).
    const marketingElements = ["hero", "divider", "currentFavorites", "suggestion", "communityFavorites", "promo"]
        .map(name => ({ name, hidden: true }));

    const supabaseClient = makeSupabaseClient(options);
    const timeouts = [];

    const fakeDocument = {
        addEventListener: () => {},
        getElementById: (id) => fakeElement(id),
        querySelectorAll: (selector) => (selector === ".js-vacation-hide" ? marketingElements : [])
    };

    const sandbox = {
        document: fakeDocument,
        window: {},
        console,
        supabaseClient,
        setTimeout: (fn, ms) => { const rec = { fn, ms, cleared: false }; timeouts.push(rec); return rec; },
        clearTimeout: (rec) => { if (rec) rec.cleared = true; }
    };
    vm.createContext(sandbox);

    const source = [
        read("js/vacation-mode.js"),
        read("js/subscribe-widget.js"),
        read("js/vacation-homepage.js"),
        `
        this.__initVacationHomepageSection = initVacationHomepageSection;
        this.__showNormalHomepage = showNormalHomepage;
        `
    ].join("\n");

    vm.runInContext(source, sandbox);

    return { sandbox, elements, supabaseClient, marketingElements, timeouts };
}

test("1. section stays hidden and untouched when no vacation is active", async () => {
    const { sandbox, elements } = loadHomepageSandbox({ vacationRow: null });
    elements.set("vacationSection", { id: "vacationSection", hidden: false });

    await sandbox.__initVacationHomepageSection();

    assert.equal(elements.get("vacationSection").hidden, true);
});

test("2. section renders heading/message/reopen date and un-hides when a cycle is active", async () => {
    const { sandbox, elements } = loadHomepageSandbox({
        vacationRow: {
            id: "cycle-1",
            heading: "We're away!",
            message: "Back before you know it.",
            reopen_at: "2026-09-14T10:30:00.000Z"
        }
    });
    elements.set("vacationSection", { id: "vacationSection", hidden: true });

    await sandbox.__initVacationHomepageSection();

    assert.equal(elements.get("vacationSection").hidden, false);
    assert.equal(elements.get("vacationHeading").textContent, "We're away!");
    assert.equal(elements.get("vacationMessage").textContent, "Back before you know it.");
    assert.match(elements.get("vacationReopenDate").textContent, /September 14, 2026/);
});

test("3. ballot teaser shown when an active ballot exists", async () => {
    const { sandbox, elements } = loadHomepageSandbox({
        vacationRow: { id: "cycle-1", heading: "Away" },
        ballotRow: { id: "ballot-1" }
    });

    await sandbox.__initVacationHomepageSection();

    assert.equal(elements.get("vacationBallotTeaser").hidden, false);
});

test("4. ballot teaser omitted cleanly (hidden, not an empty visible card) when no ballot is active", async () => {
    const { sandbox, elements } = loadHomepageSandbox({
        vacationRow: { id: "cycle-1", heading: "Away" },
        ballotRow: null
    });

    await sandbox.__initVacationHomepageSection();

    assert.equal(elements.get("vacationBallotTeaser").hidden, true);
});

test("5. mounts the subscribe widget with source 'vacation_homepage'", async () => {
    const { sandbox, elements } = loadHomepageSandbox({ vacationRow: { id: "cycle-1", heading: "Away" } });

    await sandbox.__initVacationHomepageSection();

    assert.match(elements.get("vacationSubscribeMount").innerHTML, /vacationSubscribeForm/);
});

test("6. a missing #vacationSection container is a silent no-op (page without the shell markup)", async () => {
    const { sandbox } = loadHomepageSandbox({ vacationRow: { id: "cycle-1" } });
    // No pre-seeded "vacationSection" element -- getElementById will
    // still lazily return a stub via our fake document, so instead we
    // simulate the real "missing container" case directly.
    sandbox.document.getElementById = () => null;

    await assert.doesNotReject(() => sandbox.__initVacationHomepageSection());
});

test("7. a missing reopen_at shows a graceful fallback, never 'Invalid Date'", async () => {
    const { sandbox, elements } = loadHomepageSandbox({
        vacationRow: { id: "cycle-1", heading: "Away", reopen_at: null }
    });

    await sandbox.__initVacationHomepageSection();

    assert.doesNotMatch(elements.get("vacationReopenDate").textContent, /Invalid/);
    assert.match(elements.get("vacationReopenDate").textContent, /check back/i);
});

/* ==========================================
   Marketing-section hide/reveal (.js-vacation-hide)
   ========================================== */

test("8. inactive vacation -> every .js-vacation-hide marketing section is revealed", async () => {
    const { sandbox, marketingElements } = loadHomepageSandbox({ vacationRow: null });

    await sandbox.__initVacationHomepageSection();

    assert.ok(marketingElements.every(el => el.hidden === false), "every marketing section must be revealed when inactive");
});

test("9. active vacation -> marketing sections are left untouched (still hidden, their default state)", async () => {
    const { sandbox, marketingElements } = loadHomepageSandbox({ vacationRow: { id: "cycle-1", heading: "Away" } });

    await sandbox.__initVacationHomepageSection();

    assert.ok(marketingElements.every(el => el.hidden === true), "marketing sections must stay hidden while vacation is active");
});

test("10. a vacation-status query error fails OPEN -- shows the normal homepage rather than a blank one", async () => {
    const { sandbox, marketingElements } = loadHomepageSandbox({ vacationError: { message: "boom" } });

    await sandbox.__initVacationHomepageSection();

    assert.ok(marketingElements.every(el => el.hidden === false));
});

test("11. showNormalHomepage() directly reveals every marketing section and hides the vacation section", () => {
    const { sandbox, elements, marketingElements } = loadHomepageSandbox({});
    elements.set("vacationSection", { id: "vacationSection", hidden: false });

    sandbox.__showNormalHomepage();

    assert.ok(marketingElements.every(el => el.hidden === false));
    assert.equal(elements.get("vacationSection").hidden, true);
});

test("12. the watchdog timeout is registered and cleared once the status check resolves normally", async () => {
    const { sandbox, timeouts } = loadHomepageSandbox({ vacationRow: null });

    await sandbox.__initVacationHomepageSection();

    assert.equal(timeouts.length, 1);
    assert.equal(timeouts[0].cleared, true, "the watchdog must be cancelled once resolution happens in time");
});

/* ==========================================
   Static index.html structure -- locks down the real markup, not
   just the simulated sandbox, against regressions.
   ========================================== */

test("14. index.html: every .js-vacation-hide marketing section starts with the hidden attribute (no flash of normal content while JS is still loading)", () => {
    const html = read("index.html");
    const taggedSections = html.match(/<[a-z]+[^>]*class="[^"]*js-vacation-hide[^"]*"[^>]*>/g) || [];
    assert.ok(taggedSections.length >= 6, "expected hero, its divider, Current Favorites, suggestion form, Community Favorites, and the closing promo section");
    for (const tag of taggedSections) {
        assert.match(tag, /\bhidden\b/, `element missing default hidden attribute: ${tag}`);
    }
});

test("15. index.html: #vacationSection also starts hidden by default", () => {
    const html = read("index.html");
    const tag = html.match(/<section id="vacationSection"[^>]*>/)[0];
    assert.match(tag, /\bhidden\b/);
});

test("16. index.html: a <noscript> fallback forces the normal homepage visible when JavaScript is unavailable", () => {
    const html = read("index.html");
    assert.match(html, /<noscript>.*js-vacation-hide\{display:block/);
});

test("17. index.html: the 'See the Menu' button no longer exists in the Vacation Mode box", () => {
    const html = read("index.html");
    const section = html.slice(html.indexOf('<section id="vacationSection"'), html.indexOf("</section>", html.indexOf('<section id="vacationSection"')));
    assert.doesNotMatch(section, /See the Menu/);
});

test("18. index.html: with hero/Current Favorites/suggestion/Community Favorites/promo all hidden, the surviving visible top-level sections are nav, vacation box, ballot, then footer, in that DOM order", () => {
    const html = read("index.html");
    const markers = ["<header class=\"site-header\">", "<section id=\"vacationSection\"", "<section class=\"ballot-section\">", "<footer class=\"footer\">"];
    const positions = markers.map(m => html.indexOf(m));
    assert.ok(positions.every(p => p !== -1), "one or more expected landmark elements not found");
    for (let i = 1; i < positions.length; i++) {
        assert.ok(positions[i] > positions[i - 1], `expected ${markers[i - 1]} to appear before ${markers[i]}`);
    }
});

test("13. if resolution never happens, firing the watchdog reveals the normal homepage (fail-safe, never permanently blank)", async () => {
    const { sandbox, marketingElements, timeouts } = loadHomepageSandbox({ vacationRow: { id: "cycle-1" } });

    // Simulate a hang: replace the vacation-status fetch with a promise
    // that never resolves, exactly like a network request that never
    // completes.
    sandbox.supabaseClient.from = () => ({ select: () => ({ maybeSingle: () => new Promise(() => {}) }) });

    // Don't await -- it will never resolve on its own in this test.
    sandbox.__initVacationHomepageSection();
    // Let the microtask queue settle so the watchdog has been registered.
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(timeouts.length, 1);
    assert.equal(timeouts[0].cleared, false, "watchdog must still be pending while the fetch hangs");

    // Fire the watchdog manually (this test's setTimeout stub never
    // fires on its own).
    timeouts[0].fn();

    assert.ok(marketingElements.every(el => el.hidden === false), "the watchdog firing must reveal the normal homepage");
});
