/* Ground Floor Sports · the asset library in the TOJ app. Registers screens
 * for app.js's router (the API is routes/gfs-assets.js; the rules,
 * utils/gfs-assets.js):
 *
 *   #gfs-assets               every asset in your regions, and each stop's clips
 *   #gfs-assets/<event id>    one stop's assets and clips
 *   #gfs-asset-new[/<event>]  a new asset
 *   #gfs-asset/<id>           one asset: athletes, where it lives, checks, rights, moving it along
 *
 * Athletes are team and jersey number, never a name. Files stay where they
 * are; a record keeps where, under an ID or a label.
 */
(function () {
  "use strict";
  var T = function () { return window.TOJ; };
  var h = function (s) { return T().h(s); };
  var app = function () { return document.getElementById("app"); };
  var meta = null;

  var MSG = {
    not_on_team: "You don't have Pylon events. Ask Kyron.",
    role_too_low: "Your role can't do that.",
    region_not_yours: "That region isn't one of yours.",
    not_found: "That asset isn't here, or it isn't in your regions.",
    gfs_assets_not_set_up: "The asset library isn't set up on the server yet (migration 027).",
    gfs_asset_blocked: "It isn't ready yet. See what's blocking it.",
    gfs_asset_live_location: "Say where it lives first.",
    gfs_asset_file_required: "Record the file where it goes live first: the place and its ID or label. It locks once it's in review.",
    gfs_asset_check_in_review: "This check is recorded once it's in review. Send it to review first.",
    gfs_asset_locked: "Only a draft changes. Send it back to draft first.",
    gfs_asset_source_world: "Pick a venue World from the same stop.",
    conflict: "Someone changed this at the same moment. Try again.",
    athlete: "Pick athletes from the stop's roster.",
    links: "Leave out links. Where the file lives goes under Where it lives.",
    link_host: "A brand link goes to Canva, Figma, Adobe or groundfloorsports.com.",
    gfs_asset_retired: "It's retired. Make a new one instead.",
    gfs_asset_no_athletes: "This kind of asset never shows athletes.",
    gfs_asset_one_athlete: "A Moment or a Narrative NFT shows exactly one athlete.",
    gfs_asset_not_on_roster: "That athlete isn't on this stop's roster.",
    gfs_asset_stage: "It can't move there from where it is.",
    gfs_asset_keep: "Only a draft can be deleted. Retire it instead.",
    gfs_asset_in_use: "A World Pass is made from this World.",
    gfs_asset_fixed: "What it is and which stop it's from don't change.",
    confirm_checklist: "Confirm the checklist first.",
    check_owner_only: "Kyron records the Consent to Mint.",
    check_not_for_this_asset: "That check isn't for this kind of asset.",
    link_brand_only: "Only a brand asset can be a link, and it starts with https://.",
    ref: "Use an ID or a label: letters, numbers, dots, colons and hyphens. No spaces or slashes.",
    location_required: "Pick where it lives.",
    location: "Pick where it lives.",
    sha256: "That isn't a SHA-256: 64 letters and numbers.",
    contact_details: "Leave out email addresses and phone numbers.",
    title_required: "Give it a title.",
    title_too_long: "Use 80 characters or fewer.",
    note_too_long: "Keep the note under 300 characters.",
    format: "Pick one of the listed formats.",
    price: "Use a price between $1 and $1,000.",
    source_world: "Pick a venue World from the same stop.",
    event_required: "Pick the stop it's from.",
    national_needs_approver: "Only approvers make national brand assets. Pick a region.",
    kind_required: "Pick what kind of asset it is.",
    reason: "Pick why it's retired.",
    invalid_asset: "Check the details and try again.",
  };
  function say(e) {
    var d = e && e.data;
    var code = d && d.error;
    return (code && MSG[code]) || (d && d.hint) || (e && e.message) || "Something went wrong.";
  }
  var BLOCK = {
    takedown: function (a) { return a + " has a takedown."; },
    do_not_publish: function (a) { return a + " is marked do not publish."; },
    no_capture_consent: function (a) { return a + " has no capture consent on the roster."; },
    roster_changed: function (a) { return a + " changed number or team on the roster since they were added. Check it's the same athlete, then take them out and add them again."; },
    no_3d_consent: function (a) { return a + " has no 3D permission on the roster."; },
    under_13: function (a) { return a + " may be under 13 (no verified age, or a 12-and-under division). A Moment needs verifiable parental consent, which isn't tracked yet."; },
    no_nft_consent: function (a) { return a + " has no Narrative NFT permission on the roster."; },
    no_marketing_consent: function (a) { return a + " has no marketing consent, so an edit can't feature them."; },
    no_sale_consent: function (a) { return a + " has no sale consent, so an edit with them can't be listed on SportsClippers."; },
    not_public: function (a) { return a + " isn't set for public display, or may be under 13, so an edit with them can't be listed on SportsClippers."; },
    one_athlete: function () { return "A Moment or a Narrative NFT shows exactly one athlete. Add them."; },
    venue_permission: function () { return "Record the venue's signed permission (Pylon I-2)."; },
    deidentified: function () { return "An approver confirms every other player is blurred or masked."; },
    tier4: function () { return "An approver confirms the family's Tier 4 consent is on the CFR record."; },
    illinois_hold: function () { return "No AI reconstruction of people at Illinois stops until counsel clears BIPA."; },
    mint_consent: function () { return "Kyron records the signed Consent to Mint."; },
    marks_licensed: function () { return "An approver records the sponsor's licence for its marks."; },
    price: function () { return "Set a fixed price."; },
    source_world: function () { return "Pick the venue World it's an edition of. That World has to be published first."; },
    school_venue: function () { return "It's a school venue, and school stadiums are never sold."; },
  };
  function athleteName(a) { return a ? (a.team ? a.team + " " : "") + "#" + (a.jersey || "?") : "An athlete"; }
  function blockText(b) { var f = BLOCK[b.code]; return f ? f(athleteName(b.athlete)) : b.code.replace(/_/g, " "); }

  async function getMeta() {
    if (!meta) meta = await T().api("/api/gfs/assets/meta");
    return meta;
  }
  function svg(path, size) { return '<svg viewBox="0 0 24 24" width="' + (size || 20) + '" height="' + (size || 20) + '" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + "</svg>"; }
  var ICON = {
    edit: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/>', 22),
    venue_world: svg('<path d="M3 18 12 6l9 12z"/><path d="M7.5 18 12 12l4.5 6"/>', 22),
    moment: svg('<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12 4 7.5M12 12l8-4.5M12 12v9"/>', 22),
    world_pass: svg('<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M15 6v12" stroke-dasharray="2 2"/>', 22),
    narrative_nft: svg('<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path d="m9 12 2 2 4-4"/>', 22),
    brand: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v9M7.5 12h9"/>', 22),
    clips: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4l2 5M14 4l2 5"/>', 22),
    lib: svg('<path d="M4 5h4v14H4zM10 5h4v14h-4z"/><path d="m16 6 3.5-1 2.5 13.5-3.5 1z"/>', 22),
  };

  function badge(text, kind) { return '<span class="badge' + (kind ? " " + kind : "") + '">' + h(text) + "</span>"; }
  function day(d) { return d ? new Date(String(d).slice(0, 10) + "T12:00:00Z").toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric" }) : ""; }
  function span(ev) { return !ev ? "" : ev.starts_on === ev.ends_on ? day(ev.starts_on) : day(ev.starts_on) + "–" + day(ev.ends_on); }
  function money(c) { return c == null ? "" : "$" + (c / 100).toFixed(c % 100 ? 2 : 0); }
  function head(kicker, title, right, lede) {
    return '<div class="head"><div class="grow"><p class="ws">Ground Floor Sports · Pylon</p>' + (kicker ? '<p class="kicker">' + h(kicker) + "</p>" : "") + '<h1 class="title' + (title.length > 18 ? " sm" : "") + '">' + h(title) + "</h1>" + (lede ? '<p class="lede">' + h(lede) + "</p>" : "") + "</div>" + (right || "") + "</div>";
  }
  function guard() {
    if (!T().hasTool("gfs")) { T().go("#tools"); return false; }
    return true;
  }
  function loading(back) { T().show(null, '<div class="screen">' + (back || "") + '<div class="spin" aria-label="Loading"></div></div>'); }
  function stageBadge(a) {
    if (a.needs_retiring) return badge("Needs retiring", "bad");
    if (a.stage === "retired") return badge("Retired", "");
    if (a.stage === "live") return badge(a.stage_name, "ok");
    if (a.held) return badge("On hold", "line");
    if (a.stage === "approved") return badge("Approved", "gold");
    if (a.stage === "review") return badge("In review", "warn");
    return badge("Draft", "");
  }
  function failedScreen(e, back) {
    T().show(null, '<div class="screen">' + (back || T().backBtn("#events", "Events")) + '<p class="body err">' + h(say(e)) + "</p></div>");
  }

  // ── The library ────────────────────────────────────────────────────────
  var kindFilter = "";
  async function library(eventId) {
    if (!guard()) return;
    var t = T();
    loading(t.backBtn(eventId ? "#event/" + eventId : "#events", eventId ? "Event plan" : "Events"));
    var m, d;
    try {
      m = await getMeta();
      d = await t.api("/api/gfs/assets" + (eventId ? "?event=" + encodeURIComponent(eventId) : ""));
    } catch (e) { if (e.stale) throw e; return failedScreen(e); }
    var list = d.assets.filter(function (a) { return !kindFilter || a.kind === kindFilter; });
    var stop = eventId && d.stops[0];
    // Group by stop, newest stop first; brand assets with no stop last.
    var groups = {}, order = [];
    d.stops.forEach(function (s) { groups[s.id] = { stop: s, assets: [] }; order.push(s.id); });
    list.forEach(function (a) {
      var k = a.event ? a.event.id : "national";
      if (!groups[k]) { groups[k] = { stop: a.event ? { id: a.event.id, name: a.event.name, starts_on: a.event.starts_on, ends_on: a.event.ends_on, clips: null } : null, assets: [] }; order.push(k); }
      groups[k].assets.push(a);
    });
    order.sort(function (x, y) {
      if (x === "national") return 1; if (y === "national") return -1;
      return String((groups[y].stop || {}).starts_on).localeCompare(String((groups[x].stop || {}).starts_on));
    });
    function row(a) {
      var sub = [a.kind_name + (a.format ? " · " + (m.formats[a.format] || a.format) : ""), a.athletes.length ? a.athletes.map(athleteName).join(", ") : null, a.kind === "world_pass" && a.price_cents != null ? money(a.price_cents) : null].filter(Boolean).join(" · ");
      return '<a class="li" href="#gfs-asset/' + h(a.id) + '"><div class="ico" style="width:40px;height:40px;border-radius:11px">' + (ICON[a.kind] || ICON.lib) + '</div><div class="grow"><div class="name" style="font-size:15px">' + h(a.title) + '</div><div class="sub">' + h(sub) + "</div></div>" + stageBadge(a) + "</a>";
    }
    function clipsRow(s) {
      if (!s || !s.clips) return "";
      var c = s.clips;
      var parts = [c.shot + " shot", c.approved + " approved", c.delivered + c.listed ? (c.delivered + " to families · " + c.listed + " listed") : null, c.held ? c.held + " held" : null].filter(Boolean).join(" · ");
      return '<a class="li" href="#gfs-deliver/' + h(s.id) + '"><div class="ico" style="width:40px;height:40px;border-radius:11px">' + ICON.clips + '</div><div class="grow"><div class="name" style="font-size:15px">Clips</div><div class="sub">' + h(parts) + "</div></div>" + (c.needs_removal ? badge(c.needs_removal + " to take down", "bad") : t.I.chev) + "</a>";
    }
    var sections = order.map(function (k) {
      var g = groups[k];
      var rows = clipsRow(g.stop) + g.assets.map(row).join("");
      if (!rows) return "";
      var title = g.stop ? g.stop.name : "National brand assets";
      return '<section class="sec"><h2 class="sec-h">' + h(title) + (g.stop ? " · " + h(span(g.stop)) : "") + '</h2><div class="list">' + rows + "</div></section>";
    }).filter(Boolean).join("");
    var kinds = Object.keys(m.kinds);
    var chips = '<div class="chips" role="group" aria-label="Kind"><button type="button" class="chip" data-kind="" aria-pressed="' + (!kindFilter) + '">All</button>' +
      kinds.map(function (k) { return '<button type="button" class="chip" data-kind="' + h(k) + '" aria-pressed="' + (kindFilter === k) + '">' + h(m.kinds[k].name) + (d.totals.by_kind[k] ? " · " + d.totals.by_kind[k] : "") + "</button>"; }).join("") + "</div>";
    var alert = d.totals.needs_retiring ? '<section class="card" style="border-color:#5A3A33"><p class="body"><b style="color:var(--bad)">' + d.totals.needs_retiring + (d.totals.needs_retiring === 1 ? " asset is" : " assets are") + " live and lost a permission or got a takedown.</b> Take the file down where it lives, then retire it here. A takedown isn't done while one is still live.</p></section>" : "";
    var lede = d.totals.all ? d.totals.all + (d.totals.all === 1 ? " asset" : " assets") + (d.totals.held ? " · " + d.totals.held + " on hold" : "") : "Every edit, 3D World, Moment, World Pass, Narrative NFT and brand asset, with what it may be used for.";
    t.show(eventId ? null : "events",
      '<div class="screen">' + (eventId ? t.backBtn("#event/" + eventId, "Event plan") : "") +
      head(stop ? stop.name : null, "Asset library", t.atLeast("member") ? '<a class="btn small" href="#gfs-asset-new' + (eventId ? "/" + h(eventId) : "") + '">' + t.I.plus.replace("<svg", '<svg width="16" height="16"') + "New</a>" : "", lede) +
      alert + chips +
      (sections || '<p class="empty">Nothing here yet. A stop\'s clips show up once its upload log is in; add an edit, a World, a Moment, a World Pass, an NFT or a brand asset with New.</p>') +
      "</div>");
    app().querySelectorAll("[data-kind]").forEach(function (b) { b.addEventListener("click", function () { kindFilter = b.dataset.kind; library(eventId); }); });
  }

  // ── A new asset ────────────────────────────────────────────────────────
  async function newAsset(eventId) {
    if (!guard()) return;
    var t = T();
    if (!t.atLeast("member")) return t.go("#gfs-assets");
    var back = t.backBtn(eventId ? "#gfs-assets/" + eventId : "#gfs-assets", "Cancel");
    loading(back);
    var m, evs;
    try {
      m = await getMeta();
      evs = (await t.api("/api/gfs/events")).events;
    } catch (e) { if (e.stale) throw e; return failedScreen(e, back); }
    var kind = "edit";
    function draw() {
      var k = m.kinds[kind];
      var evOptions = evs.map(function (ev) { return '<option value="' + h(ev.id) + '"' + (ev.id === eventId ? " selected" : "") + ">" + h(ev.name + " · " + span(ev)) + "</option>"; }).join("");
      var regions = m.you.regions.map(function (r) { return '<option value="' + h(r) + '">' + h(m.regions[r]) + "</option>"; }).join("");
      t.show(null,
        '<div class="screen">' + back + head(null, "New asset", "", "Pick what it is. You'll add athletes, where it lives and the checks next.") +
        '<div class="list" role="radiogroup" aria-label="Kind">' + Object.keys(m.kinds).map(function (key) {
          return '<button type="button" class="li" role="radio" aria-checked="' + (key === kind) + '" data-pick="' + h(key) + '" style="' + (key === kind ? "background:#1A2C45" : "") + '"><div class="ico" style="width:40px;height:40px;border-radius:11px">' + ICON[key] + '</div><div class="grow"><div class="name" style="font-size:15px">' + h(m.kinds[key].name) + '</div><div class="sub">' + h(m.kinds[key].what) + "</div></div>" + (key === kind ? '<span style="color:var(--gold)">' + t.I.check + "</span>" : "") + "</button>";
        }).join("") + "</div>" +
        '<label class="field"><span class="label">Title <small>no names, links or contact details</small></span><input class="input" id="naTitle" maxlength="80" placeholder="' + h(kind === "venue_world" ? "Dallas 2027 · Stadium World" : kind === "world_pass" ? "Dallas 2027 · Stadium World edition" : kind === "brand" ? "Pylon end card" : kind === "moment" ? "Catch on field 3" : kind === "narrative_nft" ? "First touchdown · day one" : "Recap · day one") + '"></label>' +
        (k.formats.length ? '<label class="field"><span class="label">Format</span><select class="input" id="naFormat"><option value="">Pick one</option>' + k.formats.map(function (f) { return '<option value="' + h(f) + '">' + h(m.formats[f] || f) + "</option>"; }).join("") + "</select></label>" : "") +
        '<label class="field"><span class="label">Stop</span><select class="input" id="naEvent">' + (kind === "brand" ? '<option value="">No stop</option>' : "") + evOptions + "</select></label>" +
        (kind === "brand" ? '<label class="field" id="naRegionRow"><span class="label">Region <small>for a brand asset with no stop</small></span><select class="input" id="naRegion">' + (t.atLeast("approver") ? '<option value="">National</option>' : "") + regions + "</select></label>" : "") +
        '<p id="naMsg" class="body" role="status"></p></div>' +
        '<div class="dock"><div class="dock-inner"><button type="button" class="btn block" id="naGo">Make the draft</button></div></div>');
      app().querySelectorAll("[data-pick]").forEach(function (b) { b.addEventListener("click", function () { kind = b.dataset.pick; draw(); }); });
      document.getElementById("naGo").addEventListener("click", async function (e) {
        var btn = e.currentTarget;
        btn.disabled = true;
        var ev = document.getElementById("naEvent").value;
        var body = { kind: kind, title: document.getElementById("naTitle").value, event_id: ev || null };
        var f = document.getElementById("naFormat");
        if (f && f.value) body.format = f.value;
        var rg = document.getElementById("naRegion");
        if (!ev && rg && rg.value) body.region = rg.value;
        try {
          var r = await t.post("/api/gfs/assets", body);
          t.go("#gfs-asset/" + r.asset.id);
        } catch (err) {
          btn.disabled = false;
          document.getElementById("naMsg").innerHTML = '<span class="err">' + h(say(err)) + "</span>";
        }
      });
    }
    draw();
  }

  // ── One asset ──────────────────────────────────────────────────────────
  async function asset(id) {
    if (!guard()) return;
    var t = T();
    loading(t.backBtn("#gfs-assets", "Asset library"));
    var m, a;
    try {
      m = await getMeta();
      a = (await t.api("/api/gfs/assets/" + encodeURIComponent(id))).asset;
    } catch (e) { if (e.stale) throw e; return failedScreen(e, t.backBtn("#gfs-assets", "Asset library")); }
    var member = t.atLeast("member");
    var k = m.kinds[a.kind];
    var backTo = a.event ? "#gfs-assets/" + a.event.id : "#gfs-assets";

    function msg(text, ok) { var el = document.getElementById("asMsg"); if (el) el.innerHTML = text ? '<span class="' + (ok ? "okc" : "err") + '">' + h(text) + "</span>" : ""; }
    async function call(fn, okText) {
      try { var r = await fn(); if (r && r.asset) a = r.asset; draw(); if (okText) t.toast(okText); }
      catch (e) {
        if (e.stale) return;
        if (e.data && e.data.blocks) { a.blocks = e.data.blocks; a.ready = false; draw(); }
        msg(say(e));
      }
    }

    function draw() {
      var blocks = a.blocks || [];
      var items = blocks.map(blockText);
      if (a.stage === "draft" && !a.file_ready) items.push("Record the file where it goes live (Where it lives, below) before you send it to review.");
      var blockCard = a.stage === "retired" ? "" :
        member ? (items.length ? '<section class="card" style="' + (a.needs_retiring ? "border-color:#5A3A33" : "") + '"><h2 class="sec-h">' + (a.needs_retiring ? "Live, and it shouldn't be" : "Before it can go out") + '</h2><ul style="margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px;font-size:14.5px;line-height:1.45;color:var(--ink-2)">' + items.map(function (x) { return "<li>" + h(x) + "</li>"; }).join("") + "</ul>" + (a.needs_retiring ? '<p class="sub" style="margin:0">Take the file down where it lives, then retire it here.</p>' : "") + "</section>" : (a.stage === "draft" || a.stage === "review" ? '<p class="sub" style="margin:0;color:var(--ok)">' + t.I.check + " Nothing's blocking it.</p>" : "")) :
        (a.held ? '<p class="body">On hold. A director can say why.</p>' : "");

      var athletes = k.athletes === "none" ? "" :
        '<section class="sec"><h2 class="sec-h">' + (k.athletes === "one" ? "The athlete" : "Athletes it features") + "</h2>" +
        (a.athletes.length ? '<div class="list">' + a.athletes.map(function (x) {
          return '<div class="li" style="cursor:default"><div class="grow"><div class="name" style="font-size:15px">' + h(athleteName(x)) + (x.position ? ' <span class="sub">' + h(x.position) + "</span>" : "") + "</div>" + (x.roster_id ? '<div class="sub">Roster ' + h(x.roster_id) + "</div>" : "") + "</div>" +
            (a.can.edit ? '<button type="button" class="btn small ghost" data-drop="' + h(x.roster_row) + '">Take out</button>' : "") + "</div>";
        }).join("") + "</div>" : '<p class="empty">' + (a.stage === "retired" && k.athletes === "one" ? "Cleared when it was retired." : k.athletes === "one" ? "Nobody yet. A " + k.name + " shows one athlete." : "Nobody yet.") + "</p>") +
        (a.can.edit && (k.athletes === "many" || !a.athletes.length) ? '<button type="button" class="btn soft small" id="asPick" style="align-self:flex-start">Add an athlete</button><div id="asPicker"></div>' : "") +
        "</section>";

      var details = a.can.edit ?
        '<section class="sec"><h2 class="sec-h">Details</h2>' +
        '<label class="field"><span class="label">Title</span><input class="input" id="asTitle" maxlength="80" value="' + h(a.title) + '"></label>' +
        (k.formats.length ? '<label class="field"><span class="label">Format</span><select class="input" id="asFormat"><option value="">Pick one</option>' + k.formats.map(function (f) { return '<option value="' + h(f) + '"' + (a.format === f ? " selected" : "") + ">" + h(m.formats[f] || f) + "</option>"; }).join("") + "</select></label>" : "") +
        (a.kind === "world_pass" ? '<label class="field"><span class="label">Price <small>fixed, in dollars</small></span><input class="input" id="asPrice" inputmode="decimal" value="' + (a.price_cents == null ? "" : h((a.price_cents / 100).toFixed(2))) + '"></label>' +
          '<label class="field"><span class="label">The venue World it\'s an edition of</span><select class="input" id="asSource"><option value="">Pick a World</option></select></label>' : "") +
        (a.kind === "venue_world" ? '<label class="check"><span class="grow"><b style="font-size:15px">A school venue</b><span class="sub" style="display:block">School stadiums are never sold.</span></span><input type="checkbox" class="switch" id="asSchool"' + (a.school_venue ? " checked" : "") + "></label>" : "") +
        (a.kind === "edit" || a.kind === "brand" ? '<label class="check"><span class="grow"><b style="font-size:15px">Carries a sponsor\'s marks</b><span class="sub" style="display:block">' + (a.format === "sponsor" ? "A sponsor asset always does, so the sponsor's licence has to be on file." : "Then the sponsor's licence has to be on file.") + '</span></span><input type="checkbox" class="switch" id="asMarks"' + (a.sponsor_marks || a.format === "sponsor" ? " checked" : "") + (a.format === "sponsor" ? " disabled" : "") + "></label>" : "") +
        '<label class="field"><span class="label">Note <small>optional; no names, links or contact details</small></span><input class="input" id="asNote" maxlength="300" value="' + h(a.note || "") + '"></label>' +
        '<button type="button" class="btn soft" id="asSave">Save details</button></section>' :
        (a.kind === "world_pass" && a.price_cents != null ? '<p class="body">' + h(money(a.price_cents)) + (a.source ? " · an edition of " + h(a.source.title) : "") + "</p>" : "") +
        (a.note && member ? '<p class="body">' + h(a.note) + "</p>" : "");

      var allowed = Object.keys(m.locations).filter(function (l) { return l !== "link" || a.kind === "brand"; });
      var where = member ?
        '<section class="sec"><h2 class="sec-h">Where it lives</h2>' +
        (a.can.place ? '<label class="field"><span class="label">Place</span><select class="input" id="asLoc"><option value="">Not yet</option>' + allowed.map(function (l) { return '<option value="' + h(l) + '"' + (a.location === l ? " selected" : "") + ">" + h(m.locations[l]) + (k.live.indexOf(l) >= 0 ? "" : " (not where it goes live)") + "</option>"; }).join("") + "</select></label>" +
          '<label class="field"><span class="label">' + (a.location === "link" ? "Link <small>Canva, Figma, Adobe or groundfloorsports.com</small>" : "ID or label there <small>no spaces or slashes; a label like Dallas2027-WR-11-EndZone-042</small>") + '</span><input class="input" id="asRef" maxlength="300" autocomplete="off" value="' + h(a.ref || "") + '"></label>' +
          '<label class="field"><span class="label">SHA-256 <small>optional, the file\'s fingerprint</small></span><input class="input mono" id="asSha" maxlength="64" autocomplete="off" spellcheck="false" style="font:13px var(--mono)" value="' + h(a.sha256 || "") + '"></label>' +
          '<button type="button" class="btn soft" id="asPlace">Save where it lives</button>' +
          '<p class="sub" style="margin:0">Record it where it goes live before you send it to review. It locks there, so what\'s approved is what goes out.</p>'
          : '<p class="body">' + (a.location ? h(m.locations[a.location]) + (a.ref ? " · " + h(a.ref) : "") : "Not recorded.") + "</p>" +
            (a.sha256 ? '<p class="sub mono" style="margin:0;font:12px var(--mono);word-break:break-all">SHA-256 ' + h(a.sha256) + "</p>" : "") +
            (a.stage !== "draft" && a.stage !== "retired" ? '<p class="sub" style="margin:0">Locked since review. To change the file, send it back to draft.</p>' : "")) +
        '<p class="sub" style="margin:0">Where it goes live: ' + h(k.live.map(function (l) { return m.locations[l]; }).join(", ")) + ".</p></section>" : "";

      var checkKeys = Object.keys(a.checks || {});
      var checks = checkKeys.length ? '<section class="sec"><h2 class="sec-h">Checks</h2>' + checkKeys.map(function (c) {
        var x = a.checks[c];
        var who = m.checks[c].role === "owner" ? "Kyron records this in review." : m.checks[c].role === "approver" ? "An approver records this in review." : "A director records this.";
        return '<label class="check"><span class="grow"><b style="font-size:14.5px">' + h(m.checks[c].name) + '</b><span class="sub" style="display:block">' + (x.on ? "Recorded" + (x.by ? " by " + h(x.by) : "") + " · " + h(t.ago(x.at)) : h(who)) + "</span></span>" +
          '<input type="checkbox" class="switch" data-check="' + h(c) + '"' + (x.on ? " checked" : "") + (x.can ? "" : " disabled") + "></label>";
      }).join("") + (a.stage === "draft" || a.stage === "review" ? '<p class="sub" style="margin:0">Checks an approver or Kyron records belong to this review. Going back to draft clears them.</p>' : "") + "</section>" : "";

      var stageLine = [a.approved ? "Approved by " + a.approved.by + " · " + t.ago(a.approved.at) : null, a.live_at ? k.liveLabel + " · " + t.ago(a.live_at) : null, a.retired ? "Retired · " + (m.retire_reasons[a.retired.reason] || a.retired.reason) + " · " + t.ago(a.retired.at) : null].filter(Boolean).join(" · ");
      var moves = a.can.moves || [];
      var actions = [];
      if (moves.indexOf("review") >= 0) actions.push('<button type="button" class="btn" data-move="review">Send to review</button>');
      if (moves.indexOf("approved") >= 0) actions.push('<button type="button" class="btn" id="asApprove">Approve</button>');
      if (moves.indexOf("live") >= 0) actions.push('<button type="button" class="btn" data-move="live">' + h(k.liveLabel === "Out" ? "Mark it out" : "Mark " + k.liveLabel.toLowerCase()) + "</button>");
      if (moves.indexOf("draft") >= 0) actions.push('<button type="button" class="btn soft" data-move="draft">Back to draft</button>');
      var retire = moves.indexOf("retired") >= 0 ? '<details class="card tight"' + (a.needs_retiring ? " open" : "") + '><summary class="sub" style="cursor:pointer">Retire it</summary><div style="display:flex;flex-direction:column;gap:10px;margin-top:10px"><select class="input" id="asReason"><option value="">Why</option>' + Object.keys(m.retire_reasons).map(function (r) { return '<option value="' + h(r) + '">' + h(m.retire_reasons[r]) + "</option>"; }).join("") + '</select>' + (a.kind === "moment" || a.kind === "narrative_nft" ? '<p class="sub" style="margin:0">Retiring clears where the file was, the title, the note and the athlete from this record. It stays retired.</p>' : '<p class="sub" style="margin:0">It stays retired.</p>') + '<button type="button" class="btn danger" id="asRetire">Retire</button></div></details>' : "";

      t.show(null,
        '<div class="screen">' + t.backBtn(backTo, a.event ? "Stop's assets" : "Asset library") +
        head(k.name + (a.format ? " · " + (m.formats[a.format] || a.format) : ""), a.title, stageBadge(a), a.event ? a.event.name + " · " + span(a.event) : a.region ? m.regions[a.region] + " · brand" : "National · brand") +
        (stageLine ? '<p class="sub" style="margin:0">' + h(stageLine) + "</p>" : "") +
        blockCard + athletes + details + where + checks +
        '<section class="card tight"><h2 class="sec-h">Rights</h2><p class="body">' + h(k.rights) + "</p></section>" +
        retire +
        (a.can.delete ? '<button type="button" class="btn ghost" id="asDelete">Delete this draft</button>' : "") +
        '<p id="asMsg" class="body" role="status"></p></div>' +
        (actions.length ? '<div class="dock"><div class="dock-inner"><div class="btn-row">' + actions.join("") + "</div></div></div>" : ""));
      wire();
    }

    function wire() {
      var base = "/api/gfs/assets/" + encodeURIComponent(a.id);
      var save = document.getElementById("asSave");
      if (save) {
        var src = document.getElementById("asSource");
        var sourceLoaded = false;
        if (src) t.api("/api/gfs/assets?event=" + encodeURIComponent(a.event.id) + "&kind=venue_world").then(function (r) {
          src.innerHTML = '<option value="">Pick a World</option>' + r.assets.map(function (w) { return '<option value="' + h(w.id) + '"' + (a.source && a.source.id === w.id ? " selected" : "") + ">" + h(w.title + " · " + w.stage_name) + "</option>"; }).join("");
          sourceLoaded = true;
        }).catch(function () {});
        save.addEventListener("click", function () {
          var val = function (id) { var el = document.getElementById(id); return el ? el.value : undefined; };
          var box = function (id) { var el = document.getElementById(id); return el && !el.disabled ? el.checked : undefined; };
          var d = detailsPatch(a, { title: val("asTitle"), note: val("asNote"), format: val("asFormat"), price: val("asPrice"), source: val("asSource"), sourceLoaded: sourceLoaded, school: box("asSchool"), marks: box("asMarks") });
          if (d.error) return msg(MSG[d.error] || say({ data: { error: d.error } }));
          if (!Object.keys(d.body).length) return t.toast("Nothing changed.");
          call(function () { return t.post(base, d.body, "PATCH"); }, "Saved.");
        });
      }
      var place = document.getElementById("asPlace");
      if (place) place.addEventListener("click", function () {
        call(function () { return t.post(base, { location: document.getElementById("asLoc").value || null, ref: document.getElementById("asRef").value, sha256: document.getElementById("asSha").value }, "PATCH"); }, "Saved.");
      });
      app().querySelectorAll("[data-check]").forEach(function (box) {
        box.addEventListener("change", function () {
          var on = box.checked;
          call(function () { return t.post(base + "/check", { check: box.dataset.check, on: on }); }, on ? "Recorded." : "Cleared.");
        });
      });
      app().querySelectorAll("[data-drop]").forEach(function (b) {
        b.addEventListener("click", function () { call(function () { return t.post(base, { athletes: { remove: [b.dataset.drop] } }, "PATCH"); }); });
      });
      var pick = document.getElementById("asPick");
      if (pick) pick.addEventListener("click", async function () {
        pick.disabled = true;
        var box = document.getElementById("asPicker");
        try {
          var r = await t.api(base + "/roster");
          var rows = r.athletes.filter(function (x) { return !x.in_asset; });
          if (!rows.length) { box.innerHTML = '<p class="empty">No roster for this stop yet, or everyone on it is already here. Load the Sports Thread roster first.</p>'; return; }
          box.innerHTML = '<label class="field" style="margin-top:8px"><span class="label">Find by jersey or team</span><input class="input" id="asFind" inputmode="search" autocomplete="off"></label><div class="list" id="asRows" style="margin-top:8px"></div>';
          var WHY = { takedown: "takedown", do_not_publish: "do not publish", no_capture_consent: "no capture consent", roster_changed: "roster changed", no_3d_consent: "no 3D permission", under_13: "may be under 13", no_nft_consent: "no NFT permission", no_marketing_consent: "no marketing consent" };
          function list(q) {
            var hits = rows.filter(function (x) { return !q || String(x.jersey || "") === q.replace(/^#/, "") || String(x.team || "").toLowerCase().indexOf(q.toLowerCase()) >= 0; }).slice(0, 40);
            document.getElementById("asRows").innerHTML = hits.map(function (x) {
              return '<button type="button" class="li" data-add="' + h(x.roster_row) + '"><div class="grow"><div class="name" style="font-size:15px">' + h(athleteName(x)) + (x.position ? ' <span class="sub">' + h(x.position) + "</span>" : "") + '</div><div class="sub">' + (x.can ? "Can be in it" : h(x.why.map(function (w) { return WHY[w] || w; }).join(", "))) + "</div></div>" + (x.can ? badge("OK", "ok") : badge("Blocked", "line")) + "</button>";
            }).join("") || '<p class="empty" style="padding:12px">No match.</p>';
            app().querySelectorAll("[data-add]").forEach(function (b) {
              b.addEventListener("click", function () { call(function () { return t.post(base, { athletes: { add: [b.dataset.add] } }, "PATCH"); }); });
            });
          }
          list("");
          document.getElementById("asFind").addEventListener("input", function (e) { list(e.target.value.trim()); });
        } catch (e) { if (!e.stale) msg(say(e)); }
        pick.disabled = false;
      });
      app().querySelectorAll("[data-move]").forEach(function (b) {
        b.addEventListener("click", function () {
          var to = b.dataset.move;
          // The file was recorded before review and goes out as it is.
          var body = { to: to };
          b.disabled = true;
          call(function () { return t.post(base + "/stage", body); }, to === "review" ? "Sent to review." : to === "draft" ? "Back to draft." : k.liveLabel + ".").then(function () { b.disabled = false; });
        });
      });
      var approve = document.getElementById("asApprove");
      if (approve) approve.addEventListener("click", function () {
        var box = document.getElementById("asConfirm");
        if (!box) {
          approve.insertAdjacentHTML("beforebegin", '<label class="check" id="asConfirm" style="grid-column:1/-1;flex-basis:100%"><span class="grow" style="font-size:14px;line-height:1.4">' + h(k.checklist) + '</span><input type="checkbox" class="switch" id="asConfirmBox" aria-label="I checked this"></label>');
          approve.textContent = "Approve: I checked it";
          return;
        }
        if (!document.getElementById("asConfirmBox").checked) return msg("Confirm the checklist first.");
        call(function () { return t.post(base + "/stage", { to: "approved", confirm: true }); }, "Approved.");
      });
      var retire = document.getElementById("asRetire");
      if (retire) retire.addEventListener("click", function () {
        var reason = document.getElementById("asReason").value;
        if (!reason) return msg("Pick why it's retired.");
        if (!retire.dataset.armed) { retire.dataset.armed = "1"; retire.textContent = "Tap again to retire"; return; }
        call(function () { return t.post(base + "/retire", { reason: reason }); }, "Retired.");
      });
      var del = document.getElementById("asDelete");
      if (del) del.addEventListener("click", async function () {
        if (!del.dataset.armed) { del.dataset.armed = "1"; del.textContent = "Tap again to delete"; return; }
        try { await t.post(base, {}, "DELETE"); t.toast("Deleted."); t.go(backTo); } catch (e) { if (!e.stale) msg(say(e)); }
      });
    }
    draw();
  }

  // What Save details sends: only what changed, and never a field the screen
  // hasn't read yet (the World list loads after the screen does). A price
  // that isn't a number is an error, not a cleared price.
  function detailsPatch(a, form) {
    var body = {};
    if (form.title !== undefined && form.title !== a.title) body.title = form.title;
    if (form.note !== undefined && String(form.note || "") !== String(a.note || "")) body.note = form.note;
    if (form.format !== undefined && (form.format || null) !== (a.format || null)) body.format = form.format || null;
    if (form.price !== undefined) {
      var raw = String(form.price).replace(/[$,\s]/g, "");
      var cents = raw === "" ? null : Math.round(Number(raw) * 100);
      if (raw !== "" && !isFinite(cents)) return { error: "price" };
      if (cents !== (a.price_cents == null ? null : a.price_cents)) body.price_cents = cents;
    }
    if (form.source !== undefined && form.sourceLoaded) {
      var current = a.source ? a.source.id : null;
      if ((form.source || null) !== current) body.source_asset_id = form.source || null;
    }
    if (form.school !== undefined && form.school !== !!a.school_venue) body.school_venue = form.school;
    if (form.marks !== undefined && form.marks !== !!a.sponsor_marks) body.sponsor_marks = form.marks;
    return { body: body };
  }

  window.TOJAssets = { detailsPatch: detailsPatch };
  window.TOJScreens = Object.assign(window.TOJScreens || {}, {
    "gfs-assets": library,
    "gfs-asset-new": newAsset,
    "gfs-asset": asset,
  });
})();
