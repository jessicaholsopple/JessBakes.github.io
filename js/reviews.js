let reviews = [];
let selectedRating = 0;
let reviewMode = "general"; // "general" (no secure link) or "order" (valid review link)
let reviewToken = null;
let orderItemsForPreview = [];

document.addEventListener("DOMContentLoaded", () => {

    initializeStars();

    loadReviews();

    attachLivePreviewListeners();

    document
        .getElementById("reviewForm")
        .addEventListener("submit", submitReview);

    const params = new URLSearchParams(window.location.search);
    const token = params.get("t");

    if (token) {

        initOrderLinkedForm(token);

    }

});

/* ==========================================
   ORDER-LINKED FORM (opened via the review-request email's ?t= link)
   ========================================== */

async function initOrderLinkedForm(token) {

    document.getElementById("reviewLoading").style.display = "block";

    const { data, error } = await supabaseClient
        .functions
        .invoke("get-review-order", { body: { token } });

    document.getElementById("reviewLoading").style.display = "none";

    if (error || !data || !data.ok) {

        showTokenMessage(tokenMessageFor(data && data.reason));
        return;

    }

    reviewMode = "order";
    reviewToken = token;
    orderItemsForPreview = data.items || [];

    document.getElementById("reviewFormHeading").textContent = "How was your order?";

    document.getElementById("reviewFormIntro").textContent =
        "Your order details are already filled in below — just add your rating and review.";

    document.getElementById("generalModeNote").style.display = "none";

    const nameInput = document.getElementById("reviewName");
    nameInput.value = data.suggestedName || "";
    document.getElementById("reviewNameHelper").style.display = "block";

    renderOrderSummary(orderItemsForPreview, "orderSummaryList");
    document.getElementById("orderSummarySection").style.display = "block";
    document.getElementById("reviewLivePreview").style.display = "block";

    updateLivePreview();

}

function tokenMessageFor(reason) {

    switch (reason) {

        case "expired":
            return "This review link has expired. Review links stay valid for 30 days after your order is completed.";

        case "used":
            return "A review has already been submitted for this order. Thank you!";

        case "rate_limited":
            return "Too many attempts. Please try again in a little while.";

        case "invalid":
        default:
            return "This review link isn't valid. It may have been copied incorrectly, or it points to an order that's no longer available. You can still leave a general review below.";

    }

}

function showTokenMessage(message) {

    const box = document.getElementById("reviewTokenMessage");
    box.textContent = message;
    box.style.display = "block";

}

/* ==========================================
   ORDER SUMMARY (read-only, same shape used in the live preview and
   on public/admin review cards)
   ========================================== */

function renderOrderSummary(items, targetId) {

    const list = document.getElementById(targetId);
    if (!list) return;

    if (!items || !items.length) {
        list.innerHTML = "<li>No items on file for this order.</li>";
        return;
    }

    list.innerHTML = items.map(orderSummaryItemHtml).join("");

}

function orderSummaryItemHtml(item) {

    const flavorsHtml = item.flavors && item.flavors.length
        ? `<ul class="order-summary-flavors">${item.flavors.map(
            f => `<li>${escapeHtml(f.name)} &times; ${escapeHtml(String(f.quantity))}</li>`
        ).join("")}</ul>`
        : "";

    const promoBadge = item.isPromo ? `<span class="promo-badge">Free</span>` : "";

    return `<li>${promoBadge}${escapeHtml(item.name)} &times; ${escapeHtml(String(item.quantity))}${flavorsHtml}</li>`;

}

/* ==========================================
   LIVE PREVIEW (order-linked form only)
   ========================================== */

function attachLivePreviewListeners() {

    ["reviewName", "reviewText"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener("input", updateLivePreview);
    });

    const toggle = document.getElementById("showOrderItems");
    if (toggle) toggle.addEventListener("change", updateLivePreview);

}

function updateLivePreview() {

    if (reviewMode !== "order") return;

    const name = document.getElementById("reviewName").value.trim() || "Your Name";
    const text = document.getElementById("reviewText").value.trim();
    const showOrder = document.getElementById("showOrderItems").checked;

    document.getElementById("previewName").textContent = name;
    document.getElementById("previewText").textContent =
        text ? `"${text}"` : `"Your review will appear here..."`;
    document.getElementById("previewStars").textContent = generateStars(selectedRating);

    const previewList = document.getElementById("previewOrderList");

    if (showOrder) {
        renderOrderSummary(orderItemsForPreview, "previewOrderList");
        previewList.style.display = "block";
    } else {
        previewList.style.display = "none";
    }

}

/* ==========================================
   PUBLIC REVIEW LIST
   ========================================== */

async function loadReviews() {

    // public_reviews is a view, not the raw reviews table -- it
    // already filters to approved:true and masks order_items_snapshot
    // to null whenever a customer chose show_order_items:false, at
    // the database layer (see supabase/migrations/
    // 20261123100000_reviews_order_linking_and_request_tokens.sql).
    const { data, error } = await supabaseClient

        .from("public_reviews")

        .select("*")

        .order("created_at", {
            ascending: false
        });

    if (error) {

        console.error(error);

        return;

    }

    reviews = data || [];

    renderReviewSummary();

    renderReviews();

}

function renderReviewSummary() {

    const summary = document.getElementById("reviewSummary");

    if (!reviews.length) {

        summary.innerHTML = `

            <div class="review-summary-card">

                <div class="review-stars">

                    ★★★★★

                </div>

                <h3>No reviews yet</h3>

                <p>

                    Be the first to leave a review after trying one of my bakes.

                </p>

            </div>

        `;

        return;

    }

    const totalReviews = reviews.length;

    const average =

        reviews.reduce((sum, review) => sum + review.rating, 0)

        / totalReviews;

    summary.innerHTML = `

        <div class="review-summary-card">

            <div class="review-stars">

                ${generateStars(Math.round(average))}

            </div>

            <h3>${average.toFixed(1)} Average Rating</h3>

            <p>

                Based on ${totalReviews}

                review${totalReviews === 1 ? "" : "s"}

            </p>

        </div>

    `;

}

