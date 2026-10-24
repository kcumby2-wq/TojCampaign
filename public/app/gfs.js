/* Ground Floor Sports · Pylon events in the TOJ app. Registers screens for
 * app.js's router (the API is routes/gfs.js; the rules, utils/gfs.js):
 *
 *   #events                      events in your regions
 *   #gfs-new                     a new event
 *   #event/<id>                  the plan: checklist, crew, deliverables
 *   #gfs-edit/<id>               edit the event
 *   #gfs-crew/<id>               crew: who's on it, who can be
 *   #gfs-roster/<id>             load the Sports Thread roster
 *   #gfs-live/<id>               live: the upload log, counts, crew
 *   #gfs-tags/<id>               tag review by jersey number
 *   #gfs-deliver/<id>            Schedule C deliverables, clips to families and SportsClippers
 *   #gfs-takedown/<id>           log a takedown for an athlete at this event
 *   #gfs-desk                    the Distribution desk (every event; wide)
 *   #gfs-creators                creator scorecards and the pool
 *   #gfs-creator/<id|new>        a creator (screening: owner only)
 *
 * Athletes appear as team and jersey number, never by name; the roster file
 * keeps only ID, team, division, jersey, position and permission columns
 * before it leaves this device.
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
    credentials: "Not screened for this event yet.",
    credentials_owner_only: "Kyron records contracts, background checks and training.",
    already_on_crew: "They're already on this crew.",
    crew_youth_needs_adult: "A youth creator works only alongside a confirmed adult on site.",
    crew_youth_left_alone: "A youth creator is confirmed. Confirm another adult first.",
    crew_youth_role: "A youth creator shoots or shadows; never leads or edits.",
    gfs_featured_consent: "An athlete it features is missing capture or marketing consent, or is on hold.",
    featured_required: "Name the athletes it features first, so their consent can be checked.",
    gfs_deliverable_nothing_new: "Log what's new before sending it to approval.",
    gfs_deliverable_short: "Log the full count before marking it done.",
    gfs_deliverable_below_approved: "That's fewer than what's already approved.",
    in_review: "It's with an approver right now.",
    not_for_approval: "This one doesn't post on Pylon's channels. Mark it done.",
    needs_approval: "This one posts on Pylon's channels, so an approver clears it.",
    note_required: "Say what needs to change.",
    gfs_clip_already_out: "That clip has reached families or SportsClippers. Log a takedown instead.",
    gfs_not_set_up: "Pylon events aren't set up on the server yet (migration 024).",
    roster_columns: "That file needs a roster ID column and a team column.",
    upload_columns: "That file needs a path or file name column.",
    csv_required: "Paste the file or choose one first.",
    not_on_this_roster: "That athlete isn't on this event's roster.",
    athlete_required: "Pick the athlete.",
    size_fixed: "The size is fixed. Cancel the event and make a new one.",
    invalid_event: "Check the highlighted fields.",
    regions_required: "Pick at least one region for a Regional Director.",
  };
  var PROBLEM = { creator_not_active: "Not active", no_contract: "No signed contract", background_check: "Background check missing or over a year old", safety_training: "Safety training missing or over a year old", youth_role: "Youth creators shoot or shadow only" };
  var WHY = { no_number: "Number unreadable", not_on_roster: "Number isn't on the roster", team_not_on_roster: "Team isn't on the roster", two_teams: "Same number on both teams", duplicate_number: "Two athletes share this number", no_roster: "No roster loaded yet" };
  var HOLD = { takedown: "Takedown", do_not_publish: "Do not publish", no_capture_consent: "No capture consent" };
  var BLOCK = { no_marketing_consent: "no marketing consent", no_capture_consent: "no capture consent", do_not_publish: "do not publish", takedown: "takedown", not_on_roster: "not on this roster" };

  function say(e) {
    var d = e && e.data;
    var code = d && d.error;
    if (code === "credentials" && d.problems) return "Can't crew them: " + d.problems.map(function (p) { return PROBLEM[p] || p; }).join(", ").toLowerCase() + ".";
    if (code === "gfs_featured_consent" && d.blocks) return "Can't clear it: " + d.blocks.map(function (b) { return (b.team ? b.team + " " : "") + "#" + b.jersey + " (" + (BLOCK[b.why] || b.why) + ")"; }).join(", ") + ".";
    return (code && MSG[code]) || (d && d.hint) || (e && e.message) || "Something went wrong.";
  }
  async function getMeta() {
    if (!meta) meta = await T().api("/api/gfs/meta");
    return meta;
  }
  function rname(k) { return (meta && meta.regions && meta.regions[k]) || k || ""; }
  function badge(text, kind) { return '<span class="badge' + (kind ? " " + kind : "") + '">' + h(text) + "</span>"; }
  function svg(path, size) { return '<svg viewBox="0 0 24 24" width="' + (size || 20) + '" height="' + (size || 20) + '" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + "</svg>"; }
  var ICON = {
    cal: svg('<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>', 22),
    crew: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><circle cx="17" cy="9" r="2.8"/><path d="M16 14.6c2.7.2 4.6 1.9 5.3 4.9"/>', 22),
    live: svg('<circle cx="12" cy="12" r="3"/><path d="M6.3 6.3a8 8 0 0 0 0 11.4M17.7 6.3a8 8 0 0 1 0 11.4"/>', 22),
    tag: svg('<path d="M3 12V4h8l9 9-8 8z"/><circle cx="7.5" cy="8.5" r="1.4"/>', 22),
    box: svg('<path d="m3 7 9-4 9 4-9 4z"/><path d="M3 7v10l9 4 9-4V7"/>', 22),
    list: svg('<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>', 22),
    stop: svg('<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>', 22),
    up: svg('<path d="M12 16V4M7 9l5-5 5 5"/><path d="M5 20h14"/>', 22),
    desk: svg('<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>', 22),
    check: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  };

  // Dates: event days are plain dates; deadlines show in the event's own zone.
  function day(d, o) {
    if (!d) return "";
    return new Date(String(d).slice(0, 10) + "T12:00:00Z").toLocaleDateString(undefined, Object.assign({ timeZone: "UTC" }, o || { weekday: "short", month: "short", day: "numeric" }));
  }
  function span(ev) { return ev.starts_on === ev.ends_on ? day(ev.starts_on) : day(ev.starts_on) + "–" + day(ev.ends_on, { month: "short", day: "numeric" }); }
  function whenIn(iso, tz) {
    if (!iso) return "";
    try { return new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: tz || undefined }); } catch (e) { return new Date(iso).toLocaleString(); }
  }
  function left(iso) {
    var ms = new Date(iso).getTime() - Date.now();
    var hrs = Math.abs(ms) / 3600000;
    var txt = hrs < 1 ? Math.max(1, Math.round(hrs * 60)) + " MIN" : hrs < 48 ? Math.round(hrs) + "H" : Math.round(hrs / 24) + "D";
    return { text: ms < 0 ? txt + " LATE" : txt, late: ms < 0, hours: ms / 3600000 };
  }
  // Calendar days from today, counted where the event happens (an 8 p.m.
  // look at tomorrow's event in Ohio is still "tomorrow", whatever UTC says).
  function todayIn(tz) {
    try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz || undefined, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
    catch (e) { var n = new Date(); return n.getFullYear() + "-" + String(n.getMonth() + 1).padStart(2, "0") + "-" + String(n.getDate()).padStart(2, "0"); }
  }
  function daysUntil(dateStr, tz) {
    return Math.round((Date.parse(String(dateStr).slice(0, 10) + "T00:00:00Z") - Date.parse(todayIn(tz) + "T00:00:00Z")) / 86400000);
  }
  function pct(v) { return v === null || v === undefined ? "—" : Math.round(v * 100) + "%"; }
  function head(kicker, title, right, lede) {
    return '<div class="head"><div class="grow"><p class="ws">Ground Floor Sports · Pylon</p>' + (kicker ? '<p class="kicker">' + h(kicker) + "</p>" : "") + '<h1 class="title' + (title.length > 18 ? " sm" : "") + '">' + h(title) + "</h1>" + (lede ? '<p class="lede">' + h(lede) + "</p>" : "") + "</div>" + (right || "") + "</div>";
  }
  function guard() {
    if (!T().hasTool("gfs")) { T().go("#tools"); return false; }
    return true;
  }
  function loading(tab, back) { T().show(tab === undefined ? "events" : tab, '<div class="screen">' + (back || "") + '<div class="spin" aria-label="Loading"></div></div>'); }
  function bind(sel, ev, fn) { app().querySelectorAll(sel).forEach(function (el) { el.addEventListener(ev, function (e) { fn(el, e); }); }); }
  function msgEl(id, text, ok) { var m = document.getElementById(id); if (m) m.innerHTML = '<span class="' + (ok ? "okc" : "err") + '">' + h(text) + "</span>"; }
  async function act(btn, fn, msgId) {
    btn.disabled = true;
    try { await fn(); } catch (e) { btn.disabled = false; if (msgId) msgEl(msgId, say(e)); else T().toast(say(e)); }
  }
  function readFile(input) {
    return new Promise(function (resolve, reject) {
      var f = input.files && input.files[0];
      if (!f) return resolve("");
      if (f.size > 2 * 1024 * 1024) return reject(new Error("That file is over 2 MB."));
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result || "")); };
      r.onerror = function () { reject(new Error("Couldn't read that file.")); };
      r.readAsText(f);
    });
  }
  function download(path, name) {
    var a = document.createElement("a");
    a.href = path;
    a.download = name || "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ── Status of an event, for lists ──────────────────────────────────────
  function eventStatus(ev, checklist) {
    if (ev.status === "cancelled") return ["Cancelled", ""];
    if (ev.status === "closed") return ["Done", "ok"];
    if (ev.status === "wrapped") return ["Delivering", "warn"];
    var d0 = daysUntil(ev.starts_on, ev.tz), d1 = daysUntil(ev.ends_on, ev.tz);
    if (d0 <= 0 && d1 >= 0) return ["Live", "gold"];
    if (d1 < 0) return ["Delivering", "warn"];
    var crew = (checklist || []).find(function (c) { return c.key === "crew"; });
    if (d0 === 1) return ["Tomorrow", "gold"];
    if (crew && !crew.confirmed && d0 <= 45) return ["No crew", "line"];
    return ["Planning", ""];
  }
  function dateBox(d) {
    return '<div class="datebox"><b>' + h(day(d, { day: "numeric" })) + "</b><span>" + h(day(d, { month: "short" }).toUpperCase()) + "</span></div>";
  }
  function regionChips(regions, current, all) {
    return '<div class="chips" role="group" aria-label="Region">' + (all ? '<button type="button" class="chip" data-region="" aria-pressed="' + (!current) + '">All</button>' : "") +
      regions.map(function (r) { return '<button type="button" class="chip" data-region="' + h(r) + '" aria-pressed="' + (current === r) + '">' + h(rname(r)) + "</button>"; }).join("") + "</div>";
  }

  // ── Events ─────────────────────────────────────────────────────────────
  var eventsRegion = "";
  async function events() {
    if (!guard()) return;
    loading();
    var t = T();
    await getMeta();
    var d = await t.api("/api/gfs/events" + (eventsRegion ? "?region=" + encodeURIComponent(eventsRegion) : ""));
    var mine = meta.you.regions;
    var rows = d.events.map(function (ev) {
      var st = eventStatus(ev, ev.checklist);
      var crew = ev.checklist.find(function (c) { return c.key === "crew"; });
      var sub = [rname(ev.region), ev.director && ev.director.name, "crew " + crew.confirmed + " of " + crew.target, ev.ready + " of 4 ready"].filter(Boolean).join(" · ");
      return '<a class="li" href="#event/' + h(ev.id) + '">' + dateBox(ev.starts_on) + '<div class="grow"><div class="name" style="font-size:15.5px">' + h(ev.name) + '</div><div class="sub">' + h(sub) + "</div></div>" + badge(st[0], st[1]) + "</a>";
    }).join("");
    var series = {};
    d.events.forEach(function (e) { if (e.series) series[e.series] = (series[e.series] || 0) + 1; });
    var lede = Object.keys(series).length ? Object.keys(series).map(function (k) { return k + " · " + series[k]; }).join(" · ") : "Every event in your regions.";
    t.show("events",
      '<div class="screen">' +
      head(null, "Events", t.atLeast("member") ? '<a class="btn small" href="#gfs-new">' + t.I.plus.replace("<svg", '<svg width="16" height="16"') + "New</a>" : "", lede) +
      (mine.length > 1 ? regionChips(mine, eventsRegion, true) : "") +
      (rows ? '<div class="list">' + rows + "</div>" : '<p class="empty">No events here yet. Pylon sends its calendar about 90 days ahead; each stop lands here with its director.</p>') +
      '<div class="tile-grid">' +
      '<a class="tile" href="#gfs-desk">' + ICON.desk + "Distribution desk</a>" +
      '<a class="tile" href="#gfs-creators">' + ICON.crew + "Creator scorecards</a>" +
      "</div>" +
      (mine.length ? "" : '<p class="empty">You don\'t have a region yet. Ask Kyron to add one.</p>') +
      "</div>");
    bind("[data-region]", "click", function (b) { eventsRegion = b.dataset.region; events(); });
  }

  // ── New and edit ───────────────────────────────────────────────────────
  var TZS = ["America/New_York", "America/Detroit", "America/Indiana/Indianapolis", "America/Chicago", "America/Denver", "America/Boise", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"];
  function input(id, label, attrs, value, hint) {
    return '<div class="field"><label class="label" for="' + id + '">' + label + "</label>" + (hint ? '<span class="sub" style="margin-top:-4px">' + h(hint) + "</span>" : "") + '<input class="input" id="' + id + '" ' + (attrs || 'type="text"') + ' value="' + h(value == null ? "" : value) + '"></div>';
  }
  function eventForm(ev, isNew) {
    var regions = meta.you.regions;
    var sizes = Object.keys(meta.sizes);
    var C = { premier: "3 on site · 6 cut-downs a day · 150 stills · 12 Top Performers", one_day: "2 on site · 3 cut-downs · 40 stills · 4 Top Performers", clinic: "1 on site · 2 cut-downs · 25 stills · no Winner Montage" };
    return input("evName", "Name", 'type="text" maxlength="120" placeholder="Girls Flag · Geneva, OH"', ev.name) +
      input("evSeries", "Series <small>(optional)</small>", 'type="text" maxlength="60" list="seriesList" placeholder="Legacy Tour"', ev.series) +
      '<datalist id="seriesList"><option value="Legacy Tour"><option value="Girls Flag"></datalist>' +
      (isNew ? '<div class="field"><span class="label">Size <small>(Schedule C)</small></span><div role="radiogroup" aria-label="Size" style="display:flex;flex-direction:column;gap:8px">' +
        sizes.map(function (s) { return '<button type="button" role="radio" class="radio" data-size="' + s + '" aria-checked="' + (ev.size === s) + '"><span class="r"></span><span><b style="display:block;font-size:15.5px">' + h(meta.sizes[s]) + '</b><span class="sub">' + h(C[s]) + "</span></span></button>"; }).join("") + "</div></div>" : "") +
      '<div class="field"><span class="label">Region</span>' + (regions.length ? '<div class="chips" role="radiogroup" aria-label="Region" style="flex-wrap:wrap;margin:0;padding:0">' + regions.map(function (r) { return '<button type="button" role="radio" class="chip" data-reg="' + r + '" aria-pressed="' + (ev.region === r) + '">' + h(rname(r)) + "</button>"; }).join("") + "</div>" : '<p class="sub err">You don\'t have a region yet.</p>') + "</div>" +
      '<div style="display:grid;grid-template-columns:minmax(0,1fr) 92px;gap:10px">' + input("evCity", "City", 'type="text" maxlength="80"', ev.city) + input("evState", "State", 'type="text" maxlength="2" autocapitalize="characters" placeholder="OH"', ev.state) + "</div>" +
      input("evVenue", "Venue <small>(optional)</small>", 'type="text" maxlength="120"', ev.venue) +
      '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px">' + input("evStart", "First day", 'type="date"', ev.starts_on) + input("evEnd", "Last day", 'type="date"', ev.ends_on) + "</div>" +
      '<div style="display:grid;grid-template-columns:110px minmax(0,1fr);gap:10px">' + input("evWrap", "Wraps at", 'type="time"', ev.wraps_at || "18:00") +
      '<div class="field"><label class="label" for="evTz">Time zone</label><select class="input" id="evTz">' + TZS.concat(ev.tz && TZS.indexOf(ev.tz) < 0 ? [ev.tz] : []).map(function (z) { return '<option value="' + z + '"' + (ev.tz === z ? " selected" : "") + ">" + h(z.replace(/^America\//, "").replace(/_/g, " ")) + "</option>"; }).join("") + "</select></div></div>" +
      '<p class="sub" style="margin:-8px 0 0">Deadlines run from the wrap time on the last day: 12 hours for full games, 48 and 72 hours for edits.</p>' +
      input("evCrew", "Crew on site per day", 'type="number" min="0" max="30" inputmode="numeric"', ev.crew_target) +
      (T().atLeast("approver") ? input("evDir", "Director's email <small>(optional)</small>", 'type="email" inputmode="email" autocomplete="off"', ev.director && ev.director.email) : "") +
      input("evStore", "Storefront page <small>(optional)</small>", 'type="url" inputmode="url" placeholder="https://"', ev.storefront_url, "The event's QR code points here.");
  }
  function readForm(ev) {
    var v = function (id) { var el = document.getElementById(id); return el ? el.value.trim() : undefined; };
    var body = { name: v("evName"), series: v("evSeries"), city: v("evCity"), state: (v("evState") || "").toUpperCase(), venue: v("evVenue"), starts_on: v("evStart"), ends_on: v("evEnd") || v("evStart"), wraps_at: v("evWrap"), tz: v("evTz"), storefront_url: v("evStore") };
    if (ev.size) body.size = ev.size;
    if (ev.region) body.region = ev.region;
    var crew = v("evCrew");
    if (crew !== "" && crew !== undefined) body.crew_target = Number(crew);
    if (document.getElementById("evDir")) body.director_email = v("evDir");
    return body;
  }
  function wireForm(ev) {
    bind("[data-size]", "click", function (b) { ev.size = b.dataset.size; app().querySelectorAll("[data-size]").forEach(function (x) { x.setAttribute("aria-checked", String(x === b)); }); var c = document.getElementById("evCrew"); if (c && !c.dataset.touched) c.value = meta.crew_target[ev.size]; });
    bind("[data-reg]", "click", function (b) { ev.region = b.dataset.reg; app().querySelectorAll("[data-reg]").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); }); });
    var st = document.getElementById("evState");
    if (st) st.addEventListener("change", function () { var z = meta.state_tz[st.value.trim().toUpperCase()]; var sel = document.getElementById("evTz"); if (z && sel) { if (![].some.call(sel.options, function (o) { return o.value === z; })) sel.insertAdjacentHTML("beforeend", '<option value="' + z + '">' + h(z) + "</option>"); sel.value = z; } });
    var c = document.getElementById("evCrew");
    if (c) c.addEventListener("input", function () { c.dataset.touched = "1"; });
    var s = document.getElementById("evStart"), e = document.getElementById("evEnd");
    if (s && e) s.addEventListener("change", function () { if (!e.value || e.value < s.value) e.value = s.value; });
  }
  async function gfsNew() {
    if (!guard() || !T().atLeast("member")) return T().go("#events");
    await getMeta();
    var ev = { size: "one_day", region: meta.you.regions.length === 1 ? meta.you.regions[0] : "", crew_target: meta.crew_target.one_day, tz: "America/Chicago", wraps_at: "18:00" };
    T().show(null, '<div class="screen"><div class="head"><a class="back" href="#events">' + T().I.back + "Cancel</a></div>" + head(null, "New event") + eventForm(ev, true) + '<p id="evMsg" class="body" role="status"></p></div>' +
      '<div class="dock"><div class="dock-inner"><button type="button" class="btn block" id="evGo">Add the event</button><span class="note">It comes with every Schedule C deliverable and its deadline.</span></div></div>');
    wireForm(ev);
    document.getElementById("evGo").addEventListener("click", function () {
      var btn = this;
      act(btn, async function () {
        var body = readForm(ev);
        if (!body.region) throw Object.assign(new Error("Pick a region."), {});
        var d = await T().post("/api/gfs/events", body);
        T().toast("Added. The deliverables and their deadlines are in.");
        T().go("#event/" + d.event.id);
      }, "evMsg");
    });
  }
  async function gfsEdit(id) {
    if (!guard() || !T().atLeast("member")) return T().go("#event/" + id);
    loading(null);
    await getMeta();
    var d = await T().api("/api/gfs/events/" + encodeURIComponent(id));
    var ev = d.event;
    T().show(null, '<div class="screen"><div class="head"><a class="back" href="#event/' + h(id) + '">' + T().I.back + "Cancel</a></div>" + head(ev.size_name, "Edit event") + eventForm(ev, false) +
      '<section class="sec"><h2 class="sec-h">Status</h2><div class="seg" role="group" aria-label="Status">' + ["planning", "live", "wrapped", "closed"].map(function (s) { return '<button type="button" data-status="' + s + '" aria-pressed="' + (ev.status === s) + '">' + { planning: "Planning", live: "Live", wrapped: "Delivering", closed: "Done" }[s] + "</button>"; }).join("") + "</div>" +
      '<button type="button" class="btn danger small" id="evCancel" style="align-self:flex-start">' + (ev.status === "cancelled" ? "Cancelled" : "Cancel this event") + "</button></section>" +
      '<p id="evMsg" class="body" role="status"></p></div>' +
      '<div class="dock"><div class="dock-inner"><button type="button" class="btn block" id="evGo">Save</button></div></div>');
    wireForm(ev);
    var status = ev.status;
    bind("[data-status]", "click", function (b) { status = b.dataset.status; app().querySelectorAll("[data-status]").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); }); });
    var cancel = document.getElementById("evCancel");
    cancel.addEventListener("click", function () {
      if (ev.status === "cancelled") return;
      if (!cancel.dataset.armed) { cancel.dataset.armed = "1"; cancel.textContent = "Tap again to cancel the event"; return; }
      act(cancel, async function () { await T().post("/api/gfs/events/" + encodeURIComponent(id), { status: "cancelled" }, "PATCH"); T().toast("Cancelled."); T().go("#events"); }, "evMsg");
    });
    document.getElementById("evGo").addEventListener("click", function () {
      var btn = this;
      act(btn, async function () {
        var body = readForm(ev);
        delete body.size;
        if (status !== ev.status) body.status = status;
        await T().post("/api/gfs/events/" + encodeURIComponent(id), body, "PATCH");
        T().toast("Saved.");
        T().go("#event/" + id);
      }, "evMsg");
    });
  }

  // ── The event plan ─────────────────────────────────────────────────────
  var DUE = { storefront: "T-7", roster: "T-72H", brief: "T-48H", crew: "T-48H" };
  async function event(id) {
    if (!guard()) return;
    loading("events", T().backBtn("#events", "Events"));
    await getMeta();
    var t = T();
    var d = await t.api("/api/gfs/events/" + encodeURIComponent(id));
    var ev = d.event;
    var st = eventStatus(ev, d.checklist);
    var d0 = daysUntil(ev.starts_on, ev.tz);
    var when = d0 === 0 ? "Today" : d0 === 1 ? "Tomorrow" : d0 > 1 && d0 < 7 ? "In " + d0 + " days" : st[0];
    var ready = d.checklist.filter(function (c) { return c.done; }).length;
    var member = t.atLeast("member");
    var items = d.checklist.map(function (c) {
      var sub = c.key === "roster" ? (d.roster.athletes ? d.roster.athletes + " athletes on " + d.roster.teams + " teams · " + d.roster.do_not_publish + " do-not-publish" : "Sports Thread sends it 72 hours out") :
        c.key === "storefront" ? (ev.storefront_url ? "Assigned by athlete ID, jersey and team" : "Add the storefront link the QR code points to") :
        c.key === "brief" ? "From the Pylon production playbook" :
        (c.lead ? "" : "No lead yet · ") + "Tap to fill";
      var href = c.key === "crew" ? "#gfs-crew/" + ev.id : c.key === "roster" ? "#gfs-roster/" + ev.id : c.key === "storefront" ? "#gfs-edit/" + ev.id : null;
      var right = '<span class="sub mono" style="font-size:11px">' + DUE[c.key] + "</span>";
      var inner = '<span class="tick' + (c.done ? " on" : left(c.due_at).late ? " late" : "") + '">' + (c.done ? ICON.check : "") + '</span><div class="grow"><div class="name" style="font-size:15px">' + h(c.label) + '</div><div class="sub">' + h(sub) + "</div></div>" + right;
      if (c.key === "brief" && member) return '<button type="button" class="li" data-brief="' + (c.done ? "0" : "1") + '">' + inner + "</button>";
      return href ? '<a class="li" href="' + href + '">' + inner + "</a>" : '<div class="li" style="cursor:default">' + inner + "</div>";
    }).join("");
    var dl = d.deliverables;
    var cleared = dl.filter(function (x) { return x.cleared; }).length;
    var waiting = dl.filter(function (x) { return x.status === "submitted"; }).length;
    var late = dl.filter(function (x) { return x.late && !x.cleared; });
    var next = dl.filter(function (x) { return !x.cleared && x.required > 0; }).sort(function (a, b) { return a.due_at < b.due_at ? -1 : 1; })[0];
    var tds = d.takedowns.map(function (td) {
      var steps = [td.pylon_done_at, td.other_done_at, td.offsite_requested_at].filter(Boolean).length;
      var due = [td.pylon_done_at ? null : td.pylon_due_at, td.other_done_at ? null : td.other_due_at, td.offsite_requested_at ? null : td.offsite_due_at].filter(Boolean).sort()[0];
      var l = left(due);
      return '<a class="li" href="#gfs-desk"><span class="badge bad">' + h(l.text) + '</span><div class="grow"><div class="name" style="font-size:15px">Takedown' + (td.number ? " #" + td.number : "") + " · " + h(td.team || "") + '</div><div class="sub">' + h(td.reason_name) + " · " + steps + " of 3 steps done</div></div>" + t.I.chev + "</a>";
    }).join("");
    t.show("events",
      '<div class="screen">' + t.backBtn("#events", "Events") +
      head(when + " · " + ev.size_name, ev.name, member ? '<a class="btn small soft" href="#gfs-edit/' + h(ev.id) + '">Edit</a>' : "", span(ev) + " · " + rname(ev.region) + (ev.director ? " · " + (ev.director.you ? "you direct it" : "director " + (ev.director.name || ev.director.email || "")) : " · no director yet")) +
      (tds ? '<section class="sec"><h2 class="sec-h">Takedowns</h2><div class="list">' + tds + "</div></section>" : "") +
      '<section class="sec"><h2 class="sec-h">Before the event · ' + ready + " of 4 ready</h2><div class=\"list\">" + items + "</div></section>" +
      '<section class="card"><div class="row"><div class="ico">' + ICON.box + '</div><div class="grow"><div class="name">Owed to Pylon · ' + cleared + " of " + dl.length + ' cleared</div><div class="sub">' + h((waiting ? waiting + " waiting for an approver · " : "") + (late.length ? late.length + " late · " : "") + (next ? "next: " + next.name + ", " + whenIn(next.due_at, ev.tz) : "nothing due")) + '</div></div></div><div class="meter"><i style="width:' + Math.round((cleared / Math.max(1, dl.length)) * 100) + '%"></i></div><a class="btn soft small" href="#gfs-deliver/' + h(ev.id) + '" style="align-self:flex-start">Open deliverables</a></section>' +
      '<section class="card tight"><div class="name" style="font-size:15px">Capture standard</div><p class="sub" style="margin:0">Two angles or a game isn\'t covered: Sideline and End Zone, Eagle Eye where the venue allows. Full game at 1080p60. Footage uploads within 12 hours of the final whistle, clips named Jersey#-Angle-Clip#.</p></section>' +
      '<div class="tile-grid">' +
      '<a class="tile" href="#gfs-crew/' + h(ev.id) + '">' + ICON.crew + "Crew</a>" +
      '<a class="tile" href="#gfs-live/' + h(ev.id) + '">' + ICON.live + "Live console</a>" +
      '<a class="tile" href="#gfs-tags/' + h(ev.id) + '">' + ICON.tag + "Tag review" + (d.counts && d.counts.unmatched ? " · " + d.counts.unmatched : "") + "</a>" +
      (member ? '<a class="tile" href="#gfs-roster/' + h(ev.id) + '">' + ICON.list + "Roster and consent</a>" : '<a class="tile" href="#gfs-deliver/' + h(ev.id) + '">' + ICON.box + "Deliver</a>") +
      "</div>" +
      (member ? '<a class="li list" href="#gfs-takedown/' + h(ev.id) + '" style="border-radius:16px">' + '<div class="ico" style="width:36px;height:36px;border-radius:9px;color:var(--bad)">' + ICON.stop + '</div><div class="grow"><div class="name" style="font-size:15px">Log a takedown</div><div class="sub">A safety request or withdrawn consent starts its clock now</div></div>' + t.I.chev + "</a>" : "") +
      "</div>");
    bind("[data-brief]", "click", function (b) { act(b, async function () { await t.post("/api/gfs/events/" + encodeURIComponent(id), { brief_sent: b.dataset.brief === "1" }, "PATCH"); t.toast(b.dataset.brief === "1" ? "Marked: crew brief sent." : "Unmarked."); event(id); }); });
  }

  // ── Crew ───────────────────────────────────────────────────────────────
  var STATUS = { invited: ["Confirmation sent", ""], confirmed: ["Confirmed", "ok"], declined: ["Declined", "bad"], removed: ["Removed", ""] };
  async function crew(id) {
    if (!guard()) return;
    loading("events", T().backBtn("#event/" + id, "Event plan"));
    await getMeta();
    var t = T();
    var d = await t.api("/api/gfs/events/" + encodeURIComponent(id) + "/crew");
    var ev = d.event;
    var member = t.atLeast("member");
    var c = d.checklist.find(function (x) { return x.key === "crew"; });
    var rows = d.crew.map(function (r) {
      var cr = r.creator || {};
      var initial = (r.role_name || "?")[0];
      var actions = member && r.status !== "removed" ? '<select class="input" data-crew="' + h(r.id) + '" aria-label="Status for ' + h(cr.name) + '" style="width:auto;min-height:38px;padding:4px 8px;font-size:14px">' + ["invited", "confirmed", "declined", "removed"].map(function (s) { return '<option value="' + s + '"' + (r.status === s ? " selected" : "") + ">" + STATUS[s][0] + "</option>"; }).join("") + "</select>" : badge(STATUS[r.status][0], STATUS[r.status][1]);
      return '<div class="li" style="cursor:default"><span class="avatar" style="width:38px;height:38px;border-width:0;background:#22364F;font-size:13px">' + h(initial) + '</span><div class="grow"><div class="name" style="font-size:15px">' + h(cr.name || "Creator") + (cr.tier === "youth" ? ' <span class="badge warn">Youth</span>' : "") + '</div><div class="sub">' + h([r.role_name.toUpperCase(), r.note, cr.home_city].filter(Boolean).join(" · ")) + "</div></div>" + actions + "</div>";
    }).join("");
    var open = Math.max(0, c.target - c.confirmed);
    var cand = d.candidates.map(function (cr) {
      var blocked = cr.blocks.length > 0;
      var badges = cr.badges.map(function (b) { return badge(b.label, b.ok ? "ok" : "warn"); }).join("");
      var roles = Object.keys(meta.crew_roles).filter(function (r) { return cr.tier !== "youth" || meta.youth_roles.indexOf(r) >= 0; });
      return '<div class="card tight"><div class="row"><span class="avatar" style="width:38px;height:38px;border-width:0;background:#22364F;font-size:13px">' + h((cr.name || "?")[0]) + '</span><div class="grow"><div class="name" style="font-size:15px">' + h(cr.name) + '</div><div class="sub">' + h([cr.home_city, cr.nearby ? null : rname(cr.region), cr.lead_scout ? "lead scout" : null].filter(Boolean).join(" · ")) + "</div></div></div>" +
        '<div class="pill-row">' + badges + "</div>" +
        (member ? (blocked ? '<p class="sub" style="margin:0">Can\'t be crewed yet: ' + h(cr.blocks.map(function (p) { return PROBLEM[p] || p; }).join(", ").toLowerCase()) + ". Kyron records screening.</p>" :
          '<div class="row"><select class="input" data-role-for="' + h(cr.id) + '" aria-label="Role" style="flex:1;min-height:40px;padding:4px 10px;font-size:14.5px">' + roles.map(function (r) { return '<option value="' + r + '"' + (r === (c.lead ? "shooter" : "lead") && roles.indexOf(r) >= 0 ? " selected" : "") + ">" + h(meta.crew_roles[r]) + "</option>"; }).join("") + '</select><button type="button" class="btn small" data-assign="' + h(cr.id) + '">Assign</button></div>') : "") +
        "</div>";
    }).join("");
    t.show("events",
      '<div class="screen">' + t.backBtn("#event/" + id, "Event plan") +
      head(span(ev) + " · " + c.confirmed + " of " + c.target + " confirmed on site" + (open ? " · " + open + " open" : ""), "Crew") +
      '<section class="sec"><h2 class="sec-h">This event</h2>' + (rows ? '<div class="list">' + rows + "</div>" : '<p class="empty">No one yet. Schedule C wants ' + c.target + " named, screened operators on site, one of them the lead.</p>") + "</section>" +
      '<section class="sec"><h2 class="sec-h">Available · ' + h(rname(ev.region)) + " first</h2>" + (cand || '<p class="empty">No other creators in your regions. ' + (member ? '<a href="#gfs-creator/new">Add one</a>.' : "") + "</p>") + "</section>" +
      '<a class="li list" href="#gfs-creators" style="border-radius:16px"><div class="grow"><div class="name" style="font-size:15px">' + h(rname(ev.region)) + ' scorecards</div><div class="sub">On time, two angles, usable film, family rating</div></div>' + t.I.chev + "</a>" +
      '<p class="sub" style="margin:0">Directors set their own crews and rotations. A youth creator shoots alongside a confirmed adult, never alone with a minor. Pylon event day rate: $[150] per event day (Scout Agreement, Schedule A).</p>' +
      '<p id="crMsg" class="body" role="status"></p></div>');
    bind("[data-assign]", "click", function (b) {
      var role = app().querySelector('[data-role-for="' + b.dataset.assign + '"]').value;
      act(b, async function () { await t.post("/api/gfs/events/" + encodeURIComponent(id) + "/crew", { creator_id: b.dataset.assign, role: role }); t.toast("Added. Confirm them once they say yes."); crew(id); }, "crMsg");
    });
    bind("[data-crew]", "change", function (s) {
      t.post("/api/gfs/events/" + encodeURIComponent(id) + "/crew/" + encodeURIComponent(s.dataset.crew), { status: s.value }, "PATCH").then(function () { t.toast("Saved."); crew(id); }).catch(function (e) { msgEl("crMsg", say(e)); crew(id); });
    });
  }

  // ── Roster ─────────────────────────────────────────────────────────────
  // Keep only the columns the server uses, so names, birth dates and contact
  // details never leave this device.
  function keepRosterColumns(text) {
    var norm = function (s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); };
    var allowed = {};
    Object.keys(meta.roster_columns).forEach(function (k) { meta.roster_columns[k].forEach(function (n) { allowed[n] = true; }); });
    var s = String(text || "").replace(/^﻿/, "");
    var first = s.split(/\r?\n/, 1)[0] || "";
    var delim = first.indexOf("\t") >= 0 && first.indexOf(",") < 0 ? "\t" : ",";
    var rows = [], row = [], field = "", q = false;
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (q) { if (c === '"' && s[i + 1] === '"') { field += '"'; i++; } else if (c === '"') q = false; else field += c; continue; }
      if (c === '"' && field === "") q = true;
      else if (c === delim) { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") { if (c === "\r" && s[i + 1] === "\n") i++; row.push(field); rows.push(row); row = []; field = ""; }
      else field += c;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    rows = rows.filter(function (r) { return r.some(function (v) { return String(v).trim() !== ""; }); });
    if (!rows.length) return { csv: "", kept: [], dropped: [] };
    var headers = rows[0];
    var keep = [], dropped = [];
    headers.forEach(function (hd, i) { var n = String(hd).trim() === "#" ? "#" : norm(hd); if (allowed[n]) keep.push(i); else if (String(hd).trim()) dropped.push(String(hd).trim()); });
    var cell = function (v) { v = String(v == null ? "" : v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var out = rows.map(function (r) { return keep.map(function (i) { return cell(r[i]); }).join(","); }).join("\n");
    return { csv: out, kept: keep.map(function (i) { return headers[i]; }), dropped: dropped };
  }
  var rosterFlag = "";
  async function roster(id) {
    if (!guard() || !T().atLeast("member")) return T().go("#event/" + id);
    loading("events", T().backBtn("#event/" + id, "Event plan"));
    await getMeta();
    var t = T();
    var d = await t.api("/api/gfs/events/" + encodeURIComponent(id) + "/roster" + (rosterFlag ? "?flag=" + rosterFlag : ""));
    var ev = d.event;
    var FLAG = [["", "All"], ["held", "On hold"], ["priority", "Pre-sold"], ["low_profile", "Low profile"], ["no_jersey", "No jersey"]];
    var shown = d.athletes.slice(0, 400);
    var lastTeam = null;
    var people = shown.map(function (a) {
      var marks = [];
      if (a.hold) marks.push(badge(HOLD[a.hold] || a.hold, "bad"));
      if (!a.consent_marketing && !a.hold) marks.push(badge("No marketing", "warn"));
      if (!a.consent_sale && !a.hold) marks.push(badge("No sale", "warn"));
      if (a.priority) marks.push(badge("Pre-sold", "gold"));
      if (a.low_profile) marks.push(badge("Low profile", "warn"));
      if (a.under_13) marks.push(badge("Under 13", ""));
      var header = a.team !== lastTeam ? '<div class="li" style="cursor:default;min-height:40px;background:var(--card-2)"><div class="grow sec-h" style="letter-spacing:.04em">' + h(a.team) + "</div></div>" : "";
      lastTeam = a.team;
      return header + '<div class="li" style="cursor:default;min-height:50px"><span class="mono" style="width:40px;font-weight:600">' + (a.jersey == null ? "—" : "#" + h(a.jersey)) + '</span><div class="grow sub" style="color:var(--ink-2)">' + h([a.position, a.division, a.roster_id].filter(Boolean).join(" · ")) + '</div><div class="pill-row" style="justify-content:flex-end;max-width:62%">' + marks.join("") + "</div></div>";
    }).join("");
    t.show("events",
      '<div class="screen">' + t.backBtn("#event/" + id, "Event plan") +
      head(ev.name, "Roster and consent", "", d.athletes.length || d.teams.length ? d.teams.reduce(function (s, x) { return s + x.athletes; }, 0) + " athletes on " + d.teams.length + " teams" : "Sports Thread sends the roster 72 hours before the event.") +
      '<section class="card"><div class="name">Load the Sports Thread file</div>' +
      '<p class="sub" style="margin:0">Only the roster ID, team, division, jersey, position and the permission columns leave this device. Names, birth dates and contact details are left behind.</p>' +
      '<label class="btn soft small" style="align-self:flex-start;cursor:pointer">' + ICON.up + 'Choose a CSV<input type="file" id="rsFile" accept=".csv,.tsv,.txt,text/csv,text/plain" hidden></label>' +
      '<details><summary class="sub" style="cursor:pointer">Or paste it</summary><textarea class="textarea mono" id="rsText" style="min-height:120px;margin-top:8px" placeholder="Athlete ID,Team,Division,Jersey,Position,Under 13,Capture,Marketing and Social,Sale of Media,…"></textarea></details>' +
      '<button type="button" class="btn small" id="rsGo" style="align-self:flex-start">Load the roster</button><p id="rsMsg" class="body" role="status"></p></section>' +
      (d.athletes.length || rosterFlag ? '<div class="chips" role="group" aria-label="Filter">' + FLAG.map(function (f) { return '<button type="button" class="chip" data-flag="' + f[0] + '" aria-pressed="' + (rosterFlag === f[0]) + '">' + f[1] + "</button>"; }).join("") + "</div>" : "") +
      (people ? '<div class="list">' + people + "</div>" + (d.athletes.length > 400 ? '<p class="sub">Showing 400 of ' + d.athletes.length + ".</p>" : "") : d.teams.length ? '<p class="empty">No one matches.</p>' : "") +
      '<p class="sub" style="margin:0">A permission is off unless the file says yes. No verified age, or a 10U or 12U division, counts as under 13: family-only on SportsClippers, never public.</p>' +
      "</div>");
    bind("[data-flag]", "click", function (b) { rosterFlag = b.dataset.flag; roster(id); });
    document.getElementById("rsGo").addEventListener("click", function () {
      var btn = this;
      act(btn, async function () {
        var text = (await readFile(document.getElementById("rsFile"))) || document.getElementById("rsText").value;
        if (!text.trim()) throw new Error("Choose the file or paste it first.");
        var kept = keepRosterColumns(text);
        var r = await t.post("/api/gfs/events/" + encodeURIComponent(id) + "/roster", { csv: kept.csv });
        var s = r.summary;
        t.toast(s.added + " added, " + s.updated + " updated.");
        await roster(id);
        msgEl("rsMsg", s.rows + " athletes read · " + s.do_not_publish + " do-not-publish · " + s.no_capture + " without capture consent · " + s.under_13 + " under 13." + (kept.dropped.length ? " Left behind: " + kept.dropped.slice(0, 8).join(", ") + (kept.dropped.length > 8 ? "…" : "") + "." : "") + (s.warnings.indexOf("no_capture_column") >= 0 ? " No capture column: everyone is on hold until it's added." : "") + (s.clips_matched_now ? " " + s.clips_matched_now + " clips matched now." : ""), true);
      }, "rsMsg");
    });
  }

  // ── Live ───────────────────────────────────────────────────────────────
  async function live(id) {
    if (!guard()) return;
    loading("events", T().backBtn("#event/" + id, "Event plan"));
    await getMeta();
    var t = T();
    var d = await t.api("/api/gfs/events/" + encodeURIComponent(id));
    var ev = d.event, c = d.counts || {};
    var cut = d.deliverables.filter(function (x) { return x.kind === "cutdowns"; });
    var cutDone = cut.reduce(function (s, x) { return s + x.delivered; }, 0), cutReq = cut.reduce(function (s, x) { return s + x.required; }, 0);
    var nextCut = cut.filter(function (x) { return x.delivered < x.required; })[0];
    var member = t.atLeast("member");
    var crewRows = d.crew.filter(function (r) { return r.status === "confirmed"; }).map(function (r) {
      return '<div class="li" style="cursor:default"><span class="avatar" style="width:36px;height:36px;border-width:0;background:#22364F;font-size:12px">' + h((r.role_name || "?")[0]) + '</span><div class="grow"><div class="name" style="font-size:15px">' + h((r.creator && r.creator.name) || "Creator") + " · " + h(r.role_name.toLowerCase()) + '</div><div class="sub">' + h(r.note || (r.on_site ? "On site" : "Remote")) + "</div></div></div>";
    }).join("");
    t.show("events",
      '<div class="screen">' + t.backBtn("#event/" + id, "Event plan") +
      head((daysUntil(ev.starts_on, ev.tz) > 0 ? "Before the event · " : "Live · ") + span(ev), ev.city + ", " + ev.state, "", ev.name + " · " + (function (n) { return n + (n === 1 ? " creator" : " creators") + " on site"; })(d.crew.filter(function (r) { return r.status === "confirmed" && r.on_site; }).length)) +
      '<div class="stats">' +
      '<div class="stat"><b>' + (c.shot || 0) + "</b><span>Clips in</span></div>" +
      '<div class="stat"><b>' + (c.matched || 0) + "</b><span>Matched to the roster</span></div>" +
      '<div class="stat' + (c.held ? " warnb" : "") + '"><b>' + (c.held || 0) + "</b><span>Held</span></div>" +
      '<div class="stat"><b>' + cutDone + "/" + cutReq + "</b><span>Cut-downs" + (nextCut ? " · due " + h(whenIn(nextCut.due_at, ev.tz)) : "") + "</span></div>" +
      "</div>" +
      (c.unmatched ? '<a class="li list" href="#gfs-tags/' + h(id) + '" style="border-radius:16px"><div class="ico" style="width:36px;height:36px;border-radius:9px">' + ICON.tag + '</div><div class="grow"><div class="name" style="font-size:15px">Review tags</div><div class="sub">' + c.unmatched + " clip" + (c.unmatched === 1 ? " doesn't" : "s don't") + " match the roster yet</div></div>" + badge(String(c.unmatched), "gold") + "</a>" : "") +
      (member ? '<section class="card"><div class="name">Load the upload log</div><p class="sub" style="margin:0">The storage export: one row per file, with its path, upload time and the creator\'s code. Game files (TEAM-A_vs_TEAM-B_YYYYMMDD_ANGLE) feed the scorecards; clips (Jersey#-Angle-Clip#) are tagged against the roster. Add a final_whistle column to measure on-time uploads.</p>' +
        '<label class="btn soft small" style="align-self:flex-start;cursor:pointer">' + ICON.up + 'Choose a CSV<input type="file" id="upFile" accept=".csv,.tsv,.txt,text/csv,text/plain" hidden></label>' +
        '<details><summary class="sub" style="cursor:pointer">Or paste it</summary><textarea class="textarea mono" id="upText" style="min-height:120px;margin-top:8px" placeholder="path,uploaded_at,creator,final_whistle"></textarea></details>' +
        '<button type="button" class="btn small" id="upGo" style="align-self:flex-start">Load the log</button><p id="upMsg" class="body" role="status"></p></section>' : "") +
      '<section class="sec"><h2 class="sec-h">Crew on site · lead signs off Sunday noon</h2>' + (crewRows ? '<div class="list">' + crewRows + "</div>" : '<p class="empty">No one confirmed yet.</p>') + "</section>" +
      '<p class="sub" style="margin:0">Held clips stay off every channel: fix a wrong tag, or wait for the consent record to change. Cards for Pylon\'s channels go through an approver from Deliver.</p>' +
      '<a class="btn soft" href="#gfs-deliver/' + h(id) + '">Deliverables</a>' +
      "</div>");
    var go = document.getElementById("upGo");
    if (go) go.addEventListener("click", function () {
      var btn = this;
      act(btn, async function () {
        var text = (await readFile(document.getElementById("upFile"))) || document.getElementById("upText").value;
        if (!text.trim()) throw new Error("Choose the file or paste it first.");
        var r = await t.post("/api/gfs/events/" + encodeURIComponent(id) + "/uploads", { csv: text });
        var s = r.summary;
        await live(id);
        msgEl("upMsg", s.clips.added + " new clips (" + s.clips.matched + " matched, " + s.clips.unmatched + " to review, " + s.clips.held + " held) · " + (s.games.added + s.games.updated) + " game files" + (s.clips.already ? " · " + s.clips.already + " already logged" : "") + (s.skipped ? " · " + s.skipped + " rows skipped (not a label)" : "") + (s.unknown_creators ? " · " + s.unknown_creators + " unknown creator codes" : "") + (s.roster_loaded ? "" : " · No roster yet, so nothing could be matched."), true);
      }, "upMsg");
    });
  }

  // ── Tag review ─────────────────────────────────────────────────────────
  async function tags(id) {
    if (!guard()) return;
    loading("events", T().backBtn("#gfs-live/" + id, "Live console"));
    var t = T();
    var d = await t.api("/api/gfs/events/" + encodeURIComponent(id) + "/clips?view=unmatched&limit=60");
    var ev = d.event, c = d.counts || {};
    var member = t.atLeast("member");
    var teams = d.teams || [];
    var rows = d.clips.map(function (cl) {
      var why = WHY[cl.why] || "Unmatched";
      var where = [cl.team, cl.team_hint && cl.team_hint.replace(/-/g, " "), cl.game && cl.game.replace(/_\d{8}$/, "").replace(/_vs_/, " vs ").replace(/-/g, " ")].filter(Boolean)[0] || "";
      var sugg = (cl.suggestions || []).map(function (s) { return '<button type="button" class="chip" data-tag="' + h(cl.id) + '" data-row="' + h(s.roster_row) + '">#' + h(s.jersey) + (teams.length > 1 ? " · " + h(s.team) : "") + "</button>"; }).join("");
      var pick = member && teams.length ? '<select class="input" data-pick="' + h(cl.id) + '" aria-label="Pick the athlete" style="min-height:38px;padding:4px 8px;font-size:14px"><option value="">Other…</option>' + teams.map(function (tm) { return '<optgroup label="' + h(tm.team) + '">' + tm.jerseys.map(function (j) { return '<option value="' + h(j.roster_row) + '">#' + h(j.jersey) + (j.position ? " · " + h(j.position) : "") + "</option>"; }).join("") + "</optgroup>"; }).join("") + "</select>" : "";
      return '<div class="card tight" data-clip="' + h(cl.id) + '"><div class="row"><div class="grow"><div class="name" style="font-size:15px">' + h(why) + (cl.jersey ? " · #" + h(cl.jersey) : "") + (where ? " · " + h(where) : "") + '</div><div class="sub mono" style="font-size:12px">' + h((cl.folder ? cl.folder + " / " : "") + cl.file) + "</div></div></div>" +
        (member ? '<div class="chips" style="margin:0;padding:0;flex-wrap:wrap">' + sugg + '<button type="button" class="chip" data-tag="' + h(cl.id) + '" data-not="1">Not a player</button></div>' + pick : "") + "</div>";
    }).join("");
    t.show(member ? null : "events",
      '<div class="screen">' + t.backBtn("#gfs-live/" + id, "Live console") +
      head(ev.name, "Tag review", "", (c.matched || 0) + " of " + (c.shot || 0) + " clips matched to the roster") +
      '<p class="body">Every clip is tagged by jersey number against the roster Sports Thread sent. No face matching. A clip that isn\'t matched to an athlete doesn\'t sell.</p>' +
      '<section class="sec"><h2 class="sec-h">Unmatched · ' + (c.unmatched || 0) + "</h2>" + (rows || '<p class="empty">Nothing left to match.</p>') + (c.unmatched > d.clips.length ? '<p class="sub">' + (c.unmatched - d.clips.length) + " more after these.</p>" : "") + "</section>" +
      (c.held ? '<p class="sub" style="margin:0">' + c.held + " matched clip" + (c.held === 1 ? " shows an athlete" : "s show athletes") + " on hold (do-not-publish, no capture consent or a takedown). They stay off every channel.</p>" : "") +
      '<p id="tgMsg" class="body" role="status"></p></div>' +
      (member ? '<div class="dock"><div class="dock-inner"><button type="button" class="btn block" id="tgGo">Approve the game\'s tags</button><span class="note">Matched clips move to the edit. Unmatched ones stay unlisted.' + (d.tags_approved_at ? " Last approved " + h(t.ago(d.tags_approved_at)) + "." : "") + "</span></div></div>" : ""));
    async function tag(clipId, body) {
      await t.post("/api/gfs/events/" + encodeURIComponent(id) + "/clips/" + encodeURIComponent(clipId), body, "PATCH");
      var card = app().querySelector('[data-clip="' + clipId + '"]');
      if (card) card.remove();
      t.toast(body.not_a_player ? "Marked: not a player." : "Tagged.");
    }
    bind("[data-tag]", "click", function (b) { act(b, function () { return tag(b.dataset.tag, b.dataset.not ? { not_a_player: true } : { roster_row: b.dataset.row }); }, "tgMsg"); });
    bind("[data-pick]", "change", function (s) { if (s.value) tag(s.dataset.pick, { roster_row: s.value }).catch(function (e) { msgEl("tgMsg", say(e)); }); });
    var go = document.getElementById("tgGo");
    if (go) go.addEventListener("click", function () {
      var btn = this;
      act(btn, async function () { var r = await t.post("/api/gfs/events/" + encodeURIComponent(id) + "/tags/approve"); t.toast(r.tagged + " clips moved to the edit."); tags(id); }, "tgMsg");
    });
  }

  // ── Deliver ────────────────────────────────────────────────────────────
  var STATE = { open: ["Open", ""], submitted: ["Waiting for an approver", "warn"], approved: ["Cleared", "ok"], changes: ["Changes asked", "bad"], done: ["Done", "ok"] };
  async function deliver(id) {
    if (!guard()) return;
    loading("events", T().backBtn("#event/" + id, "Event plan"));
    await getMeta();
    var t = T();
    var res = await Promise.all([t.api("/api/gfs/events/" + encodeURIComponent(id)), t.atLeast("member") ? t.api("/api/gfs/events/" + encodeURIComponent(id) + "/roster").catch(function () { return { athletes: [] }; }) : Promise.resolve({ athletes: [] })]);
    var d = res[0], athletes = res[1].athletes || [];
    var ev = d.event, c = d.counts || {};
    var member = t.atLeast("member"), approver = t.atLeast("approver");
    var byGroup = {};
    d.deliverables.forEach(function (x) { (byGroup[x.group || "Other"] = byGroup[x.group || "Other"] || []).push(x); });
    function featuredPicker(x) {
      if (!x.featured_needed) return "";
      var chosen = athletes.filter(function (a) { return x.featured.indexOf(a.id) >= 0; });
      var label = chosen.length ? chosen.map(function (a) { return a.team + " #" + a.jersey + (!a.consent_marketing || a.hold ? " ⚠" : ""); }).join(", ") : "No athletes named yet";
      var opts = athletes.filter(function (a) { return a.jersey != null; }).map(function (a) { var ok = a.consent_capture && a.consent_marketing && !a.hold; return '<label class="row" style="gap:8px;font-size:14px;padding:4px 0"><input type="checkbox" data-feat="' + h(x.id) + '" value="' + h(a.id) + '"' + (x.featured.indexOf(a.id) >= 0 ? " checked" : "") + (ok ? "" : " disabled") + '><span>' + h(a.team) + " #" + h(a.jersey) + (ok ? "" : ' <span class="sub">· ' + h(a.hold ? HOLD[a.hold] : "no marketing consent") + "</span>") + "</span></label>"; }).join("");
      return '<details class="card tight" style="background:var(--card-2)"><summary class="sub" style="cursor:pointer">Featured: ' + h(label) + "</summary>" + (member && x.status !== "submitted" ? '<div style="max-height:220px;overflow:auto;margin-top:8px">' + (opts || '<span class="sub">Load the roster first.</span>') + '</div><button type="button" class="btn small soft" data-savefeat="' + h(x.id) + '" style="align-self:flex-start">Save featured</button>' : "") + "</details>";
    }
    function rowHtml(x) {
      var st = STATE[x.status] || STATE.open;
      var lateBadge = x.late && !x.cleared ? badge("Late", "bad") : "";
      var count = x.required ? x.delivered + "/" + x.required : x.delivered ? String(x.delivered) : "—";
      var due = x.cleared ? "" : "due " + whenIn(x.due_at, ev.tz);
      var controls = "";
      if (member && x.status !== "submitted") {
        controls += '<div class="stepper"><button type="button" data-step="' + h(x.id) + '" data-d="-1" aria-label="One fewer">−</button><input type="number" min="0" inputmode="numeric" data-count="' + h(x.id) + '" value="' + x.delivered + '" aria-label="Delivered"><button type="button" data-step="' + h(x.id) + '" data-d="1" aria-label="One more">+</button></div>';
        if (x.publishes && x.to_submit > 0) controls += '<button type="button" class="btn small" data-submit="' + h(x.id) + '">Send ' + x.to_submit + " to approval</button>";
        if (!x.publishes && x.status === "open" && x.delivered >= x.required) controls += '<button type="button" class="btn small soft" data-done="' + h(x.id) + '">Mark done</button>';
        if (!x.publishes && x.status === "done") controls += '<button type="button" class="btn small ghost" data-reopen="' + h(x.id) + '">Reopen</button>';
      }
      if (approver && x.status === "submitted") controls += '<button type="button" class="btn small" data-approve="' + h(x.id) + '">Approve ' + x.to_submit + '</button><button type="button" class="btn small ghost" data-changes="' + h(x.id) + '">Ask for changes</button>';
      var lateCause = member && x.late && !x.cleared ? '<input class="input" data-cause="' + h(x.id) + '" maxlength="200" placeholder="Why it\'s late (goes in the monthly report)" value="' + h(x.late_cause || "") + '" style="min-height:40px;font-size:14px">' : "";
      return '<div class="card tight"><div class="row"><span class="tick' + (x.cleared ? " on" : x.late ? " late" : "") + '">' + (x.cleared ? ICON.check : "") + '</span><div class="grow"><div class="name" style="font-size:15px">' + h(x.name) + '</div><div class="sub">' + h([count, due, x.publishes ? "posts on Pylon's channels" : null, x.note].filter(Boolean).join(" · ")) + "</div></div>" + (x.status !== "open" ? badge(st[0], st[1]) : "") + lateBadge + "</div>" +
        (x.note_from_approver ? '<p class="body" style="margin:0;color:var(--bad)">' + h(x.note_from_approver) + "</p>" : "") +
        featuredPicker(x) + (controls ? '<div class="row" style="flex-wrap:wrap;gap:8px">' + controls + "</div>" : "") + lateCause + "</div>";
    }
    var groups = Object.keys(byGroup).map(function (g) { return '<section class="sec"><h2 class="sec-h">' + h(g) + "</h2>" + byGroup[g].map(rowHtml).join("") + "</section>"; }).join("");
    var pipe = '<section class="card"><div class="name">Clips to families and SportsClippers</div>' +
      '<div class="stats" style="grid-template-columns:repeat(3,minmax(0,1fr))"><div class="stat"><b>' + (c.tagged || 0) + '</b><span>Tagged</span></div><div class="stat"><b>' + (c.approved || 0) + '</b><span>Approved</span></div><div class="stat"><b>' + (c.listed || 0) + "</b><span>On SportsClippers</span></div></div>" +
      '<div class="btn-row">' +
      (member ? '<button type="button" class="btn small soft" id="clEdited">Mark tagged clips edited</button>' : "") +
      (approver ? '<button type="button" class="btn small" id="clApprove">Approve edited clips</button>' : "") +
      "</div>" +
      '<div class="btn-row">' +
      (member ? '<button type="button" class="btn small soft" id="clFam">Family links file</button><button type="button" class="btn small soft" id="clSent">Mark sent to families</button>' : "") +
      "</div>" +
      (approver ? '<div class="btn-row"><button type="button" class="btn small soft" id="clList">SportsClippers file</button><button type="button" class="btn small" id="clListed">Mark listed</button></div>' : "") +
      '<p id="clMsg" class="body" role="status"></p></section>';
    t.show("events",
      '<div class="screen">' + t.backBtn("#event/" + id, "Event plan") +
      head(ev.name, "Deliver", "", "What Schedule C of the Pylon agreement owes for a " + ev.size_name.toLowerCase() + ". Deadlines in " + ev.tz.replace(/^America\//, "").replace(/_/g, " ") + " time.") +
      '<section class="card tight"><div class="name" style="font-size:15px">Where it goes</div>' +
      '<p class="sub" style="margin:0"><b style="color:var(--ink)">Families</b> · one link per athlete, only their athlete\'s clips. Private for a minor unless the guardian chose public.</p>' +
      '<p class="sub" style="margin:0"><b style="color:var(--ink)">Pylon\'s channels</b> · an approver clears it, with capture and marketing consent for every athlete it features.</p>' +
      '<p class="sub" style="margin:0"><b style="color:var(--ink)">SportsClippers</b> · listed only with sale-of-media consent; never public under 13.</p></section>' +
      groups + pipe +
      '<p id="dvMsg" class="body" role="status"></p></div>');
    var base = "/api/gfs/events/" + encodeURIComponent(id);
    function save(did, body) { return t.post(base + "/deliverables/" + encodeURIComponent(did), body, "PATCH"); }
    bind("[data-step]", "click", function (b) {
      var inp = app().querySelector('[data-count="' + b.dataset.step + '"]');
      var n = Math.max(0, (Number(inp.value) || 0) + Number(b.dataset.d));
      inp.value = n;
      act(b, async function () { await save(b.dataset.step, { delivered: n }); deliver(id); }, "dvMsg");
    });
    bind("[data-count]", "change", function (inp) { save(inp.dataset.count, { delivered: Math.max(0, Number(inp.value) || 0) }).then(function () { deliver(id); }).catch(function (e) { msgEl("dvMsg", say(e)); }); });
    bind("[data-cause]", "change", function (inp) { save(inp.dataset.cause, { late_cause: inp.value }).then(function () { t.toast("Saved."); }).catch(function (e) { msgEl("dvMsg", say(e)); }); });
    bind("[data-savefeat]", "click", function (b) {
      var ids = [].map.call(app().querySelectorAll('[data-feat="' + b.dataset.savefeat + '"]:checked'), function (x) { return x.value; });
      act(b, async function () { await save(b.dataset.savefeat, { featured: ids }); t.toast("Saved."); deliver(id); }, "dvMsg");
    });
    bind("[data-submit]", "click", function (b) { act(b, async function () { await t.post(base + "/deliverables/" + encodeURIComponent(b.dataset.submit) + "/submit"); t.toast("Sent to the approvers."); deliver(id); }, "dvMsg"); });
    bind("[data-approve]", "click", function (b) { act(b, async function () { await t.post(base + "/deliverables/" + encodeURIComponent(b.dataset.approve) + "/approve"); t.toast("Cleared for Pylon's channels."); deliver(id); }, "dvMsg"); });
    bind("[data-changes]", "click", function (b) {
      var card = b.closest(".card");
      if (!card.querySelector("[data-note]")) {
        card.insertAdjacentHTML("beforeend", '<textarea class="textarea" data-note maxlength="300" placeholder="What needs to change" style="min-height:80px"></textarea><button type="button" class="btn small" data-sendnote="' + h(b.dataset.changes) + '" style="align-self:flex-start">Send back</button>');
        card.querySelector("[data-sendnote]").addEventListener("click", function () {
          var btn = this;
          var note = card.querySelector("[data-note]").value.trim();
          act(btn, async function () { await t.post(base + "/deliverables/" + encodeURIComponent(btn.dataset.sendnote) + "/changes", { note: note }); t.toast("Sent back with your note."); deliver(id); }, "dvMsg");
        });
      }
    });
    bind("[data-done]", "click", function (b) { act(b, async function () { await t.post(base + "/deliverables/" + encodeURIComponent(b.dataset.done) + "/done"); t.toast("Done."); deliver(id); }, "dvMsg"); });
    bind("[data-reopen]", "click", function (b) { act(b, async function () { await t.post(base + "/deliverables/" + encodeURIComponent(b.dataset.reopen) + "/reopen"); deliver(id); }, "dvMsg"); });
    function wire(btnId, fn) { var b = document.getElementById(btnId); if (b) b.addEventListener("click", function () { act(b, fn, "clMsg"); }); }
    wire("clEdited", async function () { var r = await t.post(base + "/clips/edited"); t.toast(r.edited + " clips marked edited."); deliver(id); });
    wire("clApprove", async function () { var r = await t.post(base + "/clips/approve"); t.toast(r.approved + " clips approved."); deliver(id); });
    wire("clFam", async function () { download(base + "/families.csv", ev.code + "-family-links.csv"); document.getElementById("clFam").disabled = false; });
    wire("clSent", async function () { var r = await t.post(base + "/clips/delivered"); t.toast(r.delivered + " clips for " + r.athletes + " athletes marked sent."); deliver(id); });
    wire("clList", async function () { download(base + "/listings.csv", ev.code + "-sportsclippers.csv"); document.getElementById("clList").disabled = false; });
    wire("clListed", async function () { var r = await t.post(base + "/clips/listed"); t.toast(r.listed + " listed: " + r.family + " family-only, " + r.public + " public."); deliver(id); });
  }

  // ── Takedowns ──────────────────────────────────────────────────────────
  async function takedown(id) {
    if (!guard() || !T().atLeast("member")) return T().go("#event/" + id);
    loading(null);
    await getMeta();
    var t = T();
    var r = await Promise.all([t.api("/api/gfs/events/" + encodeURIComponent(id)), t.api("/api/gfs/events/" + encodeURIComponent(id) + "/roster")]);
    var ev = r[0].event, athletes = r[1].athletes.filter(function (a) { return a.jersey != null; });
    var teams = [];
    athletes.forEach(function (a) { if (teams.indexOf(a.team) < 0) teams.push(a.team); });
    var reason = "safety_request";
    var W = meta.takedown;
    t.show(null,
      '<div class="screen"><div class="head"><a class="back" href="#event/' + h(id) + '">' + t.I.back + "Cancel</a></div>" + head(ev.name, "Log a takedown") +
      '<div class="field"><span class="label">Why</span><div role="radiogroup" aria-label="Why" style="display:flex;flex-direction:column;gap:8px">' +
      Object.keys(W).map(function (k) { return '<button type="button" role="radio" class="radio" data-reason="' + k + '" aria-checked="' + (k === reason) + '"><span class="r"></span><span><b style="display:block;font-size:15.5px">' + h(W[k].label) + '</b><span class="sub">Off Pylon\'s channels within ' + W[k].pylon + " hours; every other surface, SportsClippers included, within " + W[k].other + ". Accounts Pylon doesn't run get a removal request within " + W[k].offsite + ".</span></span></button>"; }).join("") + "</div>" +
      '<p class="sub" style="margin:0">A safety request covers custody, harassment, a threat, or a minor\'s location exposed.</p></div>' +
      '<div class="field"><label class="label" for="tdTeam">Team</label><select class="input" id="tdTeam"><option value="">Pick the team</option>' + teams.map(function (tm) { return '<option>' + h(tm) + "</option>"; }).join("") + "</select></div>" +
      '<div class="field"><label class="label" for="tdAth">Jersey</label><select class="input" id="tdAth" disabled><option value="">Pick the team first</option></select></div>' +
      '<div class="field"><label class="label" for="tdWhen">Received <small>(leave blank for now)</small></label><input class="input" id="tdWhen" type="datetime-local"></div>' +
      '<div class="field"><label class="label" for="tdNote">Note <small>(optional)</small></label><input class="input" id="tdNote" maxlength="300" placeholder="How it came in. No names or contact details."></div>' +
      '<p id="tdMsg" class="body" role="status"></p></div>' +
      '<div class="dock"><div class="dock-inner"><button type="button" class="btn block danger" id="tdGo" style="background:var(--bad);color:var(--bg);border:0">Start the clock</button><span class="note">The athlete goes do-not-publish at every event right away.</span></div></div>');
    bind("[data-reason]", "click", function (b) { reason = b.dataset.reason; app().querySelectorAll("[data-reason]").forEach(function (x) { x.setAttribute("aria-checked", String(x === b)); }); });
    var teamSel = document.getElementById("tdTeam"), athSel = document.getElementById("tdAth");
    teamSel.addEventListener("change", function () {
      var list = athletes.filter(function (a) { return a.team === teamSel.value; }).sort(function (a, b) { return Number(a.jersey) - Number(b.jersey); });
      athSel.innerHTML = '<option value="">Pick the jersey</option>' + list.map(function (a) { return '<option value="' + h(a.id) + '">#' + h(a.jersey) + (a.position ? " · " + h(a.position) : "") + "</option>"; }).join("");
      athSel.disabled = !list.length;
    });
    document.getElementById("tdGo").addEventListener("click", function () {
      var btn = this;
      act(btn, async function () {
        if (!athSel.value) throw new Error("Pick the team and the jersey.");
        var when = document.getElementById("tdWhen").value;
        var d = await t.post("/api/gfs/takedowns", { event_id: id, roster_row: athSel.value, reason: reason, received_at: when ? new Date(when).toISOString() : undefined, note: document.getElementById("tdNote").value.trim() });
        t.toast("Clock started. Off Pylon's channels by " + whenIn(d.takedown.steps[0].due_at, ev.tz) + ".");
        t.go("#gfs-desk");
      }, "tdMsg");
    });
  }
  function takedownCard(td, approverOrMember) {
    var l = td.next_due_at ? left(td.next_due_at) : null;
    return '<div class="card tight"><div class="row"><div class="grow"><div class="name" style="font-size:15px">' + (td.number ? "#" + td.number + " · " : "") + h(td.team || "Athlete") + " · " + h(td.reason_name.toLowerCase()) + '</div><div class="sub">' + h(td.event ? td.event.name : "") + (td.clips_out ? " · " + td.clips_out + " clips still out" : "") + "</div></div>" + (l ? badge(l.text, l.late || l.hours < 6 ? "bad" : "warn") : badge("Done", "ok")) + "</div>" +
      td.steps.map(function (s) { return '<div class="row" style="gap:10px"><span class="tick' + (s.done_at ? " on" : new Date(s.due_at) < new Date() ? " late" : "") + '">' + (s.done_at ? ICON.check : "") + '</span><div class="grow sub" style="color:var(--ink-2)">' + h(s.label) + " · " + (s.done_at ? "done " + h(T().ago(s.done_at)) : "by " + h(whenIn(s.due_at))) + "</div>" + (!s.done_at && approverOrMember ? '<button type="button" class="btn small soft" data-tdstep="' + h(td.id) + '" data-k="' + s.key + '">Done</button>' : "") + "</div>"; }).join("") +
      "</div>";
  }
  function wireTakedowns(refresh) {
    bind("[data-tdstep]", "click", function (b) {
      var body = {};
      body[{ pylon: "pylon_done", other: "other_done", offsite: "offsite_requested" }[b.dataset.k]] = true;
      act(b, async function () { await T().post("/api/gfs/takedowns/" + encodeURIComponent(b.dataset.tdstep), body, "PATCH"); T().toast("Marked."); refresh(); });
    });
  }

  // ── The Distribution desk (wide) ───────────────────────────────────────
  var desk = { region: "", window: "default", sel: {} };
  async function deskScreen() {
    if (!guard()) return;
    app().classList.add("wide");
    loading("events");
    await getMeta();
    var t = T();
    var q = "?window=" + encodeURIComponent(desk.window.indexOf("series:") === 0 ? "default" : desk.window) + (desk.region ? "&region=" + encodeURIComponent(desk.region) : "") + (desk.window.indexOf("series:") === 0 ? "&series=" + encodeURIComponent(desk.window.slice(7)) : "");
    var d = await t.api("/api/gfs/desk" + q);
    var approver = t.atLeast("approver"), member = t.atLeast("member");
    var tot = d.totals;
    var pickedRows = d.rows.filter(function (r) { return desk.sel[r.event.id]; });
    var pending = pickedRows.reduce(function (s, r) { return s + r.waiting_items.reduce(function (a, w) { return a + w.pieces; }, 0); }, 0);
    var nf = function (v) { return v === undefined || v === null ? "—" : String(v); };
    var table = '<div class="dtable-wrap"><table class="dtable"><thead><tr><th><span class="sr">Select</span></th><th>Event</th><th>Director</th><th>Shot</th><th>Tagged</th><th>Edited</th><th>Approved</th><th>Delivered</th><th>On SportsClippers</th><th>Held</th><th>Waiting</th></tr></thead><tbody>' +
      d.rows.map(function (r) {
        var on = !!desk.sel[r.event.id];
        return '<tr class="' + (on ? "sel" : "") + '"><td class="l"><button type="button" class="box" data-sel="' + h(r.event.id) + '" aria-pressed="' + on + '" aria-label="Select ' + h(r.event.name) + '"></button></td>' +
          '<td class="l"><a href="#event/' + h(r.event.id) + '" style="color:var(--ink);text-decoration:none;font-weight:700">' + h(r.event.name) + '</a><div class="sub">' + h(span(r.event) + " · " + rname(r.event.region) + (r.overdue ? " · " + r.overdue + " late" : "")) + "</div></td>" +
          '<td class="l">' + h(r.event.director ? r.event.director.name || (r.event.director.you ? "You" : "—") : "—") + "</td>" +
          "<td>" + nf(r.shot) + "</td><td>" + nf(r.tagged) + "</td><td>" + nf(r.edited) + "</td><td>" + nf(r.approved) + "</td><td>" + nf(r.delivered) + "</td><td>" + nf(r.listed) + '</td><td class="' + (r.held ? "num-warn" : "") + '">' + nf(r.held) + '</td><td class="' + (r.waiting ? "num-warn" : "") + '">' + nf(r.waiting) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
    var tds = d.takedowns.map(function (td) { return takedownCard(td, member); }).join("");
    var att = d.creators.attention.map(function (cr) {
      var why = [];
      cr.badges.forEach(function (b) { if (!b.ok && b.key !== "youth") why.push(b.label.toLowerCase()); });
      (cr.scorecard.below || []).forEach(function (k) { why.push({ on_time: "under on on-time uploads", angles_hit: "under on two angles", usable: "under on usable film", rating: "under on family rating" }[k]); });
      return "<li>" + h(cr.name) + " · " + h(why.join(", ")) + "</li>";
    }).join("");
    var series = {};
    d.rows.forEach(function (r) { if (r.event.series) series[r.event.series] = 1; });
    t.show("events",
      '<div class="screen">' +
      '<div class="head"><div class="grow"><p class="ws">Ground Floor Sports · Pylon</p><p class="kicker">' + h(new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })) + " · " + h(desk.region ? rname(desk.region) : "all your regions") + '</p><h1 class="title">Distribution desk</h1></div><a class="btn small ghost" href="#events">Phone view</a></div>' +
      '<div class="row" style="flex-wrap:wrap;gap:12px"><div class="seg" role="group" aria-label="Region"><button type="button" data-dreg="" aria-pressed="' + (!desk.region) + '">All regions</button>' + meta.you.regions.map(function (r) { return '<button type="button" data-dreg="' + r + '" aria-pressed="' + (desk.region === r) + '">' + h(rname(r)) + "</button>"; }).join("") + "</div>" +
      '<div class="seg" role="group" aria-label="Show"><button type="button" data-win="default" aria-pressed="' + (desk.window === "default") + '">Last 14 days and next 30</button><button type="button" data-win="weekend" aria-pressed="' + (desk.window === "weekend") + '">This weekend</button>' + Object.keys(series).concat(desk.window.indexOf("series:") === 0 && !series[desk.window.slice(7)] ? [desk.window.slice(7)] : []).map(function (s) { return '<button type="button" data-win="series:' + h(s) + '" aria-pressed="' + (desk.window === "series:" + s) + '">' + h(s) + "</button>"; }).join("") + "</div></div>" +
      '<div class="desk"><div style="display:flex;flex-direction:column;gap:16px;min-width:0">' +
      '<div class="stats"><div class="stat' + (tot.waiting ? " warnb" : "") + '"><b>' + tot.waiting + '</b><span>Deliverables waiting for an approver</span></div><div class="stat"><b>' + tot.unmatched + '</b><span>Unmatched clips · they don\'t sell until tagged</span></div><div class="stat"><b>' + tot.held + '</b><span>Clips held: do-not-publish or no consent</span></div><div class="stat' + (tot.takedowns_open ? " alert" : "") + '"><b>' + tot.takedowns_open + "</b><span>Takedowns open" + (tot.next_takedown_due_at ? " · next due in " + h(left(tot.next_takedown_due_at).text.toLowerCase()) : "") + "</span></div></div>" +
      '<section class="sec"><h2 class="sec-h">Every event · shot → tagged → edited → approved → delivered → listed</h2>' + (d.rows.length ? table : '<p class="empty">No events in this window.</p>') + "</section>" +
      (approver && d.rows.length ? '<div class="row" style="flex-wrap:wrap;gap:10px"><span class="sub">' + (pickedRows.length ? pickedRows.length + " selected" : "Select events") + '</span><button type="button" class="btn small" id="dkApprove"' + (pending ? "" : " disabled") + ">" + (pending ? "Approve " + pending + " for Pylon's channels" : "Nothing to approve") + "</button></div>" : "") +
      '<p id="dkMsg" class="body" role="status"></p>' +
      "</div><aside class=\"side\">" +
      '<section class="sec"><h2 class="sec-h">Takedowns</h2>' + (tds || '<p class="empty">None open.</p>') + '<p class="sub" style="margin:0">Flagged athletes go do-not-publish the same moment. The clip log finds every version.</p></section>' +
      '<section class="card"><div class="name">Creators this quarter</div><p class="sub" style="margin:0">' + d.creators.on_standard + " of " + d.creators.with_games + " with games are on the standard (" + h(d.creators.quarter.label) + ").</p>" + (att ? '<ul class="body" style="margin:0;padding-left:18px;font-size:14px">' + att + "</ul>" : "") + '<a class="btn small soft" href="#gfs-creators" style="align-self:flex-start">Open scorecards</a></section>' +
      '<section class="card"><div class="name">SportsClippers</div><p class="sub" style="margin:0">We film, tag, list and price. SportsClippers runs checkout, licensing, delivery and payouts.</p>' +
      '<p class="sub" style="margin:0"><b style="color:var(--ink)">Share</b> · ' + h(d.sportsclippers.share) + "</p>" +
      '<p class="sub" style="margin:0"><b style="color:var(--ink)">Payouts</b> · ' + h(d.sportsclippers.payouts) + "</p>" +
      '<p class="sub" style="margin:0">' + h(d.sportsclippers.data_rule) + " Buyers can't message athletes. A minor never checks out.</p></section>" +
      "</aside></div></div>");
    bind("[data-sel]", "click", function (b) { desk.sel[b.dataset.sel] = !desk.sel[b.dataset.sel]; deskScreen(); });
    bind("[data-dreg]", "click", function (b) { desk.region = b.dataset.dreg; desk.sel = {}; deskScreen(); });
    bind("[data-win]", "click", function (b) { desk.window = b.dataset.win; desk.sel = {}; deskScreen(); });
    wireTakedowns(deskScreen);
    var ap = document.getElementById("dkApprove");
    if (ap) ap.addEventListener("click", function () {
      act(ap, async function () {
        var ok = 0, blocked = [];
        for (var i = 0; i < pickedRows.length; i++) {
          for (var j = 0; j < pickedRows[i].waiting_items.length; j++) {
            var w = pickedRows[i].waiting_items[j];
            try { await t.post("/api/gfs/events/" + encodeURIComponent(pickedRows[i].event.id) + "/deliverables/" + encodeURIComponent(w.id) + "/approve"); ok++; }
            catch (e) { blocked.push(pickedRows[i].event.code + " · " + w.name + ": " + say(e)); }
          }
        }
        desk.sel = {};
        await deskScreen();
        if (blocked.length) msgEl("dkMsg", ok + " cleared. Held back: " + blocked.join(" · "));
        else t.toast(ok + " cleared for Pylon's channels.");
      }, "dkMsg");
    });
  }

  // ── Creators ───────────────────────────────────────────────────────────
  var crRegion = "";
  async function creatorsScreen() {
    if (!guard()) return;
    loading("events", T().backBtn("#events", "Events"));
    await getMeta();
    var t = T();
    var d = await t.api("/api/gfs/scorecards" + (crRegion ? "?region=" + encodeURIComponent(crRegion) : ""));
    var S = d.standard;
    var tone = function (v, k) { return v === null || v === undefined ? "" : v >= S[k] ? "num-ok" : "num-warn"; };
    var fmt = function (v, k) { return v === null || v === undefined ? "—" : k === "rating" ? Number(v).toFixed(1) : pct(v); };
    var rows;
    if (!crRegion && d.regions.length > 1) {
      rows = d.regions.map(function (r) { return { name: r.region_name, sub: r.creators + " creator" + (r.creators === 1 ? "" : "s") + " · " + r.on_standard + " on standard", v: r, href: null, reg: r.region }; });
    } else {
      rows = d.creators.map(function (c) {
        var bad = c.badges.filter(function (b) { return !b.ok; }).map(function (b) { return b.label.toLowerCase(); });
        return { name: c.name, sub: [c.home_city, c.tier === "youth" ? "youth creator" : null, c.scorecard.games ? c.scorecard.games + " games" : "no games yet", bad[0]].filter(Boolean).join(" · "), v: c.scorecard, href: "#gfs-creator/" + c.id };
      });
    }
    var body = '<div class="dtable-wrap"><table class="dtable compact"><thead><tr><th>' + (!crRegion && d.regions.length > 1 ? "Region" : "Creator") + "</th><th>On time</th><th>2 angles</th><th>Usable</th><th>Rating</th></tr></thead><tbody>" +
      '<tr class="target"><td class="l">Target</td><td>' + pct(S.on_time) + "</td><td>" + pct(S.angles_hit) + "</td><td>" + pct(S.usable) + "</td><td>" + S.rating.toFixed(1) + "</td></tr>" +
      rows.map(function (r) {
        var name = r.href ? '<a href="' + r.href + '" style="color:var(--ink);text-decoration:none;font-weight:700">' + h(r.name) + "</a>" : r.reg ? '<button type="button" data-reg="' + h(r.reg) + '" style="all:unset;cursor:pointer;font-weight:700">' + h(r.name) + "</button>" : h(r.name);
        return '<tr><td class="l">' + name + '<div class="sub">' + h(r.sub) + '</div></td><td class="' + tone(r.v.on_time, "on_time") + '">' + fmt(r.v.on_time, "on_time") + '</td><td class="' + tone(r.v.angles_hit, "angles_hit") + '">' + fmt(r.v.angles_hit, "angles_hit") + '</td><td class="' + tone(r.v.usable, "usable") + '">' + fmt(r.v.usable, "usable") + '</td><td class="' + tone(r.v.rating, "rating") + '">' + fmt(r.v.rating, "rating") + "</td></tr>";
      }).join("") + "</tbody></table></div>";
    var regs = meta.you.regions;
    t.show("events",
      '<div class="screen">' + t.backBtn("#events", "Events") +
      head(null, "Creators", t.atLeast("member") ? '<a class="btn small" href="#gfs-creator/new">' + t.I.plus.replace("<svg", '<svg width="16" height="16"') + "Add</a>" : "", "One standard, rolled up by region · " + d.quarter.label) +
      (regs.length > 1 ? regionChips(regs, crRegion, true) : "") +
      body +
      '<p class="sub" style="margin:0">The four measures from the Scout Agreement (§4): games uploaded within 12 hours, games with two angles that meet the standard, games that are usable for grading, and the family rating. Under for a quarter starts a coaching plan.</p>' +
      '<p class="sub" style="margin:0">Credit for a sale goes to the creator the buyer names at checkout, or the one the package is assigned to, whichever comes first.</p>' +
      "</div>");
    bind("[data-region]", "click", function (b) { crRegion = b.dataset.region; creatorsScreen(); });
    bind("[data-reg]", "click", function (b) { crRegion = b.dataset.reg; creatorsScreen(); });
  }

  async function creator(id) {
    if (!guard() || !T().atLeast("member")) return T().go("#gfs-creators");
    loading(null);
    await getMeta();
    var t = T();
    var isNew = id === "new";
    var c = { region: meta.you.regions.length === 1 ? meta.you.regions[0] : "", tier: "adult", status: "active", badges: [] };
    if (!isNew) {
      var list = await t.api("/api/gfs/creators");
      c = (list.creators || []).find(function (x) { return x.id === id; });
      if (!c) return t.go("#gfs-creators");
    }
    var owner = t.isOwner();
    var dateIn = function (key, label) { return input("c_" + key, label, 'type="date"' + (owner ? "" : " disabled"), c[key]); };
    t.show(null,
      '<div class="screen"><div class="head"><a class="back" href="#gfs-creators">' + t.I.back + "Cancel</a></div>" + head(isNew ? null : "Code " + c.code, isNew ? "Add a creator" : c.name) +
      input("c_name", "Name", 'type="text" maxlength="80"', c.name) +
      input("c_email", "Email <small>(a parent's, for a youth creator)</small>", 'type="email" inputmode="email" autocomplete="off"', c.email) +
      '<div class="field"><span class="label">Region</span><div class="chips" role="radiogroup" aria-label="Region" style="flex-wrap:wrap;margin:0;padding:0">' + meta.you.regions.map(function (r) { return '<button type="button" role="radio" class="chip" data-creg="' + r + '" aria-pressed="' + (c.region === r) + '">' + h(rname(r)) + "</button>"; }).join("") + "</div></div>" +
      input("c_city", "Home city", 'type="text" maxlength="80"', c.home_city) +
      '<section class="card"><div class="name">Screening' + (owner ? "" : " · Kyron records this") + '</div>' +
      (c.badges.length ? '<div class="pill-row">' + c.badges.map(function (b) { return badge(b.label + (b.until && b.ok ? " · to " + day(b.until, { month: "short", year: "numeric" }) : ""), b.ok ? "ok" : "warn"); }).join("") + "</div>" : "") +
      dateIn("contract_signed_on", "Contract signed") + dateIn("background_check_on", "Background check") + dateIn("safety_training_on", "Minor-safety training") +
      (owner ? '<div class="field"><span class="label">Tier</span><div class="seg" role="group" aria-label="Tier"><button type="button" data-tier="adult" aria-pressed="' + (c.tier !== "youth") + '">Adult (18+)</button><button type="button" data-tier="youth" aria-pressed="' + (c.tier === "youth") + '">Youth (16–17)</button></div><span class="sub">A youth creator signs the Youth Creator Agreement through a parent, shoots alongside an adult, and never sells or messages a family.</span></div>' +
        input("c_shadow", "Shadowed events", 'type="number" min="0" max="50" inputmode="numeric"', c.shadow_events || 0) +
        '<label class="check"><span><b style="display:block;font-size:15px">Lead scout</b><span class="sub">Regional quality control and mentoring</span></span><input type="checkbox" class="switch" id="c_lead"' + (c.lead_scout ? " checked" : "") + "></label>" : "") +
      '<p class="sub" style="margin:0">Each is good for a year (Scout Agreement §6). A creator can\'t be crewed without all three.</p></section>' +
      (isNew ? "" : '<div class="field"><span class="label">Status</span><div class="seg" role="group" aria-label="Status">' + ["active", "paused", "inactive"].map(function (s) { return '<button type="button" data-cst="' + s + '" aria-pressed="' + (c.status === s) + '">' + s[0].toUpperCase() + s.slice(1) + "</button>"; }).join("") + "</div></div>") +
      '<div class="field"><label class="label" for="c_notes">Notes</label><textarea class="textarea" id="c_notes" maxlength="500" style="min-height:80px">' + h(c.notes || "") + "</textarea></div>" +
      '<p id="cMsg" class="body" role="status"></p></div>' +
      '<div class="dock"><div class="dock-inner"><button type="button" class="btn block" id="cGo">' + (isNew ? "Add the creator" : "Save") + "</button></div></div>");
    var region = c.region, tier = c.tier, status = c.status;
    bind("[data-creg]", "click", function (b) { region = b.dataset.creg; app().querySelectorAll("[data-creg]").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); }); });
    bind("[data-tier]", "click", function (b) { tier = b.dataset.tier; app().querySelectorAll("[data-tier]").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); }); });
    bind("[data-cst]", "click", function (b) { status = b.dataset.cst; app().querySelectorAll("[data-cst]").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); }); });
    document.getElementById("cGo").addEventListener("click", function () {
      var btn = this;
      act(btn, async function () {
        var v = function (k) { var el = document.getElementById(k); return el ? el.value.trim() : undefined; };
        var body = { name: v("c_name"), email: v("c_email"), region: region, home_city: v("c_city"), notes: v("c_notes") };
        if (!isNew) body.status = status;
        if (owner) {
          body.contract_signed_on = v("c_contract_signed_on") || null;
          body.background_check_on = v("c_background_check_on") || null;
          body.safety_training_on = v("c_safety_training_on") || null;
          body.tier = tier;
          body.shadow_events = Number(v("c_shadow")) || 0;
          body.lead_scout = !!(document.getElementById("c_lead") && document.getElementById("c_lead").checked);
          if (body.tier === "youth") body.lead_scout = false;
        }
        if (isNew) await t.post("/api/gfs/creators", body);
        else await t.post("/api/gfs/creators/" + encodeURIComponent(id), body, "PATCH");
        t.toast(isNew ? "Added." + (owner ? "" : " Kyron records their screening before they can be crewed.") : "Saved.");
        t.go("#gfs-creators");
      }, "cMsg");
    });
  }

  // ── Today (app.js calls this) ──────────────────────────────────────────
  async function todayParts() {
    var t = T();
    await getMeta();
    var d = await t.api("/api/gfs/today");
    var needs = d.needs.map(function (n) {
      if (n.kind === "takedown") {
        var l = n.next_due_at ? left(n.next_due_at) : { text: "", late: false };
        return '<a class="card tight" href="#gfs-desk" style="text-decoration:none;color:inherit"><div class="row"><div class="grow"><div class="name" style="font-size:15px">Takedown' + (n.number ? " #" + n.number : "") + " · " + h(n.team || "") + '</div><div class="sub">' + h(n.reason_name) + " · " + h(n.event ? n.event.name : "") + "</div></div>" + badge(l.text, "bad") + "</div></a>";
      }
      if (n.kind === "event_gaps") { var dd = daysUntil(n.event.starts_on, n.event.tz); return '<a class="card tight" href="#event/' + h(n.event.id) + '" style="text-decoration:none;color:inherit"><div class="row"><div class="grow"><div class="name" style="font-size:15px">' + h(n.event.name) + '</div><div class="sub">' + h(n.gaps.join(" · ")) + "</div></div>" + badge(dd <= 0 ? "Today" : dd === 1 ? "Tomorrow" : "In " + dd + " days", "gold") + "</div></a>"; }
      var label = { approve: "To approve", changes: "Changes asked", overdue: "Late" }[n.kind];
      return '<a class="card tight" href="#gfs-deliver/' + h(n.event.id) + '" style="text-decoration:none;color:inherit"><div class="row"><div class="grow"><div class="name" style="font-size:15px">' + h(n.deliverable.name) + '</div><div class="sub">' + h(n.event.name + (n.kind === "approve" ? " · " + n.deliverable.to_submit + " to clear" : "")) + "</div></div>" + badge(label, n.kind === "approve" ? "gold" : "bad") + "</div></a>";
    }).join("");
    var nx = d.next;
    var next = "";
    if (nx) {
      var ready = nx.checklist.filter(function (c) { return c.done; }).length;
      var d0 = daysUntil(nx.starts_on, nx.tz);
      next = '<section class="sec"><h2 class="sec-h">' + (d0 <= 0 ? "Live now" : d0 === 1 ? "Tomorrow" : "Next event") + '</h2><article class="card"><div class="row"><div class="grow"><div class="name" style="font-size:17px">' + h(nx.name) + '</div><div class="sub">' + h(span(nx) + " · " + rname(nx.region) + " · " + nx.size_name.toLowerCase()) + "</div></div>" + badge(ready + " of 4 ready", ready === 4 ? "ok" : "warn") + "</div>" +
        '<ul class="steps" style="padding:4px 0;border:0;background:none">' + nx.checklist.map(function (c) { return '<li><span class="s' + (c.done ? " done" : "") + '"></span><div><b style="font-weight:600;font-size:14.5px">' + h(c.label) + "</b></div></li>"; }).join("") + "</ul>" +
        '<div class="btn-row"><a class="btn soft small" href="#event/' + h(nx.id) + '">Event plan</a><a class="btn small" href="#gfs-live/' + h(nx.id) + '">Live console</a></div></article>' +
        (d.upcoming.length ? '<p class="sub" style="margin:0">Then: ' + h(d.upcoming.map(function (u) { return u.city + " · " + day(u.starts_on, { month: "short", day: "numeric" }); }).join(" · ")) + "</p>" : "") + "</section>";
    }
    return { needs: needs, count: d.needs.length, next: next };
  }

  window.TOJGfs = { todayParts: todayParts };
  window.TOJScreens = Object.assign(window.TOJScreens || {}, {
    events: events,
    "gfs-new": gfsNew,
    "gfs-edit": gfsEdit,
    event: event,
    "gfs-crew": crew,
    "gfs-roster": roster,
    "gfs-live": live,
    "gfs-tags": tags,
    "gfs-deliver": deliver,
    "gfs-takedown": takedown,
    "gfs-desk": deskScreen,
    "gfs-creators": creatorsScreen,
    "gfs-creator": creator,
  });
})();
