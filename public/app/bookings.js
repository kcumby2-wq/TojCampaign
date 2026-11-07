/* Subject Medias bookings in the TOJ app: every game, team or event booked on
 * subjectmedias.com (the API is routes/sm-bookings.js). Staff only. Registers
 * screens for app.js's router:
 *
 *   #bookings          open bookings (#bookings/all for every one), under
 *                      the site's last 7 and 30 days (routes/sm-site.js)
 *   #booking/<id>      one booking: who to call, the creators in that region,
 *                      and its status, from new to delivered
 *
 * The booker's contact shows here and nowhere else in the app. Athletes are
 * a team and jersey number, never a name.
 */
(function () {
  "use strict";
  var T = function () { return window.TOJ; };
  var h = function (s) { return T().h(s); };

  var STATUS = {
    "new": ["New", "gold"],
    contacted: ["Contacted", "warn"],
    offered: ["Offered to a creator", "warn"],
    staffed: ["Staffed", "ok"],
    delivered: ["Delivered", "ok"],
    cancelled: ["Cancelled", ""],
  };
  var MSG = {
    not_authenticated: "Please sign in.",
    forbidden: "Bookings are for Kyron and staff.",
    creator_required: "Pick the creator who's on it first.",
    creator_not_active: "That creator isn't active.",
    creator_not_cleared: "Only an adult with current screening can take a booking.",
    booking_closed: "This booking is closed. Move it back to an open status first.",
    storage_unavailable: "The database isn't reachable right now.",
  };
  function say(e) {
    var code = e && e.data && e.data.error;
    return (code && MSG[code]) || (e && e.message) || "Something went wrong.";
  }
  function badge(text, kind) { return '<span class="badge' + (kind ? " " + kind : "") + '">' + h(text) + "</span>"; }
  function statusBadge(s) { var x = STATUS[s] || [s, ""]; return badge(x[0], x[1]); }
  function money(cents) { return "$" + ((Number(cents) || 0) / 100).toFixed(2); }
  function longDate(d) {
    if (!d) return "Date not given";
    var p = String(d).slice(0, 10).split("-").map(Number);
    var dt = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return dt.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" });
  }
  function denied(e) {
    return e && (e.status === 401 || e.status === 403);
  }
  // Bought straight from a payment link, and the buyer hasn't told us about
  // the game yet (their thanks email has the link to do it).
  function needsDetails(b) {
    return b.source === "stripe" && !b.details_at && !b.event_date;
  }

  // subjectmedias.com's last 7 and 30 days: visits and taps (daily totals the
  // site counts without cookies), then the requests, claims and payments that
  // are bookings here. Nothing when the counts can't be read.
  var SITE_ROWS = [
    ["Homepage visits", "visit_home"],
    ["Opened the booking form", "book_open"],
    ["Sent a request", "requests"],
    ["Saw the 10% offer", "offer_shown"],
    ["Claimed the 10% offer", "claims"],
    ["Tapped Buy", "buy_tap"],
    ["Paid", "paid"],
    ["Fellowship page visits", "visit_fellowship"],
  ];
  function siteCard(c) {
    if (!c || !c.week || !c.month) return "";
    var n = function (o, k) { return h(String(Number(o[k]) || 0)); };
    return '<section class="card"><h2 class="sec-h">subjectmedias.com</h2>' +
      '<div class="dtable-wrap"><table class="dtable compact"><thead><tr><th scope="col">On the site</th><th scope="col">7 days</th><th scope="col">30 days</th></tr></thead><tbody>' +
      SITE_ROWS.map(function (r) { return '<tr><td class="l">' + h(r[0]) + "</td><td>" + n(c.week, r[1]) + "</td><td>" + n(c.month, r[1]) + "</td></tr>"; }).join("") +
      "</tbody></table></div>" +
      '<p class="sub" style="margin-top:8px">Visits and taps are daily totals, counted without cookies. Requests, claims and payments are the bookings themselves.</p></section>';
  }

  // ── The list ───────────────────────────────────────────────────────────
  async function bookings(arg) {
    var t = T(), all = arg === "all";
    t.show("today", '<div class="screen">' + t.backBtn("#today", "Today") + '<h1 class="title">Bookings</h1><div class="spin"></div></div>');
    var d, counts = null;
    try {
      var got = await Promise.all([
        t.api("/api/sm/bookings" + (all ? "?all=1" : "")),
        t.api("/api/sm/site/counts").catch(function () { return null; }),
      ]);
      d = got[0];
      counts = got[1];
    }
    catch (e) {
      if (e.stale) throw e;
      return t.show("today", '<div class="screen">' + t.backBtn("#today", "Today") + '<h1 class="title">Bookings</h1><p class="body err">' + h(denied(e) ? MSG.forbidden : say(e)) + "</p></div>");
    }
    var rows = (d.bookings || []).map(function (b) {
      return '<a class="li" href="#booking/' + h(b.id) + '"><div class="grow"><div class="name" style="font-size:15px">' + h(b.summary) + '</div><div class="sub">' +
        h([b.event_name, b.paid ? "Paid " + money(b.amount_cents) : "Request", b.offer === "first10" ? "10% claimed" : null, needsDetails(b) ? "Waiting on details" : null, t.ago(b.created_at)].filter(Boolean).join(" · ")) +
        "</div></div>" + statusBadge(b.status) + t.I.chev + "</a>";
    }).join("");
    t.show("today",
      '<div class="screen">' + t.backBtn("#today", "Today") +
      '<div class="head"><div><h1 class="title">Bookings</h1><p class="lede">From subjectmedias.com: requests and paid packages.</p></div></div>' +
      '<div class="btn-row" style="margin-bottom:12px"><a class="btn small' + (all ? " soft" : "") + '" href="#bookings">Open</a><a class="btn small' + (all ? "" : " soft") + '" href="#bookings/all">All</a></div>' +
      (rows ? '<div class="list">' + rows + "</div>" : '<p class="empty">' + (all ? "No bookings yet." : "Nothing open. New bookings land here and on your phone.") + "</p>") +
      siteCard(counts) +
      "</div>");
  }

  // ── One booking ────────────────────────────────────────────────────────
  async function booking(id) {
    var t = T();
    t.show(null, '<div class="screen">' + t.backBtn("#bookings", "Bookings") + '<div class="spin"></div></div>');
    var d;
    try { d = await t.api("/api/sm/bookings/" + encodeURIComponent(id)); }
    catch (e) {
      if (e.stale) throw e;
      return t.show(null, '<div class="screen">' + t.backBtn("#bookings", "Bookings") + '<p class="body err">' + h(denied(e) ? MSG.forbidden : say(e)) + "</p></div>");
    }
    var b = d.booking, m = d.matches || { crew: [], pages: [] };
    var region = b.region ? d.regions[b.region] : null;
    var closed = b.status === "delivered" || b.status === "cancelled";

    var facts = [
      ["What", [d.packages[b.package] || b.package, b.sport].filter(Boolean).join(", ")],
      ["Event", b.event_name],
      ["When", longDate(b.event_date)],
      ["Where", [b.event_city, b.event_state].filter(Boolean).join(", ") + (region ? " (" + region + ")" : "")],
      ["Athletes", b.athletes],
      ["Team and jersey", b.team_jersey],
      ["Paid", b.paid ? money(b.amount_cents) + " on Stripe" + (b.source === "form" ? ", after the request" : "") : null],
      ["Offer", b.offer === "first10" ? "Claimed 10% off the first package. Take it off when you confirm." : null],
      ["Event details", needsDetails(b) ? "Not in yet. Their thanks email has a link to add them." : b.details_at ? "From the buyer, " + t.ago(b.details_at) : null],
      ["Their note", b.booker_emailed_at ? "Emailed " + t.ago(b.booker_emailed_at) : null],
    ].filter(function (x) { return x[1]; }).map(function (x) {
      return '<div class="li" style="cursor:default"><div class="grow"><div class="sub">' + h(x[0]) + '</div><div class="name" style="font-size:15px">' + h(x[1]) + "</div></div></div>";
    }).join("");

    // Each part of the address encoded on its own: nothing in it can add a
    // recipient or a body to the draft.
    var mailto = b.contact_email ? "mailto:" + String(b.contact_email).split("@").map(encodeURIComponent).join("@") + "?subject=" + encodeURIComponent("Your Subject Medias booking") : "";
    var contact =
      '<section class="card"><h2 class="sec-h">Call them back</h2>' +
      '<p class="body" style="font-weight:700;color:var(--ink);margin-bottom:6px">' + h(b.contact_name) + "</p>" +
      '<div class="btn-row">' +
      (b.contact_phone ? '<a class="btn" href="tel:' + h(b.contact_phone.replace(/[^0-9+]/g, "")) + '">Call ' + h(b.contact_phone) + "</a>" : "") +
      (mailto ? '<a class="btn soft" href="' + h(mailto) + '">Email</a>' : "") +
      "</div>" +
      '<p class="sub" style="margin-top:8px">' + h(b.contact_email || "No email on the checkout. Find them in Stripe: " + (b.stripe_session_id || "")) + "</p>" +
      (b.notes ? '<p class="body" style="font-size:14px;white-space:pre-wrap;margin-top:10px">' + h(b.notes) + "</p>" : "") +
      "</section>";

    var crew = m.crew.length
      ? '<div class="list">' + m.crew.map(function (c) {
          var on = b.staffed_creator_id === c.id;
          // Staff only an adult with current screening, and only while the
          // booking is open (a closed one keeps who it had).
          var action = on ? badge("On it", "ok") : closed || !c.can_staff ? "" : '<button type="button" class="btn small soft" data-staff="' + h(c.id) + '">Staff</button>';
          return '<div class="li" style="cursor:default"><div class="grow"><div class="name" style="font-size:15px">' + h(c.name) + '</div><div class="sub">' +
            h([c.home_city, c.tier === "youth" ? "Youth: only beside a screened adult, not on a booking" : "Adult"].filter(Boolean).join(" · ")) + "</div></div>" +
            (c.screened ? badge("Screened", "ok") : badge("Screening due", "warn")) + action + "</div>";
        }).join("") + "</div>"
      : '<p class="empty">' + (b.region ? "No active creator in the " + h(region) + " yet." : "No place given, so no suggestions.") + "</p>";
    var pages = m.pages.length
      ? '<h3 class="sec-h" style="margin-top:14px">With their own page nearby</h3><div class="list">' + m.pages.map(function (p) {
          return '<a class="li" href="/c/' + h(p.slug) + '" target="_blank" rel="noopener"><div class="grow"><div class="name" style="font-size:15px">' + h(p.brand_name) + '</div><div class="sub">' + h(p.location) + "</div></div>" + t.I.chev + "</a>";
        }).join("") + "</div>"
      : "";

    var steps = ["new", "contacted", "offered", "staffed", "delivered", "cancelled"].map(function (s) {
      var cur = b.status === s;
      return '<button type="button" class="chip" data-status="' + s + '" aria-pressed="' + cur + '">' + h(STATUS[s][0]) + "</button>";
    }).join("");

    t.show(null,
      '<div class="screen">' + t.backBtn("#bookings", "Bookings") +
      '<div class="head"><div><p class="kicker">' + h(b.paid ? "Paid booking" : "Booking request") + " · " + h(t.ago(b.created_at)) + '</p><h1 class="title sm">' + h(b.summary) + "</h1></div>" + statusBadge(b.status) + "</div>" +
      '<section class="card"><div class="list">' + facts + "</div></section>" +
      contact +
      '<section class="card"><h2 class="sec-h">Creators in the region</h2>' +
      (d.staffed ? '<p class="body" style="font-size:14px">' + badge("On it", "ok") + " " + h(d.staffed.name) + (d.staffed.home_city ? ", " + h(d.staffed.home_city) : "") + "</p>" : "") +
      crew + pages + "</section>" +
      '<section class="card"><h2 class="sec-h">Status</h2><div class="chips" style="display:flex;flex-wrap:wrap;gap:8px">' + steps + "</div>" +
      '<p class="sub" id="bkMsg" role="status" style="margin-top:8px">' + (b.status_by ? "Last changed by " + h(b.status_by) + "." : "") + "</p></section>" +
      (window.TOJChat && window.TOJChat.workRow ? window.TOJChat.workRow("booking", b.id, "Owners only, about this booking") : "") +
      "</div>");

    function save(body, done) {
      T().post("/api/sm/bookings/" + encodeURIComponent(b.id), body, "PATCH")
        .then(function () { T().toast(done); booking(b.id); })
        .catch(function (e) { document.getElementById("bkMsg").innerHTML = '<span class="err">' + h(say(e)) + "</span>"; });
    }
    Array.prototype.forEach.call(document.querySelectorAll("[data-status]"), function (btn) {
      btn.addEventListener("click", function () {
        var s = btn.getAttribute("data-status");
        if (s === b.status) return;
        save({ status: s }, "Marked " + STATUS[s][0].toLowerCase() + ".");
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-staff]"), function (btn) {
      btn.addEventListener("click", function () { btn.disabled = true; save({ staffed_creator_id: btn.getAttribute("data-staff") }, "Staffed."); });
    });
  }

  window.TOJScreens = Object.assign(window.TOJScreens || {}, { bookings: bookings, booking: booking });
})();
