/* The Creator Club in the TOJ app (phase 1): creators, their landing page on
 * request, events with QR codes, crew codes, event sales and the CSV, and
 * Stripe payouts in test mode. Registers screens for app.js's router:
 *
 *   #creators                 the list
 *   #cnew                     new creator (form, or a Jotform export)
 *   #creator/<id>             profile: ladder, checks, page, payouts, events, crew
 *   #cedit/<id>               edit the page (packages, words, colors)
 *   #cevent/<id>/<eventId>    an event: QR, cards, orders, CSV
 *
 * Buyer details show only to members and up, never in logs or alerts.
 */
(function () {
  "use strict";
  var T = function () { return window.TOJ; };
  var h = function (s) { return T().h(s); };
  var app = function () { return document.getElementById("app"); };

  var MSG = {
    owner_only: "Only Kyron can change that.",
    page_live_owner_edits: "The page is live, so only Kyron can change what the public sees.",
    would_break_live_page: "That would break the live page. Fix the problems first.",
    guardian_required: "Under 18: add a parent or guardian's email. They hold the Stripe account.",
    slug_locked: "The page address is fixed once a page is requested; QR codes point at it.",
    slug_taken: "Another creator already has that address.",
    fix_blockers_first: "Fix the problems listed under Checks first.",
    already_live: "The page is already live.",
    brand_name_required: "Add the business name.",
    stripe_not_configured: "Stripe isn't set up on the server yet (a test key is needed).",
    live_key_refused: "Live payments stay off until counsel picks the company.",
    payouts_not_ready: "Payouts aren't set up yet.",
    name_required: "Add a name.",
    not_on_team: "You don't have the Creators tool. Ask Kyron.",
    role_too_low: "Your role can't do that.",
  };
  function say(e) {
    var code = e && e.data && e.data.error;
    return (code && MSG[code]) || (e && e.data && e.data.hint) || (e && e.message) || "Something went wrong.";
  }
  function money(cents) { var v = (Number(cents) || 0) / 100; return "$" + (Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })); }
  function dateWords(d) {
    if (!d) return "";
    var p = String(d).slice(0, 10).split("-").map(Number);
    return p[0] ? ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][p[1] - 1] + " " + p[2] + ", " + p[0] : "";
  }
  var PAGE = { none: ["No page yet", ""], requested: ["Waiting for approval", "warn"], live: ["Live", "ok"], off: ["Taken down", "bad"] };
  function badge(text, kind) { return '<span class="badge' + (kind ? " " + kind : "") + '">' + h(text) + "</span>"; }
  function modeBanner(mode) {
    if (mode === "test") return '<div class="card tight" style="border-color:#7A6324"><div class="row"><span class="badge warn">Stripe test mode</span><span class="sub grow">No real charges until counsel picks the company that holds Stripe.</span></div></div>';
    if (mode === "live") return "";
    return '<div class="card tight"><div class="row"><span class="badge">Checkout off</span><span class="sub grow">Stripe isn\'t set up on the server yet. Pages, QR codes and CSVs still work.</span></div></div>';
  }
  function share(url, title) {
    if (navigator.share) navigator.share({ title: title, url: url }).catch(function () {});
    else T().copy(null, url);
  }

  // ── The list ───────────────────────────────────────────────────────────
  async function creators() {
    var t = T();
    if (!t.hasTool("creators")) return t.go("#tools");
    t.show("tools", '<div class="screen"><h1 class="title">Creators</h1><div class="spin"></div></div>');
    var d = await t.api("/api/creators");
    var rows = (d.creators || []).map(function (c) {
      var pg = PAGE[c.page_status] || PAGE.none;
      return '<a class="li" href="#creator/' + h(c.id) + '"><div class="grow"><div class="name" style="font-size:15.5px">' + h(c.brand_name) + '</div><div class="sub">' + h([c.handle, "Rung " + c.rung, pg[0]].filter(Boolean).join(" · ")) + "</div></div>" +
        (c.blockers ? badge(c.blockers + " to fix", "bad") : c.totals.orders ? '<span class="sub" style="font-weight:700;color:var(--ink)">' + h(money(c.totals.sales_cents)) + "</span>" : "") + t.I.chev + "</a>";
    }).join("");
    t.show("tools",
      '<div class="screen">' + t.backBtn("#tools", "Tools") +
      '<div class="head"><div><h1 class="title">Creators</h1><p class="lede">The Creator Club: pages, QR codes and event sales.</p></div>' + (t.atLeast("member") ? '<a class="btn small" href="#cnew">' + t.I.plus.replace("<svg", '<svg width="16" height="16"') + "New</a>" : "") + "</div>" +
      modeBanner(d.stripe_mode) +
      (rows ? '<div class="list">' + rows + "</div>" : '<p class="empty">No creators yet.' + (t.atLeast("member") ? " Add the first one." : "") + "</p>") +
      "</div>");
  }

  // ── New creator ────────────────────────────────────────────────────────
  function field(id, label, attrs, value) {
    return '<div class="field"><label class="label" for="' + id + '">' + label + '</label><input class="input" id="' + id + '" ' + (attrs || 'type="text"') + ' value="' + h(value == null ? "" : value) + '"></div>';
  }
  async function cnew() {
    var t = T();
    if (!t.atLeast("member") || !t.hasTool("creators")) return t.go("#creators");
    t.show(null,
      '<div class="screen"><div class="head"><a class="back" href="#creators">' + t.I.back + "Cancel</a></div><h1 class=\"title sm\">New creator</h1>" +
      '<p class="lede">From the intake call or the Jotform. It starts as a draft; nothing is public until Kyron approves the page.</p>' +
      field("bn", "Business name", 'type="text" maxlength="80" autocomplete="off"') +
      field("hd", "Instagram handle", 'type="text" maxlength="31" autocomplete="off" placeholder="@handle"') +
      field("lc", "Coverage area", 'type="text" maxlength="80" placeholder="City, State"') +
      field("tg", "One-line tagline", 'type="text" maxlength="160" placeholder="Photo and video coverage for your athlete, delivered fast."') +
      '<div class="field"><label class="label" for="pc">Brand color</label><div class="row"><input id="pc" type="color" value="#e10f1c" style="width:56px;height:44px;border:0;background:none"><span class="sub">The page\'s main color.</span></div></div>' +
      '<div class="field"><span class="label">Prices <small>(dollars)</small></span><div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px">' +
      [["pp", "Photo", 49], ["vp", "Video", 99], ["fp", "Full (photo + video)", 139], ["tp", "Team", 399]].map(function (x) { return '<label class="sub">' + x[1] + '<input class="input" id="' + x[0] + '" type="number" min="5" max="20000" step="1" inputmode="numeric" value="' + x[2] + '"></label>'; }).join("") + "</div></div>" +
      field("ce", "Creator's email", 'type="email" inputmode="email" autocomplete="off"') +
      '<label class="li" style="border-radius:14px;border:1px solid var(--line);cursor:pointer"><input type="checkbox" class="switch" id="u18"><div class="grow"><div class="name" style="font-size:15px">Under 18</div><div class="sub">A parent or guardian holds the Stripe account and sees payouts.</div></div></label>' +
      '<div id="gWrap" hidden>' + field("ge", "Parent or guardian's email", 'type="email" inputmode="email" autocomplete="off"') + "</div>" +
      field("cm", "Camera body <small>(for the SportsClippers rung)</small>", 'type="text" maxlength="60" placeholder="Sony FX30"') +
      '<details class="card tight"><summary class="name" style="font-size:15px;cursor:pointer">Or paste a Jotform export</summary><textarea class="textarea mono" id="jf" placeholder="{ &quot;answers&quot;: { … } }" style="min-height:120px;margin-top:10px"></textarea><p class="sub" style="margin:6px 0 0">Question labels must match the intake form (Business name, Coverage area, Creator email, …).</p></details>' +
      '<p id="cnMsg" class="body" role="status"></p></div>' +
      '<div class="dock"><div class="dock-inner"><button type="button" class="btn block" id="cnGo">Add the creator</button><span class="note">Saved as a draft with its checks.</span></div></div>');
    document.getElementById("u18").addEventListener("change", function () { document.getElementById("gWrap").hidden = !this.checked; });
    document.getElementById("cnGo").addEventListener("click", async function () {
      var btn = this, msg = document.getElementById("cnMsg");
      var v = function (id) { return document.getElementById(id).value.trim(); };
      var body;
      if (v("jf")) {
        try { body = { answers: JSON.parse(v("jf")) }; } catch (e) { msg.innerHTML = '<span class="err">That export isn\'t valid JSON.</span>'; return; }
      } else {
        if (!v("bn")) { msg.innerHTML = '<span class="err">Add the business name.</span>'; return; }
        body = { intake: { brandName: v("bn"), handle: v("hd"), location: v("lc"), tagline: v("tg"), primary: document.getElementById("pc").value, photoPrice: v("pp"), videoPrice: v("vp"), fullPrice: v("fp"), teamPrice: v("tp"), creatorEmail: v("ce"), under18: document.getElementById("u18").checked ? "yes" : "no", guardianEmail: v("ge"), camera: v("cm") } };
      }
      btn.disabled = true;
      try {
        var d = await T().post("/api/creators", body);
        T().toast(d.under_18_needs_guardian ? "Saved. Add the guardian's email before anything else." : "Saved as a draft.");
        T().go("#creator/" + d.creator.id);
      } catch (e) { btn.disabled = false; msg.innerHTML = '<span class="err">' + h(say(e)) + "</span>"; }
    });
  }

  // ── One creator ────────────────────────────────────────────────────────
  async function creator(id) {
    var t = T();
    if (!t.hasTool("creators")) return t.go("#tools");
    t.show(null, '<div class="screen">' + t.backBtn("#creators", "Creators") + '<div class="spin"></div></div>');
    var d = await t.api("/api/creators/" + encodeURIComponent(id));
    var c = d.creator, own = t.isOwner(), mem = t.atLeast("member");
    var blocks = (d.checks || []).filter(function (x) { return x.level === "block"; });
    var warns = (d.checks || []).filter(function (x) { return x.level === "warn"; });
    var pg = PAGE[c.page_status] || PAGE.none;

    var ladder = d.rungs.map(function (r) {
      var cur = r.state === "current";
      return '<div class="li" style="cursor:default;align-items:flex-start' + (cur ? ";background:#1A2C45" : "") + '"><span class="badge' + (r.state === "done" ? " ok" : cur ? " gold" : "") + '" style="flex:none;min-width:28px;justify-content:center">' + r.n + '</span><div class="grow"><div class="name" style="font-size:15px">' + h(r.name) + '</div><div class="sub">' + h(r.unlocks) + "</div>" + (cur || r.state === "ahead" ? '<div class="sub" style="color:var(--faint)">' + h("Gate: " + r.gate) + "</div>" : "") + "</div></div>";
    }).join("");

    var checks = blocks.length || warns.length
      ? '<section class="card"><h2 class="sec-h">Checks</h2>' + blocks.map(function (x) { return '<p class="body" style="font-size:14px"><span class="badge bad">Fix</span> ' + h(x.message) + ' <span class="sub">· ' + h(x.field) + "</span></p>"; }).join("") + warns.map(function (x) { return '<p class="body" style="font-size:14px"><span class="badge warn">Look</span> ' + h(x.message) + ' <span class="sub">· ' + h(x.field) + "</span></p>"; }).join("") + "</section>"
      : '<section class="card tight"><div class="row"><span class="badge ok">' + t.I.check + 'Checks pass</span><span class="sub grow">No banned words; colors, prices and contacts are in order.</span></div></section>';

    var pageBtns = '<a class="btn small soft" href="#tool/cpreview:' + h(c.id) + '">Preview</a>' +
      (mem ? '<a class="btn small soft" href="#cedit/' + h(c.id) + '">Edit page</a>' : "") +
      (mem && (c.page_status === "none" || c.page_status === "off") ? '<button type="button" class="btn small" id="pgReq"' + (blocks.length ? " disabled" : "") + ">Ask to go live</button>" : "") +
      (own && c.page_status === "requested" ? '<button type="button" class="btn small" id="pgOk"' + (blocks.length ? " disabled" : "") + ">Approve and go live</button>" : "") +
      (own && c.page_status === "live" ? '<button type="button" class="btn small danger" id="pgOff">Take down</button>' : "") +
      (c.page_status === "live" ? '<button type="button" class="btn small soft" id="pgShare">' + t.I.share + "Share link</button>" : "");
    var page = '<section class="card"><div class="row"><div class="grow"><h2 class="sec-h" style="margin:0">Landing page</h2><div class="sub mono" style="word-break:break-all;margin-top:4px">' + h(d.page_url) + "</div></div>" + badge(pg[0], pg[1]) + '</div><div class="btn-row" style="flex-wrap:wrap">' + pageBtns + "</div>" +
      (c.page_status === "requested" && !own ? '<p class="sub" style="margin:0">Kyron approves pages before they go live.</p>' : "") + "</section>";

    var holder = c.under_18 ? "the parent or guardian" : "the creator";
    var pay = '<section class="card"><div class="row"><div class="grow"><h2 class="sec-h" style="margin:0">Payouts</h2><div class="sub">Creator keeps ' + h(c.split_percent) + "% of each sale on their page · paid to " + h(holder) + "</div></div>" + (c.stripe_ready ? badge("Ready", "ok") : c.stripe_connected ? badge("Setup started", "warn") : badge("Not set up")) + "</div>" +
      '<div class="btn-row" style="flex-wrap:wrap">' + (own ? '<button type="button" class="btn small" id="stConnect">' + (c.stripe_connected ? "New setup link" : "Set up payouts") + "</button>" : "") + (c.stripe_connected ? '<button type="button" class="btn small soft" id="stRefresh">Check status</button>' : "") + "</div>" +
      (own ? '<div class="row" style="gap:8px"><label class="sub" for="splitIn" style="flex:none">Creator\'s share</label><input class="input" id="splitIn" type="number" min="50" max="95" step="1" value="' + h(c.split_percent) + '" style="width:90px"><span class="sub">%</span><button type="button" class="btn small soft" id="splitSave">Save</button></div>' : "") +
      '<div id="stLink"></div></section>';

    var events = (d.events || []).map(function (e) {
      return '<a class="li" href="#cevent/' + h(c.id) + "/" + h(e.id) + '"><div class="grow"><div class="name" style="font-size:15px">' + h(e.name) + '</div><div class="sub">' + h([dateWords(e.event_date), e.venue, "code " + e.code].filter(Boolean).join(" · ")) + "</div></div>" + (e.totals.orders ? '<span class="sub" style="font-weight:700;color:var(--ink)">' + h(money(e.totals.sales_cents)) + "</span>" : e.status !== "upcoming" ? badge(e.status) : "") + t.I.chev + "</a>";
    }).join("");
    var evForm = mem ? '<details class="card tight"><summary class="name" style="font-size:15px;cursor:pointer">Add an event</summary><div style="display:flex;flex-direction:column;gap:10px;margin-top:10px">' + field("evN", "Event", 'type="text" maxlength="80" placeholder="Spring 7v7 Classic"') + '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px">' + field("evD", "Date", 'type="date"') + field("evS", "Sport", 'type="text" maxlength="40" placeholder="7v7"') + "</div>" + field("evV", "Venue", 'type="text" maxlength="80"') + '<button type="button" class="btn" id="evGo">Add the event</button></div></details>' : "";

    var crew = (d.crew || []).map(function (m) {
      return '<div class="li" style="cursor:default"><div class="grow"><div class="name" style="font-size:15px">' + h(m.name) + '</div><div class="sub">' + h(m.role) + " · code " + h(m.code) + "</div></div>" + (mem ? '<input type="checkbox" class="switch" data-crew="' + h(m.id) + '"' + (m.active ? " checked" : "") + ' aria-label="Active">' : m.active ? "" : badge("off")) + "</div>";
    }).join("");
    var crewForm = mem ? '<details class="card tight"><summary class="name" style="font-size:15px;cursor:pointer">Add crew</summary><div style="display:flex;flex-direction:column;gap:10px;margin-top:10px">' + field("crN", "Name", 'type="text" maxlength="60"') + '<div class="field"><label class="label" for="crR">Role</label><select class="input" id="crR">' + ["lead", "support", "photographer", "coordinator", "editor", "designer"].map(function (r) { return '<option value="' + r + '">' + r[0].toUpperCase() + r.slice(1) + "</option>"; }).join("") + '</select></div><button type="button" class="btn" id="crGo">Add</button><p class="sub" style="margin:0">Each person gets a code. Their QR card and page link credit their sales.</p></div></details>' : "";

    var settings = own ? '<section class="card"><h2 class="sec-h">Owner settings</h2><div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px">' +
      '<label class="sub">Rung<select class="input" id="sRung">' + [1, 2, 3, 4, 5, 6].map(function (n) { return '<option value="' + n + '"' + (n === c.rung ? " selected" : "") + ">" + n + "</option>"; }).join("") + "</select></label>" +
      '<label class="sub">Club fee<select class="input" id="sClub">' + ["pending", "active", "lapsed"].map(function (n) { return '<option value="' + n + '"' + (n === c.club_status ? " selected" : "") + ">" + n[0].toUpperCase() + n.slice(1) + "</option>"; }).join("") + "</select></label>" +
      '<label class="sub">Status<select class="input" id="sStatus">' + ["draft", "active", "paused"].map(function (n) { return '<option value="' + n + '"' + (n === c.status ? " selected" : "") + ">" + n[0].toUpperCase() + n.slice(1) + "</option>"; }).join("") + "</select></label>" +
      '<label class="sub">Camera approved<select class="input" id="sCam"><option value="no"' + (c.camera_approved ? "" : " selected") + '>No</option><option value="yes"' + (c.camera_approved ? " selected" : "") + ">Yes</option></select></label></div>" +
      '<p class="sub" style="margin:0">Camera: ' + h(c.camera || "not given") + '</p><button type="button" class="btn small soft" id="sSave" style="align-self:flex-start">Save settings</button></section>' : "";

    t.show(null,
      '<div class="screen">' + t.backBtn("#creators", "Creators") +
      '<div><p class="kicker">' + h([c.handle, c.location].filter(Boolean).join(" · ") || "Creator") + '</p><h1 class="title sm">' + h(c.brand_name) + '</h1><div class="btn-row" style="gap:6px;flex-wrap:wrap;margin-top:8px">' + badge(c.status[0].toUpperCase() + c.status.slice(1)) + badge("Club fee: " + c.club_status, c.club_status === "active" ? "ok" : "") + (c.under_18 ? badge("Under 18") : "") + badge("Rung " + c.rung, "gold") + "</div></div>" +
      modeBanner(d.stripe_mode) +
      '<section class="sec"><h2 class="sec-h">Sales</h2><div class="tile-grid"><div class="tile" style="cursor:default"><span class="sub">Orders</span><span style="font:700 24px/1 var(--text)">' + h(d.totals.orders) + '</span></div><div class="tile" style="cursor:default"><span class="sub">Sales · creator\'s share</span><span style="font:700 20px/1.1 var(--text)">' + h(money(d.totals.sales_cents)) + ' <span class="sub">· ' + h(money(d.totals.creator_cents)) + "</span></span></div></div></section>" +
      checks + page + pay +
      '<section class="sec"><h2 class="sec-h">Events</h2>' + (events ? '<div class="list">' + events + "</div>" : '<p class="empty">No events yet. Each event gets its own QR code.</p>') + evForm + "</section>" +
      '<section class="sec"><h2 class="sec-h">Crew</h2>' + (crew ? '<div class="list">' + crew + "</div>" : '<p class="empty">No crew yet.</p>') + crewForm + "</section>" +
      '<section class="sec"><h2 class="sec-h">The ladder</h2><div class="list">' + ladder + "</div></section>" +
      settings + '<p id="cMsg" class="body" role="status"></p></div>');

    var msg = document.getElementById("cMsg");
    function act(elId, fn) {
      var el = document.getElementById(elId);
      if (el) el.addEventListener("click", async function () {
        el.disabled = true;
        try { await fn(el); } catch (e) { el.disabled = false; msg.innerHTML = '<span class="err">' + h(say(e)) + "</span>"; msg.scrollIntoView({ block: "nearest" }); }
      });
    }
    var base = "/api/creators/" + encodeURIComponent(c.id);
    act("pgReq", async function () { await t.post(base + "/page/request"); t.toast("Sent to Kyron for approval."); creator(id); });
    act("pgOk", async function () { await t.post(base + "/page/approve"); t.toast("The page is live."); creator(id); });
    act("pgOff", async function (el) {
      if (!el.dataset.armed) { el.dataset.armed = "1"; el.disabled = false; el.textContent = "Tap again to take it down"; return; }
      await t.post(base + "/page/off"); t.toast("Page taken down."); creator(id);
    });
    act("pgShare", async function (el) { el.disabled = false; share(d.page_url, c.brand_name); });
    act("stConnect", async function (el) {
      var r = await t.post(base + "/stripe/connect");
      el.disabled = false;
      document.getElementById("stLink").innerHTML = '<div class="card tight" style="margin-top:4px"><div class="name" style="font-size:15px">Send this to ' + h(r.holder === "parent_or_guardian" ? "the parent or guardian" : "the creator") + (r.holder_email ? " (" + h(r.holder_email) + ")" : "") + '</div><p class="sub" style="margin:0">They finish Stripe\'s setup themselves; the link expires in a few minutes, so make a new one if it does. ' + (r.mode === "test" ? "Test mode: Stripe accepts test details." : "") + '</p><div class="mono sub" style="word-break:break-all">' + h(r.url) + '</div><div class="btn-row" style="flex-wrap:wrap"><button type="button" class="btn small" id="stCopy">Copy link</button>' + (navigator.share ? '<button type="button" class="btn small soft" id="stShare">' + t.I.share + "Share…</button>" : "") + (document.getElementById("stRefresh") ? "" : '<button type="button" class="btn small soft" id="stRefresh">Check status</button>') + "</div></div>";
      document.getElementById("stCopy").addEventListener("click", function () { t.copy(null, r.url); });
      var ss = document.getElementById("stShare");
      if (ss) ss.addEventListener("click", function () { share(r.url, "Set up payouts"); });
      if (!refreshWired) wireRefresh();
    });
    var refreshWired = false;
    function wireRefresh() {
      if (!document.getElementById("stRefresh")) return;
      refreshWired = true;
      act("stRefresh", async function (el) { var r = await t.post(base + "/stripe/refresh"); t.toast(r.ready ? "Payouts are ready." : "Not finished yet."); el.disabled = false; if (r.ready) creator(id); });
    }
    wireRefresh();
    act("splitSave", async function (el) { await t.post(base, { split_percent: Number(document.getElementById("splitIn").value) }, "PATCH"); t.toast("Share saved."); el.disabled = false; });
    act("sSave", async function (el) {
      await t.post(base, { rung: Number(document.getElementById("sRung").value), club_status: document.getElementById("sClub").value, status: document.getElementById("sStatus").value, camera_approved: document.getElementById("sCam").value === "yes" }, "PATCH");
      t.toast("Settings saved."); creator(id);
    });
    act("evGo", async function (el) {
      var v = function (x) { return document.getElementById(x).value.trim(); };
      var r = await t.post(base + "/events", { name: v("evN"), event_date: v("evD") || null, sport: v("evS"), venue: v("evV") });
      t.go("#cevent/" + c.id + "/" + r.event.id);
    });
    act("crGo", async function () { await t.post(base + "/crew", { name: document.getElementById("crN").value.trim(), role: document.getElementById("crR").value }); t.toast("Added."); creator(id); });
    app().querySelectorAll("[data-crew]").forEach(function (sw) {
      sw.addEventListener("change", async function () {
        try { await t.post(base + "/crew/" + encodeURIComponent(sw.dataset.crew), { active: sw.checked }, "PATCH"); } catch (e) { sw.checked = !sw.checked; t.toast(say(e)); }
      });
    });
  }

  // ── Edit the page ──────────────────────────────────────────────────────
  async function cedit(id) {
    var t = T();
    if (!t.atLeast("member") || !t.hasTool("creators")) return t.go("#creator/" + id);
    var d = await t.api("/api/creators/" + encodeURIComponent(id));
    var c = d.creator;
    var th = c.theme || {};
    var pk = (c.packages || []).slice();
    var tt = c.team_tier || { show: false, name: "Team Package", price: 399, desc: "" };
    function pkgBlock(k, i) {
      return '<div class="card tight" data-pk="' + i + '"><div class="row"><div class="name grow" style="font-size:15px">Package ' + (i + 1) + '</div><label class="sub" style="display:flex;gap:6px;align-items:center"><input type="radio" name="feat" value="' + i + '"' + (k.featured ? " checked" : "") + ">Most popular</label></div>" +
        '<div style="display:grid;grid-template-columns:2fr 1fr;gap:8px"><input class="input" data-f="name" maxlength="40" value="' + h(k.name) + '" aria-label="Name"><input class="input" data-f="price" type="number" min="5" max="5000" step="1" value="' + h(k.price) + '" aria-label="Price"></div>' +
        '<input class="input" data-f="desc" maxlength="160" value="' + h(k.desc) + '" aria-label="Description" placeholder="One line about it">' +
        '<textarea class="textarea" data-f="features" aria-label="What\'s included, one per line" style="min-height:84px">' + h((k.features || []).join("\n")) + "</textarea></div>";
    }
    t.show(null,
      '<div class="screen"><div class="head"><a class="back" href="#creator/' + h(c.id) + '">' + t.I.back + "Cancel</a></div><h1 class=\"title sm\">Edit the page</h1>" +
      (c.page_status === "live" && !t.isOwner() ? '<p class="body warnc">The page is live, so only Kyron can change what the public sees.</p>' : "") +
      field("eBn", "Business name", 'type="text" maxlength="80"', c.brand_name) +
      field("eHd", "Instagram handle", 'type="text" maxlength="31"', c.handle) +
      field("eLc", "Coverage area", 'type="text" maxlength="80"', c.location) +
      field("eTg", "Tagline", 'type="text" maxlength="160"', c.tagline) +
      '<div class="field"><span class="label">Headline <small>(3 lines; the middle one is in the accent color)</small></span>' + [0, 1, 2].map(function (i) { return '<input class="input" data-hero="' + i + '" maxlength="24" value="' + h((c.hero_lines || [])[i] || "") + '">'; }).join("") + "</div>" +
      '<div class="field"><span class="label">Colors</span><div class="row" style="gap:16px;flex-wrap:wrap">' + [["cP", "Main", th.primary], ["cA", "Accent", th.accent]].map(function (x) { return '<label class="sub" style="display:flex;gap:8px;align-items:center"><input id="' + x[0] + '" type="color" value="' + h(x[2] || "#e10f1c") + '" style="width:48px;height:40px;border:0;background:none">' + x[1] + "</label>"; }).join("") +
      '<div class="seg" role="group" aria-label="Light or dark"><button type="button" data-mode="dark" aria-pressed="' + (th.mode !== "light") + '">Dark</button><button type="button" data-mode="light" aria-pressed="' + (th.mode === "light") + '">Light</button></div></div></div>' +
      '<div class="field"><span class="label">Packages</span><div id="pks" style="display:flex;flex-direction:column;gap:8px">' + pk.map(pkgBlock).join("") + "</div>" + (pk.length < 6 ? '<button type="button" class="btn small soft" id="pkAdd" style="align-self:flex-start">Add a package</button>' : "") + "</div>" +
      '<div class="field"><span class="label">Team package</span><label class="li" style="border-radius:14px;border:1px solid var(--line);cursor:pointer"><input type="checkbox" class="switch" id="tShow"' + (tt.show ? " checked" : "") + '><div class="grow name" style="font-size:15px">Show it</div></label><div style="display:grid;grid-template-columns:2fr 1fr;gap:8px"><input class="input" id="tName" maxlength="40" value="' + h(tt.name) + '" aria-label="Team package name"><input class="input" id="tPrice" type="number" min="5" max="20000" value="' + h(tt.price) + '" aria-label="Team price"></div><input class="input" id="tDesc" maxlength="160" value="' + h(tt.desc) + '" aria-label="Team description"></div>' +
      field("eFt", "Footer line", 'type="text" maxlength="120"', c.footer_note) +
      field("eCe", "Creator's email", 'type="email"', c.creator_email) +
      '<label class="li" style="border-radius:14px;border:1px solid var(--line);cursor:pointer"><input type="checkbox" class="switch" id="eU18"' + (c.under_18 ? " checked" : "") + '><div class="grow name" style="font-size:15px">Under 18</div></label>' +
      field("eGe", "Parent or guardian's email", 'type="email"', c.guardian_email) +
      field("eCm", "Camera body", 'type="text" maxlength="60"', c.camera) +
      '<p id="eMsg" class="body" role="status"></p></div>' +
      '<div class="dock"><div class="dock-inner"><button type="button" class="btn block" id="eGo">Save</button><span class="note">Checked for banned words, colors and prices when you save.</span></div></div>');
    var mode = th.mode === "light" ? "light" : "dark";
    app().querySelectorAll("[data-mode]").forEach(function (b) { b.addEventListener("click", function () { mode = b.dataset.mode; app().querySelectorAll("[data-mode]").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); }); }); });
    var add = document.getElementById("pkAdd");
    if (add) add.addEventListener("click", function () {
      var box = document.getElementById("pks"), n = box.children.length;
      if (n >= 6) return;
      box.insertAdjacentHTML("beforeend", pkgBlock({ name: "", price: 49, desc: "", features: [] }, n));
    });
    document.getElementById("eGo").addEventListener("click", async function () {
      var btn = this, msg = document.getElementById("eMsg"), v = function (x) { return document.getElementById(x).value.trim(); };
      var feat = (app().querySelector('input[name="feat"]:checked') || {}).value;
      var packages = Array.prototype.map.call(app().querySelectorAll("[data-pk]"), function (el, i) {
        var g = function (f) { return el.querySelector('[data-f="' + f + '"]').value; };
        return { id: (pk[i] && pk[i].id) || g("name"), name: g("name").trim(), price: Number(g("price")), desc: g("desc").trim(), features: g("features").split("\n").map(function (s) { return s.trim(); }).filter(Boolean), featured: String(i) === feat };
      }).filter(function (k) { return k.name; });
      var body = {
        brand_name: v("eBn"), handle: v("eHd"), location: v("eLc"), tagline: v("eTg"),
        hero_lines: Array.prototype.map.call(app().querySelectorAll("[data-hero]"), function (x) { return x.value.trim(); }),
        theme: { primary: document.getElementById("cP").value, accent: document.getElementById("cA").value, mode: mode, bg: mode === "light" ? "#ffffff" : "#0a0a0a", bgCard: mode === "light" ? "#f2f2f2" : "#1a1a1a", text: mode === "light" ? "#111111" : "#f5f5f5" },
        packages: packages,
        team_tier: { show: document.getElementById("tShow").checked, name: v("tName"), price: Number(v("tPrice")), desc: v("tDesc") },
        footer_note: v("eFt"), creator_email: v("eCe"), under_18: document.getElementById("eU18").checked, guardian_email: v("eGe"), camera: v("eCm"),
      };
      if (c.page_status === "live" && !t.isOwner()) { ["brand_name", "handle", "location", "tagline", "hero_lines", "theme", "packages", "team_tier", "footer_note"].forEach(function (k) { delete body[k]; }); }
      btn.disabled = true;
      try {
        var r = await t.post("/api/creators/" + encodeURIComponent(c.id), body, "PATCH");
        var b = (r.checks || []).filter(function (x) { return x.level === "block"; }).length;
        t.toast(b ? "Saved. " + b + " thing" + (b > 1 ? "s" : "") + " to fix before the page can go live." : "Saved.");
        t.go("#creator/" + c.id);
      } catch (e) {
        btn.disabled = false;
        var list = (e.data && e.data.checks || []).filter(function (x) { return x.level === "block"; }).map(function (x) { return "<li>" + h(x.message) + "</li>"; }).join("");
        msg.innerHTML = '<span class="err">' + h(say(e)) + "</span>" + (list ? '<ul class="body err" style="margin:6px 0 0;padding-left:20px">' + list + "</ul>" : "");
      }
    });
  }

  // ── An event ───────────────────────────────────────────────────────────
  var CSV_COLS = [["date", "Date"], ["event", "Event"], ["package", "Package"], ["amount", "Amount"], ["creator_share", "Creator share"], ["platform_share", "Platform share"], ["buyer_name", "Buyer"], ["buyer_email", "Email"], ["buyer_phone", "Phone"], ["team_jersey", "Team and jersey"], ["instagram", "Instagram"], ["crew", "Crew"], ["status", "Status"], ["consent_public", "OK to post"], ["mode", "Mode"]];
  var CSV_DEFAULT = ["date", "event", "package", "amount", "creator_share", "buyer_name", "buyer_email", "team_jersey", "instagram", "crew", "status", "consent_public", "mode"];

  async function cevent(arg) {
    var t = T();
    var parts = String(arg || "").split("/"), cid = parts[0], eid = parts[1];
    if (!t.hasTool("creators")) return t.go("#tools");
    t.show(null, '<div class="screen">' + t.backBtn("#creator/" + cid, "Creator") + '<div class="spin"></div></div>');
    var mem = t.atLeast("member");
    var res = await Promise.all([t.api("/api/creators/" + encodeURIComponent(cid)), mem ? t.api("/api/creators/" + encodeURIComponent(cid) + "/orders?event=" + encodeURIComponent(eid)) : Promise.resolve({ orders: [], stages: [] })]);
    var d = res[0], c = d.creator, ev = (d.events || []).find(function (e) { return e.id === eid; });
    if (!ev) return t.go("#creator/" + cid);
    var orders = res[1].orders || [], stages = (res[1].stages || []).filter(function (s) { return s !== "Refunded"; });
    var crew = (d.crew || []).filter(function (m) { return m.active; });
    var qr = "/api/creators/" + encodeURIComponent(cid) + "/events/" + encodeURIComponent(eid) + "/qr.svg";
    var rows = orders.map(function (o) {
      return '<div class="li" style="cursor:default;flex-wrap:wrap"><div class="grow"><div class="name" style="font-size:15px">' + h(o.buyer_name || "Buyer") + ' <span class="sub">· ' + h(o.package_name) + "</span></div><div class=\"sub\">" + h([o.team_jersey, o.instagram ? "@" + String(o.instagram).replace(/^@/, "") : "", o.crew_code ? "crew " + o.crew_code : "", o.consent_public ? "OK to post" : "Deliver only", o.mode === "test" ? "TEST" : ""].filter(Boolean).join(" · ")) + '</div></div><span class="sub" style="font-weight:700;color:var(--ink)">' + h(money(o.amount_cents)) + '</span><select class="input" data-order="' + h(o.id) + '" style="width:auto;min-height:36px;padding:2px 8px;font-size:14px" aria-label="Status">' + stages.map(function (s) { return '<option' + (s === o.status ? " selected" : "") + ">" + s + "</option>"; }).join("") + "</select></div>";
    }).join("");
    t.show(null,
      '<div class="screen">' + t.backBtn("#creator/" + cid, c.brand_name) +
      '<div><p class="kicker">' + h([dateWords(ev.event_date), ev.sport, ev.venue].filter(Boolean).join(" · ")) + '</p><h1 class="title sm">' + h(ev.name) + '</h1><p class="sub">Event code ' + h(ev.code) + (ev.status !== "upcoming" ? " · " + h(ev.status) : "") + "</p></div>" +
      (c.page_status !== "live" ? '<div class="card tight"><div class="row"><span class="badge warn">Page not live</span><span class="sub grow">The QR works once Kyron approves the page.</span></div></div>' : "") +
      '<section class="card" style="align-items:center;text-align:center"><img src="' + h(qr) + '" alt="QR code for this event" width="220" height="220" style="background:#fff;border-radius:12px;padding:8px"><div class="mono sub" style="word-break:break-all">' + h(ev.page_url) + '</div><div class="btn-row" style="flex-wrap:wrap;justify-content:center"><a class="btn small" href="#tool/ccard:' + h(cid) + ":" + h(eid) + '">Print card</a><button type="button" class="btn small soft" id="evCopy">Copy link</button><a class="btn small soft" href="' + h(qr) + '" download="' + h(c.slug + "-" + ev.code) + '.svg">Save QR</a></div>' +
      (crew.length ? '<p class="sub" style="margin:0">Crew cards credit each person\'s sales:</p><div class="btn-row" style="flex-wrap:wrap;justify-content:center">' + crew.map(function (m) { return '<a class="btn small ghost" href="#tool/ccard:' + h(cid) + ":" + h(eid) + ":" + h(m.code) + '">' + h(String(m.name).split(/\s+/)[0]) + "</a>"; }).join("") + "</div>" : "") + "</section>" +
      '<section class="sec"><h2 class="sec-h">Sales · ' + h(ev.totals.orders) + " · " + h(money(ev.totals.sales_cents)) + "</h2>" +
      (mem ? (rows ? '<div class="list">' + rows + "</div>" : '<p class="empty">No sales yet.</p>') : '<p class="empty">Members see buyers and orders.</p>') + "</section>" +
      (mem ? '<details class="card tight"><summary class="name" style="font-size:15px;cursor:pointer">Sales CSV for this event</summary><div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 10px;margin-top:10px">' + CSV_COLS.map(function (x) { return '<label class="sub" style="display:flex;gap:8px;align-items:center;min-height:36px"><input type="checkbox" data-col="' + x[0] + '"' + (CSV_DEFAULT.indexOf(x[0]) >= 0 ? " checked" : "") + ">" + h(x[1]) + "</label>"; }).join("") + '</div><a class="btn" id="csvGo" href="#">Download CSV</a><p class="sub" style="margin:0">It has buyers\' contact details. Keep it off shared drives.</p></details>' : "") +
      (mem && ev.status === "upcoming" ? '<button type="button" class="btn ghost" id="evDone">Mark the event done</button>' : "") +
      '<p id="evMsg" class="body" role="status"></p></div>');
    document.getElementById("evCopy").addEventListener("click", function () { t.copy(null, ev.page_url); });
    var csv = document.getElementById("csvGo");
    if (csv) {
      var setHref = function () {
        var cols = Array.prototype.filter.call(app().querySelectorAll("[data-col]"), function (x) { return x.checked; }).map(function (x) { return x.dataset.col; });
        csv.href = "/api/creators/" + encodeURIComponent(cid) + "/orders.csv?event=" + encodeURIComponent(eid) + "&columns=" + encodeURIComponent(cols.join(","));
      };
      setHref();
      app().querySelectorAll("[data-col]").forEach(function (x) { x.addEventListener("change", setHref); });
    }
    app().querySelectorAll("[data-order]").forEach(function (sel) {
      sel.addEventListener("change", async function () {
        try { await t.post("/api/creators/" + encodeURIComponent(cid) + "/orders/" + encodeURIComponent(sel.dataset.order), { status: sel.value }, "PATCH"); t.toast("Marked " + sel.value + "."); } catch (e) { t.toast(say(e)); }
      });
    });
    var done = document.getElementById("evDone");
    if (done) done.addEventListener("click", async function () {
      try { await t.post("/api/creators/" + encodeURIComponent(cid) + "/events/" + encodeURIComponent(eid), { status: "done" }, "PATCH"); t.toast("Marked done."); cevent(arg); } catch (e) { t.toast(say(e)); }
    });
  }

  window.TOJScreens = Object.assign(window.TOJScreens || {}, { creators: creators, cnew: cnew, creator: creator, cedit: cedit, cevent: cevent });
})();
