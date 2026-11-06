/* Fellowship applications in the TOJ app: every creator who applies to the
 * Subject Medias creator fellowship on subjectmedias.com/fellowship (the API is
 * routes/sm-fellowship.js). Staff only. Registers screens for app.js's router:
 *
 *   #applications        open applications (#applications/all for every one)
 *   #application/<id>    one application: their work, how to reach them, its
 *                        status, a private note, and once approved the note
 *                        with the payment link for their plan
 *
 * At 16 or 17 the parent or guardian shows with the applicant, and the
 * approval note goes to them first. Links open in a new tab, never in the app.
 */
(function () {
  "use strict";
  var T = function () { return window.TOJ; };
  var h = function (s) { return T().h(s); };

  var STATUS = {
    "new": ["New", "gold"],
    talking: ["Talking", "warn"],
    approved: ["Approved", "ok"],
    joined: ["Joined", "ok"],
    declined: ["Declined", ""],
    withdrawn: ["Withdrew", ""],
  };
  var ORDER = ["new", "talking", "approved", "joined", "declined", "withdrawn"];
  var MSG = {
    not_authenticated: "Please sign in.",
    forbidden: "Fellowship applications are for Kyron and staff.",
    not_set_up: "Fellowship applications aren't set up yet: migration 032 needs to run in Supabase.",
    storage_unavailable: "The database isn't reachable right now.",
    not_approved: "Approve the application first.",
    email_not_configured: "Email isn't set up on the server, so send it from your mail app or copy it.",
    email_failed: "The email didn't go. Send it from your mail app or copy it.",
    open_application_exists: "This address has another open application. Close that one first.",
    note_too_long: "Keep your note under 1,000 characters.",
    too_many: "That's a lot of emails this hour. Try again later.",
    no_recipients: "There's no email on this application.",
    invalid: "Give the note a subject and some text.",
  };
  function say(e) {
    var code = e && e.data && e.data.error;
    return (code && MSG[code]) || (e && e.message) || "Something went wrong.";
  }
  function denied(e) { return e && (e.status === 401 || e.status === 403); }
  function badge(text, kind) { return '<span class="badge' + (kind ? " " + kind : "") + '">' + h(text) + "</span>"; }
  function statusBadge(s) { var x = STATUS[s] || [s, ""]; return badge(x[0], x[1]); }
  // Each part of an address encoded on its own: nothing in it can add a
  // recipient or a body to the draft.
  function addr(e) { return String(e).split("@").map(encodeURIComponent).join("@"); }
  function mailto(to, subject, text) {
    return "mailto:" + to.map(addr).join(",") + "?subject=" + encodeURIComponent(subject || "") + "&body=" + encodeURIComponent(String(text || "").replace(/\r?\n/g, "\r\n"));
  }
  // https only (the server and the database hold the same rule); h() escapes
  // the rest, so a link with a quote in its path still shows.
  function safeLink(u) { return /^https:\/\/\S+$/i.test(String(u || "")) ? String(u) : ""; }
  function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return u; } }
  function errorScreen(back, label, e) {
    return '<div class="screen">' + T().backBtn(back, label) + '<h1 class="title">Fellowship</h1><p class="body err">' + h(denied(e) ? MSG.forbidden : say(e)) + "</p></div>";
  }

  // ── The list ───────────────────────────────────────────────────────────
  async function applications(arg) {
    var t = T(), all = arg === "all";
    t.show("today", '<div class="screen">' + t.backBtn("#today", "Today") + '<h1 class="title">Fellowship</h1><div class="spin"></div></div>');
    var d;
    try { d = await t.api("/api/sm/fellowship" + (all ? "?all=1" : "")); }
    catch (e) {
      if (e.stale) throw e;
      return t.show("today", errorScreen("#today", "Today", e));
    }
    var rows = (d.applications || []).map(function (a) {
      return '<a class="li" href="#application/' + h(a.id) + '"><div class="grow"><div class="name" style="font-size:15px">' + h(a.name) + '</div><div class="sub">' +
        h([a.summary, a.links + (a.links === 1 ? " link" : " links"), t.ago(a.created_at)].join(" · ")) + "</div></div>" + statusBadge(a.status) + t.I.chev + "</a>";
    }).join("");
    t.show("today",
      '<div class="screen">' + t.backBtn("#today", "Today") +
      '<div class="head"><div><h1 class="title">Fellowship</h1><p class="lede">Applications to the creator fellowship, from subjectmedias.com/fellowship.</p></div></div>' +
      '<div class="btn-row" style="margin-bottom:12px"><a class="btn small' + (all ? " soft" : "") + '" href="#applications">Open</a><a class="btn small' + (all ? "" : " soft") + '" href="#applications/all">All</a></div>' +
      (rows ? '<div class="list">' + rows + "</div>" : '<p class="empty">' + (all ? "No applications yet." : "Nothing open. New applications land here and on your phone.") + "</p>") +
      "</div>");
  }

  // ── One application ────────────────────────────────────────────────────
  async function application(id) {
    var t = T();
    t.show(null, '<div class="screen">' + t.backBtn("#applications", "Fellowship") + '<div class="spin"></div></div>');
    var d;
    try { d = await t.api("/api/sm/fellowship/" + encodeURIComponent(id)); }
    catch (e) {
      if (e.stale) throw e;
      return t.show(null, errorScreen("#applications", "Fellowship", e));
    }
    render(d);
  }

  function person(name, email, phone, handle) {
    return '<p class="body" style="font-weight:700;color:var(--ink);margin-bottom:6px">' + h(name) + "</p>" +
      '<div class="btn-row">' +
      (phone ? '<a class="btn small soft" href="tel:' + h(String(phone).replace(/[^0-9+]/g, "")) + '">Call</a>' : "") +
      (email ? '<a class="btn small soft" href="' + h(mailto([email], "Your Subject Medias fellowship application", "")) + '">Email</a>' : "") +
      (handle ? '<a class="btn small soft" href="https://www.instagram.com/' + h(encodeURIComponent(handle)) + '/" target="_blank" rel="noopener noreferrer">Instagram</a>' : "") +
      "</div>" +
      '<p class="sub" style="margin-top:6px;overflow-wrap:anywhere">' + h([email, phone, handle ? "@" + handle : ""].filter(Boolean).join(" · ")) + "</p>";
  }

  function render(d) {
    var t = T(), a = d.application, note = d.note || {};
    var teen = a.age_group === "teen";
    var plan = (d.plans && d.plans[a.plan]) || { name: a.plan };
    var region = a.region && d.regions ? d.regions[a.region] : null;
    var approved = a.status === "approved" || a.status === "joined";

    var facts = [
      ["Seat they want", (d.seats && d.seats[a.seat]) || a.seat],
      ["Plan they lean toward", plan.price ? plan.name + ", " + plan.price : plan.name],
      ["Age", (d.ages && d.ages[a.age_group]) || a.age_group],
      ["Where", [a.city, a.state].filter(Boolean).join(", ") + (region ? " (" + region + ")" : "")],
      ["Gear", a.gear],
    ].filter(function (x) { return x[1]; }).map(function (x) {
      return '<div class="li" style="cursor:default"><div class="grow"><div class="sub">' + h(x[0]) + '</div><div class="name" style="font-size:15px">' + h(x[1]) + "</div></div></div>";
    }).join("");

    var work = (a.links || []).map(safeLink).filter(Boolean).map(function (l) {
      return '<a class="li" href="' + h(l) + '" target="_blank" rel="noopener noreferrer"><div class="grow" style="min-width:0"><div class="name" style="font-size:15px">' + h(hostOf(l)) + '</div><div class="sub" style="overflow-wrap:anywhere">' + h(l) + "</div></div>" + t.I.chev + "</a>";
    }).join("");

    var reach =
      '<section class="card"><h2 class="sec-h">Reach them</h2>' + person(a.name, a.email, a.phone, a.handle) +
      (teen
        ? '<h3 class="sec-h" style="margin-top:8px">Parent or guardian</h3>' + person(a.guardian_name, a.guardian_email, a.guardian_phone) +
          '<p class="sub">16 or 17: talk with their parent or guardian before you approve. They start the plan, sign the agreement with them, and any payouts go to their account. At 16 or 17 a creator shoots or shadows beside a screened adult, and never leads or edits.</p>'
        : "") +
      "</section>";

    var steps = ORDER.map(function (s) {
      return '<button type="button" class="chip" data-status="' + s + '" aria-pressed="' + (a.status === s) + '">' + h(STATUS[s][0]) + "</button>";
    }).join("");

    var noteCard = "";
    if (approved) {
      var linkLine = plan.price
        ? plan.link_set
          ? "The " + plan.name + " payment link is in it, with this application's id and the payer's email filled in."
          : "There's no payment link for " + plan.name + " on the server yet (" + (a.plan === "meetings" ? "FELLOWSHIP_PAY_MEETINGS" : "FELLOWSHIP_PAY_TOOLS") + " on Render), so the note says the link comes next."
        : "They didn't pick a plan, so the note lists both and asks which one they want.";
      noteCard =
        '<section class="card"><h2 class="sec-h">The approval note</h2>' +
        '<p class="sub">To ' + h((note.to || []).join(" and ")) + ". " + h(linkLine) + "</p>" +
        '<label class="field"><span class="label">Subject</span><input class="input" id="fwSubject" maxlength="150" value="' + h(note.subject || "") + '"></label>' +
        '<label class="field"><span class="label">Note</span><textarea class="textarea" id="fwText" rows="16" maxlength="4000" style="min-height:300px">' + h(note.text || "") + "</textarea></label>" +
        '<div class="btn-row">' +
        (d.email_ready ? '<button type="button" class="btn" id="fwSend">Send it</button>' : "") +
        '<a class="btn' + (d.email_ready ? " soft" : "") + '" id="fwMail" href="' + h(mailto(note.to || [], note.subject, note.text)) + '">Open in Mail</a>' +
        '<button type="button" class="btn soft" id="fwCopy">Copy</button>' +
        "</div>" +
        '<p class="sub" id="fwNoteMsg" role="status">' +
        (a.emailed_at ? "Sent from the app " + h(t.ago(a.emailed_at)) + "." : d.email_ready ? "" : "Email isn't set up on the server, so this goes from your own mail app.") +
        "</p></section>";
    }

    t.show(null,
      '<div class="screen">' + t.backBtn("#applications", "Fellowship") +
      '<div class="head"><div><p class="kicker">Fellowship application · ' + h(t.ago(a.created_at)) + '</p><h1 class="title sm">' + h(a.name) + "</h1></div>" + statusBadge(a.status) + "</div>" +
      '<section class="card"><div class="list">' + facts + "</div></section>" +
      '<section class="card"><h2 class="sec-h">Their work</h2>' + (work ? '<div class="list">' + work + "</div>" : '<p class="empty">No links.</p>') +
      (a.about ? '<h3 class="sec-h" style="margin-top:6px">What they wrote</h3><p class="body" style="font-size:14px;white-space:pre-wrap">' + h(a.about) + "</p>" : "") +
      "</section>" +
      reach +
      '<section class="card"><h2 class="sec-h">Status</h2><div class="chips" style="display:flex;flex-wrap:wrap;gap:8px">' + steps + "</div>" +
      '<p class="sub" id="fwMsg" role="status" style="margin-top:8px">' + (a.status_by ? "Last changed by " + h(a.status_by) + "." : "Approve them to draft the note with their payment link.") + "</p></section>" +
      noteCard +
      '<section class="card"><h2 class="sec-h">Your note</h2>' +
      '<textarea class="textarea" id="fwStaff" maxlength="1000" rows="4" placeholder="What you thought of their work, when you talked. Only staff see this.">' + h(a.staff_note || "") + "</textarea>" +
      '<div class="btn-row"><button type="button" class="btn small soft" id="fwSaveStaff">Save your note</button></div></section>' +
      '<section class="card"><h2 class="sec-h">Remove it</h2><p class="sub">Deletes this application and everything in it, for good. For when they, or their parent or guardian, ask.</p>' +
      '<div class="btn-row" id="fwRmAsk"><button type="button" class="btn danger">Remove this application</button></div>' +
      '<div id="fwRmConfirm" hidden><p class="body" style="margin-bottom:10px">Remove ' + h(a.name) + "'s application for good?</p>" +
      '<div class="btn-row"><button type="button" class="btn danger" id="fwRmYes">Yes, remove it</button><button type="button" class="btn soft" id="fwRmNo">Keep it</button></div></div></section>' +
      "</div>");

    var $ = function (id) { return document.getElementById(id); };
    function fail(where, e) { var el = $(where); if (el) el.innerHTML = '<span class="err">' + h(say(e)) + "</span>"; }

    Array.prototype.forEach.call(document.querySelectorAll("[data-status]"), function (btn) {
      btn.addEventListener("click", function () {
        var s = btn.getAttribute("data-status");
        if (s === a.status) return;
        btn.disabled = true;
        T().post("/api/sm/fellowship/" + encodeURIComponent(a.id), { status: s }, "PATCH")
          .then(function (next) { T().toast("Marked " + STATUS[s][0].toLowerCase() + "."); render(next); })
          .catch(function (e) { btn.disabled = false; fail("fwMsg", e); });
      });
    });

    $("fwSaveStaff").addEventListener("click", function () {
      var b = this;
      b.disabled = true;
      T().post("/api/sm/fellowship/" + encodeURIComponent(a.id), { staff_note: $("fwStaff").value }, "PATCH")
        .then(function (next) { T().toast("Note saved."); render(next); })
        .catch(function (e) { b.disabled = false; T().toast(say(e)); });
    });

    if (approved) {
      var subject = $("fwSubject"), text = $("fwText"), mail = $("fwMail");
      var sync = function () { mail.setAttribute("href", mailto(note.to || [], subject.value, text.value)); };
      subject.addEventListener("input", sync);
      text.addEventListener("input", sync);
      $("fwCopy").addEventListener("click", function () {
        var all = "To: " + (note.to || []).join(", ") + "\nSubject: " + subject.value + "\n\n" + text.value;
        try {
          navigator.clipboard.writeText(all).then(function () { T().toast("Copied."); }, function () { text.select(); T().toast("Press and hold the note to copy it."); });
        } catch (e) { text.select(); T().toast("Press and hold the note to copy it."); }
      });
      if ($("fwSend")) {
        $("fwSend").addEventListener("click", function () {
          var b = this;
          b.disabled = true;
          $("fwNoteMsg").textContent = "Sending…";
          T().post("/api/sm/fellowship/" + encodeURIComponent(a.id) + "/note", { subject: subject.value, text: text.value })
            .then(function (r) { a.emailed_at = r.emailed_at; T().toast("Sent to " + (r.to || []).join(" and ") + "."); $("fwNoteMsg").textContent = "Sent from the app just now."; b.disabled = false; })
            .catch(function (e) { b.disabled = false; fail("fwNoteMsg", e); });
        });
      }
    }

    $("fwRmAsk").querySelector("button").addEventListener("click", function () { $("fwRmAsk").hidden = true; $("fwRmConfirm").hidden = false; $("fwRmNo").focus(); });
    $("fwRmNo").addEventListener("click", function () { $("fwRmConfirm").hidden = true; $("fwRmAsk").hidden = false; });
    $("fwRmYes").addEventListener("click", function () {
      var b = this;
      b.disabled = true;
      T().post("/api/sm/fellowship/" + encodeURIComponent(a.id), {}, "DELETE")
        .then(function () { T().toast("Removed."); location.hash = "#applications"; })
        .catch(function (e) { b.disabled = false; T().toast(say(e)); });
    });
  }

  window.TOJScreens = Object.assign(window.TOJScreens || {}, { applications: applications, application: application });
})();
