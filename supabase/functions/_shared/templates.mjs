/* ==========================================
   EMAIL TEMPLATES (HTML + plain text)

   Pure functions -- given plain data objects, return
   { subject, html, text }. No DB/network access, so every template
   is directly unit-testable with fixture data.

   Email-safe HTML: single-column table layout, inline styles only
   (plus bgcolor attributes for Outlook, which does not reliably
   render CSS background-color on tables), no background images, no
   gradients, system font stack. The canonical brand colors below are
   copied from css/style.css's own :root custom properties on the
   live site (not approximated) -- email clients do not resolve CSS
   variables, so the literal hex values are inlined directly:
     --background  #D9C2B0  (warm cream/beige/tan -- the logo banner)
     --surface     #F5E8DC  (light ivory -- the content card)
     --burgundy    #5E1811  (outer frame, headings, button)
     --text        #3B2A24  (body copy)
     --muted       #6E554A  (footer/secondary text)
     --line        rgba(94,24,17,.15) -- has no reliable email-client
       equivalent, so SEPARATOR below is that exact color pre-blended
       to a solid hex over --surface (~#DEC9BE), for compatibility.
   Uses a cropped, email-safe derivative of the site's logo
   (jess-bakes-logo-email.png -- the original asset's visible wordmark
   only fills ~68%x48% of its canvas; this crop removes the excess
   transparent margin so the wordmark reads large and clear at email
   sizes) placed on the cream banner, never on burgundy (the original
   wordmark IS burgundy-colored -- burgundy-on-burgundy was invisible).

   Order emails (order_received / order_confirmed / order_cancelled)
   stay strictly transactional -- no unsubscribe link, no newsletter
   branding beyond the standard bakery-identity footer (name, site
   link, contact link, privacy link), per the project's consent
   rule: newsletter opt-in is separate from checkout.
   ========================================== */

const BURGUNDY = "#5E1811";
const LOGO_BANNER = "#D9C2B0";
const CREAM = "#F5E8DC";
const TEXT = "#3B2A24";
const MUTED = "#6E554A";
const SEPARATOR = "#DEC9BE";
const LOGO_URL = "https://jessbakessourdough.com/images/jess-bakes-logo-email.png";
const LOGO_WIDTH = 320;
const LOGO_HEIGHT = 84; // matches the cropped asset's real 682:180 aspect ratio at 320px wide
const SITE_URL = "https://jessbakessourdough.com";

// Order-confirmation payment options. Customers never select a payment
// method at checkout (there is no such field), so every confirmation
// email shows all four ways to pay -- never a conditional single
// method. These identifiers are fixed, owner-provided values (not an
// admin-editable setting, matching the existing pickup-location-only
// scope of Admin Settings) -- preserve them exactly if this file is
// ever touched again.
const ZELLE_NUMBER = "4434700714";
const PAYPAL_HANDLE = "@jessicaholsopple";
const VENMO_HANDLE = "@jessgodi";
const CONTACT_PHONE_DISPLAY = "+1 (443) 470-0714";
const CONTACT_PHONE_TEL = "tel:+14434700714";

