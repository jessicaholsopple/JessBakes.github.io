"use strict";

/* ==========================================
   Reusable signup component (js/subscribe-widget.js)

   Covers: at least one preference is required before it ever calls
   the Edge Function; the honeypot/email/preferences/source payload
   shape sent to newsletter-subscribe; and the success/error messaging
   for each response shape the function can return (new subscriber,
   already-subscribed-no-change, preferences-updated, rate-limited,
   generic failure, transport error).

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

function loadWidgetSandbox(invokeResult) {
    const elements = new Map();
    function fakeElement(id) {
        if (!elements.has(id)) {
            elements.set(id, {
                id, value: "", textContent: "", innerHTML: "", checked: false, disabled: false,
                addEventListener: () => {},
                reset: () => {}
            });
        }
        return elements.get(id);
    }

    const invokeCalls = [];
    const supabaseClient = {
        functions: {
            invoke: (name, opts) => {
                invokeCalls.push({ name, opts });
                if (invokeResult instanceof Error) {
                    return Promise.resolve({ data: null, error: invokeResult });
                }
                return Promise.resolve({ data: invokeResult, error: null });
            }
        }
    };

    const fakeDocument = {
        getElementById: (id) => fakeElement(id)
    };

    const sandbox = { document: fakeDocument, window: {}, console, supabaseClient };
    vm.createContext(sandbox);

    const source = [
        read("js/subscribe-widget.js"),
        `
        this.__mountSubscribeWidget = mountSubscribeWidget;
        `
    ].join("\n");

    vm.runInContext(source, sandbox);

    return { sandbox, elements, invokeCalls, fakeElement };
}

function seedForm(elements, { email = "customer@example.com", reopening = false, menu = false, updates = false, honeypot = "" } = {}) {
    elements.set("vacationSubscribeEmail", { value: email });
    elements.set("vacationSubscribePrefReopening", { checked: reopening });
    elements.set("vacationSubscribePrefMenu", { checked: menu });
    elements.set("vacationSubscribePrefUpdates", { checked: updates });
    elements.set("vacationSubscribeWebsite", { value: honeypot });
    elements.set("vacationSubscribeSubmit", { disabled: false });
    elements.set("vacationSubscribeMessage", { textContent: "" });
}

function fakeEvent() {
    let defaultPrevented = false;
    return { preventDefault: () => { defaultPrevented = true; }, wasPrevented: () => defaultPrevented };
}

test("1. mountSubscribeWidget renders the form into the given container and no-ops silently for a missing container", () => {
    const { sandbox, elements } = loadWidgetSandbox({ ok: true, alreadySubscribed: false });
    elements.set("mountPoint", { innerHTML: "" });

    sandbox.__mountSubscribeWidget("mountPoint", "vacation_homepage");
    assert.match(elements.get("mountPoint").innerHTML, /vacationSubscribeForm/);

    assert.doesNotThrow(() => {
        const { sandbox: s2 } = loadWidgetSandbox({ ok: true });
        s2.document.getElementById = () => null;
        s2.__mountSubscribeWidget("missing", "vacation_menu");
    });
});

test("2. submitting with no preference selected shows a message and never calls the Edge Function", async () => {
    const { sandbox, elements, invokeCalls } = loadWidgetSandbox({ ok: true, alreadySubscribed: false });
    elements.set("mountPoint", { innerHTML: "" });
    sandbox.__mountSubscribeWidget("mountPoint", "vacation_homepage");
    seedForm(elements, { reopening: false, menu: false, updates: false });

    await sandbox.submitSubscribeWidget(fakeEvent(), "vacation_homepage");

    assert.equal(invokeCalls.length, 0);
    assert.match(elements.get("vacationSubscribeMessage").textContent, /at least one/i);
});

test("3. submitting with one preference selected calls newsletter-subscribe with the correct payload and source", async () => {
    const { sandbox, elements, invokeCalls } = loadWidgetSandbox({ ok: true, alreadySubscribed: false });
    elements.set("mountPoint", { innerHTML: "" });
    sandbox.__mountSubscribeWidget("mountPoint", "vacation_menu");
    seedForm(elements, { email: "Customer@Example.com", reopening: true });

    await sandbox.submitSubscribeWidget(fakeEvent(), "vacation_menu");

    assert.equal(invokeCalls.length, 1);
    assert.equal(invokeCalls[0].name, "newsletter-subscribe");
    assert.equal(invokeCalls[0].opts.body.email, "customer@example.com");
    assert.equal(invokeCalls[0].opts.body.source, "vacation_menu");
    // Compared by JSON, not assert.deepEqual: the preferences object is
    // constructed inside the vm sandbox's separate realm, so it has a
    // different Object.prototype than this test's literal even though
    // the shape is identical -- deepStrictEqual's prototype check would
    // otherwise fail for a reason unrelated to what's being verified.
    assert.equal(
        JSON.stringify(invokeCalls[0].opts.body.preferences),
        JSON.stringify({ reopeningAlerts: true, menuAnnouncements: false, generalUpdates: false })
    );
    assert.equal(invokeCalls[0].opts.body.honeypot, "");
});

test("4. a filled honeypot is still sent through (server decides, client never short-circuits on it)", async () => {
    const { sandbox, elements, invokeCalls } = loadWidgetSandbox({ ok: false, reason: "honeypot" });
    elements.set("mountPoint", { innerHTML: "" });
    sandbox.__mountSubscribeWidget("mountPoint", "vacation_homepage");
    seedForm(elements, { menu: true, honeypot: "I am a bot" });

    await sandbox.submitSubscribeWidget(fakeEvent(), "vacation_homepage");

    assert.equal(invokeCalls.length, 1);
    assert.equal(invokeCalls[0].opts.body.honeypot, "I am a bot");
});

test("5. success message: brand new subscriber", async () => {
    const { sandbox, elements } = loadWidgetSandbox({ ok: true, alreadySubscribed: false, preferencesUpdated: true });
    elements.set("mountPoint", { innerHTML: "" });
    sandbox.__mountSubscribeWidget("mountPoint", "vacation_homepage");
    seedForm(elements, { menu: true });

    await sandbox.submitSubscribeWidget(fakeEvent(), "vacation_homepage");

    assert.match(elements.get("vacationSubscribeMessage").textContent, /thanks for subscribing/i);
});

test("6. success message: already subscribed, preferences actually changed", async () => {
    const { sandbox, elements } = loadWidgetSandbox({ ok: true, alreadySubscribed: true, preferencesUpdated: true });
    elements.set("mountPoint", { innerHTML: "" });
    sandbox.__mountSubscribeWidget("mountPoint", "vacation_homepage");
    seedForm(elements, { reopening: true });

    await sandbox.submitSubscribeWidget(fakeEvent(), "vacation_homepage");

    assert.match(elements.get("vacationSubscribeMessage").textContent, /preferences updated/i);
});

test("7. success message: already subscribed, nothing new selected", async () => {
    const { sandbox, elements } = loadWidgetSandbox({ ok: true, alreadySubscribed: true, preferencesUpdated: false });
    elements.set("mountPoint", { innerHTML: "" });
    sandbox.__mountSubscribeWidget("mountPoint", "vacation_homepage");
    seedForm(elements, { menu: true });

    await sandbox.submitSubscribeWidget(fakeEvent(), "vacation_homepage");

    assert.match(elements.get("vacationSubscribeMessage").textContent, /already subscribed/i);
});

test("8. rate-limited response shows its own friendly message", async () => {
    const { sandbox, elements } = loadWidgetSandbox({ ok: false, reason: "rate_limited" });
    elements.set("mountPoint", { innerHTML: "" });
    sandbox.__mountSubscribeWidget("mountPoint", "vacation_homepage");
    seedForm(elements, { menu: true });

    await sandbox.submitSubscribeWidget(fakeEvent(), "vacation_homepage");

    assert.match(elements.get("vacationSubscribeMessage").textContent, /wait a moment/i);
});

test("9. generic/invalid-email failure never reveals a specific server reason to the visitor", async () => {
    const { sandbox, elements } = loadWidgetSandbox({ ok: false, reason: "preference_required" });
    elements.set("mountPoint", { innerHTML: "" });
    sandbox.__mountSubscribeWidget("mountPoint", "vacation_homepage");
    seedForm(elements, { menu: true });

    await sandbox.submitSubscribeWidget(fakeEvent(), "vacation_homepage");

    assert.match(elements.get("vacationSubscribeMessage").textContent, /valid email/i);
});

test("10. a transport error (network failure) shows a generic retry message", async () => {
    const { sandbox, elements } = loadWidgetSandbox(new Error("network down"));
    elements.set("mountPoint", { innerHTML: "" });
    sandbox.__mountSubscribeWidget("mountPoint", "vacation_homepage");
    seedForm(elements, { menu: true });

    await sandbox.submitSubscribeWidget(fakeEvent(), "vacation_homepage");

    assert.match(elements.get("vacationSubscribeMessage").textContent, /something went wrong/i);
});

test("11. the submit button is disabled during the request and re-enabled afterward", async () => {
    const { sandbox, elements } = loadWidgetSandbox({ ok: true, alreadySubscribed: false });
    elements.set("mountPoint", { innerHTML: "" });
    sandbox.__mountSubscribeWidget("mountPoint", "vacation_homepage");
    seedForm(elements, { menu: true });

    await sandbox.submitSubscribeWidget(fakeEvent(), "vacation_homepage");

    assert.equal(elements.get("vacationSubscribeSubmit").disabled, false);
});

test("12. event.preventDefault() is always called (form never does a real page navigation)", async () => {
    const { sandbox, elements } = loadWidgetSandbox({ ok: true, alreadySubscribed: false });
    elements.set("mountPoint", { innerHTML: "" });
    sandbox.__mountSubscribeWidget("mountPoint", "vacation_homepage");
    seedForm(elements, { menu: true });

    const event = fakeEvent();
    await sandbox.submitSubscribeWidget(event, "vacation_homepage");

    assert.equal(event.wasPrevented(), true);
});
