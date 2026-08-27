/* ==========================================
   EMAIL TEMPLATES (HTML + plain text)

   Pure functions -- given plain data objects, return
   { subject, html, text }. No DB/network access, so every template
   is directly unit-testable with fixture data.

   Email-safe HTML: single-column table layout, inline styles only,
   no background images, no external stylesheet, system font stack.
   Uses only the site's existing logo (absolute URL) -- no new or
   generated graphics. Matches the public site's warm palette
   (burgundy accent #7a2d1d, cream background, --muted #6E554A, per
   css/style.css).

   Order emails (order_received / order_confirmed / order_cancelled)
   stay strictly transactional -- no unsubscribe link, no newsletter
   branding beyond the standard bakery-identity footer (name, site
   link, contact link, privacy link), per the project's consent
   rule: newsletter opt-in is separate from checkout.
   ========================================== */

const BURGUNDY = "#7a2d1d";
const CREAM = "#FBF3E7";
const TEXT = "#3B2A20";
const MUTED = "#6E554A";
const LOGO_URL = "https://jessbakessourdough.com/images/jess-bakes-logo.png";
const SITE_URL = "https://jessbakessourdough.com";

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

/** Shared HTML shell: logo header, a body slot, and a standard
 * identity footer. `footerLinks` is an array of {label, url}; pass
 * an extra one for "Unsubscribe" only on newsletter-type emails. */
function emailShell({ preheader, bodyHtml, footerLinks }) {
    const links = footerLinks
        .map(l => `<a href="${esc(l.url)}" style="color:${MUTED};text-decoration:underline;">${esc(l.label)}</a>`)
        .join(' &nbsp;•&nbsp; ');

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Jess Bakes Sourdough</title>
</head>
<body style="margin:0;padding:0;background:${CREAM};font-family:Georgia,'Times New Roman',serif;color:${TEXT};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader || "")}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CREAM};padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;">
<tr><td style="background:${BURGUNDY};padding:24px;text-align:center;">
<img src="${LOGO_URL}" alt="Jess Bakes Sourdough" width="120" style="display:inline-block;height:auto;max-width:120px;">
</td></tr>
<tr><td style="padding:28px 28px 8px 28px;font-size:16px;line-height:1.6;">
${bodyHtml}
</td></tr>
<tr><td style="padding:20px 28px 28px 28px;border-top:1px solid #eee;font-size:12px;line-height:1.7;color:${MUTED};text-align:center;">
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
    orderType, pickupDate, specialInstructions
}) {
    const pickupLine = orderType === "weekly"
        ? `Weekly Sunday pickup — requested for <strong>${esc(pickupDate)}</strong>, 12:30 PM.`
        : `Custom order — requested for <strong>${esc(pickupDate)}</strong>. I'll confirm the exact time with you directly.`;

    const pickupLineText = orderType === "weekly"
        ? `Weekly Sunday pickup — requested for ${pickupDate}, 12:30 PM.`
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
   ============================ */
export function orderConfirmedEmail({
    customerName, orderRef, orderType, pickupDate, pickupLocation
}) {
    const timeLine = orderType === "weekly"
        ? "12:30 PM"
        : "I'll confirm the exact time with you directly.";

    const locationHtml = pickupLocation
        ? `<p style="margin:12px 0 0 0;"><strong>Pickup location:</strong> ${esc(pickupLocation)}</p>`
        : `<p style="margin:12px 0 0 0;color:${MUTED};">Pickup location details will be sent separately.</p>`;
    const locationText = pickupLocation
        ? `Pickup location: ${pickupLocation}`
        : "Pickup location details will be sent separately.";

    const bodyHtml = `
<h1 style="font-size:20px;margin:0 0 4px 0;">Your order is confirmed! 🎉</h1>
<p style="margin:0 0 4px 0;">Hi ${esc(customerName)},</p>
<p style="margin:0 0 16px 0;">Reference: <strong>#${esc(orderRef)}</strong></p>
<p style="margin:0;"><strong>Pickup date:</strong> ${esc(pickupDate)}</p>
<p style="margin:4px 0 0 0;"><strong>Pickup time:</strong> ${esc(timeLine)}</p>
${locationHtml}
`;

    const text = `Your order is confirmed!

Hi ${customerName},

Reference: #${orderRef}

Pickup date: ${pickupDate}
Pickup time: ${timeLine}
${locationText}
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
   [{ categoryLabel, items: [{ name, productType }] }]. Mix & Match/
   builder products get a short inline note instead of ever expanding
   into every possible flavor -- the same "don't enumerate every
   flavor" design already used by every other customer-facing
   template in this file.
   ============================ */
export function vacationReopeningEmail({ additionalMessage, categories, unsubscribeUrl }) {
    const builderNote = "(choose your own flavors on the Menu)";

    const categoryBlocksHtml = (categories || []).map(cat => `
<tr><td style="padding:18px 0 6px 0;">
  <h2 style="margin:0;font-size:17px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${BURGUNDY};">${esc(cat.categoryLabel)}</h2>
</td></tr>
${(cat.items || []).map(item => `
<tr><td style="padding:5px 0 5px 4px;font-size:14px;border-bottom:1px solid #f1e7da;">
  ${esc(item.name)}${item.productType === "builder" ? ` <span style="color:${MUTED};font-size:12px;">${builderNote}</span>` : ""}
</td></tr>`).join("")}`).join("");

    const categoryBlocksText = (categories || []).map(cat =>
        `${String(cat.categoryLabel || "").toUpperCase()}\n` +
        (cat.items || []).map(item =>
            `  - ${item.name}${item.productType === "builder" ? " " + builderNote : ""}`
        ).join("\n")
    ).join("\n\n");

    const additionalHtml = escParagraphs(additionalMessage);
    const trimmedAdditional = String(additionalMessage ?? "").trim();
    const additionalText = trimmedAdditional ? `\n${trimmedAdditional}\n` : "";

    const bodyHtml = `
<h1 style="font-size:20px;margin:0 0 12px 0;">Jess Bakes is back!</h1>
<p style="margin:0 0 8px 0;">We're back from vacation and ordering is now open!</p>
${additionalHtml}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:12px 0 20px 0;">
${categoryBlocksHtml}
</table>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
<tr><td style="background:${BURGUNDY};border-radius:8px;">
<a href="${SITE_URL}/menu.html" style="display:inline-block;padding:12px 28px;color:#ffffff;text-decoration:none;font-weight:bold;">View Menu &amp; Order</a>
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
            preheader: "We're back from vacation and ordering is now open!",
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
    orderRef, orderType, pickupDate, items, subtotalEur,
    specialInstructions, submittedAt
}) {
    const timeLine = orderType === "weekly"
        ? "12:30 PM (weekly Sunday pickup)"
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
