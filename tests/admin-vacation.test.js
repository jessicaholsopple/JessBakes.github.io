"use strict";

/* ==========================================
   Admin Vacation Mode panel (js/admin-vacation.js)

   Covers: starting/editing a cycle, the live eligible-recipient-count
   query shape, readiness/preview-staleness reflected in the UI, the
   resume-review panel's assembled content, the "Resume Without Email"
   extra-confirmation requirement, double-click/idempotent-request
   guarding, and the auto-send toggle only being enabled once every
   readiness condition holds.

   Same node:vm sandbox technique as tests/delete-order.test.js /
   tests/menu-item-archive.test.js.
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

function makeQueryBuilder(table, resolveQuery, callLog, timeline) {
    const state = { table };
    const builder = {
        select(fields) { state.select = fields; return builder; },
        eq(field, value) { state.eq = state.eq || []; state.eq.push([field, value]); return builder; },
        order(field, opts) { state.order = state.order || []; state.order.push([field, opts]); return builder; },
        limit(n) { state.limit = n; return builder; },
        insert(payload) { state.op = "insert"; state.payload = payload; return builder; },
        update(payload) { state.op = "update"; state.payload = payload; return builder; },
        maybeSingle() {
            state.op = state.op || "maybeSingle";
            callLog.push({ ...state });
            if (timeline) timeline.push({ type: "query", table, op: state.op, payload: state.payload });
            return Promise.resolve(resolveQuery(state));
        },
        then(onFulfilled, onRejected) {
            state.op = state.op || "select";
            callLog.push({ ...state });
            if (timeline) timeline.push({ type: "query", table, op: state.op, payload: state.payload });
            return Promise.resolve(resolveQuery(state)).then(onFulfilled, onRejected);
        }
    };
    return builder;
}

function makeSupabaseClient(resolveQuery, resolveRpc, resolveInvoke, timeline) {
    const callLog = [];
    const rpcCalls = [];
    const invokeCalls = [];
    return {
        callLog, rpcCalls, invokeCalls, timeline,
        from(table) { return makeQueryBuilder(table, resolveQuery, callLog, timeline); },
        rpc(name, params) {
            rpcCalls.push({ name, params });
            return Promise.resolve(resolveRpc(name, params));
        },
        functions: {
            invoke(name, opts) {
                invokeCalls.push({ name, opts });
                if (timeline) timeline.push({ type: "invoke", name, body: opts?.body });
                return Promise.resolve(resolveInvoke(name, opts));
            }
        }
    };
}

function loadAdminVacationSandbox({ resolveQuery, resolveRpc, resolveInvoke }) {
    const elements = new Map();
    function fakeElement(id) {
        if (!elements.has(id)) {
            elements.set(id, {
                id, value: "", textContent: "", innerHTML: "", checked: false, disabled: false, style: {}, className: ""
            });
        }
        return elements.get(id);
    }

    const alertCalls = [];
    const timeline = [];
    const supabaseClient = makeSupabaseClient(
        resolveQuery || (() => ({ data: null, error: null })),
        resolveRpc || (() => ({ data: [], error: null })),
        resolveInvoke || (() => ({ data: { ok: true }, error: null })),
        timeline
    );

    const fakeDocument = {
        addEventListener: () => {},
        getElementById: (id) => fakeElement(id)
    };

    const sandbox = {
        document: fakeDocument,
        window: {},
        console,
        supabaseClient,
        alert: (msg) => alertCalls.push(msg),
        requireAuth: async () => {}
    };
    vm.createContext(sandbox);

    const source = [
        read("js/vacation-mode.js"),
        read("js/admin-vacation.js"),
        `
        this.__loadVacationPanel = loadVacationPanel;
        this.__startVacation = startVacation;
        this.__saveVacationDetails = saveVacationDetails;
        this.__saveReopeningEmailDraft = saveReopeningEmailDraft;
        this.__previewVacationEmail = previewVacationEmail;
        this.__sendVacationTestEmail = sendVacationTestEmail;
        this.__renderVacationReadiness = renderVacationReadiness;
        this.__openResumeReviewPanel = openResumeReviewPanel;
        this.__confirmResumeWithEmail = confirmResumeWithEmail;
        this.__confirmResumeWithoutEmail = confirmResumeWithoutEmail;
        this.__showResumeWithoutEmailConfirm = showResumeWithoutEmailConfirm;
        Object.defineProperty(this, '__currentCycle', { get: () => vacationCurrentCycle });
        `
    ].join("\n");

    vm.runInContext(source, sandbox);

    return { sandbox, elements, supabaseClient, alertCalls, timeline };
}

const ACTIVE_CYCLE = {
    id: "cycle-1",
    status: "active",
    heading: "Away",
    message: "Back soon",
    reopen_at: "2026-09-14T10:30:00.000Z",
    next_pickup_at: "2026-09-14T10:30:00.000Z",
    started_at: "2026-08-27T00:00:00.000Z",
    reopening_email_enabled: true,
    email_subject: "We're back!",
    email_preview_text: null,
    email_intro: null,
    recipients_reopening_alerts: true,
    recipients_menu_announcements: true,
    recipients_general_updates: false,
    auto_send_on_resume: false,
    preview_menu_snapshot_key: null,
    preview_generated_at: null,
    campaign_id: null
};

function resolverForActiveCycle(overrides) {
    const cycle = { ...ACTIVE_CYCLE, ...overrides };
    return (state) => {
        if (state.table === "vacation_periods" && state.op === "maybeSingle") {
            const wantsActive = (state.eq || []).some(([f, v]) => f === "status" && v === "active");
            return { data: wantsActive ? cycle : null, error: null };
        }
        if (state.table === "menu_items") {
            return { data: [{ id: "1", name: "Sourdough Boule", price: 8, available: true, description: "", product_type: "standard" }], error: null };
        }
        if (state.table === "ballot_settings") {
            return { data: null, error: null };
        }
        return { data: null, error: null };
    };
}

test("1. loadVacationPanel shows the Not Active view with no active cycle", async () => {
    const { sandbox, elements } = loadAdminVacationSandbox({
        resolveQuery: (state) => ({ data: null, error: null })
    });

    await sandbox.__loadVacationPanel();

    assert.equal(elements.get("vacationNotActiveView").style.display, "block");
    assert.equal(elements.get("vacationActiveView").style.display, "none");
});

test("2. startVacation inserts a new vacation_periods row and refreshes to the Active view", async () => {
    let inserted = null;
    let insertedYet = false;
    const { sandbox, elements } = loadAdminVacationSandbox({
        resolveQuery: (state) => {
            if (state.table === "vacation_periods" && state.op === "insert") {
                inserted = state.payload;
                insertedYet = true;
                return { data: null, error: null };
            }
            if (state.table === "vacation_periods" && state.op === "maybeSingle") {
                const wantsActive = (state.eq || []).some(([f, v]) => f === "status" && v === "active");
                return { data: (wantsActive && insertedYet) ? { ...ACTIVE_CYCLE } : null, error: null };
            }
            if (state.table === "menu_items") return { data: [], error: null };
            return { data: null, error: null };
        }
    });
    elements.set("vacationStartHeading", { value: "Gone baking!" });
    elements.set("vacationStartMessage", { value: "See you soon" });

    await sandbox.__startVacation();

    assert.equal(inserted.heading, "Gone baking!");
    assert.equal(inserted.message, "See you soon");
    assert.equal(elements.get("vacationActiveView").style.display, "block");
});

test("3. saveVacationDetails updates the active cycle's heading/message/dates only", async () => {
    let updatePayload = null;
    const { sandbox, elements } = loadAdminVacationSandbox({
        resolveQuery: (state) => {
            if (state.table === "vacation_periods" && state.op === "update") {
                updatePayload = state.payload;
                return { data: null, error: null };
            }
            return resolverForActiveCycle()(state);
        }
    });
    await sandbox.__loadVacationPanel();
    elements.set("vacationHeadingInput", { value: "Updated heading" });
    elements.set("vacationMessageInput", { value: "Updated message" });
    elements.set("vacationReopenAtInput", { value: "" });
    elements.set("vacationPickupAtInput", { value: "" });

    await sandbox.__saveVacationDetails();

    assert.equal(updatePayload.heading, "Updated heading");
    assert.equal(updatePayload.message, "Updated message");
    // Never touches the reopening-email draft fields.
    assert.equal("email_subject" in updatePayload, false);
});

test("3b. renderVacationActiveView populates the single Additional Message field from email_intro (no separate closing-text field exists anymore)", async () => {
    const { sandbox, elements } = loadAdminVacationSandbox({
        resolveQuery: resolverForActiveCycle({ email_intro: "See you soon!" })
    });

    await sandbox.__loadVacationPanel();

    assert.equal(elements.get("vacationAdditionalMessage").value, "See you soon!");
});

test("4. the live eligible-recipient-count RPC is called with the active cycle's id", async () => {
    const { sandbox, supabaseClient, elements } = loadAdminVacationSandbox({
        resolveQuery: resolverForActiveCycle(),
        resolveRpc: (name) => name === "vacation_eligible_subscribers"
            ? { data: [{ id: "s1" }, { id: "s2" }], error: null }
            : { data: null, error: null }
    });

    await sandbox.__loadVacationPanel();

    assert.equal(supabaseClient.rpcCalls.length, 1);
    assert.equal(supabaseClient.rpcCalls[0].name, "vacation_eligible_subscribers");
    assert.equal(supabaseClient.rpcCalls[0].params.p_cycle_id, "cycle-1");
    assert.equal(elements.get("vacationEligibleCount").textContent, 2);
});

test("5. readiness is Ready once every condition holds (preview matches current menu, recipients > 0, future pickup date)", async () => {
    const menuItems = [{ id: "1", name: "Sourdough Boule", price: 8, available: true, description: "", product_type: "standard" }];
    const snapshotKey = JSON.stringify([{ id: "1", name: "Sourdough Boule", price: 8, description: "", product_type: "standard" }]);

    const { sandbox, elements } = loadAdminVacationSandbox({
        resolveQuery: (state) => {
            if (state.table === "menu_items") return { data: menuItems, error: null };
            return resolverForActiveCycle({
                preview_menu_snapshot_key: snapshotKey,
                next_pickup_at: "2999-01-01T00:00:00.000Z"
            })(state);
        },
        resolveRpc: () => ({ data: [{ id: "s1" }], error: null })
    });

    await sandbox.__loadVacationPanel();

    assert.equal(elements.get("vacationReadinessBadge").textContent, "Ready");
    assert.equal(elements.get("vacationAutoSendToggle").disabled, false);
});

test("6. readiness flags a stale preview after the menu changes, and disables the auto-send toggle", async () => {
    const { sandbox, elements } = loadAdminVacationSandbox({
        resolveQuery: (state) => {
            if (state.table === "menu_items") {
                return { data: [{ id: "1", name: "CHANGED NAME", price: 8, available: true, description: "", product_type: "standard" }], error: null };
            }
            return resolverForActiveCycle({
                preview_menu_snapshot_key: JSON.stringify([{ id: "1", name: "Sourdough Boule", price: 8, description: "", product_type: "standard" }]),
                next_pickup_at: "2999-01-01T00:00:00.000Z"
            })(state);
        },
        resolveRpc: () => ({ data: [{ id: "s1" }], error: null })
    });

    await sandbox.__loadVacationPanel();

    assert.equal(elements.get("vacationReadinessBadge").textContent, "Not Ready");
    assert.match(elements.get("vacationReadinessReasons").innerHTML, /preview/i);
    assert.equal(elements.get("vacationAutoSendToggle").disabled, true);
});

test("7. the resume-review panel summary includes reopen time, pickup date, subject, menu count, categories, recipients, and ballot status", async () => {
    const { sandbox, elements } = loadAdminVacationSandbox({
        resolveQuery: (state) => {
            if (state.table === "ballot_settings") return { data: { id: "ballot-1" }, error: null };
            return resolverForActiveCycle()(state);
        },
        resolveRpc: () => ({ data: [{ id: "s1" }, { id: "s2" }, { id: "s3" }], error: null })
    });
    await sandbox.__loadVacationPanel();
    elements.set("vacationEmailSubject", { value: "We're back!" });
    elements.set("vacationRecipientsReopening", { checked: true });
    elements.set("vacationRecipientsMenu", { checked: true });
    elements.set("vacationRecipientsGeneral", { checked: false });

    await sandbox.__openResumeReviewPanel();

    const html = elements.get("vacationResumeSummary").innerHTML;
    assert.match(html, /September 14, 2026/);
    assert.match(html, /We&#039;re back!/);
    assert.match(html, /1 available item/);
    assert.match(html, /Reopening alerts, Menu announcements/);
    assert.match(html, /3/);
    assert.match(html, /Still open/);
    assert.equal(elements.get("vacationResumePanel").style.display, "block");
});

test("8. 'Resume Without Email' requires the explicit confirmation checkbox before doing anything", async () => {
    const { sandbox, supabaseClient, alertCalls } = loadAdminVacationSandbox({
        resolveQuery: resolverForActiveCycle()
    });
    await sandbox.__loadVacationPanel();

    await sandbox.__confirmResumeWithoutEmail();

    assert.equal(supabaseClient.invokeCalls.length, 0);
    assert.equal(alertCalls.length, 1);
    assert.match(alertCalls[0], /confirm/i);
});

test("9. checking the confirmation box lets 'Resume Without Email' proceed with sendEmail:false", async () => {
    const { sandbox, elements, supabaseClient } = loadAdminVacationSandbox({
        resolveQuery: resolverForActiveCycle(),
        resolveInvoke: (name) => name === "vacation-resume"
            ? { data: { ok: true, ordering: { resumed: true }, email: null }, error: null }
            : { data: { ok: true }, error: null }
    });
    await sandbox.__loadVacationPanel();
    elements.set("vacationResumeNoEmailConfirmCheckbox", { checked: true });

    await sandbox.__confirmResumeWithoutEmail();

    assert.equal(supabaseClient.invokeCalls.length, 1);
    assert.equal(supabaseClient.invokeCalls[0].name, "vacation-resume");
    assert.equal(supabaseClient.invokeCalls[0].opts.body.sendEmail, false);
});

test("10. a second resume click while a request is already in flight is a no-op (idempotent double-click guard)", async () => {
    let resolveInvokePromise;
    const pending = new Promise((resolve) => { resolveInvokePromise = resolve; });

    const { sandbox, supabaseClient } = loadAdminVacationSandbox({
        resolveQuery: resolverForActiveCycle(),
        resolveInvoke: () => pending
    });
    await sandbox.__loadVacationPanel();

    const firstClick = sandbox.__confirmResumeWithEmail();
    const secondClick = sandbox.__confirmResumeWithEmail();

    resolveInvokePromise({
        data: { ok: true, ordering: { resumed: true }, email: { sent: 1, failed: 0, recipientCount: 1 } },
        error: null
    });
    await Promise.all([firstClick, secondClick]);

    assert.equal(supabaseClient.invokeCalls.length, 1, "the second concurrent click must not fire a second network request");
});

test("11. resuming with email reports ordering and email results independently -- ordering success is never hidden by an email failure", async () => {
    const { sandbox, elements } = loadAdminVacationSandbox({
        resolveQuery: resolverForActiveCycle(),
        resolveInvoke: () => ({
            data: { ok: true, ordering: { resumed: true }, email: { ok: false } },
            error: null
        })
    });
    await sandbox.__loadVacationPanel();

    await sandbox.__confirmResumeWithEmail();

    const result = elements.get("vacationResumeResult").textContent;
    assert.match(result, /Ordering resumed/);
    assert.match(result, /failed to queue/i);
});

/* ==========================================
   Preview / Send Test: the root-cause fix -- both must save the
   CURRENT form fields before rendering/sending, never operate on
   stale/unsaved DB state.
   ========================================== */

