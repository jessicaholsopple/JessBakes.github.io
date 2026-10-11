/* ==========================================
   CONTACT FORM (contact.html)
   ==========================================

   Public submissions always go through the contact-submit Edge
   Function -- never a direct table insert -- so honeypot, rate-
   limiting, and validation are enforced server-side no matter what
   the browser sends (contact_messages has no anon grant at all; see
   supabase/migrations/20260831093000_contact_messages_schema.sql).
   Entirely separate from the order/email system: this never touches
   orders, order_items, or email_outbox, and never creates a
   subscriber or sends an automated email reply.
   ========================================== */

const contactForm = document.getElementById("contactForm");

if (contactForm) {
    contactForm.addEventListener("submit", submitContactForm);
}

function showContactMessage(text, kind) {
    const box = document.getElementById("contactMessage");
    if (!box) return;
    box.textContent = text;
    box.className = `contact-form-message ${kind}`;
    box.style.display = "block";
}

async function submitContactForm(e) {
    e.preventDefault();

    const submitButton = contactForm.querySelector("button[type='submit']");

    // Duplicate-submission guard: the button is disabled for the
    // entire round trip, so a second click (or a second Enter-key
    // submit) while the first request is still in flight does
    // nothing.
    if (submitButton.disabled) return;

    const name = document.getElementById("contactName").value.trim();
    const email = document.getElementById("contactEmail").value.trim();
    const orderReference = document.getElementById("contactOrderReference").value.trim();
    const message = document.getElementById("contactMessageText").value.trim();
    const honeypot = document.getElementById("contactWebsite")?.value || "";

    document.getElementById("contactMessage").style.display = "none";

    if (!name || !email || !message) {
        showContactMessage("Please fill in your name, email, and message.", "error");
        return;
    }

    submitButton.disabled = true;
    submitButton.textContent = "Sending...";

    try {
        const { data, error } = await supabaseClient.functions.invoke("contact-submit", {
            body: {
                name,
                email,
                orderReference,
                message,
                honeypot
            }
        });

        if (error) {
            showContactMessage("Something went wrong. Please try again in a moment.", "error");
            return;
        }

        if (!data?.ok) {
            const reasonMessages = {
                invalid_email: "Please enter a valid email address.",
                name_required: "Please enter your name.",
                message_required: "Please enter a message.",
                rate_limited: "Please wait a few minutes before sending another message."
            };

            showContactMessage(
                reasonMessages[data?.reason] || "Something went wrong. Please try again in a moment.",
                "error"
            );
            return;
        }

        showContactMessage(
            "Thanks! Your message has been sent -- I'll get back to you by email.",
            "success"
        );
        contactForm.reset();

    } catch (err) {
        console.error(err);
        showContactMessage("Something went wrong. Please try again in a moment.", "error");
    } finally {
        submitButton.disabled = false;
        submitButton.textContent = "Send Message";
    }
}
