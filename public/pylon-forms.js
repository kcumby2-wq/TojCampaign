/* The Pylon pages' forms. The API is routes/pylon.js, and what each form must
 * carry is utils/pylon.js (normalize). The consent sentences here are the same
 * ones it keeps on the request (tests/pylon.test.js checks they match).
 *
 * A page has one or more <form class="pf" data-kind="…">: inline, or inside
 * #modal with .book[data-package] buttons that open it. Each form has a
 * .pf-msg (role=status), a .pf-primary submit and a .pf-done panel after it.
 *
 * Query parameters: ?paid=1 and ?cancelled=1 (back from Stripe); ?event= or
 * ?event_id= (fills in the event); ?ref= (a creator code); ?package= or ?sku=
 * (opens that package); ?confirm= and ?unsubscribe= (the newsletter's links).
 */
(function (root) {
  "use strict";

  // ── The consent words ──────────────────────────────────────────────────
  var I_AM = { parent: "I'm the athlete's parent.", guardian: "I'm the athlete's legal guardian.", adult: "I'm the athlete and I'm 18 or older." };
  function agree(kind, who, publicOk) {
    var them = who === "adult" ? "me" : "them";
    if (kind === "player_package")
      return "I agree to Pylon filming and photographing " + them + " at this event for this package." +
        (publicOk ? " Pylon may also post the coverage on Pylon's own channels." : " Pylon won't post the coverage on its own channels.");
    if (kind === "transcript") return "I agree to Pylon setting up a season-long recruiting profile for " + them + ", which " + (who === "adult" ? "I" : "we") + " can share with coaches.";
    if (kind === "recruiting") return "I agree to the Recruiting Concierge contacting college coaches about " + them + ". Nothing goes to a coach until I approve the exact message.";
    if (kind === "ambassador") return "I agree to this application" + (who === "adult" ? "" : " for them") + ". Nothing starts until I review and sign an agreement.";
    return null;
  }
  function consentWords(kind, who, publicOk) {
    if (!Object.prototype.hasOwnProperty.call(I_AM, who)) return null;
    var a = agree(kind, who, !!publicOk);
    return a ? I_AM[who] + " " + a : null;
  }
  root.PylonForms = { consentWords: consentWords };
  if (typeof document === "undefined" || !document.querySelector) return;

  var HELP = "hello@pylonfootball.com";
  var params = new URLSearchParams(location.search);
  var each = function (list, fn) { Array.prototype.forEach.call(list, fn); };
  function show(el, on) { if (el) el.hidden = !on; }
  function say(msg, text, err) {
    if (!msg) return;
    msg.textContent = text || "";
    msg.className = "pf-msg" + (err ? " pf-err" : "");
  }

  // ── Back from Stripe ───────────────────────────────────────────────────
  function banner(text, calm) {
    var b = document.createElement("div");
    b.className = "pf-banner" + (calm ? " pf-calm" : "");
    b.setAttribute("role", "status");
    b.textContent = text;
    document.body.insertBefore(b, document.body.firstChild);
  }
  if (params.get("paid") === "1") banner("Thanks. Stripe sends your receipt, and we'll email you within 24 hours to confirm the details.");
  else if (params.get("cancelled") === "1") banner("Checkout was cancelled and nothing was charged. Your request is saved, and we'll email you a secure payment link.", true);

  // A creator code from the link (player packages): shown, and sent with the
  // request. Stripe decides whether it takes anything off.
  var refCode = String(params.get("ref") || "").trim().toUpperCase();
  if (/^[A-Z0-9_-]{2,30}$/.test(refCode)) {
    each(document.querySelectorAll("[data-ref-code]"), function (el) { el.textContent = refCode; });
    each(document.querySelectorAll("[data-ref-show]"), function (el) { show(el, true); });
  } else refCode = "";

  // Whether payment happens on the next screen (Pylon's Stripe is set up):
  // it only changes what the buttons say.
  var checkoutOpen = false;
  function labelButtons() {
    each(document.querySelectorAll("form.pf[data-kind] .pf-primary[data-pay]"), function (b) {
      b.textContent = checkoutOpen ? b.getAttribute("data-pay") || "Continue to payment" : b.getAttribute("data-wait") || "Send request";
    });
  }
  labelButtons();
  fetch("/api/pylon/checkout").then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
    checkoutOpen = !!(d && d.open);
    labelButtons();
  }).catch(function () {});

  // ── Errors ─────────────────────────────────────────────────────────────
  var FIELD_FOR = { contact_email_same: "contact_email" };
  var WORDS = {
    who: "Tell us who's filling this in.",
    consent_confirm: "Tick the box to agree, or this can't be sent.",
    contact_email_same: "The parent or guardian's email has to be their own, not the athlete's.",
    package: "Pick a package first.",
    kind: "Pick a package first.",
  };
  function clearErrors(form) {
    each(form.querySelectorAll('[aria-invalid="true"]'), function (el) { el.removeAttribute("aria-invalid"); });
    each(form.querySelectorAll(".pf-bad"), function (el) { el.classList.remove("pf-bad"); });
  }
  function bad(form, msg, fields) {
    var first = null, lines = [];
    fields.forEach(function (f) {
      var el = form.querySelector('[name="' + (FIELD_FOR[f] || f) + '"]');
      if (el) {
        el.setAttribute("aria-invalid", "true");
        if (el.type === "checkbox" && el.closest(".pf-check")) el.closest(".pf-check").classList.add("pf-bad");
        if (!first) first = el;
      }
      if (WORDS[f] && lines.indexOf(WORDS[f]) < 0) lines.push(WORDS[f]);
    });
    say(msg, lines.length ? lines.join(" ") : "Check the highlighted fields.", true);
    if (first && first.focus) first.focus();
  }

  // ── A form ─────────────────────────────────────────────────────────────
  function wire(form) {
    var kind = form.getAttribute("data-kind") || "";
    var msg = form.querySelector(".pf-msg");
    var submit = form.querySelector(".pf-primary");
    var whoSel = form.querySelector('[name="who"]');
    var consentBox = form.querySelector('[name="consent_confirm"]');
    var consentText = form.querySelector("[data-consent-words]");
    var publicBox = form.querySelector('[name="public_ok"]');
    var panel = form.nextElementSibling && form.nextElementSibling.classList.contains("pf-done") ? form.nextElementSibling : null;

    var ev = params.get("event") || params.get("event_id");
    var evInput = form.querySelector('[name="event"]');
    if (ev && evInput && !evInput.value) evInput.value = ev.slice(0, 120);
    var refInput = form.querySelector('[name="referral_code"]');
    if (refCode && refInput) refInput.value = refCode;

    function whoChanged() {
      if (!whoSel) return;
      var who = whoSel.value;
      var minor = who === "minor";
      show(form.querySelector("[data-minor-stop]"), minor);
      // A parent's or guardian's own fields: not there for an athlete of 18+.
      each(form.querySelectorAll("[data-family]"), function (row) {
        var on = who !== "adult" && !minor;
        show(row, on);
        each(row.querySelectorAll("[data-req]"), function (el) { el.required = on; });
      });
      if (consentText) consentText.textContent = consentWords(kind, who, publicBox && publicBox.checked) || "Choose who's filling this in to see what you're agreeing to.";
      if (consentBox) {
        consentBox.disabled = !Object.prototype.hasOwnProperty.call(I_AM, who);
        if (consentBox.disabled) consentBox.checked = false;
      }
      if (submit) submit.disabled = minor;
    }
    if (whoSel) whoSel.addEventListener("change", whoChanged);
    if (publicBox) publicBox.addEventListener("change", whoChanged);
    whoChanged();

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      clearErrors(form);
      var body = {};
      each(form.querySelectorAll("input[name],select[name],textarea[name]"), function (el) {
        if (el.type === "checkbox") body[el.name] = el.checked;
        else if (!el.closest("[hidden]")) body[el.name] = el.value;
      });
      var endpoint = form.getAttribute("data-endpoint") || "/api/pylon/requests";
      if (kind) body.kind = kind;
      if (!body["package"] && form.getAttribute("data-package")) body["package"] = form.getAttribute("data-package");
      if (submit) submit.disabled = true;
      say(msg, "Sending…");
      fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        .then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (d) { return { status: r.status, d: d || {} }; });
        })
        .then(function (x) {
          if (x.status === 200 && x.d.ok) return done(x.d, body);
          if (submit) submit.disabled = false;
          if (x.status === 400 && Array.isArray(x.d.fields) && x.d.fields.length) return bad(form, msg, x.d.fields);
          if (x.status === 429) return say(msg, "Too many tries from here. Wait a few minutes and try again.", true);
          say(msg, "We couldn't send this just now. Try again in a minute, or email " + HELP + ".", true);
        })
        .catch(function () {
          if (submit) submit.disabled = false;
          say(msg, "We couldn't reach the server. Check your connection and try again, or email " + HELP + ".", true);
        });
    });

    function done(d, body) {
      if (d.checkout_url && /^https:\/\/checkout\.stripe\.com\//.test(d.checkout_url)) {
        say(msg, "Taking you to Stripe's secure checkout…");
        location.assign(d.checkout_url);
        return;
      }
      var to = body.contact_email || body.email || "";
      var title = "Request sent", lines;
      if (form.getAttribute("data-endpoint")) {
        title = "Check your email";
        lines = ["We sent a link to " + to + " to confirm your subscription. Open it and tap Confirm.", "Not there in a few minutes? Look in spam. The link works for 7 days."];
      } else if (kind === "ambassador") {
        title = "Application sent";
        lines = ["We'll reply to " + to + " within 7 days.", "Nothing starts until " + (body.who === "adult" ? "you sign" : "the parent or guardian reviews and signs") + " an agreement."];
      } else {
        lines = ["We'll email " + to + " within 24 hours to confirm the details and send a secure payment link.", "Nothing is charged until you pay it."];
      }
      if (panel) {
        panel.innerHTML = "";
        var h = document.createElement("h4");
        h.textContent = title;
        panel.appendChild(h);
        lines.forEach(function (t) { var p = document.createElement("p"); p.textContent = t; panel.appendChild(p); });
        var close = form.querySelector("[data-close]");
        if (close) {
          var again = document.createElement("div");
          again.className = "pf-actions";
          again.innerHTML = '<button type="button" class="pf-primary" data-close>Done</button>';
          panel.appendChild(again);
          again.querySelector("[data-close]").addEventListener("click", closeModal);
        }
        form.hidden = true;
        panel.hidden = false;
        var intro = document.getElementById("modal-sub");
        if (intro && form.closest("#modal")) intro.hidden = true;
        panel.setAttribute("tabindex", "-1");
        panel.focus();
      } else say(msg, title + ". " + lines.join(" "));
    }
    form._pfReset = function () {
      form.hidden = false;
      if (panel) panel.hidden = true;
      clearErrors(form);
      say(msg, "");
      if (submit) submit.disabled = whoSel ? whoSel.value === "minor" : false;
    };
  }
  each(document.querySelectorAll("form.pf"), wire);

  // ── The package modal ──────────────────────────────────────────────────
  var modal = document.getElementById("modal");
  var lastBtn = null;
  function closeModal() {
    if (!modal) return;
    modal.classList.remove("show");
    if (lastBtn && lastBtn.focus) lastBtn.focus();
  }
  if (modal) {
    var mform = modal.querySelector("form.pf");
    var title = modal.querySelector("#modal-title");
    var sub = modal.querySelector("#modal-sub");
    each(document.querySelectorAll(".book[data-package]"), function (btn) {
      btn.addEventListener("click", function () {
        lastBtn = btn;
        if (mform) {
          mform.setAttribute("data-package", btn.getAttribute("data-package"));
          var pk = mform.querySelector('[name="package"]');
          if (pk) pk.value = btn.getAttribute("data-package");
          if (mform._pfReset) mform._pfReset();
        }
        if (title) title.textContent = btn.getAttribute("data-name") || title.textContent;
        if (sub) sub.hidden = false;
        var inner = document.getElementById("modal-inner");
        if (inner) inner.classList.toggle("hbcu-mode", btn.classList.contains("hbcu-book"));
        modal.classList.add("show");
        var first = mform && mform.querySelector("select:not([disabled]),input:not([type=hidden]):not([disabled])");
        if (first) first.focus();
      });
    });
    each(modal.querySelectorAll("[data-close]"), function (b) { b.addEventListener("click", closeModal); });
    modal.addEventListener("click", function (e) { if (e.target === modal) closeModal(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && modal.classList.contains("show")) closeModal(); });
    var pre = params.get("package") || params.get("sku") || params.get("tier");
    if (pre && /^[a-z0-9_]{1,40}$/.test(pre)) {
      var b = document.querySelector('.book[data-package="' + pre + '"]');
      if (b) b.click();
    }
  }

  // ── The newsletter's links ─────────────────────────────────────────────
  var tokenPanel = document.getElementById("pf-token");
  var confirmTok = params.get("confirm"), unsubTok = params.get("unsubscribe");
  if (tokenPanel && (confirmTok || unsubTok)) {
    var confirming = !!confirmTok;
    var token = String(confirmTok || unsubTok);
    // The link's token leaves the address bar (and anything copied from it).
    try { history.replaceState(null, "", location.pathname); } catch (e) {}
    var tp = tokenPanel.querySelector("p"), tb = tokenPanel.querySelector("button"), tm = tokenPanel.querySelector(".pf-msg");
    tokenPanel.querySelector("h2").textContent = confirming ? "Confirm your subscription" : "Unsubscribe";
    tp.textContent = confirming ? "Tap Confirm to get The Off-Season Signal at the address this link came to." : "Tap Unsubscribe and this address gets no more issues.";
    tb.textContent = confirming ? "Confirm" : "Unsubscribe";
    show(tokenPanel, true);
    tb.addEventListener("click", function () {
      tb.disabled = true;
      say(tm, "One moment…");
      fetch(confirming ? "/api/pylon/newsletter/confirm" : "/api/pylon/newsletter/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: token }) })
        .then(function (r) { return r.status; })
        .then(function (status) {
          if (status === 200) {
            show(tb, false);
            return say(tm, confirming ? "You're in. The next issue comes to your inbox." : "Done. That address is off the list.");
          }
          tb.disabled = false;
          if (status === 404 || status === 400) return say(tm, confirming ? "This link has expired or was already used. Subscribe again below for a new one." : "This link doesn't work. Email " + HELP + " and we'll take you off the list.", true);
          say(tm, "We couldn't do that just now. Try again in a minute.", true);
        })
        .catch(function () { tb.disabled = false; say(tm, "We couldn't reach the server. Try again in a minute.", true); });
    });
  }
})(typeof window !== "undefined" ? window : this);
