/* ==========================================
   THEMES -- public-page application
   ==========================================

   Applies whichever theme theme_state.resolved_theme_key currently
   holds to THIS page: a body.theme-<key> class (drives the full
   per-theme palette + real sourced artwork in css/themes.css) plus a
   small set of empty, non-interactive decorative mounts injected
   fresh by this script -- never by editing existing page markup, so
   decorations can never land on top of nav/products/prices/buttons/
   forms by construction. This script only ever creates new, empty,
   aria-hidden elements; it never alters, removes, or restyles any
   existing element's content. All actual artwork (which icon goes
   where, at what size/position/rotation/opacity) is chosen entirely
   by css/themes.css's per-theme `mask-image` rules -- this file just
   mounts the anonymous hooks those rules target:
     - .theme-hero-decor: one mount, placed inside the page's hero
       section (.hero or .page-hero, whichever exists), containing a
       small scattered cluster of 5 .theme-hero-icon slots for the
       prominent seasonal composition -- never one single giant image.
     - .theme-decor-mount.theme-decor-top / -bottom: two small
       corner accents, present on every page (unchanged from Phase 2).
   Section-divider, Menu-category-heading, ballot, and footer artwork
   need no JS mount at all -- css/themes.css decorates those directly
   via ::before/::after on the existing (untouched) elements.

   This script does NOT compute the schedule itself -- it only ever
   reads theme_state's already-resolved columns (a single cheap
   public query, exactly like js/vacation-homepage.js's vacation
   status check), which is what makes "reliable at the exact
   transition moment, never reliant on the visitor's own device
   clock" true structurally. See supabase/functions/_shared/
   themeSchedule.mjs for where the actual resolution happens (the
   theme-scheduler cron Edge Function, at most 5 minutes stale).

   Fails safe to Classic (adds no class, injects nothing) on: a
   missing/errored query, the watchdog timing out, or an unrecognized
   theme_key -- mirrors js/vacation-homepage.js's
   VACATION_HOMEPAGE_WATCHDOG_MS pattern exactly. Classic itself needs
   zero added CSS, since it IS today's unmodified site.

   Admin preview support: a `?themePreview=<key>&intensity=<0.4-1>&
   graphics=<minimal|normal>` query param bypasses the DB entirely and
   applies that theme directly -- this is what admin/themes.html's
   preview iframes point the real public pages at (same-origin,
   zero effect on real visitors since the param is simply absent for
   them).
   ========================================== */

const THEME_APPLY_WATCHDOG_MS = 4000;

let themeApplyResolved = false;

document.addEventListener("DOMContentLoaded", () => {
    initThemeApply();
});

async function initThemeApply() {
    const watchdog = setTimeout(() => {
        if (!themeApplyResolved) {
            console.error("Theme status check did not resolve in time -- leaving Classic.");
        }
    }, THEME_APPLY_WATCHDOG_MS);

    try {
        const resolved = parseThemePreviewParams() || await fetchResolvedTheme();
        themeApplyResolved = true;
        clearTimeout(watchdog);

        if (!resolved || !resolved.theme_key || resolved.theme_key === "classic") {
            return;
        }

        applyTheme(resolved);
    } catch (err) {
        console.error("Theme apply failed -- leaving Classic.", err);
        themeApplyResolved = true;
        clearTimeout(watchdog);
    }
}

/** Reads the admin-preview override from the URL, if present. Pure
 *  (no DOM writes) so it's trivially testable. */
function parseThemePreviewParams() {
    const params = new URLSearchParams(window.location.search);
    const key = params.get("themePreview");
    if (!key) return null;

    const intensityParam = params.get("intensity");
    const intensityRaw = intensityParam === null || intensityParam === "" ? NaN : Number(intensityParam);
    return {
        theme_key: key,
        accent_intensity: Number.isFinite(intensityRaw) ? intensityRaw : 1,
        graphics_visibility: params.get("graphics") === "minimal" ? "minimal" : "normal"
    };
}

async function fetchResolvedTheme() {
    if (typeof supabaseClient === "undefined") return null;

    const { data, error } = await supabaseClient
        .from("theme_state")
        .select("resolved_theme_key, resolved_accent_intensity, resolved_graphics_visibility")
        .maybeSingle();

    if (error || !data) return null;

    return {
        theme_key: data.resolved_theme_key,
        accent_intensity: data.resolved_accent_intensity,
        graphics_visibility: data.resolved_graphics_visibility
    };
}