test("12. previewVacationEmail saves the current (possibly unsaved) form fields BEFORE invoking the preview action", async () => {
    const { sandbox, elements, timeline } = loadAdminVacationSandbox({
        resolveQuery: resolverForActiveCycle(),
        resolveInvoke: (name) => name === "vacation-campaign"
            ? { data: { ok: true, html: "<p>preview</p>", text: "preview", menuSnapshotKey: "abc" }, error: null }
            : { data: { ok: true }, error: null }
    });
    await sandbox.__loadVacationPanel();
    elements.set("vacationAdditionalMessage", { value: "Brand new unsaved text" });
    elements.set("vacationEmailSubject", { value: "We're back!" });

    await sandbox.__previewVacationEmail();

    const updateEvents = timeline.filter(e => e.type === "query" && e.table === "vacation_periods" && e.op === "update");
    const invokeEvents = timeline.filter(e => e.type === "invoke" && e.name === "vacation-campaign");

    assert.equal(updateEvents.length, 1);
    assert.equal(updateEvents[0].payload.email_intro, "Brand new unsaved text");
    assert.equal(invokeEvents.length, 1);
    // The save must happen strictly before the render/send call.
    assert.ok(timeline.indexOf(updateEvents[0]) < timeline.indexOf(invokeEvents[0]));
});

