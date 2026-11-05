/* The Subject Medias marketplace in the TOJ app: our own events, their
 * rosters and the families' choices, uploads, review and sales (the API is
 * routes/sm-market.js; families use subjectmedias.com/m/). For the team
 * members Kyron gives the Marketplace tool. Registers screens for app.js:
 *
 *   #market                          the events (approvers add one here)
 *   #market/<id>                     one event: its two QR codes, footage, roster, prices
 *   #market-athlete/<id>/<athlete>   one jersey: the families' answers, keep-out, a choice in person
 *   #market-upload/<id>              clips and photos, straight to storage
 *   #market-review/<id>[/<status>]   confirm who's in each one; approve it for sale
 *   #market-orders/<id>              sales (approvers)
 *
 * Athletes are a team and a number here, never a name. Only a person's
 * confirmation decides who's in a clip; the AI only suggests.
 */
(function () {
  "use strict";
  var T = function () { return window.TOJ; };
  var h = function (s) { return T().h(s); };
  var API = "/api/sm/market";
  var enc = encodeURIComponent;

  var LEVEL = {
    none: ["No answer yet", ""],
    out: ["Kept out", "bad"],
    family: ["Family only", "warn"],
    sell: ["OK to sell", "ok"],
    "public": ["OK to show publicly", "ok"],
  };
  var STATUS = { draft: ["Draft", ""], live: ["Live", "ok"], closed: ["Closed", "warn"] };
  var MEDIA = { uploaded: "Waiting", processing: "Processing", review: "To review", approved: "On sale", hidden: "Hidden", failed: "Failed" };
  var MSG = {
    not_set_up: "The marketplace isn't set up yet: migration 033 needs to run in Supabase.",
    storage_unavailable: "The database isn't reachable right now.",
    role_too_low: "Your role can't do that. Ask Kyron.",
    team_exists: "There's already a team with that name.",
    team_has_athletes: "Remove its numbers first.",
    has_consent: "A family has answered for this number, so it stays. Remove their answer first if it was a mistake.",
    event_closed: "This event is closed, so it takes no more uploads.",
    not_uploaded: "That file didn't reach storage. Try it again.",
    already_added: "That file is already added.",
    no_confirmed_tag: "Confirm who's in it first.",
    not_ready: "It's still processing.",
    not_failed: "It hasn't failed.",
    sold: "Someone bought it, so it stays.",
    in_checkout: "Someone is checking out with it right now. Try again in an hour.",
    json_only: "Update the app and try again.",
  };
  function say(e) {
    var code = e && e.data && e.data.error;
    if (code === "invalid" && e.data.fields) return "Check: " + e.data.fields.map(function (f) { return f.replace(/_/g, " "); }).join(", ") + ".";
    return (code && MSG[code]) || (e && e.message) || "Something went wrong.";
  }
  function badge(text, kind) { return '<span class="badge' + (kind ? " " + kind : "") + '">' + h(text) + "</span>"; }
  function levelBadge(l) { var x = LEVEL[l] || [l, ""]; return badge(x[0], x[1]); }
  function money(c) { var n = Number(c || 0) / 100; return "$" + (n % 1 ? n.toFixed(2) : String(n)); }
  function length(ms) { if (!ms) return ""; var s = Math.round(ms / 1000); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
  function size(b) { return b >= 1e9 ? (b / 1e9).toFixed(1) + " GB" : b >= 1e6 ? Math.round(b / 1e6) + " MB" : Math.max(1, Math.round(b / 1e3)) + " KB"; }
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function day(s) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "")); return m ? MONTHS[+m[2] - 1] + " " + +m[3] : ""; }
  function dates(ev) { return ev.ends_on && ev.ends_on !== ev.starts_on ? day(ev.starts_on) + " to " + day(ev.ends_on) : day(ev.starts_on); }
  function app() { return document.getElementById("app"); }
  function bind(sel, type, fn) { app().querySelectorAll(sel).forEach(function (el) { el.addEventListener(type, function (e) { fn(el, e); }); }); }
  function $(id) { return document.getElementById(id); }
  function note(id, text, ok) { var m = $(id); if (m) m.innerHTML = '<span class="' + (ok ? "okc" : "err") + '">' + h(text) + "</span>"; }
  function loading(back) { T().show("today", '<div class="screen">' + (back || "") + '<div class="spin" aria-label="Loading"></div></div>'); }
  function failed(back, e) {
    T().show("today", '<div class="screen">' + back + '<h1 class="title">Marketplace</h1><p class="body err">' + h(e && (e.status === 401 || e.status === 403) && !(e.data && MSG[e.data.error]) ? "The Marketplace is for the team members Kyron adds to it." : say(e)) + "</p></div>");
  }
  function guard() { if (!T().hasTool("market")) { T().go("#today"); return false; } return true; }
  async function copyLink(url) {
    try { await navigator.clipboard.writeText(url); T().toast("Link copied."); }
    catch (e) { T().toast("Couldn't copy here. Press and hold the link to copy it."); }
  }
  async function load(id) { return T().api(API + "/events/" + enc(id)); }
  // As the server reads a number: "#07" is 7, but 0 and 00 are two numbers.
  function jersey(v) {
    var s = String(v || "").trim().replace(/^#/, "");
    if (!/^[0-9]{1,3}$/.test(s)) return null;
    if (/^0+$/.test(s)) return s.length <= 2 ? s : null;
    return s.replace(/^0+/, "");
  }
  function label(a, teams) {
    var t = (teams || []).filter(function (x) { return x.id === a.team_id; })[0];
    return (t ? t.name + " " : "") + "#" + a.jersey;
  }

  // ── The events ─────────────────────────────────────────────────────────
  async function market() {
    if (!guard()) return;
    var t = T(), back = t.backBtn("#today", "Today");
    loading(back);
    var d;
    try { d = await t.api(API + "/events"); } catch (e) { if (e.stale) throw e; return failed(back, e); }
    var rows = (d.events || []).map(function (ev) {
      var s = STATUS[ev.status] || [ev.status, ""];
      return '<a class="li" href="#market/' + h(ev.id) + '"><div class="grow"><div class="name" style="font-size:15px">' + h(ev.name) + '</div><div class="sub">' + h([dates(ev), [ev.city, ev.state].filter(Boolean).join(", "), ev.code].filter(Boolean).join(" · ")) + "</div></div>" + badge(s[0], s[1]) + t.I.chev + "</a>";
    }).join("");
    var add = t.atLeast("approver")
      ? '<section class="card"><h2 class="sec-h">New event</h2>' +
        '<label class="field"><span class="label">Name</span><input class="input" id="mkName" maxlength="120" placeholder="Gulf Coast Fall Showcase" autocomplete="off"></label>' +
        '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px"><label class="field"><span class="label">Starts</span><input class="input" id="mkStart" type="date" style="min-width:0"></label><label class="field"><span class="label">Ends <small>(if more than a day)</small></span><input class="input" id="mkEnd" type="date" style="min-width:0"></label></div>' +
        '<label class="field"><span class="label">Sport <small>(helps the AI read numbers)</small></span><input class="input" id="mkSport" maxlength="40" placeholder="Football" autocomplete="off"></label>' +
        '<label class="field"><span class="label">Venue</span><input class="input" id="mkVenue" maxlength="120" autocomplete="off"></label>' +
        '<div style="display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:10px"><label class="field"><span class="label">City</span><input class="input" id="mkCity" maxlength="80" autocomplete="off"></label><label class="field"><span class="label">State</span><input class="input" id="mkState" maxlength="2" placeholder="TX" autocomplete="off" style="text-transform:uppercase"></label></div>' +
        '<p class="sub" style="margin:0">$12 a clip and $8 a photo to start; you can change them on the event. It starts as a draft: families see it once it\'s live.</p>' +
        '<button type="button" class="btn" id="mkAdd">Create the event</button><p class="body" id="mkMsg" role="status"></p></section>'
      : "";
    t.show("today",
      '<div class="screen">' + back +
      '<div class="head"><div><p class="kicker">Subject Medias</p><h1 class="title">Marketplace</h1><p class="lede">Our own events: the roster and families\' choices from the QR, uploads, review, and what sells.</p></div></div>' +
      (rows ? '<div class="list">' + rows + "</div>" : '<p class="empty">No events yet.' + (add ? " Add the first one below." : "") + "</p>") + add + "</div>");
    if ($("mkAdd")) $("mkAdd").addEventListener("click", async function () {
      var b = this;
      b.disabled = true;
      try {
        var r = await t.post(API + "/events", { name: $("mkName").value, starts_on: $("mkStart").value, ends_on: $("mkEnd").value || undefined, sport: $("mkSport").value, venue: $("mkVenue").value, city: $("mkCity").value, state: $("mkState").value.toUpperCase() });
        t.toast("Event added.");
        t.go("#market/" + r.event.id);
      } catch (e) { b.disabled = false; note("mkMsg", say(e)); }
    });
  }

  // ── One event ──────────────────────────────────────────────────────────
  async function event(id) {
    if (!guard()) return;
    var t = T(), back = t.backBtn("#market", "Marketplace");
    loading(back);
    var d;
    try { d = await load(id); } catch (e) { if (e.stale) throw e; return failed(back, e); }
    var ev = d.event, can = d.can || {}, c = d.counts || {};
    var waiting = (c.uploaded || 0) + (c.processing || 0);
    function qrCard(which, title, sub, url) {
      var img = API + "/events/" + enc(ev.id) + "/qr/" + which + ".svg";
      return '<article class="card tight"><div class="row" style="align-items:flex-start"><img src="' + h(img) + '" alt="QR code: ' + h(title) + '" width="88" height="88" loading="lazy" style="background:#fff;border-radius:10px;padding:4px;flex:none">' +
        '<div class="grow"><div class="name" style="font-size:15px">' + h(title) + '</div><div class="sub">' + h(sub) + '</div><div class="sub mono" style="font-size:11.5px;margin-top:4px;word-break:break-all">' + h(url) + "</div></div></div>" +
        '<div class="btn-row"><button type="button" class="btn small soft" data-copy="' + h(url) + '">Copy link</button><a class="btn small soft" href="' + h(url) + '" target="_blank" rel="noopener">Open</a><a class="btn small soft" href="' + h(img) + '" download="' + h(ev.code + "-" + which + ".svg") + '">SVG</a></div></article>';
    }
    var byTeam = (d.teams || []).map(function (tm) {
      var nums = (d.athletes || []).filter(function (a) { return a.team_id === tm.id; });
      var chips = nums.map(function (a) {
        var l = LEVEL[a.level] || [a.level, ""];
        return '<a class="chip" href="#market-athlete/' + h(ev.id) + "/" + h(a.id) + '" style="text-decoration:none" aria-label="' + h(tm.name + " #" + a.jersey + ": " + l[0]) + '"><b style="color:var(--ink)">#' + h(a.jersey) + '</b><span class="badge ' + h(l[1]) + '" style="padding:4px 7px">' + h(l[0]) + "</span></a>";
      }).join("");
      return '<article class="card tight"><div class="row"><div class="grow"><div class="name" style="font-size:15px">' + h(tm.name) + '</div><div class="sub">' + nums.length + (nums.length === 1 ? " number" : " numbers") + "</div></div>" +
        (can.edit && !nums.length ? '<button type="button" class="btn small ghost" data-rmteam="' + h(tm.id) + '">Remove</button>' : "") + "</div>" +
        (chips ? '<div style="display:flex;flex-wrap:wrap;gap:8px">' + chips + "</div>" : "") +
        (can.upload ? '<div class="row"><input class="input grow" data-nums="' + h(tm.id) + '" inputmode="numeric" placeholder="Numbers: 7, 11, 23" autocomplete="off"><button type="button" class="btn small" data-addnums="' + h(tm.id) + '">Add</button></div>' : "") +
        "</article>";
    }).join("");
    var answered = (d.athletes || []).filter(function (a) { return a.level !== "none"; }).length;
    var seg = can.edit ? '<div class="seg" role="group" aria-label="Status">' + ["draft", "live", "closed"].map(function (s) { return '<button type="button" data-status="' + s + '" aria-pressed="' + (ev.status === s) + '">' + STATUS[s][0] + "</button>"; }).join("") + "</div>" +
      '<p class="sub" style="margin:0">Draft: families can answer the QR, nothing is on sale. Live: on sale. Closed: no more uploads; what\'s on sale stays.</p>' : "";
    t.show("today",
      '<div class="screen">' + back +
      '<div class="head"><div class="grow"><p class="kicker">' + h([dates(ev), ev.code].join(" · ")) + '</p><h1 class="title' + (ev.name.length > 18 ? " sm" : "") + '">' + h(ev.name) + "</h1>" +
      '<p class="lede">' + h([ev.venue, [ev.city, ev.state].filter(Boolean).join(", ")].filter(Boolean).join(", ") || "No venue yet.") + "</p></div>" + badge((STATUS[ev.status] || [ev.status])[0], (STATUS[ev.status] || [])[1]) + "</div>" +
      seg +
      '<section class="sec"><h2 class="sec-h">For families</h2>' +
      qrCard("consent", "Their choice", "Print it for check-in and the team tents. A parent or guardian picks: family only, OK to sell, OK to show publicly, or keep out.", ev.links.consent) +
      qrCard("event", "Clips and photos", "Where they find their athlete by team and number, and buy. Share it after the event.", ev.links.event) +
      "</section>" +
      '<section class="sec"><h2 class="sec-h">Footage</h2>' +
      '<div class="stats"><div class="stat' + (c.review ? " warnb" : "") + '"><b>' + (c.review || 0) + '</b><span>To review</span></div><div class="stat"><b>' + (c.approved || 0) + '</b><span>On sale</span></div><div class="stat"><b>' + waiting + '</b><span>Processing</span></div><div class="stat' + (c.failed ? " alert" : "") + '"><b>' + (c.failed || 0) + "</b><span>Failed</span></div></div>" +
      '<div class="btn-row">' + (can.upload && ev.status !== "closed" ? '<a class="btn" href="#market-upload/' + h(ev.id) + '">Upload</a>' : "") + '<a class="btn soft" href="#market-review/' + h(ev.id) + '">Review</a>' + (can.edit ? '<a class="btn soft" href="#market-orders/' + h(ev.id) + '">Sales</a>' : "") + "</div></section>" +
      '<section class="sec"><h2 class="sec-h">Roster</h2><p class="sub" style="margin:0">' + (d.athletes || []).length + " numbers; " + answered + " with a family's choice in effect. Families can add their own number from the QR. Tap a number for its answers.</p>" +
      byTeam +
      (can.upload ? '<div class="card tight"><div class="name" style="font-size:15px">Add a team</div><div class="row"><input class="input grow" id="mkTeam" maxlength="60" placeholder="Lightning 14U" autocomplete="off"><button type="button" class="btn small" id="mkTeamAdd">Add</button></div><p class="body" id="mkTeamMsg" role="status"></p></div>' : "") +
      "</section>" +
      (can.edit ? '<section class="card"><h2 class="sec-h">Prices</h2><div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px"><label class="field"><span class="label">A clip</span><input class="input" id="mkClip" inputmode="decimal" value="' + h((ev.clip_cents / 100).toFixed(2)) + '"></label><label class="field"><span class="label">A photo</span><input class="input" id="mkPhoto" inputmode="decimal" value="' + h((ev.photo_cents / 100).toFixed(2)) + '"></label></div><button type="button" class="btn small soft" id="mkPrices" style="align-self:flex-start">Save prices</button><p class="body" id="mkPriceMsg" role="status"></p></section>' : "") +
      "</div>");

    bind("[data-copy]", "click", function (b) { copyLink(b.dataset.copy); });
    bind("[data-status]", "click", async function (b) {
      if (b.getAttribute("aria-pressed") === "true") return;
      try { await t.post(API + "/events/" + enc(ev.id), { status: b.dataset.status }, "PATCH"); t.toast("It's " + STATUS[b.dataset.status][0].toLowerCase() + "."); event(id); }
      catch (e) { t.toast(say(e)); }
    });
    bind("[data-addnums]", "click", async function (b) {
      var input = app().querySelector('[data-nums="' + b.dataset.addnums + '"]');
      b.disabled = true;
      try {
        var r = await t.post(API + "/events/" + enc(ev.id) + "/athletes", { team_id: b.dataset.addnums, jerseys: input.value });
        t.toast(r.added + " added" + (r.skipped ? ", " + r.skipped + " already there" : "") + ".");
        event(id);
      } catch (e) { b.disabled = false; t.toast(say(e)); }
    });
    bind("[data-rmteam]", "click", async function (b) {
      b.disabled = true;
      try { await t.post(API + "/teams/" + enc(b.dataset.rmteam), {}, "DELETE"); event(id); }
      catch (e) { b.disabled = false; t.toast(say(e)); }
    });
    if ($("mkTeamAdd")) $("mkTeamAdd").addEventListener("click", async function () {
      var b = this;
      b.disabled = true;
      try { await t.post(API + "/events/" + enc(ev.id) + "/teams", { name: $("mkTeam").value }); event(id); }
      catch (e) { b.disabled = false; note("mkTeamMsg", say(e)); }
    });
    if ($("mkPrices")) $("mkPrices").addEventListener("click", async function () {
      var cents = function (v) { return Math.round(parseFloat(String(v).replace(/^\$/, "")) * 100); };
      try {
        await t.post(API + "/events/" + enc(ev.id), { clip_cents: cents($("mkClip").value), photo_cents: cents($("mkPhoto").value) }, "PATCH");
        note("mkPriceMsg", "Saved. New orders use these prices.", true);
      } catch (e) { note("mkPriceMsg", e.data && e.data.error === "invalid" ? "Prices run from $1 to $1,000." : say(e)); }
    });
  }

  // ── One jersey ─────────────────────────────────────────────────────────
  async function athlete(arg) {
    if (!guard()) return;
    var parts = String(arg || "").split("/"), id = parts[0], aid = parts[1];
    var t = T(), back = t.backBtn("#market/" + id, "Event");
    loading(back);
    var d;
    try { d = await load(id); } catch (e) { if (e.stale) throw e; return failed(back, e); }
    var a = (d.athletes || []).filter(function (x) { return x.id === aid; })[0];
    if (!a) return failed(back, { message: "That number isn't on this event any more." });
    var can = d.can || {};
    var answers = (a.consents || []).map(function (c) {
      var l = LEVEL[c.level] || [c.level];
      var how = c.source === "staff" ? "Recorded in person" : c.confirmed ? "From the QR, confirmed" : c.level === "out" ? "From the QR (a keep-out counts at once)" : "From the QR, waiting for them to confirm";
      var pend = c.pending ? '<div class="sub" style="color:var(--warn)">' + h("Waiting for them to confirm a change to " + (LEVEL[c.pending.level] || [c.pending.level])[0] + (c.pending.under_13 ? ", 12 or younger" : "") + ". Until then, this answer counts.") + "</div>" : "";
      return '<div class="li" style="cursor:default"><div class="grow"><div class="name" style="font-size:15px">' + h(l[0]) + (c.under_13 ? " · 12 or younger" : "") + '</div><div class="sub">' + h([how, t.ago(c.at)].join(" · ")) + "</div>" + pend + (c.email ? '<div class="sub mono" style="font-size:11.5px;word-break:break-all">' + h(c.email) + "</div>" : "") + "</div>" +
        (can.edit ? '<button type="button" class="btn small ghost" data-rmc="' + h(c.id) + '">Remove</button>' : "") + "</div>";
    }).join("");
    t.show("today",
      '<div class="screen">' + back +
      '<div class="head"><div class="grow"><p class="kicker">' + h(d.event.name) + '</p><h1 class="title">' + h(label(a, d.teams)) + "</h1></div>" + levelBadge(a.level) + "</div>" +
      '<p class="body">' + h(a.keep_out ? "Kept out by staff: nothing of them is shown or sold, whatever a family answers." : a.level === "none" ? "No answer counts yet, so nothing of them is shown or sold." : "The most careful answer is the one that counts. " + (a.level === "family" ? "Only their family's own link shows their footage." : a.level === "sell" ? "Anyone with their team and number can see and buy." : "Also allowed in public places, like the store.")) + "</p>" +
      '<section class="sec"><h2 class="sec-h">Answers</h2>' + (answers ? '<div class="list">' + answers + "</div>" : '<p class="empty">No family has answered for this number.</p>') + "</section>" +
      (can.edit
        ? '<section class="card"><h2 class="sec-h">A choice given in person</h2><p class="sub" style="margin:0">From a paper form, or a parent at check-in. You vouch for it, so it counts now, and they get their family link by email.</p>' +
          '<label class="field"><span class="label">Their email</span><input class="input" id="mkEmail" type="email" autocomplete="off"></label>' +
          '<label class="field"><span class="label">Their choice</span><select class="input" id="mkLevel"><option value="">Pick one</option><option value="family">Family only</option><option value="sell">OK to sell</option><option value="public">OK to show publicly</option><option value="out">Keep out</option></select></label>' +
          '<div class="field"><span class="label">12 or younger?</span><div class="seg" role="radiogroup" aria-label="12 or younger"><button type="button" data-u13="yes" aria-pressed="false">Yes</button><button type="button" data-u13="no" aria-pressed="false">No</button></div></div>' +
          '<button type="button" class="btn" id="mkRecord">Record it</button><p class="body" id="mkRecMsg" role="status"></p><div id="mkLink"></div></section>' +
          '<section class="card"><h2 class="sec-h">Keep out</h2><p class="sub" style="margin:0">For a takedown, or a family who asks in person. It beats every answer, at once.</p>' +
          '<button type="button" class="btn ' + (a.keep_out ? "soft" : "danger") + '" id="mkKeep">' + (a.keep_out ? "Lift the keep-out" : "Keep them out of everything") + "</button></section>" +
          (a.consents && a.consents.length ? "" : '<section class="card"><h2 class="sec-h">Entered by mistake?</h2><button type="button" class="btn danger" id="mkRmNum">Remove #' + h(a.jersey) + "</button></section>")
        : "") +
      "</div>");
    var u13 = null;
    bind("[data-u13]", "click", function (b) { u13 = b.dataset.u13; app().querySelectorAll("[data-u13]").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); }); });
    bind("[data-rmc]", "click", async function (b) {
      b.disabled = true;
      try { await t.post(API + "/consents/" + enc(b.dataset.rmc), {}, "DELETE"); t.toast("Answer removed."); athlete(arg); }
      catch (e) { b.disabled = false; t.toast(say(e)); }
    });
    if ($("mkRecord")) $("mkRecord").addEventListener("click", async function () {
      var b = this;
      b.disabled = true;
      try {
        var r = await t.post(API + "/athletes/" + enc(a.id) + "/consents", { email: $("mkEmail").value, level: $("mkLevel").value, under_13: u13 });
        if (r.family_link) {
          $("mkLink").innerHTML = '<p class="sub">' + (r.emailed ? "Emailed to them. " : "Email isn't working, so share it yourself. ") + 'Their family link:</p><div class="sub mono" style="font-size:11.5px;word-break:break-all;margin:6px 0">' + h(r.family_link) + '</div><button type="button" class="btn small soft" id="mkCopyFam">Copy it</button>';
          $("mkCopyFam").addEventListener("click", function () { copyLink(r.family_link); });
          note("mkRecMsg", "Recorded.", true);
          b.disabled = false;
        } else { t.toast("Recorded."); athlete(arg); }
      } catch (e) { b.disabled = false; note("mkRecMsg", e.data && e.data.error === "invalid" && (e.data.fields || []).indexOf("level") >= 0 && u13 === "yes" ? "Showing publicly isn't open at 12 or younger." : say(e)); }
    });
    if ($("mkKeep")) $("mkKeep").addEventListener("click", async function () {
      var b = this;
      b.disabled = true;
      try { await t.post(API + "/athletes/" + enc(a.id), { keep_out: !a.keep_out }, "PATCH"); t.toast(a.keep_out ? "Keep-out lifted." : "Kept out."); athlete(arg); }
      catch (e) { b.disabled = false; t.toast(say(e)); }
    });
    if ($("mkRmNum")) $("mkRmNum").addEventListener("click", async function () {
      var b = this;
      b.disabled = true;
      try { await t.post(API + "/athletes/" + enc(a.id), {}, "DELETE"); t.toast("Removed."); t.go("#market/" + id); }
      catch (e) { b.disabled = false; t.toast(say(e)); }
    });
  }

  // ── Uploads ────────────────────────────────────────────────────────────
  // Each file goes from this device straight to storage on a signed link,
  // then is added to the event; previews and suggestions follow on the server.
  var busy = 0;
  window.addEventListener("beforeunload", function (e) { if (busy) { e.preventDefault(); e.returnValue = ""; } });
  function put(url, file, type, progress) {
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      x.open("PUT", url);
      x.setRequestHeader("Content-Type", type);
      x.upload.onprogress = function (e) { if (e.lengthComputable) progress(e.loaded / e.total); };
      x.onload = function () { x.status >= 200 && x.status < 300 ? resolve() : reject(new Error("Storage refused it (" + x.status + ").")); };
      x.onerror = function () { reject(new Error("The upload stopped. Check the connection, then try again.")); };
      x.send(file);
    });
  }
  async function upload(id) {
    if (!guard()) return;
    var t = T(), back = t.backBtn("#market/" + id, "Event");
    loading(back);
    var d;
    try { d = await load(id); } catch (e) { if (e.stale) throw e; return failed(back, e); }
    t.show("today",
      '<div class="screen">' + back +
      '<div class="head"><div><p class="kicker">' + h(d.event.name) + '</p><h1 class="title">Upload</h1><p class="lede">Clips (MP4, MOV) and photos (JPG, PNG), up to 2 GB each. They go straight to storage; the watermarked preview and the AI\'s number suggestions follow within minutes, then they wait for review.</p></div></div>' +
      '<label class="btn" style="cursor:pointer"><span style="width:20px;height:20px;display:inline-flex">' + t.I.photo + '</span>Choose files<input type="file" id="mkFiles" multiple accept="video/mp4,video/quicktime,video/x-m4v,image/jpeg,image/png,.mp4,.mov,.m4v,.jpg,.jpeg,.png" hidden></label>' +
      '<p class="sub" style="margin:0">Keep this screen open until every file says Added.</p>' +
      '<div class="list" id="mkQueue" hidden></div><div class="btn-row" id="mkDone" hidden><a class="btn soft" href="#market-review/' + h(id) + '">Go to review</a></div></div>');
    $("mkFiles").addEventListener("change", function () { send(Array.prototype.slice.call(this.files || [])); this.value = ""; });

    function row(i, f) {
      return '<div class="li" style="cursor:default" id="mkF' + i + '"><div class="grow" style="min-width:0"><div class="name" style="font-size:15px;overflow-wrap:anywhere">' + h(f.name) + '</div><div class="sub" data-state>' + h(size(f.size)) + " · waiting</div>" +
        '<div style="height:4px;border-radius:2px;background:var(--chip);margin-top:6px;overflow:hidden"><div data-bar style="height:100%;width:0;background:var(--gold);transition:width .2s"></div></div></div></div>';
    }
    var count = 0;
    async function send(files) {
      if (!files.length) return;
      var q = $("mkQueue");
      if (!q) return;
      q.hidden = false;
      var start = count;
      count += files.length;
      q.insertAdjacentHTML("beforeend", files.map(function (f, i) { return row(start + i, f); }).join(""));
      busy++;
      try {
        for (var s = 0; s < files.length; s += 50) {
          var chunk = files.slice(s, s + 50);
          var r;
          try { r = await t.post(API + "/events/" + enc(id) + "/uploads", { files: chunk.map(function (f) { return { filename: f.name, bytes: f.size }; }) }); }
          catch (e) { chunk.forEach(function (f, i) { mark(start + s + i, say(e), "err"); }); continue; }
          for (var i = 0; i < chunk.length; i++) await one(start + s + i, chunk[i], r.uploads[i]);
        }
      } finally { busy--; }
      if ($("mkDone")) $("mkDone").hidden = false;
    }
    function mark(i, text, cls, frac) {
      var el = $("mkF" + i);
      if (!el) return;
      var st = el.querySelector("[data-state]");
      st.innerHTML = '<span class="' + (cls || "") + '">' + h(text) + "</span>";
      if (frac !== undefined) el.querySelector("[data-bar]").style.width = Math.round(frac * 100) + "%";
    }
    async function one(i, f, u) {
      if (!u || u.error) return mark(i, u && u.error === "bytes" ? "Over 2 GB, or empty." : "Not a clip or photo we take (MP4, MOV, JPG, PNG).", "err");
      try {
        mark(i, "Uploading", "", 0);
        await put(u.signed_url, f, u.content_type, function (p) { mark(i, "Uploading " + Math.round(p * 100) + "%", "", p); });
        await T().post(API + "/events/" + enc(id) + "/media", { key: u.key, filename: f.name, bytes: f.size });
        mark(i, "Added. Processing next.", "okc", 1);
      } catch (e) {
        mark(i, (e.data ? say(e) : e.message) + " ", "err");
        var el = $("mkF" + i);
        if (el && !el.querySelector("[data-retry]")) {
          el.insertAdjacentHTML("beforeend", '<button type="button" class="btn small soft" data-retry>Try again</button>');
          el.querySelector("[data-retry]").addEventListener("click", function () { el.remove(); send([f]); });
        }
      }
    }
  }

  // ── Review ─────────────────────────────────────────────────────────────
  async function review(arg) {
    if (!guard()) return;
    var parts = String(arg || "").split("/"), id = parts[0], status = parts[1] || "review";
    var t = T(), back = t.backBtn("#market/" + id, "Event");
    loading(back);
    var d, m;
    try {
      d = await load(id);
      m = await t.api(API + "/events/" + enc(id) + "/media" + (status === "all" ? "" : "?status=" + enc(status === "waiting" ? "processing" : status)));
      if (status === "waiting") m.media = m.media.concat((await t.api(API + "/events/" + enc(id) + "/media?status=uploaded")).media);
    } catch (e) { if (e.stale) throw e; return failed(back, e); }
    var can = d.can || {}, c = d.counts || {};
    var byId = {};
    (d.athletes || []).forEach(function (a) { byId[a.id] = a; });
    var tabs = [["review", "To review", c.review], ["approved", "On sale", c.approved], ["hidden", "Hidden", c.hidden], ["waiting", "Processing", (c.uploaded || 0) + (c.processing || 0)], ["failed", "Failed", c.failed]];
    var seg = '<div class="seg" role="group" aria-label="Show">' + tabs.map(function (x) { return '<button type="button" data-tab="' + x[0] + '" aria-pressed="' + (status === x[0]) + '">' + h(x[1]) + (x[2] ? " " + x[2] : "") + "</button>"; }).join("") + "</div>";
    function chip(aid, on, extra) {
      var a = byId[aid];
      if (!a) return "";
      var l = LEVEL[a.level] || [a.level, ""];
      return '<button type="button" class="chip" data-who="' + h(aid) + '" aria-pressed="' + on + '" title="' + h(l[0]) + '">' + h(label(a, d.teams)) + (extra ? ' <span class="sub">' + h(extra) + "</span>" : "") + '<span class="badge ' + h(l[1]) + '" style="padding:3px 6px;font-size:10.5px">' + h(l[0]) + "</span></button>";
    }
    var cards = (m.media || []).map(function (x) {
      var view = x.kind === "clip"
        ? (x.preview_url ? '<video controls playsinline preload="none" src="' + h(x.preview_url) + '"' + (x.poster_url ? ' poster="' + h(x.poster_url) + '"' : "") + ' style="width:100%;border-radius:12px;background:#000;aspect-ratio:16/9"></video>' : "")
        : (x.preview_url ? '<img src="' + h(x.preview_url) + '" alt="Photo preview" loading="lazy" style="width:100%;border-radius:12px;background:#000;aspect-ratio:16/9;object-fit:contain">' : "");
      var tagged = (x.tags || []).map(function (g) { return chip(g.athlete_id, g.confirmed, g.source === "ai" && !g.confirmed && g.confidence ? Math.round(g.confidence * 100) + "% AI" : ""); }).join("");
      var ready = ["review", "approved", "hidden"].indexOf(x.status) >= 0;
      var picker = ready && can.upload
        ? '<div class="row" style="flex-wrap:wrap"><select class="input" data-addteam style="flex:1 1 140px;min-height:40px">' + (d.teams || []).map(function (tm) { return '<option value="' + h(tm.id) + '">' + h(tm.name) + "</option>"; }).join("") + '</select><input class="input" data-addnum inputmode="numeric" placeholder="#" style="flex:0 1 80px;min-height:40px"><button type="button" class="btn small soft" data-addwho>Add</button></div>'
        : "";
      var actions = "";
      if (ready && can.upload) actions += '<button type="button" class="btn small soft" data-save>Save who\'s in it</button>';
      if (ready && can.edit && x.status !== "approved") actions += '<button type="button" class="btn small" data-approve>Approve for sale</button>';
      if (ready && can.edit && x.status !== "hidden") actions += '<button type="button" class="btn small ghost" data-hide>Hide</button>';
      if (x.status === "failed" && can.upload) actions += '<button type="button" class="btn small" data-retry>Try again</button>';
      return '<article class="card" data-media="' + h(x.id) + '">' + view +
        '<div class="row"><div class="grow"><div class="name" style="font-size:15px;overflow-wrap:anywhere">' + h(x.filename || (x.kind === "clip" ? "Clip" : "Photo")) + '</div><div class="sub">' + h([x.kind === "clip" ? "Clip" + (x.duration_ms ? " " + length(x.duration_ms) : "") : "Photo", t.ago(x.created_at)].join(" · ")) + "</div></div>" + badge(MEDIA[x.status] || x.status, x.status === "approved" ? "ok" : x.status === "failed" ? "bad" : x.status === "review" ? "gold" : "") + "</div>" +
        (x.error ? '<p class="sub err" style="margin:0">' + h(x.error) + "</p>" : "") +
        (ready ? '<div class="field"><span class="label">Who\'s in it</span><div style="display:flex;flex-wrap:wrap;gap:8px" data-chips>' + (tagged || '<span class="sub" data-none>No numbers yet. Add who you can see.</span>') + "</div>" + picker + "</div>" : "") +
        (actions ? '<div class="btn-row">' + actions + "</div>" : "") + '<p class="body" data-msg role="status"></p></article>';
    }).join("");
    var empty = { review: "Nothing waiting. New uploads land here once their previews are made.", approved: "Nothing on sale yet.", hidden: "Nothing hidden.", waiting: "Nothing processing.", failed: "Nothing failed." }[status] || "Nothing here.";
    t.show("today",
      '<div class="screen">' + back +
      '<div class="head"><div><p class="kicker">' + h(d.event.name) + '</p><h1 class="title">Review</h1><p class="lede">Confirm who\'s in each one: tap a number to switch it on or off, or add one you can see. Only confirmed numbers decide who sees it. A family\'s choice decides where it can be sold.</p></div></div>' +
      seg + (cards || '<p class="empty">' + h(empty) + "</p>") + "</div>");

    bind("[data-tab]", "click", function (b) { t.go("#market-review/" + id + (b.dataset.tab === "review" ? "" : "/" + b.dataset.tab)); });
    bind("[data-who]", "click", function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true")); });
    bind("[data-addwho]", "click", function (b) {
      var card = b.closest("[data-media]");
      var team = card.querySelector("[data-addteam]").value;
      var num = jersey(card.querySelector("[data-addnum]").value);
      var a = (d.athletes || []).filter(function (x) { return x.team_id === team && x.jersey === num; })[0];
      var msg = card.querySelector("[data-msg]");
      if (!a) { msg.innerHTML = '<span class="err">' + h("That number isn't on the roster. Add it on the event first.") + "</span>"; return; }
      msg.textContent = "";
      var box = card.querySelector("[data-chips]");
      var none = box.querySelector("[data-none]");
      if (none) none.remove();
      var have = box.querySelector('[data-who="' + a.id + '"]');
      if (have) { have.setAttribute("aria-pressed", "true"); return; }
      box.insertAdjacentHTML("beforeend", chip(a.id, true, ""));
      var added = box.lastElementChild;
      added.addEventListener("click", function () { added.setAttribute("aria-pressed", String(added.getAttribute("aria-pressed") !== "true")); });
      card.querySelector("[data-addnum]").value = "";
    });
    function who(card) { return Array.prototype.slice.call(card.querySelectorAll('[data-who][aria-pressed="true"]')).map(function (b) { return b.dataset.who; }); }
    async function patch(b, body, done) {
      var card = b.closest("[data-media]");
      b.disabled = true;
      try { await t.post(API + "/media/" + enc(card.dataset.media), body, "PATCH"); t.toast(done); review(arg); }
      catch (e) { b.disabled = false; card.querySelector("[data-msg]").innerHTML = '<span class="err">' + h(say(e)) + "</span>"; }
    }
    bind("[data-save]", "click", function (b) { patch(b, { tags: who(b.closest("[data-media]")) }, "Saved."); });
    bind("[data-approve]", "click", function (b) { patch(b, { tags: who(b.closest("[data-media]")), status: "approved" }, "On sale."); });
    bind("[data-hide]", "click", function (b) { patch(b, { status: "hidden" }, "Hidden."); });
    bind("[data-retry]", "click", async function (b) {
      var card = b.closest("[data-media]");
      b.disabled = true;
      try { await t.post(API + "/media/" + enc(card.dataset.media) + "/retry", {}); t.toast("Trying again."); review(arg); }
      catch (e) { b.disabled = false; t.toast(say(e)); }
    });
  }

  // ── Sales ──────────────────────────────────────────────────────────────
  async function orders(id) {
    if (!guard()) return;
    var t = T(), back = t.backBtn("#market/" + id, "Event");
    loading(back);
    var d, o;
    try { d = await load(id); o = await t.api(API + "/events/" + enc(id) + "/orders"); } catch (e) { if (e.stale) throw e; return failed(back, e); }
    var S = { paid: ["Paid", "ok"], pending: ["Checking out", ""], expired: ["Didn't pay", ""], refunded: ["Refunded", "warn"] };
    var rows = (o.orders || []).map(function (x) {
      var s = S[x.status] || [x.status, ""];
      return '<div class="li" style="cursor:default"><div class="grow"><div class="name" style="font-size:15px">' + h(money(x.amount_cents)) + " · " + x.items + (x.items === 1 ? " item" : " items") + (x.mode === "test" ? " · test" : "") + '</div><div class="sub" style="overflow-wrap:anywhere">' + h([x.email || "No email yet", t.ago(x.paid_at || x.created_at)].join(" · ")) + "</div></div>" + badge(s[0], s[1]) + "</div>";
    }).join("");
    t.show("today",
      '<div class="screen">' + back +
      '<div class="head"><div><p class="kicker">' + h(d.event.name) + '</p><h1 class="title">Sales</h1><p class="lede">Every checkout started from this event\'s pages. Refunds are made in Stripe.</p></div></div>' +
      '<div class="stats"><div class="stat"><b>' + o.totals.paid_orders + '</b><span>Paid orders</span></div><div class="stat"><b>' + h(money(o.totals.paid_cents)) + "</b><span>Paid</span></div></div>" +
      (rows ? '<div class="list">' + rows + "</div>" : '<p class="empty">No sales yet.</p>') + "</div>");
  }

  window.TOJScreens = Object.assign(window.TOJScreens || {}, {
    market: function (arg) { return arg ? event(arg) : market(); },
    "market-athlete": athlete,
    "market-upload": upload,
    "market-review": review,
    "market-orders": orders,
  });
})();
