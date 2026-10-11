"use strict";

/* ==========================================
   Facebook URL consistency (site-wide)

   Jessica's official Facebook page is
   https://www.facebook.com/jessbakessourdough -- a previously-used
   share-style URL (facebook.com/share/1UYBMv8Kds/...) was wrong and
   has been removed everywhere. These tests guard against either
   regressing back to the old URL or drifting to a third, inconsistent
   one in the future.
   ========================================== */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const OFFICIAL_URL = "https://www.facebook.com/jessbakessourdough";
const OLD_URL_FRAGMENT = "facebook.com/share/1UYBMv8Kds";

function read(relPath) {
    return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

// Every customer-facing page that links to Facebook, per the repo-wide
// grep performed when this URL was corrected.
const PAGES_WITH_FACEBOOK_LINKS = [
    "index.html",
    "menu.html",
    "gallery.html",
    "reviews.html",
    "contact.html",
    "privacy.html",
    "unsubscribe.html",
    "404.html"
];

test("1. the old share-style Facebook URL does not appear anywhere in the repository's active site code", () => {
    // Walk every html/js/css file; the old fragment must be gone.
    const offenders = [];
    function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "tests") continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (/\.(html|js|css)$/.test(entry.name)) {
                const content = fs.readFileSync(full, "utf8");
                if (content.includes(OLD_URL_FRAGMENT)) {
                    offenders.push(path.relative(ROOT, full));
                }
            }
        }
    }
    walk(ROOT);
    assert.deepEqual(offenders, [], `old Facebook URL still present in: ${offenders.join(", ")}`);
});

for (const page of PAGES_WITH_FACEBOOK_LINKS) {
    test(`2. ${page} links to the official Facebook URL with safe target/rel attributes`, () => {
        const html = read(page);
        const linkMatches = [...html.matchAll(/<a\s+([^>]*href="(https:\/\/www\.facebook\.com\/[^"]+)"[^>]*)>/g)];
        assert.ok(linkMatches.length > 0, `expected at least one Facebook link on ${page}`);

        for (const match of linkMatches) {
            const [, attrs, url] = match;
            assert.equal(url, OFFICIAL_URL, `${page}: Facebook link must be the official URL, got ${url}`);
            assert.match(attrs, /target="_blank"/, `${page}: Facebook link must open in a new tab`);
            assert.match(attrs, /rel="[^"]*noopener[^"]*"/, `${page}: Facebook link must include rel="noopener"`);
        }
    });
}

test("3. gallery.html and menu.html (multi-line Facebook link markup) also resolve to the official URL", () => {
    for (const page of ["gallery.html", "menu.html"]) {
        const html = read(page);
        assert.match(
            html,
            /href="https:\/\/www\.facebook\.com\/jessbakessourdough"/,
            `${page}: expected the official Facebook URL`
        );
    }
});
