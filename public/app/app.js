/* TOJ app — one page, hash routes, the same API the consoles use.
 *
 *   #today            what needs you, what's running, the team today
 *   #studio           kits (approved + drafts)
 *   #kit/<id>         one kit: columns and cards, copy to Milanote
 *   #new[/preset]     New idea → the Brief Writer (photos, videos, PDFs, links)
 *   #brief/<runId>    the brief that came back → start the run
 *   #run/<runId>      a kit run in progress → its draft
 *   #review/<kitId>   what changed → approve (Owner, Approver) or discard
 *   #tools, #tool/<k> the other consoles, opened inside the app
 *   #team, #invite    people, roles, invites (Owner)
 *   #join/<token>     accept an invite; #signin
 *
 * Photos and video stills go to the Brief Writer for one run and are never
 * stored. File names never leave the phone.
 *
 * Inside the iPhone app (window.TOJNative, from native.js): the native camera,
 * notifications from Apple, and things shared to TOJ from other apps, which
 * open in New idea.
 */
(function () {
  "use strict";

  var app = document.getElementById("app");
  var tabsEl = document.getElementById("tabs");
  var toastEl = document.getElementById("toast");
  var state = { me: null, kits: null, idea: null, lastFiles: "", kitCol: {}, pollers: [] };

  // ── Helpers ──────────────────────────────────────────────────────────
  function h(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function store(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  // Each screen change bumps gen. A reply that lands after the person has
  // moved to another screen is dropped (the request itself still happened),
  // so a slow screen can't draw over the one they're on now.
  var gen = 0;
  function staleError() { var e = new Error("stale"); e.stale = true; return e; }
  // Promise.allSettled, except a stale reply still stops the screen.
  async function settled(list) {
    var res = await Promise.allSettled(list);
    if (res.some(function (r) { return r.status === "rejected" && r.reason && r.reason.stale; })) throw staleError();
    return res;
  }
  async function api(path, opts) {
    var my = gen;
    var r = await fetch(path, Object.assign({ credentials: "same-origin", cache: "no-store" }, opts || {}));
    var text = await r.text();
    if (my !== gen) throw staleError();
    var d = null;
    try { d = text ? JSON.parse(text) : {}; } catch (e) { var err0 = new Error("The server sent something unexpected (" + r.status + ")."); err0.status = r.status; throw err0; }
    if (!r.ok) { var err = new Error(friendly(d.error) || ("HTTP " + r.status)); err.status = r.status; err.data = d; throw err; }
    return d;
  }
  function post(path, body, method) {
    return api(path, { method: method || "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  }
  var FRIENDLY = {
    not_authenticated: "Please sign in.",
    not_on_team: "You're not on the team yet. Ask Kyron for an invite.",
    role_too_low: "Your role can't do that. Ask Kyron.",
    staff_only: "Only the owner can do that.",
    invalid_credentials: "That email and password don't match.",
    invite_not_valid: "This invite link doesn't work anymore. Ask Kyron for a new one.",
    password_too_short: "Use at least 10 characters.",
    wrong_password: "That's not the password for this account.",
    already_on_team: "They're already on the team.",
    fix_blockers_first: "This draft has problems to fix before it can be approved.",
    stale_draft: "A newer version was approved since this draft was made. Start a new refresh.",
    rule_changes_need_the_owner: "Only Kyron can allow rule changes.",
    owner_account: "The owner account can't be deleted from the app.",
    supabase_unavailable: "The server can't reach its database right now.",
    too_many_tries: "Too many tries. Wait a few minutes.",
  };
  function friendly(code) { return code ? FRIENDLY[code] || String(code).replace(/_/g, " ") : ""; }

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { toastEl.hidden = true; }, 2600);
  }
  function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }
  function stopPolling() { state.pollers.forEach(function (t) { clearTimeout(t); }); state.pollers = []; }
  function later(fn, ms) { var t = setTimeout(fn, ms); state.pollers.push(t); }
  function ago(iso) {
    if (!iso) return "";
    var s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  function initials(p) {
    var n = (p.name || p.email || "?").replace(/@.*/, "").replace(/[^A-Za-z0-9\s._-]/g, "").trim();
    var parts = n.split(/[\s._-]+/).filter(Boolean);
    return parts.length ? ((parts[0][0] || "") + (parts[1] ? parts[1][0] : "")).toUpperCase() : "?";
  }
  var RANK = { viewer: 1, member: 2, approver: 3, owner: 4 };
  function atLeast(role) { var t = state.me && state.me.team; return !!t && RANK[t.role] >= RANK[role]; }
  function isOwner() { return !!(state.me && state.me.team && state.me.team.owner); }
  function standalone() { return !!window.TOJNative || window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true; }
  var N = window.TOJNative || null;

  // ── Icons (inline, stroke) ───────────────────────────────────────────
  var I = {
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
    layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.6"/><rect x="14" y="3" width="7" height="7" rx="1.6"/><rect x="3" y="14" width="7" height="7" rx="1.6"/><rect x="14" y="14" width="7" height="7" rx="1.6"/></svg>',
    people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><circle cx="17" cy="9" r="2.8"/><path d="M16 14.6c2.7.2 4.6 1.9 5.3 4.9"/></svg>',
    chev: '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>',
    camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
    photo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="m4 17 5-4.5 4 3.5 3-2.5 4.5 3.5"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></svg>',
    invite: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="10" cy="8" r="3.5"/><path d="M3.5 20c.8-3.6 3.4-5.5 6.5-5.5 1.7 0 3.2.6 4.4 1.6"/><path d="M18 14v6M15 17h6"/></svg>',
    play: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l10-6.5z"/></svg>',
    question: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1.1.9-1.1 1.6v.4"/><path d="M12 16.8h.01"/></svg>',
    share: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3M8 7l4-4 4 4"/><path d="M6 11H5v10h14V11h-1"/></svg>',
    out: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v6H4V6h6"/></svg>',
  };

  function backBtn(href, label) { return '<a class="back" href="' + h(href) + '">' + I.back + h(label) + "</a>"; }

  // ── Tab bar ──────────────────────────────────────────────────────────
  function renderTabs(active) {
    if (!active) { tabsEl.hidden = true; app.classList.add("no-tabs"); return; }
    app.classList.remove("no-tabs");
    tabsEl.hidden = false;
    function t(key, href, label, ico) {
      return '<a href="' + href + '"' + (active === key ? ' aria-current="page"' : "") + ">" + ico + "<span>" + label + "</span></a>";
    }
    tabsEl.innerHTML =
      t("today", "#today", "Today", I.home) +
      t("studio", "#studio", "Studio", I.layers) +
      (atLeast("member") ? '<a href="#new" class="plus" aria-label="New idea"><span class="p">' + I.plus + "</span></a>" : '<span aria-hidden="true"></span>') +
      t("tools", "#tools", "Tools", I.grid) +
      t("team", "#team", "Team", I.people);
  }

  // ── Router ───────────────────────────────────────────────────────────
  var PUBLIC = { join: 1, signin: 1 };
  async function render() {
    stopPolling();
    var my = ++gen;
    var parts = location.hash.replace(/^#\/?/, "").split("/");
    var name = parts[0] || "today";
    var arg = parts.slice(1).join("/");
    if (!state.me) {
      try { state.me = await api("/api/me"); } catch (e) { if (e.stale) return; state.me = { authenticated: false }; }
    }
    if (my !== gen) return;
    if (!PUBLIC[name]) {
      if (!state.me.authenticated) return go("#signin");
      if (!state.me.team) return notOnTeam();
      if (N && !state.nativeReady) { state.nativeReady = true; await nativeStart(); if (my !== gen) return; }
      if (name !== "new" && state.shared && atLeast("member")) return openShared();
    }
    var screens = { today: today, studio: studio, kit: kit, "new": newIdea, brief: brief, run: run, review: review, tools: tools, tool: tool, team: team, invite: invite, join: join, signin: signin };
    var fn = screens[name] || today;
    window.scrollTo(0, 0);
    try { await fn(arg); } catch (e) { if (e.stale || my !== gen) return; show(null, '<div class="screen"><h1 class="title sm">Something went wrong</h1><p class="body err">' + h(e.message) + '</p><a class="btn ghost" href="#today">Back to Today</a></div>'); }
  }
  window.addEventListener("hashchange", render);

  function show(tab, html) {
    renderTabs(tab);
    app.innerHTML = html;
  }

  // ── Today ────────────────────────────────────────────────────────────
  var ACT = {
    invited: "invited someone",
    joined: "joined the team",
    started_run: "started a kit run",
    started_brief: "started a brief",
    approved_kit: "approved",
    discarded_kit: "discarded",
    changed_member: "changed someone's role",
    removed_member: "removed someone from the team",
    cancelled_invite: "cancelled an invite",
    deleted_account: "deleted their account",
  };
  function actorName(a) {
    if (a.actor && state.me && a.actor === state.me.email) return "You";
    return a.actor_name || (a.actor ? a.actor.replace(/@.*/, "") : "Someone");
  }

  async function today() {
    var me = state.me;
    var date = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
    show("today", '<div class="screen"><div class="head"><div><p class="kicker">' + h(date) + '</p><h1 class="title">Today</h1></div><a class="avatar" href="#team" aria-label="Your team">' + h(initials({ name: me.team.name, email: me.email })) + '</a></div><div class="spin" aria-label="Loading"></div></div>');
    var res = await settled([api("/api/studio-agents/kits"), api("/api/studio-agents/runs?limit=20"), api("/api/team/activity?limit=8")]);
    var kits = res[0].status === "fulfilled" ? res[0].value.kits || [] : [];
    var runs = res[1].status === "fulfilled" ? res[1].value.runs || [] : [];
    var acts = res[2].status === "fulfilled" ? res[2].value.activity || [] : [];
    state.kits = kits;

    var drafts = kits.filter(function (k) { return k.status === "draft"; });
    var recent = Date.now() - 3 * 86400000;
    var briefs = runs.filter(function (r) { return r.role === "brief-writer" && r.by_you && r.status !== "running" && r.status !== "failed" && new Date(r.created_at).getTime() > recent; }).slice(0, 2);
    var running = runs.filter(function (r) { return r.status === "running"; });
    var approved = kits.find(function (k) { return k.status === "approved"; });
    try {
      var waiting = atLeast("approver") ? drafts.length : 0;
      if (navigator.setAppBadge) { if (waiting) navigator.setAppBadge(waiting); else navigator.clearAppBadge(); }
    } catch (e) {}

    var needs = "";
    drafts.forEach(function (d) {
      var canApprove = atLeast("approver");
      needs += '<article class="card"><div class="row"><div class="ico">' + I.layers + '</div><div class="grow"><div class="name">' + h(d.title) + " · draft v" + d.version + '</div><div class="sub">' + h(roleLabel(d.role)) + " · " + h(evalLabel(d.eval_status)) + "</div></div>" +
        (canApprove ? '<span class="badge gold">Review</span>' : '<span class="badge">Waiting</span>') + "</div>" +
        '<div class="btn-row"><a class="btn" href="#review/' + h(d.id) + '">See what changed</a></div>' +
        (canApprove ? "" : '<p class="sub" style="margin:0">An approver or Kyron approves this.</p>') + "</article>";
    });
    briefs.forEach(function (b) {
      needs += '<article class="card"><div class="row" style="color:var(--gold);font:700 13px/1 var(--text)"><span style="width:18px;height:18px;display:inline-flex">' + I.question + '</span>Your brief is ready</div><p class="body" style="font-weight:600;color:var(--ink)">' + h(b.label) + '</p><div class="btn-row"><a class="btn soft" href="#brief/' + h(b.id) + '">Open the brief</a></div></article>';
    });

    var runRows = running.map(function (r) {
      var href = r.role === "brief-writer" ? "#brief/" + r.id : "#run/" + r.id;
      return '<a class="li" href="' + href + '"><div class="spin" aria-hidden="true"></div><div class="grow"><div class="name" style="font-size:15px">' + h(r.label) + '</div><div class="sub">' + h(roleLabel(r.role)) + " · started " + h(ago(r.created_at)) + (r.by_you ? " by you" : "") + "</div></div>" + I.chev + "</a>";
    }).join("");

    var tiles =
      (atLeast("member") ? '<a class="tile" href="#new">' + I.plus + "New idea</a>" : "") +
      (atLeast("member") && approved ? '<a class="tile" href="#new/gear">' + I.refresh + "Re-check gear</a>" : "") +
      (approved ? '<a class="tile" href="#kit/' + h(approved.id) + '">' + I.layers + "Open " + h(approved.title.replace(/ Milanote Kit$/, "")) + "</a>" : "") +
      (isOwner() ? '<a class="tile" href="#invite">' + I.invite + "Invite someone</a>" : '<a class="tile" href="#team">' + I.people + "The team</a>");

    var actRows = acts.slice(0, 6).map(function (a) {
      var what = ACT[a.action] || a.action.replace(/_/g, " ");
      var subj = /kit/.test(a.action) && a.subject ? " " + a.subject : "";
      return '<div class="row" style="padding:8px 0;border-bottom:1px solid #1E2C40"><span class="avatar" style="width:32px;height:32px;border-width:0;background:#22364F;font-size:12px">' + h(initials({ name: actorName(a) })) + '</span><div class="grow body" style="font-size:14px"><b style="color:var(--ink)">' + h(actorName(a)) + "</b> " + h(what + subj) + ' <span class="sub">· ' + h(ago(a.created_at)) + "</span></div></div>";
    }).join("");

    show("today",
      '<div class="screen">' +
      '<div class="head"><div><p class="kicker">' + h(date) + '</p><h1 class="title">Today</h1></div><a class="avatar" href="#team" aria-label="Your team">' + h(initials({ name: me.team.name, email: me.email })) + "</a></div>" +
      (installHint()) +
      '<section class="sec"><h2 class="sec-h">Needs you' + (drafts.length + briefs.length ? " · " + (drafts.length + briefs.length) : "") + "</h2>" + (needs || '<p class="empty">Nothing waiting on you.</p>') + "</section>" +
      (runRows ? '<section class="sec"><h2 class="sec-h">Running</h2><div class="list">' + runRows + "</div></section>" : "") +
      '<section class="sec"><h2 class="sec-h">Start something</h2><div class="tile-grid">' + tiles + "</div></section>" +
      (actRows ? '<section class="sec"><h2 class="sec-h">Team activity</h2><div>' + actRows + "</div></section>" : "") +
      "</div>");
    if (running.length) later(today, 15000);
  }

  function roleLabel(r) { return { "kit-refresher": "Kit Refresher", "kit-builder": "Kit Builder", "brief-writer": "Brief Writer" }[r] || r || ""; }
  function evalLabel(e) { return { passed: "passed its checks", passed_after_retry: "passed its checks on a retry", failed_after_retries: "failed its checks, look closely", not_run: "checks not run" }[e] || "checks pending"; }

  function installHint() {
    if (standalone() || load("toj.installHint") === "done") return "";
    var ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    return '<div class="card tight" id="installHint"><div class="row"><div class="grow"><div class="name" style="font-size:15px">Put TOJ on your Home Screen</div><div class="sub">' +
      (ios ? "In Safari, tap Share, then Add to Home Screen." : "Use your browser's Install or Add to Home Screen option.") +
      '</div></div><button type="button" class="x" aria-label="Dismiss" onclick="try{localStorage.setItem(\'toj.installHint\',\'done\')}catch(e){};this.closest(\'#installHint\').remove()">×</button></div></div>';
  }

  // ── Studio ───────────────────────────────────────────────────────────
  async function studio() {
    show("studio", '<div class="screen"><h1 class="title">Studio</h1><div class="spin"></div></div>');
    var d = await api("/api/studio-agents/kits");
    state.kits = d.kits || [];
    var bySlug = {};
    state.kits.forEach(function (k) { (bySlug[k.slug] = bySlug[k.slug] || []).push(k); });
    var blocks = Object.keys(bySlug).map(function (slug) {
      var rows = bySlug[slug].sort(function (a, b) { return b.version - a.version; });
      var ap = rows.find(function (r) { return r.status === "approved"; });
      var drafts = rows.filter(function (r) { return r.status === "draft"; });
      var older = rows.filter(function (r) { return r.status === "superseded" || r.status === "discarded"; });
      return '<article class="card"><div class="row"><div class="grow"><div class="name" style="font-size:18px">' + h((ap || rows[0]).title) + '</div><div class="sub">' + (ap ? "Approved v" + ap.version : "Not approved yet") + " · " + h(slug) + "</div></div>" + (ap ? '<span class="badge ok">' + I.check + "Approved</span>" : "") + "</div>" +
        '<div class="btn-row">' + (ap ? '<a class="btn soft" href="#kit/' + h(ap.id) + '">Open</a>' : "") + (ap && atLeast("member") ? '<a class="btn soft" href="#new/refresh/' + h(slug) + '">Refresh</a>' : "") + "</div>" +
        (drafts.length ? '<div class="list">' + drafts.map(function (r) { return '<a class="li" href="#review/' + h(r.id) + '"><span class="badge warn">Draft v' + r.version + '</span><div class="grow sub">' + h(roleLabel(r.role)) + " · " + h(ago(r.created_at)) + "</div>" + I.chev + "</a>"; }).join("") + "</div>" : "") +
        (older.length ? '<details><summary class="sub" style="cursor:pointer;min-height:32px;display:flex;align-items:center">Older versions (' + older.length + ')</summary><div class="list" style="margin-top:8px">' + older.map(function (r) { return '<a class="li" href="#kit/' + h(r.id) + '"><span class="badge">' + h(r.status) + " v" + r.version + '</span><div class="grow sub">' + h(ago(r.created_at)) + "</div>" + I.chev + "</a>"; }).join("") + "</div></details>" : "") +
        "</article>";
    }).join("");
    show("studio",
      '<div class="screen"><div class="head"><h1 class="title">Studio</h1>' + (atLeast("member") ? '<a class="btn small soft" href="#new">' + I.plus.replace("<svg", '<svg width="16" height="16"') + "New idea</a>" : "") + "</div>" +
      (blocks || '<p class="empty">No kits yet.</p>') +
      '<a class="li list" href="#tool/studio-console" style="border-radius:16px">' + '<div class="grow"><div class="name" style="font-size:15px">Full Studio console</div><div class="sub">Build a new kit from a playbook, every option</div></div>' + I.chev + "</a>" +
      "</div>");
  }

  // ── A kit ────────────────────────────────────────────────────────────
  var ALLOWED = { P: 1, B: 1, I: 1, STRONG: 1, EM: 1, UL: 1, OL: 1, LI: 1, A: 1, CODE: 1, BR: 1 };
  function safeHtml(html) {
    var doc = new DOMParser().parseFromString("<div>" + String(html || "") + "</div>", "text/html");
    var root = doc.body.firstChild;
    (function walk(node) {
      Array.prototype.slice.call(node.childNodes).forEach(function (c) {
        if (c.nodeType === 1) {
          walk(c);
          if (!ALLOWED[c.tagName]) {
            while (c.firstChild) node.insertBefore(c.firstChild, c);
            node.removeChild(c);
            return;
          }
          Array.prototype.slice.call(c.attributes).forEach(function (a) {
            var keep = c.tagName === "A" && a.name === "href" && /^https:\/\//.test(a.value);
            if (!keep) c.removeAttribute(a.name);
          });
          if (c.tagName === "A") { c.setAttribute("target", "_blank"); c.setAttribute("rel", "noopener"); }
        } else if (c.nodeType !== 3) {
          node.removeChild(c);
        }
      });
    })(root);
    return root.innerHTML;
  }
  function toText(html) {
    var s = String(html || "");
    s = s.replace(/<ol>([\s\S]*?)<\/ol>/g, function (_m, inner) {
      var items = [];
      inner.replace(/<li>([\s\S]*?)<\/li>/g, function (_x, it) { items.push(it); return ""; });
      return items.map(function (it, i) { return (i + 1) + ". " + it + "\n"; }).join("") + "\n";
    });
    s = s.replace(/<li>/g, "• ").replace(/<\/li>/g, "\n").replace(/<\/p>/g, "\n\n").replace(/<br\s*\/?>/g, "\n");
    s = s.replace(/<a href="([^"]+)">(.*?)<\/a>/g, "$2 ($1)").replace(/<[^>]+>/g, "");
    var ta = document.createElement("textarea");
    ta.innerHTML = s;
    s = ta.value;
    return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  function cardPlain(k) {
    if (k.type === "todo") return k.title + "\n\n" + (k.items || []).map(function (i) { return "☐ " + i; }).join("\n");
    return k.title + "\n\n" + toText(k.body);
  }
  function cardRich(k) {
    if (k.type === "todo") return "<h3>" + h(k.title) + "</h3><ul>" + (k.items || []).map(function (i) { return "<li>" + h(i) + "</li>"; }).join("") + "</ul>";
    return "<h3>" + h(k.title) + "</h3>" + safeHtml(k.body);
  }
  async function copy(rich, plain) {
    try {
      if (rich && window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
        await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([rich], { type: "text/html" }), "text/plain": new Blob([plain], { type: "text/plain" }) })]);
      } else {
        await navigator.clipboard.writeText(plain);
      }
      toast("Copied. Paste it onto your Milanote board.");
    } catch (e) {
      toast("Couldn't copy here. Press and hold the text to copy it.");
    }
  }

  async function kit(id) {
    show("studio", '<div class="screen">' + backBtn("#studio", "Studio") + '<div class="spin"></div></div>');
    var row = await api("/api/studio-agents/kits/" + encodeURIComponent(id));
    var k = row.kit;
    var col = Math.min(state.kitCol[id] || 0, k.columns.length - 1);
    var c = k.columns[col];
    var COLORS = { Red: "#E8826A", Blue: "#7FA3E8", Purple: "#B49AE8", Yellow: "#E6BA47", Orange: "#F0904A", Green: "#7FB487", Teal: "#5FC2BA", Grey: "#9AA3AB" };
    var total = k.columns.reduce(function (n, x) { return n + x.cards.length; }, 0);
    var chips = k.columns.map(function (x, i) {
      return '<button type="button" class="chip" data-col="' + i + '" aria-pressed="' + (i === col) + '"><span class="dot" style="background:' + (COLORS[x.color] || "#9AA3AB") + '"></span>' + h(x.name) + "</button>";
    }).join("");
    var cards = c.cards.map(function (card, j) {
      var kind = { note: "NOTE", link: "LINK", image: "IMG", todo: "TODO" }[card.type] + (card.locked ? "" : "");
      var img = card.type === "image" && k.assets ? "/api/studio-agents/assets/" + encodeURIComponent(k.assets) + "/" + encodeURIComponent(card.img) + ".jpg" : "";
      var head = img ? '<img class="kind" src="' + h(img) + '" alt="" loading="lazy">' : '<span class="kind">' + (card.locked ? "RULE" : kind) + "</span>";
      var body = card.type === "todo" ? "<ul>" + card.items.map(function (i) { return "<li>" + h(i) + "</li>"; }).join("") + "</ul>" : safeHtml(card.body);
      var btns = '<div class="btn-row">' +
        (card.type === "link" ? '<button type="button" class="btn small" data-copylink="' + j + '">Copy link</button><a class="btn small ghost" href="' + h(card.url) + '" target="_blank" rel="noopener">Open</a><button type="button" class="btn small ghost" data-copy="' + j + '">Copy notes</button>' :
          card.type === "image" ? '<a class="btn small" href="' + h(img) + '" target="_blank" rel="noopener">Open image to save</a><button type="button" class="btn small ghost" data-copy="' + j + '">Copy notes</button>' :
          '<button type="button" class="btn small" data-copy="' + j + '">Copy card</button>') + "</div>";
      return '<details class="kcard"><summary>' + head + '<span class="kt">' + h(card.title) + "</span>" + I.chev + '</summary><div class="kbody">' + (img ? '<img src="' + h(img) + '" alt="' + h(card.title) + '">' : "") + body + btns + "</div></details>";
    }).join("");
    show("studio",
      '<div class="screen">' + backBtn("#studio", "Studio") +
      '<div><p class="kicker">' + h(row.status === "approved" ? "Approved v" + row.version : row.status + " v" + row.version) + " · " + k.columns.length + " columns · " + total + ' cards</p><h1 class="title sm">' + h(k.title) + "</h1></div>" +
      (row.status === "draft" ? '<a class="btn" href="#review/' + h(row.id) + '">Review this draft</a>' : "") +
      '<div class="chips" role="group" aria-label="Milanote columns">' + chips + "</div>" +
      '<div class="sec"><p class="lede" style="margin:0">' + h(c.lead) + ' <span class="sub">· Milanote color: ' + h(c.color) + '</span></p><div style="display:flex;flex-direction:column;gap:8px">' + cards + "</div></div>" +
      '<a class="li list" href="#tool/kitpage:' + h(row.id) + '" style="border-radius:16px"><div class="grow"><div class="name" style="font-size:15px">Open the full kit page</div><div class="sub">Every card at once, for a laptop</div></div>' + I.chev + "</a>" +
      "</div>");
    app.querySelectorAll("[data-col]").forEach(function (b) {
      b.addEventListener("click", function () { state.kitCol[id] = Number(b.dataset.col); kit(id); });
    });
    app.querySelectorAll("[data-copy]").forEach(function (b) {
      b.addEventListener("click", function () { var card = c.cards[Number(b.dataset.copy)]; copy(cardRich(card), cardPlain(card)); });
    });
    app.querySelectorAll("[data-copylink]").forEach(function (b) {
      b.addEventListener("click", function () { copy(null, c.cards[Number(b.dataset.copylink)].url); });
    });
    var chipBox = app.querySelector(".chips [aria-pressed=true]");
    if (chipBox && chipBox.scrollIntoView) chipBox.scrollIntoView({ block: "nearest", inline: "center" });
  }

  // ── New idea (Brief Writer) ──────────────────────────────────────────
  var BUDGET = 4400000;
  var MAX = { image: 12, video: 4, file: 3, link: 10 };
  function freshIdea(preset) {
    var approved = (state.kits || []).filter(function (k) { return k.status === "approved"; });
    var s = { target: approved.length === 1 ? "refresh:" + approved[0].slug : "either", idea: "", refs: [], seq: 0 };
    if (preset === "gear") {
      s.target = "refresh:same-work";
      s.idea = "Re-check Same Work's Gear and Edit suite against current sources: Netflix's approved camera list, the camera specs, and the transcription and caption tools. Change only what moved, update the dates, and update the Sources card to match.";
    } else if (preset && preset.indexOf("refresh/") === 0) {
      s.target = "refresh:" + preset.slice(8);
    } else if (preset === "build") {
      s.target = "build";
    }
    return s;
  }
  async function newIdea(preset) {
    if (!atLeast("member")) return go("#today");
    if (!state.kits) { try { state.kits = (await api("/api/studio-agents/kits")).kits || []; } catch (e) { state.kits = []; } }
    if (!state.idea || (preset && preset !== "shared")) state.idea = freshIdea(preset);
    if (state.shared) addShared();
    drawIdea();
  }
  function drawIdea() {
    var s = state.idea;
    var seen = {};
    var targets = state.kits.filter(function (k) { return k.status === "approved" && !seen[k.slug] && (seen[k.slug] = 1); })
      .map(function (k) { return ["refresh:" + k.slug, k.title.replace(/ Milanote Kit$/, "")]; })
      .concat([["build", "New kit"], ["either", "Not sure"]]);
    var n = { image: 0, video: 0, file: 0, link: 0 };
    var refs = s.refs.map(function (r) {
      var label = r.error ? "COULDN'T ADD" : (r.kind === "image" ? "IMAGE " : r.kind === "video" ? "VIDEO " : r.kind === "link" ? "LINK " : "FILE ") + (++n[r.kind]);
      var meta = r.error ? r.error : r.kind === "video" ? (r.images ? r.images.length + " stills · " + Math.round(r.duration) + "s" : "Reading the video…") : r.kind === "file" ? (r.text != null ? r.text.length.toLocaleString() + " characters" : "Reading…") : r.kind === "link" ? r.url : "";
      var thumb = r.thumb ? '<img class="thumb" src="' + r.thumb + '" alt="">' : '<div class="thumb">' + (r.kind === "video" ? I.play : r.kind === "link" ? I.link : r.kind === "file" ? "PDF<br>TXT" : "…") + "</div>";
      return '<div class="ref' + (r.error ? " err" : "") + '">' + thumb + '<div class="grow"><div class="tag">' + h(label) + (meta ? ' <span class="sub" style="letter-spacing:0;font-family:var(--text)">· ' + h(meta) + "</span>" : "") + "</div>" +
        (r.error ? "" : '<input class="input" data-cap="' + r.id + '" maxlength="300" placeholder="What should it notice here?" value="' + h(r.caption || "") + '">') +
        '</div><button type="button" class="x" data-rm="' + r.id + '" aria-label="Remove">×</button></div>';
    }).join("");
    show(null,
      '<div class="screen">' +
      '<div class="head"><a class="back" href="#today">' + I.back + 'Cancel</a></div>' +
      '<h1 class="title sm">New idea</h1>' +
      '<div class="field"><span class="label">What\'s it for?</span><div class="seg" role="group" aria-label="What\'s it for?">' + targets.map(function (t) { return '<button type="button" data-target="' + h(t[0]) + '" aria-pressed="' + (s.target === t[0]) + '">' + h(t[1]) + "</button>"; }).join("") + "</div></div>" +
      '<div class="field"><label class="label" for="idea">Your idea</label><textarea class="textarea" id="idea" placeholder="Say it the way you\'d say it to a person.">' + h(s.idea) + "</textarea></div>" +
      '<div class="field"><span class="label">Show it what you mean</span><div class="attach">' +
      (N ? '<button type="button" id="nativeCam">' + I.camera + "Camera</button>" : '<label>' + I.camera + 'Camera<input type="file" accept="image/*" capture="environment" data-pick hidden></label>') +
      '<label>' + I.photo + 'Photos<input type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/*" multiple data-pick hidden></label>' +
      '<label>' + I.file + 'PDF<input type="file" accept=".pdf,.txt,.md,application/pdf,text/plain" data-pick hidden></label>' +
      '<button type="button" id="addLink">' + I.link + "Link</button></div>" +
      '<div id="linkRow" class="row" hidden><input class="input" id="linkUrl" type="url" inputmode="url" placeholder="https://…" autocomplete="off"><button type="button" class="btn small" id="linkAdd">Add</button></div>' +
      (refs ? '<div style="display:flex;flex-direction:column;gap:8px">' + refs + "</div>" : "") +
      '<p class="privacy">' + I.lock + "Photos and video stills are used for this brief only and never saved. File names stay on your phone. Videos: it sees 6 stills, not the sound." + (N ? " Things you share to TOJ from other apps wait on this phone until you open them here." : "") + "</p></div>" +
      '<p id="ideaMsg" class="body" role="status"></p>' +
      "</div>" +
      '<div class="dock"><div class="dock-inner"><button type="button" class="btn block" id="write">Write the brief</button><span class="note">Usually 1 to 3 minutes.</span></div></div>');

    app.querySelectorAll("[data-target]").forEach(function (b) { b.addEventListener("click", function () { s.target = b.dataset.target; s.idea = document.getElementById("idea").value; drawIdea(); }); });
    document.getElementById("idea").addEventListener("input", function () { s.idea = this.value; });
    app.querySelectorAll("[data-pick]").forEach(function (inp) {
      inp.addEventListener("change", function () { s.idea = document.getElementById("idea").value; addFiles(Array.prototype.slice.call(inp.files || [])); inp.value = ""; });
    });
    app.querySelectorAll("[data-cap]").forEach(function (inp) {
      inp.addEventListener("input", function () { var r = s.refs.find(function (x) { return String(x.id) === inp.dataset.cap; }); if (r) r.caption = inp.value; });
    });
    app.querySelectorAll("[data-rm]").forEach(function (b) {
      b.addEventListener("click", function () { s.idea = document.getElementById("idea").value; s.refs = s.refs.filter(function (x) { return String(x.id) !== b.dataset.rm; }); drawIdea(); });
    });
    var cam = document.getElementById("nativeCam");
    if (cam) cam.addEventListener("click", async function () {
      s.idea = document.getElementById("idea").value;
      if (s.refs.filter(function (x) { return x.kind === "image" && !x.error; }).length >= MAX.image) return say("That's the most photos one brief can take.");
      try {
        var p = await N.takePhoto();
        if (!p) return;
        s.refs.push({ id: ++s.seq, kind: "image", caption: "", thumb: "data:" + p.media_type + ";base64," + p.data, images: [p] });
        if (used() > BUDGET) { s.refs.pop(); return say("Too much to send at once. Remove a video or a few photos."); }
        drawIdea();
      } catch (e) { say(e.message); }
    });
    document.getElementById("addLink").addEventListener("click", function () { var row = document.getElementById("linkRow"); row.hidden = !row.hidden; if (!row.hidden) document.getElementById("linkUrl").focus(); });
    document.getElementById("linkAdd").addEventListener("click", function () {
      var u = document.getElementById("linkUrl").value.trim();
      if (!/^https?:\/\/\S+\.\S+/.test(u)) return say("That doesn't look like a link.");
      if (s.refs.filter(function (r) { return r.kind === "link"; }).length >= MAX.link) return say("Ten links at most.");
      s.idea = document.getElementById("idea").value;
      s.refs.push({ id: ++s.seq, kind: "link", url: u, caption: "" });
      drawIdea();
    });
    document.getElementById("write").addEventListener("click", submitIdea);
    function say(m) { document.getElementById("ideaMsg").innerHTML = '<span class="err">' + h(m) + "</span>"; }
  }

  function used() { return state.idea.refs.reduce(function (n, r) { return n + (r.images || []).reduce(function (m, i) { return m + i.data.length; }, 0); }, 0); }
  function toJpeg(src, w, hgt, max, q) {
    var sc = Math.min(1, max / Math.max(w, hgt));
    var c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * sc)); c.height = Math.max(1, Math.round(hgt * sc));
    var ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(src, 0, 0, c.width, c.height);
    var url = c.toDataURL("image/jpeg", q);
    return { url: url, data: url.slice(url.indexOf(",") + 1) };
  }
  function once(el, ev, ms) {
    return new Promise(function (res, rej) {
      var t = setTimeout(function () { rej(new Error("timed out")); }, ms);
      el.addEventListener(ev, function f() { clearTimeout(t); el.removeEventListener(ev, f); res(); });
      el.addEventListener("error", function () { clearTimeout(t); rej(new Error("this phone can't play that video here")); }, { once: true });
    });
  }
  async function addPhoto(f, r) {
    var bmp;
    if (window.createImageBitmap) bmp = await createImageBitmap(f);
    else { bmp = new Image(); bmp.src = URL.createObjectURL(f); await bmp.decode(); }
    var j = toJpeg(bmp, bmp.width, bmp.height, 1280, 0.82);
    r.thumb = j.url; r.images = [{ media_type: "image/jpeg", data: j.data }];
  }
  async function addVideo(f, r) {
    var v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.preload = "auto";
    var src = URL.createObjectURL(f); v.src = src;
    try {
      await once(v, "loadeddata", 15000);
      var d = v.duration;
      if (!isFinite(d) || d <= 0) throw new Error("couldn't read its length");
      var n = d < 6 ? 3 : 6, frames = [];
      for (var i = 0; i < n; i++) {
        var at = d * (i + 0.5) / n; v.currentTime = at; await once(v, "seeked", 10000);
        var j = toJpeg(v, v.videoWidth, v.videoHeight, 768, 0.72);
        if (i === 0) r.thumb = j.url;
        frames.push({ media_type: "image/jpeg", data: j.data, at: at });
      }
      r.images = frames; r.duration = d;
    } finally { URL.revokeObjectURL(src); }
  }
  var pdfReady = null;
  function pdfjs() {
    if (pdfReady) return pdfReady;
    pdfReady = new Promise(function (res, rej) {
      var sc = document.createElement("script");
      sc.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
      sc.onload = function () { window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"; res(window.pdfjsLib); };
      sc.onerror = function () { pdfReady = null; rej(new Error("couldn't load the PDF reader")); };
      document.head.appendChild(sc);
    });
    return pdfReady;
  }
  async function readText(f) {
    if (/\.pdf$/i.test(f.name) || f.type === "application/pdf") {
      var lib = await pdfjs();
      var doc = await lib.getDocument({ data: await f.arrayBuffer() }).promise;
      var pages = [];
      for (var i = 1; i <= doc.numPages; i++) {
        var content = await (await doc.getPage(i)).getTextContent();
        var line = "", out = [], lastY = null;
        content.items.forEach(function (it) { var y = it.transform ? Math.round(it.transform[5]) : null; if (lastY !== null && y !== lastY) { out.push(line); line = ""; } line += it.str; lastY = y; });
        out.push(line);
        pages.push(out.map(function (l) { return l.replace(/\s+$/, ""); }).join("\n").replace(/\n{3,}/g, "\n\n").trim());
      }
      return pages.join("\n\n");
    }
    return await f.text();
  }
  async function addFiles(list) {
    var s = state.idea;
    for (var k = 0; k < list.length; k++) {
      var f = list[k];
      var kind = /^image\//.test(f.type) ? "image" : /^video\//.test(f.type) ? "video" : /\.(pdf|txt|md)$/i.test(f.name) || f.type === "application/pdf" || /^text\//.test(f.type) ? "file" : null;
      var r = { id: ++s.seq, kind: kind || "file", caption: "" };
      if (!kind) r.error = "Not a photo, video, PDF or text file.";
      else if (/heic|heif/i.test(f.type) || /\.(heic|heif)$/i.test(f.name)) r.error = "This photo is HEIC. In Photos, share it as JPG, or take a screenshot of it.";
      else if (s.refs.filter(function (x) { return x.kind === kind && !x.error; }).length >= MAX[kind]) r.error = "That's the most of these one brief can take.";
      s.refs.push(r);
      drawIdea();
      if (r.error) continue;
      try {
        if (kind === "image") await addPhoto(f, r);
        else if (kind === "video") await addVideo(f, r);
        else r.text = (await readText(f)).slice(0, 60000);
        if (used() > BUDGET) { r.images = null; r.thumb = null; r.error = "Too much to send at once. Remove a video or a few photos."; }
      } catch (e) { r.images = null; r.error = "Couldn't read it here (" + e.message + "). Try a screenshot."; }
      if (location.hash.indexOf("#new") === 0) drawIdea();
    }
  }
  async function submitIdea() {
    var s = state.idea;
    s.idea = document.getElementById("idea").value.trim();
    var msg = document.getElementById("ideaMsg");
    if (s.idea.length < 10) { msg.innerHTML = '<span class="err">Tell it your idea first, a sentence or two is plenty.</span>'; return; }
    if (s.refs.some(function (r) { return !r.error && ((r.kind === "image" || r.kind === "video") && !r.images || r.kind === "file" && r.text == null); })) { msg.innerHTML = '<span class="warnc">Still reading a file. One moment.</span>'; return; }
    var target = s.target.indexOf("refresh:") === 0 ? { mode: "refresh", slug: s.target.slice(8) } : { mode: s.target };
    var images = [], files = [], links = [], vg = 0;
    s.refs.filter(function (r) { return !r.error; }).forEach(function (r) {
      if (r.kind === "image") images.push({ media_type: r.images[0].media_type, data: r.images[0].data, caption: r.caption || "" });
      else if (r.kind === "video") { vg++; r.images.forEach(function (fr) { images.push({ media_type: fr.media_type, data: fr.data, caption: r.caption || "", video: { group: vg, at: fr.at, duration: r.duration } }); }); }
      else if (r.kind === "link") links.push({ url: r.url, caption: r.caption || "" });
      else files.push({ caption: r.caption || "", text: r.text });
    });
    var btn = document.getElementById("write");
    btn.disabled = true; btn.textContent = "Sending…";
    try {
      var d = await post("/api/studio-agents/brief", { idea: s.idea, target: target, links: links, images: images, files: files });
      state.lastFiles = files.map(function (f) { return f.text; }).join("\n\n");
      state.idea = null;
      go("#brief/" + d.run_id);
    } catch (e) {
      btn.disabled = false; btn.textContent = "Write the brief";
      msg.innerHTML = '<span class="err">' + h(e.message) + "</span>";
    }
  }

  // ── The brief ────────────────────────────────────────────────────────
  async function brief(runId) {
    var d = await api("/api/studio-agents/runs/" + encodeURIComponent(runId));
    if (d.status === "running") {
      show(null, '<div class="screen">' + backBtn("#today", "Today") + '<div style="display:flex;flex-direction:column;align-items:center;gap:16px;text-align:center;padding:30px 0"><div class="spin big"></div><h1 class="title sm">Writing your brief</h1><p class="lede">Looking at your references and the kit. Usually 1 to 3 minutes. You can leave; it shows up on Today.</p></div></div>');
      later(function () { brief(runId); }, 4000);
      return;
    }
    if (!d.brief) {
      show(null, '<div class="screen">' + backBtn("#today", "Today") + '<h1 class="title sm">No brief came back</h1><p class="body err">' + h(d.error || "The Brief Writer stopped without a brief.") + '</p><a class="btn" href="#new">Try again</a></div>');
      return;
    }
    var b = d.brief;
    var needsSource = b.mode === "build";
    var refs = (b.references || []).map(function (r) {
      return '<div class="row" style="align-items:flex-start"><span class="badge" style="flex:none">' + h(r.ref) + '</span><p class="body" style="font-size:14px">' + (r.seen !== "fully" ? '<span class="warnc">' + h(r.seen === "partly" ? "Partly loaded. " : "Didn't load. ") + "</span>" : "") + h(r.what_it_shows) + " <i>Take:</i> " + h(r.take) + (r.leave ? " <i>Leave:</i> " + h(r.leave) : "") + "</p></div>";
    }).join("");
    var qs = (b.questions || []).map(function (q) { return "<li>" + h(q) + "</li>"; }).join("");
    show(null,
      '<div class="screen">' + backBtn("#today", "Today") +
      "<div>" + (d.status === "waiting" ? '<span class="badge warn">Didn\'t pass its own check, read closely</span>' : '<span class="badge ok">' + I.check + "Brief ready</span>") +
      '<h1 class="title sm" style="margin-top:12px">' + h(b.title) + '</h1><p class="lede">' + (b.mode === "refresh" ? "Refresh · " : "New kit · ") + h(b.slug) + "</p></div>" +
      '<div class="field"><label class="label" for="bwText">The brief <small>(edit anything)</small></label><textarea class="textarea mono" id="bwText">' + h(b.brief) + "</textarea></div>" +
      (refs ? '<section class="sec"><h2 class="sec-h">What it took from your references</h2>' + refs + "</section>" : "") +
      (qs ? '<section class="card" style="background:#182A3F"><div class="name" style="font-size:15px">Questions for you</div><ul class="body" style="margin:0;padding-left:20px">' + qs + '</ul><p class="sub" style="margin:0">Answer them in the brief above, or leave them; it works without.</p></section>' : "") +
      (needsSource ? '<div class="field"><label class="label" for="srcText">The playbook <small>(source material)</small></label><textarea class="textarea" id="srcText" placeholder="Paste the playbook text here.">' + h(state.lastFiles || "") + "</textarea></div>" : "") +
      '<p id="briefMsg" class="body" role="status"></p></div>' +
      '<div class="dock"><div class="dock-inner"><button type="button" class="btn block" id="startRun">' + (b.mode === "build" ? "Build the kit" : "Start the refresh") + '</button><span class="note">Makes a draft. Nothing changes until it\'s approved.</span></div></div>');
    document.getElementById("startRun").addEventListener("click", async function () {
      var btn = this;
      var body = { role: b.mode === "build" ? "kit-builder" : "kit-refresher", slug: b.slug, brief: document.getElementById("bwText").value.trim() };
      if (needsSource) body.source_text = document.getElementById("srcText").value.trim();
      btn.disabled = true; btn.textContent = "Starting…";
      try {
        var r = await post("/api/studio-agents/run", body);
        go("#run/" + r.run_id);
      } catch (e) {
        btn.disabled = false; btn.textContent = b.mode === "build" ? "Build the kit" : "Start the refresh";
        document.getElementById("briefMsg").innerHTML = '<span class="err">' + h(e.message) + (e.data && e.data.hint ? " " + h(e.data.hint) + "." : "") + "</span>";
      }
    });
  }

  // ── A run ────────────────────────────────────────────────────────────
  async function run(runId) {
    var d = await api("/api/studio-agents/runs/" + encodeURIComponent(runId));
    var steps = '<ol class="steps" aria-label="What it does"><li><span class="s"></span><div><b>Reads the approved kit</b><span>Every card, the rule cards locked</span></div></li><li><span class="s"></span><div><b>Checks the brief\'s links and sources</b><span>Dates what it re-checks</span></div></li><li><span class="s"></span><div><b>Changes only what the brief asks</b><span>Every change with a reason</span></div></li><li><span class="s"></span><div><b>Kit check and the judge</b><span>Banned words, Milanote-safe cards, rules intact</span></div></li></ol>';
    if (d.status === "running") {
      var mins = Math.max(1, Math.round((Date.now() - new Date(d.created_at).getTime()) / 60000));
      show(null, '<div class="screen">' + backBtn("#today", "Today") +
        '<div style="display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center;padding:8px 0"><div class="spin big"></div><h1 class="title sm">' + h(roleLabel(d.role)) + ' at work</h1><p class="lede">' + h(d.label || "") + "<br>" + mins + " min so far · usually 5 to 20</p></div>" + steps +
        '<p class="sub" style="text-align:center">You can close the app. The draft waits for you on Today' + (window.TOJPush && window.TOJPush.supported() ? ', and you get a notification if they\'re on (Team › Notifications).' : ".") + "</p></div>");
      later(function () { run(runId); }, 6000);
      return;
    }
    var head = d.status === "failed" ? '<span class="badge bad">Stopped</span>' : d.status === "waiting" ? '<span class="badge warn">Finished, but didn\'t pass its checks</span>' : '<span class="badge ok">' + I.check + "Finished</span>";
    var next = d.kit ? '<a class="btn block" href="#review/' + h(d.kit.id) + '">See what changed in draft v' + d.kit.version + "</a>" : d.status === "failed" ? '<p class="body err">' + h(d.error || "") + "</p>" : '<p class="body">No changes were needed, so there\'s no new draft.</p>';
    show(null, '<div class="screen">' + backBtn("#today", "Today") + "<div>" + head + '<h1 class="title sm" style="margin-top:12px">' + h(d.label || roleLabel(d.role)) + "</h1></div>" + next +
      (d.output ? '<details class="card tight"><summary class="name" style="font-size:15px;cursor:pointer">The agent\'s summary</summary><p class="body" style="white-space:pre-wrap;font-size:13.5px">' + h(d.output) + "</p></details>" : "") + "</div>");
  }

  // ── Review and approve ───────────────────────────────────────────────
  function findCard(k, col, title) { var c = (k.columns || []).find(function (x) { return x.name === col; }); return c ? c.cards.find(function (x) { return x.title === title; }) : null; }
  async function review(id) {
    show(null, '<div class="screen">' + backBtn("#today", "Today") + '<div class="spin"></div></div>');
    var row = await api("/api/studio-agents/kits/" + encodeURIComponent(id));
    var base = null;
    if (row.base_kit_id) { try { base = await api("/api/studio-agents/kits/" + encodeURIComponent(row.base_kit_id)); } catch (e) {} }
    var diff = row.diff || { totals: { changed: 0, added: 0, removed: 0, same: 0 }, columns: [] };
    var why = {};
    (row.changes || []).forEach(function (o) { if (o.title) why[o.column + "|" + o.title] = o.reason; });
    var blocks = "";
    diff.columns.filter(function (c) { return c.status !== "same"; }).forEach(function (c) {
      c.changed.forEach(function (t) {
        var before = base ? findCard(base.kit, c.name, t) : null, after = findCard(row.kit, c.name, t);
        blocks += '<div class="diff"><div class="dh"><div class="dpath">' + h(c.name) + ' · changed</div><h3>' + h(t) + "</h3></div>" +
          (before ? '<div class="before"><span class="lbl" style="color:var(--bad)">BEFORE</span>' + h(cardPlain(before).split("\n").slice(2).join("\n")) + "</div>" : "") +
          (after ? '<div class="after"><span class="lbl" style="color:var(--ok)">AFTER</span>' + h(cardPlain(after).split("\n").slice(2).join("\n")) + "</div>" : "") +
          (why[c.name + "|" + t] ? '<div class="why"><b>Why:</b> ' + h(why[c.name + "|" + t]) + "</div>" : "") + "</div>";
      });
      c.added.forEach(function (t) {
        var after = findCard(row.kit, c.name, t);
        blocks += '<div class="diff"><div class="dh"><div class="dpath">' + h(c.name) + ' · added</div><h3>' + h(t) + "</h3></div>" + (after ? '<div class="after"><span class="lbl" style="color:var(--ok)">NEW CARD</span>' + h(cardPlain(after).split("\n").slice(2).join("\n")) + "</div>" : "") + (why[c.name + "|" + t] ? '<div class="why"><b>Why:</b> ' + h(why[c.name + "|" + t]) + "</div>" : "") + "</div>";
      });
      c.removed.forEach(function (t) {
        blocks += '<div class="diff"><div class="dh"><div class="dpath">' + h(c.name) + ' · removed</div><h3>' + h(t) + "</h3></div></div>";
      });
    });
    var lockedChanged = base ? base.kit.columns.some(function (c) { return c.cards.some(function (k) { if (!k.locked) return false; var now = findCard(row.kit, c.name, k.title); return !now || JSON.stringify(now) !== JSON.stringify(k); }); }) : false;
    var t = diff.totals;
    var canApprove = atLeast("approver") && row.status === "draft";
    show(null,
      '<div class="screen">' + backBtn("#today", "Today") +
      '<div><p class="kicker">' + h(row.title) + " · " + h(roleLabel(row.role)) + '</p><h1 class="title">' + h((row.status === "draft" ? "Draft v" : row.status + " v") + row.version) + "</h1></div>" +
      '<div class="btn-row" style="gap:8px;flex-wrap:wrap">' +
      '<span class="badge ' + (row.eval_status === "failed_after_retries" ? "bad" : "ok") + '">' + h(evalLabel(row.eval_status)) + "</span>" +
      '<span class="badge">' + t.changed + " changed · " + t.added + " added · " + t.removed + " removed · " + t.same + " untouched</span>" +
      (base ? '<span class="badge ' + (lockedChanged ? "bad" : "") + '">' + (lockedChanged ? "Rule cards changed" : "Rule cards untouched") + "</span>" : "") +
      (row.check && !row.check.ok ? '<span class="badge bad">' + row.check.blockers.length + " problem(s) to fix</span>" : "") + "</div>" +
      (blocks || '<p class="empty">No card-level changes.</p>') +
      (row.summary ? '<details class="card tight"><summary class="name" style="font-size:15px;cursor:pointer">The agent\'s summary</summary><p class="body" style="white-space:pre-wrap;font-size:13.5px">' + h(row.summary) + "</p></details>" : "") +
      '<a class="li list" href="#kit/' + h(row.id) + '" style="border-radius:16px"><div class="grow name" style="font-size:15px">Open the whole draft</div>' + I.chev + "</a>" +
      '<p id="revMsg" class="body" role="status"></p></div>' +
      (row.status === "draft" ? '<div class="dock"><div class="dock-inner">' +
        (canApprove ? '<div class="btn-row"><button type="button" class="btn danger" id="discard" style="flex:0 0 auto">Discard</button><button type="button" class="btn" id="approve">Approve v' + row.version + "</button></div><span class=\"note\">Approving makes v" + row.version + " the kit the whole team uses.</span>" : '<span class="note">An approver or Kyron approves drafts. You can still read every change.</span>') +
        "</div></div>" : ""));
    if (!canApprove) return;
    var msg = document.getElementById("revMsg");
    function armed(btn, label, fn) {
      btn.addEventListener("click", async function () {
        if (!btn.dataset.armed) { btn.dataset.armed = "1"; var old = btn.textContent; btn.textContent = label; setTimeout(function () { delete btn.dataset.armed; btn.textContent = old; }, 4000); return; }
        btn.disabled = true;
        try { await fn(); } catch (e) { btn.disabled = false; msg.innerHTML = '<span class="err">' + h(e.message) + (e.data && e.data.hint ? " " + h(e.data.hint) + "." : "") + "</span>"; }
      });
    }
    armed(document.getElementById("approve"), "Tap again to approve", async function () {
      await post("/api/studio-agents/kits/" + encodeURIComponent(id) + "/approve");
      toast("Approved. v" + row.version + " is the kit now.");
      go("#kit/" + id);
    });
    armed(document.getElementById("discard"), "Tap again to discard", async function () {
      await post("/api/studio-agents/kits/" + encodeURIComponent(id) + "/discard");
      toast("Discarded.");
      go("#studio");
    });
  }

  // ── Tools ────────────────────────────────────────────────────────────
  var TOOLS = {
    "studio-console": { name: "Studio console", path: "/admin/studio-agents.html", sub: "Every Studio option, laptop-friendly", team: true },
    "command-center": { name: "Command Center", path: "/admin/command-center.html", sub: "Every console at once" },
    "intake-crm": { name: "Intake CRM", path: "/admin/intake-crm.html", sub: "Holds minors' data" },
    "toj-agents": { name: "TOJ Agents", path: "/admin/agents.html" },
    "hooks-agents": { name: "Hooks Agents", path: "/admin/hooks-agents.html" },
    "diagnostic-agents": { name: "Diagnostic Agents", path: "/admin/diagnostic-agents.html" },
    "performance-agents": { name: "Performance Agents", path: "/admin/performance-agents.html" },
    campaign: { name: "Campaign Deal Graph", path: "/admin/campaign.html" },
    waitlist: { name: "Waitlist & Pilots", path: "/admin/waitlist.html" },
    pylon: { name: "Pylon Admin", path: "/admin/pylon.html" },
    "pylon-live": { name: "Pylon Live Console", path: "/admin/pylon-live-console.html" },
    "pylon-calendar": { name: "Content Calendar", path: "/admin/pylon-content-calendar.html" },
    "pylon-performance": { name: "Content Performance", path: "/admin/pylon-content-performance.html" },
    "pylon-ambassadors": { name: "Pylon Ambassadors", path: "/admin/pylon-ambassadors.html" },
    "pylon-newsletter": { name: "Pylon Newsletter", path: "/admin/pylon-newsletter.html" },
  };
  var TOOL_GROUPS = [
    ["Agents", ["toj-agents", "hooks-agents", "diagnostic-agents", "performance-agents", "campaign"]],
    ["CRMs and ops", ["intake-crm", "waitlist", "command-center"]],
    ["Pylon", ["pylon", "pylon-live", "pylon-calendar", "pylon-performance", "pylon-ambassadors", "pylon-newsletter"]],
  ];
  function toolRow(key) {
    var t = TOOLS[key];
    return '<a class="li" href="#tool/' + key + '"><div class="ico" style="width:36px;height:36px;border-radius:9px;font:700 12px/1 var(--text);color:var(--bg);background:var(--gold)">' + h(t.name.split(/\s+/).map(function (w) { return w[0]; }).join("").slice(0, 2)) + '</div><div class="grow"><div class="name" style="font-size:15.5px">' + h(t.name) + "</div>" + (t.sub ? '<div class="sub">' + h(t.sub) + "</div>" : "") + "</div>" + I.chev + "</a>";
  }
  async function tools() {
    var make = '<div class="list"><a class="li" href="#studio"><div class="ico" style="width:36px;height:36px;border-radius:9px">' + I.layers + '</div><div class="grow"><div class="name" style="font-size:15.5px">Studio Kits</div><div class="sub">Milanote kits, briefs, refreshes</div></div>' + I.chev + "</a>" +
      (atLeast("member") ? '<a class="li" href="#new"><div class="ico" style="width:36px;height:36px;border-radius:9px">' + I.plus + '</div><div class="grow"><div class="name" style="font-size:15.5px">Brief Writer</div><div class="sub">An idea plus photos, videos, links</div></div>' + I.chev + "</a>" : "") +
      toolRow("studio-console").replace('class="li"', 'class="li"') + "</div>";
    var rest = isOwner() ? TOOL_GROUPS.map(function (g) { return '<section class="sec"><h2 class="sec-h">' + h(g[0]) + '</h2><div class="list">' + g[1].map(toolRow).join("") + "</div></section>"; }).join("") :
      '<p class="empty">More tools show up here as they move into the app. The CRMs and anything holding minors\' data stay with Kyron.</p>';
    show("tools", '<div class="screen"><div><h1 class="title">Tools</h1><p class="lede">' + (isOwner() ? "Everything from the Command Center, opened inside the app." : "What your role can open.") + '</p></div><section class="sec"><h2 class="sec-h">Make</h2>' + make + "</section>" + rest + "</div>");
  }
  async function tool(key) {
    var t, path;
    if (key.indexOf("kitpage:") === 0) { path = "/api/studio-agents/kits/" + encodeURIComponent(key.slice(8)) + "/page"; t = { name: "Kit page" }; }
    else { t = TOOLS[key]; if (!t) return go("#tools"); if (!t.team && !isOwner()) return go("#tools"); path = t.path; }
    tabsEl.hidden = true;
    app.innerHTML = '<div class="frame-wrap"><div class="frame-bar"><button type="button" class="back" id="frameBack">' + I.back + 'Back</button><div class="t">' + h(t.name) + '</div><a class="back" href="' + h(path) + '" target="_blank" rel="noopener" aria-label="Open in the browser">' + I.out + '</a></div><iframe src="' + h(path) + '" title="' + h(t.name) + '"></iframe></div>';
    document.getElementById("frameBack").addEventListener("click", function () { if (history.length > 1) history.back(); else go("#tools"); });
  }

  // ── Team ─────────────────────────────────────────────────────────────
  var ROLE_DESC = {
    owner: "Everything. Approves kits, changes rule cards, manages the team, sees the CRMs that hold minors' data.",
    approver: "Approves kit drafts, and everything a member can do.",
    member: "Writes briefs, starts runs, reviews drafts. Can't approve.",
    viewer: "Opens approved kits and copies cards to Milanote.",
  };
  async function team() {
    show("team", '<div class="screen"><h1 class="title">Team</h1><div class="spin"></div></div>');
    var res = await settled([api("/api/team"), isOwner() ? api("/api/team/invites") : Promise.resolve({ invites: [] })]);
    var people = res[0].status === "fulfilled" ? res[0].value.people : [];
    var invites = res[1].status === "fulfilled" ? res[1].value.invites : [];
    var me = state.me;
    var rows = people.map(function (p) {
      var who = p.name || (p.email ? p.email : "Teammate");
      var editable = isOwner() && p.role !== "owner";
      return '<div class="li" style="cursor:default"><span class="avatar" style="width:38px;height:38px;border-width:' + (p.you ? "1.5px" : "0") + ';background:#22364F;font-size:13px">' + h(initials(p)) + '</span><div class="grow"><div class="name" style="font-size:15.5px">' + h(who) + (p.you ? ' <span class="sub">(you)</span>' : "") + "</div>" + (p.name && p.email ? '<div class="sub">' + h(p.email) + "</div>" : "") + "</div>" +
        (editable ? '<select class="input" data-role="' + h(p.email) + '" aria-label="Role for ' + h(who) + '" style="width:auto;min-height:38px;padding:4px 8px;font-size:14px">' + ["approver", "member", "viewer"].map(function (r) { return '<option value="' + r + '"' + (p.role === r ? " selected" : "") + ">" + r[0].toUpperCase() + r.slice(1) + "</option>"; }).join("") + '</select><button type="button" class="x" data-remove="' + h(p.email) + '" aria-label="Remove ' + h(who) + '">×</button>' :
          '<span class="badge' + (p.role === "owner" ? " gold" : "") + '">' + h(p.role[0].toUpperCase() + p.role.slice(1)) + "</span>") + "</div>";
    }).join("");
    var inv = invites.map(function (i) {
      return '<div class="li" style="cursor:default"><span class="avatar" style="width:38px;height:38px;background:transparent;border:1.5px dashed #5A6B84;color:var(--muted)">@</span><div class="grow"><div class="name" style="font-size:15px">' + h(i.name || i.email) + '</div><div class="sub">Invited as ' + h(i.role) + " · link works until " + h(new Date(i.expires_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })) + '</div></div><button type="button" class="btn small soft" data-renew="' + h(i.id) + '">New link</button><button type="button" class="x" data-cancel="' + h(i.id) + '" aria-label="Cancel invite">×</button></div>';
    }).join("");
    show("team",
      '<div class="screen"><div class="head"><div><h1 class="title">Team</h1><p class="lede">' + people.length + " " + (people.length === 1 ? "person" : "people") + (invites.length ? " · " + invites.length + " invite" + (invites.length > 1 ? "s" : "") + " waiting" : "") + "</p></div>" +
      (isOwner() ? '<a class="btn small" href="#invite">' + I.plus.replace("<svg", '<svg width="16" height="16"') + "Invite</a>" : "") + "</div>" +
      '<div class="list">' + rows + inv + "</div>" +
      '<section class="card"><h2 class="sec-h">What each role can do</h2><div style="display:grid;grid-template-columns:84px 1fr;gap:10px 12px;font-size:14px;line-height:1.45;color:var(--ink-2)">' +
      ["owner", "approver", "member", "viewer"].map(function (r) { return "<b style=\"color:var(--ink)\">" + r[0].toUpperCase() + r.slice(1) + "</b><span>" + h(ROLE_DESC[r]) + "</span>"; }).join("") + "</div></section>" +
      '<section class="sec"><h2 class="sec-h">You</h2><div class="list"><div class="li" style="cursor:default"><div class="grow"><div class="name" style="font-size:15.5px">' + h(me.team.name || me.email) + '</div><div class="sub">' + h(me.email) + " · " + h(me.team.role) + "</div></div></div>" +
      '<div id="pushRow"></div>' +
      '<button type="button" class="li" id="signout"><div class="grow name err" style="font-size:15.5px">Sign out</div></button>' +
      (isOwner() ? "" : '<button type="button" class="li" id="deleteMe"><div class="grow"><div class="name err" style="font-size:15.5px">Delete my account</div><div class="sub">Removes your sign-in and takes you off the team. Kits you approved stay approved.</div></div></button>') +
      "</div></section>" +
      installHint() + "</div>");
    document.getElementById("signout").addEventListener("click", async function () {
      try { await post("/api/auth/logout"); } catch (e) {}
      state.me = null; go("#signin");
    });
    if (window.TOJPush) window.TOJPush.row(document.getElementById("pushRow"));
    var del = document.getElementById("deleteMe");
    if (del) del.addEventListener("click", async function () {
      if (!del.dataset.armed) {
        del.dataset.armed = "1";
        del.querySelector(".name").textContent = "Tap again to delete your account";
        setTimeout(function () { if (del.isConnected) { delete del.dataset.armed; del.querySelector(".name").textContent = "Delete my account"; } }, 5000);
        return;
      }
      del.disabled = true;
      try {
        if (N) { try { await N.push.disable(post); } catch (e) {} }
        await post("/api/team/me", { confirm: true }, "DELETE");
        state.me = null;
        toast("Your account is deleted.");
        go("#signin");
      } catch (e) { del.disabled = false; toast(e.message); }
    });
    if (!isOwner()) return;
    app.querySelectorAll("[data-role]").forEach(function (sel) {
      sel.addEventListener("change", async function () {
        try { await post("/api/team/members/" + encodeURIComponent(sel.dataset.role), { role: sel.value }, "PATCH"); toast("Role changed."); } catch (e) { toast(e.message); team(); }
      });
    });
    app.querySelectorAll("[data-remove]").forEach(function (b) {
      b.addEventListener("click", async function () {
        if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "?"; b.setAttribute("aria-label", "Tap again to remove"); toast("Tap × again to remove them from the team."); setTimeout(function () { delete b.dataset.armed; b.textContent = "×"; }, 4000); return; }
        try { await api("/api/team/members/" + encodeURIComponent(b.dataset.remove), { method: "DELETE" }); toast("Removed from the team."); team(); } catch (e) { toast(e.message); }
      });
    });
    app.querySelectorAll("[data-cancel]").forEach(function (b) {
      b.addEventListener("click", async function () { try { await api("/api/team/invites/" + encodeURIComponent(b.dataset.cancel), { method: "DELETE" }); toast("Invite cancelled."); team(); } catch (e) { toast(e.message); } });
    });
    app.querySelectorAll("[data-renew]").forEach(function (b) {
      b.addEventListener("click", async function () {
        try { var d = await post("/api/team/invites/" + encodeURIComponent(b.dataset.renew) + "/renew"); showLink(d.invite.email, d.path); } catch (e) { toast(e.message); }
      });
    });
  }

  async function invite() {
    if (!isOwner()) return go("#team");
    var role = "member";
    function draw() {
      show(null,
        '<div class="screen"><div class="head"><a class="back" href="#team">' + I.back + 'Cancel</a></div><h1 class="title sm">Invite someone</h1>' +
        '<div class="field"><label class="label" for="em">Email</label><input class="input" id="em" type="email" inputmode="email" autocomplete="off" placeholder="name@example.com"></div>' +
        '<div class="field"><label class="label" for="nm">Name <small>(optional)</small></label><input class="input" id="nm" type="text" placeholder="What the team calls them"></div>' +
        '<div class="field"><span class="label">Role</span><div role="radiogroup" aria-label="Role" style="display:flex;flex-direction:column;gap:8px">' +
        ["approver", "member", "viewer"].map(function (r) { return '<button type="button" role="radio" class="radio" data-r="' + r + '" aria-checked="' + (role === r) + '"><span class="r"></span><span><b style="display:block;font-size:15.5px">' + r[0].toUpperCase() + r.slice(1) + '</b><span class="sub">' + h(ROLE_DESC[r]) + "</span></span></button>"; }).join("") + "</div></div>" +
        '<div class="card tight"><div class="row"><div class="grow"><div class="name" style="font-size:15px">Can open: Studio Kits</div><div class="sub">The CRMs and anything holding minors\' data stay owner-only.</div></div><span style="width:18px;height:18px;color:var(--faint)">' + I.lock + "</span></div></div>" +
        '<p id="invMsg" class="body" role="status"></p></div>' +
        '<div class="dock"><div class="dock-inner"><button type="button" class="btn block" id="send">Make the invite link</button><span class="note">You send the link yourself, by text or email. It works once, for 7 days.</span></div></div>');
      app.querySelectorAll("[data-r]").forEach(function (b) { b.addEventListener("click", function () { var em = document.getElementById("em").value, nm = document.getElementById("nm").value; role = b.dataset.r; draw(); document.getElementById("em").value = em; document.getElementById("nm").value = nm; }); });
      document.getElementById("send").addEventListener("click", async function () {
        var btn = this;
        btn.disabled = true;
        try {
          var d = await post("/api/team/invites", { email: document.getElementById("em").value.trim(), name: document.getElementById("nm").value.trim(), role: role, tools: ["studio"] });
          showLink(d.invite.email, d.path);
        } catch (e) { btn.disabled = false; document.getElementById("invMsg").innerHTML = '<span class="err">' + h(e.message) + "</span>"; }
      });
    }
    draw();
  }
  function showLink(email, path) {
    var url = location.origin + path;
    show(null,
      '<div class="screen"><span class="badge ok" style="align-self:flex-start">' + I.check + 'Invite ready</span><h1 class="title sm">Send this link to ' + h(email) + '</h1>' +
      '<p class="lede">It works once, for 7 days. Anyone with the link can join as this person, so send it only to them.</p>' +
      '<div class="card tight mono" style="word-break:break-all;font-size:13px">' + h(url) + "</div>" +
      '<div class="btn-row"><button type="button" class="btn" id="copyLink">Copy link</button>' + (navigator.share ? '<button type="button" class="btn soft" id="shareLink">' + I.share + "Share…</button>" : "") + "</div>" +
      '<a class="btn ghost" href="#team">Done</a></div>');
    document.getElementById("copyLink").addEventListener("click", function () { copy(null, url); });
    var sh = document.getElementById("shareLink");
    if (sh) sh.addEventListener("click", function () { navigator.share({ title: "Join TOJ", text: "You're invited to the TOJ team app:", url: url }).catch(function () {}); });
  }

  // ── Join and sign in ─────────────────────────────────────────────────
  async function join(token) {
    var d;
    try { d = await api("/api/team/join/" + encodeURIComponent(token)); }
    catch (e) { show(null, '<div class="screen" style="padding-top:40px;text-align:center;align-items:center">' + appIcon() + '<h1 class="title sm">This link doesn\'t work</h1><p class="lede">' + h(e.message) + '</p><a class="btn ghost" href="#signin">Sign in instead</a></div>'); return; }
    show(null,
      '<div class="screen" style="padding-top:20px">' +
      '<div style="display:flex;flex-direction:column;align-items:center;text-align:center;gap:14px">' + appIcon() + '<h1 class="title sm">You\'re on the team</h1><p class="lede">' + h(d.invited_by) + " invited " + h(d.email) + " to TOJ as a <b style=\"color:var(--ink)\">" + h(d.role) + "</b>. " + h(ROLE_DESC[d.role] || "") + "</p></div>" +
      (d.account_exists ? "" : '<div class="field"><label class="label" for="jn">Your name</label><input class="input" id="jn" type="text" autocomplete="name" value="' + h(d.name || "") + '"></div>') +
      '<div class="field"><label class="label" for="jp">' + (d.account_exists ? "Your password for " + h(d.email) : "Set a password") + '</label><input class="input" id="jp" type="password" autocomplete="' + (d.account_exists ? "current-password" : "new-password") + '" placeholder="' + (d.account_exists ? "" : "At least " + d.password_min + " characters") + '"></div>' +
      '<p id="joinMsg" class="body" role="status"></p></div>' +
      '<div class="dock"><div class="dock-inner"><button type="button" class="btn block" id="joinBtn">Join the team</button><span class="note">This link works once.</span></div></div>');
    document.getElementById("joinBtn").addEventListener("click", async function () {
      var btn = this;
      btn.disabled = true;
      try {
        var nameEl = document.getElementById("jn");
        await post("/api/team/join", { token: token, password: document.getElementById("jp").value, name: nameEl ? nameEl.value.trim() : undefined });
        state.me = null;
        state.me = await api("/api/me");
        welcomeInstall();
      } catch (e) { btn.disabled = false; document.getElementById("joinMsg").innerHTML = '<span class="err">' + h(e.message) + "</span>"; }
    });
  }
  function appIcon() { return '<img src="/app/icons/icon-192.png" alt="TOJ" width="88" height="88" style="border-radius:20px;border:1.5px solid var(--gold)">'; }
  function welcomeInstall() {
    var ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    show(null,
      '<div class="screen" style="padding-top:20px"><div style="display:flex;flex-direction:column;align-items:center;text-align:center;gap:14px">' + appIcon() + '<h1 class="title sm">Welcome in</h1></div>' +
      (standalone() ? "" : '<section class="card"><div class="name">Put TOJ on your Home Screen</div><ol class="body" style="margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px">' +
        (ios ? '<li>Tap <b>Share</b> ' + I.share + " in Safari's toolbar.</li><li>Choose <b>Add to Home Screen</b>.</li><li>Open TOJ from its icon.</li>" : "<li>Open your browser's menu.</li><li>Choose <b>Install app</b> or <b>Add to Home Screen</b>.</li>") + "</ol></section>") +
      '<a class="btn block" href="#today">Open Today</a></div>');
  }
  async function signin() {
    show(null,
      '<div class="screen" style="padding-top:30px"><div style="display:flex;flex-direction:column;align-items:center;text-align:center;gap:14px">' + appIcon() + '<h1 class="title sm">Sign in to TOJ</h1></div>' +
      '<form id="si" style="display:flex;flex-direction:column;gap:14px"><div class="field"><label class="label" for="se">Email</label><input class="input" id="se" type="email" autocomplete="username" inputmode="email" required></div>' +
      '<div class="field"><label class="label" for="sp">Password</label><input class="input" id="sp" type="password" autocomplete="current-password" required></div>' +
      '<button class="btn block" type="submit">Sign in</button><p id="siMsg" class="body" role="status"></p></form>' +
      '<p class="sub" style="text-align:center">New to the team? Open the invite link Kyron sent you.</p></div>');
    document.getElementById("si").addEventListener("submit", async function (e) {
      e.preventDefault();
      try {
        await post("/api/auth/login", { email: document.getElementById("se").value.trim(), password: document.getElementById("sp").value });
        state.me = null;
        state.me = await api("/api/me");
        go("#today");
      } catch (err) { document.getElementById("siMsg").innerHTML = '<span class="err">' + h(err.message) + "</span>"; }
    });
  }
  function notOnTeam() {
    show(null, '<div class="screen" style="padding-top:40px;text-align:center;align-items:center">' + appIcon() + '<h1 class="title sm">Not on the team yet</h1><p class="lede">You\'re signed in as ' + h(state.me.email) + ", but this account isn't on the TOJ team. Ask Kyron for an invite link.</p><button type=\"button\" class=\"btn ghost\" id=\"so\">Sign out</button></div>");
    document.getElementById("so").addEventListener("click", async function () { try { await post("/api/auth/logout"); } catch (e) {} state.me = null; go("#signin"); });
  }

  // ── The iPhone app ───────────────────────────────────────────────────
  // Runs once, after sign-in: re-sends the notification token (Apple can
  // change it) and picks up things shared to TOJ from other apps, now and
  // whenever the app comes back to the front.
  async function nativeStart() {
    N.push.refresh(post);
    window.addEventListener("toj:resume", onResume);
    await takeShared();
  }
  async function takeShared() {
    if (!atLeast("member")) return false;
    try {
      if (!(await N.sharedCount())) return false;
      var shares = await N.takeShared();
      if (!shares.length) return false;
      state.shared = (state.shared || []).concat(shares);
      return true;
    } catch (e) { return false; }
  }
  async function onResume() {
    if (!state.me || !state.me.team) return;
    if (!(await takeShared())) return;
    if (location.hash.indexOf("#new") === 0 && state.idea) { addShared(); drawIdea(); }
    else openShared();
  }
  function openShared() {
    state.idea = freshIdea();
    addShared();
    go("#new");
  }
  // Shared items become references, the same as ones picked in New idea.
  function addShared() {
    var shares = state.shared || [];
    state.shared = null;
    if (!state.idea) state.idea = freshIdea();
    var s = state.idea, dropped = 0, vg = 0, notes = [];
    function room(kind) { return s.refs.filter(function (x) { return x.kind === kind && !x.error; }).length < MAX[kind]; }
    shares.forEach(function (sh) {
      if (sh.note) notes.push(sh.note);
      (sh.items || []).forEach(function (it) {
        if (it.kind === "text") { if (it.text) notes.push(it.text); return; }
        var kind = it.kind === "link" ? "link" : it.kind === "video" ? "video" : it.kind === "file" ? "file" : it.kind === "image" ? "image" : null;
        if (!kind || !room(kind)) { dropped++; return; }
        var r = { id: ++s.seq, kind: kind, caption: "" };
        if (kind === "link") { if (!/^https?:\/\//.test(it.url || "")) { dropped++; return; } r.url = it.url; }
        else if (kind === "file") { r.text = String(it.text || "").slice(0, 60000); }
        else {
          var imgs = (it.images || []).filter(Boolean);
          if (!imgs.length) { dropped++; return; }
          r.images = imgs.map(function (d, i) { return { media_type: "image/jpeg", data: d, at: it.at ? it.at[i] : undefined }; });
          r.thumb = "data:image/jpeg;base64," + imgs[0];
          if (kind === "video") { vg++; r.duration = it.duration || 0; }
        }
        s.refs.push(r);
        if (used() > BUDGET) { s.refs.pop(); dropped++; }
      });
    });
    if (notes.length) s.idea = (s.idea ? s.idea + "\n\n" : "") + notes.join("\n\n");
    toast(dropped ? "Added what was shared. " + dropped + " item" + (dropped > 1 ? "s" : "") + " didn't fit in one brief." : "Added what you shared. Add your idea and write the brief.");
  }

  // ── Start ────────────────────────────────────────────────────────────
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () { navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" }).catch(function () {}); });
  }
  window.TOJ = { api: api, post: post, toast: toast, state: state, h: h };
  render();
})();
