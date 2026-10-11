"use strict";

/* ==========================================
   Admin Contact Messages page (js/admin-contact-messages.js)

   Covers: the Reply-by-Email mailto construction, read/unread
   rendering, the delete confirmation gate (admin.confirm() must be
   honored -- a cancelled confirm must never delete), and that viewing
   a message marks it read without needing a separate explicit action
   (while still exposing an explicit "mark unread" toggle).

   Same node:vm sandbox technique as tests/cart-schedule-integrity.test.js.
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

function jsonEqual(actual, expected, message) {
    assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
}

function loadAdminContactSandbox({ messages, confirmResult = true, updateError, deleteError } = {}) {
    const elements = new Map();
    function makeElement() {
        return {
            style: {}, textContent: "", innerHTML: "", value: "",
            classList: { add: () => {}, toggle: () => {} },
            appendChild: () => {},
            setAttribute: () => {},
            addEventListener: () => {}
        };
    }
    function fakeElement(id) {
        if (!elements.has(id)) elements.set(id, makeElement());
        return elements.get(id);
    }

    const alertCalls = [];
    const confirmCalls = [];
    const updateCalls = [];
    const deleteCalls = [];

    let store = (messages || []).map(m => ({ ...m }));

    const supabaseClient = {
        from(table) {
            if (table !== "contact_messages") throw new Error("unexpected table: " + table);
            return {
                select() {
                    return {
                        // A deep copy, matching real PostgREST behavior
                        // (a fresh JSON response, never the same JS
                        // object reference the "server" -- our mock's
                        // `store` -- holds). Sharing references here
                        // would let the admin page's own optimistic
                        // local-state update race against the mock's
                        // write and double-toggle a boolean.
                        order: () => Promise.resolve({ data: JSON.parse(JSON.stringify(store)), error: null })
                    };
                },
                update(patch) {
                    return {
                        eq: (col, id) => {
                            updateCalls.push({ patch, id });
                            if (updateError) return Promise.resolve({ error: updateError });
                            const row = store.find(m => m.id === id);
                            if (row) Object.assign(row, patch);
                            return Promise.resolve({ error: null });
                        }
                    };
                },
                delete() {
                    return {
                        eq: (col, id) => {
                            deleteCalls.push({ id });
                            if (deleteError) return Promise.resolve({ error: deleteError });
                            store = store.filter(m => m.id !== id);
                            return Promise.resolve({ error: null });
                        }
                    };
                }
            };
        }
    };

    const fakeDocument = {
        addEventListener: () => {},
        getElementById: (id) => fakeElement(id),
        createElement: () => makeElement(),
        body: { appendChild: () => {} }
    };

    const sandbox = {
        document: fakeDocument,
        window: {},
        console,
        supabaseClient,
        alert: (msg) => alertCalls.push(msg),
        confirm: (msg) => { confirmCalls.push(msg); return confirmResult; },
        requireAuth: async () => {}
    };
    vm.createContext(sandbox);

    const source = [
        read("js/admin-contact-messages.js"),
        `
        this.__loadContactMessages = loadContactMessages;
        this.__openContactMessage = openContactMessage;
        this.__toggleContactMessageRead = toggleContactMessageRead;
        this.__toggleContactMessageResolved = toggleContactMessageResolved;
        this.__deleteContactMessage = deleteContactMessage;
        this.__buildReplyMailto = buildReplyMailto;
        this.__getContactMessages = function() { return contactMessages; };
        `
    ].join("\n");

    vm.runInContext(source, sandbox);

    return { sandbox, elements, alertCalls, confirmCalls, updateCalls, deleteCalls, getStore: () => store };
}

const SAMPLE_MESSAGE = {
    id: "msg-1",
    name: "Alex",
    email: "alex@example.com",
    order_reference: "ORD-42",
    message: "Can I add gluten-free options to my order?",
    is_read: false,
    is_resolved: false,
    created_at: "2026-08-20T10:00:00Z"
};

test("1. buildReplyMailto builds a mailto: link to the customer's own email with a subject referencing the order reference", () => {
    const { sandbox } = loadAdminContactSandbox({});
    const mailto = sandbox.__buildReplyMailto(SAMPLE_MESSAGE);

    assert.match(mailto, /^mailto:alex%40example\.com\?subject=/);
    assert.match(decodeURIComponent(mailto), /ORD-42/);
    assert.match(decodeURIComponent(mailto), /Jess Bakes/);
});

test("2. buildReplyMailto omits the order-reference parenthetical when there isn't one", () => {
    const { sandbox } = loadAdminContactSandbox({});
    const mailto = sandbox.__buildReplyMailto({ ...SAMPLE_MESSAGE, order_reference: null });

    assert.doesNotMatch(decodeURIComponent(mailto), /\(.*\)/);
});

test("3. opening a message marks it read (one update call, is_read: true) without requiring a separate explicit action", async () => {
    const { sandbox, updateCalls } = loadAdminContactSandbox({ messages: [SAMPLE_MESSAGE] });

    await sandbox.__loadContactMessages();
    await sandbox.__openContactMessage("msg-1");

    const readUpdates = updateCalls.filter(c => c.patch.is_read === true);
    assert.equal(readUpdates.length, 1);
    assert.equal(readUpdates[0].id, "msg-1");
});

test("4. opening an already-read message does not issue a redundant read update", async () => {
    const { sandbox, updateCalls } = loadAdminContactSandbox({ messages: [{ ...SAMPLE_MESSAGE, is_read: true }] });

    await sandbox.__loadContactMessages();
    await sandbox.__openContactMessage("msg-1");

    assert.equal(updateCalls.length, 0);
});

test("5. toggleContactMessageRead flips is_read in both directions (explicit mark unread works, not just auto-mark-read)", async () => {
    const { sandbox, getStore } = loadAdminContactSandbox({ messages: [{ ...SAMPLE_MESSAGE, is_read: true }] });

    await sandbox.__loadContactMessages();
    await sandbox.__openContactMessage("msg-1"); // already read -- no auto-update
    await sandbox.__toggleContactMessageRead(); // explicit: mark unread

    assert.equal(getStore()[0].is_read, false);
});

test("6. toggleContactMessageResolved flips is_resolved independently of is_read", async () => {
    const { sandbox, getStore } = loadAdminContactSandbox({ messages: [SAMPLE_MESSAGE] });

    await sandbox.__loadContactMessages();
    await sandbox.__openContactMessage("msg-1");
    await sandbox.__toggleContactMessageResolved();

    const row = getStore()[0];
    assert.equal(row.is_resolved, true);
    assert.equal(row.is_read, true, "is_read was already set true by opening the message, and stays independent of is_resolved");
});

test("7. deleteContactMessage requires confirmation -- a cancelled confirm deletes nothing", async () => {
    const { sandbox, confirmCalls, deleteCalls, getStore } = loadAdminContactSandbox({
        messages: [SAMPLE_MESSAGE], confirmResult: false
    });

    await sandbox.__loadContactMessages();
    await sandbox.__openContactMessage("msg-1");
    await sandbox.__deleteContactMessage();

    assert.equal(confirmCalls.length, 1);
    assert.equal(deleteCalls.length, 0, "no delete call should be issued when the admin cancels the confirmation");
    assert.equal(getStore().length, 1);
});

test("8. deleteContactMessage, once confirmed, removes the message", async () => {
    const { sandbox, deleteCalls, getStore } = loadAdminContactSandbox({
        messages: [SAMPLE_MESSAGE], confirmResult: true
    });

    await sandbox.__loadContactMessages();
    await sandbox.__openContactMessage("msg-1");
    await sandbox.__deleteContactMessage();

    assert.equal(deleteCalls.length, 1);
    assert.equal(getStore().length, 0);
});

test("9. loadContactMessages sorts newest first (delegated to the query's .order(\"created_at\", {ascending:false}) -- never re-sorted client-side differently)", async () => {
    const js = read("js/admin-contact-messages.js");
    assert.match(js, /\.order\("created_at",\s*\{\s*ascending:\s*false\s*\}\)/);
});
