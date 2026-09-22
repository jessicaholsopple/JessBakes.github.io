/* ==========================================
   THEMES -- public-page application
   ==========================================

   Applies whichever theme theme_state.resolved_theme_key currently
   holds to THIS page: a body.theme-<key> class (drives the CSS
   custom-property accents in css/themes.css) plus 1-2 small,
   non-interactive decorative mounts injected fresh by this script --
   never by editing existing page markup, so decorations can never
   land on top of nav/products/prices/buttons/forms by construction.

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
    if (!Object.prototype.hasOwnProperty.call(THEME_DECOR, key)) {
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
        mountThemeDecor(key);
    }
}

/** Injects fresh, empty, non-interactive mount elements -- never
 *  touches existing page markup. .theme-decor-mount + its position
 *  modifier classes are styled entirely in css/themes.css, scoped so
 *  they can never overlap nav/content/forms (see that file's header
 *  comment for the enforced forbidden-selector list). */
function mountThemeDecor(key) {
    const svg = THEME_DECOR[key];
    if (!svg) return;

    ["theme-decor-top", "theme-decor-bottom"].forEach((positionClass) => {
        const mount = document.createElement("div");
        mount.className = "theme-decor-mount " + positionClass;
        mount.setAttribute("aria-hidden", "true");
        mount.innerHTML = svg;
        document.body.appendChild(mount);
    });
}

/* ==========================================
   DECOR CATALOG -- one small inline SVG per theme, muted and simple
   (line/shape art, never full-color clipart), rendered in
   `currentColor` so css/themes.css's per-theme accent variable
   controls its color. Adding a future custom theme means adding one
   entry here (plus its CSS block) -- no scheduling-system change.
   ========================================== */