function renderReviews() {

    const list = document.getElementById("reviewList");

    if (!reviews.length) {

        list.innerHTML = "";

        return;

    }

    list.innerHTML = reviews

        .map(review => createReviewCard(review))

        .join("");

}

function createReviewCard(review) {

    const orderHtml = reviewCardOrderSummaryHtml(review);

    // Legacy reviews (submitted before this feature existed) carry a
    // free-text `product` value and no order_items_snapshot -- shown
    // as-is, never invented/backfilled with fake order data.
    const legacyProductHtml = (!orderHtml && review.product)
        ? `<p class="review-product">${escapeHtml(review.product)}</p>`
        : "";

    return `

        <article class="review-card">

            <div class="review-stars">

                ${generateStars(review.rating)}

            </div>

            ${legacyProductHtml}

            <p class="review-text">

                "${escapeHtml(review.review)}"

            </p>

            ${orderHtml}

            <div class="review-footer">

                <strong>

                    ${escapeHtml(review.public_name)}

                </strong>

                <span>

                    ${formatDate(review.created_at)}

                </span>

            </div>

        </article>

    `;

}

function reviewCardOrderSummaryHtml(review) {

    if (!Array.isArray(review.order_items_snapshot) || !review.order_items_snapshot.length) {
        return "";
    }

    return `<ul class="order-summary-list review-card-order-list">${
        review.order_items_snapshot.map(orderSummaryItemHtml).join("")
    }</ul>`;

}

function generateStars(rating) {

    let stars = "";

    for (let i = 1; i <= 5; i++) {

        stars += i <= rating ? "★" : "☆";

    }

    return stars;

}

function formatDate(dateString) {

    return new Date(dateString)

        .toLocaleDateString("en-US", {

            month: "long",

            year: "numeric"

        });

}


function initializeStars() {

    const stars = document.querySelectorAll("#starRating button");

    stars.forEach((star) => {

        star.addEventListener("mouseenter", () => {

            highlightStars(Number(star.dataset.rating));

        });

        star.addEventListener("mouseleave", () => {

            highlightStars(selectedRating);

        });

        star.addEventListener("click", () => {

            selectedRating = Number(star.dataset.rating);

            document.getElementById("reviewRating").value = selectedRating;

            highlightStars(selectedRating);

            updateLivePreview();

        });

    });

}

function highlightStars(rating) {

    const stars = document.querySelectorAll("#starRating button");

    stars.forEach((star) => {

        const value = Number(star.dataset.rating);

        if (value <= rating) {

            star.textContent = "★";

            star.classList.add("active");

        } else {

            star.textContent = "☆";

            star.classList.remove("active");

        }

    });

}

function showReviewMessage(message, type = "error") {

    const box = document.getElementById("reviewMessage");

    box.textContent = message;

    box.className = `review-message ${type}`;

    box.style.display = "block";

}

function escapeHtml(value) {

    return String(value || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");

}

/* ==========================================
   SUBMIT
   ========================================== */

async function submitReview(e) {

    e.preventDefault();
    document.getElementById("reviewMessage").style.display = "none";

    const name = document
        .getElementById("reviewName")
        .value
        .trim();

    const review = document
        .getElementById("reviewText")
        .value
        .trim();

    if (!name || !review) {

        showReviewMessage("Please complete all fields.");

        return;

    }

    if (!selectedRating) {

        showReviewMessage("Please select a star rating.");

        return;

    }

    const submitButton = document.querySelector("#reviewForm button[type='submit']");

    submitButton.disabled = true;

    submitButton.textContent = "Submitting...";

    let success = false;

    if (reviewMode === "order") {

        const showOrderItems = document.getElementById("showOrderItems").checked;

        const { data, error } = await supabaseClient

            .functions

            .invoke("submit-review", {
                body: {
                    token: reviewToken,
                    publicName: name,
                    rating: selectedRating,
                    reviewText: review,
                    showOrderItems
                }
            });

        if (error || !data || !data.ok) {

            showReviewMessage(submitErrorMessageFor(data && data.reason));

        } else {

            success = true;

        }

    } else {

        const { error } = await supabaseClient

            .from("reviews")

            .insert({

                name,

                rating: selectedRating,

                review,

                approved: false,

                featured: false

            });

        if (error) {

            console.error(error);

            showReviewMessage(
                "Something went wrong while submitting your review. Please try again."
            );

        } else {

            success = true;

        }

    }

    submitButton.disabled = false;

    submitButton.textContent = "Share Your Review";

    if (success) {

        document.getElementById("reviewForm").style.display = "none";

        document.getElementById("reviewSuccess").style.display = "block";

    }

}

function submitErrorMessageFor(reason) {

    switch (reason) {

        case "expired":
            return "This review link has expired.";

        case "used":
            return "A review has already been submitted for this order.";

        case "rate_limited":
            return "Too many attempts. Please try again in a little while.";

        case "invalid_rating":
            return "Please select a star rating.";

        case "invalid_review":
            return "Please write a short review before submitting.";

        case "invalid_name_email":
            return "Please don't use an email address as your display name.";

        case "invalid_name_url":
            return "Please don't use a web address as your display name.";

        case "invalid_name_phone":
            return "Please don't use a phone number as your display name.";

        case "invalid_name_too_long":
            return "That name is too long — please shorten it.";

        case "invalid":
        default:
            return "This review link isn't valid or has expired. Please reopen it from your email.";

    }

}
