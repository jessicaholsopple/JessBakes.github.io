"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const AdminShell = require("../js/admin-shell.js");

const REPO_ROOT = path.join(__dirname, "..");
const ADMIN_DIR = path.join(REPO_ROOT, "admin");
const REAL_PAGES = fs.readdirSync(ADMIN_DIR).filter(f => f.endsWith(".html"));

/* ==========================================
   Phase 4 UI regression tests.

   These are structural/text-based, not a real browser render (none is
   available in this environment) -- they verify the shared nav data is
   internally consistent, matches every real admin page 1:1, and that
   every admin page's HTML actually wires up the shared shell/CSS
   correctly. Visual/responsive behavior at real breakpoints was not
   pixel-verified; see the Phase 4 completion summary.
   ========================================== */

test("1. NAV_GROUPS covers every real admin/*.html page exactly once, with no extras", () => {
    const navFiles = AdminShell.allNavItems().map(item => item.href).sort();
    const realFiles = [...REAL_PAGES].sort();

    assert.deepEqual(navFiles, realFiles);
});

test("2. every nav item's href points at a file that actually exists", () => {
    AdminShell.allNavItems().forEach(item => {
        const p = path.join(ADMIN_DIR, item.href);
        assert.ok(fs.existsSync(p), `${item.href} does not exist in admin/`);
    });
});

test("3. no nav item's href or label is empty", () => {
    AdminShell.allNavItems().forEach(item => {
        assert.ok(item.href && item.href.trim(), "empty href");
        assert.ok(item.label && item.label.trim(), "empty label");
    });
});

test("4. groups are logically named per the confirmed design (Overview/Orders/Production/Catalog/Inventory/Sales/Community/Email/Site)", () => {
    const labels = AdminShell.NAV_GROUPS.map(g => g.label);
    assert.deepEqual(labels, ["Overview", "Orders", "Production", "Catalog", "Inventory", "Sales", "Community", "Email", "Site"]);
});

test("5. currentPageFile extracts the filename from a full path, defaulting to dashboard.html for the root", () => {
    assert.equal(AdminShell.currentPageFile("/admin/orders.html"), "orders.html");
    assert.equal(AdminShell.currentPageFile("orders.html"), "orders.html");
    assert.equal(AdminShell.currentPageFile("/admin/"), "dashboard.html");
    assert.equal(AdminShell.currentPageFile(""), "dashboard.html");
    assert.equal(AdminShell.currentPageFile(null), "dashboard.html");
});

test("6. buildNavHtml marks exactly the current page's link active, and every other real page's link is inactive", () => {
    for (const page of REAL_PAGES) {
        const html = AdminShell.buildNavHtml(page);
        const activeCount = (html.match(/class="active"/g) || []).length;
        assert.equal(activeCount, 1, `expected exactly 1 active link when viewing ${page}`);
        assert.ok(html.includes(`href="${page}" class="active"`), `${page}'s own link should be marked active`);
    }
});

test("7. buildNavHtml marks nothing active for a page not in the nav (e.g. an unknown/legacy URL)", () => {
    const html = AdminShell.buildNavHtml("nonexistent.html");
    assert.equal((html.match(/class="active"/g) || []).length, 0);
});

test("8. renderNavLink escapes HTML in href/label (defensive -- current data is all static/trusted, but this must never silently allow injection if that changes)", () => {
    const html = AdminShell.renderNavLink({ href: "x.html\"><script>", label: "<b>hi</b>" }, "none");
    assert.ok(!html.includes("<script>"));
    assert.ok(!html.includes("<b>"));
});

test("9. every real admin/*.html page loads js/admin-shell.js and has exactly one empty <nav class=\"sidebar-nav\">", () => {
    for (const page of REAL_PAGES) {
        const html = fs.readFileSync(path.join(ADMIN_DIR, page), "utf8");

        assert.ok(html.includes("admin-shell.js"), `${page} does not load admin-shell.js`);

        const navMatches = html.match(/<nav\s+class="sidebar-nav"[^>]*>[\s\S]*?<\/nav>/g) || [];
        assert.equal(navMatches.length, 1, `${page} should have exactly one sidebar-nav element`);
        // The nav is populated by JS at runtime -- the static HTML should
        // be empty (or whitespace-only), never a hand-copied link list.
        const innerContent = navMatches[0].replace(/<nav[^>]*>/, "").replace(/<\/nav>$/, "").trim();
        assert.equal(innerContent, "", `${page}'s sidebar-nav should be empty in the static HTML (rendered by JS)`);
    }
});

