"use strict";

/* ==========================================
   Vacation Mode notice on the public Menu page (js/menu.js)

   Covers loadMenu()'s new vacation branch: when a cycle is active, no
   orderable menu is ever fetched/rendered and initializeCart() is
   never called (so no Add to Cart button, floating cart, or checkout
   modal can exist); when inactive, the pre-existing menu rendering is
   unaffected (regression). Also covers the "link to the ballot only
   when one is actually active" requirement.

   Same node:vm sandbox technique as tests/menu-item-archive.test.js.
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

function makeSupabaseClient({ vacationRow = null, ballotRow = null, menuItems = [] } = {}) {
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
            if (table === "menu_items") {
                return {
                    select: () => ({
                        eq: () => ({
                            order: () => ({
                                order: () => ({
                                    order: () => Promise.resolve({ data: menuItems, error: null })
                                })
                            })
                        })
                    })
                };
            }
            throw new Error("Unexpected table queried by menu.js vacation logic: " + table);
        }
    };
}

function loadMenuSandbox(options) {
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

    const sandbox = {
        document: fakeDocument,
        window: {},
        console,
        supabaseClient
    };
    vm.createContext(sandbox);

    const source = [
        read("js/vacation-mode.js"),
        read("js/subscribe-widget.js"),
        read("js/menu.js"),
        `
        this.__loadMenu = loadMenu;
        `
    ].join("\n");

    vm.runInContext(source, sandbox);

    return { sandbox, elements, supabaseClient, fakeElement };
}

test("1. loadMenu renders a vacation notice and never fetches menu_items while a cycle is active", async () => {
    const { sandbox, elements, supabaseClient } = loadMenuSandbox({
        vacationRow: { id: "cycle-1", heading: "Away for a bit!", message: "Back soon.", reopen_at: "2026-09-14T10:30:00.000Z" }
    });

    await sandbox.__loadMenu();

    const container = elements.get("menuContainer");
    assert.match(container.innerHTML, /Away for a bit!/);
    assert.match(container.innerHTML, /Back soon\./);
    assert.match(container.innerHTML, /Ordering reopens/);
    assert.ok(!supabaseClient.callLog.includes("menu_items"), "menu_items must never be queried while on vacation");
});

test("2. loadMenu never calls initializeCart (no Add to Cart control possible) while a cycle is active", async () => {
    let initializeCartCalled = false;
    const { sandbox } = loadMenuSandbox({ vacationRow: { id: "cycle-1", heading: "Away" } });
    sandbox.initializeCart = () => { initializeCartCalled = true; };

    await sandbox.__loadMenu();

    assert.equal(initializeCartCalled, false);
});

test("3. loadMenu's vacation notice shows the ballot link only when an active ballot exists", async () => {
    const { sandbox, elements } = loadMenuSandbox({
        vacationRow: { id: "cycle-1", heading: "Away" },
        ballotRow: { id: "ballot-1" }
    });

    await sandbox.__loadMenu();

    const link = elements.get("menuVacationBallotLink");
    assert.equal(link.hidden, false);
});

test("4. loadMenu's vacation notice omits the ballot link cleanly when no ballot is active", async () => {
    const { sandbox, elements } = loadMenuSandbox({
        vacationRow: { id: "cycle-1", heading: "Away" },
        ballotRow: null
    });

    await sandbox.__loadMenu();

    const link = elements.get("menuVacationBallotLink");
    assert.equal(link.hidden, true);
});

test("5. loadMenu mounts the subscribe widget into the vacation notice", async () => {
    const { sandbox, elements } = loadMenuSandbox({ vacationRow: { id: "cycle-1", heading: "Away" } });

    await sandbox.__loadMenu();

    // mountSubscribeWidget replaces the mount point's innerHTML with
    // the widget form -- confirms it actually ran, not just that the
    // (empty) mount div exists.
    const mount = elements.get("menuVacationSubscribeMount");
    assert.match(mount.innerHTML, /vacationSubscribeForm/);
});

test("6. loadMenu renders the normal orderable menu when no vacation is active (regression)", async () => {
    const { sandbox, elements, supabaseClient } = loadMenuSandbox({
        vacationRow: null,
        menuItems: [{ id: "1", name: "Sourdough Boule", price: 8, category: "bread", available: true, product_type: "standard" }]
    });

    await sandbox.__loadMenu();

    const container = elements.get("menuContainer");
    assert.match(container.innerHTML, /Sourdough Boule/);
    assert.match(container.innerHTML, /Add to Cart/);
    assert.ok(supabaseClient.callLog.includes("menu_items"));
});

test("7. loadMenu checks vacation status BEFORE ever querying menu_items, even on the normal (inactive) path", async () => {
    const { sandbox, supabaseClient } = loadMenuSandbox({ vacationRow: null, menuItems: [] });
    await sandbox.__loadMenu();
    assert.equal(supabaseClient.callLog[0], "vacation_periods");
});