test("13. sendVacationTestEmail also saves current form fields before invoking the test action -- this is the exact bug that dropped the admin's Introduction/Closing text before", async () => {
    const { sandbox, elements, timeline } = loadAdminVacationSandbox({
        resolveQuery: resolverForActiveCycle(),
        resolveInvoke: (name) => name === "vacation-campaign"
            ? { data: { ok: true, testRecipient: "owner@example.com" }, error: null }
            : { data: { ok: true }, error: null }
    });
    await sandbox.__loadVacationPanel();
    elements.set("vacationAdditionalMessage", { value: "Unsaved additional message" });

    await sandbox.__sendVacationTestEmail();

    const updateEvents = timeline.filter(e => e.type === "query" && e.table === "vacation_periods" && e.op === "update");
    const invokeEvents = timeline.filter(e => e.type === "invoke" && e.name === "vacation-campaign");

    assert.equal(updateEvents.length, 1);
    assert.equal(updateEvents[0].payload.email_intro, "Unsaved additional message");
    assert.ok(timeline.indexOf(updateEvents[0]) < timeline.indexOf(invokeEvents[0]));
});

test("14. Preview button: loading state disables + relabels the button, then success restores it and shows an inline pill beside it", async () => {
    const { sandbox, elements } = loadAdminVacationSandbox({
        resolveQuery: resolverForActiveCycle(),
        resolveInvoke: () => ({ data: { ok: true, html: "<p>x</p>", text: "x", menuSnapshotKey: "abc" }, error: null })
    });
    await sandbox.__loadVacationPanel();
    elements.set("vacationPreviewBtn", { textContent: "Preview Email", disabled: false });

    const promise = sandbox.__previewVacationEmail();
    // Immediately after calling (before the microtask queue drains),
    // the button must already be in its busy state.
    assert.equal(elements.get("vacationPreviewBtn").disabled, true);
    assert.match(elements.get("vacationPreviewBtn").textContent, /Generating Preview/);

    await promise;

    assert.equal(elements.get("vacationPreviewBtn").disabled, false);
    assert.equal(elements.get("vacationPreviewBtn").textContent, "Preview Email");
    assert.match(elements.get("vacationPreviewFeedback").textContent, /generated/i);
    assert.match(elements.get("vacationPreviewFeedback").className, /is-success/);
});

