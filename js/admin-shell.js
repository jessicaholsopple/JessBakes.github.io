/* ==========================================
   ADMIN SHELL — shared navigation (Phase 4)
   ==========================================

   Single source of truth for the admin sidebar navigation, previously
   hand-copied into all 13 admin/*.html files (docs/bakery-rebuild/
   04-admin-ux-audit.md §1) with real, confirmed drift between copies
   (admin/subscribers.html was missing Menu/Suggestions/Reviews/Gallery
   entirely). Renders the nav from one shared array into
   <nav class="sidebar-nav">, auto-detects the active page from the URL,
   and wires up a mobile off-canvas toggle.

   Groups navigation logically (Overview / Orders / Production / Catalog /
   Inventory / Sales / Community / Email), per the rebuild's UX goals -- the
   previous flat list mixed customer-facing content, operational tooling,
   and site administration with no visual grouping beyond two <hr>s.

   Pure data/markup-building functions (NAV_GROUPS, currentPageFile,
   renderNavLink, buildNavHtml) have no dependency on the DOM and are
   exported UMD-style (window.AdminShell in the browser, module.exports
   under Node) so they're covered by tests/admin-shell.test.js without a
   real browser. The DOM-touching parts (rendering into a real <nav>,
   wiring the mobile toggle button/backdrop) only run when `document`
   exists, so this file is also safe to load as a plain <script> tag on
   every admin page (and the admin.html login gate, which simply has no
   matching element and no-ops).
   ========================================== */

