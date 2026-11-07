/* The Pylon pages in the TOJ app: what comes in from the public Pylon pages
 * (team and player coverage, the Athlete Transcript, the Recruiting
 * Concierge, Newsletter Premium, ambassador applications), and the newsletter
 * list. The API is routes/pylon.js. Owner only. Registers screens for app.js:
 *
 *   #pylon                 open requests (#pylon/all for every one)
 *   #pylon-request/<id>    one request: who to call, checking who they are,
 *                          what they agreed to, payment, status and a team note
 *   #pylon-newsletter      The Off-Season Signal's confirmed list
 *
 * The contact, the athlete and the consent answer show here and nowhere else
 * in the app.
 */
(function () {
  "use strict";
  var T = function () { return window.TOJ; };
  var h = function (s) { return T().h(s); };

  var STATUS = {
    "new": ["New", "gold"],
    contacted: ["Contacted", "warn"],
    confirmed: ["Confirmed", "ok"],
    done: ["Done", "ok"],
    closed: ["Closed", ""],
  };
  var MSG = {
    not_authenticated: "Please sign in.",
    staff_only: "Pylon requests are for Kyron and staff.",
    sign_in_again: "Sign in again to see Pylon requests.",
    already_paid: "That request is already paid.",
    paid_on_stripe: "That payment came through Stripe. Refunds happen in Stripe.",
    extra_payments: "Stripe took a payment on this one too, so it stays paid. Refund the one that shouldn't stand in Stripe.",
    nothing_to_pay: "An application has nothing to pay.",
    bad_verified: "That didn't save. Open it again.",
    check_first: "Check who they are first (above): an athlete's request is Confirmed or Done only after that.",
    checkout_complete: "Stripe shows this checkout as paid, so the request stays: the payment will show here shortly.",
    stripe_unavailable: "Couldn't check its Stripe checkout just now, so it wasn't deleted. Try again in a minute.",
    stripe_not_set_up: "Its Stripe checkout can't be checked: Stripe isn't set up on the server. It can be deleted a day after it came in, once the checkout has run out.",
    bad_amount: "That amount isn't a number of cents.",
    changed_meanwhile: "It changed while you were looking. Open it again.",
    paid_keep: "A paid request stays on file. Refund it in Stripe, then close it.",
    has_messages: "It has coach messages, so it stays. Close it instead.",
    storage_unavailable: "The database isn't reachable right now.",
  };
  function say(e) {
    var code = e && e.data && e.data.error;
    return (code && MSG[code]) || (e && e.message) || "Something went wrong.";
  }
  function badge(text, kind) { return '<span class="badge' + (kind ? " " + kind : "") + '">' + h(text) + "</span>"; }
  function statusBadge(s) { var x = STATUS[s] || [s, ""]; return badge(x[0], x[1]); }
  function money(cents) {
    var n = Number(cents) || 0;
    return "$" + (n % 100 === 0 ? (n / 100).toLocaleString("en-US") : (n / 100).toFixed(2));
  }
  var CADENCE = { once: "", season: " for the season", month: " a month" };
  function price(r) { return r.price_cents === null || r.price_cents === undefined ? "" : money(r.price_cents) + (CADENCE[r.cadence] || ""); }
  function denied(e) { return e && (e.status === 401 || e.status === 403); }
  var ATHLETE = { player_package: 1, transcript: 1, recruiting: 1, ambassador: 1 };
  var SUB_WORDS = { past_due: "a monthly payment didn't go through", unpaid: "monthly payments stopped going through", canceled: "the monthly plan was cancelled", incomplete: "the first monthly payment isn't complete", incomplete_expired: "the first monthly payment never completed", paused: "the monthly plan is paused" };
  function payWords(r) {
    if (r.test && (r.paid_at || r.paid)) return "Stripe test payment of " + money(r.paid_cents) + ". No money moved.";
    if (r.paid_at || r.paid) return "Paid " + money(r.paid_cents) + (r.paid_via === "manual" ? " (marked by hand)" : " on Stripe");
    if (r.kind === "ambassador") return null;
    if (r.checkout_session_id || r.went_to_checkout) return "Went to Stripe checkout. No payment has reached the app yet.";
    return "Not paid yet. Send them a payment link.";
  }

  // ── The list ───────────────────────────────────────────────────────────
  async function pylon(arg) {
    var t = T(), all = arg === "all";
    t.show("today", '<div class="screen">' + t.backBtn("#today", "Today") + '<h1 class="title">Pylon</h1><div class="spin"></div></div>');
    var d;
    try { d = await t.api("/api/pylon/requests" + (all ? "?all=1" : "")); }
    catch (e) {
      if (e.stale) throw e;
      return t.show("today", '<div class="screen">' + t.backBtn("#today", "Today") + '<h1 class="title">Pylon</h1><p class="body err">' + h(denied(e) ? MSG.staff_only : say(e)) + "</p></div>");
    }
    var kinds = d.kinds || {};
    var rows = (d.requests || []).map(function (r) {
      var paid = r.paid ? (r.test ? "Test payment" : "Paid " + money(r.paid_cents)) : r.kind === "ambassador" ? null : r.went_to_checkout ? "Went to checkout" : "Not paid";
      var flag = r.extra_payments ? "Paid twice: check it" : r.subscription_status && r.subscription_status !== "active" ? "Plan: " + (SUB_WORDS[r.subscription_status] || r.subscription_status) : null;
      var check = ATHLETE[r.kind] && !r.verified ? "Not checked yet" : null;
      return '<a class="li" href="#pylon-request/' + h(r.id) + '"><div class="grow"><div class="name" style="font-size:15px">' + h(r.summary) + '</div><div class="sub">' +
        h([kinds[r.kind] || r.kind, r.contact_name, check, paid, flag, t.ago(r.created_at)].filter(Boolean).join(" · ")) +
        "</div></div>" + statusBadge(r.status) + t.I.chev + "</a>";
    }).join("");
    t.show("today",
      '<div class="screen">' + t.backBtn("#today", "Today") +
      '<div class="head"><div><h1 class="title">Pylon</h1><p class="lede">From the Pylon pages: coverage, transcripts, the Concierge, Premium and ambassador applications.</p></div></div>' +
      '<div class="btn-row" style="margin-bottom:12px"><a class="btn small' + (all ? " soft" : "") + '" href="#pylon">Open</a><a class="btn small' + (all ? "" : " soft") + '" href="#pylon/all">All</a><a class="btn small soft" href="#pylon-newsletter">Newsletter list</a></div>' +
      (rows ? '<div class="list">' + rows + "</div>" : '<p class="empty">' + (all ? "Nothing yet." : "Nothing open. New requests land here and on your phone.") + "</p>") +
      "</div>");
  }

  // ── One request ────────────────────────────────────────────────────────
  async function pylonRequest(id) {
    var t = T();
    t.show(null, '<div class="screen">' + t.backBtn("#pylon", "Pylon") + '<div class="spin"></div></div>');
    var d;
    try { d = await t.api("/api/pylon/requests/" + encodeURIComponent(id)); }
    catch (e) {
      if (e.stale) throw e;
      return t.show(null, '<div class="screen">' + t.backBtn("#pylon", "Pylon") + '<p class="body err">' + h(denied(e) ? MSG.staff_only : say(e)) + "</p></div>");
    }
    var r = d.request, x = r.details || {};
    var handles = [x.ig_handle ? "Instagram @" + x.ig_handle : null, x.tiktok_handle ? "TikTok @" + x.tiktok_handle : null].filter(Boolean).join(", ");
    var facts = [
      ["What", r.package_name],
      ["Price", price(r)],
      ["Athlete", r.athlete_name],
      ["Position", x.position],
      ["Class of", x.class_year],
      ["Position and class", x.position_class],
      ["Team", x.team_name],
      ["Region", x.region ? (d.regions || {})[x.region] || x.region : null],
      ["Event", x.event],
      ["Target level", x.target_level ? (d.levels || {})[x.target_level] || x.target_level : null],
      ["Athlete's own email", x.athlete_email],
      ["Handles", handles],
      ["Followers", x.follower_count !== undefined ? Number(x.follower_count).toLocaleString("en-US") : null],
      ["Creator code", r.referral_code ? r.referral_code + " (Stripe applies it if it's an active code)" : null],
      ["Payment", payWords(r)],
      ["Monthly plan", r.subscription_status ? (r.subscription_status === "active" ? "Active on Stripe" : "On Stripe, " + (SUB_WORDS[r.subscription_status] || r.subscription_status) + (r.subscription_ended_at ? " (" + t.ago(r.subscription_ended_at) + ")" : "")) : null],
      ["Their note", r.contact_emailed_at ? "Emailed " + t.ago(r.contact_emailed_at) : null],
    ].filter(function (f) { return f[1]; }).map(function (f) {
      return '<div class="li" style="cursor:default"><div class="grow"><div class="sub">' + h(f[0]) + '</div><div class="name" style="font-size:15px">' + h(f[1]) + "</div></div></div>";
    }).join("");

    var consent = r.consent_text
      ? '<section class="card"><h2 class="sec-h">What they agreed to</h2><p class="body" style="font-size:14px">' + h(((d.who || {})[r.consent] ? "The form says it was filled in by " + d.who[r.consent] + "." : "") + (r.contact_verified_at ? "" : " Not checked yet.")) + '</p><p class="body" style="font-size:14px;color:var(--ink)">' + h(r.consent_text) + "</p></section>"
      : r.kind === "team_package" ? '<section class="card"><h2 class="sec-h">Consent</h2><p class="body" style="font-size:14px">A coach booked for the team. Each athlete\'s footage is cleared through their own parent or guardian at the event.</p></section>' : "";

    // Each part of the address encoded on its own: nothing in it can add a
    // recipient or a body to the draft.
    var mailto = "mailto:" + String(r.contact_email).split("@").map(encodeURIComponent).join("@") + "?subject=" + encodeURIComponent("Your Pylon request: " + r.package_name);
    var roles = { coach: "Head coach", parent: "Parent", guardian: "Legal guardian", athlete: "The athlete (18+)", subscriber: "Subscriber" };
    var contact =
      '<section class="card"><h2 class="sec-h">Get back to them</h2>' +
      '<p class="body" style="font-weight:700;color:var(--ink);margin-bottom:6px">' + h(r.contact_name) + ' <span class="sub" style="font-weight:500">' + h(roles[r.contact_role] || "") + "</span></p>" +
      '<div class="btn-row">' +
      (r.contact_phone ? '<a class="btn" href="tel:' + h(r.contact_phone.replace(/[^0-9+]/g, "")) + '">Call ' + h(r.contact_phone) + "</a>" : "") +
      '<a class="btn soft" href="' + h(mailto) + '">Email</a>' +
      "</div>" +
      '<p class="sub" style="margin-top:8px">' + h(r.contact_email) + "</p>" +
      (r.notes ? '<p class="body" style="font-size:14px;white-space:pre-wrap;margin-top:10px">' + h(r.notes) + "</p>" : "") +
      "</section>";

    // Anyone can fill in a form: before anything is done for an athlete,
    // staff check who they're dealing with, and the request says who did.
    var whoToCheck = ATHLETE[r.kind]
      ? "the athlete's parent or legal guardian (or the athlete, 18 or older)" + (r.athlete_name ? ", for " + r.athlete_name : "")
      : r.contact_role === "coach" ? "the team's coach" : "the person who sent it";
    var checkCard =
      '<section class="card"><h2 class="sec-h">Check who they are</h2>' +
      (r.contact_verified_at
        ? '<p class="body" style="font-size:14px">Checked by ' + h(r.contact_verified_by || "staff") + " " + h(t.ago(r.contact_verified_at)) + ".</p>" +
          '<div class="btn-row"><button type="button" class="btn small soft" id="plUnverify">Undo the check</button></div>'
        : '<p class="body" style="font-size:14px">' + h("Not checked yet. " + (ATHLETE[r.kind] ? "Before filming, delivering anything, setting up a profile or asking about coach messages: " : "") + "call or meet them, and check you're dealing with " + whoToCheck + " and that " + r.contact_email + " is theirs.") + "</p>" +
          '<div class="btn-row"><button type="button" class="btn small" id="plVerify">I checked: it\'s them</button></div>') +
      "</section>";

    var extras = (r.extra_payments || []).map(function (p) {
      return "Another " + money(p.amount_cents) + " came in through Stripe" + (p.mode === "test" ? " (test mode)" : "") + ", " + t.ago(p.at) + ". Check it, and refund one in Stripe if it's paid twice.";
    });
    var payCard = r.kind === "ambassador" ? "" :
      '<section class="card"><h2 class="sec-h">Payment</h2><p class="body" style="font-size:14px">' + h(payWords(r)) + "</p>" +
      extras.map(function (e) { return '<p class="body err" style="font-size:14px">' + h(e) + "</p>"; }).join("") +
      (!r.paid_at ? '<div class="btn-row"><button type="button" class="btn small soft" id="plPaid">Paid another way (' + h(money(r.price_cents)) + ")</button></div>" :
        r.paid_via === "manual" ? '<div class="btn-row"><button type="button" class="btn small soft" id="plUnpaid">Undo: not paid</button></div>' : "") +
      "</section>";

    var steps = ["new", "contacted", "confirmed", "done", "closed"].map(function (s) {
      return '<button type="button" class="chip" data-status="' + s + '" aria-pressed="' + (r.status === s) + '">' + h(STATUS[s][0]) + "</button>";
    }).join("");

    t.show(null,
      '<div class="screen">' + t.backBtn("#pylon", "Pylon") +
      '<div class="head"><div><p class="kicker">' + h(((d.kinds || {})[r.kind] || r.kind) + " · " + t.ago(r.created_at)) + '</p><h1 class="title sm">' + h(r.summary) + "</h1></div>" + statusBadge(r.status) + "</div>" +
      '<section class="card"><div class="list">' + facts + "</div></section>" +
      contact + checkCard + consent + payCard +
      '<section class="card"><h2 class="sec-h">Status</h2><div class="chips" style="display:flex;flex-wrap:wrap;gap:8px">' + steps + "</div>" +
      '<label class="sub" for="plNote" style="display:block;margin-top:14px">Team note</label>' +
      '<textarea id="plNote" maxlength="2000" rows="3" style="width:100%;margin-top:6px">' + h(r.team_note || "") + "</textarea>" +
      '<div class="btn-row" style="margin-top:8px"><button type="button" class="btn small" id="plSaveNote">Save the note</button></div>' +
      '<p class="sub" id="plMsg" role="status" style="margin-top:8px">' + (r.status_by ? "Last changed by " + h(r.status_by) + "." : "") + "</p></section>" +
      (!r.paid_at && !(r.extra_payments || []).length ? '<section class="card"><h2 class="sec-h">Delete</h2><p class="sub">For a request someone says they didn\'t send. A paid request stays on file.</p><div class="btn-row" style="margin-top:8px"><button type="button" class="btn small soft" id="plDelete">Delete this request</button></div></section>' : "") +
      "</div>");

    function save(body, done) {
      T().post("/api/pylon/requests/" + encodeURIComponent(r.id), body, "PATCH")
        .then(function () { T().toast(done); pylonRequest(r.id); })
        .catch(function (e) { document.getElementById("plMsg").innerHTML = '<span class="err">' + h(say(e)) + "</span>"; });
    }
    Array.prototype.forEach.call(document.querySelectorAll("[data-status]"), function (btn) {
      btn.addEventListener("click", function () {
        var s = btn.getAttribute("data-status");
        if (s !== r.status) save({ status: s }, "Marked " + STATUS[s][0].toLowerCase() + ".");
      });
    });
    document.getElementById("plSaveNote").addEventListener("click", function () {
      save({ team_note: document.getElementById("plNote").value }, "Note saved.");
    });
    var verifyBtn = document.getElementById("plVerify");
    if (verifyBtn) verifyBtn.addEventListener("click", function () { verifyBtn.disabled = true; save({ verified: true }, "Checked."); });
    var unverifyBtn = document.getElementById("plUnverify");
    if (unverifyBtn) unverifyBtn.addEventListener("click", function () { unverifyBtn.disabled = true; save({ verified: false }, "Check taken back."); });
    var paidBtn = document.getElementById("plPaid");
    if (paidBtn) paidBtn.addEventListener("click", function () { paidBtn.disabled = true; save({ paid: true }, "Marked paid."); });
    var unpaidBtn = document.getElementById("plUnpaid");
    if (unpaidBtn) unpaidBtn.addEventListener("click", function () { unpaidBtn.disabled = true; save({ paid: false }, "Marked not paid."); });
    // Two taps: the first asks, the second deletes.
    var delBtn = document.getElementById("plDelete");
    if (delBtn) delBtn.addEventListener("click", function () {
      if (!delBtn.getAttribute("data-sure")) { delBtn.setAttribute("data-sure", "1"); delBtn.textContent = "Tap again to delete it for good"; return; }
      delBtn.disabled = true;
      T().post("/api/pylon/requests/" + encodeURIComponent(r.id), {}, "DELETE")
        .then(function () { T().toast("Deleted."); location.hash = "#pylon"; })
        .catch(function (e) { delBtn.disabled = false; document.getElementById("plMsg").innerHTML = '<span class="err">' + h(say(e)) + "</span>"; });
    });
  }

  // ── The newsletter list ────────────────────────────────────────────────
  async function pylonNewsletter() {
    var t = T();
    t.show(null, '<div class="screen">' + t.backBtn("#pylon", "Pylon") + '<h1 class="title">Newsletter</h1><div class="spin"></div></div>');
    var d;
    try { d = await t.api("/api/pylon/newsletter"); }
    catch (e) {
      if (e.stale) throw e;
      return t.show(null, '<div class="screen">' + t.backBtn("#pylon", "Pylon") + '<h1 class="title">Newsletter</h1><p class="body err">' + h(denied(e) ? MSG.staff_only : say(e)) + "</p></div>");
    }
    var c = d.counts || {};
    var list = d.confirmed || [];
    var rows = list.map(function (s) {
      return '<div class="li" style="cursor:default"><div class="grow"><div class="name" style="font-size:15px">' + h(s.email) + '</div><div class="sub">Confirmed ' + h(t.ago(s.confirmed_at)) + "</div></div></div>";
    }).join("");
    t.show(null,
      '<div class="screen">' + t.backBtn("#pylon", "Pylon") +
      '<div class="head"><div><h1 class="title">The Off-Season Signal</h1><p class="lede">' + h((c.confirmed || 0) + " confirmed · " + (c.pending || 0) + " waiting to confirm · " + (c.unsubscribed || 0) + " unsubscribed") + "</p></div></div>" +
      '<p class="sub" style="margin-bottom:12px">Only confirmed addresses are on the list: each one opened the link we emailed. Premium subscribers are requests in Pylon.</p>' +
      (list.length ? '<div class="btn-row" style="margin-bottom:12px"><button type="button" class="btn small" id="plCopy">Copy the list with unsubscribe links</button></div><div class="list">' + rows + "</div>" : '<p class="empty">No confirmed subscribers yet.</p>') +
      '<p class="sub" id="plCopyMsg" role="status" style="margin-top:8px"></p></div>');
    var copy = document.getElementById("plCopy");
    if (copy) copy.addEventListener("click", function () {
      // A CSV the sending tool can take: each issue has to carry the
      // address's own unsubscribe link.
      var text = "email,unsubscribe_url\n" + list.map(function (s) { return s.email + "," + s.unsubscribe_url; }).join("\n");
      var msg = document.getElementById("plCopyMsg");
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
        .then(function () { msg.textContent = "Copied " + list.length + " addresses, each with its unsubscribe link (CSV)."; })
        .catch(function () { msg.textContent = "Couldn't copy here. Select the list and copy it."; });
    });
  }

  window.TOJScreens = Object.assign(window.TOJScreens || {}, { pylon: pylon, "pylon-request": pylonRequest, "pylon-newsletter": pylonNewsletter });
})();