test("15. Send Test button: success feedback reads 'Test email sent successfully to <address>' beside the button, and the button recovers", async () => {
    const { sandbox, elements } = loadAdminVacationSandbox({
        resolveQuery: resolverForActiveCycle(),
        resolveInvoke: () => ({ data: { ok: true, testRecipient: "owner@example.com" }, error: null })
    });
    await sandbox.__loadVacationPanel();
    elements.set("vacationSendTestBtn", { textContent: "Send Test Email", disabled: false });

    await sandbox.__sendVacationTestEmail();

    assert.equal(elements.get("vacationSendTestBtn").disabled, false);
    assert.equal(elements.get("vacationSendTestBtn").textContent, "Send Test Email");
    assert.match(elements.get("vacationSendTestFeedback").textContent, /Test email sent successfully to owner@example\.com/);
    assert.match(elements.get("vacationSendTestFeedback").className, /is-success/);
});

test("16. Send Test button: failure shows a red inline error beside the button and restores it (never stuck disabled)", async () => {
    const { sandbox, elements } = loadAdminVacationSandbox({
        resolveQuery: resolverForActiveCycle(),
        resolveInvoke: () => ({ data: { ok: false, reason: "missing_test_recipient" }, error: null })
    });
    await sandbox.__loadVacationPanel();
    elements.set("vacationSendTestBtn", { textContent: "Send Test Email", disabled: false });

    await sandbox.__sendVacationTestEmail();

    assert.equal(elements.get("vacationSendTestBtn").disabled, false);
    assert.match(elements.get("vacationSendTestFeedback").textContent, /test recipient/i);
    assert.match(elements.get("vacationSendTestFeedback").className, /is-error/);
});

