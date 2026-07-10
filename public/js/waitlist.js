// TOJ SaaS waitlist — client script.
// Attaches to every <form class="waitlist-form" data-vertical="...">, POSTs
// to /api/waitlist (same-origin), and swaps the field row for the success
// message on ack. Every submission is stored in TOJ's database.
//
// The endpoint is RELATIVE. In production, Vercel rewrites /api/* to the
// Render backend (see vercel.json), so the browser makes a same-origin
// request to tojcampaign.com/api/waitlist — no CORS, session cookies work.
// In local dev, the Express server serves both the page and the API on the
// same origin. One relative path works everywhere.
(function () {
  var ENDPOINT = "/api/waitlist";

  document
    .querySelectorAll('form.waitlist-form[data-vertical]')
    .forEach(function (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var vertical = form.getAttribute("data-vertical") || "unknown";
        var input = form.querySelector('input[type="email"]');
        var row = form.querySelector(".field-row");
        var ok = form.querySelector(".ok");
        var err = form.querySelector(".err");
        var btn = form.querySelector("button[type=submit]");
        var email = (input && input.value ? input.value : "").trim();

        if (!email) return;
        if (err) err.textContent = "";
        if (btn) {
          btn.disabled = true;
          btn.style.opacity = "0.7";
        }

        fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: email,
            vertical: vertical,
            source: window.location.pathname + window.location.search,
          }),
        })
          .then(function (r) {
            return r.json().catch(function () {
              return { ok: false };
            });
          })
          .then(function (body) {
            if (body && body.ok) {
              if (row) row.style.display = "none";
              if (ok) ok.classList.add("show");
            } else {
              if (err)
                err.textContent =
                  body && body.error === "invalid_email"
                    ? "Please enter a valid email."
                    : "Sorry — could not save. Try again in a moment.";
              if (btn) {
                btn.disabled = false;
                btn.style.opacity = "";
              }
            }
          })
          .catch(function () {
            if (err)
              err.textContent =
                "Network trouble — try again, or email hello@tojcampaign.com.";
            if (btn) {
              btn.disabled = false;
              btn.style.opacity = "";
            }
          });
      });
    });
})();
