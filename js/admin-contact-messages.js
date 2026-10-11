/* ==========================================
   ADMIN CONTACT MESSAGES (admin/contact-messages.html)
   ==========================================

   Read/update/delete only -- every row is CREATED by the public
   contact-submit Edge Function (service-role client), never from
   here. This page is governed by the same "Admins can..." RLS
   policies as every other admin table (see
   supabase/migrations/20260831093000_contact_messages_schema.sql).
   ========================================== */

let contactMessages = [];

document.addEventListener("DOMContentLoaded", async () => {

    await requireAuth();

    loadContactMessages();

    document
        .getElementById("contactMessageSearch")
        .addEventListener("input", filterContactMessages);

});

async function loadContactMessages() {

    const { data, error } =
        await supabaseClient
            .from("contact_messages")
            .select("*")
            .order("created_at", { ascending: false });

    if (error) {
        console.error(error);
        return;
    }

    contactMessages = data || [];
    renderContactMessages(contactMessages);

}

function renderContactMessages(list) {

    document.getElementById("contactTotalCount").textContent = contactMessages.length;
    document.getElementById("contactUnreadCount").textContent =
        contactMessages.filter(m => !m.is_read).length;

    const tbody = document.getElementById("contactMessageTableBody");
    tbody.innerHTML = "";

    if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="8">No contact messages yet.</td></tr>`;
        return;
    }

    list.forEach(msg => {

        const tr = document.createElement("tr");
        if (!msg.is_read) {
            tr.className = "contact-message-unread-row";
        }

        const preview = (msg.message || "").length > 80
            ? msg.message.slice(0, 80) + "…"
            : msg.message;

        tr.innerHTML = `
            <td>${msg.is_read ? "" : `<span class="nav-badge" aria-label="Unread">•</span>`}</td>
            <td>${formatDateTime(msg.created_at)}</td>
            <td>${escapeHtml(msg.name)}</td>
            <td><a href="mailto:${encodeURIComponent(msg.email)}">${escapeHtml(msg.email)}</a></td>
            <td>${escapeHtml(msg.order_reference || "—")}</td>
            <td>${escapeHtml(preview)}</td>
            <td>
                ${msg.is_resolved ? `<span class="status-badge status-confirmed">Resolved</span>` : `<span class="status-badge status-pending">${msg.is_read ? "Read" : "Unread"}</span>`}
            </td>
            <td>
                <button class="secondary-btn" onclick="openContactMessage('${msg.id}')">View</button>
            </td>
        `;

        tbody.appendChild(tr);

    });

}

function filterContactMessages() {

    const search =
        document.getElementById("contactMessageSearch").value.toLowerCase();

    renderContactMessages(
        contactMessages.filter(m =>
            (m.name || "").toLowerCase().includes(search) ||
            (m.email || "").toLowerCase().includes(search) ||
            (m.order_reference || "").toLowerCase().includes(search)
        )
    );

}

/* ==========================================
   DETAIL MODAL
========================================== */

function ensureContactMessageModal() {
    if (document.getElementById("contactMessageModal")) return;

    const modal = document.createElement("div");
    modal.id = "contactMessageModal";
    modal.className = "modal-overlay";
    modal.style.display = "none";

    modal.innerHTML = `
        <div class="modal-card">
            <div class="modal-header">
                <h2>Message</h2>
                <button class="modal-close" onclick="closeContactMessageModal()">✕</button>
            </div>

            <div class="modal-body">
                <p><strong>From:</strong> <span id="contactDetailName"></span></p>
                <p><strong>Email:</strong> <a id="contactDetailEmailLink" href="#"></a></p>
                <p><strong>Order reference:</strong> <span id="contactDetailOrderRef"></span></p>
                <p><strong>Received:</strong> <span id="contactDetailDate"></span></p>
                <p><strong>Message:</strong></p>
                <p id="contactDetailMessage" class="contact-detail-message"></p>
            </div>

            <div class="modal-footer">
                <button class="secondary-btn" id="contactDetailUnreadBtn" onclick="toggleContactMessageRead()"></button>
                <button class="secondary-btn" id="contactDetailResolveBtn" onclick="toggleContactMessageResolved()"></button>
                <button class="danger-btn" onclick="deleteContactMessage()">Delete</button>
                <a class="primary-btn" id="contactDetailReplyBtn" href="#">Reply by Email</a>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
}