test("17. a second Send Test click while one is already in flight does not fire a second request (duplicate-send protection)", async () => {
    let resolveInvokePromise;
    const pending = new Promise((resolve) => { resolveInvokePromise = resolve; });

    const { sandbox, supabaseClient } = loadAdminVacationSandbox({
        resolveQuery: resolverForActiveCycle(),
        resolveInvoke: (name) => name === "vacation-campaign" ? pending : { data: { ok: true }, error: null }
    });
    await sandbox.__loadVacationPanel();

    const first = sandbox.__sendVacationTestEmail();
    const second = sandbox.__sendVacationTestEmail();

    resolveInvokePromise({ data: { ok: true, testRecipient: "owner@example.com" }, error: null });
    await Promise.all([first, second]);

    const testInvokes = supabaseClient.invokeCalls.filter(c => c.name === "vacation-campaign" && c.opts.body.action === "test");
    assert.equal(testInvokes.length, 1, "the second concurrent click must not fire a second test send");
});

test("18. reloading the page (a fresh sandbox load) never re-sends a test email on its own -- Send Test only ever runs on an explicit click", async () => {
    const { sandbox, supabaseClient } = loadAdminVacationSandbox({
        resolveQuery: resolverForActiveCycle()
    });

    await sandbox.__loadVacationPanel();

    assert.equal(supabaseClient.invokeCalls.length, 0, "loading the panel must never itself trigger a send");
});
