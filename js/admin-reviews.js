document.addEventListener("DOMContentLoaded", async () => {
    await requireAuth();
    setupLogout();
    loadPendingReviews();
});

async function loadPendingReviews() {
    const container = document.getElementById("pendingReviews");

    if (!container) return;

    container.innerHTML = "<p>Loading reviews...</p>";

    const { data, error } = await AdminReviewsShared.fetchPendingReviews(supabaseClient);

    if (error) {
        console.error(error);
        container.innerHTML = "<p>Unable to load reviews.</p>";
        return;
    }

    renderPendingReviews(data || []);
}

function renderPendingReviews(reviews) {
    const container = document.getElementById("pendingReviews");

    if (!reviews.length) {
        container.innerHTML = "<p>No pending reviews.</p>";
        return;
    }

    container.innerHTML = reviews.map(review => `
        <article class="admin-review-card">
            <div class="admin-review-top">
                <div>
                    <h3>${escapeHtml(review.name)}</h3>
                    ${review.product ? `<p class="admin-product">${escapeHtml(review.product)}</p>` : ""}
                    ${adminOrderLinkBadgeHtml(review)}
                </div>

                <div class="admin-stars">
                    ${"★".repeat(review.rating)}${"☆".repeat(5 - review.rating)}
                </div>
            </div>

            <p class="admin-review-text">
                "${escapeHtml(review.review)}"
            </p>

            ${adminOrderSummaryHtml(review)}

            <div class="admin-review-actions">
                <button class="approve-btn" onclick="approveReview('${review.id}')">
                    Approve
                </button>

                <button class="delete-btn" onclick="deleteReview('${review.id}')">
                    Delete
                </button>
            </div>
        </article>
    `).join("");
}

/* Admin tooling only -- review.order_id/order_items_snapshot are
   never exposed to the public (see public_reviews view). Admins may
   see the real linkage and the customer's show_order_items choice
   regardless of that choice, per the admin-review-management spec. */
function adminOrderLinkBadgeHtml(review) {
    if (!review.order_id) {
        return `<p class="admin-order-badge admin-order-badge-general">General review (no order link)</p>`;
    }

    const shortRef = String(review.order_id).replace(/-/g, "").slice(0, 8);
    const visibility = review.show_order_items
        ? "shown publicly"
        : "hidden by customer";

    return `<p class="admin-order-badge admin-order-badge-linked">Linked to order #${escapeHtml(shortRef)} &middot; order details ${escapeHtml(visibility)}</p>`;
}

function adminOrderSummaryHtml(review) {
    if (!Array.isArray(review.order_items_snapshot) || !review.order_items_snapshot.length) {
        return "";
    }

    const items = review.order_items_snapshot.map(item => {
        const flavorsHtml = item.flavors && item.flavors.length
            ? `<ul class="admin-order-flavors">${item.flavors.map(
                f => `<li>${escapeHtml(f.name)} &times; ${escapeHtml(String(f.quantity))}</li>`
            ).join("")}</ul>`
            : "";
        const promoBadge = item.isPromo ? `<span class="promo-badge">Free</span>` : "";
        return `<li>${promoBadge}${escapeHtml(item.name)} &times; ${escapeHtml(String(item.quantity))}${flavorsHtml}</li>`;
    }).join("");

    return `<ul class="admin-order-summary-list">${items}</ul>`;
}

async function approveReview(id) {
    const { error } = await supabaseClient
        .from("reviews")
        .update({ approved: true })
        .eq("id", id);

    if (error) {
        console.error(error);
        alert(error.message);
        return;
    }

    loadPendingReviews();
}

async function deleteReview(id) {
    if (!confirm("Delete this review?")) return;

    const { error } = await supabaseClient
        .from("reviews")
        .delete()
        .eq("id", id);

    if (error) {
        console.error(error);
        alert(error.message);
        return;
    }

    loadPendingReviews();
}

function escapeHtml(value) {
    return String(value || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}