/** Clamps to the same [0.4, 1.0] safe-brand-limits range enforced by
 *  the DB CHECK constraint on accent_intensity -- defense in depth
 *  against a malformed/out-of-range value ever reaching real CSS. */
function clampIntensity(value) {
    // Number(null) and Number("") both coerce to 0 -- a falsely
    // "finite" value that would otherwise silently clamp a genuinely
    // missing intensity down to the floor instead of the intended
    // neutral default of 1.
    if (value === null || value === undefined || value === "") return 1;
    const n = Number(value);
    if (!Number.isFinite(n)) return 1;
    return Math.min(1, Math.max(0.4, n));
}

function prefersReducedMotion() {
    return typeof window.matchMedia === "function"
        && window.matchMedia("(prefers-reduced-motion: reduce)").matches === true;
}

function applyTheme(resolved) {
    const key = resolved.theme_key;
    if (!Object.prototype.hasOwnProperty.call(THEME_KEYS, key)) {
        // Unrecognized theme_key (e.g. a future catalog entry this
        // shipped copy doesn't know how to decorate yet) -- fail safe
        // to Classic rather than adding a class with no matching CSS.
        return;
    }

    document.body.classList.add("theme-" + key);
    document.documentElement.style.setProperty("--theme-intensity", String(clampIntensity(resolved.accent_intensity)));
    document.documentElement.style.setProperty(
        "--theme-graphics",
        resolved.graphics_visibility === "minimal" ? "minimal" : "normal"
    );

    // All decor is static, never animated, regardless of this check --
    // reduced-motion additionally hides it outright, since some users
    // find any persistent on-screen shape distracting, motion or not.
    if (!prefersReducedMotion() && resolved.graphics_visibility !== "minimal") {
        mountThemeDecor();
    }
}

/** Injects fresh, empty, non-interactive mount elements -- never
 *  touches existing page markup. .theme-decor-mount /
 *  .theme-hero-decor / .theme-hero-icon and their modifier classes
 *  are styled entirely in css/themes.css (which per-theme icon --
 *  via `mask-image` -- shows in each slot is a pure CSS decision),
 *  scoped so they can never overlap nav/content/forms (see that
 *  file's header comment for the enforced selector list). */
function mountThemeDecor() {
    const heroSection = document.querySelector(".hero, .page-hero");
    if (heroSection) {
        const heroMount = document.createElement("div");
        heroMount.className = "theme-hero-decor";
        heroMount.setAttribute("aria-hidden", "true");
        // A small scattered cluster, never one giant image -- see
        // css/themes.css's .theme-hero-icon.slot-1..5 rules.
        for (let i = 1; i <= HERO_ICON_SLOT_COUNT; i++) {
            const iconEl = document.createElement("div");
            iconEl.className = "theme-hero-icon slot-" + i;
            heroMount.appendChild(iconEl);
        }
        heroSection.insertBefore(heroMount, heroSection.firstChild);
    }

    ["theme-decor-top", "theme-decor-bottom"].forEach((positionClass) => {
        const mount = document.createElement("div");
        mount.className = "theme-decor-mount " + positionClass;
        mount.setAttribute("aria-hidden", "true");
        document.body.appendChild(mount);
    });
}

const HERO_ICON_SLOT_COUNT = 5;

/* ==========================================
   Every catalog theme key this shipped copy knows how to decorate.
   The actual artwork (which real, licensed image -- see
   images/themes/ARTWORK-CREDITS.md -- appears in the hero, corners,
   section dividers, menu headings, ballot, and footer) is chosen
   entirely by css/themes.css's `body.theme-<key>` rules; this file
   only needs to know a key is valid before adding the class. Adding
   a future custom theme means adding one key here plus its CSS block
   -- no scheduling-system change.
   ========================================== */
const THEME_KEYS = {
    spring: true, summer: true, autumn: true, winter: true,
    new_years: true, valentines: true, st_patricks: true, easter: true,
    fourth_of_july: true, halloween: true, thanksgiving: true, christmas: true
};