const THEME_DECOR = {
    spring: `<svg viewBox="0 0 100 100" width="100%" height="100%">
        <g fill="currentColor" opacity="0.85">
            <circle cx="50" cy="30" r="14"/><circle cx="68" cy="42" r="14"/>
            <circle cx="61" cy="63" r="14"/><circle cx="39" cy="63" r="14"/>
            <circle cx="32" cy="42" r="14"/>
        </g>
        <circle cx="50" cy="46" r="8" fill="#fff8ef" opacity="0.9"/>
    </svg>`,

    summer: `<svg viewBox="0 0 100 100" width="100%" height="100%">
        <g stroke="currentColor" stroke-width="6" stroke-linecap="round">
            <line x1="50" y1="6" x2="50" y2="22"/><line x1="50" y1="78" x2="50" y2="94"/>
            <line x1="6" y1="50" x2="22" y2="50"/><line x1="78" y1="50" x2="94" y2="50"/>
            <line x1="19" y1="19" x2="30" y2="30"/><line x1="70" y1="70" x2="81" y2="81"/>
            <line x1="81" y1="19" x2="70" y2="30"/><line x1="30" y1="70" x2="19" y2="81"/>
        </g>
        <circle cx="50" cy="50" r="18" fill="currentColor"/>
    </svg>`,

    autumn: `<svg viewBox="0 0 100 100" width="100%" height="100%">
        <path d="M50 12 C70 22 82 42 78 62 C74 82 58 92 50 92 C42 92 26 82 22 62 C18 42 30 22 50 12 Z" fill="currentColor" opacity="0.85"/>
        <path d="M50 20 L50 88" stroke="#fff8ef" stroke-width="3" opacity="0.5"/>
        <path d="M50 92 L44 100" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>
    </svg>`,

    winter: `<svg viewBox="0 0 100 100" width="100%" height="100%">
        <g stroke="currentColor" stroke-width="5" stroke-linecap="round">
            <line x1="50" y1="8" x2="50" y2="92"/>
            <line x1="14" y1="29" x2="86" y2="71"/>
            <line x1="14" y1="71" x2="86" y2="29"/>
            <line x1="50" y1="26" x2="40" y2="18"/><line x1="50" y1="26" x2="60" y2="18"/>
            <line x1="50" y1="74" x2="40" y2="82"/><line x1="50" y1="74" x2="60" y2="82"/>
        </g>
    </svg>`,

    new_years: `<svg viewBox="0 0 100 100" width="100%" height="100%">
        <g stroke="currentColor" stroke-width="5" stroke-linecap="round">
            <line x1="50" y1="10" x2="50" y2="28"/><line x1="50" y1="72" x2="50" y2="90"/>
            <line x1="10" y1="50" x2="28" y2="50"/><line x1="72" y1="50" x2="90" y2="50"/>
            <line x1="22" y1="22" x2="34" y2="34"/><line x1="66" y1="66" x2="78" y2="78"/>
            <line x1="78" y1="22" x2="66" y2="34"/><line x1="34" y1="66" x2="22" y2="78"/>
        </g>
        <circle cx="50" cy="50" r="7" fill="currentColor"/>
        <circle cx="78" cy="30" r="4" fill="currentColor" opacity="0.7"/>
        <circle cx="24" cy="70" r="4" fill="currentColor" opacity="0.7"/>
    </svg>`,

    valentines: `<svg viewBox="0 0 100 100" width="100%" height="100%">
        <path d="M50 88 C20 64 8 44 8 28 C8 12 22 4 34 10 C42 14 48 22 50 28 C52 22 58 14 66 10 C78 4 92 12 92 28 C92 44 80 64 50 88 Z" fill="currentColor" opacity="0.85"/>
    </svg>`,

    st_patricks: `<svg viewBox="0 0 100 100" width="100%" height="100%">
        <g fill="currentColor" opacity="0.85">
            <path d="M50 50 C50 34 38 22 26 24 C14 26 10 40 22 48 C30 54 42 54 50 50 Z"/>
            <path d="M50 50 C50 34 62 22 74 24 C86 26 90 40 78 48 C70 54 58 54 50 50 Z"/>
            <path d="M50 50 C34 50 22 38 24 26 C26 14 40 10 48 22 C54 30 54 42 50 50 Z"/>
        </g>
        <line x1="50" y1="50" x2="50" y2="90" stroke="currentColor" stroke-width="5" stroke-linecap="round"/>
    </svg>`,

    easter: `<svg viewBox="0 0 100 100" width="100%" height="100%">
        <ellipse cx="50" cy="54" rx="30" ry="40" fill="currentColor" opacity="0.85"/>
        <path d="M22 46 Q35 36 50 46 T78 46" stroke="#fff8ef" stroke-width="4" fill="none" opacity="0.6"/>
        <path d="M20 62 Q35 52 50 62 T80 62" stroke="#fff8ef" stroke-width="4" fill="none" opacity="0.6"/>
    </svg>`,

    fourth_of_july: `<svg viewBox="0 0 100 100" width="100%" height="100%">
        <polygon points="50,6 61,38 95,38 68,58 79,92 50,72 21,92 32,58 5,38 39,38" fill="currentColor" opacity="0.85"/>
    </svg>`,

    halloween: `<svg viewBox="0 0 100 100" width="100%" height="100%">
        <g fill="currentColor" opacity="0.85">
            <path d="M50 40 C40 20 10 18 4 34 C14 32 26 36 34 46 C22 44 10 50 8 60 C20 54 34 54 42 60 C46 66 54 66 58 60 C66 54 80 54 92 60 C90 50 78 44 66 46 C74 36 86 32 96 34 C90 18 60 20 50 40 Z"/>
            <circle cx="46" cy="38" r="3" fill="#fff8ef"/><circle cx="54" cy="38" r="3" fill="#fff8ef"/>
        </g>
    </svg>`,

    thanksgiving: `<svg viewBox="0 0 100 100" width="100%" height="100%">
        <g fill="currentColor" opacity="0.85">
            <ellipse cx="50" cy="64" rx="24" ry="26"/>
            <path d="M26 46 Q50 28 74 46 Q74 34 50 30 Q26 34 26 46 Z"/>
        </g>
        <line x1="50" y1="30" x2="50" y2="18" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>
    </svg>`,

    christmas: `<svg viewBox="0 0 100 100" width="100%" height="100%">
        <g fill="currentColor" opacity="0.85">
            <path d="M50 50 C30 40 20 20 30 8 C40 20 46 36 50 50 Z"/>
            <path d="M50 50 C70 40 80 20 70 8 C60 20 54 36 50 50 Z"/>
        </g>
        <g fill="#c0392b" opacity="0.9">
            <circle cx="44" cy="58" r="6"/><circle cx="56" cy="58" r="6"/><circle cx="50" cy="68" r="6"/>
        </g>
    </svg>`
};
