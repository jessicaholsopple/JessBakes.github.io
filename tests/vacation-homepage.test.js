"use strict";

/* ==========================================
   Vacation Mode homepage section (js/vacation-homepage.js)

   Covers: the section stays hidden with no active cycle; renders
   heading/message/reopen date and mounts the subscribe widget when
   active; shows the ballot teaser only when an active ballot exists,
   and omits it cleanly (no empty card) otherwise.

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

function makeSupabaseClient({ vacationRow = null, ballotRow = null } = {}) {
    const callLog = [];
    return {
        callLog,
        from(table) {
            callLog.push(table);
            if (table === "vacation_periods") {
                return { select: () => ({ maybeSingle: () => Promise.resolve({ data: vacationRow, error: null }) }) };
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

    const supabaseClient = makeSupabaseClient(options);

    const fakeDocument = {
        addEventListener: () => {},
        getElementById: (id) => fakeElement(id)
    };

    const sandbox = { document: fakeDocument, window: {}, console, supabaseClient };
    vm.createContext(sandbox);

    const source = [
        read("js/vacation-mode.js"),
        read("js/subscribe-widget.js"),
        read("js/vacation-homepage.js"),
        `
        this.__initVacationHomepageSection = initVacationHomepageSection;
        `
    ].join("\n");

    vm.runInContext(source, sandbox);

    return { sandbox, elements, supabaseClient };
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