function esc(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function eur(amount) {
    const n = Number(amount) || 0;
    return `€${n.toFixed(2)}`;
}

/** A payment-section USD amount is always a whole, floored dollar
 * figure by the time it reaches this template (see
 * CurrencyConversion.convertEurToUsdFlooredWhole / the
 * confirmation_usd_amount column snapshotted at order-confirm time) --
 * this only ever formats, never rounds. */
function usd(amount) {
    return `$${Math.trunc(Number(amount) || 0)} USD`;
}

/** "YYYY-MM-DD" -> "Sunday" (whatever weekday that specific date
 * actually falls on). Used instead of a hardcoded "Sunday" so these
 * emails automatically say the right day if the weekly pickup weekday
 * is ever changed in Admin Settings -- the stored pickup_date already
 * reflects whichever weekday was configured when the order was placed,
 * this just names it. Deliberately NOT a re-derivation of the
 * scheduling RULE itself (see js/weekly-schedule.js /
 * compute_weekly_pickup_from for the one canonical algorithm) -- just
 * formatting an already-decided date, safe to keep local and simple. */
function weekdayNameFromDateString(dateStr) {
    if (!dateStr) return "";
    const d = new Date(`${dateStr}T00:00:00`);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("en-US", { weekday: "long" });
}

/** "YYYY-MM-DD" -> "Sunday, August 30, 2026" -- the customer-friendly
 * date shown in the confirmation email, in place of the raw DB format.
 * Mirrors js/weekly-schedule.js's own formatFullDate() (same weekday/
 * month/day/year formatting) -- kept as a small local copy rather than
 * an import since this file is a dependency-free .mjs bundled straight
 * into Deno Edge Functions, while weekly-schedule.js is a browser/Node
 * UMD module; duplicating this one formatting call is safer than wiring
 * cross-runtime module interop for it. Not a re-derivation of the
 * scheduling RULE itself (see weekly-schedule.js's own
 * compute_weekly_pickup_from for that) -- just formatting an
 * already-decided date. Returns the raw string unchanged if it isn't a
 * plain YYYY-MM-DD date, so a malformed value is still shown rather
 * than silently disappearing. */
function formatFullDate(dateStr) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ""));
    if (!match) return dateStr || "";
    const d = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (Number.isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

/** "12:30:00" / "12:30" -> "12:30 PM". Returns "" for anything invalid
 * -- callers fall back to a generic line rather than showing a blank
 * time. */
function formatTime12h(timeStr) {
    const match = /^(\d{1,2}):(\d{2})/.exec(String(timeStr || ""));
    if (!match) return "";
    const hour = Number(match[1]);
    const minute = match[2];
    const period = hour >= 12 ? "PM" : "AM";
    const hour12 = hour % 12 === 0 ? 12 : hour % 12;
    return `${hour12}:${minute} ${period}`;
}

/** Escapes then converts admin-authored freeform text into safe
 * paragraph/line-break HTML -- blank lines become paragraph breaks,
 * single newlines become <br>. No tag other than <p>/<br> is ever
 * produced, so arbitrary HTML/script injection is impossible
 * regardless of what an admin types. Returns "" for empty input. */
function escParagraphs(text) {
    const value = String(text ?? "").trim();
    if (!value) {
        return "";
    }
    return value
        .split(/\n{2,}/)
        .map(para => `<p style="margin:0 0 14px 0;">${esc(para).replaceAll("\n", "<br>")}</p>`)
        .join("");
}

/** Sanitizes/normalizes admin-configured preheader text: collapses
 * any run of whitespace (including accidental newlines) into a
 * single space and trims. A preheader must be one short line -- this
 * is what stops "line breaks" or copy/paste artifacts from producing
 * a garbled inbox snippet. */
function normalizePreviewText(text) {
    return String(text ?? "").replace(/\s+/g, " ").trim();
}

/** Zero-width-joiner + non-breaking-space filler, repeated well past
 * what any inbox snippet window shows. This is the standard "preheader
 * padding" trick: a short real preheader alone leaves room for Gmail's
 * snippet scraper to keep reading past the hidden div and into the
 * next VISIBLE text (the heading, then the body) -- exactly what
 * caused the repetitive inbox preview. This filler exhausts that
 * budget with invisible, meaningless characters instead, so nothing
 * visible is ever pulled in. aria-hidden keeps it out of screen
 * readers (it has no meaning to announce). */
const PREHEADER_PADDING = "&zwnj;&nbsp;".repeat(60);

/** Shared HTML shell: burgundy outer frame -> centered card -> cream
 * logo banner -> ivory content area -> coordinated footer. Both a
 * hidden preheader (the actual inbox-preview text, shown exactly
 * once) and its padding block come immediately after <body>, before
 * any visible content, per the standard preheader pattern. `footerLinks`
 * is an array of {label, url}; pass an extra one for "Unsubscribe"
 * only on newsletter-type emails. */
function emailShell({ preheader, bodyHtml, footerLinks }) {
    const links = footerLinks
        .map(l => `<a href="${esc(l.url)}" style="color:${BURGUNDY};text-decoration:underline;">${esc(l.label)}</a>`)
        .join(' &nbsp;•&nbsp; ');

    const preheaderText = normalizePreviewText(preheader);

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Jess Bakes Sourdough</title>
</head>
<body style="margin:0;padding:0;background-color:${BURGUNDY};font-family:Georgia,'Times New Roman',serif;color:${TEXT};">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${esc(preheaderText)}</div>
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;" aria-hidden="true">${PREHEADER_PADDING}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${BURGUNDY}" style="background-color:${BURGUNDY};padding:32px 12px;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;border-radius:16px;overflow:hidden;">
<tr><td bgcolor="${LOGO_BANNER}" style="background-color:${LOGO_BANNER};padding:34px 24px;text-align:center;">
<img src="${LOGO_URL}" alt="Jess Bakes Sourdough" width="${LOGO_WIDTH}" height="${LOGO_HEIGHT}" style="display:block;margin:0 auto;width:70%;max-width:${LOGO_WIDTH}px;height:auto;">
</td></tr>
<tr><td bgcolor="${CREAM}" style="background-color:${CREAM};padding:32px 28px 12px 28px;font-size:16px;line-height:1.6;">
${bodyHtml}
</td></tr>
<tr><td bgcolor="${CREAM}" style="background-color:${CREAM};padding:20px 28px 28px 28px;border-top:1px solid ${SEPARATOR};font-size:12px;line-height:1.7;color:${MUTED};text-align:center;">
<p style="margin:0 0 6px 0;">Jess Bakes Sourdough &nbsp;•&nbsp; <a href="${SITE_URL}/" style="color:${MUTED};">${SITE_URL.replace("https://", "")}</a></p>
<p style="margin:0;">${links}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function textFooter(footerLines) {
    return `\n--\nJess Bakes Sourdough\n${SITE_URL}/\n${footerLines.join("\n")}\n`;
}

function itemsHtmlList(items) {
    return items.map(i =>
        `<tr>
          <td style="padding:6px 0;border-bottom:1px solid #f1e7da;">${esc(i.name)} &times; ${esc(i.quantity)}</td>
          <td style="padding:6px 0;border-bottom:1px solid #f1e7da;text-align:right;white-space:nowrap;">${eur(i.lineTotalEur)}</td>
        </tr>`
    ).join("");
}

function itemsTextList(items) {
    return items.map(i => `  - ${i.name} x${i.quantity} — ${eur(i.lineTotalEur)}`).join("\n");
}

/** Same as itemsHtmlList/itemsTextList but also shows unit price --
 * used only by the owner's internal admin_new_order notification,
 * never a customer-facing template (customers don't need to see the
 * per-unit price broken out, just the line total). */
function itemsHtmlListDetailed(items) {
    return items.map(i =>
        `<tr>
          <td style="padding:6px 0;border-bottom:1px solid #f1e7da;">${esc(i.name)} &times; ${esc(i.quantity)}</td>
          <td style="padding:6px 0;border-bottom:1px solid #f1e7da;text-align:right;white-space:nowrap;color:${MUTED};">${eur(i.unitPriceEur)} ea</td>
          <td style="padding:6px 0;border-bottom:1px solid #f1e7da;text-align:right;white-space:nowrap;">${eur(i.lineTotalEur)}</td>
        </tr>`
    ).join("");
}

function itemsTextListDetailed(items) {
    return items.map(i => `  - ${i.name} x${i.quantity} @ ${eur(i.unitPriceEur)} = ${eur(i.lineTotalEur)}`).join("\n");
}

/* ============================
   1) Order request received
   ============================ */
export function orderReceivedEmail({
    customerName, orderRef, items, subtotalEur,
    orderType, pickupDate, pickupTime, specialInstructions
}) {
    const weeklyPickupLabel = `Weekly ${weekdayNameFromDateString(pickupDate)} pickup`;
    const timeLabel = formatTime12h(pickupTime);

    const pickupLine = orderType === "weekly"
        ? `${weeklyPickupLabel} — requested for <strong>${esc(pickupDate)}</strong>${timeLabel ? `, ${esc(timeLabel)}` : ""}.`
        : `Custom order — requested for <strong>${esc(pickupDate)}</strong>. I'll confirm the exact time with you directly.`;

    const pickupLineText = orderType === "weekly"
        ? `${weeklyPickupLabel} — requested for ${pickupDate}${timeLabel ? `, ${timeLabel}` : ""}.`
        : `Custom order — requested for ${pickupDate}. I'll confirm the exact time with you directly.`;

    const notesHtml = specialInstructions
        ? `<p style="margin:16px 0 0 0;"><strong>Notes:</strong> ${esc(specialInstructions)}</p>`
        : "";
    const notesText = specialInstructions ? `\nNotes: ${specialInstructions}\n` : "";

    const bodyHtml = `
<h1 style="font-size:20px;margin:0 0 4px 0;">Order request received</h1>
<p style="margin:0 0 16px 0;color:${MUTED};">This confirms I received your request — it's <strong>not final approval</strong> yet. I'll follow up to confirm availability and your pickup details.</p>
<p style="margin:0 0 4px 0;">Hi ${esc(customerName)},</p>
<p style="margin:0 0 16px 0;">Reference: <strong>#${esc(orderRef)}</strong></p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px 0;">
${itemsHtmlList(items)}
<tr><td style="padding:10px 0 0 0;font-weight:bold;">Subtotal</td><td style="padding:10px 0 0 0;text-align:right;font-weight:bold;">${eur(subtotalEur)}</td></tr>
</table>
<p style="margin:16px 0 0 0;">${pickupLine}</p>
${notesHtml}
`;

    const text = `Order request received (not final approval)

Hi ${customerName},

Reference: #${orderRef}

Items:
${itemsTextList(items)}

Subtotal: ${eur(subtotalEur)}

${pickupLineText}
${notesText}
I'll follow up to confirm availability and your pickup details.
${textFooter(["Contact: " + SITE_URL + "/contact.html", "Privacy: " + SITE_URL + "/privacy.html"])}`;

    return {
        subject: `Order request received — #${orderRef}`,
        html: emailShell({
            preheader: "This confirms I received your order request.",
            bodyHtml,
            footerLinks: [
                { label: "Contact", url: `${SITE_URL}/contact.html` },
                { label: "Privacy", url: `${SITE_URL}/privacy.html` }
            ]
        }),
        text
    };
}

/* ============================
   2) Order confirmed

   Payment section (added 2026-08-28): customers never choose a payment
   method at checkout, so all four options -- Cash, Zelle, PayPal,
   Venmo -- are always shown together, never conditionally narrowed to
   one. Cash stays in EUR (what the customer actually agreed to pay);
   Zelle/PayPal/Venmo show the SAME pre-computed, already-floored USD
   figure (usdAmount) -- this template only formats it, it never
   converts or rounds anything itself. usdAmount/subtotalEur are the
   snapshot taken once at order-confirm time (see
   CurrencyConversion.convertEurToUsdFlooredWhole and the
   confirmation_usd_amount/confirmation_exchange_rate order columns) --
   so re-rendering this exact template later (a "Resend" retry) always
   reproduces the same amount the customer originally saw, never a
   freshly re-converted one.
   ============================ */
export function orderConfirmedEmail({
    customerName, orderRef, orderType, pickupDate, pickupTime, pickupLocation,
    subtotalEur, usdAmount
}) {
    const timeLine = orderType === "weekly"
        ? (formatTime12h(pickupTime) || "12:30 PM")
        : "I'll confirm the exact time with you directly.";

    const friendlyDate = formatFullDate(pickupDate);

    const locationHtml = pickupLocation
        ? `<p style="margin:12px 0 0 0;"><strong>Pickup location:</strong> ${esc(pickupLocation)}</p>`
        : `<p style="margin:12px 0 0 0;color:${MUTED};">Pickup location details will be sent separately.</p>`;
    const locationText = pickupLocation
        ? `Pickup location: ${pickupLocation}`
        : "Pickup location details will be sent separately.";

    const paymentHtml = `
<h2 style="font-size:17px;margin:24px 0 10px 0;color:${BURGUNDY};">Payment Options</h2>
<p style="margin:0 0 4px 0;"><strong>Order total:</strong> ${eur(subtotalEur)}</p>
<p style="margin:0 0 16px 0;">You may choose one of the following payment methods. Electronic payments may be sent before pickup or at pickup.</p>
<p style="margin:0 0 14px 0;"><strong>Cash at pickup:</strong> ${eur(subtotalEur)}<br>Please bring exact change. I typically don't have change available unless another customer also pays in cash.</p>
<p style="margin:0 0 14px 0;"><strong>Zelle:</strong> ${usd(usdAmount)}<br>Send payment to: <strong>${esc(ZELLE_NUMBER)}</strong></p>
<p style="margin:0 0 14px 0;"><strong>PayPal:</strong> ${usd(usdAmount)}<br>Send payment to: <strong>${esc(PAYPAL_HANDLE)}</strong></p>
<p style="margin:0;"><strong>Venmo:</strong> ${usd(usdAmount)}<br>Send payment to: <strong>${esc(VENMO_HANDLE)}</strong></p>
`;

    const paymentText = `Payment Options

Order total: ${eur(subtotalEur)}

You may choose one of the following payment methods. Electronic payments may be sent before pickup or at pickup.

Cash at pickup: ${eur(subtotalEur)}
Please bring exact change. I typically don't have change available unless another customer also pays in cash.

Zelle: ${usd(usdAmount)}
Send payment to: ${ZELLE_NUMBER}

PayPal: ${usd(usdAmount)}
Send payment to: ${PAYPAL_HANDLE}

Venmo: ${usd(usdAmount)}
Send payment to: ${VENMO_HANDLE}
`;

    const contactHtml = `<p style="margin:20px 0 0 0;">If you have any questions or concerns, please reach out to me at <a href="${CONTACT_PHONE_TEL}" style="color:${BURGUNDY};">${esc(CONTACT_PHONE_DISPLAY)}</a>.</p>`;
    const contactText = `If you have any questions or concerns, please reach out to me at ${CONTACT_PHONE_DISPLAY}.`;

    const bodyHtml = `
<h1 style="font-size:20px;margin:0 0 4px 0;">Your order is confirmed! 🎉</h1>
<p style="margin:0 0 4px 0;">Hi ${esc(customerName)},</p>
<p style="margin:0 0 16px 0;">Reference: <strong>#${esc(orderRef)}</strong></p>
<p style="margin:0;"><strong>Pickup date:</strong> ${esc(friendlyDate)}</p>
<p style="margin:4px 0 0 0;"><strong>Pickup time:</strong> ${esc(timeLine)}</p>
${locationHtml}
${paymentHtml}
${contactHtml}
`;

    const text = `Your order is confirmed!

Hi ${customerName},

Reference: #${orderRef}

Pickup date: ${friendlyDate}
Pickup time: ${timeLine}
${locationText}

${paymentText}
${contactText}
${textFooter(["Contact: " + SITE_URL + "/contact.html", "Privacy: " + SITE_URL + "/privacy.html"])}`;

    return {
        subject: `Order confirmed — #${orderRef}`,
        html: emailShell({
            preheader: "Your pickup date and time are confirmed.",
            bodyHtml,
            footerLinks: [
                { label: "Contact", url: `${SITE_URL}/contact.html` },
                { label: "Privacy", url: `${SITE_URL}/privacy.html` }
            ]
        }),
        text
    };
}

/* ============================
   3) Order cancelled
   ============================ */
export function orderCancelledEmail({ customerName, orderRef }) {
    const bodyHtml = `
<h1 style="font-size:20px;margin:0 0 4px 0;">Order cancelled</h1>
<p style="margin:0 0 4px 0;">Hi ${esc(customerName)},</p>
<p style="margin:0 0 16px 0;">Your order <strong>#${esc(orderRef)}</strong> has been cancelled.</p>
<p style="margin:0;">Questions? Reach out any time — I'm happy to help.</p>
`;

    const text = `Order cancelled

Hi ${customerName},

Your order #${orderRef} has been cancelled.

Questions? Reach out any time — I'm happy to help.
${textFooter(["Contact: " + SITE_URL + "/contact.html"])}`;

    return {
        subject: `Order cancelled — #${orderRef}`,
        html: emailShell({
            preheader: "Your order has been cancelled.",
            bodyHtml,
            footerLinks: [{ label: "Contact", url: `${SITE_URL}/contact.html` }]
        }),
        text
    };
}

/* ============================
   4) Newsletter welcome (single opt-in, informational only)
   ============================ */
export function newsletterWelcomeEmail({ name, unsubscribeUrl }) {
    const greeting = name ? `Hi ${esc(name)},` : "Hi,";
    const greetingText = name ? `Hi ${name},` : "Hi,";

    const bodyHtml = `
<h1 style="font-size:20px;margin:0 0 4px 0;">You're on the list! 🍞</h1>
<p style="margin:0 0 12px 0;">${greeting}</p>
<p style="margin:0 0 12px 0;">You're subscribed to the Jess Bakes Sourdough weekly menu email — I'll send it once a week with what's fresh and available to order.</p>
<p style="margin:0;color:${MUTED};">No action needed — this is just a confirmation. You can unsubscribe at any time using the link below.</p>
`;

    const text = `You're on the list!

${greetingText}

You're subscribed to the Jess Bakes Sourdough weekly menu email — I'll send it once a week with what's fresh and available to order.

No action needed — this is just a confirmation. You can unsubscribe at any time using the link below.
${textFooter(["Unsubscribe: " + unsubscribeUrl, "Privacy: " + SITE_URL + "/privacy.html"])}`;

    return {
        subject: "You're subscribed to the Jess Bakes Sourdough menu email",
        html: emailShell({
            preheader: "You're subscribed to the weekly menu email.",
            bodyHtml,
            footerLinks: [
                { label: "Privacy", url: `${SITE_URL}/privacy.html` },
                { label: "Unsubscribe", url: unsubscribeUrl }
            ]
        }),
        text
    };
}

/* ============================
   5) Weekly menu
   ============================ */
export function weeklyMenuEmail({ introMessage, items, unsubscribeUrl }) {
    const rows = items.map(i => `
<tr>
  <td style="padding:10px 0;border-bottom:1px solid #f1e7da;vertical-align:top;">
    <strong>${esc(i.name)}</strong>
    ${i.description ? `<div style="color:${MUTED};font-size:14px;margin-top:2px;">${esc(i.description)}</div>` : ""}
  </td>
  <td style="padding:10px 0;border-bottom:1px solid #f1e7da;text-align:right;white-space:nowrap;vertical-align:top;">${eur(i.priceEur)}</td>
</tr>`).join("");

    const textRows = items.map(i =>
        `  - ${i.name}${i.description ? " — " + i.description : ""} (${eur(i.priceEur)})`
    ).join("\n");

    const bodyHtml = `
<h1 style="font-size:20px;margin:0 0 12px 0;">This week's menu</h1>
<p style="margin:0 0 20px 0;">${esc(introMessage)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px 0;">
${rows}
</table>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
<tr><td style="background:${BURGUNDY};border-radius:8px;">
<a href="${SITE_URL}/menu.html" style="display:inline-block;padding:12px 28px;color:#ffffff;text-decoration:none;font-weight:bold;">View Menu &amp; Order</a>
</td></tr>
</table>
`;

    const text = `This week's menu

${introMessage}

${textRows}

View the menu and order: ${SITE_URL}/menu.html
${textFooter([
        "Gallery: " + SITE_URL + "/gallery.html",
        "Contact: " + SITE_URL + "/contact.html",
        "Privacy: " + SITE_URL + "/privacy.html",
        "Unsubscribe: " + unsubscribeUrl
    ])}`;

    return {
        subject: null, // caller supplies the admin-configured subject line
        html: emailShell({
            preheader: introMessage,
            bodyHtml,
            footerLinks: [
                { label: "Menu", url: `${SITE_URL}/menu.html` },
                { label: "Gallery", url: `${SITE_URL}/gallery.html` },
                { label: "Contact", url: `${SITE_URL}/contact.html` },
                { label: "Privacy", url: `${SITE_URL}/privacy.html` },
                { label: "Unsubscribe", url: unsubscribeUrl }
            ]
        }),
        text
    };
}

/* ============================
   6) Vacation reopening announcement

   Sent once per vacation cycle (see vacationReopeningCampaignKey),
   built from whatever the admin drafted PLUS a fresh, live read of
   the published menu at send time -- never a menu snapshot captured
   when Vacation Mode was first turned on.

   Fixed content order (never reordered by input): branding -> heading
   -> standard reopening sentence (always shown, never replaced by
   admin text) -> optional admin "Additional message" -> categorized,
   alphabetized menu -> one "View Menu & Order" button -> footer/
   unsubscribe. Deliberately carries NO pickup-date field of any kind
   -- reopening date and pickup date are separate concepts, and this
   email only ever announces that ordering has reopened.

   `categories` is the pre-grouped/sorted shape from
   buildVacationReopeningMenuCategories() in menu.mjs:
   [{ categoryLabel, items: [{ name, productType, builderSize }] }].
   Only the exact customer-facing product name is ever shown -- no
   appended instructions for Mix & Match/builder products (the "View
   Menu & Order" button is the one and only place customers are
   pointed to configure a box), no description, no price.

   `previewText` is the admin's own "Inbox Preview Text" -- passed
   straight through to emailShell() as the ONE hidden preheader, never
   concatenated with the subject/heading/standard sentence/Additional
   Message/menu. Falls back to the standard sentence only when the
   admin hasn't set one, so the hidden preheader is never blank.

   Layout is a simple vertical list per category (large burgundy
   title-case heading, then one product per line, a hairline rule
   between items only -- never a table grid, never side-by-side
   category cards), so it stays readable in Gmail desktop/mobile,
   Apple Mail, and narrow clients.
   ============================ */
export function vacationReopeningEmail({ additionalMessage, categories, previewText, unsubscribeUrl }) {
    const categoryBlocksHtml = (categories || []).map(cat => `
<div style="margin:0 0 26px 0;">
  <h2 style="margin:0 0 10px 0;font-size:19px;font-weight:700;color:${BURGUNDY};">${esc(cat.categoryLabel)}</h2>
  ${(cat.items || []).map(item => `
  <div style="padding:8px 0;font-size:15px;border-bottom:1px solid ${SEPARATOR};">${esc(item.name)}</div>`).join("")}
</div>`).join("");

    const categoryBlocksText = (categories || []).map(cat =>
        `${cat.categoryLabel}\n` +
        (cat.items || []).map(item => `  - ${item.name}`).join("\n")
    ).join("\n\n");

    const additionalHtml = escParagraphs(additionalMessage);
    const trimmedAdditional = String(additionalMessage ?? "").trim();
    const additionalText = trimmedAdditional ? `\n${trimmedAdditional}\n` : "";

    const bodyHtml = `
<h1 style="font-size:22px;margin:0 0 16px 0;color:${BURGUNDY};">Jess Bakes is back!</h1>
<p style="margin:0 0 20px 0;">We're back from vacation and ordering is now open!</p>
${additionalHtml}
<div style="margin:24px 0 28px 0;">
${categoryBlocksHtml}
</div>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px auto 0;">
<tr><td bgcolor="${BURGUNDY}" style="background-color:${BURGUNDY};border-radius:8px;">
<a href="${SITE_URL}/menu.html" style="display:inline-block;padding:14px 32px;color:${CREAM};text-decoration:none;font-weight:bold;">View Menu &amp; Order</a>
</td></tr>
</table>
`;

    const text = `Jess Bakes is back!

We're back from vacation and ordering is now open!
${additionalText}
${categoryBlocksText}

View the menu and order: ${SITE_URL}/menu.html
${textFooter([
        "Menu: " + SITE_URL + "/menu.html",
        "Gallery: " + SITE_URL + "/gallery.html",
        "Contact: " + SITE_URL + "/contact.html",
        "Privacy: " + SITE_URL + "/privacy.html",
        "Unsubscribe: " + unsubscribeUrl
    ])}`;

    return {
        subject: null, // caller supplies the admin-configured subject line
        html: emailShell({
            preheader: normalizePreviewText(previewText) || "We're back from vacation and ordering is now open!",
            bodyHtml,
            footerLinks: [
                { label: "Menu", url: `${SITE_URL}/menu.html` },
                { label: "Gallery", url: `${SITE_URL}/gallery.html` },
                { label: "Contact", url: `${SITE_URL}/contact.html` },
                { label: "Privacy", url: `${SITE_URL}/privacy.html` },
                { label: "Unsubscribe", url: unsubscribeUrl }
            ]
        }),
        text
    };
}

/* ============================
   7) Admin: new order notification (internal, to the bakery owner)

   Independent from orderReceivedEmail -- separate outbox row,
   separate idempotency key, separate enabled toggle -- but rendered
   from the exact same order/order_items data. Strictly internal:
   never sent to a customer, never linked from any public page.
   ============================ */
export function adminNewOrderEmail({
    customerName, customerEmail, customerPhone, preferredContact,
    orderRef, orderType, pickupDate, pickupTime, items, subtotalEur,
    specialInstructions, submittedAt
}) {
    const timeLine = orderType === "weekly"
        ? `${formatTime12h(pickupTime) || "12:30 PM"} (weekly ${weekdayNameFromDateString(pickupDate)} pickup)`
        : "Not yet set -- confirm the exact time with the customer.";

    const orderTypeLabel = orderType === "weekly" ? "Weekly" : "Custom";
    const submittedLine = submittedAt ? new Date(submittedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "Unknown";

    const notesHtml = specialInstructions
        ? `<p style="margin:12px 0 0 0;"><strong>Notes:</strong> ${esc(specialInstructions)}</p>`
        : "";
    const notesText = specialInstructions ? `\nNotes: ${specialInstructions}\n` : "";

    const bodyHtml = `
<h1 style="font-size:20px;margin:0 0 4px 0;">New order — #${esc(orderRef)}</h1>
<p style="margin:0 0 16px 0;color:${MUTED};">Submitted ${esc(submittedLine)}.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px 0;font-size:15px;">
<tr><td style="padding:2px 0;color:${MUTED};width:130px;">Customer</td><td style="padding:2px 0;"><strong>${esc(customerName)}</strong></td></tr>
<tr><td style="padding:2px 0;color:${MUTED};">Email</td><td style="padding:2px 0;">${esc(customerEmail || "—")}</td></tr>
<tr><td style="padding:2px 0;color:${MUTED};">Phone</td><td style="padding:2px 0;">${esc(customerPhone || "—")}</td></tr>
<tr><td style="padding:2px 0;color:${MUTED};">Prefers</td><td style="padding:2px 0;">${esc(preferredContact === "email" ? "Email" : "Text")}</td></tr>
<tr><td style="padding:2px 0;color:${MUTED};">Order type</td><td style="padding:2px 0;">${esc(orderTypeLabel)}</td></tr>
<tr><td style="padding:2px 0;color:${MUTED};">Pickup date</td><td style="padding:2px 0;">${esc(pickupDate)}</td></tr>
<tr><td style="padding:2px 0;color:${MUTED};">Pickup time</td><td style="padding:2px 0;">${esc(timeLine)}</td></tr>
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px 0;">
${itemsHtmlListDetailed(items)}
<tr><td style="padding:10px 0 0 0;font-weight:bold;" colspan="2">Total</td><td style="padding:10px 0 0 0;text-align:right;font-weight:bold;">${eur(subtotalEur)}</td></tr>
</table>
${notesHtml}
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px auto 0 auto;">
<tr><td style="background:${BURGUNDY};border-radius:8px;">
<a href="${SITE_URL}/admin/orders.html" style="display:inline-block;padding:12px 28px;color:#ffffff;text-decoration:none;font-weight:bold;">Open in Admin</a>
</td></tr>
</table>
`;

    const text = `New order — #${orderRef}

Submitted ${submittedLine}.

Customer: ${customerName}
Email: ${customerEmail || "—"}
Phone: ${customerPhone || "—"}
Prefers: ${preferredContact === "email" ? "Email" : "Text"}
Order type: ${orderTypeLabel}
Pickup date: ${pickupDate}
Pickup time: ${timeLine}

Items:
${itemsTextListDetailed(items)}

Total: ${eur(subtotalEur)}
${notesText}
Open in admin: ${SITE_URL}/admin/orders.html
${textFooter(["This is an internal notification -- not sent to the customer."])}`;

    return {
        subject: `New Jess Bakes order — ${customerName}`,
        html: emailShell({
            preheader: `New order from ${customerName} — ${eur(subtotalEur)}`,
            bodyHtml,
            footerLinks: [{ label: "Open in Admin", url: `${SITE_URL}/admin/orders.html` }]
        }),
        text
    };
}