test("10. no admin page references the deleted admin.js (BUG-07)", () => {
    const allFiles = [
        path.join(__dirname, "..", "admin.html"),
        ...REAL_PAGES.map(f => path.join(ADMIN_DIR, f))
    ];

    for (const file of allFiles) {
        const html = fs.readFileSync(file, "utf8");
        assert.ok(!/src="[^"]*\badmin\.js"/.test(html), `${file} still references admin.js`);
    }

    assert.ok(!fs.existsSync(path.join(__dirname, "..", "js", "admin.js")), "js/admin.js should be deleted");
});

test("11. admin/production.html loads both admin.css and the real production.css", () => {
    const html = fs.readFileSync(path.join(ADMIN_DIR, "production.html"), "utf8");
    assert.ok(html.includes('href="../css/admin.css"'));
    assert.ok(html.includes('href="../css/production.css"'));
    assert.ok(fs.existsSync(path.join(__dirname, "..", "css", "production.css")), "css/production.css should exist (BUG-09)");
});

test("12. every admin/*.html page's <link>/<script> src/href attributes resolve to a real file (no broken references)", () => {
    const attrRe = /(?:href|src)="([^"]+)"/g;

    for (const page of REAL_PAGES) {
        const filePath = path.join(ADMIN_DIR, page);
        const html = fs.readFileSync(filePath, "utf8");
        let m;
        while ((m = attrRe.exec(html))) {
            const url = m[1];
            if (!url || url.startsWith("#") || /^https?:/.test(url) || url.startsWith("mailto:") || url.startsWith("tel:") || url.startsWith("data:")) continue;
            // A leading "/" is a site-root-absolute path (e.g. the PWA
            // manifest/icon links, deliberately absolute so they
            // resolve identically from admin.html at the repo root AND
            // every one-level-deep admin/*.html page) -- resolve those
            // against the repo root, not the admin/ directory.
            const resolved = url.startsWith("/")
                ? path.normalize(path.join(REPO_ROOT, url))
                : path.normalize(path.join(ADMIN_DIR, url));
            assert.ok(fs.existsSync(resolved), `${page} references missing file: ${url}`);
        }
    }
});

test("13. css/admin.css has no unresolved var() references (e.g. the confirmed --border-color and --burgundy bugs)", () => {
    const css = fs.readFileSync(path.join(__dirname, "..", "css", "admin.css"), "utf8");
    const productionCss = fs.readFileSync(path.join(__dirname, "..", "css", "production.css"), "utf8");
    const combined = css + "\n" + productionCss;

    const definedTokens = new Set(
        [...css.matchAll(/--([a-zA-Z0-9-]+)\s*:/g)].map(m => "--" + m[1])
    );
    const usedTokens = new Set(
        [...combined.matchAll(/var\((--[a-zA-Z0-9-]+)\)/g)].map(m => m[1])
    );

    for (const token of usedTokens) {
        assert.ok(definedTokens.has(token), `var(${token}) is used but never defined in :root`);
    }
});

test("14. css/admin.css has no duplicate top-level selector definitions remaining", () => {
    const css = fs.readFileSync(path.join(__dirname, "..", "css", "admin.css"), "utf8");
    const lines = css.split("\n");
    const seen = new Map();
    let depth = 0, buf = "", inComment = false;

    for (const line of lines) {
        let i = 0;
        while (i < line.length) {
            if (inComment) {
                const end = line.indexOf("*/", i);
                if (end === -1) { i = line.length; } else { inComment = false; i = end + 2; }
                continue;
            }
            const ch = line[i];
            if (ch === "/" && line[i + 1] === "*") { inComment = true; i += 2; continue; }
            if (ch === "{") {
                if (depth === 0) {
                    const sel = buf.trim().replace(/\s+/g, " ");
                    if (sel && !sel.startsWith("@")) {
                        seen.set(sel, (seen.get(sel) || 0) + 1);
                    }
                    buf = "";
                }
                depth++;
            } else if (ch === "}") {
                depth--;
                if (depth === 0) buf = "";
            } else if (depth === 0) {
                buf += ch;
            }
            i++;
        }
        if (depth === 0) buf += " ";
    }

    const dups = [...seen.entries()].filter(([, count]) => count > 1);
    assert.equal(dups.length, 0, `duplicate top-level selectors found: ${JSON.stringify(dups)}`);
});

test("15. css/admin.css and css/production.css have balanced braces (no phantom/unclosed @media blocks)", () => {
    for (const file of ["admin.css", "production.css"]) {
        const css = fs.readFileSync(path.join(__dirname, "..", "css", file), "utf8");
        let depth = 0, inComment = false;
        for (let i = 0; i < css.length; i++) {
            const ch = css[i];
            if (ch === "/" && css[i + 1] === "*") { inComment = true; i++; continue; }
            if (inComment) { if (ch === "*" && css[i + 1] === "/") { inComment = false; i++; } continue; }
            if (ch === "{") depth++;
            if (ch === "}") depth--;
        }
        assert.equal(depth, 0, `${file} has unbalanced braces (final depth ${depth})`);
    }
});