let openContactMessageId = null;

async function openContactMessage(id) {

    ensureContactMessageModal();

    const msg = contactMessages.find(m => m.id === id);
    if (!msg) return;

    openContactMessageId = id;

    document.getElementById("contactDetailName").textContent = msg.name;

    const emailLink = document.getElementById("contactDetailEmailLink");
    emailLink.href = buildReplyMailto(msg);
    emailLink.textContent = msg.email;

    document.getElementById("contactDetailOrderRef").textContent = msg.order_reference || "—";
    document.getElementById("contactDetailDate").textContent = formatDateTime(msg.created_at);
    document.getElementById("contactDetailMessage").textContent = msg.message;

    document.getElementById("contactDetailReplyBtn").href = buildReplyMailto(msg);

    updateContactDetailButtons(msg);

    document.getElementById("contactMessageModal").style.display = "flex";

    // Opening a message marks it read -- the same convenience default
    // as any ordinary email client -- but an explicit "Mark unread"
    // button (see updateContactDetailButtons) lets the admin flag it
    // back for follow-up.
    if (!msg.is_read) {
        await setContactMessageRead(id, true, { silent: true });
    }

}

function updateContactDetailButtons(msg) {
    const unreadBtn = document.getElementById("contactDetailUnreadBtn");
    unreadBtn.textContent = msg.is_read ? "Mark Unread" : "Mark Read";

    const resolveBtn = document.getElementById("contactDetailResolveBtn");
    resolveBtn.textContent = msg.is_resolved ? "Mark Unresolved" : "Mark Resolved";
}

function buildReplyMailto(msg) {
    const subject = encodeURIComponent(
        "Re: Your message to Jess Bakes Sourdough" + (msg.order_reference ? ` (${msg.order_reference})` : "")
    );
    return `mailto:${encodeURIComponent(msg.email)}?subject=${subject}`;
}

function closeContactMessageModal() {
    const modal = document.getElementById("contactMessageModal");
    if (modal) modal.style.display = "none";
    openContactMessageId = null;
}

async function setContactMessageRead(id, isRead, { silent } = {}) {

    const { error } =
        await supabaseClient
            .from("contact_messages")
            .update({ is_read: isRead })
            .eq("id", id);

    if (error) {
        if (!silent) alert(error.message);
        return;
    }

    const msg = contactMessages.find(m => m.id === id);
    if (msg) msg.is_read = isRead;

    renderContactMessages(contactMessages);

    if (openContactMessageId === id) {
        updateContactDetailButtons(msg);
    }

}

async function toggleContactMessageRead() {
    if (!openContactMessageId) return;
    const msg = contactMessages.find(m => m.id === openContactMessageId);
    if (!msg) return;
    await setContactMessageRead(openContactMessageId, !msg.is_read);
}

async function toggleContactMessageResolved() {
    if (!openContactMessageId) return;
    const msg = contactMessages.find(m => m.id === openContactMessageId);
    if (!msg) return;

    const { error } =
        await supabaseClient
            .from("contact_messages")
            .update({ is_resolved: !msg.is_resolved })
            .eq("id", openContactMessageId);

    if (error) {
        alert(error.message);
        return;
    }

    msg.is_resolved = !msg.is_resolved;
    renderContactMessages(contactMessages);
    updateContactDetailButtons(msg);

}

async function deleteContactMessage() {
    if (!openContactMessageId) return;

    if (!confirm("Delete this message permanently? This cannot be undone.")) {
        return;
    }

    const { error } =
        await supabaseClient
            .from("contact_messages")
            .delete()
            .eq("id", openContactMessageId);

    if (error) {
        alert(error.message);
        return;
    }

    contactMessages = contactMessages.filter(m => m.id !== openContactMessageId);
    renderContactMessages(contactMessages);
    closeContactMessageModal();

}

/* ==========================================
   HELPERS
========================================== */

function formatDateTime(date) {
    return new Date(date).toLocaleString();
}

function escapeHtml(text) {
    return String(text ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}
