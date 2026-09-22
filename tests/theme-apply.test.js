"use strict";

/* ==========================================
   Themes public application (js/theme-apply.js)

   Covers: Classic fallback on query error/timeout/unknown key, the
   ?themePreview= admin-preview bypass (never touches the DB),
   prefers-reduced-motion skipping decor entirely, correct
   body.theme-<key> class + CSS custom property application on a
   valid resolved theme, and accent-intensity clamping to the DB's
   own [0.4, 1.0] safe-brand-limits range.

   Same node:vm sandbox technique as tests/vacation-homepage.test.js.
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

function loadThemeApplySandbox({ search = "", resolvedRow = null, error = null, reducedMotion = false, hang = false } = {}) {
    const addedClasses = [];
    const cssProps = {};
    const appendedMounts = [];
    const timeouts = [];

    const body = {
        classList: { add: (cls) => addedClasses.push(cls) },
        appendChild: (el) => appendedMounts.push(el)
    };

    const documentElement = {
        style: { setProperty: (k, v) => { cssProps[k] = v; } }
    };

    const fakeDocument = {
        body,
        documentElement,
        addEventListener: () => {},
        createElement: (tag) => ({
            tagName: tag,
            className: "",
            attributes: {},
            innerHTML: "",
            setAttribute(name, value) { this.attributes[name] = value; }
        })
    };

    const fakeWindow = {
        location: { search },
        matchMedia: (query) => ({ matches: query.includes("reduced-motion") ? reducedMotion : false })
    };

    const queryPromise = hang
        ? new Promise(() => {})
        : Promise.resolve({ data: resolvedRow, error });

    const supabaseClient = {
        from: (table) => {
            if (table !== "theme_state") throw new Error("Unexpected table queried by theme-apply.js: " + table);
            return { select: () => ({ maybeSingle: () => queryPromise }) };
        }
    };

    const sandbox = {
        document: fakeDocument,
        window: fakeWindow,
        console,
        supabaseClient,
        URLSearchParams,
        setTimeout: (fn, ms) => { const rec = { fn, ms, cleared: false }; timeouts.push(rec); return rec; },
        clearTimeout: (rec) => { if (rec) rec.cleared = true; }
    };
    vm.createContext(sandbox);

    const source = [
        read("js/theme-apply.js"),
        `
        this.__initThemeApply = initThemeApply;
        this.__parseThemePreviewParams = parseThemePreviewParams;
        this.__clampIntensity = clampIntensity;
        this.__THEME_DECOR = THEME_DECOR;
        `
    ].join("\n");

    vm.runInContext(source, sandbox);

    return { sandbox, addedClasses, cssProps, appendedMounts, timeouts };
}

test("1. no active theme (resolved_theme_key = classic) adds no class and mounts no decor", async () => {
    const { sandbox, addedClasses, appendedMounts } = loadThemeApplySandbox({
        resolvedRow: { resolved_theme_key: "classic", resolved_accent_intensity: 1, resolved_graphics_visibility: "normal" }
    });

    await sandbox.__initThemeApply();

    assert.deepEqual(addedClasses, []);
    assert.deepEqual(appendedMounts, []);
});

test("2. a query error fails safe to Classic -- no class, no decor, never throws", async () => {
    const { sandbox, addedClasses, appendedMounts } = loadThemeApplySandbox({ error: { message: "boom" } });

    await assert.doesNotReject(() => sandbox.__initThemeApply());

    assert.deepEqual(addedClasses, []);
    assert.deepEqual(appendedMounts, []);
});

test("3. a valid resolved theme adds body.theme-<key> and sets the CSS custom properties", async () => {
    const { sandbox, addedClasses, cssProps } = loadThemeApplySandbox({
        resolvedRow: { resolved_theme_key: "halloween", resolved_accent_intensity: 0.8, resolved_graphics_visibility: "normal" }
    });

    await sandbox.__initThemeApply();

    assert.ok(addedClasses.includes("theme-halloween"));
    assert.equal(cssProps["--theme-intensity"], "0.8");
    assert.equal(cssProps["--theme-graphics"], "normal");
});

test("4. a valid resolved theme with normal graphics mounts two decor elements", async () => {
    const { sandbox, appendedMounts } = loadThemeApplySandbox({
        resolvedRow: { resolved_theme_key: "christmas", resolved_accent_intensity: 1, resolved_graphics_visibility: "normal" }
    });

    await sandbox.__initThemeApply();

    assert.equal(appendedMounts.length, 2);
    assert.ok(appendedMounts.every(m => m.className.includes("theme-decor-mount")));
});

test("5. graphics_visibility 'minimal' skips mounting decor but still applies the color class", async () => {
    const { sandbox, addedClasses, appendedMounts } = loadThemeApplySandbox({
        resolvedRow: { resolved_theme_key: "christmas", resolved_accent_intensity: 1, resolved_graphics_visibility: "minimal" }
    });

    await sandbox.__initThemeApply();

    assert.ok(addedClasses.includes("theme-christmas"));
    assert.deepEqual(appendedMounts, []);
});

test("6. prefers-reduced-motion skips mounting decor entirely, regardless of graphics_visibility", async () => {
    const { sandbox, addedClasses, appendedMounts } = loadThemeApplySandbox({
        resolvedRow: { resolved_theme_key: "christmas", resolved_accent_intensity: 1, resolved_graphics_visibility: "normal" },
        reducedMotion: true
    });

    await sandbox.__initThemeApply();

    assert.ok(addedClasses.includes("theme-christmas"));
    assert.deepEqual(appendedMounts, []);
});

test("7. an unrecognized theme_key fails safe to Classic -- no class added", async () => {
    const { sandbox, addedClasses } = loadThemeApplySandbox({
        resolvedRow: { resolved_theme_key: "some_future_theme_this_copy_doesnt_know", resolved_accent_intensity: 1, resolved_graphics_visibility: "normal" }
    });

    await sandbox.__initThemeApply();

    assert.deepEqual(addedClasses, []);
});

test("8. ?themePreview= bypasses the database entirely, even if the query would hang", async () => {
    const { sandbox, addedClasses } = loadThemeApplySandbox({
        search: "?themePreview=valentines&intensity=0.6&graphics=normal",
        hang: true
    });

    await sandbox.__initThemeApply();

    assert.ok(addedClasses.includes("theme-valentines"));
});

test("9. parseThemePreviewParams: absent param returns null; present param parses intensity/graphics with safe defaults", () => {
    // Compared field-by-field with assert.equal rather than
    // assert.deepEqual against a plain literal -- the sandbox's
    // returned object belongs to the vm context's own Object
    // prototype, a different realm than this test file's, which
    // assert/strict's deepEqual correctly (if confusingly) treats as
    // unequal even when every own property matches.
    const { sandbox } = loadThemeApplySandbox({ search: "" });
    assert.equal(sandbox.__parseThemePreviewParams(), null);

    const { sandbox: sandbox2 } = loadThemeApplySandbox({ search: "?themePreview=halloween" });
    const result2 = sandbox2.__parseThemePreviewParams();
    assert.equal(result2.theme_key, "halloween");
    assert.equal(result2.accent_intensity, 1);
    assert.equal(result2.graphics_visibility, "normal");

    const { sandbox: sandbox3 } = loadThemeApplySandbox({ search: "?themePreview=halloween&intensity=0.5&graphics=minimal" });
    const result3 = sandbox3.__parseThemePreviewParams();
    assert.equal(result3.theme_key, "halloween");
    assert.equal(result3.accent_intensity, 0.5);
    assert.equal(result3.graphics_visibility, "minimal");
});

test("10. clampIntensity keeps values within the DB's [0.4, 1.0] safe-brand-limits range", () => {
    const { sandbox } = loadThemeApplySandbox({});
    assert.equal(sandbox.__clampIntensity(1.5), 1);
    assert.equal(sandbox.__clampIntensity(0.1), 0.4);
    assert.equal(sandbox.__clampIntensity(0.75), 0.75);
    assert.equal(sandbox.__clampIntensity("garbage"), 1);
    assert.equal(sandbox.__clampIntensity(null), 1);
});

test("11. the watchdog is registered and cleared once resolution happens in time", async () => {
    const { sandbox, timeouts } = loadThemeApplySandbox({
        resolvedRow: { resolved_theme_key: "classic", resolved_accent_intensity: 1, resolved_graphics_visibility: "normal" }
    });

    await sandbox.__initThemeApply();

    assert.equal(timeouts.length, 1);
    assert.equal(timeouts[0].cleared, true);
});

test("13. sw.js's admin-only STATIC_ALLOWLIST never caches css/themes.css or js/theme-apply.js -- public theme assets must always hit the network fresh, so a scheduled transition is never served stale", () => {
    const sw = read("sw.js");
    const allowlistBlock = sw.match(/STATIC_ALLOWLIST\s*=\s*\[[\s\S]*?\];/)[0];
    assert.doesNotMatch(allowlistBlock, /themes\.css/);
    assert.doesNotMatch(allowlistBlock, /theme-apply\.js/);
});

test("12. THEME_DECOR has an entry for every one of the 12 non-Classic catalog themes", () => {
    const { sandbox } = loadThemeApplySandbox({});
    const expectedKeys = [
        "spring", "summer", "autumn", "winter", "new_years", "valentines",
        "st_patricks", "easter", "fourth_of_july", "halloween", "thanksgiving", "christmas"
    ];
    for (const key of expectedKeys) {
        assert.ok(Object.prototype.hasOwnProperty.call(sandbox.__THEME_DECOR, key), `missing decor for ${key}`);
        assert.match(sandbox.__THEME_DECOR[key], /<svg/);
    }
    assert.equal(Object.keys(sandbox.__THEME_DECOR).length, expectedKeys.length);
});