(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.AdminShell = factory();
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const NAV_GROUPS = [
        {
            label: "Overview",
            items: [
                { href: "dashboard.html", label: "Dashboard" }
            ]
        },
        {
            label: "Orders",
            items: [
                { href: "orders.html", label: "Orders" }
            ]
        },
        {
            label: "Production",
            items: [
                { href: "production.html", label: "Production" },
                { href: "recipe-cards.html", label: "Recipe Cards" }
            ]
        },
        {
            label: "Catalog",
            items: [
                { href: "menu.html", label: "Menu" }
            ]
        },
        {
            label: "Inventory",
            items: [
                { href: "inventory.html", label: "Inventory" },
                { href: "packaging.html", label: "Packaging" }
            ]
        },
        {
            label: "Sales",
            items: [
                { href: "sales.html", label: "Sales" },
                { href: "analytics.html", label: "Analytics" }
            ]
        },
        {
            label: "Community",
            items: [
                { href: "reviews.html", label: "Reviews" },
                { href: "suggestions.html", label: "Suggestions" },
                { href: "subscribers.html", label: "Subscribers" },
                { href: "gallery.html", label: "Gallery" }
            ]
        },
        {
            label: "Email",
            items: [
                { href: "email.html", label: "Email" }
            ]
        }
    ];

    // Rendered as its own final group, not folded into one of the labeled
    // ones above -- account/system settings, not a workflow area.
    const SETTINGS_ITEM = { href: "settings.html", label: "Settings" };

    /** Extracts the page filename from a URL path, e.g.
     * "/admin/orders.html" -> "orders.html". Defaults to "dashboard.html"
     * for an empty/root path, matching this admin's actual entry point. */
    function currentPageFile(pathname) {
        const path = String(pathname || "");
        const file = path.substring(path.lastIndexOf("/") + 1);
        return file || "dashboard.html";
    }

    function escapeHtml(value) {
        return String(value || "")
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;");
    }

    function renderNavLink(item, current) {
        const isActive = item.href === current;
        return (
            `<a href="${escapeHtml(item.href)}"` +
            (isActive ? ` class="active" aria-current="page"` : "") +
            `>${escapeHtml(item.label)}</a>`
        );
    }

    /** Builds the full inner HTML for <nav class="sidebar-nav">, given the
     * current page's filename. Pure -- takes a string, returns a string. */
    function buildNavHtml(current) {
        const groupsHtml = NAV_GROUPS.map(group => `
            <div class="sidebar-nav-group">
                <p class="sidebar-nav-group-label">${escapeHtml(group.label)}</p>
                <div class="sidebar-nav-group-links">
                    ${group.items.map(item => renderNavLink(item, current)).join("")}
                </div>
            </div>
        `).join("");

        const settingsHtml = `
            <div class="sidebar-nav-group">
                ${renderNavLink(SETTINGS_ITEM, current)}
            </div>
        `;

        return groupsHtml + settingsHtml;
    }

    /** Every {href, label} entry across every group, including Settings --
     * useful for tests/consistency checks without duplicating the list. */
    function allNavItems() {
        return NAV_GROUPS.flatMap(group => group.items).concat([SETTINGS_ITEM]);
    }

    // ---- DOM wiring (browser only) ----

    function renderNavInto(navEl) {
        const current = currentPageFile(
            typeof window !== "undefined" ? window.location.pathname : ""
        );
        navEl.innerHTML = buildNavHtml(current);
        if (!navEl.hasAttribute("aria-label")) {
            navEl.setAttribute("aria-label", "Admin navigation");
        }
    }

    // Mobile off-canvas toggle: a compact sticky app bar + backdrop,
    // wired to toggle a `sidebar-open` class on <body> (see
    // css/admin.css's mobile density system for the responsive CSS).
    //
    // The app bar (containing the toggle button) is inserted as the
    // FIRST CHILD of .admin-content -- real document flow, not a
    // `position: fixed` overlay -- specifically so it can be
    // `position: sticky`. A sticky element reserves its own space and
    // everything after it in the DOM simply cannot scroll behind/
    // under it, unlike a fixed-position button floating over the
    // page (the previous design, which a real device test showed
    // covering page content while scrolling). The backdrop stays
    // `position: fixed`, appended to <body> -- that IS supposed to
    // overlay everything while the off-canvas nav is open.
    function setupMobileToggle(shellEl) {
        if (!shellEl || document.querySelector(".sidebar-toggle")) return;

        const appbar = document.createElement("div");
        appbar.className = "mobile-appbar";

        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "sidebar-toggle";
        toggle.setAttribute("aria-label", "Toggle navigation menu");
        toggle.setAttribute("aria-expanded", "false");
        toggle.innerHTML = `<span class="sidebar-toggle-icon" aria-hidden="true">☰</span> Menu`;
        appbar.appendChild(toggle);

        const backdrop = document.createElement("div");
        backdrop.className = "sidebar-backdrop";

        function setOpen(open) {
            document.body.classList.toggle("sidebar-open", open);
            toggle.setAttribute("aria-expanded", open ? "true" : "false");
        }

        toggle.addEventListener("click", () => {
            setOpen(!document.body.classList.contains("sidebar-open"));
        });

        backdrop.addEventListener("click", () => setOpen(false));

        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape") setOpen(false);
        });

        // Close automatically after following a nav link (mobile only --
        // harmless on desktop since the class has no effect there).
        shellEl.querySelectorAll(".sidebar-nav a").forEach(link => {
            link.addEventListener("click", () => setOpen(false));
        });

        const contentEl = shellEl.querySelector(".admin-content") || shellEl;
        contentEl.insertBefore(appbar, contentEl.firstChild);
        document.body.appendChild(backdrop);
    }

    // ---- PWA bootstrap (every admin page, including the login gate) ----
    //
    // Installable-app tags are injected via JS rather than hand-copied
    // into all 14 admin HTML files, for the same reason the nav itself
    // is centralized here (see the file header) -- one source of
    // truth, no risk of drift between pages. Absolute paths ("/...")
    // so this works identically from the root-level admin.html and
    // every one-level-deep admin/*.html page. Safe to run before the
    // user is authenticated -- none of this touches any private data.
    function injectPwaHeadTags() {
        if (document.querySelector('link[rel="manifest"]')) return; // already present

        const head = document.head;

        const manifestLink = document.createElement("link");
        manifestLink.rel = "manifest";
        manifestLink.href = "/manifest.webmanifest";
        head.appendChild(manifestLink);

        const appleTouchIcon = document.createElement("link");
        appleTouchIcon.rel = "apple-touch-icon";
        appleTouchIcon.href = "/images/icons/apple-touch-icon.png";
        head.appendChild(appleTouchIcon);

        const capable = document.createElement("meta");
        capable.name = "apple-mobile-web-app-capable";
        capable.content = "yes";
        head.appendChild(capable);

        const statusBar = document.createElement("meta");
        statusBar.name = "apple-mobile-web-app-status-bar-style";
        statusBar.content = "black-translucent";
        head.appendChild(statusBar);

        const appleTitle = document.createElement("meta");
        appleTitle.name = "apple-mobile-web-app-title";
        appleTitle.content = "Jess Bakes";
        head.appendChild(appleTitle);

        const themeColor = document.createElement("meta");
        themeColor.name = "theme-color";
        themeColor.content = "#7b2b22";
        head.appendChild(themeColor);
    }

    // Registered from every admin page so it's active before the
    // admin ever presses "Enable Order Notifications" on Settings --
    // scope "/" (this file is served from the site root), matching
    // the manifest's scope, so it covers both the root-level login
    // gate and every /admin/* page. Safe/idempotent to call on every
    // load: the browser no-ops if the same script+scope is already
    // registered, and only actually re-fetches sw.js when its bytes
    // change (standard service-worker update behavior).
    function registerServiceWorker() {
        if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
        navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
            // Never fatal -- e.g. unsupported browser, or served over
            // plain HTTP in local dev without a secure context.
        });
    }

    function init() {
        injectPwaHeadTags();
        registerServiceWorker();

        const navEl = document.querySelector("nav.sidebar-nav");
        if (!navEl) return; // e.g. the login gate, which has no sidebar

        renderNavInto(navEl);

        const shellEl = document.querySelector(".admin-shell");
        setupMobileToggle(shellEl);
    }

    if (typeof document !== "undefined") {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", init);
        } else {
            init();
        }
    }

    return {
        NAV_GROUPS,
        SETTINGS_ITEM,
        currentPageFile,
        renderNavLink,
        buildNavHtml,
        allNavItems
    };
});
